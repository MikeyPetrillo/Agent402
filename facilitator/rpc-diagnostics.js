// Diagnostics-only patch on the Stellar SDK's rpc.Server.prototype -
// @x402/stellar's ExactStellarScheme constructs a fresh rpc.Server internally
// on every /verify and /settle call (getRpcClient(), not injectable), so
// there is no way to see what the Soroban RPC actually said about a failed
// submission from outside the vendor module. Its own error handling reduces
// a rejected sendTransaction() down to one bucket - errorReason:
// "settle_exact_stellar_transaction_submission_failed" - and discards the
// real response entirely (status, errorResultXdr), which is where the
// actual reason (bad sequence, insufficient fee, a genuine tx_failed with a
// specific operation-level error, ...) lives.
//
// Found live in production (2026-08-15): a real canary settlement hit this
// exact bucket and there was nothing to go on beyond the generic string -
// a facilitator that can't diagnose its own most consequential failure mode
// isn't production-grade for a rail carrying real settlements. This mirrors
// the main app's own src/facilitator-diagnostics.js: read the actual
// response before the caller's error handling discards it, log it, and
// change NOTHING about the returned value or control flow - a diagnostic
// patch must never become a second source of behavior.
import { rpc, xdr } from "@stellar/stellar-sdk";

let installed = false;

// A single OperationResult decodes through up to three levels: the outer
// switch is either "opInner" (the operation ran and has a real per-type
// result) or a direct op-level error (opBadAuth, opNoAccount, ... - the
// operation never ran at all). For "opInner", .tr() gives a second union
// keyed by operation TYPE (payment, invokeHostFunction, ...), and that
// union's own type-specific getter (e.g. invokeHostFunctionResult()) gives
// the actual reason. Verified against real, self-encoded XDR for both an
// "opInner" case and (implicitly) the direct-error case, which needs no
// further unwrapping - its own .switch().name IS the reason.
function decodeOperationResult(opResult) {
  try {
    const outer = opResult.switch().name;
    if (outer !== "opInner") return outer;
    const tr = opResult.tr();
    const opType = tr.switch().name;
    const getterName = `${opType}Result`;
    if (typeof tr[getterName] === "function") {
      const inner = tr[getterName]();
      if (inner && typeof inner.switch === "function") return `${opType}:${inner.switch().name}`;
    }
    return opType;
  } catch {
    return "unknown";
  }
}

export function decodeErrorResultXdr(errorResultXdr) {
  if (!errorResultXdr) return null;
  try {
    const result = typeof errorResultXdr === "string" ? xdr.TransactionResult.fromXDR(errorResultXdr, "base64") : errorResultXdr;
    const code = result.result().switch().name;
    // txFailed carries a richer, per-operation breakdown - the actual
    // reason a transaction that got as far as fee/sequence checks then
    // failed (e.g. a bad Soroban invocation, insufficient trustline).
    if (code === "txFailed") {
      const opCodes = result.result().results().map(decodeOperationResult);
      return { code, opCodes };
    }
    return { code };
  } catch (e) {
    return { decodeError: (e?.message || String(e)).slice(0, 200) };
  }
}

/** stellar-sdk >= 13 parses the RPC's errorResultXdr into `errorResult` (an
 *  xdr.TransactionResult INSTANCE) and drops the string; the 2026-08-27 log
 *  line "(no errorResultXdr in response) ... otherKeys:[errorResult]" was
 *  this decoder reading the old field. Accept both. Exported for tests. */
export function decodeErrorResult(result) {
  const obj = result?.errorResult;
  if (obj && typeof obj === "object" && typeof obj.result === "function") return decodeErrorResultXdr(obj);
  if (typeof obj === "string") return decodeErrorResultXdr(obj);
  return decodeErrorResultXdr(result?.errorResultXdr);
}

/** What to log for a rejected sendTransaction when the RPC gave no result XDR:
 *  a bounded, secret-free view of the whole response (status, hash, ledger,
 *  any error/message fields), so an ERROR-without-XDR is diagnosable instead
 *  of "(no errorResultXdr in response)" - which is all the 2026-08-26 canary
 *  failure left behind. Pure; unit-tested offline. */
export function describeRpcRejection(result) {
  try {
    const r = result && typeof result === "object" ? result : { value: result };
    const view = {};
    for (const k of ["status", "hash", "latestLedger", "latestLedgerCloseTime", "errorResultXdr", "diagnosticEventsXdr", "error", "message", "code"]) {
      if (r[k] !== undefined) view[k] = typeof r[k] === "string" ? r[k].slice(0, 200) : r[k];
    }
    const extra = Object.keys(r).filter((k) => !(k in view));
    if (extra.length) view.otherKeys = extra.slice(0, 12);
    return JSON.stringify(view).slice(0, 800);
  } catch (e) { return `(undescribable: ${String(e?.message || e).slice(0, 80)})`; }
}

export function installRpcDiagnostics() {
  if (installed) return;
  installed = true;
  const original = rpc.Server.prototype.sendTransaction;
  rpc.Server.prototype.sendTransaction = async function patchedSendTransaction(transaction) {
    const result = await original.call(this, transaction);
    if (result?.status !== "PENDING") {
      const decoded = decodeErrorResult(result);
      console.warn(
        `[rpc-diagnostics] sendTransaction rejected: status=${result?.status} hash=${result?.hash || "none"}`,
        decoded ? JSON.stringify(decoded) : `(no errorResultXdr in response) raw=${describeRpcRejection(result)}`,
      );
    }
    return result; // never alter what the caller sees
  };
  console.log("[startup] RPC diagnostics installed (sendTransaction rejections will be logged with decoded errorResultXdr)");
}
