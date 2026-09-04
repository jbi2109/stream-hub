# Testing, CI and the release ritual

## e2e suite (`npm test` → test/e2e.js)

- Plain Node (≥ 22 for global `WebSocket`/`fetch`), no deps. Launches the real app with `--remote-debugging-port=9223 --test-profile` (profile wiped first) and drives it over CDP (`test/cdp.js`: `CDP.connect/send/eval`, `until(fn, desc, timeout)`, `sleep`).
- **One sequential run, order-dependent** (~182 `ok()` checkpoints as of v0.17). A test may inherit state from earlier ones (entries in `cont`, an open toast, the webview's current page). New tests must clean up what they create (remove their toast, close modals, leave the webview on a known page) and must never rely on an earlier test's data.
- Prefer `until()` polls over `sleep()`; the existing 24 sleeps are settled paints, not synchronisation.
- Local fixture servers: site 9310 (`127.0.0.1` vs `localhost` = two base domains for cross-site tests), UA echo 9311, cross-origin player 9312, live catalogs 9314/9316/9317, two-hop catalog 9318, YouTube fixture 9315 (`SH_TEST_YT_HOST`), plus a TMDB stand-in behind `SH_TEST_TMDB_BASE`. Ad-block runs from `SH_TEST_BLOCK_PATTERN`. Nothing touches the network.
- Every behaviour needs a test that goes **red when the fix is reverted** — prove it by sed-ing the fix out and running the suite before restoring.
- `npm test 2>&1 | tail` buffers until exit and looks hung; use `until` on `/json` or run without `tail` when watching.

## Screenshots

`test/screenshots.js` writes `docs/hero.png` (fresh-profile onboarding) and, with `SH_SHOT_TMDB_KEY`, browse/detail shots on port 9333 — neutral by construction (crop anything showing a real provider). For ad-hoc visual QA use a scratch harness on another port with stubbed `tmdbGet`/`fetchCatalog` globals; never launch against the user's real profile while the app is running.

**Visual QA rule**: screenshot and eyeball after every UI change. Tests are not visual verification.

## CI (.github/workflows)

- `pr-ci.yml`: full e2e on every PR and push to `main` (windows-latest, Node 24, npm cache).
- `release.yml` on `v*` tags: e2e must pass, then the release is pre-created with `gh release create --generate-notes` (avoids the electron-builder double-publisher race), then `electron-builder --publish always` uploads `Stream-Hub-Setup-X.Y.Z.exe`, `.blockmap`, `latest.yml`.

## Release ritual

1. CHANGELOG.md: new top section `## vX.Y.Z — plain-language title (Month Year)` separated from the previous one by a line that is exactly `---` (the release script splits on `\n---\n` after stripping `\r`). Plain language, no jargon.
2. README/tests updated in the same commit.
3. e2e green twice.
4. `npm version minor` (+0.01 per release; versions never go down or auto-update breaks) → commit + tag, push both.
5. Poll the CI run; on success PATCH the GitHub release body from the CHANGELOG section; verify the three assets and that `latest.yml` points at the new version.
6. Post a short non-technical summary; then critique the implementation (look, style, code) and fix before the next release starts.

## Build

`package.json` `build.files`: everything except `test`, `docs`, `.github`, `.plans`, `*.md`, `launch.bat`, `dist` (`.impeccable` is not excluded — audit R5). NSIS one-click, per-user, GitHub publish.
