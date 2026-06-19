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
// Answers streams ~5s on average for single-search mode (Brave's published p50)
// but the SSE response can run longer than the GET routes' fixed budget.
// 20s gives Brave headroom without holding the dyno indefinitely.
const ANSWER_TIMEOUT_MS = 20000;

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

// Answers is a different shape: POST to an OpenAI-compatible /chat/completions
// endpoint, streamed SSE, with citations embedded as <citation>...</citation>
// tags inside the assistant content. We accumulate the stream, then parse out
// the structured citation tags into a clean { answer, citations[] } payload.
//
// Brave issues a DISTINCT subscription token for Answers vs Web Search, even
// though both products live under api.search.brave.com. Same dual-key pattern
// as FRED v1 / FRED v2 in macro-kit: separate keys gate separate product SKUs.
// We read BRAVE_ANSWERS_API_KEY here, with a fallback to BRAVE_API_KEY so a
// deployer who only has one combined subscription token still works.
//
// Unit economics (per Brave's published pricing — confirmed on dashboard):
//   • $0.004 base per query
//   • $0.005 per 1M input tokens  (we cap input at 400 chars ≈ ~100 tokens)
//   • $0.005 per 1M output tokens (typical answer ≈ 1000-1500 tokens)
// Expected cost per call ≈ $0.012; worst-case (long answer) ≈ $0.025.
// We charge $0.03 → average ~60% margin, still profitable on tail-length cases.
async function braveAnswerPost(query, opts = {}) {
  const token = process.env.BRAVE_ANSWERS_API_KEY || process.env.BRAVE_API_KEY;
  if (!token) {
    throw bad("Web answer is not configured on this deployment", 503);
  }
  let res;
  try {
    res = await fetch(`${BRAVE_HOST}/chat/completions`, {
      method: "POST",
      headers: {
        "X-Subscription-Token": token,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: query }],
        model: "brave",
        // Citations require streaming per Brave's docs. We stream from the
        // upstream and then return a single JSON envelope to the caller —
        // the streaming is an implementation detail of the upstream API.
        stream: true,
        enable_citations: true,
        enable_entities: false,
        // research mode can take minutes — incompatible with a tool budget.
        enable_research: false,
        // OpenAI-compatible ceiling on generated tokens. Caps the long-answer
        // tail so a runaway 4000-token response can't blow past our $0.025
        // worst-case estimate. Default 1024 fits the typical 1000-1500 token
        // answer; callers can override to expand (research questions) or
        // shrink (TL;DR use cases). Assumes Brave honors max_tokens on the
        // brave model — if they ever ignore it, the cost ceiling is lost
        // silently and we'd need server-side truncation in the SSE loop.
        max_tokens: opts.maxTokens || 1024,
        country: opts.country || "us",
        language: opts.language || "en",
      }),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
  } catch {
    throw bad("Web answer upstream timed out", 504);
  }
  if (res.status === 429) throw bad("Web answer rate limit reached upstream — retry shortly", 503);
  if (!res.ok) throw bad(`Web answer upstream error (HTTP ${res.status})`, 502);

  // SSE accumulation. Each event line is `data: <json>` or `data: [DONE]`.
  // We only care about choices[0].delta.content — Brave concatenates plain
  // text and tag-wrapped JSON into a single string we'll post-process.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data);
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") content += delta;
      } catch { /* ignore malformed chunks — Brave occasionally emits keep-alives */ }
    }
  }
  return content;
}

// Pull the embedded <citation>...</citation> JSON blobs out of the raw answer
// text, return clean prose + a structured citations array. Also strips
// <usage> and <enum_item> tags so they don't bleed into the caller-visible
// answer string. De-dupes citations by URL.
function parseAnswer(raw) {
  const citations = [];
  let answer = "";
  let last = 0;
  for (const m of raw.matchAll(/<citation>([\s\S]*?)<\/citation>/g)) {
    answer += raw.slice(last, m.index);
    try {
      const c = JSON.parse(m[1]);
      citations.push({
        url: typeof c.url === "string" ? c.url : null,
        snippet: typeof c.snippet === "string" ? c.snippet : null,
        favicon: typeof c.favicon === "string" ? c.favicon : null,
        number: typeof c.number === "number" ? c.number : null,
      });
    } catch { /* skip malformed citation tag */ }
    last = m.index + m[0].length;
  }
  answer += raw.slice(last);
  // Strip remaining structural tags Brave emits inside the content stream.
  answer = answer
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .replace(/<enum_item>[\s\S]*?<\/enum_item>/g, "")
    .trim();
  // De-dupe citations by URL (Brave can repeat the same source across paras).
  const seen = new Set();
  const unique = citations.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
  return { answer, citations: unique };
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

  {
    route: "GET /api/answer",
    name: "Web answer",
    slug: "answer",
    category: "web",
    // $0.03 chosen against Brave's published unit cost (~$0.012 typical /
    // ~$0.025 long-answer worst case): ~60% margin on the average call,
    // still profitable at the tail. See braveAnswerPost above for the math.
    price: "$0.03",
    description:
      "AI-generated answer to a natural-language question, grounded in live web search results with source citations. Returns clean prose plus a structured citations array (URL, snippet, favicon) — backed by an independent search index, not the model's training data. Useful when an agent needs a synthesized answer plus the receipts to verify or follow up.",
    tags: ["search", "answer", "ai", "rag", "citations", "research", "fresh-data"],
    discovery: {
      input: { q: "what is the x402 payment protocol?" },
      inputSchema: {
        properties: {
          q: { type: "string", description: "Natural-language question (max 400 chars)" },
          country: { type: "string", description: "Optional 2-letter country code (default us)" },
          language: { type: "string", description: "Optional 2-letter language code (default en)" },
          max_tokens: { type: "integer", description: "Optional cap on the generated answer length in tokens (default 1024, min 64, max 4096). Lower for TL;DR; higher for research questions." },
        },
        required: ["q"],
      },
      output: {
        example: {
          query: "what is the x402 payment protocol?",
          answer:
            "x402 is an open standard for internet-native, pay-per-request HTTP APIs that uses the HTTP 402 \"Payment Required\" status code to negotiate and settle micro-payments inline with the original request.",
          citations: [
            {
              url: "https://www.x402.org/",
              snippet: "x402: An open standard for internet-native payments.",
              favicon: "https://imgs.search.brave.com/...",
              number: 1,
            },
          ],
          citationCount: 1,
        },
      },
    },
    handler: async (i) => {
      const q = takeQuery(i.q);
      const country = typeof i.country === "string" && /^[A-Za-z]{2}$/.test(i.country) ? i.country.toLowerCase() : undefined;
      const language = typeof i.language === "string" && /^[A-Za-z]{2}$/.test(i.language) ? i.language.toLowerCase() : undefined;
      // Clamp caller-supplied max_tokens into a sane range. 64 floor prevents
      // useless one-sentence answers; 4096 ceiling protects the cost-per-call
      // ceiling even if a caller passes a giant number. Anything outside the
      // range or non-numeric falls back to the upstream-side default (1024).
      let maxTokens;
      if (Number.isFinite(i.max_tokens)) {
        maxTokens = Math.max(64, Math.min(4096, Math.floor(i.max_tokens)));
      }
      const raw = await braveAnswerPost(q, { country, language, maxTokens });
      const { answer, citations } = parseAnswer(raw);
      if (!answer) throw bad("Web answer upstream returned no content", 502);
      return { query: q, answer, citations, citationCount: citations.length };
    },
  },
];
