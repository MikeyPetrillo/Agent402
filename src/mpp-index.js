// MPP Index — a live, independently-verified seller directory for the MPP
// payment protocol (the IETF-track "Payment" HTTP auth scheme -
// `Authorization: Payment` / `WWW-Authenticate: Payment`), parallel to the
// existing x402 crawler (src/x402-index.js) but for a different seller
// population - sellers that speak MPP, not necessarily x402.
//
// Discovery source: https://mpp.dev/api/services, the same registry mppx's own
// CLI (`services list`) reads (see node_modules/mppx/src/cli/cli.ts). It ships
// rich, structured per-service data (description, categories, tags, docs,
// priced endpoints) - unlike x402-index.js, which has to derive most of that
// itself from raw manifest/OpenAPI crawling, this only needs to independently
// VERIFY what the registry already claims.
//
// Verification is the honesty gate: a registry row is never shown as a seller
// until we've made a real, unpaid request to one of its actual endpoints and
// confirmed the response genuinely carries a `WWW-Authenticate: Payment`
// challenge (src/x402-index.js's own isMppChallenge(), reused here rather than
// duplicated). A registry's claimed count is not truth until independently
// probed - the same "crawled, not curated" discipline the x402 side already
// follows (see the registry-instance-inflation and scan-evidence-honesty
// lessons in project history).
//
// Same architecture as x402-index.js throughout, deliberately scoped down:
// one discovery source (not four), no Bazaar-style pagination, no per-path
// backoff matrix (one representative endpoint per seller, not four candidate
// manifest paths) - grow this only if a second real MPP registry surfaces.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady, leased } from "./state-db.js";
// Each store is one JSON document: on the volume, or in the state database
// when one is configured (imported from the file once).
const docs = new Map();
const docFor = (file) => { let d = docs.get(file); if (!d) { d = createJsonDocument({ file, log: () => {} }); docs.set(file, d); } return d; };
import { timedSync } from "./boot-timing.js";
import { safeFetch, assertPublicUrl, ssrfDispatcher } from "./tools/fetch-guard.js";
import { validateOriginInput, isMppChallenge, mppDualStackOrigins } from "./x402-index.js";

export { validateOriginInput };

const MPP_DISCOVERY_URL = process.env.MPP_DISCOVERY_URL || "https://mpp.dev/api/services";
// Second seed source (2026-08-19): MPPScan, the public MPP registry that
// aggregates sellers by origin (mpp.dev's own docs point sellers there for
// self-registration). It has no JSON API we could find; its server-rendered
// page embeds the origin list it renders, so we read that. Seeds only - every
// origin still has to pass OUR live probe before it is listed. Measured at
// launch: 223 origins there vs 99 usable from the mpp.dev registry.
const MPPSCAN_DISCOVERY_URL = process.env.MPPSCAN_DISCOVERY_URL || "https://www.mppscan.com/";
// MPPScan's tRPC list endpoint (found by watching the page's own network
// calls): `servers.list` with timeframeDays=0 is the all-time set (314 rows at
// launch vs 222 on the rendered page), 200 per page, each row carrying name /
// description / url / logoUrl. Primary source; the page scrape is the fallback.
const MPPSCAN_API_URL = process.env.MPPSCAN_API_URL || "https://www.mppscan.com/api/trpc/servers.list";
const MPPSCAN_PAGE_SIZE = 200;
const MPPSCAN_MAX_PAGES = 10;
// The MPP discovery format (mpp.dev/protocol/discovery): a seller's
// /openapi.json carries `x-payment-info` on paid operations. For origins the
// mpp.dev registry does not describe (MPPScan-only seeds, self-serve entries
// without a hint), that document is where a real priced path comes from, so
// the probe hits a paywalled endpoint instead of the bare root.
const MAX_DISCOVERY_DOC_BYTES = 2 * 1024 * 1024;
const DISCOVERY_DOC_TTL_MS = 60 * 60 * 1000;
const MPP_CRAWL_INTERVAL_MS = 30 * 60 * 1000; // 30 min - same politeness as the x402 crawler

/** Human label for the MPP crawl cadence, derived so served copy cannot drift. */
export function mppCrawlIntervalLabel() {
  const mins = Math.round(MPP_CRAWL_INTERVAL_MS / 60000);
  if (mins % 60 === 0 && mins >= 60) {
    const h = mins / 60;
    return h === 1 ? "every hour" : `every ${h} hours`;
  }
  return `every ${mins} minutes`;
}
const MPP_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hr - registries don't change fast
const MPP_CRAWL_CONCURRENCY = 10; // ~150 known services total; no need for x402's 25
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 8000;

// Map<origin, sellerEntry> — verified + registry-sourced state, keyed by the
// service's actual API host (registry `serviceUrl`, or the submitted origin
// for self-serve entries with no registry backing).
const cache = new Map();
// Origins discovered from the mpp.dev registry.
const discoveredSeeds = new Set();

// --- self-serve listing (POST /api/mpp-index/register) ---------------------
export const MPP_SUBMITTED_SEEDS_FILE = process.env.MPP_SUBMITTED_SEEDS_FILE || "/data/mpp-submitted-seeds.json";
const submittedSeeds = new Set();
// Optional probe hint per self-submitted origin: { path, method }. MPP has no
// well-known discovery path (see pickProbeTarget), so a seller not yet in the
// registry can name the priced endpoint its 402 lives on instead of being
// probed at "/" only - the follow-up pickProbeTarget's comment asked for.
// Persisted with the seed; a hint is only ever recorded once it verified.
const submittedHints = new Map();
const DEFAULT_MAX_SUBMITTED_SEEDS = 2000; // same ceiling/reasoning as the x402 side

/** Validate a submitter-supplied probe path/method. Pure; exported for tests. */
export function validateProbeHint({ path, method } = {}) {
  const out = {};
  if (path !== undefined && path !== null && path !== "") {
    const p = String(path).trim();
    if (p.length > 200) return { error: "path too long (max 200 chars)" };
    if (!p.startsWith("/")) return { error: "path must start with /" };
    if (/[?#\s]/.test(p) || p.includes("..") || /[^A-Za-z0-9._~!$&'()*+,;=:@%\/-]/.test(p)) return { error: "path may only contain URL path characters (no query, fragment, whitespace or ..)" };
    out.path = p;
  }
  if (method !== undefined && method !== null && method !== "") {
    const m = String(method).trim().toUpperCase();
    if (m !== "GET" && m !== "POST") return { error: "method must be GET or POST" };
    out.method = m;
  }
  return out;
}
let submittedSeedsCap = DEFAULT_MAX_SUBMITTED_SEEDS;

/** Test hook: set (or, with no arg, reset) the submission cap. */
export function __testSetSubmittedCap(n) {
  submittedSeedsCap = typeof n === "number" && n >= 0 ? n : DEFAULT_MAX_SUBMITTED_SEEDS;
}

export function loadSubmittedSeeds() {
  const d = docFor(MPP_SUBMITTED_SEEDS_FILE);
  if (d.backend === "pg") return trackStoreReady(d.load(null).then(applySubmittedSeeds));
  applySubmittedSeeds(d.loadSync(null));
  return Promise.resolve();
}
function applySubmittedSeeds(arr) {
  try {
    for (const o of Array.isArray(arr) ? arr : []) {
      if (submittedSeeds.size >= submittedSeedsCap) break;
      // Two on-disk shapes: the original bare origin string, and (since the
      // probe hint landed) { origin, path?, method? }. Both load.
      if (typeof o === "string") { submittedSeeds.add(o); discoveredSeeds.add(o); continue; }
      if (o && typeof o.origin === "string") {
        submittedSeeds.add(o.origin); discoveredSeeds.add(o.origin);
        const h = validateProbeHint(o);
        if (!h.error && (h.path || h.method)) submittedHints.set(o.origin, h);
      }
    }
  } catch { /* absent file / no volume - in-memory only */ }
}

function persistSubmittedSeeds() {
  try {
    const rows = [...submittedSeeds].map((origin) => (submittedHints.has(origin) ? { origin, ...submittedHints.get(origin) } : origin));
    void docFor(MPP_SUBMITTED_SEEDS_FILE).save(rows);
  } catch { /* best-effort - no volume in local/dev */ }
}

/** Test hook: clear submitted-seed state between test cases. */
export function __testResetSubmitted() { submittedSeeds.clear(); submittedHints.clear(); }

// ---------------------------------------------------------------------------
// Registry discovery
// ---------------------------------------------------------------------------

/** Fetch the mpp.dev services registry and index it by origin (serviceUrl).
 *  Never throws - a discovery failure just means no NEW seeds this cycle;
 *  already-discovered origins keep crawling on their existing schedule.
 *
 *  KNOWN GAP (measured 2026-08-17): 42 of 141 live registry entries are
 *  hosted as per-tenant PATHS on one shared gateway domain
 *  (mpp.orthogonal.com/<tenant>, e.g. /apollo, /tavily, /serper - real,
 *  distinct businesses, just multi-tenant-hosted rather than each on its own
 *  subdomain). validateOriginInput() requires a bare origin (no path) - the
 *  same rule the x402 side uses, where "one origin = one seller" is a safe
 *  assumption for self-serve registration. It is NOT a safe assumption for
 *  THIS registry's gateway-hosted tenants, so they are silently excluded from
 *  discovery today (99 of 141 make it through). This is a deliberate,
 *  documented scope limit for the first pass, not a silent drop: fixing it
 *  needs an origin+base-path seller key for discovery-sourced entries only
 *  (self-serve registration should keep requiring a bare origin from the
 *  submitter) - left for a follow-up if gateway-hosted MPP sellers turn out
 *  to be a meaningful share of the ecosystem going forward. */
export const discoverMppRegistry = leased("mpp-index-discover-registry", { ttlMs: 10 * 60_000, failOpen: true }, discoverMppRegistryUnleased);
async function discoverMppRegistryUnleased() {
  try {
    const { html } = await safeFetch(MPP_DISCOVERY_URL, { maxBytes: MAX_REGISTRY_BYTES, headers: { Accept: "application/json" } });
    const parsed = JSON.parse(html);
    const services = Array.isArray(parsed?.services) ? parsed.services : [];
    let added = 0, skippedPathScoped = 0;
    for (const svc of services) {
      const raw = String(svc?.serviceUrl || svc?.url || "").trim();
      const v = validateOriginInput(raw);
      if (v.error) { skippedPathScoped++; continue; }
      registryByOrigin.set(v.origin, svc);
      if (!discoveredSeeds.has(v.origin)) added++;
      discoveredSeeds.add(v.origin);
    }
    discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: Date.now(), services: services.length, added, skippedPathScoped, error: null };
    return discoveryStatus;
  } catch (e) {
    discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: Date.now(), services: 0, added: 0, skippedPathScoped: 0, error: String(e?.message || e).slice(0, 200) };
    return discoveryStatus;
  }
}

// Raw registry rows, keyed by origin - the source of the rich display fields
// (description, categories, tags, docs, endpoints) a verification probe alone
// can't produce. Map<origin, registryServiceObject>.
const registryByOrigin = new Map();
let discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: null, services: 0, added: 0, error: null };

/** Pull the origin list MPPScan renders server-side. Pure; exported for tests.
 *  Tolerates both the raw HTML (JSON is escaped inside a script payload) and
 *  an already-unescaped body. Only https origins that pass validateOriginInput
 *  come back, de-duplicated. */
export function parseMppScanOrigins(html) {
  const text = String(html || "").replace(/\\"/g, '"');
  const out = new Set();
  // One parse per list item: `\s*(?:,\s*)?` - never two adjacent `\s*` with an
  // optional comma between them, which backtracks polynomially on a long
  // whitespace run with no closing bracket (third-party page = attacker-shaped
  // input; 30k spaces took ~1s before, 0ms now). Pinned in test-mpp-index.
  const re = /"originUrls":\s*\[((?:"https?:\/\/[^"]+"\s*(?:,\s*)?)+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    for (const u of m[1].match(/"https?:\/\/[^"]+"/g) || []) {
      const v = validateOriginInput(u.slice(1, -1));
      if (!v.error) out.add(v.origin);
    }
  }
  return [...out];
}

let mppScanStatus = { url: MPPSCAN_API_URL, fetchedAt: null, origins: 0, added: 0, error: null };
const seedSource = new Map(); // origin -> "registry" | "mppscan" | "submitted"
// MPPScan's own metadata per origin (name/description/url/logo) - the display
// fields for sellers the mpp.dev registry does not describe. Third-party
// content: rendered only through esc()/safeHref() like registry fields.
const mppScanByOrigin = new Map();

/** Parse one MPPScan `servers.list` response into {total, rows[{origin,name,
 *  description,url,logoUrl}]}. Pure; exported for tests. Rows whose url is
 *  not a valid bare https origin are dropped (same rule as the registry). */
export function parseMppScanList(body) {
  const j = typeof body === "string" ? JSON.parse(body) : body;
  const r = j?.result?.data?.json ?? (Array.isArray(j) ? j[0]?.result?.data?.json : null);
  const list = Array.isArray(r?.origins) ? r.origins : [];
  const rows = [];
  for (const o of list) {
    const v = validateOriginInput(String(o?.url || ""));
    if (v.error) continue;
    rows.push({
      origin: v.origin,
      name: typeof o.name === "string" ? o.name.slice(0, 120) : null,
      description: typeof o.description === "string" ? o.description.slice(0, 600) : null,
      url: v.origin,
      logoUrl: typeof o.logoUrl === "string" && /^https:\/\//.test(o.logoUrl) ? o.logoUrl.slice(0, 300) : null,
      resourceCount: Number.isFinite(Number(o.resourceCount)) ? Number(o.resourceCount) : null,
    });
  }
  return { total: Number.isFinite(Number(r?.total)) ? Number(r.total) : rows.length, rows };
}

/** Third seed source: origins OUR OWN x402 crawl already saw answering with
 *  an MPP challenge (dual-stack sellers). Automatic detection - no registry,
 *  no submission. Pure over the injected list; exported for tests. */
export function seedFromOrigins(origins, source = "x402-crawl") {
  let added = 0;
  for (const raw of origins || []) {
    const v = validateOriginInput(String(raw || ""));
    if (v.error) continue;
    if (!discoveredSeeds.has(v.origin)) { added++; if (!seedSource.has(v.origin)) seedSource.set(v.origin, source); }
    discoveredSeeds.add(v.origin);
  }
  return added;
}
let x402CrawlSeedStatus = { fetchedAt: null, origins: 0, added: 0 };
export function discoverFromX402Crawl(origins = mppDualStackOrigins()) {
  const added = seedFromOrigins(origins, "x402-crawl");
  x402CrawlSeedStatus = { fetchedAt: Date.now(), origins: origins.length, added };
  return x402CrawlSeedStatus;
}

function mppScanListUrl(page) {
  const input = encodeURIComponent(JSON.stringify({ json: { page, pageSize: MPPSCAN_PAGE_SIZE, sorting: { desc: true, id: "tx_count" }, timeframeDays: 0 } }));
  return `${MPPSCAN_API_URL}?input=${input}`;
}

/** Discover seeds from MPPScan: the tRPC list (all pages), falling back to
 *  the rendered page's origin list if the API fails or changes shape. Never
 *  throws. */
export const discoverMppScan = leased("mpp-index-discover-scan", { ttlMs: 10 * 60_000, failOpen: true }, discoverMppScanUnleased);
async function discoverMppScanUnleased() {
  const seen = new Set();
  let added = 0, total = 0, error = null, source = "api";
  try {
    for (let page = 0; page < MPPSCAN_MAX_PAGES; page++) {
      const { html } = await safeFetch(mppScanListUrl(page), { maxBytes: MAX_REGISTRY_BYTES, headers: { Accept: "application/json" } });
      const { total: t, rows } = parseMppScanList(html);
      total = t;
      for (const row of rows) {
        seen.add(row.origin);
        mppScanByOrigin.set(row.origin, row);
        if (!discoveredSeeds.has(row.origin)) { added++; if (!seedSource.has(row.origin)) seedSource.set(row.origin, "mppscan"); }
        discoveredSeeds.add(row.origin);
      }
      if (!rows.length || (page + 1) * MPPSCAN_PAGE_SIZE >= total) break;
    }
    if (!seen.size) throw new Error("servers.list returned no usable origins");
  } catch (e) {
    // Fallback: the rendered page's originUrls list (no metadata, but seeds).
    source = "page";
    error = String(e?.message || e).slice(0, 200);
    try {
      const { html } = await safeFetch(MPPSCAN_DISCOVERY_URL, { maxBytes: MAX_REGISTRY_BYTES, headers: { Accept: "text/html" } });
      for (const o of parseMppScanOrigins(html)) {
        seen.add(o);
        if (!discoveredSeeds.has(o)) { added++; if (!seedSource.has(o)) seedSource.set(o, "mppscan"); }
        discoveredSeeds.add(o);
      }
      if (seen.size) error = `api: ${error}; page fallback used`;
      else error = `api: ${error}; page: no originUrls found`;
    } catch (e2) {
      error = `api: ${error}; page: ${String(e2?.message || e2).slice(0, 120)}`;
    }
  }
  mppScanStatus = { url: MPPSCAN_API_URL, source, fetchedAt: Date.now(), origins: seen.size, total, added, error };
  return mppScanStatus;
}

/** From an MPP discovery document (OpenAPI 3.1 with x-payment-info), pick a
 *  paid operation to probe: prefer GET, then POST; the path must be a plain
 *  path (no templates). Pure; exported for tests. Returns null when nothing
 *  priced is declared. */
export function probeTargetFromDiscovery(doc) {
  const paths = doc && typeof doc === "object" && doc.paths && typeof doc.paths === "object" ? doc.paths : null;
  if (!paths) return null;
  const candidates = [];
  for (const [path, item] of Object.entries(paths)) {
    if (typeof path !== "string" || !path.startsWith("/") || /[{}:*]/.test(path) || item == null || typeof item !== "object") continue;
    for (const method of ["get", "post"]) {
      const op = item[method];
      if (op && typeof op === "object" && (op["x-payment-info"] || item["x-payment-info"])) candidates.push({ method: method.toUpperCase(), path });
    }
  }
  return candidates.find((c) => c.method === "GET") || candidates[0] || null;
}

const discoveryDocCache = new Map(); // origin -> { at, target|null }
/** Fetch `${origin}/openapi.json` (guarded, capped, cached 1h) and derive a
 *  probe target. Never throws; null on any failure. */
async function discoveryProbeTarget(origin) {
  const hit = discoveryDocCache.get(origin);
  if (hit && Date.now() - hit.at < DISCOVERY_DOC_TTL_MS) return hit.target;
  let target = null;
  try {
    const { html } = await safeFetch(`${origin}/openapi.json`, { maxBytes: MAX_DISCOVERY_DOC_BYTES, headers: { Accept: "application/json" }, timeoutMs: PROBE_TIMEOUT_MS });
    const t = probeTargetFromDiscovery(JSON.parse(html));
    if (t) target = { method: t.method, url: `${origin}${t.path}` };
  } catch { target = null; }
  discoveryDocCache.set(origin, { at: Date.now(), target });
  return target;
}

// ---------------------------------------------------------------------------
// Backoff (per origin - one representative endpoint per seller, unlike the
// x402 side's per-origin+path matrix, since MPP verification only ever probes
// one URL per seller).
// ---------------------------------------------------------------------------
const CRAWL_BACKOFF_STEPS_MS = [0, 0, 0, 0, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const crawlBackoff = new Map(); // origin -> { fails, nextAt }

export function probeDue(origin, now = Date.now()) {
  const b = crawlBackoff.get(origin);
  return !b || now >= b.nextAt;
}
function noteProbeOutcome(origin, ok, now = Date.now()) {
  if (ok) { crawlBackoff.delete(origin); return; }
  const fails = (crawlBackoff.get(origin)?.fails || 0) + 1;
  const step = CRAWL_BACKOFF_STEPS_MS[Math.min(fails, CRAWL_BACKOFF_STEPS_MS.length - 1)];
  crawlBackoff.set(origin, { fails, nextAt: now + step });
}

// ---------------------------------------------------------------------------
// Live verification - the honesty gate
// ---------------------------------------------------------------------------

/** Pick a real, priced endpoint to probe from a registry row - prefer GET (no
 *  body to guess). Falls back to the bare origin root for self-serve entries
 *  with no registry backing (best-effort; a seller with no advertised paths
 *  is probed at "/").
 *
 *  KNOWN LIMITATION (measured live 2026-08-17): unlike x402, which defines a
 *  standard discovery path (/.well-known/x402) every seller can be probed at
 *  regardless of their own API layout, MPP has no equivalent well-known
 *  convention (confirmed: no such path anywhere in the mppx package source).
 *  So a self-serve submission for a genuinely NEW seller not yet in the
 *  mpp.dev registry can only be verified at the bare origin root, which fails
 *  for any seller whose paywall is scoped to specific API paths rather than
 *  the root itself (live-verified: a REAL, working MPP seller correctly fails
 *  root-only verification and only succeeds once its real endpoint is known
 *  from the registry). Self-serve
 *  registration today works well for registry-known sellers (the common
 *  case) but is honestly limited for brand-new ones; the natural follow-up is
 *  accepting an optional path in the registration request so a submitter can
 *  point at their own real endpoint, mirroring what the registry already
 *  provides for discovered sellers. Not built here - out of Stage 1's scope,
 *  and not a silent gap: it fails HONESTLY (unverified, real reason given),
 *  never a false positive. */
export function pickProbeTarget(origin, svc, hint = submittedHints.get(origin)) {
  const endpoints = Array.isArray(svc?.endpoints) ? svc.endpoints : [];
  const priced = endpoints.filter((e) => e && typeof e.path === "string" && e.path.startsWith("/"));
  const pick = priced.find((e) => String(e.method || "GET").toUpperCase() === "GET") || priced[0];
  if (pick) return { method: String(pick.method || "GET").toUpperCase(), url: `${origin}${pick.path}` };
  // No registry endpoints: the submitter's own hint (validated at submission),
  // else the bare origin root (the caller may first try the seller's own MPP
  // discovery document - see resolveProbeTarget).
  if (hint && (hint.path || hint.method)) return { method: hint.method || "GET", url: `${origin}${hint.path || ""}` };
  return { method: "GET", url: origin };
}

/** Full target resolution: registry endpoints > submitted hint > the seller's
 *  /openapi.json x-payment-info operation > bare root. */
async function resolveProbeTarget(origin, svc) {
  const t = pickProbeTarget(origin, svc);
  if (t.url !== origin) return t;
  return (await discoveryProbeTarget(origin)) || t;
}

/** Make one unpaid request to `target` and confirm a genuine MPP challenge.
 *  Mirrors x402-index.js's probePaywall() exactly: raw fetch + assertPublicUrl
 *  + ssrfDispatcher, NOT safeFetch() - safeFetch() throws on the 401/402 this
 *  probe is specifically trying to observe, and doesn't expose headers. */
async function probeMppChallenge({ method, url }) {
  try {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) },
      ...(method !== "GET" ? { body: "{}" } : {}),
      dispatcher: ssrfDispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const challenge = res.headers.get("www-authenticate");
    const mpp = isMppChallenge(challenge);
    // A genuine MPP challenge rides a 401 or 402 - either is a live, healthy
    // "payment required" answer; anything else (200, 404, 5xx) is not.
    const statusOk = res.status === 401 || res.status === 402;
    const offers = mpp ? await parseOffers(challenge) : [];
    return { ok: mpp && statusOk, status: res.status, url, at: Date.now(), offers, error: mpp ? null : "no WWW-Authenticate: Payment challenge on the probed endpoint" };
  } catch (e) {
    return { ok: false, status: 0, url, at: Date.now(), offers: [], error: String(e?.message || e).slice(0, 160) };
  }
}

/** The payment methods a live challenge actually offers - method/intent,
 *  recipient, currency, chain, quoted amount - parsed with mppx's own codec
 *  (never a hand-rolled header parser; the wire shape is mppx's, see
 *  src/mpp-tempo.js). This is what turns "verified" into rankable: the
 *  tempo/charge recipient is the address the seller is PAID at, and inbound
 *  transfers to it on Tempo are the on-chain settlement signal
 *  (src/mpp-leaderboard.js). Never throws; an unparseable header yields []
 *  and the seller stays verified on the raw-prefix check above - a leaderboard
 *  gap must not demote a listing. Exported for tests. */
export async function parseOffers(wwwAuth) {
  try {
    const { Challenge } = await import("mppx");
    const list = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": String(wwwAuth) }));
    return list.map((c) => {
      const r = c?.request || {};
      const recipient = typeof r.recipient === "string" && /^0x[0-9a-fA-F]{40}$/.test(r.recipient) ? r.recipient.toLowerCase() : null;
      const chainId = r.methodDetails?.chainId;
      return {
        method: String(c?.method || ""), intent: String(c?.intent || ""),
        recipient,
        currency: typeof r.currency === "string" ? r.currency.toLowerCase() : null,
        chainId: Number.isFinite(Number(chainId)) ? Number(chainId) : null,
        amount: typeof r.amount === "string" || typeof r.amount === "number" ? String(r.amount) : null,
      };
    }).slice(0, 8);
  } catch { return []; }
}

const HEALTH_WINDOW = 5;

/** Verify one origin (registry-sourced or self-submitted). Updates `cache`
 *  in place. Never throws - a failed probe just leaves `verified: false` with
 *  the reason recorded, same posture as x402-index.js's crawlSeller(). */
export async function verifyMppSeller(origin) {
  const svc = registryByOrigin.get(origin) || null;
  const target = await resolveProbeTarget(origin, svc);
  const result = await probeMppChallenge(target);
  noteProbeOutcome(origin, result.ok);
  const prior = cache.get(origin);
  const history = [...(prior?.history || []), result.ok ? 1 : 0].slice(-HEALTH_WINDOW);
  const scan = svc ? null : mppScanByOrigin.get(origin) || null;
  const entry = {
    origin,
    name: svc?.name || scan?.name || origin.replace(/^https?:\/\//, ""),
    url: svc?.url || scan?.url || origin,
    serviceUrl: origin,
    description: svc?.description || scan?.description || null,
    categories: Array.isArray(svc?.categories) ? svc.categories : [],
    tags: Array.isArray(svc?.tags) ? svc.tags : [],
    docs: svc?.docs || null,
    icon: svc?.icon || scan?.logoUrl || null,
    realm: svc?.realm || null,
    provider: svc?.provider || null,
    endpoints: Array.isArray(svc?.endpoints) ? svc.endpoints : [],
    probedUrl: target.url,
    // Live-observed payment offers (see parseOffers). Kept from the last
    // SUCCESSFUL probe so a transient probe failure does not blank the
    // recipient the leaderboard ranks on.
    offers: result.ok ? (result.offers || []) : (prior?.offers || []),
    verified: result.ok,
    verifiedAt: result.ok ? result.at : (prior?.verified ? prior.verifiedAt : null),
    lastProbeAt: result.at,
    lastProbeOk: result.ok,
    lastProbeError: result.error,
    history,
    fromRegistry: !!svc,
    fromSubmission: submittedSeeds.has(origin),
    fromMppScan: seedSource.get(origin) === "mppscan",
    fromX402Crawl: seedSource.get(origin) === "x402-crawl",
  };
  cache.set(origin, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Self-serve registration
// ---------------------------------------------------------------------------

/** Probe + list a submitted origin. `verify` is injectable for tests; defaults
 *  to the real verifyMppSeller. Successful probes persist the origin as a seed. */
export async function registerMppOrigin(origin, { verify, path, method } = {}) {
  const existing = cache.get(origin);
  if (existing?.verified) return { listed: true, origin, seller: mppSellerSummary(existing) };
  if (!submittedSeeds.has(origin) && submittedSeeds.size >= submittedSeedsCap) {
    return { listed: false, origin, error: "submission list is full - open a GitHub issue to get seeded" };
  }
  const hint = validateProbeHint({ path, method });
  if (hint.error) return { listed: false, origin, error: hint.error };
  // Stage the hint so this verification probes it; keep it only if it verifies
  // (a wrong hint must not stick to an origin for the crawler to re-probe forever).
  const priorHint = submittedHints.get(origin);
  if (hint.path || hint.method) submittedHints.set(origin, hint);
  const doVerify = verify || verifyMppSeller;
  let entry;
  try { entry = await doVerify(origin); } catch (e) { entry = { verified: false, lastProbeError: String(e?.message || e) }; }
  if (!entry?.verified) { if (priorHint) submittedHints.set(origin, priorHint); else submittedHints.delete(origin); }
  // Own the cache write here rather than relying on doVerify's own side effect
  // (the real verifyMppSeller() already writes it; an injected test verifier
  // does not, and the snapshot/crawl-rotation contract must hold either way -
  // "registerMppOrigin succeeded" must always mean "the snapshot can see it").
  cache.set(origin, { ...entry, origin });
  if (entry?.verified) {
    submittedSeeds.add(origin);
    discoveredSeeds.add(origin);
    persistSubmittedSeeds();
    return { listed: true, origin, seller: mppSellerSummary(cache.get(origin)) };
  }
  return { listed: false, origin, error: entry?.lastProbeError || "no MPP challenge (WWW-Authenticate: Payment) found on the probed endpoint" };
}

function mppSellerSummary(v) {
  return {
    name: v.name,
    description: v.description,
    categories: v.categories,
    verified: v.verified,
    verifiedAt: v.verifiedAt ? new Date(v.verifiedAt).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Crawl loop
// ---------------------------------------------------------------------------
let crawlInFlight = false;
let crawlerTimer = null;
let discoveryTimer = null;

async function runPool(items, limit, worker) {
  const queue = items.slice();
  const n = Math.min(Math.max(limit, 1), queue.length);
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch { /* verifyMppSeller already catches; belt+braces */ }
    }
  });
  await Promise.all(workers);
}

export const runMppCrawl = leased("mpp-index-crawl", { ttlMs: 30 * 60_000, failOpen: true }, runMppCrawlUnleased);
async function runMppCrawlUnleased() {
  if (crawlInFlight) return;
  crawlInFlight = true;
  try {
    // Every cycle, fold in whatever the x402 crawler has detected as
    // dual-stack since last time (its cache keeps moving between our runs).
    discoverFromX402Crawl();
    const seeds = [...discoveredSeeds];
    const due = seeds.filter((o) => probeDue(o));
    await runPool(due, MPP_CRAWL_CONCURRENCY, verifyMppSeller);
  } finally {
    crawlInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Persistence - plain JSON, no DB, same pattern as x402-index.js's warm-start
// ---------------------------------------------------------------------------
export const MPP_INDEX_CACHE_FILE = process.env.MPP_INDEX_CACHE_FILE || "/data/mpp-index-cache.json";

export function persistMppIndexCache(file = MPP_INDEX_CACHE_FILE) {
  try {
    if (cache.size === 0) return false;
    const out = [...cache.entries()].filter(([, v]) => v.verified);
    if (!out.length) return false;
    void docFor(file).save({ savedAt: Date.now(), entries: out });
    return true;
  } catch { return false; }
}

export function loadPersistedMppIndexCache(file = MPP_INDEX_CACHE_FILE) {
  return timedSync("MPP index warm-start", file, () => _loadPersistedMppIndexCache(file));
}
function _loadPersistedMppIndexCache(file = MPP_INDEX_CACHE_FILE) {
  const d = docFor(file);
  if (d.backend === "pg") {
    // The row arrives after boot: warm the cache when it does.
    trackStoreReady(d.load(null).then((parsed) => { const n = applyMppIndexCache(parsed); if (n) console.log(`[mpp-index] warm-started ${n} sellers from the state database`); }));
    return 0;
  }
  return applyMppIndexCache(d.loadSync(null));
}
function applyMppIndexCache(parsed) {
  try {
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    let n = 0;
    for (const [origin, v] of entries) {
      if (typeof origin !== "string" || !origin || cache.has(origin)) continue;
      // Warm-started rows are shown as last-known-verified, never re-labelled
      // fresh - the next crawl cycle re-probes and either confirms or corrects
      // this within one interval, same posture as the x402 side's warmStarted flag.
      cache.set(origin, { ...v, warmStarted: true });
      discoveredSeeds.add(origin);
      n++;
    }
    return n;
  } catch { return 0; }
}

export function startMppCrawler() {
  if (crawlerTimer) return;
  loadSubmittedSeeds();
  const warmed = loadPersistedMppIndexCache();
  if (warmed) console.log(`[mpp-index] warm-started ${warmed} sellers from ${MPP_INDEX_CACHE_FILE}`);
  Promise.all([discoverMppRegistry(), discoverMppScan()]).then(() => runMppCrawl()).then(() => persistMppIndexCache());
  crawlerTimer = setInterval(() => { runMppCrawl().then(() => persistMppIndexCache()).catch(() => {}); }, MPP_CRAWL_INTERVAL_MS);
  discoveryTimer = setInterval(() => { discoverMppRegistry(); discoverMppScan(); }, MPP_DISCOVERY_INTERVAL_MS);
  if (typeof crawlerTimer.unref === "function") crawlerTimer.unref();
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
}

/** Stop the crawler (used by tests to keep the process exitable). */
export function stopMppCrawler() {
  if (crawlerTimer) { clearInterval(crawlerTimer); crawlerTimer = null; }
  if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
}

/** Test-only: fully reset in-memory state between test cases. */
export function __testReset() {
  cache.clear();
  discoveredSeeds.clear();
  registryByOrigin.clear();
  seedSource.clear();
  discoveryDocCache.clear();
  mppScanByOrigin.clear();
  x402CrawlSeedStatus = { fetchedAt: null, origins: 0, added: 0 };
  mppScanStatus = { url: MPPSCAN_API_URL, fetchedAt: null, origins: 0, added: 0, error: null };
  submittedSeeds.clear();
  crawlBackoff.clear();
  discoveryStatus = { url: MPP_DISCOVERY_URL, fetchedAt: null, services: 0, added: 0, error: null };
  stopMppCrawler();
}

// ---------------------------------------------------------------------------
// Snapshot - what the market page and nav panel consume
// ---------------------------------------------------------------------------

/** Synchronous, always-honest snapshot: only VERIFIED sellers count toward the
 *  headline number - never the raw registry size (mpp.dev claims 141 today;
 *  what we show is only what we've independently confirmed still answers with
 *  a real MPP challenge). Discovered-but-unverified origins are surfaced
 *  separately so the gap is visible, never silently dropped or silently
 *  counted. */
export function mppIndexSnapshot() {
  const all = [...cache.values()];
  const verified = all.filter((v) => v.verified);
  return {
    verifiedSellers: verified.length,
    discoveredTotal: discoveredSeeds.size,
    sellers: verified,
    discovery: discoveryStatus,
    discoveryMppScan: mppScanStatus,
    discoveryX402Crawl: x402CrawlSeedStatus,
    generatedAt: Date.now(),
  };
}
