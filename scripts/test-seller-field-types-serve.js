// A stored seller index whose listings carry a number, an object or an array
// where text belongs is served whole. A free-mode boot warm-starts from an
// index file holding such sellers beside a well-formed one; every page and API
// that reads sellers answers without a server error, the server is still up
// after all of them, and the stored entries hold text (each entry is cleaned
// as the index cache stores it, so no reader meets the raw value). The router
// worker is on, so its replica of the cache is read too.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The unit: what the cache keeps for a listing with non-text fields.
const { _cleanSellerEntryForTests: clean } = await import("../src/x402-index.js");
const raw = { manifest: { name: { en: "Odd" }, homepage: 7 }, tools: [{ route: 12, name: ["ocr"], slug: 3, description: { t: 1 }, category: true, tags: "ocr", aliases: [{ a: 1 }, "alt", 5], networks: "eip155:8453", method: "POST" }, null, "not a tool"], fetchedAt: 1 };
const c = clean(raw);
const t0 = c.tools[0];
ok(c !== raw && c.tools.length === 1, `non-object tools are dropped (${c.tools.length} kept of ${raw.tools.length})`);
ok(t0.route === "12" && t0.slug === "3" && t0.category === "true" && !("name" in t0) && !("description" in t0),
  `numbers and booleans become their text, objects and arrays are dropped (${JSON.stringify({ route: t0.route, slug: t0.slug, category: t0.category, name: t0.name, description: t0.description })})`);
ok(JSON.stringify(t0.tags) === '["ocr"]' && JSON.stringify(t0.aliases) === '["alt","5"]' && JSON.stringify(t0.networks) === '["eip155:8453"]',
  `lists become lists of text (${JSON.stringify([t0.tags, t0.aliases, t0.networks])})`);
ok(!("name" in c.manifest) && c.manifest.homepage === "7", `manifest text fields are cleaned the same way (${JSON.stringify(c.manifest)})`);
const good = { manifest: { name: "Good" }, tools: [{ route: "/a", name: "a", slug: "a", tags: ["x"] }] };
ok(clean(good) === good, "a clean entry is stored as it came (same object)");

// Snake_case price keys are read through their camelCase twins: what the cache
// stores and what the manifest reader prices match the camelCase spelling.
const { normaliseManifestTools } = await import("../src/x402-index.js");
const storedTool = (over) => clean({ tools: [{ route: "/a", name: "a", ...over }] }).tools[0];
const sCamel = storedTool({ priceUsd: "0.01", amountUsd: 0.02, maxAmountRequired: "10000" });
const sSnake = storedTool({ price_usd: "0.01", amount_usd: 0.02, max_amount_required: "10000" });
ok(sSnake.priceUsd === sCamel.priceUsd && sSnake.amountUsd === sCamel.amountUsd && sSnake.maxAmountRequired === sCamel.maxAmountRequired,
  `a stored tool's snake_case price keys fill the camelCase keys (${JSON.stringify({ priceUsd: sSnake.priceUsd, amountUsd: sSnake.amountUsd, maxAmountRequired: sSnake.maxAmountRequired })})`);
ok(storedTool({ priceUsd: "0.02", price_usd: "0.01" }).priceUsd === "0.02", "a camelCase price key the seller wrote wins over its snake_case twin");
const hostile = storedTool({ price_usd: { toString: 1, valueOf: 2 }, max_amount_required: { toString: "x" }, amount_usd: Infinity });
ok(!("priceUsd" in hostile) && !("price_usd" in hostile) && !("maxAmountRequired" in hostile) && !("max_amount_required" in hostile) && !("amountUsd" in hostile) && !("amount_usd" in hostile),
  `a snake_case price that is not text or a finite number is dropped, not carried over (${JSON.stringify(Object.keys(hostile))})`);
const priceOf = (entry) => normaliseManifestTools({ resources: [{ resource: "https://snake.example/api/a", name: "a", ...entry }] }, "https://snake.example")[0]?.price ?? null;
const pairs = [
  [{ price: { amountUsd: "0.01" } }, { price: { amount_usd: "0.01" } }],
  [{ priceUsd: "0.01" }, { price_usd: "0.01" }],
  [{ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111", maxAmountRequired: "10000" },
    { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x1111111111111111111111111111111111111111", max_amount_required: "10000" }],
];
// A seller who writes both spellings of one key is read as before the
// snake_case keys were supported: a manifest row and an OpenAPI payment object
// take price_usd (the row reader's order), a price object takes priceUsd, and
// a stored tool keeps both keys as written. The snake_case spelling stands in
// only where no price was read: beside an unusable camelCase value.
const { normaliseOpenapiTools } = await import("../src/x402-index.js");
const openapiPriceOf = (payment) => normaliseOpenapiTools({ openapi: "3.1.0", info: { title: "s" }, paths: { "/api/a": { post: { summary: "a", "x-payment-info": payment } } } }, "https://snake.example")[0]?.price ?? null;
const usd = (v) => (v == null ? null : Number(String(v).replace(/[^0-9.]/g, "")));
const readers = [
  ["stored tool", (o) => storedTool(o).priceUsd, "camel"],
  ["manifest row", (o) => priceOf(o), "snake"],
  ["price object", (o) => priceOf({ price: o }), "camel"],
  ["OpenAPI payment object", (o) => openapiPriceOf(o), "snake"],
];
for (const [label, read, wins] of readers) {
  const want = (camel, snake) => (wins === "camel" ? camel : snake);
  const got = [read({ priceUsd: 0.001, price_usd: 9 }), read({ price_usd: 9, priceUsd: 0.001 }), read({ priceUsd: 9, price_usd: 0.001 }), read({ price_usd: 0.001, priceUsd: 9 })].map(usd);
  ok(got[0] === want(0.001, 9) && got[1] === want(0.001, 9) && got[2] === want(9, 0.001) && got[3] === want(9, 0.001),
    `${label}: both spellings of one key read the ${wins === "camel" ? "camelCase" : "snake_case"} value, as before, in either key order (${JSON.stringify(got)})`);
  const unusable = [{ toString: 1, valueOf: 2 }, {}, "  ", NaN, null].map((bad) => usd(read({ priceUsd: bad, price_usd: 0.002 })));
  ok(unusable.every((v) => v === 0.002), `${label}: an unusable camelCase price gives way to a usable snake_case one (${JSON.stringify(unusable)})`);
}
const both = storedTool({ priceUsd: 9, price_usd: 0.001, amountUsd: "1", amount_usd: "2", maxAmountRequired: "10", max_amount_required: "20" });
ok(both.priceUsd === 9 && both.price_usd === 0.001 && both.amountUsd === "1" && both.amount_usd === "2" && both.maxAmountRequired === "10" && both.max_amount_required === "20",
  `a stored tool with both spellings keeps every key as the seller wrote it (${JSON.stringify(both)})`);
// Cleaning is idempotent: a warm start cleans stored rows again, and a second
// pass changes nothing (same object back, same content).
const reclean = [
  { price_usd: "0.01" }, { amount_usd: 0.02, max_amount_required: "10000" },
  { priceUsd: 9, price_usd: 0.001, amountUsd: "1", amount_usd: "2", maxAmountRequired: "10", max_amount_required: "20" },
  { priceUsd: { toString: 1 }, price_usd: "0.002" }, { priceUsd: "  ", price_usd: 0.002 }, { amountUsd: NaN, amount_usd: "3" },
  { maxAmountRequired: [], max_amount_required: { valueOf: 2 } }, { priceUsd: {}, price_usd: {} }, { price_usd: null, priceUsd: null },
  { price: { amount_usd: "1" }, price_usd: Infinity }, { priceUsd: "0.01" }, {},
];
const notStable = [];
for (const over of reclean) {
  const once = clean({ tools: [{ route: "/a", name: "a", ...over }] });
  const twice = clean(once);
  if (twice !== once || JSON.stringify(twice) !== JSON.stringify(once)) notStable.push(JSON.stringify(over, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)));
}
ok(notStable.length === 0, `cleaning a cleaned tool changes nothing, for snake-only, both-keys and malformed camelCase rows (${notStable.length ? notStable.join("; ") : `${reclean.length} rows`})`);
for (const [camelEntry, snakeEntry] of pairs) {
  const a = priceOf(camelEntry), b = priceOf(snakeEntry);
  ok(a != null && a === b, `a crawled manifest entry is priced the same in either spelling (${JSON.stringify(Object.keys(snakeEntry))}: ${a} vs ${b})`);
}

// The server: odd sellers beside a well-formed one, read from a stored index.
const dir = mkdtempSync(join(tmpdir(), "a402-field-types-"));
const now = Date.now();
const tool = (origin, over) => ({ seller: origin, method: "POST", route: "/api/ocr", slug: "ocr", name: "ocr", description: "ocr a thing", category: "vision", tags: ["ocr"], price: 0.003, networks: ["eip155:8453"], ...over });
const shapes = [
  { name: 404 }, { name: { en: "ocr" } }, { name: ["ocr"] }, { slug: 7 }, { description: { text: "ocr" } }, { description: ["ocr", "a thing"] },
  { category: 5 }, { tags: "ocr,vision" }, { tags: [{ t: "ocr" }, null, 3] }, { route: 12 }, { method: 1 }, { aliases: [{ a: 1 }, "ocr-alt"] }, { networks: "eip155:8453" },
];
const lines = shapes.map((over, i) => {
  const origin = `https://odd-${i}.example`;
  return JSON.stringify([origin, { manifest: { name: i % 2 ? { en: "Odd" } : 9, homepage: origin }, tools: [tool(origin, over)], fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1] }]);
});
lines.push(JSON.stringify(["https://good.example", { manifest: { name: "Good Seller", homepage: "https://good.example" }, tools: [tool("https://good.example", {})], fetchedAt: now, source: "manifest", error: null, history: [1, 1, 1, 1, 1] }]));
writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");

const proc = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env, FREE_MODE: "true", PORT: "0", INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
    X402_INDEX_CRAWL: "", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", X402_PAYWALL_PROBES_PER_CYCLE: "0", REDIS_URL: "", STATE_DATABASE_URL: "",
    X402_ECONOMY_DB: join(dir, "econ.db"), MEMORY_DB_FILE: join(dir, "memory.db"), ROUTER_WORKERS: "1", LOAD_SHED: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => { log += d; });
proc.stderr.on("data", (d) => { log += d; });
let exited = null;
proc.on("exit", (code, signal) => { exited = { code, signal }; });
try {
  let base = null;
  for (let i = 0; i < 240 && !base && !exited; i++) { const m = log.match(/listening on :(\d+)/); if (m) base = `http://127.0.0.1:${m[1]}`; else await sleep(250); }
  if (!base) throw new Error(`server never came up${exited ? ` (exited ${JSON.stringify(exited)})` : ""}:\n${log.slice(-800)}`);
  let sellers = 0;
  for (let i = 0; i < 120 && sellers < lines.length && !exited; i++) {
    try { sellers = (await (await fetch(`${base}/api/index?limit=1`)).json()).sellerCount || 0; } catch { /* warming */ }
    if (sellers < lines.length) await sleep(500);
  }
  ok(sellers >= lines.length, `the index warm-started with every seeded seller (${sellers} of ${lines.length})`);

  const reads = [
    ["GET", "/api/index"], ["GET", "/api/index?limit=50"], ["GET", "/api/index?seller=odd-0.example"], ["GET", "/api/index?seller=odd-1.example"],
    ["GET", "/api/index?seller=good.example"], ["GET", "/marketplace"], ["GET", "/marketplace?all=1"], ["GET", "/marketplace/tools"],
    ["GET", "/marketplace/tools?q=ocr"], ["GET", "/leaderboard"], ["GET", "/base"], ["GET", "/sitemap.xml"], ["GET", "/llms-full.txt"],
    ["GET", "/api/reliability"], ["GET", "/.well-known/x402"], ["GET", "/api/find?q=ocr%20a%20thing"], ["GET", "/api/stats"],
    ["POST", "/api/route", { query: "ocr a thing", include: "external", top: 20 }],
    ["POST", "/api/route", { query: "ocr", include: "external", top: 20 }],
  ];
  const bad = [];
  let goodFound = false;
  for (const [method, path, body] of reads) {
    if (exited) break;
    let status = 0, text = "";
    try {
      const r = await fetch(`${base}${path}`, method === "POST" ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
      status = r.status; text = await r.text();
    } catch (e) { status = -1; text = String(e?.message || e); }
    if (status < 0 || status >= 500) bad.push(`${method} ${path} -> ${status} ${text.slice(0, 120)}`);
    if (path === "/api/route" && /good\.example/.test(text)) goodFound = true;
  }
  ok(bad.length === 0, `every page and API that reads sellers answers without a server error (${bad.length ? bad.join("; ") : `${reads.length} reads`})`);
  ok(goodFound, "the well-formed seller is still routed beside the odd ones");
  // What the server holds and shows for an odd seller is text: every tool
  // field a reader takes as text is a string or absent.
  const notText = [];
  for (let i = 0; i < shapes.length; i++) {
    const d = await (await fetch(`${base}/api/index?seller=odd-${i}.example`)).json().catch(() => null);
    const walk = (o) => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== "object") return;
      if (typeof o.route === "string" || "route" in o) for (const k of ["name", "description", "category", "slug", "route", "method"]) {
        if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "string") notText.push(`odd-${i}.${k}=${JSON.stringify(o[k])}`);
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    };
    walk(d);
  }
  ok(notText.length === 0, `every odd seller's tools are served with text fields (${notText.length ? notText.slice(0, 6).join(", ") : "all text"})`);
  await sleep(500);
  ok(!exited && (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)), `the server is still up after every read${exited ? ` (exited ${JSON.stringify(exited)})` : ""}`);
  ok(!/uncaughtException/.test(log), "no uncaught exception was logged");
} catch (e) {
  fail++; console.error(`FAIL - ${e.message}`);
} finally {
  proc.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntest-seller-field-types-serve: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
