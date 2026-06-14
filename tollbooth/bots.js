// Default set of AI / LLM crawler and agent user-agents to charge.
//
// Deliberately AI-focused: traditional search indexers (Googlebot, Bingbot,
// DuckDuckBot) are NOT here — you almost always want classic SEO indexing to
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
