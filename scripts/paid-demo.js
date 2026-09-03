// One REAL paid buy of a named tool over a PINNED chain — the capture step
// for announcement demo cards ("real output, never a fixture"). Same
// negotiation as the paid canary's pinned EVM legs: take the live 402, filter
// its accepts down to ONE CAIP-2 chain, pay exactly that, and print what a
// buyer actually gets — the quote, the full result JSON, and the settle
// receipt (network + on-chain tx).
//
// Usage (BURNER_KEY = a funded EVM test wallet, never a prod key):
//   BURNER_KEY=0x… node scripts/paid-demo.js \
//     --path "/api/company-financials?ticker=NVDA" \
//     [--method GET] [--body '{"text":"hi"}'] \
//     [--chain eip155:42220] [--out demo-result.json]
//
// --out writes {tool, method, chain, quote, receipt, result} for a card
// renderer to consume. Exit 1 on usage, 2 on a failed buy.
import { writeFileSync } from "node:fs";

const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PATH = arg("--path");
const METHOD = (arg("--method", "GET") || "GET").toUpperCase();
const BODY = arg("--body");
const CHAIN = arg("--chain", "eip155:8453");
const OUT = arg("--out");
// --target lets a dispatcher point this at ANY external x402 seller (by
// design, for ecosystem demos) - unlike every other spend-capable workflow in
// this repo (algorand-external-buy.yml, algorand-rail-canary.yml, refund.yml),
// this one had no ceiling on what it would pay. A malicious or misbehaving
// external seller's 402 could quote an arbitrary price and this would pay it
// from the funded demo burner. Real tool prices are cents; $2 is generous
// headroom for even a premium-priced legitimate demo.
const MAX_USD = Number(arg("--max-usd", "2.00"));
if (!PATH || !PATH.startsWith("/")) {
  console.error('usage: BURNER_KEY=0x… node scripts/paid-demo.js --path "/api/…" [--method GET] [--body json] [--chain eip155:…] [--out file.json]');
  process.exit(1);
}
// Chain-namespace signer dispatch — same signer setups as the paid canary's
// per-rail legs, so any chain the canary can prove, a demo can capture.
// Each rail registers ONLY its own scheme, so the payment can never silently
// settle on a different accept than the pinned one.
const { x402Client, x402HTTPClient } = await import("@x402/core/client");
const client = new x402Client();
let payerAddress;
if (CHAIN.startsWith("eip155:")) {
  const pk = (process.env.BURNER_KEY || "").trim();
  if (!pk) { console.error("paid-demo: no BURNER_KEY — cannot buy on an EVM chain"); process.exit(1); }
  const [{ privateKeyToAccount }, { registerExactEvmScheme }] = await Promise.all([
    import("viem/accounts"), import("@x402/evm/exact/client"),
  ]);
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  registerExactEvmScheme(client, { signer: account });
  payerAddress = account.address;
} else if (CHAIN.startsWith("solana:")) {
  const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
  if (!raw) { console.error("paid-demo: no SOLANA_BURNER_KEY — cannot buy on Solana"); process.exit(1); }
  const [{ registerExactSvmScheme }, kit] = await Promise.all([
    import("@x402/svm/exact/client"), import("@solana/kit"),
  ]);
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
  const signer = await kit.createKeyPairSignerFromBytes(bytes);
  registerExactSvmScheme(client, { signer });
  payerAddress = signer.address;
} else if (CHAIN.startsWith("stellar:")) {
  const secret = (process.env.STELLAR_BURNER_SECRET || "").trim();
  if (!secret) { console.error("paid-demo: no STELLAR_BURNER_SECRET — cannot buy on Stellar"); process.exit(1); }
  const [{ ExactStellarScheme }, sdk] = await Promise.all([
    import("@x402/stellar/exact/client"), import("@stellar/stellar-sdk"),
  ]);
  const keypair = sdk.Keypair.fromSecret(secret);
  const signer = { address: keypair.publicKey(), ...sdk.contract.basicNodeSigner(keypair, sdk.Networks.PUBLIC) };
  const rpcUrl = (process.env.STELLAR_RPC_URL || "https://mainnet.sorobanrpc.com").trim();
  client.register("stellar:*", new ExactStellarScheme(signer, { url: rpcUrl }));
  payerAddress = keypair.publicKey();
} else if (CHAIN.startsWith("algorand:")) {
  const mnemonic = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
  if (!mnemonic) { console.error("paid-demo: no ALGORAND_BURNER_MNEMONIC — cannot buy on Algorand"); process.exit(1); }
  const [{ ExactAvmScheme }, { toClientAvmSigner }, algosdk] = await Promise.all([
    import("@x402/avm/exact/client"), import("@x402/avm"), import("algosdk"),
  ]);
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
  const algodUrl = (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim();
  client.register("algorand:*", new ExactAvmScheme(signer, { algodUrl }));
  payerAddress = account.addr.toString();
} else {
  console.error(`paid-demo: unsupported chain namespace "${CHAIN}"`);
  process.exit(1);
}
const http = new x402HTTPClient(client);

const reqInit = {
  method: METHOD,
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  ...(BODY ? { body: BODY } : {}),
  signal: AbortSignal.timeout(60000),
};
const url = `${TARGET}${PATH}`;
console.log(`$ ${METHOD} ${url}`);
const bare = await fetch(url, reqInit);
if (bare.status !== 402) {
  console.error(`paid-demo: expected a 402 challenge, got HTTP ${bare.status}`);
  process.exit(2);
}
let paymentRequired;
try {
  const bareBody = await bare.json().catch(() => undefined);
  paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
} catch (e) {
  console.error(`paid-demo: could not parse the 402 challenge: ${e?.message || e}`);
  process.exit(2);
}
const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === CHAIN);
if (!accepts.length) {
  console.error(`paid-demo: ${CHAIN} not among the live accepts (${(paymentRequired.accepts || []).map((a) => a.network).join(", ")})`);
  process.exit(2);
}
const quote = {
  network: accepts[0].network,
  asset: accepts[0].asset,
  amount: accepts[0].amount ?? accepts[0].maxAmountRequired,
  usd: Number(accepts[0].amount ?? accepts[0].maxAmountRequired) / 1e6,
};
console.log(`→ HTTP 402 · quote $${quote.usd} on ${quote.network} (payer ${payerAddress})`);
if (!(quote.usd >= 0) || quote.usd > MAX_USD) {
  console.error(`paid-demo: quote $${quote.usd} exceeds the $${MAX_USD} cap (--max-usd to override) - refusing to pay`);
  process.exit(2);
}

// Normalize v1-style accepts before signing: some sellers (e.g. Stelar) carry
// the amount ONLY in maxAmountRequired, and the scheme's BigInt(amount) throws
// on undefined (hit live 2026-07-23 on the Stelar retry buy).
const normalized = accepts.map((a) => ({ ...a, amount: String(a.amount ?? a.maxAmountRequired) }));
const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: normalized });
const payHeaders = http.encodePaymentSignatureHeader(payload);
// Header-name compatibility: @x402/core v2.16 emits only PAYMENT-SIGNATURE,
// but some sellers (Stelar: error "X-PAYMENT header required", 2026-07-23)
// read only the X-PAYMENT name. Mirror the same value under both.
// PAID_DEMO_MIRROR=off sends ONLY PAYMENT-SIGNATURE - the pure stock-client
// shape - so a seller that reads X-PAYMENT first (and takes the v1 path on it)
// can be told apart from one that refuses the payment itself (2026-09-02).
// Default: mirror only on a v1 challenge (a v2 seller reading X-PAYMENT first
// takes its v1 path; xfuel's has no Solana branch). PAID_DEMO_MIRROR=on forces
// the mirror, =off never mirrors.
// Default: no mirror (the stock client shape). PAID_DEMO_MIRROR=on forces it.
const shouldMirror = process.env.PAID_DEMO_MIRROR === "on";
if (shouldMirror && payHeaders["PAYMENT-SIGNATURE"] && !payHeaders["X-PAYMENT"]) payHeaders["X-PAYMENT"] = payHeaders["PAYMENT-SIGNATURE"];
const paid = await fetch(url, {
  ...reqInit,
  headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
});
const result = await paid.json().catch(() => ({}));
let receipt = null;
const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
if (receiptHdr) {
  try { receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8")); } catch { /* best-effort */ }
}
if (paid.status !== 200) {
  console.error(`paid-demo: buy did NOT settle — HTTP ${paid.status} error=${JSON.stringify(result?.error ?? null)} body=${JSON.stringify(result).slice(0, 500)}`);
  process.exit(2);
}
console.log(`→ HTTP 200 · settled${receipt?.transaction ? ` · tx ${receipt.transaction}` : ""}${receipt?.network ? ` · network ${receipt.network}` : ""}`);
console.log("\n--- result JSON ---");
console.log(JSON.stringify(result, null, 2));
if (OUT) {
  writeFileSync(OUT, JSON.stringify({ tool: PATH, method: METHOD, chain: CHAIN, quote, receipt, result }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
