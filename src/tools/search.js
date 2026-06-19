// Live web search — the one thing in the catalog an agent genuinely cannot
// self-host: fresh results from an independent search index (Brave Search API).
// Wallet-only (each call consumes paid upstream quota, so it is never
// proof-of-work eligible). Requires BRAVE_API_KEY; without it the endpoints
// report themselves unconfigured instead of failing opaquely.
//
// Four endpoints share one upstream (api.search.brave.com), one auth header
// (X-Subscription-Token), and one error vocabulary. `braveGet` factors that
// out — the handlers below only differ in path + result shape.

const BRAVE_HOST = "https://api.search.brave.com/res/v1";
const TIMEOUT_MS = 10000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Trim+cap user-supplied query strings the same way for every Brave route.
// Brave's documented limits: 400 chars and 50 words; we enforce chars here
// (50-word check is upstream's problem and surfaces as a 422).
function takeQuery(raw) {
  const q = typeof raw === "string" ? raw.trim().slice(0, 400) : "";
  if (!q) throw bad('"q" is required');
  return q;
}

async function braveGet(path, params) {
  if (!process.env.BRAVE_API_KEY) {
    throw bad("Web search is not configured on this deployment", 503);
  }
  const url = new URL(`${BRAVE_HOST}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw bad("Search upstream timed out", 504);
  }
  // Controlled messages only — never echo the upstream body to callers, but
  // do surface the upstream status code so plan-tier mismatches (401/403) are
  // distinguishable from real outages (5xx) in logs and error tracking.
  if (res.status === 429) throw bad("Search rate limit reached upstream — retry shortly", 503);
  if (!res.ok) throw bad(`Search upstream error (HTTP ${res.status})`, 502);
  return res.json();
}

// Whitelist freshness values once — Brave also accepts YYYY-MM-DDtoYYYY-MM-DD
// custom ranges, which we deliberately don't expose (simpler agent-facing API).
const FRESHNESS = new Set(["pd", "pw", "pm", "py"]);

export const SEARCH_TOOLS = [
  {
    route: "GET /api/search",
    name: "Web search",
    slug: "search",
    category: "web",
    price: "$0.01",
    description:
      "Live web search: ranked results (title, URL, snippet, age) from an independent search index as clean JSON — fresh pages your model's training cutoff has never seen. Optional freshness filter (pd/pw/pm/py = past day/week/month/year).",
    tags: ["search", "web-search", "serp", "fresh-data", "research"],
    discovery: {
      input: { q: "x402 payment protocol adoption", count: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Search query (max 400 chars)" },
          count: { type: "number", description: "Results to return, 1-20 (default 10)" },
          freshness: { type: "string", description: "Optional: pd, pw, pm, or py (past day/week/month/year)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "x402 payment protocol adoption",
          count: 5,
          results: [
            { title: "x402: An open standard for internet-native payments", url: "https://www.x402.org/", description: "HTTP 402 brought to life…", age: null },
          ],
        },
      },
    },
    handler: async (i) => {
      const q = takeQuery(i.q);
      const count = Math.min(Math.max(parseInt(i.count, 10) || 10, 1), 20);
      const data = await braveGet("/web/search", {
        q, count,
        freshness: FRESHNESS.has(i.freshness) ? i.freshness : undefined,
      });
      const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
        title: r.title ?? null,
        url: r.url ?? null,
        description: r.description ?? null,
        age: r.age ?? null,
      }));
      return { query: q, count: results.length, results };
    },
  },

  {
    route: "GET /api/search-news",
    name: "News search",
    slug: "search-news",
    category: "web",
    price: "$0.01",
    description:
      "Live news search: ranked recent articles (title, URL, snippet, age, source, breaking flag) from an independent search index as clean JSON. Same freshness filter as web search (pd/pw/pm/py). Optimized for current-events queries where the web index lags.",
    tags: ["search", "news", "fresh-data", "breaking-news", "research"],
    discovery: {
      input: { q: "Federal Reserve interest rate decision", count: 5, freshness: "pw" },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Search query (max 400 chars)" },
          count: { type: "number", description: "Results to return, 1-50 (default 10)" },
          freshness: { type: "string", description: "Optional: pd, pw, pm, or py (past day/week/month/year)" },
          country: { type: "string", description: "Optional 2-letter country code (default US)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "Federal Reserve interest rate decision",
          count: 3,
          results: [
            { title: "Fed holds rates steady", url: "https://example.com/article", description: "Policymakers voted…", age: "2 hours ago", source: "example.com", breaking: false },
          ],
        },
      },
    },
    handler: async (i) => {
      const q = takeQuery(i.q);
      const count = Math.min(Math.max(parseInt(i.count, 10) || 10, 1), 50);
      const country = typeof i.country === "string" && /^[A-Za-z]{2}$/.test(i.country) ? i.country.toUpperCase() : undefined;
      const data = await braveGet("/news/search", {
        q, count, country,
        freshness: FRESHNESS.has(i.freshness) ? i.freshness : undefined,
      });
      const results = (data.results ?? []).slice(0, count).map((r) => ({
        title: r.title ?? null,
        url: r.url ?? null,
        description: r.description ?? null,
        age: r.age ?? null,
        source: r.meta_url?.hostname ?? null,
        breaking: r.breaking === true,
      }));
      return { query: q, count: results.length, results };
    },
  },

  {
    route: "GET /api/search-images",
    name: "Image search",
    slug: "search-images",
    category: "web",
    price: "$0.01",
    description:
      "Live image search: ranked image results (title, source page, image URL, thumbnail URL, dimensions) from an independent search index as clean JSON. Strict safe-search is on by default.",
    tags: ["search", "images", "visual", "research"],
    discovery: {
      input: { q: "san francisco golden gate bridge sunset", count: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Search query (max 400 chars)" },
          count: { type: "number", description: "Results to return, 1-50 (default 10)" },
          safesearch: { type: "string", description: "Optional: 'strict' (default) or 'off'" },
          country: { type: "string", description: "Optional 2-letter country code (default US)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "san francisco golden gate bridge sunset",
          count: 2,
          results: [
            { title: "Golden Gate at sunset", source: "https://example.com/page", image: "https://example.com/img.jpg", thumbnail: "https://imgs.search.brave.com/...", width: 1920, height: 1080 },
          ],
        },
      },
    },
    handler: async (i) => {
      const q = takeQuery(i.q);
      const count = Math.min(Math.max(parseInt(i.count, 10) || 10, 1), 50);
      const safesearch = i.safesearch === "off" ? "off" : "strict";
      const country = typeof i.country === "string" && /^[A-Za-z]{2}$/.test(i.country) ? i.country.toUpperCase() : undefined;
      const data = await braveGet("/images/search", { q, count, safesearch, country });
      const results = (data.results ?? []).slice(0, count).map((r) => ({
        title: r.title ?? null,
        source: r.url ?? null,
        image: r.properties?.url ?? null,
        thumbnail: r.thumbnail?.src ?? null,
        width: r.properties?.width ?? null,
        height: r.properties?.height ?? null,
      }));
      return { query: q, count: results.length, results };
    },
  },

  {
    route: "GET /api/search-suggest",
    name: "Search autocomplete",
    slug: "search-suggest",
    category: "web",
    // Autocomplete is high-frequency, low-information per call — priced 10×
    // cheaper than the other Brave routes so query-expansion agents can use it
    // generously without burning paid quota on the buyer side.
    price: "$0.001",
    description:
      "Search autocomplete: query suggestions for a partial input as a flat JSON array. Useful for query expansion, did-you-mean refinement, and topic exploration. Returns up to 20 suggestions.",
    tags: ["search", "autocomplete", "suggest", "query-expansion"],
    discovery: {
      input: { q: "agent4", count: 5 },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Partial query (max 400 chars)" },
          count: { type: "number", description: "Suggestions to return, 1-20 (default 5)" },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "agent4",
          count: 5,
          suggestions: ["agent402", "agent4 mexico", "agent4 movie", "agent4you", "agent 47"],
        },
      },
    },
    handler: async (i) => {
      const q = takeQuery(i.q);
      const count = Math.min(Math.max(parseInt(i.count, 10) || 5, 1), 20);
      const data = await braveGet("/suggest/search", { q, count });
      // Brave returns { results: [{query, ...rich fields requiring paid plan}, ...] }.
      // We surface only the suggestion string — `rich` enrichment requires a
      // separate subscription tier, and a flat string[] is what agents want.
      const suggestions = (data.results ?? []).slice(0, count).map((r) => r.query).filter((s) => typeof s === "string");
      return { query: q, count: suggestions.length, suggestions };
    },
  },
];
