/**
 * migrate-to-nested.js
 *
 * One-time migration: moves flat enrichment fields on each game into a
 * `claude: { ... }` sub-object so the DB is ready for multi-source enrichment.
 *
 * Before:
 *   { id, name, score, ..., sizeInitialGB: 50, offline_only: true }
 *
 * After:
 *   { id, name, score, ..., claude: { sizeInitialGB: 50, offline_only: true } }
 *
 * Safe to run multiple times — already-migrated games are skipped.
 *
 * Usage:
 *   node scripts/migrate-to-nested.js
 */

'use strict';

const path = require('path');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, '..', 'data', 'games.json');

const ENRICHMENT_FIELDS = [
  'sizeInitialGB',
  'sizeFinalGB',
  'sizeDlcGB',
  'estimatedDownloadsM',
  'offline_only',
];

async function main() {
  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();

  const games = db.data.games;
  let migrated = 0;
  let skipped = 0;

  for (const game of games) {
    // Already migrated if `claude` key exists
    if (game.claude !== undefined) {
      skipped++;
      continue;
    }

    // Move flat fields into claude sub-object
    game.claude = {};
    for (const field of ENRICHMENT_FIELDS) {
      game.claude[field] = game[field] !== undefined ? game[field] : null;
      delete game[field];
    }

    migrated++;
  }

  await db.write();

  console.log(`Migration complete.`);
  console.log(`  Migrated : ${migrated} games`);
  console.log(`  Skipped  : ${skipped} games (already had claude sub-object)`);
  console.log(`  Total    : ${games.length} games`);
}

main().catch(err => { console.error(err); process.exit(1); });
