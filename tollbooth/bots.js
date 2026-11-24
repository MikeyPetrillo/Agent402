// Default set of AI / LLM crawler and agent user-agents to charge.
//
// Deliberately AI-focused: traditional search indexers (Googlebot, Bingbot,
// DuckDuckBot) are NOT here (GoogleOther, Google's fetcher for work outside
// Search, is), you almost always want classic SEO indexing to
// stay free. Override the whole list with `botUserAgents`, or supply your own
// `charge(req)` predicate for full control.
export const AI_BOTS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User",
  "ClaudeBot", "Claude-Web", "anthropic-ai", "Claude-User",
  "PerplexityBot", "Perplexity-User",
  "CCBot", "Bytespider", "Google-Extended", "Amazonbot",
  "cohere-ai", "Meta-ExternalAgent", "Meta-ExternalFetcher",
  "Applebot-Extended", "Diffbot", "Omgilibot", "ImagesiftBot",
  "YouBot", "Timpibot", "DuckAssistBot", "PetalBot",
  "FriendlyCrawler", "AI2Bot", "Scrapy", "python-requests",
  "Claude-SearchBot", "MistralAI-User", "GoogleOther", "Google-CloudVertexBot",
  "GoogleAgent-Mariner", "cohere-training-data-crawler", "FirecrawlAgent",
  "PhindBot", "PanguBot", "img2dataset", "Webzio-Extended", "YandexAdditional",
  "bedrockbot", "iaskspider", "Andibot", "Kangaroo Bot", "python-httpx",
];

/**
 * Build a fast case-insensitive substring matcher over a user-agent list.
 * @param {string[]} list
 * @returns {(userAgent?: string) => boolean}
 */
export function makeBotMatcher(list = AI_BOTS) {
  const needles = list.map((s) => s.toLowerCase());
  return (userAgent = "") => {
    const ua = String(userAgent).toLowerCase();
    if (!ua) return false;
    return needles.some((n) => ua.includes(n));
  };
}

// Whether a request path is one of the configured health paths, for the
// empty-User-Agent health-check exemption. Shared by the Node middleware
// (index.js) and the edge (edge.js). It reads the RAW path a router matches
// (query stripped) and compares it exactly: a router resolves no dot segment
// or percent escape the way a URL parser does, so a path holding "%" or a "."
// or ".." segment is never a health path, even when it normalizes to one.
export function isHealthPath(rawPath, healthSet) {
  if (!healthSet || !healthSet.size) return false;
  const path = String(rawPath == null ? "" : rawPath).split("?")[0].split("#")[0];
  if (!path.startsWith("/") || path.includes("%") || path.includes("\\")) return false;
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return false;
  return healthSet.has(path);
}
