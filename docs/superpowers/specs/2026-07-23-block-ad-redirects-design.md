# v0.16 — Stop pages dragging you to ads

**Date:** 2026-07-23
**Status:** approved, ready to plan
**Ships as:** v0.16 (see "Version renumber" below)

---

## The problem

While using a movie/video source, the app sometimes navigates away to an ad page on its own.

We already block ad **windows** from opening (`setWindowOpenHandler` denies any cross-host
`window.open`). But when that's blocked, ad scripts fall back to navigating the **current page**
to the ad instead — and we never checked for that.

The hook that catches it (`will-navigate`) already exists in `main.js`, but it only handles one
special case (popping Google login out to its own window). Everything else passes through.

Two things worth recording, because they rule out the "obvious" alternative fixes:

- **Filter lists cannot fix this.** `@ghostery/adblocker` does not implement the `$popup` /
  `$popunder` filter options at all — those rules parse as unsupported and are silently dropped.
  Adding AdGuard Popups or Fanboy's Annoyances would be dead weight. Popup/redirect blocking is
  the app's job, not the filter engine's.
- **`@ghostery/adblocker-electron` is still the right engine** (2.18.x, actively published, same
  engine Ghostery ships). No maintained competitor for Electron. Not replacing it.

---

## What we're building

Four changes. The first three are in `main.js`, inside the existing
`app.on('web-contents-created')` webview branch. The fourth is the renderer toast.

### 1. Block off-site jumps the page starts

In the existing `will-navigate` handler, after the Google-login branch: if the target's base
domain differs from the current page's base domain, cancel the navigation and tell the renderer.

**Base domain, not exact host.** `player.site.com` → `site.com` and `www.x.com` → `m.x.com` are
the same site and must keep working. Compare the last two labels of the hostname.
`// ponytail: last-two-labels is wrong for .co.uk-style suffixes — it over-blocks there, which is
the safe direction. Swap in a public-suffix check only if a real site trips it.`

### 2. Same check on server redirects

Add a `will-redirect` handler with the same base-domain check. Ad networks bounce through a chain
of redirects, so the first hop can look innocent while the destination isn't.

### 3. Kill "Are you sure you want to leave?" traps

`contents.on('will-prevent-unload', (e) => e.preventDefault())` — calling `preventDefault` here
*allows* the unload, so the dialog never appears. These exist only to keep you on the ad page.

### 4. Toast with an Allow button

Main sends the blocked URL to the host renderer; the renderer shows:

> Blocked a redirect to `example.com`  **[Allow]**

**Allow** navigates the webview to that URL. This is the escape hatch: `will-navigate` fires both
for ad redirects *and* for a legitimate off-site link you clicked (e.g. a link in a YouTube
description), and Electron does not tell us which is which. Ad redirects you ignore; a link you
meant gets you there in one click.

The existing `toast()` (core.js) is text-only and replace-in-place, so it needs an optional action
button. Replace-in-place also means a page firing many redirects can't stack up toasts — it
self-limits, no extra rate-limiting needed.

---

## Explicitly not doing

- **`will-frame-navigate`** (ad iframes navigating themselves). Fires constantly on normal pages
  and mostly achieves nothing visible. Add later only if in-iframe ad churn actually bothers us.
- **Popup filter lists.** See above — the engine ignores those rules.
- **Injecting a CSP `sandbox` header on subframes** to strip `allow-top-navigation`. It would work
  in theory, but it is untested inside an Electron `<webview>`, carries high breakage risk on real
  player iframes, and would have to wrap the Ghostery adapter's existing `onHeadersReceived`
  listener. Not worth it when the `will-navigate` guard covers the reported symptom.
- **Persisting per-site "always allow".** YAGNI until a real site nags repeatedly.

---

## Assumptions (both must be verified by tests)

1. **App-driven navigation does not fire `will-navigate`.** The app opens sources with
   `webview.src = url`, which maps to `loadURL`, which per Electron docs does not fire
   `will-navigate`. If this is wrong, every source-open would be blocked. The existing suite would
   fail loudly (dozens of tests open sources), so this is self-checking — but call it out.
2. **Same-site navigation inside a player still works.** Players navigate themselves within their
   own domain constantly; that must be untouched.

---

## How we'll know it worked

- A page that tries to send itself to a different site is stopped, and the toast fires with the
  blocked host in it.
- The toast's Allow button navigates to the blocked URL.
- Same-site navigation is unaffected.
- A server redirect chain that ends on a different site is stopped.
- The existing suite stays green — in particular the tests that open sources, the Google-login
  pop-out path, and the same-host `window.open` → navigate-in-place behaviour.
- Real-world: no more being yanked to an ad page mid-video.

Every new behaviour needs a test that **fails when the change is reverted**. This project has
shipped three near-vacuous tests; each new assertion gets an explicit revert-proof.

---

## Version renumber (rides along with this release)

Currently v0.7.0, which reads as "nearly 1.0" when the app is nowhere near that.

**New scheme: v0.16, then +0.01 per release** (0.17, 0.18, …). That's the 7 milestones shipped so
far counted at 0.01 each, and leaves ~84 releases of runway before 1.0.

**Hard constraint:** version numbers can never go *down*, or the installed app stops auto-updating.
The installed app is 0.7.0; `0.16.0` counts as **newer** because the updater compares the middle
number (16 > 7). Anything from 0.10 to 0.99 is safe; 0.1–0.7 would break auto-update.

Past tags and releases are **not** renamed — that would break existing download links and rewrite
published history for no user benefit. One line in the changelog explains the jump.

---

## Constraints (unchanged, non-negotiable)

- Zero committed providers/URLs; providers live only in the user's localStorage.
- No stream extraction.
- Classic scripts, no build step, no ES modules.
- No new runtime dependencies, no new binary assets, CSP unchanged.
- Both light and dark themes; all animation behind `body:not(.reduced-motion)`.
- Works with no TMDB key and an empty library.

---

## Follow-on releases (planned, not in this spec)

- **v0.17 — YouTube anti-adblock hardening.** YouTube reads a pristine `JSON.parse`/`fetch` out of
  a hidden `about:blank` iframe to bypass our patched copies; our cosmetic hiding of `#player-ads`
  is itself a detection signal; missing `/api/stats/atr` telemetry is another. Also: the one filter
  list that matters (quick-fixes) expires every 8 hours, and we refresh every 24.
- **v0.18 — SponsorBlock for YouTube.** Public API, no key, hash-prefix privacy mode. Data is
  CC BY-NC-SA 4.0 → visible attribution required, and do not vendor their GPLv3 client code.
