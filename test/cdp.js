// Shared CDP client + async helpers for the test harnesses (e2e + screenshots).
// The richer e2e variants: eval errors carry the exception description + expression; `until`
// defaults to a 20s timeout / 250ms poll. PORT/PROFILE/targets stay LOCAL to each harness
// (they run on different debugging ports by design).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, desc, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${desc} (last: ${last})`);
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
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || '')} in: ${expression.slice(0, 120)}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

module.exports = { CDP, sleep, until };
