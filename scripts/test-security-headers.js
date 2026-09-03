// Exposure-hardening regression (security audit A402-11/12/13). Boots a real
// server and asserts: the Express fingerprint header is gone, a valid RFC 9116
// security.txt is served, /health hides its internal wiring from the public,
// and the /mcp CORS stays wildcard-but-credential-free.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = await getFreePort();
const base = `http://127.0.0.1:${PORT}`;
// stdio was "ignore", so a boot failure printed "FAIL - server booted" and
// nothing else - no exit code, no stack, no port. This failed once in CI and
// PASSED on the same commit in the parallel run, and the log could not say why
// because the evidence was discarded at spawn. Capture it and print it on
// failure; a boot that fails silently is unfixable by construction.
//
// X402_INDEX_CRAWL=off because this test has nothing to do with the seller
// crawl: leaving it on sets thousands of third-party fetches racing the boot
// this test is timing, on a shared CI runner already hosting other spawned
// servers. Slower boot, noisier neighbours, no coverage gained.
let childLog = "";
const T_SPAWN = Date.now();
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false", X402_INDEX_CRAWL: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
const stamp = (d) => String(d).split(/\r?\n/).filter(Boolean).map((l) => `[+${((Date.now() - T_SPAWN) / 1000).toFixed(1)}s] ${l}`).join("\n") + "\n";
child.stdout.on("data", (d) => { childLog += stamp(d); });
child.stderr.on("data", (d) => { childLog += stamp(d); });
let exited = null;
child.on("exit", (code, signal) => { exited = `exit=${code} signal=${signal}`; });
const done = (code) => { try { child.kill("SIGKILL"); } catch { /* */ } process.exit(code); };

(async () => {
  let up = false;
  // 60s, not 20s: the budget has to cover a cold boot on a loaded runner, and
  // the old one was tight enough that ordinary contention read as a failure.
  // Keep the LAST /health outcome: a 503 (health check false), a non-2xx, and
  // "connection refused" are different failures, and the old loop discarded
  // which one it saw - a run failed here once with the server log reading
  // "listening" and nothing to say whether /health answered 503 or nothing.
  let last = "no attempt";
  const t0 = Date.now();
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) { up = true; break; }
      last = `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
    } catch (e) {
      // The WHOLE cause, not just its code: CI run 33100641970 failed here with
      // "fetch failed" and no code at all while the child had logged
      // "listening on :3659" and no [boot] stall - so the code alone said
      // nothing. undici wraps the real error in `cause`; name/message/errno/
      // syscall/address/port are what distinguish refused vs reset vs a
      // hung handshake.
      const c = e?.cause;
      const detail = c ? `${c.name || ""} ${c.code || ""} ${c.errno ?? ""} ${c.syscall || ""} ${c.address || ""}:${c.port ?? ""} ${c.message || ""}` : "";
      last = `fetch error: ${String(e?.message || e).slice(0, 80)} cause=[${detail.trim().slice(0, 200)}]`;
    }
    await wait(250);
  }
  if (!up) {
    console.error(`--- last /health outcome after ${Math.round((Date.now() - t0) / 1000)}s: ${last} ---`);
    // Raw TCP: does the port accept a connection at all? Separates "nothing is
    // listening where the log says" from "listening, but HTTP never answers".
    try {
      const net = await import("node:net");
      const tcp = await new Promise((resolve) => {
        const sock = net.createConnection({ host: "127.0.0.1", port: PORT });
        const t = setTimeout(() => { sock.destroy(); resolve("timeout after 3s"); }, 3000);
        sock.on("connect", () => { clearTimeout(t); sock.destroy(); resolve("connected"); });
        sock.on("error", (err) => { clearTimeout(t); resolve(`error ${err.code || err.message}`); });
      });
      console.error(`--- raw TCP connect to 127.0.0.1:${PORT}: ${tcp} ---`);
    } catch (err) { console.error(`--- raw TCP probe failed: ${err?.message || err} ---`); }
  }
  ok(up, `server booted${up ? "" : ` on :${PORT}`}`);
  if (!up) {
    console.error(`--- server never answered /health on :${PORT} (${exited || "still running"}) ---`);
    console.error(childLog.slice(-3000) || "(child produced no output)");
    return done(1);
  }

  // A402-13: no X-Powered-By on any response.
  const home = await fetch(`${base}/`);
  ok(!home.headers.get("x-powered-by"), "no X-Powered-By header (fingerprint disabled)");

  // A402-13: RFC 9116 security.txt.
  const sec = await fetch(`${base}/.well-known/security.txt`);
  ok(sec.status === 200, `security.txt → 200 (got ${sec.status})`);
  ok((sec.headers.get("content-type") || "").includes("text/plain"), "security.txt is text/plain");
  const txt = await sec.text();
  ok(/^Contact:\s*mailto:.+@.+/m.test(txt), "security.txt has a Contact: mailto: line");
  ok(/^Expires:\s*\d{4}-\d{2}-\d{2}T/m.test(txt), "security.txt has an Expires: date");
  // Expires must be in the future (RFC 9116).
  const exp = (txt.match(/^Expires:\s*(.+)$/m) || [])[1];
  ok(exp && new Date(exp).getTime() > Date.now(), "security.txt Expires is in the future");

  // A402-11: public /health hides internal wiring.
  const health = await (await fetch(`${base}/health`)).json();
  ok(health.ok === true, "public /health still reports ok");
  ok(!("flags" in health) && !("checks" in health), "public /health hides flags+checks");
  // R-15: public /health carries only toolCount — not process uptime or freeMode.
  ok(health.meta && typeof health.meta.toolCount === "number", "public /health keeps meta.toolCount (sync-count reads it)");
  ok(!("uptime" in (health.meta || {})) && !("freeMode" in (health.meta || {})), "public /health hides uptime + freeMode (operator-only diagnostics)");

  // A402-12: /mcp CORS is wildcard but credential-free.
  const mcp = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  ok(mcp.headers.get("access-control-allow-origin") === "*", "/mcp CORS allows any origin (public connector)");
  ok(!mcp.headers.get("access-control-allow-credentials"), "/mcp never sets Allow-Credentials (credential-free wildcard)");

  // F20: operator responses forbid caching (PII/revenue/session).
  const opLogin = await fetch(`${base}/__operator/login`);
  const cc = (opLogin.headers.get("cache-control") || "").toLowerCase();
  ok(cc.includes("no-store") && cc.includes("private"), `operator response is no-store, private (got "${cc}")`);
  ok((opLogin.headers.get("vary") || "").toLowerCase().includes("cookie"), "operator response Vary includes Cookie");

  // F10: the waitlist page never builds a GitHub issue URL with lead PII.
  const wl = await (await fetch(`${base}/tollbooth/waitlist`)).text();
  ok(!/issues\/new/.test(wl) && !/window\.open/.test(wl), "waitlist page has no GitHub issue-URL / window.open PII fallback");

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
