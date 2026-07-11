// Capture README screenshots into docs/ over CDP (same route the e2e suite drives the app with).
//
//   node test/screenshots.js                       -> hero.png (fresh-profile dashboard onboarding)
//   SH_SHOT_TMDB_KEY=<v3 key> node test/screenshots.js
//       -> hero.png + browse.png (real TMDB grid) + detail.png (a title's detail page, seeded with a
//          neutral "Example Player" source; crop/skip anything showing real provider branding)
//
// Runs against the throwaway --test-profile (wiped first) so nothing personal can leak into a shot.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'stream-hub-test-profile');
const DOCS = path.join(ROOT, 'docs');
const PORT = 9333;
const KEY = process.env.SH_SHOT_TMDB_KEY || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(250);
  }
  throw new Error(`timeout: ${what}`);
}

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
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(DOCS, { recursive: true });
  const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
  const proc = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, '--test-profile'],
    { cwd: ROOT, stdio: 'ignore' });
  try {
    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      return list.find((t) => t.url.includes('index.html') && t.webSocketDebuggerUrl);
    }, 'app page target');
    const page = await CDP.connect(target.webSocketDebuggerUrl);
    const shoot = async (name) => {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(DOCS, name), Buffer.from(data, 'base64'));
      console.log('wrote docs/' + name);
    };

    // hero: fresh profile -> dashboard onboarding card (neutral by construction)
    await until(() => page.eval(`!!document.querySelector('#dashboard .onboard-card')`), 'onboarding card');
    await sleep(500); // fonts/paint settle
    await shoot('hero.png');

    if (KEY) {
      await page.eval(`tmdbKey = ${JSON.stringify(KEY)}; store('tmdbKey', tmdbKey);
        addSource({ name: 'Example Player', url: 'https://player.example.com', category: 'vod' });
        browseTab = 'movie'; showBrowse();`);
      await until(() => page.eval(`document.querySelectorAll('#browse .grid .card').length >= 10`), 'browse grid');
      await sleep(1500); // posters load
      await shoot('browse.png');
      await page.eval(`document.querySelector('#browse .grid .card').click()`);
      await until(() => page.eval(`!document.getElementById('detail').hidden && !!document.querySelector('#detail h1')`), 'detail page');
      await sleep(1500);
      await shoot('detail.png');
    } else {
      console.log('SH_SHOT_TMDB_KEY not set — skipped browse.png / detail.png');
    }
    page.close();
  } finally {
    try { proc.kill(); } catch {}
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
