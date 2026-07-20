// E2E suite: drives the real app over Chrome DevTools Protocol.
// Plain Node, no deps (built-in fetch + WebSocket). Run: npm test
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CDP, sleep, until } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const PORT = 9223;
const SITE = 'http://127.0.0.1:9310';
const UA_ECHO_HOST = '127.0.0.1:9311';
const UA_ECHO = `http://${UA_ECHO_HOST}`;
const PLAYER = 'http://127.0.0.1:9312';
const CATALOG = 'http://127.0.0.1:9314';
const YT_FIX_HOST = '127.0.0.1:9315';
const YT_FIX = 'http://' + YT_FIX_HOST;
const CATALOG2 = 'http://127.0.0.1:9316';
const CATALOG_B = 'http://127.0.0.1:9317';
const CATALOG_TWOHOP = 'http://127.0.0.1:9318';
const PROFILE = path.join(os.tmpdir(), 'stream-hub-test-profile');

let electronProc = null;
let passed = 0;

function ok(name) { passed++; console.log(`  ok ${passed} - ${name}`); }

// ---- local test site: a media page with og tags + a cross-origin player iframe ----
const site = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.setHeader('x-sec-ch-ua', req.headers['sec-ch-ua'] || 'NONE'); // echo the UA client hint (same-origin readable)
  res.end(`<!doctype html><html><head>
    <meta property="og:title" content="Widow's Bay">
    <meta property="og:image" content="${SITE}/poster.png">
    <title>Widow's Bay</title></head><body>
    <h1>Fixture</h1>
    <div id="sh-cosmetic">ad</div>
    <iframe src="${PLAYER}/player" style="width:320px;height:180px"></iframe>
    </body></html>`);
});

// Cross-origin player frame with a <video> whose position the MAIN process reads
// via WebFrameMain.executeJavaScript (frame injection). Deterministic, no real media.
const player = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><video></video><script>
    const v = document.querySelector('video');
    Object.defineProperty(v, 'currentTime', { get: () => 42 });
    Object.defineProperty(v, 'duration', { get: () => 100 });
  </script>`);
});

// Stands in for a google-login host: echoes the User-Agent the app sent.
// CORS-open so the guest (different origin) can fetch it.
const uaEcho = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', 'x-sec-ch-ua'); // so the cross-origin guest can read it
  res.setHeader('x-sec-ch-ua', req.headers['sec-ch-ua'] || 'NONE'); // echo the UA client hint (should be stripped here)
  res.end(req.headers['user-agent'] || '');
});

// Stands in for TMDB (SH_TEST_TMDB_BASE points the main process here). Path-aware:
// detail objects for /movie|tv/{id}, episode lists for /season/{n}, else a results list.
const tmdb = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;
  if (/\/season\/\d+$/.test(p)) {
    res.end(JSON.stringify({ episodes: [
      { episode_number: 1, season_number: 1, name: 'Ep One', overview: 'first', still_path: '/s1.jpg' },
      { episode_number: 2, season_number: 1, name: 'Ep Two', overview: 'second', still_path: '/s2.jpg' },
      { episode_number: 99, season_number: 1, name: 'Future Ep', air_date: '2099-01-01', overview: '', still_path: '' },
    ] }));
  } else if (/\/3\/(movie|tv)\/\d+$/.test(p)) {
    res.end(JSON.stringify({
      id: 42, title: 'Fixture Title', name: 'Fixture Title', overview: 'A fixture overview.',
      poster_path: '/x.jpg', backdrop_path: '/b.jpg', vote_average: 7.9, tagline: 'Twist.',
      release_date: '2026-01-01', first_air_date: '2026-01-01', runtime: 70,
      number_of_seasons: 2, number_of_episodes: 10, genres: [{ id: 18, name: 'Drama' }],
      seasons: [{ season_number: 1, name: 'Season 1', episode_count: 6 }, { season_number: 2, name: 'Season 2', episode_count: 4 }],
      credits: { crew: [{ job: 'Director', name: 'Jane Doe' }], cast: [{ id: 1, name: 'Actor One', character: 'Hero', profile_path: '/a.jpg' }] },
      created_by: [{ name: 'Jane Doe' }],
      videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abc123' }] },
      external_ids: { imdb_id: 'tt123' },
      'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Netflix', logo_path: '/n.jpg' }] } } },
      images: { logos: [{ file_path: '/logo.png', iso_639_1: 'en' }], backdrops: [{ file_path: '/bd1.jpg' }, { file_path: '/bd2.jpg' }] }, // logos v0.4.0; backdrops R2 photos
      recommendations: { results: [{ id: 51, title: 'Rec Movie', poster_path: '/r.jpg' }] },
      similar: { results: [{ id: 52, title: 'Similar Movie', poster_path: '/s.jpg' }] },
    }));
  } else if (/\/genre\/(movie|tv)\/list$/.test(p)) {
    res.end(JSON.stringify({ genres: [{ id: 28, name: 'Action & Adventure' }, { id: 16, name: 'Animation' }, { id: 18, name: 'Drama' }] }));
  } else if (/\/watch\/providers\/(movie|tv)$/.test(p)) {
    res.end(JSON.stringify({ results: [{ provider_id: 8, provider_name: 'Netflix', display_priority: 1 }, { provider_id: 337, provider_name: 'Disney Plus', display_priority: 2 }] }));
  } else if (/\/configuration\/languages$/.test(p)) {
    res.end(JSON.stringify([{ iso_639_1: 'en', english_name: 'English' }, { iso_639_1: 'ja', english_name: 'Japanese' }, { iso_639_1: 'ko', english_name: 'Korean' }]));
  } else if (/\/configuration\/countries$/.test(p)) {
    res.end(JSON.stringify([{ iso_3166_1: 'US', english_name: 'United States' }, { iso_3166_1: 'KR', english_name: 'South Korea' }, { iso_3166_1: 'JP', english_name: 'Japan' }]));
  } else if (/\/discover\/(movie|tv)$/.test(p)) {
    // echo page + filters into the title so pagination + each filter are assertable
    const page = +(q.get('page') || 1);
    const t = `Disc P${page} G${q.get('with_genres') || 'all'} L${q.get('with_original_language') || '-'} C${q.get('with_origin_country') || '-'}`;
    res.end(JSON.stringify({ page, total_pages: 3, results: [{ id: 42, title: t, name: t, poster_path: '/x.jpg', backdrop_path: '/b.jpg' }] }));
  } else if (/\/3\/person\/\d+$/.test(p)) {
    res.end(JSON.stringify({ id: 61, name: 'Ava Mensah', known_for_department: 'Directing',
      biography: 'A prolific fixture director known for green test runs.', profile_path: '/pp.jpg',
      combined_credits: { cast: [{ id: 71, media_type: 'movie', title: 'Person Film', poster_path: '/pf.jpg', popularity: 9 }] },
      images: { profiles: [{ file_path: '/pp.jpg' }] } }));
  } else if (/\/search\/multi$/.test(p)) {
    // mixed movie/tv/person — the app keeps movie+tv, drops the person (v0.5.0)
    res.end(JSON.stringify({ results: [
      { id: 71, media_type: 'movie', title: 'Search Movie', poster_path: '/s.jpg' },
      { id: 72, media_type: 'tv', name: 'Search Show', poster_path: '/s.jpg' },
      { id: 73, media_type: 'person', name: 'Someone', profile_path: '/p.jpg' },
    ] }));
  } else {
    res.end(JSON.stringify({ page: 1, total_pages: 1, results: [{ id: 42, title: 'Fixture Title', name: 'Fixture Title', poster_path: '/x.jpg' }] }));
  }
});

// Stands in for a generic live-catalog JSON API (fetched via sh.httpGet -> main).
const catalog = http.createServer((req, res) => {
  if (req.url === '/huge') {
    // ~6MB with NO content-length (chunked) so the STREAMED 5MB cap trips mid-transfer, not the header check.
    const chunk = 'x'.repeat(64 * 1024); // 64KB
    let sent = 0;
    const pump = () => {
      while (sent < 6 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); }
      res.end();
    };
    return pump();
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ count: 3, streams: [
    // Alpha's embed has a 3-digit id so it passes isMediaUrl — proves the `live` flag (not isMediaUrl)
    // is what keeps a live stream out of Continue Watching (v15.2 test 32k).
    // viewers/date drive the "Most watched" sort + "Live now" filter (date in seconds; 1000 = past).
    { name: 'Alpha Match', category: 'soccer', embed_url: `${PLAYER}/live/700`, thumbnail_url: '', viewers: 5000, date: Date.now() - 600000 }, // started 10 min ago -> LIVE chip
    { name: 'Beta Match', category: 'soccer', embed_url: `${PLAYER}/live/8`, viewers: 100, date: 1000 },
    { name: 'Gamma Match', category: 'tennis', embed_url: `${PLAYER}/live/9` },
    { name: 'Future Match', category: 'soccer', embed_url: `${PLAYER}/live/50`, date: 4102444800 }, // year 2100 -> upcoming
  ] }));
});

// Stands in for a "YouTube" host in the ad-block cosmetic-skip test (SH_TEST_YT_HOST points here).
const ytFix = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><body><div id="sh-cosmetic">ad</div></body>');
});

// Nested, grouped-by-sport live catalog with a per-event channels[] array (cdnlivetv-style) — exercises
// the generic fetchCatalog flatten + channel expansion. Two sports so the category filter (>2) renders.
const catalogNested = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ 'cdn-live-tv': {
    Soccer: [{ event: 'Team A vs Team B', homeTeam: 'Team A', awayTeam: 'Team B', tournament: 'Cup',
      channels: [{ channel_name: 'English TSN', url: `${PLAYER}/live/ch1`, language: 'English' },
                 { channel_name: 'Spanish DAZN', url: `${PLAYER}/live/ch2`, language: 'Spanish' }] }],
    Tennis: [{ event: 'Player X vs Player Y', homeTeam: 'Player X', awayTeam: 'Player Y',
      channels: [{ channel_name: 'HD', url: `${PLAYER}/live/ch3` }] }],
  } }));
});

// A second flat catalog with the SAME match titled in REVERSE order — exercises the team-order-aware,
// cross-catalog merge (should collapse with catalogNested's "Team A vs Team B" into one card).
const catalogB = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ streams: [{ name: 'Team B vs Team A', category: 'soccer', embed_url: `${PLAYER}/live/reverse` }] }));
});

// Two-hop catalog (streamed.pk-style): the matches list gives {source,id} with NO embed; the real embed
// comes from a second request to the derived /api/stream/{source}/{id}. Exercises Part C.
// `twoHopHits` counts matches-list fetches so the live-catalog cache is assertable.
let twoHopHits = 0;
const catalogTwoHop = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/stream/alpha/m1')) {
    res.end(JSON.stringify([{ streamNo: 1, language: 'English', hd: true, embedUrl: `${PLAYER}/live/900`, source: 'alpha' }]));
  } else if (req.url.startsWith('/api/matches')) {
    twoHopHits++;
    res.end(JSON.stringify([{ id: 'm1', title: 'Hop Match', category: 'soccer', poster: '', sources: [{ source: 'alpha', id: 'm1' }] }]));
  } else { res.statusCode = 404; res.end('[]'); }
});

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const closeTarget = (id) => fetch(`http://127.0.0.1:${PORT}/json/close/${id}`);

async function launchApp() {
  const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
  // v0.4.3 leans on requestAnimationFrame (debounced live-grid rebuild, rail edge fades) — Chromium
  // pauses rAF in an occluded/backgrounded window, which would hang those on CI/behind other windows.
  // Keep the renderer un-throttled so the suite is deterministic regardless of window visibility.
  electronProc = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, '--test-profile',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    { cwd: ROOT, stdio: 'ignore', env: {
      ...process.env, SH_TEST_UA_HOST: UA_ECHO_HOST, SH_TEST_BLOCK_PATTERN: 'ads-test-marker\n###sh-cosmetic',
      SH_TEST_YT_HOST: YT_FIX_HOST, SH_TEST_TMDB_BASE: 'http://127.0.0.1:9313' } });
  return until(async () => {
    const list = await targets();
    return list.find((t) => t.url.includes('index.html') && t.webSocketDebuggerUrl);
  }, 'app page target');
}

async function quitApp() {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const browser = await CDP.connect(webSocketDebuggerUrl);
    // Await the graceful close so localStorage flushes (protects persistence test #22). Browser.close
    // never acks on this Chromium (socket just drops), so wait on the socket-close event, bounded so a
    // no-ack close can't hang the suite.
    const closed = new Promise((res) => browser.ws.addEventListener('close', res));
    browser.send('Browser.close').catch(() => {});
    await Promise.race([closed, sleep(2000)]);
    browser.close();
  } catch {}
  await sleep(600);
  try { electronProc?.kill(); } catch {}
  electronProc = null;
}

async function main() {
  setTimeout(() => { console.error('GLOBAL TIMEOUT'); process.exit(1); }, 240000).unref();
  fs.rmSync(PROFILE, { recursive: true, force: true }); // deterministic start
  site.listen(9310);
  uaEcho.listen(9311);
  player.listen(9312);
  tmdb.listen(9313);
  catalog.listen(9314);
  ytFix.listen(9315);
  catalogNested.listen(9316);
  catalogB.listen(9317);
  catalogTwoHop.listen(9318);

  // ---------- boot ----------
  let pageTarget = await launchApp();
  let page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
  await until(() => page.eval(`!!document.querySelector('#dashboard .onboard-card')`), 'dashboard onboarding rendered');

  // 1. UI boots on the Dashboard: a fresh profile (no key AND no sources) shows the onboarding card
  assert.strictEqual(await page.eval(`document.querySelectorAll('#sources li').length`), 0, 'expected no seeded sources');
  assert.strictEqual(await page.eval(`document.getElementById('dashboard').hidden`), false, 'dashboard should be the landing view');
  assert.strictEqual(await page.eval(`document.getElementById('home').hidden`), true, 'library should be hidden at boot');
  assert.ok(await page.eval(`!!document.getElementById('onboard-add')`), 'onboarding should offer the add-source wizard');
  await page.eval(`document.getElementById('browse-btn').click()`); // Browse keeps its own no-key prompt
  await until(() => page.eval(`document.querySelectorAll('#browse .tabs .tab').length`), 'browse rendered');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#browse .tabs .tab').length`), 3, 'expected 3 browse tabs (Movies/TV/Anime — Live+YouTube moved to the rail)');
  assert.ok(await page.eval(`(document.querySelector('#browse .empty')||{}).textContent?.includes('TMDB')`), 'no-key prompt should mention TMDB');
  ok('boot: dashboard landing + onboarding card; Browse shows 3 tabs + no-key prompt');

  // 1b. v0.5.0 shell: the Search rail button reveals the #search view with a search input (full search lands R5)
  await page.eval(`document.getElementById('search-btn').click()`);
  assert.strictEqual(await page.eval(`document.getElementById('search').hidden`), false, 'search view should show after clicking the rail Search button');
  assert.ok(await page.eval(`!!document.querySelector('#search .browse-search')`), 'search view should contain a .browse-search input');
  await page.eval(`showBrowse()`); // navigate away so later tests keep their expected view state
  ok('search: rail Search button reveals the #search view with a search input');

  // 2. add local test source + click it -> interaction regression check
  await page.eval(`addSource({ name: 'LocalTest', url: '${SITE}', category: 'vod' })`);
  assert.strictEqual(await page.eval(`document.querySelectorAll('#sources li').length`), 1, 'source not added');
  await page.eval(`[...document.querySelectorAll('#sources li')].find((li) => li.textContent.includes('LocalTest')).click()`);
  assert.strictEqual(await page.eval(`document.getElementById('webview').hidden`), false, 'webview must show after choosing a source');
  assert.strictEqual(await page.eval(`document.getElementById('browse').hidden`), true, 'browse must hide after choosing a source');
  const hit = await page.eval(`(() => {
    const r = document.getElementById('view').getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el ? el.tagName : 'none';
  })()`);
  assert.strictEqual(hit, 'WEBVIEW', `click at view center hits <${hit}>, not the webview — overlay bug`);
  ok('interaction: placeholder hides, clicks reach the webview');

  // 3. webview navigates + address bar updates
  await until(() => page.eval(`document.getElementById('webview').getURL().startsWith('${SITE}')`), 'webview navigated to local site');
  assert.strictEqual(await page.eval(`document.getElementById('address').textContent.startsWith('${SITE}')`), true, 'address bar not updated');
  ok('webview navigates, address bar updates');

  // 4. guest target reachable over CDP
  const guestTarget = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(SITE) && t.webSocketDebuggerUrl), 'guest CDP target');
  const guest = await CDP.connect(guestTarget.webSocketDebuggerUrl);
  const ready = await until(() => guest.eval(`document.readyState`), 'guest ready');
  assert.ok(['interactive', 'complete'].includes(ready), `guest readyState ${ready}`);
  ok('guest page reachable over CDP');

  // 5a. cross-host ad popup denied
  await guest.eval(`void window.open('https://example.com/fake-ad')`);
  await sleep(1500);
  assert.ok(!(await targets()).some((t) => t.url.includes('example.com')), 'ad popup was NOT blocked');
  ok('popups: cross-host ad denied');

  // 5b. same-host _blank loads in place
  await guest.eval(`void window.open('${SITE}/page2')`);
  await until(async () => (await targets()).some((t) => t.url === `${SITE}/page2`), 'guest navigated to /page2');
  assert.ok(!(await targets()).some((t) => t.url === `${SITE}/page2` && t.url.includes('index.html')), 'sanity');
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${SITE}/page2'`), 'webview shows /page2');
  ok('popups: same-host opens in place');

  // 5c. auth host opens real login window
  await guest.eval(`void window.open('https://accounts.google.com')`);
  const popup = await until(async () =>
    (await targets()).find((t) => t.url.startsWith('https://accounts.google.com') && t.type === 'page'), 'login popup window');
  ok('popups: auth host (accounts.google.com) allowed as window');
  const popupCdp = await CDP.connect(popup.webSocketDebuggerUrl);

  // 5c2. requests to a google-login host get the Firefox UA header (Google blocks
  // embedded Chromium). UA_ECHO host is registered via SH_TEST_UA_HOST; check the
  // header the app actually sends, from inside the Electron session.
  const echoedUA = await guest.eval(
    `fetch('${UA_ECHO}/').then(r => r.text())`);
  assert.ok(echoedUA.includes('Firefox'), `google-login host did not get Firefox UA header: ${echoedUA}`);
  const normalUA = await guest.eval(`navigator.userAgent`);
  assert.ok(!normalUA.includes('Firefox'), `normal browsing UA should stay Chrome, got: ${normalUA}`);
  ok('login hosts get Firefox UA header; normal browsing stays Chrome');

  // 5c3. v0.2.1: google-login hosts also get Chromium's UA Client Hints stripped (real Firefox sends none)
  const siteHints = await guest.eval(`fetch('${SITE}/').then(r => r.headers.get('x-sec-ch-ua'))`);
  const loginHints = await guest.eval(`fetch('${UA_ECHO}/').then(r => r.headers.get('x-sec-ch-ua'))`);
  if (siteHints === 'NONE') console.log('  WARN - Chromium sent no sec-ch-ua to the test host; the strip assertion is weaker here');
  assert.strictEqual(loginHints, 'NONE', `sec-ch-ua must be stripped for google-login hosts, got: ${loginHints}`);
  ok('login hosts: Chromium UA Client Hints (sec-ch-ua) stripped');

  // 5d. nested popups from login window denied
  await popupCdp.eval(`void window.open('https://example.com/nested')`);
  await sleep(1500);
  assert.ok(!(await targets()).some((t) => t.url.includes('example.com')), 'nested popup was NOT blocked');
  popupCdp.close();
  await closeTarget(popup.id);
  ok('popups: nested popup from login window denied');

  // 5e. ad blocker cancels matching requests, leaves others alone (same host, path differs)
  const adResult = await guest.eval(
    `fetch('${SITE}/ads-test-marker.js').then(() => 'loaded', () => 'blocked')`);
  assert.strictEqual(adResult, 'blocked', 'ad-blocker did not cancel the ad request');
  const cleanResult = await guest.eval(
    `fetch('${SITE}/plain.js').then(() => 'loaded', () => 'blocked')`);
  assert.strictEqual(cleanResult, 'loaded', 'ad-blocker wrongly blocked a normal request');
  ok('adblock: matching request blocked, normal request allowed');

  // 6. media page auto-populates Continue Watching (title/poster/season/episode)
  await page.eval(`document.getElementById('webview').src = '${SITE}/tv/286360?season=2&episode=5'`);
  const c0 = await until(async () => {
    const c = await page.eval(`JSON.parse(localStorage.getItem('continue') || '[]')`);
    return c.length ? c : null;
  }, 'continue entry created');
  assert.strictEqual(c0[0].season, 2, 'season not captured');
  assert.strictEqual(c0[0].episode, 5, 'episode not captured');
  assert.strictEqual(c0[0].title, "Widow's Bay", 'title not captured');
  assert.strictEqual(c0[0].poster, `${SITE}/poster.png`, 'poster not captured');
  ok('continue: media page auto-captures title/poster/season/episode');

  // 7. playback position read from the cross-origin player frame (main-process injection)
  await until(async () => {
    const c = await page.eval(`JSON.parse(localStorage.getItem('continue') || '[]')`);
    return c[0] && c[0].position === 42 ? c : null;
  }, 'video position via frame injection', 12000);
  const cPos = await page.eval(`JSON.parse(localStorage.getItem('continue'))`);
  assert.strictEqual(cPos[0].duration, 100, 'duration not read from player frame');
  ok('timestamp: position read across the cross-origin player frame');

  // 8. Watch Later button adds current page, dedupes on repeat
  await page.eval(`document.getElementById('watch-later').click()`);
  let wl = await until(async () => {
    const w = await page.eval(`JSON.parse(localStorage.getItem('watchlater') || '[]')`);
    return w.length ? w : null;
  }, 'watchlater entry added');
  assert.strictEqual(wl.length, 1, 'watch later did not add');
  assert.strictEqual(wl[0].season, 2, 'watch later missing season');
  assert.strictEqual(wl[0].type, 'tv', 'watch later missing/incorrect type');
  await page.eval(`document.getElementById('watch-later').click()`);
  await sleep(400);
  wl = await page.eval(`JSON.parse(localStorage.getItem('watchlater'))`);
  assert.strictEqual(wl.length, 1, 'watch later duplicated instead of dedupe');
  ok('watch later: adds current page, dedupes');

  // 8b. Watch Later auto-advances episode as you keep watching the same show
  await page.eval(`document.getElementById('webview').src = '${SITE}/tv/286360?season=2&episode=6'`);
  wl = await until(async () => {
    const w = await page.eval(`JSON.parse(localStorage.getItem('watchlater') || '[]')`);
    return w[0] && w[0].episode === 6 ? w : null;
  }, 'watchlater episode auto-updated');
  assert.ok(wl[0].url.includes('episode=6'), 'watchlater url not advanced to new episode');
  ok('watch later: auto-advances episode from playback');

  const clickTab = (bar, label) =>
    page.eval(`[...document.querySelectorAll('#home ${bar} .tab')].find(b => b.textContent === '${label}').click()`);

  // 9. Home renders top tabs + sub tabs + a grid
  await page.eval(`document.getElementById('home-btn').click()`);
  assert.strictEqual(await page.eval(`document.getElementById('home').hidden`), false, 'home should show');
  assert.strictEqual(await page.eval(`document.getElementById('webview').hidden`), true, 'webview should hide on home');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .tabs .tab').length`), 2, 'expected 2 top tabs');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .subtabs .tab').length`), 3, 'expected 3 sub tabs');
  assert.ok(await page.eval(`document.querySelectorAll('#home .grid .card').length >= 1`), 'continue tab should show cards');
  ok('home: top tabs + sub tabs + grid render');

  // 10. clicking a card opens its url in the webview
  await page.eval(`document.querySelector('#home .grid .card').click()`);
  assert.strictEqual(await page.eval(`document.getElementById('home').hidden`), true, 'home should hide after opening a card');
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/tv/286360')`), 'card opened its url');
  ok('card click: opens the saved url');

  // 11. edit note on a continue card (✎ = first action button)
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`document.querySelector('#home .grid .card .card-actions button').click()`);
  await page.eval(`(() => {
    const input = document.querySelector('#home .grid .card .note-edit');
    input.value = 'my note';
    input.dispatchEvent(new Event('blur'));
  })()`);
  const cNote = await page.eval(`JSON.parse(localStorage.getItem('continue'))`);
  assert.ok(cNote.some((c) => c.note === 'my note'), 'note edit not persisted');
  ok('edit note: ✎ on a continue card commits');

  // 12. second continue item (a movie) + type classification
  await page.eval(`document.getElementById('webview').src = '${SITE}/movie/999888'`);
  const c2 = await until(async () => {
    const c = await page.eval(`JSON.parse(localStorage.getItem('continue') || '[]')`);
    return c.length === 2 ? c : null;
  }, 'second continue entry');
  assert.strictEqual(c2.find((c) => c.url.includes('/tv/286360')).type, 'tv', 'tv entry mis-typed');
  assert.strictEqual(c2.find((c) => c.url.includes('/movie/999888')).type, 'movie', 'movie entry mis-typed');
  ok('type: tv vs movie classified from url/season');

  // 13. sub-tabs filter the grid by type
  await page.eval(`document.getElementById('home-btn').click()`);
  await clickTab('.subtabs', 'All');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 2, 'All should show both');
  await clickTab('.subtabs', 'Movies');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 1, 'Movies should show 1');
  assert.ok(await page.eval(`document.querySelector('#home .grid .card').dataset.key.includes('999888')`), 'Movies tab wrong card');
  await clickTab('.subtabs', 'TV Shows');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 1, 'TV should show 1');
  assert.ok(await page.eval(`document.querySelector('#home .grid .card').dataset.key.includes('286360')`), 'TV tab wrong card');
  await clickTab('.subtabs', 'All');
  ok('sub-tabs: All / Movies / TV Shows filter by type');

  // 14. top tabs switch Continue Watching <-> Watch Later
  await clickTab('.tabs', 'Watch Later');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 1, 'watch later tab should show 1 card');
  assert.ok(await page.eval(`document.querySelector('#home .grid .card').dataset.key.includes('286360')`), 'watch later card wrong');
  await clickTab('.tabs', 'Continue Watching');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 2, 'continue tab should show 2 cards');
  ok('top tabs: switch Continue Watching / Watch Later');

  // 15. remove card (the movie), keep the tv entry
  const movieKey = 'movie#999888'; // mediaKey is now host-independent: type#tmdbId
  const clicked = await page.eval(
    `!!document.querySelector('.card[data-key="${movieKey}"] .card-actions button:last-child')?.click() || true`);
  assert.ok(clicked, 'movie card not found in grid');
  const cAfter = await page.eval(`JSON.parse(localStorage.getItem('continue'))`);
  assert.strictEqual(cAfter.length, 1, 'remove did not delete the card');
  assert.ok(!cAfter.some((c) => c.key === movieKey), 'removed the wrong card');
  assert.ok(cAfter[0].url.includes('/tv/286360'), 'the tv entry should remain');
  ok('remove card: ✕ deletes the targeted card from Continue Watching');

  // 16. add a Live TV source via the category select; unified list shows it with a category label,
  //     and the Default-player picker lists only Movies/TV/Anime players (not Live TV).
  await page.eval(`addSource({ name: 'LiveFix', url: '${PLAYER}', category: 'live' })`);
  const srcs = await page.eval(`JSON.parse(localStorage.getItem('sources'))`);
  assert.ok(srcs.some((s) => s.name === 'LiveFix' && s.category === 'live'), 'live source not stored with category');
  assert.ok(await page.eval(`[...document.querySelectorAll('#sources li')].some((li) => li.textContent.includes('LiveFix') && li.textContent.includes('Live TV'))`), 'live source not shown with a category label in the unified list');
  assert.ok(!(await page.eval(`[...document.querySelectorAll('#default-source option')].some((o) => o.value === '${PLAYER}' && o.textContent === 'LiveFix')`)), 'Live TV should not appear in the Default player picker');
  ok('sources: add-source category select + unified list + default picker');

  // 17. Live TV source does NOT enter Continue Watching, but Watch Later works
  const contBefore = (await page.eval(`JSON.parse(localStorage.getItem('continue'))`)).length;
  await page.eval(`
    document.getElementById('home').hidden = true;
    document.getElementById('webview').hidden = false;
    document.getElementById('webview').src = '${PLAYER}/watch/12345';
  `);
  await sleep(2000);
  assert.strictEqual((await page.eval(`JSON.parse(localStorage.getItem('continue'))`)).length, contBefore,
    'live source leaked into Continue Watching');
  await page.eval(`document.getElementById('watch-later').click()`);
  const wlLive = await until(async () => {
    const w = await page.eval(`JSON.parse(localStorage.getItem('watchlater') || '[]')`);
    return w.some((x) => x.type === 'live') ? w : null;
  }, 'live watchlater entry');
  assert.ok(wlLive.some((x) => x.type === 'live'), 'watch later live entry missing');
  ok('live source: skips Continue Watching, still allowed in Watch Later');

  // 18. Watch Later has a Live TV sub-tab that filters live items
  await page.eval(`document.getElementById('home-btn').click()`);
  await clickTab('.tabs', 'Watch Later');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .subtabs .tab').length`), 4, 'watch later should have 4 sub-tabs');
  await clickTab('.subtabs', 'Live TV');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 1, 'Live TV sub-tab should show the live entry');
  await clickTab('.subtabs', 'All');
  ok('watch later: Live TV sub-tab filters live items');

  // 19. re-categorise a Continue card (tv -> movie) via the type dropdown
  await clickTab('.tabs', 'Continue Watching');
  await clickTab('.subtabs', 'All');
  const tvKey = 'tv#286360'; // host-independent key: type#tmdbId
  await page.eval(`(() => {
    const sel = document.querySelector('.card[data-key="${tvKey}"] .type-select');
    sel.value = 'movie';
    sel.dispatchEvent(new Event('change'));
  })()`);
  const cReclass = await page.eval(`JSON.parse(localStorage.getItem('continue'))`);
  assert.strictEqual(cReclass.find((c) => c.key === tvKey).type, 'movie', 're-categorise did not persist');
  await clickTab('.subtabs', 'Movies');
  assert.ok(await page.eval(`!!document.querySelector('.card[data-key="${tvKey}"]')`), 'card did not move to Movies');
  await clickTab('.subtabs', 'All');
  ok('re-categorise: type dropdown moves a card between categories');

  // 20. migration purges live-host entries from Continue Watching on load
  await page.eval(`(() => {
    const c = JSON.parse(localStorage.getItem('continue') || '[]');
    c.push({ key: '127.0.0.1:9312#live', title: 'Stuck Live', url: '${PLAYER}/watch/777',
             season: null, episode: null, type: 'movie', updatedAt: Date.now(), position: null, duration: null, note: '' });
    localStorage.setItem('continue', JSON.stringify(c));
  })()`);
  await page.eval(`location.reload()`);
  await until(() => page.eval(`document.querySelectorAll('#sources li').length`), 'reloaded after seeding stuck entry');
  const cPurged = await page.eval(`JSON.parse(localStorage.getItem('continue'))`);
  assert.ok(!cPurged.some((c) => c.url.includes('/watch/777')), 'live-host entry not purged from Continue Watching');
  ok('migration: live-host entries purged from Continue Watching on load');

  // 21. remove a source (target by name; sidebar is grouped now)
  const beforeCount = await page.eval(`document.querySelectorAll('#sources li').length`);
  await page.eval(`[...document.querySelectorAll('#sources li')].find((li) => li.textContent.includes('LocalTest')).querySelector('button[title="Remove source"]').click()`);
  assert.strictEqual(await page.eval(`document.querySelectorAll('#sources li').length`), beforeCount - 1, 'source not removed');
  assert.ok(!(await page.eval(`JSON.parse(localStorage.getItem('sources'))`)).some((s) => s.name === 'LocalTest'), 'LocalTest still in storage');
  ok('sources: remove works, storage matches');

  // 22. persistence across restart (sources + continue + watch later incl. live)
  page.close(); guest.close();
  await quitApp();
  pageTarget = await launchApp();
  page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden`), 'app rendered after restart (dashboard landing)');
  await page.eval(`document.getElementById('home-btn').click()`); // Dashboard is the landing; open Library
  assert.strictEqual((await page.eval(`JSON.parse(localStorage.getItem('sources'))`)).length, 1, 'sources lost after restart');
  assert.strictEqual((await page.eval(`JSON.parse(localStorage.getItem('continue'))`)).length, 1, 'continue lost after restart');
  assert.strictEqual((await page.eval(`JSON.parse(localStorage.getItem('watchlater'))`)).length, 2, 'watchlater lost after restart');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 1, 'continue tab card not rendered after restart');
  const clickTop = (label) =>
    page.eval(`[...document.querySelectorAll('#home .tabs .tab')].find(b => b.textContent === '${label}').click()`);
  await clickTop('Watch Later');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#home .grid .card').length`), 2, 'watch later cards not rendered after restart');
  ok('persistence: sources + continue + watch later (incl. live) survive restart');

  // 23. Browse: TMDB grid renders (add a vod source + TMDB key first)
  await page.eval(`addSource({ name: 'BrowseSrc', url: '${SITE}', category: 'vod' })`);
  await page.eval(`(() => {
    const k = document.getElementById('tmdb-key');
    k.value = 'testkey';
    k.dispatchEvent(new Event('change'));
  })()`);
  await page.eval(`document.getElementById('browse-btn').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'browse movie grid');
  ok('browse: TMDB grid renders poster cards');

  // 23b. Global search: /search/multi returns movie+tv+person; the person is dropped, cards route to detail
  await page.eval(`document.getElementById('search-btn').click()`);
  assert.strictEqual(await page.eval(`document.getElementById('search').hidden`), false, 'search view should show');
  await page.eval(`(() => { const s = document.querySelector('#search .browse-search'); s.value = 'fix'; s.dispatchEvent(new Event('input')); })()`);
  await until(() => page.eval(`document.querySelectorAll('#search .grid .card').length === 2`), 'search grid shows 2 cards (person dropped)');
  await page.eval(`document.querySelector('#search .grid .card').click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && !!document.querySelector('#detail h1')`), 'search result opens detail');
  ok('search: multi-search keeps movie+tv (drops people), card opens detail');

  // 23c. Search type chips: All shows movie+tv; Movies narrows to movies; TV narrows to TV.
  await page.eval(`document.getElementById('search-btn').click()`);
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#search .search-types .tab')].map(t => t.textContent).join(',')`), 'All,Movies,TV', 'search hub should offer All/Movies/TV chips');
  await page.eval(`(() => { const s = document.querySelector('#search .browse-search'); s.value = 'fix'; s.dispatchEvent(new Event('input')); })()`);
  await until(() => page.eval(`document.querySelectorAll('#search .grid .card').length === 2`), 'All chip shows both the movie and the TV result');
  // Movies chip -> only the movie card
  await page.eval(`[...document.querySelectorAll('#search .search-types .tab')].find(b => b.textContent === 'Movies').click()`);
  await until(() => page.eval(`(() => { const ts = [...document.querySelectorAll('#search .grid .card')].map(c => c.textContent); return ts.length === 1 && ts[0].includes('Search Movie'); })()`), 'Movies chip narrows to the movie result only');
  // TV chip -> only the tv card
  await page.eval(`[...document.querySelectorAll('#search .search-types .tab')].find(b => b.textContent === 'TV').click()`);
  await until(() => page.eval(`(() => { const ts = [...document.querySelectorAll('#search .grid .card')].map(c => c.textContent); return ts.length === 1 && ts[0].includes('Search Show'); })()`), 'TV chip narrows to the TV result only');
  await page.eval(`[...document.querySelectorAll('#search .search-types .tab')].find(b => b.textContent === 'All').click()`); // reset to All for later tests
  ok('search: All/Movies/TV chips narrow the multi-search by media type');
  // restore browse view for the next test
  await page.eval(`document.getElementById('browse-btn').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'browse grid restored after search');

  // 24. clicking a Movies poster opens the native detail page; Watch loads the source embed URL
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && !!document.querySelector('#detail h1')`), 'movie detail page');
  assert.ok(await page.eval(`document.querySelector('#detail h1').textContent.length > 0`), 'detail title missing');
  assert.ok(await page.eval(`!!document.querySelector('#detail .detail-section p')`), 'detail overview missing');
  await page.eval(`document.querySelector('#detail .src-row').click()`); // Watch on the first source
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/embed/movie/42')`), 'watch opened embed url');
  ok('detail: movie poster -> detail page -> pick source loads the embed player');

  // 24b. TV detail shows season select + episode cards; Watch deep-links the episode; Trailer -> youtube embed
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'tv').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'tv grid');
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`!!document.querySelector('#detail .season-select') && document.querySelectorAll('#detail .episode').length >= 1`), 'tv detail episodes');
  await page.eval(`document.querySelector('#detail .src-row').click()`); // Watch S1E1 (default) on the first source
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/embed/tv/42/1/1')`), 'tv watch deep-links episode');
  // Trailer
  await page.eval(`document.getElementById('browse-btn').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'tv grid again');
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`!!document.querySelector('#detail .detail-actions')`), 'detail actions');
  await page.eval(`[...document.querySelectorAll('#detail .detail-actions button')].find(b => b.textContent.includes('Trailer')).click()`);
  assert.ok(await page.eval(`document.getElementById('webview').src.includes('youtube.com/embed/abc123')`), 'trailer did not open youtube embed');
  ok('detail: TV episode picker + deep-link Watch + trailer');

  // 24c. Watch Later from the detail page adds an entry
  await page.eval(`document.getElementById('browse-btn').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'tv grid for watch-later');
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`!!document.querySelector('#detail .detail-actions')`), 'detail for watch-later');
  const wlBefore = (await page.eval(`JSON.parse(localStorage.getItem('watchlater') || '[]')`)).length;
  await page.eval(`[...document.querySelectorAll('#detail .detail-actions button')].find(b => b.textContent.includes('Watch Later')).click()`);
  assert.strictEqual((await page.eval(`JSON.parse(localStorage.getItem('watchlater'))`)).length, wlBefore + 1, 'detail Watch Later did not add');
  ok('detail: + Watch Later adds an entry');

  // 24d. C1: tmdbGet promise-dedupes + caches by path/params (same object for repeat calls within TTL)
  const cacheDedup = await page.eval(`(async () => {
    const a = tmdbGet('/movie/42', {});
    const b = tmdbGet('/movie/42', {});
    const same = (await a) === (await b);
    const keyed = [...tmdbCache.keys()].some((k) => k.includes('/movie/42'));
    return same && tmdbCache.size > 0 && keyed;
  })()`);
  assert.ok(cacheDedup, 'tmdbGet should promise-dedupe and cache /movie/42 within the TTL');
  ok('cache: tmdbGet dedupes + caches (same object, key retained)');

  // 24e. C7: movie detail shows a formatted runtime (fmtRuntime) + a Director line from credits.crew
  await page.eval(`showDetail('movie', 42)`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && !!document.querySelector('#detail .detail-crew')`), 'movie detail with crew line');
  assert.ok(await page.eval(`/\\dh|\\dm/.test(document.querySelector('#detail .detail-meta').textContent)`), 'detail-meta should show a formatted h/m runtime');
  assert.strictEqual(await page.eval(`document.querySelector('#detail .detail-crew').textContent`), 'Director: Jane Doe', 'movie detail should show the director');
  ok('detail: fmtRuntime in meta + Director/Creator line');

  // 24f. C5: a future-dated episode is flagged "Coming Soon" and cannot be selected (Watch gated)
  await page.eval(`showDetail('tv', 42)`);
  await until(() => page.eval(`document.querySelectorAll('#detail .episode').length >= 1 && !!document.querySelector('#detail .episode.unaired')`), 'tv detail with an unaired episode');
  assert.ok(await page.eval(`document.querySelector('#detail .episode.unaired .ep-chip').textContent.includes('Coming Soon')`), 'unaired episode shows a Coming Soon chip');
  await page.eval(`document.querySelector('#detail .episode.unaired').click()`);
  await sleep(200);
  assert.ok(!(await page.eval(`document.querySelector('#detail .episode.unaired').classList.contains('selected')`)), 'an unaired episode must not be selectable');
  ok('detail: unaired episodes flagged Coming Soon and not selectable');

  // 24g. B7: Recommendations + More Like This rails render on the detail page (from the one-call fetch)
  await page.eval(`showDetail('movie', 42)`);
  await until(() => page.eval(`document.querySelectorAll('#detail .detail-rail').length >= 2`), 'detail recommendation/similar rails');
  assert.ok(await page.eval(`[...document.querySelectorAll('#detail .detail-rail')].every(r => !!r.querySelector('.card'))`), 'each detail rail should hold poster cards');
  ok('detail: Recommendations + More Like This rails render');

  // 24g2. R2: detail rails join the ONE unified rail system — native scrollbar hidden + hover chevrons.
  assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('#detail .detail-rail')).scrollbarWidth`), 'none', 'a detail rail hides its native scrollbar (unified rail system)');
  assert.ok(await page.eval(`(() => { const r = document.querySelector('#detail .detail-rail'); return r.parentElement.classList.contains('has-rail') && !!r.parentElement.querySelector('.rail-chev.next'); })()`), 'a detail rail parent gets has-rail + chevrons via wireRail');
  ok('detail: rails join the unified rail system (hidden scrollbar + chevrons)');

  // 24h. A13: Photos grid opens a lightbox; Esc closes the lightbox WITHOUT closing the detail page
  assert.ok(await page.eval(`!!document.querySelector('#detail .detail-photos img')`), 'detail photos grid missing');
  await page.eval(`document.querySelector('#detail .detail-photos img').click()`);
  assert.ok(await page.eval(`!!document.querySelector('.modal-overlay.lightbox')`), 'clicking a photo should open the lightbox');
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(150);
  assert.ok(!(await page.eval(`!!document.querySelector('.modal-overlay.lightbox')`)), 'Esc should close the lightbox');
  assert.strictEqual(await page.eval(`document.getElementById('detail').hidden`), false, 'Esc must not fall through and close the detail page');
  ok('detail: photo lightbox opens; Esc closes it without leaving the detail page');

  // 24i. B3: genre chip deep-links into a filtered Browse view (then reset to avoid filter contamination)
  await page.eval(`document.querySelector('#detail .detail-genres span').click()`);
  await until(() => page.eval(`!document.getElementById('browse').hidden`), 'genre chip opened Browse');
  assert.ok(['movie', 'tv'].includes(await page.eval(`browseTab`)), 'genre chip should switch to the movie/tv browse tab');
  assert.strictEqual(await page.eval(`browseFilters.genre`), '18', 'genre chip should apply its genre id as the browse filter');
  assert.strictEqual(await page.eval(`document.getElementById('detail').hidden`), true, 'detail should hide after a genre deep-link');
  // reset the touched tab's saved filter so later browse/discover/persistence tests see clean state
  await page.eval(`browseFiltersAll['movie'] = {}; store('browseFilters', browseFiltersAll); browseFilters = loadFiltersFor(browseTab)`);
  ok('detail: genre chip deep-links to filtered Browse');

  // 24j. B2: person page renders directly; cast→person navigation; Esc returns to the detail page
  await page.eval(`showPerson(61)`);
  await until(() => page.eval(`!document.getElementById('person').hidden && !!document.querySelector('#person h1')`), 'person page');
  assert.strictEqual(await page.eval(`document.querySelector('#person h1').textContent`), 'Ava Mensah', 'person name');
  assert.ok(await page.eval(`!!document.querySelector('#person .detail-rail .card')`), 'person Known-For rail should render');
  await page.eval(`showDetail('movie', 42)`);
  await until(() => page.eval(`!!document.querySelector('#detail .cast')`), 'detail cast row');
  await page.eval(`document.querySelector('#detail .cast').click()`);
  await until(() => page.eval(`!document.getElementById('person').hidden`), 'cast click opens person');
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && document.getElementById('person').hidden`), 'Esc returns to detail');
  ok('person: page renders + cast→person + Esc back to detail');

  // 24k. R3: ▶ Play is the loud PRIMARY action — first child of .detail-actions, routes to the default source
  await page.eval(`showDetail('movie', 42)`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && !!document.querySelector('#detail .detail-play')`), 'detail Play button');
  assert.ok(await page.eval(`document.querySelector('#detail .detail-actions').firstElementChild.classList.contains('detail-play')`), '▶ Play must be the first child of .detail-actions');
  await page.eval(`document.querySelector('#detail .detail-play').click()`); // Play on the default source
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/embed/movie/42')`), 'Play opened the default source embed');
  ok('detail: ▶ Play is the primary action and routes to the default source');

  // 25. Anime tab uses TMDB discover; Live tab shows tiles of live sources
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'anime').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'anime grid');
  await page.eval(`document.getElementById('live-btn').click()`);
  assert.ok(await page.eval(`document.querySelectorAll('#browse .tiles .tile').length >= 1`), 'live tiles missing');
  ok('browse: Anime grid + Live TV tiles render');

  // 26. YouTube tab opens youtube.com in the webview
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`document.getElementById('youtube-btn').click()`);
  assert.ok(await page.eval(`document.getElementById('webview').src.includes('youtube.com')`), 'YouTube tab did not open youtube.com');
  ok('browse: YouTube tab opens youtube.com');

  // 27. buildUrl: an alternate-domain `/player/` template trims empty season/episode for movies,
  //     fills for tv; the default /embed/ pattern is unchanged.
  assert.strictEqual(
    await page.eval(`buildUrl({url:'${PLAYER}',template:'${PLAYER}/player/{id}/{season}/{episode}'},'movie',42)`),
    `${PLAYER}/player/42`, 'movie template should trim empty season/episode');
  assert.strictEqual(
    await page.eval(`buildUrl({url:'${PLAYER}',template:'${PLAYER}/player/{id}/{season}/{episode}'},'tv',42,1,3)`),
    `${PLAYER}/player/42/1/3`, 'tv template should fill season/episode');
  assert.strictEqual(
    await page.eval(`buildUrl({url:'${SITE}'},'movie',42)`),
    `${SITE}/embed/movie/42`, 'default movie url should be unchanged');
  ok('buildUrl: template trims movie / fills tv; default unchanged');

  // 28. v0.2.4: edit a source via ✎ → the wizard in edit mode; changes save in place (no duplicate)
  await page.eval(`document.getElementById('home-btn').click()`); // leave any embed
  await page.eval(`addSource({ name: 'CineTest', url: '${PLAYER}', category: 'vod' })`);
  const srcCountBeforeEdit = (await page.eval(`JSON.parse(localStorage.getItem('sources'))`)).length;
  await page.eval(`[...document.querySelectorAll('#sources li')].find(li => li.textContent.includes('CineTest')).querySelector('button[title^="Edit"]').click()`);
  await until(() => page.eval(`!!document.querySelector('.wiz-input') && document.querySelector('.wiz-input').value === 'CineTest'`), 'edit wizard opens prefilled with the source name');
  await page.eval(`document.querySelector('.wiz-next').click()`); // name -> category
  await page.eval(`document.querySelector('.wiz-next').click()`); // category (vod prefilled) -> url
  await page.eval(`document.querySelector('.wiz-next').click()`); // url (prefilled) -> template (last)
  assert.strictEqual(await page.eval(`document.querySelector('.wiz-next').textContent`), 'Save', 'edit wizard last step should read Save');
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = '${PLAYER}/player/{id}/{season}/{episode}'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // Save
  await until(() => page.eval(`document.getElementById('wizard').hidden`), 'edit wizard closes after Save');
  assert.strictEqual(
    await page.eval(`(JSON.parse(localStorage.getItem('sources')).find(s => s.name === 'CineTest')||{}).template`),
    `${PLAYER}/player/{id}/{season}/{episode}`, 'edited template did not persist');
  assert.strictEqual((await page.eval(`JSON.parse(localStorage.getItem('sources'))`)).length, srcCountBeforeEdit, 'edit must update in place, not add a duplicate');
  ok('sources: ✎ opens the wizard in edit mode; changes save in place');

  // 29. detail-page source list routes Watch to the chosen source + its pattern
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'movie').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'movie grid for source select');
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`document.querySelectorAll('#detail .src-row').length >= 2`), 'detail source list present');
  await page.eval(`[...document.querySelectorAll('#detail .src-row')].find(r => r.textContent.includes('CineTest')).click()`); // pick CineTest -> its pattern
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/player/42'`), 'watch used the chosen source pattern');
  ok('detail: source list routes Watch to the chosen source pattern');

  // 30. topbar source switcher swaps the SAME title onto another source while watching
  assert.strictEqual(await page.eval(`document.getElementById('src-switch').hidden`), false, 'src-switch should show while watching with multiple sources');
  await page.eval(`(() => {
    const sw = document.getElementById('src-switch');
    sw.value = '${SITE}';
    sw.dispatchEvent(new Event('change'));
  })()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${SITE}/embed/movie/42'`), 'switch reloaded same movie on new source');
  ok('topbar: switch source reloads the same title on the new source');

  // 31. the switcher hides once you leave the embed
  await page.eval(`document.getElementById('browse-btn').click()`);
  assert.strictEqual(await page.eval(`document.getElementById('src-switch').hidden`), true, 'src-switch should hide off the embed');
  ok('topbar: switch source hidden when not watching');

  // 32b. Add-player wizard: Movies branch, live preview, hover example, adds with custom pattern
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`document.getElementById('add-source-btn').click()`);
  await until(() => page.eval(`!document.getElementById('wizard').hidden && !!document.querySelector('.wiz-card')`), 'wizard opened');
  assert.ok(await page.eval(`!!document.querySelector('.wiz-example')`), 'wizard step should carry a hover example');
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = 'WizPlayer'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> type
  await page.eval(`[...document.querySelectorAll('.wiz-choices button')].find(b => b.textContent.includes('Movies')).click()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> url
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = 'https://wiz.example'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> pattern (last)
  await until(() => page.eval(`(document.querySelector('.wiz-preview')||{}).textContent?.includes('/embed/movie/27205')`), 'wizard shows default preview');
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = '{origin}/player/{id}/{season}/{episode}'; i.dispatchEvent(new Event('input')); })()`);
  await until(() => page.eval(`(document.querySelector('.wiz-preview')||{}).textContent?.includes('/player/27205')`), 'wizard preview updates for custom pattern');
  await page.eval(`document.querySelector('.wiz-next').click()`); // Add
  await until(() => page.eval(`document.getElementById('wizard').hidden`), 'wizard closes after Add');
  assert.ok(await page.eval(`(() => { const s = JSON.parse(localStorage.sources).find(x => x.name === 'WizPlayer'); return s && s.category === 'vod' && s.template === '{origin}/player/{id}/{season}/{episode}'; })()`), 'wizard did not add player with custom pattern');
  ok('wizard: guided add (Movies) with live preview + hover example');

  // 32c. wizard Live TV "website" branch: 4 steps (name, type, live-source, url), adds a site source
  await page.eval(`document.getElementById('add-source-btn').click()`);
  await until(() => page.eval(`!!document.querySelector('.wiz-card')`), 'wizard reopened');
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = 'WizLive'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> type
  await page.eval(`[...document.querySelectorAll('.wiz-choices button')].find(b => b.textContent.includes('Live')).click()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> live-source choice
  assert.strictEqual(await page.eval(`document.querySelectorAll('.wiz-dots span').length`), 4, 'Live TV wizard should be 4 steps');
  await page.eval(`[...document.querySelectorAll('.wiz-choices button')].find(b => b.textContent.includes('website')).click()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> url (last)
  assert.strictEqual(await page.eval(`document.querySelector('.wiz-next').textContent`), 'Add', 'URL is the last step for a website live source');
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = 'https://livesite.example'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`);
  await until(() => page.eval(`document.getElementById('wizard').hidden`), 'live wizard closes');
  assert.ok(await page.eval(`(() => { const s = JSON.parse(localStorage.sources).find(x => x.name === 'WizLive'); return s && s.category === 'live' && s.url && !s.catalogUrl; })()`), 'wizard Live TV website entry wrong');
  ok('wizard: Live TV website branch (4 steps) adds a site source');

  // 32d. sh.httpGet fetches a (loopback) URL body via main — used by the live-catalog fetch
  assert.ok(await page.eval(`(async () => { const r = await window.sh.httpGet('${SITE}/'); return !!(r && r.body && r.body.includes('Widow')); })()`), 'sh.httpGet should return the fetched body');
  ok('ipc: sh.httpGet returns fetched body (for live-catalog fetches)');

  // 32d2. v0.2.4: sh.httpGet sends a browser User-Agent (many catalog APIs 403 the default Node UA)
  assert.ok(await page.eval(`(async () => { const r = await window.sh.httpGet('${UA_ECHO}/'); return !!(r && r.body && r.body.includes('Mozilla')); })()`), 'sh.httpGet should send a browser User-Agent');
  ok('ipc: sh.httpGet sends a browser User-Agent');

  // 32d3. v0.4.3: sh.httpGet caps the response at 5MB, streamed — a ~6MB body yields the too-large error
  assert.ok(await page.eval(`(async () => { const r = await window.sh.httpGet('${CATALOG}/huge'); return !!(r && r.error && /too large/.test(r.error)); })()`), 'sh.httpGet should reject an over-5MB response');
  ok('ipc: sh.httpGet caps oversized responses (5MB, streamed)');

  // 32d4. v0.4.3: sh.httpGet strips embedded URL credentials — undici rejects credentialed URLs, so a
  //       successful fetch (Widow's Bay body) proves the strip ran before the request went out.
  assert.ok(await page.eval(`(async () => { const r = await window.sh.httpGet('http://user:pw@127.0.0.1:9310/'); return !!(r && r.ok && r.body && r.body.includes('Widow')); })()`), 'sh.httpGet should strip embedded credentials and still fetch');
  ok('ipc: sh.httpGet strips embedded URL credentials');

  // 32e. wizard adds a Live catalog (JSON API) source through the widget
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`document.getElementById('add-source-btn').click()`);
  await until(() => page.eval(`!!document.querySelector('.wiz-card')`), 'wizard for live catalog');
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = 'FixtureCatalog'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> type
  await page.eval(`[...document.querySelectorAll('.wiz-choices button')].find(b => b.textContent.includes('Live')).click()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> live-source choice
  await page.eval(`[...document.querySelectorAll('.wiz-choices button')].find(b => b.textContent.includes('Live catalog')).click()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // -> catalog URL (last)
  assert.strictEqual(await page.eval(`document.querySelector('.wiz-next').textContent`), 'Add', 'catalog URL is the last step');
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = '${CATALOG}/api/streams'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`);
  await until(() => page.eval(`document.getElementById('wizard').hidden`), 'catalog wizard closed');
  assert.ok(await page.eval(`(() => { const s = JSON.parse(localStorage.sources).find(x => x.name === 'FixtureCatalog'); return s && s.category === 'live' && s.catalogUrl === '${CATALOG}/api/streams' && !s.url; })()`), 'catalog live source not added via wizard');
  ok('wizard: adds a Live catalog (JSON API) source through the widget');

  // 32f. Live tab: unified match grid from the catalog API, with a category filter + search; click embeds
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Alpha Match'))`), 'match cards render from the API');
  // category filter tabs derived from the data
  assert.ok(await page.eval(`['All','Soccer','Tennis'].every(l => [...document.querySelectorAll('#browse .subtabs .tab')].some(t => t.textContent === l))`), 'category filter tabs (All/Soccer/Tennis) missing');
  // search filters to Beta
  await page.eval(`(() => { const s = document.querySelector('#browse .browse-search'); s.value = 'Beta'; s.dispatchEvent(new Event('input')); })()`);
  await until(() => page.eval(`(() => { const ts = [...document.querySelectorAll('#browse .match-grid .match-card')].map(t => t.textContent); return ts.some(x => x.includes('Beta')) && ts.every(x => !x.includes('Alpha') && !x.includes('Gamma')); })()`), 'search filters the grid');
  // clear + Tennis category -> only Gamma
  await page.eval(`(() => { const s = document.querySelector('#browse .browse-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await page.eval(`[...document.querySelectorAll('#browse .subtabs .tab')].find(b => b.textContent === 'Tennis').click()`);
  await until(() => page.eval(`(() => { const ts = [...document.querySelectorAll('#browse .match-grid .match-card')].map(t => t.textContent); return ts.some(x => x.includes('Gamma')) && ts.every(x => !x.includes('Alpha') && !x.includes('Beta')); })()`), 'category filter shows only Tennis');
  // Soccer category -> Alpha present; click it -> source page (even for a single source), pick -> embed
  await page.eval(`[...document.querySelectorAll('#browse .subtabs .tab')].find(b => b.textContent === 'Soccer').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Alpha'))`), 'Soccer shows Alpha');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Alpha')).click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && document.querySelectorAll('#detail .src-row').length === 1`), 'single-source match still opens the source page');
  await page.eval(`document.querySelector('#detail .src-row').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/live/700'`), 'picking the source embeds the stream');
  ok('live: unified match grid with category filter + search; single source routes through the page');

  // 32f2. v0.2.13 live filters: "Live now" hides upcoming matches; "Most watched" sorts by popularity.
  await page.eval(`document.getElementById('browse-btn').click(); document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Future Match'))`), 'future match visible before filtering');
  await page.eval(`[...document.querySelectorAll('#browse .live-controls .pill-toggle')].find(b => b.textContent === 'Live now').click()`);
  await until(() => page.eval(`(() => { const ts = [...document.querySelectorAll('#browse .match-grid .match-card')].map(t => t.textContent); return ts.some(x => x.includes('Alpha')) && ts.every(x => !x.includes('Future')); })()`), 'Live now hides the upcoming match, keeps live ones');
  await page.eval(`(() => { const s = [...document.querySelectorAll('#browse .live-controls select')].find(x => [...x.options].some(o => o.textContent === 'Most watched')); s.value = 'popular'; s.dispatchEvent(new Event('change')); })()`);
  await until(() => page.eval(`document.querySelector('#browse .match-grid .match-card .match-title').textContent.includes('Alpha')`), 'Most watched sorts Alpha (5000 viewers) to the top');
  ok('live: Live-now hides upcoming; Most-watched sorts by popularity');

  // 32f3. v0.3.3: live sort + Live-now persist across visits; EPG chips + default kickoff ordering
  await page.eval(`document.getElementById('browse-btn').click()`); // leave the Live tab…
  await page.eval(`document.getElementById('live-btn').click()`);   // …and come back
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Alpha'))`), 'live grid re-rendered');
  assert.strictEqual(await page.eval(`document.querySelector('#browse .live-filter-row select').value`), 'popular', 'sort selection should persist across visits');
  assert.ok(await page.eval(`[...document.querySelectorAll('#browse .live-filter-row .pill-toggle')].find(b => b.textContent === 'Live now').classList.contains('active')`), 'Live-now should persist across visits');
  assert.ok(await page.eval(`![...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Future'))`), 'persisted Live-now still hides upcoming');
  // reset to defaults, then check the EPG chips + default ordering
  await page.eval(`[...document.querySelectorAll('#browse .live-filter-row .pill-toggle')].find(b => b.textContent === 'Live now').click()`);
  await page.eval(`(() => { const s = document.querySelector('#browse .live-filter-row select'); s.value = 'default'; s.dispatchEvent(new Event('change')); })()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Future'))`), 'upcoming match visible again');
  assert.strictEqual(await page.eval(`(() => { const c = [...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Alpha')); const chip = c.querySelector('.match-time'); return chip && chip.classList.contains('live') ? chip.textContent : null; })()`), 'LIVE', 'a started match should show a red LIVE chip');
  assert.ok(await page.eval(`(() => { const c = [...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Future')); const chip = c.querySelector('.match-time'); return chip && !chip.classList.contains('live') && chip.textContent.length > 0; })()`), 'an upcoming match should show a kickoff chip');
  assert.ok(await page.eval(`(() => { const ts = [...document.querySelectorAll('#browse .match-grid .match-card')].map(t => t.textContent); return ts.findIndex(x => x.includes('Alpha')) < ts.findIndex(x => x.includes('Future')); })()`), 'default order should put LIVE before upcoming');
  ok('live: sort/Live-now persist; LIVE + kickoff chips render; live-first default order');

  // 32g. auto-update banner: hidden at boot; showUpdate drives it; Restart calls install (stubbed)
  assert.strictEqual(await page.eval(`document.getElementById('update-banner').hidden`), true, 'update banner should be hidden at boot');
  await page.eval(`showUpdate({ type: 'progress', percent: 42 })`);
  assert.ok(await page.eval(`(() => { const el = document.getElementById('update-banner'); return !el.hidden && el.textContent.includes('42%'); })()`), 'progress banner should show the percent');
  await page.eval(`showUpdate({ type: 'ready', version: '9.9.9' })`);
  assert.ok(await page.eval(`document.getElementById('update-banner').textContent.includes('9.9.9')`), 'ready banner should show the version');
  await page.eval(`window.__installed = false; requestInstall = () => { window.__installed = true; };`); // stub the indirection
  await page.eval(`[...document.querySelectorAll('#update-banner button')].find(b => b.textContent === 'Restart').click()`);
  assert.strictEqual(await page.eval(`window.__installed`), true, 'Restart should trigger the install');
  await page.eval(`document.getElementById('update-banner').hidden = true`); // clear so it doesn't overlap later UI
  ok('update: banner shows progress/ready and Restart triggers install');

  // 32h. settings export/import round-trips all localStorage
  const exported = await page.eval(`JSON.stringify(exportSettings())`);
  assert.ok(exported.includes('sources'), 'export should include the sources key');
  await page.eval(`importSettings({ tmdbKey: JSON.stringify('imported-key-123'), sources: '[]' })`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('tmdbKey'))`), 'imported-key-123', 'import should write tmdbKey');
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('sources')).length`), 0, 'import should write sources');
  ok('settings: export dumps localStorage; import writes it back');

  // 32i. v15.2: Continue Watching uses the known TMDB title even when the embed page has NO og:title
  //      (the player fixture is a bare <video> page — stands in for VidSrc). Provider-agnostic: the
  //      source is a generic unnamed player, so the fix can't be keyed to any provider.
  await page.eval(`document.getElementById('home-btn').click()`); // leave any embed
  await page.eval(`sources.length = 0; cont.length = 0; later.length = 0; store('sources', sources); store('continue', cont); store('watchlater', later); renderSources();`);
  await page.eval(`addSource({ name: 'NoTitleSrc', url: '${PLAYER}', category: 'vod' })`); // embed = PLAYER (no og:title)
  await page.eval(`(() => { const k = document.getElementById('tmdb-key'); k.value = 'testkey'; k.dispatchEvent(new Event('change')); })()`);
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'movie').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'movie grid (no-title capture)');
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`!!document.querySelector('#detail .src-row')`), 'detail (no-title capture)');
  await page.eval(`document.querySelector('#detail .src-row').click()`); // Watch -> PLAYER embed (no og:title)
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/embed/movie/42')`), 'watch opened no-title embed');
  const capTitle = await until(() => page.eval(`(JSON.parse(localStorage.getItem('continue'))[0] || {}).title`), 'continue captured from no-title embed');
  assert.strictEqual(capTitle, 'Fixture Title', 'Continue Watching should use the TMDB title, not the empty/URL embed-page title');
  ok('capture: Continue Watching uses the known title when the embed page has no og:title');

  // 32j. v15.2 (bug b): topbar "+ Watch Later" while that embed plays stores the title, not the URL
  await page.eval(`later.length = 0; store('watchlater', later);`);
  await page.eval(`document.getElementById('watch-later').click()`);
  const wlTitle = await until(() => page.eval(`(JSON.parse(localStorage.getItem('watchlater'))[0] || {}).title`), 'topbar watch later added');
  assert.strictEqual(wlTitle, 'Fixture Title', 'topbar Watch Later should store the title, not the URL');
  ok('watch later: topbar uses the known title, not the URL');

  // 32k. v15.2: a live-catalog stream keeps its title in Watch Later and never enters Continue Watching
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`sources.length = 0; cont.length = 0; later.length = 0; store('sources', sources); store('continue', cont); store('watchlater', later);`);
  await page.eval(`addSource({ name: 'CatSrc', category: 'live', catalogUrl: '${CATALOG}/api/streams' })`);
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Alpha'))`), 'match cards (live capture)');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Alpha')).click()`);
  await until(() => page.eval(`document.querySelectorAll('#detail .src-row').length === 1`), 'source page for live capture');
  await page.eval(`document.querySelector('#detail .src-row').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/live/700'`), 'live match opened');
  await sleep(900); // let any capture attempt run (600ms debounce); /live/700 passes isMediaUrl, so the live flag is what must skip it
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('continue')).length`), 0, 'a live stream must not enter Continue Watching');
  await page.eval(`document.getElementById('watch-later').click()`);
  const liveWl = await until(() => page.eval(`JSON.parse(localStorage.getItem('watchlater'))[0]`), 'live watch later added');
  assert.strictEqual(liveWl.title, 'Alpha Match', 'live Watch Later should store the catalog title, not the URL');
  assert.strictEqual(liveWl.type, 'live', 'live Watch Later entry should be type live');
  ok('live: catalog stream keeps its title in Watch Later and stays out of Continue Watching');

  // 32l. v15.2 (bug d): a click originating in .card-actions must not open the show; the body still does
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`cont.length = 0; cont.push({ key: 'k1', title: 'CardShow', url: '${PLAYER}/embed/movie/99', poster: '', season: null, episode: null, type: 'movie', updatedAt: Date.now(), position: null, duration: null, note: '' }); store('continue', cont); topTab = 'continue'; subTab = 'all'; showHome();`);
  const openedFromActions = await page.eval(`(() => {
    const card = document.querySelector('#home .grid .card');
    card.onclick({ target: card.querySelector('.card-actions') }); // simulate a click on the ✕/dropdown area
    return !document.getElementById('webview').hidden;
  })()`);
  assert.strictEqual(openedFromActions, false, 'a click inside .card-actions must not open the show');
  await page.eval(`document.querySelector('#home .grid .card').click()`); // real click on the card body (target outside .card-actions)
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/embed/movie/99')`), 'a normal card-body click should still open the show');
  ok('card: clicks on the ✕/dropdown area do not open the show; the card body still does');

  // 32m. sidebar footer: shows the app version, and clicking it runs a manual update check
  await until(() => page.eval(`/^v\\d/.test(document.getElementById('version').textContent)`), 'version footer populated');
  await page.eval(`document.getElementById('version').click()`);
  await until(() => page.eval(`document.getElementById('update-status').textContent === 'dev build'`), 'manual check reports status (dev)');
  ok('footer: shows the app version and a manual update check reports status');

  // 32n. v15.3: with a TMDB id in the URL, capture prefers the TMDB title over the scraped og:title
  //       even with no intendedMedia (direct navigation). The site fixture's og:title is "Widow's Bay";
  //       tmdb fixture returns "Fixture Title" — so id-first titling must win.
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`(() => { const k = document.getElementById('tmdb-key'); k.value = 'testkey'; k.dispatchEvent(new Event('change')); })()`);
  await page.eval(`cont.length = 0; store('continue', cont); open('${SITE}/tv/428');`); // open() clears intendedMedia
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/tv/428')`), 'direct nav to id-bearing url');
  const capById = await until(() => page.eval(`(JSON.parse(localStorage.getItem('continue'))[0] || {}).title`), 'continue captured by id');
  assert.strictEqual(capById, 'Fixture Title', 'capture should use the TMDB title (by id), not the scraped og:title');
  ok('capture: prefers the TMDB title (by URL id) over the embed page og:title');

  // 32o. v15.3: healLibrary re-titles old junk entries from TMDB using the id in each URL
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`
    localStorage.removeItem('libraryHealed');
    cont.length = 0; later.length = 0;
    cont.push({ key: 'x#513', title: 'https://vidsrc.to/embed/tv/513/1/1', url: '${PLAYER}/embed/tv/513/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now(), position: null, duration: null, note: '' });
    later.push({ key: 'y#620', title: 'Vidking Player - Embedded Video', url: '${PLAYER}/embed/movie/620', poster: '', season: null, episode: null, type: 'movie', addedAt: Date.now() });
    store('continue', cont); store('watchlater', later);
  `);
  await page.eval(`healLibrary()`);
  await until(() => page.eval(`(JSON.parse(localStorage.getItem('continue'))[0] || {}).title === 'Fixture Title'`), 'continue entry healed');
  assert.strictEqual(await page.eval(`(JSON.parse(localStorage.getItem('watchlater'))[0] || {}).title`), 'Fixture Title', 'watch later entry not healed');
  ok('heal: old library entries re-titled from TMDB by URL id');

  // 32p. v0.1.4: per-card source dropdown switches + persists which source a show continues on
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`
    sources.length = 0; cont.length = 0; later.length = 0;
    addSource({ name: 'SrcA', url: '${SITE}', category: 'vod' });
    addSource({ name: 'SrcB', url: '${PLAYER}', category: 'vod' });
    cont.push({ key: 'tv#94997', title: 'Some Show', url: '${SITE}/embed/tv/94997/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now(), position: null, duration: null, note: '' });
    store('sources', sources); store('continue', cont);
    topTab = 'continue'; subTab = 'all'; showHome();
  `);
  await until(() => page.eval(`!!document.querySelector('#home .grid .card .card-source')`), 'card source dropdown present');
  assert.strictEqual(await page.eval(`(() => { const s = document.querySelector('#home .grid .card .card-source'); return s.options[s.selectedIndex].textContent; })()`), 'SrcA', 'default source should be the one it was saved from');
  await page.eval(`(() => { const s = document.querySelector('#home .grid .card .card-source'); s.value = '${PLAYER}'; s.dispatchEvent(new Event('change')); })()`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('continue'))[0].url`), `${PLAYER}/embed/tv/94997/1/1`, 'switching source should rebuild + persist the entry url');
  await page.eval(`document.querySelector('#home .grid .card').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/embed/tv/94997/1/1'`), 'card opens the switched source');
  ok('card: source dropdown switches + persists which source a show continues on');

  // 32q. v0.1.4: rekeyLibrary merges duplicate cards (same show, different source) into one
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`
    cont.length = 0;
    cont.push({ key: 'siteA#555', title: 'Dup Show', url: '${SITE}/embed/tv/555/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: 100, position: null, duration: null, note: '' });
    cont.push({ key: 'playerB#555', title: 'Dup Show', url: '${PLAYER}/embed/tv/555/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: 200, position: null, duration: null, note: '' });
    store('continue', cont);
  `);
  await page.eval(`rekeyLibrary()`);
  const merged = await page.eval(`JSON.parse(localStorage.getItem('continue'))`);
  assert.strictEqual(merged.length, 1, 'duplicate cards for the same show should merge into one');
  assert.strictEqual(merged[0].key, 'tv#555', 'merged entry should use the host-independent key');
  assert.ok(merged[0].url.includes('127.0.0.1:9312'), 'merge should keep the most-recently-updated (PLAYER, updatedAt 200)');
  ok('migration: rekeyLibrary merges duplicate cards for the same show');

  // 32q2. v0.4.3: rekeyLibrary writes only when something changed (a steady-state boot writes nothing).
  // store() is a const wrapping localStorage.setItem, so we spy on Storage.prototype.setItem to count.
  await page.eval(`document.getElementById('home-btn').click()`);
  const rekeyNoop = await page.eval(`(() => {
    cont.length = 0; later.length = 0;
    // a canonical (already mediaKey-shaped) entry + empty watchlater -> no key moves, no merge
    cont.push({ key: mediaKey('${SITE}/embed/tv/777/1/1'), title: 'Canon', url: '${SITE}/embed/tv/777/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: 100, position: null, duration: null, note: '' });
    const orig = Storage.prototype.setItem; let n = 0;
    Storage.prototype.setItem = function (k, v) { if (k === 'continue' || k === 'watchlater') n++; return orig.call(this, k, v); };
    try { rekeyLibrary(); return n; } finally { Storage.prototype.setItem = orig; }
  })()`);
  assert.strictEqual(rekeyNoop, 0, 'a no-op rekey (canonical keys, no dups) must not write the library');
  const rekeyMerge = await page.eval(`(() => {
    cont.length = 0; // legacy-keyed duplicate pair for one show -> key moves + merge -> a write must happen
    cont.push({ key: 'siteA#888', title: 'Dup', url: '${SITE}/embed/tv/888/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: 100, position: null, duration: null, note: '' });
    cont.push({ key: 'playerB#888', title: 'Dup', url: '${PLAYER}/embed/tv/888/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: 200, position: null, duration: null, note: '' });
    const orig = Storage.prototype.setItem; let n = 0;
    Storage.prototype.setItem = function (k, v) { if (k === 'continue' || k === 'watchlater') n++; return orig.call(this, k, v); };
    try { rekeyLibrary(); return { n, len: cont.length, key: cont[0].key }; } finally { Storage.prototype.setItem = orig; }
  })()`);
  assert.ok(rekeyMerge.n > 0, 'a merge must write the library');
  assert.strictEqual(rekeyMerge.len, 1, 'the duplicate pair still merges to one entry');
  assert.strictEqual(rekeyMerge.key, 'tv#888', 'merged entry uses the host-independent key');
  ok('rekey: writes only when a key moves or duplicates merge (no-op boot writes nothing)');

  // 32r. v0.1.4: live / non-rebuildable entries show a read-only source label, not a dropdown
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`
    sources.length = 0; cont.length = 0; later.length = 0;
    addSource({ name: 'MyLive', url: '${PLAYER}', category: 'live' });
    later.push({ key: 'live#1', title: 'Live Game', url: '${PLAYER}/live/xyz', poster: '', season: null, episode: null, type: 'live', addedAt: Date.now() });
    store('sources', sources); store('watchlater', later);
    topTab = 'later'; subTab = 'all'; showHome();
  `);
  await until(() => page.eval(`!!document.querySelector('#home .grid .card')`), 'live watch later card');
  assert.strictEqual(await page.eval(`!!document.querySelector('#home .grid .card .card-source')`), false, 'live entry should NOT have a source dropdown');
  assert.ok(await page.eval(`document.querySelector('#home .grid .card .card-source-label').textContent === 'MyLive'`), 'live entry should show a read-only source label');
  ok('card: live / non-rebuildable entries show a read-only source label');

  // 32r2. R4: an entry whose source host matches no current source shows a friendly label,
  //           not the raw loopback host:port.
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`
    sources.length = 0; cont.length = 0; later.length = 0;
    later.push({ key: 'live#2', title: 'Orphan Game', url: 'http://127.0.0.1:9911/live/abc', poster: '', season: null, episode: null, type: 'live', addedAt: Date.now() });
    store('sources', sources); store('watchlater', later);
    topTab = 'later'; subTab = 'all'; showHome();
  `);
  await until(() => page.eval(`!!document.querySelector('#home .grid .card .card-source-label')`), 'orphan-source card label');
  const orphanLabel = await page.eval(`document.querySelector('#home .grid .card .card-source-label').textContent`);
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(orphanLabel), 'unresolvable source shows a friendly label, not a raw IP host:port');
  assert.strictEqual(orphanLabel, 'Saved source', 'unresolvable source falls back to "Saved source"');
  ok('card: unresolvable source host shows a friendly label, not host:port');

  // 32s. v0.2.0: the rail opens the Settings screen; its tabs switch panels
  await page.eval(`document.getElementById('settings-btn').click()`);
  assert.strictEqual(await page.eval(`document.getElementById('settings').hidden`), false, 'settings should open from the rail');
  assert.strictEqual(await page.eval(`document.getElementById('browse').hidden`), true, 'browse should hide when settings opens');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#settings .settings-tabs .tab').length`), 9, 'settings should have 9 tabs (incl. Privacy & blocking)');
  await page.eval(`[...document.querySelectorAll('#settings .settings-tabs .tab')].find(t => t.textContent === 'Appearance').click()`);
  assert.ok(await page.eval(`!!document.querySelector('#settings .set-panel:not([hidden]) .swatches')`), 'Appearance tab should show the accent swatches');
  ok('settings: rail opens the screen; tabs switch panels');

  // 32t. v0.2.0: theme dark→light flips data-theme + a color var, and persists
  await page.eval(`[...document.querySelectorAll('#settings .set-panel:not([hidden]) .segmented button')].find(b => b.textContent === 'Light').click()`);
  assert.strictEqual(await page.eval(`document.documentElement.dataset.theme`), 'light', 'theme toggle should set data-theme=light');
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).theme`), 'light', 'theme should persist');
  assert.ok(await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#f4f5f7'`), 'light theme should change --bg');
  await page.eval(`[...document.querySelectorAll('#settings .set-panel:not([hidden]) .segmented button')].find(b => b.textContent === 'Dark').click()`); // back to dark
  ok('settings: theme dark→light flips data-theme + color var');

  // 32u. v0.2.0: an accent swatch updates --accent and persists
  await page.eval(`document.querySelector('#settings .swatches .swatch[data-c="#8b5cf6"]').click()`);
  assert.ok(await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#8b5cf6'`), 'accent swatch should update --accent');
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).accent`), '#8b5cf6', 'accent should persist');
  ok('settings: accent swatch updates --accent');

  // 32v. v0.2.0: poster size changes --poster-min
  await page.eval(`[...document.querySelectorAll('#settings .set-panel:not([hidden]) .segmented button')].find(b => b.textContent === 'Large').click()`);
  assert.ok(await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--poster-min').trim() === '200px'`), 'poster size Large should set --poster-min:200px');
  ok('settings: poster size changes --poster-min');

  // 32w. v0.2.0: a renderer toggle persists across reload
  await page.eval(`[...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('Autoplay trailers')).querySelector('input[type=checkbox]').click()`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).autoplayTrailers`), false, 'toggle should persist to settings');
  await page.eval(`location.reload()`);
  await until(() => page.eval(`[...document.querySelectorAll('#settings .set-row')].some(r => r.textContent.includes('Autoplay trailers'))`), 'settings Playback panel rebuilt after reload');
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).autoplayTrailers`), false, 'toggle should survive reload');
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('Autoplay trailers')).querySelector('input[type=checkbox]').checked`), false, 'rebuilt toggle should reflect the saved value');
  ok('settings: a renderer toggle persists across reload');

  // 32x. v0.2.0: Clear / Merge / Reset act on the library; Reset keeps sources + tmdbKey
  await page.eval(`window.confirm = () => true`); // fresh page after the reload
  await page.eval(`
    sources.length = 0; cont.length = 0; later.length = 0;
    addSource({ name: 'KeepSrc', url: '${SITE}', category: 'vod' });
    tmdbKey = 'keepkey'; store('tmdbKey', tmdbKey);
    cont.push({ key: 'tv#111', title: 'A', url: '${SITE}/embed/tv/111/1/1', season: 1, episode: 1, type: 'tv', poster: '', updatedAt: 100, position: null, duration: null, note: '' });
    cont.push({ key: 'player#111', title: 'A', url: '${PLAYER}/embed/tv/111/1/1', season: 1, episode: 1, type: 'tv', poster: '', updatedAt: 200, position: null, duration: null, note: '' });
    store('sources', sources); store('continue', cont);
  `);
  await page.eval(`[...document.querySelectorAll('#settings .set-btn')].find(b => b.textContent === 'Merge duplicates').click()`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('continue')).length`), 1, 'Merge duplicates should collapse the two entries');
  await page.eval(`[...document.querySelectorAll('#settings .set-btn')].find(b => b.textContent === 'Clear Continue Watching').click()`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('continue')).length`), 0, 'Clear Continue Watching should empty it');
  assert.ok(await page.eval(`[...document.querySelectorAll('#settings .set-btn')].some(b => b.textContent === 'Re-fetch titles')`), 'Re-fetch titles button should exist');
  await page.eval(`document.querySelector('#settings .swatches .swatch[data-c="#22c55e"]').click()`); // set a non-default accent
  await page.eval(`[...document.querySelectorAll('#settings .set-btn')].find(b => b.textContent === 'Reset settings').click()`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).accent`), '#4c8dff', 'Reset should restore the default accent');
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).theme`), 'dark', 'Reset should restore the default theme');
  assert.strictEqual(await page.eval(`(JSON.parse(localStorage.getItem('sources')) || []).length`), 1, 'Reset must NOT drop sources');
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('tmdbKey'))`), 'keepkey', 'Reset must NOT drop the TMDB key');
  ok('settings: Clear / Merge / Reset act correctly; Reset keeps sources + library');

  // 32w2. v0.2.4: the wizard renders its shell once — navigating a step does NOT rebuild the overlay
  //        (fixes the flash/rebuild on every click). Same .modal-overlay node before & after a step.
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`document.getElementById('add-source-btn').click()`);
  await until(() => page.eval(`!!document.querySelector('.modal-overlay')`), 'wizard open for render-once');
  await page.eval(`window.__ov = document.querySelector('.modal-overlay')`);
  await page.eval(`(() => { const i = document.querySelector('.wiz-input'); i.value = 'RenderOnce'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.wiz-next').click()`); // name -> category (a step change)
  await until(() => page.eval(`!!document.querySelector('.wiz-choices')`), 'advanced to the category step');
  assert.strictEqual(await page.eval(`document.querySelector('.modal-overlay') === window.__ov`), true, 'the overlay must be the same node across a step (no full rebuild/flash)');
  await page.eval(`document.querySelector('.wiz-x').click()`);
  ok('wizard: shell renders once — navigating a step does not rebuild the overlay');

  // 32w3. v0.2.6: unified live grid — one name-only card per match; clicking opens the source PAGE
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`settings.liveLanguage = ''; saveSettings(); sources.length = 0; store('sources', sources); addSource({ name: 'NestedCat', category: 'live', catalogUrl: '${CATALOG2}/api' }); renderSources();`);
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Team A'))`), 'unified match card renders');
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].filter(t => t.textContent.includes('Team A')).length`), 1, 'a multi-source match renders exactly one card');
  assert.ok(await page.eval(`!/[0-9]+\\s*source/i.test([...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Team A')).textContent)`), 'the card shows the name only (no source count)');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Team A')).click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && document.querySelectorAll('#detail .src-row').length === 2`), 'source page lists both sources');
  await page.eval(`document.querySelector('#detail .src-row').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL().startsWith('${PLAYER}/live/ch')`), 'picking a source embeds it');
  ok('live: unified grid, name-only card, source PAGE lists sources, pick embeds');

  // 32w4. v0.2.6: default live language floats matching sources to the top of the source page
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`settings.liveLanguage = 'Spanish'; saveSettings();`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Team A'))`), 'live grid re-rendered for language sort');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Team A')).click()`);
  await until(() => page.eval(`document.querySelectorAll('#detail .src-row').length === 2`), 'source page open for language sort');
  assert.strictEqual(await page.eval(`document.querySelector('#detail .src-row .src-lang').textContent`), 'Spanish', 'preferred language should sort to the top');
  assert.ok(await page.eval(`[...document.querySelectorAll('#detail .src-row .src-lang')].some(c => c.textContent === 'English')`), 'other languages are still listed (prefer but show all)');
  await page.eval(`settings.liveLanguage = ''; saveSettings();`);
  ok('live: default language floats matching sources to the top, others still shown');

  // 32w5. v0.2.6: cross-catalog team-order merge — "Team A vs Team B" + "Team B vs Team A" = one card
  await page.eval(`document.getElementById('home-btn').click()`);
  await page.eval(`sources.length = 0; store('sources', sources); addSource({ name: 'NestedCat', category: 'live', catalogUrl: '${CATALOG2}/api' }); addSource({ name: 'BCat', category: 'live', catalogUrl: '${CATALOG_B}/api' }); renderSources();`);
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].filter(t => /team [ab] vs team [ab]/i.test(t.textContent)).length === 1`), 'the reversed-order match merges into one card');
  // The cached catalog paints its single card one rAF before the second catalog's rows merge in (v0.4.3
  // debounced rebuild), so re-click the current card until the merged source page (both groups) is up.
  await until(async () => {
    await page.eval(`(() => { const c = [...document.querySelectorAll('#browse .match-grid .match-card')].find(t => /team [ab] vs team [ab]/i.test(t.textContent)); if (c) c.click(); })()`);
    return page.eval(`document.querySelectorAll('#detail .src-group').length >= 2`);
  }, 'the source page groups sources under both catalogs');
  assert.ok(await page.eval(`(() => { const n = [...document.querySelectorAll('#detail .src-group-name')].map(g => g.textContent); return n.includes('NestedCat') && n.includes('BCat'); })()`), 'both catalog groups present on the source page');
  await page.eval(`document.getElementById('home-btn').click()`); // leave the source page clean for the next tests
  ok('live: cross-catalog team-order merge pools sources under both catalogs');

  // 32w6. v0.2.7: the "Sources" overlay appears while a live match plays and reopens the source page
  await page.eval(`document.getElementById('home-btn').click(); sources.length = 0; store('sources', sources); addSource({ name: 'NestedCat', category: 'live', catalogUrl: '${CATALOG2}/api' }); renderSources();`);
  await page.eval(`document.getElementById('browse-btn').click(); document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Team A'))`), 'live grid for overlay test');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Team A')).click()`);
  await until(() => page.eval(`document.querySelectorAll('#detail .src-row').length === 2`), 'source page for overlay test');
  await page.eval(`document.querySelector('#detail .src-row').click()`); // play -> currentLiveMatch set, overlay shown
  await until(() => page.eval(`document.getElementById('webview').getURL().startsWith('${PLAYER}/live/ch')`), 'live embed playing');
  assert.strictEqual(await page.eval(`document.getElementById('sources-overlay').hidden`), false, 'the Sources overlay should show while a live match plays');
  await page.eval(`document.getElementById('sources-overlay').click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && document.querySelectorAll('#detail .src-row').length === 2`), 'overlay reopens the source page');
  ok('live: Sources overlay appears on the player and reopens the source page');

  // 32w7. v0.2.7: leaving a view cancels a pending capture (fixes the live/leave-race leak)
  await page.eval(`document.getElementById('home-btn').click(); cont.length = 0; store('continue', cont);`);
  await page.eval(`document.getElementById('webview').hidden = false; document.getElementById('webview').src = '${SITE}/tv/778899';`);
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/tv/778899')`), 'webview on a vod url');
  await page.eval(`intendedMedia = null; scheduleCapture();`);   // arm a capture, then immediately leave
  await page.eval(`showBrowse()`);                                // hideAll cancels the pending capture timer
  await sleep(1200);                                              // past the capture debounce
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('continue')).length`), 0, 'leaving a view should cancel the pending capture');
  // contrast: a capture that runs while still on the embed IS stored
  await page.eval(`(async () => { document.getElementById('webview').hidden = false; await captureCurrent(); })()`);
  assert.ok(await page.eval(`JSON.parse(localStorage.getItem('continue')).length >= 1`), 'a vod url still captured when not left (contrast)');
  ok('capture: leaving a view cancels a pending capture (fixes the live/leave leak)');

  // 32w8. v0.2.7: a YouTube-host Continue entry is purged on load (clears the leaked junk)
  await page.eval(`(() => { const c = JSON.parse(localStorage.getItem('continue') || '[]'); c.push({ key: 'yt#1', title: 'Some Video', url: 'https://www.youtube.com/watch?v=abc123', type: 'movie', season: null, episode: null, updatedAt: Date.now(), position: null, duration: null, note: '' }); localStorage.setItem('continue', JSON.stringify(c)); })()`);
  await page.eval(`location.reload()`);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden`), 'reloaded after seeding a youtube entry');
  assert.ok(!(await page.eval(`JSON.parse(localStorage.getItem('continue'))`)).some((c) => c.url.includes('youtube.com')), 'youtube-host entry purged from Continue Watching on load');
  ok('migration: youtube entries purged from Continue Watching on load');

  // 32L1. v0.2.8 layout: 📺 Live is reached from the rail and shows NO Movies/TV/Anime tab bar; 🔎 leaves Live.
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`!document.getElementById('browse').hidden`), 'live view shown from the rail');
  assert.strictEqual(await page.eval(`browseTab`), 'live', 'the 📺 rail button selects the live tab');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#browse .tabs').length`), 0, 'the Live view must not render the VOD tab bar');
  await page.eval(`document.getElementById('browse-btn').click()`);
  assert.notStrictEqual(await page.eval(`browseTab`), 'live', '🔎 Browse must leave the Live tab');
  await until(() => page.eval(`!!document.querySelector('#browse .tabs') && document.querySelectorAll('#browse .tabs .tab').length === 3`), 'VOD tab bar (3 tabs) restored after 🔎');
  ok('layout: 📺 Live shows no VOD tab bar; 🔎 returns to a VOD tab');

  // 32L2. v0.2.8 two-hop: a streamed-style catalog (matches list -> /stream/{source}/{id}) resolves on open.
  await page.eval(`document.getElementById('home-btn').click(); sources.length = 0; store('sources', sources); addSource({ name: 'TwoHop', category: 'live', catalogUrl: '${CATALOG_TWOHOP}/api/matches/live' }); renderSources();`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Hop Match'))`), 'two-hop match tile from hop 1');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Hop Match')).click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && document.querySelectorAll('#detail .src-row').length === 1`), 'hop 2 resolved a source row');
  assert.strictEqual(await page.eval(`document.querySelector('#detail .src-row .src-lang').textContent`), 'English', 'the resolved stream shows its language');
  assert.ok(await page.eval(`(document.querySelector('#detail .src-row .src-q')||{}).textContent === 'HD'`), 'the resolved stream shows an HD quality chip');
  await page.eval(`document.querySelector('#detail .src-row').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL().startsWith('${PLAYER}/live/900')`), 'clicking the resolved row plays the hop-2 embedUrl');
  ok('two-hop: streamed-style matches -> stream/{source}/{id} resolves + plays');

  // 32L3. v0.2.8 Resume: ⏯ reveals the last-watched page (no reload) + restores the live Sources UI.
  assert.strictEqual(await page.eval(`document.getElementById('resume-btn').hidden`), false, 'resume-btn should be visible after a watch');
  const resumeUrl = await page.eval(`document.getElementById('webview').src`);
  await page.eval(`showBrowse()`); // leave the player: webview hidden, src kept
  assert.strictEqual(await page.eval(`document.getElementById('webview').hidden`), true, 'webview hidden after leaving');
  await page.eval(`resumeLast()`);
  assert.strictEqual(await page.eval(`document.getElementById('webview').hidden`), false, 'resume must reveal the webview');
  assert.strictEqual(await page.eval(`document.getElementById('webview').src`), resumeUrl, 'resume keeps the same src (no reload)');
  assert.strictEqual(await page.eval(`document.getElementById('sources-overlay').hidden`), false, 'resume restores the live Sources overlay');
  ok('resume: ⏯ reveals the last-watched page and restores the live Sources UI');

  // 32F1. v0.2.10/.11 browse filters: Movies tab shows 6 filter selects; genre/language/country re-query.
  await page.eval(`document.getElementById('browse-btn').click()`); // -> Movies tab (resets off Live)
  await until(() => page.eval(`document.querySelectorAll('#browse .browse-filters select').length === 6`), 'six filter selects render');
  await until(() => page.eval(`[...document.querySelectorAll('#browse .grid .card')].some(c => c.textContent.includes('Disc P1'))`), 'discover page-1 card');
  await page.eval(`(() => { const s = document.querySelectorAll('#browse .browse-filters select')[0]; s.value = '28'; s.dispatchEvent(new Event('change')); })()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .grid .card')].some(c => c.textContent.includes('G28'))`), 'genre filter passes with_genres=28 to /discover');
  await page.eval(`(() => { const s = document.querySelectorAll('#browse .browse-filters select')[2]; s.value = 'ko'; s.dispatchEvent(new Event('change')); })()`); // Language
  await until(() => page.eval(`[...document.querySelectorAll('#browse .grid .card')].some(c => c.textContent.includes('Lko'))`), 'language filter passes with_original_language=ko');
  await page.eval(`(() => { const s = document.querySelectorAll('#browse .browse-filters select')[3]; s.value = 'KR'; s.dispatchEvent(new Event('change')); })()`); // Country
  await until(() => page.eval(`[...document.querySelectorAll('#browse .grid .card')].some(c => c.textContent.includes('CKR'))`), 'country filter passes with_origin_country=KR');
  ok('browse: filter bar renders 6 selects; genre/language/country re-query discover');

  // 32F2. v0.2.10 pagination: Prev disabled on page 1; Next loads page 2 (20/page), Prev then enabled.
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#browse .pager-btn')].find(b => b.textContent.includes('Prev')).disabled`), true, 'Prev disabled on page 1');
  await page.eval(`[...document.querySelectorAll('#browse .pager-btn')].find(b => b.textContent.includes('Next')).click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .grid .card')].some(c => c.textContent.includes('Disc P2'))`), 'Next loads page 2');
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#browse .pager-btn')].find(b => b.textContent.includes('Prev')).disabled`), false, 'Prev enabled on page 2');
  ok('browse: pager Prev/Next walks pages (Prev disabled on page 1)');

  // 32F2b. v0.3.3: browse filter selections persist per tab (Movies keeps its set; TV has its own)
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'tv').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .browse-filters select').length === 6`), 'TV filter bar rendered');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#browse .browse-filters select')[0].value`), '', 'TV tab should start with its own (empty) genre');
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'movie').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .browse-filters select').length === 6 && document.querySelectorAll('#browse .browse-filters select')[0].value === '28'`), 'Movies genre selection restored after a tab round-trip');
  await until(() => page.eval(`[...document.querySelectorAll('#browse .grid .card')].some(c => c.textContent.includes('G28'))`), 'restored genre still drives the discover query');
  ok('browse: filter selections persist per tab');

  // 32F1c. R4 progressive disclosure: Year/Language/Country/Provider hide behind a Filters toggle;
  //         the toggle is a button (not a select, so the 6-select order is untouched); badge counts active.
  await page.eval(`browseFilters.year=''; browseFilters.language=''; browseFilters.country=''; browseFilters.provider=''; browseFiltersExpanded=false; browsePage=1; renderBrowse()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .browse-filters .filter-adv').length === 4`), 'four advanced selects tagged .filter-adv');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#browse .browse-filters select').length`), 6, 'still exactly 6 selects (the toggle is a button)');
  assert.ok(await page.eval(`[...document.querySelectorAll('#browse .browse-filters .filter-adv')].every(s => getComputedStyle(s).display === 'none')`), 'advanced filters hidden by default');
  await page.eval(`document.querySelector('#browse .filter-toggle').click()`);
  assert.ok(await page.eval(`[...document.querySelectorAll('#browse .browse-filters .filter-adv')].every(s => getComputedStyle(s).display !== 'none')`), 'clicking the Filters toggle reveals the advanced selects');
  await page.eval(`(() => { const s = document.querySelectorAll('#browse .browse-filters select')[2]; s.value='ko'; s.dispatchEvent(new Event('change')); })()`); // Language
  await page.eval(`(() => { const s = document.querySelectorAll('#browse .browse-filters select')[3]; s.value='KR'; s.dispatchEvent(new Event('change')); })()`); // Country
  await until(() => page.eval(`(() => { const b = document.querySelector('#browse .filter-toggle .filter-badge'); return b && b.textContent === '2'; })()`), 'the Filters badge counts the two active advanced filters');
  ok('browse: advanced filters collapse behind the Filters toggle; badge counts active ones');

  // 32F3. v0.2.10 fix: opening the YouTube tab must NOT wipe the Resume target (untracked open).
  await page.eval(`document.getElementById('home-btn').click(); sources.length = 0; store('sources', sources); addSource({ name: 'TwoHop', category: 'live', catalogUrl: '${CATALOG_TWOHOP}/api/matches/live' }); renderSources();`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Hop Match'))`), 'live match for youtube-resume test');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => t.textContent.includes('Hop Match')).click()`);
  await until(() => page.eval(`document.querySelectorAll('#detail .src-row').length === 1`), 'source row for youtube-resume test');
  await page.eval(`document.querySelector('#detail .src-row').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL().startsWith('${PLAYER}/live/900')`), 'live embed playing before youtube');
  await page.eval(`document.getElementById('youtube-btn').click()`); // navigates the webview away, untracked
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('youtube.com')`), 'youtube tab opened');
  await page.eval(`resumeLast()`);
  await until(() => page.eval(`document.getElementById('webview').getURL().startsWith('${PLAYER}/live/900')`), 'Resume returns to the live show after YouTube (reload)');
  assert.strictEqual(await page.eval(`document.getElementById('sources-overlay').hidden`), false, 'Resume restores the live Sources overlay after YouTube');
  ok('resume: the YouTube tab does not wipe the Resume target');

  // 32Q1. v0.3.0: live catalog cache — re-entering the Live tab within the TTL does NOT refetch;
  //        ↻ Refresh forces a refetch; a loaded catalog shows a ✓ status chip.
  const hits0 = twoHopHits;
  await page.eval(`document.getElementById('home-btn').click(); document.getElementById('live-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Hop Match'))`), 'cached live grid renders');
  assert.strictEqual(twoHopHits, hits0, 're-entering the Live tab within the TTL must not refetch the catalog');
  assert.ok(await page.eval(`[...document.querySelectorAll('#browse .live-chip')].some(c => c.textContent.includes('✓'))`), 'a loaded catalog should show a ✓ status chip');
  await page.eval(`document.getElementById('live-refresh').click()`);
  await until(() => Promise.resolve(twoHopHits === hits0 + 1), '↻ Refresh refetches the catalog');
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(t => t.textContent.includes('Hop Match'))`), 'grid re-renders after refresh');
  ok('live: catalog cache skips refetch within TTL; ↻ Refresh refetches; ✓ chip shows');

  // 32Q2. v0.3.0: a dead catalog shows a ✕ failed status chip (nothing listens on 9399)
  await page.eval(`addSource({ name: 'DeadCat', category: 'live', catalogUrl: 'http://127.0.0.1:9399/x' })`);
  await page.eval(`document.getElementById('live-refresh').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .live-chip')].some(c => c.textContent.includes('DeadCat') && c.textContent.includes('✕'))`), 'dead catalog shows a ✕ chip');
  await page.eval(`sources = sources.filter((s) => s.name !== 'DeadCat'); store('sources', sources); renderSources();`);
  ok('live: a failed catalog is visible as a ✕ status chip');

  // 32Q3. v0.3.0: grid images are lazy-loaded. Build the cards directly (a rendered grid's <img> can be
  // onerror-removed when the fixture poster 404s, which races the assertion) — the attribute is what matters.
  assert.strictEqual(await page.eval(`posterCard('movie', { id: 1, title: 'T', poster_path: '/p.jpg' }).querySelector('img').loading`), 'lazy', 'poster images should be lazy');
  assert.strictEqual(await page.eval(`matchCard({ title: 'M', logo: '/x.png', sources: [] }).querySelector('img').loading`), 'lazy', 'match thumbs should be lazy');
  ok('perf: grid images use loading="lazy"');

  // 32Q3b. v0.4.5 F5: 'New' tile-tag overlays a poster released in the last 21 days; not for older releases
  assert.ok(await page.eval(`!!posterCard('movie', { id: 1, title: 'Fresh', poster_path: '/x.jpg', release_date: new Date(Date.now() - 3*86400000).toISOString().slice(0, 10) }).querySelector('.tile-tag.new')`), 'a recent release gets a New tag');
  assert.ok(await page.eval(`!posterCard('movie', { id: 2, title: 'Old', poster_path: '/x.jpg', release_date: '2020-01-01' }).querySelector('.tile-tag.new')`), 'an old release gets no New tag');
  ok('tiles: recent releases get a New tag, old ones do not');

  // 32Q3c. v0.4.5 F3: hovering a posterCard shows a floating preview (backdrop/title/meta/overview + CTAs).
  //        Drive the logic DIRECTLY — the attach gates on matchMedia('(hover:hover)') which reads false in the CI window.
  await page.eval(`(() => { const c = posterCard('movie', { id: 42, title: 'X', poster_path: '/x.jpg' }); document.getElementById('browse').append(c); window.__hpCard = c; })()`);
  await page.eval(`showHoverPreview(window.__hpCard, 'movie', { id: 42 })`);
  await until(() => page.eval(`!!document.querySelector('.hover-preview:not([hidden])')`), 'hover preview shown');
  assert.strictEqual(await page.eval(`document.querySelector('.hover-preview .hp-title').textContent`), 'Fixture Title', 'hover preview title wrong');
  assert.ok(await page.eval(`document.querySelector('.hover-preview .hp-overview').textContent.includes('A fixture overview.')`), 'hover preview overview missing');
  assert.ok(await page.eval(`document.querySelector('.hover-preview .hp-meta').textContent.includes('Drama')`), 'hover preview genres missing');
  // + Watch Later CTA adds an entry, then restore watchlater to its pre-test state
  const wlBeforeHp = (await page.eval(`JSON.parse(localStorage.getItem('watchlater') || '[]')`)).length;
  await page.eval(`document.querySelector('.hover-preview .hp-later').click()`);
  assert.strictEqual((await page.eval(`JSON.parse(localStorage.getItem('watchlater'))`)).length, wlBeforeHp + 1, 'hover + Watch Later did not add');
  await page.eval(`later.shift(); store('watchlater', later);`); // restore (addLater unshifts the new entry to index 0)
  // ▶ Details CTA routes to the native detail page (showDetail with the same id)
  await page.eval(`showHoverPreview(window.__hpCard, 'movie', { id: 42 })`);
  await until(() => page.eval(`!!document.querySelector('.hover-preview:not([hidden])')`), 'hover preview re-shown for Details');
  await page.eval(`document.querySelector('.hover-preview .hp-play').click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && !!(document.querySelector('#detail h1') || {}).textContent`), 'hp Details opened the detail page');
  await page.eval(`hideHoverPreview(); window.__hpCard.remove(); delete window.__hpCard;`);
  ok('hover preview: fetch-on-hover card shows detail; + Watch Later adds; ▶ Details opens the detail page');

  // 32Q4. v0.3.0: ⏯ Resume survives a restart (lastPlayed persisted) and restores the live UI
  await page.eval(`location.reload()`);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden`), 'reloaded for resume persistence');
  assert.strictEqual(await page.eval(`document.getElementById('resume-btn').hidden`), false, 'resume-btn should be visible after a restart');
  await page.eval(`resumeLast()`);
  await until(() => page.eval(`document.getElementById('webview').getURL().startsWith('${PLAYER}/live/900')`), 'resume reloads the last-watched live embed after restart');
  assert.strictEqual(await page.eval(`document.getElementById('sources-overlay').hidden`), false, 'resume restores the Sources overlay after restart');
  ok('resume: survives a restart and restores the live Sources UI');

  // 32Q5. v0.3.0: a library entry with a non-http URL (saved with no sources) cannot open the webview
  await page.eval(`(() => { later.unshift({ key: 'nosrc#1', title: 'NoSrc', url: 'tmdb:tv/42', type: 'tv', addedAt: Date.now() }); store('watchlater', later); })()`);
  await page.eval(`showBrowse(); document.getElementById('home-btn').click()`);
  await clickTab('.tabs', 'Watch Later');
  await until(() => page.eval(`[...document.querySelectorAll('#home .grid .card')].some(c => c.textContent.includes('NoSrc'))`), 'placeholder card renders');
  await page.eval(`[...document.querySelectorAll('#home .grid .card')].find(c => c.textContent.includes('NoSrc')).click()`);
  assert.strictEqual(await page.eval(`document.getElementById('webview').hidden`), true, 'a non-http entry must not open the webview');
  await page.eval(`later = later.filter((w) => w.key !== 'nosrc#1'); store('watchlater', later);`);
  ok('library: non-http placeholder entries cannot navigate the webview');

  // 32y. v0.2.1 (Part B): an in-page nav to a google-login host is popped out to a standalone window,
  //       and the webview does NOT follow. (will-navigate fires only for renderer-initiated nav.)
  await page.eval(`document.getElementById('webview').hidden = false; document.getElementById('webview').src = '${SITE}/login-origin'`);
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/login-origin')`), 'webview on origin page for login-intercept');
  const liTarget = await until(async () =>
    (await targets()).find((t) => t.url.includes('/login-origin') && t.webSocketDebuggerUrl), 'guest for login-intercept');
  const liGuest = await CDP.connect(liTarget.webSocketDebuggerUrl);
  await liGuest.eval(`location.href = '${UA_ECHO}/login'`); // renderer-initiated -> fires will-navigate
  const loginWin = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(UA_ECHO) && t.type === 'page'), 'standalone login window opened');
  assert.ok(loginWin, 'a google-login nav should open a standalone window');
  assert.ok(!(await page.eval(`document.getElementById('webview').getURL().startsWith('${UA_ECHO}')`)), 'the webview must NOT follow to the login host');
  liGuest.close();
  await closeTarget(loginWin.id);
  ok('login: in-page nav to a google-login host opens a standalone window, not the webview');

  // 32z. v0.4.2: YT hosts ALWAYS get cosmetic-CSS-only, regardless of the youtubeScriptlets setting
  //       (Layer 1 is now unconditional — engine scriptlets are NEVER injected on YouTube, since their
  //       <script> node insertion crashes the player via CSP). Cosmetic element-hiding (Sponsored feed
  //       tiles / masthead) still applies: the '###sh-cosmetic' rule hides #sh-cosmetic on the normal host
  //       AND the YouTube host. YouTube video-ad blocking moved to the preload pruner (tested in 37b).
  await page.eval(`document.getElementById('webview').hidden = false; document.getElementById('webview').src = '${SITE}/cosmetic-check'`);
  const ccTarget = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(`${SITE}/cosmetic-check`) && t.webSocketDebuggerUrl), 'guest for cosmetic-check');
  const ccGuest = await CDP.connect(ccTarget.webSocketDebuggerUrl);
  await until(() => ccGuest.eval(`getComputedStyle(document.getElementById('sh-cosmetic')).display === 'none'`), 'cosmetic hidden on a normal host');
  ccGuest.close();
  await page.eval(`document.getElementById('webview').src = '${YT_FIX}/'`);
  const ytTarget = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(YT_FIX) && t.webSocketDebuggerUrl), 'guest for yt-fix host');
  const ytGuest = await CDP.connect(ytTarget.webSocketDebuggerUrl);
  await until(() => ytGuest.eval(`getComputedStyle(document.getElementById('sh-cosmetic')).display === 'none'`),
    'cosmetic CSS injected on the YouTube host (sponsored-tile hiding)');
  ytGuest.close();
  ok('adblock: YouTube always gets cosmetic-CSS-only (no engine scriptlets); sponsored-tile hiding applies');

  // 33. WebAuthn neutered in guest pages (kills Google's "Choose a passkey" prompt)
  await page.eval(`
    document.getElementById('home').hidden = true;
    document.getElementById('browse').hidden = true;
    document.getElementById('webview').hidden = false;
    document.getElementById('webview').src = '${SITE}/webauthn-check';
  `);
  const waTarget = await until(async () =>
    (await targets()).find((t) => t.url === `${SITE}/webauthn-check` && t.webSocketDebuggerUrl), 'webauthn guest target');
  const waGuest = await CDP.connect(waTarget.webSocketDebuggerUrl);
  const pk = await until(() => waGuest.eval(`typeof window.PublicKeyCredential`), 'guest webauthn evaluated', 8000);
  assert.strictEqual(pk, 'undefined', 'WebAuthn not neutered in guest');
  waGuest.close();
  ok('webauthn: passkey API neutered in guest pages');

  // ---------- v0.3.1 ⚙ main-process settings (live toggles — placed last; they flip global behavior) ----------

  // 34. ad-block toggles live from Settings → Privacy & blocking (no restart)
  await page.eval(`document.getElementById('webview').hidden = false; document.getElementById('webview').src = '${SITE}/settings-live-check'`);
  const stTarget = await until(async () =>
    (await targets()).find((t) => t.url === `${SITE}/settings-live-check` && t.webSocketDebuggerUrl), 'guest for settings toggles');
  const stGuest = await CDP.connect(stTarget.webSocketDebuggerUrl);
  assert.strictEqual(await stGuest.eval(`fetch('${SITE}/ads-test-marker.js').then(() => 'loaded', () => 'blocked')`), 'blocked', 'ad request should start blocked');
  await page.eval(`document.getElementById('settings-btn').click()`); // webview hides; the guest stays alive
  const adToggle = `[...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('Ad-blocking')).querySelector('input[type=checkbox]')`;
  await page.eval(`${adToggle}.click()`);
  await until(async () => (await stGuest.eval(`fetch('${SITE}/ads-test-marker.js').then(() => 'loaded', () => 'blocked')`)) === 'loaded', 'ad-block off: ad request loads');
  await page.eval(`${adToggle}.click()`);
  await until(async () => (await stGuest.eval(`fetch('${SITE}/ads-test-marker.js').then(() => 'loaded', () => 'blocked')`)) === 'blocked', 'ad-block on: blocked again');
  ok('⚙ settings: ad-blocking toggles live (off → ad loads, on → blocked)');

  // 35. extra login pop-up hosts apply live: a cross-host popup is denied by default (test 5), allowed
  //     after adding the host through the Privacy input.
  await page.eval(`(() => { const i = document.getElementById('extra-auth-hosts'); i.value = '${UA_ECHO_HOST}'; i.dispatchEvent(new Event('change')); })()`);
  await sleep(400); // let the set-setting IPC land
  await stGuest.eval(`window.open('${UA_ECHO}/popup-live'); true`);
  const extraPop = await until(async () =>
    (await targets()).find((t) => t.type === 'page' && t.url.startsWith(`${UA_ECHO}/popup-live`)), 'popup to the user-added host opened');
  await closeTarget(extraPop.id);
  ok('⚙ settings: user-added login host allows its pop-up (live)');

  // 36. Google sign-in fix gate: off → the login-host fixture sees the Chrome UA; on → Firefox again.
  const uaToggle = `[...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('Google sign-in fix')).querySelector('input[type=checkbox]')`;
  await page.eval(`${uaToggle}.click()`); // off
  const uaOff = await until(async () => { const ua = await stGuest.eval(`fetch('${UA_ECHO}/').then(r => r.text())`); return (!ua.includes('Firefox') && ua.includes('Chrome')) ? ua : false; }, 'UA gate off: login host echoes Chrome UA');
  assert.ok(!uaOff.includes('Firefox') && uaOff.includes('Chrome'), 'gate off: the login host should see the normal Chrome UA');
  await page.eval(`${uaToggle}.click()`); // back on
  const uaOn = await until(async () => { const ua = await stGuest.eval(`fetch('${UA_ECHO}/').then(r => r.text())`); return ua.includes('Firefox') ? ua : false; }, 'UA gate on: login host echoes Firefox UA');
  assert.ok(uaOn.includes('Firefox'), 'gate on: Firefox UA restored');
  ok('⚙ settings: Google-UA spoof gates live (Chrome when off, Firefox when on)');

  // 37. settings.json roundtrip: an Advanced change lands in the main process file with the full ⚙ subset
  await page.eval(`(() => { const i = [...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('Live catalog timeout')).querySelector('input'); i.value = '42'; i.dispatchEvent(new Event('change')); })()`);
  await until(() => { try { return JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8')).catalogTimeoutSec === 42; } catch { return false; } }, 'settings.json roundtrip');
  const msFile = JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'));
  assert.strictEqual(msFile.catalogTimeoutSec, 42, 'catalogTimeoutSec should persist to settings.json');
  assert.strictEqual(msFile.adblock, true, 'adblock state should persist');
  assert.strictEqual(msFile.googleUaSpoof, true, 'googleUaSpoof state should persist');
  assert.deepStrictEqual(msFile.extraAuthHosts, [UA_ECHO_HOST], 'extraAuthHosts should persist as an array');
  stGuest.close();
  ok('⚙ settings: changes persist to userData/settings.json for the next launch');

  // ---------- v0.4.1 YouTube scriptlet kill-switch + ad-list refresh/status ----------

  // 37b. YouTube ad-blocking toggle now gates the PRELOAD config pruner (webview-preload.js), not engine
  //      scriptlets. Observable in the guest main world: the pruner proxies JSON.parse and strips ad fields
  //      (playerAds/adPlacements/adSlots) out of the object before returning it. ON -> adPlacements gone,
  //      other keys survive; OFF -> the pruner never installs, so adPlacements is left intact. Toggling OFF
  //      also persists youtubeScriptlets:false.
  const ytToggle = `[...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('YouTube ad-blocking')).querySelector('input[type=checkbox]')`;
  const pruneProbe = `JSON.stringify((() => { const r = JSON.parse('{"adPlacements":[1],"x":2}'); return { hasAd: 'adPlacements' in r, x: r.x }; })())`;
  // setting is ON by default -> pruner active on the YT fixture guest
  await page.eval(`document.getElementById('webview').hidden = false; document.getElementById('webview').src = '${YT_FIX}/prune-on'`);
  const onTarget = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(`${YT_FIX}/prune-on`) && t.webSocketDebuggerUrl), 'guest for yt-fix (pruner on)');
  const onGuest = await CDP.connect(onTarget.webSocketDebuggerUrl);
  const onRes = JSON.parse(await until(() => onGuest.eval(pruneProbe), 'pruner probe evaluated (on)'));
  assert.strictEqual(onRes.hasAd, false, 'pruner ON: JSON.parse should strip adPlacements');
  assert.strictEqual(onRes.x, 2, 'pruner ON: non-ad fields survive');
  onGuest.close();
  // turn it OFF -> the preload asks main, main says no, the pruner never installs
  await page.eval(`${ytToggle}.click()`);
  await sleep(400); // let set-setting land in the main process
  await page.eval(`document.getElementById('webview').src = '${YT_FIX}/prune-off'`);
  const offTarget = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(`${YT_FIX}/prune-off`) && t.webSocketDebuggerUrl), 'guest for yt-fix (pruner off)');
  const offGuest = await CDP.connect(offTarget.webSocketDebuggerUrl);
  const offRes = JSON.parse(await until(() => offGuest.eval(pruneProbe), 'pruner probe evaluated (off)'));
  assert.strictEqual(offRes.hasAd, true, 'pruner OFF: adPlacements should be left intact');
  offGuest.close();
  const msKill = JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'));
  assert.strictEqual(msKill.youtubeScriptlets, false, 'youtubeScriptlets:false should persist to settings.json');
  await page.eval(`${ytToggle}.click()`); // back on (default)
  await sleep(400);
  ok('⚙ YouTube pruner: JSON.parse strips ad fields when on, leaves them when off; persists youtubeScriptlets');

  // 37b2. auto-skip fallback: on a YT-fixture guest with the pruner active, a #movie_player that goes
  //       'ad-showing' is muted + fast-forwarded to the end and its skip button clicked (for ads the
  //       config pruner can't catch, e.g. server-side-inserted). The observer is on document.documentElement.
  await page.eval(`document.getElementById('webview').src = '${YT_FIX}/autoskip'`);
  const asTarget = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(`${YT_FIX}/autoskip`) && t.webSocketDebuggerUrl), 'guest for yt-fix (auto-skip)');
  const asGuest = await CDP.connect(asTarget.webSocketDebuggerUrl);
  await until(() => asGuest.eval('!!document.body'), 'auto-skip guest body ready');
  const asRes = await asGuest.eval(`new Promise((resolve) => {
    const mp = document.createElement('div'); mp.id = 'movie_player'; mp.className = 'ad-showing';
    const v = document.createElement('video'); let _ct = 0;
    Object.defineProperty(v, 'duration', { get: () => 100 });
    Object.defineProperty(v, 'currentTime', { get: () => _ct, set: (x) => { _ct = x; } });
    const skip = document.createElement('button'); skip.className = 'ytp-ad-skip-button-modern';
    window.__skipped = false; skip.addEventListener('click', () => { window.__skipped = true; });
    mp.appendChild(v); mp.appendChild(skip); document.body.appendChild(mp);
    requestAnimationFrame(() => mp.classList.add('ad-interrupting')); // force an attribute mutation too
    setTimeout(() => resolve({ muted: v.muted, ct: v.currentTime, dur: v.duration, skipped: window.__skipped }), 300);
  })`);
  assert.strictEqual(asRes.muted, true, 'auto-skip: the ad video should be muted');
  assert.strictEqual(asRes.ct, asRes.dur, 'auto-skip: the ad should be fast-forwarded to its end');
  assert.strictEqual(asRes.skipped, true, 'auto-skip: the skip button should be clicked');
  asGuest.close();
  ok('⚙ YouTube auto-skip: an ad-showing player is muted, fast-forwarded, and its skip button clicked');

  // 37c. sh.refreshAdlists() hot-swaps the engine with the ordered disable→enable — network blocking must
  //      survive the swap AND the YT/cosmetic wrapper must be re-applied on the new engine.
  const refreshRes = await page.eval(`sh.refreshAdlists()`);
  assert.strictEqual(refreshRes.ok, true, 'refreshAdlists should report ok');
  await page.eval(`document.getElementById('webview').hidden = false; document.getElementById('webview').src = '${SITE}/post-refresh'`);
  const prTarget = await until(async () =>
    (await targets()).find((t) => t.url.startsWith(`${SITE}/post-refresh`) && t.webSocketDebuggerUrl), 'guest after refresh');
  const prGuest = await CDP.connect(prTarget.webSocketDebuggerUrl);
  assert.strictEqual(await prGuest.eval(`fetch('${SITE}/ads-test-marker.js').then(() => 'loaded', () => 'blocked')`), 'blocked',
    'network blocking must survive the engine swap');
  await until(() => prGuest.eval(`getComputedStyle(document.getElementById('sh-cosmetic')).display === 'none'`),
    'cosmetic wrapper re-applied on the swapped-in engine');
  prGuest.close();
  ok('⚙ refreshAdlists: ordered swap keeps network blocking + re-applies the cosmetic wrapper');

  // 37d. sh.adblockStatus() reports the live engine state (test mode builds the parse() engine as 'full').
  const adState = await page.eval(`sh.adblockStatus()`);
  assert.strictEqual(adState.enabled, true, 'adblockStatus.enabled should be true');
  assert.ok(adState.at > 0, 'adblockStatus.at should be a real build timestamp');
  assert.strictEqual(adState.engine, 'full', 'test-mode engine should report as full');
  ok('⚙ adblockStatus reports enabled/full with a build timestamp');

  // 37e. Privacy panel renders the YouTube toggle, the Update button, and the live status line.
  await page.eval(`document.getElementById('settings-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#settings .settings-tabs .tab')].find(t => t.textContent === 'Privacy & blocking').click()`);
  assert.ok(await page.eval(`[...document.querySelectorAll('#settings .set-panel:not([hidden]) .set-row')].some(r => r.textContent.includes('YouTube ad-blocking'))`),
    'Privacy panel should have the YouTube ad-blocking row');
  assert.ok(await page.eval(`[...document.querySelectorAll('#settings .set-panel:not([hidden]) button')].some(b => b.textContent === 'Update ad lists now')`),
    'Privacy panel should have the Update ad lists button');
  assert.ok(await page.eval(`!!document.getElementById('adblock-state')`), 'Privacy panel should have the #adblock-state status node');
  await until(() => page.eval(`document.getElementById('adblock-state').textContent.includes('Full lists')`),
    '#adblock-state resolves to Full lists in test mode');
  // v0.4.3: the YouTube toggle + Update button carry stable ids (renderAdblockState greys by id, not a text scan)
  assert.ok(await page.eval(`!!document.getElementById('yt-scriptlets')`), 'YouTube toggle should carry id yt-scriptlets');
  assert.ok(await page.eval(`!!document.getElementById('adblock-update')`), 'Update button should carry id adblock-update');
  // greying: master ad-blocking off -> engine reports off -> both controls grey out (looked up by id)
  await page.eval(`(async () => { settings.adblock = false; saveSettings(); await pushMain(); await renderAdblockState(); })()`);
  await until(() => page.eval(`document.getElementById('yt-scriptlets').disabled && document.getElementById('adblock-update').disabled`),
    'YouTube toggle + Update button grey out when master ad-blocking is off');
  // a settings rebuild (the Reset path) recreates both nodes with fresh ids and re-greys them
  await page.eval(`rebuildSettings()`);
  assert.ok(await page.eval(`!!document.getElementById('yt-scriptlets') && !!document.getElementById('adblock-update')`),
    'a settings rebuild recreates the yt-scriptlets + adblock-update ids');
  await until(() => page.eval(`document.getElementById('yt-scriptlets').disabled && document.getElementById('adblock-update').disabled`),
    'greying re-applies after a settings rebuild');
  // restore ad-blocking on for the rest of the suite
  await page.eval(`(async () => { settings.adblock = true; saveSettings(); await pushMain(); await renderAdblockState(); })()`);
  await until(() => page.eval(`!document.getElementById('yt-scriptlets').disabled && !document.getElementById('adblock-update').disabled`),
    'controls re-enable when ad-blocking is turned back on');
  ok('⚙ Privacy panel: YouTube toggle + Update button + live ad-block status; greying by id survives a rebuild');

  // ---------- v0.3.2 topbar episode switcher + auto-play next ----------

  // 38. episode switcher: appears for TV, seasons/episodes from the TMDB fixture, same-source deep-link
  await page.eval(`tmdbKey = 'k'; sources.length = 0; store('sources', sources); addSource({ name: 'EpTest', url: '${PLAYER}', category: 'vod' }); addSource({ name: 'OtherSrc', url: '${SITE}', category: 'vod' });`);
  await page.eval(`openOn(sources.find(s => s.name === 'EpTest'), 'tv', 'tv', 42, 1, 1, 'Fixture Title', '')`);
  await until(() => page.eval(`!document.getElementById('ep-switch').hidden`), 'episode switcher appears');
  assert.strictEqual(await page.eval(`document.getElementById('ep-switch').value`), '1:1', 'current episode should be selected');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#ep-switch optgroup').length`), 2, 'two season groups');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#ep-switch option').length`), 10, '6+4 episode options');
  await page.eval(`(() => { const s = document.getElementById('ep-switch'); s.value = '1:2'; s.dispatchEvent(new Event('change')); })()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/embed/tv/42/1/2'`), 'episode change deep-links on the same source');
  ok('episodes: topbar switcher lists seasons/episodes and deep-links on change');

  // 39. movie playback hides the switcher
  await page.eval(`openOn(sources.find(s => s.name === 'EpTest'), 'movie', 'movie', 42, null, null, 'Fixture Title', '')`);
  await sleep(400); // renderEpisodeSwitch is async
  assert.strictEqual(await page.eval(`document.getElementById('ep-switch').hidden`), true, 'ep switcher hidden for movies');
  ok('episodes: switcher hidden for movie playback');

  // 40. autoplay next: near-end progress advances; S1 finale rolls into S2; series finale stops; toggle off no-ops
  await page.eval(`settings.autoplayNext = true; saveSettings();`);
  await page.eval(`openOn(sources.find(s => s.name === 'EpTest'), 'tv', 'tv', 42, 1, 6, 'Fixture Title', '')`);
  await until(() => page.eval(`!document.getElementById('ep-switch').hidden`), 'switcher ready (seasons cached)');
  await page.eval(`maybeAutoAdvance({ position: 590, duration: 600 })`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/embed/tv/42/2/1'`), 'S1 finale rolls into S2E1');
  await page.eval(`openOn(sources.find(s => s.name === 'EpTest'), 'tv', 'tv', 42, 2, 4, 'Fixture Title', '')`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/embed/tv/42/2/4'`), 'on the series finale');
  await page.eval(`maybeAutoAdvance({ position: 590, duration: 600 })`);
  await sleep(300);
  assert.strictEqual(await page.eval(`document.getElementById('webview').getURL()`), `${PLAYER}/embed/tv/42/2/4`, 'the series finale must not advance');
  await page.eval(`settings.autoplayNext = false; saveSettings();`);
  await page.eval(`openOn(sources.find(s => s.name === 'EpTest'), 'tv', 'tv', 42, 1, 1, 'Fixture Title', '')`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/embed/tv/42/1/1'`), 'back on S1E1');
  await page.eval(`maybeAutoAdvance({ position: 590, duration: 600 })`);
  await sleep(300);
  assert.strictEqual(await page.eval(`document.getElementById('webview').getURL()`), `${PLAYER}/embed/tv/42/1/1`, 'toggle off must not advance');
  ok('autoplay: advances near the end, rolls seasons, stops at the finale, respects the toggle');

  // 41. ⏭ topbar toggle flips + persists settings.autoplayNext
  await until(() => page.eval(`!document.getElementById('autonext-btn').hidden`), 'autonext button visible');
  await page.eval(`document.getElementById('autonext-btn').click()`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).autoplayNext`), true, '⏭ on should persist');
  assert.ok(await page.eval(`document.getElementById('autonext-btn').classList.contains('active')`), '⏭ should show active');
  await page.eval(`document.getElementById('autonext-btn').click()`);
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('settings')).autoplayNext`), false, '⏭ off should persist');
  ok('autoplay: ⏭ toggle flips + persists');

  // 42. library continue (R1+R6): a card click enables the switchers, and an episode change stays on
  //     the CARD's source even when the last-used player was a different one.
  await page.eval(`openOn(sources.find(s => s.name === 'OtherSrc'), 'movie', 'movie', 42, null, null, 'X', '')`); // lastSourceUrl -> OtherSrc
  // NB: a 3+ digit TMDB id — tmdbIdOf ignores short digit runs by design (host/port digits)
  await page.eval(`(() => { cont.length = 0; cont.push({ key: 'tv#428', title: 'Fixture Title', url: '${PLAYER}/embed/tv/428/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now(), position: null, duration: null, note: '' }); store('continue', cont); })()`);
  await page.eval(`document.getElementById('home-btn').click()`);
  await clickTab('.tabs', 'Continue Watching'); // an earlier test left the library on Watch Later
  await until(() => page.eval(`!!document.querySelector('#home .grid .card')`), 'library card for the R1 path');
  await page.eval(`document.querySelector('#home .grid .card').click()`);
  await until(() => page.eval(`!document.getElementById('ep-switch').hidden`), 'ep switcher appears from a library card');
  await page.eval(`(() => { const s = document.getElementById('ep-switch'); s.value = '1:3'; s.dispatchEvent(new Event('change')); })()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/embed/tv/428/1/3'`), 'episode change stays on the card source');
  ok('library: continue card enables the switchers; episode change pins the card source');

  // ---------- v0.3.4 keyboard navigation + command palette ----------
  const kd = (key, extra = '') => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}'${extra} }))`);

  // 43. exitPlayer: returns to the LAUNCHING view (library, from test 42's card); no-op while fullscreen
  await page.eval(`document.getElementById('webview').classList.add('fullscreen'); exitPlayer();`);
  assert.strictEqual(await page.eval(`document.getElementById('webview').hidden`), false, 'exitPlayer must no-op while the guest is fullscreen');
  await page.eval(`document.getElementById('webview').classList.remove('fullscreen'); exitPlayer();`);
  assert.strictEqual(await page.eval(`document.getElementById('home').hidden`), false, 'exitPlayer should return to the launching view (Library)');
  ok('keyboard: exitPlayer honors the launching view + fullscreen guard');

  // 44. arrow navigation across the live match grid (stride derived from computed style, clamped)
  await page.eval(`sources.push({ name: 'KbCat', category: 'live', catalogUrl: '${CATALOG}/api/streams' }); store('sources', sources); renderSources();`);
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .match-grid .match-card').length >= 3`), 'live grid for keyboard nav');
  await page.eval(`document.activeElement && document.activeElement.blur()`);
  await kd('ArrowRight'); // seeds focus on the first item
  assert.ok(await page.eval(`document.activeElement.classList.contains('match-card')`), 'ArrowRight should seed focus on a match card');
  const kIdx0 = await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].indexOf(document.activeElement)`);
  await kd('ArrowRight');
  const kIdx1 = await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].indexOf(document.activeElement)`);
  assert.strictEqual(kIdx1, kIdx0 + 1, 'ArrowRight should move one card right');
  const kClamp = await page.eval(`(() => { const g = document.querySelector('#browse .match-grid'); const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length; const items = [...g.querySelectorAll('.match-card')]; const i = items.indexOf(document.activeElement); return Math.max(0, Math.min(items.length - 1, i + cols)); })()`);
  await kd('ArrowDown');
  const kIdx2 = await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].indexOf(document.activeElement)`);
  assert.strictEqual(kIdx2, kClamp, 'ArrowDown should move by the derived column stride (clamped)');
  ok('keyboard: arrow navigation across the live grid');

  // 45. Enter opens a focused match; Enter on a focused source row plays it
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(c => c.textContent.includes('Beta')).focus()`);
  await kd('Enter');
  await until(() => page.eval(`!document.getElementById('detail').hidden && document.querySelectorAll('#detail .src-row').length >= 1`), 'Enter opens the source page');
  await page.eval(`document.querySelector('#detail .src-row').focus()`);
  await kd('Enter');
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/live/8'`), 'Enter on a source row plays it');
  ok('keyboard: Enter opens a match and starts a source row');

  // 46. digit tabs, / search focus, untracked YouTube (digit 5 must not clobber Resume)
  await page.eval(`showBrowse()`);
  await page.eval(`document.activeElement && document.activeElement.blur()`);
  await kd('2');
  assert.strictEqual(await page.eval(`browseTab`), 'tv', 'digit 2 should switch to the TV tab');
  await kd('4');
  await until(() => page.eval(`browseTab === 'live' && !!document.querySelector('#browse .match-grid')`), 'digit 4 opens the live grid');
  await kd('/'); // / now opens the global search hub from anywhere (Netflix-style), not the per-view box
  assert.strictEqual(await page.eval(`document.getElementById('search').hidden`), false, '/ should open the #search hub');
  assert.ok(await page.eval(`document.activeElement.matches('#search .browse-search')`), '/ should focus the hub search input');
  await kd('Escape'); // blurs the search
  const lpBefore = await page.eval(`localStorage.getItem('lastPlayed')`);
  await kd('5');
  await until(() => page.eval(`document.getElementById('webview').src.includes('youtube.com')`), 'digit 5 opens YouTube');
  assert.strictEqual(await page.eval(`localStorage.getItem('lastPlayed')`), lpBefore, 'digit 5 must not clobber the Resume target');
  ok('keyboard: digit tabs, / focuses search, YouTube stays untracked');

  // 47. Esc exits the player to its launching view; ? overlay; Ctrl+K palette runs an action
  await kd('Escape'); // player (launched from the live grid) -> back to live
  await until(() => page.eval(`!document.getElementById('browse').hidden && browseTab === 'live'`), 'Esc exits the player to the launching view');
  await kd('?');
  assert.ok(await page.eval(`!!document.querySelector('.modal-overlay.palette .help-key')`), '? should open the shortcuts overlay');
  await kd('Escape');
  assert.ok(await page.eval(`!document.querySelector('.modal-overlay.palette')`), 'Esc should close the overlay');
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
  await until(() => page.eval(`!!document.querySelector('.palette-input')`), 'Ctrl+K opens the palette');
  await page.eval(`(() => { const i = document.querySelector('.palette-input'); i.value = 'library'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
  await until(() => page.eval(`!document.getElementById('home').hidden && !document.querySelector('.palette-input')`), 'palette action runs and closes');
  ok('keyboard: Esc-to-origin, ? overlay, Ctrl+K palette');

  // 48. Esc model: Settings -> Browse; live source page -> live grid; wizard closes (blur, then close)
  await page.eval(`document.getElementById('settings-btn').click()`);
  await kd('Escape');
  assert.strictEqual(await page.eval(`document.getElementById('browse').hidden`), false, 'Esc on Settings should return to Browse');
  await page.eval(`document.getElementById('live-btn').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .match-grid .match-card').length >= 1`), 'live grid for the Esc test');
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')][0].click()`);
  await until(() => page.eval(`!document.getElementById('detail').hidden`), 'source page open for the Esc test');
  await kd('Escape');
  await until(() => page.eval(`!document.getElementById('browse').hidden && !!document.querySelector('#browse .match-grid')`), 'Esc on the live source page returns to the live grid');
  await page.eval(`document.getElementById('settings-btn').click(); document.getElementById('add-source-btn').click()`);
  await until(() => page.eval(`!document.getElementById('wizard').hidden`), 'wizard open for the Esc test');
  await kd('Escape'); // blurs the auto-focused input
  await kd('Escape'); // closes the wizard
  assert.strictEqual(await page.eval(`document.getElementById('wizard').hidden`), true, 'Esc should close the wizard');
  ok('keyboard: Esc model — Settings, live source page, wizard');

  // ---------- v0.3.5 dashboard + onboarding + shared states ----------

  // 49. dashboard: Continue / Trending / Live-now rails from existing state (live rail = warm cache)
  await page.eval(`document.getElementById('dash-btn').click()`);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden`), 'dashboard shown from the rail');
  assert.ok(await page.eval(`[...document.querySelectorAll('#dashboard .rail .card')].some(c => c.textContent.includes('Fixture Title'))`), 'Continue rail should reuse the library card');
  await until(() => page.eval(`[...document.querySelectorAll('#dashboard .rail .card')].some(c => c.textContent.includes('Disc P1'))`), 'Trending rail fills from /discover (popularity)');
  assert.ok(await page.eval(`document.querySelectorAll('#dashboard .rail .match-card').length >= 1`), 'Live-now rail should render match cards from the warm cache');
  ok('dashboard: Continue / Trending / Live-now rails render');

  // 50. See-all routes; a card launched from the dashboard enables the switchers and Esc-returns to it
  await page.eval(`[...document.querySelectorAll('#dashboard .dash-seeall')][0].click()`); // Continue -> Library
  assert.strictEqual(await page.eval(`document.getElementById('home').hidden`), false, 'Continue See-all should open the Library');
  await page.eval(`document.getElementById('dash-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#dashboard .rail .card')].some(c => c.textContent.includes('Fixture Title'))`), 'back on the dashboard');
  await page.eval(`[...document.querySelectorAll('#dashboard .rail .card')].find(c => c.textContent.includes('Fixture Title')).click()`);
  await until(() => page.eval(`!document.getElementById('webview').hidden && !document.getElementById('ep-switch').hidden`), 'dashboard card plays + enables the switchers (library card reuse)');
  await page.eval(`exitPlayer()`);
  assert.strictEqual(await page.eval(`document.getElementById('dashboard').hidden`), false, 'exitPlayer should return to the dashboard it launched from');
  ok('dashboard: See-all routes; card reuse + Esc returns to the dashboard');

  // 51. mutating a card from the dashboard refreshes the visible rail (not just the hidden Library)
  await page.eval(`document.querySelector('#dashboard .rail .card button[title="Remove"]').click()`);
  await until(() => page.eval(`![...document.querySelectorAll('#dashboard .rail .card')].some(c => c.textContent.includes('Fixture Title'))`), '✕ from the dashboard removes the card from the rail');
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('continue')).length`), 0, 'the entry should be gone from storage');
  ok('dashboard: card mutations refresh the visible rail');

  // 52. the dashboard Live-now rail FETCHES the top matches itself (first hop only; two-hop resolve stays
  // lazy). Seed one two-hop live catalog + clear the cache, open the dashboard: it warms the catalog and
  // renders the match. Then remove all live sources + clear the cache -> the Live-now rail is absent.
  await page.eval(`sources = sources.filter(s => s.category !== 'live'); sources.push({ name: 'DashHop', category: 'live', catalogUrl: '${CATALOG_TWOHOP}/api/matches/live' }); store('sources', sources); liveCatalogCache.clear();`);
  const dashHits = twoHopHits;
  await page.eval(`document.getElementById('dash-btn').click()`);
  await until(() => twoHopHits > dashHits, 'dashboard warms the live catalog');
  await until(() => page.eval(`[...document.querySelectorAll('#dashboard .rail .match-card')].some(c => c.textContent.includes('Hop Match'))`), 'live match rendered on the dashboard');
  await page.eval(`sources = sources.filter(s => s.category !== 'live'); store('sources', sources); liveCatalogCache.clear(); showDashboard();`);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden`), 'dashboard re-rendered with no live sources');
  await until(() => page.eval(`document.querySelectorAll('#dashboard .match-card').length === 0 && ![...document.querySelectorAll('#dashboard .dash-section h2')].some(h => h.textContent === 'Live now')`), 'no catalog -> Live-now rail absent');
  ok('dashboard: live rail fetches the top matches; no catalog -> rail absent');

  // 53. rail keyboard nav (←/→ walk the rail, ↑/↓ hop rails), digit 0, and the palette entry
  await page.eval(`(() => { cont.length = 0;
    cont.push({ key: 'tv#428', title: 'Fixture Title', url: '${PLAYER}/embed/tv/428/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: 2, position: null, duration: null, note: '' });
    cont.push({ key: 'movie#500', title: 'Second Card', url: '${PLAYER}/embed/movie/500', poster: '', season: null, episode: null, type: 'movie', updatedAt: 1, position: null, duration: null, note: '' });
    store('continue', cont); })()`);
  await page.eval(`document.getElementById('dash-btn').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#dashboard .rail .card')].some(c => c.textContent.includes('Disc P1'))`), 'dashboard rails ready for keyboard nav');
  await page.eval(`document.activeElement && document.activeElement.blur()`);
  await kd('ArrowRight'); // seeds focus on the first rail item
  assert.ok(await page.eval(`!!document.activeElement.closest('#dashboard .rail')`), 'arrow should seed focus on a rail item');
  const r0 = await page.eval(`[...document.activeElement.closest('.rail').querySelectorAll('.card')].indexOf(document.activeElement)`);
  await kd('ArrowRight');
  const r1 = await page.eval(`[...document.activeElement.closest('.rail').querySelectorAll('.card')].indexOf(document.activeElement)`);
  assert.strictEqual(r1, r0 + 1, 'ArrowRight should walk the rail');
  await kd('ArrowDown');
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#dashboard .rail')].indexOf(document.activeElement.closest('.rail'))`), 1, 'ArrowDown should hop to the next rail');
  await page.eval(`showBrowse(); document.activeElement && document.activeElement.blur()`);
  await kd('0');
  assert.strictEqual(await page.eval(`document.getElementById('dashboard').hidden`), false, 'digit 0 should open the dashboard');
  await page.eval(`showBrowse()`);
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
  await until(() => page.eval(`!!document.querySelector('.palette-input')`), 'palette for the dashboard action');
  await page.eval(`(() => { const i = document.querySelector('.palette-input'); i.value = 'dashboard'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden && !document.querySelector('.palette-input')`), 'palette Open Dashboard runs');
  ok('dashboard: rail arrows, digit 0, palette entry');

  // 54. shared stateNode classes; the 3-option landing control; landingView 'library' still boots there
  assert.strictEqual(await page.eval(`stateNode('empty', 'x').className`), 'empty', "stateNode('empty') must keep the .empty class");
  assert.strictEqual(await page.eval(`stateNode('loading', 'x').className`), 'loading', 'stateNode loading class');
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('Landing view')).querySelectorAll('.segmented button').length`), 3, 'Landing view should offer Dashboard/Browse/Library');
  await page.eval(`settings.landingView = 'library'; saveSettings(); location.reload()`);
  await until(() => page.eval(`!document.getElementById('home').hidden`), "landingView 'library' boots to the Library");
  await page.eval(`settings.landingView = 'dashboard'; saveSettings();`);
  ok('states + settings: stateNode classes; landing control; library landing intact');

  // 55. onboarding actions: the wizard + Settings buttons work (empty profile simulated in-memory)
  await page.eval(`tmdbKey = ''; sources = []; showDashboard();`);
  await until(() => page.eval(`!!document.getElementById('onboard-add')`), 'onboarding card renders for an empty profile');
  await page.eval(`document.getElementById('onboard-add').click()`);
  await until(() => page.eval(`!document.getElementById('wizard').hidden`), 'onboarding opens the add-source wizard');
  await page.eval(`document.getElementById('wizard').hidden = true; document.getElementById('wizard').replaceChildren();`);
  await page.eval(`showDashboard(); [...document.querySelectorAll('#dashboard .onboard-card .set-btn')].find(b => b.textContent.includes('Settings')).click()`);
  assert.strictEqual(await page.eval(`document.getElementById('settings').hidden`), false, 'onboarding should route to Settings for the key');
  ok('onboarding: buttons open the wizard and Settings');

  // ---------- v0.3.6 "What's New" modal ----------

  // 56. rendering: bullets + **bold**, heading stripped, wrapped continuations joined; Esc closes
  await page.eval(`openWhatsNew('9.9.9', '## v9.9.9 — Big (July 2026)\\n\\n- **Bold** item one\\n- Item two\\n  wrapped continuation\\n')`);
  await until(() => page.eval(`!!document.querySelector('.whats-new')`), "What's New modal renders");
  assert.ok(await page.eval(`document.querySelector('.whats-new h3').textContent.includes('9.9.9')`), 'modal heading shows the version');
  assert.strictEqual(await page.eval(`document.querySelectorAll('.whats-new .wn-bullet').length`), 2, 'two bullet rows expected');
  assert.strictEqual(await page.eval(`document.querySelector('.whats-new .wn-bullet strong').textContent`), 'Bold', '**bold** should render as <strong>');
  assert.ok(await page.eval(`[...document.querySelectorAll('.whats-new .wn-bullet')][1].textContent.includes('wrapped continuation')`), 'indented continuation should join its bullet');
  assert.ok(!(await page.eval(`[...document.querySelectorAll('.whats-new .wn-bullet, .whats-new .wn-text')].some(n => n.textContent.includes('##'))`)), 'headings should be stripped');
  await kd('Escape');
  assert.ok(await page.eval(`!document.querySelector('.whats-new')`), 'Esc should close the modal');
  ok("what's new: renders bullets/bold, Esc closes");

  // 57. trigger: a stored lastSeenVersion older than the running version shows the modal once at boot
  //     (no release exists for the dev version -> the 404/fallback path, so no live notes needed)
  await page.eval(`localStorage.setItem('lastSeenVersion', JSON.stringify('0.0.1'))`);
  await page.eval(`location.reload()`);
  await until(() => page.eval(`!!document.querySelector('.whats-new')`), 'upgrade detected on boot', 30000);
  assert.notStrictEqual(await page.eval(`JSON.parse(localStorage.getItem('lastSeenVersion'))`), '0.0.1', 'lastSeenVersion should advance to the running version');
  await page.eval(`closeWhatsNew()`);
  await page.eval(`location.reload()`);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden`), 'reloaded on the same version');
  await sleep(800); // the trigger is async — give a would-be modal time to (not) appear
  assert.ok(await page.eval(`!document.querySelector('.whats-new')`), 'same version -> no modal on the next boot');
  ok("what's new: shows once per version bump");

  // ---------- v0.4.0 cinematic pass ----------

  // 58. dashboard hero: features the resume item (backdrop + logo + ▶ Resume CTA that actually plays)
  await page.eval(`document.getElementById('dash-btn').click()`);
  await until(() => page.eval(`!!document.querySelector('#dashboard .dash-hero .hero-inner')`), 'hero fills from the resume item');
  assert.ok(await page.eval(`!!document.querySelector('.dash-hero .hero-btn.primary')`), 'resume-hero should offer a ▶ Resume CTA');
  assert.ok(await page.eval(`(document.querySelector('.dash-hero .hero-bg img')||{}).src?.includes('/b.jpg')`), 'hero backdrop comes from the fixture');
  assert.ok(await page.eval(`(document.querySelector('.dash-hero .hero-logo')||{}).src?.includes('/logo.png')`), 'hero logo art from images.logos');
  assert.ok(await page.eval(`document.querySelector('.dash-hero .hero-title').textContent.length > 0`), 'text title kept as fallback');
  await page.eval(`document.querySelector('.dash-hero .hero-btn.primary').click()`);
  await until(() => page.eval(`!document.getElementById('webview').hidden && document.getElementById('webview').getURL().includes('/embed/tv/428')`), 'hero Resume plays the continue item');
  await page.eval(`exitPlayer()`);
  await until(() => page.eval(`!document.getElementById('dashboard').hidden`), 'back on the dashboard');
  ok('hero: resume-first with backdrop + logo; ▶ Resume plays');

  // 59. hero falls back to trending when there is no resume item (and offers no fake Play)
  await page.eval(`cont.length = 0; store('continue', cont); renderDashboard();`);
  await until(() => page.eval(`!!document.querySelector('.dash-hero .hero-inner') && !document.querySelector('.dash-hero .hero-btn.primary')`), 'trending-hero has no Resume CTA');
  assert.ok(await page.eval(`document.querySelector('.dash-hero .hero-title').textContent.includes('Disc')`), 'trending hero titled from discover');
  ok('hero: trending fallback without a Resume CTA');

  // ---------- v0.4.4 rotating multi-hero + TOP 10 badge ----------

  // 59a. carousel structure: resume slide 0 + trending slides; one dot per slide, slide 0 active.
  //      Fixture returns 1 trending row, so resume + trending => 2 slides (enough to exercise multi-slide).
  await page.eval(`(() => { cont.length = 0;
    cont.push({ key: 'tv#428', title: 'Fixture Title', url: '${PLAYER}/embed/tv/428/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now(), position: 1234, duration: 6000, note: '' });
    store('continue', cont); showDashboard(); })()`);
  await until(() => page.eval(`!!document.querySelector('#dashboard .hero-slides > .hero-inner')`), 'hero carousel builds slides');
  const [dotCount, slideCount] = await page.eval(`[document.querySelectorAll('#dashboard .hero-dot').length, document.querySelectorAll('#dashboard .hero-slides > .hero-inner').length]`);
  assert.strictEqual(dotCount, slideCount, 'one hero-dot per slide');
  assert.ok(await page.eval(`document.querySelector('#dashboard .hero-slides > .hero-inner').classList.contains('active')`), 'slide 0 is the active slide');

  // dot click swaps the active slide (guarded: only when the fixture yields >1 slide)
  if (slideCount > 1) {
    await page.eval(`document.querySelectorAll('#dashboard .hero-dot')[1].click()`);
    assert.ok(await page.eval(`document.querySelectorAll('#dashboard .hero-slides > .hero-inner')[1].classList.contains('active')`), 'clicking dot 2 activates slide 2');
    assert.ok(await page.eval(`!document.querySelectorAll('#dashboard .hero-slides > .hero-inner')[0].classList.contains('active')`), 'slide 0 loses .active after dot click');
  }

  // auto-advance is deterministic via the module-level heroTimer (bare-name in page.eval, like cont/settings):
  // armed under normal motion with >1 slide, NOT armed under reduced-motion.
  await page.eval(`document.body.classList.remove('reduced-motion'); showDashboard();`);
  await until(() => page.eval(`document.querySelectorAll('#dashboard .hero-slides > .hero-inner').length > 1`), 'multi-slide carousel built (normal motion)');
  assert.ok(await page.eval(`heroTimer !== null`), 'auto-advance interval is armed with >1 slide');
  await page.eval(`document.body.classList.add('reduced-motion'); showDashboard();`);
  await until(() => page.eval(`document.querySelectorAll('#dashboard .hero-slides > .hero-inner').length > 1`), 'carousel rebuilt under reduced-motion');
  assert.strictEqual(await page.eval(`heroTimer`), null, 'reduced-motion arms no auto-advance interval');
  await page.eval(`document.body.classList.remove('reduced-motion'); clearInterval(heroTimer); heroTimer = null;`); // no stray tick into later tests
  ok('hero carousel: one dot per slide, dot-click swaps active, heroTimer armed only under normal motion');

  // 59b. TOP 10 rank badge: numbered overlay on the top10 rail's poster cards, reading 01..
  await page.eval(`settings.dashRails = ['continue', 'top10']; saveSettings(); showDashboard();`);
  await until(() => page.eval(`!!document.querySelector('#dashboard .rank-badge')`), 'TOP 10 rank badge renders');
  assert.ok(await page.eval(`[...document.querySelectorAll('#dashboard .rank-badge')].some(b => b.textContent === '01')`), 'first TOP 10 card badge reads 01');
  await page.eval(`settings.dashRails = ['continue', 'trending', 'top10', 'live']; saveSettings();`);
  ok('TOP 10: numbered rank badge (01) overlays the poster');

  // 60. resume cards: 16:9 chips (timestamp / Completed), relative time, backdrop swap via tmdbMeta
  await page.eval(`(() => { cont.length = 0;
    cont.push({ key: 'tv#428', title: 'Fixture Title', url: '${PLAYER}/embed/tv/428/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now() - 3*86400000, position: 1234, duration: 6000, note: '' });
    cont.push({ key: 'movie#500', title: 'Done Movie', url: '${PLAYER}/embed/movie/500', poster: '', season: null, episode: null, type: 'movie', updatedAt: Date.now(), position: 5900, duration: 6000, note: '' });
    store('continue', cont); renderDashboard(); })()`);
  await until(() => page.eval(`document.querySelectorAll('#dashboard .rail .resume-card').length === 2`), 'resume cards render');
  assert.ok(await page.eval(`[...document.querySelectorAll('.resume-card .resume-chip')].some(c => c.textContent === '20:34')`), 'timestamp chip formats the position');
  assert.ok(await page.eval(`[...document.querySelectorAll('.resume-card .resume-chip.done')].some(c => c.textContent === 'Completed')`), 'Completed chip at >=95%');
  assert.ok(await page.eval(`[...document.querySelectorAll('.resume-card .card-sub')].some(s => s.textContent === '3 days ago')`), 'relative-time sub-line');
  await until(() => page.eval(`[...document.querySelectorAll('.resume-card img')].some(i => i.src.includes('w780'))`), 'backdrop swapped in via tmdbMeta');
  ok('resume cards: chips + relative time + backdrop swap');

  // 61. skeletons occupy the layout synchronously while fetches resolve
  assert.ok(await page.eval(`(() => { renderDashboard(); return document.querySelectorAll('#dashboard .skel').length; })()`) >= 2, 'hero + trending skeletons render before any fetch resolves');
  assert.strictEqual(await page.eval(`skeletonCards(3, 'skel-wide')[0].className`), 'skel skel-wide', 'skeleton builder shapes');
  ok('skeletons: reserved-shape placeholders render synchronously');

  // 62. light theme: token-driven colors flip (the hardcoded dark pairs are gone)
  await page.eval(`document.documentElement.dataset.theme = 'light'`);
  assert.strictEqual(await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--bg-rgb').trim()`), '244, 245, 247', 'light --bg-rgb token');
  const tileBg = await page.eval(`(() => { const t = document.createElement('div'); t.className = 'tile'; document.getElementById('browse').append(t); const v = getComputedStyle(t).backgroundImage; t.remove(); return v; })()`);
  assert.ok(!tileBg.includes('58, 47, 47'), 'tile gradient no longer hardcodes #3a2f2f');
  await page.eval(`document.documentElement.dataset.theme = 'dark'`);
  ok('light theme: tokens flip, hardcoded darks gone');

  // 63. toast: renders and auto-expires (single, replace-in-place)
  await page.eval(`toast('Test toast')`);
  assert.ok(await page.eval(`(document.getElementById('toast')||{}).textContent?.includes('Test toast')`), 'toast renders');
  await until(() => page.eval(`!document.getElementById('toast')`), 'toast auto-expires', 8000);
  ok('toast: shows and expires');

  // 64. reduced-motion class kills animation (incl. pseudo-element shimmer)
  await page.eval(`document.body.classList.add('reduced-motion')`);
  assert.strictEqual(await page.eval(`(() => { const s = document.createElement('div'); s.className = 'skel'; document.body.append(s); const v = getComputedStyle(s, '::after').animationName; s.remove(); return v; })()`), 'none', 'shimmer gated off');
  await page.eval(`document.body.classList.remove('reduced-motion')`);
  ok('motion: reduced-motion class disables animation');

  // 64b. v0.4.5 F4: Ken Burns drifts the hero backdrop (transform), double-gated by reduced-motion
  await page.eval(`(() => { cont.length = 0;
    cont.push({ key: 'tv#428', title: 'Fixture Title', url: '${PLAYER}/embed/tv/428/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now(), position: 1234, duration: 6000, note: '' });
    store('continue', cont); showDashboard(); })()`);
  await until(() => page.eval(`!!document.querySelector('#dashboard .dash-hero .hero-bg img')`), 'hero backdrop img present');
  assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('.dash-hero .hero-bg img')).animationName`), 'hero-kenburns', 'Ken Burns animates the backdrop under normal motion');
  await page.eval(`document.body.classList.add('reduced-motion')`);
  assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('.dash-hero .hero-bg img')).animationName`), 'none', 'reduced-motion kills Ken Burns');
  await page.eval(`document.body.classList.remove('reduced-motion')`);
  ok('hero: Ken Burns transform on the backdrop, gated by reduced-motion');

  // 65. rail edge fades track scrollability
  await page.eval(`(() => { cont.length = 0;
    for (let i = 0; i < 12; i++) cont.push({ key: 'tv#42' + i, title: 'R' + i, url: '${PLAYER}/embed/tv/' + (420 + i) + '/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now(), position: null, duration: null, note: '' });
    store('continue', cont); renderDashboard(); })()`);
  await until(() => page.eval(`document.querySelectorAll('#dashboard .rail .resume-card').length >= 12`), 'wide rail rendered');
  await until(() => page.eval(`document.querySelector('#dashboard .rail').classList.contains('fade-r')`), 'right edge fade when scrollable');
  assert.ok(await page.eval(`!document.querySelector('#dashboard .rail').classList.contains('fade-l')`), 'no left fade at the start');
  await page.eval(`(() => { const r = document.querySelector('#dashboard .rail'); r.scrollLeft = 200; r.dispatchEvent(new Event('scroll')); })()`);
  await until(() => page.eval(`document.querySelector('#dashboard .rail').classList.contains('fade-l')`), 'left fade after scrolling'); // fades recompute is now rAF-throttled
  ok('rails: edge fades track scroll position');

  // ---------- v0.4.4 dashboard rail registry ----------

  // 65a. rail visibility + persistence: settings.dashRails controls which rails show (Live off -> absent)
  await page.eval(`settings.dashRails = ['continue', 'trending']; saveSettings(); showDashboard();`);
  await until(() => page.eval(`[...document.querySelectorAll('#dashboard .dash-section h2')].some(h => h.textContent === 'Trending')`), 'Trending rail present under custom rails');
  assert.ok(await page.eval(`[...document.querySelectorAll('#dashboard .dash-section h2')].some(h => h.textContent === 'Continue Watching')`), 'Continue rail present under custom rails');
  assert.ok(await page.eval(`![...document.querySelectorAll('#dashboard .dash-section h2')].some(h => h.textContent === 'Live now')`), 'Live-now rail must be absent when not in dashRails');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#dashboard .match-card').length`), 0, 'no live match cards when the live rail is disabled');
  ok('dashboard rails: dashRails membership controls rail visibility');

  // 65b. order is followed: the first rail matches the first enabled id
  await page.eval(`settings.dashRails = ['trending', 'continue', 'top10', 'live']; saveSettings(); showDashboard();`);
  await until(() => page.eval(`(document.querySelector('#dashboard .dash-section h2') || {}).textContent === 'Trending'`), 'first rail is Trending when ordered first');
  ok('dashboard rails: settings.dashRails order = render order');

  // 65c. genre shelf: enabling a genre rail renders it, and the /discover query carries with_genres (fixture echo)
  await page.eval(`settings.dashRails = ['continue', 'genre:28']; saveSettings(); showDashboard();`);
  await until(() => page.eval(`(() => { const s = [...document.querySelectorAll('#dashboard .dash-section')].find(s => (s.querySelector('h2')||{}).textContent === 'Action'); return s && s.querySelector('.card'); })()`), 'genre rail renders a card');
  assert.ok(await page.eval(`(() => { const s = [...document.querySelectorAll('#dashboard .dash-section')].find(s => (s.querySelector('h2')||{}).textContent === 'Action'); return [...s.querySelectorAll('.card')].some(c => c.textContent.includes('G28')); })()`), 'genre rail /discover query must carry with_genres=28');
  ok('dashboard rails: genre shelf enable + with_genres query shape');

  // 65d. lazy rails: a below-fold discover shelf is NOT eager-filled; fillRail fills it on demand.
  //      Top Rated is index 4 (beyond EAGER=2, not special) -> observed, not eager. The observer is
  //      disconnected right after render and the lazy path (fillRail) driven directly: under CDP the 400px
  //      rootMargin + async first-observation callback make a real-scroll assertion racy (the rail may sit
  //      within rootMargin, or the callback may fire before/after the check), so the direct call proves
  //      both halves of the contract (not-eager + fills-on-demand) deterministically.
  await page.eval(`settings.dashRails = ['continue', 'trending', 'top10', 'live', 'toprated']; saveSettings(); showDashboard(); railObserver && railObserver.disconnect();`);
  const trSel = `[...document.querySelectorAll('#dashboard .dash-section')].find(s => (s.querySelector('h2')||{}).textContent === 'Top Rated')`;
  await until(() => page.eval(`(() => { const s = ${trSel}; return s && s.querySelector('.skel'); })()`), 'Top Rated shell built with skeletons');
  assert.strictEqual(await page.eval(`(() => { const s = ${trSel}; return s.querySelectorAll('.card').length; })()`), 0, 'below-fold Top Rated rail is not eager-filled (skeletons only)');
  await page.eval(`(() => { const s = ${trSel}; fillRail(s, s._rail); })()`);
  await until(() => page.eval(`(() => { const s = ${trSel}; return s && s.querySelector('.card'); })()`), 'lazy fillRail populates the below-fold rail');
  await page.eval(`settings.dashRails = ['continue', 'trending', 'top10', 'live']; saveSettings();`);
  ok('dashboard rails: below-fold shelves lazy-fill on demand');

  // 65e. chevron scroll buttons: exist per rail section, prev disabled at scrollLeft 0, clicking next
  //      scrolls the rail. reduced-motion -> instant ('auto') scroll, so scrollLeft moves synchronously
  //      and the assertion is deterministic (same 12-wide-card overflow premise as T65's edge fades).
  await page.eval(`(() => { cont.length = 0;
    for (let i = 0; i < 12; i++) cont.push({ key: 'tv#43' + i, title: 'Chev' + i, url: '${PLAYER}/embed/tv/' + (430 + i) + '/1/1', poster: '', season: 1, episode: 1, type: 'tv', updatedAt: Date.now() - i, position: null, duration: null, note: '' });
    store('continue', cont); document.body.classList.add('reduced-motion'); renderDashboard(); })()`);
  await until(() => page.eval(`document.querySelectorAll('#dashboard .rail .resume-card').length >= 12`), 'wide Continue rail rendered for chevrons');
  const csSel = `[...document.querySelectorAll('#dashboard .dash-section')].find(s => s.querySelector('.resume-card'))`;
  assert.ok(await page.eval(`(() => { const s = ${csSel}; return !!s.querySelector('.rail-chev.prev') && !!s.querySelector('.rail-chev.next'); })()`), 'both rail chevrons exist in the section');
  await until(() => page.eval(`(() => { const s = ${csSel}; return s.querySelector('.rail-chev.prev').disabled; })()`), 'prev chevron disabled at scrollLeft 0');
  await page.eval(`(() => { const s = ${csSel}; s.querySelector('.rail-chev.next').click(); })()`);
  await until(() => page.eval(`(() => { const s = ${csSel}; return s.querySelector('.rail').scrollLeft > 8; })()`), 'clicking next scrolls the rail right');
  await page.eval(`document.body.classList.remove('reduced-motion');`);
  ok('dashboard rails: chevrons scroll the rail (prev disabled at the start)');

  // restore the default rail set for the tests that follow
  await page.eval(`settings.dashRails = ['continue', 'trending', 'top10', 'live']; saveSettings();`);

  // 66. detail: cinematic backdrop + logo art + scroll-linked cover; the live picker stays plain
  await page.eval(`showDetail('movie', 42)`);
  await until(() => page.eval(`!!document.querySelector('#detail .detail-backdrop img')`), 'detail backdrop layer renders');
  assert.ok(await page.eval(`(document.querySelector('#detail .detail-logo')||{}).src?.includes('/logo.png')`), 'logo art renders');
  assert.ok(await page.eval(`document.querySelector('#detail h1').textContent.length > 0`), 'h1 text kept (fallback + a11y)');
  const [dScroll, dOpacity] = await page.eval(`(() => { const d = document.getElementById('detail'); d.scrollTop = 600; d.dispatchEvent(new Event('scroll')); return [d.scrollTop, document.querySelector('#detail .detail-cover').style.opacity]; })()`);
  assert.strictEqual(dOpacity, String(Math.min(dScroll / 500, 1)), 'cover opacity tracks #detail scrollTop');
  await page.eval(`showLivePicker({ title: 'Plain Match', logo: '', sources: [] })`);
  await until(() => page.eval(`!document.getElementById('detail').hidden && document.querySelector('#detail h1').textContent === 'Plain Match'`), 'live picker renders in the shared container');
  assert.ok(await page.eval(`!document.querySelector('#detail .detail-backdrop')`), 'live picker has no backdrop layer');
  ok('detail: backdrop + logo + scroll fade; live picker stays plain');

  // ---------- v0.4.3 perf/health ----------

  // 67. progress poll is GATED on player visibility: it runs only while the player is shown, freezes when
  //     hidden (video parked on another view), and re-arms on the next show using the CURRENT interval.
  await page.eval(`(async () => { settings.progressPollMs = 1000; saveSettings(); await pushMain(); })()`);
  await page.eval(`cont.length = 0; store('continue', cont); activeKey = null; open('${SITE}/tv/428');`);
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/tv/428')`), 'player shown for poll-gate test');
  // visible -> the gated poll runs and the fixture's currentTime (42) lands in the continue entry
  await until(() => page.eval(`(JSON.parse(localStorage.getItem('continue'))[0] || {}).position === 42`), 'visible: gated poll reads position', 8000);
  // hidden -> poll disarmed: settle any in-flight read, then updatedAt must freeze
  await page.eval(`exitPlayer()`);
  await sleep(1500);
  const frozen = await page.eval(`(JSON.parse(localStorage.getItem('continue'))[0] || {}).updatedAt`);
  await sleep(2500);
  assert.strictEqual(await page.eval(`(JSON.parse(localStorage.getItem('continue'))[0] || {}).updatedAt`), frozen, 'hidden: progress poll must freeze (updatedAt frozen while parked)');
  // shown again -> re-armed with the current interval: updatedAt advances again
  await page.eval(`resumeLast()`);
  await until(() => page.eval(`(JSON.parse(localStorage.getItem('continue'))[0] || {}).updatedAt > ${frozen}`), 're-armed: updatedAt advances again after show', 8000);
  await page.eval(`(async () => { settings.progressPollMs = 5000; saveSettings(); await pushMain(); })()`);
  ok('poll-gate: progress poll runs only while shown; freezes hidden; re-arms on show with the current interval');

  // 68. v0.4.3: capMap bounds a Map by FIFO (oldest-first) eviction, keeping the newest `max` entries.
  const capRes = await page.eval(`(() => {
    const m = new Map();
    for (let i = 0; i < 25; i++) { m.set('k' + i, i); capMap(m, 20); } // cap AFTER each set, like the real call sites
    return { size: m.size, hasNewest: m.has('k24'), hasOldest: m.has('k0'), hasWindow: m.has('k5') };
  })()`);
  assert.strictEqual(capRes.size, 20, 'capMap holds the Map at the cap');
  assert.ok(capRes.hasNewest, 'the just-written entry survives eviction');
  assert.ok(!capRes.hasOldest, 'the oldest entry is evicted first');
  assert.ok(capRes.hasWindow, 'entries within the cap window are kept');
  ok('capMap: FIFO eviction keeps the newest max entries, drops the oldest');

  page.close();
  console.log(`\nALL ${passed} TESTS PASSED`);
}

main()
  .catch((e) => { process.exitCode = 1; console.error(`\nFAIL after ${passed} passing tests:\n${e.stack}`); })
  .finally(async () => {
    await quitApp();
    site.close();
    uaEcho.close();
    player.close();
    tmdb.close();
    catalog.close();
    ytFix.close();
    catalogNested.close();
    catalogB.close();
    catalogTwoHop.close();
    process.exit(process.exitCode ?? 0); // open CDP sockets would otherwise keep the loop alive
  });
