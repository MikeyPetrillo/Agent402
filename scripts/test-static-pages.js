// Static, server-rendered HTML surfaces: /privacy, /terms, /faq,
// /leaderboard, /index, /tools, /skills, /. These are the human-readable
// counterparts to the JSON discovery surfaces — listing portals link to them,
// Google indexes them, and a /privacy or /terms 500 silently breaks the
// "site is up" perception even when every API is fine.
//
// A render-time regression in any one page handler (e.g., an undefined
// snapshot field in ledgerLeaderboardPage) returns 500
// in a way that the API-only health probe never sees. This smoke test boots
// FREE_MODE and asserts each page:
//
//   1. Returns 200 with text/html.
//   2. Has a non-trivial body length (a blank 200 is a regression too).
//   3. Carries a page-specific anchor string in the title — so a future
//      change that silently swaps two handlers (e.g., /terms returning the
//      FAQ page) surfaces here instead of in production.
//
//   node scripts/test-static-pages.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WHY_POINTS, WHY_COMPARE } from "../src/why.js";
import { USE_CASES, useCaseCost } from "../src/use-cases.js";
import { BADGE_STYLES } from "../src/badges.js";
import { esc } from "../src/ledger-chrome.js";

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
  { path: "/leaderboard", titleSubstr: "Leaderboard" },
  { path: "/marketplace", titleSubstr: "marketplace" },
  { path: "/tools",       titleSubstr: "Agent402 Tools" },
  { path: "/skills",      titleSubstr: "skill" },
  { path: "/robinhood",   titleSubstr: "Robinhood" },
  { path: "/celo",        titleSubstr: "Celo" },
  { path: "/avalanche",   titleSubstr: "Avalanche" },
  { path: "/sei",         titleSubstr: "Sei" },
  { path: "/optimism",    titleSubstr: "Optimism" },
  { path: "/revenue",     titleSubstr: "Transactions" },
  { path: "/what-is-mpp", titleSubstr: "MPP" },
  { path: "/agentic-finance", titleSubstr: "Agentic Finance" },
  { path: "/docs",         titleSubstr: "Docs" },
  { path: "/x402-test",    titleSubstr: "Test your x402 client" },
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

// --- no page sells credits while credits are off ----------------------------
// Six pages and the /credits share card kept telling readers to buy a pack for
// two weeks after sales stopped (truth audit 2026-10-02): every guard read
// prices and counts, none read whether the thing offered can be bought. The
// booted server's own /credits page says which state it is in.
{
  const SELLS_CREDITS = /buy (?:a |credits )?(?:credits )?pack|buy credits by card|pack by card|top-up link|\$20, \$50 or \$100/i;
  ok(SELLS_CREDITS.test("Get the key once: buy a pack by card at /credits") && SELLS_CREDITS.test("No wallet? Buy credits by card."), "control: the credits-sale pattern matches the copy that shipped");
  const creditsPage = await (await fetch(`${BASE}/credits`)).text().catch(() => "");
  if (/not on sale/i.test(creditsPage)) {
    const paths = new Set(PAGES.map((p) => p.path));
    for (const sm of ["/sitemap-pages.xml", "/sitemap-guides.xml"]) {
      const xml = await (await fetch(`${BASE}${sm}`)).text().catch(() => "");
      for (const m of xml.matchAll(/<loc>https?:\/\/[^/<]+(\/[^<]*)<\/loc>/g)) paths.add(m[1]);
    }
    paths.add("/og/credits.svg");
    const sells = [];
    for (const path of paths) {
      const html = await (await fetch(`${BASE}${path}`)).text().catch(() => "");
      const m = String(html).match(SELLS_CREDITS);
      if (m) sells.push(`${path}: "${m[0]}"`);
    }
    ok(sells.length === 0, `credits are off and no page or card offers to sell them${sells.length ? ` - ${sells.join(" | ")}` : ""}`);
  } else {
    console.log("skip - this boot sells credits (CREDITS_SALES on); the off-state copy check needs it off");
  }
}

// --- "Why pay here" lives on the home page (#why); /why redirects there -----
{
  const res = await fetch(`${BASE}/why`, { redirect: "manual" });
  ok(res.status === 301, `/why → 301 (got ${res.status})`);
  ok(res.headers.get("location") === "/#why", `/why Location is /#why (got ${res.headers.get("location")})`);
  const home = await (await fetch(`${BASE}/`)).text();
  const m = home.match(/<section id="why"[\s\S]*?<\/section>/);
  ok(m != null, "the home page renders the #why section");
  const why = m?.[0] || "";
  ok(WHY_POINTS.length === 7, `seven why points (got ${WHY_POINTS.length})`);
  for (const w of WHY_POINTS) {
    ok(why.includes(`id="why-${w.id}"`) && why.includes(`<h3>${esc(w.t)}</h3>`), `/#why carries the ${w.id} row heading`);
    ok(typeof w.t === "string" && w.t.length <= 40, `/#why ${w.id} heading is short enough for one line (${w.t.length} chars)`);
    ok(typeof w.s === "string" && w.s.length > 20 && w.s.length <= 130 && why.includes(esc(w.s)), `/#why ${w.id} shows its one-sentence claim`);
    ok(why.includes(esc(w.h)) && why.includes(esc(w.p)), `/#why ${w.id} keeps the full claim behind how it works`);
    ok(Array.isArray(w.links) && w.links.length >= 1 && w.links.length <= 2, `/#why ${w.id} shows one or two proof links on its row`);
    for (const [href] of [...w.links, ...(w.more || [])]) ok(why.includes(`href="${esc(href)}"`), `/#why ${w.id} links its proof ${href}`);
  }
  ok(why.includes('id="why-compare"') && why.includes('class="why-cmp"'), "/#why carries the side-by-side table");
  for (const c of WHY_COMPARE.cols) ok(why.includes(`<th scope="col">${esc(c)}</th>`), `/#why table has the "${c}" column`);
  for (const [label, ...cells] of WHY_COMPARE.rows) ok(why.includes(`<th scope="row">${esc(label)}</th>`) && cells.every((c) => why.includes(esc(c))), `/#why table has the "${label}" row`);
  ok(/"@id":"[^"]*\/#why"/.test(home), "the seven points' ItemList is anchored on the home page");
  // /docs keeps a pointer for old /docs#why links, not a copy of the points.
  const docs = await (await fetch(`${BASE}/docs`)).text();
  const stub = (docs.match(/<p id="why"[\s\S]*?<\/p>/) || [""])[0];
  ok(stub.includes('href="/#why"'), "/docs keeps an id=\"why\" stub that links /#why");
  ok(!WHY_POINTS.some((w) => docs.includes(`id="why-${w.id}"`)), "/docs no longer repeats the seven points");
  ok(docs.indexOf('id="why"') < docs.indexOf('id="how"'), "the #why stub sits above how payment works");
  for (const sm of ["/sitemap.xml", "/sitemap-pages.xml"]) {
    const xml = await (await fetch(`${BASE}${sm}`)).text();
    ok(!/\/why<\/loc>/.test(xml), `${sm} does not list /why`);
  }
}

// --- home: no stats strip under the two doors --------------------------------
{
  const home = await (await fetch(`${BASE}/`)).text();
  ok(!/class="hm-proof"/.test(home), "the home page has no full-width stats strip");
  ok(!/settlement rails · x402 \+ MPP|deducted from sellers · open source|priced tools · \d+ are skill packs/.test(home), "none of the strip's labels remain");
  ok(/\d+ rails live/.test(home), "control: the hero still states the live rail count");
  // The hero is the agent story: no report button, no card, one primary pill.
  const hero = (home.match(/<header[\s\S]*?<\/header>/) || [""])[0];
  ok(hero.includes('href="/docs#add"') && /btn-primary" href="\/docs#add">Add to your agent</.test(hero), "hero primary is Add to your agent");
  ok(/btn-secondary" href="\/tools">Browse tools</.test(hero), "hero secondary is Browse tools");
  ok(!/Buy a report|by card|agentic finance/i.test(hero.replace(/<div class="hm-obsidian[\s\S]*$/, "")), "hero copy carries no report, card or agentic-finance line");
}

// --- nav and footer: no /why, no For people, Tools named consistently --------
{
  for (const p of ["/", "/pricing", "/docs", "/company", "/reports"]) {
    const html = await (await fetch(`${BASE}${p}`)).text();
    const navHtml = (html.match(/<nav style="border-bottom[\s\S]*?<\/nav>/) || [""])[0];
    const footHtml = (html.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
    ok(navHtml.length > 1000 && footHtml.length > 500, `${p} renders the site nav and footer`);
    const chrome = navHtml + footHtml;
    ok(!/href="\/why["#]/.test(chrome), `${p} nav/footer carries no /why link`);
    ok(!/href="\/(docs)?#why"/.test(navHtml), `${p} nav carries no why pay here link`);
    ok(!/why pay here|WHY PAY HERE/i.test(navHtml), `${p} nav has no Why entry`);
    ok(!/For people|FOR PEOPLE/.test(navHtml), `${p} nav has no "For people" item`);
    ok(/<a class="ml-nav-link[^"]*" href="\/tools">Tools /.test(navHtml), `${p} nav names /tools "Tools"`);
    ok(/href="\/tools" style="color:var\(--muted\);text-decoration:none;">tools<\/a>/.test(footHtml), `${p} footer names /tools "tools"`);
    ok(!/>catalog</.test(chrome), `${p} nav/footer never label /tools "catalog"`);
    ok(!/href="\/company["#]/.test(chrome), `${p} nav/footer carries no /company link`);
    ok(/© \d{4} <a href="https:\/\/havok\.holdings" rel="noopener"[^>]*>Havok Holdings LLC<\/a>/.test(footHtml), `${p} footer links the copyright entity to https://havok.holdings`);
    // Reports stay one click away: the CTA everywhere but /reports itself, and the footer.
    ok(!/class="ml-nav-cta"/.test(navHtml) && /href="\/reports"[^>]*>\s*Reports/.test(navHtml), `${p} nav lists Reports as a plain link and carries no button`);
    ok(footHtml.includes('href="/reports"') && footHtml.includes('href="/monitors"'), `${p} footer links reports and monitors`);
  }
  const reports = await (await fetch(`${BASE}/reports`)).text();
  ok(/class="mon-offer"[\s\S]*?href="\/monitors"/.test(reports), "/reports offers monitors near the top");
}

// --- the footer's "more" row is gone; its pages moved or retired -----------
// /faq stays (linked from the home FAQ, listed in the sitemap); /compare,
// /use-cases and /badges became sections of /docs; /community, /shop and the
// weekly digest page redirect. The agent row still links SKILL.md and webhooks.
const MOVED = { "/compare": "/#why-compare", "/use-cases": "/docs#examples", "/badges": "/docs#badges", "/community": "/integrations", "/shop": "/tools", "/digest": "/docs" };
{
  for (const p of ["/", "/pricing", "/docs"]) {
    const html = await (await fetch(`${BASE}${p}`)).text();
    const foot = (html.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
    ok(foot.length > 500, `${p} renders the footer`);
    ok(!/>more<\/span>/.test(foot), `${p} footer has no "more" row`);
    for (const old of [...Object.keys(MOVED), "/faq"]) ok(!foot.includes(`href="${old}"`), `${p} footer does not link ${old}`);
    for (const keep of ["/SKILL.md", "/docs/webhooks"]) ok(foot.includes(`href="${keep}"`), `${p} footer still links ${keep}`);
  }
  for (const [from, to] of Object.entries(MOVED)) {
    const res = await fetch(`${BASE}${from}`, { redirect: "manual" });
    ok(res.status === 301 && res.headers.get("location") === to, `${from} -> 301 ${to} (got ${res.status} ${res.headers.get("location")})`);
    const target = await fetch(`${BASE}${to.split("#")[0]}`, { redirect: "manual" });
    ok(target.status === 200, `${from}'s target ${to} answers 200 (got ${target.status})`);
  }
  const home = await (await fetch(`${BASE}/`)).text();
  ok(home.includes('href="/faq"'), "the home FAQ links /faq");
  for (const sm of ["/sitemap.xml", "/sitemap-pages.xml"]) {
    const xml = await (await fetch(`${BASE}${sm}`)).text();
    if (sm === "/sitemap-pages.xml") ok(/\/faq<\/loc>/.test(xml), `${sm} lists /faq`);
    for (const old of Object.keys(MOVED)) ok(!xml.includes(`${old}</loc>`), `${sm} does not list ${old}`);
  }
}

// --- /docs carries the folded sections ----------------------------------------
{
  const docs = await (await fetch(`${BASE}/docs`)).text();
  // Examples: every cost line is the one the live catalog computes.
  const ex = (docs.match(/<h2 id="examples"[\s\S]*?<\/section>/) || [""])[0];
  ok(ex.length > 0, "/docs renders the #examples section");
  const pricing = await (await fetch(`${BASE}/api/pricing`)).json();
  const rows = pricing.endpoints || [];
  const catalog = Object.fromEntries(rows.filter((t) => t && t.slug).map((t) => [`${t.method} ${t.path}`, { slug: t.slug, price: t.price }]));
  ok(Object.keys(catalog).length > 100, `/api/pricing yields the catalog for the check (${Object.keys(catalog).length} rows)`);
  let priced = 0;
  for (const uc of USE_CASES) {
    ok(ex.includes(`<h3>${esc(uc.title)}</h3>`), `/docs#examples lists "${uc.title}"`);
    const cost = useCaseCost(uc, catalog);
    if (cost) {
      priced++;
      const cut = cost.indexOf(" (");
      ok(ex.includes(`<span class="ex-price">${esc(cost.slice(0, cut))}</span>`) && ex.includes(esc(cost.slice(cut + 1))), `/docs#examples "${uc.title}" cost is the live one (${cost})`);
    }
  }
  ok(priced >= USE_CASES.length - 1 && /Cost at list price:/.test(ex), `/docs#examples prices the examples from the catalog (${priced}/${USE_CASES.length})`);

  // Badges: each style's preview and both snippets; the images still serve.
  const bd = (docs.match(/<h2 id="badges"[\s\S]*?<\/section>/) || [""])[0];
  ok(bd.length > 0, "/docs renders the #badges section");
  for (const b of BADGE_STYLES) {
    ok(bd.includes(`src="/badges/${b.style}.svg"`) && bd.includes(`/badges/${b.style}.svg)](`), `/docs#badges shows ${b.style} with its Markdown snippet`);
    const img = await fetch(`${BASE}/badges/${b.style}.svg`);
    ok(img.status === 200 && (img.headers.get("content-type") || "").includes("image/svg+xml") && (await img.text()).startsWith("<svg"), `/badges/${b.style}.svg still serves an SVG (got ${img.status})`);
  }
  ok(docs.includes('<script src="/js/copy-buttons.js"></script>'), "/docs loads the copy-button script for the badge snippets");
}

// --- the weekly digest is retired ----------------------------------------------
{
  const r = await fetch(`${BASE}/api/digest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com", creditsKey: "a402_x" }) });
  const j = await r.json().catch(() => ({}));
  ok(r.status === 410 && typeof j.error === "string" && /ended/.test(j.error), `POST /api/digest -> 410 with a JSON error (got ${r.status})`);
  for (const p of ["/digest/confirm?id=dg_abc&k=x", "/digest/unsubscribe?id=dg_abc&k=x", "/digest/confirm"]) {
    const res = await fetch(`${BASE}${p}`);
    const html = await res.text();
    ok(res.status === 200 && /digest has ended/i.test(html) && /nothing you need to do/i.test(html), `${p} -> 200 with the ended notice (got ${res.status})`);
    ok(/noindex/.test(res.headers.get("x-robots-tag") || ""), `${p} is noindex`);
  }
  const one = await fetch(`${BASE}/digest/unsubscribe?id=dg_abc&k=x`, { method: "POST" });
  ok(one.status === 200, `one-click POST /digest/unsubscribe -> 200 (got ${one.status})`);
  for (const p of ["/__operator/digest.json"]) {
    const res = await fetch(`${BASE}${p}`);
    ok(res.status === 404, `${p} is gone (got ${res.status})`);
  }

  // No served page offers the digest.
  // The IPO monitor's own "weekly digest of every IPO" is a different product.
  const OFFERS = /spend digest|>weekly digest<|weekly digest\b(?! of every IPO)|href="\/digest"|agent402\.tools\/digest|\/api\/digest|digest-signup/i;
  ok(OFFERS.test('<a href="/digest">weekly digest</a>') && OFFERS.test("Weekly spend digest - Agent402") && OFFERS.test("the weekly digest) is sent"), "control: the digest-offer pattern matches the copy that shipped");
  ok(!OFFERS.test("A weekly digest of every IPO that priced (424B4)"), "control: the IPO monitor's description is not a digest offer");
  const paths = new Set(["/", "/docs", "/pricing", "/privacy", "/credits", "/tools/my-usage", "/llms.txt", "/llms-full.txt", "/og/digest.svg"]);
  for (const sm of ["/sitemap-pages.xml", "/sitemap-guides.xml"]) {
    const xml = await (await fetch(`${BASE}${sm}`)).text().catch(() => "");
    for (const m of xml.matchAll(/<loc>https?:\/\/[^/<]+(\/[^<]*)<\/loc>/g)) paths.add(m[1]);
  }
  const offers = [];
  for (const p of paths) {
    const res = await fetch(`${BASE}${p}`).catch(() => null);
    if (!res || res.status !== 200) continue;
    const m = String(await res.text()).match(OFFERS);
    if (m) offers.push(`${p}: "${m[0]}"`);
  }
  ok(offers.length === 0, `no served page offers the weekly digest${offers.length ? ` - ${offers.join(" | ")}` : ""}`);
}

  console.log(`\n${pass} passed (${PAGES.length} pages + error template)`);
  proc.kill("SIGKILL");
  process.exit(0);
} catch (e) {
  fail(e.message);
}
