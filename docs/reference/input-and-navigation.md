# Keyboard, controller, touch and navigation (keyboard.js, input.js, rail.js)

## Keyboard map (document-level dispatcher)

| Key | Action |
|-----|--------|
| `0` / `1 2 3` / `4` / `5` | Dashboard / Browse Movies, TV, Anime (clears the query) / Live TV / YouTube (untracked) |
| `/`, Ctrl+F | Focus the Browse search (keeps the query; hops off Live) |
| Ctrl/Cmd+K | Command palette (also forwarded from inside the guest player by main) |
| `?` | Shortcuts + controller overlay |
| ← ↑ → ↓ | `moveGrid` — see below |
| Enter | Click the focused `NAV_SEL` item |
| Esc | First Esc blurs a form field; then `goBack()` |

Keys are ignored while `modalOpen()` or `typing()` (input/textarea/select/contenteditable).

## Esc / back chain (`goBack` → `exitPlayer`)

modal (lightbox → palette → help → What's New → wizard) → person page (→ its detail or Browse) → Settings (→ Browse) → detail / live picker (→ its origin via `detailBackTo`, or Live) → player (`exitPlayer`: back to `openedFrom` = dashboard | home | live | detail | browse; no-op while the guest is HTML-fullscreen). Top-level views have no back. Esc inside the guest is forwarded by main's `before-input-event`.

## Grid navigation (`moveGrid`)

`NAV_SEL = '.card, .episode, .match-card, .src-row, .cast'`. With nothing focused, seed the first item of the visible view. Inside a `.rail` (dashboard) ←/→ walk the rail and ↑/↓ hop to the nearest rail with a focusable item; elsewhere the container is `.grid, .episodes, .src-list, .rail` and column count comes from the computed `grid-template-columns`. Movement clamps at the container edge — buttons, selects, tabs, pager, hero controls, rail buttons and every Settings control are unreachable this way (audit A2).

## Controller (input.js)

Gamepad API polled on rAF (started on `gamepadconnected`). D-pad / left stick (0.5 deadzone) → `padMove` (400 ms hold delay, 110 ms repeat). A = click focused (or seed), B = `goBack`, X = search, Y = preview toggle, LB/RB = page the rail or view, Start = palette. Modals swallow everything except B. Body class `input-gamepad` rings plain `:focus` (script-moved focus is not `:focus-visible`). While the guest has focus the host poll is dead, so `webview-preload.js` polls B/Start itself and main relays them (`guest-pad`), then the host re-seeds focus. One-time hint toast on first connect.

## Touch

`input-touch` body class: hover-only affordances become permanent, targets grow to 44 px. Long-press (500 ms, 10 px slop) on a poster card = hover preview; the follow-up click is swallowed once.

## Input-mode classes

`input-pointer` (default), `input-touch` (touch pointerdown), `input-gamepad` (any pad press/move; a real mouse move leaves it). CSS keys every affordance change off these — there is no separate "TV mode".

## Rails (rail.js)

`wireRail(rail)`: hidden scrollbar, hover-revealed chevrons (0.8 × width per click, `auto` scroll under reduced motion), edge fade classes from scroll position via one rAF-coalesced handler + a ResizeObserver. Used by dashboard rails, detail rails, cast row, providers row, person "Known For".
