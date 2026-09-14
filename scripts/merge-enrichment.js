const path = require('path');
const fs = require('fs');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, '..', 'data', 'games.json');

async function merge(batchFile) {
  const batchPath = path.resolve(__dirname, '..', batchFile);
  const batchRaw = fs.readFileSync(batchPath, 'utf-8');
  const batchData = JSON.parse(batchRaw);

  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();
  db.data = db.data || { games: [] };

  let count = 0;
  for (const game of db.data.games) {
    const data = batchData[game.name];
    if (data) {
      game.sizeInitialGB = data.sizeInitialGB;
      game.sizeFinalGB = data.sizeFinalGB;
      game.sizeDlcGB = data.sizeDlcGB;
      game.estimatedDownloadsM = data.estimatedDownloadsM;
      game.offline_only = data.offline_only;
      count++;
    }
  }

  await db.write();
  console.log(`✓ Merged ${count} games from ${batchFile}`);
}

const batchFile = process.argv[2] || 'enrichment-data-batch1.json';
merge(batchFile).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
