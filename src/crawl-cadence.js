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

// Seconds, for machine surfaces that state the cadence (/.well-known/x402).
export const CRAWL_INTERVAL_SECONDS = CRAWL_INTERVAL_MS / 1000;
export const DISCOVERY_INTERVAL_SECONDS = DISCOVERY_INTERVAL_MS / 1000;

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

// Origins whose operator asked us to probe them less often. The request is
// theirs, so the set is explicit and small, and the cadence is a multiple of the
// normal cycle: a due check on the cycle number, never a second timer.
// Set on the deployment, never in source: CRAWL_SLOW_ORIGINS=<origin>,<origin>
export const SLOW_ORIGINS = Object.freeze(new Set(String(process.env.CRAWL_SLOW_ORIGINS || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)));
export const SLOW_ORIGIN_EVERY_CYCLES = 12; // 12 x 30 minutes = every 6 hours
export function isSlowOrigin(origin) {
  return SLOW_ORIGINS.has(String(origin || "").replace(/\/+$/, ""));
}

/** "every 6 hours": the slower cycle an operator can ask us for (CRAWL_SLOW_ORIGINS). */
export const slowOriginIntervalLabel = () => everyLabel(CRAWL_INTERVAL_MS * SLOW_ORIGIN_EVERY_CYCLES);

// A paid route's live 402 is read once and then again once this much time has
// passed (a learned quote's age, and the weekly re-check of a route whose
// price the seller's own documents declare). A re-registration reads it now.
export const LIVE_QUOTE_MAX_AGE_MS = Number(process.env.QUOTE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000;
export const NETWORKS_VERIFY_AGE_MS = Number(process.env.NETWORKS_VERIFY_AGE_MS) || 7 * 24 * 60 * 60 * 1000;
// ONE ROUTE, ONE UNPAID PRICE READ PER INTERVAL. Whatever makes a route due
// (a price it never yielded, a price that keeps differing from the seller's
// documents, a 402 we could not read), the scheduled crawl sends one route
// at most one unpaid price read (one pass of requests) per this interval. A
// read that got no answer of the route's own (a server error, a redirect, a
// connection that did not finish) keeps one retry; a price the seller's
// documents changed since the last read is read once; a registration reads
// at once (src/x402-index.js routeHeldToInterval). The paywall check, one
// request to a seller's cheapest paid route on a rotation across the index,
// keeps its own cadence; only its repeat after a refusal of our request's
// shape is held to this interval (paywallShapeRefusalHeld).
// ROUTE_PROBE_MIN_INTERVAL_DAYS: days, default 7, at most 30; `off` or 0
// removes the interval. A value that is not a number reads as the default.
export const ROUTE_PROBE_MIN_INTERVAL_MS = (() => {
  const raw = String(process.env.ROUTE_PROBE_MIN_INTERVAL_DAYS ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return 0;
  const n = Number(raw);
  return Math.round(Math.min(30, raw !== "" && Number.isFinite(n) && n > 0 ? n : 7) * 24 * 60 * 60 * 1000);
})();
// A route that answered the unpaid quote probe with no 402 at all (the
// seller's limit, an input check, a free answer) is held this long before it
// is asked again, doubling on each refusal up to the maximum (src/x402-index.js).
export const QUOTE_REFUSED_BACKOFF_MS = 3 * 24 * 60 * 60 * 1000;
export const QUOTE_REFUSED_BACKOFF_MAX_MS = 14 * 24 * 60 * 60 * 1000;

/** A span as prose: "a week", "2 days", "a day", "12 hours", "an hour", "30 minutes". */
export function spanLabel(ms) {
  const n = Math.round(Number(ms) || 0);
  const WEEK = 7 * 86_400_000, DAY = 86_400_000, HOUR = 3_600_000;
  const unit = (k, one, many) => (k === 1 ? one : `${k} ${many}`);
  if (n >= WEEK && n % WEEK === 0) return unit(n / WEEK, "a week", "weeks");
  if (n >= DAY && n % DAY === 0) return unit(n / DAY, "a day", "days");
  if (n >= HOUR && n % HOUR === 0) return unit(n / HOUR, "an hour", "hours");
  return unit(Math.round(n / 60_000), "a minute", "minutes");
}
