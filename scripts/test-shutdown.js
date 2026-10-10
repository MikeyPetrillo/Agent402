// Process-lifecycle tests (security audit A402-10). Two guarantees:
//
//   1. SIGTERM still drains and exits 0 — the redeploy path that protects
//      in-flight, already-paid requests must NOT be broken by the fatal change.
//   2. An uncaught exception is now FATAL: the process drains briefly then exits
//      NON-ZERO within the deadline, instead of continuing to serve payments
//      from an undefined state.
//
// Both run the behavior in a real child process (the only faithful way to test
// process exit). No network beyond localhost /health.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Real server: SIGTERM drains and exits 0 (redeploy path intact) ----
async function testSigterm() {
  const port = 3400 + (process.pid % 500);
  const child = spawn(process.execPath, ["src/server.js"], {
    // No lame duck: the service is volume-backed, so Railway cannot start the
    // replacement until this process exits (see the shutdown comment in
    // src/server.js). SIGTERM closes the listener at once and drains; the
    // in-flight half of that contract is test-drain-on-sigterm.js.
    env: { ...process.env, FREE_MODE: "true", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  // Wait for the server to be listening.
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await wait(250);
  }
  ok(up, "server booted in FREE_MODE");

  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const t0 = Date.now();
  child.kill("SIGTERM");
  const code = await Promise.race([exited, wait(20_000).then(() => "timeout")]);
  const elapsed = Date.now() - t0;
  ok(code === 0, `SIGTERM exits 0 (graceful redeploy) — got ${code}`);
  ok(elapsed < 20_000, `SIGTERM drain completes well under the 75s hard deadline (${elapsed}ms)`);
  ok(/closing listener, draining in-flight requests \(exit 0\)/.test(out), "SIGTERM logs close + drain with exit 0");
  if (code === "timeout") child.kill("SIGKILL");
}

// ---- 2. Fatal uncaughtException → non-zero exit within the deadline ----
// A self-contained harness that mirrors the server.js wiring (an http server +
// the same shutdown(code,deadline) + uncaughtException handler), then throws
// asynchronously outside any try/catch. Asserts the process exits 1 quickly.
async function testFatal() {
  const dir = mkdtempSync(join(tmpdir(), "a402-fatal-"));
  const harness = join(dir, "harness.mjs");
  writeFileSync(harness, `
import http from "node:http";
const httpServer = http.createServer((_req, res) => res.end("ok")).listen(0);
let shuttingDown = false;
function shutdown(signal, { code = 0, deadlineMs = 75000 } = {}) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(signal + " received — draining in-flight requests (exit " + code + ")");
  httpServer.close(() => process.exit(code));
  httpServer.closeIdleConnections();
  setTimeout(() => process.exit(code), deadlineMs).unref();
}
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] fatal:", err && err.message);
  try { shutdown("uncaughtException", { code: 1, deadlineMs: 10000 }); } catch { process.exit(1); }
});
// Throw asynchronously, outside any try/catch — a real uncaught exception.
setImmediate(() => { throw new Error("boom"); });
`);
  const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const t0 = Date.now();
  const code = await Promise.race([exited, wait(12_000).then(() => "timeout")]);
  const elapsed = Date.now() - t0;
  ok(code === 1, `uncaughtException exits NON-ZERO (got ${code})`);
  ok(typeof code === "number" && elapsed < 11_000, `fatal exit is bounded by the deadline (${elapsed}ms)`);
  ok(/\[uncaughtException\] fatal/.test(out), "fatal handler logged before exit");
  ok(/draining in-flight requests \(exit 1\)/.test(out), "fatal path drains with exit 1 (not a bare crash)");
  if (code === "timeout") child.kill("SIGKILL");
}

// ---- 3. Real server, file mode: the fatal drain keeps its full deadline ----
// Without a state database there is no lease to release and no pool to close,
// so nothing may cut the drain short: a request still in flight holds the
// exit until the fatal deadline (10 s), exactly as before the database work.
// A preload throws from a SIGUSR2 handler, a real uncaught exception inside
// the server process, while a POST is held open mid-body.
async function testFatalFileModeDeadline() {
  const dir = mkdtempSync(join(tmpdir(), "a402-fatal-srv-"));
  const preload = join(dir, "throw-on-usr2.mjs");
  writeFileSync(preload, `process.on("SIGUSR2", () => { throw new Error("boom from the test"); });\n`);
  const port = 3900 + (process.pid % 500);
  const env = { ...process.env, FREE_MODE: "true", PORT: String(port), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" };
  delete env.STATE_DATABASE_URL;
  const child = spawn(process.execPath, ["--import", preload, "src/server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { up = true; break; } } catch { /* not up yet */ }
    await wait(250);
  }
  ok(up, "server booted in FREE_MODE with the throwing preload");
  const http = await import("node:http");
  const held = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/hash", headers: { "content-type": "application/json", "content-length": 64 } });
  held.on("error", () => {});
  held.write("{\"text\":");
  await wait(300);
  const t0 = Date.now();
  child.kill("SIGUSR2");
  const code = await Promise.race([exited, wait(15_000).then(() => "timeout")]);
  const elapsed = Date.now() - t0;
  ok(code === 1, `uncaught exception in the server exits 1 (got ${code})`);
  ok(elapsed >= 9_000 && elapsed < 12_000, `file mode: a held request keeps the fatal drain to its 10 s deadline, no early finish (${elapsed}ms)`);
  held.destroy();
  if (code === "timeout") child.kill("SIGKILL");
}

(async () => {
  await testSigterm();
  await testFatal();
  await testFatalFileModeDeadline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
