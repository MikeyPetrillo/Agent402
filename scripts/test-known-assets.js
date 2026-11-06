#!/usr/bin/env node
// The buyer packages price an x402 accept from a table of known assets
// (known-assets.js), never from a decimals value in the challenge. Each
// package is published on its own, so each carries the file; this keeps the
// copies byte-identical and checks the table against what the server offers:
//   - every rail in src/rails.js has an entry,
//   - every EVM asset address is the one src/payments.js or @x402/evm's own
//     default table names for that chain, with the same decimals,
//   - Solana, Stellar and Algorand match their @x402 scheme packages.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL - ${m}`); } };

const COPIES = ["client/known-assets.js", "mcp/known-assets.js", "openclaw/known-assets.js"];
const texts = COPIES.map((p) => readFileSync(join(ROOT, p), "utf8"));
for (let i = 1; i < COPIES.length; i++) ok(texts[i] === texts[0], `${COPIES[i]} is byte-identical to ${COPIES[0]}`);
for (const p of COPIES) {
  const pkg = JSON.parse(readFileSync(join(ROOT, p.split("/")[0], "package.json"), "utf8"));
  ok((pkg.files || []).includes("known-assets.js"), `${pkg.name} ships known-assets.js in its "files"`);
}

const { KNOWN_ASSETS, acceptUsd, knownAsset } = await import(join(ROOT, "client/known-assets.js"));
const { RAILS } = await import(join(ROOT, "src/rails.js"));
for (const r of RAILS) {
  const list = KNOWN_ASSETS[r.caip2] || [];
  ok(list.some((e) => e.symbol === r.asset), `rail ${r.name} (${r.caip2}) has a known ${r.asset} entry`);
}

// The EVM table: each address appears in src/payments.js or in @x402/evm's
// default-asset chunk beside its chain, with decimals 6.
const payments = readFileSync(join(ROOT, "src/payments.js"), "utf8");
const require = createRequire(join(ROOT, "package.json"));
const evmDir = join(require.resolve("@x402/evm").split("/dist/")[0], "dist", "esm");
const { readdirSync } = await import("node:fs");
const evmSrc = readdirSync(evmDir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(join(evmDir, f), "utf8")).join("\n");
for (const [network, list] of Object.entries(KNOWN_ASSETS)) {
  if (!network.startsWith("eip155:")) continue;
  for (const e of list) {
    const inPayments = payments.toLowerCase().includes(e.asset.toLowerCase());
    const block = evmSrc.match(new RegExp(`"${network}":\\s*\\[\\s*\\{[^\\]]*?asset:\\s*"(0x[0-9a-fA-F]{40})"[^\\]]*?decimals:\\s*(\\d+)`));
    const inEvm = block && block[1].toLowerCase() === e.asset.toLowerCase() && Number(block[2]) === e.decimals;
    ok(e.decimals === 6 && (inPayments || inEvm), `${network} ${e.symbol} ${e.asset} is the asset the server offers (${inPayments ? "src/payments.js" : inEvm ? "@x402/evm default" : "not found"})`);
  }
}
const pkgText = (name) => {
  const dir = join(require.resolve(name).split("/dist/")[0], "dist", "esm");
  return readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
};
const svm = pkgText("@x402/svm"), stellar = pkgText("@x402/stellar"), avm = pkgText("@x402/avm");
ok(svm.includes(`USDC_MAINNET_ADDRESS = "${KNOWN_ASSETS["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"][0].asset}"`), "Solana USDC mint matches @x402/svm");
ok(stellar.includes(`USDC_PUBNET_ADDRESS = "${KNOWN_ASSETS["stellar:pubnet"][0].asset}"`) && /DEFAULT_TOKEN_DECIMALS = 7;/.test(stellar) && KNOWN_ASSETS["stellar:pubnet"][0].decimals === 7, "Stellar USDC contract and its 7 decimals match @x402/stellar");
ok(avm.includes(`USDC_MAINNET_ASA_ID = "${KNOWN_ASSETS["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"][0].asset}"`), "Algorand USDC ASA matches @x402/avm");
ok(avm.includes(`ALGORAND_MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"`), "the Algorand mainnet key is the CAIP-2 id @x402/avm names");
ok(JSON.stringify(KNOWN_ASSETS["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="]) === JSON.stringify(KNOWN_ASSETS["algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"]), "the full-hash spelling of Algorand mainnet prices the same asset");

// The pricing contract itself.
const BASE = KNOWN_ASSETS["eip155:8453"][0].asset;
ok(acceptUsd({ network: "eip155:8453", asset: BASE, amount: "1500000", extra: { decimals: 18 } }) === 1.5, "a decimals hint in the accept is ignored");
ok(acceptUsd({ network: "eip155:8453", asset: "0x000000000000000000000000000000000000bEEF", amount: "1" }) === null, "an unknown asset cannot be priced");
ok(knownAsset("eip155:8453", BASE.toLowerCase()) && !knownAsset("stellar:pubnet", KNOWN_ASSETS["stellar:pubnet"][0].asset.toLowerCase()), "EVM addresses match without case; Stellar ones exactly");

// Pricing by version: a v1 signer signs maxAmountRequired and a v2 signer
// signs amount, so the price is read from the field the challenge's version
// signs, and an accept that carries both at different values is not priced.
{
  const { acceptAmount, quoteOf } = await import(join(ROOT, "client/known-assets.js"));
  const split = { network: "eip155:8453", asset: BASE, amount: "1000", maxAmountRequired: "500000000" };
  ok(acceptUsd(split, 1) === null && acceptUsd(split, 2) === null && acceptUsd(split) === null, "an accept whose amount and maxAmountRequired differ is not priced under v1, v2 or no version");
  ok(acceptUsd({ network: "eip155:8453", asset: BASE, maxAmountRequired: "1000" }, 1) === 0.001 && acceptUsd({ network: "eip155:8453", asset: BASE, amount: "1000" }, 2) === 0.001, "v1 prices maxAmountRequired and v2 prices amount");
  ok(acceptUsd({ network: "eip155:8453", asset: BASE, amount: "1000" }, 1) === null && acceptUsd({ network: "eip155:8453", asset: BASE, maxAmountRequired: "1000" }, 2) === null, "the field the version does not sign is never the price");
  ok(acceptUsd({ network: "eip155:8453", asset: BASE, amount: "1000", maxAmountRequired: "1000" }, 1) === 0.001 && acceptUsd({ network: "eip155:8453", asset: BASE, amount: "1000" }, 3) === null, "agreeing fields price; an unknown version does not");
  ok(acceptAmount(split, 2) === null && acceptAmount({ amount: "1000" }, 2) === "1000", "acceptAmount reads the signed field as digits");
  ok(quoteOf([split], 2).unknown === 1 && quoteOf([split], 2).max === null, "quoteOf counts a split accept as unpriced");
  // The table is keyed by CAIP-2 only: a bare v1 network name is not priced
  // unless the table deliberately lists it.
  for (const name of ["base", "base-sepolia", "polygon", "solana", "avalanche"]) {
    ok(!Object.prototype.hasOwnProperty.call(KNOWN_ASSETS, name), `the bare v1 name "${name}" is not a table key`);
  }
  ok(acceptUsd({ network: "base", asset: BASE, maxAmountRequired: "1000" }, 1) === null, "a v1 accept on the bare name \"base\" is not priced");
}

// The signed amount is checked after the payload is built and before it is
// sent: a signer that commits to more than the priced amount is refused, and
// the payment-aware fetch never sends it.
{
  const { signedAmountOf, signedPaymentProblem, guardSigning } = await import(join(ROOT, "client/known-assets.js"));
  const req = { scheme: "exact", network: "eip155:8453", asset: BASE, payTo: "0x000000000000000000000000000000000000dEaD", amount: "1000", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  ok((await signedAmountOf({ payload: { authorization: { value: "1000" } } }, "eip155:8453")).amount === "1000", "an EIP-3009 authorization.value is read");
  ok((await signedAmountOf({ payload: { permit2Authorization: { permitted: { amount: "1000" } } } }, "eip155:8453")).amount === "1000", "a Permit2 permitted.amount is read");
  ok(await signedAmountOf({ payload: {} }, "eip155:8453") === null && await signedAmountOf({ payload: { authorization: { value: "1" }, permit2Authorization: { permitted: { amount: "1" } } } }, "eip155:8453") === null, "an EVM payload with no amount, or two, is unreadable");
  ok(await signedPaymentProblem({ payload: { authorization: { value: "1000" } } }, req, 2, 0.01) === null, "a payload that signs the priced amount passes");
  ok(/differs/.test(await signedPaymentProblem({ payload: { authorization: { value: "500000000" } } }, req, 2, 1e9)), "a payload that signs another amount is refused whatever the cap");
  ok(/above/.test(await signedPaymentProblem({ payload: { authorization: { value: "1000" } } }, req, 2, 0.0001)), "a payload over the cap is refused");
  ok(/cannot be read/.test(await signedPaymentProblem({ payload: { authorization: { value: "1000" } } }, { ...req, maxAmountRequired: "500000000" }, 2, 1)), "a split accept is refused after signing too");

  // End to end on a real x402Client and the stock v2 EVM signer, wrapped to
  // sign more than the accept asks; every send is counted.
  const { x402Client } = await import("@x402/core/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const offer = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "http://127.0.0.1/x" }, accepts: [req] })).toString("base64");
  const run = async (signAmount) => {
    let sent = 0;
    const fake = async (input, init) => {
      const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (h.get("payment-signature") || h.get("x-payment")) { sent++; return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": offer } });
    };
    const xc = new x402Client();
    xc.setSpendControls(false);
    const refusals = [];
    guardSigning(xc, { allowance: () => 0.01, onRefuse: (d) => refusals.push(d) });
    const real = new ExactEvmScheme(privateKeyToAccount(generatePrivateKey()));
    xc.register("eip155:8453", { scheme: "exact", createPaymentPayload: (v, r, ctx) => real.createPaymentPayload(v, { ...r, amount: signAmount }, ctx) });
    let err = null; try { await wrapFetchWithPayment(fake, xc)("http://127.0.0.1/x"); } catch (e) { err = String(e.message); }
    return { sent, err, refusals };
  };
  const lying = await run("500000000");
  ok(lying.sent === 0 && /signed amount/.test(lying.err || "") && lying.refusals.some((d) => d.reason === "signed-amount"), `a signer that signs over the priced amount is refused before sending (sent ${lying.sent}, ${lying.err})`);
  const honest = await run("1000");
  ok(honest.sent === 1 && honest.err === null, "the same client sends a payload that signs the priced amount");

  // Solana: a real v2 "exact" payload (legacy-v0 and v1 transactions) built by
  // @x402/svm against a loopback RPC stub, decoded back to its transfer.
  const http = await import("node:http");
  const { ExactSvmScheme } = await import("@x402/svm/exact/client");
  const { generateKeyPairSigner } = await import("@solana/kit");
  const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", MINT = KNOWN_ASSETS[SOL][0].asset;
  const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1; // decimals 6, initialized
  const rpc = http.createServer((q, res) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => {
    const { id, method } = JSON.parse(b);
    const result = method === "getAccountInfo"
      ? { context: { slot: 1 }, value: { data: [mint.toString("base64"), "base64"], executable: false, lamports: 1, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 82 } }
      : { context: { slot: 1 }, value: { blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", lastValidBlockHeight: 100 } };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }); });
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
  try {
    const scheme = new ExactSvmScheme(await generateKeyPairSigner(), { rpcUrl: `http://127.0.0.1:${rpc.address().port}` });
    const sreq = { scheme: "exact", network: SOL, asset: MINT, payTo: (await generateKeyPairSigner()).address, amount: "1000", maxTimeoutSeconds: 60, extra: { feePayer: (await generateKeyPairSigner()).address } };
    for (const tv of [0, 1]) {
      const p = await scheme.createPaymentPayload(2, { ...sreq, extra: { ...sreq.extra, transactionVersions: [tv] } });
      const got = await signedAmountOf(p, SOL);
      ok(got && got.amount === "1000" && got.decimals === 6, `a Solana v${tv} transaction's TransferChecked amount is read (${JSON.stringify(got)})`);
      ok(await signedPaymentProblem(p, sreq, 2, 0.01) === null && /differs/.test(await signedPaymentProblem(p, { ...sreq, amount: "999" }, 2, 0.01)), `a Solana v${tv} payload passes at its own amount and is refused against another`);
    }
    ok(await signedAmountOf({ payload: { transaction: "AAAA" } }, SOL) === null, "an undecodable Solana transaction is unreadable (refused)");
  } finally { rpc.close(); }
}

// A table change ships only with a version bump: scripts/known-assets-pins.json
// holds the table's sha256 at the package version it was pinned at (no
// network: the published tarball is not read). A table that differs from its
// pin needs a version past the pinned one, then
// `node scripts/test-known-assets.js --write` to re-pin; a bump alone re-pins nothing.
{
  const { createHash } = await import("node:crypto");
  const { writeFileSync } = await import("node:fs");
  const PINS = join(ROOT, "scripts/known-assets-pins.json");
  const pins = JSON.parse(readFileSync(PINS, "utf8"));
  const current = Object.fromEntries(COPIES.map((p, i) => [p.split("/")[0], { version: JSON.parse(readFileSync(join(ROOT, p.split("/")[0], "package.json"), "utf8")).version, sha256: createHash("sha256").update(texts[i]).digest("hex") }]));
  if (process.argv.includes("--write")) { writeFileSync(PINS, JSON.stringify(current, null, 2) + "\n"); Object.assign(pins, current); console.log(`wrote ${PINS}`); }
  for (const [dir, now] of Object.entries(current)) {
    const pin = pins[dir] || {};
    ok(now.sha256 === pin.sha256 || now.version !== pin.version, `${dir}/known-assets.js changed since ${pin.version || "?"}, so ${dir}/package.json must bump its version`);
    ok(now.sha256 === pin.sha256, `${dir} pin records its table at ${pin.version || "?"} (after the bump, run with --write)`);
  }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
