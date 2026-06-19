// EDGAR-kit — SEC EDGAR (data.sec.gov + www.sec.gov) wrappers for the data agents
// actually want: a ticker→CIK resolver, recent filings (10-K / 10-Q / 8-K / 4 /
// etc.), and XBRL financial-statement data — both per-company (company-concept,
// company-facts) and cross-company (the "frames" snapshot that lets you screen
// every issuer reporting a given tag in a given period in one call).
//
// Notes on the upstream:
//
//   • Every EDGAR request MUST include a User-Agent in the form
//     "Name email@domain" — SEC will reject calls without it. We expose this via
//     EDGAR_USER_AGENT and fall back to a generic Agent402 string so the kit
//     stays usable out-of-the-box on a fresh deployment.
//   • CIK numbers are 10-digit zero-padded everywhere in the JSON API
//     (Apple = 0000320193, not 320193). We pad transparently.
//   • The ticker→CIK map (company_tickers.json, ~10k entries, ~500KB) is cached
//     in-process for 1 hour. It changes rarely (new listings) and a fresh fetch
//     on every lookup would burn an EDGAR roundtrip for a one-line answer.
//   • safeFetch hardcodes our own User-Agent (right behavior for HTML scrapers),
//     so we use assertPublicUrl + native fetch for the EDGAR-specific UA.
import { assertPublicUrl } from "./fetch-guard.js";

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// SEC says: use a User-Agent that identifies your application and includes a
// contact email. EDGAR_USER_AGENT lets a deployer set their own string (their
// own email) — the fallback is a generic Agent402 contact, sufficient to avoid
// the hard 403 from SEC but operators should set their own for friendlier rate
// treatment.
function edgarUserAgent() {
  return (process.env.EDGAR_USER_AGENT || "").trim() || "Agent402 hello@agent402.tools";
}

async function edgarGetJson(url) {
  const safeUrl = await assertPublicUrl(url);
  let res;
  try {
    res = await fetch(safeUrl, {
      headers: {
        "User-Agent": edgarUserAgent(),
        Accept: "application/json",
      },
    });
  } catch (e) {
    throw bad(`EDGAR request failed: ${e.message}`, 504);
  }
  const text = await res.text();
  if (!res.ok) {
    // 404 from data.sec.gov usually means "unknown CIK" or "no XBRL for this
    // tag/period" — surface as 422 (caller-attributable) so the dashboard
    // counts it correctly. 5xx is a real upstream outage.
    const status = res.status;
    if (status === 404) throw bad("EDGAR returned 404 — unknown CIK, ticker, or tag/period combination", 422);
    if (status >= 500) throw bad(`EDGAR upstream HTTP ${status} — try again later`, 502);
    throw bad(`EDGAR upstream HTTP ${status}: ${text.slice(0, 200)}`, 422);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw bad("EDGAR returned non-JSON response", 502);
  }
}

// CIK comes in as "320193", "0000320193", "CIK0000320193", or 320193 (number).
// All five-ish input forms collapse to the canonical 10-digit zero-padded
// string EDGAR's URLs use.
function padCik(input) {
  if (input == null) return null;
  let s = String(input).trim().toUpperCase();
  if (s.startsWith("CIK")) s = s.slice(3);
  if (!/^\d+$/.test(s)) return null;
  if (s.length > 10) return null;
  return s.padStart(10, "0");
}

// In-process cache of the full ticker→CIK map. 1-hour TTL: long enough that
// the typical session never re-fetches, short enough that a brand-new IPO's
// ticker becomes resolvable within an hour.
const TICKER_MAP_TTL_MS = 60 * 60 * 1000;
let tickerCache = { exp: 0, map: null };

async function getTickerMap() {
  const now = Date.now();
  if (tickerCache.map && tickerCache.exp > now) return tickerCache.map;
  // company_tickers.json shape: { "0": {cik_str, ticker, title}, "1": {...}, ... }
  const j = await edgarGetJson("https://www.sec.gov/files/company_tickers.json");
  const map = new Map();
  for (const k of Object.keys(j)) {
    const row = j[k];
    if (!row || !row.ticker || row.cik_str == null) continue;
    map.set(String(row.ticker).toUpperCase(), {
      cik: padCik(row.cik_str),
      name: row.title ?? null,
    });
  }
  if (!map.size) throw bad("EDGAR ticker map was empty", 502);
  tickerCache = { exp: now + TICKER_MAP_TTL_MS, map };
  return map;
}

// Resolve { ticker? | cik? } → { cik, name? }. At least one of ticker / cik must
// be supplied. If both are supplied, cik wins (it's authoritative) but we still
// look up the ticker name if it resolves.
async function resolveCompany({ ticker, cik }) {
  const padded = cik != null ? padCik(cik) : null;
  const t = typeof ticker === "string" ? ticker.trim().toUpperCase() : null;
  if (!padded && !t) throw bad("Provide either ticker or cik");
  if (cik != null && !padded) throw bad("cik must be a numeric CIK (e.g. 320193 or 0000320193)");
  if (padded) {
    // Best-effort name lookup via the ticker map; don't fail if missing.
    if (t) {
      try {
        const map = await getTickerMap();
        const hit = map.get(t);
        if (hit) return { cik: padded, name: hit.name };
      } catch {}
    }
    return { cik: padded, name: null };
  }
  const map = await getTickerMap();
  const hit = map.get(t);
  if (!hit) throw bad(`Unknown ticker: ${t} — try the literal CIK or check spelling`, 404);
  return { cik: hit.cik, name: hit.name };
}

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

export const EDGAR_TOOLS = [
  {
    route: "GET /api/edgar-company-lookup",
    name: "EDGAR company lookup (ticker → CIK)",
    slug: "edgar-company-lookup",
    category: "data",
    price: "$0.001",
    description:
      "Resolve a US stock ticker (e.g. AAPL) to its SEC CIK number, the primitive every other EDGAR call needs. Returns CIK in both zero-padded (0000320193) and integer form, plus the registered company name. Backed by SEC's company_tickers.json (public domain). ?ticker=AAPL",
    tags: ["edgar", "sec", "cik", "ticker", "lookup", "company", "stocks", "filings"],
    discovery: {
      input: { ticker: "AAPL" },
      inputSchema: {
        properties: { ticker: { type: "string", description: "US stock ticker, e.g. AAPL" } },
        required: ["ticker"],
      },
      output: { example: { ticker: "AAPL", cik: "0000320193", cikInt: 320193, name: "Apple Inc.", source: "SEC company_tickers.json" } },
    },
    handler: async (i) => {
      const ticker = String(i.ticker ?? "").trim().toUpperCase();
      if (!ticker) throw bad('"ticker" is required');
      if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) throw bad("ticker must be a short alphanumeric symbol (letters, digits, dot, hyphen)");
      const map = await getTickerMap();
      const hit = map.get(ticker);
      if (!hit) throw bad(`Unknown ticker: ${ticker} — not in SEC's company_tickers.json (may be a non-SEC issuer or delisted)`, 404);
      return {
        ticker,
        cik: hit.cik,
        cikInt: parseInt(hit.cik, 10),
        name: hit.name,
        source: "SEC company_tickers.json (public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-filings",
    name: "EDGAR recent filings",
    slug: "edgar-filings",
    category: "data",
    price: "$0.005",
    description:
      "Recent SEC filings for a company by ticker or CIK, newest first. Optionally filter by form type (10-K, 10-Q, 8-K, 4, S-1, etc.). Each row links to the primary document on SEC.gov. Source: data.sec.gov/submissions (public domain). ?ticker=AAPL&form=10-K&limit=10",
    tags: ["edgar", "sec", "filings", "10-K", "10-Q", "8-K", "form-4", "insider", "annual-report", "quarterly"],
    discovery: {
      input: { ticker: "AAPL", form: "10-K", limit: 5 },
      inputSchema: {
        properties: {
          ticker: { type: "string", description: "US stock ticker (alternative to cik)" },
          cik: { type: "string", description: "SEC CIK number (alternative to ticker)" },
          form: { type: "string", description: 'Optional form filter, e.g. "10-K", "10-Q", "8-K", "4"' },
          limit: { type: "number", description: "Max filings to return, 1-200 (default 25)" },
        },
      },
      output: {
        example: {
          cik: "0000320193",
          name: "Apple Inc.",
          count: 5,
          filings: [
            { form: "10-K", filingDate: "2025-11-01", reportDate: "2025-09-28", accessionNumber: "0000320193-25-000123", primaryDocument: "aapl-20250928.htm", primaryDocDescription: "10-K", isXBRL: 1, isInlineXBRL: 1, url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000123/aapl-20250928.htm" },
          ],
        },
      },
    },
    handler: async (i) => {
      const { cik, name } = await resolveCompany({ ticker: i.ticker, cik: i.cik });
      const form = typeof i.form === "string" ? i.form.trim().toUpperCase() : null;
      const limit = clampInt(i.limit, 25, 1, 200);
      const j = await edgarGetJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
      const recent = j?.filings?.recent;
      if (!recent || !Array.isArray(recent.form)) throw bad("EDGAR submissions feed returned no recent filings", 502);
      // The "recent" object is column-oriented: parallel arrays of equal length,
      // one element per filing. Zip + filter + slice.
      const n = recent.form.length;
      const out = [];
      const cikInt = parseInt(cik, 10);
      const accDir = (acc) => acc.replace(/-/g, ""); // archive URL wants the digits only
      for (let k = 0; k < n && out.length < limit; k++) {
        if (form && String(recent.form[k] ?? "").toUpperCase() !== form) continue;
        const acc = recent.accessionNumber?.[k] ?? null;
        const primary = recent.primaryDocument?.[k] ?? null;
        out.push({
          form: recent.form[k] ?? null,
          filingDate: recent.filingDate?.[k] ?? null,
          reportDate: recent.reportDate?.[k] ?? null,
          accessionNumber: acc,
          primaryDocument: primary,
          primaryDocDescription: recent.primaryDocDescription?.[k] ?? null,
          items: recent.items?.[k] ?? null,
          size: recent.size?.[k] ?? null,
          isXBRL: recent.isXBRL?.[k] ?? null,
          isInlineXBRL: recent.isInlineXBRL?.[k] ?? null,
          url: acc && primary ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accDir(acc)}/${primary}` : null,
        });
      }
      return {
        cik,
        name: j?.name ?? name ?? null,
        sic: j?.sic ?? null,
        sicDescription: j?.sicDescription ?? null,
        tickers: Array.isArray(j?.tickers) ? j.tickers : [],
        exchanges: Array.isArray(j?.exchanges) ? j.exchanges : [],
        formFilter: form,
        count: out.length,
        filings: out,
        source: "SEC EDGAR submissions API (public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-company-concept",
    name: "EDGAR XBRL company-concept (one tag, full history)",
    slug: "edgar-company-concept",
    category: "data",
    price: "$0.005",
    description:
      "Full reported history of a single XBRL concept for one company (e.g. quarterly Revenues for Apple). Each datapoint cites the accession number and filing that reported it, so you can trace the number back to a 10-K/10-Q. Source: data.sec.gov/api/xbrl/companyconcept. ?ticker=AAPL&taxonomy=us-gaap&tag=Revenues",
    tags: ["edgar", "sec", "xbrl", "financials", "fundamentals", "revenue", "earnings", "10-K", "10-Q"],
    discovery: {
      input: { ticker: "AAPL", taxonomy: "us-gaap", tag: "Revenues" },
      inputSchema: {
        properties: {
          ticker: { type: "string", description: "US stock ticker (alternative to cik)" },
          cik: { type: "string", description: "SEC CIK number (alternative to ticker)" },
          taxonomy: { type: "string", description: 'XBRL taxonomy, default "us-gaap" (also: ifrs-full, dei, srt)' },
          tag: { type: "string", description: 'XBRL concept tag, e.g. "Revenues", "Assets", "NetIncomeLoss", "EarningsPerShareBasic"' },
        },
        required: ["tag"],
      },
      output: {
        example: {
          cik: "0000320193",
          entityName: "Apple Inc.",
          taxonomy: "us-gaap",
          tag: "Revenues",
          label: "Revenues",
          description: "Amount of revenue recognized from goods sold...",
          units: { USD: [{ end: "2024-09-28", val: 391035000000, accn: "0000320193-24-000123", fy: 2024, fp: "FY", form: "10-K", filed: "2024-11-01" }] },
        },
      },
    },
    handler: async (i) => {
      const { cik } = await resolveCompany({ ticker: i.ticker, cik: i.cik });
      const taxonomy = String(i.taxonomy ?? "us-gaap").trim();
      const tag = String(i.tag ?? "").trim();
      if (!tag) throw bad('"tag" is required (e.g. "Revenues", "Assets", "NetIncomeLoss")');
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(taxonomy)) throw bad("taxonomy looks malformed");
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,120}$/.test(tag)) throw bad("tag looks malformed");
      const j = await edgarGetJson(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`);
      return {
        cik,
        entityName: j?.entityName ?? null,
        taxonomy: j?.taxonomy ?? taxonomy,
        tag: j?.tag ?? tag,
        label: j?.label ?? null,
        description: j?.description ?? null,
        units: j?.units ?? {},
        source: "SEC EDGAR XBRL company-concept API (public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-company-facts",
    name: "EDGAR XBRL company-facts (all tags)",
    slug: "edgar-company-facts",
    category: "data",
    price: "$0.010",
    description:
      "All XBRL concepts reported by a company. Default returns a compact summary per tag (label, unit, latest value, latest end date) — typically a few hundred KB. Pass tags=Revenues,Assets,NetIncomeLoss to get full time-series for just those concepts. Source: data.sec.gov/api/xbrl/companyfacts. ?ticker=AAPL",
    tags: ["edgar", "sec", "xbrl", "financials", "fundamentals", "facts", "company"],
    discovery: {
      input: { ticker: "AAPL" },
      inputSchema: {
        properties: {
          ticker: { type: "string", description: "US stock ticker (alternative to cik)" },
          cik: { type: "string", description: "SEC CIK number (alternative to ticker)" },
          taxonomy: { type: "string", description: 'Optional taxonomy filter, e.g. "us-gaap" or "dei"' },
          tags: { type: "string", description: "Optional comma-separated tag list — when set, returns full time series for ONLY these tags (e.g. Revenues,Assets,NetIncomeLoss)" },
        },
      },
      output: {
        example: {
          cik: "0000320193",
          entityName: "Apple Inc.",
          mode: "summary",
          taxonomies: { "us-gaap": { count: 312, sample: { Revenues: { label: "Revenues", unit: "USD", latestEnd: "2024-09-28", latestVal: 391035000000, observations: 48 } } } },
        },
      },
    },
    handler: async (i) => {
      const { cik } = await resolveCompany({ ticker: i.ticker, cik: i.cik });
      const taxonomyFilter = typeof i.taxonomy === "string" ? i.taxonomy.trim() : null;
      const tagsFilter = typeof i.tags === "string" && i.tags.trim()
        ? new Set(i.tags.split(",").map((s) => s.trim()).filter(Boolean))
        : null;
      const j = await edgarGetJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
      const facts = j?.facts ?? {};
      const out = {};
      for (const tx of Object.keys(facts)) {
        if (taxonomyFilter && tx !== taxonomyFilter) continue;
        const tagsObj = facts[tx] ?? {};
        if (tagsFilter) {
          // Full-series mode for the named tags — preserves the SEC payload
          // verbatim (units → observation array) for the agent to crunch.
          const picked = {};
          for (const tagName of tagsFilter) {
            if (tagsObj[tagName]) picked[tagName] = tagsObj[tagName];
          }
          out[tx] = picked;
        } else {
          // Summary mode: one line per tag with the latest observation only.
          // Picks the alphabetically-largest unit key as the canonical unit
          // when multiple are reported (vast majority of tags only have one).
          const summary = {};
          for (const tagName of Object.keys(tagsObj)) {
            const entry = tagsObj[tagName];
            const units = entry?.units ?? {};
            const unitKeys = Object.keys(units);
            if (!unitKeys.length) continue;
            const primaryUnit = unitKeys.sort().pop();
            const obs = Array.isArray(units[primaryUnit]) ? units[primaryUnit] : [];
            if (!obs.length) continue;
            // Find the observation with the largest "end" date (or "filed" as fallback).
            let latest = obs[0];
            for (const o of obs) {
              if ((o.end ?? "") > (latest.end ?? "")) latest = o;
            }
            summary[tagName] = {
              label: entry.label ?? null,
              unit: primaryUnit,
              latestEnd: latest.end ?? null,
              latestVal: latest.val ?? null,
              observations: obs.length,
            };
          }
          out[tx] = { count: Object.keys(summary).length, tags: summary };
        }
      }
      return {
        cik,
        entityName: j?.entityName ?? null,
        mode: tagsFilter ? "full" : "summary",
        taxonomyFilter,
        tagsFilter: tagsFilter ? [...tagsFilter] : null,
        taxonomies: out,
        source: "SEC EDGAR XBRL company-facts API (public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-xbrl-frame",
    name: "EDGAR XBRL frame (cross-company snapshot)",
    slug: "edgar-xbrl-frame",
    category: "data",
    price: "$0.015",
    description:
      "All US public companies that reported a given XBRL tag for a given period, in one call. Killer endpoint for cross-sectional screens: 'every issuer's Revenues for CY2023Q1' or 'every issuer's Assets as of CY2023Q4I (instantaneous)'. Period format: CY{YYYY} (annual), CY{YYYY}Q{1-4} (quarterly), or CY{YYYY}Q{1-4}I (instantaneous balance-sheet items). Source: data.sec.gov/api/xbrl/frames. ?taxonomy=us-gaap&tag=Revenues&unit=USD&period=CY2023Q1",
    tags: ["edgar", "sec", "xbrl", "frames", "screen", "cross-section", "fundamentals", "financials"],
    discovery: {
      input: { taxonomy: "us-gaap", tag: "Revenues", unit: "USD", period: "CY2023Q1" },
      inputSchema: {
        properties: {
          taxonomy: { type: "string", description: 'XBRL taxonomy, default "us-gaap"' },
          tag: { type: "string", description: 'XBRL concept tag, e.g. "Revenues", "Assets"' },
          unit: { type: "string", description: 'Unit of measure, e.g. "USD", "shares", "USD/shares"' },
          period: { type: "string", description: 'CY{YYYY} (annual), CY{YYYY}Q{1-4} (quarterly), or CY{YYYY}Q{1-4}I (instantaneous balance-sheet)' },
          limit: { type: "number", description: "Max companies to return, 1-2000 (default 200)" },
        },
        required: ["tag", "unit", "period"],
      },
      output: {
        example: {
          taxonomy: "us-gaap",
          tag: "Revenues",
          ccp: "CY2023Q1",
          uom: "USD",
          label: "Revenues",
          totalCompanies: 1872,
          returned: 1,
          truncated: true,
          data: [{ accn: "0000320193-23-000064", cik: 320193, entityName: "Apple Inc.", loc: "US-CA", end: "2023-04-01", val: 94836000000 }],
        },
      },
    },
    handler: async (i) => {
      const taxonomy = String(i.taxonomy ?? "us-gaap").trim();
      const tag = String(i.tag ?? "").trim();
      const unit = String(i.unit ?? "").trim();
      const period = String(i.period ?? "").trim();
      const limit = clampInt(i.limit, 200, 1, 2000);
      if (!tag) throw bad('"tag" is required (e.g. "Revenues", "Assets")');
      if (!unit) throw bad('"unit" is required (e.g. "USD", "shares")');
      if (!period) throw bad('"period" is required, e.g. "CY2023Q1" or "CY2023Q4I"');
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(taxonomy)) throw bad("taxonomy looks malformed");
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,120}$/.test(tag)) throw bad("tag looks malformed");
      // EDGAR's "unit" goes in the URL path. Allow USD, shares, USD/shares,
      // pure, EUR, etc. — basically alphanumeric plus / for compound units.
      if (!/^[A-Za-z][A-Za-z0-9/_-]{0,40}$/.test(unit)) throw bad("unit looks malformed");
      if (!/^CY\d{4}(Q[1-4]I?)?$/.test(period)) throw bad('"period" must be CY{YYYY}, CY{YYYY}Q{1-4}, or CY{YYYY}Q{1-4}I (instantaneous)');
      // The URL form for compound units is "USD-per-shares"; the JSON wants
      // "USD/shares". data.sec.gov accepts the slash form directly.
      const j = await edgarGetJson(`https://data.sec.gov/api/xbrl/frames/${taxonomy}/${tag}/${encodeURIComponent(unit)}/${period}.json`);
      const data = Array.isArray(j?.data) ? j.data : [];
      const sliced = data.slice(0, limit);
      return {
        taxonomy: j?.taxonomy ?? taxonomy,
        tag: j?.tag ?? tag,
        ccp: j?.ccp ?? period,
        uom: j?.uom ?? unit,
        label: j?.label ?? null,
        description: j?.description ?? null,
        totalCompanies: data.length,
        returned: sliced.length,
        truncated: data.length > sliced.length,
        data: sliced,
        source: "SEC EDGAR XBRL frames API (public domain)",
      };
    },
  },
];
