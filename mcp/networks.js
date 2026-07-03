// Network preference for the x402 buyer — pure helpers, no side effects.
//
// AGENT402_NETWORKS (comma-separated, e.g. "robinhood" or "base,solana" or a
// raw CAIP-2 like "eip155:4663") restricts AND orders which payment options
// the buyer will consider from a seller's 402 `accepts`. Without it the
// underlying @x402 client picks whichever registered scheme matches first —
// which on a multi-chain seller is effectively always Base, making rails like
// USDG on Robinhood Chain unreachable no matter what the wallet holds.

export const NETWORK_CAIP2 = {
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  "base-sepolia": "eip155:84532",
  robinhood: "eip155:4663",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

/** Parse "robinhood,base" / "eip155:4663" into an ordered CAIP-2 list.
 *  Unknown names pass through verbatim so raw CAIP-2 ids (future chains)
 *  work without a package update. Returns [] when unset. */
export function parseNetworkPrefs(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((n) => NETWORK_CAIP2[n] || n);
}

/** Filter a 402's accepts to the preferred networks, ordered by preference
 *  (all accepts for the 1st preferred chain, then the 2nd, …). Throws with an
 *  actionable message when nothing matches — better than silently paying on a
 *  chain the operator excluded. No prefs → accepts unchanged. */
export function filterAcceptsByNetworks(accepts, prefs) {
  if (!prefs?.length) return accepts;
  const list = Array.isArray(accepts) ? accepts : [];
  const picked = prefs.flatMap((caip2) => list.filter((a) => String(a?.network || "").toLowerCase() === caip2.toLowerCase()));
  if (!picked.length) {
    const offered = [...new Set(list.map((a) => a?.network).filter(Boolean))];
    throw new Error(
      `AGENT402_NETWORKS matched none of the seller's payment options — wanted [${prefs.join(", ")}], offered [${offered.join(", ")}]. ` +
        "Remove the restriction or add one of the offered networks."
    );
  }
  return picked;
}

/** Apply the preference to an @x402 client (duck-typed — any version with
 *  createPaymentPayload works): the client only ever sees the filtered,
 *  preference-ordered accepts. Returns the same client for chaining. */
export function withNetworkPreference(client, prefs) {
  if (!prefs?.length) return client;
  const orig = client.createPaymentPayload.bind(client);
  client.createPaymentPayload = (paymentRequired) =>
    orig({ ...paymentRequired, accepts: filterAcceptsByNetworks(paymentRequired?.accepts, prefs) });
  return client;
}
