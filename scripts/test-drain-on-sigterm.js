#!/usr/bin/env node
// SIGTERM closes the door at once and drains what is in flight. Nothing else.
//
// This service has a volume, and Railway cannot run two deployments of a
// volume-backed service at once: it stops the old container and only then
// starts the new one. So after SIGTERM there is nothing to keep serving FOR -
// every second this process lingers is a second added to the deploy and to the
// outage, because the replacement cannot boot until we exit. The 2026-08-24/25
// "lame duck" got this backwards and turned a ~3 minute deploy into 16 minutes
// while measuring its own setting as "Railway's gap". This test pins the
// opposite contract, with a real server and a real signal:
//
//   1. a request that is IN FLIGHT when SIGTERM arrives still completes 200
//      (that is the paid-for work the drain exists to protect);
//   2. the listener is closed within a couple of seconds - no lingering;
//   3. the process exits 0 well inside the drain deadline;
//   4. the deadline fits under the Railway grace the deploy job sets, and the
//      code has no timer/quiet-window path left that could reintroduce a wait.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";
import http from "node:http";
import { readFileSync } from "node:fs";

const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  try { const r = await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(3000) }); return r.status; }
  catch { return 0; }
};

const srv = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
srv.stdout.on("data", (d) => { out += d; });
srv.stderr.on("data", (d) => { out += d; });
const exited = new Promise((resolve) => srv.on("exit", (code) => resolve(code)));

let up = false;
for (let i = 0; i < 90; i++) { if (await get("/health") === 200) { up = true; break; } await sleep(500); }
ok(up, `server booted on :${PORT}`);
if (!up) { srv.kill("SIGKILL"); console.log(out.slice(-800)); process.exit(1); }

// --- 1. an in-flight request survives SIGTERM --------------------------------
// Hold a POST open by sending the headers and half the body, signal the server
// while it is waiting for the rest, then finish the body. The response must be
// a normal 200: server.close() stops NEW connections, it must not cut this one.
const body = JSON.stringify({ text: "drain-me" });
const inflight = new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path: "/api/hash",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
    let data = ""; res.on("data", (d) => data += d); res.on("end", () => resolve({ status: res.statusCode, data }));
  });
  req.on("error", (e) => resolve({ status: 0, data: String(e) }));
  req.write(body.slice(0, 5));
  setTimeout(() => req.end(body.slice(5)), 1500);
});
await sleep(300);
const t0 = Date.now();
srv.kill("SIGTERM");

// --- 2. the door closes at once ---------------------------------------------
await sleep(700);
const after = await get("/health");
ok(after === 0, `new connections refused shortly after SIGTERM (got ${after}) - lingering here only delays the replacement`);
ok(/closing listener, draining in-flight requests \(exit 0\)/.test(out), "SIGTERM log names the action: close listener + drain, exit 0");
ok(!/serving (for|until)/.test(out), "no 'keep serving' path fired after SIGTERM");

const r = await inflight;
ok(r.status === 200 && /"/.test(r.data), `in-flight request completed after SIGTERM (got ${r.status})`);

// --- 3. exit 0, promptly -----------------------------------------------------
const code = await Promise.race([exited, sleep(20_000).then(() => "timeout")]);
const elapsed = Date.now() - t0;
ok(code === 0, `exited 0 after draining (got ${code})`);
ok(elapsed < 15_000, `exit took ${elapsed}ms - must be seconds, not a window`);
if (code === "timeout") srv.kill("SIGKILL");

// --- 4. the numbers and the shape ---------------------------------------------
const srvSrc = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const wf = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const num = (m) => (m ? Number(String(m[1]).replace(/_/g, "")) : NaN);
const drain = num(srvSrc.match(/const DRAIN_DEADLINE_MS = ([0-9_]+)/));
const grace = num(wf.match(/RAILWAY_DEPLOYMENT_DRAINING_SECONDS:"(\d+)"/)) * 1000;
ok(Number.isFinite(drain) && drain >= 60_000, `drain deadline ${drain / 1000}s must cover the slowest single-call upstream (transcribe 60s)`);
ok(Number.isFinite(grace) && grace > drain + 10_000,
  `Railway grace ${grace / 1000}s must exceed the drain deadline ${drain / 1000}s with margin, or SIGKILL lands mid-drain`);
ok(grace <= 300_000,
  `Railway grace ${grace / 1000}s is a SIGKILL backstop for a process that exits in seconds - a long one is the lame duck coming back as a variable`);
const shutdownSrc = srvSrc.slice(srvSrc.indexOf("function shutdown(signal,"), srvSrc.indexOf('process.on("SIGTERM"'));
ok(!/setInterval\([^)]*\)\s*;?\s*\n?[\s\S]*quiet/i.test(shutdownSrc) && !/lameDuck|LAME_DUCK|lastRequestAt/.test(srvSrc),
  "no lame-duck window or quiet-detection path remains in shutdown()");
ok(/httpServer\.close\(\(\) => process\.exit\(code\)\)/.test(shutdownSrc), "shutdown() closes the listener synchronously on the signal");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
