// populate-context.js
// One-shot script to fetch developer/studio info from Steam API for all games,
// fetch demo release dates, and generate a complete context.md.

const https = require("https");
const fs = require("fs");
const path = require("path");

const BASE_DIR = __dirname;
const GAMEDATA_DIR = path.join(BASE_DIR, "gamedata");
const CONTEXT_FILE = path.join(BASE_DIR, "context.md");
const CACHE_FILE = path.join(BASE_DIR, "steam-details-cache.json");

const MAX_RETRIES = 3;
const DELAY_MS = 1500;

// ---- utilities ----

function httpsGet(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return resolve(httpsGet(res.headers.location, retries));
        }
        if (res.statusCode === 429 && retries > 0) {
          const delay = 2000 * Math.pow(2, MAX_RETRIES - retries);
          console.warn(`  Rate limited, retrying in ${delay}ms...`);
          return setTimeout(
            () => resolve(httpsGet(url, retries - 1)),
            delay
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ---- load local gamedata ----

function loadAllGames() {
  const games = [];
  const files = fs.readdirSync(GAMEDATA_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(GAMEDATA_DIR, file), "utf8");
      games.push(JSON.parse(raw));
    } catch (err) {
      console.error(`Failed to read ${file}:`, err.message);
    }
  }
  games.sort((a, b) => a.SteamID - b.SteamID);
  return games;
}

// ---- parse existing context.md ----

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function parseExistingContext() {
  if (!fs.existsSync(CONTEXT_FILE)) return new Map();
  const raw = stripHtmlComments(fs.readFileSync(CONTEXT_FILE, "utf8"));
  const entries = new Map();
  let currentId = null;
  let currentTags = [];
  let currentNotes = [];

  function flush() {
    if (currentId) {
      entries.set(currentId, {
        tags: currentTags,
        notes: currentNotes.join("\n").trim(),
      });
    }
  }

  for (const line of raw.split("\n")) {
    const headerMatch = /^#\s+(\d+)/.exec(line);
    if (headerMatch) {
      flush();
      currentId = headerMatch[1];
      currentTags = [];
      currentNotes = [];
      continue;
    }
    if (!currentId) continue;
    const tagsMatch = /^tags:\s*(.+)$/i.exec(line);
    if (tagsMatch && currentTags.length === 0 && currentNotes.length === 0) {
      currentTags = tagsMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      continue;
    }
    // Skip studio: and demo_date: lines from previous runs
    if (/^studio:\s/i.test(line)) continue;
    if (/^demo_date:\s/i.test(line)) continue;
    if (line.trim()) {
      currentNotes.push(line.trim());
    }
  }
  flush();
  return entries;
}

// ---- Steam API ----

async function fetchAppDetails(appId) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
  const body = await httpsGet(url);
  const json = JSON.parse(body);

  if (!json[appId] || !json[appId].success) {
    return null;
  }

  return json[appId].data;
}

// ---- main ----

async function main() {
  const games = loadAllGames();
  console.log(`Loaded ${games.length} games from gamedata/`);

  // Load or init cache
  const cache = loadJson(CACHE_FILE) || { games: {}, demos: {} };

  // Phase 1: Fetch developer info for all games
  const toFetchGames = games.filter((g) => !cache.games[String(g.SteamID)]);
  console.log(
    `\nPhase 1: Fetching developer info (${toFetchGames.length} remaining of ${games.length})`
  );

  for (let i = 0; i < toFetchGames.length; i++) {
    const game = toFetchGames[i];
    const id = String(game.SteamID);
    console.log(
      `  [${i + 1}/${toFetchGames.length}] Fetching ${id} (${game.name})...`
    );

    try {
      const data = await fetchAppDetails(id);
      if (data) {
        cache.games[id] = {
          developers: data.developers || [],
          publishers: data.publishers || [],
          demos: Array.isArray(data.demos)
            ? data.demos.map((d) => ({ appid: d.appid }))
            : [],
        };
      } else {
        cache.games[id] = { developers: [], publishers: [], demos: [], error: "unavailable" };
      }
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      cache.games[id] = { developers: [], publishers: [], demos: [], error: err.message };
    }

    // Save cache periodically
    if ((i + 1) % 10 === 0 || i === toFetchGames.length - 1) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", "utf8");
    }

    await sleep(DELAY_MS);
  }

  // Phase 2: Fetch demo release dates
  const demoGames = games.filter((g) => g.demo);
  const toFetchDemos = [];
  for (const game of demoGames) {
    const id = String(game.SteamID);
    const cached = cache.games[id];
    if (cached && cached.demos && cached.demos.length > 0) {
      const demoAppId = String(cached.demos[0].appid);
      if (!cache.demos[demoAppId]) {
        toFetchDemos.push({ gameId: id, gameName: game.name, demoAppId });
      }
    }
  }

  console.log(
    `\nPhase 2: Fetching demo release dates (${toFetchDemos.length} remaining)`
  );

  for (let i = 0; i < toFetchDemos.length; i++) {
    const { gameId, gameName, demoAppId } = toFetchDemos[i];
    console.log(
      `  [${i + 1}/${toFetchDemos.length}] Fetching demo ${demoAppId} for ${gameName}...`
    );

    try {
      const data = await fetchAppDetails(demoAppId);
      if (data && data.release_date) {
        cache.demos[demoAppId] = {
          release_date: data.release_date.date || null,
          coming_soon: data.release_date.coming_soon,
        };
      } else {
        cache.demos[demoAppId] = { release_date: null, error: "unavailable" };
      }
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      cache.demos[demoAppId] = { release_date: null, error: err.message };
    }

    if ((i + 1) % 10 === 0 || i === toFetchDemos.length - 1) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", "utf8");
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", "utf8");
  console.log(`\nCache saved to ${CACHE_FILE}`);

  // Phase 3: Generate context.md
  const existing = parseExistingContext();
  console.log(`\nPhase 3: Generating context.md (preserving ${existing.size} existing entries)`);

  const lines = [];

  // Header comment
  lines.push("<!-- Game Context File");
  lines.push("     Format: Each game is a section headed by its SteamID and name.");
  lines.push('     Metadata lines: "studio:", "demo_date:", "tags:" (all optional).');
  lines.push("     Remaining lines are freeform notes used to generate AI descriptions.");
  lines.push("");
  lines.push("# 1234567 Game Name");
  lines.push("studio: Developer Studio");
  lines.push("tags: genre, theme");
  lines.push("Any context about this game that helps generate a good description.");
  lines.push("-->");

  for (const game of games) {
    const id = String(game.SteamID);
    const cached = cache.games[id] || {};
    const existingEntry = existing.get(id);

    lines.push("");
    lines.push(`# ${id} ${game.name}`);

    // Studio line
    const developers = cached.developers || [];
    if (developers.length > 0) {
      lines.push(`studio: ${developers.join(", ")}`);
    } else {
      lines.push("studio: Unknown");
    }

    // Demo date line
    if (game.demo && cached.demos && cached.demos.length > 0) {
      const demoAppId = String(cached.demos[0].appid);
      const demoInfo = cache.demos[demoAppId];
      if (demoInfo && demoInfo.release_date) {
        lines.push(`demo_date: ${demoInfo.release_date}`);
      }
    }

    // Existing tags
    if (existingEntry && existingEntry.tags.length > 0) {
      lines.push(`tags: ${existingEntry.tags.join(", ")}`);
    }

    // Existing notes
    if (existingEntry && existingEntry.notes) {
      lines.push(existingEntry.notes);
    }
  }

  lines.push("");

  const content = lines.join("\n");
  fs.writeFileSync(CONTEXT_FILE, content, "utf8");
  console.log(`Wrote ${CONTEXT_FILE} with ${games.length} game entries`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
