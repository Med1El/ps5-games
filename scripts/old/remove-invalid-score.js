const path = require('path');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, 'data', 'games.json');

async function main() {
  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();
  db.data = db.data || { games: [] };

  const before = db.data.games.length;
  db.data.games = db.data.games.filter(game => game.score !== -1);
  const after = db.data.games.length;
  const removed = before - after;

  if (removed > 0) {
    await db.write();
    console.log(`✓ Removed ${removed} games with score=-1`);
    console.log(`  Before: ${before} games`);
    console.log(`  After: ${after} games`);
  } else {
    console.log('No games with score=-1 found.');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
