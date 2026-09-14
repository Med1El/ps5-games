const path = require('path');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, 'data', 'games.json');

async function extract() {
  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();
  db.data = db.data || { games: [] };

  const names = db.data.games.map((g, i) => `${i}: ${g.name} (${g.genres.join(', ')})`);

  console.log(`Total games: ${names.length}\n`);
  console.log('Game list (first 200):');
  console.log(names.slice(0, 200).join('\n'));
}

extract().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
