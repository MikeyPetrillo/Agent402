// Live web search — the one thing in the catalog an agent genuinely cannot
// self-host: fresh results from an independent search index (Brave Search API).
// Wallet-only (each call consumes paid upstream quota, so it is never
// proof-of-work eligible). Requires BRAVE_API_KEY; without it the endpoint
// reports itself unconfigured instead of failing opaquely.

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 10000;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

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
      if (!process.env.BRAVE_API_KEY) {
        throw bad("Web search is not configured on this deployment", 503);
      }
      const q = typeof i.q === "string" ? i.q.trim().slice(0, 400) : "";
      if (!q) throw bad('"q" is required');
      const count = Math.min(Math.max(parseInt(i.count, 10) || 10, 1), 20);
      const url = new URL(BRAVE_URL);
      url.searchParams.set("q", q);
      url.searchParams.set("count", String(count));
      if (["pd", "pw", "pm", "py"].includes(i.freshness)) url.searchParams.set("freshness", i.freshness);

      let res;
      try {
        res = await fetch(url, {
          headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY, Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw bad("Search upstream timed out", 504);
      }
      // Controlled messages only — never echo the upstream body to callers.
      if (res.status === 429) throw bad("Search rate limit reached upstream — retry shortly", 503);
      if (!res.ok) throw bad("Search upstream error", 502);
      const data = await res.json();
      const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
        title: r.title ?? null,
        url: r.url ?? null,
        description: r.description ?? null,
        age: r.age ?? null,
      }));
      return { query: q, count: results.length, results };
    },
  },
];
