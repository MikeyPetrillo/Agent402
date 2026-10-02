// Tempo relay verdicts must be VISIBLE (src/mpp-tempo.js relayFetch).
//
// mppx's Relay.js discards the whole response body whenever Tempo's relay
// answers non-2xx (`if (!response.ok) throw failure();` — argument-less), and
// Tempo's relay puts its actual verdict there: `{"error":{"code":
// "api_key_invalid",...}}` on 401, "does not grant MPP relay access" on 403,
// a validation error on 400 (measured live 2026-08-18). Through three straight
// live rejections our log said only "Payment verification failed.
// details=(none)" — indistinguishable from a bad credential, a dead relay, or
// a mis-scoped key, which need three different fixes. This drives the REAL
// mppx relay path (no stubbed validate/broadcast) against a local stub relay
// that answers non-2xx with a structured body and asserts the status AND body
// reach the error string, on validate and on broadcast, and that two
// concurrent requests each see their own verdict (AsyncLocalStorage, not a
// module-level "last error"). Mutation-checked: dropping `fetch: relayFetch`
// from the relay config fails at the first path/status assertion (the error
// degrades to "no relay verdict"), so a silent regression cannot pass.
import { createServer } from "node:http";
import { Challenge, Credential } from "mppx";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Stub relay: every call answers 403 with Tempo's structured error shape and
// echoes a per-request marker so concurrent traces can be told apart.
let hits = 0;
let mode = "403"; // flipped to "200-rejected" for the second scenario
const relay = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits++;
    let realm = "?";
    try { realm = JSON.parse(body).challenge.realm; } catch { /* leave ? */ }
    if (mode === "200-rejected") {
      // The EXACT live shape measured 2026-08-18: HTTP 200, success:false,
      // code "unknown" (outside mppx's details allowlist), reason in message.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unknown", message: `Payment verification failed: Invalid transaction: no matching payment call found (realm ${realm})` }, success: false }));
      return;
    }
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "api_key_scope_missing", message: `The API key does not grant MPP relay access (realm ${realm})` }, requestId: `r-${hits}` }));
  });
});
await new Promise((r) => relay.listen(0, r));

process.env.TEMPO_API_BASE_URL = `http://127.0.0.1:${relay.address().port}`;
process.env.TEMPO_API_KEY = "test-key";
process.env.WALLET_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const { validateTempoCredential, broadcastTempoCredential, tempoEnabled } = await import("../src/mpp-tempo.js");
ok(tempoEnabled(), "tempo enabled for the test (key + recipient set)");

function credentialFor(realm) {
  const challenge = Challenge.from({
    realm, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
    request: { amount: "1000", currency: "0x20c0000000000000000000000000000000000000", decimals: 6, recipient: process.env.WALLET_ADDRESS },
    secretKey: "test-secret",
  });
  return Credential.serialize({ challenge, payload: { hash: `0x${"ab".repeat(32)}`, type: "hash" } });
}

// Two concurrent validations + one broadcast, each with a distinct realm so
// the relay's echoed verdict identifies WHICH request it belongs to.
const [a, b, c] = await Promise.all([
  validateTempoCredential(credentialFor("alpha.test")),
  validateTempoCredential(credentialFor("beta.test")),
  broadcastTempoCredential(credentialFor("gamma.test")),
]);
ok(hits >= 3, `stub relay was actually hit (${hits} calls) — the real mppx relay path ran, nothing was stubbed in-process`);
for (const [name, r] of [["validate a", a], ["validate b", b], ["broadcast c", c]]) {
  ok(!r.ok, `${name}: rejected (relay said 403)`);
  ok(/relay \/v1\/mpp\/(validate|broadcast) HTTP 403 /.test(r.error), `${name}: error names the relay path + HTTP status (got: ${r.error.slice(0, 120)})`);
  ok(/api_key_scope_missing/.test(r.error), `${name}: the relay's structured error code survives into the log line`);
}
ok(/realm alpha\.test/.test(a.error) && /realm beta\.test/.test(b.error) && /realm gamma\.test/.test(c.error), "concurrent requests each carry THEIR OWN relay verdict (no cross-request bleed)");
ok(!/details=\(none/.test(a.error), "the old blind 'details=(none)' wording is gone when a relay verdict exists");

// Scenario 2: HTTP 200 + success:false + an error code OUTSIDE mppx's
// allowlist. mppx surfaces NO details for this (safeDetails("unknown") is
// undefined) and never the message — the live relay's real reason lived only
// there, through four straight rejections.
mode = "200-rejected";
const d = await validateTempoCredential(credentialFor("delta.test"));
relay.close();
ok(!d.ok, "200-rejected: still rejected (mppx sees success:false)");
ok(/relay \/v1\/mpp\/validate HTTP 200 /.test(d.error), `200-rejected: a 2xx success:false body is captured too (got: ${d.error.slice(0, 100)})`);
ok(/no matching payment call found \(realm delta\.test\)/.test(d.error), "200-rejected: the relay's human-readable reason (message) survives — the field mppx drops");

// Scenario 3: the relay never answers — it accepts the connection and then
// destroys the socket (what a relay-side deadline looks like from here).
// mppx throws the same bare failure(); the log must say NETWORK ERROR with
// elapsed time, not "no relay verdict" as if nothing was ever attempted.
// Measured live 2026-08-18: a 21,816ms broadcast that ended this way.
const dead = createServer((req) => { req.on("data", () => {}); req.on("end", () => setTimeout(() => req.socket.destroy(), 30)); });
await new Promise((r) => dead.listen(0, r));
process.env.TEMPO_API_BASE_URL = `http://127.0.0.1:${dead.address().port}`;
const { __testResetMethodCache } = await import("../src/mpp-tempo.js");
__testResetMethodCache();
const e = await validateTempoCredential(credentialFor("epsilon.test"));
dead.close();
ok(!e.ok, "socket-destroyed: rejected");
ok(/relay \/v1\/mpp\/validate NETWORK ERROR after \d+ms/.test(e.error), `socket-destroyed: the failure is labelled a NETWORK ERROR with elapsed ms, not a missing verdict (got: ${e.error.slice(0, 120)})`);

// Scenario 4: bounded retry (2026-09-24). VALIDATE is non-mutating, so a
// dropped connection or a 503 is retried and the second answer wins.
{
  let calls = 0;
  const flaky = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      if (calls === 1) return req.socket.destroy();                       // first: dropped
      if (calls === 2) { res.writeHead(503); return res.end("busy"); }   // second: busy
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((r) => flaky.listen(0, r));
  process.env.TEMPO_API_BASE_URL = `http://127.0.0.1:${flaky.address().port}`;
  process.env.TEMPO_RELAY_VALIDATE_ATTEMPTS = "3";
  __testResetMethodCache();
  const v = await validateTempoCredential(credentialFor("zeta.test"));
  ok(calls === 3, `validate: a dropped connection and a 503 are retried (relay saw ${calls} calls)`);
  ok(!/NETWORK ERROR/.test(String(v.error || "")), "validate: the final answer is the relay's, not the transient failure");
  // Every attempt fails at the transport: bounded, then classified unreachable.
  calls = 0;
  const allDead = createServer((req) => { req.on("data", () => {}); req.on("end", () => { calls++; req.socket.destroy(); }); });
  await new Promise((r) => allDead.listen(0, r));
  process.env.TEMPO_API_BASE_URL = `http://127.0.0.1:${allDead.address().port}`;
  process.env.TEMPO_RELAY_VALIDATE_ATTEMPTS = "2";
  __testResetMethodCache();
  const dead2 = await validateTempoCredential(credentialFor("eta.test"));
  ok(calls === 2 && !dead2.ok && dead2.cls === "relay-unreachable" && /attempts 2/.test(dead2.error), `validate: bounded at 2 attempts, then relay-unreachable (calls ${calls}, cls ${dead2.cls})`);

  // BROADCAST moves money: a failure AFTER the bytes were sent is NEVER retried.
  // (mppx's broadcastCredential re-validates first, so the stub answers
  // validate and drops only the broadcast.)
  let broadcasts = 0;
  const dropBroadcast = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.url.endsWith("/validate")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ success: true })); }
      broadcasts++; req.socket.destroy();
    });
  });
  await new Promise((r) => dropBroadcast.listen(0, r));
  process.env.TEMPO_API_BASE_URL = `http://127.0.0.1:${dropBroadcast.address().port}`;
  __testResetMethodCache();
  const b1 = await broadcastTempoCredential(credentialFor("theta.test"));
  ok(broadcasts === 1 && !b1.ok, `broadcast: a connection dropped after the request was sent is not retried (relay saw ${broadcasts} broadcast)`);
  allDead.close(); flaky.close(); dropBroadcast.close();

  // ...but a connect-phase failure (nothing reached the relay) is retried once.
  const closedPort = await new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const { __testRelayFetch } = await import("../src/mpp-tempo.js");
  const b2 = await __testRelayFetch(`http://127.0.0.1:${closedPort}/v1/mpp/broadcast`, { method: "POST", body: "{}" });
  ok(b2.error && b2.trace.relayAttempts === 2 && b2.trace.connectPhase === true && /\/v1\/mpp\/broadcast NETWORK ERROR .*ECONNREFUSED \(attempts 2\)/.test(b2.trace.relayError), `broadcast: a refused connection (request never sent) is retried once (${b2.trace.relayError})`);
  const { isConnectPhaseError } = await import("../src/mpp-tempo.js");
  ok(isConnectPhaseError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }) && !isConnectPhaseError({ cause: { code: "UND_ERR_SOCKET" } }) && !isConnectPhaseError({ name: "TimeoutError" }), "connect-phase codes are the only broadcast retry trigger");
  delete process.env.TEMPO_RELAY_VALIDATE_ATTEMPTS;
}

console.log(`\nAll ${pass} assertions passed`);
process.exit(0);
