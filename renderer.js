const $ = (id) => document.getElementById(id);
const webview = $('webview');

const load = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
const store = (key, val) => localStorage.setItem(key, JSON.stringify(val));

// category: 'vod' = Movies/TV Shows, 'live' = Live TV (not tracked in Continue Watching)
// Sources are user-supplied — add your own with the "+ Add source" form.
let sources = load('sources', []);
let cont = load('continue', []);     // auto-tracked, keyed, sorted by updatedAt desc
let later = load('watchlater', []);  // button-added, deduped by key
let currentSource = null;            // home URL for the topbar home button
let activeKey = null;                // continue entry the player position attaches to

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

function open(url) {
  $('home').hidden = true;
  webview.hidden = false;
  webview.src = url;
}

function showHome() {
  webview.hidden = true;
  $('home').hidden = false;
  renderHome();
}

// ---------- rendering ----------

function sourceItem(src) {
  const li = document.createElement('li');
  const grow = document.createElement('div');
  grow.className = 'grow';
  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = src.name;
  grow.append(t);
  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = 'Remove source';
  del.onclick = (e) => {
    e.stopPropagation();
    sources = sources.filter((s) => s !== src);
    store('sources', sources);
    renderSources();
  };
  li.append(grow, del);
  li.onclick = () => { currentSource = src.url; open(src.url); };
  return li;
}

function sourceGroup(label, cat) {
  const list = sources.filter((s) => (s.category || 'vod') === cat);
  if (!list.length) return [];
  const h = document.createElement('h2');
  h.textContent = label;
  const ul = document.createElement('ul');
  ul.className = 'source-list';
  ul.append(...list.map(sourceItem));
  return [h, ul];
}

function renderSources() {
  $('sources').replaceChildren(
    ...sourceGroup('Movies & TV', 'vod'),
    ...sourceGroup('Live TV', 'live'),
  );
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
    btn.onclick = () => { onPick(id); renderHome(); };
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
      (id) => { topTab = id; }, 'tabs'),
    tabBar(subs, subTab, (id) => { subTab = id; }, 'subtabs'),
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

$('add-source').onsubmit = (e) => {
  e.preventDefault();
  let url = $('src-url').value.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  sources.push({ name: $('src-name').value.trim(), url, category: $('src-cat').value });
  store('sources', sources);
  renderSources();
  e.target.reset();
};

$('home-btn').onclick = showHome;
$('back').onclick = () => webview.goBack();
$('forward').onclick = () => webview.goForward();
$('src-home').onclick = () => currentSource && open(currentSource);

webview.addEventListener('did-navigate', () => { $('address').textContent = webview.getURL(); scheduleCapture(); });
webview.addEventListener('did-navigate-in-page', () => { $('address').textContent = webview.getURL(); scheduleCapture(); });
webview.addEventListener('did-stop-loading', scheduleCapture);
webview.addEventListener('enter-html-full-screen', () => webview.classList.add('fullscreen'));
webview.addEventListener('leave-html-full-screen', () => webview.classList.remove('fullscreen'));

renderSources();
renderHome();
