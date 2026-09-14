const path = require('path');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, 'data', 'games.json');

async function main() {
  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();
  db.data = db.data || { games: [] };

  let modified = 0;
  for (const game of db.data.games) {
    if (!('offline_only' in game)) {
      game.offline_only = null;
      modified++;
    }
  }

  if (modified > 0) {
    await db.write();
    console.log(`✓ Added 'offline_only' field to ${modified} games`);
  } else {
    console.log('No changes needed — all games already have the field.');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
