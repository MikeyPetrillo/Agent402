// The owed card refunds (src/human-checkout.js listIssues / owedRefunds, read
// by the refundsOwed word on /api/gateway-status) come from the records, not
// only from the issues index written after them. File backend here; the
// database backend has the same cases in scripts/test-human-checkout-pg.js.
//
// Proves, each beside a control:
//  - an owed error record the index never caught (its write failed) is listed;
//  - an index entry whose record shows the refund was sent is not;
//  - an index entry with no record is still listed (never left out for want
//    of an answer), and a delivered report is never listed;
//  - through the caller path: a failed report whose refund fails while the
//    index cannot be written is listed, and leaves the list once a later
//    poll refunds it.
//   node scripts/test-human-checkout-owed-records.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHumanCheckout } from "../src/human-checkout.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let clock = Date.parse("2026-10-01T12:00:00Z");
const iso = (ago) => new Date(clock - ago).toISOString();

const sessions = {
  cs_live: { id: "cs_live", mode: "payment", payment_status: "paid", payment_intent: "pi_live", metadata: { product: "research", input: "FAIL" } },
};
let refundFail = true;
const stripe = {
  checkout: { sessions: { retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; } } },
  refunds: { create: async () => { if (refundFail) throw new Error("stripe refund down"); return { id: "re_live" }; } },
};
const generate = async () => { throw new Error("upstream boom"); };
const mk = (dir) => createHumanCheckout({ stripe, generate, baseUrl: "https://agent402.tools", storeDir: dir, onSale: () => {}, now: () => clock, log: () => {}, owedListWaitMs: 0 });
const ids = (list) => list.map((x) => x.id).sort();

const root = mkdtempSync(join(tmpdir(), "hc-owed-records-"));
try {
  // ---- seeded records against a seeded index --------------------------------
  {
    const dir = join(root, "seeded");
    mkdirSync(dir, { recursive: true });
    const owedRec = { status: "error", refundId: null, refundOwed: true, refundAttempts: 6, lastRefundAttemptAt: 0, paymentIntent: "pi_u", product: "research", at: iso(20 * 60_000), error: "x" };
    writeFileSync(join(dir, "cs_unindexed.json"), JSON.stringify(owedRec));
    writeFileSync(join(dir, "cs_refunded.json"), JSON.stringify({ ...owedRec, refundId: "re_9", refundOwed: false, paymentIntent: "pi_r" }));
    writeFileSync(join(dir, "cs_done.json"), JSON.stringify({ status: "done", product: "research", report: "# r", at: iso(0) }));
    writeFileSync(join(dir, "_issues.json"), JSON.stringify({
      cs_refunded: { kind: "refund-owed", at: iso(30 * 60_000), attempts: 3 },
      cs_indexonly: { kind: "refund-owed", at: iso(40 * 60_000), attempts: 2, product: "research" },
    }));
    const hc = mk(dir);
    const listed = hc.listIssues().refundOwed;
    ok(listed.some((x) => x.id === "cs_unindexed" && x.kind === "refund-owed" && x.attempts === 6 && x.at === owedRec.at && x.product === "research"),
      `an owed error record the index never caught is listed, with its time and attempts (${JSON.stringify(ids(listed))})`);
    ok(!listed.some((x) => x.id === "cs_refunded"), "an index entry whose record shows the refund was sent is not listed");
    ok(listed.some((x) => x.id === "cs_indexonly"), "control: an index entry with no record is still listed");
    ok(!listed.some((x) => x.id === "cs_done"), "control: a delivered report is never listed");
    const owed = ids(await hc.owedRefunds());
    ok(JSON.stringify(owed) === JSON.stringify(["cs_indexonly", "cs_unindexed"]), `the owed list the refundsOwed word reads agrees (${JSON.stringify(owed)})`);
  }

  // ---- the caller path: the index cannot be written -------------------------
  {
    const dir = join(root, "live");
    mkdirSync(join(dir, "_issues.json"), { recursive: true }); // a directory where the index file goes: every index write fails
    const hc = mk(dir);
    await hc.fulfill("cs_live");
    let rec = null;
    for (const until = Date.now() + 10_000; Date.now() < until; await wait(10)) { rec = hc.peek("cs_live"); if (rec && rec.status !== "generating") break; }
    ok(rec?.status === "error" && rec.refundOwed === true && !rec.refundId, `setup: the report failed and its refund failed (${rec?.status})`);
    ok(hc.listIssues().refundOwed.some((x) => x.id === "cs_live"), "the owed refund is listed although its index entry was never written");
    ok((await hc.owedRefunds()).some((x) => x.id === "cs_live"), "and is on the owed list the refundsOwed word reads");
    refundFail = false;
    clock += 60_000; // past the refund retry spacing
    const retried = await hc.fulfill("cs_live");
    ok(retried.refundId === "re_live" && retried.refundOwed === false, `control: a later poll refunds it (${retried.refundId})`);
    ok(!hc.listIssues().refundOwed.some((x) => x.id === "cs_live") && !(await hc.owedRefunds()).some((x) => x.id === "cs_live"), "once refunded it leaves the list, though the index still cannot be written");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\ntest-human-checkout-owed-records: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
