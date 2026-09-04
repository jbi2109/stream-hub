# Ad-blocking and YouTube (main.js + webview-preload.js)

## Engine lifecycle (main.js)

- `buildBlocker({forceRefresh})` → `ElectronBlocker.fromPrebuiltFull(fetch, cache)` with the cache object ALWAYS passed (a missing/corrupt `adblock-full.bin` makes `read()` reject and the engine self-heals). Stale = bin older than ⚙ `adlistRefreshHours` (default 8 — the upstream quick-fixes list expires every 8 h). On refresh the bin is rotated to `.old`; a failed download restores it (stale full lists beat none); last resort `fromPrebuiltAdsAndTracking` (`engine: 'ads-only'`), then `'off'`.
- Concurrent builds coalesce on `buildInFlight`; a force build never piggybacks a weaker non-force build.
- `swapBlocker` disables the old engine BEFORE enabling the new one (Electron allows one webRequest listener per event; the adapter's `ipcMain.handle` channels throw on duplicates).
- `applyAdblock()` syncs with ⚙ `adblock` live (off→on reuses the built engine, no refetch). Hourly timer refreshes once the lists age past the threshold.
- `applyYtPolicy` wraps `onInjectCosmeticFilters`: YouTube hosts get **cosmetic CSS only** via `getCosmeticsFilters({getInjectionRules:false, …})` — engine scriptlets crash the YouTube player under its CSP (grey box). Everything else takes the adapter's default path.
- Status for the Privacy panel: `{enabled, engine, at}`.

## YouTube video-ad pruner (webview-preload.js, gated by ⚙ `youtubeScriptlets` + host check via `yt-adblock`)

1. Proxy `JSON.parse`, `Response.prototype.json` and the `ytInitialPlayerResponse` global to delete `playerAds` / `adPlacements` / `adSlots`.
2. **Anti-detection (v0.17)**: YouTube steals a pristine `JSON.parse` from a fresh same-origin iframe and diffs it against the pruned config. Hook `HTMLIFrameElement.prototype.contentWindow/contentDocument` getters and re-apply the pruning in every child realm (WeakSet-tracked, kept in our realm). Port of uBO `trusted-prevent-dom-bypass`.
3. **Nag killer**: a MutationObserver tick removes `ytd-enforcement-message-view-model` (+ `-wiz`) inside `tp-yt-paper-dialog`, the backdrop, restores body overflow and calls `movie_player.playVideo()`.
4. **Leak fallback**: while `#movie_player` has `ad-showing`/`ad-interrupting`, mute + seek to the end + click the skip button (selector list — YouTube rotates class names).

The tick is one MutationObserver on `documentElement` (`subtree`, `childList`, `attributes: ['class']`); rAF coalescing was rejected because rAF stops when the webview is hidden.

## Test hooks (env vars read by main.js)

| Var | Effect |
|-----|--------|
| `SH_TEST_BLOCK_PATTERN` | Deterministic engine from `ElectronBlocker.parse`; disables the refresh timer. |
| `SH_TEST_YT_HOST` | A fixture host treated as YouTube by both the cosmetic policy and the pruner gate. |
| `SH_TEST_UA_HOST` | Extra host treated as a Google login host. |
| `SH_TEST_TMDB_BASE` | TMDB proxy base URL. |

## Known limits

- The pop-up itself was proven only on a signed-out session behind Google's consent wall; the mechanism (realm bypass closed) is proven by test 37b3.
- No SponsorBlock yet (planned; hash-prefix API through main, skip in the guest, CC BY-NC-SA attribution, no vendored GPL code).
