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
import { noteOwnScreenUnscreened } from "./settle-compliance.js";

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
