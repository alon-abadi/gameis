// generate-context.js
// Parses context.md and groups.md, generates AI descriptions via Anthropic API,
// and writes data/context-data.js. Fully separate from the Steam sync pipeline.

const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE_DIR = __dirname;
const GAMEDATA_DIR = path.join(BASE_DIR, "gamedata");
const OUTPUT_DIR = path.join(BASE_DIR, "data");
const CONTEXT_FILE = path.join(BASE_DIR, "context.md");
const GROUPS_FILE = path.join(BASE_DIR, "groups.md");
const CACHE_FILE = path.join(BASE_DIR, "context-generated.json");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "context-data.js");

const API_MODEL = "claude-sonnet-4-20250514";
const API_MAX_TOKENS = 300;
const DELAY_BETWEEN_CALLS_MS = 1000;

// ---- utilities ----

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadGamedataMap() {
  const map = new Map();
  if (!fs.existsSync(GAMEDATA_DIR)) return map;
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

// ---- markdown parsers ----

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function parseContextMd() {
  if (!fs.existsSync(CONTEXT_FILE)) return new Map();
  const raw = stripHtmlComments(fs.readFileSync(CONTEXT_FILE, "utf8"));
  const entries = new Map();
  let currentId = null;
  let currentTags = [];
  let currentStudio = null;
  let currentDemoDate = null;
  let currentNotes = [];

  function flush() {
    if (currentId) {
      entries.set(currentId, {
        tags: currentTags,
        studio: currentStudio,
        demoDate: currentDemoDate,
        notes: currentNotes.join("\n").trim(),
      });
    }
  }

  for (const line of raw.split("\n")) {
    const headerMatch = /^#\s+(\d+)(?:\s+.*)?$/.exec(line);
    if (headerMatch) {
      flush();
      currentId = headerMatch[1];
      currentTags = [];
      currentStudio = null;
      currentDemoDate = null;
      currentNotes = [];
      continue;
    }
    if (!currentId) continue;
    const studioMatch = /^studio:\s*(.+)$/i.exec(line);
    if (studioMatch && !currentStudio) {
      currentStudio = studioMatch[1].trim();
      continue;
    }
    const demoDateMatch = /^demo_date:\s*(.+)$/i.exec(line);
    if (demoDateMatch && !currentDemoDate) {
      currentDemoDate = demoDateMatch[1].trim();
      continue;
    }
    const tagsMatch = /^tags:\s*(.+)$/i.exec(line);
    if (tagsMatch && currentTags.length === 0 && currentNotes.length === 0) {
      currentTags = tagsMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      continue;
    }
    if (line.trim()) {
      currentNotes.push(line.trim());
    }
  }
  flush();
  return entries;
}

function parseGroupsMd() {
  if (!fs.existsSync(GROUPS_FILE)) return [];
  const raw = stripHtmlComments(fs.readFileSync(GROUPS_FILE, "utf8"));
  const groups = [];
  let current = null;

  function flush() {
    if (current) {
      current.notes = current.notes.join("\n").trim();
      groups.push(current);
    }
  }

  for (const line of raw.split("\n")) {
    const headerMatch = /^#\s+(\S+)\s*$/.exec(line);
    if (headerMatch) {
      flush();
      current = {
        slug: headerMatch[1],
        name: "",
        url: null,
        games: [],
        notes: [],
      };
      continue;
    }
    if (!current) continue;
    const nameMatch = /^name:\s*(.+)$/i.exec(line);
    if (nameMatch && !current.name) {
      current.name = nameMatch[1].trim();
      continue;
    }
    const urlMatch = /^url:\s*(.+)$/i.exec(line);
    if (urlMatch && !current.url) {
      current.url = urlMatch[1].trim();
      continue;
    }
    const gamesMatch = /^games:\s*(.+)$/i.exec(line);
    if (gamesMatch && current.games.length === 0) {
      current.games = gamesMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (line.trim()) {
      current.notes.push(line.trim());
    }
  }
  flush();
  return groups;
}

// ---- AI API ----

function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const body = JSON.stringify({
    model: API_MODEL,
    max_tokens: API_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Anthropic API ${res.statusCode}: ${data}`));
          }
          try {
            const json = JSON.parse(data);
            resolve(json.content[0].text);
          } catch (err) {
            reject(new Error(`Failed to parse API response: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildGamePrompt(steamData, context) {
  const parts = [
    "You are writing a brief, engaging description (2-3 sentences, max 80 words) for a catalog of Israeli indie games on Steam.",
    "",
    `Game name: ${steamData ? steamData.name : "Unknown"}`,
  ];
  if (steamData) {
    parts.push(`Release date: ${steamData.release_date || "Unknown"}`);
    if (steamData.ea) parts.push("Status: Early Access");
    if (steamData.demo) parts.push("Has a playable demo");
  }
  if (context.studio) {
    parts.push(`Developer: ${context.studio}`);
  }
  if (context.tags.length > 0) {
    parts.push(`Tags: ${context.tags.join(", ")}`);
  }
  parts.push(`Context from curator: ${context.notes}`);
  parts.push("");
  parts.push(
    "Write a short paragraph that highlights what makes this game interesting. Do not repeat the game name at the start. Write in third person. Be factual and enthusiastic without being hyperbolic."
  );
  return parts.join("\n");
}

function buildGroupPrompt(group, gameNames) {
  const parts = [
    "You are writing a brief description (2-3 sentences, max 80 words) for a curated collection of Israeli indie games on Steam.",
    "",
    `Collection name: ${group.name}`,
    `Games in this collection: ${gameNames.join(", ")}`,
    `Context from curator: ${group.notes}`,
    "",
    "Write a short paragraph that describes what ties these games together and why this collection is interesting. Write in third person. Be factual and enthusiastic without being hyperbolic.",
  ];
  return parts.join("\n");
}

// ---- hashing ----

function computeGameHash(context, steamData) {
  const input = JSON.stringify({
    notes: context.notes,
    tags: context.tags.slice().sort(),
    studio: context.studio || "",
    demoDate: context.demoDate || "",
    gameName: steamData ? steamData.name : "",
    releaseDate: steamData ? steamData.release_date : "",
    ea: steamData ? steamData.ea : false,
    demo: steamData ? steamData.demo : false,
  });
  return sha256(input);
}

function computeGroupHash(group, gameNames) {
  const input = JSON.stringify({
    name: group.name,
    notes: group.notes,
    games: group.games.slice().sort(),
    gameNames: gameNames,
  });
  return sha256(input);
}

// ---- main ----

async function main() {
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasApiKey) {
    console.warn(
      "WARNING: ANTHROPIC_API_KEY not set. Skipping AI generation, using cached descriptions only."
    );
  }

  // Parse inputs
  const contextEntries = parseContextMd();
  const groupEntries = parseGroupsMd();
  console.log(
    `Parsed context.md: ${contextEntries.size} games, groups.md: ${groupEntries.length} groups`
  );

  // Load cache
  const cache = loadJson(CACHE_FILE) || { games: {}, groups: {} };

  // Load gamedata for enrichment
  const gamedataMap = loadGamedataMap();

  let apiCalls = 0;
  let cacheHits = 0;
  let errors = 0;

  // Process game contexts
  for (const [steamId, context] of contextEntries) {
    const steamData = gamedataMap.get(steamId) || null;
    const hash = computeGameHash(context, steamData);

    if (cache.games[steamId] && cache.games[steamId].hash === hash) {
      cacheHits++;
      continue;
    }

    if (!hasApiKey) {
      // No API key, clear stale cache entry if hash changed
      if (cache.games[steamId]) {
        cache.games[steamId] = { aiDescription: null, hash: null };
      }
      continue;
    }

    try {
      console.log(
        `  Generating description for game ${steamId} (${steamData ? steamData.name : "unknown"})...`
      );
      const prompt = buildGamePrompt(steamData, context);
      const description = await callClaude(prompt);
      cache.games[steamId] = { aiDescription: description.trim(), hash };
      apiCalls++;
      await sleep(DELAY_BETWEEN_CALLS_MS);
    } catch (err) {
      console.error(`  ERROR generating for game ${steamId}:`, err.message);
      errors++;
    }
  }

  // Remove cache entries for games no longer in context.md
  for (const steamId of Object.keys(cache.games)) {
    if (!contextEntries.has(steamId)) {
      delete cache.games[steamId];
    }
  }

  // Process groups
  for (const group of groupEntries) {
    const gameNames = group.games.map((id) => {
      const steam = gamedataMap.get(id);
      return steam ? steam.name : `SteamID ${id}`;
    });
    const hash = computeGroupHash(group, gameNames);

    if (cache.groups[group.slug] && cache.groups[group.slug].hash === hash) {
      cacheHits++;
      continue;
    }

    if (!hasApiKey) {
      if (cache.groups[group.slug]) {
        cache.groups[group.slug] = { aiDescription: null, hash: null };
      }
      continue;
    }

    try {
      console.log(`  Generating description for group "${group.name}"...`);
      const prompt = buildGroupPrompt(group, gameNames);
      const description = await callClaude(prompt);
      cache.groups[group.slug] = { aiDescription: description.trim(), hash };
      apiCalls++;
      await sleep(DELAY_BETWEEN_CALLS_MS);
    } catch (err) {
      console.error(
        `  ERROR generating for group "${group.slug}":`,
        err.message
      );
      errors++;
    }
  }

  // Remove cache entries for groups no longer in groups.md
  for (const slug of Object.keys(cache.groups)) {
    if (!groupEntries.find((g) => g.slug === slug)) {
      delete cache.groups[slug];
    }
  }

  // Write cache
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", "utf8");
  console.log(`Wrote ${CACHE_FILE}`);

  // Build output
  const gamesOutput = {};
  for (const [steamId, context] of contextEntries) {
    const entry = {};
    if (context.tags.length > 0) entry.tags = context.tags;
    const cached = cache.games[steamId];
    if (cached && cached.aiDescription) {
      entry.description = cached.aiDescription;
    }
    if (Object.keys(entry).length > 0) {
      gamesOutput[steamId] = entry;
    }
  }

  const groupsOutput = groupEntries.map((group) => {
    const out = {
      slug: group.slug,
      name: group.name,
      games: group.games,
    };
    if (group.url) {
      out.url = group.url;
    }
    const cached = cache.groups[group.slug];
    if (cached && cached.aiDescription) {
      out.description = cached.aiDescription;
    }
    return out;
  });

  const output = {
    generatedAt: new Date().toISOString(),
    games: gamesOutput,
    groups: groupsOutput,
  };

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const jsContent =
    "// Auto-generated by generate-context.js. Do not edit by hand.\n" +
    "window.GAME_CONTEXT_DATA = " +
    JSON.stringify(output, null, 2) +
    ";\n";

  fs.writeFileSync(OUTPUT_FILE, jsContent, "utf8");
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(
    `  API calls: ${apiCalls}, cache hits: ${cacheHits}, errors: ${errors}`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
