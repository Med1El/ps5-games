const express = require('express');
const path = require('path');
// lowdb@2 is ESM-only ("type": "module"), so it must be loaded via dynamic
// import() from this CommonJS file — require() throws ERR_REQUIRE_ESM on Vercel.

const DB_PATH = path.join(__dirname, 'data', 'games.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let db;
let dbReady;

async function initDb() {
  const { Low, JSONFile } = await import('lowdb');
  const adapter = new JSONFile(DB_PATH);
  db = new Low(adapter);
  await db.read();
  db.data = db.data || { games: [] };
  console.log(`DB loaded: ${db.data.games.length} games`);
}

// Lazily load the DB once per serverless instance (and reuse on warm invocations).
function ensureDb() {
  if (!dbReady) dbReady = initDb();
  return dbReady;
}

app.use(async (req, res, next) => {
  try {
    await ensureDb();
    next();
  } catch (err) {
    next(err);
  }
});

/**
 * Resolve enrichment fields for a game with source priority:
 *   gemini > claude > flat (legacy, pre-migration)
 *
 * Returns a flat object with the resolved values merged onto the game.
 * The original game.claude and game.gemini sub-objects are preserved.
 */
function resolveGame(g) {
  const flat = g.claude || {};            // legacy flat fields (pre-migration) OR claude sub-object
  const gemini = g.gemini || {};

  return {
    ...g,
    // Resolved flat fields (used for filtering/sorting)
    sizeInitialGB:       gemini.sizeInitialGB       ?? flat.sizeInitialGB       ?? g.sizeInitialGB       ?? null,
    sizeFinalGB:         gemini.sizeFinalGB         ?? flat.sizeFinalGB         ?? g.sizeFinalGB         ?? null,
    sizeDlcGB:           gemini.sizeDlcGB           ?? flat.sizeDlcGB           ?? g.sizeDlcGB           ?? null,
    estimatedDownloadsM: gemini.estimatedDownloadsM ?? flat.estimatedDownloadsM ?? g.estimatedDownloadsM ?? null,
    offline_only:        gemini.offline_only        ?? flat.offline_only        ?? g.offline_only        ?? null,
    isDLC:               gemini.isDLC               ?? flat.isDLC               ?? null,
    // Keep sources for the frontend to display
    claude: g.claude || null,
    gemini: g.gemini || null,
  };
}

// GET /api/games
// Query params (all optional):
//   scoreMin, scoreMax
//   sizeInitialMin, sizeInitialMax
//   sizeFinalMin, sizeFinalMax
//   sizeDlcMin, sizeDlcMax
//   downloadsMin, downloadsMax
//   genres        (comma-separated, OR match)
//   search        (name substring, case-insensitive)
//   offlineOnly   (true|false)
//   ids           (comma-separated game IDs — returns only these games)
//   sort          (score|name|sizeInitial|sizeFinal|sizeDlc|downloads, default: score)
//   order         (asc|desc, default: desc)
//   limit         (default: 100, max: 500)
//   offset        (default: 0)
app.get('/api/games', (req, res) => {
  const {
    scoreMin, scoreMax,
    sizeInitialMin, sizeInitialMax,
    sizeFinalMin, sizeFinalMax,
    sizeDlcMin, sizeDlcMax,
    downloadsMin, downloadsMax,
    genres, search, offlineOnly,
    sort = 'score', order = 'desc',
    limit = '100', offset = '0',
  } = req.query;

  const num = (v) => (v !== undefined && v !== '' ? parseFloat(v) : null);

  const filters = {
    scoreMin: num(scoreMin), scoreMax: num(scoreMax),
    sizeInitialMin: num(sizeInitialMin), sizeInitialMax: num(sizeInitialMax),
    sizeFinalMin: num(sizeFinalMin), sizeFinalMax: num(sizeFinalMax),
    sizeDlcMin: num(sizeDlcMin), sizeDlcMax: num(sizeDlcMax),
    downloadsMin: num(downloadsMin), downloadsMax: num(downloadsMax),
    genres: genres ? genres.split(',').map(g => g.trim()).filter(Boolean) : [],
    search: search ? search.trim().toLowerCase() : '',
    offlineOnly: offlineOnly === 'true' ? true : offlineOnly === 'false' ? false : null,
    isDLC: req.query.isDLC === 'true' ? true : req.query.isDLC === 'false' ? false : null,
    ids: req.query.ids ? req.query.ids.split(',').map(s => s.trim()).filter(Boolean) : null,
  };

  // Resolve all games once (merges claude/gemini into flat fields)
  let games = db.data.games.map(resolveGame);

  games = games.filter(g => {
    if (filters.ids !== null && !filters.ids.includes(g.id)) return false;
    if (filters.scoreMin !== null && (g.score === null || g.score < filters.scoreMin)) return false;
    if (filters.scoreMax !== null && (g.score === null || g.score > filters.scoreMax)) return false;
    if (filters.sizeInitialMin !== null && (g.sizeInitialGB === null || g.sizeInitialGB < filters.sizeInitialMin)) return false;
    if (filters.sizeInitialMax !== null && (g.sizeInitialGB === null || g.sizeInitialGB > filters.sizeInitialMax)) return false;
    if (filters.sizeFinalMin !== null && (g.sizeFinalGB === null || g.sizeFinalGB < filters.sizeFinalMin)) return false;
    if (filters.sizeFinalMax !== null && (g.sizeFinalGB === null || g.sizeFinalGB > filters.sizeFinalMax)) return false;
    if (filters.sizeDlcMin !== null && (g.sizeDlcGB === null || g.sizeDlcGB < filters.sizeDlcMin)) return false;
    if (filters.sizeDlcMax !== null && (g.sizeDlcGB === null || g.sizeDlcGB > filters.sizeDlcMax)) return false;
    if (filters.downloadsMin !== null && (g.estimatedDownloadsM === null || g.estimatedDownloadsM < filters.downloadsMin)) return false;
    if (filters.downloadsMax !== null && (g.estimatedDownloadsM === null || g.estimatedDownloadsM > filters.downloadsMax)) return false;
    if (filters.genres.length > 0) {
      const gameGenres = (g.genres || []).map(x => x.toLowerCase());
      if (!filters.genres.some(fg => gameGenres.includes(fg.toLowerCase()))) return false;
    }
    if (filters.search && !g.name.toLowerCase().includes(filters.search)) return false;
    if (filters.offlineOnly !== null && g.offline_only !== filters.offlineOnly) return false;
    if (filters.isDLC !== null && g.isDLC !== filters.isDLC) return false;
    return true;
  });

  // Sort
  const sortKey = {
    score: 'score', name: 'name',
    sizeInitial: 'sizeInitialGB', sizeFinal: 'sizeFinalGB',
    sizeDlc: 'sizeDlcGB', downloads: 'estimatedDownloadsM',
  }[sort] || 'score';

  games.sort((a, b) => {
    const av = a[sortKey] ?? (order === 'desc' ? -Infinity : Infinity);
    const bv = b[sortKey] ?? (order === 'desc' ? -Infinity : Infinity);
    if (typeof av === 'string') return order === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return order === 'asc' ? av - bv : bv - av;
  });

  const total = games.length;
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  const off = parseInt(offset, 10) || 0;
  games = games.slice(off, off + lim);

  res.json({ total, offset: off, limit: lim, games });
});

// GET /api/meta — unique genres + min/max ranges for sliders (uses resolved values)
app.get('/api/meta', (req, res) => {
  const genreSet = new Set();
  let scoreMin = Infinity, scoreMax = -Infinity;
  let sizeInitialMin = Infinity, sizeInitialMax = -Infinity;
  let sizeFinalMin = Infinity, sizeFinalMax = -Infinity;
  let sizeDlcMin = Infinity, sizeDlcMax = -Infinity;
  let downloadsMin = Infinity, downloadsMax = -Infinity;

  for (const raw of db.data.games) {
    const g = resolveGame(raw);
    (g.genres || []).forEach(genre => genreSet.add(genre));
    if (g.score !== null)              { scoreMin = Math.min(scoreMin, g.score); scoreMax = Math.max(scoreMax, g.score); }
    if (g.sizeInitialGB !== null)      { sizeInitialMin = Math.min(sizeInitialMin, g.sizeInitialGB); sizeInitialMax = Math.max(sizeInitialMax, g.sizeInitialGB); }
    if (g.sizeFinalGB !== null)        { sizeFinalMin = Math.min(sizeFinalMin, g.sizeFinalGB); sizeFinalMax = Math.max(sizeFinalMax, g.sizeFinalGB); }
    if (g.sizeDlcGB !== null)          { sizeDlcMin = Math.min(sizeDlcMin, g.sizeDlcGB); sizeDlcMax = Math.max(sizeDlcMax, g.sizeDlcGB); }
    if (g.estimatedDownloadsM !== null){ downloadsMin = Math.min(downloadsMin, g.estimatedDownloadsM); downloadsMax = Math.max(downloadsMax, g.estimatedDownloadsM); }
  }

  res.json({
    totalGames: db.data.games.length,
    genres: [...genreSet].sort(),
    ranges: {
      score:       { min: isFinite(scoreMin)       ? scoreMin       : 0, max: isFinite(scoreMax)       ? scoreMax       : 100 },
      sizeInitial: { min: isFinite(sizeInitialMin) ? sizeInitialMin : 0, max: isFinite(sizeInitialMax) ? sizeInitialMax : 200 },
      sizeFinal:   { min: isFinite(sizeFinalMin)   ? sizeFinalMin   : 0, max: isFinite(sizeFinalMax)   ? sizeFinalMax   : 300 },
      sizeDlc:     { min: isFinite(sizeDlcMin)     ? sizeDlcMin     : 0, max: isFinite(sizeDlcMax)     ? sizeDlcMax     : 100 },
      downloads:   { min: isFinite(downloadsMin)   ? downloadsMin   : 0, max: isFinite(downloadsMax)   ? downloadsMax   : 100 },
    },
  });
});

// PATCH /api/games/:id — update editable fields (writes into claude sub-object after migration)
app.patch('/api/games/:id', async (req, res) => {
  const game = db.data.games.find(g => g.id === req.params.id);
  if (!game) return res.status(404).json({ error: 'Not found' });

  const enrichmentFields = ['sizeInitialGB', 'sizeFinalGB', 'sizeDlcGB', 'estimatedDownloadsM', 'offline_only', 'isDLC'];
  const topLevelFields   = ['genres'];

  // Write enrichment edits into claude sub-object if it exists, else flat
  const target = game.claude || game;
  for (const key of enrichmentFields) {
    if (key in req.body) target[key] = req.body[key];
  }
  for (const key of topLevelFields) {
    if (key in req.body) game[key] = req.body[key];
  }

  try {
    await db.write();
  } catch (err) {
    // On a read-only filesystem (e.g. Vercel) the in-memory edit succeeds but
    // cannot be persisted. Report it rather than crashing the request.
    return res.status(503).json({ error: 'read-only deployment: edit not persisted', game: resolveGame(game) });
  }
  res.json({ ok: true, game: resolveGame(game) });
});

app.post('/api/reload', async (req, res) => {
  await db.read();
  res.json({ ok: true, games: db.data.games.length });
});

// Run a real HTTP server only when invoked directly (local dev).
// On Vercel the app is imported by api/index.js and handled as a serverless function.
if (require.main === module) {
  initDb().then(() => {
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
  });
}

module.exports = app;
