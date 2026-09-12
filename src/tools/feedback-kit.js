// feedback-kit - `POST /api/feedback`: a verdict on a call you actually paid for.
//
// Ratings are worth exactly as much as the credential behind them. Anywhere a
// review can be written by anyone, the ratings drift toward whoever cares most
// about the number, and everybody reading them knows it. Here the credential is
// a settlement transaction: the ledger records who paid for each call, so a row
// can only be written by that wallet, about that call, once.
//
// WHAT WE HOLD THAT A PAYMENT ALONE DOES NOT. The dispatcher records sha256 of
// the exact JSON bytes served (`response_sha256` on the sale row, see attest-kit).
// So a verdict here is not only bound to "money moved" - it is bound to a
// specific set of DELIVERED BYTES we can still identify. A buyer saying "this
// answer was empty" names a digest, and the same digest is what they can hash
// their own copy against. That is what makes a complaint actionable instead of
// an opinion, and it is why the digest rides on the receipt this returns.
//
// WHY IT COSTS $0.001. Not to discourage complaints - the fee is the facilitator's
// own settlement floor, and it is here because the PAYMENT IS THE IDENTITY: the
// signed EIP-3009 authorization is how the server knows which wallet is speaking.
// There is no cheaper way to authenticate a buyer who has no account. Refusals
// are free (a >= 400 cancels settlement), so a rejected verdict costs nothing.
//
// WHAT IT IS NOT: it is not a star rating, not a public review feed, and not a
// reputation score. Two verdicts and a tally of counts. See recordSaleFeedback
// in sales-ledger.js for why two, and feedbackByTool for why counts only.
import { saleByTx, recordSaleFeedback, feedbackForTx, feedbackByTool } from "../sales-ledger.js";
import { payerFromRequest } from "../payer.js";

const MAX_REASON = 1000;

function bad(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

const normalizeTx = (v) => String(v || "").trim();

/**
 * The write handler, with the ledger injected so the whole decision path runs
 * offline in a test with a temp database.
 */
export function makeFeedbackHandler(deps = {}) {
  const lookup = deps.saleByTx || saleByTx;
  const record = deps.recordSaleFeedback || recordSaleFeedback;
  const existing = deps.feedbackForTx || feedbackForTx;
  const payerOf = deps.payerOf || payerFromRequest;
  const log = deps.log || console.warn;

  return async (input, req) => {
    const tx = normalizeTx(input?.tx);
    if (!tx) throw bad('Provide "tx": the settlement transaction from the PAYMENT-RESPONSE (or Payment-Receipt) header of the call you are reporting on.', 400);

    const verdict = String(input?.verdict ?? "").trim().toLowerCase();
    if (verdict !== "good" && verdict !== "bad") {
      throw bad('"verdict" must be "good" (the call delivered what it promised) or "bad" (it did not). Deliberately two values: a star scale averages into a number that looks like a measurement and is not one.', 400);
    }

    // Reason is optional on "good" and REQUIRED on "bad". A bad verdict with no
    // words is a number we can publish and cannot act on, and acting on it is
    // the entire point of collecting it.
    const reason = input?.reason === undefined || input?.reason === null ? "" : String(input.reason).trim();
    if (verdict === "bad" && reason.length < 10) {
      throw bad('A "bad" verdict needs a "reason" of at least 10 characters saying what went wrong. Without it there is nothing to fix, and a count nobody can act on is not worth charging you for. Nothing was charged.', 400);
    }
    if (reason.length > MAX_REASON) throw bad(`"reason" is limited to ${MAX_REASON} characters.`, 400);

    // Who is asking. The route is identity-bound (EVM exact only, like attest
    // and receipts), so a signed payer is always derivable here and a buyer on
    // a rail we cannot read was never offered the route, never charged.
    const caller = payerOf(req);
    if (!caller) {
      throw bad("Feedback is bound to the wallet that PAID for the call being rated, so this call must itself be paid with a signed EVM authorization from that wallet. Nothing was charged.", 403);
    }

    const sale = lookup(tx);
    // The two refusals below are deliberately the same sentence: a wallet that
    // did not buy the call learns nothing about whether the transaction is ours
    // or what it bought. Same rule as attest - only the buyer sees detail.
    const notYours = () => bad(`No settled call of yours was found for transaction ${tx}. Feedback covers calls this wallet paid for on this server; use the hash from your own receipt. Nothing was charged.`, 403);
    if (!sale) throw notYours();
    if (!sale.payer || String(sale.payer).toLowerCase() !== String(caller).toLowerCase()) throw notYours();

    const prior = existing(tx);
    const row = record({ tx, saleId: sale.id, slug: sale.slug, payer: caller, verdict, reason: reason || null });
    if (!row) throw bad("The verdict could not be recorded. Nothing was charged.", 500);

    // A bad verdict is a buyer telling us something is broken, and that has one
    // job: to be SEEN. It goes to the log with the slug and the digest of the
    // bytes they were served, so an operator can identify the exact response
    // being complained about instead of guessing from a timestamp.
    if (verdict === "bad") {
      log(`[feedback] BAD verdict on ${sale.slug} (tx ${tx}, digest ${sale.responseSha256 || "none recorded"}): ${reason}`);
    }

    return {
      recorded: true,
      replaced: !!prior,
      item: sale.slug,
      verdict,
      settlementTx: tx,
      settledAt: new Date(sale.ts).toISOString(),
      amountUsd: sale.priceUsd,
      // The bytes the verdict is ABOUT. Hash your own copy of that response and
      // compare: if the digests differ, you are not rating the answer we served.
      responseSha256: sale.responseSha256 || null,
      note: sale.responseSha256
        ? "responseSha256 is sha256 over the exact JSON bytes that call returned. It identifies the answer your verdict is about."
        : "That call was a streamed or binary response, so no digest of the delivered bytes was recorded. The verdict still stands against the payment.",
    };
  };
}

export function makeFeedbackSummaryHandler(deps = {}) {
  const tally = deps.feedbackByTool || feedbackByTool;
  return async (input) => {
    const days = input?.days === undefined ? 90 : parseInt(input.days, 10);
    if (Number.isNaN(days) || days < 1 || days > 3650) throw bad('"days" must be an integer between 1 and 3650 (default 90).', 400);
    const slug = input?.slug ? String(input.slug).trim() : null;
    let tools = tally({ days });
    if (slug) tools = tools.filter((t) => t.slug === slug);
    const good = tools.reduce((n, t) => n + t.good, 0);
    const bad_ = tools.reduce((n, t) => n + t.bad, 0);
    return {
      windowDays: days,
      tools,
      totals: { good, bad: bad_, total: good + bad_, tools: tools.length },
      // An honest empty: nobody has rated anything in the window, which is not
      // the same as everything being rated well.
      note: tools.length
        ? "Counts only. Every verdict was written by the wallet that paid for that call, one per settlement transaction. `raters` is distinct wallets: ten verdicts from one wallet is one opinion. Who said what, and their words, are never published."
        : "No verdicts were recorded in this window. That is an absence of ratings, not a clean record.",
    };
  };
}

export const FEEDBACK_TOOLS = [
  {
    route: "POST /api/feedback",
    name: "Rate a call you paid for",
    slug: "feedback",
    category: "payments",
    price: "$0.001",
    description:
      "Tell this server whether a call you paid for delivered what it promised. Bound to the receipt: give it the settlement transaction from that call's PAYMENT-RESPONSE (or Payment-Receipt) header and a verdict of \"good\" or \"bad\", and only the wallet the ledger records as having paid for that exact call can write it - so a rating here is always a real customer about a real purchase. One verdict per settlement transaction (sending another replaces yours, it never stacks). A \"bad\" verdict requires a reason of at least ten characters and is logged for a human with the sha256 of the bytes that call actually served, so the complaint names a specific answer rather than a bad day. Your words are stored for the operator and are never published; the public tally is counts only. Requires an EIP-3009 payment from the same wallet; the $0.001 is the settlement floor, not a charge for complaining, and every refusal is free.",
    tags: ["feedback", "rating", "receipt", "reputation", "quality", "x402"],
    aliases: ["rate", "review", "report-issue", "verdict"],
    discovery: {
      bodyType: "json",
      input: { tx: "0x2f1fecade9bd945e7817c11e5a34cafe6b349dd8c92a7587efed1de476bddfeb", verdict: "good" },
      inputSchema: {
        properties: {
          tx: { type: "string", description: "Settlement transaction of the call you are rating, as carried in that response's PAYMENT-RESPONSE (x402) or Payment-Receipt (MPP) header." },
          verdict: { type: "string", description: '"good" (it delivered what it promised) or "bad" (it did not).' },
          reason: { type: "string", description: "What happened, in your own words. Optional on \"good\", required on \"bad\" (10 characters minimum, 1000 maximum). Stored for the operator, never published." },
        },
        required: ["tx", "verdict"],
      },
      output: {
        example: {
          recorded: true,
          replaced: false,
          item: "crypto-price",
          verdict: "good",
          settlementTx: "0x2f1fecade9bd945e7817c11e5a34cafe6b349dd8c92a7587efed1de476bddfeb",
          settledAt: "2026-09-03T15:16:06.000Z",
          amountUsd: 0.01,
          responseSha256: "7d2a9b1c4e6f8a0b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b",
          note: "responseSha256 is sha256 over the exact JSON bytes that call returned. It identifies the answer your verdict is about.",
        },
      },
    },
    handler: makeFeedbackHandler(),
  },
  {
    route: "GET /api/feedback/summary",
    name: "Feedback tally by tool",
    slug: "feedback-summary",
    category: "payments",
    price: "$0.001",
    description:
      "What paying buyers said about each tool on this server: good and bad counts and the number of distinct wallets behind them, over a window you choose. Every verdict counted here was written by the wallet that paid for that specific call, one per settlement transaction, so the numbers cannot be inflated by anyone who did not buy. Counts only - no payer addresses and no review text, ever. Bad counts are published beside good ones, including ours.",
    tags: ["feedback", "ratings", "quality", "reliability", "stats"],
    aliases: ["ratings", "reviews", "tool-quality"],
    discovery: {
      input: { days: 90 },
      inputSchema: {
        properties: {
          days: { type: "number", description: "Window in days, 1-3650 (default 90)." },
          slug: { type: "string", description: "Limit the tally to one tool slug." },
        },
        required: [],
      },
      output: {
        example: {
          windowDays: 90,
          tools: [
            { slug: "crypto-price", good: 14, bad: 1, total: 15, raters: 9 },
            { slug: "research", good: 3, bad: 0, total: 3, raters: 3 },
          ],
          totals: { good: 17, bad: 1, total: 18, tools: 2 },
          note: "Counts only. Every verdict was written by the wallet that paid for that call, one per settlement transaction. `raters` is distinct wallets: ten verdicts from one wallet is one opinion. Who said what, and their words, are never published.",
        },
      },
    },
    handler: makeFeedbackSummaryHandler(),
  },
];
