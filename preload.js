const { contextBridge, ipcRenderer } = require('electron');

// Bridge for playback position read by the main process (see main.js readVideo)
// and TMDB catalog fetches (run in main to sidestep the renderer CSP).
contextBridge.exposeInMainWorld('sh', {
  onVideoProgress: (cb) => ipcRenderer.on('video-progress', (_e, d) => cb(d)),
  tmdb: (path, params) => ipcRenderer.invoke('tmdb', { path, params }),
});
