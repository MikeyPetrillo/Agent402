// A refund on request racing its own webhooks (src/credits.js applyRefundOn).
// Two retries of one request and a refund.failed delivery interleave so that
// the older refund's failure is decided after a newer refund was sent: the
// request must keep waiting on the newer refund, never record the older id
// over it. A success event for any refund of the request settles it once.
// Offline, file backend, a Stripe stub that holds replies until released.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { looseCreditsChecks } from "./lib/credits-loose-checks.js"; // wide purchase checks (see the file)
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createCredits, hashKey, CREDIT_PACKS } = await import("../src/credits.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = join(tmpdir(), `test-credits-refund-race-${process.pid}`);
rmSync(DIR, { recursive: true, force: true });

// ---- a Stripe stub: idempotent creates, and a gate that holds one reply -----
const sessions = {}, charges = {}, made = {}, byIdem = {};
let seq = 0;
let nextStatus = "pending";
let hold = null; // { what, release, reached } - holds the next reply of that call
const gate = (what) => {
  if (!hold || hold.what !== what || hold.used) return null;
  hold.used = true; hold.reachedResolve();
  return hold.promise;
};
const holdNext = (what) => {
  let release, reachedResolve;
  const promise = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { reachedResolve = r; });
  hold = { what, promise, release, reached, reachedResolve, used: false };
  return hold;
};
const paid = (id, pack, pi, email) => {
  sessions[id] = { id, mode: "payment", payment_status: "paid", payment_intent: pi, customer_details: { email }, metadata: { credits_pack: pack } };
  charges[pi] = { amount: CREDIT_PACKS[pack].cents, amount_refunded: 0 };
};
const stripe = {
  checkout: { sessions: { retrieve: async (id) => { if (!sessions[id]) throw new Error("no"); return sessions[id]; } } },
  paymentIntents: { retrieve: async (pi) => { const c = charges[pi]; return { id: pi, latest_charge: c ? { amount: c.amount, amount_refunded: c.amount_refunded, payment_method_details: { card: { fingerprint: `fp_${pi}` } } } : null }; } },
  refunds: {
    create: async (a, opts = {}) => {
      const k = opts.idempotencyKey;
      if (k && byIdem[k]) return { ...made[byIdem[k]] };
      const r = { id: `re_${++seq}`, amount: a.amount, status: nextStatus, payment_intent: a.payment_intent, metadata: a.metadata || {} };
      made[r.id] = r; if (k) byIdem[k] = r.id;
      if (r.status !== "failed" && r.status !== "canceled") charges[a.payment_intent].amount_refunded += a.amount;
      return { ...r };
    },
    retrieve: async (id) => { const snap = { ...made[id] }; const g = gate("retrieve"); if (g) await g; return snap; },
    list: async ({ payment_intent }) => ({ data: Object.values(made).filter((r) => r.payment_intent === payment_intent).map((r) => ({ ...r })) }),
  },
};
const failAtStripe = (id) => { const r = made[id]; if (r.status !== "failed") charges[r.payment_intent].amount_refunded -= r.amount; r.status = "failed"; };
const logs = [];
const cr = createCredits({ stripe, baseUrl: "https://agent402.tools", storeDir: DIR, log: (l) => logs.push(l) });
const rrOf = (key) => JSON.parse(readFileSync(join(DIR, `k_${hashKey(key)}.json`), "utf8")).refundRequest;
const recOf = (key) => JSON.parse(readFileSync(join(DIR, `k_${hashKey(key)}.json`), "utf8"));
const ev = (id, status) => ({ ...made[id], status });

// ---- (1) the race: retry A reads R1 failed, the webhook says so too, retry B
// sends R2, and only then does A record what it read --------------------------
paid("cs_a", "credits-20", "pi_a", "a@x.com");
const A = await cr.claim("cs_a");
ok((await cr.requestRefund(A.key)).status === "pending" && rrOf(A.key).parts[0].refundId === "re_1", "setup: the first refund (re_1) is pending at Stripe");
failAtStripe("re_1");
const h = holdNext("retrieve");
const retryA = cr.requestRefund(A.key); // reads re_1 (failed) and waits on the held reply
await h.reached;
ok(cr.settleRefund(ev("re_1", "failed")) === A.keyId && rrOf(A.key).state === "failed", "refund.failed for re_1 lands while retry A waits");
const retryB = await cr.requestRefund(A.key);
ok(retryB.status === "pending" && rrOf(A.key).parts[0].refundId === "re_2" && rrOf(A.key).state === "pending", "retry B sends a new refund (re_2), recorded pending");
h.release();
const a = await retryA;
const after = rrOf(A.key).parts[0];
ok(after.refundId === "re_2" && after.state === "pending" && rrOf(A.key).state === "pending", `retry A's late read of re_1 failed never replaces re_2 (refundId ${after.refundId}, ${after.state})`);
ok(JSON.stringify(after.failedIds) === JSON.stringify(["re_1"]) && a.status === "pending", "the older refund stays in the failure list once");
ok(!(await cr.refundRequestsOwed()).includes(A.keyId), "the request is not owed while re_2 is pending");
// The same late failure as a webhook redelivery, and a failure of an older
// refund the request never recorded, both leave re_2 in place.
ok(cr.settleRefund(ev("re_1", "failed")) === null && rrOf(A.key).parts[0].refundId === "re_2", "a redelivered refund.failed for re_1 changes nothing");
made.re_9 = { id: "re_9", amount: 2000, status: "failed", payment_intent: "pi_a", metadata: { credits_refund_request: A.keyId } };
ok(cr.settleRefund(ev("re_9", "failed")) === null && rrOf(A.key).parts[0].refundId === "re_2" && rrOf(A.key).parts[0].failedIds.includes("re_9"), "a failure of a refund the request is not waiting on is noted, not applied");
// re_2 succeeds: done once, the charge total recorded once.
made.re_2.status = "succeeded";
ok(cr.settleRefund(ev("re_2", "succeeded")) === A.keyId && rrOf(A.key).state === "done" && recOf(A.key).refundedMicro === 20_000_000, "re_2 succeeding settles the request");
ok(cr.settleRefund(ev("re_2", "succeeded")) === null && recOf(A.key).refundedMicro === 20_000_000, "a second success event settles nothing again");
ok(cr.settleRefund(ev("re_1", "failed")) === null && rrOf(A.key).state === "done", "a late failure of the older refund leaves the done request alone");

// ---- (2) the same race the other way: A records its read before the webhook --
paid("cs_b", "credits-20", "pi_b", "b@x.com");
const B = await cr.claim("cs_b");
await cr.requestRefund(B.key);
const b1 = rrOf(B.key).parts[0].refundId;
failAtStripe(b1);
await cr.requestRefund(B.key); // reads b1 failed and records it
ok(rrOf(B.key).state === "failed" && rrOf(B.key).parts[0].failedIds.includes(b1), "a retry that reads the failure first records it");
ok(cr.settleRefund(ev(b1, "failed")) === null, "...and the webhook after it changes nothing");
const b2 = await cr.requestRefund(B.key);
ok(b2.status === "pending" && rrOf(B.key).parts[0].refundId !== b1 && rrOf(B.key).parts[0].refundId, "asking again sends a newer refund");

// ---- (3) a success event for any refund of the request settles it once --------
paid("cs_c", "credits-20", "pi_c", "c@x.com");
const C = await cr.claim("cs_c");
await cr.requestRefund(C.key);
const c1 = rrOf(C.key).parts[0].refundId;
failAtStripe(c1);
cr.settleRefund(ev(c1, "failed"));
await cr.requestRefund(C.key);
const c2 = rrOf(C.key).parts[0].refundId;
ok(c2 && c2 !== c1 && rrOf(C.key).state === "pending", "setup: the request waits on a second refund");
// Stripe reports the first refund succeeded after all (a delivery it corrected).
made[c1].status = "succeeded";
const n0 = logs.length;
ok(cr.settleRefund(ev(c1, "succeeded")) === C.keyId && rrOf(C.key).state === "done" && rrOf(C.key).parts[0].refundId === c1, "a success for the older refund settles the request");
made[c2].status = "succeeded";
ok(cr.settleRefund(ev(c2, "succeeded")) === null && rrOf(C.key).parts[0].refundId === c1 && recOf(C.key).refundedMicro === 20_000_000, "the newer refund's success settles nothing twice and the refund is counted once");
ok(logs.slice(n0).some((l) => /a second refund .* succeeded for a request already refunded/.test(l)), "...and the second success is logged for a look in Stripe");
// Two deliveries of one success racing: one settles.
paid("cs_d", "credits-20", "pi_d", "d@x.com");
const D = await cr.claim("cs_d");
await cr.requestRefund(D.key);
const d1 = rrOf(D.key).parts[0].refundId;
made[d1].status = "succeeded";
const both = await Promise.all([cr.settleRefund(ev(d1, "succeeded")), cr.requestRefund(D.key)]);
ok(both[0] === D.keyId && both[1].status === "refunded" && rrOf(D.key).state === "done" && recOf(D.key).refundedMicro === 20_000_000, "a webhook and a retry seeing the same success settle the request once");

// ---- (4) two retries racing with nothing else: one refund, under one key ------
paid("cs_e", "credits-20", "pi_e", "e@x.com");
const E = await cr.claim("cs_e");
nextStatus = "failed";
await cr.requestRefund(E.key);
nextStatus = "pending";
const sentBefore = seq;
const [e1, e2] = await Promise.all([cr.requestRefund(E.key), cr.requestRefund(E.key)]);
ok(e1.status === "pending" && e2.status === "pending" && seq === sentBefore + 1 && rrOf(E.key).parts[0].refundId === `re_${seq}`, "two retries at once send one new refund (one idempotency key) and both record it");

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
