const { contextBridge, ipcRenderer } = require('electron');

// Bridge for playback position read by the main process (see main.js readVideo)
// and TMDB catalog fetches (run in main to sidestep the renderer CSP).
contextBridge.exposeInMainWorld('sh', {
  onVideoProgress: (cb) => ipcRenderer.on('video-progress', (_e, d) => cb(d)),
  tmdb: (path, params) => ipcRenderer.invoke('tmdb', { path, params }),
  httpGet: (url) => ipcRenderer.invoke('httpGet', url), // generic GET for local live-provider modules
  testMode: !!(process.env.SH_TEST_UA_HOST || process.env.SH_TEST_TMDB_BASE), // e2e: skip the local module
});
