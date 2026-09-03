// Generic one-shot paid tool smoke test (owner-approved). Buys ONE tool from
// production with real USDC on Base to confirm it works end-to-end (Chromium
// render, a live-data tool like FRED, etc.). Marks the buy as internal traffic
// (X-Heartbeat-Token) so it doesn't pollute the sales ledger.
//
// Configure via env:
//   SMOKE_ROUTE   e.g. /api/unemployment-rate   (required)
//   SMOKE_METHOD  GET | POST                     (default GET)
//   SMOKE_QUERY   querystring for GET, e.g. q=gdp&limit=3   (optional)
//   SMOKE_BODY    JSON string for POST                       (optional)
//   SMOKE_EXPECT  a substring the response JSON must contain (required with SMOKE_TARGET)
//   SMOKE_RECEIPT_OUT  write a complete signed offer receipt to this new file;
//                      fails closed if capture was requested but none is returned
//   SMOKE_TARGET  full origin to buy from INSTEAD of production (an external
//                 x402 seller compatibility check, e.g. https://seller.example).
//                 The internal-traffic marker is suppressed for external
//                 targets - it is OUR ledger convention, not theirs.
//
//   BURNER_KEY=0x… POW_SECRET=… SMOKE_ROUTE=/api/unemployment-rate node scripts/smoke-buy.js
import { readFileSync, existsSync } from "node:fs";
import { createHmac, createHash } from "node:crypto";
import {
  decodeSettlementHeader,
  receiptOutputPath,
  signedOfferReceiptFromSettlement,
  writeSignedOfferReceipt,
} from "./lib/smoke-receipt.js";

const EXTERNAL_TARGET = (process.env.SMOKE_TARGET || "").trim().replace(/\/+$/, "");
const TARGET = EXTERNAL_TARGET || process.env.TARGET_URL || "https://agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const ROUTE = (process.env.SMOKE_ROUTE || "").trim();
const METHOD = (process.env.SMOKE_METHOD || "GET").trim().toUpperCase();
const QUERY = (process.env.SMOKE_QUERY || "").trim();
const BODY = (process.env.SMOKE_BODY || "").trim();
const EXPECT = (process.env.SMOKE_EXPECT || "").trim();
let RECEIPT_OUT = "";
try { RECEIPT_OUT = receiptOutputPath(process.env.SMOKE_RECEIPT_OUT); }
catch (error) { console.error(error.message); process.exit(2); }
// Diagnostic: drop named x402 extensions from the seller's challenge BEFORE the
// client sees it. The @x402 client echoes every extension it is offered back
// into the payment payload verbatim, schemas and all, so one seller's rich 402
// can inflate the payload past what a facilitator will accept - measured
// 2026-08-29 against an external seller: 10,259 payload bytes vs 2,678 for our
// own 402, and CDP answered `'paymentPayload' is invalid`. Stripping isolates
// which extension is responsible. Comma-separated, e.g. "offer-receipt".
const STRIP_EXT = (process.env.SMOKE_STRIP_EXTENSIONS || "").split(",").map((x) => x.trim()).filter(Boolean);
if (!ROUTE) { console.error("smoke-buy: SMOKE_ROUTE is required (e.g. /api/unemployment-rate)"); process.exit(2); }
if (EXTERNAL_TARGET && !EXPECT) { console.error("smoke-buy: SMOKE_EXPECT is required when SMOKE_TARGET selects an external target"); process.exit(2); }

const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
if (!pk) { console.error("smoke-buy: no BURNER_KEY / KEY_FILE — cannot run the paid check"); process.exit(2); }

const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
]);
const account = privateKeyToAccount(pk);
console.log(`buyer: ${account.address}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const secret = EXTERNAL_TARGET ? "" : (process.env.POW_SECRET || "").trim();
if (!secret && !EXTERNAL_TARGET) console.warn("WARN  POW_SECRET not set — this buy records as EXTERNAL demand in the ledger");
const synthFetch = !secret ? fetch : (input, init) => {
  const minute = Math.floor(Date.now() / 60_000);
  const token = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
  const req = new Request(input, init);
  req.headers.set("X-Heartbeat-Token", token);
  return fetch(req);
};
// Wrap once more when stripping: rewrite the 402 (body AND the PAYMENT-REQUIRED
// header, since a client may read either) before the payment layer parses it.
const stripFetch = !STRIP_EXT.length ? synthFetch : async (input, init) => {
  const res = await synthFetch(input, init);
  if (res.status !== 402) return res;
  const text = await res.clone().text();
  let doc; try { doc = JSON.parse(text); } catch { return res; }
  if (!doc?.extensions) return res;
  const before = Object.keys(doc.extensions);
  for (const k of STRIP_EXT) delete doc.extensions[k];
  console.log(`stripped extensions: ${STRIP_EXT.join(",")} (challenge had ${before.join(",")})`);
  const headers = new Headers(res.headers);
  if (headers.get("payment-required")) headers.set("payment-required", Buffer.from(JSON.stringify(doc)).toString("base64"));
  return new Response(JSON.stringify(doc), { status: 402, headers });
};
const payFetch = wrapFetchWithPayment(stripFetch, client);

const url = `${TARGET}${ROUTE}${QUERY ? (ROUTE.includes("?") ? "&" : "?") + QUERY : ""}`;
const init = { method: METHOD, headers: { Accept: "application/json" } };
if (METHOD !== "GET" && METHOD !== "HEAD") { init.headers["Content-Type"] = "application/json"; init.body = BODY || "{}"; }
console.log(`buying ${METHOD} ${url} …`);

const res = await payFetch(url, init);
const text = await res.text();
let body = null; try { body = JSON.parse(text); } catch {}
console.log(`status: ${res.status}`);
// Full response (bounded) — receipts carry fields a partner may need to
// verify a routed buy (callRef, settleTx, result payload for hashing); a
// 220-char preview silently dropped them.
console.log(`  response: ${text.slice(0, 8000).replace(/\s+/g, " ")}`);
// Verification fields for compatibility checks against a counterparty:
// the settle receipt (X-PAYMENT-RESPONSE, base64 JSON with the on-chain tx),
// their request id if they send one, and a sha256 over the exact body bytes.
// v2 name first (PAYMENT-RESPONSE), then the v1 X- name, then the MPP
// mirror - a seller shipping only the v2 header must not read as "no
// receipt" (that blind spot would have re-confirmed a gap a partner fixed).
const settleHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response") || res.headers.get("payment-receipt") || "";
const settlement = decodeSettlementHeader(settleHdr);
const signedOfferReceipt = signedOfferReceiptFromSettlement(settlement);
if (settleHdr) {
  if (settlement) console.log(`  settle: network=${settlement.network || "?"} tx=${settlement.transaction || "?"} payer=${settlement.payer || "?"}`);
  else console.log(`  settle (raw header): ${settleHdr.slice(0, 300)}`);
}
if (RECEIPT_OUT && signedOfferReceipt) {
  writeSignedOfferReceipt(RECEIPT_OUT, signedOfferReceipt);
  console.log("  signed offer receipt: captured");
} else if (RECEIPT_OUT) {
  console.warn("WARN  signed offer receipt: capture requested but the seller returned none");
}
const reqId = res.headers.get("x-request-id");
if (reqId) console.log(`  x-request-id: ${reqId}`);
console.log(`  bodySha256: sha256:${createHash("sha256").update(text).digest("hex")}`);

const ok200 = res.status === 200 && body && typeof body === "object";
const expectOk = !EXPECT || text.includes(EXPECT);
const receiptOk = !RECEIPT_OUT || Boolean(signedOfferReceipt);
if (!ok200 || !expectOk || !receiptOk) {
  const reason = !receiptOk ? " with the requested signed offer receipt" : (EXPECT && !expectOk ? ` containing "${EXPECT}"` : "");
  console.error(`SMOKE FAIL: ${ROUTE} did not return a healthy 200 JSON${reason}.`);
  process.exit(1);
}
console.log(`SMOKE OK: ${ROUTE} returned live data and payment settled.`);
