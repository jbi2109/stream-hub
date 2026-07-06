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
  if (providerCache.has(mt)) return providerCache.get(mt);
  let list = [];
  try {
    const d = await tmdbGet(`/watch/providers/${mt}`, { watch_region: settings.watchRegion || 'US' });
    list = (d?.results || []).slice().sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))
      .slice(0, 16).map((p) => [String(p.provider_id), p.provider_name]); // the majors, by display priority
  } catch {}
  providerCache.set(mt, list);
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
          else if (ch && typeof ch === 'object' && typeof ch.source === 'string' && ch.id != null) {
            // two-hop shape: {source,id} with no embed -> resolve later via a derived /stream/{source}/{id} URL
            out.push({ matchTitle: t || 'Stream', label: String(ch.source), embed: null,
              unresolved: { source: ch.source, id: String(ch.id) },
              category: String(ch.category || ch.sport || nodeCat || '').toLowerCase(),
              logo: catalogLogo(node) || catalogLogo(ch), language: ch.language || ch.lang || '' });
          }
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

// --- two-hop live catalogs (streamed.pk-style: matches list -> per-source stream lookup) ---
// Derive the second-hop stream endpoint from the user's catalog URL — generic, no committed provider path.
// streamed.pk resolves via {origin}/api/stream/{source}/{id}; the /matches -> /stream path swap covers
// APIs not under /api. // ponytail: assumes a /stream/{source}/{id} convention; other shapes won't resolve.
function streamEndpoints(catalogUrl, source, id) {
  const s = encodeURIComponent(source), i = encodeURIComponent(id);
  const cands = [];
  try {
    const u = new URL(catalogUrl);
    if (/\/matches\b/i.test(u.pathname)) cands.push(u.origin + u.pathname.replace(/\/matches\b.*$/i, '') + `/stream/${s}/${i}`);
    cands.push(u.origin + `/api/stream/${s}/${i}`);
  } catch {}
  return [...new Set(cands)];
}

// Fetch a source's second hop and flatten to playable rows. First endpoint that parses to an array of
// objects carrying an embed field wins. Reuses window.sh.httpGet (browser UA + 60s timeout in main.js).
async function fetchStreams(catalogUrl, source, id) {
  for (const url of streamEndpoints(catalogUrl, source, id)) {
    try {
      const r = await window.sh.httpGet(url);
      if (!r || r.error || !r.ok) continue;
      const arr = JSON.parse(r.body);
      if (!Array.isArray(arr)) continue;
      const rows = arr.filter((x) => x && typeof x === 'object' && catalogEmbed(x)).map((x) => ({
        embed: catalogEmbed(x),
        language: x.language || x.lang || '',
        quality: x.hd === true ? 'HD' : parseQuality(x.quality || x.label || ''),
        streamNo: x.streamNo != null ? x.streamNo : '',
      }));
      if (rows.length) return rows;
    } catch {}
  }
  return [];
}

// Resolve a match's sources for the source page: pass single-hop embeds through; second-hop the {source,id}
// ones. Cached on the match object so reopening (Resume / Sources button) doesn't refetch.
async function resolveMatchSources(match) {
  if (match._resolved) return match._resolved;
  const out = [];
  for (const s of match.sources) {
    if (s.embed) { out.push({ label: s.label, embed: s.embed, language: s.language, quality: parseQuality(s.label), catalog: s.catalog }); continue; }
    if (!s.unresolved) continue;
    const streams = await fetchStreams(s.catalogUrl, s.unresolved.source, s.unresolved.id);
    for (const st of streams) out.push({
      label: `${s.unresolved.source}${st.streamNo !== '' ? ' ' + st.streamNo : ''}`.trim() || 'Source',
      embed: st.embed, language: st.language, quality: st.quality, catalog: s.catalog,
    });
  }
  match._resolved = out;
  return out;
}

// Team-order-aware key so "A vs B" and "B vs A" collapse to one match, even across catalogs.
function matchKey(title) {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?)\s+v(?:s)?\s+(.+)$/);
  return m ? [m[1].trim(), m[2].trim()].sort().join(' v ') : t;
}

// Collapse per-source rows into one entry per match (team-order-aware, pooled across catalogs). Each
// source keeps its catalog + language so the source page can group + sort them.
function groupMatches(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = matchKey(r.matchTitle) || r.embed;
    let g = byKey.get(key);
    if (!g) { g = { title: r.matchTitle || 'Stream', category: r.category || '', logo: r.logo || '', sources: [] }; byKey.set(key, g); }
    if (!g.logo && r.logo) g.logo = r.logo;
    if (!g.category && r.category) g.category = r.category;
    // dedup resolved sources by embed, unresolved (two-hop) by source+id
    const dup = r.embed
      ? g.sources.some((s) => s.embed === r.embed)
      : r.unresolved && g.sources.some((s) => s.unresolved && s.unresolved.source === r.unresolved.source && s.unresolved.id === r.unresolved.id);
    if (!dup) g.sources.push({ label: r.label || '', embed: r.embed || null, unresolved: r.unresolved || null,
      language: r.language || '', catalog: r.catalog || '', catalogUrl: r.catalogUrl || '' });
  }
  return [...byKey.values()];
}

// HD/FHD/SD/4K from a source label (a small quality chip on the source page).
const parseQuality = (label) => { const m = String(label || '').match(/\b(4k|uhd|fhd|hd|sd)\b/i); return m ? m[1].toUpperCase() : ''; };

// Generic photo-3 source list: groups of rows, each row = [quality] label [language], click -> onPick.
// `groups = [{ name, rows: [{ label, language, quality, onPick }] }]`.
function sourceList(groups) {
  const wrap = document.createElement('div'); wrap.className = 'src-list';
  for (const g of groups) {
    const group = document.createElement('div'); group.className = 'src-group';
    if (g.name) { const gh = document.createElement('div'); gh.className = 'src-group-name'; gh.textContent = g.name; group.append(gh); }
    for (const r of g.rows) {
      const row = document.createElement('div'); row.className = 'src-row';
      if (r.quality) { const qc = document.createElement('span'); qc.className = 'src-q'; qc.textContent = r.quality; row.append(qc); }
      const name = document.createElement('span'); name.className = 'src-name'; name.textContent = r.label;
      row.append(name);
      if (r.language) { const chip = document.createElement('span'); chip.className = 'src-lang'; chip.textContent = r.language; row.append(chip); }
      row.onclick = r.onPick;
      group.append(row);
    }
    if (!g.rows.length) group.append(emptyMsg('No sources — add one in Settings.'));
    wrap.append(group);
  }
  return wrap;
}

// Build source-list groups from a resolved source array: grouped by catalog, default language floated up.
function liveMatchGroups(match, srcs) {
  const pref = (settings.liveLanguage || '').toLowerCase();
  const rank = (s) => { const l = (s.language || '').toLowerCase(); return pref && l === pref ? 0 : (l ? 2 : 1); };
  const byCat = new Map();
  srcs.forEach((s, i) => {
    const c = s.catalog || 'Sources';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push({ ...s, label: s.label || ('Source ' + (i + 1)) });
  });
  return [...byCat.entries()].map(([name, list]) => ({
    name,
    rows: list.sort((a, b) => rank(a) - rank(b)).map((s) => ({
      label: s.label, language: s.language, quality: s.quality || parseQuality(s.label),
      onPick: () => {
        open(s.embed);
        intendedMedia = { title: match.title, poster: match.logo, live: true };
        currentLiveMatch = match; lastPlayedLive = true; lastLiveMatch = match;
        $('live-sources').hidden = false; $('sources-overlay').hidden = false;
      },
    })),
  }));
}

// Live source-selection PAGE (photo 3/4): rendered into the #detail container. Back returns to the grid.
// Async: single-hop sources render at once; two-hop ({source,id}) sources are resolved (a "Loading…"
// placeholder shows meanwhile) via the derived stream endpoint.
async function showLivePicker(match) {
  hideAll();
  currentLiveMatch = match;
  const el = $('detail');
  const back = document.createElement('div'); back.className = 'detail-back';
  const bb = document.createElement('button'); bb.textContent = '← Back'; bb.onclick = () => { browseTab = 'live'; showBrowse(); };
  back.append(bb);
  const head = document.createElement('div'); head.className = 'live-pick-head';
  if (match.logo) { const img = document.createElement('img'); img.className = 'live-pick-logo'; img.src = match.logo; img.onerror = () => img.remove(); head.append(img); }
  const h = document.createElement('h1'); h.textContent = match.title; head.append(h);
  const sec = document.createElement('div'); sec.className = 'detail-section';
  sec.textContent = 'Loading sources…';
  el.replaceChildren(back, head, sec);
  el.hidden = false;
  const srcs = await resolveMatchSources(match);
  if (currentLiveMatch !== match || el.hidden) return; // user navigated away while resolving
  if (!srcs.length) { sec.textContent = 'No playable sources.'; return; }
  sec.replaceChildren(sourceList(liveMatchGroups(match, srcs)));
}

// photo-2 style match card: 16:9 image (cover) + title below, no source count.
function matchCard(m) {
  const el = document.createElement('div'); el.className = 'match-card';
  const thumb = document.createElement('div'); thumb.className = 'match-thumb';
  if (m.logo) { const img = document.createElement('img'); img.src = m.logo; img.onerror = () => { img.remove(); thumb.classList.add('noimg'); }; thumb.append(img); }
  else thumb.classList.add('noimg');
  const t = document.createElement('div'); t.className = 'match-title'; t.textContent = m.title;
  el.append(thumb, t);
  // Always open the source page (never auto-jump a single source) — the same show often has sources in
  // other catalogs that stream in a moment later; landing on the page lets the user reach them.
  el.onclick = () => showLivePicker(m);
  return el;
}

// Live TV tab: ONE grid amalgamating every catalog source (matches pooled + merged across catalogs) +
// plain "open the site" tiles for non-catalog live sources.
function renderLiveTab(container) {
  const live = sources.filter((s) => s.category === 'live');
  const catalogSrcs = live.filter((s) => s.catalogUrl);
  const siteSrcs = live.filter((s) => !s.catalogUrl && s.url);
  const nodes = []; // no browse tab bar here — the Live view is reached via the 📺 rail button

  if (!live.length) {
    nodes.push(emptyMsg('Add a Live TV source in Settings → + Add player / source.'));
    container.replaceChildren(...nodes);
    return;
  }

  if (siteSrcs.length) {
    const siteGrid = document.createElement('div'); siteGrid.className = 'grid tiles';
    siteGrid.append(...siteSrcs.map((s) => {
      const el = document.createElement('div'); el.className = 'tile'; el.textContent = s.name;
      el.onclick = () => { currentSource = s.url; open(s.url); };
      return el;
    }));
    nodes.push(siteGrid);
  }

  if (!catalogSrcs.length) { container.replaceChildren(...nodes); return; }

  const controls = document.createElement('div'); controls.className = 'live-controls';
  const catBar = document.createElement('div'); catBar.className = 'subtabs';
  const search = document.createElement('input'); search.className = 'browse-search'; search.placeholder = 'Search live…';
  controls.append(catBar, search);
  const grid = document.createElement('div'); grid.className = 'grid match-grid'; grid.textContent = 'Loading…';
  nodes.push(controls, grid);
  container.replaceChildren(...nodes);

  let all = [], cat = 'all', allRows = [];
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    let items = cat === 'all' ? all : all.filter((it) => it.category === cat);
    if (q) items = items.filter((it) => (it.title || '').toLowerCase().includes(q));
    if (!items.length) { grid.textContent = all.length ? 'No matches.' : 'Nothing live right now.'; return; }
    grid.replaceChildren(...items.slice(0, 400).map(matchCard));
  };
  const renderCatBar = () => {
    const cats = ['all', ...[...new Set(all.map((it) => it.category).filter(Boolean))].sort()];
    catBar.replaceChildren();
    if (cats.length > 2) {
      for (const c of cats) {
        const b = document.createElement('button'); b.className = 'tab' + (c === cat ? ' active' : '');
        b.textContent = c === 'all' ? 'All' : c[0].toUpperCase() + c.slice(1);
        b.onclick = () => { cat = c; renderCatBar(); draw(); };
        catBar.append(b);
      }
    }
  };
  const rebuild = () => { all = groupMatches(allRows); renderCatBar(); draw(); };
  search.oninput = draw;

  // Incremental: each catalog renders into the grid as it resolves — fast ones appear in seconds, slow
  // ones stream in without blocking. A dead catalog is aborted by the httpGet timeout (main.js) and skipped.
  for (const s of catalogSrcs) {
    let origin = ''; try { origin = new URL(s.catalogUrl).origin; } catch {}
    fetchCatalog(s.catalogUrl)
      .then((rows) => {
        allRows.push(...rows.map((r) => ({ ...r, catalog: s.name, catalogUrl: s.catalogUrl,
          // absolutize relative logos (e.g. streamed's /api/images/... posters) against the catalog origin
          logo: r.logo && r.logo.startsWith('/') && origin ? origin + r.logo : r.logo })));
        rebuild();
      })
      .catch(() => {});
  }
}
