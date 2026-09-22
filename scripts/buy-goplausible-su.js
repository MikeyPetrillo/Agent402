#!/usr/bin/env node
// Buy a GoPlausible Settlement Unit card for THIS wallet, from THIS machine.
//
// Why a script: GoPlausible sponsors the Algorand fee on every x402 settlement
// we serve and gives each payTo 1,000 free sponsored sub-cent settlements a
// month. SUs are credited to the wallet that PAYS for the card, so the payment
// has to come from the payTo wallet itself - the treasury - whose key lives
// only with the operator. Their web client needs a wallet extension or
// WalletConnect; this does the same x402 payment from a mnemonic in the
// operator's own shell. The mnemonic is read from the environment only and is
// never printed, logged or written.
//
//   ALGORAND_MNEMONIC="<25 words>" node scripts/buy-goplausible-su.js 10            # dry run: shows the 402 accept
//   ALGORAND_MNEMONIC="<25 words>" node scripts/buy-goplausible-su.js 10 --confirm  # pays
//
// Refuses: a tier that is not 10/100/1000, an accept on any network but
// Algorand mainnet, an amount above the card price, and (without --confirm)
// any payment at all.
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";

const FACILITATOR = (process.env.GOPLAUSIBLE_URL || "https://facilitator.goplausible.xyz").replace(/\/$/, "");
const ALGORAND_MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const USDC_ASA = "31566704";

const tier = process.argv[2];
const confirm = process.argv.includes("--confirm");
if (!["10", "100", "1000"].includes(String(tier))) { console.error("usage: node scripts/buy-goplausible-su.js <10|100|1000> [--confirm]"); process.exit(2); }
const mnemonic = (process.env.ALGORAND_MNEMONIC || "").trim();
if (!mnemonic) { console.error("ALGORAND_MNEMONIC is not set (25 words, environment only - never on the command line)."); process.exit(2); }

const url = `${FACILITATOR}/sponsorship/purchase/${tier}`;
const bare = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
if (bare.status !== 402) { console.error(`expected a 402 from ${url}, got ${bare.status}: ${(await bare.text()).slice(0, 200)}`); process.exit(1); }
const hdr = bare.headers.get("payment-required");
const required = hdr ? JSON.parse(Buffer.from(hdr, "base64").toString("utf8")) : await bare.json();
const accept = (required.accepts || []).find((a) => a.network === ALGORAND_MAINNET);
if (!accept) { console.error("no Algorand mainnet accept on the 402; offered:", (required.accepts || []).map((a) => a.network)); process.exit(1); }
const amount = BigInt(accept.amount ?? accept.maxAmountRequired);
const cap = BigInt(tier) * 1_000_000n;
console.log(`card:      $${tier}  (${tier === "10" ? "25,000" : tier === "100" ? "250,000" : "2,500,000"} Algorand SUs)`);
console.log(`network:   ${accept.network}`);
console.log(`asset:     ${accept.asset}${String(accept.asset) === USDC_ASA ? " (USDC)" : "  <-- NOT USDC, refusing"}`);
console.log(`amount:    ${Number(amount) / 1e6} USDC`);
console.log(`payTo:     ${accept.payTo}`);
console.log(`feePayer:  ${accept.extra?.feePayer || "(none)"}`);
if (String(accept.asset) !== USDC_ASA) process.exit(1);
if (amount > cap) { console.error(`amount ${amount} exceeds the $${tier} card price - refusing`); process.exit(1); }

const [{ x402Client }, { ExactAvmScheme }, { wrapFetchWithPayment }, { toClientAvmSigner }, algosdk] = await Promise.all([
  import("@x402/core/client"), import("@x402/avm/exact/client"), import("@x402/fetch"), import("@x402/avm"), import("algosdk"),
]);
const account = algosdk.mnemonicToSecretKey(mnemonic);
const address = account.addr.toString();
console.log(`payer:     ${address}  (SUs are credited to THIS wallet)`);
if (!confirm) { console.log("\nDry run. Re-run with --confirm to pay."); process.exit(0); }

const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
const client = disableVendorSpendControls(new x402Client());
client.register("algorand:*", new ExactAvmScheme(signer, { algodUrl: process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud" }));
const pay = wrapFetchWithPayment(fetch, client);
const res = await pay(url, { method: "POST", headers: { Accept: "application/json" } });
const body = await res.text();
console.log(`\nHTTP ${res.status}`);
console.log(body.slice(0, 600));
const receipt = res.headers.get("payment-response") || res.headers.get("x-payment-response");
if (receipt) { try { const r = JSON.parse(Buffer.from(receipt, "base64").toString("utf8")); console.log(`settled: ${r.success}  tx: ${r.transaction || "-"}`); } catch {} }
const status = await (await fetch(`${FACILITATOR}/sponsorship/status?wallet=${address}`)).json();
console.log("\nsponsorship status:", JSON.stringify(status.chains?.find((c) => c.chain === "algorand") || status));
process.exit(res.status === 200 ? 0 : 1);
