/**
 * apply-gemini-enrichment.js
 *
 * Applies a saved Gemini enrichment batch file to games.json.
 * Reads the batch file, finds each game by name, and writes the
 * Gemini estimates into game.gemini = { ... }.
 *
 * Usage:
 *   node scripts/apply-gemini-enrichment.js data/enrichments/gemini-batch-1.json
 *
 * Batch file format (produced by gemini-enrich.js):
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
const fs = require('fs');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, '..', 'data', 'games.json');

async function main() {
  const batchFile = process.argv[2];
  if (!batchFile) {
    console.error('Usage: node scripts/apply-gemini-enrichment.js <batch-file.json>');
    process.exit(1);
  }

  const batchPath = path.resolve(batchFile);
  if (!fs.existsSync(batchPath)) {
    console.error(`Batch file not found: ${batchPath}`);
    process.exit(1);
  }

  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));

  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();

  // Build name→game index for fast lookup
  const byName = new Map(db.data.games.map(g => [g.name.toLowerCase(), g]));

  let applied = 0;
  let notFound = 0;

  for (const [name, data] of Object.entries(batch)) {
    const game = byName.get(name.toLowerCase());
    if (!game) {
      console.warn(`  NOT FOUND in DB: "${name}"`);
      notFound++;
      continue;
    }
    game.gemini = { ...data };
    applied++;
  }

  await db.write();

  console.log(`Applied ${path.basename(batchPath)}`);
  console.log(`  Written  : ${applied} games`);
  console.log(`  Not found: ${notFound} games`);
}

main().catch(err => { console.error(err); process.exit(1); });
