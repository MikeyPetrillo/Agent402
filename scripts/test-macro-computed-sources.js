// sahm-rule, cpi-yoy, unemployment-rate and fed-funds read the agencies that
// publish their inputs (src/tools/us-macro-series.js), never FRED. Offline:
// fetch is stubbed per host, with data dated relative to today.
//   1. no request goes to a FRED host; each tool declares the hosts it reads;
//   2. each answer keeps the fields its published example had, and carries
//      its publisher's credit, the retrieval date and the publisher's terms;
//   3. the Sahm Rule is computed here from the BLS unemployment rate (the
//      three-month average against the lowest three-month average of the
//      prior twelve months), and says so;
//   4. a month the publisher has no value for is listed in missingDates;
//   5. fed-funds gives calendar days, a weekend or holiday carrying the rate
//      of the business day before it;
//   6. the descriptions make no FRED claim, and the tools are keyless, so
//      the catalog sweeps drive them.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS } from "../src/tools/macro-kit.js";
import { BLS_VOUCH, TERMS, _resetUsMacroForTest } from "../src/tools/us-macro-series.js";
import { BLS_ATTRIBUTION, NYFED_ATTRIBUTION } from "../src/data-attribution.js";
import { METERED_SLUGS } from "../src/metered-slugs.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = (slug) => MACRO_TOOLS.find((t) => t.slug === slug);
const SLUGS = ["sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds"];
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };

// --- the definitions -----------------------------------------------------------------
const EXAMPLE_FIELDS = {
  "sahm-rule": ["date", "value", "triggered", "threshold", "source", "terms"],
  "cpi-yoy": ["date", "inflationYoYPct", "trailing12mo", "source", "missingDates", "terms"],
  "unemployment-rate": ["date", "current", "months", "history", "source", "terms"],
  "fed-funds": ["date", "current", "days", "history", "source", "terms"],
};
for (const slug of SLUGS) {
  const t = tool(slug);
  ok(t && t.attribution !== "fred" && !/FRED|St\. Louis|stlouisfed/.test(t.description), `${slug}: no FRED claim in the description or attribution`);
  ok(!METERED_SLUGS.has(slug), `${slug}: keyless, so the catalog sweeps drive it`);
  const want = slug === "fed-funds" ? ["markets.newyorkfed.org"] : ["api.bls.gov"];
  ok(JSON.stringify(t.upstreamHosts) === JSON.stringify(want), `${slug}: declares the host it reads through its source module (${JSON.stringify(t.upstreamHosts)})`);
  const ex = t.discovery.output.example;
  ok(EXAMPLE_FIELDS[slug].every((k) => Object.hasOwn(ex, k)) && !/FRED/.test(JSON.stringify(ex)), `${slug}: the published example keeps its fields and names no FRED series (${Object.keys(ex).join(",")})`);
  ok(ex.terms === (slug === "fed-funds" ? TERMS.nyfed : TERMS.bls), `${slug}: the example links the publisher's terms`);
}

// --- stubbed publishers, dated relative to today ------------------------------------------
const now = new Date();
const monthIso = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}-01`;
const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); return monthIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).getUTCFullYear(), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).getUTCMonth()); };
const LAST = monthIso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).getUTCFullYear(), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).getUTCMonth());
const MISSING = addMonths(LAST, -11); // a month the publisher has no value for
const months = []; for (let i = -40; i <= 0; i++) months.push(addMonths(LAST, i));
const unrate = (iso) => ({ [LAST]: 4.7, [addMonths(LAST, -1)]: 4.6, [addMonths(LAST, -2)]: 4.5 }[iso] ?? 4.0);
const cpi = (iso) => 300 * Math.pow(1.003, months.indexOf(iso));
const day = (d) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;
// The latest published business day: the last Monday before today; the
// Friday before it at a different rate, so the weekend's carry shows.
let monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY);
while (monday.getUTCDay() !== 1) monday = new Date(monday.getTime() - DAY);
const friday = new Date(monday.getTime() - 3 * DAY);

const realFetch = globalThis.fetch;
const undoDns = stubGuardResolver(offlineGuardAnswer);
const hosts = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  hosts.push(u.hostname);
  if (u.hostname === "api.bls.gov") {
    const b = JSON.parse(opts.body);
    const id = b.seriesid[0];
    const data = months
      .filter((m) => m !== MISSING && Number(m.slice(0, 4)) >= Number(b.startyear) && Number(m.slice(0, 4)) <= Number(b.endyear))
      .map((m) => ({ year: m.slice(0, 4), period: `M${m.slice(5, 7)}`, value: String(id === "LNS14000000" ? unrate(m) : id === "CUSR0000SA0" ? cpi(m).toFixed(3) : 0) }));
    if (months.includes(MISSING)) data.push({ year: MISSING.slice(0, 4), period: `M${MISSING.slice(5, 7)}`, value: "-" }); // a month not collected
    return json({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: id, data: data.reverse() }] } });
  }
  if (u.hostname === "markets.newyorkfed.org") {
    const rows = [];
    for (let d = new Date(monday.getTime() - 120 * DAY); d <= monday; d = new Date(d.getTime() + DAY)) {
      if ([0, 6].includes(d.getUTCDay())) continue;
      rows.push({ effectiveDate: day(d), type: "EFFR", percentRate: day(d) === day(friday) ? 3.9 : 3.88 });
    }
    return json({ refRates: rows.reverse() });
  }
  return new Response("unexpected host", { status: 599 });
};

try {
  _resetUsMacroForTest();
  // unemployment-rate
  const u4 = await tool("unemployment-rate").handler({ months: 4 });
  ok(u4.date === LAST && u4.current === 4.7 && u4.months === 4 && u4.history.map((r) => r.value).join() === "4,4.5,4.6,4.7" && u4.history[0].date === addMonths(LAST, -3), `unemployment-rate: the latest month and the trailing months, oldest first (${JSON.stringify(u4.history)})`);
  ok(u4.source === "U.S. Bureau of Labor Statistics" && u4.sourceSeries === "LNS14000000" && u4.credit === `${BLS_ATTRIBUTION} ${BLS_VOUCH}` && /^\d{4}-\d{2}-\d{2}T/.test(u4.retrievedAt) && u4.terms === TERMS.bls && u4.missingDates === undefined, "unemployment-rate: credits BLS with its statement, the retrieval date and the BLS terms");
  const u13 = await tool("unemployment-rate").handler({ months: 13 });
  ok(u13.months === 12 && JSON.stringify(u13.missingDates) === JSON.stringify([MISSING]) && /12 of the 13 months/.test(u13.note || ""), `unemployment-rate: a month with no published value is listed with a note (${JSON.stringify(u13.missingDates)})`);

  // sahm-rule
  const s = await tool("sahm-rule").handler({});
  ok(s.date === LAST && s.value === 0.6 && s.triggered === true && s.threshold === 0.5, `sahm-rule: the three-month average against the prior twelve months' lowest (${JSON.stringify({ date: s.date, value: s.value })})`);
  ok(s.derived === true && /^Computed by Agent402 from U\.S\. Bureau of Labor Statistics data/.test(s.source) && s.credit === `${BLS_ATTRIBUTION} ${BLS_VOUCH}` && s.terms === TERMS.bls && /^\d{4}-\d{2}-\d{2}T/.test(s.retrievedAt) && typeof s.method === "string", `sahm-rule: marked as computed here from BLS data, with the method (${s.source})`);

  // cpi-yoy
  const c = await tool("cpi-yoy").handler({});
  const yoy = Number(((Math.pow(1.003, 12) - 1) * 100).toFixed(2));
  ok(c.date === LAST && c.inflationYoYPct === yoy && c.trailing12mo.length === 11 && c.trailing12mo.at(-1).date === LAST, `cpi-yoy: the latest year-over-year rate and the trailing twelve months (${c.inflationYoYPct}, ${c.trailing12mo.length} readings)`);
  ok(JSON.stringify(c.missingDates) === JSON.stringify([MISSING]) && /11 readings/.test(c.note || ""), `cpi-yoy: the month with no value is listed (${JSON.stringify(c.missingDates)})`);
  ok(c.derived === true && /^Computed by Agent402 from U\.S\. Bureau of Labor Statistics data/.test(c.source) && c.sourceSeries === "CUSR0000SA0" && c.credit === `${BLS_ATTRIBUTION} ${BLS_VOUCH}` && c.terms === TERMS.bls, "cpi-yoy: computed here from the BLS CPI-U index, credited to BLS");

  // fed-funds
  const f = await tool("fed-funds").handler({ days: 4 });
  ok(f.date === day(monday) && f.current === 3.88 && f.days === 4 && f.history.map((r) => `${r.date}=${r.value}`).join() === [0, 1, 2, 3].map((i) => `${day(new Date(friday.getTime() + i * DAY))}=${i < 3 ? 3.9 : 3.88}`).join(), `fed-funds: calendar days, the weekend carrying Friday's rate (${JSON.stringify(f.history)})`);
  ok(f.source === "Federal Reserve Bank of New York" && f.sourceSeries === "EFFR" && f.credit.startsWith(NYFED_ATTRIBUTION) && /not affiliated with the New York Fed/.test(f.credit) && f.terms === TERMS.nyfed && /^\d{4}-\d{2}-\d{2}T/.test(f.retrievedAt) && /business day before/.test(f.note || ""), "fed-funds: credits the New York Fed with its notice, and says how a non-business day reads");
  const f1 = await tool("fed-funds").handler({ days: 1 });
  ok(f1.days === 1 && f1.history.length === 1 && f1.current === 3.88, "fed-funds: one day");

  // a publisher that cannot be read is a 503, never a FRED message
  _resetUsMacroForTest();
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response("down", { status: 500 });
  const e = await caught(tool("unemployment-rate").handler({}));
  globalThis.fetch = saved;
  ok(e?.statusCode === 503 && !/FRED/.test(e.message), `an unreadable publisher is a 503 naming it (${e?.statusCode} ${e?.message})`);

  ok(hosts.length > 0 && hosts.every((h) => ["api.bls.gov", "markets.newyorkfed.org"].includes(h)), `only the publishers were read (${[...new Set(hosts)].join(", ")})`);
} catch (err) {
  ok(false, `a stubbed run threw: ${err?.stack || err}`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
