// No submission after the settle's deadline.
//
// /settle answers its caller at SETTLE_TIMEOUT_MS (timeout.js), but nothing
// cancels the vendor's settle(): its pre-submit RPC steps (simulate, latest
// ledger, the signer's account) keep running, and without a check it would
// go on to sendTransaction after the caller was already told it failed.
//
// Each settle runs with a context that carries its deadline (an epoch-ms
// time, read through getContext, which index.js backs with its
// AsyncLocalStorage). Once that time has passed, every pre-submit RPC
// method on rpc.Server.prototype refuses with SETTLE_DEADLINE_PASSED, and
// sendTransaction, the one irreversible step, is refused before any bytes
// leave the process. getTransaction (the post-submit poll) is left alone:
// a transaction submitted before the deadline is still watched until it
// lands, which keeps the serial queue's slot held for it (queue.js hold).
//
// Install before rpc-failover.js, so the failover's own attempts and the
// hedged reads, which call the method it captured, pass this check too. A
// refusal is not a transport failure, so it is never retried elsewhere.
// Calls with no settle context (verify, health, payer recovery) are untouched.
import { rpc } from "@stellar/stellar-sdk";
import { TimeoutError, withTimeout } from "./timeout.js";

export const PRE_SUBMIT_METHODS = ["simulateTransaction", "getLatestLedger", "getAccount", "getLedgerEntries", "sendTransaction"];

export class SettleDeadlineError extends Error {
  constructor(method) {
    super(`settle deadline passed: ${method} refused`);
    this.code = "SETTLE_DEADLINE_PASSED";
  }
}

export function installSettleDeadline(getContext, {
  proto = rpc.Server.prototype, methods = PRE_SUBMIT_METHODS, now = Date.now, log = console.log,
} = {}) {
  if (typeof getContext !== "function" || !proto) return 0;
  let patched = 0;
  for (const name of methods) {
    const original = proto[name];
    if (typeof original !== "function" || original.__settleDeadline) continue;
    const wrapped = function settleDeadlineGuard(...args) {
      const ctx = getContext();
      if (ctx && Number(ctx.deadline) > 0 && now() >= ctx.deadline) {
        ctx.deadlineRefused = true;
        if (name === "sendTransaction") log("[settle-deadline] past the settle deadline: transaction NOT submitted");
        return Promise.reject(new SettleDeadlineError(name));
      }
      return original.apply(this, args);
    };
    wrapped.__settleDeadline = true;
    proto[name] = wrapped;
    patched++;
  }
  return patched;
}

// A settle's deadline runs from the request's ARRIVAL, not from when its
// queue slot comes up. A settle queued behind a held one (queue.js hold) can
// wait close to the hold cap; timing its deadline from the job's start would
// let it submit long after the caller stopped waiting and may have retried
// the same payment through another facilitator.
export function newSettleContext(timeoutMs, now = Date.now) {
  const startedAt = now();
  return { txHash: "", startedAt, deadline: startedAt + Number(timeoutMs), deadlineRefused: false, lateStart: false };
}

// The /settle queue job. A job whose request is already past its deadline,
// or whose caller has hung up, never starts the vendor settle: it is answered
// as timed out with nothing submitted. Otherwise the work is held (queue.js)
// and the answer is bounded by what is left of the deadline.
export function settleJob(ctx, { run = (c, fn) => fn(), settle, clientClosed = () => false, now = Date.now, onStart } = {}) {
  return (hold) => run(ctx, () => {
    if (typeof onStart === "function") onStart(ctx);
    const left = Number(ctx.deadline) - now();
    if (clientClosed() || !(left > 0)) {
      ctx.deadlineRefused = true;
      ctx.lateStart = true;
      throw new TimeoutError("settle (queued past its deadline)", Math.max(0, now() - ctx.startedAt));
    }
    const work = settle();
    hold(work);
    return withTimeout(work, left, "settle");
  });
}
