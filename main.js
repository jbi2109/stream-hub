const { app, BrowserWindow, session, ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const fs = require('fs');

// e2e tests run against a throwaway profile so they never touch real bookmarks/logins
if (process.argv.includes('--test-profile')) {
  app.setPath('userData', path.join(os.tmpdir(), 'stream-hub-test-profile'));
} else if (!app.isPackaged) {
  // Dev runs (npm start) use a separate `-dev` data folder so testing never touches the
  // installed app's real sources/logins. The packaged build keeps the default folder.
  app.setPath('userData', app.getPath('userData') + '-dev');
}

// Packaged app: single instance only — a second launch focuses the existing window.
// Skipped in dev/tests so the e2e harness can launch its own instance freely.
let mainWindow = null;
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// Some streaming sites / Cloudflare block the Electron user agent
app.userAgentFallback = app.userAgentFallback.replace(/(Electron|stream-hub)\/\S+\s?/g, '');
const DEFAULT_UA = app.userAgentFallback;

// ⚙ main-process settings, mirrored from the renderer's Settings screen via the set-setting IPC and
// persisted to userData/settings.json (read here at startup; the renderer re-pushes at boot so an
// Import/Reset stays in sync). Everything except progressPollMs (new players only) and
// adlistRefreshHours (next launch) applies live.
const MAIN_DEFAULTS = {
  adblock: true,           // network+cosmetic ad-blocking on the whole session
  progressPollMs: 5000,    // playback-position poll (per webview, set at attach)
  adlistRefreshHours: 24,  // ad-list cache age before a re-download
  extraAuthHosts: [],      // extra hosts allowed to open login pop-ups
  googleUaSpoof: true,     // present Google sign-in as Firefox ("browser not secure" fix)
  autoUpdateCheck: true,   // check for updates on launch
  catalogTimeoutSec: 60,   // live-catalog fetch abort
};
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let ms = { ...MAIN_DEFAULTS };
try { ms = { ...MAIN_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch {}

// Kill the "Choose a passkey" (WebAuthn/Windows Hello) prompt Google auto-triggers on its
// login page — it spams and derails password login. This media app needs no passkeys.
app.commandLine.appendSwitch('disable-features',
  'WebAuthenticationConditionalUI,WebAuthentication,WebAuthenticationRemoteDesktopSupport');

// Login popups allowed for these hosts only; everything else cross-host is an ad
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'www.facebook.com',
                    'discord.com', 'github.com', 'login.live.com'];

// Google refuses OAuth from embedded Chromium ("browser may not be secure");
// it accepts the flow when the login window presents as Firefox
// Keep this byte-identical to the FF string in webview-preload.js so the header + navigator agree.
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const GOOGLE_LOGIN_HOSTS = ['accounts.google.com', 'accounts.youtube.com'];
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
if (process.env.SH_TEST_UA_HOST) GOOGLE_LOGIN_HOSTS.push(process.env.SH_TEST_UA_HOST);
// Single choke point for the whole Google-UA spoof (header rewrite, hint strip, pop-out window, per-nav
// setUserAgent): gated on the ⚙ googleUaSpoof setting. The guest preload's navigator spoof can't read
// main state and stays on — harmless alone, since the header spoof is what Google keys on.
const isGoogleLoginHost = (url) => {
  if (ms.googleUaSpoof === false) return false;
  try { return GOOGLE_LOGIN_HOSTS.includes(new URL(url).host); } catch { return false; }
};

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
  // ponytail: interval is the ⚙ progressPollMs setting; applies to players opened after a change
  const timer = setInterval(async () => {
    const v = await readVideo(contents);
    if (v) contents.hostWebContents?.send('video-progress', v);
  }, ms.progressPollMs || 5000);
  contents.on('destroyed', () => clearInterval(timer));
  // While the guest owns the keyboard, document keydowns never reach the host renderer — forward the
  // two in-player shortcuts from here: Esc (exit player) and Ctrl/Cmd+K (command palette).
  contents.on('before-input-event', (_ev, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape') contents.hostWebContents?.send('exit-player');
    else if ((input.control || input.meta) && String(input.key).toLowerCase() === 'k') contents.hostWebContents?.send('open-palette');
  });
  // Google's client JS checks navigator.userAgent (not just the header) — present Firefox
  // on its login hosts so it doesn't block the embedded browser; restore default elsewhere.
  contents.on('did-start-navigation', (_ev, url, _inPage, isMainFrame) => {
    if (isMainFrame) contents.setUserAgent(isGoogleLoginHost(url) ? FIREFOX_UA : DEFAULT_UA);
  });
  // every window we allow is a login popup — make its JS environment report Firefox too
  contents.on('did-create-window', (win) => { if (ms.googleUaSpoof !== false) win.webContents.setUserAgent(FIREFOX_UA); });
  // In-place login navigations (e.g. YouTube → accounts.google.com in the main frame) are popped out
  // to a standalone top-level window — Google blocks its embedded-browser check on <webview> guests.
  contents.on('will-navigate', (e, url) => {
    if (isGoogleLoginHost(url)) { e.preventDefault(); openGoogleLoginWindow(url, hostOf(contents.getURL())); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const host = new URL(url).host;
      if (host === new URL(contents.getURL()).host) {
        contents.loadURL(url); // same-site _blank link navigates in place
        return { action: 'deny' };
      }
      const allowed = [...AUTH_HOSTS, ...(ms.extraAuthHosts || [])]; // ⚙ user-added login hosts
      if (allowed.some((h) => host === h || host.endsWith('.' + h))) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 500, height: 700, autoHideMenuBar: true },
        };
      }
    } catch {}
    return { action: 'deny' }; // ad popunders
  });
});

// Network + cosmetic + scriptlet ad-blocking (Ghostery engine, uBlock-style full lists).
// Full lists (not just network rules) are what block YouTube ads, which are served from
// the video domain and need cosmetic/scriptlet injection.
let blocker = null;          // kept so the ⚙ ad-block toggle can disable/re-enable live
let blockingEnabled = false;
async function enableAdblock() {
  if (process.env.SH_TEST_BLOCK_PATTERN) {
    blocker = ElectronBlocker.parse(process.env.SH_TEST_BLOCK_PATTERN); // deterministic e2e rule
  } else {
    const cachePath = path.join(app.getPath('userData'), 'adblock-full.bin');
    // ponytail: refresh age is the ⚙ adlistRefreshHours setting; YouTube fights blockers so stale lists rot
    let fresh = false;
    try { fresh = (Date.now() - fs.statSync(cachePath).mtimeMs) < (ms.adlistRefreshHours || 24) * 3600 * 1000; } catch {}
    const cache = fresh
      ? { path: cachePath, read: fs.promises.readFile, write: fs.promises.writeFile }
      : { path: cachePath, write: fs.promises.writeFile }; // missing/stale -> fetch latest lists
    try {
      blocker = await ElectronBlocker.fromPrebuiltFull(fetch, cache);
    } catch (e) {
      console.error('full adblock list unavailable, trying ads-only:', e.message);
      try {
        blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
      } catch (e2) {
        console.error('adblock unavailable, continuing without:', e2.message);
        return;
      }
    }
  }
  // YouTube: inject cosmetic element-hiding CSS (hides Sponsored feed tiles + masthead) but NOT the
  // scriptlets. uBlock's YouTube scriptlets (json-prune ytInitialPlayerResponse, set-constant …) mangle
  // the player's init data → black, silent player; CSS element-hiding can't. `getInjectionRules:false`
  // asks the engine for styles without the +js() scriptlets. Ghostery calls onInjectCosmeticFilters
  // fresh per frame, so wrapping it here scopes this to YouTube; every other site keeps full blocking,
  // and network blocking stays on everywhere.
  const YT_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com|youtu\.be)$/i;
  const ytTestHost = process.env.SH_TEST_YT_HOST; // e2e hook: treat a fixture host as "YouTube"
  const origInject = blocker.onInjectCosmeticFilters;
  blocker.onInjectCosmeticFilters = async (event, url, msg) => {
    try {
      const host = new URL(url).hostname;
      if (YT_HOSTS.test(host) || (ytTestHost && url.includes(ytTestHost))) {
        const first = msg === undefined;
        const { active, styles } = blocker.getCosmeticsFilters({
          domain: host.split('.').slice(-2).join('.'), hostname: host, url,
          classes: msg?.classes, hrefs: msg?.hrefs, ids: msg?.ids,
          getBaseRules: first, getInjectionRules: false, getExtendedRules: false,
          getRulesFromHostname: first, getRulesFromDOM: !first,
          callerContext: { frameId: event.frameId, processId: event.processId, lifecycle: msg?.lifecycle },
        });
        if (active !== false && styles && styles.length) event.sender.insertCSS(styles, { cssOrigin: 'user' });
        return;
      }
    } catch {}
    return origInject(event, url, msg);
  };

  blocker.enableBlockingInSession(session.defaultSession); // webview shares default session
  blockingEnabled = true;
}

// Sync blocking with the ⚙ adblock setting — live, no restart. First enable builds the engine lazily
// (covers launching with ad-block off, then turning it on).
async function applyAdblock() {
  const want = ms.adblock !== false;
  if (want === blockingEnabled) return;
  if (want) {
    if (blocker) { blocker.enableBlockingInSession(session.defaultSession); blockingEnabled = true; }
    else await enableAdblock();
  } else if (blocker) {
    blocker.disableBlockingInSession(session.defaultSession);
    blockingEnabled = false;
  }
}

// Open a Google login URL in a standalone top-level window (not the embedded <webview>), with the same
// Firefox spoof preload so it presents cleanly. Cookies are shared (default session), so on return the
// webview is reloaded to pick up the new sign-in. `returnHost` = the host the login started from.
function openGoogleLoginWindow(url, returnHost) {
  if (!mainWindow) return;
  const win = new BrowserWindow({
    width: 500,
    height: 660,
    parent: mainWindow,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'webview-preload.js'),
      contextIsolation: false, // preload runs in the page's world (same posture as the guest)
      nodeIntegration: false,
    },
  });
  win.webContents.setUserAgent(FIREFOX_UA);
  // Best-effort auto-close once login returns to the originating site; the `closed` handler is the
  // guaranteed path that reloads the webview so it sees the new session cookies.
  const check = (u) => { try { if (returnHost && hostOf(u) === returnHost && !win.isDestroyed()) win.close(); } catch {} };
  win.webContents.on('did-navigate', (_e, u) => check(u));
  win.webContents.on('will-redirect', (_e, u) => check(u));
  win.on('closed', () => { try { mainWindow && mainWindow.webContents.send('auth-reload'); } catch {} });
  win.loadURL(url);
}

function createWindow() {
  // Restore the last window size/position (+ maximized), saved on close to userData/window.json.
  const boundsPath = path.join(app.getPath('userData'), 'window.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(boundsPath, 'utf8')); if (!(saved.width > 200 && saved.height > 200)) saved = null; } catch {}
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...(saved && { x: saved.x, y: saved.y, width: saved.width, height: saved.height }),
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    icon: path.join(__dirname, 'build', 'icon.ico'), // taskbar/window icon (dev too — win.icon only applies when packaged)
    webPreferences: {
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  if (saved && saved.maximized) win.maximize();
  win.on('close', () => {
    try { fs.writeFileSync(boundsPath, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
  });
  // Give every guest <webview> a preload that neuters WebAuthn in its main world.
  win.webContents.on('will-attach-webview', (_e, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'webview-preload.js');
    webPreferences.contextIsolation = false; // so the preload runs in the page's world
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  mainWindow = win;
  return win;
}

// In-app auto-update from GitHub Releases (packaged builds only; silent on errors).
function initUpdater() {
  if (!app.isPackaged || process.argv.includes('--test-profile')) return;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (ch, data) => { try { mainWindow && mainWindow.webContents.send(ch, data); } catch {} };
  const status = (state, extra) => send('update-status', { state, ...extra });
  autoUpdater.on('checking-for-update', () => status('checking'));
  autoUpdater.on('update-available', (info) => status('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', () => status('none'));
  autoUpdater.on('download-progress', (p) => send('update-progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update-ready', { version: info.version }));
  autoUpdater.on('error', (e) => { console.error('updater:', e && e.message); status('error', { message: e && e.message }); }); // offline / no release yet
  if (ms.autoUpdateCheck !== false) autoUpdater.checkForUpdates().catch(() => {}); // ⚙ check-on-launch
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    try {
      if (isGoogleLoginHost(details.url)) { // gated on the ⚙ googleUaSpoof setting
        details.requestHeaders['User-Agent'] = FIREFOX_UA;
        // Real Firefox sends no UA Client Hints; leaving Chromium's Sec-CH-UA* headers on a Firefox
        // UA is what Google now flags as "browser may not be secure". Strip them so it's consistent.
        for (const k of Object.keys(details.requestHeaders)) {
          if (k.toLowerCase().startsWith('sec-ch-ua')) delete details.requestHeaders[k];
        }
      }
    } catch {}
    cb({ requestHeaders: details.requestHeaders });
  });
  if (ms.adblock !== false) enableAdblock().catch((e) => console.error('adblock init failed:', e.message));

  // TMDB catalog fetch (runs here to avoid the renderer CSP). Renderer passes api_key.
  const TMDB_BASE = process.env.SH_TEST_TMDB_BASE || 'https://api.themoviedb.org';
  ipcMain.handle('tmdb', async (_e, { path: p, params }) => {
    const qs = new URLSearchParams(params || {}).toString();
    try {
      const r = await fetch(`${TMDB_BASE}/3${p}${qs ? '?' + qs : ''}`);
      if (!r.ok) return { error: `HTTP ${r.status}`, results: [] };
      return await r.json();
    } catch (e) {
      return { error: e.message, results: [] };
    }
  });

  ipcMain.handle('install-update', () => { if (app.isPackaged) autoUpdater.quitAndInstall(); });

  // ⚙ settings sync from the renderer: merge, persist for the next launch, live-apply what can be.
  ipcMain.handle('set-setting', async (_e, patch) => {
    if (!patch || typeof patch !== 'object') return { error: 'bad patch' };
    Object.assign(ms, patch);
    try { fs.writeFileSync(settingsPath(), JSON.stringify(ms, null, 2)); } catch (e) { console.error('settings write:', e.message); }
    await applyAdblock().catch((e) => console.error('adblock toggle:', e.message));
    return { ok: true };
  });

  // Version string for the sidebar footer, and a manual "check for updates" trigger.
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('check-update', async () => {
    if (!app.isPackaged) return { state: 'dev' };
    try { await autoUpdater.checkForUpdates(); return { ok: true }; }
    catch (e) { return { error: e && e.message }; }
  });

  // Generic https GET (runs here to sidestep the renderer CSP). Used by live-catalog fetches
  // to reach their JSON APIs. https only (loopback http allowed for tests); no provider logic here.
  ipcMain.handle('httpGet', async (_e, url) => {
    try {
      const u = String(url);
      const okScheme = /^https:\/\//i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(u);
      if (!okScheme) return { error: 'https only' };
      // Send a browser User-Agent — many live-catalog APIs 403 the default Node/undici UA. Abort after
      // 60s so a dead/hanging catalog is skipped (the live grid renders the others incrementally).
      const r = await fetch(u, { headers: { 'User-Agent': DEFAULT_UA, 'Accept': 'application/json,text/plain,*/*' }, signal: AbortSignal.timeout((ms.catalogTimeoutSec || 60) * 1000) });
      return { ok: r.ok, status: r.status, body: await r.text() };
    } catch (e) {
      return { error: e.message };
    }
  });

  createWindow();
  initUpdater();
});
app.on('window-all-closed', () => app.quit());
