// The operator heap read names every large in-memory store (src/memory-stores.js,
// /__operator/heap.json `stores`): sizes track the real heap, the read stays
// bounded at production scale, a store past the time budget reads `skipped`,
// every registered store reports, and the route stays operator-only.
//
//   node scripts/test-memory-stores.js          (offline; boots a free-mode server)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getFreePort } from "./lib/free-port.js";

const ms = await import("../src/memory-stores.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// CI runs without --expose-gc; enable it here so the heap comparison runs.
const v8 = await import("node:v8"); const vm = await import("node:vm");
v8.setFlagsFromString("--expose-gc");
const gc = globalThis.gc || vm.runInNewContext("gc");
const heapNow = () => { gc(); gc(); return process.memoryUsage().heapUsed; };

// --- 1. sizes track the real heap (a seller-shaped store, production layout:
// most sellers list ~30 tools, every 50th lists 250).
const tool = (i, s) => ({ route: `/api/t${i}/${s}`, method: "GET", name: `tool ${i} of ${s}`, description: `a description of tool ${i} of seller ${s} that says what it does`, price: "0.01", networks: ["base", "solana"], paid: true });
const h0 = heapNow();
const sellers = new Map();
for (let i = 0; i < 6000; i++) sellers.set(`https://seller${i}.example`, { tools: Array.from({ length: i % 50 ? 30 : 250 }, (_, j) => tool(j, i)), fetchedAt: i, manifest: { name: `s${i}` } });
const realMb = (heapNow() - h0) / 1048576;
ms._resetMemoryStoresForTest();
ms.registerMemoryStore("fixture.sellers", () => sellers, { note: "seller-shaped" });
{
  const { stores } = ms.memoryStoreFigures();
  const est = stores["fixture.sellers"].sampledMb;
  ok(stores["fixture.sellers"].rows === 6000, "a Map reports its member count");
  ok(est > realMb * 0.5 && est < realMb * 2, `the sampled estimate tracks the real heap (${est} MB estimated, ${realMb.toFixed(1)} MB measured)`);
}

// --- 2. the read is bounded at production scale: ~200k tool rows, a 200k-row
// flat directory, a 200k-row in-memory ledger, and sixty smaller stores.
const flat = Array.from({ length: 200_000 }, (_, i) => ({ origin: `https://s${i % 5800}.example`, route: `/api/x${i}`, desc: `desc ${i}`, n: i }));
const db = new Database(":memory:");
db.exec("CREATE TABLE sales (id INTEGER PRIMARY KEY, slug TEXT, usd REAL, payer TEXT)");
const ins = db.prepare("INSERT INTO sales (slug, usd, payer) VALUES (?, ?, ?)");
db.transaction(() => { for (let i = 0; i < 200_000; i++) ins.run(`slug-${i % 600}`, 0.005, `0x${String(i % 5000).padStart(40, "0")}`); })();
ms.registerMemoryStore("fixture.directory", () => flat, { note: "flat rows" });
ms.registerSqliteStore("fixture.ledger", () => db, { note: "in-memory ledger" });
for (let k = 0; k < 60; k++) {
  const m = new Map();
  for (let i = 0; i < 2000; i++) m.set(`k${k}-${i}`, { at: i, value: `v${i}`.repeat(4), list: [i, i + 1, i + 2] });
  ms.registerMemoryStore(`fixture.small${k}`, () => m);
}
// Same-machine baseline: serializing the one 200k-row store whole, the work
// sampling avoids. A slow runner slows both, so the time bounds and the read
// budget are a share of it (never under the 40-50 ms they were), under an
// absolute cap; a read that walked whole stores would take about all of it.
const t00 = performance.now();
JSON.stringify(flat);
const fullMs = performance.now() - t00;
const READ_BOUND = Math.min(250, Math.max(50, fullMs * 0.5));
// The skip check gets room past a collector pause; only a read that walks
// whole stores would still run out of it.
const BUDGET = Math.min(500, Math.max(100, fullMs));
// The fastest of three reads: one collector pause does not decide the bound.
const timedRead = (opts) => { let best = null; for (let k = 0; k < 3; k++) { const t0 = performance.now(); const r = ms.memoryStoreFigures(opts); const wall = performance.now() - t0; if (!best || wall < best.wall) best = { r, wall }; } return best; };
{
  const { r, wall } = timedRead({ budgetMs: BUDGET });
  ok(wall < READ_BOUND && r.readMs < READ_BOUND, `the whole read stays bounded at production scale (${wall.toFixed(1)} ms, ${Object.keys(r.stores).length} stores; bound ${Math.round(READ_BOUND)} ms: 50 ms or half of the ${Math.round(fullMs)} ms whole-store serialize)`);
  ok(r.skipped === 0, `nothing was skipped inside the budget (${r.skipped}, budget ${Math.round(BUDGET)} ms)`);
  const led = r.stores["fixture.ledger"];
  ok(led.kind === "sqlite" && led.rows === 200_000 && led.sampledMb > 1 && led.memory === true, `a SQLite store reports its pages and rows (${led.rows} rows, ${led.sampledMb} MB)`);
  ok(r.stores["fixture.directory"].rows === 200_000, "an array reports its length");
  const order = Object.values(r.stores).map((s) => s.sampledMb ?? -1);
  ok(order.every((v, i) => i === 0 || order[i - 1] >= v), "stores are listed largest first");
}

// --- 3. one pathological store cannot run the read away: two million
// entries, nested, still answers inside the budget.
{
  const huge = new Map();
  for (let i = 0; i < 2_000_000; i++) huge.set(i, { a: i, b: [i, { c: `x${i}` }] });
  ms.registerMemoryStore("fixture.huge", () => huge);
  const { r, wall } = timedRead({ budgetMs: BUDGET });
  ok(wall < READ_BOUND + 10 && r.stores["fixture.huge"].rows === 2_000_000, `a 2M-entry store is sampled, not walked (${wall.toFixed(1)} ms, bound ${Math.round(READ_BOUND + 10)} ms)`);
  huge.clear();
}

// --- 4. past the time budget, the remaining stores read `skipped`.
{
  let clock = 0;
  const r = ms.memoryStoreFigures({ budgetMs: 5, now: () => (clock += 3) });
  const skipped = Object.values(r.stores).filter((s) => s.skipped === "time budget").length;
  ok(r.skipped > 0 && skipped === r.skipped, `stores past the budget read skipped (${skipped} of ${Object.keys(r.stores).length})`);
}

// --- 5. a getter that throws is reported, not fatal; a figure store reports its own numbers.
{
  ms._resetMemoryStoresForTest();
  ms.registerMemoryStore("fixture.throws", () => { throw new Error("not built yet"); });
  ms.registerMemoryStore("fixture.figure", null, { figure: () => ({ rows: 7, mb: 1.24 }) });
  const r = ms.memoryStoreFigures();
  ok(/not built yet/.test(r.stores["fixture.throws"].error || ""), "a store whose read throws reports the error");
  ok(r.stores["fixture.figure"].rows === 7 && r.stores["fixture.figure"].sampledMb === 1.2, "a figure store reports its own count and size");
}
sellers.clear(); flat.length = 0; db.close();

// --- 6. the live route: operator-only, every module's stores report, none errors.
const EXPECT = [
  "x402-index.entries", "x402-index.routeIndex", "x402-index.directory", "x402-index.tokenIntern", "x402-index.bazaarTools",
  "x402-index.sideSynced", "x402-index.probeExamples", "x402-index.robotsCache", "x402-index.crawlValidators",
  "mpp-index.entries", "mpp-index.registry", "leaderboard.snapshot", "leaderboard.history", "leaderboard-log-cache.intern",
  "mpp-leaderboard.current", "solana-leaderboard.current", "revenue-live.snapshot", "x402-economy.history",
  "sales-ledger.db", "revenue-ledger.db", "refund-ledger.db", "pow.db", "ledger-mirror.journals",
  "request-timing.routes", "solana-history.cache", "sanctions-screen.state", "ofac-sdn.held", "tool-failure-monitor",
  "server.surfaceMemo", "server.chainSellerViews", "server.externalServes", "server.toolCards",
];
const dir = mkdtempSync(join(tmpdir(), "a402-memstores-"));
const TOKEN = "memory-stores-operator-token-0123456789";
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: join(dir, "x402-index-cache.json"), INDEX_FIRST_CRAWL_DELAY_MS: "999999999",
    X402_INDEX_CRAWL: "", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", STATE_DATABASE_URL: "", X402_ECONOMY_DB: join(dir, "econ.db"),
    ROUTER_WORKERS: "0", AGENT402_OPERATOR_TOKEN: TOKEN, LOAD_SHED: "off",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(500); } }
  ok(up, "the free-mode server booted");
  const anon = await fetch(`${base}/__operator/heap.json`);
  ok(anon.status === 404, `heap.json without the operator token is 404 (${anon.status})`);
  const res = await fetch(`${base}/__operator/heap.json`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  const names = Object.keys(body.stores || {});
  const missing = EXPECT.filter((n) => !names.includes(n));
  ok(res.status === 200 && missing.length === 0, `every named store reports (${names.length} stores${missing.length ? `; missing ${missing.join(", ")}` : ""})`);
  const errored = Object.entries(body.stores || {}).filter(([, s]) => s.error).map(([n, s]) => `${n}: ${s.error}`);
  ok(errored.length === 0, `no store read errors (${errored.join("; ") || "none"})`);
  // The server's own 40 ms budget bounds this read; a slow runner may spend
  // part of it, so the check is that the budget held and nothing was cut.
  ok(Number.isFinite(body.storesReadMs) && body.storesReadMs < 200 && body.storesSkipped === 0, `the live read is bounded (${body.storesReadMs} ms, ${body.storesSkipped} skipped)`);
} finally {
  proc.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ntest-memory-stores: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
