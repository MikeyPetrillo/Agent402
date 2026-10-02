// CI performance gate: paid calls keep flowing while free search is flooded.
//
// On 2026-09-25 a local load test with a production-sized index showed 50
// addresses sending uncached /api/route searches pushing a paid-path probe to
// a 10 s median, a quarter of it timing out. This boots a server warm-started
// from a production-sized synthetic index (the same deterministic fixture the
// router perf pin uses, 3,000 sellers / 100k+ tools), floods uncached searches
// from 50 addresses, and runs a steady paid-path probe beside it. Fails when:
//   - any paid-path call does not answer 200,
//   - the paid-path p95 passes PERF_PAID_P95_MS (default 600; CI runners are
//     slower than a laptop; without the CPU budget the p95 measured 3.4 s),
//   - the server logs a stall over 1 s during the flood.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort } from "./lib/free-port.js";
import { buildRoutePerfFixture } from "./lib/route-perf-fixture.js";

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log(`ok - ${m}`); };
const TOKEN = "perf-budget-operator-token-0123456789";
const FLOOD_MS = Number(process.env.PERF_FLOOD_MS || 8000);
const PAID_P95_MS = Number(process.env.PERF_PAID_P95_MS || 600);

// --- the fixture, written in the warm-start NDJSON format
const dir = mkdtempSync(join(tmpdir(), "a402-perf-"));
const file = join(dir, "x402-index-cache.json");
const lines = [];
const now = Date.now();
buildRoutePerfFixture({ cache: { set: (o, e) => lines.push(JSON.stringify([o, { ...e, fetchedAt: now, source: "manifest" }])) } });
writeFileSync(join(dir, "x402-index-cache.ndjson"), [JSON.stringify({ savedAt: now, format: "ndjson-v1", origins: lines.length }), ...lines].join("\n") + "\n");
ok(lines.length >= 2900, `fixture written (${lines.length} sellers)`);

const port = await getFreePort();
const proc = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(port), INDEX_CACHE_FILE: file, INDEX_FIRST_CRAWL_DELAY_MS: "999999999", X402_SYNC_ON_START: "false", MPP_INDEX_CRAWL: "off", REDIS_URL: "", AGENT402_OPERATOR_TOKEN: TOKEN },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  ok(up, "server booted");
  let sellers = 0;
  for (let i = 0; i < 60 && sellers < 2900; i++) {
    try { sellers = (await (await fetch(`${base}/api/index?limit=1`)).json()).sellerCount || 0; } catch { /* warming */ }
    if (sellers < 2900) await new Promise((r) => setTimeout(r, 500));
  }
  ok(sellers >= 2900, `the index warm-started at production size (${sellers} sellers)`);
  await new Promise((r) => setTimeout(r, 2000)); // let the route index build off the query path
  await fetch(`${base}/__operator/perf.json?reset=1`, { headers: { authorization: `Bearer ${TOKEN}` } });

  const until = Date.now() + FLOOD_MS;
  const words = ["json", "csv", "weather", "price", "token", "pdf", "image", "hash", "dns", "email", "wallet", "stock", "search", "crypto", "qr", "uuid"];
  let i = 0;
  const flood = Promise.all(Array.from({ length: 50 }, async () => {
    while (Date.now() < until) {
      const k = i++;
      const q = `${words[k % 16]} ${words[(k * 7) % 16]} ${words[(k * 11) % 16]} ${k}`;
      try { const r = await fetch(`${base}/api/route?q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": `198.51.100.${k % 50}` }, signal: AbortSignal.timeout(20_000) }); await r.arrayBuffer(); } catch { /* the flood's own fate is not asserted */ }
    }
  }));
  const paid = [], paidStatus = {};
  const probes = [];
  while (Date.now() < until) {
    const t0 = performance.now();
    probes.push(fetch(`${base}/api/hash`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": "perf-budget-paid-probe".padEnd(48, "x") }, body: JSON.stringify({ text: String(t0) }), signal: AbortSignal.timeout(20_000) })
      .then(async (r) => { await r.arrayBuffer(); paid.push(performance.now() - t0); paidStatus[r.status] = (paidStatus[r.status] || 0) + 1; })
      .catch((e) => { paid.push(performance.now() - t0); paidStatus[e?.name || "error"] = (paidStatus[e?.name || "error"] || 0) + 1; }));
    await new Promise((r) => setTimeout(r, 100));
  }
  await Promise.all([flood, ...probes]);
  const perf = await (await fetch(`${base}/__operator/perf.json`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const p95 = Math.round(pct(paid, 0.95));
  console.log(`# paid-path: n=${paid.length} p50=${Math.round(pct(paid, 0.5))}ms p95=${p95}ms max=${Math.round(Math.max(...paid))}ms statuses=${JSON.stringify(paidStatus)}; flood searches=${i}; shed=${JSON.stringify(perf.shed)}; stalls=${perf.loop.stalls} worst=${perf.loop.worstMs}ms`);
  ok(paid.length >= FLOOD_MS / 150 && Object.keys(paidStatus).every((k) => k === "200"), `every paid-path call answered 200 during the flood (${JSON.stringify(paidStatus)})`);
  ok(p95 <= PAID_P95_MS, `paid-path p95 ${p95} ms <= ${PAID_P95_MS} ms while 50 addresses flood uncached search`);
  ok((perf.loop.stalls || 0) === 0, `no event-loop stall over 1 s during the flood (worst ${perf.loop.worstMs} ms)`);
} finally {
  proc.kill("SIGKILL");
}
console.log(`test-perf-budget: ${n} passed`);
