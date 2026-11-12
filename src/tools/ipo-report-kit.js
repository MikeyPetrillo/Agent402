// ipo-report-kit — IPO PIPELINE DIGEST: S-1/F-1 registrations and 424B4 final
// prospectuses filed with the SEC in a window, each filer CLASSIFIED from its
// own submissions index (first-time registrant = IPO; periodic reports on file
// = already public, a follow-on/resale; SIC 6770 = SPAC), optionally filtered by a keyword on the
// filer's name. DETERMINISTIC - built from EDGAR full-text search through the
// existing edgar-recent-ipos tool, no LLM, so it is cheap enough to run weekly
// for every subscriber of the IPO watch monitor and honest by construction
// (nothing is summarized that is not in the filing index). Egress -> WALLET_ONLY.
//
// `probeIpos()` is exported for the monitor scheduler: same data, plus a
// fingerprint of the accession numbers seen.
import { bad } from "./llm-gateway-kit.js";
import { EDGAR_TOOLS, edgarGetJson } from "./edgar-kit.js";
import { neutralizeQuoteMarkers } from "../report-grounding.js";

export const IPO_TIERS = { "ipo-report": { price: "$0.05", maxDays: 90, limit: 200 } };
const MAX_KEYWORD = 60;

let _edgar = null;
function H(slug) {
  const t = (_edgar ||= EDGAR_TOOLS).find((x) => x.slug === slug);
  if (!t) throw bad(`ipo-report: missing dependency '${slug}'`, 500);
  return t.handler;
}
// A filer-written field (name, tickers, exchanges, SIC description) as one
// markdown-inert line in the digest: no quote markers or hidden characters, no
// line break that could open a heading, no link, image or tag syntax (a tag's
// brackets are dropped, a link's escaped, a URL reduced to its host, as a
// source title is). The filings table keeps the values as EDGAR returned them.
const urlHost = (u) => { try { return new URL(u).hostname; } catch { return " "; } };
export function filerText(v) {
  return neutralizeQuoteMarkers(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\b(?:https?|ftp):\/\/[^\s<>()[\]"']+/gi, (u) => urlHost(u.replace(/[.,;:!?]+$/, "")))
    .replace(/[<>]/g, " ").replace(/[[\]`*_\\]/g, (c) => `\\${c}`).replace(/\s{2,}/g, " ").trim();
}
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };

export function normIpoKeyword(input) {
  const k = String(typeof input === "string" ? input : input?.keyword ?? input?.target ?? "").replace(/\s+/g, " ").trim();
  if (!k || /^(all|any|\*)$/i.test(k)) return "";
  if (k.length > MAX_KEYWORD) throw bad(`"keyword" must be at most ${MAX_KEYWORD} characters`);
  if (!/^[\p{L}\p{N} .,'&+/-]+$/u.test(k)) throw bad('"keyword" contains unsupported characters');
  return k;
}

// An S-1 or a 424B4 is not an IPO by itself: measured on one week of EDGAR
// (2026-08), 5 of 9 "priced IPOs" (424B4) and 8 of 10 "new registrations" (S-1)
// were follow-on or resale filings by companies with 10-Ks on file. The filer's
// submissions index (one keyless read, cached) says which: a periodic report
// (10-K/10-Q/20-F/40-F) filed BEFORE this filing means an already-public
// issuer; SIC 6770 is a blank-check company (SPAC).
const PERIODIC_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F", "10-K405", "10-KSB", "10-QSB"]);
const CLASSIFY_CONCURRENCY = 4;
const CLASSIFY_MAX_FILERS = 150;
const CLASSIFY_TTL_MS = 6 * 3600_000;
const classifyCache = new Map(); // cik -> { at, sub }
export function classifyFromSubmissions(sub, filedDate) {
  if (!sub) return { klass: "unclassified", reason: "submissions unreadable" };
  const r = sub.filings?.recent || {};
  const forms = Array.isArray(r.form) ? r.form : [];
  const publicBefore = forms.some((f, i) => PERIODIC_FORMS.has(String(f).toUpperCase()) && String(r.filingDate?.[i] || "") < String(filedDate || "9999"));
  const sic = String(sub.sic || "");
  if (sic === "6770") return { klass: "spac", reason: "SIC 6770 blank check" };
  if (publicBefore) return { klass: "follow-on", reason: "periodic reports on file before this filing" };
  return { klass: "ipo", reason: "no periodic report on file before this filing" };
}
async function readSubmissions(cik) {
  const key = String(cik).padStart(10, "0");
  const hit = classifyCache.get(key);
  if (hit && Date.now() - hit.at < CLASSIFY_TTL_MS) return hit.sub;
  let sub = null;
  try { sub = await edgarGetJson(`https://data.sec.gov/submissions/CIK${key}.json`); } catch { sub = null; }
  if (classifyCache.size > 2000) classifyCache.clear();
  classifyCache.set(key, { at: Date.now(), sub });
  return sub;
}
async function classifyRows(rows) {
  const ciks = [...new Set(rows.map((r) => r.cik).filter(Boolean))].slice(0, CLASSIFY_MAX_FILERS);
  const subs = new Map();
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, ciks.length) }, async () => { while (i < ciks.length) { const c = ciks[i++]; subs.set(c, await readSubmissions(c)); } }));
  for (const r of rows) {
    const sub = subs.has(r.cik) ? subs.get(r.cik) : undefined;
    const c = sub === undefined ? { klass: "unclassified", reason: "filer beyond the classification cap" } : classifyFromSubmissions(sub, r.filedDate);
    r.klass = c.klass; r.klassReason = c.reason;
    if (sub) { r.tickers = Array.isArray(sub.tickers) ? sub.tickers.slice(0, 3) : []; r.exchanges = Array.isArray(sub.exchanges) ? sub.exchanges.filter(Boolean).slice(0, 2) : []; r.sicDescription = sub.sicDescription || ""; r.state = sub.stateOfIncorporation || ""; }
  }
  return rows;
}

/** The three EDGAR legs for the window (S-1 and F-1 registrations, 424B4
 *  final prospectuses), each filer CLASSIFIED from its own submissions index
 *  (ipo / follow-on / spac), filtered by keyword. Returns rows + a fingerprint
 *  of accessions (what the monitor compares). */
export async function probeIpos({ days = 7, keyword = "", limit = 200, classify = true } = {}) {
  const ipos = H("edgar-recent-ipos");
  const [s1, f1, priced] = await Promise.all([
    ipos({ days, form: "S-1", limit }),
    ipos({ days, form: "F-1", limit }),
    ipos({ days, form: "424B4", limit }),
  ]);
  const kw = keyword ? keyword.toLowerCase() : "";
  const norm = (f, stage) => ({
    stage, form: f.form || "", filedDate: f.filedDate || "", cik: f.cik || "", accessionNumber: f.accessionNumber || "",
    name: Array.isArray(f.displayNames) && f.displayNames.length ? String(f.displayNames[0]).replace(/\s*\(CIK[^)]*\)\s*$/i, "") : "",
    url: f.url || "", klass: "unclassified", klassReason: "not classified",
  });
  let rows = [
    ...((s1?.filings || []).map((f) => norm(f, "registration"))),
    ...((f1?.filings || []).map((f) => norm(f, "registration"))),
    ...((priced?.filings || []).map((f) => norm(f, "priced"))),
  ].filter((r) => !kw || r.name.toLowerCase().includes(kw));
  if (classify) rows = await classifyRows(rows);
  rows.sort((a, b) => b.filedDate.localeCompare(a.filedDate) || a.name.localeCompare(b.name));
  const ids = [...new Set(rows.map((r) => r.accessionNumber).filter(Boolean))].sort();
  return { days, keyword, startDate: s1?.startDate || null, endDate: s1?.endDate || null, totalS1: s1?.total ?? null, totalF1: f1?.total ?? null, totalPriced: priced?.total ?? null, returnedS1: s1?.returned ?? null, returnedF1: f1?.returned ?? null, returnedPriced: priced?.returned ?? null, rows, ids, fingerprint: JSON.stringify(ids) };
}

// `deps` is the test seam for the EDGAR reads (probeIpos).
function makeIpoHandler(tierSlug) {
  const t = IPO_TIERS[tierSlug];
  return async (input, req, deps = {}) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"days": 7, "keyword": ""}');
    const days = clampInt(input.days, 7, 1, t.maxDays);
    const keyword = normIpoKeyword(input);
    const pr = await (deps?.probeIpos || probeIpos)({ days, keyword, limit: t.limit });
    const reg = pr.rows.filter((r) => r.stage === "registration");
    const priced = pr.rows.filter((r) => r.stage === "priced");
    const by = (xs, k) => xs.filter((r) => r.klass === k);
    const tag = (r) => `${r.tickers?.length ? ` · ${filerText(r.tickers.join("/"))}` : ""}${r.exchanges?.length ? ` (${filerText(r.exchanges.join(", "))})` : ""}${r.sicDescription ? ` · ${filerText(r.sicDescription)}` : ""}`;
    const line = (r) => `- **${filerText(r.name) || "(unnamed filer)"}**${tag(r)} · ${r.form} filed ${r.filedDate} · CIK ${r.cik} · [filing](${r.url})`;
    const scope = keyword ? ` matching "${keyword}"` : "";
    const cov = (ret, tot) => (tot != null && ret != null && ret < tot ? `${ret} of ${tot}` : String(tot ?? ret ?? "?"));
    const section = (title, xs, empty) => [`## ${title}`, xs.length ? xs.map(line).join("\n") : `_${empty}_`, ``];
    const unclassified = pr.rows.filter((r) => r.klass === "unclassified");
    const report = [
      `# IPO Pipeline Digest${scope}: ${pr.startDate || "?"} to ${pr.endDate || "?"}`,
      ``,
      `**${by(priced, "ipo").length} IPO${by(priced, "ipo").length === 1 ? "" : "s"} priced** (424B4 by a first-time registrant), **${by(reg, "ipo").length} new IPO registration${by(reg, "ipo").length === 1 ? "" : "s"}** (S-1/F-1 by a first-time registrant) and **${by(reg, "spac").length} SPAC registration${by(reg, "spac").length === 1 ? "" : "s"}** in the last ${days} day${days === 1 ? "" : "s"}${keyword ? `, filtered to filers whose name contains "${keyword}"` : ""}. Filings read: S-1 ${cov(pr.returnedS1, pr.totalS1)}, F-1 ${cov(pr.returnedF1, pr.totalF1)}, 424B4 ${cov(pr.returnedPriced, pr.totalPriced)} in the window${(pr.totalS1 > (pr.returnedS1 ?? 0) || pr.totalF1 > (pr.returnedF1 ?? 0) || pr.totalPriced > (pr.returnedPriced ?? 0)) ? " (EDGAR full-text search pages 100 at a time; older filings in the window beyond the read limit are not listed)" : ""}. Each filer is classified from its own EDGAR submissions index: a periodic report (10-K/10-Q/20-F) on file before the filing marks an already-public issuer (follow-on or resale registration, not an IPO); SIC 6770 marks a blank-check company. Counts are filings, not companies (amendments and multiple filers per deal are not collapsed).`,
      ``,
      ...section("IPOs that priced (424B4, first-time registrants)", by(priced, "ipo"), `No IPO priced${scope} in the window.`),
      ...section("New IPO registrations (S-1 / F-1, first-time registrants)", by(reg, "ipo"), `No first-time S-1/F-1 registrations${scope} in the window.`),
      ...section("SPAC registrations and pricings (SIC 6770)", [...by(reg, "spac"), ...by(priced, "spac")], `No blank-check filings${scope} in the window.`),
      ...section("Already-public issuers: priced follow-on / secondary offerings (424B4)", by(priced, "follow-on"), `None${scope} in the window.`),
      ...section("Already-public issuers: resale / secondary registrations (S-1 / F-1)", by(reg, "follow-on"), `None${scope} in the window.`),
      ...(unclassified.length ? section("Not classified (filer's submissions index could not be read or was beyond the read cap)", unclassified, "") : []),
      `## Sources`,
      `[1] SEC EDGAR full-text search, form S-1, ${pr.startDate || "?"} to ${pr.endDate || "?"} - https://efts.sec.gov/LATEST/search-index?q=&forms=S-1`,
      `[2] SEC EDGAR full-text search, form F-1, ${pr.startDate || "?"} to ${pr.endDate || "?"} - https://efts.sec.gov/LATEST/search-index?q=&forms=F-1`,
      `[3] SEC EDGAR full-text search, form 424B4, ${pr.startDate || "?"} to ${pr.endDate || "?"} - https://efts.sec.gov/LATEST/search-index?q=&forms=424B4`,
      `[4] SEC EDGAR company submissions index (per filer) - https://data.sec.gov/submissions/`,
    ].join("\n");
    const tables = [{
      name: "filings", label: "IPO filings",
      columns: ["Stage", "Class", "Form", "Filed", "Filer", "Tickers", "Exchanges", "SIC", "State", "CIK", "Accession", "URL"],
      rows: pr.rows.map((r) => [r.stage, r.klass, r.form, r.filedDate, r.name, (r.tickers || []).join("/"), (r.exchanges || []).join(", "), r.sicDescription || "", r.state || "", r.cik, r.accessionNumber, r.url]),
    }];
    const sources = [
      { n: 1, title: `SEC EDGAR full-text search, form S-1, ${pr.startDate || "?"} to ${pr.endDate || "?"}`, url: "https://efts.sec.gov/LATEST/search-index?q=&forms=S-1" },
      { n: 2, title: `SEC EDGAR full-text search, form F-1, ${pr.startDate || "?"} to ${pr.endDate || "?"}`, url: "https://efts.sec.gov/LATEST/search-index?q=&forms=F-1" },
      { n: 3, title: `SEC EDGAR full-text search, form 424B4, ${pr.startDate || "?"} to ${pr.endDate || "?"}`, url: "https://efts.sec.gov/LATEST/search-index?q=&forms=424B4" },
      { n: 4, title: "SEC EDGAR company submissions index (per filer)", url: "https://data.sec.gov/submissions/" },
    ];
    const meta = { tier: tierSlug, days, keyword: keyword || null, start: pr.startDate, end: pr.endDate, priced: priced.length, registrations: reg.length,
      ipos_priced: by(priced, "ipo").length, ipo_registrations: by(reg, "ipo").length, spac_filings: by(reg, "spac").length + by(priced, "spac").length, follow_on_filings: by(priced, "follow-on").length + by(reg, "follow-on").length, unclassified: unclassified.length,
      total_s1_in_window: pr.totalS1, total_f1_in_window: pr.totalF1, total_424b4_in_window: pr.totalPriced, read_s1: pr.returnedS1, read_f1: pr.returnedF1, read_424b4: pr.returnedPriced, deterministic: true };
    return { report, title: `IPO pipeline${scope}`, sources, tables, meta };
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    days: { type: "number", description: "Lookback window in days, 1-90 (default 7)." },
    keyword: { type: "string", description: "Optional filter on the filer's name (case-insensitive). Omit or \"all\" for every filing." },
  },
};
const OUT_EXAMPLE = {
  report: "# IPO Pipeline Digest: 2025-11-11 to 2025-11-18\n\n**2 priced IPOs** (424B4 final prospectus) and **9 new registrations** (S-1) in the last 7 days...\n\n## Priced IPOs (424B4)\n- **Example Newco Inc.** · 424B4 filed 2025-11-17 · CIK 0001999888 · [filing](https://www.sec.gov/Archives/...)\n\n## Sources\n[1] ...",
  title: "IPO pipeline",
  sources: [{ n: 1, title: "SEC EDGAR full-text search, form S-1, 2025-11-11 to 2025-11-18", url: "https://efts.sec.gov/LATEST/search-index?q=&forms=S-1" }],
  tables: [{ name: "filings", label: "IPO filings", columns: ["Stage", "Form", "Filed", "Filer", "CIK", "Accession", "URL"], rows: [["priced", "424B4", "2025-11-17", "Example Newco Inc.", "0001999888", "0001213900-25-099999", "https://www.sec.gov/Archives/..."]] }],
  meta: { tier: "ipo-report", days: 7, keyword: null, priced: 2, registrations: 9, deterministic: true },
};

export const IPO_TOOLS = [
  {
    route: "POST /v1/ipo-report", name: "IPO pipeline digest (S-1 + 424B4)", slug: "ipo-report", category: "data", price: IPO_TIERS["ipo-report"].price,
    description: "A deterministic digest of the IPO pipeline for a window: every 424B4 final prospectus and every S-1/F-1 registration from SEC EDGAR, each filer classified from its own submissions index as a first-time registrant (an IPO), an already-public issuer (follow-on or resale, not an IPO) or a SPAC, optionally filtered by a keyword on the filer's name, with tickers/exchanges where listed and a downloadable filings table. No LLM, no guessing - filing facts only. Default last 7 days.",
    tags: ["ipo", "sec", "edgar", "s-1", "424b4", "new-listings", "digest", "report", "agentic-finance", "x402", "mpp"],
    discovery: { bodyType: "json", input: { days: 7 }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeIpoHandler("ipo-report"),
  },
];
