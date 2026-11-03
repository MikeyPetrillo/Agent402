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
// Offline, no facilitator, no network. The per-process sections pin that
// path: a REDIS_URL in the caller's environment would send every call to a
// shared Redis whose keys outlive the run (a fixed key here is "consumed" on
// the next run) and whose state _state() does not show. The real-Redis
// behavior has its own suite (scripts/test-replay-guard-redis.js); the
// Redis code path here runs against an in-memory client (section A4).
import express from "express";
delete process.env.REDIS_URL;
const { paymentReplayKey, paymentValidBeforeMs, createReplayGuard, CONSUMED_VALIDITY_MARGIN_MS } = await import("../src/replay-guard.js");
const { __setTestClient } = await import("../src/shared-limit.js");

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
{
  // The identity is the nonce scoped to its network AND its signed payer: the
  // chain consumes a nonce per (token, from), so two wallets that sign the
  // same nonce are two payments.
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
  const ka = paymentReplayKey(fakeReq({ "x-payment": evmCred({ nonce: "0x77", from: A }) }));
  const kb = paymentReplayKey(fakeReq({ "x-payment": evmCred({ nonce: "0x77", from: B }) }));
  ok(ka && kb && ka !== kb, "same nonce, different payer → different key");
  const kA = paymentReplayKey(fakeReq({ "x-payment": evmCred({ nonce: "0x77", from: "0x" + "A".repeat(40) }) }));
  ok(kA === ka, "an EVM payer is case-folded (checksummed and lowercase spell one wallet)");
  // A non-EVM payer string is kept as signed: base58 is case-sensitive.
  const b58 = (from) => Buffer.from(JSON.stringify({ network: "solana:x", payload: { authorization: { nonce: "0x77", from } } })).toString("base64");
  ok(paymentReplayKey(fakeReq({ "x-payment": b58("AbCdEf") })) !== paymentReplayKey(fakeReq({ "x-payment": b58("abcdef") })), "a base58 payer is never case-folded");
  // v2 carries the network on `accepted`: two networks are two identities there too.
  const v2 = (network) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network }, payload: { authorization: { nonce: "0x77", from: A } } })).toString("base64");
  ok(paymentReplayKey(fakeReq({ "x-payment": v2("eip155:8453") })) !== paymentReplayKey(fakeReq({ "x-payment": v2("eip155:137") })), "v2: same nonce and payer, different network → different key");
  ok(/^n2:[0-9a-f]{64}:[0-9a-f]{64}$/.test(ka), "a nonce key carries the earlier build's key for the deploy window");
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

// ---- A3b. The store fails AFTER the claim landed ------------------------------
// A command that throws once the SET NX has claimed the key must not leave
// that claim behind: the buyer's retry of the same unused authorization would
// otherwise read "inflight" for the claim's whole life.
{
  const g = createReplayGuard();
  const store = new Map();
  let failOnce = false;
  const flaky = {
    isReady: true,
    get: async (k) => { if (failOnce && [...store.keys()].some((x) => x.includes(":f:"))) { failOnce = false; throw new Error("READONLY"); } return store.has(k) ? store.get(k) : null; },
    set: async (k, v, o = {}) => { if (o.NX && store.has(k)) return null; store.set(k, v); return "OK"; },
    del: async (k) => (store.delete(k) ? 1 : 0),
    expire: async () => 1,
  };
  __setTestClient(flaky);
  try {
    failOnce = true;
    ok(await g.begin("n2:partial", undefined, { requireShared: true }) === "unavailable", "a store error after the claim refuses the call");
    ok(![...store.keys()].some((k) => k.includes(":f:")), `and drops the claim it took (left: ${[...store.keys()].join(",") || "none"})`);
    ok(await g.begin("n2:partial", undefined, { requireShared: true }) === "ok", "so the buyer's retry of the same authorization is claimed, not refused as in flight");
    await g.release?.("n2:partial");
  } finally {
    __setTestClient(null);
  }
}

// ---- A4. The Redis code path against an in-memory client ---------------------
// A minimal client with the commands the guard sends (GET, SET NX/EX, DEL,
// EXPIRE) and a hook that runs between two commands, so an interleaving that
// a real Redis allows can be placed exactly.
function memoryRedis() {
  const kv = new Map(); // key -> { v, exp (ms) }
  const live = (k) => { const e = kv.get(k); if (e && e.exp && e.exp <= Date.now()) { kv.delete(k); return null; } return e || null; };
  const c = {
    kv, between: null, sets: [],
    afterGet: null,
    async get(k) { const v = live(k)?.v ?? null; if (c.afterGet) { const f = c.afterGet; c.afterGet = null; await f(); } return v; },
    async set(k, v, o = {}) {
      if (o.NX && live(k)) return null;
      kv.set(k, { v, exp: o.EX ? Date.now() + o.EX * 1000 : 0 });
      c.sets.push({ k, ex: o.EX });
      if (c.between) { const f = c.between; c.between = null; await f(); }
      return "OK";
    },
    async del(k) {
      const had = kv.delete(k);
      if (c.between) { const f = c.between; c.between = null; await f(); }
      return had ? 1 : 0;
    },
    async expire(k, sec) { const e = live(k); if (!e) return 0; e.exp = Date.now() + sec * 1000; return 1; },
  };
  return c;
}
{
  // A re-send racing the first request's settle: with the consumed mark
  // written before the claim is dropped, the racing begin() reads either the
  // claim ("inflight") or the mark ("consumed"), never neither. The hook runs
  // the racing begin() right after settle's first write lands, whichever
  // command that is.
  const mem = memoryRedis();
  __setTestClient(mem);
  try {
    const g1 = createReplayGuard(), g2 = createReplayGuard();
    const k = "n:race";
    ok(await g1.begin(k) === "ok", "redis path: replica 1 claims the nonce");
    let raced = null;
    mem.between = async () => { raced = await g2.begin(k); };
    await g1.settle(k);
    ok(raced === "inflight" || raced === "consumed", `redis path: a begin() between settle's two writes is refused (got ${raced})`);
    ok(await g2.begin(k) === "consumed", "redis path: after settle the nonce reads consumed");
  } finally { __setTestClient(null); }
}
{
  // The consumed mark of a granted payment is held until its authorization
  // expires (plus a margin) when that is later than the guard's TTL: a
  // forgiven hang-up is granted without being settled, so the chain would
  // still accept the authorization.
  const mem = memoryRedis();
  __setTestClient(mem);
  try {
    const g = createReplayGuard({ ttlMs: 60 * 60 * 1000 });
    const now = Date.now();
    await g.begin("n:long");
    await g.settle("n:long", now, { validBeforeMs: now + 3 * 3600_000 });
    const ex = mem.sets.find((x) => x.k === "replay:c:n:long")?.ex;
    ok(ex >= Math.floor((3 * 3600_000 + CONSUMED_VALIDITY_MARGIN_MS) / 1000) - 1, `redis path: a 3 h authorization keeps its consumed mark past its validBefore (EX ${ex} s)`);
    await g.begin("n:short");
    await g.settle("n:short", now, { validBeforeMs: now + 300_000 });
    ok(mem.sets.find((x) => x.k === "replay:c:n:short")?.ex === 3600, "redis path: a 300 s authorization keeps the guard's 1 h TTL (the longer of the two)");
  } finally { __setTestClient(null); }
}
{
  // The same on the per-process path, with an injected clock.
  const g = createReplayGuard({ ttlMs: 1000 });
  await g.begin("n:held", 0);
  await g.settle("n:held", 0, { validBeforeMs: 10_000 });
  ok(await g.begin("n:held", 5_000) === "consumed", "local path: past the TTL but before validBefore the mark holds");
  ok(await g.begin("n:held", 10_000 + CONSUMED_VALIDITY_MARGIN_MS - 1) === "consumed", "local path: and through the margin after validBefore");
  const g2 = createReplayGuard({ ttlMs: 1000 });
  await g2.begin("n:held", 0);
  await g2.settle("n:held", 0, { validBeforeMs: 10_000 });
  ok(await g2.begin("n:held", 10_000 + CONSUMED_VALIDITY_MARGIN_MS + 1) === "ok", "local path: past validBefore plus the margin the key is free (the chain refuses it now)");
  // An entry held long at the head does not keep a shorter one behind it alive.
  const g3 = createReplayGuard({ ttlMs: 1000 });
  await g3.begin("n:a", 0); await g3.settle("n:a", 0, { validBeforeMs: 1e9 });
  await g3.begin("n:b", 0); await g3.settle("n:b", 0);
  ok(await g3.begin("n:b", 2_000) === "ok" && await g3.begin("n:a", 2_000) === "consumed", "local path: each entry expires on its own time");
}
{
  const cred = (auth) => fakeReq({ "payment-signature": Buffer.from(JSON.stringify({ payload: { authorization: auth } })).toString("base64") });
  ok(paymentValidBeforeMs(cred({ nonce: "0x1", validBefore: "1900000000" })) === 1_900_000_000_000, "paymentValidBeforeMs reads the signed validBefore (seconds) as ms");
  ok(paymentValidBeforeMs(cred({ nonce: "0x1" })) === null && paymentValidBeforeMs(cred({ nonce: "0x1", validBefore: "-5" })) === null && paymentValidBeforeMs(cred({ nonce: "0x1", validBefore: "1e9" })) === null, "no or malformed validBefore -> null (the guard's TTL applies)");
  ok(paymentValidBeforeMs(fakeReq({})) === null, "no payment header -> null");
  const far = paymentValidBeforeMs(cred({ nonce: "0x1", validBefore: "99999999999999999999" }));
  ok(Number.isFinite(far) && far > Date.now() + 50 * 365 * 24 * 3600_000, "an absurd validBefore is held for a century, never Infinity");
}

{
  // The x402 call site passes the authorization's validBefore and requires
  // the shared claim on every paid route (the booted two-container case is
  // scripts/test-replay-store-outage.js).
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(server.includes("replayGuard.settle(replayKey, undefined, { validBeforeMs: paymentValidBeforeMs(req) })"), "server.js holds a granted x402 payment's consumed mark until its validBefore");
  ok(/requireShared: sharedClaimRequired\(\{ longRunning: !!replayDef && isLongRunningSlug\(replayDef\.slug\), draining: drainSignal\(\)\.aborted \}\)/.test(server), "server.js requires the shared claim on a long-running route and whenever another container may serve (src/replay-topology.js)");
}

// ---- A5. Payer- and network-scoped keys on the Redis path, and the deploy
// window: an earlier build keyed on the nonce alone ("n:" + sha256 of
// "<v1 network>:<nonce>") and wrote a bare timestamp there.
{
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
  const keyOf = (o) => paymentReplayKey(fakeReq({ "x-payment": evmCred(o) }));
  const legacyName = (k) => "n:" + k.split(":")[2];
  const mem = memoryRedis();
  __setTestClient(mem);
  try {
    const g1 = createReplayGuard(), g2 = createReplayGuard();
    const ka = keyOf({ nonce: "0x51", from: A }), kb = keyOf({ nonce: "0x51", from: B });
    ok(await g1.begin(ka) === "ok", "redis path: payer A claims nonce 0x51");
    ok(await g2.begin(kb) === "ok", "redis path: payer B signing the same nonce is accepted while A is in flight");
    ok(await g2.begin(ka) === "inflight", "redis path: payer A's same nonce on another replica is refused (inflight)");
    await g1.settle(ka);
    await g2.settle(kb);
    ok(await g2.begin(ka) === "consumed", "redis path: payer A's same nonce after settle is refused (consumed)");
    ok(await g1.begin(kb) === "consumed", "redis path: payer B's same nonce after settle is refused (consumed)");
    const kc = keyOf({ nonce: "0x52", from: A }), kd = keyOf({ nonce: "0x52", from: A, network: "eip155:137" });
    ok(await g1.begin(kc) === "ok" && await g2.begin(kd) === "ok", "redis path: same payer and nonce on two networks are both accepted");
    await g1.release(kc); await g2.release(kd);
    const kc2 = keyOf({ nonce: "0x53", from: A });
    ok(await g1.begin(kc2) === "ok", "redis path: a fresh nonce claims");
    await g1.settle(kc2);
    ok(await g1.begin(keyOf({ nonce: "0x53", from: B })) === "ok", "redis path: another payer's same nonce is accepted after the first one settled");

    // A settle that completes between a begin()'s consumed read and its claim:
    // the claim succeeds (the settle dropped its own), and the consumed mark
    // read again under the claim refuses the re-send.
    const kr = keyOf({ nonce: "0x5f", from: A });
    ok(await g1.begin(kr) === "ok", "redis path: replica 1 claims a payment");
    mem.afterGet = async () => { await g1.settle(kr); };
    ok(await g2.begin(kr) === "consumed", "redis path: a settle that lands between a re-send's read and its claim is still seen (consumed)");

    // Deploy window, earlier build first: its claim and its consumed mark
    // (bare timestamps at the legacy name) are honored for the same credential.
    const ke = keyOf({ nonce: "0x61", from: A });
    await mem.set("replay:f:" + legacyName(ke), String(Date.now()), { NX: true, EX: 120 });
    ok(await g1.begin(ke) === "inflight", "deploy window: a payment an earlier build holds in flight is refused (inflight)");
    ok(!mem.kv.has("replay:f:" + ke.split(":").slice(0, 2).join(":")), "deploy window: and the refused claim is given back");
    const kf = keyOf({ nonce: "0x62", from: A });
    await mem.set("replay:c:" + legacyName(kf), String(Date.now()), { EX: 3600 });
    ok(await g1.begin(kf) === "consumed", "deploy window: a payment an earlier build consumed is refused (consumed)");
    // This build first: an earlier build still running checks any entry at
    // the legacy name, so this build writes its claim and its consumed mark
    // there as well, and drops only its own tagged entry.
    const kg = keyOf({ nonce: "0x63", from: A });
    ok(await g1.begin(kg) === "ok", "deploy window: this build claims a payment");
    ok(Boolean(await mem.get("replay:f:" + legacyName(kg))), "deploy window: an earlier build sees that claim at the legacy name");
    await g1.settle(kg);
    ok(Boolean(await mem.get("replay:c:" + legacyName(kg))), "deploy window: an earlier build sees the consumed mark at the legacy name");
    ok(!(await mem.get("replay:f:" + legacyName(kg))), "deploy window: the tagged legacy claim is dropped on settle");
    const kh = keyOf({ nonce: "0x64", from: A });
    await g1.begin(kh); await g1.release(kh);
    ok(!(await mem.get("replay:f:" + legacyName(kh))), "deploy window: a release drops the tagged legacy claim");
    // A tagged legacy entry (another payer's, written by this build) is not a
    // refusal for a different payer.
    ok(await g2.begin(keyOf({ nonce: "0x63", from: B })) === "ok", "deploy window: another payer's tagged legacy mark does not refuse this payer");
    // An earlier build's claim on the legacy name is never deleted by this build.
    const ki = keyOf({ nonce: "0x65", from: A });
    await mem.set("replay:f:" + legacyName(ki), "12345", { EX: 120 });
    await g1.release(ki);
    ok((await mem.get("replay:f:" + legacyName(ki))) === "12345", "deploy window: an earlier build's claim is left to its owner");
  } finally { __setTestClient(null); }
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
