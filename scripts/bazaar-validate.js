#!/usr/bin/env node
// Bazaar listing validation - Coinbase CDP's keyless, read-only
// POST /platform/v2/x402/validate probes a LIVE https URL the way the Bazaar
// crawler does and reports the preflight checks (returns 402, PAYMENT-REQUIRED
// header, accepts shape, bazaar extension incl. input method + output
// example), a simulated facilitator accept/reject, and whether the resource is
// in the index (index.active, lastCrawledAt, quality). We never called it
// before 2026-08-19, so a broken 402 shape on one route could silently drop
// that listing for weeks; this turns the whole listing class into something
// we watch.
//
// Usage:
//   node scripts/bazaar-validate.js                  # flagship set + every non-JSON listing vs TARGET_URL (default prod)
//   node scripts/bazaar-validate.js --all            # every catalog endpoint (500+ calls - rate-paced)
//   node scripts/bazaar-validate.js --sample 40      # flagship + 40 random others
//   node scripts/bazaar-validate.js --routes /api/hash,/api/search
//   node scripts/bazaar-validate.js --mcp            # the connector's MCP tool listings (below)
// Exit 0 = every probed route readable AND valid; 1 = at least one route
// INVALID (our 402 shape / listing defect); 2 = no invalid route but at least
// one was unreadable (CDP-side: rate limit / outage - the check was partially
// blind, report loudly, do not page as our defect). Unreadable never counts
// as valid, and a partially blind run is never "OK".
//
// The validator needs a public https URL, so it runs against PRODUCTION (a
// probe/heartbeat leg), never against a CI localhost boot. Method comes from
// the catalog (/api/pricing): the first manual probe POSTed a GET route and
// read a 405 as "not x402" - the exact mistake this script exists to not make.
//
// --mcp checks the MCP tool listings instead (scripts/lib/mcp-listings.js).
// The CDP validator probes an HTTP route for a 402, and the connector answers
// its offer inside a tool result, so this check reads each offer itself: one
// unpaid tools/call per listed tool on TARGET_URL's /mcp, then the offer must
// name the resource `${LISTING_ORIGIN or TARGET_URL}/mcp`, carry a discovery
// extension of type "mcp" for that tool (toolName, an object inputSchema,
// transport streamable-http) that passes the protocol's own validators, and
// ask the list price on Base. It pays nothing and works against a local boot.
// Same exit codes: 1 = an offer that is not a valid MCP listing offer (a boot
// with no x402 on the connector included), 2 = the connector or the catalog
// could not be read. A listed tool the catalog does not carry is skipped with
// a note.
import { pathToFileURL } from "node:url";
import "../src/tls-distrust-boot.js"; // refuse TLS chains through a distrusted intermediate CA
import { mcpListingRoutes, mcpOfferProblems, MCP_LISTING_TOOLS } from "./lib/mcp-listings.js";
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const VALIDATE_URL = process.env.BAZAAR_VALIDATE_URL || "https://api.cdp.coinbase.com/platform/v2/x402/validate";
const CONCURRENCY = Math.max(1, Number(process.env.BAZAAR_VALIDATE_CONCURRENCY) || (process.argv.includes("--all") ? 1 : 3));
const PER_CALL_TIMEOUT_MS = Number(process.env.BAZAAR_VALIDATE_TIMEOUT_MS) || 45_000;
const MAX_429_RETRIES = Math.max(0, Number(process.env.BAZAAR_VALIDATE_429_RETRIES ?? 4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A whole run's deadline. A validator that answers 429 with a long Retry-After
// to every call would otherwise hold a default run (about 20 routes, 5 calls
// each) near half an hour. Past the deadline nothing waits or retries: every
// route not yet read is reported unreadable (exit 2 when none is INVALID), so
// the callers warn. Default 8 minutes for the default, --sample and --routes
// runs: the heartbeat's one run stays inside its 75-minute job beside its
// 48-minute loop, and the deploy step's three runs a minute apart take at most
// 26 minutes of a 120-minute job. --all is rate-paced over the whole catalog
// and has no deadline unless BAZAAR_VALIDATE_DEADLINE_MS sets one (0 = none).
const DEFAULT_DEADLINE_MS = 8 * 60_000;
export function runDeadlineMs(all = process.argv.includes("--all"), env = process.env) {
  const raw = env.BAZAAR_VALIDATE_DEADLINE_MS;
  if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return all ? 0 : DEFAULT_DEADLINE_MS;
}
const DEADLINE_ERROR = "run deadline reached before the validator answered for this route";

// Flagship = the routes whose listing we most want visible: the search front
// doors, the canary-proven federal-data pair, the router, the gateway, a
// skill pack, memory, and the cheapest/most-bought compute tool. Keep this
// list short - the heartbeat validates it hourly against CDP.
export const FLAGSHIP_PATHS = [
  "/api/search", "/api/answer", "/api/search-news", "/api/extract", "/api/render",
  "/api/vin-decode", "/api/geo-lookup", "/api/hash", "/api/sql-guard",
  "/api/route/execute", "/v1/auto/chat/completions", "/v1/embeddings",
  "/api/image-ocr", "/api/memory",
];

// A listing whose content type is not JSON (a row on /api/pricing that
// carries mimeType: the tools that answer raw bytes) is a shape of its own,
// so the default run validates every one of them beside the flagship set.
// One validator call each; capped so the default run never becomes a sweep.
export const NON_JSON_LISTING_MAX = 12;

/** The default run's endpoints: every non-JSON listing not in the flagship
 *  set (up to NON_JSON_LISTING_MAX) FIRST, then the flagship set, so a run
 *  the validator throttles to its deadline has read the non-JSON listings
 *  before it is cut. Exported for the test. */
export function defaultEndpoints(all) {
  const byPath = new Map(all.map((e) => [e.path, e]));
  const flagship = FLAGSHIP_PATHS.map((p) => byPath.get(p)).filter(Boolean);
  const missingFlagship = FLAGSHIP_PATHS.filter((p) => !byPath.has(p));
  const nonJsonAll = all.filter((e) => e.mimeType && e.mimeType !== "application/json" && !FLAGSHIP_PATHS.includes(e.path));
  const nonJson = nonJsonAll.slice(0, NON_JSON_LISTING_MAX);
  return { chosen: [...nonJson, ...flagship], flagship, nonJson, missingFlagship, nonJsonSkipped: nonJsonAll.length - nonJson.length };
}

function args() {
  const a = process.argv.slice(2);
  const out = { all: a.includes("--all"), sample: 0, routes: null, json: a.includes("--json"), mcp: a.includes("--mcp") };
  const si = a.indexOf("--sample"); if (si >= 0) out.sample = Math.max(0, Number(a[si + 1]) || 0);
  const ri = a.indexOf("--routes"); if (ri >= 0) out.routes = String(a[ri + 1] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return out;
}

async function catalogEndpoints() {
  const res = await fetch(`${TARGET}/api/pricing`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`/api/pricing HTTP ${res.status}`);
  const j = await res.json();
  const list = Array.isArray(j.endpoints) ? j.endpoints : [];
  if (!list.length) throw new Error("/api/pricing carried no endpoints[]");
  return list.map((e) => ({ method: String(e.method || "POST").toUpperCase(), path: String(e.path), slug: String(e.slug || e.path), price: e.price, ...(typeof e.mimeType === "string" ? { mimeType: e.mimeType } : {}) }));
}

/** One validate call. Returns {ok:true, valid, failed[], index, quality} or
 *  {ok:false, error} when the validator itself could not be read. Exported
 *  for the test. */
export async function validateOne(endpoint, { fetchImpl = fetch, validateUrl = VALIDATE_URL, base = TARGET, deadlineAt = 0 } = {}) {
  // Milliseconds left in the run (Infinity with no deadline).
  const left = () => (deadlineAt > 0 ? deadlineAt - Date.now() : Infinity);
  const resource = `${base}${endpoint.path}`;
  const method = endpoint.method === "GET" ? "GET" : "POST";
  let res, body;
  // CDP rate-limits the validator (measured 2026-08-19: HTTP 429 after ~200
  // calls in a full-catalog run). Honour Retry-After (capped) and retry a few
  // times before calling the route unreadable - a 429 is not a listing verdict.
  for (let attempt = 0; ; attempt++) {
    if (left() <= 0) return { ok: false, error: DEADLINE_ERROR };
    try {
      res = await fetchImpl(validateUrl, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ resource, method }), signal: AbortSignal.timeout(Math.max(1, Math.min(PER_CALL_TIMEOUT_MS, left()))),
      });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const ra = Number(res.headers.get("retry-after"));
        const waitMs = Math.min(60_000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000 * (attempt + 1)));
        // A wait that would pass the deadline is not taken.
        if (waitMs >= left()) return { ok: false, error: `${DEADLINE_ERROR} (last answer HTTP 429)` };
        await sleep(waitMs);
        continue;
      }
      const text = await res.text();
      try { body = JSON.parse(text); } catch { return { ok: false, error: `validator HTTP ${res.status} non-JSON: ${text.slice(0, 120)}` }; }
      break;
    } catch (e) {
      if (left() <= 0) return { ok: false, error: DEADLINE_ERROR };
      return { ok: false, error: `validator unreachable: ${e?.message || e}` };
    }
  }
  if (!res.ok || typeof body?.valid !== "boolean") {
    return { ok: false, error: `validator HTTP ${res.status}: ${JSON.stringify(body).slice(0, 160)}` };
  }
  const preflight = Array.isArray(body.preflight) ? body.preflight : [];
  // Only REQUIRED failures make a route invalid; advisory ones are surfaced
  // separately so we can improve listings without paging on them.
  const failed = preflight.filter((p) => p && p.passed === false && p.severity !== "advisory").map((p) => `${p.check}: ${p.detail || ""}${p.expected ? ` (expected ${p.expected}, got ${p.actual})` : ""}`.trim());
  const advisory = preflight.filter((p) => p && p.passed === false && p.severity === "advisory").map((p) => p.check);
  return {
    ok: true, valid: body.valid === true, statusCode: body.statusCode ?? null, failed, advisory,
    simulation: body.simulation?.outcome || null, rejectionReason: body.simulation?.rejectionReason || null,
    // A date from the validator, kept to date characters: it is printed into CI logs.
    indexed: body.index?.active === true, lastCrawledAt: String(body.index?.lastCrawledAt || "").replace(/[^0-9TZ:.+-]/g, "").slice(0, 40) || null, quality: body.index?.quality || null,
  };
}

/** Why an offer is not a valid MCP listing offer for a tool ([] when it is):
 *  the listing's own shape (mcpOfferProblems) and the protocol's validators
 *  over its discovery extension. `validators` is @x402/extensions/bazaar's
 *  { validateDiscoveryExtension, validateDiscoveryExtensionSpec }. Exported
 *  for the test. */
export function mcpListingOfferProblems(offer, { toolName, origin, micros = null }, validators) {
  const out = mcpOfferProblems(offer, { toolName, origin, micros });
  const ext = offer?.extensions?.bazaar;
  if (ext && typeof ext === "object") {
    for (const [name, fn] of Object.entries(validators || {})) {
      let r;
      try { r = fn(ext); } catch (e) { r = { valid: false, errors: [String(e?.message || e)] }; }
      if (!r?.valid) out.push(`${name}: ${(r?.errors || ["invalid"]).join(", ").slice(0, 200)}`);
    }
  }
  return out;
}

/** The --mcp run; returns the exit code. Every dependency is injectable so
 *  scripts/test-mcp-listing-tools.js runs it against a local server. */
export async function runMcpValidation({ target = TARGET, env = process.env, log = console.log, connect = null, fetchJson = null, validators = null } = {}) {
  const origin = String(env.LISTING_ORIGIN || target).replace(/\/+$/, "");
  const getJson = fetchJson || (async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  let pricing, spec;
  try { [pricing, spec] = await Promise.all([getJson(`${target}/api/pricing`), getJson(`${target}/openapi.json`)]); } catch (e) {
    log(`VALIDATOR UNREADABLE - the catalog could not be read (${String(e?.message || e).slice(0, 120)})`);
    return 2;
  }
  const routes = mcpListingRoutes(pricing);
  const absent = Object.keys(MCP_LISTING_TOOLS).filter((s) => !routes.some((r) => r.slug === s));
  if (absent.length) log(`note - MCP listing tools not in the live catalog (skipped): ${absent.map((s) => MCP_LISTING_TOOLS[s]).join(", ")}`);
  log(`bazaar-validate: ${routes.length} MCP tool listing offer(s) on ${target}/mcp, resource origin ${origin}`);
  const v = validators || await (async () => {
    const m = await import("@x402/extensions/bazaar");
    return { validateDiscoveryExtension: m.validateDiscoveryExtension, validateDiscoveryExtensionSpec: m.validateDiscoveryExtensionSpec };
  })();
  const { examplesFromOpenapi } = await import("./listing-coverage.js");
  const examples = examplesFromOpenapi(spec);
  const { connectMcp, askMcpOffer } = await import("./lib/mcp-x402-client.js");
  let mcp;
  try { mcp = await (connect || connectMcp)(target, { name: "agent402-bazaar-validate" }); } catch (e) {
    log(`VALIDATOR UNREADABLE - the connector could not be reached (${String(e?.message || e).slice(0, 120)})`);
    return 2;
  }
  let invalid = 0, unreadable = 0, valid = 0;
  try {
    for (const r of routes) {
      const tag = `MCP ${r.toolName}`;
      let asked;
      try { asked = await askMcpOffer(mcp.callTool, r.toolName, examples.get(`${r.method} ${r.path}`) || {}); } catch (e) {
        unreadable++; log(`??  ${tag} - the call did not answer (${String(e?.message || e).slice(0, 120)})`); continue;
      }
      const problems = asked.offer ? mcpListingOfferProblems(asked.offer, { toolName: r.toolName, origin, micros: r.micros }, v) : [`no x402 offer: ${asked.why}`];
      if (problems.length) { invalid++; log(`FAIL ${tag} - ${problems.join("; ")}`); continue; }
      valid++; log(`ok   ${tag} - valid MCP listing offer (resource ${origin}/mcp, type mcp, list price on Base)`);
    }
  } finally { await mcp.close(); }
  log(`\nsummary: ${JSON.stringify({ target, probed: routes.length, valid, invalid, unreadable })}`);
  if (invalid > 0) { log(`BAZAAR VALIDATION FAILED: ${invalid} invalid MCP listing offer(s)`); return 1; }
  if (unreadable > 0) { log(`VALIDATOR UNREADABLE for ${unreadable}/${routes.length} MCP listing offer(s)`); return 2; }
  if (!routes.length) { log("VALIDATOR UNREADABLE - the catalog carries no MCP listing tool"); return 2; }
  log("BAZAAR VALIDATION OK");
  return 0;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  const opt = args();
  if (opt.mcp) process.exit(await runMcpValidation());
  const all = await catalogEndpoints();
  const byPath = new Map(all.map((e) => [e.path, e]));
  let chosen;
  if (opt.routes) {
    chosen = opt.routes.map((p) => byPath.get(p) || { method: "POST", path: p, slug: p, price: "?" });
  } else if (opt.all) {
    chosen = all;
  } else {
    const picked = defaultEndpoints(all);
    const { missingFlagship } = picked;
    if (missingFlagship.length) console.log(`note - flagship paths not in the live catalog (skipped): ${missingFlagship.join(", ")}`);
    if (picked.nonJson.length) console.log(`note - ${picked.nonJson.length} non-JSON listing(s) validated beside the flagship set: ${picked.nonJson.map((e) => `${e.path} (${e.mimeType})`).join(", ")}`);
    if (picked.nonJsonSkipped) console.log(`note - ${picked.nonJsonSkipped} further non-JSON listing(s) not validated (cap ${NON_JSON_LISTING_MAX}); run --routes for them`);
    chosen = picked.chosen;
    if (opt.sample > 0) {
      const rest = all.filter((e) => !chosen.includes(e));
      // deterministic-ish spread: stride through the catalog instead of Math.random (reproducible runs)
      const stride = Math.max(1, Math.floor(rest.length / opt.sample));
      const want = chosen.length + opt.sample;
      for (let i = 0; i < rest.length && chosen.length < want; i += stride) chosen.push(rest[i]);
    }
  }
  console.log(`bazaar-validate: ${chosen.length} endpoint(s) against ${TARGET} via ${VALIDATE_URL} (concurrency ${CONCURRENCY})`);
  const deadlineMs = runDeadlineMs(opt.all);
  const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : 0;
  const results = await mapLimit(chosen, CONCURRENCY, async (e) => ({ endpoint: e, r: await validateOne(e, { deadlineAt }) }));

  let invalid = 0, unreadable = 0, valid = 0, notIndexed = 0;
  const rows = [];
  // A non-JSON listing (a row that carries a non-JSON mimeType) gets two
  // lines of its own, which the deploy and heartbeat steps grep:
  //   WARN not-indexed <route> (last crawl <date or unknown>)
  //     valid but not in the index. The index lags the validator by days, so
  //     this stays exit 0; it is the only sign of an indexer that dropped the
  //     listing after a crawl.
  //   NONJSON-INVALID <route>
  //     beside its FAIL line, so the caller can name the listing switch.
  const nonJson = (e) => typeof e.mimeType === "string" && e.mimeType !== "application/json";
  for (const { endpoint, r } of results) {
    const tag = `${endpoint.method} ${endpoint.path}`;
    if (!r.ok) { unreadable++; rows.push({ route: tag, status: "UNREADABLE", detail: r.error }); console.log(`??  ${tag} - ${r.error}`); continue; }
    if (!r.valid) { invalid++; rows.push({ route: tag, status: "INVALID", detail: r.failed.join("; ") || r.rejectionReason || `statusCode ${r.statusCode}` }); console.log(`FAIL ${tag} - ${r.failed.join("; ") || r.rejectionReason || `HTTP ${r.statusCode}`}`); if (nonJson(endpoint)) console.log(`NONJSON-INVALID ${tag}`); continue; }
    valid++;
    if (!r.indexed) notIndexed++;
    rows.push({ route: tag, status: "valid", indexed: r.indexed, lastCrawledAt: r.lastCrawledAt, quality: r.quality, advisory: r.advisory });
    console.log(`ok   ${tag} - valid${r.indexed ? ` · indexed (crawled ${r.lastCrawledAt || "?"})` : " · NOT in index"}${r.advisory.length ? ` · advisory: ${r.advisory.join(", ")}` : ""}${r.quality ? ` · quality ${JSON.stringify(r.quality)}` : ""}`);
    if (!r.indexed && nonJson(endpoint)) console.log(`WARN not-indexed ${tag} (last crawl ${r.lastCrawledAt || "unknown"})`);
  }
  const summary = { target: TARGET, probed: chosen.length, valid, invalid, unreadable, notIndexed };
  console.log(`\nsummary: ${JSON.stringify(summary)}`);
  if (opt.json) console.log(JSON.stringify({ summary, rows }, null, 2));
  // Verdict order: any INVALID route is our defect (1); otherwise any
  // unreadable route means the check was partially blind (2) - never "OK" on
  // a run that could not read everything it was asked to read.
  if (invalid > 0) { console.log(`BAZAAR VALIDATION FAILED: ${invalid} invalid route(s)`); process.exit(1); }
  if (unreadable > 0) { console.log(`VALIDATOR UNREADABLE for ${unreadable}/${chosen.length} route(s) - CDP-side (rate limit / outage); no listing verdict for those`); process.exit(2); }
  console.log("BAZAAR VALIDATION OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("bazaar-validate crashed:", e?.message || e); process.exit(2); });
}
