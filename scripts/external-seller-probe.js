#!/usr/bin/env node
// Pay ONE outside x402 seller endpoint once with the CI burner and print what
// came back: status, the settle receipt, and the body. Built 2026-09-03 for the
// outreach kit (the seller's OpenAPI documents inputs but not outputs, and
// "request contracts runtimeVerified:false" was the research's own caveat):
// before a kit relays a seller's response, one real paid call shows its shape.
// Dispatch-only (.github/workflows/spend.yml, job external-seller-probe); never in CI.
//
//   BURNER_KEY=0x... PROBE_URL=https://seller/route PROBE_METHOD=POST \
//   PROBE_BODY='{"...":"..."}' PROBE_HEADERS='{"Idempotency-Key":"..."}' PROBE_MAX_USD=0.01 node scripts/external-seller-probe.js
// Runs OUT OF TREE (copied to a temp dir by its workflow), so no import from src/:
// the vendor client default since @x402/core 2.23 is a $1 pegged-assets cap and
// this script bounds spend itself; the same line src/x402-spend-controls.js wraps.
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const pk = (process.env.BURNER_KEY || "").trim();
const url = String(process.env.PROBE_URL || "").trim();
const method = String(process.env.PROBE_METHOD || "POST").toUpperCase();
const maxUsd = Number(process.env.PROBE_MAX_USD || 0.01);
if (!pk || !/^https:\/\//.test(url)) { console.error("need BURNER_KEY and an https PROBE_URL"); process.exit(2); }
if (!(Number.isFinite(maxUsd) && maxUsd > 0)) { console.error(`PROBE_MAX_USD must be a positive number, got ${JSON.stringify(process.env.PROBE_MAX_USD)}; not paying`); process.exit(2); }
const maxAtomic = BigInt(Math.round(maxUsd * 1e6));
let body;
if (process.env.PROBE_BODY) { try { body = JSON.parse(process.env.PROBE_BODY); } catch { console.error("PROBE_BODY is not JSON"); process.exit(2); } }
// Optional extra request headers (a JSON object of header -> value): some
// sellers gate the paid route on their own keys (Idempotency-Key, a receipt
// recovery id). Never the payment header - the paying fetch owns that.
let extraHeaders = {};
if (process.env.PROBE_HEADERS) {
  try { extraHeaders = JSON.parse(process.env.PROBE_HEADERS); } catch { console.error("PROBE_HEADERS is not JSON"); process.exit(2); }
  if (!extraHeaders || typeof extraHeaders !== "object" || Array.isArray(extraHeaders)) { console.error("PROBE_HEADERS must be a JSON object"); process.exit(2); }
  for (const k of Object.keys(extraHeaders)) if (/^(payment-signature|x-payment|authorization)$/i.test(k)) { console.error(`PROBE_HEADERS may not set ${k}`); process.exit(2); }
}
const reqHeaders = () => ({ ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders });

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
const client = new x402Client();
client.setSpendControls?.(false);
// Base only: the burner must never sign for another EVM chain a seller names.
registerExactEvmScheme(client, { signer: account, networks: ["eip155:8453"] });

// Refuse before signing when the seller's quote exceeds the cap: read the bare
// 402 first, and only then let the paying fetch retry.
const bare = await fetch(url, { method, headers: reqHeaders(), body: body ? JSON.stringify(body) : undefined });
console.log(`bare: HTTP ${bare.status}`);
if (bare.status !== 402) { console.log((await bare.text()).slice(0, 2000)); process.exit(bare.status === 200 ? 0 : 1); }
const pr = bare.headers.get("payment-required");
const accepts = pr ? JSON.parse(Buffer.from(pr, "base64").toString("utf8")).accepts : [];
const baseAccept = accepts.find((a) => a.network === "eip155:8453" && a.scheme === "exact");
if (!baseAccept) { console.error("no exact/eip155:8453 accept:", JSON.stringify(accepts).slice(0, 500)); process.exit(1); }
const quoteUsd = Number(baseAccept.amount) / 1e6;
console.log(`quote: $${quoteUsd} to ${baseAccept.payTo} (maxTimeoutSeconds ${baseAccept.maxTimeoutSeconds})`);
if (quoteUsd > maxUsd) { console.error(`quote $${quoteUsd} exceeds PROBE_MAX_USD ${maxUsd}; not paying`); process.exit(1); }
// The cap is enforced on the accept ACTUALLY SIGNED, not only on the bare
// 402 read above: the paying fetch issues its own unpaid request and pays
// whatever that second 402 says, so a seller that quotes one amount to the
// bare read and another to the paid retry (or lists a dearer chain first)
// would otherwise be paid the dearer one. The policy keeps only Base exact
// accepts at or under the cap, to the payee the bare read showed; when
// nothing survives the client has nothing to sign and the request fails.
const barePayTo = String(baseAccept.payTo).toLowerCase();
client.registerPolicy((_version, reqs) => reqs.filter((r) => {
  const okShape = r.scheme === "exact" && r.network === "eip155:8453" && String(r.payTo || "").toLowerCase() === barePayTo;
  let amt; try { amt = BigInt(String(r.amount)); } catch { return false; }
  const ok = okShape && amt <= maxAtomic;
  if (!ok) console.error(`refusing accept ${r.scheme}/${r.network} amount=${r.amount} payTo=${r.payTo}: outside the cap ($${maxUsd}) or not the payee the bare 402 named`);
  return ok;
}));

let receipt = null;
const payFetch = wrapFetchWithPayment(async (input, init) => {
  const res = await fetch(input, init);
  const rh = res.headers.get("payment-response");
  if (rh) { try { receipt = JSON.parse(Buffer.from(rh, "base64").toString("utf8")); } catch { /* keep null */ } }
  return res;
}, client);
const t0 = Date.now();
const res = await payFetch(url, { method, headers: reqHeaders(), body: body ? JSON.stringify(body) : undefined });
const text = await res.text();
console.log(`paid: HTTP ${res.status} in ${Date.now() - t0} ms, content-type ${res.headers.get("content-type")}`);
console.log(`receipt: ${JSON.stringify(receipt)}`);
console.log("body:");
console.log(text.slice(0, 6000));
process.exit(res.status === 200 ? 0 : 1);
