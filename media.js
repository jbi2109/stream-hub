// Page inspection (title/poster/season/episode) + Continue-Watching capture.

// Stable per-title id: first 3+ digit run in the path (TMDB id), else the path.
function mediaKey(url) {
  try {
    const u = new URL(url);
    const id = u.pathname.match(/\/(\d{3,})/);
    return u.host + (id ? '#' + id[1] : u.pathname);
  } catch { return url; }
}

function parseSeasonEpisode(url, title) {
  try {
    const u = new URL(url);
    const q = u.searchParams;
    const s = q.get('season') ?? q.get('s');
    const e = q.get('episode') ?? q.get('e');
    if (s && e) return { season: +s, episode: +e };
    // path form .../<id>/<season>/<episode>
    const p = u.pathname.match(/\/\d{3,}\/(\d{1,3})\/(\d{1,3})\b/);
    if (p) return { season: +p[1], episode: +p[2] };
  } catch {}
  const t = (title || '').match(/S(\d{1,3})\s*[\s.:_-]?\s*E(\d{1,3})/i);
  if (t) return { season: +t[1], episode: +t[2] };
  return { season: null, episode: null };
}

// Reads the guest's TOP document (readable — only the video iframe was cross-origin).
async function parsePage() {
  try {
    return await webview.executeJavaScript(`(() => {
      const m = (sel) => document.querySelector(sel)?.content || '';
      return {
        title: m('meta[property="og:title"]') || document.title || '',
        poster: m('meta[property="og:image"]') || m('meta[name="twitter:image"]') || '',
        ogType: m('meta[property="og:type"]'),
      };
    })()`);
  } catch { return { title: '', poster: '', ogType: '' }; }
}

function isMediaUrl(url) {
  try {
    const u = new URL(url);
    return /\/\d{3,}/.test(u.pathname) || /\/(tv|movie|movies|watch|series|anime|show)\b/i.test(u.pathname);
  } catch { return false; }
}

function mediaType(url, season) {
  if (season != null) return 'tv';
  try { if (/\/(tv|series|show|anime|episode)\b/i.test(new URL(url).pathname)) return 'tv'; } catch {}
  return 'movie';
}

// full classification incl. Live TV (from the source's category)
const classify = (url, season) => (isLiveUrl(url) ? 'live' : mediaType(url, season));

// type of an item, falling back for entries saved before `type` existed
const typeOf = (item) => item.type || classify(item.url, item.season);

// ---------- capture ----------

let captureTimer = null;
function scheduleCapture() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(captureCurrent, 600);
}

async function captureCurrent() {
  const url = webview.getURL();
  if (!url || !/^https?:/.test(url) || !isMediaUrl(url)) return;
  if (isLiveUrl(url)) return; // Live TV sources never enter Continue Watching
  const page = await parsePage();
  if (!page.title) return;
  const key = mediaKey(url);
  const { season, episode } = parseSeasonEpisode(url, page.title);
  const type = mediaType(url, season);
  activeKey = key;
  const existing = cont.find((c) => c.key === key);
  const base = { key, title: page.title, url, poster: page.poster, season, episode, type, updatedAt: Date.now() };
  if (existing) {
    Object.assign(existing, base, { poster: page.poster || existing.poster });
  } else {
    cont.unshift({ ...base, position: null, duration: null, note: '' });
  }
  cont.sort((a, b) => b.updatedAt - a.updatedAt);
  store('continue', cont);

  // Watch Later tracks the show too: advance its episode/url as you watch
  const wl = later.find((w) => w.key === key);
  if (wl) {
    Object.assign(wl, { season, episode, url, type, poster: page.poster || wl.poster });
    store('watchlater', later);
  }
}

// player position, pushed from main over the preload bridge
window.sh?.onVideoProgress(({ position, duration }) => {
  if (!activeKey) return;
  const item = cont.find((c) => c.key === activeKey);
  if (!item) return;
  item.position = position;
  item.duration = duration;
  item.updatedAt = Date.now();
  store('continue', cont);
  // no live re-render: home is hidden during playback; it refreshes on next open
});
