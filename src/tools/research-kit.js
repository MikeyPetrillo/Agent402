// Research-kit — composite tools that fan out to multiple underlying kits
// in parallel and merge into one priced response. The thesis: agents
// frequently want "everything I need to look at company X" or "everything
// I need to look at the US economy this week," which today means 5–6
// sequential paid calls. Bundle them: cheaper per-call (single fee), one
// upstream burst (Promise.allSettled), and a stable wire shape an agent
// can render as a card without LLM mediation.
//
// Implementation note: we re-use existing tool handlers by importing the
// kit arrays and looking up by slug. This is deliberately tight coupling
// — if a sub-tool's input shape changes, this composite catches it at
// the next CI run via the answers-its-own-example check.
//
// Failure model: Promise.allSettled — a single 5xx from EDGAR or Brave
// must never tank the whole composite. Each section in the response is
// either { ok: true, data } or { ok: false, error }, so the agent sees
// exactly which sub-call failed and can decide whether to retry.

import { EDGAR_TOOLS } from "./edgar-kit.js";
import { FINANCE_TOOLS } from "./finance-kit.js";
import { SEARCH_TOOLS } from "./search.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Resolve a handler by slug from any kit. Throws if missing — that means
// a kit got renamed and this composite is stale; fail loudly so CI catches it.
function getHandler(kit, slug) {
  const t = kit.find((x) => x.slug === slug);
  if (!t) throw bad(`research-kit: missing dependency tool '${slug}' — sub-kit may have been renamed`, 500);
  return t.handler;
}

// settle(fn, input) → { ok: true, data } | { ok: false, error, statusCode }
// We never throw; the composite always returns 200 with per-section status.
async function settle(label, fn, input) {
  try {
    const data = await fn(input);
    return { section: label, ok: true, data };
  } catch (e) {
    return {
      section: label,
      ok: false,
      error: e?.message || String(e),
      statusCode: e?.statusCode ?? 500,
    };
  }
}

export const RESEARCH_TOOLS = [
  {
    route: "GET /api/research-company",
    name: "Company research dossier",
    slug: "research-company",
    category: "research",
    price: "$0.10",
    description:
      "One-shot company research dossier for a US-listed ticker: recent 10-K / 10-Q / 8-K filings, Form 4 insider trades (last 90 days), live stock quote, and recent news headlines — all merged into a single deterministic JSON response. Fans out to EDGAR, Yahoo Finance, and an independent news index in parallel. Each section reports its own ok/error status so a partial upstream outage degrades gracefully instead of failing the whole call. Replaces ~5 sequential paid calls with one. ?ticker=AAPL",
    tags: ["research", "company", "dossier", "edgar", "stocks", "filings", "news", "insider", "composite", "premium"],
    discovery: {
      input: { ticker: "AAPL" },
      inputSchema: {
        properties: {
          ticker: { type: "string", description: "US stock ticker, e.g. AAPL" },
          filingsLimit: { type: "number", description: "Max filings per form, 1-25 (default 5)" },
          insiderDays: { type: "number", description: "Insider lookback window in days, 1-365 (default 90)" },
          newsCount: { type: "number", description: "News headlines to return, 1-20 (default 8)" },
        },
        required: ["ticker"],
      },
      output: {
        example: {
          ticker: "AAPL",
          generatedAt: "2026-06-19T18:00:00.000Z",
          quote: { ok: true, data: { symbol: "AAPL", price: 232.1 } },
          filings10K: { ok: true, data: { count: 1, filings: [] } },
          filings10Q: { ok: true, data: { count: 4, filings: [] } },
          filings8K: { ok: true, data: { count: 5, filings: [] } },
          insiderTrades: { ok: true, data: { total: 8, trades: [] } },
          news: { ok: true, data: { count: 8, results: [] } },
          sources: ["SEC EDGAR", "Yahoo Finance", "Brave Search"],
        },
      },
    },
    handler: async (i) => {
      const ticker = String(i.ticker ?? "").trim().toUpperCase();
      if (!ticker) throw bad('"ticker" is required');
      if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) throw bad("ticker must be a short alphanumeric symbol");

      const filingsLimit = Math.min(Math.max(parseInt(i.filingsLimit, 10) || 5, 1), 25);
      const insiderDays = Math.min(Math.max(parseInt(i.insiderDays, 10) || 90, 1), 365);
      const newsCount = Math.min(Math.max(parseInt(i.newsCount, 10) || 8, 1), 20);

      const edgarFilings = getHandler(EDGAR_TOOLS, "edgar-filings");
      const edgarInsider = getHandler(EDGAR_TOOLS, "edgar-insider-trades");
      const stockQuote = getHandler(FINANCE_TOOLS, "stock-quote");
      const searchNews = getHandler(SEARCH_TOOLS, "search-news");

      const [quote, filings10K, filings10Q, filings8K, insiderTrades, news] = await Promise.all([
        settle("quote", stockQuote, { symbol: ticker }),
        settle("filings10K", edgarFilings, { ticker, form: "10-K", limit: filingsLimit }),
        settle("filings10Q", edgarFilings, { ticker, form: "10-Q", limit: filingsLimit }),
        settle("filings8K", edgarFilings, { ticker, form: "8-K", limit: filingsLimit }),
        settle("insiderTrades", edgarInsider, { ticker, days: insiderDays, limit: filingsLimit * 4 }),
        settle("news", searchNews, { q: `${ticker} stock`, count: newsCount, freshness: "pw" }),
      ]);

      // Pull the most useful metadata up to the top level: company name
      // (from any filings call that succeeded), CIK, and a count of
      // sections that returned data. Agents asking "did this work?" can
      // check sectionsOk without walking the whole shape.
      const nameFrom = [filings10K, filings10Q, filings8K, insiderTrades].find((s) => s.ok && s.data?.name);
      const name = nameFrom?.data?.name ?? null;
      const cik = nameFrom?.data?.cik ?? null;
      const sections = [quote, filings10K, filings10Q, filings8K, insiderTrades, news];
      const sectionsOk = sections.filter((s) => s.ok).length;

      return {
        ticker,
        name,
        cik,
        generatedAt: new Date().toISOString(),
        sectionsOk,
        sectionsTotal: sections.length,
        quote,
        filings10K,
        filings10Q,
        filings8K,
        insiderTrades,
        news,
        sources: ["SEC EDGAR (data.sec.gov, efts.sec.gov)", "Yahoo Finance", "Brave Search (news index)"],
      };
    },
  },
];
