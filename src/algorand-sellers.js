// Algorand external-seller source for the Smart Order Router.
//
// The Base external path discovers candidates in our own x402 index and gates
// them on PROVEN settled volume from the leaderboard (CDP/Base on-chain data).
// Algorand sellers appear in neither — their catalog AND settlement history
// live with the GoPlausible facilitator — so this module is both halves for
// the AVM chain, from two facilitator surfaces:
//   /discovery/merchants   merchantId -> totalVerifications
//   /discovery/resources   merchantId -> { resourceUrl, method, description,
//                                          accepts (amount, asset) }
// Verifications are facilitator-witnessed payment attempts (settles <=
// verifies); as a proven-activity gate they play the role callsSettled plays
// on Base, and the router's live 402-probe plus payX402's margin guard still
// run before any spend.
//
// Cached ~30 min (the economy-snapshot convention), single-flighted, and
// rebuilt on schedule only while the router reads it (IDLE below); NEVER throws — a facilitator outage yields an empty catalog, which simply
// gates external Algorand routing closed until the next successful refresh.
//
// OUR OWN CRAWL IS A SECOND SOURCE (2026-09-18). Until today this catalog was
// the ONLY one: a seller we indexed ourselves, advertising an Algorand accept
// with its own payTo, was not even a CANDIDATE unless GoPlausible also listed
// it, so no amount of real settlement could make it routable. That is the same
// registry dependence the Base leaderboard had (fixed the same day by seeding
// its scan from allPayToOrigins), one step worse, because on Base such a seller
// at least ranked. Both halves are supplied here now, injected from server.js:
//   candidates - priced Algorand routes from the index (crawledResources)
//   proof      - inbound USDC-ASA transfers to the seller's own advertised
//                payTo, read from the indexer (countInboundUsdc), which is the
//                same role GoPlausible's verification count plays and is read
//                from the chain rather than taken from a registry.
// A crawled resource that GoPlausible ALSO lists keeps the facilitator's
// verification count: it witnessed those payments and we did not.
//
// Every row is bound to the address its count belongs to before it is paid
// (algorandRouterCandidates below): our crawled payTo when we have one, else
// the receiving address the facilitator records; a row with neither is not
// dispatched.

import { algorandProofBinding } from "./dispatch-eligibility.js";

const GP_BASE = (process.env.ALGORAND_FACILITATOR_URL || "https://facilitator.goplausible.xyz").replace(/\/+$/, "");
const TTL_MS = Number(process.env.ALGORAND_SELLERS_TTL_MS || 30 * 60 * 1000);
const USDC_ASA = "31566704";
// PAGING. The facilitator's listings answer at most 100 rows a page whatever
// `limit` asks, and name the whole count in `pagination.total`. A loop that
// stopped on a page shorter than the one it asked for read only the first
// page. Each listing is read page by page, advancing by the rows each page
// returned, until `pagination.total` (or an empty page, or a short page when
// no total is named), and never past MAX_PAGES pages: a hostile or huge total
// costs at most MAX_PAGES reads per listing per build, each under its own
// time limit, and the build as a whole stays under its build limit. Rows past
// the cap are not read: the router then knows fewer sellers, never wrong ones.
const PAGE = 100;
const MAX_PAGES = Math.max(1, Math.min(500, Number(process.env.ALGORAND_SELLERS_MAX_PAGES) || 80)); // 8,000 rows a listing
// TIME LIMITS. A build started while a buyer waits (a cold catalog with no
// build running) keeps the short per-read limit; the background build (the
// boot warm-up and the scheduled refresh) reads with its own longer one,
// since a cold merchant read was measured at about twice the short limit.
const READ_TIMEOUT_MS = 15_000;
const BG_READ_TIMEOUT_MS = Math.max(READ_TIMEOUT_MS, Number(process.env.ALGORAND_SELLERS_BG_READ_TIMEOUT_MS) || 60_000);
const BUILD_MAX_MS = 120_000;
const BG_BUILD_MAX_MS = Math.max(BUILD_MAX_MS, Number(process.env.ALGORAND_SELLERS_BG_BUILD_MAX_MS) || 10 * 60_000);

let cache = { at: 0, resources: [] };
let inFlight = null;
let lastBuild = null; // { background, readTimeoutMs, startedAt, pages } of the last build started
// IDLE. A build reads up to MAX_PAGES pages of each listing, so the scheduled
// refresh does not rebuild a catalog nobody has read: the router's read
// records `lastUseAt`, and the timer's check rebuilds only when a read came
// at or after the start of the build that made the current cache. With no
// read since, the cache goes stale and the next read starts the build (it is
// served the stale list meanwhile). The boot warm-up always builds.
let lastUseAt = 0;
let cacheBuildStartedAt = 0; // start of the build that last finished (success or failure)
/** Which per-read limit the last build used (the offline test reads it). */
export function algorandCatalogBuildInfo() {
  return { ...(lastBuild || {}), readTimeoutMs: lastBuild?.readTimeoutMs ?? null, shortReadTimeoutMs: READ_TIMEOUT_MS, backgroundReadTimeoutMs: BG_READ_TIMEOUT_MS, maxPages: MAX_PAGES, pageSize: PAGE, lastUseAt, cacheBuildStartedAt };
}

async function getJson(path, timeoutMs = READ_TIMEOUT_MS) {
  const res = await fetch(`${GP_BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Every row of one facilitator listing, page by page (PAGING above).
 *  `read(path)` answers one page's JSON; `onRows(items)` takes each page.
 *  Exported for the offline test. */
export async function readListing(listPath, read, { onRows, maxPages = MAX_PAGES, pageSize = PAGE, deadline = Infinity } = {}) {
  let offset = 0, pages = 0, total = null;
  while (pages < maxPages) {
    if (Date.now() > deadline) throw new Error("catalog build passed its time limit");
    const j = await read(`${listPath}?limit=${pageSize}&offset=${offset}`);
    pages++;
    const items = Array.isArray(j?.items) ? j.items : [];
    const t = Number(j?.pagination?.total);
    if (Number.isSafeInteger(t) && t >= 0) total = t;
    if (items.length) onRows?.(items);
    offset += items.length;
    if (!items.length) break;
    if (total != null ? offset >= total : items.length < pageSize) break;
  }
  return { rows: offset, pages, total, capped: pages >= maxPages && (total == null || offset < total) };
}

// Algorand addresses are case-sensitive base32: kept exactly, never folded.
const algoAddr = (a) => (typeof a === "string" && /^[A-Z2-7]{58}$/.test(a) ? a : null);

async function build({ background = false } = {}) {
  const timeoutMs = background ? BG_READ_TIMEOUT_MS : READ_TIMEOUT_MS;
  const deadline = Date.now() + (background ? BG_BUILD_MAX_MS : BUILD_MAX_MS);
  const info = { background, readTimeoutMs: timeoutMs, startedAt: Date.now(), pages: null };
  lastBuild = info;
  const read = (path) => getJson(path, timeoutMs);
  const verifsByMerchant = new Map();
  const payToByMerchant = new Map();
  const merchantsRead = await readListing("/discovery/merchants", read, { deadline, onRows: (items) => {
    for (const m of items) {
      if (typeof m?.id === "string") verifsByMerchant.set(m.id, Number(m.totalVerifications) || 0);
      // The merchant's receiving address, when the record names one (an id
      // that is itself an address counts): the address its count belongs to.
      const addr = [m?.payTo, m?.address, m?.id].find(algoAddr);
      if (typeof m?.id === "string" && addr) payToByMerchant.set(m.id, addr);
    }
  } });
  const resources = [];
  const resourcesRead = await readListing("/discovery/resources", read, { deadline, onRows: (items) => {
    for (const r of items) {
      const verifs = verifsByMerchant.get(r?.merchantId) || 0;
      // Only USDC-ASA exact accepts are payable from the AVM spending wallet;
      // pick the entry payX402's own pin will later re-validate.
      const accept = (r?.accepts || []).find((a) => String(a?.asset || "") === USDC_ASA && String(a?.scheme || "exact") === "exact");
      const amountAtomic = String(accept?.amount ?? accept?.maxAmountRequired ?? "");
      if (!/^\d+$/.test(amountAtomic)) continue;
      let url;
      try { url = new URL(r.resourceUrl); } catch { continue; }
      // Hygiene: the open catalog contains localhost/plain-http registrations.
      // assertPublicUrl + ssrfDispatcher are the real guards at probe/pay time;
      // this just keeps garbage out of the rankings entirely.
      if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|\[?::1)/i.test(url.hostname)) continue;
      resources.push({
        url: url.href,
        origin: url.origin.toLowerCase(),
        path: url.pathname,
        method: String(r.method || "GET").toUpperCase(),
        description: String(r.description || ""),
        amountAtomic,
        priceUsd: Number(amountAtomic) / 1e6,
        verifs,
        // Where the facilitator records this route being paid: the accept's
        // own payTo, else its merchant's address. The router binds the live
        // 402 to it (algorandProofBinding, src/dispatch-eligibility.js).
        facilitatorPayTo: algoAddr(accept?.payTo) || payToByMerchant.get(r?.merchantId) || null,
      });
    }
  } });
  info.pages = { merchants: merchantsRead.pages, resources: resourcesRead.pages };
  console.log(`[algorand-sellers] catalog build (${background ? "background" : "on read"}) read ${merchantsRead.pages} merchant page(s) and ${resourcesRead.pages} resource page(s)${merchantsRead.capped || resourcesRead.capped ? " (page cap reached)" : ""}, ${resources.length} payable route(s)`);
  return resources;
}

/** Fold resources our own index knows into the facilitator catalog.
 *
 *  `crawled` is the shape server.js builds from the index: one entry per
 *  priced Algorand route, carrying the seller's advertised payTo. Resources
 *  the facilitator already lists win on identity (url + method) and keep its
 *  verification count; a route only we know enters with verifs 0 until the
 *  chain read below gives it a number, so it is a CANDIDATE that the router's
 *  own minVerifs gate still refuses. Pure and exported for the offline test.
 */
export function mergeCrawledResources(facilitator, crawled) {
  if (!Array.isArray(crawled) || !crawled.length) return { merged: facilitator, added: 0 };
  const key = (r) => `${String(r.method || "GET").toUpperCase()} ${String(r.url || "").toLowerCase()}`;
  const known = new Map(facilitator.map((r) => [key(r), r]));
  let added = 0;
  for (const c of crawled) {
    let url;
    try { url = new URL(c?.url); } catch { continue; }
    if (url.protocol !== "https:") continue;
    const amountAtomic = String(c?.amountAtomic ?? "");
    if (!/^\d+$/.test(amountAtomic)) continue;
    const row = {
      url: url.href,
      origin: url.origin.toLowerCase(),
      path: url.pathname,
      method: String(c.method || "GET").toUpperCase(),
      description: String(c.description || ""),
      amountAtomic,
      priceUsd: Number(amountAtomic) / 1e6,
      verifs: 0,
      payTo: typeof c.payTo === "string" && /^[A-Z2-7]{58}$/.test(c.payTo) ? c.payTo : null,
      source: "crawl",
    };
    const existing = known.get(key(row));
    if (existing) {
      // The facilitator witnessed this one. Keep its count and its wording;
      // only record that we know a payTo for it, which the chain read uses.
      if (!existing.payTo && row.payTo) existing.payTo = row.payTo;
      existing.source = existing.source === "crawl" ? "crawl" : "both";
      continue;
    }
    known.set(key(row), row);
    added++;
  }
  return { merged: [...known.values()], added };
}

/** Give crawl-only resources a settlement count read from the CHAIN.
 *
 *  GoPlausible's verification count is a facilitator's witness; for a seller it
 *  never saw, the equivalent evidence is inbound USDC-ASA transfers to the
 *  payTo the seller itself advertises. `countInbound(payTo)` is injected (the
 *  indexer lives in revenue-live.js, which this module does not import) and is
 *  asked ONCE PER DISTINCT PAYTO, not per resource.
 *
 *  A READ THAT FAILED IS UNKNOWN, NEVER A COUNT. A read that throws or returns
 *  a non-number is not "0 payments": the rows keep the last count a completed
 *  read gave for that payTo (within KNOWN_COUNT_TTL_MS), or, with none, stay
 *  unproven and carry `verifsUnknown: true`, and the catalog holding them is
 *  re-read in minutes instead of being kept for the whole TTL
 *  (algorandCatalog). An unreadable chain is never evidence of activity, and
 *  never evidence of its absence either. Only a completed read of 0 is a 0.
 */
const KNOWN_COUNT_TTL_MS = 24 * 3600 * 1000;
const knownInbound = new Map(); // payTo -> { n, at } from the last completed read
export function __resetKnownInboundForTest() { knownInbound.clear(); }
export async function proveCrawledResources(resources, countInbound, now = Date.now()) {
  if (typeof countInbound !== "function") return 0;
  const needed = new Map();
  for (const r of resources) {
    if (r?.source !== "crawl" || !r.payTo || r.verifs > 0) continue;
    if (!needed.has(r.payTo)) needed.set(r.payTo, []);
    needed.get(r.payTo).push(r);
  }
  let proved = 0;
  for (const [payTo, rows] of needed.entries()) {
    let n = NaN;
    try { n = Number(await countInbound(payTo)); } catch { n = NaN; }
    if (!Number.isFinite(n) || n < 0) {
      const known = knownInbound.get(payTo);
      if (known && now - known.at <= KNOWN_COUNT_TTL_MS) n = known.n;
      else { for (const r of rows) r.verifsUnknown = true; continue; }
    } else {
      if (knownInbound.size >= 5000 && !knownInbound.has(payTo)) knownInbound.delete(knownInbound.keys().next().value);
      knownInbound.set(payTo, { n, at: now });
    }
    if (n <= 0) continue;
    for (const r of rows) r.verifs = n;
    proved++;
  }
  return proved;
}
/** Re-read a catalog holding an unread count in this long, not the TTL. */
const UNKNOWN_COUNT_RETRY_MS = 5 * 60 * 1000;

/** The cached facilitator catalog. Stale cache is served while a deduped
 *  background refresh runs; only a cold cache awaits the build. Failure ->
 *  last known list (possibly empty), never throws. */
let sources = { crawledResources: null, countInbound: null };
/** Inject the index-backed halves (server.js). Both optional: with neither,
 *  this module behaves exactly as it did before 2026-09-18. */
/** The chain read server.js injects as `countInbound`: inbound USDC
 *  transfers to `payTo` from the indexer, through `getJson(bases, path, opts)`
 *  (src/revenue-live.js getJsonAcross). The indexer's 404 (no such account)
 *  is a definite 0; any other read that did not complete throws (unknown,
 *  never a count of 0). Inbound only, and never the seller paying itself. */
export const ALGORAND_USDC_ASSET_ID = 31566704;
export function makeIndexerInboundCount(getJson, bases) {
  return async (payTo) => {
    const r = await getJson(bases, `/v2/accounts/${payTo}/transactions?asset-id=${ALGORAND_USDC_ASSET_ID}&tx-type=axfer&limit=200`, { timeoutMs: 8000, okStatuses: [404] });
    if (r?.ok && r.status === 404) return 0;
    if (!r?.ok || !Array.isArray(r.json?.transactions)) throw new Error("indexer read did not complete");
    return r.json.transactions.filter((t) => t?.["asset-transfer-transaction"]?.receiver === payTo && t?.sender !== payTo).length;
  };
}
// `crawlReady()` (optional) says whether our own index has loaded: a build
// made before it has folds in no crawled rows, so it is re-read in minutes
// (like an unread count) rather than kept for the whole TTL.
export function setAlgorandCrawlSources({ crawledResources, countInbound, crawlReady } = {}) {
  sources = { crawledResources: crawledResources || null, countInbound: countInbound || null, crawlReady: typeof crawlReady === "function" ? crawlReady : null };
}

/** The catalog, never waiting more than `maxWaitMs` for a COLD build (no
 *  completed build yet): `{ resources, warming }`. `warming: true` means the
 *  first build is still running and this answer knows no seller yet; the
 *  build goes on and fills the cache for the next call. With no `maxWaitMs`
 *  a cold call waits for the build, as algorandCatalog() always did. */
export async function algorandCatalogWithin(maxWaitMs = null, { background = false } = {}) {
  if (!background) lastUseAt = Date.now();
  startBuildIfStale({ background });
  if (!cache.at && inFlight) {
    if (maxWaitMs == null) await inFlight;
    else {
      let timer;
      const timedOut = await Promise.race([
        inFlight.then(() => false),
        new Promise((r) => { timer = setTimeout(() => r(true), Math.max(0, Math.floor(maxWaitMs))); }),
      ]);
      clearTimeout(timer);
      if (timedOut && !cache.at) return { resources: [], warming: true };
    }
  }
  return { resources: cache.resources, warming: false };
}

/** Start a background build when the cache is stale (the boot warm-up and
 *  the scheduled refresh): never awaited by a caller, never throws. */
export function warmAlgorandCatalog() {
  startBuildIfStale({ background: true });
  return inFlight || Promise.resolve();
}

/** Whether the scheduled check may rebuild: never before a build has
 *  finished (the warm-up's own build is in flight), and after one only when
 *  the router read the catalog at or after that build's start (IDLE above). */
export function scheduledRefreshWanted() {
  return cacheBuildStartedAt > 0 && lastUseAt >= cacheBuildStartedAt;
}

/** Warm the catalog now and keep it fresh on its own schedule (the TTL, or
 *  the minutes-long re-read after an unread count or a failed build): a
 *  check every `checkMs` that builds only when the cache is stale and the
 *  router has read it since the last build (IDLE above). Off the request
 *  path; the timer never holds the process open. Returns a stop. */
export function startAlgorandCatalogRefresh({ checkMs = 60_000 } = {}) {
  warmAlgorandCatalog();
  const t = setInterval(() => { if (scheduledRefreshWanted()) warmAlgorandCatalog(); }, Math.max(1000, checkMs));
  t.unref?.();
  return () => clearInterval(t);
}

export async function algorandCatalog() {
  return (await algorandCatalogWithin(null)).resources;
}

function startBuildIfStale({ background = false } = {}) {
  const stale = Date.now() - cache.at > TTL_MS;
  if (stale && !inFlight) {
    let crawlWasReady = true;
    const startedAt = Date.now();
    inFlight = build({ background })
      .then(async (resources) => {
        // Our own index, folded in and then proven from the chain. Wrapped so a
        // failure in either half leaves the facilitator catalog exactly as it
        // was: this path may never make Algorand routing worse than it was
        // before it existed.
        let out = resources;
        try {
          if (typeof sources.crawledResources === "function") {
            try { crawlWasReady = sources.crawlReady ? sources.crawlReady() !== false : true; } catch { crawlWasReady = false; }
            const { merged } = mergeCrawledResources(out, await sources.crawledResources());
            out = merged;
            await proveCrawledResources(out, sources.countInbound);
          }
        } catch { out = resources; }
        // A count we could not read is not cached as one, and neither is a
        // build made before our index loaded: the catalog is re-read in
        // minutes (proveCrawledResources, crawlReady).
        const unread = !crawlWasReady || out.some((r) => r?.verifsUnknown === true);
        cache = { at: unread ? Date.now() - TTL_MS + UNKNOWN_COUNT_RETRY_MS : Date.now(), resources: out };
      })
      // Keep the last known list; back-date so the next call retries in ~5 min.
      .catch(() => { cache.at = Date.now() - TTL_MS + 5 * 60 * 1000; })
      .finally(() => { inFlight = null; cacheBuildStartedAt = startedAt; });
  }
}

const tokenize = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Rank the facilitator catalog against a task description. Pure given a
 *  resource list (exported for offline tests): DISTINCT task-token overlap on
 *  description + URL path (a spammy description repeating one keyword can't
 *  outrank a real match), with substring credit against path tokens so
 *  "price check" finds a /pricecheck route. Proven verifications break ties.
 *  Only in-cap, min-proven, non-excluded-origin resources come back. */
export function rankAlgorandResources(resources, task, { capUsd, minVerifs = 50, excludeOrigin = "" } = {}) {
  const want = [...new Set(tokenize(task))];
  if (!want.length) return [];
  const scored = [];
  for (const r of resources) {
    if (!(r.priceUsd > 0 && r.priceUsd <= capUsd)) continue;
    if (r.verifs < minVerifs) continue;
    if (excludeOrigin && r.origin === excludeOrigin) continue;
    const have = new Set(tokenize(r.description));
    const pathTokens = tokenize(r.path);
    let score = 0;
    for (const t of want) {
      if (have.has(t) || pathTokens.includes(t)) score += 1;
      else if (t.length > 3 && pathTokens.some((p) => p.includes(t))) score += 1; // "price" ⊂ "pricecheck"
    }
    if (score > 0) scored.push({ ...r, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.verifs - a.verifs);
}

/** The router's Algorand candidates: ranked rows, each bound to the address
 *  its proof was counted at (`chainProvenPayTo`, which the resolver checks
 *  against the probe's 402 and payX402 against the accept it signs). A row
 *  with no address to bind, or two that disagree, is dropped and counted by
 *  verdict. Pure; server.js maps the result into its candidate list. */
export function algorandRouterCandidates(resources, task, { capUsd, minVerifs = 50, excludeOrigin = "", network, limit = 5 } = {}) {
  const candidates = [];
  const dropped = {};
  for (const r of rankAlgorandResources(resources, task, { capUsd, minVerifs, excludeOrigin })) {
    const b = algorandProofBinding(r);
    if (!b.dispatchable) { dropped[b.verdict] = (dropped[b.verdict] || 0) + 1; continue; }
    if (candidates.length >= limit) continue;
    candidates.push({
      seller: r.origin, slug: r.path.replace(/^\//, ""), url: r.url, method: r.method,
      price: `$${r.priceUsd}`, priceUsd: r.priceUsd,
      networks: [network], settled: r.verifs,
      chainProvenPayTo: b.payTo, proofPayToBasis: b.basis,
      // The route's own text, for the category filter.
      description: r.description,
    });
  }
  return { candidates, dropped };
}

export function _resetForTest(resources = null) {
  cache = resources ? { at: Date.now(), resources } : { at: 0, resources: [] };
  inFlight = null;
  lastBuild = null;
  lastUseAt = 0;
  cacheBuildStartedAt = resources ? Date.now() : 0;
}
