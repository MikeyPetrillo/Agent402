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
import { readFileSync, writeFileSync } from "node:fs";
import { timedSync } from "./boot-timing.js";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
// F23: seller-manifest homepages are external, attacker-controlled URLs. esc()
// escapes HTML but does NOT constrain the scheme, so a `javascript:`/`data:`
// homepage would become a clickable link if the legacy indexPage renderer is
// ever re-enabled. Only http(s) becomes a link; anything else renders inert.
const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");
import { safeFetch } from "./tools/fetch-guard.js";
import { parseRobots, robotsAllows } from "./tools/kit.js";
import { responseContractOf, packResponseContract, responseContractProjection } from "./response-contract.js";
import { deliveryProjection } from "./response-observation.js";
import { requestContractOf, packRequestContract, requestContractProjection } from "./request-contract.js";
import { toolList } from "./pages.js";
import { fetchAllBazaarItems, isBazaarDiscoveryUrl } from "./bazaar-pager.js";
import { RAILS, railKey, truncateCaip2 } from "./rails.js";
import { CHAIN_PAGES, marketSellers } from "./market-page.js";
import { WELL_KNOWN_PATH, discoveryNote } from "./discovery-note.js";
import { acceptsFromLive402, quoteFromAccepts, probeMethodsFor, isQuoteResponse } from "./x402-live-quote.js";
import { summarize, fmtUsd, fmtPct } from "./economy.js";
import { rankBy, canonicalHost, getLeaderboardSnapshot } from "./leaderboard.js";
import { routeExecuteHint } from "./tools/route-execute.js";
import { recordSellerRegistrationSeen, getSellerRegistrations } from "./stats.js";
import { verifiedListEnabled, routeOnVerifiedList, startVerifiedListRefresh, stopVerifiedListRefresh } from "./verified-list.js";

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
const CRAWL_INTERVAL_MS = 30 * 60 * 1000; // 30 min — gentle on third-party sellers
const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hr — registries don't change fast

/**
 * Human label for the crawl cadence, DERIVED from CRAWL_INTERVAL_MS so served
 * copy cannot drift from the timer. Page prose that states a cadence is a
 * factual claim about our own behaviour toward third parties - the same class
 * as a price quoted in prose - so it is generated, never typed.
 */
// A seller manifest is third-party JSON: `capabilities.tools` may be a number
// or anything else (a string reached a marketplace attribute unescaped, review
// 2026-08-28). Only a non-negative integer counts; everything else is 0.
function manifestToolCount(manifest) {
  const n = Number(manifest?.capabilities?.tools);
  return Number.isInteger(n) && n >= 0 && n < 1_000_000 ? n : 0;
}

export function crawlIntervalLabel() {
  const mins = Math.round(CRAWL_INTERVAL_MS / 60000);
  if (mins % 60 === 0 && mins >= 60) {
    const h = mins / 60;
    return h === 1 ? "every hour" : `every ${h} hours`;
  }
  return `every ${mins} minutes`;
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
const cache = new Map();
// Set of origins auto-discovered from public x402 registries (distinct from
// the env-configured seed list so we can show provenance separately on /index).
const discoveredSeeds = new Set();

// --- self-serve listing (POST /api/index/register) ---------------------------
// Origins submitted through the public register endpoint. Persisted to /data
// so a submission survives redeploys; silent in-memory fallback without the
// volume (same posture as stats). All probing goes through crawlSeller() —
// this module never fetches a submitted origin directly.
export const SUBMITTED_SEEDS_FILE = "/data/submitted-seeds.json";
const submittedSeeds = new Set();

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

/** Test hook: clear submitted-seed state between test cases. */
export function __testResetSubmitted() { submittedSeeds.clear(); }

/** Validate a raw submitted origin. Returns { origin } (normalized) or { error }. */
export function validateOriginInput(raw, { selfOrigin } = {}) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return { error: "origin must be a valid URL" }; }
  if (u.protocol !== "https:") return { error: "origin must be https" };
  if (u.username || u.password) return { error: "origin must not contain credentials" };
  if (u.port && u.port !== "443") return { error: "origin must use the default https port" };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { error: "submit the bare origin (no path or query)" };
  if (!u.hostname.includes(".")) return { error: "origin must be a public hostname" };
  const origin = `https://${u.hostname.toLowerCase()}`;
  if (selfOrigin && origin === String(selfOrigin).toLowerCase()) return { error: "this host is already the local catalog" };
  return { origin };
}

/**
 * Probe + list a submitted origin. `crawl` is injectable for tests; defaults
 * to the real crawlSeller. Known origins return their current state without
 * a fetch. Successful probes persist the origin as a seed.
 */
export async function registerOrigin(origin, { crawl } = {}) {
  const existing = cache.get(origin);
  if (existing && !existing.error) {
    // A re-registration of a KNOWN origin used to be a pure no-op, which made
    // "register again" useless as a seller's lever: a catalog stuck unpriced
    // (and therefore unroutable) had no way to ask for pricing except waiting
    // for the shared cycle budget to reach its rotation slot - measured
    // 2026-09-01, sol.blockrun's 128 routes across four attempts. Registering
    // is an explicit, rate-limited request (5/hour/IP), so it now re-runs the
    // live-402 quote enrichment for THIS origin, budget-exempt and bounded by
    // the same per-origin cap; probeDue backoffs still apply per route.
    try {
      await enrichLiveQuotes(existing.tools, origin, { ignoreBudget: true });
      // The route pool memoizes DECORATED tools by entry-object identity
      // (remotePoolMemo), so prices learned into the existing entry are
      // invisible until the object is replaced - a fresh spread busts the
      // memo and the pool re-decorates with what was just learned.
      cache.set(origin, { ...existing });
    } catch { /* listing still served */ }
    // Only a self-serve-submitted origin belongs in seller_registrations - this
    // early-return path also serves origins already known from Bazaar/registry
    // discovery, which never went through /sell and would misrepresent an
    // ecosystem seller as one of ours if recorded here.
    if (submittedSeeds.has(origin)) recordSellerRegistrationSeen(origin, { settled: originHasSettled(origin) });
    return { listed: true, origin, seller: sellerSummary(origin, existing) };
  }
  // Cap applies only to origins that would grow the submitted set. An origin
  // already on the list (retrying after a prior failure) is not new growth,
  // so it's exempt — it can still probe and update its own entry at cap.
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
    recordSellerRegistrationSeen(origin, { settled: originHasSettled(origin) });
    return { listed: true, origin, seller: sellerSummary(origin, cache.get(origin) || v) };
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
function originHasSettled(origin) {
  const host = canonicalHost(origin);
  if (!host) return false;
  try {
    const snap = getLeaderboardSnapshot();
    return (snap?.leaderboard || []).some(
      (row) => (row.callsSettled || 0) > 0 && (row.origins || []).some((o) => canonicalHost(o) === host)
    );
  } catch {
    return false;
  }
}

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
const bazaarToolsByOrigin = new Map();
// Per-origin Bazaar `quality` (Coinbase-measured 30-day calls + unique payers,
// last call time), aggregated from the discovery feed's per-resource objects:
// calls summed, unique payers MAX across resources (a seller-level unique
// count is unknowable from per-resource counts; max is the safe lower bound,
// never a sum that double-counts one wallet across routes). An independent
// evidence source next to our own on-chain scan: a Base seller Coinbase has
// watched being paid by N distinct wallets this month is proven for the SOR
// gate whether or not our scan has caught up, and /api/find can rank on it.
const bazaarQualityByOrigin = new Map();
export function bazaarQualityFor(origin) {
  return bazaarQualityByOrigin.get(String(origin || "").replace(/\/$/, "")) || null;
}
export function bazaarQualityEntries() { return [...bazaarQualityByOrigin.entries()]; }
export function _setBazaarQualityForTest(origin, q) { if (q) bazaarQualityByOrigin.set(origin, q); else bazaarQualityByOrigin.delete(origin); }
function foldBazaarQuality(map, origin, q) {
  if (!q || typeof q !== "object") return;
  const calls = Number(q.l30DaysTotalCalls) || 0, payers = Number(q.l30DaysUniquePayers) || 0;
  const last = typeof q.lastCalledAt === "string" ? q.lastCalledAt : null;
  const cur = map.get(origin) || { calls30d: 0, payers30d: 0, lastCalledAt: null };
  cur.calls30d += calls;
  cur.payers30d = Math.max(cur.payers30d, payers);
  if (last && (!cur.lastCalledAt || last > cur.lastCalledAt)) cur.lastCalledAt = last;
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
];

export const seedList = () => {
  const envSeeds = String(process.env.X402_INDEX_SEEDS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s));
  // committed defaults + env seeds (both operator-curated), then auto-discovered.
  return [...new Set([...DEFAULT_SEEDS, ...envSeeds, ...discoveredSeeds])];
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
    for (const item of list) {
      const url = item.resource || item.resourceUrl || item.url || item.endpoint || item.homepage;
      const origin = extractOrigin(url);
      if (!origin || origin === selfOrigin) continue;
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
        if (qualityByOrigin && item.quality) foldBazaarQuality(qualityByOrigin, origin, item.quality);
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
    // AVM sellers publish no /.well-known/x402 (oyapicks.app 404s), so without
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

/** USD → integer micro-dollars for exact compares (avoids float !== hazards). */
function priceToMicroUsd(p) {
  if (p == null || p === "") return null;
  const n = typeof p === "number" ? p : parseFloat(String(p).replace(/[^0-9.]/g, ""));
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
// Measured live 2026-08-13: bluepages.fyi (network:"base"),
// 1mpixels-one.vercel.app (network:"solana"), ~72 of 1,000 sampled PayAI
// resources affected. Built from CHAIN_PAGES itself (networkParam -> that
// chain's real mainnet id) rather than a hand-maintained list, so a future
// chain addition is covered automatically with no second edit required here.
const NETWORK_SHORTHAND = new Map(Object.values(CHAIN_PAGES).map((C) => [C.networkParam, C.acceptNetwork]));
function normalizeNetwork(n) {
  if (typeof n !== "string") return n;
  return NETWORK_SHORTHAND.get(n.toLowerCase()) || n;
}

export function bazaarItemToTool(item, originUrl) {
  // `resource` = CDP Bazaar; `resourceUrl` = GoPlausible's AVM registry.
  const resource = item.resource || item.resourceUrl || item.url;
  if (typeof resource !== "string" || !resource.startsWith(originUrl)) return null;
  // Normalized ONCE here so every downstream read (the `preferred` accept
  // below, `networks:`, `stellarPayTo`, `algorandPayTo`, `payToByNetwork`)
  // sees a real CAIP-2 id without each site needing its own fix.
  const accepts = (Array.isArray(item.accepts) ? item.accepts : []).map((a) =>
    a && typeof a.network === "string" ? { ...a, network: normalizeNetwork(a.network) } : a
  );
  // Prefer the first Base USDC accept; fall back to any USDC; fall back to first.
  const preferred =
    accepts.find((a) => a?.network === "eip155:8453" && /USDC|USD Coin/i.test(a?.extra?.name || "")) ||
    accepts.find((a) => /USDC|USD Coin/i.test(a?.extra?.name || "")) ||
    accepts[0] ||
    null;
  let price = null;
  if (preferred?.amount != null) {
    // amount is an atomic-units string; USDC has 6 decimals.
    const n = Number(preferred.amount);
    if (Number.isFinite(n)) price = n / 1e6;
  }
  let pathStr = "/";
  try {
    pathStr = new URL(resource).pathname || "/";
  } catch {
    /* keep "/" */
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
    provenance: "bazaar",
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
  if (!pick) return "";
  let path;
  try { path = new URL(pick, origin || "https://x.invalid").pathname; } catch { return ""; }
  path = path.replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

export function normaliseOpenapiTools(openapi, originUrl) {
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
      const annotated = openapiOperationHasPaymentSignal(op);
      const tags = Array.isArray(op.tags) ? op.tags : [];
      out.push({
        seller: originUrl,
        method: method.toUpperCase(),
        route: pathStr,
        slug: op.operationId || pathStr.replace(/^\//, "").replace(/\//g, "-"),
        name: op.summary || op.operationId || pathStr,
        description: op.description || "",
        category: tags[0] || "other",
        tags,
        price: op["x-price"] || op["x-x402-price"] || op["x-payment-info"]?.price?.amount || op["x-x402-price-usdc"] || null,
        ...(documentDistinguishesPaidOperations ? { paid: annotated } : {}),
        // What this operation's own document GUARANTEES on success. Stored as
        // a compact tuple (the public object repeats a constant source string
        // and a constant false on every one of tens of thousands of rows), and
        // omitted entirely when there is nothing to report. A parse failure
        // here must never cost the seller their listing, so it is caught per
        // operation rather than escaping into crawlSeller's manifest-only
        // handler.
        ...(() => {
          try {
            const packed = packResponseContract(responseContractOf(op));
            return packed ? { responseContract: packed } : {};
          } catch { return {}; }
        })(),
        // What a buyer must SEND. Same per-operation try/catch: a parse failure
        // must cost this operation its tuple, never the seller their listing.
        ...(() => {
          try {
            const packed = packRequestContract(requestContractOf(op));
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
// agente.revenuerecoveryai.app: thin "POST /v1/…" strings shadowed a rich
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
    name: named(prefer.name, prefer.route) ? prefer.name : (named(other.name, other.route) ? other.name : prefer.name),
    description: prefer.description || other.description || "",
    price: prefer.price || other.price || null,
    slug: (prefer.slug && prefer.slug !== prefer.route) ? prefer.slug : (other.slug || prefer.slug),
    method: prefer.method || other.method,
  };
}

function parseManifestPrice(raw) {
  const p = raw?.price_usd ?? raw?.priceUsd ?? raw?.price ?? raw?.amount ?? null;
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

export function normaliseManifestTools(manifest, originUrl) {
  if (!manifest || typeof manifest !== "object") return [];
  let origin;
  try { origin = new URL(originUrl); } catch { return []; }
  const catalogues = ["tools", "resources", "endpoints", "services"]
    .map((k) => manifest[k])
    .filter((v) => Array.isArray(v) && v.length);
  if (!catalogues.length) {
    const single = singleResourceManifestTool(manifest, originUrl);
    return single ? [single] : [];
  }

  const byKey = new Map();
  const metaByPath = new Map();
  const notePathMeta = (path, { name, description, price, slug }) => {
    if (!path) return;
    const cur = metaByPath.get(path) || {};
    const named = name && name !== path && !String(name).startsWith("/");
    const curNamed = cur.name && cur.name !== path && !String(cur.name).startsWith("/");
    metaByPath.set(path, {
      name: (named ? name : null) || (curNamed ? cur.name : null) || cur.name || name || "",
      description: description || cur.description || "",
      price: price || cur.price || null,
      slug: (slug && slug !== path) ? slug : (cur.slug || slug || ""),
    });
  };

  for (const list of catalogues) {
    for (const raw of list.slice(0, 1000)) {
      let ref = "", name = "", description = "", price = null;
      const methodList = [];
      if (typeof raw === "string") {
        ref = raw.trim();
      } else if (raw && typeof raw === "object") {
        ref = String(raw.endpoint || raw.resource || raw.url || raw.route || raw.path || "").trim();
        name = String(raw.name || raw.title || raw.operationId || "").trim();
        description = String(raw.summary || raw.description || "").trim();
        price = parseManifestPrice(raw);
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
      notePathMeta(pathOnly, { name, description, price, slug });
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
          // default as a declaration. Until 2026-09-02 minia2a.uk's two entries
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
          price,
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
    }
    if (!hit.stellarPayTo && m.stellarPayTo) hit.stellarPayTo = m.stellarPayTo;
    if (!hit.algorandPayTo && m.algorandPayTo) hit.algorandPayTo = m.algorandPayTo;
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

function openapiOperationHasPaymentSignal(op) {
  return Boolean(op && typeof op === "object" &&
    (op["x-price"] || op["x-x402-price"] || op["x-payment-info"] ||
      // Seen in the wild 2026-07-27 (cloudworldmodel.ai): a price-in-USDC
      // variant key on operations that carry no other payment extension —
      // 3 of their 17 paid operations were silently dropped without it.
      op["x-x402-price-usdc"]));
}

// Annotation-dialect watch. There is no standard for payment extensions, so
// sellers invent keys — and in an ANNOTATED document an unrecognized price key
// doesn't inflate anything, it silently DELETES: the op reads as unannotated
// and drops from the paid set (x-x402-price-usdc hid 3 of a seller's 17 paid
// ops until they emailed, 2026-07-27). Surface every payment-ish x- key we
// don't recognize so the next dialect announces itself in the logs instead.
const RECOGNIZED_PAYMENT_KEYS = new Set(["x-price", "x-x402-price", "x-payment-info", "x-x402-price-usdc"]);
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
const LIVE_QUOTE_PROBES_PER_CRAWL = 5;
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
// fully priced in about half an hour, and each of them still sees at most five
// requests per cycle. The env override remains for throttling if a real cost
// ever shows up.
const LIVE_QUOTE_PROBES_PER_CYCLE = Number(process.env.LIVE_QUOTE_PROBES_PER_CYCLE || 4000);
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
 * Carry forward quotes we already learned from a live 402.
 *
 * Every crawl REBUILDS `tools` from the seller's catalogue, and the catalogue is
 * exactly the surface that has no price - that is the whole reason the live
 * probe exists. So without this, each cycle threw away everything the previous
 * cycle learned and re-learned at most LIVE_QUOTE_PROBES_PER_CRAWL routes.
 * A seller with 39 routes could never accumulate: the count oscillated near
 * zero forever and the feature looked like it worked while achieving nothing.
 * Observed live - two routes priced, then zero after the next crawl.
 *
 * Keyed by ROUTE only, deliberately: learning a quote can CORRECT the method
 * (a catalogue that said GET for a POST-only endpoint), so a method-qualified
 * key would miss the row it just fixed.
 */
export function carryForwardLearnedQuotes(tools, prev) {
  // Keyed by METHOD + route, with a route-only fallback for the price and
  // networks. Until 2026-09-02 the map was keyed by route alone and the
  // remembered row's VERB was stamped onto every current row on that route,
  // so a path with GET and POST (minia2a.uk: 86 such paths in the first 500
  // rows) came out as two GETs - the POST operation mislabelled, and a seller
  // whose POST route rejects GET would answer 405 to every buyer we sent and
  // be recorded as broken by us. A remembered verb may only replace a verb
  // the current row INFERRED (a manifest or llms.txt entry that named none);
  // a declared verb is the seller's own statement and stands.
  const learnedExact = new Map();
  const learnedByRoute = new Map();
  for (const t of prev?.tools || []) {
    if (t?.quoteSource !== "live-402" || typeof t.route !== "string") continue;
    learnedExact.set(`${String(t.method || "GET").toUpperCase()} ${t.route}`, t);
    if (!learnedByRoute.has(t.route)) learnedByRoute.set(t.route, t);
  }
  if (!learnedExact.size) return tools;
  for (const t of tools) {
    const exact = learnedExact.get(`${String(t.method || "GET").toUpperCase()} ${t.route}`);
    const hit = exact || learnedByRoute.get(t.route);
    if (!hit) continue;
    // A carried-forward quote FILLS A GAP; it never overrides what this crawl
    // just read from the origin. `originDeclaredPrice` is set by the OpenAPI
    // merge above, so a route the origin priced today keeps that number even
    // when an older live-402 learned a different one (2026-08-29: the stale
    // amount was filling the fresh row and then being re-stamped "live-402",
    // which made a nine-day-old price look freshly observed).
    const originPricedThisCrawl = Number(t.originDeclaredPrice) > 0;
    if (!(Number(t.price) > 0) && !originPricedThisCrawl && Number(hit.price) > 0) {
      t.price = hit.price;
      t.quoteCarriedForward = true;
      if (hit.quoteObservedAt) t.quoteObservedAt = hit.quoteObservedAt;
    }
    if (!(Array.isArray(t.networks) && t.networks.length) && Array.isArray(hit.networks) && hit.networks.length) {
      t.networks = [...hit.networks];
    } else if (Number(hit.networksVerifiedAt) > 0 && Array.isArray(hit.networks) && hit.networks.length) {
      // A VERIFIED live read outranks a manifest claim: union the chains the
      // 402 actually offered into the freshly rebuilt (manifest-shaped) row,
      // and carry when they were verified so the weekly re-read keeps its clock.
      t.networks = [...new Set([...(t.networks || []), ...hit.networks])];
      t.networksVerifiedAt = hit.networksVerifiedAt;
    }
    // A route-level hit may change a current row's verb in exactly two cases:
    // the row INFERRED its verb (named none), or the hit is a recorded
    // CORRECTION of this very verb (the probe saw it fail and the other answer).
    // A learned verb that simply answered on its own row is not evidence about
    // a sibling verb - that reading is what mislabelled minia2a's POST rows.
    if (!exact && hit.method && hit.method !== t.method
        && (t.methodInferred === true || hit.methodCorrectedFrom === String(t.method || "GET").toUpperCase())) {
      if (hit.methodCorrectedFrom) t.methodCorrectedFrom = hit.methodCorrectedFrom;
      t.method = hit.method; t.methodInferred = false;
    }
    // Only claim "live-402" for a price this crawl is actually standing behind:
    // a row the origin priced today is origin-declared, not live-learned.
    if (!originPricedThisCrawl) t.quoteSource = "live-402";
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
// single-chain forever (angel.finereli.com, 2026-09-02: live 402 offers Base
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
  return now - at >= NETWORKS_VERIFY_AGE_MS;
}

export function priceDisagreesWithOrigin(t) {
  const held = Number(t?.price), declared = Number(t?.originDeclaredPrice);
  if (!(held > 0) || !(declared > 0)) return false;
  const ratio = held > declared ? held / declared : declared / held;
  return ratio >= QUOTE_DRIFT_FACTOR;
}

/** Per-crawl quote-probe cap for one origin. The polite steady-state is
 * LIVE_QUOTE_PROBES_PER_CRAWL (5) - but an origin with ZERO priced tools is
 * wholly invisible to routing (the resolver only pays priced rows), and at 5
 * per 30-min cycle a new 128-route seller stays unroutable for half a day
 * (measured live 2026-09-01: sol.blockrun registered, proven on-chain, and
 * unroutable for hours while the rotation crept). A catalog with nothing
 * priced gets a one-time burst - the seller REGISTERED to be found, and a
 * single burst on a new listing is what they asked for - then drops to the
 * polite cap the moment anything is priced. Pure; exported for the test. */
export function quoteProbeCapFor(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const priced = list.filter((t) => Number(t?.price) > 0).length;
  const unpriced = list.length - priced;
  // "Zero priced" was the first predicate and it missed the live case: a
  // registry merge had already priced a handful of sol.blockrun's 128 rows,
  // so the burst never fired and the catalog stayed 90% invisible. The state
  // that starves a seller is OVERWHELMINGLY unpriced, not perfectly unpriced:
  // burst while at least 20 rows are unpriced and priced rows are under a
  // quarter of the unpriced count, polite cap the rest of the time.
  if (unpriced >= 20 && priced < unpriced / 4) {
    return Math.max(LIVE_QUOTE_PROBES_PER_CRAWL, Number(process.env.NEW_CATALOG_QUOTE_BURST || "60"));
  }
  return LIVE_QUOTE_PROBES_PER_CRAWL;
}

async function enrichLiveQuotes(tools, originUrl, { ignoreBudget = false } = {}) {
  if (!Array.isArray(tools) || !tools.length) return tools;
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
      // probed again (measured 2026-09-01, sol.blockrun).
      && ((!(Number(t.price) > 0) || !(Array.isArray(t.networks) && t.networks.length)) || priceDisagreesWithOrigin(t) || quoteIsStale(t) || networksNeedLiveVerify(t))
      && probeMethodsFor(t).length                       // never PUT/PATCH/DELETE
      && probeDue(originUrl, `quote:${t.route}`),
  );
  // NEVER-ATTEMPTED rows first. The first rotation attempt indexed a window
  // into a list that SHRINKS as rows price, so some rows landed in skipped
  // windows on every pass (sol.blockrun's stock routes, three passes running,
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
  const repriceCap = Number(process.env.REPRICE_MAX_PER_CALL || "120");
  const cap = ignoreBudget ? repriceCap : Math.min(quoteProbeCapFor(tools), liveQuoteBudget);
  const rotated = [...candidates]
    .sort((a, b) => (a.quoteObservedAt ? 1 : 0) - (b.quoteObservedAt ? 1 : 0))
    .slice(0, Math.max(0, cap));
  if (!rotated.length) return tools;
  if (!ignoreBudget) liveQuoteBudget -= rotated.length;

  const { assertPublicUrl, ssrfDispatcher } = await import("./tools/fetch-guard.js");
  for (const tool of rotated) {
    const target = `${originUrl}${tool.route}`;
    let learned = null;
    for (const method of probeMethodsFor(tool)) {
      try {
        // Crawled URLs are external data and could DNS-rebind between crawl and
        // now: validate then pin, exactly as probePaywall does.
        await assertPublicUrl(target);
        const res = await fetch(target, {
          method,
          headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
          ...(method === "POST" ? { body: "{}" } : {}),
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
        if (method === "GET" && res.status === 200) break;
        if (!isQuoteResponse(res.status)) continue;   // 404 on GET is expected for a POST-only seller
        // The quote lives in the header for x402 v2 and in the body for several
        // real sellers; read a bounded slice of both and let the parser decide.
        const body = await res.text().catch(() => "");
        const quote = quoteFromAccepts(
          acceptsFromLive402({ header: res.headers.get("payment-required"), body: body.slice(0, 64_000) }),
        );
        if (quote) { learned = { ...quote, method }; break; }
      } catch { /* unreachable, blocked, or malformed - try the next method */ }
    }
    noteProbeOutcome(originUrl, `quote:${tool.route}`, Boolean(learned));
    if (!learned) continue;
    // Price may be null for an asset we refuse to guess at; the networks alone
    // still move the row from payable:"unknown" to payable:"x402", which is the
    // honest and useful half of the answer.
    if (learned.price != null && !(Number(tool.price) > 0)) tool.price = learned.price;
    if (learned.networks?.length) tool.networks = [...new Set([...(tool.networks || []), ...learned.networks])];
    // The live 402 was read: the row's chains are verified as of now, whatever
    // the manifest claimed (the union above never drops a manifest chain).
    tool.networksVerifiedAt = Date.now();
    if (learned.method && learned.method !== tool.method) {
      // The stated verb did not answer a quote and this one did: a CORRECTION,
      // recorded as such so the next crawl's carry-forward can re-apply it to
      // the freshly rebuilt row (which will state the wrong verb again) without
      // ever touching a row whose own verb was never probed.
      tool.methodCorrectedFrom = String(tool.method || "GET").toUpperCase();
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
  const target = `${pick.seller}${pick.route}`;
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
async function robotsGroupsFor(originUrl, fetchText) {
  const hit = robotsCache.get(originUrl);
  if (hit && Date.now() - hit.at < ROBOTS_TTL_MS) return hit.groups;
  let groups = [];
  try {
    const text = fetchText
      ? await fetchText(`${originUrl}/robots.txt`)
      : (await safeFetch(`${originUrl}/robots.txt`, { maxBytes: ROBOTS_MAX_BYTES })).html;
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
  // to be found: measured live 2026-09-01 on sol.blockrun.ai (manifest 200,
  // robots Disallow /, entry stuck as textless registry synthesis, invisible
  // to every route query). Everything else the crawler touches - llms.txt,
  // homepages, tool probes - stays robots-honoured.
  //
  // ONE extension (2026-09-02): once a seller has published that manifest,
  // /openapi.json at the same origin is read even under a BLANKET Disallow.
  // The manifest is the seller's opt-in to machine discovery, and the OpenAPI
  // is the document that NAMES the routes the manifest lists as bare
  // "POST /api/v1/exa/search" strings. Without it, sol.blockrun.ai's 128
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
  const verdict = robotsAllows(groups, ROBOTS_UA, path);
  if (verdict.allowed) return null;
  if (manifestPublished && path === OPENAPI_PATH && !robotsNamesUs(groups)) return null;
  return verdict.matchedRule || "Disallow";
}
export function __resetRobotsCacheForTest() { robotsCache.clear(); }

/** Fetch `path` on `originUrl` unless it is backed off, recording the outcome.
 *  Every per-origin probe in the crawl goes through here so a new one cannot be
 *  added ungated the way /agents.json and /llms.txt were. */
async function probePath(originUrl, path, { manifestPublished = false, ...opts } = {}) {
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
    const stored = validatorFor(originUrl, path);
    const res = await safeFetch(`${originUrl}${path}`, { ...opts, validators: stored, allowNotModified: true });
    noteProbeOutcome(originUrl, path, true);
    if (res.notModified) {
      if (res.validators) rememberValidator(originUrl, path, res.validators);
      return res;
    }
    rememberValidator(originUrl, path, res.validators || null);
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
export function __validatorCountForTest() { return crawlValidators.size; }

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
async function probeDoc(originUrl, path, opts, prevParsed) {
  const res = await probePath(originUrl, path, opts);
  if (!res.notModified) return { parsed: JSON.parse(res.html), reused: false };
  if (prevParsed != null) return { parsed: prevParsed, reused: true };
  rememberValidator(originUrl, path, null);
  const fresh = await probePath(originUrl, path, opts);
  return { parsed: JSON.parse(fresh.html), reused: false };
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
      // WHICH surface produced this catalogue. Everything below is a fallback,
      // and a seller cannot fix a gap they cannot see — see discoveryNote().
      discoveryPath: WELL_KNOWN_PATH,
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
    try {
      const openapiRes = await fetchOpenapi();
      const parsed = JSON.parse(openapiRes.html);
      if (bazaarTools.length || openapiHasPaymentSignal(parsed)) {
        openapi = parsed;
        openapiTools = normaliseOpenapiTools(parsed, originUrl);
        if (openapiTools.length) openapiPath = "/openapi.json";
      }
    } catch {
      /* no openapi either — Bazaar-only seller */
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
        const agentsRes = await probePath(originUrl, "/agents.json", { maxBytes: MAX_OPENAPI_BYTES });
        const parsed = JSON.parse(agentsRes.html);
        if (bazaarTools.length || openapiHasPaymentSignal(parsed)) {
          const fromAgents = normaliseOpenapiTools(parsed, originUrl);
          if (fromAgents.length) { openapi = openapi || parsed; openapiTools = fromAgents; openapiPath = "/agents.json"; }
        }
      } catch {
        /* no agents.json either */
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
        const llmsRes = await probePath(originUrl, "/llms.txt", { maxBytes: MAX_OPENAPI_BYTES });
        const fromLlms = normaliseLlmsTxtTools(llmsRes.html, originUrl);
        if (fromLlms.length) { openapiTools = fromLlms; openapiPath = "/llms.txt"; }
      } catch {
        /* no llms.txt either */
      }
    }
    const tools = dropUnvouchedNonProductRoutes(
      mergeOpenapiIntoBazaar(openapiTools, bazaarTools, {
        allRoutes: openapi ? openapiAllOperationRoutes(openapi, originUrl) : [],
      }),
      bazaarTools.map((t) => t.route)
    );
    if (tools.length) {
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
        history: rollHistory(prev, true),
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
export function computeAliasOrigins(cacheMap) {
  const byHost = new Map(); // canonical host -> { origin, v }
  for (const [origin, v] of cacheMap) {
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
    const ownHost = canonicalHost(origin);
    const homeHost = canonicalHost(v?.manifest?.homepage);
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
  const canonicalPayees = (tools) => Object.entries(allPayTosByNetwork(tools))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([network, values]) => [network, [...values].map((value) => String(value).toLowerCase()).sort()]);
  const exactServiceKey = (v) => {
    if (!v || typeof v !== "object") return null;
    if (serviceKeyMemo.has(v)) return serviceKeyMemo.get(v);
    const tools = v.tools || [];
    const payees = canonicalPayees(tools);
    let key = null;
    if (tools.length && payees.length) {
      const contracts = tools.map((t) => [
        String(t.method || "GET").toUpperCase(),
        String(t.route || ""),
        String(t.slug || ""),
        String(t.price ?? ""),
        t.paid === false ? "free" : "paid-or-unknown",
        [...(t.networks || [])].map(String).sort(),
      ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      key = JSON.stringify({ payees, contracts });
    }
    serviceKeyMemo.set(v, key);
    return key;
  };
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
];
export function looksLikeListingInjection(text) {
  const t = String(text || "");
  if (t.length > 8000) return true; // no honest listing is a novel; oversized = padding an attack
  for (const re of INJECTION_PATTERNS) if (re.test(t)) return true;
  return false;
}

let crawlerTimer = null;
let firstCrawlTimer = null;
let discoveryTimer = null;
let crawlInFlight = false;

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
// could have registered throwaway origins under the same suffix to starve a
// competitor's listing until its learned quote went stale (QUOTE_MAX_AGE_MS).
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
    recordSubmittedSellerObservations();
    // `due`, not `ordered`: cycleOkFraction's own contract is that it measures
    // THIS pass. Once the per-operator cap made the crawled set a subset, passing
    // the full list let every origin held back this cycle contribute its previous
    // cached verdict - diluting the denominator with stale OKs in the UNSAFE
    // direction, so during an egress outage the fraction could stay above the
    // 0.5 floor and slots would be released anyway.
    releaseDeadSubmissions(cycleOkFraction(due));
  } finally {
    crawlInFlight = false;
  }
}

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
    if (row.last_settled_seen || hasSettled(origin)) continue;
    // No successful probe ever recorded falls back to first_seen, so a row
    // that predates this column cannot be immortal.
    const lastOk = Number(row.last_routable_seen || row.first_seen || 0);
    if (!lastOk) continue;
    if (now - lastOk < maxIdleMs) continue;
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

// Release submission slots held by origins that have been gone for a month.
// Called once per crawl cycle, after the observation pass has advanced
// last_routable_seen for everything that answered - so an origin released here
// definitively did not answer this cycle either.
function releaseDeadSubmissions(okFraction) {
  let releasable;
  try {
    releasable = selectReleasableOrigins({
      registrations: getSellerRegistrations(),
      isSubmitted: (o) => submittedSeeds.has(o),
      hasSettled: (o) => originHasSettled(o),
      cycleOkFraction: okFraction,
    });
  } catch { return 0; }
  if (!releasable.length) return 0;
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
  console.log(`[x402-index] released ${releasable.length} submission slot(s) after ${Math.round(RELEASE_AFTER_MS / 86400000)}d with no successful probe: ${releasable.slice(0, 10).join(", ")}${releasable.length > 10 ? ", ..." : ""}`);
  return releasable.length;
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
const MANIFEST_PERSIST_KEYS = ["name", "description", "homepage", "version", "synthesized", "payTo", "network", "networks", "x402Version"];
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

/** The entries to persist: slim projections of every non-errored origin. */
function persistedEntries() {
  const out = [];
  for (const [origin, v] of cache.entries()) {
    if (v?.error) continue; // don't re-seed failures; let the crawl re-decide
    out.push([origin, {
      manifest: slimManifestForPersist(v.manifest),
      tools: Array.isArray(v.tools) ? v.tools.map(slimToolForPersist) : [],
      fetchedAt: v.fetchedAt ?? null,
      error: null,
      source: v.source ?? null,
      history: Array.isArray(v.history) ? v.history.slice(-10) : [],
      paywall: v.paywall ?? null,
    }]);
  }
  return out;
}

/** Async persist for the crawler's own cycle: the stringify is still one
 *  synchronous pass, but the write no longer blocks, and overlapping cycles
 *  never write twice. */
let persistInFlight = false;
export async function persistIndexCacheAsync(file = INDEX_CACHE_FILE) {
  if (persistInFlight) return false;
  persistInFlight = true;
  try {
    if (cache.size === 0) return false;
    const entries = persistedEntries();
    if (!entries.length) return false;
    const t0 = performance.now();
    const json = JSON.stringify({ savedAt: Date.now(), entries });
    const ms = Math.round(performance.now() - t0);
    // Always say how big it is, and which origins carry it: the file was 91 MB
    // before the slim projection and 48 MB after, and what remains is tool
    // arrays. Naming the five largest origins each cycle is how the next cut
    // gets sized from data instead of a guess.
    const top = entries.map(([o, v]) => [o, JSON.stringify(v).length]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`[x402-index] persisted ${(json.length / 1_048_576).toFixed(1)} MB for ${entries.length} origins in ${ms}ms; largest: ` +
      top.map(([o, n]) => `${o} ${(n / 1024).toFixed(0)}KB/${(cache.get(o)?.tools || []).length} tools`).join(", "));
    const { writeFile, rename } = await import("node:fs/promises");
    // NDJSON for the incremental loader: header line, then one [origin, entry]
    // per line. Written to a temp path and renamed so a crash mid-write can
    // never leave a half file for the next boot to read.
    const ndFile = file === INDEX_CACHE_FILE ? INDEX_CACHE_NDJSON_FILE : file.replace(/\.json$/, "") + ".ndjson";
    const lines = [JSON.stringify({ savedAt: Date.now(), format: "ndjson-v1", origins: entries.length })];
    for (const e of entries) lines.push(JSON.stringify(e));
    await writeFile(`${ndFile}.tmp`, lines.join("\n") + "\n");
    await rename(`${ndFile}.tmp`, ndFile);
    // The legacy single-JSON file stays current too, for the sync loader and
    // for anything that copies it (backups exclude cache files anyway).
    await writeFile(file, json);
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

export function startCrawler(opts = {}) {
  if (crawlerTimer) return;
  loadSubmittedSeeds();
  // Warm start: the NDJSON twin incrementally when it exists (its own log
  // line says how long and the longest turn), else the legacy JSON in one
  // synchronous parse. The first crawl is deferred below, so the fill has
  // finished long before anything re-crawls.
  if (opts.syncWarmStart) {
    const warmed = loadPersistedIndexCache();
    if (warmed) console.log(`[x402-index] warm-started ${warmed} sellers from ${INDEX_CACHE_FILE}`);
  } else {
    loadPersistedIndexCacheAsync().then((n) => {
      if (n) return;
      const warmed = loadPersistedIndexCache();
      if (warmed) console.log(`[x402-index] warm-started ${warmed} sellers from ${INDEX_CACHE_FILE} (no NDJSON twin yet)`);
    }).catch(() => {});
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
  crawlerTimer = setInterval(() => { runCrawl().then(() => persistIndexCacheAsync()).catch(() => {}); }, CRAWL_INTERVAL_MS);
  discoveryTimer = setInterval(() => runDiscovery(selfOrigin), DISCOVERY_INTERVAL_MS);
  // Verified-list feed: no-op unless X402_VERIFIED_LIST=on (default off).
  startVerifiedListRefresh();
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
  stopVerifiedListRefresh();
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
export function ecosystemMarket({ limit = 12 } = {}) {
  return aggregateEcosystemSupply([...cache.values()], { limit });
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
 * not - a seller whose probe failed still told us its address) plus the
 * registry-synthesized tools (the Bazaar lists payTo per resource, so a
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

export function routableSellerSummaries() {
  const out = [];
  for (const [origin, v] of cache.entries()) {
    if (v?.error || !isRoutable(v)) continue;
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
      toolCount: v.tools?.length || manifestToolCount(v.manifest),
      // Did the origin ever answer us, or is this a registry listing about it?
      originResponded: v.originResponded !== false,
      // Rides with originResponded on ALL THREE accessors on purpose: this
      // file has twice shipped a field present on two of three, which is
      // inert on whichever surface happens to render.
      discoveryPath: v.discoveryPath || null,
      // payTo per advertised network, so callers can join an origin to on-chain
      // settlements it received. Sourced ONLY from facilitator discovery-registry
      // items (bazaarItemToRow) - a seller's own crawled manifest never
      // contributes one - so this carries exactly the same trust as the
      // leaderboard's registry-declared payTo, no more.
      //
      // Omitting it silently broke the router's chain-derived proven-ness join:
      // baseNetworkPayTo() returned null for every seller, so the evidence
      // source contributed nothing, always, and looked identical to "no data".
      payToByNetwork: (v.tools || []).reduce((acc, t) => {
        for (const [net, addr] of Object.entries(t.payToByNetwork || {})) if (!acc[net]) acc[net] = addr;
        return acc;
      }, {}),
      // Every advertised payTo, not just the first (see allPayTosByNetwork).
      payTosByNetwork: allPayTosByNetwork(v.tools),
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
export function allPayTosByNetwork(tools) {
  return (tools || []).reduce((acc, t) => {
    for (const [net, addr] of Object.entries(t?.payToByNetwork || {})) {
      const seen = (acc[net] ||= []);
      if (!seen.includes(addr) && seen.length < 200) seen.push(addr);
    }
    return acc;
  }, {});
}

export function sellerDetail(originOrHost) {
  const q = String(originOrHost || "").trim().toLowerCase().slice(0, 253);
  if (!q) return null;
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
  for (const [origin, v] of cache.entries()) {
    if (origin.toLowerCase() !== q && hostOf(origin) !== q) continue;
    return {
      origin,
      displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
      homepage: v.manifest?.homepage || origin,
      toolCount: v.tools?.length || manifestToolCount(v.manifest),
      ...(v.tools?.some((t) => t.paid !== undefined)
        ? { paidToolCount: v.tools.filter((t) => t.paid !== false).length }
        : {}),
      fetchedAt: v.fetchedAt ?? null,
      error: v.error || null,
      health: healthScore(v),
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
      // payTo per advertised network. Registry-sourced only (bazaarItemToTool);
      // a seller's own crawled manifest never contributes one. Omitting it made
      // advertisedPayToEvidence inert: server.js passes THIS object as `seller`,
      // so baseNetworkPayTo() read undefined and the paid seller-trust tool
      // reported "advertises no payTo" for every seller, including the many that
      // plainly do.
      payToByNetwork: (v.tools || []).reduce((acc, t) => {
        for (const [net, addr] of Object.entries(t.payToByNetwork || {})) if (!acc[net]) acc[net] = addr;
        return acc;
      }, {}),
      // Every payee this origin advertises, so a venue hosting many authors is
      // not reported as a single seller (see allPayTosByNetwork).
      payTosByNetwork: allPayTosByNetwork(v.tools),
      routable: isRoutable(v),
      tools: (v.tools || []).slice(0, 500).map((t) => ({
        method: t.method || null,
        route: t.route || null,
        slug: t.slug || null,
        name: t.name || null,
        price: t.price ?? null,
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
  const remote = [...cache.entries()].filter(([origin]) => !isSelfOrigin(origin)).map(([origin, v]) => ({
    origin,
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
    // (first payTo seen per network wins) — the EVM/Solana counterpart to the
    // stellar/algorand wallets above, so the market pages can scope activity to
    // an external seller's advertised address on the chain being viewed.
    payToByNetwork: [...(bazaarToolsByOrigin.get(origin) || []), ...(v.tools || [])]
      .reduce((acc, t) => {
        for (const [net, addr] of Object.entries(t.payToByNetwork || {})) if (!acc[net]) acc[net] = addr;
        return acc;
      }, {}),
    payTosByNetwork: allPayTosByNetwork([...(bazaarToolsByOrigin.get(origin) || []), ...(v.tools || [])]),
  }));
  // Collapse http/https duplicates of the same host into one seller. A registry
  // can list the same origin under both schemes (algo.netintel.dev appeared as
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
const toolStaticsMemo = new WeakMap(); // tool (local or decorated) -> { slug, name, hay, injected, priceRank }
function decoratedRemoteTools(v) {
  let d = remotePoolMemo.get(v);
  if (d) return d;
  // Seller-level payment networks: the union of every chain this seller's
  // OWN crawled 402s advertise plus the Bazaar's settled view of the same
  // origin - the same union the /api/index seller row carries. A route the
  // seller documents in OpenAPI (priced, so a buy candidate) has no accepts
  // of its own until a probe reaches it, and until 2026-09-02 such a row
  // ranked with `networks: []`: api.strale.io's /x402/v2/image-to-text
  // (3,769 settled calls that month) read as network_unknown and the router
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
  d = (v.tools || [])
    // paid:false = the seller's own doc says this operation is free.
    // It lists on the marketplace, but it is never a BUY candidate —
    // route-execute would 402-dance against an endpoint that never
    // quotes, and "cheapest tool" rankings would fill with $0 rows.
    .filter((t) => t.paid !== false)
    .map((t) => ({
      ...t,
      ...(!(Array.isArray(t.networks) && t.networks.length) && sellerNets.length ? { networks: sellerNets, networksInferred: true } : {}),
      sellerHome: v.manifest?.homepage || t.seller,
      sellerName: v.manifest?.name || t.seller,
      health: healthScore(v),
    }));
  remotePoolMemo.set(v, d);
  return d;
}
function toolStatics(t) {
  let st = toolStaticsMemo.get(t);
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
    aliases: Array.isArray(t.aliases) ? t.aliases.map((a) => String(a).toLowerCase()).filter(Boolean) : [],
  };
  toolStaticsMemo.set(t, st);
  return st;
}

export function routeQuery({ query, top, include, networkFilter, strictNetwork = false, baseUrl, catalog, prices, network, toolCount, walletName }) {
  const q = String(query || "").slice(0, 500);
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 32);
  const k = Math.min(Math.max(parseInt(top, 10) || 5, 1), 25);
  const inc = VALID_INCLUDE.has(include) ? include : "all";
  // ?network=robinhood (or a raw CAIP-2) keeps only tools whose crawled 402
  // advertises that chain. Positive-signal filter: local tools and sellers
  // whose crawl source carries no accepts (networks unknown) are kept — the
  // filter is "exclude sellers known NOT to settle there", not a guarantee.
  const wantNet = networkFilter ? (ROUTE_NETWORKS[String(networkFilter).trim().toLowerCase()] || String(networkFilter).trim()) : null;
  if (!terms.length) return { query: q, count: 0, results: [], sellers: 0, include: inc, ...(wantNet ? { network: wantNet } : {}) };

  // Always include the local catalog (we trust ourselves), plus every crawled
  // seller's tools — but only from sellers whose last crawl succeeded. A buyer
  // routed to a currently-broken seller would just lose the call, so we'd
  // rather rank fewer trustworthy options than more flaky ones.
  const local = buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName });
  const localPool = inc === "external"
    ? []
    : local.tools.map((t) => ({ ...t, sellerHome: baseUrl, sellerName: local.displayName, health: 1 }));
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
  const remotePool = inc === "local"
    ? []
    : [...cache.entries()]
        .filter(([origin, v]) => isRoutable(v) && !aliasOrigins.has(origin) && !isSelfOrigin(origin))
        .flatMap(([, v]) => decoratedRemoteTools(v));
  const all = [...localPool, ...remotePool];

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
  const scored = [];
  for (const t of all) {
    if (!netOk(t)) continue;
    const st = toolStatics(t);
    if (st.injected) continue;
    const { slug, name, hay, aliases } = st;
    const names = aliases.length ? [slug, ...aliases] : [slug];
    let score = 0;
    // Record WHERE the score came from, not just how much. A seller who loses a
    // routing decision learns nothing from silence; "matched on description
    // only" tells them to fix their slug, and it makes the neutrality claim
    // checkable by anyone instead of merely stated (asked for in #645).
    const matched = { slug: 0, name: 0, text: 0 };
    for (const term of terms) {
      // A term under three characters matches whole tokens only: "ip" used to
      // substring-match gzip, gunzip and html-strip, which outranked every IP
      // tool for "ip geolocation" (2026-08-28).
      const hit = term.length >= 3 ? (str) => str.includes(term) : (str) => str.split(/[^a-z0-9]+/).includes(term);
      const slugScore = Math.max(...names.map((n) => (n === term ? 10 : hit(n) ? 4 : 0)));
      if (slugScore) { score += slugScore; matched.slug += slugScore; }
      if (hit(name)) { score += 2; matched.name += 2; }
      if (hit(hay)) { score += 1; matched.text += 1; }
    }
    if (score > 0) scored.push([score, t, matched, st.priceRank]);
  }
  // Highest score first; healthier seller wins on ties; then cheapest KNOWN
  // price (unknown ranks last among equals — see priceRank); then shorter
  // slug. Health is the strongest tiebreak after match score because a
  // cheap-but-flaky seller is worse than a slightly pricier reliable one.
  const selfQuality = (bazaarQualityFor(baseUrl) || bazaarQualityFor(SELF_BAZAAR_ORIGIN))?.payers30d ?? null;
  scored.sort((a, b) => {
    if (b[0] !== a[0]) return b[0] - a[0];
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
    const aLocal = a[1].seller === LOCAL_SELLER, bLocal = b[1].seller === LOCAL_SELLER;
    if (aLocal || bLocal) {
      const qa = aLocal ? selfQuality : (bazaarQualityFor(a[1].seller)?.payers30d ?? null);
      const qb = bLocal ? selfQuality : (bazaarQualityFor(b[1].seller)?.payers30d ?? null);
      if (qa != null && qb != null && qb !== qa) return qb - qa;
    } else {
      const qa = bazaarQualityFor(a[1].seller)?.payers30d || 0, qb = bazaarQualityFor(b[1].seller)?.payers30d || 0;
      if (qb !== qa) return qb - qa;
    }
    if (a[3] !== b[3]) return a[3] - b[3];
    const slugLen = (a[1].slug || "").length - (b[1].slug || "").length;
    if (slugLen !== 0) return slugLen;
    // Verified-list preference (X402_VERIFIED_LIST, default off): only fires
    // when every existing key already tied. Presence on the operator-configured
    // feed is a last-resort tiebreak, never a score bump, and never consulted
    // when the flag is off.
    if (!verifiedListEnabled()) return 0;
    const va = routeOnVerifiedList(a[1]) ? 1 : 0;
    const vb = routeOnVerifiedList(b[1]) ? 1 : 0;
    return vb - va;
  });

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

  const sellersSeen = new Set();
  let anyExternal = false;
  const results = picked.map(([score, t, matched]) => {
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
      url: t.seller === LOCAL_SELLER ? `${baseUrl}${t.route}` : `${t.seller}${t.route}`,
      // A crawled OpenAPI path can carry template segments the seller never
      // substitutes ("/stock/{symbol}"). Handing an agent that URL as if it
      // were callable wastes its money and its time - measured 2026-08-28,
      // three of eight rows for "get a stock quote" were templates. We still
      // RETURN the row (the seller and the tool are real, and an agent that
      // knows the parameter can fill it), but we say so, and the SOR skips it.
      ...urlTemplateProjection(t),
      price: t.price,
      priceUsd: parsePrice(t.price),
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
        tiebreaks: verifiedListEnabled()
          ? ["score", "health", "cheapest known price", "shorter slug", "verified-list"]
          : ["score", "health", "cheapest known price", "shorter slug"],
        ...(verifiedListEnabled() ? { verifiedList: routeOnVerifiedList(t) } : {}),
      },
      category: t.category,
      description: t.description,
      score,
      health: t.health,
      ...(Array.isArray(t.networks) && t.networks.length ? { networks: t.networks } : {}),
      // Says when those networks were inherited from the seller rather than
      // observed on this route's own 402 (see decoratedRemoteTools).
      ...(t.networksInferred ? { networksInferred: true } : {}),
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
      ranking: verifiedListEnabled()
        ? "deterministic lexical match on slug, name and description; ties broken by health, then cheapest known price, then shorter slug, then presence on the operator-configured verified-list feed"
        : "deterministic lexical match on slug, name and description; ties broken by health, then cheapest known price, then shorter slug",
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
      source: "https://github.com/MikeyPetrillo/Agent402",
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

// "What agents actually buy" — the demand-composition panel. External tools
// ranked by DISTINCT verified wallets (breadth of demand, not dollars): the
// primitives the most independent agents reach for. Data from the sales ledger
// via topByBuyers(); canary/burner traffic is already excluded there. Renders
// an honest empty state before the first attributable external sale lands.
export function whatAgentsBuyHtml(buyRows) {
  const rows = Array.isArray(buyRows) ? buyRows.filter((r) => r && r.buyers > 0) : [];
  const max = rows.reduce((m, r) => Math.max(m, r.buyers), 0) || 1;
  const bars = rows.map((r) => {
    const pct = Math.max(6, Math.round((r.buyers / max) * 100));
    return `<div style="display:flex;align-items:center;gap:12px;font-family:var(--font-mono);font-size:13px;line-height:1.3;">
      <a href="/tools/${esc(r.slug)}" style="flex:0 0 160px;color:var(--ink);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.slug)}</a>
      <div style="flex:1;min-width:50px;height:15px;background:var(--hairline);position:relative;">
        <div style="position:absolute;inset:0 auto 0 0;width:${pct}%;background:var(--accent);opacity:.82;"></div>
      </div>
      <span style="flex:0 0 92px;text-align:right;font-weight:700;white-space:nowrap;">${r.buyers} wallet${r.buyers === 1 ? "" : "s"}</span>
      <span style="flex:0 0 52px;text-align:right;color:var(--muted);white-space:nowrap;">&times;${r.sales}</span>
    </div>`;
  }).join("");
  const body = rows.length
    ? `<div style="display:flex;flex-direction:column;gap:9px;">${bars}</div>
       <p class="foot" style="margin:14px 0 0;">The tools the most independent agents reach for are live-data and compute primitives - things an LLM can't do itself. Ranked by distinct verified wallets on the money rails; our own canary and test traffic is excluded.</p>`
    : `<div class="pn">No attributable external sales in the window yet - the first independent wallet purchase populates this.</div>`;
  return `<div class="panel" id="demand">
  <div class="ph">
    <h2>What agents actually buy</h2>
    <div class="pn">Every external paid call, ranked by how many distinct wallets bought each tool over the last 30 days - breadth of demand, not dollars.</div>
  </div>
  <div style="padding:14px 18px;">${body}</div>
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
export function _cacheForTests() {
  return cache;
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
  const rows = interleaveBySeller([...ourTools, ...flattenedThirdPartyTools(excludeOrigin)]);
  const q = String(search || "").trim().toLowerCase();
  const terms = q ? q.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 8) : [];
  const cat = String(category || "").trim().toLowerCase();
  const net = String(network || "").trim().toLowerCase();

  const src = String(source || "").trim().toLowerCase();
  const filtered = rows.filter((t) => {
    if (src === "ours" && !t.ours) return false;
    if (src === "third-party" && t.ours) return false;
    if (cat && String(t.category || "").toLowerCase() !== cat) return false;
    if (net && !(t.networks || []).some((n) => String(n).toLowerCase().includes(net))) return false;
    if (!terms.length) return true;
    const hay = `${t.name} ${t.description} ${t.route} ${t.sellerName} ${(t.tags || []).join(" ")}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });

  const off = Math.max(0, parseInt(offset, 10) || 0);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  return {
    total: rows.length,
    ours: rows.filter((t) => t.ours).length,
    thirdParty: rows.filter((t) => !t.ours).length,
    matched: filtered.length,
    offset: off,
    limit: lim,
    described: filtered.filter((t) => t.described).length,
    results: filtered.slice(off, off + lim),
  };
}

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
function interleaveBySeller(rows) {
  const pass = (subset) => {
    const bySeller = new Map();
    for (const r of subset) {
      const k = r.sellerName || r.seller;
      if (!bySeller.has(k)) bySeller.set(k, []);
      bySeller.get(k).push(r);
    }
    const groups = [...bySeller.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([, list]) => list.sort((a, b) => String(a.route).localeCompare(String(b.route))));
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
  const out = [];
  const seen = new Set();
  for (const [origin, v] of cache.entries()) {
    if (!origin.startsWith("https:")) continue; // same bar as /api/index/register
    const normOrigin = origin.replace(/\/+$/, "").toLowerCase();
    if (self && normOrigin === self) continue;
    if (normOrigin === "https://agent402.tools") continue;
    if (v?.error) continue;
    if (healthScore(v) <= 0) continue;
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
  out.sort((a, b) => (b.described - a.described) || a.sellerName.localeCompare(b.sellerName) || a.route.localeCompare(b.route));
  flatCache = { at: Date.now(), rows: out, self };
  return out;
}

/** Category rollup for the catalog's filter chips. */
export function indexedToolCategories(excludeOrigin = "") {
  const counts = new Map();
  for (const t of flattenedThirdPartyTools(excludeOrigin)) counts.set(t.category, (counts.get(t.category) || 0) + 1);
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

export function _resetFlatCacheForTest() { flatCache = { at: 0, rows: [], self: "" }; }
// KNOWN ROUTER LIMITATION (found 2026-09-01, sol.blockrun): the resolver's
// liveness probe sends an empty `{}` and treats only HTTP 402 as "live". A
// seller that VALIDATES the request body BEFORE issuing its 402 (returning
// 400/422 with no challenge on an empty body) therefore fails the probe and
// is never routed to, even though it is a perfectly good paid endpoint - its
// GET-shaped siblings resolve fine. sol.blockrun's /chat/completions is the
// live example (400 on {}, no payment-required header to distinguish it from
// a genuine bad request). Fixing this needs a probe that sends a
// shape-plausible body per the tool's input schema, or a seller convention
// of 402-before-validate; deferred as its own change, not bolted onto the
// Solana-rail work. Tracked here so the next reader does not re-discover it.
