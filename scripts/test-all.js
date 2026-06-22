// Comprehensive coverage: call EVERY tool in the catalog with its own documented
// example and verify a sensible response. Drives itself from /openapi.json over
// HTTP, so it exercises real routing + handlers for all ~1070 endpoints.
//
//   TARGET_URL=http://localhost:3000 node scripts/test-all.js
//
// Pure-CPU tools must return 200 with no error. Network/browser tools are
// exercised but tolerant of upstream/sandbox failures (they need real egress;
// CI has it). Memory tools get a demo namespace and accept their valid 4xx.
const TARGET = process.env.TARGET_URL || "http://localhost:3000";

// Tools that reach the network/browser — lenient (need real egress).
// Brave-backed routes — opt-in via BRAVE_LIVE_TEST=1. Every [test] CI run
// otherwise burns the Brave subscription with calls the daily paid-canary
// already covers post-deploy. When skipped, these routes are simply not
// exercised by this sweep — search-kit shape/validation is covered by
// scripts/test-search-kit.js and post-deploy by scripts/paid-canary.js.
const BRAVE_ROUTES = new Set([
  "/api/search", "/api/search-news", "/api/search-images", "/api/search-suggest", "/api/answer",
]);
const skipBrave = process.env.BRAVE_LIVE_TEST !== "1";

const NETWORK = new Set([
  "/api/extract", "/api/meta", "/api/dns", "/api/render", "/api/screenshot", "/api/pdf",
  "/api/http-check", "/api/tls-cert", "/api/whois", "/api/robots-check", "/api/sitemap",
  "/api/email-validate", "/api/ip-info", "/api/search", "/api/search-news", "/api/search-images", "/api/search-suggest", "/api/answer",
  "/api/pdf-info", "/api/pdf-merge", "/api/pdf-extract-pages", "/api/pdf-rotate", "/api/images-to-pdf",
  "/api/pdf-to-markdown",
  "/api/media-info", "/api/audio-convert", "/api/audio-normalize",
  "/api/gov-data", "/api/weather-alerts", "/api/earthquakes",
  "/api/geocode", "/api/reverse-geocode", "/api/place-search",
  "/api/image-ocr",
  "/api/barcode-lookup", "/api/fx-rate", "/api/weather-forecast",
  "/api/x402-quote", "/api/usdc-balance", "/api/tx-status", "/api/gas-estimate", "/api/x402-verify", "/api/ens-resolve",
  // Macro-kit: all routes hit live upstreams (FRED, Treasury Fiscal Data, ECB,
  // World Bank). FRED-keyed routes return 503 without FRED_API_KEY — the
  // 502/503/504 tolerance below covers that.
  "/api/treasury-yield-curve", "/api/treasury-yield-history", "/api/yield-curve-spread",
  "/api/treasury-debt", "/api/treasury-avg-rates",
  "/api/fx-historical", "/api/fx-timeseries", "/api/fx-dashboard",
  "/api/world-bank-indicator", "/api/world-bank-search",
  "/api/fred-series", "/api/fred-search", "/api/fred-series-info", "/api/fred-release-calendar",
  "/api/sahm-rule", "/api/cpi-yoy", "/api/unemployment-rate", "/api/fed-funds",
  "/api/fred-release-observations",
  // EDGAR-kit: every route hits data.sec.gov, www.sec.gov, or efts.sec.gov.
  "/api/edgar-company-lookup", "/api/edgar-filings", "/api/edgar-company-concept",
  "/api/edgar-company-facts", "/api/edgar-xbrl-frame",
  "/api/edgar-insider-trades", "/api/edgar-13f-holdings", "/api/edgar-recent-ipos", "/api/edgar-search",
  // Finance-kit: Yahoo Finance chart (quote + history) and Nasdaq earnings
  // calendar — keyless live upstreams; tolerate transient 502/503/504.
  "/api/stock-quote", "/api/stock-history", "/api/earnings-calendar",
  // Crypto-kit: CoinGecko public API — keyless, ~30 req/min from a single IP.
  // Tolerate transient 429/502/503/504 (rate limit + Cloudflare hiccups).
  "/api/crypto-price", "/api/crypto-market", "/api/crypto-history", "/api/crypto-trending", "/api/crypto-global",
  // Network-kit: live DNS resolution against 1.1.1.1/8.8.8.8/9.9.9.9. Public
  // resolvers can NXDOMAIN, time out, or return SERVFAIL for placeholder inputs —
  // tolerate transient failures, the shape check still gates the happy path.
  "/api/dns-lookup", "/api/dns-propagation", "/api/spf-check", "/api/dmarc-check",
  "/api/dkim-lookup", "/api/email-deliverability",
  // Network-kit2: crt.sh (CT logs), live HTTP fetch, signature scan, Team Cymru
  // DNS-whois. All hit free public infra; tolerate transient 4xx/5xx upstream.
  "/api/cert-transparency", "/api/http-headers", "/api/tech-stack", "/api/asn-info",
  // Chain-kit: Alchemy-backed reads (JSON-RPC + NFT + Prices + Data APIs).
  // Returns 503 without ALCHEMY_API_KEY (CI env may not have it); the
  // 502/503/504 tolerance below covers that. Daily paid-canary covers
  // post-deploy verification once the key is set in Railway.
  "/api/wallet-balance", "/api/token-metadata", "/api/token-price",
  "/api/wallet-transactions", "/api/nft-holdings", "/api/nft-metadata",
  "/api/gas-snapshot", "/api/eth-call",
  // Price-feed-kit: keyless public upstreams (Pyth Hermes, CoinGecko, DeFiLlama).
  // CoinGecko's free tier shares a per-IP ~30 rpm limit; tolerate 429/502/503/504.
  "/api/price-pyth", "/api/price-coingecko", "/api/defi-tvl",
]);
const isMemory = (p) => p.startsWith("/api/memory");

const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
const paths = Object.entries(spec.paths);

let strictPass = 0, strictFail = 0, lenient = 0, serverErr = 0;
const failures = [];
const shapeMismatches = [];
const cats = {};

// Shape check: compare a 200 JSON response against the documented
// `responses.200.content.application/json.example` keys. Catches tools whose
// output drifted from what their description claims.
//
// Skiplist: tools whose example documents the happy path but the test invokes
// them with placeholder inputs that legitimately produce a smaller "not found"
// response shape. These are NOT bugs — the happy-path example is the
// user-facing documentation; the test just can't supply real inputs.
const SHAPE_HAPPY_PATH_ONLY = new Set([
  "/api/x402-quote",   // example shows 402-detected case; placeholder URL may not 402
  "/api/tx-status",    // example shows success; 0x0…0 hash returns {status:"not_found"}
  "/api/x402-verify",  // example shows verified settlement; 0x0…0 hash returns {status:"not_found"}
]);
function checkShape(path, method, op, body) {
  if (SHAPE_HAPPY_PATH_ONLY.has(path)) return;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const example = op.responses?.["200"]?.content?.["application/json"]?.example;
  if (!example || typeof example !== "object" || Array.isArray(example)) return;
  const expected = Object.keys(example);
  if (!expected.length) return;
  const actual = Object.keys(body);
  const missing = expected.filter((k) => !actual.includes(k));
  if (missing.length) shapeMismatches.push(`${method} ${path} → missing documented keys: ${missing.join(",")}`);
}

function buildGetUrl(path, op) {
  const qs = new URLSearchParams();
  for (const p of op.parameters ?? []) {
    if (p.example !== undefined) qs.set(p.name, typeof p.example === "string" ? p.example : JSON.stringify(p.example));
  }
  return `${TARGET}${path}${[...qs].length ? `?${qs}` : ""}`;
}

let braveSkipped = 0;
for (const [path, methods] of paths) {
  if (skipBrave && BRAVE_ROUTES.has(path)) { braveSkipped += Object.keys(methods).length; continue; }
  for (const [method, op] of Object.entries(methods)) {
    const cat = (op.tags && op.tags[0]) || "other";
    // Discovery/composition surfaces (skill packs) live in the OpenAPI spec so
    // SDK generators know they exist, but they're not paywalled tools — they
    // take a path param (slug) the generic sweep can't substitute. The
    // dedicated skill-pack tests in test-mcp-all.js exercise the prompts.
    if (cat === "workflows") continue;
    cats[cat] = cats[cat] || { pass: 0, total: 0 };
    cats[cat].total++;

    let url, init;
    if (method === "get") {
      url = buildGetUrl(path, op);
      init = {};
    } else {
      const example = op.requestBody?.content?.["application/json"]?.example ?? {};
      url = `${TARGET}${path}`;
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(example) };
    }
    // Memory tools need an identity in free mode; give them a demo namespace.
    if (isMemory(path)) url += (url.includes("?") ? "&" : "?") + "ns=smoke-all";

    let status = 0, body = null, threw = null;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      status = res.status;
      const ct = res.headers.get("content-type") || "";
      body = ct.includes("application/json") ? await res.json() : (await res.arrayBuffer()).byteLength;
    } catch (e) {
      threw = e.message;
    }

    const okStrict = status === 200 && !(body && body.error);
    if (okStrict) checkShape(path, method, op, body);
    if (NETWORK.has(path)) {
      lenient++;
      // Tolerate upstream/egress failures (502/504) and browser-not-available
      // (503) — these tools need real network/Chromium, present in CI.
      if (status >= 500 && ![502, 503, 504].includes(status)) { serverErr++; failures.push(`${method} ${path} → server ${status}`); }
    } else if (isMemory(path)) {
      lenient++;
      if (threw || (status >= 500)) { serverErr++; failures.push(`${method} ${path} → ${threw || status}`); }
    } else {
      if (okStrict) { strictPass++; cats[cat].pass++; }
      else { strictFail++; failures.push(`${method} ${path} → ${threw || `HTTP ${status}`}${body && body.error ? " " + JSON.stringify(body.error).slice(0, 60) : ""}`); }
    }
  }
}

const totalOps = paths.reduce((a, [, m]) => a + Object.keys(m).length, 0);
console.log(`\nExercised ${totalOps - braveSkipped} endpoints at ${TARGET}${braveSkipped ? ` (skipped ${braveSkipped} Brave route(s) — set BRAVE_LIVE_TEST=1 to include; paid-canary covers post-deploy verification)` : ""}\n`);
for (const [cat, c] of Object.entries(cats).sort()) console.log(`  ${cat.padEnd(12)} ${c.pass}/${c.total} pure-CPU strict-pass`);
console.log(`\n  strict (pure-CPU): ${strictPass} passed, ${strictFail} failed`);
console.log(`  lenient (network/memory): ${lenient} exercised, ${serverErr} server errors`);
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):\n  ` + failures.slice(0, 40).join("\n  ") + (failures.length > 40 ? `\n  …and ${failures.length - 40} more` : ""));
}
console.log(`\n  shape (documented output keys present): ${shapeMismatches.length === 0 ? "all clean" : shapeMismatches.length + " mismatches"}`);
if (shapeMismatches.length) {
  console.error(`\nSHAPE MISMATCHES (${shapeMismatches.length}):\n  ` + shapeMismatches.slice(0, 60).join("\n  ") + (shapeMismatches.length > 60 ? `\n  …and ${shapeMismatches.length - 60} more` : ""));
}
// Fail the run on: pure-CPU strict failure, a real server crash (5xx that
// isn't an upstream 502/504), or any shape mismatch (the documented output
// example no longer matches the live response).
process.exit(strictFail === 0 && serverErr === 0 && shapeMismatches.length === 0 ? 0 : 1);
