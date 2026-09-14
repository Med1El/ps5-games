const path = require('path');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, 'data', 'games.json');

// Enrichment data - add games here with their properties
const enrichmentData = {
  "Baldur's Gate 3": { sizeInitialGB: 150, sizeFinalGB: 170, sizeDlcGB: 0, estimatedDownloadsM: 20, offline_only: true },
  "Red Dead Redemption 2": { sizeInitialGB: 107, sizeFinalGB: 107, sizeDlcGB: 0, estimatedDownloadsM: 35, offline_only: true },
  "Elden Ring": { sizeInitialGB: 60, sizeFinalGB: 65, sizeDlcGB: 40, estimatedDownloadsM: 25, offline_only: true },
  "Astro Bot": { sizeInitialGB: 34, sizeFinalGB: 34, sizeDlcGB: 0, estimatedDownloadsM: 8, offline_only: true },
  "The Last of Us Remastered": { sizeInitialGB: 66, sizeFinalGB: 66, sizeDlcGB: 8, estimatedDownloadsM: 15, offline_only: true },
  "God of War": { sizeInitialGB: 88, sizeFinalGB: 90, sizeDlcGB: 0, estimatedDownloadsM: 18, offline_only: true },
  "Hades II": { sizeInitialGB: 25, sizeFinalGB: 25, sizeDlcGB: 0, estimatedDownloadsM: 5, offline_only: true },
  "Persona 5 Royal": { sizeInitialGB: 103, sizeFinalGB: 103, sizeDlcGB: 8, estimatedDownloadsM: 8, offline_only: true },
  "Persona 5": { sizeInitialGB: 103, sizeFinalGB: 103, sizeDlcGB: 0, estimatedDownloadsM: 5, offline_only: true },
  "Hades": { sizeInitialGB: 18, sizeFinalGB: 20, sizeDlcGB: 0, estimatedDownloadsM: 6, offline_only: true },
  "Elden Ring: Shadow of the Erdtree": { sizeInitialGB: 40, sizeFinalGB: 40, sizeDlcGB: 0, estimatedDownloadsM: 8, offline_only: true },
  "Journey": { sizeInitialGB: 3.5, sizeFinalGB: 3.5, sizeDlcGB: 0, estimatedDownloadsM: 3, offline_only: false },
  "Undertale": { sizeInitialGB: 2, sizeFinalGB: 2, sizeDlcGB: 0, estimatedDownloadsM: 4, offline_only: true },
  "Uncharted 4": { sizeInitialGB: 55, sizeFinalGB: 55, sizeDlcGB: 0, estimatedDownloadsM: 12, offline_only: true },
  "Metaphor: ReFantazio": { sizeInitialGB: 100, sizeFinalGB: 100, sizeDlcGB: 0, estimatedDownloadsM: 3, offline_only: true },
  "The Witcher 3": { sizeInitialGB: 136, sizeFinalGB: 136, sizeDlcGB: 40, estimatedDownloadsM: 30, offline_only: true },
  "Final Fantasy XIV: Endwalker": { sizeInitialGB: 110, sizeFinalGB: 110, sizeDlcGB: 0, estimatedDownloadsM: 15, offline_only: false },
  "Metal Gear Solid V": { sizeInitialGB: 84, sizeFinalGB: 84, sizeDlcGB: 0, estimatedDownloadsM: 12, offline_only: true },
  "The Last of Us Part II": { sizeInitialGB: 83, sizeFinalGB: 83, sizeDlcGB: 0, estimatedDownloadsM: 10, offline_only: true },
  "Vampire Survivors: Ode to Castlevania": { sizeInitialGB: 5, sizeFinalGB: 5, sizeDlcGB: 0, estimatedDownloadsM: 2, offline_only: true },
};

async function enrich() {
  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();
  db.data = db.data || { games: [] };

  let enrichedCount = 0;
  for (const game of db.data.games) {
    const data = enrichmentData[game.name];
    if (data) {
      game.sizeInitialGB = data.sizeInitialGB;
      game.sizeFinalGB = data.sizeFinalGB;
      game.sizeDlcGB = data.sizeDlcGB;
      game.estimatedDownloadsM = data.estimatedDownloadsM;
      game.offline_only = data.offline_only;
      enrichedCount++;
    }
  }

  await db.write();
  console.log(`✓ Enriched ${enrichedCount} games`);
}

enrich().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
