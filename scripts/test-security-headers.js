// Exposure-hardening regression (security audit A402-11/12/13). Boots a real
// server and asserts: the Express fingerprint header is gone, a valid RFC 9116
// security.txt is served, /health hides its internal wiring from the public,
// and the /mcp CORS stays wildcard-but-credential-free.
import { spawn } from "node:child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 3520 + (process.pid % 300);
const base = `http://localhost:${PORT}`;
const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});
const done = (code) => { try { child.kill("SIGKILL"); } catch { /* */ } process.exit(code); };

(async () => {
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* */ } await wait(250); }
  ok(up, "server booted");
  if (!up) return done(1);

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

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
