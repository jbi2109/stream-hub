// Core: DOM helpers, storage, shared state, and view switching.
// Plain classic script — every renderer file shares this global scope (no modules;
// the e2e suite drives functions like addSource/buildUrl/showUpdate as globals).

const $ = (id) => document.getElementById(id);
const webview = $('webview');

// Small DOM builder: cuts the createElement/className/textContent triplet.
// Named `mk` (not `el`) so it doesn't shadow the `const el = …` root-node idiom used elsewhere.
const mk = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const load = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
const store = (key, val) => localStorage.setItem(key, JSON.stringify(val));

// category: 'vod' = Movies/TV Shows, 'live' = Live TV (not tracked in Continue Watching)
// Sources are user-supplied — add your own with the "+ Add source" form.
let sources = load('sources', []);
let cont = load('continue', []);     // auto-tracked, keyed, sorted by updatedAt desc
let later = load('watchlater', []);  // button-added, deduped by key
let tmdbKey = load('tmdbKey', '');   // user's free TMDB API key (for Browse)
let currentSource = null;            // home URL for the topbar home button
let activeKey = null;                // continue entry the player position attaches to
let playing = null;                  // {kind,type,id,season,episode} of the open embed (for source switching)
let intendedMedia = null;            // {title,poster,id?} known title/poster for the next capture — set by any
                                     // play path that already knows them (detail Watch, live tile, card reopen),
                                     // so capture/Watch-Later never depend on a provider's embed-page og:title
let lastSourceUrl = load('lastSource', null); // last source the user watched on
let defaultSource = load('defaultSource', null); // preferred player URL for Movies/TV/Anime

const CAT_LABEL = { vod: 'Movies / TV', anime: 'Anime', live: 'Live TV' };

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const sourceCategory = (url) => sources.find((s) => hostOf(s.url) === hostOf(url))?.category;
const isLiveUrl = (url) => sourceCategory(url) === 'live';

// --- one-time migration: give old sources a category, purge live entries from Continue ---
(function migrate() {
  let changed = false;
  sources = sources.map((s) => {
    if (s.category) return s;
    changed = true;
    return { ...s, category: 'vod' }; // default; user can flip a source to Live TV
  });
  if (changed) store('sources', sources);
  const before = cont.length;
  cont = cont.filter((c) => !isLiveUrl(c.url)); // Live TV never belongs in Continue Watching
  if (cont.length !== before) store('continue', cont);
})();

function emptyMsg(text) {
  return mk('div', 'empty', text);
}

function tabBar(tabs, current, onPick, cls) {
  const bar = mk('div', cls);
  for (const [id, label] of tabs) {
    const btn = mk('button', 'tab' + (id === current ? ' active' : ''), label);
    btn.dataset.tab = id;
    btn.onclick = () => onPick(id); // onPick is responsible for re-rendering
    bar.append(btn);
  }
  return bar;
}

// ---------- views ----------

function hideAll() {
  $('home').hidden = true;
  $('browse').hidden = true;
  $('detail').hidden = true;
  webview.hidden = true;
  playing = null;              // leaving the embed: forget what's playing
  intendedMedia = null;        // and forget any known title/poster; producers re-set it after open()
  $('src-switch').hidden = true;
}

function open(url) {
  hideAll();
  webview.hidden = false;
  webview.src = url;
}

function showHome() {
  hideAll();
  $('home').hidden = false;
  renderHome();
}

function showBrowse() {
  hideAll();
  $('browse').hidden = false;
  renderBrowse();
}
