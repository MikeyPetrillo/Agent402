// Operator auth regression (security audit A402-07). The operator dashboard must
// NEVER authenticate from a ?token= query string (it leaks into access logs,
// history, and Referer). Auth is a POST-login session cookie (Secure/HttpOnly/
// SameSite=Strict) or a header for curl/API. Boots the real server (the only
// faithful way to test the route wiring) with a known token.
import { spawn } from "node:child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = "operator-test-secret-123";
const PORT = 3480 + (process.pid % 400);
const base = `http://localhost:${PORT}`;

const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), AGENT402_OPERATOR_TOKEN: TOKEN },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += d; });
child.stderr.on("data", (d) => { serverLog += d; });

const done = (code) => { try { child.kill("SIGKILL"); } catch { /* */ } process.exit(code); };

(async () => {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* */ }
    await wait(250);
  }
  ok(up, "server booted");
  if (!up) { console.error(serverLog.slice(-500)); return done(1); }

  const status = async (path, opts) => (await fetch(`${base}${path}`, { redirect: "manual", ...opts })).status;

  // 1. The core fix: a ?token= query must NOT authenticate.
  ok((await status(`/__operator?token=${TOKEN}`)) === 404, "?token= query is ignored (404) — the A402-07 fix");
  ok((await status(`/__operator/wishes?token=${TOKEN}`)) === 404, "?token= ignored on sub-pages too");

  // 2. Unauthenticated dashboard is hidden (404), but the login form is reachable.
  ok((await status("/__operator")) === 404, "no auth → 404 (dashboard hidden)");
  ok((await status("/__operator/login")) === 200, "login form is reachable");

  // 3. POST login: wrong token rejected, correct token sets a hardened cookie.
  ok((await status("/__operator/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) })) === 401, "wrong token → 401");
  const loginRes = await fetch(`${base}/__operator/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  ok(loginRes.status === 200, "correct token → 200");
  const setCookie = loginRes.headers.get("set-cookie") || "";
  ok(/a402_op=/.test(setCookie), "login sets the a402_op cookie");
  ok(/HttpOnly/i.test(setCookie), "cookie is HttpOnly (no JS/XSS read)");
  ok(/SameSite=Strict/i.test(setCookie), "cookie is SameSite=Strict (CSRF-safe)");
  ok(/Max-Age=/i.test(setCookie), "cookie has an expiry");
  // R-12 core fix: the cookie carries an OPAQUE session id, never the root token.
  ok(!setCookie.includes(TOKEN), "cookie is an opaque session id, NOT the root token (R-12)");

  // 4. The cookie authenticates the dashboard; so does a header (curl/API path).
  const cookie = setCookie.split(";")[0];
  ok((await status("/__operator", { headers: { cookie } })) === 200, "session cookie authenticates the dashboard");
  ok((await status("/__operator/wishes", { headers: { cookie } })) === 200, "session cookie authenticates sub-pages");
  ok((await status("/__operator", { headers: { authorization: `Bearer ${TOKEN}` } })) === 200, "Authorization: Bearer still works (curl/API)");
  ok((await status("/__operator", { headers: { "x-operator-token": TOKEN } })) === 200, "X-Operator-Token header still works");
  // A forged/random session id must NOT authenticate.
  ok((await status("/__operator", { headers: { cookie: "a402_op=deadbeefdeadbeef" } })) === 404, "a random session id does not authenticate");

  // 5. Logout is a POST that REVOKES the session server-side (audit R-12).
  ok((await status("/__operator/logout", { method: "GET" })) === 404, "GET /__operator/logout is not a route (no GET side effect)");
  const logoutRes = await fetch(`${base}/__operator/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
  ok(/a402_op=;/.test(logoutRes.headers.get("set-cookie") || ""), "POST logout clears the cookie");
  ok(logoutRes.status === 303, "POST logout redirects (303) back to login");
  // The revoked session id must no longer authenticate — even presenting the
  // same cookie value fails (server-side revocation, not just a client clear).
  ok((await status("/__operator", { headers: { cookie } })) === 404, "the logged-out session is revoked server-side (cookie no longer works)");

  // 6. Login is rate-limited (audit R-12): a burst of attempts from one IP 429s.
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const s = await status("/__operator/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
    if (s === 429) { saw429 = true; break; }
  }
  ok(saw429, "login is rate-limited — a burst of attempts eventually 429s");

  // 7. No token ever appeared in a request-line the server logged.
  ok(!serverLog.includes(TOKEN), "the operator token never appears in server logs");

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
