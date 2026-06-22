// /api/leaderboard is the public on-chain ranking surface. MCP's
// `top_x402_sellers` tool, the agent402-client SDK's `topSellers()`, the
// `/leaderboard` HTML page, and external integrations all read this same
// JSON. The MCP layer is locked (test-mcp-http.js); the upstream HTTP
// surface isn't. A regression here breaks every downstream surface at once.
//
// This test boots FREE_MODE and locks:
//
//   1. Default-args response (no query string) — the most common call path.
//      Envelope keys: spec ('x402-leaderboard/1'), asOf, scannedBlocks,
//      windowLabel, maxCallUsd, leaderboard[] (always an array — may be
//      empty during warming), cache{cachedAt, lastTriedAt, refreshIntervalMs},
//      include, sortServed, windowRequested, windowServed, totalSellers.
//   2. include default is 'all', sortServed default is 'usd'. Silent
//      default flip skews every uninformed query and the MCP `top_x402_sellers`
//      defaults piggyback on this.
//   3. Explicit include='external' is echoed.
//   4. Explicit sort='calls' is echoed as sortServed='calls'.
//   5. warming flag is a boolean (warming during cold start is OK; serving a
//      non-boolean here breaks downstream truthiness checks).
//   6. cache envelope has the documented keys (cachedAt may be null pre-warm).
//   7. When rows exist, per-row shape matches what MCP top_x402_sellers echoes:
//      { rank, name, network, wallet, callsSettled, totalUsd, uniqueBuyers }.
//      Conditional — CI may run before the first chain scan finishes.
//
//   node scripts/test-leaderboard-envelope.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3081;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  // Default-args call — the path agents hit first.
  const res = await fetch(`${BASE}/api/leaderboard`);
  ok(res.status === 200, `/api/leaderboard → 200 (got ${res.status})`);
  ok((res.headers.get("content-type") || "").includes("application/json"), `content-type is application/json (got ${res.headers.get("content-type")})`);
  const body = await res.json();

  // Envelope shape lock.
  ok(body.spec === "x402-leaderboard/1", `spec='x402-leaderboard/1' (got ${body.spec}) — versioned contract`);
  ok(typeof body.asOf === "string" && !isNaN(Date.parse(body.asOf)), `asOf is a parseable ISO timestamp (got ${body.asOf})`);
  ok(typeof body.scannedBlocks === "number", `scannedBlocks is a number (got ${typeof body.scannedBlocks})`);
  ok(typeof body.windowLabel === "string" && body.windowLabel.length > 0, `windowLabel is non-empty (got ${body.windowLabel})`);
  ok(typeof body.maxCallUsd === "number" && body.maxCallUsd > 0, `maxCallUsd is positive (got ${body.maxCallUsd}) — call-ceiling filter`);
  ok(Array.isArray(body.leaderboard), `leaderboard is an array (may be empty during warming)`);
  ok(body.cache && typeof body.cache === "object", "cache is an object");
  ok("cachedAt" in body.cache, `cache.cachedAt key present (value may be null pre-warm; got ${body.cache.cachedAt})`);
  ok(typeof body.cache.lastTriedAt === "string", `cache.lastTriedAt is string (got ${typeof body.cache.lastTriedAt})`);
  ok(typeof body.cache.refreshIntervalMs === "number" && body.cache.refreshIntervalMs > 0, `cache.refreshIntervalMs is positive (got ${body.cache.refreshIntervalMs})`);
  ok(typeof body.totalSellers === "number" && body.totalSellers >= 0, `totalSellers is non-negative number (got ${body.totalSellers})`);
  ok(typeof body.warming === "boolean", `warming is boolean (got ${typeof body.warming}) — downstream checks rely on this`);

  // Defaults. These are baked into MCP top_x402_sellers' defaults too — a
  // flip here silently rotates what every uninformed agent sees.
  ok(body.include === "all", `default include is 'all' (got ${body.include})`);
  ok(body.sortServed === "usd", `default sortServed is 'usd' (got ${body.sortServed})`);
  ok(typeof body.windowServed === "string" && body.windowServed.length > 0, `windowServed is a non-empty string (got ${body.windowServed})`);
  ok(body.windowRequested === body.windowServed, `default windowRequested === windowServed (got requested=${body.windowRequested}, served=${body.windowServed})`);

  // Explicit args echoed back.
  const ext = await (await fetch(`${BASE}/api/leaderboard?include=external&sort=calls&top=3`)).json();
  ok(ext.include === "external", `?include=external is echoed (got ${ext.include})`);
  ok(ext.sortServed === "calls", `?sort=calls is echoed as sortServed='calls' (got ${ext.sortServed})`);
  ok(Array.isArray(ext.leaderboard) && ext.leaderboard.length <= 3, `?top=3 caps leaderboard length (got ${ext.leaderboard.length})`);

  // Per-row shape lock — only when rows exist. CI is allowed to run during
  // warming; when rows show up, every row carries the documented shape that
  // MCP top_x402_sellers also echoes.
  if (body.leaderboard.length > 0) {
    const row = body.leaderboard[0];
    for (const k of ["rank", "name", "network", "wallet", "callsSettled", "totalUsd", "uniqueBuyers"]) {
      ok(k in row, `row carries ${k} (got keys: ${Object.keys(row).join(",")})`);
    }
    ok(typeof row.totalUsd === "number", `row.totalUsd is a number (got ${typeof row.totalUsd})`);
    ok(typeof row.callsSettled === "number", `row.callsSettled is a number (got ${typeof row.callsSettled})`);
  } else {
    console.log("note: leaderboard empty (warming) — per-row shape lock skipped");
  }

  console.log(`\n${pass} passed (warming=${body.warming}, rows=${body.leaderboard.length})`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
