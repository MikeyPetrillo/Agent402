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
// A payment an operator refunded in the Stripe dashboard: create refuses it,
// and the refund that was made is read back by its PaymentIntent.
const dashboard = new Map(); // pi -> { createError, refunds: [...], fullyRefunded }
const lookups = [];
const stripe = {
  checkout: { sessions: { retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; } } },
  refunds: {
    create: async ({ payment_intent }) => {
      const d = dashboard.get(payment_intent);
      if (d) { const e = new Error(d.createError.message); e.code = d.createError.code; throw e; }
      if (refundFail) throw new Error("stripe refund down"); return { id: "re_live" };
    },
    list: async ({ payment_intent }) => { lookups.push(`list:${payment_intent}`); return { data: dashboard.get(payment_intent)?.refunds || [] }; },
  },
  paymentIntents: {
    retrieve: async (id) => { lookups.push(`pi:${id}`); return { id, latest_charge: { id: `ch_${id}`, refunded: dashboard.get(id)?.fullyRefunded === true } }; },
  },
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

  // ---- refunded by hand in the Stripe dashboard -----------------------------
  // The retry's refunds.create fails (already refunded, or a key that replays
  // an earlier failure); the refund the operator made is read back and its id
  // recorded, so the record leaves the owed list.
  {
    const dir = join(root, "dashboard");
    mkdirSync(dir, { recursive: true });
    const owedRec = (pi) => ({ status: "error", refundId: null, refundOwed: true, refundAttempts: 2, lastRefundAttemptAt: 0, paymentIntent: pi, product: "research", at: iso(20 * 60_000), error: "We couldn't complete this report. Your refund is being processed." });
    const cases = {
      cs_dash: { pi: "pi_dash", createError: { code: "charge_already_refunded", message: "Charge ch_x has already been refunded." }, refunds: [{ id: "re_failed", status: "failed", created: 3 }, { id: "re_dash", status: "succeeded", created: 2 }] },
      cs_cached: { pi: "pi_cached", createError: { code: "idempotency_error", message: "replayed earlier failure" }, refunds: [{ id: "re_hand", status: "pending", created: 5 }], fullyRefunded: true },
      cs_partial: { pi: "pi_partial", createError: { code: "amount_too_large", message: "Refund amount is greater than unrefunded amount" }, refunds: [{ id: "re_part", status: "succeeded", created: 4 }], fullyRefunded: false },
      cs_none: { pi: "pi_none", createError: { code: "charge_already_refunded", message: "Charge has already been refunded." }, refunds: [{ id: "re_x", status: "canceled", created: 1 }] },
    };
    for (const [id, c] of Object.entries(cases)) {
      sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: c.pi, metadata: { product: "research", input: "x" } };
      dashboard.set(c.pi, c);
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(owedRec(c.pi)));
    }
    const hc = mk(dir);
    ok(ids(await hc.owedRefunds()).join() === "cs_cached,cs_dash,cs_none,cs_partial", "setup: all four records are owed");
    const got = {};
    for (const id of Object.keys(cases)) got[id] = await hc.fulfill(id);
    ok(got.cs_dash?.refundId === "re_dash" && got.cs_dash.refundOwed === false, `a payment already refunded in the dashboard records that refund's id (${got.cs_dash?.refundId})`);
    ok(got.cs_cached?.refundId === "re_hand" && got.cs_cached.refundOwed === false, `a failed create whose payment is fully refunded records the existing refund (${got.cs_cached?.refundId})`);
    ok(!got.cs_partial?.refundId && got.cs_partial?.refundOwed === true, "control: a partial refund leaves the record owed");
    ok(!got.cs_none?.refundId && got.cs_none?.refundOwed === true, "control: with no live refund on the payment the record stays owed");
    ok(lookups.includes("list:pi_dash") && !lookups.includes("pi:pi_dash") && lookups.includes("pi:pi_cached"), `an already-refunded refusal needs no PaymentIntent read; any other refusal checks the charge is fully refunded (${lookups.join(",")})`);
    ok(ids(await hc.owedRefunds()).join() === "cs_none,cs_partial", `the dashboard-refunded records leave the owed list the refundsOwed word reads (${ids(await hc.owedRefunds()).join()})`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\ntest-human-checkout-owed-records: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
