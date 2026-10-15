// One upto signer for every replica.
//
// An upto offer names the facilitator address its Permit2 witness binds to
// (extra.facilitatorAddress), copied from the facilitator's /supported answer
// at boot. A facilitator that runs several signers may name a different one on
// each call, so two replicas booted seconds apart offer different requirements
// for the same request. x402 matches a paid retry against the offer the
// serving replica builds, so a buyer quoted by one replica and paid on the
// other is refused with "No matching payment requirements".
//
// The fix keeps the facilitator's own choice set and only removes the
// randomness: when the named address is one of the signers the same answer
// publishes for that network, every process names the lowest of them. An
// address outside the published list, or an answer with no list, is left
// exactly as the facilitator sent it.

const lc = (a) => String(a || "").toLowerCase();

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

/** A copy of a /supported answer whose upto kinds name one stable signer. */
export function pinUptoFacilitatorAddress(supported) {
  if (!supported || !Array.isArray(supported.kinds)) return supported;
  let changed = false;
  const kinds = supported.kinds.map((kind) => {
    const named = kind?.extra?.facilitatorAddress;
    if (String(kind?.scheme || "").toLowerCase() !== "upto" || typeof named !== "string") return kind;
    const list = signersFor(supported.signers, kind.network);
    if (!list.some((a) => lc(a) === lc(named))) return kind;
    const pinned = [...list].sort((a, b) => (lc(a) < lc(b) ? -1 : lc(a) > lc(b) ? 1 : 0))[0];
    if (lc(pinned) === lc(named)) return kind;
    changed = true;
    return { ...kind, extra: { ...kind.extra, facilitatorAddress: pinned } };
  });
  return changed ? { ...supported, kinds } : supported;
}
