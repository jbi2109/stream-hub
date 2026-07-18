// Library: the Continue Watching / Watch Later grid (poster cards + tabs).

function seLabel(item) {
  if (item.season != null && item.episode != null) return `S${item.season} E${item.episode}`;
  return '';
}

// The dashboard's Continue rail reuses these cards, so a mutation (✕ / category / note) must refresh
// whichever of the two card views is showing — renderHome alone would leave a visible rail stale.
function refreshCards() {
  renderHome();
  if (!$('dashboard').hidden) renderDashboard();
}

function card(item, isCont) {
  const el = document.createElement('div');
  el.className = 'card';
  el.tabIndex = 0;
  el.dataset.key = item.key;

  const wrap = document.createElement('div');
  wrap.className = 'poster-wrap';
  if (item.poster) {
    const img = document.createElement('img');
    img.className = 'poster';
    img.loading = 'lazy';
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
    refreshCards();
  };
  actions.append(typeSel);

  if (isCont) {
    const editBtn = document.createElement('button');
    editBtn.append(icon('edit'));
    editBtn.title = 'Edit note';
    editBtn.onclick = (e) => { e.stopPropagation(); editNote(item, sub); };
    actions.append(editBtn);
  }
  const del = document.createElement('button');
  del.append(icon('close'));
  del.title = 'Remove';
  del.onclick = (e) => {
    e.stopPropagation();
    if (isCont) { cont = cont.filter((c) => c.key !== item.key); store('continue', cont); }
    else { later = later.filter((c) => c.key !== item.key); store('watchlater', later); }
    refreshCards();
  };
  actions.append(del);
  wrap.append(actions);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = item.title;

  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = isCont ? (item.note || se || 'Watching') : (se || 'Movie');

  el.append(wrap, title, sourceControl(item, isCont), sub);
  el.onclick = (e) => {
    // clicks on a control (✕ / category dropdown / source dropdown) must never open the show
    if (e.target.closest('.card-actions') || e.target.closest('.card-source')) return;
    openLibraryItem(item);
  };
  return el;
}

// Open a library entry exactly as a card click does — also used by the dashboard hero's Resume CTA.
function openLibraryItem(item) {
  if (!/^https?:/i.test(item.url || '')) return; // placeholder entries (saved with no source) can't open
  activeKey = item.key;
  open(item.url);
  intendedMedia = { title: item.title, poster: item.poster, live: item.type === 'live' || undefined };
  // Rebuildable entries also set `playing` so the topbar episode/source switchers + auto-play-next
  // work when continuing from the library — not just from the detail page's Watch.
  const id = tmdbIdOf(item.url);
  const t = typeOf(item);
  if (id && t !== 'live') {
    const src = sources.find((s) => hostOf(s.url) === hostOf(item.url));
    if (src) { currentSource = src.url; lastSourceUrl = src.url; store('lastSource', lastSourceUrl); } // stay on the card's player
    playing = { kind: t === 'movie' ? 'movie' : 'tv', type: t === 'movie' ? 'movie' : 'tv', id,
      season: item.season, episode: item.episode, title: item.title, poster: item.poster };
    lastPlayed.playing = playing; store('lastPlayed', lastPlayed);
    renderSourceSwitch();
    renderEpisodeSwitch();
  }
}

// Per-card source control: a dropdown to switch (and persist) which source this show continues on,
// or a read-only "source" label when it can't be rebuilt (live entries, or no TMDB id in the URL).
function sourceControl(item, isCont) {
  const id = tmdbIdOf(item.url);
  const kind = item.type === 'live' ? 'live' : item.type === 'movie' ? 'movie' : 'tv';
  const srcs = sourcesFor(kind);
  const curSrc = sources.find((s) => hostOf(s.url) === hostOf(item.url));
  if (item.type !== 'live' && id && srcs.length) {
    const sel = document.createElement('select');
    sel.className = 'card-source';
    sel.title = 'Continue on which source';
    sel.onclick = (e) => e.stopPropagation();
    if (!curSrc) { // saved source no longer in the list — keep its host visible as the current value
      const o = document.createElement('option'); o.textContent = hostOf(item.url) || 'source'; o.selected = true; o.disabled = true; sel.append(o);
    }
    for (const s of srcs) {
      const o = document.createElement('option'); o.value = s.url; o.textContent = s.name;
      if (curSrc && s.url === curSrc.url) o.selected = true;
      sel.append(o);
    }
    sel.onchange = (e) => {
      e.stopPropagation();
      const src = srcs.find((s) => s.url === sel.value);
      if (!src) return;
      item.url = buildUrl(src, item.type === 'movie' ? 'movie' : 'tv', id, item.season, item.episode);
      store(isCont ? 'continue' : 'watchlater', isCont ? cont : later); // persist; next click continues here
    };
    return sel;
  }
  const lbl = document.createElement('div');
  lbl.className = 'card-source-label';
  lbl.textContent = curSrc ? curSrc.name : (hostOf(item.url) || '');
  return lbl;
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
    refreshCards();
  };
  sub.replaceWith(input);
  input.focus();
}

let topTab = 'continue'; // 'continue' | 'later'
let subTab = 'all';      // 'all' | 'movie' | 'tv'

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
    nodes.push(emptyMsg(isCont
      ? 'Play something — it shows up here automatically.'
      : 'Hit “+ Watch Later” on a show or movie to save it here.'));
  } else {
    const grid = document.createElement('div');
    grid.className = 'grid anim-in';
    grid.append(...list.map((item) => card(item, isCont)));
    nodes.push(grid);
  }
  $('home').replaceChildren(...nodes);
}

// One-time heal: re-title/re-poster old library entries from TMDB (using the id in each URL), fixing
// junk captured before id-first titling. No-op once done, or until a TMDB key is set. Live entries and
// entries with no resolvable id are left as-is (the user removes them; watching heals the rest).
async function healLibrary() {
  if (localStorage.getItem('libraryHealed') || !tmdbKey) return;
  // One-time heal — fire the TMDB lookups in parallel (was serial per entry). Duplicate ids firing
  // duplicate fetches is acceptable here (runs once). Spread preserves object identity, so the mutations
  // below land on the real cont/later entries.
  const items = [...cont, ...later].filter((i) => i.type !== 'live');
  const metas = await Promise.all(items.map((i) => tmdbMeta(tmdbIdOf(i.url), i.type || mediaType(i.url, i.season))));
  let changed = false;
  items.forEach((item, idx) => { const m = metas[idx]; if (m) { item.title = m.title; if (m.poster) item.poster = m.poster; changed = true; } });
  if (changed) { store('continue', cont); store('watchlater', later); if (!$('home').hidden) renderHome(); }
  localStorage.setItem('libraryHealed', '1');
}
