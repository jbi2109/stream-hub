// Browse: TMDB catalog (Movies/TV/Anime) + the Live TV tab (catalog JSON APIs + plain sites).

let browseTab = 'movie'; // 'movie' | 'tv' | 'anime' | 'live' | 'youtube'
let browseQuery = '';
let browseTimer = null;
let browsePage = 1;
let browseFiltersExpanded = false; // Year/Language/Country/Provider collapsed behind the Filters toggle
// Filter selections persist per tab (movie/tv/anime keep separate sets — genre ids differ per media type).
let browseFiltersAll = load('browseFilters', {});
const loadFiltersFor = (tab) => ({ genre: '', year: '', sort: '', provider: '', language: '', country: '', ...(browseFiltersAll[tab] || {}) });
let browseFilters = loadFiltersFor('movie');
const debouncedBrowse = () => { clearTimeout(browseTimer); browseTimer = setTimeout(renderBrowse, 350); };

// Full TMDB object (details/season/discover), not just the .results list.
const tmdbCache = new Map();                 // key -> { at, p:Promise }
const TMDB_CACHE_V = 1;                        // versioned keys
const TMDB_TTL = 300000;                        // 5 min for detail/discover/season/search/person
const isConfigPath = (p) => p.startsWith('/genre/') || p.startsWith('/configuration/') || p.startsWith('/watch/providers/');
// ponytail: capMap is FIFO (approx-LRU via delete-on-hit re-insert); real LRU only if 500 entries thrash.
async function tmdbGet(path, params = {}) {
  const norm = new URLSearchParams({ ...params }); norm.sort();          // stable key, param-order-independent
  const key = TMDB_CACHE_V + '|' + path + '?' + norm.toString();          // api_key intentionally NOT in key (content is key-independent)
  const ttl = isConfigPath(path) ? Infinity : TMDB_TTL;
  const hit = tmdbCache.get(key);
  if (hit && Date.now() - hit.at < ttl) { tmdbCache.delete(key); tmdbCache.set(key, hit); return hit.p; } // LRU bump
  const p = window.sh.tmdb(path, { api_key: tmdbKey, ...params });        // in-flight promise-dedup
  p.then((d) => { if (!d || d.error) tmdbCache.delete(key); }, () => tmdbCache.delete(key)); // negative-cache: don't retain failures
  tmdbCache.set(key, { at: Date.now(), p }); capMap(tmdbCache, 500);
  return p;
}

// Cached title+poster for a TMDB id (or null). Used to title Continue/Watch-Later entries from the
// id in the embed URL instead of the provider's own og:title — correct + provider-agnostic. Caches
// PROMISES (not values) so concurrent callers — round-1's parallel heal, the dashboard hero/card[0]
// single-fetch — dedupe onto one request. A null (bad payload) or rejected resolution is NOT cached:
// the entry is deleted so a later call can retry/heal.
const tmdbMetaCache = new Map(); // `${type}:${id}` -> Promise<{title,poster,backdrop}|null>
function tmdbMeta(id, type) {
  if (!id || !tmdbKey) return Promise.resolve(null);
  const t = type === 'movie' ? 'movie' : 'tv';
  const ck = t + ':' + id;
  if (!tmdbMetaCache.has(ck)) {
    const p = (async () => {
      const d = await tmdbGet(`/${t}/${id}`, {}); // tmdbGet never throws (main returns {error}); guard on shape
      const name = d && (d.title || d.name);
      if (name) return { title: name, poster: IMG(d.poster_path, 'w342'), backdrop: IMG(d.backdrop_path, 'w780') };
      return null;
    })();
    // Do NOT persist a null/failed resolution — let a later call retry.
    p.then((v) => { if (!v) tmdbMetaCache.delete(ck); }, () => tmdbMetaCache.delete(ck));
    tmdbMetaCache.set(ck, p);
  }
  return tmdbMetaCache.get(ck);
}

// --- browse filters (genre / year / sort / provider) ---
// Option lists come from TMDB and are cached per media type so filter/page re-renders don't refetch.
const genreCache = new Map();    // mt -> [[id, name], ...]
const providerCache = new Map(); // mt -> [[id, name], ...]

async function ensureGenres(mt) {
  if (genreCache.has(mt)) return genreCache.get(mt);
  let list = [];
  try { const d = await tmdbGet(`/genre/${mt}/list`, {}); list = (d?.genres || []).map((g) => [String(g.id), g.name]); } catch {}
  genreCache.set(mt, list);
  return list;
}
async function ensureProviders(mt) {
  const region = settings.watchRegion || 'US';
  const ck = `${mt}:${region}`; // keyed by region so a Settings change takes effect without a restart
  if (providerCache.has(ck)) return providerCache.get(ck);
  let list = [];
  try {
    const d = await tmdbGet(`/watch/providers/${mt}`, { watch_region: region });
    list = (d?.results || []).slice().sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))
      .slice(0, 16).map((p) => [String(p.provider_id), p.provider_name]); // the majors, by display priority
  } catch {}
  providerCache.set(ck, list);
  return list;
}

// Language + country option lists (global, not per media type) from TMDB's config endpoints, cached.
let languageList = null; // [[iso_639_1, name], ...]
let countryList = null;  // [[iso_3166_1, name], ...]
async function ensureLanguages() {
  if (languageList) return languageList;
  let list = [];
  try {
    const d = await tmdbGet('/configuration/languages', {});
    list = (d || []).map((l) => [l.iso_639_1, l.english_name || l.name || l.iso_639_1])
      .filter(([code]) => code).sort((a, b) => a[1].localeCompare(b[1]));
  } catch {}
  languageList = list;
  return list;
}
async function ensureCountries() {
  if (countryList) return countryList;
  let list = [];
  try {
    const d = await tmdbGet('/configuration/countries', {});
    list = (d || []).map((c) => [c.iso_3166_1, c.english_name || c.native_name || c.iso_3166_1])
      .filter(([code]) => code).sort((a, b) => a[1].localeCompare(b[1]));
  } catch {}
  countryList = list;
  return list;
}

// sort_by options per media type (TMDB sort_by value -> label). First entry is the default.
const browseSorts = (mt) => {
  const date = mt === 'movie' ? 'primary_release_date' : 'first_air_date';
  const az = mt === 'movie' ? 'title.asc' : 'name.asc';
  return [['popularity.desc', 'Most Popular'], [`${date}.desc`, 'Newest'], [`${date}.asc`, 'Oldest'],
    ['vote_average.desc', 'Highest Rated'], ['vote_count.desc', 'Most Voted'], [az, 'A-Z']];
};
const browseYears = () => { const out = []; for (let y = new Date().getFullYear(); y >= 1950; y--) out.push([String(y), String(y)]); return out; };

// A pill <select>: a leading default option (firstLabel/firstValue) then [value,label] pairs.
function pillSelect(firstLabel, firstValue, pairs, value, onChange) {
  const sel = document.createElement('select');
  sel.className = 'pill-select';
  for (const [v, label] of [[firstValue, firstLabel], ...pairs]) {
    const o = document.createElement('option'); o.value = v; o.textContent = label; sel.append(o);
  }
  sel.value = value || firstValue;
  sel.onchange = () => onChange(sel.value);
  return sel;
}

// --- Netflix-style hover preview (F3) ---
// Fetch-on-hover the SAME detail the hero uses, cached in an isolated map (NOT tmdbMetaCache).
const hpCache = new Map(); // `${kind}:${id}` -> Promise<detail|null>
function hoverDetail(kind, id) {
  const k = kind + ':' + id;
  if (!hpCache.has(k)) {
    const p = tmdbGet(`/${kind === 'movie' ? 'movie' : 'tv'}/${id}`, { append_to_response: 'images', include_image_language: 'en,null' })
      .then((d) => (d && (d.title || d.name)) ? d : null).catch(() => null);
    p.then((v) => { if (!v) hpCache.delete(k); }); // don't cache failures (mirrors tmdbMeta's delete-on-null)
    hpCache.set(k, p);
  }
  return hpCache.get(k);
}
let HOVER_MS = 1000;                      // bare global so e2e can zero it (like heroTimer/settings)
let hp = null, hpTimer = null, hpHide = null, hpToken = 0;
function hoverPreviewNode() {              // build the singleton once, lazily, appended to document.body
  if (hp) return hp;
  hp = mk('div', 'hover-preview'); hp.hidden = true;
  const art = mk('div', 'hp-art'); const img = document.createElement('img'); img.loading = 'lazy';
  img.onerror = () => { img.style.display = 'none'; }; art.append(img);
  const body = mk('div', 'hp-body');
  const title = mk('div', 'hp-title'); const meta = mk('div', 'hp-meta'); const ov = mk('div', 'hp-overview');
  const cta = mk('div', 'hp-cta'); const play = mk('button', 'hero-btn primary hp-play'); const later = mk('button', 'hero-btn hp-later', '+ Watch Later');
  play.textContent = '▶ Details'; cta.append(play, later);
  body.append(title, meta, ov, cta); hp.append(art, body);
  hp.addEventListener('mouseenter', () => { clearTimeout(hpHide); });   // moving onto the card keeps it
  hp.addEventListener('mouseleave', scheduleHide);
  document.body.append(hp);
  document.addEventListener('scroll', hideHoverPreview, true); // capture-phase: the fixed node's anchor moves on any scroll (rail or view)
  hp._els = { img, title, meta, ov, play, later };
  return hp;
}
const scheduleHide = () => { clearTimeout(hpHide); hpHide = setTimeout(hideHoverPreview, 120); }; // grace period
function hideHoverPreview() { if (hp) hp.hidden = true; hpToken++; clearTimeout(hpTimer); clearTimeout(hpHide); }
async function showHoverPreview(cardEl, kind, item) {
  const node = hoverPreviewNode(); const token = ++hpToken;
  const d = await hoverDetail(kind, item.id);
  if (token !== hpToken || !cardEl.isConnected || !d) return;     // stale hover / navigated / no data
  const e = node._els;
  e.title.textContent = d.title || d.name || '';
  const year = (d.release_date || d.first_air_date || '').slice(0, 4);
  e.meta.textContent = [year, d.vote_average ? `★ ${d.vote_average.toFixed(1)}` : '', (d.genres || []).slice(0, 3).map((g) => g.name).join(' · ')].filter(Boolean).join('   ·   ');
  e.ov.textContent = (d.overview || '').slice(0, 200);
  e.img.style.display = ''; e.img.src = IMG(d.backdrop_path, 'w780') || '';
  e.play.onclick = () => { hideHoverPreview(); showDetail(kind, item.id); };
  e.later.onclick = () => { addLater(kind, kind === 'movie' ? 'movie' : 'tv', item.id, d.title || d.name, IMG(d.poster_path, 'w342')); hideHoverPreview(); };
  node.hidden = false;
  positionHoverPreview(cardEl, node);
}
function positionHoverPreview(cardEl, node) {
  const r = cardEl.getBoundingClientRect();
  const w = node.offsetWidth, h = node.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));   // clamp to viewport
  let top = r.top - h - 8;                                          // prefer above
  if (top < 8) top = r.bottom + 8;                                 // flip below if no room
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));    // clamp: never off-screen / over the topbar
  node.style.left = left + 'px'; node.style.top = top + 'px';
}

function posterCard(kind, item, rank) {
  const el = document.createElement('div');
  el.className = 'card poster-card';
  el.tabIndex = 0;
  const wrap = document.createElement('div');
  wrap.className = 'poster-wrap';
  if (item.poster_path) {
    const img = document.createElement('img');
    img.className = 'poster';
    img.loading = 'lazy';
    img.src = `https://image.tmdb.org/t/p/w342${item.poster_path}`;
    img.onerror = () => { img.remove(); wrap.classList.add('noposter'); };
    wrap.append(img);
  } else {
    wrap.classList.add('noposter');
  }
  // hover overlay (play glyph) + persistent gradient info — both pointer-events:none so every
  // click lands on the card itself
  const overlay = mk('div', 'poster-overlay');
  overlay.append(icon('play'));
  wrap.append(overlay);
  const info = mk('div', 'poster-info');
  info.append(mk('div', 'poster-info-title', item.title || item.name || 'Untitled'));
  const year = (item.release_date || item.first_air_date || '').slice(0, 4);
  const meta = [year, item.vote_average ? `★ ${item.vote_average.toFixed(1)}` : ''].filter(Boolean).join('  ·  ');
  if (meta) info.append(mk('div', 'poster-info-meta', meta));
  wrap.append(info);
  if (rank) wrap.append(mk('span', 'rank-badge', String(rank).padStart(2, '0'))); // TOP 10 numbered overlay
  // 'New' tag: only a PAST release within the last 21 days (upcoming/future -> nothing)
  const rel = item.release_date || item.first_air_date || '';
  const rt = Date.parse(rel);
  if (!isNaN(rt) && rt <= Date.now() && Date.now() - rt <= 21 * 86400000) wrap.append(mk('span', 'tile-tag new', 'New'));
  el.append(wrap);
  el.onclick = () => showDetail(kind, item.id);
  // Netflix expand-on-hover: after ~1s, show the floating preview card (complements the .poster-overlay).
  // Gated on real hover capability so touch devices (no hover) never trigger it.
  if (matchMedia('(hover: hover)').matches) {
    el.addEventListener('mouseenter', () => { clearTimeout(hpTimer); clearTimeout(hpHide);
      hpTimer = setTimeout(() => showHoverPreview(el, kind, item), HOVER_MS); });
    el.addEventListener('mouseleave', () => { clearTimeout(hpTimer); scheduleHide(); });
  }
  return el;
}

// --- global search (#search view) — multi-search across movies + TV ---
let searchQuery = '', searchTimer = null;
function renderSearch() {
  const input = mk('input', 'browse-search'); input.placeholder = 'Search movies, shows, people…'; input.value = searchQuery;
  const grid = mk('div', 'grid');
  input.oninput = () => { searchQuery = input.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(grid), 300); };
  $('search').replaceChildren(input, grid);
  if (!tmdbKey) { grid.replaceChildren(stateNode('empty', 'Add a TMDB key in Settings to search.')); }
  else if (searchQuery) runSearch(grid);
  else grid.replaceChildren(stateNode('empty', 'Search across movies, TV, and people.'));
  input.focus();
}
async function runSearch(grid) {
  const q = searchQuery; if (!q) { renderSearch(); return; }
  const d = await tmdbGet('/search/multi', { query: q });
  if (searchQuery !== q) return;                                   // stale
  // ponytail: person results dropped for v0.5.0 — add a person branch (name+known-for) when search grows a People tab.
  const rows = (d?.results || []).filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && (r.poster_path || r.title || r.name));
  grid.replaceChildren(rows.length ? undefined : stateNode('empty', 'No results.'));
  if (rows.length) grid.replaceChildren(...rows.map((r) => posterCard(r.media_type, r)));   // click → showDetail(kind,id) for free
}

// VOD tabs only — Live TV + YouTube are reached from the rail (📺 / ▶), not this bar.
function browseTabBar() {
  const tabs = [['movie', 'Movies'], ['tv', 'TV'], ['anime', 'Anime']];
  return tabBar(tabs, browseTab, (id) => {
    browseTab = id;
    browseQuery = '';
    browsePage = 1;
    browseFilters = loadFiltersFor(id); // each tab remembers its own selections
    renderBrowse();
  }, 'tabs');
}

async function renderBrowse() {
  if (browseTab === 'live') { renderLiveTab($('browse')); return; }
  const nodes = [browseTabBar()];

  // Movies / TV / Anime need a TMDB key
  if (!tmdbKey) {
    nodes.push(emptyMsg('Add your free TMDB API key to browse. Get one at themoviedb.org → Settings → API.'));
    const toSettings = mk('button', 'set-btn', 'Open Settings');
    toSettings.onclick = () => { showSettings(); showSettingsTab('general'); };
    nodes.push(toSettings);
    $('browse').replaceChildren(...nodes);
    return;
  }

  const mt = browseTab === 'movie' ? 'movie' : 'tv';

  // search box
  const search = document.createElement('input');
  search.className = 'browse-search';
  search.placeholder = `Search ${browseTab === 'anime' ? 'anime' : browseTab === 'movie' ? 'movies' : 'TV'}...`;
  search.value = browseQuery;
  search.oninput = () => { browseQuery = search.value; browsePage = 1; debouncedBrowse(); };
  nodes.push(search);

  // filter bar (genre / year / sort / provider) — populated once the cached option lists resolve
  const filterBar = document.createElement('div');
  filterBar.className = 'browse-filters';
  nodes.push(filterBar);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.replaceChildren(...skeletonCards(12));
  nodes.push(grid);

  const pager = document.createElement('div');
  pager.className = 'browse-pager';
  nodes.push(pager);

  const tabAtRender = browseTab;
  $('browse').replaceChildren(...nodes);

  // filters (cached after the first fetch)
  const [genres, providers, languages, countries] = await Promise.all(
    [ensureGenres(mt), ensureProviders(mt), ensureLanguages(), ensureCountries()]);
  if (browseTab !== tabAtRender) return; // user switched tabs mid-fetch
  const setFilter = (key, v) => {
    browseFilters[key] = v;
    browseFiltersAll[browseTab] = browseFilters;
    store('browseFilters', browseFiltersAll); // selections persist across visits + restarts
    browsePage = 1;
    renderBrowse();
  };
  // Genre + Sort stay visible; Year/Language/Country/Provider hide behind the Filters toggle.
  const adv = (sel) => { sel.classList.add('filter-adv'); return sel; };
  const activeAdv = ['year', 'language', 'country', 'provider'].filter((k) => browseFilters[k]).length;
  if (activeAdv) browseFiltersExpanded = true; // never hide an active advanced filter
  const toggle = mk('button', 'filter-toggle', 'Filters');
  if (activeAdv) toggle.append(mk('span', 'filter-badge', String(activeAdv)));
  toggle.onclick = () => { browseFiltersExpanded = filterBar.classList.toggle('expanded'); };
  filterBar.classList.toggle('expanded', browseFiltersExpanded);
  filterBar.replaceChildren(
    pillSelect('All Genres', '', genres, browseFilters.genre, (v) => setFilter('genre', v)),
    adv(pillSelect('All Years', '', browseYears(), browseFilters.year, (v) => setFilter('year', v))),
    adv(pillSelect('All Languages', '', languages, browseFilters.language, (v) => setFilter('language', v))),
    adv(pillSelect('All Countries', '', countries, browseFilters.country, (v) => setFilter('country', v))),
    pillSelect('Most Popular', 'popularity.desc', browseSorts(mt).slice(1), browseFilters.sort, (v) => setFilter('sort', v)),
    adv(pillSelect('All Providers', '', providers, browseFilters.provider, (v) => setFilter('provider', v))),
    toggle,
  );

  // results
  const data = await fetchBrowse(browseTab, browseQuery, browseFilters, browsePage);
  if (browseTab !== tabAtRender) return;
  const results = (data && data.results) || [];
  if (!results.length) grid.replaceChildren(stateNode('empty', 'No results (check your TMDB key / filters).'));
  else {
    grid.classList.add('anim-in'); // fresh full render — entrance is fine here (never on live draw())
    grid.replaceChildren(...results.filter((r) => r.poster_path || r.title || r.name).map((r) => posterCard(browseTab, r)));
  }

  // pager: 20 per page, Prev disabled on page 1, Next disabled at the last page (TMDB caps at 500)
  const totalPages = Math.min(data?.total_pages || 1, 500);
  const pageBtn = (label, disabled, delta) => {
    const b = document.createElement('button'); b.className = 'pager-btn'; b.textContent = label; b.disabled = disabled;
    if (!disabled) b.onclick = () => { browsePage += delta; renderBrowse(); };
    return b;
  };
  const info = document.createElement('span'); info.className = 'pager-info';
  info.textContent = `Page ${browsePage}${totalPages > 1 ? ' / ' + totalPages : ''}`;
  pager.replaceChildren(pageBtn('‹ Prev', browsePage <= 1, -1), info, pageBtn('Next ›', browsePage >= totalPages, 1));

  // keep focus in the search box while typing
  if (browseQuery) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
}

// Returns the full TMDB response ({ results, page, total_pages }). Search honors year only; browsing
// (no query) uses /discover with all four filters.
async function fetchBrowse(tab, query, filters, page) {
  const mt = tab === 'movie' ? 'movie' : 'tv';
  const yearKey = mt === 'movie' ? 'primary_release_year' : 'first_air_date_year';
  if (query) {
    const p = { query, page };
    if (filters.year) p[yearKey] = filters.year; // ponytail: TMDB search ignores genre/sort/provider
    return tmdbGet(`/search/${mt}`, p);
  }
  const p = { page, sort_by: filters.sort || 'popularity.desc' };
  const genres = [];
  if (tab === 'anime') genres.push('16'); // keep anime = animation
  if (filters.genre) genres.push(filters.genre);
  if (genres.length) p.with_genres = genres.join(',');
  if (filters.year) p[yearKey] = filters.year;
  // language: an explicit pick wins; else anime defaults to Japanese, other tabs unrestricted
  if (filters.language) p.with_original_language = filters.language;
  else if (tab === 'anime') p.with_original_language = 'ja';
  if (filters.country) p.with_origin_country = filters.country;
  if (filters.provider) { p.with_watch_providers = filters.provider; p.watch_region = settings.watchRegion || 'US'; }
  if ((filters.sort || '').startsWith('vote_average')) p['vote_count.gte'] = 200; // avoid a few-vote 10.0s
  return tmdbGet(`/discover/${mt}`, p);
}
