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
import { openDecideLedger, hashToken } from "../decide/ledger.js";
import { validateParams } from "../decide/params.js";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { dispatchable } from "./route-execute.js";
import { EXPENSIVE_COMPOSITE_SLUGS } from "../composite-spend-guard.js";
import { evmCredentialBudgetMs } from "../evm-validity.js";
import { resolveStepRefs } from "../decide/step-refs.js";

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
    ledger.saveDecision({ decisionId: out.decisionId, depth, priceUsd, payer, plan: out.plan, costViaUsd: out.estimatedCostViaAgent402Usd || 0, feedbackHash: hashToken(feedbackToken), now: now() });
    const amount = roundUsd(priceUsd * cfg.credit.percentOfFee / 100);
    let executionCredit = null;
    if (amount > 0 && out.plan?.length) {
      const c = ledger.mintCredit({ decisionId: out.decisionId, amountUsd: amount, ttlMs: cfg.credit.ttlHours * 3_600_000, payer, now: now() });
      onSettled(req, (settledOk) => { if (settledOk) { ledger.activateCredit(c.hash); ledger.markDecisionSettled(out.decisionId); } });
      executionCredit = { amountUsd: c.amountUsd, expiresAt: new Date(c.expiresAt).toISOString(), token: c.token, redeemWith: "POST /api/decide/execute { decisionId, creditToken }", activeAfterPaymentSettles: true };
    } else {
      onSettled(req, (settledOk) => { if (settledOk) ledger.markDecisionSettled(out.decisionId); });
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
 *  under the settlement floor. Sync: reads the local ledger only. */
export function executeQuoteUsd(body, { ledger, now = Date.now() }) {
  const floor = 0.001;
  const d = body?.decisionId ? ledger.getDecision(String(body.decisionId)) : null;
  if (!d) return floor;
  const budget = executeBudgetUsd(body, d);
  const credit = ledger.creditAvailableUsd(body?.creditToken, d.id, now);
  return Math.max(floor, roundUsd(budget - credit));
}

export function executeBudgetUsd(body, d, cfg = decideConfig()) {
  const asked = Number(body?.maxBudgetUsd);
  const planned = Number(d?.costViaUsd) || 0;
  const base = Number.isFinite(asked) && asked > 0 ? asked : planned;
  return roundUsd(Math.min(base, cfg.execute.perCallMaxUsd));
}

function stepParams(step, overrides) {
  const o = overrides && typeof overrides === "object" ? overrides[String(step.step)] : null;
  return o && typeof o === "object" && !Array.isArray(o) ? o : step.tool.exampleParams || {};
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

export function makeExecuteHandler({ ledger, getCatalog, now = () => Date.now(), isComposite = (slug) => EXPENSIVE_COMPOSITE_SLUGS.has(slug), runBudgetMs = (req) => evmCredentialBudgetMs(req), spendingWalletStatus = async () => (await import("../upstream-buyer-status.js")).upstreamBuyerStatus() }) {
  return async function executeHandler(input, req) {
    const cfg = decideConfig();
    const decisionId = String(input?.decisionId || "");
    if (!decisionId) throw bad('"decisionId" is required (from POST /api/decide)');
    const d = ledger.getDecision(decisionId);
    if (!d) throw bad("Unknown decisionId - decisions are kept for this server's own answers only", 404);
    if (!d.settled) throw bad("That decision's payment has not settled, so it cannot be executed", 409);
    if (input.params != null && (typeof input.params !== "object" || Array.isArray(input.params))) throw bad('"params" must be an object keyed by step number');
    const payer = payerOf(req);
    const t = now();
    const startedAt = Date.now();
    const budget = executeBudgetUsd(input, d, cfg);
    if (budget <= 0) throw bad("Nothing to execute: the plan has no priced steps; pass maxBudgetUsd", 400);

    // WHAT WAS PAID is the quote the payment gate settled against (stashed on
    // the request by every gate), never a recomputation: a credit raced away
    // since the quote would otherwise make an unpaid budget spendable.
    const quoted = Number.isFinite(req?.__meteredQuoteUsd) && req.__meteredQuoteUsd > 0 ? req.__meteredQuoteUsd : executeQuoteUsd(input, { ledger, now: t });
    const creditAssumed = roundUsd(Math.max(0, budget - quoted));

    // One run per (decision, runKey): a client that timed out and paid again
    // gets the first run's id back, not a second run (a 409 is not charged).
    const runKey = typeof input?.runKey === "string" && input.runKey ? input.runKey.slice(0, 128)
      : typeof req?.headers?.["idempotency-key"] === "string" && req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]).slice(0, 128) : null;
    const prior = ledger.runByKey(d.id, runKey);
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
    // From here to createRun there is no await: the checks and the booking of
    // this run happen in one turn, so concurrent requests cannot all pass on
    // the same reading.
    if (payer && ledger.payerExposureUsd(payer, t - 3_600_000) + budget > cfg.execute.perWalletHourUsd) throw bad(`This wallet has reached its hourly execution ceiling ($${cfg.execute.perWalletHourUsd}); nothing was charged`, 429);
    // Only a plan that can pay outside sellers is held to the wallet's
    // global daily ceiling; our own tools do not draw on that wallet.
    if (hasOutside && ledger.globalExposureUsd(t - 86_400_000) + budget > cfg.execute.globalDayUsd) throw bad("Outside steps are paused for everyone for up to 24 hours; nothing was charged", 429);
    const payerDayCap = cfg.execute.globalDayUsd * cfg.execute.perPayerDayShare;
    if (payer && ledger.payerExposureUsd(payer, t - 86_400_000) + budget > payerDayCap) throw bad(`This wallet has reached its daily execution ceiling ($${roundUsd(payerDayCap)}); nothing was charged`, 429);

    const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    let redeemed = 0;
    if (creditAssumed > 0) {
      redeemed = ledger.redeemCredit(input.creditToken, d.id, runId, t);
      // The price assumed this credit; if it is gone (used by another run,
      // expired), refuse before spending anything. Not charged.
      if (redeemed + 1e-9 < creditAssumed) {
        if (redeemed) ledger.restoreCredit(input.creditToken, runId);
        throw bad("The execution credit this price assumed is no longer available (already used or expired); nothing was charged - request a fresh quote", 409);
      }
    }
    const spendable = roundUsd(Math.min(budget, quoted + redeemed));
    if (!ledger.createRun({ runId, decisionId: d.id, payer, budgetUsd: spendable, creditUsd: redeemed, runKey, now: t })) {
      // Lost a race with a concurrent request carrying the same key.
      if (redeemed) ledger.restoreCredit(input.creditToken, runId);
      throw bad("This decision already has a run with that key; nothing was charged", 409);
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
      // A "{{step N}}" value is taken from step N's output (an address an ENS
      // lookup resolved); one that cannot be named without guessing skips the step.
      const chained = resolveStepRefs(stepParams(step, input.params), outputs);
      if (!chained.ok) { results.push({ step: step.step, status: "skipped", reason: chained.reason }); continue; }
      const params = chained.params;
      // A placeholder the plan could not fill from the task is never sent to a
      // paid tool as if it were the value.
      const open = Object.entries(params).filter(([, v]) => typeof v === "string" && PLACEHOLDER.test(v)).map(([k]) => k);
      if (open.length) { results.push({ step: step.step, status: "skipped", reason: `needs ${open.join(", ")}: pass params for this step` }); continue; }
      let done = null;
      const attempts = [];
      for (const tool of [step.tool, ...(step.fallbacks || [])]) {
        if (left() < 5000) { attempts.push({ id: tool.id, skipped: "the run's time budget is spent" }); break; }
        if (tool.callDirectly === true) { attempts.push({ id: tool.id, skipped: "call this tool directly: execute cannot pay it" }); continue; }
        const def = tool.firstParty ? bySlug.get(tool.slug) : null;
        const listPrice = tool.firstParty ? priceOfDef(def) : tool.priceUsd;
        if (tool.firstParty && listPrice === null) { attempts.push({ id: tool.id, skipped: "no longer in the catalog" }); continue; }
        const cost = tool.firstParty ? listPrice : roundUsd(listPrice * (1 + cfg.routingFeePct / 100));
        if (spent + cost > spendable + 1e-9) { attempts.push({ id: tool.id, skipped: "over the remaining budget" }); continue; }
        const v = validateParams(tool.inputSchema, params);
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
            const result = await withTimeout(runInAbortableScope(() => Promise.resolve(def.handler(params)), { stopSignal: stepStop.signal }), Math.min(cfg.execute.stepTimeoutMs, left()), tool.slug)
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
        if (String(tool.method || "").toUpperCase() === "POST" && !Object.keys(tool.inputSchema?.properties || {}).length && !Object.keys(params || {}).length) {
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
        if (ledger.sellerSpendUsd(tool.seller, t - 86_400_000) + maxUsd > cfg.execute.perSellerDayUsd) { attempts.push({ id: tool.id, skipped: "this seller's daily execution ceiling is reached" }); continue; }
        const hold = ledger.holdSellerSpend({ runId, seller: tool.seller, amountUsd: maxUsd, now: now() });
        try {
          const r = await withTimeout(router.handler({ task: `${step.purpose} (${tool.name})`, include: "external", target: tool.endpoint, params, maxUsd }, req), Math.min(left(), cfg.execute.externalStepTimeoutMs), tool.seller);
          const underlying = Number(r?.receipt?.underlyingPriceUsd);
          const paidOut = Number.isFinite(underlying) && underlying > 0 ? underlying : maxUsd; // unknown: book the worst case
          const fee = roundUsd(paidOut * cfg.routingFeePct / 100);
          spent = roundUsd(spent + paidOut + fee);
          ledger.settleSellerHold(hold, paidOut);
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
          attempts.push({ id: tool.id, error: String(e?.message || e).slice(0, 240), status: e?.statusCode || 500, toolFault: !(e?.statusCode >= 400 && e?.statusCode < 500), ...(maybePaid ? { mayHavePaid: true } : {}) });
          if (maybePaid) {
            // The payment may have left (or may still leave: a timed-out leg is
            // not cancelled). Book its worst case and try no other paid seller.
            mayHaveSpentOutside = true;
            // What the signed credential could move, when the payer said; else the cap.
            const signed = Number(e?.signedUsd);
            const exposure = Number.isFinite(signed) && signed >= 0 && !timedOut ? Math.min(signed, maxUsd) : maxUsd;
            spent = roundUsd(spent + exposure * (1 + cfg.routingFeePct / 100));
            ledger.settleSellerHold(hold, exposure);
            attempts[attempts.length - 1].bookedUsd = roundUsd(exposure); // the worst case booked for this leg (read by the reconciliation)
            break;
          }
          ledger.settleSellerHold(hold, 0); // refused before any payment: nothing left
        }
      }
      if (done) { outputs[String(step.step)] = done.result; results.push({ step: step.step, status: "ok", ...done, ...(attempts.length ? { attempts } : {}) }); }
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
      ledger.finishRun({ runId, status: "failed", spentUsd: spent, steps: results, now: now() });
      // A credit comes back only when nothing left our wallet.
      if (redeemed && nothingSpent) ledger.restoreCredit(input.creditToken, runId);
      // Caused by the caller's own inputs (skipped steps, params that do not
      // fit, 4xx answers) with nothing spent: a 400, which the spend-then-fail
      // breaker does not count. A tool-side failure or any spend: a 502.
      const callerCaused = nothingSpent && results.every((r) => r.status === "skipped" || (r.attempts || []).every((a) => a.skipped || (a.status >= 400 && a.status < 500)));
      throw Object.assign(bad(`No step of the plan could be run (${results.map((r) => `step ${r.step}: ${r.reason || (r.attempts || []).map((a) => a.error || a.skipped).join(" / ")}`).join("; ").slice(0, 600)}). Nothing was charged.`, callerCaused ? 400 : 502), { steps: results });
    }
    ledger.finishRun({ runId, status: okSteps === results.length ? "complete" : "partial", spentUsd: spent, steps: results.map(({ result, ...r }) => r), now: now() });
    // Unspent funds (what was paid plus the credit, less what was spent)
    // return as a credit on the same decision, live once this payment settles
    // and expiring WITH the decision, so a credit is never rolled forward.
    const leftover = roundUsd(quoted + redeemed - spent);
    const decisionExpiry = d.createdAt + cfg.credit.ttlHours * 3_600_000;
    let leftoverCredit = null;
    if (leftover >= 0.001 && decisionExpiry > now() + 60_000) {
      const c = ledger.mintCredit({ decisionId: d.id, amountUsd: leftover, expiresAt: decisionExpiry, payer, now: now() });
      onSettled(req, (settledOk) => { if (settledOk) ledger.activateCredit(c.hash); });
      leftoverCredit = { amountUsd: c.amountUsd, expiresAt: new Date(c.expiresAt).toISOString(), token: c.token, activeAfterPaymentSettles: true };
    }
    // A settlement that fails after this run spent money forfeits the credit:
    // restoring it would let the same credit fund run after run.
    if (redeemed && nothingSpent) onSettled(req, (settledOk) => { if (!settledOk) ledger.restoreCredit(input.creditToken, runId); });
    // What the spend was, on separate lines: our own tools, what was passed
    // through to outside sellers, and the routing fee on it.
    const okResults = results.filter((r) => r.status === "ok");
    const routingFeesUsd = roundUsd(okResults.reduce((a, r) => a + (r.routingFeeUsd || 0), 0));
    const passThroughUsd = roundUsd(okResults.filter((r) => !r.tool.firstParty).reduce((a, r) => a + (r.costUsd || 0), 0) - routingFeesUsd);
    const firstPartyUsd = roundUsd(okResults.filter((r) => r.tool.firstParty).reduce((a, r) => a + (r.costUsd || 0), 0));
    return {
      runId, decisionId: d.id, status: okSteps === results.length ? "complete" : "partial",
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
  return function feedback(body) {
    const b = body && typeof body === "object" ? body : {};
    const decisionId = String(b.decisionId || "");
    // One answer for "unknown decision" and "wrong token": a stranger learns
    // nothing about which decisions exist.
    if (!ledger.feedbackTokenOk(decisionId, b.feedbackToken)) throw bad("decisionId and feedbackToken do not match a decision", 403);
    const d = ledger.getDecision(decisionId);
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
    const replaced = ledger.saveFeedback({ decisionId, step, toolId, outcome, quality, latencyMs, now: now() });
    // A replaced verdict is not counted twice.
    if (!replaced) sendObservations([{ toolId, ok: outcome === "success", source: "feedback", by: observerId(d.payer) }], { send });
    return { ok: true, decisionId, step, toolId, outcome, replaced };
  };
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
      category: "agents",
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
      category: "agents",
      price: "$0.001",
      spendsOwnWallet: true,
      // Outside steps are bought from the Base spending wallet, which only a
      // Base payment funds: other EVM chains are not offered (credits and card
      // still work).
      onlyNetworks: ["eip155:8453"],
      quote: (body) => executeQuoteUsd(body, { ledger, now: now() }),
      // The budget is capped per call (executeBudgetUsd), so that is the ceiling.
      quoteMaxUsd: decideConfig().execute.perCallMaxUsd,
      description:
        "Run a decision's plan through Agent402: first-party steps run directly, third-party steps are paid on your behalf (paid on Base, or by credits or card) and relayed at the seller's price plus a disclosed routing fee. Priced at the plan's budget (or your maxBudgetUsd, whichever you set) less a valid execution credit; spend stops at that budget, fallbacks are tried in order, and any unspent amount comes back as a credit. A run where no step succeeds is not charged.",
      tags: ["agents", "execute", "planning", "router", "x402"],
      discovery: {
        bodyType: "json",
        input: { decisionId: "dec_2b1c9e0f4a7d4c3e9b8a1f00", creditToken: "dc_...", maxBudgetUsd: 0.05 },
        inputSchema: {
          properties: {
            decisionId: { type: "string", description: "From POST /api/decide" },
            creditToken: { type: "string", description: "executionCredit.token from that decision (optional)" },
            maxBudgetUsd: { type: "number", description: "Spend ceiling for the run (default: the plan's estimate via Agent402)" },
            params: { type: "object", description: "Per-step params overriding the plan's exampleParams, keyed by step number" },
          },
          required: ["decisionId"],
        },
        output: { example: { runId: "run_…", decisionId: "dec_…", status: "complete", steps: [{ step: 1, status: "ok", tool: { slug: "search", seller: "agent402", firstParty: true }, costUsd: 0.02, result: {} }], budgetUsd: 0.02, spentUsd: 0.02, paidUsd: 0.001, creditAppliedUsd: 0.02, routingFeePct: 5, leftoverCredit: null } },
      },
      handler: makeExecuteHandler({ ledger, getCatalog, now }),
    },
  ];
}
