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
//    poll refunds it;
//  - a refund Stripe reports pending is never recorded as made: the record
//    stays owed until a later read finds it succeeded, and stays owed when
//    it fails (read-back, and a poll whose create answers pending).
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
const creates = [];
let listHang = false;
const stripe = {
  checkout: { sessions: { retrieve: async (id) => { const s = sessions[id]; if (!s) throw new Error("No such session"); return s; } } },
  refunds: {
    create: async ({ payment_intent }) => {
      creates.push(payment_intent);
      const d = dashboard.get(payment_intent);
      if (d?.createResult) return { ...d.createResult };
      if (d) { const e = new Error(d.createError.message); e.code = d.createError.code; throw e; }
      if (refundFail) throw new Error("stripe refund down"); return { id: "re_live", status: "succeeded" };
    },
    list: async ({ payment_intent }) => { if (listHang) return new Promise(() => {}); lookups.push(`list:${payment_intent}`); return { data: dashboard.get(payment_intent)?.refunds || [] }; },
  },
  paymentIntents: {
    retrieve: async (id) => { lookups.push(`pi:${id}`); return { id, latest_charge: { id: `ch_${id}`, refunded: dashboard.get(id)?.fullyRefunded === true } }; },
  },
};
const generate = async () => { throw new Error("upstream boom"); };
const mk = (dir, extra = {}) => createHumanCheckout({ stripe, generate, baseUrl: "https://agent402.tools", storeDir: dir, onSale: () => {}, now: () => clock, log: () => {}, owedListWaitMs: 0, ...extra });
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
      cs_cached: { pi: "pi_cached", createError: { code: "idempotency_error", message: "replayed earlier failure" }, refunds: [{ id: "re_hand", status: "succeeded", created: 5 }], fullyRefunded: true },
      cs_partial: { pi: "pi_partial", createError: { code: "amount_too_large", message: "Refund amount is greater than unrefunded amount" }, refunds: [{ id: "re_part", status: "succeeded", created: 4 }], fullyRefunded: false },
      cs_none: { pi: "pi_none", createError: { code: "charge_already_refunded", message: "Charge has already been refunded." }, refunds: [{ id: "re_x", status: "canceled", created: 1 }] },
      // Two live refunds on one payment (a partial, then the rest): the newest is recorded.
      cs_two: { pi: "pi_two", createError: { code: "charge_already_refunded", message: "Charge has already been refunded." }, refunds: [{ id: "re_two_mid", status: "succeeded", created: 5 }, { id: "re_two_new", status: "succeeded", created: 9 }, { id: "re_two_old", status: "succeeded", created: 1 }] },
    };
    for (const [id, c] of Object.entries(cases)) {
      sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: c.pi, metadata: { product: "research", input: "x" } };
      dashboard.set(c.pi, c);
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(owedRec(c.pi)));
    }
    const hc = mk(dir);
    ok(ids(await hc.owedRefunds()).join() === "cs_cached,cs_dash,cs_none,cs_partial,cs_two", "setup: all five records are owed");
    const got = {};
    for (const id of Object.keys(cases)) got[id] = await hc.fulfill(id);
    ok(got.cs_dash?.refundId === "re_dash" && got.cs_dash.refundOwed === false, `a payment already refunded in the dashboard records that refund's id (${got.cs_dash?.refundId})`);
    ok(got.cs_cached?.refundId === "re_hand" && got.cs_cached.refundOwed === false, `a failed create whose payment is fully refunded records the existing refund (${got.cs_cached?.refundId})`);
    ok(!got.cs_partial?.refundId && got.cs_partial?.refundOwed === true, "control: a partial refund leaves the record owed");
    ok(!got.cs_none?.refundId && got.cs_none?.refundOwed === true, "control: with no live refund on the payment the record stays owed");
    ok(got.cs_two?.refundId === "re_two_new", `of two live refunds with different created times the newest is recorded (${got.cs_two?.refundId})`);
    ok(lookups.includes("list:pi_dash") && !lookups.includes("pi:pi_dash") && lookups.includes("pi:pi_cached"), `an already-refunded refusal needs no PaymentIntent read; any other refusal checks the charge is fully refunded (${lookups.join(",")})`);
    ok(ids(await hc.owedRefunds()).join() === "cs_none,cs_partial", `the dashboard-refunded records leave the owed list the refundsOwed word reads (${ids(await hc.owedRefunds()).join()})`);
  }

  // ---- read back past the retry cap -----------------------------------------
  // A record at MAX_REFUND_ATTEMPTS is no longer retried on a poll, so a
  // refund made by hand after that is caught only by the background
  // read-back, which never issues a refund itself.
  {
    const dir = join(root, "readback");
    mkdirSync(dir, { recursive: true });
    const capRec = (pi) => ({ status: "error", refundId: null, refundOwed: true, refundAttempts: 6, lastRefundAttemptAt: 0, paymentIntent: pi, product: "research", at: iso(20 * 60_000), error: "We couldn't complete this report. Your refund is being processed." });
    const cases = {
      cs_cap_full: { pi: "pi_cap_full", createError: { code: "charge_already_refunded", message: "already refunded" }, refunds: [{ id: "re_cap", status: "succeeded", created: 7 }], fullyRefunded: true },
      cs_cap_partial: { pi: "pi_cap_partial", createError: { code: "amount_too_large", message: "too large" }, refunds: [{ id: "re_cap_part", status: "succeeded", created: 4 }], fullyRefunded: false },
      cs_cap_none: { pi: "pi_cap_none", createError: { code: "x", message: "down" }, refunds: [], fullyRefunded: false },
    };
    for (const [id, c] of Object.entries(cases)) {
      sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: c.pi, metadata: { product: "research", input: "x" } };
      dashboard.set(c.pi, c);
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(capRec(c.pi)));
    }
    const hc = mk(dir);
    creates.length = 0;
    const polled = await hc.fulfill("cs_cap_full");
    ok(polled?.refundOwed === true && !polled.refundId && creates.length === 0, "control: a poll at the retry cap neither refunds nor reads back");
    const r = await hc.readBackOwedRefunds();
    ok(r.checked === 3 && r.recorded === 1, `the read-back checks every owed record and records the dashboard refund (${JSON.stringify(r)})`);
    ok(creates.length === 0, `the read-back never issues a refund (${creates.length} creates)`);
    const after = await hc.fulfill("cs_cap_full");
    ok(after?.refundId === "re_cap" && after.refundOwed === false, `a record at refundAttempts 6 refunded by hand is recorded (${after?.refundId})`);
    ok(ids(await hc.owedRefunds()).join() === "cs_cap_none,cs_cap_partial", `a partial refund and no refund stay owed; the refundsOwed list drops the refunded one (${ids(await hc.owedRefunds()).join()})`);
    const bounded = await hc.readBackOwedRefunds({ max: 1 });
    ok(bounded.checked === 1, `a pass reads at most its bound (${bounded.checked})`);

    // A Stripe read that never answers is given up after the per-call timeout.
    const hcT = mk(dir, { readbackCallTimeoutMs: 50 });
    listHang = true;
    // The suite's own bound (ref'd, so it also holds the process open): a
    // pass with no per-call timeout would wait here for good.
    let bound = null;
    const t0 = Date.now();
    const timed = await Promise.race([hcT.readBackOwedRefunds(), new Promise((r) => { bound = setTimeout(() => r({ recorded: -1 }), 3000); })]);
    clearTimeout(bound);
    listHang = false;
    ok(timed.recorded === 0 && Date.now() - t0 < 2000, `a read that never answers is given up per call (${Date.now() - t0} ms)`);

    // The timers: the first run after start() records; stop() clears it.
    const dir2 = join(root, "readback-timer");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "cs_cap_full.json"), JSON.stringify(capRec("pi_cap_full")));
    const hc2 = mk(dir2);
    hc2.start({ firstMs: 50, intervalMs: 3_600_000 });
    hc2.stop();
    await wait(200);
    ok(ids(await hc2.owedRefunds()).join() === "cs_cap_full", "control: stop() before the first run leaves the record owed");
    hc2.start({ firstMs: 20, intervalMs: 3_600_000 });
    for (let i = 0; i < 100 && ids(await hc2.owedRefunds()).length; i++) await wait(20);
    hc2.stop();
    ok(ids(await hc2.owedRefunds()).length === 0, "the read-back's first run after start() records the dashboard refund");
  }

  // ---- a pending refund is not a refund -------------------------------------
  // Stripe marks the charge fully refunded while a refund is still pending,
  // and a pending refund can still fail. Only a succeeded refund is recorded;
  // the read-back pass reads a pending one again on later passes.
  {
    const dir = join(root, "pending");
    mkdirSync(dir, { recursive: true });
    const capRec = (pi, attempts = 6) => ({ status: "error", refundId: null, refundOwed: true, refundAttempts: attempts, lastRefundAttemptAt: 0, paymentIntent: pi, product: "research", at: iso(20 * 60_000), error: "We couldn't complete this report. Your refund is being processed." });
    const cases = {
      cs_pend_ok: { pi: "pi_pend_ok", createError: { code: "charge_already_refunded", message: "already refunded" }, refunds: [{ id: "re_pend_ok", status: "pending", created: 3 }], fullyRefunded: true },
      cs_pend_fail: { pi: "pi_pend_fail", createError: { code: "charge_already_refunded", message: "already refunded" }, refunds: [{ id: "re_pend_fail", status: "pending", created: 3 }], fullyRefunded: true },
      // A partial refund succeeded and the rest is still pending.
      cs_pend_mix: { pi: "pi_pend_mix", createError: { code: "charge_already_refunded", message: "already refunded" }, refunds: [{ id: "re_mix_a", status: "succeeded", created: 2 }, { id: "re_mix_b", status: "pending", created: 4 }], fullyRefunded: true },
    };
    for (const [id, c] of Object.entries(cases)) {
      sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: c.pi, metadata: { product: "research", input: "x" } };
      dashboard.set(c.pi, c);
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(capRec(c.pi)));
    }
    const hc = mk(dir);
    creates.length = 0;
    const p1 = await hc.readBackOwedRefunds();
    ok(p1.checked === 3 && p1.recorded === 0, `a fully refunded charge whose refund is pending is not recorded (${JSON.stringify(p1)})`);
    ok(ids(await hc.owedRefunds()).join() === "cs_pend_fail,cs_pend_mix,cs_pend_ok", "all three stay owed while a refund is pending");
    // The owed list says which are pending at Stripe (the refundsOwed word's
    // card=pending: nothing for the operator to do), on the record and its entry.
    const pendOf = async () => Object.fromEntries((await hc.owedRefunds()).map((x) => [x.id, x.pending]));
    ok(JSON.stringify(await pendOf()) === JSON.stringify({ cs_pend_fail: true, cs_pend_mix: true, cs_pend_ok: true }) && (await hc.fulfill("cs_pend_ok"))?.refundPending === true,
      `a refund Stripe holds and has not finished marks the owed record pending (${JSON.stringify(await pendOf())})`);
    ok(p1.marked === 3, `the read-back counts the records it marked (${JSON.stringify(p1)})`);
    ok((await hc.readBackOwedRefunds()).marked === 0, "a second pass with nothing changed writes nothing");
    // Stripe settles them: one succeeds, one fails (the charge is no longer refunded).
    cases.cs_pend_ok.refunds[0].status = "succeeded";
    cases.cs_pend_fail.refunds[0].status = "failed";
    cases.cs_pend_fail.fullyRefunded = false;
    cases.cs_pend_fail.createError = { code: "x", message: "down" };
    const p2 = await hc.readBackOwedRefunds();
    ok(p2.recorded === 1, `the next pass records the refund that succeeded (${JSON.stringify(p2)})`);
    const okRec = await hc.fulfill("cs_pend_ok");
    ok(okRec?.refundId === "re_pend_ok" && okRec.refundOwed === false && /has been refunded/.test(okRec.error), `pending then succeeded is recorded as refunded (${okRec?.refundId})`);
    const failRec = await hc.fulfill("cs_pend_fail");
    ok(!failRec?.refundId && failRec?.refundOwed === true && /being processed/.test(failRec.error), "pending then failed stays owed and is never told it was refunded");
    ok(failRec?.refundPending !== true && (await hc.owedRefunds()).find((x) => x.id === "cs_pend_fail")?.pending === false, "a pending refund that failed is no longer marked pending: the operator is told to act");
    const p3 = await hc.readBackOwedRefunds();
    ok(p3.recorded === 0 && ids(await hc.owedRefunds()).join() === "cs_pend_fail,cs_pend_mix", `a failed refund and a still-pending remainder stay owed on later passes (${ids(await hc.owedRefunds()).join()})`);
    ok(creates.length === 0, `the read-back never issues a refund (${creates.length} creates)`);

    // The buyer-poll path: refunds.create answers a refund that is pending.
    const dirP = join(root, "pending-poll");
    mkdirSync(dirP, { recursive: true });
    const pc = { pi: "pi_poll_pend", createResult: { id: "re_poll_pend", status: "pending" }, refunds: [{ id: "re_poll_pend", status: "pending", created: 6 }], fullyRefunded: true };
    sessions.cs_poll_pend = { id: "cs_poll_pend", mode: "payment", payment_status: "paid", payment_intent: pc.pi, metadata: { product: "research", input: "x" } };
    dashboard.set(pc.pi, pc);
    writeFileSync(join(dirP, "cs_poll_pend.json"), JSON.stringify(capRec(pc.pi, 2)));
    const hcP = mk(dirP);
    const polled = await hcP.fulfill("cs_poll_pend");
    ok(creates.includes("pi_poll_pend") && !polled?.refundId && polled?.refundOwed === true && /being processed/.test(polled.error), "a poll whose refund is created pending stays owed");
    ok(polled?.refundPending === true && (await hcP.owedRefunds()).find((x) => x.id === "cs_poll_pend")?.pending === true, "and is marked pending at Stripe");
    clock += 60_000;
    pc.refunds[0].status = "succeeded"; // the key replays the pending answer; the list holds the truth
    const polled2 = await hcP.fulfill("cs_poll_pend");
    ok(polled2?.refundId === "re_poll_pend" && polled2.refundOwed === false, `the next poll reads the refund back once it succeeded (${polled2?.refundId})`);
  }

  // ---- a pending refund is read back within minutes ---------------------------
  // Between full passes a short pass reads only the records marked pending,
  // so a refund Stripe finishes leaves the owed list (and its page closes)
  // soon after; a record not marked pending waits for the next full pass.
  {
    const dir = join(root, "pending-timer");
    mkdirSync(dir, { recursive: true });
    const rec = (pi) => ({ status: "error", refundId: null, refundOwed: true, refundAttempts: 6, lastRefundAttemptAt: 0, paymentIntent: pi, product: "research", at: iso(20 * 60_000), error: "We couldn't complete this report. Your refund is being processed." });
    const pend = { pi: "pi_t_pend", createError: { code: "x", message: "down" }, refunds: [{ id: "re_t_pend", status: "pending", created: 2 }], fullyRefunded: true };
    const plain = { pi: "pi_t_plain", createError: { code: "x", message: "down" }, refunds: [], fullyRefunded: false };
    dashboard.set(pend.pi, pend); dashboard.set(plain.pi, plain);
    writeFileSync(join(dir, "cs_t_pend.json"), JSON.stringify(rec(pend.pi)));
    writeFileSync(join(dir, "cs_t_plain.json"), JSON.stringify(rec(plain.pi)));
    const hcT = mk(dir);
    hcT.start({ firstMs: 10, intervalMs: 3_600_000, pendingIntervalMs: 40 });
    try {
      for (let i = 0; i < 100 && (await hcT.owedRefunds()).find((x) => x.id === "cs_t_pend")?.pending !== true; i++) await wait(10);
      ok((await hcT.owedRefunds()).find((x) => x.id === "cs_t_pend")?.pending === true, "setup: the first (full) pass marks the pending refund");
      // Stripe finishes it; the plain one is refunded by hand at the same time.
      pend.refunds[0].status = "succeeded";
      plain.refunds = [{ id: "re_t_plain", status: "succeeded", created: 3 }]; plain.fullyRefunded = true;
      for (let i = 0; i < 100 && ids(await hcT.owedRefunds()).includes("cs_t_pend"); i++) await wait(10);
      ok(!ids(await hcT.owedRefunds()).includes("cs_t_pend"), "a short pass records the pending refund once Stripe finishes it, long before the next full pass");
      await wait(150);
      ok(ids(await hcT.owedRefunds()).includes("cs_t_plain"), "control: a record not marked pending waits for the next full pass");
    } finally { hcT.stop(); }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\ntest-human-checkout-owed-records: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
