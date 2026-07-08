// Browse: TMDB catalog (Movies/TV/Anime) + the Live TV tab (catalog JSON APIs + plain sites).

let browseTab = 'movie'; // 'movie' | 'tv' | 'anime' | 'live' | 'youtube'
let browseQuery = '';
let browseTimer = null;
let browsePage = 1;
let browseFilters = { genre: '', year: '', sort: '', provider: '', language: '', country: '' };
const debouncedBrowse = () => { clearTimeout(browseTimer); browseTimer = setTimeout(renderBrowse, 350); };

// Full TMDB object (details/season/discover), not just the .results list.
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

function posterCard(kind, item) {
  const el = document.createElement('div');
  el.className = 'card';
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
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = item.title || item.name || 'Untitled';
  el.append(wrap, title);
  el.onclick = () => showDetail(kind, item.id);
  return el;
}

// VOD tabs only — Live TV + YouTube are reached from the rail (📺 / ▶), not this bar.
function browseTabBar() {
  const tabs = [['movie', 'Movies'], ['tv', 'TV'], ['anime', 'Anime']];
  return tabBar(tabs, browseTab, (id) => {
    browseTab = id;
    browseQuery = '';
    browsePage = 1;
    browseFilters = { genre: '', year: '', sort: '', provider: '', language: '', country: '' }; // genre lists differ per media type
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
  grid.textContent = 'Loading…';
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
  const setFilter = (key, v) => { browseFilters[key] = v; browsePage = 1; renderBrowse(); };
  filterBar.replaceChildren(
    pillSelect('All Genres', '', genres, browseFilters.genre, (v) => setFilter('genre', v)),
    pillSelect('All Years', '', browseYears(), browseFilters.year, (v) => setFilter('year', v)),
    pillSelect('All Languages', '', languages, browseFilters.language, (v) => setFilter('language', v)),
    pillSelect('All Countries', '', countries, browseFilters.country, (v) => setFilter('country', v)),
    pillSelect('Most Popular', 'popularity.desc', browseSorts(mt).slice(1), browseFilters.sort, (v) => setFilter('sort', v)),
    pillSelect('All Providers', '', providers, browseFilters.provider, (v) => setFilter('provider', v)),
  );

  // results
  const data = await fetchBrowse(browseTab, browseQuery, browseFilters, browsePage);
  if (browseTab !== tabAtRender) return;
  const results = (data && data.results) || [];
  grid.textContent = '';
  if (!results.length) grid.textContent = 'No results (check your TMDB key / filters).';
  else grid.append(...results.filter((r) => r.poster_path || r.title || r.name).map((r) => posterCard(browseTab, r)));

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
