// MPP recurring subscriptions (src/mpp-subscriptions.js) - fully offline.
//
// House pattern is scripts/test-mpp-tempo-shim.js: prove OUR logic with real
// mppx codec objects and INJECTED settlement, never a live relay or RPC. The
// two things this file must not fake are the ones that bit the charge rail
// live: the WIRE SHAPE of a minted challenge (built through mppx's own codec,
// asserted field by field against an independently built one) and the INBOUND
// BINDING check (must reject a forged, foreign, expired, underpriced or
// retargeted challenge BEFORE anything that moves money is called).
//
// The key authorizations here are REAL: signed with viem accounts and verified
// through mppx's own verifySubscriptionKeyAuthorization, so the payer this
// engine records is cryptographically recovered, not asserted by the test.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import * as Tempo from "mppx/tempo";
import { KeyAuthorization } from "ox/tempo";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createMppSubscriptions, checkSubscriptionBinding, mppSubscriptionsEnabled,
  mppSubscriptionMethodAvailable, periodMs, PERIOD_COUNT, PERIOD_UNIT,
  SUBSCRIPTION_TERM_MS, PAST_DUE_GRACE_MS, CHARGE_BACKOFF_MS, TEMPO_MAINNET_CHAIN_ID,
  OFFER_SWEEP_AFTER_MS, MAX_OPEN_OFFERS,
  CANARY_PRODUCT_KEY, CANARY_PRODUCT, CANARY_PERIOD_SECONDS, productDefFor, isCanaryProduct,
  subscriptionFeePayerPolicy, SUB_FEE_PAYER_MAX_GAS,
  isTransientChargeError, TRANSIENT_CHARGE_BACKOFF_MS, isSendPhaseAmbiguity, expectedRenewalMemo,
} from "../src/mpp-subscriptions.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const SECRET = "test-mpp-secret";
const REALM = "agent402.test";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";
const PERIOD = periodMs();
const PRICE_ATOMIC = BigInt(MONITOR_PRODUCTS["domain-monitor"].price / 100 * 1e6);

const tmp = mkdtempSync(join(tmpdir(), "a402-mppsubs-"));
process.env.MPP_SECRET_KEY = SECRET;
process.env.TEMPO_RECIPIENT_ADDRESS = RECIPIENT;
process.env.TEMPO_CURRENCY = "usdc";
process.env.TEMPO_DECIMALS = "6";
// A throwaway key: this suite never broadcasts, but the rollout switch now
// requires a gas sponsor because the unsponsored mppx path signs a ZERO gas
// price and Tempo refuses it (measured live, three runs, -32000 "gas price is
// less than basefee").
process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = "0x" + "11".repeat(32);
delete process.env.MPP_SUBSCRIPTIONS;
delete process.env.TEMPO_RPC_URL;

// ---------------------------------------------------------------------------
// Group 0: what mppx actually offers, and the rollout switch.
// ---------------------------------------------------------------------------
ok(mppSubscriptionMethodAvailable(), "installed mppx exposes tempo/subscription (method, key-authorization verifier, store, background renew)");
ok(Tempo.Methods.subscription.intent === "subscription" && Tempo.Methods.subscription.name === "tempo", "the method is tempo/subscription");
ok(Array.isArray(Tempo.Methods.chargeModes) && !("supportedModes" in (Tempo.Methods.subscription.schema.request ?? {})), "chargeModes belongs to tempo/charge: the subscription request carries no mode field (it is always a server pull)");
ok(PERIOD === 30 * 24 * 3600 * 1000, `a monthly product is periodCount ${PERIOD_COUNT}/${PERIOD_UNIT} = ${PERIOD / 86400000} days (mppx has no "month" unit)`);

ok(mppSubscriptionsEnabled() === true, "rollout switch: enabled with MPP_SECRET_KEY + a Tempo recipient + a fee payer + the method present");
{
  const saved = process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
  delete process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
  ok(mppSubscriptionsEnabled() === false,
    "rollout switch: NO gas sponsor means the rail is not mounted at all - the unsponsored mppx path signs a zero gas price, so every subscribe would 402 forever and advertising it would be a product we cannot deliver");
  process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = "not-a-key";
  ok(mppSubscriptionsEnabled() === false, "rollout switch: an unparseable sponsor key is treated as no sponsor, never as a silent fallback to the unsponsored path");
  process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = saved;
}
process.env.MPP_SUBSCRIPTIONS = "off";
ok(mppSubscriptionsEnabled() === false, "rollout switch: MPP_SUBSCRIPTIONS=off disarms it");
delete process.env.MPP_SUBSCRIPTIONS;
process.env.MPP_SECRET_KEY = "";
ok(mppSubscriptionsEnabled() === false, "rollout switch: no MPP_SECRET_KEY means no offer at all (nothing to bind a challenge to)");
process.env.MPP_SECRET_KEY = SECRET;
process.env.TEMPO_RECIPIENT_ADDRESS = "";
const savedWallet = process.env.WALLET_ADDRESS; process.env.WALLET_ADDRESS = "";
ok(mppSubscriptionsEnabled() === false, "rollout switch: no Tempo recipient means no offer (nobody to pay)");
process.env.TEMPO_RECIPIENT_ADDRESS = RECIPIENT;
if (savedWallet === undefined) delete process.env.WALLET_ADDRESS; else process.env.WALLET_ADDRESS = savedWallet;
ok(createMppSubscriptions({ secretKey: "", realm: REALM }) === null, "fail closed: an engine with no secret refuses to start");

// ---------------------------------------------------------------------------
// Harness. Injected settlement: `activate` writes the mppx-shaped record the
// real method would have written after settling period 0; `chargePeriod`
// advances mppx's own lastChargedPeriod. Every call is counted so the tests can
// prove nothing money-moving ran on a rejected credential.
// ---------------------------------------------------------------------------
let clock = Date.parse("2026-09-01T00:00:00.000Z");
const advance = (ms) => { clock += ms; };

function makeEngine(opts = {}) {
  const calls = { activate: 0, charge: 0, sales: [] };
  let chargeBehaviour = () => ({ reference: `0xtx${calls.charge}` });
  let findBehaviour = { found: false };
  const engine = createMppSubscriptions({
    secretKey: SECRET, realm: REALM,
    storePath: join(tmp, `${opts.name || "store"}.json`),
    now: () => clock,
    log: () => {},
    onCharge: (s) => calls.sales.push(s),
    validateTarget: opts.validateTarget,
    activate: async (header, ctx) => {
      calls.activate++;
      if (opts.activateThrows) throw new Error("simulated settlement failure: node said no");
      // What mppx's own activation persists after the first on-chain transfer.
      await engine._subStore.put({
        accessKey: { accessKeyAddress: ctx.accessKey.accessKeyAddress, keyType: ctx.accessKey.keyType },
        amount: String(ctx.binding.amountAtomic),
        billingAnchor: new Date(clock).toISOString(),
        chainId: TEMPO_MAINNET_CHAIN_ID,
        currency: CURRENCY,
        keyAuthorization: ctx.binding.credential.payload.signature,
        lastChargedPeriod: 0,
        lookupKey: ctx.lookupKey,
        payer: { address: ctx.payer, chainId: TEMPO_MAINNET_CHAIN_ID },
        periodCount: String(PERIOD_COUNT), periodUnit: PERIOD_UNIT,
        recipient: RECIPIENT,
        reference: "0xactivation",
        subscriptionExpires: ctx.binding.challenge.request.subscriptionExpires,
        subscriptionId: `sub-${calls.activate}`,
        timestamp: new Date(clock).toISOString(),
      });
      return { receipt: { method: "tempo", status: "success", reference: "0xactivation", timestamp: new Date(clock).toISOString() } };
    },
    findRenewalOnChain: async (args) => { calls.find = (calls.find || 0) + 1; return typeof findBehaviour === "function" ? findBehaviour(args) : findBehaviour; },
    chargePeriod: async (rec, { periodIndex }) => {
      calls.charge++;
      const r = chargeBehaviour(rec, periodIndex);
      if (r instanceof Error) throw r;
      // A real renewal advances mppx's own counter; mirror that so the engine
      // reads the authority rather than trusting our return value.
      const mppxRec = await engine._subStore.get(rec.mppxSubscriptionId);
      await engine._subStore.put({ ...mppxRec, lastChargedPeriod: periodIndex, reference: r.reference });
      return r;
    },
  });
  return { engine, calls, setCharge: (fn) => { chargeBehaviour = fn; }, setFind: (v) => { findBehaviour = v; } };
}

/** A real buyer: signs the challenge's key authorization with a viem account. */
async function signCredential(challenge, { account, accessKey } = {}) {
  const acct = account || privateKeyToAccount(generatePrivateKey());
  const ak = accessKey || challenge.request.methodDetails.accessKey;
  const signed = await Tempo.Subscription.signSubscriptionKeyAuthorization({
    accessKey: ak, account: acct, chainId: TEMPO_MAINNET_CHAIN_ID, request: challenge.request,
  });
  const credential = Credential.from({
    challenge,
    payload: { type: "keyAuthorization", signature: KeyAuthorization.serialize(signed) },
  });
  return { header: `Payment ${Credential.serialize(credential).replace(/^Payment\s+/i, "")}`, account: acct };
}

// ---------------------------------------------------------------------------
// Group 1: challenge minting is mppx's wire shape, not ours.
// ---------------------------------------------------------------------------
{
  const { engine } = makeEngine({ name: "mint" });
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "example.com", email: "a@b.co" });
  const ch = Challenge.deserialize(offer.header);
  ok(ch.method === "tempo" && ch.intent === "subscription", "minted challenge is tempo/subscription");
  ok(Challenge.verify(ch, { secretKey: SECRET }) === true, "minted challenge id HMAC-verifies against our secret");
  const r = ch.request;
  ok(r.amount === String(PRICE_ATOMIC), `amount rides as BASE UNITS "${r.amount}", never the decimal string`);
  ok(!("decimals" in r), "no `decimals` key on the wire (a server-side parsing input, and the exact drift that made the live relay reject every charge credential)");
  ok(r.methodDetails?.chainId === TEMPO_MAINNET_CHAIN_ID, "chainId rides under methodDetails");
  ok(/^0x[0-9a-f]{40}$/.test(r.methodDetails?.accessKey?.accessKeyAddress || ""), "methodDetails.accessKey names the server-owned access key");
  ok(r.methodDetails.accessKey.keyType === "secp256k1", "the access key declares its key type");
  ok(r.recipient.toLowerCase() === RECIPIENT.toLowerCase() && r.currency.toLowerCase() === CURRENCY.toLowerCase(), "recipient + currency are ours");
  ok(r.periodCount === String(PERIOD_COUNT) && r.periodUnit === PERIOD_UNIT, "billing period rides on the wire");

  // Byte-exact against an independently built challenge: same inputs through
  // Challenge.fromMethod must produce the same request object. This is what
  // catches a hand-assembled shape sneaking back in.
  const independent = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(Date.parse(ch.expires)), secretKey: SECRET,
    description: ch.description,
    meta: { product: "domain-monitor", target: "example.com", email: "a@b.co" },
    request: {
      amount: (MONITOR_PRODUCTS["domain-monitor"].price / 100).toFixed(6),
      accessKey: r.methodDetails.accessKey,
      chainId: TEMPO_MAINNET_CHAIN_ID, currency: CURRENCY, decimals: 6,
      periodCount: PERIOD_COUNT, periodUnit: PERIOD_UNIT, recipient: RECIPIENT,
      subscriptionExpires: new Date(Date.parse(r.subscriptionExpires)),
    },
  });
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
  ok(canon(independent.request) === canon(r), "minted request is field-for-field what mppx's own codec produces from the same inputs");
  ok(independent.id === ch.id, "and the HMAC-bound challenge id matches, which is the byte-level proof: the id is computed over the canonical serialization of realm|method|intent|request|expires|digest|opaque");
  ok(Math.abs(Date.parse(r.subscriptionExpires) - (clock + SUBSCRIPTION_TERM_MS)) < 1000, "the standing authorization is bounded by a signed term expiry");

  // Target validation runs BEFORE a challenge exists, like the card path.
  const { engine: strict } = makeEngine({ name: "validate", validateTarget: { domain: () => { const e = new Error("that domain does not parse"); e.statusCode = 400; e.buyerSafe = true; throw e; } } });
  let threw = null;
  try { await strict.mintOffer({ product: "domain-monitor", target: "nope" }); } catch (e) { threw = e; }
  ok(threw?.statusCode === 400 && /does not parse/.test(threw.message), "an unwatchable target is refused before any challenge is minted");
  let leaked = null;
  const { engine: leaky } = makeEngine({ name: "leak", validateTarget: { domain: () => { throw new Error("EDGAR said: <html>upstream body here</html>"); } } });
  try { await leaky.mintOffer({ product: "domain-monitor", target: "x.com" }); } catch (e) { leaked = e; }
  ok(leaked && !/upstream body/.test(leaked.message), "an upstream body is never relayed to the buyer (only buyerSafe messages pass)");
  ok((await engine.mintOffer({ product: "domain-monitor", target: "a.com" })).header !== offer.header, "each offer mints a FRESH access key, so one subscription can never be reused as another");
  let unknown = null;
  try { await engine.mintOffer({ product: "not-a-product", target: "x" }); } catch (e) { unknown = e; }
  ok(unknown?.statusCode === 400, "an unknown product is refused");
}

// ---------------------------------------------------------------------------
// Group 2: the inbound binding, and that it runs BEFORE anything settles.
// ---------------------------------------------------------------------------
{
  const { engine, calls } = makeEngine({ name: "binding" });
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "example.com" });
  const good = Challenge.deserialize(offer.header);
  const { header: goodHeader } = await signCredential(good);
  const b = checkSubscriptionBinding(goodHeader, { secretKey: SECRET, realm: REALM, now: clock });
  ok(b.ok === true && b.product === "domain-monitor" && b.target === "example.com", "binding accepts our own freshly minted challenge and recovers the bound product + target");

  const reject = async (label, header, match) => {
    const before = calls.activate;
    const v = checkSubscriptionBinding(header, { secretKey: SECRET, realm: REALM, now: clock });
    ok(v.ok === false && (!match || match.test(v.reason)), `binding refuses ${label} (${v.reason})`);
    let err = null;
    try { await engine.activateFromCredential(header); } catch (e) { err = e; }
    ok(err?.statusCode === 402 && calls.activate === before, `${label}: nothing settled - activation refused before any charge`);
  };

  // Forged: minted with a different secret (an attacker's own challenge).
  const forged = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(clock + 300_000), secretKey: "not-our-secret",
    meta: { product: "domain-monitor", target: "example.com" },
    request: { ...good.request, amount: "1", decimals: 6, subscriptionExpires: new Date(Date.parse(good.request.subscriptionExpires)), chainId: TEMPO_MAINNET_CHAIN_ID, accessKey: good.request.methodDetails.accessKey },
  });
  await reject("a forged challenge", (await signCredential(forged)).header, /HMAC-verify/);

  // Foreign: someone else's realm, our secret would not verify anyway, so mint
  // one that DOES verify but for another host.
  const foreign = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: "someone-else.example", expires: new Date(clock + 300_000), secretKey: SECRET,
    meta: { product: "domain-monitor", target: "example.com" },
    request: { ...good.request, decimals: 6, subscriptionExpires: new Date(Date.parse(good.request.subscriptionExpires)), chainId: TEMPO_MAINNET_CHAIN_ID, accessKey: good.request.methodDetails.accessKey },
  });
  await reject("a challenge minted for a different realm", (await signCredential(foreign)).header, /realm/);

  // Expired.
  const expired = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(clock - 1000), secretKey: SECRET,
    meta: { product: "domain-monitor", target: "example.com" },
    request: { ...good.request, decimals: 6, subscriptionExpires: new Date(Date.parse(good.request.subscriptionExpires)), chainId: TEMPO_MAINNET_CHAIN_ID, accessKey: good.request.methodDetails.accessKey },
  });
  await reject("an expired challenge", (await signCredential(expired)).header, /expired/);

  // Underpriced: legitimately OURS, but for less than the product costs.
  const cheap = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(clock + 300_000), secretKey: SECRET,
    meta: { product: "domain-monitor", target: "example.com" },
    request: { ...good.request, amount: "0.010000", decimals: 6, subscriptionExpires: new Date(Date.parse(good.request.subscriptionExpires)), chainId: TEMPO_MAINNET_CHAIN_ID, accessKey: good.request.methodDetails.accessKey },
  });
  await reject("an underpriced challenge", (await signCredential(cheap)).header, /below this product's price/);

  // Wrong recipient: paid to the buyer instead of us.
  const misdirected = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(clock + 300_000), secretKey: SECRET,
    meta: { product: "domain-monitor", target: "example.com" },
    request: { ...good.request, recipient: "0x1111111111111111111111111111111111111111", decimals: 6, subscriptionExpires: new Date(Date.parse(good.request.subscriptionExpires)), chainId: TEMPO_MAINNET_CHAIN_ID, accessKey: good.request.methodDetails.accessKey },
  });
  await reject("a challenge paying someone else", (await signCredential(misdirected)).header, /recipient/);

  // Wrong chain.
  const otherChain = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(clock + 300_000), secretKey: SECRET,
    meta: { product: "domain-monitor", target: "example.com" },
    request: { ...good.request, decimals: 6, subscriptionExpires: new Date(Date.parse(good.request.subscriptionExpires)), chainId: 42431, accessKey: good.request.methodDetails.accessKey },
  });
  await reject("a challenge on another chain", (await signCredential(otherChain)).header, /chainId/);

  // Retargeted: the same paid challenge pointed at a different target. `meta` is
  // NOT what the HMAC covers (Challenge.verify hashes `opaque`), so this is the
  // case that would slip through a naive read of challenge.meta.
  const retargeted = { ...good, meta: { product: "fund-monitor", target: "someone-elses-fund" } };
  const retargetedCred = Credential.from({ challenge: retargeted, payload: (Credential.deserialize(goodHeader)).payload });
  const rb = checkSubscriptionBinding(`Payment ${Credential.serialize(retargetedCred).replace(/^Payment\s+/i, "")}`, { secretKey: SECRET, realm: REALM, now: clock });
  ok(rb.ok === true && rb.product === "domain-monitor" && rb.target === "example.com", "rewriting challenge.meta cannot retarget a subscription: product + target are read from the HMAC-covered opaque");

  // A tempo/CHARGE credential must not be mistaken for a subscription.
  const chargeCh = Challenge.fromMethod(Tempo.Methods.charge, {
    realm: REALM, expires: new Date(clock + 300_000), secretKey: SECRET,
    request: { amount: "3.000000", chainId: TEMPO_MAINNET_CHAIN_ID, currency: CURRENCY, decimals: 6, recipient: RECIPIENT },
  });
  const chargeCred = Credential.from({ challenge: chargeCh, payload: { type: "hash", hash: "0x" + "11".repeat(32) } });
  const cb = checkSubscriptionBinding(`Payment ${Credential.serialize(chargeCred).replace(/^Payment\s+/i, "")}`, { secretKey: SECRET, realm: REALM, now: clock });
  ok(cb.ok === false && /not a tempo\/subscription challenge/.test(cb.reason), "a one-shot tempo/charge credential is not a subscription and is left to the charge gate");
  ok(checkSubscriptionBinding("Payment not-a-credential", { secretKey: SECRET, realm: REALM }).ok === false, "garbage in the Authorization header is refused, never thrown");
  ok(checkSubscriptionBinding(goodHeader, { secretKey: "", realm: REALM }).ok === false, "with no secret the binding refuses everything rather than accepting anything");

  // A signature over a DIFFERENT access key: the challenge is ours, but the
  // delegation is not to the key we hold. mppx accepts this when it is not
  // given an access key, so the engine must pass its own.
  const strangerKey = { accessKeyAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), keyType: "secp256k1" };
  const wrongDelegation = await signCredential(good, { accessKey: strangerKey });
  const beforeWrong = calls.activate;
  let wrongErr = null;
  try { await engine.activateFromCredential(wrongDelegation.header); } catch (e) { wrongErr = e; }
  ok(wrongErr?.statusCode === 402 && /key authorization did not verify/.test(wrongErr.message) && calls.activate === beforeWrong, "a key authorization delegating to an access key we do not hold is refused, and nothing settles");
}

// ---------------------------------------------------------------------------
// Group 3: activation, the scheduler-facing record, and replay.
// ---------------------------------------------------------------------------
const live = makeEngine({ name: "live" });
let liveSubId = null, liveHeader = null, liveToken = null, liveBuyer = null;
{
  const { engine, calls } = live;
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "example.com", email: "sub@example.com" });
  const signedCred = await signCredential(Challenge.deserialize(offer.header));
  liveHeader = signedCred.header; liveBuyer = signedCred.account;
  const result = await engine.activateFromCredential(liveHeader);
  liveSubId = result.subId; liveToken = result.manageToken;
  ok(calls.activate === 1 && result.status === "active", "a valid credential settles period 0 and activates");
  ok(result.subId.startsWith("mpp_"), "the subscription id is namespaced so server.js can route it to this engine");
  ok(typeof result.manageToken === "string" && result.manageToken.length > 20, "activation hands back a manage token (the subscriber's only bearer for cancel)");
  ok(calls.sales.length === 1 && calls.sales[0].priceUsd === 5 && calls.sales[0].payer === liveBuyer.address.toLowerCase(), "the first period is booked as a sale against the cryptographically recovered payer");

  await engine.warm();
  const active = engine.listActive();
  ok(active.length === 1, "listActive returns the new subscriber");
  const rec = active[0];
  for (const f of ["subId", "status", "product", "target", "email"]) ok(f in rec, `scheduler-facing record carries ${f} (same shape as the Stripe engine, so monitor-scheduler.js needs no change)`);
  ok(rec.status === "active" && rec.product === "domain-monitor" && rec.target === "example.com" && rec.email === "sub@example.com", "the record's values are the ones the challenge was bound to");
  ok(engine.listActive("domain").length === 1 && engine.listActive("fund").length === 0, "listActive filters by product kind exactly as the scheduler calls it");
  ok(engine.get(liveSubId)?.subId === liveSubId && engine.isMine(liveSubId) && !engine.isMine("sub_stripe123"), "get() and isMine() let server.js merge two engines without guessing");
  ok(!/privateKey|0x[0-9a-f]{64}/.test(JSON.stringify(rec)), "no key material ever reaches a subscriber-facing record");

  // Replay: the same credential a second time must not create a second
  // subscription or a second charge.
  const again = await engine.activateFromCredential(liveHeader);
  ok(again.replay === true && again.subId === liveSubId && calls.activate === 1 && calls.sales.length === 1, "replaying the activation credential returns the existing subscription and charges nothing again");
}

// ---------------------------------------------------------------------------
// Group 4: period accounting. One authorized transfer per period, pulled by us.
// ---------------------------------------------------------------------------
{
  const { engine, calls } = live;
  ok(await engine.refreshStatus(liveSubId) === "active" && calls.charge === 0, "inside the paid period refreshStatus is free: it confirms active without pulling anything");
  advance(PERIOD - 60_000);
  ok(await engine.refreshStatus(liveSubId) === "active" && calls.charge === 0, "one minute before the period ends, still no pull");
  advance(120_000);   // now one period past the anchor
  ok(await engine.refreshStatus(liveSubId) === "active" && calls.charge === 1, "the moment a new period starts, refreshStatus pulls exactly one transfer");
  ok(engine.get(liveSubId).lastChargedPeriod === 1, "the paid-period counter advances to mppx's own value, never our arithmetic");
  ok(calls.sales.length === 2 && calls.sales[1].periodIndex === 1, "the renewal is booked as a sale once");
  ok(await engine.refreshStatus(liveSubId) === "active" && calls.charge === 1, "a second refreshStatus in the same period does NOT pull again (one transfer per period)");
  advance(PERIOD);
  ok(await engine.refreshStatus(liveSubId) === "active" && calls.charge === 2, "the next period pulls once more");
  ok(await engine.refreshStatus("mpp_does-not-exist") === null, "an unknown subscription is null, never a status");
}

// ---------------------------------------------------------------------------
// Group 5: a failed period. Fail CLOSED - no paid report for a period nobody
// paid for - and never silence: the subscription lands in past_due, which the
// scheduler reads as not-active on exactly the gate the Stripe path uses.
// ---------------------------------------------------------------------------
{
  const h = makeEngine({ name: "dunning" });
  const { engine, calls } = h;
  const offer = await engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
  const { header } = await signCredential(Challenge.deserialize(offer.header));
  const sub = await engine.activateFromCredential(header);
  await engine.warm();

  h.setCharge(() => new Error("insufficient funds"));
  advance(PERIOD);
  const st = await engine.refreshStatus(sub.subId);
  ok(st === "past_due" && calls.charge === 1, "a period whose transfer does not confirm leaves the subscription past_due");
  const rec = engine.get(sub.subId);
  ok(rec.chargeFailures === 1 && rec.nextChargeAttemptAt, "the failure is recorded with a retry time (1h, doubling)");
  ok(rec.lastChargedPeriod === 0, "the paid-period counter does NOT advance on a failed charge");

  // The scheduler contract: stillActive() only proceeds on "active"/"trialing".
  const schedulerWouldRun = (s) => s == null || s === "active" || s === "trialing";
  ok(schedulerWouldRun(st) === false, "monitor-scheduler.js's stillActive() gate refuses a past_due subscription, so no paid report is produced");
  ok(engine.listActive("fund").length === 0, "and it stops appearing as an active subscriber once the status flips");

  // Backoff is honoured: no retry storm against the chain.
  const before = calls.charge;
  ok(await engine.refreshStatus(sub.subId) === "past_due" && calls.charge === before, "inside the backoff window no further pull is attempted");
  advance(CHARGE_BACKOFF_MS + 1000);
  ok(await engine.refreshStatus(sub.subId) === "past_due" && calls.charge === before + 1, "after the backoff it retries once");

  // A TRANSIENT failure (RPC slow, validBefore lapsed - canary run 33657453172)
  // retries in minutes; a refused transfer keeps the hour. Classified through
  // viem's shape: the server's words sit in `details` on a nested cause.
  {
    const viemShaped = Object.assign(new Error("Execution reverted for an unknown reason.\n\nRequest body: {...}"), { name: "EstimateGasExecutionError", cause: Object.assign(new Error("An internal error was received."), { details: "Revm error: transaction expired: current block timestamp 1788367998 >= validBefore 1788367996" }) });
    ok(isTransientChargeError(viemShaped) === true, "a validBefore-lapsed estimateGas error is transient (read from the nested cause's details)");
    ok(isTransientChargeError(new Error("insufficient funds for gas * price + value")) === false && isTransientChargeError(new Error("key authorization revoked")) === false, "a refused transfer is not transient");
    const t = makeEngine({ name: "transient" });
    const off = await t.engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
    const c = await signCredential(Challenge.deserialize(off.header));
    const ts = await t.engine.activateFromCredential(c.header);
    await t.engine.warm();
    t.setCharge(() => viemShaped);
    advance(PERIOD);
    ok(await t.engine.refreshStatus(ts.subId) === "past_due", "a transient charge failure still leaves the subscription past_due (fail closed)");
    const tr = t.engine.get(ts.subId);
    const wait = Date.parse(tr.nextChargeAttemptAt) - clock;
    ok(wait > 0 && wait <= TRANSIENT_CHARGE_BACKOFF_MS + 1000, `a transient failure retries in ${Math.round(TRANSIENT_CHARGE_BACKOFF_MS / 60000)} minutes, not an hour (got ${Math.round(wait / 1000)}s)`);
    t.setCharge(() => ({ reference: "0xafter-blip" }));
    advance(TRANSIENT_CHARGE_BACKOFF_MS + 1000);
    ok(await t.engine.refreshStatus(ts.subId) === "active" && t.engine.get(ts.subId).lastChargedPeriod === 1, "and the retry after the short backoff pulls the period");
  }

  // A SEND-PHASE failure (canary run 33659899394: eth_sendRawTransactionSync
  // timed out after the transfer was handed to the RPC) may have moved money.
  // The next pull asks the chain first; only "never landed" signs again.
  {
    const sendTimeout = Object.assign(new Error("The request took too long to respond.\n\nURL: https://rpc.tempo.xyz/\nRequest body: {\"method\":\"eth_sendRawTransactionSync\",\"params\":[\"0x76f9\"]}"), { name: "TimeoutError", details: "The request timed out." });
    ok(isSendPhaseAmbiguity(sendTimeout) === true, "a timeout on eth_sendRawTransactionSync is a send-phase ambiguity");
    const estimateTimeout = Object.assign(new Error("Request body: {\"method\":\"eth_estimateGas\"}"), { name: "TimeoutError", details: "The request timed out." });
    ok(isSendPhaseAmbiguity(estimateTimeout) === false && isTransientChargeError(estimateTimeout) === true, "a timeout BEFORE the send is transient but not ambiguous (nothing could have moved)");
    ok(isSendPhaseAmbiguity(new Error("eth_sendRawTransactionSync: insufficient funds")) === false, "a refusal that names the send call is not ambiguous");
    const memo = await expectedRenewalMemo({ lookupKey: "lk", subscriptionId: "mpp_x", periodIndex: 1 });
    ok(/^0x[0-9a-f]{64}$/.test(memo), `the expected memo is bytes32 (${memo.slice(0, 12)}...)`);
    // Pinned against mppx's OWN encoder (imported by file path: the package
    // does not export it) so a drift in their memo layout fails here, not on
    // a real renewal that then gets charged twice.
    const theirs = (await import("../node_modules/mppx/dist/tempo/Attribution.js")).encode({ serverId: "lk", challengeId: "renewal:mpp_x:1" });
    ok(theirs.toLowerCase() === memo.toLowerCase(), "our expected memo equals mppx's Attribution.encode for the same lookupKey + renewal reference");
    ok(memo.slice(10, 12) === "01" && memo.slice(32, 52) === "0".repeat(20), "memo layout: version byte 0x01 at offset 4, ten zero bytes (no clientId) at offset 15");
    ok((await expectedRenewalMemo({ lookupKey: "lk", subscriptionId: "mpp_x", periodIndex: 2 })) !== memo, "a different period is a different memo (the check is per period)");

    // (a) landed: the chain says the timed-out send settled -> recorded, never re-sent.
    const a = makeEngine({ name: "ambiguous-landed" });
    const offA = await a.engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
    const cA = await signCredential(Challenge.deserialize(offA.header));
    const subA = await a.engine.activateFromCredential(cA.header);
    await a.engine.warm();
    a.setCharge(() => sendTimeout);
    advance(PERIOD);
    ok(await a.engine.refreshStatus(subA.subId) === "past_due", "a send-phase failure leaves the subscription past_due");
    const recA = a.engine.get(subA.subId);
    ok(recA.unconfirmedCharge?.periodIndex === 1 && recA.unconfirmedCharge.at, "and remembers that period 1 has an UNCONFIRMED send");
    const chargesA = a.calls.charge;
    a.setFind(({ periodIndex, sinceMs }) => (periodIndex === 1 && sinceMs < clock ? { found: true, tx: "0xlanded" } : { found: false }));
    a.setCharge(() => ({ reference: "0xMUST-NOT-HAPPEN" }));
    advance(TRANSIENT_CHARGE_BACKOFF_MS + 1000);
    ok(await a.engine.refreshStatus(subA.subId) === "active", "the next pull asks the chain first and finds the transfer -> active");
    const afterA = a.engine.get(subA.subId);
    ok(afterA.lastChargedPeriod === 1 && afterA.lastChargeTx === "0xlanded" && !afterA.unconfirmedCharge, "the landed transaction is recorded as period 1's charge");
    ok(a.calls.charge === chargesA && a.calls.find === 1, "and NOTHING was signed again (no second transfer)");

    // (b) never landed: the chain says nothing -> charged now, once.
    const b = makeEngine({ name: "ambiguous-clean" });
    const offB = await b.engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
    const cB = await signCredential(Challenge.deserialize(offB.header));
    const subB = await b.engine.activateFromCredential(cB.header);
    await b.engine.warm();
    b.setCharge(() => sendTimeout);
    advance(PERIOD);
    ok(await b.engine.refreshStatus(subB.subId) === "past_due", "(b) send-phase failure -> past_due");
    b.setFind({ found: false });
    b.setCharge(() => ({ reference: "0xsecond-try" }));
    advance(TRANSIENT_CHARGE_BACKOFF_MS + 1000);
    ok(await b.engine.refreshStatus(subB.subId) === "active" && b.engine.get(subB.subId).lastChargeTx === "0xsecond-try" && !b.engine.get(subB.subId).unconfirmedCharge, "(b) the chain shows no transfer -> charged now, flag cleared");

    // (c) chain unreadable: wait, never sign.
    const c = makeEngine({ name: "ambiguous-unreadable" });
    const offC = await c.engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
    const cC = await signCredential(Challenge.deserialize(offC.header));
    const subC = await c.engine.activateFromCredential(cC.header);
    await c.engine.warm();
    c.setCharge(() => sendTimeout);
    advance(PERIOD);
    await c.engine.refreshStatus(subC.subId);
    const chargesC = c.calls.charge;
    c.setFind(null);
    c.setCharge(() => ({ reference: "0xMUST-NOT-HAPPEN" }));
    advance(TRANSIENT_CHARGE_BACKOFF_MS + 1000);
    ok(await c.engine.refreshStatus(subC.subId) === "past_due" && c.calls.charge === chargesC, "(c) an unreadable chain waits and signs nothing");
    ok(Date.parse(c.engine.get(subC.subId).nextChargeAttemptAt) - clock <= TRANSIENT_CHARGE_BACKOFF_MS + 1000, "(c) and retries the chain read on the short backoff");
  }

  // Recovery.
  h.setCharge(() => ({ reference: "0xrecovered" }));
  advance(2 * CHARGE_BACKOFF_MS + 1000);
  ok(await engine.refreshStatus(sub.subId) === "active", "a later successful pull clears past_due and the subscriber is served again");
  ok(engine.get(sub.subId).chargeFailures === 0 && engine.get(sub.subId).lastChargeError === null, "the failure episode is closed out");

  // Give up: a period that never clears within the grace window ends it.
  h.setCharge(() => new Error("access key revoked by the payer"));
  advance(PERIOD);
  ok(await engine.refreshStatus(sub.subId) === "past_due", "the buyer revoking the access key lands in past_due, the same fail-closed place");
  advance(PAST_DUE_GRACE_MS + 1000);
  ok(await engine.refreshStatus(sub.subId) === "canceled", "past the grace window the subscription is canceled as unpaid");
  const chargesAtCancel = calls.charge;
  advance(10 * PERIOD);
  ok(await engine.refreshStatus(sub.subId) === "canceled" && calls.charge === chargesAtCancel, "a canceled subscription is never pulled from again");
  ok(engine.listActive().length === 0, "and never served again");
}

// ---------------------------------------------------------------------------
// Group 6: cancellation.
// ---------------------------------------------------------------------------
{
  const h = makeEngine({ name: "cancel" });
  const { engine, calls } = h;
  const offer = await engine.mintOffer({ product: "recall-monitor", target: "losartan" });
  const { header } = await signCredential(Challenge.deserialize(offer.header));
  const sub = await engine.activateFromCredential(header);
  await engine.warm();

  let denied = null;
  try { await engine.cancel(sub.subId, "guessed-token"); } catch (e) { denied = e; }
  ok(denied?.statusCode === 403, "cancel requires the manage token: the subscription id alone is not enough (report links carry ids)");
  let missing = null;
  try { await engine.cancel("mpp_nope", sub.manageToken); } catch (e) { missing = e; }
  ok(missing?.statusCode === 404, "cancelling an unknown subscription is a 404, not a silent success");

  advance(PERIOD / 2);
  const canceled = await engine.cancel(sub.subId, sub.manageToken);
  ok(canceled.cancelAtPeriodEnd === true && canceled.status === "active", "cancelling mid-period keeps the subscriber active through the period they already paid for");
  ok(await engine.refreshStatus(sub.subId) === "active" && calls.charge === 0, "and pulls nothing more");
  ok(engine.listActive("recall").length === 1, "they keep being served until the paid period runs out");

  advance(PERIOD);
  ok(await engine.refreshStatus(sub.subId) === "canceled" && calls.charge === 0, "when the paid period ends the subscription closes without another charge");
  ok(engine.listActive().length === 0, "and stops being served");
  ok((await engine.cancel(sub.subId, sub.manageToken)).status === "canceled", "cancelling twice is idempotent");
}

// ---------------------------------------------------------------------------
// Group 7: activation that does not settle, and the offer surface.
// ---------------------------------------------------------------------------
{
  const { engine, calls } = makeEngine({ name: "nosettle", activateThrows: true });
  const offer = await engine.mintOffer({ product: "ipo-monitor", target: "all" });
  const { header } = await signCredential(Challenge.deserialize(offer.header));
  let err = null;
  try { await engine.activateFromCredential(header); } catch (e) { err = e; }
  ok(err?.statusCode === 402, "an activation whose first transfer does not settle is a 402, never a subscriber");
  ok(!/node said no/.test(err.message), "and the upstream failure text is never relayed to the buyer");
  await engine.warm();
  ok(engine.listActive().length === 0 && calls.sales.length === 0, "no record, no sale: an unpaid activation leaves nothing behind");

  const info = engine.offerInfo("https://agent402.tools");
  ok(info.method === "tempo" && info.intent === "subscription" && info.chargeMode === "pull", "the offer surface names the real method and says plainly that the server pulls");
  ok(info.products.length === Object.keys(MONITOR_PRODUCTS).length, "every monitor product is offered over MPP, not a subset");
  ok(info.products.every((p) => p.amountAtomic === String(BigInt(MONITOR_PRODUCTS[p.product].price / 100 * 1e6))), "the offer quotes base units, the same figure the challenge will carry");
  ok(info.billingPeriod.seconds === PERIOD / 1000 && info.recipient === RECIPIENT, "the offer names the billing period and the payTo");
}

// ---------------------------------------------------------------------------
// Group 8: an unpaid offer is not a free write to the shared volume. Every 402
// mints and persists a server-owned key, so unclaimed offers must be swept and
// minting must refuse past a cap.
// ---------------------------------------------------------------------------
{
  const { engine } = makeEngine({ name: "offers" });
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "a.com" });
  const addr = Challenge.deserialize(offer.header).request.methodDetails.accessKey.accessKeyAddress;
  const holdsKey = () => Object.values(engine._store._snapshot()).some((v) => v && typeof v === "object" && v.privateKey && String(v.accessKeyAddress).toLowerCase() === addr.toLowerCase());
  ok(holdsKey(), "an offer persists the server-owned access key it names");
  await engine.mintOffer({ product: "domain-monitor", target: "b.com" });
  ok(Object.keys(engine._store._snapshot()).filter((k) => k.startsWith("a402:offer:")).length === 2, "each open offer is tracked");

  advance(OFFER_SWEEP_AFTER_MS + 1000);
  await engine.mintOffer({ product: "domain-monitor", target: "c.com" });
  ok(Object.keys(engine._store._snapshot()).filter((k) => k.startsWith("a402:offer:")).length === 1, "offers past the point where their challenge could still be paid are swept");
  ok(!holdsKey(), "and the swept offer's PRIVATE KEY material is actually gone from the store (matched by content, never by a hand-written mppx key prefix)");

  // A paid offer's key is never swept: it is the subscription's billing key.
  const paidOffer = await engine.mintOffer({ product: "domain-monitor", target: "paid.com" });
  const paidAddr = Challenge.deserialize(paidOffer.header).request.methodDetails.accessKey.accessKeyAddress;
  const { header: paidHeader } = await signCredential(Challenge.deserialize(paidOffer.header));
  await engine.activateFromCredential(paidHeader);
  advance(OFFER_SWEEP_AFTER_MS + 1000);
  await engine.mintOffer({ product: "domain-monitor", target: "d.com" });
  ok(Object.values(engine._store._snapshot()).some((v) => v && typeof v === "object" && v.privateKey && String(v.accessKeyAddress).toLowerCase() === paidAddr.toLowerCase()), "a PAID subscription's access key survives the sweep: it is the key we bill with");
}

// ---------------------------------------------------------------------------
// Group 9: the rail canary's product. Its whole safety rests on two structural
// facts rather than a flag anyone can set, so both are pinned here: it is not a
// MONITOR_PRODUCT (which is what keeps it away from the scheduler), and it is
// not mintable without the caller being proven synthetic.
// ---------------------------------------------------------------------------
{
  ok(!Object.hasOwn(MONITOR_PRODUCTS, CANARY_PRODUCT_KEY),
    "the canary product is NOT in MONITOR_PRODUCTS - listActive() skips any record whose product is absent there, so it can never reach the monitor scheduler, produce a paid report, or send an email");
  ok(productDefFor(CANARY_PRODUCT_KEY) === CANARY_PRODUCT && isCanaryProduct(CANARY_PRODUCT_KEY),
    "productDefFor is the only resolver that admits the canary product");
  ok(productDefFor("domain-monitor") === MONITOR_PRODUCTS["domain-monitor"] && productDefFor("nope") === null && !isCanaryProduct("domain-monitor"),
    "productDefFor still resolves real products and still refuses unknown ones");
  ok(CANARY_PERIOD_SECONDS >= 30 && CANARY_PERIOD_SECONDS <= 600,
    `canary period ${CANARY_PERIOD_SECONDS}s is long enough to be a real period and short enough to prove a renewal in one run`);

  const { engine } = makeEngine({ name: "canary" });

  // THE GATE. Without the flag the canary product is indistinguishable from any
  // other unknown string, so the 400 leaks nothing about its existence.
  let ungated = null;
  try { await engine.mintOffer({ product: CANARY_PRODUCT_KEY, target: "x" }); }
  catch (e) { ungated = e; }
  ok(ungated && ungated.statusCode === 400 && /unknown monitor product/i.test(ungated.message),
    "an UNGATED caller asking for the canary product gets the same 'Unknown monitor product' 400 as any unknown string: the gate leaks nothing");

  const offer = await engine.mintOffer({ product: CANARY_PRODUCT_KEY, target: "canary-1", canary: true });
  const ch = offer.challenge;
  ok(ch.request.periodUnit === "dev_second" && String(ch.request.periodCount) === String(CANARY_PERIOD_SECONDS),
    `a gated canary offer bills in dev_second x${CANARY_PERIOD_SECONDS} - the only reason a live renewal is provable at all`);
  ok(String(ch.request.amount) === String(BigInt(CANARY_PRODUCT.price / 100 * 1e6)),
    "the canary offer carries the canary price in base units, built through mppx's codec like every other challenge");

  // A real product is untouched by the flag: the canary path must not become a
  // way to buy a $9 monitor on a 60-second period.
  const realGated = await engine.mintOffer({ product: "domain-monitor", target: "d.com", canary: true });
  const realCh = realGated.challenge;
  ok(realCh.request.periodUnit === PERIOD_UNIT && String(realCh.request.periodCount) === String(PERIOD_COUNT),
    "the canary flag does NOT shorten a real product's period: only the canary product itself bills in dev_second");
  ok(String(realCh.request.amount) === String(PRICE_ATOMIC),
    "the canary flag does NOT cheapen a real product either");

  // The binding check must accept the canary product (activation would be
  // impossible otherwise) without becoming a hole: a challenge naming the
  // canary product at a LOWER amount is still refused on price.
  const canaryCred = Credential.from({ challenge: ch, payload: { type: "keyAuthorization", signature: "0x" + "11".repeat(65) } });
  const b = checkSubscriptionBinding(`Payment ${Credential.serialize(canaryCred)}`, { secretKey: SECRET, realm: REALM });

  // THE RETARGET the period check exists to stop, and the reason that check had
  // to move BELOW the product read: the expected period must come from the
  // HMAC-covered product, not from a constant. Both challenges below are
  // legitimately OURS (minted with the real secret) and differ only in period,
  // which is exactly the shape a mint-side bug would produce.
  const realReq = realCh.request;
  const fastReal = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(clock + 300_000), secretKey: SECRET,
    meta: { product: "domain-monitor", target: "d.com" },
    request: { ...realReq, decimals: 6, subscriptionExpires: new Date(Date.parse(realReq.subscriptionExpires)),
      chainId: TEMPO_MAINNET_CHAIN_ID, accessKey: realReq.methodDetails.accessKey,
      periodCount: String(CANARY_PERIOD_SECONDS), periodUnit: "dev_second" },
  });
  const fr = checkSubscriptionBinding((await signCredential(fastReal)).header, { secretKey: SECRET, realm: REALM, now: clock });
  ok(fr.ok === false && /billing period/.test(String(fr.reason || "")),
    "a REAL product's challenge on the canary's dev_second period is REFUSED: the expected period is resolved from the HMAC-covered product, never from a constant (this would be a $9 monitor billing every 60 seconds)");

  // And the mirror, so the check is a binding both ways rather than a one-sided
  // allowance that happens to admit anything short.
  const slowCanary = Challenge.fromMethod(Tempo.Methods.subscription, {
    realm: REALM, expires: new Date(clock + 300_000), secretKey: SECRET,
    meta: { product: CANARY_PRODUCT_KEY, target: "canary-1" },
    request: { ...ch.request, decimals: 6, subscriptionExpires: new Date(Date.parse(ch.request.subscriptionExpires)),
      chainId: TEMPO_MAINNET_CHAIN_ID, accessKey: ch.request.methodDetails.accessKey,
      periodCount: String(PERIOD_COUNT), periodUnit: PERIOD_UNIT },
  });
  const sc = checkSubscriptionBinding((await signCredential(slowCanary)).header, { secretKey: SECRET, realm: REALM, now: clock });
  ok(sc.ok === false && /billing period/.test(String(sc.reason || "")),
    "and the canary product on the real 30-day period is refused too: the period binding is two-sided");
  ok(b.ok !== false || !/no known monitor product/.test(String(b.reason || "")),
    "the binding check resolves the canary product rather than rejecting it as unknown");
}

// ---------------------------------------------------------------------------
// Group 10: the sponsored-gas policy. mppx caps maxGas at 2,000,000 by default
// and an activation installs an access key on top of the transfer, so the
// default is the wrong shape for this rail's heaviest leg.
// ---------------------------------------------------------------------------
{
  const pol = subscriptionFeePayerPolicy();
  ok(pol.maxGas === SUB_FEE_PAYER_MAX_GAS && pol.maxGas > 2_000_000n,
    `the fee-payer policy raises maxGas to ${pol.maxGas}, above mppx's 2,000,000 default (an activation installs the access key as well as moving the first period)`);

  // The gas ceiling is not the money bound; maxTotalFee is, and we leave it
  // untouched. Recorded here so a future raise cannot quietly become expensive:
  // fees settle in USDC.e and gas*price converts at ~1e12 (measured: 46,575 gas
  // at 0.6 gwei was charged 28 units, $0.000028).
  const usd = (gas, price) => Number((gas * BigInt(price)) / 1_000_000_000_000n) / 1e6;
  ok(usd(pol.maxGas, 600_000_000) < 0.01,
    `at the live 0.6 gwei basefee this ceiling is worth $${usd(pol.maxGas, 600_000_000).toFixed(6)} per transaction, well under a cent`);

  // The helper returning the right number proves nothing about the engine using
  // it, and removing the parameter from the mppx call survived a mutation until
  // this assertion existed.
  const { engine: sponsored } = makeEngine({ name: "feepolicy" });
  ok(sponsored._feePayer && sponsored._feePayerPolicy?.maxGas === SUB_FEE_PAYER_MAX_GAS,
    "the engine actually hands that policy to mppx alongside the fee payer, rather than resolving it and dropping it");

  // The RENEWAL path needs the sponsor passed separately: mppx's
  // renewSubscription is a standalone entry point that builds its own context
  // from its own parameters, so a fee payer configured on the method does not
  // reach it. The live canary activated fine and then failed every renewal with
  // the zero-gas-price error the activation leg had already been fixed for, so
  // this is read from the source rather than trusted.
  const src = readFileSync(new URL("../src/mpp-subscriptions.js", import.meta.url), "utf8");
  const renewCall = src.slice(src.indexOf("tempoServer.renewSubscription({"));
  const renewArgs = renewCall.slice(0, renewCall.indexOf("});"));
  ok(/feePayer/.test(renewArgs) && /feePayerPolicy/.test(renewArgs),
    "renewSubscription is passed the fee payer AND its policy: without them the renewal takes mppx's unsponsored path and is signed with a zero gas price");

  const prev = process.env.MPP_SUB_FEE_PAYER_MAX_GAS;
  process.env.MPP_SUB_FEE_PAYER_MAX_GAS = "9000000";
  ok(subscriptionFeePayerPolicy().maxGas === 9_000_000n, "the ceiling is a call-time env knob, like every other knob in this repo");
  // A malformed or zero knob must never widen the policy, void it, or throw:
  // this value rides into a signing path, so the failure mode has to be inert.
  for (const bad of ["not-a-number", "0", "-1", ""]) {
    process.env.MPP_SUB_FEE_PAYER_MAX_GAS = bad;
    ok(subscriptionFeePayerPolicy().maxGas === SUB_FEE_PAYER_MAX_GAS, `a ${JSON.stringify(bad)} ceiling falls back to the default rather than widening or voiding the policy`);
  }
  if (prev === undefined) delete process.env.MPP_SUB_FEE_PAYER_MAX_GAS; else process.env.MPP_SUB_FEE_PAYER_MAX_GAS = prev;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, 0 failed`);
