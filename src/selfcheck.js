// Synthetic self-check — the missing "is a paid tool actually working in prod?"
// signal.
//
// The gap this closes: earnings-calendar failed 100% for weeks and NOTHING
// caught it. CI's "answers its own example" check only runs pre-deploy; the
// aggregate error rate on /api/stats drowns a single low-traffic tool; and the
// live test suites are deliberately failure-tolerant (they warn-and-continue on
// upstream errors). So a green board + passing tests coexisted with a dead tool.
//
// This runs a CURATED set of high-value tools' OWN documented examples live,
// in-process (no HTTP, no payment — we call the handler directly), so a broken
// tool is caught immediately, independent of organic traffic. A GitHub Action
// (tool-alert.yml) polls /api/selfcheck and opens an issue when any curated tool
// fails — the same open/close pattern as the 15-minute heartbeat.
//
// Deliberately NOT all 500 tools: many legitimately return 503 without a key
// or 4xx on placeholder example inputs, which would be pure noise. This list is
// the tools whose outage actually costs us — the finance/market-data wedge that
// real buyers pay for — plus a pure-CPU canary that isolates "the server itself
// is fine" from "an upstream broke".

export const SELFCHECK_SLUGS = [
  "hash",                  // pure-CPU canary — proves the server itself is healthy
  "stock-quote",           // wedge star (Databento; 503s without DATABENTO_API_KEY)
  "treasury-debt",         // Treasury Fiscal Data
  "treasury-avg-rates",    // Treasury Fiscal Data
  "treasury-yield-curve",  // FRED CSV (keyless — also proves FRED CSV is reachable)
  "fx-dashboard",          // ECB / Frankfurter
  "stock-history",         // wedge — the second Databento endpoint beyond the quote
  "crypto-market",         // crypto prices
  "whois",                 // DNS / RDAP
  // High-value paid tools the reliability review flagged as unmonitored — added so
  // a break in EDGAR / crypto / on-chain / DeFi is caught proactively (synthetically,
  // no real traffic needed), not only when an agent happens to pay-and-fail. Keyless.
  "company-financials",    // SEC EDGAR — the priciest tool ($0.02)
  "edgar-company-lookup",  // SEC EDGAR
  "price-coingecko",       // CoinGecko price
  "defi-tvl",              // DeFiLlama
  "gas-estimate",          // on-chain gas (public RPC)
  "crypto-global",         // crypto market globals
  // FDA + NHTSA federal-data pack — monitored with semantic invariants (a fixed
  // VIN, a permanent recall) so a break in an openFDA/NHTSA mapping pages us.
  "vin-decode",            // NHTSA vPIC
  "vehicle-recalls",       // NHTSA recalls
  "drug-recalls",          // openFDA drug enforcement
  "food-recalls",          // openFDA food enforcement
  "drug-adverse-events",   // openFDA FAERS
  "device-recalls",        // openFDA device enforcement
  "college-lookup",        // College Scorecard (api.data.gov key, DEMO fallback)
  "fec-candidates",        // FEC (api.data.gov key, DEMO fallback)
  "federal-awards",        // USAspending (POST search)
  "geo-lookup",            // FCC Area API (lat/lon -> county/state)
  "fema-disasters",        // openFEMA disaster declarations
];
// Semantic invariants — the teeth on the self-check. Running a tool's example
// and seeing it "not throw" catches a dead upstream, but NOT a tool that returns
// the wrong thing (an upstream that changed shape, a mapping we broke). Each
// invariant gets the handler's result for the tool's documented example input
// and returns true iff the KNOWN-CORRECT answer still holds. Facts must be
// permanent so this can never flake on live values: a fixed VIN decodes to the
// same car forever, a historical recall never un-happens, the national debt only
// grows, a stock has a positive price. A tool with an invariant is only "ok" when
// it ran AND the invariant held. (Applied in checkOne; retried like any failure.)
export const INVARIANTS = {
  // FDA + NHTSA pack (this batch)
  "vin-decode": (r) => r?.vehicle?.make === "HONDA" && r?.vehicle?.year === "2003",
  "vehicle-recalls": (r) => Number(r?.count) >= 1 && !!r?.recalls?.[0]?.campaign,
  "drug-recalls": (r) => Number(r?.count) >= 1 && !!r?.recalls?.[0]?.classification,
  "food-recalls": (r) => Number(r?.count) >= 1,
  "drug-adverse-events": (r) => Array.isArray(r?.topReactions) && r.topReactions.length >= 1 && typeof r.topReactions[0]?.reports === "number",
  "device-recalls": (r) => Number(r?.count) >= 1 && !!r?.recalls?.[0]?.classification,
  "college-lookup": (r) => Number(r?.count) >= 1 && /stanford/i.test(r?.colleges?.[0]?.name || "") && r.colleges[0].state === "CA",
  "fec-candidates": (r) => Number(r?.count) >= 1 && !!r?.candidates?.[0]?.candidateId,
  "federal-awards": (r) => Number(r?.count) >= 1 && Number(r?.awards?.[0]?.amountUsd) > 0,
  "geo-lookup": (r) => r?.state === "CA" && /los angeles/i.test(r?.county || ""), // fixed coords -> fixed county
  "fema-disasters": (r) => Number(r?.count) >= 1 && typeof r?.disasters?.[0]?.disasterNumber === "number",
  // revenue-critical existing tools (stable facts, not live values)
  "stock-quote": (r) => typeof r?.price === "number" && r.price > 0 && !!r?.symbol,
  "treasury-debt": (r) => Number(r?.totalPublicDebtOutstanding) > 30e12, // debt only grows; already >$30T
  "crypto-global": (r) => Number(r?.totalMarketCap) > 0 && Number(r?.btcDominancePct) > 0 && Number(r?.btcDominancePct) < 100,
  "whois": (r) => !!r?.domain && Array.isArray(r?.nameservers), // registered domain resolves with a nameserver list
};

// Key-gated tools: checked ONLY when their key env var is actually set. This is
// how we monitor key EXPIRY without false-paging on an intentional unset — a
// set-but-invalid key makes the tool fail and we page; an unset key is simply
// skipped (a fork or a deliberately-disabled feature never trips the alarm).
// These cover the keyed tools whose outage costs revenue: FRED (macro) and
// Brave (search — a top earner).
export const KEYED_SELFCHECKS = [
  { slug: "cpi-yoy", envVar: "FRED_API_KEY" },  // FRED JSON API — key expiry ⇒ every FRED tool dies
  { slug: "search", envVar: "BRAVE_API_KEY" },  // Brave search — top revenue tool
];

// The effective curated list for this deployment: the always-on keyless set plus
// any key-gated tool whose key is configured here. Computed at call time because
// it depends on process.env.
export function selfcheckSlugs() {
  const keyed = KEYED_SELFCHECKS
    .filter((k) => (process.env[k.envVar] || "").trim())
    .map((k) => k.slug);
  return [...SELFCHECK_SLUGS, ...keyed];
}

// Run one tool's documented example, with a hard timeout. Returns a plain result
// object; never throws.
async function checkOne(def, timeoutMs) {
  const input = def.discovery?.input || {};
  const t0 = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => def.handler(input)),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error("selfcheck timeout"), { statusCode: 504 })), timeoutMs);
      }),
    ]);
    // Semantic invariant (if defined): the tool ran, but did it return the
    // known-correct answer? A false invariant is a real regression, not a blip.
    const invariant = INVARIANTS[def.slug];
    if (invariant) {
      let held = false;
      try { held = !!invariant(result); } catch { held = false; }
      if (!held) return { slug: def.slug, ok: false, ms: Date.now() - t0, status: 0, error: "invariant failed: ran but returned an unexpected answer (upstream shape change?)" };
    }
    return { slug: def.slug, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { slug: def.slug, ok: false, ms: Date.now() - t0, status: e?.statusCode || 0, error: String(e?.message || e).slice(0, 160) };
  } finally {
    clearTimeout(timer); // don't leave a pending timer holding the loop after a fast success
  }
}

// Run the curated self-check against a route→def CATALOG. Each failing tool is
// retried ONCE after a short backoff before being reported failed, so a single
// transient upstream blip can't page us — only a tool that
// fails twice in a row is real.
// Keyed checks hit PAID upstreams (Brave web search bills per call), and
// they exist to catch KEY EXPIRY — an hours-scale event. The route's 5-min
// cache is right for the keyless checks but let monitoring (tool-alert polls
// every 30 min) plus any stranger hitting the free endpoint burn ~48 real
// Brave calls/day (2026-07-23 leak audit). Keyed results are therefore reused
// for 6h; a failing keyed check is NOT cached, so a real key problem still
// re-tests (and pages) on the next poll.
const KEYED_TTL_MS = 6 * 60 * 60 * 1000;
// A FAILING keyed check was deliberately not cached, so a real key problem
// would re-test on the next poll. Correct instinct, wrong bound: with a 30-min
// poll and a retry on failure that is ~96 billed Brave calls a day, and it
// bills hardest exactly when the thing is already broken. The outage pays for
// itself twice.
//
// Negatives are now cached too, on a much shorter TTL. This does NOT hide the
// failure: the cached result is still `ok:false`, so it stays in `failing`,
// the endpoint still reports it, and tool-alert.yml still pages and keeps its
// issue open. The only thing that changes is how often we PAY to re-confirm
// something we already know.
const KEYED_FAIL_TTL_MS = 30 * 60 * 1000;
const keyedCache = new Map(); // slug → { at, result }
const keyedTtlFor = (result) => (result?.ok ? KEYED_TTL_MS : KEYED_FAIL_TTL_MS);
const KEYED_SLUG_SET = new Set(KEYED_SELFCHECKS.map((k) => k.slug));

export async function runSelfCheck(catalog, slugs = selfcheckSlugs(), { timeoutMs = 12000 } = {}) {
  const bySlug = new Map();
  for (const def of Object.values(catalog)) bySlug.set(def.slug, def);
  const results = [];
  for (const slug of slugs) {
    const def = bySlug.get(slug);
    if (!def) { results.push({ slug, ok: false, error: "not in catalog" }); continue; }
    const keyed = KEYED_SLUG_SET.has(slug);
    const hit = keyed ? keyedCache.get(slug) : null;
    if (hit && Date.now() - hit.at < keyedTtlFor(hit.result)) {
      results.push({ ...hit.result, cachedKeyedCheck: true });
      continue;
    }
    let r = await checkOne(def, timeoutMs);
    if (!r.ok) {
      await new Promise((res) => setTimeout(res, 500));
      const retry = await checkOne(def, timeoutMs);
      // Keep the retry's verdict; note that it took two tries to fail.
      r = retry.ok ? { ...retry, flaky: true } : retry;
    }
    // Cache the verdict either way. A success is trusted for 6h; a failure for
    // 30 min - long enough to stop hammering a metered upstream that is already
    // down, short enough that a recovery is noticed promptly.
    if (keyed) keyedCache.set(slug, { at: Date.now(), result: r });
    results.push(r);
  }
  const failing = results.filter((r) => !r.ok).map((r) => r.slug);
  return {
    ok: failing.length === 0,
    checked: results.length,
    failing,
    results,
    at: new Date().toISOString(),
  };
}

// The HTTP surface's cache, kept here so it can be tested without booting the
// server. /api/selfcheck is free and unauthenticated, and a fresh run drives
// metered upstreams (the CoinGecko Demo key's monthly quota, billed Databento
// queries, public RPCs). So a public caller can never cause a run more often
// than once per `publicTtlMs`, however often it polls: the one scheduled
// consumer (tool-alert.yml) polls every 30 minutes, so a 30-minute cache costs
// it nothing. The operator may ask for a fresher answer with `?fresh=1`, but
// even then no more than once per `operatorFloorMs`. Every run is single-
// flighted, so a burst of callers shares one run.
export const SELFCHECK_PUBLIC_TTL_MS = 30 * 60 * 1000;
export const SELFCHECK_OPERATOR_FLOOR_MS = 5 * 60 * 1000;
export function createSelfCheckRoute({
  run,
  isOperator = () => false,
  publicTtlMs = SELFCHECK_PUBLIC_TTL_MS,
  operatorFloorMs = SELFCHECK_OPERATOR_FLOOR_MS,
  now = () => Date.now(),
} = {}) {
  let cache = { at: 0, value: null };
  let inFlight = null;
  return async function selfCheckRoute(req, res) {
    const wantsFresh = String(req?.query?.fresh || "") === "1" && isOperator(req);
    const ttl = wantsFresh ? operatorFloorMs : publicTtlMs;
    const age = now() - cache.at;
    const meta = (a) => ({ cacheTtlSeconds: Math.round(ttl / 1000), ageSeconds: Math.max(0, Math.round(a / 1000)) });
    if (cache.value && age < ttl) {
      return res.json({ ...cache.value, cached: true, ...meta(age) });
    }
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => run())
        .then((v) => { cache = { at: now(), value: v }; return v; })
        .finally(() => { inFlight = null; });
    }
    try {
      const v = await inFlight;
      res.json({ ...v, cached: false, ...meta(now() - cache.at) });
    } catch {
      res.status(500).json({ ok: false, error: "selfcheck failed to run" });
    }
  };
}
