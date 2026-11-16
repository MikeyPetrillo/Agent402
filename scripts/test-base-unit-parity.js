// One dollar price, one base-unit amount per token, on every rail.
//
//   1. The Tempo charge path end to end: a challenge minted by
//      mintTempoChallenge for a price is presented back to
//      checkTempoCredentialBinding for the same price, at 6, 7 and 18 token
//      decimals, over the first 20,000 micro-dollar prices and a sample of
//      them up to $0.20 and the catalog's own list prices. A buyer who pays exactly the
//      minted amount is never refused as below the route's price.
//   2. src/base-units.js on its own: for every decimals value a rail here
//      settles in (6 for USDC on every EVM chain, Solana and Algorand, 7 for
//      Stellar, the Tempo setting, any ERC-20 the refund proof reads up to 36),
//      the amount agrees with the x402 money parser the accepts use
//      (convertToTokenAmount) and scales exactly between any two decimals.
//   3. A source guard: no payment module turns dollars into base units with a
//      float multiplied by 10 ** decimals, 1e6 or 100 (the drift this suite pins).
// Offline: no relay, no chain, no store.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";
import { Challenge, Credential } from "mppx";
import { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";

process.env.TEMPO_API_KEY = "test-relay-key";
process.env.TEMPO_RECIPIENT_ADDRESS = "0x" + "7".repeat(40);
delete process.env.TEMPO_RELAY;
delete process.env.TEMPO_CURRENCY;
const SECRET = "parity-secret";
const REALM = "agent402.test";

const { mintTempoChallenge, checkTempoCredentialBinding } = await import("../src/mpp-tempo.js");
const { usdToBaseUnits, baseUnitsToDecimalString, usdToTokenDecimalString } = await import("../src/base-units.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

// ---- 1. Tempo: minted amount vs the gate's expected amount ------------------
const microPrices = [];
for (let micro = 1; micro <= 200_000; micro++) microPrices.push(micro / 1e6);
const listPrices = [0.0005, 0.001, 0.002, 0.003, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.05, 0.07, 0.1, 0.15, 0.25, 0.5, 0.99, 1, 1.5, 2.49, 4.99, 9.99, 19.99, 49];
function tempoRefusals(decimals, prices) {
  process.env.TEMPO_DECIMALS = String(decimals);
  const refused = [];
  for (const p of prices) {
    const header = mintTempoChallenge({ priceUsd: p, realm: REALM, secretKey: SECRET });
    if (!header) { refused.push({ p, reason: "no challenge minted" }); continue; }
    const challenge = Challenge.deserialize(header);
    const auth = Credential.serialize({ challenge, payload: { type: "transaction", signature: "0x" + "ab".repeat(70) } });
    const r = checkTempoCredentialBinding(auth, { secretKey: SECRET, realm: REALM, priceFor: () => ({ priceUsd: p }), method: "POST", path: "/api/x" });
    if (!r.ok && /below this route's price/.test(String(r.reason))) refused.push({ p, reason: r.reason, minted: challenge.request.amount });
    else if (!r.ok) refused.push({ p, reason: r.reason });
    else if (BigInt(challenge.request.amount) !== usdToBaseUnits(p, decimals)) refused.push({ p, reason: `minted ${challenge.request.amount}, not ${usdToBaseUnits(p, decimals)}` });
  }
  return refused;
}
{
  const sample18 = microPrices.filter((_, i) => i % 97 === 0 || i < 5000);
  const sampleWide = microPrices.filter((_, i) => i % 13 === 0 || i < 20000);
  for (const [d, prices] of [[6, sampleWide], [7, sampleWide], [18, sample18]]) {
    const all = [...prices, ...listPrices];
    const refused = tempoRefusals(d, all);
    ok(refused.length === 0, `Tempo at ${d} decimals: a credential paying exactly the minted amount is accepted for all ${all.length} prices (refused ${refused.length}${refused.length ? `, first ${refused[0].p}: ${refused[0].reason}` : ""})`);
  }
  // CONTROL: one base unit under the minted amount is still refused.
  process.env.TEMPO_DECIMALS = "18";
  const p = 0.00391;
  const ch = Challenge.deserialize(mintTempoChallenge({ priceUsd: p, realm: REALM, secretKey: SECRET }));
  ok(BigInt(ch.request.amount) === 3_910_000_000_000_000n, `the minted amount at 18 decimals is exact (${ch.request.amount})`);
  const short = Challenge.from({ ...ch, secretKey: SECRET, request: { ...ch.request, amount: String(BigInt(ch.request.amount) - 1n) } });
  const auth = Credential.serialize({ challenge: short, payload: { type: "transaction", signature: "0x" + "ab".repeat(70) } });
  const r = checkTempoCredentialBinding(auth, { secretKey: SECRET, realm: REALM, priceFor: () => ({ priceUsd: p }), method: "POST", path: "/api/x" });
  ok(!r.ok && /below this route's price/.test(String(r.reason)), `CONTROL: a challenge one base unit under the price is still refused (${r.reason})`);
  delete process.env.TEMPO_DECIMALS;
}

// ---- 2. The helper on every rail's decimals --------------------------------
{
  const RAIL_DECIMALS = [2, 6, 7, 8, 9, 12, 18, 24, 36];
  const places = (p) => (numberToDecimalString(p).split(".")[1] || "").length;
  let parserMismatch = 0, scaleMismatch = 0, firstBad = null;
  for (const p of [...microPrices, ...listPrices]) {
    for (const d of RAIL_DECIMALS) {
      if (places(p) > d) continue;
      const mine = usdToBaseUnits(p, d);
      if (mine !== BigInt(convertToTokenAmount(numberToDecimalString(p), d))) { parserMismatch++; firstBad ||= { p, d }; }
      for (const e of RAIL_DECIMALS) {
        if (e < d) continue;
        if (mine * 10n ** BigInt(e - d) !== usdToBaseUnits(p, e)) { scaleMismatch++; firstBad ||= { p, d, e }; }
      }
    }
  }
  ok(parserMismatch === 0, `every price agrees with the x402 money parser at every rail's decimals (mismatches ${parserMismatch}${firstBad ? ` first ${JSON.stringify(firstBad)}` : ""})`);
  ok(scaleMismatch === 0, `every price scales exactly between any two decimals (mismatches ${scaleMismatch})`);
  ok(usdToBaseUnits("$0.003", 7) === 30_000n && usdToBaseUnits("0.003", 18) === 3_000_000_000_000_000n, "a dollar label and a decimal string read the same as the number");
  ok(usdToBaseUnits(0.0000125, 6) === 13n && usdToBaseUnits(0.0000124, 6) === 12n, "more places than the token rounds half up at its last place");
  ok(usdToBaseUnits(1e-7, 7) === 1n && usdToBaseUnits(1e21, 6) === 10n ** 27n, "a number JavaScript prints with an exponent is read exactly");
  ok(baseUnitsToDecimalString(3000n, 6) === "0.003000" && baseUnitsToDecimalString(5n, 0) === "5" && usdToTokenDecimalString(4.99, 18) === "4.990000000000000000", "base units spell back as a decimal with the token's places");
  let threw = 0;
  for (const bad of [NaN, -1, Infinity, "abc", "1e-7", null, undefined, {}]) { try { usdToBaseUnits(bad, 6); } catch (e) { if (e instanceof RangeError) threw++; } }
  ok(threw === 8, `an amount that is not a dollar figure throws RangeError (${threw}/8)`);
}

// ---- 3. Source guard --------------------------------------------------------
{
  // A dollar figure times 10 ** decimals, 1e6 (USDC) or 100 (cents) in float
  // math, or a float's own toFixed at the token's places, is the drift.
  const FILES = ["src/mpp-tempo.js", "src/mpp-subscriptions.js", "src/payment-verify.js", "src/pages.js", "src/mpp-stripe.js"];
  const FLOAT_SCALE = /(?:Math\.round|BigInt)\([^;\n]*\*\s*(?:10\s*\*\*|Math\.pow\(10|1e[67]\b|100\b)|\*\s*1e6\b|\.toFixed\((?:decimals|envDecimals\(\))\)/;
  const hits = [];
  for (const f of FILES) {
    readFileSync(new URL(`../${f}`, import.meta.url), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (FLOAT_SCALE.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  ok(hits.length === 0, `no payment module scales dollars to base units with float math (${hits.join(", ") || "none"})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
