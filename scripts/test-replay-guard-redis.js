#!/usr/bin/env node
// Exercise the REAL Redis-backed replay guard against a REAL redis server.
//
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-replay-guard-redis.js
//
// WHY THIS EXISTS (2026-08-16). test-replay-guard.js proves the guard's STATE
// MACHINE (concurrent/sequential replay refused, release-on-failure, TTL,
// eviction) entirely against the per-process fallback - it never sets
// REDIS_URL, so it can never prove the property the Redis backing exists for:
// that TWO SEPARATE createReplayGuard() instances (standing in for two app
// replicas) sharing one Redis actually behave like ONE shared guard. A stub
// client would only prove "the code calls set/get/del", the same shallow
// coverage this repo has been burned by before (see test-redis-integration.js's
// own header) - this drives the real client against a real server instead.
//
// Deliberately does not skip when REDIS_URL is unset: a skipped integration
// test is how the cross-replica gap this guard now closes went uncaught for
// as long as it did.
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
if (!process.env.REDIS_URL) {
  console.error("FAIL: REDIS_URL is not set. This test needs a real redis (CI provides a service container).");
  console.error("      It deliberately does not skip - see the header comment.");
  process.exit(1);
}

const { createReplayGuard, paymentReplayKey } = await import("../src/replay-guard.js");
const { getSharedRedisClient, __setTestClient } = await import("../src/shared-limit.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const client = await getSharedRedisClient();
if (!client) { console.error("FAIL: could not reach redis at", process.env.REDIS_URL); process.exit(1); }

// Unique key prefix per run so repeated local runs never collide with leftover state.
const runId = `t${Date.now()}${Math.floor(Math.random() * 1e6) || 1}`;
const key = (suffix) => `replay-guard-redis-test:${runId}:${suffix}`;

// --- 1. Two independent guard instances = two "replicas" -------------------
// Neither instance's local Map/Set is shared - if the guard were still
// per-process, guardB would see nothing guardA claimed. It must, because
// both share the SAME Redis connection under the hood.
{
  const guardA = createReplayGuard();
  const guardB = createReplayGuard();
  const k = key("cross-replica");

  const first = await guardA.begin(k);
  ok(first === "ok", `replica A claims a fresh nonce (got "${first}")`);

  const second = await guardB.begin(k);
  ok(second === "inflight", `replica B sees it as in-flight, NOT "ok" (got "${second}") — proves cross-replica sharing`);

  await guardA.settle(k);
  const third = await guardB.begin(k);
  ok(third === "consumed", `after A settles, B sees it as consumed (got "${third}") — settlement is visible cross-replica`);
}

// --- 2. Release is also cross-replica visible -------------------------------
{
  const guardA = createReplayGuard();
  const guardB = createReplayGuard();
  const k = key("cross-release");

  await guardA.begin(k);
  await guardA.release(k); // e.g. facilitator rejected settlement
  const retried = await guardB.begin(k);
  ok(retried === "ok", `after A releases, B can claim the SAME nonce fresh (got "${retried}") — release-on-failure works cross-replica`);
}

// --- 3. The in-flight claim carries a real TTL (self-heals a crashed replica) ---
{
  const k = key("ttl-check");
  const guard = createReplayGuard();
  await guard.begin(k);
  const ttl = await client.ttl(`replay:f:${k}`);
  ok(ttl > 0 && ttl <= 120, `the in-flight Redis key carries a bounded TTL (got ${ttl}s, expect 0 < ttl <= 120)`);
  await guard.release(k);
}

// --- 4. The consumed marker's TTL matches the guard's configured ttlMs -------
{
  const k = key("consumed-ttl");
  const guard = createReplayGuard({ ttlMs: 5000 }); // 5s
  await guard.begin(k);
  await guard.settle(k);
  const ttl = await client.ttl(`replay:c:${k}`);
  ok(ttl > 0 && ttl <= 5, `the consumed Redis key's TTL matches ttlMs (got ${ttl}s, expect 0 < ttl <= 5)`);
}

// --- 5. Full paymentReplayKey() -> guard round trip, matching server.js's
// real usage shape (not a synthetic string key). ----------------------------
{
  const guardA = createReplayGuard();
  const guardB = createReplayGuard();
  const fakeReq = (cred) => ({ header: (n) => (String(n).toLowerCase() === "x-payment" ? cred : undefined) });
  const cred = Buffer.from(JSON.stringify({
    network: "eip155:8453",
    payload: { authorization: { nonce: `0x${runId}`, from: "0x" + "1".repeat(40) } },
  })).toString("base64");
  const rk = paymentReplayKey(fakeReq(cred));
  ok(typeof rk === "string" && rk.startsWith("n2:"), "paymentReplayKey() extracts a real nonce- and payer-scoped key from an x402 credential");

  ok(await guardA.begin(rk) === "ok", "real payment-credential key: replica A claims it");
  ok(await guardB.begin(rk) === "inflight", "real payment-credential key: replica B sees inflight");
  await guardA.settle(rk);
}

// --- 5b. A call that runs past the claim's TTL keeps its claim ---------------
// The claim is renewed while the call is open, so a handler that outlives the
// in-flight TTL cannot be run a second time on the same signed payment from
// another replica; settle/release stop the renewal, and a holder that never
// finishes stops renewing after maxHoldMs so its claim lapses.
{
  const opts = { inflightTtlSeconds: 1, renewMs: 300 };
  const guardA = createReplayGuard(opts);
  const guardB = createReplayGuard(opts);
  const k = key("long-handler");
  ok(await guardA.begin(k) === "ok", "long handler: replica A claims the nonce");
  await new Promise((r) => setTimeout(r, 2_600)); // the handler runs past the 1 s TTL
  const during = await guardB.begin(k);
  ok(during === "inflight", `long handler: replica B still sees inflight past the claim's TTL while A runs (got "${during}")`);
  ok(guardA._state().renewing === 1, "long handler: A renews its claim while the call is open");
  await guardA.release(k);
  ok(guardA._state().renewing === 0, "long handler: release stops the renewal");
  ok(await guardB.begin(k) === "ok", "long handler: after A releases, B may claim the still-valid authorization");
  await guardB.settle(k);
  ok(guardB._state().renewing === 0, "long handler: settle stops the renewal");

  const guardC = createReplayGuard({ ...opts, maxHoldMs: 600 });
  const k2 = key("abandoned-holder");
  await guardC.begin(k2);
  await new Promise((r) => setTimeout(r, 2_600)); // renewal stops at 600 ms, the 1 s TTL then lapses
  const lapsed = await guardB.begin(k2);
  ok(lapsed === "ok", `a holder that never settles or releases stops renewing and its claim lapses (got "${lapsed}")`);
  ok(guardC._state().renewing === 0, "the abandoned holder's renewal timer is gone");
  await guardB.release(k2);
}

// --- 6. Fails OPEN to local state when Redis throws (not closed, not a crash) --
// A rejected paid call over an optimization layer going dark would be the
// wrong direction for THIS guard (see the fail-open rationale in
// replay-guard.js's header) - the real chain-level nonce protection holds
// regardless. Injects a broken client via shared-limit.js's own test seam
// (the same one test-shared-limit.js uses) so this doesn't need a second,
// duplicate connection-mocking mechanism.
{
  const broken = {
    get: async () => { throw new Error("simulated redis outage"); },
    set: async () => { throw new Error("simulated redis outage"); },
    del: async () => { throw new Error("simulated redis outage"); },
  };
  __setTestClient(broken);
  try {
    const g = createReplayGuard();
    const k = "outage-test";
    const r1 = await g.begin(k);
    ok(r1 === "ok", `begin() during a redis outage still resolves (not a throw/hang) — falls back to local state (got "${r1}")`);
    const r2 = await g.begin(k);
    ok(r2 === "inflight", `local-state fallback still enforces the concurrent-replay rule during the outage (got "${r2}")`);
    await g.settle(k);
    const r3 = await g.begin(k);
    ok(r3 === "consumed", `local-state fallback still enforces sequential-replay after settle during the outage (got "${r3}")`);
  } finally {
    __setTestClient(null); // restore the real client for anything after this
  }
}

// --- Payer- and network-scoped keys on the real store, and the deploy window --
// Two wallets that sign the same nonce are two payments; an earlier build's
// nonce-only key ("n:" + legacy hash, a bare timestamp) is still honored.
{
  const reqOf = (o) => {
    const cred = Buffer.from(JSON.stringify({ network: o.network || "eip155:8453", payload: { authorization: { nonce: o.nonce, from: o.from } } })).toString("base64");
    return { header: (n) => (String(n).toLowerCase() === "x-payment" ? cred : undefined) };
  };
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
  const nonce = "0x" + runId;
  const gA = createReplayGuard(), gB = createReplayGuard();
  const ka = paymentReplayKey(reqOf({ nonce, from: A })), kb = paymentReplayKey(reqOf({ nonce, from: B }));
  ok(await gA.begin(ka) === "ok" && await gB.begin(kb) === "ok", "real redis: two payers signing the same nonce are both accepted");
  ok(await gB.begin(ka) === "inflight", "real redis: the same payer's same nonce on another replica is refused");
  await gA.settle(ka); await gB.settle(kb);
  ok(await gB.begin(ka) === "consumed" && await gA.begin(kb) === "consumed", "real redis: each payer's settled nonce reads consumed");
  const kn = paymentReplayKey(reqOf({ nonce, from: A, network: "eip155:137" }));
  ok(await gA.begin(kn) === "ok", "real redis: the same payer and nonce on another network is accepted");
  await gA.release(kn);
  const kl = paymentReplayKey(reqOf({ nonce: nonce + "1", from: A }));
  const legacy = "replay:c:n:" + kl.split(":")[2];
  await client.set(legacy, String(Date.now()), { EX: 60 });
  ok(await gA.begin(kl) === "consumed", "real redis: a payment an earlier build consumed under the nonce-only key is refused");
  await client.del(legacy);
}

// --- Stellar: one signed entry, two encodings, two replicas ------------------
// paymentReplayKeyAsync keys a Stellar payment on (network, signer, nonce) of
// the payer's signed entry, so a re-encoded copy on another replica is
// refused; an earlier build's raw-header claim on the same header is honored.
{
  const { paymentReplayKeyAsync } = await import("../src/replay-guard.js");
  const sdk = await import("@stellar/stellar-sdk");
  const NET = sdk.Networks.PUBLIC;
  const SAC = new sdk.Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN").contractId(NET);
  const from = sdk.Keypair.random().publicKey(), to = sdk.Keypair.random().publicKey();
  const nonce = String(Date.now());
  const args = [new sdk.Address(from).toScVal(), new sdk.Address(to).toScVal(), sdk.nativeToScVal(10000n, { type: "i128" })];
  const call = new sdk.xdr.InvokeContractArgs({ contractAddress: new sdk.Address(SAC).toScAddress(), functionName: "transfer", args });
  const entry = new sdk.xdr.SorobanAuthorizationEntry({
    credentials: sdk.xdr.SorobanCredentials.sorobanCredentialsAddress(new sdk.xdr.SorobanAddressCredentials({
      address: new sdk.Address(from).toScAddress(), nonce: sdk.xdr.Int64.fromString(nonce), signatureExpirationLedger: 1000, signature: sdk.xdr.ScVal.scvBytes(Buffer.alloc(64, 7)),
    })),
    rootInvocation: new sdk.xdr.SorobanAuthorizedInvocation({ function: sdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] }),
  });
  const op = sdk.Operation.invokeContractFunction({ contract: SAC, function: "transfer", args, auth: [entry] });
  const env = (seq) => new sdk.TransactionBuilder(new sdk.Account(sdk.Keypair.random().publicKey(), seq), { fee: "100", networkPassphrase: NET }).addOperation(op).setTimeout(300).build().toXDR();
  const reqOf = (x) => { const cred = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: "stellar:pubnet" }, payload: { transaction: x } })).toString("base64"); return { header: (n) => (String(n).toLowerCase() === "payment-signature" ? cred : undefined) }; };
  const ka = await paymentReplayKeyAsync(reqOf(env("1"))), kb = await paymentReplayKeyAsync(reqOf(env("2")));
  const gA = createReplayGuard(), gB = createReplayGuard();
  ok(/^s2:/.test(ka) && await gA.begin(ka) === "ok" && await gB.begin(kb) === "inflight", "real redis: a re-encoded copy of one Stellar entry on another replica is refused");
  await gA.settle(ka);
  ok(await gB.begin(kb) === "consumed", "real redis: after it settled, the re-encoded copy reads consumed");
  const kc = await paymentReplayKeyAsync(reqOf(env("3")));
  const legacy = "replay:f:c:" + kc.split(":")[2];
  // A fresh identity (another signer) under an earlier build's raw-header claim.
  const kd = kc.replace(/^s2:[0-9a-f]{64}:/, "s2:" + "0".repeat(64) + ":");
  await client.set(legacy, String(Date.now()), { EX: 60 });
  ok(await gA.begin(kd) === "inflight", "real redis: an earlier build's raw-header claim on the same header is honored");
  await client.del(legacy);
  // A build that derives this family's identity another way tags the same
  // header hash with its own primary: its claim and its mark hold this header
  // on every replica, another payment of the family is accepted, and a key
  // of another family at the same header hash is not held.
  const { createHash } = await import("node:crypto");
  const h = (x) => createHash("sha256").update(`${runId} ${x}`).digest("hex");
  const mine = `s2:${h("entries")}:${h("header")}`, theirs = `s2:${h("entries, derived another way")}:${h("header")}`, another = `s2:${h("other entries")}:${h("other header")}`, cross = `t2:${h("transaction")}:${h("header")}`;
  ok(await gA.begin(theirs) === "ok" && await gB.held(mine) === "inflight" && await gB.begin(mine) === "inflight", "real redis: a header another derivation of its family holds in flight is refused");
  ok(await gB.begin(another) === "ok" && await gB.held(cross) === null, "real redis: another payment of the family is accepted, and another family's key at the same header hash is not held");
  await gB.release(another);
  await gA.settle(theirs);
  ok(await gB.held(mine) === "consumed" && await gB.begin(mine) === "consumed", "real redis: a header another derivation of its family consumed is refused");
  ok(await gB.begin(cross) === "ok", "real redis: another family's key at the same header hash is accepted");
  await gB.release(cross);
}

// --- held(): the read-only twin, one MGET on the real client ----------------
// Read by the gateway cache before the paywall (src/gateway-cache-scope.js):
// every state another replica wrote, in one round trip, claiming nothing.
{
  const reqOf = (nonce) => {
    const cred = Buffer.from(JSON.stringify({ network: "eip155:8453", payload: { authorization: { nonce, from: "0x" + "c".repeat(40) } } })).toString("base64");
    return { header: (n) => (String(n).toLowerCase() === "x-payment" ? cred : undefined) };
  };
  const gA = createReplayGuard(), gB = createReplayGuard();
  const k = paymentReplayKey(reqOf("0x" + runId + "d"));
  ok(await gB.held(k) === null, "real redis: held() reads nothing held for a fresh payment");
  await gA.begin(k);
  ok(await gB.held(k) === "inflight", "real redis: held() on another replica reads the claim in flight");
  await gA.settle(k);
  ok(await gB.held(k) === "consumed", "real redis: held() on another replica reads the settled mark");
  const kl = paymentReplayKey(reqOf("0x" + runId + "e"));
  const legacyC = "replay:c:n:" + kl.split(":")[2], legacyF = "replay:f:n:" + kl.split(":")[2];
  await client.set(legacyF, String(Date.now()), { EX: 60 });
  ok(await gB.held(kl) === "inflight", "real redis: held() honors an earlier build's untagged claim at the legacy name");
  await client.set(legacyF, "v2|n2:" + "0".repeat(64), { EX: 60 });
  ok(await gB.held(kl) === null, "real redis: held() skips another payment's tagged claim at the legacy name");
  await client.set(legacyC, String(Date.now()), { EX: 60 });
  ok(await gB.held(kl) === "consumed", "real redis: held() honors an earlier build's consumed mark at the legacy name");
  await client.del(legacyC); await client.del(legacyF);
  ok(await gB.begin(kl) === "ok", "real redis: held() claimed nothing");
  await gB.release(kl);
}

// --- Owner token on a real Redis (compare-and-act scripts) -------------------
// A claim that lapsed and was taken by another request is neither dropped nor
// renewed by its first holder; the holder's own release drops it.
{
  const gA = createReplayGuard({ renewMs: 50 }), gB = createReplayGuard(), gC = createReplayGuard();
  const k = key("owner-token");
  ok(await gA.begin(k) === "ok", "owner token: A claims");
  await client.del(`replay:f:${k}`); // A's claim lapsed
  ok(await gB.begin(k) === "ok", "owner token: B takes the lapsed claim");
  await client.expire(`replay:f:${k}`, 5);
  await new Promise((r) => setTimeout(r, 160));
  const ttl = await client.ttl(`replay:f:${k}`);
  ok(ttl > 0 && ttl <= 5, `owner token: A's renewal does not extend B's claim (ttl ${ttl}s)`);
  await gA.release(k);
  ok(await gC.begin(k) === "inflight", "owner token: A's release leaves B's claim");
  await gB.release(k);
  ok(!(await client.get(`replay:f:${k}`)), "owner token: B's own release drops it");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
