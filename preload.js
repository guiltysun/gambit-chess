const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gambit', {
  getIP: () => ipcRenderer.invoke('get-ip'),
  hostStart: o => ipcRenderer.send('host-start', o),
  hostStop: () => ipcRenderer.send('host-stop'),
  startDiscovery: () => ipcRenderer.send('start-discovery-listen'),
  stopDiscovery: () => ipcRenderer.send('stop-discovery-listen'),
  on: (ch, cb) => ipcRenderer.on(ch, (e, d) => cb(d))
});