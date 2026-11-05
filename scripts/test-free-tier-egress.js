#!/usr/bin/env node
// The free tier must not reach the network or spawn a process. This proves it.
//
//   node scripts/test-free-tier-egress.js
//
// WHY: 200+ compute-payable tools are served FREE on the authless MCP connector
// and for a CPU solve over HTTP. If one of them egressed, a free caller could
// farm a metered upstream (search, inference, a sandbox, an RPC quota) on our
// account, at our cost, without paying. That is exactly what WALLET_ONLY_SLUGS
// exists to prevent - and until now the only thing enforcing it was that list
// being maintained by hand. A new kit whose author forgets to list a slug is
// permanently free, and nothing would have said so. Two prior lane-specific
// leaks (Brave, then E2B) are the evidence that hand-maintenance fails; a
// security audit measured the property once with an instrumented probe, but a
// one-time measurement is not an invariant.
//
// HOW: the server boots under scripts/egress-probe-preload.js, which enters an
// AsyncLocalStorage context per inbound request and records every fetch, HTTP
// request, socket connect, DNS lookup and child_process call that happens inside
// one. Egress from background work (crawler, leaderboard refresh, snapshot
// warming) has no request context and is ignored rather than blamed on a tool.
// The crawler is switched off anyway with X402_INDEX_CRAWL=off.
//
// Each free tool is then called with its own documented example, and the
// invariant is: zero attributed egress. A tool that legitimately needs the
// network belongs in WALLET_ONLY_SLUGS, which is the fix - not an exemption here.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { spawn } from "node:child_process";
import { readFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.EGRESS_TEST_PORT) || 3231;
const B = `http://127.0.0.1:${PORT}`;
const LOG = join(mkdtempSync(join(tmpdir(), "a402-egress-")), "egress.jsonl");

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn("node", ["--import", "./scripts/egress-probe-preload.js", "src/server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    FREE_MODE: "true",
    PORT: String(PORT),
    EGRESS_LOG: LOG,
    X402_INDEX_CRAWL: "off",
    AGENT402_MCP_MAX_PER_MIN: "999999",
    AGENT402_MCP_MAX_PER_HOUR: "9999999",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = "";
srv.stdout.on("data", (d) => { srvLog += d; });
srv.stderr.on("data", (d) => { srvLog += d; });

const readLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

try {
  let up = false;
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${B}/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await sleep(500);
  }
  ok(up, "instrumented server booted");
  if (!up) throw new Error(`server never came up:\n${srvLog.slice(-800)}`);
  ok(/crawler disabled/.test(srvLog), "the index crawler is off, so background egress cannot mask a leak");

  // Sanity check FIRST: the probe must be able to SEE egress, or a clean run
  // below would prove nothing. http-check is the control because it fetches a
  // caller-supplied URL, so the egress is unmistakably inside the request. (A
  // DNS-based tool is a poor control: it never calls fetch, so a blind probe
  // would look identical to a clean one - which is how the first version of
  // this test managed to report nothing while working perfectly.)
  await fetch(`${B}/api/http-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  }).catch(() => {});
  await sleep(400);
  const control = readLog();
  ok(control.length > 0, `the probe detects egress at all (control tool produced ${control.length} record(s))`);
  if (!control.length) throw new Error("probe is blind - a clean result would be meaningless");
  if (existsSync(LOG)) unlinkSync(LOG);

  // Now drive every free tool with its own documented example.
  const pricing = await (await fetch(`${B}/api/pricing`)).json();
  const free = (pricing.endpoints || []).filter((e) => e.computePayable);
  ok(free.length > 150, `found the compute-payable tools to check (${free.length})`);

  const spec = await (await fetch(`${B}/openapi.json`)).json();
  const exampleFor = (path, method) => {
    const op = spec.paths?.[path]?.[method.toLowerCase()];
    const body = op?.requestBody?.content?.["application/json"]?.example;
    const params = (op?.parameters || []).filter((p) => p.example !== undefined);
    return { body, query: params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.example)}`).join("&") };
  };

  let called = 0, skipped = 0;
  for (const e of free) {
    const { body, query } = exampleFor(e.path, e.method);
    const url = `${B}${e.path}${query ? `?${query}` : ""}`;
    try {
      if (e.method === "GET") await fetch(url);
      else await fetch(url, { method: e.method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      called++;
    } catch { skipped++; }
  }
  await sleep(1200); // let any late async egress land in the log
  ok(called > 150, `exercised the free tools (${called} called, ${skipped} unreachable)`);

  const records = readLog();
  // Group by request so a failure names the offending tool, not just a count.
  const byReq = new Map();
  for (const r of records) byReq.set(r.req, [...(byReq.get(r.req) || []), r]);
  for (const [req, hits] of byReq) {
    console.error(`  EGRESS from ${req}: ${hits.slice(0, 3).map((h) => `${h.kind} -> ${h.target}`).join("; ")}${hits.length > 3 ? ` (+${hits.length - 3})` : ""}`);
  }
  ok(records.length === 0,
    `no compute-payable tool reached the network or spawned a process (${records.length} egress record(s) across ${byReq.size} request(s))`);
} catch (e) {
  failed++;
  console.error(`FAIL - ${String(e?.message || e).slice(0, 400)}`);
} finally {
  srv.kill("SIGTERM");
  await sleep(400);
  srv.kill("SIGKILL");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
