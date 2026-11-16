// The routes whose effect outlives the answer, as one list with no imports, so
// a script that runs before any install (scripts/lib/keepalive-plan.js, read
// by the heartbeat and the keep-alive plan step) reads the same list the
// server does. src/hangup-forgiveness.js re-exports it and explains each
// entry; scripts/test-hangup-settlement.js and scripts/test-gateway-nanopayments.js
// check it against the booted catalog's flags (spendsOwnWallet,
// paysThirdPartySeller).
const LASTING_EFFECT_SLUGS = new Set([
  "memory-write", "memory-incr", "memory-cas", "memory-grant", "memory-revoke", "memory-remember", "memory-forget",
  "attest",
  "feedback",
  "route-execute", "route-execute-plus", "route-execute-max", "route-execute-pro",
  "seller-payability",
  "flight-search", "flight-status",
  "decide-execute",
]);
export const LASTING_EFFECT_SLUG_LIST = Object.freeze([...LASTING_EFFECT_SLUGS]);

/** True for a slug whose effect outlives an undelivered answer. */
export function hasLastingEffect(slug) {
  return typeof slug === "string" && LASTING_EFFECT_SLUGS.has(slug);
}
