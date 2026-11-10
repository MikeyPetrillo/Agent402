// An MPP subscription's signing key lives only while a later period can be
// pulled (src/mpp-subscriptions.js KEY LIFETIME). Offline: real mppx codec
// objects and real signed key authorizations, injected settlement, a file
// store in a temp directory; the one real mppx call (renewSubscription) is
// handed a client factory that counts and throws, so nothing is sent.
//
// Proves, each beside a live control: after a cancel, after the signed expiry
// and after dunning gives up, no store entry and no byte of the store file
// carries the key in any encoding, and mppx's own renewal cannot reach its
// signing step; the reduced record keeps only TOMBSTONE_FIELDS and is deleted
// after ENDED_RECORD_KEEP_MS and not before; the sweep brings in records ended
// before it existed, bounded per run and idempotent; a live subscription keeps
// its key and renews; no captured log line carries key bytes.
//   node scripts/test-mpp-subscription-key-lifetime.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import * as Tempo from "mppx/tempo";
import { tempo as tempoServer } from "mppx/server";
import { KeyAuthorization } from "ox/tempo";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createMppSubscriptions, periodMs, PERIOD_COUNT, PERIOD_UNIT, SUBSCRIPTION_TERM_MS, PAST_DUE_GRACE_MS,
  TEMPO_MAINNET_CHAIN_ID, KEY_GONE_PREFIX, TOMBSTONE_FIELDS,
} from "../src/mpp-subscriptions.js";
import { ENDED_RECORD_KEEP_MS, ENDED_SWEEP_INTERVAL_MS, ENDED_SWEEP_MAX_PER_RUN, endedRecordRetentionPublic } from "../src/mpp-subscription-retention.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const SECRET = "test-mpp-secret";
const REALM = "agent402.test";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";
const PERIOD = periodMs();
const DAY = 86_400_000;

const tmp = mkdtempSync(join(tmpdir(), "a402-mppsubs-key-"));
process.env.MPP_SECRET_KEY = SECRET;
process.env.TEMPO_RECIPIENT_ADDRESS = RECIPIENT;
process.env.TEMPO_CURRENCY = "usdc";
process.env.TEMPO_DECIMALS = "6";
process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = "0x" + "11".repeat(32); // throwaway: nothing is broadcast
delete process.env.MPP_SUBSCRIPTIONS;
process.env.TEMPO_RPC_URL = "http://127.0.0.1:9/never-called";

// Every line anything logs while this file runs, searched for key bytes at the end.
const logs = [];
for (const k of ["log", "warn", "error", "info"]) {
  const real = console[k].bind(console);
  console[k] = (...a) => { logs.push(a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ")); real(...a); };
}

// The engine clock. Subscriptions are activated 40 days before the real
// clock, so mppx's own renewal (which reads the real clock) finds a period due.
let clock = Date.now() - 40 * DAY;
const advance = (ms) => { clock += ms; };

function makeEngine(name) {
  const calls = { activate: 0, charge: 0 };
  let chargeBehavior = () => ({ reference: `0xtx${calls.charge}` });
  const path = join(tmp, `${name}.json`);
  const engine = createMppSubscriptions({
    secretKey: SECRET, realm: REALM, storePath: path, now: () => clock,
    log: (m) => logs.push(String(m)),
    activate: async (_header, ctx) => {
      calls.activate++;
      await engine._subStore.put({
        accessKey: { accessKeyAddress: ctx.accessKey.accessKeyAddress, keyType: ctx.accessKey.keyType },
        amount: String(ctx.binding.amountAtomic), billingAnchor: new Date(clock).toISOString(),
        chainId: TEMPO_MAINNET_CHAIN_ID, currency: CURRENCY, keyAuthorization: ctx.binding.credential.payload.signature,
        lastChargedPeriod: 0, lookupKey: ctx.lookupKey, payer: { address: ctx.payer, chainId: TEMPO_MAINNET_CHAIN_ID },
        periodCount: String(PERIOD_COUNT), periodUnit: PERIOD_UNIT, recipient: RECIPIENT, reference: "0xactivation",
        subscriptionExpires: ctx.binding.challenge.request.subscriptionExpires,
        subscriptionId: `sub-${name}-${calls.activate}`, timestamp: new Date(clock).toISOString(),
      });
      return { receipt: { method: "tempo", status: "success", reference: "0xactivation", timestamp: new Date(clock).toISOString() } };
    },
    findRenewalOnChain: async () => ({ found: false }),
    chargePeriod: async (rec, { periodIndex }) => {
      calls.charge++;
      const r = await chargeBehavior(rec, periodIndex);
      if (r instanceof Error) throw r;
      const mppxRec = await engine._subStore.get(rec.mppxSubscriptionId);
      await engine._subStore.put({ ...mppxRec, lastChargedPeriod: periodIndex, reference: r.reference });
      return r;
    },
  });
  return { engine, calls, path, setCharge: (fn) => { chargeBehavior = fn; } };
}
async function subscribe(engine, { product = "domain-monitor", target = "example.com", email = "owner@example.com" } = {}) {
  const offer = await engine.mintOffer({ product, target, email });
  const challenge = Challenge.deserialize(offer.header);
  const account = privateKeyToAccount(generatePrivateKey());
  const signed = await Tempo.Subscription.signSubscriptionKeyAuthorization({
    accessKey: challenge.request.methodDetails.accessKey, account, challengeId: challenge.id, chainId: TEMPO_MAINNET_CHAIN_ID, request: challenge.request,
  });
  const credential = Credential.from({ challenge, payload: { type: "keyAuthorization", signature: KeyAuthorization.serialize(signed) } });
  const sub = await engine.activateFromCredential(`Payment ${Credential.serialize(credential).replace(/^Payment\s+/i, "")}`);
  return { sub, rec: await engine._readRec(sub.subId) };
}

// The private key held for an access key address, read BEFORE it is destroyed,
// and every form its bytes could take in a serialized record.
const everyKey = [];
function keyOf(engine, address) {
  const hit = Object.values(engine._store._snapshot()).find((v) => v && typeof v === "object" && typeof v.privateKey === "string" && String(v.accessKeyAddress).toLowerCase() === String(address).toLowerCase());
  if (hit) everyKey.push(hit.privateKey);
  return hit ? hit.privateKey : null;
}
function encodingsOf(privateKey) {
  const hex = privateKey.replace(/^0x/i, "").toLowerCase();
  const bytes = Buffer.from(hex, "hex");
  return [hex, bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("base64").replace(/=+$/, ""), JSON.stringify([...bytes]).slice(1, -1)];
}
const carries = (text, privateKey) => { const t = String(text); const low = t.toLowerCase(); return encodingsOf(privateKey).some((e, i) => (i === 0 ? low.includes(e) : t.includes(e))); };
const fileHolds = (path, privateKey) => carries(readFileSync(path, "utf8"), privateKey);
const memHolds = (engine, privateKey) => carries(JSON.stringify(engine._store._snapshot()), privateKey);
const keyRecords = (engine, address) => Object.values(engine._store._snapshot()).filter((v) => v && typeof v === "object" && v.privateKey && String(v.accessKeyAddress || "").toLowerCase() === String(address).toLowerCase()).length;

// mppx's own renewal against the engine's store. With the key held it reaches
// the client factory (its last step before signing), which counts and throws;
// without the key it must stop before that. Returns "reached-signing" or the
// reason it stopped.
async function mppxRenewal(engine, rec) {
  let reached = 0;
  try {
    const out = await tempoServer.renewSubscription({
      subscriptionId: rec.mppxSubscriptionId, store: engine._store, recipient: RECIPIENT,
      getClient: () => { reached++; throw new Error("stub client: nothing is sent"); },
    });
    return reached ? "reached-signing" : `stopped: ${out === null ? "nothing to renew" : "returned"}`;
  } catch (e) {
    return reached ? "reached-signing" : `stopped: ${String(e?.reason || e?.message || e).slice(0, 80)}`;
  }
}

ok(endedRecordRetentionPublic().keepDays === ENDED_RECORD_KEEP_MS / DAY && ENDED_RECORD_KEEP_MS === PERIOD, `the reduced record is kept one billing period (${endedRecordRetentionPublic().keepDays} days), the figure /privacy prints`);
ok(!TOMBSTONE_FIELDS.includes("email") && !TOMBSTONE_FIELDS.includes("target") && !TOMBSTONE_FIELDS.includes("lastChargeError") && TOMBSTONE_FIELDS.includes("payer") && TOMBSTONE_FIELDS.includes("lastChargeTx"),
  "the reduced record names the wallet and the last transaction, never the email, the watched subject or error text");
const reducedOnly = (rec) => Object.keys(rec).every((k) => TOMBSTONE_FIELDS.includes(k) || ["tombstone", "endedAt", "keyDestroyedAt", "mppxCleared", "updatedAt"].includes(k));

// ---------------------------------------------------------------------------
// 1. Cancel: the key goes at the cancel, the record at the end of the paid
//    period plus the retention, and a live subscription beside it is untouched.
// ---------------------------------------------------------------------------
{
  const h = makeEngine("cancel");
  const { engine, calls, path } = h;
  const live = await subscribe(engine, { target: "live.example", email: "live@example.com" });
  const gone = await subscribe(engine, { target: "gone.example", email: "gone@example.com" });
  const liveKey = keyOf(engine, live.rec.accessKeyAddress), goneKey = keyOf(engine, gone.rec.accessKeyAddress);
  ok(liveKey && goneKey && liveKey !== goneKey, "control: each active subscription holds its own private key");
  ok(fileHolds(path, goneKey) && memHolds(engine, goneKey), "control: the key bytes are in the store file and in memory while the subscription is live (so the searches below can fail)");
  ok(carries(Buffer.from(goneKey.slice(2), "hex").toString("base64"), goneKey) && carries(goneKey.toUpperCase(), goneKey), "control: the search finds the key as hex in either case and as base64");

  advance(PERIOD / 2);
  const view = await engine.cancel(gone.sub.subId, gone.sub.manageToken);
  ok(view.status === "active" && view.cancelAtPeriodEnd === true, "a mid-period cancel keeps the subscriber active through the period already paid for");
  ok(keyRecords(engine, gone.rec.accessKeyAddress) === 0 && !fileHolds(path, goneKey) && !memHolds(engine, goneKey), "after the cancel no store entry, no byte of the store file and no in-memory copy carries the key, in any encoding");
  ok(!!(await engine._store.get(`${KEY_GONE_PREFIX}${gone.rec.accessKeyAddress}`)), "the destroyed key is marked, so a renewal still sending cannot write it back");
  ok((await engine._subStore.getAccessKeyByAddress(gone.rec.accessKeyAddress)) === null && (await engine._subStore.getAccessKey(gone.rec.lookupKey)) === null, "both lookups mppx signs from answer nothing for the canceled subscription");
  ok(engine.listActive("domain").some((r) => r.subId === gone.sub.subId) && (await engine._readRec(gone.sub.subId)).email === "gone@example.com", "the canceled subscriber is still served, with their record whole, until the paid period ends");

  // The live control: its key is intact and mppx's renewal reaches signing.
  ok(keyRecords(engine, live.rec.accessKeyAddress) > 0 && fileHolds(path, liveKey), "the live subscription beside it still holds its key");
  // (the engine clock is 20 days behind the real one here, so mppx sees a period due)
  const liveAttempt = await mppxRenewal(engine, live.rec);
  ok(liveAttempt === "reached-signing", `control: mppx's renewal of the live subscription reaches its signing step (${liveAttempt})`);
  const goneAttempt = await mppxRenewal(engine, gone.rec);
  ok(goneAttempt !== "reached-signing" && /access key is missing/.test(goneAttempt), `mppx's renewal of the canceled subscription cannot sign (${goneAttempt})`);

  // The paid period ends: nothing calls refreshStatus for a canceled
  // subscriber, so the sweep is what closes and reduces the record.
  advance(PERIOD / 2 + 60_000);
  const s1 = await engine.sweepEnded();
  const tomb = await engine._readRec(gone.sub.subId);
  ok(s1.closed === 1 && s1.reduced === 1 && s1.deleted === 0, `the sweep closes and reduces the record once its paid period has ended (${JSON.stringify(s1)})`);
  ok(tomb.status === "canceled" && tomb.tombstone === true && reducedOnly(tomb) && tomb.email === undefined && tomb.target === undefined, "the reduced record holds only the listed fields: no email, no watched subject");
  ok(tomb.payer === gone.rec.payer && tomb.subId === gone.sub.subId && tomb.lastChargeTx === gone.rec.lastChargeTx && tomb.canceledReason === "requested" && tomb.accessKeyAddress === gone.rec.accessKeyAddress, "it keeps the id, the wallet, the last transaction, the final state and the key's public address");
  ok(Math.abs(Date.parse(tomb.endedAt) - (Date.parse(gone.rec.billingAnchor) + PERIOD)) < 1000, "its end is the end of the period that was paid for");
  ok((await engine._subStore.get(gone.rec.mppxSubscriptionId)) === null && (await engine._subStore.getByKey(gone.rec.lookupKey)) === null, "mppx's own record of it (which carries the signed authorization) and the lookup pointer are deleted with it");
  ok(!JSON.stringify(engine._store._snapshot()).includes("gone@example.com") && !readFileSync(path, "utf8").includes("gone@example.com"), "the email is gone from the store and the file");
  ok(engine.publicView(tomb).status === "canceled" && engine.publicView(tomb).payer === gone.rec.payer && engine.manageTokenOk(gone.sub.subId, gone.sub.manageToken), "the subscriber's manage link still answers with the final state");
  ok(engine.listActive().every((r) => r.subId !== gone.sub.subId), "and it is no longer served");

  // The live subscription renews after the other key was destroyed.
  const before = calls.charge;
  ok(await engine.refreshStatus(live.sub.subId) === "active" && calls.charge === before + 1 && (await engine._readRec(live.sub.subId)).lastChargedPeriod === 1, "the live subscription renews (one charge) after the other subscription's key was destroyed");
  ok(keyRecords(engine, live.rec.accessKeyAddress) > 0 && (await engine._readRec(live.sub.subId)).email === "live@example.com", "and keeps its key and its whole record");

  // Retention: not before, then deleted.
  advance(ENDED_RECORD_KEEP_MS - 60_000 - 60_000);
  const s2 = await engine.sweepEnded();
  ok(s2.deleted === 0 && (await engine._readRec(gone.sub.subId))?.tombstone === true, "one minute before the retention period ends the reduced record is still there");
  advance(2 * 60_000);
  const s3 = await engine.sweepEnded();
  ok(s3.deleted === 1 && (await engine._readRec(gone.sub.subId)) === null && engine.get(gone.sub.subId) === null, `once ${ENDED_RECORD_KEEP_MS / DAY} days have passed since the end the reduced record is deleted (${JSON.stringify(s3)})`);
  ok(!engine._store._keys().some((k) => k.includes(gone.rec.mppxSubscriptionId)) && !readFileSync(path, "utf8").includes(gone.sub.subId), "nothing of the subscription is left in the store file");
  const s4 = await engine.sweepEnded();
  ok(s4.closed + s4.reduced + s4.keysDestroyed + s4.deleted === 0, "a further sweep finds nothing to do");
  ok(await engine.refreshStatus(gone.sub.subId) === null, "a status read of the deleted subscription answers unknown and writes nothing back");
  ok((await engine._readRec(gone.sub.subId)) === null && (await engine._readRec(live.sub.subId)).status === "active" && keyRecords(engine, live.rec.accessKeyAddress) > 0, "the live subscription is still whole after every sweep");
}

// ---------------------------------------------------------------------------
// 2. The signed expiry passes.
// ---------------------------------------------------------------------------
{
  const { engine, calls, path } = makeEngine("expiry");
  const a = await subscribe(engine, { target: "term.example" });
  const b = await subscribe(engine, { target: "term-sweep.example" });
  const aKey = keyOf(engine, a.rec.accessKeyAddress), bKey = keyOf(engine, b.rec.accessKeyAddress);
  ok(fileHolds(path, aKey) && fileHolds(path, bKey), "control: both keys are held before the signed expiry");
  advance(SUBSCRIPTION_TERM_MS + 60_000);
  ok(await engine.refreshStatus(a.sub.subId) === "expired" && calls.charge === 0, "past the signed expiry the subscription reads expired and nothing is charged");
  const ta = await engine._readRec(a.sub.subId);
  ok(ta.tombstone === true && reducedOnly(ta) && !fileHolds(path, aKey) && !memHolds(engine, aKey) && keyRecords(engine, a.rec.accessKeyAddress) === 0, "the status read that expires it destroys the key and reduces the record in the same step");
  ok(Math.abs(Date.parse(ta.endedAt) - Date.parse(a.rec.subscriptionExpires)) < 1000, "its end is the expiry the subscriber signed");
  ok(/access key is missing|stopped/.test(await mppxRenewal(engine, a.rec)) && (await mppxRenewal(engine, a.rec)) !== "reached-signing", "mppx's renewal of the expired subscription cannot sign");
  // The other one is never read by anyone: the sweep expires it.
  ok(fileHolds(path, bKey), "control: the subscription nobody read still holds its key");
  const s = await engine.sweepEnded();
  const tb = await engine._readRec(b.sub.subId);
  ok(s.closed === 1 && tb.status === "expired" && tb.tombstone === true && !fileHolds(path, bKey) && !memHolds(engine, bKey), `the sweep expires a subscription nobody read, destroys its key and reduces it (${JSON.stringify(s)})`);
}

// ---------------------------------------------------------------------------
// 3. Dunning gives up: the key is held while the charge can still be retried
//    and goes with the write that ends the subscription.
// ---------------------------------------------------------------------------
{
  const { engine, calls, path, setCharge } = makeEngine("unpaid");
  const u = await subscribe(engine, { target: "unpaid.example", email: "u@example.com" });
  const uKey = keyOf(engine, u.rec.accessKeyAddress);
  setCharge(() => new Error("transfer refused: insufficient funds"));
  advance(PERIOD + 1000);
  ok(await engine.refreshStatus(u.sub.subId) === "past_due" && calls.charge === 1, "a refused renewal leaves the subscription past due");
  ok(fileHolds(path, uKey) && keyRecords(engine, u.rec.accessKeyAddress) > 0 && (await engine._readRec(u.sub.subId)).email === "u@example.com", "control: while the charge can still be retried the key and the whole record are kept");
  advance(PAST_DUE_GRACE_MS + 1000);
  ok(await engine.refreshStatus(u.sub.subId) === "canceled", "past the grace window the failed renewal ends the subscription");
  const t = await engine._readRec(u.sub.subId);
  ok(t.tombstone === true && t.canceledReason === "unpaid" && reducedOnly(t) && t.lastChargeError === undefined && t.email === undefined, "the record is reduced by that same write: final state kept, error text and email removed");
  ok(!fileHolds(path, uKey) && !memHolds(engine, uKey) && keyRecords(engine, u.rec.accessKeyAddress) === 0, "and no store entry or file byte carries the key");
  const charges = calls.charge;
  ok(await engine.refreshStatus(u.sub.subId) === "canceled" && calls.charge === charges && (await mppxRenewal(engine, u.rec)) !== "reached-signing", "a later renewal attempt charges nothing and cannot sign");
}

// ---------------------------------------------------------------------------
// 4. Records that ended before the sweep existed, the per-run bound, and a
//    second run.
// ---------------------------------------------------------------------------
{
  clock = Date.now() - 40 * DAY; // back behind the real clock, so mppx's renewal of the live control finds a period due
  const { engine, path } = makeEngine("backlog");
  const live = await subscribe(engine, { target: "backlog-live.example" });
  const old = [];
  for (let i = 0; i < 4; i++) {
    const s = await subscribe(engine, { target: `old-${i}.example`, email: `old${i}@example.com` });
    const key = keyOf(engine, s.rec.accessKeyAddress);
    // As the previous build left it: status canceled, the whole record and the key kept.
    const endedAgo = i === 3 ? ENDED_RECORD_KEEP_MS + 5 * DAY : (i + 1) * DAY;
    await engine._writeRec({ ...s.rec, status: "canceled", cancelAtPeriodEnd: true, canceledAt: new Date(clock - endedAgo).toISOString(), canceledReason: "unpaid", lastChargeError: "node said: something long" });
    old.push({ ...s, key });
  }
  ok(old.every((o) => fileHolds(path, o.key)), "control: four ended records from before the sweep still hold their keys");
  const r1 = await engine.sweepEnded({ max: 2 });
  ok(r1.reduced === 2 && r1.more === true && old.filter((o) => fileHolds(path, o.key)).length === 2, `one run changes at most its bound and says more is waiting (${JSON.stringify(r1)})`);
  const r2 = await engine.sweepEnded();
  ok(r2.reduced === 2 && r2.deleted === 1 && r2.more === false && old.every((o) => !fileHolds(path, o.key) && !memHolds(engine, o.key)), `the next run finishes the rest: every key gone, and the record that ended longer ago than the retention is deleted (${JSON.stringify(r2)})`);
  const left = await Promise.all(old.map((o) => engine._readRec(o.sub.subId)));
  ok(left[3] === null && left.slice(0, 3).every((t) => t?.tombstone === true && reducedOnly(t) && t.email === undefined && t.lastChargeError === undefined), "the three inside the retention are reduced records; their emails and error text are gone");
  ok(Math.abs(Date.parse(left[0].endedAt) - (clock - DAY)) < 1000, "a record that ended before the sweep existed counts its retention from when it ended, not from the sweep");
  const r3 = await engine.sweepEnded();
  ok(r3.closed + r3.reduced + r3.keysDestroyed + r3.deleted === 0 && r3.more === false, "a third run changes nothing (idempotent)");
  ok(keyRecords(engine, live.rec.accessKeyAddress) > 0 && (await engine._readRec(live.sub.subId)).status === "active" && (await mppxRenewal(engine, live.rec)) === "reached-signing", "the live subscription in the same store kept its key through every run");
  const sweepLines = logs.filter((l) => /ended-subscription sweep:/.test(l));
  ok(sweepLines.length >= 2 && sweepLines.every((l) => !/0x[0-9a-fA-F]{8}/.test(l) && !/@/.test(l)), "the sweep logs counts only: no wallet, no id, no email");
  ok(ENDED_SWEEP_MAX_PER_RUN > 0 && ENDED_SWEEP_INTERVAL_MS >= 60_000, "the sweep has a per-run bound and an interval");
  engine.start({ intervalMs: 3_600_000, firstMs: 3_600_000 }); engine.stop();
}

// ---------------------------------------------------------------------------
// 5. Nothing logged carries key bytes.
// ---------------------------------------------------------------------------
{
  const all = logs.join("\n");
  ok(everyKey.length >= 9 && logs.length > 30, `control: ${everyKey.length} private keys were read from the stores and ${logs.length} log lines captured`);
  ok(carries(`x ${everyKey[0]} y`, everyKey[0]), "control: the log search finds a key when one is present");
  ok(everyKey.every((k) => !carries(all, k)), "no captured log line (engine, console) carries any key's bytes in any encoding");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, 0 failed`);
