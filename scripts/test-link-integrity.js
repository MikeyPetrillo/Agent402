// Site-wide link integrity: every sitemap.xml URL resolves, and every
// internal href referenced across a broad crawl of real pages resolves too
// - the second check catches links pointing somewhere NOT in the sitemap,
// which sitemap-only coverage misses entirely.
//
// Requires a booted server (same TARGET_URL convention as test-mcp-http.js /
// test-docs-truth.js):
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-link-integrity.js
//
// Deliberately internal-only: external hrefs (github.com, solscan.io, real
// crawled third-party seller domains, ...) are collected and reported but
// never fetched - checking hundreds of third-party sites on every CI run
// would be slow and flaky for failures that are never ours to fix. A
// separate, ad-hoc pass against the live site is the right tool for that.
// Chain seller-activity views (?seller=X, our own route) get the same
// report-don't-gate treatment for a different reason: the first lookup of an
// unfamiliar wallet is a genuinely cold, bounded-but-slow on-chain RPC scan
// (src/revenue-live.js), and a fresh CI boot's first hit on some chain's
// public RPC can outrun any timeout short enough to be CI-friendly - proven
// live (an Algorand lookup exceeded even a 90s allowance once in CI). Not a
// broken link, just not gateable.
//
// Real bug this locks in (found 2026-08-14 via exactly this kind of sweep):
// the homepage's "for agents" machine-readable-surfaces strip rendered
// /mcp as a real <a href="/mcp">, styled identically to the three other
// links in the same row (/openapi.json, /.well-known/x402, /api/pricing) -
// which all correctly GET 200. /mcp is a stateless MCP endpoint that
// deliberately 405s on GET per spec (POST-only JSON-RPC) - correct endpoint
// behavior, wrong presentation: a prominent homepage link that always
// errors for a human click or a crawler follow. Fixed by rendering it as
// plain text (matching how the same page already shows the connector URL
// in a <pre> code block elsewhere), not a link.
import { docsSlugs } from "../src/docs.js";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Chain seller-activity views (?seller=) trigger a cold, bounded on-chain RPC
// scan the first time a given wallet is looked up (src/revenue-live.js -
// every RPC call already carries its own 6-8s timeout and a maxPages/maxTx
// loop cap, so this always finishes eventually). "Bounded" still means up to
// ~10 sequential RPC calls against whichever chain's public endpoint that
// wallet happens to hit first, which measured live in CI exceeded even a 90s
// allowance for a genuinely cold Algorand lookup - a real timing flake, not a
// broken link. Same reasoning as external hrefs below: collected and
// reported, never gated on, because a slow-but-working page here is never
// something this test can fix.
const SELLER_SCAN_RE = /[?&]seller=/;

// Single retry on a network-level exception only (connection reset/refused,
// not an HTTP status) - CONCURRENCY=20 against a local CI-booted server,
// often running right after a long battery of other test steps on a shared
// runner, can drop a socket transiently (found 2026-08-16: /tools/
// number-format failed once with a bare "fetch failed", no HTTP status at
// all, while curling the same route directly against prod 200s cleanly).
// Same single-retry doctrine already used elsewhere in this codebase
// (scripts/heartbeat-probe.sh) to tell a real outage from a blip. Does NOT
// retry an HTTP status (a real 404/500 is deterministic and should stay a
// hard failure, not get a free pass).
async function fetchStatus(path) {
  const r = await fetch(`${BASE}${path}`, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  return r.status;
}
async function status(path) {
  try {
    return await fetchStatus(path);
  } catch (e) {
    try {
      return await fetchStatus(path);
    } catch (e2) {
      return `ERR:${e2.message}`;
    }
  }
}

// --- Phase 1: sitemap.xml coverage -------------------------------------------
const sitemapXml = await (await fetch(`${BASE}/sitemap.xml`)).text();
const sitemapUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, ""));
ok(sitemapUrls.length > 400, `sitemap.xml lists a substantial URL set (got ${sitemapUrls.length})`);

const CONCURRENCY = 20;
async function checkAll(paths, label, { gate = true } = {}) {
  const broken = [];
  const queue = [...paths];
  async function worker() {
    while (queue.length) {
      const path = queue.pop();
      const s = await status(path);
      if (typeof s === "string" || s >= 400) broken.push({ path, status: s });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const msg = `${label}: 0 broken out of ${paths.length}${broken.length ? ` - broken: ${broken.slice(0, 10).map((b) => `${b.path} (${b.status})`).join(", ")}${broken.length > 10 ? ` +${broken.length - 10} more` : ""}` : ""}`;
  if (gate) ok(broken.length === 0, msg);
  else console.log(`${broken.length === 0 ? "ok" : "info"} - ${msg} (not gated)`);
  return broken;
}

await checkAll(sitemapUrls, "sitemap.xml URLs all resolve");

// --- Phase 2: crawl a broad seed set, extract every unique internal href,
// verify each one resolves too (catches links to targets NOT in the
// sitemap - fragments, query-param views, anything hand-authored). --------
const seeds = [
  "/", "/what-is-x402", "/what-is-mpp", "/sell", "/tools", "/leaderboard", "/marketplace",
  "/skills", "/docs", "/docs/adapters", "/docs/webhooks", "/docs/api", "/docs/api/explorer",
  "/pricing", "/playground", "/sdk-playground", "/quickstart", "/faq", "/status", "/revenue",
  "/badges", "/shop", "/compare", "/community", "/contribute", "/changelog", "/blog",
  "/contact", "/privacy", "/terms", "/transparency", "/integrations", "/workflows",
  "/base", "/solana", "/polygon", "/arbitrum", "/monad", "/celo", "/avalanche", "/sei",
  "/optimism", "/stellar", "/algorand", "/robinhood",
  "/marketplace/tools", "/tools/bestsellers", "/tools/category/llm",
  "/guides", "/guides/smart-order-router", "/guides/x402-in-5-minutes",
  ...docsSlugs().slice(0, 5).map((s) => `/docs/${s}`),
];

const hrefsByPage = new Map();
await Promise.all(seeds.map(async (path) => {
  const s = await status(path);
  if (typeof s === "string" || s >= 400) { hrefsByPage.set(path, { error: s }); return; }
  const html = await (await fetch(`${BASE}${path}`)).text();
  hrefsByPage.set(path, { hrefs: [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]) });
}));

const brokenSeeds = [...hrefsByPage.entries()].filter(([, v]) => v.error);
ok(brokenSeeds.length === 0, `all ${seeds.length} seed pages load (0 broken)${brokenSeeds.length ? ` - broken: ${brokenSeeds.map(([p, v]) => `${p} (${v.error})`).join(", ")}` : ""}`);

// Some crawled pages (e.g. /marketplace) render OTHER PEOPLE'S URLs as hrefs
// (seller homepages, etc.) - real URL parsing, never a prefix/substring
// match, so a lookalike host (agent402.tools.evil.example) can't be
// misclassified as one of ours.
const OWN_HOST = new URL(BASE).host.toLowerCase();
const internalPaths = new Set();
for (const [, v] of hrefsByPage) {
  if (!v.hrefs) continue;
  for (const h of v.hrefs) {
    if (!h || h.startsWith("/")) {
      if (h) internalPaths.add(h.split("#")[0]);
      continue;
    }
    let u;
    try { u = new URL(h); } catch { continue; } // not an absolute URL (mailto:, javascript:, tel:, ...) - not a page to check
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const host = u.host.toLowerCase();
    if (host !== OWN_HOST && host !== "agent402.tools") continue; // external - out of scope, see header note
    internalPaths.add(u.pathname + u.search);
  }
}
ok(internalPaths.size > 50, `crawl surfaced a substantial set of unique internal links (got ${internalPaths.size})`);
const sellerScanPaths = [...internalPaths].filter((p) => SELLER_SCAN_RE.test(p));
const strictPaths = [...internalPaths].filter((p) => !SELLER_SCAN_RE.test(p));
await checkAll(strictPaths, "every unique internal href found across the crawl resolves");
if (sellerScanPaths.length) {
  await checkAll(sellerScanPaths, "chain seller-activity views (?seller=)", { gate: false });
}

// --- Regression: /mcp must never render as a real <a href> anywhere -----------
// The endpoint's own 405-on-GET is correct (stateless MCP server, POST-only
// per spec) - the bug was presenting it as a browsable link at all.
{
  let mcpLinked = false;
  for (const [, v] of hrefsByPage) {
    if (v.hrefs && v.hrefs.some((h) => h === "/mcp" || h === `${BASE}/mcp` || h === "https://agent402.tools/mcp")) mcpLinked = true;
  }
  ok(!mcpLinked, "/mcp (a stateless, POST-only endpoint that correctly 405s on GET) never renders as a real <a href> - shown as plain text instead, matching how the connector URL is already presented elsewhere on the page");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
