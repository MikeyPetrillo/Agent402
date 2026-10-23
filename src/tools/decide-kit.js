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

import { runInAbortableScope, drainSignal, clientGoneSignal } from "../drain-abort.js";
import { decideConfig, priceForDepth, DEPTHS } from "../decide/config.js";
import { recordWish } from "../wish.js";
import { payerFromRequest } from "../payer.js";
import { openDecideLedger, hashToken, newCreditToken } from "../decide/ledger.js";
import { validateParams, fitParamsToSchema } from "../decide/params.js";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { dispatchable } from "./route-execute.js";
import { EXPENSIVE_COMPOSITE_SLUGS } from "../composite-spend-guard.js";
import { evmCredentialBudgetMs } from "../evm-validity.js";
import { resolveStepRefs, STEP_REF } from "../decide/step-refs.js";
import { hasLastingEffect } from "../hangup-forgiveness.js";
import { sketchPlan, sketchListPriceUsd, SKETCH_MIN_STEPS, SKETCH_MAX_STEPS } from "../decide/sketch-plan.js";
import { planShape } from "../decide/plan-shape.js";
import { attemptErrorCode } from "../decide/skip-codes.js";
export { SKIP_CODES, attemptErrorCode, skipCodeOf } from "../decide/skip-codes.js";

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
    try { kept = journal ? Boolean(journal()) : false; } catch { kept = false; } // the journal answers its entry id (or true) when on disk
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
/** The refusal for a decisionId this server never answered (or has dropped):
 *  where a real one comes from, and how to run without one. */
export const UNKNOWN_DECISION_MESSAGE = 'Unknown decisionId: a decisionId comes from a paid POST /api/decide answer and is kept 30 days. To run without one, pass "steps" (the tool slugs of a free plan sketch from GET /api/find?q=<task>, in order) and "params" for step 1. Nothing was charged.';
/** The planner version a free plan sketch's decision records. */
export const SKETCH_PLANNER_VERSION = "sketch";

/** Our own traffic (a signed probe, one of our wallets), as the server detects
 *  it; never able to fail a paid request. */
const ownTraffic = (isOwnTraffic, req) => { try { return req ? isOwnTraffic(req) === true : false; } catch { return false; } };

export function makeDecideHandler({ ledger, now = () => Date.now(), isOwnTraffic = () => false }) {
  return async function decideHandler(input, req) {
    const depth = String(input?.depth ?? "plan").toLowerCase();
    if (!DEPTHS.includes(depth)) throw bad(`"depth" must be one of ${DEPTHS.join(", ")}`);
    const cfg = decideConfig();
    const priceUsd = decideQuoteUsd(input);
    const payer = payerOf(req);
    const synthetic = ownTraffic(isOwnTraffic, req);
    // A Tempo credential is only settleable for about 25s after signing, and
    // settlement follows the answer: its decision is bounded well inside that.
    const budgetMs = req?.mppTempoCredential ? Math.min(cfg.budgetMs[depth], TEMPO_DECISION_BUDGET_MS) : cfg.budgetMs[depth];
    const answer = await callService("/internal/decide", {
      task: input?.task, constraints: input?.constraints, depth,
      payer, rail: req?.mppTempoCredential ? "mpp" : "x402", priceUsd, synthetic,
      deadlineAt: Date.now() + budgetMs + 3000,
    }, { timeoutMs: budgetMs + 4000 });
    // The planner version and plan shape are kept with the decision for the
    // operator stats; neither is part of the answer.
    const { plannerVersion = null, shape = null, ...out } = answer || {};
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
    const row = { decisionId: id, depth, priceUsd, payer, plan: out.plan, costViaUsd: out.estimatedCostViaAgent402Usd || 0, feedbackHash: hashToken(feedbackToken), now: now(),
      plannerVersion: typeof plannerVersion === "string" ? plannerVersion.slice(0, 64) : null, shapeKey: typeof shape?.shapeKey === "string" ? shape.shapeKey.slice(0, 40) : null, synthetic };
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
      ...(depth === "quick" ? { upgrade: 'depth "plan" splits the job into steps, each with fallbacks and params; "full" adds a compiled prompt' } : {}),
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
  return Math.max(floor, roundUsd(budget - credit + replanPriceUsd(body, d)));
}

/** What `replan: true` adds to an execute quote: the plan price at the saved
 *  decision's own depth, the same as a fresh POST /api/decide at that depth.
 *  It is never spent on steps: a re-plan that does not happen returns it as
 *  credit with the run's unspent budget. Zero for a sketch or without replan. */
export function replanPriceUsd(body, d, cfg = decideConfig()) {
  if (body?.replan !== true || !d || !DEPTHS.includes(d.depth)) return 0;
  return priceForDepth(d.depth, cfg);
}

const toolBrief = (t) => (t ? {
  id: t.id, slug: t.slug ?? null, seller: t.seller ?? null, firstParty: t.firstParty === true,
  priceUsd: Number.isFinite(t.executeViaAgent402Usd) ? t.executeViaAgent402Usd : Number.isFinite(t.priceUsd) ? t.priceUsd : null,
} : null);
/** Per step, the lead tool a re-plan changed against the saved plan (tool,
 *  seller or price), in step order; a step the new plan added or dropped has
 *  null on the side that lacks it. Empty when nothing changed. */
export function planChanges(before = [], after = []) {
  const out = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const b = toolBrief(before[i]?.tool), a = toolBrief(after[i]?.tool);
    if (b && a && b.id === a.id && b.seller === a.seller && b.priceUsd === a.priceUsd) continue;
    out.push({ step: (after[i] || before[i]).step ?? i + 1, before: b, after: a });
  }
  return out;
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

// ------------------------------------------------- run scheduling (execute)

/** Most steps of one run in flight at once (DECIDE_CONFIG execute.maxParallelSteps). */
export function maxParallelSteps(cfg = decideConfig()) {
  const n = Math.floor(Number(cfg?.execute?.maxParallelSteps));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 3;
}

/** Every params object a step may send: the caller's for the step, else each tool's own. */
function paramSetsOf(step, overrides) {
  const caller = stepOverride(step, overrides);
  if (caller) return [caller];
  return [step?.tool?.exampleParams, ...((step?.fallbacks || []).map((f) => f?.exampleParams))].filter((p) => p && typeof p === "object");
}

/**
 * Which steps each step waits for, as plan indexes. A step waits for every
 * step in its dependsOn and every earlier step one of its params names as
 * "{{step N}}", so a value it takes from another step is always there when it
 * starts. A plan the graph cannot be read from (a step number repeated or not
 * an integer, a dependsOn that is not a list, or that names a step that is not
 * earlier in the plan: unknown, itself, later, or a cycle) runs in plan order,
 * one step at a time, as every plan did before.
 * A step whose tool (or any fallback) leaves state behind (hasLastingEffect:
 * the memory writers, attest, feedback, ...) is a barrier: it waits for every
 * earlier step and every later step waits for it, so a write and a read of the
 * same state keep plan order even when the plan names no edge between them.
 * @returns {{ parallel: boolean, deps: number[][], why?: string }}
 */
export function planSchedule(plan, overrides) {
  const steps = Array.isArray(plan) ? plan : [];
  const sequential = (why) => ({ parallel: false, why, deps: steps.map((_, i) => (i ? [i - 1] : [])) });
  const indexOf = new Map();
  for (const [i, p] of steps.entries()) {
    const k = Number(p?.step);
    if (!Number.isInteger(k) || indexOf.has(k)) return sequential("step numbers are not distinct integers");
    indexOf.set(k, i);
  }
  const deps = [];
  for (const [i, p] of steps.entries()) {
    if (!Array.isArray(p.dependsOn)) return sequential(`step ${p.step} has no dependsOn list`);
    const set = new Set();
    for (const raw of p.dependsOn) {
      const j = Number.isInteger(Number(raw)) ? indexOf.get(Number(raw)) : undefined;
      if (j === undefined || j >= i) return sequential(`step ${p.step} depends on ${String(raw).slice(0, 24)}, which is not an earlier step`);
      set.add(j);
    }
    for (const params of paramSetsOf(p, overrides)) {
      for (const v of Object.values(params)) {
        const m = typeof v === "string" ? STEP_REF.exec(v) : null;
        const j = m ? indexOf.get(Number(m[1])) : undefined;
        if (j !== undefined && j < i) set.add(j);
      }
    }
    deps.push(set);
  }
  const barrier = steps.map((p) => [p?.tool, ...(Array.isArray(p?.fallbacks) ? p.fallbacks : [])].some((t) => hasLastingEffect(t?.slug)));
  for (let i = 0; i < steps.length; i++) {
    for (let j = 0; j < i; j++) if (barrier[i] || barrier[j]) deps[i].add(j);
  }
  return { parallel: true, deps: deps.map((s) => [...s].sort((a, b) => a - b)) };
}

/**
 * The run's budget, shared by its steps. A step reserves its worst case
 * before it starts (the check and the reservation are one synchronous step,
 * so two steps in flight cannot both pass on the same headroom), then turns
 * the reservation into what it spent, or gives it back. A step that would fit
 * once a sibling in flight finishes waits for it; one that cannot fit even if
 * every sibling spends nothing is refused at once.
 */
export function makeSpendPool(spendable) {
  let spent = 0, reserved = 0, holders = 0;
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; for (const fn of w) fn(); };
  const pool = {
    get spent() { return spent; },
    get reserved() { return reserved; },
    /** Reservations not yet settled or given back. */
    get holders() { return holders; },
    wake,
    /** A reservation of size(available) (at least `need`), or null when it can never fit, or "wait". */
    tryReserve(need, size = () => need) {
      if (spent + need > spendable + 1e-9) return null;
      const available = roundUsd(spendable - spent - reserved);
      // Waiting needs a sibling whose reservation can come back; with none, it never fits.
      if (need > available + 1e-9) return holders > 0 ? "wait" : null;
      const amount = Math.max(need, Number(size(available)) || 0);
      reserved = roundUsd(reserved + amount);
      holders++;
      return { amount, open: true };
    },
    /** Waits while only siblings' reservations stand in the way; "halted" when halt() says so. */
    async reserve(need, size, halt = () => null) {
      for (;;) {
        if (halt()) return "halted";
        const r = pool.tryReserve(need, size);
        if (r !== "wait") return r;
        await new Promise((res) => waiters.push(res));
      }
    },
    commit(h, usd) {
      if (!h?.open) return;
      h.open = false; holders--;
      reserved = holders ? roundUsd(Math.max(0, reserved - h.amount)) : 0;
      spent = roundUsd(spent + usd);
      wake();
    },
    release(h) {
      if (!h?.open) return;
      h.open = false; holders--;
      reserved = holders ? roundUsd(Math.max(0, reserved - h.amount)) : 0;
      wake();
    },
  };
  return pool;
}

/** Rejects (503, marked runStopped) as soon as the run's stop signal fires. */
function raceStop(promise, signal) {
  if (!signal) return promise;
  let onAbort;
  const stopped = new Promise((_, rej) => {
    onAbort = () => rej(Object.assign(bad(`the run was stopped: ${String(signal.reason?.message || "stopped").slice(0, 160)}`, 503), { runStopped: true }));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  stopped.catch(() => {});
  return Promise.race([promise, stopped]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** The drain signal and, inside a paid request's scope, the buyer's client-gone signal. */
function defaultRunStopSignal() {
  // Always a signal of the run's own (never the process-wide one itself), so
  // a listener added for the run cannot pile up on a long-lived signal.
  const parts = [drainSignal(), clientGoneSignal()].filter(Boolean);
  return parts.length ? AbortSignal.any(parts) : null;
}

export function makeExecuteHandler({ ledger, getCatalog, now = () => Date.now(), isOwnTraffic = () => false, isComposite = (slug) => EXPENSIVE_COMPOSITE_SLUGS.has(slug), runBudgetMs = (req) => evmCredentialBudgetMs(req), spendingWalletStatus = async () => (await import("../upstream-buyer-status.js")).upstreamBuyerStatus(), ledgerRetryMs = LEDGER_RETRY_MS, runStopSignal = defaultRunStopSignal, replan = (body, opts) => callService("/internal/replan", body, opts) }) {
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
    const synthetic = ownTraffic(isOwnTraffic, req);
    const t = now();
    // One run per (decision, runKey): a client that timed out and paid again
    // gets the first run's id back, not a second run (a 409 is not charged).
    const runKey = typeof input?.runKey === "string" && input.runKey ? input.runKey.slice(0, 128)
      : typeof req?.headers?.["idempotency-key"] === "string" && req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]).slice(0, 128) : null;
    let decisionId = String(input?.decisionId || "");
    if (input?.replan != null && typeof input.replan !== "boolean") throw bad('"replan" must be true or false');
    const wantsReplan = input?.replan === true;
    let d = null;
    let persistSketch = null, sketchFeedbackToken = null;
    if (decisionId) {
      d = await ledger.getDecision(decisionId);
      if (!d) throw bad(UNKNOWN_DECISION_MESSAGE, 404);
      if (!d.settled) throw bad("That decision's payment has not settled, so it cannot be executed", 409);
    } else if (Array.isArray(input?.steps)) {
      if (wantsReplan) throw bad('"replan" plans a saved decision again: pass its decisionId (a sketch has no task to plan from)');
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
        // A sketch has no model planner: its version says so, and its shape
        // is computed here by the same rule the decide service uses.
        const shapeKey = planShape(sk.plan, { gaps: [] }).shapeKey;
        d = { id: decisionId, createdAt: t, depth: "sketch", priceUsd: 0, payer, plan: sk.plan, costViaUsd: sk.costUsd, settled: true, plannerVersion: SKETCH_PLANNER_VERSION, shapeKey, synthetic };
        persistSketch = async () => {
          await ledger.saveDecision({ decisionId, depth: "sketch", priceUsd: 0, payer, plan: sk.plan, costViaUsd: sk.costUsd, feedbackHash: hashToken(feedbackToken), now: t, plannerVersion: SKETCH_PLANNER_VERSION, shapeKey, synthetic });
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
    // A re-plan's price rides on the same payment and is never spent on steps.
    const planCharge = replanPriceUsd(input, d, cfg);
    const runPaid = roundUsd(Math.max(0, quoted - planCharge));
    const creditAssumed = roundUsd(Math.max(0, budget - runPaid));

    const prior = await ledger.runByKey(d.id, runKey);
    if (prior) {
      // The payer that ran it gets that run's outcome back with the refusal
      // (still a 409, so nothing is charged again); anyone else gets the id only.
      const own = prior.status !== "running" && payer && prior.payer === payer;
      throw Object.assign(bad(`This decision already has a run with that key (${prior.id}, ${prior.status}); nothing was charged`, 409), { runId: prior.id, ...(own ? { priorRun: { id: prior.id, status: prior.status, spentUsd: prior.spentUsd, steps: prior.steps } } : {}) });
    }

    // REPLAN: the saved decision's task, constraints and depth go through the
    // planner again and the run executes the new plan. The run stays booked
    // on the saved decision (its run key, credit and budget are the ones the
    // quote priced); the new plan is recorded as a decision of its own, with
    // its own feedback token. A re-plan that does not happen runs the saved
    // plan and returns its price as credit, which the saved decision's credit
    // window must still be open to hold; when it is not, the call is refused
    // before anything is spent (not charged).
    let replanned = null;
    if (wantsReplan) {
      const saved = d;
      const creditMs = runBudgetMs(req);
      const planMs = Math.min(cfg.budgetMs[saved.depth] ?? cfg.budgetMs.plan, Number.isFinite(creditMs) && creditMs > 0 ? creditMs / 2 : Infinity);
      let fresh = null, why = null;
      try {
        const ans = await replan({ decisionId: saved.id, payer, rail: req?.mppTempoCredential ? "mpp" : "x402", priceUsd: planCharge, synthetic, deadlineAt: Date.now() + planMs }, { timeoutMs: planMs + 1000 });
        if (!Array.isArray(ans?.plan) || !ans.plan.length) why = "no indexed tool covers the task now";
        else if (ans.judged === false) why = "the new plan could not be judged";
        else fresh = ans;
      } catch (e) {
        why = e?.statusCode === 404 ? "the saved task is no longer held (decisions are kept 30 days)" : "the planner did not answer in time";
      }
      if (fresh) {
        const feedbackToken = `fb_${randomBytes(18).toString("base64url")}`;
        const id = fresh.decisionId;
        const row = { decisionId: id, depth: saved.depth, priceUsd: planCharge, payer, plan: fresh.plan, costViaUsd: fresh.estimatedCostViaAgent402Usd || 0, feedbackHash: hashToken(feedbackToken), now: now(),
          plannerVersion: typeof fresh.plannerVersion === "string" ? fresh.plannerVersion.slice(0, 64) : null, shapeKey: typeof fresh.shape?.shapeKey === "string" ? fresh.shape.shapeKey.slice(0, 40) : null, synthetic };
        await afterSpend(`save decision ${id}`, "saveDecision", row, () => ledger.saveDecision(row));
        onSettled(req, (settledOk) => { if (settledOk) fireRetry(`settle decision ${id}`, () => markSettledRecorded(ledger, id), ledgerRetryMs, journalOf(ledger, "markDecisionSettled", { decisionId: id })); });
        const changes = planChanges(saved.plan, fresh.plan);
        replanned = { ran: true, decisionId: id, feedbackToken, priceUsd: planCharge, unchanged: changes.length === 0, changes, estimatedCostViaAgent402Usd: row.costViaUsd };
        d = { ...saved, plan: fresh.plan, plannerVersion: row.plannerVersion, shapeKey: row.shapeKey };
      } else if (saved.createdAt + cfg.credit.ttlHours * 3_600_000 > now() + 60_000) {
        replanned = { ran: false, reason: why, priceUsd: planCharge, returnedAsCredit: true };
      } else {
        throw bad(`The re-plan could not run (${why}); nothing was charged. Retry, or send the same body without "replan" to run the saved plan.`, 503);
      }
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
    const spendable = roundUsd(Math.min(budget, runPaid + redeemed));
    let booked;
    try {
      if (persistSketch) { await persistSketch(); persistSketch = null; }
      booked = await ledger.bookRun({ runId, decisionId: d.id, payer, budgetUsd: spendable, creditUsd: redeemed, runKey, now: t,
        plannerVersion: d.plannerVersion || null, shapeKey: d.shapeKey || null, synthetic: synthetic || d.synthetic === true,
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
    let mayHaveSpentOutside = false; // an external payment whose outcome we cannot know
    const outputs = {};
    // Steps run as their dependencies finish, up to maxParallelSteps at once,
    // in plan order among the ready ones; everything the buyer reads stays in
    // plan order. Every step draws on one budget (the pool): a leg reserves
    // its worst case before it starts and settles it after.
    const schedule = planSchedule(d.plan, input.params);
    if (!schedule.parallel && d.plan.length > 1) console.warn(`[decide] run ${runId}: steps run in plan order (${schedule.why})`);
    const pool = makeSpendPool(spendable);
    const stop = (() => { try { return runStopSignal() || null; } catch { return null; } })();
    const stopWhy = () => String(stop?.reason?.message || "stopped").slice(0, 160);
    let refusedBy = null; // the ledger error that refuses the whole run (503) before anything was spent
    let defect = null; // a step that threw (a defect, not a tool failure)
    const halt = () => (refusedBy ? "refused" : defect ? "defect" : stop?.aborted ? "stopped" : null);
    const haltSkip = () => (refusedBy ? "the run was refused before this leg started" : defect ? "the run stopped on an internal error" : `the run was stopped: ${stopWhy()}`);
    // A step waiting for budget wakes when the run stops, and gives up.
    const onStop = () => pool.wake();
    stop?.addEventListener?.("abort", onStop, { once: true });
    let okCount = 0;
    // One leg in flight per outside seller within a run, as when steps ran one at a time.
    const sellerLocks = new Map();
    const lockSeller = (key) => {
      const prev = sellerLocks.get(key) || Promise.resolve();
      let release;
      const mine = new Promise((r) => { release = r; });
      const tail = prev.then(() => mine);
      sellerLocks.set(key, tail);
      return prev.then(() => () => { release(); if (sellerLocks.get(key) === tail) sellerLocks.delete(key); });
    };
    // A step's "{{step N}}" sees only steps earlier in the plan (all of which
    // it waits for when it names them), so a reference reads what it read
    // when steps ran in order.
    const stepIndex = new Map(d.plan.map((p, i) => [String(p.step), i]));
    const outputsBefore = (i) => (schedule.parallel ? Object.fromEntries(Object.entries(outputs).filter(([k]) => (stepIndex.get(k) ?? Infinity) < i)) : outputs);

    const runStep = async (step, stepAt) => {
      let done = null;
      const attempts = [];
      const inputSkips = [];
      const inputCodes = [];
      const callerParams = stepOverride(step, input.params);
      const seen = outputsBefore(stepAt);
      for (const tool of [step.tool, ...(step.fallbacks || [])]) {
        if (halt()) { attempts.push({ id: tool.id, skipped: haltSkip(), code: "halt" }); break; }
        // This tool's own params: the caller's for the step if given, else the
        // ones the plan wrote for this tool (backups carry their own; a plan
        // from before that falls back to the step's), under this tool's field
        // names for a renamed single input.
        const raw = callerParams || tool.exampleParams || step.tool.exampleParams || {};
        // A "{{step N}}" value is taken from step N's output (an address an ENS
        // lookup resolved); one that cannot be named without guessing skips
        // this tool, and the next one is tried.
        const chained = resolveStepRefs(raw, seen);
        if (!chained.ok) { inputSkips.push(chained.reason); inputCodes.push("ref_unresolved"); attempts.push({ id: tool.id, skipped: chained.reason, code: "ref_unresolved" }); continue; }
        // A placeholder the plan could not fill from the task is never sent to
        // a paid tool as if it were the value.
        const open = Object.entries(chained.params).filter(([, v]) => typeof v === "string" && PLACEHOLDER.test(v)).map(([k]) => k);
        if (open.length) { const why = `needs ${open.join(", ")}: pass params for this step`; inputSkips.push(why); inputCodes.push("needs_input"); attempts.push({ id: tool.id, skipped: why, code: "needs_input" }); continue; }
        const toolParams = fitParamsToSchema(tool.inputSchema, chained.params);
        if (left() < 5000) { attempts.push({ id: tool.id, skipped: "the run's time budget is spent", code: "timeout" }); break; }
        if (tool.callDirectly === true) { attempts.push({ id: tool.id, skipped: "call this tool directly: execute cannot pay it", code: "call_directly" }); continue; }
        const def = tool.firstParty ? bySlug.get(tool.slug) : null;
        const listPrice = tool.firstParty ? priceOfDef(def) : tool.priceUsd;
        if (tool.firstParty && listPrice === null) { attempts.push({ id: tool.id, skipped: "no longer in the catalog", code: "call_directly" }); continue; }
        const cost = tool.firstParty ? listPrice : roundUsd(listPrice * (1 + cfg.routingFeePct / 100));
        // Over what is left even if every leg in flight spends nothing: never fits.
        if (pool.spent + cost > spendable + 1e-9) { attempts.push({ id: tool.id, skipped: "over the remaining budget", code: "budget" }); continue; }
        const v = validateParams(tool.inputSchema, toolParams);
        if (!v.ok) { attempts.push({ id: tool.id, skipped: `params do not fit: ${v.errors.slice(0, 3).join("; ")}`, code: "params_misfit" }); continue; }
        if (tool.firstParty) {
          // The router's dispatch rules, plus: nothing priced per request and
          // no report composite (those carry their own spend guards and run
          // only as direct calls).
          const why = !dispatchable(def).ok ? dispatchable(def).why
            : typeof def.tierQuote === "function" ? "priced per request; call it directly"
            : isComposite(def.slug) ? "a report product; call it directly"
            : null;
          if (why) { attempts.push({ id: tool.id, skipped: why, code: "call_directly" }); continue; }
          // Reserved before the call, settled at its price or given back.
          const held = await pool.reserve(cost, undefined, halt);
          if (held === "halted") { attempts.push({ id: tool.id, skipped: haltSkip(), code: "halt" }); break; }
          if (!held) { attempts.push({ id: tool.id, skipped: "over the remaining budget", code: "budget" }); continue; }
          if (left() < 5000) { pool.release(held); attempts.push({ id: tool.id, skipped: "the run's time budget is spent", code: "timeout" }); break; }
          const t0 = Date.now();
          try {
            // No request object: a step must not see (or act on) the paying
            // request's credential, payer or settle hooks.
            // Past the timeout (or once the run is stopped) the step's own
            // outbound calls are cut off too, so a late step cannot keep
            // spending upstream while the fallback runs.
            const stepStop = new AbortController();
            const result = await raceStop(withTimeout(runInAbortableScope(() => Promise.resolve(def.handler(toolParams)), { stopSignal: stepStop.signal }), Math.min(cfg.execute.stepTimeoutMs, left()), tool.slug), stop)
              .catch((e) => { stepStop.abort(e); throw e; });
            pool.commit(held, cost);
            done = { tool: { id: tool.id, slug: tool.slug, seller: tool.seller, firstParty: true }, costUsd: cost, result, latencyMs: Date.now() - t0 };
            break;
          } catch (e) {
            pool.release(held);
            // A 4xx means our request was wrong for this tool, not that the tool
            // is unreliable; only a failure on the tool's side counts against it
            // (a run stopped on our side is neither).
            attempts.push({ id: tool.id, error: String(e?.message || e).slice(0, 240), status: e?.statusCode || 500, toolFault: e?.runStopped ? false : !(e?.statusCode >= 400 && e?.statusCode < 500), code: attemptErrorCode(e) });
            continue;
          }
        }
        // An outside POST that declares no input fields gets only what the
        // caller passes: never an empty body paid for on a guess (a seller
        // answers {} with a 400, and the leg is a refusal we cannot use).
        if (String(tool.method || "").toUpperCase() === "POST" && !Object.keys(tool.inputSchema?.properties || {}).length && !Object.keys(toolParams || {}).length) {
          attempts.push({ id: tool.id, skipped: "this seller declares no inputs: pass params for this step", code: "needs_input" }); continue;
        }
        if (!router) { attempts.push({ id: tool.id, skipped: "external execution is not enabled on this host", code: "call_directly" }); continue; }
        if (outsidePaused) { attempts.push({ id: tool.id, skipped: "outside steps are paused while our spending wallet is topped up", code: "budget" }); continue; }
        const unlock = await lockSeller(String(tool.seller || "").toLowerCase());
        try {
          if (halt()) { attempts.push({ id: tool.id, skipped: haltSkip(), code: "halt" }); break; }
          if (left() < 5000) { attempts.push({ id: tool.id, skipped: "the run's time budget is spent", code: "timeout" }); break; }
          // The most this leg may pay: the planned price with room for a small
          // live-price drift, never the whole remaining budget (a leg whose
          // outcome is unknown is booked at this worst case). Reserved, fee
          // included, in the same step as the check.
          let maxUsd = 0;
          const held = await pool.reserve(cost, (available) => {
            maxUsd = Math.min(roundUsd(available / (1 + cfg.routingFeePct / 100)), roundUsd(listPrice * 1.5), cfg.execute.perCallMaxUsd);
            return roundUsd(maxUsd * (1 + cfg.routingFeePct / 100));
          }, halt);
          if (held === "halted") { attempts.push({ id: tool.id, skipped: haltSkip(), code: "halt" }); break; }
          if (!held) { attempts.push({ id: tool.id, skipped: "over the remaining budget", code: "budget" }); continue; }
          const t0 = Date.now();
          // Checked and held in one turn, before the payment: concurrent runs
          // see this leg's worst case against the seller's daily ceiling.
          // A hold the ledger cannot book (refused, or its reply lost) is a leg
          // not paid. After money moved, or while another leg of this run is in
          // flight, the run goes on without it (a 500 now would leave that
          // spend uncharged); before, the run is refused (503, not charged) and
          // no other leg starts. A hold row that may have landed is dropped.
          let hold;
          const holdAt = now();
          try { hold = await ledger.holdSellerSpend({ runId, seller: tool.seller, amountUsd: maxUsd, now: holdAt, capUsd: cfg.execute.perSellerDayUsd, sinceMs: t - 86_400_000 }); }
          catch (e) {
            pool.release(held);
            // Decided in this turn, before any await, so no sibling starts a leg after it.
            const refuseRun = !refusedBy && !(pool.spent > 0 || mayHaveSpentOutside || okCount > 0 || pool.holders > 0);
            if (refuseRun) refusedBy = e;
            if (typeof ledger.dropSellerHold === "function") {
              const lost = { runId, seller: tool.seller, amountUsd: maxUsd, now: holdAt };
              await afterSpend(`drop unbooked hold ${runId}`, "dropSellerHold", lost, () => ledger.dropSellerHold(lost));
            }
            attempts.push({ id: tool.id, skipped: "the spend ledger is unavailable; this leg was not paid", code: "other" });
            if (refusedBy) break; // the run is refused: no other tool is tried
            continue;
          }
          if (hold === false) { pool.release(held); attempts.push({ id: tool.id, skipped: "this seller's daily execution ceiling is reached", code: "budget" }); continue; }
          try {
            const r = await withTimeout(router.handler({ task: `${step.purpose} (${tool.name})`, include: "external", target: tool.endpoint, params: toolParams, maxUsd }, req), Math.min(left(), cfg.execute.externalStepTimeoutMs), tool.seller);
            const underlying = Number(r?.receipt?.underlyingPriceUsd);
            const paidOut = Number.isFinite(underlying) && underlying > 0 ? underlying : maxUsd; // unknown: book the worst case
            const fee = roundUsd(paidOut * cfg.routingFeePct / 100);
            pool.commit(held, paidOut + fee);
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
            attempts.push({ id: tool.id, error: String(e?.message || e).slice(0, 240), status: e?.statusCode || 500, toolFault: sellerRefused || !(e?.statusCode >= 400 && e?.statusCode < 500), code: attemptErrorCode(e, { sellerRefused, timedOut }), ...(maybePaid ? { mayHavePaid: true } : {}) });
            if (maybePaid) {
              // The payment may have left (or may still leave: a timed-out leg is
              // not canceled). Book its worst case and try no other paid seller.
              mayHaveSpentOutside = true;
              // What the signed credential could move, when the payer said; else the cap.
              const signed = Number(e?.signedUsd);
              const exposure = Number.isFinite(signed) && signed >= 0 && !timedOut ? Math.min(signed, maxUsd) : maxUsd;
              pool.commit(held, exposure * (1 + cfg.routingFeePct / 100));
              await settleHold(runId, hold, exposure);
              attempts[attempts.length - 1].bookedUsd = roundUsd(exposure); // the worst case booked for this leg (read by the reconciliation)
              break;
            }
            pool.release(held);
            await settleHold(runId, hold, 0); // refused before any payment: nothing left
          }
        } finally { unlock(); }
      }
      if (done) { outputs[String(step.step)] = done.result; okCount++; return { step: step.step, status: "ok", ...done, ...(attempts.length ? { attempts } : {}) }; }
      // Every tool was held back for want of an input: the step is skipped
      // (nothing was tried, nothing paid), and the first reason says why.
      if (inputSkips.length && inputSkips.length === attempts.length) return { step: step.step, status: "skipped", reason: inputSkips[0], code: inputCodes[0], attempts };
      return { step: step.step, status: "failed", attempts };
    };

    // Ready steps start in plan order while fewer than the cap are in flight.
    // A step that throws (a defect, not a tool failure) stops new starts; the
    // run waits for every step in flight before it answers, so nothing is
    // still spending when it does.
    const cap = schedule.parallel ? maxParallelSteps(cfg) : 1;
    const entries = new Array(d.plan.length);
    await new Promise((resolveRun) => {
      const state = new Array(d.plan.length).fill(0); // 0 waiting, 1 running, 2 finished
      let running = 0;
      const pump = () => {
        if (!defect && !halt()) {
          for (let i = 0; i < d.plan.length && running < cap; i++) {
            if (state[i] !== 0 || !schedule.deps[i].every((j) => state[j] === 2)) continue;
            state[i] = 1; running++;
            runStep(d.plan[i], i)
              .then((r) => { entries[i] = r; }, (e) => { defect ||= e; pool.wake(); })
              .finally(() => { state[i] = 2; running--; pump(); });
          }
        }
        if (running === 0) resolveRun();
      };
      pump();
    });
    stop?.removeEventListener?.("abort", onStop);
    if (defect) {
      // An internal error in one step, after its siblings may have spent: the
      // run is closed as failed with what was spent (best effort, so the
      // error the buyer gets stays the original one), and a credit is given
      // back only when nothing was spent at all.
      const closed = d.plan.map((p, i) => entries[i]).filter(Boolean).map(({ result, ...r }) => r);
      try { await finish({ runId, status: "failed", spentUsd: pool.spent, steps: closed, now: now() }); } catch { /* the defect is the answer */ }
      if (redeemed && pool.spent === 0 && !mayHaveSpentOutside) { try { await restore(input.creditToken, runId); } catch { /* likewise */ } }
      throw defect;
    }
    if (refusedBy && pool.spent === 0 && !mayHaveSpentOutside && okCount === 0) {
      await finish({ runId, status: "failed", spentUsd: 0, steps: [], now: now() });
      if (redeemed) await restore(input.creditToken, runId);
      throw Object.assign(bad("The execution ledger is unavailable; nothing was charged - retry shortly", 503), { cause: refusedBy });
    }
    // A step the run never started (stopped, or refused) says so, in its place.
    const results = d.plan.map((p, i) => entries[i] || { step: p.step, status: "skipped", reason: `the run ${refusedBy ? "was refused" : `was stopped (${stopWhy()})`} before this step started`, code: "halt", attempts: [] });
    const spent = pool.spent;

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
      // breaker does not count. A tool-side failure or any spend: a 502. A
      // run stopped on our side (draining, or the buyer gone): a 503.
      const callerCaused = nothingSpent && results.every((r) => r.status === "skipped" || (r.attempts || []).every((a) => a.skipped || (a.status >= 400 && a.status < 500)));
      throw Object.assign(bad(`No step of the plan could be run (${results.map((r) => `step ${r.step}: ${r.reason || (r.attempts || []).map((a) => a.error || a.skipped).join(" / ")}`).join("; ").slice(0, 600)}). Nothing was charged.`, stop?.aborted ? 503 : callerCaused ? 400 : 502), { steps: results });
    }
    const finishedAt = now();
    const finalSteps = results.map(({ result, ...r }) => r);
    await finish({ runId, status: okSteps === results.length ? "complete" : "partial", spentUsd: spent, steps: finalSteps, now: finishedAt });
    // Unspent funds (what was paid plus the credit, less what was spent)
    // return as a credit on the same decision, live once this payment settles
    // and expiring WITH the decision, so a credit is never rolled forward.
    const leftover = roundUsd(quoted + redeemed - spent - (replanned?.ran ? planCharge : 0));
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
      ...(replanned ? { replanned } : {}),
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


/** The decide route's description, every price read from the config. */
export function decideDescription(cfg = decideConfig()) {
  const usd = (d) => `$${priceForDepth(d, cfg)}`;
  return `Describe a job and get a call-ready plan: which tools, across this catalog and outside x402 sellers with a recently verified 402, solve it end to end, in what order, with fallbacks and input params that validate against each tool's schema. Priced by depth: quick ${usd("quick")} (one best tool), plan ${usd("plan")} (the default: steps, fallbacks, params from your task, cost and latency estimates), full ${usd("full")} (the plan plus a compiled prompt). The fee comes back as a credit toward running the plan with POST /api/decide/execute. Free first: GET /api/find?q=<task> answers a multi-step task with a keyword plan sketch. The ranking formula has no first-party term; every tool carries firstParty. Uncovered needs are listed in gaps.`;
}

/** The paid decide upgrade a free plan sketch offers: priced at the depth it
 *  describes (plan, the default), with every depth's price beside it. */
export function decideUpgradeOffer({ next = "decide-execute", cfg = decideConfig() } = {}) {
  const usd = (d) => `$${priceForDepth(d, cfg)}`;
  return {
    tool: "decide", route: "POST /api/decide", mcp: "decide.plan", depth: "plan", price: usd("plan"),
    prices: Object.fromEntries(DEPTHS.map((d) => [d, usd(d)])),
    note: `a judged plan with your inputs filled in and fallbacks checked; the fee is credited toward running it with ${next}`,
  };
}

/** The execute route's published example: a free plan sketch, ENS name to
 *  wallet balance, which runs as written (no decisionId is needed). */
export const EXECUTE_EXAMPLE_INPUT = Object.freeze({ steps: ["ens-resolve", "wallet-balance"], params: { 1: { name: "vitalik.eth" } } });

// The decide route's published answer, compact enough to travel whole in the
// 402's discovery block (a larger one is replaced there by a pointer), so a
// buyer sees what the fee buys before paying.
export const DECIDE_EXAMPLE_TASK = "Resolve the ENS name vitalik.eth and read its wallet balance on Base";
export function decideExampleOut(cfg = decideConfig()) {
  const price = priceForDepth("plan", cfg);
  const step = (n, slug, method, priceUsd, purpose, exampleParams, dependsOn) => ({
    step: n, purpose, tool: { slug, firstParty: true, endpoint: `https://agent402.tools/api/${slug}`, method, priceUsd, exampleParams },
    fallbacks: [], dependsOn,
  });
  return {
    decisionId: "dec_…", task: DECIDE_EXAMPLE_TASK, depth: "plan",
    plan: [
      step(1, "ens-resolve", "GET", 0.001, "resolve the ENS name to an address", { name: "vitalik.eth" }, []),
      step(2, "wallet-balance", "POST", 0.002, "read that address's balance on Base", { address: "{{step 1}}", network: "base" }, [1]),
    ],
    estimatedCostUsd: 0.003, estimatedLatencyMs: 3000, confidence: 0.9, gaps: [], priceUsd: price,
    executionCredit: { amountUsd: Math.round(price * cfg.credit.percentOfFee / 100 * 1e6) / 1e6, token: "dc_…", redeemWith: "POST /api/decide/execute { decisionId, creditToken }" },
    feedbackToken: "fb_…",
  };
}

export function buildDecideTools({ getCatalog, ledger = openDecideLedger(), now = () => Date.now(), isOwnTraffic = () => false } = {}) {
  return [
    {
      route: "POST /api/decide",
      name: "Decide: tool plan for a task",
      slug: "decide",
      category: "agent",
      price: `$${priceForDepth("plan").toFixed(3)}`,
      quote: (body) => decideQuoteUsd(body),
      // Quoted by depth: the listed price is the default depth (plan), the ceiling is full.
      quoteMaxUsd: priceForDepth("full"),
      description: decideDescription(),
      tags: ["agents", "routing", "planning", "discovery", "x402"],
      discovery: {
        bodyType: "json",
        input: { task: DECIDE_EXAMPLE_TASK, depth: "plan" },
        inputSchema: {
          properties: {
            task: { type: "string", description: "What the agent needs done (max 2000 chars)" },
            depth: { type: "string", enum: DEPTHS, description: "quick | plan (default) | full" },
            constraints: { type: "object", description: "maxBudgetUsd, maxLatencyMs, rails [x402|mpp], chains [CAIP-2 or namespace], excludeSellers [host], requireDeterministic" },
          },
          required: ["task"],
        },
        output: { example: decideExampleOut() },
      },
      handler: makeDecideHandler({ ledger, now, isOwnTraffic }),
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
        "Run a decision's plan (decisionId from POST /api/decide), or a free plan sketch (steps), through Agent402: first-party steps run directly, third-party steps are bought from the seller and resold to you (you pay on Base, or by credits or card) at the seller's price plus a disclosed markup. Priced at the plan's budget (or your maxBudgetUsd, whichever you set) less a valid execution credit; spend stops at that budget, fallbacks are tried in order, and any unspent amount comes back as a credit. A run where no step succeeds is not charged. Reusing a saved plan: send its decisionId with replan: true and the saved task is planned again on current prices and reliability before the run, for the POST /api/decide price at that decision's depth added to the quote; the answer's replanned field gives the new decisionId and each step whose tool, seller or price changed (or unchanged: true), and a re-plan that cannot run falls back to the saved plan with its price returned as credit. Also runs a free plan sketch: pass the sketch's tool slugs as steps (no decisionId) with params for step 1, and each later step takes its one required input from the step before, at list price.",
      tags: ["agents", "execute", "planning", "router", "x402"],
      discovery: {
        bodyType: "json",
        // A body that runs as published: a free plan sketch (no decisionId,
        // which only a paid POST /api/decide answer can supply).
        input: EXECUTE_EXAMPLE_INPUT,
        inputSchema: {
          properties: {
            decisionId: { type: "string", description: "From POST /api/decide (or pass steps instead)" },
            steps: { type: "array", items: { type: "string" }, description: "Instead of decisionId: the tool slugs of a free plan sketch (from /api/find or /api/route), 2 to 5, in order. Pass params for step 1; a later step takes its one required input from the step before." },
            creditToken: { type: "string", description: "executionCredit.token from that decision (optional)" },
            maxBudgetUsd: { type: "number", description: "Spend ceiling for the run (default: the plan's estimate via Agent402)" },
            params: { type: "object", description: "Per-step params overriding the plan's exampleParams, keyed by step number" },
            replan: { type: "boolean", description: "With decisionId: plan the saved task again on current prices and reliability, then run the new plan. Adds the plan price for that decision's depth to the quote; the answer's replanned field lists what changed. Default false." },
          },
          required: [],
        },
        output: { example: { runId: "run_…", decisionId: "dec_…", status: "complete", steps: [{ step: 1, status: "ok", tool: { slug: "search", seller: "agent402", firstParty: true }, costUsd: 0.02, result: {} }], budgetUsd: 0.02, spentUsd: 0.02, paidUsd: 0.001, creditAppliedUsd: 0.02, routingFeePct: 5, leftoverCredit: null } },
      },
      handler: makeExecuteHandler({ ledger, getCatalog, now, isOwnTraffic }),
    },
  ];
}
