// Agent402 Decide on the site: the /decide page, the nav item, the mobile and
// footer links, the homepage door and the sitemap entry all follow ONE flag -
// the decide tools being in the catalog. Off, nothing links a page that 404s;
// on, every figure the page quotes is read from the decide config. Offline.
//
//   node scripts/test-decide-site.js

import { ledgerShell, ledgerFooterCompact, setDecideLive, decideLive } from "../src/ledger-chrome.js";
import { ledgerHomePage } from "../src/ledger-home.js";
import { decidePage } from "../src/decide-page.js";
import { sitemapPages, sitemapXml } from "../src/seo.js";
import { decideConfig } from "../src/decide/config.js";
import { ogSectionFor, sectionCardSvg } from "../src/og-cards.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };

const BASE = "https://example.test";
const shell = () => ledgerShell({ title: "t", description: "d", canonical: BASE + "/", baseUrl: BASE, body: "<main>x</main>" });
const home = (catalog) => ledgerHomePage(BASE, catalog, {}, null, []);
const withDecide = { "POST /api/decide": { slug: "decide", price: 0.005 } };
const links = (html) => (html.match(/href="\/decide(?:#[a-z]+)?"/g) || []).length;

// ---- off ----
setDecideLive(false);
ok(decideLive() === false, "flag off");
ok(links(shell() + ledgerFooterCompact()) === 0, "nav, mobile menu and footer carry no /decide link when off");
ok(!home({}).includes('class="hm-milled hm-decide"'), "homepage renders no Decide door when off");
ok(!sitemapPages(BASE, {}).includes("/decide<"), "sitemap-pages omits /decide when the tool is absent");
ok(!sitemapXml(BASE, {}).includes("/decide<"), "sitemap.xml omits /decide when the tool is absent");

// ---- on ----
setDecideLive(true);
const s = shell();
ok(s.includes('class="ml-nav-link" href="/decide">Decide</a>'), "top nav carries Decide");
ok(s.includes("decide · a plan for any job"), "mobile menu carries Decide");
ok(/>decide<\/a>/.test(ledgerFooterCompact()), "footer carries decide");
const h = home({});
ok(h.includes('class="hm-milled hm-decide"') && h.includes("Describe the job. Get the plan."), "homepage renders the Decide door when on");
ok(h.indexOf('class="hm-doors"') < h.indexOf('class="hm-milled hm-decide"'), "the door sits below the two existing doors");
ok(sitemapPages(BASE, withDecide).includes(`${BASE}/decide<`), "sitemap-pages lists /decide when the tool is live");

// ---- the page quotes the config, never a typed figure ----
const c = decideConfig();
const page = decidePage(BASE, withDecide);
const usd = (n) => `$${Number(n).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
for (const d of ["quick", "plan", "full"]) ok(page.includes(usd(c.prices[d])), `page quotes the ${d} price from config (${usd(c.prices[d])})`);
ok(page.includes(`${c.routingFeePct}%`), "page quotes the routing fee from config");
ok(page.includes(`${c.credit.ttlHours} hours`), "page quotes the credit window from config");
ok(page.includes(`<link rel="canonical" href="${BASE}/decide"`), "canonical is /decide");
ok(page.includes('"FAQPage"'), "FAQ JSON-LD present");
ok(!/—/.test(page), "no em dashes");
ok(page.includes("no term for who sells") && page.includes("firstParty") && !/Neutral by construction/.test(page), "neutrality stated as what the code guarantees, not as an absolute");
const bumped = decideConfig({ DECIDE_CONFIG: JSON.stringify({ prices: { quick: 0.007 } }) });
ok(bumped.prices.quick === 0.007, "config override path reachable (control for the derivation check)");

// ---- the page's own social card ----
ok(ogSectionFor("/decide") === "decide", "/decide derives its own section card");
const card = sectionCardSvg("decide", { BRAND: {}, BRAND_DEFS: "", BRAND_FONT_STYLE: "", toolCount: 600, railCount: 12, decide: { quick: "$0.009", full: "$0.09" } });
ok(card && card.includes("$0.009 to $0.09"), "the card's price range comes from ctx, not typed");
ok(sectionCardSvg("decide", { BRAND: {}, BRAND_DEFS: "", BRAND_FONT_STYLE: "" }).includes("priced per decision"), "no ctx prices: the card states no figure");

setDecideLive(false);

// The page's example plan quotes real routes at their catalog prices.
{
  const cat = { "POST /api/sanctions/wallet": { slug: "sanctions-wallet", price: "$0.002" }, "POST /api/asset-transfers": { slug: "asset-transfers", price: "$0.003" } };
  const h = decidePage("https://agent402.tools", cat).replace(/&quot;/g, '"');
  ok(/"endpoint": "\/api\/asset-transfers"/.test(h) && !/alchemy\/asset-transfers/.test(h), "the example names the asset-transfers route the catalog serves");
  ok(/"priceUsd": 0\.002/.test(h) && /"priceUsd": 0\.003/.test(h) && /"estimatedCostUsd": 0\.005/.test(h), "the example's prices and total come from the catalog");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
