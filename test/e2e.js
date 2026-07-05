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

// Stands in for TMDB (SH_TEST_TMDB_BASE points the main process here). Any /3/* path
// returns one canned result so browse grids render deterministically.
const tmdb = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ results: [{ id: 42, title: 'Fixture Title', name: 'Fixture Title', poster_path: '/x.jpg' }] }));
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
  await page.eval(`
    document.getElementById('src-name').value = 'LocalTest';
    document.getElementById('src-url').value = '${SITE}';
    document.getElementById('add-source').requestSubmit();
  `);
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

  // 16. add a Live TV source via the category select; sidebar splits into groups
  await page.eval(`
    document.getElementById('src-name').value = 'LiveFix';
    document.getElementById('src-url').value = '${PLAYER}';
    document.getElementById('src-cat').value = 'live';
    document.getElementById('add-source').requestSubmit();
  `);
  const srcs = await page.eval(`JSON.parse(localStorage.getItem('sources'))`);
  assert.ok(srcs.some((s) => s.name === 'LiveFix' && s.category === 'live'), 'live source not stored with category');
  assert.strictEqual(
    await page.eval(`[...document.querySelectorAll('#sources h2')].map((h) => h.textContent).join('|')`),
    'Movies & TV|Live TV', 'sidebar not grouped into Movies & TV / Live TV');
  ok('sources: add-source category select + grouped sidebar');

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
  await page.eval(`[...document.querySelectorAll('#sources li')].find((li) => li.textContent.includes('LocalTest')).querySelector('button').click()`);
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
  await page.eval(`
    document.getElementById('src-name').value = 'BrowseSrc';
    document.getElementById('src-url').value = '${SITE}';
    document.getElementById('src-cat').value = 'vod';
    document.getElementById('add-source').requestSubmit();
  `);
  await page.eval(`(() => {
    const k = document.getElementById('tmdb-key');
    k.value = 'testkey';
    k.dispatchEvent(new Event('change'));
  })()`);
  await page.eval(`document.getElementById('browse-btn').click()`);
  await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length`), 'browse movie grid');
  ok('browse: TMDB grid renders poster cards');

  // 24. clicking a browse card opens the title on a vod source (/movie/42)
  await page.eval(`document.querySelector('#browse .grid .card').click()`);
  await until(() => page.eval(`document.getElementById('webview').getURL().includes('/movie/42')`), 'browse card opened title url');
  ok('browse: click opens the title on a source');

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
    process.exit(process.exitCode ?? 0); // open CDP sockets would otherwise keep the loop alive
  });
