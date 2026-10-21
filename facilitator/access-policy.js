// Access policy helpers for the facilitator's startup check and auth gate.
// Dependency-free (node:crypto only) so they are testable without the
// facilitator's own node_modules.
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A mainnet facilitator with no bearer token and no payTo allowlist settles
 * for any caller, to any payTo, with this signer paying the fees. Returns the
 * startup warning lines for that case, or null when the facilitator is gated,
 * not on mainnet, or the operator acknowledged it with FACILITATOR_ALLOW_OPEN=1.
 */
export function openFacilitatorWarning({ network, authToken, allowedPayTo, allowOpen }) {
  if (network !== "stellar:pubnet") return null;
  if (authToken || (allowedPayTo && allowedPayTo.length)) return null;
  if (allowOpen) return null;
  const bar = "!".repeat(78);
  return [
    bar,
    "[startup] WARNING: OPEN MAINNET FACILITATOR. FACILITATOR_NETWORK=pubnet with neither",
    "[startup] FACILITATOR_AUTH_TOKEN nor FACILITATOR_ALLOWED_PAYTO set: any caller can settle",
    "[startup] to any payTo and this signer pays the fees. Set one of the two, or set",
    "[startup] FACILITATOR_ALLOW_OPEN=1 to acknowledge an intentionally open facilitator.",
    bar,
  ];
}

/**
 * Constant-time bearer token compare. Both sides are hashed to a fixed length
 * first, so neither the content nor the length of the expected token shows in
 * the timing. An empty expected token never matches.
 */
export function tokenMatches(got, expected) {
  const e = String(expected ?? "");
  if (!e) return false;
  const g = String(got ?? "");
  const a = createHash("sha256").update(g).digest();
  const b = createHash("sha256").update(e).digest();
  return timingSafeEqual(a, b) && g.length === e.length;
}
