// The Algorand buyer pays a seller that still advertises the legacy network id
// (the full genesis hash). @x402/avm 2.29 refuses that spelling when it picks
// the algod client and asset, so src/x402-buyer.js folds it to the CAIP-2 id
// inside the scheme only; the payment still echoes the seller's own accept.
// Offline: the real x402 client and scheme, a stub algod client.
import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import algosdk from "algosdk";
import { avmSchemeAcceptingLegacyNetwork } from "../src/x402-buyer.js";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_MAINNET_LEGACY_CAIP2 } from "../src/avm-network.js";
import { disableVendorSpendControls } from "../src/x402-spend-controls.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

const account = algosdk.generateAccount();
const payTo = algosdk.generateAccount().addr.toString();
const feePayer = algosdk.generateAccount().addr.toString();
// A real AlgorandClient against a local stub algod that answers the one read
// a payment needs: suggested transaction params (mainnet genesis).
const { AlgorandClient } = await import("@algorandfoundation/algokit-utils/algorand-client");
const http = await import("node:http");
const algod = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/v2/transactions/params")) return res.end(JSON.stringify({ "consensus-version": "future", fee: 0, "min-fee": 1000, "genesis-id": "mainnet-v1.0", "genesis-hash": "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "last-round": 1000 }));
  res.statusCode = 404; res.end("{}");
}).listen(0, "127.0.0.1");
await new Promise((r) => algod.on("listening", r));
const algorandClient = AlgorandClient.fromConfig({ algodConfig: { server: `http://127.0.0.1`, port: algod.address().port, token: "" } }).setDefaultValidityWindow(1000);

const required = (network) => ({
  x402Version: 2,
  resource: { url: "https://seller.example/api/x", description: "x", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network, amount: "10000", asset: "31566704", payTo, maxTimeoutSeconds: 60, extra: { feePayer } }],
});
const clientWith = (scheme) => {
  const c = disableVendorSpendControls(new x402Client());
  c.register("algorand:*", scheme);
  return c;
};
const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
const tryPay = async (scheme, network) => { try { return await clientWith(scheme).createPaymentPayload(required(network)); } catch (e) { return { error: String(e?.message || e) }; } };

const bare = await tryPay(new ExactAvmScheme(signer, { algorandClient }), ALGORAND_MAINNET_LEGACY_CAIP2);
ok(Boolean(bare.error) && /Unsupported Algorand network/.test(bare.error), `the stock 2.29 scheme refuses the legacy id (control: ${bare.error?.slice(0, 80) || "no error"})`);

const legacy = await tryPay(avmSchemeAcceptingLegacyNetwork(new ExactAvmScheme(signer, { algorandClient })), ALGORAND_MAINNET_LEGACY_CAIP2);
ok(!legacy.error && legacy.payload, `the wrapped scheme signs for a seller on the legacy id (${legacy.error || "signed"})`);
ok(legacy.accepted?.network === ALGORAND_MAINNET_LEGACY_CAIP2, `...and the payment echoes the seller's own accept, legacy id included (${legacy.accepted?.network})`);
ok(legacy.accepted?.payTo === payTo && legacy.accepted?.amount === "10000", "...with the seller's payTo and amount unchanged");

const short = await tryPay(avmSchemeAcceptingLegacyNetwork(new ExactAvmScheme(signer, { algorandClient })), ALGORAND_MAINNET_CAIP2);
ok(!short.error && short.accepted?.network === ALGORAND_MAINNET_CAIP2, `a seller on the CAIP-2 id is paid as before (${short.error || short.accepted?.network})`);
ok(JSON.stringify(legacy.payload) !== undefined && Object.keys(legacy.payload).join() === Object.keys(short.payload).join(), "both spellings produce the same payload shape");

algod.close();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
