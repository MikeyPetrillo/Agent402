// Sitewide CSP regression test — the payoff of the 2026-08-16 CSP hardening
// pass (script-src dropped 'unsafe-inline'; every page-behavior script now
// lives in a real file under /js/:file or a dedicated scoped-CSP route).
// A static grep for "<script>" catches an inline block existing in the
// TEMPLATE SOURCE; it cannot catch a real browser actually refusing to run
// something, which is the only thing that matters to a visitor. This drives
// a real Chromium instance (Playwright) over every distinct page template
// on the site (deduped from the live sitemap.xml, not a hand-maintained
// list that goes stale) and asserts ZERO CSP violations fire, on load AND
// across a set of real user interactions on the pages known to gate
// behavior behind a click (the playground's Run button, the SDK
// playground's eval sandbox, docs sidebar search, market filter bar sort/
// search, the homepage's live PoW demo, the tollbooth configurator,
// api-explorer's search/expand) — page-load-only coverage would miss a
// violation that only fires once a user actually does something.
//
//   FREE_MODE=true PORT=3000 node src/server.js
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-csp-violations.js
import { chromium } from "playwright";

const BASE = process.env.TARGET_URL || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// Dynamic-slug route families collapse to ONE representative sample each,
// so this test tracks the sitemap (self-maintaining) without visiting
// hundreds of near-identical tool/skill/doc pages that share one template.
// The programmatic SEC pages belong here for the same reason every other family
// does: /reports/insider/:ticker is ONE template with 100 seeded slugs, not 100
// templates. Leaving them out meant a CSP run loaded 250 of them to re-test
// three page shapes - and because each builds from EDGAR behind a 2-concurrent
// gate, that was also 250 EDGAR-backed page builds per CI run, which is load on
// somebody else's service to learn nothing we did not already know from the
// first one.
const DYNAMIC_PREFIXES = [
  "/tools/category/", "/tools/", "/skills/", "/blog/", "/docs/adapters/", "/docs/", "/guides/",
  "/reports/insider/", "/reports/fund/", "/reports/dossier/",
];
function shapeOf(path) {
  for (const p of DYNAMIC_PREFIXES) {
    if (path.startsWith(p) && path.length > p.length && !path.slice(p.length).includes("/")) return p;
  }
  return path;
}
const NON_HTML_RE = /\.(svg|png|ico|json|xml|txt|rss)(\?|$)/i;

const sitemapXml = await (await fetch(`${BASE}/sitemap.xml`)).text();
const sitemapPaths = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ""))
  .filter((p) => !NON_HTML_RE.test(p));
ok(sitemapPaths.length > 30, `sitemap.xml lists a substantial HTML page set (got ${sitemapPaths.length})`);

const seenShapes = new Map();
for (const p of sitemapPaths) {
  const shape = shapeOf(p);
  if (!seenShapes.has(shape)) seenShapes.set(shape, p);
}
// Always include the homepage and every chain marketplace page explicitly —
// the homepage is often excluded from a sitemap's <loc> list (canonical "/"
// quirks vary by generator) and chain pages share a shape ("/base" has no
// slash after it, so shapeOf treats each chain slug as its own unique
// shape already - this just guarantees the set even if sitemap coverage
// for a given chain is thin).
seenShapes.set("/", "/");
for (const chain of ["base", "solana", "polygon", "arbitrum", "monad", "celo", "avalanche", "sei", "optimism", "stellar", "algorand", "robinhood"]) {
  seenShapes.set(`/${chain}`, `/${chain}`);
}
// Real pages that are NOT in the sitemap, and so had NO CSP coverage at all.
// The set is derived from sitemap.xml, which is self-maintaining and the right
// default - but "self-maintaining" silently means a page missing from the
// sitemap is a page this test has never once loaded. Found by planting an
// inline script on /terms to check the detector still worked after this file
// was parallelised: the run stayed green, because /terms was never visited.
// All three are linked from every footer.
for (const p of ["/terms", "/privacy", "/transparency"]) seenShapes.set(p, p);
const pages = [...new Set(seenShapes.values())];
ok(pages.length >= 30, `deduped to a substantial distinct-template set (got ${pages.length})`);
console.log(`  crawling ${pages.length} distinct page templates for CSP violations...`);

const browser = await chromium.launch();

// Collects securitypolicyviolation events (installed via addInitScript so
// it's live before ANY page script runs, not just after DOMContentLoaded)
// plus console messages Chrome itself logs for a CSP refusal (a redundant
// backstop - some violation shapes log to console without firing the DOM
// event, e.g. a refused <script src> before the document element exists).
async function freshPage() {
  const page = await browser.newPage();
  const violations = [];
  await page.exposeFunction("__cspReport", (v) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspReport({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
      });
    });
  });
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(text)) {
      violations.push({ directive: "(console)", blockedURI: text, sourceFile: page.url(), lineNumber: 0 });
    }
  });
  return { page, violations };
}

const allViolations = [];

// The load pass is 321 page templates of almost pure I/O wait - measured at 22%
// CPU while it ran for over seven minutes, which made it about a quarter of the
// entire CI test job. Each page is independent (its own browser page, its own
// violation array), so it pools cleanly. Results are collected BY INDEX and
// flattened in the original page order, so the failure report reads identically
// to the serial version rather than in whatever order the pool finished.
//
// Concurrency is deliberately modest and the navigation timeout deliberately
// generous. A CI runner has far fewer cores than a laptop, and a page that
// times out is recorded as a violation and FAILS the run - so being greedy here
// would not produce a faster test, it would produce a flaky one that reports
// CSP failures for pages that were merely slow.
const LOAD_CONCURRENCY = Number(process.env.CSP_CONCURRENCY || 6);
const NAV_TIMEOUT_MS = 30000;
const EDGAR_CONCURRENCY = 2;        // the gate these pages queue on
const EDGAR_NAV_TIMEOUT_MS = 90000; // queueing behind a bounded resource is not a stuck page

async function runPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// PAGES BOUND BY A SHARED EXTERNAL GATE CANNOT BE POOLED WIDER THAN THE GATE.
//
// The programmatic SEC pages (/reports/insider|fund|dossier) build from EDGAR
// behind a 2-concurrent gate with a queue of 8. Loading six at once does not
// make them finish sooner - they serialise on that gate regardless - but it does
// make them WAIT in it, and a page that waits past the navigation timeout is
// recorded as a violation. That is what this test is for, so it correctly
// failed the build; the defect was the pool, not the pages.
//
// So they get their own small pool sized to the gate, and a longer deadline,
// because queueing behind a bounded external resource is legitimate slowness
// rather than a stuck page. Locally this passed on a warm cache, which is
// exactly why the CI failure was the first honest measurement of it.
const EDGAR_BACKED = /^\/reports\/(insider|fund|dossier)\//;
const gated = pages.filter((p) => EDGAR_BACKED.test(p));
const ungated = pages.filter((p) => !EDGAR_BACKED.test(p));

const t0 = Date.now();
const loadPage = async (path, navTimeoutMs) => {
  const { page, violations } = await freshPage();
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: navTimeoutMs });
    await page.waitForTimeout(300); // let any deferred/polling script fire once
  } catch (e) {
    violations.push({ directive: "(navigation)", blockedURI: String(e && e.message || e), sourceFile: path, lineNumber: 0 });
  }
  await page.close();
  return violations.map((v) => ({ path, ...v }));
};

const perPage = await runPool(ungated, LOAD_CONCURRENCY, (path) => loadPage(path, NAV_TIMEOUT_MS));
const perGated = await runPool(gated, EDGAR_CONCURRENCY, (path) => loadPage(path, EDGAR_NAV_TIMEOUT_MS));
for (const list of [...perPage, ...perGated]) for (const v of list) allViolations.push(v);
console.log(`  load pass: ${ungated.length} templates at concurrency ${LOAD_CONCURRENCY}, ` +
  `${gated.length} EDGAR-backed at ${EDGAR_CONCURRENCY}, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
ok(allViolations.length === 0, `zero CSP violations across ${pages.length} page loads (got ${allViolations.length})`);

// --- Interaction pass: pages whose scripts gate real behavior behind a
// click/input, not just page load. -------------------------------------------
const interactions = [
  {
    path: "/playground",
    async run(page) {
      await page.waitForTimeout(300);
      await page.click("#pgRun");
      await page.waitForFunction(() => /Done|Error/.test(document.getElementById("pgStatus")?.textContent || ""), { timeout: 15000 }).catch(() => {});
    },
  },
  {
    path: "/sdk-playground",
    async run(page) {
      await page.waitForTimeout(300);
      await page.click('.sp-example[data-idx="2"]'); // Generate a UUID - fast, no PoW
      await page.click("#spRun");
      await page.waitForFunction(() => document.getElementById("spStatus")?.textContent === "Done", { timeout: 15000 }).catch(() => {});
    },
  },
  {
    path: "/docs",
    async run(page) {
      await page.waitForTimeout(300);
      const input = await page.$("#ml-docs-search-input");
      if (input) await input.fill("getting");
      // The mobile sidebar toggle is display:none above the 900px
      // breakpoint (desktop default viewport) - resize down so it's a real,
      // clickable element instead of erroring on an invisible target.
      await page.setViewportSize({ width: 390, height: 844 });
      const toggle = await page.$("#ml-docs-mobile-toggle");
      if (toggle) await toggle.click();
    },
  },
  {
    path: "/base",
    async run(page) {
      await page.waitForTimeout(300);
      const sortSel = await page.$("select[data-mfb-sort]");
      if (sortSel) await sortSel.selectOption("usd");
      const searchIn = await page.$("input[data-mfb-search]");
      if (searchIn) await searchIn.fill("a");
      const sellerLink = await page.$("[data-seller-link]");
      if (sellerLink) await sellerLink.click();
    },
  },
  {
    path: "/",
    async run(page) {
      await page.waitForTimeout(500);
      const input = await page.$("#hm-demo-in");
      if (input) await input.fill("csp regression check");
      const runBtn = await page.$("#hm-demo-run");
      if (runBtn) await runBtn.click();
      await page.waitForFunction(() => {
        const s = document.getElementById("hm-demo-status");
        return s && /200 OK|error/.test(s.textContent || "");
      }, { timeout: 15000 }).catch(() => {});
    },
  },
  {
    path: "/docs/api/explorer",
    async run(page) {
      await page.waitForTimeout(500);
      const search = await page.$("#aeSearch");
      if (search) await search.fill("hash");
      const head = await page.$(".ae-ep-head");
      if (head) await head.click();
    },
  },
];

// The interaction pass stays SERIAL on purpose. These drive real work against
// the same local server (the homepage PoW demo, the playground's Run), and
// their waitForFunction calls swallow their own timeouts - so a server slowed
// by concurrent load would not fail here, it would quietly stop completing the
// interactions and reduce the coverage to a page load. Seven pages is not where
// the time goes anyway.
for (const { path, run } of interactions) {
  const { page, violations } = await freshPage();
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 20000 });
    await run(page);
  } catch (e) {
    violations.push({ directive: "(interaction)", blockedURI: String(e && e.message || e), sourceFile: path, lineNumber: 0 });
  }
  for (const v of violations) allViolations.push({ path: `${path} (interaction)`, ...v });
  await page.close();
  ok(violations.length === 0, `${path}: zero CSP violations after interacting with the page`);
}

await browser.close();

if (allViolations.length) {
  console.error("\nCSP violations found:");
  for (const v of allViolations) {
    console.error(`  ${v.path}: [${v.directive}] blocked ${v.blockedURI} (${v.sourceFile}:${v.lineNumber})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
