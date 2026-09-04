# Settings, migrations, export/import (settings.js, app.js, theme.js)

## `SETTINGS_DEFAULTS` (renderer, `localStorage.settings`)

Renderer-only: `theme` dark|light, `accent` (6 swatches), `posterSize` 130|160|200, `landingView` dashboard|browse|library, `defaultBrowseTab`, `dashRails` (order = render order, membership = enabled), `watchRegion`, `trackContinue`, `autoAdvanceLater`, `autoplayTrailers`, `autoplayNext` (⏭ topbar toggle), `liveLanguage`, `captureDebounce`.

⚙ main-process subset (mirrored via `pushMain()` → `set-setting` → `userData/settings.json`, live-applied): `adblock`, `youtubeScriptlets`, `extraAuthHosts` (comma string → array), `googleUaSpoof`, `autoUpdateCheck`, `progressPollMs` (next player show), `adlistRefreshHours` (default 8), `catalogTimeoutSec`. `mainSubset()` is the single translation; app.js re-pushes it at every boot so Import/Reset cannot drift.

## Installed-base rule

`settings = { ...SETTINGS_DEFAULTS, ...load('settings') }` — **a persisted value always beats a new default**, so a changed default reaches upgrading profiles only through a flag-gated one-shot migration that moves the EXACT old value:

| Flag | Migration |
|------|-----------|
| `railsV060` | Append the `because` rail once to persisted `dashRails`. |
| `adlistV017` | `adlistRefreshHours` 24 → 8 once; user-set numbers untouched. |
| (core.js IIFE) | Default source category `vod`; purge live/YouTube entries from Continue. |
| `libraryHealed` | One-time TMDB re-title of old entries. |

Add a new flag for every default change; run it before the screen that displays the value is built.

## Settings screen

Built once at load (`buildSettings`), panels kept so wired controls survive tab switches; `rebuildSettings()` after Reset re-wires the legacy id'd controls (`#tmdb-key`, `#default-source`, `#export-settings`, `#import-*`, `#version`) via `wireSettingsControls()` in app.js. Tabs: General, Appearance, Sources, Playback, Privacy & blocking, Library, Updates, Advanced, About. Controls: `settingRow`, `toggleControl` (switch — no visible keyboard focus, audit A1), `segmented`, `selectControl`, `numControl` (clamps to min silently, audit B10), `dashRailsControl` (checkbox list + ▲▼), accent `swatches`. Native `confirm()` for Clear/Reset (audit A6). The Privacy panel re-queries `adblock-status` on entry and greys the YouTube toggle + Update button while master blocking is off.

## Theme (theme.js)

Runs in `<head>` before the stylesheet: sets `data-theme`, `--accent`, `--poster-min` from `localStorage.settings` so there is no flash. `applyThemeVars(settings)` is re-called live by the Appearance panel.

## Export / import

Export = every `localStorage` key as one JSON file (includes the TMDB key and watch history — audit F20). Import (v0.20) parses every value, requires `sources` / `continue` / `watchlater` to be arrays and `settings` an object, skips and counts anything else (toast), then reloads. Boot reads the three lists through `loadList` (non-array → `[]`) and spreads `settings` only when it is a plain object, so a hand-edited store cannot blank the window.

## What's New

Once per version bump (`lastSeenVersion`): fetch the GitHub release body for `v{version}` through `httpGet`, render `- ` bullets and `**bold**` via `textContent` only; offline → short fallback + link. First-ever run seeds silently.
