// A first subscription payment that settled but left no subscription record
// of ours is never lost money (src/mpp-subscriptions.js). Offline: real mppx
// codec objects and real signed key authorizations, injected settlement, a
// file store and the real refund ledger (file mode) in a temp directory.
//
// Proves, each beside a control:
//  - our record lookup missing after settlement (500), or our record write
//    throwing, books an owed row keyed on the settlement reference, once;
//  - a retry of the same credential that rebuilds the subscription voids that
//    row (the buyer is served, never served and refunded), and a row already
//    being sent refuses the rebuild instead;
//  - a settled first payment with no record and no owed row (the process died
//    in between) is found by the offer sweep before it destroys the key: the
//    record is rebuilt from the offer and mppx's record, and the key is kept;
//    an offer that carries no product (minted by an earlier build) books owed
//    and the key goes;
//  - a payment the ledger already holds a row for (the buyer was answered
//    "refunded") is never rebuilt by the sweep: the debt stands, the key goes;
//    a debt a rebuild voided and never finished is owed again;
//  - an offer with no email is never rebuilt (nobody could see it): owed;
//  - a rebuild whose record write fails owes the debt again;
//  - the route relays the settled-not-recorded answer (on the engine's flag,
//    never its wording) and keeps every other 5xx text its own;
//  - a debt booked after a concurrent retry served the payment is voided;
//  - the offer marker (email, target) goes on activation, on the timed sweep
//    with no mint, and with the key;
//  - an unpaid offer is still swept with nothing booked.
//   node scripts/test-mpp-subscription-activation-owed.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "a402-mppsubs-owed-"));
process.env.REFUND_DB_DIR = tmp;
process.env.MPP_SECRET_KEY = "test-mpp-secret";
process.env.TEMPO_RECIPIENT_ADDRESS = "0x000000000000000000000000000000000000dEaD";
process.env.TEMPO_CURRENCY = "usdc";
process.env.TEMPO_DECIMALS = "6";
process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = "0x" + "11".repeat(32);
delete process.env.MPP_SUBSCRIPTIONS;
delete process.env.TEMPO_RPC_URL;

const { Challenge, Credential } = await import("mppx");
const Tempo = await import("mppx/tempo");
const { KeyAuthorization } = await import("ox/tempo");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
const { createMppSubscriptions, PERIOD_COUNT, PERIOD_UNIT, TEMPO_MAINNET_CHAIN_ID, OFFER_SWEEP_AFTER_MS } = await import("../src/mpp-subscriptions.js");
const { MONITOR_PRODUCTS } = await import("../src/stripe-subscriptions.js");
const ledger = await import("../src/refund-ledger.js");

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exitCode = 1; } };

const REALM = "agent402.test";
const PRICE_USD = MONITOR_PRODUCTS["domain-monitor"].price / 100;
let clock = Date.parse("2026-09-01T00:00:00.000Z");
let txSeq = 0;

function makeEngine(name, { writeMppxRecord = true, refunds = null, screen = null } = {}) {
  const calls = { activate: 0, sales: [] };
  const refs = new Map(); // one settlement reference per credential, as a re-sent credential names the same transfer
  const engine = createMppSubscriptions({
    secretKey: process.env.MPP_SECRET_KEY, realm: REALM,
    storePath: join(tmp, `${name}.json`),
    now: () => clock, log: () => {},
    onCharge: (s) => calls.sales.push(s),
    activate: async (_header, ctx) => {
      calls.activate++;
      const sig = ctx.binding.credential.payload.signature;
      if (!refs.has(sig)) refs.set(sig, `0x${(++txSeq).toString(16).padStart(64, "a")}`);
      const reference = refs.get(sig);
      if (writeMppxRecord) await engine._subStore.put(mppxRecord(ctx, reference, `sub-${name}-${calls.activate}`));
      return { receipt: { method: "tempo", status: "success", reference, timestamp: new Date(clock).toISOString() } };
    },
    chargePeriod: async () => { throw new Error("no renewals in this suite"); },
    findRenewalOnChain: async () => ({ found: false }),
    ...(refunds ? { refunds } : {}),
    ...(screen ? { screen } : {}),
  });
  return { engine, calls };
}
function mppxRecord(ctx, reference, subscriptionId) {
  return {
    accessKey: { accessKeyAddress: ctx.accessKey.accessKeyAddress, keyType: ctx.accessKey.keyType },
    amount: String(ctx.binding.amountAtomic),
    billingAnchor: new Date(clock).toISOString(),
    chainId: TEMPO_MAINNET_CHAIN_ID, currency: "0x20C000000000000000000000b9537d11c60E8b50",
    keyAuthorization: ctx.binding.credential.payload.signature,
    lastChargedPeriod: 0, lookupKey: ctx.lookupKey,
    payer: { address: ctx.payer, chainId: TEMPO_MAINNET_CHAIN_ID },
    periodCount: String(PERIOD_COUNT), periodUnit: PERIOD_UNIT,
    recipient: process.env.TEMPO_RECIPIENT_ADDRESS, reference,
    subscriptionExpires: ctx.binding.challenge.request.subscriptionExpires,
    subscriptionId, timestamp: new Date(clock).toISOString(),
  };
}
async function signCredential(challenge) {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed = await Tempo.Subscription.signSubscriptionKeyAuthorization({
    accessKey: challenge.request.methodDetails.accessKey, account, challengeId: challenge.id, chainId: TEMPO_MAINNET_CHAIN_ID, request: challenge.request,
  });
  const credential = Credential.from({ challenge, payload: { type: "keyAuthorization", signature: KeyAuthorization.serialize(signed) } });
  return { header: `Payment ${Credential.serialize(credential).replace(/^Payment\s+/i, "")}`, payer: account.address.toLowerCase() };
}
const rowFor = async (evidence) => { await ledger.refundLedgerFlush(); return ledger.refundByEvidence(evidence); };
const holdsKey = (engine, addr) => Object.values(engine._store._snapshot()).some((v) => v && typeof v === "object" && v.privateKey && String(v.accessKeyAddress).toLowerCase() === addr.toLowerCase());
const offerCount = (engine) => Object.keys(engine._store._snapshot()).filter((k) => k.startsWith("a402:offer:")).length;
const subRecords = (engine) => Object.entries(engine._store._snapshot()).filter(([k]) => k.startsWith("a402:sub:")).map(([, v]) => v);
async function attempt(fn) { try { return { value: await fn() }; } catch (error) { return { error }; } }

// 1. Our record lookup misses after settlement: owed, once, keyed on the settlement.
{
  const { engine, calls } = makeEngine("lookup-miss", { writeMppxRecord: false });
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "miss.example.org" });
  const signed = await signCredential(Challenge.deserialize(offer.header));
  const r = await attempt(() => engine.activateFromCredential(signed.header));
  const ev = `0x${txSeq.toString(16).padStart(64, "a")}`;
  ok(r.error?.statusCode === 500 && calls.activate === 1, `setup: the payment settled and the lookup missed (${r.error?.statusCode} ${r.error?.message})`);
  ok(!/nothing was charged/i.test(r.error?.message || ""), "the answer never tells a charged buyer that nothing was charged");
  const row = await rowFor(ev);
  ok(row?.status === "owed" && row.payer === signed.payer && Math.abs(row.priceUsd - PRICE_USD) < 1e-9 && row.slug === "domain-monitor" && row.network === "tempo" && row.wire === "mpp-tempo-subscription",
    `an owed row is booked for the settled first payment, keyed on its settlement (${JSON.stringify(row && { status: row.status, slug: row.slug, network: row.network, wire: row.wire })})`);
  const again = await attempt(() => engine.activateFromCredential(signed.header));
  await ledger.refundLedgerFlush();
  ok(again.error?.statusCode === 500 && ledger.listRefunds({ status: "all" }).filter((x) => x.payer === signed.payer).length === 1, `a second failure of the same payment books nothing more (one row; second answer ${again.error?.statusCode})`);
  ok(calls.sales.length === 0, "no sale is booked for a subscription that does not exist");
}

// 2. Our record write throws: owed; the retry that rebuilds voids it, and books the sale once.
{
  const { engine, calls } = makeEngine("write-throws");
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "throw.example.org", email: "t@example.com" });
  const signed = await signCredential(Challenge.deserialize(offer.header));
  const cas = engine._store.compareAndSet.bind(engine._store);
  let failOnce = true;
  engine._store.compareAndSet = async (k, d) => { if (failOnce && String(k).startsWith("a402:sub:mpp_")) { failOnce = false; throw new Error("simulated store failure"); } return cas(k, d); };
  const first = await attempt(() => engine.activateFromCredential(signed.header));
  engine._store.compareAndSet = cas;
  const ev = `0x${txSeq.toString(16).padStart(64, "a")}`;
  ok(first.error?.statusCode === 500 && calls.activate === 1 && calls.sales.length === 0, `setup: settled, our record write threw (${first.error?.statusCode})`);
  ok((await rowFor(ev))?.status === "owed", "the settled payment whose record was not written is booked owed");
  const retry = await attempt(() => engine.activateFromCredential(signed.header));
  ok(retry.value?.status === "active" && retry.value.replay === true && calls.activate === 1 && calls.sales.length === 1, `the retry rebuilds the subscription without settling again (${retry.error?.message || retry.value?.status})`);
  ok((await rowFor(ev))?.status === "void", `the owed row is voided when the subscription is handed back (${(await rowFor(ev))?.status})`);
}

// 3. A refund already being sent: the rebuild is refused, nothing booked, the row untouched.
{
  const { engine, calls } = makeEngine("sending");
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "sending.example.org" });
  const signed = await signCredential(Challenge.deserialize(offer.header));
  const cas = engine._store.compareAndSet.bind(engine._store);
  let failOnce = true;
  engine._store.compareAndSet = async (k, d) => { if (failOnce && String(k).startsWith("a402:sub:mpp_")) { failOnce = false; throw new Error("simulated store failure"); } return cas(k, d); };
  await attempt(() => engine.activateFromCredential(signed.header));
  engine._store.compareAndSet = cas;
  const ev = `0x${txSeq.toString(16).padStart(64, "a")}`;
  const row = await rowFor(ev);
  ok(row?.status === "owed" && (await ledger.claimRefundForSend(row.id)) === true, "setup: the owed row is claimed for sending");
  const retry = await attempt(() => engine.activateFromCredential(signed.header));
  ok(retry.error && retry.error.statusCode >= 400 && calls.sales.length === 0 && subRecords(engine).length === 0, `a refund under way refuses the rebuild: never served and refunded (${retry.error?.statusCode})`);
  ok((await rowFor(ev))?.status === "sending", "the row being sent is left as it was");
}

// 4. The process died between settlement and our record: the offer sweep finds it.
{
  const { engine, calls } = makeEngine("died");
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "died.example.org", email: "d@example.com" });
  const ch = Challenge.deserialize(offer.header);
  const addr = ch.request.methodDetails.accessKey.accessKeyAddress.toLowerCase();
  const signed = await signCredential(ch);
  // What mppx persisted for the settled first period, and nothing of ours.
  const binding = { amountAtomic: ch.request.amount, credential: { payload: { signature: "0x01" } }, challenge: ch };
  const reference = `0x${(++txSeq).toString(16).padStart(64, "b")}`;
  await engine._subStore.put(mppxRecord({ accessKey: { accessKeyAddress: addr, keyType: "secp256k1" }, binding, lookupKey: `${signed.payer}|${addr}`, payer: signed.payer }, reference, "sub-died-1"));
  // A control: an unpaid offer minted at the same time.
  const unpaid = await engine.mintOffer({ product: "domain-monitor", target: "unpaid.example.org" });
  const unpaidAddr = Challenge.deserialize(unpaid.header).request.methodDetails.accessKey.accessKeyAddress.toLowerCase();
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  await engine.mintOffer({ product: "domain-monitor", target: "next.example.org" });
  const recs = subRecords(engine);
  ok(recs.length === 1 && recs[0].product === "domain-monitor" && recs[0].target === "died.example.org" && recs[0].email === "d@example.com" && recs[0].payer === signed.payer && recs[0].status === "active" && recs[0].lastChargeTx === reference,
    `the sweep rebuilds the subscription from the offer and mppx's record (${JSON.stringify(recs.map((r) => ({ product: r.product, target: r.target, status: r.status })))})`);
  ok(calls.sales.length === 1 && calls.sales[0].tx === reference, `its first period is booked once (sales ${calls.sales.length})`);
  ok(holdsKey(engine, addr), "the rebuilt subscription keeps its billing key");
  ok(!holdsKey(engine, unpaidAddr), "control: the unpaid offer's key is destroyed");
  ok(!(await rowFor(reference)), "nothing is booked owed for a subscription handed back");
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  await engine.mintOffer({ product: "domain-monitor", target: "again.example.org" });
  ok(subRecords(engine).length === 1 && calls.sales.length === 1, "a later sweep books nothing again");
  ok(offerCount(engine) === 1, "only the newest offer is still open");
}

// 5. An offer from an earlier build names no product: owed, and the key goes.
{
  const { engine, calls } = makeEngine("legacy");
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "legacy.example.org" });
  const ch = Challenge.deserialize(offer.header);
  const addr = ch.request.methodDetails.accessKey.accessKeyAddress.toLowerCase();
  const signed = await signCredential(ch);
  for (const [k, v] of Object.entries(engine._store._snapshot())) if (k.startsWith("a402:offer:")) await engine._store.put(k, { at: v.at, accessKeyAddress: v.accessKeyAddress });
  const binding = { amountAtomic: ch.request.amount, credential: { payload: { signature: "0x01" } }, challenge: ch };
  const reference = `0x${(++txSeq).toString(16).padStart(64, "c")}`;
  await engine._subStore.put(mppxRecord({ accessKey: { accessKeyAddress: addr, keyType: "secp256k1" }, binding, lookupKey: `${signed.payer}|${addr}`, payer: signed.payer }, reference, "sub-legacy-1"));
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  await engine.mintOffer({ product: "domain-monitor", target: "next.example.org" });
  const row = await rowFor(reference);
  ok(row?.status === "owed" && row.payer === signed.payer && Math.abs(row.priceUsd - PRICE_USD) < 1e-9, `a settled first payment the sweep cannot rebuild is booked owed (${row?.status})`);
  ok(!holdsKey(engine, addr) && subRecords(engine).length === 0 && calls.sales.length === 0, "and its key is destroyed, with no subscription and no sale");
}


const realLedger = { recordOwed: ledger.recordRefundOwed, voidForServe: ledger.voidOwedForServe, reopenHeld: ledger.reopenHeldClaim, renoteVoid: ledger.renoteVoidRefund, byEvidence: (ev) => ledger.refundByEvidenceFresh(ev) };
const markersFor = (engine, addr) => Object.entries(engine._store._snapshot()).filter(([k, v]) => k.startsWith("a402:offer:") && String(v?.accessKeyAddress || "").toLowerCase() === addr.toLowerCase()).map(([, v]) => v);
function failSubWrites(engine, times = 1) {
  const cas = engine._store.compareAndSet.bind(engine._store);
  let left = times;
  engine._store.compareAndSet = async (k, d) => { if (left > 0 && String(k).startsWith("a402:sub:mpp_")) { left--; throw new Error("simulated store failure"); } return cas(k, d); };
  return () => { engine._store.compareAndSet = cas; };
}
async function mintSigned(engine, target, email) {
  const offer = await engine.mintOffer({ product: "domain-monitor", target, ...(email ? { email } : {}) });
  const ch = Challenge.deserialize(offer.header);
  const addr = ch.request.methodDetails.accessKey.accessKeyAddress.toLowerCase();
  return { ch, addr, ...(await signCredential(ch)) };
}

// 6. Booked owed and answered "refunded"; the buyer never retries; the
//    challenge expires and the sweep runs: the debt stands, no subscription.
{
  const { engine, calls } = makeEngine("owed-then-sweep");
  const s6 = await mintSigned(engine, "owedsweep.example.org", "o@example.com");
  const restore = failSubWrites(engine);
  const first = await attempt(() => engine.activateFromCredential(s6.header));
  restore();
  const ev = `0x${txSeq.toString(16).padStart(64, "a")}`;
  ok(first.error?.statusCode === 500 && first.error.settledNotRecorded === true && (await rowFor(ev))?.status === "owed", `setup: settled, not recorded, booked owed (${first.error?.statusCode})`);
  ok(/before the payment challenge expires/.test(first.error.message) && /refunded/.test(first.error.message), `the answer says a retry works only inside the challenge window, else a refund (${first.error.message})`);
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  await engine.mintOffer({ product: "domain-monitor", target: "next6.example.org" });
  ok((await rowFor(ev))?.status === "owed", `the sweep leaves the debt owed (${(await rowFor(ev))?.status})`);
  ok(subRecords(engine).length === 0 && calls.sales.length === 0, "no subscription is rebuilt behind a buyer told they are refunded");
  ok(!holdsKey(engine, s6.addr), "the key is destroyed, so the settled authorization can never bill again");
  ok(markersFor(engine, s6.addr).length === 0, "and the offer's marker (email, target) is gone");
  const late = await attempt(() => engine.activateFromCredential(s6.header));
  ok(late.error?.statusCode === 402 && (await rowFor(ev))?.status === "owed" && subRecords(engine).length === 0, `a retry after the challenge expired is refused and the debt is untouched (${late.error?.statusCode})`);
}

// 7. No ledger row, the offer names a product and target but no email: owed, key destroyed.
{
  const { engine, calls } = makeEngine("no-email");
  const s7 = await mintSigned(engine, "noemail.example.org", null);
  const binding = { amountAtomic: s7.ch.request.amount, credential: { payload: { signature: "0x01" } }, challenge: s7.ch };
  const reference = `0x${(++txSeq).toString(16).padStart(64, "d")}`;
  await engine._subStore.put(mppxRecord({ accessKey: { accessKeyAddress: s7.addr, keyType: "secp256k1" }, binding, lookupKey: `${s7.payer}|${s7.addr}`, payer: s7.payer }, reference, "sub-noemail-1"));
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  await engine.mintOffer({ product: "domain-monitor", target: "next7.example.org" });
  ok((await rowFor(reference))?.status === "owed", `an email-less settled offer is booked owed (${(await rowFor(reference))?.status})`);
  ok(!holdsKey(engine, s7.addr) && subRecords(engine).length === 0 && calls.sales.length === 0, "never rebuilt (no one could see it); the key is destroyed");
}

// 8. A rebuild voided the debt and died before its record: the sweep owes it again.
{
  let reopenWorks = false;
  const refunds = { ...realLedger, reopenHeld: (...a) => (reopenWorks ? realLedger.reopenHeld(...a) : false) };
  const { engine, calls } = makeEngine("held", { refunds });
  const s8 = await mintSigned(engine, "held.example.org", "h@example.com");
  let restore = failSubWrites(engine);
  await attempt(() => engine.activateFromCredential(s8.header));
  restore();
  const ev = `0x${txSeq.toString(16).padStart(64, "a")}`;
  ok((await rowFor(ev))?.status === "owed", "setup: booked owed");
  restore = failSubWrites(engine);
  const retry = await attempt(() => engine.activateFromCredential(s8.header));
  restore();
  ok(retry.error && (await rowFor(ev))?.status === "void", `setup: the rebuild voided the debt and did not finish (${(await rowFor(ev))?.status})`);
  reopenWorks = true;
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  await engine.mintOffer({ product: "domain-monitor", target: "next8.example.org" });
  const row = await rowFor(ev);
  ok(row?.status === "owed", `the sweep owes the held debt again (${row?.status} ${row?.note})`);
  ok(subRecords(engine).length === 0 && calls.sales.length === 0 && !holdsKey(engine, s8.addr), "no subscription, no sale, the key destroyed");
}

// 9. A rebuild whose record write fails owes the debt again; the next retry serves it.
{
  const { engine, calls } = makeEngine("rebuild-fails");
  const s9 = await mintSigned(engine, "rebuildfail.example.org", "r@example.com");
  let restore = failSubWrites(engine);
  await attempt(() => engine.activateFromCredential(s9.header));
  restore();
  const ev = `0x${txSeq.toString(16).padStart(64, "a")}`;
  restore = failSubWrites(engine);
  const retry = await attempt(() => engine.activateFromCredential(s9.header));
  restore();
  ok(retry.error?.statusCode === 500 && (await rowFor(ev))?.status === "owed", `a failed rebuild leaves the debt owed, never void (${retry.error?.statusCode} ${(await rowFor(ev))?.status})`);
  const third = await attempt(() => engine.activateFromCredential(s9.header));
  ok(third.value?.status === "active" && (await rowFor(ev))?.status === "void" && calls.sales.length === 1, `the next retry serves it and voids the debt once (${third.value?.status} ${(await rowFor(ev))?.status})`);
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  await engine.mintOffer({ product: "domain-monitor", target: "next9.example.org" });
  ok((await rowFor(ev))?.status === "void" && holdsKey(engine, s9.addr), "a later sweep reopens nothing and keeps the served key");
}

// 10. The offer marker's email goes on activation, on the timed sweep (no mint), and with the key.
{
  const { engine } = makeEngine("privacy");
  const sA = await mintSigned(engine, "privacy-a.example.org", "a@example.com");
  ok(markersFor(engine, sA.addr)[0]?.email === "a@example.com", "setup: the open offer's marker holds the email");
  const act = await attempt(() => engine.activateFromCredential(sA.header));
  ok(act.value?.status === "active" && markersFor(engine, sA.addr).length === 0, `activation drops the offer's marker (${act.value?.status})`);

  const sB = await mintSigned(engine, "privacy-b.example.org", "b@example.com");
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  engine.start({ offerIntervalMs: 20, firstMs: 3_600_000 });
  for (let i = 0; i < 100 && markersFor(engine, sB.addr).length; i++) await new Promise((r) => setTimeout(r, 20));
  engine.stop();
  ok(markersFor(engine, sB.addr).length === 0 && !holdsKey(engine, sB.addr), "the timed sweep drops an expired offer's marker and key with no mint");
  ok(holdsKey(engine, sA.addr), "control: the timed sweep never destroys a key a subscription uses");

  // The offer sweep's first run comes shortly after a start, not one full
  // interval later: a deploy would otherwise push it out by the interval.
  const sD = await mintSigned(engine, "privacy-d.example.org", "d@example.com");
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  engine.start({ offerIntervalMs: 3_600_000, offerFirstMs: 20, firstMs: 3_600_000 });
  for (let i = 0; i < 100 && markersFor(engine, sD.addr).length; i++) await new Promise((r) => setTimeout(r, 20));
  engine.stop();
  ok(markersFor(engine, sD.addr).length === 0 && !holdsKey(engine, sD.addr), "the offer sweep's first run after a start drops an expired offer before the first interval");
  const sE = await mintSigned(engine, "privacy-e.example.org", "e@example.com");
  clock += OFFER_SWEEP_AFTER_MS + 1000;
  engine.start({ offerIntervalMs: 3_600_000, offerFirstMs: 3_600_000, firstMs: 3_600_000 });
  await new Promise((r) => setTimeout(r, 200));
  engine.stop();
  ok(markersFor(engine, sE.addr).length === 1 && holdsKey(engine, sE.addr), "control: with the first run held back, nothing sweeps before it");
  const { OFFER_SWEEP_FIRST_MS, OFFER_SWEEP_INTERVAL_MS } = await import("../src/mpp-subscription-retention.js");
  ok(OFFER_SWEEP_FIRST_MS > 0 && OFFER_SWEEP_FIRST_MS < OFFER_SWEEP_INTERVAL_MS, `the default first offer sweep (${OFFER_SWEEP_FIRST_MS} ms) comes before the first interval (${OFFER_SWEEP_INTERVAL_MS} ms)`);

  const listed = { addresses: () => ({ ok: false, reason: "listed" }), funding: async () => ({ ok: true }) };
  const { engine: e2 } = makeEngine("privacy-screen", { screen: listed });
  const sC = await mintSigned(e2, "privacy-c.example.org", "c@example.com");
  const refused = await attempt(() => e2.activateFromCredential(sC.header));
  ok(refused.error?.screenRejected === true && !holdsKey(e2, sC.addr) && markersFor(e2, sC.addr).length === 0, "a destroyed key takes its offer's marker with it");
}

// 11. Through the HTTP route: the settled-not-recorded answer reaches the buyer.
{
  const express = (await import("express")).default;
  const { mppSubscribeHandler } = await import("../src/mpp-subscribe-route.js");
  const { engine } = makeEngine("route");
  let stubError = null;
  const stub = { mintOffer: (a) => engine.mintOffer(a), activateFromCredential: async (h) => { if (stubError) throw stubError; return engine.activateFromCredential(h); } };
  const app = express();
  app.use(express.json());
  app.post("/subscribe", mppSubscribeHandler({ engine: stub, rateLimited: () => false, isCanary: () => false, warn: () => {} }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/subscribe`;
  const post = (headers = {}, body = { product: "domain-monitor", target: "route.example.org" }) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const unpaid = await post();
    const ch = Challenge.deserialize(unpaid.headers.get("www-authenticate"));
    ok(unpaid.status === 402, `setup: the route mints a challenge (${unpaid.status})`);
    const signed = await signCredential(ch);
    const restore = failSubWrites(engine);
    const res = await post({ authorization: signed.header });
    restore();
    const body = await res.json();
    ok(res.status === 500 && /payment settled/i.test(body.error || "") && /before the payment challenge expires/.test(body.error) && body.paymentSettled === true,
      `the buyer reads that the payment settled and what happens next (${res.status} ${body.error})`);
    const again = await post({ authorization: signed.header });
    const againBody = await again.json();
    ok(again.status === 200 && againBody.status === "active", `the same request sent again inside the window receives the subscription (${again.status})`);
    stubError = Object.assign(new Error("The first subscription payment settled, but the subscription could not be recorded."), { statusCode: 500 });
    const plain = await (await post({ authorization: signed.header })).json();
    ok(plain.error === "Could not complete the subscription right now.", `control: an unflagged 5xx with the same words keeps the route's own text (${plain.error})`);
  } finally { server.close(); }
}

// 12. A retry rebuilt the subscription between the failed write and the booking: the debt is voided.
{
  let racer = null, raced = null;
  const refunds = { ...realLedger, recordOwed: async (row) => { if (racer) { const go = racer; racer = null; raced = await attempt(go); } return realLedger.recordOwed(row); } };
  const { engine, calls } = makeEngine("race", { refunds });
  const s12 = await mintSigned(engine, "race.example.org", "race@example.com");
  racer = () => engine.activateFromCredential(s12.header);
  const restore = failSubWrites(engine);
  const first = await attempt(() => engine.activateFromCredential(s12.header));
  restore();
  const ev = `0x${txSeq.toString(16).padStart(64, "a")}`;
  ok(raced?.value?.status === "active", `setup: the concurrent retry was served (${raced?.value?.status || raced?.error?.message})`);
  ok(first.value?.status === "active" && first.value.replay === true, `the first call answers with the served subscription (${first.value?.status || first.error?.message})`);
  ok((await rowFor(ev))?.status === "void" && calls.sales.length === 1, `the debt booked after it was served is voided: never served and refunded (${(await rowFor(ev))?.status})`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed${process.exitCode ? ", FAILURES above" : ""}`);
process.exit(process.exitCode || 0);
