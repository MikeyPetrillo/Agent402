// Ground-truth tracer for the Base/CDP settlement failure. Monkeypatches the
// @x402 resource-server + facilitator-client methods on their prototypes, THEN
// boots the real src/server.js. Every gate a paid request passes through prints
// exactly what it decided and why, so a buy driven against this server reveals
// the precise point of failure instead of another theory:
//
//   [TRACE challenge]      — encoded PAYMENT-REQUIRED header byte size (tests the
//                            "multi-chain challenge too big for the buyer" theory)
//   [TRACE match]          — findMatchingRequirements: matched vs NULL (+ the
//                            server requirement vs the client's echoed accepted)
//   [TRACE ext]            — validateExtensions: valid vs extension_echo_mismatch
//                            (+ advertised vs echoed extension info)
//   [TRACE verify]         — verifyPayment: called? result / thrown reason
//   [TRACE cdp.verify]     — raw facilitator verify request/response
//   [TRACE settle]         — settlePayment / cdp.settle result or throw
//
// If [TRACE verify] never prints during a buy, the buyer never sent a payment —
// the failure is client-side negotiation (challenge size / malformed), not CDP.
//
//   CDP_API_KEY_ID=.. CDP_API_KEY_SECRET=.. WALLET_ADDRESS=.. \
//   PAYMENT_NETWORKS=base,solana,polygon,arbitrum NETWORK=base \
//   PORT=3777 node scripts/cdp-trace-server.js
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";

const short = (v, n = 600) => {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s && s.length > n ? s.slice(0, n) + "…" : s;
};

// --- resource-server gates (all run per paid request) ---
const RS = x402ResourceServer.prototype;

const origCreate = RS.createPaymentRequiredResponse;
RS.createPaymentRequiredResponse = async function (requirements, resourceInfo, error, extensions, tc, pp) {
  const res = await origCreate.call(this, requirements, resourceInfo, error, extensions, tc, pp);
  try {
    const encoded = Buffer.from(JSON.stringify(res), "utf8").toString("base64");
    // Only log the "fresh challenge" (no incoming payment) to avoid noise on retries.
    if (!pp) {
      console.log(`[TRACE challenge] ${resourceInfo?.url || "?"} accepts=${res.accepts?.length} extKeys=${short(Object.keys(res.extensions || {}))} headerB64Bytes=${encoded.length} error=${short(error, 80)}`);
    }
  } catch {}
  return res;
};

const origMatch = RS.findMatchingRequirements;
RS.findMatchingRequirements = function (available, pp) {
  const r = origMatch.call(this, available, pp);
  if (!r) {
    console.log(`[TRACE match] NULL — no requirement matched the payload`);
    console.log(`[TRACE match]   client.accepted=${short(pp?.accepted)}`);
    console.log(`[TRACE match]   server.available=${short(available)}`);
  } else {
    console.log(`[TRACE match] matched ${r.network} ${r.scheme}`);
  }
  return r;
};

const origValExt = RS.validateExtensions;
RS.validateExtensions = function (paymentRequired, pp) {
  const r = origValExt.call(this, paymentRequired, pp);
  if (!r || r.valid === false) {
    console.log(`[TRACE ext] INVALID ${short(r)}`);
    console.log(`[TRACE ext]   server.extensions=${short(paymentRequired?.extensions)}`);
    console.log(`[TRACE ext]   client.extensions=${short(pp?.extensions)}`);
  } else {
    console.log(`[TRACE ext] valid`);
  }
  return r;
};

const origVerify = RS.verifyPayment;
RS.verifyPayment = async function (pp, req, de, tc) {
  console.log(`[TRACE verify] CALLED for ${req?.network} ${req?.scheme}`);
  try {
    const r = await origVerify.call(this, pp, req, de, tc);
    console.log(`[TRACE verify] result=${short(r)}`);
    return r;
  } catch (e) {
    console.log(`[TRACE verify] THREW ${e?.constructor?.name} | ${e?.message}`);
    throw e;
  }
};

const origSettle = RS.settlePayment;
RS.settlePayment = async function (pp, req, de, tc, ov) {
  console.log(`[TRACE settle] CALLED for ${req?.network} ${req?.scheme}`);
  try {
    const r = await origSettle.call(this, pp, req, de, tc, ov);
    console.log(`[TRACE settle] result=${short(r)}`);
    return r;
  } catch (e) {
    console.log(`[TRACE settle] THREW ${e?.constructor?.name} | ${e?.message}`);
    throw e;
  }
};

// --- raw facilitator client (what actually goes to CDP over the wire) ---
const FC = HTTPFacilitatorClient.prototype;

const origFcVerify = FC.verify;
FC.verify = async function (pp, req) {
  try {
    const r = await origFcVerify.call(this, pp, req);
    console.log(`[TRACE cdp.verify] ${this?.config?.url || this?.url || "?"} -> ${short(r)}`);
    return r;
  } catch (e) {
    console.log(`[TRACE cdp.verify] THREW ${e?.constructor?.name} | ${e?.message} | body=${short(e?.responseBody || e?.body)}`);
    throw e;
  }
};

const origFcSettle = FC.settle;
FC.settle = async function (pp, req) {
  try {
    const r = await origFcSettle.call(this, pp, req);
    console.log(`[TRACE cdp.settle] ${this?.config?.url || this?.url || "?"} -> ${short(r)}`);
    return r;
  } catch (e) {
    console.log(`[TRACE cdp.settle] THREW ${e?.constructor?.name} | ${e?.message} | body=${short(e?.responseBody || e?.body)}`);
    throw e;
  }
};

console.log("[TRACE] prototypes patched — booting real src/server.js …");
await import("../src/server.js");
