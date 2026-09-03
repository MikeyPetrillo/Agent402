// ticker-pack-kit — TICKER PACK. One ticker, one purchase, the full picture.
//
// The bundle around the dossier: for a single US ticker it runs the EXISTING
// composites in-process (no pipeline is duplicated) and stitches ONE report:
//   1. company dossier      -> src/tools/dossier-kit.js  (makeDossierHandler)
//   2. insider flow, 90 d   -> src/tools/insider-flow-kit.js (makeInsiderHandler)
//   3. institutional holders-> NEW here, deterministic, EDGAR only (below)
// plus a deterministic digest of the company's own recent filings, and ONE
// short synthesis pass that writes the connective tissue (executive summary +
// "what to check next") from FETCHED FACTS ONLY.
//
// WHY THREE SYNTHESIS PASSES AND NOT ONE. The brief prefers a single combined
// synthesis. The two part handlers do not expose a data-only mode and take no
// depth knobs (dossier: {ticker, focus, format}; insider: {ticker, cik, days}),
// and the instruction is to CALL them rather than re-implement their pipelines,
// so their own synthesis rides along. The bundle therefore reuses both parts'
// synthesis and adds ONE small pass of its own. Upstream arithmetic:
//     dossier   cap $0.50   (DOSSIER_TIERS["dossier"].maxUpstreamUsd)
//   + insider   cap $0.35   (INSIDER_TIERS["insider-report"].maxUpstreamUsd)
//   + holders   $0.00       (SEC EDGAR only: 1 full-text query + N XML reads)
//   + filings   $0.00       (SEC EDGAR submissions JSON, 1 read)
//   + pack pass cap $0.35   (PACK_SYNTH_MAX_UPSTREAM_USD, 1,800 output tokens)
//   = $1.20 worst case against a $2.00 price = 60%. Every part cap is the
//     MEASURED opus-5 worst case (max $0.311 over 30 days of $ai_generation),
//     because three syntheses is where an optimistic cap compounds fastest.
//
// HOLDERS: "which institutional managers hold this ticker" IS cheaply possible
// from EDGAR full-text search - efts.sec.gov indexes the 13F-HR INFORMATION
// TABLE attachments themselves (verified live: a phrase query on the issuer
// name, and on the CUSIP, returns 13F-HR information tables). So the leg is
// one full-text query for the issuer name over 13F-HR filings in the last ~150
// days, then a bounded, STREAMING scan of each matching manager's information
// table that keeps only the rows for this issuer. It is a SAMPLE, not a
// complete holder list (full-text search caps its result window), and the
// report says so in those words.
//
// Discipline, same as the other report products: grounding-strict (every claim
// traces to fetched data), settlement-safe (any failure throws >= 400 so the
// buyer is not charged), thin-evidence refusal BEFORE any expensive spend,
// upstream cost read internally and never returned, WALLET_ONLY,
// composite-guarded, not cached. 503 without OPENROUTER_API_KEY.
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { resolveCompany, eftsSearch, edgarGetJson, parse13fInformationTable, fetchXmlText } from "./edgar-kit.js";
import { makeDossierHandler, DOSSIER_TIERS } from "./dossier-kit.js";
import { makeInsiderHandler, INSIDER_TIERS, probeInsiderFilings } from "./insider-flow-kit.js";

const SYNTH = "anthropic/claude-opus-5";
// Exported so the live-catalog guard can check the id is still upstream.
export const TICKER_PACK_MODELS = [SYNTH];

// The bundle's own synthesis budget. Small on purpose: it writes the executive
// summary and the check-next list, not the report.
const PACK_SYNTH_MAX_UPSTREAM_USD = 0.35;
const round2 = (n) => Number(n.toFixed(2));

export const TICKER_PACK_TIERS = {
  "ticker-pack": {
    price: "$2.00",
    // Derived, never hand-typed: if a part's cap moves, this moves with it and
    // scripts/test-ticker-pack-kit.js fails the <= $5.50 bound.
    maxUpstreamUsd: round2(
      DOSSIER_TIERS["dossier"].maxUpstreamUsd +
      INSIDER_TIERS["insider-report"].maxUpstreamUsd +
      PACK_SYNTH_MAX_UPSTREAM_USD,
    ),
    partCaps: {
      dossier: DOSSIER_TIERS["dossier"].maxUpstreamUsd,
      insider: INSIDER_TIERS["insider-report"].maxUpstreamUsd,
      holders: 0,
      filings: 0,
      pack: PACK_SYNTH_MAX_UPSTREAM_USD,
    },
    insiderDays: 90,
    holderFilings: 12,      // information tables scanned per run
    holderWindowDays: 150,  // covers the latest 13F deadline plus the prior one
    filingsShown: 24,
    synthMaxTokens: 1800,
    words: "~600",
  },
};

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
// Budget: probes 30 s + parts 190 s + pack synthesis 45 s = 265 s worst case,
// inside the 300 s ceiling a long-running x402 EVM authorization allows. The
// hard deadline below skips the pack synthesis rather than overrun it.
const PROBE_TIMEOUT_MS = 30_000;
const PART_TIMEOUT_MS = 150_000;
const SYNTH_TIMEOUT_MS = 45_000;
const XML_TIMEOUT_MS = 20_000;
// The x402 clock starts when the BUYER SIGNS, not when this handler starts, so
// the 300 s ceiling has to cover transit and the settle broadcast too. A run
// also cannot outlive a redeploy: the drain deadline is 75 s, and every second
// past it is upstream we paid for and never charged. Kept as tight as the parts
// allow; the synthesis is skipped (deterministic fallback) rather than overrun.
const RUN_DEADLINE_MS = 230_000;
const HOLDER_CONCURRENCY = 4;
// A single <infoTable> block is a few hundred bytes; the scan is STREAMING and
// keeps only matching blocks, so this bounds the read, never the memory. The
// largest tables seen live are ~11 MB.
const HOLDER_MAX_BYTES = 16_000_000;
// Cumulative across every information table in one run. Per-file caps alone let
// a mega-cap ticker (the caller picks it) pull hundreds of MB of egress for one
// $15 call; this is the bound that actually holds.
const HOLDER_RUN_MAX_BYTES = 96_000_000;

const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const clampInt = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d; };
function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }
function edgarUserAgent() { return (process.env.EDGAR_USER_AGENT || "").trim() || "Agent402 mike@agent402.tools"; }

async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();

/** A leg's failure reason as the BUYER sees it: our own words plus, at most, a
 *  short markup-free excerpt. An upstream body is never relayed verbatim into
 *  the report, the 4xx/5xx message, or `evidence`. */
export function buyerReason(e) {
  // As soon as markup appears the rest is an upstream body, not our sentence:
  // drop from the first tag to the end rather than trying to launder it.
  let s = String(e?.message ?? e ?? "unknown error").replace(/<[^>]*>[\s\S]*$/, "");
  s = s.replace(/\s+/g, " ").replace(/[\s:;,.-]+$/, "").trim().slice(0, 160);
  return s || "upstream error (details withheld)";
}

/** Never throw from a leg: {ok:true,data} | {ok:false,error}. A failed leg is
 *  NAMED as failed everywhere downstream and never silently zeroed. */
async function settle(promiseFactory, timeoutMs, label) {
  let timer = null;
  try {
    const p = Promise.resolve().then(promiseFactory);
    const data = timeoutMs
      ? await Promise.race([p, new Promise((_, r) => { timer = setTimeout(() => r(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); })])
      : await p;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: buyerReason(e) };
  } finally { if (timer) clearTimeout(timer); }
}

const fmtUsd = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
};
const nf = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "?");

// ---------------------------------------------------------------------------
// Institutional holders (13F information tables) - deterministic, EDGAR only.
// ---------------------------------------------------------------------------

/** Normalize an issuer name for equality matching between EDGAR's registrant
 *  name ("Apple Inc.") and the free-text name a manager types into its 13F
 *  information table ("APPLE INC"). Suffix noise only; nothing is inferred. */
export function normIssuerName(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|HOLDINGS|HOLDING|GROUP|CLASS|COM|THE|NEW|SA|NV|AG)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const XML_NAME_RE = /<(?:[A-Za-z0-9_]+:)?nameOfIssuer>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?nameOfIssuer>/i;
const XML_CUSIP_RE = /<(?:[A-Za-z0-9_]+:)?cusip>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?cusip>/i;
const XML_BLOCK_RE = /<(?:[A-Za-z0-9_]+:)?infoTable>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?infoTable>/i;

/** Only ever an EDGAR archive path we assembled ourselves. The accession and
 *  the attachment filename come from the full-text index, so they are checked
 *  against a strict shape (no slashes, no traversal) before a URL is built. */
export function infoTableUrl(cik, accession, filename) {
  const acc = String(accession || "");
  const file = String(filename || "");
  if (!/^\d{10}-\d{2}-\d{6}$/.test(acc)) return null;
  if (!/^[A-Za-z0-9._-]+\.xml$/i.test(file) || file.includes("..")) return null;
  const cikInt = parseInt(String(cik || ""), 10);
  if (!Number.isFinite(cikInt) || cikInt <= 0) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc.replace(/-/g, "")}/${file}`;
}

/** Stream a 13F information table and keep ONLY the <infoTable> blocks for this
 *  issuer. Memory is bounded by the block size, not the file size, so the
 *  largest filers (whose tables run to tens of megabytes, and who are exactly
 *  the managers most likely to hold a large-cap) are read, not skipped. */
export async function scanInfoTableForIssuer(url, state, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const reportDate = opts.reportDate;
  const maxBytes = opts.maxBytes || HOLDER_MAX_BYTES;
  const res = await fetchImpl(url, {
    headers: { "User-Agent": edgarUserAgent(), Accept: "application/xml,text/xml,*/*" },
    signal: AbortSignal.timeout(opts.timeoutMs || XML_TIMEOUT_MS),
  });
  if (!res || !res.ok) throw new Error(`EDGAR XML HTTP ${res ? res.status : "no-response"}`);
  const dec = new TextDecoder("utf-8");
  let buf = "", bytes = 0, totalRows = 0, truncated = false;
  const kept = [];
  const drain = () => {
    for (;;) {
      const m = buf.match(XML_BLOCK_RE);
      if (!m) break;
      totalRows++;
      const block = m[1];
      const name = (block.match(XML_NAME_RE)?.[1] || "").trim();
      const cusip = (block.match(XML_CUSIP_RE)?.[1] || "").trim().toUpperCase();
      const nameHit = normIssuerName(name) === state.want && state.want.length > 0;
      const cusipHit = state.cusip6 ? cusip.slice(0, 6) === state.cusip6 : false;
      if (nameHit || cusipHit) {
        if (nameHit && !state.cusip6 && cusip.length >= 6) state.cusip6 = cusip.slice(0, 6);
        kept.push(m[0]);
      }
      buf = buf.slice(m.index + m[0].length);
    }
    // Nothing matched in a long stretch: keep only a tail large enough that no
    // single block can be split across the trim.
    if (buf.length > 400_000) buf = buf.slice(-100_000);
  };
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength ?? value.length ?? 0;
      if (bytes > maxBytes) { truncated = true; try { await reader.cancel(); } catch { /* already closed */ } break; }
      buf += dec.decode(value, { stream: true });
      drain();
    }
  } else {
    // Test/stub seam: a body-less response object exposing text().
    buf += String(await res.text());
    bytes = buf.length;
  }
  buf += dec.decode();
  drain();
  return { rows: kept.length ? parse13fInformationTable(kept.join("\n"), reportDate) : [], totalRows, bytes, truncated };
}

/** Fold one manager's rows for this issuer into a position summary.
 *
 *  A 13F row's sshPrnamt is SHARES only when sshPrnamtType is "SH". "PRN" is a
 *  PRINCIPAL amount - the issuer's bonds carry the same CUSIP prefix - so those
 *  rows are counted separately and NEVER summed into a share count. Option
 *  rows (putCall set) are separated for the same reason.
 *
 *  `impliedPriceUsd` exists because the value field is not comparable across
 *  filers: the SEC moved 13F values to whole dollars for filings submitted from
 *  2023-01-03 and a minority of filers still report thousands (measured live on
 *  a 2026 filing). Shares are unambiguous; the implied price makes a
 *  thousands-reporting filer visible instead of quietly wrong. */
export function summarizeIssuerRows(rows) {
  const mine = rows || [];
  const isPrincipal = (r) => String(r?.sharesOrPrincipalAmountType || "").toUpperCase() === "PRN";
  const shareRows = mine.filter((r) => !r.putCall && !isPrincipal(r));
  const optionRows = mine.filter((r) => r.putCall);
  const principalRows = mine.filter((r) => !r.putCall && isPrincipal(r));
  const shares = shareRows.reduce((a, r) => a + (Number(r.shares) || 0), 0);
  const valueUsd = shareRows.reduce((a, r) => a + (Number(r.valueUsd) || 0), 0);
  return {
    shares,
    valueUsd,
    impliedPriceUsd: shares > 0 ? valueUsd / shares : null,
    optionRows: optionRows.length,
    optionShares: optionRows.reduce((a, r) => a + (Number(r.shares) || 0), 0),
    principalRows: principalRows.length,
    rows: mine.length,
    classes: [...new Set(mine.map((r) => r.titleOfClass).filter(Boolean))].slice(0, 4),
  };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** WHICH institutional managers report holding this ticker. One EDGAR
 *  full-text query over 13F-HR filings in the window, then a bounded scan of
 *  each manager's most recent information table in the result set.
 *
 *  This is a SAMPLE by construction: EDGAR full-text search returns a bounded
 *  result window (and reports "at least 10,000" for a mega-cap), so the leg
 *  reports what it read and never claims completeness. */
export async function probeHolders({ ticker, cik, name, maxFilings = 12, windowDays = 150, concurrency = HOLDER_CONCURRENCY, fetchImpl } = {}) {
  const issuerName = String(name || "").trim();
  if (!issuerName) throw bad("probeHolders needs the issuer's registered name", 500);
  const enddt = isoDate(Date.now());
  const startdt = isoDate(Date.now() - windowDays * 86400 * 1000);
  const j = await eftsSearch({ q: `"${issuerName}"`, forms: "13F-HR", startdt, enddt });
  const hits = j?.hits?.hits ?? [];
  // One row per FILER, keeping that filer's most recent reporting period.
  const byFiler = new Map();
  for (const h of hits) {
    const s = h?._source || {};
    const filerCik = (s.ciks || [])[0];
    const [acc, file] = String(h?._id || "").split(":");
    const url = infoTableUrl(filerCik, acc, file);
    if (!url) continue;
    const row = {
      cik: String(filerCik).padStart(10, "0"),
      manager: String((s.display_names || [])[0] || "").replace(/\s*\(CIK[^)]*\)\s*$/i, "").trim(),
      period: String(s.period_ending || ""),
      filed: String(s.file_date || ""),
      accession: acc,
      url,
    };
    const cur = byFiler.get(row.cik);
    if (!cur || row.period > cur.period) byFiler.set(row.cik, row);
  }
  const candidates = [...byFiler.values()].slice(0, maxFilings);
  const state = { want: normIssuerName(issuerName), cusip6: null };
  // Run-wide egress budget: the caller picks the ticker, and a mega-cap has both
  // more filers and bigger tables. Once the budget is spent the remaining
  // candidates are reported as skipped rather than silently dropped.
  let runBytes = 0;
  const scanned = await mapLimit(candidates, concurrency, async (c) => {
    if (runBytes >= HOLDER_RUN_MAX_BYTES) return { ...c, skipped: "run byte budget reached" };
    try {
      const r = await scanInfoTableForIssuer(c.url, state, { fetchImpl, reportDate: c.filed, maxBytes: Math.min(HOLDER_MAX_BYTES, HOLDER_RUN_MAX_BYTES - runBytes) });
      runBytes += r.bytes || 0;
      return { ...c, ...r };
    } catch (e) { return { ...c, error: String(e?.message || e).slice(0, 160) }; }
  });

  // Consistency filter: keep only rows on the MODAL CUSIP issuer prefix, so a
  // name collision in one filer's free-text issuer field cannot contaminate the
  // table. Nothing is inferred - the prefix is read from the filings.
  const prefixCount = new Map();
  for (const s of scanned) for (const r of (s.rows || [])) {
    const p = String(r.cusip || "").toUpperCase().slice(0, 6);
    if (p.length === 6) prefixCount.set(p, (prefixCount.get(p) || 0) + 1);
  }
  const modal = [...prefixCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const managers = [];
  let failed = 0;
  for (const s of scanned) {
    if (s.skipped) { failed++; managers.push({ manager: s.manager, cik: s.cik, period: s.period, filed: s.filed, url: s.url, error: s.skipped }); continue; }
    if (s.error) { failed++; managers.push({ manager: s.manager, cik: s.cik, period: s.period, filed: s.filed, url: s.url, error: s.error }); continue; }
    const mine = (s.rows || []).filter((r) => !modal || String(r.cusip || "").toUpperCase().slice(0, 6) === modal);
    if (!mine.length) continue;
    managers.push({
      manager: s.manager, cik: s.cik, period: s.period, filed: s.filed, url: s.url,
      ...summarizeIssuerRows(mine),
      totalPositions: s.totalRows,
      truncated: !!s.truncated,
    });
  }
  const withData = managers.filter((m) => !m.error);
  // Ranked by SHARES: the share count is unambiguous across filers, the value
  // field is not (see impliedPriceUsd above).
  withData.sort((a, b) => (b.shares || 0) - (a.shares || 0));
  const total = j?.hits?.total || {};
  return {
    query: `"${issuerName}"`,
    ticker: ticker || null,
    issuerCik: cik || null,
    startDate: startdt,
    endDate: enddt,
    matchingFilings: Number(total.value) || 0,
    matchingRelation: String(total.relation || "eq"),
    cusipPrefix: modal,
    candidates: candidates.length,
    scanned: scanned.length,
    failedScans: failed,
    managers: withData,
    failures: managers.filter((m) => m.error),
    searchUrl: `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${issuerName}"`)}&forms=13F-HR&dateRange=custom&startdt=${startdt}&enddt=${enddt}`,
  };
}

// ---------------------------------------------------------------------------
// 5%+ holders as DISCLOSED on Schedule 13G / 13D (the issuer's own filings
// index, one EDGAR full-text query + <= 10 small XML reads). The 13F leg below
// is a relevance-ranked SAMPLE of managers (for INTC: twelve small managers
// and none of Vanguard/BlackRock); the 13G is where the largest holders are
// required to disclose, and since Dec 2024 it is structured XML
// (primary_doc.xml; form type "SCHEDULE 13G", not the legacy "SC 13G").
// A row with 0 shares / 0% is a filer reporting that it FELL BELOW 5% - a
// disclosed fact, shown as such (Vanguard on INTC, event 2026-03-13).
// ---------------------------------------------------------------------------
const THIRTEEN_G_FORMS = "SCHEDULE 13G,SCHEDULE 13G/A,SCHEDULE 13D,SCHEDULE 13D/A,SC 13G,SC 13G/A,SC 13D,SC 13D/A";
export function parse13GCover(xml) {
  const t = (n) => { const m = String(xml || "").match(new RegExp(`<${n}>([^<]*)</${n}>`)); return m ? m[1].trim() : ""; };
  const num = (v) => { const n = Number(String(v).replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : null; };
  return {
    filer: t("reportingPersonName") || t("filingPersonName") || null,
    shares: num(t("reportingPersonBeneficiallyOwnedAggregateNumberOfShares") ?? t("aggregateAmountBeneficiallyOwned")),
    percent: num(t("classPercent") || t("percentOfClass")),
    eventDate: t("eventDateRequiresFilingThisStatement") || t("dateOfEvent") || null,
    securityClass: t("securitiesClassTitle") || null,
    form: t("submissionType") || null,
    personType: t("typeOfReportingPerson") || t("typeOfPersonFiling") || null,
    rule: t("designateRulePursuantThisScheduleFiled") || null,
    issuerCusip: t("issuerCusipNumber") || null,
    issuerCik: (t("issuerCik") || "").padStart(10, "0") || null,
  };
}
export async function probe13G({ cik, windowDays = 400, maxFilers = 10, fetchText = fetchXmlText } = {}) {
  const issuer = String(cik || "").padStart(10, "0");
  const enddt = isoDate(Date.now()), startdt = isoDate(Date.now() - windowDays * 86400 * 1000);
  const j = await eftsSearch({ forms: THIRTEEN_G_FORMS, ciks: issuer, startdt, enddt });
  const hits = j?.hits?.hits ?? [];
  const byFiler = new Map();
  for (const h of hits) {
    const s = h?._source || {};
    const filerCik = (s.ciks || []).map((c) => String(c).padStart(10, "0")).find((c) => c !== issuer) || null;
    if (!filerCik) continue;
    const [acc, doc] = String(h?._id || "").split(":");
    const row = { filerCik, acc, doc: String(doc || ""), filed: String(s.file_date || ""), form: String(s.form || ""), name: String((s.display_names || []).find((n) => String(n).includes(filerCik)) || (s.display_names || [])[1] || "").replace(/\s*\(CIK[^)]*\)\s*$/i, "").trim() };
    const cur = byFiler.get(filerCik);
    if (!cur || row.filed > cur.filed) byFiler.set(filerCik, row);
  }
  const filers = [...byFiler.values()].sort((a, b) => b.filed.localeCompare(a.filed)).slice(0, maxFilers);
  const rows = await mapLimit(filers, 3, async (f) => {
    const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(f.filerCik, 10)}/${String(f.acc).replace(/-/g, "")}/${f.doc}`;
    const base = { filerCik: f.filerCik, filer: f.name || `CIK ${f.filerCik}`, form: f.form, filed: f.filed, accession: f.acc, url, parsed: false };
    if (!/primary_doc\.xml$/i.test(f.doc)) return { ...base, note: "legacy HTML schedule - not parsed; read the filing" };
    try {
      const c = parse13GCover(await fetchText(url));
      // EFTS `ciks=` matches ANY CIK on the filing: the issuer's own 13G on a
      // company it holds (Intel on Mobileye) comes back too. The cover names
      // the issuer; a mismatch is dropped.
      if (c.issuerCik && c.issuerCik !== issuer) return null;
      return { ...base, parsed: true, filer: c.filer || base.filer, shares: c.shares, percent: c.percent, eventDate: c.eventDate, securityClass: c.securityClass, personType: c.personType, rule: c.rule, belowThreshold: c.shares === 0 || c.percent === 0 };
    } catch (e) { return { ...base, note: `not readable (${String(e?.message || e).slice(0, 80)})` }; }
  });
  return { cik: issuer, startDate: startdt, endDate: enddt, matching: j?.hits?.total?.value ?? hits.length, filers: rows.filter(Boolean), searchUrl: `https://efts.sec.gov/LATEST/search-index?q=&forms=${encodeURIComponent(THIRTEEN_G_FORMS)}&ciks=${issuer}` };
}

// ---------------------------------------------------------------------------
// The company's own recent filings (deterministic digest, one EDGAR read).
// ---------------------------------------------------------------------------
export async function probeCompanyFilings({ cik, limit = 24 }) {
  const sub = await edgarGetJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = sub?.filings?.recent;
  if (!r || !Array.isArray(r.form)) return { cik, name: sub?.name || null, filings: [] };
  const cikInt = parseInt(String(cik), 10);
  const filings = [];
  for (let i = 0; i < r.form.length && filings.length < limit; i++) {
    const acc = String(r.accessionNumber?.[i] || "");
    const doc = String(r.primaryDocument?.[i] || "");
    filings.push({
      form: String(r.form[i] || ""),
      filed: String(r.filingDate?.[i] || ""),
      period: String(r.reportDate?.[i] || ""),
      description: String(r.primaryDocDescription?.[i] || "").slice(0, 120),
      // 8-K item codes ("2.02,9.01") ride in the same JSON; without them an
      // earnings 8-K reads as "8-K filed <date>" and nothing more.
      items: String(r.items?.[i] || ""),
      accession: acc,
      url: acc && doc ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc.replace(/-/g, "")}/${doc}` : "",
    });
  }
  return {
    cik,
    name: sub?.name || null,
    sic: sub?.sicDescription || null,
    exchanges: Array.isArray(sub?.exchanges) ? sub.exchanges.slice(0, 4) : [],
    tickers: Array.isArray(sub?.tickers) ? sub.tickers.slice(0, 6) : [],
    stateOfIncorporation: sub?.stateOfIncorporation || null,
    fiscalYearEnd: sub?.fiscalYearEnd || null,
    filings,
    browseUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`,
  };
}

// ---------------------------------------------------------------------------
// Stitching helpers (pure, so the merge is unit-testable).
// ---------------------------------------------------------------------------

/** Drop a sub-report's own appended "## Sources" block: the pack appends ONE
 *  merged, renumbered list. */
export function stripSourcesSection(md) {
  const s = String(md || "");
  const i = s.lastIndexOf("\n## Sources\n");
  return (i >= 0 ? s.slice(0, i) : s).trimEnd();
}

/** Push every heading down by `by` levels so a sub-report nests under the
 *  pack's own section heading. */
export function demoteHeadings(md, by = 2) {
  return String(md || "").replace(/^(#{1,5})\s+/gm, (_m, h) => `${"#".repeat(Math.min(6, h.length + by))} `);
}

/** Merge several parts' numbered source lists into one, deduping by URL, and
 *  return a per-part old-n -> global-n map. */
export function mergeSources(parts) {
  const byUrl = new Map();
  const merged = [];
  const maps = parts.map((p) => {
    const m = new Map();
    for (const s of (p?.sources || [])) {
      const url = String(s?.url || "");
      if (!url) continue;
      let n = byUrl.get(url);
      if (!n) { n = merged.length + 1; merged.push({ n, title: String(s.title || url).slice(0, 240), url }); byUrl.set(url, n); }
      m.set(Number(s.n), n);
    }
    return m;
  });
  return { merged, maps };
}

/** Rewrite [n] citations to the merged numbering. A citation with no mapping
 *  is REMOVED rather than left pointing at someone else's source. */
export function remapCitations(md, map) {
  return String(md || "").replace(/\[(\d{1,3})\](?!\()/g, (full, d) => {
    const t = map.get(Number(d));
    return t ? `[${t}]` : "";
  });
}

/** strip sources -> remap citations -> demote headings, in that order. */
export function foldSubReport(md, map, demoteBy = 2) {
  return demoteHeadings(remapCitations(stripSourcesSection(md), map), demoteBy).trim();
}

const DISCLAIMER = "SEC EDGAR data as filed, plus cited web research. This is information, not investment advice, and not a recommendation to buy or sell any security.";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function defaultDeps() {
  return {
    resolveCompany,
    probeCompanyFilings,
    probeInsiderFilings,
    probeHolders,
    probe13G,
    runDossier: makeDossierHandler("dossier"),
    runInsider: makeInsiderHandler("insider-report"),
    synthesize: async (body, timeoutMs, user) => chat(body, timeoutMs, user),
    now: () => Date.now(),
  };
}

function makeTickerPackHandlerInner(tierSlug, depsIn) {
  const t = TICKER_PACK_TIERS[tierSlug];
  const d = { ...defaultDeps(), ...(depsIn || {}) };
  return async (input, req) => {
    const started = d.now();
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"ticker": "AAPL"}');
    const ticker = String(input.ticker ?? "").trim().toUpperCase();
    if (!ticker) throw bad('"ticker" (US stock ticker, e.g. "AAPL") is required');
    if (!TICKER_RE.test(ticker)) throw bad("ticker must be a short alphanumeric symbol, e.g. AAPL");
    const focus = Array.isArray(input.focus) ? input.focus.filter((x) => typeof x === "string").slice(0, 8) : [];
    const insiderDays = clampInt(input.days, t.insiderDays, 7, 365);
    const user = safeUser(req);

    // 1) RESOLVE. An unknown ticker is a 4xx with zero spend.
    const resolved = await d.resolveCompany({ ticker });
    const companyName = resolved?.name || ticker;
    const cik = resolved?.cik;
    if (!cik) throw bad(`Could not resolve "${ticker}" to a SEC registrant. Not charged.`, 404);

    // 2) CHEAP PROBES FIRST (EDGAR only, no LLM, no upstream spend). These are
    //    the evidence gate: the expensive parts do not run unless at least two
    //    of the three legs have something to report.
    const [filingsP, insiderP, holdersP, g13P] = await Promise.all([
      settle(() => d.probeCompanyFilings({ cik, limit: t.filingsShown }), PROBE_TIMEOUT_MS, "EDGAR filings probe"),
      settle(() => d.probeInsiderFilings({ ticker, days: insiderDays, limit: 40 }), PROBE_TIMEOUT_MS, "Form 4 probe"),
      settle(() => d.probeHolders({ ticker, cik, name: companyName, maxFilings: t.holderFilings, windowDays: t.holderWindowDays }), PROBE_TIMEOUT_MS, "13F holders probe"),
      settle(() => d.probe13G({ cik }), PROBE_TIMEOUT_MS, "Schedule 13G probe"),
    ]);
    const filings = filingsP.ok ? filingsP.data : null;
    const g13 = g13P.ok ? g13P.data : null;
    const insiderProbe = insiderP.ok ? insiderP.data : null;
    const holders = holdersP.ok ? holdersP.data : null;

    const haveFilings = !!(filings?.filings?.length);
    const haveInsider = !!(insiderProbe?.filings?.length);
    const haveHolders = !!(holders?.managers?.length);
    const readyLegs = [haveFilings, haveInsider, haveHolders].filter(Boolean).length;
    if (readyLegs < 2) {
      const why = [
        haveFilings ? null : `no recent SEC filings for ${ticker}${filingsP.ok ? "" : ` (${filingsP.error})`}`,
        haveInsider ? null : `no Form 4 insider filings in the last ${insiderDays} days${insiderP.ok ? "" : ` (${insiderP.error})`}`,
        haveHolders ? null : `no 13F information table naming this issuer in the last ${t.holderWindowDays} days${holdersP.ok ? "" : ` (${holdersP.error})`}`,
      ].filter(Boolean).join("; ");
      throw bad(`Not enough evidence to build a ticker pack for ${ticker}: ${why}. A pack needs at least two of the three legs. Not charged.`, 422);
    }

    // 3) THE EXPENSIVE PARTS, in parallel. Each is settled: a failed part is
    //    NAMED as failed in the report and its numbers are left null, never 0.
    let partSpend = 0;
    const [dossierR, insiderR] = await Promise.all([
      // `accountAs` makes each part fold its upstream spend into THIS run instead
      // of booking a separate sale: one $15 purchase must produce one usage row,
      // not three rows totalling $28 of "price" with a fictitious 98% margin.
      settle(() => d.runDossier({ ticker, ...(focus.length ? { focus } : {}), accountAs: (usd) => { partSpend += Number(usd) || 0; } }, req), PART_TIMEOUT_MS, "dossier"),
      haveInsider
        ? settle(() => d.runInsider({ ticker, days: insiderDays, accountAs: (usd) => { partSpend += Number(usd) || 0; } }, req), PART_TIMEOUT_MS, "insider flow")
        : Promise.resolve({ ok: false, error: `no Form 4 filings against ${ticker} in the last ${insiderDays} days` }),
    ]);

    // 4) POST-RUN EVIDENCE GATE: the three CONTENT legs of the finished pack.
    const producedLegs = [dossierR.ok, insiderR.ok, haveHolders].filter(Boolean).length;
    // Weighted, not a bare count: the dossier is the substance of this bundle.
    // Insider + holders alone is a $4 report's worth of content sold for $15.
    if (producedLegs < 2 || !dossierR.ok) {
      const why = [
        dossierR.ok ? null : `dossier leg failed (${dossierR.error})`,
        insiderR.ok ? null : `insider leg failed (${insiderR.error})`,
        haveHolders ? null : "holders leg found nothing",
      ].filter(Boolean).join("; ");
      throw bad(`Ticker pack for ${ticker} could not be completed: ${why}. Not charged - please retry.`, 502);
    }

    // 5) MERGE SOURCES across the parts (dedupe by URL), then renumber every
    //    sub-report's citations into the merged list.
    // Each manager carries its OWN local source number, so a manager with no
    // readable information-table URL cannot shift anybody else's citation.
    const holderManagers = holders?.managers || [];
    const holderSrcLocal = new Map(); // manager index -> local source n
    const holderSourceRows = [];
    for (let i = 0; i < holderManagers.length; i++) {
      const m = holderManagers[i];
      if (!m.url) continue;
      const n = holderSourceRows.length + 1;
      holderSrcLocal.set(i, n);
      holderSourceRows.push({ n, title: `13F-HR information table filed ${m.filed || "?"} by ${m.manager || `CIK ${m.cik}`} (period ${m.period || "?"}) - SEC EDGAR`, url: m.url });
    }
    const HOLDER_SEARCH_LOCAL_N = holderSourceRows.length + 1;
    if (holders) holderSourceRows.push({ n: HOLDER_SEARCH_LOCAL_N, title: `SEC EDGAR full-text search: 13F-HR information tables naming ${companyName}, ${holders.startDate} to ${holders.endDate}`, url: holders.searchUrl });
    const holderSources = { sources: holderSourceRows };
    const filingSources = { sources: filings ? [{ n: 1, title: `SEC EDGAR filing history for ${filings.name || companyName} (CIK ${cik})`, url: filings.browseUrl }] : [] };
    const g13Filers = g13?.filers || [];
    const g13Sources = { sources: g13Filers.map((f, i) => ({ n: i + 1, title: `${f.form} filed ${f.filed} by ${f.filer} - SEC EDGAR`, url: f.url })) };
    const { merged, maps } = mergeSources([
      { sources: dossierR.ok ? dossierR.data?.sources : [] },
      { sources: insiderR.ok ? insiderR.data?.sources : [] },
      holderSources,
      filingSources,
      g13Sources,
    ]);
    const dossierProse = dossierR.ok ? foldSubReport(dossierR.data?.dossier || "", maps[0]) : "";
    const insiderProse = insiderR.ok ? foldSubReport(insiderR.data?.report || "", maps[1]) : "";
    const holderSrcNum = maps[2];
    const filingSrcNum = maps[3].get(1) || null;
    const g13SrcNum = maps[4];

    // 6) DETERMINISTIC SECTIONS.
    const filingsRows = (filings?.filings || []).map((f) => [f.form, f.filed, f.period, f.description, f.url]);
    const filingsBlock = filingsRows.length
      ? [
          `${filings.name || companyName} (CIK ${cik})${filings.sic ? ` · ${filings.sic}` : ""}${filings.exchanges?.length ? ` · listed on ${filings.exchanges.join(", ")}` : ""}${filings.fiscalYearEnd ? ` · fiscal year end ${filings.fiscalYearEnd}` : ""}.`,
          "",
          `The ${filingsRows.length} most recent filings on EDGAR${filingSrcNum ? ` [${filingSrcNum}]` : ""}:`,
          "",
          "| Form | Filed | Period | Document |",
          "| --- | --- | --- | --- |",
          ...filingsRows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2] || ""} | ${r[3] ? `[${r[3]}](${r[4]})` : (r[4] ? `[filing](${r[4]})` : "")} |`),
        ].join("\n")
      : `Recent EDGAR filing history is unavailable for this run${filingsP.ok ? "" : ` (${filingsP.error})`}.`;

    const holderCount = holders?.managers?.length || 0;
    const holderShares = (holders?.managers || []).reduce((a, m) => a + (m.shares || 0), 0);
    const holderLines = holderManagers.map((m, i) => {
      const g = holderSrcLocal.has(i) ? holderSrcNum.get(holderSrcLocal.get(i)) : null;
      return `| ${m.manager || `CIK ${m.cik}`} | ${m.period || "?"} | ${nf(m.shares)} | ${fmtUsd(m.valueUsd)} | ${m.impliedPriceUsd == null ? "" : `$${m.impliedPriceUsd.toFixed(2)}`} | ${m.optionRows ? `${nf(m.optionShares)} (${m.optionRows} row${m.optionRows === 1 ? "" : "s"})` : ""} | ${g ? `[${g}]` : ""} |`;
    });
    const holdersSearchCite = holders ? (holderSrcNum.get(HOLDER_SEARCH_LOCAL_N) || null) : null;
    const nfp = (v) => (v == null ? "?" : `${Number(v).toFixed(2)}%`);
    const g13Block = g13Filers.length
      ? [
          `**5%+ holders as disclosed on Schedule 13G / 13D** (${g13.startDate} to ${g13.endDate}; ${g13.matching} matching filing${g13.matching === 1 ? "" : "s"}, newest per filer shown). A row reporting 0 shares / 0% is a filer disclosing that it fell BELOW the 5% threshold - a disclosed exit, not a data gap.`,
          "",
          "| Filer | Type | Shares | % of class | As of | Form | Filed | Filing |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          ...g13Filers.map((f, i) => `| ${f.filer} | ${f.personType || ""} | ${f.parsed ? (f.belowThreshold ? "0 (below 5%)" : nf(f.shares)) : "not parsed"} | ${f.parsed ? (f.belowThreshold ? "0% (below 5%)" : nfp(f.percent)) : ""} | ${f.eventDate || ""} | ${f.form} | ${f.filed} | ${g13SrcNum.get(i + 1) ? `[${g13SrcNum.get(i + 1)}]` : ""} |`),
          "",
        ]
      : [`No Schedule 13G / 13D filing against this issuer was found on EDGAR in the last ${g13 ? Math.round((Date.parse(g13.endDate) - Date.parse(g13.startDate)) / 86400000) : 400} days${g13P.ok ? "" : ` (${g13P.error})`} - the material provided here does not include 5%+ holder disclosures; do not infer there are none.`, ""];
    const holdersBlock = holderCount
      ? [
          ...g13Block,
          `${holderCount} institutional manager${holderCount === 1 ? "" : "s"} in this sample report a position in ${companyName}${holders.cusipPrefix ? ` (CUSIP issuer prefix ${holders.cusipPrefix})` : ""}, totalling ${nf(holderShares)} shares across the periods shown${holdersSearchCite ? ` [${holdersSearchCite}]` : ""}.`,
          "",
          "| Manager | Period | Shares reported | Value reported | Implied $/share | Option rows | Filing |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...holderLines,
          "",
          `**How to read this.** SEC EDGAR full-text search returned ${holders.matchingRelation === "gte" ? `at least ${nf(holders.matchingFilings)}` : nf(holders.matchingFilings)} 13F-HR information tables naming this issuer between ${holders.startDate} and ${holders.endDate}; this pack scanned ${holders.scanned} of them${holders.failedScans ? ` (${holders.failedScans} could not be read)` : ""} and reports each manager's most recent table in that window. **It is a sample of holders, not the complete holder list**, and the search result window is capped by EDGAR, so absence from this table is not evidence that a manager does not hold the stock. A 13F-HR reports only long US-listed equity and option positions, is filed up to 45 days after quarter end, and excludes shorts, cash, non-US holdings and most fixed income.`,
          "",
          `Share counts are summed only from rows a filer marked SH; rows marked PRN are principal amounts on the issuer's debt, which shares the CUSIP prefix, and are excluded. Values are reproduced exactly as each manager reported them: the SEC moved 13F values to whole dollars for filings submitted from 2023-01-03, a minority of filers still report thousands, and the implied price per share column makes that visible rather than folding it into a total. For that reason the dollar column is not summed here.`,
          ...(holders.managers.some((m) => m.truncated) ? ["", "One or more of these information tables was larger than this run reads, so those managers' share counts are a FLOOR, not a total. The table's \"Partial read\" column names them."] : []),
        ].join("\n")
      : [...g13Block, `No 13F-HR information table naming this issuer was read for this run${holdersP.ok ? "" : ` (${holdersP.error})`}. The 13F sample is not reported in this pack.`].join("\n");

    // 7) ONE pack synthesis pass over FETCHED FACTS ONLY. The sub-reports'
    //    prose is deliberately NOT in this prompt: the pack pass summarizes
    //    measured values, so nothing it writes can trace to model prose.
    const im = insiderR.ok ? (insiderR.data?.meta || {}) : null;
    const dm = dossierR.ok ? (dossierR.data?.meta || {}) : null;
    const factLines = [
      `COMPANY: ${filings?.name || companyName} (ticker ${ticker}, SEC CIK ${cik})${filings?.sic ? `, SIC classification "${filings.sic}"` : ""}${filings?.exchanges?.length ? `, listed on ${filings.exchanges.join(", ")}` : ""}.`,
      filings?.filings?.length
        ? `RECENT FILINGS (${filings.filings.length} most recent on EDGAR): ${filings.filings.slice(0, 12).map((f) => `${f.form} filed ${f.filed}${f.period ? ` for period ${f.period}` : ""}`).join("; ")}.`
        : `RECENT FILINGS: unavailable for this run${filingsP.ok ? "" : ` (${filingsP.error})`} - do not describe the company's filing history.`,
      dm
        ? `DOSSIER LEG: produced. It read ${dm.filings_10k ?? 0} 10-K, ${dm.filings_10q ?? 0} 10-Q and ${dm.filings_8k ?? 0} 8-K filings, ${dm.insider_filings ?? 0} Form 4 filings, ${dm.web_angles ?? 0} grounded web angles, and cited ${dm.sources_cited ?? 0} sources.`
        : `DOSSIER LEG: FAILED (${dossierR.error}). No company narrative is available - say the leg failed, and do not describe the business, financials or risks.`,
      im
        ? `INSIDER FLOW LEG (${im.start} to ${im.end}, ${im.window_days} days): produced. Form 4 filings in the window ${im.filings_in_window}, filings read ${im.filings_read}, transactions parsed ${im.transactions}. Open-market BUYS ${im.open_market_buys} totalling ${fmtUsd(im.buy_usd)} across ${im.distinct_buyers} distinct insiders. Open-market SELLS ${im.open_market_sells} totalling ${fmtUsd(im.sell_usd)} across ${im.distinct_sellers} distinct insiders. Net open-market flow ${fmtUsd(im.net_open_market_usd)}. Awards ${im.awards}, option exercises ${im.option_exercises}, tax-withholding dispositions ${im.tax_withholding}.`
        : `INSIDER FLOW LEG: FAILED or empty (${insiderR.error}). Say so plainly, and do NOT state or imply any insider buying, selling or amount.`,
      g13Filers.length
        ? `SCHEDULE 13G/13D LEG (5%+ holder disclosures, ${g13.startDate} to ${g13.endDate}): ${g13Filers.map((f) => `${f.filer}: ${f.parsed ? (f.belowThreshold ? `reported falling BELOW 5% as of ${f.eventDate || "?"}` : `${nf(f.shares)} shares, ${nfp(f.percent)} of class as of ${f.eventDate || "?"}`) : `filed ${f.form} on ${f.filed} (not parsed)`}`).join("; ")}.`
        : `SCHEDULE 13G/13D LEG: no filing found in the window${g13P.ok ? "" : ` (${g13P.error})`} - the material does not include 5%+ holder disclosures; do not say there are none.`,
      holderCount
        ? `INSTITUTIONAL HOLDERS LEG (13F-HR information tables, ${holders.startDate} to ${holders.endDate}): produced. EDGAR full-text search matched ${holders.matchingRelation === "gte" ? `at least ${holders.matchingFilings}` : holders.matchingFilings} information tables naming this issuer; ${holders.scanned} were scanned and ${holderCount} managers reported a position. Total reported in this SAMPLE: ${holderShares} shares. Largest reported positions in the sample, by share count: ${holders.managers.slice(0, 8).map((m) => `${m.manager || `CIK ${m.cik}`} ${m.shares} shares (value as reported ${fmtUsd(m.valueUsd)}, period ${m.period || "?"})`).join("; ")}. Reported dollar values are NOT comparable across filers (some still report thousands) and must not be summed. THIS IS A SAMPLE, NOT THE COMPLETE HOLDER LIST.`
        : `INSTITUTIONAL HOLDERS LEG: no information table was read${holdersP.ok ? "" : ` (${holdersP.error})`}. Do not name any institutional holder.`,
    ];

    const synthPrompt = `You are writing the two connective sections of a TICKER PACK on ${filings?.name || companyName} (${ticker}) that will be SOLD to a paying customer. The pack already contains a full company dossier, an insider-flow report and an institutional-holders table; your job is ONLY the opening summary and the closing checklist.

=== ABSOLUTE GROUNDING RULES ===
1. Use ONLY the MEASURED FACTS below. They are the complete set of things you know about this company. NEVER introduce a figure, a date, a person, a product, a price or a market fact from your own training or memory.
2. Reproduce every magnitude and date exactly as given. If a fact is not below, do not state it - describe the gap instead.
3. A leg marked FAILED produced NOTHING. Say the leg was unavailable. Never treat a missing number as zero and never guess what it would have been.
4. Do NOT use bracketed citations - this section carries none. Do not write a "Sources" section.
5. This is information, not investment advice. Do not recommend buying or selling.
6. Write about the COMPANY, never about this pipeline: do not say a leg "was produced", "ran successfully" or "cited N sources", and do not narrate what was read. Coverage facts (how many filings, the holders sample size and its limitation) belong in ONE short sentence at the end of the executive summary, nowhere else. Only a FAILED leg is named as such (rule 3).

Write EXACTLY two parts, separated by a line containing only ===NEXT===.

PART ONE: an EXECUTIVE SUMMARY of up to ${t.words} words - what this company is by its own SEC classification, what the filing cadence shows, what the insider flow measured, and what the institutional-holder sample shows, with the sampling caveat stated plainly. Plain paragraphs, no headings.

PART TWO: WHAT TO CHECK NEXT - a markdown bullet list of 5 to 8 concrete, specific follow-ups a reader should do, each tied to a fact above (a named filing to read, a window to re-run, a number to watch). No headings, bullets only.

=== MEASURED FACTS ===
${factLines.join("\n")}`;

    let spent = 0;
    let execSummary = "";
    let nextSteps = "";
    const overBudget = (d.now() - started) > RUN_DEADLINE_MS - SYNTH_TIMEOUT_MS;
    const packSynth = overBudget
      ? { ok: false, error: `skipped: the pack was already ${Math.round((d.now() - started) / 1000)}s in and the payment window bounds the run` }
      : await settle(() => d.synthesize({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user), SYNTH_TIMEOUT_MS + 5_000, "pack synthesis");
    if (packSynth.ok) {
      spent += costOf(packSynth.data);
      const text = textOf(packSynth.data);
      const idx = text.indexOf("===NEXT===");
      if (idx >= 0) { execSummary = text.slice(0, idx).trim(); nextSteps = text.slice(idx + "===NEXT===".length).trim(); }
      else { execSummary = text.trim(); }
    }
    // Deterministic fallbacks: the pack still ships if the connective pass is
    // unavailable, because both parts and the tables are already grounded.
    if (!execSummary) {
      execSummary = [
        `${filings?.name || companyName} (${ticker}, SEC CIK ${cik}) is covered here by ${[dossierR.ok ? "a full due-diligence dossier" : null, insiderR.ok ? `an insider-flow report over the last ${insiderDays} days` : null, holderCount ? `an institutional-holder sample of ${holderCount} 13F filers` : null].filter(Boolean).join(", ")}.`,
        im ? `Form 4 filings in the window: ${im.filings_in_window}, of which ${im.filings_read} were read; ${im.open_market_buys} open-market buys totalling ${fmtUsd(im.buy_usd)} and ${im.open_market_sells} open-market sales totalling ${fmtUsd(im.sell_usd)}.` : "The insider-flow leg is not part of this run.",
        holderCount ? `The holder table is a sample of ${holderCount} managers, not the complete holder list.` : "No institutional-holder sample was read for this run.",
      ].join(" ");
    }
    if (!nextSteps) {
      nextSteps = [
        filings?.filings?.[0] ? `- Read the most recent filing in the table above: ${filings.filings[0].form} filed ${filings.filings[0].filed}.` : null,
        insiderR.ok ? `- Re-run the insider leg after the next Form 4 lands; Form 4s are due within two business days of a transaction.` : `- Re-run the insider leg once Form 4 filings appear for this issuer.`,
        holderCount ? `- Re-run the holder sample after the next 13F-HR deadline (13F-HR is due 45 days after quarter end) and compare the managers and share counts.` : null,
        `- Widen the insider window past ${insiderDays} days if the sample is thin.`,
        `- Check the full EDGAR filing history directly at ${filings?.browseUrl || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`}.`,
      ].filter(Boolean).join("\n");
    }

    // 8) STITCH.
    const legLine = [
      dossierR.ok ? "company dossier" : "company dossier UNAVAILABLE",
      insiderR.ok ? `insider flow (${insiderDays}d)` : "insider flow UNAVAILABLE",
      holderCount ? `${holderCount} institutional holders (sample)` : "institutional holders UNAVAILABLE",
    ].join(" · ");
    const sourceList = merged.map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n");
    const report = [
      `# Ticker Pack: ${filings?.name || companyName} (${ticker})`,
      "",
      `**${isoDate(d.now())}** · ${legLine} · ${merged.length} source${merged.length === 1 ? "" : "s"}`,
      "",
      "## Executive summary",
      "",
      execSummary,
      "",
      "## Company",
      "",
      dossierProse || `The company dossier leg did not produce for this run (${dossierR.error}). The filings, insider and holder sections below are unaffected.`,
      "",
      "## Filings",
      "",
      filingsBlock,
      "",
      `## Insider flow (last ${insiderDays} days)`,
      "",
      insiderProse || `The insider-flow leg did not produce for this run (${insiderR.error}). No insider buying or selling is reported here, and none should be inferred.`,
      "",
      "## Institutional holders (13F)",
      "",
      holdersBlock,
      "",
      "## What to check next",
      "",
      nextSteps,
      "",
      "---",
      "",
      DISCLAIMER,
      ...(sourceList ? ["", "## Sources", sourceList] : []),
    ].join("\n");

    // 9) TABLES: the parts' own appendices plus the new holders table, each
    //    namespaced so a spreadsheet export never collides.
    const tables = [];
    if (filingsRows.length) tables.push({
      name: "filings", label: "Recent SEC filings",
      columns: ["Form", "Filed", "Period", "Description", "Document"], rows: filingsRows,
    });
    for (const tb of (dossierR.ok ? (dossierR.data?.tables || []) : [])) tables.push({ ...tb, name: `dossier-${tb.name}`, label: `Dossier: ${tb.label}` });
    for (const tb of (insiderR.ok ? (insiderR.data?.tables || []) : [])) tables.push({ ...tb, name: `insider-${tb.name}`, label: `Insider flow: ${tb.label}` });
    if (holderCount) tables.push({
      name: "holders", label: "Institutional holders (13F sample)",
      columns: ["Manager", "CIK", "Period", "Filed", "Shares reported", "Value reported (as filed)", "Implied USD/share", "Option rows", "Option shares", "Principal rows", "Partial read", "Share classes", "Information table"],
      rows: holders.managers.map((m) => [m.manager || "", m.cik || "", m.period || "", m.filed || "", String(m.shares || 0), String(Math.round(m.valueUsd || 0)), m.impliedPriceUsd == null ? "" : m.impliedPriceUsd.toFixed(4), String(m.optionRows || 0), String(m.optionShares || 0), String(m.principalRows || 0), m.truncated ? "yes (share count is a floor)" : "", (m.classes || []).join(" / "), m.url || ""]),
    });

    const evidence = {
      filings: filings?.filings?.length
        ? { ok: true, count: filings.filings.length, cik, browseUrl: filings.browseUrl }
        : { ok: false, error: filingsP.ok ? "EDGAR returned no recent filings" : filingsP.error },
      dossier: dossierR.ok
        ? { ok: true, sources: dm?.sources_cited ?? null, webAngles: dm?.web_angles ?? null, filings10k: dm?.filings_10k ?? null, filings10q: dm?.filings_10q ?? null, filings8k: dm?.filings_8k ?? null }
        : { ok: false, error: dossierR.error },
      insider: insiderR.ok
        ? { ok: true, windowDays: im?.window_days ?? insiderDays, start: im?.start ?? null, end: im?.end ?? null, filingsInWindow: im?.filings_in_window ?? null, filingsRead: im?.filings_read ?? null, transactions: im?.transactions ?? null, openMarketBuys: im?.open_market_buys ?? null, buyUsd: im?.buy_usd ?? null, openMarketSells: im?.open_market_sells ?? null, sellUsd: im?.sell_usd ?? null, netOpenMarketUsd: im?.net_open_market_usd ?? null }
        : { ok: false, error: insiderR.error },
      holders: holderCount
        ? { ok: true, managers: holderCount, sharesReported: holderShares, scanned: holders.scanned, failedScans: holders.failedScans, matchingFilings: holders.matchingFilings, matchingRelation: holders.matchingRelation, cusipPrefix: holders.cusipPrefix, start: holders.startDate, end: holders.endDate, complete: false, note: "A sample of 13F filers from EDGAR full-text search, not the complete holder list." }
        : { ok: false, error: holdersP.ok ? "no 13F information table naming this issuer was read" : holdersP.error },
      packSynthesis: packSynth.ok ? { ok: true, model: SYNTH } : { ok: false, error: packSynth.error },
    };

    const meta = {
      tier: tierSlug,
      company: filings?.name || companyName,
      ticker,
      cik,
      generated: isoDate(d.now()),
      elapsed_ms: d.now() - started,
      legs_produced: producedLegs,
      legs: { dossier: dossierR.ok, insider: insiderR.ok, holders: holderCount > 0 },
      insider_window_days: insiderDays,
      holder_sample_managers: holderCount || null,
      holder_sample_complete: false,
      sources_cited: merged.length,
      synthesis_model: SYNTH,
      // The parts record their OWN upstream spend under their own slugs; this
      // number is the pack pass only, so nothing is double counted.
      disclaimer: DISCLAIMER,
    };

    const out = { report, company: meta.company, ticker, cik, sources: merged, tables, evidence, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { synthPrompt, factLines };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent + partSpend, ok: true, priceUsd: priceUsdOf(t) });
    return out;
  };
}

export function makeTickerPackHandler(tierSlug = "ticker-pack", deps) {
  const run = makeTickerPackHandlerInner(tierSlug, deps);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(TICKER_PACK_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}

const SCHEMA = {
  type: "object",
  required: ["ticker"],
  properties: {
    ticker: { type: "string", description: "US stock ticker to cover, e.g. AAPL." },
    days: { type: "number", description: "Insider-flow lookback in days, 7-365 (default 90)." },
    focus: { type: "array", items: { type: "string" }, description: "Optional aspects for the dossier leg to emphasize (<= 8), e.g. [\"litigation\", \"debt\"]." },
  },
};
const OUT_EXAMPLE = {
  report: "# Ticker Pack: Example Corp (EXMP)\n\n**2026-08-22** · company dossier · insider flow (90d) · 9 institutional holders (sample) · 31 sources\n\n## Executive summary\n...\n\n## Company\n...\n\n## Filings\n| Form | Filed | Period | Document |\n| --- | --- | --- | --- |\n\n## Insider flow (last 90 days)\n...\n\n## Institutional holders (13F)\n...\n\n## What to check next\n- ...\n\n## Sources\n[1] 10-K filed 2026-02-01 - SEC EDGAR - https://www.sec.gov/...",
  company: "Example Corp", ticker: "EXMP", cik: "0000000000",
  sources: [{ n: 1, title: "10-K filed 2026-02-01 - SEC EDGAR", url: "https://www.sec.gov/..." }],
  tables: [{ name: "holders", label: "Institutional holders (13F sample)", columns: ["Manager", "CIK", "Period", "Filed", "Shares reported", "Value reported (as filed)", "Implied USD/share", "Option rows", "Option shares", "Principal rows", "Share classes", "Information table"], rows: [["EXAMPLE ASSET MANAGEMENT LLC", "0000000001", "2026-06-30", "2026-08-12", "12025", "3509184", "291.8032", "0", "0", "0", "COM", "https://www.sec.gov/Archives/edgar/data/1/000000000000000000/infotable.xml"]] }],
  evidence: {
    filings: { ok: true, count: 24, cik: "0000000000", browseUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000000" },
    dossier: { ok: true, sources: 20, webAngles: 4, filings10k: 1, filings10q: 3, filings8k: 6 },
    insider: { ok: true, windowDays: 90, filingsInWindow: 11, filingsRead: 11, transactions: 18, openMarketBuys: 1, buyUsd: 240000, openMarketSells: 3, sellUsd: 1850000, netOpenMarketUsd: -1610000 },
    holders: { ok: true, managers: 9, sharesReported: 1975812, scanned: 12, failedScans: 0, complete: false, note: "A sample of 13F filers from EDGAR full-text search, not the complete holder list." },
    packSynthesis: { ok: true, model: "anthropic/claude-opus-5" },
  },
  meta: { tier: "ticker-pack", company: "Example Corp", ticker: "EXMP", cik: "0000000000", legs_produced: 3, legs: { dossier: true, insider: true, holders: true }, insider_window_days: 90, holder_sample_managers: 9, holder_sample_complete: false, sources_cited: 31, synthesis_model: "anthropic/claude-opus-5" },
};

export const TICKER_PACK_TOOLS = [
  {
    route: "POST /v1/ticker-pack",
    name: "Ticker pack: dossier, insider flow and institutional holders",
    slug: "ticker-pack",
    category: "llm",
    price: TICKER_PACK_TIERS["ticker-pack"].price,
    description: "One ticker, one purchase, the full picture. Runs the company due-diligence dossier (SEC filings, XBRL financials, grounded web research), the Form 4 insider-flow report with the actual transactions parsed, and a 13F institutional-holder sample read live off SEC EDGAR full-text search, then stitches them into ONE cited report: company, filings, insider flow, institutional holders and what to check next, with a merged source list and downloadable data appendices. Cheaper than buying the parts separately. SEC EDGAR data, not investment advice. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["research", "due-diligence", "bundle", "sec", "edgar", "13f", "holders", "insider", "form-4", "stocks", "premium", "agentic-finance", "agent"],
    discovery: { bodyType: "json", input: { ticker: "AAPL", days: 90 }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeTickerPackHandler("ticker-pack"),
  },
];

export const __test = { makeTickerPackHandler, defaultDeps, DISCLAIMER, PACK_SYNTH_MAX_UPSTREAM_USD };
