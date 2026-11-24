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
ok(!/FRED\(R\) API|St\. Louis|stlouisfed/.test(tool.description) && /bea\.gov/.test(tool.discovery.output.example.terms), "fred-series makes no FRED API claim, and its example links the publisher's terms, not FRED's");
const PUBLISHER_HOSTS = ["api.bls.gov", "markets.newyorkfed.org", "api.fiscaldata.treasury.gov", "home.treasury.gov", "www.federalreserve.gov", "apps.bea.gov"];
ok(JSON.stringify(tool.upstreamHosts) === JSON.stringify(PUBLISHER_HOSTS), "fred-series declares the hosts it reads through its source module");
// The series current buyers ask for most are served: Treasury constant
// maturities and their spreads, the money stock, GDP.
for (const id of ["DGS1MO", "DGS3MO", "DGS6MO", "DGS1", "DGS2", "DGS3", "DGS5", "DGS7", "DGS10", "DGS20", "DGS30", "T10Y2Y", "T10Y3M", "M1SL", "M2SL", "M1NS", "M2NS", "GDP", "GDPC1"]) ok(SUPPORTED_IDS.includes(id), `${id} is served`);
ok(tool.discovery.input.seriesId === "GDPC1", "the published example is GDPC1 again, the example buyers had");
ok(!METERED_SLUGS.has("fred-series"), "fred-series is keyless, so the catalog sweeps drive it");
ok(SERIES[tool.discovery.input.seriesId], `the published example's series (${tool.discovery.input.seriesId}) is served`);
for (const id of ["UNRATE", "CPIAUCSL", "FEDFUNDS", "DFF"]) ok(SUPPORTED_IDS.includes(id), `${id}, which the description, packs and corpus name, is served`);

// --- stubbed publishers -------------------------------------------------------------
const realFetch = globalThis.fetch;
const undoDns = stubGuardResolver(offlineGuardAnswer);
const hosts = [];
const frbAsks = [];
let frbEmptyOnce = false;
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
  if (u.hostname === "home.treasury.gov" && u.searchParams.get("type") === "daily_treasury_real_yield_curve") {
    const year = Number(u.pathname.split("/").at(-2));
    return new Response(['Date,"5 YR","7 YR","10 YR","20 YR","30 YR"', `12/31/${year},1.40,1.62,1.88,2.20,2.31`, `01/02/${year},1.85,1.99,2.10,2.30,2.41`].join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
  }
  if (u.hostname === "home.treasury.gov") {
    const year = Number(u.pathname.split("/").at(-2));
    const head = year < 2000 ? 'Date,"3 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","30 Yr"' : 'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"';
    const rows = year < 2000 ? ["12/31/1999,5.33,5.78,5.98,6.24,6.30,6.36,6.45,6.45,6.48"] : [`12/31/${year},3.74,3.75,3.67,3.67,3.63,3.59,3.48,3.47,3.55,3.73,3.94,4.18,4.79,4.84`, `01/02/${year},4.40,4.41,4.39,4.36,4.33,4.25,4.17,4.25,4.29,4.38,4.47,4.57,4.86,4.79`];
    return new Response([head, ...rows].join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
  }
  if (u.hostname === "www.federalreserve.gov" && u.searchParams.get("rel") === "H10") {
    frbAsks.push(u.searchParams.get("series"));
    if (frbEmptyOnce) { frbEmptyOnce = false; return new Response("", { status: 200 }); }
    const rates = u.searchParams.get("series") === "60f32914ab61dfab590e0e470153e3ae";
    const head = rates ? '"Time Period","RXI$US_N.B.EU","RXI_N.B.JA"' : '"Time Period","JRXWTFB_N.B","JRXWTFN_N.B","JRXWTFO_N.B"';
    const rows = rates ? ["2026-11-19,1.1012,159.76", "2026-11-20,ND,158.76"] : ["2026-11-19,123.5253,116.7735,132.1409", "2026-11-20,123.5978,116.7217,132.3508"];
    return new Response(['"Series Description","a","b"', '"Unit:","x","x"', head, ...rows].join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
  }
  if (u.hostname === "www.federalreserve.gov" && u.searchParams.get("rel") === "H15") {
    return new Response(['"Series Description","Prime","3-month bill","10-year"', '"Time Period","RIFSPBLP_N.M","RIFSGFSM03_N.M","RIFLGFCY10_N.M"', "2026-09,6.87,3.94,4.99", "2026-10,7.00,4.05,5.13"].join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
  }
  if (u.hostname === "www.federalreserve.gov") {
    return new Response([
      '"Series Description","M1; Not seasonally adjusted","M2; Not seasonally adjusted","M1; Seasonally adjusted","M2; Seasonally adjusted"',
      '"Unit:","Currency","Currency","Currency","Currency"',
      '"Multiplier:","1e+09","1e+09","1e+09","1e+09"',
      '"Currency:","USD","USD","USD","USD"',
      '"Unique Identifier:","H6/H6_M1/M1_N.M","H6/H6_M2/M2_N.M","H6/H6_M1/M1.M","H6/H6_M2/M2.M"',
      '"Time Period","M1_N.M","M2_N.M","M1.M","M2.M"',
      "2026-08,19932.1,23242.5,19967.3,23300.9",
      "2026-09,20009.7,23339.6,20061.2,23413.9",
      "2026-10,,,,",
    ].join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
  }
  if (u.hostname === "apps.bea.gov" && u.pathname.endsWith("NipaDataM.txt")) {
    return new Response([
      "%SeriesCode,Period,Value",
      'DPCERG,2026M08,"131.611"', 'DPCERG,2026M09,"132.257"',
      'DPCCRG,2026M08,"130.501"', 'DPCCRG,2026M09,"130.902"',
      'DPCERC,2026M08,"22,339,658"', 'DPCERC,2026M09,"22,452,780"',
      'DPCERX,2026M09,"16,977,581"', 'A065RC,2026M09,"27,707,845"', 'A067RC,2026M09,"24,289,049"', 'A072RC,2026M08,"4.0"', 'A072RC,2026M09,"3.8"',
    ].join("\n"), { status: 200, headers: { "content-type": "text/plain" } });
  }
  if (u.hostname === "apps.bea.gov") {
    return new Response([
      "%SeriesCode,Period,Value",
      'A001RC,2025Q1,"1"',
      'A191RC,2025Q1,"30,171,979"', 'A191RC,2025Q2,"30,630,174"', 'A191RC,2025Q3,"31,180,493"',
      'A191RX,2025Q1,"23,548,210"', 'A191RX,2025Q2,"23,770,976"', 'A191RX,2025Q3,"23,999,000"',
      'A191RZ,2025Q1,"9"',
    ].join("\n"), { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("unexpected host", { status: 599 });
};

try {
  // 1-2: BLS
  _resetUsMacroForTest();
  const a = await run({ seriesId: "unrate", startDate: "2024-01-01", endDate: "2024-12-31" });
  ok(a.seriesId === "UNRATE" && a.units === "lin" && a.count === 12 && a.observations[0].date === "2024-01-01" && a.observations[11].date === "2024-12-01", `UNRATE answers fred-series' shape, one row a month (${a.count})`);
  ok(a.source === "U.S. Bureau of Labor Statistics" && a.sourceSeries === "LNS14000000" && a.credit === BLS_VOUCH && /^\d{4}-\d{2}-\d{2}T/.test(a.retrievedAt) && /termsOfService/.test(a.terms) && !a.derived, "UNRATE credits BLS, its series, the retrieval date and the statement the BLS terms require");
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
  ok(f.source === "Federal Reserve Bank of New York" && f.sourceSeries === "EFFR" && f.note && /not affiliated with the New York Fed/.test(f.credit) && /subject to the Terms of Use posted at newyorkfed.org/.test(f.credit) && /© \d{4} Federal Reserve Bank of New York/.test(f.credit) && /newyorkfed\.org\/privacy\/termsofuse/.test(f.terms), "DFF credits the New York Fed with its notice and disclaimer, and notes business days only");
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

  // Treasury constant maturities, read from the daily par yield curve
  const t10 = await run({ seriesId: "DGS10", startDate: "2025-01-01", endDate: "2025-12-31" });
  ok(t10.count === 2 && t10.observations[0].date === "2025-01-02" && t10.observations[0].value === 4.57 && t10.observations[1].value === 4.18 && /Treasury/.test(t10.source) && /par yield curve/i.test(t10.sourceSeries) && /Treasury/.test(t10.credit) && !t10.derived, `DGS10 is the 10-year column of the Treasury's daily par yield curve, oldest first (${JSON.stringify(t10.observations)})`);
  const m1 = await run({ seriesId: "DGS1MO", startDate: "2025-01-01", endDate: "2025-12-31" });
  ok(m1.observations[0].value === 4.40, "a column is read by its header, not its place");
  const old = await run({ seriesId: "DGS30", startDate: "1999-01-01", endDate: "1999-12-31" });
  ok(old.count === 1 && old.observations[0].value === 6.48, "a year whose file has fewer columns is read by header");
  const sp = await run({ seriesId: "T10Y2Y", startDate: "2025-01-01", endDate: "2025-12-31" });
  ok(sp.derived === true && /Computed by Agent402 from/.test(sp.source) && Math.abs(sp.observations[0].value - (4.57 - 4.25)) < 1e-9, `T10Y2Y is the 10-year less the 2-year, marked derived (${JSON.stringify(sp.observations[0])})`);
  {
    const { useHeldTreasuryYields } = await import("../src/tools/us-macro-series.js");
    _resetUsMacroForTest();
    const y = new Date().getUTCFullYear();
    useHeldTreasuryYields((yr) => (yr === y ? { at: Date.now(), rows: [{ recordDate: `${y}-01-05`, yr10: 4.92, yr2: 4.63 }] } : null));
    const before = hosts.filter((h) => h === "home.treasury.gov").length;
    const held = await run({ seriesId: "DGS10", startDate: `${y}-01-01` });
    ok(held.observations.length === 1 && held.observations[0].value === 4.92 && hosts.filter((h) => h === "home.treasury.gov").length === before, "a year the yield-curve tools hold is served from there, with no second read");
    useHeldTreasuryYields(null);
  }
  const wideT = await caught(run({ seriesId: "DGS10", startDate: "1990-01-01", endDate: "2026-01-01" }));
  ok(wideT?.statusCode === 400 && /calendar years/.test(wideT.message), "a Treasury window wider than its year bound is refused before any read");
  // Money stock (Federal Reserve Board H.6)
  const m2 = await run({ seriesId: "M2SL", startDate: "2026-01-01" });
  ok(m2.count === 2 && m2.observations[1].date === "2026-09-01" && m2.observations[1].value === 23413.9 && /Board of Governors of the Federal Reserve System/.test(m2.source) && /H\.6/.test(m2.sourceSeries) && /not affiliated with the Federal Reserve/.test(m2.credit) && /federalreserve\.gov\/disclaimer/.test(m2.terms), `M2SL is H.6 M2, seasonally adjusted, billions, credited to the Board (${JSON.stringify(m2.observations)})`);
  const m1n = await run({ seriesId: "M1NS", startDate: "2026-01-01" });
  ok(m1n.observations[0].value === 19932.1, "M1NS is the not seasonally adjusted column");
  // GDP (BEA NIPA)
  const gdp = await run({ seriesId: "GDPC1", startDate: "2025-01-01" });
  ok(gdp.count === 3 && gdp.observations[0].date === "2025-01-01" && gdp.observations[2].date === "2025-07-01" && gdp.observations[0].value === 23548.21 && /Bureau of Economic Analysis/.test(gdp.source) && /A191RX/.test(gdp.sourceSeries) && /not endorsed or certified by BEA/.test(gdp.credit) && /bea\.gov/.test(gdp.terms), `GDPC1 is BEA's real GDP in billions of chained dollars, quarterly (${JSON.stringify(gdp.observations[0])})`);
  const ng = await run({ seriesId: "GDP", startDate: "2025-01-01", units: "pc1" });
  ok(ng.derived === true, "a transformed GDP answer is marked derived");
  const gd = await run({ seriesId: "GDP", startDate: "2025-01-01" });
  ok(gd.observations[2].value === 31180.493, `GDP is current dollars, billions (${gd.observations[2].value})`);

  // BEA monthly: personal income and outlays
  const pce = await run({ seriesId: "PCEPI", startDate: "2026-01-01" });
  ok(pce.count === 2 && pce.observations[1].value === 132.257 && /Bureau of Economic Analysis/.test(pce.source) && /DPCERG/.test(pce.sourceSeries) && /not endorsed or certified by BEA/.test(pce.credit) && /bea\.gov/.test(pce.terms), `PCEPI is BEA's PCE price index, as published (${JSON.stringify(pce.observations)})`);
  const pceL = await run({ seriesId: "PCE", startDate: "2026-01-01" });
  ok(pceL.observations[1].value === 22452.78, `PCE is billions, from the file's millions (${pceL.observations[1].value})`);
  const sav = await run({ seriesId: "PSAVERT", startDate: "2026-01-01" });
  ok(sav.observations[1].value === 3.8 && (await run({ seriesId: "DSPI", startDate: "2026-01-01" })).observations[0].value === 24289.049, "a rate is read as published, a level in billions");
  // FRB H.10 and H.15
  _resetUsMacroForTest(); frbAsks.length = 0; frbEmptyOnce = true;
  const eu = await run({ seriesId: "DEXUSEU", startDate: "2026-11-01" });
  ok(eu.count === 1 && eu.observations[0].value === 1.1012 && /Board of Governors/.test(eu.source) && /H\.10/.test(eu.sourceSeries) && /not affiliated with the Federal Reserve/.test(eu.credit) && /federalreserve\.gov\/disclaimer/.test(eu.terms), `DEXUSEU is the H.10 noon buying rate, a no-data day skipped (${JSON.stringify(eu.observations)})`);
  ok(frbAsks.length === 2, `an empty answer from the download program is read once more (${frbAsks.length} reads)`);
  const jp = await run({ seriesId: "DEXJPUS" });
  ok(jp.count === 2 && jp.window && frbAsks.length === 2, "a second series of the same file is served from the cache, the last two years by default");
  const broad = await run({ seriesId: "DTWEXBGS", startDate: "2026-11-01" });
  ok(broad.observations[1].value === 123.5978, "DTWEXBGS is the nominal broad dollar index");
  const early = await caught(run({ seriesId: "DEXUSEU", startDate: "1999-01-01" }));
  ok(early?.statusCode === 400 && /served from/.test(early.message), "an H.10 window before the years held is refused, naming the first date served");
  const prime = await run({ seriesId: "MPRIME", startDate: "2026-01-01" });
  const gs10 = await run({ seriesId: "GS10", startDate: "2026-01-01" });
  ok(prime.observations[1].value === 7 && gs10.observations[0].value === 4.99 && /H\.15/.test(gs10.sourceSeries) && /H\.15 Selected Interest Rates/.test(gs10.credit), "MPRIME and GS10 are H.15's monthly columns, credited to the Board");
  // Treasury real yields and breakeven inflation
  const dfii = await run({ seriesId: "DFII10", startDate: "2025-01-01", endDate: "2025-12-31" });
  ok(dfii.count === 2 && dfii.observations[0].value === 2.10 && /Real Yield Curve/.test(dfii.sourceSeries) && !dfii.derived, `DFII10 is the 10-year real par yield (${JSON.stringify(dfii.observations)})`);
  const be = await run({ seriesId: "T10YIE", startDate: "2025-01-01", endDate: "2025-12-31" });
  ok(be.derived === true && /Computed by Agent402/.test(be.source) && Math.abs(be.observations[0].value - (4.57 - 2.10)) < 1e-9 && /Real Yield Curve/.test(be.credit), `T10YIE is the nominal less the real 10-year yield, marked derived (${JSON.stringify(be.observations[0])})`);
  // Never served: licensed or restricted series, and sources needing a key.
  for (const id of ["SP500", "MORTGAGE30US", "MORTGAGE15US", "DCOILWTICO", "DCOILBRENTEU", "HOUST", "RSAFS"]) ok(!SUPPORTED_IDS.includes(id), `${id} is not served (its terms or its access)`);
  ok(SUPPORTED_IDS.length >= 90, `the supported list is wide (${SUPPORTED_IDS.length} IDs)`);

  // 3: not served
  const e = await caught(run({ seriesId: "NOTSERVED1" }));
  ok(e?.statusCode === 404 && SUPPORTED_IDS.every((id) => e.message.includes(id)) && Array.isArray(e.supportedSeriesIds), "an ID that is not served is a 404 naming every supported ID");
  const bad = await caught(run({ seriesId: "UNRATE", frequency: "bwew" }));
  ok(bad?.statusCode === 400 && /must be one of: d, w, m, q, sa, a, wef/.test(bad.message), "a FRED frequency code these sources do not offer is a 400 naming the ones they do");

  // 1: nothing reached FRED
  ok(hosts.length > 0 && hosts.every((h) => PUBLISHER_HOSTS.includes(h)), `only the publishers were read (${[...new Set(hosts)].join(", ")})`);
  // The BLS daily budget is sized for the keyed limit when the key is set.
  process.env.BLS_API_KEY = "test-key";
  ok(blsDailyBudget() > 25 && blsDailyBudget() < 500, `with BLS_API_KEY the budget sits under the keyed limit of 500 (${blsDailyBudget()})`);
  process.env.BLS_DAILY_MAX = "12";
  ok(blsDailyBudget() === 12, "BLS_DAILY_MAX lowers the day's budget (the CI sweep's per-run cap)");
  process.env.BLS_DAILY_MAX = "9999";
  ok(blsDailyBudget() < 500, "BLS_DAILY_MAX never raises it past the keyed limit");
  process.env.BLS_DAILY_MAX = "junk";
  ok(blsDailyBudget() > 25, "an unusable BLS_DAILY_MAX leaves the budget as it is");
  delete process.env.BLS_DAILY_MAX;
  delete process.env.BLS_API_KEY;
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
