#!/usr/bin/env node
// During a redeploy drain, a composite report must not START. The listener is
// closed on SIGTERM, but a keep-alive socket that was busy at that moment can
// still carry one more request before the idle sweep closes it; a composite
// runs 30 s to 4 min, so a run started then is cut off by the drain deadline
// with upstream money already spent for a response nobody receives. The
// dispatcher answers 503 while `draining` (>= 400 cancels settlement: nobody
// charged) and the replacement container takes the retry.
//
// Proven on a real keep-alive socket against a real server: warm the socket,
// SIGTERM, send a composite POST down the same connection, expect the 503.
import { spawn } from "node:child_process";
import { getFreePorts } from "./lib/free-port.js";
import http from "node:http";

const [PORT, PORT2] = await getFreePorts(2);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.error("FAIL -", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const call = (opts, body) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: PORT, agent, ...opts }, (res) => {
    let data = ""; res.on("data", (d) => data += d); res.on("end", () => resolve({ status: res.statusCode, data }));
  });
  req.on("error", (e) => resolve({ status: 0, data: String(e) }));
  if (body) req.write(body);
  req.end();
});

const srv = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
srv.stdout.on("data", (d) => { out += d; });
srv.stderr.on("data", (d) => { out += d; });

let up = false;
for (let i = 0; i < 90; i++) { if ((await call({ method: "GET", path: "/health" })).status === 200) { up = true; break; } await sleep(500); }
ok(up, `server booted on :${PORT}`);
if (!up) { srv.kill("SIGKILL"); console.log(out.slice(-800)); process.exit(1); }

const { EXPENSIVE_COMPOSITE_SLUGS } = await import("../src/composite-spend-guard.js");
const pricing = JSON.parse((await call({ method: "GET", path: "/api/pricing" })).data);
const ep = (pricing.endpoints || []).find((e) => EXPENSIVE_COMPOSITE_SLUGS.has(e.slug));
ok(Boolean(ep), `found a composite route to probe (${ep?.path || "none"})`);

// The socket has to be BUSY when SIGTERM lands: an idle keep-alive socket is
// swept the moment the drain begins, so the only connection that can carry a
// late request is one mid-request at the signal. Hold a POST open (headers +
// half the body), signal, finish the body; the agent then reuses that same,
// now-idle socket for the composite POST within milliseconds - inside the 5 s
// idle-sweep interval, exactly the window the dispatcher check exists for.
const held = JSON.stringify({ text: "busy-at-sigterm" });
const inflight = new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: PORT, agent, method: "POST", path: "/api/hash",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(held) } }, (res) => {
    let data = ""; res.on("data", (d) => data += d); res.on("end", () => resolve({ status: res.statusCode, data }));
  });
  req.on("error", (e) => resolve({ status: 0, data: String(e) }));
  req.write(held.slice(0, 4));
  setTimeout(() => req.end(held.slice(4)), 600);
});
await sleep(250);
srv.kill("SIGTERM");
const first = await inflight;
ok(first.status === 200, `the request busy at SIGTERM completed (got ${first.status})`);
const r = await call({ method: "POST", path: ep.path, headers: { "content-type": "application/json" } }, JSON.stringify({ query: "drain probe", ticker: "AAPL", domain: "example.com", token: "x" }));
if (process.env.DEBUG_DRAIN) { console.log("--- server out tail ---"); console.log(out.split("\n").filter((l) => /SIGTERM|drain|\[boot\]|research|listening/i.test(l)).slice(-12).join("\n")); }
ok(r.status === 503, `composite POST during the drain answers 503 (got ${r.status}: ${String(r.data).slice(0, 200)})`);
ok(/redeploying/i.test(r.data), "refusal names the redeploy and says not charged");

// Control: the same route on a live server is NOT refused with that message
// (it may 400 on the body, 503 for other reasons, or run - anything but the
// drain refusal). Proves the 503 above came from the drain flag. The drained
// server is killed first so two processes never share the scratch SQLite files.
agent.destroy();
srv.kill("SIGKILL");
await sleep(300);
const srv2 = spawn("node", ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT2), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let up2 = false;
for (let i = 0; i < 90; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT2}/health`)).status === 200) { up2 = true; break; } } catch {} await sleep(500); }
if (up2) {
  const c = await fetch(`http://127.0.0.1:${PORT2}${ep.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(8000) }).then(async (x) => ({ status: x.status, data: await x.text() })).catch((e) => ({ status: 0, data: String(e) }));
  ok(!/redeploying/i.test(c.data), `control: a live server does not give the drain refusal (got ${c.status})`);
} else ok(false, "control server did not boot");
srv2.kill("SIGKILL");
await sleep(300);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
