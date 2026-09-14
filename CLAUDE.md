# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the app (serves on http://localhost:3000)
node server.js

# Run Gemini enrichment (sends all games in batches of 200 to Gemini AI)
node scripts/gemini-enrich.js --apply       # enrich + immediately apply each batch to DB
node scripts/gemini-enrich.js --test        # test run: first batch only

# Apply a specific Gemini enrichment batch file to the DB
node scripts/apply-gemini-enrichment.js data/gemini-enrichments/gemini-batch-N.json

# Apply a range of batches (Bash)
for i in 21 22 23 24 25; do node scripts/apply-gemini-enrichment.js "data/gemini-enrichments/gemini-batch-$i.json"; done

# Apply manual Claude enrichment batches
node scripts/merge-enrichment.js data/enrichments/enrichment-data-batchN.json

# One-time migration: move flat enrichment fields into game.claude sub-object
node scripts/migrate-to-nested.js
```

## Architecture

**Stack**: Express.js + lowdb@2 (CommonJS, JSON file DB) + vanilla JS single-page frontend. No build step.

**Data flow**: `data/games.json` is the single source of truth (~4908 PS5 games). The server reads it via lowdb, keeps it in memory, and filters/sorts on every request.

### Enrichment layers

Each game can have three layers of enrichment data, resolved by `resolveGame()` in `server.js` with priority **gemini > claude > flat legacy**:

```
game.gemini  { sizeInitialGB, sizeFinalGB, sizeDlcGB, estimatedDownloadsM, offline_only, isDLC }
game.claude  { same fields }          ← written by PATCH /api/games/:id edits
(flat)       game.sizeInitialGB …     ← pre-migration legacy fields
```

`resolveGame(g)` merges these into a flat object for API responses. Never read `g.sizeInitialGB` directly from raw DB records — always go through `resolveGame`.

### API

- `GET /api/games` — filtered/sorted/paginated list. Supports: `scoreMin/Max`, `sizeInitialMin/Max`, `sizeFinalMin/Max`, `sizeDlcMin/Max`, `downloadsMin/Max`, `genres`, `search`, `offlineOnly`, `isDLC`, `ids` (comma-separated, bypasses pagination), `sort`, `order`, `limit`, `offset`.
- `GET /api/meta` — unique genres + min/max ranges for slider init.
- `PATCH /api/games/:id` — edits enrichment fields; writes into `game.claude` sub-object.
- `POST /api/reload` — re-reads DB from disk without restarting.

### Frontend (`public/index.html`)

Single file — all CSS, HTML, and JS inline. Key concepts:

**Views / tabs**: `currentView` ∈ `all | fav | played | upnext | snoozed | hidden`. List views (all except `all` and `hidden`) fetch with `?ids=<stored-ids>&limit=500` to show only the user's list. The `hidden` view calls `renderHiddenView()` which also uses `buildParams()` so sidebar filters apply there too.

**Exclusion rule**: `all` view excludes games in `ps5_hidden`, `ps5_played`, `ps5_snoozed`. List views show those games regardless (a game can be in multiple lists at once).

**localStorage keys**: `ps5_favs`, `ps5_hidden`, `ps5_played`, `ps5_upnext`, `ps5_snoozed`, `ps5_hnames` (name cache for hidden sidebar panel). All sets stored as JSON arrays of game ID strings.

**Event delegation**: all card button clicks are handled by a single listener on `#gameGrid` using `data-action` attributes (`fav`, `snoozed`, `played`, `upnext`, `hide`, `edit`). Never add inline `onclick` — game names with apostrophes will break them.

**`buildParams(offset)`**: centralised function that reads all active sidebar filters and returns a `URLSearchParams`. All fetch calls (including `renderHiddenView`) must go through this so filters stay consistent across views.

### Enrichment scripts

- `scripts/gemini-enrich.js` — sends batches of 200 games to `gemini-2.5-flash`, saves results to `data/gemini-enrichments/gemini-batch-N.json`, auto-resumes from last saved batch.
- `scripts/apply-gemini-enrichment.js` — matches batch JSON entries to DB games by name (case-insensitive) and writes into `game.gemini`.
- `data/enrichments/enrichment-data-batch1..43.json` — manual Claude enrichment batches (43 total, ~4908 games). Applied via `scripts/merge-enrichment.js`.
