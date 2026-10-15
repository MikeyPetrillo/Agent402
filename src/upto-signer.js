// One facilitator signer for every replica.
//
// Some offers name a facilitator-held address copied from the facilitator's
// /supported answer at boot: an upto offer's extra.facilitatorAddress (the
// address its Permit2 witness binds to) and a Solana offer's extra.feePayer
// (the account that pays the transaction fee and must sign it). A facilitator
// that runs several signers may name a different one on each call, so two
// replicas booted seconds apart offer different requirements for the same
// request. x402 matches a paid retry against the offer the serving replica
// builds, so a buyer quoted by one replica and paid on the other is refused
// with "No matching payment requirements".
//
// The fix keeps the facilitator's own choice set and only removes the
// randomness: when the named address is one of the signers the same answer
// publishes for that network, every process names the lowest of them. An
// address outside the published list, or an answer with no list, is left
// exactly as the facilitator sent it. EVM addresses compare case-insensitively;
// base58 and every other family compare and sort exactly as written.

const PINNED_FIELDS = ["facilitatorAddress", "feePayer"];

function signersFor(signers, network) {
  if (!signers || typeof signers !== "object") return [];
  const family = String(network || "").split(":")[0];
  const out = [];
  for (const [key, list] of Object.entries(signers)) {
    if (!Array.isArray(list)) continue;
    if (key === network || key === `${family}:*`) out.push(...list.filter((a) => typeof a === "string"));
  }
  return out;
}

function keyFor(network) {
  return String(network || "").startsWith("eip155:") ? (a) => String(a).toLowerCase() : (a) => String(a);
}

/** A copy of a /supported answer whose signer-naming fields name one stable signer. */
export function pinFacilitatorSigners(supported) {
  if (!supported || !Array.isArray(supported.kinds)) return supported;
  let changed = false;
  const kinds = supported.kinds.map((kind) => {
    const extra = kind?.extra;
    if (!extra || typeof extra !== "object") return kind;
    const k = keyFor(kind.network);
    let next = null;
    for (const field of PINNED_FIELDS) {
      const named = extra[field];
      if (typeof named !== "string") continue;
      const list = signersFor(supported.signers, kind.network);
      if (!list.some((a) => k(a) === k(named))) continue;
      const pinned = [...list].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0))[0];
      if (k(pinned) === k(named)) continue;
      next = { ...(next || extra), [field]: pinned };
    }
    if (!next) return kind;
    changed = true;
    return { ...kind, extra: next };
  });
  return changed ? { ...supported, kinds } : supported;
}
