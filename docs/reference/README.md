# Reference docs

One file per aspect of the app. Read the one you need before touching that area; update it in the same commit when behaviour changes.

| File | Aspect |
|------|--------|
| [architecture.md](architecture.md) | Process model, hard constraints, file map, view switching, data keys |
| [main-process.md](main-process.md) | IPC surface, webview session policy, navigation guards, progress poll, window state, updater |
| [adblock-youtube.md](adblock-youtube.md) | Ad-block engine lifecycle, YouTube pruner / anti-detection / nag killer, test hooks |
| [tmdb-browse-detail-dashboard.md](tmdb-browse-detail-dashboard.md) | TMDB caching, Browse, hover preview, detail + person pages, dashboard rails + hero |
| [live-tv.md](live-tv.md) | Catalog parsing, two-hop resolution, grouping, caches, Live tab, source picker |
| [library-and-progress.md](library-and-progress.md) | Identity keys, capture pipeline, progress + auto-next, library cards, sources + `buildUrl`, repair migrations |
| [input-and-navigation.md](input-and-navigation.md) | Keyboard map, Esc chain, grid navigation, controller, touch, rails |
| [settings-and-migrations.md](settings-and-migrations.md) | Settings defaults, ⚙ main subset, installed-base migration rule, export/import, theme, What's New |
| [design-system.md](design-system.md) | Tokens, contrast, layout, component families, focus + input-mode classes |
| [testing-and-release.md](testing-and-release.md) | e2e harness, screenshots, CI, release ritual, build config |

Audit and roadmap: [../superpowers/specs/2026-09-04-full-audit-and-roadmap.md](../superpowers/specs/2026-09-04-full-audit-and-roadmap.md).
