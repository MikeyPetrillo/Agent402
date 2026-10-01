// Uncached /api/find and /api/route computes run on the main thread. One client
// firing distinct searches in parallel froze production for 3-18 s at a time and
// timed out payment relays (2026-09-25). Pinned here:
//   1. a client past its budget of uncached computes gets a 429 with Retry-After;
//   2. another client is unaffected, and loopback callers (the MCP connector,
//      local sweeps) are never limited;
//   3. the limiter sits AFTER the cache lookup, so a cache hit never counts;
//   4. routableSellerSummaries is memoized and rebuilt when the cache changes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getFreePort } from "./lib/free-port.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };

// --- 3. placement, from source
const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("async function serveCachedDiscovery("), src.indexOf('app.get("/api/find"'));
ok(body.indexOf("cacheGet(cacheKey)") > 0 && body.indexOf("discoveryComputeLimiter.check(") > body.indexOf("cacheGet(cacheKey)"), "the compute limiter runs after the cache lookup, so a cache hit never counts");
ok(body.indexOf("discoveryComputeLimiter.check(") < body.indexOf("computeFn("), "...and before the compute");

// --- 4. memo
process.env.X402_INDEX_CRAWL = "off";
const x = await import("../src/x402-index.js");
const seller = (i) => [`https://s${i}.example.com`, { tools: [{ route: "/a", method: "POST", slug: "a", price: 0.01 }], manifest: { name: `s${i}` }, fetchedAt: Date.now(), error: null, history: [1], originResponded: true }];
x.__testResetSubmitted(); x.__resetRoutableSummaryMemoForTest();
x.__testSeedCache([seller(1), seller(2)]);
const a1 = x.routableSellerSummaries();
ok(x.routableSellerSummaries() === a1, "a second read inside the TTL returns the memoized list");
x.__testSeedCache([seller(3)]);
const a2 = x.routableSellerSummaries();
ok(a2 !== a1 && a2.length === a1.length + 1, `a new seller in the cache rebuilds it (${a1.length} -> ${a2.length})`);
ok(Object.isFrozen(a2), "the shared list is frozen, so no caller can mutate another's view");

// --- 1 + 2. booted server
const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", DISCOVERY_COMPUTE_PER_MIN: "5", DISCOVERY_COMPUTE_PER_HOUR: "100" },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted");
  const find = (q, ip) => fetch(`${base}/api/find?q=${encodeURIComponent(q)}`, { headers: ip ? { "X-Forwarded-For": ip } : {} });
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await find(`distinct query number ${i}`, "203.0.113.9")).status);
  ok(statuses.slice(0, 5).every((s) => s === 200), `the first 5 uncached searches from one client answer (${statuses.join(",")})`);
  const over = await find("distinct query number 99", "203.0.113.9");
  const bodyOver = await over.json();
  ok(over.status === 429 && over.headers.get("retry-after") === "60" && /uncached searches/i.test(bodyOver.error), `past the budget: 429 with Retry-After and a reason (${over.status})`);
  const route = await fetch(`${base}/api/route?q=${encodeURIComponent("another distinct query")}`, { headers: { "X-Forwarded-For": "203.0.113.9" } });
  ok(route.status === 429, "/api/route shares the same budget");
  ok((await find("distinct query number 7", "198.51.100.4")).status === 200, "another client is unaffected");
  let loopOk = true;
  for (let i = 0; i < 8; i++) if ((await find(`loopback query ${i}`)).status !== 200) loopOk = false;
  ok(loopOk, "loopback callers (MCP connector, local sweeps) are never limited");
} finally {
  proc.kill("SIGKILL");
}

// --- 5. each client's own CPU share (2026-10-01): one bursting client gets a
// 429 naming its limit before it can drain the GLOBAL budget that sheds
// everyone else; another client is unaffected; shed refusals are not recorded
// as server errors.
ok(body.indexOf("clientBudget?.over()") > 0 && body.indexOf("clientBudget?.over()") < body.indexOf("discoveryCpuBudget.over()"), "the per-client CPU check runs before the global budget");
ok(/clientBudget\?\.record\(ms\)/.test(body) && /clientBudget\?\.record\(syncMs\)/.test(body), "the per-client budget is charged with the same CPU the global budget is");
ok(/if \(!shed\) recordToolCall\(/.test(body), "a shed refusal is not recorded as a tool-call server error");
{
  const port2 = await getFreePort();
  const proc2 = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, FREE_MODE: "true", PORT: String(port2), X402_INDEX_CRAWL: "off", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", DISCOVERY_CLIENT_CPU_MS: "1", DISCOVERY_COMPUTE_PER_MIN: "100" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const base2 = `http://127.0.0.1:${port2}`;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base2}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    ok(up, "second server booted with a 1 ms per-client share");
    const f = (q, ip) => fetch(`${base2}/api/find?q=${encodeURIComponent(q)}`, { headers: { "X-Forwarded-For": ip } });
    const first = await f("a first uncached search", "203.0.113.50");
    ok(first.status === 200, `a client's first uncached search answers (${first.status})`);
    const second = await f("a second uncached search", "203.0.113.50");
    const sb = await second.json();
    ok(second.status === 429 && second.headers.get("retry-after") === "10" && /at once/i.test(sb.error), `past its own share: 429 naming the client's limit (${second.status})`);
    ok((await f("someone else searching", "198.51.100.50")).status === 200, "another client is unaffected by the first client's burst");
  } finally {
    proc2.kill("SIGKILL");
  }
}
console.log(`test-discovery-compute-limit: ${n} passed`);
