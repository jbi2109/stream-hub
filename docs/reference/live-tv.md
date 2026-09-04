# Live TV engine (live.js)

A live source is either a plain **site** (`url`, opens in the webview) or a **catalog** (`catalogUrl`, a JSON API listing streams). Both are user-added; nothing is committed.

## Catalog parsing (`fetchCatalog`)

Fully generic walk of the JSON (cap 500 rows): title from `name|title|event|homeTeam v awayTeam|channel_name|stream_key`; embed from `embed_url|embedUrl|url|stream_url|iframe|src`; per-item `channels[]|sources[]|servers[]` expand to one row each; wrapper keys (`streams,data,results,items,events,matches,…`) are recursed without becoming a category, any other string key becomes the category ("Soccer"); start time from `date|match_timestamp|timestamp|starts_at|startTime|start|kickoff` (seconds→ms), popularity from `viewers|viewer_count|views|watching|popularity|popular:true`; language from an explicit field or a fuzzy word/code scan of the label.

**Two-hop** shape `{source, id}` with no embed → resolved later via `{origin}{path-before-/matches}/stream/{source}/{id}` then `{origin}/api/stream/{source}/{id}`; the first endpoint returning an array with embed fields wins (`fetchStreams`).

## Grouping and caches

- `groupMatches` pools rows into one match per team-order-aware key (`matchKey`: "A v B" == "B v A"), dedupes sources by embed (or source+id), keeps the earliest start and highest popularity, remembers each source's catalog + language.
- `liveCatalogCache` (per catalog URL, 90 s TTL, failures cached too, cap 20) — `warmCatalog` is shared with the dashboard rail. ↻ Refresh clears it and `resolvedCache` (per match + source count, cap 100).

## Live tab (`renderLiveTab`)

One merged match grid (v0.20: plain site sources render as `.match-card.site` cards at the front of it — name over the shared gradient, "Open site" caption, filtered by the search box but not by category): category sub-tabs (only when > 2), search, sort (default = live first then kickoff; "Most watched"), Live-now filter (both persisted in `liveView`), ↻ refresh, per-catalog status chips (`name …` → `✓ n` / `✕ failed`). Catalogs stream in incrementally; grid rebuilds are coalesced to one rAF and keyboard focus is kept by index. Match cards: 16:9 logo, `liveTimeChip` (LIVE ≤ 8 h old, "in 34m", today's time, or a date).

## Source picker (`showLivePicker`)

Rendered into `#detail`: back → Live tab, logo + title, skeleton rows, then `sourceList(liveMatchGroups(match, srcs))` grouped by catalog. Rows: quality chip (4K/FHD/HD/SD from the label), name, language chip, ▸ affordance. Ordering: ⚙ `liveLanguage` match first, then known-language rows, but unknown-language rows currently rank *above* known ones when no preference is set (audit B7). Picking a row `open(embed)`s it, marks the entry live (never enters Continue Watching), sets `currentLiveMatch` and shows the topbar Sources button + the hover-revealed player overlay (touch mode pins it; gamepad mode does not — audit A7).
