// The payer screen our own settlers run before they submit a payment.
//
// A settler we sign for (the Robinhood relayer, and the Stellar settle path,
// whose primary facilitator may be our own) checks the payer against the same
// OFAC SDN list the x402 payer screen, the referral gate and the marketplace
// gate read: EVM addresses in the sanctions screen's set
// (src/sanctions-screen.js), any other address in the payout map
// (src/tools/sanctions-kit.js), the split src/x402-payer-screen.js uses. A
// listed payer is refused with nothing sent (src/settle-compliance.js words
// the answer and makes it final). With no list loaded the submission goes on
// as the direct routes' payer screen does, and is counted unscreened.

import { screenAddresses } from "./sanctions-screen.js";
import { screenAddressForPayment } from "./tools/sanctions-kit.js";
import { noteOwnScreenUnscreened, noteComplianceRefusal, OWN_SETTLER_SCREEN_REFUSED, OWN_SETTLER_SCREEN_REFUSED_TEXT } from "./settle-compliance.js";
import { X402_SCREENED_FIELDS } from "./x402-payer-screen.js";
import { stellarSignedPaymentOf } from "./stellar-confirm.js";

const EVM = /^0x[0-9a-fA-F]{40}$/;

/** "listed" | "clear" | "unscreened" for the payer `address`. */
export async function screenOwnSettlerPayer(address) {
  const a = typeof address === "string" ? address.trim() : "";
  if (!a) { noteOwnScreenUnscreened(); return "unscreened"; }
  if (EVM.test(a)) {
    const v = screenAddresses([a]);
    if (v.ok) return "clear";
    if (v.reason === "listed") return "listed";
    // The EVM set is not loaded: the payout map holds every listed address.
  }
  try {
    return (await screenAddressForPayment(a)) ? "listed" : "clear";
  } catch {
    noteOwnScreenUnscreened();
    return "unscreened";
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
const EVM_PAYER_PATHS = X402_SCREENED_FIELDS["x402-evm"].map((f) => f.split("."));

/** Every payer an EVM exact payload names, by the fields the x402 payer
 *  screen reads (X402_SCREENED_FIELDS["x402-evm"]): the EIP-3009
 *  `authorization.from` and the Permit2 `permit2Authorization.from`, in that
 *  order, de-duplicated without case, the zero address left out. */
export function evmSettlePayersOf(paymentPayload) {
  const inner = paymentPayload?.payload;
  const out = [], seen = new Set();
  if (!inner || typeof inner !== "object") return out;
  for (const path of EVM_PAYER_PATHS) {
    let at = inner;
    for (const k of path) at = at && typeof at === "object" && Object.hasOwn(at, k) ? at[k] : undefined;
    if (typeof at !== "string" || !EVM.test(at) || at.toLowerCase() === ZERO || seen.has(at.toLowerCase())) continue;
    seen.add(at.toLowerCase());
    out.push(at);
  }
  return out;
}

/** The Stellar settle path's screen: the payer read from this payment's own
 *  signed transaction is screened before `submit()` (the primary, then the
 *  fallback) runs. A listed payer is answered the own-screen refusal, final,
 *  and nothing is submitted; a clean, unscreened or unread payer goes on. */
export async function screenStellarBeforeSettle({ paymentPayload, requirements, network, submit, signedPaymentOf = stellarSignedPaymentOf, screen = screenOwnSettlerPayer, log = console.warn }) {
  let payer = null;
  try { payer = (await signedPaymentOf(paymentPayload, requirements))?.payer || null; } catch { payer = null; }
  if (payer) {
    let verdict = "unscreened";
    try { verdict = await screen(payer); } catch { verdict = "unscreened"; }
    if (verdict === "listed") {
      noteComplianceRefusal({ network, via: "stellar settle", kind: "own-screen", log });
      return { success: false, errorReason: OWN_SETTLER_SCREEN_REFUSED, errorMessage: OWN_SETTLER_SCREEN_REFUSED_TEXT, transaction: "", network, payer };
    }
  }
  return submit();
}
