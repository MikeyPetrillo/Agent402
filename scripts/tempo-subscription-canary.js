// LIVE verification of the MPP RECURRING SUBSCRIPTION rail (tempo/subscription)
// against production: a real mppx client, signed by the existing EVM canary
// burner, subscribes for real money and is then billed a real SECOND period by
// our server pulling on the delegated access key it holds.
//
// Why this exists, and why it is not the charge canary:
//   scripts/test-mpp-subscriptions.js (99 assertions) proves OUR logic against
//   injected activate/chargePeriod stubs. The charge rail learned twice, live,
//   that a stub proves nothing about the wire (a decimal `amount` made the
//   client throw before signing; `decimals` ON the wire made the relay expect
//   1,000,000,000 base units for a 1,000-unit transfer). Subscriptions have
//   MORE unproven wire than charge did, and one structurally riskier half.
//
// The two halves, and which one matters:
//   1. ACTIVATION - the buyer is present and signs. This is charge-shaped:
//      402 -> credential -> period 0 settles on-chain.
//   2. RENEWAL - THE HALF WORTH PROVING. No buyer is present. Our server signs
//      a transfer with a delegated access key it holds and broadcasts it to a
//      Tempo RPC. There is no relay in this path, so there is no relay verdict
//      to read and no confirm-fallback to save us: if this half is wrong, a
//      subscription silently stops billing (we serve for free) or bills wrong.
//      A 30-day period puts it beyond any canary, which is exactly why the
//      canary product bills in mppx's `dev_second` unit.
//
// The canary product (`rail-canary`, src/mpp-subscriptions.js) is NOT in
// MONITOR_PRODUCTS, so listActive() cannot hand it to the monitor scheduler: it
// can never produce a paid report or send an email. It is mintable only for a
// caller carrying the POW_SECRET-signed heartbeat token, which also books both
// settlements as our own money rather than external demand.
//
// Cost per run: 2 x $0.01 from the canary burner to our own payTo, plus Tempo
// fees. The money is ours on both ends; the fees are the real spend.
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { Mppx, tempo } from "mppx/client";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) {
  console.error("tempo-subscription-canary: no BURNER_KEY - cannot run");
  process.exit(2);
}
const secret = (process.env.POW_SECRET || "").trim();
if (!secret) {
  // Unlike the charge canary this is FATAL, not a warning: without the token the
  // canary product is not mintable at all, so the run could only ever test the
  // real $9 products against a live scheduler. Refuse rather than do that.
  console.error("tempo-subscription-canary: no POW_SECRET - the canary product is not mintable without it");
  process.exit(2);
}

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
console.log(`buyer: ${account.address}`);
console.log(`target: ${TARGET}`);

const hb = () => createHmac("sha256", secret)
  .update(`heartbeat:${Math.floor(Date.now() / 60_000)}`)
  .digest("base64url").slice(0, 32);

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// autoSwap for the same reason the charge canary carries it: the burner holds
// both PathUSD and USDC.e and prod's TEMPO_CURRENCY decides which the challenge
// quotes. A no-op when they already match.
const mppxClient = Mppx.create({
  methods: [tempo.subscription({ account }), tempo.charge({ account, autoSwap: true })],
});

let sawChallenge = false, sawCredential = false, credentialRounds = 0, paymentFailure = null;
mppxClient.onChallengeReceived(() => { sawChallenge = true; console.log("challenge received"); });
mppxClient.onCredentialCreated(() => { sawCredential = true; credentialRounds++; console.log("credential created (key authorization signed by the burner)"); });
mppxClient.onPaymentFailed((e) => {
  paymentFailure = e;
  console.error("PAYMENT FAILED event:", JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 800));
});

// --- 0. discovery ----------------------------------------------------------
// The free surface an agent reads before it subscribes. A canary that skipped
// this would not notice the rail going dark for buyers who have not already
// hardcoded the route.
const offerRes = await fetch(`${TARGET}/api/mpp/monitors`).catch((e) => { fail(`discovery fetch threw: ${e?.message || e}`); });
if (!offerRes.ok) fail(`GET /api/mpp/monitors returned ${offerRes.status}, expected 200`);
const offer = await offerRes.json().catch(() => null);
if (!Array.isArray(offer?.products) || offer.products.length === 0) fail("discovery lists no subscribable products");
console.log(`discovery: ${offer.products.length} product(s), currency ${offer.currency || "?"}`);
// The canary product must NOT be advertised: it is heartbeat-gated, and a
// public listing would be the leak.
if (offer.products.some((p) => p.product === "rail-canary")) fail("the rail-canary product is PUBLICLY ADVERTISED - it must never appear on the open offer");

// --- 1. activation ---------------------------------------------------------
console.log("\n--- activation (buyer present, signs the standing authorization) ---");
let res;
try {
  res = await mppxClient.fetch(`${TARGET}/api/mpp/monitors/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Heartbeat-Token": hb() },
    body: JSON.stringify({ product: "rail-canary", target: `canary-${Date.now()}` }),
  });
} catch (e) {
  fail(`subscribe fetch threw: ${e?.message || e}`);
}
const bodyText = await res.text();
console.log(`status: ${res.status}`);
console.log(`payment-receipt header: ${res.headers.get("payment-receipt") || "(none)"}`);
console.log(`body: ${bodyText.slice(0, 600)}`);

if (!sawChallenge) fail("never saw a 402 challenge - the client did not reach the subscribe paywall");
if (!sawCredential) fail("never signed a key authorization - challenge selection or signing failed");
if (paymentFailure) fail("mppx reported a payment.failed event during activation");
if (res.status !== 200) fail(`activation status ${res.status}, expected 200`);

let sub;
try { sub = JSON.parse(bodyText); } catch { fail("activation body is not valid JSON"); }
if (!sub?.subId || !sub.subId.startsWith("mpp_")) fail(`activation returned no subscription id (got ${JSON.stringify(sub?.subId)})`);
if (sub.status !== "active") fail(`activation left status ${sub.status}, expected active`);
if (!sub.manageToken) fail("activation returned no manage token - the subscription cannot be read back or canceled");
// Period 0 must have SETTLED, not merely been recorded. The reference is the
// on-chain proof; without it we would be calling an unpaid subscription active.
if (!sub.lastChargeTx) fail("activation recorded no on-chain reference for period 0 - nothing proves the first period settled");
if (sub.lastChargedPeriod !== 0) fail(`activation left lastChargedPeriod ${sub.lastChargedPeriod}, expected 0`);
const periodSeconds = Number(sub.periodSeconds);
if (!Number.isFinite(periodSeconds) || periodSeconds <= 0) fail(`subscription carries no usable period length (${sub.periodSeconds})`);
if (periodSeconds > 600) fail(`period is ${periodSeconds}s - too long to prove a renewal; the canary product must bill in dev_second`);
console.log(`ACTIVATED ${sub.subId} - period 0 settled, tx ${sub.lastChargeTx}, period ${periodSeconds}s, $${sub.priceUsdPerPeriod}/period`);

const manageUrl = (extra = "") =>
  `${TARGET}/api/mpp/monitors/${encodeURIComponent(sub.subId)}?token=${encodeURIComponent(sub.manageToken)}${extra}`;

// Always try to cancel, whatever happens next: a canary that leaves a live
// standing authorization behind on every failed run is its own slow leak.
let canceled = false;
async function cleanup() {
  if (canceled) return;
  canceled = true;
  try {
    const c = await fetch(`${TARGET}/api/mpp/monitors/${encodeURIComponent(sub.subId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Heartbeat-Token": hb() },
      body: JSON.stringify({ token: sub.manageToken }),
    });
    console.log(`cleanup: cancel returned ${c.status}`);
  } catch (e) { console.warn(`cleanup: cancel threw ${e?.message || e}`); }
}

// Anything unexpected from here on must still cancel: an uncaught throw would
// otherwise leave a live standing authorization on the burner.
process.on("uncaughtException", async (e) => { await cleanup(); console.error("FAIL: uncaught", e?.message || e); process.exit(1); });
process.on("unhandledRejection", async (e) => { await cleanup(); console.error("FAIL: unhandled rejection", e?.message || e); process.exit(1); });

// --- 2. renewal (the half worth proving) -----------------------------------
console.log(`\n--- renewal (no buyer present; our delegated key pulls) ---`);
console.log(`waiting ${periodSeconds + 5}s for period 1 to come due...`);
await sleep((periodSeconds + 5) * 1000);

// refresh=1 drives refreshStatus, which is where a due period is pulled. It is
// accepted only for canary subscriptions, read from the stored record.
let after = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  const r = await fetch(manageUrl("&refresh=1"), { headers: { "X-Heartbeat-Token": hb() } });
  if (!r.ok) { await cleanup(); fail(`manage read returned ${r.status}, expected 200`); }
  after = await r.json().catch(() => null);
  if (!after) { await cleanup(); fail("manage read body is not valid JSON"); }
  console.log(`attempt ${attempt}: status=${after.status} lastChargedPeriod=${after.lastChargedPeriod} tx=${after.lastChargeTx || "(none)"}`);
  if (after.lastChargedPeriod > 0) break;
  // A pull that is genuinely in flight, or a backoff window from a first
  // failure, both look like "not yet" for a few seconds.
  if (attempt < 3) await sleep(12_000);
}
// A first pull that failed on a slow RPC is retried by the server after its
// TRANSIENT backoff (2 min, src/mpp-subscriptions.js) - and, if the send was
// the ambiguous step, only after the chain has been read. Give that one
// retry its window before calling the rail broken.
if (after && after.lastChargedPeriod <= 0 && after.status === "past_due") {
  console.log("first pull did not land; waiting 135s for the server's transient retry (chain checked first if the send was ambiguous)...");
  await sleep(135_000);
  for (let attempt = 4; attempt <= 5; attempt++) {
    const r = await fetch(manageUrl("&refresh=1"), { headers: { "X-Heartbeat-Token": hb() } });
    if (!r.ok) { await cleanup(); fail(`manage read returned ${r.status}, expected 200`); }
    after = await r.json().catch(() => null);
    if (!after) { await cleanup(); fail("manage read body is not valid JSON"); }
    console.log(`attempt ${attempt}: status=${after.status} lastChargedPeriod=${after.lastChargedPeriod} tx=${after.lastChargeTx || "(none)"}`);
    if (after.lastChargedPeriod > 0) break;
    if (attempt < 5) await sleep(15_000);
  }
}

await cleanup();

if (!after) fail("never read the subscription back after the renewal window");
if (after.lastChargedPeriod <= 0) {
  fail(`RENEWAL DID NOT HAPPEN - lastChargedPeriod is still ${after.lastChargedPeriod} after ${periodSeconds + 5}s plus retries. ` +
       `status=${after.status}. This is the pull half of the rail: our server holds a delegated key and could not move the buyer's money. ` +
       `A real subscriber in this state serves for free until the grace window ends. Check prod's [mpp-subs] log lines.`);
}
if (!after.lastChargeTx || after.lastChargeTx === sub.lastChargeTx) {
  fail(`renewal advanced the period counter to ${after.lastChargedPeriod} but carries no NEW on-chain reference ` +
       `(activation tx ${sub.lastChargeTx}, now ${after.lastChargeTx || "(none)"}). The counter moved without provable payment.`);
}
if (after.status !== "active") fail(`renewal left status ${after.status}, expected active`);

console.log(`RENEWED - period ${after.lastChargedPeriod} pulled with no buyer present, tx ${after.lastChargeTx}`);

if (credentialRounds > 1) {
  console.warn(`WARN  activation needed ${credentialRounds} signed credentials - the first attempt(s) were rejected or timed out; read prod's [mpp-subs] lines`);
}
console.log(`\nPASS - live tempo/subscription round trip confirmed against production:`);
console.log(`  activation: period 0 settled with the buyer present   (tx ${sub.lastChargeTx})`);
console.log(`  renewal:    period ${after.lastChargedPeriod} pulled on the delegated key   (tx ${after.lastChargeTx})`);
