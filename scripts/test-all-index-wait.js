#!/usr/bin/env node
// scripts/test-all.js waits for the server's seller index before its strict
// sweep, and fails naming the state when the index never loads.
//
// Why: a server answers a seller question (seller-dossier) with a 503 "the
// seller index is still loading" until its first crawl or warm start lands.
// Started right after a boot, the sweep read that honest 503 as a strict
// failure; in CI it passed only because earlier steps gave the index time.
//
// A stub stands in for the server: /api/index/tools says `indexing: true`
// (with Retry-After) for a while, and the one documented route answers 503
// "still loading" until then. Offline; the stub binds port 0.
//
//   node scripts/test-all-index-wait.js
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SWEEP = process.env.TEST_ALL_SCRIPT || fileURLToPath(new URL("./test-all.js", import.meta.url));
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "ok" : "FAIL"} - ${m}`); if (!c) failed++; };

function stub(readyAfterMs) {
  const t0 = Date.now();
  const ready = () => readyAfterMs != null && Date.now() - t0 >= readyAfterMs;
  const spec = { openapi: "3.1.0", info: { title: "stub", version: "0" }, paths: {
    "/api/seller-dossier": { get: { tags: ["sellers"], parameters: [{ name: "seller", in: "query", example: "example.com" }], responses: { 200: { description: "ok" } } } },
  } };
  const s = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/api/index/tools") return ready() ? json(200, { indexing: false, indexState: "ready", tools: [] }) : json(200, { indexing: true, indexState: "first-crawl", tools: [] }, { "retry-after": "1" });
    if (u.pathname === "/openapi.json") return json(200, spec);
    if (u.pathname === "/api/seller-dossier") return ready() ? json(200, { seller: "example.com" }) : json(503, { error: "the seller index is still loading on this server (first-crawl) - retry in 60s" });
    json(404, { error: "not found" });
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function sweep(port, env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SWEEP], { env: { ...process.env, TARGET_URL: `http://127.0.0.1:${port}`, TEST_ALL_SKIP_STRICT_COVERED: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    const kill = setTimeout(() => c.kill("SIGKILL"), 60_000);
    c.on("close", (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

{
  const s = await stub(2500);
  const t0 = Date.now();
  const r = await sweep(s.address().port);
  s.close();
  ok(r.code === 0 && /strict \(pure-CPU\): 1 passed, 0 failed/.test(r.out), `started while the index loads, the sweep waits and passes (exit ${r.code})`);
  ok(Date.now() - t0 >= 2500 && /waiting for the seller index/.test(r.out), "...after waiting on the index signal, and says so");
}
{
  const s = await stub(null);
  const r = await sweep(s.address().port, { TEST_ALL_INDEX_WAIT_MS: "1500" });
  s.close();
  ok(r.code === 1 && /seller index .* never became ready \(still first-crawl/.test(r.out) && !/strict \(pure-CPU\)/.test(r.out), `an index that never loads fails before the sweep, naming its state (exit ${r.code})`);
}
{
  const s = await stub(0);
  const t0 = Date.now();
  const r = await sweep(s.address().port);
  s.close();
  ok(r.code === 0 && !/waiting for the seller index/.test(r.out) && Date.now() - t0 < 20_000, "control: a ready index costs no wait");
}
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall test-all index-wait checks passed");
