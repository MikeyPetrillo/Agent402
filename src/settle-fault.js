// Who a failed settlement proves at fault, for the settle breaker
// (src/gateway-settle-breaker.js). Three answers:
//
//   "buyer"      a definite verdict on the buyer's own payment: a verdict
//                code (src/settle-verdict.js isBuyerSettleVerdict), or the
//                chain's own words that the paying wallet came up short on
//                the transfer (BALANCE_PROOFS below). Counted at the
//                breaker's normal count, and the refusal names the payment.
//   "not-buyer"  proven to be ours or a third party's: our time limit, a
//                connection or DNS error, our store or a hook of ours, our
//                relayer, our credentials refused, our requirements, a
//                facilitator's HTTP error, a billing limit on this server's
//                account. Never counted against the wallet.
//   "unknown"    neither: a revert or failed simulation that names no
//                balance, a bare settlement_failed, a 402 with no receipt, a
//                settle still pending. Counted against the wallet at a higher
//                count, and the refusal says only that settlement did not
//                complete, which is true whoever caused it.
//
// The receipt a buyer gets carries a code-shaped reason and a fixed message
// (src/facilitator-diagnostics.js); the facilitator's raw reason and message
// are kept on the request by the same guard (RAW_SETTLE_RECEIPT) and read
// here, bounded, so a chain's words can prove a balance shortfall.
import { isBuyerSettleVerdict } from "./settle-verdict.js";
import { notCheckedRefusal, isFacilitatorBillingRefusal } from "./payment-reject.js";
import { classifySvmFundingRefusal } from "./svm-funding-refusal.js";

/** The request property the settle-receipt guard keeps the facilitator's
 *  raw { errorReason, errorMessage } under (bounded text). */
export const RAW_SETTLE_RECEIPT = "__settleReceiptRaw";

const TEXT_MAX = 2000;
const NOT_BUYER_CODE = /^(?:timeout|network_error|non_json_response|redirect_refused|client_disconnected|own_relayer_refused|relayer_error)$|_check_failed$|_hook_error$|_mark_failed$|_unverifiable$|^invalid_(?:network|scheme|payment_requirements|x402_version)$|_requirements$|_not_configured$|_auth_store$|_unauthenticated$|_verifier_error$|^unsupported_|^(?:circle|gateway)_http_\d{3}$/i;

// The chain's own words that the paying wallet held too little of the asset
// for the transfer, per rail. Each is read only on its own rail, and never
// a word about gas or a fee payer (that is the settler's own wallet).
//   EVM: the token's revert (FiatToken and OpenZeppelin ERC-20 before v5,
//        "ERC20: transfer amount exceeds balance"; v5, ERC20InsufficientBalance).
//   Stellar: the asset contract's error #10 (balance is not sufficient to
//        spend), or a classic payment's op_underfunded.
//   Algorand: the asset transfer's "underflow on subtracting N from sender
//        amount M" (an ALGO shortfall reads "overspend" and can be the
//        sponsoring fee payer's account, so it is not read).
//   Solana: the transfer instruction's SPL token error Custom:1
//        (insufficient funds) or InvalidAccountData (no token account),
//        read by src/svm-funding-refusal.js.
const EVM_SHORT = /\btransfer amount exceeds balance\b|\bERC20: insufficient (?:balance|funds)\b|\bERC20InsufficientBalance\b/i;
const STELLAR_SHORT = /Error\(Contract, ?#10\)|\bbalance is not sufficient\b|\bop_underfunded\b/i;
const ALGO_SHORT = /\bunderflow on subtracting \d{1,20} from sender amount \d{1,20}\b/i;
const SETTLER_WORDS = /\bgas\b|\bfee ?payer\b|\bfees?\b|\brelayer\b/i;

/** True when `text` is the chain saying the paying wallet came up short on
 *  the transfer, read for the rail `network` names. Pure. */
export function isBalanceShortfallText(text, network) {
  const t = String(text || "").slice(0, TEXT_MAX);
  const net = String(network || "");
  if (!t) return false;
  if (/^solana:/.test(net)) return classifySvmFundingRefusal({ network: net, reason: t }) != null;
  if (SETTLER_WORDS.test(t)) return false;
  if (/^eip155:/.test(net)) return EVM_SHORT.test(t);
  if (/^stellar:/.test(net)) return STELLAR_SHORT.test(t);
  if (/^algorand:/.test(net)) return ALGO_SHORT.test(t);
  return false;
}

/**
 * The fault a failed settle receipt proves: "buyer" | "not-buyer" | "unknown".
 * `receipt` is the decoded PAYMENT-RESPONSE (success:false); `raw` the
 * facilitator's own { errorReason, errorMessage } before the guard cut it;
 * `network` the payment's network when the receipt names none. Pure.
 */
export function settleFailureFault({ receipt = null, raw = null, network = null } = {}) {
  const code = String(receipt?.errorReason || "").trim();
  const rawReason = typeof raw?.errorReason === "string" ? raw.errorReason : "";
  const rawMessage = typeof raw?.errorMessage === "string" ? raw.errorMessage : "";
  const text = `${rawReason} ${rawMessage}`.slice(0, TEXT_MAX);
  const net = typeof receipt?.network === "string" && receipt.network ? receipt.network : String(network || "");
  if (NOT_BUYER_CODE.test(code) || NOT_BUYER_CODE.test(rawReason.trim())) return "not-buyer";
  // A verdict code first: words in a message never turn it into anything else.
  if (isBuyerSettleVerdict(code) || isBuyerSettleVerdict(rawReason)) return "buyer";
  // Our request not completing, a facilitator's HTTP status, a billing limit
  // on our account: proven, and not the buyer's.
  if (notCheckedRefusal(text) || notCheckedRefusal(code)) return "not-buyer";
  if (isFacilitatorBillingRefusal(code) || isFacilitatorBillingRefusal(text)) return "not-buyer";
  if (isBalanceShortfallText(text, net)) return "buyer";
  return "unknown";
}

// The Tempo gate's refusal classes (src/mpp-tempo.js TEMPO_REFUSAL_CLASSES),
// by the fault each proves. Any class not named here is "unknown".
const TEMPO_BUYER = new Set(["insufficient-funds", "transfer-mismatch", "memo-unbound", "expired", "replay", "simulation-failed"]);
const TEMPO_NOT_BUYER = new Set(["relay-unreachable", "chain-unreachable", "relay-unavailable", "relay-dependency-unavailable", "screen-unavailable", "screen-rejected"]);
/** The fault a Tempo refusal class proves. Pure. */
export function tempoRefusalFault(cls) {
  const c = String(cls || "");
  return TEMPO_BUYER.has(c) ? "buyer" : TEMPO_NOT_BUYER.has(c) ? "not-buyer" : "unknown";
}

/** The request property a payment gate with no x402 receipt (the Tempo
 *  gate) sets to its refusal's fault ("buyer" | "not-buyer" | "unknown"). */
export const SETTLE_FAULT = "__settleFault";
