// The metered-settlement pricing rule.
import { meteredUsd, METER_MARKUP, METER_FLOOR_USD, METER_MIN_SETTLE_USD, isMeterable, applyMeteredSettlement } from "../src/gateway-meter.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// The measured reality this exists to fix: v1-chat charges $0.02 against
// $0.0001 of real spend, i.e. 170x. Metered, the same call bills whichever
// floor is higher - ours, or the one the rail will actually accept.
const smallFloor = Math.max(METER_FLOOR_USD, METER_MIN_SETTLE_USD);
const chat = meteredUsd({ upstreamUsd: 0.0001, ceilingUsd: 0.02 });
ok(chat === smallFloor, `a typical v1-chat call ($0.0001 upstream) bills $${chat} instead of the $0.02 flat price`);
ok(chat < 0.02, "which is still cheaper for the buyer than the flat tier");

// HOW MUCH CHEAPER IS SET BY THE FACILITATOR, NOT BY US, and the honest number
// moves when METER_MIN_SETTLE_USD does. At a $0.01 rail floor a $0.02 call is
// 2x cheaper, not the 17x the markup alone would give - CDP refused $0.00115 as
// amount_too_low, and a refused settle pays us NOTHING while we have already
// done the work. Anyone quoting a multiple on a page must read it from here.
ok(chat >= METER_MIN_SETTLE_USD, "a metered amount is never below what the facilitator will settle");

// A tier whose whole price is under the rail's floor cannot be metered at all:
// every nameable amount is either over what the buyer authorized or under what
// the rail accepts. It settles at its ceiling, exactly as before metering.
ok(meteredUsd({ upstreamUsd: 0.0001, ceilingUsd: METER_MIN_SETTLE_USD / 2 }) === null,
  "a ceiling below the facilitator floor is not metered at all - it settles at the ceiling");

// The FLOOR dominates small calls, and that is worth stating rather than
// hiding: below the breakeven the bill is the fixed per-request component, not
// the markup. So a tiny call is still several times what a direct API caller
// pays. Any claim of "cheaper than calling the API yourself" is false and this
// is the arithmetic that makes it false.
const breakeven = smallFloor / METER_MARKUP;
ok(meteredUsd({ upstreamUsd: breakeven * 0.5, ceilingUsd: 0.1 }) === smallFloor,
  `below the $${breakeven.toFixed(6)} breakeven the bill is the flat floor, not the markup`);
ok(meteredUsd({ upstreamUsd: breakeven * 2, ceilingUsd: 0.1 }) > smallFloor,
  "above it the markup governs");

// A real, large call bills its cost plus the markup, still under the ceiling.
const big = meteredUsd({ upstreamUsd: 0.012, ceilingUsd: 0.02 });
ok(Math.abs(big - 0.012 * METER_MARKUP) < 1e-6, `a large call ($0.012 upstream) bills $${big}, cost plus ${Math.round((METER_MARKUP - 1) * 100)}%`);
ok(big < 0.02, "and still lands under the ceiling the buyer authorized");

// THE INVARIANT THAT MAKES THE CAP UNREACHABLE: the margin clamp already holds
// upstream at or under 70% of the tier price, so metered <= 0.91 x ceiling.
for (const ceiling of [0.003, 0.01, 0.02, 0.10, 0.50]) {
  const worst = meteredUsd({ upstreamUsd: ceiling * 0.7, ceilingUsd: ceiling });
  // Tiers at or under the rail's floor are declined outright (null), which is
  // the honest answer: they settle at their ceiling as they always did. The
  // invariant is about tiers we DO meter.
  if (worst === null) {
    ok(METER_MIN_SETTLE_USD >= ceiling, `$${ceiling} is not metered because the facilitator floor ($${METER_MIN_SETTLE_USD}) is not below it`);
    continue;
  }
  ok(worst < ceiling, `at the margin clamp's own bound (70% of $${ceiling}), the metered amount $${worst} is still under the ceiling, so the cap never binds`);
}

// It must still be capped, because "should never bind" is not a reason to omit
// a check on something that moves money.
const over = meteredUsd({ upstreamUsd: 5, ceilingUsd: 0.02 });
ok(over === 0.02, "an upstream cost beyond the ceiling settles AT the ceiling, never above what the buyer authorized");

// An unknown cost must never become a cheap settle.
// null is the one that mattered: Number(null) is 0, so a coercion-based guard
// reads a MISSING cost as a free call and bills the floor.
for (const [label, bad] of [["null", null], ["undefined", undefined], ["NaN", NaN], ["a string", "abc"], ["negative", -1], ["a numeric string", "0.001"]]) {
  ok(meteredUsd({ upstreamUsd: bad, ceilingUsd: 0.02 }) === null,
    `an unreported/invalid upstream cost (${label}) returns null so the caller keeps the ceiling, rather than silently underbilling`);
}
for (const bad of [0, -1, null, NaN]) {
  ok(meteredUsd({ upstreamUsd: 0.001, ceilingUsd: bad }) === null, `a missing ceiling (${JSON.stringify(bad)}) is not meterable`);
}

// A free call still bills the floor: a request costs us something before any
// model runs, and a $0 settle is not a payment.
ok(meteredUsd({ upstreamUsd: 0, ceilingUsd: 0.02 }) === smallFloor, "a zero-cost call still bills the floor, never $0");

// Rounding favours the seller, so a rounding error can never underbill.
const r = meteredUsd({ upstreamUsd: 0.0010001, ceilingUsd: 0.02 });
ok(r >= 0.0010001 * METER_MARKUP && Number.isInteger(Math.round(r * 1e6)),
  `settles in whole atomic units, rounded UP ($${r}), so rounding can only favour the seller`);

// Only an `upto` payment may be metered.
//
// These build a REQUEST, not a scheme. The previous version passed
// `{ x402: { scheme: "upto" } }` - a shape nothing ever produces - so it proved
// the comparison while the derivation was missing entirely, and the metered path
// was dead in production with both tests green. The input here is what an
// express request actually carries: a base64 payment header, read through the
// same `header()` accessor the middleware uses.
const reqWith = (headers) => ({ header: (n) => headers[String(n).toLowerCase()] ?? undefined });
const paymentHeader = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64");
// BOTH wire versions, because they carry the scheme in DIFFERENT places and a
// v1-only reader returns null for every v2 payment - silently, since the caller
// reads null as "not this scheme". That is exactly what shipped: the first fix
// read only the top-level field, the live buy settled at the full ceiling again,
// and nothing logged. @x402/core's own schemas:
//   v1 { x402Version, scheme, network, payload }
//   v2 { x402Version, resource?, accepted: PaymentRequirementsV2, payload }
const v2Payload = (scheme) => ({
  x402Version: 2,
  accepted: { scheme, network: "eip155:8453", amount: "20000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0xabc", maxTimeoutSeconds: 60 },
  payload: { signature: "0xdead", authorization: {} },
});
const v1Payload = (scheme) => ({ x402Version: 1, scheme, network: "base", payload: { signature: "0xdead", authorization: {} } });
const uptoPayload = v2Payload("upto");
const exactPayload = v2Payload("exact");

ok(isMeterable(reqWith({ "payment-signature": paymentHeader(uptoPayload) })) === true,
  "an upto payment is meterable, read from the payment header the middleware settles from");
ok(isMeterable(reqWith({ "x-payment": paymentHeader(uptoPayload) })) === true,
  "the x-payment fallback header is read too, since the middleware falls back to it");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(exactPayload) })) === false,
  "an EXACT payment is never metered: that scheme fixed the amount at the 402 and cannot express a lower settle");
ok(isMeterable(reqWith({})) === false && isMeterable({}) === false && isMeterable(null) === false,
  "no payment header means no metering");
ok(isMeterable(reqWith({ "payment-signature": "not base64 json" })) === false,
  "an unparseable payment header is not meterable: it must never DEFAULT to metered");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader({ x402Version: 2, network: "eip155:8453" }) })) === false,
  "a payload with no scheme at all is not meterable");
// v1 wire: the scheme is top-level. Dropping this reader would strand v1 buyers.
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(v1Payload("upto")) })) === true,
  "a v1 payload carries the scheme TOP-LEVEL and is still read");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(v1Payload("exact")) })) === false,
  "a v1 exact payment is not metered either");
// v2 wire: the scheme is on `accepted`. This is the one the live buy proved.
ok(isMeterable(reqWith({ "payment-signature": paymentHeader(v2Payload("upto")) })) === true,
  "a v2 payload carries the scheme on `accepted` (NO top-level scheme) and is read there");
ok(isMeterable(reqWith({ "payment-signature": paymentHeader({ x402Version: 2, accepted: { network: "eip155:8453" }, payload: {} }) })) === false,
  "a v2 payload whose accepted names no scheme is not meterable");
// The shape the dead version believed in must not resurrect it.
ok(isMeterable({ x402: { scheme: "upto" } }) === false && isMeterable({ _x402Scheme: "upto" }) === false,
  "a decorated request property is NOT the source of truth: nothing sets those, and trusting them is what made this dead");

// --- applyMeteredSettlement: the block that reached production twice broken ---
//
// It lived inline in server.js's route loop where nothing could execute it, and
// shipped (1) unable to run at all, then (2) throwing ReferenceError the moment
// it did - with a catch that named the same undefined identifier, so the
// fail-safe raised the error it existed to absorb and a 500 reached the buyer.
// These call it for real.
{
  const uptoReq = reqWith({ "payment-signature": paymentHeader(v2Payload("upto")) });
  const exactReq = reqWith({ "payment-signature": paymentHeader(v2Payload("exact")) });
  const mkRes = () => {
    const headers = {}; 
    return { headersSent: false, headers, setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
  };
  const tool = { slug: "v1-chat", price: "$0.02" };  // ceiling above the rail floor, so it IS meterable
  const mk = (cost) => ({ ok: true, __meterUpstreamUsd: cost });

  // The happy path, end to end: upstream $0.001 -> $0.00115 at 15%.
  let overrides = null; let res = mkRes();
  // Upstream large enough that the markup, not a floor, governs - so this
  // asserts the arithmetic rather than whichever floor happens to be highest.
  const bigUp = Math.max(0.001, METER_MIN_SETTLE_USD);           // > every floor
  const expect = Math.ceil(bigUp * METER_MARKUP * 1e6 - 1e-9) / 1e6;
  let amt = applyMeteredSettlement({ result: mk(bigUp), req: uptoReq, tool: { slug: "v1-chat-pro", price: "$0.10" }, res, enabled: true, setOverrides: (r, o) => { overrides = o; } });
  ok(amt === expect, `meters an upto call at upstream + markup (got ${amt}, expected ${expect})`);
  ok(overrides && overrides.amount === `$${expect.toFixed(6)}`, "sets the settlement override to the metered amount");
  ok(res.headers["x-metered-usd"] === expect.toFixed(6), "reports the metered amount on the response header");

  // The sentinel NEVER reaches a buyer, on any path.
  const r1 = mk(0.001);
  applyMeteredSettlement({ result: r1, req: uptoReq, tool, res: mkRes(), enabled: true, setOverrides: () => {} });
  ok(!("__meterUpstreamUsd" in r1), "strips the internal cost sentinel when it meters");
  const r2 = mk(0.001);
  applyMeteredSettlement({ result: r2, req: exactReq, tool, res: mkRes(), enabled: true, setOverrides: () => {} });
  ok(!("__meterUpstreamUsd" in r2), "strips the sentinel even when it does NOT meter - a buyer must never see our upstream cost");
  // CREDITS: a prepaid-credits request (no x402 payment header, req.creditsSettled)
  // is metered too - header set for the credits gate, NO settlement override
  // (nothing is settling it over x402).
  {
    let o = null; const rc = mkRes();
    const amtC = applyMeteredSettlement({ result: mk(bigUp), req: { headers: {}, creditsSettled: true, __meteredQuoteUsd: 0.10 }, tool: { slug: "v1-chat-metered", price: "$0.001" }, res: rc, enabled: true, setOverrides: (r, x) => { o = x; } });
    ok(amtC === expect && rc.headers["x-metered-usd"] === expect.toFixed(6) && o === null, `credits request is metered (${amtC}) with the header set and no x402 override`);
  }
  const r3 = mk(0.001);
  applyMeteredSettlement({ result: r3, req: uptoReq, tool, res: mkRes(), enabled: false, setOverrides: () => {} });
  ok(!("__meterUpstreamUsd" in r3), "strips the sentinel even when metering is switched off");

  // Every refusal path leaves the ceiling standing.
  const noOverride = (opts) => { let o = null; applyMeteredSettlement({ ...opts, setOverrides: (r, x) => { o = x; } }); return o; };
  ok(noOverride({ result: mk(0.001), req: exactReq, tool, res: mkRes(), enabled: true }) === null,
    "an exact payment is never metered");
  ok(noOverride({ result: mk(0.001), req: uptoReq, tool, res: mkRes(), enabled: false }) === null,
    "the switch off means no override, so the buyer settles at the ceiling");
  ok(noOverride({ result: mk(0.001), req: uptoReq, tool, res: { ...mkRes(), headersSent: true } }) === null,
    "headers already sent means no override - a late header write is silently lost");
  ok(noOverride({ result: { ok: true }, req: uptoReq, tool, res: mkRes(), enabled: true }) === null,
    "no reported cost means no metering");
  ok(noOverride({ result: mk(0.001), req: uptoReq, tool: { slug: "x", price: undefined }, res: mkRes(), enabled: true }) === null,
    "a tool with no price cannot be metered");

  // THE 500. A throw inside must be absorbed, and the absorbing path must not
  // itself throw - which is exactly how a ReferenceError became a buyer's 500.
  let logged = null;
  const boom = { headersSent: false, setHeader: () => { throw new Error("header exploded"); } };
  let threw = null;
  try {
    amt = applyMeteredSettlement({ result: mk(0.001), req: uptoReq, tool, res: boom, enabled: true, setOverrides: () => {}, log: (m) => { logged = m; } });
  } catch (e) { threw = e; }
  ok(threw === null, "a throw inside NEVER escapes to the caller - that is what turned a metering bug into a 500 for the buyer");
  ok(amt === null, "a throw means no metered amount, so the buyer settles at the ceiling");
  ok(logged && logged.includes("v1-chat") && logged.includes("settling at the ceiling"),
    "the failure is logged with the tool slug, read BEFORE the try so the catch cannot fail on it");

  // The catch must survive a tool object that is missing entirely.
  threw = null;
  try { applyMeteredSettlement({ result: mk(0.001), req: uptoReq, tool: undefined, res: boom, enabled: true, setOverrides: () => {}, log: () => {} }); }
  catch (e) { threw = e; }
  ok(threw === null, "no tool object at all still cannot throw out of the metering path");
}


// ---- setMeterSentinel: the sentinel is NON-enumerable (never serializes, even nested) ----
{
  const { setMeterSentinel } = await import("../src/gateway-meter.js");
  const data = setMeterSentinel({ choices: [] }, 0.0042);
  ok(data.__meterUpstreamUsd === 0.0042 && !Object.keys(data).includes("__meterUpstreamUsd") && !JSON.stringify({ nested: data }).includes("__meterUpstreamUsd"), "setMeterSentinel: readable by the binder, invisible to JSON.stringify and Object.keys (nested too)");
  ok(setMeterSentinel({ a: 1 }, "0.1").__meterUpstreamUsd === undefined && setMeterSentinel(null, 0.1) === null, "setMeterSentinel: refuses a non-number cost and a non-object result");
  const overrides = [];
  const req = { ...reqWith({ "payment-signature": paymentHeader(uptoPayload) }), __meteredQuoteUsd: 0.058011 };
  const amount = applyMeteredSettlement({ result: data, req, tool: { slug: "v1-chat-metered", price: "$0.001" }, res: { headersSent: false, setHeader() {} }, enabled: true, setOverrides: (_r, o) => overrides.push(o) });
  ok(typeof amount === "number" && amount > 0.0042 && amount < 0.0049 && !("__meterUpstreamUsd" in data) && overrides.length === 1, `applyMeteredSettlement reads the non-enumerable sentinel, meters ($${amount}), and deletes it`);
}

// ---- metered tier: the ceiling is the per-request quote, not the catalog floor ----
{
  const overrides = [];
  const res = { headersSent: false, setHeader() {} };
  const result = { __meterUpstreamUsd: 0.02 };
  const req = { ...reqWith({ "payment-signature": paymentHeader(uptoPayload) }), __meteredQuoteUsd: 0.058011 };
  const amount = applyMeteredSettlement({ result, req, tool: { slug: "v1-chat-metered", price: "$0.001" }, res, enabled: true, setOverrides: (_r, o) => overrides.push(o) });
  ok(amount === Math.max(METER_FLOOR_USD, METER_MIN_SETTLE_USD, 0.02 * METER_MARKUP), `metered tier: settles actual x markup ($${amount}) under the QUOTED ceiling, not refused by the $0.001 catalog floor`);
  ok(overrides.length === 1, "an override was set");
}

console.log(`\n${pass} passed, 0 failed`);
