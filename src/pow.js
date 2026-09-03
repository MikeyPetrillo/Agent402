// Proof-of-work: a no-wallet alternative to USDC payment for the cheap,
// CPU-only tools. An agent that cannot pay proves it spent real CPU instead.
//
// Flow (mirrors the x402 challenge/response shape):
//   1. GET /api/pow/challenge?slug=hash  -> a signed, single-use challenge.
//   2. Agent finds a nonce so sha256("<challenge>:<nonce>") has >= difficulty
//      leading zero bits.
//   3. Agent re-sends the tool request with header
//      X-Pow-Solution: <token>:<nonce>
//   4. This module verifies (one hash + one HMAC + a single-use check) and the
//      request is served free of charge.
//
// Challenges are stateless: the token is HMAC-signed by the server, so no state
// is stored when a challenge is issued. Only a *solved* challenge writes a row
// (for replay protection), so an attacker must burn CPU before costing us any
// storage. Tunable difficulty makes spam uneconomic while staying trivial for a
// one-off legitimate call.
import Database from "better-sqlite3";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Replay-protection lives in /data (persistent volume) so used PoW tokens
// stay used across restarts. Falling back to /tmp on prod is unsafe: a
// redeploy resets the table and tokens within their TTL (default 300s) can
// be replayed against the fresh instance. We require /data when NODE_ENV
// looks production-ish and FREE_MODE/POW_ALLOW_EPHEMERAL haven't explicitly
// opted into the ephemeral path (local tests, edge functions, etc.).
const HAS_DATA_DIR = existsSync("/data");
const ALLOW_EPHEMERAL =
  process.env.POW_ALLOW_EPHEMERAL === "true" ||
  process.env.FREE_MODE === "true" ||
  process.env.NODE_ENV !== "production";
if (!HAS_DATA_DIR && !ALLOW_EPHEMERAL) {
  console.error(
    "PoW replay store has no persistent volume (/data missing) and NODE_ENV=production. Mount /data, or set POW_ALLOW_EPHEMERAL=true to accept replay risk on restart."
  );
  process.exit(1);
}
const DATA_DIR = HAS_DATA_DIR ? "/data" : "/tmp";
const db = new Database(join(DATA_DIR, "agent402-pow.db"));
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS pow_used (challenge TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
db.exec("CREATE INDEX IF NOT EXISTS pow_used_exp ON pow_used (exp)");
const markStmt = db.prepare("INSERT INTO pow_used (challenge, exp) VALUES (?, ?)");
const pruneStmt = db.prepare("DELETE FROM pow_used WHERE exp < ?");

// Tools that cost real money or reach the network are NOT compute-payable —
// they stay wallet-only so PoW can't be used to farm Chromium/egress/storage.
export const WALLET_ONLY_SLUGS = new Set([
  "token-brief", "filing-report",  // token-brief-kit.js: keyless Solana egress + Opus synthesis, metered
  "linkedin-article",              // linkedin-article-kit.js: research + Opus + image generation, metered
  "v1-images-fast", "v1-images-pro", "v1-videos",  // llm-images-fast-kit.js (OpenRouter spend)
  "asset-transfers", "token-balances", "token-allowance", "tx-receipt", "block-receipts", "token-price-history",  // alchemy-data-kit.js (egress)
  "fc-cast-search", "fc-channel-feed", "fc-trending", "fc-user-casts", "fc-cast", "fc-cast-replies", "fc-channel", "fc-user-search", "fc-cast-metrics",  // farcaster-social-kit.js (egress)
  "coin-price-by-contract", "coin-profile", "coin-history", "coin-ohlc", "coin-market-chart-range", "coin-categories", "global-defi", "exchanges", "exchange-tickers", "exchange-rates", "coin-search", "coins-list",
  "rwa-list", "rwa-markets", "rwa-asset", "rwa-issuers", "rwa-issuer",  // crypto-markets-kit.js (egress)
  "defi-yields", "defi-yield-history", "defi-protocols", "defi-protocol", "defi-chains", "defi-chain-tvl-history", "stablecoins", "stablecoin-supply-history", "defi-fees", "defi-dex-volume",  // defi-kit.js (egress)
  "crypto-news", "crypto-indicators", "crypto-market-pulse",  // crypto-signals-kit.js (egress)
  "site-map", "site-crawl",  // crawl-kit.js (egress)
  // derivatives-kit (Hyperliquid/Deribit/DefiLlama egress), x-data-kit (X API), b2b-enrich-kit (Hunter/Apollo) - 2026-08-22
  "perp-markets", "perp-funding", "perp-funding-screener", "perp-open-interest", "perp-klines", "perp-orderbook", "perp-basis",
  "options-summary", "crypto-options-chain", "options-ticker", "options-volume",
  "sol-token-safety", "sol-token-report", "sol-token-holders", "sol-token-pairs", "sol-token-search", "sol-trending", "sol-price", "sol-swap-quote", "sol-token-lookup",
  "x-search-recent", "x-user", "x-user-tweets", "x-tweet", "x-users-lookup",
  "hunter-domain-search", "hunter-email-finder", "hunter-email-verify", "hunter-company", "apollo-people-search", "apollo-org-enrich", "apollo-person-match",
  "extract", "meta", "dns", "render", "screenshot", "pdf", "multi-search",
  "memory-write", "memory-read", "memory-incr", "memory-cas", "memory-grant", "memory-revoke",
  "memory-grants", "memory-log", "memory-remember", "memory-recall", "memory-forget",
  "http-check", "tls-cert", "whois", "robots-check", "sitemap",
  "email-validate", "ip-info", "search", "search-news", "search-images", "search-videos", "search-suggest", "answer",
  "llm-context",  // llm-context-kit.js - spends the Brave subscription per call (never PoW-eligible)
  "pdf-info", "pdf-merge", "pdf-extract-pages", "pdf-rotate", "images-to-pdf",
  "pdf-to-markdown",
  "media-info", "audio-convert", "audio-normalize",
  "gov-data", "weather-alerts", "earthquakes",
  "drug-recalls", "food-recalls", "drug-adverse-events", "vin-decode", "vehicle-recalls",
  "device-recalls", "college-lookup", "fec-candidates",
  "federal-awards", "geo-lookup", "fema-disasters",
  "barcode-lookup", "fx-rate", "weather-forecast",
  // Locale/time reference (data-kit): Nager.Date egress → wallet-only.
  // (country-info is a committed in-repo dataset now — pure CPU, PoW-eligible.)
  "public-holidays",
  // Image tools that can fetch a caller-supplied URL (safeFetch egress).
  "image-exif", "image-dominant-color", "image-crop",
  "treasury-yield-curve", "treasury-yield-history", "yield-curve-spread",
  "treasury-debt", "treasury-avg-rates",
  "fx-historical", "fx-timeseries", "fx-dashboard",
  "world-bank-indicator", "world-bank-search",
  "fred-series", "fred-search", "fred-series-info", "fred-release-calendar",
  "sahm-rule", "cpi-yoy", "unemployment-rate", "fed-funds",
  "fred-release-observations",
  "edgar-company-lookup", "edgar-filings", "edgar-company-concept", "edgar-company-facts", "edgar-xbrl-frame",
  "edgar-insider-trades", "edgar-13f-holdings", "edgar-recent-ipos", "edgar-search",
  "company-financials",
  "stock-quote", "stock-history", "earnings-calendar",
  "options-chain", "premarket-quote", "stock-dividends", "dividend-calendar",
  "crypto-price", "crypto-market", "crypto-history", "crypto-trending", "crypto-global",
  "crypto-orderbook", "stablecoin-peg",
  // Composite research tools fan out to multiple paid upstreams; PoW would
  // turn 1 free request into 5+ paid roundtrips. Wallet-only.
  "research-company",
  // Network-kit: every tool hits an external resolver (DNS via 1.1.1.1/8.8.8.8/
  // 9.9.9.9) or a paid upstream (crt.sh, target site, Team Cymru). PoW would
  // let one client farm our egress; keep them wallet-only.
  "a2a-card-fetch",
  // Blockscout kit: every call BUYS upstream data over x402 with the server's
  // spending wallet — PoW would let one client drain the upstream buyer.
  "contract-inspect", "address-profile", "token-info", "token-holders", "tx-inspect",
  // sql-guard MINTS an Ed25519 execution certificate with SQL_CERT_SIGNING_KEY.
  // Left PoW-eligible it was a free, unlimited signing oracle for our own
  // certifying identity: anyone could obtain unbounded signed certificates for
  // nothing, and the certificate - not the verdict - is the thing a database
  // layer trusts to let a write through. Signing is also exactly what an
  // attacker wants volume of, so metering it with money rather than CPU is the
  // point. sql-cert-verify stays PoW-eligible on purpose: it verifies with the
  // PUBLIC key, mints nothing, and the gate protecting someone's database
  // should never be the step that fails for want of a wallet.
  "sql-guard",
  // action-gate has zero real upstream cost (pure deterministic checks, no
  // network I/O) but is wallet-only for the same reasoning as sql-guard just
  // above: the VERDICT, not any signed artifact, is the thing a caller
  // relies on to decide whether to proceed with a real action. Metered with
  // money so it can't be farmed at unlimited volume over PoW.
  "action-gate",
  // captcha-verify relays a secret to a provider (egress); captcha-generate
  // is pure-CPU and stays PoW-eligible (NOT listed here).
  "captcha-verify",
  "dns-lookup", "dns-propagation", "spf-check", "dmarc-check", "dkim-lookup", "email-deliverability",
  "cert-transparency", "http-headers", "tech-stack", "asn-info",
  // x402 payments toolkit — kept off the free connector (paid surface only).
  "x402-quote", "usdc-balance", "tx-status", "gas-estimate", "x402-verify", "transfer-authorization", "ens-resolve", "x402-audit",
  "route-execute-max", // external tier can spend upstream — wallet-only
  "route-execute-plus", // same reasoning: proportional middle tier, spends upstream
  // route-execute-pro (underlyingMaxUsd $3.00, the highest tier) was added
  // 2026-08-07 and missed this list entirely - live PoW-eligible for days.
  // Free tier has NO per-caller spend cap: external-spend-guard.js's
  // maySpend() explicitly returns ok:true, uncapped, whenever the payer is
  // unattributable (exactly every free/PoW call, since there is no signed
  // EIP-3009 authorization to attribute to). A caller could solve a cheap PoW
  // puzzle, call this for free, and direct up to $3.00 of OUR upstream
  // spending wallet to a seller of their choosing - including one they
  // control - repeated with no cumulative limit. Found 2026-08-11 auditing
  // the free tier; fixed the same day found.
  "route-execute-pro",
  // x402-trending is the PAID ecosystem-analysis layer (momentum + organic-buyer
  // grade + week-over-week growth); the raw seller ranking stays free at
  // /api/leaderboard. Pay-only so the differentiated analysis is monetized.
  "x402-trending",
  // demand-radar is the same play over the agent-demand board: the raw wish
  // clusters stay free at /api/wishes, the ranked/classified seller
  // intelligence (signalType, nearThreshold, noise flags) is pay-only.
  "demand-radar",
  // bestsellers is the same play over our own sales ledger: aggregate totals
  // stay free at /api/sales, and everything per-tool (the ranking itself, trend
  // vs previous window, organic-buyer grade, revenue share) is pay-only.
  "bestsellers",
  // B20 kit — RPC egress against Base (b20-feature-id is pure CPU and stays PoW-eligible).
  "b20-activation-check", "b20-token-info", "b20-verify", "b20-new-tokens", "b20-memos",
  // Chain-kit: tools talk to Alchemy (compute-unit quota) or, for evm-rpc,
  // shared-per-IP public RPC endpoints. PoW would let one client farm our
  // paid upstream / exhaust the shared quota.
  "wallet-balance", "token-metadata", "token-price", "wallet-transactions",
  "nft-holdings", "nft-metadata", "gas-snapshot", "eth-call", "evm-rpc",
  // Named chain-read primitives (2026-07-29): same shared public-RPC pool +
  // Alchemy lane as evm-rpc — PoW would let one client farm the quota.
  "block-number", "chain-info", "block-info", "erc721-owner", "contract-code", "event-logs",
  // Contract-kit: Sourcify (contract-source / contract-abi), openchain.xyz +
  // 4byte.directory signature DBs (selector-lookup, and calldata-decode's
  // no-ABI fallback path), and the shared keyless public RPC pool
  // (tx-simulate — same per-IP quota as evm-rpc). solidity-scan and
  // address-label are pure CPU and stay PoW-eligible.
  "contract-source", "contract-abi", "calldata-decode", "selector-lookup", "tx-simulate",
  // Enrich-kit: GLEIF (lei-lookup), Wikidata (wikidata-entity), gravatar.com
  // (gravatar-check — the hash is CPU but the probe is egress), api.github.com
  // (github-repo — shared 60/hr per-IP keyless quota PoW must not farm), and
  // arbitrary caller sites (favicon-grab). All egress → wallet-only.
  "lei-lookup", "wikidata-entity", "gravatar-check", "github-repo", "favicon-grab",
  // Web-content kit: archive.org availability API (archive-snapshot), arbitrary
  // caller feed URLs (feed-parse), and redirect-chain following against
  // arbitrary caller URLs (unshorten-url). All egress → wallet-only.
  // (search-videos rides with the other Brave routes above.)
  "archive-snapshot", "feed-parse", "unshorten-url",
  // Price-feed-kit: keyless public upstreams (Pyth Hermes, CoinGecko, DeFiLlama)
  // but the rate limits are shared per-IP. PoW would let one client exhaust the
  // shared quota for every other caller.
  "price-coingecko", "defi-tvl",
  // Dex-kit: 3 Alchemy-backed (dex-pair, dex-pool, dex-quote share the same
  // compute-unit quota as chain-kit) and 1 DeFiLlama-backed (dex-top-pools
  // shares the per-IP quota with defi-tvl). All wallet-only for the same
  // reasons as their underlying upstreams.
  "dex-pair", "dex-pool", "dex-quote", "dex-top-pools",
  // Prediction-market-kit: Polymarket Gamma + CLOB + Kalshi. All keyless but
  // all hit external HTTP; PoW would let one client farm the per-IP rate
  // limits we share with everyone else.
  "polymarket-search", "polymarket-market", "polymarket-orderbook", "polymarket-price-history",
  "kalshi-markets", "kalshi-event",
  // MEV + L2 kit: Flashbots relay (keyless, per-IP rate-limited), DeFiLlama
  // (per-IP shared with defi-tvl), and Alchemy (compute-unit quota shared with
  // chain-kit/dex-kit). All wallet-only for the same reasons.
  "mev-recent-blocks", "mev-builder-share", "mev-block-payment",
  "l2-tvl", "l2-gas-comparison",
  // Onchain-identity-kit: ensideas (keyless), Neynar API (NEYNAR_API_KEY),
  // EAS GraphQL indexers (keyless). All external HTTP; wallet-only for the
  // same reasons as the other crypto kits.
  "ens-bulk-resolve", "farcaster-profile", "farcaster-by-address",
  "eas-attestations",
  // NFT-market-kit: Alchemy NFT API v3 (shares ALCHEMY_API_KEY + compute-unit
  // pool with chain-kit / dex-kit / mev-and-l2-kit). 3 net-new market-side
  // tools that complement chain-kit's existing nft-holdings + nft-metadata.
  "nft-collection", "nft-floor",
  // Weather-kit: all 5 tools fetch from Open-Meteo (keyless, per-IP rate limit).
  "weather-current", "weather-daily", "weather-hourly", "weather-history", "weather-air-quality",
  // Geo-kit: all 3 tools fetch from Nominatim (shared per-IP rate limit).
  "geocode", "reverse-geocode", "place-search",
  // OCR-kit: image-ocr conditionally fetches external URLs (url param).
  "image-ocr",
  // Skill packs (bundled execution endpoints) — premium + standard tiers
  // orchestrate paid-upstream tools (EDGAR / FRED / Alchemy / Brave /
  // Yahoo / CoinGecko / DefiLlama / DNS resolvers / Chromium). PoW would
  // turn one free request into N paid sub-calls. Light-tier packs that
  // call at least one wallet-only tool must also be listed here — the
  // skill runner calls handlers in-process, bypassing the route paywall.
  "skill-earnings-deep-dive", "skill-options-analytics", "skill-fixed-income-desk", "skill-defi-protocol-scanner",
  "skill-market-brief", "skill-financial-analysis",
  "skill-financial-research", "skill-sec-filings-deep-dive", "skill-macro-context",
  "skill-crypto-research", "skill-regulatory-watch", "skill-search-and-cite",
  "skill-macro-economics", "skill-macro-dashboard",
  "skill-content-extraction", "skill-media-pipeline", "skill-document-intel",
  "skill-trend-analysis", "skill-any-to-markdown", "skill-structured-scrape",
  // openapi-audit was pure-CPU and PoW-eligible only because it never actually
  // fetched anything: every step handed the caller's URL to a tool that wanted
  // the document, so the pack was inert. Fixing it gave the pack a real
  // caller-supplied fetch (safeFetch, SSRF-guarded, 5MB), and a free tier that
  // fetches arbitrary URLs on demand is what this list exists to prevent. Our
  // own free-tier egress probe caught this on the first CI run after the fix.
  "skill-openapi-audit",
  "skill-forecasting-bake-off", "skill-fraud-signals", "skill-security-audit",
  "skill-link-preview", "skill-api-investigation", "skill-email-deliverability",
  "skill-location-intel", "skill-dns-network-ops", "skill-status-snapshot",
  "skill-schema-evolution",
  // Premium dossier packs (2026-07): multi-tool chains hitting paid upstreams
  // (EDGAR, Brave Search, Yahoo, CoinGecko, DNS resolvers).
  "skill-company-dossier", "skill-domain-intel", "skill-crypto-dossier",
  // Strategy additions (2026-07): every underlying tool hits the network
  // (CDP-indexed balances/SQL, live gas RPCs, page fetches) — wallet-only.
  "skill-wallet-readiness", "skill-onchain-analyst", "skill-seo-audit",
  "skill-cheapest-rail",
  // Premium skill packs (2026-07): all fan out to paid-upstream tools.
  "skill-earnings-watch", "skill-insider-alert", "skill-ipo-watch",
  "skill-yield-dashboard", "skill-inflation-check", "skill-fx-monitor",
  "skill-defi-dashboard", "skill-nft-portfolio", "skill-wallet-audit",
  "skill-gas-optimizer", "skill-ssl-audit", "skill-email-security",
  "skill-brand-protection", "skill-competitor-scan", "skill-page-audit",
  // Light-tier packs that call wallet-only tools in-process:
  "skill-trip-planner",       // calls weather-forecast (wallet-only)
  "skill-user-onboarding",   // calls email-validate (wallet-only)
  "skill-weather-brief",     // calls weather-current/daily/air-quality (all wallet-only)
  "skill-price-monitor",     // calls stock-quote/history + crypto-price/history (all wallet-only — the exact tools buyers pay for)
  // Standard-tier batch 2 packs that call wallet-only tools in-process:
  "skill-article-digest",    // calls search + answer (both wallet-only)
  "skill-pdf-pipeline",      // calls pdf-info + pdf-to-markdown + pdf-extract-pages (all wallet-only)
  "skill-url-inspector",     // calls http-check + meta (wallet-only)
  "skill-content-grade",     // calls extract (wallet-only)
  "skill-api-health",        // calls http-check + http-headers + tls-cert (all wallet-only)
  "skill-world-data",        // calls world-bank-indicator (wallet-only)
  "skill-fred-snapshot",     // calls fred-series (wallet-only)
  "skill-contact-verify",    // calls email-validate + dns-lookup (both wallet-only)
  "skill-domain-age",        // calls whois + dns-lookup + tls-cert (all wallet-only)
  // "The 500" phase-2 packs (2026-07) that call wallet-only tools in-process
  // (skill-schema-guard is pure CPU and stays PoW-eligible):
  "skill-contract-audit",    // calls contract-source + selector-lookup + tx-simulate (all wallet-only)
  "skill-tx-forensics",      // calls tx-status + evm-rpc + calldata-decode + selector-lookup (all wallet-only)
  "skill-market-open",       // calls stock-quote + premarket-quote + options-chain + stock-dividends + earnings-calendar (all wallet-only)
  "skill-entity-enrich",     // calls wikidata-entity + lei-lookup + edgar-company-lookup + whois + tech-stack + favicon-grab (all wallet-only)
  "skill-feed-watch",        // calls feed-parse + extract (both wallet-only)
  "skill-subtitle-pipeline", // calls transcribe (wallet-only — OpenAI upstream credit)
  "skill-locale-brief",      // calls public-holidays (wallet-only — Nager.Date egress)
  "skill-document-brief",    // calls pdf-summarize (wallet-only — real upstream LLM cost)
  // LLM proxy kit: every call burns real upstream inference credit (OpenAI).
  // PoW would let one client farm our API keys for free.
  "llm", "llm-pro", "llm-premium",
  // OpenAI-compatible gateway (OpenRouter upstream) — same reasoning.
  "v1-chat-nano", "v1-chat-auto", "v1-chat-grounded", "v1-chat-ox", "v1-chat", "v1-chat-pro", "v1-chat-premium", "v1-chat-metered", "v1-embeddings", "v1-rerank", "v1-images", "v1-audio-speech",
  "v1-chat-nano-messages", "v1-chat-auto-messages", "v1-chat-messages", "v1-chat-pro-messages", "v1-chat-premium-messages", "v1-chat-metered-messages",
  "v1-chat-nano-responses", "v1-chat-auto-responses", "v1-chat-responses", "v1-chat-pro-responses", "v1-chat-premium-responses", "v1-chat-metered-responses",
  // research-deep composites (src/tools/research-deep-kit.js) — each fans out
  // to multiple metered gateway calls (grounded search + rerank + synthesis),
  // so they cost real upstream money and are never free-tier/PoW-eligible.
  "research", "research-pro", "research-max",
  // fund-report composites (src/tools/fund-report-kit.js) — SEC 13F diff +
  // grounded search + Opus synthesis; metered upstream, never PoW-eligible.
  "fund-report", "fund-report-max",
  // recall-report (src/tools/recall-report-kit.js): free openFDA probes + Opus synthesis;
  // ipo-report (src/tools/ipo-report-kit.js): EDGAR egress, deterministic.
  "recall-report", "ipo-report",
  // insider-report (EDGAR Form 4 XML + Opus synthesis); market-brief (research pipeline).
  "insider-report", "market-brief",
  // ticker-pack (src/tools/ticker-pack-kit.js): runs the dossier + insider
  // composites in-process and reads SEC EDGAR - metered upstream, never PoW.
  "ticker-pack",
  // domain-audit composites (src/tools/domain-audit-kit.js) — live network
  // probes (egress) + Opus synthesis; egressing + metered, never PoW-eligible.
  "domain-audit", "domain-audit-pro",
  // token-risk composites (src/tools/token-risk-kit.js) — buy Blockscout token/
  // holder data over x402 (upstream spend) + Opus synthesis; never PoW-eligible.
  "token-risk", "token-risk-pro",
  // dossier-kit: company due-diligence dossier, fans out to EDGAR + grounded
  // web search + Opus synthesis - metered upstream, never free-tier/PoW.
  "dossier", "dossier-max",
  // Route-and-execute can dispatch to any paid/egress tool — never PoW-free.
  "route-execute",
  // Usage report: payment IS the identity (payerFromRequest) — a PoW call has
  // no wallet, so there is nothing it could ever report on.
  "my-usage",
  // Image generation kit: every call burns real upstream inference credit
  // (OpenAI GPT Image API). Same rationale as LLM proxy.
  "image-gen", "image-gen-hd", "image-gen-premium",
  // PDF summarize: calls the v1-chat gateway tier in-process to summarize
  // extracted text - real upstream inference credit burned per call, same
  // rationale as the LLM proxy kit above. Added at build time specifically
  // so this can never repeat the route-execute-pro gap (a paid tier that
  // shipped without this line and was free-tier-reachable for days).
  "pdf-summarize",
  // Code execution kit: every call spins up an E2B sandbox (compute cost).
  // PoW would let one client farm our E2B quota for free.
  "code-run", "code-run-pro",
  // TTS kit: every call burns OpenAI TTS credit.
  "tts", "tts-hd",
  // STT kit: fetches external audio + burns OpenAI transcription credit.
  "transcribe", "transcribe-pro",
  // Embeddings kit: every call burns OpenAI embedding credit.
  "embed", "embed-large",
  // Moderation kit: OpenAI moderation API (free upstream, but wallet-only by policy).
  "moderate",
  // CDP kit: every call hits the Coinbase Developer Platform on our API keys.
  // testnet-fund additionally spends a shared per-account faucet budget —
  // PoW would let one client drain it for free. onchain-sql burns real SQL
  // engine quota (100GB reads / 30s per query).
  "wallet-balances", "testnet-fund", "onramp-link", "onchain-sql", "onchain-sql-schema",
]);

/** A tool is compute-payable (PoW-eligible) if it is pure-CPU and ~free to serve. */
export function isComputePayable(tool) {
  return !WALLET_ONLY_SLUGS.has(tool.slug);
}

function clampInt(value, dflt, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

// Stable across restarts when POW_SECRET is set; otherwise a random per-process
// secret (outstanding challenges simply expire on restart). Intentionally does
// NOT fall back to CDP_API_KEY_SECRET: that secret authenticates on-chain
// settlement, and reusing it as the PoW HMAC key would cross one credential
// across two trust domains. Set a dedicated POW_SECRET in production for a
// durable PoW token signer.
const SECRET = process.env.POW_SECRET || randomBytes(32).toString("hex");
// 16 bits ≈ 65k hashes ≈ ~0.1-0.3s of client CPU: enough to make bulk abuse of
// the (near-free-to-serve) CPU tools uneconomic, while keeping a one-off call
// snappy. Higher difficulties have brutal tail latency (difficulty 20 p90 ≈ 12s)
// because solving is a memoryless random search. Tune via POW_DIFFICULTY.
export const POW_DIFFICULTY = clampInt(process.env.POW_DIFFICULTY, 16, 8, 28);
const TTL_SECONDS = clampInt(process.env.POW_TTL_SECONDS, 300, 30, 3600);

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24; // clz32 of an 8-bit value is 24..31
    break;
  }
  return bits;
}

/**
 * Issue a signed, single-use challenge. `slug` strictly scopes the token to
 * one tool so a challenge can't be retargeted at a different route.
 */
export function issueChallenge(slug) {
  const challenge = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${challenge}.${exp}.${POW_DIFFICULTY}.${slug}`;
  const token = `${payload}.${sign(payload)}`;
  // Opportunistically prune expired replay rows (cheap, indexed by exp).
  pruneStmt.run(Math.floor(Date.now() / 1000));
  return {
    algorithm: "sha256",
    challenge,
    difficulty: POW_DIFFICULTY,
    slug,
    rule: `Find an integer nonce such that sha256("${challenge}:" + nonce) has at least ${POW_DIFFICULTY} leading zero bits.`,
    expiresAt: exp,
    ttlSeconds: TTL_SECONDS,
    submitHeader: "X-Pow-Solution",
    submitFormat: "<token>:<nonce>",
    // You HASH one field and SEND a different one. Everything above describes
    // the work; without this line the two strings are easy to conflate, and
    // doing so yields a 402 indistinguishable from not having paid at all.
    // Spelled out here because this response is the only thing a wallet-less
    // agent reads before its first successful call.
    submitNote:
      "Hash the `challenge` field; submit the `token` field. They are different values: " +
      "`challenge` is the 32-hex puzzle input, `token` is the signed credential the server accepts. " +
      `Send header ${"X-Pow-Solution"}: <the token field>:<your nonce>`,
    token,
  };
}

/**
 * Verify a submitted "<token>:<nonce>" against the route's slug. Returns
 * { ok: true } on success (and consumes the challenge), or { ok:false, reason }.
 */
export function verifySolution(headerValue, slug) {
  if (typeof headerValue !== "string" || !headerValue) return { ok: false, reason: "missing solution" };
  const sep = headerValue.lastIndexOf(":");
  if (sep < 0) return { ok: false, reason: "malformed solution (expected <token>:<nonce>)" };
  const token = headerValue.slice(0, sep);
  const nonce = headerValue.slice(sep + 1);
  if (!nonce) return { ok: false, reason: "missing nonce" };

  const parts = token.split(".");
  if (parts.length !== 5) {
    // THE FREE TIER'S ONE SHARP EDGE, named instead of shrugged at.
    //
    // The challenge response carries two different strings: `challenge` (the
    // 32-hex value you HASH) and `token` (the signed value you SEND). An agent
    // that hashes `challenge` and then submits `challenge` has done the work
    // correctly and gets a 402 that is byte-identical to "you did not pay" —
    // a silent failure on the exact path meant to turn a wallet-less agent
    // into a user. "malformed token" did not hint at which of the two it
    // wanted. This costs one regex and converts a dead end into an instruction.
    const looksLikeChallenge = /^[0-9a-f]{32}$/i.test(token);
    return {
      ok: false,
      reason: looksLikeChallenge
        ? "sent the 'challenge' field; send the 'token' field instead - hash `challenge`, submit `token` (they are two different values in the challenge response)"
        : "malformed token - submit the `token` field from the challenge response verbatim, as `<token>:<nonce>`",
    };
  }
  const [challenge, expStr, diffStr, tokSlug, sig] = parts;
  const payload = `${challenge}.${expStr}.${diffStr}.${tokSlug}`;

  // 1. Signature (constant-time).
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };

  // 2. Expiry.
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "challenge expired" };

  // 3. Scope: token must be for exactly this tool (wildcards are not issued
  //    and not accepted — legacy "*" tokens fail here by design).
  if (tokSlug !== slug) return { ok: false, reason: `challenge scoped to "${tokSlug}", not "${slug}"` };

  // 4. Proof of work (difficulty is fixed in the signed token — cannot be downgraded).
  const difficulty = parseInt(diffStr, 10);
  const digest = createHash("sha256").update(`${challenge}:${nonce}`).digest();
  if (leadingZeroBits(digest) < difficulty) return { ok: false, reason: "insufficient work" };

  // 5. Single-use: the first valid submission wins; a replay hits the PK constraint.
  try {
    markStmt.run(challenge, exp);
  } catch {
    return { ok: false, reason: "challenge already used" };
  }
  // Prune here too, so a solve-heavy/issue-light workload can't grow the table.
  pruneStmt.run(Math.floor(Date.now() / 1000));
  return { ok: true };
}

// --- Heartbeat token --------------------------------------------------------
// Internal-probe attribution. The /__operator dashboard breaks served traffic
// into three rails (USDC / PoW / Heartbeat) so the maintainer can see *real*
// external demand at a glance. We used to identify the probe by a plain
// User-Agent string ("agent402-heartbeat/1.0"), but anyone could spoof that to
// poison the heartbeat counter and hide their own traffic in our internal rail.
//
// Fix: the probe HMACs the current UTC minute with the same POW_SECRET, so a
// caller has to know the secret to mint a valid token. A ±5 minute skew window
// covers clock drift between the scheduler runner and prod, and timingSafeEqual
// avoids signature timing leaks.
const HEARTBEAT_WINDOW_MS = 60_000;
const HEARTBEAT_SKEW_WINDOWS = 5;

function heartbeatTokenForMinute(minute) {
  return createHmac("sha256", SECRET).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
}

/** Mint a token for the current minute — used by the heartbeat workflow probe. */
export function issueHeartbeatToken(nowMs = Date.now()) {
  return heartbeatTokenForMinute(Math.floor(nowMs / HEARTBEAT_WINDOW_MS));
}

/** Verify a header value against the rolling ±skew window. */
export function verifyHeartbeatToken(headerValue, nowMs = Date.now()) {
  if (typeof headerValue !== "string" || !headerValue) return false;
  const given = Buffer.from(headerValue);
  const minute = Math.floor(nowMs / HEARTBEAT_WINDOW_MS);
  for (let offset = -HEARTBEAT_SKEW_WINDOWS; offset <= HEARTBEAT_SKEW_WINDOWS; offset++) {
    const expected = Buffer.from(heartbeatTokenForMinute(minute + offset));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** Machine-readable description of the PoW option for discovery surfaces. */
export function powInfo(baseUrl, computeSlugs) {
  return {
    type: "proof-of-work",
    summary:
      "Agents without a wallet can access the pure-CPU tools by solving a sha256 puzzle (a fraction of a second of the caller's CPU) instead of paying USDC. No money, no AI tokens, no model involved. Request a challenge, solve it, and resend with the X-Pow-Solution header.",
    challengeUrl: `${baseUrl}/api/pow/challenge`,
    difficultyBits: POW_DIFFICULTY,
    ttlSeconds: TTL_SECONDS,
    submitHeader: "X-Pow-Solution",
    submitFormat: "<token>:<nonce>",
    eligibleTools: computeSlugs,
    note: "Network/browser/storage tools (render, screenshot, pdf, memory, http-check, etc.) remain wallet-only via x402.",
    solverExample:
      'const c = await (await fetch(BASE+"/api/pow/challenge?slug=hash")).json();\n' +
      'const { createHash } = await import("node:crypto");\n' +
      "let n = 0, lz = (b)=>{let t=0;for(const x of b){if(!x){t+=8;continue;}t+=Math.clz32(x)-24;break;}return t;};\n" +
      'while (lz(createHash("sha256").update(c.challenge+":"+n).digest()) < c.difficulty) n++;\n' +
      'const res = await fetch(BASE+"/api/hash",{method:"POST",headers:{"Content-Type":"application/json","X-Pow-Solution":c.token+":"+n},body:JSON.stringify({text:"hello"})});',
  };
}
