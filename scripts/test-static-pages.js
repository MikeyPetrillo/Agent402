// Static, server-rendered HTML surfaces: /privacy, /terms, /shop,
// /leaderboard, /index, /tools, /skills, /. These are the human-readable
// counterparts to the JSON discovery surfaces — listing portals link to them,
// Google indexes them, and a /privacy or /terms 500 silently breaks the
// "site is up" perception even when every API is fine.
//
// A render-time regression in any one page handler (e.g., an undefined
// snapshot field in leaderboardPage) returns 500
// in a way that the API-only health probe never sees. This smoke test boots
// FREE_MODE and asserts each page:
//
//   1. Returns 200 with text/html.
//   2. Has a non-trivial body length (a blank 200 is a regression too).
//   3. Carries a page-specific anchor string in the title — so a future
//      change that silently swaps two handlers (e.g., /terms returning the
//      shop page) surfaces here instead of in production.
//
//   node scripts/test-static-pages.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3089;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fail = (m) => { console.error("FAIL:", m); try { proc.kill("SIGKILL"); } catch {} process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each page is keyed by its path with the anchor string we expect to find
// inside the served <title>. The anchor proves we got the right handler;
// a 200 with a wrong-but-valid HTML body would pass a content-type check.
const PAGES = [
  { path: "/privacy",     titleSubstr: "Privacy" },
  { path: "/faq",         titleSubstr: "FAQ" },
  { path: "/terms",       titleSubstr: "Terms" },
  { path: "/shop",        titleSubstr: "shop" },
  { path: "/leaderboard", titleSubstr: "Leaderboard" },
  { path: "/marketplace", titleSubstr: "marketplace" },
  { path: "/tools",       titleSubstr: "Catalog" },
  { path: "/skills",      titleSubstr: "skill" },
  { path: "/robinhood",   titleSubstr: "Robinhood" },
  { path: "/celo",        titleSubstr: "Celo" },
  { path: "/avalanche",   titleSubstr: "Avalanche" },
  { path: "/sei",         titleSubstr: "Sei" },
  { path: "/optimism",    titleSubstr: "Optimism" },
  { path: "/revenue",     titleSubstr: "Transactions" },
  { path: "/what-is-mpp", titleSubstr: "MPP" },
  { path: "/agentic-finance", titleSubstr: "Agentic Finance" },
  { path: "/why",          titleSubstr: "Why pay here" },
  { path: "/x402-test",    titleSubstr: "Test your x402 client" },
  { path: "/digest",      titleSubstr: "Weekly spend digest" },
  { path: "/markets",     titleSubstr: "market data" },
  { path: "/security",    titleSubstr: "Security" },
  { path: "/crawler",     titleSubstr: "crawler" },
  { path: "/company",     titleSubstr: "Havok Holdings" },
  { path: "/reports/sample/dossier", titleSubstr: "sample" },
  { path: "/proof",       titleSubstr: "Receipts" },
  { path: "/glossary",    titleSubstr: "glossary" },
  { path: "/learn",       titleSubstr: "Learn" },
  { path: "/learn/mpp",   titleSubstr: "MPP" },
  { path: "/integrations/tollbooth", titleSubstr: "agent402-tollbooth" },
  { path: "/101",         titleSubstr: "101" },
  { path: "/mpp-marketplace", titleSubstr: "MPP marketplace" },
  { path: "/",            titleSubstr: "Agent402" },
];

const proc = spawn(process.execPath, [join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, FREE_MODE: "true", PORT: String(PORT), X402_SYNC_ON_START: "false" },
  stdio: "ignore",
});

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(500); }

  for (const { path, titleSubstr } of PAGES) {
    const res = await fetch(`${BASE}${path}`);
    ok(res.status === 200, `${path} → 200 (got ${res.status})`);
    const ct = res.headers.get("content-type") || "";
    ok(ct.includes("text/html"), `${path} content-type is text/html (got ${ct})`);
    const body = await res.text();
    // 1KB floor — every page in this set carries a layout shell, head, nav,
    // and substantial content; a blank-template regression renders well
    // under this.
    ok(body.length >= 1024, `${path} body is non-trivial (got ${body.length} bytes)`);
    // Anchor lookup is case-insensitive so a future title rephrase doesn't
    // flake the test, but the anchor itself is specific enough that two
    // pages can't both match it.
    const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
    ok(titleMatch != null, `${path} has a <title> tag`);
    const title = titleMatch?.[1] ?? "";
    ok(title.toLowerCase().includes(titleSubstr.toLowerCase()), `${path} title contains '${titleSubstr}' (got '${title}')`);
    if (path === "/shop") {
      // Every slug a shop goal lists must be a live catalog slug; the page
      // prints a "no longer in the catalog" note when one is not.
      ok(!/no longer in the catalog/.test(body), "/shop lists only slugs the catalog serves");
    }
    if (path === "/marketplace") {
      // The unified marketplace surface (the old /index and /marketplaces 301
      // here) — its nav/footer must not link the retired standalone paths.
      ok(!body.includes('href="/economy"'), "/marketplace nav/footer carries no /economy link");
      ok(!body.includes('href="/index"'), "/marketplace nav/footer carries no /index link");
      // The folded economy strip: the /economy and /x402-economy 301s land on
      // /marketplace#economy (the footer's own Economy link was removed
      // 2026-07-29 as duplicative), and the route always renders the anchor —
      // x402EconomySnapshot never rejects (an errored snapshot keeps the
      // anchor with an honest "unavailable" line).
      ok(body.includes('id="economy"'), '/marketplace renders the id="economy" anchor');
    }
  }

  // Legacy marketplace surfaces must 301 straight to /marketplace — same
  // assertions as scripts/test-redirects.js, folded here so a regression
  // fails CI (test-redirects.js stays as a standalone prod probe).
  for (const path of ["/index", "/marketplaces"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    ok(res.status === 301, `${path} → 301 (got ${res.status})`);
    ok(res.headers.get("location") === "/marketplace", `${path} Location is /marketplace (got ${res.headers.get("location")})`);
  }

  // Both old economy pages folded into the marketplace: /x402-economy (the
  // on-chain settlement Observatory) and /economy (the leaderboard-derived
  // dashboard). Assert the permanent redirects instead of 200s — and that
  // they point straight at /marketplace, never chaining through the /index
  // 301 (a redirect Location must not point at another redirect).
  for (const path of ["/x402-economy", "/economy"]) {
    const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
    ok(res.status === 301, `${path} → 301 (got ${res.status})`);
    ok(res.headers.get("location") === "/marketplace#economy", `${path} Location is /marketplace#economy (got ${res.headers.get("location")})`);
  }

  // The global error handler's HTML branch must itself be renderable. It
  // once referenced chrome.js exports that server.js never imported, so any
  // thrown error on an HTML route made the handler throw ReferenceError and
  // fall through to Express's default handler — which dumps `err.stack`
  // (absolute paths, module layout) unless NODE_ENV=production. Force the
  // path deterministically: an oversized JSON body on an HTML-accepting,
  // non-/api route makes express.json throw entity.too.large (413).
  {
    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/html" },
      body: `{"pad":"${"x".repeat(200 * 1024)}"}`,
    });
    ok(res.status === 413, `error handler HTML branch → 413 (got ${res.status})`);
    const body = await res.text();
    ok((res.headers.get("content-type") || "").includes("text/html"), "error page is text/html");
    ok(body.includes("<title>") && body.includes("413"), "error page renders the status template");
    ok(!/at .*\/src\/server\.js|ReferenceError|node_modules/.test(body), "error page leaks no stack frames or paths");
  }

// --- no page may ship a raw template placeholder --------------------------
// The homepage served `${usd0(CARD_LO)}` inside its AggregateOffer JSON-LD for
// an unknown period: a DOUBLE-QUOTED string containing ${...}, three lines
// above an FAQ answer that used the same helpers correctly inside a template
// literal. That is our structured data on the most important page on the site,
// and no guard could see it because every other check reads rendered values
// rather than looking for the syntax of an unrendered one.
{
  const bad = [];
  // Every page the sitemaps list, not only the hand-picked set above.
  const paths = new Set(PAGES.map((p) => p.path));
  for (const sm of ["/sitemap-pages.xml", "/sitemap-guides.xml"]) {
    const xml = await (await fetch(`${BASE}${sm}`)).text().catch(() => "");
    for (const m of xml.matchAll(/<loc>https?:\/\/[^/<]+(\/[^<]*)<\/loc>/g)) paths.add(m[1]);
  }
  for (const path of paths) {
    const p = { path };
    const html = await (await fetch(`${BASE}${p.path}`)).text().catch(() => "");
    // Code samples legitimately teach shell `${VAR}` syntax; scan the rest.
    const prose = String(html).replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, "");
    const hits = [...prose.matchAll(/\$\{[A-Za-z0-9_.()\[\] ]{1,60}\}/g)].map((m) => m[0]);
    if (hits.length) bad.push(`${p.path}: ${[...new Set(hits)].slice(0, 3).join(" ")}`);
  }
  ok(bad.length === 0, `no page ships an uninterpolated template placeholder${bad.length ? ` - ${bad.join(" | ")}` : ""}`);
}

// --- sitemap pages no menu reaches still get a site-wide link ---------------
{
  const html = await (await fetch(`${BASE}/pricing`)).text();
  for (const p of ["/faq", "/compare", "/use-cases", "/community", "/digest", "/shop", "/badges", "/SKILL.md", "/docs/webhooks"]) {
    ok(html.includes(`href="${p}"`), `footer links ${p}`);
  }
}

  console.log(`\n${pass} passed (${PAGES.length} pages + error template)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
