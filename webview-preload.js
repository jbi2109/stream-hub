// Runs in each guest page (streaming sites, Google login) at document start, in the page's
// main world (the webview attaches with contextIsolation:false). Neuters WebAuthn so Google's
// "Choose a passkey" (Windows Hello) dialog never pops and login falls back to password.
try {
  delete window.PublicKeyCredential;
  if (window.navigator && navigator.credentials) {
    navigator.credentials.get = () => Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError'));
    navigator.credentials.create = () => Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError'));
  }
} catch (e) {}

// On Google's login hosts, present Firefox to page JS too (not just the request header),
// so navigator.userAgent matches and Google doesn't flag the embedded browser as insecure.
try {
  if (['accounts.google.com', 'accounts.youtube.com'].includes(location.host)) {
    const FF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
    Object.defineProperty(navigator, 'userAgent', { get: () => FF });
    Object.defineProperty(navigator, 'appVersion', { get: () => '5.0 (Windows)' });
    Object.defineProperty(navigator, 'vendor', { get: () => '' });        // Firefox: empty
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined }); // Firefox has none
  }
} catch (e) {}

// YouTube video-ad blocking (CSP-safe): prune ad fields out of the player config before the player
// reads them, and auto-skip anything that slips through. Runs only when main says so (YT host + setting).
try {
  const { ipcRenderer } = require('electron');
  if (ipcRenderer.sendSync('yt-adblock', location.host)) {
    const prune = (o) => {
      if (o && typeof o === 'object') {
        delete o.playerAds; delete o.adPlacements; delete o.adSlots;
        for (const k of ['playerResponse', 'ytInitialPlayerResponse']) {
          if (o[k]) { delete o[k].playerAds; delete o[k].adPlacements; delete o[k].adSlots; }
        }
      }
      return o;
    };
    // Proxy the two JSON entry points the player config arrives through. Installed synchronously at
    // document_start, BEFORE YouTube's bootstrap captures them. Persist across SPA navigations.
    const _parse = JSON.parse;
    JSON.parse = function () { return prune(_parse.apply(this, arguments)); };
    const _json = Response.prototype.json;
    Response.prototype.json = function () { return _json.apply(this, arguments).then(prune); };
    // The first-load pre-roll rides the inline `var ytInitialPlayerResponse = {...}` literal (not
    // JSON.parse'd) — trap the global assignment and prune on set.
    try {
      let _yt;
      Object.defineProperty(window, 'ytInitialPlayerResponse', {
        get: () => _yt, set: (v) => { _yt = prune(v); }, configurable: true,
      });
    } catch (e) {}
    // Fallback for leaks / server-side-inserted ads: mute + fast-forward the ad and click skip.
    const skipSels = ['.ytp-ad-skip-button-modern', '.ytp-skip-ad-button', '.ytp-ad-skip-button'];
    const tick = () => {
      const p = document.getElementById('movie_player');
      if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) {
        const v = document.querySelector('video');
        if (v) { v.muted = true; if (isFinite(v.duration) && v.duration) v.currentTime = v.duration; }
        for (const s of skipSels) { const b = document.querySelector(s); if (b) { b.click(); break; } }
      }
    };
    // ponytail: selectors because YT rotates ytp-ad-* class names; add to skipSels when one stops matching.
    const start = () => new MutationObserver(tick).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class'],
    });
    if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  }
} catch (e) {}

// Controller support while a video is playing. Chromium only updates gamepad state for the FOCUSED
// document, and the guest owns focus whenever the player is up — so the host renderer's poll goes dead,
// exactly like the keyboard does (which is why main forwards Escape / Ctrl+K from before-input-event).
// There is no before-input-event for gamepads, so poll here and forward the same two actions.
// Only B (back) and Start (palette) are forwarded: the D-pad has nothing to move while the player is
// full-frame, and A belongs to the embedded player's own controls.
try {
  if (window.top === window) {
    const { ipcRenderer } = require('electron');
    const BTN = { B: 1, START: 9 };
    const down = new Set();
    let primed = false, raf = null;

    const pollGuestPad = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = [...pads].find((p) => p && p.connected);
      if (!pad) { down.clear(); primed = false; return false; }
      for (const [name, i] of Object.entries(BTN)) {
        const pressed = !!(pad.buttons[i] && pad.buttons[i].pressed);
        if (!pressed) { down.delete(i); continue; }
        if (down.has(i)) continue;
        down.add(i);
        // first sample only records what's already held — entering the player mid-press must not fire
        if (primed) ipcRenderer.send('guest-pad', name === 'B' ? 'back' : 'palette');
      }
      primed = true;
      return true;
    };
    window.__shPollPad = pollGuestPad; // e2e drives one tick with a stubbed navigator.getGamepads

    const loop = () => { pollGuestPad(); raf = requestAnimationFrame(loop); };
    window.addEventListener('gamepadconnected', () => { if (raf == null) loop(); });
    window.addEventListener('gamepaddisconnected', () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      if (![...pads].some((p) => p && p.connected) && raf != null) { cancelAnimationFrame(raf); raf = null; }
    });
  }
} catch (e) {}
