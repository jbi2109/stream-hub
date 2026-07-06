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

// Fetch a live-catalog JSON API (via the main-process httpGet, past CSP) and map it to tiles.
// Generic field fallbacks so a plain URL works for common live-catalog shapes with no provider code.
async function fetchCatalog(url) {
  const r = await window.sh.httpGet(url);
  if (!r || r.error) throw new Error(r && r.error || 'request failed');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = JSON.parse(r.body);
  let arr = Array.isArray(data) ? data
    : data.streams || data.data || data.results || data.items
    || Object.values(data).find((v) => Array.isArray(v)) || [];
  return arr.map((s) => ({
    title: s.name || s.title || s.stream_key || 'Stream',
    category: String(s.category || s.sport || s.group || '').toLowerCase(),
    logo: s.thumbnail_url || s.thumbnail || s.poster || s.logo || s.image,
    embed: s.embed_url || s.embedUrl || s.url || s.stream_url,
  })).filter((it) => it.embed);
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

  let all = [], cat = 'all';
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    let items = cat === 'all' ? all : all.filter((it) => it.category === cat);
    if (q) items = items.filter((it) => (it.title || '').toLowerCase().includes(q));
    if (!items.length) { grid.textContent = all.length ? 'No matches.' : 'Nothing live right now.'; return; }
    grid.replaceChildren(...items.slice(0, 300).map((it) => {
      const el = document.createElement('div'); el.className = 'tile';
      if (it.logo) { const img = document.createElement('img'); img.className = 'tile-logo'; img.src = it.logo; img.onerror = () => img.remove(); el.append(img); }
      const t = document.createElement('div'); t.textContent = it.title; el.append(t);
      el.onclick = () => { open(it.embed); intendedMedia = { title: it.title, poster: it.logo, live: true }; };
      return el;
    }));
  };
  search.oninput = draw;

  fetchCatalog(src.catalogUrl).then((items) => {
    all = items;
    const cats = ['all', ...[...new Set(items.map((it) => it.category).filter(Boolean))].sort()];
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
