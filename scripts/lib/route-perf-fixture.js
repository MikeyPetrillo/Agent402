// Deterministic prod-sized synthetic index for the router performance pin
// (scripts/test-route-perf.js). Shape measured on prod 2026-09-18: 4,224
// sellers, 108,095 tools, 3,063 routable; one seller in fifty carries several
// hundred routes (api.nodeseller.example 543, mpp.hireseller.example 226). The vocabulary
// is a hundred "hot" words every real query reaches for, a handful of
// stopword-class words that sit in most descriptions (the "to" in "json to
// csv" selects a third of the pool), and thousands of filler tokens so the
// vocabulary is as sparse as a real crawl's (~100k distinct tokens).
//
// The RNG is seeded, the insertion order is fixed, and Bazaar quality is
// assigned by index, so the SAME fixture is rebuilt on every run and a golden
// ranking captured from one version of routeQuery can be compared against
// another. Change nothing here without regenerating the golden.
const HOT = ["json", "csv", "convert", "ip", "geolocation", "address", "lookup", "chat", "completions", "model", "openai", "weather", "forecast", "price", "token", "swap", "quote", "stock", "hash", "sha256", "image", "resize", "pdf", "extract", "text", "summarize", "search", "web", "news", "dns", "whois", "domain", "email", "validate", "phone", "currency", "fx", "rate", "block", "transaction", "wallet", "balance", "nft", "metadata", "translate", "sentiment", "ocr", "qr", "barcode", "time", "zone", "cron", "uuid", "random", "number", "math", "stats", "regex", "markdown", "html", "strip", "render", "screenshot", "crawl", "sitemap", "robots", "tls", "cert", "spf", "dmarc", "geo", "distance", "map", "route", "flight", "hotel", "recipe", "nutrition", "calorie", "fitness", "sports", "score", "game", "movie", "music", "lyrics", "book", "joke", "fact", "trivia", "api", "data", "get", "list", "fetch", "agent", "x402", "usdc", "base", "chain"];
const STOP = ["to", "the", "and", "for", "a", "of", "on", "with"];
export const FIXTURE = { sellers: 3000, toolsTarget: 100000, filler: 3000, localTools: 600 };

export function seededRng(seed = 42) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

export function buildRoutePerfFixture({ cache, setBazaarQuality, sellers = FIXTURE.sellers, toolsTarget = FIXTURE.toolsTarget, filler = FIXTURE.filler, localTools = FIXTURE.localTools } = {}) {
  const rnd = seededRng(42);
  const words = [...HOT];
  for (let i = 0; i < filler; i++) words.push(`w${i.toString(36)}x`);
  const pick = () => words[Math.floor(rnd() * words.length)];
  const hot = () => HOT[Math.floor(rnd() * HOT.length)];
  const stop = () => STOP[Math.floor(rnd() * STOP.length)];
  // A description: mostly filler-or-hot words with two stopwords, like prose.
  const sentence = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(i === 2 || i === 7 ? stop() : pick()); return out.join(" "); };
  const perSeller = Math.round(toolsTarget / sellers);
  let total = 0;
  for (let i = 0; i < sellers; i++) {
    const origin = `https://seller${i}.example`;
    const n = i % 50 === 0 ? perSeller * 8 : perSeller;
    const tools = [];
    for (let j = 0; j < n; j++) {
      const a = hot(), b = hot();
      tools.push({
        seller: origin, method: rnd() < 0.5 ? "GET" : "POST", route: `/api/${a}-${b}-${j}`,
        slug: `${a}-${b}${j % 7 === 0 ? "" : "-" + pick()}`, name: `${a} ${b} ${pick()}`, description: sentence(14),
        category: hot(), tags: [pick(), pick(), hot()], price: Math.round(rnd() * 100) / 1000,
        networks: ["eip155:8453"], payToByNetwork: { "eip155:8453": "0x" + String(i).padStart(40, "0") },
      });
    }
    total += tools.length;
    cache.set(origin, { manifest: { name: `s${i}`, homepage: origin }, tools, fetchedAt: 1_700_000_000_000 + i, error: null, history: i % 97 === 0 ? [1, 1, 0] : [1, 1, 1, 1, 1] });
    if (i % 3 === 0 && setBazaarQuality) setBazaarQuality(origin, { calls30d: 10 + i, payers30d: 1 + (i % 30), lastCalledAt: null });
  }
  const catalog = {};
  for (let i = 0; i < localTools; i++) {
    const a = hot(), b = hot();
    catalog[`POST /api/${a}-${b}-${i}`] = { route: `POST /api/${a}-${b}-${i}`, slug: `${a}-${b}-${i}`, name: `${a} ${b} ${pick()}`, description: sentence(16), category: hot(), tags: [pick(), hot()], price: "$0.002", discovery: { input: {} }, handler: async () => ({}) };
  }
  const ctx = { baseUrl: "https://agent402.tools", catalog, prices: {}, network: "base", toolCount: localTools, walletName: "w" };
  return { ctx, totalRemoteTools: total };
}

export const GOLDEN_QUERIES = ["ip geolocation", "json to csv", "chat completions", "weather forecast", "qr code", "fx rate", "pdf extract text", "wallet balance", "cron next", "web search"];
