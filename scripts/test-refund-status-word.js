// The refund status word (src/refund-status-word.js): one rule for every
// answer that names a refund row's status. A row held as blocked reads
// `held` on the lookup and on every refused payment's answer; anything else
// unknown reads `owed`. The class guard: no module under src/ maps the words
// on its own (an inline ["owed", "sending", "paid"] list, or a
// `=== "blocked" ? "held"` rewrite outside the helper), so a fourth reader
// cannot drift from the other three.
import "./lib/offline-stores.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, failed = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { failed++; console.error(`FAIL - ${m}`); } };

const { publicRefundStatus, refundAnswerStatus } = await import("../src/refund-status-word.js");
ok(publicRefundStatus("blocked") === "held" && publicRefundStatus("owed") === "owed" && publicRefundStatus("void") === "void", "the lookup word: blocked reads held, the rest as kept");
ok(["owed", "sending", "paid", "held"].every((w) => refundAnswerStatus(w) === w) && refundAnswerStatus("blocked") === "held", "an answer's word: owed, sending, paid and held as they are, blocked as held");
ok(refundAnswerStatus("void") === "owed" && refundAnswerStatus(undefined) === "owed" && refundAnswerStatus("") === "owed", "anything else reads owed");

// The three readers, through their own code.
const { resendSpentBody } = await import("../src/settle-first.js");
ok(resendSpentBody({ status: "blocked", tx: "0xab" }).refund.status === "held", "settle-first's resend limit names a blocked row held");
const { cappedResendVerdict } = await import("../src/settle-deadlines.js");
{
  const TX = `0x${"ab".repeat(32)}`;
  const P = { network: "eip155:42220", asset: "0x0", payTo: "0x0", amount: "2500", from: `0x${"1".repeat(40)}`, nonce: `0x${"9".repeat(64)}`, seenAt: Date.now() - 60_000 };
  const verdictFor = (status) => cappedResendVerdict(P, {
    prove: async () => ({ proven: true, transaction: TX }),
    claimTx: async () => ({ claimed: false, holder: "late-settle:k" }),
    isLateHolder: (h) => String(h || "").startsWith("late-settle:"),
    rowOf: async () => ({ status }),
    replayVerdict: async () => ({ verdict: "refunded", row: { status } }),
    book: async () => {},
    ledgerShared: true,
    refundLookup: (t) => `https://x.example/api/refunds/lookup?tx=${t}`,
  });
  const held = await verdictFor("blocked");
  ok(held?.status === 402 && held.body.error === "payment_refunded" && held.body.refund.status === "held" && /held for review/.test(held.body.hint) && !/refunded \(or is being refunded\)/.test(held.body.hint), `a late-settled resend whose refund row is blocked reads held, as its lookup does (${held?.body?.refund?.status})`);
  const sending = await verdictFor("sending");
  ok(sending?.body?.refund?.status === "sending" && /being refunded/.test(sending.body.hint), "a row being repaid still reads sending");
}

// The class: nobody else maps the words.
const root = fileURLToPath(new URL("../src/", import.meta.url));
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== "generated") walk(p); } else if (n.endsWith(".js")) files.push(p); } };
walk(root);
const inline = /\[\s*"owed"\s*,\s*"sending"\s*,\s*"paid"\s*\]\s*\.includes/;
const rewrite = /===\s*"blocked"\s*\?\s*"held"/;
const offenders = files.filter((f) => !f.endsWith("refund-status-word.js")).filter((f) => { const s = readFileSync(f, "utf8"); return inline.test(s) || rewrite.test(s); }).map((f) => relative(root, f));
ok(offenders.length === 0, `no module maps a refund status word on its own (${offenders.join(", ") || "none"})`);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
