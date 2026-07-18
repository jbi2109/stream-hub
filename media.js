// Page inspection (title/poster/season/episode) + Continue-Watching capture.

// Stable per-title id: first 3+ digit run in the path (TMDB id), else the path.
function mediaKey(url) {
  try {
    const u = new URL(url);
    const id = u.pathname.match(/\/(\d{3,})/);
    // Key by type#tmdbId (host-independent) so the same show across sources is ONE entry and
    // switching a card's source can't fork a duplicate. Fall back to host+path when there's no id.
    if (id) return mediaType(url) + '#' + id[1];
    return u.host + u.pathname;
  } catch { return url; }
}

// TMDB id from an embed URL (first 3+ digit path run — the same id mediaKey keys on). Matches the
// PATHNAME, not the whole URL, so a host containing digits (127.0.0.1, 123movies) can't be mistaken.
const tmdbIdOf = (url) => {
  try { return new URL(url).pathname.match(/\/(\d{3,})/)?.[1] || null; }
  catch { return String(url).match(/\/(\d{3,})/)?.[1] || null; }
};

// Migration: re-key Continue/Watch-Later by the host-independent key and merge duplicates that
// collapse to the same show (keep the most-recently-touched). Idempotent; run at startup.
function rekeyLibrary() {
  for (const [name, list] of [['continue', cont], ['watchlater', later]]) {
    let changed = false;
    // still scan every entry (re-canonicalizing imports is cheap) — but only flag a rewrite if a key
    // actually moves or the merge collapses duplicates, so a steady-state boot writes nothing.
    for (const item of list) { const k = mediaKey(item.url); if (item.key !== k) { item.key = k; changed = true; } }
    const byKey = new Map();
    for (const item of list) {
      const prev = byKey.get(item.key);
      const t = (x) => x.updatedAt || x.addedAt || 0;
      if (!prev || t(item) > t(prev)) byKey.set(item.key, item);
    }
    if (byKey.size !== list.length) { const kept = [...byKey.values()]; list.length = 0; list.push(...kept); changed = true; }
    if (changed) store(name, list);
  }
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
  captureTimer = setTimeout(captureCurrent, settings.captureDebounce || 600);
}

// Shared title/poster precedence: known (intendedMedia) → TMDB-by-URL-id → scraped page → existing entry.
async function resolveTitlePoster(url, type, known, page, existing) {
  const tmdb = known ? null : await tmdbMeta(tmdbIdOf(url), type);
  return { title: known?.title || tmdb?.title || existing?.title || page.title,
           poster: known?.poster || tmdb?.poster || page.poster || existing?.poster || '' };
}

async function captureCurrent() {
  const url = webview.getURL();
  if (!url || !/^https?:/.test(url) || !isMediaUrl(url)) return;
  // YouTube is the built-in tab, not a tracked show (and /watch trips isMediaUrl) — never capture it.
  try { if (/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(new URL(url).host)) return; } catch {}
  // Live TV never enters Continue Watching. Catalog embeds live on an arbitrary host that isLiveUrl
  // can't recognise, so also trust the `live` flag set when a live stream was opened/reopened.
  if (isLiveUrl(url) || intendedMedia?.live) return;
  const key = mediaKey(url);
  const existing = cont.find((c) => c.key === key);
  const { season, episode } = parseSeasonEpisode(url, '');
  const type = mediaType(url, season);
  // Title/poster precedence (id-first): what we were told (detail Watch / live tile / card reopen),
  // then TMDB looked up by the id in the URL, then the existing entry, then the scraped embed page.
  // TMDB-by-id means even direct navigation is correct and the provider's own og:title is never used
  // when the show is identifiable — a stale bad `existing.title` gets healed on the next watch.
  const known = intendedMedia && (!intendedMedia.id || String(url).includes(String(intendedMedia.id))) ? intendedMedia : null;
  const page = await parsePage();
  const { title, poster } = await resolveTitlePoster(url, type, known, page, existing);
  if (!title) return;

  // Continue Watching upsert (gated by the setting; still lets Watch Later track below).
  if (settings.trackContinue !== false) {
    activeKey = key;
    const base = { key, title, url, poster, season, episode, type, updatedAt: Date.now() };
    if (existing) {
      Object.assign(existing, base);
    } else {
      cont.unshift({ ...base, position: null, duration: null, note: '' });
    }
    cont.sort((a, b) => b.updatedAt - a.updatedAt);
    store('continue', cont);
  }

  // Watch Later tracks the show as you watch. Only overwrite its title from an authoritative source
  // (what we were told, or TMDB) — never clobber it with a scrape.
  if (settings.autoAdvanceLater !== false) {
    const wl = later.find((w) => w.key === key);
    if (wl) {
      const patch = { season, episode, url, type, poster: poster || wl.poster };
      // overwrite the WL title only from an authoritative source (known or a TMDB hit), never a scrape.
      // tmdbMeta is memoized, so this reuses resolveTitlePoster's cached lookup (no extra fetch).
      if (known || await tmdbMeta(tmdbIdOf(url), type)) patch.title = title;
      Object.assign(wl, patch);
      store('watchlater', later);
    }
  }
}

// ---------- auto-play next episode ----------

// Near the end of a TV episode (⏭ on), advance to the next one on the same source. Single-fire per
// open (open() resets the flag); between the src change and the new player loading, readVideo returns
// null, so a stale near-end position can't double-advance.
// ponytail: only works where the player exposes progress (same best-effort as the progress bars);
// 45s-from-end threshold, tune if it fires into credits too early/late.
let autoAdvanced = false;
function maybeAutoAdvance({ position, duration }) {
  if (autoAdvanced || settings.autoplayNext !== true) return;
  if (!playing || playing.type !== 'tv' || playing.season == null) return;
  if (!(duration >= 300 && position >= duration - 45)) return;
  autoAdvanced = true;
  let s = playing.season, e = (playing.episode ?? 1) + 1;
  const seasons = seasonsCache.get(playing.id); // may be empty pre-fetch -> naive +1; capture heals
  if (seasons && seasons.length) {
    const cur = seasons.find((x) => x.n === s);
    if (cur && e > cur.count) {
      const idx = seasons.indexOf(cur);
      if (idx + 1 >= seasons.length) return; // finale of the last season — stop
      s = seasons[idx + 1].n; e = 1;
    }
  }
  const src = playingSource();
  if (src) openOn(src, playing.kind, playing.type, playing.id, s, e, playing.title, playing.poster);
}

// player position, pushed from main over the preload bridge
window.sh?.onVideoProgress(({ position, duration }) => {
  maybeAutoAdvance({ position, duration }); // before the activeKey guard: autoplay works with tracking off
  if (!activeKey) return;
  const item = cont.find((c) => c.key === activeKey);
  if (!item) return;
  item.position = position;
  item.duration = duration;
  item.updatedAt = Date.now();
  store('continue', cont);
  // no live re-render: home is hidden during playback; it refreshes on next open
});
