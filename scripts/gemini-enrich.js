/**
 * gemini-enrich.js
 *
 * Sends PS5 games to Gemini in batches and saves structured enrichment data.
 *
 * For each game it asks Gemini to estimate:
 *   - sizeInitialGB     : install size at launch (before patches)
 *   - sizeFinalGB       : install size after all updates/patches
 *   - sizeDlcGB         : total size of all DLC combined (0 if none)
 *   - estimatedDownloadsM : estimated total downloads across all platforms (millions)
 *   - offline_only      : true if no internet is ever required to play
 *   - isDLC             : true if this entry is actually a DLC/expansion, not a full game
 *
 * Enrichment files are saved to:
 *   data/gemini-enrichments/gemini-batch-{N}.json
 *
 * Auto-resume: already-saved batch files are skipped on restart.
 *
 * Usage:
 *   GEMINI_API_KEY=your_key node scripts/gemini-enrich.js
 *   GEMINI_API_KEY=your_key node scripts/gemini-enrich.js --test   (first batch only)
 *   GEMINI_API_KEY=your_key node scripts/gemini-enrich.js --apply  (also apply to DB after each batch)
 *
 * Environment variables:
 *   GEMINI_API_KEY  (required)
 *   BATCH_SIZE      (default: 200)
 *   DELAY_MS        (ms to wait between batches, default: 2000)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Low, JSONFile } = require('lowdb');

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY   = process.env.GEMINI_API_KEY;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const DELAY_MS   = parseInt(process.env.DELAY_MS   || '2000', 10);
const TEST_MODE  = process.argv.includes('--test');
const AUTO_APPLY = process.argv.includes('--apply');

const DB_PATH         = path.join(__dirname, '..', 'data', 'games.json');
const ENRICHMENTS_DIR = path.join(__dirname, '..', 'data', 'gemini-enrichments');

if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set.');
  console.error('  Set it with: $env:GEMINI_API_KEY="your_key_here"  (PowerShell)');
  process.exit(1);
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a precise PS5 game data analyst. Your task is to estimate technical and commercial data for PS5 games based on your knowledge.

You will receive a JSON array of games, each with a "name" and "releaseDate".

For EACH game return ONLY a JSON object mapping the game name (exactly as given) to its data fields.

FIELDS TO ESTIMATE:
- sizeInitialGB (number): The PS5 install size in gigabytes at the game's original launch, before any patches. Use real-world reported sizes where known. For unknown games, estimate based on genre (indie: 1-5GB, AA action: 10-30GB, AAA open world: 50-130GB). Never return 0 unless it's a trivially small web game.
- sizeFinalGB (number): The install size after all major updates and patches have been applied. Usually 10-40% larger than sizeInitialGB for games with ongoing support. For games discontinued or with no updates, equal to sizeInitialGB.
- sizeDlcGB (number): Total combined install size of ALL paid DLC and expansions in gigabytes. Use 0 if the game has no DLC. Count only paid DLC, not free patches/updates.
- estimatedDownloadsM (number): Estimated total downloads/copies sold across ALL platforms (PC, PS4, PS5, Xbox, Switch, etc.) in millions. This is a best-effort industry estimate. AAA games: 5-30M. Mid-tier: 0.5-5M. Indie: 0.01-0.5M. Free-to-play: can be 10-100M+.
- offline_only (boolean): true if the game can be played entirely without an internet connection (single-player or local multiplayer). false if it requires internet to play (online-only, live service, MMO). null if unknown or mixed.
- isDLC (boolean): true if this entry is NOT a standalone full game but is actually a DLC, expansion pack, season pass, or add-on content for another game. false if it is a standalone full game or free-to-play base game.

CRITICAL RULES:
1. Return ONLY valid JSON. No markdown, no explanation, no code fences, no extra text.
2. Use the EXACT game name as the key, copied character-for-character from the input.
3. All numeric values must be numbers (not strings). Use null only if you truly have no basis for an estimate.
4. isDLC: Look for keywords in the name like "DLC", "Expansion", "Season Pass", "Chapter", "Episode", "Pack", "Bundle Add-on", or names that are clearly sub-titles of a parent game (e.g. "Game Name: Story DLC").
5. offline_only: Online-only games include MMOs, battle royale, sports live services (eFootball, FIFA Ultimate Team). Singleplayer-focused games are typically true.
6. sizeDlcGB: If a game has a season pass or known DLC, estimate the size. Do not confuse DLC size with update size.
7. For games you are uncertain about, provide genre-based estimates rather than returning null. Null should be a last resort.

EXAMPLE INPUT:
[
  {"name": "Elden Ring", "releaseDate": "Feb 25, 2022"},
  {"name": "Fortnite", "releaseDate": "Jul 25, 2017"}
]

EXAMPLE OUTPUT (return exactly this structure, nothing else):
{
  "Elden Ring": {
    "sizeInitialGB": 44.0,
    "sizeFinalGB": 60.0,
    "sizeDlcGB": 16.0,
    "estimatedDownloadsM": 25.0,
    "offline_only": true,
    "isDLC": false
  },
  "Fortnite": {
    "sizeInitialGB": 26.0,
    "sizeFinalGB": 35.0,
    "sizeDlcGB": 0,
    "estimatedDownloadsM": 350.0,
    "offline_only": false,
    "isDLC": false
  }
}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function batchFilePath(n) {
  return path.join(ENRICHMENTS_DIR, `gemini-batch-${n}.json`);
}

function loadExistingBatchNumbers() {
  if (!fs.existsSync(ENRICHMENTS_DIR)) fs.mkdirSync(ENRICHMENTS_DIR, { recursive: true });
  return new Set(
    fs.readdirSync(ENRICHMENTS_DIR)
      .map(f => f.match(/^gemini-batch-(\d+)\.json$/))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10))
  );
}

async function applyBatchFile(filePath) {
  const { execSync } = require('child_process');
  try {
    execSync(`node "${path.join(__dirname, 'apply-gemini-enrichment.js')}" "${filePath}"`, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch (e) {
    console.error(`Failed to apply batch: ${e.message}`);
  }
}

// ── Parse Gemini response (handles edge cases) ────────────────────────────────

function parseGeminiResponse(text) {
  // Strip any accidental markdown code fences
  let clean = text.trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // Some models wrap in an outer object — try direct parse first
  try {
    const parsed = JSON.parse(clean);
    // Validate: should be a plain object of game-name → fields
    if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}

  // Try to extract the first JSON object from the text
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }

  return null;
}

// ── Validate and sanitize a single game's Gemini result ──────────────────────

function sanitizeResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    sizeInitialGB:      typeof raw.sizeInitialGB      === 'number' ? raw.sizeInitialGB      : null,
    sizeFinalGB:        typeof raw.sizeFinalGB        === 'number' ? raw.sizeFinalGB        : null,
    sizeDlcGB:          typeof raw.sizeDlcGB          === 'number' ? raw.sizeDlcGB          : null,
    estimatedDownloadsM:typeof raw.estimatedDownloadsM=== 'number' ? raw.estimatedDownloadsM: null,
    offline_only:       typeof raw.offline_only       === 'boolean'? raw.offline_only       : null,
    isDLC:              typeof raw.isDLC              === 'boolean'? raw.isDLC              : false,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load DB
  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();
  const allGames = db.data.games;

  // Determine which batch numbers already exist
  const existingBatches = loadExistingBatchNumbers();

  // Slice into batches
  const batches = [];
  for (let i = 0; i < allGames.length; i += BATCH_SIZE) {
    batches.push(allGames.slice(i, i + BATCH_SIZE));
  }

  console.log(`Total games  : ${allGames.length}`);
  console.log(`Batch size   : ${BATCH_SIZE}`);
  console.log(`Total batches: ${batches.length}`);
  console.log(`Already done : ${existingBatches.size} batch(es)`);
  if (TEST_MODE) console.log(`TEST MODE    : only running batch 1`);
  if (AUTO_APPLY) console.log(`AUTO APPLY   : will apply each batch to DB`);
  console.log('');

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.1,      // Low temperature = more deterministic, factual answers
      responseMimeType: 'application/json',
    },
  });

  let totalProcessed = 0;
  let totalFailed    = 0;

  for (let batchNum = 1; batchNum <= batches.length; batchNum++) {
    if (TEST_MODE && batchNum > 1) {
      console.log('Test mode: stopping after batch 1.');
      break;
    }

    if (existingBatches.has(batchNum)) {
      console.log(`Batch ${batchNum}/${batches.length} — skipped (already saved)`);
      continue;
    }

    const batch = batches[batchNum - 1];
    const input = batch.map(g => ({ name: g.name, releaseDate: g.releaseDate || '' }));

    console.log(`Batch ${batchNum}/${batches.length} — sending ${batch.length} games to Gemini…`);

    let result = {};
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response = await model.generateContent(JSON.stringify(input));
        const text = response.response.text();
        const parsed = parseGeminiResponse(text);

        if (!parsed) {
          console.warn(`  Attempt ${attempt}: Could not parse response. Retrying…`);
          if (attempt < maxAttempts) await sleep(3000);
          continue;
        }

        // Sanitize each game's result
        for (const [name, raw] of Object.entries(parsed)) {
          const clean = sanitizeResult(raw);
          if (clean) result[name] = clean;
        }

        const received = Object.keys(result).length;
        const expected = batch.length;
        console.log(`  Received: ${received}/${expected} games`);

        if (received < expected * 0.5 && attempt < maxAttempts) {
          console.warn(`  Only got ${received} of ${expected} — retrying…`);
          result = {};
          await sleep(3000);
          continue;
        }

        break; // success
      } catch (err) {
        console.error(`  Attempt ${attempt} error: ${err.message}`);
        if (attempt < maxAttempts) await sleep(5000 * attempt);
      }
    }

    if (Object.keys(result).length === 0) {
      console.error(`  FAILED batch ${batchNum} after ${maxAttempts} attempts. Skipping.`);
      totalFailed += batch.length;
      continue;
    }

    // Save enrichment file
    const outPath = batchFilePath(batchNum);
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`  Saved → ${path.relative(process.cwd(), outPath)}`);
    totalProcessed += Object.keys(result).length;

    // Optionally apply to DB immediately
    if (AUTO_APPLY) {
      console.log(`  Applying to DB…`);
      await applyBatchFile(outPath);
    }

    // Delay between batches to avoid rate limits
    if (batchNum < batches.length && !TEST_MODE) {
      await sleep(DELAY_MS);
    }
  }

  console.log('');
  console.log(`Done.`);
  console.log(`  Processed : ${totalProcessed} games`);
  console.log(`  Failed    : ${totalFailed} games`);
  if (!AUTO_APPLY && totalProcessed > 0) {
    console.log('');
    console.log('To apply all saved batches to the DB, run:');
    console.log('  for ($i=1; $i -le ' + batches.length + '; $i++) { node scripts/apply-gemini-enrichment.js "data/gemini-enrichments/gemini-batch-$i.json" }');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
