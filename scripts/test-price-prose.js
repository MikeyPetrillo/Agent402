

// Any PRICE QUOTED IN PROSE on a served page must match a real price.
//
// scripts/test-docs-truth.js checks the price stated beside a ROUTE. It cannot
// see a sentence, and a sentence is what search engines and link previews show:
// after the 2026-08-23 repricing, /reports advertised "$1 or $2 by card and
// $0.20 to $1.10" and /monitors advertised "$3 a month" for a full day, in the
// meta and og:description of both pages, because prices live in three places
// and the prose quoting them was not one of them.
//
// The fix was to DERIVE those strings. This is the guard that keeps them
// derived: it fails on any dollar figure in a page description that is not an
// actual product price.
import { HUMAN_PRODUCTS } from "../src/human-checkout.js";
import { MONITOR_PRODUCTS } from "../src/stripe-subscriptions.js";
import { priceUsdFor } from "../src/report-tiers.js";
import { humanReportsPage } from "../src/human-reports-page.js";
import { monitorsPage } from "../src/monitors-page.js";

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };

// Every number that is legitimately a price today.
const real = new Set();
for (const p of Object.values(HUMAN_PRODUCTS)) {
  real.add((p.price / 100).toFixed(2));
  const a = priceUsdFor(p.slug);
  if (Number.isFinite(a)) real.add(a.toFixed(2));
}
for (const p of Object.values(MONITOR_PRODUCTS)) real.add((p.price / 100).toFixed(2));
// Credit packs are fixed denominations, not product prices.
for (const pack of ["20.00", "50.00", "100.00"]) real.add(pack);
ok(real.size > 3, `collected ${real.size} real price values from the product tables`);

const descOf = (html) => (html.match(/name="description" content="([^"]*)"/) || [])[1] || "";

for (const [name, html] of [["/reports", humanReportsPage("https://agent402.tools")], ["/monitors", monitorsPage("https://agent402.tools")]]) {
  const desc = descOf(html);
  ok(desc.length > 0, `${name} has a meta description`);
  const quoted = [...desc.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]).toFixed(2));
  ok(quoted.length > 0, `${name} description quotes ${quoted.length} price(s) - if this ever hits zero the check below is vacuous`);
  const bogus = quoted.filter((q) => !real.has(q));
  ok(bogus.length === 0, `${name}: every price quoted in its description is a real product price${bogus.length ? ` (not real: ${[...new Set(bogus)].join(", ")})` : ""}`);
  // And the og:description, which is what a link preview actually renders.
  const og = (html.match(/property="og:description" content="([^"]*)"/) || [])[1] || "";
  if (og) {
    const ogBogus = [...og.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]).toFixed(2)).filter((q) => !real.has(q));
    ok(ogBogus.length === 0, `${name}: og:description too${ogBogus.length ? ` (not real: ${[...new Set(ogBogus)].join(", ")})` : ""}`);
  }
}

// --- THE BODY, not only the description ------------------------------------
//
// The guard above reads a page's meta and og:description, and that is where the
// 2026-08-23 defect was found. It was not where the defect ENDED: the homepage
// carried its own hardcoded chips - "Dossier $1" against a $3 product, "Monitor
// $3/mo" against $5 - and they survived that whole fix untouched, because a
// description check cannot see a body. A visitor clicked a price we do not
// charge for a day and nobody's test could tell.
//
// So this reads the rendered homepage BODY. It is deliberately narrow: only
// price-shaped text inside the product chips, so ordinary copy that happens to
// contain a number is not dragged in.
{
  const { ledgerHomePage } = await import("../src/ledger-home.js");
  const home = ledgerHomePage("https://agent402.tools", {}, {}, null, []);
  ok(typeof home === "string" && home.length > 1000, "the homepage rendered for inspection");

  const chips = [...home.matchAll(/class="hm-chip"[^>]*>([^<]{1,60})</g)].map((m) => m[1]);
  ok(chips.length > 0, `the homepage has ${chips.length} product chips - if this hits zero the check below is vacuous`);

  const quoted = chips.flatMap((c) => [...c.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]).toFixed(2)));
  ok(quoted.length > 0, `those chips quote ${quoted.length} price(s)`);
  const bogus = quoted.filter((q) => !real.has(q));
  ok(bogus.length === 0,
    `every price on a homepage chip is a real product price${bogus.length ? ` (not real: ${[...new Set(bogus)].join(", ")})` : ""}`);

  // THE ABOVE IS NOT ENOUGH ON ITS OWN, and finding that out is the point.
  // Restoring the original bug - "Monitor $3/mo" against a $5 monitor - PASSED
  // it, because $3 is a real price for other products. "This number appears
  // somewhere in the price tables" is a much weaker claim than "this chip
  // states the price of the thing it links to". So each chip is matched to its
  // own product.
  const expect = (label, cents) => {
    const want = Number(cents) % 100 === 0 ? `$${Number(cents) / 100}` : `$${(Number(cents) / 100).toFixed(2)}`;
    const chip = chips.find((c) => c.trim().startsWith(label));
    ok(chip, `a homepage chip for "${label}" exists`);
    ok(chip && chip.includes(want),
      `the "${label}" chip states ${want}, the price of the product it links to (chip reads "${(chip || "").trim()}")`);
  };
  expect("Dossier", HUMAN_PRODUCTS["dossier"].price);
  expect("Fund 13F", HUMAN_PRODUCTS["fund-report"].price);
  expect("Domain audit", HUMAN_PRODUCTS["domain-audit"].price);
  expect("Deep research", HUMAN_PRODUCTS["research"].price);
  expect("Monitor", Math.min(...Object.values(MONITOR_PRODUCTS).map((m) => m.price)));
}

// The llms.txt reports paragraph is derived from the catalog + product tables.
{
  const { reportsParagraph } = await import("../src/seo.js");
  const { REPORT_TIERS } = await import("../src/report-tiers.js");
  const tools = Object.entries(REPORT_TIERS).map(([slug, t]) => ({ slug, route: `POST /v1/${slug}`, price: t.price }));
  tools.push({ slug: "ipo-report", route: "POST /v1/ipo-report", price: "$0.05" });
  const para = reportsParagraph("https://agent402.tools", tools);
  const allowed = new Set([...real, "0.05"]);
  const figures = [...para.matchAll(/\$(\d+\.\d{2})/g)].map((m) => m[1]);
  const bad = figures.filter((f) => !allowed.has(f));
  ok(figures.length >= 20 && bad.length === 0, `llms.txt reports paragraph: ${figures.length} dollar figures, every one a real price${bad.length ? ` (stale: ${bad.join(", ")})` : ""}`);
  ok(para.includes(`POST /v1/research (${REPORT_TIERS["research"].price})`) && para.includes(`for $${(Math.min(...Object.values(HUMAN_PRODUCTS).map((p) => p.price)) / 100).toFixed(2)} to $`) && para.includes(`Monitors ($${(Math.min(...Object.values(MONITOR_PRODUCTS).map((m) => m.price)) / 100).toFixed(2)}/month`), "paragraph carries the agent route prices, the card range and the monitor price from the tables");
  ok(!para.includes("$0.35)") && !para.includes("$3/month"), "the two stale figures that shipped 2026-08-23..27 cannot come back");
}

// --- the BODY of a page, and the MCP payload, not only its meta description --
// The 2026-08-23 guard checked meta descriptions, which is where the drift had
// been that week. The next drift was in a page BODY (/pricing said monitors
// were "$3 a month" for three weeks while /monitors, the homepage FAQ and
// /company all said $5) and in the hosted connector's payment.info, which
// quoted the whole pre-repricing ladder - every figure understated 1.7x to
// 3.4x. A machine surface is the worst place to under-quote: an agent budgets
// from it, pays, and is refused.
{
  const { reportLadderProse } = await import("../src/report-tiers.js");
  const { ledgerPricingPage } = await import("../src/ledger-pricing.js");
  const { readFileSync } = await import("node:fs");
  const ladder = reportLadderProse({ humanProducts: HUMAN_PRODUCTS, monitorProducts: MONITOR_PRODUCTS });
  const monthly = ladder.monthly;
  ok(/^\$\d/.test(monthly), `the monitor price derives from MONITOR_PRODUCTS (${monthly})`);

  // Page BODIES, rendered the way a visitor gets them.
  const pages = [["/pricing", ledgerPricingPage("https://agent402.tools", {})], ["/monitors", monitorsPage("https://agent402.tools")]];
  for (const [label, html] of pages) {
    const permonth = [...String(html).matchAll(/\$(\d+(?:\.\d+)?)\s*(?:a|per|\/)\s*month/gi)].map((m) => `$${m[1]}`);
    const wrong = [...new Set(permonth.filter((x) => x !== monthly))];
    ok(wrong.length === 0, `${label} body quotes only the real monthly price${wrong.length ? ` - found ${wrong.join(", ")} against ${monthly}` : ""}`);
  }

  // The hosted connector's payment.info is a MACHINE surface and drifted worst.
  // Pinned from source: it must derive the ladder, and must not carry a typed
  // one. A literal price in that block is the bug this is here to prevent.
  const mcp = readFileSync(new URL("../src/mcp-http.js", import.meta.url), "utf8");
  const block = mcp.slice(mcp.indexOf("reports: {"), mcp.indexOf("reports: {") + 1400);
  ok(/reportLadder\(\)\.agentLadder/.test(block), "the MCP connector derives the agent ladder rather than typing it");
  ok(/reportLadder\(\)\.monthlySentence/.test(block), "...and the monitor price");
  for (const stale of ["$0.35/$0.65/$1.10", "ticker pack $0.75", "$3 a month per target", "fund 13F $0.25"]) {
    ok(!mcp.includes(stale), `the ladder that shipped wrong cannot come back: "${stale}"`);
  }
}

// --- the AggregateOffer range is DERIVED from the catalog -------------------
// highPrice sat at a literal "1.50" while the real ceiling was $3.30
// (route-execute-pro), so the structured data Google reads understated our own
// range by more than half. Same class as every other stale price on this page:
// a number typed once beside a table that moves.
{
  const { ledgerHomePage } = await import("../src/ledger-home.js");
  const { CATALOG_FOR_TEST } = await import("./lib/home-catalog.js").catch(() => ({ CATALOG_FOR_TEST: null }));
  const catalog = CATALOG_FOR_TEST || { a: { slug: "a", price: "$0.001" }, b: { slug: "b", price: "$3.30" } };
  const html = ledgerHomePage("https://agent402.tools", catalog, {}, null, [], {});
  const hi = /"highPrice":"([0-9.]+)"/.exec(String(html));
  ok(hi && Number(hi[1]) === 3.30, `highPrice derives from the catalog ceiling (got ${hi ? hi[1] : "none"} for a $3.30 catalog)`);
  ok(!String(html).includes('"highPrice":"1.50"') || Number(hi?.[1]) === 1.5,
     "the old literal cannot come back while a dearer tool exists");
}

// --- body prices on /, /pricing and /use-cases come from the catalog --------
// The homepage typed "POST /v1/dossier $0.55" against an $0.85 route, /pricing
// typed render at $0.02 against $0.01 and payments "from $0.002" against $0.001,
// and every cost line on /use-cases had drifted. Rendered here against a catalog
// of deliberately odd prices: a typed figure cannot match them by coincidence.
{
  const { ledgerHomePage } = await import("../src/ledger-home.js");
  const { ledgerPricingPage } = await import("../src/ledger-pricing.js");
  const { useCasesPage, useCaseCost } = await import("../src/use-cases.js");
  const odd = {
    "POST /v1/dossier": { slug: "dossier", price: "$9.97", category: "research" },
    "POST /api/route/execute": { slug: "route-execute", price: "$0.077", category: "agent" },
    "GET /api/bestsellers": { slug: "bestsellers", price: "$0.0071", category: "x402" },
    "POST /api/render": { slug: "render", price: "$0.033", category: "web" },
    "POST /api/screenshot": { slug: "screenshot", price: "$0.044", category: "web" },
    "POST /api/extract": { slug: "extract", price: "$0.055", category: "web" },
    "POST /api/x402-quote": { slug: "x402-quote", price: "$0.006", category: "payments" },
    "POST /api/memory-write": { slug: "memory-write", price: "$0.009", category: "memory" },
    "POST /v1/metered/chat/completions": { slug: "v1-chat-metered", price: "$0.0013", category: "llm" },
    "GET /api/answer": { slug: "answer", price: "$0.081", category: "search" },
  };
  const home = ledgerHomePage("https://agent402.tools", odd, {}, null, [], {});
  ok(/POST \/v1\/metered\/chat\/completions<\/span><span[^>]*>from \$0\.0013</.test(home), "the homepage gateway row states the catalog price");
  ok(/GET \/api\/answer<\/span><span[^>]*>\$0\.081</.test(home), "...and the answer row");
  ok(/POST \/api\/route\/execute<\/span><span[^>]*>\$0\.077 \+ seller</.test(home), "...and the route-execute row");
  ok(home.includes("GET /api/bestsellers · $0.0071"), "...and the bestsellers kicker");
  const pricing = ledgerPricingPage("https://agent402.tools", odd);
  ok(pricing.includes("from $0.033"), "the /pricing browser row is the cheaper of render and screenshot, from the catalog");
  ok(pricing.includes("$0.055") && pricing.includes("$0.006") && pricing.includes("$0.009"), "...and extract, payments and memory read from the catalog");
  ok(!/>\$0\.02</.test(pricing) && !/from \$0\.002</.test(pricing), "no typed row figure survives");
  const uc = useCasesPage("https://agent402.tools", odd);
  const expected = useCaseCost({ calls: [["render", 20], ["extract", 20], ["memory-write", 20]], per: "per day" }, odd);
  ok(expected && expected.startsWith("$1.94 per day"), `the use-case cost is summed from catalog prices (${expected})`);
  ok(uc.includes(expected.slice(0, 14)), "and the page renders that computed cost");
  ok(!/~\$/.test(uc), "no typed approximate cost line is left on /use-cases");
}

// --- payment.info's OTHER price field ---------------------------------------
// The 2026-09-13 fix derived this tool's `reports` line and left the `prices`
// line beside it hand-typed, where it had kept "skill packs up to $1.50"
// (really $0.003-$0.119) and "report products $0.20-$1.10" (the ladder tops out
// at the $2.00 ticker pack) through two repricings. Same lesson as the guard
// that missed it: scope the check to every field that QUOTES the number, not to
// the one that drifted last.
{
  const { readFileSync: rf } = await import("node:fs");
  const src = rf(new URL("../src/mcp-http.js", import.meta.url), "utf8");
  ok(/PACK_PRICE_RANGE\.text/.test(src), "the connector renders the pack range from skills.js, never typed");
  ok(/agentReportPriceRange\(\)/.test(src), "the connector renders the report range from REPORT_TIERS, never typed");
  for (const stale of ["up to $1.50", "$0.20–$1.10", "$0.20-$1.10"]) {
    ok(!src.includes(stale), `the connector no longer carries the stale figure "${stale}"`);
  }
  const { agentReportPriceRange } = await import("../src/report-tiers.js");
  const r = agentReportPriceRange();
  ok(r && r.max >= 2, `the report range reaches the priciest product (${r?.text}) rather than stopping at a mid tier`);
}


// --- retired price figures, swept across EVERY surface that quotes one -------
// The pack ceiling moved twice (a hand-written table, then a derived one) and
// the card floor moved once, and the prose that quoted them was never swept:
// the retired pack ceiling was still live on /faq, the wiki FAQ, a PUBLISHED
// npm README and two docs pages, and /faq quoted the card range below its own
// floor. Each earlier guard was scoped to the page that drifted last, so each
// found nothing. This one is scoped to the FIGURE.
{
  const { readFileSync: rf, readdirSync: rd } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const SKIP = new Set(["node_modules", ".git", "dist", "coverage", "assets"]);
  const walk = (rel, out = [], d = 0) => {
    let names = [];
    try { names = rd(join(root, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of names) {
      if (SKIP.has(e.name)) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (d < 4) walk(next, out, d + 1); }
      else if (/\.(js|md)$/.test(e.name)) out.push(next);
    }
    return out;
  };
  // Every tracked text file, not a folder list: a folder list missed
  // skills/openclaw/agent402/SKILL.md and .cursor-plugin/plugin.json, both
  // public and both stale (2026-09-26). What is left out is named.
  const { execFileSync } = await import("node:child_process");
  const NOT_SURFACES = [/^scripts\/(?!.*card.*\.js$)/, /^\.github\//, /^CLAUDE\.md$/, /(^|\/)CHANGELOG\.md$/, /(^|\/)package-lock\.json$/, /\.test\.js$|(^|\/)test[^/]*\.js$/];
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter((f) => f && /\.(?:js|mjs|md|json|toml|txt|ya?ml|html)$/.test(f) && !NOT_SURFACES.some((re) => re.test(f)));
  void walk;
  ok(files.length >= 200, `sweeping ${files.length} surfaces for retired price figures`);

  const { PACK_PRICE_RANGE } = await import("../src/skills.js");
  const RETIRED = [
    ["up to $1.50", `the pack ceiling is ${PACK_PRICE_RANGE.text}; derive it from PACK_PRICE_RANGE`],
    ["$0.20 to $1.10", "the agent report ladder is $0.60-$2.00; derive it from REPORT_TIERS"],
    ["$0.20–$1.10", "the agent report ladder is $0.60-$2.00; derive it from REPORT_TIERS"],
    ["$1 to $2 by card", "the card ladder is $2 to $5; derive it from HUMAN_PRODUCTS"],
    ["$0.55 (`route-execute-max`)", "route-execute-pro is $3.30, so the routing tiers do not top out there"],
    ["200+ pure-CPU", "the proof-of-work tier is the eligible list at /api/pow (166 tools on 2026-09-26); do not type a count"],
    ["Over\n200 of the 500+ tools", "the proof-of-work tier is the eligible list at /api/pow; do not type a count"],
    ["100 skill packs", "the pack count is live on /skills; the public copy says 70+"],
    ["Base + 4 more chains", "the payment rails are the networks in /api/pricing, not a typed count"],
    ["$0.003 to $0.119", `a retired pack range; the packs run ${PACK_PRICE_RANGE.text} (PACK_PRICE_RANGE)`],
    ["200+ deterministic pure-CPU", "the proof-of-work tier is the eligible list at /api/pow; do not type a count"],
    ["100+ **skill packs**", "the pack count is live on /skills; it was never 100+"],
  ];
  // A markdown surface cannot derive, so a pack range it does quote must equal
  // the derived one; a range that drifts again is reported here, not by a buyer.
  for (const f of files.filter((x) => x.endsWith(".md"))) {
    const text = (() => { try { return rf(join(root, f), "utf8"); } catch { return ""; } })();
    for (const m of text.matchAll(/skill packs run (\$[0-9.]+ to \$[0-9.]+)/g)) {
      ok(m[1] === PACK_PRICE_RANGE.text, `${f} quotes the pack range ${m[1]}, and PACK_PRICE_RANGE is ${PACK_PRICE_RANGE.text}`);
    }
  }
  // Control first: the sweep must report a planted figure through this path.
  const scan = (entries) => {
    const hits = [];
    for (const [rel, text] of entries) {
      if (rel === "scripts/test-price-prose.js") continue;
      for (const [lit, why] of RETIRED) if (text?.includes(lit)) hits.push(`${rel} quotes "${lit}" (${why})`);
    }
    return hits;
  };
  ok(scan([["<control>", "multi-tool skill packs run up to $1.50 per call"]]).length === 1,
     "control: a retired figure is reported through this exact code path");
  const stale = scan(files.map((f) => [f, (() => { try { return rf(join(root, f), "utf8"); } catch { return null; } })()]));
  ok(stale.length === 0, `no surface quotes a retired price${stale.length ? ` - ${stale.join(" | ")}` : ""}`);
}

console.log(`\n${pass} passed, 0 failed`);
