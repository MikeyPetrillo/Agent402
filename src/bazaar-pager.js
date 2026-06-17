// Paginated walker for x402 discovery endpoints (Coinbase CDP Bazaar shape).
//
// Why this lives on its own: both src/leaderboard.js and src/x402-index.js need
// to enumerate every Bazaar listing, but they have different fetch contracts
// (leaderboard uses a timeout + byte-capped fetch; the index uses the
// SSRF-guarded safeFetch). Keep the pagination loop in one place and inject
// the fetcher so each caller keeps its own transport guards.
//
// The Bazaar reports `pagination.total` so we walk to that. Free-tier
// pagination caps page size at 1000; the discovery endpoint has 69k+ listings
// and growing, so a single un-paginated fetch sees <0.2% of the corpus.

/**
 * Walk every page of a Bazaar-shaped discovery endpoint.
 *
 * @param {string} baseUrl - the discovery endpoint (without limit/offset query params).
 * @param {object} opts
 * @param {number} [opts.pageSize=1000] - items per page (Bazaar caps at 1000).
 * @param {number} [opts.maxPages=200]  - hard ceiling on pages walked (DoS guard).
 * @param {(url: string) => Promise<any>} fetcher - returns the parsed JSON page.
 * @returns {Promise<{ items: any[], total: number | null }>}
 */
export async function fetchAllBazaarItems(baseUrl, opts = {}, fetcher) {
  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 200;
  const items = [];
  let offset = 0;
  let total = null;
  for (let p = 0; p < maxPages; p++) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}limit=${pageSize}&offset=${offset}`;
    const page = await fetcher(url);
    const pageItems = page?.items || page?.resources || (Array.isArray(page) ? page : []);
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    for (const it of pageItems) items.push(it);
    total = page?.pagination?.total ?? total;
    offset += pageItems.length;
    if (total != null && offset >= total) break;
    if (pageItems.length < pageSize) break;
  }
  return { items, total };
}

/**
 * Heuristic: does this URL look like the Coinbase CDP Bazaar discovery endpoint?
 * Other registries we crawl don't paginate or use a different shape — single
 * fetch stays correct for them.
 */
export function isBazaarDiscoveryUrl(url) {
  if (typeof url !== "string") return false;
  return /\/x402\/discovery\/resources(?:\?|$|\/)/i.test(url) || /api\.cdp\.coinbase\.com/i.test(url);
}
