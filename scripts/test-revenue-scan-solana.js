// Unit tests for the Solana revenue scanner's decode + classification logic —
// the pure functions that turn a tx's pre/postTokenBalances into "who paid us
// how much" and decide what counts as an external x402 payment. No network.
import { usdcDeltaForOwner, payerFromMeta, isExternalPayment } from "./revenue-scan-solana.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const US = "AgentRevenueWa11etXXXXXXXXXXXXXXXXXXXXXXXXX";
const BUYER = "BuyerWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const bal = (owner, uiAmount, mint = USDC) => ({ owner, mint, uiTokenAmount: { uiAmount } });

// A canonical x402 SVM settlement: buyer's USDC down $0.005, ours up $0.005.
const settleMeta = {
  preTokenBalances: [bal(BUYER, 10), bal(US, 1)],
  postTokenBalances: [bal(BUYER, 9.995), bal(US, 1.005)],
};
ok(Math.abs(usdcDeltaForOwner(settleMeta, US) - 0.005) < 1e-9, "delta decodes +$0.005 incoming");
ok(Math.abs(usdcDeltaForOwner(settleMeta, BUYER) + 0.005) < 1e-9, "delta decodes -$0.005 for the buyer");
ok(payerFromMeta(settleMeta, US) === BUYER, "payer = owner whose USDC decreased");

// Outgoing transfer from us → delta negative, and we are not our own payer.
const outMeta = {
  preTokenBalances: [bal(US, 5), bal(BUYER, 0)],
  postTokenBalances: [bal(US, 3), bal(BUYER, 2)],
};
ok(usdcDeltaForOwner(outMeta, US) === -2, "outgoing delta is negative");
ok(payerFromMeta(outMeta, US) === null, "no payer when no one else's balance decreased");

// Non-USDC mints are ignored entirely.
const otherMint = {
  preTokenBalances: [bal(BUYER, 10, "SomeOtherMint1111111111111111111111111111111")],
  postTokenBalances: [bal(US, 10, "SomeOtherMint1111111111111111111111111111111")],
};
ok(usdcDeltaForOwner(otherMint, US) === 0, "other mints contribute nothing");
ok(payerFromMeta(otherMint, US) === null, "other mints yield no payer");

// New token account: no preTokenBalances entry for us (first-ever payment).
const firstPayment = {
  preTokenBalances: [bal(BUYER, 1)],
  postTokenBalances: [bal(BUYER, 0.999), bal(US, 0.001)],
};
ok(Math.abs(usdcDeltaForOwner(firstPayment, US) - 0.001) < 1e-9, "first payment to fresh token account decodes");
ok(payerFromMeta(firstPayment, US) === BUYER, "payer found on fresh token account");

// Multiple counterparties: the largest negative delta wins.
const multi = {
  preTokenBalances: [bal("Aaa", 5), bal("Bbb", 5), bal(US, 0)],
  postTokenBalances: [bal("Aaa", 4.9), bal("Bbb", 4.99), bal(US, 0.11)],
};
ok(payerFromMeta(multi, US) === "Aaa", "largest negative delta selected as payer");

// Degenerate meta.
ok(usdcDeltaForOwner(null, US) === 0, "null meta → 0 delta");
ok(payerFromMeta(undefined, US) === null, "undefined meta → null payer");

// Classification — same ceiling semantics as the Base scan.
const OURS = new Set(["OurBurnerWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"]);
const ext = (row) => isExternalPayment(row, { ourWallets: OURS, maxUsd: 0.5 });
ok(ext({ payer: BUYER, usd: 0.005 }) === true, "$0.005 from unknown wallet = external");
ok(ext({ payer: BUYER, usd: 1 }) === false, "$1 inbound excluded (over ceiling)");
ok(ext({ payer: "OurBurnerWa11etXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", usd: 0.005 }) === false, "our burner excluded");
ok(ext({ payer: null, usd: 0.005 }) === true, "unknown payer within range still counts (Solana meta can omit source)");
ok(ext({ payer: BUYER, usd: 0 }) === false, "zero amount excluded");
ok(ext(null) === false, "null row excluded");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
