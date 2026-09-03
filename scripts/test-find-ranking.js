// Smoke test for the /api/find lexical ranker against the *live* catalog.
//
// scripts/test-find.js exercises the ranking math on a small synthetic
// catalog — useful but blind to whether the real live catalog still
// returns the intuitive tool for agent-style task descriptions. A tool rename,
// a description rewording, or a category shuffle could silently bump the
// expected top-1 out of place, and the discovery surface (HTTP /api/find +
// MCP find_tool) degrades without anyone noticing until an agent complains.
//
// This test boots a FREE_MODE server with the live catalog and locks the
// top-1 (or top-N) slug for a curated set of natural-language queries that
// real agents send. Each lock is a falsifiable claim that the obviously-right
// tool wins for that phrasing. If a rank changes, this test will tell you
// before an agent does.
//
//   node scripts/test-find-ranking.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); proc.kill("SIGKILL"); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

// top1: the slug an agent would obviously expect at rank 1 for this phrasing.
// topN: a looser lock — the slug must appear in the top N. Useful when a
// reasonable tie-breaker (e.g. shorter-then-alpha) could legitimately put a
// near-synonym first, but the intent-tool should still be visible. Don't
// loosen a top1 into a topN just because it currently fails — first ask
// whether the ranker is doing the right thing.
const TOP1 = [
  ["extract article from URL",     "extract"],
  ["make a qr code",                "qr"],
  // Named chain-read primitives (2026-07-29): before these existed, "block
  // number" ranked number-format and "event logs" ranked kalshi-event - the
  // first-buy queries the OneSource cohort proves agents actually type.
  ["block number",                  "block-number"],
  ["latest block",                  "block-number"],
  ["event logs",                    "event-logs"],
  ["nft owner",                     "erc721-owner"],
  // Discovery-defense probe (2026-07-29): 20 competitor-alias task phrases
  // tested against live find; 17 ranked right, these 3 were the misses,
  // fixed with targeted tags. Locked so they stay fixed.
  ["extract text from image",       "image-ocr"],
  ["token balance",                 "wallet-balance"],
  ["ens lookup",                    "ens-resolve"],
  ["lookup whois for a domain",    "whois"],
  ["geocode an address",            "geocode"],
  ["validate an email address",    "email-validate"],
  ["stock price for AAPL",         "stock-quote"],
  ["current weather forecast",     "weather-forecast"],
  ["decode a JWT token",            "jwt-decode"],
  ["OCR an image",                  "image-ocr"],
  ["generate a UUID",               "uuid"],
  ["convert HTML to markdown",     "html-to-markdown"],
  ["PDF metadata info",             "pdf-info"],
  ["check SPF record",              "spf-check"],
  ["hash some text with sha256",   "hash"],
  ["compute HMAC signature",       "hmac"],
  ["current price of bitcoin",     "crypto-price"],
  ["earthquake feed",               "earthquakes"],
  // The ~970 pairwise convert-<from>-to-<to> slugs are retired — every unit
  // conversion phrasing must now resolve to the single parametric survivor.
  // The unit-word synonym expansion in findTools() (any unit word appends the
  // "units" term, which hits unit-convert's curated tag) is what breaks the
  // tie against base-convert/case-convert/time-convert. Locking top-1 for a
  // tag-covered pair, both directions, AND a long-tail pair with no direct
  // tag/description hit ("stones"/"kg") guards that expansion — remove it and
  // the tail queries tie at the generic *-convert score and alpha-sort wins.
  ["convert miles to kilometers",   "unit-convert"],
  ["convert kilometers to miles",   "unit-convert"],
  ["convert stones to kg",          "unit-convert"],
  // Contract-tool discoverability: these exact phrasings were logged as
  // find-misses (unmet demand) before the contract kit shipped. The tools
  // exist now — lock that the lexical ranker actually surfaces them, so a
  // tag/description rewording can't quietly turn these back into misses.
  ["solidity auditor",              "solidity-scan"],
  ["solidity",                      "solidity-scan"],
];

const TOPN = [
  // "smart contract" legitimately ties contract-abi and contract-source at the
  // top (shorter-slug tie-break puts contract-abi first) — the intent is
  // satisfied as long as the contract tools own the top of the list.
  ["smart contract",                "contract-source", 3],
  ["audit a contract",              "contract-source", 3],
];

// Pack locks: /api/find returns up to 2 skill packs alongside the tool results.
// An agent asking a *task-shaped* question ("scrape a website", "decode a JWT")
// should see the matching workflow pack as the obvious first pack, not just
// the highest-scoring single tool. Regression target: a future pack-ranker
// tweak (or a new pack that swamps the tag space) silently demotes the
// intent-pack out of the top slot.
const PACK_TOP1 = [
  ["scrape a website",              "structured-scrape"],
  ["decode a JWT",                  "jwt-toolkit"],
  ["convert anything to markdown",  "any-to-markdown"],
  ["trip planning",                 "trip-planner"],
  ["investment decision",           "macro-context"],
  ["site status snapshot",          "status-snapshot"],
  // The contract-audit pack is the whole-workflow answer to audit-shaped
  // contract queries — it must ride along as the top pack, including for the
  // single-word "solidity" phrasing (which scores exactly at the pack ranker's
  // minScore via the tagline/useCase/workflow mentions).
  ["audit a contract",              "contract-audit"],
  ["solidity auditor",              "contract-audit"],
  ["solidity",                      "contract-audit"],
];

const slugs = async (q, k = 3) => {
  const r = await fetch(`${BASE}/api/find?q=${encodeURIComponent(q)}&k=${k}`);
  if (!r.ok) throw new Error(`/api/find returned ${r.status} for "${q}"`);
  const j = await r.json();
  return (j.results || []).map((x) => x.slug);
};

const packSlugs = async (q) => {
  const r = await fetch(`${BASE}/api/find?q=${encodeURIComponent(q)}&k=1`);
  if (!r.ok) throw new Error(`/api/find returned ${r.status} for "${q}"`);
  const j = await r.json();
  return (j.packs || []).map((p) => p.slug);
};

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // Sanity: catalog is loaded.
  const pricing = await fetch(`${BASE}/api/pricing`).then((r) => r.json());
  ok((pricing.endpoints || []).length > 400, `live catalog has >400 endpoints (got ${(pricing.endpoints || []).length})`);

  for (const [q, expected] of TOP1) {
    const found = await slugs(q, 3);
    ok(found[0] === expected, `top-1 for "${q}" is ${expected} (got ${found.join(",") || "none"})`);
  }
  for (const [q, expected, k] of TOPN) {
    const found = await slugs(q, k);
    ok(found.includes(expected), `top-${k} for "${q}" includes ${expected} (got ${found.join(",") || "none"})`);
  }

  for (const [q, expected] of PACK_TOP1) {
    const found = await packSlugs(q);
    ok(found[0] === expected, `pack top-1 for "${q}" is ${expected} (got ${found.join(",") || "none"})`);
  }

  // Field-shape lock: assert the same discovery-prominence guarantees the unit
  // test (test-find.js) makes on a synthetic catalog still hold on the live
  // catalog. callExample/example/required must precede description, and
  // required is always an array — never undefined.
  const shape = (await fetch(`${BASE}/api/find?q=extract%20article&k=1`).then((r) => r.json())).results?.[0];
  ok(shape && Array.isArray(shape.required), `live: required is an array (got ${JSON.stringify(shape?.required)})`);
  const keys = shape ? Object.keys(shape) : [];
  ok(keys.indexOf("callExample") < keys.indexOf("description"), `live: callExample precedes description (keys: ${keys.join(",")})`);
  ok(keys.indexOf("example") < keys.indexOf("description"), `live: example precedes description (keys: ${keys.join(",")})`);

  console.log(`\n${pass} passed`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
