#!/usr/bin/env node
// A SETTLEMENT COUNTS WHEN THE SELLER PUBLISHES THAT PRICE.
//
// The fold kept a transfer only when it was under a flat MAX_CALL_USD ceiling
// ($0.75), on the reasoning that "bigger transfers are funding/swaps, not tool
// buys". True when every x402 tool cost a fraction of a cent; false now.
//
// MEASURED 2026-09-21 against a curated list of seven active services over the
// same 7-day window this board scans: SIX were absent from our board entirely,
// and every one of the six has an average transfer above the ceiling. One
// missed by four cents - 27,590 transactions and 715 buyers at $0.79 each. We
// were not ranking them low. We could not see them.
//
// The ceiling was not simply wrong, which is why the fix is not a bigger
// number. Some of those services convert stablecoins or sell gift cards, so
// their volume is value moved rather than a fee, and folding it in would make
// this a table of money-moved labelled as API revenue. The ceiling aimed at
// that and hit everything else.
//
// So the rule reads the seller's own listing: a transfer equal to a price they
// advertise is a purchase at any size, and anything matching nothing is still
// held to the ceiling.
//
//   node scripts/test-leaderboard-price-match.js
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { aggregateLeaderboard, priceMatches, advertisedMicroUsd, DEFAULTS } from "../src/leaderboard.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };

const seller = (prices) => [{
  wallet: "0xa", network: "base", name: "S",
  origins: ["https://s.example"], homepage: "https://s.example",
  endpoints: 1, prices: new Set(prices),
}];
const t = (usd, payer) => ({ wallet: "0xa", usd, payer });
const row = (prices, transfers) => aggregateLeaderboard(transfers, seller(prices))[0];

// --- the ceiling still governs a wallet we cannot read -----------------------
{
  const r = row([], [t(0.50, "0xp1"), t(5.00, "0xp2")]);
  eq(r.callsSettled, 1, "with NO advertised prices the old ceiling is the whole rule");
  eq(r.transfersSkippedOverCeiling, 1, "...and the drop is counted rather than silent");
  ok(DEFAULTS.maxCallUsd === 0.75, "control: the ceiling under test is the one in production");
}

// --- a published price is admitted above the flat ceiling ---------------------
{
  // $2.00 listed. 2.00 exact, 2.01 a premium-chain rounding, 0.50 under the
  // ceiling on its own merits, 1000 matching nothing.
  const r = row([2_000_000], [t(2.00, "0xp1"), t(2.01, "0xp2"), t(0.50, "0xp3"), t(1000, "0xp4")]);
  eq(r.callsSettled, 3, "three of four counted: both purchases at the listed price, plus the sub-ceiling one");
  eq(Number(r.totalUsd.toFixed(2)), 4.51, "...and the dollars are the three admitted transfers, not the $1,000");
  eq(r.uniqueBuyers, 3, "...with one buyer per admitted transfer");
  eq(r.settlementsAbovePerCallCeiling, 2, "two were admitted ONLY because they matched a published price");
  eq(r.transfersSkippedOverCeiling, 1, "...and the transfer matching no listing is still dropped");
}

// --- THE CASE THAT STARTED THIS --------------------------------------------
//
// $0.79 a call, which the ceiling misses by four cents. Before this change a
// seller like that contributed nothing at all.
{
  const price = 790_000;
  const many = Array.from({ length: 50 }, (_, i) => t(0.79, `0xp${i}`));
  const r = row([price], many);
  eq(r.callsSettled, 50, "a seller priced four cents over the ceiling is fully counted");
  eq(r.uniqueBuyers, 50, "...and every distinct buyer is seen");
  // And the control in the other direction: without the rule, nothing.
  const blind = aggregateLeaderboard(many, seller([]))[0];
  eq(blind.callsSettled, 0, "control: with no published price to match, that same seller reads zero - which is what the board did");
}

// --- underpaying is not buying ---------------------------------------------
{
  const r = row([2_000_000], [t(1.99, "0xp1")]);
  eq(r.callsSettled, 0, "a transfer BELOW the published price is not a purchase at it");
  eq(r.transfersSkippedOverCeiling, 1, "...and it is counted as dropped");
}

// --- the tolerance is bounded ----------------------------------------------
{
  ok(priceMatches(2_000_000, new Set([2_000_000])), "exact matches");
  ok(priceMatches(2_010_000, new Set([2_000_000])), "a cent over matches (premium chains quote above list)");
  ok(!priceMatches(2_100_000, new Set([2_000_000])), "ten cents over a $2 listing does NOT match - the window is 1c or 2%, whichever is larger");
  ok(!priceMatches(1_000_000_000, new Set([990_000])), "a $1,000 transfer cannot match a $0.99 listing, which is the whole reason for a bound");
  ok(priceMatches(1_020_000, new Set([1_000_000])), "2% of a dollar-scale price is allowed");
  ok(!priceMatches(2_000_000, new Set()), "no prices means no match, never a match against nothing");
  ok(!priceMatches(NaN, new Set([1])), "a NaN amount never matches");
}

// --- the price-match rule is itself bounded ----------------------------------
//
// A wallet that publishes $1,000 (a gift card, a stablecoin conversion) would
// otherwise count every $1,000 transfer as a tool call, on a board whose default
// sort is dollars. Measured live the day the rule shipped: five matched transfers
// above the ceiling supplied ~$5,000 of one seller's $5,072 row.
{
  const r = row([1_000_000_000, 2_000_000], [t(1000, "0xg1"), t(1000, "0xg2"), t(2.00, "0xg3")]);
  eq(r.callsSettled, 1, "the $1,000 transfers are dropped although the price is published; the $2 one counts");
  eq(r.transfersSkippedOverCeiling, 2, "...and they are reported as skipped over the ceiling");
  eq(r.settlementsAbovePerCallCeiling, 1, "...while the $2 match above the flat ceiling is still admitted");
  const wide = aggregateLeaderboard([t(1000, "0xg1")], seller([1_000_000_000]), { priceMatchMaxUsd: 5000 })[0];
  eq(wide.callsSettled, 1, "the bound is a parameter: raised, the same transfer counts");
  ok(DEFAULTS.priceMatchMaxUsd >= 1 && DEFAULTS.priceMatchMaxUsd <= 100, `the default bound (${DEFAULTS.priceMatchMaxUsd}) sits between a tool price and a gift card`);
}

// --- the served snapshot carries the ceiling it applied -----------------------
//
// The first cut stamped priceMatchMaxUsd on the EMPTY snapshot only; the real
// result object omitted it, so the cap applied while /api/leaderboard and the
// page sentence that prints it read nothing (measured live 2026-09-22 11:10Z).
{
  const src = readFileSync(new URL("../src/leaderboard.js", import.meta.url), "utf8");
  const result = src.slice(src.indexOf("const ranked = finalizeLeaderboard(byWallet"), src.indexOf("const ranked = finalizeLeaderboard(byWallet") + 1500);
  ok(/maxCallUsd: opts\.maxCallUsd,\s*\n\s*priceMatchMaxUsd: opts\.priceMatchMaxUsd,/.test(result), "the built snapshot carries priceMatchMaxUsd beside maxCallUsd");
  const empty = src.slice(src.indexOf("const emptySnapshot"), src.indexOf("const emptySnapshot") + 600);
  ok(/priceMatchMaxUsd: opts\.priceMatchMaxUsd/.test(empty), "...and so does the empty snapshot");
}

// --- reading a price off a listing ------------------------------------------
{
  const BASE = "eip155:8453", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const item = (accepts) => ({ accepts });
  eq(advertisedMicroUsd(item([{ network: BASE, asset: USDC, amount: "50000" }])), 50_000, "reads `amount` in base units, which for 6-decimal USDC are micro-dollars");
  eq(advertisedMicroUsd(item([{ network: BASE, asset: USDC, maxAmountRequired: "50000" }])), 50_000, "...and the v1 field name too");
  eq(advertisedMicroUsd(item([{ network: "eip155:1", asset: USDC, amount: "50000" }])), null, "a listing on another chain declares nothing about this scan");
  eq(advertisedMicroUsd(item([{ network: BASE, asset: USDC, amount: "0" }])), null, "zero is not a price");
  eq(advertisedMicroUsd(item([{ network: BASE, asset: USDC, amount: "1.5" }])), null, "a non-integer base amount is unreadable, and an unreadable price must never ADMIT a transfer");
  eq(advertisedMicroUsd(item([])), null, "no accepts, no price");
}

console.log(`\nOK: ${n} passed`);
