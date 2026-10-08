// Native MPP `stripe/charge` — accept CARD payments over the MPP wire via
// Stripe Shared Payment Tokens (SPTs). The first non-crypto buyer path: an
// agent presents a Stripe SPT (issued by its Link Agent Wallet), we mint a
// stripe/charge challenge, and settle a PaymentIntent to our Stripe balance.
// Docs: https://docs.stripe.com/payments/machine/mpp . The WIRE SHAPE was
// sandbox-validated 2026-08-20 (`npx mppx validate --yes` against a minimal
// mppx.charge() server, Payment [stripe] successful) - that proved the
// challenge/credential shapes, NOT this gate: its first live buy (Link SPT,
// 2026-08-26) was refused by the pre-handler validate, see
// validateStripeCredential. Live proof of the gate = the link-cli buy.
//
// Structurally the SAME gate as src/mpp-tempo.js (validate before the handler,
// buffer the response, settle ONLY after a <400, replay with a Payment-Receipt)
// but with three deliberate differences:
//   1. The challenge-signing secret is DERIVED from the Stripe secret key
//      (HMAC(STRIPE_SECRET_KEY, "mpp-challenge-signing"), base64) exactly as
//      Stripe's own docs specify - NOT our MPP_SECRET_KEY. So stripe/charge
//      challenges verify against Stripe's convention while evm/tempo keep ours.
//   2. Settlement is a Stripe PaymentIntent (Method.broadcastCredential runs
//      the mppx stripe method's verify -> createPaymentIntent), authoritative
//      by return value - there is no relay that can report failure for a
//      settled charge, so no chain-truth confirm is needed (unlike tempo).
//   3. Cards have a $0.50 minimum (SPT), so stripe/charge is offered ONLY on
//      routes priced >= $0.50 - a challenge is never minted below that.
//
// Rollout switch = STRIPE_SECRET_KEY + STRIPE_PROFILE_ID both present. Unset =
// not mounted, no stripe challenge on any 402 (pure evm/tempo/x402).
import Stripe from "stripe";
import { Challenge, Credential, Expires, Method, Receipt } from "mppx";
import { stripe as stripeMethods } from "mppx/server";
import { createHmac } from "node:crypto";
import { mppProblem, markMppProblem, sendMppProblem } from "./mpp-problem.js";
import { chargeCancelledForClientGone, CLIENT_GONE_TEXT } from "./hangup-settlement.js";

export const STRIPE_MIN_USD = 0.50; // SPT card minimum (docs.stripe.com/payments/machine)
const CHALLENGE_TIMEOUT_SECONDS = 300;

export function stripeEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PROFILE_ID);
}
/** Discovery metadata for /openapi.json x-payment-info (null unless enabled —
 *  never advertise stripe/charge on any operation when the gate is dormant).
 *  minUsd is the SPT card floor; only routes >= it are stripe-payable. */
export function stripeDiscoveryInfo() {
  if (!stripeEnabled()) return null;
  return { minUsd: STRIPE_MIN_USD, currency: "usd", profileId: stripeProfileId() };
}
function stripeSecretKey() { return process.env.STRIPE_SECRET_KEY || ""; }
function stripeProfileId() { return process.env.STRIPE_PROFILE_ID || ""; }
function realmDefault() { try { return new URL(process.env.BASE_URL || "https://agent402.tools").host; } catch { return "agent402.tools"; } }

// The MPP challenge-signing secret, DERIVED from the Stripe key per the docs.
function challengeSecret() {
  return createHmac("sha256", stripeSecretKey()).update("mpp-challenge-signing").digest("base64");
}

// The mppx stripe/charge Method.Server, cached and rebuilt only when the key
// or profile changes (same memo discipline as the tempo method). Lazily builds
// a Stripe client so this module imports with no key present (offline tests).
let cachedMethod = null;
let cachedKeyProfile = "";
function stripeMethod() {
  const key = stripeSecretKey();
  const profile = stripeProfileId();
  const sig = `${key}|${profile}`;
  if (cachedMethod && cachedKeyProfile === sig) return cachedMethod;
  const client = new Stripe(key);
  cachedMethod = stripeMethods.charge({
    client,
    networkId: profile,
    paymentMethodTypes: ["card"],
    livemode: !key.includes("_test_"),
  });
  cachedKeyProfile = sig;
  return cachedMethod;
}

const usdToCents = (usd) => Math.round(Number(usd) * 100);

/** Mint one stripe/charge challenge for a route priced >= $0.50. Returns the
 *  WWW-Authenticate "Payment id=…" value, or null when disabled/underpriced.
 *  amount is integer CENTS as a string, decimals 2, currency usd, our profile
 *  as methodDetails.networkId - the exact shape mppx validate accepted. */
export function mintStripeChallenge({ priceUsd, description, realm, secretKey } = {}) {
  if (!stripeEnabled()) return null;
  const amount = Number(priceUsd);
  if (!Number.isFinite(amount) || amount < STRIPE_MIN_USD) return null; // card minimum
  try {
    // The stripe/charge request schema takes a DECIMAL dollar `amount` (e.g.
    // "0.50") and REQUIRES `paymentMethodTypes`; mppx's transform runs
    // parseUnits(amount, decimals) to the cents stored on the wire and folds
    // networkId + paymentMethodTypes into methodDetails. Passing cents here
    // would 100x the charge (parseUnits("50",2) = 5000). Byte-shape proven
    // by `npx mppx validate` 2026-08-20.
    const challenge = Challenge.fromMethod(stripeMethod(), {
      realm: realm || realmDefault(),
      expires: new Date(Date.now() + CHALLENGE_TIMEOUT_SECONDS * 1000),
      request: {
        amount: amount.toFixed(2),
        currency: "usd",
        decimals: 2,
        networkId: stripeProfileId(),
        paymentMethodTypes: ["card"],
        ...(description ? { description: String(description).slice(0, 200) } : {}),
      },
      secretKey: secretKey || challengeSecret(),
    });
    return Challenge.serialize(challenge);
  } catch (e) {
    console.warn(`[mpp-stripe] mintStripeChallenge failed: ${String(e?.message || e).slice(0, 200)}`);
    return null;
  }
}

const isStripeCredential = (auth) => {
  if (!auth || !/^Payment\s/i.test(auth)) return false;
  try { const c = Credential.deserialize(auth); return c?.challenge?.method === "stripe" && (c.challenge.intent || "charge") === "charge"; }
  catch { return false; }
};

/** BINDING CHECK — before any Stripe API call, prove this credential carries a
 *  challenge WE minted (HMAC over the Stripe-derived secret), for our profile,
 *  unexpired, at >= this route's price. Same defense as the tempo gate: without
 *  it a buyer could forge a $0.50 challenge to any networkId and be served any
 *  route. Pure/synchronous/never throws. Exported for tests. */
export function checkStripeCredentialBinding(authorizationHeader, { secretKey, realm, priceFor, method, path, req = null, now = Date.now() } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  let credential;
  try { credential = Credential.deserialize(authorizationHeader); } catch { return bad("credential does not deserialize"); }
  const ch = credential?.challenge;
  if (!ch || ch.method !== "stripe" || (ch.intent || "charge") !== "charge") return bad("not a stripe/charge challenge");
  const sk = secretKey || challengeSecret();
  let verified = false;
  try { verified = Challenge.verify(ch, { secretKey: sk }); } catch { verified = false; }
  if (!verified) return bad("challenge id does not HMAC-verify - not minted by this server");
  if (realm && ch.realm !== realm) return bad(`challenge realm ${JSON.stringify(ch.realm)} is not ours`);
  const exp = Date.parse(ch.expires);
  if (!Number.isFinite(exp) || exp <= now) return bad("challenge expired");
  const r = ch.request || {};
  if (String(r.currency || "").toLowerCase() !== "usd") return bad("challenge currency is not usd");
  const networkId = r.methodDetails?.networkId ?? r.networkId;
  if (String(networkId || "") !== stripeProfileId()) return bad("challenge networkId is not this server's Stripe profile");
  const item = typeof priceFor === "function" ? priceFor(method, path, req) : null;
  const priceUsd = Number(item?.priceUsd);
  if (!(priceUsd >= STRIPE_MIN_USD)) return bad(`route price ${priceUsd} is below the $${STRIPE_MIN_USD} card minimum - stripe/charge is not offered here`);
  if (item.identityBound) return bad("this route is wallet-identity bound; Stripe credentials carry no verified wallet payer - pay it over an x402 rail");
  const expected = usdToCents(priceUsd);
  let amount;
  try { amount = parseInt(String(r.amount), 10); } catch { return bad("challenge amount is not an integer cents string"); }
  if (!Number.isFinite(amount)) return bad("challenge amount is not an integer cents string");
  if (amount < expected) return bad(`challenge amount ${amount} is below this route's price ${expected} cents`);
  return { ok: true, challenge: ch, amountCents: amount, expectedCents: expected };
}

/** Non-mutating pre-check, run BEFORE the handler: is this a well-formed,
 *  unexpired stripe/charge credential carrying an SPT?
 *
 *  Structural only, never touches Stripe. mppx's stripe method has NO
 *  `validate` step - its only operation is `verify`, which CREATES the
 *  PaymentIntent (the charge) - so `Method.validateCredential` throws
 *  "stripe/charge does not support non-mutating credential validation" for
 *  every credential. That is what the first live Link buy hit (2026-08-26):
 *  every card credential was refused before the handler ran, and the injected
 *  stubs in test-mpp-stripe never saw it. The checks mppx would have made
 *  before charging (method/intent dispatch, expiry, payload schema) are done
 *  here with its own primitives; HMAC binding + amount are already checked by
 *  checkStripeCredentialBinding, and the charge itself is settle()'s job. */
export async function validateStripeCredential(authorizationHeader) {
  try {
    const credential = Credential.deserialize(String(authorizationHeader || ""));
    const method = stripeMethod();
    if (credential.challenge.method !== method.name || credential.challenge.intent !== method.intent) {
      const m = String(credential.challenge.method).replace(/[^\w.-]/g, "").slice(0, 32), it = String(credential.challenge.intent).replace(/[^\w.-]/g, "").slice(0, 32);
      return { ok: false, error: `no registered method for ${m}/${it}`, reason: "the credential is not a stripe/charge credential" };
    }
    Expires.assert(credential.challenge.expires, credential.challenge.id);
    const parsed = method.schema.credential.payload.safeParse(credential.payload);
    if (!parsed.success) return { ok: false, error: "Invalid credential payload: missing or malformed spt", reason: "the credential carries no Shared Payment Token" };
    if (!/^spt_/.test(String(parsed.data.spt))) return { ok: false, error: "spt does not look like a Shared Payment Token id", reason: "the credential carries no Shared Payment Token" };
    return { ok: true, validation: { spt: parsed.data.spt, externalId: parsed.data.externalId } };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300), reason: "the Stripe credential failed validation" };
  }
}

/** Terminal — settles the card via a Stripe PaymentIntent (mppx stripe method's
 *  broadcast -> createPaymentIntent with the SPT). Call ONLY after a <400
 *  handler response. Returns { ok, receipt } or { ok:false, error }. */
export async function settleStripeCredential(authorizationHeader) {
  try {
    const receipt = await Method.broadcastCredential([stripeMethod()], authorizationHeader);
    return { ok: true, receipt };
  } catch (e) {
    // 900, not 300: Stripe's permission errors put the fix ("Enabling X
    // permissions on this key would allow this request") past char 300, and
    // the first live buy's log cut it off. Operator log only - the buyer sees
    // `reason`, never Stripe's words.
    return { ok: false, error: String(e?.message || e).slice(0, 900), reason: "Stripe declined or could not capture the charge" };
  }
}

export function stripeReceiptHeader(receipt) {
  try { return Receipt.serialize(receipt); } catch { return null; }
}
export function stripeTxFromReceiptHeader(header) {
  try { return Receipt.deserialize(String(header)).reference || null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// OUTBOUND: append a stripe/charge challenge to a 402, next to evm/tempo. Only
// on routes priced >= $0.50 (card minimum). No-op unless enabled.
// ---------------------------------------------------------------------------
export function createStripeChallengeAppender({ realm, secretKey, priceFor } = {}) {
  if (!stripeEnabled()) return null;
  return function stripeChallengeAppender(req, res, next) {
    const origWriteHead = res.writeHead;
    res.writeHead = function stripeWriteHead(...args) {
      try {
        if (res.statusCode === 402) {
          const item = typeof priceFor === "function" ? priceFor(req.method, req.path, req) : null;
          const priceUsd = Number(item?.priceUsd);
          if (item && !item.identityBound && priceUsd >= STRIPE_MIN_USD) {
            const header = mintStripeChallenge({ priceUsd, realm, secretKey });
            if (header) {
              const existing = res.getHeader("WWW-Authenticate");
              res.setHeader("WWW-Authenticate", existing ? `${existing}, ${header}` : header);
            }
          }
        }
      } catch { /* never break a 402 over an optional challenge */ }
      res.writeHead = origWriteHead;
      return origWriteHead.apply(res, args);
    };
    next();
  };
}

// ---------------------------------------------------------------------------
// INBOUND: settle a stripe/charge credential. Same buffer-then-decide
// discipline as the tempo gate. Refuses to mount without a secret + priceFor.
// ---------------------------------------------------------------------------
export function createStripeGate({ validate = validateStripeCredential, settle = settleStripeCredential, replayGuard, secretKey, realm, priceFor } = {}) {
  if (!stripeEnabled()) return null;
  if (typeof priceFor !== "function") {
    console.error("[mpp-stripe] REFUSING to mount the Stripe gate: priceFor is required to bind credentials to route prices");
    return null;
  }
  const sk = secretKey || challengeSecret();
  return function stripeGate(req, res, next) {
    const auth = req.headers.authorization;
    if (!isStripeCredential(auth)) return next();

    const binding = checkStripeCredentialBinding(auth, { secretKey: sk, realm, priceFor, method: req.method, path: req.path, req });
    if (!binding.ok) {
      console.warn(`[mpp-stripe] credential rejected before settle(): ${binding.reason}`);
      if (binding.reason !== "not a stripe/charge challenge") {
        const kind = /does not deserialize/.test(binding.reason) ? "malformed-credential"
          : /amount .* below/.test(binding.reason) ? "payment-insufficient"
          : "invalid-challenge";
        markMppProblem(req, res, mppProblem(kind, kind === "malformed-credential" ? "Credential is malformed: the Authorization: Payment value does not decode." : `Challenge is invalid: ${binding.reason}. Request the resource again for a fresh challenge.`));
      }
      return next();
    }

    validate(auth).then(async (v) => {
      if (!v.ok) {
        console.warn(`[mpp-stripe] credential rejected by validate(): ${v.error || "(no error detail)"}`);
        markMppProblem(req, res, mppProblem("verification-failed", `Payment verification failed: ${String(v.reason || "the Stripe credential was rejected").slice(0, 160)}`));
        return next();
      }
      req.mppStripeCredential = true;
      const replayKey = replayGuard ? `stripe:${binding.challenge.id}` : null;
      if (replayGuard && replayKey) {
        const verdict = await replayGuard.begin(replayKey);
        if (verdict !== "ok") return sendMppProblem(res, mppProblem("invalid-challenge", `Challenge is invalid: this credential was already used or is in flight (${verdict}). Request the resource again for a fresh challenge.`));
      }
      const releaseReplay = () => { if (replayGuard && replayKey) replayGuard.release(replayKey).catch(() => {}); };
      const settleReplay = () => { if (replayGuard && replayKey) replayGuard.settle(replayKey).catch(() => {}); };

      req.stripeSettling = true;
      // The stripe credential is the ONLY payment evidence: drop any x402
      // header riding alongside it (same identity-spoof defense as tempo).
      for (const h of ["payment-signature", "x-payment", "payment-identifier", "x-pow-solution"]) delete req.headers[h];

      const originalWriteHead = res.writeHead.bind(res);
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);
      const originalFlushHeaders = typeof res.flushHeaders === "function" ? res.flushHeaders.bind(res) : null;
      let bufferedCalls = [];
      let settled = false;
      let endCalled;
      const endPromise = new Promise((resolve) => { endCalled = resolve; });
      const restore = () => {
        settled = true;
        res.writeHead = originalWriteHead;
        res.write = originalWrite;
        res.end = originalEnd;
        if (originalFlushHeaders) res.flushHeaders = originalFlushHeaders;
      };
      res.writeHead = (...a) => { if (!settled) { bufferedCalls.push(["writeHead", a]); return res; } return originalWriteHead(...a); };
      res.write = (...a) => { if (!settled) { bufferedCalls.push(["write", a]); return true; } return originalWrite(...a); };
      res.end = (...a) => { if (!settled) { bufferedCalls.push(["end", a]); endCalled(); return res; } return originalEnd(...a); };
      if (originalFlushHeaders) res.flushHeaders = () => { if (!settled) { bufferedCalls.push(["flushHeaders", []]); return; } return originalFlushHeaders(); };
      const replay = () => {
        for (const [fn, a] of bufferedCalls) {
          if (fn === "writeHead") originalWriteHead(...a);
          else if (fn === "write") originalWrite(...a);
          else if (fn === "flushHeaders") { if (originalFlushHeaders) originalFlushHeaders(); }
          else originalEnd(...a);
        }
        bufferedCalls = [];
      };

      try { next(); } catch (err) { restore(); releaseReplay(); return next(err); }
      await endPromise;

      if (res.statusCode >= 400) {
        // Handler failed — never charge the card, buyer keeps their money.
        restore();
        replay();
        releaseReplay();
        return;
      }
      // A gateway cache hit repeats an answer someone already paid for, and is
      // free on every rail: never capture, and release the credential unused.
      if (req.gatewayCacheHit === true) {
        restore();
        replay();
        releaseReplay();
        return;
      }
      // The buyer left before anything could reach them and the request holds
      // a granted forgiveness ticket (src/hangup-settlement.js): do not
      // capture. The credential stays spent, so it cannot buy a second run.
      // Without a ticket the card is captured as usual and the hang-up hook
      // books the undelivered charge as owed; so is a close during the
      // capture itself.
      if (chargeCancelledForClientGone(req)) {
        bufferedCalls = [];
        restore();
        settleReplay();
        console.warn(`[mpp-stripe] client gone before the handler's answer could be sent (${req.method} ${req.path}) - not captured, not charged`);
        try { res.removeHeader("Content-Length"); res.statusCode = 499; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: CLIENT_GONE_TEXT, charged: false })); } catch { /* socket already gone */ }
        return;
      }
      const b = await settle(auth);
      if (!b.ok) {
        console.warn(`[mpp-stripe] settle failed AFTER a successful handler (${req.method} ${req.path}) — buyer answered 402, not charged: ${b.error}`);
        bufferedCalls = [];
        restore();
        sendMppProblem(res, mppProblem("verification-failed", `Payment verification failed: Stripe did not capture the charge (${String(b.reason || "no detail").slice(0, 160)}).`));
        releaseReplay();
        return;
      }
      console.log(`[mpp-stripe] settled ${req.method} ${req.path} pi=${b.receipt?.reference || "?"}`);
      const receiptHeader = stripeReceiptHeader(b.receipt);
      restore();
      if (receiptHeader) res.setHeader("Payment-Receipt", receiptHeader);
      settleReplay();
      req.stripeSettled = true;
      try {
        replay();
      } catch (err) {
        console.error(`[mpp-stripe] CHARGED-BUT-NOT-SERVED: replay threw after settlement (${req.method} ${req.path} pi=${b.receipt?.reference || "?"}): ${String(err?.message || err).slice(0, 300)}`);
        try { if (!res.writableEnded) { if (!res.headersSent) res.status(500); res.end(); } } catch { /* nothing left */ }
      }
    }).catch((err) => {
      console.warn(`[mpp-stripe] gate threw: ${String(err?.message || err).slice(0, 300)}`);
      if (req.stripeSettled || res.headersSent) { try { if (!res.writableEnded) res.end(); } catch { /* ignore */ } return; }
      next();
    });
  };
}
