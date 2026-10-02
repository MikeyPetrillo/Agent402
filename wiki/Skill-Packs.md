# Skill Packs

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

**70+ curated multi-tool workflows.** Each pack solves a real job that no single tool covers - auditing a domain, working up a time series, decoding an opaque blob, pulling the macro backdrop - and ships as a single MCP **prompt**. An agent calls `prompts/get { name: "<pack>", arguments: { … } }` and gets back a ready-to-run plan with the right Agent402 tools wired in (in the right order, with the right inputs).

- **Browse on the live site:** [`agent402.tools/skills`](https://agent402.tools/skills) (full templates, arguments, examples)
- **MCP discovery:** every MCP-aware client picks them up via `prompts/list` → `prompts/get`
- **Find-by-task:** [`/api/find?q=<task>`](https://agent402.tools/api/find?q=audit+a+domain) also recommends a matching pack alongside individual tools, so a task-shaped query points at the workflow, not just the raw tools.

## How to call a pack

```jsonc
// MCP (any MCP-aware client - Claude Desktop, Cline, etc.)
prompts/get { "name": "security-audit", "arguments": { "domain": "example.com" } }

// HTTP (plain GET - no wallet needed to render a template)
GET https://agent402.tools/skills/security-audit?domain=example.com
```

The template is the **plan** - the agent then executes each step. Payment (USDC via x402 or free proof-of-work) only happens when the agent actually calls each tool.

Every pack is **also a single paid endpoint**, `POST /api/skill/{slug}`, which runs the whole workflow in one call for one flat price. That price is the **Price** column in the tables below (verifiable in [`/api/pricing`](https://agent402.tools/api/pricing) under the `skill-{slug}` slugs). Rendering the template stays free either way; the flat price is what the bundled run costs.

---

## Security & trust (10)

| Pack | Price | What it solves |
|---|---|---|
| [**jwt-toolkit**](https://agent402.tools/skills/jwt-toolkit) | $0.003 | Decode and verify a JWT in one pass, then re-issue the claims: jwt-decode, jwt-verify, jwt-sign. |
| [**webhook-intake**](https://agent402.tools/skills/webhook-intake) | $0.006 | The production ingest path for an incoming webhook: verify the signature, validate the payload, hash, timestamp, redact. |
| [**security-audit**](https://agent402.tools/skills/security-audit) | $0.017 | Enumerate a domain's external attack surface: certs, DNS posture, email auth, HTTP headers, tech stack. |
| [**email-deliverability**](https://agent402.tools/skills/email-deliverability) | $0.009 | Diagnose why a domain's email lands in spam: SPF, DMARC, DKIM strength, MX, composite score. |
| [**fraud-signals**](https://agent402.tools/skills/fraud-signals) | $0.027 | Is this domain a phishing site / typosquat / scam? Pull the reputation signals before you click. |
| [**domain-intel**](https://agent402.tools/skills/domain-intel) | $0.016 | Full domain security + SEO intel: WHOIS, DNS, TLS, headers, tech stack, robots, certificate transparency. |
| [**ssl-audit**](https://agent402.tools/skills/ssl-audit) | $0.006 | TLS/SSL posture: live certificate inspection, HTTP security headers, and CAA DNS records. |
| [**email-security**](https://agent402.tools/skills/email-security) | $0.006 | Full email auth posture: SPF, DMARC, DKIM, and a composite deliverability score. |
| [**brand-protection**](https://agent402.tools/skills/brand-protection) | $0.018 | Is this domain legitimate? WHOIS age, DNS, scam/phishing search, and HTTP headers for a trust read. |
| [**domain-age**](https://agent402.tools/skills/domain-age) | $0.008 | How old and legit is this domain? WHOIS registration, DNS resolution, and TLS certificate in one pass. |

## Web extraction & document intelligence (12)

| Pack | Price | What it solves |
|---|---|---|
| [**markdown-convert**](https://agent402.tools/skills/markdown-convert) | $0.003 | Markdown to HTML and back, with a diff of the round trip. |
| [**text-analyze**](https://agent402.tools/skills/text-analyze) | $0.004 | Word and sentence stats, keyword extraction and an exact token count in one call. |
| [**text-hygiene**](https://agent402.tools/skills/text-hygiene) | $0.009 | Turn dirty text (chat logs, scraped pages) into clean lines: stats, redaction, dedupe, sort, entities, keywords, readability. |
| [**content-extraction**](https://agent402.tools/skills/content-extraction) | $0.035 | Turn arbitrary URLs and PDFs into clean structured text - articles, page metadata, PDF pages, OCR. |
| [**structured-scrape**](https://agent402.tools/skills/structured-scrape) | $0.023 | Pull structured data out of any page deterministically - articles, tables, elements by CSS selector. |
| [**any-to-markdown**](https://agent402.tools/skills/any-to-markdown) | $0.026 | "I have a URL but it might be HTML, PDF, or an image - give me clean markdown either way." |
| [**document-intel**](https://agent402.tools/skills/document-intel) | $0.024 | Turn any PDF or image URL into structured data - metadata, text, page ranges, OCR, barcodes. |
| [**link-preview**](https://agent402.tools/skills/link-preview) | $0.015 | Turn a URL into a card-shaped preview - OpenGraph/Twitter metadata + normalized social image + thumbnail. |
| [**pdf-pipeline**](https://agent402.tools/skills/pdf-pipeline) | $0.007 | Full PDF pipeline - metadata, markdown conversion, and first-page extraction in one call. |
| [**url-inspector**](https://agent402.tools/skills/url-inspector) | $0.004 | Quick URL health + metadata - parse the structure, verify reachability, and pull page metadata. |
| [**content-grade**](https://agent402.tools/skills/content-grade) | $0.012 | Grade a page's content quality - extract the readable content then analyze keyword density. |
| [**document-brief**](https://agent402.tools/skills/document-brief) | $0.031 | Metadata, an AI-written summary, and a preview of the opening pages of a PDF - understand what a document says without reading the whole thing. |

## SEO & site audit (4)

| Pack | Price | What it solves |
|---|---|---|
| [**seo-audit**](https://agent402.tools/skills/seo-audit) | $0.009 | Can search engines and AI crawlers index this page? Reachability, TLS, robots, sitemap, meta/OG, link graph. |
| [**page-audit**](https://agent402.tools/skills/page-audit) | $0.017 | Full page SEO + security audit: content, metadata, HTTP headers, robots policy, and sitemap health. |
| [**competitor-scan**](https://agent402.tools/skills/competitor-scan) | $0.014 | What's a competitor running? Tech stack, HTTP headers, WHOIS, and page metadata in one call. |
| [**status-snapshot**](https://agent402.tools/skills/status-snapshot) | $0.008 | "Is this site healthy, addressable, and crawlable - right now?" DNS → HTTP → headers → TLS → robots. |

## Finance (9)

| Pack | Price | What it solves |
|---|---|---|
| [**loan-comparison**](https://agent402.tools/skills/loan-comparison) | $0.006 | Compare loan offers with different rates and terms: payment, amortization, compound interest, NPV, IRR. |
| [**financial-research**](https://agent402.tools/skills/financial-research) | $0.024 | SEC filings + real-time quotes + history + macro context for a single ticker. |
| [**financial-analysis**](https://agent402.tools/skills/financial-analysis) | $0.024 | Quick company snapshot: live quote, 9 key financial metrics, and upcoming earnings. |
| [**company-dossier**](https://agent402.tools/skills/company-dossier) | $0.037 | Comprehensive company research in one call: quote, financials, filings, insider trades, news. |
| [**earnings-watch**](https://agent402.tools/skills/earnings-watch) | $0.015 | Is this company reporting soon and what's the consensus? Earnings calendar, quote, recent results. |
| [**earnings-deep-dive**](https://agent402.tools/skills/earnings-deep-dive) | $0.033 | Everything before a company reports: the upcoming date, latest financials, recent filings, live quote, and fresh news in one pass. |
| [**insider-alert**](https://agent402.tools/skills/insider-alert) | $0.01 | Insider buying/selling for a stock: Form 4 trades, live quote, and recent SEC filings. |
| [**price-monitor**](https://agent402.tools/skills/price-monitor) | $0.021 | Side-by-side snapshot of a stock and a crypto asset: live quotes, 1-year history, date-stamped compare. |
| [**options-analytics**](https://agent402.tools/skills/options-analytics) | $0.017 | Price a European option on a live stock: current quote, volatility from recent history, Black-Scholes fair value plus the full greeks, and catalyst news. |

## Macro & SEC (12)

| Pack | Price | What it solves |
|---|---|---|
| [**macro-economics**](https://agent402.tools/skills/macro-economics) | $0.032 | Pull the canonical US macro dataset - yield curve, CPI, unemployment, fed funds, Sahm rule. |
| [**macro-context**](https://agent402.tools/skills/macro-context) | $0.036 | "Is the economic backdrop you're modeling against still current?" - refresh the macro snapshot. |
| [**sec-filings-deep-dive**](https://agent402.tools/skills/sec-filings-deep-dive) | $0.028 | Full EDGAR picture of one company: filings, key financial time series, insider trades, full-text search. |
| [**regulatory-watch**](https://agent402.tools/skills/regulatory-watch) | $0.023 | "Who just filed / bought / IPO'd?" - EDGAR full-text search, recent filings, Form 4s, 13F, IPO calendar. |
| [**ipo-watch**](https://agent402.tools/skills/ipo-watch) | $0.023 | What's going public? Recent S-1/IPO filings from EDGAR plus a web search for IPO news. |
| [**yield-dashboard**](https://agent402.tools/skills/yield-dashboard) | $0.014 | Current yield-curve snapshot: full Treasury curve, key spreads, and average rates. |
| [**fixed-income-desk**](https://agent402.tools/skills/fixed-income-desk) | $0.017 | Read the rate environment and price a bond in one workflow: live Treasury curve, the recession-signal spread, inflation context, then bond price and yield at current rates. |
| [**inflation-check**](https://agent402.tools/skills/inflation-check) | $0.018 | Is the economy in recession territory? CPI, fed funds, unemployment, and Sahm rule. |
| [**fx-monitor**](https://agent402.tools/skills/fx-monitor) | $0.009 | Major currency snapshot: EUR/USD, GBP/USD, JPY/USD plus the full FX dashboard. |
| [**fred-snapshot**](https://agent402.tools/skills/fred-snapshot) | $0.005 | Key Fed indicators - fed funds rate, unemployment, and CPI - in one call. |
| [**world-data**](https://agent402.tools/skills/world-data) | $0.005 | GDP and population for a country - two key World Bank indicators. |
| [**macro-dashboard**](https://agent402.tools/skills/macro-dashboard) | $0.065 | The full macro plus crypto dashboard in one call: 5 FRED series, 5 Treasury reads, the curve spread, crypto market/trending/global, and live gas. |

## Time series & forecasting (3)

| Pack | Price | What it solves |
|---|---|---|
| [**number-crunch**](https://agent402.tools/skills/number-crunch) | $0.003 | Descriptive statistics, correlation and outliers over a numeric series. |
| [**trend-analysis**](https://agent402.tools/skills/trend-analysis) | $0.018 | Take any numeric series and run the full workup - descriptives, moving averages, trend, outliers, forecast. |
| [**forecasting-bake-off**](https://agent402.tools/skills/forecasting-bake-off) | $0.014 | Backtest all four methods (naive/drift, SES, Holt, Holt-Winters), rank by RMSE, forecast with the winner. |

## Crypto & onchain (13)

| Pack | Price | What it solves |
|---|---|---|
| [**market-brief**](https://agent402.tools/skills/market-brief) | $0.009 | Quick crypto snapshot: price for a coin, trending coins, and global market stats in one call. |
| [**crypto-research**](https://agent402.tools/skills/crypto-research) | $0.054 | Live price, market structure, OHLC history, trending status, global context, and news for a coin. |
| [**crypto-dossier**](https://agent402.tools/skills/crypto-dossier) | $0.041 | Everything about a coin: live price, 90-day history, trending status, market context, news + top article. |
| [**defi-protocol-scanner**](https://agent402.tools/skills/defi-protocol-scanner) | $0.025 | Due-diligence a DeFi protocol: live token price, market context, protocol TVL across chains, and recent news. |
| [**defi-dashboard**](https://agent402.tools/skills/defi-dashboard) | $0.014 | DeFi overview: total TVL, ETH price, Base gas, and global crypto stats. |
| [**nft-portfolio**](https://agent402.tools/skills/nft-portfolio) | $0.005 | NFT + wallet snapshot: NFT holdings, native balance, and ETH price for an address. |
| [**wallet-audit**](https://agent402.tools/skills/wallet-audit) | $0.005 | Full wallet review: balance, recent transactions, and token metadata for an address. |
| [**wallet-readiness**](https://agent402.tools/skills/wallet-readiness) | $0.008 | "Can this wallet pay right now?" USDC on Base + Solana, live Base gas, and an Onramp funding link. |
| [**onchain-analyst**](https://agent402.tools/skills/onchain-analyst) | $0.021 | Ask Base anything in SQL - your query runs against Coinbase's indexed, decoded chain data. |
| [**gas-optimizer**](https://agent402.tools/skills/gas-optimizer) | $0.007 | Find the cheapest gas: Base gas, Ethereum gas, Base fee estimate, and ETH price for USD conversion. |
| [**tx-forensics**](https://agent402.tools/skills/tx-forensics) | $0.011 | Explain what an EVM transaction actually did: confirmation status, the raw transaction, decoded calldata with typed parameters, resolved function signature, and labeled counterparties. |
| [**cheapest-rail**](https://agent402.tools/skills/cheapest-rail) | $0.009 | Where should an agent transact this minute? Live gas across L2s, a fee estimate, and ETH spot. |
| [**contract-audit**](https://agent402.tools/skills/contract-audit) | $0.022 | Triage a smart contract before an agent touches it: verified source, heuristic vulnerability scan, known-address check, selector resolution, and a read-only dry-run of the exact call. |

## Network, DevOps & API work (7)

| Pack | Price | What it solves |
|---|---|---|
| [**schema-guard**](https://agent402.tools/skills/schema-guard) | $0.004 | Contract-test a JSON payload: validate against a schema, infer one, diff, format. |
| [**json-pipeline**](https://agent402.tools/skills/json-pipeline) | $0.004 | Validate, pretty-print and convert JSON to CSV in one pass. |
| [**openapi-audit**](https://agent402.tools/skills/openapi-audit) | $0.004 | Lint an OpenAPI spec, validate a sample payload against it, and summarize its security schemes. |
| [**dns-network-ops**](https://agent402.tools/skills/dns-network-ops) | $0.011 | End-to-end DNS health check: records, multi-resolver propagation, WHOIS, ASN, robots.txt, reachability. |
| [**api-investigation**](https://agent402.tools/skills/api-investigation) | $0.017 | Point at an unknown API and figure out how to use it: auth, content type, version, rate limits, schema. |
| [**schema-evolution**](https://agent402.tools/skills/schema-evolution) | $0.008 | "Did this API contract change in a way that breaks us?" - diff two OpenAPI snapshots, lint, validate. |
| [**api-health**](https://agent402.tools/skills/api-health) | $0.005 | Is this API endpoint healthy? Liveness check, response headers, and TLS certificate status. |

## Decoding & inspection (1)

| Pack | Price | What it solves |
|---|---|---|
| [**decode-blob**](https://agent402.tools/skills/decode-blob) | $0.007 | Hand the agent an opaque string - JWT, base64 JSON, gzipped response - and identify + unwrap it layer by layer. |

## Identity & onboarding (3)

| Pack | Price | What it solves |
|---|---|---|
| [**user-onboarding**](https://agent402.tools/skills/user-onboarding) | $0.008 | Take a signup form and run onboarding deterministically - validate, score, mint ID, slug, hash, verify 2FA. |
| [**contact-verify**](https://agent402.tools/skills/contact-verify) | $0.004 | Verify an email is deliverable - syntax validation plus MX record check on the domain. |
| [**entity-enrich**](https://agent402.tools/skills/entity-enrich) | $0.022 | Company name to verified identity plus web footprint: Wikidata facts, the LEI legal-entity record, the SEC filer, domain registration, tech stack, and brand favicon. |

## Location & time (5)

| Pack | Price | What it solves |
|---|---|---|
| [**timezone-planner**](https://agent402.tools/skills/timezone-planner) | $0.003 | Time zone conversion, business-day arithmetic and the next cron fire time. |
| [**location-intel**](https://agent402.tools/skills/location-intel) | $0.008 | Point at an address and assemble the brief - coords, address, nearby, weather, NWS alerts, seismic. |
| [**trip-planner**](https://agent402.tools/skills/trip-planner) | $0.006 | Plan a multi-stop journey - geocode each stop, sum pairwise distances, add travel time, pull weather. |
| [**weather-brief**](https://agent402.tools/skills/weather-brief) | $0.006 | Full weather briefing for a location: current conditions, 7-day forecast, and air quality. |
| [**locale-brief**](https://agent402.tools/skills/locale-brief) | $0.004 | "Can I reach this counterparty this week?" Country facts, this year's public holidays, working days left this week, and the local time right now. |

## Media & accessibility (2)

| Pack | Price | What it solves |
|---|---|---|
| [**media-pipeline**](https://agent402.tools/skills/media-pipeline) | $0.03 | "User uploaded a thing, normalize it before storing." Probe → decode → resize → thumbnail → convert. |
| [**subtitle-pipeline**](https://agent402.tools/skills/subtitle-pipeline) | $0.03 | Audio URL to finished subtitles: transcribe the audio, emit SRT/WebVTT/JSON cues, and report length, reading time, and word count. |

## Search & citations (3)

| Pack | Price | What it solves |
|---|---|---|
| [**search-and-cite**](https://agent402.tools/skills/search-and-cite) | $0.101 | Research a question, return an answer with citations - synthesized take + SERP + news, verified by fetch. |
| [**article-digest**](https://agent402.tools/skills/article-digest) | $0.09 | Quick research brief on any topic - web search results plus an AI-generated answer. |
| [**feed-watch**](https://agent402.tools/skills/feed-watch) | $0.016 | Monitor an RSS/Atom feed: parse it, read the top story in full, extract the keywords driving the cycle, and diff the item list against your last run to isolate what is new. |

---

## Why packs and not just tools

A single tool answers a question. A pack answers a **job**.

When an agent says *"audit a domain"*, picking one tool (whois? dns? tls-cert? cert-transparency?) is a guess - the right answer is "all of them in the right order, then synthesize." That's what a pack encodes:

- **The plan is in the template, not in the model.** Same pack, same plan, every time - no token-spending discovery loop.
- **The tools are pinned.** When a new better tool ships, the pack template gets updated server-side; agents calling `prompts/get` always get the current best plan.
- **Pricing is transparent.** Each tool's price is deterministic; the pack template lists every call so total cost is predictable before the first call.
- **No hidden inference.** Rendering a pack template runs no model, so the plan an agent receives is the same every time; a pack step that calls a model-backed tool says so.

## Adding a pack

Packs live in [`src/skills.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/src/skills.js). A pack is `{ slug, title, tagline, useCase, toolSlugs[], arguments[], workflow[], notes[] }` - see the existing entries for the shape. CI's "answers its own example" check covers the underlying tools; pack templates are validated by `scripts/test-mcp-all.js` (`prompts/list` returns N typed entries; `prompts/get` renders each one without throwing).

## See also

- [[Tool Catalog]] - the underlying 500+ tools the packs orchestrate
- [[MCP Connector]] - how to wire the connector into Claude / Cline / any MCP-aware client
- [[Getting Started]] - your first call (free, no wallet) in 60 seconds
- [[x402-Index-and-Router]] - what Agent402 looks like inside the wider x402 ecosystem
