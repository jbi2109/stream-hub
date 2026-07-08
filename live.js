// Live TV engine: catalog fetching/parsing (single- and two-hop), match grouping, the source-selection
// page, and the Live tab renderer. Split out of browse.js (which keeps the TMDB browse). Classic script
// sharing the global scope — sourceList is also used by detail.js.

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

// Best-effort "starts at" (ms) + popularity from a catalog node — for the Live tab's "Live now" filter
// and "Most watched" sort. Generic field names; missing/unparseable -> null / 0.
const CATALOG_START_FIELDS = ['date', 'match_timestamp', 'timestamp', 'starts_at', 'startTime', 'start', 'kickoff'];
const CATALOG_VIEW_FIELDS = ['viewers', 'viewer_count', 'views', 'watching', 'popularity'];
function catalogStart(o) {
  for (const k of CATALOG_START_FIELDS) {
    const v = o[k];
    if (typeof v === 'number' && v > 0) return v < 1e12 ? v * 1000 : v; // seconds -> ms
    if (typeof v === 'string' && v) { const t = Date.parse(v); if (!isNaN(t)) return t; }
  }
  return null;
}
function catalogViews(o) {
  for (const k of CATALOG_VIEW_FIELDS) if (typeof o[k] === 'number') return o[k];
  return o.popular === true ? 1 : 0; // streamed.pk-style boolean floats flagged matches up
}

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
    const nodeStart = catalogStart(node), nodeViews = catalogViews(node); // match-level time/popularity
    // per-item channels/streams/sources array -> one row per entry (grouped back into the match later)
    for (const key of CATALOG_CHANNEL_ARRAYS) {
      if (Array.isArray(node[key])) {
        for (const ch of node[key]) {
          if (out.length >= CAP) return;
          const embed = ch && typeof ch === 'object' && catalogEmbed(ch);
          if (embed) out.push({ matchTitle: t || 'Stream', label: catalogTitle(ch) || '', embed,
            category: String(ch.category || ch.sport || nodeCat || '').toLowerCase(),
            logo: catalogLogo(ch) || catalogLogo(node), language: ch.language || ch.lang || parseLanguage(catalogTitle(ch) || t),
            startsAt: catalogStart(ch) ?? nodeStart, popularity: catalogViews(ch) || nodeViews });
          else if (ch && typeof ch === 'object' && typeof ch.source === 'string' && ch.id != null) {
            // two-hop shape: {source,id} with no embed -> resolve later via a derived /stream/{source}/{id} URL
            out.push({ matchTitle: t || 'Stream', label: String(ch.source), embed: null,
              unresolved: { source: ch.source, id: String(ch.id) },
              category: String(ch.category || ch.sport || nodeCat || '').toLowerCase(),
              logo: catalogLogo(node) || catalogLogo(ch), language: ch.language || ch.lang || '',
              startsAt: nodeStart, popularity: nodeViews });
          }
        }
      }
    }
    // a direct embed on this node
    const embed = catalogEmbed(node);
    if (embed) out.push({ matchTitle: t || 'Stream', label: String(node.server || node.quality || node.channel_name || ''),
      embed, category: nodeCat, logo: catalogLogo(node), language: node.language || node.lang || parseLanguage(t),
      startsAt: nodeStart, popularity: nodeViews });
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
// ones IN PARALLEL. Cached in a module Map (match objects are recreated on every grid rebuild, so a
// property cache would be lost). The key includes the source count so a match that gains sources from a
// later-arriving catalog re-resolves instead of serving the stale early answer.
const resolvedCache = new Map(); // `${matchKey}#${sourceCount}` -> resolved rows
async function resolveMatchSources(match) {
  const key = matchKey(match.title) + '#' + match.sources.length;
  if (resolvedCache.has(key)) return resolvedCache.get(key);
  const perSource = await Promise.all(match.sources.map(async (s) => {
    if (s.embed) return [{ label: s.label, embed: s.embed, language: s.language, quality: parseQuality(s.label), catalog: s.catalog }];
    if (!s.unresolved) return [];
    const streams = await fetchStreams(s.catalogUrl, s.unresolved.source, s.unresolved.id);
    return streams.map((st) => ({
      label: `${s.unresolved.source}${st.streamNo !== '' ? ' ' + st.streamNo : ''}`.trim() || 'Source',
      embed: st.embed, language: st.language, quality: st.quality, catalog: s.catalog,
    }));
  }));
  const out = perSource.flat();
  resolvedCache.set(key, out);
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
    if (!g) { g = { title: r.matchTitle || 'Stream', category: r.category || '', logo: r.logo || '', sources: [], startsAt: null, popularity: 0 }; byKey.set(key, g); }
    if (!g.logo && r.logo) g.logo = r.logo;
    if (!g.category && r.category) g.category = r.category;
    if (r.startsAt != null && (g.startsAt == null || r.startsAt < g.startsAt)) g.startsAt = r.startsAt; // earliest
    if ((r.popularity || 0) > g.popularity) g.popularity = r.popularity || 0; // most-watched signal
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
        open(s.embed); // sets lastPlayed = {url, live:false}; enrich it with the live match below
        intendedMedia = { title: match.title, poster: match.logo, live: true };
        currentLiveMatch = match;
        lastPlayed.live = true;
        lastPlayed.match = { title: match.title, category: match.category, logo: match.logo, sources: match.sources };
        store('lastPlayed', lastPlayed);
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
  if (m.logo) { const img = document.createElement('img'); img.loading = 'lazy'; img.src = m.logo; img.onerror = () => { img.remove(); thumb.classList.add('noimg'); }; thumb.append(img); }
  else thumb.classList.add('noimg');
  const t = document.createElement('div'); t.className = 'match-title'; t.textContent = m.title;
  el.append(thumb, t);
  // Always open the source page (never auto-jump a single source) — the same show often has sources in
  // other catalogs that stream in a moment later; landing on the page lets the user reach them.
  el.onclick = () => showLivePicker(m);
  return el;
}

// Catalog cache: entering the Live tab (incl. "← Back" from a source page) within the TTL renders
// instantly from the cached rows instead of refetching every catalog. A failed fetch is also cached for
// the TTL so a dead catalog isn't hammered on every entry. ↻ Refresh clears it.
const LIVE_CACHE_TTL = 90000; // ms
const liveCatalogCache = new Map(); // catalogUrl -> { rows, at } | { error: true, at }

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
  const filterRow = document.createElement('div'); filterRow.className = 'live-filter-row';
  const search = document.createElement('input'); search.className = 'browse-search'; search.placeholder = 'Search live…';
  filterRow.append(search);
  controls.append(catBar, filterRow);
  const grid = document.createElement('div'); grid.className = 'grid match-grid'; grid.textContent = 'Loading…';
  nodes.push(controls, grid);
  container.replaceChildren(...nodes);

  let all = [], cat = 'all', allRows = [], liveSort = 'default', liveOnly = false;
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    let items = cat === 'all' ? all : all.filter((it) => it.category === cat);
    if (q) items = items.filter((it) => (it.title || '').toLowerCase().includes(q));
    if (liveOnly) items = items.filter((it) => !it.startsAt || it.startsAt <= Date.now() + 60000); // hide upcoming (60s grace)
    if (liveSort === 'popular') items = items.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    if (!items.length) { grid.textContent = all.length ? 'No matches.' : 'Nothing live right now.'; return; }
    grid.replaceChildren(...items.slice(0, 400).map(matchCard));
  };

  // Most-watched sort + Live-now filter (both operate on the already-fetched matches; no extra network)
  filterRow.append(
    pillSelect('Default order', 'default', [['popular', 'Most watched']], liveSort, (v) => { liveSort = v; draw(); }),
  );
  const liveNowBtn = document.createElement('button');
  liveNowBtn.className = 'pill-toggle';
  liveNowBtn.textContent = 'Live now';
  liveNowBtn.onclick = () => { liveOnly = !liveOnly; liveNowBtn.classList.toggle('active', liveOnly); draw(); };
  filterRow.append(liveNowBtn);
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'pill-toggle';
  refreshBtn.id = 'live-refresh';
  refreshBtn.title = 'Refresh catalogs';
  refreshBtn.textContent = '↻';
  refreshBtn.onclick = () => {
    for (const s of catalogSrcs) liveCatalogCache.delete(s.catalogUrl);
    resolvedCache.clear();
    renderLiveTab(container);
  };
  filterRow.append(refreshBtn);
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

  // Per-catalog status chips (name ✓count / ✕ failed / … loading) so a timed-out catalog is visible.
  const status = document.createElement('div'); status.className = 'live-status';
  controls.append(status);
  const chips = new Map();
  for (const s of catalogSrcs) {
    const c = document.createElement('span'); c.className = 'live-chip'; c.textContent = `${s.name} …`;
    chips.set(s.name, c); status.append(c);
  }
  const setStatus = (name, text, cls) => {
    const c = chips.get(name); if (!c) return;
    c.textContent = `${name} ${text}`; c.className = 'live-chip' + (cls ? ' ' + cls : '');
  };

  // Incremental: each catalog renders into the grid as it resolves — fast ones appear in seconds, slow
  // ones stream in without blocking. A dead catalog is aborted by the httpGet timeout (main.js), marked
  // ✕, and not retried until the cache TTL passes (or ↻ Refresh).
  for (const s of catalogSrcs) {
    const cached = liveCatalogCache.get(s.catalogUrl);
    if (cached && Date.now() - cached.at < LIVE_CACHE_TTL) {
      if (cached.rows) { allRows.push(...cached.rows); rebuild(); setStatus(s.name, '✓ ' + cached.rows.length, 'ok'); }
      else setStatus(s.name, '✕ failed', 'err');
      continue;
    }
    let origin = ''; try { origin = new URL(s.catalogUrl).origin; } catch {}
    fetchCatalog(s.catalogUrl)
      .then((rows) => {
        const mapped = rows.map((r) => ({ ...r, catalog: s.name, catalogUrl: s.catalogUrl,
          // absolutize relative logos (e.g. streamed's /api/images/... posters) against the catalog origin
          logo: r.logo && r.logo.startsWith('/') && origin ? origin + r.logo : r.logo }));
        liveCatalogCache.set(s.catalogUrl, { rows: mapped, at: Date.now() });
        allRows.push(...mapped);
        rebuild();
        setStatus(s.name, '✓ ' + mapped.length, 'ok');
      })
      .catch(() => { liveCatalogCache.set(s.catalogUrl, { error: true, at: Date.now() }); setStatus(s.name, '✕ failed', 'err'); });
  }
}
