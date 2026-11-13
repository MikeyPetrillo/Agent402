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
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import * as Tempo from "mppx/tempo";
import { KeyAuthorization } from "ox/tempo";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createMppSubscriptions, checkSubscriptionBinding, mppSubscriptionsEnabled, mppSubscriptionsConfigured,
  mppSubscriptionMethodAvailable, periodMs, PERIOD_COUNT, PERIOD_UNIT,
  SUBSCRIPTION_TERM_MS, PAST_DUE_GRACE_MS, CHARGE_BACKOFF_MS, TEMPO_MAINNET_CHAIN_ID,
  OFFER_SWEEP_AFTER_MS, MAX_OPEN_OFFERS,
  CANARY_PRODUCT_KEY, CANARY_PRODUCT, CANARY_PERIOD_SECONDS, productDefFor, isCanaryProduct,
  subscriptionFeePayerPolicy, SUB_FEE_PAYER_MAX_GAS,
  isTransientChargeError, TRANSIENT_CHARGE_BACKOFF_MS, isSendPhaseAmbiguity, expectedRenewalMemo, RENEWAL_SCAN_MAX_BLOCKS,
  renewalValidForSeconds, withRenewalValidity, RENEWAL_VALID_FOR_DEFAULT_S, RENEWAL_VALID_FOR_MAX_S, SETTLEABLE_SLACK_MS,
  ACTIVATION_VALID_FOR_S, TEMPO_RPC_TIMEOUT_MS,
  guardDestroyedKeys, KEY_GONE_PREFIX, createFileStore, diagnoseError,
  renewalUnconfirmedAlertHours, renewalsWord, RENEWAL_UNCONFIRMED_ALERT_HOURS_DEFAULT,
  buildMppSubscriptionsEngine,
} from "../src/mpp-subscriptions.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { HttpRequestError } from "viem";

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
// The boot build and its gateway-status word (mppSubscriptions): on / off /
// failed, where failed is configured but the build threw or refused.
{
  const warned = [];
  const warn = (...a) => warned.push(a.join(" "));
  const engine = { marker: true };
  const on = buildMppSubscriptionsEngine({ configured: () => true, build: () => engine, warn });
  ok(on.state === "on" && on.engine === engine && warned.length === 0, "boot build: a configured engine that builds reads on");
  let built = false;
  const off = buildMppSubscriptionsEngine({ configured: () => false, build: () => { built = true; return engine; }, warn });
  ok(off.state === "off" && off.engine === null && !built && warned.length === 0, "boot build: not configured reads off and never builds");
  const threw = buildMppSubscriptionsEngine({ configured: () => true, build: () => { throw new Error("store unreadable"); }, warn });
  ok(threw.state === "failed" && threw.engine === null && /init failed: store unreadable/.test(warned.at(-1) || ""), "boot build: a configured engine whose build throws reads failed and logs it");
  const refused = buildMppSubscriptionsEngine({ configured: () => true, build: () => null, warn });
  ok(refused.state === "failed" && refused.engine === null, "boot build: a configured engine that refuses to start reads failed");
  const enabledThrew = buildMppSubscriptionsEngine({ configured: () => { throw new Error("bad env"); }, build: () => engine, warn });
  ok(enabledThrew.state === "failed" && enabledThrew.engine === null, "boot build: a rollout switch that throws reads failed, never on");
  // The default switch is the real one: configured here, so a throwing build reads failed.
  ok(buildMppSubscriptionsEngine({ build: () => { throw new Error("x"); }, warn }).state === "failed", "boot build: the default switch is mppSubscriptionsConfigured (configured in this suite)");
  // A vendor bump that drops the subscription method: configured, no method.
  // That reads failed (and pages), never off, and nothing is built.
  let builtNoMethod = false;
  const noMethod = buildMppSubscriptionsEngine({ available: () => false, build: () => { builtNoMethod = true; return engine; }, warn });
  ok(noMethod.state === "failed" && noMethod.engine === null && !builtNoMethod && /no tempo\/subscription method/.test(warned.at(-1) || ""), "boot build: configured but the installed mppx has no subscription method reads failed, logs it and builds nothing");
  ok(mppSubscriptionsConfigured() === true, "configured reads the env only (secret, recipient, fee payer, switch not off)");
  process.env.MPP_SUBSCRIPTIONS = "off";
  ok(mppSubscriptionsConfigured() === false && buildMppSubscriptionsEngine({ available: () => false, build: () => engine, warn }).state === "off", "MPP_SUBSCRIPTIONS=off reads off even with the method missing");
  delete process.env.MPP_SUBSCRIPTIONS;
  const savedFp = process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
  delete process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY;
  ok(mppSubscriptionsConfigured() === false && buildMppSubscriptionsEngine({ available: () => false, build: () => engine, warn }).state === "off", "no fee payer reads off even with the method missing");
  process.env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY = savedFp;
  // subscriptionRenewals agrees: unknown (neither pages nor clears) while the engine failed, off when not configured.
  ok(/subscriptionRenewals: \(\(\) => \{ try \{ return _mppSubs \? _mppSubs\.renewalsStatus\(\{ full \}\) : \{ status: _mppSubsState === "failed" \? "unknown" : "off" \}/.test(readFileSync(new URL("../src/server.js", import.meta.url), "utf8")), "subscriptionRenewals reads unknown while a configured engine failed, off when none is configured");
  // server.js builds through it and publishes the state as the word.
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/const \{ engine: _mppSubs, state: _mppSubsState \} = buildMppSubscriptionsEngine\(/.test(server) && /mppSubscriptions: \{ status: _mppSubsState \}/.test(server), "server.js builds the engine through buildMppSubscriptionsEngine and publishes its state on /api/gateway-status");
}

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
  const usedCreds = new Set();
  let chargeBehaviour = () => ({ reference: `0xtx${calls.charge}` });
  let findBehaviour = { found: false };
  const engine = createMppSubscriptions({
    secretKey: SECRET, realm: REALM,
    storePath: join(tmp, `${opts.name || "store"}.json`),
    now: () => clock,
    log: opts.log || (() => {}),
    onCharge: (s) => calls.sales.push(s),
    validateTarget: opts.validateTarget,
    activate: async (header, ctx) => {
      calls.activate++;
      if (opts.activateThrows) throw new Error("simulated settlement failure: node said no");
      // mppx claims a credential once: a second activation of it is refused.
      if (opts.oneUse) { const sig = ctx.binding.credential.payload.signature; if (usedCreds.has(sig)) throw new Error("subscription credential has already been used"); usedCreds.add(sig); }
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
    findRenewalOnChain: opts.chainReader ? undefined : async (args) => { calls.find = (calls.find || 0) + 1; return typeof findBehaviour === "function" ? findBehaviour(args) : findBehaviour; },
    chargePeriod: async (rec, { periodIndex }) => {
      calls.charge++;
      const r = await chargeBehaviour(rec, periodIndex);
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
    // challengeId: the witness a 0.9.3 signer binds the authorization to (ignored by 0.9.2).
    accessKey: ak, account: acct, challengeId: challenge.id, chainId: TEMPO_MAINNET_CHAIN_ID, request: challenge.request,
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

// A first payment that settled (mppx wrote its record) but whose record of ours
// was never written: the retry of the same credential is refused by mppx as
// used, so the engine rebuilds its record from mppx's and hands the paid
// subscription back, never "nothing was charged".
{
  const lost = makeEngine({ name: "lost-house-record", oneUse: true });
  const { engine, calls } = lost;
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "example.org", email: "lost@example.com" });
  const signed = await signCredential(Challenge.deserialize(offer.header));
  // The first write of our record fails, whichever store call makes it.
  const cas = engine._store.compareAndSet.bind(engine._store), put = engine._store.put.bind(engine._store);
  let failOnce = true;
  const boom = (k) => { if (failOnce && String(k).startsWith("a402:sub:mpp_")) { failOnce = false; throw new Error("simulated store failure"); } };
  const failing = async (k, d) => { boom(k); return cas(k, d); };
  const failingPut = async (k, v) => { boom(k); return put(k, v); };
  engine._store.compareAndSet = failing; engine._store.put = failingPut;
  let firstErr = null;
  try { await engine.activateFromCredential(signed.header); } catch (e) { firstErr = e; }
  engine._store.compareAndSet = cas; engine._store.put = put;
  ok(firstErr && calls.activate === 1 && calls.sales.length === 0, `setup: the first payment settled and our record write failed (${firstErr?.message})`);
  let again = null, againErr = null;
  try { again = await engine.activateFromCredential(signed.header); } catch (e) { againErr = e; }
  ok(!againErr && again?.status === "active" && again.replay === true && typeof again.manageToken === "string", `the retry hands back the paid subscription, rebuilt from mppx's record (${againErr ? `${againErr.statusCode} ${againErr.message}` : again?.status})`);
  ok(calls.activate === 1 && calls.sales.length === 1 && calls.sales[0].tx === "0xactivation" && calls.sales[0].payer === signed.account.address.toLowerCase(), `nothing settles twice and the first payment is booked once (activations ${calls.activate}, sales ${calls.sales.length})`);
  const rec = engine.get(again?.subId);
  ok(rec && rec.product === "domain-monitor" && rec.target === "example.org" && rec.email === "lost@example.com" && rec.billingAnchor && rec.lastChargedPeriod === 0, "the rebuilt record carries the binding and mppx's billing anchor");
  const third = await engine.activateFromCredential(signed.header);
  ok(third.replay === true && third.subId === again.subId && calls.sales.length === 1, "a further retry finds the rebuilt record and books nothing");
  // mppx's record says the subscription was canceled since: rebuilt as canceled.
  const offer2 = await engine.mintOffer({ product: "domain-monitor", target: "example.net", email: "lost@example.com" });
  const signed2 = await signCredential(Challenge.deserialize(offer2.header));
  failOnce = true;
  engine._store.compareAndSet = failing; engine._store.put = failingPut;
  try { await engine.activateFromCredential(signed2.header); } catch { /* setup */ }
  engine._store.compareAndSet = cas; engine._store.put = put;
  const mrec = await engine._subStore.get(`sub-${calls.activate}`);
  await engine._subStore.put({ ...mrec, canceledAt: new Date(clock).toISOString() });
  const canceled = await engine.activateFromCredential(signed2.header);
  ok(canceled.replay === true && canceled.status === "canceled" && engine.get(canceled.subId)?.status === "canceled", `a settled record mppx has since canceled is rebuilt canceled, not active (${canceled.status})`);
}

// Two retries of one credential whose house record is missing, at once: the
// record is created once (create-if-absent) and the first period is booked
// once; a record stored meanwhile (a cancel) is never overwritten by a rebuild.
{
  const race = makeEngine({ name: "rebuild-race", oneUse: true });
  const { engine, calls } = race;
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "race.example.org", email: "race@example.com" });
  const signed = await signCredential(Challenge.deserialize(offer.header));
  // The first write of our record fails, whichever store call makes it.
  const cas = engine._store.compareAndSet.bind(engine._store), put = engine._store.put.bind(engine._store);
  let failOnce = true;
  const boom = (k) => { if (failOnce && String(k).startsWith("a402:sub:mpp_")) { failOnce = false; throw new Error("simulated store failure"); } };
  engine._store.compareAndSet = async (k, d) => { boom(k); return cas(k, d); };
  engine._store.put = async (k, v) => { boom(k); return put(k, v); };
  try { await engine.activateFromCredential(signed.header); } catch { /* setup: settled, our record not written */ }
  engine._store.compareAndSet = cas; engine._store.put = put;
  ok(calls.activate === 1 && calls.sales.length === 0, "setup: the first payment settled and our record was not written");
  const salesBefore = calls.sales.length;
  const [r1, r2] = await Promise.all([engine.activateFromCredential(signed.header), engine.activateFromCredential(signed.header)]);
  ok(r1.subId === r2.subId && calls.sales.length === salesBefore + 1 && calls.activate === 1, `two concurrent rebuilds of one credential book the first period once (sales ${calls.sales.length - salesBefore}, activations ${calls.activate})`);
  // A cancel stored after the rebuild survives a further retry.
  const stored = engine.get(r1.subId);
  await engine._store.put(`a402:sub:${r1.subId}`, { ...stored, status: "canceled", canceledAt: new Date(clock).toISOString(), canceledReason: "requested" });
  const again = await engine.activateFromCredential(signed.header);
  const after = await engine._store.get(`a402:sub:${r1.subId}`);
  ok(again.replay === true && after?.status === "canceled" && calls.sales.length === salesBefore + 1, `a retry after a stored cancel neither rewrites it nor books again (${after?.status}, sales ${calls.sales.length - salesBefore})`);
}

// An activation whose create-if-absent write loses books nothing: a retry of
// the same credential that arrived while the first payment was settling
// rebuilt the record and booked the period, so the activation hands back that
// record and the period is booked once.
{
  const lose = makeEngine({ name: "activation-loses-write" });
  const { engine, calls } = lose;
  const offer = await engine.mintOffer({ product: "domain-monitor", target: "lose.example.org", email: "lose@example.com" });
  const signed = await signCredential(Challenge.deserialize(offer.header));
  const cas = engine._store.compareAndSet.bind(engine._store);
  let retried = null, stole = false;
  engine._store.compareAndSet = async (k, d) => {
    if (!stole && String(k).startsWith("a402:sub:mpp_")) { stole = true; retried = await engine.activateFromCredential(signed.header); }
    return cas(k, d);
  };
  const first = await engine.activateFromCredential(signed.header);
  engine._store.compareAndSet = cas;
  ok(retried?.replay === true && retried.subId === first.subId && calls.activate === 1, `setup: the retry rebuilt the record before the activation wrote it (${retried?.subId}, activations ${calls.activate})`);
  ok(calls.sales.length === 1 && calls.sales[0].tx === "0xactivation", `the activation that lost the write books nothing: the first period is booked once (sales ${calls.sales.length})`);
  ok(first.replay === false && first.status === "active" && typeof first.manageToken === "string", "the activation still hands back the stored subscription");
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
    ok(Date.parse(recA.unconfirmedCharge.settleableUntil) >= clock + RENEWAL_VALID_FOR_DEFAULT_S * 1000 + SETTLEABLE_SLACK_MS,
      "the unconfirmed send records when it stops being settleable (validity window + slack)");
    ok(Date.parse(recA.nextChargeAttemptAt) >= Date.parse(recA.unconfirmedCharge.settleableUntil), "and the next pull is not scheduled before that");
    advance(Date.parse(recA.nextChargeAttemptAt) - clock + 1000);
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
    b.setCharge(() => ({ reference: "0xMUST-NOT-HAPPEN-YET" }));
    // Not on chain while its validBefore may still be ahead: wait, never sign.
    const chargesB = b.calls.charge;
    const recB = await b.engine._readRec(subB.subId);
    await b.engine._writeRec({ ...recB, nextChargeAttemptAt: null });
    ok(await b.engine.refreshStatus(subB.subId) === "past_due" && b.calls.charge === chargesB,
      "(b) nothing on chain but the timed-out transaction is still settleable -> waits, signs nothing");
    ok(Date.parse(b.engine.get(subB.subId).nextChargeAttemptAt) === Date.parse(recB.unconfirmedCharge.settleableUntil), "(b) and retries when the window has closed");
    b.setCharge(() => ({ reference: "0xsecond-try" }));
    advance(Date.parse(b.engine.get(subB.subId).nextChargeAttemptAt) - clock + 1000);
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

    let clockAfterFirstD = null;
    // (d) read by the DEFAULT chain reader (no injected finder) from a stub
    // JSON-RPC on a loopback port that honours getLogs' address and topic
    // filters. mppx sends a renewal as a Tempo 0x76 transaction whose
    // transferWithMemo is one of calls[] (its top-level input is empty), and
    // the token emits Transfer + TransferWithMemo. mppx's record carries the
    // amount in BASE UNITS ("3000000" for $3); the reader never re-scales it.
    {
      const { encodeFunctionData, parseAbi, pad, toHex, keccak256, toBytes } = await import("viem");
      const http = await import("node:http");
      const abi = parseAbi(["function transferWithMemo(address to, uint256 amount, bytes32 memo)"]);
      const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
      const TRANSFER_MEMO = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));
      const OTHER = "0x000000000000000000000000000000000000bEEF";
      const OTHER_TOKEN = "0x20C0000000000000000000000000000000000001";
      const HEAD = 0x1000000;
      const TXH = "0x" + "ab".repeat(32);
      const BH = "0x" + "cd".repeat(32);
      // landed: { payer, value, memo, shape, logTo, logValue, logMemo, logToken, callTo, receipt }
      let landed = null;
      const rpcCalls = [];
      const logsOf = () => {
        if (!landed) return [];
        const L = landed, token = L.logToken || CURRENCY, to = L.logTo || RECIPIENT, value = L.logValue ?? L.value, memo = L.logMemo || L.memo;
        // The landed block sits where the chain's block time puts the attempt.
        const landedBlock = HEAD - Math.floor((clock - L.atMs) / (L.blockMs || 1000));
        const base = { blockNumber: toHex(landedBlock), blockHash: BH, transactionHash: TXH, transactionIndex: "0x0", removed: false };
        // The plain Transfer the candidate search finds is always to us for the full amount;
        // the memo log carries the variant under test.
        return [
          { ...base, address: CURRENCY, topics: [TRANSFER, pad(L.payer), pad(RECIPIENT)], data: pad(toHex(L.value)), logIndex: "0x0" },
          ...(L.noMemoLog ? [] : [{ ...base, address: token, topics: [TRANSFER_MEMO, pad(L.payer), pad(to), memo], data: pad(toHex(value)), logIndex: "0x1" }]),
        ];
      };
      const topicOk = (want, got) => want == null || (Array.isArray(want) ? want.some((w) => w.toLowerCase() === String(got).toLowerCase()) : want.toLowerCase() === String(got).toLowerCase());
      const filterLogs = (f) => logsOf().filter((l) => (!f.address || [].concat(f.address).some((a) => a.toLowerCase() === l.address.toLowerCase()))
        && (f.topics || []).every((t, i) => topicOk(t, l.topics[i]))
        && (f.fromBlock == null || f.fromBlock === "latest" || Number(l.blockNumber) >= Number(f.fromBlock))
        && (f.toBlock == null || f.toBlock === "latest" || Number(l.blockNumber) <= Number(f.toBlock)));
      const sig = { r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), yParity: "0x0" };
      const txOf = () => {
        const L = landed;
        // callMatches: the calldata pays us exactly while the receipt says otherwise (a held transfer).
        const data = L.callMatches
          ? encodeFunctionData({ abi, functionName: "transferWithMemo", args: [RECIPIENT, L.value, L.memo] })
          : encodeFunctionData({ abi, functionName: "transferWithMemo", args: [L.logTo || RECIPIENT, L.logValue ?? L.value, L.logMemo || L.memo] });
        const common = { hash: TXH, from: L.payer, nonce: "0x1", gas: "0x5208", blockNumber: "0xfff0", blockHash: BH, transactionIndex: "0x0", chainId: toHex(TEMPO_MAINNET_CHAIN_ID) };
        if (L.shape === "legacy") return { ...common, to: CURRENCY, input: data, value: "0x0", gasPrice: "0x1", type: "0x0", v: "0x1b", r: sig.r, s: sig.s };
        return { ...common, to: null, input: "0x", value: "0x0", type: "0x76", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", accessList: [],
          calls: [{ to: L.callTo || CURRENCY, value: "0x0", input: data }], nonceKey: "0x0", signature: { type: "secp256k1", ...sig } };
      };
      const srv = http.createServer((req, res) => {
        let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
          const parsed = JSON.parse(body);
          const out = [].concat(parsed).map(({ id, method, params }) => {
            rpcCalls.push(method);
            let result = null;
            if (method === "eth_blockNumber") result = toHex(HEAD);
            else if (method === "eth_chainId") result = toHex(TEMPO_MAINNET_CHAIN_ID);
            else if (method === "eth_getBlockByNumber") {
              const n = Number(params[0]);
              result = { number: toHex(n), hash: "0x" + n.toString(16).padStart(64, "0"), parentHash: BH, timestamp: toHex(Math.floor((clock - (HEAD - n) * (landed?.blockMs || 1000)) / 1000)), transactions: [], gasLimit: "0x1", gasUsed: "0x0", baseFeePerGas: "0x1", logsBloom: "0x" + "00".repeat(256), miner: RECIPIENT, extraData: "0x", difficulty: "0x0", size: "0x1", uncles: [] };
            }
            else if (method === "eth_getLogs") result = filterLogs(params[0] || {});
            else if (method === "eth_getTransactionReceipt") {
              if (landed?.receipt === "unreadable") return { jsonrpc: "2.0", id, error: { code: -32000, message: "header not found" } };
              result = { transactionHash: TXH, transactionIndex: "0x0", blockHash: BH, blockNumber: "0xfff0", from: landed.payer, to: null, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: logsOf(), logsBloom: "0x" + "00".repeat(256), status: "0x1", type: landed.shape === "legacy" ? "0x0" : "0x76" };
            }
            else if (method === "eth_getTransactionByHash") result = txOf();
            return { jsonrpc: "2.0", id, result };
          });
          res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
        });
      });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const savedRpc = process.env.TEMPO_RPC_URL;
      process.env.TEMPO_RPC_URL = `http://127.0.0.1:${srv.address().port}`;
      // One subscription per scenario: a send-phase timeout for period 1, the
      // chain then shows `variant`, and the pull runs after the settle window.
      async function scenario(name, variant, extraMs = 0) {
        const logsD = [];
        const d = makeEngine({ name: `ambiguous-default-reader-${name}`, chainReader: true, log: (m) => logsD.push(m) });
        const offD = await d.engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
        const cD = await signCredential(Challenge.deserialize(offD.header));
        const subD = await d.engine.activateFromCredential(cD.header);
        await d.engine.warm();
        d.setCharge(() => sendTimeout);
        advance(PERIOD);
        ok(await d.engine.refreshStatus(subD.subId) === "past_due", `(d:${name}) send-phase failure -> past_due`);
        const recD = d.engine.get(subD.subId);
        const mppxD = await d.engine._subStore.get(recD.mppxSubscriptionId);
        const memo = await expectedRenewalMemo({ lookupKey: mppxD.lookupKey, subscriptionId: recD.mppxSubscriptionId, periodIndex: 1 });
        landed = { payer: cD.account.address, value: BigInt(mppxD.amount), memo, atMs: clock, ...variant(memo) };
        const charges = d.calls.charge;
        d.setCharge(() => ({ reference: "0xsecond-charge" }));
        advance(Date.parse(recD.nextChargeAttemptAt) - clock + 1000 + extraMs);
        const status = await d.engine.refreshStatus(subD.subId);
        return { d, subD, recD, mppxD, status, charges, logsD, after: d.engine.get(subD.subId) };
      }
      try {
        // Tempo 0x76: the receipt's TransferWithMemo proves it -> recorded, never re-sent.
        {
          const r = await scenario("tempo", () => ({ shape: "tempo" }));
          ok(/^\d+$/.test(String(r.mppxD.amount)) && BigInt(r.mppxD.amount) >= 1000000n && String(r.recD.amountAtomic) === String(r.mppxD.amount), `(d) mppx's record and ours both hold the period amount in base units (${r.mppxD.amount})`);
          ok(r.status === "active", `(d) the default reader finds the landed 0x76 renewal (calls[], empty input) -> active (rpc: ${[...new Set(rpcCalls)].join(",")}; ${r.logsD.filter((m) => /chain|unconfirmed/.test(m)).slice(-2).join(" | ")})`);
          ok(r.after.lastChargedPeriod === 1 && r.after.lastChargeTx === TXH && !r.after.unconfirmedCharge, "(d) the landed transaction is recorded as period 1's charge");
          ok(r.d.calls.charge === r.charges, "(d) and no second transfer was signed for the same period");
          clockAfterFirstD = clock; // the later groups run on the timeline the first scenario leaves
        }
        // A 0x76 renewal with the receipt read ONLY through calls[] (token emitted no memo log).
        {
          const r = await scenario("tempo-calls-only", () => ({ shape: "tempo", noMemoLog: true }));
          ok(r.status === "active" && r.after.lastChargeTx === TXH && r.d.calls.charge === r.charges, "(d) a receipt with no memo log falls back to calls[] and finds the renewal -> no second transfer");
        }
        // Legacy shape: transferWithMemo in the top-level input still counts.
        {
          const r = await scenario("legacy", () => ({ shape: "legacy", noMemoLog: true }));
          ok(r.status === "active" && r.after.lastChargeTx === TXH && r.d.calls.charge === r.charges, "(d) the legacy 0x0 input shape is still read -> no second transfer");
        }
        // Blocks four times faster than one a second: the scan widens by block
        // timestamp until it reaches back past the attempt, so the renewal is found.
        {
          const r = await scenario("fast-blocks", () => ({ shape: "tempo", blockMs: 250 }));
          ok(r.status === "active" && r.after.lastChargeTx === TXH && r.d.calls.charge === r.charges, "(d) with 250 ms blocks the scan still reaches the attempt's block -> no second transfer");
        }
        // The pull runs so late that the attempt lies past the scan bound: that
        // is UNKNOWN (wait), never "not found".
        {
          const r = await scenario("beyond-scan-bound", () => ({ shape: "tempo" }), (Number(RENEWAL_SCAN_MAX_BLOCKS) + 10_000) * 1000);
          ok(r.status === "past_due" && r.d.calls.charge === r.charges && r.after.unconfirmedCharge?.periodIndex === 1,
            `(d) an attempt further back than the scan bound waits and signs nothing (${r.logsD.filter((m) => /decide/.test(m)).slice(-1).join("")})`);
        }
        // Not this renewal: a different recipient, amount, token or memo in the receipt is not counted.
        for (const [name, variant] of [
          ["other-recipient", () => ({ shape: "tempo", logTo: OTHER })],
          ["other-amount", () => ({ shape: "tempo", logValue: 1n })],
          ["other-memo", () => ({ shape: "tempo", logMemo: "0x" + "99".repeat(32) })],
          ["other-token", () => ({ shape: "tempo", logToken: OTHER_TOKEN, callTo: OTHER_TOKEN })],
          // A receive policy held the funds: the call names us, the receipt credits the guard.
          ["held-by-receive-policy", () => ({ shape: "tempo", logTo: OTHER, callMatches: true })],
        ]) {
          const r = await scenario(name, variant);
          ok(r.status === "active" && r.after.lastChargeTx === "0xsecond-charge" && r.d.calls.charge === r.charges + 1,
            `(d:${name}) a transfer that is not this renewal is not counted; past the settle window the period is charged once`);
        }
        // Unreadable receipt: undecidable -> waits, never a second transfer, even long after the window.
        {
          const r = await scenario("receipt-unreadable", () => ({ shape: "tempo", receipt: "unreadable" }));
          ok(r.status === "past_due" && r.d.calls.charge === r.charges && r.after.unconfirmedCharge?.periodIndex === 1,
            `(d) an unreadable receipt is UNKNOWN: past_due, unconfirmed kept, nothing signed (${r.logsD.filter((m) => /decide|unconfirmed/.test(m)).slice(-1).join("")})`);
          advance(Date.parse(r.after.nextChargeAttemptAt) - clock + 1000);
          ok(await r.d.engine.refreshStatus(r.subD.subId) === "past_due" && r.d.calls.charge === r.charges, "(d) and a later pull still signs nothing while the receipt cannot be read");
          landed.receipt = "ok";
          advance(Date.parse(r.d.engine.get(r.subD.subId).nextChargeAttemptAt) - clock + 1000);
          ok(await r.d.engine.refreshStatus(r.subD.subId) === "active" && r.d.engine.get(r.subD.subId).lastChargeTx === TXH && r.d.calls.charge === r.charges, "(d) once the receipt reads, the landed renewal is recorded, still one transfer");
        }
      } finally {
        if (savedRpc === undefined) delete process.env.TEMPO_RPC_URL; else process.env.TEMPO_RPC_URL = savedRpc;
        srv.close();
      }
    }

    // (e) the pull signs again ONLY on an explicit {found:false}: an unknown or
    // malformed verdict from any reader waits, even past the settle window.
    for (const [name, verdict] of [["unknown", { unknown: true, reason: "test" }], ["found-false-but-unknown", { found: false, unknown: true }], ["empty", {}], ["found-no-tx", { found: true }], ["string", "nope"]]) {
      const e = makeEngine({ name: `ambiguous-verdict-${name}` });
      const offE = await e.engine.mintOffer({ product: "fund-monitor", target: "Some Manager LP" });
      const cE = await signCredential(Challenge.deserialize(offE.header));
      const subE = await e.engine.activateFromCredential(cE.header);
      await e.engine.warm();
      e.setCharge(() => sendTimeout);
      advance(PERIOD);
      await e.engine.refreshStatus(subE.subId);
      const chargesE = e.calls.charge;
      e.setFind(verdict);
      e.setCharge(() => ({ reference: "0xMUST-NOT-HAPPEN" }));
      advance(Date.parse(e.engine.get(subE.subId).nextChargeAttemptAt) - clock + 1000);
      ok(await e.engine.refreshStatus(subE.subId) === "past_due" && e.calls.charge === chargesE && e.engine.get(subE.subId).unconfirmedCharge,
        `(e:${name}) a verdict that is not a definite answer waits past the settle window and signs nothing`);
      if (name === "unknown") {
        // The wait is open-ended, so it is a status word: ok inside the
        // alert window, unconfirmed past it, off when disabled; the public
        // read is the word alone.
        const since = Date.parse(e.engine.get(subE.subId).unconfirmedCharge.at);
        const H = 3_600_000;
        ok(e.engine.renewalsStatus({ env: {}, at: since + 3 * H }).status === "ok", "(e) an unconfirmed renewal inside the alert window reads ok");
        const stuck = e.engine.renewalsStatus({ env: {}, at: since + 3 * H + 1 });
        ok(JSON.stringify(stuck) === JSON.stringify({ status: "unconfirmed" }), `(e) past MPP_SUB_UNCONFIRMED_ALERT_HOURS (default 3) the word reads unconfirmed, publicly the word only (${JSON.stringify(stuck)})`);
        const op = e.engine.renewalsStatus({ full: true, env: {}, at: since + 3 * H + 1 });
        ok(op.status === "unconfirmed" && op.alertHours === 3 && op.unconfirmedCount === 1 && op.oldestAttemptAt === new Date(since).toISOString(), `(e) the operator read has the threshold, the count and the oldest attempt (${JSON.stringify(op)})`);
        ok(e.engine.renewalsStatus({ env: { MPP_SUB_UNCONFIRMED_ALERT_HOURS: "12" }, at: since + 6 * H }).status === "ok" && e.engine.renewalsStatus({ env: { MPP_SUB_UNCONFIRMED_ALERT_HOURS: "1" }, at: since + 2 * H }).status === "unconfirmed", "(e) the threshold is read from the environment");
        for (const v of ["0", "off", " OFF "]) ok(e.engine.renewalsStatus({ env: { MPP_SUB_UNCONFIRMED_ALERT_HOURS: v }, at: since + 72 * H }).status === "off", `(e) MPP_SUB_UNCONFIRMED_ALERT_HOURS=${JSON.stringify(v)} turns the word off`);
        ok((await e.engine.status()).subs.find((x) => x.subId === subE.subId)?.unconfirmedChargeAt === new Date(since).toISOString(), "(e) the operator subscription list names the unconfirmed attempt time");
      }
    }
    // The extra scenarios above each ran their own periods; put the shared clock back.
    clock = clockAfterFirstD;
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
// Group 9b: canary records close. 39 of 42 canary records read `active` in
// production because cancel() honoured the paid period and nothing ever
// refreshes a canary record afterwards. A canary cancel closes at once, and a
// sweep closes the ones a run never cancelled - canary product ONLY.
// ---------------------------------------------------------------------------
{
  const { engine } = makeEngine({ name: "canary-close" });
  const privKeysFor = (addr) => Object.values(engine._store._snapshot()).filter((v) => v && typeof v === "object" && v.privateKey && String(v.accessKeyAddress || "").toLowerCase() === String(addr).toLowerCase()).length;
  async function activateCanary(label) {
    const offer = await engine.mintOffer({ product: CANARY_PRODUCT_KEY, target: label, canary: true });
    const { header } = await signCredential(Challenge.deserialize(offer.header));
    return engine.activateFromCredential(header);
  }
  async function activateReal() {
    const offer = await engine.mintOffer({ product: "domain-monitor", target: "real-subscriber.example" });
    const { header } = await signCredential(Challenge.deserialize(offer.header));
    return engine.activateFromCredential(header);
  }

  const c1 = await activateCanary("canary-cancel");
  const c1Rec = await engine._readRec(c1.subId);
  ok(privKeysFor(c1Rec.accessKeyAddress) > 0, "control: an active canary subscription's access key is held (so the destroy assertion below can fail)");
  const closed = await engine.cancel(c1.subId, c1.manageToken);
  ok(closed.status === "canceled", "a canary cancel closes the record AT ONCE (the old answer was active-until-period-end, which nothing ever refreshed)");
  ok(privKeysFor(c1Rec.accessKeyAddress) === 0, "and drops our private half of its access key, so the standing authorization is inert");

  const real = await activateReal();
  const realCancel = await engine.cancel(real.subId, real.manageToken);
  ok(realCancel.status === "active" && realCancel.cancelAtPeriodEnd === true, "a REAL subscriber's cancel still honours the period already paid for");

  const stale = await activateCanary("canary-stale");        // never cancelled (a crashed run)
  const staleRec = await engine._readRec(stale.subId);
  const realOpen = await activateReal();                     // a real subscriber, never cancelled
  advance(60 * 60 * 1000);
  const young = await activateCanary("canary-young");        // a run still in flight
  const r = await engine.sweepStaleCanaries({ olderThanMs: 30 * 60 * 1000 });
  ok(r.swept.length === 1 && r.swept[0].subId === stale.subId, `the sweep closes exactly the stale canary record (swept ${r.swept.length})`);
  ok((await engine._readRec(stale.subId)).status === "canceled" && privKeysFor(staleRec.accessKeyAddress) === 0, "the swept record is canceled and its access key destroyed");
  ok((await engine._readRec(young.subId)).status === "active" && r.skippedYoung === 1, "a canary record younger than the threshold is left for its run to finish");
  ok((await engine._readRec(realOpen.subId)).status === "active", "a REAL subscriber is never swept, whatever its age");
  ok((await engine._readRec(real.subId)).status === "active", "nor a real subscriber inside the paid period of a cancel");
  const again = await engine.sweepStaleCanaries({ olderThanMs: 30 * 60 * 1000 });
  ok(again.swept.length === 0, "the sweep is idempotent");
}

// ---------------------------------------------------------------------------
// Group 9c: a canary cancel that lands while a renewal is in flight. mppx 0.17
// reads the private key before signing and, once the transfer is sent,
// rewrites it (retainAccessKey: under the lookup key and the address). A
// cancel's destroy that runs between those two steps must stay destroyed.
// ---------------------------------------------------------------------------
{
  const h = makeEngine({ name: "canary-race" });
  const { engine } = h;
  const privKeysFor = (addr) => Object.values(engine._store._snapshot()).filter((v) => v && typeof v === "object" && v.privateKey && String(v.accessKeyAddress || "").toLowerCase() === String(addr).toLowerCase()).length;
  const offer = await engine.mintOffer({ product: CANARY_PRODUCT_KEY, target: "canary-race", canary: true });
  const { header } = await signCredential(Challenge.deserialize(offer.header));
  const sub = await engine.activateFromCredential(header);
  const rec = await engine._readRec(sub.subId);
  const addr = rec.accessKeyAddress;
  ok(privKeysFor(addr) > 0, "control: the canary's access key is held before the race");
  let release;
  const gate = new Promise((r) => { release = r; });
  let signedIn = null;
  const inSend = new Promise((r) => { signedIn = r; });
  // What 0.17's submitSubscriptionPayment does, in its order: read the key,
  // sign and send (the gate), then retain the key it read.
  h.setCharge(async (r) => {
    const mppxRec = await engine._subStore.get(r.mppxSubscriptionId);
    const stored = await engine._subStore.getAccessKeyByAddress(mppxRec.accessKey.accessKeyAddress, mppxRec.accessKey.keyToken);
    signedIn();
    await gate;
    await engine._subStore.retainAccessKey(mppxRec.lookupKey, stored);
    return { reference: "0xracetx" };
  });
  // The harness's activation writes the record on the 30-day period.
  advance(PERIOD + 1000);
  const pulling = engine.refreshStatus(sub.subId);
  const early = await Promise.race([inSend.then(() => "sending"), pulling.then((s) => `returned ${s}`)]);
  ok(early === "sending", `control: the renewal reached its send (${early})`);
  const closed = await engine.cancel(sub.subId, sub.manageToken);
  ok(closed.status === "canceled" && privKeysFor(addr) === 0, "the cancel closes the record and destroys the key while the renewal is still sending");
  release();
  await pulling;
  ok(privKeysFor(addr) === 0, `the renewal finishing after the cancel does not write the private key back (${privKeysFor(addr)} copies)`);
  ok((await engine._readRec(sub.subId)).status === "canceled", "and the record stays canceled");
  // The same race against the stale-canary sweep.
  const offer2 = await engine.mintOffer({ product: CANARY_PRODUCT_KEY, target: "canary-race-2", canary: true });
  const sub2 = await engine.activateFromCredential((await signCredential(Challenge.deserialize(offer2.header))).header);
  const addr2 = (await engine._readRec(sub2.subId)).accessKeyAddress;
  let release2; const gate2 = new Promise((r) => { release2 = r; });
  let in2; const inSend2 = new Promise((r) => { in2 = r; });
  h.setCharge(async (r) => {
    const mppxRec = await engine._subStore.get(r.mppxSubscriptionId);
    const stored = await engine._subStore.getAccessKeyByAddress(mppxRec.accessKey.accessKeyAddress, mppxRec.accessKey.keyToken);
    in2(); await gate2;
    await engine._subStore.retainAccessKey(mppxRec.lookupKey, stored);
    return { reference: "0xracetx2" };
  });
  advance(PERIOD + 1000);
  const pulling2 = engine.refreshStatus(sub2.subId);
  ok(await Promise.race([inSend2.then(() => "sending"), pulling2.then((s) => `returned ${s}`)]) === "sending", "control: the second renewal reached its send");
  const swept = await engine.sweepStaleCanaries({ olderThanMs: 1 });
  ok(swept.swept.some((s) => s.subId === sub2.subId) && privKeysFor(addr2) === 0, "the sweep closes it mid-renewal and destroys the key");
  release2();
  await pulling2;
  ok(privKeysFor(addr2) === 0, "and the late rewrite does not bring it back");
  // A key never destroyed is still rewritten as before (a real subscriber's
  // renewal keeps the key it bills with).
  const offer3 = await engine.mintOffer({ product: "domain-monitor", target: "race-real.example" });
  const sub3 = await engine.activateFromCredential((await signCredential(Challenge.deserialize(offer3.header))).header);
  const addr3 = (await engine._readRec(sub3.subId)).accessKeyAddress;
  const before3 = privKeysFor(addr3);
  h.setCharge(async (r) => {
    const mppxRec = await engine._subStore.get(r.mppxSubscriptionId);
    const stored = await engine._subStore.getAccessKeyByAddress(mppxRec.accessKey.accessKeyAddress, mppxRec.accessKey.keyToken);
    await engine._subStore.retainAccessKey(mppxRec.lookupKey, stored);
    return { reference: "0xrealtx" };
  });
  advance(PERIOD);
  ok(await engine.refreshStatus(sub3.subId) === "active", "a real subscriber renews");
  ok(privKeysFor(addr3) >= before3 && privKeysFor(addr3) > 0, "and its key is retained by the renewal as mppx writes it");
  const markers = () => engine._store._keys().filter((k) => k.startsWith(KEY_GONE_PREFIX));
  // The first race's marker went with the offer sweep a 30-day period later.
  ok(markers().length === 1 && markers()[0] === `${KEY_GONE_PREFIX}${addr2}`, `the swept key's marker is held (${markers().length})`);
  advance(8 * 24 * 60 * 60 * 1000);
  await engine.mintOffer({ product: "domain-monitor", target: "after-markers.example" });
  ok(markers().length === 0, "markers are dropped by the offer sweep once far past any renewal");

  // The view itself, on its own store: put and update are both refused for a
  // marked address, a destroy landing between put's check and its write is
  // undone, and nothing else is touched.
  const raw = createFileStore(join(tmp, "guard.json"));
  const view = guardDestroyedKeys(raw);
  const k = { accessKeyAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), keyType: "secp256k1", privateKey: generatePrivateKey() };
  await view.put("tempo:subscription:access-key:x", k);
  ok(!!(await raw.get("tempo:subscription:access-key:x")), "control: an unmarked key is written");
  await raw.put(`${KEY_GONE_PREFIX}${k.accessKeyAddress}`, { at: new Date(clock).toISOString() });
  await raw.delete("tempo:subscription:access-key:x");
  await view.put("tempo:subscription:access-key:y", k);
  await view.update("tempo:subscription:access-key:z", () => ({ op: "set", value: k, result: k }));
  ok(!(await raw.get("tempo:subscription:access-key:y")) && !(await raw.get("tempo:subscription:access-key:z")), "a marked key is written by neither put nor update");
  await view.put("tempo:subscription:record:r", { subscriptionId: "r", accessKey: { accessKeyAddress: k.accessKeyAddress } });
  ok(!!(await raw.get("tempo:subscription:record:r")), "a record that names the address but holds no private key is written");
  const k2 = { ...k, accessKeyAddress: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() };
  const racing = Object.create(raw);
  let first = true;
  racing.get = async (key) => {
    // The destroy lands right after put's first check.
    if (key === `${KEY_GONE_PREFIX}${k2.accessKeyAddress}` && first) { first = false; return null; }
    if (key === `${KEY_GONE_PREFIX}${k2.accessKeyAddress}`) return { at: "x" };
    return raw.get(key);
  };
  await guardDestroyedKeys(racing).put("tempo:subscription:access-key:w", k2);
  ok(!(await raw.get("tempo:subscription:access-key:w")), "a destroy between the check and the write is undone");
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
  // fees settle in USDC.e and gas*price converts at ~1e12.
  const usd = (gas, price) => Number((gas * BigInt(price)) / 1_000_000_000_000n) / 1e6;
  ok(usd(pol.maxGas, 600_000_000) < 0.01,
    `at the live basefee this ceiling is worth well under a cent per transaction`);

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

// --- a cancel during an in-flight renewal (one process, the file store) -------
// The renewal's charge takes seconds; a cancel that lands meanwhile must not be
// undone by the renewal's write, and the next period must not be pulled.
{
  const { engine: E, calls, setCharge } = makeEngine({ name: "cancel-race" });
  const offer = await E.mintOffer({ product: "domain-monitor", target: "race.example" });
  const { header } = await signCredential(Challenge.deserialize(offer.header));
  const sub = await E.activateFromCredential(header);
  advance(PERIOD);
  // After the charge, the renewal's next write of the record (a put or a
  // conditional write) first lets a whole cancel run.
  let charged = false;
  setCharge(() => { charged = true; return { reference: "0xrace" }; });
  const kv = E._store, realPut = kv.put, realCas = kv.compareAndSet;
  const cancelFirst = async (k) => { if (k === `a402:sub:${sub.subId}` && charged) { charged = false; await E.cancel(sub.subId, sub.manageToken); } };
  kv.put = async (k, v) => { await cancelFirst(k); return realPut.call(kv, k, v); };
  kv.compareAndSet = async (k, d) => { await cancelFirst(k); return realCas.call(kv, k, d); };
  let st0;
  try { st0 = await E.refreshStatus(sub.subId); } finally { kv.put = realPut; kv.compareAndSet = realCas; }
  const rec = await E._readRec(sub.subId);
  ok(rec.cancelAtPeriodEnd === true && rec.lastChargedPeriod === 1, `file store: a cancel during the renewal survives its write and the charge stands (cancel=${rec.cancelAtPeriodEnd}, period=${rec.lastChargedPeriod})`);
  ok(rec.status === "active" && st0 === "active", `file store: the period the renewal paid is honoured until it ends (record ${rec.status}, answer ${st0})`);
  advance(PERIOD);
  const before = calls.charge;
  const st = await E.refreshStatus(sub.subId);
  ok(st === "canceled" && calls.charge === before, `file store: the next period is not charged after that cancel (status ${st})`);
}

// --- validity window on SERVER-SIGNED renewals ------------------------------
{
  ok(renewalValidForSeconds(undefined) === 120 && renewalValidForSeconds("") === 120, "renewal window defaults to 120 s");
  ok(renewalValidForSeconds("180") === 180, "TEMPO_SUBSCRIPTION_VALID_FOR_S sets the window");
  // The unconfirmed-renewal alert threshold: validated, never silently off.
  ok(RENEWAL_UNCONFIRMED_ALERT_HOURS_DEFAULT === 3 && renewalUnconfirmedAlertHours({}) === 3 && renewalUnconfirmedAlertHours({ MPP_SUB_UNCONFIRMED_ALERT_HOURS: " " }) === 3, "the unconfirmed-renewal alert defaults to 3 hours");
  ok(renewalUnconfirmedAlertHours({ MPP_SUB_UNCONFIRMED_ALERT_HOURS: "junk" }) === 3 && renewalUnconfirmedAlertHours({ MPP_SUB_UNCONFIRMED_ALERT_HOURS: "-2" }) === 3 && renewalUnconfirmedAlertHours({ MPP_SUB_UNCONFIRMED_ALERT_HOURS: "Infinity" }) === 3, "a value that is not a non-negative number keeps the default");
  ok(renewalUnconfirmedAlertHours({ MPP_SUB_UNCONFIRMED_ALERT_HOURS: "1.5" }) === 1.5 && renewalUnconfirmedAlertHours({ MPP_SUB_UNCONFIRMED_ALERT_HOURS: "0" }) === null && renewalUnconfirmedAlertHours({ MPP_SUB_UNCONFIRMED_ALERT_HOURS: "Off" }) === null, "a number sets it; 0 or off disables it");
  {
    const T = Date.parse("2026-11-01T00:00:00Z"), H = 3_600_000;
    const u = (status, atMs) => ({ status, unconfirmedCharge: { at: new Date(atMs).toISOString(), periodIndex: 1 } });
    ok(renewalsWord([], { hours: 3, at: T }).status === "ok" && renewalsWord([{ status: "active" }, { status: "past_due" }], { hours: 3, at: T }).status === "ok", "no unconfirmed renewal reads ok");
    ok(renewalsWord([u("past_due", T - 4 * H)], { hours: 3, at: T }).status === "unconfirmed" && renewalsWord([u("active", T - 4 * H)], { hours: 3, at: T }).status === "unconfirmed", "an open subscription unconfirmed past the window reads unconfirmed");
    ok(renewalsWord([u("canceled", T - 40 * H), u("expired", T - 40 * H)], { hours: 3, at: T }).status === "ok", "a canceled or expired record never holds the word");
    ok(renewalsWord([u("past_due", T - 4 * H)], { hours: null, at: T }).status === "off", "a disabled alert reads off");
    const f = renewalsWord([u("past_due", T - 4 * H), u("past_due", T - 9 * H), u("past_due", T - H)], { hours: 3, at: T, full: true });
    ok(f.unconfirmedCount === 2 && f.oldestAttemptAt === new Date(T - 9 * H).toISOString() && f.alertHours === 3, `the full read counts only the stuck ones and names the oldest (${JSON.stringify(f)})`);
    ok(Object.keys(renewalsWord([u("past_due", T - 4 * H)], { hours: 3, at: T })).join() === "status", "the public read is the word alone");
  }
  ok(renewalValidForSeconds("1000") === RENEWAL_VALID_FOR_MAX_S && RENEWAL_VALID_FOR_MAX_S === 240, "clamped to <= 240 s (under the 5-minute expiring-nonce cap)");
  ok(renewalValidForSeconds("5") === 25 && ACTIVATION_VALID_FOR_S === 25, "never shorter than the 25 s activation window");
  for (const bad of ["abc", "-3", "12.5", "0", "1e3", "NaN"]) ok(renewalValidForSeconds(bad) === 120, `malformed ${JSON.stringify(bad)} -> default`);

  const { tempo: tempoChain } = await import("viem/tempo/chains");
  const prep = async (chain, req) => chain.prepareTransactionRequest[0]({ calls: [], chainId: 4217, ...req }, { client: { chain }, phase: "beforeFillTransaction" });
  const nowS = () => Math.floor(Date.now() / 1000);
  // viem's own default is read, never typed: it was 25 s through 2.57.13 and
  // 270 s from 2.57.16. Whatever it is, it must sit under the protocol cap and
  // nothing below may depend on it.
  const { Transaction: TempoTx } = await import("viem/tempo");
  const PROTOCOL_CAP_S = TempoTx.expiringNonceMaxExpiry;
  ok(Number.isInteger(PROTOCOL_CAP_S) && PROTOCOL_CAP_S >= 300, `viem names the protocol's expiring-nonce cap (${PROTOCOL_CAP_S} s)`);
  const stock = await prep(tempoChain, { nonceKey: "expiring" });
  const STOCK_S = stock.validBefore - nowS();
  ok(STOCK_S > 0 && STOCK_S <= PROTOCOL_CAP_S, `control: viem's stock Tempo chain stamps a window inside the cap (+${STOCK_S} s)`);
  ok(RENEWAL_VALID_FOR_MAX_S < PROTOCOL_CAP_S, `the longest renewal window (${RENEWAL_VALID_FOR_MAX_S} s) stays under the protocol cap (${PROTOCOL_CAP_S} s)`);
  ok(ACTIVATION_VALID_FOR_S * 1000 < TEMPO_RPC_TIMEOUT_MS, `the activation window (${ACTIVATION_VALID_FOR_S} s) is shorter than the RPC timeout (${TEMPO_RPC_TIMEOUT_MS} ms), so a timed-out activation can no longer land`);
  // Our window wins over ANY stock default, not only today's.
  const oddDefault = { prepareTransactionRequest: [async (r) => ({ ...r, validBefore: r.validBefore ?? nowS() + 999 }), { runAt: ["beforeFillTransaction"] }] };
  const overDefault = await withRenewalValidity(oddDefault, 120).prepareTransactionRequest[0]({ nonceKey: "expiring" }, {});
  ok(Math.abs(overDefault.validBefore - nowS() - 120) <= 2, "the stamped window holds whatever viem's default is");
  const ours = await prep(withRenewalValidity(tempoChain, 120), { nonceKey: "expiring" });
  ok(Math.abs(ours.validBefore - nowS() - 120) <= 2, `the renewal chain stamps now + 120 s through viem's real hook (got +${ours.validBefore - nowS()})`);
  const sponsored = await prep(withRenewalValidity(tempoChain, 200), { feePayer: true });
  ok(Math.abs(sponsored.validBefore - nowS() - 200) <= 2, "a sponsored request (implicit expiring nonce) gets the window too");
  const preset = await prep(withRenewalValidity(tempoChain, 200), { nonceKey: "expiring", validBefore: 1234 });
  ok(preset.validBefore === 1234, "an explicit validBefore is never overwritten");
  const seen = [];
  const fake = { prepareTransactionRequest: [async (r) => { seen.push(r); return r; }, { runAt: ["beforeFillTransaction"] }] };
  await withRenewalValidity(fake, 120).prepareTransactionRequest[0]({ nonceKey: 5n }, {});
  ok(seen[0].validBefore === undefined, "a non-expiring nonce lane passes through untouched");

  const { engine: eng } = makeEngine({ name: "renewal-window" });
  const rc = await eng._renewalClient();
  const bc = await eng._client();
  ok(eng._renewalValidForS === 120, "the engine resolves the renewal window at construction");
  const viaRenewal = await rc.chain.prepareTransactionRequest[0]({ calls: [], chainId: 4217, nonceKey: "expiring" }, { client: rc, phase: "beforeFillTransaction" });
  const viaShared = await bc.chain.prepareTransactionRequest[0]({ calls: [], chainId: 4217, nonceKey: "expiring" }, { client: bc, phase: "beforeFillTransaction" });
  ok(Math.abs(viaRenewal.validBefore - nowS() - 120) <= 2, "the renewal client carries the longer window");
  ok(Math.abs(viaShared.validBefore - nowS() - ACTIVATION_VALID_FOR_S) <= 2, `the activation client stamps its own ${ACTIVATION_VALID_FOR_S} s, not viem's default (got +${viaShared.validBefore - nowS()}, stock +${STOCK_S})`);
  ok(rc !== bc, "renewals use their own client");
  // The caller path: viem's real prepareTransactionRequest on each engine
  // chain, the way mppx's submitSubscriptionPayment calls it, over a stub RPC.
  {
    const { createClient, custom } = await import("viem");
    const { prepareTransactionRequest } = await import("viem/actions");
    const { privateKeyToAccount } = await import("viem/accounts");
    const stubRpc = custom({ async request({ method }) {
      if (method === "eth_chainId") return "0x1079";
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x1", number: "0x1", timestamp: "0x1", hash: `0x${"0".repeat(64)}`, transactions: [] };
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_maxPriorityFeePerGas" || method === "eth_gasPrice") return "0x1";
      if (method === "eth_getTransactionCount") return "0x0";
      const e = new Error(`stub RPC: ${method} unsupported`); e.code = -32601; throw e;
    } }, { retryCount: 0 });
    const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const req = { account, calls: [{ to: "0x20c0000000000000000000000000000000000000", data: "0x" }], nonceKey: "expiring" };
    const viaPrep = async (chain) => (await prepareTransactionRequest(createClient({ chain, transport: stubRpc }), req)).validBefore - nowS();
    const actS = await viaPrep(bc.chain), renS = await viaPrep(rc.chain), stockS = await viaPrep(tempoChain);
    ok(Math.abs(actS - ACTIVATION_VALID_FOR_S) <= 2, `activation through prepareTransactionRequest sends validBefore = now + ${ACTIVATION_VALID_FOR_S} s (got +${actS})`);
    ok(Math.abs(renS - 120) <= 2, `renewal through prepareTransactionRequest sends validBefore = now + 120 s (got +${renS})`);
    ok(Math.abs(stockS - STOCK_S) <= 2, `control: the stock chain sends viem's default through the same call (+${stockS})`);
  }

  const src = readFileSync(new URL("../src/mpp-subscriptions.js", import.meta.url), "utf8");
  const renewCall = src.slice(src.indexOf("tempoServer.renewSubscription({"));
  const renewArgs = renewCall.slice(0, renewCall.indexOf("});"));
  ok(/getClient:\s*\(\)\s*=>\s*tempoRenewalClient\(\)/.test(renewArgs) && !/clientOverride\(\)/.test(renewArgs), "renewSubscription is handed the renewal client, not the shared one");
  const methodStart = src.indexOf("tempoServer.subscription({");
  const methodArgs = src.slice(methodStart, src.indexOf("resolve:", methodStart));
  ok(methodStart > 0 && /clientOverride\(\)/.test(methodArgs) && !/tempoRenewalClient/.test(methodArgs), "activation keeps the shared client");
  ok(!/withRenewalValidity|tempoRenewalClient/.test(readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8")), "the buyer-side tempo/charge gate never touches the renewal window");
}

// --- a store written before mppx 0.15 keeps working ---------------------------
// 0.15 moved mppx's OWN anonymous subscription challenges to a sealed key token
// and a persistent sealing key, and 0.17 activation retains the access key under
// the subscription's lookup key. This engine mints its own offers through
// getOrCreateAccessKey, so the keys it holds are in the pre-0.15 layout. A store
// file written in exactly that layout (key names as mppx 0.13 wrote them) must
// still serve, renew and destroy its keys after the upgrade.
{
  const name = "legacy-0-13";
  const first = makeEngine({ name });
  const offer = await first.engine.mintOffer({ product: "domain-monitor", target: "legacy.example" });
  const { header } = await signCredential(Challenge.deserialize(offer.header));
  const sub = await first.engine.activateFromCredential(header);
  const path = join(tmp, `${name}.json`);
  const written = JSON.parse(readFileSync(path, "utf8"));
  const OLD_PREFIXES = ["tempo:subscription:record:", "tempo:subscription:key:", "tempo:subscription:activation:", "tempo:subscription:access-key:", "tempo:subscription:credential:"];
  const mppxKeys = Object.keys(written).filter((k) => !k.startsWith("a402:"));
  ok(mppxKeys.length > 0 && mppxKeys.every((k) => OLD_PREFIXES.some((p) => k.startsWith(p)) && !k.includes("pending-access-key")),
    `minting and activating write only the key names mppx 0.13 used, no sealing key (${mppxKeys.length} keys)`);

  // Rebuild the file by hand in the 0.13 layout: our own records as written,
  // mppx's from literal key names, so nothing in it comes from 0.17's writer.
  const rec = first.engine.get(sub.subId);
  const mppxRec = await first.engine._subStore.get(rec.mppxSubscriptionId);
  const keyEntry = written[`tempo:subscription:access-key:address:${rec.accessKeyAddress}`];
  ok(keyEntry?.privateKey && Object.keys(keyEntry).sort().join(",") === "accessKeyAddress,keyType,privateKey", "the held access key is the 0.13 record shape { accessKeyAddress, keyType, privateKey }");
  const legacy = Object.fromEntries(Object.entries(written).filter(([k]) => k.startsWith("a402:")));
  const offerNonce = Object.keys(written).find((k) => k.startsWith("tempo:subscription:access-key:offer:"));
  legacy[offerNonce] = { ...keyEntry };
  legacy[`tempo:subscription:access-key:address:${rec.accessKeyAddress}`] = { ...keyEntry };
  legacy[`tempo:subscription:record:${mppxRec.subscriptionId}`] = mppxRec;
  legacy[`tempo:subscription:key:${mppxRec.lookupKey}`] = mppxRec.subscriptionId;
  writeFileSync(path, JSON.stringify(legacy));

  // A fresh engine on that file: the process after the upgrade.
  const after = makeEngine({ name });
  const E = after.engine;
  await E.warm();
  ok(E.get(sub.subId)?.status === "active" && E.listActive("domain").length === 1, "after the upgrade the subscriber written before it is active and served");
  ok((await E._subStore.getByKey(mppxRec.lookupKey))?.subscriptionId === mppxRec.subscriptionId && (await E._subStore.get(mppxRec.subscriptionId))?.lastChargedPeriod === 0,
    "mppx 0.17 reads the 0.13 subscription record by id and by lookup key");
  // The exact lookup 0.17's submitSubscriptionPayment makes before signing a
  // renewal: by address, with the record's own (absent) key token.
  const held = await E._subStore.getAccessKeyByAddress(mppxRec.accessKey.accessKeyAddress, mppxRec.accessKey.keyToken);
  ok(held?.privateKey === keyEntry.privateKey, "the renewal's access-key lookup finds the 0.13 private key with no key token");
  ok((await E._subStore.getOrCreateAccessKey(offerNonce.slice("tempo:subscription:access-key:".length)))?.privateKey === keyEntry.privateKey, "getOrCreateAccessKey returns the 0.13 key for its offer instead of minting another");
  advance(PERIOD);
  ok(await E.refreshStatus(sub.subId) === "active" && after.calls.charge === 1 && E.get(sub.subId).lastChargedPeriod === 1, "the next period renews from the 0.13 records");

  // 0.17 activation also retains the key under the lookup key, a third copy
  // that destroyAccessKey finds by content, never by key name.
  await E._subStore.retainAccessKey(mppxRec.lookupKey, held);
  const copies = () => Object.values(JSON.parse(readFileSync(path, "utf8"))).filter((v) => v && typeof v === "object" && v.privateKey === keyEntry.privateKey).length;
  ok(copies() >= 3, `the key is held under offer, address and lookup key (${copies()} copies)`);
  ok(!Object.keys(JSON.parse(readFileSync(path, "utf8"))).some((k) => k.includes("pending-access-key")), "no sealing key is ever written: our challenges carry no key token");
}

// The log line for a failed RPC call passes the redactor: viem's
// HttpRequestError quotes the request URL in metaMessages and its message, and
// an RPC URL's path can carry its key.
{
  const pathKey = ["rpc", "Canary", "Path", String(process.pid), "abcdef"].join("");
  const saved = process.env.TEMPO_RPC_URL;
  process.env.TEMPO_RPC_URL = `https://rpc.example.test/${pathKey}`;
  const err = new HttpRequestError({ url: `https://rpc.example.test/${pathKey}`, status: 500, details: "upstream busy", body: { method: "eth_call" } });
  ok(JSON.stringify(err.metaMessages).includes(pathKey), "control: viem's HttpRequestError quotes the RPC URL in metaMessages");
  const line = diagnoseError(new Error("charge failed", { cause: err }));
  ok(!line.includes(pathKey) && line.includes("[redacted]") && line.includes("upstream busy"), "diagnoseError redacts an RPC URL path key and keeps the upstream's reason");
  const cut = diagnoseError(Object.assign(new Error("x"), { metaMessages: ["y".repeat(290) + pathKey] }));
  ok(!cut.includes(pathKey.slice(0, 8)), "a field is redacted before it is cut, so no key head survives the cut");
  if (saved === undefined) delete process.env.TEMPO_RPC_URL; else process.env.TEMPO_RPC_URL = saved;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, 0 failed`);
