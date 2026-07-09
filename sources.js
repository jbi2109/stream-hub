// Sources: the Settings list (add/edit/remove/default) + play-URL building and routing.

function sourceItem(src) {
  const li = mk('li');
  const grow = mk('div', 'grow');
  grow.append(mk('div', 'title', src.name), mk('div', 'meta', CAT_LABEL[src.category || 'vod']));

  const edit = mk('button', null, '✎');
  edit.title = 'Edit source'; // full-facet edit via the wizard (name, URL, category, catalog, pattern)
  edit.onclick = (e) => { e.stopPropagation(); openAddWizard(src); };

  const del = mk('button', null, '✕');
  del.title = 'Remove source';
  del.onclick = (e) => {
    e.stopPropagation();
    sources = sources.filter((s) => s !== src);
    store('sources', sources);
    renderSources();
  };

  li.append(grow, edit, del);
  li.onclick = () => {
    if (src.catalogUrl) { browseTab = 'live'; showBrowse(); }     // catalog live source -> Live tab
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
    const ul = mk('ul', 'source-list');
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
    const o = mk('option', null, s.name);
    o.value = s.url;
    if (s.url === defaultSource) o.selected = true;
    return o;
  }));
}

// Assemble a source object from wizard/test data (shared by add + edit). Auto-prefixes the URL scheme.
// A Live TV source may instead be a catalog (catalogUrl: a JSON API of live streams, no site URL).
function buildSource(data) {
  const category = data.category || 'vod';
  const prefix = (u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u);
  const src = { name: (data.name || '').trim(), category };
  if (category === 'live' && data.catalogUrl && data.catalogUrl.trim()) src.catalogUrl = prefix(data.catalogUrl.trim());
  if (data.url && data.url.trim()) src.url = prefix(data.url.trim());
  if (data.template && data.template.trim()) src.template = data.template.trim();
  return src;
}

// Add a player/source (shared by the wizard + tests).
function addSource(data) {
  const src = buildSource(data);
  sources.push(src);
  store('sources', sources);
  renderSources();
  return src;
}

// Build a source's embed-player URL for a TMDB title. `type` is 'movie' or 'tv' (anime -> tv).
// Default assumes the common /embed/{type}/{id}[/{season}/{episode}] pattern most embed players use;
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
  // template serves movie AND tv (e.g. a `/player/{id}/{season}/{episode}` layout).
  return u.replace(/([^:]\/)\/+/g, '$1').replace(/\/+(\?|#|$)/g, '$1');
}

// ponytail: self-check the empty-segment trim; fires on load, no-op if correct.
(function () {
  const ex = { url: 'https://play.example', template: 'https://play.example/player/{id}/{season}/{episode}' };
  console.assert(buildUrl(ex, 'movie', 42) === 'https://play.example/player/42', 'buildUrl movie trim');
  console.assert(buildUrl(ex, 'tv', 42, 1, 3) === 'https://play.example/player/42/1/3', 'buildUrl tv fill');
  console.assert(buildUrl({ url: 'https://ex.com' }, 'movie', 42) === 'https://ex.com/embed/movie/42', 'buildUrl default');
})();

// Sources that can play a given browse kind (with a sensible fallback to vod).
function sourcesFor(kind) {
  if (kind === 'live') return sources.filter((s) => s.category === 'live');
  const want = kind === 'anime' ? 'anime' : 'vod';
  const exact = sources.filter((s) => s.category === want);
  return exact.length ? exact : sources.filter((s) => s.category === 'vod' || s.category === 'anime');
}

// Load a source's embed player for a title/episode and remember it so the topbar can switch source.
// title/poster (from the TMDB detail page) are carried so capture uses them instead of scraping.
function openOn(src, kind, type, id, season, episode, title, poster) {
  currentSource = src.url;
  lastSourceUrl = src.url;
  store('lastSource', lastSourceUrl);
  open(buildUrl(src, type, id, season, episode)); // open()->hideAll() clears playing/intendedMedia; re-set after
  playing = { kind, type, id, season, episode, title, poster };
  intendedMedia = { title, poster, id };
  lastPlayed.playing = playing; store('lastPlayed', lastPlayed); // ⏯ Resume restores the source-switcher
  renderSourceSwitch();
  renderEpisodeSwitch();
}

// Season/episode counts for a TV show (for the topbar episode switcher + auto-play-next rollover).
// One cached TMDB call per show; specials (season 0) and empty seasons filtered out, like the detail page.
const seasonsCache = new Map(); // tmdbId -> [{ n, count }]
async function ensureSeasons(id) {
  if (seasonsCache.has(id)) return seasonsCache.get(id);
  let list = [];
  try {
    const d = await tmdbGet(`/tv/${id}`, {});
    list = (d?.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => ({ n: s.season_number, count: s.episode_count }));
  } catch {}
  seasonsCache.set(id, list);
  return list;
}

// The source the current playback should stay on when switching episodes (last-used, else first).
const playingSource = () => playing
  && (sourcesFor(playing.kind).find((s) => s.url === lastSourceUrl) || sourcesFor(playing.kind)[0]);

// Populate + show the topbar episode switcher (+ the ⏭ auto-next toggle) for a playing TV show.
// Options are S{n} E{e} per-season groups — numbers only (episode names would cost a fetch per season).
async function renderEpisodeSwitch() {
  const sel = $('ep-switch'), btn = $('autonext-btn');
  const p = playing;
  if (!p || p.type !== 'tv' || p.season == null || !p.id) { sel.hidden = true; btn.hidden = true; return; }
  const seasons = await ensureSeasons(p.id);
  if (playing !== p) return; // switched titles while the seasons fetch was in flight
  if (!seasons.length) { sel.hidden = true; btn.hidden = true; return; }
  sel.replaceChildren(...seasons.map((s) => {
    const og = document.createElement('optgroup');
    og.label = 'Season ' + s.n;
    for (let e = 1; e <= Math.min(s.count, 300); e++) {
      const o = mk('option', null, `S${s.n} E${e}`);
      o.value = s.n + ':' + e;
      og.append(o);
    }
    return og;
  }));
  sel.value = p.season + ':' + (p.episode ?? 1);
  sel.hidden = false;
  btn.classList.toggle('active', settings.autoplayNext === true);
  btn.hidden = false;
}

// Populate + show the topbar source switcher for whatever is playing (only if >1 source to switch to).
function renderSourceSwitch() {
  const sel = $('src-switch');
  const srcs = playing ? sourcesFor(playing.kind) : [];
  if (srcs.length < 2) { sel.hidden = true; return; }
  sel.replaceChildren(...srcs.map((s) => {
    const o = mk('option', null, s.name);
    o.value = s.url;
    if (s.url === lastSourceUrl) o.selected = true;
    return o;
  }));
  sel.hidden = false;
}

// Play a title on the chosen source: the detail-page selector, else last-used, else the first source.
function playOn(kind, type, id, season, episode, title, poster) {
  const srcs = sourcesFor(kind);
  if (srcs.length === 0) { alert('Add a ' + (kind === 'anime' ? 'Anime' : 'Movies/TV') + ' source first.'); return; }
  const sel = document.querySelector('.detail-source');
  const chosen = (sel && srcs.find((s) => s.url === sel.value)) // match within this kind (URLs can collide across categories)
    || srcs.find((s) => s.url === defaultSource)
    || srcs.find((s) => s.url === lastSourceUrl)
    || srcs[0];
  openOn(chosen, kind, type, id, season, episode, title, poster);
}
