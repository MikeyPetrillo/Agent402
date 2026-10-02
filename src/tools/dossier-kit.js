// dossier-kit — Company Due-Diligence Dossier. A premium (card-tier) report that
// grounds in OUR structured data - SEC EDGAR filings + Form 4 insider filings +
// a live quote - which generic-web research agents cannot reach, plus grounded
// web search for recent developments, then synthesizes a cited, structured
// dossier.
//
// Same discipline as research-deep: grounding-strict synthesis (every specific
// must trace to the provided data/sources, no invented figures, cite [n] only
// what a source supports), Opus synthesis, deterministic source list appended in
// code, settlement-safe (any upstream failure throws >=400 so the buyer is not
// charged), cost read for the internal accumulator and never returned,
// WALLET_ONLY, not cached. Gated on OPENROUTER_API_KEY (503 without it).
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { EDGAR_TOOLS, fetchXmlText } from "./edgar-kit.js";
import { FINANCE_TOOLS } from "./finance-kit.js";

// Per-buyer OpenRouter `user` id (OpenRouter abuse isolation); never throws.
function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5"; // synthesis on both tiers (see research-deep eval)
const GROUND = "google/gemini-3.6-flash"; // grounded web search + read. gemini-3.6-flash since 2026-09-23 (2.5-flash expires upstream 2026-10-20); it reasons by default, so the search call passes reasoning:low - measured: default spent 460 of 600 tokens thinking, low returned the full cited answer at the same cost.

// synthMaxTokens carries headroom over the word target (measured ~2.3 output
// tokens/word for dense cited markdown; a 6,000 cap truncated a "~2,500 word"
// dossier at ~2,540 words). Caps held at a provider-safe 8,000; word targets are
// what those budgets complete; the source list is appended in code (no budget).
export const DOSSIER_TIERS = {
  "dossier": { price: "$0.85", maxUpstreamUsd: 0.5, filings: 3, insiderDays: 120, searches: 4, topWeb: 20, synthMaxTokens: 7000, words: "~2,400" },
  "dossier-max": { price: "$1.10", maxUpstreamUsd: 0.65, filings: 6, insiderDays: 365, searches: 8, topWeb: 32, synthMaxTokens: 8000, words: "~2,800" },
};
// Models routed to - exported so the live-catalog guard checks them.
export const DOSSIER_MODELS = [SYNTH, GROUND];

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const SEARCH_TIMEOUT_MS = 60_000;
const SYNTH_TIMEOUT_MS = 120_000;
const DATA_TIMEOUT_MS = 25_000;

async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
// The grounded-search model cites its sources inline as [domain](url) or bare
// [domain.com] tags. Strip them from the sub-answers so the synthesizer doesn't
// COPY those tags (it must cite our numbered [n] list instead).
function stripInlineCites(s) {
  return String(s || "")
    .replace(/\[([^\]]+)\]\((?:https?:)?\/\/[^)]+\)/g, "$1")                           // [text](url) -> text
    .replace(/\[[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?:\s*,\s*[a-z0-9][a-z0-9.\-]*\.[a-z]{2,})*\]/gi, "") // [domain.com] / [d1, d2] -> ""
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
function webSourcesFrom(d) {
  const anns = d?.choices?.[0]?.message?.annotations || [];
  const out = [];
  for (const a of anns) {
    const c = a?.url_citation || a;
    if (c?.url) out.push({ title: String(c.title || c.url).slice(0, 200), url: String(c.url), snippet: String(c.content || c.snippet || "").slice(0, 500) });
  }
  return out;
}
function getHandler(kit, slug) {
  const t = kit.find((x) => x.slug === slug);
  if (!t) throw bad(`dossier: missing dependency '${slug}' - sub-kit renamed`, 500);
  return t.handler;
}
// settle: never throw from a data leg; return {ok,data} | {ok:false,error}.
async function settle(fn, input, timeoutMs) {
  try {
    const p = fn(input);
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

function fmtUsd(v) {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v), a = Math.abs(n), sign = n < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  return `${sign}$${a.toLocaleString("en-US")}`;
}
// Pull key financial facts from SEC XBRL (data.sec.gov) - so figures come from
// the FILINGS, not a news article, and are traceable to a 10-K/10-Q. Each concept
// yields a latest-annual + most-recent datapoint. Revenue has two common tags.
// The three bridge concepts (non-operating, pre-tax, tax) exist because of a
// real report (INTC, 2026-08-26): the synthesis was handed operating income
// +$1.80B and net income -$11.03B with nothing between them and called the
// quarter's loss "unexplained" as a RED FLAG - the 10-Q explains it in one
// line (a $12.5B fair-value loss on escrowed shares) and XBRL carries it as
// NonoperatingIncomeExpense -$12.58B. Headline numbers without the bridge
// invite exactly that misreading.
const FIN_CONCEPTS = [
  ["Revenues", "Total revenue"],
  ["RevenueFromContractWithCustomerExcludingAssessedTax", "Total revenue"],
  ["NetIncomeLoss", "Net income"],
  ["OperatingIncomeLoss", "Operating income"],
  ["NonoperatingIncomeExpense", "Non-operating income (expense)"],
  ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "Pre-tax income"],
  ["IncomeTaxExpenseBenefit", "Income tax expense (benefit)"],
  ["Assets", "Total assets"],
  ["Liabilities", "Total liabilities"],
  ["StockholdersEquity", "Stockholders' equity"],
  ["CashAndCashEquivalentsAtCarryingValue", "Cash & equivalents"],
  ["EarningsPerShareBasic", "EPS (basic)"],
];

/** Operating-to-net income bridge for the most recent period the filings
 *  report both ends of. `facts` = { tag: [{start,end,val,form,fp,fy}] } (the
 *  XBRL `units.USD` arrays). Returns null when operating and net income agree
 *  within tolerance (nothing to explain) or when either end is missing.
 *  Otherwise the reconciling lines the filing reports (non-operating, pre-tax,
 *  tax) and the remainder those lines leave - so the synthesis is HANDED the
 *  reconciliation instead of asked to find it. Pure; exported for tests. */
export function incomeBridge(facts, { tolerance = 0.15, minGapUsd = 5e6 } = {}) {
  const arr = (tag) => (Array.isArray(facts?.[tag]) ? facts[tag] : []).filter((x) => x && x.end && x.start && Number.isFinite(Number(x.val)));
  const key = (x) => `${x.start}..${x.end}`;
  const byPeriod = (tag) => { const m = new Map(); for (const x of arr(tag)) { const k = key(x); const prev = m.get(k); if (!prev || String(x.filed || "") >= String(prev.filed || "")) m.set(k, x); } return m; };
  const op = byPeriod("OperatingIncomeLoss"), net = byPeriod("NetIncomeLoss");
  // Most recent period end that has BOTH ends, preferring the shortest span
  // (a quarter over a year-to-date) at that end date.
  const candidates = [...op.keys()].filter((k) => net.has(k)).map((k) => ({ k, end: op.get(k).end, span: Date.parse(op.get(k).end) - Date.parse(op.get(k).start) }));
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.end.localeCompare(a.end) || a.span - b.span);
  const period = candidates[0].k;
  const at = (tag) => byPeriod(tag).get(period);
  const o = Number(at("OperatingIncomeLoss").val), n = Number(at("NetIncomeLoss").val);
  const gap = n - o;
  if (Math.abs(gap) < Math.max(minGapUsd, tolerance * Math.max(Math.abs(o), Math.abs(n)))) return null;
  const nonop = at("NonoperatingIncomeExpense"), pretax = at("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"), tax = at("IncomeTaxExpenseBenefit");
  const lines = [];
  let explained = 0;
  if (nonop) { lines.push({ label: "Non-operating income (expense)", val: Number(nonop.val) }); explained += Number(nonop.val); }
  if (tax) { lines.push({ label: "Income tax expense (benefit)", val: -Number(tax.val) }); explained -= Number(tax.val); }
  const remainder = gap - explained;
  const src = at("NetIncomeLoss");
  return {
    period: { start: src.start, end: src.end, form: src.form || null, fp: src.fp || null, fy: src.fy || null },
    operating: o, net: n, gap,
    ...(pretax ? { pretax: Number(pretax.val) } : {}),
    lines, remainder,
    // "Explained" = the filing's own reported lines account for the gap to
    // within tolerance; the prose may then say WHAT the non-operating line is
    // only if the filing excerpts name it.
    explained: Math.abs(remainder) <= Math.max(minGapUsd, tolerance * Math.abs(gap)),
  };
}

export function bridgeLines(b) {
  if (!b) return [];
  const when = `${b.period.start} to ${b.period.end}${b.period.form ? `, ${b.period.form}` : ""}`;
  const out = [`- OPERATING-TO-NET BRIDGE (${when}): operating income ${fmtUsd(b.operating)}; net income ${fmtUsd(b.net)}; gap ${fmtUsd(b.gap)}.`];
  for (const l of b.lines) out.push(`  - ${l.label}: ${fmtUsd(l.val)}`);
  if (b.pretax != null) out.push(`  - Pre-tax income as reported: ${fmtUsd(b.pretax)}`);
  out.push(b.explained
    ? `  - The reported lines account for the gap (remainder ${fmtUsd(b.remainder)}). The gap between operating and net income is therefore a REPORTED non-operating/tax item, not an unexplained loss - identify WHAT the item is from the FILING EXCERPTS if they name it; otherwise say the excerpts do not name it.`
    : `  - The reported lines leave ${fmtUsd(b.remainder)} unaccounted for in the XBRL bridge; check the FILING EXCERPTS before characterising it.`);
  return out;
}

// Vocabulary for the verbatim filing excerpts: the terms that name the things
// that make a bottom line diverge from operations, plus the disclosures a
// diligence reader asks about first. Order = priority when the budget binds.
export const EXCERPT_TERMS = [
  "mark-to-market", "fair value of", "escrow", "warrant", "derivative liabilit", "impairment", "restructuring",
  "gain (loss)", "(gains) losses", "gains (losses)", "loss on", "interest and other, net", "other income (expense)",
  "going concern", "material weakness", "subsequent event", "litigation", "dilut",
];
const EXCERPT_WINDOW = 520;

/** Strip a filing's HTML/iXBRL to readable text. Pure. */
export function filingText(html) {
  return String(html || "")
    // Inline XBRL keeps its context/unit definitions in a hidden <ix:header>;
    // as text it is member ids and CIKs, not prose.
    .replace(/<ix:header[^>]*>[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d|table|br)>/gi, " \n")
    .replace(/<[^>]+>/g, " ")
    // Entities: `&amp;` is decoded LAST so an encoded "&amp;lt;" cannot be
    // double-unescaped into a "<" (CodeQL js/double-escaping).
    .replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&#\d+;|&(?!amp;)[a-z]+;/gi, " ").replace(/&amp;/g, "&")
    .replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

/** Verbatim windows around EXCERPT_TERMS from a filing's text, deduped by
 *  overlap, bounded by `maxChars`. Terms earlier in the list win the budget.
 *  `extraTerms` (e.g. the bridge's own line names) go first. Pure. */
export function extractFilingExcerpts(text, { maxChars = 6_000, perTerm = 2, extraTerms = [] } = {}) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const taken = []; // [start, end]
  const out = [];
  let used = 0;
  // A hit already inside a taken window is covered; windows may otherwise
  // overlap at the edges (a short filing would else yield one window).
  const covered = (i) => taken.some(([s, e]) => i >= s && i < e);
  // XBRL/context soup guard: a window that is mostly ids (CIKs, prefixed
  // member names, dates) is not the filing's words.
  const soupy = (str) => { const toks = str.split(/\s+/); const ids = toks.filter((w) => /^\d{10}$/.test(w) || /^[a-z-]+:[A-Za-z]+$/.test(w) || /^\d{4}-\d{2}-\d{2}$/.test(w)).length; return toks.length > 0 && ids / toks.length > 0.12; };
  for (const term of [...extraTerms, ...EXCERPT_TERMS]) {
    const needle = String(term).toLowerCase();
    if (!needle) continue;
    let from = 0, hits = 0;
    while (hits < perTerm && used < maxChars) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      from = i + needle.length;
      const s = Math.max(0, i - Math.floor(EXCERPT_WINDOW / 3)), e = Math.min(t.length, i + EXCERPT_WINDOW);
      if (covered(i)) continue;
      const snippet = t.slice(s, e).replace(/\s+/g, " ").trim();
      if (snippet.length < 40 || soupy(snippet)) continue;
      if (out.length && used + snippet.length > maxChars) { used = maxChars; break; }
      taken.push([s, e]); out.push({ term, text: snippet }); used += snippet.length; hits++;
    }
    if (used >= maxChars) break;
  }
  return out;
}

async function pullFinancials(ticker, edgarConcept) {
  const results = await Promise.all(FIN_CONCEPTS.map(([tag, label]) =>
    settle(edgarConcept, { ticker, taxonomy: "us-gaap", tag }, DATA_TIMEOUT_MS).then((r) => ({ tag, label, r }))));
  const facts = {};
  for (const { tag, r } of results) { const u = r.ok ? r.data?.units?.USD : null; if (Array.isArray(u)) facts[tag] = u; }
  const bridge = incomeBridge(facts);
  const seen = new Set(); const lines = []; const rows = [];
  for (const { tag, label, r } of results) {
    if (seen.has(label)) continue;
    const units = r.ok ? (r.data?.units || {}) : {};
    const unitKey = units.USD ? "USD" : Object.keys(units)[0];
    const arr = unitKey ? units[unitKey] : [];
    if (!Array.isArray(arr) || !arr.length) continue;
    seen.add(label);
    const isShares = /shares/i.test(unitKey || "");
    const sorted = [...arr].filter((x) => x && x.end).sort((a, b) => String(a.end).localeCompare(String(b.end)));
    const annual = [...sorted].reverse().find((x) => x.form === "10-K" || x.fp === "FY");
    const latest = sorted[sorted.length - 1];
    const val = (x) => isShares ? String(x.val) : fmtUsd(x.val);
    const parts = [];
    if (annual) parts.push(`latest annual ${val(annual)} (${annual.fp || "FY"}${annual.fy ? " " + annual.fy : ""}, ${annual.form || "?"} filed ${annual.filed || "?"})`);
    if (latest && latest !== annual) parts.push(`most recent ${val(latest)} (period ending ${latest.end}, ${latest.form || "?"})`);
    if (parts.length) lines.push(`- ${label}: ${parts.join("; ")}`);
    // Structured row for the downloadable data appendix (same figures the prose
    // is grounded in, machine-readable for a spreadsheet).
    rows.push({
      metric: label,
      latestAnnual: annual ? val(annual) : "",
      annualPeriod: annual ? `${annual.fp || "FY"}${annual.fy ? " " + annual.fy : ""} ${annual.form || ""} filed ${annual.filed || "?"}`.trim() : "",
      mostRecent: (latest && latest !== annual) ? val(latest) : "",
      recentPeriod: (latest && latest !== annual) ? `${latest.end} (${latest.form || "?"})` : "",
    });
  }
  const bridgeText = bridgeLines(bridge);
  for (const l of bridge?.lines || []) rows.push({ metric: `Bridge: ${l.label}`, latestAnnual: "", annualPeriod: "", mostRecent: fmtUsd(l.val), recentPeriod: `${bridge.period.start}..${bridge.period.end} (${bridge.period.form || "?"})` });
  return { lines: [...lines, ...bridgeText], rows, bridge };
}

/** Verbatim excerpts from the newest 10-Q (else 10-K) primary document: the
 *  filing's OWN words on the items the vocabulary names, handed to the
 *  synthesis under the filing's source number so it can cite them. One EDGAR
 *  document read (bounded by EDGAR_FETCH_TIMEOUT_MS; the doc is capped before
 *  parsing). Never throws - a failed read yields no excerpts, and the prompt
 *  then says the filing text was not available rather than "not disclosed". */
async function pullFilingExcerpts(filings, { bridge = null, maxChars = 6_000, maxDocBytes = 6_000_000, fetchText = fetchXmlText } = {}) {
  const pick = filings.find((f) => f?.form === "10-Q" && f.url) || filings.find((f) => f?.form === "10-K" && f.url);
  if (!pick) return { filing: null, excerpts: [], note: "no 10-Q/10-K document URL" };
  try {
    const html = await fetchText(pick.url);
    if (typeof html !== "string") return { filing: pick, excerpts: [], note: "unreadable" };
    const text = filingText(html.length > maxDocBytes ? html.slice(0, maxDocBytes) : html);
    const extraTerms = bridge && !bridge.explained ? [] : (bridge ? ["interest and other", "non-operating", "nonoperating"] : []);
    return { filing: pick, excerpts: extractFilingExcerpts(text, { maxChars, extraTerms }), note: null, textChars: text.length };
  } catch (e) {
    return { filing: pick, excerpts: [], note: `filing text not readable (${String(e?.message || e).slice(0, 120)})` };
  }
}

function makeDossierHandlerInner(tierSlug) {
  const t = DOSSIER_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"ticker": "AAPL"}');
    const ticker = String(input.ticker ?? "").trim().toUpperCase();
    if (!ticker) throw bad('"ticker" (US stock ticker, e.g. "AAPL") is required');
    if (!TICKER_RE.test(ticker)) throw bad("ticker must be a short alphanumeric symbol, e.g. AAPL");
    const focus = Array.isArray(input.focus) ? input.focus.filter((x) => typeof x === "string").slice(0, 8) : [];
    const format = input.format === "json" ? "json" : "markdown";
    const user = safeUser(req);

    const edgarFilings = getHandler(EDGAR_TOOLS, "edgar-filings");
    const edgarInsider = getHandler(EDGAR_TOOLS, "edgar-insider-trades");
    const edgarConcept = getHandler(EDGAR_TOOLS, "edgar-company-concept");
    const stockQuote = getHandler(FINANCE_TOOLS, "stock-quote");

    let spent = 0;

    // 1) STRUCTURED DATA - fan out to EDGAR + quote in parallel (the moat). This
    // includes real XBRL financials pulled from the filings, so financial figures
    // are grounded in SEC data, not a news article.
    const [quote, k10, q10, k8, insider, financials] = await Promise.all([
      settle(stockQuote, { symbol: ticker }, DATA_TIMEOUT_MS),
      settle(edgarFilings, { ticker, form: "10-K", limit: Math.min(t.filings, 3) }, DATA_TIMEOUT_MS),
      settle(edgarFilings, { ticker, form: "10-Q", limit: t.filings }, DATA_TIMEOUT_MS),
      settle(edgarFilings, { ticker, form: "8-K", limit: t.filings * 2 }, DATA_TIMEOUT_MS),
      settle(edgarInsider, { ticker, days: t.insiderDays, limit: t.filings * 6 }, DATA_TIMEOUT_MS),
      pullFinancials(ticker, edgarConcept),
    ]);
    const company = [k10, q10, k8].map((r) => r.ok && r.data?.name).find(Boolean) || ticker;

    // If EDGAR gave us nothing at all, this isn't a US-listed company we can
    // do diligence on - fail (no charge) rather than sell a web-only "dossier".
    const anyFilings = [k10, q10, k8].some((r) => r.ok && (r.data?.filings?.length || 0) > 0);
    if (!anyFilings) throw bad(`No SEC EDGAR filings found for "${ticker}" - this product covers US-listed companies (try a ticker like AAPL). Not charged.`, 422);

    // 1b) FILING EXCERPTS - the newest 10-Q's own words on the items that move
    // a bottom line (runs alongside the web search below; one EDGAR read).
    const excerptsP = pullFilingExcerpts([...(q10.ok ? q10.data?.filings || [] : []), ...(k10.ok ? k10.data?.filings || [] : [])], { bridge: financials.bridge });

    // 2) GROUNDED WEB SEARCH - recent developments / risks / analyst view.
    const queries = [
      `${company} (${ticker}) recent news and business developments`,
      `${company} (${ticker}) risks, litigation, regulatory or accounting concerns`,
      `${company} (${ticker}) latest earnings results, guidance and analyst view`,
      `${company} (${ticker}) competitive position and market share`,
      `${company} (${ticker}) management, strategy and outlook`,
      `${company} (${ticker}) debt, liquidity and capital allocation`,
      `${company} (${ticker}) insider or institutional ownership changes`,
      `${company} (${ticker}) short interest, controversies or bear thesis`,
    ].slice(0, t.searches);
    const searchBody = (q) => ({
      model: GROUND,
      reasoning: { effort: "low" },
      messages: [{ role: "user", content: `Search the web and answer with SPECIFIC, verifiable facts - figures, dates, named events, quotes - each with a citation. Do not state a number unless a source supports it. Question: ${q}` }],
      max_tokens: 800,
      plugins: [{ id: "web", engine: "exa", max_results: 5 }],
    });
    const webResults = await Promise.all(queries.map((q) => chat(searchBody(q), SEARCH_TIMEOUT_MS, user).then(
      (d) => ({ q, answer: textOf(d), sources: webSourcesFrom(d), cost: costOf(d) }),
      () => null,
    )));
    const webGood = webResults.filter(Boolean);
    for (const r of webGood) spent += r.cost;
    const excerpts = await excerptsP;

    // 3) BUILD A UNIFIED, NUMBERED SOURCE LIST: SEC filings (real EDGAR URLs)
    // first, then deduped web citations. Everything the report cites is [n].
    const sources = [];
    const pushFiling = (f, label) => {
      if (f?.url) sources.push({ title: `${label} filed ${f.filingDate || "?"}${f.reportDate ? ` (period ${f.reportDate})` : ""} - SEC EDGAR`, url: f.url });
    };
    for (const r of [k10, q10, k8]) {
      if (r.ok) for (const f of (r.data?.filings || [])) pushFiling(f, f.form || "Filing");
    }
    const seenWeb = new Set(sources.map((s) => s.url));
    for (const r of webGood) for (const s of r.sources) if (s.url && !seenWeb.has(s.url)) { seenWeb.add(s.url); sources.push(s); }
    const numbered = sources.slice(0, t.topWeb).map((s, i) => ({ n: i + 1, ...s }));

    // 4) STRUCTURED DATA BLOCK for the synthesizer (grounding material).
    const q = quote.ok ? quote.data : null;
    const quoteBlock = q ? `Live quote (${q.symbol || ticker}): last ${q.price ?? q.last ?? "?"} ${q.currency || ""}, day range ${q.dayLow ?? "?"}-${q.dayHigh ?? "?"}, 52-week ${q.week52Low ?? q.fiftyTwoWeekLow ?? "?"}-${q.week52High ?? q.fiftyTwoWeekHigh ?? "?"}, prev close ${q.previousClose ?? "?"}, change ${q.change ?? q.changePercent ?? "?"}.` : "Live quote: unavailable.";
    const filingLines = numbered.filter((s) => s.title.includes("SEC EDGAR")).map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n") || "(no filings retrieved)";
    const insiderTrades = insider.ok ? (insider.data?.trades || insider.data?.transactions || []) : [];
    // edgar-insider-trades returns Form 4 FILINGS (who filed, when, the filing
    // URL) via full-text search - it does not parse the transaction table, so
    // there is no code/shares/price here. Represent what we actually have.
    const insiderName = (tr) => {
      const dn = Array.isArray(tr.displayNames) ? tr.displayNames : (tr.displayNames ? [tr.displayNames] : []);
      const cleaned = dn.map((n) => String(n).replace(/\s*\(CIK[^)]*\)\s*$/i, "").trim()).filter(Boolean);
      return cleaned.join("; ") || tr.reportingOwner || tr.name || tr.insider || "insider";
    };
    const insiderBlock = insiderTrades.length
      ? insiderTrades.slice(0, 25).map((tr) => `- ${insiderName(tr)} filed Form ${tr.form || "4"} on ${tr.filedDate || tr.date || tr.filedAt || "?"}`).join("\n")
      : (insider.ok ? "No Form 4 insider filings in the window." : "Insider data unavailable.");
    const webBlock = webGood.map((r, i) => `WEB ANGLE ${i + 1}: ${r.q}\n${stripInlineCites(r.answer)}`).join("\n\n") || "(web research unavailable)";
    // Web sources WITH their snippet content, so the model can only cite [n] for
    // what a source actually says - not guess a claim from a title alone.
    const webSourceLines = numbered.filter((s) => !s.title.includes("SEC EDGAR")).map((s) => `[${s.n}] ${s.title}${s.snippet ? `\n    "${s.snippet.slice(0, 320)}"` : ""} - ${s.url}`).join("\n") || "(none)";
    const financialsBlock = financials.lines.length ? financials.lines.join("\n") : "SEC XBRL financial facts unavailable for this issuer.";
    const maxCite = numbered.length;
    const excerptSrc = excerpts.filing ? numbered.find((s) => s.url === excerpts.filing.url) : null;
    const excerptBlock = excerpts.excerpts.length
      ? `Verbatim text from ${excerptSrc ? `source [${excerptSrc.n}]` : "the filing"} (${excerpts.filing.form} filed ${excerpts.filing.filingDate || "?"}). These are the filing's OWN words - cite ${excerptSrc ? `[${excerptSrc.n}]` : "the filing"} for anything taken from them.\n` +
        excerpts.excerpts.map((x, i) => `(${i + 1}) [${x.term}] "${x.text}"`).join("\n")
      : `(no filing text available${excerpts.note ? `: ${excerpts.note}` : ""} - the material below does NOT include the filing's own explanations, so where a figure is not explained here, say the material does not explain it; do not call it undisclosed or unexplained by the company)`;

    // 5) SYNTHESIZE - grounding-strict cited dossier.
    const synthPrompt = `You are a diligence analyst writing a COMPANY DUE-DILIGENCE DOSSIER on ${company} (${ticker}) that will be SOLD to a paying customer. Accuracy is paramount; a fabricated fact fails the whole report.

=== ABSOLUTE GROUNDING RULES ===
1. Use ONLY the SEC DATA, INSIDER DATA, LIVE QUOTE, and WEB RESEARCH provided below. Treat them as your only knowledge about this company.
2. Every SPECIFIC fact - financial figures, dates, share counts, prices, filing references, named events - MUST appear in the provided material. NEVER introduce a number, metric, or claim from your own training/memory. If the material lacks a figure, describe it qualitatively rather than inventing one.
3. CITATIONS: the sources are numbered [1] to [${maxCite}]. NEVER cite a number outside that range - if you cannot ground a claim in sources [1]-[${maxCite}], do not attach a citation to it. Cite every substantive claim with [n], and ONLY attach [n] to a claim that source's own text supports - for a WEB source, that means the claim appears in that source's quoted snippet or the web research; do NOT infer a source's content from its title alone. A citation is ONLY a bracketed number, e.g. [14] or [3][7] - NEVER put words, notes, ranges, or explanations inside the brackets (not "[14 for the release]", not "[13-adjacent]"), and never use a word-tag or source name like [research]/[web]/[data]/[morningstar]/[reuters] - EVERY citation must be a numbered [n] from the list, never a publication name or domain. The LIVE QUOTE, SEC XBRL FINANCIALS, and FORM 4 INSIDER data are given to you DIRECTLY - reference all three in prose WITHOUT a bracketed citation ("the live quote shows...", "the latest reported revenue was...", "Form 4 filings in the window show..."); do NOT attach a [n] to a financial figure (the specific filing that reported an XBRL fact is often not in the numbered list). The FORM 4 data is FILING METADATA ONLY - who filed and when - with NO buy/sell direction, share count, or price: report only that Form 4s were filed and by whom, and do NOT infer or state whether insiders bought or sold, or any amount.
4. Do not overstate: reproduce magnitudes and dates exactly as given. Where sources disagree or are silent, say so. Being less specific beats stating something you cannot ground.
4b. A GAP IN THIS MATERIAL IS NEVER A FINDING ABOUT THE COMPANY. If the material does not explain WHY a figure is what it is, write "the material provided here does not explain ..." - never "unexplained", "undisclosed", "cannot be reconciled" or a red flag, because the filing may explain it in text you were not given. Before characterising any gap between operating and net income, read the OPERATING-TO-NET BRIDGE (reported non-operating and tax lines) and the FILING EXCERPTS (the filing's own words); if they account for it, say what the item is and cite the excerpt's source.
5. Do NOT write a "Sources" section - a complete numbered source list is appended automatically. Prioritize COMPLETING the dossier (finish your final sentence and section) over length.

Write a thorough, well-structured dossier of up to ${t.words} words, with these sections where the material supports them: an opening SNAPSHOT (what the company is, current quote, one-paragraph bottom line), BUSINESS & RECENT FILINGS (what the latest 10-K/10-Q/8-K disclose), FINANCIAL POSTURE, RECENT DEVELOPMENTS (from the web research), INSIDER ACTIVITY (which insiders filed Form 4s and when - NOT buy/sell direction or amounts, which these filings do not contain), RISKS & RED FLAGS, and a closing DILIGENCE READ (the balanced takeaway). Be specific and analytical, not a data dump; call out what matters for someone deciding whether to trust, invest in, or partner with this company.${focus.length ? `\nEmphasize: ${focus.join(", ")}.` : ""}

=== LIVE QUOTE ===\n${quoteBlock}
=== SEC XBRL FINANCIALS (reported figures - reference in prose, no bracket) ===\n${financialsBlock}
=== SEC FILINGS (numbered sources) ===\n${filingLines}
=== FILING EXCERPTS (verbatim, from the newest 10-Q/10-K) ===\n${excerptBlock}
=== FORM 4 INSIDER FILINGS (last ${t.insiderDays} days - filing metadata only: NO buy/sell, share count, or price) ===\n${insiderBlock}
=== WEB RESEARCH ===\n${webBlock}
=== WEB SOURCES (numbered, with snippet content) ===\n${webSourceLines}`;

    const sd = await chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Dossier synthesis produced nothing - not charged", 502);

    const sourceList = numbered.map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n");
    const dossier = sourceList ? `${prose}\n\n## Sources\n${sourceList}` : prose;

    // Downloadable DATA APPENDIX - the structured tables the prose is grounded
    // in, so the buyer gets a spreadsheet-ready dataset, not only narrative.
    const insiderRows = insiderTrades.slice(0, 100).map((tr) => [
      insiderName(tr),
      String(tr.form || "4"),
      String(tr.filedDate || tr.date || tr.filedAt || ""),
      String(tr.url || tr.link || ""),
    ]);
    const tables = [];
    if (insiderRows.length) tables.push({
      name: "insider-filings", label: "Form 4 insider filings",
      columns: ["Insider", "Form", "Filed", "Filing URL"], rows: insiderRows,
    });
    if (financials.rows.length) tables.push({
      name: "financials", label: "SEC XBRL financials",
      columns: ["Metric", "Latest annual", "Annual period", "Most recent", "Recent period"],
      rows: financials.rows.map((r) => [r.metric, r.latestAnnual, r.annualPeriod, r.mostRecent, r.recentPeriod]),
    });

    const meta = {
      disclaimer: "Research and analysis from public filings and public sources. Not investment advice and not a recommendation to buy, sell or hold any security. Verify against the primary filings before acting.",
      tier: tierSlug, company, ticker,
      filings_10k: (k10.ok && k10.data?.filings?.length) || 0,
      filings_10q: (q10.ok && q10.data?.filings?.length) || 0,
      filings_8k: (k8.ok && k8.data?.filings?.length) || 0,
      insider_filings: insiderTrades.length,
      web_angles: webGood.length,
      sources_cited: numbered.length,
      synthesis_model: SYNTH,
    };
    const out = format === "json"
      ? { dossier, company, ticker, sources: numbered, tables, meta }
      : { dossier, company, ticker, sources: numbered, tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { webAnswers: webGood.map((r) => ({ q: r.q, answer: r.answer })), quoteBlock, insiderBlock, financialsBlock, bridge: financials.bridge, excerptBlock, webSources: numbered.filter((s) => !s.title.includes("SEC EDGAR")).map((s) => ({ n: s.n, snippet: s.snippet })) };
    // A composite that CALLS this one in-process passes `accountAs`, so the sale is
    // booked once against the product the buyer actually paid for; the caller folds
    // this leg's spend into its own. Direct callers are unaffected.
    if (input?.accountAs) input.accountAs(spent);
    else recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(DOSSIER_TIERS[tierSlug]) });
    return out;
  };
}

const SCHEMA = {
  type: "object",
  required: ["ticker"],
  properties: {
    ticker: { type: "string", description: "US stock ticker to investigate, e.g. AAPL." },
    focus: { type: "array", items: { type: "string" }, description: "Optional aspects to emphasize (<= 8), e.g. [\"litigation\", \"debt\"]." },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown dossier)." },
  },
};
const OUT_EXAMPLE = {
  dossier: "# Due-Diligence Dossier: Example Corp (EXMP)\n\n## Snapshot\nExample Corp trades at ... [1]\n\n## Sources\n[1] 10-K filed ... - https://www.sec.gov/...",
  company: "Example Corp", ticker: "EXMP",
  sources: [{ n: 1, title: "10-K filed 2025-11-01 - SEC EDGAR", url: "https://www.sec.gov/..." }],
  tables: [{ name: "financials", label: "SEC XBRL financials", columns: ["Metric", "Latest annual", "Annual period", "Most recent", "Recent period"], rows: [["Total revenue", "$1.2B", "FY 2024 10-K filed 2025-11-01", "$0.3B", "2025-09-30 (10-Q)"]] }],
  meta: { tier: "dossier", company: "Example Corp", ticker: "EXMP", filings_10k: 1, filings_10q: 3, filings_8k: 5, insider_filings: 8, web_angles: 4, sources_cited: 18, synthesis_model: "anthropic/claude-opus-5" },
};

export const DOSSIER_TOOLS = [
  {
    route: "POST /v1/dossier", name: "Company due-diligence dossier (grounded, cited)", slug: "dossier", category: "llm", price: DOSSIER_TIERS["dossier"].price,
    description: "Hand over a ticker and get one due-diligence dossier back. Pulls the company's SEC EDGAR filings (10-K / 10-Q / 8-K) and Form 4 insider trades, a live quote, and grounded web research on recent developments and risks, then synthesizes a ~2,400-word cited dossier - business, financial posture, insider activity, red flags, and a balanced diligence read. Grounded in real SEC data, not a generic web guess. One payment, one report. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["research", "due-diligence", "company", "sec", "edgar", "filings", "insider", "stocks", "dossier", "premium", "agent"],
    discovery: { bodyType: "json", input: { ticker: "AAPL", focus: ["risks"] }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeDossierHandler("dossier"),
  },
  {
    route: "POST /v1/dossier/max", name: "Company due-diligence dossier - MAX (exhaustive)", slug: "dossier-max", category: "llm", price: DOSSIER_TIERS["dossier-max"].price,
    description: "The exhaustive due-diligence tier: more filings, a full year of Form 4 insider activity, wider web research (up to 8 angles), the widest source set, and a ~2,800-word cited dossier with a full source table. For a decision that warrants real diligence. USDC or card (Stripe). Not cached.",
    tags: ["research", "due-diligence", "company", "sec", "edgar", "filings", "insider", "stocks", "dossier", "premium", "agent"],
    discovery: { bodyType: "json", input: { ticker: "AAPL", focus: ["debt", "litigation"] }, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "dossier-max" } } } },
    handler: makeDossierHandler("dossier-max"),
  },
];

// Upstream-usage telemetry wrapper: a successful run records its exact spend at
// the return site; a failed run (thrown >= 400, not charged) is recorded here
// so the burn on failures is visible too (spend unknown at this point -> 0).
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
export function makeDossierHandler(tierSlug) {
  const run = makeDossierHandlerInner(tierSlug);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(DOSSIER_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}
