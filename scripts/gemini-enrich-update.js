/**
 * gemini-enrich-update.js
 *
 * Runs Gemini enrichment over data/games_update1.json (the new-games file).
 * Saves batch results to data/gemini-enrichments/update1/gemini-batch-{N}.json
 * Auto-resumes: already-saved batch files are skipped on restart.
 *
 * Usage:
 *   node scripts/gemini-enrich-update.js              # enrich all, save batches
 *   node scripts/gemini-enrich-update.js --apply      # also apply each batch to games_update1.json immediately
 *   node scripts/gemini-enrich-update.js --test       # first batch only (dry-run / smoke test)
 *
 * Environment:
 *   GEMINI_API_KEY   (required — or set inline below)
 *   BATCH_SIZE       (default: 200)
 *   DELAY_MS         (ms between batches, default: 2000)
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Low, JSONFile }       = require('lowdb');

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY    = process.env.GEMINI_API_KEY;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const DELAY_MS   = parseInt(process.env.DELAY_MS   || '2000', 10);
const TEST_MODE  = process.argv.includes('--test');
const AUTO_APPLY = process.argv.includes('--apply');

// Points at the update file, not the main DB
const DB_PATH         = path.join(__dirname, '..', 'data', 'games_update1.json');
const ENRICHMENTS_DIR = path.join(__dirname, '..', 'data', 'gemini-enrichments', 'update1');

if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is not set.');
  process.exit(1);
}

// ── System prompt (identical to gemini-enrich.js) ────────────────────────────

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
    execSync(
      `node "${path.join(__dirname, 'apply-gemini-enrichment-update.js')}" "${filePath}"`,
      { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
    );
  } catch (e) {
    console.error(`Failed to apply batch: ${e.message}`);
  }
}

function parseGeminiResponse(text) {
  let clean = text.trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(clean);
    if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

function sanitizeResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    sizeInitialGB:       typeof raw.sizeInitialGB       === 'number'  ? raw.sizeInitialGB       : null,
    sizeFinalGB:         typeof raw.sizeFinalGB         === 'number'  ? raw.sizeFinalGB         : null,
    sizeDlcGB:           typeof raw.sizeDlcGB           === 'number'  ? raw.sizeDlcGB           : null,
    estimatedDownloadsM: typeof raw.estimatedDownloadsM === 'number'  ? raw.estimatedDownloadsM : null,
    offline_only:        typeof raw.offline_only        === 'boolean' ? raw.offline_only        : null,
    isDLC:               typeof raw.isDLC               === 'boolean' ? raw.isDLC               : false,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`ERROR: ${DB_PATH} not found. Run scrape-update.js first.`);
    process.exit(1);
  }

  // Load update games file
  const adapter = new JSONFile(DB_PATH);
  const db      = new Low(adapter);
  await db.read();
  const allGames = db.data.games;

  const existingBatches = loadExistingBatchNumbers();

  const batches = [];
  for (let i = 0; i < allGames.length; i += BATCH_SIZE) {
    batches.push(allGames.slice(i, i + BATCH_SIZE));
  }

  console.log('=== gemini-enrich-update.js ===');
  console.log(`Source       : ${DB_PATH}`);
  console.log(`Batches dir  : ${ENRICHMENTS_DIR}`);
  console.log(`Total games  : ${allGames.length}`);
  console.log(`Batch size   : ${BATCH_SIZE}`);
  console.log(`Total batches: ${batches.length}`);
  console.log(`Already done : ${existingBatches.size} batch(es)`);
  if (TEST_MODE)  console.log('TEST MODE    : only running batch 1');
  if (AUTO_APPLY) console.log('AUTO APPLY   : will apply each batch to games_update1.json');
  console.log('');

  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-3.8-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.1,
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

    let result   = {};
    let attempt  = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response = await model.generateContent(JSON.stringify(input));
        const text     = response.response.text();
        const parsed   = parseGeminiResponse(text);

        if (!parsed) {
          console.warn(`  Attempt ${attempt}: Could not parse response. Retrying…`);
          if (attempt < maxAttempts) await sleep(3000);
          continue;
        }

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
      console.log('  Applying to games_update1.json…');
      await applyBatchFile(outPath);
    }

    if (batchNum < batches.length) await sleep(DELAY_MS);
  }

  console.log('');
  console.log(`=== Enrichment complete ===`);
  console.log(`Processed : ${totalProcessed} games`);
  console.log(`Failed    : ${totalFailed} games`);
  console.log('');
  if (!AUTO_APPLY && totalProcessed > 0) {
    console.log('To apply all saved batches to games_update1.json, run:');
    console.log('  node scripts/apply-gemini-enrichment-update.js --all');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
