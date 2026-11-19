// Seller reputation states measurements, never a judgment of the seller. A
// record, its labels and methods, the seller card line, the re-check answer
// and every page that describes it (the method page, llms.txt and
// llms-full.txt, openapi, the changelog entries) are read here for words that
// characterize a seller (dishonest, unreliable, bad and their kin). The price
// metric is "price matches listing": what was compared, not a verdict.
// Offline.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { readFileSync } from "node:fs";

const R = await import("../src/seller-reputation.js");
const { sellerReputationLineHtml } = await import("../src/market-page.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

export const JUDGMENT = /\b(dis)?honest(y|ly)?\b|\bunreliab(le|ility)\b|\breliab(le|ility)\b|\bbad\b|\buntrust(worthy|ed)\b|\btrustworthy\b|\bscam\w*|\bfraud\w*|\bshady\b|\bpoor(ly)?\b|\bliar\b|\bcheat\w*|\bsketchy\b|\bsuspicious\b|\bgood\b|\bblacklist\w*/i;
const hits = (text) => {
  const out = [];
  const re = new RegExp(JUDGMENT.source, "gi");
  let m;
  while ((m = re.exec(String(text)))) out.push(m[0]);
  return out;
};
const check = (label, text) => { const h = hits(text); ok(h.length === 0 && String(text).length > 0, `${label}: no judgment word${h.length ? ` (found: ${[...new Set(h)].join(", ")})` : ""}`); };

ok(hits("a dishonest seller").length === 1 && hits("Unreliable").length === 1 && hits("bad price").length === 1 && hits("price honesty").length === 1 && hits("measured uptime").length === 0, "control: the pattern catches each word and leaves plain measurement words alone");

// Records over every shape a seller can have: nothing measured, every metric
// low, every metric high, issue days, a re-check scheduled and measured.
const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 19, 12), today = Math.floor(NOW / DAY);
const series = (ok, n) => { const s = []; for (let i = n - 1; i >= 0; i--) s.push(today - i, i < ok ? 1 : 0, 1); return s; };
const shapes = [
  {},
  { rec: { f: NOW - 40 * DAY, lc: NOW, lp: NOW, c: series(0, 20), p: series(0, 10), l: [today, 9000, today, 9000, today, 9000, today, 9000, today, 9000], q: [10, 0, NOW] }, delivery: { d: series(0, 10) } },
  { rec: { f: NOW - 40 * DAY, lc: NOW, lp: NOW, c: series(20, 20), p: series(10, 10), l: [today, 100, today, 100, today, 100, today, 100, today, 100], q: [10, 10, NOW], rk: NOW }, delivery: { d: series(10, 10) }, recheck: { requestedAt: NOW - 1000 } },
  { rec: { f: NOW - 40 * DAY, lc: NOW, lp: NOW, c: series(5, 20), p: series(5, 10), l: [], q: [4, 1, NOW] }, ourSideDays: [today, today - 1], recheck: { requestedAt: NOW } },
];
for (const [i, sh] of shapes.entries()) check(`reputation record, shape ${i}`, JSON.stringify(R.reputationOf({ ...sh, now: NOW })));
check("metric labels", Object.values(R.METRIC_LABELS).join(" | "));
check("metric methods", Object.values(R.METHODS).join(" | "));
check("legends and fixed phrases", [R.REPUTATION_LEGEND, R.TOOL_REPUTATION_LEGEND, R.DELIVERY_LABEL, R.OUR_SIDE_ISSUE].join(" | "));
for (const t of [{ price: 0.002, originDeclaredPrice: 0.001, quoteObservedAt: NOW - DAY }, { price: 0.001, originDeclaredPrice: 0.001, quoteObservedAt: NOW - DAY }, {}]) {
  check(`route row ${JSON.stringify(t).slice(0, 40)}`, JSON.stringify(R.toolReputationOf(t, { now: NOW })));
}
ok(R.METRIC_LABELS.priceMatchesListing === "price matches listing" && !Object.keys(R.METRIC_LABELS).some((k) => /honest/i.test(k)), "the price metric's field and label read price matches listing");
check("seller card line", sellerReputationLineHtml({ origin: "https://seller.example" }, "seller.example").replace(/<[^>]+>/g, " "));

// The pages that describe it.
check("wiki/Seller-Reputation.md", read("wiki/Seller-Reputation.md"));
const reputationLines = (text) => text.split("\n").filter((l) => /reputation/i.test(l)).join("\n");
check("llms.txt and llms-full.txt lines (src/seo.js)", reputationLines(read("src/seo.js")));
check("wiki/x402-Index-and-Router.md reputation row", reputationLines(read("wiki/x402-Index-and-Router.md")));
{
  const pages = read("src/pages.js");
  const from = pages.indexOf('paths["/api/reputation"]'), to = pages.indexOf("// Instance-wide MPP offer");
  ok(from > 0 && to > from, "found the openapi reputation paths");
  check("openapi reputation paths", pages.slice(from, to));
}
{
  const srv = read("src/server.js");
  const from = srv.indexOf("app.post(RECHECK_PATH"), to = srv.indexOf("\n});", from);
  ok(from > 0 && to > from, "found the re-check route");
  check("the re-check route's answers", srv.slice(from, to));
}
{
  const cl = read("CHANGELOG.md");
  const from = cl.indexOf("(seller reputation)");
  ok(from > 0, "found the seller reputation changelog entry");
  check("CHANGELOG.md seller reputation entry", cl.slice(from, cl.indexOf("\n### ", from)));
  const js = read("src/changelog.js");
  check("src/changelog.js reputation items", js.split("\n").filter((l) => /\/api\/reputation/.test(l)).join("\n"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
