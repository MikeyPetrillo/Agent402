// Comprehensive coverage: call EVERY tool in the catalog with its own documented
// example and verify a sensible response. Drives itself from /openapi.json over
// HTTP, so it exercises real routing + handlers for all ~1070 endpoints.
//
//   TARGET_URL=http://127.0.0.1:3000 node scripts/test-all.js
//
// Pure-CPU tools must return 200 with no error. Network/browser tools are
// exercised but tolerant of upstream/sandbox failures (they need real egress;
// CI has it). Memory tools get a demo namespace and accept their valid 4xx.
import { missingDocumentedKeys, emptyPromisedArrays } from "./sweep-shape.js";

const TARGET = process.env.TARGET_URL || "http://127.0.0.1:3000";

// Tools that reach the network/browser — lenient (need real egress).
// Brave-backed routes — opt-in via BRAVE_LIVE_TEST=1. Every [test] CI run
// otherwise burns the Brave subscription with calls the daily paid-canary
// already covers post-deploy. When skipped, these routes are simply not
// exercised by this sweep — search-kit shape/validation is covered by
// scripts/test-search-kit.js and post-deploy by scripts/paid-canary.js.
const BRAVE_ROUTES = new Set([
  "/api/search", "/api/search-news", "/api/search-images", "/api/search-videos", "/api/search-suggest", "/api/answer",
  "/api/multi-search",
  // Skill packs whose EXECUTABLE steps invoke Brave-backed handlers in-process
  // (skill-runner bypasses the HTTP route, so the direct-route skip above never
  // caught them — every [test] run was making ~9 real web-search calls through
  // pack examples, found in the 2026-07-23 Brave leak audit). Same opt-in.
  "/api/skill/crypto-research", "/api/skill/search-and-cite", "/api/skill/company-dossier",
  "/api/skill/crypto-dossier", "/api/skill/earnings-watch", "/api/skill/ipo-watch",
  "/api/skill/brand-protection", "/api/skill/article-digest",
  // Added 2026-07-28: packs created AFTER the 07-23 audit whose steps also call
  // a Brave-backed tool. They reopened the leak silently - measured at ~2.3
  // Brave requests per CI run (down from ~10.4 pre-audit, so the first fix
  // worked and only the newcomers were missing). scripts/test-brave-leak.js now
  // fails CI if any pack reaching Brave is absent from this set, so the third
  // recurrence cannot happen quietly.
  "/api/skill/earnings-deep-dive", "/api/skill/options-analytics", "/api/skill/defi-protocol-scanner",
  // Added 2026-08-02 after an outbound counter measured 2 live Brave calls per
  // run that BOTH previous guards cleared. Neither of these names a Brave slug
  // anywhere: research-company calls the search-news HANDLER in-process, and
  // financial-research composes research-company. A check for "does this use a
  // Brave slug" sees nothing in either, which is why test-brave-leak.js now
  // resolves reach through kits rather than by slug name.
  "/api/research-company", "/api/skill/financial-research",
  // Added 2026-08-22 with the llm-context kit. It is not a search TOOL and it
  // does not call one - it spends the SAME Brave subscription directly, on
  // Brave's /llm/context endpoint. Unskipped, every CI run would buy one live
  // grounding-context request. test-brave-leak.js now resolves that reach
  // structurally (a kit that names the Brave host, or imports the search kit's
  // meter, is Brave-reaching) so this entry cannot be forgotten quietly.
  "/api/llm-context",
]);
const skipBrave = process.env.BRAVE_LIVE_TEST !== "1";

// E2B-backed routes — same leak shape as Brave (found in the 2026-07-29 paid-
// upstream audit): the CI test job boots the server with the REAL E2B_API_KEY,
// so this sweep's example calls spin real sandboxes and bill the E2B account
// invisibly (CI has no PostHog). The old NETWORK-set comment assumed the key
// was absent in CI; it is not. Live coverage stays in the dedicated
// scripts/test-code-run-kit.js step, which runs live deliberately in CI.
const E2B_ROUTES = new Set([
  "/api/code-run", "/api/code-run-pro",
]);
const skipE2b = process.env.E2B_LIVE_TEST !== "1";

const NETWORK = new Set([
  "/v1/images/fast", "/v1/images/pro", "/v1/videos/generations",  // llm-images-fast-kit.js
  "/api/asset-transfers", "/api/token-balances", "/api/token-allowance", "/api/tx-receipt", "/api/block-receipts", "/api/token-price-history",  // alchemy-data-kit.js
  "/api/fc-cast-search", "/api/fc-channel-feed", "/api/fc-trending", "/api/fc-user-casts", "/api/fc-cast", "/api/fc-cast-replies", "/api/fc-channel", "/api/fc-user-search", "/api/fc-cast-metrics",  // farcaster-social-kit.js
  "/api/coin-price-by-contract", "/api/coin-profile", "/api/coin-history", "/api/coin-ohlc", "/api/coin-market-chart-range", "/api/coin-categories", "/api/global-defi", "/api/exchanges", "/api/exchange-tickers", "/api/exchange-rates", "/api/coin-search", "/api/coins-list",
  "/api/rwa-list", "/api/rwa-markets", "/api/rwa-asset", "/api/rwa-issuers", "/api/rwa-issuer",  // crypto-markets-kit.js
  "/api/defi-yields", "/api/defi-yield-history", "/api/defi-protocols", "/api/defi-protocol", "/api/defi-chains", "/api/defi-chain-tvl-history", "/api/stablecoins", "/api/stablecoin-supply-history", "/api/defi-fees", "/api/defi-dex-volume",  // defi-kit.js
  "/api/crypto-news", "/api/crypto-indicators", "/api/crypto-market-pulse",  // crypto-signals-kit.js
  "/api/site-map", "/api/site-crawl",  // crawl-kit.js
  "/api/perp-markets", "/api/perp-funding", "/api/perp-funding-screener", "/api/perp-open-interest", "/api/perp-klines", "/api/perp-orderbook", "/api/perp-basis",
  "/api/options-summary", "/api/crypto-options-chain", "/api/options-ticker", "/api/options-volume",
  "/api/sol-token-safety", "/api/sol-token-report", "/api/sol-token-holders", "/api/sol-token-pairs", "/api/sol-token-search", "/api/sol-trending", "/api/sol-price", "/api/sol-swap-quote", "/api/sol-token-lookup",
  "/api/x-search-recent", "/api/x-user", "/api/x-user-tweets", "/api/x-tweet", "/api/x-users-lookup",
  "/api/hunter-domain-search", "/api/hunter-email-finder", "/api/hunter-email-verify", "/api/hunter-company", "/api/apollo-people-search", "/api/apollo-org-enrich", "/api/apollo-person-match",
  "/api/extract", "/api/meta", "/api/dns", "/api/render", "/api/screenshot", "/api/pdf",
  "/api/http-check", "/api/tls-cert", "/api/whois", "/api/robots-check", "/api/sitemap",
  "/api/email-validate", "/api/ip-info", "/api/search", "/api/search-news", "/api/search-images", "/api/search-videos", "/api/search-suggest", "/api/answer", "/api/multi-search",
  "/api/llm-context",  // llm-context-kit.js (Brave grounding context - live egress, skipped by BRAVE_ROUTES)
  // Web-content kit: archive.org (archive-snapshot), caller feed URLs
  // (feed-parse), caller redirect chains (unshorten-url) — all live egress.
  "/api/archive-snapshot", "/api/feed-parse", "/api/unshorten-url",
  // a2a-card-fetch: its example fetches the static sample card on PROD, which
  // 404s on the CI run that first ships the route — lenient until deployed.
  "/api/a2a-card-fetch",
  // Blockscout kit: paid x402 upstream — 503 without X402_UPSTREAM_BUYER_KEY
  // (CI boots keyless; the real path costs $0.002/call and is canary-class).
  "/api/contract-inspect", "/api/address-profile", "/api/token-info", "/api/token-holders", "/api/tx-inspect",
  // route-execute-max/-plus: external tiers may pay an upstream seller — lenient.
  "/api/route/execute-max", "/api/route/execute-plus",
  // captcha-verify hits a live provider siteverify (egress) — lenient.
  "/api/captcha-verify",
  "/api/pdf-info", "/api/pdf-merge", "/api/pdf-extract-pages", "/api/pdf-rotate", "/api/images-to-pdf",
  "/api/pdf-to-markdown",
  // pdf-summarize: live PDF fetch (same as /api/pdf above) PLUS an in-process
  // call into the v1-chat gateway tier — same acceptable-cost class already
  // applied to the gateway tiers themselves (503s harmlessly without
  // OPENROUTER_API_KEY, which CI's test job doesn't set; a real call when the
  // key IS present costs at most the v1-chat tier's own margin-clamped
  // worst case, ~$0.014).
  "/api/pdf-summarize",
  // document-brief skill pack: same reasoning, one hop up (it calls
  // pdf-summarize in-process as one of its three fanout steps).
  "/api/skill/document-brief",
  "/api/media-info", "/api/audio-convert", "/api/audio-normalize",
  "/api/gov-data", "/api/weather-alerts", "/api/earthquakes",
  "/api/drug-recalls", "/api/food-recalls", "/api/drug-adverse-events", "/api/vin-decode", "/api/vehicle-recalls",
  "/api/device-recalls", "/api/college-lookup", "/api/fec-candidates",
  "/api/federal-awards", "/api/geo-lookup", "/api/fema-disasters",
  "/api/geocode", "/api/reverse-geocode", "/api/place-search",
  "/api/image-ocr",
  // Image-kit URL tools: the examples fetch a small stable sample image from
  // raw.githubusercontent.com — live egress, tolerate transient upstream flaps.
  "/api/image-exif", "/api/image-dominant-color", "/api/image-crop",
  "/api/barcode-lookup", "/api/fx-rate", "/api/weather-forecast",
  "/api/public-holidays",
  // Weather-kit: live open-meteo forecasts — same upstream class as
  // weather-forecast above (was misfiled as pure-CPU; an open-meteo outage
  // must not hard-block the deploy gate).
  "/api/weather-current", "/api/weather-daily", "/api/weather-hourly",
  "/api/weather-history", "/api/weather-air-quality",
  // B20 log scans: chunked eth_getLogs against public Base RPCs — flappy in CI.
  "/api/b20-new-tokens", "/api/b20-memos",
  // B20 eth_call tools: the SAME public-RPC egress (15s abort x 3 RPCs x 2
  // passes in b20-kit rpc()), wallet-only in pow.js, but they were never filed
  // here - one stalled public RPC tripped the 20s strict abort and blocked the
  // deploy gate (2026-08-22, run 32541121323). b20-feature-id is pure CPU and
  // stays strict.
  "/api/b20-token-info", "/api/b20-verify", "/api/b20-activation-check",
  // CDP kit: live Coinbase Developer Platform calls, env-gated on CDP keys
  // (503 without them — the CI test env has none; scripts/test-cdp-live.js
  // covers the real calls where the secrets exist).
  "/api/wallet-balances", "/api/testnet-fund", "/api/onramp-link",
  "/api/onchain-sql", "/api/onchain-sql-schema",
  "/api/x402-quote", "/api/usdc-balance", "/api/tx-status", "/api/gas-estimate", "/api/x402-verify", "/api/ens-resolve",
  // Macro-kit: all routes hit live upstreams (FRED, Treasury Fiscal Data, ECB,
  // World Bank). FRED-keyed routes return 503 without FRED_API_KEY — the
  // 502/503/504 tolerance below covers that.
  "/api/treasury-yield-curve", "/api/treasury-yield-history", "/api/yield-curve-spread",
  "/api/treasury-debt", "/api/treasury-avg-rates",
  "/api/fx-historical", "/api/fx-timeseries", "/api/fx-dashboard",
  "/api/world-bank-indicator", "/api/world-bank-search",
  "/api/fred-series", "/api/fred-search", "/api/fred-series-info", "/api/fred-release-calendar",
  "/api/sahm-rule", "/api/cpi-yoy", "/api/unemployment-rate", "/api/fed-funds",
  "/api/fred-release-observations",
  // EDGAR-kit: every route hits data.sec.gov, www.sec.gov, or efts.sec.gov.
  "/api/edgar-company-lookup", "/api/edgar-filings", "/api/edgar-company-concept",
  "/api/edgar-company-facts", "/api/edgar-xbrl-frame",
  "/api/edgar-insider-trades", "/api/edgar-13f-holdings", "/api/edgar-recent-ipos", "/api/edgar-search",
  "/api/company-financials",
  // Finance-kit: Yahoo Finance chart (quote + history) and Nasdaq earnings
  // calendar — keyless live upstreams; tolerate transient 502/503/504.
  "/api/stock-quote", "/api/stock-history", "/api/earnings-calendar",
  "/api/options-chain", "/api/premarket-quote", "/api/stock-dividends", "/api/dividend-calendar",
  // Crypto-kit: CoinGecko public API — keyless, ~30 req/min from a single IP.
  // Tolerate transient 429/502/503/504 (rate limit + Cloudflare hiccups).
  // crypto-orderbook rides Coinbase Exchange's public API (same lenient posture).
  "/api/crypto-price", "/api/crypto-market", "/api/crypto-history", "/api/crypto-trending", "/api/crypto-global",
  "/api/crypto-orderbook", "/api/stablecoin-peg",
  // Network-kit: live DNS resolution against 1.1.1.1/8.8.8.8/9.9.9.9. Public
  // resolvers can NXDOMAIN, time out, or return SERVFAIL for placeholder inputs —
  // tolerate transient failures, the shape check still gates the happy path.
  "/api/dns-lookup", "/api/dns-propagation", "/api/spf-check", "/api/dmarc-check",
  "/api/dkim-lookup", "/api/email-deliverability",
  // Network-kit2: crt.sh (CT logs), live HTTP fetch, signature scan, Team Cymru
  // DNS-whois. All hit free public infra; tolerate transient 4xx/5xx upstream.
  "/api/cert-transparency", "/api/http-headers", "/api/tech-stack", "/api/asn-info",
  // x402-audit: probes an external seller's live 402 challenge — same live-fetch
  // class as x402-quote; tolerate transient upstream reachability failures.
  "/api/x402-audit",
  // Chain-kit: Alchemy-backed reads (JSON-RPC + NFT + Prices + Data APIs).
  // Returns 503 without ALCHEMY_API_KEY (CI env may not have it); the
  // 502/503/504 tolerance below covers that. Daily paid-canary covers
  // post-deploy verification once the key is set in Railway.
  "/api/wallet-balance", "/api/token-metadata", "/api/token-price",
  "/api/wallet-transactions", "/api/nft-holdings", "/api/nft-metadata",
  "/api/gas-snapshot", "/api/eth-call",
  // evm-rpc rides keyless public RPC endpoints (no Alchemy key needed) but
  // shares per-IP rate limits — tolerate transient upstream failures.
  "/api/evm-rpc",
  // Contract-kit egress: Sourcify (contract-source / contract-abi), the
  // openchain.xyz + 4byte.directory signature DBs (selector-lookup, and
  // calldata-decode's no-ABI fallback), and the shared public RPC pool
  // (tx-simulate). solidity-scan + address-label are pure CPU and stay strict.
  "/api/contract-source", "/api/contract-abi", "/api/calldata-decode",
  "/api/selector-lookup", "/api/tx-simulate",
  // Enrich-kit: GLEIF (lei-lookup), Wikidata (wikidata-entity), gravatar.com
  // (gravatar-check), api.github.com (github-repo — 60/hr per-IP keyless quota
  // can 403→503 in CI), favicon fetch against a live site (favicon-grab).
  "/api/lei-lookup", "/api/wikidata-entity", "/api/gravatar-check",
  "/api/github-repo", "/api/favicon-grab",
  // Price-feed-kit: keyless public upstreams (Pyth Hermes, CoinGecko, DeFiLlama).
  // CoinGecko's free tier shares a per-IP ~30 rpm limit; tolerate 429/502/503/504.
  "/api/price-coingecko", "/api/defi-tvl",
  // Dex-kit: 3 Alchemy-backed (dex-pair / dex-pool / dex-quote) — 503 without
  // ALCHEMY_API_KEY, same as chain-kit. dex-top-pools hits DeFiLlama keylessly.
  "/api/dex-pair", "/api/dex-pool", "/api/dex-quote", "/api/dex-top-pools",
  // Prediction-market-kit: keyless public upstreams (Polymarket Gamma + CLOB,
  // Kalshi). Per-IP rate-limited; tolerate transient 429/502/503/504. The
  // placeholder example inputs may also return 4xx (e.g. "election" keyword
  // search returns 0 results out of cycle, or a fake tokenId yields 404).
  "/api/polymarket-search", "/api/polymarket-market", "/api/polymarket-orderbook",
  "/api/polymarket-price-history", "/api/kalshi-markets", "/api/kalshi-event",
  // MEV + L2 kit: Flashbots relay (keyless), DeFiLlama (keyless), and Alchemy
  // (503 without key). Tolerate transient upstream errors + 4xx from
  // placeholder example inputs (e.g. specific block-number lookups may miss).
  "/api/mev-recent-blocks", "/api/mev-builder-share", "/api/mev-block-payment",
  "/api/l2-tvl", "/api/l2-gas-comparison",
  // Onchain-identity-kit: keyless public APIs (ensideas, Warpcast, EAS
  // indexers). Tolerate transient upstream errors + 4xx from placeholder
  // example inputs (0x000…0 may return null/empty).
  "/api/ens-bulk-resolve", "/api/farcaster-profile", "/api/farcaster-by-address",
  "/api/eas-attestations",
  // NFT-market-kit: Alchemy NFT v3 (503 without key in CI without secrets;
  // 4xx on placeholder contracts that don't exist on a given chain).
  "/api/nft-collection", "/api/nft-floor",
  // Skill packs (bundled execution endpoints) — orchestrate up to 8 underlying
  // tool calls per request; sequential chains can exceed the 20s AbortSignal in
  // CI even when each underlying call is fast. The partial-success envelope
  // always returns 200 with {pack, args, steps, summary}, so strict mode would
  // also pass — NETWORK membership is a timeout safety hedge. All 39 packs:
  "/api/skill/security-audit", "/api/skill/email-deliverability", "/api/skill/financial-research",
  "/api/skill/macro-economics", "/api/skill/macro-dashboard", "/api/skill/dns-network-ops", "/api/skill/crypto-research",
  // fixed-income-desk joined 2026-09-01: it was an instant 0/5 (no PACK_STEPS
  // entry, every step todoError'd in microseconds) so it never needed the
  // hedge - implementing it for real gave it three sequential upstream reads
  // (fiscaldata twice + FRED), the same dependencies as macro-economics above,
  // and a slow upstream moment pushed it past the 20s cap on its first CI run.
  "/api/skill/fixed-income-desk",
  "/api/skill/content-extraction", "/api/skill/sec-filings-deep-dive", "/api/skill/structured-scrape",
  "/api/skill/decode-blob", "/api/skill/trend-analysis", "/api/skill/forecasting-bake-off",
  "/api/skill/document-intel", "/api/skill/loan-comparison", "/api/skill/investment-decision",
  "/api/skill/retirement-planning", "/api/skill/savings-goal", "/api/skill/fraud-signals",
  "/api/skill/api-investigation", "/api/skill/text-hygiene", "/api/skill/csv-profile",
  "/api/skill/location-intel", "/api/skill/meeting-scheduler", "/api/skill/jwt-forensics",
  "/api/skill/user-onboarding", "/api/skill/data-interchange", "/api/skill/rag-prep",
  "/api/skill/webhook-debug", "/api/skill/a11y-audit", "/api/skill/trip-planner",
  "/api/skill/identity-mint", "/api/skill/macro-context", "/api/skill/regulatory-watch",
  "/api/skill/search-and-cite", "/api/skill/media-pipeline", "/api/skill/schema-evolution",
  "/api/skill/link-preview", "/api/skill/any-to-markdown", "/api/skill/status-snapshot",
  "/api/skill/financial-analysis", "/api/skill/market-brief",
  "/api/skill/company-dossier", "/api/skill/domain-intel", "/api/skill/crypto-dossier",
  "/api/skill/earnings-watch", "/api/skill/insider-alert", "/api/skill/ipo-watch",
  "/api/skill/yield-dashboard", "/api/skill/inflation-check", "/api/skill/fx-monitor",
  "/api/skill/defi-dashboard", "/api/skill/nft-portfolio", "/api/skill/wallet-audit",
  "/api/skill/gas-optimizer", "/api/skill/ssl-audit", "/api/skill/email-security",
  "/api/skill/brand-protection", "/api/skill/competitor-scan", "/api/skill/page-audit",
  // Standard-tier batch 2 (2026-07): all skill packs go in NETWORK as a
  // timeout safety hedge (bundled execution can exceed the 20s AbortSignal).
  "/api/skill/article-digest", "/api/skill/pdf-pipeline", "/api/skill/url-inspector",
  "/api/skill/content-grade", "/api/skill/openapi-audit", "/api/skill/json-pipeline",
  "/api/skill/data-convert", "/api/skill/api-health", "/api/skill/world-data",
  "/api/skill/fred-snapshot", "/api/skill/contact-verify", "/api/skill/domain-age",
  "/api/skill/hash-verify", "/api/skill/encoding-suite", "/api/skill/jwt-toolkit",
  "/api/skill/timezone-planner", "/api/skill/text-analyze", "/api/skill/content-clean",
  // The 500 overhaul (2026-07): these 8 packs shipped WITHOUT NETWORK membership,
  // so a slow upstream tripping their 20s AbortSignal counted as a strict failure
  // and broke the build (feed-watch hit this). They compose network/wallet-only
  // tools (feed-parse, extract, transcribe, contract/tx reads, market feeds), so
  // they belong in the same timeout hedge as every other pack.
  "/api/skill/contract-audit", "/api/skill/tx-forensics", "/api/skill/market-open",
  "/api/skill/entity-enrich", "/api/skill/feed-watch", "/api/skill/subtitle-pipeline",
  "/api/skill/locale-brief", "/api/skill/schema-guard",
  // webhook-intake (2026-07): pure-CPU chain, but every pack rides the same
  // timeout hedge per the convention above.
  "/api/skill/webhook-intake",
  // Packs that compose WALLET_ONLY (egress) tools and were never added here, so
  // a slow upstream tripping the 20s AbortSignal counted as a strict failure —
  // price-monitor (Yahoo + CoinGecko) broke the build this way on 2026-07-24.
  // Scoped deliberately: an audit of all 109 packs found 23 absent from this
  // set, but only these 6 reach the network. The other 17 are pure-CPU chains
  // with no upstream that could ever be slow, so they stay STRICT rather than
  // losing real coverage to a hedge they cannot need.
  "/api/skill/price-monitor", "/api/skill/weather-brief", "/api/skill/seo-audit",
  "/api/skill/wallet-readiness", "/api/skill/onchain-analyst", "/api/skill/cheapest-rail",
  // LLM proxy kit: every call hits OpenAI upstream. Returns 503 without
  // OPENAI_API_KEY — the 502/503/504 tolerance below covers that.
  "/api/llm", "/api/llm-pro", "/api/llm-premium",
  // OpenAI-compatible gateway: every call hits OpenRouter upstream. Returns
  // 503 without OPENROUTER_API_KEY — same tolerance as the LLM proxy.
  "/v1/nano/chat/completions", "/v1/auto/chat/completions", "/v1/grounded/chat/completions", "/v1/ox/chat/completions", "/v1/chat/completions", "/v1/pro/chat/completions", "/v1/premium/chat/completions", "/v1/metered/chat/completions",
  // Embeddings wire path: hits OpenAI upstream. 503 without OPENAI_API_KEY —
  // same tolerance as the LLM proxy.
  "/v1/embeddings",
  "/v1/rerank",
  // research-deep composites: multi-round grounded search + rerank + synthesis
  // over the gateway; not deterministic (LLM + live web), 503 without
  // OPENROUTER_API_KEY. Same NETWORK tolerance as the gateway tiers.
  "/v1/research", "/v1/research/pro", "/v1/research/max",
  // fund-report composites: SEC 13F diff + grounded search + synthesis; 503
  // without OPENROUTER_API_KEY, same NETWORK tolerance.
  "/v1/fund", "/v1/fund/max",
  // domain-audit composites: live probes + synthesis; 503 without
  // OPENROUTER_API_KEY, same NETWORK tolerance.
  "/v1/domain-audit", "/v1/domain-audit/pro",
  // recall-report (openFDA + synthesis, 503 without OPENROUTER_API_KEY) and the
  // deterministic ipo-report (EDGAR full-text search) - live upstreams.
  "/v1/token-brief", "/v1/filing-report", "/v1/recall-report", "/v1/ipo-report", "/v1/insider-report", "/v1/research/market-brief", "/v1/linkedin-article",
  // ticker-pack: the bundle - runs the dossier + insider composites in-process
  // plus live SEC EDGAR reads; 503 without OPENROUTER_API_KEY, same tolerance.
  "/v1/ticker-pack",
  // token-risk composites: Blockscout x402 buys + synthesis; 503 without the
  // upstream-buyer wallet / OPENROUTER_API_KEY, same NETWORK tolerance.
  "/v1/token-risk", "/v1/token-risk/pro",
  // dossier-kit composites: EDGAR + grounded web search + synthesis, 503 without key.
  "/v1/dossier", "/v1/dossier/max",
  // Anthropic Messages wire (OpenRouter /messages upstream) - same tolerance.
  "/v1/nano/messages", "/v1/auto/messages", "/v1/messages", "/v1/pro/messages", "/v1/premium/messages", "/v1/metered/messages",
  "/v1/nano/responses", "/v1/auto/responses", "/v1/responses", "/v1/pro/responses", "/v1/premium/responses", "/v1/metered/responses",
  // Image generation wire path: hits OpenRouter upstream (Gemini image model).
  // 503 without OPENROUTER_API_KEY — same tolerance as the chat tiers.
  "/v1/images/generations",
  // TTS wire path: hits OpenRouter's audio API upstream (binary out).
  // 503 without OPENROUTER_API_KEY — same tolerance as the chat tiers.
  "/v1/audio/speech",
  // Image generation kit: every call hits OpenAI GPT Image API upstream.
  // Returns 503 without OPENAI_API_KEY — same tolerance as LLM proxy.
  "/api/image-gen", "/api/image-gen-hd", "/api/image-gen-premium",
  // Named chain-read primitives (chain-kit 2026-07-29): live public-RPC reads.
  "/api/block-number", "/api/chain-info", "/api/block-info", "/api/erc721-owner", "/api/contract-code", "/api/event-logs",
  // TTS kit: every call hits OpenAI TTS API upstream.
  "/api/tts", "/api/tts-hd",
  // STT kit: fetches external audio + hits OpenAI transcription API.
  "/api/transcribe", "/api/transcribe-pro",
  // Embeddings kit: every call hits OpenAI embeddings API upstream.
  "/api/embed", "/api/embed-large",
  // Moderation kit: every call hits OpenAI moderation API upstream.
  "/api/moderate",
]);
const isMemory = (p) => p.startsWith("/api/memory");
// Wallet-keyed tools (payment = identity): in free mode there is no payment,
// so their documented "pay to unlock" 4xx is the CORRECT answer, not a bug —
// same leniency class as the memory tools.
const isWalletIdentity = (p) => isMemory(p) || p === "/api/my-usage";

const spec = await (await fetch(`${TARGET}/openapi.json`)).json();
const paths = Object.entries(spec.paths);

let strictPass = 0, strictFail = 0, lenient = 0, serverErr = 0;
const failures = [];
const shapeMismatches = [];
const cats = {};

// Shape check: compare a 200 JSON response against the documented
// `responses.200.content.application/json.example` keys. Catches tools whose
// output drifted from what their description claims.
//
// Skiplist: tools whose example documents the happy path but the test invokes
// them with placeholder inputs that legitimately produce a smaller "not found"
// response shape. These are NOT bugs — the happy-path example is the
// user-facing documentation; the test just can't supply real inputs.
function checkShape(path, method, op, body) {
  const missing = missingDocumentedKeys(path, op, body);
  if (missing.length) shapeMismatches.push(`${method} ${path} → missing documented keys: ${missing.join(",")}`);
  // A key can be PRESENT and still teach an agent the tool is broken: three
  // tools published an example whose own input returned an empty array where
  // the docs promise entries (2026-08-29). See sweep-shape.js.
  const hollow = emptyPromisedArrays(path, op, body);
  if (hollow.length) shapeMismatches.push(`${method} ${path} → documented example returns an EMPTY array for: ${hollow.join(",")} (its own published input produces nothing)`);
}

// ONE HIT PER ENDPOINT ACROSS THE TWO SWEEPS. scripts/test-non-metered-examples.js
// drives every priced, non-metered route with a STRICTER grade than this file
// (502/503/504 fail there, pass here) and, since 2026-08-25, the same
// documented-keys shape check. Driving those routes again here proved nothing
// the strict sweep had not, and cost ~65 s of the lane plus a second round of
// hits on the free-public upstreams that rate-limit by IP. So when the CI lane
// runs both sweeps (TEST_ALL_SKIP_STRICT_COVERED=1) this one skips the routes
// the strict sweep will assert on this commit - reported by count, never
// silently - and keeps everything else: free routes, metered routes (skipped or
// lenient here, excluded there), workflows, and the CoinGecko tools the strict
// sweep sampled out this run. Default off, so a local `test-all` alone still
// covers the whole catalog.
let strictCovered = new Set();
if (process.env.TEST_ALL_SKIP_STRICT_COVERED === "1") {
  const { strictScopeKeys } = await import("./test-non-metered-examples.js");
  const pricing = await (await fetch(`${TARGET}/api/pricing`)).json();
  strictCovered = strictScopeKeys(spec, pricing);
  if (strictCovered.size < 300) {
    console.error(`TEST_ALL_SKIP_STRICT_COVERED is set but the strict sweep's scope is only ${strictCovered.size} routes - the hand-over is broken; sweeping everything here instead`);
    strictCovered = new Set();
  }
}

function buildGetUrl(path, op) {
  const qs = new URLSearchParams();
  for (const p of op.parameters ?? []) {
    if (p.example !== undefined) qs.set(p.name, typeof p.example === "string" ? p.example : JSON.stringify(p.example));
  }
  return `${TARGET}${path}${[...qs].length ? `?${qs}` : ""}`;
}

let braveSkipped = 0, e2bSkipped = 0, strictSkipped = 0;
const timings = [];
// The sweep used to be one serial await-fetch per endpoint. Locally that is
// ~2 minutes because almost nothing reaches the network; in CI, where the real
// API keys are present, network tools make REAL upstream calls and the same
// sweep took over 35 minutes - enough that every change today queued behind it,
// and a push during a run cancels it.
//
// The wall-clock is almost entirely I/O wait, so it parallelises well. Order of
// RESULTS is preserved (tasks are collected first and aggregated in order), so
// the report reads identically and a failure list does not shuffle between runs.
const tasks = [];
for (const [path, methods] of paths) {
  if (skipBrave && BRAVE_ROUTES.has(path)) { braveSkipped += Object.keys(methods).length; continue; }
  if (skipE2b && E2B_ROUTES.has(path)) { e2bSkipped += Object.keys(methods).length; continue; }
  for (const [method, op] of Object.entries(methods)) {
    const cat = (op.tags && op.tags[0]) || "other";
    // Discovery/composition surfaces (skill packs) live in the OpenAPI spec so
    // SDK generators know they exist, but they're not paywalled tools — they
    // take a path param (slug) the generic sweep can't substitute. The
    // dedicated skill-pack tests in test-mcp-all.js exercise the prompts.
    if (cat === "workflows") continue;
    if (strictCovered.has(`${method} ${path}`)) { strictSkipped++; continue; }
    cats[cat] = cats[cat] || { pass: 0, total: 0 };
    cats[cat].total++;

    let url, init;
    if (method === "get") {
      url = buildGetUrl(path, op);
      init = {};
    } else {
      const example = op.requestBody?.content?.["application/json"]?.example ?? {};
      url = `${TARGET}${path}`;
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(example) };
    }
    // Memory tools need an identity in free mode; give them a demo namespace.
    if (isMemory(path)) url += (url.includes("?") ? "&" : "?") + "ns=smoke-all";

    tasks.push({ path, method, op, cat, url, init });
  }
}

// Bounded pool. 8 by default: high enough to collapse the I/O wait, low enough
// to stay under our own rate limiter and to leave the 2-worker image pool's
// 32-deep queue absorbing rather than answering 503, which this sweep would
// (correctly) read as a failure.
const CONCURRENCY = Math.max(1, Number(process.env.TEST_ALL_CONCURRENCY) || 8);
async function runTask(t) {
  let status = 0, body = null, threw = null;
  const _t0 = Date.now();
  try {
    const res = await fetch(t.url, { ...t.init, signal: AbortSignal.timeout(20000) });
    status = res.status;
    const ct = res.headers.get("content-type") || "";
    body = ct.includes("application/json") ? await res.json() : (await res.arrayBuffer()).byteLength;
  } catch (e) {
    threw = e.message;
  }
  return { ...t, status, body, threw, ms: Date.now() - _t0 };
}
const results = new Array(tasks.length);
{
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await runTask(tasks[i]);
    }
  }));
}

// Aggregate IN ORDER, so the counters, the failure list and the report are
// byte-identical to the serial version.
for (const r of results) {
  {
    const { path, method, op, cat, status, body, threw } = r;
    timings.push([r.ms, `${method.toUpperCase()} ${path}`]);
    const okStrict = status === 200 && !(body && body.error);
    if (okStrict) checkShape(path, method, op, body);
    if (NETWORK.has(path)) {
      lenient++;
      // Tolerate upstream/egress failures (502/504) and browser-not-available
      // (503) — these tools need real network/Chromium, present in CI.
      if (status >= 500 && ![502, 503, 504].includes(status)) { serverErr++; failures.push(`${method} ${path} → server ${status}`); }
    } else if (isWalletIdentity(path)) {
      lenient++;
      if (threw || (status >= 500)) { serverErr++; failures.push(`${method} ${path} → ${threw || status}`); }
    } else {
      if (okStrict) { strictPass++; cats[cat].pass++; }
      else { strictFail++; failures.push(`${method} ${path} → ${threw || `HTTP ${status}`}${body && body.error ? " " + JSON.stringify(body.error).slice(0, 60) : ""}`); }
    }
  }
}

const totalOps = paths.reduce((a, [, m]) => a + Object.keys(m).length, 0);
console.log(`\nExercised ${totalOps - braveSkipped - e2bSkipped - strictSkipped} endpoints at ${TARGET}${strictSkipped ? ` (handed ${strictSkipped} route(s) to the strict non-metered sweep - TEST_ALL_SKIP_STRICT_COVERED)` : ""}${braveSkipped ? ` (skipped ${braveSkipped} Brave route(s) — set BRAVE_LIVE_TEST=1 to include; paid-canary covers post-deploy verification)` : ""}${e2bSkipped ? ` (skipped ${e2bSkipped} E2B route(s) — set E2B_LIVE_TEST=1 to include; test-code-run-kit covers live in CI)` : ""}\n`);
// Where the wall-clock actually went. Printed always: a slow sweep that only
// reports a total gives the next reader nothing to act on.
{
  const total = timings.reduce((a, t) => a + t[0], 0);
  const slow = [...timings].sort((a, b) => b[0] - a[0]).slice(0, 12);
  console.log(`\n  wall-clock in requests: ${(total / 1000).toFixed(1)}s across ${timings.length} calls (median ${timings.length ? [...timings].sort((a,b)=>a[0]-b[0])[Math.floor(timings.length/2)][0] : 0}ms)`);
  console.log("  slowest:");
  for (const [ms, name] of slow) console.log(`    ${String(ms).padStart(6)}ms  ${name}`);
}
for (const [cat, c] of Object.entries(cats).sort()) console.log(`  ${cat.padEnd(12)} ${c.pass}/${c.total} pure-CPU strict-pass`);
console.log(`\n  strict (pure-CPU): ${strictPass} passed, ${strictFail} failed`);
console.log(`  lenient (network/memory): ${lenient} exercised, ${serverErr} server errors`);
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):\n  ` + failures.slice(0, 40).join("\n  ") + (failures.length > 40 ? `\n  …and ${failures.length - 40} more` : ""));
}
console.log(`\n  shape (documented output keys present): ${shapeMismatches.length === 0 ? "all clean" : shapeMismatches.length + " mismatches"}`);
if (shapeMismatches.length) {
  console.error(`\nSHAPE MISMATCHES (${shapeMismatches.length}):\n  ` + shapeMismatches.slice(0, 60).join("\n  ") + (shapeMismatches.length > 60 ? `\n  …and ${shapeMismatches.length - 60} more` : ""));
}
// Fail the run on: pure-CPU strict failure, a real server crash (5xx that
// isn't an upstream 502/504), or any shape mismatch (the documented output
// example no longer matches the live response).
process.exit(strictFail === 0 && serverErr === 0 && shapeMismatches.length === 0 ? 0 : 1);
