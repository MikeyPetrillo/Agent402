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
import { dataSetsIndex, dataSetHead } from "./edgar-13f-datasets.js";

// Hard per-request socket bound for every EDGAR read (undici defaults to 300 s).
const EDGAR_FETCH_TIMEOUT_MS = Math.max(2_000, parseInt(process.env.EDGAR_FETCH_TIMEOUT_MS || "12000", 10) || 12_000);
function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// SEC says: use a User-Agent that identifies your application and includes a
// contact email. EDGAR_USER_AGENT lets a deployer set their own string (their
// own email) — the fallback is a generic Agent402 contact, sufficient to avoid
// the hard 403 from SEC but operators should set their own for friendlier rate
// treatment.
function edgarUserAgent() {
  return (process.env.EDGAR_USER_AGENT || "").trim() || "Agent402 mike@agent402.tools";
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
      // Without this the socket has no bound of its own: a caller-side deadline
      // (the programmatic pages use 12 s) frees its concurrency slot while the
      // request keeps running, so a throttling SEC grows in-flight sockets far
      // past whatever gate is supposed to be holding the line.
      signal: AbortSignal.timeout(EDGAR_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw bad(`EDGAR request failed: ${e.message}`, 504);
  }
  const text = await res.text();
  if (!res.ok) {
    // 404 from data.sec.gov usually means "unknown CIK" or "no XBRL for this
    // tag/period" — surface as 422 (caller-attributable) so the dashboard
    // counts it correctly. 5xx is a real upstream outage.
    // `upstreamStatus` rides along so a caller can tell "EDGAR says this does
    // not exist" (404) from "EDGAR refused to answer us" (403 rate limit, 429).
    // Both map to 422 for the paid tools, but a free page that negative-caches
    // a throttle as "no such company" would 404 a real ticker for as long as
    // that cache lives.
    const status = res.status;
    if (status === 404) throw Object.assign(bad("EDGAR returned 404 - unknown CIK, ticker, or tag/period combination", 422), { upstreamStatus: 404 });
    if (status >= 500) throw Object.assign(bad(`EDGAR upstream HTTP ${status} - try again later`, 502), { upstreamStatus: status });
    throw Object.assign(bad(`EDGAR upstream HTTP ${status}: ${text.slice(0, 200)}`, 422), { upstreamStatus: status });
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
  if (!hit) throw bad(`Unknown ticker: ${t} - try the literal CIK or check spelling`, 404);
  return { cik: hit.cik, name: hit.name };
}

// A buyer who sends a company NAME where a ticker goes ("Tesla", "NVIDIA")
// used to get a bare "Unknown ticker". The map already holds every registered
// name, so the refusal can name the likely tickers instead. Pure: exported for
// the offline test. Matches the whole query as a leading word of the name
// first, then anywhere in it; at most `limit` rows, shortest ticker first so a
// parent listing beats its preferred-share classes.
export function tickerSuggestions(map, query, limit = 3) {
  const q = String(query || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 3 || !map) return [];
  const starts = [], contains = [];
  for (const [ticker, row] of map) {
    const name = String(row?.name || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (name === q || name.startsWith(q + " ")) starts.push({ ticker, name: row.name });
    else if ((" " + name + " ").includes(" " + q + " ")) contains.push({ ticker, name: row.name });
  }
  const byLen = (a, b) => a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker);
  return [...starts.sort(byLen), ...contains.sort(byLen)].slice(0, limit);
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
      "Resolve a US stock ticker (e.g. AAPL) to its SEC CIK number, the primitive every other EDGAR call needs. Returns ticker, cik (zero-padded, 0000320193), cikInt (320193) and the registered company name. Backed by SEC's company_tickers.json (public domain). A company name sent where the ticker goes is answered with a 404 that names the likely tickers (\"Tesla\" -> TSLA). ?ticker=AAPL",
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
      if (!hit) {
        const sugg = tickerSuggestions(map, i.ticker);
        const hint = sugg.length ? ` Did you mean ${sugg.map((x) => `${x.ticker} (${x.name})`).join(", ")}? Send the ticker.` : "";
        throw bad(`Unknown ticker: ${ticker} - not in SEC's company_tickers.json (may be a non-SEC issuer or delisted).${hint}`, 404);
      }
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
    price: "$0.005",
    description:
      "All XBRL concepts reported by a company. Default returns a compact summary per tag (label, unit, latest value, latest end date) - typically a few hundred KB. Pass tags=Revenues,Assets,NetIncomeLoss to get full time-series for just those concepts. Source: data.sec.gov/api/xbrl/companyfacts. ?ticker=AAPL",
    tags: ["edgar", "sec", "xbrl", "financials", "fundamentals", "facts", "company"],
    discovery: {
      input: { ticker: "AAPL" },
      inputSchema: {
        properties: {
          ticker: { type: "string", description: "US stock ticker (alternative to cik)" },
          cik: { type: "string", description: "SEC CIK number (alternative to ticker)" },
          taxonomy: { type: "string", description: 'Optional taxonomy filter, e.g. "us-gaap" or "dei"' },
          tags: { type: "string", description: "Optional comma-separated tag list - when set, returns full time series for ONLY these tags (e.g. Revenues,Assets,NetIncomeLoss)" },
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
    price: "$0.005",
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

// ---------------------------------------------------------------------------
// EDGAR full-text search backend (efts.sec.gov)
//
// One endpoint powers three of the next four tools: insider-trades (forms=4 +
// ciks=COMPANY), recent-ipos (forms=S-1 + date range), and the general
// full-text search. Form 4 is filed by each insider's OWN CIK — not the
// company's — so it does NOT appear in the company's submissions feed. The
// efts.sec.gov endpoint indexes by *subject company* CIK, which is the only
// single-call path to "all insider trades against Apple".
// ---------------------------------------------------------------------------

function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }

// Map an efts hit to a stable, agent-friendly row. The raw hit shape has
// _source with adsh (accession), display_names (which embed the ticker in
// parens), and various other fields with under_score names.
function mapEftsHit(hit) {
  const s = hit?._source ?? {};
  const acc = s.adsh ?? null;
  const cik = Array.isArray(s.ciks) && s.ciks.length ? padCik(s.ciks[0]) : null;
  const cikInt = cik ? parseInt(cik, 10) : null;
  // _id is "<accession>:<filename>" — the filename is the primary doc.
  const id = hit?._id ?? "";
  const primaryDoc = id.includes(":") ? id.split(":").slice(1).join(":") : null;
  const accDir = acc ? acc.replace(/-/g, "") : null;
  const url = cikInt && accDir && primaryDoc
    ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accDir}/${primaryDoc}`
    : null;
  return {
    accessionNumber: acc,
    form: s.form ?? null,
    fileType: s.file_type ?? null,
    fileDescription: s.file_description ?? null,
    filedDate: s.file_date ?? null,
    cik,
    ciks: Array.isArray(s.ciks) ? s.ciks.map(padCik).filter(Boolean) : [],
    displayNames: Array.isArray(s.display_names) ? s.display_names : [],
    primaryDocument: primaryDoc,
    url,
  };
}

// efts.sec.gov requires the same User-Agent policy as data.sec.gov. Same
// helper, different base URL.
async function eftsSearch({ q, forms, ciks, startdt, enddt, locationCode, from = 0 }) {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (forms) qs.set("forms", forms);
  if (ciks) qs.set("ciks", ciks);
  if (locationCode) qs.set("locationCode", locationCode);
  if (startdt && enddt) {
    qs.set("dateRange", "custom");
    qs.set("startdt", startdt);
    qs.set("enddt", enddt);
  }
  if (from) qs.set("from", String(from));
  const url = `https://efts.sec.gov/LATEST/search-index?${qs}`;
  return edgarGetJson(url);
}

// ---------------------------------------------------------------------------
// 13F-HR holdings parser (informationtable.xml)
//
// The 13F holdings table is a standard SEC XML attachment named
// "*informationtable*.xml" inside the filing's accession archive. We list the
// archive via index.json, find the table, fetch the XML, and parse the
// well-known <infoTable> blocks (the format is stable, and pulling in a full
// XML parser for one repeating shape isn't worth it).
// ---------------------------------------------------------------------------

function pickXml(re, str) {
  const m = str.match(re);
  return m ? m[1].trim() : null;
}

// Pull the first occurrence of a given child tag (namespace-agnostic) from a
// parent block. Lets us tolerate variants like <ns1:nameOfIssuer>...</...>
// that some filers produce.
function xmlChild(parent, tagName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tagName}>`, "i");
  return pickXml(re, parent);
}

// SEC Form 13F's <value> field unit changed effective 2023-01-03: pre-cutoff
// it's thousands of USD, post-cutoff it's whole USD. Pick the multiplier from
// the filing's reportDate so callers see actual dollars either way.
function valueMultiplierFor(reportDate) {
  if (typeof reportDate !== "string") return 1000; // assume old format if unknown
  return reportDate >= "2023-01-03" ? 1 : 1000;
}

function parse13fInformationTable(xml, reportDate) {
  const mult = valueMultiplierFor(reportDate);
  // Each holding is one <infoTable>...</infoTable> block. Namespace-agnostic.
  const blockRe = /<(?:[A-Za-z0-9_]+:)?infoTable>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?infoTable>/gi;
  const rows = [];
  for (const m of xml.matchAll(blockRe)) {
    const block = m[1];
    const rawValue = xmlChild(block, "value");
    const shrs = xmlChild(block, "sshPrnamt");
    const shrsType = xmlChild(block, "sshPrnamtType");
    const valNum = rawValue != null ? Number(rawValue) : null;
    rows.push({
      issuer: xmlChild(block, "nameOfIssuer"),
      titleOfClass: xmlChild(block, "titleOfClass"),
      cusip: xmlChild(block, "cusip"),
      // valueUsd: whole USD regardless of filing era. valueRaw: the XML's
      // literal value field (in whatever unit that era used) for audit.
      valueUsd: valNum != null ? valNum * mult : null,
      valueRaw: valNum,
      shares: shrs != null ? Number(shrs) : null,
      sharesOrPrincipalAmountType: shrsType,
      putCall: xmlChild(block, "putCall"),
      investmentDiscretion: xmlChild(block, "investmentDiscretion"),
      votingSole: xmlChild(block, "Sole") != null ? Number(xmlChild(block, "Sole")) : null,
      votingShared: xmlChild(block, "Shared") != null ? Number(xmlChild(block, "Shared")) : null,
      votingNone: xmlChild(block, "None") != null ? Number(xmlChild(block, "None")) : null,
    });
  }
  return rows;
}

// Locate a 13F-HR filing's information table AND report its declared byte size.
// The size matters to any caller that is not being paid for the read: the
// largest filers (index complexes with thousands of positions) publish tables
// in the tens of megabytes, so a free surface must be able to decline the fetch
// rather than pull it into memory. fetchInformationTableUrl() below keeps the
// old url-only contract for the paid path.
export async function findInformationTable(cikInt, accession) {
  const accDir = accession.replace(/-/g, "");
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accDir}/index.json`;
  const idx = await edgarGetJson(indexUrl);
  const items = idx?.directory?.item ?? [];
  // SEC only standardizes the cover-page filename ("primary_doc.xml"). The
  // information-table XML can be named various things — sometimes
  // "informationtable.xml", sometimes a numeric form code like "53405.xml"
  // (e.g. Berkshire's recent filings). Strategy:
  //   1. Prefer an .xml whose name contains "informationtable" or "infotable".
  //   2. Otherwise, pick the largest .xml that ISN'T primary_doc.xml — the
  //      cover page is tiny (~5KB), the table is much larger (10s-100s KB).
  const xmls = items.filter((it) => {
    const n = String(it?.name ?? "").toLowerCase();
    return n.endsWith(".xml") && !n.includes("index");
  });
  const namedHit = xmls.find((it) => {
    const n = String(it.name).toLowerCase();
    return n.includes("informationtable") || n.includes("infotable");
  });
  if (namedHit) {
    return { name: namedHit.name, size: parseInt(namedHit.size, 10) || 0, url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accDir}/${namedHit.name}` };
  }
  const candidates = xmls
    .filter((it) => String(it.name).toLowerCase() !== "primary_doc.xml")
    .map((it) => ({ name: it.name, size: parseInt(it.size, 10) || 0 }))
    .sort((a, b) => b.size - a.size);
  if (!candidates.length) return null;
  return { ...candidates[0], url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accDir}/${candidates[0].name}` };
}

async function fetchInformationTableUrl(cikInt, accession) {
  const hit = await findInformationTable(cikInt, accession);
  return hit ? hit.url : null;
}

async function fetchXmlText(url) {
  const safeUrl = await assertPublicUrl(url);
  let res;
  try {
    res = await fetch(safeUrl, {
      headers: { "User-Agent": edgarUserAgent(), Accept: "application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(EDGAR_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw bad(`EDGAR XML fetch failed: ${e.message}`, 504);
  }
  if (!res.ok) {
    if (res.status === 404) throw Object.assign(bad("EDGAR XML attachment not found (filing may not have the expected layout)", 422), { upstreamStatus: 404 });
    throw Object.assign(bad(`EDGAR XML HTTP ${res.status}`, res.status >= 500 ? 502 : 422), { upstreamStatus: res.status });
  }
  return await res.text();
}

// Key XBRL tags for the company-financials summary tool. Companies may report
// under different tag names (GAAP evolved; "Revenues" → "RevenueFromContract..."
// in ASC 606 era). `alts` lists fallback tags tried in order.
const FINANCIALS_TAGS = [
  { tag: "Revenues", label: "Revenue", alts: ["RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"] },
  { tag: "NetIncomeLoss", label: "Net Income", alts: ["ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"] },
  { tag: "OperatingIncomeLoss", label: "Operating Income", alts: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"] },
  { tag: "Assets", label: "Total Assets", alts: [] },
  { tag: "Liabilities", label: "Total Liabilities", alts: ["LiabilitiesCurrent"] },
  { tag: "StockholdersEquity", label: "Stockholders Equity", alts: ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
  { tag: "EarningsPerShareBasic", label: "EPS (Basic)", alts: [] },
  { tag: "EarningsPerShareDiluted", label: "EPS (Diluted)", alts: [] },
  { tag: "NetCashProvidedByUsedInOperatingActivities", label: "Operating Cash Flow", alts: ["NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
];

EDGAR_TOOLS.push(
  {
    route: "GET /api/company-financials",
    name: "Company financials summary",
    slug: "company-financials",
    category: "data",
    price: "$0.02",
    description:
      "Key financial metrics (Revenue, Net Income, Operating Income, Total Assets, Liabilities, Equity, EPS, Operating Cash Flow) for a US public company in one call. Returns the latest annual and quarterly values from SEC XBRL filings. No XBRL knowledge needed - just pass a ticker. ?ticker=AAPL",
    tags: ["edgar", "sec", "financials", "fundamentals", "income-statement", "balance-sheet", "cash-flow"],
    discovery: {
      input: { ticker: "AAPL" },
      inputSchema: {
        properties: {
          ticker: { type: "string", description: "US stock ticker (alternative to cik)" },
          cik: { type: "string", description: "SEC CIK number (alternative to ticker)" },
        },
      },
      output: {
        example: {
          ticker: "AAPL",
          cik: "0000320193",
          entityName: "Apple Inc.",
          metrics: [
            { label: "Revenue", tag: "Revenues", latestAnnual: { value: 391035000000, period: "2024-09-28", form: "10-K" }, latestQuarterly: { value: 94930000000, period: "2025-03-29", form: "10-Q" } },
            { label: "Net Income", tag: "NetIncomeLoss", latestAnnual: { value: 93736000000, period: "2024-09-28", form: "10-K" }, latestQuarterly: { value: 24780000000, period: "2025-03-29", form: "10-Q" } },
          ],
          source: "SEC EDGAR XBRL (public domain)",
        },
      },
    },
    handler: async (i) => {
      const { cik, name } = await resolveCompany({ ticker: i.ticker, cik: i.cik });
      const j = await edgarGetJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
      const facts = j?.facts?.["us-gaap"] ?? {};
      const metrics = [];
      for (const { tag, label, alts } of FINANCIALS_TAGS) {
        // Try all candidate tags and pick the one with the freshest annual filing.
        // Companies migrate tag names over time (e.g. "Revenues" → ASC 606 tag),
        // so the primary tag may have stale data while an alt has current filings.
        const candidates = [tag, ...(alts || [])];
        let bestTag = null, bestAnnual = null, bestQuarterly = null;
        for (const t of candidates) {
          const concept = facts[t];
          if (!concept) continue;
          const units = concept.units?.USD ?? concept.units?.["USD/shares"] ?? concept.units?.pure ?? [];
          let annual = null, quarterly = null;
          for (const row of units) {
            if (row.form === "10-K" && (!annual || row.end > annual.end)) annual = row;
            if (row.form === "10-Q" && (!quarterly || row.end > quarterly.end)) quarterly = row;
          }
          // Pick the candidate whose annual data is most recent
          if (annual && (!bestAnnual || annual.end > bestAnnual.end)) {
            bestTag = t; bestAnnual = annual; bestQuarterly = quarterly;
          } else if (!bestAnnual && quarterly && (!bestQuarterly || quarterly.end > bestQuarterly.end)) {
            bestTag = t; bestQuarterly = quarterly;
          }
        }
        const fmt = (r) => r ? { value: r.val, period: r.end, form: r.form } : null;
        metrics.push({ label, tag: bestTag ?? tag, latestAnnual: fmt(bestAnnual), latestQuarterly: fmt(bestQuarterly) });
      }
      return {
        ticker: typeof i.ticker === "string" ? i.ticker.trim().toUpperCase() : null,
        cik,
        entityName: j?.entityName ?? name,
        metrics,
        source: "SEC EDGAR XBRL (public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-insider-trades",
    name: "EDGAR insider trades (Form 4)",
    slug: "edgar-insider-trades",
    category: "data",
    price: "$0.005",
    description:
      "Recent Form 4 insider transactions filed against a company (officer, director, or 10% holder trades). Backed by EDGAR's full-text search (efts.sec.gov) filtered by subject-company CIK - Form 4 is owned by each insider's CIK, not the company's, so this is the only single-call path. ?ticker=AAPL&days=30",
    tags: ["edgar", "sec", "insider", "form-4", "trades", "officers", "directors", "transactions"],
    discovery: {
      input: { ticker: "AAPL", days: 30 },
      inputSchema: {
        properties: {
          ticker: { type: "string", description: "US stock ticker (alternative to cik)" },
          cik: { type: "string", description: "SEC CIK of the subject company (alternative to ticker)" },
          days: { type: "number", description: "Lookback window in days, 1-365 (default 30)" },
          limit: { type: "number", description: "Max filings to return, 1-100 (default 25)" },
        },
      },
      output: {
        example: {
          cik: "0000320193",
          name: "Apple Inc.",
          windowDays: 30,
          total: 8,
          returned: 8,
          trades: [
            { accessionNumber: "0001127602-25-009999", form: "4", filedDate: "2025-11-04", cik: "0001214128", displayNames: ["COOK TIMOTHY D (CIK 0001214128)"], url: "https://www.sec.gov/Archives/edgar/data/1214128/000112760225009999/xslF345X05/wf-form4.xml", primaryDocument: "xslF345X05/wf-form4.xml" },
          ],
        },
      },
    },
    handler: async (i) => {
      const { cik, name } = await resolveCompany({ ticker: i.ticker, cik: i.cik });
      const days = clampInt(i.days, 30, 1, 365);
      const limit = clampInt(i.limit, 25, 1, 100);
      const enddt = isoDate(Date.now());
      const startdt = isoDate(Date.now() - days * 86400 * 1000);
      const j = await eftsSearch({ forms: "4", ciks: cik, startdt, enddt });
      const hits = j?.hits?.hits ?? [];
      const total = j?.hits?.total?.value ?? hits.length;
      const trades = hits.slice(0, limit).map(mapEftsHit);
      return {
        cik,
        name,
        windowDays: days,
        startDate: startdt,
        endDate: enddt,
        total,
        returned: trades.length,
        trades,
        source: "SEC EDGAR full-text search (efts.sec.gov, public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-13f-holdings",
    name: "EDGAR 13F-HR holdings (institutional positions)",
    slug: "edgar-13f-holdings",
    category: "data",
    price: "$0.005",
    description:
      "Top holdings from an institutional investment manager's most recent 13F-HR filing (managers >$100M AUM file quarterly). Parses the standard SEC informationtable.xml attached to the filing - returns issuer, CUSIP, shares, USD value, and voting authority for each position. Sorted by USD value, descending. Source: data.sec.gov + filing archive. ?cik=1067983 (Berkshire) or ?ticker=BRK-B",
    tags: ["edgar", "sec", "13F", "13F-HR", "holdings", "institutional", "fund", "hedge-fund", "portfolio"],
    discovery: {
      input: { cik: "1067983", limit: 10 },
      inputSchema: {
        properties: {
          cik: { type: "string", description: "SEC CIK of the institutional manager (e.g. 1067983 = Berkshire Hathaway)" },
          ticker: { type: "string", description: "US ticker of a publicly-traded manager (alternative to cik; many funds aren't public)" },
          limit: { type: "number", description: "Top N holdings by USD value, 1-500 (default 50)" },
        },
      },
      output: {
        example: {
          cik: "0001067983",
          managerName: "Berkshire Hathaway Inc",
          accessionNumber: "0000950123-25-001234",
          filedDate: "2025-11-14",
          reportDate: "2025-09-30",
          informationTableUrl: "https://www.sec.gov/Archives/edgar/data/1067983/000095012325001234/informationtable.xml",
          totalHoldings: 38,
          returned: 10,
          totalValueUsd: 312456000000,
          holdings: [
            { issuer: "APPLE INC", titleOfClass: "COM", cusip: "037833100", valueUsd: 176558000000, valueRaw: 176558000000, shares: 905560000, sharesOrPrincipalAmountType: "SH", putCall: null, investmentDiscretion: "DFND", votingSole: 905560000, votingShared: 0, votingNone: 0 },
          ],
        },
      },
    },
    handler: async (i) => {
      const limit = clampInt(i.limit, 50, 1, 500);
      const r = await get13fHoldings({ cik: i.cik, ticker: i.ticker, index: 0 });
      if (!r) throw bad("Manager has no recent 13F-HR filings", 422);
      return {
        cik: r.cik,
        managerName: r.managerName,
        accessionNumber: r.accessionNumber,
        filedDate: r.filedDate,
        reportDate: r.reportDate,
        informationTableUrl: r.informationTableUrl,
        totalHoldings: r.totalHoldings,
        returned: Math.min(r.totalHoldings, limit),
        totalValueUsd: r.totalValueUsd,
        holdings: r.holdings.slice(0, limit),
        source: "SEC EDGAR 13F-HR informationtable.xml (public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-recent-ipos",
    name: "EDGAR recent IPO filings (S-1 / 424B4)",
    slug: "edgar-recent-ipos",
    category: "data",
    price: "$0.005",
    description:
      "Recently-filed S-1 (initial registration) or 424B4 (final prospectus - actual priced IPO) filings across all US issuers. Default returns S-1 filings (companies preparing to IPO) in the last 30 days; pass form=424B4 for actual IPOs that priced. Source: EDGAR full-text search. ?days=30&form=S-1",
    tags: ["edgar", "sec", "ipo", "S-1", "424B4", "prospectus", "registration", "new-listings"],
    discovery: {
      input: { days: 30, form: "S-1", limit: 25 },
      inputSchema: {
        properties: {
          days: { type: "number", description: "Lookback window in days, 1-365 (default 30)" },
          form: { type: "string", description: 'Form type. "S-1" = initial registration (default). "424B4" = final prospectus (actual priced IPOs). "S-1/A" = amended registration.' },
          limit: { type: "number", description: "Max filings, 1-200 (default 25)" },
        },
      },
      output: {
        example: {
          form: "S-1",
          windowDays: 30,
          startDate: "2025-10-19",
          endDate: "2025-11-18",
          total: 142,
          returned: 25,
          filings: [
            { accessionNumber: "0001213900-25-099999", form: "S-1", filedDate: "2025-11-17", cik: "0001999888", displayNames: ["Example Newco Inc."], url: "https://www.sec.gov/Archives/edgar/data/1999888/000121390025099999/exfiling.htm", primaryDocument: "exfiling.htm" },
          ],
        },
      },
    },
    handler: async (i) => {
      const form = String(i.form ?? "S-1").trim().toUpperCase();
      if (!/^[A-Z0-9./\-]{1,15}$/.test(form)) throw bad("form looks malformed");
      const days = clampInt(i.days, 30, 1, 365);
      const limit = clampInt(i.limit, 25, 1, 200);
      const enddt = isoDate(Date.now());
      const startdt = isoDate(Date.now() - days * 86400 * 1000);
      // EFTS answers 100 hits a page; a 90-day S-1 window holds ~600. Page up
      // to `limit` so "N in the window" is not silently "the newest 100".
      const j = await eftsSearch({ forms: form, startdt, enddt });
      let hits = j?.hits?.hits ?? [];
      const total = j?.hits?.total?.value ?? hits.length;
      for (let from = hits.length; hits.length < Math.min(total, limit) && from < 1000 && hits.length > 0; from += 100) {
        const page = await eftsSearch({ forms: form, startdt, enddt, from });
        const more = page?.hits?.hits ?? [];
        if (!more.length) break;
        hits = hits.concat(more);
      }
      const filings = hits.slice(0, limit).map(mapEftsHit);
      return {
        form,
        windowDays: days,
        startDate: startdt,
        endDate: enddt,
        total,
        returned: filings.length,
        filings,
        source: "SEC EDGAR full-text search (efts.sec.gov, public domain)",
      };
    },
  },
  {
    route: "GET /api/edgar-search",
    name: "EDGAR full-text search",
    slug: "edgar-search",
    category: "data",
    price: "$0.005",
    description:
      'General-purpose full-text search across every SEC filing since 2001. Find any phrase in any filing - material-weakness language in 10-Ks, going-concern in 10-Qs, "Russia" exposure across all forms. Supports form-type, CIK, US-state, and date-window filters. Source: EDGAR full-text search (efts.sec.gov). ?q=going+concern&forms=10-Q&days=30',
    tags: ["edgar", "sec", "search", "full-text", "filings", "10-K", "10-Q", "8-K", "screen"],
    discovery: {
      input: { q: "going concern", forms: "10-Q", days: 90, limit: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: 'Search phrase (quote-wrap for exact match, e.g. "material weakness")' },
          forms: { type: "string", description: 'Comma-separated form filter, e.g. "10-K,10-Q" or "8-K"' },
          ticker: { type: "string", description: "Restrict to a single company by ticker" },
          cik: { type: "string", description: "Restrict to a single company by CIK" },
          days: { type: "number", description: "Lookback window in days, 1-3650 (default unset = all-time)" },
          locationCode: { type: "string", description: 'Two-letter US state code to filter by issuer location (e.g. "CA")' },
          limit: { type: "number", description: "Max hits to return, 1-100 (default 25)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          q: "going concern",
          forms: "10-Q",
          windowDays: 90,
          total: 1287,
          returned: 5,
          hits: [
            { accessionNumber: "0001213900-25-088888", form: "10-Q", filedDate: "2025-11-10", cik: "0001234567", displayNames: ["Example Distressed Co"], url: "https://www.sec.gov/Archives/edgar/data/1234567/000121390025088888/ex10q.htm", primaryDocument: "ex10q.htm" },
          ],
        },
      },
    },
    handler: async (i) => {
      const q = String(i.q ?? "").trim();
      if (!q) throw bad('"q" is required');
      if (q.length > 200) throw bad("q is too long (max 200 chars)");
      const forms = typeof i.forms === "string" && i.forms.trim() ? i.forms.trim().toUpperCase() : null;
      const locationCode = typeof i.locationCode === "string" && i.locationCode.trim() ? i.locationCode.trim().toUpperCase() : null;
      if (locationCode && !/^[A-Z]{2}$/.test(locationCode)) throw bad("locationCode must be a 2-letter US state code");
      const limit = clampInt(i.limit, 25, 1, 100);
      let ciks = null;
      if (i.ticker || i.cik) {
        const r = await resolveCompany({ ticker: i.ticker, cik: i.cik });
        ciks = r.cik;
      }
      let startdt = null, endd = null, days = null;
      if (i.days != null) {
        days = clampInt(i.days, 30, 1, 3650);
        endd = isoDate(Date.now());
        startdt = isoDate(Date.now() - days * 86400 * 1000);
      }
      const j = await eftsSearch({ q, forms, ciks, startdt, enddt: endd, locationCode });
      const hits = j?.hits?.hits ?? [];
      const total = j?.hits?.total?.value ?? hits.length;
      return {
        q,
        forms,
        ciks,
        locationCode,
        windowDays: days,
        startDate: startdt,
        endDate: endd,
        total,
        returned: Math.min(hits.length, limit),
        hits: hits.slice(0, limit).map(mapEftsHit),
        source: "SEC EDGAR full-text search (efts.sec.gov, public domain)",
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Reusable 13F helpers - exported for the Fund Portfolio Report product so the
// 13F parsing lives in ONE place (edgar-13f-holdings uses get13fHoldings too).
// ---------------------------------------------------------------------------

// The Nth most recent 13F-HR holdings for a manager (index 0 = latest, 1 =
// prior quarter). Returns null when the manager has fewer than index+1 13F-HR
// filings (so a caller can ask for the prior quarter and get null, not throw).
export async function get13fHoldings({ cik, ticker, index = 0 }) {
  const resolved = await resolveCompany({ ticker, cik });
  const _cik = resolved.cik;
  const sub = await edgarGetJson(`https://data.sec.gov/submissions/CIK${_cik}.json`);
  const recent = sub?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) throw bad("Manager has no recent filings", 422);
  const idxs = [];
  for (let k = 0; k < recent.form.length; k++) if (String(recent.form[k]).toUpperCase() === "13F-HR") idxs.push(k);
  if (!idxs.length) throw bad(`No 13F-HR filings for CIK ${_cik} - confirm this is an institutional investment manager (>$100M AUM)`, 422);
  if (index >= idxs.length) return null;
  const at = idxs[index];
  const accession = recent.accessionNumber[at];
  const filedDate = recent.filingDate[at];
  const reportDate = recent.reportDate[at];
  const cikInt = parseInt(_cik, 10);
  const tableUrl = await fetchInformationTableUrl(cikInt, accession);
  if (!tableUrl) throw bad("13F-HR filing has no informationtable.xml attachment (older filing format?)", 502);
  const xml = await fetchXmlText(tableUrl);
  // The SEC's whole-dollars value change is effective for filings SUBMITTED on
  // or after 2023-01-03, so the unit multiplier must key on the FILED date, not
  // the period end (a Q4-2022 report filed in Feb 2023 uses whole dollars).
  let all = parse13fInformationTable(xml, filedDate);
  // The cover page (primary_doc.xml, ~5 KB): confidential treatment means the
  // table is INCOMPLETE by the manager's own declaration, and a later
  // 13F-HR/A "NEW HOLDINGS" amendment carries the omitted rows. Berkshire's
  // Q1-2025 original (isConfidentialOmitted=true, 110 rows) was completed on
  // 2025-08-14 by an amendment adding D R Horton, Lennar and Nucor - a diff
  // against the original alone reports those as NEW a quarter late.
  const cover = await settleCover(cikInt, accession);
  const amendments = [];
  for (let k = 0; k < recent.form.length; k++) {
    if (String(recent.form[k]).toUpperCase() !== "13F-HR/A" || recent.reportDate[k] !== reportDate) continue;
    const accA = recent.accessionNumber[k], filedA = recent.filingDate[k];
    const coverA = await settleCover(cikInt, accA);
    const type = String(coverA?.amendmentType || "").toUpperCase();
    let rows = null, tableA = null;
    try { tableA = await fetchInformationTableUrl(cikInt, accA); if (tableA) rows = parse13fInformationTable(await fetchXmlText(tableA), filedA); } catch { rows = null; }
    amendments.push({ accessionNumber: accA, filedDate: filedA, amendmentType: type || "UNKNOWN", rows: rows ? rows.length : null, informationTableUrl: tableA, applied: false });
    if (!rows) continue;
    if (type === "RESTATEMENT") { all = rows; amendments[amendments.length - 1].applied = true; }
    else if (type === "NEW HOLDINGS") { all = all.concat(rows); amendments[amendments.length - 1].applied = true; }
  }
  all.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const totalValueUsd = all.reduce((acc, r) => acc + (r.valueUsd ?? 0), 0);
  return { cik: _cik, managerName: sub?.name ?? resolved.name ?? null, accessionNumber: accession, filedDate, reportDate, informationTableUrl: tableUrl, totalHoldings: all.length, totalValueUsd, holdings: all,
    cover: cover ? { confidentialOmitted: cover.isConfidentialOmitted === true, tableEntryTotal: cover.tableEntryTotal, tableValueTotal: cover.tableValueTotal, otherIncludedManagersCount: cover.otherIncludedManagersCount } : null,
    amendments };
}

/** The 13F cover page's few facts (never throws; null when unreadable). */
export function parse13fCover(xml) {
  const t = (n) => { const m = String(xml || "").match(new RegExp(`<${n}>([^<]*)</${n}>`)); return m ? m[1].trim() : ""; };
  return {
    isAmendment: /^true$/i.test(t("isAmendment")), amendmentType: t("amendmentType") || null, amendmentNo: t("amendmentNo") || null,
    isConfidentialOmitted: /^true$/i.test(t("isConfidentialOmitted")), reportType: t("reportType") || null,
    tableEntryTotal: Number(t("tableEntryTotal")) || null, tableValueTotal: Number(t("tableValueTotal")) || null, otherIncludedManagersCount: Number(t("otherIncludedManagersCount")) || 0,
  };
}
async function settleCover(cikInt, accession) {
  try { return parse13fCover(await fetchXmlText(`https://www.sec.gov/Archives/edgar/data/${cikInt}/${String(accession).replace(/-/g, "")}/primary_doc.xml`)); } catch { return null; }
}

// The latest 13F-HR filing's identity ONLY (accession + dates) from the
// submissions index - ONE small JSON read, no information table. The monitor
// scheduler polls this daily per subscribed manager and only pays for a full
// report when the accession changes, so the check must stay this cheap.
export async function latest13fFiling({ cik }) {
  const resolved = await resolveCompany({ cik });
  const _cik = resolved.cik;
  const sub = await edgarGetJson(`https://data.sec.gov/submissions/CIK${_cik}.json`);
  const recent = sub?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) throw bad("Manager has no recent filings", 422);
  for (let k = 0; k < recent.form.length; k++) {
    if (String(recent.form[k]).toUpperCase() !== "13F-HR") continue;
    return { cik: _cik, managerName: sub?.name ?? resolved.name ?? null, accessionNumber: recent.accessionNumber[k], filedDate: recent.filingDate[k], reportDate: recent.reportDate[k] };
  }
  return null;
}

// Resolve an institutional manager by cik, ticker, or NAME. Most funds have no
// ticker, so a name resolves via EDGAR full-text search filtered to 13F-HR,
// taking the CIK that appears most across recent hits.
export async function resolveManager({ cik, ticker, name }) {
  if (cik || ticker) { const r = await resolveCompany({ cik, ticker }); return { cik: r.cik, name: r.name }; }
  const nm = String(name ?? "").trim();
  if (!nm) throw bad("Provide the manager's SEC CIK, ticker, or name", 400);
  const j = await eftsSearch({ q: `"${nm}"`, forms: "13F-HR" });
  const hits = j?.hits?.hits ?? [];
  // Build candidate entities from the hits' display_names (which embed the
  // registered name + CIK), keyed by CIK, tallying how often each appears.
  const cand = new Map();
  for (const h of hits) {
    const src = h?._source || {};
    const ciks = src.ciks || [];
    const dns = src.display_names || [];
    for (let k = 0; k < ciks.length; k++) {
      const c = padCik(ciks[k]); if (!c) continue;
      const dn = String(dns[k] || dns[0] || "").replace(/\s*\(CIK[^)]*\)\s*$/i, "").trim();
      const cur = cand.get(c) || { cik: c, name: dn, count: 0 };
      if (!cur.name && dn) cur.name = dn;
      cur.count++;
      cand.set(c, cur);
    }
  }
  if (!cand.size) throw bad(`No 13F filer found matching "${nm}" - try the manager's SEC CIK (find it on sec.gov EDGAR)`, 404);
  // Score by NAME-MATCH QUALITY, not raw frequency: an exact name wins; then a
  // prefix match, preferring the SHORTEST registered name (the closest to the
  // query - so "Berkshire Hathaway" resolves to the parent, not a longer-named
  // subsidiary), with hit frequency only as a final tiebreak.
  const nmUp = nm.toUpperCase();
  const score = (x) => {
    const en = (x.name || "").toUpperCase();
    if (en === nmUp) return 1e6;
    let base = 0;
    if (en.startsWith(nmUp)) base = 1e5;
    else if (en.includes(nmUp)) base = 1e4;
    return base - en.length * 10 + Math.min(x.count, 50);
  };
  const best = [...cand.values()].sort((a, b) => score(b) - score(a))[0];
  // Confidence floor: the candidate pool is polluted by funds that merely HOLD a
  // security whose issuer name matches the query (issuer names appear in the
  // info-tables), so a winner whose OWN registered name does not contain the
  // query is not a reliable match - refuse rather than silently sell a report
  // for the wrong manager.
  if (!best || !(best.name || "").toUpperCase().includes(nmUp)) {
    throw bad(`Could not confidently resolve "${nm}" to a 13F filer - try the manager's exact registered name or its SEC CIK (find it on sec.gov EDGAR).`, 404);
  }
  return { cik: best.cik, name: best.name || nm };
}

// ---------------------------------------------------------------------------
// Form 13F Data Sets - the SEC's bulk quarterly extracts (src/tools/edgar-13f-datasets.js).
// The archive is the product (100 MB, INFOTABLE 400 MB inflated), so the index
// tool reads the SEC's listing and the head tool reads two bounded byte ranges
// of one archive: the zip's central directory and the first 256 KB of ONE
// table. Never the whole zip, never a caller-supplied URL.
// ---------------------------------------------------------------------------
EDGAR_TOOLS.push(
  {
    route: "GET /api/edgar-13f-datasets",
    name: "EDGAR Form 13F data sets (index)",
    slug: "edgar-13f-datasets",
    category: "data",
    price: "$0.003",
    description:
      "The SEC's bulk Form 13F Data Sets: every quarterly (2013Q2-2023Q4) and rolling three-month (2024-) archive the SEC publishes, newest first, with its window, size and download URL, plus the seven tables each archive carries (SUBMISSION, COVERPAGE, OTHERMANAGER, OTHERMANAGER2, SIGNATURE, SUMMARYPAGE, INFOTABLE) and the readme. Read from sec.gov's own listing, cached 6 hours. Pair with edgar-13f-dataset-head to read a bounded head of one table without downloading the archive.",
    tags: ["edgar", "sec", "13F", "data-sets", "bulk", "institutional", "holdings"],
    discovery: {
      input: { limit: 3 },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Data sets to return, newest first (1-200, default 60)." },
        },
      },
      output: {
        example: {
          total: 54,
          count: 1,
          latest: "01jun2026-31aug2026",
          dataSets: [{ id: "01jun2026-31aug2026", from: "2026-06-01", to: "2026-08-31", quarter: null, label: "2026 June July August 13F", file: "01jun2026-31aug2026_form13f.zip", url: "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip", sizeMb: 96.05 }],
          tables: ["SUBMISSION", "COVERPAGE", "OTHERMANAGER", "OTHERMANAGER2", "SIGNATURE", "SUMMARYPAGE", "INFOTABLE"],
          readmeUrl: "https://www.sec.gov/files/form_13f_readme.pdf",
          source: "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets",
          note: "Each data set is one zip of seven TSV tables flattened from every 13F filed in the window.",
        },
      },
    },
    handler: (i) => dataSetsIndex(i || {}),
  },
  {
    route: "GET /api/edgar-13f-dataset-head",
    name: "EDGAR Form 13F data set head (one table, bounded)",
    slug: "edgar-13f-dataset-head",
    category: "data",
    price: "$0.005",
    description:
      "A bounded head of ONE table in a Form 13F data set, read with two byte-range requests against sec.gov (the archive's central directory plus the first 256 KB of the chosen table) so the multi-hundred-MB zip is never downloaded. Returns the archive's members with sizes, the table's columns and its first rows (1-200, default 25) as objects: SUMMARYPAGE (per filing: holdings count, total value, confidential-omission flag), SUBMISSION (accession, filer CIK, period, form), COVERPAGE (manager name and address, amendment flags), INFOTABLE (the holdings rows), OTHERMANAGER, OTHERMANAGER2, SIGNATURE. dataSet is an id from edgar-13f-datasets or latest. partial says whether the table was read in full.",
    tags: ["edgar", "sec", "13F", "data-sets", "bulk", "holdings", "tsv"],
    discovery: {
      input: { dataSet: "latest", table: "SUMMARYPAGE", rows: 5 },
      inputSchema: {
        properties: {
          dataSet: { type: "string", description: 'Data set id from edgar-13f-datasets (e.g. "01jun2026-31aug2026" or "2013q2"), or "latest" (default).' },
          table: { type: "string", description: "SUBMISSION, COVERPAGE, OTHERMANAGER, OTHERMANAGER2, SIGNATURE, SUMMARYPAGE (default) or INFOTABLE." },
          rows: { type: "number", description: "Rows to return from the head of the table (1-200, default 25)." },
        },
      },
      output: {
        example: {
          dataSet: { id: "01jun2026-31aug2026", label: "2026 June July August 13F", from: "2026-06-01", to: "2026-08-31", quarter: null, url: "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip", sizeMb: 96.05 },
          archiveBytes: 100719015,
          zip64: false,
          members: [{ name: "SUMMARYPAGE.tsv", bytes: 382912, compressedBytes: 126238, method: "deflate" }],
          table: "SUMMARYPAGE",
          file: "SUMMARYPAGE.tsv",
          columns: ["ACCESSION_NUMBER", "OTHERINCLUDEDMANAGERSCOUNT", "TABLEENTRYTOTAL", "TABLEVALUETOTAL", "ISCONFIDENTIALOMITTED"],
          rowsReturned: 1,
          rows: [{ ACCESSION_NUMBER: "0002134841-26-000139", OTHERINCLUDEDMANAGERSCOUNT: "0", TABLEENTRYTOTAL: "91", TABLEVALUETOTAL: "147088596", ISCONFIDENTIALOMITTED: "N" }],
          partial: false,
          bytesRead: 192774,
          note: "The whole SUMMARYPAGE.tsv member was read; rows is the first 5 of it.",
          readmeUrl: "https://www.sec.gov/files/form_13f_readme.pdf",
          source: "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets/01jun2026-31aug2026_form13f.zip",
        },
      },
    },
    handler: (i) => dataSetHead(i || {}),
  },
);

// Shared EDGAR primitives for the composite report kits (insider-flow, ipo):
// same User-Agent policy, same politeness, one implementation.
export { resolveCompany, eftsSearch, fetchXmlText, edgarGetJson, parse13fInformationTable };
