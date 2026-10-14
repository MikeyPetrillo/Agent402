// Upstream deadlines: one budget per handler call, one cap per read, one
// answer when an upstream does not come back.
//
// WHY ONE MODULE. Every kit that reads a third-party API used to carry its
// own copy of the same shape: a fixed AbortSignal.timeout on each fetch and a
// catch that mapped ANY transport failure to a 504 "upstream timed out". The
// shape had three defects, each alive in every copy. A fixed cap does not
// compose: a handler that reads twice in sequence, or walks a fallback list,
// could run for several caps in a row while the payment it was answering
// expired (this server's own router signs 30 s authorizations and the
// facilitator refuses one within six seconds of its expiry, so the answer must
// be on the wire inside about 20 s). A 504 named the wrong party: the buyer
// reads "gateway timeout" as this server's defect when the host that stopped
// answering was the upstream's. And a connection that was refused outright
// read as a timeout. The Solana intel kit was fixed first; this module is that
// fix made shareable, so the next kit cannot drift from it.
//
// THE CONTRACT.
//   - budgetOf() / underBudget(): a handler runs under one budget
//     (HANDLER_BUDGET_MS). underBudget() carries it on an AsyncLocalStorage
//     store, so a kit wraps each handler once and every read it makes, however
//     deep, finds the budget without a parameter being threaded through.
//   - upstreamFetch(): the read gets its own cap (sized from measured normal
//     answers, with room for a slow day), or what is left of the budget if that
//     is shorter; a budget already spent refuses before any egress. The signal
//     bounds headers AND body, so a stalled body read ends at the same
//     deadline (bodyUnderDeadline maps that abort too).
//   - upstreamDeadline() / upstreamUnreachable(): the two 503 classes. The
//     message is the contract the strict sweep's runner probe reads
//     (scripts/test-non-metered-examples.js, runnerProbeLabel): the upstream's
//     label first, then the step, then the deadline. Both say "nothing was
//     charged", which is true by construction: settlement runs after the
//     handler and a status of 400 or more is never settled. Never a 504 for an
//     upstream problem (a 504 here is reserved for the buyer's own payment
//     window running out, a different party).
//   - An optional read (a holder table, a second relay, a refinement) is
//     skipped when the budget cannot hold it (OPTIONAL_READ_FLOOR_MS), and the
//     kit says so in partial-answer fields, never a complete answer of zero
//     rows.
//
// Status mapping of an upstream's ANSWER (429, 5xx, 4xx, non-JSON) stays in
// each kit: those differ per upstream and are not this module's concern.

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_MAX_TIMEOUT_SECONDS, SETTLE_RULE_SECONDS, SETTLE_MARGIN_SECONDS } from "./evm-validity.js";

/** The whole handler, every read included, answers inside this: the budget of
 *  the keyless data kits, whose reads answer in well under a second, sized so
 *  the answer lands while this server's own router's 30 s authorization can
 *  still settle. */
export const HANDLER_BUDGET_MS = 20_000;
/** The budget of a route whose upstream is measured slower (speech, judgment,
 *  answer synthesis): the route's own payment window, as a stock client signs
 *  it (validBefore = now + maxTimeoutSeconds, src/evm-validity.js), less the
 *  facilitator's settle-time rule and the settle margin, so the work still
 *  ends where the payment can settle. Those routes keep their own measured
 *  per-read caps; this only bounds the walk. */
export const PAYMENT_WINDOW_BUDGET_MS = (DEFAULT_MAX_TIMEOUT_SECONDS - SETTLE_RULE_SECONDS - SETTLE_MARGIN_SECONDS) * 1000;
/** An optional read is not started with less than this left in the budget. */
export const OPTIONAL_READ_FLOOR_MS = 1_500;
/** The cap most keyless JSON APIs get: a normal answer is well under a second. */
export const DEFAULT_READ_MS = 8_000;

const store = new AsyncLocalStorage();

/** One budget per handler call: remaining() is what the next read may spend. */
export function budgetOf(totalMs = HANDLER_BUDGET_MS) {
  const endsAt = Date.now() + totalMs;
  return { remaining: () => endsAt - Date.now(), totalMs };
}

/** The budget of the handler call this code runs under, or null outside one
 *  (a scheduled warmer, a boot-time read), where a read keeps its own cap. */
export function currentBudget() {
  return store.getStore() ?? null;
}

/** The budget a wrapped handler gets: `totalMs` (HANDLER_BUDGET_MS when
 *  absent). UPSTREAM_HANDLER_BUDGET_MS, when set to a number, overrides every
 *  budget: the shared deadline test runs every kit's stalled example under a
 *  short budget instead of waiting a real cap out. Production leaves it unset. */
export function handlerBudgetMs(totalMs = null) {
  const n = Number(process.env.UPSTREAM_HANDLER_BUDGET_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return Number(totalMs) > 0 ? Number(totalMs) : HANDLER_BUDGET_MS;
}

/** Wrap a tool handler so it runs under one budget. The budget starts when
 *  the handler starts (after the paywall verified the payment) and every
 *  upstreamFetch inside it, through any depth of calls, reads it. The
 *  configured size rides on the wrapper as __budgetMs. */
export function underBudget(handler, totalMs = null) {
  const budgeted = function budgeted(...args) {
    return store.run(budgetOf(handlerBudgetMs(totalMs)), () => handler.apply(this, args));
  };
  return Object.assign(budgeted, { __underBudget: true, __budgetMs: Number(totalMs) > 0 ? Number(totalMs) : HANDLER_BUDGET_MS });
}

/** Wrap every handler in a kit's tool array, in place, and return the array:
 *  one line at the end of the kit, and no handler can be added without it.
 *  `totalMs` is a number for every tool, or a function of the tool (null for
 *  the default) when one kit's routes have different windows. */
export function underBudgetAll(tools, totalMs = null) {
  for (const t of tools) if (t && typeof t.handler === "function" && !t.handler.__underBudget) {
    t.handler = underBudget(t.handler, typeof totalMs === "function" ? totalMs(t) : totalMs);
  }
  return tools;
}

/** Run `fn` under a fresh budget of exactly `totalMs` (handlerBudgetMs() when
 *  absent), for code that is not a tool handler. */
export function withBudget(fn, totalMs = null) {
  return store.run(budgetOf(totalMs ?? handlerBudgetMs()), fn);
}

/** The cap a read may spend: its own, or the budget's remainder if shorter. */
export function capOf(timeoutMs, budget = currentBudget()) {
  return budget ? Math.min(timeoutMs, budget.remaining()) : timeoutMs;
}

/** True when the budget cannot hold an optional read. */
export function budgetSpent(budget = currentBudget(), floorMs = OPTIONAL_READ_FLOOR_MS) {
  return !!budget && budget.remaining() < floorMs;
}

export const secondsOf = (ms) => String(Math.max(1, Math.round(ms / 1000)));

/** TimeoutError (AbortSignal.timeout) or AbortError (a caller's abort). */
export const isAbortError = (err) => err?.name === "TimeoutError" || err?.name === "AbortError";

function bad(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

/** The 503 a read answers when its upstream does not come back in time. */
export function upstreamDeadline(label, step, ms) {
  return Object.assign(
    bad(`${label} did not answer the ${step} read within ${secondsOf(ms)} s (upstream deadline); nothing was charged - retry shortly`, 503),
    { attribution: "upstream", upstreamFailure: "deadline" },
  );
}

/** The 503 a read answers when the upstream could not be reached at all. */
export function upstreamUnreachable(label, step) {
  return Object.assign(
    bad(`${label} is unreachable from here (${step} read failed before any answer); nothing was charged - retry shortly`, 503),
    { attribution: "upstream", upstreamFailure: "unreachable" },
  );
}

/** True for either 503 class above (a kit's fallback walk reads this). */
export const isUpstreamFailure = (err) => err?.upstreamFailure === "deadline" || err?.upstreamFailure === "unreachable";

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return "?"; }
}

/**
 * One fetch under a deadline. `ctx` names the read for the message and the
 * log, and sizes it:
 *   label      the upstream, as the buyer reads it ("RugCheck", "Chain data")
 *   step       the read, as the buyer reads it ("report", "eth_call")
 *   timeoutMs  this read's own cap (DEFAULT_READ_MS when absent)
 *   budget     the handler budget (the current one when absent; null for none)
 *   tag        the kit's log prefix ("[chain]")
 *   fetchImpl  test seam
 * Returns the Response. Throws upstreamDeadline when the cap (or the budget's
 * remainder) passes first, upstreamUnreachable on any other transport failure.
 * After it returns, `ctx.cap` holds the cap the read ran under, so a body read
 * can be mapped with bodyUnderDeadline(promise, ctx).
 */
export async function upstreamFetch(url, init = {}, ctx = {}) {
  const label = ctx.label || "Upstream";
  const step = ctx.step || "data";
  const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : DEFAULT_READ_MS;
  const budget = ctx.budget === undefined ? currentBudget() : ctx.budget;
  const cap = capOf(timeoutMs, budget);
  ctx.cap = cap;
  // A budget already spent refuses before any egress; the deadline named is
  // the handler budget the upstream's earlier reads used up.
  if (cap <= 0) throw upstreamDeadline(label, step, budget?.totalMs ?? timeoutMs);
  const fetchImpl = ctx.fetchImpl || fetch;
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(cap) });
  } catch (err) {
    const timedOut = isAbortError(err);
    if (ctx.tag !== null) {
      console.warn(`${ctx.tag || "[upstream]"} ${label} ${timedOut ? `did not answer within ${cap} ms` : "unreachable"}: ${hostOf(url)} (${step}) -> ${err?.name ?? err?.code ?? err?.message}`);
    }
    throw timedOut ? upstreamDeadline(label, step, cap) : upstreamUnreachable(label, step);
  }
}

/**
 * A body read under the same signal: an abort while the body streams is the
 * deadline it is, not an unreadable response. Any other failure is rethrown
 * unchanged, so the kit keeps its own "returned non-JSON" mapping.
 */
export async function bodyUnderDeadline(promise, ctx = {}) {
  try {
    return await promise;
  } catch (err) {
    if (isAbortError(err)) throw upstreamDeadline(ctx.label || "Upstream", ctx.step || "data", ctx.cap ?? ctx.timeoutMs ?? DEFAULT_READ_MS);
    throw err;
  }
}

/**
 * Promise-shaped work (an SDK call, a stream consumer) under a cap composed
 * with the budget: resolves with the work's value, or rejects with the
 * deadline class when the cap passes first. `onExpire` (optional) is called
 * at expiry so the caller can abort the underlying work.
 */
export function workUnderDeadline(work, ctx = {}) {
  const label = ctx.label || "Upstream";
  const step = ctx.step || "data";
  const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : DEFAULT_READ_MS;
  const budget = ctx.budget === undefined ? currentBudget() : ctx.budget;
  const cap = capOf(timeoutMs, budget);
  ctx.cap = cap;
  if (cap <= 0) return Promise.reject(upstreamDeadline(label, step, budget?.totalMs ?? timeoutMs));
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { ctx.onExpire?.(); } catch { /* the deadline stands */ }
      reject(upstreamDeadline(label, step, cap));
    }, cap);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}
