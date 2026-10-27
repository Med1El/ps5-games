/**
 * apply-gemini-enrichment-update.js
 *
 * Applies a saved Gemini enrichment batch (or all batches) to data/games_update1.json.
 * Reads batch file(s), finds each game by name (case-insensitive), and writes
 * enrichment data into game.gemini = { ... }.
 *
 * Usage:
 *   # Apply a single batch file:
 *   node scripts/apply-gemini-enrichment-update.js data/gemini-enrichments/update1/gemini-batch-1.json
 *
 *   # Apply ALL batches in the update1 folder:
 *   node scripts/apply-gemini-enrichment-update.js --all
 *
 * Batch file format (produced by gemini-enrich-update.js):
 * {
 *   "Game Name": {
 *     "sizeInitialGB": 50,
 *     "sizeFinalGB": 60,
 *     "sizeDlcGB": 5,
 *     "estimatedDownloadsM": 3.5,
 *     "offline_only": true,
 *     "isDLC": false
 *   },
 *   ...
 * }
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { Low, JSONFile } = require('lowdb');

const DB_PATH         = path.join(__dirname, '..', 'data', 'games_update1.json');
const ENRICHMENTS_DIR = path.join(__dirname, '..', 'data', 'gemini-enrichments', 'update1');

async function applyBatch(batchPath, db) {
  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  const byName = new Map(db.data.games.map(g => [g.name.toLowerCase(), g]));

  let applied  = 0;
  let notFound = 0;

  for (const [name, data] of Object.entries(batch)) {
    const game = byName.get(name.toLowerCase());
    if (!game) {
      console.warn(`  NOT FOUND: "${name}"`);
      notFound++;
      continue;
    }
    game.gemini = { ...data };
    applied++;
  }

  return { applied, notFound };
}

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.error('Usage:');
    console.error('  node scripts/apply-gemini-enrichment-update.js <batch-file.json>');
    console.error('  node scripts/apply-gemini-enrichment-update.js --all');
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`ERROR: ${DB_PATH} not found. Run scrape-update.js first.`);
    process.exit(1);
  }

  const adapter = new JSONFile(DB_PATH);
  const db      = new Low(adapter);
  await db.read();

  if (arg === '--all') {
    // Apply every batch in the update1 enrichments folder, sorted numerically
    if (!fs.existsSync(ENRICHMENTS_DIR)) {
      console.error(`ERROR: Enrichments folder not found: ${ENRICHMENTS_DIR}`);
      console.error('Run gemini-enrich-update.js first.');
      process.exit(1);
    }

    const batchFiles = fs.readdirSync(ENRICHMENTS_DIR)
      .map(f => ({ file: f, match: f.match(/^gemini-batch-(\d+)\.json$/) }))
      .filter(x => x.match)
      .sort((a, b) => parseInt(a.match[1]) - parseInt(b.match[1]))
      .map(x => path.join(ENRICHMENTS_DIR, x.file));

    if (batchFiles.length === 0) {
      console.log('No batch files found in', ENRICHMENTS_DIR);
      process.exit(0);
    }

    console.log(`Applying ${batchFiles.length} batch file(s) to games_update1.json…\n`);

    let totalApplied  = 0;
    let totalNotFound = 0;

    for (const batchPath of batchFiles) {
      const rel = path.relative(process.cwd(), batchPath);
      process.stdout.write(`  ${rel} … `);
      const { applied, notFound } = await applyBatch(batchPath, db);
      console.log(`applied ${applied}, not found ${notFound}`);
      totalApplied  += applied;
      totalNotFound += notFound;
    }

    await db.write();

    console.log('');
    console.log(`=== Done ===`);
    console.log(`Total applied  : ${totalApplied}`);
    console.log(`Total not found: ${totalNotFound}`);

  } else {
    // Apply a single specified file
    const batchPath = path.resolve(arg);
    if (!fs.existsSync(batchPath)) {
      console.error(`Batch file not found: ${batchPath}`);
      process.exit(1);
    }

    const { applied, notFound } = await applyBatch(batchPath, db);
    await db.write();

    console.log(`Applied ${path.basename(batchPath)}`);
    console.log(`  Written  : ${applied} games`);
    console.log(`  Not found: ${notFound} games`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
