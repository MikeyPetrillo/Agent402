// MPP recurring subscriptions (src/mpp-subscriptions.js) with the state
// database on: the store that was one JSON file on the volume is one row.
// Proves, against a real Postgres: the file is imported once at the first
// boot and never again; a write is visible to a fresh instance (a second
// container) through the row, not the file; mppx's `update` stays synchronous
// over the in-memory map; the money invariant holds across containers (a
// renewal whose send was ambiguous is remembered as `unconfirmedCharge` in the
// row, and a SECOND instance asks the chain before it signs); and a pull whose
// lease another container holds signs nothing. Requires STATE_DATABASE_URL
// (CI fails without it; locally it skips). Fully offline otherwise: real mppx
// codec objects, injected settlement, no RPC.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-mpp-subscriptions-pg" });

const SECRET = "test-mpp-secret";
const REALM = "agent402.test";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";
process.env.MPP_SECRET_KEY = SECRET;
process.env.TEMPO_RECIPIENT_ADDRESS = RECIPIENT;
process.env.TEMPO_CURRENCY = "usdc";
process.env.TEMPO_DECIMALS = "6";
process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = "0x" + "11".repeat(32);
delete process.env.MPP_SUBSCRIPTIONS;
delete process.env.TEMPO_RPC_URL;

const { Challenge, Credential } = await import("mppx");
const Tempo = await import("mppx/tempo");
const { KeyAuthorization } = await import("ox/tempo");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const sdb = await import("../src/state-db.js");
const { createMppSubscriptions, createDbStore, periodMs, PERIOD_COUNT, PERIOD_UNIT, TEMPO_MAINNET_CHAIN_ID, RENEWAL_LEASE_TTL_MS } = await import("../src/mpp-subscriptions.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const quiet = () => {};
const D1 = mkdtempSync(join(tmpdir(), "mppsubs-pg-1-"));
const D2 = mkdtempSync(join(tmpdir(), "mppsubs-pg-2-"));
const FILE = join(D1, "mpp-subscriptions.json");
const DOC = "mpp-subscriptions.json";
const PERIOD = periodMs();
let clock = Date.parse("2026-10-09T12:00:00.000Z");
const advance = (ms) => { clock += ms; };

function makeEngine(storePath) {
  const calls = { activate: 0, charge: 0, find: 0, sales: [] };
  let chargeBehaviour = () => ({ reference: `0xtx${calls.charge}` });
  let findBehaviour = { found: false };
  const engine = createMppSubscriptions({
    secretKey: SECRET, realm: REALM, storePath, now: () => clock, log: quiet,
    onCharge: (s) => calls.sales.push(s),
    activate: async (header, ctx) => {
      calls.activate++;
      await engine._subStore.put({
        accessKey: { accessKeyAddress: ctx.accessKey.accessKeyAddress, keyType: ctx.accessKey.keyType },
        amount: String(ctx.binding.amountAtomic),
        billingAnchor: new Date(clock).toISOString(),
        chainId: TEMPO_MAINNET_CHAIN_ID, currency: CURRENCY,
        keyAuthorization: ctx.binding.credential.payload.signature,
        lastChargedPeriod: 0, lookupKey: ctx.lookupKey,
        payer: { address: ctx.payer, chainId: TEMPO_MAINNET_CHAIN_ID },
        periodCount: String(PERIOD_COUNT), periodUnit: PERIOD_UNIT,
        recipient: RECIPIENT, reference: "0xactivation",
        subscriptionExpires: ctx.binding.challenge.request.subscriptionExpires,
        subscriptionId: `sub-${calls.activate}`, timestamp: new Date(clock).toISOString(),
      });
      return { receipt: { method: "tempo", status: "success", reference: "0xactivation", timestamp: new Date(clock).toISOString() } };
    },
    findRenewalOnChain: async (args) => { calls.find++; return typeof findBehaviour === "function" ? findBehaviour(args) : findBehaviour; },
    chargePeriod: async (rec, { periodIndex }) => {
      calls.charge++;
      const r = chargeBehaviour(rec, periodIndex);
      if (r instanceof Error) throw r;
      const mppxRec = await engine._subStore.get(rec.mppxSubscriptionId);
      await engine._subStore.put({ ...mppxRec, lastChargedPeriod: periodIndex, reference: r.reference });
      return r;
    },
  });
  return { engine, calls, setCharge: (fn) => { chargeBehaviour = fn; }, setFind: (v) => { findBehaviour = v; } };
}
async function signCredential(challenge) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const ak = challenge.request.methodDetails.accessKey;
  const signed = await Tempo.Subscription.signSubscriptionKeyAuthorization({ accessKey: ak, account: acct, challengeId: challenge.id, chainId: TEMPO_MAINNET_CHAIN_ID, request: challenge.request });
  const credential = Credential.from({ challenge, payload: { type: "keyAuthorization", signature: KeyAuthorization.serialize(signed) } });
  return `Payment ${Credential.serialize(credential).replace(/^Payment\s+/i, "")}`;
}
const rowBody = async () => (await sdb.documents.get(DOC))?.body || null;
const sendTimeout = () => Object.assign(new Error("The request took too long to respond.\n\nURL: https://rpc.tempo.xyz/\nRequest body: {\"method\":\"eth_sendRawTransactionSync\",\"params\":[\"0x76f9\"]}"), { name: "TimeoutError", details: "The request timed out." });

try {
  // ---- (1) import once ------------------------------------------------------
  const oldRec = { subId: "mpp_old", product: "domain-monitor", target: "example.com", status: "active", payer: "0x" + "a".repeat(40), rail: "mpp-tempo", currency: CURRENCY, chainId: TEMPO_MAINNET_CHAIN_ID, priceUsd: "3.00", billingAnchor: new Date(clock).toISOString(), periodCount: PERIOD_COUNT, periodUnit: PERIOD_UNIT, lastChargedPeriod: 0, subscriptionExpires: new Date(clock + 365 * 86400_000).toISOString(), mppxSubscriptionId: "sub-old", accessKeyAddress: "0x" + "b".repeat(40), createdAt: new Date(clock).toISOString() };
  writeFileSync(FILE, JSON.stringify({ "a402:sub:mpp_old": oldRec, "mppx:tempo:subscription:sub-old": { subscriptionId: "sub-old", lastChargedPeriod: 0 } }));
  const A = makeEngine(FILE);
  ok(A.engine._store.backend === "pg", "with STATE_DATABASE_URL set the engine's store is the database one");
  ok(A.engine.get("mpp_old") === null && A.engine.listActive().length === 0, "before the first load the map is empty (the server awaits ready before listening)");
  await A.engine.ready();
  ok(A.engine.get("mpp_old")?.subId === "mpp_old", "the first load imports the file: the house record is readable");
  ok((await A.engine._store.get("mppx:tempo:subscription:sub-old"))?.lastChargedPeriod === 0, "and mppx's own records came with it");
  ok(A.engine.listActive("domain").length === 1, "listActive serves the imported subscriber after ready");
  const mark = await sdb.imports.done(DOC);
  ok(mark && mark.source === FILE, `the import is marked under the file's basename (${DOC})`);
  ok((await rowBody())?.["a402:sub:mpp_old"]?.subId === "mpp_old", "the row holds the imported body");

  // A second boot on the same file does not import again: a key written to
  // the file after the row exists (within the write-through grace) is ignored.
  const tampered = JSON.parse(readFileSync(FILE, "utf8"));
  tampered["a402:sub:mpp_ghost"] = { ...oldRec, subId: "mpp_ghost" };
  writeFileSync(FILE, JSON.stringify(tampered));
  const A2 = makeEngine(FILE);
  await A2.engine.ready();
  ok(A2.engine.get("mpp_ghost") === null && A2.engine.get("mpp_old")?.subId === "mpp_old", "a second boot reads the row, not the file: no re-import");
  ok((await rowBody())?.["a402:sub:mpp_ghost"] === undefined, "and the row is untouched by the file's later contents");

  // ---- (2) a write is visible to a second instance ----------------------------
  const offer = await A.engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
  const header = await signCredential(Challenge.deserialize(offer.header));
  const sub = await A.engine.activateFromCredential(header);
  ok(typeof sub.subId === "string" && sub.subId.startsWith("mpp_"), "an activation writes a house record");
  await A.engine.flush();
  ok((await rowBody())?.[`a402:sub:${sub.subId}`]?.status === "active", "the house record is in the row");
  const mppxKeys = Object.keys(await rowBody()).filter((k) => !k.startsWith("a402:"));
  ok(mppxKeys.length >= 3, `mppx's own records (access key, subscription, locks) are in the row too (${mppxKeys.length} keys)`);
  ok(JSON.parse(readFileSync(FILE, "utf8"))[`a402:sub:${sub.subId}`]?.status === "active", "write-through keeps the file current for the backup and a rollback");
  const B = makeEngine(join(D2, "mpp-subscriptions.json"));
  await B.engine.ready();
  ok(B.engine.get(sub.subId)?.status === "active" && B.engine.get("mpp_old")?.subId === "mpp_old", "a fresh instance sees the record from the row");
  ok((await B.engine._subStore.get(B.engine.get(sub.subId).mppxSubscriptionId))?.lastChargedPeriod === 0, "and mppx's subscription record for it");

  // ---- (3) update stays synchronous ----------------------------------------------
  {
    const kv = createDbStore(join(D2, "mpp-subscriptions.json"), { log: quiet });
    await kv._ready;
    const p = kv.update("a402:test:sync", (cur) => ({ op: "set", value: { seen: cur, n: 1 }, result: "r1" }));
    ok(kv._snapshot()["a402:test:sync"]?.n === 1, "update applies to the map before anything is awaited (mppx's atomic contract)");
    ok(await p === "r1", "and resolves the callback's result");
    const p2 = kv.update("a402:test:sync", (cur) => ({ op: "set", value: { n: cur.n + 1 }, result: cur.n }));
    ok(kv._snapshot()["a402:test:sync"].n === 2 && await p2 === 1, "a second update reads the first's value synchronously");
    await kv.flush();
    ok((await rowBody())?.["a402:test:sync"]?.n === 2, "the queued write landed in the row");
    const nop = await kv.update("a402:test:sync", () => ({ op: "noop", result: "untouched" }));
    ok(nop === "untouched" && kv._snapshot()["a402:test:sync"].n === 2, "a noop changes nothing");
    await kv.update("a402:test:sync", () => ({ op: "delete", result: true }));
    await kv.flush();
    ok(!("a402:test:sync" in (await rowBody())) && kv._snapshot()["a402:test:sync"] === undefined, "a delete through update leaves the row and the map");
    await kv.put("a402:test:order", { v: 1 });
    void kv.put("a402:test:order", { v: 2 });
    await kv.put("a402:test:order", { v: 3 });
    ok((await rowBody())?.["a402:test:order"]?.v === 3, "writes land in call order (one queue per store)");
    await kv.delete("a402:test:order");
  }

  // ---- (4) the money invariant across containers --------------------------------
  // Container A's pull dies in the send phase: the record remembers the
  // unconfirmed send IN THE ROW. Container B (a fresh instance) must read it
  // and ask the chain before it signs anything.
  A.setCharge(() => sendTimeout());
  advance(PERIOD);
  ok(await A.engine.refreshStatus(sub.subId) === "past_due", "A: a send-phase failure leaves the subscription past_due");
  ok(A.calls.charge === 1, "A: one attempt was made");
  const rowRec = (await rowBody())?.[`a402:sub:${sub.subId}`];
  ok(rowRec?.unconfirmedCharge?.periodIndex === 1 && rowRec.unconfirmedCharge.at, "the row carries unconfirmedCharge for period 1 (durable, not only in A's memory)");
  const B2 = makeEngine(join(D2, "mpp-subscriptions.json"));
  await B2.engine.ready();
  const recB = B2.engine.get(sub.subId);
  ok(recB?.unconfirmedCharge?.periodIndex === 1, "B: a fresh instance sees the unconfirmed send");
  B2.setFind(({ periodIndex, sinceMs }) => (periodIndex === 1 && sinceMs < clock ? { found: true, tx: "0xlanded" } : { found: false }));
  B2.setCharge(() => ({ reference: "0xMUST-NOT-HAPPEN" }));
  advance(Date.parse(recB.nextChargeAttemptAt) - clock + 1000);
  ok(await B2.engine.refreshStatus(sub.subId) === "active", "B: the next pull asks the chain first and finds the transfer -> active");
  ok(B2.calls.charge === 0 && B2.calls.find === 1, "B: NOTHING was signed (no second transfer from the other container)");
  const afterB = B2.engine.get(sub.subId);
  ok(afterB.lastChargedPeriod === 1 && afterB.lastChargeTx === "0xlanded" && !afterB.unconfirmedCharge, "B: the landed transaction is recorded as period 1's charge");
  await B2.engine.flush();
  ok((await rowBody())?.[`a402:sub:${sub.subId}`]?.lastChargeTx === "0xlanded", "and that is in the row for every container");
  ok((await B2.engine._subStore.get(afterB.mppxSubscriptionId))?.lastChargedPeriod === 1, "B: mppx's own counter advanced to the reconciled period");

  // ---- (5) the lease skip -------------------------------------------------------------
  advance(PERIOD);
  const leaseName = `mpp-sub-renewal:${sub.subId}`;
  ok(await sdb.leases.acquire(leaseName, { owner: "other-container", ttlMs: 60_000 }) === true, "another container holds this subscription's pull lease");
  B2.setFind({ found: false });
  B2.setCharge(() => ({ reference: "0xperiod2" }));
  ok(await B2.engine.refreshStatus(sub.subId) === "past_due", "a pull whose lease another holder has answers past_due (fail closed, no paid run)");
  ok(B2.calls.charge === 0, "and signs nothing");
  ok((await sdb.leases.holder(leaseName))?.owner === "other-container", "the other holder keeps the lease");
  await sdb.leases.release(leaseName, { owner: "other-container" });
  ok(await B2.engine.refreshStatus(sub.subId) === "active" && B2.calls.charge === 1 && B2.engine.get(sub.subId).lastChargedPeriod === 2, "once released, the pull charges period 2 exactly once");
  ok((await sdb.leases.holder(leaseName)) === null, "the pull released its lease after running");
  ok(RENEWAL_LEASE_TTL_MS >= 5 * 60_000, "the pull lease outlives a slow sync send");

  // ---- (6) roll-forward after a rollback window ------------------------------------
  {
    const rec2 = { ...oldRec, subId: "mpp_newer" };
    const file2 = join(D1, "mpp-subscriptions.json");
    const body = JSON.parse(readFileSync(file2, "utf8"));
    body["a402:sub:mpp_newer"] = rec2;
    writeFileSync(file2, JSON.stringify(body));
    // A file written long after the row was last written is a rollback
    // window's writes: the next first load replaces the row with it.
    const future = (Date.now() + 10 * 60_000) / 1000;
    utimesSync(file2, future, future);
    const A3 = makeEngine(file2);
    await A3.engine.ready();
    ok(A3.engine.get("mpp_newer")?.subId === "mpp_newer", "a file written past the write-through grace (a rollback window) is rolled forward into the row");
  }
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  rmSync(D1, { recursive: true, force: true });
  rmSync(D2, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
