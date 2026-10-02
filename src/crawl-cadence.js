// The index crawler's two cadences, in a leaf module so page renderers can
// quote them without importing the crawler (src/x402-index.js imports the
// market pages, so the pages importing it back would close a cycle).
//
// A cadence stated in page prose is a factual claim about our own behaviour
// toward third parties - the same class as a price quoted in prose - so it is
// generated from these constants, never typed.

// One full re-probe of every known origin per cycle (see x402-index.js for
// the bandwidth measurement behind 30 minutes).
export const CRAWL_INTERVAL_MS = 30 * 60 * 1000;
// How often the discovery registries (the Bazaar feed among them) are re-read.
export const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

function everyLabel(ms) {
  const mins = Math.round(ms / 60000);
  if (mins % 60 === 0 && mins >= 60) {
    const h = mins / 60;
    return h === 1 ? "every hour" : `every ${h} hours`;
  }
  return `every ${mins} minutes`;
}

/** "every 30 minutes": how often each indexed origin is re-probed. */
export const crawlIntervalLabel = () => everyLabel(CRAWL_INTERVAL_MS);
/** "every hour": how often the discovery registries are re-read. */
export const discoveryIntervalLabel = () => everyLabel(DISCOVERY_INTERVAL_MS);
