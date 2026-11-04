#!/usr/bin/env node
// The cheap EVM token-safety verdict, offline.
//
//   node scripts/test-token-safety.js
//
// Why the tool exists: our only EVM answer to "is this token safe to trade" was
// token-risk at $0.60, an LLM-synthesised report - the wrong shape and price for
// a pre-trade check an agent makes in one call. Solana already had
// sol-token-safety at $0.005; EVM had nothing under sixty cents, and a seller
// running the SAME keyless GoPlus leg sells it at $0.01.
//
// What this pins is the judgement, not the upstream: the verdict is derived from
// named facts, and an UNANSWERED check is never counted as safe. The first cut
// broke that rule with `(g.sellTaxPct ?? 0)`, which read "upstream did not say"
// as "zero tax" - caught by writing this table.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { safetyVerdict } from "../src/tools/token-safety-kit.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const clean = { honeypot: false, openSource: true, mintable: false, hiddenOwner: false,
  blacklist: false, transferPausable: false, buyTaxPct: 0, sellTaxPct: 0 };

// --- blocking: things that take the buyer's money outright -----------------
for (const [label, g] of [
  ["a honeypot", { ...clean, honeypot: true }],
  ["cannot sell the full balance", { ...clean, cannotSellAll: true }],
  ["buying blocked", { ...clean, cannotBuy: true }],
  ["a counterfeit of another token", { ...clean, fakeToken: { value: true } }],
  ["a 60% sell tax", { ...clean, sellTaxPct: 60 }],
]) {
  const v = safetyVerdict(g);
  ok(v.verdict === "unsafe", `${label} is unsafe (got ${v.verdict}: ${v.because})`);
  ok(v.blocking.length > 0, `...and says which fact blocked it`);
}

// --- caution: powers an owner COULD use, but has not ------------------------
for (const [label, g] of [
  ["mintable supply", { ...clean, mintable: true }],
  ["a hidden owner", { ...clean, hiddenOwner: true }],
  ["reclaimable ownership", { ...clean, canTakeBackOwnership: true }],
  ["pausable transfers", { ...clean, transferPausable: true }],
  ["an unverified source", { ...clean, openSource: false }],
  ["an upgradeable proxy", { ...clean, proxy: true }],
]) {
  const v = safetyVerdict(g);
  ok(v.verdict === "caution", `${label} is caution, not unsafe (got ${v.verdict})`);
}

// --- ok, and the rule that makes it trustworthy -----------------------------
{
  const v = safetyVerdict(clean);
  ok(v.verdict === "ok" && !v.blocking.length && !v.warnings.length, "a clean token is ok");

  // THE RULE: an unanswered check is UNKNOWN, never safe. `(x ?? 0)` quietly
  // broke this - a null sell tax compared as 0 and passed every threshold.
  const thin = safetyVerdict({ honeypot: false, sellTaxPct: null, buyTaxPct: null });
  ok(thin.unknown.includes("sell tax") && thin.unknown.includes("buy tax"),
     `an unanswered tax is listed as unknown, not treated as zero (got ${JSON.stringify(thin.unknown)})`);
  ok(/unanswered/.test(thin.because),
     "...and the headline says some checks went unanswered rather than implying a clean bill");
  const hugeNull = safetyVerdict({ ...clean, sellTaxPct: null });
  ok(!hugeNull.blocking.some((b) => /sell tax/.test(b)), "a null tax never fabricates a tax finding");
}

// --- no score, on purpose ---------------------------------------------------
{
  const v = safetyVerdict(clean);
  ok(!("score" in v) && !("rating" in v),
     "the verdict carries no number: a score invites a ranking, and a ranking over vendor flags reads as a measurement we did not make");
}

console.log(`test-token-safety: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
