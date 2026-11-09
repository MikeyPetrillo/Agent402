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
// NEVER throws — a facilitator outage yields an empty catalog, which simply
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
const PAGE = 500;
const MAX_PAGES = 40; // 20k resources — far above today's catalog, bounded forever

let cache = { at: 0, resources: [] };
let inFlight = null;

async function getJson(path) {
  const res = await fetch(`${GP_BASE}${path}`, { signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Algorand addresses are case-sensitive base32: kept exactly, never folded.
const algoAddr = (a) => (typeof a === "string" && /^[A-Z2-7]{58}$/.test(a) ? a : null);

async function build() {
  const verifsByMerchant = new Map();
  const payToByMerchant = new Map();
  for (let offset = 0; offset < MAX_PAGES * PAGE; offset += PAGE) {
    const j = await getJson(`/discovery/merchants?limit=${PAGE}&offset=${offset}`);
    const items = j.items || [];
    for (const m of items) {
      if (typeof m?.id === "string") verifsByMerchant.set(m.id, Number(m.totalVerifications) || 0);
      // The merchant's receiving address, when the record names one (an id
      // that is itself an address counts): the address its count belongs to.
      const addr = [m?.payTo, m?.address, m?.id].find(algoAddr);
      if (typeof m?.id === "string" && addr) payToByMerchant.set(m.id, addr);
    }
    if (items.length < PAGE) break;
  }
  const resources = [];
  for (let offset = 0; offset < MAX_PAGES * PAGE; offset += PAGE) {
    const j = await getJson(`/discovery/resources?limit=${PAGE}&offset=${offset}`);
    const items = j.items || [];
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
    if (items.length < PAGE) break;
  }
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
 *  asked ONCE PER DISTINCT PAYTO, not per resource. A read that throws or
 *  returns a non-number leaves verifs at 0, which gates that seller closed:
 *  an unreadable chain is never evidence of activity.
 */
export async function proveCrawledResources(resources, countInbound) {
  if (typeof countInbound !== "function") return 0;
  const needed = new Map();
  for (const r of resources) {
    if (r?.source !== "crawl" || !r.payTo || r.verifs > 0) continue;
    if (!needed.has(r.payTo)) needed.set(r.payTo, []);
    needed.get(r.payTo).push(r);
  }
  let proved = 0;
  for (const [payTo, rows] of needed.entries()) {
    let n = 0;
    try { n = Number(await countInbound(payTo)); } catch { n = 0; }
    if (!Number.isFinite(n) || n <= 0) continue;
    for (const r of rows) r.verifs = n;
    proved++;
  }
  return proved;
}

/** The cached facilitator catalog. Stale cache is served while a deduped
 *  background refresh runs; only a cold cache awaits the build. Failure ->
 *  last known list (possibly empty), never throws. */
let sources = { crawledResources: null, countInbound: null };
/** Inject the index-backed halves (server.js). Both optional: with neither,
 *  this module behaves exactly as it did before 2026-09-18. */
export function setAlgorandCrawlSources({ crawledResources, countInbound } = {}) {
  sources = { crawledResources: crawledResources || null, countInbound: countInbound || null };
}

export async function algorandCatalog() {
  const stale = Date.now() - cache.at > TTL_MS;
  if (stale && !inFlight) {
    inFlight = build()
      .then(async (resources) => {
        // Our own index, folded in and then proven from the chain. Wrapped so a
        // failure in either half leaves the facilitator catalog exactly as it
        // was: this path may never make Algorand routing worse than it was
        // before it existed.
        let out = resources;
        try {
          if (typeof sources.crawledResources === "function") {
            const { merged } = mergeCrawledResources(out, await sources.crawledResources());
            out = merged;
            await proveCrawledResources(out, sources.countInbound);
          }
        } catch { out = resources; }
        cache = { at: Date.now(), resources: out };
      })
      // Keep the last known list; back-date so the next call retries in ~5 min.
      .catch(() => { cache.at = Date.now() - TTL_MS + 5 * 60 * 1000; })
      .finally(() => { inFlight = null; });
  }
  if (!cache.at && inFlight) await inFlight; // build() rejection is swallowed above
  return cache.resources;
}

const tokenize = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

/** Rank the facilitator catalog against a plain-language task. Pure given a
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
}
