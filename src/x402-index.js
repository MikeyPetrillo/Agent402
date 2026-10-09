// x402 Index — the live aggregation layer for the agent payments economy.
//
// Two surfaces:
//   • GET  /index   — public HTML dashboard: every seller we've crawled, their
//                     tool count, network, and last-fetched time. Embeddable.
//   • POST /api/route — Smart Order Router. Given a task description, return the
//                     cheapest matching tool across all crawled sellers.
//
// Both are FREE (mounted outside the paywall) — discovery primitives shouldn't
// cost money, by the same logic as /api/find.
//
// How sellers get into the Index:
//   1. The local Agent402 catalog is always present (no network).
//   2. Optional seeds via X402_INDEX_SEEDS env (comma-separated origins) get
//      crawled every 30 minutes. Each crawl fetches /.well-known/x402 + the
//      seller's openapi.json (when present) and caches the result.
//
// Design notes:
//   • In-memory cache (Map), warm-started from /data at boot so a redeploy
//     never serves a half-crawled ecosystem (see INDEX_CACHE_FILE below).
//     A crawl warms it in <30s and the data is intentionally transient.
//   • All outbound HTTP goes through safeFetch (SSRF-guarded, byte-capped).
//   • Failed crawls log a stale marker; they never crash the process.
//   • The router uses the same lexical scoring shape as /api/find so rankings
//     are consistent whether a buyer searches local-only or cross-seller.
import { resolveLocalRefs } from "./openapi-deref.js";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { timedSync } from "./boot-timing.js";
import { esc } from "./ledger-chrome.js";
// F23: seller-manifest homepages are external, attacker-controlled URLs. esc()
// escapes HTML but does NOT constrain the scheme, so a `javascript:`/`data:`
// homepage would become a clickable link if the legacy indexPage renderer is
// ever re-enabled. Only http(s) becomes a link; anything else renders inert.
const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
import { safeFetch } from "./tools/fetch-guard.js";
import { readTextCapped } from "./capped-body.js";
import { parseRobots, robotsAllows } from "./tools/kit.js";
import { partialFields, clampFields } from "./partial-answer.js";
import { responseContractOf, packResponseContract, responseContractProjection } from "./response-contract.js";
import { deliveryProjection } from "./response-observation.js";
import { requestContractOf, requestContractFromInputSchema, packRequestContract, requestContractProjection, requestContractStrength } from "./request-contract.js";
import { toolList } from "./pages.js";
import { fetchAllBazaarItems, isBazaarDiscoveryUrl } from "./bazaar-pager.js";
import { RAILS, railKey } from "./rails.js";
import { CHAIN_PAGES, marketSellers } from "./market-page.js";
import { WELL_KNOWN_PATH, discoveryNote } from "./discovery-note.js";
import { judgeFreeResponse } from "./tool-judge.js";
import { acceptsFromLive402, quoteFromAccepts, probeMethodsFor, probeAttemptsFor, isQuoteResponse, joinSellerRoute } from "./x402-live-quote.js";
import { evmDomainsOfAccepts, EVM_TOKEN_DOMAINS } from "./evm-usdc-domain.js";
import { queryTerms, isCjkTerm, splitTokens } from "./query-terms.js";
import { summarize, fmtUsd, fmtPct } from "./economy.js";
import { rankBy, canonicalHost, getLeaderboardSnapshot, getLeaderboardCircularWallets } from "./leaderboard.js";
import { routeExecuteHint } from "./tools/route-execute.js";
import { recordSellerRegistrationSeen, getSellerRegistrations, deleteSellerRegistration, ensureSellerRegistrations } from "./stats.js";

import { REPO_URL } from "./repo-link.js";
// RAILS caip2 -> CHAIN_PAGES key, same join the homepage's by-chain strip uses
// (see ledger-home.js) so /index's own row derives the same way: page
// availability from CHAIN_PAGES, live seller counts from marketSellers() run
// against the snapshot this page already renders from — no new plumbing.
const CHAIN_PAGE_BY_CAIP2 = new Map(Object.entries(CHAIN_PAGES).map(([key, cfg]) => [cfg.caip2, key]));

// ?network=<key> matchers for the Sellers table filter chips — one per
// mainnet rail in rails.js, same "EVM = exact CAIP-2, else = namespace
// prefix excluding testnets" rule market-page.js's CHAIN_PAGES.isNetwork
// uses for stellar/algorand (solana gets the same treatment for consistency
// even though it has no market page yet). Keyed by railKey() so a future
// rail lights up a chip here with zero new code.
const NETWORK_MATCHERS = new Map(RAILS.map((r) => {
  const matches = r.chainId
    ? (n) => n === r.caip2
    : (n) => typeof n === "string" && n.startsWith(r.caip2.split(":")[0]) && !n.includes("test");
  return [railKey(r), { label: r.name.replace(/ Chain$/, ""), matches }];
}));

const LOCAL_SELLER = "self";
// Unsubstituted OpenAPI path templates: "/stock/{symbol}", "/v1/x/{arg}".
// TWO regexes on purpose: `.test()` on a /g regex is STATEFUL (it advances
// lastIndex and alternates true/false across calls), so the predicate is
// non-global and only the extraction is global.
const URL_TEMPLATE_RE = /\{[^}/]+\}|%7[Bb][^/]*?%7[Dd]|\/:[A-Za-z_][A-Za-z0-9_]*(?=\/|$)/;
const URL_TEMPLATE_RE_G = /\{([^}/]+)\}|%7[Bb](.*?)%7[Dd]|\/:([A-Za-z_][A-Za-z0-9_]*)(?=\/|$)/g;
// THREE dialects, not one. The brace form is what OpenAPI writes, but a seller
// documenting with Express-style ":domain", or a manifest that URL-encoded its
// own braces into "%7Bdomain%7D", produces a path that is just as uncallable and
// used to sail through. Reported 2026-08-30 by a seller whose row we published
// with two placeholder routes priced at $0.02: /api/v1/hosts/:domain answers 422
// forever, while /api/v1/hosts/allbirds.com?refresh=1 answers 402 as it should.
// He also noted the consequence we could not see - a prober that tries the
// documented path scores the SELLER as unpayable for a service that works.
//
// The colon form is anchored to a whole segment (/:name) so an ordinary path
// containing a colon, or a scheme, is not mistaken for a template.
const SELF_BAZAAR_ORIGIN = "https://agent402.tools"; // the origin our Bazaar listing is keyed under
// /index used to render every crawled seller server-side (~1,477 rows → a
// 475KB response with no compression). Cap the default render to the top N
// by whatever metric the page is currently sorted on; ?all=1 opts back into
// the full table. The local seller is exempt from the cap — it's always the
// one row a self-hoster actually cares about finding.
const INDEX_ROW_CAP = 100;
// One full re-probe of every known origin per cycle, so this constant is the
// single biggest lever on our outbound footprint - it multiplies the seed
// count, not adds to it. Measured 2026-08-23 over 25 live seller origins: a
// revalidating cycle moves ~45.6 KB per document fetched, and 2/3 of sellers
// send a validator but only 38% of those actually answer 304, so conditional
// requests save ~15% and NOT the order of magnitude an earlier comment here
// claimed. At 5 minutes that was ~11.3 GB/day of third-party bandwidth at a
// 500-origin submission cap - which is what a seller noticed and reported
// (#886). 30 minutes cuts it 6x for a staleness cost nobody can act on faster
// than that anyway (a seller who fixes their manifest waits half an hour to
// see it, versus five minutes, and the churn signals downstream all read in
// days). Raise the interval BEFORE raising any seed cap: the cap is linear,
// this is the multiplier.
// 30 min crawl, 1 hr discovery: defined in src/crawl-cadence.js so the pages
// that quote the cadence read the same constants without importing this file.
import { CRAWL_INTERVAL_MS, DISCOVERY_INTERVAL_MS } from "./crawl-cadence.js";
import { routeTiebreakLabels } from "./route-order.js";

// A seller manifest is third-party JSON: `capabilities.tools` may be a number
// or anything else (a string reached a marketplace attribute unescaped, review
// 2026-08-28). Only a non-negative integer counts; everything else is 0.
function manifestToolCount(manifest) {
  const n = Number(manifest?.capabilities?.tools);
  return Number.isInteger(n) && n >= 0 && n < 1_000_000 ? n : 0;
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_OPENAPI_BYTES = 12 * 1024 * 1024; // Agent402's own is ~5 MB; allow headroom
const MAX_DISCOVERY_BYTES = 64 * 1024 * 1024;
// Effectively uncapped for any realistic registry — kept as a sanity guard so a
// malicious registry can't OOM us. Real politeness comes from CRAWL_CONCURRENCY.
const MAX_DISCOVERED_SELLERS = 50000;
const CRAWL_CONCURRENCY = 25; // max parallel seller crawls per cycle — caps outbound fan-out
const HEALTH_WINDOW = 5; // last N crawl outcomes per seller — drives health-aware routing

// Map<originUrl, { manifest, openapi, tools, fetchedAt, error? }>
// Every mutation is observed by the route candidate index (see routeIdx,
// beside routeQuery): a set enqueues the new entry and marks the replaced
// one stale, a delete marks stale, a clear resets. Entries are replaced,
// never mutated, so identity is the whole invalidation rule here as it is
// for the per-entry memos.
// REMOVED ORIGINS (operator lever, see removeOrigin below). Declared ahead of
// the stores it guards so every write path can consult it: the cache, both
// seed sets and the Bazaar maps refuse a removed origin at the write itself,
// which covers every discovery source at once instead of one check per source.
const removedOrigins = new Map(); // origin key -> { origin, removedAt, note }

// ---------------------------------------------------------------------------
// PATH-SCOPED SELLERS (2026-10-01). A seller hosted under a path prefix on a
// shared host (`https://host/app/<name>`, whose /.well-known/x402 and
// /openapi.json answer under that prefix while the host root 404s) is its own
// seller. Its KEY is the origin plus the normalised prefix; a bare origin's key
// is the origin exactly as before, so nothing about an existing seller changes.
//
// The invariants:
//   * every discovery document is read UNDER the prefix (key + path), and a
//     document a redirect served from outside the prefix is not the seller's;
//   * a path seller's routes are stored RELATIVE to its prefix, so the callable
//     URL stays `seller + route` everywhere it is built;
//   * a manifest or OpenAPI row that names a route outside the prefix is
//     dropped, never attributed - otherwise one app on a shared host could
//     claim another app's routes;
//   * robots.txt stays per HOST, read at the root, and its rules are matched
//     against the full path on that host.
// ---------------------------------------------------------------------------
export const SELLER_PREFIX_MAX_CHARS = 200;
export const SELLER_PREFIX_MAX_SEGMENTS = 8;
const SELLER_PREFIX_SEGMENT_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;

/**
 * Normalise a submitted seller URL into a key. Lowercased scheme and host, a
 * non-default port carried, the path case preserved and its trailing slash
 * dropped. Refused: query, fragment, credentials, any percent-encoding (one
 * prefix, one spelling), dot segments, empty segments, and a prefix over
 * SELLER_PREFIX_MAX_CHARS or SELLER_PREFIX_MAX_SEGMENTS. Returns
 * { key, origin, prefix } or { error }.
 */
export function normalizeSellerKey(raw, { protocols = ["https:"] } = {}) {
  const str = String(raw || "").trim();
  let u;
  try { u = new URL(str); } catch { return { error: "origin must be a valid URL" }; }
  if (!protocols.includes(u.protocol)) return { error: "origin must be https" };
  if (u.username || u.password) return { error: "origin must not contain credentials" };
  if (u.search || u.hash || /[?#]/.test(str)) return { error: "submit the origin, optionally with a path prefix, but no query or fragment" };
  const origin = `${u.protocol}//${u.host.toLowerCase()}`;
  // WHATWG URL resolves "." and ".." before we see the path, so the raw text is
  // checked: a prefix that only means something after resolution is refused.
  const rawPath = str.slice(str.indexOf(u.host) + u.host.length).replace(/^:\d+/, "");
  if (/%/.test(rawPath)) return { error: "the path prefix must not be percent-encoded" };
  if (/(^|\/)\.{1,2}(\/|$)/.test(rawPath) || /\\/.test(rawPath)) return { error: "the path prefix must not contain dot segments" };
  let prefix = u.pathname.replace(/\/+$/, "");
  if (prefix === "") return { key: origin, origin, prefix: "" };
  if (prefix.length > SELLER_PREFIX_MAX_CHARS) return { error: `the path prefix is longer than ${SELLER_PREFIX_MAX_CHARS} characters` };
  const segments = prefix.slice(1).split("/");
  if (segments.length > SELLER_PREFIX_MAX_SEGMENTS) return { error: `the path prefix has more than ${SELLER_PREFIX_MAX_SEGMENTS} segments` };
  if (segments.some((s) => !s || !SELLER_PREFIX_SEGMENT_RE.test(s))) return { error: "the path prefix has an empty or unsupported segment" };
  return { key: `${origin}${prefix}`, origin, prefix };
}

/** { origin, prefix } of a stored seller key; prefix is "" for a bare origin.
 *  Keys are normalised on the way in, so this is a split, not a parse. */
export function sellerKeyParts(key) {
  const s = String(key || "");
  const scheme = s.indexOf("://");
  const slash = scheme >= 0 ? s.indexOf("/", scheme + 3) : -1;
  if (slash < 0) return { origin: s, prefix: "" };
  const prefix = s.slice(slash).replace(/\/+$/, "");
  return { origin: s.slice(0, slash), prefix: prefix === "/" ? "" : prefix };
}
export const sellerPrefixOf = (key) => sellerKeyParts(key).prefix;
export const sellerHostRootOf = (key) => sellerKeyParts(key).origin;

/** The absolute URL of a seller's route, or null when the joined text would
 *  leave the seller (a route like "@other.host/x" or "//other.host" read as an
 *  authority, or a path outside a path seller's prefix). Every probe that joins
 *  seller + route text builds its URL here, so a crawled route can never aim a
 *  fetch at a different host than the seller it was listed under. */
export function sellerRouteUrl(key, route) {
  const r = String(route || "");
  if (!r.startsWith("/") || r.startsWith("//")) return null;
  let u;
  try { u = new URL(joinSellerRoute(key, r)); } catch { return null; }
  if (u.username || u.password) return null;
  return isUnderSeller(u.href, key) ? u.href : null;
}

/** Is this absolute URL served by the seller - same scheme+host+port and, for a
 *  path seller, at or under its prefix (a segment boundary, never a substring:
 *  /app/x does not own /app/x2)? */
export function isUnderSeller(url, key) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  const { origin, prefix } = sellerKeyParts(key);
  if (`${u.protocol}//${u.host.toLowerCase()}` !== origin.toLowerCase()) return false;
  if (!prefix) return true;
  return u.pathname === prefix || u.pathname.startsWith(`${prefix}/`);
}

/** A host-absolute path, as a route of this seller: unchanged for a bare
 *  origin; for a path seller, relative to the prefix, or null when it lies
 *  outside it. */
export function scopeRouteToSeller(key, hostPath) {
  const prefix = sellerPrefixOf(key);
  const p = String(hostPath ?? "");
  if (!prefix) return p;
  const [path, query] = [p.split("?")[0], p.includes("?") ? p.slice(p.indexOf("?")) : ""];
  if (path === prefix) return `/${query}`;
  if (!path.startsWith(`${prefix}/`)) return null;
  return path.slice(prefix.length) + query;
}

/** Scope parsed rows to their seller: routes made prefix-relative, rows
 *  outside the prefix dropped. A no-op for a bare origin, so every existing
 *  seller's rows are returned untouched.
 *
 *  The prefix ROOT ("/" or "/?q=1") is kept only when the row declares payment
 *  (a price, or accepts that named a chain). The root of a path seller is
 *  usually its landing page or the function's own index, and an unpriced row
 *  there is not a tool; but a function host often serves ONE paid endpoint at
 *  its own path (GET <prefix>?package=react answers 402), and dropping that row
 *  left the seller listed with no route, no chains and nothing to probe. */
export function rowDeclaresPayment(r) {
  return priceToMicroUsd(r?.price) > 0 || (Array.isArray(r?.networks) && r.networks.length > 0) || r?.paid === true;
}
// Rows already made prefix-relative (a Bazaar row converted in
// bazaarItemToTool, which a single-resource manifest reuses) carry this mark,
// so a second pass cannot read their relative route as host-absolute and drop
// it. A Symbol, so it never reaches JSON or the persisted cache.
const SCOPED_ROW = Symbol("scopedToSeller");
export function scopeRowsToSeller(rows, key) {
  if (!sellerPrefixOf(key) || !Array.isArray(rows)) return rows;
  const out = [];
  for (const r of rows) {
    if (!r || typeof r.route !== "string") continue;
    if (r[SCOPED_ROW]) { out.push(r); continue; }
    const route = scopeRouteToSeller(key, r.route);
    if (route == null) continue;
    if ((route === "/" || route.startsWith("/?")) && !rowDeclaresPayment(r)) continue;
    out.push({ ...r, route, [SCOPED_ROW]: true });
  }
  return out;
}

/** host origin -> path-seller keys on it (longest prefix first), from every
 *  seed and cache key that carries a prefix. Built once per discovery pass. */
function pathSellersByHost() {
  const out = new Map();
  const add = (k) => {
    if (typeof k !== "string" || !sellerPrefixOf(k)) return;
    const o = sellerHostRootOf(k);
    const list = out.get(o) || [];
    if (!list.includes(k)) list.push(k);
    out.set(o, list);
  };
  for (const k of submittedSeeds) add(k);
  for (const k of discoveredSeeds) add(k);
  for (const k of cache.keys()) add(k);
  for (const list of out.values()) list.sort((a, b) => b.length - a.length);
  return out;
}
/** The path seller whose prefix covers this URL, else null. */
function pathSellerOwning(url, hostOrigin, byHost) {
  const list = byHost.get(hostOrigin);
  if (!list) return null;
  for (const k of list) if (isUnderSeller(url, k)) return k;
  return null;
}

function removalKeyOf(raw) {
  const n = normalizeSellerKey(raw, { protocols: ["http:", "https:"] });
  if (!n.error) return n.key;
  // Anything that is not a seller key (a URL with a query, say) still keys on
  // its host, as it always did.
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch { return null; }
}
/** Has the operator removed this origin from the index? Exact origin (scheme +
 *  host + port); a removed bare origin also covers every path seller on it. */
export function isRemovedOrigin(origin) {
  if (removedOrigins.size === 0) return false;
  const k = removalKeyOf(origin);
  if (!k) return false;
  return removedOrigins.has(k) || removedOrigins.has(sellerHostRootOf(k));
}
class GuardedSet extends Set {
  add(v) { return isRemovedOrigin(v) ? this : super.add(v); }
}
class GuardedMap extends Map {
  set(k, v) { return isRemovedOrigin(k) ? this : super.set(k, v); }
}

// Bumped on every cache mutation, so per-query derivations of the whole cache
// (the alias set, a scored ranking) can be memoized exactly: entries are
// replaced, never mutated, so an unchanged version means an unchanged cache.
let cacheVersion = 0;
/** Changes whenever the crawl cache does; readers memoize derived views on it. */
export function indexCacheVersion() { return cacheVersion; }
class IndexCache extends Map {
  set(origin, v) {
    if (isRemovedOrigin(origin)) { this.delete(origin); return this; }
    cacheVersion++;
    routeIndexNoteSet(origin, super.get(origin), v); return super.set(origin, v);
  }
  delete(origin) { if (super.has(origin)) { cacheVersion++; routeIndexNoteSet(origin, super.get(origin), null); } return super.delete(origin); }
  clear() { cacheVersion++; super.clear(); routeIndexReset(); }
}
const cache = new IndexCache();
// Set of origins auto-discovered from public x402 registries (distinct from
// the env-configured seed list so we can show provenance separately on /index).
const discoveredSeeds = new GuardedSet();

// --- self-serve listing (POST /api/index/register) ---------------------------
// Origins submitted through the public register endpoint. Persisted to /data
// so a submission survives redeploys; silent in-memory fallback without the
// volume (same posture as stats). All probing goes through crawlSeller() —
// this module never fetches a submitted origin directly.
export const SUBMITTED_SEEDS_FILE = "/data/submitted-seeds.json";
const submittedSeeds = new GuardedSet();

// Manual-submission ceiling — a fetch-amplifier guard: every successful probe
// is re-crawled on every cycle forever, so unbounded submissions become
// unbounded outbound fan-out + unbounded /data growth (independent of
// MAX_DISCOVERED_SELLERS, which only guards the registry-discovery path).
// Legitimate growth beyond this goes through DEFAULT_SEEDS or Bazaar discovery.
//
// Sized from MEASURED bytes, not a feeling (25 live seller origins, 2026-08-23):
// a revalidating cycle moves ~45.6 KB per document fetched and ~1.9 documents
// per origin, so one origin costs ~3.8 MB/day at the 30-minute cadence. The
// old pairing (5-minute cadence, cap 500) put our whole crawl set at roughly
// 52 GB/day of other people's bandwidth; the cadence change alone takes that
// to ~8.7 GB/day, and this ceiling adds at most ~5.8 GB/day if every new slot
// ever fills. Net: a 4x larger front door at a third of the old footprint.
//
// The ceiling is NOT a quality gate, and it is no longer a lifetime bucket.
// Three separate bounds do three separate jobs, and conflating them is what
// made the front door fill once and stay full:
//
//   * the register route's rate caps (5/hour/IP, 30/hour global) stop one
//     actor consuming the whole door in a burst - the fairness bound;
//   * this ceiling bounds steady-state outbound cost against the byte budget
//     above - the money bound;
//   * selectReleasableOrigins gives a slot back after 30 days with no
//     successful probe - the continuity bound, so the queue moves forward.
//
// A release is not a deletion: the seller_registrations row survives, so the
// provenance saying a seller came to us through /sell outlives the listing,
// and a seller who comes back re-registers into a free slot. An origin that
// has ever settled a payment is never released, however long it has been down.
// If this fills with LIVE sellers, raise CRAWL_INTERVAL_MS first (it is the
// multiplier), then this (it is linear).
const DEFAULT_MAX_SUBMITTED_SEEDS = 2000;
let submittedSeedsCap = DEFAULT_MAX_SUBMITTED_SEEDS;

/** Test hook: set (or, with no arg, reset) the submission cap. */
export function __testSetSubmittedCap(n) {
  submittedSeedsCap = typeof n === "number" && n >= 0 ? n : DEFAULT_MAX_SUBMITTED_SEEDS;
}

export function loadSubmittedSeeds() {
  try {
    const arr = JSON.parse(readFileSync(SUBMITTED_SEEDS_FILE, "utf8"));
    // Respect the cap even if the file was hand-edited or corrupted into
    // something oversized — the ceiling has to hold on load, not just on write.
    for (const o of Array.isArray(arr) ? arr : []) {
      if (submittedSeeds.size >= submittedSeedsCap) break;
      if (typeof o === "string") { submittedSeeds.add(o); discoveredSeeds.add(o); }
    }
  } catch { /* absent file / no volume — in-memory only */ }
}

function persistSubmittedSeeds() {
  try {
    writeFileSync(SUBMITTED_SEEDS_FILE, JSON.stringify([...submittedSeeds], null, 2));
  } catch { /* best-effort — no volume in local/dev */ }
}

// ---------------------------------------------------------------------------
// SUCCESSION: an origin that has been replaced by another.
//
// Verifying a succession used to do exactly one thing - carry the old origin's
// first-seen date onto the new one so a migrating seller kept its registration
// tenure - and nothing else. The predecessor stayed in the index as a full
// routable seller, so a seller who migrated correctly ended up listed TWICE
// with identical slugs. Reported 2026-09-13 by the first seller to use the
// feature, who noticed their own duplicate before we did. Carrying a duplicate
// seller is the registry inflation we decline to do and collapse when other
// people's listings do it, so it is not something to leave in ours.
//
// A superseded origin joins the same alias set that already hides redirect and
// deployment-hostname duplicates, which is what excludes it from the index
// listing, the router's external pool and route queries in one move rather
// than four. It stays resolvable by direct lookup and says where it went: an
// old link should answer, not 404.
export const SUCCESSIONS_FILE = "/data/origin-successions.json";
const SUCCESSIONS_MAX = 2_000;
const SUCCESSION_MAX_CHAIN = 16;
const successions = new Map(); // old origin -> { to: new origin, at: recordedAt }

export function loadSuccessions() {
  try {
    const obj = JSON.parse(readFileSync(SUCCESSIONS_FILE, "utf8"));
    for (const [oldO, newO] of Object.entries(obj || {})) {
      if (successions.size >= SUCCESSIONS_MAX) break; // the ceiling holds on load, not only on write
      // Two shapes: the bare string this file wrote before re-verification
      // existed, and the record it writes now. An old file loads with at=0,
      // which makes every legacy entry due for re-verification immediately -
      // the safe direction, since an entry that no longer holds should stop
      // hiding a seller as soon as we can tell.
      if (typeof oldO !== "string") continue;
      if (typeof newO === "string") successions.set(oldO, { to: newO, at: 0 });
      else if (newO && typeof newO.to === "string") successions.set(oldO, { to: newO.to, at: Number(newO.at) || 0 });
    }
  } catch { /* absent file / no volume - in-memory only */ }
}

function persistSuccessions() {
  // tmp+rename like the other durable stores: a deploy is a SIGTERM, and a
  // truncated file here reads as "no successions", silently restoring every
  // duplicate this exists to hide.
  try {
    const tmp = `${SUCCESSIONS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(successions), null, 2));
    renameSync(tmp, SUCCESSIONS_FILE);
  } catch { /* best-effort - no volume in local/dev */ }
}

// What decides that a listed route exists. A seller's listing is merged from
// their own documents (well-known manifest, OpenAPI, agents.json, llms.txt),
// registry rows (minted by any past settled payment and never retired
// upstream) and what earlier live 402s taught us. The merge only adds, so
// before this a route the seller removed stayed listed through the registry
// row, and re-registering could not clear it. The rule now:
//   - a route the seller's own documents declare is listed (row.declared);
//   - any other route must answer a live 402 (or be observed free) at least
//     every LIVE_PROOF_MAX_AGE_MS, and is dropped when its own verb answers
//     404, 405 or 410;
//   - a 410 on the row's own verb drops even a declared route: the seller is
//     saying it is gone.
// A 404/405 must be seen twice, at least MISS_CONFIRM_MS apart, before the
// route is dropped: one reading taken mid-deploy is not a retirement. A
// seller who re-registers clears every mark on their origin.
// A dropped route is remembered so the next crawl's merge cannot restore it.
// A "miss" mark hides only undeclared rows, so a route the seller declares
// again is listed again at once; a "410" mark hides the route either way. Both
// lapse after GONE_ROUTE_TTL_MS, and the route is probed afresh.
export const GONE_ROUTES_FILE = "/data/x402-gone-routes.json";
export const GONE_ROUTE_TTL_MS = 30 * 24 * 3600 * 1000;
const GONE_ROUTES_MAX = 20_000;
const goneRoutes = new Map(); // "origin METHOD /route" -> { at, kind: "410" | "miss" | "pending" }
export const MISS_CONFIRM_MS = 3600 * 1000;
export const LIVE_PROOF_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const goneKey = (origin, method, route) => `${origin} ${String(method || "GET").toUpperCase()} ${route}`;

export function loadGoneRoutes() {
  try {
    const obj = JSON.parse(readFileSync(GONE_ROUTES_FILE, "utf8"));
    for (const [k, v] of Object.entries(obj || {})) {
      if (goneRoutes.size >= GONE_ROUTES_MAX) break;
      if (typeof k === "string" && v && Number(v.at) > 0) goneRoutes.set(k, { at: Number(v.at), kind: ["410", "miss", "pending"].includes(v.kind) ? v.kind : "miss" });
    }
  } catch { /* absent file / no volume - in-memory only */ }
}

function persistGoneRoutes() {
  try {
    const tmp = `${GONE_ROUTES_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(goneRoutes)));
    renameSync(tmp, GONE_ROUTES_FILE);
  } catch { /* best-effort - no volume in local/dev */ }
}

export function markRouteGone(origin, method, route, { at = Date.now(), kind = "410" } = {}) {
  const k = goneKey(origin, method, route);
  goneRoutes.delete(k);
  while (goneRoutes.size >= GONE_ROUTES_MAX) goneRoutes.delete(goneRoutes.keys().next().value);
  goneRoutes.set(k, { at, kind: ["410", "miss", "pending"].includes(kind) ? kind : "miss" });
  persistGoneRoutes();
}

function clearGoneMark(origin, method, route) {
  if (goneRoutes.delete(goneKey(origin, method, route))) persistGoneRoutes();
}

/** Clear every mark on an origin (a re-registration). Returns how many. */
export function clearGoneMarks(origin) {
  const prefix = `${origin} `;
  let n = 0;
  for (const k of [...goneRoutes.keys()]) if (k.startsWith(prefix)) { goneRoutes.delete(k); n++; }
  if (n) persistGoneRoutes();
  return n;
}

/** The live mark for a route, or null. Expired marks are removed. */
export function goneMark(origin, method, route, now = Date.now()) {
  const k = goneKey(origin, method, route);
  const m = goneRoutes.get(k);
  if (!m) return null;
  if (now - m.at > GONE_ROUTE_TTL_MS) { goneRoutes.delete(k); return null; }
  return m;
}
export function isRouteGone(origin, method, route, now = Date.now()) {
  const m = goneMark(origin, method, route, now);
  return m != null && m.kind !== "pending";
}

// Removes rows marked gone from `tools` IN PLACE (callers read the array they
// passed). A "miss" mark hides only a row the seller does not declare.
// Returns how many were removed.
export function dropGoneRoutes(tools, origin, now = Date.now()) {
  if (!Array.isArray(tools) || !goneRoutes.size) return 0;
  let n = 0;
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (!t || typeof t.route !== "string") continue;
    const m = goneMark(origin, t.method, t.route, now);
    if (m && (m.kind === "410" || (m.kind === "miss" && t.declared === false))) { tools.splice(i, 1); n++; }
  }
  return n;
}

const pathOf = (r) => String(r || "").split("?")[0];
const SOURCE_LABELS = { bazaar: "registry", manifest: "manifest" };
export function listingBasisProjection(t) {
  const at = liveProofAt(t);
  return {
    ...(typeof t?.declared === "boolean" ? { declared: t.declared } : {}),
    ...(t?.provenance ? { source: SOURCE_LABELS[t.provenance] || t.provenance } : {}),
    ...(at > 0 ? { lastVerifiedAt: new Date(at).toISOString() } : {}),
  };
}
/** Stamp `declared` on every row: true when the seller's own documents name
 *  the route (exact path, or an OpenAPI template it instantiates, or the same
 *  template), false otherwise. `declaredRoutes` is any list of { route }. */
export function stampDeclared(tools, declaredRoutes = []) {
  if (!Array.isArray(tools)) return tools;
  const exact = new Set();
  const templates = [];
  for (const d of declaredRoutes || []) {
    const r = pathOf(d?.route);
    if (!r) continue;
    exact.add(r);
    if (r.includes("{")) templates.push(r);
  }
  for (const t of tools) {
    if (!t || typeof t.route !== "string") continue;
    const r = pathOf(t.route);
    t.declared = exact.has(r) || templates.some((tpl) => routeMatchesTemplate(tpl, r));
  }
  return tools;
}

/** When a row last proved it is for sale by answering us: a live 402, a
 *  live-verified chain list, or an observed free answer. 0 when never. */
export function liveProofAt(t) {
  const learnedAt = (t?.quoteSource === "live-402" || t?.quoteSource === "live-200") ? Number(t?.quoteObservedAt) || 0 : 0;
  return Math.max(Number(t?.liveProvenAt) || 0, Number(t?.networksVerifiedAt) || 0, Number(t?.freeObservedAt) || 0, learnedAt);
}
/** An undeclared row whose last live proof is older than the window. */
export function needsLiveProof(t, now = Date.now()) {
  return t?.declared === false && now - liveProofAt(t) > LIVE_PROOF_MAX_AGE_MS;
}

export function _resetGoneRoutes() { goneRoutes.clear(); }

/**
 * Record a VERIFIED succession. Refuses the two shapes that would hide a
 * seller entirely rather than deduplicate one:
 *  - self-succession, and
 *  - a cycle (B already succeeded by A, so recording A->B would hide both).
 */
export function recordSuccession(oldOrigin, newOrigin) {
  const a = String(oldOrigin || ""), b = String(newOrigin || "");
  if (!a || !b) return false;
  if (isRemovedOrigin(a) || isRemovedOrigin(b)) return false;
  // Walk the chain from the claimant: if it leads back to the predecessor,
  // this would close a loop and both origins would drop out of every listing.
  // The walk starts AT the claimant, so hop zero is the self-succession case
  // (A succeeds A) - one check, not two, and a separate `a === b` guard above
  // would be dead code that no mutation can kill.
  let cur = b, hops = 0;
  while (cur) {
    if (sameOrigin(cur, a)) return false;
    // A chain we ran out of budget to walk is a chain we did not verify, and
    // an unverified cycle check must refuse rather than fall through: every
    // origin in a closed loop passes "successor present and healthy" and they
    // would all be hidden, which is the exact outcome this guard prevents.
    if (++hops >= SUCCESSION_MAX_CHAIN) return false;
    cur = successions.get(cur)?.to;
  }
  // Bounded like the submitted-seed store it sits beside: this map is fed by
  // the same unauthenticated endpoint, persists to the same shared volume, and
  // has no eviction of its own.
  if (!successions.has(a) && successions.size >= SUCCESSIONS_MAX) return false;
  successions.set(a, { to: b, at: Date.now() });
  persistSuccessions();
  return true;
}

/** The origin that replaced this one, or null. */
export function succeededBy(origin) {
  return successions.get(String(origin || ""))?.to || null;
}

/**
 * Forget a succession, so the predecessor is listed again.
 *
 * Retirement used to be write-once with no delete anywhere in this file, which
 * made a wrong one permanent: the obvious self-serve remedy (register the old
 * origin naming the new one as `replaces`) is refused by the cycle guard, so
 * the only lever was hand-editing the volume. Two levers exist now - this, for
 * an operator, and reverifySuccessions below, which is the seller's own.
 */
export function revokeSuccession(oldOrigin) {
  const key = String(oldOrigin || "");
  if (!successions.delete(key)) return false;
  persistSuccessions();
  return true;
}

/** Every recorded succession, for an operator surface. Counts and origins only. */
export function listSuccessions() {
  return [...successions.entries()].map(([from, r]) => ({ from, to: r.to, recordedAt: r.at || null }));
}

// ---------------------------------------------------------------------------
// REMOVAL: an operator lever that takes ONE origin out of the index and the
// router for good. Every other exit from the index is automatic and reversible
// by the seller (a release after 30 dark days, a succession the marker backs);
// this one is deliberate, keyed on an exact origin, persisted, and consulted
// at every write path (see GuardedSet / GuardedMap / IndexCache above), so no
// registry, Bazaar row, warm start or re-crawl can bring the origin back.
// Undo is restoreOrigin, which only lifts the block: the owner re-registers.
export const REMOVED_ORIGINS_FILE = "/data/removed-origins.json";
export const REMOVED_ORIGIN_ERROR = "origin removed at the owner's request";
const REMOVED_ORIGINS_MAX = 5_000;
const removedFile = () => process.env.REMOVED_ORIGINS_FILE || REMOVED_ORIGINS_FILE;

/**
 * Strict form for the operator route: a bare http(s) origin, nothing else.
 * No name matching, no wildcards, no path. Returns the key or null.
 */
export function strictOriginKey(raw) {
  const str = String(raw || "").trim();
  if (!str || str.length > 300 || /[*\s]/.test(str)) return null;
  let u;
  try { u = new URL(str); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.search || u.hash) return null;
  if (!u.hostname.includes(".")) return null;
  // A path seller is removed by its exact key; a bare origin as before.
  if (u.pathname && u.pathname !== "/") {
    const n = normalizeSellerKey(str, { protocols: ["http:", "https:"] });
    return n.error ? null : n.key;
  }
  return `${u.protocol}//${u.host.toLowerCase()}`;
}

export function loadRemovedOrigins() {
  try {
    const arr = JSON.parse(readFileSync(removedFile(), "utf8"));
    for (const r of Array.isArray(arr) ? arr : []) {
      if (removedOrigins.size >= REMOVED_ORIGINS_MAX) break;
      const k = strictOriginKey(r?.origin);
      if (!k) continue;
      removedOrigins.set(k, { origin: k, removedAt: Number(r.removedAt) || 0, note: typeof r.note === "string" ? r.note.slice(0, 500) : "" });
    }
  } catch { /* absent file / no volume - in-memory only */ }
  // A removal loaded after the stores were filled (a hand edit, a test) must
  // still take effect: purge whatever is already held.
  for (const k of removedOrigins.keys()) purgeOrigin(k);
  return removedOrigins.size;
}

function persistRemovedOrigins() {
  // tmp+rename: a truncated file here reads as "nothing removed", which would
  // quietly bring every removed origin back on the next boot.
  try {
    const f = removedFile();
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify([...removedOrigins.values()], null, 2));
    renameSync(tmp, f);
  } catch { /* best-effort - no volume in local/dev */ }
}

// Drop every piece of state keyed on this origin. Returns what was held.
function purgeOrigin(key) {
  const held = { cache: false, submitted: false, discovered: false, successions: 0 };
  // A bare-origin key also purges every path seller on that host.
  const match = (o) => { const k = removalKeyOf(o); return k === key || (!sellerPrefixOf(key) && k != null && sellerHostRootOf(k) === key); };
  for (const o of [...submittedSeeds]) if (match(o)) { submittedSeeds.delete(o); held.submitted = true; }
  for (const o of [...discoveredSeeds]) if (match(o)) { discoveredSeeds.delete(o); held.discovered = true; }
  for (const o of [...cache.keys()]) if (match(o)) { cache.delete(o); held.cache = true; }
  for (const o of [...bazaarToolsByOrigin.keys()]) if (match(o)) bazaarToolsByOrigin.delete(o);
  for (const o of [...bazaarQualityByOrigin.keys()]) if (match(o)) bazaarQualityByOrigin.delete(o);
  for (const [from, r] of [...successions]) if (match(from) || match(r.to)) { successions.delete(from); held.successions++; }
  for (const o of [...successionScanAt.keys()]) if (match(o)) successionScanAt.delete(o);
  for (const k of [...forcedCrawlAt.keys()]) if (match(k)) forcedCrawlAt.delete(k);
  try { clearOriginProbeState(key); } catch { /* best-effort */ }
  try { deleteSellerRegistration(key); } catch { /* best-effort */ }
  return held;
}

/**
 * Remove one origin from the index and the router, permanently.
 * Returns { removed, origin, removedAt, held } or { error }.
 */
export function removeOrigin(raw, { note = "" } = {}) {
  const key = strictOriginKey(raw);
  if (!key) return { error: "pass an exact origin such as https://seller.example (scheme and host, optional port and path prefix, no query, no wildcard)" };
  if (!removedOrigins.has(key) && removedOrigins.size >= REMOVED_ORIGINS_MAX) return { error: `removed list is full (${REMOVED_ORIGINS_MAX})` };
  const rec = removedOrigins.get(key) || { origin: key, removedAt: Date.now(), note: String(note || "").slice(0, 500) };
  removedOrigins.set(key, rec);
  persistRemovedOrigins();
  const held = purgeOrigin(key);
  persistSubmittedSeeds();
  if (held.successions) persistSuccessions();
  console.log(`[x402-index] origin removed by operator: ${key}`);
  return { removed: true, origin: key, removedAt: rec.removedAt, held };
}

/** Lift a removal. Seeds are NOT re-added; the owner can register again. */
export function restoreOrigin(raw) {
  const key = strictOriginKey(raw);
  if (!key) return { error: "pass an exact origin" };
  if (!removedOrigins.delete(key)) return { restored: false, origin: key };
  persistRemovedOrigins();
  return { restored: true, origin: key };
}

/** Every removed origin, newest first, for the operator surface. */
export function listRemovedOrigins() {
  return [...removedOrigins.values()].sort((a, b) => (b.removedAt || 0) - (a.removedAt || 0));
}

/**
 * Re-read the markers behind recorded successions and drop the ones that no
 * longer hold.
 *
 * THE PROOF IS A FACT ABOUT NOW, NOT A FACT ABOUT ONCE. Checked only at record
 * time, a retirement outlives the thing that justified it: a seller who takes
 * the marker down, or a domain that changes hands, stays retired forever. This
 * makes removing the marker the predecessor's own undo, and it means a
 * momentary takeover of a dangling PaaS hostname - exactly the `*.workers.dev`
 * shape this feature was built for - can no longer retire a listing
 * permanently, because the legitimate owner's recovery removes the marker and
 * the next pass restores them.
 *
 * Bounded per call and only for entries past `maxAgeMs`, so it costs at most a
 * handful of requests a cycle. A marker we could not READ changes nothing: an
 * origin that is merely down must not be un-retired by its own outage.
 */
export async function reverifySuccessions({ now = Date.now(), maxAgeMs = 24 * 3600_000, limit = 5, verify = verifySuccessionMarkers } = {}) {
  const due = [...successions.entries()].filter(([, r]) => now - (r.at || 0) >= maxAgeMs).slice(0, limit);
  let dropped = 0;
  for (const [from, r] of due) {
    let res = null;
    try { res = await verify(r.to, from); } catch { res = null; }
    if (res && res.ok === false && res.reason) {
      // A definite NO from a readable pair of origins: the claim no longer
      // holds, so stop hiding the predecessor.
      successions.delete(from);
      dropped++;
    } else if (res?.ok) {
      successions.set(from, { to: r.to, at: now });
    }
    // res === null means unreadable. Leave it exactly as it was and try again
    // next pass: an outage is not evidence either way.
  }
  if (dropped) persistSuccessions();
  return { checked: due.length, dropped };
}

// When was each origin last probed for a succession marker it never told us
// about? Discovery is bounded per cycle and rotates oldest-first.
const successionScanAt = new Map();

/**
 * Find successions nobody registered, from the markers themselves.
 *
 * Retirement was wired to the REGISTER call: `replaces` had to ride on a
 * /api/index/register request for the pair to be recorded. That is correct for
 * anyone migrating after the feature existed and leaves everyone who migrated
 * BEFORE it permanently un-recorded - their old origin never names its
 * successor, so an old link answers as a live seller pointing nowhere. The
 * first seller to use the feature is exactly such a case: their register
 * returned `succession: {ok:true, via:"cross-served markers"}` on the day the
 * proof existed and the recording did not, and nothing in the store remembers
 * the pair (the predecessor is used transiently to backdate first_seen and is
 * never persisted), so there is nothing to backfill FROM.
 *
 * The markers themselves are the record. The new origin's own marker names its
 * predecessor, so a succession is discoverable by reading one document from an
 * origin we already crawl - no seller action, no re-registration, no operator
 * lever that could retire a listing without proof.
 *
 * THE PROOF IS UNCHANGED. This only finds CANDIDATES; `verify` is the same
 * cross-served check the register path runs, so retirement still requires
 * serving a document on the OLD origin, which is control of it. A marker that
 * names a predecessor we have never heard of is skipped rather than trusted.
 *
 * Scoped to self-registered origins: they are the population this feature is
 * for, and it keeps the scan off thousands of discovered origins that never
 * asked for anything.
 */
// One marker read per candidate, against an origin we already crawl. The first
// cut used limit 3 out of caution and that is too slow to be a fix: the crawl
// cycle is 30 minutes and the self-registered population is in the hundreds
// (586 of the 2,000 seed slots at the last count), so a full pass took about
// FOUR DAYS and the seller who reported the duplicate would not have been
// reached this week. At 25 a pass is ~12 hours, and the cost is ~1,200 small
// GETs a day spread across origins whose manifests we are fetching anyway -
// noise against a cycle that already reads thousands. A shipped fix that
// cannot reach the reporter before they ask again has not shipped.
export async function discoverSuccessions({ now = Date.now(), limit = 25, minAgeMs = 6 * 3600_000,
  origins = null, read = readMarker, verify = verifySuccessionMarkers } = {}) {
  const candidates = (origins || [...submittedSeeds])
    .filter((o) => {
      if (successions.has(o)) return false;               // already the predecessor of something
      const e = cache.get(o);
      if (!e || e.error) return false;                    // nothing to claim with
      return now - (successionScanAt.get(o) || 0) >= minAgeMs;
    })
    .sort((a, b) => (successionScanAt.get(a) || 0) - (successionScanAt.get(b) || 0))
    .slice(0, limit);

  let found = 0;
  for (const origin of candidates) {
    successionScanAt.set(origin, now);                    // belt: stamp before the await, so a read the caller abandons does not requeue
    let marker = null;
    try { marker = await read(origin); } catch { marker = null; }
    const predecessor = marker && typeof marker.succeeds === "string" ? marker.succeeds : null;
    // No self-succession check here: recordSuccession's cycle walk starts AT
    // the claimant, so hop zero IS the self case and it already refuses. A
    // guard here would be dead code no mutation can kill - the same call made
    // when the register path's `a === b` check was removed.
    if (!predecessor) continue;
    if (!cache.has(predecessor)) continue;                // not an origin we list; nothing to retire
    if (successions.has(predecessor)) continue;           // already recorded
    let res = null;
    try { res = await verify(origin, predecessor); } catch { res = null; }
    if (res?.ok && res.via === "cross-served markers" && recordSuccession(predecessor, origin)) found++;
  }
  return { checked: candidates.length, found };
}

/**
 * Superseded origins to hide, resolved AT READ TIME against the live cache.
 *
 * The successor must actually be present and healthy: if the new origin is
 * gone or erroring, hiding the old one would remove the seller from the index
 * altogether, which is worse than the duplicate this exists to fix. A
 * migration that fails backs out on its own.
 */
export function supersededOrigins(cacheMap = cache) {
  const out = new Set();
  for (const [oldO, rec] of successions) {
    const newO = rec.to;
    const successor = cacheMap.get(newO);
    if (!successor || successor.error) continue;
    if (!cacheMap.has(oldO)) continue;
    out.add(oldO);
  }
  return out;
}

/** Test hook: clear submitted-seed state between test cases. */
export function __testResetSubmitted() { submittedSeeds.clear(); successions.clear(); successionScanAt.clear(); cache.clear(); removedOrigins.clear(); }

/** Test hook: put entries in the crawl cache so cache-dependent paths can be driven. */
export function __testSeedCache(entries = []) { for (const [o, e] of entries) cache.set(o, e); }

/** Test hook: set (or, with no rows, clear) the registry rows held for one origin. */
export function __testSetBazaarTools(origin, rows) { if (Array.isArray(rows)) bazaarToolsByOrigin.set(origin, rows); else bazaarToolsByOrigin.delete(origin); }

/** Validate a raw submitted origin. Returns { origin } (normalized) or { error }. */
export function validateOriginInput(raw, { selfOrigin, allowPath = false } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { error: "origin must be a valid URL" }; }
  // A path seller (2026-10-01): only where the caller opts in, so the MPP index
  // and every other caller keep requiring a bare origin.
  if (allowPath && u.pathname && u.pathname !== "/") {
    if (u.protocol !== "https:") return { error: "origin must be https" };
    if (!u.hostname.includes(".")) return { error: "origin must be a public hostname" };
    const n = normalizeSellerKey(raw);
    if (n.error) return { error: n.error };
    if (selfOrigin && n.origin === String(selfOrigin).toLowerCase().replace(/\/+$/, "")) return { error: "this host is already the local catalog" };
    return { origin: n.key };
  }
  if (u.protocol !== "https:") return { error: "origin must be https" };
  if (u.username || u.password) return { error: "origin must not contain credentials" };
  // A NON-DEFAULT PORT IS CARRIED, not refused (2026-09-21). The normaliser
  // below builds the origin from `u.host`, which includes a port when there is
  // one and omits it when it is 443, because WHATWG URL drops a scheme's
  // default port on parse. So `https://host:443` and `https://host` normalise
  // to the same key and `https://host:8443` keeps its own.
  //
  // This door used to refuse a port, and the reason it gave (that supporting
  // one meant reshaping a persisted key across a dozen modules) was wrong. The
  // rest of the index was already port-safe and had been all along: the
  // discovery normaliser `extractOrigin` has always used `u.host`, crawls build
  // URLs with `new URL(path, origin)` or by concatenation onto the whole origin,
  // `canonicalHost` and the payTo grouping read `u.host`, the persisted cache
  // treats the origin as an opaque key, and the display sites strip the scheme
  // and print whatever is left. Six ported origins were sitting in the live
  // index when this was measured, three of them routable, every one of them
  // arrived through discovery. Registration was the only door that refused one.
  //
  // NOT an SSRF control, which is worth saying because it looked like one.
  // Every outbound crawl goes through safeFetch -> assertPublicUrl, which
  // resolves the host and refuses private addresses and never inspects the
  // port, so the port was never what bounded the reach. What a port does add is
  // a crude prober: registering an origin reports whether that host:port speaks
  // TLS and HTTP. That was already true of 443 on any public host, the hosts
  // are public either way, and registration is rate limited per IP and
  // globally, so the honest trade is to accept a real seller's port rather than
  // guard a fact anyone can read with nmap.
  //
  // `operatorKey` still groups by hostname alone, deliberately: two ports on
  // one host are one operator and share one crawl budget.
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { error: "submit the bare origin (no path or query)" };
  if (!u.hostname.includes(".")) return { error: "origin must be a public hostname" };
  const origin = `https://${u.host.toLowerCase()}`;
  if (selfOrigin && origin === String(selfOrigin).toLowerCase()) return { error: "this host is already the local catalog" };
  return { origin };
}

/**
 * Probe + list a submitted origin. `crawl` is injectable for tests; defaults
 * to the real crawlSeller. Known origins return their current state without
 * a fetch. Successful probes persist the origin as a seed.
 */
/**
 * Does `claimant` have the standing to inherit `predecessor`'s listing age?
 *
 * The only non-forgeable binding available here is the PAYOUT WALLET: both
 * origins must advertise the same Base payTo, which means whoever is moving
 * controls where the money goes on both. Anything weaker (a header, a
 * well-known file, an assertion in the request) is a claim, not proof.
 *
 * This is a narrow grant - it moves a date - and it deliberately buys nothing
 * else. It does not demote the predecessor, transfer settlement evidence, or
 * merge crawl history. Evidence is keyed by payTo and follows the wallet
 * already; the shared-payTo guard that withholds chain proof while two live
 * origins claim one wallet stays exactly as it is, because a migration window
 * is precisely when a listing SHOULD be treated carefully.
 */
export const SUCCESSION_PATH = "/.well-known/agent402-succession";

/**
 * Does `claimant` have the standing to inherit `predecessor`'s listing age?
 *
 * TWO proofs, either sufficient, because the first one is unavailable to
 * exactly the sellers who need this most.
 *
 * 1. SHARED PAYOUT WALLET. Both origins advertise the same payTo on some
 *    chain: whoever is moving controls where the money goes on both. Free,
 *    instant, and needs nothing from the seller.
 *
 *    Measured 2026-09-12: 2,955 of 3,955 indexed origins advertise a payTo
 *    somewhere, 2,641 on Base. So a BASE-only rule - which is what shipped
 *    first - refused a third of the index, and the seller who asked for this
 *    feature was in that third with no payTo on any chain at all. Widening to
 *    any network recovers 314 of them; the other thousand need the second
 *    proof, which is why it exists.
 *
 * 2. CROSS-SERVED MARKERS. Each origin serves a small JSON document at
 *    /.well-known/agent402-succession naming the other. Serving a file at a
 *    path on a host is the standard proof of control over that host, and
 *    requiring BOTH directions means a claimant cannot annex an origin they do
 *    not run, nor be annexed by one.
 *
 * Still narrow either way: it moves a date. It never demotes, retires or edits
 * the predecessor, never transfers settlement evidence, and leaves the
 * shared-payTo guard exactly as it is.
 */
export function sharesPayTo(claimant, predecessor) {
  const a = cache.get(claimant), b = cache.get(predecessor);
  if (!a || !b || a.error || b.error) return null;
  // The seller-level payTo per network, the origin's own address first (see
  // sellerPayToByNetwork): a wallet only a registry row still records is not
  // the seller's payTo for a proof of common control.
  const payTos = (e) => new Map(Object.entries(sellerPayToByNetwork(e.tools)).map(([net, v]) => [net, v.toLowerCase()]));
  const x = payTos(a), y = payTos(b);
  for (const [net, v] of x) if (y.get(net) === v) return { network: net, payTo: v };
  return null;
}

/** Fetch one origin's succession marker. Never throws; an unreadable marker is
 *  simply not a proof. */
async function readMarker(origin, fetchImpl) {
  try {
    const url = `${String(origin).replace(/\/+$/, "")}${SUCCESSION_PATH}`;
    // SSRF: `origin` is caller-supplied, so this goes through safeFetch - the
    // guarded fetcher this file already imports and the rest of the codebase
    // uses for exactly this. It asserts the URL is public, pins the connection
    // to the validated IP and re-validates every redirect hop.
    //
    // Two earlier attempts were both flagged CRITICAL js/request-forgery, and
    // both times CodeQL was right to. First the guard was injectable
    // (`(assertUrl || assertPublicUrl)(url)`) - an indirection a static
    // analyzer cannot follow. Then it was unconditional but reached through a
    // DYNAMIC import, which CodeQL also cannot resolve, so it still could not
    // tell the call was sanitized. A control the tooling cannot see is not
    // meaningfully a control: the third version uses the statically imported
    // helper, which it can.
    //
    // `fetchImpl` remains only for tests and is never the network path.
    const res = fetchImpl
      ? await fetchImpl(url).then(async (r) => (r.ok ? { html: await r.text(), finalUrl: r.url || url } : null))
      : await safeFetch(url, { headers: { accept: "application/json" }, maxBytes: 4096 }).catch(() => null);
    if (!res) return null;
    // THE MARKER MUST BE SERVED BY THE ORIGIN ITSELF.
    //
    // safeFetch follows redirects (redirect: "follow"), and its SSRF guard
    // re-validates each hop only for being PUBLIC - it does not pin the hop to
    // the host we asked for. So without this check the document we parse as
    // "the marker on the old origin" may have been served by any other public
    // host the old origin redirects to, and the whole proof degrades from
    // "control of this host" to "being the target of something it points at".
    // A victim with a wildcard or catch-all redirect at this path could then be
    // retired by whoever it redirects to. Same rule every domain-control check
    // uses (ACME http-01, site-verification files): the proof fetch may not be
    // satisfied off-host.
    // A path seller's marker must also come from under its own prefix: another
    // app on the same host is not the seller.
    if (res.finalUrl && !(sellerPrefixOf(origin) ? isUnderSeller(res.finalUrl, origin) : sameOrigin(res.finalUrl, origin))) return null;
    return JSON.parse(String(res.html).slice(0, 4000));
  } catch { return null; }
}

const sameOrigin = (a, b) => {
  try { return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase(); } catch { return false; }
};
// Does the URL a marker names (`named`) name the seller keyed `sellerKey`? For a
// bare-origin seller it compares as an origin, exactly as before. For a path
// seller the normalised key must be identical, so a marker naming the host
// does not name an app on it.
const sameSeller = (named, sellerKey) => {
  if (!sellerPrefixOf(sellerKey)) return sameOrigin(named, sellerKey);
  const x = normalizeSellerKey(named, { protocols: ["http:", "https:"] });
  return !x.error && x.key === sellerKey;
};

/** Both origins must name the other, so neither can be annexed by the other. */
export async function verifySuccessionMarkers(claimant, predecessor, { fetchImpl } = {}) {
  const [mNew, mOld] = await Promise.all([readMarker(claimant, fetchImpl), readMarker(predecessor, fetchImpl)]);
  if (!mNew || !mOld) return { ok: false, reason: `serve a JSON document at ${SUCCESSION_PATH} on BOTH origins: {"succeeds":"<old origin>"} on the new one and {"succeededBy":"<new origin>"} on the old one` };
  if (!sameSeller(mNew.succeeds || "", predecessor)) return { ok: false, reason: `${SUCCESSION_PATH} on the new origin must name the old origin as "succeeds"` };
  if (!sameSeller(mOld.succeededBy || "", claimant)) return { ok: false, reason: `${SUCCESSION_PATH} on the old origin must name the new origin as "succeededBy"` };
  return { ok: true, via: "cross-served markers" };
}

export async function succeedsOrigin(claimant, predecessor, { fetchImpl } = {}) {
  const a = cache.get(claimant), b = cache.get(predecessor);
  if (!a || !b || a.error || b.error) return { ok: false, reason: "one of the two origins is not in the index - register it first" };
  // Markers first: they are the only proof that retires the predecessor, and a
  // seller who migrates keeps the same payout wallet, so checking the wallet
  // first answered "shared payout wallet" for exactly the sellers who had also
  // served valid markers, and their old listing was never retired (reported
  // by a seller 2026-10-02). The wallet still answers when no markers are up.
  const markers = await verifySuccessionMarkers(claimant, predecessor, { fetchImpl });
  if (markers.ok) return markers;
  const shared = sharesPayTo(claimant, predecessor);
  if (shared) return { ok: true, via: "shared payout wallet", ...shared };
  return markers;
}

export async function registerOrigin(origin, { crawl, replaces = null } = {}) {
  if (isRemovedOrigin(origin) || (replaces && isRemovedOrigin(replaces))) return { listed: false, origin, removed: true, error: REMOVED_ORIGIN_ERROR };
  // Evaluated lazily: the claimant has to be in the cache before its payTo can
  // be compared, so this is re-read at each record site rather than up front.
  const checkSuccession = async () => {
    if (!replaces) return null;
    const r = await succeedsOrigin(origin, replaces);
    // Recording is what retires the predecessor from every listing. Only ever
    // on a VERIFIED succession: the markers (or a shared payout wallet) are
    // what make this the seller's own decision rather than a claim anyone can
    // make about anyone.
    // RETIRE ONLY ON THE MARKER PATH. succeedsOrigin has two proofs and they
    // are not equally strong. Cross-served markers require serving a document
    // on the OLD origin, which is control of it - that is the seller's own
    // decision about their own listing. A SHARED PAYOUT WALLET is not: a
    // manifest can advertise any address, so an origin claiming a wallet it
    // merely names could retire the listing of whoever actually earns on it.
    // That is the same inherited-evidence class as the 2026-09-03 payTo
    // binding, and it is exactly what test-seller-succession warned about when
    // it said a register call that can retire another seller's listing is a
    // weapon whatever proof rides with it. The shared-wallet path keeps doing
    // what it always did (carry the first-seen date) and retires nothing.
    if (r?.ok && r.via === "cross-served markers") r.predecessorRetired = recordSuccession(replaces, origin);
    return r;
  };
  let succession = null;
  const existing = cache.get(origin);
  if (existing && !existing.error) {
    // A re-registration of a KNOWN origin used to be a pure no-op, which made
    // "register again" useless as a seller's lever: a catalog stuck unpriced
    // (and therefore unroutable) had no way to ask for pricing except waiting
    // for the shared cycle budget to reach its rotation slot - measured
    // 2026-09-01, one seller's 128 routes across four attempts. Registering
    // is an explicit, rate-limited request (5/hour/IP), so it now re-runs the
    // live-402 quote enrichment for THIS origin, budget-exempt and bounded by
    // the same per-origin cap; probeDue backoffs still apply per route.
    let reread = false, repriced = false, routesProbed = 0;
    try {
      // RE-READ THE DOCUMENTS FIRST. Until 2026-09-18 this branch ran only the
      // quote enrichment, so "register again" was a lever over PRICE and
      // nothing else: a seller who improved an operation's description, tags
      // or name on our own advice had no way to ask us to look again, and
      // waited for the shared rotation to reach them. Measured that day on a
      // seller who deployed a 232-character description and eight tags we had
      // asked for, whose row still carried neither two hours later while our
      // parser read both correctly from their live document. The 2026-09-01
      // fix that created this branch was scoped to the case that arrived
      // first, which is the shape of bug this file keeps re-teaching.
      // The backoff and the stored validators are cleared for THIS origin
      // only, so a path we had backed off is re-asked and a document we would
      // revalidate is read in full rather than answered 304 from our own ETag.
      // PER-ORIGIN COOLDOWN (2026-09-18, security review). Registration
      // requires no proof of control, so "re-read this origin's documents" is
      // a lever anyone can pull at ANY origin, and the clear above deliberately
      // defeats the backoff that exists to stop us hammering one. Per-IP limits
      // cannot bound that: the victim feels the sum of every caller, and the
      // global cap (300/hour) is the real ceiling on how often WE fetch one
      // seller's 4MB manifest and 12MB OpenAPI. The bound therefore lives on
      // the ORIGIN, where the cost lands, not on the caller.
      // A re-registration inside the window still re-prices (the lever's
      // original job, and free of third-party fetches beyond the seller's own
      // 402s) and still answers listed - it simply does not re-read documents.
      // A re-registration is the seller asking us to look again: every route
      // this origin had dropped or was about to drop is re-checked from scratch.
      clearGoneMarks(origin);
      if (forcedCrawlDue(origin)) {
        noteForcedCrawl(origin);
        clearOriginProbeState(origin);
        reread = true;
        if (crawl) await crawl(origin); else await crawlSeller(origin);
      }
      const fresh = cache.get(origin);
      const tools = Array.isArray(fresh?.tools) && fresh.tools.length ? fresh.tools : existing.tools;
      // The re-price is bounded AT THE ORIGIN too (2026-09-28). ignoreBudget
      // makes every live-verified route a candidate, and a successful probe
      // clears that route's backoff, so without a window each call re-asked up
      // to REPRICE_MAX_PER_CALL routes on two or three verbs - and anyone may
      // call it about anyone. A seller who fixes a price, domain or payTo is
      // re-read on the first call and again once the window passes; an origin
      // also has an hourly route allowance across calls.
      if (repriceDue(origin)) {
        const allowance = repriceAllowance(origin);
        if (allowance > 0) {
          noteReprice(origin);
          await enrichLiveQuotes(tools, origin, { ignoreBudget: true, maxProbes: allowance, onProbed: (n) => { routesProbed = n; spendRepriceAllowance(origin, n); } });
          repriced = true;
        }
      }
      // The route pool memoizes DECORATED tools by entry-object identity
      // (remotePoolMemo), so prices learned into the existing entry are
      // invisible until the object is replaced - a fresh spread busts the
      // memo and the pool re-decorates with what was just learned.
      cache.set(origin, { ...(cache.get(origin) || existing) });
    } catch { /* listing still served */ }
    // Only a self-serve-submitted origin belongs in seller_registrations - this
    // early-return path also serves origins already known from Bazaar/registry
    // discovery, which never went through /sell and would misrepresent an
    // ecosystem seller as one of ours if recorded here.
    succession = await checkSuccession();
    if (submittedSeeds.has(origin)) recordSellerRegistrationSeen(origin, { settled: originHasSettled(origin), inheritFirstSeenFrom: succession?.ok ? replaces : null });
    return { listed: true, origin, seller: sellerSummary(origin, cache.get(origin) || existing), reverify: reverifyReport(origin, { reread, repriced, routesProbed }), ...(succession ? { succession } : {}) };
  }
  // Cap applies only to origins that would grow the submitted set. An origin
  // already on the list (retrying after a prior failure) is not new growth,
  // so it's exempt — it can still probe and update its own entry at cap.
  if (!submittedSeeds.has(origin) && isEphemeralTunnelOrigin(origin)) {
    let tunnels = 0;
    for (const o of submittedSeeds) if (isEphemeralTunnelOrigin(o)) tunnels++;
    if (tunnels >= tunnelSubmissionCap(submittedSeedsCap)) {
      return { listed: false, origin, error: "tunnel submissions are full - quick-tunnel hostnames change every session, so their share of submission slots is capped; register a stable hostname, or retry after tunnel slots free up (a tunnel slot is released 3 days after its last successful probe)" };
    }
  }
  if (!submittedSeeds.has(origin) && submittedSeeds.size >= submittedSeedsCap) {
    return { listed: false, origin, error: "submission list is full - slots free up after 30 days with no successful probe; open a GitHub issue to get seeded sooner" };
  }
  const doCrawl = crawl || (async (o) => { await crawlSeller(o); return cache.get(o); });
  let v;
  try { v = await doCrawl(origin); } catch (e) { v = { error: String(e?.message || e) }; }
  // Injected test crawlers return the entry directly; the real path re-reads cache.
  if (v && !v.error && (v.tools?.length || v.manifest)) {
    submittedSeeds.add(origin);
    discoveredSeeds.add(origin);
    persistSubmittedSeeds();
    if (!cache.has(origin) && crawl) cache.set(origin, { ...v, fetchedAt: Date.now() });
    succession = await checkSuccession();
    recordSellerRegistrationSeen(origin, { settled: originHasSettled(origin), inheritFirstSeenFrom: succession?.ok ? replaces : null });
    return { listed: true, origin, seller: sellerSummary(origin, cache.get(origin) || v), ...(succession ? { succession } : {}) };
  }
  return { listed: false, origin, error: String(v?.error || "no x402 surface found (manifest, OpenAPI, or Bazaar entry)") };
}

// Has this origin's leaderboard row settled at least one payment? Joins on
// canonical host (leaderboard rows carry `origins: string[]`) rather than
// payTo address - the leaderboard already groups by host when a homepage is
// known, and every origin here already has a URL we can hash the same way,
// so this needs no new payTo-matching plumbing. Best-effort: any shape
// surprise in the snapshot (still warming, scan error) reads as "not yet
// observed settling", never a throw.
// The set of hosts that have settled, built once per leaderboard snapshot
// object. Each lookup used to walk every leaderboard row and parse every
// origin in it, once per submitted seed, twice per crawl cycle: measured
// 0.4-2.5 s of blocked event loop at the 2,000-seed cap (2026-09-25).
// Keyed on the snapshot's row ARRAY: getLeaderboardSnapshot() spreads a new
// wrapper object per call, while the rows array is shared until a refresh.
const settledHostsMemo = new WeakMap(); // leaderboard rows array -> Set<host>
function settledHostsOf(snap) {
  const rows = snap?.leaderboard;
  if (!Array.isArray(rows)) return new Set();
  let set = settledHostsMemo.get(rows);
  if (set) return set;
  set = new Set();
  for (const row of rows) {
    if (!((row.callsSettled || 0) > 0)) continue;
    for (const o of row.origins || []) { const h = canonicalHost(o); if (h) set.add(h); }
  }
  settledHostsMemo.set(rows, set);
  return set;
}
function originHasSettled(origin) {
  // A path seller is one app on a shared host: another app on the same host
  // settling says nothing about it, so it matches only listings at or under its
  // own prefix. A bare origin keeps the host match.
  if (sellerPrefixOf(origin)) {
    try {
      const rows = getLeaderboardSnapshot()?.leaderboard || [];
      return rows.some((row) => (row.callsSettled || 0) > 0 && (row.origins || []).some((o) => isUnderSeller(o, origin)));
    } catch {
      return false;
    }
  }
  const host = canonicalHost(origin);
  if (!host) return false;
  try {
    return settledHostsOf(getLeaderboardSnapshot()).has(host);
  } catch {
    return false;
  }
}
export function __originHasSettledForTest(origin) { return originHasSettled(origin); }

function sellerSummary(origin, v) {
  return {
    displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
    toolCount: v.tools?.length || 0,
    networks: [...new Set([...(v.tools || []).flatMap((t) => t.networks || []), ...(bazaarToolsByOrigin.get(origin) || []).flatMap((t) => t.networks || [])])],
    routable: isRoutable(v),
    health: healthScore(v),
  };
}

// Per-source state for the discovery panel on /index.
const discoveryStatus = new Map(); // name -> { url, fetchedAt, resources, origins, error }
// Per-origin synthesized tool list assembled directly from Bazaar resource
// entries. Used as a fallback for sellers whose /.well-known/x402 endpoint
// 404s (the bulk of the unhealthy cohort — they only ever published settled
// resources, never a manifest). Map<origin, Array<tool>>.
const bazaarToolsByOrigin = new GuardedMap();
// Per-origin Bazaar `quality` (Coinbase-measured 30-day calls + unique payers,
// last call time), aggregated from the discovery feed's per-resource objects:
// calls summed, unique payers MAX across resources (a seller-level unique
// count is unknowable from per-resource counts; max is the safe lower bound,
// never a sum that double-counts one wallet across routes). An independent
// evidence source next to our own on-chain scan: a Base seller Coinbase has
// watched being paid by N distinct wallets this month is proven for the SOR
// gate whether or not our scan has caught up, and /api/find can rank on it.
const bazaarQualityByOrigin = new GuardedMap();
export function bazaarQualityFor(origin) {
  return bazaarQualityByOrigin.get(String(origin || "").replace(/\/$/, "")) || null;
}
/**
 * The Bazaar payer count a ranking tie-break may read for one origin
 * (2026-09-28). The Bazaar counts every settled payment, including the ones a
 * seller funded itself; at a wallet whose received dollars were mostly
 * self-funded (src/seller-funding.js) those counts are the same self-payments,
 * so the slice measured at that wallet is left out. Null when nothing measured
 * remains: unmeasured, never zero.
 *
 * ONLY AN ORIGIN MEASURED AT A CIRCULAR WALLET IS TOUCHED. Every other origin
 * reads its payers30d exactly as before, whatever other wallets are circular:
 * another seller's verdict must never move this one's rank (the first cut
 * replaced every split origin's figure with its Base split, which dropped the
 * payers of its non-Base resources as soon as any wallet anywhere was
 * circular). For an origin that IS measured at a circular wallet, what stays
 * is the largest figure measured anywhere else: its other Base wallets, and
 * its resources declaring no Base payTo at all (`payersOffBase`), which cannot
 * be paid at that wallet.
 */
export function rankingPayersOf(q, circular = null) {
  if (!q || typeof q !== "object") return null;
  if (!circular || typeof circular.has !== "function" || !circular.size) return q.payers30d ?? null;
  const isCircular = (w) => circular.has(String(w).toLowerCase());
  const split = q.byPayTo && typeof q.byPayTo === "object" ? Object.entries(q.byPayTo) : [];
  const measuredAtCircular = split.some(([w]) => isCircular(w)) || (Array.isArray(q.payTos) ? q.payTos : []).some(isCircular);
  if (!measuredAtCircular) return q.payers30d ?? null;
  let best = null;
  for (const [w, v] of split) if (!isCircular(w)) best = Math.max(best ?? 0, Number(v?.payers) || 0);
  const off = Number(q.payersOffBase);
  if (off > 0) best = Math.max(best ?? 0, off);
  return best;
}
export function bazaarQualityEntries() { return [...bazaarQualityByOrigin.entries()]; }
export function _setBazaarQualityForTest(origin, q) { if (q) bazaarQualityByOrigin.set(origin, q); else bazaarQualityByOrigin.delete(origin); }
// `basePayTo` (2026-09-03): the Base-mainnet payTo the counted resource
// DECLARES, kept beside the counts as `payTos` so the router can bind the
// inherited history to the wallet it belongs to (src/evidence-binding.js) -
// a quality count is Coinbase's measurement of settlements at that resource's
// payTo, and it must not clear the Base floor for an origin whose live 402
// asks to be paid somewhere else.
//
// `byPayTo` (2026-09-28): the same counts split by the Base payTo each
// counted resource declares, under the same cap: calls summed, payers the MAX
// across that wallet's resources. The router keeps its evidence PER WALLET
// (src/evidence-binding.js), so a count measured at one wallet can never clear
// the floor for a payment to another. NON-ENUMERABLE on purpose: this object
// is served as-is as `bazaar` on public index and route rows, and the split is
// router input, not a column.
//
// `payersOffBase` (2026-09-28, non-enumerable for the same reason): the largest
// payer count among the origin's resources that declare NO Base payTo. Those
// cannot be paid at any Base wallet, so no Base wallet's verdict applies to
// them (rankingPayersOf).
//
// `curated` (2026-09-29): true when any of the origin's resources carries the
// Bazaar's own `curated: true` flag, which the bulk discovery feed now serves
// per item (it used to appear on the search endpoint only). Read ONLY from the
// Coinbase feed (`fromCoinbase`): an open registry's item could set the same
// key about itself. Coinbase's editorial mark, reported as theirs; the router
// reads it as its LAST tie-break, after match, health, payers and price.
export const BAZAAR_QUALITY_MAX_PAYTOS = 8;
export function foldBazaarQuality(map, origin, q, basePayTo = null, { curated = false } = {}) {
  if (!q || typeof q !== "object") return;
  const calls = Number(q.l30DaysTotalCalls) || 0, payers = Number(q.l30DaysUniquePayers) || 0;
  const last = typeof q.lastCalledAt === "string" ? q.lastCalledAt : null;
  const cur = map.get(origin) || { calls30d: 0, payers30d: 0, lastCalledAt: null, payTos: [], curated: false };
  cur.curated = cur.curated === true || curated === true;
  if (!cur.byPayTo || typeof cur.byPayTo !== "object") Object.defineProperty(cur, "byPayTo", { value: {}, enumerable: false, writable: true, configurable: true });
  if (!Object.hasOwn(cur, "payersOffBase")) Object.defineProperty(cur, "payersOffBase", { value: 0, enumerable: false, writable: true, configurable: true });
  cur.calls30d += calls;
  cur.payers30d = Math.max(cur.payers30d, payers);
  if (last && (!cur.lastCalledAt || last > cur.lastCalledAt)) cur.lastCalledAt = last;
  const w = typeof basePayTo === "string" && /^0x[0-9a-f]{40}$/i.test(basePayTo) ? basePayTo.toLowerCase() : null;
  if (!w) cur.payersOffBase = Math.max(cur.payersOffBase, payers);
  if (!Array.isArray(cur.payTos)) cur.payTos = [];
  if (w && !cur.payTos.includes(w) && cur.payTos.length < BAZAAR_QUALITY_MAX_PAYTOS) cur.payTos.push(w);
  if (w && calls > 0 && (Object.hasOwn(cur.byPayTo, w) || Object.keys(cur.byPayTo).length < BAZAAR_QUALITY_MAX_PAYTOS)) {
    const at = cur.byPayTo[w] || { calls: 0, payers: 0 };
    at.calls += calls;
    at.payers = Math.max(at.payers, payers);
    cur.byPayTo[w] = at;
  }
  map.set(origin, cur);
}

// Public x402 seller registries we crawl. Each exposes an unauthenticated
// discovery endpoint; we extract unique origins from the listings.
const DISCOVERY_SOURCES = [
  { name: "Coinbase CDP Bazaar", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" },
  // GoPlausible's facilitator registry (multi-chain - AVM/EVM/SVM - despite
  // the name; Algorand-native x402 sellers live here, registering by settling
  // through the facilitator rather than on the CDP Bazaar). Same
  // {items, pagination:{total}} contract as PayAI/Solvador below - confirmed
  // 2026-08-13. Was a single un-paginated ?limit=1000 fetch (sized when the
  // registry had ~8 Algorand origins, 2026-07-10); by 2026-08-13 the full
  // registry had grown to ~5,962 resources, so that single page was only
  // ever seeing ~17% of it. paginate walks the rest, matching PayAI/Solvador.
  // strict drops testnet-only listings and placeholder origins, same as
  // those two - Algorand's testnet CAIP-2 id needed itemHasMainnetAccept
  // taught to recognize it first (it's a genesis-hash id, not a
  // "testnet"-labeled string the existing EVM-shaped check could see).
  // synthesizeTools makes their sellers list with tools even when they serve
  // no /.well-known/x402 manifest.
  { name: "GoPlausible registry", url: "https://facilitator.goplausible.xyz/discovery/resources", paginate: true, synthesizeTools: true, seedImmediately: true, strict: true },
  // PayAI's facilitator registry — where non-Base-native sellers (Solana
  // especially) that settle through PayAI register instead of the Base-centric
  // CDP Bazaar (added 2026-07-12; the Bazaar showed ~378 Solana sellers, PayAI
  // adds ~dozens more net-new). Same {resource, accepts, pagination:{total}}
  // contract as the Bazaar, so `paginate` walks all ~24 pages. `strict` drops
  // testnet-only listings and placeholder origins (the open registry carries
  // base-sepolia entries, example.com, and staging URLs); health routing then
  // self-heals anything dead. synthesizeTools so PayAI sellers with no manifest
  // still list with tools.
  { name: "PayAI facilitator registry", url: "https://facilitator.payai.network/discovery/resources", paginate: true, synthesizeTools: true, strict: true },
  // Solvador's registry — settlement-harvested like the Bazaar (confirmed
  // 2026-07-28: our first two Optimism settles auto-registered our routes
  // within the hour), keyless reads, identical {items, pagination.total}
  // contract. Their facilitator uniquely covers Optimism, Unichain, World
  // Chain, Linea, NEAR and XRPL, so this is the discovery home for sellers
  // on those chains as they appear (watch issue #586). Same hygiene as
  // PayAI's open registry: paginate + synthesizeTools + strict.
  { name: "Solvador registry", url: "https://api.solvador.com/discovery/resources", paginate: true, synthesizeTools: true, strict: true },
];

// Operator-curated seeds committed in-repo — the version-controlled companion
// to the X402_INDEX_SEEDS env var, and what the /index page's "open a PR adding
// your origin to the seed list" invitation points at. It exists for sellers who
// can't reach the CDP Bazaar auto-discovery source (Coinbase account/phone
// verification blocks). Health-aware routing drops any seed that goes dark, so a
// stale entry self-heals — but keep this to STABLE origins only. No ephemeral
// tunnels (*.trycloudflare.com and friends flap to STALE on every restart).
const DEFAULT_SEEDS = [
  "https://agentpass-protocol.rmalka06.chatgpt.site", // IntentFence — payment-safety, wallet-risk, and signed policy preflights
  "https://agentservices.to", // AgentServices — 50 paid APIs for AI agents (#aiservices)
  "https://agents.daedalusdevelopmentgroup.com", // DDG Agent-Payable Services (#222)
  "https://jmt-x402-proxy.jmthomasofficial.workers.dev", // JMT x402 server (#221)
  "https://nolawealthfinancial.com", // Still OS Notary Protocol — Ed25519-signed notarization, OFAC/SDN screening, CPI/GDP signals, USDC on Base (#434)
  "https://x402.evidencesupply.com", // Evidence Supply — corroborated agent-action verification, USDC on Base
  "https://x402.lagaceta.net", // Colombia TRM — official USD/COP Superfinanciera series, prepaid x402 GET on Base USDC
  "https://api.surplusintelligence.ai", // Surplus Intelligence — OpenAI-compatible inference market, x402 (Base USDC, exact + upto) and MPP (Tempo) on one 402; /.well-known/x402 manifest (verified 2026-08-26)
  "https://billing.ideatrace.cn", // Idie - self-evolving autonomy RPC, exact-scheme pay-per-use USDC on Solana (PR #903)
  "https://compounder-market-api.vercel.app", // Compounder Market API — deterministic bounty-fit scoring with structured JSON verdicts, $0.01 USDC exact on Base
];

export const seedList = () => {
  const envSeeds = String(process.env.X402_INDEX_SEEDS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s));
  // committed defaults + env seeds (both operator-curated), then auto-discovered.
  return [...new Set([...DEFAULT_SEEDS, ...envSeeds, ...discoveredSeeds])].filter((o) => !isRemovedOrigin(o));
};

function extractOrigin(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Registries carry dev entries (localhost:3000, 127.0.0.1:*) — skip
    // dotless/loopback hosts up front. safeFetch's SSRF guard would block the
    // crawl anyway; this keeps them out of the seed set and off /index.
    if (!u.hostname.includes(".") || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// --- strict-source hygiene (testnet + placeholder filtering) ----------------
// Open facilitator registries (PayAI) carry testnet listings and placeholder
// origins the CDP Bazaar doesn't. A `strict` source drops both before they hit
// the index. Testnet networks by CAIP-2/name; a listing offered ONLY on testnets
// is skipped, but a mainnet+testnet listing still counts (via its mainnet leg).
const TESTNET_NET_RE = /sepolia|testnet|devnet/i;
const TESTNET_CAIP2 = new Set([
  "eip155:84532", // base sepolia
  "eip155:11155111", // ethereum sepolia
  "eip155:80002", // polygon amoy
  "eip155:421614", // arbitrum sepolia
  "eip155:11155420", // optimism sepolia
  // Added 2026-08-13: this set was never extended when Monad/Celo/Avalanche/Sei
  // joined as rails (their mainnet ids were added to CHAIN_PAGES, but their
  // testnet ids - none of which contain "sepolia"/"testnet"/"devnet", the
  // only strings TESTNET_NET_RE above can see - were not added here). Latent
  // gap: a strict-source listing whose only accept is one of these would have
  // incorrectly passed itemHasMainnetAccept. Values per each chain's own
  // isNetwork comment in src/market-page.js.
  "eip155:10143", // monad testnet
  "eip155:11142220", // celo sepolia
  "eip155:43113", // avalanche fuji
  "eip155:1328", // sei testnet (atlantic-2)
]);
export function itemHasMainnetAccept(item) {
  const accepts = Array.isArray(item?.accepts) ? item.accepts : [];
  if (!accepts.length) return true; // no accepts info → don't over-filter it out
  return accepts.some((a) => {
    const n = String(a?.network || "");
    if (!n) return false;
    // Algorand's testnet CAIP-2 id is a genesis hash (algorand:SGO1GKSz...),
    // not a "testnet"-labeled string, so the EVM-shaped checks below can't
    // see it - check the known mainnet prefix directly instead, same source
    // of truth as CHAIN_PAGES.algorand.isNetwork (src/market-page.js).
    if (n.startsWith("algorand:")) return CHAIN_PAGES.algorand.isNetwork(n);
    return !TESTNET_NET_RE.test(n) && !TESTNET_CAIP2.has(n);
  });
}
// Placeholder / non-real hosts that show up in open registries. extractOrigin
// already rejects dotless/loopback hosts; this catches documentation stand-ins.
const JUNK_HOST_RE = /(^|\.)(example|test|invalid|localhost)\.(com|org|net|dev|io)$/i;
export function isJunkOrigin(origin) {
  try {
    return JUNK_HOST_RE.test(new URL(origin).hostname);
  } catch {
    return true;
  }
}

// safeFetch-backed JSON fetcher injected into the Bazaar pager. Each page is
// independently SSRF-guarded and byte-capped — the pager just chains them.
// Accept must say JSON: safeFetch's default Accept prefers text/html, and
// content-negotiating registries (GoPlausible's) serve their docs page for it.
async function safeFetchJson(url) {
  const { html } = await safeFetch(url, { maxBytes: MAX_DISCOVERY_BYTES, headers: { Accept: "application/json" } });
  return JSON.parse(html);
}

async function discoverOneSource(source, selfOrigin) {
  const status = { url: source.url, fetchedAt: Date.now(), resources: 0, origins: 0, error: null };
  try {
    // The Bazaar paginates and has 69k+ listings — a single fetch sees the
    // first page only and the index ends up with <0.2% of sellers. For Bazaar
    // sources walk every page; for other registries keep the single-fetch path
    // (their shapes vary and most have no pagination contract).
    let list;
    if (isBazaarDiscoveryUrl(source.url) || source.paginate) {
      const { items } = await fetchAllBazaarItems(
        source.url,
        {
          pageSize: parseInt(process.env.BAZAAR_PAGE_SIZE || "1000", 10),
          maxPages: parseInt(process.env.BAZAAR_MAX_PAGES || "200", 10),
        },
        safeFetchJson
      );
      list = items;
    } else {
      const data = await safeFetchJson(source.url);
      // Discovery shapes vary by registry: { resources }, { items }, { data },
      // or a top-level array.
      list =
        data.resources ||
        data.items ||
        data.data ||
        (Array.isArray(data) ? data : []);
    }
    status.resources = list.length;
    const found = new Set();
    // Rebuild the registry→origin tool map from this discovery pass so renamed /
    // removed resources don't linger. Each registry is authoritative for the
    // origins it lists (per-origin swap below, so two registries listing
    // disjoint origins don't clobber each other).
    const synthesize = isBazaarDiscoveryUrl(source.url) || source.synthesizeTools === true;
    const toolsByOrigin = synthesize ? new Map() : null;
    const qualityByOrigin = toolsByOrigin ? new Map() : null;
    let droppedTestnet = 0, droppedJunk = 0;
    // A registry row under a known path seller's prefix belongs to that seller,
    // not to its shared host (which would list every app on the host as one).
    const pathSellers = pathSellersByHost();
    for (const item of list) {
      const url = item.resource || item.resourceUrl || item.url || item.endpoint || item.homepage;
      const hostOrigin = extractOrigin(url);
      if (!hostOrigin || hostOrigin === selfOrigin) continue;
      const origin = pathSellerOwning(url, hostOrigin, pathSellers) || hostOrigin;
      // strict sources (open registries): drop testnet-only listings and
      // placeholder origins before they reach the index.
      if (source.strict) {
        if (!itemHasMainnetAccept(item)) { droppedTestnet++; continue; }
        if (isJunkOrigin(origin)) { droppedJunk++; continue; }
      }
      found.add(origin);
      if (toolsByOrigin) {
        const t = bazaarItemToTool(item, origin);
        if (t) {
          const arr = toolsByOrigin.get(origin) || [];
          arr.push(t);
          toolsByOrigin.set(origin, arr);
        }
        if (qualityByOrigin && item.quality) foldBazaarQuality(qualityByOrigin, origin, item.quality, t?.payToByNetwork?.["eip155:8453"] || null, { curated: item.curated === true && isBazaarDiscoveryUrl(source.url) });
      }
    }
    if (toolsByOrigin) {
      // Atomic swap-in (per-origin) to avoid stale partial state mid-update.
      for (const [o, arr] of toolsByOrigin) bazaarToolsByOrigin.set(o, arr);
      if (qualityByOrigin) for (const [o, q] of qualityByOrigin) bazaarQualityByOrigin.set(o, q);
    }
    // Small niche-chain registries (GoPlausible's AVM feed) seed a bazaar-
    // fallback cache entry IMMEDIATELY, so their sellers appear the moment we
    // discover them instead of waiting for a crawl cycle to reach them. Many
    // AVM sellers publish no /.well-known/x402 (it 404s), so without
    // this they only surfaced when a crawl happened to run while their tools
    // were populated — flickering across restarts. We never do this for the
    // 1,477-origin CDP Bazaar (crawl-gated by design); only for the handful of
    // origins on a seedImmediately source. A live manifest crawl still upgrades
    // the entry later; we never clobber a good manifest with the fallback.
    if (source.seedImmediately && toolsByOrigin) {
      for (const [o, arr] of toolsByOrigin) {
        const existing = cache.get(o);
        if (!existing || existing.error || existing.source === "bazaar-fallback") {
          cache.set(o, {
            ...(existing || {}),
            manifest: existing?.manifest || synthManifestFromBazaar(o, arr),
            tools: arr,
            fetchedAt: Date.now(),
            error: null,
            source: "bazaar-fallback",
            history: rollHistory(existing, true),
          });
        }
      }
    }
    status.origins = found.size;
    if (source.strict) { status.droppedTestnet = droppedTestnet; status.droppedJunk = droppedJunk; }
    for (const o of found) {
      if (discoveredSeeds.size >= MAX_DISCOVERED_SELLERS) break;
      discoveredSeeds.add(o);
    }
  } catch (e) {
    status.error = String(e.message || e);
  }
  discoveryStatus.set(source.name, status);
}

let selfOriginCache = null;
async function runDiscovery(selfOrigin) {
  selfOriginCache = selfOrigin || selfOriginCache;
  await Promise.allSettled(DISCOVERY_SOURCES.map((s) => discoverOneSource(s, selfOriginCache)));
}

function parsePrice(p) {
  if (typeof p === "number") return p;
  const n = parseFloat(String(p ?? "").replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : 0;
}

/** USD → integer micro-dollars for exact compares (avoids float !== hazards).
 *  Exported for the dataset snapshot, which needs a price column that is NULL
 *  when the origin published something unparseable - never parsePrice's 0,
 *  which would publish "free" for "we could not read it". */
export function priceToMicroUsd(p) {
  if (p == null || p === "") return null;
  if (typeof p === "number") return Number.isFinite(p) && p >= 0 ? Math.round(p * 1e6) : null;

  // A seller may publish a price as an OBJECT. Read the shapes that actually
  // appear in the crawl rather than dropping a price we were told: a bare
  // {usd}, or Stripe-style minor units. Measured 2026-09-11: 21 routes carried
  // {"amountMinor":50,"currency":"USD"} or {"usd":0.05} and every one of them
  // published as null while the seller had stated the price plainly.
  if (typeof p === "object") {
    if (Number.isFinite(Number(p.usd))) return priceToMicroUsd(Number(p.usd));
    if (Number.isFinite(Number(p.amountMinor)) && String(p.currency || "USD").toUpperCase() === "USD") {
      return Math.round(Number(p.amountMinor) * 1e4); // cents -> micro-dollars
    }
    // `amount` beside payment context (decimals / asset / an MPP currency) is
    // BASE UNITS, the same rule parseManifestPrice reads it by: the million-
    // fold overquote arrives here too whenever a row stores its price object.
    const amount = p.amount != null && atomicContext(p) ? atomicAmountToDollars(p, p.amount) : p.amount;
    return priceToMicroUsd(p.display ?? p.price ?? amount ?? null);
  }
  if (typeof p !== "string") return null;

  // Strip currency and separators, then require the remainder to be ONE number.
  // The old rule deleted every non-digit and parsed whatever was left, so
  // "$free (since 2026-09-02)" became 20260902 - a date welded into a price,
  // and not a small error: five routes published at $20,260,902 while their
  // seller was saying FREE. A string carrying several numbers is a sentence,
  // not a price, and the honest answer is null.
  const cleaned = p.replace(/[$,\s]|usdc?\b/gi, "");
  if (!/^[0-9]*\.?[0-9]+$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6);
}

function microUsdToPrice(micro) {
  return micro / 1e6;
}

/** Shared projection so sellerDetail / route / index-tools never drift. */
/** Say when a published route is a documentation TEMPLATE rather than a callable
 *  URL. Rides on every accessor that projects a route, deliberately: this file
 *  already warns that a field present on two of three surfaces is inert on
 *  whichever one happens to render, and that is exactly what happened here -
 *  the flag existed only in routeQuery, so /api/index kept advertising a
 *  seller's placeholder path at $0.02 with nothing to say it could never pay.
 *  We still RETURN the row (the seller and the tool are real, and an agent that
 *  knows the parameter can substitute it); we just stop implying it is payable. */
function urlTemplateProjection(t) {
  const route = String(t?.route || "");
  if (!URL_TEMPLATE_RE.test(route)) return {};
  return {
    urlTemplate: true,
    pathParams: [...route.matchAll(URL_TEMPLATE_RE_G)].map((m) => m[1] || m[2] || m[3]).filter(Boolean),
  };
}

/** Can we actually READ a price for this route?
 *
 *  `/api/route` has published `priceUsd` since long before this, computed by
 *  parsePrice, which returns 0 for anything it cannot parse. So a route whose
 *  price we failed to read is advertised at zero - "free" - and a consumer has
 *  no way to tell that from a genuinely free route. Measured live 2026-09-21:
 *  16 of 286 distinct external rows read priceUsd 0, and 14 of them carry
 *  `price: null`, meaning we never read a price at all. The other two are
 *  "$free" and really are free.
 *
 *  The file already knew. priceToMicroUsd's own comment, three lines below
 *  parsePrice, says its null is deliberate and "never parsePrice's 0, which
 *  would publish 'free' for 'we could not read it'". The right reader existed
 *  and this surface kept calling the wrong one.
 *
 *  NOT FIXED BY CHANGING priceUsd. Someone is reading that field today and a
 *  0 turning into null breaks them; publishing a wrong number is our mistake
 *  to disclose, not theirs to absorb. So priceUsd keeps its meaning exactly,
 *  on every surface, and this says whether to believe it. `priceKnown: false`
 *  means we could not read a price and the 0 is our ignorance, not the
 *  seller's price.
 *
 *  Uses priceToMicroUsd rather than a second parser, so "known" here means the
 *  same thing the crawler means when it compares a declaration to a learned
 *  quote - including the object shapes ({usd}, {amountMinor}) that parsePrice
 *  reads as zero. */
function priceKnownProjection(t) {
  // `freeObserved`: the route answered an unpaid GET with a 200 - no paywall on
  // it when we last looked, which is a fact about the route, not ignorance.
  // Additive and only present when true.
  return { priceKnown: priceToMicroUsd(t?.price) != null, ...(isObservedFree(t) ? { freeObserved: true } : {}) };
}
function isObservedFree(t, now = Date.now()) {
  const at = Number(t?.freeObservedAt || t?.quoteRetiredAt);
  return t?.quoteSource === "live-200" && Number.isFinite(at) && at > 0 && now - at < QUOTE_MAX_AGE_MS;
}

function priceConflictProjection(t) {
  if (t?.priceConflict !== true || !t.priceObservations) return {};
  const bazaar = priceToMicroUsd(t.priceObservations.bazaar);
  const origin = priceToMicroUsd(t.priceObservations.origin);
  if (bazaar == null || origin == null) return {};
  return {
    priceConflict: true,
    priceObservations: { bazaar: microUsdToPrice(bazaar), origin: microUsdToPrice(origin) },
  };
}

// Tie-break rank for price. parsePrice maps unknown (null / unparseable) to 0
// for display, which is right for priceUsd but wrong for ranking: it let
// listings with NO published amount masquerade as "free" and outrank sellers
// honest enough to publish one (observed live: two price-less sellers
// tie-broke above a $0.005 seller on an equal match score). Known prices
// compare by value — an explicit $0 is genuinely free and still wins —
// unknown ranks last among equals.
// Can a buyer actually PAY for this row over x402, or only find it?
//
// A seller reported (#645) that two of their listed endpoints are real products
// but key-gated: a well-formed call returns 401 with a "get a free key" pointer,
// never a 402 with a challenge. An agent that routes there to pay has nothing to
// pay against. They asked for "sellable via x402" to be distinguishable from
// "sellable, other rail", and they were right that it generalises - key-gated
// and subscription endpoints are all over the index.
//
// What this deliberately does NOT do is reorder on it. Measured across all
// 65,462 rows, only 47.8% carry any payability evidence at all; 52.2% have
// none. Demoting everything without evidence would bury half the ecosystem for
// absence of evidence rather than evidence of absence, and most of those rows
// are ordinary sellers whose price simply was not in the surface we read. So
// this reports, and the consumer decides.
//
// "evidence" means one of:
//   * a price above zero, which only a paid surface advertises, or
//   * networks on the row, which come from a registry accepts array and mean
//     somebody settled against it.
// Anything else is UNKNOWN, which is honestly what we have. It is not "no".
export function payabilityOf(t) {
  const usd = priceRank(t?.price);
  if (Number.isFinite(usd) && usd > 0) return "x402";
  if (Array.isArray(t?.networks) && t.networks.length) return "x402";
  return "unknown";
}

function priceRank(p) {
  if (p == null) return Infinity;
  if (typeof p === "number") return isFinite(p) ? p : Infinity;
  const s = String(p).replace(/[^0-9.]/g, "");
  if (!s) return Infinity;
  const n = parseFloat(s);
  return isFinite(n) ? n : Infinity;
}

// Convert a single Bazaar resource entry into the tool shape used by the rest
// of the index. Bazaar gives us the resource URL, the accepts array (with
// per-network price/asset), an optional serviceName, description, and tags.
// We deliberately keep the price in atomic USDC units → USD here so the router
// can compare across sellers without a per-network price lookup.
// Exported for offline merge-contract tests alongside normaliseOpenapiTools.
// PayAI's open registry (and occasionally others) carries `network` as a bare
// shorthand string ("base", "solana") instead of proper CAIP-2
// ("eip155:8453", "solana:5eykt4Us...") on some listings - every downstream
// CHAIN_PAGES isNetwork exact-match then fails silently, so the seller is
// indexed (shows on /marketplace) but invisible on its own chain's page.
// Measured live 2026-08-13: sellers publishing bare network names ("base",
// "solana"), ~72 of 1,000 sampled discovery resources affected. Built from CHAIN_PAGES itself (networkParam -> that
// chain's real mainnet id) rather than a hand-maintained list, so a future
// chain addition is covered automatically with no second edit required here.
const NETWORK_SHORTHAND = new Map(Object.values(CHAIN_PAGES).map((C) => [C.networkParam, C.acceptNetwork]));
function normalizeNetwork(n) {
  if (typeof n !== "string") return n;
  return NETWORK_SHORTHAND.get(n.toLowerCase()) || n;
}

/**
 * WHERE a row's payTo for one network came from (2026-10-03).
 *
 *   "live"     - the origin's own 402 named it (applyLivePayTo)
 *   "origin"   - the origin's own documents named it (manifest, OpenAPI,
 *                agents.json, a single-resource manifest)
 *   "registry" - only a third party's listing carries it (a Bazaar row: the
 *                address a payment settled to when the registry recorded it)
 *
 * Stamped explicitly in `payToSourceByNetwork` wherever a merge writes a payTo
 * from a source other than the row's own; otherwise read from the row's
 * provenance (a Bazaar row's addresses are the registry's, every other row was
 * read from the origin). Rows persisted before the stamp existed read the same
 * way, which is right for every one of them except a registry row a live read
 * had corrected - that one is re-corrected by the origin's own documents on the
 * next crawl, or by the next live read.
 *
 * Why it exists: the seller-level payTo was "first seen per network wins" over
 * a tool list whose Bazaar rows come first, and a merge filled the origin's own
 * address only where a row held none. A seller who moved to a new wallet kept
 * the old one published as its Base payTo for as long as one Bazaar row still
 * recorded a payment to it, and a re-registration that read the live 402 was
 * undone by the next crawl (reported 2026-10-03: the router label then read the
 * abandoned wallet as the seller's own and refused it as evidence_payto_mismatch).
 * Same rule as the price: the origin's own current word wins over a registry's
 * record, and a registry address only fills a network the origin names nothing on.
 */
export function payToSourceOf(row, net) {
  const s = row?.payToSourceByNetwork?.[net];
  if (s === "live" || s === "origin" || s === "registry") return s;
  return row?.provenance === "bazaar" ? "registry" : "origin";
}
const ownPayToSource = (s) => s === "live" || s === "origin";

/** Write one network's payTo onto a row with its source. Fresh objects only:
 *  rows on one path can share their maps (see applyLivePayTo). */
function setRowPayTo(row, net, addr, source) {
  row.payToByNetwork = { ...(row.payToByNetwork || {}), [net]: addr };
  row.payToSourceByNetwork = { ...(row.payToSourceByNetwork || {}), [net]: source };
}

/** The seller-level payTo per network over a tool list: an address the origin
 *  itself named (its documents or its live 402) wins; an address only a
 *  registry row carries fills a network the origin names nothing on. Within a
 *  class the first seen still wins, as before. Every address stays listed in
 *  `payTosByNetwork` (allPayTosByNetwork), so a wallet the seller once used
 *  remains visible as the history it is. */
export function sellerPayToByNetwork(tools) {
  const own = {}, registry = {};
  for (const t of tools || []) {
    for (const [net, addr] of Object.entries(t?.payToByNetwork || {})) {
      if (typeof addr !== "string" || !addr) continue;
      const bucket = ownPayToSource(payToSourceOf(t, net)) ? own : registry;
      if (!bucket[net]) bucket[net] = addr;
    }
  }
  return { ...registry, ...own };
}

/**
 * Everything an `accepts` array says about money, in the shape an index row
 * carries it: price, chains, payTo per chain, the EIP-712 domain per chain.
 *
 * Lifted out of `bazaarItemToTool` so the MANIFEST reader can derive the same
 * fields from the same code. A seller who publishes their payment terms inside
 * a catalogue entry (`resources[].accepts`, or `resources[].network` flat) was
 * read for its URL, name and price string and for nothing else, so the row
 * came out chainless and the seller landed on `network_unknown` — listed and
 * unroutable, the same defect class as the single-resource manifest above and
 * the same cost. Sharing the derivation is what keeps a manifest row and a
 * Bazaar row describing one endpoint from disagreeing about what it costs.
 */
export function paymentFieldsFromAccepts(rawAccepts) {
  // Normalized ONCE here so every downstream read (the `preferred` accept
  // below, `networks:`, `stellarPayTo`, `algorandPayTo`, `payToByNetwork`)
  // sees a real CAIP-2 id without each site needing its own fix.
  const accepts = (Array.isArray(rawAccepts) ? rawAccepts : []).map((a) =>
    a && typeof a.network === "string" ? { ...a, network: normalizeNetwork(a.network) } : a
  );
  // Prefer the first Base USDC accept; fall back to any USDC; fall back to first.
  const preferred =
    accepts.find((a) => a?.network === "eip155:8453" && /USDC|USD Coin/i.test(a?.extra?.name || "")) ||
    accepts.find((a) => /USDC|USD Coin/i.test(a?.extra?.name || "")) ||
    accepts[0] ||
    null;
  let price = null;
  // `amount` is the x402 v2 field; `maxAmountRequired` is the v1 spelling and
  // the one most flat-`resources` manifests still publish. Reading only the
  // first left those rows priceless AND cost the live-402 probe that would
  // have learned the figure the origin already declared.
  const amount = preferred?.amount ?? preferred?.maxAmountRequired;
  if (amount != null) {
    // amount is an atomic-units string; USDC has 6 decimals.
    const n = Number(amount);
    if (Number.isFinite(n)) price = n / 1e6;
  }
  return {
    price,
    // Every chain this resource's 402 advertises — the signal behind the
    // router's ?network= filter ("who else settles on Robinhood Chain?").
    networks: [...new Set(accepts.map((a) => a?.network).filter(Boolean))],
    // Stellar payTo from the accepts — feeds /stellar's per-seller activity
    // scan. Kept raw here; the snapshot validates the strkey shape before use.
    stellarPayTo: accepts.find((a) => typeof a?.network === "string" && a.network.startsWith("stellar") && !a.network.includes("test"))?.payTo || null,
    // Algorand payTo — same idea, feeds /algorand's per-seller activity scan.
    // Mainnet-only: the CAIP-2 prefix distinguishes mainnet
    // (algorand:wGHE2Pwd…) from testnet (algorand:SGO1GKSz…) — an
    // includes("test") check would miss a testnet id that happens not to
    // contain the literal substring "test".
    algorandPayTo: accepts.find((a) => typeof a?.network === "string" && a.network.startsWith("algorand:wGHE2Pwd"))?.payTo || null,
    // payTo keyed by advertised CAIP-2 network — feeds every market page's
    // per-seller activity scan (the page looks up the payTo whose network
    // matches the chain being viewed). Stellar/Algorand keep their dedicated
    // strkey-validated fields above; this covers the EVM chains + Solana, whose
    // /base, /polygon, /arbitrum, /solana pages had no per-seller address to
    // scope to. Shape is validated by getActivityForChain before any RPC call.
    payToByNetwork: Object.fromEntries(
      accepts
        .filter((a) => typeof a?.network === "string" && typeof a?.payTo === "string" && a.payTo)
        .map((a) => [a.network, a.payTo])
    ),
    // The EIP-712 domain each EVM accept advertises (asset + extra.name). A
    // Base accept naming "USDC" where the token signs under "USD Coin" is a
    // challenge no stock buyer can pay; the router label reads this to say so
    // (src/evm-usdc-domain.js). Omitted when no EVM accept carries a name.
    ...(Object.keys(evmDomainsOfAccepts(accepts)).length ? { evmDomainByNetwork: evmDomainsOfAccepts(accepts) } : {}),
  };
}

export function bazaarItemToTool(item, originUrl) {
  // `resource` = CDP Bazaar; `resourceUrl` = GoPlausible's AVM registry.
  const resource = item.resource || item.resourceUrl || item.url;
  if (typeof resource !== "string" || !resource.startsWith(originUrl)) return null;
  // A segment boundary after the key: "https://host" must not own
  // "https://hostile.example/...", nor a path seller "/app/x" own "/app/x2".
  if (!isUnderSeller(resource, originUrl)) return null;
  const pay = paymentFieldsFromAccepts(item.accepts);
  let pathStr = "/";
  try {
    pathStr = new URL(resource).pathname || "/";
  } catch {
    /* keep "/" */
  }
  // A path seller's routes are relative to its prefix.
  const scopedHere = Boolean(sellerPrefixOf(originUrl));
  if (scopedHere) {
    const scoped = scopeRouteToSeller(originUrl, pathStr);
    // The prefix root is kept for a registry row that carries payment terms:
    // such a row is minted by a settled payment, so it is a paid route, not a
    // landing page (see scopeRowsToSeller).
    if (scoped == null || (scoped === "/" && !rowDeclaresPayment(pay))) return null;
    pathStr = scoped;
  }
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const methodInferred = !(typeof item.method === "string" && item.method);
  // Bazaar entries don't always carry a method (GoPlausible's do); assume POST
  // if we can't tell. The router treats this as a hint and respects a 405 retry.
  return {
    seller: originUrl,
    method: methodInferred ? "POST" : item.method.toUpperCase(),
    methodInferred,
    route: pathStr,
    slug: pathStr.replace(/^\//, "").replace(/\//g, "-") || originUrl.replace(/^https?:\/\//, ""),
    name: item.serviceName || pathStr,
    description: item.description || "",
    category: tags[0] || "other",
    tags,
    ...pay,
    provenance: "bazaar",
    ...(scopedHere ? { [SCOPED_ROW]: true } : {}),
    // Coinbase-measured 30-day usage of THIS resource (null when absent).
    quality: item.quality && typeof item.quality === "object"
      ? { calls30d: Number(item.quality.l30DaysTotalCalls) || 0, payers30d: Number(item.quality.l30DaysUniquePayers) || 0, lastCalledAt: typeof item.quality.lastCalledAt === "string" ? item.quality.lastCalledAt : null }
      : null,
  };
}

// Exported for the offline crawler contract test. Keeping this pure makes the
// exact OpenAPI -> index row mapping testable without network I/O.
/** The path prefix an OpenAPI document's `paths` are relative to.
 *
 *  OpenAPI paths are relative to `servers[].url`, so a document declaring
 *  server `https://host/api` and path `/foo` describes the endpoint
 *  `https://host/api/foo`. We ignored this, recorded the route as `/foo`, and
 *  then failed to match it against the real `/api/foo` that Bazaar/PayAI
 *  discovery reports — so mergeOpenapiIntoBazaar never fired and the seller's
 *  summary, description and tags were dropped. Their tools stayed in the index
 *  with an empty description and the raw path as their name, which the Smart
 *  Order Router can only rank on path tokens. Found via Cloud World Model,
 *  whose 106 endpoints were invisible to every semantic query (2026-07-26).
 *
 *  Prefers a server whose origin matches the seller we are indexing; falls back
 *  to the first usable entry. Relative server URLs ("/api") are honoured too. */
export function openapiBasePath(openapi, originUrl) {
  const servers = Array.isArray(openapi?.servers) ? openapi.servers : [];
  let origin = null;
  try { origin = new URL(originUrl).origin; } catch { /* originUrl may be a bare host */ }
  const candidates = servers.map((s) => (typeof s === "string" ? s : s?.url)).filter((u) => typeof u === "string" && u);
  const pick =
    (origin && candidates.find((u) => { try { return new URL(u).origin === origin; } catch { return false; } })) ||
    candidates.find((u) => u.startsWith("/")) ||
    candidates[0];
  // A path seller whose document names no server: its paths are relative to
  // the prefix it is served under (the rows are then scoped back to it). A
  // document naming another server is honoured and scoped as usual.
  if (!pick) return sellerPrefixOf(originUrl);
  let path;
  // A relative server URL resolves against where the document is served: for a
  // path seller that is its prefix, for a bare origin the root (as before).
  const docBase = sellerPrefixOf(originUrl) ? `${originUrl}/` : (origin || "https://x.invalid");
  try { path = new URL(pick, docBase).pathname; } catch { return ""; }
  path = path.replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

export function normaliseOpenapiTools(openapi, originUrl) {
  return scopeRowsToSeller(normaliseOpenapiToolsUnscoped(openapi, originUrl), originUrl);
}
function normaliseOpenapiToolsUnscoped(openapi, originUrl) {
  if (!openapi || typeof openapi !== "object" || !openapi.paths) return [];
  const base = openapiBasePath(openapi, originUrl);
  const documentDistinguishesPaidOperations = openapiHasPaymentSignal(openapi);
  logUnknownPaymentKeys(openapi, originUrl);
  const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
  const nonToolPath =
    /^\/(\.well-known|health|openapi|llms|sitemap|robots|favicon|admin|internal)|\.(png|ico|svg|txt|xml)$/i;
  const out = [];
  for (const [rawPath, methods] of Object.entries(openapi.paths)) {
    // Apply the basePath unless the document already spells it out (some specs
    // repeat the prefix in every path even though servers declares it).
    const pathStr = base && !rawPath.startsWith(base + "/") && rawPath !== base ? base + rawPath : rawPath;
    for (const [method, op] of Object.entries(methods || {})) {
      if (!httpMethods.has(method.toLowerCase())) continue;
      if (!op || typeof op !== "object") continue;
      // A seller that annotates any paid operation is trusted to distinguish
      // paid from free siblings — but the free siblings are still part of the
      // curated surface they publish, so they LIST (marked paid:false) rather
      // than vanish. Hiding them made a 42-operation seller read as 17 while
      // x402scan showed all 42 (seller escalation, 2026-07-27). What the
      // annotation gate now controls is the `paid` flag, which in turn gates
      // paid ROUTING — a free op must never be a buy candidate. Deprecated
      // operations and obvious discovery/static-asset paths are excluded in
      // all cases (the junk #478 was aimed at). Zero-annotation documents
      // retain the legacy inclusive behavior with `paid` unknown, because
      // many settlement-proven sellers do not use payment extensions yet.
      if (nonToolPath.test(rawPath) || nonToolPath.test(pathStr)) continue;
      if (op.deprecated === true) continue;
      // One reader for every annotation dialect (see openapiOperationPayment):
      // price, paid/free, the chains and the payTo the operation declares.
      const pay = openapiOperationPayment(op);
      const tags = Array.isArray(op.tags) ? op.tags : [];
      out.push({
        seller: originUrl,
        method: method.toUpperCase(),
        route: pathStr,
        slug: op.operationId || pathStr.replace(/^\//, "").replace(/\//g, "-"),
        name: op.summary || op.operationId || pathStr,
        // Capped like the Bazaar and llms.txt paths (400): the description feeds
        // the route haystack and the postings vocabulary, and an OpenAPI document
        // is the one ingest path where a seller controls a field of any length.
        description: String(op.description || "").slice(0, 400),
        category: tags[0] || "other",
        tags,
        price: pay.price,
        // An x-price in the origin's OWN OpenAPI is the origin declaring a
        // price, so stamp the anchor here rather than only in the Bazaar merge.
        //
        // Without it the anti-ratchet correction is inert: it re-probes a route
        // whose learned price disagrees with the declaration, and with no
        // declaration there is nothing to disagree with. Measured across 41
        // indexed sellers carrying priced rows, 38 had no anchor at all - so
        // the correction built in August and again in September was dead for
        // about 93% of them, silently, because a stale price is invisible to us
        // and visible only to the seller reading their own listing. All three
        // reports of it arrived by email for exactly that reason.
        //
        // Same normalisation as the manifest path: an x-price is usually a
        // display string ("$0.032"), and a bare Number() on that yields NaN and
        // skips the stamp without a sound.
        ...(() => {
          const micro = priceToMicroUsd(pay.price);
          return micro != null && micro > 0 ? { originDeclaredPrice: microUsdToPrice(micro) } : {};
        })(),
        ...(pay.networks.length ? { networks: pay.networks } : {}),
        ...(Object.keys(pay.payToByNetwork).length ? { payToByNetwork: pay.payToByNetwork } : {}),
        // In a document that distinguishes paid operations, an unannotated
        // sibling is free (paid:false) - the seller's own free routes list
        // rather than vanish. An explicit `x-payment-required: false` reads
        // free the same way; a priced or payment-declared op reads paid.
        ...(documentDistinguishesPaidOperations ? { paid: pay.paid ?? false } : {}),
        // What this operation's own document GUARANTEES on success. Stored as
        // a compact tuple (the public object repeats a constant source string
        // and a constant false on every one of tens of thousands of rows), and
        // omitted entirely when there is nothing to report. A parse failure
        // here must never cost the seller their listing, so it is caught per
        // operation rather than escaping into crawlSeller's manifest-only
        // handler.
        ...(() => {
          try {
            const packed = packResponseContract(responseContractOf(resolveLocalRefs(op, openapi)));
            return packed ? { responseContract: packed } : {};
          } catch { return {}; }
        })(),
        // What a buyer must SEND. Same per-operation try/catch: a parse failure
        // must cost this operation its tuple, never the seller their listing.
        ...(() => {
          try {
            const packed = packRequestContract(requestContractOf(resolveLocalRefs(op, openapi)));
            return packed ? { requestContract: packed } : {};
          } catch { return {}; }
        })(),
      });
    }
  }
  return out;
}

// Read the catalogue a seller publishes INSIDE their own manifest.
//
// Until now /.well-known/x402 was read for identity and payment only: the tool
// list came from the seller's openapi.json plus registry rows, and a manifest
// that itself enumerated every endpoint was parsed and then thrown away. A
// seller reported being "listed thinly" (#645) while their manifest carried a
// complete 17-entry catalogue with names, prices and summaries. Sampling 44
// reachable manifest-sourced sellers found 5 advertising more entries than we
// listed - one publishing 14 while we showed 1.
//
// There is no single shape in the wild, so this is deliberately tolerant about
// FORM and strict about ATTRIBUTION. Observed dialects, all handled:
//   "tools":     [{name, endpoint, price_usd, summary}]
//   "resources": ["https://origin/api/thing"]
//   "resources": ["POST /exchange/sell-clams"]
//   "resources": [{resource|url|route|path, description, price}]
//   "endpoints": [{path, methods, name, price, description}]  // Agente Jefe shape
//
// SAME-ORIGIN ONLY, and that is the load-bearing rule. Some manifests list
// other people's origins (an aggregator pointing outward); attributing those
// to the publisher would put another seller's tools under this seller's payTo,
// which is a routing and payment error, not a cosmetic one. Those origins are
// crawled on their own account anyway. Same reasoning as the llms.txt parser:
// a thin listing is recoverable, a fabricated one is not.
//
// ALL catalogue keys are read, not just the first non-empty. Taking only
// `resources` when `endpoints` also exists (first-wins) threw away names,
// prices and descriptions on sellers that publish both — measured on
// one seller: thin "POST /v1/…" strings shadowed a rich
// endpoints[] catalogue, so the index showed payable tools with empty
// descriptions. Merge every dialect; when the same method+route appears
// twice, keep the richer row and fill blanks from the other. Path-level
// metadata from a rich object also enriches sibling methods on that path
// (GET+POST strings + one priced endpoint object → both methods priced).
const MANIFEST_NON_TOOL_PATH =
  /^\/(\.well-known|health|openapi|llms|sitemap|robots|favicon|admin|internal)|\.(png|ico|svg|txt|xml)$/i;
const MANIFEST_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

function manifestToolRichness(t) {
  if (!t) return 0;
  const named = t.name && t.name !== t.route && !String(t.name).startsWith("/");
  return (t.price ? 4 : 0) + (t.description ? 2 : 0) + (named ? 2 : 0) + (t.method ? 1 : 0);
}

function mergeManifestToolRows(a, b) {
  if (!a) return b;
  if (!b) return a;
  const prefer = manifestToolRichness(a) >= manifestToolRichness(b) ? a : b;
  const other = prefer === a ? b : a;
  const named = (n, route) => n && n !== route && !String(n).startsWith("/");
  return {
    ...prefer,
    ...(requestContractStrength(other.requestContract) > requestContractStrength(prefer.requestContract) ? { requestContract: other.requestContract } : {}),
    name: named(prefer.name, prefer.route) ? prefer.name : (named(other.name, other.route) ? other.name : prefer.name),
    description: prefer.description || other.description || "",
    price: prefer.price || other.price || null,
    slug: (prefer.slug && prefer.slug !== prefer.route) ? prefer.slug : (other.slug || prefer.slug),
    method: prefer.method || other.method,
    // Richness is measured on price/description/name, so the row that wins can
    // easily be the chainless one: two entries for the same method+route where
    // only the thin one carries `accepts`. Blank-fill the payment fields the
    // same way, or the merge itself re-creates the network_unknown it just fixed.
    ...(prefer.networks?.length ? {} : (other.networks?.length ? { networks: other.networks } : {})),
    ...(Object.keys(prefer.payToByNetwork || {}).length ? {}
      : (Object.keys(other.payToByNetwork || {}).length ? { payToByNetwork: other.payToByNetwork } : {})),
    ...(prefer.stellarPayTo ? {} : (other.stellarPayTo ? { stellarPayTo: other.stellarPayTo } : {})),
    ...(prefer.algorandPayTo ? {} : (other.algorandPayTo ? { algorandPayTo: other.algorandPayTo } : {})),
    ...(prefer.evmDomainByNetwork ? {} : (other.evmDomainByNetwork ? { evmDomainByNetwork: other.evmDomainByNetwork } : {})),
  };
}

/**
 * `amount` / `maxAmountRequired` on an ACCEPT-SHAPED entry are ATOMIC UNITS of
 * the asset, never dollars. Reading them as a scalar price published the
 * seller's own listing at a million times its real figure - measured live
 * 2026-09-15 on one seller, whose $0.10 route read **$100000**
 * in the index (`resources: [{scheme, network, asset, amount: "100000", ...}]`,
 * six-decimal USDC). An entry that names a network, an asset or a scheme is
 * quoting the x402 accept shape and its amount goes through the accepts
 * reader, which divides by the decimals; a manifest that carries a bare
 * `amount` with no payment context still means dollars and is read as before.
 * Same failure direction as the 2026-08-29 price ratchet (#1043): an overquote
 * a seller cannot see, on their own listing.
 */
function acceptShaped(raw) {
  return !!raw && typeof raw === "object"
    && (typeof raw.network === "string" || typeof raw.asset === "string" || typeof raw.scheme === "string"
      || typeof raw.payTo === "string" || typeof raw.maxAmountRequired === "string" || Array.isArray(raw.accepts));
}

/**
 * An AMOUNT beside PAYMENT CONTEXT is base units of a token, never dollars
 * (2026-09-22). Two live shapes still read atomic figures as dollars after the
 * 2026-09-15 fix, because that one recognised the accept shape at the ENTRY
 * level only:
 *   - a manifest price OBJECT, `price: { amount: "3000", asset: <Base USDC>,
 *     decimals: 6, display: "$0.003" }`, was listed at $3000 (the object path
 *     took `amount` as dollars and never read `decimals`, `asset` or `display`);
 *   - MPP's discovery shape in an OpenAPI operation, `x-payment-info: {
 *     amount: "5000", currency: <Tempo USDC.e>, method: "tempo", intent:
 *     "charge", offers: [...] }`, was listed at $5000 instead of $0.005.
 * Payment context is `decimals`, an `asset`, or a `currency` beside an MPP
 * `method`/`intent`. A bare `currency: "USDC"` beside an amount is NOT context:
 * catalogues publish `{ amount: "0.032", currency: "USDC" }` meaning dollars.
 * A fractional figure is never base units, so it keeps its dollar reading.
 * Decimals are the declared ones, else 6 for the stablecoins every rail here
 * settles in (USDC on any chain, Tempo USDC.e and PathUSD), else NOTHING: a
 * token we cannot size is a price we do not publish (the live-402 probe learns
 * it), because a wrong exponent is the same million-fold error by another road.
 */
const SIX_DECIMAL_TICKER = /^(usdc|usd coin|usdc\.e|pathusd)$/i;
// Each id as its chain publishes it, lowercased HERE rather than by hand: the
// first cut typed the Solana mint out in lower case and got one letter wrong,
// which reads as "we cannot size this token" and publishes no price at all.
const SIX_DECIMAL_ASSETS = new Set([
  ...EVM_TOKEN_DOMAINS.filter((d) => d.symbol === "USDC").map((d) => d.asset),
  "0x20C000000000000000000000b9537d11c60E8b50", // Tempo USDC.e
  "0x20c0000000000000000000000000000000000000", // Tempo PathUSD
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // Solana USDC mint
].map((a) => a.toLowerCase()));
/** Six, when this object names a token we RECOGNISE as dollar-pegged. Null
 *  otherwise, which is the whole gate: sizing an amount by decimals only turns
 *  base units into DOLLARS if the token is a dollar. */
function dollarPeggedDecimalsOf(obj) {
  for (const id of [obj?.asset, obj?.currency, obj?.asset_address, obj?.assetAddress, obj?.symbol, obj?.extra?.name]) {
    if (typeof id !== "string" || !id.trim()) continue;
    const v = id.trim();
    if (SIX_DECIMAL_TICKER.test(v) || SIX_DECIMAL_ASSETS.has(v.toLowerCase())) return 6;
  }
  return null;
}
function declaredDecimalsOf(obj) {
  const d = obj?.decimals;
  if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 36) return d;
  if (typeof d === "string" && /^\s*\d{1,2}\s*$/.test(d) && Number(d) <= 36) return Number(d);
  return null;
}
/** Decimals to divide an amount by, or null to publish no price at all.
 *
 *  A DECLARED `decimals` used to be enough on its own, which made the seller's
 *  own field the whole rule for ANY asset: `{ amount: "5000", decimals: 18,
 *  asset: <some token> }` published 0.000000000000005 as a DOLLAR price of a
 *  token that is not a dollar, and the same field set to 2 would have published
 *  $50. Decimals say how to READ an amount, never what it is worth, so the
 *  token has to be one we recognise as dollar-pegged first; anything else is a
 *  price the live-402 probe learns rather than one we invent.
 *
 *  A declaration that CONTRADICTS the chain (USDC is six decimals on every rail
 *  we settle) is not a tie we get to break: publish nothing. */
function tokenDecimalsOf(obj) {
  const pegged = dollarPeggedDecimalsOf(obj);
  if (pegged == null) return null;
  const declared = declaredDecimalsOf(obj);
  if (declared != null && declared !== pegged) return null;
  return pegged;
}
/** An asset IDENTIFIER - an EVM address, a Solana mint, a CAIP-19 id - rather
 *  than a ticker. Payment context is the identifier: a ticker is a word a
 *  catalogue writes beside a dollar figure. */
function looksLikeAssetIdentifier(v) {
  if (typeof v !== "string") return false;
  const id = v.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(id) || /^0x[0-9a-fA-F]{64}$/.test(id)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) return true; // base58 mint
  return id.includes(":") && /[/:][^\s:/]{6,}$/.test(id);   // caip-19 and friends
}
function atomicContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.decimals != null) return true;
  // A TICKER IS NOT PAYMENT CONTEXT, in whichever field it is written. The rule
  // was applied to `currency` and not to `asset`, so one declaration read three
  // ways: `{ amount: 2, currency: "USDC" }` was $2, `{ amount: 2, symbol:
  // "USDC" }` was $2, and `{ amount: 2, asset: "USDC" }` was $0.000002 - a
  // millionfold under-quote on a seller's listing, arrived at from the same
  // sentence. An asset field carrying a real identifier still states base
  // units, which is what an x402 accept carries and what every case this
  // machinery was built for looks like.
  if (looksLikeAssetIdentifier(obj.asset)) return true;
  return typeof obj.currency === "string" && !!obj.currency.trim()
    && (typeof obj.method === "string" || typeof obj.intent === "string");
}
/** The dollar figure an amount in atomic context stands for: a number, the
 *  fractional figure itself when it cannot be base units, or null for a token
 *  whose decimals we cannot know. */
function atomicAmountToDollars(obj, amount) {
  const whole = typeof amount === "number" ? (Number.isInteger(amount) && amount >= 0)
    : (typeof amount === "string" && /^\s*\d+\s*$/.test(amount));
  if (!whole) {
    const frac = typeof amount === "number" ? Number.isFinite(amount) && amount >= 0
      : (typeof amount === "string" && /^\s*\d*\.\d+\s*$/.test(amount));
    return frac ? amount : null;
  }
  const decimals = tokenDecimalsOf(obj);
  if (decimals == null) return null;
  const usd = Number(String(amount).trim()) / 10 ** decimals;
  // Only a figure that writes out as a plain decimal. JS renders anything from
  // 1e21 up (and below 1e-6) in exponent notation, and every price reader
  // downstream takes a STRING: "$1e+21" parses to null in our own reader and to
  // some unrelated number in any reader that strips punctuation. A price we
  // cannot write down is a price we do not publish.
  if (!Number.isFinite(usd) || /e/i.test(String(usd))) return null;
  return usd;
}
/** An explicit DOLLAR label (`display`, `amountLabel`) the seller wrote for
 *  humans: preferred over any figure we would have to convert. Taken only when
 *  it reads as one dollar amount ("$0.003", "0.003 USDC"), never a sentence. */
function dollarLabelOf(obj) {
  for (const v of [obj?.display, obj?.amountLabel]) {
    if ((typeof v === "string" || typeof v === "number") && priceToMicroUsd(v) != null) return v;
  }
  return null;
}

function parseManifestPrice(raw) {
  let p = raw?.price_usd ?? raw?.priceUsd ?? raw?.price ?? null;
  // An entry whose own amount sits beside payment context: a label first,
  // else base units. Accept-shaped entries keep their old rule (the accepts
  // reader prices them); MPP-shaped ones (currency + method/intent) had none.
  if (p == null && raw?.amount != null && !acceptShaped(raw)) {
    p = atomicContext(raw) ? (dollarLabelOf(raw) ?? atomicAmountToDollars(raw, raw.amount)) : raw.amount;
  }
  // A `price` that is an OBJECT is a richer, entirely legitimate manifest shape:
  // the seller carries scheme/network/asset/payTo per resource and puts the
  // figure inside it. We only read scalars, so such a manifest normalised to
  // price: null - which costs a live-402 probe to learn what the origin already
  // said, and, worse, never stamps `originDeclaredPrice`. That stamp is the
  // anchor the 2026-08-29 anti-ratchet fix hangs on: without it a learned quote
  // for that seller can only age out on the 7-day clock instead of being
  // corrected against the origin's own current declaration. Found reviewing a
  // seed PR whose manifest used `price: { amountUsd: "0.01", ... }`.
  // The Array check is a BELT, not load-bearing: an array carries none of the
  // keys below, so descending into one already yields null. Kept so the intent
  // survives a future edit to that key list, and noted because no mutation can
  // kill it - the test asserts the OUTCOME (an array declares nothing) instead.
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const o = p;
    p = o.amountUsd ?? o.priceUsd ?? o.price_usd ?? dollarLabelOf(o) ?? null;
    if (p == null) {
      const fig = o.amount ?? o.value;
      if (fig != null) p = atomicContext(o) ? atomicAmountToDollars(o, fig) : fig;
    }
  }
  if (typeof p === "number" && Number.isFinite(p)) return `$${p}`;
  if (typeof p === "string" && p.trim()) return p.trim().startsWith("$") ? p.trim() : `$${p.trim()}`;
  return null;
}

/**
 * Read an x402 v2 SINGLE-RESOURCE manifest: a top-level `resource` plus
 * `accepts`, and no catalogue array at all.
 *
 * This is the spec's own 402 response body served as the manifest, which is a
 * natural reading of x402 and not an odd one - but every catalogue reader here
 * looks for an ARRAY (tools/resources/endpoints/services), so a manifest whose
 * `resource` is a single object fell through all of them and we read the
 * seller's payment terms not at all. Found live 2026-08-24 on a seller who had
 * asked to be listed (#907): we listed them from their OpenAPI with 7 tools and
 * `network: null`, so they appeared on the marketplace but the router could
 * never chain-match them - listed and unroutable, which is worse than absent
 * because it looks like it worked.
 *
 * `resource` is accepted as a bare URL string or as the spec's object form.
 * Everything else - the price, the chains, the payTo per chain - is derived by
 * the same `accepts` reader the Bazaar path uses, so a manifest and a Bazaar
 * row describing one endpoint cannot disagree about what it costs.
 */
export function singleResourceManifestTool(manifest, originUrl) {
  const r = manifest?.resource;
  const url = typeof r === "string" ? r : (typeof r?.url === "string" ? r.url : null);
  if (!url) return null;
  if (!Array.isArray(manifest?.accepts) || !manifest.accepts.length) return null;
  const meta = (r && typeof r === "object") ? r : {};
  const tool = bazaarItemToTool({
    resource: url,
    accepts: manifest.accepts,
    serviceName: meta.serviceName || manifest.serviceName || "",
    description: meta.description || manifest.description || "",
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    method: meta.method || manifest.method,
  }, originUrl);
  if (!tool) return null;
  // Provenance is the seller's own manifest, not a registry that observed them.
  return { ...tool, provenance: "manifest" };
}

/**
 * The payment terms a CATALOGUE ENTRY declares, as an `accepts` array.
 *
 * Three shapes are published in the wild besides the single-resource one, and
 * the catalogue loop below read none of them — it took the entry's URL, name,
 * description and price string and dropped everything about money:
 *
 *   resources: [{ resource, accepts: [{network, asset, payTo, …}] }]   nested
 *   resources: [{ resource, scheme, network, asset, payTo, amount }]   flat
 *   payment:   { network, asset_address, pay_to, … }                   service-wide
 *
 * The service-wide block is a manifest-level default: it applies to every
 * catalogue row that declares no payment of its own, which is exactly how the
 * sellers publishing it mean it (one service, one chain, many routes).
 *
 * Measured against the live index 2026-09-15: of the 304 sellers the router
 * labelled `network_unknown`, 83 still served a manifest, and 59 of those 83
 * declared a chain in one of these three shapes — 49 of them `eip155:8453`.
 * Each was listed and unroutable: on the marketplace, invisible to the router
 * and to its own chain page.
 */
function catalogueEntryAccepts(raw, fallback) {
  if (!raw || typeof raw !== "object") return fallback;
  if (Array.isArray(raw.accepts) && raw.accepts.length) return raw.accepts;
  const network = raw.network || raw.chain;
  if (typeof network === "string" && network) {
    return [{
      scheme: raw.scheme || "exact",
      network,
      asset: raw.asset || raw.asset_address || raw.assetAddress,
      payTo: raw.payTo || raw.pay_to,
      amount: raw.amount ?? raw.maxAmountRequired,
      maxAmountRequired: raw.maxAmountRequired ?? raw.amount,
      maxTimeoutSeconds: raw.maxTimeoutSeconds,
      extra: raw.extra,
    }];
  }
  return fallback;
}

/** Does this address have the shape of a wallet on this network's family?
 *  A service-wide block names ONE payTo beside a LIST of networks, and an EVM
 *  address paired with a Solana network (or the reverse) is not a wallet
 *  anyone can be paid at there. A family we do not recognise is not refused:
 *  every consumer validates the shape again before any RPC call. */
function payToFitsNetwork(network, addr) {
  if (typeof addr !== "string" || !addr.trim()) return false;
  const n = String(network || "").toLowerCase();
  if (n.startsWith("eip155:")) return /^0x[0-9a-fA-F]{40}$/.test(addr);
  if (n.startsWith("solana")) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  if (n.startsWith("stellar")) return /^G[A-Z2-7]{55}$/.test(addr);
  if (n.startsWith("algorand")) return /^[A-Z2-7]{58}$/.test(addr);
  return true;
}

/**
 * The `payment.x402` shape: `{ networks: ["base"], primaryNetwork, payTo,
 * currency }` - one wallet for the whole service, declared once, beside a
 * catalogue whose `resources` are bare URL strings that carry no payment
 * terms at all. It was read for the seller's display network and nothing
 * else, so the payTo it declares never reached a row: live 2026-09-22, a
 * seller whose every resource is a bare string sat in the index with an
 * empty payToByNetwork, invisible to the Base scan (allPayToOrigins) and so
 * unable to clear the settlement floor however many outside buyers paid it.
 * One accept per declared network, shorthand normalised ("base" ->
 * eip155:8453), the payTo attached only where its shape fits the network.
 * The same block at the top level of `payment` (no `x402` key) is read too.
 */
function manifestX402BlockAccepts(p) {
  const x = (p.x402 && typeof p.x402 === "object" && !Array.isArray(p.x402)) ? p.x402
    : (Array.isArray(p.networks) ? p : null);
  if (!x) return [];
  const payTo = typeof x.payTo === "string" ? x.payTo.trim() : (typeof x.pay_to === "string" ? x.pay_to.trim() : "");
  const nets = [...new Set(
    [...(Array.isArray(x.networks) ? x.networks : []), x.network, x.primaryNetwork]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => normalizeNetwork(v.trim())),
  )].slice(0, 16);
  return nets.map((network) => ({
    scheme: typeof x.scheme === "string" ? x.scheme : "exact",
    network,
    ...(payToFitsNetwork(network, payTo) ? { payTo } : {}),
  }));
}

/** The service-wide `payment` block, read as accepts. Empty when absent. */
function manifestPaymentAccepts(manifest) {
  const p = manifest?.payment;
  if (!p || typeof p !== "object") return [];
  const network = p.network || p.chain;
  if (typeof network !== "string" || !network) return manifestX402BlockAccepts(p);
  return [{
    scheme: p.scheme || "exact",
    network,
    asset: p.asset_address || p.assetAddress || p.asset,
    payTo: p.pay_to || p.payTo,
    amount: p.amount ?? p.maxAmountRequired,
    maxTimeoutSeconds: p.maxTimeoutSeconds,
    // `asset` in these manifests is the ticker ("USDC") while `asset_address`
    // is the contract; the EIP-712 domain reader wants the ticker-ish name, so
    // pass whichever of the two is NOT an address.
    extra: p.extra || (typeof p.asset === "string" && !/^0x[0-9a-f]{40}$/i.test(p.asset) ? { name: p.asset } : undefined),
  }];
}

export function normaliseManifestTools(manifest, originUrl) {
  return scopeRowsToSeller(normaliseManifestToolsUnscoped(manifest, originUrl), originUrl);
}
function normaliseManifestToolsUnscoped(manifest, originUrl) {
  if (!manifest || typeof manifest !== "object") return [];
  let origin;
  // Relative entries resolve against where the manifest is served: a path
  // seller's prefix, or the root of a bare origin.
  try { origin = new URL(sellerPrefixOf(originUrl) ? `${originUrl}/` : originUrl); } catch { return []; }
  // `resourceCatalog` is the same dialect one key over: one seller publishes
  // `resources` as bare URL strings (no price anywhere) and the real rows,
  // with prices, in `resourceCatalog`. Reading only the canonical array left
  // both of their rows unpriced and unanchored, which is how a $0.032 route
  // sat in the index at $0.002 across two re-registrations. Rows merge by
  // route, and a price already taken from an earlier catalogue wins, so this
  // can only FILL a gap and never overwrite what the canonical array declared.
  const catalogues = ["tools", "resources", "endpoints", "services", "resourceCatalog"]
    .map((k) => manifest[k])
    .filter((v) => Array.isArray(v) && v.length);
  if (!catalogues.length) {
    const single = singleResourceManifestTool(manifest, originUrl);
    return single ? [single] : [];
  }

  const byKey = new Map();
  const metaByPath = new Map();
  // Manifest-level default, applied only to rows that declare nothing.
  const manifestAccepts = manifestPaymentAccepts(manifest);
  const notePathMeta = (path, { name, description, price, slug, pay }) => {
    if (!path) return;
    const cur = metaByPath.get(path) || {};
    const named = name && name !== path && !String(name).startsWith("/");
    const curNamed = cur.name && cur.name !== path && !String(cur.name).startsWith("/");
    metaByPath.set(path, {
      name: (named ? name : null) || (curNamed ? cur.name : null) || cur.name || name || "",
      description: description || cur.description || "",
      price: price || cur.price || null,
      slug: (slug && slug !== path) ? slug : (cur.slug || slug || ""),
      // One path, one set of payment terms: a rich entry that carries accepts
      // lends its chain to the sibling methods on that path published as thin
      // strings, exactly as it already lends them its price and description.
      pay: (pay && pay.networks?.length) ? pay : (cur.pay || null),
    });
  };

  for (const list of catalogues) {
    for (const raw of list.slice(0, 1000)) {
      let ref = "", name = "", description = "", price = null, inputSchema = null;
      const methodList = [];
      // What this entry says about money, from its own accepts / flat payment
      // fields, falling back to the service-wide block. A thin string entry
      // inherits the service-wide block and nothing else.
      const entryAccepts = typeof raw === "string"
        ? manifestAccepts
        : catalogueEntryAccepts(raw, manifestAccepts);
      const pay = entryAccepts.length ? paymentFieldsFromAccepts(entryAccepts) : null;
      if (typeof raw === "string") {
        ref = raw.trim();
      } else if (raw && typeof raw === "object") {
        ref = String(raw.endpoint || raw.resource || raw.url || raw.route || raw.path || "").trim();
        name = String(raw.name || raw.title || raw.operationId || "").trim();
        description = String(raw.summary || raw.description || "").trim();
        price = parseManifestPrice(raw);
        // The input schema a seller declares beside the route (issue #1503).
        inputSchema = raw.input_schema && typeof raw.input_schema === "object" ? raw.input_schema
          : (raw.inputSchema && typeof raw.inputSchema === "object" ? raw.inputSchema : null);
        if (raw.method && MANIFEST_HTTP_METHODS.has(String(raw.method).toUpperCase())) {
          methodList.push(String(raw.method).toUpperCase());
        } else if (Array.isArray(raw.methods)) {
          for (const m of raw.methods) {
            if (MANIFEST_HTTP_METHODS.has(String(m).toUpperCase())) methodList.push(String(m).toUpperCase());
          }
        }
      }
      if (!ref) continue;
      // "POST /exchange/sell-clams" — a verb glued to a path.
      const verb = /^([A-Za-z]+)\s+(\/.*)$/.exec(ref);
      if (verb && MANIFEST_HTTP_METHODS.has(verb[1].toUpperCase())) {
        if (!methodList.length) methodList.push(verb[1].toUpperCase());
        ref = verb[2];
      }
      let u;
      try { u = new URL(ref, origin); } catch { continue; }
      if (u.host.toLowerCase() !== origin.host.toLowerCase()) continue;
      const route = u.pathname + (u.search || "");
      if (!u.pathname || u.pathname === "/" || MANIFEST_NON_TOOL_PATH.test(u.pathname)) continue;
      const pathOnly = u.pathname;
      const slug = name || u.pathname.replace(/^\//, "").replace(/\//g, "-");
      notePathMeta(pathOnly, { name, description, price, slug, pay });
      const methodsToEmit = methodList.length ? [...new Set(methodList)] : [""];
      for (const method of methodsToEmit) {
        // Keyed on method+route INCLUDING the query string: two entries that differ
        // only by ?product= are two products, and collapsing them to the pathname
        // is how a 17-tool seller reads as 16.
        const key = `${method || "GET"} ${route}`;
        const row = {
          seller: originUrl,
          method: method || "GET",
          // A manifest entry that names no verb is published as GET, the wire
          // default - but SAY SO, so a later merge with rows that observed the
          // real verb (OpenAPI, a live 402) can correct it instead of trusting a
          // default as a declaration. Until 2026-09-02 one seller's two entries
          // per path (ids x402_ip_geo_get / x402_ip_geo_post, no method) both
          // published as GET; a seller whose POST route rejects GET would have
          // been listed as GET, answered 405 to every buyer, and been recorded
          // as broken by us.
          ...(method ? {} : { methodInferred: true }),
          route,
          slug,
          name: name || u.pathname,
          description: description.slice(0, 400),
          category: "other",
          tags: [],
          // A price the entry states as a display string ("$0.05") wins over
          // one derived from atomic units: it is the seller's own wording and
          // it is what `originDeclaredPrice` is stamped from below.
          price: price ?? (pay && pay.price != null ? `$${pay.price}` : null),
          ...(() => { const packed = inputSchema ? packRequestContract(requestContractFromInputSchema(inputSchema, method || "GET")) : null; return packed ? { requestContract: packed } : {}; })(),
          ...(pay ? { networks: pay.networks, stellarPayTo: pay.stellarPayTo,
            algorandPayTo: pay.algorandPayTo, payToByNetwork: pay.payToByNetwork,
            ...(pay.evmDomainByNetwork ? { evmDomainByNetwork: pay.evmDomainByNetwork } : {}) } : {}),
        };
        byKey.set(key, mergeManifestToolRows(byKey.get(key), row));
      }
    }
  }

  // Path-level metadata from a rich object fills sibling methods discovered as
  // thin strings (GET+POST resource lines + one priced endpoints[] object).
  for (const t of byKey.values()) {
    const meta = metaByPath.get(String(t.route || "").split("?")[0]);
    if (!meta) continue;
    if (!t.price && meta.price) t.price = meta.price;
    // fall through to the stamp below
    if ((!t.name || t.name === t.route || String(t.name).startsWith("/")) && meta.name) t.name = meta.name;
    if (!t.description && meta.description) t.description = String(meta.description).slice(0, 400);
    if ((!t.slug || t.slug === t.route) && meta.slug) t.slug = meta.slug;
    if (!(t.networks || []).length && meta.pay?.networks?.length) {
      t.networks = meta.pay.networks;
      if (!Object.keys(t.payToByNetwork || {}).length && Object.keys(meta.pay.payToByNetwork || {}).length) {
        t.payToByNetwork = meta.pay.payToByNetwork;
      }
      if (!t.stellarPayTo && meta.pay.stellarPayTo) t.stellarPayTo = meta.pay.stellarPayTo;
      if (!t.algorandPayTo && meta.pay.algorandPayTo) t.algorandPayTo = meta.pay.algorandPayTo;
      if (!t.evmDomainByNetwork && meta.pay.evmDomainByNetwork) t.evmDomainByNetwork = meta.pay.evmDomainByNetwork;
    }
  }
  // A price in the seller's OWN manifest is an origin declaration, exactly like
  // one in their openapi.json, and must be marked as such: `originDeclaredPrice`
  // is what stops a stale learned quote from overriding it. Missing this was a
  // real defect in the first cut of the #1043 fix - the reporter's own row is
  // discovered via /.well-known/x402, not OpenAPI, so their corrected manifest
  // price kept losing to a nine-day-old learned amount even after the "fix".
  // Verified against their live endpoint before this line existed: still 0.5.
  for (const t of byKey.values()) {
    // NB the manifest price is often a display string ("$0.05"), so this must
    // go through the same parser the rest of the index uses - a bare Number()
    // yields NaN and silently skips the stamp (caught while verifying against
    // the reporter's own live manifest).
    const micro = priceToMicroUsd(t.price);
    if (micro != null && micro > 0 && !(Number(t.originDeclaredPrice) > 0)) t.originDeclaredPrice = microUsdToPrice(micro);
  }
  // Drop a row whose METHOD we guessed when another row declares a method for
  // the same route. A bare `resources` string ("https://origin/x402/thing")
  // carries no verb, so it is inferred as GET; if a richer catalogue entry for
  // that same route states POST, keeping both publishes the endpoint twice and
  // sends half the buyers to a verb the seller answers 405 to. The seller
  // reported exactly this duplicate from their own compatibility array and
  // worked around it by deleting theirs - reading `resourceCatalog` would have
  // re-created it from a different key.
  //
  // Only the INFERRED row is dropped, and only when a declared sibling exists:
  // a seller who genuinely serves GET and POST on one route declares both, and
  // neither is inferred, so both survive.
  const declaredRoutes = new Set();
  for (const t of byKey.values()) if (!t.methodInferred && t.route) declaredRoutes.add(String(t.route));
  for (const [k, t] of [...byKey.entries()]) {
    if (t.methodInferred && t.route && declaredRoutes.has(String(t.route))) byKey.delete(k);
  }
  return [...byKey.values()];
}

/**
 * Drop routes the seller themselves declares free (manifest free_endpoints).
 * Priced / paid-annotated rows still survive — a contradiction is resolved in
 * favour of "this is sellable", same vouch doctrine as non-product filtering.
 */
export function dropDeclaredFreeEndpoints(tools = [], manifest) {
  const raw = manifest?.free_endpoints ?? manifest?.freeEndpoints;
  if (!Array.isArray(raw) || !raw.length) return tools;
  const free = new Set();
  for (const item of raw) {
    let ref = typeof item === "string" ? item.trim()
      : String(item?.path || item?.route || item?.url || "").trim();
    if (!ref) continue;
    const verb = /^([A-Za-z]+)\s+(\/.*)$/.exec(ref);
    if (verb) ref = verb[2];
    try {
      const path = new URL(ref, "https://placeholder.invalid").pathname.replace(/\/$/, "") || "/";
      if (path && path !== "/") free.add(path);
    } catch { /* skip junk */ }
  }
  if (!free.size) return tools;
  return tools.filter((t) => {
    const path = String(t?.route || "").split("?")[0].replace(/\/$/, "");
    if (!free.has(path)) return true;
    if (t.price) return true;
    if (t.paid === true) return true;
    return false;
  });
}

// Liveness probes are not products, but only when nothing says otherwise.
//
// The non-tool path filter anchors at the START of a path, so "/health" is
// excluded and "/v1/health" is not. That put sellers' liveness endpoints into
// their sellable catalogues: 150 such rows across 92 sellers.
//
// The tempting fix is to match the name anywhere in the path, and it is wrong.
// The same scan surfaced "/context-dev/web/scrape/sitemap" (a sitemap scraper)
// and "/inspect/openapi" (an OpenAPI inspector) - real products whose names
// collide with infrastructure. Deleting sellers' actual tools to tidy 0.2% of
// rows is a far worse trade than leaving the junk.
//
// So a row is dropped only when EVERY signal that it might be sellable is
// absent:
//   * its last segment is a pure liveness name. "ping" and "metrics" are
//     deliberately NOT here - a network ping tool and an account-metrics API
//     are both plausible products, and "/v1/account/metrics" reads like one.
//   * no registry vouches for it. A registry row means somebody settled a
//     payment against that exact path, the strongest possible evidence it IS
//     for sale - it spares "/v1/ping" and "/api/ai/metrics", which are
//     registry-listed and therefore bought.
//   * it carries no price and no paid annotation of its own.
//
// A seller who does sell one of these gets it back by pricing it or by taking
// a single payment, both of which they control.
// Extended past liveness after the same scan found three more classes of the
// same thing: account plumbing, documentation boilerplate, and the seller's own
// storefront, all listed as if an agent could buy them. 181 rows across the
// index, on top of the 150 liveness ones.
//
// The membership test is deliberately strict and every borderline word is
// LEFT OUT, because the cost of a wrong drop is a seller losing a listing they
// never hear about:
//   "token"    - a token-info tool is a real product
//   "auth"     - so is an auth-check tool
//   "status"   - so is a transaction-status lookup
//   "test"     - one seller's /api/test IS their regex tester
//   "openapi"  - one seller's /inspect/openapi IS an OpenAPI inspector
//   "schema"   - a schema validator is a product
//   "pricing"  - a pricing calculator is a product
//   "subscribe"- an alerts subscription can be sold
//   "config"   - a config generator is a product
// What remains is plumbing nobody sells: you cannot buy someone's /login.
const NON_PRODUCT_SEGMENTS = new Set([
  // liveness
  "health", "healthz", "livez", "readyz", "heartbeat",
  // account plumbing
  "login", "logout", "signin", "signout", "signup", "register", "oauth", "callback", "session",
  // documentation boilerplate
  "swagger", "redoc", "docs",
  // the seller's own storefront
  "checkout", "billing",
  // operator-only surfaces (also matched as ANY path segment below — see
  // OPERATOR_PATH_SEGMENTS — so /admin/gasto-hoy is dropped, not only /admin)
  "webhook", "webhooks", "admin", "internal", "debug",
]);
// Operator namespaces: unlike "health" (a product category under /health/bmi),
// nobody sells /admin/*. Matching only the last segment left Agente Jefe's
// /admin/gasto-hoy and /admin/saldo in the buyable index as payable:unknown.
const OPERATOR_PATH_SEGMENTS = new Set(["admin", "internal", "debug"]);
export function dropUnvouchedNonProductRoutes(tools = [], vouchedRoutes = []) {
  const vouched = new Set(
    (vouchedRoutes || []).map((r) => String(r || "").split("?")[0].replace(/\/$/, ""))
  );
  return tools.filter((t) => {
    const path = String(t?.route || "").split("?")[0].replace(/\/$/, "");
    const segs = path.split("/").filter(Boolean).map((s) => s.toLowerCase());
    const last = segs[segs.length - 1] || "";
    const operator = segs.some((s) => OPERATOR_PATH_SEGMENTS.has(s));
    if (!operator && !NON_PRODUCT_SEGMENTS.has(last)) return true;
    if (vouched.has(path)) return true;      // somebody paid for it
    if (t.price) return true;                // the seller prices it
    if (t.paid === true) return true;        // the seller annotates it as paid
    return false;
  });
}

// Fold a manifest catalogue into the rows we already have, WITHOUT inflating
// and WITHOUT silently dropping the seller's variants.
//
// Both halves were learned the hard way, in that order.
//
// FIRST: keying the merge on the full route string doubled a seller from 16 to
// 30. Manifest entries declare no HTTP verb, so they default to GET, and they
// often carry a query template; the same endpoint arrives from a registry row
// as a bare POST path. Neither method nor route matches, so one endpoint was
// listed twice, for 11 of that seller's 17 entries.
//
//   POST /x402/preflight                        (registry row)
//   GET  /x402/preflight?chain=base&sender=...  (manifest entry)
//
// SECOND: keying on the pathname alone fixes that and silently loses variants.
// A seller report flagged this about the fix
// itself: a single route often sells different things by parameter (?product=,
// a reader keyed by ?url=, a chain call keyed by ?chain=), at different prices.
// Folding those into one row erases products the seller does sell.
//
// So the pathname decides the MATCH and the count of advertised resources on
// that path decides the OUTCOME:
//   * path unknown to us            -> add everything, variants included
//   * one resource, path known      -> same endpoint; enrich in place, add nothing
//   * several resources, path known -> the row we hold is that path without its
//                                      parameters, so the variants replace it
//
// Throughout: an observed value beats a claimed one. A verb seen on an openapi
// operation or a settled registry row is evidence; a manifest's silence is not.
// The manifest still wins on description, which is the whole reason to read it.
export function mergeManifestIntoTools(manifestTools = [], existing = []) {
  if (!manifestTools.length) return existing.slice();
  // Group the seller's entries by pathname first, because how many they
  // advertise on one path is what decides the merge.
  const groups = new Map();
  for (const m of manifestTools) {
    const path = String(m.route || "").split("?")[0];
    if (!path) continue;
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push(m);
  }
  const indicesByPath = new Map();
  existing.forEach((t, i) => {
    const p = String(t.route || "").split("?")[0];
    if (!p) return;
    if (!indicesByPath.has(p)) indicesByPath.set(p, []);
    indicesByPath.get(p).push(i);
  });
  const replaced = new Set();
  const append = [];
  const enrich = (hit, m) => {
    if (!hit.name || hit.name === hit.route || String(hit.name).startsWith("/")) hit.name = m.name || hit.name;
    if (!hit.description) hit.description = m.description || "";
    if (!hit.price && m.price) hit.price = m.price;
    if ((!hit.slug || hit.slug === hit.route) && m.slug) hit.slug = m.slug;
    // Settlement terms too, and this is the half that used to be missing. An
    // OpenAPI document carries no payment metadata, so a row sourced from one
    // has no chain and no payTo - and the manifest, which is exactly where the
    // seller states both, could only supply them on a path nobody else had
    // reported. A seller who documents their endpoint in OpenAPI AND declares
    // it in their manifest therefore ended up listed with `network: null`,
    // invisible to the router's chain match and to every per-chain market page.
    // Blank-fill only: an observed live 402 outranks a manifest claim, so a row
    // that already knows its chains keeps them.
    if (!hit.networks?.length && m.networks?.length) hit.networks = [...m.networks];
    if (!Object.keys(hit.payToByNetwork || {}).length && Object.keys(m.payToByNetwork || {}).length) {
      hit.payToByNetwork = { ...m.payToByNetwork };
      // Explicit, because the hit may be a Bazaar row whose provenance would
      // otherwise read these manifest addresses as the registry's.
      hit.payToSourceByNetwork = Object.fromEntries(Object.keys(m.payToByNetwork).map((net) => [net, "origin"]));
    } else {
      // The one exception to blank-fill: an address only a REGISTRY carries
      // for a network the manifest names is replaced by the manifest's. The
      // manifest is the origin's own current word on where it is paid; the
      // registry row records where an earlier payment went, which is a wallet
      // the seller may have since left (2026-10-03, see payToSourceOf). An
      // address the origin's OpenAPI or live 402 gave the row is untouched.
      for (const [net, addr] of Object.entries(m.payToByNetwork || {})) {
        if (typeof addr !== "string" || !addr) continue;
        if (hit.payToByNetwork?.[net] && payToSourceOf(hit, net) === "registry") setRowPayTo(hit, net, addr, "origin");
      }
    }
    if (!hit.stellarPayTo && m.stellarPayTo) hit.stellarPayTo = m.stellarPayTo;
    if (!hit.algorandPayTo && m.algorandPayTo) hit.algorandPayTo = m.algorandPayTo;
    // Blank-fill: a contract read from the seller's OpenAPI outranks one read
    // from a manifest schema.
    // A manifest's names also fill an OpenAPI "requires nothing": an operation
    // documented with no parameters says less than a schema listing fields.
    if (requestContractStrength(m.requestContract) > requestContractStrength(hit.requestContract)) hit.requestContract = m.requestContract;
  };
  for (const [path, entries] of groups) {
    const indices = indicesByPath.get(path) || [];
    if (!indices.length) {
      // Nobody else reported this path. Everything the seller advertises on it
      // is new, variants included.
      append.push(...entries);
      continue;
    }
    if (entries.length === 1) {
      // One advertised resource: fill blanks on EVERY observed method for this
      // path (OpenAPI often lists GET+POST). Adding nothing keeps the 16→30
      // guard; enriching only the first row left sibling methods thin.
      for (const i of indices) enrich(existing[i], entries[0]);
      continue;
    }
    // SEVERAL resources on one path. The rows we hold are that path seen
    // without parameters (or as one method among several), so the variants
    // ARE it, described properly. Replace EVERY observed row on the path —
    // replacing only the first left OpenAPI's GET sibling beside a replaced
    // POST and the listing stayed thin (Agente Jefe: empty descriptions on
    // the surviving GET row).
    //
    // Method rule: when the manifest entries themselves disagree on verb
    // (GET+POST catalogue), keep each entry's method. When they all share one
    // verb (query-template variants defaulting to GET) and we observed a
    // single method on the path, carry that observed verb across so a
    // defaulted GET cannot overwrite a settled POST.
    const observedMethods = [...new Set(
      indices.map((i) => String(existing[i].method || "").toUpperCase()).filter(Boolean)
    )];
    const manifestMethods = [...new Set(
      entries.map((e) => String(e.method || "GET").toUpperCase())
    )];
    const forceObserved =
      manifestMethods.length <= 1 && observedMethods.length === 1 ? observedMethods[0] : null;
    for (const i of indices) replaced.add(i);
    for (const e of entries) {
      // A defaulted verb that the observed row corrects is no longer inferred.
      const { methodInferred, ...rest } = e;
      append.push({ ...rest, method: forceObserved || e.method || "GET", ...(methodInferred && !forceObserved ? { methodInferred: true } : {}) });
    }
  }
  const out = existing.filter((_, i) => !replaced.has(i));
  out.push(...append);
  return out;
}

// Read a tool catalogue out of an /llms.txt.
//
// Asked for alongside /agents.json in #645, and it is the riskier of the two:
// agents.json is structured, llms.txt is prose. A greedy markdown scrape would
// happily turn a seller's marketing copy into fifty phantom "tools" and inflate
// the index with things nobody can buy - the exact failure the registry
// template-collapse work already had to undo once.
//
// So this only accepts the one shape that is unambiguous, the link-list entry
// that the llms.txt convention is actually built on:
//
//   - [Name](https://origin/route): description ... $0.01 ...
//
// and requires ALL of:
//   * a SAME-ORIGIN absolute URL, so a link to someone else's docs can never
//     be listed as this seller's tool,
//   * an explicit price on the line, which is what separates a buyable
//     endpoint from a link to an about page,
//   * a route that survives the same non-tool path filter openapi uses.
//
// Anything less structured is left unread on purpose. A thin listing is a
// recoverable problem; a fabricated one is not.
export function normaliseLlmsTxtTools(text, originUrl) {
  return scopeRowsToSeller(normaliseLlmsTxtToolsUnscoped(text, originUrl), originUrl);
}
function normaliseLlmsTxtToolsUnscoped(text, originUrl) {
  if (typeof text !== "string" || !text) return [];
  let originHost = "";
  try { originHost = new URL(originUrl).host.toLowerCase(); } catch { return []; }
  const nonToolPath =
    /^\/(\.well-known|health|openapi|llms|sitemap|robots|favicon|admin|internal)|\.(png|ico|svg|txt|xml)$/i;
  const line = /^\s*[-*]\s*\[([^\]]{1,120})\]\(([^)\s]{1,400})\)\s*[:\-]?\s*(.*)$/;
  const priceRe = /\$\s?([0-9]+(?:\.[0-9]+)?)/;
  const out = [];
  const seen = new Set();
  for (const raw of text.split("\n").slice(0, 2000)) {
    const m = line.exec(raw);
    if (!m) continue;
    const [, name, href, rest] = m;
    let u;
    try { u = new URL(href); } catch { continue; }
    // Same-origin only. A cross-origin link in someone's llms.txt is a
    // reference, never a tool they sell.
    if (u.host.toLowerCase() !== originHost) continue;
    const route = u.pathname;
    if (!route || route === "/" || nonToolPath.test(route)) continue;
    // A price is the buyability evidence. Without one this is a doc link.
    const price = priceRe.exec(rest);
    if (!price) continue;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push({
      seller: originUrl,
      // llms.txt states no verb. GET is the honest default for a link, and the
      // router treats method as a hint rather than a contract.
      method: "GET",
      route,
      slug: route.replace(/^\//, "").replace(/\//g, "-"),
      name: name.trim(),
      description: String(rest || "").replace(/\s+/g, " ").trim().slice(0, 400),
      category: "other",
      tags: [],
      price: `$${price[1]}`,
      paid: true,
    });
  }
  return out;
}

// ONE reader for every payment annotation dialect an OpenAPI operation can
// carry (2026-09-18). There is no standard for these extensions and sellers
// invent keys; one crawl cycle on prod logged unrecognized payment-ish keys
// from ~250 origins, every one of whose operations was being indexed as FREE:
// `x-price-usd` (101 origins; 0.001 or "$0.003"), `x-x402` (100; an accepts-
// shaped object, with or without an amount, or `{price:"$0.01", scheme,
// network_default}`), `x-payment` (37; `{protocol:"x402", network, asset,
// payTo, amountUsd, amountAtomic}` or `{x402Version:2, scheme, network,
// amount:"1000000", asset, payTo}`), `x-payment-required` (18; a boolean, no
// price), `x-price-usdc` (16), `x-402` (13; `{price:"$0.05", priceMicros:
// 50000, ...}` or `{priceUsd}` or `{price_usdc}`), plus a tail of
// `x-payment-protocol`, `x-pricing`, `x-x402-network`, `x-x402-price-usd`,
// `x-x402-payment`, `x-x402-price-atomic`. Each shape below was read off a
// live document that day (fixtures in scripts/test-index-tools-catalog.js).
//
// Rules: a DOLLAR figure is read through `parseManifestPrice` (which already
// descends one object level and normalises "$"); an ATOMIC amount
// (`amountAtomic`, `x-x402-price-atomic`, or the accepts-shaped `amount`) is
// read through `paymentFieldsFromAccepts`, i.e. divided by the asset's
// decimals - the 2026-09-15 lesson: an atomic "1000000" read as
// dollars is a thousand-fold overquote on the seller's own listing;
// `priceMicros` is micro-dollars. `x-payment-required: true` marks the op
// PAID with the price unknown so the live-402 probe learns the figure;
// `false` marks it FREE unless a price key beside it says otherwise (the more
// specific declaration wins). Networks and payTo ride out so a row from one of
// these documents is chain-matched like a manifest row instead of
// `network_unknown`. Returns `paid` as true | false | null (null = the
// operation carries no payment annotation at all).
const PAYMENT_ANNOTATION_KEYS = [
  "x-price", "x-x402-price", "x-payment-info", "x-x402-price-usdc",
  "x-price-usd", "x-price-usdc", "x-x402-price-usd", "x-x402-price-atomic",
  "x-x402", "x-402", "x-payment", "x-x402-payment", "x-pricing", "x-payment-protocol",
  "x-x402-network", "x-payment-required",
];
const SCALAR_PRICE_KEYS = ["x-price", "x-x402-price", "x-x402-price-usdc", "x-price-usd", "x-price-usdc", "x-x402-price-usd"];
const OBJECT_PAYMENT_KEYS = ["x-payment-info", "x-x402", "x-402", "x-payment", "x-x402-payment", "x-pricing", "x-payment-protocol"];
const isScalar = (v) => typeof v === "number" || typeof v === "string";
export function openapiOperationPayment(op) {
  const out = { paid: null, price: null, networks: [], payToByNetwork: {} };
  if (!op || typeof op !== "object") return out;
  const lower = new Map(Object.keys(op).map((k) => [k.toLowerCase(), op[k]]));
  const get = (k) => lower.get(k);
  let annotated = false;
  const addNetwork = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const n = normalizeNetwork(raw.trim());
    if (n && !out.networks.includes(n)) out.networks.push(n);
    return n;
  };
  // A figure is a price only when it is a POSITIVE dollar amount. Zero is a
  // declaration of "free" and is remembered as such (below); a negative,
  // NaN or unparseable figure is ignored. Before this rule a seller stamping
  // `x-price-usd: 0` on every operation indexed as PAID "$0" rows, which win
  // the cheapest-price tiebreak on every equal-score /api/route query (the
  // thing decoratedRemoteTools' comment forbids), and "-1000" atomic produced
  // a "$-0.001" display price the money path could not read.
  let declaredZero = false;
  const takePrice = (p) => {
    if (out.price || p == null) return;
    const micro = priceToMicroUsd(p);
    if (micro == null) return;
    if (micro <= 0) { if (micro === 0) declaredZero = true; return; }
    out.price = p;
  };
  const positiveNumber = (x) => typeof x === "number" ? x > 0 : (typeof x === "string" && /^\s*\d+(\.\d+)?\s*$/.test(x) && Number(x) > 0);
  const zeroNumber = (x) => (typeof x === "number" && x === 0) || (typeof x === "string" && /^\s*0+(\.0+)?\s*$/.test(x));
  // Atomic amounts: through the accepts reader (divides by the asset's decimals).
  // Digits only: "1e6" and "0x10" are not base units anyone publishes.
  const takeAtomic = (obj, amount) => {
    if (amount == null || amount === "") return;
    if (zeroNumber(amount)) { declaredZero = true; return; }
    if (!(typeof amount === "number" ? Number.isInteger(amount) && amount > 0 : /^\s*\d+\s*$/.test(String(amount)))) return;
    const f = paymentFieldsFromAccepts([{ ...obj, amount: String(amount).trim() }]);
    if (f.price != null) takePrice(`$${f.price}`);
  };
  for (const k of SCALAR_PRICE_KEYS) {
    const v = get(k);
    if (v == null) continue;
    annotated = true;
    if (isScalar(v) || (v && typeof v === "object")) takePrice(parseManifestPrice({ price: v }));
  }
  const atomic = get("x-x402-price-atomic");
  if (atomic != null) { annotated = true; takeAtomic({ network: get("x-x402-network") }, atomic); }
  if (get("x-x402-network") != null) { annotated = true; addNetwork(get("x-x402-network")); }
  for (const k of OBJECT_PAYMENT_KEYS) {
    const v = get(k);
    if (v == null) continue;
    annotated = true;
    if (isScalar(v)) { takePrice(parseManifestPrice({ price: v })); continue; }
    if (typeof v !== "object" || Array.isArray(v)) continue;
    // Dollar figures first: price_usd / priceUsd / price (scalar or object) and
    // the dialect-specific spellings.
    takePrice(parseManifestPrice(v));
    for (const key of ["amountUsd", "price_usdc"]) {
      if (out.price || v[key] == null) continue;
      if (zeroNumber(v[key])) declaredZero = true;
      else if (positiveNumber(v[key])) takePrice(`$${Number(v[key])}`);
    }
    if (!out.price && v.priceMicros != null) {
      if (zeroNumber(v.priceMicros)) declaredZero = true;
      else if (positiveNumber(v.priceMicros)) takePrice(`$${Number(v.priceMicros) / 1e6}`);
    }
    // Then atomic: an explicit amountAtomic, or the x402 accepts field `amount`
    // when the object is accepts-shaped (parseManifestPrice refuses to read
    // that one as dollars for exactly this reason).
    if (!out.price && v.amountAtomic != null) takeAtomic(v, v.amountAtomic);
    if (!out.price && acceptShaped(v) && v.amount != null) takeAtomic(v, v.amount);
    // MPP's discovery shape lists its terms under `offers`; when the top level
    // states no amount, the first offer is the price and carries the same
    // base-units rule (parseManifestPrice reads currency + method/intent).
    if (!out.price && Array.isArray(v.offers)) {
      for (const offer of v.offers.slice(0, 5)) {
        takePrice(parseManifestPrice(offer));
        if (out.price) break;
      }
    }
    const net = addNetwork(v.network ?? v.network_default ?? v.chain ?? null);
    if (net && typeof v.payTo === "string" && v.payTo) out.payToByNetwork[net] = v.payTo;
    if (Array.isArray(v.accepts)) {
      const f = paymentFieldsFromAccepts(v.accepts);
      if (!out.price && f.price != null) takePrice(`$${f.price}`);
      for (const n of f.networks) addNetwork(n);
      Object.assign(out.payToByNetwork, f.payToByNetwork);
    }
  }
  const required = get("x-payment-required");
  if (typeof required === "boolean") annotated = true;
  else if (typeof required === "string" && /^(true|false)$/i.test(required.trim())) annotated = true;
  const requiredBool = typeof required === "boolean" ? required : (typeof required === "string" && /^(true|false)$/i.test(required.trim()) ? required.trim().toLowerCase() === "true" : null);
  if (!annotated) return out;
  // Paid when priced, when payment is declared required, or when payment terms
  // (an object dialect) are declared at all; free on an explicit `false` with
  // no price beside it, and free when the only figure declared was ZERO
  // (unless x-payment-required says true, which wins as "paid, price unknown").
  if (out.price) out.paid = true;
  else if (requiredBool === false) out.paid = false;
  else if (declaredZero && requiredBool !== true) out.paid = false;
  else out.paid = true;
  return out;
}

function openapiOperationHasPaymentSignal(op) {
  return openapiOperationPayment(op).paid === true;
}

// Annotation-dialect watch. There is no standard for payment extensions, so
// sellers invent keys — and in an ANNOTATED document an unrecognized price key
// doesn't inflate anything, it silently DELETES: the op reads as unannotated
// and drops from the paid set (x-x402-price-usdc hid 3 of a seller's 17 paid
// ops until they emailed, 2026-07-27). Surface every payment-ish x- key we
// don't recognize so the next dialect announces itself in the logs instead.
const RECOGNIZED_PAYMENT_KEYS = new Set(PAYMENT_ANNOTATION_KEYS);
// Payment-ish by name but known to carry no price — never worth a log line.
const BENIGN_PAYMENT_LOOKALIKES = new Set(["x-x402-call-type"]);
const PAYMENTISH = /pric|pay|cost|fee|402|usdc|usd\b/i;
export function unknownPaymentishKeys(openapi) {
  if (!openapi || typeof openapi !== "object" || !openapi.paths) return [];
  const found = new Set();
  for (const methods of Object.values(openapi.paths)) {
    for (const op of Object.values(methods || {})) {
      if (!op || typeof op !== "object") continue;
      for (const k of Object.keys(op)) {
        const kl = k.toLowerCase();
        if (!kl.startsWith("x-")) continue;
        if (RECOGNIZED_PAYMENT_KEYS.has(kl) || BENIGN_PAYMENT_LOOKALIKES.has(kl)) continue;
        if (PAYMENTISH.test(kl)) found.add(kl);
      }
    }
  }
  return [...found].sort();
}
// Once per (origin, key) per process — the crawler revisits every cycle
// and a repeated line would be noise, but a NEW key must always surface.
const loggedAnnotationKeys = new Set();
// The key name is THIRD-PARTY text headed for our logs: strip control chars
// (newlines/ANSI escapes could forge log lines) and cap the length. Same
// class of hygiene as the router's listing-injection filter — a crawled
// document must never get to write our operational log for us.
const safeLogToken = (s) => String(s).replace(/[^\x20-\x7E]/g, "").slice(0, 64);
function logUnknownPaymentKeys(openapi, originUrl) {
  for (const k of unknownPaymentishKeys(openapi)) {
    const id = `${originUrl} ${k}`;
    if (loggedAnnotationKeys.has(id)) continue;
    loggedAnnotationKeys.add(id);
    console.warn(
      `[x402-index] unrecognized payment-ish annotation "${safeLogToken(k)}" at ${originUrl} — ` +
        `if it prices operations, ops carrying only it are being listed as FREE ` +
        `(add it to RECOGNIZED_PAYMENT_KEYS after verifying)`
    );
  }
}

// Does this openapi document look like a *paid* x402 service rather than any
// random Swagger site? True when at least one operation carries a payment
// extension. Gates the openapi-fallback crawl path: without a manifest AND
// without a Bazaar settlement record, a payment extension is the only signal
// that the origin actually sells anything.
export function openapiHasPaymentSignal(openapi) {
  if (!openapi || typeof openapi !== "object" || !openapi.paths) return false;
  for (const methods of Object.values(openapi.paths)) {
    for (const op of Object.values(methods || {})) {
      if (openapiOperationHasPaymentSignal(op)) return true;
    }
  }
  return false;
}

// Overlay openapi tool metadata onto Bazaar-derived tools for the same origin.
// Bazaar entries are payment-proven (price, networks, payTo observed from real
// 402s) but carry only a path-derived slug and no name — a seller whose routes
// are short ("/md") is invisible to the router's slug/name scoring even when
// its openapi.json says exactly what the tool does (operationId → slug,
// summary → name, tags). Match by method+route (route-only as a fallback,
// Bazaar guesses POST when the registry omits the method); openapi wins on
// descriptive fields and the declared HTTP method. Bazaar wins on observed
// payment truth when it has an amount; otherwise the OpenAPI payment extension
// fills the unknown price. Openapi-only routes are appended as-is;
// Bazaar-only routes pass through untouched.
/** Every operation's {method, route} in a document — NO payment filtering, no
 *  static-asset skip. Used only to COLLAPSE facilitator-registry rows whose
 *  concrete URLs instantiate a templated path (see mergeOpenapiIntoBazaar);
 *  never to list tools. */
export function openapiAllOperationRoutes(openapi, originUrl) {
  return scopeRowsToSeller(openapiAllOperationRoutesUnscoped(openapi, originUrl), originUrl);
}
function openapiAllOperationRoutesUnscoped(openapi, originUrl) {
  if (!openapi || typeof openapi !== "object" || !openapi.paths) return [];
  const base = openapiBasePath(openapi, originUrl);
  const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
  const out = [];
  for (const [rawPath, methods] of Object.entries(openapi.paths)) {
    const pathStr = base && !rawPath.startsWith(base + "/") && rawPath !== base ? base + rawPath : rawPath;
    for (const [method, op] of Object.entries(methods || {})) {
      if (!httpMethods.has(method.toLowerCase())) continue;
      if (!op || typeof op !== "object") continue;
      out.push({ method: method.toUpperCase(), route: pathStr });
    }
  }
  return out;
}

// Does `concrete` instantiate the templated `route` ("/a/{id}/b" matches
// "/a/57dc.../b")? Literal segments must match exactly; {param} segments match
// any non-empty segment. A route with no template is never a template match —
// literal equality is the exact-match path's job.
function routeMatchesTemplate(templateRoute, concreteRoute) {
  if (typeof templateRoute !== "string" || !templateRoute.includes("{")) return false;
  const t = templateRoute.split("/");
  const c = String(concreteRoute || "").split("/");
  if (t.length !== c.length) return false;
  for (let i = 0; i < t.length; i++) {
    if (/^\{.+\}$/.test(t[i])) { if (!c[i]) return false; }
    else if (t[i] !== c[i]) return false;
  }
  return true;
}

// Bazaar and other registry rows are settlement/discovery evidence, never
// seller application-contract authority. Build a fresh plain object from own
// enumerable data fields so contract-shaped own accessors are not invoked and
// inherited/prototype-carried fields cannot become own published evidence.
function withoutRegistryContracts(row) {
  if (!row || typeof row !== "object") return row;
  const clean = {};
  for (const key of Object.keys(row)) {
    if (key === "requestContract" || key === "responseContract") continue;
    clean[key] = row[key];
  }
  return clean;
}

// OpenAPI contract tuples may cross the join only as own data properties of
// the normalized seller operation. Refuse accessors and prototype values.
function ownContractTuple(row, key) {
  let descriptor;
  try {
    descriptor = row && typeof row === "object"
      ? Object.getOwnPropertyDescriptor(row, key)
      : undefined;
  } catch {
    return null;
  }
  return descriptor && "value" in descriptor && Array.isArray(descriptor.value)
    ? descriptor.value
    : null;
}

export function mergeOpenapiIntoBazaar(openapiTools = [], bazaarTools = [], { allRoutes = [] } = {}) {
  if (!openapiTools.length && !allRoutes.length) return bazaarTools.map(withoutRegistryContracts);
  if (!bazaarTools.length) return openapiTools.slice();
  const exact = new Map();
  const byRoute = new Map();
  for (const o of openapiTools) {
    exact.set(`${o.method} ${o.route}`, o);
    // A route-only match is safe only when the document declares exactly one
    // operation for that path. null marks an ambiguous GET+POST-style path.
    if (!byRoute.has(o.route)) byRoute.set(o.route, o);
    else byRoute.set(o.route, null);
  }
  // Templated operations, for collapsing per-instance registry rows. A
  // facilitator registry records every settled URL verbatim, so one templated
  // operation ("/api/simulations/{id}/step") can appear as dozens of concrete
  // UUID instances — each a real settlement, none a distinct tool. Found live
  // 2026-07-27: a 42-operation seller listed as "72 tools" because 58
  // per-instance rows rode alongside their 14 indexed operations.
  const templatedOps = openapiTools.filter((o) => String(o.route).includes("{"));
  // Templates from the FULL document (payment-filtered ops included): an
  // instance of an operation the seller marks unpaid/deprecated still
  // collapses — to one representative row, since its settlements are real.
  const docTemplates = allRoutes.filter((r) => String(r.route).includes("{"));
  const collapsedDocRows = new Map(); // "METHOD template" -> first surviving row
  const templateMatch = (b, candidates, methodOf) => {
    const fits = candidates.filter((x) => routeMatchesTemplate(methodOf(x).route, b.route) &&
      (b.methodInferred || methodOf(x).method === b.method));
    return fits.length === 1 ? fits[0] : null;
  };
  const used = new Set();
  const enrich = (b, o, route) => {
    // Bazaar is settlement evidence, never application-contract authority.
    // Strip contract-shaped fields before carrying only the matched seller
    // OpenAPI operation's packed tuples below.
    const bazaar = withoutRegistryContracts(b);
    const requestContract = ownContractTuple(o, "requestContract");
    const responseContract = ownContractTuple(o, "responseContract");
    const bazaarMicro = priceToMicroUsd(b.price);
    const originMicro = priceToMicroUsd(o.price);
    const priceConflict = bazaarMicro != null && originMicro != null && bazaarMicro !== originMicro;
    // On disagreement the ORIGIN'S OWN CURRENT DECLARATION wins. This used to
    // take Math.max(), which protects a buyer from underquoting a RAISED price
    // against a stale Bazaar row - but in that scenario the origin IS the
    // higher figure, so preferring the origin handles it identically. The two
    // rules only diverge when the origin is LOWER, i.e. a price CUT, and there
    // max() pinned the old high amount forever: reported 2026-08-29 by a
    // seller whose 2026-08-20 cut we were still quoting at 10x nine days and
    // dozens of crawls later. An origin's own openapi.json, fetched this
    // crawl, is the freshest and most authoritative statement of its price;
    // the Bazaar amount is a third party's record and can lag arbitrarily.
    // Absent conflict: keep settlement-observed Bazaar (incl. explicit 0);
    // only fill a missing amount from OpenAPI.
    let price;
    // Normalized, NOT passed through: `o.price` can be the string "0.003"
    // straight from the seller's document, and a string price fails every
    // numeric comparison downstream (caught by test-openapi-fallback).
    if (priceConflict) price = microUsdToPrice(originMicro);
    else price = b.price == null ? o.price : b.price;
    return ({
    ...bazaar,
    // Bazaar defaults missing methods to POST. The OpenAPI operation is the
    // authoritative verb once the route-only fallback finds a match.
    method: b.methodInferred ? (o.method || b.method) : b.method,
    route,
    slug: o.slug || b.slug,
    name: o.name && o.name !== o.route ? o.name : b.name,
    description: o.description || b.description,
    tags: o.tags?.length ? o.tags : b.tags,
    category: o.tags?.length ? o.category : b.category,
    // The seller's OpenAPI operation is the only source of these packed
    // contract tuples. Carry them across the settlement-evidence join without
    // reconstructing them from the Bazaar row or letting them affect ranking,
    // routing, pricing, or payment behavior.
    ...(requestContract ? { requestContract } : {}),
    ...(responseContract ? { responseContract } : {}),
    price,
    // What the ORIGIN itself declared this crawl, kept separately so a later
    // stage cannot quietly overwrite the seller's own current number with an
    // older learned one, and so a re-probe can tell drift from agreement.
    ...(originMicro != null ? { originDeclaredPrice: microUsdToPrice(originMicro) } : {}),
    // Preserve both observations (normalized numbers) so a buyer can see the
    // drift and fail closed - and so we can audit which side won.
    ...(priceConflict ? {
      priceConflict: true,
      priceResolvedFrom: "origin", // the seller's own current declaration
      priceObservations: {
        bazaar: microUsdToPrice(bazaarMicro),
        origin: microUsdToPrice(originMicro),
      },
    } : {}),
    // A registry row IS a settlement record: an operation the document left
    // unannotated (paid:false) that has real settled payments is buyable —
    // observed truth beats the doc's silence. An explicit zero price stays free.
    ...(b.price != null && b.price > 0 ? { paid: true } : o.paid !== undefined ? { paid: o.paid } : {}),
    // The payTo the origin's own operation names wins over the one the
    // registry recorded, network by network, like the price above: a seller
    // that moved wallets is paid at the new one, and the registry's address is
    // a record of where an earlier payment went (see payToSourceOf). The
    // registry's address still fills a network the operation names nothing on.
    ...(() => {
      const own = Object.entries(o.payToByNetwork || {}).filter(([, a]) => typeof a === "string" && a);
      if (!own.length) return {};
      const sources = {};
      for (const net of Object.keys(bazaar.payToByNetwork || {})) sources[net] = payToSourceOf(bazaar, net);
      for (const [net] of own) sources[net] = "origin";
      return { payToByNetwork: { ...(bazaar.payToByNetwork || {}), ...Object.fromEntries(own) }, payToSourceByNetwork: sources };
    })(),
  });
  };
  const merged = bazaarTools.map((b) => {
    // Only an inferred Bazaar verb may fall back to a route-only match. An
    // explicit verb must match exactly: GET and POST on the same path can be
    // different tools with different descriptions and prices.
    const o = b.methodInferred
      ? byRoute.get(b.route)
      : exact.get(`${b.method} ${b.route}`);
    if (o) { used.add(o); return enrich(b, o, b.route); }
    // Per-instance collapse, indexed operations first: the first instance
    // becomes the operation's row (templated route, registry payment truth);
    // every further instance of the same operation is dropped.
    const t = templateMatch(b, templatedOps, (x) => x);
    if (t) {
      if (used.has(t)) return null;
      used.add(t);
      return enrich(b, t, t.route);
    }
    // Instances of operations the document declares but we do not index
    // (unannotated in an annotated doc, deprecated): real settlements, so
    // keep exactly ONE representative row per operation, on the templated
    // route so it reads as the operation rather than one UUID of it.
    const d = templateMatch(b, docTemplates, (x) => x);
    if (d) {
      const key = `${d.method} ${d.route}`;
      if (collapsedDocRows.has(key)) return null;
      const row = {
        ...withoutRegistryContracts(b),
        route: d.route,
        slug: d.route.replace(/^\//, "").replace(/\//g, "-"),
      };
      collapsedDocRows.set(key, row);
      return row;
    }
    return withoutRegistryContracts(b);
  }).filter(Boolean);
  for (const o of openapiTools) if (!used.has(o)) merged.push(o);
  return merged;
}

// Record a crawl outcome and roll the per-seller history window. `prev` is the
// existing cache entry (may be undefined on first crawl). Returns the new
// history array so the caller can derive a health score from it.
function rollHistory(prev, ok) {
  const h = Array.isArray(prev?.history) ? prev.history.slice(-(HEALTH_WINDOW - 1)) : [];
  h.push(ok ? 1 : 0);
  return h;
}

// Does this seller's PAYWALL actually work?
//
// Crawl health measures one thing: did /.well-known/x402 parse. A seller whose
// every paid route answers 500 scores a perfect 1.0 and reads as healthy,
// because the manifest is free and the paywall is never touched. That is not
// hypothetical - a seller with ~49k claimed lifetime calls sat at health 1 in
// our index while every paid route returned
// "no supported payment kinds loaded from any facilitator".
//
// One unpaid request per seller per crawl. It costs the seller nothing (an
// unpaid 402 is the normal way to read a price) and it is the only signal that
// distinguishes "serving" from "serving its brochure".
//
// Recorded SEPARATELY from `history` on purpose: crawl health drives routing
// and is already tuned, and folding a new failure mode into it would silently
// re-rank the whole index. This reports; it does not re-weight.
// Bounded per cycle. The first version probed EVERY seller on EVERY crawl,
// which doubled the crawler's outbound requests across ~2,250 origins — a cost
// I noted in passing instead of sizing, and it lands on third parties as well
// as on us. A rotating cap keeps total outbound near 1x while still covering
// the whole index over successive cycles: every seller is probed eventually,
// none is probed every time.
const PAYWALL_PROBES_PER_CYCLE = Math.max(0, Number(process.env.X402_PAYWALL_PROBES_PER_CYCLE ?? 25));
let paywallProbeCursor = 0;
/** Round-robin: is this seller's turn to be probed on this cycle? */
function paywallProbeDue() {
  if (PAYWALL_PROBES_PER_CYCLE === 0) return false; // 0 disables it entirely
  return paywallProbeCursor++ % Math.max(1, Math.ceil(cache.size / PAYWALL_PROBES_PER_CYCLE) || 1) === 0;
}

// How many priceless routes we will quote-probe per seller per crawl. The
// crawl runs every 30 minutes across ~2,200 origins, so this is the difference
// between "we learn a catalogue's prices within the hour" and "we hammer a
// stranger's server". A route that gets priced is never probed again (it has a
// price); one that cannot be priced backs off through probeDue like every
// other path. See the #645 note below on why per-PATH backoff matters.
const LIVE_QUOTE_PROBES_PER_CRAWL = Number(process.env.LIVE_QUOTE_PROBES_PER_CRAWL || 15);
// GLOBAL ceiling per crawl CYCLE, not just per seller. Three per seller sounds
// gentle until you multiply: roughly a third of indexed rows carry no price, so
// a per-seller-only limit fires thousands of outbound requests every cycle
// across the whole index - which is issue #645 rebuilt with a different label.
// Per-route backoff eventually quiets the sellers who never answer 402, but
// "eventually" is the first several cycles, and the seller feels those. This
// bounds the whole cycle; the rest simply wait their turn on the next one.
// The global cap is a BLAST-RADIUS control, not a politeness control, so it
// belongs high.
//
// What protects a seller is the PER-SELLER cap and per-route backoff: whatever
// this number is, one origin feels at most LIVE_QUOTE_PROBES_PER_CRAWL requests
// per cycle, and only until its routes are priced. That is the number the #645
// lesson was about - 686 requests to ONE origin for a fact we already knew.
// Spreading a larger total across many DIFFERENT hosts is a different thing
// entirely, and the crawl already fetches four discovery paths per origin per
// cycle.
//
// Setting it low did not make us polite, it made us slow and unfair: at 240 the
// budget was consumed by whoever came first, a full rotation took hours, and a
// seller with a few dozen routes would have waited most of a day to be priced.
// At 4000 every unpriced seller is reached every cycle, so a 30-route seller is
// fully priced in about half an hour, and each of them still sees at most
// LIVE_QUOTE_PROBES_PER_CRAWL requests per cycle. The env override remains for throttling if a real cost
// ever shows up.
const LIVE_QUOTE_PROBES_PER_CYCLE = Number(process.env.LIVE_QUOTE_PROBES_PER_CYCLE || 10000);
let liveQuoteBudget = LIVE_QUOTE_PROBES_PER_CYCLE;
let crawlCycle = 0;   // rotates the per-cycle visiting order so the budget is fair

/**
 * Learn price + networks from a live 402 for rows that have neither.
 *
 * THE DEFECT (reported by a seller, 2026-08-07): a manifest may list
 * `resources` as bare URL strings, which carry no price, and probePaywall -
 * the only thing that talks to a seller's endpoint - filters on
 * `Number(t.price) > 0`. So a priceless row was never probed, and probing is
 * the only thing that could have given it a price. Their 39 endpoints indexed
 * at price:null while every one returned a textbook 402 on POST. Across the
 * index that same day: 146 of 500 sellers had zero priced rows.
 *
 * Only ever ADDS information: a row that already has a price is skipped, and a
 * probe that cannot produce a quote leaves the row exactly as it was.
 */
/**
 * Was this row's verification stamp earned by this row's own verb?
 *
 * The probe records the verb whose 402 it read (networksVerifiedMethod) beside
 * every networksVerifiedAt it writes, so a stamp is evidence about that verb's
 * row and no other. A stamp that names no verb was written before 2026-09-28,
 * when carry-forward still unioned one verb's read into a declared sibling on
 * the same path: the other verb's chains, its stamp and its Base payTo, filed
 * as the sibling's own. Such a stamp cannot be told from one the row earned, so
 * it is not carried as a verified read, and the row takes one fresh read of its
 * own (networksNeedLiveVerify, quoteIsStale) instead of keeping it for good.
 */
function stampIsOwn(r) {
  return Number(r?.networksVerifiedAt) > 0
    && typeof r?.networksVerifiedMethod === "string"
    && r.networksVerifiedMethod.toUpperCase() === String(r?.method || "GET").toUpperCase();
}

/**
 * Carry forward quotes (and verified chain reads) we already learned from a
 * live 402.
 *
 * Every crawl REBUILDS `tools` from the seller's catalogue, and the catalogue is
 * exactly the surface that has no price - that is the whole reason the live
 * probe exists. So without this, each cycle threw away everything the previous
 * cycle learned and re-learned at most LIVE_QUOTE_PROBES_PER_CRAWL routes.
 * A seller with 39 routes could never accumulate: the count oscillated near
 * zero forever and the feature looked like it worked while achieving nothing.
 * Observed live - two routes priced, then zero after the next crawl.
 *
 * Learning a quote can CORRECT the method (a catalogue that said GET for a
 * POST-only endpoint), which is why a route-only fallback sits beside the
 * method-qualified key: without it the key would miss the row it just fixed.
 */
export function carryForwardLearnedQuotes(tools, prev) {
  // Keyed by METHOD + route, with a route-only fallback for the price and
  // networks. Until 2026-09-02 the map was keyed by route alone and the
  // remembered row's VERB was stamped onto every current row on that route,
  // so a path with GET and POST (one seller: 86 such paths in the first 500
  // rows) came out as two GETs - the POST operation mislabelled, and a seller
  // whose POST route rejects GET would answer 405 to every buyer we sent and
  // be recorded as broken by us. A remembered verb may only replace a verb
  // the current row INFERRED (a manifest or llms.txt entry that named none);
  // a declared verb is the seller's own statement and stands.
  //
  // Two kinds of remembered row. A LEARNED QUOTE (live-402, or the live-200
  // retirement of one) carries its price, chains, payTo and verb. A VERIFIED
  // READ is a row whose chains a live 402 confirmed (networksVerifiedAt) while
  // its PRICE stayed the origin's own declaration: such a row is deliberately
  // never re-stamped live-402 (the 2026-08-29 ratchet fix), so until
  // 2026-09-28 the first probe-less rebuild after the read copied its chains
  // and payTo once, without the verification stamp, and the second rebuild
  // found nothing "learned" to carry at all. Every origin-priced seller whose
  // document names no chains flapped between settlement_required and
  // network_unknown, and the payTo the Base scan reads flapped with it. A
  // verified read now carries its chains, payTo, domain observation, verb
  // correction and verification stamp - never a price, never a quoteSource -
  // so the origin's price still wins and the weekly re-verify
  // (networksNeedLiveVerify) keeps its own clock. A verified read is admitted
  // only when its stamp names its own verb (stampIsOwn): a stamp written before
  // the verb was recorded may be another verb's read, and carrying it would
  // keep that verb's chains and Base payTo on this row for good.
  const learnedQuote = (r) => r?.quoteSource === "live-402" || r?.quoteSource === "live-200";
  const verifiedRead = (r) => stampIsOwn(r) && Array.isArray(r?.networks) && r.networks.length > 0;
  const learnedExact = new Map();
  const learnedByRoute = new Map();
  for (const t of prev?.tools || []) {
    if (typeof t?.route !== "string" || !(learnedQuote(t) || verifiedRead(t))) continue;
    // A learned quote is never displaced by a verified read on the same key,
    // so admitting verified reads cannot change which row the older rules
    // pick; among learned quotes the previous order stands (last wins on the
    // exact key, first wins on the route).
    const key = `${String(t.method || "GET").toUpperCase()} ${t.route}`;
    const heldExact = learnedExact.get(key);
    if (!heldExact || learnedQuote(t) || !learnedQuote(heldExact)) learnedExact.set(key, t);
    const heldRoute = learnedByRoute.get(t.route);
    if (!heldRoute || (!learnedQuote(heldRoute) && learnedQuote(t))) learnedByRoute.set(t.route, t);
  }
  if (!learnedExact.size) return tools;
  for (const t of tools) {
    const exact = learnedExact.get(`${String(t.method || "GET").toUpperCase()} ${t.route}`);
    const hit = exact || learnedByRoute.get(t.route);
    if (!hit) continue;
    const fromQuote = learnedQuote(hit);
    // A route-level hit may change a current row's verb in exactly two cases:
    // the row INFERRED its verb (named none), or the hit is a recorded
    // CORRECTION of this very verb (the probe saw it fail and the other answer).
    const correctsVerb = !exact && hit.method && hit.method !== t.method
      && (t.methodInferred === true || hit.methodCorrectedFrom === String(t.method || "GET").toUpperCase());
    // A read is evidence about ITS OWN row: the same verb, or the verb it
    // recorded correcting (or the verb an inferred row adopts from it). A
    // sibling verb on the path was never read, so a verified read carries
    // nothing to it, and a learned quote carries it only the route-level price
    // and, onto a row with no chains of its own, the chains (see below).
    const ownRead = Boolean(exact) || correctsVerb;
    if (!fromQuote && !ownRead) continue;
    // ...and the hit's chains, stamp, payTo and domain are this row's own only
    // when its stamp was earned by its own verb (stampIsOwn). A verified read
    // is admitted only on that condition; a learned quote may still carry a
    // stamp written before the verb was recorded, and an exact key does not
    // prove that stamp is this verb's: until 2026-09-28 carry-forward itself
    // filed a sibling verb's read on this row, under this row's key.
    const readIsOwn = ownRead && stampIsOwn(hit);
    const hitRead = Number(hit.networksVerifiedAt) > 0 && Array.isArray(hit.networks) && hit.networks.length > 0;
    const rowHasChains = Array.isArray(t.networks) && t.networks.length > 0;
    // A read that would have been this row's by key but cannot be attributed
    // to its verb, on a row with chains of its own: its chains, payTo and
    // domain are withheld below, so the row must be read again to get them
    // back (a row with no chains takes the chains and payTo by the older
    // price-and-networks rule and loses only the stamp).
    const withheldRead = ownRead && !readIsOwn && hitRead && rowHasChains;
    if (exact && Number(hit.liveProvenAt) > 0) t.liveProvenAt = hit.liveProvenAt;
    if (hit.quoteSource === "live-200") {
      // A RETIREMENT is carried the way a quote is: the rebuilt row (which the
      // Bazaar merge may have priced again from its settlement snapshot) reads
      // free until the origin declares a price or the retirement ages past the
      // quote window - after which the row is a probe candidate anyway and the
      // live route decides again. Exact verb only: a retired GET says nothing
      // about a POST on the same path.
      if (exact && !(Number(t.originDeclaredPrice) > 0) && Number(hit.quoteRetiredAt) > 0 && Date.now() - Number(hit.quoteRetiredAt) < QUOTE_MAX_AGE_MS) {
        t.price = null; t.paid = false;
        t.quoteSource = "live-200"; t.quoteRetiredAt = hit.quoteRetiredAt; t.quoteObservedAt = hit.quoteObservedAt;
      } else if (exact && !(Number(t.originDeclaredPrice) > 0) && !(Number(t.price) > 0) && isObservedFree(hit)) {
        // An observed-free route carries its observation across the rebuild.
        t.paid = false;
        t.quoteSource = "live-200"; t.freeObservedAt = hit.freeObservedAt; t.quoteObservedAt = hit.quoteObservedAt;
      }
      continue;
    }
    // A carried-forward quote FILLS A GAP; it never overrides what this crawl
    // just read from the origin. `originDeclaredPrice` is set by the OpenAPI
    // merge above, so a route the origin priced today keeps that number even
    // when an older live-402 learned a different one (2026-08-29: the stale
    // amount was filling the fresh row and then being re-stamped "live-402",
    // which made a nine-day-old price look freshly observed).
    const originPricedThisCrawl = Number(t.originDeclaredPrice) > 0;
    // Only a learned QUOTE fills a price: a verified read's price was the
    // origin's own declaration, and if the origin has stopped declaring it the
    // honest state is "unpriced" (a probe candidate), not a remembered figure
    // relabelled as learned.
    if (fromQuote && !(Number(t.price) > 0) && !originPricedThisCrawl && Number(hit.price) > 0) {
      t.price = hit.price;
      t.quoteCarriedForward = true;
      // A quote whose read was withheld is carried without its age, so
      // quoteIsStale reads it as due once ("never stamped: refresh once") and
      // the next probe restores what was withheld, stamped with its own verb.
      // (An origin-priced row is due through networksNeedLiveVerify instead,
      // and a row already priced carries no age from the hit in any case.)
      if (hit.quoteObservedAt && !withheldRead) t.quoteObservedAt = hit.quoteObservedAt;
    }
    // Did this row just take its chains from the hit? A row with no chains of
    // its own takes a learned quote's chains through the route fallback (the
    // older price-and-networks rule); the domain and payTo below describe those
    // chains, so they ride with them.
    let tookChains = false;
    // The chains this crawl's own documents named for the row, before any
    // remembered chain joins them (see the record after these branches).
    const ownChains = Array.isArray(t.networks) ? [...t.networks] : [];
    if (!rowHasChains && Array.isArray(hit.networks) && hit.networks.length) {
      t.networks = [...hit.networks];
      tookChains = true;
      // The verification stamp travels with the chains it verified, onto the
      // row it belongs to (same verb, or the verb it recorded correcting),
      // with the verb that earned it. This branch used to drop it, so the next
      // rebuild saw an unverified row.
      if (readIsOwn) { t.networksVerifiedAt = hit.networksVerifiedAt; t.networksVerifiedMethod = hit.networksVerifiedMethod.toUpperCase(); }
    } else if (readIsOwn && Array.isArray(hit.networks) && hit.networks.length) {
      // A VERIFIED live read outranks a manifest claim: union the chains the
      // 402 actually offered into the freshly rebuilt (manifest-shaped) row,
      // and carry when they were verified so the weekly re-read keeps its clock.
      // Own row only, like the stamp above. A declared sibling verb that
      // already names chains in the seller's document was never read: until
      // 2026-09-28 it took the other verb's chains and stamp here, and, once
      // verified reads were carried, kept them rebuild after rebuild as its own
      // "verified read" - hidden from its own weekly read, and listing the
      // other verb's chains (and, below, its Base payTo) as the sibling's.
      // Rows written that way are still in the persisted cache, stamped with
      // no verb, which is why the gate is readIsOwn and not ownRead.
      t.networks = [...new Set([...(t.networks || []), ...hit.networks])];
      t.networksVerifiedAt = hit.networksVerifiedAt;
      t.networksVerifiedMethod = hit.networksVerifiedMethod.toUpperCase();
    }
    // Remember which of the row's chains its documents named, whenever a
    // remembered chain has joined them: a later live re-read keeps those and
    // replaces the rest with what the 402 offers then (applyLiveNetworks), so
    // a chain the seller withdraws from its 402 leaves the row instead of
    // being carried forever. Kept when already present: a row object reused
    // unchanged from an earlier crawl (an OpenAPI 304) already holds its own.
    if (!Array.isArray(t.documentedNetworks) && (t.networks || []).some((n) => !ownChains.includes(n))) t.documentedNetworks = ownChains;
    // The domain observation and the payTo describe the chains of the read
    // they came from, so they ride only where those chains do: onto the read's
    // own row, or onto a row that just took the hit's chains.
    const carriesPayment = readIsOwn || tookChains;
    // The domain observation rides with the verified read it came from: a
    // manifest-shaped rebuild has no accepts of its own, and without this the
    // label would forget a wrong-domain seller on every crawl.
    if (carriesPayment && !t.evmDomainByNetwork && hit.evmDomainByNetwork && typeof hit.evmDomainByNetwork === "object") t.evmDomainByNetwork = { ...hit.evmDomainByNetwork };
    // The payTo the live 402 named rides forward the same way, per network,
    // filling a GAP only: a manifest-shaped rebuild names no wallet on a
    // bare-string resource, and without this every crawl would forget the one
    // address the Base scan needs. A network the rebuilt row already carries a
    // payTo for keeps it (the origin's own current document, read this crawl).
    if (carriesPayment && hit.payToByNetwork && typeof hit.payToByNetwork === "object") {
      const remembered = Object.entries(hit.payToByNetwork).filter(([, addr]) => typeof addr === "string" && addr);
      // The spread ORDER is the whole rule: what this crawl read from the
      // origin wins, the remembered address fills the rest. Filtering the
      // remembered entries as well would make each guard unkillable by the
      // other, so a test could not tell either of them from a no-op.
      // One exception, by SOURCE rather than by order (2026-10-03): a payTo
      // this crawl took only from a REGISTRY row does not outrank a
      // remembered address the origin itself named (its live 402 or its own
      // documents). A Bazaar row is rebuilt into every crawl, so without this
      // the wallet a seller had left came back on the first crawl after a
      // re-registration had read the new one from the live 402.
      if (remembered.length) {
        const current = t.payToByNetwork || {};
        const next = { ...current }, sources = {};
        for (const net of Object.keys(current)) sources[net] = payToSourceOf(t, net);
        for (const [net, addr] of remembered) {
          const hitSource = payToSourceOf(hit, net);
          if (!current[net] || (sources[net] === "registry" && ownPayToSource(hitSource))) {
            next[net] = addr; sources[net] = hitSource;
          }
        }
        t.payToByNetwork = next;
        t.payToSourceByNetwork = sources;
      }
    }
    // Verb change: see correctsVerb above. A learned verb that simply answered
    // on its own row is not evidence about a sibling verb - that reading is
    // what mislabelled one seller's POST rows.
    if (correctsVerb) {
      if (hit.methodCorrectedFrom) t.methodCorrectedFrom = hit.methodCorrectedFrom;
      t.method = hit.method; t.methodInferred = false;
      // The live proof belongs to the verb that answered, so it travels with
      // the correction the way the verification stamp does. Carried on exact
      // hits only until 2026-09-28, which lost it on the first rebuild of every
      // corrected row (the rebuilt row states the wrong verb, so it never
      // matches exactly).
      if (Number(hit.liveProvenAt) > 0) t.liveProvenAt = hit.liveProvenAt;
    }
    // Only claim "live-402" for a price this crawl is actually standing behind:
    // a row the origin priced today is origin-declared, not live-learned, and a
    // verified read never carried a learned price at all.
    if (fromQuote && !originPricedThisCrawl) t.quoteSource = "live-402";
  }
  return tools;
}

/** Does the amount we hold disagree materially with what the origin declared
 *  this crawl? Used to spend a live-402 probe on a route we would otherwise
 *  skip, so a price CUT is learned instead of ratcheting. Deliberately a
 *  RATIO test: a rounding difference is not worth a probe, a 2x is. */
const QUOTE_DRIFT_FACTOR = Number(process.env.QUOTE_DRIFT_FACTOR) || 2;
/** Has a learned quote gone unverified for long enough to re-ask the seller?
 *  The drift test above only fires when the origin DECLARES a price, and most
 *  crawled sellers publish none - for them a learned amount would otherwise
 *  stand forever, which is the same ratchet by a quieter route. An unstamped
 *  quote counts as stale once, so pre-existing rows get one refresh. Budgeted
 *  and backed-off like every other probe. */
const QUOTE_MAX_AGE_MS = Number(process.env.QUOTE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000;
export function quoteIsStale(t, now = Date.now()) {
  if (t?.quoteSource !== "live-402") return false;
  if (!(Number(t?.price) > 0)) return false;
  const at = Number(t?.quoteObservedAt);
  if (!Number.isFinite(at) || at <= 0) return true; // never stamped: refresh once
  return now - at >= QUOTE_MAX_AGE_MS;
}

// A manifest-priced, manifest-networked row was never read live: the crawler
// had nothing to LEARN (price and chains both present), so a seller who added
// a rail to their 402 middleware and not to their manifest stayed listed
// single-chain forever (2026-09-02: live 402 offers Base
// AND Algorand, manifest says Base, our row said Base; reported by the seller
// on issue #1178). One live read, then a weekly one, unions what the 402
// actually offers into the row. Learned quotes have their own clock
// (quoteIsStale); this is the manifest-vs-402 consistency check.
const NETWORKS_VERIFY_AGE_MS = Number(process.env.NETWORKS_VERIFY_AGE_MS) || 7 * 24 * 60 * 60 * 1000;
export function networksNeedLiveVerify(t, now = Date.now()) {
  if (!t || t.quoteSource === "live-402") return false;
  if (!(Number(t.price) > 0)) return false;
  if (!(Array.isArray(t.networks) && t.networks.length)) return false;
  const at = Number(t.networksVerifiedAt);
  if (!Number.isFinite(at) || at <= 0) return true;
  // A stamp that names no verb, or another verb, is no read of this row's own
  // (stampIsOwn): carry-forward no longer passes such a stamp on, and a row
  // still holding one is read rather than left to the clock.
  if (!stampIsOwn(t)) return true;
  // The stamp's clock covers a row whose PRICE is the origin's own declaration
  // (a live 402 is the other price source, and it returned above). A priced
  // row carrying a stamp but neither is a row whose price came from somewhere
  // no read looked at: the origin stopped declaring and the rebuild took a
  // registry's settlement snapshot, while carry-forward kept the stamp of the
  // read made beside the old declaration. Before verified reads were carried
  // such a row had no stamp and was read on the next crawl; it still is.
  if (!(Number(t.originDeclaredPrice) > 0)) return true;
  return now - at >= NETWORKS_VERIFY_AGE_MS;
}

export function priceDisagreesWithOrigin(t) {
  const held = Number(t?.price), declared = Number(t?.originDeclaredPrice);
  if (!(held > 0) || !(declared > 0)) return false;
  const ratio = held > declared ? held / declared : declared / held;
  return ratio >= QUOTE_DRIFT_FACTOR;
}

/** Per-crawl quote-probe cap for one origin. The polite steady-state is
 * LIVE_QUOTE_PROBES_PER_CRAWL - but an origin with ZERO priced tools is
 * wholly invisible to routing (the resolver only pays priced rows), and at 5
 * per 30-min cycle a new 128-route seller stays unroutable for half a day
 * (measured live 2026-09-01: a seller registered, proven on-chain, and
 * unroutable for hours while the rotation crept). A catalog with nothing
 * priced gets a one-time burst - the seller REGISTERED to be found, and a
 * single burst on a new listing is what they asked for - then drops to the
 * polite cap the moment anything is priced. Pure; exported for the test. */
export function quoteProbeCapFor(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const priced = list.filter((t) => Number(t?.price) > 0).length;
  const unpriced = list.length - priced;
  // "Zero priced" was the first predicate and it missed the live case: a
  // registry merge had already priced a handful of one seller's 128 rows,
  // so the burst never fired and the catalog stayed 90% invisible. The state
  // that starves a seller is OVERWHELMINGLY unpriced, not perfectly unpriced:
  // burst while at least 20 rows are unpriced and priced rows are under a
  // quarter of the unpriced count, polite cap the rest of the time.
  if (unpriced >= 20 && priced < unpriced / 4) {
    return Math.max(LIVE_QUOTE_PROBES_PER_CRAWL, Number(process.env.NEW_CATALOG_QUOTE_BURST || "60"));
  }
  return LIVE_QUOTE_PROBES_PER_CRAWL;
}

/**
 * Write the payTo a live 402 named, per network, onto an index row. The live
 * read REPLACES what the row held for each network it names (the 402 is the
 * current word on where the origin is paid) and leaves networks it does not
 * name alone; a network the read withdrew from the row loses its payTo in
 * applyLiveNetworks, which runs first.
 * Always a fresh object: manifest rows on one path can share one
 * payToByNetwork, and writing into it would move a sibling's address too.
 */
function applyLivePayTo(row, payToByNetwork) {
  if (!row || !payToByNetwork || typeof payToByNetwork !== "object") return;
  const live = Object.entries(payToByNetwork).filter(([net, addr]) => typeof net === "string" && net && typeof addr === "string" && addr);
  if (!live.length) return;
  row.payToByNetwork = { ...(row.payToByNetwork || {}), ...Object.fromEntries(live) };
  // Stamped, so a later crawl can tell the origin's own live word from a
  // registry's record of an earlier payment (payToSourceOf).
  row.payToSourceByNetwork = { ...(row.payToSourceByNetwork || {}), ...Object.fromEntries(live.map(([net]) => [net, "live"])) };
}

/**
 * Write the chains a live 402 offered onto an index row. The row keeps every
 * chain its own documents name (`documentedNetworks`, recorded by
 * carryForwardLearnedQuotes; a row without the record holds only documented
 * chains and live reads already folded in, all of which are kept) and takes
 * the offered set for the rest: a chain an earlier read found and this one
 * does not is withdrawn, with its payTo. Until 2026-09-28 the read was a pure
 * union, so a chain the seller removed from its 402 stayed listed, with its
 * old wallet, for as long as the route was indexed. A read that names no
 * chain says nothing about chains and changes none. Fresh objects only, like
 * applyLivePayTo: rows on one path can share their arrays.
 */
function applyLiveNetworks(row, liveNetworks) {
  if (!row || !Array.isArray(liveNetworks) || !liveNetworks.length) return;
  const before = Array.isArray(row.networks) ? row.networks : [];
  const documented = Array.isArray(row.documentedNetworks) ? row.documentedNetworks : before;
  const after = [...new Set([...documented, ...liveNetworks])];
  row.networks = after;
  if (!Array.isArray(row.documentedNetworks) && after.some((n) => !documented.includes(n))) row.documentedNetworks = [...documented];
  const withdrawn = before.filter((n) => !after.includes(n));
  if (withdrawn.length && row.payToByNetwork && typeof row.payToByNetwork === "object") {
    const kept = { ...row.payToByNetwork };
    for (const n of withdrawn) delete kept[n];
    row.payToByNetwork = kept;
    if (row.payToSourceByNetwork && typeof row.payToSourceByNetwork === "object") {
      const keptSources = { ...row.payToSourceByNetwork };
      for (const n of withdrawn) delete keptSources[n];
      row.payToSourceByNetwork = keptSources;
    }
  }
}

// WHY a live-402 read learned nothing, counted. Across the index about half of
// all rows miss a chain the seller offers and ~30% have no price (measured
// 2026-09-23); the required-query-parameter case explained only part of it, and
// nothing recorded why the rest fail. Each missed route is filed under the
// outcome of its FIRST attempt (the primary target and verb), and every attempt
// is counted by verb and status, so the dominant cause can be read off prod
// instead of guessed. Counts only: no URL, no origin, no body.
const quoteProbeStats = { since: Date.now(), probed: 0, learned: 0, free: 0, missed: 0, missByFirst: {}, attempts: {} };
function bump(map, key) { map[key] = (map[key] || 0) + 1; }
export function probeFailureCode(err) {
  const name = String(err?.name || "");
  const code = String(err?.cause?.code || err?.code || "");
  if (name === "TimeoutError" || name === "AbortError" || /TIMEOUT/.test(code)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return "dns";
  if (/ECONNRESET|UND_ERR_SOCKET/.test(code)) return "reset";
  if (/ECONNREFUSED/.test(code)) return "refused";
  if (/CERT|SSL|TLS|ERR_TLS/i.test(code + " " + String(err?.message || ""))) return "tls";
  if (Number(err?.statusCode) === 400 || /private|public|blocked|not allowed/i.test(String(err?.message || ""))) return "ssrf-blocked";
  return "error";
}
// Up to 20 unreadable-402 shapes, newest kept: host + route + the key names
// of the decoded header and body and the first 160 characters of the body.
// Operator surface only; it exists to name the next format we fail to read.
const unreadable402Samples = [];
function sampleUnreadable402(originUrl, route, header, body) {
  const keysOf = (txt, b64) => {
    try { const o = JSON.parse(b64 ? Buffer.from(String(txt).trim(), "base64").toString("utf8") : String(txt)); return o && typeof o === "object" ? Object.keys(o).slice(0, 12) : typeof o; } catch { return txt ? "unparseable" : null; }
  };
  let host = ""; try { host = new URL(originUrl).host; } catch { /* keep blank */ }
  unreadable402Samples.push({ host, route: String(route).slice(0, 120), headerKeys: header ? keysOf(header, true) : null, bodyKeys: keysOf(body, false), body: String(body || "").slice(0, 160) });
  if (unreadable402Samples.length > 20) unreadable402Samples.shift();
}
export function quoteProbeStatsSnapshot() {
  const top = (m) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25));
  return { since: new Date(quoteProbeStats.since).toISOString(), probed: quoteProbeStats.probed, learned: quoteProbeStats.learned, free: quoteProbeStats.free, missed: quoteProbeStats.missed, missByFirst: top(quoteProbeStats.missByFirst), attempts: top(quoteProbeStats.attempts), unreadable402Samples: [...unreadable402Samples] };
}
let quoteProbeSummaryAt = Date.now();
function maybeLogQuoteProbeSummary(now = Date.now()) {
  if (now - quoteProbeSummaryAt < 60 * 60_000) return;
  quoteProbeSummaryAt = now;
  const s = quoteProbeStatsSnapshot();
  console.log(`[x402-index] live-402 probe outcomes since ${s.since}: probed ${s.probed}, learned ${s.learned}, missed ${s.missed}; misses by first attempt ${JSON.stringify(s.missByFirst)}`);
}

/** Write a live-402 price onto a row: fills a gap, and replaces a held price
 *  that differs (logged with both figures, so a correction is never silent). */
export function adoptLivePrice(row, livePrice, originUrl = "") {
  if (!row || livePrice == null) return;
  const live = priceToMicroUsd(livePrice);
  if (!(live > 0)) return;
  const held = priceToMicroUsd(row.price);
  if (held === live) return;
  if (held > 0) console.log(`[x402-index] live-402 price: ${originUrl}${row.route} ${microUsdToPrice(held)} -> ${microUsdToPrice(live)} (the route's own 402)`);
  row.price = livePrice;
  delete row.quoteCarriedForward;
}

export async function enrichLiveQuotes(tools, originUrl, { ignoreBudget = false, maxProbes = null, onProbed = null } = {}) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  dropGoneRoutes(tools, originUrl);
  if (!tools.length) return tools;
  const candidates = tools.filter(
    (t) => t
      && typeof t.route === "string" && t.route.startsWith("/")
      && t.seller !== LOCAL_SELLER                      // never probe ourselves
      // Already priced: nothing to learn - UNLESS the amount we hold disagrees
      // with what the origin declared this crawl. That disagreement is exactly
      // how a price CUT used to be invisible: a priced route was never
      // re-probed, so the live 402 that would correct it was never fetched
      // (reported 2026-08-29, a 10x overquote standing for nine days).
      // A row missing EITHER the price or the networks is a candidate. This
      // was && - both had to be missing - so a probe that learned networks
      // but could not price (the Solana isUsdc gap) LOCKED the row unpriced
      // for the 7-day staleness window: networks known, price null, never
      // probed again (measured 2026-09-01).
      && ((!(Number(t.price) > 0) || !(Array.isArray(t.networks) && t.networks.length)) || priceDisagreesWithOrigin(t) || quoteIsStale(t) || networksNeedLiveVerify(t)
        // An explicit re-registration ("price my catalog NOW") also re-asks
        // every route whose price is NOT the origin's own declaration - a
        // learned quote, or a Bazaar settlement snapshot. Issue #1365
        // (2026-09-15): a seller made a route free, re-registered, and the
        // 0.001 learned two weeks earlier stood because a priced row was never
        // a candidate until its 7-day clock ran out.
        || (ignoreBudget && Number(t.price) > 0 && !(Number(t.originDeclaredPrice) > 0))
        // ...and every route whose held price differs from the origin's own
        // declaration AT ALL. The automatic crawl waits for a 2x drift
        // (QUOTE_DRIFT_FACTOR) to stay polite; a seller who re-registers is
        // asking us to look now, and a 1.67x gap is still a wrong price.
        || (ignoreBudget && Number(t.price) > 0 && Number(t.originDeclaredPrice) > 0
          && priceToMicroUsd(t.price) !== priceToMicroUsd(t.originDeclaredPrice))
        // ...and every route whose chains, payTo and EIP-712 domain came from
        // a past live read. The price of an origin-priced row is the origin's
        // own and needs no re-ask, but those three fields are the 402's, and
        // carry-forward keeps a verified read across rebuilds, so the automatic
        // crawl re-reads them only on the weekly networksNeedLiveVerify clock.
        // A seller who fixed a wrong USDC domain (the fix we ask them to make,
        // then re-register) or moved its payout wallet would otherwise keep the
        // old observation for up to a week, with the router skipping them on it
        // and the Base scan reading the old wallet.
        || (ignoreBudget && Number(t.networksVerifiedAt) > 0 && Array.isArray(t.networks) && t.networks.length > 0))
      // (An undeclared route needs no clause of its own here: the staleness
      // tests above re-ask every priced row within the same 7 days that
      // needsLiveProof measures, off the same timestamps.)
      // A route observed free inside the quote window is left alone by the
      // automatic crawl; an explicit re-registration still re-asks it.
      && (ignoreBudget || !isObservedFree(t))
      && probeMethodsFor(t).length                       // never PUT/PATCH/DELETE
      && probeDue(originUrl, `quote:${t.route}`),
  );
  // NEVER-ATTEMPTED rows first. The first rotation attempt indexed a window
  // into a list that SHRINKS as rows price, so some rows landed in skipped
  // windows on every pass (one seller's stock routes, three passes running,
  // 50 of 114 priced around them). Rows a probe has already touched carry
  // quoteObservedAt - putting untouched rows ahead means each pass drains new
  // ground before re-visiting networks-only learns, and coverage completes in
  // ceil(candidates/cap) passes regardless of how the list shrinks.
  // ignoreBudget = an explicit re-registration ("price my catalog now"), so
  // clear as many still-unpriceable routes as one bounded pass allows
  // (REPRICE_MAX_PER_CALL) rather than the polite auto-cycle cap - otherwise a
  // 128-route seller with 45 priced drains 5/pass over a dozen passes. The
  // automatic crawl keeps the gentle cap. Untouched rows first either way, so
  // each pass makes new ground.
  //
  // quoteObservedAt alone does not say "touched": a row the rebuild priced
  // from a registry snapshot keeps a learned quote's stamp but not its age,
  // so it is due on every crawl and reads as never attempted. A stamp naming
  // the row's own verb (stampIsOwn) is the other record of a read, so such a
  // row goes behind the rows that hold neither. Those include a learned quote
  // whose read was withheld (carryForwardLearnedQuotes: a stamp naming no
  // verb, on a row with chains of its own), which keeps no payTo until its
  // own read. Ranked level with the snapshot rows, a cap's worth of those
  // ahead in array order took every crawl's probes and that read never came.
  // Rows with an age still go last, as before.
  const readRank = (t) => (t.quoteObservedAt ? 2 : stampIsOwn(t) ? 1 : 0);
  const repriceCap = Number(process.env.REPRICE_MAX_PER_CALL || "120");
  let cap = ignoreBudget ? repriceCap : Math.min(quoteProbeCapFor(tools), liveQuoteBudget);
  // A caller-supplied ceiling (the re-registration's per-origin hourly
  // allowance) can only LOWER the cap, never raise it.
  if (maxProbes != null && Number.isFinite(Number(maxProbes))) cap = Math.min(cap, Math.max(0, Math.floor(Number(maxProbes))));
  const rotated = [...candidates]
    .sort((a, b) => readRank(a) - readRank(b))
    .slice(0, Math.max(0, cap));
  if (typeof onProbed === "function") { try { onProbed(rotated.length); } catch { /* accounting only */ } }
  if (!rotated.length) return tools;
  if (!ignoreBudget) liveQuoteBudget -= rotated.length;

  const { assertPublicUrl, ssrfDispatcher } = await import("./tools/fetch-guard.js");
  const dropped = new Set();
  for (const tool of rotated) {
    let learned = null;
    let freeObserved = false;
    let gone = false;
    let firstOutcome = null;
    const own = String(tool.method || "GET").toUpperCase();
    const statusByMethod = {};
    // Every answer per verb, a thrown attempt recorded as 0: a verb "refused"
    // only when every attempt on it said so (see the sibling branch below).
    const answersByMethod = {};
    const note = (method, outcome) => {
      const k = `${method} ${outcome}`;
      bump(quoteProbeStats.attempts, k);
      if (!firstOutcome) firstOutcome = k;
    };
    probe: for (const { target, method, body: reqBody } of probeAttemptsFor(originUrl, tool)) {
      try {
        // Crawled URLs are external data and could DNS-rebind between crawl and
        // now: validate then pin, exactly as probePaywall does.
        await assertPublicUrl(target);
        const res = await fetch(target, {
          method,
          headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
          ...(method === "POST" ? { body: reqBody } : {}),
          dispatcher: ssrfDispatcher,
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
        // A GET that returns 200 has ANSWERED: the route is not paywalled, and
        // there is nothing a POST can add. Following it with an unpaid POST is
        // a second request to somebody else's endpoint on the exact shape most
        // likely to do something - an endpoint that serves on GET and mutates
        // on POST. We stop.
        //
        // Every other status still falls through to POST, because that is what
        // discovers a POST-only seller: a 404 or 405 on GET is expected there
        // and is the whole reason the second method is tried.
        note(method, String(res.status));
        statusByMethod[method] = res.status;
        (answersByMethod[method] ||= []).push(res.status);
        if (method === "GET" && res.status === 200) {
          // The route answered WITHOUT a paywall. If the price we hold was
          // learned (a past 402, or a Bazaar settlement snapshot) rather than
          // declared by the origin this crawl, and the row's own verb is GET,
          // that price is retired: a paid-to-free transition is the seller's
          // decision and the index must follow it (issue #1365, 2026-09-15 -
          // before this the 200 was noted, nothing was learned, and the old
          // quote stood). The retirement is stamped so the next crawl's
          // carry-forward keeps it over the Bazaar snapshot, and the row stays
          // a probe candidate (unpriced), so a later 402 re-prices it.
          if (String(tool.method || "GET").toUpperCase() === "GET" && Number(tool.price) > 0 && !(Number(tool.originDeclaredPrice) > 0)) {
            const was = tool.price;
            tool.price = null; tool.paid = false;
            tool.quoteSource = "live-200"; tool.quoteRetiredAt = Date.now(); tool.quoteObservedAt = Date.now();
            tool.liveProvenAt = Date.now();
            delete tool.quoteCarriedForward;
            console.log(`[x402-index] live-200: ${originUrl}${tool.route} answered GET 200 with no paywall; retired the learned price ${was}`);
          } else if (String(tool.method || "GET").toUpperCase() === "GET" && !(Number(tool.price) > 0) && !(Number(tool.originDeclaredPrice) > 0)) {
            // An UNPRICED row that answers 200 is a free route (health, docs,
            // previews, free data: 36 of 36 in a 2026-09-23 sample). Until now
            // it stayed "price unknown" and was re-probed every crawl - ~640
            // probes an hour, 37% of all misses. Stamp it free; the automatic
            // crawl leaves it alone for the quote window, a re-registration
            // re-asks.
            // Only when the body is the route working, not an error page (src/tool-judge.js).
            const raw = (await readTextCapped(res, 2000).catch(() => "")).slice(0, 2000);
            const bodyText = looksLikeListingInjection(raw) ? null : raw;   // text written to steer a judgment is not sent
            const verdict = bodyText == null ? null : await judgeFreeResponse(bodyText, res.headers.get("content-type") || "");
            if (verdict === "free") {
              tool.paid = false;
              tool.quoteSource = "live-200"; tool.freeObservedAt = Date.now(); tool.quoteObservedAt = Date.now();
              freeObserved = true;
            } else {
              note(method, verdict === "error" ? "200-error-body" : "200-unsure");
            }
          }
          break probe;
        }
        // 410 on the row's own verb: the seller retired this route.
        if (res.status === 410 && method === own) { gone = true; break probe; }
        if (!isQuoteResponse(res.status)) continue;   // 404 on GET is expected for a POST-only seller
        // The quote lives in the header for x402 v2 and in the body for several
        // real sellers; read a bounded slice of both and let the parser decide.
        const body = await readTextCapped(res, 64_000).catch(() => "");
        // Networks normalised ONCE, as paymentFieldsFromAccepts does for a
        // manifest or registry row: a v1-style 402 that names "base" must key
        // its payTo under eip155:8453, or allPayToOrigins (which reads that
        // key) never sees the wallet and the Base scan never credits it.
        const live = acceptsFromLive402({ header: res.headers.get("payment-required"), body: body.slice(0, 64_000) });
        const quote = quoteFromAccepts(Array.isArray(live)
          ? live.map((a) => (a && typeof a.network === "string" ? { ...a, network: normalizeNetwork(a.network) } : a))
          : live);
        if (quote) { learned = { ...quote, method }; break probe; }
        // A 402 whose accepts we could not turn into a quote. An MPP-only
        // seller answers with a Payment challenge and no x402 accepts at all:
        // counted apart, because it is not a parser gap. The rest are sampled
        // (shape only) so the next format we fail to read can be named.
        const mppOnly = /^Payment\b/i.test(String(res.headers.get("www-authenticate") || "").trim());
        note(method, mppOnly ? "402-mpp-only" : "402-unreadable");
        if (!mppOnly) sampleUnreadable402(originUrl, tool.route, res.headers.get("payment-required"), body);
      } catch (err) {
        note(method, probeFailureCode(err));
        (answersByMethod[method] ||= []).push(0);
        /* unreachable, blocked, or malformed - try the next method */
      }
    }
    if (gone) {
      markRouteGone(originUrl, own, tool.route, { kind: "410" });
      dropped.add(tool);
      quoteProbeStats.probed++;
      console.log(`[x402-index] live-410: ${originUrl}${tool.route} answered ${own} 410 Gone; dropped the row`);
      continue;
    }
    // An undeclared route whose own verb answered "no such route" is not for
    // sale. Only a definitive answer counts: a timeout, 5xx, 429, 401/403 or a
    // 400 on our probe body says nothing. A row whose verb was inferred must
    // miss on every verb tried; a URL template is never probed literally.
    const MISS = new Set([404, 405, 410]);
    // The quote belongs to the row of the verb that answered. When that is not
    // the stated verb and the seller ALSO declares the answering verb on this
    // route, the declared sibling takes the read, and the stated row keeps
    // nothing from it (see the sibling branch below).
    const answered = learned?.method ? String(learned.method).toUpperCase() : own;
    const sibling = learned && answered !== own
      ? tools.find((o) => o !== tool && o.route === tool.route && String(o.method || "").toUpperCase() === answered)
      : null;
    // Did the stated verb itself refuse, definitively, on every attempt? Only
    // then does the sibling branch drop the stated row. The length test is a
    // belt: probeMethodsFor always tries the stated verb first, so no current
    // path reaches it, but an empty list would otherwise read as a refusal.
    const statedRefused = Boolean(sibling) && (answersByMethod[own] || []).length > 0
      && answersByMethod[own].every((st) => MISS.has(st));
    if (learned || freeObserved) {
      const proven = sibling || tool;
      proven.liveProvenAt = Date.now();
      clearGoneMark(originUrl, sibling ? answered : own, tool.route);
    }
    const missCandidate = !learned && !freeObserved && tool.declared === false && !String(tool.route).includes("{") && MISS.has(statusByMethod[own]);
    // An inferred POST is only ever probed with POST; before calling a guessed
    // verb's miss a miss, ask the route once with a read-only GET.
    if (missCandidate && tool.methodInferred && statusByMethod.GET === undefined) {
      try {
        // seller + route, as every other probe builds it: a path seller's routes
        // are relative to its prefix, which URL resolution against the key drops.
        const target = sellerRouteUrl(originUrl, tool.route);
        if (!target) throw new Error("route outside the seller");
        await assertPublicUrl(target);
        const r = await fetch(target, { method: "GET", headers: { Accept: "application/json" }, dispatcher: ssrfDispatcher, redirect: "manual", signal: AbortSignal.timeout(8000) });
        statusByMethod.GET = r.status;
        await r.body?.cancel?.().catch?.(() => {});
      } catch { statusByMethod.GET = 0; }
    }
    if (missCandidate
        && (!tool.methodInferred || Object.values(statusByMethod).every((st) => MISS.has(st)))) {
      // First sighting: remember it and keep the row. Confirmed only by a
      // second miss at least MISS_CONFIRM_MS later.
      const prior = goneMark(originUrl, own, tool.route);
      if (!prior || prior.kind !== "pending" || Date.now() - prior.at < MISS_CONFIRM_MS) {
        if (!prior || prior.kind !== "pending") markRouteGone(originUrl, own, tool.route, { kind: "pending" });
        noteProbeOutcome(originUrl, `quote:${tool.route}`, false);
        quoteProbeStats.probed++;
        console.log(`[x402-index] live-miss (first): ${originUrl}${tool.route} answered ${own} ${statusByMethod[own]}; kept until a second miss`);
        continue;
      }
      markRouteGone(originUrl, own, tool.route, { kind: "miss" });
      dropped.add(tool);
      quoteProbeStats.probed++;
      console.log(`[x402-index] live-miss: ${originUrl}${tool.route} is not in the seller's documents and answered ${own} ${statusByMethod[own]}; dropped the row`);
      continue;
    }
    // A quote that went to a declared sibling taught the stated row nothing
    // about itself, so the route backs off like any probe that learned nothing
    // (the stated row stays a candidate, and without this it would be asked
    // again, both verbs, on every crawl). The sibling was just read and is not
    // due again for days; a successful read of its own clears the backoff.
    noteProbeOutcome(originUrl, `quote:${tool.route}`, Boolean(learned) && !sibling);
    quoteProbeStats.probed++;
    if (learned) quoteProbeStats.learned++;
    else if (freeObserved) quoteProbeStats.free++;
    else { quoteProbeStats.missed++; bump(quoteProbeStats.missByFirst, firstOutcome || "none"); }
    if (!learned) continue;
    if (sibling) {
      // The stated verb did not answer a quote, and the seller ALSO declares
      // the verb that did on this route: the read is the sibling's, and only
      // the sibling is written. The stated row is dropped only when its own
      // verb refused definitively (404/405/410 on every attempt): an OpenAPI
      // that lists GET and POST on one path where only POST is real, a
      // declaration the seller does not honour, which would send buyers a verb
      // that 405s. Any other answer (a 400 from a route that validates its
      // input before the paywall, 401/403, 5xx, a timeout) says nothing about
      // whether the stated verb is for sale, so the row stays exactly as it
      // was. Until 2026-09-28 any non-402 dropped it, and the drop writes no
      // gone mark, so a declared product left the index on every crawl and
      // came back on every rebuild.
      adoptLivePrice(sibling, learned.price, originUrl);
      applyLiveNetworks(sibling, learned.networks);
      if (learned.evmDomainByNetwork) sibling.evmDomainByNetwork = { ...learned.evmDomainByNetwork };
      applyLivePayTo(sibling, learned.payToByNetwork);
      // The stamp names the verb whose 402 was read (stampIsOwn), here the
      // sibling's own.
      sibling.networksVerifiedAt = Date.now();
      sibling.networksVerifiedMethod = answered;
      if (statedRefused) {
        dropped.add(tool);
        console.log(`[x402-index] live-402: ${originUrl}${tool.route} refuses ${own} and answers ${answered}; the seller declares both, dropping the ${own} row (sibling kept; ${own} answered ${answersByMethod[own].join(",")})`);
      } else {
        console.log(`[x402-index] live-402: ${originUrl}${tool.route} answers ${answered}, not ${own} (${(answersByMethod[own] || []).map((st) => st || "failed").join(",") || "not asked"}); the quote went to the declared ${answered} row and the ${own} row was left as it was`);
      }
      continue;
    }
    // Price may be null for an asset we refuse to guess at; the networks alone
    // still move the row from payable:"unknown" to payable:"x402", which is the
    // honest and useful half of the answer.
    // The live 402 is what a buyer is actually asked to pay, so it is the
    // current word on the price as well as the chains. This used to fill an
    // EMPTY price only, which made every re-probe of a priced row - a drift
    // against the origin's declaration, a stale learned quote, an explicit
    // re-registration - read the right amount and keep the old one (issue
    // #1460, 2026-09-23: a seller re-registered at $0.005 and seven routes
    // still showed the $0.003 learned earlier).
    adoptLivePrice(tool, learned.price, originUrl);
    applyLiveNetworks(tool, learned.networks);
    // The live 402 is the current word on which EIP-712 domain each EVM
    // accept advertises: it replaces any older observation on the row.
    if (learned.evmDomainByNetwork) tool.evmDomainByNetwork = { ...learned.evmDomainByNetwork };
    // And on where the origin asks to be paid. Until 2026-09-22 this was the
    // one field of the 402 the probe threw away: a seller whose manifest names
    // its wallet nowhere a resource reads it (bare-string resources) was listed
    // with an EMPTY payToByNetwork, so allPayToOrigins never offered that
    // wallet to the Base scan and no volume of outside buyers could ever move
    // it past the settlement floor. The address the origin's OWN 402 names is
    // the address the router would pay, so it is own evidence, never inherited
    // (src/evidence-binding.js binds only registry and leaderboard wallets).
    applyLivePayTo(tool, learned.payToByNetwork);
    // The live 402 was read: the row's chains are verified as of now, whatever
    // the manifest claimed (applyLiveNetworks never drops a documented chain).
    // The stamp names the verb that answered, which is this row's verb once
    // the correction below applies (stampIsOwn).
    tool.networksVerifiedAt = Date.now();
    tool.networksVerifiedMethod = answered;
    if (learned.method && learned.method !== tool.method) {
      // The stated verb did not answer a quote and this one did, and no
      // sibling row declares the answering verb (that case took the branch
      // above): a CORRECTION, recorded as such so the next crawl's
      // carry-forward can re-apply it to the freshly rebuilt row (which will
      // state the wrong verb again) without ever touching a row whose own verb
      // was never probed.
      const stated = own;
      tool.methodCorrectedFrom = stated;
      tool.method = learned.method; tool.methodInferred = false;
    }
    tool.quoteSource = "live-402";
    // WHEN we learned it. Without this a learned price has no age, so nothing
    // can tell a quote observed an hour ago from one observed in July - and a
    // seller who cuts a price we learned months ago has no way to reach us
    // (issue #1043: the only correcting signal was an origin-declared price,
    // which ~95% of crawled sellers do not publish).
    tool.quoteObservedAt = Date.now();
    // Say so. `quoteSource` is not serialized by the row mappers, so without
    // this line the only way to tell whether enrichment ever ran was to watch a
    // price appear and hope - which is how an inert feature hides.
    console.log(`[x402-index] live-402 quote: ${originUrl}${tool.route} -> ${learned.price == null ? "networks only" : "$" + learned.price} (${learned.method})`);
  }
  // Two call sites ignore the return value and read the array they passed, so
  // a dropped row must leave the array itself, not just the returned copy.
  if (dropped.size) for (let i = tools.length - 1; i >= 0; i--) if (dropped.has(tools[i])) tools.splice(i, 1);
  maybeLogQuoteProbeSummary();
  return tools;
}

// A native MPP-dual-stack seller's 402 carries WWW-Authenticate: Payment -
// exactly what our own src/mpp-shim.js emits, and the same check the paid
// canary's mpp leg uses. Extracted as its own pure function (mirrors
// itemHasMainnetAccept/isJunkOrigin above) so the detection logic is
// directly unit-testable without mocking an HTTP server.
export function isMppChallenge(wwwAuthHeaderValue) {
  return !!wwwAuthHeaderValue && /^Payment\b/i.test(String(wwwAuthHeaderValue).trim());
}

async function probePaywall(tools) {
  // A cached tool row has NO `url` field — the callable URL is derived as
  // seller + route, the same way routeQuery builds it (see the `url:` mapping
  // further down this file). The first version of this filtered on
  // `typeof t.url === "string"`, which no producer ever sets, so the probe
  // returned null for every seller and `paywall` was permanently null. It read
  // as "not probed yet" and was really "never probes anything" — the same
  // inert-feature defect this module's own header warns about, one field over.
  const paid = (Array.isArray(tools) ? tools : []).filter(
    (t) => t
      && typeof t.seller === "string" && t.seller !== LOCAL_SELLER  // never probe ourselves
      && typeof t.route === "string" && t.route.startsWith("/")
      && Number(t.price) > 0
  );
  // Prefer a GET: no body to guess, and a wrong body shape would produce a 400
  // that says nothing about the paywall.
  const pick = paid.find((t) => String(t.method || "GET").toUpperCase() === "GET") || paid[0];
  if (!pick) return null;
  const method = String(pick.method || "GET").toUpperCase();
  const target = sellerRouteUrl(pick.seller, pick.route);
  if (!target) return null;
  try {
    const { assertPublicUrl, ssrfDispatcher } = await import("./tools/fetch-guard.js");
    // Same guard as the router's live probe: crawled URLs are external data and
    // could DNS-rebind between crawl and now, so validate then pin.
    await assertPublicUrl(target);
    const res = await fetch(target, {
      method,
      headers: { Accept: "application/json", ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
      ...(method !== "GET" ? { body: "{}" } : {}),
      dispatcher: ssrfDispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    // 402 is the ONLY healthy answer for an unpaid call to a paid route. A 200
    // means the route is not actually paywalled; a 5xx means it is broken.
    //
    // Piggybacks the SAME response for MPP detection - zero extra requests.
    // A native MPP-dual-stack seller's 402 carries WWW-Authenticate: Payment
    // (this is exactly what our own src/mpp-shim.js emits, and how the paid
    // canary's mpp leg checks for it - same pattern here). This is a real,
    // live-verified signal (we made the request and read the actual header),
    // never a claim inferred from a registry or a manifest field.
    const mpp = isMppChallenge(res.headers.get("www-authenticate"));
    return { ok: res.status === 402, status: res.status, url: target, at: Date.now(), mpp };
  } catch (e) {
    return { ok: false, status: 0, url: target, at: Date.now(), error: String(e?.message || e).slice(0, 120), mpp: false };
  }
}

// BACK OFF FROM AN ORIGIN THAT KEEPS SAYING NO.
//
// The crawl runs on a fixed cycle and treated an origin that had 404'd hundreds
// of times exactly like a healthy one. A seller wrote in (#645) to report 686
// requests in a week to a /.well-known/x402 that returned 404 every single
// time. They were gracious about it; it was still us hammering someone else's
// origin ~98 times a day to re-learn a fact we already knew.
//
// "Gentle on third-party sellers" was true of the INTERVAL and false of the
// behaviour. An origin that has failed N crawls in a row is re-tried on a
// widening schedule instead, capped, and any success resets it immediately -
// so a seller who fixes their manifest is picked up within the hour rather
// than being punished for having been broken.
// Indexed by CONSECUTIVE failure count, so index 0 is unused and 1..3 are
// deliberately free: three transient failures in a row must not cost a seller
// their listing freshness. Sustained failure widens from 30m to 6h and stops
// there - an origin is never permanently abandoned, because the whole point is
// to notice when they fix it.
export { WELL_KNOWN_PATH, discoveryNote };

const CRAWL_BACKOFF_STEPS_MS = [0, 0, 0, 0, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];
// Keyed origin+PATH, not origin. The first version of this backed off only the
// manifest probe, because that was the path the reporting seller named - and
// the crawl asks every origin for four different files. Measured afterwards:
// 687 indexed sellers reach the fallback chain, an empirical 21 of 25 sampled
// serve NONE of /openapi.json, /agents.json or /llms.txt, and all three were
// re-asked on every cycle forever. That was ~500,000 404s a day across the
// index, roughly 700x the volume of the report that started this, and two of
// those three paths were added in the same afternoon as the fix.
//
// Fixing one named path and leaving its three siblings ungated is the shape of
// bug worth naming: the report is a sample, not the population.
const crawlBackoff = new Map(); // `${origin}|${path}` -> { fails, nextAt }
const bkey = (originUrl, path) => `${originUrl}|${path}`;

/** Should we probe this origin's `path` now?
 *  Scoped per PATH, never per origin: the seller in #645 was serving a complete
 *  catalogue at /agents.json the entire time we were 404ing on the well-known
 *  path. Skipping the origin outright would have cost us their catalogue to
 *  save them a request; skipping only the dead path costs nothing. */
export function probeDue(originUrl, path, now = Date.now()) {
  const b = crawlBackoff.get(bkey(originUrl, path));
  return !b || now >= b.nextAt;
}
export function noteProbeOutcome(originUrl, path, ok, now = Date.now()) {
  const k = bkey(originUrl, path);
  if (ok) { crawlBackoff.delete(k); return; }
  const fails = (crawlBackoff.get(k)?.fails || 0) + 1;
  const step = CRAWL_BACKOFF_STEPS_MS[Math.min(fails, CRAWL_BACKOFF_STEPS_MS.length - 1)];
  crawlBackoff.set(k, { fails, nextAt: now + step });
}

/** Clear every per-path crawl backoff for ONE origin, and the conditional-request
 *  validators with them. Used only by an explicit re-registration: the seller is
 *  asking us to look again, so a path we backed off (or a document we would
 *  revalidate and be told is unchanged) must be re-read rather than skipped.
 *  Scoped to the caller's own origin and rate-limited upstream (5/hour/IP). */
// When an origin was last force-re-crawled by an explicit registration, so the
// cost of that lever is bounded AT THE ORIGIN rather than per caller. Capped
// like every other unbounded-key map here; a restart forgets, which at worst
// allows one extra re-read per origin.
const forcedCrawlAt = new Map();
const FORCED_CRAWL_COOLDOWN_MS = Math.max(60_000, Number(process.env.INDEX_FORCE_CRAWL_COOLDOWN_MS || 15 * 60_000));
export function forcedCrawlDue(originUrl, now = Date.now()) {
  const at = forcedCrawlAt.get(originUrl);
  return !at || now - at >= FORCED_CRAWL_COOLDOWN_MS;
}
export function noteForcedCrawl(originUrl, now = Date.now()) {
  if (forcedCrawlAt.size > 2000) {
    for (const [k, t] of forcedCrawlAt) if (now - t >= FORCED_CRAWL_COOLDOWN_MS) forcedCrawlAt.delete(k);
    if (forcedCrawlAt.size > 2000) forcedCrawlAt.clear();
  }
  forcedCrawlAt.set(originUrl, now);
}
export function __resetForcedCrawlForTest() { forcedCrawlAt.clear(); repriceAt.clear(); repriceSpend.clear(); }

// The same bound for the re-registration's live-402 re-price: a window per
// origin, and an hourly allowance of route probes per origin across calls.
// A restart forgets both, which at worst allows one extra pass per origin.
const repriceAt = new Map();      // origin -> last re-price start
const repriceSpend = new Map();   // origin -> [{ at, n }]
const REPRICE_COOLDOWN_MS = Math.max(60_000, Number(process.env.INDEX_REPRICE_COOLDOWN_MS || 10 * 60_000));
const REPRICE_MAX_PER_ORIGIN_HOUR = Math.max(1, Number(process.env.INDEX_REPRICE_MAX_PER_ORIGIN_HOUR || 240));
const HOUR_MS = 3600_000;
function trimMap(map, keep) {
  if (map.size <= 2000) return;
  for (const [k, v] of map) if (!keep(v)) map.delete(k);
  if (map.size > 2000) map.clear();
}
export function __shiftRecheckClocksForTest(ms) {
  for (const [k, t] of repriceAt) repriceAt.set(k, t - ms);
  for (const [k, t] of forcedCrawlAt) forcedCrawlAt.set(k, t - ms);
  for (const rows of repriceSpend.values()) for (const r of rows) r.at -= ms;
}
export function repriceDue(originUrl, now = Date.now()) {
  const at = repriceAt.get(originUrl);
  return !at || now - at >= REPRICE_COOLDOWN_MS;
}
function noteReprice(originUrl, now = Date.now()) {
  trimMap(repriceAt, (t) => now - t < REPRICE_COOLDOWN_MS);
  repriceAt.set(originUrl, now);
}
function spentThisHour(originUrl, now = Date.now()) {
  const rows = (repriceSpend.get(originUrl) || []).filter((r) => now - r.at < HOUR_MS);
  if (rows.length) repriceSpend.set(originUrl, rows); else repriceSpend.delete(originUrl);
  return rows.reduce((a, r) => a + r.n, 0);
}
export function repriceAllowance(originUrl, now = Date.now()) {
  return Math.max(0, REPRICE_MAX_PER_ORIGIN_HOUR - spentThisHour(originUrl, now));
}
function spendRepriceAllowance(originUrl, n, now = Date.now()) {
  if (!(n > 0)) return;
  trimMap(repriceSpend, (rows) => rows.some((r) => now - r.at < HOUR_MS));
  const rows = repriceSpend.get(originUrl) || [];
  rows.push({ at: now, n });
  repriceSpend.set(originUrl, rows);
}
// What the register answer says about the re-check it did (or did not) run,
// so a seller whose call landed inside a window knows when to try again
// rather than reading a silent no-op as "the fix did not take".
function reverifyReport(originUrl, { reread, repriced, routesProbed }, now = Date.now()) {
  const left = (at, win) => (at ? Math.max(0, Math.ceil((at + win - now) / 1000)) : 0);
  const rereadAfter = reread ? 0 : left(forcedCrawlAt.get(originUrl), FORCED_CRAWL_COOLDOWN_MS);
  const repriceAfter = repriced ? 0 : left(repriceAt.get(originUrl), REPRICE_COOLDOWN_MS);
  const allowance = repriceAllowance(originUrl, now);
  const parts = [];
  parts.push(reread ? "documents re-read now" : `documents were re-read recently; the next re-read is available in ${rereadAfter}s`);
  if (repriced) parts.push(`${routesProbed} route(s) re-checked against their live 402 now`);
  else if (allowance <= 0) parts.push(`this origin's hourly re-check allowance (${REPRICE_MAX_PER_ORIGIN_HOUR} routes) is spent; it refills over the hour`);
  else parts.push(`routes were re-checked recently; the next re-check is available in ${repriceAfter}s`);
  return {
    documentsReread: reread,
    routesRechecked: repriced,
    routesProbed: repriced ? routesProbed : 0,
    rereadCooldownSeconds: Math.round(FORCED_CRAWL_COOLDOWN_MS / 1000),
    recheckCooldownSeconds: Math.round(REPRICE_COOLDOWN_MS / 1000),
    nextRereadInSeconds: rereadAfter,
    nextRecheckInSeconds: repriceAfter,
    recheckAllowancePerHour: REPRICE_MAX_PER_ORIGIN_HOUR,
    recheckAllowanceLeft: allowance,
    note: `${parts.join("; ")}. The crawler also re-reads every listed origin on its own cycle.`,
  };
}

export function clearOriginProbeState(originUrl) {
  let cleared = 0;
  for (const k of [...crawlBackoff.keys()]) {
    if (k.startsWith(`${originUrl}|`)) { crawlBackoff.delete(k); cleared++; }
  }
  cleared += clearValidatorsFor(originUrl);
  return cleared;
}

/** Convenience wrapper for the manifest path (the original call site). */
export function manifestProbeDue(originUrl, now = Date.now()) {
  return probeDue(originUrl, WELL_KNOWN_PATH, now);
}
export function __noteCrawlOutcomeForTest(originUrl, ok, now) { return noteCrawlOutcome(originUrl, ok, now); }
function noteCrawlOutcome(originUrl, ok, now = Date.now()) {
  return noteProbeOutcome(originUrl, WELL_KNOWN_PATH, ok, now);
}

/** Probes currently backed off, for the seller-facing gap report. `origin` is
 *  kept alongside `path` so a consumer can still group by seller. */
export function crawlBackoffState() {
  return [...crawlBackoff.entries()].map(([k, b]) => {
    const i = k.lastIndexOf("|");
    return { origin: k.slice(0, i), path: k.slice(i + 1), fails: b.fails, nextAt: b.nextAt };
  });
}

// ROBOTS.TXT. We honour it, and until now we did not - while our own tollbooth
// product and the site-crawl tool both do, which is a double standard we would
// rightly be called out for and a good way to get null-routed at an edge.
//
// The parser is kit.js's, deliberately: it already carries the catastrophic-
// backtracking guard (a rule with chained wildcards against a long path is
// exponential, and both sides are third-party text). A second implementation
// here would be a second place for that to be got wrong.
//
// FAILS OPEN. A robots.txt we cannot fetch or parse allows the crawl: this is a
// politeness control, and dropping thousands of sellers out of the index over a
// transient 500 on an unrelated file would be a worse outcome than one extra
// request. An explicit Disallow that matches is honoured, and RECORDED on the
// entry rather than silently shrinking the index - a seller who has excluded us
// should be visible as excluded, not absent.
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;  // robots.txt is not a hot document
const ROBOTS_MAX_BYTES = 512 * 1024;
const robotsCache = new Map();               // origin -> { groups, at }
const ROBOTS_UA = "Agent402";

// `fetchText` is injectable so the policy can be tested without a network or a
// resolvable hostname. The default is the real guarded fetch; a test that
// stubbed global fetch instead would silently exercise nothing, because
// assertPublicUrl rejects an unresolvable host before any request is made -
// which is exactly how the first version of the test passed its fail-open cases
// and proved nothing about the blocking ones.
async function robotsGroupsFor(sellerKey, fetchText) {
  // robots.txt is a HOST document: a path seller reads its host's root file,
  // and every seller on one host shares one cached read.
  const originUrl = sellerHostRootOf(sellerKey);
  const hit = robotsCache.get(originUrl);
  if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.groups;
  let groups = [];
  try {
    const text = fetchText
      ? await fetchText(`${originUrl}/robots.txt`)
      : (await crawlFetch(`${originUrl}/robots.txt`, { maxBytes: ROBOTS_MAX_BYTES })).html;
    groups = parseRobots(String(text || ""));
  } catch {
    groups = [];   // unreachable, 404, oversize: nothing to honour
  }
  robotsCache.set(originUrl, { groups, at: Date.now() });
  return groups;
}

/** The matched rule when this origin's robots.txt forbids us this path, else null. */
const OPENAPI_PATH = "/openapi.json";
// True when some group in this robots.txt is addressed to US by name (the
// same substring rule robotsAllows uses to pick a group). A rule written for
// Agent402 specifically is a deliberate refusal and is honoured everywhere.
function robotsNamesUs(groups) {
  const ua = ROBOTS_UA.toLowerCase();
  return groups.some((g) => (g.agents || []).some((a) => a !== "*" && ua.includes(String(a).toLowerCase())));
}

export async function robotsForbids(originUrl, path, { fetchText, manifestPublished = false } = {}) {
  // The x402 discovery document is EXEMPT from robots gating. robots.txt is a
  // control on content crawling; /.well-known/x402 is a protocol endpoint
  // (RFC 8615) a seller publishes for the sole purpose of being fetched by
  // payment-discovery clients. An API host's blanket Disallow: / - a common
  // default - otherwise permanently hides the very document the seller serves
  // to be found: measured live 2026-09-01 on one seller (manifest 200,
  // robots Disallow /, entry stuck as textless registry synthesis, invisible
  // to every route query). Everything else the crawler touches - llms.txt,
  // homepages, tool probes - stays robots-honoured.
  //
  // ONE extension (2026-09-02): once a seller has published that manifest,
  // /openapi.json at the same origin is read even under a BLANKET Disallow.
  // The manifest is the seller's opt-in to machine discovery, and the OpenAPI
  // is the document that NAMES the routes the manifest lists as bare
  // "POST /api/v1/exa/search" strings. Without it, that seller's 128
  // routes carried their path as their name and could not match ordinary
  // task text ("web search" finds nothing in "/api/v1/search"), while the
  // seller's own OpenAPI called that route "Grok Live Search" with a
  // description - measured 2026-09-02, the same day the Solana router was
  // proven against them by typing the path. The exemption never ADDS routes
  // (the merge only enriches paths the manifest or a registry already
  // vouched for), applies only with the manifest in hand (the no-manifest
  // fallback stays robots-honoured), and yields to a robots group that names
  // Agent402 specifically: a blanket `User-agent: *` `Disallow: /` on an API
  // host is a default, a rule addressed to us is a decision.
  if (path === WELL_KNOWN_PATH) return null;
  const groups = await robotsGroupsFor(originUrl, fetchText);
  if (!groups.length) return null;
  // Rules match the path on the HOST, so a path seller's documents are checked
  // at their full location under its prefix.
  const verdict = robotsAllows(groups, ROBOTS_UA, `${sellerPrefixOf(originUrl)}${path}`);
  if (verdict.allowed) return null;
  if (manifestPublished && path === OPENAPI_PATH && !robotsNamesUs(groups)) return null;
  return verdict.matchedRule || "Disallow";
}
export function __resetRobotsCacheForTest() { robotsCache.clear(); }

// The crawl's document reads (robots.txt and every per-origin probe) go through
// this one binding. It is the guarded safeFetch in production; a test swaps it
// for a stub so the real crawl pipeline can be driven without a network (a
// stubbed global fetch would exercise nothing, because safeFetch resolves the
// host before it fetches).
let crawlFetch = (url, opts) => safeFetch(url, opts);
export function __setCrawlFetchForTest(fn) { crawlFetch = typeof fn === "function" ? fn : (url, opts) => safeFetch(url, opts); }
export async function __crawlSellerForTest(originUrl) { return crawlSeller(originUrl); }

/** Fetch `path` on `originUrl` unless it is backed off, recording the outcome.
 *  Every per-origin probe in the crawl goes through here so a new one cannot be
 *  added ungated the way /agents.json and /llms.txt were. */
async function probePath(originUrl, path, { manifestPublished = false, conditional = true, ...opts } = {}) {
  if (!probeDue(originUrl, path)) throw new Error(`probe backed off: ${path}`);
  // Every per-origin probe already funnels through here, so this is the one
  // place robots has to be checked for it to be checked everywhere.
  const forbidden = await robotsForbids(originUrl, path, { manifestPublished });
  if (forbidden) throw Object.assign(new Error(`robots.txt forbids ${path} (${forbidden})`), { robotsBlocked: true });
  try {
    // CONDITIONAL REQUEST. We visit every seller every CRAWL_INTERVAL_MS, which
    // is 288 times a day per origin, and re-downloaded the whole document every
    // time - a manifest capped at 4MB and an openapi at 12MB, for content our
    // own comments describe as slow-changing. Sending the ETag / Last-Modified
    // we already hold lets the origin answer 304 with no body. It costs the
    // seller a header comparison instead of a document, and it is what any
    // well-behaved crawler does; the only reason it was missing is that nobody
    // had counted the requests.
    //
    // Validators are stored per (origin, path) and a 304 leaves them alone -
    // RFC 9110 allows a 304 to omit the ETag it matched on, so overwriting them
    // with a null read would disable revalidation from the second cycle on.
    // A fallback document is read unconditionally: that branch keeps no parsed
    // copy, so a 304 would only be followed by a second, full fetch.
    const stored = conditional ? validatorFor(originUrl, path) : null;
    const res = await crawlFetch(`${originUrl}${path}`, { ...opts, validators: stored, allowNotModified: conditional });
    // A path seller's document must be served from under its own prefix. A
    // redirect to another path on the same host is another app's document,
    // and reading it as this seller's would attribute that app to it.
    if (sellerPrefixOf(originUrl) && res.finalUrl && !isUnderSeller(res.finalUrl, originUrl)) {
      throw new Error(`${path} was redirected outside the seller's path prefix`);
    }
    noteProbeOutcome(originUrl, path, true);
    if (res.notModified) {
      if (res.validators) rememberValidator(originUrl, path, res.validators);
      return res;
    }
    rememberValidator(originUrl, path, conditional ? res.validators || null : null);
    return res;
  } catch (e) {
    noteProbeOutcome(originUrl, path, false);
    throw e;
  }
}

// Per (origin, path) ETag / Last-Modified. Memory-only and bounded by the seed
// set, which is the same population the crawl already visits, so this cannot
// grow beyond it. Cleared for a path whose fetch produced no validators, so an
// origin that STOPS sending them stops being revalidated rather than being sent
// a validator it no longer honours.
const crawlValidators = new Map();
const vkey = (originUrl, path) => `${originUrl}${path}`;
export function validatorFor(originUrl, path) { return crawlValidators.get(vkey(originUrl, path)) || null; }
export function rememberValidator(originUrl, path, validators) {
  const k = vkey(originUrl, path);
  if (validators) crawlValidators.set(k, validators);
  else crawlValidators.delete(k);
}
/** Drop every stored validator for one origin, so its next probe is an
 *  UNCONDITIONAL read. Paired with the backoff clear on an explicit
 *  re-registration: a seller who edited a document and asks us to look again
 *  must not be answered 304 from our own remembered ETag. */
export function clearValidatorsFor(originUrl) {
  let n = 0;
  for (const k of [...crawlValidators.keys()]) {
    if (k.startsWith(originUrl)) { crawlValidators.delete(k); n++; }
  }
  return n;
}

/** Fetch and parse a JSON document, honouring 304.
 *
 *  A 304 carries no body, so the caller must supply what the previous fetch
 *  parsed. When that is missing - a restart dropped it, or the entry was
 *  evicted while the validator survived - we drop the validator and fetch the
 *  document properly rather than reporting a healthy seller as unreadable
 *  because of our own bookkeeping. That is the failure mode a naive 304 path
 *  produces: the origin is fine, we hold a validator, and we have nothing to
 *  pair it with.
 */
/** The body of a fallback document. The manifest branch keeps what its last
 *  fetch derived, but the fallback branch (no /.well-known/x402: /openapi.json,
 *  /agents.json, /llms.txt) keeps nothing, so a 304 there parsed an empty body
 *  and the seller lost every tool from its second crawl on: "\"undefined\" is
 *  not valid JSON" on 8 of 66 crawl_failed origins, 2026-10-07. Fallback reads
 *  are therefore unconditional; a 304 arrives here only when the manifest
 *  branch already fetched /openapi.json conditionally this crawl, and that one
 *  is re-read in full. */
async function fallbackBody(originUrl, path, res, opts) {
  if (!res?.notModified) return res?.html;
  rememberValidator(originUrl, path, null);
  return (await probePath(originUrl, path, opts)).html;
}

async function probeDoc(originUrl, path, opts, prevParsed) {
  const res = await probePath(originUrl, path, opts);
  if (!res.notModified) return { parsed: JSON.parse(res.html), reused: false, finalUrl: res.finalUrl || null };
  if (prevParsed != null) return { parsed: prevParsed, reused: true, finalUrl: res.finalUrl || null };
  rememberValidator(originUrl, path, null);
  const fresh = await probePath(originUrl, path, opts);
  return { parsed: JSON.parse(fresh.html), reused: false, finalUrl: fresh.finalUrl || null };
}

/** The origin a document fetch was permanently redirected to, when it is a
 *  DIFFERENT origin than the one asked; null otherwise. */
export function redirectedOriginOf(originUrl, finalUrl) {
  try {
    if (!finalUrl) return null;
    const a = new URL(originUrl), b = new URL(finalUrl);
    if (canonicalHost(a.origin) === canonicalHost(b.origin)) return null;
    return b.origin;
  } catch { return null; }
}

// One crawl, one fetch of a given document. crawlSeller reached for
// /openapi.json from two independent places (tool discovery and paywall
// classification) plus a revalidation retry, so a seller saw it two or three
// times per 30-minute cycle where once would do. Measured from the OUTSIDE on
// 2026-08-31 by a listed seller whose logs held 3,372 /openapi.json against 681
// /.well-known/x402 over the same window - the manifest count matched our cycle
// exactly, which is what proved the excess was ours and not an impersonator
// running at a different rate.
//
// Per-crawl only: a fresh Map for every crawlSeller call, so nothing is cached
// ACROSS cycles and the crawl still re-reads the world each time.
function oncePerCrawl() {
  const seen = new Map();
  return (key, fn) => {
    if (!seen.has(key)) seen.set(key, fn());
    return seen.get(key);
  };
}

async function crawlSeller(originUrl) {
  const once = oncePerCrawl();
  // `manifestPublished` is set by the well-known branch only: once the seller's
  // manifest is in hand, robotsForbids reads /openapi.json under a blanket
  // Disallow (see the exemption there). The no-manifest fallback below calls
  // this without the flag and stays fully robots-honoured. `once` keys on the
  // path, so whichever branch runs first decides - and the manifest branch
  // runs first only when the manifest was actually fetched.
  const fetchOpenapi = (extra = {}) => once("/openapi.json", () => probePath(originUrl, "/openapi.json", { maxBytes: MAX_OPENAPI_BYTES, ...extra }));
  const prev = cache.get(originUrl);
  try {
    // A manifest that has 404'd repeatedly is not re-probed every cycle.
    // Throwing here drops straight into the fallback chain below, which is the
    // same path a genuine 404 takes - so coverage is identical, we just stop
    // asking a question we already know the answer to.
    const manifestDoc = await probeDoc(originUrl, WELL_KNOWN_PATH, { maxBytes: MAX_MANIFEST_BYTES }, prev?.manifest);
    const manifest = manifestDoc.parsed;
    // A manifest that arrives from ANOTHER origin (safeFetch followed a 301/308)
    // is that origin's manifest: the seller retired this hostname and pointed it
    // at the real one (2026-09-10, a seller wrote in about a Sepolia origin still
    // listed beside its mainnet successor). Recorded so computeAliasOrigins can
    // fold it without needing a homepage field the manifest may not carry.
    const redirectedTo = redirectedOriginOf(originUrl, manifestDoc.finalUrl);
    if (redirectedTo && redirectedTo !== prev?.redirectedTo) console.log(`[x402-index] ${originUrl}: manifest is served from ${redirectedTo} (permanent redirect) - treated as an alias of it`);

    // OpenAPI is the tool-level detail. Best-effort: a seller without one still
    // shows up in the Index based on their manifest alone.
    let openapi = null;
    let tools = [];
    // On a 304 we reuse what the last fetch DERIVED, not the document itself.
    // Keeping a 12MB openapi per origin in memory across ~2,200 origins is not
    // affordable; the two things the pipeline actually needs from it are the
    // normalised tool rows and the full operation-route list, and both are
    // small. So those are what the cache carries.
    let openapiTools = null, openapiRoutes = null;
    try {
      const res = await fetchOpenapi({ manifestPublished: true });
      if (res.notModified && prev?.openapiTools) {
        openapiTools = prev.openapiTools;
        openapiRoutes = prev.openapiRoutes || [];
        tools = openapiTools;
        openapi = prev.openapiSummary ? { paths: {} } : null; // presence only; summary carried forward below
      } else {
        const body = res.notModified
          ? (rememberValidator(originUrl, "/openapi.json", null),
             JSON.parse((await probePath(originUrl, "/openapi.json", { maxBytes: MAX_OPENAPI_BYTES })).html))
          : JSON.parse(res.html);
        openapi = body;
        openapiTools = normaliseOpenapiTools(openapi, originUrl);
        openapiRoutes = openapiAllOperationRoutes(openapi, originUrl);
        tools = openapiTools;
      }
    } catch {
      /* manifest-only seller — fine */
    }

    // Same Bazaar merge as the fallback path below: a manifest seller whose
    // openapi documents only some of its settlement-proven routes (or none —
    // manifest-only sellers) must not LOSE listings by publishing a manifest.
    // Observed live: a seller's toolCount dropped 9 → 2 the moment they added
    // a manifest, because their openapi covered 2 of the 9 routes the Bazaar
    // had settled. Openapi metadata still wins per-route; Bazaar rows without
    // an openapi match pass through.
    tools = mergeOpenapiIntoBazaar(tools, bazaarToolsByOrigin.get(originUrl) || [], {
      allRoutes: openapiRoutes || [],
    });
    // The manifest is folded in LAST and by pathname, so it can only add
    // endpoints nobody else reported or enrich ones already known. It can
    // never add a second row for an endpoint we already list — see
    // mergeManifestIntoTools for the 16 -> 30 regression that proved why.
    tools = mergeManifestIntoTools(normaliseManifestTools(manifest, originUrl), tools);
    tools = dropDeclaredFreeEndpoints(tools, manifest);
    tools = dropUnvouchedNonProductRoutes(tools, (bazaarToolsByOrigin.get(originUrl) || []).map((t) => t.route));
    // Which routes the seller's own documents name; the rest must prove
    // themselves live (see stampDeclared / needsLiveProof).
    stampDeclared(tools, [...normaliseManifestTools(manifest, originUrl), ...(openapiRoutes || []), ...(openapiTools || [])]);
    // Keep what earlier crawls already learned, THEN spend the probe budget on
    // routes we still know nothing about.
    tools = carryForwardLearnedQuotes(tools, prev);
    tools = await enrichLiveQuotes(tools, originUrl);

    cache.set(originUrl, {
      manifest,
      // Kept so a 304 on the next cycle has something to reuse.
      openapiTools, openapiRoutes,
      openapiSummary: openapiTools
        ? (openapi && Object.keys(openapi.paths || {}).length
            ? { paths: Object.keys(openapi.paths).length }
            : (prev?.openapiSummary ?? null))
        : null,
      tools,
      fetchedAt: Date.now(),
      error: null,
      history: rollHistory(prev, true),
      // The ORIGIN itself served /.well-known/x402 — it answered us.
      originResponded: true,
      ...(redirectedTo ? { redirectedTo } : {}),
      // WHICH surface produced this catalogue. Everything below is a fallback,
      // and a seller cannot fix a gap they cannot see — see discoveryNote().
      discoveryPath: WELL_KNOWN_PATH,
      fallbackErrors: undefined,
      // Not this seller's turn: carry the last reading forward rather than
      // dropping it — null must mean "never probed", not "not probed today".
      paywall: paywallProbeDue() ? await probePaywall(tools) : (prev?.paywall ?? null),
    });
  } catch (e) {
    // No /.well-known/x402 — two fallback surfaces, richest metadata wins:
    //
    // 1. The seller's own openapi.json. Some sellers publish no manifest but
    //    a rich openapi (operationId, summary, tags) — before this path
    //    existed they landed on the Bazaar fallback below, whose
    //    path-derived slugs ("md") score near zero in the router. Accepted
    //    only when the origin is payment-proven: either the Bazaar lists it,
    //    or the openapi itself carries a payment extension — a plain Swagger
    //    site is not an x402 seller.
    // 2. Bazaar resource entries. Many sellers never publish anything else;
    //    the Bazaar IS their public surface, and its entries are settlement-
    //    proven (price, networks, payTo from real 402s).
    //
    // When both exist we merge: openapi descriptive fields over Bazaar
    // payment truth. Either way the seller is routable (history flips
    // positive) — we just observed a live surface.
    // Count only REAL probe failures. Our own backoff skip must not deepen the
    // backoff that caused it - that would ratchet an origin toward never being
    // probed again on the strength of nothing.
    // Outcome recording moved into probePath, which records every path it
    // fetches. Recording again here would double-count the manifest failure
    // and deepen its backoff twice per cycle.
    const bazaarTools = bazaarToolsByOrigin.get(originUrl) || [];
    let openapi = null;
    let openapiTools = [];
    let openapiPath = null;
    // WHY each fallback surface gave nothing. The record's `error` names only
    // the manifest's failure, so a seller whose /openapi.json we could not
    // read (or read and could not use) saw "probe backed off: /.well-known/x402"
    // and nothing about the file that actually decided the listing.
    const fallbackErrors = [];
    const noteFallback = (path, e) => fallbackErrors.push({ path, error: String(e?.message || e).slice(0, 160) });
    try {
      const openapiRes = await fetchOpenapi({ conditional: false });
      const parsed = JSON.parse(await fallbackBody(originUrl, "/openapi.json", openapiRes, { maxBytes: MAX_OPENAPI_BYTES }));
      if (bazaarTools.length || openapiHasPaymentSignal(parsed)) {
        openapi = parsed;
        openapiTools = normaliseOpenapiTools(parsed, originUrl);
        if (openapiTools.length) openapiPath = "/openapi.json";
        else noteFallback("/openapi.json", "no paid operation could be read from it");
      } else noteFallback("/openapi.json", "no payment annotation on any operation");
    } catch (e) {
      /* no openapi either — Bazaar-only seller */
      noteFallback("/openapi.json", e);
    }
    // 3. /agents.json. Reported by a seller (#645) who served a COMPLETE
    //    catalogue there - 17 endpoints with prices and schemas - while our
    //    crawler 404'd on the well-known path 686 times in a week and listed
    //    them thinly. The spec being right does not make the wild uniform;
    //    an index that only reads one path indexes only the sellers who
    //    happened to read the same page we did.
    //
    //    Same payment gate as openapi: a catalogue is accepted only if the
    //    Bazaar already proves this origin settles, or the document itself
    //    carries a payment signal. A plain JSON file is not an x402 seller.
    if (!openapiTools.length) {
      try {
        const agentsRes = await probePath(originUrl, "/agents.json", { maxBytes: MAX_OPENAPI_BYTES, conditional: false });
        const parsed = JSON.parse(await fallbackBody(originUrl, "/agents.json", agentsRes, { maxBytes: MAX_OPENAPI_BYTES }));
        if (bazaarTools.length || openapiHasPaymentSignal(parsed)) {
          const fromAgents = normaliseOpenapiTools(parsed, originUrl);
          if (fromAgents.length) { openapi = openapi || parsed; openapiTools = fromAgents; openapiPath = "/agents.json"; }
        }
      } catch (e) {
        /* no agents.json either */
        noteFallback("/agents.json", e);
      }
    }
    // 4. /llms.txt. The other half of the #645 ask. Last because it is prose:
    //    normaliseLlmsTxtTools accepts only priced, same-origin link-list
    //    entries, so a seller who publishes one gets listed from it and a
    //    seller who publishes marketing copy gets nothing rather than noise.
    //
    //    The payment gate here is the price on each line itself - an entry
    //    without one is not emitted at all - so unlike the JSON surfaces there
    //    is no separate document-level check to apply.
    if (!openapiTools.length) {
      try {
        const llmsRes = await probePath(originUrl, "/llms.txt", { maxBytes: MAX_OPENAPI_BYTES, conditional: false });
        const fromLlms = normaliseLlmsTxtTools(await fallbackBody(originUrl, "/llms.txt", llmsRes, { maxBytes: MAX_OPENAPI_BYTES }), originUrl);
        if (fromLlms.length) { openapiTools = fromLlms; openapiPath = "/llms.txt"; }
      } catch (e) {
        /* no llms.txt either */
        noteFallback("/llms.txt", e);
      }
    }
    const tools = dropUnvouchedNonProductRoutes(
      mergeOpenapiIntoBazaar(openapiTools, bazaarTools, {
        allRoutes: openapi ? openapiAllOperationRoutes(openapi, originUrl) : [],
      }),
      bazaarTools.map((t) => t.route)
    );
    if (tools.length) {
      stampDeclared(tools, [...openapiTools, ...(openapi ? openapiAllOperationRoutes(openapi, originUrl) : [])]);
      // Same enrichment as the manifest path. A seller discovered through the
      // FALLBACK surfaces is even less likely to have published a price, so
      // skipping it here would leave the worst-served sellers unpriced.
      carryForwardLearnedQuotes(tools, prev);
      await enrichLiveQuotes(tools, originUrl);
      // A real (non-synthesized) manifest from a past crawl is kept; a stale
      // synthesized one is rebuilt so a newly appeared openapi title wins.
      const keepManifest = prev?.manifest && !prev.manifest.synthesized ? prev.manifest : null;
      cache.set(originUrl, {
        ...(prev || {}),
        manifest:
          keepManifest ||
          (openapi
            ? synthManifestFromOpenapi(originUrl, openapi, tools)
            : synthManifestFromBazaar(originUrl, bazaarTools)),
        openapiSummary: openapi ? { paths: Object.keys(openapi.paths || {}).length } : prev?.openapiSummary ?? null,
        tools,
        fetchedAt: Date.now(),
        error: null,
        source: openapiTools.length ? "openapi-fallback" : "bazaar-fallback",
        // The surface that ACTUALLY served the catalogue, which `source` cannot
        // express: it says "openapi-fallback" for both /openapi.json and
        // /agents.json. A seller told to fix their discovery path needs to know
        // which path we did read, not merely that it was not the standard one.
        discoveryPath: openapiPath,
        fallbackErrors: openapiTools.length ? undefined : fallbackErrors,
        // A CRAWL COMPLETING IS NOT A SELLER ANSWERING, and this line is where
        // that distinction was half-applied. `originResponded` below already
        // says the truth (openapi-fallback = their document answered;
        // bazaar-fallback = the manifest fetch AND the OpenAPI fetch both
        // failed and every field here was synthesised from a third-party
        // registry row). The health history was recorded as a SUCCESS either
        // way, so an origin that answers nothing at all carried health 1 and
        // rendered as healthy - which is the same defect the comment below
        // describes and stops one field short of fixing.
        //
        // Found 2026-09-11 from an outside report: an origin whose root,
        // /.well-known/x402, /openapi.json and /llms.txt all answer 404 was
        // published as routable with health 1 and a four-tool catalogue, every
        // tool of it synthesised from a registry. One condition, read once, so
        // the two fields cannot disagree again.
        history: rollHistory(prev, openapiTools.length > 0),
        // Did the ORIGIN serve us anything, or is this record purely a registry
        // listing about it?
        //
        // `openapi-fallback` means we fetched THEIR OpenAPI doc: the origin
        // answered. `bazaar-fallback` means the manifest fetch failed AND the
        // OpenAPI fetch failed, and every field here was synthesised from a
        // third-party registry row. We tried twice and got nothing.
        //
        // rollHistory(prev, true) marks the CRAWL successful either way, which
        // is how ~32% of the index came to sit at health 1 / routable true
        // while never having responded — and the marketplace rendered them
        // "healthy". A crawl completing is not a seller answering.
        originResponded: openapiTools.length > 0,
        paywall: paywallProbeDue() ? await probePaywall(tools) : (prev?.paywall ?? null),
      });
      return;
    }
    // Preserve the last good manifest+tools so a transient outage doesn't drop
    // the seller from the Index — but the history flip marks them unhealthy
    // for routing decisions.
    cache.set(originUrl, {
      ...(prev || {}),
      error: String(e.message || e),
      // A seller who has excluded us in robots.txt is EXCLUDED, not broken and
      // not absent. Flagged so /index can say so; reporting it as a crawl
      // failure would file their deliberate choice under our outage count, and
      // dropping them silently would make the index quietly smaller with no
      // explanation - the same "absence reported as absence" rule the discovery
      // gap and /status already follow.
      robotsBlocked: Boolean(e?.robotsBlocked) || undefined,
      fallbackErrors,
      fetchedAt: Date.now(),
      history: rollHistory(prev, false),
    });
  }
}

// Build a minimal x402 service manifest from Bazaar resource entries — enough
// for indexSnapshot to render a display name + payment network without
// pretending the seller actually publishes /.well-known/x402.
export function synthManifestFromBazaar(originUrl, tools) {
  const first = tools[0] || {};
  const host = originUrl.replace(/^https?:\/\//, "");
  return {
    name: first.name && first.name !== first.route ? first.name : host,
    homepage: originUrl,
    payment: { x402: { primaryNetwork: "base" } },
    capabilities: { tools: tools.length },
    synthesized: true,
  };
}

// Same idea for an openapi-fallback seller — info.title is the display name.
function synthManifestFromOpenapi(originUrl, openapi, tools) {
  const host = originUrl.replace(/^https?:\/\//, "");
  return {
    name: openapi?.info?.title || host,
    homepage: originUrl,
    payment: { x402: { primaryNetwork: "base" } },
    capabilities: { tools: tools.length },
    synthesized: true,
  };
}

// Health score in [0,1] = fraction of healthy crawls in the rolling window.
// A seller with no history yet (just discovered) is treated as healthy so we
// don't unfairly exclude brand-new sellers on their first crawl cycle.
function healthScore(entry) {
  const h = entry?.history;
  if (!Array.isArray(h) || h.length === 0) return 1;
  return h.reduce((a, b) => a + b, 0) / h.length;
}

// A seller is "routable" if its most recent crawl succeeded. This is the
// strictest signal — a tool we recommend should be from a seller we just
// observed serving. Falling back to history would be nice but the latest
// success/failure is the most actionable bit.
function isRoutable(entry) {
  const h = entry?.history;
  if (!Array.isArray(h) || h.length === 0) return true; // never-crawled: give benefit of doubt
  // A record synthesised entirely from a registry is not evidence the seller
  // works. `originResponded === false` means we asked twice and got nothing;
  // undefined means the entry predates this field and keeps the old behaviour
  // rather than being demoted on absence of data.
  if (entry?.originResponded === false) return false;
  return h[h.length - 1] === 1;
}

// Alias collapse for the router. A retired bootstrap host that permanently
// redirects to a seller's real domain never dies in the index: safeFetch
// follows the redirect, lands on the real manifest, and the alias keeps
// crawling healthy forever. Left alone it (a) duplicates every row in route
// results and (b) doubles the operator's slots under the per-seller Sybil cap
// — an alias per redirect is a cheap way to monopolize a shortlist.
//
// An origin is an alias when its manifest homepage points at a DIFFERENT
// origin that is also in the cache, that primary is self-canonical (its own
// homepage is itself — breaks mutual-pointing pairs, which collapse neither),
// isn't errored, and the alias's tool slugs are a subset of the primary's.
// The subset test is what keeps this safe: an api. subdomain whose homepage
// is the operator's main site but which serves DISTINCT tools is a real
// seller, not an alias, and must keep ranking.
// PER-ENTRY DERIVED VALUES, MEMOIZED BY ENTRY IDENTITY (2026-08-25). Every
// route query re-derived the alias set for all ~2,900 sellers, and the boot
// CPU profile put 8 s of the first 75 s in exactServiceKey() alone - a
// JSON.stringify of every tool of every seller, per query, on a free public
// surface (/api/route measured 1.1 s cold on prod). Cache entries are
// replaced, never mutated, when a seller is re-crawled, so a WeakMap keyed by
// the entry object is exact with no invalidation: a fresh entry is a fresh
// key, and a dropped entry's memo goes with it.
const slugSetMemo = new WeakMap();
const serviceKeyMemo = new WeakMap();
const canonicalPayeesOf = (tools) => Object.entries(allPayTosByNetwork(tools))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([network, values]) => [network, [...values].map((value) => String(value).toLowerCase()).sort()]);
// The full tool contract + payees of one entry, memoized by identity. Built
// here rather than inside computeAliasOriginsBase so the route index can
// prime it in the background as each re-crawled entry lands.
function exactServiceKeyOf(v) {
  if (!v || typeof v !== "object") return null;
  if (serviceKeyMemo.has(v)) return serviceKeyMemo.get(v);
  const tools = v.tools || [];
  const payees = canonicalPayeesOf(tools);
  let key = null;
  if (tools.length && payees.length) {
    const contracts = tools.map((t) => [
      String(t.method || "GET").toUpperCase(),
      String(t.route || ""),
      String(t.slug || ""),
      String(t.price ?? ""),
      t.paid === false ? "free" : "paid-or-unknown",
      [...(t.networks || [])].map(String).sort(),
    ]).map((c) => [JSON.stringify(c), c]).sort((a, b) => a[0].localeCompare(b[0])).map((p) => p[1]);
    key = JSON.stringify({ payees, contracts });
  }
  serviceKeyMemo.set(v, key);
  return key;
}

// The cache-derived part of the alias set walks every entry (4,360 on prod,
// ~150 ms measured per /api/route query). It changes only when the cache does,
// so for the live cache it is memoized on cacheVersion; the superseded origins
// depend on the successions map as well and are folded in fresh on each call.
let aliasBaseMemo = { version: -1, base: null, at: 0 };
const ALIAS_CRAWL_STALE_MS = 60_000;
export function computeAliasOrigins(cacheMap) {
  let base;
  // While a crawl runs, every cache.set bumps the version and would force a
  // full walk per reader; the last set (at most ALIAS_CRAWL_STALE_MS old) is
  // reused until the cycle ends. The superseded fold below is always fresh.
  const fresh = aliasBaseMemo.base && cacheMap === cache && (aliasBaseMemo.version === cacheVersion || (crawlInFlight && Date.now() - aliasBaseMemo.at < ALIAS_CRAWL_STALE_MS));
  if (fresh) base = aliasBaseMemo.base;
  else {
    base = computeAliasOriginsBase(cacheMap);
    if (cacheMap === cache) aliasBaseMemo = { version: cacheVersion, base, at: Date.now() };
  }
  const aliases = new Set(base);
  // A superseded origin hides for the same reason a redirect alias does: it is
  // the same seller counted twice. Folded in here so the four consumers of this
  // set (index listing, remote pool, route query, seller roster) all honour it
  // without a second exclusion to keep in step.
  for (const o of supersededOrigins(cacheMap)) aliases.add(o);
  return aliases;
}
function computeAliasOriginsBase(cacheMap) {
  const byHost = new Map(); // canonical host -> { origin, v }
  for (const [origin, v] of cacheMap) {
    // A path seller shares its host with other sellers, so it is never the
    // host's primary, and never folded into one by host (see the loop below).
    if (sellerPrefixOf(origin)) continue;
    const h = canonicalHost(origin);
    if (h && !byHost.has(h)) byHost.set(h, { origin, v });
  }
  const slugSet = (v) => {
    if (!v || typeof v !== "object") return new Set();
    let m = slugSetMemo.get(v);
    if (!m) { m = new Set((v.tools || []).map((t) => t.slug)); slugSetMemo.set(v, m); }
    return m;
  };
  const aliases = new Set();
  for (const [origin, v] of cacheMap) {
    if (sellerPrefixOf(origin)) continue;
    const ownHost = canonicalHost(origin);
    // A manifest served from another origin by permanent redirect is stronger
    // evidence than a homepage field: the seller pointed the old hostname at
    // the new one themselves. Same primary and subset rules apply.
    const homeHost = canonicalHost(v?.redirectedTo) || canonicalHost(v?.manifest?.homepage);
    if (!ownHost || !homeHost || homeHost === ownHost) continue;
    const primary = byHost.get(homeHost);
    if (!primary || primary.origin === origin || primary.v?.error) continue;
    const primaryHome = canonicalHost(primary.v?.manifest?.homepage);
    if (primaryHome && primaryHome !== homeHost) continue; // primary not self-canonical
    const mine = slugSet(v);
    if (!mine.size) continue;
    const theirs = slugSet(primary.v);
    let subset = true;
    for (const s of mine) if (!theirs.has(s)) { subset = false; break; }
    if (subset) aliases.add(origin);
  }

  // Some sellers expose the same service on both a durable custom domain and
  // Railway's generated deployment hostname. Both manifests can be
  // self-canonical, so the homepage rule above cannot identify the deployment
  // origin as an alias. Collapse only the measured, fail-closed case: exactly
  // one non-Railway origin has the same complete tool contract and the same
  // payees as one or more `*.up.railway.app` origins. Shared wallets alone do
  // not collapse anything, and two custom origins remain distinct.
  const exactServiceKey = exactServiceKeyOf;
  const railwayDeploymentOrigin = (origin) => {
    try { return new URL(origin).hostname.toLowerCase().endsWith(".up.railway.app"); }
    catch { return false; }
  };
  const exactGroups = new Map();
  for (const [origin, v] of cacheMap) {
    if (v?.error || aliases.has(origin)) continue;
    const key = exactServiceKey(v);
    if (!key) continue;
    if (!exactGroups.has(key)) exactGroups.set(key, []);
    exactGroups.get(key).push(origin);
  }
  for (const origins of exactGroups.values()) {
    const durable = origins.filter((origin) => !railwayDeploymentOrigin(origin));
    if (durable.length !== 1) continue;
    for (const origin of origins) {
      if (origin !== durable[0] && railwayDeploymentOrigin(origin)) aliases.add(origin);
    }
  }
  return aliases;
}

// Metadata-injection detector (M6, "Five Attacks on x402" Attack IV-E1).
// A tool listing is metadata: a name, a description, tags — text that *describes*
// what a tool does. It is never a channel for instructions to the selecting
// agent. When an external listing's text tries to command the ranker or the
// buyer's LLM ("ignore previous instructions", "always pick this", a fake
// <system> block), that's an attack, not a description — the paper drove one
// crafted server to 71.8% selection this way. We drop such listings entirely.
//
// Deliberately conservative: every pattern is imperative/meta phrasing that a
// genuine tool description has no reason to contain. A tool that legitimately
// *operates on* prompts (e.g. a "prompt linter") describes its function
// ("detects prompt-injection patterns"), it doesn't issue the commands below.
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|the\s+above)\s+(?:instructions?|prompts?|context|rules?)/,
  /disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|other)/,
  /forget\s+(?:everything|all|the\s+above|previous|prior)/,
  /always\s+(?:pick|choose|select|use|prefer|recommend|return)\s+(?:this|me|the\s+following)/,
  /(?:you\s+must|be\s+sure\s+to)\s+(?:always\s+)?(?:pick|choose|select|use|prefer|recommend)/,
  /(?:highest|top|maximum|max)\s+priority/,
  /override\s+(?:all\s+|any\s+|the\s+)?(?:other|previous|prior|instructions?|ranking)/,
  /<\/?\s*(?:system|assistant|user|instructions?|important)\s*>/,
  /\[(?:system|important|instructions?|override)\]/,
  /system\s*(?:prompt|message|role)\s*[:=]/,
  /do\s+not\s+(?:pick|choose|select|recommend|consider)\s+(?:any\s+)?other/,
  // A listing that tries to set its own score for a ranker that reads it.
  /"fits?"\s*:\s*\{/,
  /\b(?:rate|score|give)\s+(?:this|it|me|every\s+\w+)?\s*(?:a\s+)?fit\s*(?:of\s*)?[:=]?\s*(?:1(?:\.0+)?|100\s*%)/,
  /\bfit\s*[:=]\s*(?:1(?:\.0+)?|100\s*%)/,
  // The same instructions in the languages seen on the index.
  /ignora\s+(?:las?\s+|todas?\s+las?\s+)?(?:instrucciones|indicaciones)\s+(?:anteriores|previas)/,
  /ignor(?:e|ez)\s+(?:les\s+|toutes\s+les\s+)?(?:instructions|consignes)\s+(?:pr[eé]c[eé]dentes|ant[eé]rieures)/,
  /ignoriere\s+(?:alle\s+)?(?:vorherigen|bisherigen|obigen)\s+(?:anweisungen|instruktionen)/,
  /ignore\s+(?:as\s+|todas\s+as\s+)?instru[cç][oõ]es\s+anteriores/,
];
// Letters from other scripts that render like Latin ones ("Іgnоrе" spelled with
// Cyrillic І, о, е): one more reading of the text maps them back before the
// patterns run, so a lookalike spelling is read as the phrase it imitates.
const CONFUSABLES = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u04cf": "l", "\u0501": "d", "\u051b": "q", "\u051d": "w",
  "\u03b1": "a", "\u03bf": "o", "\u03c1": "p", "\u03b5": "e", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03c4": "t", "\u03c5": "u", "\u03c7": "x",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");
// The patterns are written lowercase; the text is brought to that form before
// matching, twice: as written (so a literal <system> tag is still seen) and
// with markup/entities/invisible characters turned to spaces (so
// "Ignore&lt;previous instructions" or a zero-width split cannot slip a phrase
// past the screen that a later cleaning step would reassemble).
// Plain printable ASCII with no markup, entity or backtick characters: NFKC,
// entity decoding, invisible-character handling and the lookalike map are all
// identity on it, so the four forms below reduce to the lowercased text and its
// whitespace-collapsed copy. Nearly every listing is this, and the full path
// costs several times more per listing across an index of tens of thousands.
const PLAIN_LISTING = /^[\t\n\r\x20-\x7e]*$/;
const MARKUP_CHARS = /[&<>`*~|]/;
function injectionForms(text) {
  const raw = String(text || "");
  if (PLAIN_LISTING.test(raw) && !MARKUP_CHARS.test(raw)) {
    const lower = raw.toLowerCase();
    if (!/[\t\n\r]| {2}/.test(lower)) return [lower];
    return [lower, lower.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ")];
  }
  const decoded = raw.normalize("NFKC")
    .replace(/&(?:lt|gt|amp|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6});/gi, (m) => {
      const e = m.toLowerCase();
      return e === "&lt;" ? "<" : e === "&gt;" ? ">" : e === "&amp;" ? "&" : " ";
    })
    .toLowerCase();
  // Invisible characters are DELETED (a zero-width split inside a word must
  // rejoin it); markup punctuation becomes a space. Underscores are left as
  // they are: identifiers like max_priority_fee are honest listing text.
  // An invisible character may split a word (delete it) or two words (read it
  // as a space): both readings are checked.
  const INVIS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g;
  const flatten = (x) => x.replace(/[\u0000-\u001f\u007f-\u009f<>`*~|]/g, " ").replace(/\s+/g, " ");
  const forms = [decoded.replace(INVIS, ""), flatten(decoded.replace(INVIS, "")), flatten(decoded.replace(INVIS, " "))];
  if (CONFUSABLE_RE.test(decoded)) { CONFUSABLE_RE.lastIndex = 0; forms.push(flatten(decoded.replace(INVIS, "").replace(CONFUSABLE_RE, (c) => CONFUSABLES[c]))); }
  CONFUSABLE_RE.lastIndex = 0;
  return forms;
}
// One alternation of every pattern: the same any-match answer as testing them
// in turn (none carries a flag or a lastIndex), in one pass over the text.
const INJECTION_ANY = new RegExp(INJECTION_PATTERNS.map((re) => `(?:${re.source})`).join("|"));
export function looksLikeListingInjection(text) {
  const t = String(text || "");
  if (t.length > 8000) return true; // no honest listing is a novel; oversized = padding an attack
  for (const form of injectionForms(t)) if (INJECTION_ANY.test(form)) return true;
  return false;
}

let crawlerTimer = null;
let firstCrawlTimer = null;
let discoveryTimer = null;
let crawlInFlight = false;
// How many crawl cycles have RUN TO COMPLETION. Read only by indexReadiness()
// below, to tell "we hold no row for that seller" apart from "we have not
// finished reading the index yet" - two answers a lookup used to give with the
// same 404.
let crawlsCompleted = 0;

// Bounded worker pool. With thousands of discovered sellers we can't fan out
// every crawl in parallel — the unbounded `Promise.allSettled(seeds.map(...))`
// pattern would burn file descriptors and look like an outbound DoS. Each
// worker pulls the next seed off the queue until it's empty.
async function runPool(items, limit, worker) {
  const queue = items.slice();
  const n = Math.min(Math.max(limit, 1), queue.length);
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch { /* crawlSeller already catches; belt+braces */ }
    }
  });
  await Promise.all(workers);
}

// Registrable domain, approximately: the last two labels, plus a third for the
// common multi-part suffixes. It does not need to be a full public-suffix list -
// getting it wrong groups an operator slightly wider or narrower than ideal, and
// never causes an origin to be skipped forever.
const MULTI_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "com.au", "com.br", "co.nz", "co.in", "com.cn", "com.mx"]);

// Suffixes where the label BELOW the suffix is a different tenant, not a
// different host of one operator. Without these, "last two labels" made every
// Vercel seller one operator, every Workers seller one operator, and so on -
// they would then have shared a single per-cycle crawl budget, and an attacker
// could have registered throwaway origins under the same suffix to starve another
// seller's listing until its learned quote went stale (QUOTE_MAX_AGE_MS).
// This file already knew better in one place: railwayDeploymentOrigin exists
// precisely because unrelated sellers publish on *.up.railway.app.
const SHARED_HOSTING_SUFFIXES = [
  "workers.dev", "vercel.app", "up.railway.app", "railway.app", "onrender.com",
  "fly.dev", "pages.dev", "netlify.app", "herokuapp.com", "replit.app",
  "repl.co", "chatgpt.site", "trycloudflare.com", "ngrok-free.app", "ngrok.app",
  "deno.dev", "glitch.me", "surge.sh", "web.app", "firebaseapp.com",
  "azurewebsites.net", "appspot.com", "cloudfunctions.net", "koyeb.app",
  "vercel.sh", "netlify.com", "render.com", "streamlit.app", "hf.space",
];
export function operatorKey(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return String(origin).toLowerCase(); }
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  // Multi-tenant hosting: the tenant is the whole hostname. Grouping two tenants
  // together is not a small inaccuracy - it hands them one budget and lets either
  // one crowd the other out.
  for (const suffix of SHARED_HOSTING_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return host;
  }
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

// How many origins of ONE operator we will crawl in a single cycle.
const CRAWL_ORIGINS_PER_OPERATOR = Math.max(1, Number(process.env.CRAWL_ORIGINS_PER_OPERATOR || 4));

/** At most `cap` origins per operator this cycle, rotating by cycle so every
 *  origin comes up in turn instead of the same few always winning. Input order
 *  is preserved, and anyone at or under the cap is unaffected. */
export function originsDueThisCycle(origins, cycle = 0, cap = CRAWL_ORIGINS_PER_OPERATOR) {
  const byOperator = new Map();
  for (const o of origins) {
    const k = operatorKey(o);
    if (!byOperator.has(k)) byOperator.set(k, []);
    byOperator.get(k).push(o);
  }
  const due = new Set();
  for (const [, list] of byOperator) {
    if (list.length <= cap) { for (const o of list) due.add(o); continue; }
    const offset = (cycle * cap) % list.length;
    for (let i = 0; i < cap; i++) due.add(list[(offset + i) % list.length]);
  }
  return origins.filter((o) => due.has(o));
}

/** True while a crawl cycle is running (every entry is being replaced). */
export function crawlInProgress() { return !!crawlInFlight; }
async function runCrawl() {
  if (crawlInFlight) return; // overlapping runs would just rate-limit each other
  crawlInFlight = true;
  try {
    const seeds = seedList();
    liveQuoteBudget = LIVE_QUOTE_PROBES_PER_CYCLE;   // fresh allowance each cycle
    // ROTATE the visiting order each cycle. The per-cycle quote budget is spent
    // first-come, so a fixed order hands every probe to whichever sellers sit at
    // the front of the list and starves the tail FOREVER - the sellers at the
    // back would never be priced, which is the exact complaint that started
    // this work, reintroduced by the fix for it. Rotation costs nothing (the
    // crawl visits every seed each cycle regardless) and makes the budget fair.
    const start = seeds.length ? crawlCycle % seeds.length : 0;
    crawlCycle += 1;
    const ordered = seeds.length ? [...seeds.slice(start), ...seeds.slice(0, start)] : seeds;
    // Politeness is per OPERATOR, not per origin. We key everything on origin, so
    // an operator running 20 hosts was 20 unrelated crawl targets and felt 20x
    // the load of a one-host seller for no reason of their own. Reported
    // 2026-08-31 by a listed seller: ~18,200 requests/day across their 20 hosts,
    // ~67% of all their external traffic, none carrying payment. Our own
    // arithmetic agrees on the order of magnitude - 4 discovery docs per origin
    // per 30-minute cycle is ~200/day/origin, ~4,000/day across 20.
    //
    // Each cycle now crawls at most CRAWL_ORIGINS_PER_OPERATOR origins per
    // registrable domain, rotating by cycle. Every origin is still crawled, just
    // less often when it shares an operator: 20 hosts at a cap of 4 means each is
    // seen every 5th cycle (~2.5h) instead of every 30 minutes. Single-host
    // sellers - almost all of them - are untouched.
    const due = originsDueThisCycle(ordered, crawlCycle);
    await runPool(due, CRAWL_CONCURRENCY, crawlSeller);
    // Each step is guarded on its own: a throw in one used to skip the release
    // silently for every later cycle, and the slots it should have freed stayed
    // held with nothing in the log to say why.
    try { recordSubmittedSellerObservations(); } catch (e) { console.log(`[x402-index] observation pass failed: ${String(e?.message || e).slice(0, 160)}`); }
    let rowsAdded = 0;
    try { const known = registeredOrigins(); rowsAdded = ensureSellerRegistrations([...submittedSeeds].filter((o) => !known.has(o))); } catch { /* counted as 0 */ }
    // `due`, not `ordered`: cycleOkFraction's own contract is that it measures
    // THIS pass. Once the per-operator cap made the crawled set a subset, passing
    // the full list let every origin held back this cycle contribute its previous
    // cached verdict - diluting the denominator with stale OKs in the UNSAFE
    // direction, so during an egress outage the fraction could stay above the
    // 0.5 floor and slots would be released anyway.
    const fraction = cycleOkFraction(due);
    let release;
    try { release = releaseDeadSubmissions(fraction); } catch (e) { release = { released: 0, reason: `error: ${String(e?.message || e).slice(0, 120)}` }; }
    lastCycleSummary = { at: new Date().toISOString(), cycle: crawlCycle, due: due.length, okFraction: fraction === null ? null : Number(fraction.toFixed(3)), rowsAdded, ...release };
    // One line per cycle (every ~30 min): the only way to tell from the log
    // whether the release ran, freed slots, or why it did not.
    console.log(`[x402-index] cycle ${crawlCycle}: probed ${due.length}, ok ${fraction === null ? "n/a" : (fraction * 100).toFixed(1) + "%"}, release ${release.released ? `freed ${release.released}` : `none (${release.reason})`}${rowsAdded ? `, ${rowsAdded} registration row(s) added` : ""}`);
  } finally {
    crawlInFlight = false;
    crawlsCompleted += 1;
  }
}

// Quick-tunnel services hand out a random hostname per session, so a tunnel
// origin that stops answering is gone for good: the next session is a new
// hostname. Measured 2026-10-02: 1,753 of 2,432 self-serve registrations were
// such hostnames, arriving 100-150 a day, which kept the submission door full
// while a 30-day release drained it far slower. Named services only - a
// tenant's own domain or a stable platform subdomain is never one of these.
export const EPHEMERAL_TUNNEL_SUFFIXES = [
  "lhr.life", "localhost.run", "trycloudflare.com", "loca.lt", "tunnelmole.net",
  "ngrok-free.app", "ngrok-free.dev", "ngrok.app", "ngrok.io", "ngrok.dev",
  "serveo.net", "serveousercontent.com", "pinggy.link", "pinggy.io",
];
export function isEphemeralTunnelOrigin(origin) {
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return EPHEMERAL_TUNNEL_SUFFIXES.some((sfx) => host.endsWith(`.${sfx}`));
}
// A gone tunnel hostname never comes back, so its slot is released after days,
// not a month, and a past settlement does not hold it: the seller, if still
// selling, is already on a new hostname.
const TUNNEL_RELEASE_AFTER_MS = Number(process.env.INDEX_TUNNEL_RELEASE_AFTER_DAYS || 3) * 86_400_000;
// At most this share of the submission slots may be tunnel hostnames, so live
// tunnels cannot fill the door for sellers on stable hostnames.
const TUNNEL_SUBMISSION_SHARE = Number(process.env.INDEX_TUNNEL_SUBMISSION_SHARE || 0.25);
export function tunnelSubmissionCap(cap) { return Math.floor(cap * (TUNNEL_SUBMISSION_SHARE >= 0 && TUNNEL_SUBMISSION_SHARE <= 1 ? TUNNEL_SUBMISSION_SHARE : 0.25)); }

// How long an origin may go without a single successful crawl before its
// submission slot is released. 30 days is deliberately far past any outage a
// seller could be having: it is not a health signal, it is "this address has
// been gone for a month".
const RELEASE_AFTER_MS = Number(process.env.INDEX_RELEASE_AFTER_DAYS || 30) * 86_400_000;

// The submission ceiling used to be a lifetime bucket: an origin entered and
// nothing ever took it out, so the front door filled once and stayed full, and
// a seller arriving later got "submission list is full" no matter how many of
// the origins ahead of them had gone dark. The rate caps on the register route
// (5/hour/IP, 30/hour global) already stop one actor consuming the door in a
// burst; what was missing is the door moving forward at all.
//
// Releasing a slot is NOT deleting a seller. The seller_registrations row -
// first_seen, last_routable_seen, last_settled_seen - is untouched, so the
// provenance saying they came to us through /sell outlives the listing, and a
// seller who comes back re-registers into a free slot.
//
// Decides from DURABLE state on purpose. The crawl cache never persists failed
// entries, so consecutive-failure counts reset on every redeploy and would
// have made this pass unable to ever fire in production. last_routable_seen is
// written to SQLite on the volume and advances only on a successful probe,
// which is exactly the question being asked.
//
// @param registrations  rows from getSellerRegistrations()
// @param isSubmitted    is this origin still holding a submission slot?
// @param hasSettled     has this origin ever settled a payment through us?
// @param cycleOkFraction  share of THIS cycle's crawls that succeeded, or null
export function selectReleasableOrigins({
  registrations = [],
  isSubmitted = () => false,
  hasSettled = () => false,
  now = Date.now(),
  maxIdleMs = RELEASE_AFTER_MS,
  tunnelMaxIdleMs = TUNNEL_RELEASE_AFTER_MS,
  cycleOkFraction = null,
  minCycleOkFraction = 0.5,
} = {}) {
  // OUTAGE GUARD. Every seller looks dead when the failure is ours - a blocked
  // egress IP, a DNS problem, a bad deploy - and a month of that would release
  // the entire list in one pass. If most of this cycle failed, release nothing
  // and let the next healthy cycle decide. Fails closed: an unknown fraction
  // releases nothing.
  if (cycleOkFraction === null || !(cycleOkFraction >= minCycleOkFraction)) return [];
  const out = [];
  for (const row of registrations) {
    const origin = row?.origin;
    if (typeof origin !== "string" || !origin) continue;
    if (!isSubmitted(origin)) continue;
    // A seller who has ever been PAID through us is not a stale submission,
    // however long they have been down. Money is a stronger claim on a slot
    // than liveness, and releasing one would quietly drop a real counterparty.
    const tunnel = isEphemeralTunnelOrigin(origin);
    if (!tunnel && (row.last_settled_seen || hasSettled(origin))) continue;
    // No successful probe ever recorded falls back to first_seen, so a row
    // that predates this column cannot be immortal.
    const lastOk = Number(row.last_routable_seen || row.first_seen || 0);
    if (!lastOk) continue;
    if (now - lastOk < (tunnel ? tunnelMaxIdleMs : maxIdleMs)) continue;
    out.push(origin);
  }
  return out;
}

// Share of the origins visited this cycle that came back without an error.
// Read from the cache the crawl just wrote, so it measures THIS pass and not a
// warm-started memory of a healthier one. Returns null when nothing was
// visited, which the release pass treats as "do not release".
//
// This exists to answer ONE question - "is the failure ours?" - so only
// outcomes that could indicate our own breakage get a vote. A seller who has
// excluded us in robots.txt is neither a success nor evidence of an outage;
// they are a deliberate choice this module already refuses to file under our
// failure count, and counting them here would drag the fraction down and make
// the guard block releases that should proceed. They are left out of the
// denominator entirely rather than scored either way.
//
// (Such a seller still stops advancing last_routable_seen, so a submitted
// origin that blocks us does eventually give its slot back. That is the
// intended outcome and not an oversight: releasing it frees the slot AND
// stops us fetching them, which is what their robots.txt asked for.)
export function cycleOkFraction(visited = [], lookup = (o) => cache.get(o)) {
  if (!visited.length) return null;
  let ok = 0, seen = 0;
  for (const origin of visited) {
    const entry = lookup(origin);
    if (!entry) continue;      // never reached (budgeted probe, abort) - not a vote
    if (entry.robotsBlocked) continue;  // their choice, not our outage
    seen++;
    if (!entry.error) ok++;
  }
  return seen ? ok / seen : null;
}

// The release pass's health floor (see selectReleasableOrigins' outage guard).
const RELEASE_MIN_CYCLE_OK = 0.5;
let lastCycleSummary = null;
let lastReleaseAt = null;
function registeredOrigins() { return new Set(getSellerRegistrations().map((r) => r.origin)); }
/** Slot usage for the operator view: how full the submission list is, the
 *  tunnel share, and what the last crawl cycle's release pass did. */
export function submissionSlotStatus() {
  let tunnels = 0;
  for (const o of submittedSeeds) if (isEphemeralTunnelOrigin(o)) tunnels++;
  return { submitted: submittedSeeds.size, cap: submittedSeedsCap, tunnels, tunnelCap: tunnelSubmissionCap(submittedSeedsCap), lastReleaseAt, lastCycle: lastCycleSummary };
}

// Release submission slots held by origins that have been gone for a month.
// Called once per crawl cycle, after the observation pass has advanced
// last_routable_seen for everything that answered - so an origin released here
// definitively did not answer this cycle either.
function releaseDeadSubmissions(okFraction) {
  if (okFraction === null || !(okFraction >= RELEASE_MIN_CYCLE_OK)) return { released: 0, reason: `outage guard: cycle ok ${okFraction === null ? "unknown" : (okFraction * 100).toFixed(1) + "%"} below ${RELEASE_MIN_CYCLE_OK * 100}%` };
  let releasable;
  try {
    releasable = selectReleasableOrigins({
      registrations: getSellerRegistrations(),
      isSubmitted: (o) => submittedSeeds.has(o),
      hasSettled: (o) => originHasSettled(o),
      cycleOkFraction: okFraction,
      minCycleOkFraction: RELEASE_MIN_CYCLE_OK,
    });
  } catch (e) { return { released: 0, reason: `error: ${String(e?.message || e).slice(0, 120)}` }; }
  if (!releasable.length) return { released: 0, reason: "nothing past its idle window" };
  for (const origin of releasable) {
    submittedSeeds.delete(origin);
    // Stop crawling it too, otherwise the slot is free but the fetches are not.
    // Discovery may legitimately re-add it within the hour if a registry still
    // lists it - that is correct: it is then a discovered seller, not a
    // submission, and it no longer holds anyone's slot.
    discoveredSeeds.delete(origin);
    cache.delete(origin);
  }
  persistSubmittedSeeds();
  // Loud on purpose: this is the only path that removes a listing, so it must
  // never happen quietly. seller_registrations still holds every one of them.
  const tunnels = releasable.filter(isEphemeralTunnelOrigin).length;
  console.log(`[x402-index] released ${releasable.length} submission slot(s) with no successful probe (${tunnels} quick-tunnel after ${Math.round(TUNNEL_RELEASE_AFTER_MS / 86400000)}d, ${releasable.length - tunnels} after ${Math.round(RELEASE_AFTER_MS / 86400000)}d): ${releasable.slice(0, 10).join(", ")}${releasable.length > 10 ? ", ..." : ""}`);
  lastReleaseAt = new Date().toISOString();
  return { released: releasable.length, reason: "released" };
}

// Post-cycle churn/conversion pass over ONLY self-serve-submitted origins
// (not the operator-curated DEFAULT_SEEDS or registry-discovered sellers -
// seller_registrations tracks /sell signups specifically). An origin whose
// crawl failed this cycle is skipped entirely: last_routable_seen simply
// stops advancing, which is the churn signal itself - stamping "now" on a
// failed probe would hide the very thing this table exists to show.
function recordSubmittedSellerObservations() {
  for (const origin of submittedSeeds) {
    const entry = cache.get(origin);
    if (!entry || entry.error) continue;
    recordSellerRegistrationSeen(origin, { settled: originHasSettled(origin) });
  }
}

/**
 * Boot the periodic crawler. Safe to call multiple times — subsequent calls are
 * no-ops. The first crawl runs immediately (non-blocking) so the page has data
 * as soon as the seeds finish responding.
 *
 * @param {Object} [opts]
 * @param {string} [opts.selfOrigin] our own public origin — used to skip self
 *   in registry discovery so we don't waste a crawl slot fetching our own
 *   manifest via the public endpoint.
 */
// ---------------------------------------------------------------------------
// Crawl-cache warm-start
// ---------------------------------------------------------------------------
// The header above used to claim the in-memory cache was "restart-tolerant by
// design; no persistence needed". It self-heals, which is not the same thing as
// being harmless: re-crawling ~2,200 origins takes many minutes, and for that
// whole window /marketplace, /api/index and the tool catalog render a PARTIAL
// ecosystem with no hint that they are still filling up. On a day with ten
// deploys that is most of the day. A visitor saw 569 sellers when the index
// held 2,169 — not a bug in the counting, just a cache that had barely started.
//
// Same fix, same reasoning, same volume as the leaderboard's own warm-start
// (see LEADERBOARD_SNAPSHOT_FILE): persist the crawl and load it at boot.
// Stale-but-complete beats empty-and-correct here — a seller reachable an hour
// ago is almost certainly still reachable, and the next crawl re-verifies it
// anyway.
export const INDEX_CACHE_FILE = process.env.INDEX_CACHE_FILE || "/data/x402-index-cache.json";
// NDJSON twin of the cache (2026-08-25): one seller per line, so the boot can
// parse it a few hundred lines per event-loop turn instead of one 48 MB
// JSON.parse that held the loop for 1.4-3 s (and the GC after it for more).
// The crawler's async persist writes THIS file; the legacy single-JSON path is
// kept for tests and as the fallback when no NDJSON exists yet.
export const INDEX_CACHE_NDJSON_FILE = process.env.INDEX_CACHE_NDJSON_FILE || INDEX_CACHE_FILE.replace(/\.json$/, "") + ".ndjson";
// True while the incremental warm-start is still filling the cache: readers
// that snapshot the index (server.js getIndexSnapshot, 30 s TTL) must not
// cache a half-loaded ecosystem for half a minute.
let warmStartInProgress = false;
export function indexWarmStartInProgress() { return warmStartInProgress; }

/** Is the index in a state where "we hold no row for that origin" is a FACT
 *  about the origin, or only a fact about this process?
 *
 *  There are three ways to hold no row for a seller who is perfectly well
 *  indexed, and until 2026-09-22 all three answered `404 seller not found in
 *  the index` - the same sentence as a genuine absence:
 *    - the incremental warm-start is still reading the NDJSON off the volume
 *      (~2 s after every boot, and every deploy is a fresh boot);
 *    - the volume carries no cache at all (first deploy of a new volume, an
 *      unreadable file), so the cache is empty until the first crawl lands -
 *      the first cycle is deferred 30 s and a full pass takes minutes;
 *    - the crawler is switched off entirely (X402_INDEX_CRAWL=off: CI, and any
 *      test that needs to attribute outbound traffic).
 *  The consumer is a seller's automated checker, which reads "not found" as
 *  "we are not listed" - the same misreading the paging fix of the same day was
 *  written for, one branch away in the same handler.
 *
 *  `state`: "ready" | "warm-start" | "first-crawl" | "disabled".
 *  `ready` is false for the two states where the answer will change on its own. */
export function indexReadiness() {
  return readinessOf({ warmStarting: warmStartInProgress, sellers: cache.size, crawlsCompleted, crawlerRunning: !!crawlerTimer });
}

/** The decision above, as a pure function, for the same reason src/index-paging.js
 *  exists: a CI boot is ALWAYS in one state (crawler off, cache empty), so every
 *  branch that matters here - the two that answer "ask again" - is unreachable
 *  from a booted test, and a guard that can only exercise the reachable branch
 *  is a certificate for the half that never broke. */
export function readinessOf({ warmStarting = false, sellers = 0, crawlsCompleted: crawls = 0, crawlerRunning = false } = {}) {
  if (warmStarting) return { ready: false, state: "warm-start", sellers, crawlsCompleted: crawls, retryAfterSeconds: 5 };
  if (sellers === 0 && crawls === 0) {
    // Nothing loaded and nothing crawled. Whether that resolves on its own is
    // the difference between "ask again" and "this server holds no index": with
    // the crawler running it is the deferred first cycle (30 s, minutes to
    // complete) and waiting fixes it; with the crawler off nothing will ever
    // arrive, so a caller must be told that rather than told to retry forever.
    return crawlerRunning
      ? { ready: false, state: "first-crawl", sellers: 0, crawlsCompleted: crawls, retryAfterSeconds: 60 }
      : { ready: true, state: "disabled", sellers: 0, crawlsCompleted: crawls, retryAfterSeconds: 0 };
  }
  return { ready: true, state: "ready", sellers, crawlsCompleted: crawls, retryAfterSeconds: 0 };
}

/** Best-effort persist of the crawl cache. No-op without a /data volume. */
// WHAT THE PERSISTED CACHE KEEPS, AND WHY IT IS SLIM (2026-08-25). The file
// had grown to 91.4 MB on prod: full seller manifests (a /.well-known/x402 doc
// can be 4 MB - registry-style sellers list thousands of resources) for ~2,200
// origins. Parsing it held the boot event loop for 3 s, and re-stringifying it
// after every crawl cycle held it for seconds more, on the request path.
// Nothing that reads a WARM-STARTED entry needs the full manifest: readers use
// name, description, homepage, capabilities.tools and the synthesized flag,
// and the crawler's 304 path reuses the previous doc only when its ETag cache
// (memory-only) says not-modified - after a reboot that cache is empty, so the
// first crawl re-fetches every manifest in full regardless. Tools keep their
// scalar fields with the description bounded; anything schema-shaped is dropped.
// `payment` carries payment.x402.primaryNetwork, which indexSnapshot publishes
// as the seller's `network`. It was NOT persisted, so every warm start dropped
// it and the next crawl re-persisted the slim copy - and /api/index has been
// publishing network:null for every seller since the slim-persist change.
// Found 2026-09-11 by the dataset snapshot's columnFill reading exactly 0.
const MANIFEST_PERSIST_KEYS = ["name", "description", "homepage", "version", "synthesized", "payTo", "network", "networks", "x402Version", "payment"];
const TOOL_BULKY_KEYS = ["inputSchema", "input", "example", "parameters", "requestBody", "responses", "schema", "outputSchema", "discovery"];
function slimManifestForPersist(m) {
  if (!m || typeof m !== "object") return null;
  const out = {};
  for (const k of MANIFEST_PERSIST_KEYS) {
    if (m[k] === undefined) continue;
    out[k] = k === "description" ? String(m[k]).slice(0, 300) : m[k];
  }
  if (m.capabilities && typeof m.capabilities === "object") {
    const tools = Number(m.capabilities.tools);
    if (Number.isFinite(tools)) out.capabilities = { tools };
  }
  out.slimmed = true;
  return out;
}
function slimToolForPersist(t) {
  if (!t || typeof t !== "object") return t;
  const out = { ...t };
  for (const k of TOOL_BULKY_KEYS) delete out[k];
  if (typeof out.description === "string" && out.description.length > 400) out.description = out.description.slice(0, 400);
  if (Array.isArray(out.tags) && out.tags.length > 8) out.tags = out.tags.slice(0, 8);
  return out;
}

/** An errored entry that still carries the catalogue an earlier good crawl
 *  produced. crawlSeller keeps that catalogue on a failure on purpose ("so a
 *  transient outage doesn't drop the seller from the Index"), so it must
 *  survive a restart too; an origin that never produced one has nothing to
 *  carry and is still left for the crawl to re-decide. */
export function heldLastGood(v) {
  return Boolean(v?.error) && Array.isArray(v.tools) && v.tools.length > 0;
}

/** The entries to persist: slim projections of every origin that holds a
 *  catalogue (an errored one keeps its error and history, so it warm-starts
 *  as the same unhealthy, unroutable listing it was before the restart). */
function persistedEntries() {
  const out = [];
  for (const [origin, v] of cache.entries()) {
    // A failure with nothing to show is not re-seeded; the crawl re-decides.
    // A failure that still holds its last good catalogue is. Dropping those
    // made one failed crawl before a restart delete the listing outright,
    // and the per-operator crawl cap can take hours to bring it back
    // (2026-10-02: five path sellers on one shared host vanished this way).
    if (v?.error && !heldLastGood(v)) continue;
    out.push([origin, {
      manifest: slimManifestForPersist(v.manifest),
      tools: Array.isArray(v.tools) ? v.tools.map(slimToolForPersist) : [],
      fetchedAt: v.fetchedAt ?? null,
      error: v.error ? String(v.error).slice(0, 300) : null,
      ...(v.error && Array.isArray(v.fallbackErrors) && v.fallbackErrors.length ? { fallbackErrors: v.fallbackErrors.slice(0, 5) } : {}),
      source: v.source ?? null,
      // Same class as `payment` above: published by /api/index, never
      // persisted, so it read null for every warm-started origin.
      discoveryPath: v.discoveryPath ?? null,
      history: Array.isArray(v.history) ? v.history.slice(-10) : [],
      paywall: v.paywall ?? null,
      ...(v.redirectedTo ? { redirectedTo: v.redirectedTo } : {}),
    }]);
  }
  return out;
}

/** Async persist for the crawler's own cycle. Each origin is stringified ONCE,
 *  in batches with an event-loop turn between them, and both files are built
 *  from those lines: the whole-cache stringify, a second stringify per origin
 *  to size the log line and a third for the NDJSON lines used to run as one
 *  synchronous block (~220 ms for 52 MB locally, seconds on the production
 *  container). Overlapping cycles never write twice. */
let persistInFlight = false;
const PERSIST_BATCH = 50;
export async function persistIndexCacheAsync(file = INDEX_CACHE_FILE) {
  if (persistInFlight) return false;
  persistInFlight = true;
  try {
    if (cache.size === 0) return false;
    const entries = persistedEntries();
    if (!entries.length) return false;
    const savedAt = Date.now();
    const t0 = performance.now();
    const lines = new Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      lines[i] = JSON.stringify(entries[i]);
      if ((i + 1) % PERSIST_BATCH === 0) await new Promise((r) => setImmediate(r));
    }
    const ms = Math.round(performance.now() - t0);
    const bytes = lines.reduce((n, l) => n + l.length + 1, 0);
    // Always say how big it is, and which origins carry it: the file was 91 MB
    // before the slim projection and 48 MB after, and what remains is tool
    // arrays. Naming the five largest origins each cycle is how the next cut
    // gets sized from data instead of a guess.
    const top = entries.map(([o], i) => [o, lines[i].length]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`[x402-index] persisted ${(bytes / 1_048_576).toFixed(1)} MB for ${entries.length} origins in ${ms}ms; largest: ` +
      top.map(([o, n]) => `${o} ${(n / 1024).toFixed(0)}KB/${(cache.get(o)?.tools || []).length} tools`).join(", "));
    const { writeFile, rename } = await import("node:fs/promises");
    // NDJSON for the incremental loader: header line, then one [origin, entry]
    // per line. Written to a temp path and renamed so a crash mid-write can
    // never leave a half file for the next boot to read.
    const ndFile = file === INDEX_CACHE_FILE ? INDEX_CACHE_NDJSON_FILE : file.replace(/\.json$/, "") + ".ndjson";
    const header = JSON.stringify({ savedAt, format: "ndjson-v1", origins: entries.length });
    await writeFile(`${ndFile}.tmp`, header + "\n" + lines.join("\n") + "\n");
    await rename(`${ndFile}.tmp`, ndFile);
    // The legacy single-JSON file stays current too, for the sync loader and
    // for anything that copies it (backups exclude cache files anyway). Built
    // from the same lines: byte-identical to JSON.stringify({ savedAt, entries }).
    await writeFile(file, `{"savedAt":${savedAt},"entries":[${lines.join(",")}]}`);
    return true;
  } catch { return false; }
  finally { persistInFlight = false; }
}

export function persistIndexCache(file = INDEX_CACHE_FILE) {
  try {
    if (cache.size === 0) return false; // never overwrite a good file with nothing
    const out = persistedEntries();
    if (!out.length) return false;
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), entries: out }));
    return true;
  } catch { return false; }
}

/** Warm the cache from the last persisted crawl. Never clobbers an entry the
 *  live crawler has already refreshed in this process. Returns rows loaded. */
export function loadPersistedIndexCache(file = INDEX_CACHE_FILE) {
  return timedSync("x402 index warm-start", file, () => _loadPersistedIndexCache(file));
}
/** One warm-started entry into the cache (shared by both loaders). */
function foldWarmEntry(origin, v) {
  if (typeof origin !== "string" || !origin || cache.has(origin) || !v || typeof v !== "object") return false;
  cache.set(origin, { ...v, warmStarted: true });
  // CRITICAL: re-seed the crawler with every warm-started origin (see the
  // legacy loader below for the incident that made this load-bearing).
  discoveredSeeds.add(origin);
  return true;
}

/** Incremental warm-start from the NDJSON twin: the file is read off the
 *  loop, then parsed WARM_START_BATCH lines per turn with a setImmediate
 *  between batches, so /health and buyers are answered throughout. Resolves
 *  to the number of sellers loaded, 0 when the file is absent or unreadable
 *  (callers fall back to the legacy loader). */
const WARM_START_BATCH = Number(process.env.INDEX_WARM_START_BATCH || 250);
export async function loadPersistedIndexCacheAsync(file = INDEX_CACHE_NDJSON_FILE) {
  // Raised BEFORE the read, not after: during the read the cache is still
  // empty, and a snapshot taken then would pin an empty ecosystem for 30 s.
  warmStartInProgress = true;
  const t0 = performance.now();
  let n = 0, bad = 0, maxTurnMs = 0;
  try {
    let text;
    try {
      const { readFile } = await import("node:fs/promises");
      text = await readFile(file, "utf8");
    } catch { return 0; }
    let pos = text.indexOf("\n");
    if (pos < 0) return 0;
    try { JSON.parse(text.slice(0, pos)); } catch { return 0; } // header must parse: not our file
    pos++;
    while (pos < text.length) {
      const turn0 = performance.now();
      for (let i = 0; i < WARM_START_BATCH && pos < text.length; i++) {
        let end = text.indexOf("\n", pos);
        if (end < 0) end = text.length;
        const line = text.slice(pos, end);
        pos = end + 1;
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (Array.isArray(e) && foldWarmEntry(e[0], e[1])) n++;
        } catch { bad++; }
      }
      maxTurnMs = Math.max(maxTurnMs, performance.now() - turn0);
      if (pos < text.length) await new Promise((r) => setImmediate(r));
    }
  } finally {
    warmStartInProgress = false;
  }
  console.log(`[x402-index] warm-started ${n} sellers from ${file} in ${Math.round(performance.now() - t0)}ms (longest turn ${Math.round(maxTurnMs)}ms${bad ? `, ${bad} unreadable line(s)` : ""})`);
  return n;
}

function _loadPersistedIndexCache(file = INDEX_CACHE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    let n = 0;
    for (const [origin, v] of entries) {
      if (typeof origin !== "string" || !origin || cache.has(origin)) continue;
      cache.set(origin, { ...v, warmStarted: true });
      // CRITICAL: re-seed the crawler with every warm-started origin. The crawl
      // loop only visits seedList() — a cache entry whose origin is in no seed
      // set is an ORPHAN: served forever, re-crawled never, wrong forever once
      // the seller changes anything. Found live 2026-07-27: a seller fixed
      // their manifest and their listing stayed frozen at the stale tool count
      // through every crawl cycle because warm-start restored the cache but
      // not the seeds. Discovery may re-add these origins anyway when a
      // registry lists them, but that must never be load-bearing.
      discoveredSeeds.add(origin);
      n++;
    }
    return n;
  } catch { return 0; }
}

const ROUTE_INDEX_WARM_DELAY_MS = Number(process.env.ROUTE_INDEX_WARM_DELAY_MS || 30_000);
export function startCrawler(opts = {}) {
  if (crawlerTimer) return;
  // Removals load FIRST, so no seed, warm-started entry or first crawl can
  // bring a removed origin back before the block is in place.
  loadRemovedOrigins();
  loadSubmittedSeeds();
  // Successions survive a restart or they stop hiding the duplicate they were
  // recorded to hide, and the seller is listed twice again on the next boot.
  loadSuccessions();
  loadGoneRoutes();
  // Warm start: the NDJSON twin incrementally when it exists (its own log
  // line says how long and the longest turn), else the legacy JSON in one
  // synchronous parse. The first crawl is deferred below, so the fill has
  // finished long before anything re-crawls.
  const scheduleRouteIndexWarm = () => {
    const t = setTimeout(() => {
      try { const t0 = Date.now(); const n = warmRouteIndex(); console.log(`[x402-index] route index warmed: ${n} tools in ${Date.now() - t0} ms (off the first buyer's query)`); }
      catch (e) { console.warn(`[x402-index] route index warm failed (the first query builds it instead): ${String(e?.message || e).slice(0, 120)}`); }
    }, ROUTE_INDEX_WARM_DELAY_MS);
    t.unref?.();
  };
  if (opts.syncWarmStart) {
    const warmed = loadPersistedIndexCache();
    if (warmed) console.log(`[x402-index] warm-started ${warmed} sellers from ${INDEX_CACHE_FILE}`);
    scheduleRouteIndexWarm();
  } else {
    loadPersistedIndexCacheAsync().then((n) => {
      if (n) return;
      const warmed = loadPersistedIndexCache();
      if (warmed) console.log(`[x402-index] warm-started ${warmed} sellers from ${INDEX_CACHE_FILE} (no NDJSON twin yet)`);
    }).catch(() => {}).finally(scheduleRouteIndexWarm);
  }
  const { selfOrigin = null } = opts;
  // Kick off discovery first so the first crawl has registry-sourced seeds in
  // hand (best-effort — if discovery is slow, the first crawl just uses env seeds).
  // The first cycle is DEFERRED past boot. Starting it on the spot put the
  // crawler's TLS handshakes and JSON parsing (~1.7 s of self-time in the
  // 2026-08-25 boot profile) into the same seconds the container needs to
  // answer its first health check; the warm-started cache already serves every
  // reader meanwhile. Tests that need it immediately pass firstDelayMs: 0.
  const firstDelayMs = Number.isFinite(opts.firstDelayMs) ? opts.firstDelayMs : Number(process.env.INDEX_FIRST_CRAWL_DELAY_MS ?? 30_000);
  firstCrawlTimer = setTimeout(() => {
    firstCrawlTimer = null;
    runDiscovery(selfOrigin).then(() => runCrawl()).then(() => persistIndexCacheAsync()).catch(() => {});
  }, Math.max(0, firstDelayMs));
  if (typeof firstCrawlTimer.unref === "function") firstCrawlTimer.unref();
  crawlerTimer = setInterval(() => {
    // Re-check a few recorded successions each cycle. A retirement is a claim
    // about NOW, and the marker that justified it can be taken down; without
    // this the hiding outlives the proof and the seller has no undo.
    runCrawl()
      .then(() => reverifySuccessions().catch(() => {}))
      // ...and look for a few nobody registered. A seller who migrated before
      // `replaces` recorded anything is invisible to reverify, which only ever
      // re-checks what is already in the map.
      .then(() => discoverSuccessions().catch(() => {}))
      .then(() => persistIndexCacheAsync())
      .catch(() => {});
  }, CRAWL_INTERVAL_MS);
  discoveryTimer = setInterval(() => runDiscovery(selfOrigin), DISCOVERY_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  if (typeof crawlerTimer.unref === "function") crawlerTimer.unref();
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
}

/** Stop the crawler (used by tests to keep the process exitable). */
export function stopCrawler() {
  if (firstCrawlTimer) {
    clearTimeout(firstCrawlTimer);
    firstCrawlTimer = null;
  }
  if (crawlerTimer) {
    clearInterval(crawlerTimer);
    crawlerTimer = null;
  }
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}

function buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName }) {
  const tools = toolList(catalog).map((t) => ({
    seller: LOCAL_SELLER,
    method: t.route.split(" ")[0],
    route: t.route.split(" ")[1] || t.route,
    slug: t.slug,
    name: t.name,
    description: t.description || "",
    ...(Array.isArray(t.aliases) && t.aliases.length ? { aliases: t.aliases } : {}),
    category: t.category,
    tags: t.tags || [],
    price: prices?.[t.slug] ?? parsePrice(t.price),
    // The same field every remote row carries, so one rule reads every row.
    priceKnown: priceToMicroUsd(t.price) != null,
  }));
  return {
    origin: LOCAL_SELLER,
    displayName: walletName ? `Agent402.Tools (${walletName})` : "Agent402.Tools",
    homepage: baseUrl,
    network,
    // Every rail this host settles on (CAIP-2) — same shape crawled sellers get
    // from their 402 accepts, so the marketplace roster's Chain column renders
    // us like any other seller instead of an empty dash.
    networks: RAILS.map((r) => r.caip2),
    toolCount,
    tools,
    fetchedAt: Date.now(),
    local: true,
  };
}

// Canonical functional taxonomy for the ecosystem supply mix. Crawled sellers
// set `category = tags[0]` verbatim (see buildManifestTools), which fragments
// into hundreds of raw tags and dumps every untagged tool into "other". This
// classifier maps each tool to ONE closed-set functional bucket by keyword, so
// the market-pulse supply mix is meaningful. Deterministic (no LLM). Ordered
// MOST-SPECIFIC first — first match wins (defi before crypto so "swap on Base"
// is defi; research before ai so arXiv is research; health before utility so a
// BMI calc is health). Deliberately NOT keyed on base/mainnet/agent/x402/usdc —
// those appear in nearly every listing and would swallow everything.
//
// The haystack is name + description + tags + route + slug, TOKENIZED: most
// crawled tools come from a seller's openapi.json where description/tags are
// empty and the only signal is a terse summary and a token-rich path
// (/v1/bulk/dns, /v1/amazon/products/price). tokenize() splits camelCase,
// snake_case, kebab, and path separators into words so those path tokens match
// (verified against real seller specs — cuts "other" ~30%->~19% on that
// corpus). Patterns must match the TOKENIZED form: no hyphens/underscores,
// "on-chain" -> "on chain". Only the market-pulse view uses this; the raw
// `category` field is untouched for find/search/category pages.
const ECOSYSTEM_CATEGORY_RULES = [
  ["defi",       /\b(defi|swap|dex|liquidity|perp(etual|s)?|hyperliquid|lending|yield|amm|slippage|aggregator route|best route)\b/],
  ["crypto",     /\b(btc|bitcoin|eth|ethereum|solana|\bsol\b|xrp|erc ?20|onchain|on chain|wallet|\bens\b|\btx\b|transaction hash|chain id|market cap|gainers|losers|coingecko|coinbase|crypto|blockchain|staking|\bnft\b|token price|gas price|gwei)\b/],
  ["finance",    /\b(forex|exchange rate|currenc(y|ies)|\bfx\b|stock|equit(y|ies)|\bsec\b|financ(e|ial|ials)|earnings|treasury|bond|macro|\bgdp\b|inflation|ticker|dividend|options?|volatility|invoice)\b/],
  ["commerce",   /\b(amazon|\basin\b|product|shopping|ecommerce|walmart|\bebay\b|price check|retail|catalog|\bsku\b|merchant)\b/],
  ["social",     /\b(twitter|tweet|x com|reddit|subreddit|linkedin|farcaster|telegram|instagram|tiktok|youtube|social)\b/],
  ["research",   /\b(arxiv|scientif|literature|preprint|academ|papers?|citation|longevity|research|grant)\b/],
  ["ai",         /\b(\bllm\b|\bgpt\b|openai|grok|claude|gemini|text to speech|\btts\b|speech|image generation|generate image|image gen|embedding|inference|transcri|summari|rerank|prompt|completion)\b/],
  ["jobs",       /\b(jobs?|indeed|glassdoor|ziprecruiter|hiring|recruit|vacanc|career)\b/],
  ["people",     /\b(people search|person research|enrichment|dossier|public records|whois|\bkyc\b|\bkyb\b|background check|contact info|email lookup|email validate|email verif|phone lookup|reverse)\b/],
  ["security",   /\b(ransomware|0day|zero day|exploit|vulnerab|threat intel|darkweb|dark web|malware|phishing|breach|\bcve\b|sanction)\b/],
  ["news",       /\b(news|headlines|press release|breaking|journalis)\b/],
  ["weather",    /\b(weather|forecast|temperature|climate|precipitation|humidity)\b/],
  ["maps",       /\b(maps?|geocod|geolocat|places|directions|routing|distance matrix)\b/],
  ["search",     /\b(search|retrieval|scrape|scraping|crawl|serper|\bexa\b|firecrawl|web data|extract|\bserp\b)\b/],
  ["email",      /\b(email|smtp|imap|inbox|mailbox|send mail|\bsms\b|messaging)\b/],
  ["seo",        /\b(\bseo\b|keyword|backlink|serp rank|domain authority)\b/],
  ["sports",     /\b(sports?|\bnba\b|\bnfl\b|soccer|odds|betting|fixtures)\b/],
  ["media",      /\b(image|photo|video|audio|music|face detection|object detection|celebrity|render|design|logo|favicon|screenshot|vision|\bstem\b|media|thumbnail)\b/],
  ["documents",  /\b(\bpdf\b|docx?|office|spreadsheet|markdown|document)\b/],
  ["dev",        /\b(code|python|javascript|sandbox|\be2b\b|browser|browserbase|repo|github|gitlab|\bgit\b|compile|execution|runtime|regex|api spec|openapi|webhook|deploy)\b/],
  ["travel",     /\b(flight|aviation|airline|hotel|maritime|marine|trucking|shipping|logistics|supply chain|freight|vessel|voyage)\b/],
  ["realestate", /\b(real estate|property|housing|mortgage|zillow|rent(al)?|listing agent)\b/],
  ["insurance",  /\b(insurance|claims|policy|underwrit|actuar)\b/],
  ["health",     /\b(\bbmi\b|\bbmr\b|\bbac\b|\bbsa\b|medical|clinical|drug|\bfda\b|dose|dosage|pregnan|gestational|due date|health|disease|symptom|\bicd\b|calorie|body mass|metabolic)\b/],
  ["utility",    /\b(json|csv|hash|base64|encode|decode|timezone|datetime|uuid|\bdiff\b|color|isbn|calc|calculator|conversion|convert|\bqr\b|barcode|combinatoric|dilution)\b/],
  ["infra",      /\b(\bdns\b|\bip\b|geoip|network lookup|uptime|monitoring|status page|\bssl\b|certificate|ping|traceroute)\b/],
];

// Split camelCase / snake_case / kebab / path separators into space-delimited
// words and lowercase, so terse openapi tokens in a route or operationId become
// matchable words ("get_v1_bulk_dns" -> "get v1 bulk dns", "getTokenPrice" ->
// "get token price"). Patterns above assume this normalized form.
function tokenizeForCategory(s) {
  return String(s || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-/{}.]+/g, " ")
    .toLowerCase();
}

/**
 * Map one crawled tool to a canonical functional category (closed set). No
 * raw-tag passthrough — an unmatched tool is "other", not its own singleton
 * bucket (which would just relocate the fragmentation). Reads name +
 * description + tags + route + slug so terse openapi tools classify on their
 * path when summary/description are empty.
 */
export function classifyEcosystemCategory(t) {
  const raw = `${t?.name || ""} ${t?.description || ""} ${(t?.tags || []).join(" ")} ${t?.route || ""} ${t?.slug || ""}`;
  // Include BOTH the raw lowercased text AND the tokenized form: tokenizing
  // splits path tokens into matchable words but also splits compound brand
  // names (LinkedIn -> "linked in", GitHub -> "git hub"), so keep the raw text
  // too or those keywords stop matching.
  const hay = `${raw.toLowerCase()} ${tokenizeForCategory(raw)}`;
  for (const [cat, re] of ECOSYSTEM_CATEGORY_RULES) if (re.test(hay)) return cat;
  return "other";
}

// Per-category tool counts are dominated by a handful of giant auto-generated
// catalogues (one seller alone lists 10k tools, ~30% of the whole crawl, almost
// all in one bucket). Counting DISTINCT SELLERS is the primary dominance guard,
// but the secondary `tools` figure still let one catalogue skew a category. Cap
// each seller's contribution to any one category's tool count so `tools`
// measures breadth of supply, not one operator's catalogue size. The true,
// uncapped total is still reported as `toolsIndexed` — nothing is hidden.
const MAX_TOOLS_PER_SELLER_PER_CATEGORY = 50;

/**
 * Pure aggregation of the supply mix from a list of crawl-cache entries. Kept
 * separate from `ecosystemMarket` (which reads the module-private cache) so it
 * can be unit-tested with synthetic entries, including a single giant seller.
 * `tools` is the TRUE uncapped tool total; per-category `tools` is capped at
 * `capPerSeller` per seller so no one catalogue dominates.
 */
export function aggregateEcosystemSupply(entries, { limit = 12, capPerSeller = MAX_TOOLS_PER_SELLER_PER_CATEGORY } = {}) {
  let sellers = 0, tools = 0;
  const catSellers = new Map();
  const catTools = new Map();
  for (const v of entries) {
    if (v.error || !Array.isArray(v.tools) || !v.tools.length) continue;
    sellers++;
    tools += v.tools.length; // true, uncapped
    const perCat = new Map();
    for (const t of v.tools) {
      const c = classifyEcosystemCategory(t);
      perCat.set(c, (perCat.get(c) || 0) + 1);
    }
    for (const [c, n] of perCat) {
      catTools.set(c, (catTools.get(c) || 0) + Math.min(n, capPerSeller));
      catSellers.set(c, (catSellers.get(c) || 0) + 1);
    }
  }
  const categories = [...catSellers.keys()]
    .map((category) => ({ category, sellersOffering: catSellers.get(category), tools: catTools.get(category) || 0 }))
    .sort((a, b) => b.sellersOffering - a.sellersOffering || b.tools - a.tools)
    .slice(0, limit);
  return { sellers, tools, categories, toolsCapPerSeller: capPerSeller };
}

/**
 * Cross-provider market supply mix: how the whole x402 ecosystem's tool
 * catalogue breaks down by canonical category, aggregated over every crawled
 * seller's manifest (NOT Agent402's own catalogue — the crawler cache is remote
 * sellers only). Counts DISTINCT SELLERS per category, and caps each seller's
 * per-category tool contribution (see MAX_TOOLS_PER_SELLER_PER_CATEGORY) so one
 * big catalogue can't dominate. Reads the in-memory crawl cache — no network.
 * Powers the x402-market-pulse tool's supply side (demand comes from the
 * on-chain leaderboard).
 */
// The aggregate walks every crawled origin and classifies every one of its
// tools with regexes, synchronously: measured 2026-10-09 at a 20 s median per
// call over 4,785 origins (9 s in August, rising with the index), on the event
// loop, for a tool bought a few times a week. It is a market picture, not a
// per-call read, so it is memoized: the first caller computes it once, later
// callers get the memo, and past MARKET_MEMO_TTL_MS one caller starts a
// chunked recompute in the background (a slice of origins per tick, so the
// loop is never held) while everyone keeps reading the last picture.
const MARKET_MEMO_TTL_MS = 15 * 60_000;
const MARKET_CHUNK = 50;
let marketMemo = { at: 0, limit: null, value: null, version: -1 };
let marketRefresh = null;
let marketTtlMs = MARKET_MEMO_TTL_MS;
/** Test hook: shorten (or reset) the memo TTL; clears the memo. */
export function __setMarketMemoTtl(ms) { marketTtlMs = Number.isFinite(ms) && ms >= 0 ? ms : MARKET_MEMO_TTL_MS; marketMemo = { at: 0, limit: null, value: null, version: -1 }; marketRefresh = null; }
async function refreshEcosystemMarket(limit) {
  const entries = [...cache.values()];
  const version = cacheVersion;
  const parts = [];
  for (let i = 0; i < entries.length; i += MARKET_CHUNK) {
    parts.push(aggregateEcosystemSupply(entries.slice(i, i + MARKET_CHUNK), { limit: Infinity }));
    await new Promise((r) => setImmediate(r));
  }
  // Merge the per-slice aggregates: sellers and tools add, categories add per
  // name, and the limit is applied once at the end, the same as one pass.
  const catSellers = new Map(), catTools = new Map();
  let sellers = 0, tools = 0;
  for (const p of parts) {
    sellers += p.sellers; tools += p.tools;
    for (const c of p.categories) {
      catSellers.set(c.category, (catSellers.get(c.category) || 0) + c.sellersOffering);
      catTools.set(c.category, (catTools.get(c.category) || 0) + c.tools);
    }
  }
  const categories = [...catSellers.keys()]
    .map((category) => ({ category, sellersOffering: catSellers.get(category), tools: catTools.get(category) || 0 }))
    .sort((a, b) => b.sellersOffering - a.sellersOffering || b.tools - a.tools)
    .slice(0, limit);
  marketMemo = { at: Date.now(), limit, version, value: { sellers, tools, categories, toolsCapPerSeller: MAX_TOOLS_PER_SELLER_PER_CATEGORY } };
}
export function ecosystemMarket({ limit = 12 } = {}) {
  const fresh = marketMemo.value && marketMemo.limit === limit && Date.now() - marketMemo.at < marketTtlMs;
  if (fresh) return marketMemo.value;
  if (marketMemo.value && marketMemo.limit === limit) {
    // Stale: hand back the last picture now, refresh once in the background.
    if (!marketRefresh) marketRefresh = refreshEcosystemMarket(limit).catch(() => {}).finally(() => { marketRefresh = null; });
    return marketMemo.value;
  }
  // Nothing memoized for this limit yet: one synchronous pass, then memoized.
  const value = aggregateEcosystemSupply([...cache.values()], { limit });
  marketMemo = { at: Date.now(), limit, version: cacheVersion, value };
  return value;
}

/**
 * Per-seller detail: the crawled entry PLUS its full tool list. Exists so a
 * seller disputing their count can see exactly which rows we hold (the
 * 2026-07-27 "72 tools vs my 42 APIs" escalation was undiagnosable from
 * /api/index, which carries only the count). Matches by full origin or bare
 * host, case-insensitive. Returns null when unknown.
 */
/** Lightweight routable-seller list for the find->seller bridge: origin,
 *  host and toolCount only - deliberately NO third-party display text, so a
 *  consumer can attach it to agent-facing responses without inheriting the
 *  listing-injection surface. Cheap: one pass over the in-memory cache. */
/** Origins whose live 402 (probed by OUR x402 crawl, no extra request)
 *  carried an MPP `WWW-Authenticate: Payment` challenge - dual-stack sellers
 *  detected automatically, no registry needed. Feeds the MPP index as a third
 *  seed source (src/mpp-index.js discoverFromX402Crawl). */
export function mppDualStackOrigins() {
  const out = [];
  for (const [origin, v] of cache.entries()) {
    if (v?.paywall?.mpp === true) out.push(origin);
  }
  return out;
}

/**
 * Every EVM payTo any known origin advertises on `network`, mapped to the
 * origins advertising it: crawled cache entries (routable or not, error or
 * not - a seller whose probe failed still told us its address, and since
 * 2026-09-22 so did its own live 402) plus the registry-synthesized tools (the Bazaar lists payTo per resource, so a
 * Bazaar-listed seller we could never crawl is still attributable). The
 * discovery-gap report matched merchants against ROUTABLE sellers only, so
 * every known-but-unroutable origin counted as a blind spot. Attribution and
 * routability are different questions. Keys are lowercased addresses.
 */
export function allPayToOrigins(network = "eip155:8453") {
  const out = new Map();
  const add = (addr, origin) => {
    if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    const k = addr.toLowerCase();
    let set = out.get(k);
    if (!set) { set = new Set(); out.set(k, set); }
    set.add(origin);
  };
  for (const [origin, v] of cache.entries()) {
    for (const t of v?.tools || []) add(t?.payToByNetwork?.[network], origin);
  }
  for (const [origin, arr] of bazaarToolsByOrigin.entries()) {
    for (const t of arr || []) add(t?.payToByNetwork?.[network], origin);
  }
  return out;
}

/** The listing prices our own crawl knows per payTo on `network`: Map(lowercased
 *  wallet -> Set(micro-dollars)). Read by the Base leaderboard for wallets the
 *  Bazaar does not list (sellers found through our crawl, PayAI's catalog and
 *  self-registration), whose transfers could otherwise never be matched to a
 *  price the seller publishes. Crawled rows only: a Bazaar-listed wallet keeps
 *  the Bazaar's own prices (mergeCrawledWallets does not touch those rows).
 *  A route marked free, or with no readable price, contributes nothing. */
export function allPayToPrices(network = "eip155:8453") {
  const out = new Map();
  for (const v of cache.values()) {
    for (const t of v?.tools || []) {
      const addr = t?.payToByNetwork?.[network];
      if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr) || t.paid === false) continue;
      const micro = priceToMicroUsd(t.price);
      if (!(micro > 0)) continue;
      const k = addr.toLowerCase();
      let set = out.get(k);
      if (!set) { set = new Set(); out.set(k, set); }
      set.add(micro);
    }
  }
  return out;
}

/** Solana twin of allPayToOrigins: mainnet-label payTos (base58) -> origins.
 *  The Solana leaderboard's scan list (src/solana-leaderboard.js). */
export const SOLANA_MAINNET_LABELS = new Set(["solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp", "solana", "solana-mainnet", "solana-mainnet-beta"]);
export function allSolanaPayToOrigins() {
  const out = new Map();
  const add = (addr, origin) => {
    if (typeof addr !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return;
    let set = out.get(addr);
    if (!set) { set = new Set(); out.set(addr, set); }
    set.add(origin);
  };
  const fromTool = (t, origin) => {
    for (const [net, addr] of Object.entries(t?.payToByNetwork || {})) if (SOLANA_MAINNET_LABELS.has(String(net).toLowerCase())) add(addr, origin);
  };
  for (const [origin, v] of cache.entries()) for (const t of v?.tools || []) fromTool(t, origin);
  for (const [origin, arr] of bazaarToolsByOrigin.entries()) for (const t of arr || []) fromTool(t, origin);
  return out;
}

// Rebuilt from the whole crawl cache (alias detection plus a projection of
// every routable seller), and read two or more times by every /api/find and
// /api/route call. On production's cache that rebuild is far from free, and a
// burst of searches spent the event loop on it (2026-09-25: 3-18 s stalls that
// timed out payment relays). Memoized briefly; a change in the cache size
// invalidates at once, and the TTL bounds how stale a changed entry can read.
const ROUTABLE_SUMMARY_TTL_MS = Number(process.env.ROUTABLE_SUMMARY_TTL_MS) || 30_000;
let routableSummaryMemo = null; // { at, size, out }
export function routableSellerSummaries() {
  const now = Date.now();
  if (routableSummaryMemo && routableSummaryMemo.size === cache.size && now - routableSummaryMemo.at < ROUTABLE_SUMMARY_TTL_MS) return routableSummaryMemo.out;
  const out = buildRoutableSellerSummaries();
  routableSummaryMemo = { at: now, size: cache.size, out: Object.freeze(out) };
  return routableSummaryMemo.out;
}
export function __resetRoutableSummaryMemoForTest() { routableSummaryMemo = null; }
function buildRoutableSellerSummaries() {
  const out = [];
  const aliasOrigins = computeAliasOrigins(cache);
  for (const [origin, v] of cache.entries()) {
    if (v?.error || !isRoutable(v) || aliasOrigins.has(origin)) continue;
    // The crawler can discover and cache the real, publicly-registered
    // agent402.tools origin regardless of what BASE_URL this instance is
    // configured with (see indexSnapshot's identical guard) - this feeds
    // agent-facing find/route responses, so a self-entry here isn't just a
    // display artifact, it's "here's a third-party alternative" pointing
    // right back at the same server. No baseUrl parameter is threaded
    // through this function's many call sites, so this checks the
    // well-known domain only (the scenario that's actually been observed),
    // not a dynamic instance-specific one.
    if (origin.replace(/\/+$/, "").toLowerCase() === "https://agent402.tools") continue;
    let host = "";
    try { host = new URL(origin).host.toLowerCase(); } catch { continue; }
    out.push({
      origin,
      host,
      ...(sellerPrefixOf(origin) ? { pathPrefix: sellerPrefixOf(origin) } : {}),
      toolCount: v.tools?.length || manifestToolCount(v.manifest),
      // Did the origin ever answer us, or is this a registry listing about it?
      originResponded: v.originResponded !== false,
      // Rides with originResponded on ALL THREE accessors on purpose: this
      // file has twice shipped a field present on two of three, which is
      // inert on whichever surface happens to render.
      discoveryPath: v.discoveryPath || null,
      // payTo per advertised network, so callers can join an origin to on-chain
      // settlements it received. Read from every surface that states one: the
      // origin's OWN live 402 (enrichLiveQuotes), its manifest accepts or
      // service-wide payment block, and facilitator discovery-registry items.
      // The first two are the origin's own word about where it is paid, which
      // is the address the router would pay and therefore own evidence; a
      // wallet an origin merely NAMES in someone else's listing stays bound to
      // that listing (src/evidence-binding.js decides what it may inherit).
      //
      // Omitting it silently broke the router's chain-derived proven-ness join:
      // baseNetworkPayTo() returned null for every seller, so the evidence
      // source contributed nothing, always, and looked identical to "no data".
      // The origin's own address first per network (sellerPayToByNetwork).
      payToByNetwork: sellerPayToByNetwork(v.tools),
      // Every advertised payTo, not just the first (see allPayTosByNetwork).
      payTosByNetwork: allPayTosByNetwork(v.tools),
      evmDomainByNetwork: evmDomainUnion(v.tools),
    });
  }
  return out;
}

// Every distinct payTo a tool list advertises, per network. The `payToByNetwork`
// fields elsewhere are first-wins single strings and must stay that way (the
// router's proven-ness join and the market pages index them directly), but
// first-wins DISCARDS every payee after the first - and an origin that gives
// each author their own revenue split legitimately advertises many. Measured on
// a live seller 2026-08-06: 236 paid routes, 22 authors, 22 distinct payTo, of
// which the index kept one. Case-exact, since folding base58/base32 or
// checksummed EVM addresses merges distinct payees (same rule as src/payer.js).
/** First advertised EIP-712 domain per EVM network across a tool list, the
 *  seller-level twin of payToByNetwork (first seen per network wins). */
function evmDomainUnion(tools) {
  const acc = {};
  for (const t of tools || []) {
    for (const [net, obs] of Object.entries(t?.evmDomainByNetwork || {})) {
      if (!acc[net] && obs && typeof obs === "object" && typeof obs.asset === "string" && typeof obs.name === "string") acc[net] = { asset: obs.asset, name: obs.name };
    }
  }
  return acc;
}

export function allPayTosByNetwork(tools) {
  return (tools || []).reduce((acc, t) => {
    for (const [net, addr] of Object.entries(t?.payToByNetwork || {})) {
      const seen = (acc[net] ||= []);
      if (!seen.includes(addr) && seen.length < 200) seen.push(addr);
    }
    return acc;
  }, {});
}

// How many of a seller's tools one detail response carries. Bounded because a
// single origin can publish thousands and this endpoint is free; the number is
// published on the response so the bound is never mistaken for the catalogue.
export const SELLER_TOOLS_CAP = 500;

export function sellerDetail(originOrHost) {
  // One matcher for every lookup (findSellerKey): an exact key, or a host. A
  // path seller is found by its prefixed URL.
  const key = findSellerKey(originOrHost);
  if (!key) return null;
  for (const [origin, v] of cache.entries()) {
    if (origin !== key) continue;
    return {
      origin,
      // Present only for a path seller, so a bare origin's detail is unchanged.
      ...(sellerPrefixOf(origin) ? { pathPrefix: sellerPrefixOf(origin) } : {}),
      displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
      homepage: v.manifest?.homepage || origin,
      // The routes this lookup returns, counted. It used to fall back to the
      // manifest's own capabilities.tools when we held no rows, so a seller
      // whose one route we had dropped read "toolCount 1, toolsReturned 0".
      // The seller's own figure is still published, under its own name, when
      // it differs from what we hold.
      toolCount: (v.tools || []).length,
      ...(manifestToolCount(v.manifest) > 0 && manifestToolCount(v.manifest) !== (v.tools || []).length
        ? { declaredToolCount: manifestToolCount(v.manifest), declaredToolCountNote: "the tool count the seller's own manifest states (capabilities.tools); toolCount is the routes this index holds and returns" }
        : {}),
      ...(v.tools?.some((t) => t.paid !== undefined)
        ? { paidToolCount: v.tools.filter((t) => t.paid !== false).length }
        : {}),
      fetchedAt: v.fetchedAt ?? null,
      error: v.error || null,
      health: healthScore(v),
      // A superseded origin still answers here and says where it went. An old
      // link that 404s teaches nothing; one that names its successor is how
      // anyone holding a stale reference finds the live seller. Ranked
      // listings hide it (it is the same seller twice); direct lookup does not.
      ...(succeededBy(origin) ? { succeededBy: succeededBy(origin), listed: false, listedNote: "this origin was replaced by the one named in succeededBy, so it is not ranked or listed; it still answers here" } : {}),
      // The same two fields the snapshot carries, so the ?seller= detail can be
      // dispatch-labelled from its own evidence (2026-09-02).
      routable: isRoutable(v),
      networks: [...new Set((v.tools || []).flatMap((t) => t.networks || []))],
      // Paywall liveness, measured separately from crawl health. `health` only
      // says the manifest parsed; a seller whose every paid route 500s scores a
      // perfect 1.0 on it. null = not probed yet (never assume healthy).
      paywall: v.paywall || null,
      // Same probe, no extra request: does this seller's paid route also
      // carry WWW-Authenticate: Payment (native MPP dual-stack)? null = never
      // probed yet, matching paywall's own convention.
      mpp: v.paywall?.mpp ?? null,
      // Registry-only records (the origin never answered) are not evidence the
      // seller works. Surfaced so a consumer can tell a crawled seller from a
      // listed one.
      originResponded: v.originResponded !== false,
      // Rides with originResponded on ALL THREE accessors on purpose: this
      // file has twice shipped a field present on two of three, which is
      // inert on whichever surface happens to render.
      discoveryPath: v.discoveryPath || null,
      // Why each fallback surface (openapi, agents.json, llms.txt) gave
      // nothing on the last crawl that fell back; absent when the manifest or
      // a fallback served the catalogue. A backed-off path says so, and an
      // explicit re-registration at /sell clears every backoff.
      ...(Array.isArray(v.fallbackErrors) && v.fallbackErrors.length ? { fallbackErrors: v.fallbackErrors } : {}),
      // payTo per advertised network, from the origin's own live 402 and its
      // own documents as well as from a registry listing about it (see the
      // same field on routableSellerSummaries). Omitting it made
      // advertisedPayToEvidence inert: server.js passes THIS object as `seller`,
      // so baseNetworkPayTo() read undefined and the paid seller-trust tool
      // reported "advertises no payTo" for every seller, including the many that
      // plainly do.
      // The origin's own address first per network (sellerPayToByNetwork).
      payToByNetwork: sellerPayToByNetwork(v.tools),
      // Every payee this origin advertises, so a venue hosting many authors is
      // not reported as a single seller (see allPayTosByNetwork).
      payTosByNetwork: allPayTosByNetwork(v.tools),
      // The EIP-712 domain name each EVM accept advertises, first seen per
      // network - the router label's evidence for usdc_domain_mismatch.
      evmDomainByNetwork: evmDomainUnion(v.tools),
      routable: isRoutable(v),
      // THE AUDIT TRAIL, on the one surface that promised it. The listing page
      // strips `history` on purpose (the bulk snapshot is the crawl-and-score
      // work, and shipping every origin's in one unauthenticated GET gives a
      // competing router it for free), and server.js's own comment says the
      // field is "kept for the single-seller drill-down" - it never was. So
      // three published claims were false in the most expensive direction:
      // the wiki told an operator that the bulk listing published each
      // seller's rolling history for auditing, and that the history behind our
      // health scores was there for anyone to verify. Neither was true on any
      // public surface, and a seller who went looking for it found nothing and
      // could not tell "withheld" from "we
      // hold none". One origin's own five crawl outcomes are not the bulk this
      // was ever protecting: it is their result, about their origin, on the
      // surface we tell them to self-diagnose with. `healthWindow` rides with
      // it because a bare [1,0,1] is its own quiet contract - a reader cannot
      // otherwise tell a short history from a truncated one.
      history: Array.isArray(v.history) ? v.history.slice(-HEALTH_WINDOW) : [],
      healthWindow: HEALTH_WINDOW,
      listingLegend: "Per tool: declared = your own manifest, OpenAPI, agents.json or llms.txt names the route; source = manifest, or registry for a row minted by a settled payment (omitted for rows read from your OpenAPI, agents.json or llms.txt); lastVerifiedAt = when the route last answered us live. A route you do not declare must answer a live 402 at least every 7 days, and leaves the listing when its method answers 404 or 405 twice at least an hour apart, or 410 once. A 410 removes even a declared route. Re-registering at /sell re-checks every route now.",
      historyLegend: `the last ${HEALTH_WINDOW} crawl outcomes, oldest first: 1 = the manifest parsed, 0 = it did not. Fewer than ${HEALTH_WINDOW} entries means we have crawled this origin that many times, not that entries were dropped. Paywall liveness is measured separately and reported as \`paywall\`.`,
      // THE CAP HAS TO ANNOUNCE ITSELF. This list has been cut at 500 with
      // nothing saying so, on the one surface we tell a seller to use to check
      // what we hold for them ("?seller=<host> ... returns its full row").
      // Measured 2026-09-22: one indexed origin declares 3,638 tools and got
      // 500 back, so a seller auditing their own catalogue here would conclude
      // we had lost 3,138 of their routes. Same defect as the listing page that
      // read as the whole index, one branch away in the same handler, and the
      // count beside it (toolCount) was right the whole time - which is exactly
      // what makes the silence convincing.
      toolsReturned: Math.min((v.tools || []).length, SELLER_TOOLS_CAP),
      toolsTruncated: (v.tools || []).length > SELLER_TOOLS_CAP,
      toolsCap: SELLER_TOOLS_CAP,
      tools: (v.tools || []).slice(0, SELLER_TOOLS_CAP).map((t) => ({
        method: t.method || null,
        route: t.route || null,
        slug: t.slug || null,
        name: t.name || null,
        // The seller's OWN published text, echoed back. Omitted until
        // 2026-09-18, which made this view useless for the one thing a seller
        // uses it for: checking whether the description and tags they just
        // deployed reached our index. Measured that day - a seller deployed
        // both on our advice, this view showed neither, and the row had
        // carried them the whole time (a distinctive phrase from the new
        // description ranked their route first on /api/route). We told them to
        // improve metadata and then showed them a surface that could not
        // confirm it landed. Nothing here is secret: it is their document.
        description: t.description || null,
        tags: Array.isArray(t.tags) && t.tags.length ? t.tags : undefined,
        price: t.price ?? null,
        ...priceKnownProjection(t),
      ...priceConflictProjection(t),
        ...urlTemplateProjection(t),
        ...(t.paid !== undefined ? { paid: t.paid } : {}),
        // What the seller's own OpenAPI guarantees on success. Omitted rather
        // than nulled when there is nothing to report: most rows have no
        // contract and this surface serves up to 500 of them.
        ...responseContractProjection(t),
        ...requestContractProjection(t),
        // This loop's own origin, not t.seller: the row's origin is the key
        // the observer recorded under.
        ...deliveryProjection(origin, t.method, t.route),
        networks: t.networks || undefined,
        // Why this row is listed, so a seller can check a listing without
        // asking us: whether their own documents declare it, where the row
        // came from, and when it last answered us live. An undeclared row
        // that stops answering leaves the listing (see stampDeclared).
        ...listingBasisProjection(t),
      })),
    };
  }
  return null;
}

/**
 * Snapshot for the /index page. Always includes the local catalog (instant,
 * zero-network) plus whatever the crawler has accumulated.
 */
export function indexSnapshot({ baseUrl, catalog, prices, network, toolCount, walletName }) {
  const local = buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName });
  // Exclude the crawled self-entry two ways: the caller's own baseUrl (works
  // whenever this instance's BASE_URL matches what was crawled - true in
  // real production), AND the well-known, permanent production domain by
  // name (works everywhere else - CI, local dev, preview deploys - where
  // BASE_URL points at localhost/a preview host but the crawler can still
  // reach and cache the real, publicly-registered agent402.tools origin).
  // Measured live: without the second check, /marketplace and
  // /marketplace/tools both listed agent402.tools as an unlabelled
  // "third-party" seller of its own tools on any non-production boot.
  const selfBase = String(baseUrl || "").replace(/\/+$/, "").toLowerCase();
  const isSelfOrigin = (origin) => {
    const o = String(origin).replace(/\/+$/, "").toLowerCase();
    return (selfBase && o === selfBase) || o === "https://agent402.tools";
  };
  // An alias origin (a retired hostname whose manifest now comes from, or whose
  // homepage names, another listed seller) was hidden from the route pool but
  // still rendered as its own seller on every listing - two rows for one
  // service, the retired one still advertising its old chain (2026-09-10).
  const aliasOrigins = computeAliasOrigins(cache);
  const remote = [...cache.entries()].filter(([origin]) => !isSelfOrigin(origin) && !aliasOrigins.has(origin)).map(([origin, v]) => ({
    origin,
    ...(sellerPrefixOf(origin) ? { pathPrefix: sellerPrefixOf(origin) } : {}),
    displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
    homepage: v.manifest?.homepage || origin,
    network: v.manifest?.payment?.x402?.primaryNetwork || v.manifest?.payment?.primaryNetwork || null,
    toolCount: v.tools?.length || manifestToolCount(v.manifest),
    // Did the ORIGIN answer, or is this a registry listing about it? Read by
    // the marketplace label and by totals.respondedOrigins. Added here as well
    // as on the other accessors because /api/index and the market pages read
    // THIS projection, and a field present on two of three accessors is the
    // inert-signal defect this file has already produced twice.
    originResponded: v.originResponded !== false,
    // Rides with originResponded on ALL THREE accessors on purpose: this
    // file has twice shipped a field present on two of three, which is
    // inert on whichever surface happens to render.
    discoveryPath: v.discoveryPath || null,
    // Present only when the seller's document distinguishes paid from free
    // (tools carry paid flags): the buyable subset. Display uses it to show
    // "42 tools · 21 paid" so a padded free surface can't read as paid depth.
    ...(v.tools?.some((t) => t.paid !== undefined)
      ? { paidToolCount: v.tools.filter((t) => t.paid !== false).length }
      : {}),
    fetchedAt: v.fetchedAt,
    error: v.error || null,
    local: false,
    health: healthScore(v),
    routable: isRoutable(v),
    // Rides the SAME probe as `paywall` below, not a separate request -
    // whether this seller's paid route also carries WWW-Authenticate:
    // Payment (native MPP dual-stack, same signal our own src/mpp-shim.js
    // emits). null = never probed yet (honest "don't know", not "no"),
    // matching paywall's own null-until-probed convention.
    mpp: v.paywall?.mpp ?? null,
    history: Array.isArray(v.history) ? v.history.slice() : [],
    source: v.source || (v.manifest && !v.manifest.synthesized ? "manifest" : null),
    // Coinbase-measured 30-day usage from the Bazaar feed (calls, distinct
    // payers, last call) - null when the Bazaar does not list this origin.
    bazaar: bazaarQualityFor(origin),
    // Union of the chains this seller's crawled 402s advertise. Manifest-
    // sourced crawls carry no accepts, so also union the Bazaar's view of the
    // same origin — a seller with its own manifest AND Stellar accepts on the
    // Bazaar must not read as network-less (it hid two of the four known
    // Stellar sellers from /stellar).
    networks: [...new Set([
      ...(v.tools || []).flatMap((t) => t.networks || []),
      ...(bazaarToolsByOrigin.get(origin) || []).flatMap((t) => t.networks || []),
    ])],
    // First valid Stellar payTo advertised across this seller's accepts —
    // strkey-validated (ed25519 public key: G + 55 base32 chars) so a hostile
    // accepts value can never reach a Horizon URL.
    stellarWallet: [...(v.tools || []), ...(bazaarToolsByOrigin.get(origin) || [])]
      .map((t) => t.stellarPayTo)
      .find((w) => typeof w === "string" && /^G[A-Z2-7]{55}$/.test(w)) || null,
    // First valid Algorand payTo advertised across this seller's accepts —
    // strkey-validated (58 base32 chars) so a hostile accepts value can never
    // reach an indexer URL. Feeds /algorand's per-seller activity scan.
    algorandWallet: [...(v.tools || []), ...(bazaarToolsByOrigin.get(origin) || [])]
      .map((t) => t.algorandPayTo)
      .find((w) => typeof w === "string" && /^[A-Z2-7]{58}$/.test(w)) || null,
    // Union of payTo-by-network across this seller's crawled + Bazaar tools
    // (the origin's own address first, see below) — the EVM/Solana counterpart to the
    // stellar/algorand wallets above, so the market pages can scope activity to
    // an external seller's advertised address on the chain being viewed.
    // The origin's own address first per network: the Bazaar rows listed first
    // here are a registry's record and only fill a network the origin's own
    // documents and live 402s name nothing on (sellerPayToByNetwork).
    payToByNetwork: sellerPayToByNetwork([...(bazaarToolsByOrigin.get(origin) || []), ...(v.tools || [])]),
    payTosByNetwork: allPayTosByNetwork([...(bazaarToolsByOrigin.get(origin) || []), ...(v.tools || [])]),
    evmDomainByNetwork: evmDomainUnion([...(bazaarToolsByOrigin.get(origin) || []), ...(v.tools || [])]),
  }));
  // Collapse http/https duplicates of the same host into one seller. A registry
  // can list the same origin under both schemes (one origin appeared as
  // both http:// and https://), which crawled as two cache entries and rendered
  // as two identical rows. Keep one per host: prefer https, then the routable /
  // higher-tool-count entry, and union networks + wallets so nothing is lost.
  const hostKey = (o) => { try { return new URL(o).host.toLowerCase(); } catch { return String(o); } };
  const isHttps = (o) => String(o).startsWith("https://");
  const byHost = new Map();
  for (const s of remote) {
    const k = hostKey(s.origin);
    const cur = byHost.get(k);
    if (!cur) { byHost.set(k, s); continue; }
    const sBetter =
      (isHttps(s.origin) && !isHttps(cur.origin)) ||
      (isHttps(s.origin) === isHttps(cur.origin) && s.routable && !cur.routable) ||
      (isHttps(s.origin) === isHttps(cur.origin) && !!s.routable === !!cur.routable && (s.toolCount || 0) > (cur.toolCount || 0));
    const keep = sBetter ? s : cur;
    const drop = sBetter ? cur : s;
    keep.networks = [...new Set([...(keep.networks || []), ...(drop.networks || [])])];
    keep.stellarWallet = keep.stellarWallet || drop.stellarWallet;
    keep.algorandWallet = keep.algorandWallet || drop.algorandWallet;
    keep.payToByNetwork = { ...(drop.payToByNetwork || {}), ...(keep.payToByNetwork || {}) };
    keep.evmDomainByNetwork = { ...(drop.evmDomainByNetwork || {}), ...(keep.evmDomainByNetwork || {}) };
    // Union, not overwrite: the two schemes of one host can advertise different
    // payees, and spreading one object over the other would drop a whole side.
    keep.payTosByNetwork = Object.entries({ ...(drop.payTosByNetwork || {}), ...(keep.payTosByNetwork || {}) })
      .reduce((acc, [net]) => {
        acc[net] = [...new Set([...((drop.payTosByNetwork || {})[net] || []), ...((keep.payTosByNetwork || {})[net] || [])])].slice(0, 200);
        return acc;
      }, {});
    keep.toolCount = Math.max(keep.toolCount || 0, drop.toolCount || 0);
    if (keep.paidToolCount != null || drop.paidToolCount != null) {
      keep.paidToolCount = Math.max(keep.paidToolCount ?? 0, drop.paidToolCount ?? 0);
    }
    byHost.set(k, keep);
  }
  const sellers = [local, ...byHost.values()];
  const discoverySources = DISCOVERY_SOURCES.map((s) => {
    const st = discoveryStatus.get(s.name);
    return {
      name: s.name,
      url: s.url,
      fetchedAt: st?.fetchedAt || null,
      resources: st?.resources ?? null,
      origins: st?.origins ?? null,
      error: st?.error || null,
      // strict sources report what filtering dropped, so the crawl's hygiene is
      // visible rather than silent (testnet-only listings + placeholder origins).
      ...(st?.droppedTestnet != null ? { droppedTestnet: st.droppedTestnet, droppedJunk: st.droppedJunk } : {}),
    };
  });
  return {
    spec: "x402-index/1",
    asOf: new Date().toISOString(),
    sellers,
    discoverySources,
    totals: {
      // NOTE: `sellers` counts indexed ORIGINS, not operators. One operator can
      // publish many hostnames — a custom domain plus the raw platform host it
      // aliases, or a template stamped across dozens of subdomains — and each
      // is a separate origin here. Measured 2026-07-31: 858 of 2,008 origins
      // carrying a Base payTo shared that address with at least one other, and
      // a single address spanned 144 origins.
      //
      // That is the same instance inflation we document in third-party
      // registries ("registries record settled URLs verbatim"), and publishing
      // only the origin count under the word "sellers" reproduces it on our own
      // machine-readable surface. So the operator-level number is published
      // beside it rather than instead of it: both are true, they answer
      // different questions, and a consumer can now tell which one it is
      // reading. /marketplace already names both populations for the same
      // reason.
      sellers: sellers.length,
      // Distinct Base payTo across indexed origins — the closest proxy we have
      // for OPERATORS. An undercount where one operator uses several wallets,
      // an overcount where a platform settles many independent sellers to one
      // address; stated as a proxy, never as a headcount.
      // Origins that ACTUALLY answered us, vs records synthesised from a
      // registry. Before this, a registry-only listing counted as a healthy
      // routable seller and the marketplace rendered it "healthy".
      respondedOrigins: sellers.filter((x) => x?.originResponded !== false).length,
      distinctBasePayees: new Set(
        sellers
          .map((x) => x?.payToByNetwork?.["eip155:8453"])
          .filter((a) => typeof a === "string" && /^0x[0-9a-f]{40}$/i.test(a))
          .map((a) => a.toLowerCase())
      ).size,
      tools: sellers.reduce((s, x) => s + (x.toolCount || 0), 0),
      // Buyable subset of `tools`. Sellers without paid flags (zero-annotation
      // docs, registry-synthesized) count fully — their rows route today, so
      // presuming them paid keeps this the routing-eligible total rather than
      // an undercount. Diverges from `tools` only as flagged-free rows appear.
      paidTools: sellers.reduce((s, x) => s + (x.paidToolCount ?? x.toolCount ?? 0), 0),
      crawled: remote.length,
      discovered: discoveredSeeds.size,
      routable: 1 + remote.filter((s) => s.routable).length, // self always routable
      unhealthy: remote.filter((s) => !s.routable).length,
      bazaarFallback: remote.filter((s) => s.source === "bazaar-fallback").length,
      openapiFallback: remote.filter((s) => s.source === "openapi-fallback").length,
    },
  };
}

// `include` controls which seller set the router considers. Defaults to "all"
// (local catalog + healthy crawled sellers). `external` excludes the local
// catalog — the explicit "find me another seller's tool" path that makes Agent402
// useful as a neutral discovery layer even when the caller isn't using us.
// `local` is the explicit local-only escape hatch.
const VALID_INCLUDE = new Set(["all", "external", "local"]);

/**
 * Smart Order Router — given a task description, rank matching tools across
 * every seller in the Index. Cheapest seller wins on score ties.
 *
 * Returns the same shape as /api/find but with a `seller` field per result and
 * cross-seller deduplication left to the buyer (different sellers may legitimately
 * offer the same tool at different prices).
 *
 * `include` (`all` | `external` | `local`) lets buyers explicitly route to
 * non-Agent402 sellers (`external`) — the same router, used as a neutral
 * discovery API over the whole x402 ecosystem.
 */
// Short chain names buyers may pass to ?network= — resolved to CAIP-2.
const ROUTE_NETWORKS = {
  base: "eip155:8453", polygon: "eip155:137", arbitrum: "eip155:42161",
  robinhood: "eip155:4663", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

// The decorated remote pool per entry and the per-tool statics (lowercased
// haystack, injection verdict, price rank) are memoized by object identity
// like the alias derivations above: entries and their tool objects are
// replaced on re-crawl, never mutated. What was tens of thousands of spread
// copies, regex passes and price parses per query is now a lookup.
const remotePoolMemo = new WeakMap(); // entry -> decorated paid tools
// Per-tool records live on the tool object under non-enumerable symbol keys
// (never serialized, never copied by a spread) rather than in WeakMaps keyed
// by 100k+ tools: V8 marks WeakMap entries as ephemerons, which lengthened
// every full GC, and a lookup is slower than a property read. A tool that is
// not extensible (a frozen catalog object) falls back to the WeakMap.
const TOOL_STATICS = Symbol("toolStatics");
const TOOL_HOME = Symbol("routeHome");
const toolStaticsMemo = new WeakMap(); // fallback for non-extensible tools only
function setHidden(obj, key, value) {
  if (!Object.isExtensible(obj)) return false;
  Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
  return true;
}
function decoratedRemoteTools(v) {
  const d = remotePoolMemo.get(v);
  if (d) return d;
  return decorateRemoteToolsStep(v, Infinity);
}
// Seller-level facts every decorated row of one entry shares.
function decorationContext(v) {
  // Seller-level payment networks: the union of every chain this seller's
  // OWN crawled 402s advertise plus the Bazaar's settled view of the same
  // origin - the same union the /api/index seller row carries. A route the
  // seller documents in OpenAPI (priced, so a buy candidate) has no accepts
  // of its own until a probe reaches it, and until 2026-09-02 such a row
  // ranked with `networks: []`: one seller's priced route
  // (thousands of settled calls that month) read as network_unknown and the router
  // never dispatched to it, while the seller's manifest rows beside it said
  // Base. So a row with NO observed accepts inherits its seller's known
  // networks, flagged `networksInferred`; a row that observed its own keeps
  // them. Money-safe: payX402 pins the accept from the LIVE 402 before it
  // signs, so an inferred chain the route does not actually offer fails the
  // buy with nothing spent - inference only decides who gets tried.
  const sellerOrigin = (v.tools || [])[0]?.seller || null;
  const sellerNets = [...new Set([
    ...(v.tools || []).flatMap((t) => t.networks || []),
    ...(sellerOrigin ? (bazaarToolsByOrigin.get(sellerOrigin) || []) : []).flatMap((t) => t.networks || []),
  ])];
  // Same inheritance for the advertised EIP-712 domain: a row that observed
  // no accepts of its own reads the seller's (a wrong name is set once, in the
  // seller's middleware, so every route on the origin carries it).
  const sellerDomains = evmDomainUnion([...(v.tools || []), ...(sellerOrigin ? (bazaarToolsByOrigin.get(sellerOrigin) || []) : [])]);
  return { sellerNets, hasDomains: Object.keys(sellerDomains).length > 0, sellerDomains, home: v.manifest?.homepage, name: v.manifest?.name, health: healthScore(v) };
}
function decorateRow(t, c) {
  return {
    ...t,
    ...(!(Array.isArray(t.networks) && t.networks.length) && c.sellerNets.length ? { networks: c.sellerNets, networksInferred: true } : {}),
    ...(!t.evmDomainByNetwork && c.hasDomains ? { evmDomainByNetwork: c.sellerDomains } : {}),
    sellerHome: c.home || t.seller,
    sellerName: c.name || t.seller,
    health: c.health,
  };
}
// Decorate an entry's rows, stopping once `until` passes: returns the pool
// when complete (and memoizes it), null when time ran out (progress is kept,
// the next call resumes). One 80,000-row seller decorated in one pass held
// the loop 33 ms locally and 185 ms on a CI runner (2026-10-02); the index
// slices call this so the decoration is cut into slices too.
const decoratePartial = new WeakMap();
function decorateRemoteToolsStep(v, until = Infinity) {
  const memo = remotePoolMemo.get(v);
  if (memo) return memo;
  let p = decoratePartial.get(v);
  if (!p) { p = { i: 0, out: [], c: decorationContext(v) }; decoratePartial.set(v, p); }
  const tools = v.tools || [];
  for (; p.i < tools.length; p.i++) {
    if ((p.i & 255) === 0 && until !== Infinity && p.i > 0 && performance.now() >= until) return null;
    const t = tools[p.i];
    // paid:false = the seller's own doc says this operation is free.
    // It lists on the marketplace, but it is never a BUY candidate —
    // route-execute would 402-dance against an endpoint that never
    // quotes, and "cheapest tool" rankings would fill with $0 rows.
    if (t.paid === false) continue;
    p.out.push(decorateRow(t, p.c));
  }
  decoratePartial.delete(v);
  remotePoolMemo.set(v, p.out);
  return p.out;
}
const NO_ALIASES = Object.freeze([]); // shared by the 100k+ tools with none
const tokenIntern = new Map();
const TOKEN_INTERN_MAX = 500_000; // past it, tokens are kept as they come
function internToken(tok) {
  const hit = tokenIntern.get(tok);
  if (hit !== undefined) return hit;
  if (tokenIntern.size < TOKEN_INTERN_MAX) tokenIntern.set(tok, tok);
  return tok;
}
function toolStatics(t) {
  let st = t[TOOL_STATICS] || toolStaticsMemo.get(t);
  if (st) return st;
  const hay = `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")}`.toLowerCase();
  st = {
    slug: (t.slug || "").toLowerCase(),
    name: (t.name || "").toLowerCase(),
    hay,
    // Metadata sanitization (M6, defends "Five Attacks on x402" Attack IV-E1 —
    // metadata manipulation): a single crafted external listing whose text tries
    // to command the selecting agent ("ignore previous instructions", "always
    // pick this", fake <system> tags) hit 71.8% selection in the paper. We DROP
    // such external listings from the router entirely — a legitimate tool
    // describes what it does, it doesn't instruct the ranker.
    // Applied to OUR rows too, not just external ones. It was external-only
    // because the filter exists to defend against seller-controlled text and we
    // trust our own - but "we are exempt from our own safety check" is a rule
    // that favours the host, and a catalog entry of ours that tripped it would
    // be a bug worth seeing rather than an exception worth granting.
    // scripts/test-discovery-note.js asserts no local tool trips it.
    injected: looksLikeListingInjection(hay),
    priceRank: priceRank(t.price),
    // Curated alternate names a tool answers to, scored exactly like the slug
    // (max over slug + aliases per term, never additive). Our asn-info IS an IP
    // geolocation tool but its slug says neither word, so "ip geolocation"
    // routed to a $0.05 external seller above our $0.003 one (2026-08-28).
    aliases: Array.isArray(t.aliases) && t.aliases.length ? t.aliases.map((a) => String(a).toLowerCase()).filter(Boolean) : NO_ALIASES,
    // The row's own NAME in slug form ("Cron next runs" -> cron-next-runs) is an
    // implicit alias: a query that covers every word of the name is an exact
    // match for the name. Applied to EVERY row, ours and the index's alike. It
    // exists because the coverage rule (2026-09-10) credits a slug for each
    // query word it carries, so an outside slug that IS a tool's full name in
    // snake_case out-scored the tool's own shorter slug on its own name (49 of
    // 585 after the first pass). Now both sides score the name the same way.
    nameSlug: (() => { const toks = splitTokens(t.name); const ns = toks.join("-"); return toks.length > 1 && ns !== String(t.slug || "").toLowerCase() ? ns : null; })(),
  };
  // Every name the slug rule scores: slug, curated aliases, the name in slug
  // form. Built once here rather than per row per query.
  st.names = [st.slug, ...st.aliases, ...(st.nameSlug ? [st.nameSlug] : [])];
  // Tokens are interned: the same few thousand words ("json", "price", "api")
  // repeat across 100k+ tools, and a private copy of each per tool was the
  // single largest thing the router held (63 MB of 164 MB on the
  // production-sized fixture, 2026-09-25).
  st.nameToks = st.names.map((n) => splitTokens(n).map(internToken));
  if (!setHidden(t, TOOL_STATICS, st)) toolStaticsMemo.set(t, st);
  return st;
}
// Whole-token test for a SHORT term (the "ip" rule) without tokenizing the
// row: `splitTokens(str).includes(term)` is true exactly when `str` carries the
// term bounded by non-token characters or the string's ends, because a term
// is itself one run of token characters. Compiled once per term per query.
//
// Implemented as indexOf plus a boundary check rather than the equivalent
// `(?:^|[^\p{L}\p{N}])term(?:$|[^\p{L}\p{N}])` Unicode regex: same answer,
// but the regex was 15% of routeQuery's CPU on a stopword-heavy query, run
// against every candidate's full description (2026-09-25).
const TOKEN_CHAR = /[\p{L}\p{N}]/u;
function isTokenCodePoint(cp) {
  if (cp < 128) return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
  return TOKEN_CHAR.test(String.fromCodePoint(cp));
}
function tokenCharBefore(str, i) {
  if (i <= 0) return false;
  const lo = str.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = str.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return isTokenCodePoint(str.codePointAt(i - 2));
  }
  return isTokenCodePoint(lo);
}
function tokenCharAt(str, i) {
  return i < str.length && isTokenCodePoint(str.codePointAt(i));
}
export function wholeTokenMatcher(term) {
  const len = term.length;
  if (!len) return () => false;
  return (str) => {
    for (let i = str.indexOf(term); i !== -1; i = str.indexOf(term, i + 1)) {
      if (!tokenCharBefore(str, i) && !tokenCharAt(str, i + len)) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// Route candidate index (2026-09-18).
//
// routeQuery used to score EVERY row of the pool on every query: 108k rows on
// prod (4,224 sellers), each read with a substring test per term on the slug,
// the name and the whole haystack, re-tokenized per row for the coverage rule
// and again for every short term, and then sorted with a comparator that read
// bazaarQualityFor() per COMPARISON. The 2026-08-25 memo measured 53 ms on a
// synthetic 2,900-seller cache with a few tools each; prod's pool is thirty
// times that many rows, and /api/route measured 0.5-1.8 s per query with
// 1-3 s event-loop stalls while a scanner ran one query a second.
//
// The index below makes candidate selection proportional to the rows that can
// score at all. It is EXACT with respect to the scoring rules, because a query
// term is one alphanumeric run (queryTerms -> splitTokens): a term is a
// substring of a haystack iff it is a substring of ONE of the haystack's
// tokens (a match cannot straddle a separator - the term has none), and a
// short term matches a whole token by definition. So a row can score iff some
// token of its slug, aliases, name or haystack contains (long term) or equals
// (short term) a query term, and postings by token are a complete candidate
// set. Rows outside it scored zero before and were dropped; rows inside are
// scored by the SAME per-row rules as before, in the SAME pool order, so the
// ranking is byte-identical (pinned by scripts/test-route-perf.js against
// a golden ranking taken from the full-scan code).
//
// Maintenance is incremental and lazy: cache mutations (the crawler's
// cache.set per seller, delete, clear) only enqueue; the next query drains the
// queue, decorating and indexing the new entries. A replaced entry's postings
// go stale rather than being removed (removing a tool from the posting of a
// common token is O(posting)), are filtered at query time by "is this tool's
// entry still the live one", and the whole index is rebuilt once the stale
// share passes ROUTE_INDEX_REBUILD_STALE_SHARE - a few hundred milliseconds
// a few times per crawl cycle, instead of on every query.
// ---------------------------------------------------------------------------
const ROUTE_INDEX_REBUILD_STALE_SHARE = 0.15;
const ROUTE_INDEX_TERM_CACHE_MAX = 4096;
const routeIdx = {
  postings: new Map(), // token -> tool[] (decorated remote pool objects)
  indexed: new WeakSet(), // entries whose pool is in `postings`
  indexedTools: 0,
  staleTools: 0,
  pending: new Map(), // origin -> entry awaiting indexing
  termCache: new Map(), // long term -> matching vocabulary tokens
  builds: 0,
  queryStamp: 0, // per-query dedupe stamp written onto each tool's home record
  shadow: null, // background rebuild in progress (see routeIndexStartShadow)
  partial: null, // live entry being indexed across slices { origin, v, pos }
};
function routeIndexNoteSet(origin, prev, next) {
  if (prev === next) return;
  if (prev && routeIdx.indexed.has(prev)) { routeIdx.staleTools += (remotePoolMemo.get(prev) || []).length; routeIdx.indexed.delete(prev); }
  if (next && typeof next === "object") { routeIdx.pending.set(origin, next); routeIndexScheduleDrain(); }
  else routeIdx.pending.delete(origin);
}
// The crawler replaces entries one at a time as its fetches land. Draining
// them in the background, in short slices, keeps the pending queue near empty,
// so a query rarely has to index a backlog inline (a full cycle's backlog was
// ~1 s on the query that met it). A query still drains whatever is left, so a
// result never misses a seller that was set before it.
let routeDrainScheduled = false;
function routeIndexScheduleDrain() {
  if (routeDrainScheduled) return;
  routeDrainScheduled = true;
  setImmediate(function drainSlice() {
    const until = performance.now() + ROUTE_INDEX_SLICE_MS;
    while (performance.now() < until) {
      if (!routeIdx.partial) {
        const first = routeIdx.pending.entries().next().value;
        if (!first) break;
        const [origin, v] = first;
        routeIdx.pending.delete(origin);
        if (cache.get(origin) !== v || routeIdx.indexed.has(v)) continue;
        routeIdx.partial = { origin, v, pos: 0 };
      }
      if (!routeIndexAdvancePartial(until)) break; // out of time inside one seller
    }
    if (routeIdx.partial || routeIdx.pending.size) setImmediate(drainSlice);
    else routeDrainScheduled = false;
  });
}
function routeIndexReset() {
  routeIdx.postings = new Map();
  routeIdx.indexed = new WeakSet();
  routeIdx.indexedTools = 0;
  routeIdx.staleTools = 0;
  routeIdx.pending.clear();
  routeIdx.termCache.clear();
  routeIdx.shadow = null; // an in-flight background rebuild is abandoned
  routeIdx.partial = null;
}
// Continue the live index's partly indexed entry until `until`. Returns true
// when the entry is finished (or no longer live), false when time ran out.
function routeIndexAdvancePartial(until = Infinity) {
  const p = routeIdx.partial;
  if (!p) return true;
  if (cache.get(p.origin) !== p.v) { routeIdx.partial = null; return true; }
  const next = routeIndexAddEntry(p.origin, p.v, routeIdx, p.pos, until);
  if (next !== -1) { p.pos = next; return false; }
  routeIdx.partial = null;
  if (routeIdx.shadow) routeIdx.shadow.late.push([p.origin, p.v]);
  routeIdx.termCache.clear();
  return true;
}
function newRouteIndexShard() {
  return { postings: new Map(), indexed: new WeakSet(), indexedTools: 0 };
}
// Index one entry's tools from `from`, stopping (and returning the position to
// resume at) once `until` passes; returns -1 when the entry is complete. The
// time check sits inside the entry because one seller can carry thousands of
// tools: the production stall profiler caught a single 4,000-tool entry
// holding the loop for 1.3 s (2026-09-25).
function routeIndexAddEntry(origin, v, target = routeIdx, from = 0, until = Infinity) {
  const pool = decorateRemoteToolsStep(v, until);
  if (!pool) return from; // decoration ran out of time: resume here next slice
  const { postings } = target;
  for (let pos = from; pos < pool.length; pos++) {
    if (pos > from && (pos & 63) === 0 && until !== Infinity && performance.now() >= until) return pos;
    const t = pool[pos];
    const st = toolStatics(t);
    // The home record is a property of the tool (its entry and position in
    // that entry's pool), the same whichever shard indexes it.
    t[TOOL_HOME] ? Object.assign(t[TOOL_HOME], { origin, v, pos }) : setHidden(t, TOOL_HOME, { origin, v, pos });
    // Tokens of the haystack (name, description, category, tags) plus those
    // of every scored name (slug, aliases, name-as-slug), deduplicated per
    // tool so one tool sits once in each posting.
    const seen = new Set(splitTokens(st.hay));
    for (const toks of st.nameToks) for (const tok of toks) seen.add(tok);
    for (const tok of seen) {
      const list = postings.get(tok);
      if (list) list.push(t); else postings.set(tok, [t]);
    }
  }
  target.indexed.add(v);
  target.indexedTools += pool.length;
  exactServiceKeyOf(v); // primes the alias-set memo off the query path
  return -1;
}
/** Build the /api/route candidate index now instead of on the first query.
 *  On a prod-sized pool the first build is ~1 s of synchronous work; before
 *  this the first buyer after every deploy paid it (3.9 s measured by an
 *  outside review, 2026-09-18). startCrawler schedules it 30 s after the
 *  warm start, past the post-listen stall. Idempotent: a built index is a
 *  no-op here, and a later mutation still drains on the next query. */
export function warmRouteIndex() { routeIndexSync({ sync: true }); return routeIdx.indexedTools; }
// A pool this small rebuilds inline (a few ms); a larger one rebuilds in the
// background, in slices, while the current index keeps answering.
const ROUTE_INDEX_INLINE_REBUILD_MAX_TOOLS = 20000;
const ROUTE_INDEX_SLICE_MS = 12;
// Every crawl cycle (30 min) replaces every entry, so the stale share passes
// its threshold three or four times per cycle. A synchronous rebuild of the
// prod pool is ~1 s here and 2 s+ on prod, and it ran INSIDE whichever buyer
// query tripped it - blocking every other request, payment relays included,
// for that long. The rebuild now runs as a shadow index filled in slices of
// ~12 ms between event-loop turns; queries keep reading the current index
// (its stale postings are filtered by liveness, as always) until the shadow
// is complete and swapped in.
function routeIndexStartShadow() {
  if (routeIdx.shadow) return;
  const shadow = { ...newRouteIndexShard(), entries: [...cache].filter(([, v]) => v && typeof v === "object"), i: 0, late: [], cur: null };
  routeIdx.shadow = shadow;
  const step = () => {
    if (routeIdx.shadow !== shadow) return; // reset or superseded
    const until = performance.now() + ROUTE_INDEX_SLICE_MS;
    while (performance.now() < until) {
      if (!shadow.cur) {
        if (shadow.i >= shadow.entries.length) break;
        const [origin, v] = shadow.entries[shadow.i++];
        if (cache.get(origin) !== v) continue;
        shadow.cur = { origin, v, pos: 0 };
      }
      const next = routeIndexAddEntry(shadow.cur.origin, shadow.cur.v, shadow, shadow.cur.pos, until);
      if (next === -1) shadow.cur = null; else { shadow.cur.pos = next; break; }
    }
    if (shadow.cur || shadow.i < shadow.entries.length) { setImmediate(step); return; }
    // Entries the current index took from `pending` while the shadow was
    // being filled were set after its snapshot: carry the live ones over.
    for (const [origin, v] of shadow.late) if (cache.get(origin) === v && !shadow.indexed.has(v)) routeIndexAddEntry(origin, v, shadow);
    let stale = 0;
    for (const [origin, v] of [...shadow.entries, ...shadow.late]) {
      if (shadow.indexed.has(v) && cache.get(origin) !== v) { stale += (remotePoolMemo.get(v) || []).length; shadow.indexed.delete(v); }
    }
    routeIdx.postings = shadow.postings;
    routeIdx.indexed = shadow.indexed;
    routeIdx.indexedTools = shadow.indexedTools;
    routeIdx.staleTools = stale;
    routeIdx.termCache.clear();
    routeIdx.shadow = null;
    routeIdx.builds++;
  };
  setImmediate(step);
}
function routeIndexSync({ sync = false } = {}) {
  const total = routeIdx.indexedTools + routeIdx.staleTools;
  if (routeIdx.staleTools > 0 && routeIdx.staleTools >= total * ROUTE_INDEX_REBUILD_STALE_SHARE) {
    if (sync || total <= ROUTE_INDEX_INLINE_REBUILD_MAX_TOOLS) {
      routeIndexReset();
      routeIdx.builds++;
      for (const [origin, v] of cache) if (v && typeof v === "object") routeIndexAddEntry(origin, v);
      return;
    }
    routeIndexStartShadow();
  }
  // A query finishes the live index's partly indexed entry first, so it never
  // ranks a seller with only some of its rows in the postings.
  if (routeIdx.partial) routeIndexAdvancePartial();
  if (!routeIdx.pending.size) return;
  for (const [origin, v] of routeIdx.pending) {
    if (cache.get(origin) !== v) continue; // replaced again before we got to it
    if (routeIdx.indexed.has(v)) continue; // already indexed (a swapped-in shadow took it)
    routeIndexAddEntry(origin, v);
    if (routeIdx.shadow) routeIdx.shadow.late.push([origin, v]);
  }
  routeIdx.pending.clear();
  routeIdx.termCache.clear(); // new vocabulary may match a cached term
}
/** Test hook: resolves once no background rebuild is in flight. */
export async function _routeIndexSettledForTest() {
  while (routeIdx.shadow) await new Promise((r) => setImmediate(r));
}
// Vocabulary tokens a term selects: itself for a short term (whole-token rule),
// every token containing it for a long one (substring rule). Candidate
// selection only has to be COMPLETE: scoreRow re-applies the exact rules to
// every candidate, so widening this (a short term as a substring) would cost
// time, never correctness - which is why no test can kill that mutation.
function routeIndexTokensFor(term, short) {
  if (short) return routeIdx.postings.has(term) ? [term] : [];
  const cached = routeIdx.termCache.get(term);
  if (cached) return cached;
  const out = [];
  for (const tok of routeIdx.postings.keys()) if (tok.includes(term)) out.push(tok);
  if (routeIdx.termCache.size >= ROUTE_INDEX_TERM_CACHE_MAX) routeIdx.termCache.clear();
  routeIdx.termCache.set(term, out);
  return out;
}
export function _routeIndexStatsForTest() {
  return { vocabulary: routeIdx.postings.size, indexedTools: routeIdx.indexedTools, staleTools: routeIdx.staleTools, pending: routeIdx.pending.size, builds: routeIdx.builds, rebuilding: !!routeIdx.shadow, partial: !!routeIdx.partial };
}

// The local pool is rebuilt from the catalog on every query (buildLocalEntry
// maps every catalog tool into a fresh row object), which made every local
// row a toolStatics MISS per query - 600 haystack builds and injection-regex
// passes per call. The catalog and price table are built once at boot and
// handed in by identity, so the pool is memoized on them like the remote
// pool is on its cache entry; any other input changing rebuilds it.
const localPoolMemo = new WeakMap(); // catalog -> { prices, baseUrl, walletName, network, toolCount, local, pool }
function localPoolFor(args) {
  const { catalog, prices, baseUrl, walletName, network, toolCount } = args;
  const memoable = catalog && typeof catalog === "object";
  // The key count is a belt for a catalog MUTATED in place (tests build one
  // and add to it; the server's is built once at boot): a new route changes
  // the count, and the pool is rebuilt rather than served stale.
  const keys = memoable ? Object.keys(catalog).length : 0;
  const m = memoable ? localPoolMemo.get(catalog) : null;
  if (m && m.keys === keys && m.prices === prices && m.baseUrl === baseUrl && m.walletName === walletName && m.network === network && m.toolCount === toolCount) return m;
  const local = buildLocalEntry(args);
  const pool = local.tools.map((t) => ({ ...t, sellerHome: baseUrl, sellerName: local.displayName, health: 1 }));
  const built = { keys, prices, baseUrl, walletName, network, toolCount, local, pool };
  if (memoable) localPoolMemo.set(catalog, built);
  return built;
}

// Most rows one /api/route answer carries. A ranking, so a ceiling is right;
// publishing it beside the rows is what stops the ceiling reading as the count.
export const ROUTE_TOP_MAX = 25;

// Words that carry no capability. They still SCORE (every rule below reads
// every term), but they do not SELECT candidates when the query has any other
// term: "to", "for" and "the" sit in most of the 110k+ descriptions ("for" and
// "the" by substring - format, forecast, ethereum), so selecting on them put
// tens of thousands of rows through scoring on every query, measured 0.5-3 s
// per /api/route on prod. A row that matches ONLY such words is not an answer
// to a task that names anything else. A query made of nothing but these words
// selects on all of them, as before.
const ROUTE_NONSELECTING_TERMS = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "at", "by", "and", "or", "with", "from", "into", "via", "as",
  "is", "are", "be", "it", "its", "this", "that", "i", "me", "my", "we", "our", "you", "your",
  "get", "do", "does", "can", "how", "what", "want", "need", "please", "some", "any", "all", "using", "use",
]);
// A caller that asks the same query several times in one synchronous turn
// (/api/route: its page, then a 50-row shortlist) passes one `scoredMemo`
// object to every call and the ranking is scored once. Scoped to the caller,
// so nothing a later request sees can be stale.
// routeQuery runs synchronously; routeQueryAsync runs the SAME steps and hands
// the event loop back every few milliseconds while it scores candidates. A
// query whose words are common in seller descriptions scores tens of thousands
// of rows, which held the thread 0.5-2 s on prod (2026-09-25); the free
// discovery surfaces use the async form so one such query no longer stalls
// every other request. Both drive routeQuerySteps, so their answers cannot
// differ. Yields happen only after candidates are collected from the index
// (collection stamps shared per-tool records and must not interleave).
export function routeQuery(args) {
  const steps = routeQuerySteps(args);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

const yieldToLoop = () => new Promise((r) => setImmediate(r));
// `onBusy(ms)` is called once per slice with the time that slice held the
// thread, so a caller's CPU budget is charged while the query runs, not only
// when it ends (a burst of queries would otherwise all pass a budget check
// that none of them had charged yet).
export async function routeQueryAsync(args, { sliceMs = 8, onBusy = null } = {}) {
  const steps = routeQuerySteps(args);
  let sliceStart = performance.now();
  let r = steps.next();
  while (!r.done) {
    const now = performance.now();
    if (now - sliceStart >= sliceMs) {
      if (onBusy) onBusy(now - sliceStart);
      await yieldToLoop();
      sliceStart = performance.now();
    }
    r = steps.next();
  }
  if (onBusy) onBusy(performance.now() - sliceStart);
  return r.value;
}

// Rows scored between chances to yield. Small enough that a slice overruns
// its budget by well under a millisecond, large enough that the generator
// hop is noise.
const ROUTE_SCORE_YIELD_ROWS = 256;
function* routeQuerySteps({ query, top, include, networkFilter, strictNetwork = false, baseUrl, catalog, prices, network, toolCount, walletName, scoredMemo = null }) {
  const q = String(query || "").slice(0, 500);
  // Unicode-aware (src/query-terms.js): a CJK query used to tokenize to
  // nothing and answer zero rows (reported from outside 2026-09-10).
  const terms = queryTerms(q, { max: 32 });
  const termSet = new Set(terms);
  // The ceiling has to announce itself. ?top=100 returned 25 rows with
  // `count: 25` and nothing else, so a caller reads "25 matched" where the truth
  // is "25 is our maximum" - the same silence that let a seller read one page of
  // /api/index as the whole index (2026-09-22). The leaderboard learned this on
  // 2026-08-28 (?top=1000 quietly served 50) and grew `truncated` +
  // `topRequested`; this surface never got the same treatment.
  const k = Math.min(Math.max(parseInt(top, 10) || 5, 1), ROUTE_TOP_MAX);
  const inc = VALID_INCLUDE.has(include) ? include : "all";
  // ?network=robinhood (or a raw CAIP-2) keeps only tools whose crawled 402
  // advertises that chain. Positive-signal filter: local tools and sellers
  // whose crawl source carries no accepts (networks unknown) are kept — the
  // filter is "exclude sellers known NOT to settle there", not a guarantee.
  const wantNet = networkFilter ? (ROUTE_NETWORKS[String(networkFilter).trim().toLowerCase()] || String(networkFilter).trim()) : null;
  // The same envelope on the empty answer: a consumer must not have to learn
  // one shape for a hit and another for a miss.
  if (!terms.length) return { query: q, count: 0, results: [], sellers: 0, sellersMatched: 0, include: inc, topMax: ROUTE_TOP_MAX, truncated: false, ...partialFields(0, 0), ...(wantNet ? { network: wantNet } : {}) };

  // Always include the local catalog (we trust ourselves), plus every crawled
  // seller's tools — but only from sellers whose last crawl succeeded. A buyer
  // routed to a currently-broken seller would just lose the call, so we'd
  // rather rank fewer trustworthy options than more flaky ones.
  const localRef = inc === "external" ? null : localPoolFor({ baseUrl, catalog, prices, network, toolCount, walletName });
  const localPool = localRef ? localRef.pool : [];
  const aliasOrigins = inc === "local" ? null : computeAliasOrigins(cache);
  // Same self-exclusion as indexSnapshot/routableSellerSummaries: the crawler
  // can discover and cache the real agent402.tools origin regardless of this
  // instance's own BASE_URL. Our own tools are already in localPool above -
  // without this, a crawled self-entry would additionally rank as a
  // duplicate "external" candidate, and a route-execute call against it
  // would pay our own wallet through the external-settlement path instead
  // of just running the local call directly.
  const selfBase = String(baseUrl || "").replace(/\/+$/, "").toLowerCase();
  const isSelfOrigin = (origin) => {
    const o = String(origin).replace(/\/+$/, "").toLowerCase();
    return (selfBase && o === selfBase) || o === "https://agent402.tools";
  };
  // The network filter is applied HERE, before scoring, so the k slots are
  // filled by rows that can actually settle on the wanted chain. Until
  // 2026-09-02 `wantNet` was computed, echoed in the response and never
  // applied: ?network=solana returned the same Base-dominated list as no
  // filter at all, and the Solana SOR branch (which asked for the top 20 and
  // then kept the Solana rows) found one or two survivors among twenty ties.
  // Default semantics are the documented positive-signal ones: a row whose
  // crawled 402 names other chains only is dropped; unknown networks (no
  // accepts seen) and local rows are kept. `strictNetwork` keeps ONLY rows
  // that advertise the chain - what a chain-matched spend needs, since it
  // will pay nobody whose 402 does not offer that rail.
  const netOk = (t) => {
    if (!wantNet) return true;
    const nets = Array.isArray(t.networks) ? t.networks.map((n) => String(n || "").toLowerCase()) : [];
    if (nets.length) return nets.includes(wantNet.toLowerCase());
    return !strictNetwork;
  };
  // A term under three characters matches whole tokens only: "ip" used to
  // substring-match gzip, gunzip and html-strip, which outranked every IP
  // tool for "ip geolocation" (2026-08-28). The predicate is decided ONCE per
  // term here (termMatcher's rule) and applied per candidate row below.
  // queryTerms already caps at 32; the literal bound here is for the static
  // analyser, which cannot see through it and reads the buyer's query as an
  // unbounded loop bound (CodeQL js/loop-bound-injection, 2026-09-18).
  const nTerms = Math.min(terms.length, 32);
  const shortTerm = Array.from({ length: nTerms }, (_, k) => !(terms[k].length >= 3 || isCjkTerm(terms[k])));
  const hitTerm = Array.from({ length: nTerms }, (_, k) => (shortTerm[k] ? wholeTokenMatcher(terms[k]) : (str) => str.includes(terms[k])));
  // Coinbase-measured 30-day unique payers per seller, read once per seller per
  // query instead of once per sort COMPARISON: on a pool where a common term
  // matches tens of thousands of rows, the comparator ran bazaarQualityFor()
  // (a regex + map read) hundreds of thousands of times per query.
  const selfQ = bazaarQualityFor(baseUrl) || bazaarQualityFor(SELF_BAZAAR_ORIGIN);
  const selfQuality = selfQ?.payers30d ?? null;
  const selfCurated = selfQ?.curated === true;
  const curatedBySeller = new Map();
  const curatedOf = (seller) => {
    let c = curatedBySeller.get(seller);
    if (c === undefined) { c = bazaarQualityFor(seller)?.curated === true; curatedBySeller.set(seller, c); }
    return c;
  };
  const payersBySeller = new Map();
  // Self-funded Bazaar counts never break a tie (rankingPayersOf above).
  const circular = getLeaderboardCircularWallets();
  const payersOf = (seller) => {
    let p = payersBySeller.get(seller);
    if (p === undefined) { p = rankingPayersOf(bazaarQualityFor(seller), circular.wallets); payersBySeller.set(seller, p); }
    return p;
  };
  const memoKey = scoredMemo ? JSON.stringify([q, inc, wantNet, !!strictNetwork, baseUrl, cacheVersion, circular.version]) : null;
  const memoHit = !!scoredMemo && scoredMemo.key === memoKey && scoredMemo.local === localRef;
  const scored = memoHit ? scoredMemo.scored : [];
  // The four text-match rules, per row. Same rules and weights as before the
  // candidate index; the index only decides which rows are worth asking.
  const scoreRow = (t) => {
    if (!netOk(t)) return;
    const st = toolStatics(t);
    if (st.injected) return;
    const { name, hay, names, nameToks } = st;
    let score = 0, mSlug = 0, mName = 0, mText = 0;
    // A slug (or alias) EVERY token of which appears in the query is an exact
    // match for each of those tokens, not a substring one. Before 2026-09-10 a
    // query "json diff" scored json-diff 4+4 on the slug while a one-token slug
    // "diff" took 10 for its one exact term, so a compound slug lost to any
    // single-word slug sharing one of its words - measured on 79 of our own
    // 585 tool names, and it bites every multi-word slug in the index the same
    // way. Neutral: any row's csv-to-json is fully covered by "csv to json" too.
    const covered = nameToks.map((toks) => toks.length > 1 && toks.every((tok) => termSet.has(tok)));
    for (let k = 0; k < nTerms; k++) {
      const term = terms[k], short = shortTerm[k], hit = hitTerm[k];
      let slugScore = 0;
      for (let i = 0; i < names.length && slugScore < 10; i++) {
        const n = names[i];
        let s = 0;
        if (n === term || (covered[i] && nameToks[i].includes(term))) s = 10;
        else if (short ? nameToks[i].includes(term) : n.includes(term)) s = 4;
        if (s > slugScore) slugScore = s;
      }
      if (slugScore) { score += slugScore; mSlug += slugScore; }
      if (hit(name)) { score += 2; mName += 2; }
      if (hit(hay)) { score += 1; mText += 1; }
    }
    // Record WHERE the score came from, not just how much. A seller who loses a
    // routing decision learns nothing from silence; "matched on description
    // only" tells them to fix their slug, and it makes the neutrality claim
    // checkable by anyone instead of merely stated (asked for in #645).
    if (score > 0) {
      const isLocal = t.seller === LOCAL_SELLER;
      scored.push([score, t, { slug: mSlug, name: mName, text: mText }, st.priceRank, isLocal, isLocal ? selfQuality : payersOf(t.seller), isLocal ? selfCurated : curatedOf(t.seller)]);
    }
  };
  // Local rows first (a few hundred; scanned outright), then the remote pool's
  // CANDIDATES in pool order - cache order, tool order within a seller - which
  // is the order the full scan used to push them in, so ties still resolve the
  // same way. A candidate is a tool whose entry is the LIVE one for its origin
  // (a stale posting from a replaced entry is skipped here) and whose seller
  // passes the same routable / alias / self filters as before.
  const selecting = Array.from({ length: nTerms }, (_, k) => !ROUTE_NONSELECTING_TERMS.has(terms[k]));
  if (!selecting.some(Boolean)) selecting.fill(true);
  if (!memoHit) for (const t of localPool) scoreRow(t);
  if (!memoHit && inc !== "local") {
    routeIndexSync();
    // Which entries are in the pool this query: the routable / alias / self
    // filters, decided once per ENTRY (a seller's 500 candidate rows used to
    // re-run them 500 times), and a per-query stamp on each tool's index
    // record dedupes a tool reached through several tokens.
    const stamp = ++routeIdx.queryStamp;
    const entryOk = new Map();
    const byEntry = new Map(); // live entry -> candidate tools (unordered)
    for (let k = 0; k < nTerms; k++) {
      if (!selecting[k]) continue;
      for (const tok of routeIndexTokensFor(terms[k], shortTerm[k])) {
        const list = routeIdx.postings.get(tok);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const home = t[TOOL_HOME];
          if (!home || home.stamp === stamp) continue;
          home.stamp = stamp;
          let ok = entryOk.get(home.v);
          if (ok === undefined) {
            // The liveness test is a BELT, not the load-bearing rule: rows are
            // emitted below by walking the cache's live entries, so a stale
            // posting (its entry replaced) can never be served whatever this
            // says - it is skipped here only to save the grouping work. The
            // rest is the same seller filter the full scan applied.
            ok = cache.get(home.origin) === home.v && isRoutable(home.v) && !aliasOrigins.has(home.origin) && !isSelfOrigin(home.origin);
            entryOk.set(home.v, ok);
          }
          if (!ok) continue;
          let arr = byEntry.get(home.v);
          if (!arr) byEntry.set(home.v, (arr = []));
          arr.push(t);
        }
      }
    }
    if (byEntry.size) {
      // Cache order is fixed here, before any yield: the async driver may let
      // a crawl write the cache between slices, and the order rows are pushed
      // in decides how ties resolve.
      const ordered = [];
      for (const v of cache.values()) {
        const arr = byEntry.get(v);
        if (!arr) continue;
        if (arr.length > 1) arr.sort((a, b) => a[TOOL_HOME].pos - b[TOOL_HOME].pos);
        ordered.push(arr);
      }
      let sinceYield = 0;
      for (const arr of ordered) {
        for (let i = 0; i < arr.length; i++) {
          scoreRow(arr[i]);
          if (++sinceYield >= ROUTE_SCORE_YIELD_ROWS) { sinceYield = 0; yield; }
        }
      }
    }
  }
  // Highest score first; healthier seller wins on ties; then cheapest KNOWN
  // price (unknown ranks last among equals — see priceRank); then shorter
  // slug. Health is the strongest tiebreak after score because a
  // cheap-but-flaky seller is worse than a slightly pricier reliable one.
  const tiebreak = (a, b) => {
    if (b[1].health !== a[1].health) return b[1].health - a[1].health;
    // Coinbase-measured 30-day unique payers (Bazaar quality): a seller more
    // wallets actually paid this month ranks ahead of an equally-matched,
    // equally-healthy one nobody has. A LOCAL row is measured under our own
    // Bazaar origin when the feed carries it; when it does not, the comparison
    // is SKIPPED for that pair (a missing measurement is not zero). Before
    // 2026-08-28 local rows read as zero payers, so any outside seller with
    // one Bazaar payer outranked our identical tool: json-to-csv sat 23rd on
    // our own router for "json to csv" behind twenty-two equally scored,
    // equally priced copies of it.
    if (a[4] || b[4]) {
      const qa = a[5], qb = b[5];
      if (qa != null && qb != null && qb !== qa) return qb - qa;
    } else {
      const qa = a[5] || 0, qb = b[5] || 0;
      if (qb !== qa) return qb - qa;
    }
    if (a[3] !== b[3]) return a[3] - b[3];
    // Bazaar-curated (Coinbase's editorial flag), only among rows equal on
    // match, health, payers AND price: it can order two equals, never lift a
    // seller over a better-matched, healthier, more-paid or cheaper one.
    if (a[6] !== b[6]) return a[6] ? -1 : 1;
    return (a[1].slug || "").length - (b[1].slug || "").length;
  };
  // ONE global sort over the whole scored array, deliberately. A bucket-per-
  // score sort with the tiebreak inside each bucket was tried (2026-09-18) and
  // moved rows: the local-vs-external payers branch above is not transitive
  // (a local row with no measurement compares equal to two external rows that
  // compare unequal to each other), so the order among such ties depends on
  // the comparison sequence, and a different array shape gives a different
  // sequence. Keeping the exact call the ranking was pinned on keeps the
  // published order byte-identical; the sort is a few ms of the query.
  if (!memoHit) {
    scored.sort((a, b) => (b[0] !== a[0] ? b[0] - a[0] : tiebreak(a, b)));
    if (scoredMemo) Object.assign(scoredMemo, { key: memoKey, scored, local: localRef });
  }

  // Per-seller diversity cap (M6, "Five Attacks on x402" Attack IV — Sybil /
  // metadata capture). Ranking is already sorted best-first; naively taking the
  // top k lets one seller (or a crafted Sybil listing set) monopolize the whole
  // shortlist — the paper measured a single domain owning 77.5% of a real
  // registry's results. We take at most `perSellerCap` entries per external
  // seller in a first pass, then backfill any remaining slots from the leftovers
  // so the shortlist is never shorter than it would have been. Our own local
  // catalog (LOCAL_SELLER) is exempt: it's one trusted seller by construction,
  // and capping it would perversely push buyers toward less-vetted externals.
  // Honest limit: a Sybil attacker spread across many *distinct* domains/wallets
  // still gets one slot each — that's the paper's open problem, not solved here.
  const perSellerCap = Math.max(1, Math.ceil(k / 3));
  const perSellerCount = new Map();
  const picked = [];
  const leftover = [];
  // The cap now applies to OUR catalog on the same terms as everyone else's.
  //
  // It used to exempt us, on the reasoning that capping the host would push
  // buyers toward less-vetted externals. Measured over 30 representative
  // queries at top=12, our catalog took 8.3% of slots and the exemption
  // actually bound on ONE query. It was buying us almost nothing and costing
  // the thing the endpoint is for, so it is gone.
  //
  // Skipped entirely for include=local, where there is only one seller by
  // definition and a per-seller cap would just truncate the answer to a third.
  const capApplies = inc !== "local";
  for (const entry of scored) {
    if (picked.length >= k) break;
    const seller = entry[1].seller;
    if (!capApplies) { picked.push(entry); continue; }
    const n = perSellerCount.get(seller) || 0;
    if (n < perSellerCap) { perSellerCount.set(seller, n + 1); picked.push(entry); }
    else leftover.push(entry);
  }
  // Backfill: if the cap left us short of k, take the best leftovers (still in
  // score order) so we never return fewer results than a plain top-k would.
  for (const entry of leftover) {
    if (picked.length >= k) break;
    picked.push(entry);
  }

  // WHO MATCHED, not who survived the cut. `sellersSeen` counts origins present
  // in THIS page and was the only seller number in the answer, so a caller
  // reading `sellers: 16` beside `count: 25` took 16 for the sellers that can
  // serve the task. The same misreading as the 250-of-4,473 index page, one
  // field over.
  const sellersScored = new Set(scored.map((e) => e[1].seller));
  // The diversity cap SUPPRESSES higher-scoring rows on purpose (a single
  // domain owned 77.5% of a real registry's results, which is why it exists).
  // That is a reordering the caller cannot see and would not expect from a
  // ranking, so it has to be stated: `leftover` is non-empty exactly when a row
  // was pushed down for its seller rather than for its score.
  const diversityCapped = capApplies && leftover.length > 0;
  const sellersSeen = new Set();
  let anyExternal = false;
  const results = picked.map(([score, t, matched, , , payers30d, curated]) => {
    sellersSeen.add(t.seller);
    // F09: name/description/sellerName on an EXTERNAL result are seller-
    // controlled text. Regex filtering + the diversity cap above are secondary
    // controls; the primary control is an explicit machine-readable marker so a
    // downstream selecting agent treats the copy as data to rank, never as an
    // instruction. Our own local catalog is trusted and unmarked.
    const external = t.seller !== LOCAL_SELLER;
    if (external) anyExternal = true;
    return {
      seller: t.seller,
      sellerHome: t.sellerHome,
      sellerName: t.sellerName,
      slug: t.slug,
      name: t.name,
      method: t.method,
      route: t.route,
      // The joined text as written (a template keeps its {param}); sellerRouteUrl
      // only validates it, since its URL-parsed form percent-encodes the braces.
      url: t.seller === LOCAL_SELLER ? `${baseUrl}${t.route}` : joinSellerRoute(t.seller, t.route),
      // A crawled OpenAPI path can carry template segments the seller never
      // substitutes ("/stock/{symbol}"). Handing an agent that URL as if it
      // were callable wastes its money and its time - measured 2026-08-28,
      // three of eight rows for "get a stock quote" were templates. We still
      // RETURN the row (the seller and the tool are real, and an agent that
      // knows the parameter can fill it), but we say so, and the SOR skips it.
      ...urlTemplateProjection(t),
      price: t.price,
      priceUsd: parsePrice(t.price),
      ...priceKnownProjection(t),
      ...priceConflictProjection(t),
      // "x402" = we have positive evidence this is payable in-protocol (a price,
      // or a registry accepts entry someone settled against). "unknown" = we
      // have none, which is NOT the same as "not payable" - see payabilityOf.
      // A buyer that intends to pay should prefer "x402"; a buyer that just
      // wants the capability can use either.
      payable: payabilityOf(t),
      // Coinbase-measured 30-day usage of this seller on the Bazaar (calls,
      // distinct payers, last call) - absent for our own rows and for sellers
      // the Bazaar does not list. A third-party measurement, shown as such.
      ...(external && bazaarQualityFor(t.seller) ? { bazaar: bazaarQualityFor(t.seller) } : {}),
      // Seller-declared response evidence, EXTERNAL rows only: our own catalog
      // is documented by us and a buyer does not need to be told what we
      // promise. Reporting only - it never re-ranks and never gates payment.
      ...(external ? responseContractProjection(t) : {}),
      // External rows only: our own catalog rows already carry a worked
      // `example`, and two descriptions of the same input that can disagree is
      // worse than one.
      ...(external ? requestContractProjection(t) : {}),
      ...(external ? deliveryProjection(t.seller, t.method, t.route) : {}),
      // The deciding factors, in the order the sort applies them, so a seller
      // who loses a routing decision can fix the actual reason.
      //
      // The first version of this comment claimed "no paid placement and no
      // operator thumb". The first half is true and the second was not: we host
      // this index and we sell on it, and three rules favour our own catalog.
      // They are disclosed in `neutrality` on the response rather than left for
      // a seller to find in the source. A claim nobody can check is worth less
      // than a smaller claim anyone can.
      why: {
        score,
        matchedOn: matched || null,
        health: t.health,
        // Our own health is ASSERTED, not measured: the crawler never probes
        // itself, so a local row is always 1 while an external row carries a
        // score derived from real crawl outcomes. Health is the first tiebreak
        // after score, so saying which kind of number this is matters.
        healthSource: external ? "crawl" : "self-asserted",
        priceRank: (() => { const r = priceRank(t.price); return Number.isFinite(r) ? r : null; })(),
        // The two Bazaar-measured tiebreak inputs this row was sorted on (null
        // payers = no measurement, which the sort skips rather than reading as 0).
        bazaarPayers30d: Number.isFinite(payers30d) ? payers30d : null,
        bazaarCurated: curated === true,
        // The order the sort applies, from src/route-order.js (pinned to the
        // comparator by test-route-order.js).
        tiebreaks: routeTiebreakLabels(),
      },
      category: t.category,
      description: t.description,
      score,
      health: t.health,
      ...(Array.isArray(t.networks) && t.networks.length ? { networks: t.networks } : {}),
      // Says when those networks were inherited from the seller rather than
      // observed on this route's own 402 (see decoratedRemoteTools).
      ...(t.networksInferred ? { networksInferred: true } : {}),
      // The EIP-712 domain each EVM accept advertised (asset + name), so the
      // dispatch label can refuse a Base accept no stock buyer can sign.
      ...(t.evmDomainByNetwork && Object.keys(t.evmDomainByNetwork).length ? { evmDomainByNetwork: t.evmDomainByNetwork } : {}),
      // Quote-guided execution: tell the buyer exactly which route-execute tier
      // runs this result and what to pay (x402 is fixed-price, so the buyer must
      // pick the tier that covers the tool's underlying price). null = above the
      // top tier; call it directly. This is what makes "find then execute" one
      // obvious step instead of a guess.
      ...(routeExecuteHint(parsePrice(t.price)) ? { executeVia: routeExecuteHint(parsePrice(t.price)) } : {}),
      ...(external ? { untrustedContent: true, source: t.seller } : {}),
    };
  });
  return {
    query: q, include: inc, count: results.length, sellers: sellersSeen.size, results,
    // `count` and `sellers` keep their exact meaning and their exact values -
    // renaming a live field is a second, worse break. These ride alongside.
    ...partialFields(scored.length, results.length),
    ...clampFields(top, ROUTE_TOP_MAX, "top"),
    sellersMatched: sellersScored.size,
    ...(diversityCapped ? {
      diversityCapped: true,
      perSellerCap,
      diversityNote: `at most ${perSellerCap} rows per seller in the first pass, so a higher-scoring row from a seller already at the cap can rank below a lower-scoring row from another seller - raise ?top to raise the cap`,
    } : {}),
    // `count` is what THIS answer carries, never what matched. A caller that
    // asked for more than the ceiling must be able to tell the two apart:
    // topMax is the ceiling, truncated says the ranking was cut by it.
    topMax: ROUTE_TOP_MAX,
    truncated: picked.length >= k && scored.length > picked.length,
    // We run this index and we also sell on it. Rather than assert neutrality,
    // publish the parts that are literally true and the parts where the host
    // has an edge, so anyone can check both against the source.
    //
    // Nobody can buy rank here: there is no paid placement, no sponsored slot,
    // and no seller-keyed term anywhere in the scoring function - it is four
    // text-match rules over the seller's own slug, name and description. That
    // part needs no qualification.
    //
    // The three advantages below are real, deliberate, and ours. Listing them
    // costs less than having a seller find them in the open source and conclude
    // the rest was oversold too.
    neutrality: {
      paidPlacement: false,
      sellerKeyedScoring: false,
      ranking: "deterministic lexical match on slug, name and description; ties broken by health, then cheapest known price, then shorter slug",
      // Was three entries. Two were removed rather than disclosed: the
      // per-seller diversity cap now applies to our catalog on the same terms
      // as everyone else's (measured cost of giving it up: it bound on 1 of 30
      // representative queries), and the listing-injection filter now runs
      // against our rows too. Fixing an asymmetry beats publishing it.
      //
      // The one that remains is real and we cannot honestly remove it: the
      // crawler never probes itself, so there is no measured health for our own
      // rows the way there is for a crawled seller. Every result carries
      // why.healthSource so an asserted 1 is never mistaken for a measured one.
      hostAdvantages: [
        "our own health is self-asserted as 1 because the crawler never probes itself; external health is measured from crawl outcomes. Every result reports why.healthSource so the two are distinguishable",
      ],
      excludeHost: 'include=external removes our catalog from the ranking entirely',
      source: REPO_URL,
    },
    ...(anyExternal ? { containsUntrustedContent: true } : {}),
    ...(wantNet ? { network: wantNet } : {}),
  };
}

// "The economy, over time" — folded in from the two old standalone economy
// pages (/x402-economy and /economy, both now 301s to /index#economy).
// Renders (a) the daily settlement history + week-over-week trend from
// x402EconomySnapshot(), and (b) the 24h ecosystem summary (concentration +
// network split) from the leaderboard snapshot via summarize() — the parts
// /leaderboard itself doesn't show. The per-seller top lists from both old
// pages were NOT ported since /leaderboard already ranks sellers.
// Pure function of its snapshots so it's unit-testable without a server.
const econFmt = (n) => Number(n || 0).toLocaleString("en-US");

// 24h ecosystem summary sub-block (from the old /economy page). Renders
// nothing when the leaderboard snapshot is warming — the section's on-chain
// history above still carries it, no fabricated zeros.
function economy24hHtml(leaderboardSnap) {
  if (leaderboardSnap?.warming || !leaderboardSnap?.leaderboard?.length) return "";
  const s = summarize(rankBy(leaderboardSnap.leaderboard, "usd"), "usd");
  const windowLabel = leaderboardSnap.windowLabel || "24h";
  const networkBars = s.networks
    .map(
      (n) => `<div class="econ-net-row"><span>${esc(n.net)}</span><span class="econ-net-val">${fmtUsd(n.usd)} &middot; ${fmtPct(n.share)}</span></div>
      <div class="econ-net-bar"><div style="width:${Math.max(2, Math.min(100, n.share))}%"></div></div>`
    )
    .join("");
  return `
    <h3 class="econ-h3">Last ${esc(windowLabel)} across the ecosystem</h3>
    <p class="pn" style="margin:0 0 14px;">Per-call USDC settled across every public x402 seller our crawler can see, from on-chain Base transfers ($0.50 per-call ceiling filters out funding moves). Refreshes hourly. Full ranking: <a href="/leaderboard">/leaderboard</a>; machine-readable: <a href="/api/leaderboard">/api/leaderboard</a>.</p>
    <div class="grid" style="margin:0 0 14px;">
      <div class="stat"><div class="k">Total volume</div><div class="v">${fmtUsd(s.total)}</div><div class="s">across ${econFmt(s.activeSellers)} active sellers</div></div>
      <div class="stat"><div class="k">Total calls</div><div class="v">${econFmt(s.totalCalls)}</div><div class="s">avg ${fmtUsd(s.avgCallUsd)} per call</div></div>
      <div class="stat"><div class="k">Top-5 share</div><div class="v">${fmtPct(s.top5Share)}</div><div class="s">top-1 ${fmtPct(s.top1Share)} &middot; top-10 ${fmtPct(s.top10Share)}</div></div>
      <div class="stat"><div class="k">Networks</div><div class="v">${s.networks.length}</div><div class="s">chains with volume</div></div>
    </div>
    <div class="econ-nets">${networkBars}</div>`;
}

export function economySectionHtml(snap, leaderboardSnap) {
  const day = economy24hHtml(leaderboardSnap);
  const unavailable = !snap || (snap.errors?.length && !(snap.daily || []).length);
  if (unavailable) {
    return `<div class="panel" id="economy">
  <div class="ph"><h2>The economy, over time</h2><div class="pn">Chain-wide gasless USDC settlement history on Base.</div></div>
  <div style="padding:14px 18px;"><div class="econ-warm">economy history unavailable right now (detail in <a href="/api/x402-economy">/api/x402-economy</a>)</div>${day}</div>
</div>`;
  }
  const t7 = snap.totals?.last7d || { settlements: 0, volumeUsd: 0, payers: 0 };
  const t30 = snap.totals?.last30d || { settlements: 0 };
  const daily = snap.daily || [];
  const maxSett = Math.max(1, ...daily.map((d) => d.settlements));
  const weekly = snap.weekly;
  const weeklyLine = weekly?.growthPct != null && weekly.lastWeek.days === 7
    ? `<p class="pn" style="margin:0 0 14px;">week over week: <strong style="color:${weekly.growthPct >= 0 ? "var(--accent)" : "var(--ink)"};">${weekly.growthPct >= 0 ? "+" : ""}${weekly.growthPct}%</strong> settlements (${econFmt(weekly.thisWeek.settlements)} vs ${econFmt(weekly.lastWeek.settlements)} the week before - complete days only)</p>`
    : `<p class="pn" style="margin:0 0 14px;">week-over-week trend unlocks once two full weeks of history accumulate (${weekly?.historyDays ?? 0} days recorded so far)</p>`;
  const bars = daily
    .map(
      (d) => `<div class="econ-bar-row">
        <span class="econ-bar-day">${esc(d.day)}</span>
        <span class="econ-bar-track" style="width:${Math.max(1, Math.round((d.settlements / maxSett) * 100))}%;"></span>
        <span>${econFmt(d.settlements)} settlements &middot; ${econFmt(d.payers)} payers</span>
      </div>`
    )
    .join("");
  return `<div class="panel" id="economy">
  <div class="ph">
    <h2>The economy, over time</h2>
    <div class="pn">Every gasless EIP-3009 USDC settlement on Base - the primitive x402 uses - counted chain-wide across every seller, not just Agent402's own catalog. Machine-readable at <a href="/api/x402-economy">/api/x402-economy</a>; same query any agent can buy as <a href="/tools/onchain-sql">onchain-sql</a> for $0.02.</div>
  </div>
  <div style="padding:14px 18px;">
    <div class="grid" style="margin:0 0 14px;">
      <div class="stat"><div class="k">Settlements 7d</div><div class="v">${econFmt(t7.settlements)}</div></div>
      <div class="stat"><div class="k">Volume 7d</div><div class="v">$${econFmt(t7.volumeUsd)}</div></div>
      <div class="stat"><div class="k">Unique payers 7d</div><div class="v">${econFmt(t7.payers)}</div></div>
      <div class="stat"><div class="k">Settlements 30d</div><div class="v">${econFmt(t30.settlements)}</div></div>
    </div>
    ${weeklyLine}
    <div class="econ-bars">${bars || `<div class="pn">no daily history recorded yet</div>`}</div>
    ${day}
  </div>
</div>`;
}

// REMOVED 2026-08-24: `indexPage` (a ~340-line HTML dashboard) and its only
// caller-side helper `leaderboardHostIndex`. Nothing mounted either one -
// `/index` has 301'd to `/marketplace` for a long time and that page renders
// through `marketPage` in src/market-page.js. They were nonetheless covered by
// scripts/test-index-page.js, 40 assertions that passed on every run while
// proving nothing about anything a visitor could reach.
//
// That is not a tidiness complaint. Writing the crawl-cadence guard, the dead
// renderer is the file the cadence copy was found in, so the guard was aimed
// at it and MISSED src/market-page.js entirely - the live one. Dead code that
// still looks alive misdirects the next person, and here it misdirected a
// safety check away from the surface it existed to protect.
//
// Recover from git history if a standalone index dashboard is ever wanted.


/** Internal helper for tests. */
/** Counts only (no values): how much crawl data the index holds, for the
 *  operator heap read. Walks entries once; no stringify. */
export function indexMemoryFigures() {
  let entries = 0, tools = 0, openapiTools = 0, openapiRoutes = 0, fullManifests = 0, manifestResources = 0, slimManifests = 0;
  for (const v of cache.values()) {
    if (!v || typeof v !== "object") continue;
    entries++;
    tools += Array.isArray(v.tools) ? v.tools.length : 0;
    openapiTools += Array.isArray(v.openapiTools) ? v.openapiTools.length : 0;
    openapiRoutes += Array.isArray(v.openapiRoutes) ? v.openapiRoutes.length : 0;
    if (v.manifest?.slimmed) slimManifests++;
    else if (v.manifest && typeof v.manifest === "object") {
      fullManifests++;
      const r = v.manifest.resources || v.manifest.endpoints || v.manifest.tools;
      if (Array.isArray(r)) manifestResources += r.length;
    }
  }
  return { entries, tools, openapiTools, openapiRoutes, fullManifests, slimManifests, manifestResources, internedTokens: tokenIntern.size, routeIndexedTools: routeIdx.indexedTools };
}
export function _cacheForTests() {
  return cache;
}

/** The RAW crawl entry for one origin or bare host (the object sellerDetail
 *  projects from), for readers that need the per-tool provenance stamps the
 *  projection drops: quoteSource, quoteObservedAt, quoteCarriedForward,
 *  originDeclaredPrice, priceResolvedFrom, networksVerifiedAt, methodInferred,
 *  methodCorrectedFrom. Read-only by convention: callers must not mutate it.
 *  null when the origin was never crawled. */
/** Every crawled seller's own tool rows, keyed by origin, raw.
 *
 *  For the dated dataset snapshot (src/dataset-snapshot.js), which needs the
 *  per-route price provenance that the /api/index seller projection drops.
 *  It hands over everything and makes NO publishing decision: the snapshot's
 *  column allowlist is the single place that decides what is published, so
 *  there is only one file to read to answer "what goes out". */
export function crawlToolsByOrigin() {
  const out = new Map();
  for (const [origin, v] of cache.entries()) out.set(origin, Array.isArray(v.tools) ? v.tools : []);
  return out;
}

/** Every routable outside seller's buy candidates, under the router's own
 *  seller filter (routable, not an alias or superseded origin, not this host,
 *  not removed at the owner's request). A generator, so the decision index
 *  export can yield between entries instead of holding the loop. */
export function* routableRemoteEntries({ baseUrl = "" } = {}) {
  const aliases = computeAliasOrigins(cache);
  const selfBase = String(baseUrl || "").replace(/\/+$/, "").toLowerCase();
  const isSelf = (origin) => {
    const o = String(origin).replace(/\/+$/, "").toLowerCase();
    return (selfBase && o === selfBase) || o === "https://agent402.tools";
  };
  for (const [origin, v] of cache) {
    if (!v || typeof v !== "object" || !isRoutable(v) || aliases.has(origin) || isSelf(origin) || isRemovedOrigin(origin)) continue;
    yield [origin, decoratedRemoteTools(v)];
  }
}

export function sellerEntry(originOrHost) {
  const origin = findSellerKey(originOrHost);
  return origin ? { origin, ...cache.get(origin) } : null;
}

/**
 * The cache key a lookup names: an exact key (scheme optional, trailing slash
 * ignored, case-insensitive), or a bare host. A host names its bare-origin
 * seller when it has one; with only path sellers on it, the first of them. A
 * lookup carrying a path names exactly that path seller and nothing else.
 */
export function findSellerKey(originOrHost) {
  // 512, not 253: a path seller's key is host plus a prefix of up to
  // SELLER_PREFIX_MAX_CHARS characters.
  const q = String(originOrHost || "").trim().toLowerCase().slice(0, 512).replace(/\/+$/, "");
  if (!q) return null;
  const noScheme = (s) => s.replace(/^https?:\/\//, "");
  const hasScheme = /^https?:\/\//.test(q);
  const qBare = noScheme(q);
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
  let hostHit = null;
  for (const origin of cache.keys()) {
    const k = origin.toLowerCase();
    if (hasScheme ? k === q : noScheme(k) === qBare) return origin;
    if (hostOf(origin) === qBare && (!hostHit || (sellerPrefixOf(hostHit) && !sellerPrefixOf(origin)))) hostHit = origin;
  }
  return qBare.includes("/") ? null : hostHit;
}

// ---------------------------------------------------------------------------
// Third-party tool catalog (/marketplace/tools)
// ---------------------------------------------------------------------------

/**
 * Every tool the crawler holds for a THIRD-PARTY seller, flattened for browsing.
 *
 * These are not our tools and carry none of our guarantees. Our own catalog is
 * tested against each tool's documented example on every deploy and priced by
 * us; these are endpoints other people operate, described in their own words.
 * `described` is surfaced per row rather than filtered on, because roughly two
 * thirds of the ecosystem publishes no description at all (PayAI's discovery
 * records carry only a URL, method and price) and hiding them would misrepresent
 * how much of the index is actually legible.
 *
 * Every string here is seller-supplied and therefore untrusted: render it as
 * escaped text, never as markup, and never as instructions to an agent.
 *
 * Sellers are limited to https origins that the crawler currently scores as
 * reachable — the same bar /api/index/register enforces on the way in, so the
 * catalog cannot advertise something registration would have refused.
 */
// A directory search built each row's lowercase search text on every request
// (112k rows: ~120 ms per search locally). Rows are rebuilt, never mutated, so
// the text is kept per row object.
// A symbol key: never serialized, and a WeakMap over 112k rows measured slower
// than the rebuild it saves.
const DIRECTORY_HAY = Symbol("directoryHay");
function directoryHayOf(t) {
  let h = t[DIRECTORY_HAY];
  if (h === undefined) { h = `${t.name} ${t.description} ${t.route} ${t.sellerName} ${(t.tags || []).join(" ")}`.toLowerCase(); t[DIRECTORY_HAY] = h; }
  return h;
}
export function allIndexedTools({ search = "", category = "", network = "", offset = 0, limit = 100, excludeOrigin = "", ourTools = [], source = "" } = {}) {
  // One index of the whole ecosystem WITH provenance on every row. Ours are
  // NOT floated to the top: 515 of them would fill the first six pages and bury
  // the third-party index this page exists to show, which would read as a
  // directory that is mostly an advert. Provenance is carried by the badge and
  // the row tint instead, and anyone who wants only ours has the source filter
  // and /tools. Described rows lead, because a row with no description cannot
  // help anyone choose. `excludeOrigin` still drops our crawled self-listing
  // (we publish to the Bazaar, so the crawler finds us) so ours appear exactly
  // once, from the authoritative catalog rather than a stale crawl of it.
  const rows = interleavedIndexRows(ourTools, excludeOrigin);
  const q = String(search || "").trim().toLowerCase();
  const terms = q ? queryTerms(q, { max: 8 }) : [];
  const cat = String(category || "").trim().toLowerCase();
  const net = String(network || "").trim().toLowerCase();

  const src = String(source || "").trim().toLowerCase();
  const filtered = !terms.length && !cat && !net && !src ? rows : rows.filter((t) => {
    if (src === "ours" && !t.ours) return false;
    if (src === "third-party" && t.ours) return false;
    if (cat && String(t.category || "").toLowerCase() !== cat) return false;
    if (net && !(t.networks || []).some((n) => String(n).toLowerCase().includes(net))) return false;
    if (!terms.length) return true;
    const hay = directoryHayOf(t);
    return terms.every((term) => hay.includes(term));
  });

  const off = Math.max(0, parseInt(offset, 10) || 0);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  return {
    total: rows.length,
    ours: rows.oursCount,
    thirdParty: rows.length - rows.oursCount,
    matched: filtered.length,
    offset: off,
    limit: lim,
    described: filtered.filter((t) => t.described).length,
    results: filtered.slice(off, off + lim),
  };
}

// The flattened, interleaved directory, rebuilt only when the crawl cache has
// changed (at most every 2 min while a crawl is replacing entries).
// /marketplace/tools and /api/index/tools rebuilt it on EVERY page request:
// the production stall profiler measured 1.4 s per build (2026-09-25), and a
// crawler walking the pages paid it per page. Only the filter and the slice
// run per request now.
let indexRowsMemo = { key: null, at: 0, rows: null };
// A directory this small rebuilds inline (a few ms); a larger one is served
// stale while a background rebuild runs in slices (the production build was
// 1.5-1.8 s of one synchronous turn, 2026-09-25).
const INDEX_ROWS_INLINE_MAX = 20000;
let indexRowsRebuild = null;
function interleavedIndexRows(ourTools, excludeOrigin) {
  const now = Date.now();
  const key = `${excludeOrigin}|${ourTools.length}`;
  const m = indexRowsMemo;
  // Unchanged cache: reuse for up to 5 min (Bazaar rows can change without a
  // cache write). Mid-crawl: reuse for up to 2 min whatever the version says.
  if (m.rows && m.key === key && ((m.version === cacheVersion && now - m.at < 300_000) || (crawlInFlight && now - m.at < 120_000))) return m.rows;
  if (m.rows && m.key === key && m.rows.length > INDEX_ROWS_INLINE_MAX) {
    if (!indexRowsRebuild) {
      const version = cacheVersion;
      indexRowsRebuild = (async () => {
        try {
          const flat = await flattenedThirdPartyToolsAsync(excludeOrigin);
          await yieldTurn();
          const rows = interleaveBySeller([...ourTools, ...flat]);
          rows.oursCount = rows.filter((t) => t.ours).length;
          if (indexRowsMemo === m) indexRowsMemo = { key, at: Date.now(), rows, version };
        } catch (e) {
          console.warn(`[x402-index] directory rebuild failed: ${String(e?.message || e).slice(0, 120)}`);
        } finally { indexRowsRebuild = null; }
      })();
    }
    return m.rows;
  }
  const rows = interleaveBySeller([...ourTools, ...flattenedThirdPartyTools(excludeOrigin)]);
  rows.oursCount = rows.filter((t) => t.ours).length;
  indexRowsMemo = { key, at: now, rows, version: cacheVersion };
  return rows;
}
const yieldTurn = () => new Promise((r) => setImmediate(r));
/** Test hook: wait for an in-flight background directory rebuild. */
export async function _indexRowsSettledForTest() { while (indexRowsRebuild || flatRebuild) await (indexRowsRebuild || flatRebuild); }

/** Round-robin the rows across sellers, described first.
 *
 *  A directory sorted by seller name shows one seller's entire catalog before
 *  the next one starts, which for us meant our own 500-odd tools filling the
 *  first six pages of a page titled "Every tool, indexed" — accurate row by row
 *  and misleading as a whole. Interleaving means page one is ~100 different
 *  sellers rather than one, ours included and badged. Deterministic, so the
 *  pagination stays stable and cacheable.
 *
 *  Described rows lead: a row with no description cannot help anyone choose,
 *  so those sink rather than being hidden. */
// One collator instead of String#localeCompare per comparison: same order,
// a fraction of the cost on a 100k-row sort.
const collate = new Intl.Collator().compare;
function interleaveBySeller(rows) {
  const pass = (subset) => {
    const bySeller = new Map();
    for (const r of subset) {
      const k = r.sellerName || r.seller;
      if (!bySeller.has(k)) bySeller.set(k, []);
      bySeller.get(k).push(r);
    }
    const groups = [...bySeller.entries()]
      .sort((a, b) => collate(String(a[0]), String(b[0])))
      .map(([, list]) => list.sort((a, b) => collate(String(a.route), String(b.route))));
    const out = [];
    for (let i = 0; out.length < subset.length; i++) {
      let moved = false;
      for (const g of groups) {
        if (i < g.length) { out.push(g[i]); moved = true; }
      }
      if (!moved) break; // defensive: never spin if a group shrinks underneath us
    }
    return out;
  };
  return [...pass(rows.filter((r) => r.described)), ...pass(rows.filter((r) => !r.described))];
}

function flatRowsForEntry(origin, v, self, seen, out) {
  if (!origin.startsWith("https:")) return; // same bar as /api/index/register
  const normOrigin = origin.replace(/\/+$/, "").toLowerCase();
  if (self && normOrigin === self) return;
  if (normOrigin === "https://agent402.tools") return;
  if (v?.error) return;
  if (healthScore(v) <= 0) return;
  const sellerName = v?.manifest?.name || origin.replace(/^https?:\/\//, "");
  for (const t of v?.tools || []) {
    const route = t?.route || "/";
    const key = `${t?.method || "POST"} ${origin}${route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const description = String(t?.description || "").trim();
    out.push({
      ours: false,
      seller: origin,
      sellerName,
      name: String(t?.name || route),
      route,
      method: t?.method || "POST",
      url: origin + route,
      description,
      described: description.length >= 12,
      category: t?.category || "other",
      tags: Array.isArray(t?.tags) ? t.tags.slice(0, 6) : [],
      // Was `typeof t.price === "number" ? t.price : null`, which silently
      // nulled every price stored as a string - and manifest and llms.txt
      // catalogues store them as "$0.002". parsePrice is what every other
      // surface uses; using a different rule here made the same tool look
      // priced on /api/route and unpriced on /api/index/tools.
      priceUsd: parsePrice(t?.price),
      // Both spellings, deliberately. /api/route served `price` and
      // `priceUsd`, this surface served only `priceUsd`, and /api/find served
      // only `price`. A consumer that learned one surface got `undefined` on
      // the next and could not tell it from "no price" - which is exactly how
      // a measurement taken during this audit came out wrong.
      price: t?.price ?? null,
      ...priceKnownProjection(t),
    ...priceConflictProjection(t),
      // The identifier a caller needs to actually invoke the tool. Present on
      // /api/route and /api/find, missing here, on the surface that lists all
      // 65k third-party rows.
      slug: t?.slug || null,
      // Added to /api/route earlier today and to nothing else, which is the
      // inert-field defect this file's own header warns about, committed the
      // same afternoon as a fix for it. It belongs wherever a tool row is
      // served.
      payable: payabilityOf(t),
      // Same evidence as seller detail and /api/route. Added to all three at
      // once on purpose - this file's own header records shipping a field on
      // two of three surfaces twice, where it is inert on whichever one the
      // caller happens to read.
      ...responseContractProjection(t),
      ...requestContractProjection(t),
      // The loop's own origin/route, which are what this surface keys on -
      // t.seller is not set on every row source.
      ...deliveryProjection(origin, t?.method, route),
      networks: Array.isArray(t?.networks) ? t.networks : [],
    });
  }
  }

let flatCache = { at: 0, rows: [], self: "" };
const FLAT_TTL_MS = 60_000;

/** Flatten + dedupe the crawler's per-seller tool arrays. Cached for a minute:
 *  the catalog is a read-heavy page and the underlying crawl moves on the order
 *  of minutes, so rebuilding per request would be pure waste. */
function flattenedThirdPartyTools(excludeOrigin = "") {
  // We publish our own routes to the Bazaar, so the crawler discovers
  // agent402.tools as just another seller and our tools would otherwise appear
  // in a catalog whose entire premise is "these are NOT ours". Keyed on the
  // caller-supplied origin because the index module has no BASE_URL of its own.
  //
  // That excludeOrigin match is NOT enough by itself: it only excludes the
  // crawled self-entry when it matches the CURRENT server instance's own
  // BASE_URL exactly. In real production BASE_URL is set to the real domain
  // so the two agree, but the crawler runs (and can discover the real,
  // publicly-registered agent402.tools origin) in ANY environment regardless
  // of that instance's own BASE_URL - a CI test server, a local dev boot, or
  // a preview deploy all have BASE_URL pointing at localhost or a preview
  // hostname while the crawl can still reach and cache the real production
  // origin. Measured live: X402_SYNC_ON_START=false does not stop the
  // background crawl from running, so a CI/local boot with a mismatched
  // BASE_URL genuinely lists agent402.tools as a "third-party" seller of its
  // own tools within about a minute. Excluding the real, permanent domain by
  // name as a second, hardcoded check closes that regardless of which
  // BASE_URL any given instance happens to be configured with.
  const self = String(excludeOrigin || "").replace(/\/+$/, "").toLowerCase();
  if (flatCache.self !== self) flatCache = { at: 0, rows: [], self };
  if (Date.now() - flatCache.at < FLAT_TTL_MS && flatCache.rows.length) return flatCache.rows;
  if (flatCache.self === self && flatCache.rows.length > INDEX_ROWS_INLINE_MAX) {
    // Large and stale: serve it and rebuild in the background.
    flattenedThirdPartyToolsAsync(excludeOrigin);
    return flatCache.rows;
  }
  const out = [];
  const seen = new Set();
  for (const [origin, v] of cache.entries()) flatRowsForEntry(origin, v, self, seen, out);
  return finishFlat(out, self);
}
function finishFlat(out, self) {
  // No sort: every consumer groups or counts (interleaveBySeller orders the
  // rows itself), and a 100k-row sort was most of a rebuild's longest turn.
  flatCache = { at: Date.now(), rows: out, self };
  return out;
}
// The same flatten, yielding the event loop every few milliseconds.
let flatRebuild = null;
function flattenedThirdPartyToolsAsync(excludeOrigin = "") {
  if (flatRebuild) return flatRebuild;
  const self = String(excludeOrigin || "").replace(/\/+$/, "").toLowerCase();
  flatRebuild = (async () => {
    try {
      const out = [];
      const seen = new Set();
      let until = performance.now() + 8;
      for (const [origin, v] of [...cache.entries()]) {
        flatRowsForEntry(origin, v, self, seen, out);
        if (performance.now() >= until) { await yieldTurn(); until = performance.now() + 8; }
      }
      await yieldTurn();
      return finishFlat(out, self);
    } finally { flatRebuild = null; }
  })();
  return flatRebuild;
}


/** Category rollup for the catalog's filter chips. */
export function indexedToolCategories(excludeOrigin = "") {
  const counts = new Map();
  for (const t of flattenedThirdPartyTools(excludeOrigin)) counts.set(t.category, (counts.get(t.category) || 0) + 1);
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

export function _resetFlatCacheForTest() { flatCache = { at: 0, rows: [], self: "" }; }
export function _resetIndexRowsForTest() { indexRowsMemo = { key: null, at: 0, rows: null }; }
// KNOWN ROUTER LIMITATION (found 2026-09-01): the resolver's
// liveness probe sends an empty `{}` and treats only HTTP 402 as "live". A
// seller that VALIDATES the request body BEFORE issuing its 402 (returning
// 400/422 with no challenge on an empty body) therefore fails the probe and
// is never routed to, even though it is a perfectly good paid endpoint - its
// GET-shaped siblings resolve fine. One seller's /chat/completions is the
// live example (400 on {}, no payment-required header to distinguish it from
// a genuine bad request). Fixing this needs a probe that sends a
// shape-plausible body per the tool's input schema, or a seller convention
// of 402-before-validate; deferred as its own change, not bolted onto the
// Solana-rail work. Tracked here so the next reader does not re-discover it.
