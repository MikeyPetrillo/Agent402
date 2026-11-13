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
import { pathToFileURL } from "node:url";
import "../src/tls-distrust-boot.js"; // refuse TLS chains through a distrusted intermediate CA
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
  const out = { all: a.includes("--all"), sample: 0, routes: null, json: a.includes("--json") };
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
    indexed: body.index?.active === true, lastCrawledAt: body.index?.lastCrawledAt || null, quality: body.index?.quality || null,
  };
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
  for (const { endpoint, r } of results) {
    const tag = `${endpoint.method} ${endpoint.path}`;
    if (!r.ok) { unreadable++; rows.push({ route: tag, status: "UNREADABLE", detail: r.error }); console.log(`??  ${tag} - ${r.error}`); continue; }
    if (!r.valid) { invalid++; rows.push({ route: tag, status: "INVALID", detail: r.failed.join("; ") || r.rejectionReason || `statusCode ${r.statusCode}` }); console.log(`FAIL ${tag} - ${r.failed.join("; ") || r.rejectionReason || `HTTP ${r.statusCode}`}`); continue; }
    valid++;
    if (!r.indexed) notIndexed++;
    rows.push({ route: tag, status: "valid", indexed: r.indexed, lastCrawledAt: r.lastCrawledAt, quality: r.quality, advisory: r.advisory });
    console.log(`ok   ${tag} - valid${r.indexed ? ` · indexed (crawled ${r.lastCrawledAt || "?"})` : " · NOT in index"}${r.advisory.length ? ` · advisory: ${r.advisory.join(", ")}` : ""}${r.quality ? ` · quality ${JSON.stringify(r.quality)}` : ""}`);
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
