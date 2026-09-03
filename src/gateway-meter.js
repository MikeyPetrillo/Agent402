import { paymentSchemeOf } from "./payer.js";

// METERED SETTLEMENT for the LLM gateway: bill what a call actually cost,
// not the flat tier price.
//
// WHY. The gateway prices in flat tiers because `exact` fixes the amount in the
// 402 before the handler runs. Measured over 30 days of `gateway_usage`, that
// makes us 170x to 2,162x the upstream cost on the chat tiers: v1-chat charges
// $0.02 against $0.0001 of real spend, v1-chat-pro $0.10 against ~$0.00005. An
// agent that can hold an API key has no reason to route through that, and the
// flat price is bad at BOTH ends - small calls are wildly overpriced, and large
// ones hit the margin clamp, which shrinks max_tokens and hands the buyer a
// truncated answer to defend our margin.
//
// The `upto` scheme fixes the shape: the buyer authorizes a CEILING and the
// seller names the settled amount afterwards, never above it. So the tier price
// becomes a guaranteed maximum and the bill becomes the meter.
//
// THE MARKUP IS THE PRODUCT, and it is deliberately thin: 15%, which is the
// margin the operator asked for. Be honest about what that does and does not
// buy. It is cheaper than a subscription for anyone under the monthly
// break-even. It is NOT cheaper than an agent calling OpenRouter with its own
// key - that agent pays upstream and we pay upstream plus 15%. Anyone claiming
// otherwise on a served page is making a claim the numbers do not support.
//
// HOW MUCH CHEAPER THAN THE FLAT TIER IS NOT OURS TO DECIDE. This once said
// "roughly 40x cheaper", which was the markup arithmetic alone and true only in
// a world with no floor. The binding constraint is METER_MIN_SETTLE_USD below:
// the facilitator refuses to settle small amounts, so the real multiple is
// ceiling / max(floor, upstream x markup), per tier. At the measured $0.001
// floor a small call on the $0.02 base tier is 20x cheaper and on the $0.10 pro
// tier 100x; nano at $0.003 is 3x; auto at $0.01 is 10x. Read any multiple
// quoted publicly off these constants at the current floor, and re-read it when
// the floor moves.
//
// What the buyer gets for the 15% is access without credentials and a hard
// per-call ceiling (see below), not a lower token price.
export const METER_MARKUP = 1.15;
// Every request costs us something no percentage of a $0.000003 call can cover
// (the paywall, the settle, egress). This floor is what a request is worth
// before any model runs.
//
// It is set by judgement, not measurement - we have never measured a per-request
// fixed cost - so it is deliberately small enough that it stops mattering above
// about a tenth of a cent of model spend, and large enough not to be dust a
// facilitator would rather not move. If we ever measure the real number, move
// this to it rather than defending the guess.
export const METER_FLOOR_USD = 0.0002;

// THE FACILITATOR HAS ITS OWN FLOOR, AND IT IS NOT OURS TO CHOOSE.
//
// MEASURED, by settling real money on Base against CDP, 2026-08-23:
//
//     200 atomic  ($0.0002)   refused, amount_too_low
//     500 atomic  ($0.0005)   refused, amount_too_low
//     750 atomic  ($0.00075)  refused, amount_too_low
//   1,000 atomic  ($0.001)    SETTLED
//   1,150 / 1,250 / 1,500 / 2,000 / 2,500 / 5,000 / 10,000  all SETTLED
//
// So the floor is in (750, 1000] and $0.001 is proven good - the same minimum
// our `exact` routes have always settled at, which is the likely explanation:
// it is a facilitator-wide minimum, not something upto-specific.
//
// Neither CDP's facilitator documentation nor the upto spec states any minimum
// - the spec explicitly allows a settled amount of 0 - so this is undocumented
// behaviour that only a real settle reveals.
//
// A correction, because it was briefly recorded as fact: the first failure was
// reported here (and in a commit message) as a refusal of 1,150 atomic units.
// It was not. That run proposed 200 - the old METER_FLOOR_USD - and 1,150 was a
// number I derived from the markup rather than read from the wire. 1,150 in
// fact settles. The lesson is the one this file keeps relearning: a figure that
// was computed is not a figure that was observed.
//
// WHY THIS MATTERS MORE THAN THE MARKUP. A refused settle is not a smaller
// payment, it is NO payment: @x402/express turns it into a 402, the buyer is
// charged nothing, and we have already done the work and paid upstream. So
// proposing an amount below the facilitator's floor is strictly worse than
// proposing the ceiling. METER_FLOOR_USD (above) is about what a request is
// worth to us; this is about what the rail will actually accept.
//
// Set to the lowest amount PROVEN to settle, not to the lowest that might.
// The error is asymmetric - too high costs a buyer a fraction of a cent, too
// low costs us the entire call - so the default is the measured pass, and the
// unproven gap below it (751..999) is left alone. Lower it only with evidence
// from a live settle, never to make a number look better.
export const METER_MIN_SETTLE_USD = Number(process.env.GATEWAY_METER_MIN_SETTLE_USD || 0.001);

/**
 * What to settle for a metered call.
 *
 * @param {object} p
 * @param {number} p.upstreamUsd  what the call actually cost us upstream
 * @param {number} p.ceilingUsd   the tier price the buyer authorized
 * @returns {number|null} USD to settle, or null when it cannot be metered
 *                        (unknown cost, or nothing to bill against)
 */
export function meteredUsd({ upstreamUsd, ceilingUsd }) {
  const ceiling = Number(ceilingUsd);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  // An unreported cost must NEVER silently become a cheap settle: without a
  // number we cannot meter, so the caller keeps the ceiling it already quoted.
  //
  // The type check is the load-bearing part. `Number(null)` is 0, which is
  // finite and non-negative, so a coercion-based guard reads a MISSING cost as
  // a free call and bills the floor - underbilling ourselves on precisely the
  // calls where we do not know what we spent.
  if (typeof upstreamUsd !== "number" || !Number.isFinite(upstreamUsd) || upstreamUsd < 0) return null;
  const up = upstreamUsd;
  // Our floor (what a request is worth) and the rail's floor (what it will
  // accept) are different things and both apply.
  const metered = Math.max(METER_FLOOR_USD, METER_MIN_SETTLE_USD, up * METER_MARKUP);
  // Never above what the buyer authorized. The margin clamp already holds
  // upstream at or under 70% of the tier price, so metered <= 0.91 x ceiling
  // and this cap should never bind - it is here because "should never" is not
  // an argument to skip the check on something that moves money.
  // A ceiling AT OR BELOW the facilitator's floor cannot be metered: every
  // amount we could name is either above what the buyer authorized or below
  // what the rail accepts. Decline, and the buyer settles at the ceiling - the
  // one outcome that is certain to work. Silently clamping to the ceiling here
  // would be the same number but a worse story, since "metered" would then mean
  // "charged the maximum" on those tiers.
  //
  // The comparison is >=, not >, so that METERING ALWAYS MEANS STRICTLY LESS
  // THAN THE CEILING. At equality the settle would land exactly on the
  // authorized maximum, which buys the buyer nothing and would fail the live
  // canary's one real assertion - that the amount which moved is less than the
  // amount authorized. A feature that reports success while charging the
  // maximum is the thing that assertion exists to catch.
  if (METER_MIN_SETTLE_USD >= ceiling) return null;
  const capped = Math.min(metered, ceiling);
  // Settle in whole atomic units of a 6-decimal stablecoin, rounding UP so a
  // rounding error can only favour the seller.
  //
  // The epsilon is not cosmetic: 0.012 * 1.3 is 0.015600000000000001 in binary
  // floating point, and a bare ceil() turns that into 15,601 units - a whole
  // extra atomic unit of overbilling on any call whose product lands just above
  // an exact unit, which is most of them.
  return Math.ceil(capped * 1e6 - 1e-9) / 1e6;
}

/** True when this request may be metered: it paid over `upto`, so the amount is
 *  ours to name. An `exact` payment fixed the amount at the 402 and overriding
 *  it is not something the scheme can express.
 *
 *  THE SCHEME MUST BE DERIVED FROM THE PAYMENT ITSELF. The first version read
 *  `req.x402?.scheme || req._x402Scheme`, and NOTHING sets either: @x402/express
 *  does not decorate the request, and no code of ours ever assigned
 *  `_x402Scheme`. So this returned false for every request ever made and the
 *  whole metered path was dead - a live buy settled at the full ceiling with
 *  GATEWAY_METERED_BILLING=on and no warning anywhere, because a skipped branch
 *  logs nothing.
 *
 *  Both tests passed throughout: the unit test handed it `{x402:{scheme:"upto"}}`,
 *  which is precisely the shape the caller has to derive and never did, and the
 *  wiring test only grepped server.js for the call. A test that supplies the
 *  input under test proves the function, never the caller - so the test below
 *  now builds a real request carrying a real encoded payment header. */
export function isMeterable(req) {
  // A prepaid-credits call is ours to name too: the credits gate HOLDS the
  // quote and settles what this meter reports (2026-08-26; before this a card
  // buyer on the metered route paid the worst-case quote, not usage).
  return paymentSchemeOf(req) === "upto" || req?.creditsSettled === true;
}

/**
 * Apply metered settlement to a response, or leave it settling at the ceiling.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE BLOCK. It used to be twelve lines
 * inside server.js's route-binding loop, where no test could execute it, and it
 * shipped two defects that CI could not see:
 *
 *   1. it could never run at all (isMeterable read a request property nothing
 *      sets), and a skipped branch logs nothing, so two live buys settled at
 *      the full ceiling with no signal anywhere; then
 *   2. the moment it DID run it threw ReferenceError - it named `def` for the
 *      tool, which does not exist in that scope, and the catch named `def` too,
 *      so the fail-safe raised the same error it existed to absorb and a 500
 *      reached the buyer.
 *
 * Both are the kind of thing one real call finds instantly and no amount of
 * source-grepping finds at all. So the logic lives here, where a test can call
 * it with a fake request, tool and response.
 *
 * Everything is injected (`enabled`, `setOverrides`) rather than imported so
 * this stays a pure decision with no module-load side effects.
 *
 * FAILS SAFE IN EVERY DIRECTION. Not an upto payment, no reported cost,
 * metering off, headers already sent, or anything thrown: no override is set
 * and the buyer settles at the ceiling they authorized. The sentinel is ALWAYS
 * stripped first, so an internal cost figure can never reach a buyer even on
 * the paths that decline to meter.
 *
 * @returns {number|null} the metered USD amount, or null when not metered.
 */
/** Put the upstream cost on a result for the route binder WITHOUT making it
 *  serializable: non-enumerable, so `res.json` / `JSON.stringify` never emit
 *  it - including when an in-process caller (route-execute, a skill pack, the
 *  MCP loopback) nests the object inside its own response, which is where the
 *  enumerable form leaked our exact OpenRouter bill (review 2026-08-27). Still
 *  configurable, so applyMeteredSettlement's delete works unchanged. */
export function setMeterSentinel(result, upstreamUsd) {
  if (!result || typeof result !== "object" || typeof upstreamUsd !== "number") return result;
  Object.defineProperty(result, "__meterUpstreamUsd", { value: upstreamUsd, enumerable: false, configurable: true, writable: true });
  return result;
}

export function applyMeteredSettlement({ result, req, tool, res, enabled, setOverrides, log = console.warn }) {
  if (!result || typeof result !== "object" || typeof result.__meterUpstreamUsd === "undefined") return null;
  const upstream = result.__meterUpstreamUsd;
  delete result.__meterUpstreamUsd; // strip before anything else can fail
  // Read once, into a local the catch cannot throw on. A recovery path that can
  // raise the error it is recovering from is not a recovery path.
  const slug = tool?.slug;
  try {
    if (!enabled || !isMeterable(req)) return null;
    // Metered tier: the ceiling the buyer authorized is the per-request quote
    // (stashed by payments.js when the 402 price was resolved), not the
    // catalog floor. Flat tiers keep the tier price.
    const quoted = Number(req?.__meteredQuoteUsd);
    const ceilingUsd = Number.isFinite(quoted) && quoted > 0 ? quoted : Number(String(tool?.price ?? "").replace(/[^0-9.]/g, ""));
    const amount = meteredUsd({ upstreamUsd: upstream, ceilingUsd });
    if (amount == null || res?.headersSent) return null;
    // Credits: no x402 middleware is settling this response, so no settlement
    // override; the credits gate reads X-Metered-Usd on finish and debits it.
    if (req?.creditsSettled !== true) setOverrides(res, { amount: `$${amount.toFixed(6)}` });
    res.setHeader("X-Metered-Usd", amount.toFixed(6));
    return amount;
  } catch (e) {
    log(`[meter] ${slug}: not metered (${String(e?.message || e).slice(0, 120)}) - settling at the ceiling`);
    return null;
  }
}
