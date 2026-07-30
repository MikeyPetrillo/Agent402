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
//   SMOKE_EXPECT  a substring the response JSON must contain (optional extra assert)
//   SMOKE_TARGET  full origin to buy from INSTEAD of production (an external
//                 x402 seller compatibility check, e.g. https://api.utilia.ink).
//                 The internal-traffic marker is suppressed for external
//                 targets - it is OUR ledger convention, not theirs.
//
//   BURNER_KEY=0x… POW_SECRET=… SMOKE_ROUTE=/api/unemployment-rate node scripts/smoke-buy.js
import { readFileSync, existsSync } from "node:fs";
import { createHmac, createHash } from "node:crypto";

const EXTERNAL_TARGET = (process.env.SMOKE_TARGET || "").trim().replace(/\/+$/, "");
const TARGET = EXTERNAL_TARGET || process.env.TARGET_URL || "https://agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const ROUTE = (process.env.SMOKE_ROUTE || "").trim();
const METHOD = (process.env.SMOKE_METHOD || "GET").trim().toUpperCase();
const QUERY = (process.env.SMOKE_QUERY || "").trim();
const BODY = (process.env.SMOKE_BODY || "").trim();
const EXPECT = (process.env.SMOKE_EXPECT || "").trim();
if (!ROUTE) { console.error("smoke-buy: SMOKE_ROUTE is required (e.g. /api/unemployment-rate)"); process.exit(2); }

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
const payFetch = wrapFetchWithPayment(synthFetch, client);

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
const settleHdr = res.headers.get("x-payment-response") || res.headers.get("payment-receipt") || "";
if (settleHdr) {
  try {
    const receipt = JSON.parse(Buffer.from(settleHdr, "base64").toString("utf8"));
    console.log(`  settle: network=${receipt.network || "?"} tx=${receipt.transaction || "?"} payer=${receipt.payer || "?"}`);
  } catch { console.log(`  settle (raw header): ${settleHdr.slice(0, 300)}`); }
}
const reqId = res.headers.get("x-request-id");
if (reqId) console.log(`  x-request-id: ${reqId}`);
console.log(`  bodySha256: sha256:${createHash("sha256").update(text).digest("hex")}`);

const ok200 = res.status === 200 && body && typeof body === "object";
const expectOk = !EXPECT || text.includes(EXPECT);
if (!ok200 || !expectOk) {
  console.error(`SMOKE FAIL: ${ROUTE} did not return a healthy 200 JSON${EXPECT && !expectOk ? ` containing "${EXPECT}"` : ""}.`);
  process.exit(1);
}
console.log(`SMOKE OK: ${ROUTE} returned live data and payment settled.`);
