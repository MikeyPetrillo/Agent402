// Candidate shapes for the external router's resolver (resolveExternalSeller
// in src/server.js). Pure: the resolver decides which rows qualify and which
// payTo is proven; these build the objects it ranks and hands to route-execute,
// so the fields a row carries from the index to the payer can be driven by a
// test through the same functions production uses.

/** A ranked Tempo catalog resource (src/tempo-sellers.js) as a resolver
 *  candidate. */
export function tempoCandidateOf(r) {
  return {
    seller: r.origin, slug: r.path.replace(/^\//, ""), url: r.url, method: r.method,
    // Dynamic-priced sellers carry no price here: the resolver's live-probe
    // loop reads it from the real tempo/charge challenge and drops the
    // candidate when it exceeds the cap.
    price: r.dynamic ? null : `$${r.priceUsd}`, priceUsd: r.dynamic ? null : r.priceUsd, dynamic: !!r.dynamic,
    networks: r.networks, wire: "mpp", settled: r.settled,
    ...(r.inputExample ? { inputExample: r.inputExample } : {}),
    // The route's own text, for the category filter.
    description: r.description, tags: r.tags,
  };
}

/** A live, gated candidate as route-execute receives it. `provenPayTo` and
 *  `evidenceWallets` are the resolver's own verdicts for this row. */
export function resolvedCandidateOf(r, { provenPayTo = null, evidenceWallets = null } = {}) {
  return {
    seller: r.seller, slug: r.slug, url: r.url, method: r.method, price: r.price, priceUsd: r.priceUsd, networks: r.networks, settled: r.settled,
    wire: r.wire || "x402", provenPayTo, evidenceWallets, route: r.route || null, guaranteedPaths: r.responseContract?.guaranteedPaths || [],
    ...(r.wire === "mpp" && r.inputExample ? { inputExample: r.inputExample } : {}),
    ...(r.unproven ? { unproven: true } : {}),
    ...(r.judgedSelection ? { selection: r.judgedSelection } : {}),
  };
}
