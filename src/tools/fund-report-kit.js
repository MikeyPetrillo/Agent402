// fund-report-kit — Fund Portfolio Report (13F). Hand over an institutional
// manager (a name like "Berkshire Hathaway", a ticker, or a SEC CIK) and get one
// cited report on what they hold and, crucially, what they BOUGHT, ADDED,
// TRIMMED, and EXITED last quarter - diffed from the manager's two most recent
// 13F-HR filings. This is data a chatbot cannot reach (it parses the live
// informationtable.xml off SEC EDGAR) delivered as a finished, packaged report
// with a downloadable holdings + changes appendix.
//
// Same discipline as dossier/research: grounding-strict Opus synthesis (every
// figure traces to the 13F data or a cited web source), deterministic source
// list appended in code, settlement-safe (any upstream failure throws >=400 so
// the buyer is not charged), cost read internally and never returned,
// WALLET_ONLY, not cached. Pure SEC data for the core (no extra upstream wallet);
// gated on OPENROUTER_API_KEY for the synthesis (503 without it).
import { fetchOpenRouter, throwUpstreamError, bad, upstreamUserId } from "./llm-gateway-kit.js";
import { recordCompositeUsage } from "../composite-spend-guard.js";
import { get13fHoldings, resolveManager } from "./edgar-kit.js";

function safeUser(req) { try { return req ? upstreamUserId(req) : undefined; } catch { return undefined; } }

const SYNTH = "anthropic/claude-opus-5";
const GROUND = "google/gemini-3.6-flash"; // grounded web search + read. gemini-3.6-flash since 2026-09-23 (2.5-flash expires upstream 2026-10-20); it reasons by default, so the search call passes reasoning:low - measured: default spent 460 of 600 tokens thinking, low returned the full cited answer at the same cost.

export const FUND_TIERS = {
  "fund-report": { price: "$0.60", maxUpstreamUsd: 0.35, topN: 15, changeRows: 20, searches: 2, synthMaxTokens: 4500, words: "~1,500" },
  "fund-report-max": { price: "$0.85", maxUpstreamUsd: 0.5, topN: 30, changeRows: 30, searches: 3, synthMaxTokens: 6500, words: "~2,400" },
};
export const FUND_MODELS = [SYNTH, GROUND];

const MAX_MANAGER_CHARS = 120;
const SEARCH_TIMEOUT_MS = 60_000;
const SYNTH_TIMEOUT_MS = 120_000;
const DATA_TIMEOUT_MS = 30_000;

async function chat(body, timeoutMs, user) {
  const res = await fetchOpenRouter({ ...body, ...(user ? { user } : {}), usage: { include: true } }, { timeoutMs });
  if (!res.ok) await throwUpstreamError(res);
  return res.json();
}
const costOf = (d) => Number(d?.usage?.cost) || 0;
const textOf = (d) => (d?.choices?.[0]?.message?.content || "").trim();
function stripInlineCites(s) {
  return String(s || "")
    .replace(/\[([^\]]+)\]\((?:https?:)?\/\/[^)]+\)/g, "$1")
    .replace(/\[[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(?:\s*,\s*[a-z0-9][a-z0-9.\-]*\.[a-z]{2,})*\]/gi, "")
    .replace(/[ \t]{2,}/g, " ").trim();
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
// settle: never throw from a data leg.
async function settle(p, timeoutMs) {
  try {
    const data = timeoutMs ? await Promise.race([p, new Promise((_, r) => setTimeout(() => r(bad("timeout", 504)), timeoutMs))]) : await p;
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
function fmtUsd(v) {
  if (v == null || !Number.isFinite(Number(v))) return "?";
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toLocaleString("en-US")}`;
}
const numShares = (h) => Number(h?.shares) || 0;
const numVal = (h) => Number(h?.valueUsd) || 0;

// A 13F info-table has one ROW per (security, investment discretion, voting)
// split, and options share the underlying's CUSIP. Aggregate to one row per
// economic POSITION (cusip + put/call + class), summing shares and value, so
// concentration and the quarter diff are per position, not per filing row
// (otherwise duplicate rows on one CUSIP net incorrectly and a real position
// can vanish from the changes section).
function positionKey(h) { return `${h.cusip}|${h.putCall || ""}|${h.titleOfClass || ""}`; }
function aggregateHoldings(holdings) {
  const m = new Map();
  for (const h of holdings || []) {
    if (!h || !h.cusip) continue;
    const k = positionKey(h);
    const cur = m.get(k) || { key: k, issuer: h.issuer || "?", cusip: h.cusip, titleOfClass: h.titleOfClass || "", putCall: h.putCall || "", shares: 0, valueUsd: 0 };
    cur.shares += numShares(h);
    cur.valueUsd += numVal(h);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.valueUsd - a.valueUsd);
}
// Diff two AGGREGATED holdings lists (per-position) by position key. Returns
// per-position action rows (NEW / ADD / TRIM / HOLD / EXIT) with share deltas.
function diff13f(latestAgg, priorAgg) {
  const L = new Map((latestAgg || []).map((x) => [x.key, x]));
  const P = new Map((priorAgg || []).map((x) => [x.key, x]));
  const rows = [];
  for (const [k, l] of L) {
    const p = P.get(k);
    const ls = l.shares, ps = p ? p.shares : 0;
    let action;
    if (!p) action = "NEW";
    else if (ls > ps) action = "ADD";
    else if (ls < ps) action = "TRIM";
    else action = "HOLD";
    rows.push({ issuer: l.issuer, cusip: l.cusip, action, shares: ls, priorShares: ps, sharesDelta: ls - ps, valueUsd: l.valueUsd, putCall: l.putCall });
  }
  if (priorAgg) for (const [k, p] of P) if (!L.has(k)) rows.push({ issuer: p.issuer, cusip: p.cusip, action: "EXIT", shares: 0, priorShares: p.shares, sharesDelta: -p.shares, valueUsd: 0, putCall: p.putCall });
  return rows;
}
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "?");

function makeFundHandlerInner(tierSlug) {
  const t = FUND_TIERS[tierSlug];
  return async (input, req) => {
    if (!input || typeof input !== "object") throw bad('Body must be a JSON object: {"manager": "Berkshire Hathaway"}');
    const manager = String(input.manager ?? input.name ?? "").trim();
    const cikIn = input.cik != null ? String(input.cik).trim() : "";
    const tickerIn = typeof input.ticker === "string" ? input.ticker.trim() : "";
    if (!manager && !cikIn && !tickerIn) throw bad('"manager" (a fund name, ticker, or SEC CIK) is required');
    if (manager.length > MAX_MANAGER_CHARS) throw bad(`"manager" too long (max ${MAX_MANAGER_CHARS} chars)`);
    const format = input.format === "json" ? "json" : "markdown";
    const user = safeUser(req);

    // 1) RESOLVE the manager, then pull the two most recent 13F-HR filings.
    const resolved = await resolveManager({ cik: cikIn || undefined, ticker: tickerIn || undefined, name: manager || undefined });
    // The prior quarter is retried once; a read that still fails is a 502 (not
    // charged), because "no prior quarter exists" was being written into the
    // report for a timeout on an 11 MB table. get13fHoldings returns null ONLY
    // when the manager genuinely has no earlier 13F-HR.
    const [latest, priorR] = await Promise.all([
      get13fHoldings({ cik: resolved.cik, index: 0 }),
      settle(get13fHoldings({ cik: resolved.cik, index: 1 }), DATA_TIMEOUT_MS).then(async (r) => (r.ok ? r : settle(get13fHoldings({ cik: resolved.cik, index: 1 }), DATA_TIMEOUT_MS))),
    ]);
    if (!latest || !latest.holdings || !latest.holdings.length) throw bad(`No 13F-HR holdings found for "${manager || resolved.cik}" - confirm this is an institutional manager (>$100M AUM). Not charged.`, 422);
    if (!priorR.ok) throw bad(`The prior-quarter 13F-HR for "${manager || resolved.cik}" exists but could not be read from SEC EDGAR (${String(priorR.error).slice(0, 120)}). Not charged - please retry.`, 502);
    const prior = priorR.data;
    const managerName = latest.managerName || resolved.name || manager || `CIK ${resolved.cik}`;

    const latestAgg = aggregateHoldings(latest.holdings);
    const priorAgg = prior ? aggregateHoldings(prior.holdings) : null;
    const totalValue = latestAgg.reduce((a, h) => a + h.valueUsd, 0) || latest.totalValueUsd || 0;
    const positions = latestAgg.length;
    const changes = diff13f(latestAgg, priorAgg);
    const bySignal = (arr, a) => arr.filter((r) => r.action === a);
    // ADD/TRIM ranked by the DOLLAR SIZE OF THE CHANGE (|share delta| at the
    // current implied price), not by position size: sorted by value, a 1% trim
    // of the largest holding outranked a 90% cut of a mid-size one.
    const changeUsd = (r) => Math.abs(r.sharesDelta) * (r.shares > 0 ? r.valueUsd / r.shares : 0);
    const news = bySignal(changes, "NEW").sort((a, b) => b.valueUsd - a.valueUsd);
    const adds = bySignal(changes, "ADD").sort((a, b) => changeUsd(b) - changeUsd(a));
    const trims = bySignal(changes, "TRIM").sort((a, b) => changeUsd(b) - changeUsd(a));
    const exits = bySignal(changes, "EXIT").sort((a, b) => b.priorShares - a.priorShares);
    const cap = t.changeRows || 12;

    // 2) OPTIONAL grounded web research on the manager (non-fatal).
    const queries = [
      `${managerName} 13F portfolio latest quarter positions and strategy`,
      `${managerName} recent investment moves, new positions, or exits`,
      `${managerName} fund performance, assets under management, and outlook`,
    ].slice(0, t.searches);
    const searchBody = (q) => ({
      model: GROUND,
      reasoning: { effort: "low" },
      messages: [{ role: "user", content: `Search the web and answer with SPECIFIC, verifiable facts - figures, dates, named positions - each with a citation. Do not state a number unless a source supports it. Question: ${q}` }],
      max_tokens: 700,
      plugins: [{ id: "web", engine: "exa", max_results: 5 }],
    });
    let spent = 0;
    const webResults = await Promise.all(queries.map((q) => chat(searchBody(q), SEARCH_TIMEOUT_MS, user).then(
      (d) => ({ q, answer: textOf(d), sources: webSourcesFrom(d), cost: costOf(d) }),
      () => null,
    )));
    const webGood = webResults.filter(Boolean);
    for (const r of webGood) spent += r.cost;

    // 3) NUMBERED SOURCES: the 13F filings (real SEC URLs) first, then web.
    const sources = [];
    if (latest.informationTableUrl) sources.push({ title: `13F-HR holdings filed ${latest.filedDate || "?"} (period ${latest.reportDate || "?"}) - SEC EDGAR`, url: latest.informationTableUrl });
    if (prior && prior.informationTableUrl) sources.push({ title: `Prior 13F-HR holdings filed ${prior.filedDate || "?"} (period ${prior.reportDate || "?"}) - SEC EDGAR`, url: prior.informationTableUrl });
    const seen = new Set(sources.map((s) => s.url));
    for (const r of webGood) for (const s of r.sources) if (s.url && !seen.has(s.url)) { seen.add(s.url); sources.push(s); }
    const numbered = sources.slice(0, 40).map((s, i) => ({ n: i + 1, ...s }));
    const maxCite = numbered.length;

    // 4) GROUNDING BLOCKS for the synthesizer.
    const topHoldings = latestAgg.slice(0, t.topN).map((h, i) =>
      `${i + 1}. ${h.issuer || "?"} ${h.putCall ? `(${h.putCall}) ` : ""}- ${fmtUsd(h.valueUsd)} (${pct(h.valueUsd, totalValue)} of portfolio), ${h.shares.toLocaleString("en-US")} shares`).join("\n");
    const changeBlock = prior
      ? [
          `(${cap} largest shown per bucket, of the counts in parentheses; the full change set is in the data appendix)`,
          `NEW positions (${news.length}): ${news.slice(0, cap).map((r) => `${r.issuer} ${fmtUsd(r.valueUsd)}`).join("; ") || "none"}`,
          `ADDED to (${adds.length}): ${adds.slice(0, cap).map((r) => `${r.issuer} +${r.sharesDelta.toLocaleString("en-US")} sh (+${pct(r.sharesDelta, r.priorShares)} vs prior ${r.priorShares.toLocaleString("en-US")} sh, ~${fmtUsd(changeUsd(r))})`).join("; ") || "none"}`,
          `TRIMMED (${trims.length}): ${trims.slice(0, cap).map((r) => `${r.issuer} ${r.sharesDelta.toLocaleString("en-US")} sh (-${pct(-r.sharesDelta, r.priorShares)} of prior ${r.priorShares.toLocaleString("en-US")} sh, ~${fmtUsd(changeUsd(r))})`).join("; ") || "none"}`,
          `EXITED (${exits.length}): ${exits.slice(0, cap).map((r) => `${r.issuer} (was ${r.priorShares.toLocaleString("en-US")} sh)`).join("; ") || "none"}`,
          ...((latest.cover?.confidentialOmitted || prior.cover?.confidentialOmitted) ? [`CAUTION: ${latest.cover?.confidentialOmitted ? "the LATEST" : "the PRIOR"} filing's cover declares confidential treatment (isConfidentialOmitted=true): positions were withheld and will appear in a later 13F-HR/A. NEW and EXIT rows are therefore UNRELIABLE for this quarter - say so, and do not call any position new or exited with confidence.`] : []),
          ...(latest.amendments?.length ? [`Amendments folded into the latest quarter: ${latest.amendments.map((a) => `${a.amendmentType} filed ${a.filedDate}${a.applied ? ` (${a.rows} rows applied)` : " (not applied)"}`).join("; ")}.`] : []),
          ...(prior.amendments?.length ? [`Amendments folded into the prior quarter: ${prior.amendments.map((a) => `${a.amendmentType} filed ${a.filedDate}${a.applied ? ` (${a.rows} rows applied)` : " (not applied)"}`).join("; ")}.`] : []),
        ].join("\n")
      : "No prior-quarter 13F-HR exists on EDGAR for this manager (this is their first), so quarter-over-quarter changes cannot be computed - report the current holdings only and say so.";
    const webBlock = webGood.map((r, i) => `WEB ANGLE ${i + 1}: ${r.q}\n${stripInlineCites(r.answer)}`).join("\n\n") || "(web research unavailable)";
    const webSourceLines = numbered.filter((s) => !s.title.includes("SEC EDGAR")).map((s) => `[${s.n}] ${s.title}${s.snippet ? `\n    "${s.snippet.slice(0, 300)}"` : ""} - ${s.url}`).join("\n") || "(none)";

    // 5) SYNTHESIZE - grounding-strict fund report.
    const synthPrompt = `You are an investment analyst writing a FUND PORTFOLIO REPORT on ${managerName} (SEC CIK ${resolved.cik}) that will be SOLD to a paying customer. Accuracy is paramount; a fabricated figure fails the whole report.

=== ABSOLUTE GROUNDING RULES ===
1. Use ONLY the 13F HOLDINGS data, the QUARTER-OVER-QUARTER CHANGES, and the WEB RESEARCH provided below. Treat them as your only knowledge about this manager.
2. Every SPECIFIC fact - dollar values, share counts, position sizes, percentages, dates - MUST appear in the provided material. NEVER introduce a number from your own training/memory.
3. CITATIONS: the sources are numbered [1] to [${maxCite}]. Attach [n] only to a claim that source's own text supports, and never cite a number outside 1-${maxCite}. The 13F HOLDINGS and CHANGES are given to you directly: reference them in prose ("the latest 13F shows...", "quarter over quarter they added...") WITHOUT a bracket; use [n] for web-sourced claims and the filing sources [1]/[2]. A citation is ONLY a bracketed number like [3] - never a word or name inside the brackets.
4. IMPORTANT CAVEATS you MUST state plainly in the report: a 13F-HR reports only LONG US-listed equity/option positions, is filed up to 45 days after quarter-end (so it is a lagged snapshot, not real-time), and excludes shorts, cash, non-US holdings, and most fixed income. Do not present it as the manager's complete book.
5. Do not overstate: reproduce magnitudes and dates exactly as given. Do NOT write a "Sources" section - a numbered source list is appended automatically. Prioritize COMPLETING the report over length.
6. A GAP IN THIS MATERIAL IS NEVER A FINDING ABOUT THE MANAGER: only the largest rows of each change bucket are listed (the counts say how many there are); write "the material provided here lists ..." rather than "the fund made no other moves". Honour every CAUTION line about confidential treatment.

Write a thorough, well-structured report of up to ${t.words} words with these sections where the material supports them: SNAPSHOT (the manager, reported portfolio value, number of positions, the report period and filing date), TOP HOLDINGS (the largest positions and how concentrated the book is), PORTFOLIO CHANGES (what they bought/added/trimmed/exited versus the prior quarter - this is the most important section), NOTABLE MOVES & WHAT THEY SIGNAL (interpret the biggest changes), and a CLOSING READ. Be specific and analytical.

=== MANAGER ===\n${managerName} (CIK ${resolved.cik}). Latest 13F-HR period ${latest.reportDate || "?"}, filed ${latest.filedDate || "?"}. Reported 13F portfolio value ${fmtUsd(totalValue)} across ${positions} positions${latest.cover ? ` (cover page: ${latest.cover.tableEntryTotal ?? "?"} entries, ${latest.cover.otherIncludedManagersCount || 0} other included managers, confidential treatment ${latest.cover.confidentialOmitted ? "YES" : "no"})` : ""}.${prior ? ` Prior 13F-HR period ${prior.reportDate || "?"}${prior.cover?.confidentialOmitted ? " (confidential treatment declared)" : ""}.` : ""}
=== TOP HOLDINGS (latest 13F, by value) ===\n${topHoldings}
=== QUARTER-OVER-QUARTER CHANGES ===\n${changeBlock}
=== WEB RESEARCH ===\n${webBlock}
=== WEB SOURCES (numbered, with snippet content) ===\n${webSourceLines}`;

    const sd = await chat({ model: SYNTH, messages: [{ role: "user", content: synthPrompt }], max_tokens: t.synthMaxTokens, reasoning: { enabled: false } }, SYNTH_TIMEOUT_MS, user);
    spent += costOf(sd);
    const prose = textOf(sd);
    if (!prose) throw bad("Fund report synthesis produced nothing - not charged", 502);

    const sourceList = numbered.map((s) => `[${s.n}] ${s.title} - ${s.url}`).join("\n");
    const report = sourceList ? `${prose}\n\n## Sources\n${sourceList}` : prose;

    // 6) DOWNLOADABLE DATA APPENDIX.
    const tables = [];
    tables.push({
      name: "holdings", label: "13F holdings (latest)",
      columns: ["Issuer", "Class", "CUSIP", "Shares", "Value (USD)", "% of portfolio", "Put/Call"],
      rows: latestAgg.map((h) => [h.issuer || "", h.titleOfClass || "", h.cusip || "", String(h.shares), String(h.valueUsd), pct(h.valueUsd, totalValue), h.putCall || ""]),
    });
    if (prior) tables.push({
      name: "changes", label: "Quarter-over-quarter changes",
      columns: ["Issuer", "CUSIP", "Action", "Shares", "Prior shares", "Shares change", "Value (USD)"],
      rows: changes.sort((a, b) => b.valueUsd - a.valueUsd || Math.abs(b.sharesDelta) - Math.abs(a.sharesDelta))
        .map((r) => [r.issuer, r.cusip, r.action, String(r.shares), String(r.priorShares), String(r.sharesDelta), String(r.valueUsd)]),
    });

    const meta = {
      tier: tierSlug, manager: managerName, cik: resolved.cik,
      report_period: latest.reportDate || null, filed: latest.filedDate || null,
      prior_period: prior ? (prior.reportDate || null) : null,
      positions, portfolio_value_usd: totalValue,
      new_positions: news.length, exited_positions: exits.length,
      added: adds.length, trimmed: trims.length,
      web_angles: webGood.length, sources_cited: numbered.length, synthesis_model: SYNTH,
    };
    const out = { report, manager: managerName, cik: resolved.cik, sources: numbered, tables, meta };
    if (process.env.RESEARCH_DEBUG === "1") out._debug = { changeBlock, topHoldings, webAnswers: webGood.map((r) => ({ q: r.q, answer: r.answer })) };
    recordCompositeUsage({ slug: tierSlug, upstreamUsd: spent, ok: true, priceUsd: priceUsdOf(FUND_TIERS[tierSlug]) });
    return out;
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    manager: { type: "string", description: "Institutional manager: a fund/firm name (e.g. \"Berkshire Hathaway\"), a ticker, or a SEC CIK." },
    cik: { type: "string", description: "SEC CIK of the manager (alternative to manager/ticker)." },
    ticker: { type: "string", description: "US ticker of a publicly-traded manager (alternative to manager/cik)." },
    format: { type: "string", enum: ["markdown", "json"], description: "Response shape (default markdown report)." },
  },
};
const OUT_EXAMPLE = {
  report: "# Fund Portfolio Report: Example Capital (CIK 0001234567)\n\n## Snapshot\nExample Capital reported a $4.2B 13F portfolio across 42 positions...\n\n## Sources\n[1] 13F-HR holdings filed ... - https://www.sec.gov/...",
  manager: "Example Capital Management LLC", cik: "0001234567",
  sources: [{ n: 1, title: "13F-HR holdings filed 2025-11-14 (period 2025-09-30) - SEC EDGAR", url: "https://www.sec.gov/..." }],
  tables: [{ name: "changes", label: "Quarter-over-quarter changes", columns: ["Issuer", "CUSIP", "Action", "Shares", "Prior shares", "Shares change", "Value (USD)"], rows: [["APPLE INC", "037833100", "ADD", "905560000", "850000000", "55560000", "176558000000"]] }],
  meta: { tier: "fund-report", manager: "Example Capital Management LLC", cik: "0001234567", report_period: "2025-09-30", positions: 42, portfolio_value_usd: 4200000000, new_positions: 3, exited_positions: 2, sources_cited: 8, synthesis_model: "anthropic/claude-opus-5" },
};

export const FUND_TOOLS = [
  {
    route: "POST /v1/fund", name: "Fund portfolio report (13F, grounded)", slug: "fund-report", category: "llm", price: FUND_TIERS["fund-report"].price,
    description: "Hand over an institutional manager (a fund name like \"Berkshire Hathaway\", a ticker, or a SEC CIK) and get one cited report on what they hold and what they BOUGHT, ADDED, TRIMMED, and EXITED last quarter - diffed from their two most recent SEC 13F-HR filings, with a downloadable holdings + changes appendix. Data a chatbot can't reach (parsed live off SEC EDGAR). One payment, one report. USDC (x402/MPP) or card (Stripe). Not cached.",
    tags: ["research", "13f", "fund", "institutional", "holdings", "sec", "edgar", "portfolio", "hedge-fund", "premium", "agent"],
    discovery: { bodyType: "json", input: { manager: "Berkshire Hathaway" }, inputSchema: SCHEMA, output: { example: OUT_EXAMPLE } },
    handler: makeFundHandler("fund-report"),
  },
  {
    route: "POST /v1/fund/max", name: "Fund portfolio report - MAX (deep)", slug: "fund-report-max", category: "llm", price: FUND_TIERS["fund-report-max"].price,
    description: "The deep tier: the full holdings table, wider quarter-over-quarter change analysis, more grounded web research, and a longer cited report on the manager's positioning. USDC or card (Stripe). Not cached.",
    tags: ["research", "13f", "fund", "institutional", "holdings", "sec", "edgar", "portfolio", "hedge-fund", "premium", "agent"],
    discovery: { bodyType: "json", input: { manager: "Scion Asset Management" }, inputSchema: SCHEMA, output: { example: { ...OUT_EXAMPLE, meta: { ...OUT_EXAMPLE.meta, tier: "fund-report-max" } } } },
    handler: makeFundHandler("fund-report-max"),
  },
];

// Upstream-usage telemetry wrapper: a successful run records its exact spend at
// the return site; a failed run (thrown >= 400, not charged) is recorded here
// so the burn on failures is visible too (spend unknown at this point -> 0).
const priceUsdOf = (t) => Number(String(t?.price ?? "").replace(/[^0-9.]/g, "")) || null;
export function makeFundHandler(tierSlug) {
  const run = makeFundHandlerInner(tierSlug);
  return async (input, req) => {
    try { return await run(input, req); }
    catch (e) { try { recordCompositeUsage({ slug: tierSlug, upstreamUsd: 0, ok: false, priceUsd: priceUsdOf(FUND_TIERS[tierSlug]) }); } catch { /* never mask the real error */ } throw e; }
  };
}
