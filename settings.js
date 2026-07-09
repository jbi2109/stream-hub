// Settings: the settings object + DEFAULTS, and the tabbed #settings screen.
// Built once at load so the legacy id'd controls (#tmdb-key, #sources, #default-source,
// #export-settings, #version…) exist for app.js to wire. This file owns the NEW controls
// (theme / accent / poster size / toggles / library actions / reset + tab switching).

const SETTINGS_DEFAULTS = {
  theme: 'dark',            // 'dark' | 'light'
  accent: '#4c8dff',        // one of ACCENTS
  posterSize: 160,          // grid minmax min, px
  landingView: 'browse',    // 'browse' | 'library' — first view on launch
  defaultBrowseTab: 'movie',// 'movie' | 'tv' | 'anime'
  watchRegion: 'US',        // TMDB "where to watch" region
  trackContinue: true,      // auto-add to Continue Watching as you watch
  autoAdvanceLater: true,   // Watch Later follows the episode you're on
  autoplayTrailers: true,   // trailer opens with autoplay
  liveLanguage: '',         // '' = any; floats this language to the top of the live source picker
  captureDebounce: 600,     // ms before a watched page is captured
  // ⚙ main-process settings (mirrored to userData/settings.json via sh.setSetting; live-applied)
  adblock: true,            // ad-blocking on/off
  extraAuthHosts: '',       // comma-separated extra hosts allowed to open login pop-ups
  googleUaSpoof: true,      // present Google sign-in as Firefox ("browser not secure" fix)
  autoUpdateCheck: true,    // check for updates on launch
  progressPollMs: 5000,     // playback-position poll interval (new players)
  adlistRefreshHours: 24,   // ad-list cache age before re-download (next launch)
  catalogTimeoutSec: 60,    // live-catalog fetch abort
};
let settings = { ...SETTINGS_DEFAULTS, ...load('settings', {}) };
function saveSettings() { store('settings', settings); }

// The ⚙ subset in the shape main.js wants (extraAuthHosts: comma string -> array of hosts).
function mainSubset(s) {
  return {
    adblock: s.adblock !== false,
    progressPollMs: +s.progressPollMs || 5000,
    adlistRefreshHours: +s.adlistRefreshHours || 24,
    extraAuthHosts: String(s.extraAuthHosts || '').split(',').map((x) => x.trim()).filter(Boolean),
    googleUaSpoof: s.googleUaSpoof !== false,
    autoUpdateCheck: s.autoUpdateCheck !== false,
    catalogTimeoutSec: +s.catalogTimeoutSec || 60,
  };
}
const pushMain = () => window.sh?.setSetting?.(mainSubset(settings));

const ACCENTS = ['#4c8dff', '#8b5cf6', '#22c55e', '#f97316', '#ef4444', '#14b8a6'];
const REGIONS = [['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'],
  ['AU', 'Australia'], ['IN', 'India'], ['DE', 'Germany'], ['FR', 'France'], ['BR', 'Brazil']];
const POSTER_SIZES = [[130, 'Small'], [160, 'Medium'], [200, 'Large']]; // [value, label] for segmented()
const LIVE_LANGS = [['', '(any)'], ['English', 'English'], ['Spanish', 'Spanish'], ['French', 'French'],
  ['German', 'German'], ['Italian', 'Italian'], ['Portuguese', 'Portuguese'], ['Dutch', 'Dutch'],
  ['Arabic', 'Arabic'], ['Russian', 'Russian'], ['Turkish', 'Turkish']];

let settingsTab = 'general';
let settingsTabsBar = null;
const settingsPanels = {}; // id -> panel node (built once, kept so wired controls survive tab switches)

// ---- small control builders ----

// A settings row: label + one-line hint on the left, the control on the right.
function settingRow(label, hint, control) {
  const row = mk('div', 'set-row');
  const lab = mk('div', 'set-label');
  lab.append(mk('div', 'set-label-t', label));
  if (hint) lab.append(mk('div', 'set-hint', hint));
  const ctrl = mk('div', 'set-control');
  ctrl.append(control);
  row.append(lab, ctrl);
  return row;
}

// A checkbox styled as a switch, bound to settings[key]. `after` runs post-save (⚙ rows push to main).
function toggleControl(key, after) {
  const wrap = mk('label', 'switch');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = settings[key] !== false;
  cb.onchange = () => { settings[key] = cb.checked; saveSettings(); if (after) after(); };
  wrap.append(cb, mk('span', 'slider'));
  return wrap;
}

// A segmented pill group; `opts` = [[value,label],…]. onPick(value) after saving.
function segmented(current, opts, onPick) {
  const bar = mk('div', 'segmented');
  const draw = () => [...bar.children].forEach((b) => b.classList.toggle('on', b.dataset.v === String(current)));
  for (const [v, l] of opts) {
    const b = mk('button', null, l);
    b.dataset.v = v;
    b.onclick = () => { current = v; draw(); onPick(v); };
    bar.append(b);
  }
  draw();
  return bar;
}

function selectControl(current, opts, onPick) {
  const sel = document.createElement('select');
  sel.className = 'set-select';
  for (const [v, l] of opts) {
    const o = mk('option', null, l); o.value = v; if (String(v) === String(current)) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => onPick(sel.value);
  return sel;
}

function actionButton(label, cls, onClick) {
  const b = mk('button', 'set-btn' + (cls ? ' ' + cls : ''), label);
  b.onclick = onClick;
  return b;
}

// ---- panels ----

function buildGeneral() {
  const p = mk('div', 'set-panel');

  const tmdb = document.createElement('input');
  tmdb.id = 'tmdb-key';
  tmdb.placeholder = 'TMDB API key';
  p.append(settingRow('TMDB API key', 'Powers Browse. Get a free v3 key at themoviedb.org → Settings → API.', tmdb));

  // default player picker (populated by renderDefaultPicker; hidden until there are players)
  const dpRow = mk('div', 'set-row');
  dpRow.id = 'default-player-row';
  const dpLab = mk('div', 'set-label');
  dpLab.append(mk('div', 'set-label-t', 'Default source'), mk('div', 'set-hint', 'Preselected on the detail page.'));
  const dpCtrl = mk('div', 'set-control');
  const dsel = document.createElement('select'); dsel.id = 'default-source';
  dpCtrl.append(dsel);
  dpRow.append(dpLab, dpCtrl);
  p.append(dpRow);

  p.append(settingRow('Watch region', 'Region for "where to watch" on the detail page.',
    selectControl(settings.watchRegion, REGIONS, (v) => { settings.watchRegion = v; saveSettings(); })));

  p.append(settingRow('Landing view', 'Which screen opens on launch.',
    segmented(settings.landingView, [['browse', 'Browse'], ['library', 'Library']],
      (v) => { settings.landingView = v; saveSettings(); })));

  p.append(settingRow('Default Browse tab', 'Which tab Browse opens on.',
    selectControl(settings.defaultBrowseTab, [['movie', 'Movies'], ['tv', 'TV'], ['anime', 'Anime']],
      (v) => { settings.defaultBrowseTab = v; saveSettings(); })));

  return p;
}

function buildAppearance() {
  const p = mk('div', 'set-panel');

  p.append(settingRow('Theme', 'Dark or light.',
    segmented(settings.theme, [['dark', 'Dark'], ['light', 'Light']],
      (v) => { settings.theme = v; saveSettings(); applyThemeVars(settings); })));

  const swatches = mk('div', 'swatches');
  const drawSw = () => [...swatches.children].forEach((s) => s.classList.toggle('on', s.dataset.c === settings.accent));
  for (const c of ACCENTS) {
    const s = mk('button', 'swatch'); s.dataset.c = c; s.style.background = c; s.title = c;
    s.onclick = () => { settings.accent = c; saveSettings(); applyThemeVars(settings); drawSw(); };
    swatches.append(s);
  }
  drawSw();
  p.append(settingRow('Accent color', 'Drives buttons, active tabs, progress.', swatches));

  p.append(settingRow('Poster size', 'Grid poster width.',
    segmented(settings.posterSize, POSTER_SIZES, (v) => { settings.posterSize = +v; saveSettings(); applyThemeVars(settings); })));

  return p;
}

function buildSources() {
  const p = mk('div', 'set-panel');
  p.append(mk('div', 'set-hint', 'Add embed players / sites. Movies/TV & Anime play through a pattern; Live TV is a site or a JSON catalog.'));
  const box = mk('div'); box.id = 'sources';
  const add = mk('button', 'add-btn', '+ Add player / source'); add.id = 'add-source-btn';
  p.append(box, add);
  return p;
}

function buildPlayback() {
  const p = mk('div', 'set-panel');
  p.append(settingRow('Track Continue Watching', 'Auto-add shows to Continue Watching as you watch.', toggleControl('trackContinue')));
  p.append(settingRow('Auto-advance Watch Later', 'Watch Later follows the episode you are on.', toggleControl('autoAdvanceLater')));
  p.append(settingRow('Autoplay trailers', 'Start trailers automatically.', toggleControl('autoplayTrailers')));
  p.append(settingRow('Default live language', 'Floats this language to the top of the live source picker.',
    selectControl(settings.liveLanguage, LIVE_LANGS, (v) => { settings.liveLanguage = v; saveSettings(); })));
  return p;
}

function buildPrivacy() {
  const p = mk('div', 'set-panel');

  p.append(settingRow('Ad-blocking', 'Full uBlock-style lists (network + cosmetic). Applies immediately.',
    toggleControl('adblock', pushMain)));

  const hosts = document.createElement('input');
  hosts.className = 'set-input'; hosts.id = 'extra-auth-hosts';
  hosts.placeholder = 'login.example.com, auth.other.com';
  hosts.value = settings.extraAuthHosts || '';
  hosts.onchange = () => { settings.extraAuthHosts = hosts.value.trim(); saveSettings(); pushMain(); };
  p.append(settingRow('Extra login pop-up hosts', 'Hosts allowed to open sign-in pop-ups, comma-separated. Applies immediately.', hosts));

  p.append(settingRow('Google sign-in fix', 'Presents Google login as Firefox so it isn’t blocked as an "insecure browser". Turn off only if sign-in misbehaves.',
    toggleControl('googleUaSpoof', pushMain)));

  return p;
}

function buildLibrary() {
  const p = mk('div', 'set-panel');

  const io = mk('div', 'set-btn-row'); io.id = 'settings-io';
  const exp = mk('button', 'set-btn', 'Export'); exp.id = 'export-settings'; exp.title = 'Save all your data to a JSON file';
  const imp = mk('button', 'set-btn', 'Import'); imp.id = 'import-settings'; imp.title = 'Load data from a JSON file';
  const impFile = document.createElement('input'); impFile.id = 'import-file'; impFile.type = 'file';
  impFile.accept = 'application/json,.json'; impFile.hidden = true;
  io.append(exp, imp, impFile);
  p.append(settingRow('Backup', 'Export / import sources, TMDB key, and library as JSON.', io));

  const clearC = actionButton('Clear Continue Watching', 'danger', () => {
    if (!confirm('Clear all Continue Watching entries?')) return;
    cont.length = 0; store('continue', cont); if (!$('home').hidden) renderHome();
  });
  const clearL = actionButton('Clear Watch Later', 'danger', () => {
    if (!confirm('Clear all Watch Later entries?')) return;
    later.length = 0; store('watchlater', later); if (!$('home').hidden) renderHome();
  });
  p.append(settingRow('Clear library', 'Remove saved entries (does not delete sources).',
    rowOf(clearC, clearL)));

  const refetch = actionButton('Re-fetch titles', null, () => {
    localStorage.removeItem('libraryHealed'); healLibrary();
  });
  const merge = actionButton('Merge duplicates', null, () => {
    rekeyLibrary(); if (!$('home').hidden) renderHome();
  });
  p.append(settingRow('Fix up library', 'Re-title from TMDB, or merge the same show saved twice.',
    rowOf(refetch, merge)));

  return p;
}

function buildUpdates() {
  const p = mk('div', 'set-panel');
  const ver = mk('span', 'set-val', ''); ver.id = 'version'; ver.title = 'Click to check for updates';
  const status = mk('span', 'set-status', ''); status.id = 'update-status';
  const check = actionButton('Check now', null, () => $('version').click());
  const line = mk('div', 'set-btn-row'); line.append(ver, check, status);
  p.append(settingRow('Version', 'Updates install on quit, or via the Restart banner.', line));
  p.append(settingRow('Check for updates on launch', 'Off = updates only when you press Check now.',
    toggleControl('autoUpdateCheck', pushMain)));
  return p;
}

// A numeric ⚙ input bound to settings[key]; clamps to min, saves + pushes to main.
function numControl(key, min) {
  const inp = document.createElement('input');
  inp.className = 'set-input'; inp.type = 'number'; inp.min = String(min); inp.step = '1';
  inp.value = settings[key];
  inp.onchange = () => { const n = +inp.value; if (n >= min) { settings[key] = n; saveSettings(); pushMain(); } };
  return inp;
}

function buildAdvanced() {
  const p = mk('div', 'set-panel');
  p.append(mk('div', 'set-warn', '⚠ Defaults are recommended — change these only if you know why.'));

  const deb = document.createElement('input');
  deb.className = 'set-input'; deb.type = 'number'; deb.min = '100'; deb.step = '100';
  deb.value = settings.captureDebounce;
  deb.onchange = () => { const n = +deb.value; if (n >= 100) { settings.captureDebounce = n; saveSettings(); } };
  p.append(settingRow('Capture debounce (ms)', 'Delay before a watched page is saved to Continue Watching.', deb));

  p.append(settingRow('Progress poll interval (ms)', 'How often playback position is read. Applies to newly opened players.',
    numControl('progressPollMs', 1000)));
  p.append(settingRow('Ad-list refresh (hours)', 'Ad-block list cache age before re-downloading. Applies on next launch.',
    numControl('adlistRefreshHours', 1)));
  p.append(settingRow('Live catalog timeout (s)', 'How long a slow live catalog may load before it is marked failed.',
    numControl('catalogTimeoutSec', 5)));

  p.append(settingRow('Reset settings', 'Restore these settings to defaults (sources & library are kept).',
    actionButton('Reset settings', 'danger', () => {
      if (!confirm('Reset all settings to defaults? Sources and library are kept.')) return;
      settings = { ...SETTINGS_DEFAULTS };
      saveSettings(); applyThemeVars(settings); pushMain(); rebuildSettings();
    })));

  return p;
}

function buildAbout() {
  const p = mk('div', 'set-panel');
  p.append(mk('div', 'about-title', 'Stream Hub'));
  p.append(mk('div', 'set-hint', 'A thin browser shell that turns the streaming sites you add into one tidy media library. It scrapes nothing and ships no sources.'));
  const gh = mk('a', 'about-link', 'github.com/jbi2109/stream-hub');
  gh.href = 'https://github.com/jbi2109/stream-hub'; gh.target = '_blank';
  p.append(settingRow('Source', 'MIT licensed.', gh));
  p.append(mk('div', 'set-hint', 'Movie & TV metadata from TMDB (themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.'));
  p.append(mk('div', 'set-hint', 'You are responsible for the sites you add and for accessing only content you are entitled to.'));
  return p;
}

// small helper: a horizontal row of buttons
function rowOf(...btns) { const r = mk('div', 'set-btn-row'); r.append(...btns); return r; }

const SETTINGS_TABS = [
  ['general', 'General'], ['appearance', 'Appearance'], ['sources', 'Sources'],
  ['playback', 'Playback'], ['privacy', 'Privacy & blocking'], ['library', 'Library'],
  ['updates', 'Updates'], ['advanced', 'Advanced'], ['about', 'About'],
];
const SETTINGS_BUILDERS = {
  general: buildGeneral, appearance: buildAppearance, sources: buildSources, playback: buildPlayback,
  privacy: buildPrivacy, library: buildLibrary, updates: buildUpdates, advanced: buildAdvanced, about: buildAbout,
};

function showSettingsTab(id) {
  settingsTab = id;
  for (const [tid, panel] of Object.entries(settingsPanels)) panel.hidden = tid !== id;
  for (const b of settingsTabsBar.children) b.classList.toggle('active', b.dataset.tab === id);
}

function buildSettings() {
  const wrap = mk('div', 'settings-wrap');
  settingsTabsBar = tabBar(SETTINGS_TABS, settingsTab, showSettingsTab, 'settings-tabs');
  const body = mk('div', 'settings-body');
  for (const [id] of SETTINGS_TABS) {
    const panel = SETTINGS_BUILDERS[id]();
    settingsPanels[id] = panel;
    body.append(panel);
  }
  wrap.append(settingsTabsBar, body);
  $('settings').replaceChildren(wrap);
  showSettingsTab(settingsTab);
}

// Rebuild from scratch (used by Reset so control values re-read `settings`). Re-wires the
// legacy controls afterwards, since Reset destroys the old #tmdb-key / #default-source nodes.
function rebuildSettings() {
  buildSettings();
  if (typeof wireSettingsControls === 'function') wireSettingsControls();
  renderSources();
}

buildSettings();
