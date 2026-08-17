const { app, BrowserWindow, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

let win = null, wss = null, serverClients = [], hostOpts = null;
const opp = c => c === 'w' ? 'b' : 'w';
const WS_PORT = 47500;
const DISCOVERY_PORT = 47501;
let discoverySocket = null;
let discoveryInterval = null;
let listenSocket = null;
let listenCleanup = null;

function getLanIP() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || [])
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1420, height: 920, minWidth: 960, minHeight: 660,
    backgroundColor: '#0d1015', autoHideMenuBar: true,
    title: 'Gambit Chess — by GuiltySun',
    icon: path.join(__dirname, 'assets/icon.png'), // ← App icon for window/taskbar
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile('index.html');
}

function stopHost() {
  if (wss) {
    for (const c of serverClients) { try { c.close(); } catch (e) {} }
    serverClients = [];
    try { wss.close(); } catch (e) {}
    wss = null;
  }
  stopDiscoveryBroadcast();
}

/* ── UDP Discovery: Broadcast ── */
function startDiscoveryBroadcast(name) {
  stopDiscoveryBroadcast();
  try {
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discoverySocket.bind(() => {
      try { discoverySocket.setBroadcast(true); } catch (e) {}

      const message = Buffer.from(JSON.stringify({
        type: 'host',
        name: name || 'Player',
        port: WS_PORT,
        timestamp: Date.now()
      }));

      const nets = os.networkInterfaces();
      const broadcastAddresses = new Set(['255.255.255.255']);

      for (const ifaceName in nets) {
        for (const net of nets[ifaceName]) {
          if (net.family === 'IPv4' && !net.internal) {
            const parts = net.address.split('.');
            parts[3] = '255';
            broadcastAddresses.add(parts.join('.'));
          }
        }
      }

      discoveryInterval = setInterval(() => {
        for (const addr of broadcastAddresses) {
          try {
            discoverySocket.send(message, 0, message.length, DISCOVERY_PORT, addr);
          } catch (e) {}
        }
      }, 2000);
    });
  } catch (e) {
    console.error('Discovery broadcast error:', e);
  }
}

function stopDiscoveryBroadcast() {
  if (discoveryInterval) {
    clearInterval(discoveryInterval);
    discoveryInterval = null;
  }
  if (discoverySocket) {
    try { discoverySocket.close(); } catch (e) {}
    discoverySocket = null;
  }
}

/* ── UDP Discovery: Listen ── */
function stopDiscoveryListen() {
  if (listenCleanup) { clearInterval(listenCleanup); listenCleanup = null; }
  if (listenSocket) { try { listenSocket.close(); } catch (e) {} listenSocket = null; }
}

function startDiscoveryListen() {
  stopDiscoveryListen();
  try {
    listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    listenSocket.bind(DISCOVERY_PORT);

    const hosts = {};

    listenSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'host' && rinfo.address !== getLanIP()) {
          hosts[rinfo.address] = {
            ...data,
            ip: rinfo.address,
            lastSeen: Date.now()
          };
          if (win) win.webContents.send('discovery-update', Object.values(hosts));
        }
      } catch (e) {}
    });

    listenCleanup = setInterval(() => {
      const now = Date.now();
      let changed = false;
      Object.keys(hosts).forEach(ip => {
        if (now - hosts[ip].lastSeen > 10000) {
          delete hosts[ip];
          changed = true;
        }
      });
      if (changed && win) win.webContents.send('discovery-update', Object.values(hosts));
    }, 5000);

    listenSocket.on('close', () => { if (listenCleanup) { clearInterval(listenCleanup); listenCleanup = null; } });
  } catch (e) {
    console.error('Discovery listen error:', e);
  }
}

/* ── App lifecycle ── */
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { stopHost(); stopDiscoveryListen(); app.quit(); });

/* ── IPC handlers ── */
ipcMain.handle('get-ip', getLanIP);
ipcMain.on('host-stop', stopHost);
ipcMain.on('start-discovery-listen', startDiscoveryListen);
ipcMain.on('stop-discovery-listen', stopDiscoveryListen);

ipcMain.on('host-start', (e, opts) => {
  stopHost();
  hostOpts = opts;
  try {
    wss = new WebSocketServer({ port: opts.port || WS_PORT });
  } catch (err) {
    win.webContents.send('host-error', err.message);
    return;
  }

  startDiscoveryBroadcast(opts.name || 'Player');

  wss.on('error', err => {
    win.webContents.send('host-error', err.message);
    stopHost();
  });

  wss.on('connection', ws => {
    if (serverClients.length >= 2) { try { ws.close(); } catch (e) {} return; }
    const color = serverClients.length === 0 ? hostOpts.side : opp(serverClients[0].color);
    serverClients.push(ws);
    ws.color = color;

    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data); } catch (err) { return; }
      if (msg.type === 'hello') {
        ws.name = String(msg.name || 'Player').slice(0, 24);
        maybeStart();
        return;
      }
      const other = serverClients.find(c => c !== ws);
      if (other && other.readyState === 1) other.send(JSON.stringify(msg));
    });

    ws.on('close', () => {
      const i = serverClients.indexOf(ws);
      if (i >= 0) serverClients.splice(i, 1);
      const other = serverClients[0];
      if (other && other.readyState === 1) other.send(JSON.stringify({ type: 'opponent-left' }));
    });
  });
});

function maybeStart() {
  if (serverClients.length === 2 && serverClients.every(c => c.name)) {
    for (const c of serverClients) {
      const other = serverClients.find(x => x !== c);
      c.send(JSON.stringify({ type: 'start', color: c.color, opponent: other.name, time: hostOpts.time }));
    }
  }
}