// Payment-nonce replay guard (M3) — defends Attack II (replay / insufficient
// idempotency) from "Five Attacks on x402". Two layers:
//
//   A. Unit — paymentReplayKey() identity extraction + the guard state machine
//      (concurrent replay refused, sequential replay refused, release-on-failure
//      allows retry, TTL expiry, FIFO eviction).
//   B. HTTP — an Express harness mounting the EXACT guard code path the server
//      uses (begin → 409 on duplicate → settle/release on finish). Proves that
//      N concurrent identical authorizations collapse to a single grant, and
//      that a failed settle releases the nonce for a legitimate retry.
//
// Offline, no facilitator, no network.
import express from "express";
import { paymentReplayKey, createReplayGuard } from "../src/replay-guard.js";
import { __setTestClient } from "../src/shared-limit.js";

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// A fake Express req exposing .header() over a case-insensitive header bag.
function fakeReq(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (n) => lower[String(n).toLowerCase()] };
}
// Build an x402-style base64 payment credential carrying an EIP-3009 nonce.
function evmCred({ network = "eip155:8453", nonce = "0xabc", from = "0x" + "1".repeat(40) } = {}) {
  return Buffer.from(JSON.stringify({ network, payload: { authorization: { nonce, from } } })).toString("base64");
}

// ---- A1. Key extraction ------------------------------------------------------
{
  const a = paymentReplayKey(fakeReq({ "x-payment": evmCred({ nonce: "0xDEAD" }) }));
  const b = paymentReplayKey(fakeReq({ "x-payment": evmCred({ nonce: "0xdead" }) })); // case-normalized nonce
  const c = paymentReplayKey(fakeReq({ "x-payment": evmCred({ nonce: "0xBEEF" }) }));
  ok(a && a === b, "same nonce (case-insensitive) → same replay key");
  ok(a !== c, "different nonce → different replay key");

  // Re-encoded credential with a different JSON key order but the same nonce
  // still maps to one identity (nonce-scoped, not byte-scoped).
  const reordered = Buffer.from(JSON.stringify({ payload: { authorization: { from: "0x" + "1".repeat(40), nonce: "0xDEAD" } }, network: "eip155:8453" })).toString("base64");
  ok(paymentReplayKey(fakeReq({ "x-payment": reordered })) === a, "re-encoded same-nonce authorization → same key");

  // Same nonce on a different network is a distinct identity.
  const otherNet = paymentReplayKey(fakeReq({ "x-payment": evmCred({ nonce: "0xDEAD", network: "eip155:137" }) }));
  ok(otherNet !== a, "same nonce, different network → different key");

  ok(paymentReplayKey(fakeReq({})) === null, "no payment header → null (unpaid crawl not guarded)");
  ok(paymentReplayKey(fakeReq({ "x-pow-solution": "abc" })) === null, "PoW-only request → null (not guarded here)");

  // A credential we can't parse for a nonce still yields a stable raw identity.
  const opaque = Buffer.from("not json at all").toString("base64");
  const o1 = paymentReplayKey(fakeReq({ "x-payment": opaque }));
  const o2 = paymentReplayKey(fakeReq({ "x-payment": opaque }));
  ok(o1 && o1 === o2 && o1.startsWith("c:"), "unparseable credential → stable raw-hash identity");
}

// ---- A2. Guard state machine (local fallback path — no REDIS_URL in this
// process, so every call below exercises the per-process Map/Set) -----------
{
  const g = createReplayGuard();
  const k = "n:test";
  ok(await g.begin(k) === "ok", "first use → ok");
  ok(await g.begin(k) === "inflight", "concurrent duplicate (still in flight) → inflight");
  await g.settle(k);
  ok(await g.begin(k) === "consumed", "after settle, replay → consumed");
  ok(g._state().consumed === 1 && g._state().inFlight === 0, "state: 1 consumed, 0 in flight");
}
{
  const g = createReplayGuard();
  const k = "n:retry";
  ok(await g.begin(k) === "ok", "first attempt → ok");
  await g.release(k); // gated call was NOT granted (e.g. settle failed)
  ok(await g.begin(k) === "ok", "release-on-failure → same authorization may retry");
  ok(g._state().inFlight === 1 && g._state().consumed === 0, "retry is in flight, nothing consumed yet");
}
{
  // TTL expiry: a consumed nonce older than ttl is pruned, freeing the key.
  const g = createReplayGuard({ ttlMs: 1000 });
  const k = "n:ttl";
  await g.begin(k, 0);
  await g.settle(k, 0);
  ok(await g.begin(k, 500) === "consumed", "within TTL → still consumed");
  ok(await g.begin(k, 5000) === "ok", "past TTL → pruned, key reusable (safe: on-chain nonce still dead)");
}
{
  // FIFO eviction keeps memory bounded; eviction is always safe.
  const g = createReplayGuard({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) { await g.begin(`k${i}`); await g.settle(`k${i}`); }
  ok(g._state().consumed <= 3, `consumed capped at maxEntries (got ${g._state().consumed})`);
}

// ---- A3. A shared store that is configured and does not answer ---------------
// A caller that requires the shared store (the long-running and composite
// routes) is told "unavailable" and refuses; every other caller keeps the
// per-process fallback. With no shared store configured at all (one process)
// the fallback is the guarantee for both.
{
  const g = createReplayGuard();
  ok(await g.begin("n:solo", undefined, { requireShared: true }) === "ok", "no shared store configured: a route that requires it still claims locally");
  const broken = { get: async () => { throw new Error("simulated outage"); }, set: async () => { throw new Error("simulated outage"); }, del: async () => { throw new Error("simulated outage"); }, expire: async () => { throw new Error("simulated outage"); } };
  __setTestClient(broken);
  try {
    ok(await g.begin("n:slow", undefined, { requireShared: true }) === "unavailable", "store configured and failing: a route that requires it is refused");
    ok(g._state().inFlight === 1, "and the refusal claims nothing locally");
    ok(await g.begin("n:fast") === "ok", "store configured and failing: a fast route falls back to the per-process claim");
    ok(await g.begin("n:fast") === "inflight", "and the per-process claim still refuses a concurrent duplicate");
  } finally {
    __setTestClient(null);
  }
}

// ---- B. HTTP harness: the real guard code path in an Express app -------------
// Replicates server.js's wrapping of the paywall: begin → 409 on duplicate →
// settle/release on finish. The stub "paywall" stands in for x402mw.
function buildApp({ grant }) {
  const app = express();
  const guard = createReplayGuard();
  let handlerCalls = 0;
  app.use(async (req, res, next) => {
    const key = paymentReplayKey(req);
    if (key) {
      const verdict = await guard.begin(key);
      if (verdict !== "ok") {
        res.setHeader("X-Payment-Replay", verdict);
        return res.status(409).json({ error: "replay", reason: verdict });
      }
      let resolved = false;
      const fin = () => { if (resolved) return; resolved = true; if (res.statusCode === 200) guard.settle(key).catch(() => {}); else guard.release(key).catch(() => {}); };
      res.on("finish", fin);
      res.on("close", fin);
    }
    next();
  });
  // Stub paywall: async so concurrent requests interleave at the guard. Grants
  // (200) or rejects settlement (402) per the harness config.
  app.use(async (req, res) => {
    handlerCalls++;
    await new Promise((r) => setTimeout(r, 120));
    if (grant) res.status(200).json({ ok: true });
    else res.status(402).json({ error: "settle failed" });
  });
  return { app, stats: () => ({ handlerCalls }) };
}

function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

try {
  // B1. Concurrent replay: 8 identical authorizations at once → exactly 1 grant,
  // 7 refused. This is the paper's duplicate-grant window, held to DGR = 1.
  {
    const { app, stats } = buildApp({ grant: true });
    const srv = await listen(app);
    const port = srv.address().port;
    const cred = evmCred({ nonce: "0xC0NCURRENT" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`http://127.0.0.1:${port}/api/hash`, { method: "POST", headers: { "x-payment": cred } }).then((r) => r.status)
      )
    );
    const granted = results.filter((s) => s === 200).length;
    const refused = results.filter((s) => s === 409).length;
    ok(granted === 1, `concurrent replay: exactly 1 grant (got ${granted})`);
    ok(refused === 7, `concurrent replay: 7 refused with 409 (got ${refused})`);
    ok(stats().handlerCalls === 1, `paywall/facilitator invoked once, not 8× (got ${stats().handlerCalls})`);

    // A brand-new authorization still works after the storm.
    const fresh = await fetch(`http://127.0.0.1:${port}/api/hash`, { method: "POST", headers: { "x-payment": evmCred({ nonce: "0xFRESH" }) } });
    ok(fresh.status === 200, `fresh nonce still granted (got ${fresh.status})`);

    // Replaying the already-settled nonce is now refused outright.
    const replay = await fetch(`http://127.0.0.1:${port}/api/hash`, { method: "POST", headers: { "x-payment": cred } });
    ok(replay.status === 409, `settled nonce replay refused (got ${replay.status})`);
    ok(replay.headers.get("x-payment-replay") === "consumed", "replay marked consumed");
    srv.close();
  }

  // B2. Release-on-failure: a settle that fails (402) must NOT burn the nonce —
  // two sequential attempts with the same authorization both reach the paywall.
  {
    const { app, stats } = buildApp({ grant: false });
    const srv = await listen(app);
    const port = srv.address().port;
    const cred = evmCred({ nonce: "0xRETRYABLE" });
    const r1 = await fetch(`http://127.0.0.1:${port}/api/hash`, { method: "POST", headers: { "x-payment": cred } });
    const r2 = await fetch(`http://127.0.0.1:${port}/api/hash`, { method: "POST", headers: { "x-payment": cred } });
    ok(r1.status === 402 && r2.status === 402, `both attempts reach the paywall (got ${r1.status}, ${r2.status})`);
    ok(stats().handlerCalls === 2, `failed settle released the nonce — paywall invoked twice (got ${stats().handlerCalls})`);
    srv.close();
  }
} catch (e) {
  ok(false, `HTTP harness threw: ${e.message}`);
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
