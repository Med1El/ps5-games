const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Low, JSONFile } = require('lowdb');

const DB_PATH = path.join(__dirname, 'data', 'games.json');
const TOTAL_PAGES = 246;
const BASE_URL = 'https://opencritic.com/browse/ps5';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return delay(1500 + Math.random() * 1000);
}

function parseGames($) {
  const games = [];
  $('.game-row').each((_, el) => {
    const row = $(el);
    const nameEl = row.find('.game-name a');
    const name = nameEl.text().trim();
    const href = nameEl.attr('href');
    if (!name || !href) return;

    const url = 'https://opencritic.com' + href;
    const scoreText = row.find('.inner-orb.small-orb').text().trim();
    const score = scoreText ? parseInt(scoreText, 10) : null;
    const genresText = row.find('.genres').text().trim();
    const genres = genresText
      ? genresText.split(',').map((g) => g.trim()).filter(Boolean)
      : [];
    const imageUrl = row.find('.img-fluid').attr('src') || null;
    const releaseDate = row.find('.first-release-date span').text().trim() || null;

    games.push({
      id: href.replace(/^\/game\//, '').replace(/\/.*/, ''),
      name,
      url,
      score,
      genres,
      imageUrl,
      releaseDate,
      sizeInitialGB: null,
      sizeFinalGB: null,
      sizeDlcGB: null,
      estimatedDownloadsM: null,
    });
  });
  return games;
}

async function fetchPage(page) {
  const url = `${BASE_URL}?page=${page}`;
  const response = await axios.get(url, {
    headers: {
      'User-Agent': randomUserAgent(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Cache-Control': 'no-cache',
    },
    timeout: 30000,
  });
  return response.data;
}

async function main() {
  const adapter = new JSONFile(DB_PATH);
  const db = new Low(adapter);
  await db.read();
  db.data = db.data || { games: [] };

  const existingUrls = new Set(db.data.games.map((g) => g.url));
  console.log(`Resuming with ${existingUrls.size} existing games in DB.`);

  let totalScraped = existingUrls.size;
  let consecutiveErrors = 0;

  for (let page = 1; page <= TOTAL_PAGES; page++) {
    // Check if all games on this page might already exist (approximate skip)
    // We can't know exactly without fetching, but skip if we already have 20*(page) games
    // Instead, fetch and check for new games
    process.stdout.write(`[${page}/${TOTAL_PAGES}] Fetching page ${page}... `);

    let html;
    try {
      html = await fetchPage(page);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error(`FAILED: ${err.message}`);
      if (consecutiveErrors >= 5) {
        console.error('5 consecutive errors — stopping. Re-run to resume.');
        break;
      }
      await delay(5000);
      page--; // retry this page
      continue;
    }

    const $ = cheerio.load(html);
    const games = parseGames($);

    if (games.length === 0) {
      console.log(`No games found — possibly last page or bot block.`);
      // Don't break immediately; some pages may be sparse
      await randomDelay();
      continue;
    }

    let newCount = 0;
    for (const game of games) {
      if (!existingUrls.has(game.url)) {
        db.data.games.push(game);
        existingUrls.add(game.url);
        newCount++;
      }
    }

    totalScraped = existingUrls.size;
    console.log(`${games.length} found, ${newCount} new → total ${totalScraped}`);

    await db.write();
    await randomDelay();
  }

  console.log(`\nDone. Total games in DB: ${db.data.games.length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
