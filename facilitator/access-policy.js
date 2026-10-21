// Access policy helpers for the facilitator's startup check and auth gate.
// Dependency-free (node:crypto only) so they are testable without the
// facilitator's own node_modules.
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A mainnet facilitator with no bearer token and no payTo allowlist settles
 * for any caller, to any payTo, with this signer paying the fees. Returns the
 * refusal message for that case (startup exits with it), or null when the
 * facilitator is gated, not on mainnet, or the operator opted in with
 * FACILITATOR_ALLOW_OPEN=1.
 */
export function openFacilitatorRefusal({ network, authToken, allowedPayTo, allowOpen }) {
  if (network !== "stellar:pubnet") return null;
  if (authToken || (allowedPayTo && allowedPayTo.length)) return null;
  if (allowOpen) return null;
  return [
    "[startup] Refusing to start: FACILITATOR_NETWORK=pubnet with neither FACILITATOR_AUTH_TOKEN",
    "[startup] nor FACILITATOR_ALLOWED_PAYTO set would let any caller settle to any payTo with",
    "[startup] this signer paying the fees. Set one of the two. To run an intentionally open",
    "[startup] mainnet facilitator, opt in explicitly with FACILITATOR_ALLOW_OPEN=1.",
  ].join("\n");
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
