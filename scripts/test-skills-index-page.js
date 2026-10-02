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
ok(html.includes(`${SKILL_PACKS.length}+ packs, ${PACK_PRICE_RANGE.text}`) && html.includes("none priced above the sum of its tools"), "hero cites the real live pack count, the derived price range and the rule");
// The pricing claim must hold for EVERY pack. Rounding up to the $0.001 floor
// puts many packs exactly AT the sum of their tools, so the copy may claim
// "never above", never "below" (it said "below" while 34 of 84 sat at the sum).
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/skills.js", import.meta.url), "utf8");
  const rows = [...src.matchAll(/^\s+"([a-z0-9-]+)": ([0-9.]+), \/\/ \d+ tools?, parts \$([0-9.]+)/gm)];
  ok(rows.length === SKILL_PACKS.length, `every pack price row carries its parts sum (${rows.length}/${SKILL_PACKS.length})`);
  const over = rows.filter(([, , price, parts]) => Number(price) > Number(parts));
  ok(over.length === 0, `no pack is priced above the sum of its tools${over.length ? `: ${over.map((r) => r[1]).join(", ")}` : ""}`);
  const atSum = rows.filter(([, , price, parts]) => Number(price) === Number(parts)).length;
  ok(atSum === 0 || !/priced below the sum|Below its parts|cheaper than assembling/.test(html + src),
    `${atSum} pack(s) sit at the sum of their tools, so no copy may claim every pack is below it`);
  const lo = html.match(/"lowPrice":"([0-9.]+)"/)?.[1], hi = html.match(/"highPrice":"([0-9.]+)"/)?.[1];
  ok(Number(lo) === PACK_PRICE_RANGE.min && Number(hi) === PACK_PRICE_RANGE.max, `AggregateOffer low/high derive from PACK_PRICE_RANGE (got ${lo}/${hi})`);
  ok(/\$\{PACK_PRICE_RANGE\.text\} per pack, no signup/.test(src) && !/\$0\.05-\$1\.50/.test(html + src), "the page description quotes the derived range, never the retired $0.05-$1.50");
}

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
// --- "Call it directly" snippet runs against the published SDK (2026-10-02) --
// It used to read `npx agent402-client call <pack> {...}`, and the package
// ships no bin, so the command could not run. The snippet now uses the SDK's
// constructor + call(); this drives that exact call against a stubbed server.
{
  const { packClientSnippet } = await import("../src/skills.js");
  const { Agent402 } = await import("../client/index.js");
  const { readFileSync } = await import("node:fs");
  const catalog = { "POST /api/skill/security-audit": { slug: "skill-security-audit", route: "POST /api/skill/security-audit", price: "$0.017", discovery: {} } };
  const detail = skillPackPage(BASE_URL, "security-audit", catalog);
  const snippet = packClientSnippet("skill-security-audit", { domain: "example.com" });
  ok(detail.includes("client.call(&quot;skill-security-audit&quot;"), "pack page shows the SDK call keyed on the catalog slug");
  ok(!/npx agent402-client/.test(detail), "pack page does not show a CLI the package does not ship");
  const pkg = JSON.parse(readFileSync(new URL("../client/package.json", import.meta.url), "utf8"));
  ok(/import \{ Agent402 \} from "agent402-client"/.test(snippet) && pkg.name === "agent402-client" && pkg.bin === undefined, "snippet imports the package the way it is published (a library, no bin)");
  const hits = [];
  const stub = async (url, init = {}) => {
    const u = new URL(url);
    hits.push(`${init.method || "GET"} ${u.pathname}`);
    if (u.pathname === "/api/pricing") return new Response(JSON.stringify({ endpoints: [{ slug: "skill-security-audit", method: "POST", path: "/api/skill/security-audit", computePayable: true, price: "$0.017" }] }), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/skill/security-audit") return new Response(JSON.stringify({ pack: "security-audit", args: JSON.parse(init.body || "{}"), steps: [], summary: "0/0" }), { headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  };
  const m = snippet.match(/client\.call\(("[^"]+"), (\{.*\})\);/);
  const client = new Agent402({ baseUrl: "http://stub.test", fetchImpl: stub, cache: false });
  let out = null, err = null;
  try { out = await client.call(JSON.parse(m[1]), JSON.parse(m[2])); } catch (e2) { err = e2; }
  ok(out && out.pack === "security-audit" && out.args.domain === "example.com" && hits.includes("POST /api/skill/security-audit"),
    `the snippet's call() resolves and posts the pack args${err ? ` (error: ${err.message})` : ""}`);
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
  const itemListBlock = html.match(/<script type="application\/ld\+json">\{(?:"@context":"https:\/\/schema.org",)?"@type":"ItemList"[\s\S]*?<\/script>/);
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
