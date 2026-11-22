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
const ONLY = (process.env.SETTLE_FIRST_PARTS || "1,2,3").split(",");

// =============================================================================
// PART 1: the breaker's own rules, offline
// =============================================================================
if (ONLY.includes("1")) {
  delete process.env.GATEWAY_SETTLE_FIRST;
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

  await ok(b.SETTLE_FIRST_UNSETTLED_MAX === 2 && b.settleFirstEnabled() && !b.settleFirstEnabled({ GATEWAY_SETTLE_FIRST: "off" }) && b.settleFirstEnabled({ GATEWAY_SETTLE_FIRST: "anything" }),
    `defaults: settle-first is on, GATEWAY_SETTLE_FIRST=off is the only value that turns it off, and a key may hold ${b.SETTLE_FIRST_UNSETTLED_MAX} unsettled runs`);

  // ---- wallet rotation --------------------------------------------------------
  // One call of the model: the handler's consult (which may refuse the key),
  // then the run. A run that is due settles first: this caller's payments do
  // not settle, so it ends as the settle-failure 402 and the handler's
  // upstream work never runs. A run that is not due is served, and then fails
  // to settle: served and not paid.
  async function rotation(W) {
    await b._gatewaySettleBreakerReset();
    let servedUnpaid = 0, settledFirst = 0, refusedOnFirstCall = 0;
    for (let i = 1; i <= W; i++) {
      for (let k = 0; k < 50; k++) {
        const r = reqOf(wallet(i));
        if (!(await consult(r))) { if (k === 0) refusedOnFirstCall++; break; }
        if (await b.gatewaySettleFirstDue(r)) settledFirst++; else servedUnpaid++;
        failed(r);
      }
    }
    return { servedUnpaid, settledFirst, refusedOnFirstCall };
  }
  quiet();
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const before = await rotation(500);
  delete process.env.GATEWAY_SETTLE_FIRST;
  const after = await rotation(500);
  loud();
  await ok(before.servedUnpaid === 522 && before.settledFirst === 0 && before.refusedOnFirstCall === 0,
    `rotation, every run settled after its handler (the switch off): 500 new wallets are served ${before.servedUnpaid} runs that are never paid, and no new wallet is refused its first call, so the total grows with the wallet count`);
  await ok(after.servedUnpaid === 0 && after.settledFirst > 0 && after.refusedOnFirstCall === 0,
    `rotation, settle first: the same 500 wallets are served ${after.servedUnpaid} unpaid runs (${after.settledFirst} payments were asked to settle first and did not), and no new wallet is refused its first call`);

  // ---- one new wallet, calls in flight together -------------------------------
  async function together(cover, C = 300) {
    await b._gatewaySettleBreakerReset();
    const admitted = [];
    let due = 0;
    for (let k = 0; k < C; k++) {
      const r = reqOf(wallet(9001), { cover });
      if (!(await consult(r))) continue;
      if (await b.gatewaySettleFirstDue(r)) due++;
      admitted.push(r);
    }
    for (const r of admitted) failed(r);
    return { admitted: admitted.length, servedUnpaid: admitted.length - due };
  }
  quiet();
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const coveredOff = await together("covered"), unreadOff = await together("unread");
  delete process.env.GATEWAY_SETTLE_FIRST;
  const coveredOn = await together("covered"), unreadOn = await together("unread");
  loud();
  await ok(coveredOff.servedUnpaid === 300 && unreadOff.servedUnpaid > 0, `calls in flight together, the switch off: one new wallet admitted as covered is served ${coveredOff.servedUnpaid} of 300 unpaid (${unreadOff.servedUnpaid} when its balance was not read)`);
  await ok(coveredOn.servedUnpaid === 0 && unreadOn.servedUnpaid === 0 && coveredOn.admitted === 300, `calls in flight together, settle first: the same wallet is served ${coveredOn.servedUnpaid} unpaid runs, covered or not, and all ${coveredOn.admitted} covered calls were admitted (none refused)`);

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

  // ---- where "never settled" comes from ---------------------------------------
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
  process.env.GATEWAY_SETTLE_FIRST = "off";
  const off = await b.gatewaySettleFirstDue(reqOf(NEW));
  delete process.env.GATEWAY_SETTLE_FIRST;
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
  // ---- which payments can settle first (src/payments.js) -----------------------
  {
    const { settleFirstNetworkFor, SETTLE_FIRST_NAMESPACES } = await import("../src/payments.js");
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

if (ONLY.includes("2") || ONLY.includes("3")) await import("./lib/settle-first-paid.js").then((m) => m.run({ ok, fail, parts: ONLY, setRig: (r) => { rig = r; } }));

console.log(`\n${pass} checks passed`);
process.exit(0);
