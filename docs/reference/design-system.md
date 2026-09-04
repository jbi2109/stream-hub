# Design system (style.css)

System font stack only (CSP forbids web fonts). All colour through tokens; both themes defined on `:root` / `[data-theme="light"]`.

## Tokens

- Surfaces: `--bg`, `--panel`, `--panel-2`, `--panel-3`, `--border`; text `--text`, `--muted`; `--accent` (user-picked, inline), `--on-accent`; `--scrim` (dark in both themes — only ever over imagery); status `--danger --warn --success --info --live` (+ `-bg`/`-border` variants).
- Type scale `--fs-xs .6875rem … --fs-3xl 2.75rem` (ratio ≈ 1.2); weights `--fw-normal … --fw-black`.
- Spacing `--sp-1 4px … --sp-12 48px`; radii `--r-sm 6 / --r-md 10 / --r-lg 12 / --r-xl 16 / --r-pill`; elevation `--shadow-1…4` (softer in light).
- Motion `--dur-fast 120ms`, `--dur-mid 180ms`, `--dur-slow 240ms`, `--ease-out`, `--ease-out-quart`. Every transition rides these tokens (v0.20 folded the last raw `.12s/.15s`).
- Z-index scale: `--z-fs 999` (HTML-fullscreen webview) < `--z-modal 1000` (overlays, hover preview, sources overlay) < `--z-banner 1200` (update) < `--z-palette 1300` < `--z-toast 1400`.
- `--focus-ring: 2px solid var(--accent)`; `--poster-min` (grid column minimum, from Settings).

## Contrast (measured)

`--muted #8a919e` on `--bg` 5.8:1, on `--panel` 5.2:1, on `--panel-2` **4.48:1** (audit A4). Light `--muted #5a616c` on `--panel-2` 5.4:1. Fifteen rules are 10–11 px (audit A3).

## Layout

`body` = flex: 56 px icon rail + `#content` (topbar shown only while watching, `#view` relative). Views are `position:absolute; inset:0; overflow-y:auto` with hidden scrollbars (`scrollbar-width:none` + `::-webkit-scrollbar`). Grids: `repeat(auto-fill, minmax(var(--poster-min), 1fr))`; match grid 200 px min, max 1280 px centred. One breakpoint at 720 px (stacked detail hero, smaller hero, hidden hero arrows). Rails: flex rows with `align-items` default stretch (audit V3), responsive `clamp()` card widths.

## Component families

Cards (`.card`, `.poster-card`, `.resume-card`, `.match-card`, `.tile`, `.episode`, `.cast`), pills (`.pill-select`, `.pill-toggle`, `.filter-toggle`, `.subtabs .tab`), `.segmented`, `.switch`, `.set-*` settings rows, `.wiz-*` wizard, `.modal-overlay` (+ `.palette` variant top-aligned), `.palette-card` shared by palette / help / What's New, `.toast` (+ `.toast-btn`, countdown bar driven by `--toast-dur`), `.skel*` skeletons (shimmer), `.hero-*`, `.hp-*` hover preview, `.rail-chev` / `.fade-l|r`.

## Focus and input modes

`:focus-visible` rings on cards, tiles, episodes, match cards, src rows, hero controls, chevrons, toast button. Switch inputs are `opacity:0; width:0` → no visible focus (audit A1). `body.input-touch` pins hover-only affordances and grows targets to 44 px; `body.input-gamepad` rings plain `:focus` and mirrors hover layers on focused cards. `body.reduced-motion` (synced from `prefers-reduced-motion`) kills every animation/transition with one `!important` rule; the toast bar stays a static full-width line.

## Scrollbars

Every scroller hides its bar except the command palette list, which keeps a 6 px WebKit-styled one (`::-webkit-scrollbar` only — setting `scrollbar-width` too makes Chromium ignore the WebKit sizing).
