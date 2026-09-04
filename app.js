// App wiring: event handlers, auto-update banner, settings export/import, and bootstrap.
// Loaded LAST — every function it references is defined by the earlier scripts (settings.js built
// the #settings controls just before this ran), and the bootstrap at the bottom first paints the UI.

$('watch-later').onclick = async () => {
  if (webview.hidden) return;
  const url = webview.getURL();
  const page = await parsePage();
  const key = mediaKey(url);
  const { season, episode } = parseSeasonEpisode(url, page.title);
  const type = intendedMedia?.live ? 'live' : classify(url, season);
  // Shared precedence ladder (known short-circuits TMDB); `|| url` is the provider-agnostic last resort.
  const resolved = await resolveTitlePoster(url, type, intendedMedia, page, null);
  const title = resolved.title || url;
  const poster = resolved.poster;
  later = later.filter((c) => c.key !== key); // dedupe
  later.unshift({ key, title, url, poster, season, episode, type, addedAt: Date.now() });
  store('watchlater', later);
  toast(`Added to Watch Later — ${title}`);
};

// ---- rail + topbar navigation ----
// 🔎 Browse shows Movies/TV/Anime only; if we're on Live (its tab bar was removed) reset to a VOD tab.
$('browse-btn').onclick = () => { browseQuery = ''; if (browseTab === 'live') browseTab = settings.defaultBrowseTab || 'movie'; showBrowse(); };
$('dash-btn').onclick = showDashboard;
$('home-btn').onclick = showHome;
$('live-btn').onclick = () => { browseTab = 'live'; showBrowse(); };
// Return to YouTube where you left it. Only the first visit of a session loads the home page; after that
// the button reveals the page still sitting in the webview (the video you were on, its position, the
// scroll), instead of throwing you back to the feed. Untracked either way: never clobbers ⏯ Resume.
let ytHostRe = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i; // e2e retargets this at a fixture host
$('youtube-btn').onclick = () => {
  if (!ytHostRe.test(hostOf(webview.getAttribute('src') || ''))) return open('https://www.youtube.com', false);
  captureOrigin();
  revealWebview();
};
$('resume-btn').onclick = resumeLast;
$('settings-btn').onclick = showSettings;
$('back').onclick = () => webview.goBack();
$('forward').onclick = () => webview.goForward();
$('src-home').onclick = () => currentSource && open(currentSource);
$('src-switch').onchange = () => {
  if (!playing) return;
  const src = sourcesFor(playing.kind).find((s) => s.url === $('src-switch').value);
  if (src) openOn(src, playing.kind, playing.type, playing.id, playing.season, playing.episode, playing.title, playing.poster);
};
$('ep-switch').onchange = () => {
  if (!playing) return;
  const [s, e] = $('ep-switch').value.split(':').map(Number);
  const src = playingSource();
  if (src) openOn(src, playing.kind, playing.type, playing.id, s, e, playing.title, playing.poster);
};
$('autonext-btn').onclick = () => {
  settings.autoplayNext = settings.autoplayNext !== true;
  saveSettings();
  $('autonext-btn').classList.toggle('active', settings.autoplayNext);
};
$('live-sources').onclick = () => { if (currentLiveMatch) showLivePicker(currentLiveMatch); }; // reopen the live source page
$('sources-overlay').onclick = () => { if (currentLiveMatch) showLivePicker(currentLiveMatch); }; // same, from the player overlay

// Wire the controls settings.js builds. A named function so it can re-run after a settings Reset
// rebuilds those DOM nodes (which would otherwise drop their handlers).
function wireSettingsControls() {
  $('add-source-btn').onclick = () => openAddWizard(); // no arg -> add mode (not the click Event)

  const tmdbKeyInput = $('tmdb-key');
  tmdbKeyInput.value = tmdbKey;
  tmdbKeyInput.onchange = () => {
    tmdbKey = tmdbKeyInput.value.trim(); store('tmdbKey', tmdbKey);
    if (!$('browse').hidden) renderBrowse();
    // v0.20: say at once whether the key works — a wrong key used to mean a silently blank dashboard. Straight to
    // main (not tmdbGet): its cache ignores the key, so a cached success from an old key could mask a bad new one.
    if (tmdbKey) window.sh.tmdb('/configuration', { api_key: tmdbKey }).then((r) => {
      if (r && r.error) toast(`TMDB rejected that key (${r.error}) — paste the v3 API key from themoviedb.org`, 'error');
      else toast('TMDB key works');
    });
  };

  $('default-source').onchange = () => { defaultSource = $('default-source').value; store('defaultSource', defaultSource); };

  $('export-settings').onclick = () => {
    const blob = new Blob([JSON.stringify(exportSettings(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'stream-hub-settings.json'; a.click();
    URL.revokeObjectURL(a.href);
    toast('Settings exported');
  };
  $('import-settings').onclick = () => $('import-file').click();
  $('import-file').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      let skipped;
      try { skipped = importSettings(JSON.parse(r.result)); } catch { toast('Invalid settings file.', 'error'); return; }
      if (skipped) { toast(`Imported — skipped ${skipped} entr${skipped > 1 ? 'ies' : 'y'} that made no sense`); setTimeout(() => location.reload(), 1800); }
      else location.reload();
    };
    r.readAsText(file);
    e.target.value = '';
  };

  // footer/updates: show the version; clicking it triggers a manual update check
  if (window.sh && window.sh.getVersion) {
    window.sh.getVersion().then((v) => { $('version').textContent = 'v' + v; }).catch(() => {});
    $('version').onclick = async () => {
      setUpdateStatus('Checking…');
      const r = await window.sh.checkForUpdates().catch(() => ({ error: 'failed' }));
      if (r && r.state === 'dev') setUpdateStatus('dev build');
      else if (r && r.error) setUpdateStatus('Check failed — ' + r.error); // else the update-status events set the text
    };
  }
}

webview.addEventListener('did-navigate', () => { $('address').textContent = webview.getURL(); scheduleCapture(); });
webview.addEventListener('did-navigate-in-page', () => { $('address').textContent = webview.getURL(); scheduleCapture(); });
webview.addEventListener('did-stop-loading', scheduleCapture);
// v0.20: a source that fails to load used to show Chromium's raw error page and nothing else. -3 = aborted (the app
// navigated away mid-load) and subframes (ad iframes die all the time) are not the user's problem.
webview.addEventListener('did-fail-load', (e) => {
  if (e.isMainFrame === false || e.errorCode === -3) return;
  const host = hostOf(e.validatedURL);
  toast(`Couldn't load ${host} (${e.errorDescription || e.errorCode})`, 'error', { label: 'Edit source',
    aria: `Edit the source for ${host}`, onClick: () => { const s = sources.find((x) => hostOf(x.url) === host); if (s) openAddWizard(s); else showSettings(); } });
});
// v0.20: links in the shell (Get a key, GitHub, release notes) open in the system browser. The host window denies
// window.open (main.js), so without this every <a target=_blank> was dead. One delegated handler; main validates
// the scheme. A named global so e2e can observe the call without a browser launching.
function openExternal(url) { return window.sh?.openExternal?.(url); }
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || !/^https?:/i.test(a.href)) return;
  e.preventDefault();
  openExternal(a.href);
});

webview.addEventListener('enter-html-full-screen', () => webview.classList.add('fullscreen'));
webview.addEventListener('leave-html-full-screen', () => webview.classList.remove('fullscreen'));

// ---- auto-update: bottom-right banner + a status line in the Updates settings tab ----
const UPDATE_STATUS_TEXT = { checking: 'Checking for updates…', available: 'Downloading update…', none: 'Up to date', error: 'Update check failed' };
function setUpdateStatus(text) { const s = $('update-status'); if (s) s.textContent = text || ''; }

function showUpdate(state) {
  const el = $('update-banner');
  if (state.type === 'status') {
    const base = UPDATE_STATUS_TEXT[state.state] || '';
    // surface the real reason on failures ("Check failed" alone is undiagnosable from a screenshot)
    setUpdateStatus(state.state === 'error' && state.message ? `${base} — ${state.message}` : base);
  } else if (state.type === 'progress') {
    el.textContent = `Downloading update… ${state.percent}%`;
    el.hidden = false;
    setUpdateStatus(`Downloading ${state.percent}%`);
  } else if (state.type === 'ready') {
    const msg = document.createElement('span');
    msg.textContent = `Update ${state.version ? 'v' + state.version + ' ' : ''}ready`;
    const btn = document.createElement('button');
    btn.textContent = 'Restart';
    btn.onclick = () => requestInstall();
    el.replaceChildren(msg, btn);
    el.hidden = false;
    setUpdateStatus('Update ready');
  }
}
function requestInstall() { window.sh.installUpdate(); } // indirection so e2e can stub it safely
if (window.sh && window.sh.onUpdate) window.sh.onUpdate(showUpdate);

// After a standalone Google-login window closes, reload the webview so it picks up the sign-in cookies.
window.sh?.onAuthReload?.(() => { if (!webview.hidden) webview.reload(); });

// A page tried to send itself to another site (ad redirect) and main cancelled it. Name the destination
// and offer one click through: will-navigate also fires for an off-site link you meant to follow.
// open(url, false) — untracked, so the ⏯ Resume target stays on whatever you were actually watching.
// It also records the launching view for Esc and reveals the webview, which matters because the guest
// outlives the player view: a redirect fired after you left would otherwise load invisibly. App-driven
// loads are exempt from both guards, so Allow always gets through. Separate `aria` because #toast is a
// live region: repeating the text in the button's name would announce the whole message twice.
window.sh?.onBlockedNav?.((url) => toast(`Blocked a redirect to ${hostOf(url)}`, 'error',
  { label: 'Allow', aria: `Allow navigation to ${hostOf(url)}`, onClick: () => open(url, false) }));

// ---- settings export / import (all localStorage: sources, tmdbKey, library, settings, defaults) ----
function exportSettings() { return Object.fromEntries(Object.entries(localStorage)); }
// v0.20: validate shapes on the way in — a list key that is not a list bricked the next boot. Returns how many
// keys were skipped so the caller can say so. Values arrive as the export wrote them (JSON strings) or, from a
// hand-made file, as raw values; both are checked after parsing.
const IMPORT_LISTS = ['sources', 'continue', 'watchlater'];
function importSettings(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not a settings file');
  let skipped = 0;
  for (const [k, v] of Object.entries(obj)) {
    const raw = typeof v === 'string' ? v : JSON.stringify(v);
    let parsed; try { parsed = JSON.parse(raw); } catch { skipped++; continue; }
    if (IMPORT_LISTS.includes(k) && !Array.isArray(parsed)) { skipped++; continue; }
    if (k === 'settings' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) { skipped++; continue; }
    localStorage.setItem(k, raw);
  }
  return skipped;
}

// ---- bootstrap ----
if (lastPlayed && lastPlayed.url) $('resume-btn').hidden = false; // ⏯ Resume survives a restart
pushMain(); // sync main's settings.json with the renderer ⚙ subset (covers Import/Reset drift)
wireSettingsControls();
rekeyLibrary();          // host-independent keys + merge duplicate cards (before capture/heal)
renderSources();
if (settings.defaultBrowseTab) browseTab = settings.defaultBrowseTab;
browseFilters = loadFiltersFor(browseTab); // restore the landing tab's saved filter selections
if (settings.landingView === 'library') showHome();
else if (settings.landingView === 'browse') showBrowse();
else showDashboard();
// Idle-defer the non-critical boot work so it never blocks first paint (Chromium requestIdleCallback).
requestIdleCallback(() => healLibrary()); // one-time: re-title old entries from TMDB (no-op once done / without a key)

// "What's New" once per version bump: the release body IS the CHANGELOG section (set by the release
// ritual), fetched via main's httpGet. Fetch failure (offline / no release for a dev version) still
// shows the modal with a link. First-ever run seeds silently — no wall of history.
requestIdleCallback(() => {
  if (window.sh && window.sh.getVersion) {
    window.sh.getVersion().then(async (v) => {
      const last = load('lastSeenVersion', null);
      store('lastSeenVersion', v);
      if (!last || last === v) return;
      let notes = null;
      try {
        const r = await window.sh.httpGet(`https://api.github.com/repos/jbi2109/stream-hub/releases/tags/v${v}`);
        if (r && r.ok) notes = JSON.parse(r.body).body || null;
      } catch {}
      openWhatsNew(v, notes);
    }).catch(() => {});
  }
});
