const { contextBridge, ipcRenderer } = require('electron');

// Bridge for playback position read by the main process (see main.js readVideo).
contextBridge.exposeInMainWorld('sh', {
  onVideoProgress: (cb) => ipcRenderer.on('video-progress', (_e, d) => cb(d)),
});
