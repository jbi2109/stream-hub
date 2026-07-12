// Landing dashboard: a cinematic hero (your resume item > trending) over horizontal rails of
// Continue Watching / Trending / Live now, built from the existing card builders so click behavior,
// resume state, and keyboard focus all come for free. Empty rails hide; a fresh profile (no TMDB key
// AND no sources) gets the onboarding card instead. The Live-now rail reads ONLY the catalog cache —
// it never fetches (visiting the Live TV tab warms the cache); a cold cache shows a hint.

const DASH_RAIL_MAX = 15;

// One rail: title + "See all →" + a horizontal scroller of cards. Null when there's nothing to show.
function dashRail(title, seeAll, items) {
  if (!items.length) return null;
  const sec = mk('div', 'dash-section');
  const head = mk('div', 'dash-head');
  head.append(mk('h2', null, title));
  const link = mk('button', 'dash-seeall', 'See all →');
  link.onclick = seeAll;
  head.append(link);
  const rail = mk('div', 'rail anim-in');
  rail.append(...items);
  // edge fades hint at scrollability (mask toggled by can-scroll state)
  const fades = () => {
    rail.classList.toggle('fade-l', rail.scrollLeft > 8);
    rail.classList.toggle('fade-r', rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 8);
  };
  rail.onscroll = fades;
  requestAnimationFrame(fades);
  sec.append(head, rail);
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
  }
  return el;
}

// ---------- hero (resume > trending) ----------

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

// Fill the hero placeholder: the most recent Continue item (with logo art via one appended detail
// fetch), else trending #1. Anything failing -> the hero disappears (same contract as empty rails).
async function fillHero(heroSec) {
  let kind = null, d = null, resume = null;
  try {
    const c = cont[0];
    const cid = c && typeOf(c) !== 'live' && tmdbIdOf(c.url);
    if (cid) {
      kind = typeOf(c) === 'movie' ? 'movie' : 'tv';
      d = await tmdbGet(`/${kind}/${cid}`, { append_to_response: 'images', include_image_language: 'en,null' });
      if (d && !d.id) d.id = cid;
      resume = c;
    } else {
      const t = await fetchTrending();
      d = ((t && t.results) || []).find((r) => r.backdrop_path || r.title || r.name) || null;
      kind = 'movie';
    }
  } catch {}
  if (!heroSec.isConnected) return; // dashboard re-rendered / navigated away
  if (!d || d.error || (!d.title && !d.name)) { heroSec.remove(); return; }
  heroSec.replaceChildren(heroContent(kind, d, resume));
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

// Trending = discover-by-popularity (the app has no /trending path; this reuses the browse endpoint).
let trendCache = null; // { data, at } — re-entering the dashboard within the TTL doesn't refetch
const TREND_TTL = 300000;
async function fetchTrending() {
  if (trendCache && Date.now() - trendCache.at < TREND_TTL) return trendCache.data;
  const data = await tmdbGet('/discover/movie', { sort_by: 'popularity.desc' });
  trendCache = { data, at: Date.now() };
  return data;
}

// First-run setup card — the one place that checks BOTH missing pieces. Gated on emptiness (no
// dismiss flag): it disappears as soon as a key or a source exists.
function onboardingCard() {
  const card = mk('div', 'onboard-card');
  card.append(mk('h2', null, 'Welcome to Stream Hub'));
  card.append(mk('div', 'set-hint', 'Two quick steps and this becomes your media library:'));

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

  card.append(s1, s2);
  return card;
}

async function renderDashboard() {
  const el = $('dashboard');
  if (!tmdbKey && !sources.length) { el.replaceChildren(onboardingCard()); return; }

  const nodes = [];

  // hero placeholder (reserved-height skeleton) — filled or removed by fillHero
  let heroSec = null;
  if (tmdbKey) {
    heroSec = mk('div', 'dash-hero');
    heroSec.append(mk('div', 'skel skel-hero'));
    nodes.push(heroSec);
  }

  const contRail = dashRail('Continue Watching', showHome,
    cont.slice(0, DASH_RAIL_MAX).map(resumeCard));
  if (contRail) nodes.push(contRail);

  // Trending paints skeleton cards and fills in when the fetch resolves — never blocks the dashboard.
  let trendSec = null;
  if (tmdbKey) {
    trendSec = dashRail('Trending', () => { browseTab = 'movie'; showBrowse(); }, skeletonCards(6));
    nodes.push(trendSec);
  }

  const liveNow = cachedLiveNow().slice(0, DASH_RAIL_MAX).map(matchCard);
  if (liveNow.length) {
    nodes.push(dashRail('Live now', () => { browseTab = 'live'; showBrowse(); }, liveNow));
  } else if (sources.some((s) => s.category === 'live' && s.catalogUrl)) {
    // cold cache: point at the Live tab (which fetches + warms the cache) instead of fetching here
    const sec = mk('div', 'dash-section');
    const head = mk('div', 'dash-head');
    head.append(mk('h2', null, 'Live now'));
    sec.append(head);
    const hint = mk('button', 'set-btn dash-live-hint', 'Open Live TV to load matches');
    hint.onclick = () => { browseTab = 'live'; showBrowse(); };
    sec.append(hint);
    nodes.push(sec);
  }

  if (!nodes.length) nodes.push(emptyMsg('Nothing here yet — watch something and it shows up, or add a TMDB API key in Settings to see Trending.'));
  el.replaceChildren(...nodes);

  if (heroSec) fillHero(heroSec);

  if (trendSec) {
    let results = [];
    try {
      const d = await fetchTrending();
      results = ((d && d.results) || []).filter((r) => r.poster_path || r.title || r.name).slice(0, DASH_RAIL_MAX);
    } catch {}
    if (!trendSec.isConnected) return; // dashboard re-rendered / navigated away while fetching
    if (!results.length) trendSec.remove();
    else {
      const rail = trendSec.querySelector('.rail');
      rail.replaceChildren(...results.map((r) => posterCard('movie', r)));
      rail.dispatchEvent(new Event('scroll')); // re-evaluate the edge fades for the new width
    }
  }
}
