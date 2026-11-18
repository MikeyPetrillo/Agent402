// Every User-Agent this server sends to a host it does not run, one per
// component, so a seller reading its logs can tell our index crawler from our
// price probes, from a purchase our router makes for a paying caller, and from
// a fetch a caller of our catalog asked for. /crawler (src/crawler-page.js)
// renders this list, so the page cannot name a string we do not send, and
// scripts/test-user-agents.js checks that each component sends its own.
//
// Each keeps the browser-compatible form (`Mozilla/5.0 (compatible; ...)`)
// that hosts already accept, a product token of its own, and the link to the
// page that says who we are. None is the bare `Agent402/1.0`.

export const INFO_URL = "https://agent402.tools/crawler";
const compatible = (token) => `Mozilla/5.0 (compatible; ${token}/1.0; +${INFO_URL})`;

/** The index crawler: robots.txt, the x402 manifest, /openapi.json and the
 *  other discovery documents, plus the registries it reads seller lists from. */
export const CRAWLER_TOKEN = "Agent402-Crawler";
export const CRAWLER_UA = compatible(CRAWLER_TOKEN);
/** The unpaid probes: the paywall check, the price (quote) reads and the
 *  network re-checks the index sends to a seller's paid route. */
export const PROBE_TOKEN = "Agent402-Probe";
export const PROBE_UA = compatible(PROBE_TOKEN);
/** The router, inside a paying caller's call: the pre-payment probe and the
 *  purchase itself (src/x402-buyer.js, src/tempo-buyer.js, server.js). */
export const ROUTER_TOKEN = "Agent402-Router";
export const ROUTER_UA = compatible(ROUTER_TOKEN);
/** A tool in our catalog fetching a URL its caller named (one request for one
 *  caller, not a crawl). */
export const FETCH_TOKEN = "Agent402-Fetch";
export const FETCH_UA = compatible(FETCH_TOKEN);
/** The multi-page site-crawl tool, which honors robots.txt for this token. */
export const SITE_CRAWL_TOKEN = "Agent402Bot";
export const SITE_CRAWL_UA = `${SITE_CRAWL_TOKEN}/1.0 (+${INFO_URL})`;

/** The string we retired; no component sends it bare. */
export const RETIRED_BARE_UA = "Agent402/1.0";

/** The list /crawler renders: token, full string and what sends it. */
export const SELLER_FACING_USER_AGENTS = Object.freeze([
  { token: CRAWLER_TOKEN, ua: CRAWLER_UA, role: "crawler" },
  { token: PROBE_TOKEN, ua: PROBE_UA, role: "probe" },
  { token: ROUTER_TOKEN, ua: ROUTER_UA, role: "router" },
  { token: FETCH_TOKEN, ua: FETCH_UA, role: "fetch" },
  { token: SITE_CRAWL_TOKEN, ua: SITE_CRAWL_UA, role: "site-crawl" },
]);
