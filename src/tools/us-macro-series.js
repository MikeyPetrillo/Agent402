// fred-series' sources: common FRED series IDs, each read from the agency
// that publishes it, so the route serves no FRED data.
//
//   - U.S. Bureau of Labor Statistics, Public Data API (api.bls.gov): the
//     labor and price series. BLS publishes into the public domain
//     (https://www.bls.gov/opub/copyright-information.htm). Its API terms
//     (https://www.bls.gov/developers/termsOfService.htm) ask users to cite
//     the date the data were retrieved, to state that "BLS.gov cannot vouch
//     for the data or analyses derived from these data after the data have
//     been retrieved from BLS.gov", and not to modify content and still cite
//     it as BLS.gov: every answer carries `retrievedAt` and that sentence, and
//     a transformed or aggregated answer is marked `derived` and credited as
//     computed by this service from BLS data. Keyless (v1) the API allows 25
//     queries a day; with BLS_API_KEY (v2) 500. Reads are cached by decade
//     and held under a daily budget below the API's own limit.
//   - Federal Reserve Bank of New York, Markets Data API
//     (markets.newyorkfed.org): EFFR, SOFR and OBFR. Its Terms of Use
//     (https://www.newyorkfed.org/privacy/termsofuse) license use, copying and
//     distribution "for your personal or business purposes" and ask a
//     publisher of reference rate data to carry a notice, and a product that
//     names a rate to carry a disclaimer; both ride every answer (NYFED_NOTICE).
//   - U.S. Treasury, Fiscal Data API (api.fiscaldata.treasury.gov): total
//     public debt outstanding. "The data on this site is available to copy,
//     adapt, redistribute, or otherwise use for non-commercial and commercial
//     purposes" (https://fiscaldata.treasury.gov/about-us/).
//   - U.S. Treasury, Daily Treasury Par Yield Curve Rates (home.treasury.gov,
//     one CSV a year): the constant-maturity yields (DGS1MO ... DGS30; the
//     H.15 constant maturities are these par yields) and the 10-year spreads
//     T10Y2Y and T10Y3M, computed here. A work of the U.S. Government (public
//     domain). The host builds each file slowly (15-20 s), so a call waits at
//     most PUBLISHER_WAIT_MS for a file not held; the read runs on and fills
//     the cache (an earlier year is kept 30 days).
//   - Board of Governors of the Federal Reserve System, H.6 Money Stock
//     Measures (www.federalreserve.gov Data Download Program, the monthly
//     package): M1SL, M2SL, M1NS, M2NS. "Unless otherwise indicated,
//     information on Board's website is in the public domain and may be
//     copied and distributed without permission. Please cite to the Board as
//     the source of the information" (https://www.federalreserve.gov/disclaimer.htm);
//     nothing here implies membership in or endorsement by the Federal
//     Reserve. The Board retires the preformatted packages on 2027-03-31 (the
//     program on 2027-07-01); H6_PACKAGE_URL moves to the release's XML before then.
//   - U.S. Bureau of Economic Analysis, National Income and Product Accounts
//     (apps.bea.gov flat file of quarterly NIPA series, keyless): GDP
//     (A191RC) and GDPC1 (A191RX), millions in the file, billions here as
//     FRED gives them. A work of the U.S. Government; BEA asks that nothing
//     suggest its endorsement (https://www.bea.gov/help/guidelines-for-citing-bea),
//     so every answer says it is not endorsed or certified by BEA. The same
//     agency's monthly flat file (NipaDataM.txt) gives personal income and
//     outlays: PCE and its price indexes, personal and disposable income, the
//     saving rate.
//   - Board of Governors of the Federal Reserve System, H.10 Foreign Exchange
//     Rates (daily noon buying rates and the nominal dollar indexes) and H.15
//     Selected Interest Rates (the monthly package: prime rate, Treasury bill
//     and constant-maturity rates), from the same Data Download Program and
//     under the same Board policy as H.6 (public domain, cite the Board).
//   - U.S. Treasury Daily Treasury Par Real Yield Curve Rates (the TIPS real
//     yields, DFII5 ... DFII30, from 2003), and the breakeven inflation rates
//     T5YIE and T10YIE computed here as the nominal less the real yield, the
//     way FRED computes them. Same host and status as the nominal curve.
// Not served, by their own terms or access: S&P 500 and other licensed index
// series; Freddie Mac's PMMS (MORTGAGE30US, MORTGAGE15US: its terms limit data
// to internal business or personal use, https://www.freddiemac.com/terms); the
// WTI and Brent spot prices EIA republishes from a licensed vendor
// (DCOILWTICO, DCOILBRENTEU); and the Census Bureau's API and EIA's API, which
// need a key this server does not hold.
import { safeFetch, retryTransient } from "./fetch-guard.js";
import { CAP_NAMES } from "../upstream-cap-refusals.js";
import { notChargedHere } from "../not-charged.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export const BLS_VOUCH = "BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.";
export const NYFED_NOTICE = (name) =>
  `The ${name} is subject to the Terms of Use posted at newyorkfed.org. The New York Fed is not responsible for publication of the ${name} by Agent402, does not sanction or endorse any particular republication, and has no liability for your use. Agent402 is not affiliated with the New York Fed. The New York Fed does not sanction, endorse, or recommend any products or services offered by Agent402.`;
export const SOFR_DTCC_NOTICE = "The Secured Overnight Financing Rate (SOFR) Data are calculated using data provided under a license granted to the New York Fed by DTCC Solutions LLC (\"Solutions\"), an affiliate of The Depository Trust & Clearing Corporation. Solutions, its affiliates, and third parties from which they obtained data have no liability for the content of this material.";
// Each answer links the terms its publisher's data is served under (the New
// York Fed's ask that its content be passed on with the same permissions,
// conditions and restrictions is met by naming them).
export const TERMS = Object.freeze({
  bls: "BLS Public Data API terms of service: https://www.bls.gov/developers/termsOfService.htm",
  nyfed: "New York Fed Terms of Use, which apply to this data as passed on here: https://www.newyorkfed.org/privacy/termsofuse",
  treasury: "U.S. Treasury Fiscal Data: https://fiscaldata.treasury.gov/about-us/",
  yields: "U.S. Treasury interest rate data: https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
  frb: "Federal Reserve Board website policies: https://www.federalreserve.gov/disclaimer.htm",
  bea: "BEA citation guidelines: https://www.bea.gov/help/guidelines-for-citing-bea",
});
// A source whose terms are another source's.
const TERMS_OF = Object.freeze({ beaM: "bea", h10: "frb", h15: "frb" });
export const TREASURY_YIELDS_CREDIT = "Source: U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates (home.treasury.gov).";
export const FRB_H6_CREDIT = "Source: Board of Governors of the Federal Reserve System (US), H.6 Money Stock Measures (federalreserve.gov). Agent402 is not affiliated with the Federal Reserve.";
export const BEA_CREDIT = "Source: U.S. Bureau of Economic Analysis, National Income and Product Accounts (bea.gov). This product uses BEA data but is not endorsed or certified by BEA.";
export const FRB_H10_CREDIT = "Source: Board of Governors of the Federal Reserve System (US), H.10 Foreign Exchange Rates (federalreserve.gov). Agent402 is not affiliated with the Federal Reserve.";
export const FRB_H15_CREDIT = "Source: Board of Governors of the Federal Reserve System (US), H.15 Selected Interest Rates (federalreserve.gov). Agent402 is not affiliated with the Federal Reserve.";
export const TREASURY_REAL_YIELDS_CREDIT = "Source: U.S. Department of the Treasury, Daily Treasury Par Real Yield Curve Rates (home.treasury.gov).";
export const TREASURY_FISCAL_CREDIT = "Source: U.S. Department of the Treasury, Fiscal Data (fiscaldata.treasury.gov).";

const BLS = (id, title) => ({ source: "bls", id, freq: "m", title });
const NYF = (path, name, title, extra = {}) => ({ source: "nyfed", path, name, freq: "d", title, ...extra });
const CMT = (col, title) => ({ source: "yields", col, freq: "d", title: `Market Yield on U.S. Treasury Securities at ${title} Constant Maturity (percent, business days)` });
const SPREAD = (long, short, title) => ({ source: "yields", spread: [long, short], freq: "d", title });
const H6 = (col, title) => ({ source: "frb", col, freq: "m", title });
const NIPA = (code, title) => ({ source: "bea", code, freq: "q", title });
// BEA's monthly flat file: `divisor` 1000 turns its millions into FRED's billions.
const NIPAM = (code, title, divisor = 1) => ({ source: "beaM", code, freq: "m", title, divisor });
const H10 = (pkg, col, title) => ({ source: "h10", pkg, col, freq: "d", title });
const H15M = (col, title) => ({ source: "h15", col, freq: "m", title });
const REAL = (col, title) => ({ source: "yields", real: true, col, freq: "d", title: `Market Yield on U.S. Treasury Securities at ${title} Constant Maturity, Quoted on an Investment Basis, Inflation-Indexed (percent, business days)` });
const BREAKEVEN = ([nominal, real], title) => ({ source: "yields", breakeven: [nominal, real], freq: "d", title });
/** FRED series ID -> the publisher's own series. */
export const SERIES = Object.freeze({
  UNRATE: BLS("LNS14000000", "Unemployment Rate (percent, seasonally adjusted)"),
  UNRATENSA: BLS("LNU04000000", "Unemployment Rate (percent, not seasonally adjusted)"),
  U6RATE: BLS("LNS13327709", "Total unemployed, plus marginally attached and part time for economic reasons (U-6, percent, seasonally adjusted)"),
  CIVPART: BLS("LNS11300000", "Labor Force Participation Rate (percent, seasonally adjusted)"),
  EMRATIO: BLS("LNS12300000", "Employment-Population Ratio (percent, seasonally adjusted)"),
  PAYEMS: BLS("CES0000000001", "All Employees, Total Nonfarm (thousands, seasonally adjusted)"),
  CES0500000003: BLS("CES0500000003", "Average Hourly Earnings of All Employees, Total Private (dollars, seasonally adjusted)"),
  JTSJOL: BLS("JTS000000000000000JOL", "Job Openings: Total Nonfarm (thousands, seasonally adjusted)"),
  CPIAUCSL: BLS("CUSR0000SA0", "Consumer Price Index for All Urban Consumers: All Items (index 1982-1984=100, seasonally adjusted)"),
  CPIAUCNS: BLS("CUUR0000SA0", "Consumer Price Index for All Urban Consumers: All Items (index 1982-1984=100, not seasonally adjusted)"),
  CPILFESL: BLS("CUSR0000SA0L1E", "CPI-U: All Items Less Food and Energy (index 1982-1984=100, seasonally adjusted)"),
  PPIACO: BLS("WPU00000000", "Producer Price Index: All Commodities (index 1982=100, not seasonally adjusted)"),
  EFFR: NYF("unsecured/effr", "Effective Federal Funds Rate (EFFR)", "Effective Federal Funds Rate (percent, business days)"),
  DFF: NYF("unsecured/effr", "Effective Federal Funds Rate (EFFR)", "Effective Federal Funds Rate (percent, business days)", { note: "Read from the New York Fed's EFFR, published on business days only; weekends and holidays carry no observation." }),
  FEDFUNDS: NYF("unsecured/effr", "Effective Federal Funds Rate (EFFR)", "Federal Funds Effective Rate, monthly average (percent)", { freq: "m", monthlyAverage: true }),
  SOFR: NYF("secured/sofr", "Secured Overnight Financing Rate (SOFR)", "Secured Overnight Financing Rate (percent, business days)", { dtcc: true }),
  OBFR: NYF("unsecured/obfr", "Overnight Bank Funding Rate (OBFR)", "Overnight Bank Funding Rate (percent, business days)"),
  GFDEBTN: { source: "treasury", freq: "q", title: "Federal Debt: Total Public Debt (millions of dollars, end of quarter)" },
  DGS1MO: CMT("1 Mo", "1-Month"),
  DGS3MO: CMT("3 Mo", "3-Month"),
  DGS6MO: CMT("6 Mo", "6-Month"),
  DGS1: CMT("1 Yr", "1-Year"),
  DGS2: CMT("2 Yr", "2-Year"),
  DGS3: CMT("3 Yr", "3-Year"),
  DGS5: CMT("5 Yr", "5-Year"),
  DGS7: CMT("7 Yr", "7-Year"),
  DGS10: CMT("10 Yr", "10-Year"),
  DGS20: CMT("20 Yr", "20-Year"),
  DGS30: CMT("30 Yr", "30-Year"),
  T10Y2Y: SPREAD("10 Yr", "2 Yr", "10-Year Treasury Constant Maturity Minus 2-Year Treasury Constant Maturity (percentage points, business days)"),
  T10Y3M: SPREAD("10 Yr", "3 Mo", "10-Year Treasury Constant Maturity Minus 3-Month Treasury Constant Maturity (percentage points, business days)"),
  M1SL: H6("M1.M", "M1 (billions of dollars, seasonally adjusted)"),
  M2SL: H6("M2.M", "M2 (billions of dollars, seasonally adjusted)"),
  M1NS: H6("M1_N.M", "M1 (billions of dollars, not seasonally adjusted)"),
  M2NS: H6("M2_N.M", "M2 (billions of dollars, not seasonally adjusted)"),
  GDP: NIPA("A191RC", "Gross Domestic Product (billions of dollars, seasonally adjusted annual rate)"),
  GDPC1: NIPA("A191RX", "Real Gross Domestic Product (billions of chained dollars, seasonally adjusted annual rate)"),
  // BLS: more of the labor and price series FRED mirrors.
  UNEMPLOY: BLS("LNS13000000", "Unemployment Level (thousands of persons, seasonally adjusted)"),
  CLF16OV: BLS("LNS11000000", "Civilian Labor Force Level (thousands of persons, seasonally adjusted)"),
  CE16OV: BLS("LNS12000000", "Employment Level (thousands of persons, seasonally adjusted)"),
  USPRIV: BLS("CES0500000001", "All Employees, Total Private (thousands, seasonally adjusted)"),
  MANEMP: BLS("CES3000000001", "All Employees, Manufacturing (thousands, seasonally adjusted)"),
  AHETPI: BLS("CES0500000008", "Average Hourly Earnings of Production and Nonsupervisory Employees, Total Private (dollars, seasonally adjusted)"),
  AWHAETP: BLS("CES0500000002", "Average Weekly Hours of All Employees, Total Private (hours, seasonally adjusted)"),
  AWHNONAG: BLS("CES0500000007", "Average Weekly Hours of Production and Nonsupervisory Employees, Total Private (hours, seasonally adjusted)"),
  JTSJOR: BLS("JTS000000000000000JOR", "Job Openings: Total Nonfarm (rate, percent, seasonally adjusted)"),
  JTSHIR: BLS("JTS000000000000000HIR", "Hires: Total Nonfarm (rate, percent, seasonally adjusted)"),
  JTSQUR: BLS("JTS000000000000000QUR", "Quits: Total Nonfarm (rate, percent, seasonally adjusted)"),
  CPIUFDSL: BLS("CUSR0000SAF1", "CPI-U: Food (index 1982-1984=100, seasonally adjusted)"),
  CPIENGSL: BLS("CUSR0000SA0E", "CPI-U: Energy (index 1982-1984=100, seasonally adjusted)"),
  CUSR0000SAH1: BLS("CUSR0000SAH1", "CPI-U: Shelter (index 1982-1984=100, seasonally adjusted)"),
  PPIFIS: BLS("WPSFD4", "Producer Price Index by Commodity: Final Demand (index Nov 2009=100, seasonally adjusted)"),
  // BEA: personal income and outlays, monthly.
  PCEPI: NIPAM("DPCERG", "Personal Consumption Expenditures: Chain-type Price Index (index 2017=100, seasonally adjusted)"),
  PCEPILFE: NIPAM("DPCCRG", "Personal Consumption Expenditures Excluding Food and Energy: Chain-type Price Index (index 2017=100, seasonally adjusted)"),
  PCE: NIPAM("DPCERC", "Personal Consumption Expenditures (billions of dollars, seasonally adjusted annual rate)", 1000),
  PCEC96: NIPAM("DPCERX", "Real Personal Consumption Expenditures (billions of chained 2017 dollars, seasonally adjusted annual rate)", 1000),
  PI: NIPAM("A065RC", "Personal Income (billions of dollars, seasonally adjusted annual rate)", 1000),
  DSPI: NIPAM("A067RC", "Disposable Personal Income (billions of dollars, seasonally adjusted annual rate)", 1000),
  PSAVERT: NIPAM("A072RC", "Personal Saving Rate (percent, seasonally adjusted annual rate)"),
  // Federal Reserve Board H.10: noon buying rates in New York, and the dollar indexes.
  DEXUSEU: H10("rates", "RXI$US_N.B.EU", "U.S. Dollars to One Euro Spot Exchange Rate (business days)"),
  DEXUSUK: H10("rates", "RXI$US_N.B.UK", "U.S. Dollars to One U.K. Pound Sterling Spot Exchange Rate (business days)"),
  DEXUSAL: H10("rates", "RXI$US_N.B.AL", "U.S. Dollars to One Australian Dollar Spot Exchange Rate (business days)"),
  DEXJPUS: H10("rates", "RXI_N.B.JA", "Japanese Yen to One U.S. Dollar Spot Exchange Rate (business days)"),
  DEXCHUS: H10("rates", "RXI_N.B.CH", "Chinese Yuan Renminbi to One U.S. Dollar Spot Exchange Rate (business days)"),
  DEXCAUS: H10("rates", "RXI_N.B.CA", "Canadian Dollars to One U.S. Dollar Spot Exchange Rate (business days)"),
  DEXMXUS: H10("rates", "RXI_N.B.MX", "Mexican Pesos to One U.S. Dollar Spot Exchange Rate (business days)"),
  DEXSZUS: H10("rates", "RXI_N.B.SZ", "Swiss Francs to One U.S. Dollar Spot Exchange Rate (business days)"),
  DEXKOUS: H10("rates", "RXI_N.B.KO", "South Korean Won to One U.S. Dollar Spot Exchange Rate (business days)"),
  DEXINUS: H10("rates", "RXI_N.B.IN", "Indian Rupees to One U.S. Dollar Spot Exchange Rate (business days)"),
  DEXBZUS: H10("rates", "RXI_N.B.BZ", "Brazilian Reals to One U.S. Dollar Spot Exchange Rate (business days)"),
  DTWEXBGS: H10("indexes", "JRXWTFB_N.B", "Nominal Broad U.S. Dollar Index (index, business days)"),
  DTWEXAFEGS: H10("indexes", "JRXWTFN_N.B", "Nominal Advanced Foreign Economies U.S. Dollar Index (index, business days)"),
  DTWEXEMEGS: H10("indexes", "JRXWTFO_N.B", "Nominal Emerging Market Economies U.S. Dollar Index (index, business days)"),
  // Federal Reserve Board H.15, monthly averages.
  MPRIME: H15M("RIFSPBLP_N.M", "Bank Prime Loan Rate (percent, monthly)"),
  TB3MS: H15M("RIFSGFSM03_N.M", "3-Month Treasury Bill Secondary Market Rate, Discount Basis (percent, monthly)"),
  TB6MS: H15M("RIFSGFSM06_N.M", "6-Month Treasury Bill Secondary Market Rate, Discount Basis (percent, monthly)"),
  TB1YR: H15M("RIFSGFSY01_N.M", "1-Year Treasury Bill Secondary Market Rate, Discount Basis (percent, monthly)"),
  GS1: H15M("RIFLGFCY01_N.M", "Market Yield on U.S. Treasury Securities at 1-Year Constant Maturity (percent, monthly)"),
  GS2: H15M("RIFLGFCY02_N.M", "Market Yield on U.S. Treasury Securities at 2-Year Constant Maturity (percent, monthly)"),
  GS5: H15M("RIFLGFCY05_N.M", "Market Yield on U.S. Treasury Securities at 5-Year Constant Maturity (percent, monthly)"),
  GS10: H15M("RIFLGFCY10_N.M", "Market Yield on U.S. Treasury Securities at 10-Year Constant Maturity (percent, monthly)"),
  GS20: H15M("RIFLGFCY20_N.M", "Market Yield on U.S. Treasury Securities at 20-Year Constant Maturity (percent, monthly)"),
  GS30: H15M("RIFLGFCY30_N.M", "Market Yield on U.S. Treasury Securities at 30-Year Constant Maturity (percent, monthly)"),
  // Treasury real (TIPS) yields and the breakeven inflation computed from them.
  DFII5: REAL("5 YR", "5-Year"),
  DFII7: REAL("7 YR", "7-Year"),
  DFII10: REAL("10 YR", "10-Year"),
  DFII20: REAL("20 YR", "20-Year"),
  DFII30: REAL("30 YR", "30-Year"),
  T5YIE: BREAKEVEN(["5 Yr", "5 YR"], "5-Year Breakeven Inflation Rate: the 5-year nominal less the 5-year real par yield (percent, business days)"),
  T10YIE: BREAKEVEN(["10 Yr", "10 YR"], "10-Year Breakeven Inflation Rate: the 10-year nominal less the 10-year real par yield (percent, business days)"),
});
export const SUPPORTED_IDS = Object.freeze(Object.keys(SERIES));

// ---- caches and budgets ------------------------------------------------------
const HOUR = 3_600_000;
const cache = new Map(); // key -> { at, ttl, value, retrievedAt }
const CACHE_MAX = 500;
function cached(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.at > c.ttl) { cache.delete(key); return null; }
  return c;
}
function keep(key, value, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  const entry = { at: Date.now(), ttl, value, retrievedAt: new Date().toISOString() };
  cache.set(key, entry);
  return entry;
}
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const blsKey = () => (process.env.BLS_API_KEY || "").trim();
/** Queries a UTC day this server makes to the BLS API, under its limit (25
 *  keyless, 500 keyed). BLS_DAILY_MAX lowers it, never raises it: the CI sweep
 *  server sets it to the sweep's per-run cap (a fresh server's day is the run),
 *  so a run never spends the key's daily allowance. */
export const blsDailyBudget = () => {
  const base = blsKey() ? 450 : 20;
  const cap = Number(process.env.BLS_DAILY_MAX);
  return Number.isInteger(cap) && cap >= 0 ? Math.min(base, cap) : base;
};
const blsDay = { day: "", used: 0 };
function takeBlsQuery() {
  const d = new Date().toISOString().slice(0, 10);
  if (blsDay.day !== d) { blsDay.day = d; blsDay.used = 0; }
  if (blsDay.used >= blsDailyBudget()) return false;
  blsDay.used++;
  return true;
}
/** Test seam: forget every cached read and the day's BLS count. */
export function _resetUsMacroForTest() { cache.clear(); inflight.clear(); blsDay.day = ""; blsDay.used = 0; }

// The publisher did not answer, or answered a refusal (a BLS daily threshold
// on its side included): the upstream's outage, not ours.
const busy = (what) => Object.assign(bad(`${what} did not answer or refused the read (the publisher's own limit or outage); retry shortly.${notChargedHere()}`, 503), { retryAfter: 60, attribution: "upstream" });

// ---- BLS ---------------------------------------------------------------------
/** One decade of a BLS series (startYear a multiple of 10), oldest first. */
async function blsDecade(id, startYear) {
  const endYear = startYear + 9;
  const k = `bls:${id}:${startYear}`;
  const hit = cached(k);
  if (hit) return hit;
  return once(k, async () => {
    if (!takeBlsQuery()) throw Object.assign(bad(`The U.S. Bureau of Labor Statistics daily query allowance of this server is used up; this decade of the series is not held yet. Retry tomorrow, or ask for a window this server has read today.${notChargedHere()}`, 503), { retryAfter: 3600, capRefusal: CAP_NAMES.blsDay });
    const key = blsKey();
    const body = { seriesid: [id], startyear: String(startYear), endyear: String(endYear), ...(key ? { registrationkey: key } : {}) };
    const url = key ? "https://api.bls.gov/publicAPI/v2/timeseries/data/" : "https://api.bls.gov/publicAPI/v1/timeseries/data/";
    let j;
    try {
      const { html } = await retryTransient(() => safeFetch(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, timeoutMs: 12_000, maxBytes: 4 * 1024 * 1024, ownUpstream: true }));
      j = JSON.parse(html);
    } catch (e) {
      if (e?.statusCode && e.statusCode < 500 && e.statusCode !== 429) throw e;
      throw busy("The U.S. Bureau of Labor Statistics API");
    }
    if (j?.status !== "REQUEST_SUCCEEDED") throw busy("The U.S. Bureau of Labor Statistics API");
    const rows = [];
    for (const d of j?.Results?.series?.[0]?.data || []) {
      const m = /^M(0[1-9]|1[0-2])$/.exec(String(d.period));
      const v = Number(d.value);
      if (!m || !Number.isFinite(v) || !/^\d{4}$/.test(String(d.year))) continue;
      rows.push({ date: `${d.year}-${m[1]}-01`, value: v });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const thisDecade = Math.floor(new Date().getUTCFullYear() / 10) * 10 === startYear;
    return keep(k, rows, thisDecade ? 6 * HOUR : 7 * 24 * HOUR);
  });
}

/** The most decades one call reads (two keyless queries a day each spare the allowance). */
export const BLS_MAX_DECADES = 3;
async function blsSeries(id, fromYear, toYear) {
  const decades = [];
  for (let y = Math.floor(fromYear / 10) * 10; y <= toYear; y += 10) decades.push(y);
  if (decades.length > BLS_MAX_DECADES) throw bad(`A window on this series may touch at most three calendar decades (for example 2000-01-01 to 2029-12-31); narrow startDate and endDate.`);
  const parts = [];
  for (const y of decades) parts.push(await blsDecade(id, y));
  return { rows: parts.flatMap((p) => p.value), retrievedAt: parts.map((p) => p.retrievedAt).sort()[0] };
}

// ---- New York Fed ------------------------------------------------------------
async function nyfedRates(path) {
  const k = `nyfed:${path}`;
  const hit = cached(k);
  if (hit) return hit;
  return once(k, async () => {
    const end = new Date().toISOString().slice(0, 10);
    const url = `https://markets.newyorkfed.org/api/rates/${path}/search.json?startDate=2000-01-01&endDate=${end}`;
    let j;
    try {
      const { html } = await retryTransient(() => safeFetch(url, { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024, ownUpstream: true }));
      j = JSON.parse(html);
    } catch {
      throw busy("The New York Fed Markets Data API");
    }
    const rows = (j?.refRates || [])
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(String(r.effectiveDate)) && Number.isFinite(Number(r.percentRate)))
      .map((r) => ({ date: r.effectiveDate, value: Number(r.percentRate) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!rows.length) throw busy("The New York Fed Markets Data API");
    return keep(k, rows, 2 * HOUR);
  });
}

/** Monthly averages of a business-day rate over every calendar day, each day
 *  at the latest rate published on or before it (the method of the Federal
 *  Reserve's monthly effective rate); only months that have ended. */
export function monthlyCalendarAverage(daily, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  if (!daily.length) return out;
  const first = new Date(`${daily[0].date}T00:00:00Z`);
  let m = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)); // the first whole month
  // Months that have ended, through the month of the latest published rate.
  const thisMonth = today.slice(0, 7);
  const lastMonth = daily[daily.length - 1].date.slice(0, 7);
  let i = 0, cur = null;
  while (m.toISOString().slice(0, 7) < thisMonth && m.toISOString().slice(0, 7) <= lastMonth) {
    const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    let sum = 0, n = 0;
    for (let d = new Date(m); d < next; d = new Date(d.getTime() + 86_400_000)) {
      const ds = d.toISOString().slice(0, 10);
      while (i < daily.length && daily[i].date <= ds) cur = daily[i++].value;
      if (cur !== null) { sum += cur; n++; }
    }
    if (n) out.push({ date: m.toISOString().slice(0, 10), value: Math.round((sum / n) * 100) / 100 });
    m = next;
  }
  return out;
}

// ---- Treasury Fiscal Data ----------------------------------------------------
async function treasuryDebtQuarterly() {
  const k = "treasury:mspd-total";
  const hit = cached(k);
  if (hit) return hit;
  return once(k, async () => {
    const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/debt/mspd/mspd_table_1?filter=security_type_desc:eq:Total%20Public%20Debt%20Outstanding&fields=record_date,total_mil_amt&sort=record_date&page[size]=1000";
    let j;
    try {
      const { html } = await retryTransient(() => safeFetch(url, { timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024, ownUpstream: true }), { retries: 2, backoffMs: 400 });
      j = JSON.parse(html);
    } catch {
      throw busy("The U.S. Treasury Fiscal Data API");
    }
    const rows = [];
    for (const r of j?.data || []) {
      const m = /^(\d{4})-(03|06|09|12)-\d{2}$/.exec(String(r.record_date));
      const v = Number(r.total_mil_amt);
      if (!m || !Number.isFinite(v)) continue;
      const qStart = { "03": "01", "06": "04", "09": "07", "12": "10" }[m[2]];
      rows.push({ date: `${m[1]}-${qStart}-01`, value: v });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!rows.length) throw busy("The U.S. Treasury Fiscal Data API");
    return keep(k, rows, 6 * HOUR);
  });
}

// ---- the slower publishers: a call waits at most this long for a read --------
/** The longest a call waits for a publisher file this process does not hold
 *  yet; past it the call answers 503 with Retry-After (nothing is settled)
 *  and the read runs on to its own cap, filling the cache for the retry. */
export const PUBLISHER_WAIT_MS = 20_000;
async function withinWait(p, what) {
  let timer;
  p.catch(() => {});
  try {
    return await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(bad(`${what} is being read; retry in 30 s.${notChargedHere()}`, 503), { retryAfter: 30 })), PUBLISHER_WAIT_MS); timer.unref?.(); })]);
  } finally { clearTimeout(timer); }
}
const csvCells = (line) => { const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((c) => c.trim()); };

// ---- U.S. Treasury daily par yield curve -----------------------------------------
export const TREASURY_YIELDS_FIRST_YEAR = 1990;
/** The most calendar years one call reads (one file each). */
export const TREASURY_YIELDS_MAX_YEARS = 10;
const treasuryYieldsUrl = (year, real = false) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=${real ? "daily_treasury_real_yield_curve" : "daily_treasury_yield_curve"}&field_tdr_date_value=${year}&_format=csv`;
/** The first year of the real (TIPS) par yield curve file. */
export const TREASURY_REAL_YIELDS_FIRST_YEAR = 2003;
/** One year's file -> [{ date, cols: { "10 Yr": 4.18, ... } }], by header. */
export function parseTreasuryYieldsCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = csvCells(lines[0]);
  if (head[0] !== "Date") throw busy("The U.S. Treasury yield curve file");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = csvCells(lines[i]);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[0]);
    if (!m) continue;
    const cols = {};
    for (let j = 1; j < head.length; j++) { const v = c[j] === "" || c[j] === "N/A" || c[j] == null ? NaN : Number(c[j]); if (Number.isFinite(v)) cols[head[j]] = v; }
    rows.push({ date: `${m[3]}-${m[1]}-${m[2]}`, cols });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}
// The yield-curve tools (src/tools/macro-kit.js) keep the current and last
// year's files warm in production; a year they hold is used from there
// rather than read again (macro-kit hands its reader in at import).
let heldYields = null;
/** `fn(year)` -> { at, rows: [{ recordDate, mo1 ... yr30 }] } or null. */
export function useHeldTreasuryYields(fn) { heldYields = typeof fn === "function" ? fn : null; }
const HELD_TENORS = { mo1: "1 Mo", mo3: "3 Mo", mo6: "6 Mo", yr1: "1 Yr", yr2: "2 Yr", yr3: "3 Yr", yr5: "5 Yr", yr7: "7 Yr", yr10: "10 Yr", yr20: "20 Yr", yr30: "30 Yr" };
function fromHeld(year) {
  let h = null;
  try { h = heldYields ? heldYields(year) : null; } catch { h = null; }
  if (!h || !Array.isArray(h.rows) || !h.rows.length || !(Date.now() - h.at < 2 * HOUR)) return null;
  const rows = h.rows.map((r) => ({ date: r.recordDate, cols: Object.fromEntries(Object.entries(HELD_TENORS).filter(([kk]) => Number.isFinite(r[kk])).map(([kk, col]) => [col, r[kk]])) }));
  return { at: h.at, ttl: HOUR, value: rows, retrievedAt: new Date(h.at).toISOString() };
}
function treasuryYieldsYear(year, real = false) {
  const k = `yields:${real ? "real:" : ""}${year}`;
  const hit = cached(k) || (real ? null : fromHeld(year));
  if (hit) return Promise.resolve(hit);
  return once(k, async () => {
    let html;
    try {
      ({ html } = await safeFetch(treasuryYieldsUrl(year, real), { timeoutMs: 45_000, maxBytes: 5 * 1024 * 1024, ownUpstream: true }));
    } catch {
      throw busy("The U.S. Treasury yield curve file");
    }
    const rows = parseTreasuryYieldsCsv(html);
    const current = year >= new Date().getUTCFullYear();
    return keep(k, rows, current ? HOUR : 30 * 24 * HOUR);
  });
}
async function treasuryYields(s, fromYear, toYear) {
  const real = s.real || s.breakeven;
  const first = real ? TREASURY_REAL_YIELDS_FIRST_YEAR : TREASURY_YIELDS_FIRST_YEAR;
  const years = [];
  for (let y = Math.max(fromYear, first); y <= toYear; y++) years.push(y);
  if (years.length > TREASURY_YIELDS_MAX_YEARS) throw bad(`A window on a Treasury yield series may touch at most ${TREASURY_YIELDS_MAX_YEARS} calendar years; narrow startDate and endDate.`);
  const reads = [];
  if (!s.real) reads.push(...years.map((y) => treasuryYieldsYear(y, false)));
  if (real) reads.push(...years.map((y) => treasuryYieldsYear(y, true)));
  const parts = await withinWait(Promise.all(reads), "The U.S. Treasury yield curve file");
  const rows = [];
  if (s.breakeven) {
    // The nominal and the real file of each year, joined by date.
    const [nom, rl] = s.breakeven;
    const realBy = new Map(parts.slice(years.length).flatMap((p) => p.value).map((r) => [r.date, r.cols[rl]]));
    for (const r of parts.slice(0, years.length).flatMap((p) => p.value)) {
      const a = r.cols[nom], b = realBy.get(r.date);
      if (Number.isFinite(a) && Number.isFinite(b)) rows.push({ date: r.date, value: Math.round((a - b) * 1e6) / 1e6 });
    }
  } else {
    for (const r of parts.flatMap((p) => p.value)) {
      if (s.spread) { const [a, b] = s.spread; if (Number.isFinite(r.cols[a]) && Number.isFinite(r.cols[b])) rows.push({ date: r.date, value: Math.round((r.cols[a] - r.cols[b]) * 1e6) / 1e6 }); }
      else if (Number.isFinite(r.cols[s.col])) rows.push({ date: r.date, value: r.cols[s.col] });
    }
  }
  return { rows, retrievedAt: parts.map((p) => p.retrievedAt).sort()[0] };
}

// ---- Federal Reserve Board H.6 -----------------------------------------------------
// The monthly package (M1, M2 and other release data), every column of it.
export const H6_PACKAGE_URL = "https://www.federalreserve.gov/datadownload/Output.aspx?rel=H6&series=798e2796917702a5f8423426ba7e6b42&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn&type=package";
/** A Data Download Program package -> { "<column>": [{ date, value }], ... },
 *  by the header row; monthly periods (YYYY-MM) are dated the 1st, daily
 *  ones (YYYY-MM-DD) as they are. Cells such as ND (no data) are skipped. */
export function parseFrbCsv(text, what = "The Federal Reserve Board file") { return parseH6Csv(text, what); }
/** The package -> { "M2.M": [{ date, value }], ... } (billions), by the header row. */
export function parseH6Csv(text, what = "The Federal Reserve Board H.6 file") {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  const at = lines.findIndex((l) => /^"?Time Period"?,/.test(l));
  if (at < 0) throw busy(what);
  const head = csvCells(lines[at]);
  const out = {};
  for (let j = 1; j < head.length; j++) out[head[j]] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const c = csvCells(lines[i]);
    if (!/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(c[0])) continue;
    const date = c[0].length === 7 ? `${c[0]}-01` : c[0];
    for (let j = 1; j < head.length; j++) { if (c[j] === "" || c[j] == null) continue; const v = Number(c[j]); if (Number.isFinite(v)) out[head[j]].push({ date, value: v }); }
  }
  return out;
}
function h6Package() {
  const k = "frb:h6";
  const hit = cached(k);
  if (hit) return Promise.resolve(hit);
  return once(k, async () => {
    let html;
    try {
      ({ html } = await retryTransient(() => safeFetch(H6_PACKAGE_URL, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024, ownUpstream: true })));
    } catch {
      throw busy("The Federal Reserve Board H.6 file");
    }
    return keep(k, parseH6Csv(html), 6 * HOUR);
  });
}

// ---- Federal Reserve Board H.10 and H.15 ---------------------------------------------
// H.10: the daily rates and the daily dollar indexes, read for the last
// H10_YEARS calendar years (the program does not serve the whole daily history
// in one file). H.15: the monthly package, whole history.
export const H10_YEARS = 10;
const H10_PACKAGES = Object.freeze({ rates: "60f32914ab61dfab590e0e470153e3ae", indexes: "122e3bcb627e8e53f1bf72a1a09cfb81" });
export const H15_MONTHLY_URL = "https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series=d7e27b7b09a3a7feae95b9c61781fcd8&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn&type=package";
export const h10FirstYear = (nowYear = new Date().getUTCFullYear()) => nowYear - H10_YEARS;
export const h10Url = (pkg, nowYear = new Date().getUTCFullYear()) => `https://www.federalreserve.gov/datadownload/Output.aspx?rel=H10&series=${H10_PACKAGES[pkg]}&lastobs=&from=01/01/${h10FirstYear(nowYear)}&to=12/31/${nowYear}&filetype=csv&label=include&layout=seriescolumn&type=package`;
function frbPackage(k, url, what, ttl) {
  const hit = cached(k);
  if (hit) return Promise.resolve(hit);
  return once(k, async () => {
    // The program sometimes answers an empty 200 for a package it is still
    // building: one more read before the call is answered busy.
    for (let attempt = 0; ; attempt++) {
      let html;
      try {
        ({ html } = await retryTransient(() => safeFetch(url, { timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, ownUpstream: true })));
      } catch {
        throw busy(what);
      }
      let parsed = null;
      try { parsed = parseFrbCsv(html, what); } catch (e) { if (attempt >= 1) throw e; }
      if (parsed && Object.values(parsed).some((r) => r.length)) return keep(k, parsed, ttl);
      if (attempt >= 1) throw busy(what);
    }
  });
}
const h10Package = (pkg) => frbPackage(`frb:h10:${pkg}`, h10Url(pkg), "The Federal Reserve Board H.10 file", 2 * HOUR);
const h15Monthly = () => frbPackage("frb:h15:m", H15_MONTHLY_URL, "The Federal Reserve Board H.15 file", 6 * HOUR);

// ---- BEA NIPA monthly flat file ------------------------------------------------------
export const BEA_NIPA_M_URL = "https://apps.bea.gov/national/Release/TXT/NipaDataM.txt";
const BEA_MONTHLY_CODES = () => [...new Set(Object.values(SERIES).filter((x) => x.source === "beaM").map((x) => x.code))];
/** The monthly flat file -> { CODE: [{ date, value }] } for `codes` ({ code: divisor }). */
export function parseNipaMonthly(text, codes) {
  const out = Object.fromEntries(Object.keys(codes).map((c) => [c, []]));
  const t = String(text || "");
  for (const [code, divisor] of Object.entries(codes)) {
    let at = t.indexOf(`\n${code},`);
    while (at >= 0) {
      const end = t.indexOf("\n", at + 1);
      const line = t.slice(at + 1, end < 0 ? undefined : end);
      if (!line.startsWith(`${code},`)) break;
      const m = /^[A-Z0-9]+,(\d{4})M(0[1-9]|1[0-2]),"?([-0-9,.]+)"?\s*$/.exec(line);
      if (m) { const v = Number(m[3].replace(/,/g, "")); if (Number.isFinite(v)) out[code].push({ date: `${m[1]}-${m[2]}-01`, value: divisor === 1 ? v : Math.round(v) / divisor }); }
      at = end;
    }
    out[code].sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return out;
}
function beaNipaMonthly() {
  const k = "bea:nipa-m";
  const hit = cached(k);
  if (hit) return Promise.resolve(hit);
  return once(k, async () => {
    let html;
    try {
      ({ html } = await safeFetch(BEA_NIPA_M_URL, { timeoutMs: 60_000, maxBytes: 80 * 1024 * 1024, ownUpstream: true }));
    } catch {
      throw busy("The U.S. Bureau of Economic Analysis file");
    }
    const codes = Object.fromEntries(Object.values(SERIES).filter((x) => x.source === "beaM").map((x) => [x.code, x.divisor]));
    const parsed = parseNipaMonthly(html, codes);
    html = null;
    if (!BEA_MONTHLY_CODES().every((c) => parsed[c]?.length)) throw busy("The U.S. Bureau of Economic Analysis file");
    return keep(k, parsed, 12 * HOUR);
  });
}

// ---- BEA NIPA quarterly flat file ------------------------------------------------
export const BEA_NIPA_Q_URL = "https://apps.bea.gov/national/Release/TXT/NipaDataQ.txt";
const BEA_CODES = ["A191RC", "A191RX"];
/** The flat file -> { A191RC: [{ date, value }], ... } in billions, for the codes asked. */
export function parseNipaQuarterly(text, codes = BEA_CODES) {
  const out = Object.fromEntries(codes.map((c) => [c, []]));
  const t = String(text || "");
  for (const code of codes) {
    let at = t.indexOf(`\n${code},`);
    while (at >= 0) {
      const end = t.indexOf("\n", at + 1);
      const line = t.slice(at + 1, end < 0 ? undefined : end);
      if (!line.startsWith(`${code},`)) break;
      const m = /^[A-Z0-9]+,(\d{4})Q([1-4]),"?([-0-9,.]+)"?\s*$/.exec(line);
      if (m) { const v = Number(m[3].replace(/,/g, "")); if (Number.isFinite(v)) out[code].push({ date: `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}-01`, value: Math.round(v) / 1000 }); }
      at = end;
    }
    out[code].sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return out;
}
function beaNipa() {
  const k = "bea:nipa-q";
  const hit = cached(k);
  if (hit) return Promise.resolve(hit);
  return once(k, async () => {
    let html;
    try {
      ({ html } = await safeFetch(BEA_NIPA_Q_URL, { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024, ownUpstream: true }));
    } catch {
      throw busy("The U.S. Bureau of Economic Analysis file");
    }
    const parsed = parseNipaQuarterly(html);
    if (!parsed.A191RC.length || !parsed.A191RX.length) throw busy("The U.S. Bureau of Economic Analysis file");
    return keep(k, parsed, 12 * HOUR);
  });
}

// ---- transformations ---------------------------------------------------------
const PER_YEAR = { d: 260, w: 52, m: 12, q: 4, sa: 2, a: 1 };
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);
/** The value a year before observation i: the same date a year earlier for
 *  a monthly or lower series, else the latest observation on or before it. */
function yearAgo(rows, i, freq) {
  const target = `${Number(rows[i].date.slice(0, 4)) - 1}${rows[i].date.slice(4)}`;
  let lo = 0, hi = i - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].date <= target) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  if (found < 0) return null;
  if (PER_YEAR[freq] <= 12 && rows[found].date !== target) return null;
  return rows[found].value;
}
/** FRED's units codes, computed from the publisher's levels. */
export function transform(rows, units, freq) {
  if (units === "lin") return rows;
  const n = PER_YEAR[freq] || 12;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i].value, p = i > 0 ? rows[i - 1].value : null;
    let v = null;
    if (units === "chg") v = p === null ? null : x - p;
    else if (units === "pch") v = p ? (x / p - 1) * 100 : null;
    else if (units === "pca") v = p ? (Math.pow(x / p, n) - 1) * 100 : null;
    else if (units === "cca") v = p && x > 0 && p > 0 ? n * Math.log(x / p) * 100 : null;
    else if (units === "log") v = x > 0 ? Math.log(x) : null;
    else if (units === "ch1" || units === "pc1") {
      const y = yearAgo(rows, i, freq);
      v = y === null ? null : units === "ch1" ? x - y : y ? (x / y - 1) * 100 : null;
    }
    if (v !== null && Number.isFinite(v)) out.push({ date: rows[i].date, value: round(v) });
  }
  return out;
}

const RANK = { d: 0, w: 1, m: 2, q: 3, sa: 4, a: 5 };
export const SUPPORTED_FREQ = Object.freeze(["d", "w", "m", "q", "sa", "a"]);
function periodStart(date, freq) {
  const y = date.slice(0, 4), mo = Number(date.slice(5, 7));
  if (freq === "m") return `${y}-${date.slice(5, 7)}-01`;
  if (freq === "q") return `${y}-${String(Math.floor((mo - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  if (freq === "sa") return `${y}-${mo <= 6 ? "01" : "07"}-01`;
  if (freq === "a") return `${y}-01-01`;
  // w: weeks ending Friday, dated by the Friday (FRED's wef)
  const d = new Date(`${date}T00:00:00Z`);
  const fri = new Date(d.getTime() + ((5 - d.getUTCDay() + 7) % 7) * 86_400_000);
  return fri.toISOString().slice(0, 10);
}
/** Averages to a lower frequency; only periods the data covers through their end. */
export function aggregate(rows, from, to) {
  if (to === from || (to === "d" && from === "d")) return rows;
  if (RANK[to] < RANK[from]) throw bad(`"frequency" ${to} is higher than this series' own frequency (${from}); a series can only be aggregated to a lower one.`);
  const groups = new Map();
  for (const r of rows) {
    const k = periodStart(r.date, to);
    const g = groups.get(k) || { n: 0, sum: 0 };
    g.n++; g.sum += r.value;
    groups.set(k, g);
  }
  const last = rows.length ? rows[rows.length - 1].date : "";
  const need = from === "m" ? { q: 3, sa: 6, a: 12 }[to] : null;
  // Averages are given at the precision the series is published in.
  const places = rows.reduce((m, r) => Math.max(m, (String(r.value).split(".")[1] || "").length), 0);
  const out = [];
  for (const [k, g] of groups) {
    if (need && g.n < need) continue;
    if (!need && from === "d") {
      // the period must have ended by the last observation
      const end = to === "w" ? k : periodEnd(k, to);
      if (end > last && !(to === "w" && k <= last)) continue;
    }
    out.push({ date: k, value: Number((g.sum / g.n).toFixed(places)) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
function periodEnd(start, freq) {
  const d = new Date(`${start}T00:00:00Z`);
  const months = { m: 1, q: 3, sa: 6, a: 12 }[freq];
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 0)).toISOString().slice(0, 10);
}

// ---- the series read ---------------------------------------------------------
const yearOf = (iso) => Number(iso.slice(0, 4));
/**
 * Observations of a supported FRED series ID from its publisher, in
 * fred-series' answer shape. `frequency` and `units` follow FRED's codes
 * (frequency: d, w, m, q, sa, a).
 */
export async function usMacroSeries({ seriesId, startDate, endDate, limit = 1000, units = "lin", frequency }) {
  const s = SERIES[seriesId];
  if (!s) return null;
  if (frequency && !SUPPORTED_FREQ.includes(frequency === "wef" ? "w" : frequency)) {
    throw bad(`"frequency" ${frequency} is not offered on this series; use one of: ${SUPPORTED_FREQ.join(", ")} (w is weeks ending Friday).`);
  }
  const freqOut = frequency === "wef" ? "w" : frequency;
  const nowYear = new Date().getUTCFullYear();
  let rows, retrievedAt, sourceName, sourceSeries, credit, windowNote = null, defaultedStart = false;
  // A year more than asked, so the first observations of a year-over-year
  // transform have their base.
  const pad = units === "ch1" || units === "pc1" ? 1 : units === "lin" ? 0 : 1;
  if (s.source === "bls") {
    const toYear = endDate ? Math.min(yearOf(endDate), nowYear) : nowYear;
    let fromYear;
    if (startDate) fromYear = yearOf(startDate) - pad;
    else { fromYear = toYear - 9 - pad; defaultedStart = true; }
    const got = await blsSeries(s.id, Math.max(fromYear, 1913), toYear);
    rows = got.rows; retrievedAt = got.retrievedAt;
    sourceName = "U.S. Bureau of Labor Statistics"; sourceSeries = s.id;
    credit = BLS_VOUCH;
    if (defaultedStart) windowNote = "With no startDate, this series answers its last 10 years; pass startDate for earlier years (up to three calendar decades per call).";
  } else if (s.source === "nyfed") {
    const got = await nyfedRates(s.path);
    rows = s.monthlyAverage ? monthlyCalendarAverage(got.value) : got.value;
    retrievedAt = got.retrievedAt;
    sourceName = "Federal Reserve Bank of New York"; sourceSeries = s.path.split("/")[1].toUpperCase();
    credit = `${NYFED_NOTICE(s.name)}${s.dtcc ? ` ${SOFR_DTCC_NOTICE}` : ""} © ${nowYear} Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org.`;
  } else if (s.source === "yields") {
    const toYear = endDate ? Math.min(yearOf(endDate), nowYear) : nowYear;
    let fromYear;
    if (startDate) fromYear = yearOf(startDate) - pad;
    else { fromYear = toYear - 1 - pad; defaultedStart = true; }
    if (startDate && yearOf(startDate) > toYear) fromYear = toYear;
    const got = await treasuryYields(s, fromYear, toYear);
    rows = got.rows; retrievedAt = got.retrievedAt;
    sourceName = "U.S. Department of the Treasury";
    sourceSeries = s.breakeven ? `Daily Treasury Par Yield Curve Rates: ${s.breakeven[0]} minus Daily Treasury Par Real Yield Curve Rates: ${s.breakeven[1]}`
      : s.real ? `Daily Treasury Par Real Yield Curve Rates: ${s.col}`
        : `Daily Treasury Par Yield Curve Rates: ${s.spread ? s.spread.join(" minus ") : s.col}`;
    credit = s.real ? TREASURY_REAL_YIELDS_CREDIT : s.breakeven ? `${TREASURY_YIELDS_CREDIT} ${TREASURY_REAL_YIELDS_CREDIT}` : TREASURY_YIELDS_CREDIT;
    if (defaultedStart) windowNote = `With no startDate, this series answers its last 2 calendar years; pass startDate for earlier years (from ${s.real || s.breakeven ? TREASURY_REAL_YIELDS_FIRST_YEAR : TREASURY_YIELDS_FIRST_YEAR}, up to ${TREASURY_YIELDS_MAX_YEARS} calendar years per call).`;
  } else if (s.source === "frb") {
    const got = await withinWait(h6Package(), "The Federal Reserve Board H.6 file");
    rows = got.value[s.col] || [];
    if (!rows.length) throw busy("The Federal Reserve Board H.6 file");
    retrievedAt = got.retrievedAt;
    sourceName = "Board of Governors of the Federal Reserve System (US)"; sourceSeries = `H.6 Money Stock Measures: ${s.col}`;
    credit = FRB_H6_CREDIT;
  } else if (s.source === "h10") {
    const first = h10FirstYear(nowYear);
    if (startDate && yearOf(startDate) < first) throw bad(`This series is served from ${first}-01-01 (the last ${H10_YEARS} calendar years); pass a later startDate.`);
    const got = await withinWait(h10Package(s.pkg), "The Federal Reserve Board H.10 file");
    rows = got.value[s.col] || [];
    if (!rows.length) throw busy("The Federal Reserve Board H.10 file");
    retrievedAt = got.retrievedAt;
    if (!startDate) defaultedStart = true;
    sourceName = "Board of Governors of the Federal Reserve System (US)"; sourceSeries = `H.10 Foreign Exchange Rates: ${s.col}`;
    credit = FRB_H10_CREDIT;
    if (defaultedStart) windowNote = `With no startDate, this series answers its last 2 calendar years; pass startDate for earlier years (from ${first}).`;
  } else if (s.source === "h15") {
    const got = await withinWait(h15Monthly(), "The Federal Reserve Board H.15 file");
    rows = got.value[s.col] || [];
    if (!rows.length) throw busy("The Federal Reserve Board H.15 file");
    retrievedAt = got.retrievedAt;
    sourceName = "Board of Governors of the Federal Reserve System (US)"; sourceSeries = `H.15 Selected Interest Rates: ${s.col}`;
    credit = FRB_H15_CREDIT;
  } else if (s.source === "beaM") {
    const got = await withinWait(beaNipaMonthly(), "The U.S. Bureau of Economic Analysis file");
    rows = got.value[s.code] || [];
    retrievedAt = got.retrievedAt;
    sourceName = "U.S. Bureau of Economic Analysis"; sourceSeries = `NIPA ${s.code} (monthly)`;
    credit = BEA_CREDIT;
  } else if (s.source === "bea") {
    const got = await withinWait(beaNipa(), "The U.S. Bureau of Economic Analysis file");
    rows = got.value[s.code] || [];
    retrievedAt = got.retrievedAt;
    sourceName = "U.S. Bureau of Economic Analysis"; sourceSeries = `NIPA ${s.code} (Table 1.1.${s.code === "A191RX" ? "6" : "5"}, line 1)`;
    credit = BEA_CREDIT;
  } else {
    const got = await treasuryDebtQuarterly();
    rows = got.value; retrievedAt = got.retrievedAt;
    sourceName = "U.S. Department of the Treasury, Fiscal Data"; sourceSeries = "mspd_table_1: Total Public Debt Outstanding";
    credit = TREASURY_FISCAL_CREDIT;
  }
  rows = rows.slice();
  let derived = !!s.monthlyAverage || !!s.spread || !!s.breakeven;
  if (freqOut && freqOut !== s.freq) { rows = aggregate(rows, s.freq, freqOut); derived = true; }
  if (units !== "lin") { rows = transform(rows, units, freqOut || s.freq); derived = true; }
  const back = s.source === "yields" || s.source === "h10" ? 1 : 9;
  const from = startDate || (defaultedStart ? `${(endDate ? Math.min(yearOf(endDate), nowYear) : nowYear) - back}-01-01` : null);
  if (from) rows = rows.filter((r) => r.date >= from);
  if (endDate) rows = rows.filter((r) => r.date <= endDate);
  const matched = rows.length;
  const observations = rows.slice(0, limit);
  return {
    seriesId,
    units,
    count: observations.length,
    observations,
    source: derived ? `Computed by Agent402 from ${sourceName} data` : sourceName,
    sourceSeries,
    title: s.title,
    retrievedAt,
    credit,
    terms: TERMS[TERMS_OF[s.source] || s.source],
    ...(derived ? { derived: true } : {}),
    ...(s.note ? { note: s.note } : {}),
    ...(windowNote ? { window: windowNote } : {}),
    ...(matched > observations.length ? { returned: observations.length, matched, complete: false, truncated: true } : {}),
  };
}

/** The 404 for an ID this route does not serve: the supported IDs, named. */
export function unsupportedSeriesError(seriesId) {
  return Object.assign(
    bad(`Series ${seriesId} is not served here. fred-series answers these FRED series IDs from the agencies that publish them: ${SUPPORTED_IDS.join(", ")}.`, 404),
    { supportedSeriesIds: SUPPORTED_IDS },
  );
}
