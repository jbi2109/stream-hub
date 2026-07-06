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
  res.end(`<!doctype html><html><head>
    <meta property="og:title" content="Widow's Bay">
    <meta property="og:image" content="${SITE}/poster.png">
    <title>Widow's Bay</title></head><body>
    <h1>Fixture</h1>
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
  res.end(req.headers['user-agent'] || '');
});

// Stands in for TMDB (SH_TEST_TMDB_BASE points the main process here). Path-aware:
// detail objects for /movie|tv/{id}, episode lists for /season/{n}, else a results list.
const tmdb = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const p = req.url.split('?')[0];
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
      number_of_seasons: 1, number_of_episodes: 6, genres: [{ id: 18, name: 'Drama' }],
      seasons: [{ season_number: 1, name: 'Season 1' }],
      credits: { cast: [{ id: 1, name: 'Actor One', character: 'Hero', profile_path: '/a.jpg' }] },
      videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abc123' }] },
      external_ids: { imdb_id: 'tt123' },
      'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Netflix', logo_path: '/n.jpg' }] } } },
    }));
  } else {
    res.end(JSON.stringify({ results: [{ id: 42, title: 'Fixture Title', name: 'Fixture Title', poster_path: '/x.jpg' }] }));
  }
});

// Stands in for a generic live-catalog JSON API (fetched via sh.httpGet -> main).
const catalog = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ count: 3, streams: [
    // Alpha's embed has a 3-digit id so it passes isMediaUrl — proves the `live` flag (not isMediaUrl)
    // is what keeps a live stream out of Continue Watching (v15.2 test 32k).
    { name: 'Alpha Match', category: 'soccer', embed_url: `${PLAYER}/live/700`, thumbnail_url: '' },
    { name: 'Beta Match', category: 'soccer', embed_url: `${PLAYER}/live/8` },
    { name: 'Gamma Match', category: 'tennis', embed_url: `${PLAYER}/live/9` },
  ] }));
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
      ...process.env, SH_TEST_UA_HOST: UA_ECHO_HOST, SH_TEST_BLOCK_PATTERN: 'ads-test-marker',
      SH_TEST_TMDB_BASE: 'http://127.0.0.1:9313' } });
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
  setTimeout(() => { console.error('GLOBAL TIMEOUT'); process.exit(1); }, 180000).unref();
  fs.rmSync(PROFILE, { recursive: true, force: true }); // deterministic start
  site.listen(9310);
  uaEcho.listen(9311);
  player.listen(9312);
  tmdb.listen(9313);
  catalog.listen(9314);

  // ---------- boot ----------
  let pageTarget = await launchApp();
  let page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
  await until(() => page.eval(`document.querySelectorAll('#browse .tabs .tab').length`), 'browse rendered');

  // 1. UI boots on Browse (ships with no default sources; no TMDB key -> prompt)
  assert.strictEqual(await page.eval(`document.querySelectorAll('#sources li').length`), 0, 'expected no seeded sources');
  assert.strictEqual(await page.eval(`document.getElementById('browse').hidden`), false, 'browse should be the landing view');
  assert.strictEqual(await page.eval(`document.getElementById('home').hidden`), true, 'library should be hidden at boot');
  assert.strictEqual(await page.eval(`document.querySelectorAll('#browse .tabs .tab').length`), 5, 'expected 5 browse tabs');
  assert.ok(await page.eval(`(document.querySelector('#browse .empty')||{}).textContent?.includes('TMDB')`), 'no-key prompt should mention TMDB');
  ok('UI boots on Browse: 5 tabs, no-key prompt, no default sources');

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
  const movieKey = '127.0.0.1:9310#999888'; // mediaKey(host + '#' + tmdb id)
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
  const tvKey = '127.0.0.1:9310#286360';
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
  await until(() => page.eval(`document.querySelectorAll('#browse .tabs .tab').length`), 'app rendered after restart');
  await page.eval(`document.getElementById('home-btn').click()`); // Browse is now the landing; open Library
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
  await page.eval(`document.querySelector('#detail .detail-actions .btn-primary').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/embed/movie/42')`), 'watch opened embed url');
  ok('detail: movie poster -> detail page -> Watch loads source embed player');

  // 24b. TV detail shows season select + episode cards; Watch deep-links the episode; Trailer -> youtube embed
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'tv').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'tv grid');
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`!!document.querySelector('#detail .season-select') && document.querySelectorAll('#detail .episode').length >= 1`), 'tv detail episodes');
  await page.eval(`document.querySelector('#detail .detail-actions .btn-primary').click()`); // Watch S1E1
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
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'live').click()`);
  assert.ok(await page.eval(`document.querySelectorAll('#browse .tiles .tile').length >= 1`), 'live tiles missing');
  ok('browse: Anime grid + Live TV tiles render');

  // 26. YouTube tab opens youtube.com in the webview
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'youtube').click()`);
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

  // 28. edit a source's play-URL pattern via the inline ✎ editor; it persists
  await page.eval(`document.getElementById('home-btn').click()`); // leave any embed
  await page.eval(`addSource({ name: 'CineTest', url: '${PLAYER}', category: 'vod' })`);
  await page.eval(`[...document.querySelectorAll('#sources li')].find(li => li.textContent.includes('CineTest')).querySelector('button[title^="Edit"]').click()`);
  await page.eval(`(() => {
    const inp = document.querySelector('#sources li input');
    inp.value = '${PLAYER}/player/{id}/{season}/{episode}';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  })()`);
  assert.strictEqual(
    await page.eval(`(JSON.parse(localStorage.getItem('sources')).find(s => s.name === 'CineTest')||{}).template`),
    `${PLAYER}/player/{id}/{season}/{episode}`, 'edited template did not persist');
  ok('sources: inline ✎ sets a play-URL pattern that persists');

  // 29. detail-page source selector routes Watch to the chosen source + its pattern
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'movie').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'movie grid for source select');
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`!!document.querySelector('#detail .detail-source')`), 'detail source selector present');
  await page.eval(`document.querySelector('#detail .detail-source').value = '${PLAYER}'`); // choose CineTest
  await page.eval(`document.querySelector('#detail .detail-actions .btn-primary').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/player/42'`), 'watch used the chosen source pattern');
  ok('detail: source selector routes Watch to the chosen source pattern');

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

  // 32f. Live tab: catalog fetched from the API renders tiles, with a category filter + search; click embeds
  await page.eval(`document.getElementById('browse-btn').click()`);
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'live').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .live-provider .tile')].some(t => t.textContent.includes('Alpha Match'))`), 'catalog tiles render from the API');
  // category filter tabs derived from the data
  assert.ok(await page.eval(`['All','Soccer','Tennis'].every(l => [...document.querySelectorAll('#browse .subtabs .tab')].some(t => t.textContent === l))`), 'category filter tabs (All/Soccer/Tennis) missing');
  // search filters to Beta
  await page.eval(`(() => { const s = document.querySelector('#browse .browse-search'); s.value = 'Beta'; s.dispatchEvent(new Event('input')); })()`);
  await until(() => page.eval(`(() => { const ts = [...document.querySelectorAll('#browse .live-provider .tile')].map(t => t.textContent); return ts.some(x => x.includes('Beta')) && ts.every(x => !x.includes('Alpha') && !x.includes('Gamma')); })()`), 'search filters the catalog');
  // clear + Tennis category -> only Gamma
  await page.eval(`(() => { const s = document.querySelector('#browse .browse-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await page.eval(`[...document.querySelectorAll('#browse .subtabs .tab')].find(b => b.textContent === 'Tennis').click()`);
  await until(() => page.eval(`(() => { const ts = [...document.querySelectorAll('#browse .live-provider .tile')].map(t => t.textContent); return ts.some(x => x.includes('Gamma')) && ts.every(x => !x.includes('Alpha') && !x.includes('Beta')); })()`), 'category filter shows only Tennis');
  // Soccer category -> Alpha present; click it -> embeds the stream
  await page.eval(`[...document.querySelectorAll('#browse .subtabs .tab')].find(b => b.textContent === 'Soccer').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .live-provider .tile')].some(t => t.textContent.includes('Alpha'))`), 'Soccer shows Alpha');
  await page.eval(`[...document.querySelectorAll('#browse .live-provider .tile')].find(t => t.textContent.includes('Alpha')).click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/live/700'`), 'catalog tile embeds the stream');
  ok('live: JSON catalog renders with category filter + search + embed');

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
  await until(() => page.eval(`!!document.querySelector('#detail .detail-actions .btn-primary')`), 'detail (no-title capture)');
  await page.eval(`document.querySelector('#detail .detail-actions .btn-primary').click()`); // Watch -> PLAYER embed (no og:title)
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
  await page.eval(`[...document.querySelectorAll('#browse .tabs .tab')].find(b => b.dataset.tab === 'live').click()`);
  await until(() => page.eval(`[...document.querySelectorAll('#browse .live-provider .tile')].some(t => t.textContent.includes('Alpha'))`), 'catalog tiles (live capture)');
  await page.eval(`[...document.querySelectorAll('#browse .live-provider .tile')].find(t => t.textContent.includes('Alpha')).click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL() === '${PLAYER}/live/700'`), 'live tile opened');
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
    process.exit(process.exitCode ?? 0); // open CDP sockets would otherwise keep the loop alive
  });
