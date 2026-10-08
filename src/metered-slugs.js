// The slugs both catalog sweeps skip because their example answers spend a
// third-party key, a buyer wallet or an identity surface. Lives in src/ (not
// scripts/) so the running server can derive the count it publishes on
// /api/reliability from the same list the sweeps read; scripts/ is not shipped
// in the image. Keep in sync with the class of spend: adding a new keyed
// upstream means listing its slugs here (and skill packs resolve transitively,
// see meteredSkip below).
export const METERED_SLUGS = new Set([
  "attest",  // attest-kit.js: spends Base gas from the spending wallet, unset in CI
  // Databento equities: a query is billed by the bytes it returns and CI
  // holds no key on purpose, so an unkeyed sweep would 503 here and a keyed
  // one would spend on every push. Same rule as Brave, E2B and CoinGecko.
  "stock-quote", "stock-history",
  // Brave Search subscription
  "search", "search-lite", "search-news", "search-images", "search-videos", "search-suggest", "answer", "multi-search",
  "llm-context",      // Brave /llm/context - same subscription, billed per call
  // OpenAI
  "llm", "llm-pro", "llm-premium",
  "image-gen", "image-gen-hd", "image-gen-premium",
  "tts", "tts-hd", "tts-lite", "transcribe", "transcribe-pro",
  "embed", "embed-large", "moderate",
  // OpenRouter gateway
  "v1-chat-nano", "v1-chat-auto", "v1-chat-grounded", "v1-chat-ox", "v1-chat", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered",
  "v1-embeddings", "v1-rerank", "v1-images", "v1-audio-speech",
  "v1-chat-nano-messages", "v1-chat-auto-messages", "v1-chat-messages", "v1-chat-pro-messages", "v1-chat-premium-messages", "v1-chat-metered-messages",
  "v1-chat-nano-gemini", "v1-chat-auto-gemini", "v1-chat-gemini", "v1-chat-pro-gemini", "v1-chat-premium-gemini", "v1-chat-metered-gemini",
  "v1-audio-transcriptions", "v1-audio-transcriptions-pro",
  "v1-chat-nano-responses", "v1-chat-auto-responses", "v1-chat-responses", "v1-chat-pro-responses", "v1-chat-premium-responses", "v1-chat-metered-responses",
  // Calls the v1-chat gateway handler in-process — same OpenRouter key dependency.
  "pdf-summarize",
  // research-deep composites — fan out to grounded search + rerank + synthesis
  // over OpenRouter (503 without OPENROUTER_API_KEY), same key dependency.
  "research", "research-pro", "research-max",
  "dossier", "dossier-max",
  // fund-report composites — SEC 13F diff + grounded search + Opus synthesis
  // over OpenRouter (503 without OPENROUTER_API_KEY), same key dependency.
  "fund-report", "fund-report-max",
  // domain-audit composites — live probes + Opus synthesis over OpenRouter.
  "domain-audit", "domain-audit-pro",
  // recall-report - openFDA probes + Opus synthesis over OpenRouter.
  "recall-report", "insider-report", "market-brief", "token-brief", "filing-report", "linkedin-article",
  // ticker-pack - runs the dossier + insider composites in-process.
  "ticker-pack",
  // token-risk composites - keyless probes + Opus synthesis over OpenRouter.
  "token-risk", "token-risk-pro",
  // E2B
  "code-run", "code-run-pro",
  // Route-and-execute can buy external sellers
  "route-execute", "seller-payability", "route-execute-max", "route-execute-plus",
  // Flights buy from outside sellers (flights-kit.js).
  "flight-search", "flight-status",
  // Identity-bound (payment = identity)
  "memory-write", "memory-read", "memory-incr", "memory-cas", "memory-grant", "memory-revoke",
  "memory-grants", "memory-log", "memory-remember", "memory-recall", "memory-forget",
  "my-usage",
  "receipts",
  "feedback",        // feedback-kit.js: the verdict is bound to the wallet that paid for the rated call
  "judge",           // paid third-party judgment model; CI holds no key
  "decisions",       // the same judgment on the OpenAI Decisions wire
  "decide",          // decision service + model calls; CI runs no decide service
  "decide-execute",  // runs plans and pays sellers; CI runs no decide service
  // FRED keyed (503 without FRED_API_KEY / FRED_API_KEY_V2)
  "fred-series", "fred-search", "fred-series-info", "fred-release-calendar",
  "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds",
  "fred-release-observations",
  // Neynar / Farcaster
  "farcaster-profile", "farcaster-by-address",
  "fc-cast-search", "fc-channel-feed", "fc-trending", "fc-user-casts", "fc-cast",
  "fc-cast-replies", "fc-channel", "fc-user-search", "fc-cast-metrics",
  // X API v2 app-only bearer (per-post read billing) and the enrichment
  // providers - each lists only with its own key, and 503s without it.
  "x-search-recent", "x-user", "x-user-tweets", "x-tweet", "x-users-lookup",
  "exa-search", "exa-answer", "exa-contents",
  "hunter-domain-search", "hunter-email-finder", "hunter-email-verify", "hunter-company",
  "apollo-people-search", "apollo-org-enrich", "apollo-person-match",
  // OpenRouter Image + Video APIs (flat per-image / per-second upstream price).
  "v1-images-fast", "v1-images-pro", "v1-videos",
  // Alchemy hard-require (compute units) — publicJsonRpc-backed tools stay IN
  "wallet-balance", "token-metadata", "token-price", "wallet-transactions",
  "asset-transfers", "token-balances", "token-allowance", "tx-receipt",
  "block-receipts", "token-price-history",
  "nft-holdings", "nft-metadata", "gas-snapshot", "eth-call",
  "dex-pair", "dex-pool", "dex-quote",
  "nft-collection", "nft-floor",
  "l2-gas-comparison",
  // CDP (Coinbase Developer Platform keys)
  "wallet-balances", "testnet-fund", "onramp-link", "onchain-sql", "onchain-sql-schema",
]);

/** Pack slugs (the name after "skill-") whose advertised toolSlugs reach a
 *  metered slug: the sweeps skip those packs too. */
export function meteredPackSlugs(packs = []) {
  const out = new Set();
  for (const p of packs) if ((p.toolSlugs || []).some((t) => METERED_SLUGS.has(t))) out.add(p.slug);
  return out;
}

/** How many of a catalog's priced routes the sweeps skip as metered: the slug
 *  is in METERED_SLUGS, or it is a skill pack reaching one. Same rule as the
 *  sweep's excludeReason (scripts/test-non-metered-examples.js). */
export function meteredSkip(catalog = {}, packs = []) {
  const packsHit = meteredPackSlugs(packs);
  let metered = 0, total = 0;
  for (const [route, def] of Object.entries(catalog)) {
    if (!def || !def.slug) continue;
    // Priced routes only, as the sweeps scope themselves (price > 0).
    if (!(Number(String(def.price ?? "").replace(/[^0-9.]/g, "")) > 0)) continue;
    total++;
    const path = String(route).split(" ")[1] || "";
    const pack = def.slug.startsWith("skill-") ? def.slug.slice(6) : path.startsWith("/api/skill/") ? path.slice("/api/skill/".length) : null;
    if (METERED_SLUGS.has(def.slug) || (pack && packsHit.has(pack))) metered++;
  }
  return { metered, total };
}
