// Shared by the two catalog sweeps (test-all.js, test-non-metered-examples.js):
// "does a 200 carry every key its documented example promises?" Lives here so
// the strict sweep can take over the routes it covers from the lenient one
// without either losing the shape check - one endpoint, one hit, both checks.
// The skiplist lives in src/openapi-schema.js and is re-exported here: the
// same set decides which routes may declare `required` in /openapi.json, so a
// route excused from the shape check can never promise a shape in the spec.
export { SHAPE_HAPPY_PATH_ONLY } from "../src/openapi-schema.js";
import { SHAPE_HAPPY_PATH_ONLY as SKIP } from "../src/openapi-schema.js";

/** Documented top-level keys of the 200 example that the body lacks ([] when
 *  there is nothing to compare: no example, non-object body, opted-out path). */
export function missingDocumentedKeys(path, op, body) {
  if (SKIP.has(path)) return [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const example = op?.responses?.["200"]?.content?.["application/json"]?.example;
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  const expected = Object.keys(example);
  if (!expected.length) return [];
  const actual = Object.keys(body);
  return expected.filter((k) => !actual.includes(k));
}

// A documented example that returns NOTHING teaches an agent the tool is broken.
//
// Found 2026-08-29 while auditing why explorers leave: /api/keywords published
// `{text: "Long article text…"}` and answered `{keywords: [], phrases: []}`;
// polymarket-price-history published a FABRICATED token id (a repeating digit
// pattern) and answered `count: 0`; kalshi-event published `PRES-24`, whose
// markets Kalshi removed once the 2024 election settled. All three passed the
// documented-keys check above, because the keys are present - they are just
// empty. A buyer copying our own example gets an answer that looks like an
// outage.
//
// So: where the documented 200 example shows a NON-EMPTY array, the tool's own
// documented input must produce a non-empty array there too.
export const EMPTY_ARRAY_OK = new Map([
  // Index/board-backed tools: empty on a cold boot (the crawler is off in CI),
  // populated in production. Same reason x402-market-pulse is skiplisted above.
  ["/api/x402-trending", "sellers"],
  ["/api/x402-market-pulse", "topProviders,topToolCategories"],
  ["/api/demand-radar", "radar"],
  ["/api/bestsellers", "bestsellers"],        // reads OUR sales ledger: empty on a fresh CI boot, populated in production
  ["/api/x402-verify", "transfers"],          // placeholder 0x0…0 hash finds nothing, by design
  // Legitimately empty for the example's own subject, not a defect:
  ["/api/stock-dividends", "splits"],         // a stock that has never split
  ["/api/dividend-calendar", "entries"],      // no US ex-dividend dates on a weekend
  ["/api/nft-metadata", "attributes"],        // a token whose collection publishes no traits
  ["/api/coin-profile", "platforms"],         // a native coin has no contract addresses
  ["/api/memory/grants", "grants"],           // a fresh store holds no grants
  // EVERY OTHER wallet-keyed READ, for the same reason plus a sharper one.
  // Listed as a family on purpose: this was first fixed for /api/memory and
  // /api/memory/log alone, and /api/memory/recall surfaced two hours later on
  // the next unlucky interleaving - the same defect, found twice, because the
  // first fix covered the two that happened to fail that run instead of the
  // class. If a new wallet-keyed read is added, it belongs here too.
  // they take no required parameter (the namespace IS the payer), so they are
  // non-empty only once a write to that same derived owner has landed - and the
  // sweep drives 8 requests CONCURRENTLY, so the read can and does beat
  // /api/memory/remember. That made the run fail at random from the day this
  // check shipped (2026-08-29), on main as much as on a branch. The tools are
  // correct: an empty store has nothing to list, and the example shows what the
  // answer looks like once it does.
  ["/api/memory", "keys"],                    // a fresh store holds no keys (and the sweep is concurrent)
  ["/api/memory/log", "entries"],             // same: nothing has been written yet in this namespace
  ["/api/memory/recall", "results"],          // same: a search over a namespace nothing has written to
]);

/** Keys whose documented example promises entries but whose live answer is an
 *  empty array. [] when there is nothing to compare or the path is excused. */
export function emptyPromisedArrays(path, op, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const example = op?.responses?.["200"]?.content?.["application/json"]?.example;
  if (!example || typeof example !== "object" || Array.isArray(example)) return [];
  const excused = new Set((EMPTY_ARRAY_OK.get(path) || "").split(",").filter(Boolean));
  return Object.entries(example)
    .filter(([k, v]) => Array.isArray(v) && v.length > 0 && !excused.has(k))
    .filter(([k]) => Array.isArray(body[k]) && body[k].length === 0)
    .map(([k]) => k);
}
