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
//      crawled every 5 minutes. Each crawl fetches /.well-known/x402 + the
//      seller's openapi.json (when present) and caches the result.
//
// Design notes:
//   • In-memory cache (Map) — restart-tolerant by design; no persistence needed.
//     A crawl warms it in <30s and the data is intentionally transient.
//   • All outbound HTTP goes through safeFetch (SSRF-guarded, byte-capped).
//   • Failed crawls log a stale marker; they never crash the process.
//   • The router uses the same lexical scoring shape as /api/find so rankings
//     are consistent whether a buyer searches local-only or cross-seller.
import { CHROME_HEAD_LINKS, CHROME_CSS } from "./chrome.js";
import { safeFetch } from "./tools/fetch-guard.js";
import { toolList } from "./pages.js";

const LOCAL_SELLER = "self";
const CRAWL_INTERVAL_MS = 5 * 60 * 1000; // 5 min — gentle on third-party sellers
const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hr — registries don't change fast
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_OPENAPI_BYTES = 12 * 1024 * 1024; // Agent402's own is ~5 MB; allow headroom
const MAX_DISCOVERY_BYTES = 16 * 1024 * 1024;
const MAX_DISCOVERED_SELLERS = 200; // cap so a misbehaving registry can't blow up memory
const HEALTH_WINDOW = 5; // last N crawl outcomes per seller — drives health-aware routing

// Map<originUrl, { manifest, openapi, tools, fetchedAt, error? }>
const cache = new Map();
// Set of origins auto-discovered from public x402 registries (distinct from
// the env-configured seed list so we can show provenance separately on /index).
const discoveredSeeds = new Set();
// Per-source state for the discovery panel on /index.
const discoveryStatus = new Map(); // name -> { url, fetchedAt, resources, origins, error }

// Public x402 seller registries we crawl. Each exposes an unauthenticated
// discovery endpoint; we extract unique origins from the listings.
//
// agent402.app marketplace is intentionally NOT included: its listing-with-URLs
// view (`/bazaar/quality?details=true`) is already >16MB with 69k+ services and
// growing; the slim view (`/bazaar/quality`) returns summary stats only with no
// per-item URLs. Until they ship a paginated origin-list endpoint, Coinbase CDP
// Bazaar is the canonical source.
const DISCOVERY_SOURCES = [
  { name: "Coinbase CDP Bazaar", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources" },
];

const seedList = () => {
  const envSeeds = String(process.env.X402_INDEX_SEEDS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s));
  // env seeds first (operator-curated), then auto-discovered.
  return [...new Set([...envSeeds, ...discoveredSeeds])];
};

function extractOrigin(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function discoverOneSource(source, selfOrigin) {
  const status = { url: source.url, fetchedAt: Date.now(), resources: 0, origins: 0, error: null };
  try {
    const { html } = await safeFetch(source.url, { maxBytes: MAX_DISCOVERY_BYTES });
    const data = JSON.parse(html);
    // Discovery shapes vary by registry: { resources }, { items }, { data }, top-level array, or
    // agent402.app's { services: [...] }.
    const list =
      data.resources ||
      data.items ||
      data.data ||
      data.services ||
      (Array.isArray(data) ? data : []);
    status.resources = list.length;
    const found = new Set();
    for (const item of list) {
      const url = item.resource || item.url || item.endpoint || item.homepage;
      const origin = extractOrigin(url);
      if (!origin || origin === selfOrigin) continue;
      found.add(origin);
    }
    status.origins = found.size;
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

function normaliseOpenapiTools(openapi, originUrl) {
  if (!openapi || typeof openapi !== "object" || !openapi.paths) return [];
  const out = [];
  for (const [pathStr, methods] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(methods || {})) {
      if (!op || typeof op !== "object") continue;
      // Heuristics: openapi entries that look like a paid tool route.
      // Skip pure discovery surfaces.
      if (/^\/(\.well-known|health|openapi|llms|sitemap|robots|favicon)/.test(pathStr)) continue;
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
        price: op["x-price"] || op["x-x402-price"] || null,
      });
    }
  }
  return out;
}

// Record a crawl outcome and roll the per-seller history window. `prev` is the
// existing cache entry (may be undefined on first crawl). Returns the new
// history array so the caller can derive a health score from it.
function rollHistory(prev, ok) {
  const h = Array.isArray(prev?.history) ? prev.history.slice(-(HEALTH_WINDOW - 1)) : [];
  h.push(ok ? 1 : 0);
  return h;
}

async function crawlSeller(originUrl) {
  const prev = cache.get(originUrl);
  try {
    const manifestRes = await safeFetch(`${originUrl}/.well-known/x402`, {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    const manifest = JSON.parse(manifestRes.html);

    // OpenAPI is the tool-level detail. Best-effort: a seller without one still
    // shows up in the Index based on their manifest alone.
    let openapi = null;
    let tools = [];
    try {
      const openapiRes = await safeFetch(`${originUrl}/openapi.json`, {
        maxBytes: MAX_OPENAPI_BYTES,
      });
      openapi = JSON.parse(openapiRes.html);
      tools = normaliseOpenapiTools(openapi, originUrl);
    } catch {
      /* manifest-only seller — fine */
    }

    cache.set(originUrl, {
      manifest,
      openapiSummary: openapi ? { paths: Object.keys(openapi.paths || {}).length } : null,
      tools,
      fetchedAt: Date.now(),
      error: null,
      history: rollHistory(prev, true),
    });
  } catch (e) {
    // Preserve the last good manifest+tools so a transient outage doesn't drop
    // the seller from the Index — but the history flip marks them unhealthy
    // for routing decisions.
    cache.set(originUrl, {
      ...(prev || {}),
      error: String(e.message || e),
      fetchedAt: Date.now(),
      history: rollHistory(prev, false),
    });
  }
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
  return h[h.length - 1] === 1;
}

let crawlerTimer = null;
let discoveryTimer = null;
let crawlInFlight = false;

async function runCrawl() {
  if (crawlInFlight) return; // overlapping runs would just rate-limit each other
  crawlInFlight = true;
  try {
    const seeds = seedList();
    await Promise.allSettled(seeds.map(crawlSeller));
  } finally {
    crawlInFlight = false;
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
export function startCrawler(opts = {}) {
  if (crawlerTimer) return;
  const { selfOrigin = null } = opts;
  // Kick off discovery first so the first crawl has registry-sourced seeds in
  // hand (best-effort — if discovery is slow, the first crawl just uses env seeds).
  runDiscovery(selfOrigin).then(() => runCrawl());
  crawlerTimer = setInterval(runCrawl, CRAWL_INTERVAL_MS);
  discoveryTimer = setInterval(() => runDiscovery(selfOrigin), DISCOVERY_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  if (typeof crawlerTimer.unref === "function") crawlerTimer.unref();
  if (typeof discoveryTimer.unref === "function") discoveryTimer.unref();
}

/** Stop the crawler (used by tests to keep the process exitable). */
export function stopCrawler() {
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
    category: t.category,
    tags: t.tags || [],
    price: prices?.[t.slug] ?? parsePrice(t.price),
  }));
  return {
    origin: LOCAL_SELLER,
    displayName: walletName ? `Agent402 (${walletName})` : "Agent402",
    homepage: baseUrl,
    network,
    toolCount,
    tools,
    fetchedAt: Date.now(),
    local: true,
  };
}

/**
 * Snapshot for the /index page. Always includes the local catalog (instant,
 * zero-network) plus whatever the crawler has accumulated.
 */
export function indexSnapshot({ baseUrl, catalog, prices, network, toolCount, walletName }) {
  const local = buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName });
  const remote = [...cache.entries()].map(([origin, v]) => ({
    origin,
    displayName: v.manifest?.name || origin.replace(/^https?:\/\//, ""),
    homepage: v.manifest?.homepage || origin,
    network: v.manifest?.payment?.x402?.primaryNetwork || v.manifest?.payment?.primaryNetwork || null,
    toolCount: v.tools?.length || v.manifest?.capabilities?.tools || 0,
    fetchedAt: v.fetchedAt,
    error: v.error || null,
    local: false,
    health: healthScore(v),
    routable: isRoutable(v),
    history: Array.isArray(v.history) ? v.history.slice() : [],
  }));
  const sellers = [local, ...remote];
  const discoverySources = DISCOVERY_SOURCES.map((s) => {
    const st = discoveryStatus.get(s.name);
    return {
      name: s.name,
      url: s.url,
      fetchedAt: st?.fetchedAt || null,
      resources: st?.resources ?? null,
      origins: st?.origins ?? null,
      error: st?.error || null,
    };
  });
  return {
    spec: "x402-index/1",
    asOf: new Date().toISOString(),
    sellers,
    discoverySources,
    totals: {
      sellers: sellers.length,
      tools: sellers.reduce((s, x) => s + (x.toolCount || 0), 0),
      crawled: remote.length,
      discovered: discoveredSeeds.size,
      routable: 1 + remote.filter((s) => s.routable).length, // self always routable
      unhealthy: remote.filter((s) => !s.routable).length,
    },
  };
}

/**
 * Smart Order Router — given a task description, rank matching tools across
 * every seller in the Index. Cheapest seller wins on score ties.
 *
 * Returns the same shape as /api/find but with a `seller` field per result and
 * cross-seller deduplication left to the buyer (different sellers may legitimately
 * offer the same tool at different prices).
 */
export function routeQuery({ query, top, baseUrl, catalog, prices, network, toolCount, walletName }) {
  const q = String(query || "").slice(0, 500);
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 32);
  const k = Math.min(Math.max(parseInt(top, 10) || 5, 1), 25);
  if (!terms.length) return { query: q, count: 0, results: [], sellers: 0 };

  // Always include the local catalog (we trust ourselves), plus every crawled
  // seller's tools — but only from sellers whose last crawl succeeded. A buyer
  // routed to a currently-broken seller would just lose the call, so we'd
  // rather rank fewer trustworthy options than more flaky ones.
  const local = buildLocalEntry({ baseUrl, catalog, prices, network, toolCount, walletName });
  const all = [
    ...local.tools.map((t) => ({ ...t, sellerHome: baseUrl, sellerName: local.displayName, health: 1 })),
    ...[...cache.values()]
      .filter(isRoutable)
      .flatMap((v) =>
        (v.tools || []).map((t) => ({
          ...t,
          sellerHome: v.manifest?.homepage || t.seller,
          sellerName: v.manifest?.name || t.seller,
          health: healthScore(v),
        })),
      ),
  ];

  const scored = [];
  for (const t of all) {
    const slug = (t.slug || "").toLowerCase();
    const name = (t.name || "").toLowerCase();
    const hay = `${t.name} ${t.description} ${t.category} ${(t.tags || []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 10;
      else if (slug.includes(term)) score += 4;
      if (name.includes(term)) score += 2;
      if (hay.includes(term)) score += 1;
    }
    if (score > 0) scored.push([score, t]);
  }
  // Highest score first; healthier seller wins on ties; then cheapest; then
  // shorter slug. Health is the strongest tiebreak after match score because a
  // cheap-but-flaky seller is worse than a slightly pricier reliable one.
  scored.sort((a, b) => {
    if (b[0] !== a[0]) return b[0] - a[0];
    if (b[1].health !== a[1].health) return b[1].health - a[1].health;
    const pa = parsePrice(a[1].price);
    const pb = parsePrice(b[1].price);
    if (pa !== pb) return pa - pb;
    return (a[1].slug || "").length - (b[1].slug || "").length;
  });

  const sellersSeen = new Set();
  const results = scored.slice(0, k).map(([score, t]) => {
    sellersSeen.add(t.seller);
    return {
      seller: t.seller,
      sellerHome: t.sellerHome,
      sellerName: t.sellerName,
      slug: t.slug,
      name: t.name,
      method: t.method,
      route: t.route,
      url: t.seller === LOCAL_SELLER ? `${baseUrl}${t.route}` : `${t.seller}${t.route}`,
      price: t.price,
      priceUsd: parsePrice(t.price),
      category: t.category,
      description: t.description,
      score,
      health: t.health,
    };
  });
  return { query: q, count: results.length, sellers: sellersSeen.size, results };
}

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Public HTML dashboard. Self-contained: no client-side polling required — a
 * page refresh re-renders from the latest snapshot. Embed snippet at the bottom
 * shows sellers how to drop a "tools live on x402" widget on their landing.
 */
export function indexPage(snapshot, { baseUrl }) {
  const fmtAge = (ts) => {
    if (!ts) return "—";
    const age = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
  };
  const healthBadge = (s) => {
    if (s.local) return ' <span class="badge local">SELF</span>';
    if (s.error) return ' <span class="badge err" title="' + esc(s.error) + '">STALE</span>';
    // Healthy seller: show rolling history as a tiny sparkline (●=ok, ○=fail)
    const dots = (s.history || []).map((x) => (x ? "●" : "○")).join("");
    return dots ? ` <span class="badge ok" title="last ${s.history.length} crawls">${dots}</span>` : "";
  };
  const rows = snapshot.sellers
    .map((s) => {
      return `<tr>
        <td><a href="${esc(s.homepage || s.origin)}" target="_blank" rel="noopener">${esc(s.displayName)}</a>${healthBadge(s)}</td>
        <td class="num">${esc(s.toolCount)}</td>
        <td>${esc(s.network || "—")}</td>
        <td class="muted">${esc(fmtAge(s.fetchedAt))}</td>
      </tr>`;
    })
    .join("");
  const discoveryRows = (snapshot.discoverySources || [])
    .map((d) => {
      const status = d.error
        ? `<span class="badge err" title="${esc(d.error)}">ERROR</span>`
        : d.fetchedAt
        ? `<span class="muted">${esc(d.resources)} resources → ${esc(d.origins)} origins</span>`
        : `<span class="muted">pending…</span>`;
      return `<tr>
        <td><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a></td>
        <td>${status}</td>
        <td class="muted">${esc(fmtAge(d.fetchedAt))}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402 Index — Agent402</title>
<meta name="description" content="Live map of the agent payments economy: every x402 seller, their tool count, network, and last-crawled time.">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --card:#0f1320; --warn:#f97316; }
  body { background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:980px; margin:0 auto; padding:36px 20px 28px; }
  h1 { font-size:1.6rem; margin:0 0 6px; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:.95rem; max-width:680px; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin:0 0 22px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .stat .k { color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .stat .v { font-family:ui-monospace,Menlo,monospace; font-size:1.65rem; color:var(--fg); margin-top:4px; }
  .stat .s { color:var(--muted); font-size:.78rem; margin-top:3px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:18px; }
  .ph { padding:14px 18px; border-bottom:1px solid var(--line); }
  .ph h2 { margin:0; font-size:1rem; color:var(--accent); }
  .ph .pn { color:var(--muted); font-size:.82rem; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:10px 18px; border-bottom:1px solid var(--line); }
  th.num { text-align:right; }
  td { padding:10px 18px; border-bottom:1px solid var(--line); }
  td.num { font-family:ui-monospace,Menlo,monospace; text-align:right; }
  td.muted { color:var(--muted); }
  td a { color:var(--fg); text-decoration:none; border-bottom:1px solid transparent; }
  td a:hover { border-color:var(--accent); }
  .badge { display:inline-block; font-size:.62rem; font-weight:600; padding:1px 6px; border-radius:4px; margin-left:6px; letter-spacing:.04em; font-family:ui-monospace,Menlo,monospace; }
  .badge.local { background:rgba(74,222,128,.1); color:var(--accent); border:1px solid rgba(74,222,128,.3); }
  .badge.err { background:rgba(249,115,22,.12); color:var(--warn); border:1px solid rgba(249,115,22,.3); }
  .badge.ok { background:rgba(74,222,128,.08); color:var(--accent); border:1px solid rgba(74,222,128,.2); letter-spacing:.1em; }
  code { background:#1a2236; padding:1px 5px; border-radius:4px; font-family:ui-monospace,Menlo,monospace; font-size:.85em; }
  pre { background:#0a0d15; border:1px solid var(--line); border-radius:8px; padding:14px 16px; overflow:auto; font-size:.84rem; }
  .foot { color:var(--muted); font-size:.82rem; margin-top:24px; }
  .foot a { color:var(--accent); text-decoration:none; }
  ${CHROME_CSS}
</style>
</head>
<body><div class="wrap">

<h1>x402 Index</h1>
<p class="sub">Live map of the agent payments economy. Every seller below publishes an x402 service manifest at <code>/.well-known/x402</code>; this page crawls them every 5 minutes and shows what's online.</p>

<div class="grid">
  <div class="stat"><div class="k">Sellers</div><div class="v">${esc(snapshot.totals.sellers)}</div><div class="s">listed in the Index</div></div>
  <div class="stat"><div class="k">Tools online</div><div class="v">${esc(snapshot.totals.tools)}</div><div class="s">across all sellers</div></div>
  <div class="stat"><div class="k">Crawled sellers</div><div class="v">${esc(snapshot.totals.crawled)}</div><div class="s">via /.well-known/x402</div></div>
  <div class="stat"><div class="k">Auto-discovered</div><div class="v">${esc(snapshot.totals.discovered ?? 0)}</div><div class="s">from public registries</div></div>
  <div class="stat"><div class="k">Routable now</div><div class="v">${esc(snapshot.totals.routable ?? 0)}</div><div class="s">${esc(snapshot.totals.unhealthy ?? 0)} unhealthy excluded from router</div></div>
  <div class="stat"><div class="k">Snapshot</div><div class="v" style="font-size:1rem">${esc(snapshot.asOf.replace("T", " ").slice(0, 19))}Z</div><div class="s">refresh the page to update</div></div>
</div>

<div class="panel">
  <div class="ph"><h2>Sellers</h2><div class="pn">Local catalog plus every seeded origin we could fetch.</div></div>
  <table>
    <thead><tr><th>Seller</th><th class="num">Tools</th><th>Network</th><th>Last fetch</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">No sellers yet — seed via X402_INDEX_SEEDS.</td></tr>`}</tbody>
  </table>
</div>

<div class="panel">
  <div class="ph"><h2>Discovery sources</h2><div class="pn">Public x402 registries we poll hourly to find new sellers automatically.</div></div>
  <table>
    <thead><tr><th>Registry</th><th>Result</th><th>Last fetch</th></tr></thead>
    <tbody>${discoveryRows || `<tr><td colspan="3" class="muted" style="text-align:center;padding:24px">No discovery sources configured.</td></tr>`}</tbody>
  </table>
</div>

<div class="panel">
  <div class="ph"><h2>Smart Order Router</h2><div class="pn">Resolve a task to the cheapest matching tool across every seller in one call.</div></div>
  <div style="padding:14px 18px;">
    <pre>curl -s -X POST ${esc(baseUrl)}/api/route \\
  -H 'Content-Type: application/json' \\
  -d '{"query":"ocr image","top":3}'</pre>
    <p class="foot" style="margin:10px 0 0;">Free — same gate as <code>/api/find</code>. Deterministic lexical scoring with cheapest-seller tiebreak.</p>
  </div>
</div>

<p class="foot">x402 Index is open-source — part of <a href="https://github.com/MikeyPetrillo/Agent402">Agent402</a>. To add your seller, publish a manifest at <code>/.well-known/x402</code> and open a PR adding your origin to the seed list (or run your own Index instance).</p>

</div></body></html>`;
}

/** Internal helper for tests. */
export function _cacheForTests() {
  return cache;
}
