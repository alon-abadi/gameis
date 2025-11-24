// generate-data.js
const fs = require("fs");
const path = require("path");
const {
  NEW_PAST_MONTHS,
  UPCOMING_FUTURE_MONTHS,
  ID_FIELD,
} = require("./settings");

const DATA_DIR = __dirname;
const OUTPUT_DIR = path.join(DATA_DIR, "data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "data.js");
const AVOID_FILE = path.join(DATA_DIR, "avoid-list.txt");

// make sure /data exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

// ---- helpers ----

function loadAvoidList() {
  if (!fs.existsSync(AVOID_FILE)) {
    return new Set();
  }
  const raw = fs.readFileSync(AVOID_FILE, "utf8");
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(ids);
}

function getYearMonthFromFilename(filename) {
  // matches data-YYYY.json or data-YYYY-MM.json
  const m = /^data-(\d{4})(?:-(\d{2}))?\.json$/.exec(filename);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = m[2] ? parseInt(m[2], 10) : null; // null for year-only
  return { year, month };
}

function getGameId(game) {
  if (!game) return null;
  if (ID_FIELD && game[ID_FIELD] != null) return String(game[ID_FIELD]);
  if (game.id != null) return String(game.id);
  if (game.SteamID != null) return String(game.SteamID);
  return null;
}

// month diff relative to "now", working in UTC for consistency
const now = new Date();
const nowYear = now.getUTCFullYear();
const nowMonth = now.getUTCMonth() + 1; // 1–12

function monthDiff(year, month) {
  return (year - nowYear) * 12 + (month - nowMonth);
}

// Add game to byYear[yearKey] with deduplication
const byYear = {};
const byYearIds = {};

function addToYear(yearKey, game, idOverride = null) {
  if (!byYear[yearKey]) {
    byYear[yearKey] = [];
    byYearIds[yearKey] = new Set();
  }
  const gid = idOverride || getGameId(game) || JSON.stringify(game);
  if (!byYearIds[yearKey].has(gid)) {
    byYearIds[yearKey].add(gid);
    byYear[yearKey].push(game);
  }
}

// ---- main ----

function main() {
  const avoidIds = loadAvoidList();

  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("data-") && f.endsWith(".json"));

  const newGames = [];
  const upcomingGames = [];
  const otherGames = [];

  // prevent duplicates across the three main arrays
  const classifiedIds = new Set();

  function classifyGame(game, yearMonthInfo, sourceFile) {
    const gid = getGameId(game);
    // Skip avoided
    if (gid && avoidIds.has(gid)) return;

    // Always add to yearly map if we know year, or to "other" if not
    if (sourceFile === "data-other.json") {
      addToYear("other", game, gid);
      // and classification: they go to otherGames (no date)
      if (gid && classifiedIds.has(gid)) return;
      otherGames.push(game);
      if (gid) classifiedIds.add(gid);
      return;
    }

    if (yearMonthInfo) {
      const { year, month } = yearMonthInfo;
      const yearKey = String(year);

      addToYear(yearKey, game, gid);

      // if already classified from another file, skip re-classifying
      if (gid && classifiedIds.has(gid)) return;

      // If month missing (data-YYYY.json), assume June for rough placement
      const effectiveMonth = month || 6;
      const diff = monthDiff(year, effectiveMonth);

      // New: from the past N months including current month
      // e.g. N=3 → diff in [-2, 0]
      const minNewDiff = -(NEW_PAST_MONTHS - 1);

      if (diff <= 0 && diff >= minNewDiff) {
        newGames.push(game);
      } else if (diff >= 1 && diff <= UPCOMING_FUTURE_MONTHS) {
        upcomingGames.push(game);
      } else {
        otherGames.push(game);
      }

      if (gid) classifiedIds.add(gid);
    } else {
      // No year info and not data-other → just dump to otherGames
      if (gid && classifiedIds.has(gid)) return;
      otherGames.push(game);
      if (gid) classifiedIds.add(gid);
    }
  }

  for (const file of files) {
    const fullPath = path.join(DATA_DIR, file);

    let data;
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      data = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to read/parse ${file}:`, err.message);
      continue;
    }

    if (!Array.isArray(data)) {
      console.error(`File ${file} does not contain a JSON array, skipping`);
      continue;
    }

    if (file === "data-other.json") {
      for (const game of data) {
        classifyGame(game, null, "data-other.json");
      }
      continue;
    }

    const ym = getYearMonthFromFilename(file);
    if (!ym) {
      console.warn(`File ${file} didn't match data-YYYY[-MM].json pattern, skipping`);
      continue;
    }

    for (const game of data) {
      classifyGame(game, ym, file);
    }
  }

  // Sort year keys for nicer output
  const sortedYears = Object.keys(byYear)
    .filter((k) => k !== "other")
    .sort((a, b) => Number(a) - Number(b));

  const byYearSorted = {};
  for (const y of sortedYears) {
    byYearSorted[y] = byYear[y];
  }
  if (byYear.other) {
    byYearSorted.other = byYear.other;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    settings: {
      NEW_PAST_MONTHS,
      UPCOMING_FUTURE_MONTHS,
    },
    newGames,
    upcomingGames,
    otherGames,
    byYear: byYearSorted,
  };

  const jsContent =
    "// Auto-generated by generate-data.js. Do not edit by hand.\n" +
    "window.ISRAELI_GAMES_DATA = " +
    JSON.stringify(output, null, 2) +
    ";\n";

  fs.writeFileSync(OUTPUT_FILE, jsContent, "utf8");
  console.log(`Wrote ${OUTPUT_FILE}`);
}

main();
