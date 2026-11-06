// Buy one live /api/bestsellers response and save the JSON — the data feed
// for the announcement demo card (scripts/bestsellers-card.js). The endpoint
// is wallet-only, so this pays for real with the canary burner via x402,
// using the exact client pattern of scripts/paid-canary.js.
//
// The buy is marked INTERNAL traffic (X-Heartbeat-Token, same unspoofable
// HMAC marker the canary sends) so an operational card render never records
// as external demand in the sales ledger it is about to picture. Without
// POW_SECRET the buy still works but records as external — warned loudly.
//
// Env: BURNER_KEY (funded EVM burner, required), POW_SECRET (internal-traffic
// marker, strongly recommended), TARGET_URL (default https://agent402.tools).
//
//   node scripts/capture-bestsellers.js --out response.json [--query "sort=buyers&days=30"]
//
// Exit codes: 0 saved · 2 config/payment/shape failure.
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import { assertOwnPaidTarget, capFromEnv, guardCappedSigning } from "./lib/buyer-guard.js";
import { writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = arg("--out", "bestsellers-response.json");
const QUERY = arg("--query", "sort=buyers&days=30&limit=10");
const TARGET = assertOwnPaidTarget(process.env.TARGET_URL || "https://agent402.tools", "capture-bestsellers");

const pk = (process.env.BURNER_KEY || "").trim();
if (!pk) {
  console.error("capture-bestsellers: BURNER_KEY not set — the endpoint is wallet-only and needs a funded burner");
  process.exit(2);
}

const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
  import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
]);
const account = privateKeyToAccount(pk);
const client = disableVendorSpendControls(new x402Client());
registerExactEvmScheme(client, { signer: account });
// One Base buy of a list-priced route: nothing above CAPTURE_MAX_USD is signed.
guardCappedSigning(client, { maxUsd: capFromEnv("CAPTURE_MAX_USD", 0.01, { script: "capture-bestsellers" }), networks: ["eip155:8453"] });

// Same internal-traffic marker as paid-canary.js: header set on the Request
// object (rebuilding init would drop the X-PAYMENT header on the paid retry).
const secret = (process.env.POW_SECRET || "").trim();
if (!secret) console.warn("WARN  POW_SECRET not set — this buy will record as EXTERNAL demand in the sales ledger");
const synthFetch = !secret ? fetch : (input, init) => {
  const minute = Math.floor(Date.now() / 60_000);
  const token = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
  const req = new Request(input, init);
  req.headers.set("X-Heartbeat-Token", token);
  return fetch(req);
};
const payFetch = wrapFetchWithPayment(synthFetch, client);

try {
  const url = `${TARGET}/api/bestsellers?${QUERY}`;
  const res = await payFetch(url, { method: "GET" });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body || !Array.isArray(body.bestsellers)) {
    console.error(`capture-bestsellers: expected 200 with a bestsellers array, got ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    process.exit(2);
  }
  writeFileSync(OUT, JSON.stringify(body, null, 2));
  console.log(`wrote ${OUT} — ${body.bestsellers.length} rows, window ${body.days}d, sort ${body.sort} (paid by ${account.address})`);
} catch (e) {
  console.error(`capture-bestsellers failed: ${(e?.message || String(e)).slice(0, 300)}`);
  process.exit(2);
}
