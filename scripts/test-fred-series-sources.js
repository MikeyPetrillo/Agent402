// fred-series reads each supported FRED series ID from the agency that
// publishes it (src/tools/us-macro-series.js) and never from FRED. Offline:
// fetch is stubbed per host.
//   1. no request goes to a FRED host, for any supported ID or any other;
//   2. each ID reaches its publisher's API and answers fred-series' shape,
//      with the credit that publisher's terms ask for;
//   3. an ID that is not served is a 404 naming every supported ID;
//   4. units and frequency are computed here and the answer says so
//      (derived, "Computed by Agent402 from ..."), never credited to the
//      publisher as its own figure;
//   5. BLS reads are cached by decade and held under a daily budget below
//      the API's own limit; a window wider than three decades is refused;
//   6. FEDFUNDS is the calendar-day average of the daily rate, whole months.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { stubGuardResolver, offlineGuardAnswer } from "./lib/guard-resolver-stub.js";
import { MACRO_TOOLS } from "../src/tools/macro-kit.js";
import { SUPPORTED_IDS, SERIES, BLS_VOUCH, monthlyCalendarAverage, transform, aggregate, blsDailyBudget, _resetUsMacroForTest } from "../src/tools/us-macro-series.js";
import { ATTRIBUTIONS, US_AGENCIES_ATTRIBUTION } from "../src/data-attribution.js";
import { METERED_SLUGS } from "../src/metered-slugs.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const tool = MACRO_TOOLS.find((t) => t.slug === "fred-series");
const run = (input) => tool.handler(input);
const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };

// --- the tool definition --------------------------------------------------------
ok(tool.attribution === "us-agencies" && ATTRIBUTIONS["us-agencies"] === US_AGENCIES_ATTRIBUTION && tool.description.endsWith(US_AGENCIES_ATTRIBUTION), "fred-series credits the agencies and its description ends with that sentence");
ok(!/FRED\(R\) API|St\. Louis|stlouisfed/.test(tool.description) && !("terms" in tool.discovery.output.example), "fred-series makes no FRED API claim and carries no FRED terms line");
ok(JSON.stringify(tool.upstreamHosts) === JSON.stringify(["api.bls.gov", "markets.newyorkfed.org", "api.fiscaldata.treasury.gov"]), "fred-series declares the hosts it reads through its source module");
ok(!METERED_SLUGS.has("fred-series"), "fred-series is keyless, so the catalog sweeps drive it");
ok(SERIES[tool.discovery.input.seriesId], `the published example's series (${tool.discovery.input.seriesId}) is served`);
for (const id of ["UNRATE", "CPIAUCSL", "FEDFUNDS", "DFF"]) ok(SUPPORTED_IDS.includes(id), `${id}, which the description, packs and corpus name, is served`);

// --- stubbed publishers -------------------------------------------------------------
const realFetch = globalThis.fetch;
const undoDns = stubGuardResolver(offlineGuardAnswer);
const hosts = [];
const blsBodies = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const blsData = (startyear, endyear) => {
  const data = [];
  for (let y = Number(startyear); y <= Math.min(Number(endyear), 2026); y++) for (let m = 1; m <= 12; m++) {
    if (y === 2026 && m > 10) continue;
    data.push({ year: String(y), period: `M${String(m).padStart(2, "0")}`, value: String(100 + (y - 2000) * 12 + m) });
  }
  data.push({ year: "2025", period: "M13", value: "999" }); // an annual average row is not a month
  return data.reverse();
};
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  hosts.push(u.hostname);
  if (u.hostname === "api.bls.gov") {
    const b = JSON.parse(opts.body);
    blsBodies.push(b);
    return json({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: b.seriesid[0], data: blsData(b.startyear, b.endyear) }] } });
  }
  if (u.hostname === "markets.newyorkfed.org") {
    const rows = [];
    for (let d = new Date("2025-12-01T00:00:00Z"); d <= new Date("2026-02-10T00:00:00Z"); d = new Date(d.getTime() + 86_400_000)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      rows.push({ effectiveDate: d.toISOString().slice(0, 10), type: "EFFR", percentRate: d < new Date("2026-01-15T00:00:00Z") ? 4.0 : 3.5 });
    }
    return json({ refRates: rows.reverse() });
  }
  if (u.hostname === "api.fiscaldata.treasury.gov") {
    return json({ data: [
      { record_date: "2025-09-30", total_mil_amt: "37637552.5270142" },
      { record_date: "2025-10-31", total_mil_amt: "38040093.8056379" },
      { record_date: "2025-12-31", total_mil_amt: "38514008.7862368" },
    ] });
  }
  return new Response("unexpected host", { status: 599 });
};

try {
  // 1-2: BLS
  _resetUsMacroForTest();
  const a = await run({ seriesId: "unrate", startDate: "2024-01-01", endDate: "2024-12-31" });
  ok(a.seriesId === "UNRATE" && a.units === "lin" && a.count === 12 && a.observations[0].date === "2024-01-01" && a.observations[11].date === "2024-12-01", `UNRATE answers fred-series' shape, one row a month (${a.count})`);
  ok(a.source === "U.S. Bureau of Labor Statistics" && a.sourceSeries === "LNS14000000" && a.credit === BLS_VOUCH && /^\d{4}-\d{2}-\d{2}T/.test(a.retrievedAt) && !a.derived, "UNRATE credits BLS, its series, the retrieval date and the statement the BLS terms require");
  ok(blsBodies.length === 1 && blsBodies[0].seriesid[0] === "LNS14000000" && blsBodies[0].startyear === "2020" && blsBodies[0].endyear === "2029" && !("registrationkey" in blsBodies[0]), "BLS is read one calendar decade per query, keyless without BLS_API_KEY");
  await run({ seriesId: "UNRATE", startDate: "2021-01-01", endDate: "2022-12-31" });
  ok(blsBodies.length === 1, "a second window in the same decade is served from the cache");
  // 4: units and frequency are derived
  const p = await run({ seriesId: "CPIAUCSL", startDate: "2025-01-01", endDate: "2025-03-31", units: "pc1" });
  ok(p.derived === true && p.source === "Computed by Agent402 from U.S. Bureau of Labor Statistics data" && p.count === 3, `a transformed answer is marked derived and credited as computed here (${p.source})`);
  ok(Math.abs(p.observations[0].value - ((100 + 25 * 12 + 1) / (100 + 24 * 12 + 1) - 1) * 100) < 1e-6, "pc1 is the change from the same month a year earlier");
  const q = await run({ seriesId: "UNRATE", startDate: "2024-01-01", endDate: "2024-12-31", frequency: "q" });
  ok(q.derived === true && q.count === 4 && q.observations[0].date === "2024-01-01" && q.observations[0].value === 390, `quarterly averaging (${JSON.stringify(q.observations[0])})`);
  ok(!q.observations.some((o) => o.value === 999), "annual-average rows are not read as months");
  // 5: default window, wide window and budget
  const d = await run({ seriesId: "PAYEMS" });
  ok(d.window && d.observations[0].date === "2017-01-01", `with no startDate a BLS series answers its last 10 years and says so (${d.observations[0].date})`);
  const wide = await caught(run({ seriesId: "UNRATE", startDate: "1980-01-01", endDate: "2026-01-01" }));
  ok(wide?.statusCode === 400 && /three calendar decades/.test(wide.message), "a window wider than three decades is refused before any read");
  _resetUsMacroForTest(); blsBodies.length = 0;
  const blsIds = SUPPORTED_IDS.filter((id) => SERIES[id].source === "bls");
  const asks = blsIds.flatMap((id) => [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020].map((y) => ({ seriesId: id, startDate: `${y}-01-01`, endDate: `${y}-12-31` })));
  for (const ask of asks.slice(0, blsDailyBudget())) await run(ask);
  const spent = await caught(run(asks[blsDailyBudget()]));
  ok(blsBodies.length === blsDailyBudget() && spent?.statusCode === 503 && /allowance/.test(spent.message) && blsDailyBudget() < 25, `BLS reads stop at the daily budget, under the keyless limit of 25 (${blsBodies.length}, ${spent?.statusCode})`);

  // NY Fed
  _resetUsMacroForTest();
  const f = await run({ seriesId: "DFF", startDate: "2026-01-01", endDate: "2026-01-31" });
  ok(f.source === "Federal Reserve Bank of New York" && f.sourceSeries === "EFFR" && f.note && /not affiliated with the New York Fed/.test(f.credit) && /subject to the Terms of Use posted at newyorkfed.org/.test(f.credit) && /© \d{4} Federal Reserve Bank of New York/.test(f.credit), "DFF credits the New York Fed with its notice and disclaimer, and notes business days only");
  ok(f.observations.every((o) => ![0, 6].includes(new Date(`${o.date}T00:00:00Z`).getUTCDay())), "DFF carries the published business days only");
  const ff = await run({ seriesId: "FEDFUNDS" });
  ok(ff.derived === true && ff.count === 2 && ff.observations[0].date === "2026-01-01" && ff.observations[1].date === "2026-02-01", `FEDFUNDS carries whole months through the latest rate's month, none after it (${JSON.stringify(ff.observations)})`);
  // January: the 1st through the 14th at 4.0 (the 1st is a holiday-free weekday here), the 15th on at 3.5
  ok(Math.abs(ff.observations[0].value - Math.round(((14 * 4.0 + 17 * 3.5) / 31) * 100) / 100) < 1e-9, `FEDFUNDS is the calendar-day average (${ff.observations[0].value})`);
  const sofr = await run({ seriesId: "SOFR", startDate: "2026-02-01" });
  ok(/DTCC Solutions LLC/.test(sofr.credit), "SOFR carries the data-license credit the New York Fed's terms require");

  // Treasury
  const g = await run({ seriesId: "GFDEBTN" });
  ok(g.count === 2 && g.observations[0].date === "2025-07-01" && g.observations[1].date === "2025-10-01" && /Fiscal Data/.test(g.source), `GFDEBTN is the quarter-end total, dated by quarter (${JSON.stringify(g.observations.map((o) => o.date))})`);

  // 3: not served
  const e = await caught(run({ seriesId: "GDPC1" }));
  ok(e?.statusCode === 404 && SUPPORTED_IDS.every((id) => e.message.includes(id)) && Array.isArray(e.supportedSeriesIds), "an ID that is not served is a 404 naming every supported ID");
  const bad = await caught(run({ seriesId: "UNRATE", frequency: "bwew" }));
  ok(bad?.statusCode === 400 && /must be one of: d, w, m, q, sa, a, wef/.test(bad.message), "a FRED frequency code these sources do not offer is a 400 naming the ones they do");

  // 1: nothing reached FRED
  ok(hosts.length > 0 && hosts.every((h) => ["api.bls.gov", "markets.newyorkfed.org", "api.fiscaldata.treasury.gov"].includes(h)), `only the publishers were read (${[...new Set(hosts)].join(", ")})`);
} finally {
  globalThis.fetch = realFetch;
  undoDns();
}

// --- pure helpers ---------------------------------------------------------------------
{
  const rows = [{ date: "2024-01-01", value: 100 }, { date: "2024-02-01", value: 110 }];
  ok(JSON.stringify(transform(rows, "chg", "m")) === JSON.stringify([{ date: "2024-02-01", value: 10 }]) && transform(rows, "pch", "m")[0].value === 10, "chg and pch");
  ok(Math.abs(transform(rows, "pca", "m")[0].value - (Math.pow(1.1, 12) - 1) * 100) < 1e-4, "pca compounds over the year");
  ok(aggregate([{ date: "2024-01-01", value: 1 }, { date: "2024-02-01", value: 2 }], "m", "q").length === 0, "an incomplete quarter is not averaged");
  const avg = monthlyCalendarAverage([{ date: "2025-12-31", value: 2 }, { date: "2026-02-03", value: 3 }], "2026-03-05");
  ok(avg.map((r) => `${r.date}=${r.value}`).join() === `2026-01-01=2,2026-02-01=${Math.round(((2 * 2 + 26 * 3) / 28) * 100) / 100}`, `a month with no new rate carries the latest one (${JSON.stringify(avg)})`);
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
