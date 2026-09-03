// Offline unit tests for the /skills index page renderer (src/skills.js's
// skillsIndex, Aug 2026 revamp). No server, no network - real SKILL_PACKS
// data, since the page has no fixture-able inputs of its own (unlike the
// other revamped pages, it takes only baseUrl).
import { skillsIndex, SKILL_PACKS, PACK_PRICES, skillPackPage, skillPacksJson, PACK_PRICE_RANGE } from "../src/skills.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const BASE_URL = "https://agent402.tools";
const FLAGSHIP = ["security-audit", "trend-analysis", "structured-scrape", "document-intel", "decode-blob", "forecasting-bake-off"];

const html = skillsIndex(BASE_URL);

// --- real data rendering ------------------------------------------------------
ok(html.includes("Seven tools.") && html.includes("One <span"), "hero H1 renders");
ok(html.includes(`${SKILL_PACKS.length}+ packs, ${PACK_PRICE_RANGE.text}`) && html.includes("priced below the sum of its tools"), "hero cites the real live pack count, the derived price range and the rule");

const flagshipCount = (html.match(/class="sk-flagship"/g) || []).length;
ok(flagshipCount === 6, `exactly 6 flagship cards render (got ${flagshipCount})`);

const restChipCount = (html.match(/class="sk-rest-chip"/g) || []).length;
ok(restChipCount === SKILL_PACKS.length - 6, `the remaining ${SKILL_PACKS.length - 6} packs render as chips, matching SKILL_PACKS.length - 6 (got ${restChipCount})`);

// Every flagship pack's REAL tool sequence must appear verbatim - this is
// the exact class of bug the design handoff's own README flagged (an
// earlier draft had trend-analysis wrong). Read from live SKILL_PACKS, not
// hardcoded here, so a future pack edit can't silently desync the page from
// the data it claims to describe.
for (const slug of FLAGSHIP) {
  const pack = SKILL_PACKS.find((p) => p.slug === slug);
  ok(pack, `flagship pack "${slug}" exists in SKILL_PACKS`);
  if (!pack) continue;
  const seq = pack.toolSlugs.join(" · ");
  ok(html.includes(seq), `"${slug}" renders its REAL tool sequence verbatim: ${seq}`);
}

// forecasting-bake-off specifically: the design handoff's own copy dropped
// the "forecast-" prefix on four slugs (naive/ses/holt/holt-winters), which
// aren't real catalog slugs - a reader following that link would 404. Lock
// that the corrected, real slugs render instead.
ok(html.includes("forecast-naive") && html.includes("forecast-ses") && html.includes("forecast-holt") && html.includes("forecast-holt-winters"), "forecasting-bake-off renders the REAL forecast-* slugs, not the design's abbreviated (404-prone) versions");
ok(!/[^-]\bnaive\b/.test(html.split("forecasting-bake-off")[1]?.split("</a>")[0] || ""), "forecasting-bake-off's card never renders the bare (non-prefixed) 'naive' slug");

// --- pricing honesty: real range, not invented -------------------------------
{
  const prices = SKILL_PACKS.map((p) => PACK_PRICES[p.slug]);
  ok(prices.every((n) => Number.isFinite(n) && n >= 0.001), "every listed pack has a derived price at or above the $0.001 floor");
  ok(html.includes("How is a pack priced?") && html.includes("10% bundle discount"), "the FAQ states the pricing rule");
}

// --- illustrative run is labelled, not presented as a live guarantee --------
ok(html.includes("Illustrative run"), "the partial-success example table is explicitly labelled illustrative");
ok(html.includes("tls-cert") && html.includes("handshake timed out"), "illustrative failed step renders with its reason");
ok(html.includes(">failed<"), "illustrative table shows a real failed-step status, not all-green");

// --- shared CSS: skillPackPage's classes must still work after the rewrite --
// skillsIndex and skillPackPage share one SKILLS_CSS constant; the rewrite
// replaced the now-unused .sk-grid/.sk-card/.sk-meta rules (verified unused
// elsewhere before removal) but must not have touched anything
// skillPackPage depends on.
{
  const detail = skillPackPage(BASE_URL, "security-audit", {});
  ok(typeof detail === "string" && detail.includes('class="sk-tl"'), "skillPackPage still renders with .sk-tl (shared CSS untouched for the detail page)");
  ok(detail.includes("Tools in this pack"), "skillPackPage still renders its own sections unchanged");
}
{
  const json = skillPacksJson();
  ok(Array.isArray(json.packs) && json.packs.length === SKILL_PACKS.length, "skillPacksJson still returns every pack unchanged");
}

// --- structured data -----------------------------------------------------------
ok(html.includes('"@type":"Organization"'), "Organization JSON-LD present");
ok(html.includes('"@type":"BreadcrumbList"'), "BreadcrumbList JSON-LD present, Agent402 → Our tools → Skill packs");
ok(html.includes('"@type":"CollectionPage"'), "CollectionPage JSON-LD present");
ok(html.includes('"@type":"SoftwareApplication"') && html.includes('"@type":"AggregateOffer"'), "SoftwareApplication + AggregateOffer JSON-LD present");
{
  const offerCountMatch = html.match(/"offerCount":"(\d+)"/);
  ok(offerCountMatch && Number(offerCountMatch[1]) === SKILL_PACKS.length, `AggregateOffer offerCount matches the real live pack count (got ${offerCountMatch?.[1]})`);
}
ok(html.includes('"@type":"ItemList"'), "ItemList JSON-LD present for the 6 flagship packs");
{
  // Each JSON-LD object ledgerShell renders is its own <script> tag (not one
  // @graph array), so isolate the ItemList block specifically before
  // counting - a naive split on the shared "#packs" @id string would first
  // match CollectionPage's mainEntity reference to it instead.
  const itemListBlock = html.match(/<script type="application\/ld\+json">\{"@type":"ItemList"[\s\S]*?<\/script>/);
  const itemListMatches = itemListBlock ? (itemListBlock[0].match(/"@type":"ListItem"/g) || []) : [];
  ok(itemListMatches.length === 6, `ItemList JSON-LD carries exactly 6 flagship entries (got ${itemListMatches.length})`);
}
{
  const faqLdCount = (html.match(/"@type":"Question"/g) || []).length;
  const faqVisibleCount = (html.match(/<article style="padding:22px 0/g) || []).length;
  ok(faqLdCount === 5, `FAQPage JSON-LD carries exactly 5 questions (got ${faqLdCount})`);
  ok(faqVisibleCount === 5, `visible FAQ prose carries exactly 5 questions, matching the schema 1:1 (got ${faqVisibleCount})`);
}

// --- tab strip + breadcrumb ----------------------------------------------------
ok(html.includes(">Skill packs<") && html.includes("border-bottom:2px solid var(--accent)"), "tab strip marks Skill packs as the active tab");
ok(html.includes('href="/tools"') && html.includes('href="/marketplace/tools"'), "tab strip links to Tools and the all-indexed-tools escape hatch");
ok(/agent402.*our tools.*skill packs/is.test(html.split("<header")[1]?.slice(0, 500) || ""), "breadcrumb reads agent402 / our tools / skill packs");

// --- copy hygiene -----------------------------------------------------------
ok(!html.includes("—"), "no em dashes anywhere in the page copy");

// --- no template artifacts -----------------------------------------------------
ok(!/undefined|NaN|\[object Object\]/.test(html), "no template artifacts leak into the render");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
