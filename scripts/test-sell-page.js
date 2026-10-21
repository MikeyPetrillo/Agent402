// Offline unit tests for the /sell hub renderer (Aug 2026 revamp). No
// server, no network — sellPage() takes no live-data args any more (the
// new design surfaces no free aggregate numbers on this page at all, only
// static "what it costs you" copy and a lane-level teaser for the paid
// /api/bestsellers + /api/demand-radar reads).
import { readFileSync } from "node:fs";
import { sellPage, catalogPriceOf } from "../src/sell.js";
import { X402_TOOLS } from "../src/tools/x402-kit.js";
import { buildSellerPayabilityTool } from "../src/tools/seller-payability-kit.js";
import { routingProofSentence } from "../src/routing-proof.js";
import { ROUTE_ORDER } from "../src/route-order.js";
import { decodeEntities, stripScripts, stripTags } from "./lib/html-text.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// The real tool definitions the server's CATALOG holds for the paid seller
// reads this page quotes, so every price on the page is the catalog's.
const CATALOG = Object.fromEntries([...X402_TOOLS, buildSellerPayabilityTool({})].map((d) => [d.route, d]));
const html = sellPage("https://agent402.tools", CATALOG);
const text = decodeEntities(stripTags(html)).replace(/\s+/g, " ");

// --- hero ---------------------------------------------------------------
ok(html.includes("Agents are buying") && html.includes(">paid<") && html.includes("for it."), "hero H1 renders");
ok(html.includes("WHAT IT COSTS YOU"), "cost table header renders");
ok(html.includes(">$0<") && html.includes(">0%<"), "cost table shows $0 listing fee and 0% deducted");
ok(html.includes("cut of your sales") && html.includes("optional, paid"), "cost table says no cut of sales and that the seller tools are optional paid reads");
ok(!/buyer side only|Buyer side, and only there/i.test(html), "no claim that we earn on the buyer side only (the seller reads on this page are paid)");

// --- commercial sensitivity: lane-level demand only, no per-tool figures --
ok(html.includes("Demand data from our own sales ledger"), "demand section renders");
ok(!/anywhere else|nobody else/i.test(text), "no unprovable claims about what third parties hold");
ok(!/spend most in|in order\./.test(text) && text.includes("in no particular order") && text.includes("unranked"), "the hand-written lane list does not claim a spend ranking it cannot derive");
ok(html.includes("Hashing &amp; encoding") || html.includes("Hashing & encoding"), "lane names render");
ok(html.includes("figures withheld"), "lane table discloses figures are withheld, not shown free");
ok(html.includes("/tools/bestsellers"), "bestsellers upsell links out");
for (const slug of ["bestsellers", "demand-radar", "seller-payability", "x402-audit"]) {
  const p = catalogPriceOf(CATALOG, slug);
  ok(p && text.includes(p), `${slug}'s catalog price (${p}) is the one the page quotes`);
}
{
  const { readFileSync: rf } = await import("node:fs");
  const src = rf(new URL("../src/sell.js", import.meta.url), "utf8");
  ok(!/\$0\.0\d+|\$0\.10\b|half a cent/.test(src), "src/sell.js types no tool price: every price is read from the catalog");
  const bare = sellPage("https://agent402.tools");
  ok(!/\$0\.00[1-9]|\$0\.10\b/.test(stripScripts(bare, "")), "rendered without a catalog, the page quotes no tool price rather than a stale one");
}
ok(html.includes("/tools/demand-radar"), "demand-radar upsell links out");
// The one thing this page must never do: pair a tool slug with a purchase
// count. Every catalog price on this page is a flat UPSELL price ($0.005),
// never a per-tool sales/purchase figure — check no bare integer sits next
// to a known tool-shaped identifier outside the upsell links themselves.
ok(!/\b\d{1,3}(,\d{3})*\s*(purchases|sales|buyers)\b/i.test(html.replace(/\/tools\/(bestsellers|demand-radar)/g, "")),
  "no per-tool purchase/sales/buyer count rendered anywhere on the page");

// --- register form: same id/posture as market-page.js ---------------------
ok(html.includes('id="list-api"') && html.includes('id="reg-origin"') && html.includes('id="reg-go"') && html.includes('id="reg-out"'), "register form present with market-page.js's ids");
ok(html.includes('<script src="/js/reg-form.js">'), "register form's behavior is externalized (CSP hardening) — the page references the shared script, not an inline one");
// CSP hardening (2026-08-16) moved this handler to assets/js/reg-form.js -
// the textContent-only invariant now lives there, not in the page HTML.
const regFormJs = readFileSync(new URL("../assets/js/reg-form.js", import.meta.url), "utf8");
ok(regFormJs.includes("/api/index/register"), "the shared script posts to /api/index/register");
ok(regFormJs.includes("out.textContent") && !regFormJs.includes("innerHTML"), "register-result rendering is textContent-only, never innerHTML");

// --- how-we-earn / commitments --------------------------------------------
ok(html.includes("HOW WE MAKE MONEY") && html.includes("THE COMMITMENTS") || html.includes("The commitments"), "how-we-earn and commitments sections render");
ok(html.includes("src/route-order.js") && html.includes("src/ledger-leaderboard.js") && html.includes("github.com/MikeyPetrillo/Agent402"), "commitments link to the ranking order and the leaderboard self-exclusion source");
ok((html.match(/We never/g) || []).length >= 4, "at least four explicit 'We never' commitments render");

// --- rails ------------------------------------------------------------
ok(html.includes(">Base<") && html.includes(">Robinhood Chain<"), "rail marks render every chain including Robinhood Chain");
ok(html.includes(">USDG<"), "Robinhood's asset is labelled USDG, not USDC");

// --- router promises match route-execute / dispatch-eligibility ----------
ok(!/same terms|does not care whose tool|routes matching buyer tasks to you|sends you work/i.test(text), "no claim that the router sends sellers work by default (it runs this catalog unless the buyer passes include:\"external\")");
ok((text.match(/include: "external"/g) || []).length >= 2, "the external opt-in is named where the router is described");
ok(text.split(routingProofSentence()).length - 1 >= 2, "routingProofSentence() (the router's payment gate) is quoted in step 04 and the router FAQ");
ok(text.includes("/api/index?seller=<your host>"), "the per-seller dispatch verdict is linked");
{
  const meta = (html.match(/<div class="ml-meta"[^>]*>((?:<span>[^<]*<\/span>)+)<\/div>\s*<p[^>]*>Four places/) || [])[1] || "";
  const spans = [...meta.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
  ok(spans.slice(0, ROUTE_ORDER.length).join("|") === ROUTE_ORDER.map((o) => o.short).join("|"), `the router meta row is ROUTE_ORDER, in order (${ROUTE_ORDER.map((o) => o.short).join(" > ")})`);
}
ok(text.includes("Settled Base USDC volume shows up on the public on-chain leaderboard"), "the leaderboard claim is scoped to Base USDC (src/leaderboard.js)");
ok(!/Gas is sponsored by the facilitator on EVM chains/.test(text) && text.includes("x402 exact scheme on EVM chains"), "the gas claim is scoped to the x402 exact scheme");
ok(!/Coinbase/.test(text), "no third-party company name in the copy");
ok(!/never off the roster|on the next pass/.test(text), "listing and registration timing say what the crawler does");

// --- FAQ ----------------------------------------------------------------
ok(html.includes("What does it cost to list?"), "seller FAQ renders");
ok((html.match(/<article/g) || []).length >= 6, "all six FAQ questions render as full prose articles");

// --- JSON-LD --------------------------------------------------------------
ok(html.includes("application/ld+json") && html.includes('"@type":"Service"'), "Service JSON-LD present");
ok(html.includes('"@type":"HowTo"') && html.includes('"totalTime":"PT15M"'), "HowTo JSON-LD present");
ok(html.includes('"@type":"FAQPage"'), "FAQPage JSON-LD present");
ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present");

// --- copy hygiene: no em dashes anywhere on the page -----------------------
ok(!html.includes("—"), "no em dashes anywhere in the page copy");

// --- new sellers: each verdict explained, the floor's figure never stated ---
{
  const { DISPATCH_REASONS } = await import("../src/dispatch-eligibility.js");
  const start = html.indexOf('id="new-sellers"');
  const sec = start < 0 ? "" : html.slice(html.indexOf(">", start) + 1, html.indexOf("</section>", start));
  ok(sec.length > 0, "the page carries a #new-sellers section");
  // Every refusal reason the router emits is listed (an eligible verdict is not).
  const NOT_REFUSALS = new Set(["eligible", "local_catalog", "settlement_checked_at_pay_time"]);
  for (const code of Object.keys(DISPATCH_REASONS).filter((c) => !NOT_REFUSALS.has(c))) {
    ok(sec.includes(`>${code}<`) && sec.includes(DISPATCH_REASONS[code].slice(0, 40).replace(/"/g, "&quot;").replace(/'/g, "&#39;")), `${code}: named with the router's own reason text`);
  }
  // The floor's figures are server config (SOR_MIN_SETTLED_TX / SOR_MIN_DISTINCT_PAYERS):
  // no bare number outside a price, a code name or an HTTP status may appear.
  const text = sec.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  const stray = (text.match(/(?<![$\w./-])\d+(?![\w.%-])/g) || []).filter((n) => n !== "402");
  ok(stray.length === 0, `no floor figure in the section (stray numbers: ${stray.join(", ") || "none"})`);
  ok(/seller-trust answer/.test(text) && !/private|don.t quote|not publish/i.test(text), "the section points to where a seller reads the exact gate and never claims the figure is hidden (it is readable server config and a seller-trust field)");
  const faq = FAQ_TEXT_OF(html);
  ok(/settlement floor/i.test(faq) && !/\b(50|3) (settle|payer|transaction)/i.test(faq), "the floor FAQ explains it without a figure");
}
function FAQ_TEXT_OF(h) { const i = h.indexOf("What is the settlement floor"); return i < 0 ? "" : h.slice(i, i + 1500); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
