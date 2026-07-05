const $ = (id) => document.getElementById(id);
const webview = $('webview');

const load = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
const store = (key, val) => localStorage.setItem(key, JSON.stringify(val));

// category: 'vod' = Movies/TV Shows, 'live' = Live TV (not tracked in Continue Watching)
// Sources are user-supplied — add your own with the "+ Add source" form.
let sources = load('sources', []);
let cont = load('continue', []);     // auto-tracked, keyed, sorted by updatedAt desc
let later = load('watchlater', []);  // button-added, deduped by key
let tmdbKey = load('tmdbKey', '');   // user's free TMDB API key (for Browse)
let currentSource = null;            // home URL for the topbar home button
let activeKey = null;                // continue entry the player position attaches to
let playing = null;                  // {kind,type,id,season,episode} of the open embed (for source switching)
let lastSourceUrl = load('lastSource', null); // last source the user watched on
let defaultSource = load('defaultSource', null); // preferred player URL for Movies/TV/Anime

const CAT_LABEL = { vod: 'Movies / TV', anime: 'Anime', live: 'Live TV' };

// Optional live-TV adapters, registered at runtime by a local, gitignored module
// (live-providers.local.js). The committed app ships none — a fresh clone stays neutral.
// An adapter = { key, name, list(): Promise<[{title,logo?,onOpen()}]>, listLive?(): same }.
// The user adds one as a Live TV "source" (category:'live', provider:key) via the add-source wizard.
const liveAdapters = {};
window.registerLiveProvider = (a) => { liveAdapters[a.key] = a; if (browseTab === 'live' && !$('browse').hidden) renderBrowse(); };
window.openLiveEmbed = (url) => open(url); // stable API for an adapter to embed a stream in the webview
let liveMode = 'all'; // Live tab: 'all' matches | 'live' now
let liveQuery = '';   // Live tab search text

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const sourceCategory = (url) => sources.find((s) => hostOf(s.url) === hostOf(url))?.category;
const isLiveUrl = (url) => sourceCategory(url) === 'live';

// --- one-time migration: give old sources a category, purge live entries from Continue ---
(function migrate() {
  let changed = false;
  sources = sources.map((s) => {
    if (s.category) return s;
    changed = true;
    return { ...s, category: 'vod' }; // default; user can flip a source to Live TV
  });
  if (changed) store('sources', sources);
  const before = cont.length;
  cont = cont.filter((c) => !isLiveUrl(c.url)); // Live TV never belongs in Continue Watching
  if (cont.length !== before) store('continue', cont);
})();

// ---------- page inspection ----------

// Stable per-title id: first 3+ digit run in the path (TMDB id), else the path.
function mediaKey(url) {
  try {
    const u = new URL(url);
    const id = u.pathname.match(/\/(\d{3,})/);
    return u.host + (id ? '#' + id[1] : u.pathname);
  } catch { return url; }
}

function parseSeasonEpisode(url, title) {
  try {
    const u = new URL(url);
    const q = u.searchParams;
    const s = q.get('season') ?? q.get('s');
    const e = q.get('episode') ?? q.get('e');
    if (s && e) return { season: +s, episode: +e };
    // path form .../<id>/<season>/<episode>
    const p = u.pathname.match(/\/\d{3,}\/(\d{1,3})\/(\d{1,3})\b/);
    if (p) return { season: +p[1], episode: +p[2] };
  } catch {}
  const t = (title || '').match(/S(\d{1,3})\s*[\s.:_-]?\s*E(\d{1,3})/i);
  if (t) return { season: +t[1], episode: +t[2] };
  return { season: null, episode: null };
}

// Reads the guest's TOP document (readable — only the video iframe was cross-origin).
async function parsePage() {
  try {
    return await webview.executeJavaScript(`(() => {
      const m = (sel) => document.querySelector(sel)?.content || '';
      return {
        title: m('meta[property="og:title"]') || document.title || '',
        poster: m('meta[property="og:image"]') || m('meta[name="twitter:image"]') || '',
        ogType: m('meta[property="og:type"]'),
      };
    })()`);
  } catch { return { title: '', poster: '', ogType: '' }; }
}

function isMediaUrl(url) {
  try {
    const u = new URL(url);
    return /\/\d{3,}/.test(u.pathname) || /\/(tv|movie|movies|watch|series|anime|show)\b/i.test(u.pathname);
  } catch { return false; }
}

function mediaType(url, season) {
  if (season != null) return 'tv';
  try { if (/\/(tv|series|show|anime|episode)\b/i.test(new URL(url).pathname)) return 'tv'; } catch {}
  return 'movie';
}

// full classification incl. Live TV (from the source's category)
const classify = (url, season) => (isLiveUrl(url) ? 'live' : mediaType(url, season));

// type of an item, falling back for entries saved before `type` existed
const typeOf = (item) => item.type || classify(item.url, item.season);

// ---------- capture ----------

let captureTimer = null;
function scheduleCapture() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(captureCurrent, 600);
}

async function captureCurrent() {
  const url = webview.getURL();
  if (!url || !/^https?:/.test(url) || !isMediaUrl(url)) return;
  if (isLiveUrl(url)) return; // Live TV sources never enter Continue Watching
  const page = await parsePage();
  if (!page.title) return;
  const key = mediaKey(url);
  const { season, episode } = parseSeasonEpisode(url, page.title);
  const type = mediaType(url, season);
  activeKey = key;
  const existing = cont.find((c) => c.key === key);
  const base = { key, title: page.title, url, poster: page.poster, season, episode, type, updatedAt: Date.now() };
  if (existing) {
    Object.assign(existing, base, { poster: page.poster || existing.poster });
  } else {
    cont.unshift({ ...base, position: null, duration: null, note: '' });
  }
  cont.sort((a, b) => b.updatedAt - a.updatedAt);
  store('continue', cont);

  // Watch Later tracks the show too: advance its episode/url as you watch
  const wl = later.find((w) => w.key === key);
  if (wl) {
    Object.assign(wl, { season, episode, url, type, poster: page.poster || wl.poster });
    store('watchlater', later);
  }
}

// player position, pushed from main over the preload bridge
window.sh?.onVideoProgress(({ position, duration }) => {
  if (!activeKey) return;
  const item = cont.find((c) => c.key === activeKey);
  if (!item) return;
  item.position = position;
  item.duration = duration;
  item.updatedAt = Date.now();
  store('continue', cont);
  // no live re-render: home is hidden during playback; it refreshes on next open
});

// ---------- views ----------

function hideAll() {
  $('home').hidden = true;
  $('browse').hidden = true;
  $('detail').hidden = true;
  webview.hidden = true;
  playing = null;              // leaving the embed: forget what's playing
  $('src-switch').hidden = true;
}

function open(url) {
  hideAll();
  webview.hidden = false;
  webview.src = url;
}

function showHome() {
  hideAll();
  $('home').hidden = false;
  renderHome();
}

function showBrowse() {
  hideAll();
  $('browse').hidden = false;
  renderBrowse();
}

// ---------- rendering ----------

function sourceItem(src) {
  const li = document.createElement('li');
  const grow = document.createElement('div');
  grow.className = 'grow';
  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = src.name;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = CAT_LABEL[src.category || 'vod'];
  grow.append(t, meta);
  const edit = document.createElement('button');
  edit.textContent = '✎';
  edit.title = 'Edit play-URL pattern'; // tokens: {origin} {type} {id} {season} {episode}
  edit.onclick = (e) => {
    e.stopPropagation();
    const inp = document.createElement('input');
    inp.value = src.template || '';
    inp.placeholder = '{origin}/embed/{type}/{id}/{season}/{episode}';
    inp.title = 'Play-URL pattern — tokens {origin} {type} {id} {season} {episode}; blank = default';
    inp.onclick = (ev) => ev.stopPropagation(); // don't open the source while editing
    const commit = () => {
      if (inp.value.trim()) src.template = inp.value.trim(); else delete src.template;
      store('sources', sources);
      renderSources();
    };
    inp.onkeydown = (ev) => {
      if (ev.key === 'Enter') { inp.onblur = null; commit(); }
      if (ev.key === 'Escape') { inp.onblur = null; renderSources(); }
    };
    inp.onblur = commit;
    li.replaceChildren(inp);
    inp.focus();
  };
  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = 'Remove source';
  del.onclick = (e) => {
    e.stopPropagation();
    sources = sources.filter((s) => s !== src);
    store('sources', sources);
    renderSources();
  };
  li.append(grow, edit, del);
  li.onclick = () => {
    if (src.provider) { browseTab = 'live'; showBrowse(); }      // adapter-backed live source -> Live tab
    else if (src.url) { currentSource = src.url; open(src.url); }
  };
  return li;
}

// One unified list of players/sources (managed under Settings); also refresh the default picker.
function renderSources() {
  const box = $('sources');
  if (!sources.length) {
    box.replaceChildren(emptyMsg('No players yet — add one below.'));
  } else {
    const ul = document.createElement('ul');
    ul.className = 'source-list';
    ul.append(...sources.map(sourceItem));
    box.replaceChildren(ul);
  }
  renderDefaultPicker();
}

// Populate the "Default player" selector with the Movies/TV/Anime players (Live TV excluded).
function renderDefaultPicker() {
  const sel = $('default-source');
  const players = sources.filter((s) => (s.category || 'vod') !== 'live');
  $('default-player-row').hidden = players.length === 0;
  if (!players.length) { sel.replaceChildren(); return; }
  if (!players.some((s) => s.url === defaultSource)) { // keep the stored default valid
    defaultSource = players[0].url;
    store('defaultSource', defaultSource);
  }
  sel.replaceChildren(...players.map((s) => {
    const o = document.createElement('option');
    o.value = s.url; o.textContent = s.name;
    if (s.url === defaultSource) o.selected = true;
    return o;
  }));
}

function seLabel(item) {
  if (item.season != null && item.episode != null) return `S${item.season} E${item.episode}`;
  return '';
}

function card(item, isCont) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.key = item.key;

  const wrap = document.createElement('div');
  wrap.className = 'poster-wrap';
  if (item.poster) {
    const img = document.createElement('img');
    img.className = 'poster';
    img.src = item.poster;
    img.onerror = () => { img.remove(); wrap.classList.add('noposter'); };
    wrap.append(img);
  } else {
    wrap.classList.add('noposter');
  }

  const se = seLabel(item);
  if (se) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = se;
    wrap.append(badge);
  }

  if (isCont && item.duration) {
    const bar = document.createElement('div');
    bar.className = 'progress';
    const fill = document.createElement('div');
    fill.style.width = Math.min(100, (item.position / item.duration) * 100) + '%';
    bar.append(fill);
    wrap.append(bar);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  // change category (fixes wrong auto-classification); Live TV only offered in Watch Later
  const typeSel = document.createElement('select');
  typeSel.className = 'type-select';
  typeSel.title = 'Change category';
  const opts = isCont ? [['movie', 'Movie'], ['tv', 'TV Show']]
                      : [['movie', 'Movie'], ['tv', 'TV Show'], ['live', 'Live TV']];
  for (const [v, l] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    typeSel.append(o);
  }
  typeSel.value = typeOf(item);
  typeSel.onclick = (e) => e.stopPropagation();
  typeSel.onchange = (e) => {
    e.stopPropagation();
    item.type = typeSel.value;
    store(isCont ? 'continue' : 'watchlater', isCont ? cont : later);
    renderHome();
  };
  actions.append(typeSel);

  if (isCont) {
    const editBtn = document.createElement('button');
    editBtn.textContent = '✎';
    editBtn.title = 'Edit note';
    editBtn.onclick = (e) => { e.stopPropagation(); editNote(item, sub); };
    actions.append(editBtn);
  }
  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = 'Remove';
  del.onclick = (e) => {
    e.stopPropagation();
    if (isCont) { cont = cont.filter((c) => c.key !== item.key); store('continue', cont); }
    else { later = later.filter((c) => c.key !== item.key); store('watchlater', later); }
    renderHome();
  };
  actions.append(del);
  wrap.append(actions);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = item.title;

  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = isCont ? (item.note || se || 'Watching') : (se || 'Movie');

  el.append(wrap, title, sub);
  el.onclick = () => { activeKey = item.key; open(item.url); };
  return el;
}

function editNote(item, sub) {
  const input = document.createElement('input');
  input.className = 'note-edit';
  input.value = item.note || '';
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
  input.onblur = () => {
    item.note = input.value.trim();
    store('continue', cont);
    renderHome();
  };
  sub.replaceWith(input);
  input.focus();
}

let topTab = 'continue'; // 'continue' | 'later'
let subTab = 'all';      // 'all' | 'movie' | 'tv'

function tabBar(tabs, current, onPick, cls) {
  const bar = document.createElement('div');
  bar.className = cls;
  for (const [id, label] of tabs) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (id === current ? ' active' : '');
    btn.textContent = label;
    btn.dataset.tab = id;
    btn.onclick = () => onPick(id); // onPick is responsible for re-rendering
    bar.append(btn);
  }
  return bar;
}

function renderHome() {
  const isCont = topTab === 'continue';
  if (isCont && subTab === 'live') subTab = 'all'; // Continue has no Live TV tab
  const list = (isCont ? cont : later).filter((i) => subTab === 'all' || typeOf(i) === subTab);

  const subs = isCont
    ? [['all', 'All'], ['movie', 'Movies'], ['tv', 'TV Shows']]
    : [['all', 'All'], ['movie', 'Movies'], ['tv', 'TV Shows'], ['live', 'Live TV']];

  const nodes = [
    tabBar([['continue', 'Continue Watching'], ['later', 'Watch Later']], topTab,
      (id) => { topTab = id; renderHome(); }, 'tabs'),
    tabBar(subs, subTab, (id) => { subTab = id; renderHome(); }, 'subtabs'),
  ];

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = isCont
      ? 'Play something — it shows up here automatically.'
      : 'Hit “+ Watch Later” on a show or movie to save it here.';
    nodes.push(empty);
  } else {
    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.append(...list.map((item) => card(item, isCont)));
    nodes.push(grid);
  }
  $('home').replaceChildren(...nodes);
}

// ---------- browse (TMDB catalog) ----------

let browseTab = 'movie'; // 'movie' | 'tv' | 'anime' | 'live' | 'youtube'

// Build a source's embed-player URL for a TMDB title. `type` is 'movie' or 'tv' (anime -> tv).
// Default assumes the common /embed/{type}/{id}[/{season}/{episode}] pattern (vidsrc, vidking, …);
// a source can override with a `template` using {origin} {type} {id} {season} {episode} tokens.
function buildUrl(src, type, id, season, episode) {
  let origin = src.url;
  try { origin = new URL(src.url).origin; } catch {}
  let u;
  if (src.template) {
    u = src.template
      .replaceAll('{origin}', origin).replaceAll('{type}', type).replaceAll('{id}', id)
      .replaceAll('{season}', season ?? '').replaceAll('{episode}', episode ?? '');
  } else {
    u = `${origin}/embed/${type}/${id}`;
    if (type === 'tv' && season != null && episode != null) u += `/${season}/${episode}`;
  }
  // Movies leave {season}/{episode} blank -> trailing `//`; trim empty path segments so one
  // template serves movie AND tv (e.g. cinemaos `/player/{id}/{season}/{episode}`).
  return u.replace(/([^:]\/)\/+/g, '$1').replace(/\/+(\?|#|$)/g, '$1');
}

// ponytail: self-check the empty-segment trim; fires on load, no-op if correct.
(function () {
  const cine = { url: 'https://cinemaos.tech', template: 'https://cinemaos.tech/player/{id}/{season}/{episode}' };
  console.assert(buildUrl(cine, 'movie', 42) === 'https://cinemaos.tech/player/42', 'buildUrl movie trim');
  console.assert(buildUrl(cine, 'tv', 42, 1, 3) === 'https://cinemaos.tech/player/42/1/3', 'buildUrl tv fill');
  console.assert(buildUrl({ url: 'https://ex.com' }, 'movie', 42) === 'https://ex.com/embed/movie/42', 'buildUrl default');
})();

// Sources that can play a given browse kind (with a sensible fallback to vod).
function sourcesFor(kind) {
  if (kind === 'live') return sources.filter((s) => s.category === 'live');
  const want = kind === 'anime' ? 'anime' : 'vod';
  const exact = sources.filter((s) => s.category === want);
  return exact.length ? exact : sources.filter((s) => s.category === 'vod' || s.category === 'anime');
}

async function tmdbFetch(path, params) {
  const res = await window.sh.tmdb(path, { api_key: tmdbKey, ...params });
  return res && res.results ? res.results : [];
}

// Full TMDB object (details/season), not the .results list.
async function tmdbGet(path, params) {
  return window.sh.tmdb(path, { api_key: tmdbKey, ...params });
}

// Load a source's embed player for a title/episode and remember it so the topbar can switch source.
function openOn(src, kind, type, id, season, episode) {
  currentSource = src.url;
  lastSourceUrl = src.url;
  store('lastSource', lastSourceUrl);
  open(buildUrl(src, type, id, season, episode)); // open()->hideAll() clears `playing`; re-set after
  playing = { kind, type, id, season, episode };
  renderSourceSwitch();
}

// Populate + show the topbar source switcher for whatever is playing (only if >1 source to switch to).
function renderSourceSwitch() {
  const sel = $('src-switch');
  const srcs = playing ? sourcesFor(playing.kind) : [];
  if (srcs.length < 2) { sel.hidden = true; return; }
  sel.replaceChildren(...srcs.map((s) => {
    const o = document.createElement('option');
    o.value = s.url; o.textContent = s.name;
    if (s.url === lastSourceUrl) o.selected = true;
    return o;
  }));
  sel.hidden = false;
}

// Play a title on the chosen source: the detail-page selector, else last-used, else the first source.
function playOn(kind, type, id, season, episode) {
  const srcs = sourcesFor(kind);
  if (srcs.length === 0) { alert('Add a ' + (kind === 'anime' ? 'Anime' : 'Movies/TV') + ' source first.'); return; }
  const sel = document.querySelector('.detail-source');
  const chosen = (sel && srcs.find((s) => s.url === sel.value)) // match within this kind (URLs can collide across categories)
    || srcs.find((s) => s.url === defaultSource)
    || srcs.find((s) => s.url === lastSourceUrl)
    || srcs[0];
  openOn(chosen, kind, type, id, season, episode);
}

function posterCard(kind, item) {
  const el = document.createElement('div');
  el.className = 'card';
  const wrap = document.createElement('div');
  wrap.className = 'poster-wrap';
  if (item.poster_path) {
    const img = document.createElement('img');
    img.className = 'poster';
    img.src = `https://image.tmdb.org/t/p/w342${item.poster_path}`;
    img.onerror = () => { img.remove(); wrap.classList.add('noposter'); };
    wrap.append(img);
  } else {
    wrap.classList.add('noposter');
  }
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = item.title || item.name || 'Untitled';
  el.append(wrap, title);
  el.onclick = () => showDetail(kind, item.id);
  return el;
}

function browseTabBar() {
  const tabs = [['movie', 'Movies'], ['tv', 'TV'], ['anime', 'Anime'], ['live', 'Live TV'], ['youtube', 'YouTube']];
  return tabBar(tabs, browseTab, (id) => {
    if (id === 'youtube') { open('https://www.youtube.com'); return; }
    browseTab = id;
    browseQuery = '';
    renderBrowse();
  }, 'tabs');
}

async function renderBrowse() {
  if (browseTab === 'live') { renderLiveTab($('browse')); return; }
  const nodes = [browseTabBar()];

  // Movies / TV / Anime need a TMDB key
  if (!tmdbKey) {
    nodes.push(emptyMsg('Add your free TMDB API key in Settings (left) to browse. Get one at themoviedb.org → Settings → API.'));
    $('browse').replaceChildren(...nodes);
    return;
  }

  // search box
  const search = document.createElement('input');
  search.className = 'browse-search';
  search.placeholder = `Search ${browseTab === 'anime' ? 'anime' : browseTab === 'movie' ? 'movies' : 'TV'}...`;
  search.value = browseQuery;
  search.oninput = () => { browseQuery = search.value; debouncedBrowse(); };
  nodes.push(search);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.textContent = 'Loading…';
  nodes.push(grid);
  const tabAtRender = browseTab;
  $('browse').replaceChildren(...nodes);

  const results = await fetchBrowse(browseTab, browseQuery);
  if (browseTab !== tabAtRender) return; // user switched tabs mid-fetch
  grid.textContent = '';
  if (!results.length) { grid.textContent = 'No results (check your TMDB key).'; return; }
  const kind = browseTab;
  grid.append(...results.filter((r) => r.poster_path || r.title || r.name).map((r) => posterCard(kind, r)));
  // keep focus in the search box while typing
  if (browseQuery) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
}

function liveTile(item) {
  const el = document.createElement('div'); el.className = 'tile';
  if (item.logo) { const img = document.createElement('img'); img.className = 'tile-logo'; img.src = item.logo; img.onerror = () => img.remove(); el.append(img); }
  const t = document.createElement('div'); t.textContent = item.title; el.append(t);
  el.onclick = () => item.onOpen();
  return el;
}

// The filter views an adapter offers. Adapters may declare `views: [{key,label,fetch}]`;
// otherwise we synthesise All (+ Live now if it has listLive) from the legacy list()/listLive().
function adapterViews(a) {
  if (a.views && a.views.length) return a.views;
  const v = [{ key: 'all', label: 'All', fetch: () => a.list() }];
  if (a.listLive) v.push({ key: 'live', label: 'Live now', fetch: () => a.listLive() });
  return v;
}

// Live TV tab: provider-backed catalogs (adapter-declared view filter + one search box, filtered
// client-side) plus plain site tiles for bring-your-own live sources. Search doesn't refetch; view does.
function renderLiveTab(container) {
  const live = sources.filter((s) => s.category === 'live');
  const provSrcs = live.filter((s) => s.provider && liveAdapters[s.provider]);
  const siteSrcs = live.filter((s) => !s.provider && s.url);
  const nodes = [browseTabBar()];

  if (!live.length) {
    nodes.push(emptyMsg('Add a Live TV source in Settings → + Add player / source.'));
    container.replaceChildren(...nodes);
    return;
  }

  // union of views across provider adapters (dedup by key, first label/order wins)
  const viewOrder = []; const seen = new Set();
  for (const s of provSrcs) for (const v of adapterViews(liveAdapters[s.provider])) if (!seen.has(v.key)) { seen.add(v.key); viewOrder.push([v.key, v.label]); }
  if (viewOrder.length && !seen.has(liveMode)) liveMode = viewOrder[0][0];

  const refilters = [];
  let searchInput;
  if (provSrcs.length) {
    const controls = document.createElement('div'); controls.className = 'live-controls';
    if (viewOrder.length > 1) controls.append(tabBar(viewOrder, liveMode, (m) => { liveMode = m; renderLiveTab(container); }, 'subtabs'));
    searchInput = document.createElement('input');
    searchInput.className = 'browse-search'; searchInput.placeholder = 'Search live…'; searchInput.value = liveQuery;
    searchInput.oninput = () => { liveQuery = searchInput.value; refilters.forEach((f) => f()); };
    controls.append(searchInput);
    nodes.push(controls);
  }

  for (const s of provSrcs) {
    const adapter = liveAdapters[s.provider];
    const views = adapterViews(adapter);
    const view = views.find((v) => v.key === liveMode) || views[0];
    const sec = document.createElement('div'); sec.className = 'live-provider';
    if (provSrcs.length > 1) { const h = document.createElement('h3'); h.className = 'live-provider-name'; h.textContent = s.name || adapter.name; sec.append(h); }
    const grid = document.createElement('div'); grid.className = 'grid tiles'; grid.textContent = 'Loading…';
    sec.append(grid); nodes.push(sec);
    let all = [];
    const refilter = () => {
      const q = liveQuery.trim().toLowerCase();
      const items = q ? all.filter((it) => (it.title || '').toLowerCase().includes(q)) : all;
      if (!items.length) { grid.textContent = all.length ? `No matches for “${liveQuery}”.` : 'Nothing here right now.'; return; }
      grid.replaceChildren(...items.slice(0, 300).map(liveTile));
    };
    refilters.push(refilter);
    Promise.resolve(view.fetch()).then((items) => { all = items || []; refilter(); }).catch((e) => { grid.textContent = 'Failed to load (' + (e && e.message || e) + ').'; });
  }

  if (siteSrcs.length) {
    const grid = document.createElement('div'); grid.className = 'grid tiles';
    grid.append(...siteSrcs.map((s) => {
      const el = document.createElement('div'); el.className = 'tile'; el.textContent = s.name;
      el.onclick = () => { currentSource = s.url; open(s.url); };
      return el;
    }));
    nodes.push(grid);
  }

  container.replaceChildren(...nodes);
  if (liveQuery && searchInput) { searchInput.focus(); searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); }
}

let browseQuery = '';
let browseTimer = null;
const debouncedBrowse = () => { clearTimeout(browseTimer); browseTimer = setTimeout(renderBrowse, 350); };

function emptyMsg(text) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  return d;
}

async function fetchBrowse(tab, query) {
  if (query) {
    const mediaType = tab === 'movie' ? 'movie' : 'tv';
    return tmdbFetch(`/search/${mediaType}`, { query });
  }
  if (tab === 'movie') return tmdbFetch('/trending/movie/week', {});
  if (tab === 'tv') return tmdbFetch('/trending/tv/week', {});
  // anime: Japanese-origin animation
  return tmdbFetch('/discover/tv', {
    with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc',
  });
}

// ---------- native detail page (TMDB metadata; Watch loads the source embed player) ----------

const IMG = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : '');

function detailBackTo() { showBrowse(); }

async function showDetail(kind, id) {
  hideAll();
  $('detail').hidden = false;
  $('detail').replaceChildren(emptyMsg('Loading…'));
  const type = kind === 'movie' ? 'movie' : 'tv';
  let d;
  try {
    d = await tmdbGet(`/${type}/${id}`, { append_to_response: 'credits,videos,external_ids,watch/providers' });
  } catch { d = null; }
  if (!d || d.error || (!d.title && !d.name)) {
    $('detail').replaceChildren(detailHeaderBar(), emptyMsg('Could not load details (check your TMDB key).'));
    return;
  }
  renderDetail(kind, type, id, d);
}

function detailHeaderBar() {
  const bar = document.createElement('div');
  bar.className = 'detail-back';
  const back = document.createElement('button');
  back.textContent = '← Browse';
  back.onclick = detailBackTo;
  bar.append(back);
  return bar;
}

function renderDetail(kind, type, id, d) {
  const el = $('detail');
  const title = d.title || d.name;
  const year = (d.release_date || d.first_air_date || '').slice(0, 4);
  const rating = d.vote_average ? d.vote_average.toFixed(1) : null;
  const genres = (d.genres || []).map((g) => g.name);
  const trailer = (d.videos?.results || []).find((v) => v.site === 'YouTube' && /Trailer|Teaser/i.test(v.type))
    || (d.videos?.results || []).find((v) => v.site === 'YouTube');

  // hero
  const hero = document.createElement('div');
  hero.className = 'detail-hero';
  if (d.backdrop_path) hero.style.backgroundImage = `linear-gradient(to right, rgba(20,22,26,.96), rgba(20,22,26,.55)), url(${IMG(d.backdrop_path, 'w1280')})`;

  const poster = document.createElement('img');
  poster.className = 'detail-poster';
  poster.src = IMG(d.poster_path, 'w342');
  poster.onerror = () => poster.remove();

  const info = document.createElement('div');
  info.className = 'detail-info';
  const h = document.createElement('h1');
  h.textContent = title;
  info.append(h);
  if (d.tagline) { const t = document.createElement('div'); t.className = 'detail-tagline'; t.textContent = `“${d.tagline}”`; info.append(t); }

  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const bits = [];
  if (year) bits.push(year);
  if (type === 'tv') { if (d.number_of_seasons) bits.push(`${d.number_of_seasons} Season${d.number_of_seasons > 1 ? 's' : ''}`); if (d.number_of_episodes) bits.push(`${d.number_of_episodes} Episodes`); }
  else if (d.runtime) bits.push(`${d.runtime}m`);
  if (rating) bits.push(`★ ${rating}`);
  meta.textContent = bits.join('  ·  ');
  info.append(meta);
  if (genres.length) { const g = document.createElement('div'); g.className = 'detail-genres'; g.append(...genres.map((n) => { const s = document.createElement('span'); s.textContent = n; return s; })); info.append(g); }

  // TV: season + episode selectors bound to the Watch button
  let curSeason = type === 'tv' ? ((d.seasons || []).find((s) => s.season_number > 0)?.season_number ?? 1) : null;
  let curEpisode = type === 'tv' ? 1 : null;

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const playSrcs = sourcesFor(kind);
  if (playSrcs.length > 1) {
    const srcSel = document.createElement('select');
    srcSel.className = 'detail-source';
    srcSel.title = 'Source';
    srcSel.append(...playSrcs.map((s) => {
      const o = document.createElement('option');
      o.value = s.url; o.textContent = s.name;
      if (s.url === (defaultSource || lastSourceUrl)) o.selected = true;
      return o;
    }));
    actions.append(srcSel);
  }
  const watchBtn = document.createElement('button');
  watchBtn.className = 'btn-primary';
  const setWatchLabel = () => { watchBtn.textContent = type === 'tv' ? `▶ Watch S${curSeason}E${curEpisode}` : '▶ Watch'; };
  setWatchLabel();
  watchBtn.onclick = () => playOn(kind, type, id, curSeason, curEpisode);
  actions.append(watchBtn);
  if (trailer) {
    const tb = document.createElement('button');
    tb.textContent = '🎬 Trailer';
    tb.onclick = () => open(`https://www.youtube.com/embed/${trailer.key}?autoplay=1`);
    actions.append(tb);
  }
  const wl = document.createElement('button');
  wl.textContent = '+ Watch Later';
  wl.onclick = () => {
    const src = sourcesFor(kind)[0];
    const url = src ? buildUrl(src, type, id, curSeason, curEpisode) : `tmdb:${type}/${id}`;
    const key = mediaKey(url);
    later = later.filter((c) => c.key !== key);
    later.unshift({ key, title, url, poster: IMG(d.poster_path, 'w342'), season: curSeason, episode: curEpisode, type: kind === 'anime' ? 'tv' : type, addedAt: Date.now() });
    store('watchlater', later);
    wl.textContent = '✓ Added';
    setTimeout(() => { wl.textContent = '+ Watch Later'; }, 1500);
  };
  actions.append(wl);
  info.append(actions);

  hero.append(poster, info);
  el.replaceChildren(detailHeaderBar(), hero);

  // overview
  if (d.overview) {
    const ov = document.createElement('div');
    ov.className = 'detail-section';
    ov.innerHTML = '<h2>Overview</h2>';
    const p = document.createElement('p');
    p.textContent = d.overview;
    ov.append(p);
    el.append(ov);
  }

  // TV episodes
  if (type === 'tv') {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const head = document.createElement('div');
    head.className = 'episodes-head';
    const hh = document.createElement('h2'); hh.textContent = 'Episodes';
    const sel = document.createElement('select');
    sel.className = 'season-select';
    for (const s of (d.seasons || []).filter((s) => s.season_number > 0)) {
      const o = document.createElement('option'); o.value = s.season_number; o.textContent = s.name || `Season ${s.season_number}`; sel.append(o);
    }
    sel.value = curSeason;
    head.append(hh, sel);
    sec.append(head);
    const epGrid = document.createElement('div');
    epGrid.className = 'episodes';
    sec.append(epGrid);
    el.append(sec);

    const loadSeason = async (n) => {
      curSeason = +n;
      epGrid.replaceChildren(emptyMsg('Loading…'));
      let s;
      try { s = await tmdbGet(`/tv/${id}/season/${n}`, {}); } catch { s = null; }
      epGrid.replaceChildren(...(s?.episodes || []).map((ep) => episodeCard(kind, type, id, ep, () => { curEpisode = ep.episode_number; setWatchLabel(); })));
    };
    sel.onchange = () => loadSeason(sel.value);
    loadSeason(curSeason);
  }

  // cast
  const cast = (d.credits?.cast || []).slice(0, 12);
  if (cast.length) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    sec.innerHTML = '<h2>Cast</h2>';
    const row = document.createElement('div');
    row.className = 'cast-row';
    row.append(...cast.map((c) => {
      const card = document.createElement('div'); card.className = 'cast';
      const img = document.createElement('img'); img.src = IMG(c.profile_path, 'w185'); img.onerror = () => img.classList.add('noimg');
      const nm = document.createElement('div'); nm.className = 'cast-name'; nm.textContent = c.name;
      const ch = document.createElement('div'); ch.className = 'cast-char'; ch.textContent = c.character || '';
      card.append(img, nm, ch);
      return card;
    }));
    sec.append(row);
    el.append(sec);
  }

  // where to watch (legal providers)
  const provs = (d['watch/providers']?.results?.US || d['watch/providers']?.results?.GB || {});
  const flat = [...(provs.flatrate || []), ...(provs.free || []), ...(provs.ads || [])];
  if (flat.length) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    sec.innerHTML = '<h2>Where to Watch</h2>';
    const row = document.createElement('div');
    row.className = 'providers';
    row.append(...flat.slice(0, 12).map((pv) => { const img = document.createElement('img'); img.src = IMG(pv.logo_path, 'w92'); img.title = pv.provider_name; return img; }));
    sec.append(row);
    el.append(sec);
  }
}

function episodeCard(kind, type, id, ep, onPick) {
  const el = document.createElement('div');
  el.className = 'episode';
  const still = document.createElement('img');
  still.src = IMG(ep.still_path, 'w300');
  still.onerror = () => still.classList.add('noimg');
  const body = document.createElement('div');
  body.className = 'episode-body';
  const t = document.createElement('div'); t.className = 'episode-title';
  t.textContent = `E${ep.episode_number} · ${ep.name || 'Episode ' + ep.episode_number}`;
  const ov = document.createElement('div'); ov.className = 'episode-ov'; ov.textContent = ep.overview || '';
  body.append(t, ov);
  el.append(still, body);
  el.onclick = () => { onPick(); playOn(kind, type, id, ep.season_number, ep.episode_number); };
  return el;
}

// ---------- actions ----------

$('watch-later').onclick = async () => {
  if (webview.hidden) return;
  const url = webview.getURL();
  const page = await parsePage();
  const key = mediaKey(url);
  const { season, episode } = parseSeasonEpisode(url, page.title);
  later = later.filter((c) => c.key !== key); // dedupe
  later.unshift({ key, title: page.title || url, url, poster: page.poster, season, episode, type: classify(url, season), addedAt: Date.now() });
  store('watchlater', later);
  const btn = $('watch-later');
  btn.textContent = '✓ Added';
  setTimeout(() => { btn.textContent = '+ Watch Later'; }, 1500);
};

// Add a player/source (shared by the wizard + tests). Auto-prefixes the URL scheme.
// A Live TV source may instead reference a registered adapter (provider) and carry no URL.
function addSource({ name, url, category, template, provider }) {
  category = category || 'vod';
  const src = { name: (name || '').trim(), category };
  if (provider && category === 'live') src.provider = provider;
  if (url && url.trim()) {
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    src.url = url;
  }
  if (template && template.trim()) src.template = template.trim();
  sources.push(src);
  store('sources', sources);
  renderSources();
  return src;
}

// Step-by-step "Add player / source" modal wizard, with a per-field hover example + live preview.
function openAddWizard() {
  const data = { name: '', category: 'vod', url: '', template: '' };
  let i = 0;
  const wiz = $('wizard');
  const close = () => { wiz.hidden = true; wiz.replaceChildren(); };

  const urlStep = {
    key: 'url', title: 'Paste the address', label: 'The player or site web address', placeholder: 'https://example-player.com',
    example: 'The site that hosts the embed player. Example: https://example-player.com',
    valid: () => /\./.test(data.url.trim()) };
  const steps = () => {
    const s = [
      { key: 'name', title: 'Name it', label: 'What do you want to call this?', placeholder: 'e.g. My Player',
        example: 'A short label shown in your list and the source picker. Example: “My Player”.',
        valid: () => data.name.trim().length > 0 },
      { key: 'category', title: 'Pick a type', label: 'What kind of source is this?',
        example: 'Movies/TV & Anime play through an embed pattern. Live TV is a website or a built-in catalog.',
        choices: [['vod', 'Movies / TV Shows'], ['anime', 'Anime'], ['live', 'Live TV']] },
    ];
    if (data.category === 'live') {
      const keys = Object.keys(liveAdapters);
      if (keys.length) s.push({
        key: 'provider', title: 'Live source', label: 'Where do the channels come from?',
        example: 'Pick a built-in catalog (searchable, with an All / Live-now view), or “A website” to just open a site.',
        choices: [['', 'A website (opens the site)'], ...keys.map((k) => [k, liveAdapters[k].name])] });
      if (!data.provider) s.push(urlStep); // website path still needs a URL
    } else {
      s.push(urlStep, {
        key: 'template', title: 'Watch-link pattern', label: 'How does it build a watch link? (optional)',
        placeholder: '{origin}/embed/{type}/{id}/{season}/{episode}', preview: true,
        example: 'Leave blank for the common /embed/ format. Tokens: {origin}=site · {type}=movie/tv · {id}=TMDB id · {season}/{episode} for TV (blank on movies).' });
    }
    return s;
  };

  const render = () => {
    const S = steps();
    if (i >= S.length) i = S.length - 1;
    const step = S[i], total = S.length, isLast = i === total - 1;

    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const card = document.createElement('div'); card.className = 'wiz-card';

    const head = document.createElement('div'); head.className = 'wiz-head';
    const dots = document.createElement('div'); dots.className = 'wiz-dots';
    for (let d = 0; d < total; d++) { const dot = document.createElement('span'); if (d === i) dot.className = 'on'; dots.append(dot); }
    const count = document.createElement('span'); count.className = 'wiz-count'; count.textContent = `Step ${i + 1} of ${total}`;
    const x = document.createElement('button'); x.className = 'wiz-x'; x.textContent = '✕'; x.onclick = close;
    head.append(dots, count, x);
    const h = document.createElement('h3'); h.textContent = step.title;
    const label = document.createElement('div'); label.className = 'wiz-label'; label.textContent = step.label;
    card.append(head, h, label);

    // nav buttons created early so field handlers can toggle Next
    const nav = document.createElement('div'); nav.className = 'wiz-nav';
    const back = document.createElement('button'); back.className = 'wiz-back'; back.textContent = i === 0 ? 'Cancel' : 'Back';
    back.onclick = () => { if (i === 0) close(); else { i--; render(); } };
    const next = document.createElement('button'); next.className = 'wiz-next'; next.textContent = isLast ? 'Add' : 'Next';
    const isValid = () => (step.valid ? step.valid() : true);
    next.disabled = !isValid();
    next.onclick = () => { if (!isValid()) return; if (isLast) { addSource(data); close(); } else { i++; render(); } };
    nav.append(back, next);

    const field = document.createElement('div'); field.className = 'wiz-field';
    let prev;
    function updatePreview() {
      if (!prev) return;
      const src = { url: data.url.trim() || 'https://example-player.com', template: data.template.trim() || undefined };
      prev.textContent = `Preview ▸ Movie: ${buildUrl(src, 'movie', 27205)}  ·  TV S1E1: ${buildUrl(src, 'tv', 27205, 1, 1)}`;
    }
    if (step.choices) {
      const row = document.createElement('div'); row.className = 'wiz-choices';
      for (const [val, txt] of step.choices) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = txt;
        b.className = data[step.key] === val ? 'on' : '';
        b.onclick = () => { data[step.key] = val; render(); };
        row.append(b);
      }
      field.append(row);
    } else {
      const inp = document.createElement('input'); inp.className = 'wiz-input';
      inp.placeholder = step.placeholder || ''; inp.value = data[step.key] || '';
      inp.oninput = () => { data[step.key] = inp.value; next.disabled = !isValid(); updatePreview(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter' && !next.disabled) next.click(); };
      field.append(inp);
      setTimeout(() => inp.focus(), 0);
    }
    const ex = document.createElement('div'); ex.className = 'wiz-example'; ex.textContent = step.example;
    field.append(ex);
    if (step.preview) { prev = document.createElement('div'); prev.className = 'wiz-preview'; field.append(prev); updatePreview(); }

    card.append(field, nav);
    overlay.append(card);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    wiz.replaceChildren(overlay);
    wiz.hidden = false;
  };
  render();
}

$('add-source-btn').onclick = openAddWizard;

const tmdbKeyInput = $('tmdb-key');
tmdbKeyInput.value = tmdbKey;
tmdbKeyInput.onchange = () => { tmdbKey = tmdbKeyInput.value.trim(); store('tmdbKey', tmdbKey); if (!$('browse').hidden) renderBrowse(); };

$('browse-btn').onclick = showBrowse;
$('home-btn').onclick = showHome;
$('back').onclick = () => webview.goBack();
$('forward').onclick = () => webview.goForward();
$('src-home').onclick = () => currentSource && open(currentSource);
$('src-switch').onchange = () => {
  if (!playing) return;
  const src = sourcesFor(playing.kind).find((s) => s.url === $('src-switch').value);
  if (src) openOn(src, playing.kind, playing.type, playing.id, playing.season, playing.episode);
};
$('default-source').onchange = () => { defaultSource = $('default-source').value; store('defaultSource', defaultSource); };

webview.addEventListener('did-navigate', () => { $('address').textContent = webview.getURL(); scheduleCapture(); });
webview.addEventListener('did-navigate-in-page', () => { $('address').textContent = webview.getURL(); scheduleCapture(); });
webview.addEventListener('did-stop-loading', scheduleCapture);
webview.addEventListener('enter-html-full-screen', () => webview.classList.add('fullscreen'));
webview.addEventListener('leave-html-full-screen', () => webview.classList.remove('fullscreen'));

renderSources();
showBrowse(); // Browse is the landing page

// Optionally load local-only live-TV providers (gitignored; absent on a fresh clone -> silent no-op).
// Skipped under e2e so the committed suite stays deterministic (registers its own stub adapter).
if (!(window.sh && window.sh.testMode)) import('./live-providers.local.js').catch(() => {});
