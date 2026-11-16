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

function makeEngine(name, { writeMppxRecord = true } = {}) {
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

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed${process.exitCode ? ", FAILURES above" : ""}`);
process.exit(process.exitCode || 0);
