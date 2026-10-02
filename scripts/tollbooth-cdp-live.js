#!/usr/bin/env node
// LIVE proof of the Coinbase Business path: boot the tollbooth CLI's own
// middleware (buildCliX402Middleware, the code `npx agent402-tollbooth` runs)
// with CDP keys and a Base payTo, then pay it once from the canary burner with
// a stock x402 client. payTo = our treasury (PAY_TO; the daily canary's own
// $0.001 movement): Coinbase's facilitator refuses payer == payTo
// (`self_send_not_allowed`, measured 2026-08-27), so no self-pay proof exists. Asserts: 402 with a Base USDC accept naming the payTo, then a
// paid 200 whose PAYMENT-RESPONSE receipt says success with a transaction.
// Dispatch-only (.github/workflows/tollbooth-cdp-live.yml); never in CI lanes.
import { randomBytes } from "node:crypto";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";
import express from "express";
import { createTollbooth, buildCliX402Middleware } from "../tollbooth/index.js";
import { privateKeyToAccount } from "viem/accounts";

const { CDP_API_KEY_ID, CDP_API_KEY_SECRET } = process.env;
const pk = (process.env.BURNER_KEY || "").trim();
if (!pk || (process.env.CONTROL !== "payai" && (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET))) { console.error("need BURNER_KEY (+ CDP_API_KEY_ID/SECRET unless CONTROL=payai)"); process.exit(2); }
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const payTo = process.env.PAY_TO || account.address;

// CONTROL=payai runs the identical path through PayAI's keyless facilitator
// first, so a CDP refusal is distinguishable from a gate defect.
const control = process.env.CONTROL === "payai";
const mw = await buildCliX402Middleware(control
  ? { TOLLBOOTH_PAYTO: payTo, TOLLBOOTH_FACILITATOR_URL: "https://facilitator.payai.network", TOLLBOOTH_PRICE: "$0.001", TOLLBOOTH_NETWORK: "base", TOLLBOOTH_RESOURCE_BASE: "https://tollbooth-cdp-live-proof.invalid" }
  : { TOLLBOOTH_PAYTO: payTo, TOLLBOOTH_CDP_API_KEY_ID: CDP_API_KEY_ID, TOLLBOOTH_CDP_API_KEY_SECRET: CDP_API_KEY_SECRET, TOLLBOOTH_PRICE: "$0.001", TOLLBOOTH_NETWORK: "base", TOLLBOOTH_RESOURCE_BASE: "https://tollbooth-cdp-live-proof.invalid" });
console.log("facilitator:", control ? "PayAI (control)" : "Coinbase CDP");
if (typeof mw !== "function") { console.error("CLI did not build a settling middleware from CDP keys"); process.exit(1); }

const app = express();
// One process, one proof: the MPP challenge ids this gate mints only have to
// verify against the process that minted them, so a per-process random key
// is exactly right (PoW is off, so nothing else is keyed).
app.use(createTollbooth({ x402: mw, mode: "all", pow: false, mppSecret: randomBytes(32).toString("hex"), resourceBaseUrl: "https://tollbooth-cdp-live-proof.invalid" }));
app.get("/paid", (_req, res) => res.json({ ok: true, served: new Date().toISOString() }));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/paid`;

const bare = await fetch(url);
const pr = bare.headers.get("payment-required");
const req = pr ? JSON.parse(Buffer.from(pr, "base64").toString("utf8")) : null;
const accept = req?.accepts?.find((a) => a.network === "eip155:8453" && a.scheme === "exact");
console.log("bare:", bare.status, "accepts:", JSON.stringify(req?.accepts?.map((a) => ({ network: a.network, payTo: a.payTo, amount: a.amount }))));
if (bare.status !== 402 || !accept || accept.payTo.toLowerCase() !== payTo.toLowerCase() || accept.amount !== "1000") { console.error("402 shape wrong"); process.exit(1); }

const [{ x402Client, wrapFetchWithPayment }, { registerExactEvmScheme }] = await Promise.all([import("@x402/fetch"), import("@x402/evm/exact/client")]);
const client = disableVendorSpendControls(new x402Client()); registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);
const paid = await payFetch(url);
const body = await paid.json().catch(() => ({}));
const rh = paid.headers.get("payment-response");
const receipt = rh ? JSON.parse(Buffer.from(rh, "base64").toString("utf8")) : null;
console.log("paid:", paid.status, JSON.stringify(body).slice(0, 200));
console.log("receipt:", JSON.stringify(receipt));
console.log("X-Tollbooth-Paid:", paid.headers.get("x-tollbooth-paid"), "X-Tollbooth-Error:", paid.headers.get("x-tollbooth-error"));
// A refused retry carries the facilitator's reason in the fresh payment-required header.
const pr2 = paid.headers.get("payment-required");
if (pr2) { try { const r2 = JSON.parse(Buffer.from(pr2, "base64").toString("utf8")); console.log("retry payment-required:", JSON.stringify({ error: r2.error, x402Version: r2.x402Version, accepts: (r2.accepts || []).length })); } catch { console.log("retry payment-required: (unparseable)"); } }
server.close();
const ok = paid.status === 200 && body.ok === true && receipt?.success === true && /^0x[0-9a-f]{64}$/i.test(receipt?.transaction || "")
  && String(receipt?.payer || "").toLowerCase() === account.address.toLowerCase() && payTo.toLowerCase() !== account.address.toLowerCase();
if (ok) console.log(`PROVEN (${control ? "PayAI control" : "Coinbase CDP"}): settled, tx https://basescan.org/tx/${receipt.transaction} (payer ${receipt.payer} -> payTo ${payTo})`);
else console.error("NOT PROVEN");
process.exit(ok ? 0 : 1);
