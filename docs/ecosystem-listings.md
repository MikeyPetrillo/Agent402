# Ecosystem listing copy

## Current product summary (paste-ready, keep evergreen)

Use this block (or any subset) wherever a directory asks what Agent402 is. Every
claim below is served live; verify prices against `/api/pricing` before pasting.

- **What it is:** the applied layer of Agentic Finance (AIFI): tools, a model
  gateway and finished reports an agent pays for per request over x402 or MPP.
- **Catalog:** 500+ pay-per-call tools and multi-tool skill packs for AI agents:
  live web search and cited answers, headless browser, PDFs, OCR,
  financial / SEC EDGAR / macro / on-chain data, an OpenAI-compatible LLM gateway
  (`/v1`), durable wallet-keyed memory, 150+ pure-CPU utilities.
- **Decide (`POST /api/decide`, MCP `decide.plan`):** describe a job in plain
  language and get a call-ready plan over this catalog and outside x402 sellers
  with a recently verified 402: tools in order, fallbacks, params that validate,
  chained steps. One ranking formula for every seller, ours included. Run it
  yourself, or through `/api/decide/execute` with the decision fee back as credit.
- **Market and onchain intel (keyless, deterministic, per call):** live perpetuals
  (`perp-markets`, `perp-funding`, `perp-funding-screener`, `perp-basis`,
  `perp-open-interest`, `perp-klines`, `perp-orderbook`, $0.001 to $0.003) and the
  options book (`options-summary`, `crypto-options-chain`, `options-ticker`,
  `options-volume`, $0.002 to $0.005); DeFi yields, TVL, fees, DEX volume and
  stablecoin supply with history siblings (`defi-*`, `stablecoins`, $0.001 to
  $0.003); Solana token due diligence (`sol-token-safety` $0.005,
  `sol-token-report` $0.010, holders, pairs, trending, prices, swap quotes);
  crypto news, computed technical indicators and a whole-market pulse
  ($0.002 to $0.004); broad coin/exchange coverage including price by token
  contract address; indexed EVM chain reads (transfers, balances, allowances,
  decoded receipts, block receipts, token price history); Farcaster social
  (search, feeds, threads, engagement metrics); and whole-site crawling
  (`site-map` $0.005, `site-crawl` $0.02).
- **Images and video, flat per call:** `POST /v1/images/fast` $0.02,
  `POST /v1/images/pro` $0.05, `POST /v1/images/generations` $0.08,
  `POST /v1/videos/generations` $0.20 (one silent 4-second 720p clip). OpenAI
  wire, so any OpenAI SDK works against base_url `https://agent402.tools/v1`;
  priced per picture or per clip rather than per token.
- **Pay any way:** x402 (USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo,
  Avalanche, Sei, Optimism, Stellar, Algorand; USDG on Robinhood Chain - 12 chains),
  MPP (Machine Payments Protocol) on the same 402 (Base/Celo, or natively on Tempo),
  free proof-of-work on the pure-CPU tools. Prepaid card credits are not on sale;
  a credits key bought earlier still pays any priced route except the
  wallet-identity-bound ones with `Authorization: Bearer a402_…`, debited only on
  a successful call, and never expires.
- **Report products** ($0.60 to $2.00 over x402/MPP, or $2 to $5 by card at
  https://agent402.tools/reports - the card price includes payment processing,
  an agent paying per call pays the lower tool price for the same report):
  deep research `POST /v1/research` (+ `/pro`, `/max`), market brief
  `/v1/research/market-brief`, company dossier `/v1/dossier` (+ `/max`), ticker
  pack `/v1/ticker-pack`, 13F fund report `/v1/fund` (+ `/max`), SEC filing report
  `/v1/filing-report`, domain audit `/v1/domain-audit` (+ `/pro`), FDA recall
  `/v1/recall-report`, insider flow `/v1/insider-report`, Solana token brief
  `/v1/token-brief`, token risk `/v1/token-risk` (+ `/pro`) - $0.60 to $2.00 per
  call for an agent, $2 to $5 by card; current per-route prices at
  https://agent402.tools/pricing.
- **Monitors** ($5/month each, card, https://agent402.tools/monitors): domain
  security, SEC filings, Solana token safety, 13F fund, FDA recall, insider flow,
  IPO pipeline and a research question. Most watch with a free daily probe and
  send a full paid re-run only when something changes; the research watch
  re-runs weekly.
- **MCP:** hosted connector `https://agent402.tools/mcp` (dotted tools:
  `catalog.search`, `catalog.find`, `catalog.call`, `payment.info`,
  `server.describe`, `sellers.list`, `demand.request`, plus flagships `web.search`,
  `web.answer`, `web.news`, `browser.render`, `market.quote`, `audio.transcribe`,
  `memory.read`, `memory.write`); wallet-only tools are payable on the connector
  over MPP (the challenge arrives as a JSON-RPC payment error, the credential
  goes back in `_meta`). npm: `agent402-mcp` (stdio, pays by
  wallet or credits key), `agent402-client` (buyer SDK), `agent402-tollbooth`
  (pay-per-crawl: x402 + MPP, native Tempo with split payments).
- **Maintainer:** Havok Holdings LLC. Open source (AGPL-3.0 server, MIT packages).
