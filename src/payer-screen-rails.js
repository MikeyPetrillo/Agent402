// Payer screening per rail: which identifier each payment rail's screen reads,
// and the Tempo relay-mode payer screen.
//
// THE RULE ON EVERY RAIL. A payer is refused only when an address it pays
// from is on the OFAC SDN list this server holds (src/sanctions-screen.js for
// EVM-format addresses, src/tools/sanctions-kit.js for every address the list
// names). A payer that is not listed is never refused, slowed or capped by a
// screen: no list loaded serves the payment unscreened (counted and surfaced
// as the sanctionsScreen word), except on Tempo direct mode, which offers no
// Tempo challenge until the list loads (every other method stays offered).
//
// WHERE EACH RAIL SCREENS, and the identifier it reads (PAYER_SCREEN_RAILS):
//   - x402 on an EVM chain, the MPP evm shim (x402 underneath) and the Circle
//     Gateway batched option (the same EIP-3009 authorization): the signed
//     payer, src/x402-payer-screen.js, after verification, before the handler.
//   - x402 on Solana (the transfer authorities and required signers), Stellar
//     (the transfer's `from`) and Algorand (the signed payment's sender): the
//     same screen.
//   - the referral copies (/ref): the same screen, failing closed.
//   - MPP Tempo, direct mode (TEMPO_RELAY=off): every payment party and the
//     payer's recent funders, src/mpp-tempo.js.
//   - MPP Tempo through the relay (the default): the payer addresses the
//     credential names (its did:pkh source, a pull transaction's sender, its
//     keychain account and recovered signer, and the sender the relay settled
//     on), screened here before the relay is asked and again after it
//     answers. relayPayerScreen below; hooked in validateTempoCredential.
//   - MPP subscriptions: the paying wallet, src/mpp-subscriptions.js.
//   - MPP card (Stripe), prepaid credits and card checkout: no payer address
//     exists on these rails (a card, or a key bought by card), so this server
//     runs no screen of its own; the card network's processor screens the
//     cardholder. The conformance cells say so.
import { screenAddresses, sanctionsScreenStatus, maskAddress } from "./sanctions-screen.js";

/** The identifier each rail's screen reads, keyed by conformance row kind.
 *  `identifier: null` means the rail carries no payer address. */
export const PAYER_SCREEN_RAILS = Object.freeze({
  "x402-evm": { identifier: "the signed payer: authorization.from (EIP-3009), or permit2Authorization.from (Permit2); both when both are present", source: "src/x402-payer-screen.js" },
  "x402-gateway-batched": { identifier: "the signed payer: authorization.from of the batched EIP-3009 authorization", source: "src/x402-payer-screen.js" },
  "x402-svm": { identifier: "the transaction's transfer authorities and required signers, except the fee payer", source: "src/non-evm-payer.js" },
  "x402-stellar": { identifier: "the `from` of the token transfer the transaction invokes", source: "src/non-evm-payer.js" },
  "x402-avm": { identifier: "the sender of the signed payment transaction in the group", source: "src/non-evm-payer.js" },
  "mpp-evm": { identifier: "the signed payer of the x402 payment the credential is translated to", source: "src/x402-payer-screen.js" },
  "mpp-tempo-direct": { identifier: "every payment party (source, sender, signer, fee payer, recipient, call targets) and the paying wallet's recent funders", source: "src/mpp-tempo.js" },
  "mpp-tempo-relay": { identifier: "the paying wallet: the credential's did:pkh source, the transaction's sender, its keychain account and signer, and the sender the relay settled on", source: "src/payer-screen-rails.js" },
  "mpp-stripe": { identifier: null, source: null },
  credits: { identifier: null, source: null },
  "card-checkout": { identifier: null, source: null },
  "card-subscription": { identifier: null, source: null },
  "mpp-subscription": { identifier: "the paying wallet the subscription authorization names, and its recent funders, before the first payment and before each renewal", source: "src/mpp-subscriptions.js" },
});

/** The rail key for a conformance row's network (x402 rows). */
export function x402ScreenKey(network, { batched = false } = {}) {
  const n = String(network || "");
  if (batched) return "x402-gateway-batched";
  if (n.startsWith("solana:")) return "x402-svm";
  if (n.startsWith("stellar:")) return "x402-stellar";
  if (n.startsWith("algorand:")) return "x402-avm";
  return "x402-evm";
}

const counts = { screened: 0, refused: 0, servedUnscreened: 0, lastRefusedAt: 0, lastUnscreenedAt: 0 };
let unscreenedLoggedAt = 0;

/**
 * The Tempo relay-mode payer screen. `addresses` are the payer addresses the
 * credential names (src/mpp-tempo.js tempoPayerAddresses, plus the sender the
 * relay settled on). Returns null to proceed (no address listed, no address
 * readable, or no list loaded: served unscreened and counted), else the
 * screen-rejected refusal validateTempoCredential returns (nothing has been
 * broadcast, so nothing is charged). Never throws.
 */
export function relayPayerScreen(addresses, phase = "before validate", { log = console.warn } = {}) {
  const list = [...new Set((Array.isArray(addresses) ? addresses : []).filter((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()))];
  if (!list.length) return null;
  let v;
  try { v = screenAddresses(list); } catch { v = { ok: false, reason: "unavailable" }; }
  if (v.ok) { counts.screened++; return null; }
  if (v.reason !== "listed") {
    counts.servedUnscreened++;
    counts.lastUnscreenedAt = Date.now();
    if (Date.now() - unscreenedLoggedAt >= 60_000) {
      unscreenedLoggedAt = Date.now();
      log("[sanctions-screen] Tempo relay payer screen: no list loaded, serving Tempo payments unscreened");
    }
    return null;
  }
  counts.screened++;
  counts.refused++;
  counts.lastRefusedAt = Date.now();
  return { ok: false, cls: "screen-rejected", error: `screen ${phase} (relay mode): payer ${maskAddress(v.address)} is on the OFAC SDN list (${list.length} payer addresses screened)`, reason: "a payment address is on the OFAC SDN list", requestId: null, relayMessage: null };
}

/** Counts for the operator view; never an address. */
export function relayPayerScreenView() {
  return {
    status: sanctionsScreenStatus(),
    screened: counts.screened,
    refused: counts.refused,
    servedUnscreened: counts.servedUnscreened,
    lastRefusedAt: counts.lastRefusedAt ? new Date(counts.lastRefusedAt).toISOString() : null,
    lastUnscreenedAt: counts.lastUnscreenedAt ? new Date(counts.lastUnscreenedAt).toISOString() : null,
  };
}

/** Test seam. */
export function __resetRelayPayerScreenForTests() {
  counts.screened = 0; counts.refused = 0; counts.servedUnscreened = 0; counts.lastRefusedAt = 0; counts.lastUnscreenedAt = 0;
  unscreenedLoggedAt = 0;
}
