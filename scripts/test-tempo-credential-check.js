// payTempo checks what the minted credential carries before sending it: one
// USDC.e transfer of exactly the capped quote to the checked recipient. A
// credential that says anything else is refused with nothing sent (the stub
// seller never sees a paid request) and nothing committed. Offline: a stub
// seller on port 0 and locally signed credentials; nothing is broadcast.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mintTempoTestCredential, tempoTransferCall } from "./lib/tempo-test-credential.js";
import { createServer } from "node:http";
import { Challenge } from "mppx";
import { encodeFunctionData } from "viem";
import { Abis } from "viem/tempo";
import { payTempo, credentialPaymentRefusal, TEMPO_USDC } from "../src/tempo-buyer.js";
(await import("../src/x402-buyer.js")).__setBuyerAddressGuardForTest(false); // this suite's seller is a local stub
import { __seedPayoutListForTests } from "../src/tools/sanctions-kit.js";
import { tempoCappedChargeOptions, TEMPO_SCRIPT_MAX_AMOUNT } from "./lib/buyer-guard.js";
__seedPayoutListForTests();

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const origWarn = console.warn;
console.warn = () => {};

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const QUOTE = "2000";
let paidHits = 0;
const challengeHeader = () => Challenge.serialize(Challenge.from({
  realm: "seller.test", method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
  request: { amount: QUOTE, currency: TEMPO_USDC, recipient: RECIPIENT, methodDetails: { chainId: 4217 } }, secretKey: "seller-secret",
}));
const seller = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (/^Payment /.test(req.headers.authorization || "")) {
      paidHits++;
      res.writeHead(200, { "content-type": "application/json", "payment-receipt": Buffer.from(JSON.stringify({ method: "tempo", status: "success", reference: "0xfeed", timestamp: new Date().toISOString() })).toString("base64url") });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(402, { "www-authenticate": challengeHeader() });
    res.end("{}");
  });
});
await new Promise((r) => seller.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${seller.address().port}/v1/scrape`;
const buy = (createCredential) => payTempo(URL_, { method: "POST", body: {}, maxAtomic: 5000n, createCredential, proof: async () => ({ count: 4000, payers: 50 }) }).then((r) => ({ r }), (e) => ({ e }));

try {
  // CONTROL: a credential that carries the checked payment is sent and paid.
  {
    const before = paidHits;
    const { r, e } = await buy(async (res402) => mintTempoTestCredential(res402));
    ok(!e && r?.result?.ok === true && paidHits === before + 1, `CONTROL: a credential moving the quote to the recipient is sent (${e?.message || "paid"})`);
    const plain = await buy(async (res402) => mintTempoTestCredential(res402, { override: { calls: [{ to: TEMPO_USDC, data: encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [RECIPIENT, BigInt(QUOTE)] }) }] } }));
    ok(!plain.e && paidHits === before + 2, "CONTROL: a plain transfer (no memo) of the quote is sent too");
  }

  const refused = async (label, override, re) => {
    const before = paidHits;
    const { e } = await buy(async (res402) => typeof override === "function" ? override(res402) : mintTempoTestCredential(res402, { override }));
    ok(e && e.refused === true && e.statusCode === 502, `${label} -> refused (${String(e?.message).slice(0, 110)})`);
    ok(re.test(String(e?.message)), `${label} -> the refusal names why`);
    ok(paidHits === before, `${label} -> nothing was sent to the seller`);
    ok(e?.committed !== true && e?.signedUsd === undefined, `${label} -> nothing is booked as spent`);
  };
  await refused("a credential moving more than the capped quote", { amount: "4000" }, /moves 0\.004 USDC, not the capped quote 0\.002/);
  await refused("a credential moving less than the quote", { amount: "1999" }, /not the capped quote/);
  await refused("a credential paying another recipient", { recipient: OTHER }, /another recipient/);
  await refused("a credential paying in another token", { token: "0x20c0000000000000000000000000000000000000" }, /not in USDC\.e/);
  await refused("a credential with a second transfer", { calls: [tempoTransferCall({ recipient: RECIPIENT, amount: QUOTE }), tempoTransferCall({ recipient: OTHER, amount: "1" })] }, /2 calls, not one transfer/);
  await refused("a credential whose call is an approve", { calls: [{ to: TEMPO_USDC, data: encodeFunctionData({ abi: Abis.tip20, functionName: "approve", args: [OTHER, 10n ** 12n] }) }] }, /approve, not a transfer/);
  await refused("a credential with native value on its call", { calls: [{ ...tempoTransferCall({ recipient: RECIPIENT, amount: QUOTE }), value: 1n }] }, /native value/);
  await refused("a credential that does not decode", async () => "Payment ZmFrZQ", /does not decode/);
} finally {
  seller.close();
  console.warn = origWarn;
}

// The pure check, on its own.
{
  const res402 = new Response(null, { status: 402, headers: { "www-authenticate": challengeHeader() } });
  const good = mintTempoTestCredential(res402);
  ok(await credentialPaymentRefusal(good, { amountAtomic: 2000n, recipient: RECIPIENT.toUpperCase().replace("0X", "0x") }) === null, "the recipient compares case-blind (EVM hex)");
  ok(typeof await credentialPaymentRefusal(good, { amountAtomic: 2001n, recipient: RECIPIENT }) === "string", "one base unit off is a refusal");
}

// Our own paying scripts (the canary's mpp-tempo leg, the volume runner) sign
// tempo/charge under the per-call ceiling: mppx refuses a dearer challenge
// when choosing it and again before any signing (and before any RPC).
{
  const { tempo } = await import("mppx/client");
  const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
  const opts = tempoCappedChargeOptions({ autoSwap: true });
  ok(opts.maxAmount === TEMPO_SCRIPT_MAX_AMOUNT && opts.decimals === 6 && opts.autoSwap?.maxAmountIn === 10_000n, "the scripts' ceiling is the canary's MPP figure, and the swap input is held to it");
  const method = tempo.charge({ account: privateKeyToAccount(generatePrivateKey()), ...opts, getClient: () => { throw new Error("no RPC in this suite"); } });
  const challengeFor = (amount, currency = TEMPO_USDC) => ({ request: { amount, currency, recipient: RECIPIENT, methodDetails: { chainId: 4217 } } });
  ok(method.canHandleChallenge({ challenge: challengeFor("1000") }) === true, "a list-price challenge ($0.001) is payable");
  ok(method.canHandleChallenge({ challenge: challengeFor("10000") }) === true, "the ceiling itself is payable");
  ok(method.canHandleChallenge({ challenge: challengeFor("10001") }) === false, "one base unit over the ceiling is skipped");
  ok(method.canHandleChallenge({ challenge: challengeFor("1000", "0x20c0000000000000000000000000000000000000") }) === true, "a PathUSD challenge is payable under the same ceiling");
  ok(method.canHandleChallenge({ challenge: challengeFor("1000", "0x" + "7".repeat(40)) }) === false, "a challenge in another currency is skipped");
  let refusedErr = null;
  try { await method.createCredential({ challenge: { ...challengeFor("500000"), id: "x", realm: "r", method: "tempo", intent: "charge" }, context: {} }); } catch (e) { refusedErr = e; }
  ok(refusedErr && !/no RPC in this suite/.test(String(refusedErr.message)), `a dear challenge is refused before any client or signing work (${String(refusedErr?.message).slice(0, 80)})`);
  const { readFileSync } = await import("node:fs");
  for (const f of ["scripts/paid-canary.js", "scripts/tempo-volume.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const builds = src.match(/\b(?:mppTempo|tempo)\.charge\(\{[^)]*\}\)/g) || [];
    ok(builds.length > 0 && builds.every((b) => /\.\.\.tempoCappedChargeOptions\(/.test(b)), `${f}: every tempo/charge client it builds signs under the ceiling (${builds.length} found)`);
  }
}
console.log(`\n${pass} checks passed`);
process.exit(0);
