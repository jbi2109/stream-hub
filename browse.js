// Browse: TMDB catalog (Movies/TV/Anime) + the Live TV tab (catalog JSON APIs + plain sites).

let browseTab = 'movie'; // 'movie' | 'tv' | 'anime' | 'live' | 'youtube'
let browseQuery = '';
let browseTimer = null;
const debouncedBrowse = () => { clearTimeout(browseTimer); browseTimer = setTimeout(renderBrowse, 350); };

async function tmdbFetch(path, params) {
  const res = await window.sh.tmdb(path, { api_key: tmdbKey, ...params });
  return res && res.results ? res.results : [];
}

// Full TMDB object (details/season), not the .results list.
async function tmdbGet(path, params) {
  return window.sh.tmdb(path, { api_key: tmdbKey, ...params });
}

// Cached title+poster for a TMDB id (or null). Used to title Continue/Watch-Later entries from the
// id in the embed URL instead of the provider's own og:title — correct + provider-agnostic. Caching
// bounds the API calls (capture fires repeatedly; the library heal touches every entry).
const tmdbMetaCache = new Map(); // `${type}:${id}` -> { title, poster } | null
async function tmdbMeta(id, type) {
  if (!id || !tmdbKey) return null;
  const t = type === 'movie' ? 'movie' : 'tv';
  const ck = t + ':' + id;
  if (tmdbMetaCache.has(ck)) return tmdbMetaCache.get(ck);
  let meta = null;
  try {
    const d = await tmdbGet(`/${t}/${id}`, {});
    const name = d && (d.title || d.name);
    if (name) meta = { title: name, poster: IMG(d.poster_path, 'w342') };
  } catch {}
  tmdbMetaCache.set(ck, meta);
  return meta;
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

async function fetchBrowse(tab, query) {
  if (query) {
    const mt = tab === 'movie' ? 'movie' : 'tv';
    return tmdbFetch(`/search/${mt}`, { query });
  }
  if (tab === 'movie') return tmdbFetch('/trending/movie/week', {});
  if (tab === 'tv') return tmdbFetch('/trending/tv/week', {});
  // anime: Japanese-origin animation
  return tmdbFetch('/discover/tv', {
    with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc',
  });
}

// Fetch a live-catalog JSON API (via the main-process httpGet, past CSP) and flatten it to tiles.
// Fully generic (no provider code): recurses through nested objects (e.g. grouped-by-sport catalogs),
// expands a per-item channels[]/streams[]/sources[] array into one tile each, and uses broad field
// fallbacks — so flat `{streams:[{embed_url}]}`, nested `{prov:{Soccer:[{…channels:[{url}]}]}}`, and
// anything carrying an embed URL all work with just a pasted URL.
const CATALOG_EMBED_FIELDS = ['embed_url', 'embedUrl', 'url', 'stream_url', 'iframe', 'src'];
// Per-item sub-stream arrays to expand into one tile each. NOT 'streams' — that's a common top-level
// wrapper (`{streams:[…]}`) whose items carry their own category, so it's recursed, not expanded.
const CATALOG_CHANNEL_ARRAYS = ['channels', 'sources', 'servers'];
const CATALOG_WRAPPER_KEYS = new Set(['streams', 'data', 'results', 'items', 'events', 'matches',
  'channels', 'sources', 'servers', 'list', 'response', 'payload']);
const catalogEmbed = (o) => { for (const k of CATALOG_EMBED_FIELDS) if (typeof o[k] === 'string' && o[k]) return o[k]; return null; };
const catalogLogo = (o) => o.thumbnail_url || o.thumbnail || o.poster || o.logo || o.image || o.homeTeamIMG || o.countryIMG || '';
const catalogTitle = (o) => o.name || o.title || o.event
  || (o.homeTeam && o.awayTeam ? `${o.homeTeam} v ${o.awayTeam}` : '') || o.channel_name || o.stream_key || '';

// Best-effort language from a source label/title (fuzzy — catalogs rarely give a clean field). Used only
// to sort the source picker; the user chose "prefer but show all", so a mis-detect only mis-orders.
const LANG_WORDS = { english: 'English', spanish: 'Spanish', french: 'French', german: 'German',
  italian: 'Italian', portuguese: 'Portuguese', dutch: 'Dutch', arabic: 'Arabic', russian: 'Russian',
  turkish: 'Turkish', polish: 'Polish', greek: 'Greek', hindi: 'Hindi', japanese: 'Japanese' };
const LANG_CODES = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', ar: 'Arabic', ru: 'Russian', tr: 'Turkish', pl: 'Polish', gr: 'Greek' };
function parseLanguage(str) {
  const s = String(str || '').toLowerCase();
  for (const [w, name] of Object.entries(LANG_WORDS)) if (s.includes(w)) return name;
  for (const c of (s.match(/\b[a-z]{2}\b/g) || [])) if (LANG_CODES[c]) return LANG_CODES[c];
  return '';
}

async function fetchCatalog(url) {
  const r = await window.sh.httpGet(url);
  if (!r || r.error) throw new Error(r && r.error || 'request failed');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = JSON.parse(r.body);
  const out = [];
  const CAP = 500;
  const walk = (node, cat, parentTitle) => {
    if (out.length >= CAP || node == null) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, cat, parentTitle); return; }
    if (typeof node !== 'object') return;
    const t = catalogTitle(node) || parentTitle;
    const nodeCat = String(node.category || node.sport || node.group || cat || node.tournament || '').toLowerCase();
    // per-item channels/streams/sources array -> one row per entry (grouped back into the match later)
    for (const key of CATALOG_CHANNEL_ARRAYS) {
      if (Array.isArray(node[key])) {
        for (const ch of node[key]) {
          if (out.length >= CAP) return;
          const embed = ch && typeof ch === 'object' && catalogEmbed(ch);
          if (embed) out.push({ matchTitle: t || 'Stream', label: catalogTitle(ch) || '', embed,
            category: String(ch.category || ch.sport || nodeCat || '').toLowerCase(),
            logo: catalogLogo(ch) || catalogLogo(node), language: ch.language || ch.lang || parseLanguage(catalogTitle(ch) || t) });
        }
      }
    }
    // a direct embed on this node
    const embed = catalogEmbed(node);
    if (embed) out.push({ matchTitle: t || 'Stream', label: String(node.server || node.quality || node.channel_name || ''),
      embed, category: nodeCat, logo: catalogLogo(node), language: node.language || node.lang || parseLanguage(t) });
    // recurse into nested objects/arrays, carrying a category down from a non-wrapper string key ("Soccer")
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && !CATALOG_EMBED_FIELDS.includes(k) && !CATALOG_CHANNEL_ARRAYS.includes(k)) {
        const childCat = (isNaN(k) && !CATALOG_WRAPPER_KEYS.has(k.toLowerCase())) ? k.toLowerCase() : (nodeCat || cat);
        walk(v, childCat, t);
      }
    }
  };
  walk(data, '', '');
  return out;
}

// Collapse per-source rows into one entry per match (by normalised title) with a sources[] list, so a
// match with many channels/servers shows as a single tile instead of a wall of duplicates.
function groupMatches(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = (r.matchTitle || '').toLowerCase().replace(/\s+/g, ' ').trim() || r.embed;
    let g = byKey.get(key);
    if (!g) { g = { title: r.matchTitle || 'Stream', category: r.category || '', logo: r.logo || '', sources: [] }; byKey.set(key, g); }
    if (!g.logo && r.logo) g.logo = r.logo;
    if (!g.category && r.category) g.category = r.category;
    if (!g.sources.some((s) => s.embed === r.embed)) g.sources.push({ label: r.label || '', embed: r.embed, language: r.language || '' });
  }
  return [...byKey.values()];
}

// Source-picker modal: lists every source for a match (label + language chip). The chosen default live
// language sorts to the top ("prefer but show all"). Reuses the #wizard modal host + .modal-overlay styles.
function openLiveSources(match) {
  const host = $('wizard');
  const close = () => { host.hidden = true; host.replaceChildren(); };
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const card = document.createElement('div'); card.className = 'wiz-card src-pick';
  const head = document.createElement('div'); head.className = 'wiz-head';
  const h = document.createElement('h3'); h.textContent = match.title; h.style.flex = '1';
  const x = document.createElement('button'); x.type = 'button'; x.className = 'wiz-x'; x.textContent = '✕'; x.onclick = close;
  head.append(h, x);
  const pref = (settings.liveLanguage || '').toLowerCase();
  const rank = (s) => { const l = (s.language || '').toLowerCase(); return pref && l === pref ? 0 : (l ? 2 : 1); };
  const list = document.createElement('div'); list.className = 'src-list';
  list.append(...match.sources
    .map((s, idx) => ({ ...s, label: s.label || ('Source ' + (idx + 1)) }))
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => {
      const row = document.createElement('div'); row.className = 'src-row';
      const name = document.createElement('span'); name.className = 'src-name'; name.textContent = s.label;
      row.append(name);
      if (s.language) { const chip = document.createElement('span'); chip.className = 'src-lang'; chip.textContent = s.language; row.append(chip); }
      row.onclick = () => { open(s.embed); intendedMedia = { title: match.title, poster: match.logo, live: true }; close(); };
      return row;
    }));
  card.append(head, list);
  overlay.append(card);
  host.replaceChildren(overlay);
  host.hidden = false;
}

// Live TV tab: catalog sources (fetch JSON -> tiles + category filter + search) + plain site tiles.
// Search filters client-side (no refetch); the category filter is built from the fetched data.
function renderLiveTab(container) {
  const live = sources.filter((s) => s.category === 'live');
  const catalogSrcs = live.filter((s) => s.catalogUrl);
  const siteSrcs = live.filter((s) => !s.catalogUrl && s.url);
  const nodes = [browseTabBar()];

  if (!live.length) {
    nodes.push(emptyMsg('Add a Live TV source in Settings → + Add player / source.'));
    container.replaceChildren(...nodes);
    return;
  }

  for (const s of catalogSrcs) nodes.push(liveCatalogSection(s));

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
}

// One catalog source: a titled section with a category filter + search box + tile grid.
function liveCatalogSection(src) {
  const sec = document.createElement('div'); sec.className = 'live-provider';
  const h = document.createElement('h3'); h.className = 'live-provider-name'; h.textContent = src.name;
  const controls = document.createElement('div'); controls.className = 'live-controls';
  const catBar = document.createElement('div'); catBar.className = 'subtabs';
  const search = document.createElement('input');
  search.className = 'browse-search'; search.placeholder = 'Search live…';
  controls.append(catBar, search);
  const grid = document.createElement('div'); grid.className = 'grid tiles'; grid.textContent = 'Loading…';
  sec.append(h, controls, grid);

  let all = [], cat = 'all'; // all = grouped matches ({ title, category, logo, sources: [...] })
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    let items = cat === 'all' ? all : all.filter((it) => it.category === cat);
    if (q) items = items.filter((it) => (it.title || '').toLowerCase().includes(q));
    if (!items.length) { grid.textContent = all.length ? 'No matches.' : 'Nothing live right now.'; return; }
    grid.replaceChildren(...items.slice(0, 300).map((m) => {
      const el = document.createElement('div'); el.className = 'tile';
      if (m.logo) { const img = document.createElement('img'); img.className = 'tile-logo'; img.src = m.logo; img.onerror = () => img.remove(); el.append(img); }
      const t = document.createElement('div'); t.textContent = m.title; el.append(t);
      if (m.sources.length > 1) { const badge = document.createElement('div'); badge.className = 'tile-count'; badge.textContent = m.sources.length + ' sources'; el.append(badge); }
      el.onclick = () => {
        if (m.sources.length === 1) { open(m.sources[0].embed); intendedMedia = { title: m.title, poster: m.logo, live: true }; }
        else openLiveSources(m);
      };
      return el;
    }));
  };
  search.oninput = draw;

  fetchCatalog(src.catalogUrl).then((rows) => {
    all = groupMatches(rows);
    const cats = ['all', ...[...new Set(all.map((it) => it.category).filter(Boolean))].sort()];
    if (cats.length > 2) {
      catBar.append(...cats.map((c) => {
        const b = document.createElement('button');
        b.className = 'tab' + (c === cat ? ' active' : '');
        b.textContent = c === 'all' ? 'All' : c[0].toUpperCase() + c.slice(1);
        b.onclick = () => { cat = c; [...catBar.children].forEach((x) => x.classList.toggle('active', x === b)); draw(); };
        return b;
      }));
    }
    draw();
  }).catch((e) => { grid.textContent = 'Failed to load (' + (e && e.message || e) + ').'; });

  return sec;
}
