/**
 * scrape-update.js
 *
 * Scrapes OpenCritic PS5 games sorted by release date (newest first).
 * Stops as soon as it encounters a game with a releaseDate <= CUTOFF_DATE.
 * Saves results to data/games_update1.json
 *
 * Usage:
 *   node scrape-update.js
 *
 * Output file format mirrors data/games.json:
 *   { "games": [ { id, name, url, score, genres, imageUrl, releaseDate, ... } ] }
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const OUTPUT_PATH = path.join(__dirname, 'data', 'games_update1.json');

// Stop scraping once we hit this date (exclusive — games ON this date are NOT included)
const CUTOFF_DATE = new Date('May 29, 2026');

// OpenCritic PS5 browse sorted by release date descending
const BASE_URL = 'https://opencritic.com/browse/ps5/all-time/date';

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
  // 1.5 – 2.5 s between requests to be polite
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
  console.log(`  GET ${url}`);
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

function loadExisting() {
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
      return Array.isArray(raw.games) ? raw.games : [];
    } catch (_) {}
  }
  return [];
}

function saveGames(games) {
  // Ensure data/ directory exists
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ games }, null, 2));
}

async function main() {
  console.log('=== scrape-update.js ===');
  console.log(`Output  : ${OUTPUT_PATH}`);
  console.log(`Cutoff  : games AFTER ${CUTOFF_DATE.toDateString()} (strictly newer)`);
  console.log('');

  // Resume support — reload whatever we already saved
  const existing = loadExisting();
  const existingUrls = new Set(existing.map((g) => g.url));
  const collected = [...existing];
  console.log(`Resuming with ${collected.length} games already in output file.\n`);

  let done = false;
  let page = 1;
  let consecutiveErrors = 0;
  const MAX_PAGES = 500; // safety cap

  while (!done && page <= MAX_PAGES) {
    process.stdout.write(`[page ${page}] Fetching… `);

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
      // retry same page
      continue;
    }

    const $ = cheerio.load(html);
    const games = parseGames($);

    if (games.length === 0) {
      console.log('No games found — possible last page or bot block. Stopping.');
      break;
    }

    let newCount = 0;
    for (const game of games) {
      // Parse the game's release date
      const gameDate = game.releaseDate ? new Date(game.releaseDate) : null;

      // If date is valid and on-or-before cutoff, we're done
      if (gameDate && !isNaN(gameDate) && gameDate <= CUTOFF_DATE) {
        console.log(`\nReached cutoff: "${game.name}" (${game.releaseDate}) is on or before ${CUTOFF_DATE.toDateString()}. Stopping.`);
        done = true;
        break;
      }

      // Skip dupes (resume safety)
      if (existingUrls.has(game.url)) continue;

      collected.push(game);
      existingUrls.add(game.url);
      newCount++;
    }

    const total = collected.length;
    console.log(`${games.length} found, ${newCount} new → total ${total}`);

    // Save after every page so we can resume on crash
    saveGames(collected);

    if (!done) {
      page++;
      await randomDelay();
    }
  }

  // Final save
  saveGames(collected);

  console.log(`\n=== Done ===`);
  console.log(`Total new games collected : ${collected.length}`);
  console.log(`Saved to                  : ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
