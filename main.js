const { app, BrowserWindow, session } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// e2e tests run against a throwaway profile so they never touch real bookmarks/logins
if (process.argv.includes('--test-profile')) {
  app.setPath('userData', path.join(os.tmpdir(), 'stream-hub-test-profile'));
}

// Some streaming sites / Cloudflare block the Electron user agent
app.userAgentFallback = app.userAgentFallback.replace(/(Electron|stream-hub)\/\S+\s?/g, '');

// Login popups allowed for these hosts only; everything else cross-host is an ad
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'www.facebook.com',
                    'discord.com', 'github.com', 'login.live.com'];

// Google refuses OAuth from embedded Chromium ("browser may not be secure");
// it accepts the flow when the login window presents as Firefox
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
const GOOGLE_LOGIN_HOSTS = ['accounts.google.com', 'accounts.youtube.com'];
if (process.env.SH_TEST_UA_HOST) GOOGLE_LOGIN_HOSTS.push(process.env.SH_TEST_UA_HOST);

// Read playback position from the player, walking into cross-origin subframes.
// WebFrameMain.executeJavaScript runs from the privileged main process, so it is
// NOT bound by the same-origin policy that blocks the renderer.
async function readVideo(contents) {
  let frames;
  try {
    frames = [contents.mainFrame, ...contents.mainFrame.framesInSubtree];
  } catch { return null; }
  for (const f of frames) {
    try {
      const v = await f.executeJavaScript(
        `(()=>{const v=document.querySelector('video');return v&&v.duration?{position:v.currentTime,duration:v.duration}:null})()`);
      if (v) return v;
    } catch {}
  }
  return null;
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') {
    // main window + login popups: never spawn further windows
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return;
  }
  // poll the player and push position to the host renderer
  // ponytail: 5s poll, tighten if progress feels laggy
  const timer = setInterval(async () => {
    const v = await readVideo(contents);
    if (v) contents.hostWebContents?.send('video-progress', v);
  }, 5000);
  contents.on('destroyed', () => clearInterval(timer));
  // every window we allow is a login popup — make its JS environment report Firefox too
  contents.on('did-create-window', (win) => win.webContents.setUserAgent(FIREFOX_UA));
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const host = new URL(url).host;
      if (host === new URL(contents.getURL()).host) {
        contents.loadURL(url); // same-site _blank link navigates in place
        return { action: 'deny' };
      }
      if (AUTH_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 500, height: 700, autoHideMenuBar: true },
        };
      }
    } catch {}
    return { action: 'deny' }; // ad popunders
  });
});

// Network-level ad/tracker blocking (EasyList via Ghostery engine).
// Cancels ad requests before they load — kills popups' sources and fake-update ads.
async function enableAdblock() {
  let blocker;
  if (process.env.SH_TEST_BLOCK_PATTERN) {
    blocker = ElectronBlocker.parse(process.env.SH_TEST_BLOCK_PATTERN); // deterministic e2e rule
  } else {
    try {
      blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: path.join(app.getPath('userData'), 'adblock-engine.bin'), // cache: no refetch each launch
        read: fs.promises.readFile,
        write: fs.promises.writeFile,
      });
    } catch (e) {
      console.error('adblock list unavailable, continuing without:', e.message);
      return;
    }
  }
  blocker.enableBlockingInSession(session.defaultSession); // webview shares default session
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    webPreferences: {
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    try {
      if (GOOGLE_LOGIN_HOSTS.includes(new URL(details.url).host)) {
        details.requestHeaders['User-Agent'] = FIREFOX_UA;
      }
    } catch {}
    cb({ requestHeaders: details.requestHeaders });
  });
  enableAdblock().catch((e) => console.error('adblock init failed:', e.message));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
