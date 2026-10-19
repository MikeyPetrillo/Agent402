// How we found a seller's catalogue, said in one line the seller can act on.
//
// A leaf module with no imports on purpose: x402-index.js imports
// market-page.js, so the renderer cannot import the index back without a
// cycle (it produced "Cannot access 'CHAIN_PAGES' before initialization" and
// took the whole marketplace down). A pure formatter has no business in either
// of those files anyway.

// The one path the x402 spec names. Every other surface we read is a fallback,
// and that distinction is the whole point of discoveryNote().
export const WELL_KNOWN_PATH = "/.well-known/x402";

/**
 * A one-line, seller-readable account of HOW we found their catalogue.
 *
 * This exists because of #645. A seller watched us request their
 * /.well-known/x402 686 times in one week and take 404 every single time,
 * while their complete catalogue sat at /agents.json the whole while. From
 * their logs it looked like a broken crawler hammering a dead path. From our
 * index it looked like a thin seller. Neither side could see the other half,
 * and the gap was one line of text wide.
 *
 * So: say which surface answered, and when it was not the standard one, say
 * what to publish. Returns null when the seller is on the spec path, because a
 * note that renders for everyone is decoration rather than a signal.
 */
export function discoveryNote(entry) {
  const path = entry?.discoveryPath || null;
  if (path === WELL_KNOWN_PATH) return null;
  if (path) {
    return `catalog read from ${path} - no ${WELL_KNOWN_PATH} served, ` +
      `so buyers who follow the spec path find nothing`;
  }
  // No origin surface answered at all: everything shown was synthesised from a
  // third-party registry row. Say that plainly rather than let a listing pass
  // for a crawl.
  if (entry && entry.originResponded === false) {
    return `listed by a registry - this origin served neither ${WELL_KNOWN_PATH} ` +
      `nor /openapi.json nor /agents.json, so nothing here came from the seller`;
  }
  return null;
}

