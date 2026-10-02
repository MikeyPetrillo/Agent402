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
//   node scripts/bazaar-validate.js                  # flagship set vs TARGET_URL (default prod)
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
const TARGET = (process.env.TARGET_URL || "https://agent402.tools").replace(/\/$/, "");
const VALIDATE_URL = process.env.BAZAAR_VALIDATE_URL || "https://api.cdp.coinbase.com/platform/v2/x402/validate";
const CONCURRENCY = Math.max(1, Number(process.env.BAZAAR_VALIDATE_CONCURRENCY) || (process.argv.includes("--all") ? 1 : 3));
const PER_CALL_TIMEOUT_MS = Number(process.env.BAZAAR_VALIDATE_TIMEOUT_MS) || 45_000;
const MAX_429_RETRIES = Math.max(0, Number(process.env.BAZAAR_VALIDATE_429_RETRIES ?? 4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return list.map((e) => ({ method: String(e.method || "POST").toUpperCase(), path: String(e.path), slug: String(e.slug || e.path), price: e.price }));
}

/** One validate call. Returns {ok:true, valid, failed[], index, quality} or
 *  {ok:false, error} when the validator itself could not be read. Exported
 *  for the test. */
export async function validateOne(endpoint, { fetchImpl = fetch, validateUrl = VALIDATE_URL, base = TARGET } = {}) {
  const resource = `${base}${endpoint.path}`;
  const method = endpoint.method === "GET" ? "GET" : "POST";
  let res, body;
  // CDP rate-limits the validator (measured 2026-08-19: HTTP 429 after ~200
  // calls in a full-catalog run). Honour Retry-After (capped) and retry a few
  // times before calling the route unreadable - a 429 is not a listing verdict.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchImpl(validateUrl, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ resource, method }), signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const ra = Number(res.headers.get("retry-after"));
        const waitMs = Math.min(60_000, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15_000 * (attempt + 1)));
        await sleep(waitMs);
        continue;
      }
      const text = await res.text();
      try { body = JSON.parse(text); } catch { return { ok: false, error: `validator HTTP ${res.status} non-JSON: ${text.slice(0, 120)}` }; }
      break;
    } catch (e) {
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
    const flagship = FLAGSHIP_PATHS.map((p) => byPath.get(p)).filter(Boolean);
    const missingFlagship = FLAGSHIP_PATHS.filter((p) => !byPath.has(p));
    if (missingFlagship.length) console.log(`note - flagship paths not in the live catalog (skipped): ${missingFlagship.join(", ")}`);
    chosen = flagship;
    if (opt.sample > 0) {
      const rest = all.filter((e) => !FLAGSHIP_PATHS.includes(e.path));
      // deterministic-ish spread: stride through the catalog instead of Math.random (reproducible runs)
      const stride = Math.max(1, Math.floor(rest.length / opt.sample));
      for (let i = 0; i < rest.length && chosen.length < flagship.length + opt.sample; i += stride) chosen.push(rest[i]);
    }
  }
  console.log(`bazaar-validate: ${chosen.length} endpoint(s) against ${TARGET} via ${VALIDATE_URL} (concurrency ${CONCURRENCY})`);
  const results = await mapLimit(chosen, CONCURRENCY, async (e) => ({ endpoint: e, r: await validateOne(e) }));

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("bazaar-validate crashed:", e?.message || e); process.exit(2); });
}
