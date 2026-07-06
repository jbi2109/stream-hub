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
let currentLiveMatch = null;         // the live match being watched (for the topbar "Sources" reopen)
let lastLiveMatch = null;            // last live match watched (kept across leave, for the ⏯ Resume button)
let lastPlayedLive = false;          // was the last open() a live stream? (Resume restores the Sources UI)
let lastPlayedUrl = null;            // the ⏯ Resume target url (survives the webview navigating elsewhere)

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
  // Live TV and YouTube never belong in Continue Watching (clears entries leaked before the capture fix).
  cont = cont.filter((c) => {
    if (isLiveUrl(c.url)) return false;
    try { if (/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(new URL(c.url).host)) return false; } catch {}
    return true;
  });
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

// Highlight the rail button for the active view (null clears all — e.g. while watching an embed).
function setActiveRail(id) {
  for (const b of document.querySelectorAll('#rail .rail-btn')) b.classList.toggle('active', b.id === id);
}

function hideAll() {
  $('home').hidden = true;
  $('browse').hidden = true;
  $('detail').hidden = true;
  $('settings').hidden = true;
  webview.hidden = true;
  playing = null;              // leaving the embed: forget what's playing
  intendedMedia = null;        // and forget any known title/poster; producers re-set it after open()
  currentLiveMatch = null;
  clearTimeout(captureTimer);  // cancel any pending capture so a late timer can't grab the stale (live) URL
  $('src-switch').hidden = true;
  $('live-sources').hidden = true;
  $('sources-overlay').hidden = true;
}

// track=true records the ⏯ Resume target. The YouTube rail button opens untracked (track=false) so browsing
// to YouTube doesn't clobber the show you were watching (it navigates the webview but leaves Resume intact).
function open(url, track = true) {
  hideAll();
  setActiveRail(null);
  webview.hidden = false;
  webview.src = url;
  if (track) {
    lastPlayedUrl = url;
    lastPlayedLive = false; lastLiveMatch = null; // a generic (non-live) watch; live enriches after open()
    $('resume-btn').hidden = false;               // something is now resumable
  }
}

// ⏯ Resume: go back to the last-watched page. Reveal it when the webview still holds it (instant, keeps the
// live stream / VOD position); reload it when the webview moved on (e.g. the YouTube tab). Restores the live
// Sources UI if the last watch was live. // ponytail: reveal when still loaded, reload when moved on.
function resumeLast() {
  if (!lastPlayedUrl) return;           // nothing watched this session
  const wasLive = lastPlayedLive, m = lastLiveMatch;
  hideAll();
  setActiveRail(null);
  webview.hidden = false;
  if (webview.getAttribute('src') !== lastPlayedUrl) webview.src = lastPlayedUrl;
  if (wasLive && m) { currentLiveMatch = m; $('live-sources').hidden = false; $('sources-overlay').hidden = false; }
}

function showHome() {
  hideAll();
  setActiveRail('home-btn');
  $('home').hidden = false;
  renderHome();
}

function showBrowse() {
  hideAll();
  setActiveRail(browseTab === 'live' ? 'live-btn' : 'browse-btn');
  $('browse').hidden = false;
  renderBrowse();
}

function showSettings() {
  hideAll();
  setActiveRail('settings-btn');
  $('settings').hidden = false;
}
