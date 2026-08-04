#!/usr/bin/env node
// What does this process ACTUALLY talk to, and which of it costs money?
//
//   node scripts/egress-census.js                 # local (most vendors blind)
//   railway run node scripts/egress-census.js     # the run that counts
//
// WHY THIS EXISTS: three separate cost leaks were found by an invoice rather
// than by us - Alchemy (crawlers holding a 60s cache warm), Brave (CI's own
// sweep), CDP SQL (a public page billing per seller wallet). After each one we
// added a guard for THAT vendor, from a list of vendors we could remember.
//
// A list cannot find what you have not thought of. This measures instead: it
// records every host the process contacts, attributes it to the source file
// that called, and separates crawl targets from vendors.
//
// THE PART THAT MATTERS MOST: a vendor whose API key is unset is UNREACHABLE,
// so a census run without prod's environment cannot see it and must never
// report a clean bill of health. This script prints what it was blind to, and
// exits non-zero if it was blind to anything - because "we found nothing" and
// "we could not look" are the same output otherwise, and that confusion is
// exactly how the last three leaks survived.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vendors that bill per request, and the env var that makes them reachable.
const METERED = [
  ["api.search.brave.com", "BRAVE_API_KEY", "Brave Search"],
  // NB this host serves TWO different things: the BILLED SQL API (via the
  // onchain-sql tool, ~$0.0083/query, the source of the $245/mo invoice) and the
  // FREE x402 Bazaar discovery directory that the index crawler reads. A
  // host-level census cannot tell them apart, so a crawler doing its job reads
  // as paid queries. Check the attributed caller: x402-index.js / leaderboard.js
  // are discovery, anything via the onchain-sql tool is the billed path.
  ["api.cdp.coinbase.com", "CDP_API_KEY_ID", "Coinbase CDP (SQL billed + Bazaar discovery free)"],
  ["api.openai.com", "OPENAI_API_KEY", "OpenAI"],
  ["openrouter.ai", "OPENROUTER_API_KEY", "OpenRouter"],
  ["e2b.dev", "E2B_API_KEY", "E2B sandboxes"],
  // The tool reads NEYNAR_API_KEY || WARPCAST_API_KEY (onchain-identity-kit.js),
  // so checking only the first reports a BLIND SPOT on a perfectly reachable
  // vendor - and a false blind spot makes the run exit non-zero and reads as
  // "we could not look" when we could.
  ["api.neynar.com", ["NEYNAR_API_KEY", "WARPCAST_API_KEY"], "Neynar"],
  ["g.alchemy.com", "ALCHEMY_API_KEY", "Alchemy RPC"],
  ["blockscout.com", "X402_UPSTREAM_BUYER_KEY", "Blockscout Pro"],
];

const LOG = join(tmpdir(), `egress-census-${process.pid}.log`);
const PRELOAD = join(tmpdir(), `egress-preload-${process.pid}.cjs`);
writeFileSync(PRELOAD, `
const fs = require("fs");
const OUT = ${JSON.stringify(LOG)};
// Attribution. This has to skip TRANSPORT PLUMBING, and there is more of it
// than there looks: the server installs its own always-on meter that also wraps
// globalThis.fetch, so a call arrives here as
//   real caller -> meteredFetch (src/egress-meter.js) -> this preload -> note()
// The first version took the first /src/ frame in a 6-line window, which is
// always src/egress-meter.js. Every census since the meter shipped therefore
// reported "<- egress-meter.js" for every metered vendor - the meter blamed for
// all 235 Alchemy calls, naming nothing. Same defect that was just fixed inside
// egress-meter.js itself, living in a second copy here.
// So: raise the frame limit (the default 10 does not reach past the wrappers),
// scan the WHOLE stack, skip known plumbing, and fall back to the package name
// when a vendor SDK made the call and no app frame exists.
const PLUMBING = /egress-meter\\.js|fetch-guard\\.js|egress-preload-/;
const note = (host, stack) => { try {
  const lines = (stack||"").split("\\n").slice(1);
  let f = null, pkg = null;
  for (const line of lines) {
    if (PLUMBING.test(line)) continue;
    const m = line.match(/\\/src\\/([^\\s:)]+)/);
    if (m) { f = m[1]; break; }
    if (!pkg) { const p = line.match(/node_modules\\/((?:@[^/]+\\/)?[^/]+)\\//); if (p) pkg = "pkg:" + p[1]; }
  }
  fs.appendFileSync(OUT, host + "\\t" + (f || pkg || "?") + "\\n");
} catch {} };
const grab = () => { const prev = Error.stackTraceLimit; Error.stackTraceLimit = 60;
  try { return new Error().stack; } finally { Error.stackTraceLimit = prev; } };
const of = globalThis.fetch;
globalThis.fetch = function (i) {
  let h=""; try { const u = typeof i==="string" ? new URL(i) : (i instanceof URL ? i : new URL(i.url)); h=u.host; } catch {}
  if (h) note(h, grab());
  return of.apply(this, arguments);
};
for (const m of ["http","https"]) {
  const mod = require("node:"+m), orig = mod.request;
  mod.request = function (...a) {
    try { const x=a[0]; const h = typeof x==="string" ? new URL(x).host : (x && (x.host||x.hostname)); if (h) note(String(h), grab()); } catch {}
    return orig.apply(this, a);
  };
}
`);
writeFileSync(LOG, "");

const PORT = process.env.CENSUS_PORT || "4399";
const SURFACES = [
  "/", "/marketplace", "/revenue", "/base", "/solana", "/status", "/index", "/sell",
  "/leaderboard", "/api/stats", "/api/leaderboard", "/api/x402-economy", "/api/index",
  "/api/reliability", "/api/rails", "/openapi.json", "/llms.txt", "/.well-known/x402",
];

// `railway run` uses whatever service the CLI is LINKED to, and this repo's
// project has five. Linked to agent402-worker, the injected env carries
// RENDER_WORKER_TOKEN without RENDER_WORKER_URL - an incomplete pair the
// server refuses to boot on, by design (src/worker-client.js). That guard is
// right for a real boot and irrelevant to a census, which only needs the
// process to start and make outbound calls.
//
// Neutralised here rather than worked around by the operator, because the
// alternative is a tool that fails with a stack trace about render workers
// when the actual problem is which service you are linked to.
if (process.env.RENDER_WORKER_TOKEN && !process.env.RENDER_WORKER_URL) {
  delete process.env.RENDER_WORKER_TOKEN;
  console.log("note: dropped RENDER_WORKER_TOKEN (set without RENDER_WORKER_URL) so the server can boot for the census.\n");
}

const envSet = (env) => (Array.isArray(env) ? env : [env]).some((e) => process.env[e]);
const envName = (env) => (Array.isArray(env) ? env.join(" / ") : env);
const blind = METERED.filter(([, env]) => !envSet(env));

// The wrong-service check. If EVERY metered key is missing, this is almost
// certainly not the main app's environment - and without saying so, the run
// would produce a truthful-looking "8 of 8 unobservable" that reads like a
// tooling limitation rather than "you are pointed at the wrong service".
if (blind.length === METERED.length) {
  console.log("⚠  every metered vendor key is absent from this environment.");
  console.log("   If you meant to census production, the main service is `agent402`:");
  console.log("     railway run --service agent402 node scripts/egress-census.js");
  console.log("   (`railway run` uses the LINKED service; `railway status` shows which.)\n");
}
console.log(`egress census — port ${PORT}\n`);

// Prod's environment points DATA_DIR at /data, a Railway volume that does not
// exist on a laptop - so `railway run` injects a path the process cannot write
// and the server dies at boot. Redirect it to a temp dir unless the caller
// chose one: the census cares about which HOSTS are contacted, not about
// reading the real cache, and a warm cache would actually suppress the very
// crawl traffic we are trying to observe.
const DATA_DIR = process.env.CENSUS_DATA_DIR || join(tmpdir(), `census-data-${process.pid}`);
mkdirSync(DATA_DIR, { recursive: true });

const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT, FREE_MODE: "true", X402_SYNC_ON_START: "false",
    DATA_DIR,
    INDEX_CACHE_FILE: join(DATA_DIR, "x402-index-cache.json"),
    NODE_OPTIONS: `--require ${PRELOAD}`,
  },
  // Captured, NOT ignored. The first version discarded the child's output and
  // then reported "server never came up" with no reason - a failure message
  // that tells you nothing is the same defect this whole audit is about.
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BOOT_TIMEOUT_S = Number(process.env.CENSUS_BOOT_TIMEOUT_S || 120);
let up = false;
for (let i = 0; i < BOOT_TIMEOUT_S && !up; i++) {
  if (child.exitCode !== null) break;   // died - stop waiting on a corpse
  try { await fetch(`http://localhost:${PORT}/health`); up = true; } catch { await wait(1000); }
}
if (!up) {
  child.kill("SIGKILL");
  console.error(`server never came up (waited ${BOOT_TIMEOUT_S}s, exitCode=${child.exitCode})`);
  const tail = childLog.trim().split("\n").slice(-25).join("\n");
  console.error(tail ? `\n--- server output (last 25 lines) ---\n${tail}` : "(the server produced no output at all)");
  console.error(`\nIf this is a path error, the prod env points at a volume this machine lacks.`);
  console.error(`Data dir used: ${DATA_DIR}`);
  process.exit(1);
}

for (const s of SURFACES) { try { await fetch(`http://localhost:${PORT}${s}`); } catch {} }
const settle = Number(process.env.CENSUS_SETTLE_MS || 60_000);
console.log(`exercised ${SURFACES.length} public surfaces; waiting ${settle / 1000}s for background timers…\n`);
await wait(settle);
child.kill("SIGKILL");

const rows = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const byHost = new Map();
for (const [h, f] of rows) {
  if (!byHost.has(h)) byHost.set(h, { n: 0, files: new Set() });
  const e = byHost.get(h); e.n++; e.files.add(f);
}
const hits = METERED
  .map(([host, env, name]) => {
    const matched = [...byHost.entries()].filter(([h]) => h.includes(host));
    const n = matched.reduce((a, [, v]) => a + v.n, 0);
    const files = new Set(matched.flatMap(([, v]) => [...v.files]));
    return { host, env, name, n, files: [...files], observable: envSet(env) };
  })
  .filter((x) => x.n > 0 || x.observable);

console.log(`hosts contacted: ${byHost.size}`);
console.log(`\nMETERED vendors reached from a NON-TOOL path (page / crawler / background):`);
let unattached = 0;
for (const h of hits) {
  const nonTool = h.files.filter((f) => f && !f.startsWith("tools/"));
  if (h.n && nonTool.length) { unattached++; console.log(`  ${h.name}: ${h.n} call(s) <- ${nonTool.join(", ")}`); }
}
if (!unattached) console.log("  (none observed in this run)");

// COLD-LEDGER CAVEAT. This is not a footnote — without it the run reports a
// leak that production does not have.
//
// The census points DATA_DIR at a fresh temp dir (a laptop has no /data volume,
// and a warm cache would suppress the very crawl traffic we want to see). But
// the settlement ledger lives there too, so it comes up EMPTY, and every
// ledger-backed surface degrades to its fallback. src/revenue-live.js only
// skips the chain scan when ledgerRecent() returns rows, so with a cold ledger
// all nine EVM rails scan the chain instead — which is exactly the Alchemy
// traffic the ledger-first change was written to remove.
//
// Measured 2026-08-03: this run reported 231 Alchemy calls from revenue-live.js,
// while production served 9 of 12 rails with recentSource="ledger" and ZERO
// chain scans (GET /api/revenue). Both numbers are true; they describe different
// states. Read the vendor counts for ledger-backed callers as COLD-START worst
// case, not steady state, and confirm against prod before chasing one.
if (!process.env.CENSUS_DATA_DIR) {
  console.log(`\n  NOTE — the ledger was COLD for this run (DATA_DIR is a fresh temp dir).`);
  console.log(`  Ledger-backed surfaces fall back to chain scans, so RPC counts here are a`);
  console.log(`  cold-start worst case. Check prod's steady state before treating one as a leak:`);
  console.log(`    curl -s https://agent402.tools/api/revenue | grep -o '"recentSource":"[a-z-]*"' | sort | uniq -c`);
}

console.log(`\nBLIND SPOTS — vendors this run could NOT observe because their key is unset:`);
if (!blind.length) console.log("  (none — every metered vendor was reachable)");
for (const [host, env, name] of blind) console.log(`  ${name.padEnd(26)} ${envName(env)} unset  → ${host} unreachable`);

try { unlinkSync(PRELOAD); } catch {}
console.log("");
if (blind.length) {
  console.log(`INCOMPLETE: ${blind.length} of ${METERED.length} metered vendors were unobservable.`);
  console.log("Re-run with the production environment before treating this as a clean bill of health.");
  process.exit(2);
}
console.log(`COMPLETE: all ${METERED.length} metered vendors were observable; ${unattached} reached from a non-tool path.`);
process.exit(unattached ? 1 : 0);
