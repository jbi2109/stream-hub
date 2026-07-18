// Landing dashboard: a cinematic hero (your resume item > trending) over a configurable set of
// horizontal rails, built from the existing card builders so click behavior, resume state, and
// keyboard focus all come for free. Rails come from a registry (DASH_RAILS); settings.dashRails picks
// which show and in what order. Empty rails hide; a fresh profile (no TMDB key AND no sources) gets the
// onboarding card instead. The Live-now rail reads ONLY the catalog cache — it never fetches (visiting
// the Live TV tab warms the cache); a cold cache shows a hint.

const DASH_RAIL_MAX = 15;

// Movie-only genre rails (default off).
// ponytail: movie-only genre rails avoid the movie/TV genre-id split; add TV genre rails only if asked.
const DASH_GENRES = [['28', 'Action'], ['35', 'Comedy'], ['27', 'Horror'], ['10749', 'Romance'], ['878', 'Sci-Fi & Fantasy'], ['16', 'Animation']];

const seeAllMovies = () => { browseTab = 'movie'; showBrowse(); };
const seeAllLive = () => { browseTab = 'live'; showBrowse(); };

// Rail registry. Descriptor: { id, title, seeAll, skel, skelN, special?, build:async()=>Node[] } where
// build returns the card nodes. The 'live' special branch in fillRail bypasses build (cache-only).
const DASH_RAILS = [
  { id: 'continue', title: 'Continue Watching', seeAll: showHome, skel: 'skel-wide', skelN: 5, special: 'continue',
    build: async () => cont.slice(0, DASH_RAIL_MAX).map(resumeCard) },
  { id: 'trending', title: 'Trending', seeAll: seeAllMovies, skel: 'skel-poster', skelN: 6,
    build: async () => (await discoverRail('trending')).map((r) => posterCard('movie', r)) },
  { id: 'top10', title: 'Top 10 Today', seeAll: seeAllMovies, skel: 'skel-poster', skelN: 10,
    build: async () => (await discoverRail('trending')).slice(0, 10).map((r, i) => posterCard('movie', r, i + 1)) }, // R2: rank badge (i+1 => 01..10)
  { id: 'live', title: 'Live now', seeAll: seeAllLive, skel: 'skel-wide', skelN: 4, special: 'live',
    build: async () => [] }, // unused — fillRail's live branch is cache-only
  { id: 'toprated', title: 'Top Rated', seeAll: seeAllMovies, skel: 'skel-poster', skelN: 6,
    build: async () => (await discoverRail('toprated')).map((r) => posterCard('movie', r)) },
  { id: 'newest', title: 'Newest', seeAll: seeAllMovies, skel: 'skel-poster', skelN: 6,
    build: async () => (await discoverRail('newest')).map((r) => posterCard('movie', r)) },
  { id: 'upcoming', title: 'Upcoming', seeAll: seeAllMovies, skel: 'skel-poster', skelN: 6,
    build: async () => (await discoverRail('upcoming')).map((r) => posterCard('movie', r)) },
  ...DASH_GENRES.map(([gid, name]) => ({
    id: 'genre:' + gid, title: name, seeAll: seeAllMovies, skel: 'skel-poster', skelN: 6,
    build: async () => (await discoverRail('genre:' + gid)).map((r) => posterCard('movie', r)),
  })),
];
const RAIL_BY_ID = Object.fromEntries(DASH_RAILS.map((r) => [r.id, r]));
// Default membership + order. Mirrored into SETTINGS_DEFAULTS.dashRails (settings.js loads after this
// file, so the literal lives here and settings references it — not the other way around).
const DEFAULT_DASH_RAILS = ['continue', 'trending', 'top10', 'live'];
const enabledRails = () => (settings.dashRails || DEFAULT_DASH_RAILS).map((id) => RAIL_BY_ID[id]).filter(Boolean);

// One rail SHELL: title + "See all →" + a horizontal scroller of skeletons. Always returned (fillRail
// swaps in real cards or removes the section), so R3's lazy observer always has a target.
function railShell(title, seeAll, skel, skelN) {
  const sec = mk('div', 'dash-section');
  const head = mk('div', 'dash-head');
  head.append(mk('h2', null, title));
  const link = mk('button', 'dash-seeall', 'See all →');
  link.onclick = seeAll;
  head.append(link);
  const rail = mk('div', 'rail anim-in');
  rail.append(...skeletonCards(skelN, skel));
  // chevron scroll buttons (siblings of the rail; CSS absolute-positions them over its edges so they
  // never shift the rail layout). Reduced-motion → instant scroll. NAV_SEL doesn't match <button>, so
  // keyboard grid nav skips them.
  const chevL = mk('button', 'rail-chev prev'); chevL.append(icon('chevron-l'));
  const chevR = mk('button', 'rail-chev next'); chevR.append(icon('chevron-r'));
  const scrollBy = (dir) => rail.scrollBy({ left: dir * rail.clientWidth * 0.8, behavior: document.body.classList.contains('reduced-motion') ? 'auto' : 'smooth' });
  chevL.onclick = () => scrollBy(-1); chevR.onclick = () => scrollBy(1);
  // edge fades hint at scrollability (mask toggled by can-scroll state). Reading scrollLeft/clientWidth/
  // scrollWidth forces layout; scroll + ResizeObserver can fire many times a frame, so coalesce to one
  // rAF. State is per-rail (this closure) so two rails scrolling the same frame each recompute. The same
  // reads also toggle the chevrons' disabled state at the scroll ends.
  let fadePending = false;
  const fades = () => {
    if (fadePending) return;
    fadePending = true;
    requestAnimationFrame(() => {
      fadePending = false;
      rail.classList.toggle('fade-l', rail.scrollLeft > 8);
      rail.classList.toggle('fade-r', rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 8);
      chevL.disabled = rail.scrollLeft <= 8;
      chevR.disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 8;
    });
  };
  rail.onscroll = fades;
  // ResizeObserver (not a one-shot rAF): fires once layout actually settles — however late the rail
  // attaches or images shift it — and again on window resizes, so the fade state can't go stale.
  new ResizeObserver(fades).observe(rail);
  sec.append(head, rail, chevL, chevR);
  return sec;
}

// ---------- Continue Watching resume cards (16:9; the Library grid keeps the 2:3 poster card) ----------

function relTime(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000), h = Math.round(m / 60), d = Math.round(h / 24);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  if (d < 8) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtPos(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? [h, String(m).padStart(2, '0')] : [m]).concat(String(s).padStart(2, '0')).join(':');
}

// Wraps the library card (keeping ALL of its click/actions/source behavior) into a 16:9 backdrop
// card: timestamp/Completed chip + relative-time sub-line, with the backdrop fetched on render via
// the session-cached tmdbMeta (the stored poster paints first; entries with no TMDB id keep it).
function resumeCard(item) {
  const el = card(item, true);
  el.classList.add('resume-card');
  const wrap = el.querySelector('.poster-wrap');
  const done = item.duration && item.position >= item.duration * 0.95;
  if (done || item.position) {
    wrap.append(mk('span', 'resume-chip' + (done ? ' done' : ''), done ? 'Completed' : fmtPos(item.position)));
  }
  const when = relTime(item.updatedAt);
  if (when && !item.note) el.querySelector('.card-sub').textContent = when;
  const id = tmdbIdOf(item.url);
  if (id) {
    // defer to idle so N cards don't fire N fetches during the dashboard paint; card[0] hits the
    // seeded cache (no fetch), cards 1..N resolve when the main thread is free.
    requestIdleCallback(() => {
      tmdbMeta(id, typeOf(item)).then((m) => {
        if (!m || !m.backdrop || !wrap.isConnected) return;
        let im = wrap.querySelector('img');
        if (!im) { // entries captured without a poster still get backdrop art
          im = document.createElement('img');
          im.className = 'poster';
          im.loading = 'lazy';
          im.onerror = () => { im.style.display = 'none'; }; // no broken-image glyph if the art 404s
          wrap.prepend(im);
          wrap.classList.remove('noposter');
        }
        im.src = m.backdrop;
      });
    });
  }
  return el;
}

// ---------- hero (resume > trending) ----------

// Auto-advance interval for the rotating hero. Module-scope so renderDashboard can clear it at the top
// of every re-render (otherwise intervals stack and fire on detached slide nodes).
let heroTimer = null;
// Lazy-fill observer for discover-backed rails below the fold. Module-scope so every re-render can
// disconnect the prior one (observers leak otherwise) before building a fresh one.
let railObserver = null;

function heroContent(kind, d, resume) {
  const inner = mk('div', 'hero-inner');
  const bg = mk('div', 'hero-bg');
  if (d.backdrop_path) {
    const img = document.createElement('img');
    img.src = IMG(d.backdrop_path, 'w1280');
    img.alt = '';
    img.onerror = () => { img.style.display = 'none'; }; // hide, don't remove — the gradient bg covers
    bg.append(img);
  }
  const body = mk('div', 'hero-body');
  const title = d.title || d.name || '';
  const logo = (d.images?.logos || []).find((l) => l.iso_639_1 === 'en') || (d.images?.logos || [])[0];
  if (logo && logo.file_path) {
    const li = document.createElement('img');
    li.className = 'hero-logo';
    li.src = IMG(logo.file_path, 'w500');
    li.alt = title;
    li.onerror = () => { li.classList.add('dead'); li.style.display = 'none'; }; // .hero-title reappears (CSS)
    body.append(li);
  }
  body.append(mk('h1', 'hero-title', title));

  const bits = [];
  const year = (d.release_date || d.first_air_date || '').slice(0, 4);
  if (year) bits.push(year);
  if (d.vote_average) bits.push(`★ ${d.vote_average.toFixed(1)}`);
  if (resume) {
    if (resume.season != null && resume.episode != null) bits.push(`S${resume.season} E${resume.episode}`);
    if (resume.duration && resume.position) bits.push(`${Math.max(1, Math.round((resume.duration - resume.position) / 60))} min left`);
  }
  if (bits.length) body.append(mk('div', 'hero-meta', bits.join('  ·  ')));

  const cta = mk('div', 'hero-cta');
  if (resume) {
    const play = mk('button', 'hero-btn primary', '▶ Resume');
    play.onclick = () => openLibraryItem(resume); // exact same path as clicking the Continue card
    cta.append(play);
  }
  const details = mk('button', 'hero-btn', 'View details');
  details.onclick = () => showDetail(kind, d.id);
  cta.append(details);
  body.append(cta);

  inner.append(bg, body);
  return inner;
}

// Fill the hero placeholder with a rotating carousel (up to 5 slides). Slide 0 is the most recent
// Continue item (resume slide, WITH logo art via the one shared detail fetch + a ▶ Resume CTA), else
// trending #1. Slides 1..4 come from trending discover rows (no per-slide fetch, no logo, no CTA).
// Slide 0 stays FIRST in DOM + .active so the pinned hero tests resolve to it. Auto-advances every 7s
// (paused on hover, off under reduced-motion). If slide 0 is unusable the hero disappears (empty-rail
// contract). heroTimer is cleared at the top of renderDashboard so re-renders don't stack intervals.
async function fillHeroCarousel(heroSec, heroFetch) {
  const slides = []; // { kind, d, resume }
  let trendingRows = [];
  try { trendingRows = await discoverRail('trending'); } catch {}
  try {
    const c = cont[0];
    const cid = c && typeOf(c) !== 'live' && tmdbIdOf(c.url);
    if (cid) {
      const kind = typeOf(c) === 'movie' ? 'movie' : 'tv';
      // reuse the single detail fetch renderDashboard already started (hero + resume-card[0] share it)
      let d = heroFetch ? await heroFetch : await tmdbGet(`/${kind}/${cid}`, { append_to_response: 'images', include_image_language: 'en,null' });
      if (d && !d.id) d.id = cid;
      slides.push({ kind, d, resume: c });
      for (const row of trendingRows.slice(0, 4)) slides.push({ kind: 'movie', d: row, resume: null });
    } else {
      for (const row of trendingRows.slice(0, 5)) slides.push({ kind: 'movie', d: row, resume: null });
    }
  } catch {}
  if (!heroSec.isConnected) return; // dashboard re-rendered / navigated away
  const s0 = slides[0];
  if (!s0 || !s0.d || s0.d.error || (!s0.d.title && !s0.d.name)) { heroSec.remove(); return; }

  const carousel = mk('div', 'hero-carousel');
  const slidesEl = mk('div', 'hero-slides');
  const inners = slides.map((s) => heroContent(s.kind, s.d, s.resume));
  inners.forEach((el, i) => { if (i === 0) el.classList.add('active'); slidesEl.append(el); });
  carousel.append(slidesEl);

  let activeIdx = 0, dots = [];
  const heroGoto = (i) => {
    activeIdx = i;
    inners.forEach((el, j) => el.classList.toggle('active', j === i));
    dots.forEach((dot, j) => dot.classList.toggle('on', j === i));
  };

  if (slides.length > 1) {
    const prev = mk('button', 'hero-arrow prev'); prev.append(icon('chevron-l'));
    prev.onclick = () => heroGoto((activeIdx - 1 + slides.length) % slides.length);
    const next = mk('button', 'hero-arrow next'); next.append(icon('chevron-r'));
    next.onclick = () => heroGoto((activeIdx + 1) % slides.length);
    const dotsEl = mk('div', 'hero-dots');
    dots = slides.map((_, i) => {
      const dot = mk('button', 'hero-dot' + (i === 0 ? ' on' : ''));
      dot.onclick = () => heroGoto(i);
      dotsEl.append(dot);
      return dot;
    });
    carousel.append(prev, next, dotsEl);
  }

  heroSec.replaceChildren(carousel);

  const canAuto = () => slides.length > 1 && !document.body.classList.contains('reduced-motion');
  const start = () => {
    if (!canAuto()) return;
    clearInterval(heroTimer);
    heroTimer = setInterval(() => {
      if (!slidesEl.isConnected) { clearInterval(heroTimer); return; }
      heroGoto((activeIdx + 1) % slides.length);
    }, 7000);
  };
  if (canAuto()) {
    start();
    heroSec.onmouseenter = () => clearInterval(heroTimer);
    heroSec.onmouseleave = start;
  }
}

// ---------- data helpers ----------

// Live-now matches assembled from fresh cached catalog rows (most watched first). Never fetches.
function cachedLiveNow() {
  const now = Date.now();
  const rows = [];
  for (const c of liveCatalogCache.values()) {
    if (!c.error && c.rows && now - c.at < LIVE_CACHE_TTL) rows.push(...c.rows);
  }
  return groupMatches(rows)
    .filter((m) => !m.startsAt || m.startsAt <= now + 60000) // same live-now rule as the Live tab
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

// Synthetic shelves = TMDB /discover slices (the app has no /trending path). Each rail id maps to a
// discover query; results are cached per id for RAIL_TTL so re-entering the dashboard doesn't refetch.
const railCache = new Map();  // id -> { at, results }
const RAIL_TTL = 300000;      // 5 min
const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
function railQuery(id) {
  if (id.startsWith('genre:')) return { path: '/discover/movie', query: { with_genres: id.slice(6), sort_by: 'popularity.desc' } };
  return ({
    trending: { path: '/discover/movie', query: { sort_by: 'popularity.desc' } },
    toprated: { path: '/discover/movie', query: { sort_by: 'vote_average.desc', 'vote_count.gte': 200 } },
    newest:   { path: '/discover/movie', query: { sort_by: 'primary_release_date.desc', 'vote_count.gte': 10, 'primary_release_date.lte': today() } },
    upcoming: { path: '/discover/movie', query: { sort_by: 'primary_release_date.asc', 'primary_release_date.gte': today() } },
  })[id];
}
async function discoverRail(id) {
  const key = id === 'top10' ? 'trending' : id; // top10 shares trending's data
  const hit = railCache.get(key);
  if (hit && Date.now() - hit.at < RAIL_TTL) return hit.results;
  const q = railQuery(key);
  const d = q ? await tmdbGet(q.path, q.query) : null;
  const results = ((d && d.results) || []).filter((r) => r.poster_path || r.title || r.name).slice(0, DASH_RAIL_MAX);
  railCache.set(key, { at: Date.now(), results }); capMap(railCache, 24);
  return results;
}

// First-run setup card — the one place that checks BOTH missing pieces. Gated on emptiness (no
// dismiss flag): it disappears as soon as a key or a source exists.
function onboardingCard() {
  const cardEl = mk('div', 'onboard-card');
  cardEl.append(mk('h2', null, 'Welcome to Stream Hub'));
  cardEl.append(mk('div', 'set-hint', 'Two quick steps and this becomes your media library:'));

  const s1 = mk('div', 'onboard-step');
  s1.append(mk('span', 'onboard-num', '1'), mk('span', null, 'Add a free TMDB API key to power Browse.'));
  const get = mk('a', 'about-link', 'Get a key');
  get.href = 'https://www.themoviedb.org/settings/api';
  get.target = '_blank';
  const paste = mk('button', 'set-btn', 'Paste it in Settings');
  paste.onclick = () => { showSettings(); showSettingsTab('general'); };
  s1.append(get, paste);

  const s2 = mk('div', 'onboard-step');
  s2.append(mk('span', 'onboard-num', '2'), mk('span', null, 'Add the player or site you watch on.'));
  const add = mk('button', 'set-btn', '+ Add player / source');
  add.id = 'onboard-add';
  add.onclick = () => openAddWizard();
  s2.append(add);

  cardEl.append(s1, s2);
  return cardEl;
}

// Generic rail fill: swap the skeletons for the descriptor's cards, or remove the section if it's empty.
// The 'live' rail is bespoke — cache-only (NEVER fetches); a cold cache with a live catalog shows a hint.
async function fillRail(sec, r) {
  const rail = sec.querySelector('.rail');
  if (r.special === 'live') {
    const items = cachedLiveNow().slice(0, DASH_RAIL_MAX).map(matchCard);
    if (items.length) rail.replaceChildren(...items);
    else if (sources.some((s) => s.category === 'live' && s.catalogUrl)) {
      // cold cache: point at the Live tab (which fetches + warms the cache) instead of fetching here
      const hint = mk('button', 'set-btn dash-live-hint', 'Open Live TV to load matches');
      hint.onclick = () => { browseTab = 'live'; showBrowse(); };
      rail.replaceChildren(hint);
    } else sec.remove();
    return;
  }
  let nodes = [];
  try { nodes = await r.build(); } catch {}
  if (!sec.isConnected) return; // dashboard re-rendered / navigated away while building
  if (!nodes.length) { sec.remove(); return; }
  rail.replaceChildren(...nodes);
  rail.dispatchEvent(new Event('scroll')); // recompute the edge fades for the new width
}

async function renderDashboard() {
  clearInterval(heroTimer); heroTimer = null; // idempotent: kill any prior carousel timer before re-render
  railObserver?.disconnect();                 // and any prior lazy-fill observer (a fresh one is built below)
  const el = $('dashboard');
  if (!tmdbKey && !sources.length) { el.replaceChildren(onboardingCard()); return; }

  // hero placeholder (reserved-height skeleton) — filled or removed by fillHero
  let heroSec = null;
  if (tmdbKey) {
    heroSec = mk('div', 'dash-hero');
    heroSec.append(mk('div', 'skel skel-hero'));
  }

  // Single-fetch: the hero and resume-card[0] are the same show, so start ONE detail fetch and seed
  // the meta cache with its mapped result BEFORE the Continue rail builds. card[0]'s idle tmdbMeta then
  // hits the seeded entry (no second fetch), and fillHero reuses the raw detail. Seed with the same
  // delete-on-null/reject rule tmdbMeta uses, so a bad/failed payload can't poison the session. Seed
  // BEFORE the fill loop so the Continue rail's resumeCard[0] (built in fillRail) hits the seeded entry.
  let heroFetch = null;
  const c0 = cont[0], cid0 = c0 && typeOf(c0) !== 'live' && tmdbIdOf(c0.url);
  if (tmdbKey && cid0) {
    const k0 = typeOf(c0) === 'movie' ? 'movie' : 'tv';
    heroFetch = tmdbGet(`/${k0}/${cid0}`, { append_to_response: 'images', include_image_language: 'en,null' });
    const seeded = heroFetch.then((d) => (d && (d.title || d.name))
      ? { title: d.title || d.name, poster: IMG(d.poster_path, 'w342'), backdrop: IMG(d.backdrop_path, 'w780') } : null);
    seeded.then((v) => { if (!v) tmdbMetaCache.delete(k0 + ':' + cid0); }, () => tmdbMetaCache.delete(k0 + ':' + cid0));
    tmdbMetaCache.set(k0 + ':' + cid0, seeded);
  }

  // Build every enabled rail's shell (skeletons now, real cards on fill). _rail is stashed so R3's lazy
  // observer can fill on demand; R1 fills them all eagerly below. Empties remove themselves in fillRail.
  const sections = [];
  for (const r of enabledRails()) {
    const sec = railShell(r.title, r.seeAll, r.skel, r.skelN);
    sec._rail = r;
    sections.push(sec);
  }

  const nodes = heroSec ? [heroSec, ...sections] : [...sections];
  if (!nodes.length) nodes.push(emptyMsg('Nothing here yet — watch something and it shows up, or add a TMDB API key in Settings to see Trending.'));
  el.replaceChildren(...nodes);

  if (heroSec) fillHeroCarousel(heroSec, heroFetch);

  // Lazy-fill discover-backed rails below the fold on scroll, but fill the first 2 rails + all special
  // rails (continue/live — local/cache, no fetch) immediately: T49 asserts the Live match-cards and the
  // Trending cards (rail index 1) render with no scroll. root MUST be #dashboard (it's the scroller).
  railObserver = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) { railObserver.unobserve(e.target); fillRail(e.target, e.target._rail); }
  }, { root: $('dashboard'), rootMargin: '400px' });
  const EAGER = 2;
  sections.forEach((sec, i) => {
    if (i < EAGER || sec._rail.special) fillRail(sec, sec._rail); // first 2 + all special fill now
    else railObserver.observe(sec);                               // discover-backed below-fold rails: on scroll
  });
}
