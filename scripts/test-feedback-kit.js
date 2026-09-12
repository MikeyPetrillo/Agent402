#!/usr/bin/env node
// Feedback: a verdict on a call, written by the wallet that paid for it.
//
// The whole product is the credential. Two properties carry it and both are
// pinned here:
//
//   1. THE RECEIPT IS THE RIGHT TO SPEAK. The wallet comes from the verified
//      EIP-3009 authorization and the sale row says who paid. A `wallet` in the
//      body must change nothing, and a stranger must learn nothing about
//      whether a transaction is even ours.
//
//   2. ONE PAYMENT, ONE VERDICT. A buyer may change their mind; they may not
//      stack five ratings on one call. That is the cheapest way to distort any
//      review system and it has to be structurally impossible, not discouraged.
//
// And the tally must never become a customer list: counts only, no addresses,
// no review text.
//
// Offline: the ledger is driven directly with a temp database.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-feedback-"));
process.env.SALES_LEDGER_DB = join(dir, "sales.db");

const { recordSale, feedbackForTx, feedbackByTool, badFeedback } = await import("../src/sales-ledger.js");
const { FEEDBACK_TOOLS, makeFeedbackHandler } = await import("../src/tools/feedback-kit.js");
const { isIdentityBoundRoute } = await import("../src/payments.js");

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

const MINE = "0xaaaa000000000000000000000000000000000001";
const THEIRS = "0xbbbb000000000000000000000000000000000002";
const DIGEST = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";

const write = FEEDBACK_TOOLS.find((t) => t.slug === "feedback");
const summary = FEEDBACK_TOOLS.find((t) => t.slug === "feedback-summary");
ok(write && summary, "both tools exist");

// --- the write route must be identity-bound ---------------------------------
ok(isIdentityBoundRoute(write), "feedback is identity-bound: it advertises EVM exact only, so a buyer on a rail whose payer we cannot verify is never charged for a call the server must then refuse");
ok(!isIdentityBoundRoute(summary), "the TALLY is not identity-bound: counts are public and anyone may read them");

recordSale({ slug: "crypto-price", priceUsd: 0.01, rail: "usdc", network: "base", payer: MINE, tx: "0xtx1", responseSha256: DIGEST });
recordSale({ slug: "crypto-price", priceUsd: 0.01, rail: "usdc", network: "base", payer: THEIRS, tx: "0xtx2", responseSha256: DIGEST });
recordSale({ slug: "research", priceUsd: 0.6, rail: "usdc", network: "base", payer: MINE, tx: "0xtx3" });

// The handler under test, with the payer supplied the way the paywall does.
const logged = [];
const handler = makeFeedbackHandler({ payerOf: (req) => req?.__payer || null, log: (m) => logged.push(m) });
const as = (payer) => ({ __payer: payer, headers: {} });
const err = (p) => p.then((v) => v, (e) => e);

// --- 1. the buyer of that call can write ------------------------------------
{
  const out = await handler({ tx: "0xtx1", verdict: "good" }, as(MINE));
  eq(out.recorded, true, "the buyer's verdict is recorded");
  eq(out.replaced, false, "a first verdict replaces nothing");
  eq(out.item, "crypto-price", "the tool rated is named back");
  eq(out.responseSha256, DIGEST, "the digest of the bytes that call served rides on the receipt - the verdict is about a specific answer, not a vibe");
  eq(feedbackForTx("0xtx1").verdict, "good", "and it is in the ledger");
}

// --- 2. nobody else can ------------------------------------------------------
{
  const mine = await err(handler({ tx: "0xtx2", verdict: "bad", reason: "it returned nothing at all" }, as(MINE)));
  ok(mine instanceof Error && mine.statusCode === 403, "a wallet cannot rate a call another wallet paid for");
  const unknown = await err(handler({ tx: "0xdoesnotexist", verdict: "good" }, as(MINE)));
  ok(unknown instanceof Error && unknown.statusCode === 403, "an unknown transaction is refused");
  eq(mine.message.replace("0xtx2", "T"), unknown.message.replace("0xdoesnotexist", "T"),
     "and the two refusals are the SAME sentence: a stranger must not learn whether a transaction is ours, or what it bought");
  eq(feedbackForTx("0xtx2"), null, "nothing was written for someone else's call");

  const noPayer = await err(handler({ tx: "0xtx1", verdict: "good" }, as(null)));
  ok(noPayer instanceof Error && noPayer.statusCode === 403, "with no verifiable payer the handler REFUSES");
  const noPayerButAsked = await err(handler({ tx: "0xtx1", verdict: "good", wallet: MINE, payer: MINE }, as(null)));
  ok(noPayerButAsked instanceof Error && noPayerButAsked.statusCode === 403,
     "...and it does NOT fall back to a wallet named in the body when the signature carries none - that fallback would make the route writable as anyone");

  // A refusal must not leak the sale either: naming the tool would tell a
  // stranger what any transaction they can find bought.
  ok(!/crypto-price/.test(mine.message), "the refusal does not name the tool the transaction bought");

  // The assertion that keeps this from becoming a write-as-anyone endpoint.
  const spoof = await err(handler({ tx: "0xtx2", verdict: "good", wallet: THEIRS, payer: THEIRS, from: THEIRS }, as(MINE)));
  ok(spoof instanceof Error && spoof.statusCode === 403, "naming the real payer in the BODY changes nothing - identity comes from the signature only");
  eq(feedbackForTx("0xtx2"), null, "and still nothing was written");
}

// --- 3. one payment, one verdict --------------------------------------------
{
  const again = await handler({ tx: "0xtx1", verdict: "bad", reason: "on reflection the price was stale by an hour" }, as(MINE));
  eq(again.replaced, true, "a second verdict on the same call SAYS it replaced the first");
  eq(feedbackForTx("0xtx1").verdict, "bad", "and the ledger holds one row, now bad");
  const t = feedbackByTool({ days: 90 }).find((x) => x.slug === "crypto-price");
  eq(t.total, 1, "the tally counts ONE verdict for that call, not two - stacking is what a rating system has to make impossible");
  await handler({ tx: "0xtx1", verdict: "good" }, as(MINE));
  eq(feedbackForTx("0xtx1").reason, null, "changing the verdict clears the old reason rather than leaving words that no longer match it");
}

// --- 4. what a verdict must say ---------------------------------------------
{
  for (const v of [undefined, "", "great", "5", 4, "GOOD "]) {
    const e = await err(handler({ tx: "0xtx1", verdict: v }, as(MINE)));
    if (String(v).trim().toLowerCase() === "good") { ok(!(e instanceof Error), "case and surrounding space are tolerated on a real verdict"); continue; }
    ok(e instanceof Error && e.statusCode === 400, `"${v}" is not a verdict`);
  }
  const noReason = await err(handler({ tx: "0xtx3", verdict: "bad" }, as(MINE)));
  ok(noReason instanceof Error && noReason.statusCode === 400, "a BAD verdict with no words is refused: a count nobody can act on is not worth charging for");
  const thin = await err(handler({ tx: "0xtx3", verdict: "bad", reason: "bad" }, as(MINE)));
  ok(thin instanceof Error, "...and neither is a token one");
  ok(/reason/i.test(noReason.message) && /Nothing was charged/.test(noReason.message), "the refusal says what is missing and that it was free");
  const long = await err(handler({ tx: "0xtx3", verdict: "good", reason: "x".repeat(1001) }, as(MINE)));
  ok(long instanceof Error && long.statusCode === 400, "reason length is bounded - it is stored and later read by a person");
  const noTx = await err(handler({ verdict: "good" }, as(MINE)));
  ok(noTx instanceof Error && noTx.statusCode === 400, "a verdict with no transaction is not a receipt-bound verdict at all");
}

// --- 5. a bad verdict is made VISIBLE, with the bytes it is about ------------
{
  logged.length = 0;
  await handler({ tx: "0xtx3", verdict: "bad", reason: "the report cited one source and called it research" }, as(MINE));
  eq(logged.length, 1, "a bad verdict is logged for a human - collecting complaints nobody reads is how the last one sat unread for eleven days");
  ok(/research/.test(logged[0]) && /0xtx3/.test(logged[0]), "the log names the tool and the settlement transaction");
  ok(/cited one source/.test(logged[0]), "and the buyer's own words");
  logged.length = 0;
  await handler({ tx: "0xtx1", verdict: "good", reason: "fine" }, as(MINE));
  eq(logged.length, 0, "a good verdict pages nobody");
}

// --- 6. the tally is counts, and never a customer list -----------------------
{
  recordSale({ slug: "crypto-price", priceUsd: 0.01, rail: "usdc", network: "base", payer: THEIRS, tx: "0xtx4", responseSha256: DIGEST });
  await handler({ tx: "0xtx2", verdict: "good" }, as(THEIRS));
  await handler({ tx: "0xtx4", verdict: "good" }, as(THEIRS));

  const out = await summary.handler({ days: 90 });
  const cp = out.tools.find((t) => t.slug === "crypto-price");
  eq(cp.good, 3, "good counts");
  eq(cp.raters, 2, "`raters` is DISTINCT wallets: two verdicts from one wallet is one opinion, and a tally that cannot say so is one anybody can buy");
  eq(out.totals.bad, 1, "bad counts are published beside good ones, including our own");

  const json = JSON.stringify(out);
  ok(!json.includes(MINE) && !json.includes(THEIRS), "no payer address appears anywhere in the tally");
  ok(!/cited one source/.test(json), "and no review text: the buyer's words go to the operator, never to a public feed");

  eq((await summary.handler({ days: 90, slug: "research" })).tools.length, 1, "the tally can be narrowed to one tool");
  const empty = await summary.handler({ days: 1, slug: "no-such-tool" });
  eq(empty.tools, [], "an unrated tool is an empty list, not a missing field");
  ok(/absence of ratings, not a clean record/.test(empty.note), "and the empty case says what it means - no ratings is not a good score");
  for (const d of [0, -1, "x", 4000]) ok((await err(summary.handler({ days: d }))) instanceof Error, `days=${d} is refused rather than silently defaulted`);
}

// --- 7. the operator view carries the complaint AND the bytes complained about
{
  const bad_ = badFeedback({ days: 30 });
  const row = bad_.find((r) => r.settlementTx === "0xtx3");
  ok(row, "a bad verdict appears in the operator view");
  eq(row.item, "research", "named by tool");
  ok(/cited one source/.test(row.reason), "with the buyer's own words, which live here and nowhere public");
  ok("responseSha256" in row, "and the digest of the bytes served, so the operator can identify the exact answer (null when none was recorded)");
  ok(!bad_.some((r) => r.settlementTx === "0xtx1"), "a verdict later changed to good is no longer a complaint");
  ok(!JSON.stringify(bad_).includes(MINE), "no payer address: the complaint is what needs acting on");
}

rmSync(dir, { recursive: true, force: true });
console.log(`test-feedback-kit: ${n} assertions OK`);
