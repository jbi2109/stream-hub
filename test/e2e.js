// E2E suite: drives the real app over Chrome DevTools Protocol.
// Plain Node, no deps (built-in fetch + WebSocket). Run: npm test
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, desc, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`timeout waiting for: ${desc} (last: ${last})`);
}

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
    ] }));
  } else if (/\/3\/(movie|tv)\/\d+$/.test(p)) {
    res.end(JSON.stringify({
      id: 42, title: 'Fixture Title', name: 'Fixture Title', overview: 'A fixture overview.',
      poster_path: '/x.jpg', backdrop_path: '/b.jpg', vote_average: 7.9, tagline: 'Twist.',
      release_date: '2026-01-01', first_air_date: '2026-01-01', runtime: 70,
      number_of_seasons: 2, number_of_episodes: 10, genres: [{ id: 18, name: 'Drama' }],
      seasons: [{ season_number: 1, name: 'Season 1', episode_count: 6 }, { season_number: 2, name: 'Season 2', episode_count: 4 }],
      credits: { cast: [{ id: 1, name: 'Actor One', character: 'Hero', profile_path: '/a.jpg' }] },
      videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abc123' }] },
      external_ids: { imdb_id: 'tt123' },
      'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Netflix', logo_path: '/n.jpg' }] } } },
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
    res.end(JSON.stringify({ page, total_pages: 3, results: [{ id: 42, title: t, name: t, poster_path: '/x.jpg' }] }));
  } else {
    res.end(JSON.stringify({ page: 1, total_pages: 1, results: [{ id: 42, title: 'Fixture Title', name: 'Fixture Title', poster_path: '/x.jpg' }] }));
  }
});

// Stands in for a generic live-catalog JSON API (fetched via sh.httpGet -> main).
const catalog = http.createServer((req, res) => {
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

// ---- minimal CDP client ----
class CDP {
  static async connect(wsUrl) {
    const c = new CDP();
    c.pending = new Map();
    c.nextId = 1;
    c.ws = new WebSocket(wsUrl);
    c.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    await new Promise((res, rej) => {
      c.ws.addEventListener('open', res);
      c.ws.addEventListener('error', () => rej(new Error('ws connect failed')));
    });
    return c;
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || '')} in: ${expression.slice(0, 120)}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const closeTarget = (id) => fetch(`http://127.0.0.1:${PORT}/json/close/${id}`);

async function launchApp() {
  const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
  electronProc = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, '--test-profile'],
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
    browser.send('Browser.close').catch(() => {}); // browser may drop socket without replying
    browser.close();
  } catch {}
  await sleep(1500);
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
  await page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].find(t => /team [ab] vs team [ab]/i.test(t.textContent)).click()`);
  await until(() => page.eval(`document.querySelectorAll('#detail .src-group').length >= 2`), 'the source page groups sources under both catalogs');
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

  // 32z. v0.2.3: YouTube hosts get cosmetic element-hiding CSS (hides Sponsored feed tiles / masthead)
  //       but NOT scriptlets (which break the player — enforced by getInjectionRules:false in main.js +
  //       the manual player check; scriptlet bodies aren't resolvable under the parse() test engine).
  //       The '###sh-cosmetic' rule hides #sh-cosmetic on the normal host AND the YouTube host.
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
    'cosmetic CSS also injected on the YouTube host (sponsored-tile hiding restored)');
  ytGuest.close();
  ok('adblock: YouTube gets cosmetic CSS (hides sponsored tiles), scriptlets withheld');

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
  await sleep(400);
  const uaOff = await stGuest.eval(`fetch('${UA_ECHO}/').then(r => r.text())`);
  assert.ok(!uaOff.includes('Firefox') && uaOff.includes('Chrome'), 'gate off: the login host should see the normal Chrome UA');
  await page.eval(`${uaToggle}.click()`); // back on
  await sleep(400);
  const uaOn = await stGuest.eval(`fetch('${UA_ECHO}/').then(r => r.text())`);
  assert.ok(uaOn.includes('Firefox'), 'gate on: Firefox UA restored');
  ok('⚙ settings: Google-UA spoof gates live (Chrome when off, Firefox when on)');

  // 37. settings.json roundtrip: an Advanced change lands in the main process file with the full ⚙ subset
  await page.eval(`(() => { const i = [...document.querySelectorAll('#settings .set-row')].find(r => r.textContent.includes('Live catalog timeout')).querySelector('input'); i.value = '42'; i.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  const msFile = JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'));
  assert.strictEqual(msFile.catalogTimeoutSec, 42, 'catalogTimeoutSec should persist to settings.json');
  assert.strictEqual(msFile.adblock, true, 'adblock state should persist');
  assert.strictEqual(msFile.googleUaSpoof, true, 'googleUaSpoof state should persist');
  assert.deepStrictEqual(msFile.extraAuthHosts, [UA_ECHO_HOST], 'extraAuthHosts should persist as an array');
  stGuest.close();
  ok('⚙ settings: changes persist to userData/settings.json for the next launch');

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
  await kd('/');
  assert.ok(await page.eval(`document.activeElement.classList.contains('browse-search')`), '/ should focus the visible search');
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

  // 52. the Live-now rail NEVER fetches: cold cache -> hint; the hint opens Live TV (which fetches)
  await page.eval(`sources = sources.filter(s => s.category !== 'live'); sources.push({ name: 'DashHop', category: 'live', catalogUrl: '${CATALOG_TWOHOP}/api/matches/live' }); store('sources', sources); liveCatalogCache.clear();`);
  const dashHits = twoHopHits;
  await page.eval(`document.getElementById('dash-btn').click()`);
  await until(() => page.eval(`!!document.querySelector('#dashboard .dash-live-hint')`), 'cold cache shows the Open-Live-TV hint');
  await sleep(600);
  assert.strictEqual(twoHopHits, dashHits, 'the dashboard must not fetch catalogs');
  await page.eval(`document.querySelector('#dashboard .dash-live-hint').click()`);
  await until(() => Promise.resolve(twoHopHits === dashHits + 1), 'the hint opens Live TV, which fetches');
  await until(() => page.eval(`[...document.querySelectorAll('#browse .match-grid .match-card')].some(c => c.textContent.includes('Hop Match'))`), 'live grid renders after the hint');
  ok('dashboard: live rail is cache-only; the hint routes to Live TV');

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
