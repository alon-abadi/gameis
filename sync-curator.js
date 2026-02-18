const https = require("https");
const fs = require("fs");
const path = require("path");

const CURATOR_ID = "2728897";
const CURATOR_SLUG = "Ping-972";
const PAGE_SIZE = 50;
const REFETCH_MONTHS = 3;
const MAX_RETRIES = 3;

const BASE_DIR = __dirname;
const GAMEDATA_DIR = path.join(BASE_DIR, "gamedata");
const RELEASES_DIR = path.join(BASE_DIR, "releases");
const TRACKING_FILE = path.join(BASE_DIR, "curator-tracking.json");
const AVOID_FILE = path.join(BASE_DIR, "avoid-list.txt");
const EXTRA_IDS_FILE = path.join(BASE_DIR, "extra-curator-ids.txt");

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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---- avoid list ----

function loadAvoidList() {
  if (!fs.existsSync(AVOID_FILE)) return new Set();
  const raw = fs.readFileSync(AVOID_FILE, "utf8");
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// ---- extra IDs (games the AJAX endpoint drops, e.g. non-Latin names) ----

function loadExtraIds() {
  if (!fs.existsSync(EXTRA_IDS_FILE)) return new Set();
  const raw = fs.readFileSync(EXTRA_IDS_FILE, "utf8");
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function saveExtraIds(idSet) {
  const sorted = [...idSet].sort((a, b) => Number(a) - Number(b));
  fs.writeFileSync(EXTRA_IDS_FILE, sorted.join(",") + "\n", "utf8");
}

// ---- tracking ----

function loadTracking() {
  return loadJson(TRACKING_FILE) || { last_sync: null, games: {} };
}

function saveTracking(tracking) {
  tracking.last_sync = new Date().toISOString();
  writeJson(TRACKING_FILE, tracking);
}

// ---- curator fetching ----

async function fetchCuratorPage(start) {
  const url = `https://store.steampowered.com/curator/${CURATOR_ID}-${CURATOR_SLUG}/ajaxgetfilteredrecommendations/render/?start=${start}&count=${PAGE_SIZE}&sort=recent&types=0`;
  const body = await httpsGet(url);
  const json = JSON.parse(body);

  const appIds = [];
  const seen = new Set();
  const regex = /data-ds-appid="(\d+)"/g;
  let match;
  while ((match = regex.exec(json.results_html)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      appIds.push(match[1]);
    }
  }

  return { totalCount: json.total_count, appIds };
}

async function fetchAllCuratorAppIds() {
  let start = 0;
  let totalCount = Infinity;
  const allIds = [];

  while (start < totalCount) {
    const page = await fetchCuratorPage(start);
    totalCount = page.totalCount;
    allIds.push(...page.appIds);
    start += PAGE_SIZE;
  }

  console.log(
    `Found ${allIds.length} games on curator (total_count: ${totalCount})`
  );
  return allIds;
}

async function fetchCuratorPageHtml() {
  const url = `https://store.steampowered.com/curator/${CURATOR_ID}-${CURATOR_SLUG}/`;
  const body = await httpsGet(url);
  const appIds = [];
  const seen = new Set();
  const regex = /data-ds-appid="(\d+)"/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      appIds.push(match[1]);
    }
  }
  return appIds;
}

// ---- determine what to fetch ----

function getGamesToFetch(curatorAppIds, tracking, avoidSet) {
  const now = new Date();
  const toFetch = [];

  for (const appId of curatorAppIds) {
    if (avoidSet.has(appId)) continue;

    const tracked = tracking.games[appId];
    if (!tracked) {
      toFetch.push(appId);
      continue;
    }

    if (tracked.released) continue;

    const lastFetched = new Date(tracked.last_fetched);
    const monthsDiff =
      (now.getFullYear() - lastFetched.getFullYear()) * 12 +
      (now.getMonth() - lastFetched.getMonth());
    if (monthsDiff >= REFETCH_MONTHS) {
      toFetch.push(appId);
    }
  }

  return toFetch;
}

// ---- app details ----

async function fetchAppDetails(appId) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
  const body = await httpsGet(url);
  const json = JSON.parse(body);

  if (!json[appId] || !json[appId].success) {
    console.warn(`  AppDetails failed for ${appId} (delisted?), skipping`);
    return null;
  }

  return json[appId].data;
}

function buildGameObject(appData) {
  const imageUrl = (appData.header_image || "").replace(
    "/header.jpg",
    "/header_292x136.jpg"
  );

  const game = {
    name: appData.name,
    SteamID: appData.steam_appid,
    link: `https://s.team/a/${appData.steam_appid}`,
    demo: Array.isArray(appData.demos) && appData.demos.length > 0,
    ea:
      Array.isArray(appData.genres) &&
      appData.genres.some((g) => g.description === "Early Access"),
    image: imageUrl,
    updated_at: new Date().toISOString(),
  };

  const rd = appData.release_date && appData.release_date.date;
  if (rd && rd.trim()) {
    game.release_date = rd;
  }

  return game;
}

function isReleased(appData) {
  return appData.release_date && appData.release_date.coming_soon === false;
}

// ---- release date parsing ----

const MONTH_ABBR = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};
const MONTH_FULL = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

function parseReleaseDate(dateStr) {
  if (!dateStr || dateStr === "Coming soon" || dateStr === "To be announced") {
    return { year: null, month: null };
  }

  let m;

  // "DD Mon, YYYY" e.g. "21 Aug, 2025"
  m = /^(\d{1,2}) (\w{3}), (\d{4})$/.exec(dateStr);
  if (m && MONTH_ABBR[m[2]]) {
    return { year: parseInt(m[3]), month: MONTH_ABBR[m[2]] };
  }

  // "Mon DD, YYYY" e.g. "Oct 22, 2025"
  m = /^(\w{3}) (\d{1,2}), (\d{4})$/.exec(dateStr);
  if (m && MONTH_ABBR[m[1]]) {
    return { year: parseInt(m[3]), month: MONTH_ABBR[m[1]] };
  }

  // "Month YYYY" e.g. "February 2026"
  m = /^(\w+) (\d{4})$/.exec(dateStr);
  if (m && MONTH_FULL[m[1]]) {
    return { year: parseInt(m[2]), month: MONTH_FULL[m[1]] };
  }

  // "QN YYYY" e.g. "Q2 2026" — year known, month unknown
  m = /^Q[1-4] (\d{4})$/.exec(dateStr);
  if (m) {
    return { year: parseInt(m[1]), month: null };
  }

  // "YYYY" e.g. "2026"
  m = /^(\d{4})$/.exec(dateStr);
  if (m) {
    return { year: parseInt(m[1]), month: null };
  }

  // fallback: extract year if present e.g. "Early 2027"
  m = /(\d{4})/.exec(dateStr);
  if (m) {
    return { year: parseInt(m[1]), month: null };
  }

  return { year: null, month: null };
}

// ---- releases generation ----

function generateReleases(avoidSet) {
  ensureDir(RELEASES_DIR);

  const currentYear = new Date().getFullYear();
  const gameFiles = fs
    .readdirSync(GAMEDATA_DIR)
    .filter((f) => f.endsWith(".json"));

  const byYear = {};
  const upcoming = [];

  for (const file of gameFiles) {
    const game = loadJson(path.join(GAMEDATA_DIR, file));
    if (!game) continue;
    const appId = String(game.SteamID);
    if (avoidSet.has(appId)) continue;

    const parsed = parseReleaseDate(game.release_date);

    if (parsed.year === null) {
      const entry = { SteamID: game.SteamID, name: game.name };
      if (game.release_date) entry.release_date = game.release_date;
      upcoming.push(entry);
      continue;
    }

    // Skip past years that already have a releases file
    if (parsed.year < currentYear) {
      const existingFile = path.join(RELEASES_DIR, `${parsed.year}.json`);
      if (fs.existsSync(existingFile)) continue;
    }

    const yearKey = String(parsed.year);
    if (!byYear[yearKey]) byYear[yearKey] = {};

    const monthKey = parsed.month ? String(parsed.month) : "unknown";
    if (!byYear[yearKey][monthKey]) byYear[yearKey][monthKey] = [];

    const entry = { SteamID: game.SteamID, name: game.name };
    if (game.release_date) entry.release_date = game.release_date;
    byYear[yearKey][monthKey].push(entry);
  }

  // Write year files (only current + future years, or any year without an existing file)
  for (const [yearStr, months] of Object.entries(byYear)) {
    const yearFile = path.join(RELEASES_DIR, `${yearStr}.json`);
    // Build full structure with all 12 months + unknown
    const output = {};
    for (let m = 1; m <= 12; m++) {
      output[String(m)] = months[String(m)] || [];
    }
    output.unknown = months.unknown || [];
    writeJson(yearFile, output);
    console.log(`  Wrote releases/${yearStr}.json`);
  }

  // Write upcoming.json
  upcoming.sort((a, b) => a.name.localeCompare(b.name));
  writeJson(path.join(RELEASES_DIR, "upcoming.json"), upcoming);
  console.log(`  Wrote releases/upcoming.json (${upcoming.length} games)`);
}

// ---- main ----

async function main() {
  console.log("=== Steam Curator Sync ===");
  console.log(`Time: ${new Date().toISOString()}`);

  const avoidSet = loadAvoidList();
  console.log(`Avoid list: ${avoidSet.size} games`);

  const tracking = loadTracking();
  console.log(
    `Tracking: ${Object.keys(tracking.games).length} games, last sync: ${tracking.last_sync || "never"}`
  );

  // Fetch curator game list
  console.log("\n--- Fetching curator game list ---");
  const curatorAppIds = await fetchAllCuratorAppIds();
  const ajaxSet = new Set(curatorAppIds);

  // Scrape main curator page to catch games the AJAX endpoint drops
  // (Steam's pagination silently excludes games with non-Latin names)
  console.log("\n--- Checking curator page for extra games ---");
  const pageAppIds = await fetchCuratorPageHtml();
  const newExtras = pageAppIds.filter((id) => !ajaxSet.has(id));

  // Merge with previously discovered extras
  const extraIds = loadExtraIds();
  for (const id of newExtras) extraIds.add(id);
  if (newExtras.length > 0) {
    console.log(`Discovered ${newExtras.length} new extra game(s) from curator page`);
    saveExtraIds(extraIds);
  }

  // Combine all sources
  const allExtras = [...extraIds].filter((id) => !ajaxSet.has(id));
  const allAppIds = [...curatorAppIds, ...allExtras];
  if (allExtras.length > 0) {
    console.log(`Including ${allExtras.length} extra game(s) from ${path.basename(EXTRA_IDS_FILE)}`);
  }

  // Determine what needs fetching
  console.log("\n--- Determining games to fetch ---");
  const toFetch = getGamesToFetch(allAppIds, tracking, avoidSet);
  console.log(`Games to fetch: ${toFetch.length} of ${allAppIds.length}`);

  // Fetch app details
  if (toFetch.length > 0) {
    console.log("\n--- Fetching app details ---");
    ensureDir(GAMEDATA_DIR);

    let fetched = 0;
    let failed = 0;

    for (const appId of toFetch) {
      console.log(
        `  [${fetched + failed + 1}/${toFetch.length}] Fetching ${appId}...`
      );
      try {
        const appData = await fetchAppDetails(appId);
        if (appData) {
          const game = buildGameObject(appData);
          writeJson(path.join(GAMEDATA_DIR, `${appId}.json`), game);
          tracking.games[appId] = {
            last_fetched: new Date().toISOString(),
            released: isReleased(appData),
          };
          console.log(
            `    ${game.name} (released: ${tracking.games[appId].released})`
          );
          fetched++;
        } else {
          failed++;
        }
      } catch (err) {
        console.error(`    ERROR: ${err.message}`);
        failed++;
      }
    }

    console.log(`\nFetched: ${fetched}, Failed: ${failed}`);
  }

  // Save tracking
  console.log("\n--- Saving tracking ---");
  saveTracking(tracking);
  console.log(
    `Tracking: ${Object.keys(tracking.games).length} games total`
  );

  // Generate releases
  console.log("\n--- Generating releases ---");
  generateReleases(avoidSet);

  console.log("\n=== Sync complete ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
