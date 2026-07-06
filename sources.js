// Sources: the Settings list (add/edit/remove/default) + play-URL building and routing.

function sourceItem(src) {
  const li = mk('li');
  const grow = mk('div', 'grow');
  grow.append(mk('div', 'title', src.name), mk('div', 'meta', CAT_LABEL[src.category || 'vod']));

  const edit = mk('button', null, '✎');
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

// Add a player/source (shared by the wizard + tests). Auto-prefixes the URL scheme.
// A Live TV source may instead be a catalog (catalogUrl: a JSON API of live streams, no site URL).
function addSource({ name, url, category, template, catalogUrl }) {
  category = category || 'vod';
  const src = { name: (name || '').trim(), category };
  const prefix = (u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u);
  if (category === 'live' && catalogUrl && catalogUrl.trim()) src.catalogUrl = prefix(catalogUrl.trim());
  if (url && url.trim()) src.url = prefix(url.trim());
  if (template && template.trim()) src.template = template.trim();
  sources.push(src);
  store('sources', sources);
  renderSources();
  return src;
}

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
    const o = mk('option', null, s.name);
    o.value = s.url;
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
