const { contextBridge, ipcRenderer } = require('electron');

// Bridge for playback position read by the main process (see main.js readVideo)
// and TMDB catalog fetches (run in main to sidestep the renderer CSP).
contextBridge.exposeInMainWorld('sh', {
  onVideoProgress: (cb) => ipcRenderer.on('video-progress', (_e, d) => cb(d)),
  tmdb: (path, params) => ipcRenderer.invoke('tmdb', { path, params }),
  httpGet: (url) => ipcRenderer.invoke('httpGet', url), // generic GET for live-catalog fetches
  onUpdate: (cb) => {
    ipcRenderer.on('update-progress', (_e, d) => cb({ type: 'progress', percent: d.percent }));
    ipcRenderer.on('update-ready', (_e, d) => cb({ type: 'ready', version: d.version }));
    ipcRenderer.on('update-status', (_e, d) => cb({ type: 'status', ...d }));
  },
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-update'),
  onAuthReload: (cb) => ipcRenderer.on('auth-reload', () => cb()), // reload the webview after a standalone login
});
