// Landing dashboard: horizontal rails of Continue Watching / Trending / Live now, built from the
// existing card builders (library card / posterCard / matchCard) so click behavior, resume state, and
// keyboard focus all come for free. Empty rails hide; a fresh profile (no TMDB key AND no sources)
// gets the onboarding card instead. The Live-now rail reads ONLY the catalog cache — it never fetches
// (visiting the Live TV tab warms the cache); a cold cache shows a hint.

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
  const rail = mk('div', 'rail');
  rail.append(...items);
  sec.append(head, rail);
  return sec;
}

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

  const contRail = dashRail('Continue Watching', showHome,
    cont.slice(0, DASH_RAIL_MAX).map((i) => card(i, true)));
  if (contRail) nodes.push(contRail);

  // Trending paints a spinner and fills in when the fetch resolves — never blocks the dashboard.
  let trendSec = null;
  if (tmdbKey) {
    trendSec = dashRail('Trending', () => { browseTab = 'movie'; showBrowse(); },
      [stateNode('loading', 'Loading…')]);
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

  if (trendSec) {
    let results = [];
    try {
      const d = await fetchTrending();
      results = ((d && d.results) || []).filter((r) => r.poster_path || r.title || r.name).slice(0, DASH_RAIL_MAX);
    } catch {}
    if (!trendSec.isConnected) return; // dashboard re-rendered / navigated away while fetching
    if (!results.length) trendSec.remove();
    else trendSec.querySelector('.rail').replaceChildren(...results.map((r) => posterCard('movie', r)));
  }
}
