// Company-specific content for the free SEC filing pages (src/programmatic-pages.js).
//
// Those pages carried the same frame around a few EDGAR facts, so one company's
// page read almost word for word like the next. Everything here turns data the
// page already reads (the submissions index, the parsed Form 4 rows, the 13F
// table) plus three small XBRL concept reads into figures and sentences that are
// true of THIS company only: annual revenue, net income and assets with the
// change on the prior year, what it filed in the last twelve months and why its
// 8-Ks were filed, who traded and for how much, how concentrated a fund is.
//
// Pure functions except keyFinancials, which takes the EDGAR reader as a
// dependency so tests drive it without the network. Nothing here invents a
// number: a figure that is not in the filings is left out, never estimated.

const DAY_MS = 86_400_000;

// --- formatting -------------------------------------------------------------
/** $1.2B / $345.6M / $12,345: compact US-dollar amounts for prose and tables. */
export function fmtMoney(n) {
  if (!Number.isFinite(n)) return "";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(a >= 1e11 ? 0 : 1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  return `${s}$${Math.round(a).toLocaleString("en-US")}`;
}
const pct = (x) => `${Math.abs(x * 100).toFixed(1)}%`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** EDGAR "0930" -> "September 30". */
export function fiscalYearEndText(mmdd) {
  const m = /^(\d{2})(\d{2})$/.exec(String(mmdd || ""));
  if (!m) return "";
  const mi = Number(m[1]) - 1, d = Number(m[2]);
  return mi >= 0 && mi < 12 && d >= 1 && d <= 31 ? `${MONTHS[mi]} ${d}` : "";
}

const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "the District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  E9: "the Cayman Islands", D0: "Bermuda", L2: "Ireland", X0: "the United Kingdom", A1: "Ontario", K3: "Hong Kong",
  L3: "Israel", N4: "the Netherlands", U0: "Singapore", W8: "Switzerland",
};
export const stateName = (code) => STATES[String(code || "").toUpperCase()] || "";

// --- XBRL annual financials ---------------------------------------------------
// Revenue is reported under different tags by different filers (a bank reports
// revenue net of interest expense; older filers used Revenues or SalesRevenueNet,
// and some stopped using one tag years ago). Tried in order; the first whose
// newest annual value is recent wins, otherwise the freshest one read.
export const REVENUE_TAGS = Object.freeze([
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "RevenuesNetOfInterestExpense",
  "SalesRevenueNet",
]);
const FRESH_MS = 550 * DAY_MS;

/** One value per fiscal year from a companyconcept payload: 10-K, full-year,
 *  US dollars. A flow (revenue, income) must span roughly a year; an instant
 *  (assets) has no start. When several filings report the same year the latest
 *  filed one wins (it carries any restatement). Newest year first. */
export function annualSeries(concept, { instant = false } = {}) {
  const rows = Array.isArray(concept?.units?.USD) ? concept.units.USD : [];
  const byEnd = new Map();
  for (const x of rows) {
    if (x?.form !== "10-K" || x?.fp !== "FY" || !Number.isFinite(x?.val) || !x?.end) continue;
    if (!instant) {
      const days = (Date.parse(x.end) - Date.parse(x.start)) / DAY_MS;
      if (!(days >= 330 && days <= 400)) continue;
    }
    const cur = byEnd.get(x.end);
    if (!cur || String(x.filed || "") > String(cur.filed || "")) byEnd.set(x.end, x);
  }
  return [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end)).map((x) => ({ end: x.end, val: x.val, accn: x.accn || null, filed: x.filed || null }));
}

/** Revenue, net income and total assets for the latest fiscal years, read from
 *  data.sec.gov companyconcept: at most REVENUE_TAGS.length + 2 small requests.
 *  A tag the company does not report (404) is skipped; any OTHER read failure
 *  (a throttle, a timeout) marks the result partial so the caller caches it
 *  briefly instead of freezing a gap for half a day. */
export async function keyFinancials(cik, getJson, { now = Date.now(), years = 3 } = {}) {
  let partial = false;
  const read = async (tag) => {
    try { return await getJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`); }
    catch (e) { if (e?.upstreamStatus !== 404) partial = true; return null; }
  };
  const revenueRead = (async () => {
    let best = null, tag = null;
    for (const t of REVENUE_TAGS) {
      const s = annualSeries(await read(t));
      if (!s.length) continue;
      if (!best || s[0].end > best[0].end) { best = s; tag = t; }
      if (now - Date.parse(s[0].end) <= FRESH_MS) break;
    }
    return { series: best || [], tag };
  })();
  const [rev, ni, assets] = await Promise.all([
    revenueRead,
    read("NetIncomeLoss").then((c) => annualSeries(c)),
    read("Assets").then((c) => annualSeries(c, { instant: true })),
  ]);
  const ends = [...new Set([...rev.series, ...ni].map((x) => x.end))].sort((a, b) => b.localeCompare(a)).slice(0, years);
  const at = (series, end) => series.find((x) => x.end === end)?.val ?? null;
  const rows = ends.map((end) => ({ end, revenue: at(rev.series, end), netIncome: at(ni, end), assets: at(assets, end) }));
  return { rows, revenueTag: rev.tag, partial, stale: rows.length > 0 && now - Date.parse(rows[0].end) > FRESH_MS };
}

// --- filing activity from the submissions index --------------------------------
const FORM_LABELS = {
  "10-K": ["annual report", "annual reports"], "10-Q": ["quarterly report", "quarterly reports"],
  "8-K": ["current report on Form 8-K", "current reports on Form 8-K"], "4": ["Form 4 insider filing", "Form 4 insider filings"],
  "DEF 14A": ["proxy statement", "proxy statements"], "S-8": ["S-8 employee-plan registration", "S-8 employee-plan registrations"],
  "SC 13G": ["Schedule 13G ownership filing", "Schedule 13G ownership filings"], "SC 13G/A": ["Schedule 13G amendment", "Schedule 13G amendments"],
  "SCHEDULE 13G": ["Schedule 13G ownership filing", "Schedule 13G ownership filings"], "SCHEDULE 13G/A": ["Schedule 13G amendment", "Schedule 13G amendments"],
  "SCHEDULE 13D": ["Schedule 13D ownership filing", "Schedule 13D ownership filings"], "SCHEDULE 13D/A": ["Schedule 13D amendment", "Schedule 13D amendments"],
  "10-K/A": ["amended annual report", "amended annual reports"], "10-Q/A": ["amended quarterly report", "amended quarterly reports"],
  "8-K/A": ["amended current report", "amended current reports"], "DEFA14A": ["additional proxy material", "additional proxy materials"],
  "3": ["Form 3 initial ownership filing", "Form 3 initial ownership filings"], "S-3ASR": ["shelf registration", "shelf registrations"],
  "424B3": ["424B3 prospectus", "424B3 prospectuses"], "424B5": ["424B5 prospectus", "424B5 prospectuses"],
  "144": ["Form 144 notice of proposed sale", "Form 144 notices of proposed sale"], "424B2": ["424B2 prospectus", "424B2 prospectuses"],
  "FWP": ["free writing prospectus", "free writing prospectuses"], "11-K": ["11-K plan report", "11-K plan reports"],
};
// High-volume offering paperwork: a large issuer can file thousands of pricing
// supplements a year, which would bury every filing a reader is looking for.
export const isOfferingNoise = (form) => /^(424B\d*|FWP)$/.test(String(form || "").toUpperCase());
// Forms a reader of a company profile looks for first, in this order.
const KEY_FORMS = ["10-K", "10-Q", "8-K", "4", "DEF 14A", "20-F", "6-K", "40-F"];

export const formLabel = (form, n) => { const l = FORM_LABELS[form]; return l ? (n === 1 ? l[0] : l[1]) : `Form ${form} ${n === 1 ? "filing" : "filings"}`; };

// Item 9.01 (exhibits) rides on almost every 8-K and says nothing on its own.
export const EIGHT_K_ITEMS = Object.freeze({
  "1.01": "a material agreement", "1.02": "ending a material agreement", "1.05": "a cybersecurity incident",
  "2.01": "an acquisition or disposition", "2.02": "results of operations", "2.03": "a new financial obligation",
  "2.05": "exit or restructuring costs", "2.06": "an impairment", "3.01": "a listing notice",
  "3.02": "unregistered equity sales", "3.03": "changes to shareholder rights", "4.01": "an auditor change",
  "4.02": "non-reliance on past financials", "5.02": "officer or director changes", "5.03": "charter or bylaw amendments",
  "5.07": "shareholder vote results", "7.01": "Regulation FD disclosures", "8.01": "other events",
});

/** The submissions index's `recent` arrays as row objects. */
function recentRows(sub) {
  const r = sub?.filings?.recent || {};
  const n = Array.isArray(r.form) ? r.form.length : 0;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      form: String(r.form[i] || "").toUpperCase(), filingDate: r.filingDate?.[i] || null, reportDate: r.reportDate?.[i] || null,
      accession: r.accessionNumber?.[i] || null, primaryDocument: r.primaryDocument?.[i] || null,
      description: r.primaryDocDescription?.[i] || null, items: r.items?.[i] || "",
    });
  }
  return rows;
}

/** A filing's primary document on sec.gov (or its index when no document is named). */
export function filingUrl(cik, accession, primaryDocument) {
  const c = String(parseInt(cik, 10)), a = String(accession || "").replace(/-/g, "");
  if (!c || c === "NaN" || !a) return null;
  return primaryDocument ? `https://www.sec.gov/Archives/edgar/data/${c}/${a}/${primaryDocument}` : `https://www.sec.gov/Archives/edgar/data/${c}/${a}/`;
}

/** What the company filed in the twelve months before `now`, newest filings
 *  first, plus counts by form and the reasons its 8-Ks were filed. */
export function filingActivity(sub, cik, { now = Date.now(), recent = 10 } = {}) {
  const rows = recentRows(sub);
  const since = new Date(now - 365 * DAY_MS).toISOString().slice(0, 10);
  const inYear = rows.filter((r) => r.filingDate && r.filingDate >= since);
  const byForm = {};
  for (const r of inYear) byForm[r.form] = (byForm[r.form] || 0) + 1;
  const items = {};
  for (const r of inYear) {
    if (r.form !== "8-K") continue;
    for (const it of String(r.items).split(",").map((s) => s.trim()).filter(Boolean)) if (EIGHT_K_ITEMS[it]) items[it] = (items[it] || 0) + 1;
  }
  return {
    since, total: inYear.length,
    byForm: Object.entries(byForm).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([form, n]) => ({ form, n })),
    eightKItems: Object.entries(items).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([item, n]) => ({ item, n, label: EIGHT_K_ITEMS[item] })),
    offeringNoise: inYear.filter((r) => isOfferingNoise(r.form)).length,
    recent: rows.filter((r) => !isOfferingNoise(r.form)).slice(0, recent).map((r) => ({ form: r.form, filingDate: r.filingDate, reportDate: r.reportDate, description: r.description, url: filingUrl(cik, r.accession, r.primaryDocument) })),
  };
}

// --- sentences ------------------------------------------------------------------
const listJoin = (xs) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);
const longDate = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return Number.isNaN(d.getTime()) ? String(iso || "") : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const change = (cur, prev) => (Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0 ? (cur - prev) / Math.abs(prev) : null);

/** Plain-English paragraphs about one company, built only from its own filings. */
export function dossierNarrative(d) {
  if (!d) return [];
  const out = [];
  const who = [];
  if (d.category) who.push(`a ${String(d.category).toLowerCase()}`);
  const inc = stateName(d.stateOfIncorporation);
  const tickers = [...new Set(d.tickers || [])], exchanges = [...new Set(d.exchanges || [])];
  const ident = `${d.name}${tickers.length ? ` (${tickers.slice(0, 3).join(", ")}${tickers.length > 3 ? ` and ${tickers.length - 3} more` : ""})` : ""} is ${who[0] || "an SEC registrant"}${inc ? ` incorporated in ${inc}` : ""}${d.industry ? `, classified under SIC ${d.sic} (${d.industry})` : ""}${exchanges.length ? `, and lists on ${listJoin(exchanges)}` : ""}.`;
  const fy = fiscalYearEndText(d.fiscalYearEnd);
  out.push(`${ident}${fy ? ` Its fiscal year ends ${fy}.` : ""}${d.formerNames?.length ? ` It has also filed as ${listJoin(d.formerNames.slice(0, 3).map((f) => f.name))}.` : ""}`);
  const f = d.financials?.rows || [];
  if (f.length) {
    const [cur, prev] = f;
    const bits = [];
    if (Number.isFinite(cur.revenue)) { const c = change(cur.revenue, prev?.revenue); bits.push(`revenue of ${fmtMoney(cur.revenue)}${c == null ? "" : `, ${c >= 0 ? "up" : "down"} ${pct(c)} from the year before`}`); }
    if (Number.isFinite(cur.netIncome)) bits.push(cur.netIncome >= 0 ? `net income of ${fmtMoney(cur.netIncome)}` : `a net loss of ${fmtMoney(-cur.netIncome)}`);
    if (Number.isFinite(cur.assets)) bits.push(`total assets of ${fmtMoney(cur.assets)}`);
    if (bits.length) out.push(`For the fiscal year ended ${longDate(cur.end)}, its 10-K reported ${listJoin(bits)}.`);
  }
  const a = d.activity;
  if (a?.total) {
    const byForm = (a.byForm || []).filter(({ form }) => !isOfferingNoise(form));
    const rank = (f) => { const i = KEY_FORMS.indexOf(f); return i < 0 ? KEY_FORMS.length : i; };
    const picked = [...byForm].sort((x, y) => rank(x.form) - rank(y.form) || y.n - x.n).slice(0, 4);
    const parts = picked.map(({ form, n }) => `${n.toLocaleString("en-US")} ${formLabel(form, n)}`);
    let s = `In the twelve months to ${longDate(d.asOf || new Date().toISOString().slice(0, 10))} it made ${plural(a.total, "filing")} on EDGAR${parts.length ? `, including ${listJoin(parts)}` : ""}${a.offeringNoise ? `, plus ${a.offeringNoise.toLocaleString("en-US")} prospectus supplements and free writing prospectuses for its securities offerings` : ""}.`;
    const top = (a.eightKItems || []).slice(0, 3).map(({ label, n }) => `${label} (${n})`);
    if (top.length) s += ` Its 8-Ks were filed most often for ${listJoin(top)}.`;
    out.push(s);
  }
  return out;
}

/** Totals over the Form 4 rows a page shows. Value is shares times the price
 *  on each open-market line, the same figures the table prints. */
export function insiderSummary(rows) {
  const rs = Array.isArray(rows) ? rows : [];
  const agg = (code) => {
    const xs = rs.filter((r) => r.code === code);
    return { lines: xs.length, shares: xs.reduce((s, r) => s + (Number(r.shares) || 0), 0), value: xs.reduce((s, r) => s + (Number(r.shares) || 0) * (Number(r.price) || 0), 0) };
  };
  const people = new Map();
  for (const r of rs) { const k = r.insider || "?"; const p = people.get(k) || { insider: k, role: r.role, lines: 0, sold: 0, bought: 0 };
    p.lines++; if (r.code === "S") p.sold += (Number(r.shares) || 0) * (Number(r.price) || 0); if (r.code === "P") p.bought += (Number(r.shares) || 0) * (Number(r.price) || 0); people.set(k, p); }
  const ranked = [...people.values()].sort((a, b) => (b.sold + b.bought) - (a.sold + a.bought) || b.lines - a.lines);
  return { sells: agg("S"), buys: agg("P"), insiders: people.size, top: ranked[0] || null };
}

export function insiderNarrative(name, ticker, data, s) {
  if (!data || !s || !(data.rows || []).length) return [];
  const out = [];
  const flows = [];
  if (s.sells.lines) flows.push(`${plural(s.sells.lines, "open-market sale")} of ${s.sells.shares.toLocaleString("en-US")} shares worth about ${fmtMoney(s.sells.value)}`);
  if (s.buys.lines) flows.push(`${plural(s.buys.lines, "open-market purchase")} of ${s.buys.shares.toLocaleString("en-US")} shares worth about ${fmtMoney(s.buys.value)}`);
  out.push(`Across the ${plural(data.filingsRead, "filing")} read here, ${plural(s.insiders, "insider")} at ${name} (${ticker}) reported ${flows.length ? listJoin(flows) : "no open-market buys or sales, only awards, exercises, tax withholding or other non-market transactions"}.`);
  if (s.top && (s.top.sold || s.top.bought)) {
    out.push(`The largest by value was ${s.top.insider}${s.top.role ? ` (${s.top.role})` : ""}, with ${s.top.sold ? `about ${fmtMoney(s.top.sold)} sold` : ""}${s.top.sold && s.top.bought ? " and " : ""}${s.top.bought ? `about ${fmtMoney(s.top.bought)} bought` : ""} on the open market.`);
  }
  if (data.filingsInWindow > data.filingsRead) out.push(`${plural(data.filingsInWindow, "Form 4 filing")} were made against ${name} in the ${data.windowDays} days to ${longDate(data.endDate)}; the paid report reads all of them.`);
  return out;
}

/** Concentration of the positions a fund page shows, against the whole filing. */
export function fundNarrative(name, data) {
  if (!data?.holdingsAvailable || !(data.holdings || []).length) return [];
  const h = data.holdings;
  const topW = h.reduce((s, x) => s + (Number(x.weight) || 0), 0);
  const out = [`${name}'s largest reported position at ${longDate(data.reportDate)} was ${h[0].issuer} at ${(h[0].weight * 100).toFixed(1)}% of the ${fmtMoney(data.totalValueUsd)} it reported${h[1] ? `, followed by ${h[1].issuer} (${(h[1].weight * 100).toFixed(1)}%)` : ""}.`];
  if (data.totalHoldings > h.length) out.push(`The ${plural(h.length, "largest position")} shown make up ${(topW * 100).toFixed(1)}% of reported value across ${plural(data.totalHoldings, "position")}, so the rest of the portfolio holds ${((1 - topW) * 100).toFixed(1)}%.`);
  return out;
}
