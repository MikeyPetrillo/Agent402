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

console.log(`\n${pass} passed, 0 failed`);
