// What a throw means in an x402 beforeVerify / beforeSettle hook.
//
// @x402/core (2.30.0 and later) refuses a payment whose beforeVerify hook
// throws (invalidReason before_verify_hook_error, a 402 before the handler)
// and cancels the settlement of one whose beforeSettle hook throws
// (errorReason before_settle_hook_error, a 402 with nothing settled). Before
// 2.30.0 a throw was logged and the payment went on. Neither default is a
// decision, so every such hook we register states its own:
//
//   refusingHook  a check that guards money or identity (the wallet
//                 blocklist, the Arc contract-wallet gate): a throw refuses
//                 with this hook's own reason, so the buyer reads why.
//   passingHook   bookkeeping or a buyer courtesy whose failure has its own
//                 backstop (the client-gone cancel, the settle-sent mark): a
//                 throw is logged and the payment goes on as before.
//
// The non-throwing path is untouched: a sync hook stays sync and its return
// value is passed through as is.
//
// Test seam: under NODE_ENV=test only, X402_HOOK_FAULT_FOR_TEST names hooks
// (comma separated) that throw before their body runs, so a booted server can
// show what a throw does (scripts/test-x402-hook-throws.js).

const ENV_FAULTS = process.env.NODE_ENV === "test" && process.env.X402_HOOK_FAULT_FOR_TEST
  ? new Set(String(process.env.X402_HOOK_FAULT_FOR_TEST).split(",").map((s) => s.trim()).filter(Boolean))
  : null;
let testFaults = null;

/** In-process test seam: hook names that throw on their next calls. */
export function _setHookFaultsForTest(names) { testFaults = names && names.length ? new Set(names) : null; }

function injectFault(name) {
  if (ENV_FAULTS?.has(name) || testFaults?.has(name)) throw new Error(`test fault in ${name}`);
}

function guard(name, fn, onThrow) {
  return (ctx) => {
    let out;
    try { injectFault(name); out = fn(ctx); } catch (e) { return onThrow(e); }
    return out && typeof out.then === "function" ? out.then(undefined, onThrow) : out;
  };
}

/** A throw refuses the payment with `reason` and `message` (the hook's abort shape). */
export function refusingHook(name, fn, { reason, message }) {
  return guard(name, fn, (e) => {
    console.error(`[x402-hook] ${name} failed, payment refused (${reason}): ${String(e?.message || e).slice(0, 200)}`);
    return { abort: true, reason, message };
  });
}

/** A throw is logged and the payment goes on (the hook returns nothing). */
export function passingHook(name, fn) {
  return guard(name, fn, (e) => {
    console.warn(`[x402-hook] ${name} failed, payment goes on: ${String(e?.message || e).slice(0, 200)}`);
    return undefined;
  });
}

export const HOOK_NAMES = Object.freeze({
  arcContractWalletGate: "arc-contract-wallet-gate",
  walletBlocklist: "wallet-blocklist",
  clientGone: "client-gone",
  settleSent: "settle-sent",
});
export const ARC_CONTRACT_WALLET_CHECK_FAILED = "contract_wallet_check_failed";
export const WALLET_CHECK_FAILED = "wallet_check_failed";
