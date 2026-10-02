#!/usr/bin/env node
// A WARN-ONLY RAIL LEG MUST STILL PAGE WHEN THE FACILITATOR IS THE ONE REFUSING.
//
// Three paid-canary legs (Solana, Algorand, Robinhood) WARN instead of
// railFail() by design: "an unset or unfunded burner cannot open an issue".
// The premise was that every failure on those legs is our own wallet.
//
// 2026-09-21, run 35639815416: the Algorand leg got HTTP 402 with facilitator
// reason `subcent_quota_exceeded`. It recorded an outage to /status, printed
// WARN, and the run printed "all rail legs settled" and exited 0. The rail
// stayed refused all day, /status showed it, nothing paged. That morning the
// weekly Algorand sweep had failed the same way after 145 clean sub-cent
// settlements and been read as a generic outage.
//
// So: a funding/opt-in shaped reason keeps the designed WARN; anything else,
// including a reason we cannot classify, pages. Pinned both in the pure
// classifier and in the canary source, because the classifier being right is
// worthless if a leg does not call it.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { isFundingShapedRefusal, legRefusalVerdict } from "./canary-refusal-classify.js";

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };

// --- the live reason, verbatim ----------------------------------------------
eq(legRefusalVerdict("subcent_quota_exceeded"), "page", "the reason that went unpaged on 2026-09-21 PAGES");
eq(isFundingShapedRefusal("subcent_quota_exceeded"), false, "...because a facilitator quota is not our wallet's state");

// --- funding / opt-in shapes keep the designed WARN -------------------------
for (const r of [
  "insufficient_funds", "insufficient balance", "Insufficient-Funds",
  "unfunded", "asset not opted in", "not_opted_in", "receiver must opt-in",
  "no USDC balance", "below minimum balance", "balance too low", "would overspend",
]) eq(legRefusalVerdict(r), "warn", `funding-shaped reason stays WARN: ${JSON.stringify(r)}`);

// --- everything else pages, INCLUDING the unknown ----------------------------
for (const r of [
  "invalid_payload", "settle_exact_stellar_transaction_failed", "facilitator_error",
  "rate_limited", "unexpected_verify_error", "payment-method-required",
]) eq(legRefusalVerdict(r), "page", `a non-funding reason pages: ${JSON.stringify(r)}`);
eq(legRefusalVerdict(null), "page", "a MISSING reason pages - a refusal we cannot read is exactly the one a human should see");
eq(legRefusalVerdict(""), "page", "...and so does an empty one");
eq(legRefusalVerdict({ code: "quota", detail: "daily cap" }), "page", "an object reason with no funding words pages");
eq(legRefusalVerdict({ error: "insufficient funds for fee" }), "warn", "...and an object reason WITH funding words is read through JSON, not dropped");

// --- CONTROL: the two words that matter are actually decisive ----------------
ok(isFundingShapedRefusal("insufficient funds") && !isFundingShapedRefusal("sufficient funds"),
   "control: the matcher distinguishes insufficient from sufficient - it is not just matching 'funds'");

// --- the legs actually call it ---------------------------------------------
{
  const src = readFileSync(new URL("./paid-canary.js", import.meta.url), "utf8");
  ok(/import \{ legRefusalVerdict \} from "\.\/canary-refusal-classify\.js"/.test(src), "paid-canary imports the classifier rather than a local copy that can drift");
  for (const key of ["algorand", "solana", "robinhood"]) {
    ok(new RegExp(`railFail\\(\\s*"${key}"`).test(src), `${key} leg has a railFail path (it was WARN-only)`);
    // One level of nested parens allowed: the Solana leg passes
    // settleRejectReason(res.headers) straight in.
    ok(new RegExp(`legRefusalVerdict\\((?:[^()]|\\([^()]*\\))*\\)\\s*===\\s*"page"[\\s\\S]{0,400}railFail\\(\\s*"${key}"`).test(src),
       `${key} leg pages ONLY on the classifier's "page" verdict - the funding-shaped WARN the design wanted is preserved`);
    ok(new RegExp(`noteRail\\(\\s*"${key}",\\s*false`).test(src), `${key} leg still records a WARN-class failure to /status`);
  }
  // The stale design note that said these legs "must never page" is gone.
  ok(!/Algorand\/Robinhood are WARN-only by design \(their failures must never/.test(src),
     "the comment claiming these legs must never page no longer stands");
}

console.log(`\nOK: ${n} passed`);
