// Operator auth regression (security audit A402-07). The operator dashboard must
// NEVER authenticate from a ?token= query string (it leaks into access logs,
// history, and Referer). Auth is a POST-login session cookie (Secure/HttpOnly/
// SameSite=Strict) or a header for curl/API. Boots the real server (the only
// faithful way to test the route wiring) with a known token.
import { spawn } from "node:child_process";
import { getFreePort } from "./lib/free-port.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = "operator-test-secret-123";
const PORT = await getFreePort();
const base = `http://127.0.0.1:${PORT}`;

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
  // 60 s, like the other booted-server tests (test-pricing-margin: 120 x 500 ms).
  // The old 80 x 250 ms = 20 s bound failed CI run 33093827741 with the server
  // already at "listening": the documented post-listen boot stall (per-route
  // Ajv compile) on a loaded runner outlived it. Nothing was broken; the bound
  // was the tightest in the suite.
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { up = true; break; } } catch { /* */ }
    await wait(500);
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

  // 5b. Credential guessing on the ELEVATION path is bounded.
  //
  // These routes accept the same credentials without going through the login
  // form, so the login limiter never sees them. The first attempt at this
  // shipped as a no-op: it recorded failures into a bucket and then returned
  // false regardless, which is indistinguishable from having no limiter. The
  // only observable proof that a bound exists is that guessing eventually stops
  // the gate from EVALUATING at all - so that is what these assert, and it is
  // why a burst must end with the CORRECT token being refused.
  const bearer = { authorization: `Bearer ${TOKEN}` };

  // A correct credential must never be throttled. Well past the 10/min budget:
  // if success consumed budget, the operator would lock themselves out of their
  // own dashboard just by using it.
  let goodAllOk = true;
  for (let i = 0; i < 15; i++) if ((await status("/__operator", { headers: bearer })) !== 200) goodAllOk = false;
  ok(goodAllOk, "a correct token is never throttled (15 straight requests all authenticate)");

  // Anonymous traffic must never reach the limiter. /api/leaderboard is a PUBLIC
  // route carrying an operator branch - throttling it would throttle ordinary
  // agent traffic, which is the opposite of what this service is for.
  let anonAllOk = true;
  for (let i = 0; i < 15; i++) if ((await status("/api/leaderboard")) !== 200) anonAllOk = false;
  ok(anonAllOk, "anonymous traffic on a public route with an operator branch is never limited");

  // Now guess. After the budget is gone the gate must refuse the correct token,
  // because it is no longer looking at credentials at all.
  let lockedOut = false;
  for (let i = 0; i < 40; i++) {
    await status("/__operator", { headers: { authorization: `Bearer wrong-guess-${i}` } });
    if ((await status("/__operator", { headers: bearer })) === 404) { lockedOut = true; break; }
  }
  ok(lockedOut, "guessing exhausts the budget and the gate stops evaluating — even a correct token is refused");
  ok((await status("/api/leaderboard")) === 200, "a locked-out IP still gets the PUBLIC view (fail closed, stay usable)");

  // ...and a real login is the way back in, or a stale cookie could lock the
  // operator out permanently.
  const reLogin = await fetch(`${base}/__operator/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }),
  });
  ok(reLogin.status === 200, "a correct login still succeeds while the elevation budget is exhausted");
  ok((await status("/__operator", { headers: bearer })) === 200, "a successful login clears the lockout");

  // 6. Login is rate-limited (audit R-12): a burst of attempts from one IP 429s.
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const s = await status("/__operator/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
    if (s === 429) { saw429 = true; break; }
  }
  ok(saw429, "login is rate-limited — a burst of attempts eventually 429s");

  // 6b. The two operator diagnostics that fan out to THIRD PARTIES are rate-
  //     limited, not merely authenticated. Auth bounds who can call them; it
  //     does not bound how often, and both fire live RPC / on-chain reads.
  //     CodeQL js/missing-rate-limiting flagged ledger-sync.json (alert #81);
  //     discovery-gap.json has the identical shape and was not flagged, so it
  //     is asserted here too - the scanner finds instances, and the defect is
  //     the class.
  for (const route of ["/__operator/ledger-sync.json", "/__operator/discovery-gap.json"]) {
    const first = await status(route, { headers: bearer });
    ok(first === 200 || first === 429,
      `${route} answers an authed operator (got ${first})`);
    let limited = false;
    for (let i = 0; i < 45; i++) {
      if ((await status(route, { headers: bearer })) === 429) { limited = true; break; }
    }
    ok(limited, `${route} 429s a burst - a cache bounds the UPSTREAM, this bounds the CALLER`);
  }
  // The bound must not have leaked onto the cheap operator pages: locking an
  // operator out of their own dashboard during an incident would be worse than
  // the abuse it prevents.
  ok((await status("/__operator/stats", { headers: bearer })) === 200,
    "the heavy-route limiter does not spill onto the cheap operator endpoints");

  // 7. No token ever appeared in a request-line the server logged.
  ok(!serverLog.includes(TOKEN), "the operator token never appears in server logs");

  // Aggregate guessing alarm (2026-08-28): wrong credentials are counted
  // globally and exposed as a status word on the public gateway-status.
  {
    for (let i = 0; i < 3; i++) await status("/__operator/stats", { headers: { Authorization: "Bearer not-the-token-" + i } });
    const gs = await (await fetch(`${base}/api/gateway-status`)).json();
    ok(gs.operatorAuth && typeof gs.operatorAuth.failures1h === "number" && gs.operatorAuth.failures1h >= 3 && gs.operatorAuth.status === "ok" && gs.operatorAuth.threshold >= 10,
      `wrong operator credentials are counted on /api/gateway-status (${gs.operatorAuth?.failures1h} in the hour, status ${gs.operatorAuth?.status})`);
    ok(!JSON.stringify(gs.operatorAuth).includes(TOKEN) && !/not-the-token/.test(JSON.stringify(gs.operatorAuth)), "the status carries counts only, never a credential");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  done(fail ? 1 : 0);
})().catch((e) => { console.error(e); done(1); });
