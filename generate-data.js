// generate-data.js
const fs = require("fs");
const path = require("path");
const {
  NEW_PAST_MONTHS,
  UPCOMING_FUTURE_MONTHS,
} = require("./settings");

const BASE_DIR = __dirname;
const GAMEDATA_DIR = path.join(BASE_DIR, "gamedata");
const RELEASES_DIR = path.join(BASE_DIR, "releases");
const OUTPUT_DIR = path.join(BASE_DIR, "data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "data.js");
const AVOID_FILE = path.join(BASE_DIR, "avoid-list.txt");

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

// month diff relative to "now", working in UTC for consistency
const now = new Date();
const nowYear = now.getUTCFullYear();
const nowMonth = now.getUTCMonth() + 1; // 1–12

function monthDiff(year, month) {
  return (year - nowYear) * 12 + (month - nowMonth);
}

function loadGamedataMap() {
  const map = new Map();
  const files = fs.readdirSync(GAMEDATA_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(GAMEDATA_DIR, file), "utf8");
      const game = JSON.parse(raw);
      map.set(String(game.SteamID), game);
    } catch (err) {
      console.error(`Failed to read/parse gamedata/${file}:`, err.message);
    }
  }
  return map;
}

function loadReleasesSchedule() {
  const schedule = [];
  const files = fs.readdirSync(RELEASES_DIR).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    let data;
    try {
      const raw = fs.readFileSync(path.join(RELEASES_DIR, file), "utf8");
      data = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to read/parse releases/${file}:`, err.message);
      continue;
    }

    if (file === "upcoming.json") {
      for (const entry of data) {
        schedule.push({ steamId: String(entry.SteamID), year: null, month: null });
      }
      continue;
    }

    const yearMatch = /^(\d{4})\.json$/.exec(file);
    if (!yearMatch) {
      console.warn(`Unexpected file in releases/: ${file}, skipping`);
      continue;
    }
    const year = parseInt(yearMatch[1], 10);

    for (const [monthKey, entries] of Object.entries(data)) {
      const month = monthKey === "unknown" ? null : parseInt(monthKey, 10);
      for (const entry of entries) {
        schedule.push({ steamId: String(entry.SteamID), year, month });
      }
    }
  }

  return schedule;
}

// ---- main ----

function main() {
  const avoidIds = loadAvoidList();
  const gamedataMap = loadGamedataMap();
  const schedule = loadReleasesSchedule();

  const newGames = [];
  const upcomingGames = [];
  const otherGames = [];

  const byYear = {};
  const byYearIds = {};
  const classifiedIds = new Set();

  for (const { steamId, year, month } of schedule) {
    if (avoidIds.has(steamId)) continue;

    const game = gamedataMap.get(steamId);
    if (!game) {
      console.warn(`SteamID ${steamId} in releases but not in gamedata, skipping`);
      continue;
    }

    const gid = String(game.SteamID);

    // Add to byYear (nested by month)
    const yearKey = year != null ? String(year) : "other";
    const monthKey = month != null ? String(month) : "unknown";
    if (!byYear[yearKey]) {
      byYear[yearKey] = {};
      byYearIds[yearKey] = new Set();
    }
    if (!byYearIds[yearKey].has(gid)) {
      byYearIds[yearKey].add(gid);
      if (!byYear[yearKey][monthKey]) {
        byYear[yearKey][monthKey] = [];
      }
      byYear[yearKey][monthKey].push(game);
    }

    // Classify into new/upcoming/other (deduplicated)
    if (classifiedIds.has(gid)) continue;
    classifiedIds.add(gid);

    if (year == null) {
      otherGames.push(game);
      continue;
    }

    // If month unknown, assume June for rough placement
    const effectiveMonth = month || 6;
    const diff = monthDiff(year, effectiveMonth);
    const minNewDiff = -(NEW_PAST_MONTHS - 1);

    if (diff <= 0 && diff >= minNewDiff) {
      newGames.push(game);
    } else if (diff >= 1 && diff <= UPCOMING_FUTURE_MONTHS) {
      upcomingGames.push(game);
    } else {
      otherGames.push(game);
    }
  }

  // Sort year keys for nicer output
  const sortedYears = Object.keys(byYear)
    .filter((k) => k !== "other")
    .sort((a, b) => Number(a) - Number(b));

  const byYearSorted = {};
  for (const y of sortedYears) {
    const monthObj = byYear[y];
    const sortedMonths = Object.keys(monthObj)
      .filter((k) => k !== "unknown")
      .sort((a, b) => Number(a) - Number(b));
    const monthSorted = {};
    for (const m of sortedMonths) {
      monthSorted[m] = monthObj[m];
    }
    if (monthObj.unknown) {
      monthSorted.unknown = monthObj.unknown;
    }
    byYearSorted[y] = monthSorted;
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
  console.log(`  newGames: ${newGames.length}`);
  console.log(`  upcomingGames: ${upcomingGames.length}`);
  console.log(`  otherGames: ${otherGames.length}`);
  console.log(`  byYear keys: ${Object.keys(byYearSorted).join(", ")}`);
}

main();
