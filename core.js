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
// ⏯ Resume target — persisted so Resume survives a restart. { url, live, match?, playing? }:
// live picks attach the match (Sources page restore); VOD attaches `playing` (source-switcher restore).
let lastPlayed = load('lastPlayed', null);
let openedFrom = 'browse';           // which view launched the player ('home'|'live'|'browse') — Esc returns there

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

// Shared view-state node: 'empty' (keeps the .empty class), 'loading' (CSS spinner), or 'error'.
function stateNode(kind, text) {
  return mk('div', kind === 'empty' ? 'empty' : kind, text);
}

// Skeleton loaders shaped like the layout they replace (poster cards by default) — they occupy the
// final layout's space immediately, so content arriving never shifts the page.
function skeletonCards(n, cls = 'skel-poster') {
  return Array.from({ length: n }, () => mk('div', 'skel ' + cls));
}

// Single replace-in-place toast (top-right); a new message resets the timer. No stacking — the app
// doesn't emit enough events to earn a queue.
let toastTimer = null;
function toast(text, kind) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.append(t);
  }
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.replaceChildren(document.createTextNode(text), mk('div', 'toast-bar')); // fresh bar restarts its countdown animation
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3000);
}

// prefers-reduced-motion → a live-synced body class; one CSS rule kills all animation behind it.
// (A class, not a media query in every rule, so the e2e suite can toggle it deterministically.)
(function motionPref() {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const apply = () => document.body.classList.toggle('reduced-motion', mq.matches);
  mq.addEventListener('change', apply);
  apply();
})();

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
  hideHoverPreview();                     // single choke point for view switches: drop the fixed hover preview (browse.js global)
  $('topbar').classList.remove('at-top'); // detail's scroll-blend must not linger on other views
  $('dashboard').hidden = true;
  $('home').hidden = true;
  $('browse').hidden = true;
  $('detail').hidden = true;
  $('person').hidden = true;
  $('settings').hidden = true;
  webview.hidden = true;
  window.sh?.setPlayerVisible?.(false); // player hidden -> stop the main-process progress poll
  playing = null;              // leaving the embed: forget what's playing
  intendedMedia = null;        // and forget any known title/poster; producers re-set it after open()
  currentLiveMatch = null;
  clearTimeout(captureTimer);  // cancel any pending capture so a late timer can't grab the stale (live) URL
  $('src-switch').hidden = true;
  $('ep-switch').hidden = true;
  $('autonext-btn').hidden = true;
  $('live-sources').hidden = true;
  $('sources-overlay').hidden = true;
}

// track=true records the ⏯ Resume target. The YouTube rail button opens untracked (track=false) so browsing
// to YouTube doesn't clobber the show you were watching (it navigates the webview but leaves Resume intact).
function open(url, track = true) {
  // Record the launching view for Esc-exit — but only on a fresh open; an in-player episode/source
  // switch (webview already visible) keeps the original origin.
  if (webview.hidden) {
    openedFrom = !$('dashboard').hidden ? 'dashboard'
      : !$('home').hidden ? 'home'
      : ((browseTab === 'live' && !$('browse').hidden) || currentLiveMatch) ? 'live' : 'browse';
  }
  hideAll();
  setActiveRail(null);
  webview.hidden = false;
  window.sh?.setPlayerVisible?.(true); // player shown -> (re)arm the main-process progress poll
  webview.src = url;
  autoAdvanced = false; // each opened episode may auto-advance once
  if (track) {
    lastPlayed = { url, live: false };  // a generic watch; live picks / openOn enrich right after open()
    store('lastPlayed', lastPlayed);
    $('resume-btn').hidden = false;     // something is now resumable
  }
}

// ⏯ Resume: go back to the last-watched page. Reveal it when the webview still holds it (instant, keeps the
// live stream / VOD position); reload it when the webview moved on (YouTube tab) or after a restart.
// Restores the live Sources UI or the VOD source-switcher for whatever was playing.
function resumeLast() {
  if (!lastPlayed || !lastPlayed.url) return; // nothing watched yet
  const lp = lastPlayed;
  hideAll();
  setActiveRail(null);
  webview.hidden = false;
  window.sh?.setPlayerVisible?.(true); // player shown again -> re-arm the main-process progress poll
  if (webview.getAttribute('src') !== lp.url) webview.src = lp.url; // reveal if loaded, reload if moved on
  if (lp.live && lp.match) {
    currentLiveMatch = lp.match;
    intendedMedia = { title: lp.match.title, poster: lp.match.logo, live: true };
    $('live-sources').hidden = false; $('sources-overlay').hidden = false;
  } else if (lp.playing) {
    playing = lp.playing;
    intendedMedia = { title: lp.playing.title, poster: lp.playing.poster, id: lp.playing.id };
    renderSourceSwitch();
    renderEpisodeSwitch();
  }
}

function showDashboard() {
  hideAll();
  setActiveRail('dash-btn');
  $('dashboard').hidden = false;
  renderDashboard();
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
