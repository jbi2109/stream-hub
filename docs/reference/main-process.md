# Main process (main.js, preload.js)

## Profiles

- Packaged: default `userData`, single-instance lock (second launch focuses the window).
- `npm start` (dev): `userData + '-dev'` — never touches the installed app's data.
- `--test-profile`: `%TMP%/stream-hub-test-profile`, wiped by the e2e/screenshot harnesses; updater disabled.

## IPC surface (`window.sh` in preload.js)

| Channel | Direction | Purpose / validation |
|---------|-----------|----------------------|
| `tmdb` (invoke) | R→M | `fetch(TMDB_BASE + '/3' + path + qs)`; returns `{error, results:[]}` on failure. `SH_TEST_TMDB_BASE` redirects to a fixture. **No timeout today** (audit R2). |
| `httpGet` (invoke) | R→M | Generic GET for live catalogs: https only (loopback http allowed), credentials stripped, browser UA, `catalogTimeoutSec` abort, 5 MB streamed cap. |
| `set-setting` (invoke) | R→M | Merges a patch into `ms`, writes `settings.json`, live-applies ad-block. Keys not whitelisted (audit R6). |
| `refresh-adlists`, `adblock-status` (invoke) | R→M | Force rebuild / engine state for the Privacy panel. |
| `app-version`, `check-update`, `install-update` (invoke) | R→M | Updater controls (`{state:'dev'}` when unpackaged). |
| `open-external` (invoke) | R→M | v0.20: `shell.openExternal` for shell links; http(s) only, `{ok, skipped}` under `--test-profile`. Renderer side: one delegated click handler in app.js (`openExternal`). |
| `player-visible` (send) | R→M | Gates the progress poll on webview visibility. |
| `yt-adblock` (sendSync) | Guest→M | Guest preload asks at document_start whether to run the YouTube pruner. |
| `guest-pad` (send) | Guest→M→R | Controller B/Start pressed while the guest has focus; whitelisted to `back`/`palette`. |
| `video-progress`, `exit-player`, `open-palette`, `guest-pad`, `blocked-nav`, `auth-reload`, `update-*` | M→R | Events the renderer subscribes to. |

## Webview session policy (`web-contents-created`)

- Host window and login pop-ups: `setWindowOpenHandler → deny`.
- Guest: same-host `_blank` → `loadURL` in place; `AUTH_HOSTS` (+ ⚙ `extraAuthHosts`) → allowed 500×700 pop-up; everything else denied (ad pop-unders).
- **Navigation guards (v0.16)**: `will-navigate` and frame-initiated `will-redirect` on the main frame — Google login hosts pop out to a standalone window; cross-site (last-two-labels base domain; the three YouTube domains count as one site) is cancelled and `blocked-nav` is sent so the renderer can offer one-click Allow. App-driven loads are exempt. `will-prevent-unload` → `preventDefault` so beforeunload traps cannot hold the player.
- Google UA spoof (⚙ `googleUaSpoof`): Firefox UA header + stripped `sec-ch-ua` hints on `GOOGLE_LOGIN_HOSTS`, per-navigation `setUserAgent`, and the guest preload mirrors `navigator.userAgent`.
- WebAuthn disabled app-wide (`disable-features`) and in the guest preload.

## Progress poll

`readVideo(contents)` walks `mainFrame.framesInSubtree` from the privileged main process and reads `{currentTime, duration}` of the first `<video>` — cross-origin frames included. Armed only while the renderer reports the player visible; interval = ⚙ `progressPollMs`.

## Window state

`window.json` saved on close (`getNormalBounds` + maximized); restored without checking the display still exists (audit R3).

## Updater

`electron-updater` from GitHub Releases, packaged builds only; `autoInstallOnAppQuit`; check on launch gated by ⚙ `autoUpdateCheck`; every event is forwarded to the renderer banner/status line.
