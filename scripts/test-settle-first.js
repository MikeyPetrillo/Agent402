#!/usr/bin/env node
// Settle first (src/settle-first.js): on the /v1 model routes, a run of a
// wallet with no paid sale on the books, and of a wallet or an authorization
// holding runs that did not settle, has its payment settled BEFORE its
// upstream work. Nobody is refused by it, a payment is taken once and for the
// amount it was signed for, and a charge whose run then fails is booked as
// owed under its own class.
//
// PART 1, offline, on the settle breaker itself (src/gateway-settle-breaker.js):
//   - wallet rotation: W new wallets, each run until its key is refused, each
//     payment failing to settle. With GATEWAY_SETTLE_FIRST=off (every run
//     settled after its handler, as before) each wallet is served unpaid runs
//     and the total grows with W; on, no run is served unpaid;
//   - one new wallet, many calls in flight together, admitted as covered: off,
//     every one is served unpaid; on, none;
//   - one wallet WITH paid history and one authorization, 200 runs that do not
//     settle for a cause that is not the buyer's: off, all 200 are served; on,
//     the first SETTLE_FIRST_UNSETTLED_MAX are, the rest settle first, and
//     the key is never refused; a settled call ends it;
//   - where "never settled" comes from, and what an unreadable ledger reads as.
//
// PART 2, one PAID-mode server (scripts/lib/paid-wires-rig.js: stub
// facilitators that hold balances, a stub model upstream), every x402 exact
// wire: the order of the settle call and the upstream call; one settle call
// per payment; the controls (a wallet with history, the switch off); every
// refusal that is the buyer's own doing answered before any settle call;
// every failure after the settlement booked as owed with its class, payer,
// transaction, amount and route, and said so in the answer; a hang-up after
// the settlement; the same payment sent again; the wires that are left as
// they were; the operator counts; and the 402, which does not change.
// A second boot with GATEWAY_SETTLE_FIRST=off shows the same calls served
// unpaid, as they were before, and a third (boot A's sales ledger file) is a
// restart: the wallet that paid is read from the ledger.
//
//   node scripts/test-settle-first.js
//   SETTLE_FIRST_PARTS=1 node scripts/test-settle-first.js   # the offline part only (2: the paid boot; 3: the switch off and, after 2, the restart)
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports
import "./lib/file-mode.js";
import { EventEmitter } from "node:events";
import { bootPaidWires, sleep } from "./lib/paid-wires-rig.js";

let pass = 0, rig = null;
const fail = async (m) => { console.error(`FAIL - ${m}`); for (const l of (rig?.log() || "").split("\n").filter(Boolean).slice(-25)) console.error("  server:", l.slice(0, 300)); await rig?.stop().catch(() => {}); process.exit(1); };
const ok = async (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else await fail(m); };
const ONLY = (process.env.SETTLE_FIRST_PARTS || "1,2,3,4").split(",");

// =============================================================================
// PART 1: the breaker's own rules, offline
// =============================================================================
if (ONLY.includes("1")) {
  delete process.env.GATEWAY_SETTLE_FIRST;
  // The sentence a route that may settle first carries after its "settles
  // only on the answer" claim: present on such a route, absent elsewhere.
  {
    const copy = await import("../src/settle-first-copy.js?clause");
    const c = copy.settleFirstClause({ settlesFirst: true });
    await ok(c === ` ${copy.SETTLE_FIRST_TEXT}` && c.includes(copy.SETTLE_FIRST_MARK), `settleFirstClause gives a settle-first route the sentence (${JSON.stringify(c.slice(0, 40))})`);
    await ok(copy.settleFirstClause({ settlesFirst: false }) === "" && copy.settleFirstClause(null) === "", "settleFirstClause adds nothing on any other route");
    await ok(copy.settleFirstCopyOn({ GATEWAY_SETTLE_FIRST: "off" }) === false && copy.settleFirstCopyOn({}) === true, "the sentence follows the settle-first switch");
  }
  // The meter's per-minute figures stay within its 24-hour window even when
  // nothing ever reads them (each new minute drops the minutes past it).
  {
    const meter = await import("../src/settle-first-meter.js?own-minutes");
    const T = Date.UTC(2026, 0, 1);
    for (let h = 0; h < 72; h++) for (let q = 0; q < 60; q += 15) meter.noteUnsettledRunCost(0.001, T + h * 3_600_000 + q * 60_000);
    await ok(meter._ownCostMinutesForTest() <= 24 * 4 + 1, `the meter keeps only its window's minutes when never read (${meter._ownCostMinutesForTest()} minutes after 72 hours of writes)`);
  }
  // The answer to a resend past the bound: the count in words, and the
  // refund's own status (a paid refund is said to be refunded, never owed).
  {
    const { resendSpentBody, SETTLE_FIRST_MAX_RESENDS } = await import("../src/settle-first.js");
    const tx = "0x" + "ab".repeat(32);
    const owed = resendSpentBody({ status: "owed", tx, baseUrl: "https://example.test" });
    await ok(SETTLE_FIRST_MAX_RESENDS === 2 && owed.error === "resend_limit_reached" && owed.charged === true && owed.refundOwed === true && /already ran again twice after its call failed/.test(owed.hint) && /owed back to the paying wallet/.test(owed.hint) && !/\d times/.test(owed.hint) && owed.refund.status === "owed" && owed.refund.lookup === `https://example.test/api/refunds/lookup?tx=${tx}`,
      `an owed resend answer says "ran again twice" and that the payment is owed back (${owed.hint})`);
    const sending = resendSpentBody({ status: "sending", tx, baseUrl: "" });
    await ok(sending.refundOwed === true && /owed back/.test(sending.hint), "a refund being sent is still owed");
    const paid = resendSpentBody({ status: "paid", tx, baseUrl: "" });
    await ok(paid.charged === true && paid.refundOwed === false && paid.refund.status === "paid" && /was refunded to the paying wallet/.test(paid.hint) && !/owed/.test(paid.hint),
      `a paid refund's resend answer says it was refunded, refundOwed false, and never that it is owed (${paid.hint})`);
    const held = resendSpentBody({ status: "blocked", tx, baseUrl: "" });
    ok(held.refund.status === "held" && held.refundOwed === false && held.charged === true && /held for review; it has not been paid/.test(held.hint) && !/blocked|sanction/i.test(JSON.stringify(held)), "a resend past the bound whose refund is held reads held, unpaid, with no reason named");
    {
      const { readFileSync } = await import("node:fs");
      const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
      const at = server.indexOf('error: "payment_refunded"');
      ok(at > 0 && /const held = refundAnswerStatus\(row\.status\) === "held";/.test(server.slice(at - 400, at)) && /status: refundAnswerStatus\(row\.status\)/.test(server.slice(at, at + 900)), "a resend of a payment whose refund is held reads held on payment_refunded too (the shared word, src/refund-status-word.js)");
    }
    const junk = resendSpentBody({ status: "weird", tx, baseUrl: "" });
    await ok(junk.refund.status === "owed" && junk.refundOwed === true, "an unknown refund status reads as owed");
  }
  const b = await import("../src/gateway-settle-breaker.js");
  const { settleReceiptHeaderGuard } = await import("../src/facilitator-diagnostics.js");
  const { COVER_STATE } = await import("../src/inflight-cover-state.js");
  const paid = new Set();
  let ledger = { read: (p) => paid.has(p), loaded: () => true };
  const useLedger = () => b.setGatewaySettleBreakerPaidSaleReaderForTest((p) => ledger.read(p), { loaded: () => ledger.loaded() });
  useLedger();
  const hdr = (from, nonce, network = "eip155:8453") => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network }, payload: { authorization: { from, nonce } } })).toString("base64");
  let nonceSeq = 0;
  const newNonce = () => "0x" + (++nonceSeq).toString(16).padStart(64, "0");
  function reqOf(from, { cover = null, nonce = newNonce(), network = "eip155:8453" } = {}) {
    const h = hdr(from, nonce, network);
    const res = new EventEmitter(); res.statusCode = 200; res._h = {};
    res.getHeader = (n) => res._h[String(n).toLowerCase()]; res.setHeader = (n, v) => { res._h[String(n).toLowerCase()] = v; };
    const req = { header: (n) => (String(n).toLowerCase() === "payment-signature" ? h : undefined), headers: {}, ip: "203.0.113.7", res, method: "POST", path: "/v1/chat" };
    settleReceiptHeaderGuard({ log: () => {} })(req, res, () => {});
    if (cover) Object.defineProperty(req, COVER_STATE, { value: cover, enumerable: false });
    return req;
  }
  const receipt = (errorReason) => Buffer.from(JSON.stringify({ success: false, errorReason, errorMessage: errorReason, transaction: "" })).toString("base64");
  // The final answer of a payment that did not settle: a 402 and its receipt.
  // `reason`: insufficient_funds is a verdict on the buyer's payment;
  // timeout is ours (src/settle-fault.js).
  const failed = (req, reason = "insufficient_funds") => { req.res.statusCode = 402; req.res.setHeader("PAYMENT-RESPONSE", receipt(reason)); req.res.emit("finish"); };
  const settled = (req) => { req.res.statusCode = 200; req.res.emit("finish"); };
  const consult = async (req) => { try { await b.gatewaySettleBreakerCheck(req); return true; } catch (e) { if (e.statusCode === 429 || e.statusCode === 503) return false; throw e; } };
  const wallet = (i) => "0x" + i.toString(16).padStart(40, "0");
  const warn = console.warn, log = console.log;
  const quiet = () => { console.warn = () => {}; };
  const loud = () => { console.warn = warn; console.log = log; };

  const meter = await import("../src/settle-first-meter.js");
  await ok(b.SETTLE_FIRST_UNSETTLED_MAX === 2 && b.settleFirstEnabled() && !b.settleFirstEnabled({ GATEWAY_SETTLE_FIRST: "off" }) && b.settleFirstEnabled({ GATEWAY_SETTLE_FIRST: "anything" })
    && meter.settleFirstSwitch({}) === "auto" && meter.settleFirstSwitch({ GATEWAY_SETTLE_FIRST: "always" }) === "always" && meter.settleFirstSwitch({ GATEWAY_SETTLE_FIRST: "off" }) === "off"
    && meter.settleFirstBudgetUsd({}) === 5 && meter.settleFirstBudgetUsd({ GATEWAY_SETTLE_FIRST_BUDGET_USD: "2.5" }) === 2.5 && meter.settleFirstBudgetUsd({ GATEWAY_SETTLE_FIRST_BUDGET_USD: "-1" }) === 5 && meter.settleFirstBudgetUsd({ GATEWAY_SETTLE_FIRST_BUDGET_USD: "$5" }) === 5,
    `defaults: settle first is armed (only GATEWAY_SETTLE_FIRST=off disarms it), the budget mode is automatic at $${meter.settleFirstBudgetUsd({})} (a malformed or non-positive budget reads the default), and a key may hold ${b.SETTLE_FIRST_UNSETTLED_MAX} unsettled runs`);

  // ---- the server's part, as server.js does it ---------------------------------
  // A run the plan names as due settles first (here: its payment does not
  // settle, so nothing runs and nothing is metered). A run that is not due is
  // served first; a never-settled wallet's run puts its price at risk until
  // it ends, and when it ends unsettled its upstream cost is metered (the
  // listener server.js registers, priced here at COST).
  const PRICE = 0.02, COST = 0.02;
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const settleFirstRefused = new WeakSet();
  b.setUnsettledRunListener((req) => { if (!settleFirstRefused.has(req)) meter.noteUnsettledRunCost(req.__cost ?? COST, clock); });
  const resetAll = async () => { await b._gatewaySettleBreakerReset(); meter._resetSettleFirstMeterForTest(); };
  /** Admit one run: its plan, and for a never-settled wallet served first, its reservation. */
  async function admit(r) {
    const plan = await b.gatewaySettleFirstPlan(r, { now: clock });
    let due = plan.due;
    if (!due && plan.neverSettled) {
      const a = meter.admitServedFirst(PRICE, { now: clock });
      if (!a.on) return { due: null, release: a.release };
      due = { reason: "never-settled", mode: a.why };
    }
    if (due) { settleFirstRefused.add(r); return { due, release: () => {} }; }
    return { due: null, release: () => {} };
  }

  // ---- wallet rotation --------------------------------------------------------
  // Each new wallet calls until its key is refused; none of its payments
  // settle. Served first, each run is upstream spend with nothing paid.
  async function rotation(W) {
    await resetAll();
    let servedUnpaid = 0, settledFirst = 0, refusedOnFirstCall = 0;
    for (let i = 1; i <= W; i++) {
      for (let k = 0; k < 50; k++) {
        const r = reqOf(wallet(i));
        if (!(await consult(r))) { if (k === 0) refusedOnFirstCall++; break; }
        const a = await admit(r);
        if (a.due) settledFirst++; else servedUnpaid++;
        a.release();
        failed(r);
      }
    }
    return { servedUnpaid, settledFirst, refusedOnFirstCall };
  }
  quiet(); console.log = () => {};
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const before = await rotation(500);
  delete process.env.GATEWAY_SETTLE_FIRST;
  const after = await rotation(500);
  process.env.GATEWAY_SETTLE_FIRST = "always";
  const always = await rotation(500);
  delete process.env.GATEWAY_SETTLE_FIRST;
  loud();
  const crossing = Math.round(meter.settleFirstBudgetUsd() / COST);
  await ok(before.servedUnpaid === 522 && before.settledFirst === 0 && before.refusedOnFirstCall === 0,
    `rotation, every run served first (the switch off, as main serves): 500 new wallets are served ${before.servedUnpaid} runs that are never paid, and the total grows with the wallet count`);
  await ok(after.servedUnpaid === crossing && after.settledFirst > 0 && after.refusedOnFirstCall === 0,
    `rotation, the budget mode: the same 500 wallets are served ${after.servedUnpaid} unpaid runs, exactly the runs that crossed the $${meter.settleFirstBudgetUsd()} budget at $${COST} each; after that ${after.settledFirst} payments were asked to settle first and none ran unpaid; no new wallet is refused its first call`);
  await ok(always.servedUnpaid === 0 && always.refusedOnFirstCall === 0, `rotation, GATEWAY_SETTLE_FIRST=always: no run is served unpaid (${always.servedUnpaid})`);

  // ---- one new wallet, calls in flight together -------------------------------
  // All admitted before any of them ends: the meter sees them only through
  // what is at risk in flight.
  async function together(cover, C = 300) {
    await resetAll();
    const admitted = [];
    let due = 0;
    for (let k = 0; k < C; k++) {
      const r = reqOf(wallet(9001), { cover });
      if (!(await consult(r))) continue;
      const a = await admit(r);
      if (a.due) due++;
      admitted.push([r, a]);
    }
    for (const [r, a] of admitted) { a.release(); failed(r); }
    return { admitted: admitted.length, servedUnpaid: admitted.length - due };
  }
  quiet(); console.log = () => {};
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const coveredOff = await together("covered"), unreadOff = await together("unread");
  delete process.env.GATEWAY_SETTLE_FIRST;
  const coveredOn = await together("covered"), unreadOn = await together("unread");
  loud();
  const atRiskCrossing = Math.round(meter.settleFirstBudgetUsd() / PRICE);
  await ok(coveredOff.servedUnpaid === 300 && unreadOff.servedUnpaid > 0, `calls in flight together, the switch off: one new wallet admitted as covered is served ${coveredOff.servedUnpaid} of 300 unpaid (${unreadOff.servedUnpaid} when its balance was not read)`);
  await ok(coveredOn.servedUnpaid === atRiskCrossing && unreadOn.servedUnpaid === Math.min(unreadOff.servedUnpaid, atRiskCrossing) && coveredOn.admitted === 300,
    `calls in flight together, the budget mode: the same wallet is served ${coveredOn.servedUnpaid} unpaid runs, the ones whose price at risk crossed the budget; the other ${300 - coveredOn.servedUnpaid} settle first, and all ${coveredOn.admitted} covered calls were admitted (none refused)`);

  // ---- a paced attacker: under any per-minute threshold ------------------------
  // One new wallet every 7 minutes for three days, each run never paid.
  // Rolling 24 hours: the unpaid dollars inside any 24 hours stay within the
  // budget and one run; the mode turns on, and back off as the window rolls.
  {
    await resetAll();
    quiet(); console.log = () => {};
    const unpaidAt = [];
    let onSeen = false, offAgain = false;
    const start = clock;
    for (let i = 0; clock < start + 72 * 3600_000; i++, clock += 7 * 60_000) {
      const r = reqOf(wallet(20000 + i));
      r.__cost = 0.05;
      if (!(await consult(r))) continue;
      const a = await admit(r);
      if (a.due) onSeen = true; else { unpaidAt.push(clock); if (onSeen) offAgain = true; }
      a.release();
      failed(r);
    }
    loud();
    let worst = 0;
    for (const t of unpaidAt) worst = Math.max(worst, unpaidAt.filter((u) => u > t - 24 * 3600_000 && u <= t).length * 0.05);
    await ok(onSeen && offAgain && worst <= meter.settleFirstBudgetUsd() + 0.05 + 1e-9 && unpaidAt.length <= 3 * Math.ceil(meter.settleFirstBudgetUsd() / 0.05) + 3,
      `a paced attacker (one new wallet every 7 minutes for 72 hours): ${unpaidAt.length} runs served unpaid in all, at most $${worst.toFixed(2)} inside any 24 hours (budget $${meter.settleFirstBudgetUsd()}); the mode turned on and, as the window rolled, off again`);
    clock = Date.parse("2026-11-01T00:00:00Z");
  }

  // ---- the meter itself ---------------------------------------------------------
  {
    await resetAll();
    const t0 = clock;
    const m0 = meter.settleFirstBudgetMode({ now: t0 });
    meter.noteUnsettledRunCost(4.99, t0);
    const m1 = meter.settleFirstBudgetMode({ now: t0 });
    const rel = meter.reserveAtRisk(0.02, t0);
    const m2 = meter.settleFirstBudgetMode({ now: t0 });
    rel(); rel();
    const m3 = meter.settleFirstBudgetMode({ now: t0 });
    meter.noteUnsettledRunCost(0.01, t0 + 60_000);
    const m4 = meter.settleFirstBudgetMode({ now: t0 + 60_000 });
    const m5 = meter.settleFirstBudgetMode({ now: t0 + 24 * 3600_000 + 30_000 });
    const m6 = meter.settleFirstBudgetMode({ now: t0 + 24 * 3600_000 + 120_000 });
    await ok(!m0.on && m0.why === "under-budget" && !m1.on && m2.on && m2.why === "budget" && !m3.on && m4.on && !m5.on && !m6.on,
      `the meter: off at $0, off at $4.99 unsettled, on with $0.02 more at risk, off when that run ends, on at $5.00 unsettled, off once the window rolls past the older cost (${[m0, m1, m2, m3, m4, m5, m6].map((m) => (m.on ? "on" : "off")).join(" ")})`);
    meter._resetSettleFirstMeterForTest();
    meter.noteUnsettledRunCost(5, t0);
    meter.noteUnsettledRunCost(-3, t0); meter.noteUnsettledRunCost(Number.NaN, t0); meter.noteUnsettledRunCost("9", t0);
    const st = meter.settleFirstMeterStatus({ now: t0 + 61_000 });
    await ok(st.unsettledUsd24h === 5 && st.atRiskUsd === 0 && st.budgetMode === "on" && st.shared === false, `a negative, NaN or text amount adds nothing; the operator view carries the figures (${JSON.stringify(st)})`);
    process.env.GATEWAY_SETTLE_FIRST = "always";
    await resetAll();
    const forced = meter.settleFirstBudgetMode({ now: t0 });
    process.env.GATEWAY_SETTLE_FIRST = "off";
    meter.noteUnsettledRunCost(50, t0);
    const off = meter.settleFirstBudgetMode({ now: t0 });
    delete process.env.GATEWAY_SETTLE_FIRST;
    await ok(forced.on && forced.why === "always" && !off.on, "GATEWAY_SETTLE_FIRST=always turns the mode on whatever the meter; off keeps it off whatever the meter");
    // The run's own upstream cost, noted inside its request scope and read after.
    const { requestTimingMiddleware } = await import("../src/request-timing.js");
    const fakeRes = new EventEmitter(); fakeRes.statusCode = 200; fakeRes.locals = {};
    const fakeReq = { method: "POST", path: "/v1/chat" };
    await new Promise((done) => requestTimingMiddleware(() => "x")(fakeReq, fakeRes, () => { meter.bindRunScope(fakeReq); meter.noteRunUpstreamUsd(0.004); meter.noteRunUpstreamUsd(0.001); meter.noteRunUpstreamUsd(-1); done(); }));
    await ok(Math.abs(meter.runUpstreamUsdOf(fakeReq) - 0.005) < 1e-12 && meter.runUpstreamUsdOf({}) === 0 && meter.runUpstreamUsdOf(null) === 0, `a run's upstream cost is the sum noted in its own scope (${meter.runUpstreamUsdOf(fakeReq)}); a request with no scope reads 0`);
    await resetAll();
  }

  // ---- normal operation, under the budget: a new wallet is served first --------
  {
    await resetAll();
    const NEWW = "0x" + "ce".repeat(20);
    const p = await b.gatewaySettleFirstPlan(reqOf(NEWW), { now: clock });
    await ok(p.due === null && p.neverSettled === true, "under the budget a wallet that has never settled is not due: it is served first, as on main (its price is only put at risk)");
  }

  // ---- a wallet WITH history whose runs do not settle, whatever the cause ----
  const PAYER = "0x" + "ab".repeat(20), NONCE = "0x" + "11".repeat(32);
  paid.add(PAYER);
  async function unsettledRuns(reason, N = 200) {
    await b._gatewaySettleBreakerReset();
    let served = 0, first = 0, refusedAt = null;
    for (let i = 1; i <= N; i++) {
      const r = reqOf(PAYER, { nonce: NONCE });
      if (!(await consult(r))) { if (refusedAt === null) refusedAt = i; continue; }
      if (await b.gatewaySettleFirstDue(r)) first++; else served++;
      failed(r, reason);
    }
    return { served, first, refusedAt };
  }
  quiet();
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const oursOff = await unsettledRuns("timeout");
  delete process.env.GATEWAY_SETTLE_FIRST;
  const oursOn = await unsettledRuns("timeout");
  const buyerOn = await unsettledRuns("insufficient_funds");
  loud();
  await ok(oursOff.served === 200 && oursOff.refusedAt === null, `a wallet with paid history, one authorization, 200 runs that fail to settle for a cause that is ours, the switch off: all ${oursOff.served} are served and none is refused`);
  await ok(oursOn.served === b.SETTLE_FIRST_UNSETTLED_MAX && oursOn.first === 200 - b.SETTLE_FIRST_UNSETTLED_MAX && oursOn.refusedAt === null,
    `settle first: ${oursOn.served} are served (the threshold), the other ${oursOn.first} have their payment settled first, and the key is never refused`);
  await ok(buyerOn.served === 2 && buyerOn.refusedAt === 4,
    `a verdict on the buyer's payment still refuses the key at its third failure, as before (served ${buyerOn.served}, first refused on call ${buyerOn.refusedAt}): the refusal count is unchanged`);

  // A settled call ends the run of unsettled runs; the authorization's own
  // count stays with that authorization.
  await b._gatewaySettleBreakerReset();
  quiet();
  for (let i = 0; i < 2; i++) { const r = reqOf(PAYER); await consult(r); failed(r, "timeout"); }
  loud();
  const dueAfterTwo = await b.gatewaySettleFirstDue(reqOf(PAYER));
  { const r = reqOf(PAYER); await consult(r); settled(r); }
  const dueAfterSettle = await b.gatewaySettleFirstDue(reqOf(PAYER));
  await ok(dueAfterTwo?.reason === "unsettled-runs" && dueAfterSettle === null, `two unsettled runs put a wallet with history on settle first (${dueAfterTwo?.reason}); one settled call puts it back (${dueAfterSettle})`);
  // One authorization shown again and again between the wallet's settled calls.
  await b._gatewaySettleBreakerReset();
  quiet();
  for (let i = 0; i < 2; i++) {
    const again = reqOf(PAYER, { nonce: NONCE }); await consult(again); failed(again, "timeout");
    const fresh = reqOf(PAYER); await consult(fresh); settled(fresh);
  }
  loud();
  const sameAuth = await b.gatewaySettleFirstDue(reqOf(PAYER, { nonce: NONCE })), otherAuth = await b.gatewaySettleFirstDue(reqOf(PAYER));
  await ok(sameAuth?.reason === "authorization" && otherAuth === null, `one authorization that failed to settle twice settles first when shown again (${sameAuth?.reason}), though the wallet's other payments settled between; a new authorization from the wallet does not (${otherAuth})`);
  // Counted per network, like every count of this breaker.
  await b._gatewaySettleBreakerReset();
  quiet();
  for (let i = 0; i < 2; i++) { const r = reqOf(PAYER, { network: "eip155:137" }); await consult(r); failed(r, "timeout"); }
  loud();
  await ok((await b.gatewaySettleFirstDue(reqOf(PAYER, { network: "eip155:137" })))?.reason === "unsettled-runs" && (await b.gatewaySettleFirstDue(reqOf(PAYER))) === null, "the count is the wallet's on the network its payment names: another network is not affected");
  // The catalog consult's failures (global: false) are not /v1 runs.
  await b._gatewaySettleBreakerReset();
  quiet();
  for (let i = 0; i < 3; i++) { const r = reqOf(PAYER); try { await b.gatewaySettleBreakerCheck(r, { global: false }); } catch { /* refused at its count */ } failed(r, "timeout"); }
  loud();
  await ok((await b.gatewaySettleFirstDue(reqOf(PAYER))) === null, "a failure recorded by the catalog consult alone (not a /v1 run) is not counted toward settle first");

  // ---- THE RESEND BOUND: a resend of a payment settled first that is not served ----
  // It runs with no new payment: counted toward settling the wallet's next
  // runs first and on the budget meter, like a run that did not settle; never
  // toward refusing the wallet. A served resend is not.
  {
    const { markSettledFirstResend } = await import("../src/settle-first.js");
    let metered = 0;
    b.setUnsettledRunListener(() => { metered++; });
    const resend = (status) => { const r = reqOf(PAYER, { nonce: NONCE }); markSettledFirstResend(r, { tx: "0x" + "ab".repeat(32) }); return { r, end: () => { r.res.statusCode = status; r.res.emit("finish"); } }; };
    await b._gatewaySettleBreakerReset();
    quiet();
    for (let i = 0; i < 2; i++) { const { r, end } = resend(200); await consult(r); end(); }
    loud();
    const dueServed = await b.gatewaySettleFirstDue(reqOf(PAYER)), meteredServed = metered;
    await b._gatewaySettleBreakerReset();
    quiet();
    let refused = 0;
    for (let i = 0; i < 6; i++) { const { r, end } = resend(502); if (!(await consult(r))) refused++; end(); }
    loud();
    const dueFailed = await b.gatewaySettleFirstDue(reqOf(PAYER)), dueAuth = await b.gatewaySettleFirstDue(reqOf(PAYER, { nonce: NONCE }));
    const servedAfter = await consult(reqOf(PAYER));
    b.setUnsettledRunListener((req) => { if (!settleFirstRefused.has(req)) meter.noteUnsettledRunCost(req.__cost ?? COST, clock); });
    await ok(dueServed === null && meteredServed === 0, `a resend that is served is the payment's settled call: not an unsettled run, not metered (${dueServed?.reason}, ${meteredServed})`);
    await ok(dueFailed?.reason === "unsettled-runs" && dueAuth?.reason === "unsettled-runs" && metered === 6 && refused === 0 && servedAfter === true,
      `each resend that is not served counts like a run that did not settle: the wallet settles first (${dueFailed?.reason}), each is metered (${metered}), and the wallet is never refused for them (${refused} refused)`);
  }

  // ---- where "never settled" comes from ---------------------------------------
  // (Read with the mode forced on: under the budget no never-settled run is due.)
  process.env.GATEWAY_SETTLE_FIRST = "always";
  await b._gatewaySettleBreakerReset();
  const NEW = "0x" + "cd".repeat(20);
  await ok((await b.gatewaySettleFirstDue(reqOf(NEW)))?.reason === "never-settled" && (await b.gatewaySettleFirstDue(reqOf(PAYER))) === null, "a wallet with no paid sale on the books settles first (never-settled); one with a paid sale does not");
  { const r = reqOf(NEW); await consult(r); settled(r); }
  await ok((await b.gatewaySettleFirstDue(reqOf(NEW))) === null, "a settled call recorded in this process is settled history at once, before the sale row is read back from the books");
  await b._gatewaySettleBreakerReset();
  ledger = { read: () => { throw new Error("ledger down"); }, loaded: () => true };
  const thrown = await b.gatewaySettleFirstDue(reqOf(PAYER));
  ledger = { read: (p) => paid.has(p), loaded: () => false };
  const unloaded = await b.gatewaySettleFirstDue(reqOf(PAYER));
  b.setGatewaySettleBreakerPaidSaleReaderForTest(null);
  b.setGatewaySettleBreakerSalesLedger({});
  const unregistered = await b.gatewaySettleFirstDue(reqOf(PAYER));
  ledger = { read: (p) => paid.has(p), loaded: () => true };
  useLedger();
  await ok(thrown?.reason === "history-unread" && unloaded?.reason === "history-unread" && unregistered?.reason === "history-unread",
    `a ledger that cannot answer (a read that throws: ${thrown?.reason}; a first load not landed: ${unloaded?.reason}; none registered: ${unregistered?.reason}) reads as no paid sale here, so the payment settles first and nobody is refused`);
  // ... and the same unreadable ledger never puts a wallet under the lower
  // refusing count (that read errs toward "paid", because its answer refuses).
  await ok((await consult(reqOf(PAYER))) === true, "that unreadable ledger refuses nobody: the consult serves the wallet as before");
  const ipOnly = { header: () => undefined, headers: {}, ip: "203.0.113.9", res: reqOf(NEW).res, method: "POST", path: "/v1/chat" };
  await ok((await b.gatewaySettleFirstDue(ipOnly)) === null && (await b.gatewaySettleFirstDue(Object.assign(reqOf(NEW), { creditsKeyId: "ck_1", header: () => undefined }))) === null,
    "a key that names no wallet (a client address, a credits key) never settles first");
  const lane = reqOf(NEW); b.settleBreakerOtherLane(lane);
  const forcedReason = (await b.gatewaySettleFirstDue(reqOf(NEW)))?.mode;
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const off = await b.gatewaySettleFirstDue(reqOf(NEW));
  delete process.env.GATEWAY_SETTLE_FIRST;
  await ok(forcedReason === "always", `a never-settled run due in the budget mode names why the mode is on (${forcedReason})`);
  await ok((await b.gatewaySettleFirstDue(lane)) === null && off === null, "a run another gate settles is never due, and GATEWAY_SETTLE_FIRST=off reads no run as due");

  // ---- counted for the operator, never per wallet ------------------------------
  await b._gatewaySettleBreakerReset();
  b.noteSettleFirst("armed", { reason: "never-settled" }); b.noteSettleFirst("armed", { reason: "unsettled-runs" });
  console.log = () => {};
  b.noteSettleFirst("settled", { req: reqOf(NEW), reason: "never-settled", slug: "v1-chat", ms: 12 });
  b.noteSettleFirst("refused", { req: reqOf(NEW), reason: "never-settled", slug: "v1-chat", ms: 12 });
  loud();
  b.noteSettleFirst("owed"); b.noteSettleFirst("not-reached");
  const st = b.gatewaySettleBreakerStatus().settleFirst;
  await ok(st.enabled === true && st.armed["never-settled"] === 1 && st.armed["unsettled-runs"] === 1 && st.settled === 1 && st.refused === 1 && st.owed === 1 && st.notReached === 1 && st.unsettledMax === 2,
    `the status counts runs armed by reason, payments settled first, payments that did not settle, charges owed and runs that never reached their settle point (${JSON.stringify(st)})`);
  const pub = await b.gatewaySettleFailuresStatus(), full = await b.gatewaySettleFailuresStatus({ full: true });
  await ok(Object.keys(pub).join() === "status" && full.settleFirst?.settled === 1 && !JSON.stringify(full.settleFirst).includes(NEW.slice(2, 12)), "the public word is the status alone; the operator view adds the counts, never a wallet");
  await b._gatewaySettleBreakerReset();
  b.setGatewaySettleBreakerPaidSaleReaderForTest(null);

  // ---- the request-side pieces (src/settle-first.js) ---------------------------
  const sf = await import("../src/settle-first.js");
  {
    const req = {};
    let runs = 0;
    await ok(sf.settleBeforeUpstream(req) === undefined && sf.settleBeforeUpstream() === undefined, "a request that is not armed pays nothing at a settle point: the call returns at once");
    sf.armSettleFirst(req, { reason: "never-settled", run: async () => { runs++; await sleep(5); } });
    let ambientReq = req;
    sf.setSettleFirstAmbient(() => ambientReq);
    await Promise.all([sf.settleBeforeUpstream(req), sf.settleBeforeUpstream(req), sf.settleBeforeUpstream()]);
    await sf.settleBeforeUpstream(req);
    await ok(runs === 1 && sf.settleFirstStarted(req) && sf.settleFirstReasonOf(req) === "never-settled", `an armed request settles once however many upstream calls reach the point, together or in turn, by request or through the ambient reader (${runs} run)`);
    const late = {};
    let lateRuns = 0;
    sf.armSettleFirst(late, { run: async () => { lateRuns++; } });
    ambientReq = late;
    sf.disarmSettleFirst(late);
    await sf.settleBeforeUpstream(); await sf.settleBeforeUpstream(late);
    sf.setSettleFirstAmbient(() => { throw new Error("no scope"); });
    const thrown = sf.settleBeforeUpstream();
    sf.setSettleFirstAmbient(null);
    await ok(lateRuns === 0 && !sf.settleFirstStarted(late) && thrown === undefined, "once the handler ended (the request disarmed), nothing that inherited its scope can start a settlement, and a reader that throws settles nothing");
    const refusedReq = {};
    sf.armSettleFirst(refusedReq, { run: async () => { throw sf.settleFirstRefusal({ status: 402, headers: {}, body: {} }); } });
    let e1 = null, e2 = null;
    try { await sf.settleBeforeUpstream(refusedReq); } catch (e) { e1 = e; }
    try { await sf.settleBeforeUpstream(refusedReq); } catch (e) { e2 = e; }
    await ok(sf.isSettleFirstRefusal(e1) && e1 === e2 && e1.statusCode === 402 && sf.settleFirstRefusalOf(refusedReq) === e1 && sf.settledFirstOf(refusedReq) === null, "a payment that did not settle refuses every upstream call of the run with the one refusal (a 402, which no fallback chain walks past), and the request reads as not settled");
    await ok(sf.settledFirstOf(Object.create({ [Symbol.for("x")]: 1 })) === null && sf.settledFirstOf(null) === null, "a request with no state of its own never reads as settled");
    await ok(sf.settleFirstFailedNote(502) === "settle-first-failed: answer http 502" && sf.settleFirstFailedNote(499) === "settle-first-failed: answer not delivered" && sf.isSettleFirstFailedRefund({ note: sf.settleFirstFailedNote(504) }) && !sf.isSettleFirstFailedRefund({ note: "held for review" }) && !sf.isSettleFirstFailedRefund({}),
      "the refund class is the note's first word: settle-first-failed, then how the run ended");
  }
  // ---- what the failure says (src/settle-first-body.js) ------------------------
  {
    const body = await import("../src/settle-first-body.js");
    const tx = "0x" + "ab".repeat(32);
    const out = JSON.parse(body.settledFirstFailureBody(JSON.stringify({ error: "Upstream error (HTTP 500). Nothing was charged.", tool: "v1-chat", charged: false }), { transaction: tx, origin: "https://example.test" }));
    await ok(out.charged === true && out.refundOwed === true && out.payment === body.SETTLED_FIRST_FAILURE_NOTE && out.transaction === tx && out.refundStatusUrl === `https://example.test/api/refunds?tx=${tx}` && !/Nothing was charged/.test(out.error) && out.error.includes("recorded as a refund owed"),
      `a failure after the settlement never says "not charged": ${out.error}`);
    await ok(body.rewriteNotChargedForSettledFirst("The upstream did not answer in time, so nothing was charged.") === "The upstream did not answer in time, so the payment settled before the call is recorded as owed and repaid after on-chain proof."
      && !/not charged/.test(body.rewriteNotChargedForSettledFirst("This call is not charged on x402."))
      && body.rewriteNotChargedForSettledFirst("This call is not charged on credits.") === "This call is not charged on credits.",
      "a clause is restated in place, a sentence scoped to x402 is restated too (this payment is on it), and one scoped to another rail stays as written");
    const { rewriteNotChargedForPush } = await import("../src/push-refusal-body.js");
    await ok(rewriteNotChargedForPush("This call is not charged on x402.") === "This call is not charged on x402." && /Tempo transfer/.test(rewriteNotChargedForPush("Bad input. Nothing was charged.")), "control: the Tempo push wording is unchanged by the shared rewriter");
    await ok(body.settledFirstFailureBody("not json") === null && body.settledFirstFailureBody("[1]") === null, "a body that is not a JSON object is left as it is");
    // A job whose run failed after the settlement says the same (src/async-jobs.js).
    const { failedRunSummary } = await import("../src/async-jobs.js");
    const { PUSH_FAILURE_NOTE } = await import("../src/push-refusal-body.js");
    const job = failedRunSummary(502, out), pushJob = failedRunSummary(502, { error: "x", charged: true, transferClaimed: true, refundOwed: true, payment: PUSH_FAILURE_NOTE }), plain = failedRunSummary(502, { error: "x" });
    await ok(job.includes(body.SETTLED_FIRST_FAILURE_NOTE) && !/Tempo/.test(job) && !/Nothing was charged/.test(job) && pushJob.includes(PUSH_FAILURE_NOTE) && /Nothing was charged\./.test(plain),
      `a failed job's summary says the payment settled before the run is owed back; a Tempo push failure and an uncharged failure keep their words (${job})`);
  }
  // ---- a resend's hold whose run never ended is owed again (the held sweep) ----
  {
    const { createHeldClaimSweep } = await import("../src/tempo-push-debts.js");
    const { settleFirstResendHeldFrom } = await import("../src/settle-first.js");
    const NOW = Date.parse("2026-11-21T12:00:00Z");
    const note = "settle-first-failed: answer http 502";
    const held = (ev, mins, n = note) => ({ evidence: ev, network: "eip155:8453", status: "void", note: `${n}; resend of the same payment: running [attempt 0a1b2c3d]`, resolvedAt: NOW - mins * 60_000 });
    const rows = [held("0xold", 45), held("0xyoung", 5), held("0xserved", 45), held("0xother", 45, "held for review")];
    const reopened = [], renoted = [];
    const sweep = createHeldClaimSweep({
      listVoid: async () => rows, now: () => NOW, maxAgeMs: 30 * 60_000, log: () => {},
      saleFor: async (tx) => (tx === "0xserved" ? { tx } : null),
      reopenHeld: async (ev, o) => { reopened.push([ev, o.note, o.held]); return true; },
      renoteVoid: async (ev, from, to) => { renoted.push([ev, to]); return true; },
    });
    const out = await sweep.sweep();
    await ok(settleFirstResendHeldFrom(rows[0]) === note && settleFirstResendHeldFrom(rows[3]) === null && settleFirstResendHeldFrom({ ...rows[0], status: "owed" }) === null
      && reopened.length === 1 && reopened[0][0] === "0xold" && reopened[0][1] === note && renoted.length === 1 && renoted[0][0] === "0xserved" && /served on the resend/.test(renoted[0][1]) && out.reopened === 1 && out.served === 1,
      `a debt held for its payment's resend whose run never ended is owed again under its class after the hold's age; one whose sale is on the books is noted served; a young hold and another class are left (${JSON.stringify({ reopened, renoted })})`);
  }

  // ---- every HTTP resource server over the core server settles a payment once --
  // The core server's verified-payment stash lets any request it verified
  // settle at its settle point, so every x402 HTTP server built over that core
  // (the HTTP routes and the connector's twins) must answer the after-handler
  // settlement from that settle, not call the facilitator a second time.
  {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { installSettleOnceEcho, hasSettleOnceEcho } = await import("../src/payments.js");
    const { armSettleFirst, markSettledFirst } = await import("../src/settle-first.js");
    const src = join(import.meta.dirname, "..", "src");
    const files = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".js")) files.push(f); } };
    walk(src);
    const builds = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n");
      lines.forEach((l, i) => { if (/\bx402HTTPResourceServer\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) builds.push({ file: f.slice(src.length + 1), line: i + 1, text: l.trim(), stash: /registerVerifiedPaymentStash\s*\(/.test(text) }); });
    }
    const overStash = builds.filter((b) => b.stash);
    const unechoed = overStash.filter((b) => !/installSettleOnceEcho\(\s*new x402HTTPResourceServer\(\s*server\s*,/.test(b.text));
    const pay = readFileSync(join(src, "payments.js"), "utf8");
    const viaHelper = (name) => new RegExp(`const ${name} = [^\\n]*httpServerOverCore\\(`).test(pay);
    await ok(overStash.length === 1 && unechoed.length === 0 && viaHelper("httpServer") && viaHelper("mcpHttpServer"),
      `every x402 HTTP server built over the core server that stashes verified payments is built by the one helper that installs the settle-once echo, the HTTP routes and the connector's twins both (${JSON.stringify(builds.map((b) => `${b.file}:${b.line}${b.stash ? " (stash)" : ""}`))})`);
    // What the echo does: a payment settled at its settle point is answered
    // from that settlement; anything else reaches the facilitator.
    let calls = 0;
    const fake = { processSettlement: async () => { calls++; return { success: true, transaction: "0xsecond", headers: {} }; }, createSettlementHeaders: (r) => ({ "PAYMENT-RESPONSE": r.transaction }) };
    installSettleOnceEcho(fake);
    installSettleOnceEcho(fake);
    const payment = { x402Version: 2 };
    const req = {};
    armSettleFirst(req, { run: async () => {} });
    markSettledFirst(req, { result: { success: true, transaction: "0xfirst", network: "eip155:8453" }, requirements: { network: "eip155:8453" }, paymentPayload: payment, at: Date.now() });
    const ctx = { request: { adapter: { req } } };
    const echoed = await fake.processSettlement(payment, { network: "eip155:8453" }, undefined, ctx);
    const other = await fake.processSettlement({ x402Version: 2 }, { network: "eip155:8453" }, undefined, ctx);
    const before = await fake.processSettlement(payment, { network: "eip155:8453" }, undefined, ctx, undefined, undefined, "before-handler");
    await ok(hasSettleOnceEcho(fake) && echoed.success === true && echoed.transaction === "0xfirst" && echoed.headers["PAYMENT-RESPONSE"] === "0xfirst" && other.transaction === "0xsecond" && before.transaction === "0xsecond" && calls === 2,
      `the echo answers the settled-first payment's after-handler settlement from its settle point with no facilitator call; another payment and the settle point itself still settle; installing twice wraps once (${calls} facilitator calls)`);
  }

  // ---- which payments can settle first (src/payments.js) -----------------------
  {
    const { settleFirstNetworkFor, SETTLE_FIRST_NAMESPACES, settleFirstPaymentKindFor } = await import("../src/payments.js");
    const gw = { requirements: { scheme: "exact", network: "eip155:8453", extra: { name: "GatewayWalletBatched", version: "1" } }, paymentPayload: { accepted: { scheme: "exact", network: "eip155:8453", extra: { name: "GatewayWalletBatched", version: "1" } } } };
    const kinds = [
      settleFirstPaymentKindFor({ requirements: { scheme: "exact", network: "eip155:8453" }, paymentPayload: {} }),
      settleFirstPaymentKindFor({ requirements: { scheme: "upto", network: "eip155:8453" }, paymentPayload: {} }),
      settleFirstPaymentKindFor(gw),
      settleFirstPaymentKindFor({ requirements: { scheme: "batch-settlement", network: "eip155:8453" }, paymentPayload: {} }),
      settleFirstPaymentKindFor(null),
    ];
    await ok(JSON.stringify(kinds) === JSON.stringify(["exact", "upto", "gateway", null, null]),
      `option A reads the payment's kind: an exact payment can settle first; an upto and a Circle Gateway batched payment are asked for an exact one while settle first applies; anything else is left as it was (${JSON.stringify(kinds)})`);
    const exact = (network, extra = {}) => ({ requirements: { scheme: "exact", network, ...extra }, paymentPayload: { accepted: { scheme: "exact", network } } });
    const yes = ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", "stellar:pubnet"].map((n) => settleFirstNetworkFor(exact(n)));
    const no = [
      settleFirstNetworkFor({ requirements: { scheme: "upto", network: "eip155:8453" }, paymentPayload: {} }),
      settleFirstNetworkFor({ requirements: { scheme: "batch-settlement", network: "eip155:8453" }, paymentPayload: {} }),
      settleFirstNetworkFor(exact("eip155:8453", { extra: { name: "GatewayWalletBatched", version: "1" } })),
      settleFirstNetworkFor(exact("tempo:4217")),
      settleFirstNetworkFor(null),
    ];
    await ok(yes.every(Boolean) && no.every((x) => x === null) && SETTLE_FIRST_NAMESPACES.join() === "eip155,solana,algorand,stellar",
      `only an exact payment on an x402 rail can settle first (${yes.join(", ")}); upto, a payment channel, a Circle Gateway batched payment and any other namespace cannot (${JSON.stringify(no)})`);
  }
}

if (ONLY.includes("2") || ONLY.includes("3") || ONLY.includes("4")) await import("./lib/settle-first-paid.js").then((m) => m.run({ ok, fail, parts: ONLY, setRig: (r) => { rig = r; } }));

console.log(`\n${pass} checks passed`);
process.exit(0);
