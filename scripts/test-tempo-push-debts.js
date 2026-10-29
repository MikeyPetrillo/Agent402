// Tempo PUSH transfers that reach us unclaimed are booked as owed, and a
// claim that is later served voids that debt (src/tempo-push-debts.js wired
// into createTempoGate, against the REAL refund ledger in a scratch dir).
//
//   - refused on input, never retried: exactly one owed row (hash, chain
//     sender, amount), no charged failure;
//   - refused on input, then presented again with a corrected body and
//     served: the row is void ("claimed on retry") and the sale booked once;
//   - refused twice: booked once;
//   - finalize refused: one owed row AND one genuine charged failure (not for
//     our own synthetic traffic); an already-claimed hash books nothing;
//   - a transfer whose debt is being refunded no longer pays for a request;
//   - a sync window's refusal (a slow route called without Prefer:
//     respond-async, src/slow-sync-window.js and src/cdn-sync-window.js) is
//     deferred to the gate for a push credential and booked as owed there;
//     the retry with the header claims the transfer and voids the row;
//   - a push credential the ROUTE refuses at the binding check (long-running,
//     identity-bound: no Tempo offer there) is booked as owed once the relay
//     confirms the transfer, and the same credential claimed on a route that
//     offers Tempo voids the row; a transfer the relay does not confirm books
//     nothing. Every slow route in the catalog is long-running today, so this
//     is the path a push credential on a slow route takes.
// The relay and the chain are stubs: offline, nothing moves.
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";

process.env.REFUND_DB_DIR = mkdtempSync(join(tmpdir(), "a402-push-debts-"));
const TREASURY = "0x000000000000000000000000000000000000dEaD";
const CUR = "0x2000000000000000000000000000000000000000";
process.env.TEMPO_API_KEY = "test-tempo-key";
process.env.TEMPO_RECIPIENT_ADDRESS = TREASURY;
process.env.TEMPO_CURRENCY = CUR;

const { createTempoGate, PUSH_SENDER_WAIT_MS, isTempoPushCredential, tempoOfferedFor } = await import("../src/mpp-tempo.js");
const { EVM_RUN_SECONDS } = await import("../src/evm-validity.js");
const { SLOW_ADVISE_SECONDS } = await import("../src/slow-routes.js");
const { isLongRunningSlug } = await import("../src/composite-spend-guard.js");
const { createTempoPushDebts, PUSH_INPUT_REFUSED_NOTE, PUSH_CLAIMED_NOTE, PUSH_SERVED_NOTE, PUSH_FINALIZE_FAILURE_STATUS, PUSH_HANGUP_AFTER_CLAIM_NOTE, PUSH_HANDLER_FAILED_AFTER_CLAIM_NOTE, PUSH_EXCEPTION, whenTempoLedgerPayerKnown } = await import("../src/tempo-push-debts.js");
const { slowSyncWindowMiddleware, SYNC_WINDOW_RETRY } = await import("../src/slow-sync-window.js");
const { cdnSyncWindowMiddleware } = await import("../src/cdn-sync-window.js");
const { wantsAsync } = await import("../src/async-jobs.js");
const { carriesPaymentAttempt } = await import("../src/payment-attempt.js");
const { isRepeatHangup, isLastingEffectHangup, HANGUP_STATUS } = await import("./refund-run.js");
const ledger = await import("../src/refund-ledger.js");
const { createReplayGuard } = await import("../src/replay-guard.js");

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

const SECRET = "push-debts-secret";
const REALM = "test.local";
const SENDER = "0x5555555555555555555555555555555555555555";
// /long and /ident are priced routes that offer no Tempo challenge (as
// server.js's priceFor marks a long-running or identity-bound route).
const priceFor = (_m, path) => (path === "/paid" || path === "/slow" ? { priceUsd: 0.05 } : path === "/long" ? { priceUsd: 0.05, longRunning: true } : path === "/ident" ? { priceUsd: 0.05, identityBound: true } : null);
let n = 0;
let credSeq = 0;
const hashFor = (i) => `0x${i.toString(16).padStart(64, "0")}`;
function pushCred(hash) {
  // A distinct expiry per credential: two challenges minted in one millisecond would share an id (and a replay key).
  const challenge = Challenge.from({ realm: REALM, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000 + (++credSeq) * 1000), request: { amount: "50000", currency: CUR, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } }, secretKey: SECRET });
  return Credential.serialize({ challenge, payload: { hash, type: "hash" }, source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" });
}

const failures = [];
const sales = [];
let synthetic = false;
let failNext = null;
let validateNext = null;
const debts = createTempoPushDebts({
  recordOwed: ledger.recordRefundOwed, voidOnClaim: ledger.voidOwedOnClaim, voidForServe: ledger.voidOwedForServe, reopenHeld: ledger.reopenHeldClaim, renoteVoid: ledger.renoteVoidRefund, renoteOwed: ledger.renoteOwedRefund, promoteToHangup: ledger.promoteOwedToHangup, restateHandlerFailure: ledger.restateOwedAsHandlerFailure, refundByEvidence: ledger.refundByEvidence,
  recordChargedFailure: (slug, status) => failures.push({ slug, status }),
  isSynthetic: () => synthetic,
  slugOf: () => "paid-tool",
});
const app = express();
app.use(express.json());
// server.js's finish path, reduced to what matters here: a settled 200 is a
// sale, and a served push claim voids its debt.
// served() is called on EVERY finish here (server.js calls it on a 200 only):
// its own guard must refuse to void anything that was not a served claim.
// A claimed push that ends >= 400 books its debt on the hash; when the hash
// already carries a row, handlerFailed restates or reopens it (as server.js).
let handlerRuns = 0;
app.use((req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode === 200 && req.tempoSettled) sales.push(req.mppTempoPushHash);
    debts.served(req, res);
    if (req.tempoSettled && res.statusCode >= 400 && !req.tempoPushRefunded) {
      const h = req.mppTempoPushHash;
      const made = ledger.recordRefundOwed({ slug: "paid-tool", network: "tempo", payer: SENDER, priceUsd: 0.05, tx: h, httpStatus: res.statusCode, synthetic: false, wire: "mpp-tempo" });
      if (!made) debts.handlerFailed(h, res.statusCode);
    }
  });
  next();
});
// The sync windows ahead of the gate, as server.js mounts them (the real
// payment-attempt, respond-async and push-credential predicates): /slow is a
// slow route whose run budget is past both bounds.
const SLOW_DEF = { slug: "slow-tool", asyncProfile: { slow: true, maxSeconds: 75, expectedSeconds: 40 } };
const asyncRouteOf = (req) => (req.path === "/slow" ? SLOW_DEF : null);
const isTempoPush = (req) => isTempoPushCredential(req.headers.authorization);
app.use((req, _res, next) => { if (req.headers["x-test-via-cdn"]) req.viaCdn = true; next(); });
app.use(cdnSyncWindowMiddleware({ asyncRouteOf, wantsAsync, carriesPaymentAttempt, isTempoPush, maxSeconds: 8, log: () => {} }));
app.use(slowSyncWindowMiddleware({ asyncRouteOf, wantsAsync, carriesPaymentAttempt, followsJobAnswer: () => false, isTempoPush, windowSeconds: 20, log: () => {} }));
// A refund send claims the debt in the moment after the gate's check and
// before the handler (another container's refund run), when armed.
let claimInWindow = null;
app.use(createTempoGate({
  secretKey: SECRET, realm: REALM, priceFor, replayGuard: createReplayGuard(),
  preValidate: (req) => (req.body?.text ? null : { status: 400, body: { error: "Missing required parameter: text" } }),
  validate: async () => { if (validateNext) { const v = validateNext; validateNext = null; return v; } return { ok: true, validation: {} }; },
  broadcast: async () => { if (failNext) { const f = failNext; failNext = null; return f; } return { ok: true, receipt: { method: "tempo", status: "success", reference: `0xr${++n}`, timestamp: new Date().toISOString() } }; },
  pushSender: async () => SENDER,
  onPushNotClaimed: (req, info) => debts.notClaimed(req, info),
  onPushInputRefused: (req, info) => debts.inputRefused(req, info),
  pushClaimAllowed: (hash) => {
    const allowed = !["sending", "paid"].includes(ledger.refundByEvidence(hash)?.status);
    if (claimInWindow === hash) { claimInWindow = null; ledger.claimRefundForSend(ledger.refundByEvidence(hash).id, "refund-run: claimed before broadcast"); }
    return allowed;
  },
  pushRowOf: (hash) => ledger.refundByEvidence(hash) || null,
}));
// server.js's claim hold, mounted right after the gate.
app.use(async (req, res, next) => {
  if (!req.tempoSettled || !req.mppTempoPushHash) return next();
  if (await debts.claimForServe(req)) return next();
  req.tempoPushRefunded = true;
  return res.status(402).json({ details: { reason: "refunded", transferClaimed: true } });
});
app.use((req, res, next) => (req.tempoSettling ? next() : res.status(402).json({ error: "Payment Required" })));
const handler = (req, res) => {
  handlerRuns++;
  if (req.body?.text === "boom") return res.status(500).json({ error: "handler failed" });
  if (req.body?.text === "slow") return setTimeout(() => res.json({ ok: true }), 400);
  // A handler refusal written for the settle-after rails, as the kits write them.
  if (req.body?.text === "refuse") return res.status(422).json({ error: "The text is over the cap. Nothing was charged.", hint: "Send a shorter text; you were not charged.", problem: { detail: "Refused before any upstream call, so nothing was charged." } });
  return res.json({ ok: true, note: "Nothing was charged for the free part." });
};
app.post("/paid", handler);
app.post("/slow", handler);
app.post("/long", handler);
app.post("/ident", handler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/paid`;
const postTo = async (path, cred, body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "content-type": "application/json", Authorization: cred, ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = (cred, body) => postTo("/paid", cred, body);
const rowsFor = (hash) => ledger.listRefunds({ status: "all", limit: 1000 }).filter((r) => r.evidence === hash);

// Control: a clean push buy books a sale and no debt.
{
  const h = hashFor(1);
  const r = await post(pushCred(h), { text: "x" });
  ok(r.status === 200 && sales.filter((s) => s === h).length === 1 && rowsFor(h).length === 0 && failures.length === 0, "control: a push buy with a valid body is served, booked once, and owes nothing");
}

// Refused on input, never retried: one owed row under the chain sender.
{
  const h = hashFor(2);
  const r = await post(pushCred(h), {});
  const rows = rowsFor(h);
  ok(r.status === 400 && r.body.transferClaimed === false && /recorded as owed/.test(r.body.payment || ""), `input refused: 400, transfer unclaimed, and the answer says it is recorded as owed (${JSON.stringify(r.body)})`);
  ok(rows.length === 1 && rows[0].status === "owed" && rows[0].network === "tempo" && rows[0].payer === SENDER && rows[0].priceUsd === 0.05 && rows[0].note === PUSH_INPUT_REFUSED_NOTE && rows[0].wire === "mpp-tempo" && rows[0].httpStatus === 400,
    `input refused and never retried: exactly one owed row keyed on the hash, under the chain-read sender (${JSON.stringify(rows)})`);
  ok(failures.length === 0 && sales.every((s) => s !== h), "input refused: no charged failure counted (the buyer can still claim it) and no sale");
}

// Refused twice (same credential), then retried with a corrected body: one
// row, void on the served claim, one sale.
{
  const h = hashFor(3);
  const cred = pushCred(h);
  await post(cred, {});
  await post(cred, {});
  ok(rowsFor(h).length === 1 && rowsFor(h)[0].status === "owed", "refused twice: booked once");
  const r = await post(cred, { text: "fixed" });
  const rows = rowsFor(h);
  ok(r.status === 200 && rows.length === 1 && rows[0].status === "void" && rows[0].note.includes(PUSH_CLAIMED_NOTE) && rows[0].note.includes(PUSH_INPUT_REFUSED_NOTE),
    `refused then served on retry: the debt is void ("${rows[0]?.note}"), never both refunded and served`);
  ok(sales.filter((s) => s === h).length === 1 && failures.length === 0, "...and the sale is booked exactly once");
  // A later refusal of the (now claimed) credential books nothing new: the
  // replay guard refuses it before the input check.
  const again = await post(cred, {});
  ok(again.status === 402 && rowsFor(h).length === 1 && rowsFor(h)[0].status === "void", "the claimed credential presented again is a replay, and the void row stays void");
}

// Refused on input, then claimed on retry but the handler FAILED: the debt
// stands (the transfer is claimed and nothing was delivered).
{
  const h = hashFor(9);
  const cred = pushCred(h);
  await post(cred, {});
  const r = await post(cred, { text: "boom" });
  ok(r.status === 500 && rowsFor(h).length === 1 && rowsFor(h)[0].status === "owed" && sales.every((s) => s !== h), `refused, then claimed but the handler failed: the debt stays owed (${r.status}, ${rowsFor(h)[0]?.status})`);
}

// Finalize refused: owed and counted as a genuine charged failure, once.
{
  const h = hashFor(4);
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  const r = await post(pushCred(h), { text: "x" });
  const rows = rowsFor(h);
  ok(r.status === 402 && r.body.details?.refundOwed === true && rows.length === 1 && rows[0].status === "owed" && rows[0].payer === SENDER, `finalize refused: 402 with the debt booked (${JSON.stringify(rows)})`);
  ok(failures.length === 1 && failures[0].status === PUSH_FINALIZE_FAILURE_STATUS && failures[0].status !== 402, `finalize refused: one charged failure, recorded with a status the genuine count includes (${JSON.stringify(failures)})`);
  // The same hash refused on input earlier, then refused at finalize: still
  // one row, and counted once when it becomes a finalize failure.
  const h2 = hashFor(5);
  const c2 = pushCred(h2);
  await post(c2, {});
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  await post(c2, { text: "x" });
  ok(rowsFor(h2).length === 1 && rowsFor(h2)[0].status === "owed" && failures.length === 2, `input refused then finalize refused: one row, one charged failure (${failures.length})`);
  ok((await debts.notClaimed({ method: "POST", path: "/paid" }, { hash: h2, payer: SENDER, amountUsd: 0.05 })) === true && failures.length === 2, "a repeat finalize failure for the same hash counts nothing new");
  // Our own synthetic traffic: booked (flagged) but not counted.
  synthetic = true;
  const h3 = hashFor(6);
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  await post(pushCred(h3), { text: "x" });
  synthetic = false;
  ok(rowsFor(h3).length === 1 && rowsFor(h3)[0].synthetic === 1 && failures.length === 2, "synthetic finalize failure: booked and flagged, not counted as a charged failure");
  // Already claimed for an earlier request: no debt, no count.
  const h4 = hashFor(7);
  failNext = { ok: false, cls: "replay", error: "Transaction hash has already been used", reason: "already used" };
  await post(pushCred(h4), { text: "x" });
  ok(rowsFor(h4).length === 0 && failures.length === 2, "finalize refused as already claimed: no debt, no count");
}

// A transfer whose debt is being refunded no longer pays for a request.
{
  const h = hashFor(8);
  const cred = pushCred(h);
  await post(cred, {});
  const row = rowsFor(h)[0];
  ok(ledger.claimRefundForSend(row.id, "test"), "setup: the debt is claimed for sending");
  const r = await post(cred, { text: "fixed" });
  ok(r.status === 402 && r.body.details?.reason === "refunded" && sales.every((s) => s !== h) && rowsFor(h)[0].status === "sending", `a transfer being refunded is refused, not claimed and served (${r.status} ${JSON.stringify(r.body.details)})`);
}

// A refund send claims the debt AFTER the gate's check and before the
// handler: the claim hold finds the row being sent, so the run is not served
// (the buyer is refunded), and the row stays with the send.
{
  const h = hashFor(30);
  const cred = pushCred(h);
  await post(cred, {});
  ok(rowsFor(h)[0]?.status === "owed", "setup: the input-refused debt is owed");
  claimInWindow = h;
  const before = handlerRuns;
  const r = await post(cred, { text: "fixed" });
  ok(r.status === 402 && r.body.details?.reason === "refunded" && handlerRuns === before && sales.every((s) => s !== h),
    `claimed by a refund send in the window: not served, the handler never ran (${r.status}, handler runs ${handlerRuns - before})`);
  ok(rowsFor(h).length === 1 && rowsFor(h)[0].status === "sending" && failures.length === 2, `...the row stays with the send and no charged failure is counted (${rowsFor(h)[0]?.status})`);
}

// The hold, served: the row is void and says it was served, so no later
// reopen can turn it back to owed. Held, then the buyer hangs up: owed again.
{
  const h = hashFor(31);
  const cred = pushCred(h);
  await post(cred, {});
  const r = await post(cred, { text: "fixed" });
  ok(r.status === 200 && rowsFor(h)[0].status === "void" && rowsFor(h)[0].note.endsWith(PUSH_SERVED_NOTE), `held and served: void, noted served ("${rowsFor(h)[0].note}")`);
  ok((await debts.hungUp(h, "no ticket")) === false && (await debts.handlerFailed(h, 502)) === false && rowsFor(h)[0].status === "void", "a served hold is never reopened");
  const h2 = hashFor(32);
  await post(pushCred(h2), {});
  const req = { tempoSettled: true, mppTempoPushHash: h2 };
  ok((await debts.claimForServe(req)) === true && rowsFor(h2)[0].status === "void", "claimForServe voids the owed debt before the handler");
  ok(ledger.claimRefundForSend(rowsFor(h2)[0].id, "refund-run") === false, "...and a refund send can no longer claim it");
  ok((await debts.hungUp(h2, "payer budget")) === true, "a disconnect reopens the held row");
  const [row] = rowsFor(h2);
  ok(row.status === "owed" && row.httpStatus === 499 && row.hangupReason === "payer budget" && row.note.includes(PUSH_HANGUP_AFTER_CLAIM_NOTE) && isRepeatHangup(row), `...as the disconnect it is (${JSON.stringify(row)})`);
  ok(ledger.claimRefundForSend(row.id, "refund-run") === true, "...which a refund send can claim");
}

// Refused on input, then the corrected retry is claimed and the buyer hangs up
// before the first byte. server.js's recordHangupDebt books a 499 on the same
// hash; INSERT OR IGNORE kept the stale 400 "input refused" row, so the
// planner's hang-up holds never applied. hungUp promotes it.
{
  const h = hashFor(10);
  await post(pushCred(h), {});
  const hangupRow = { slug: "paid-tool", network: "tempo", payer: SENDER, priceUsd: 0.05, tx: h, httpStatus: HANGUP_STATUS, synthetic: false, wire: "mpp-tempo", hangupReason: "payer budget" };
  ok(ledger.recordRefundOwed(hangupRow) === false, "setup: the disconnect insert on the same hash is ignored (the input-refused row holds it)");
  ok((await debts.hungUp(h, "payer budget")) === true, "hungUp promotes the owed input-refused row");
  const [row] = rowsFor(h);
  ok(rowsFor(h).length === 1 && row.status === "owed" && row.httpStatus === 499 && row.hangupReason === "payer budget" && row.note.includes(PUSH_INPUT_REFUSED_NOTE) && row.note.includes(PUSH_HANGUP_AFTER_CLAIM_NOTE),
    `the row is now the disconnect it is: 499, the reason, and a note that says it was claimed then disconnected (${JSON.stringify(row)})`);
  ok(isRepeatHangup(row) === true, "...so the planner's repeat-hang-up hold applies to it");
  ok(isLastingEffectHangup({ ...row, slug: "route-execute" }) === true, "...and so does the lasting-effect hold (keyed on 499 + slug)");
  ok((await debts.hungUp(h, "no ticket")) === false && rowsFor(h)[0].hangupReason === "payer budget", "a second promotion changes nothing (the note no longer reads the input refusal)");
  // Controls: never a row that is being sent, paid or void; never a finalize-refused row.
  const hs = hashFor(11);
  await post(pushCred(hs), {});
  // Claimed with its note unchanged, so only the status guard stands between it and a rewrite.
  ok(ledger.claimRefundForSend(rowsFor(hs)[0].id, PUSH_INPUT_REFUSED_NOTE), "setup: claimed for sending, note unchanged");
  ok((await debts.hungUp(hs, "no ticket")) === false && rowsFor(hs)[0].status === "sending" && rowsFor(hs)[0].httpStatus === 400, "a row being sent is never rewritten");
  const hv = hashFor(12);
  const cv = pushCred(hv);
  await post(cv, {}); await post(cv, { text: "fixed" });
  ok(rowsFor(hv)[0].status === "void" && (await debts.hungUp(hv, "no ticket")) === false && rowsFor(hv)[0].httpStatus === 400, "a void row (claimed and served) is never rewritten");
  const hf = hashFor(13);
  failNext = { ok: false, cls: "unknown", error: "relay said no", reason: "relay said no" };
  await post(pushCred(hf), { text: "x" });
  ok((await debts.hungUp(hf, "no ticket")) === false && rowsFor(hf)[0].httpStatus === 402, "a finalize-refused row is not a disconnect and is never rewritten");
  ok((await debts.hungUp(hashFor(14), "no ticket")) === false && rowsFor(hashFor(14)).length === 0, "no row, nothing written");
}

// Refused on input, then the corrected retry is claimed and the HANDLER fails
// (>= 400, not a disconnect). server.js books the handler failure on the same
// hash; INSERT OR IGNORE kept the stale 400 "input refused" row. handlerFailed
// restates it with the handler's status and a note saying what happened.
{
  const h = hashFor(20);
  await post(pushCred(h), {});
  const failRow = { slug: "paid-tool", network: "tempo", payer: SENDER, priceUsd: 0.05, tx: h, httpStatus: 502, synthetic: false, wire: "mpp-tempo" };
  ok(ledger.recordRefundOwed(failRow) === false, "setup: the handler-failure insert on the same hash is ignored (the input-refused row holds it)");
  ok((await debts.handlerFailed(h, 502)) === true, "handlerFailed restates the owed input-refused row");
  const [row] = rowsFor(h);
  ok(rowsFor(h).length === 1 && row.status === "owed" && row.httpStatus === 502 && row.note.includes(PUSH_INPUT_REFUSED_NOTE) && row.note.includes(PUSH_HANDLER_FAILED_AFTER_CLAIM_NOTE),
    `the row now reads the handler failure: 502 and a note that says it was claimed then failed (${JSON.stringify(row)})`);
  ok((await debts.handlerFailed(h, 500)) === false && rowsFor(h)[0].httpStatus === 502, "a second restatement changes nothing (the note no longer reads the input refusal)");
  // Controls: a disconnect status is not a handler failure; a row being sent is never rewritten.
  const hd = hashFor(21);
  await post(pushCred(hd), {});
  ok((await debts.handlerFailed(hd, 499)) === false && rowsFor(hd)[0].httpStatus === 400, "499 is refused here (disconnects go through hungUp)");
  ok((await debts.handlerFailed(hd, 200)) === false && rowsFor(hd)[0].httpStatus === 400, "a success status is refused");
  ok(ledger.claimRefundForSend(rowsFor(hd)[0].id, PUSH_INPUT_REFUSED_NOTE), "setup: claimed for sending, note unchanged");
  ok((await debts.handlerFailed(hd, 502)) === false && rowsFor(hd)[0].status === "sending" && rowsFor(hd)[0].httpStatus === 400, "a row being sent is never rewritten");
}

// THE HANDLER NEVER WAITS ON THE SENDER READ (2026-09-28). A slow Tempo RPC
// used to hold an honest push buyer before the handler for up to the read's
// bound; now the read runs beside the handler and only the booking waits.
{
  const slowApp = express();
  slowApp.use(express.json());
  let readDelayMs = 600;
  let readStartedAt = 0;
  const booked = [];
  const handlerStarts = [];
  slowApp.use((req, res, next) => {
    res.on("finish", () => { if (res.statusCode === 200 && req.tempoSettled) whenTempoLedgerPayerKnown(req, "test", () => booked.push({ hash: req.mppTempoPushHash, payer: req.mppTempoLedgerPayer, at: Date.now() })); });
    next();
  });
  slowApp.use(createTempoGate({
    secretKey: SECRET, realm: REALM, priceFor, replayGuard: createReplayGuard(),
    validate: async () => ({ ok: true, validation: {} }),
    broadcast: async () => ({ ok: true, receipt: { method: "tempo", status: "success", reference: `0xs${++n}`, timestamp: new Date().toISOString() } }),
    pushSender: () => { readStartedAt = Date.now(); return readDelayMs === Infinity ? new Promise(() => {}) : new Promise((r) => setTimeout(() => r(SENDER.toUpperCase().replace("0X", "0x")), readDelayMs)); },
  }));
  slowApp.use((req, res, next) => (req.tempoSettling ? next() : res.status(402).json({ error: "Payment Required" })));
  slowApp.post("/paid", (req, res) => { handlerStarts.push(Date.now()); res.json({ ok: true }); });
  const srv = slowApp.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const slowUrl = `http://127.0.0.1:${srv.address().port}/paid`;
  const buy = async (h) => { const t0 = Date.now(); const r = await fetch(slowUrl, { method: "POST", headers: { "content-type": "application/json", Authorization: pushCred(h) }, body: JSON.stringify({ text: "x" }) }); return { status: r.status, ms: Date.now() - t0 }; };
  const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return pred(); };

  const h = hashFor(20);
  const r = await buy(h);
  ok(r.status === 200 && r.ms < readDelayMs && handlerStarts.length === 1 && handlerStarts[0] - readStartedAt < readDelayMs / 2,
    `a push buy is served without waiting on a ${readDelayMs} ms sender read (answered in ${r.ms} ms, handler started ${handlerStarts[0] - readStartedAt} ms after the read began)`);
  ok(booked.length === 0, "the booking that names the payer has not run yet: it waits for the read");
  ok(await waitFor(() => booked.length === 1, 2000) && booked[0].hash === h && booked[0].payer === SENDER && booked[0].at - readStartedAt >= readDelayMs - 20,
    `once the read completes inside its bound, the sale is booked under the chain-read sender, lowercased (${JSON.stringify(booked[0])})`);

  // A read that never answers: still served at once, booked after the bound
  // with nobody named, exactly as a failed read did before.
  readDelayMs = Infinity;
  const h2 = hashFor(21);
  const r2 = await buy(h2);
  ok(r2.status === 200 && r2.ms < 500, `a hung sender read does not hold the answer (${r2.ms} ms)`);
  ok(await waitFor(() => booked.length === 2, PUSH_SENDER_WAIT_MS + 1500) && booked[1].hash === h2 && booked[1].payer === null && booked[1].at - readStartedAt >= PUSH_SENDER_WAIT_MS - 20,
    `past the ${PUSH_SENDER_WAIT_MS} ms bound the booking runs with the payer null (${JSON.stringify(booked[1])})`);
  srv.close();
  const src = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/if \(!FREE_MODE\) whenTempoLedgerPayerKnown\(req, "sales", \(\) => \{/.test(src), "server.js books the sale through the wait");
  ok(/whenTempoLedgerPayerKnown\(req, "refund-ledger", \(\) => \{[\s\S]{0,400}whenVerdict\(recordRefundOwed\(/.test(src), "...and a Tempo/Stripe handler-failure debt (booked through the verdict helper)");
  ok(/if \(!created && req\.tempoSettled && tempoPushDebts && typeof tx === "string"\) void tempoPushDebts\.handlerFailed\(tx, res\.statusCode\)/.test(src), "...which restates a stale input-refused push row when the insert found one");
  ok(/if \(req\.tempoSettled && tempoLedgerPayerPending\(req\)\) \{\s*\n\s*whenTempoLedgerPayerKnown\(req, "hangup"/.test(src), "...and a disconnect debt");
  const tempoSrc = (await import("node:fs")).readFileSync(new URL("../src/mpp-tempo.js", import.meta.url), "utf8");
  ok(!/req\.mppTempoLedgerPayer = await readPushSender\(\)/.test(tempoSrc), "the gate no longer awaits the sender read before next()");
}

// The void path never touches a row that is not owed, and needs a note.
{
  ok(ledger.voidOwedOnClaim(hashFor(8), PUSH_CLAIMED_NOTE) === false && rowsFor(hashFor(8))[0].status === "sending", "voidOwedOnClaim leaves a row being sent alone");
  ok(ledger.voidOwedOnClaim(hashFor(2), "") === false && rowsFor(hashFor(2))[0].status === "owed", "voidOwedOnClaim requires a note");
}

// Wiring pin: server.js builds these hooks from the same module and runs the
// served() void at the sale.
{
  const src = (await import("node:fs")).readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  ok(/createTempoPushDebts\(\{[\s\S]{0,300}recordOwed: recordRefundOwed[\s\S]{0,300}recordChargedFailure/.test(src), "server.js builds the push-debt hooks on the refund ledger and the charged-failure tally");
  ok(/onPushNotClaimed: \(req, info\) => tempoPushDebts\.notClaimed/.test(src) && /onPushInputRefused: \(req, info\) => tempoPushDebts\.inputRefused/.test(src) && /pushClaimAllowed:/.test(src) && /pushRowOf: \(hash\) => refundByEvidence\(hash\)/.test(src), "server.js passes all four push hooks to the Tempo gate");
  ok(/countChargedFailuresGenuine = db\.prepare\("SELECT COUNT\(\*\) AS n FROM charged_failures WHERE status <> 402"\)/.test((await import("node:fs")).readFileSync(new URL("../src/stats.js", import.meta.url), "utf8")) && PUSH_FINALIZE_FAILURE_STATUS !== 402, "the genuine charged-failure count excludes only status 402, and a push finalize failure is not recorded as 402");
  ok(/recordSale\(\{[\s\S]{0,1800}\}\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(req\.tempoSettled\) tempoPushDebts\?\.served\(req, res\)/.test(src), "server.js voids a served push claim's debt right after booking the sale");
  const hang = src.slice(src.indexOf("function recordHangupDebt("), src.indexOf("function recordHangupOutcome("));
  ok(/tx: req\.tempoSettled \? \(tempoPushHashOf\(req\) \|\|/.test(hang), "a push disconnect is keyed on the credential's (lowercased) hash, the evidence the input-refused row used");
  ok(/if \(!made && req\.tempoSettled && tempoPushHashOf\(req\) === row\.tx\) void tempoPushDebts\?\.hungUp\(row\.tx, hangupReason\)/.test(hang), "recordHangupDebt promotes an existing input-refused row instead of ignoring it (on the write's verdict)");
  ok(/promoteToHangup: promoteOwedToHangup/.test(src), "server.js wires the promotion to the refund ledger");
  ok(/voidForServe: voidOwedForServe, reopenHeld: reopenHeldClaim, renoteVoid: renoteVoidRefund/.test(src), "server.js wires the claim hold, its reopen and its served note to the refund ledger");
  ok(/app\.use\(tempoGate\);[\s\S]{0,900}await tempoPushDebts\.claimForServe\(req\)/.test(src), "server.js holds the claim right after the Tempo gate, before any handler");
  ok(/res\.statusCode >= 400 && !req\.tempoPushRefunded\)/.test(src), "a push refused as refunded books no second debt or charged failure");
  ok(/const tx = req\.tempoSettled \? \(tempoPushHashOf\(req\) \|\| tempoTxFromReceiptHeader/.test(src), "a push handler failure is keyed on the same hash too, so a mixed-case relay reference cannot book a second row for one transfer");
}

// A handler refusal on a CLAIMED push transfer is a charge booked as owed,
// so the "not charged" sentence the kits write for the settle-after rails is
// restated for this payer at send (src/push-refusal-body.js), with the fields
// a client reads. A served answer and a refunded claim go out as written.
{
  const { PUSH_FAILURE_NOTE, rewriteNotChargedForPush } = await import("../src/push-refusal-body.js");
  const h = hashFor(40);
  const r = await post(pushCred(h), { text: "refuse" });
  ok(r.status === 422 && r.body.charged === true && r.body.transferClaimed === true && r.body.refundOwed === true && r.body.payment === PUSH_FAILURE_NOTE, `push handler refusal: the body carries charged, transferClaimed, refundOwed and the owed note (${JSON.stringify(r.body).slice(0, 160)})`);
  ok(!/not charged|nothing was charged/i.test(JSON.stringify(r.body)) && /recorded as a refund owed/.test(r.body.error) && /owed a refund/.test(r.body.hint) && /recorded as owed/.test(r.body.problem?.detail), `push handler refusal: every "not charged" sentence, nested ones too, is restated (${r.body.error})`);
  ok(rowsFor(h).length === 1 && rowsFor(h)[0].status === "owed" && rowsFor(h)[0].httpStatus === 422, "...and the finish path books the debt the sentence names");
  const served = await post(pushCred(hashFor(41)), { text: "x" });
  ok(served.status === 200 && served.body.note === "Nothing was charged for the free part." && served.body.refundOwed === undefined, "a served push answer goes out as written (only a refusal is restated)");
  ok(rewriteNotChargedForPush("This call is not charged on x402.") === "This call is not charged on x402." && rewriteNotChargedForPush("Bad input - not charged; retry") === "Bad input - a refund is owed; retry", "a sentence scoped to another rail is kept; an unscoped clause is restated in place");
  // The refund run holds the claim: server.js answers its own refunded 402, untouched.
  const h2 = hashFor(42);
  const cred2 = pushCred(h2);
  await post(cred2, {});
  claimInWindow = h2;
  const held = await post(cred2, { text: "refuse" });
  ok(held.status === 402 && held.body.details?.reason === "refunded" && held.body.refundOwed === undefined && held.body.payment === undefined, `a claim the refund run holds is answered as refunded, not restated (${JSON.stringify(held.body)})`);
}

// A slow route called with a push credential and no Prefer: the window's
// respond_async_required refusal is not sent ahead of the gate (the
// transfer is already final) but answered by the gate's push input check,
// so the transfer is booked as owed until claimed; the retry with the header
// passes the window, is claimed, served, and voids the row. The handler never
// runs on the refusal. The same for the CDN window's 504.
for (const [label, headers, status, error, tail] of [
  ["direct window", {}, 400, "respond_async_required", `before any payment was taken${PUSH_EXCEPTION}.`],
  ["CDN window", { "x-test-via-cdn": "1" }, 504, "sync_answer_too_slow_for_connection", `Nothing was charged${PUSH_EXCEPTION}.`],
]) {
  const h = hashFor(label === "direct window" ? 50 : 51);
  const cred = pushCred(h);
  const runs = handlerRuns, fails = failures.length;
  const r = await postTo("/slow", cred, { text: "x" }, headers);
  ok(r.status === status && r.body.error === error && r.body.charged === false && r.body.transferClaimed === false && handlerRuns === runs,
    `${label}: a push credential on a slow route without Prefer is refused ${status} ${error} by the gate, transfer unclaimed, handler not run (got ${r.status} ${r.body.error}, runs +${handlerRuns - runs})`);
  ok(typeof r.body.hint === "string" && r.body.hint.endsWith(tail) && r.body.payment.includes(SYNC_WINDOW_RETRY) && /recorded as owed/.test(r.body.payment),
    `${label}: the hint carries the push exception and the payment line names the header and the owed row (${String(r.body.payment).slice(0, 120)})`);
  const rows = rowsFor(h);
  ok(rows.length === 1 && rows[0].status === "owed" && rows[0].note === PUSH_INPUT_REFUSED_NOTE && rows[0].httpStatus === status && rows[0].payer === SENDER && rows[0].priceUsd === 0.05 && failures.length === fails,
    `${label}: one owed row keyed on the hash, no charged failure (${JSON.stringify(rows)})`);
  const again = await postTo("/slow", cred, { text: "x" }, headers);
  ok(again.status === status && rowsFor(h).length === 1, `${label}: refused again, booked once`);
  const r2 = await postTo("/slow", cred, { text: "x" }, { ...headers, prefer: "respond-async" });
  const after = rowsFor(h);
  ok(r2.status === 200 && after.length === 1 && after[0].status === "void" && after[0].note.includes(PUSH_CLAIMED_NOTE) && sales.filter((s) => s === h).length === 1 && handlerRuns === runs + 1,
    `${label}: the retry with Prefer: respond-async claims the transfer, is served, voids the row and books the sale once (${r2.status}, ${after[0]?.status} "${after[0]?.note}")`);
}
// Controls: the windows leave a push credential on a fast route alone, and
// refuse a non-push payment themselves (nothing reaches the gate, no row).
{
  const h = hashFor(52);
  const r = await post(pushCred(h), { text: "x" });
  ok(r.status === 200 && rowsFor(h).length === 0, "control: a push credential on a fast route is served, no window in the way");
  const x402 = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: {} })).toString("base64");
  const rows0 = ledger.listRefunds({ status: "all", limit: 1000 }).length;
  const rx = await fetch(`http://127.0.0.1:${server.address().port}/slow`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": x402 }, body: JSON.stringify({ text: "x" }) });
  const jx = await rx.json();
  ok(rx.status === 400 && jx.error === "respond_async_required" && jx.hint.endsWith("before any payment was taken.") && jx.payment === undefined && ledger.listRefunds({ status: "all", limit: 1000 }).length === rows0,
    `control: an x402 payment on the slow route is refused by the window itself, before the gate, no row and no push clause (${rx.status})`);
}

// A push credential on a route that offers no Tempo challenge (long-running,
// identity-bound) is refused at the gate's binding check, before the sync
// window's deferred refusal is read. The transfer still paid a challenge this
// server minted, so once the relay confirms it the refusal books it as owed,
// unclaimed, and consumes the credential: the refund run repays it, and it
// pays for no further request (a resend to a Tempo route is a replay). The
// handler never runs on the refusal.
{
  const h = hashFor(60);
  const cred = pushCred(h);
  const runs = handlerRuns, fails = failures.length;
  const r = await postTo("/long", cred, { text: "x" });
  ok(r.status === 402 && r.body.details?.reason === "method-unsupported" && r.body.details.charged === false && r.body.details.transferClaimed === false && r.body.details.refundOwed === true && handlerRuns === runs,
    `long-running route: a push credential is refused 402 at the binding check, transfer unclaimed, owed, handler not run (${JSON.stringify(r.body.details)})`);
  ok(/runs longer than a Tempo credential/.test(r.body.detail) && /has not been claimed and is recorded as owed/.test(r.body.detail) && /pays for no further request/.test(r.body.detail),
    `...and the detail says why, that the transfer is owed and to be refunded, and that the credential is spent (${r.body.detail})`);
  const rows = rowsFor(h);
  ok(rows.length === 1 && rows[0].status === "owed" && rows[0].note === PUSH_INPUT_REFUSED_NOTE && rows[0].httpStatus === 402 && rows[0].payer === SENDER && rows[0].priceUsd === 0.05 && rows[0].network === "tempo" && failures.length === fails,
    `long-running route: one owed row keyed on the hash, under the chain-read sender, no charged failure (${JSON.stringify(rows)})`);
  const again = await postTo("/long", cred, { text: "x" });
  ok(again.status === 402 && again.body.details?.refundOwed === undefined && rowsFor(h).length === 1 && rowsFor(h)[0].status === "owed", `refused again at the same route: the consumed credential gets the plain refusal, the one row stands (${JSON.stringify(again.body.details)})`);
  const r2 = await post(cred, { text: "x" });
  ok(r2.status === 402 && r2.body.details?.reason === "replay" && rowsFor(h)[0].status === "owed" && sales.every((s) => s !== h) && handlerRuns === runs,
    `the booked credential on a route that offers Tempo is a replay: never served, the debt stands for the refund run (${r2.status} ${r2.body.details?.reason})`);
  // The same class: an identity-bound route.
  const hi = hashFor(61);
  const ri = await postTo("/ident", pushCred(hi), { text: "x" });
  ok(ri.status === 402 && ri.body.details?.reason === "method-unsupported" && ri.body.details.transferClaimed === false && rowsFor(hi).length === 1 && rowsFor(hi)[0].status === "owed" && handlerRuns === runs,
    `identity-bound route: the same refusal books the confirmed transfer as owed (${JSON.stringify(ri.body.details)})`);
  // A credential that already paid a SERVED call, re-sent to a long-running
  // route: the replay guard holds it consumed, so the refusal is the plain
  // one and nothing is booked for a transfer that bought an answer.
  const hs = hashFor(63);
  const served = pushCred(hs);
  const rs = await post(served, { text: "x" });
  ok(rs.status === 200 && sales.filter((s) => s === hs).length === 1, "setup: the push credential is claimed and served");
  const rl = await postTo("/long", served, { text: "x" });
  ok(rl.status === 402 && rl.body.details?.reason === "method-unsupported" && rl.body.details.charged === false && rl.body.details.transferClaimed === undefined && rl.body.details.refundOwed === undefined && !/recorded as owed/.test(rl.body.detail) && rowsFor(hs).length === 0 && sales.filter((s) => s === hs).length === 1 && handlerRuns === runs + 1,
    `served, then re-sent to a long-running route: plain refusal, no row, the one sale (${JSON.stringify(rl.body.details)}, rows ${rowsFor(hs).length})`);
  const rr = await post(served, { text: "x" });
  ok(rr.status === 402 && rr.body.details?.reason === "replay" && rowsFor(hs).length === 0, "...and a later resend to the Tempo route is still a replay");
  // Concurrent: the claim on the Tempo route is in flight (a slow handler)
  // while the same credential reaches the long-running route.
  const hc = hashFor(64);
  const inflight = pushCred(hc);
  const claim = post(inflight, { text: "slow" });
  await new Promise((r) => setTimeout(r, 120));
  const rc = await postTo("/long", inflight, { text: "x" });
  ok(rc.status === 402 && rc.body.details?.reason === "method-unsupported" && rc.body.details.refundOwed === undefined && rowsFor(hc).length === 0, `a claim in flight elsewhere: the route refusal books nothing (${JSON.stringify(rc.body.details)})`);
  const done = await claim;
  ok(done.status === 200 && sales.filter((s) => s === hc).length === 1 && rowsFor(hc).length === 0, "...and the in-flight claim is served once, with no debt");
  // A transfer whose row the refund run already holds (input refused on the
  // Tempo route, so the guard released the credential; then claimed for
  // sending): the ledger row stops the booking and the row is untouched.
  const hv = hashFor(65);
  const held = pushCred(hv);
  await post(held, {});
  ok(ledger.claimRefundForSend(rowsFor(hv)[0].id, "refund-run"), "setup: the input-refused row is claimed for sending");
  const rh = await postTo("/long", held, { text: "x" });
  ok(rh.status === 402 && rh.body.details?.reason === "method-unsupported" && rh.body.details.refundOwed === undefined && rowsFor(hv).length === 1 && rowsFor(hv)[0].status === "sending", `a transfer being refunded: plain refusal, the row untouched (${rowsFor(hv)[0]?.status})`);
  // Controls: a transfer the relay does not confirm books nothing and keeps
  // the plain refusal; a pull credential at the same route is the plain refusal.
  const hu = hashFor(62);
  validateNext = { ok: false, cls: "invalid-payment", error: "no such transfer", reason: "no such transfer" };
  const ru = await postTo("/long", pushCred(hu), { text: "x" });
  ok(ru.status === 402 && ru.body.details?.reason === "method-unsupported" && ru.body.details.charged === false && ru.body.details.transferClaimed === undefined && ru.body.details.refundOwed === undefined && !/recorded as owed/.test(ru.body.detail) && rowsFor(hu).length === 0,
    `control: a push transfer the relay does not confirm is the plain refusal, nothing booked (${JSON.stringify(ru.body.details)})`);
  const pullChallenge = Challenge.from({ realm: REALM, method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000 + (++credSeq) * 1000), request: { amount: "50000", currency: CUR, decimals: 6, recipient: TREASURY, methodDetails: { chainId: 4217 } }, secretKey: SECRET });
  const pull = Credential.serialize({ challenge: pullChallenge, payload: { type: "transaction", transaction: "0x02" }, source: "did:pkh:eip155:4217:0x1111111111111111111111111111111111111111" });
  const rows0 = ledger.listRefunds({ status: "all", limit: 1000 }).length;
  const rp = await postTo("/long", pull, { text: "x" });
  ok(rp.status === 402 && rp.body.details?.reason === "method-unsupported" && rp.body.details.transferClaimed === undefined && ledger.listRefunds({ status: "all", limit: 1000 }).length === rows0, "control: a pull credential at a long-running route is the plain refusal (nothing was sent), no row");
}

// Catalog state the paths above depend on: every slow route (run budget past
// the advise bound, src/slow-routes.js) is long-running, so no slow route
// offers Tempo and a push credential on one is refused at the binding check,
// never by the sync window's deferred refusal. A slow route that offers Tempo
// would take the deferred path (tested on /slow above) with live money: when
// this assertion fails, cover that route there before changing the list.
{
  const slow = Object.entries(EVM_RUN_SECONDS).filter(([, s]) => Number(s) > SLOW_ADVISE_SECONDS).map(([slug]) => slug);
  const offered = slow.filter((slug) => tempoOfferedFor({ priceUsd: 0.05, longRunning: isLongRunningSlug(slug) }));
  ok(slow.length > 0 && offered.length === 0, `every slow route (${slow.length}) is long-running, so none offers Tempo and the deferred sync-window refusal has no live route today${offered.length ? `: ${offered.join(", ")} now offers Tempo on a slow route` : ""}`);
}

server.close();
console.log(`\n${pass} passed, 0 failed`);
process.exit(0);
