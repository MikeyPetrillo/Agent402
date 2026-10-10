// decide: a paid decision. The buyer describes a job; the answer is a
// call-ready plan over every tool in the index, ours and every routable
// outside x402/MPP seller, ranked neutrally.
//
// This file is the paid front: the payment gates run first (settlement is
// after the handler, so nothing here is reached unpaid and a >= 400 is never
// charged), then the plan is built by the separate decide service over the
// private network, under a hard timeout. The decide service never sees a
// payment credential.
//
// Listed only when DECIDE_SERVICE_URL and DECIDE_INTERNAL_TOKEN are set.

import { runInAbortableScope } from "../drain-abort.js";
import { decideConfig, priceForDepth, DEPTHS } from "../decide/config.js";
import { recordWish } from "../wish.js";
import { payerFromRequest } from "../payer.js";
import { openDecideLedger, hashToken, newCreditToken } from "../decide/ledger.js";
import { validateParams, fitParamsToSchema } from "../decide/params.js";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { dispatchable } from "./route-execute.js";
import { EXPENSIVE_COMPOSITE_SLUGS } from "../composite-spend-guard.js";
import { evmCredentialBudgetMs } from "../evm-validity.js";
import { resolveStepRefs } from "../decide/step-refs.js";
import { sketchPlan, sketchListPriceUsd, SKETCH_MIN_STEPS, SKETCH_MAX_STEPS } from "../decide/sketch-plan.js";

export const NEUTRALITY_NOTE = "Every candidate is scored by one formula with the same weights: fit to the step, observed reliability, price, schema quality and a freshness pass mark. It has no term for who sells the tool, and every tool carries firstParty. Fit is judged from the same bounded description for every tool; reliability counts one observation per payer per day. Outside tools are eligible when a live 402 was seen within the configured window and their input schema is known.";

const serviceUrl = () => String(process.env.DECIDE_SERVICE_URL || "").replace(/\/+$/, "");
const token = () => String(process.env.DECIDE_INTERNAL_TOKEN || "");
export const decideEnabled = () => !!serviceUrl() && token().length >= 24;

function bad(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function safeServiceUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && (/\.railway\.internal$/.test(x.hostname) || x.hostname === "127.0.0.1" || x.hostname === "localhost");
  } catch { return false; }
}

export async function callService(path, body, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  // The shared token is only ever sent over TLS or the private network.
  if (!safeServiceUrl(serviceUrl())) throw bad("The decision service is misconfigured - not charged", 503);
  let res;
  try {
    res = await fetchImpl(`${serviceUrl()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw bad(e?.name === "TimeoutError" ? "The decision service did not answer in time - not charged; retry shortly" : "The decision service is unreachable - not charged; retry shortly", 503);
  }
  let j = null;
  try { j = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    // Relay only our own service's 4xx wording; anything else is a generic 5xx.
    if (res.status >= 400 && res.status < 500 && typeof j?.error === "string") throw bad(j.error.slice(0, 300), res.status);
    throw bad("The decision service failed - not charged; retry shortly", res.status === 503 ? 503 : 502);
  }
  return j;
}

/** The 402 price follows the requested depth. */
export function decideQuoteUsd(body) {
  const d = String(body?.depth ?? "plan").toLowerCase();
  return priceForDepth(DEPTHS.includes(d) ? d : "plan");
}

function fileGaps(gaps, req) {
  for (const g of (gaps || []).slice(0, 4)) {
    try { recordWish({ need: String(g).slice(0, 200), context: "decide gap", source: "decide", ip: req?.ip }); } catch { /* the board is best effort */ }
  }
}

// Keyed like the router's spend guard: signed payer, else the verified Tempo
// sender, else the client ip, so no caller is unkeyed.
const payerOf = (req) => (req ? payerFromRequest(req) || (req.mppTempoSender ? `tempo:${req.mppTempoSender}` : null) || (req.creditsKeyId ? `credits:${req.creditsKeyId}` : null) || (req.ip ? `ip:${req.ip}` : null) : null);
// Runs fn(settledOk) once the paid response's settlement outcome is known,
// including a client that hung up after the handler answered (the server
// resolves __onSettled through hangup-settlement's onSettleOutcome).
const onSettled = (req, fn) => { if (req && typeof req === "object") (req.__onSettled ||= []).push(fn); };
const roundUsd = (x) => Math.round(x * 1e6) / 1e6;
// A ledger write made AFTER money may have left (an outside seller paid, a
// step's spend booked) must never turn the run into a 500: x402 never settles
// a 500, so the buyer would not pay for what we already paid out. Such a write
// is awaited once; on failure it is logged and retried in the background on
// this schedule (every write retried here is idempotent: an UPDATE to a fixed
// state), and the run still answers.
const LEDGER_RETRY_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
function retryLedgerWrite(label, thunk, delays = LEDGER_RETRY_MS, attempt = 0) {
  if (attempt >= delays.length) { console.error(`[decide] ${label}: ledger write still failing after ${delays.length} retries; left for the operator`); return; }
  const t = setTimeout(async () => {
    try { await thunk(); console.log(`[decide] ${label}: ledger write landed on retry ${attempt + 1}`); }
    catch { retryLedgerWrite(label, thunk, delays, attempt + 1); }
  }, delays[attempt]);
  t.unref?.();
}
/** Await a ledger write; a failure is logged and queued for retry, never thrown. True when it landed now.
 *  `journal`, when given, records the write on local disk (the ledger's
 *  pending-write journal, replayed at boot and on a timer) before this
 *  resolves, so the write outlives the process. */
async function ledgerWriteAfterSpend(label, thunk, delays = LEDGER_RETRY_MS, journal = null) {
  try { await thunk(); return true; }
  catch (e) {
    let kept = false;
    try { kept = journal ? journal() === true : false; } catch { kept = false; }
    console.warn(`[decide] ${label}: ledger write failed (${String(e?.message || e).slice(0, 120)}); queued for retry${kept ? " and journaled" : ""}`);
    retryLedgerWrite(label, thunk, delays);
    return false;
  }
}
/** A settlement-hook write, made after the answer and awaited by nobody: a
 *  failure is logged and retried, never thrown into a response already gone. */
const fireRetry = (label, thunk, delays = LEDGER_RETRY_MS, journal = null) => { ledgerWriteAfterSpend(label, thunk, delays, journal).catch(() => {}); };
/** The journal step for a write, when the ledger keeps one (the state database ledger). */
const journalOf = (ledger, kind, payload) => (typeof ledger?.journal === "function" ? () => ledger.journal(kind, payload) : null);
/** Activate a credit; a credit not recorded yet throws (so the write is retried), one already past pending is done. */
async function activateRecorded(ledger, token, hash) {
  if (await ledger.activateCredit(hash)) return;
  if (!(await ledger.creditState(token))) throw new Error("the credit is not recorded yet");
}
/** The settled mark; a decision not recorded yet throws (the database ledger says so), so the mark is retried. */
async function markSettledRecorded(ledger, decisionId) {
  if ((await ledger.markDecisionSettled(decisionId)) === false) throw new Error("the decision is not recorded yet");
}

/** Fire-and-forget: reliability observations to the decide service. Never
 *  awaited by a paid request, never able to fail one. */
/** Who an observation came from, as a short one-way hash (never the payer). */
export const observerId = (payer) => (payer ? createHash("sha256").update(String(payer)).digest("hex").slice(0, 16) : null);

export function sendObservations(observations, { send = callService } = {}) {
  if (!observations.length || !decideEnabled()) return;
  Promise.resolve().then(() => send("/internal/observations", { observations }, { timeoutMs: 5000 })).catch(() => {});
}

export const TEMPO_DECISION_BUDGET_MS = 14_000;

export function makeDecideHandler({ ledger, now = () => Date.now() }) {
  return async function decideHandler(input, req) {
    const depth = String(input?.depth ?? "plan").toLowerCase();
    if (!DEPTHS.includes(depth)) throw bad(`"depth" must be one of ${DEPTHS.join(", ")}`);
    const cfg = decideConfig();
    const priceUsd = decideQuoteUsd(input);
    const payer = payerOf(req);
    // A Tempo credential is only settleable for about 25s after signing, and
    // settlement follows the answer: its decision is bounded well inside that.
    const budgetMs = req?.mppTempoCredential ? Math.min(cfg.budgetMs[depth], TEMPO_DECISION_BUDGET_MS) : cfg.budgetMs[depth];
    const out = await callService("/internal/decide", {
      task: input?.task, constraints: input?.constraints, depth,
      payer, rail: req?.mppTempoCredential ? "mpp" : "x402", priceUsd,
      deadlineAt: Date.now() + budgetMs + 3000,
    }, { timeoutMs: budgetMs + 4000 });
    fileGaps(out.gaps, req);
    // A 4xx/5xx is never charged. An empty plan is "nothing covers this", and
    // a plan whose fit judging failed is retrieval order, which /api/find gives
    // free: neither is sold as a decision.
    if (!Array.isArray(out.plan) || !out.plan.length) throw Object.assign(bad("No indexed tool covers this task yet - not charged. The need was recorded.", 422), { gaps: out.gaps || [] });
    if (out.judged === false) throw bad("The decision could not be judged right now - not charged; retry shortly", 503);
    // The decision is kept here (money side) so execute can price from it;
    // its credit counts only once THIS payment settles.
    const feedbackToken = `fb_${randomBytes(18).toString("base64url")}`;
    // Past this point the decision cost a model call: a ledger failure is
    // retried and journaled, never a 500 (a 500 is never charged). A retry
    // writes the row only when absent, so it cannot unsettle it.
    const id = out.decisionId;
    const row = { decisionId: id, depth, priceUsd, payer, plan: out.plan, costViaUsd: out.estimatedCostViaAgent402Usd || 0, feedbackHash: hashToken(feedbackToken), now: now() };
    let firstSave = true;
    await ledgerWriteAfterSpend(`save decision ${id}`, () => {
      if (firstSave || typeof ledger.saveDecisionIfAbsent !== "function") { firstSave = false; return ledger.saveDecision(row); }
      return ledger.saveDecisionIfAbsent(row);
    }, LEDGER_RETRY_MS, journalOf(ledger, "saveDecision", row));
    const settleMark = () => fireRetry(`settle decision ${id}`, () => markSettledRecorded(ledger, id), LEDGER_RETRY_MS, journalOf(ledger, "markDecisionSettled", { decisionId: id }));
    const amount = roundUsd(priceUsd * cfg.credit.percentOfFee / 100);
    let executionCredit = null;
    if (amount > 0 && out.plan?.length) {
      // The token is drawn first, so a retried or journaled mint names the same credit.
      const token = newCreditToken();
      const hash = hashToken(token);
      const t0 = now();
      const mintArgs = { decisionId: id, amountUsd: amount, expiresAt: t0 + cfg.credit.ttlHours * 3_600_000, payer, now: t0, token };
      const minted = await ledgerWriteAfterSpend(`mint credit ${id}`, () => ledger.mintCredit(mintArgs), LEDGER_RETRY_MS, journalOf(ledger, "mintCredit", mintArgs));
      onSettled(req, (settledOk) => { if (settledOk) { fireRetry(`activate credit ${id}`, () => activateRecorded(ledger, token, hash), LEDGER_RETRY_MS, journalOf(ledger, "activateCredit", { hash })); settleMark(); } });
      executionCredit = { amountUsd: roundUsd(amount), expiresAt: new Date(mintArgs.expiresAt).toISOString(), token, redeemWith: "POST /api/decide/execute { decisionId, creditToken }", activeAfterPaymentSettles: true, ...(minted ? {} : { recordPending: true }) };
    } else {
      onSettled(req, (settledOk) => { if (settledOk) settleMark(); });
    }
    return {
      ...out,
      priceUsd,
      executionCredit,
      feedbackToken,
      feedback: "POST /api/decide/feedback { decisionId, feedbackToken, step, outcome: success|failure, quality?: 1-5, latencyMs? } - free, one verdict per step",
      neutrality: NEUTRALITY_NOTE,
      ...(depth === "quick" ? { upgrade: 'depth "plan" adds steps and fallbacks; "full" adds params, a compiled prompt and cost/latency estimates' } : {}),
    };
  };
}

// ---------------------------------------------------------------- execute

/** What an execute call is priced at: its budget less a valid credit, never
 *  under the settlement floor. Sync: reads the ledger's synchronous view
 *  (the file, or the mirror on the state database, which the handler then
 *  re-validates against the database before anything is charged). */
export function executeQuoteUsd(body, { ledger, now = Date.now(), getCatalog = null }) {
  const floor = 0.001;
  const d = body?.decisionId ? (ledger.getDecisionSync ? ledger.getDecisionSync(String(body.decisionId)) : ledger.getDecision(String(body.decisionId))) : null;
  if (!d) {
    // A sketch run (steps, no decision) is quoted at its steps' list prices;
    // the handler refuses a step it cannot run before anything is charged.
    if (!body?.decisionId && Array.isArray(body?.steps) && typeof getCatalog === "function") {
      const sum = sketchListPriceUsd(body.steps, getCatalog());
      if (sum > 0) return Math.max(floor, executeBudgetUsd(body, { costViaUsd: sum }));
    }
    return floor;
  }
  const credit = ledger.creditAvailableUsdSync ? ledger.creditAvailableUsdSync(body?.creditToken, d.id, now) : ledger.creditAvailableUsd(body?.creditToken, d.id, now);
  const budget = executeBudgetUsd(body, d, undefined, credit);
  return Math.max(floor, roundUsd(budget - credit));
}

// With no maxBudgetUsd, the budget is the plan's estimate, or the credit the
// caller already holds for this decision when that is larger: a backup tool
// pricier than the planned one can then still run (2026-10-01 prod run: step 1
// fell through to a dearer seller and the estimate left nothing for step 2
// while $0.02 of credit sat unused). Unspent budget returns as credit.
export function executeBudgetUsd(body, d, cfg = decideConfig(), creditUsd = 0) {
  const asked = Number(body?.maxBudgetUsd);
  const planned = Number(d?.costViaUsd) || 0;
  const held = Number(creditUsd) > 0 ? Number(creditUsd) : 0;
  const base = Number.isFinite(asked) && asked > 0 ? asked : Math.max(planned, held);
  return roundUsd(Math.min(base, cfg.execute.perCallMaxUsd));
}

/** The caller's params for one step, when given. */
function stepOverride(step, overrides) {
  const o = overrides && typeof overrides === "object" ? overrides[String(step.step)] : null;
  return o && typeof o === "object" && !Array.isArray(o) ? o : null;
}
const PLACEHOLDER = /^<[^<>]*>$/;

async function withTimeout(promise, ms, label) {
  let t;
  try {
    return await Promise.race([promise, new Promise((_, r) => { t = setTimeout(() => r(bad(`${label} did not answer within ${Math.round(ms / 1000)} s`, 504)), ms); })]);
  } finally { clearTimeout(t); }
}

function priceOfDef(def) {
  const n = Number(String(def?.price ?? "").replace(/^\$/, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function makeExecuteHandler({ ledger, getCatalog, now = () => Date.now(), isComposite = (slug) => EXPENSIVE_COMPOSITE_SLUGS.has(slug), runBudgetMs = (req) => evmCredentialBudgetMs(req), spendingWalletStatus = async () => (await import("../upstream-buyer-status.js")).upstreamBuyerStatus(), ledgerRetryMs = LEDGER_RETRY_MS }) {
  // A write after money may have moved: awaited once, then retried and
  // journaled (kind, payload) on local disk before the run answers.
  const afterSpend = (label, kind, payload, thunk) => ledgerWriteAfterSpend(label, thunk, ledgerRetryMs, journalOf(ledger, kind, payload));
  const finish = (args) => afterSpend(`finish run ${args.runId}`, "finishRun", args, () => ledger.finishRun(args));
  const restore = (token, runId) => afterSpend(`restore credit ${runId}`, "restoreCredit", { token, runId }, () => ledger.restoreCredit(token, runId));
  const settleHold = (runId, holdId, amountUsd) => afterSpend(`${amountUsd > 0 ? "settle" : "drop"} hold ${runId}`, "settleSellerHold", { holdId, amountUsd }, () => ledger.settleSellerHold(holdId, amountUsd));
  return async function executeHandler(input, req) {
    const cfg = decideConfig();
    if (input.params != null && (typeof input.params !== "object" || Array.isArray(input.params))) throw bad('"params" must be an object keyed by step number');
    const payer = payerOf(req);
    const t = now();
    // One run per (decision, runKey): a client that timed out and paid again
    // gets the first run's id back, not a second run (a 409 is not charged).
    const runKey = typeof input?.runKey === "string" && input.runKey ? input.runKey.slice(0, 128)
      : typeof req?.headers?.["idempotency-key"] === "string" && req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]).slice(0, 128) : null;
    let decisionId = String(input?.decisionId || "");
    let d = null;
    let persistSketch = null, sketchFeedbackToken = null;
    if (decisionId) {
      d = await ledger.getDecision(decisionId);
      if (!d) throw bad("Unknown decisionId - decisions are kept for this server's own answers only", 404);
      if (!d.settled) throw bad("That decision's payment has not settled, so it cannot be executed", 409);
    } else if (Array.isArray(input?.steps)) {
      // The steps of a free plan sketch become a decision of their own: kept
      // like a paid one (so the run can be repeated and given feedback),
      // priced at zero and settled at once, since the sketch cost nothing.
      const refuse = (def) => {
        const dis = dispatchable(def);
        if (!dis.ok) return dis.why;
        if (typeof def.tierQuote === "function") return "is priced per request; call it directly";
        if (isComposite(def.slug)) return "is a report product; call it directly";
        return null;
      };
      const sk = sketchPlan(input.steps, { catalog: getCatalog(), refuse });
      if (!sk.ok) throw bad(sk.error, 400);
      // With a run key the decision id is derived from payer, key and steps,
      // so a paid retry finds the first run (the guard below) instead of
      // minting a second decision. Without one, the id is random.
      decisionId = runKey
        ? `skt_${createHash("sha256").update(`${payer || ""}|${runKey}|${sk.plan.map((p) => p.tool.slug).join(",")}`).digest("hex").slice(0, 24)}`
        : `skt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const prior = runKey ? await ledger.getDecision(decisionId) : null;
      if (prior) d = prior;
      else {
        // Kept like a paid decision (feedback token included), priced at zero
        // and settled at once since the sketch cost nothing; written only once
        // the run is booked, so a refused attempt leaves no row.
        const feedbackToken = `fb_${randomBytes(18).toString("base64url")}`;
        sketchFeedbackToken = feedbackToken;
        d = { id: decisionId, createdAt: t, depth: "sketch", priceUsd: 0, payer, plan: sk.plan, costViaUsd: sk.costUsd, settled: true };
        persistSketch = async () => {
          await ledger.saveDecision({ decisionId, depth: "sketch", priceUsd: 0, payer, plan: sk.plan, costViaUsd: sk.costUsd, feedbackHash: hashToken(feedbackToken), now: t });
          await ledger.markDecisionSettled(decisionId);
        };
      }
    } else {
      throw bad(`"decisionId" (from POST /api/decide) or "steps" (the tool slugs of a free plan sketch from /api/find or /api/route, ${SKETCH_MIN_STEPS} to ${SKETCH_MAX_STEPS}, in order) is required`);
    }
    const startedAt = Date.now();
    const budget = executeBudgetUsd(input, d, cfg, await ledger.creditAvailableUsd(input.creditToken, d.id, t));
    if (budget <= 0) throw bad("Nothing to execute: the plan has no priced steps; pass maxBudgetUsd", 400);

    // WHAT WAS PAID is the quote the payment gate settled against (stashed on
    // the request by every gate), never a recomputation: a credit raced away
    // since the quote would otherwise make an unpaid budget spendable.
    const quoted = Number.isFinite(req?.__meteredQuoteUsd) && req.__meteredQuoteUsd > 0 ? req.__meteredQuoteUsd : executeQuoteUsd(input, { ledger, now: t, getCatalog });
    const creditAssumed = roundUsd(Math.max(0, budget - quoted));

    const prior = await ledger.runByKey(d.id, runKey);
    if (prior) {
      // The payer that ran it gets that run's outcome back with the refusal
      // (still a 409, so nothing is charged again); anyone else gets the id only.
      const own = prior.status !== "running" && payer && prior.payer === payer;
      throw Object.assign(bad(`This decision already has a run with that key (${prior.id}, ${prior.status}); nothing was charged`, 409), { runId: prior.id, ...(own ? { priorRun: { id: prior.id, status: prior.status, spentUsd: prior.spentUsd, steps: prior.steps } } : {}) });
    }

    // Outside steps are paid from our spending wallet. When its balance reads
    // low, they are paused before anything is paid (an unreadable balance does
    // not block: a payment the wallet cannot cover is refused, and not charged).
    const hasOutside = d.plan.some((p) => [p.tool, ...(p.fallbacks || [])].some((x) => x && !x.firstParty));
    let outsidePaused = false;
    if (hasOutside) {
      try { outsidePaused = (await spendingWalletStatus())?.status === "low"; } catch { outsidePaused = false; }
      if (outsidePaused && d.plan.every((p) => [p.tool, ...(p.fallbacks || [])].every((x) => x && !x.firstParty))) {
        throw bad("Outside steps are paused while our spending wallet is topped up; nothing was charged - retry later", 503);
      }
    }

    // Caps, checked before anything is spent (a >= 400 is never charged).
    // These reads refuse early with the right message; the booking below
    // (bookRun) checks the same ceilings again in the same atomic step as the
    // insert, so concurrent requests, in this process or in another
    // container, cannot all pass on the same reading.
    const payerDayCap = cfg.execute.globalDayUsd * cfg.execute.perPayerDayShare;
    const capRefused = (reason) => reason === "payerHour" ? bad(`This wallet has reached its hourly execution ceiling ($${cfg.execute.perWalletHourUsd}); nothing was charged`, 429)
      : reason === "global" ? bad("Outside steps are paused for everyone for up to 24 hours; nothing was charged", 429)
      : bad(`This wallet has reached its daily execution ceiling ($${roundUsd(payerDayCap)}); nothing was charged`, 429);
    if (payer && await ledger.payerExposureUsd(payer, t - 3_600_000) + budget > cfg.execute.perWalletHourUsd) throw capRefused("payerHour");
    // Only a plan that can pay outside sellers is held to the wallet's
    // global daily ceiling; our own tools do not draw on that wallet.
    if (hasOutside && await ledger.globalExposureUsd(t - 86_400_000) + budget > cfg.execute.globalDayUsd) throw capRefused("global");
    if (payer && await ledger.payerExposureUsd(payer, t - 86_400_000) + budget > payerDayCap) throw capRefused("payerDay");

    const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    let redeemed = 0;
    // A ledger failure from the redeem to the booking (refused, or a reply
    // lost after the write landed) must not strand the credit or the run
    // key: nothing is spent yet, so the run is closed as failed (which frees
    // its key) and the credit restored, both conditional on this runId and
    // harmless when neither write landed. A 503, not charged.
    const unbook = async (e) => {
      await finish({ runId, status: "failed", spentUsd: 0, steps: [], now: now() });
      if (input.creditToken) await restore(input.creditToken, runId);
      return Object.assign(bad("The execution ledger is unavailable; nothing was charged - retry shortly", 503), { cause: e });
    };
    if (creditAssumed > 0) {
      try { redeemed = await ledger.redeemCredit(input.creditToken, d.id, runId, t); }
      catch (e) { throw await unbook(e); }
      // The price assumed this credit; if it is gone (used by another run,
      // expired), refuse before spending anything. Not charged.
      if (redeemed + 1e-9 < creditAssumed) {
        if (redeemed) await restore(input.creditToken, runId);
        throw bad("The execution credit this price assumed is no longer available (already used or expired); nothing was charged - request a fresh quote", 409);
      }
    }
    const spendable = roundUsd(Math.min(budget, quoted + redeemed));
    let booked;
    try {
      if (persistSketch) { await persistSketch(); persistSketch = null; }
      booked = await ledger.bookRun({ runId, decisionId: d.id, payer, budgetUsd: spendable, creditUsd: redeemed, runKey, now: t,
        caps: { payerHourUsd: cfg.execute.perWalletHourUsd, globalDayUsd: hasOutside ? cfg.execute.globalDayUsd : null, payerDayUsd: payerDayCap, hourSinceMs: t - 3_600_000, daySinceMs: t - 86_400_000 } });
    } catch (e) { throw await unbook(e); }
    if (!booked.ok) {
      // Lost a race: a concurrent request carrying the same key, or one that
      // took the last of a ceiling's headroom. Nothing was booked.
      if (redeemed) await restore(input.creditToken, runId);
      throw booked.reason === "key" ? bad("This decision already has a run with that key; nothing was charged", 409) : capRefused(booked.reason);
    }

    // One deadline for the whole run, inside what the buyer's payment can
    // still settle (EVM credentials expire), and never past the ceiling.
    const creditMs = runBudgetMs(req);
    const deadline = startedAt + Math.min(Number.isFinite(creditMs) && creditMs > 0 ? creditMs : Infinity, cfg.execute.runDeadlineMs ?? 240_000);
    const left = () => deadline - Date.now();

    const catalog = getCatalog();
    const bySlug = new Map(Object.values(catalog).map((def) => [def.slug, def]));
    const router = bySlug.get("route-execute-pro");
    let spent = 0;
    let mayHaveSpentOutside = false; // an external payment whose outcome we cannot know
    const results = [];
    const outputs = {};
    for (const step of d.plan) {
      let done = null;
      const attempts = [];
      const inputSkips = [];
      const callerParams = stepOverride(step, input.params);
      for (const tool of [step.tool, ...(step.fallbacks || [])]) {
        // This tool's own params: the caller's for the step if given, else the
        // ones the plan wrote for this tool (backups carry their own; a plan
        // from before that falls back to the step's), under this tool's field
        // names for a renamed single input.
        const raw = callerParams || tool.exampleParams || step.tool.exampleParams || {};
        // A "{{step N}}" value is taken from step N's output (an address an ENS
        // lookup resolved); one that cannot be named without guessing skips
        // this tool, and the next one is tried.
        const chained = resolveStepRefs(raw, outputs);
        if (!chained.ok) { inputSkips.push(chained.reason); attempts.push({ id: tool.id, skipped: chained.reason }); continue; }
        // A placeholder the plan could not fill from the task is never sent to
        // a paid tool as if it were the value.
        const open = Object.entries(chained.params).filter(([, v]) => typeof v === "string" && PLACEHOLDER.test(v)).map(([k]) => k);
        if (open.length) { const why = `needs ${open.join(", ")}: pass params for this step`; inputSkips.push(why); attempts.push({ id: tool.id, skipped: why }); continue; }
        const toolParams = fitParamsToSchema(tool.inputSchema, chained.params);
        if (left() < 5000) { attempts.push({ id: tool.id, skipped: "the run's time budget is spent" }); break; }
        if (tool.callDirectly === true) { attempts.push({ id: tool.id, skipped: "call this tool directly: execute cannot pay it" }); continue; }
        const def = tool.firstParty ? bySlug.get(tool.slug) : null;
        const listPrice = tool.firstParty ? priceOfDef(def) : tool.priceUsd;
        if (tool.firstParty && listPrice === null) { attempts.push({ id: tool.id, skipped: "no longer in the catalog" }); continue; }
        const cost = tool.firstParty ? listPrice : roundUsd(listPrice * (1 + cfg.routingFeePct / 100));
        if (spent + cost > spendable + 1e-9) { attempts.push({ id: tool.id, skipped: "over the remaining budget" }); continue; }
        const v = validateParams(tool.inputSchema, toolParams);
        if (!v.ok) { attempts.push({ id: tool.id, skipped: `params do not fit: ${v.errors.slice(0, 3).join("; ")}` }); continue; }
        const t0 = Date.now();
        if (tool.firstParty) {
          // The router's dispatch rules, plus: nothing priced per request and
          // no report composite (those carry their own spend guards and run
          // only as direct calls).
          const why = !dispatchable(def).ok ? dispatchable(def).why
            : typeof def.tierQuote === "function" ? "priced per request; call it directly"
            : isComposite(def.slug) ? "a report product; call it directly"
            : null;
          if (why) { attempts.push({ id: tool.id, skipped: why }); continue; }
          try {
            // No request object: a step must not see (or act on) the paying
            // request's credential, payer or settle hooks.
            // Past the timeout the step's own outbound calls are cut off too,
            // so a late step cannot keep spending upstream while the fallback runs.
            const stepStop = new AbortController();
            const result = await withTimeout(runInAbortableScope(() => Promise.resolve(def.handler(toolParams)), { stopSignal: stepStop.signal }), Math.min(cfg.execute.stepTimeoutMs, left()), tool.slug)
              .catch((e) => { stepStop.abort(e); throw e; });
            spent = roundUsd(spent + cost);
            done = { tool: { id: tool.id, slug: tool.slug, seller: tool.seller, firstParty: true }, costUsd: cost, result, latencyMs: Date.now() - t0 };
            break;
          } catch (e) {
            // A 4xx means our request was wrong for this tool, not that the tool
            // is unreliable; only a failure on the tool's side counts against it.
            attempts.push({ id: tool.id, error: String(e?.message || e).slice(0, 240), status: e?.statusCode || 500, toolFault: !(e?.statusCode >= 400 && e?.statusCode < 500) });
            continue;
          }
        }
        // An outside POST that declares no input fields gets only what the
        // caller passes: never an empty body paid for on a guess (a seller
        // answers {} with a 400, and the leg is a refusal we cannot use).
        if (String(tool.method || "").toUpperCase() === "POST" && !Object.keys(tool.inputSchema?.properties || {}).length && !Object.keys(toolParams || {}).length) {
          attempts.push({ id: tool.id, skipped: "this seller declares no inputs: pass params for this step" }); continue;
        }
        if (!router) { attempts.push({ id: tool.id, skipped: "external execution is not enabled on this host" }); continue; }
        if (outsidePaused) { attempts.push({ id: tool.id, skipped: "outside steps are paused while our spending wallet is topped up" }); continue; }
        // The most this leg may pay: the planned price with room for a small
        // live-price drift, never the whole remaining budget (a leg whose
        // outcome is unknown is booked at this worst case).
        const maxUsd = Math.min(roundUsd((spendable - spent) / (1 + cfg.routingFeePct / 100)), roundUsd(listPrice * 1.5), cfg.execute.perCallMaxUsd);
        // Checked and held in one turn, before the payment: concurrent runs
        // see this leg's worst case against the seller's daily ceiling.
        // A hold the ledger cannot book (refused, or its reply lost) is a leg
        // not paid. After money moved the run goes on without it (a 500 now
        // would leave that spend uncharged); before, the run is refused
        // (503, not charged). A hold row that may have landed is dropped.
        let hold;
        const holdAt = now();
        try { hold = await ledger.holdSellerSpend({ runId, seller: tool.seller, amountUsd: maxUsd, now: holdAt, capUsd: cfg.execute.perSellerDayUsd, sinceMs: t - 86_400_000 }); }
        catch (e) {
          if (typeof ledger.dropSellerHold === "function") {
            const lost = { runId, seller: tool.seller, amountUsd: maxUsd, now: holdAt };
            await afterSpend(`drop unbooked hold ${runId}`, "dropSellerHold", lost, () => ledger.dropSellerHold(lost));
          }
          if (spent > 0 || mayHaveSpentOutside || results.some((r) => r.status === "ok")) { attempts.push({ id: tool.id, skipped: "the spend ledger is unavailable; this leg was not paid" }); continue; }
          await finish({ runId, status: "failed", spentUsd: 0, steps: [], now: now() });
          if (redeemed) await restore(input.creditToken, runId);
          throw Object.assign(bad("The execution ledger is unavailable; nothing was charged - retry shortly", 503), { cause: e });
        }
        if (hold === false) { attempts.push({ id: tool.id, skipped: "this seller's daily execution ceiling is reached" }); continue; }
        try {
          const r = await withTimeout(router.handler({ task: `${step.purpose} (${tool.name})`, include: "external", target: tool.endpoint, params: toolParams, maxUsd }, req), Math.min(left(), cfg.execute.externalStepTimeoutMs), tool.seller);
          const underlying = Number(r?.receipt?.underlyingPriceUsd);
          const paidOut = Number.isFinite(underlying) && underlying > 0 ? underlying : maxUsd; // unknown: book the worst case
          const fee = roundUsd(paidOut * cfg.routingFeePct / 100);
          spent = roundUsd(spent + paidOut + fee);
          await settleHold(runId, hold, paidOut);
          // The router's receipt prices the router's own call (paidUsd is its
          // tier price, routingFeeUsd the tier price minus the seller's). This
          // run charges the seller's price plus decide's fee, so those two
          // fields are replaced with this step's own figures.
          const receipt = r?.receipt && typeof r.receipt === "object" ? { ...r.receipt, paidUsd: roundUsd(paidOut + fee), routingFeeUsd: fee } : r?.receipt;
          done = { tool: { id: tool.id, slug: tool.slug, seller: tool.seller, firstParty: false }, costUsd: roundUsd(paidOut + fee), routingFeeUsd: fee, result: r?.result, receipt, untrustedContent: true, latencyMs: Date.now() - t0 };
          break;
        } catch (e) {
          const timedOut = e?.statusCode === 504 && /did not answer within/.test(String(e?.message));
          const maybePaid = timedOut || e?.committed === true || e?.paidUnanswered === true || /no other seller is tried/.test(String(e?.message));
          // A seller that refuses a valid payment, or rejects the paid retry,
          // failed on its own side whatever status the router relays: it counts
          // against the seller's reliability, so the next plans rank it lower.
          const sellerRefused = /refused the payment|rejected the paid retry|Seller .* failed/i.test(String(e?.message || ""));
          attempts.push({ id: tool.id, error: String(e?.message || e).slice(0, 240), status: e?.statusCode || 500, toolFault: sellerRefused || !(e?.statusCode >= 400 && e?.statusCode < 500), ...(maybePaid ? { mayHavePaid: true } : {}) });
          if (maybePaid) {
            // The payment may have left (or may still leave: a timed-out leg is
            // not cancelled). Book its worst case and try no other paid seller.
            mayHaveSpentOutside = true;
            // What the signed credential could move, when the payer said; else the cap.
            const signed = Number(e?.signedUsd);
            const exposure = Number.isFinite(signed) && signed >= 0 && !timedOut ? Math.min(signed, maxUsd) : maxUsd;
            spent = roundUsd(spent + exposure * (1 + cfg.routingFeePct / 100));
            await settleHold(runId, hold, exposure);
            attempts[attempts.length - 1].bookedUsd = roundUsd(exposure); // the worst case booked for this leg (read by the reconciliation)
            break;
          }
          await settleHold(runId, hold, 0); // refused before any payment: nothing left
        }
      }
      if (done) { outputs[String(step.step)] = done.result; results.push({ step: step.step, status: "ok", ...done, ...(attempts.length ? { attempts } : {}) }); }
      // Every tool was held back for want of an input: the step is skipped
      // (nothing was tried, nothing paid), and the first reason says why.
      else if (inputSkips.length && inputSkips.length === attempts.length) results.push({ step: step.step, status: "skipped", reason: inputSkips[0], attempts });
      else results.push({ step: step.step, status: "failed", attempts });
    }

    sendObservations(results.flatMap((r) => [
      // A leg that may have been paid and still failed is the worst outcome a
      // seller can give: it counts against the tool like any tool-side failure.
      ...(r.attempts || []).filter((a) => a.error && (a.toolFault || a.mayHavePaid)).map((a) => ({ toolId: a.id, ok: false, source: "execution", by: observerId(payer) })),
      ...(r.status === "ok" ? [{ toolId: r.tool.id, ok: true, latencyMs: r.latencyMs, source: "execution", by: observerId(payer) }] : []),
    ]));
    const okSteps = results.filter((r) => r.status === "ok").length;
    const nothingSpent = spent === 0 && !mayHaveSpentOutside;
    if (!okSteps) {
      const failedAt = now();
      await finish({ runId, status: "failed", spentUsd: spent, steps: results, now: failedAt });
      // A credit comes back only when nothing left our wallet.
      if (redeemed && nothingSpent) await restore(input.creditToken, runId);
      // Caused by the caller's own inputs (skipped steps, params that do not
      // fit, 4xx answers) with nothing spent: a 400, which the spend-then-fail
      // breaker does not count. A tool-side failure or any spend: a 502.
      const callerCaused = nothingSpent && results.every((r) => r.status === "skipped" || (r.attempts || []).every((a) => a.skipped || (a.status >= 400 && a.status < 500)));
      throw Object.assign(bad(`No step of the plan could be run (${results.map((r) => `step ${r.step}: ${r.reason || (r.attempts || []).map((a) => a.error || a.skipped).join(" / ")}`).join("; ").slice(0, 600)}). Nothing was charged.`, callerCaused ? 400 : 502), { steps: results });
    }
    const finishedAt = now();
    const finalSteps = results.map(({ result, ...r }) => r);
    await finish({ runId, status: okSteps === results.length ? "complete" : "partial", spentUsd: spent, steps: finalSteps, now: finishedAt });
    // Unspent funds (what was paid plus the credit, less what was spent)
    // return as a credit on the same decision, live once this payment settles
    // and expiring WITH the decision, so a credit is never rolled forward.
    const leftover = roundUsd(quoted + redeemed - spent);
    const decisionExpiry = d.createdAt + cfg.credit.ttlHours * 3_600_000;
    let leftoverCredit = null;
    if (leftover >= 0.001 && decisionExpiry > now() + 60_000) {
      // The token is drawn first, so every attempt mints the same credit: a
      // mint that fails here is queued for retry like the other writes after
      // a spend, and the buyer gets the token now. The credit is activated
      // once the payment settles and the mint has landed (the activation
      // retries until the row exists); a settlement that fails leaves it
      // pending, never spendable.
      const token = newCreditToken();
      const hash = hashToken(token);
      const mintArgs = { decisionId: d.id, amountUsd: leftover, expiresAt: decisionExpiry, payer, now: now(), token };
      let c = null;
      for (let i = 0; i < 2 && !c; i++) {
        try { c = await ledger.mintCredit(mintArgs); }
        catch (e) { console.warn(`[decide] mint leftover credit ${runId}: ledger write failed (${String(e?.message || e).slice(0, 120)})`); }
      }
      const minted = Boolean(c);
      // A mint that did not land is journaled before the answer and retried;
      // the activation (after settlement) retries until the mint is in, and
      // is journaled too, behind the mint. Both are idempotent.
      if (!minted) {
        journalOf(ledger, "mintCredit", mintArgs)?.();
        retryLedgerWrite(`mint leftover credit ${runId}`, () => ledger.mintCredit(mintArgs), ledgerRetryMs);
      }
      onSettled(req, (settledOk) => {
        if (!settledOk) return;
        fireRetry(`activate credit ${runId}`, () => activateRecorded(ledger, token, hash), ledgerRetryMs, journalOf(ledger, "activateCredit", { hash }));
      });
      const expiresAt = c ? c.expiresAt : decisionExpiry;
      leftoverCredit = { amountUsd: c ? c.amountUsd : roundUsd(leftover), expiresAt: new Date(expiresAt).toISOString(), token, activeAfterPaymentSettles: true, ...(minted ? {} : { recordPending: true }) };
    }
    // A settlement that fails after this run spent money forfeits the credit:
    // restoring it would let the same credit fund run after run.
    if (redeemed && nothingSpent) onSettled(req, (settledOk) => { if (!settledOk) fireRetry(`restore credit ${runId}`, () => ledger.restoreCredit(input.creditToken, runId), ledgerRetryMs, journalOf(ledger, "restoreCredit", { token: input.creditToken, runId })); });
    // What the spend was, on separate lines: our own tools, what was passed
    // through to outside sellers, and the routing fee on it.
    const okResults = results.filter((r) => r.status === "ok");
    const routingFeesUsd = roundUsd(okResults.reduce((a, r) => a + (r.routingFeeUsd || 0), 0));
    const passThroughUsd = roundUsd(okResults.filter((r) => !r.tool.firstParty).reduce((a, r) => a + (r.costUsd || 0), 0) - routingFeesUsd);
    const firstPartyUsd = roundUsd(okResults.filter((r) => r.tool.firstParty).reduce((a, r) => a + (r.costUsd || 0), 0));
    return {
      runId, decisionId: d.id, status: okSteps === results.length ? "complete" : "partial",
      ...(sketchFeedbackToken ? { feedbackToken: sketchFeedbackToken, feedback: "POST /api/decide/feedback { decisionId, feedbackToken, step, outcome: success|failure, quality?: 1-5, latencyMs? } - free, one verdict per step" } : {}),
      steps: results, budgetUsd: spendable, spentUsd: spent, paidUsd: quoted, creditAppliedUsd: redeemed,
      charges: { firstPartyUsd, passThroughUsd, routingFeesUsd, uncertainUsd: roundUsd(Math.max(0, spent - firstPartyUsd - passThroughUsd - routingFeesUsd)) },
      routingFeePct: cfg.routingFeePct, leftoverCredit,
    };
  };
}

// ---------------------------------------------------------------- feedback

const OUTCOMES = new Set(["success", "failure"]);

/** Free: a buyer's verdict on one step of a decision they bought. */
export function makeFeedbackHandler({ ledger, send = callService, now = () => Date.now() }) {
  const refusal = () => bad("decisionId and feedbackToken do not match a decision", 403);
  // One answer for "unknown decision" and "wrong token": a stranger learns
  // nothing about which decisions exist. The ledger on the state database
  // answers in promises, so the handler is async there and sync on the file.
  if (ledger.async) {
    return async function feedback(body) {
      const b = body && typeof body === "object" ? body : {};
      const decisionId = String(b.decisionId || "");
      if (!(await ledger.feedbackTokenOk(decisionId, b.feedbackToken))) throw refusal();
      const d = await ledger.getDecision(decisionId);
      const v = validate(b, d);
      const replaced = await ledger.saveFeedback({ decisionId, ...v, now: now() });
      return finish(decisionId, d, v, replaced);
    };
  }
  return function feedback(body) {
    const b = body && typeof body === "object" ? body : {};
    const decisionId = String(b.decisionId || "");
    if (!ledger.feedbackTokenOk(decisionId, b.feedbackToken)) throw refusal();
    const d = ledger.getDecision(decisionId);
    const v = validate(b, d);
    const replaced = ledger.saveFeedback({ decisionId, ...v, now: now() });
    return finish(decisionId, d, v, replaced);
  };
  function validate(b, d) {
    const step = Number(b.step);
    const planned = d.plan.find((p) => p.step === step);
    if (!Number.isInteger(step) || !planned) throw bad(`"step" must be one of ${d.plan.map((p) => p.step).join(", ") || "(none)"}`);
    const outcome = String(b.outcome || "").toLowerCase();
    if (!OUTCOMES.has(outcome)) throw bad('"outcome" must be success or failure');
    const quality = b.quality === undefined ? null : Number(b.quality);
    if (quality !== null && !(Number.isInteger(quality) && quality >= 1 && quality <= 5)) throw bad('"quality" must be an integer 1-5');
    const latencyMs = b.latencyMs === undefined ? null : Number(b.latencyMs);
    if (latencyMs !== null && !(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 600_000)) throw bad('"latencyMs" must be 0-600000');
    // Which tool: the step's primary unless the buyer names one of its fallbacks.
    const ids = [planned.tool.id, ...(planned.fallbacks || []).map((f) => f.id)];
    const toolId = b.toolId === undefined ? planned.tool.id : String(b.toolId);
    if (!ids.includes(toolId)) throw bad('"toolId" must be the step\'s tool or one of its fallbacks');
    return { step, toolId, outcome, quality, latencyMs };
  }
  function finish(decisionId, d, { step, toolId, outcome }, replaced) {
    // A replaced verdict is not counted twice.
    if (!replaced) sendObservations([{ toolId, ok: outcome === "success", source: "feedback", by: observerId(d.payer) }], { send });
    return { ok: true, decisionId, step, toolId, outcome, replaced };
  }
}


const EXAMPLE_OUT = {
  decisionId: "dec_2b1c9e0f4a7d4c3e9b8a1f00",
  task: "Research the latest EU AI Act obligations for general-purpose models, with citations",
  depth: "plan",
  plan: [{
    step: 1, purpose: "search recent sources on the EU AI Act GPAI obligations",
    tool: { id: "a1b2", slug: "search", name: "Web search", seller: "agent402", firstParty: true, endpoint: "https://agent402.tools/api/search", method: "GET", rail: "x402", rails: ["x402", "mpp"], networks: ["eip155:8453"], priceUsd: 0.02, executeViaAgent402Usd: 0.02, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, exampleParams: { q: "EU AI Act general-purpose AI model obligations 2026" }, exampleParamsSource: "task" },
    why: "fit 0.92, score 0.801", score: 0.801, fallbacks: [], dependsOn: [],
  }],
  estimatedCostUsd: 0.02, estimatedCostViaAgent402Usd: 0.02, estimatedLatencyMs: 1500,
  confidence: 0.92, partial: false, gaps: [], cached: false, priceUsd: 0.02,
  ranking: { weights: { fit: 0.45, reliability: 0.2, price: 0.15, schema: 0.1, freshness: 0.1 }, firstPartyWeight: 0 },
  neutrality: NEUTRALITY_NOTE,
};

export function buildDecideTools({ getCatalog, ledger = openDecideLedger(), now = () => Date.now() } = {}) {
  return [
    {
      route: "POST /api/decide",
      name: "Decide: tool plan for a task",
      slug: "decide",
      category: "agent",
      price: `$${priceForDepth("quick").toFixed(3)}`,
      quote: (body) => decideQuoteUsd(body),
      // Quoted by depth: the listed price is quick's, the ceiling is full's.
      quoteMaxUsd: priceForDepth("full"),
      description:
        "Describe a job and get a call-ready plan: which tools, across this catalog and outside x402 sellers with a recently verified 402, solve it end to end, in what order, with fallbacks, input params that validate against each tool's schema, and cost/latency estimates. Priced by depth: quick (one best tool), plan (steps + fallbacks), full (plan + params + compiled prompt). The fee comes back as a credit toward running the plan with POST /api/decide/execute. The ranking formula has no first-party term; every tool carries firstParty. Uncovered needs are listed in gaps.",
      tags: ["agents", "routing", "planning", "discovery", "x402"],
      discovery: {
        bodyType: "json",
        input: { task: "Research the latest EU AI Act obligations for general-purpose models, with citations", depth: "plan" },
        inputSchema: {
          properties: {
            task: { type: "string", description: "What the agent needs done (max 2000 chars)" },
            depth: { type: "string", enum: DEPTHS, description: "quick | plan (default) | full" },
            constraints: { type: "object", description: "maxBudgetUsd, maxLatencyMs, rails [x402|mpp], chains [CAIP-2 or namespace], excludeSellers [host], requireDeterministic" },
          },
          required: ["task"],
        },
        output: { example: EXAMPLE_OUT },
      },
      handler: makeDecideHandler({ ledger, now }),
    },
    {
      route: "POST /api/decide/execute",
      name: "Decide: execute a plan",
      slug: "decide-execute",
      category: "agent",
      price: "$0.001",
      spendsOwnWallet: true,
      // Outside steps are bought from the Base spending wallet, which only a
      // Base payment funds: other EVM chains are not offered (credits and card
      // still work).
      onlyNetworks: ["eip155:8453"],
      quote: (body) => executeQuoteUsd(body, { ledger, now: now(), getCatalog }),
      // The budget is capped per call (executeBudgetUsd), so that is the ceiling.
      quoteMaxUsd: decideConfig().execute.perCallMaxUsd,
      description:
        "Run a decision's plan through Agent402: first-party steps run directly, third-party steps are bought from the seller and resold to you (you pay on Base, or by credits or card) at the seller's price plus a disclosed markup. Priced at the plan's budget (or your maxBudgetUsd, whichever you set) less a valid execution credit; spend stops at that budget, fallbacks are tried in order, and any unspent amount comes back as a credit. A run where no step succeeds is not charged. Also runs a free plan sketch: pass the sketch's tool slugs as steps (no decisionId) with params for step 1, and each later step takes its one required input from the step before, at list price.",
      tags: ["agents", "execute", "planning", "router", "x402"],
      discovery: {
        bodyType: "json",
        input: { decisionId: "dec_2b1c9e0f4a7d4c3e9b8a1f00", creditToken: "dc_...", maxBudgetUsd: 0.05 },
        inputSchema: {
          properties: {
            decisionId: { type: "string", description: "From POST /api/decide (or pass steps instead)" },
            steps: { type: "array", items: { type: "string" }, description: "Instead of decisionId: the tool slugs of a free plan sketch (from /api/find or /api/route), 2 to 5, in order. Pass params for step 1; a later step takes its one required input from the step before." },
            creditToken: { type: "string", description: "executionCredit.token from that decision (optional)" },
            maxBudgetUsd: { type: "number", description: "Spend ceiling for the run (default: the plan's estimate via Agent402)" },
            params: { type: "object", description: "Per-step params overriding the plan's exampleParams, keyed by step number" },
          },
          required: [],
        },
        output: { example: { runId: "run_…", decisionId: "dec_…", status: "complete", steps: [{ step: 1, status: "ok", tool: { slug: "search", seller: "agent402", firstParty: true }, costUsd: 0.02, result: {} }], budgetUsd: 0.02, spentUsd: 0.02, paidUsd: 0.001, creditAppliedUsd: 0.02, routingFeePct: 5, leftoverCredit: null } },
      },
      handler: makeExecuteHandler({ ledger, getCatalog, now }),
    },
  ];
}
