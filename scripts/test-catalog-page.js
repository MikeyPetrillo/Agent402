// Offline unit tests for the /tools catalog page renderer (Aug 2026 revamp).
// Fixture catalog — no server, no network.
import { ledgerCatalogPage } from "../src/ledger-catalog.js";
import { WALLET_ONLY_SLUGS } from "../src/pow.js";
import { FREE_TIER_SLUGS } from "../src/free-tier.js";
import { CATEGORIES } from "../src/pages.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

// The search-filter script lives in assets/js/catalog-search.js (external
// file, CSP hardening, 2026-08-16) — was inline in the page's own <script>
// block before that.
const catalogSearchScript = readFileSync(new URL("../assets/js/catalog-search.js", import.meta.url), "utf8");

// The free tier is an allowlist (src/free-tier.js, 2026-10-04): a slug is free
// only when listed there, so a fabricated slug now reads wallet-only. The free
// fixtures are real members of FREE_TIER_SLUGS; a real member of
// WALLET_ONLY_SLUGS is the guaranteed-paid one.
const [FREE_SLUG_A, FREE_SLUG_B, FREE_SLUG_C] = [...FREE_TIER_SLUGS];
const PAID_SLUG = [...WALLET_ONLY_SLUGS][0];
ok(typeof PAID_SLUG === "string" && PAID_SLUG.length > 0, "source: WALLET_ONLY_SLUGS has at least one real member to test against");

// "web" gets one free + one paid -> must render as the mixed "cpu + usdc"
// state, never a misleading pure "cpu" or "usdc". "text" gets two free ->
// pure "cpu". "memory" gets one paid -> pure "usdc". Reusing PAID_SLUG
// across two catalog entries is harmless here — isComputePayable() only
// ever reads the slug, never anything route-specific.
const catalog = {
  "GET /web-free": { slug: FREE_SLUG_A, category: "web", price: "$0.01", name: "web free fixture" },
  "GET /web-paid": { slug: PAID_SLUG, category: "web", price: "$0.01", name: "web paid fixture" },
  "GET /text-free-1": { slug: FREE_SLUG_B, category: "text", price: "$0.01", name: "text free fixture 1" },
  "GET /text-free-2": { slug: FREE_SLUG_C, category: "text", price: "$0.01", name: "text free fixture 2" },
  "GET /memory-paid": { slug: PAID_SLUG, category: "memory", price: "$0.01", name: "memory paid fixture" },
};

const skillPacks = [{ slug: "demo-pack", title: "Demo pack", tagline: "fixture" }];

const html = ledgerCatalogPage("https://agent402.tools", catalog, skillPacks);

// --- tab strip --------------------------------------------------------
ok(html.includes(">Tools<") && html.includes("Skill packs") && html.includes("Playground") && html.includes("Pricing") && html.includes("Integrations"), "tab strip renders all five tabs");
ok(html.includes("All indexed tools"), "dimmed all-indexed-tools tab renders, pointing at /marketplace/tools");

// --- category derivation: cpu / usdc / mixed, from real per-tool data -----
{
  const webStart = html.indexOf('data-cat="web"');
  const webEnd = html.indexOf("</tr>", webStart);
  const webRow = html.slice(webStart, webEnd);
  ok(webRow.includes("cpu + usdc"), "a category with one free + one paid tool renders the mixed 'cpu + usdc' state, not a misleading binary badge");

  const textStart = html.indexOf('data-cat="text"');
  const textEnd = html.indexOf("</tr>", textStart);
  const textRow = html.slice(textStart, textEnd);
  ok(/>cpu</.test(textRow) && !textRow.includes("usdc"), "a category with only free tools renders pure 'cpu'");

  const memStart = html.indexOf('data-cat="memory"');
  const memEnd = html.indexOf("</tr>", memStart);
  const memRow = html.slice(memStart, memEnd);
  ok(/>usdc</.test(memRow) && !memRow.includes("cpu"), "a category with only paid tools renders pure 'usdc'");
}
ok(html.includes("does not sum to"), "the legend discloses that a tool can appear in more than one category");
ok(html.includes("mixes both"), "the legend explains the mixed cpu + usdc state, not just the two pure states");

// --- category blurbs are the real CATEGORIES text, not a paraphrase -------
ok(html.includes(CATEGORIES.web.blurb.replace(/&/g, "&amp;")), "category blurb is the real, authoritative src/pages.js CATEGORIES text, not a shortened paraphrase");

// --- live client-side search filter (kept from the current page; the design
// mockup's redirect-to-/api/find-on-submit would dump raw JSON at a human
// visitor, so the working in-place filter is kept instead) -----------------
ok(html.includes('id="cat-search"') && html.includes('<script src="/js/catalog-search.js"></script>') && catalogSearchScript.includes("addEventListener('input'"), "live search filter script is present and wired to the input event, not a form submit");
ok(!html.includes("onSubmit"), "no form-submit-to-raw-JSON handler ships (the design mockup's behavior, deliberately not ported)");

// --- structured data --------------------------------------------------------
ok(html.includes('"@type":"CollectionPage"'), "CollectionPage JSON-LD present");
ok(html.includes('"@type":"ItemList"'), "ItemList JSON-LD present, one entry per category");
ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present");

// --- copy hygiene -----------------------------------------------------------
ok(!html.includes("—"), "no em dashes anywhere in the page copy");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
