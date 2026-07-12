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
  // Precedence: known -> TMDB looked up by the URL's id -> scrape -> url (provider-agnostic).
  const tmdb = intendedMedia?.live ? null : await tmdbMeta(tmdbIdOf(url), type);
  const title = intendedMedia?.title || tmdb?.title || page.title || url;
  const poster = intendedMedia?.poster || tmdb?.poster || page.poster;
  later = later.filter((c) => c.key !== key); // dedupe
  later.unshift({ key, title, url, poster, season, episode, type, addedAt: Date.now() });
  store('watchlater', later);
  toast(`Added to Watch Later — ${title}`);
};

// ---- rail + topbar navigation ----
// 🔎 Browse shows Movies/TV/Anime only; if we're on Live (its tab bar was removed) reset to a VOD tab.
$('browse-btn').onclick = () => { if (browseTab === 'live') browseTab = settings.defaultBrowseTab || 'movie'; showBrowse(); };
$('dash-btn').onclick = showDashboard;
$('home-btn').onclick = showHome;
$('live-btn').onclick = () => { browseTab = 'live'; showBrowse(); };
$('youtube-btn').onclick = () => open('https://www.youtube.com', false); // untracked: don't clobber Resume
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
  tmdbKeyInput.onchange = () => { tmdbKey = tmdbKeyInput.value.trim(); store('tmdbKey', tmdbKey); if (!$('browse').hidden) renderBrowse(); };

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
    r.onload = () => { try { importSettings(JSON.parse(r.result)); location.reload(); } catch { toast('Invalid settings file.', 'error'); } };
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

// ---- settings export / import (all localStorage: sources, tmdbKey, library, settings, defaults) ----
function exportSettings() { return Object.fromEntries(Object.entries(localStorage)); }
function importSettings(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
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
healLibrary();           // one-time: re-title old entries from TMDB (no-op once done / without a key)

// "What's New" once per version bump: the release body IS the CHANGELOG section (set by the release
// ritual), fetched via main's httpGet. Fetch failure (offline / no release for a dev version) still
// shows the modal with a link. First-ever run seeds silently — no wall of history.
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
