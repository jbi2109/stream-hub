// Library: the Continue Watching / Watch Later grid (poster cards + tabs).

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
  el.onclick = (e) => {
    if (e.target.closest('.card-actions')) return; // a click on the ✕ / category dropdown must never open the show
    activeKey = item.key;
    open(item.url);
    intendedMedia = { title: item.title, poster: item.poster, live: item.type === 'live' || undefined };
  };
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
