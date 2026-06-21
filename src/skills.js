// Skill packs — curated bundles of tools for a specific workflow. Each pack is
// a discovery surface (a server-rendered page at /skills/<slug>) and, in the
// follow-up PR, an MCP prompt that templates the workflow for an agent.
//
// The data shape is deliberately small: a slug, a human-readable title and
// tagline, a "when to use" sentence, the ordered list of tool slugs, a narrative
// workflow (what each tool contributes), and a copy-pastable Claude prompt.
// Both surfaces (HTML pages + MCP prompts) read from the same SKILL_PACKS
// array — single source of truth.
//
// The page renderer looks each toolSlug up in the live CATALOG so prices,
// descriptions, and routes stay accurate even as tools evolve. If a pack
// references a tool that's been removed, the page surfaces a "missing" placeholder
// rather than crashing — useful for catching dead references in the test suite.
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

export const SKILL_PACKS = [
  {
    slug: "security-audit",
    title: "Security audit",
    tagline:
      "Enumerate a domain's external attack surface in one workflow: certs, DNS posture, email auth, HTTP security headers, and tech stack.",
    useCase:
      "Before a pentest, an acquisition diligence call, or a quarterly review — you want a fast read on what an attacker sees from the outside.",
    promptArgs: [
      { name: "domain", description: "Target domain to audit (e.g. stripe.com)", required: true, substitute: "example.com" },
    ],
    toolSlugs: [
      "cert-transparency",
      "dns-lookup",
      "spf-check",
      "dmarc-check",
      "http-headers",
      "tls-cert",
      "tech-stack",
    ],
    workflow: [
      "Pull the certificate transparency log to enumerate every subdomain a CA has ever issued a cert for — this is the fastest external recon step.",
      "For each interesting subdomain, resolve A/AAAA/MX/NS/CAA records to map the live infrastructure and certificate authority constraints.",
      "Check SPF and DMARC on the apex to see whether the domain can be spoofed in email — a missing or weak DMARC is one of the highest-impact findings on most audits.",
      "Pull HTTP response headers on the apex and a few key subdomains; the security analyzer scores HSTS, CSP, XFO, XCTO, Referrer-Policy, Permissions-Policy, and the COOP/CORP/COEP triad.",
      "Inspect the live TLS cert (chain, expiry, SANs) — useful for spotting near-expiry, mismatched SANs, or weak chain configurations.",
      "Fingerprint the tech stack so you know what CMS/framework/CDN to research for known CVEs.",
    ],
    claudePrompt:
      'Run a security audit on example.com. Use Agent402 to: (1) pull the certificate transparency log, (2) check SPF and DMARC on the apex, (3) fetch HTTP security headers and the TLS cert, (4) fingerprint the tech stack. Report findings ranked by severity, and call out anything that would block a SOC 2 review.',
  },
  {
    slug: "email-deliverability",
    title: "Email deliverability",
    tagline:
      "Diagnose why a domain's email lands in spam: SPF posture, DMARC policy, DKIM key strength, MX targets, and a composite 0–100 score.",
    useCase:
      "Marketing or transactional email is landing in spam, or you're rolling out a new sending domain and want to verify the auth posture before the first campaign.",
    promptArgs: [
      { name: "domain", description: "Sending domain to diagnose (e.g. stripe.com)", required: true, substitute: "example.com" },
    ],
    toolSlugs: [
      "spf-check",
      "dmarc-check",
      "dkim-lookup",
      "email-deliverability",
      "email-validate",
      "dns-lookup",
    ],
    workflow: [
      "Parse the SPF record — the tool flags the most common failures (>10 DNS lookups, +all permissive directive, syntax errors).",
      "Parse the DMARC policy — p=none means receivers ignore SPF/DKIM failures, which usually explains a 'we set it all up but it still goes to spam' problem.",
      "Probe 14 common DKIM selectors and warn on <1024-bit keys and testing-mode (t=y) records. Most sending platforms publish under a predictable selector this catches.",
      "Run the composite deliverability score (25 points each for SPF + DMARC + DKIM + MX) for a single integer to report back to the team.",
      "Validate a single recipient address with email-validate to confirm the MX is actually reachable.",
      "Spot-check the MX records with dns-lookup type=MX to verify the chain matches the sending platform's documented setup.",
    ],
    claudePrompt:
      'Diagnose email deliverability for sender@example.com. Use Agent402 to check SPF, DMARC, DKIM (probe common selectors), and the composite email-deliverability score. If the score is below 75, explain which auth records are missing or weak and how to fix each one.',
  },
  {
    slug: "financial-research",
    title: "Financial research",
    tagline:
      "Pull SEC filings, real-time quotes, historical prices, and macro context for a single ticker in one pass.",
    useCase:
      "Building a one-pager on a public company — you want fundamentals, recent insider activity, and the macro backdrop without leaving the agent loop.",
    promptArgs: [
      { name: "ticker", description: "Stock ticker symbol (e.g. AAPL, MSFT, NVDA)", required: true, substitute: "AAPL" },
    ],
    toolSlugs: [
      "stock-quote",
      "stock-history",
      "edgar-filings",
      "edgar-company-facts",
      "edgar-insider-trades",
      "fred-series",
      "research-company",
    ],
    workflow: [
      "Get the live quote from stock-quote — current price, market cap, day range, volume.",
      "Pull 1Y of OHLCV from stock-history to compute return, vol, and drawdown for the brief.",
      "List recent SEC filings (10-K, 10-Q, 8-K) via edgar-filings — link each one in the report.",
      "Pull the structured XBRL company facts (revenue, net income, total assets, share count) from edgar-company-facts for the canonical numbers.",
      "Check edgar-insider-trades for Form 4 filings in the last 90 days — directional insider activity is a real signal.",
      "Drop in macro context (CPI, fed funds, unemployment) from fred-series so the brief contextualizes the company-level view.",
      "If you need a 1-call composite, research-company fans out to several of the above in a single paid call.",
    ],
    claudePrompt:
      "Build a one-page research brief on AAPL. Use Agent402 to pull: (1) current quote, (2) 1-year price history with return/vol/max-drawdown, (3) the last 4 SEC filings, (4) XBRL revenue and net income trend, (5) Form 4 insider trades in the last 90 days, (6) CPI and fed funds rate as macro context. Output a clean markdown brief.",
  },
  {
    slug: "macro-economics",
    title: "Macro economics",
    tagline:
      "Pull the canonical US macro dataset — yield curve, CPI, unemployment, fed funds, Sahm rule — without an API key.",
    useCase:
      "Producing a weekly macro note, charting the recession-indicator dashboard, or feeding a model with the latest FRED/Treasury data.",
    promptArgs: [],
    toolSlugs: [
      "treasury-yield-curve",
      "yield-curve-spread",
      "cpi-yoy",
      "unemployment-rate",
      "fed-funds",
      "sahm-rule",
      "fred-release-calendar",
    ],
    workflow: [
      "Pull the live Treasury yield curve (all maturities from 1M to 30Y) — the base data for every spread/inversion chart.",
      "Get the 10Y–2Y and 10Y–3M spreads from yield-curve-spread; the latter is the NY Fed's preferred recession indicator.",
      "Pull CPI YoY (cpi-yoy) for the headline and core inflation read.",
      "Pull the headline unemployment rate (unemployment-rate) — the U-3 series.",
      "Get the effective fed funds rate (fed-funds) for the current policy stance.",
      "Compute the Sahm rule (sahm-rule) — a real-time recession indicator that triggers when the 3-month unemployment average rises >0.5pp above its 12-month low.",
      "Pull the upcoming FRED release calendar (fred-release-calendar) so the brief can flag what's hitting this week.",
    ],
    claudePrompt:
      "Build today's macro dashboard. Use Agent402 to pull the Treasury yield curve, 10Y–2Y and 10Y–3M spreads, latest CPI YoY, unemployment rate, fed funds rate, and the Sahm rule reading. Highlight any indicator that is at a multi-year extreme, and list FRED releases scheduled for this week.",
  },
  {
    slug: "dns-network-ops",
    title: "DNS & network ops",
    tagline:
      "End-to-end DNS health check: records, multi-resolver propagation, WHOIS, ASN, robots.txt, and reachability.",
    useCase:
      "Investigating a DNS-related outage, debugging propagation after a record change, or onboarding a new domain and checking the operator chain.",
    promptArgs: [
      { name: "domain", description: "Domain to check (e.g. stripe.com)", required: true, substitute: "example.com" },
    ],
    toolSlugs: [
      "dns-lookup",
      "dns-propagation",
      "asn-info",
      "whois",
      "http-check",
      "robots-check",
    ],
    workflow: [
      "Resolve A/AAAA/MX/TXT/NS/CAA records on the apex with dns-lookup to baseline what the authoritative answer should be.",
      "Run dns-propagation across Cloudflare/Google/Quad9/OpenDNS in parallel — divergent answers mean a stale cache somewhere or a botched TTL during a migration.",
      "Look up the ASN and prefix that the apex resolves into with asn-info (Team Cymru DNS-based whois — no auth needed). Useful for spotting an unexpected hosting move.",
      "Pull whois for ownership, expiry, and registrar — catches the 'we forgot to renew' class of outage.",
      "Run http-check for status code, response time, and final URL after redirects — the fastest 'is it actually up' read.",
      "Spot-check robots.txt with robots-check to make sure a redeploy didn't accidentally Disallow: / the whole site.",
    ],
    claudePrompt:
      "Run a DNS health check on example.com. Use Agent402 to: pull the apex DNS records, check propagation across major public resolvers, look up the ASN/prefix, pull whois for ownership and expiry, run an HTTP reachability check, and confirm robots.txt isn't broken. Report any inconsistency or near-expiry.",
  },
  {
    slug: "crypto-research",
    title: "Crypto research",
    tagline:
      "Pull live price, market structure, OHLC history, trending status, global market context, and recent news for a single coin in one pass.",
    useCase:
      "Building a one-pager on a token, prepping for a positioning decision, or monitoring a new listing — you want price, supply, sentiment, and headlines without leaving the agent loop.",
    promptArgs: [
      { name: "coin", description: "Coin ticker or CoinGecko id (e.g. BTC, ETH, bitcoin)", required: true, substitute: "BTC" },
    ],
    toolSlugs: [
      "crypto-price",
      "crypto-market",
      "crypto-history",
      "crypto-trending",
      "crypto-global",
      "search-news",
      "extract",
    ],
    workflow: [
      "Get the live quote from crypto-price — last price, 24h change, 24h volume, and market cap.",
      "Pull the market overview from crypto-market — circulating supply, max supply, ATH, ATH date, and 7d/30d performance for the deep dive.",
      "Pull OHLC history from crypto-history to compute return, volatility, and max drawdown over a chosen window.",
      "Check crypto-trending to see whether the coin is on CoinGecko's most-searched list — a fast read on retail attention.",
      "Pull crypto-global for total market cap, BTC dominance, and 24h volume — contextualizes the coin's move against the broader market.",
      "Pull the last week of search-news headlines for the coin — catalysts, partnerships, exploit reports.",
      "For the top 2–3 headlines, use extract to convert the article to clean markdown for the brief.",
    ],
    claudePrompt:
      "Build a one-page research brief on BTC. Use Agent402 to pull: (1) live quote (price, 24h change, volume), (2) market overview (supply, ATH, 30d performance), (3) 90 days of OHLC history with return and max drawdown, (4) whether BTC is in CoinGecko's trending list, (5) Bitcoin dominance and total market cap context from crypto-global, (6) the last 7 days of news headlines via search-news, (7) clean markdown of the top 2–3 articles via extract. Output a clean markdown brief.",
  },
  {
    slug: "content-extraction",
    title: "Content extraction",
    tagline:
      "Turn arbitrary URLs and PDFs into clean structured text — articles, page metadata, PDF pages, OCR'd images, browser-rendered SPAs.",
    useCase:
      "Building a RAG corpus, a daily newsletter from a list of source URLs, or extracting a table from a scanned PDF.",
    promptArgs: [
      { name: "urls", description: "Newline- or comma-separated list of URLs / PDF links to ingest", required: false, substitute: "these 10 URLs" },
    ],
    toolSlugs: [
      "extract",
      "meta",
      "pdf-to-markdown",
      "pdf-extract-pages",
      "render",
      "image-ocr",
    ],
    workflow: [
      "For an article URL, extract returns clean markdown (Readability-style) plus title, byline, word count.",
      "For OpenGraph card data (title, description, image, canonical), meta is faster than extract.",
      "For a PDF that lives at a URL, pdf-to-markdown converts the whole document; pdf-extract-pages pulls a specific page range.",
      "For a SPA or paywalled page that needs JavaScript execution, render returns the post-JS HTML — extract usually works directly against the rendered URL.",
      "For an image URL (scanned receipt, screenshot of a table), image-ocr returns the text.",
      "Pipeline: render → extract → embed for a robust ingest path that handles client-rendered sites without breaking.",
    ],
    claudePrompt:
      "Ingest these 10 URLs into clean markdown using Agent402. For each: try extract first; if it returns no body, fall back to render→extract; for any PDF URL, use pdf-to-markdown. Return one markdown blob per URL with the source URL as the H1.",
  },
  {
    slug: "sec-filings-deep-dive",
    title: "SEC filings deep-dive",
    tagline:
      "Pull the full EDGAR picture of a US public company in one workflow: recent filings, key financial time series, insider trades, and full-text search across the corpus.",
    useCase:
      "Pre-earnings prep, an investment thesis, M&A diligence, or journalism — anywhere you need the source documents instead of a paid terminal's summary.",
    promptArgs: [
      { name: "ticker", description: "US stock ticker (e.g. AAPL, NVDA, BRK.B)", required: true, substitute: "AAPL" },
    ],
    // 7 tools, 4 of which weren't used in any other pack before this one
    // (edgar-company-lookup, edgar-company-concept, edgar-search,
    // edgar-13f-holdings). Ordered to mirror an analyst's real workflow:
    // resolve the entity first, then go wide on what's been filed.
    toolSlugs: [
      "edgar-company-lookup",
      "edgar-filings",
      "edgar-company-facts",
      "edgar-company-concept",
      "edgar-insider-trades",
      "edgar-search",
      "edgar-13f-holdings",
    ],
    workflow: [
      "Resolve the ticker to a SEC CIK with edgar-company-lookup — every other tool keys off CIK, and tickers change (mergers, listings, spinoffs) while CIKs are stable.",
      "Pull the recent filing history with edgar-filings — 10-K (annual), 10-Q (quarterly), 8-K (material events), DEF 14A (proxy). The 8-K stream is the freshest signal: M&A, exec departures, material agreements, restatements.",
      "Use edgar-company-facts for a structured snapshot of every XBRL tag the company has ever filed (revenue, net income, assets, cash, etc.) — one call returns the full time series for tagging in your own model.",
      "Drill into a single concept with edgar-company-concept (e.g. us-gaap:Revenues, NetIncomeLoss) to compare a specific metric across years without parsing 10-K HTML.",
      "Run edgar-insider-trades to surface Form 4 transactions (officer/director buys + sells) in the last N days — concentrated insider selling around an event is one of the highest-signal-to-noise flags in public-markets research.",
      "Run edgar-search to full-text query the filing corpus for any phrase the company has ever filed — useful for finding the exact 10-K paragraph mentioning a competitor, a risk factor, or a litigation matter.",
      "Optional: pull edgar-13f-holdings on a known institutional manager (Berkshire = CIK 1067983, Bridgewater, etc.) to see whether they hold the target company and at what dollar weight.",
    ],
    claudePrompt:
      "Build a research brief on AAPL using Agent402's EDGAR tools. (1) Resolve the ticker → CIK with edgar-company-lookup. (2) List the 25 most recent filings via edgar-filings — flag any 8-K from the last 90 days. (3) Pull edgar-company-facts and report the 4-quarter trend for Revenues, NetIncomeLoss, and Assets. (4) Run edgar-insider-trades over the last 90 days and flag any director/officer who sold >$1M. (5) Run edgar-search for 'going concern' restricted to this CIK to surface auditor risk language. Output a markdown brief with each section linking back to the source filing URL.",
  },
  {
    slug: "structured-scrape",
    title: "Structured scrape",
    tagline:
      "Pull structured data out of any web page deterministically — articles to clean text, tables to JSON rows, specific elements via CSS selector — without writing regex against raw HTML.",
    useCase:
      "Extracting a product price, a sports stats table, a roster, a pricing tier, an outlink list — anything where the page has the data but no public API exposes it, and you need a repeatable deterministic answer instead of an LLM guess.",
    promptArgs: [
      { name: "url", description: "Page to scrape (e.g. https://example.com/product/42)", required: true, substitute: "https://example.com/product/42" },
      { name: "target", description: "What to extract — a price, a table, a list, a paragraph, etc.", required: true, substitute: "the price and SKU" },
    ],
    // Ordered as a real decision tree: try the cheapest fetch first (extract
    // for prose, meta for headers-only), fall back to render for SPAs, then
    // drill into the resulting HTML with the html-kit. Composes the kit that
    // shipped in src/tools/html-kit.js with the existing fetch tools.
    toolSlugs: [
      "extract",
      "render",
      "html-select",
      "html-table",
      "html-strip",
      "html-links",
      "html-meta",
    ],
    workflow: [
      "If the page is prose (an article, a blog post, a docs page), try extract first — it returns clean Readability-style markdown in one call, no HTML wrangling needed.",
      "If the page is a SPA, paywalled-but-bypassable-with-render, or has data that lives outside the article body, fall back to render — it runs Chromium and returns the post-JS HTML you can then drill into.",
      "Pipe the HTML from render into html-select with a CSS selector to pull specific elements (a price, a header, a button label). Use the `attr` parameter when you only need href/id/data-* values — keeps the response tight.",
      "If the data is in a <table>, use html-table — it returns header-keyed JSON rows by default, or RFC 4180 CSV if you'd rather paste it into a spreadsheet. It picks the first matching table; pass a selector for more specificity.",
      "If you need plain text from a specific subtree (e.g. \"give me the body of <article>\"), use html-strip with a selector — it preserves block-level newlines and removes <script>/<style>.",
      "To enumerate outlinks (link audits, crawl seeds, footnote URLs), use html-links — it resolves relative hrefs against a base URL and dedups by href. Filter by regex when you only want one host or path prefix.",
      "If you already have the rendered HTML and just want the metadata (title, description, OpenGraph, Twitter, canonical, JSON-LD), use html-meta on the string — avoids paying for a second fetch from /api/meta.",
    ],
    claudePrompt:
      "Scrape the price and SKU from https://example.com/product/42 using Agent402. (1) Try extract first; if the price isn't in the article body, (2) call render to get the post-JS HTML. (3) Use html-select with a precise CSS selector to pull the price element — fall back to a broader selector if the first returns 0 matches. (4) Use html-select again with attr=\"data-sku\" or similar to read the SKU. Return a single JSON object {price, sku, url, source} where source = \"extract\" or \"render\" depending on which path worked.",
  },
  {
    slug: "decode-blob",
    title: "Decode this blob",
    tagline:
      "Hand the agent an opaque string — a JWT, a base64'd JSON payload, a gzip-encoded API response, a hex-encoded hash — and walk it through identifying what it is and unwrapping it layer by layer until it's human-readable.",
    useCase:
      "You pulled a suspicious string out of a log, a webhook body, a network capture, a cookie, or an API response, and you need to know what's inside without writing a one-off Node script. The tools in this pack are all deterministic and pure-CPU — every step is free over the proof-of-work tier.",
    promptArgs: [
      {
        name: "blob",
        description: "The opaque string to identify and decode",
        required: true,
        // A real JWT (HS256, header+payload only, signature stripped) so the
        // example prompt actually executes end-to-end via jwt-decode.
        substitute: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
      },
    ],
    // Ordered by cheapest-test-first: prefix inspection costs nothing, then
    // we try the encodings most likely to match (JWT for "eyJ", gzip for the
    // 1f 8b magic, base64 as the universal fallback). Composes the compression
    // kit shipped in src/tools/compression-kit.js with existing primitives.
    toolSlugs: [
      "jwt-decode",
      "gunzip",
      "brotli-decompress",
      "base64",
      "hex",
      "json-format",
      "hash",
    ],
    workflow: [
      "Look at the first few characters before calling anything. \"eyJ\" → almost certainly a JWT (it's base64url for `{\"`). \"H4sI\" → base64-encoded gzip (gzip's 1f 8b magic, base64'd). All hex chars and a multiple-of-2 length → likely hex-encoded bytes. Mostly A-Z/a-z/0-9/+// with optional `=` padding → base64.",
      "If it looks like a JWT, call jwt-decode — returns the header + payload as JSON without verifying the signature. The header tells you the algorithm; the payload is your answer. If decoded successfully but the payload is itself base64'd or gzipped, recurse with this pack.",
      "If the prefix is \"H4sI\" (or starts with bytes 1f 8b after a base64 decode), it's gzipped. Call gunzip with the base64 string directly — outputFormat \"utf8\" if you expect text, \"base64\" if you expect another binary layer.",
      "Brotli has no fixed magic in the stream, but if you've ruled out gzip and the bytes still don't look like text after base64 decode, try brotli-decompress. Failure is cheap (a 400, not a 500) so this is safe to attempt.",
      "Fall back to base64 with mode=\"decode\" — it's the most common wrapper. If the result is human-readable text, you're done; if it looks like more binary, you're peeling another layer (very common: base64(gzip(json))).",
      "If everything is in [0-9a-f] pairs and an even length, use hex with mode=\"decode\". This is how a lot of crypto/hash tooling formats output — sha256 digests, wallet addresses, encryption ciphertexts.",
      "When you finally land on something that parses as JSON, run json-format to pretty-print it — much easier to inspect a 50-key payload with indented keys than as one long line. If the original blob was a hash you wanted to verify, call hash on the source content and compare hex outputs.",
    ],
    claudePrompt:
      "Identify and decode this opaque string using Agent402: \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ\". (1) Inspect the prefix — \"eyJ\" suggests a JWT. (2) Call jwt-decode and return the header + payload. (3) If any field in the payload is itself a base64 / gzip / hex string, peel it: base64 → gunzip → brotli-decompress → hex, trying each only if the prefix suggests it. (4) When you reach plain text or JSON, return a single object describing what each layer was (e.g. {layers: [\"jwt\", \"base64\", \"gzip\", \"json\"], finalPayload: {...}}). All steps are free over the proof-of-work tier — no payment needed.",
  },
  {
    slug: "trend-analysis",
    title: "Trend analysis",
    tagline:
      "Take any numeric time series — a stock's daily close, a FRED macro indicator, a treasury yield history — and run it through the full quantitative workup: descriptives, moving averages, trend line, outliers, optional correlation against a benchmark, and a deterministic forecast forward with a 95% prediction interval. Everything an analyst writes a notebook for, in one chain of cheap calls.",
    useCase:
      "You have a question like \"is AAPL trending up over the last year — and what does the next quarter look like?\" or \"is unemployment a leading indicator for fed-funds moves?\" and want a deterministic numerical answer (slope, r², outlier dates, point forecast + 95% interval) instead of a hand-wavy LLM summary or hallucinated projection. The stats + forecast steps are pure-CPU and free over PoW; only the upstream data fetch (finance/macro) is paid.",
    promptArgs: [
      {
        name: "series",
        description: "What to analyze — a ticker (AAPL), a FRED series id (UNRATE), or a treasury maturity (10Y)",
        required: true,
        substitute: "AAPL",
      },
      {
        name: "horizon",
        description: "Lookback window for the fetch — e.g. \"1y\", \"5y\", \"6mo\". Maps to the upstream tool's range parameter.",
        required: false,
        substitute: "1y",
      },
    ],
    // Ordered as: fetch → describe → smooth → trend → anomalies → benchmark →
    // forecast. Each step takes the array of close prices / observations from
    // the prior step. Composes the stats + forecast kits (shipped in
    // src/tools/stats-kit.js and src/tools/forecast-kit.js) with the
    // finance/macro fetchers that already existed.
    toolSlugs: [
      "stock-history",
      "fred-series",
      "stats-summary",
      "moving-average",
      "linear-regression",
      "outliers",
      "correlation",
      "forecast-eval",
    ],
    workflow: [
      "Fetch the series. For an equity ticker, call stock-history with range=horizon (or \"1y\" if unspecified) and pull the array of `close` prices in chronological order. For a macro indicator, call fred-series with the series id (UNRATE, CPIAUCSL, FEDFUNDS, etc.) and pull the array of `value`s.",
      "Run stats-summary on the values to get the full descriptive panel (mean, median, stddev, min, max, q1/q3, IQR). This is the one-line \"what does this series even look like\" answer — agents that skip this step end up reporting trends without context.",
      "Smooth the noise with moving-average. A 20-day SMA is the textbook short-term trend smoother for daily prices; a 12-month MA suits monthly macro data. Use which=\"both\" so you can compare SMA (lagging but stable) with EMA (responsive but jittery).",
      "Fit linear-regression with x = [0, 1, ..., n-1] (just the index) and y = values. Slope tells you direction + magnitude per unit time; r² tells you how clean the trend is (>0.7 = strong trend, <0.3 = mostly noise). Pass `predict` for next-N-period extrapolation if the user wants a projection.",
      "Flag anomalies with outliers method=\"iqr\" — Tukey fences (1.5·IQR) are the conservative default. Report the indices + values; agents should then map indices back to dates from the original fetch so the answer says \"2024-03-14: $187.23 outlier\" not just \"index 142\".",
      "If the user asked a comparison question (\"is AAPL correlated with the S&P?\", \"do CPI and fed funds move together?\"), repeat steps 1-2 for the benchmark series, then call correlation with the two equal-length arrays. r above 0.7 = strong same-direction move; near 0 = independent; negative = inverse. Use the `interpretation` field as your one-line answer.",
      "Pick a forecast method honestly by backtesting. Call forecast-eval three times — once each with method=\"drift\", \"ses\", \"holt\" — passing the same values + testSize (≈ 20% of the series, capped at half). Compare RMSE; the lowest wins. Check `warnings` — non-empty means treat the result as indicative not predictive. Skip the bake-off only if you already know the series shape (e.g. holt-winters for clearly seasonal data with a known period).",
      "Forecast forward with the winning method. Call forecast-naive / forecast-ses / forecast-holt (whichever won) with the full values + the user's horizon. Return the point forecast AND lower95/upper95 — never report a point estimate without its interval; that's the whole reason these tools exist instead of an LLM guess. Combine summary + trend + outliers + optional correlation + forecast into a single JSON object. That's the deterministic analyst-grade reply.",
    ],
    claudePrompt:
      "Run a full trend analysis on AAPL over the last 1y using Agent402, then project the next quarter forward. (1) Fetch the daily closes via stock-history (ticker=AAPL, range=1y). (2) Run stats-summary on the closes for the descriptive panel. (3) Run moving-average with window=20, which=\"both\" — compare SMA vs EMA. (4) Run linear-regression with x=[0..n-1], y=closes; report slope (annualized = slope·252), intercept, r². (5) Run outliers method=\"iqr\" and map the flagged indices back to actual dates from the fetch. (6) Pick a forecast method: call forecast-eval three times with method=\"drift\", \"ses\", \"holt\" and testSize=50 (≈ 20% of a 252-day year); pick the lowest RMSE. (7) Forecast the next ~63 trading days using the winning method (forecast-naive / forecast-ses / forecast-holt) and report both point and 95% interval. (8) Return a single JSON object: {summary, trend, outlierDates, forecastMethod, forecastWithIntervals, oneLineConclusion}. The stats + forecast steps are free over PoW; only the stock-history fetch is paid.",
  },
  {
    slug: "forecasting-bake-off",
    title: "Forecasting bake-off",
    tagline:
      "Don't guess which forecasting method to trust. Backtest all four (naive/drift, SES, Holt, Holt-Winters) on a real series, rank by out-of-sample RMSE, then forecast forward with the winner and its 95% prediction interval. Method selection without the hand-waving.",
    useCase:
      "You need a forecast and you're not sure whether the series is stationary, trending, or seasonal. Instead of picking a method by gut and praying, the bake-off lets the data choose: every method runs the same holdout backtest, the lowest RMSE wins, and you forecast forward with that winner only. Pure-CPU and free over PoW — only the upstream data fetch is paid.",
    promptArgs: [
      {
        name: "series",
        description: "What to forecast — a ticker (AAPL) or a FRED series id (UNRATE, CPIAUCSL)",
        required: true,
        substitute: "AAPL",
      },
      {
        name: "horizon",
        description: "How many periods to project forward — e.g. 30 (days for daily data, months for monthly)",
        required: false,
        substitute: "30",
      },
    ],
    // Ordered as: fetch (equity OR macro) → bake-off (forecast-eval is the
    // ranker, called once per method) → conditional forward forecast with the
    // winner. The four method-specific tools are listed so the agent has the
    // full menu — only one will be called for the forward forecast based on
    // which won the bake-off. Holt-Winters is included for seasonal series
    // (monthly macro, quarterly earnings) where it usually wins outright.
    toolSlugs: [
      "stock-history",
      "fred-series",
      "forecast-eval",
      "forecast-naive",
      "forecast-ses",
      "forecast-holt",
      "forecast-holt-winters",
    ],
    workflow: [
      "Fetch the equity series with stock-history (ticker, range=horizon-scaled — e.g. \"2y\" if you want to forecast ~6 months out). Pull `close` in chronological order; you want at least ~50 observations for the backtest to be meaningful, more if you suspect seasonality.",
      "If the user is asking about a macro indicator instead (unemployment, CPI, fed funds), fetch via fred-series with the series id. Monthly FRED data with 10+ years of history is the sweet spot for Holt-Winters with period=12.",
      "Run the bake-off. Call forecast-eval four times on the same values with testSize ≈ 20% of the series (capped at half): method=\"naive\" or \"drift\", \"ses\", \"holt\", \"holt-winters\" (the last only if you have ≥ 2·period observations and suspect seasonality). Compare RMSE; lowest wins. Watch the `warnings` field — \"insufficient data\" or \"could not detect seasonal period\" means treat that method's score as suspect, not as a clean win/loss.",
      "If forecast-naive (or drift, the mean-reversion variant) won, the series is essentially random-walk and there's nothing to extrapolate — call forecast-naive with the full values + horizon. The point forecast is just the last value (or last + average drift); the interval widens with √h. This is the honest answer for noisy series; don't over-engineer.",
      "If forecast-ses won, the series has no trend but local level matters more than the long-run mean. Call forecast-ses with the full values + horizon; the alpha SES picked tells you how much weight goes on recent vs. older observations (high alpha = react fast, low alpha = smooth heavy). Report alpha alongside the forecast — it's diagnostic.",
      "If forecast-holt won, the series has a persistent trend worth extrapolating. Call forecast-holt with full values + horizon; it returns level + trend smoothing parameters (alpha, beta) and a forecast that walks forward at the fitted trend slope. The 95% interval grows faster than SES because trend uncertainty compounds.",
      "If forecast-holt-winters won, the series has seasonality you should respect (e.g. monthly macro with annual cycle, quarterly retail with year-end peak). Call forecast-holt-winters with the full values + horizon + period (12 for monthly-annual, 4 for quarterly-annual, 7 for daily-weekly) and seasonality=\"additive\" or \"multiplicative\". The forecast carries the seasonal pattern forward; never report the point forecast without the interval — seasonal forecasts look confident but compound multiple sources of error.",
    ],
    claudePrompt:
      "Run a forecasting bake-off on AAPL over the last 2y and project the next 30 trading days using Agent402. (1) Fetch the daily closes via stock-history (ticker=AAPL, range=2y). (2) Run forecast-eval four times on the closes with testSize=100: method=\"drift\", \"ses\", \"holt\", and \"holt-winters\" with period=21 and seasonality=\"multiplicative\" (try the seasonal one — equities usually don't have strong calendar seasonality but the backtest will tell you). (3) Rank by RMSE ascending; the lowest is the winner. Note any `warnings` returned. (4) Call the winning forecast tool (forecast-naive / forecast-ses / forecast-holt / forecast-holt-winters) with the full closes + horizon=30 to get the forward forecast and 95% interval. (5) Return a single JSON object: {rankings: [{method, rmse, mape, warnings}, ...], winner: \"holt\", forecast: {point: [...], lower95: [...], upper95: [...]}, oneLineConclusion}. All bake-off + forecast calls are free over PoW; only stock-history is paid.",
  },
  {
    slug: "document-intel",
    title: "Document intelligence",
    tagline:
      "Turn any PDF or image URL into structured data — metadata, extracted text, sliced page ranges, OCR for scanned docs, decoded barcodes / QR codes — without falling back to a vision LLM guess. Built for the messy 30% of documents where pdf-to-markdown alone returns nothing useful.",
    useCase:
      "An agent gets a PDF link from a webhook (invoice, contract, receipt, regulatory filing) or an image URL (shipping label, scanned form, photographed ticket) and needs to extract structured fields deterministically. content-extraction handles the easy path; document-intel adds metadata inspection, page slicing, OCR fallback for scanned PDFs, embedded barcode / QR decoding, and PDF reassembly for downstream sharing.",
    promptArgs: [
      {
        name: "url",
        description: "PDF or image URL to process (e.g. https://example.com/invoice.pdf)",
        required: true,
        substitute: "https://example.com/invoice.pdf",
      },
    ],
    // Ordered by realistic-agent decision tree: cheapest inspection first
    // (pdf-info), then happy-path text extraction (pdf-to-markdown), then
    // narrowing (pdf-extract-pages), then fallbacks for the failure modes
    // (image-ocr for scans, barcode-decode for the 2D-barcode payload), then
    // reassembly tools (pdf-merge, images-to-pdf). All 7 are paid (egress +
    // CPU-heavy) — they're wallet-only and not free over PoW. Composes
    // pdf-kit + ocr-kit + barcode-kit with the existing pdf-to-markdown.
    toolSlugs: [
      "pdf-info",
      "pdf-to-markdown",
      "pdf-extract-pages",
      "image-ocr",
      "barcode-decode",
      "pdf-merge",
      "images-to-pdf",
    ],
    workflow: [
      "Start with pdf-info — confirms the URL actually serves a PDF (some webhooks lie about content-type), returns the page count for scoping, and surfaces flags like `encrypted` so you don't waste a pdf-to-markdown call that will fail. Skip only if you already know the document's shape.",
      "Run pdf-to-markdown for the happy path. Digital-native PDFs — invoices generated by accounting software, Word/Google-Docs exports, EDGAR filings — come back as clean markdown in one call. This handles ~70% of real-world PDF intake; the next steps are for the other 30%.",
      "If the document is long (>20 pages) and you only need a slice — the signature page on a contract, the line-item table on an invoice, an appendix from a research report — call pdf-extract-pages with the page range first. Then run pdf-to-markdown on the extracted slice. Cheaper, faster, and the smaller payload reduces noise downstream.",
      "If pdf-to-markdown returns <50 characters of text, the PDF is a raster (a scanned document, a photo-of-a-receipt PDF, or a contract that was printed and re-scanned). Fall back to image-ocr — feed it the rendered page image. Tesseract-grade OCR is deterministic and surfaces the text that pdf-to-markdown couldn't.",
      "For invoices, shipping labels, event tickets, and packaging, the high-value structured payload is often encoded in a barcode or QR code rather than visible text. Run barcode-decode on the page image — it returns the raw payload (shipping tracking numbers, EAN/UPC product codes, base64 / JWT ticket payloads). Feed JWT-shaped payloads to the decode-blob pack for further unwrapping.",
      "Use pdf-merge when you've extracted slices from multiple PDFs and want to combine them into a single artifact — building a deal package (term sheet + signature page + appendix), or stitching a multi-vendor invoice export back together for accounting.",
      "Use images-to-pdf when the source material was a set of phone photos (receipts, whiteboard captures, scanned pages handed to you out-of-order) and you need to wrap them into one shareable PDF — either as the final deliverable or as the input to a re-run of this same pipeline at higher quality.",
    ],
    claudePrompt:
      "Process this invoice with Agent402: https://example.com/invoice.pdf. (1) Run pdf-info to confirm it's a PDF, get the page count, check the `encrypted` flag. (2) If not encrypted, call pdf-to-markdown with the URL. (3) Inspect the returned markdown — if it has <50 chars of text, the PDF is scanned: call pdf-extract-pages to get each page as an image, then run image-ocr on each. (4) If you still can't find a tracking number after parsing the OCR text, run barcode-decode on page 1 to surface an embedded QR / barcode payload. (5) Return a single JSON object: {invoiceNumber, totalAmount, vendor, lineItems, trackingNumber, source: \"pdf-to-markdown\" | \"image-ocr\" | \"barcode-decode\"} — populate `source` based on which extraction path actually produced the data. Budget ≤ $0.05 per document; all of these tools are wallet-only (paid per call).",
  },
  {
    slug: "loan-comparison",
    title: "Loan comparison",
    tagline:
      "Compare two or more loan offers — different rates, terms, fees, prepayment structures — on the metrics that actually matter (monthly payment, total interest, year-1 equity build, NPV at your discount rate, effective rate). Apples-to-apples math without opening a spreadsheet.",
    useCase:
      "You're choosing between two mortgage offers, a fixed vs. variable auto loan, a student-loan refinance, or a 15-year vs. 30-year structure. Raw totals lie (you can't compare $300k of 15-year payments to $300k of 30-year payments on total dollars — the 30-year wins on total cost only because you held the money longer). Compare on present-value terms and opportunity cost. All deterministic, all free over PoW.",
    promptArgs: [
      {
        name: "loanA",
        description: "First loan offer (e.g. \"$300,000 at 6.5% for 30 years\")",
        required: true,
        substitute: "$300,000 at 6.5% for 30 years",
      },
      {
        name: "loanB",
        description: "Second loan offer (e.g. \"$300,000 at 6.0% for 15 years\")",
        required: true,
        substitute: "$300,000 at 6.0% for 15 years",
      },
    ],
    // Five tools, one per analytical layer. Ordered cheapest-first: payment
    // alone decides ~60% of comparisons; the deeper layers (amortization,
    // opportunity cost, NPV, IRR) only matter when offers are close or when
    // the loan structures are genuinely different. Composes the finance-math
    // kit shipped in src/tools/finance-math-kit.js.
    toolSlugs: [
      "loan-payment",
      "amortization",
      "compound-interest",
      "npv",
      "irr",
    ],
    workflow: [
      "Call loan-payment on each offer to get the monthly payment, total paid over the term, and total interest. For most plain fixed-rate comparisons (same principal, same term, just different rates), this single comparison settles it — pick the lower payment. Only keep going when the comparison is non-trivial (different terms, points, balloon payments, etc.).",
      "Call amortization on each loan with maxRows=12 (or paymentsPerYear, whichever you'd rather inspect). Report the year-1 ending balance to surface equity-build differences — a 15-year loan pays off ~$13k of principal in year 1 on a $300k mortgage where a 30-year pays off ~$3k. That's the 'why pay more per month?' answer, and it's invisible from the payment number alone.",
      "Compute opportunity cost with compound-interest. Take the per-period payment difference (Loan A monthly minus Loan B monthly) and ask: if I invested the savings instead, what would I have at the end of the term? Use the longer term and your assumed market return (default 7-8% for stocks, 4-5% for bonds). This is the layer that flips most 'obvious' comparisons — a higher-payment 15-year loan often loses to a 30-year + invest-the-difference once you price the opportunity cost honestly.",
      "Run npv on each loan's full cashflow stream using your personal discount rate (default 5%). Build the stream as: [principal, -payment, -payment, ...] over the loan's periods. The loan with the less-negative NPV is cheaper in present-value terms. This is the right comparison metric when the terms differ — comparing raw total-paid on a 15y vs. 30y is dishonest because the dollars in year 30 are worth less than the dollars in year 1.",
      "Use irr only for non-standard structures: loans with discount points (you pay $X upfront for a lower rate), balloon payments (low monthly + a giant final payment), prepayment penalties, or fees rolled into the loan. Build the actual cashflow stream and call irr — that's the all-in effective rate the loan is really costing you, comparable across structures. Plain fixed-rate loans don't need this step; their irr equals their stated rate.",
    ],
    claudePrompt:
      "Compare these two mortgage offers using Agent402: A) $300,000 at 6.5% for 30 years, B) $300,000 at 6.0% for 15 years. (1) Call loan-payment on each — record monthly payment + totalInterest. Expect A ≈ $1896/mo and B ≈ $2531/mo. (2) Call amortization with maxRows=12 on each; report each loan's balance after 12 payments to show equity build (B's year-1 principal paydown should be ~4x A's). (3) Compute opportunity cost: the monthly payment differential is ~$635 (B - A). Call compound-interest with principal=0, but instead approximate by treating the differential as an annuity: take the differential × 12 months × 30 years and run compound-interest on that as if invested at 7%/yr to get the upper-bound forgone investment. (4) Build cashflow streams for npv: A = [300000, -1896, -1896, ... (360 times)], B = [300000, -2531, -2531, ... (180 times)], call npv on each at discountRate=0.05 — compare the (negative) NPVs. (5) Skip irr because both are plain fixed-rate loans with no points / balloon / fees. (6) Return: {a: {monthly, totalInterest, year1Balance, npvAt5pct}, b: {monthly, totalInterest, year1Balance, npvAt5pct}, recommendation: \"A\" | \"B\", reasoning: \"...one sentence explaining which layer was decisive.\"}. All five tools are free over PoW — only pay if you also fetch live rate data via finance-kit.",
  },
  {
    slug: "investment-decision",
    title: "Investment decision",
    tagline:
      "Should we do this project? Run a capital allocation decision (equipment, expansion, acquisition, build-vs-buy) through the textbook CFO workflow: NPV at your hurdle rate, IRR vs. cost of capital, opportunity cost against a passive benchmark, and levered cashflow analysis if the project is debt-financed. Deterministic answers, not a gut call.",
    useCase:
      "You're evaluating a $500,000 equipment purchase returning $150,000/year for 5 years; a market expansion with $2M upfront and an uncertain return; an acquisition target with a forecasted cashflow stream; or a build-vs-buy decision with different upfront costs and operating profiles. Standard capital-budgeting rules say accept if NPV > 0 at your hurdle rate AND IRR > cost of capital — but the inputs (especially hurdle rate and the cashflow forecast) deserve sanity checks, which this pack walks the agent through layer by layer.",
    promptArgs: [
      {
        name: "project",
        description: "What's being evaluated (e.g. \"$500,000 equipment purchase returning $150,000/year for 5 years\")",
        required: true,
        substitute: "$500,000 equipment purchase returning $150,000/year for 5 years",
      },
      {
        name: "hurdleRate",
        description: "Your cost of capital / required return as a decimal (default 0.10 = 10%). Higher for riskier projects.",
        required: false,
        substitute: "0.10",
      },
    ],
    // Five tools, each catching a different way the naive answer is wrong:
    // NPV anchors the accept/reject call at the hurdle rate, IRR surfaces
    // the effective return, compound-interest grounds it against the passive
    // alternative, and the two debt tools (loan-payment + amortization)
    // handle the levered case which usually flips small-NPV projects either
    // way. Composes the finance-math kit (src/tools/finance-math-kit.js).
    toolSlugs: [
      "npv",
      "irr",
      "compound-interest",
      "loan-payment",
      "amortization",
    ],
    workflow: [
      "Build the cashflow stream: index 0 = upfront investment (negative), 1..n = expected annual cashflows (positive), with any salvage/terminal value rolled into the final year. Pass to npv with discountRate = your hurdle rate (typically 8-12% for a small business, 10-15% for VC-backed risk, your weighted average cost of capital if you have one). Positive NPV = the project creates value above your hurdle; negative = it destroys value. This is the primary accept/reject signal.",
      "Call irr on the same cashflow stream. The IRR is the discount rate at which NPV = 0 — i.e., the project's effective annualized return. Accept if IRR > hurdle rate; reject if IRR < hurdle. If the response has converged=false, the cashflow shape has multiple sign changes (common with mid-project re-investments) and NPV is the more reliable metric — flag the IRR as indicative not definitive.",
      "Sanity-check against the passive alternative with compound-interest. Take the same upfront capital, invest at your benchmark rate (7-8% for long-run equity, 4-5% for bonds, your actual savings rate for cash), project forward over the same horizon. If the project's NPV + initial investment doesn't beat the passive future value, the project is destroying value relative to doing nothing — even if NPV at hurdle rate is positive. This catches projects that 'pass NPV' only because the hurdle rate is set unrealistically low.",
      "If the project will be debt-financed (most real-world deals are not all-equity), call loan-payment to compute the periodic debt service. Subtract this from the project's annual operating cashflow to get the levered free cashflow to equity. Then re-run npv and irr on the *levered* stream (index 0 = your equity check, not the full purchase price). Leverage almost always boosts IRR (positive leverage when project yield > debt cost) and increases risk — surface both numbers so the user sees the trade-off.",
      "Call amortization on the financing loan to get the year-by-year interest + principal split. The interest expense is typically tax-deductible — multiply by your tax rate to get the annual tax shield, which improves the levered cashflows. The remaining balance at each year is what you'd owe if you sold/refinanced — useful for modeling an early exit or refinance scenario. Skip if the project is all-equity; required if you want to model the levered IRR honestly.",
    ],
    claudePrompt:
      "Evaluate this capital project using Agent402: $500,000 equipment purchase returning $150,000/year for 5 years with $50,000 salvage value at the end. Use a 10% hurdle rate. (1) Build cashflows = [-500000, 150000, 150000, 150000, 150000, 200000] (year 5 includes salvage). Call npv at discountRate=0.10 — record the NPV. (2) Call irr on the same cashflows — record the IRR (it should be ~17-18% on these numbers; converged should be true). (3) Sanity-check the passive alternative: call compound-interest(principal=500000, annualRate=0.07, years=5, compoundingPerYear=1) — compare the future value of the cashflow scenario (cumulative undiscounted = $750k + $50k = $800k) against the passive S&P 7% future value (~$701k). If the project beats passive even before discounting, that's a real positive signal beyond NPV. (4) Model financing: if a $400k loan at 8% for 5 years funds most of it, call loan-payment(400000, 0.08, 5). Compute the annual debt service (payment × 12); subtract from $150k cashflow → levered cashflow. Build levered stream = [-100000, leveredCF, leveredCF, leveredCF, leveredCF, leveredCF + 50000] and re-run npv + irr on this — the levered IRR will be meaningfully higher than the unlevered, reflecting the equity returns. (5) Call amortization(400000, 0.08, 5, maxRows=5) for the per-year interest schedule (for tax-shield modeling). (6) Return: {unleveredNpv, unleveredIrr, passiveAlternativeFV, leveredNpv, leveredIrr, recommendation: \"ACCEPT\"|\"REJECT\", reasoning}. All five tools are free over PoW.",
  },
  {
    slug: "retirement-planning",
    title: "Retirement planning",
    tagline:
      "Will my retirement plan actually work? Project the accumulation phase forward with compound interest, compute the target nest egg from your expected spending, then model the drawdown phase using the same PMT formula a mortgage uses — your retirement is mathematically a loan you're paying yourself. Deterministic numbers, no glossy advisor PowerPoint.",
    useCase:
      "You're 35 years old with $100,000 saved, contributing $1,500/month, retiring at 65 and you want an honest answer to: will the nest egg get there? How much can I draw down per year without running out? What happens if I retire 5 years earlier — or contribute $500/mo less? The accumulation phase, the target calculation, and the drawdown phase are all the same handful of textbook formulas the finance-math kit already implements; this pack composes them into the full plan.",
    promptArgs: [
      {
        name: "scenario",
        description: "Your retirement scenario (current age, balance, contributions, retirement age, etc.)",
        required: true,
        substitute: "35 years old with $100,000 saved, contributing $1,500/month, retiring at 65",
      },
      {
        name: "expectedReturn",
        description: "Long-run expected annual return as a decimal (default 0.07 = 7% — historical S&P after inflation runs ~6-7%; use 5% for a conservative bond-heavy mix)",
        required: false,
        substitute: "0.07",
      },
    ],
    // Five tools, two phases. Accumulation phase (steps 1-3): project the
    // current balance forward, add the contribution stream's future value,
    // sum for the projected nest egg, then compute the target lump sum from
    // expected spending via NPV in reverse. Drawdown phase (steps 4-5):
    // repurpose loan-payment + amortization to compute sustainable
    // withdrawals and the year-by-year retirement balance — same PMT math,
    // different label on the principal. Composes finance-math-kit.
    toolSlugs: [
      "compound-interest",
      "npv",
      "irr",
      "loan-payment",
      "amortization",
    ],
    workflow: [
      "Project the current balance forward with compound-interest. Pass principal=current_savings, annualRate=expected_return, years=years_to_retirement, compoundingPerYear=12 (or 1 for annual). The future value is what your existing balance grows to if you never add another dollar — the 'do-nothing' baseline. Use the post-inflation return (e.g., 7% nominal - 3% inflation = 4% real) if you want today's-dollars output; use nominal if you'll discount spending in nominal terms later.",
      "Add the contribution stream's future value. The PMT-to-FV identity says a $X/month contribution for N years at rate r compounds to PMT · ((1+r/12)^(12N) - 1) / (r/12). Easiest path: call compound-interest twice — once on a hypothetical $1/month contribution to get the per-dollar multiplier, then scale by actual monthly contribution. Or use a per-period proxy by calling it with principal=annual_contribution, years=N, and approximating. Sum step 1's result + this contribution FV → projected nest egg at retirement.",
      "Compute the target nest egg from expected retirement spending. Build a cashflow stream of negative annual spending over the expected retirement horizon (e.g., 30 years from age 65-95) and call npv with discountRate = expected drawdown return (often lower than accumulation rate — say 4-5% for a bond-heavier retirement allocation). The (negative) NPV's absolute value is the lump sum you need at retirement to fund that spending — your target. Compare against step 2's projected nest egg: if projected > target, you're on track; if projected < target, you have a gap.",
      "Compute the sustainable annual withdrawal using loan-payment. Pass principal=projected_nest_egg, annualRate=drawdown_return, termYears=expected_retirement_years, paymentsPerYear=12. The 'payment' the tool returns IS your sustainable monthly withdrawal — the same PMT formula that amortizes a mortgage amortizes a retirement portfolio. The math doesn't care whether you're paying a bank or paying yourself. This is the 'how much can I spend each month?' answer with no rule-of-thumb (e.g. the 4% rule) hand-waving.",
      "Pressure-test the trajectory with amortization. Same inputs as step 4 (principal=nest egg, etc.). The schedule's `balance` column shows the year-by-year retirement portfolio balance — useful for sequence-of-returns risk (if early returns underperform the average, the trajectory is much steeper than the smooth assumption suggests). The `interest` column is what your portfolio is earning each year; the `principal` column is what you're actually drawing down. A real plan should have a buffer — if the schedule shows balance hitting zero at exactly your assumed end age, one bad year of returns breaks it. Optional: call irr to back-solve the required return given your target and contributions — useful when the user asks 'what return do I need to retire at 60 instead of 65?'",
    ],
    claudePrompt:
      "Build a retirement plan for: 35 years old with $100,000 saved, contributing $1,500/month, retiring at 65, expecting 30 years of retirement, current annual spending of $60,000 (assume 80% replacement = $48,000/yr in retirement). Use Agent402's finance-math kit. (1) Project current $100k forward 30 years at 7%/yr monthly compounding: compound-interest(principal=100000, annualRate=0.07, years=30, compoundingPerYear=12) → expect ~$811k. (2) Project the $1,500/mo contribution stream: easiest is the closed-form PMT-to-FV identity = 1500 · ((1+0.07/12)^360 - 1) / (0.07/12). Compute it (~$1.83M) and add to step 1 → projected nest egg ≈ $2.64M. (3) Target nest egg: build a cashflow stream of [-48000] × 30 (annual retirement spending), call npv at discountRate=0.05 (drawdown-era return) → |NPV| ≈ $738k. Compare projected ($2.64M) vs target ($738k) — comfortably above. (4) Sustainable monthly withdrawal: loan-payment(principal=2640000, annualRate=0.05, termYears=30) → the 'payment' is the monthly draw — expect ~$14,170/mo (~$170k/yr), well above the $48k/yr target. (5) Year-by-year drawdown: amortization(principal=2640000, annualRate=0.05, termYears=30, maxRows=30) — confirm balance trajectory and that final balance is 0. (6) Return: {projectedNestEgg, targetNestEgg, gap, sustainableMonthlyWithdrawal, sustainableAnnualWithdrawal, onTrack: true|false, oneLineConclusion}. All five tools are free over PoW.",
  },
  {
    slug: "savings-goal",
    title: "Savings goal",
    tagline:
      "How much do I need to save each month to hit $X in N years? Pin down the required contribution with a clever PV-discount trick: discount the target back to today, then call loan-payment with the discounted target as principal — the 'payment' the tool returns IS your required monthly savings. Same PMT formula a mortgage uses; different decision.",
    useCase:
      "You have a concrete goal — save $1,000,000 for retirement in 30 years, $500k for a child's college in 18 years, $80k for a down payment in 5 years, $20k for a wedding in 2 years — and want the deterministic answer to: how much per month? What's the gap if I keep saving at my current rate? What return would I need on a fixed contribution? This pack walks the agent through projecting current savings, computing the gap, and back-solving the required PMT — all with the finance-math kit, all free over PoW.",
    promptArgs: [
      {
        name: "goal",
        description: "What you're saving for, with the target amount and time horizon (e.g. \"save $1,000,000 for retirement in 30 years\")",
        required: true,
        substitute: "save $1,000,000 for retirement in 30 years",
      },
      {
        name: "expectedReturn",
        description: "Expected annual return as a decimal (default 0.07 = 7% for long-horizon equity; use 0.04 for bond-heavy or short-horizon goals)",
        required: false,
        substitute: "0.07",
      },
    ],
    // Four tools, one core insight: the PMT formula loan-payment implements
    // solves "save $X to reach $Y" if you discount the target to PV first.
    // The other three tools (compound-interest, npv, irr) handle the baseline
    // projection, the inflation-adjustment, and the back-solved return rate.
    // No amortization here — savings accumulation builds up rather than
    // amortizing down, so the schedule shape doesn't apply.
    toolSlugs: [
      "compound-interest",
      "loan-payment",
      "npv",
      "irr",
    ],
    workflow: [
      "Project the current balance forward with compound-interest. Pass principal=current_savings, annualRate=expected_return, years=time_horizon, compoundingPerYear=12. This is the 'no further contributions' future value — what's already covered. Subtract from the target → the gap that new contributions need to fill.",
      "Solve for the required monthly contribution with the PV-discount trick. The PMT formula loan-payment implements is PMT = PV · r / (1 - (1+r)^-n). The same formula in reverse computes: 'what regular contribution accumulates to a given FV?' To use loan-payment directly, first discount the gap back to present value: PV_of_gap = gap / (1 + r)^n (or use npv with cashflows=[0, ..., gap] to do this). Then call loan-payment(principal=PV_of_gap, annualRate=r, termYears=n, paymentsPerYear=12) — the 'payment' the tool returns IS your required monthly contribution. Same PMT formula, different decision: you're not borrowing, you're paying yourself.",
      "Sanity-check the target in today's dollars with npv. A $1M target in 30 years isn't $1M in spending power — at 3% inflation it's worth ~$412k today. Build a single-cashflow stream [0, ..., target] over the horizon and call npv at discountRate = inflation rate (3% historical, 2.5% recent Fed target). The (positive) NPV is the target in today's-dollars terms. Surface both nominal and real targets to the user — many people set savings targets without realizing they're undershooting because they thought in nominal dollars.",
      "If the user has a fixed contribution and wants to know 'what return do I need?', back-solve with irr. Build the cashflow stream [-current_savings, -annual_contribution, -annual_contribution, ..., +target] over the horizon and call irr. The returned rate is the required annual return to hit the target — compare to historical asset class returns (cash ~2%, bonds ~4%, balanced ~6%, stocks ~7-10%) to ground-truth whether the plan is plausible. If irr > 10% on a long horizon, the plan is aggressive; if irr > 15%, the user should expect to either save more, extend the horizon, or accept higher risk.",
    ],
    claudePrompt:
      "I want to save $1,000,000 for retirement in 30 years. I currently have $50,000 saved. Use Agent402 to compute how much I need to contribute monthly at a 7% expected return, and pressure-test the plan. (1) Project current $50k forward 30 years: compound-interest(principal=50000, annualRate=0.07, years=30, compoundingPerYear=12) — expect ~$406k. Gap = $1,000,000 - $406k = $594k FV still needed. (2) Discount the gap to PV: PV_of_gap = 594000 / (1+0.07/12)^360 ≈ $73,200. Now call loan-payment(principal=73200, annualRate=0.07, termYears=30, paymentsPerYear=12) → the 'payment' is your required monthly contribution. Expect ~$487/mo. (3) Sanity-check the target in today's dollars: build cashflows=[0, 0, ..., 1000000] (index 30 = $1M), call npv at discountRate=0.03 → ~$412k in today's-dollars terms. Surface both. (4) Optional back-solve: if the user can only afford $300/mo, build cashflow=[-50000, -3600, -3600, ..., +1000000] (30 years of $3600/yr contributions) and call irr → required return. If the irr > 10%, the plan is aggressive — recommend lowering the target, extending the horizon, or increasing the contribution. (5) Return: {requiredMonthlyContribution, targetInTodaysDollars, gapAfterCurrentSavings, plausibilityFlag: \"realistic\"|\"aggressive\"|\"unrealistic\", oneLineConclusion}. All four tools are free over PoW.",
  },
  {
    slug: "fraud-signals",
    title: "Fraud signals",
    tagline:
      "Is this domain trustworthy, or is it a phishing site / typosquat / scam? Pull the reputation signals an analyst checks before clicking anything: domain age, cert issuance history, hosting reputation, DNS topology, tech-stack fingerprint, and page-content red flags. Different from a security audit — this is about whether the domain is what it claims to be.",
    useCase:
      "You got a link from email, a webhook, a referral, or a search result and you need to decide whether to trust it before authenticating, paying, or downloading. The security-audit pack tells you whether a domain you own is configured securely; fraud-signals tells you whether a domain you don't own is who it says it is. Newly registered domain + Let's Encrypt cert from yesterday + hosted on a bulletproof ASN + WordPress restaurant theme imitating a bank = the agent should refuse, not click.",
    promptArgs: [
      { name: "domain", description: "Domain to evaluate (e.g. example.com or suspicious-bank-login.com)", required: true, substitute: "example.com" },
    ],
    // Seven tools, ordered by signal strength: whois first (domain age is
    // the single best predictor), then certificate evidence (transparency
    // log + live cert), then hosting reputation (ASN), then DNS topology,
    // then the fingerprintable application layer (tech-stack + page
    // content). Each step is independent — you can short-circuit on any
    // strong red flag — but combining all 7 gives the most confident
    // assessment. Composes network-kit + network-kit2 + extract.
    toolSlugs: [
      "whois",
      "cert-transparency",
      "tls-cert",
      "asn-info",
      "dns-lookup",
      "tech-stack",
      "extract",
    ],
    workflow: [
      "Start with whois — domain age is the single best fraud predictor. Established brands have domains registered years ago; impersonators are usually using domains < 90 days old. Also surfaces the registrar (some — like privacy-shrouded resellers operating out of jurisdictions with slow abuse response — are over-represented in fraud) and registrant info (privacy-protected WHOIS is normal for personal sites, suspicious for a business claiming to be Fortune-500 established).",
      "Pull the cert-transparency log. CT logs every TLS cert ever issued for the domain. A legitimate long-running site shows years of cert renewals from major CAs. A classic phishing pattern is a brand-new domain with exactly one Let's Encrypt cert issued in the last few days — there's no history because there's no history. Burst issuance across many subdomains in a short window can indicate a phishing kit operator.",
      "Inspect the live cert with tls-cert. Self-signed = major red flag, period. Wildcard certs across a sprawling subdomain set on a brand-new domain can indicate a phishing kit operator running many landing pages off one cert. Cert validity window matters too — Let's Encrypt's 90-day cert on a domain claiming to be an established bank is anomalous (real banks use OV/EV certs with longer validity and the green-bar / org-name treatment).",
      "Run asn-info on the resolved IP. Cloudflare / AWS / GCP / Azure are neutral — most of the internet runs there. Known abuse-friendly hosters (specific ASNs in Russia, China, and certain Eastern European countries) over-index on fraud. Geographic mismatch matters: a US-targeted brand impersonator hosted in a country with no business presence there is a meaningful signal. Cross-reference the ASN against public abuse databases if the user wants depth.",
      "Map the DNS topology with dns-lookup. MX records: a site claiming to be a business with no MX records (can't receive email) is a red flag. CNAMEs to shared hosting (Wix / Webflow / Squarespace on a domain impersonating a bank) are common in scams — legitimate financial institutions don't host on shared CMS platforms. Many A records spread across disparate subnets can indicate a fast-flux network rotating IPs to evade takedowns.",
      "Fingerprint the application layer with tech-stack. Off-the-shelf scam templates are detectable: certain WordPress themes ('AI investment platform' kits, 'crypto exchange' kits), specific obfuscated jQuery patterns, telltale Bitrix or older CMS versions. Mismatch between detected tech and the claimed brand is meaningful — a 'bank' running on a WordPress theme designed for restaurants doesn't pass even a casual review.",
      "Pull the page content with extract and scan for fraud-pattern keywords. Phishing kits use predictable language: urgency ('act now', 'limited time'), unsolicited payment requests, crypto-only payment ('USDT only'), dubious testimonials, broken English on a site claiming to be US-headquartered, gift-card payment instructions. Combine all 7 signal sources into a single rollup: low / medium / high fraud likelihood with each piece of cited evidence — let the user see exactly which signals fired, not just a black-box score.",
    ],
    claudePrompt:
      "Evaluate example.com for fraud signals using Agent402. (1) whois — record the domain creation date and the registrar. If age < 90 days, flag as a strong fraud signal. (2) cert-transparency — pull the cert log. Count entries; first issuance date should match (or predate) the whois creation date by at most a few days. (3) tls-cert — inspect the live cert: issuer (Let's Encrypt is fine, self-signed is a hard red flag), validity window, wildcard scope. (4) asn-info — resolve the A record, pull the ASN: is it a mainstream cloud (Cloudflare/AWS/GCP) or a known abuse-friendly hoster? Surface country. (5) dns-lookup — MX records (a 'business' with no MX is suspicious), CNAMEs (shared-hosting CNAMEs on a brand-impersonator site are a red flag). (6) tech-stack — fingerprint the running stack; flag mismatches with the claimed brand (e.g., a 'bank' on a WordPress restaurant theme). (7) extract — pull the home-page text, scan for urgency language, crypto-only payment requests, gift-card mentions, broken English. Return: {domain, age_days, certHistoryCount, hostingProvider, hostingCountry, hasMX, techStack, redFlags: [{signal, evidence}], fraudLikelihood: \"low\"|\"medium\"|\"high\", oneLineRecommendation}. All seven tools are wallet-only (egress) — budget ≤ $0.05 per domain check.",
  },
  {
    slug: "api-investigation",
    title: "API investigation",
    tagline:
      "Point at an unknown API endpoint and figure out how to use it: auth scheme, content type, version, rate limits, OpenAPI/Swagger spec discovery, and JSON response structure. The deterministic recon workflow before writing a single line of integration code.",
    useCase:
      "A developer just got handed an API base URL with minimal docs (\"here's the endpoint, integrate it\"). The pack walks through the recon-before-code workflow: decompose the URL, probe headers for auth + versioning + rate-limit signals, find the human-readable docs page, hunt for an OpenAPI/Swagger link in the docs page, and once a real response is in hand, pretty-print and drill into the JSON structure. Saves the cycle of \"send request → 401 → guess auth header → 415 → guess content-type → ...\" by surfacing it all in one workup.",
    promptArgs: [
      {
        name: "endpoint",
        description: "API URL to investigate (e.g. https://api.example.com/v1/users)",
        required: true,
        substitute: "https://api.example.com/v1/users",
      },
    ],
    // Seven tools, ordered as the real recon-before-code flow: decompose
    // the URL first (cheapest), then live-probe with http-check + http-headers
    // (where auth scheme + content type + rate-limit hints all live), then
    // hunt for human docs (extract) and the machine spec (html-links chasing
    // /openapi.json or /swagger.json), then finally inspect actual response
    // payloads (json-format + json-query). Composes util-kit + html-kit +
    // network-kit2 + extract — no new tools needed.
    toolSlugs: [
      "url-parse",
      "http-check",
      "http-headers",
      "extract",
      "html-links",
      "json-format",
      "json-query",
    ],
    workflow: [
      "Decompose the URL first with url-parse. Surfaces scheme, host, port (default-or-explicit matters for whether you're hitting a non-standard reverse proxy), path, and parsed query parameters. The host alone often tells you whether the API is multi-tenant (api.example.com vs. tenant.example.com vs. example.com/api) which affects how rate limits will work. Cheap, deterministic, and orients the rest of the investigation.",
      "Liveness-probe with http-check. Returns the status code, response time, and (most importantly) confirms whether the host even resolves and answers TCP/443. A 401 here is the friendliest answer — it tells you the endpoint exists and what auth scheme is expected (Bearer, Basic, Digest via the WWW-Authenticate header). A 404 might mean the path is wrong; a 502 / connection refused means you have a different problem (DNS, infra, or simply wrong URL). Don't burn calls on the next steps until http-check returns a 2xx or an authenticated 4xx.",
      "Inspect the full response headers with http-headers — this is where most of the API contract leaks out. Watch for: Content-Type (application/json, application/hal+json, application/vnd.api+json, etc. — each implies a different response convention), WWW-Authenticate (auth scheme + realm), X-RateLimit-* (anticipate quotas before you hit them), X-API-Version / API-Version (call out the version you're actually pinned to), CORS headers (whether browser-side calls will work), and any vendor-prefixed headers (X-Stripe-*, X-GitHub-*, X-Twilio-*) that hint at the platform and unlock platform-specific patterns.",
      "Pull the human-readable docs page with extract. Most APIs publish at a guessable path: api.example.com → docs.example.com, /docs, /api, /reference, /developer. extract returns clean markdown, suitable for skimming. Look for: an authentication section (token format, where to put it), a rate-limit section (quotas + retry behavior), a versioning/changelog section (deprecations), and a base URL section (sometimes the URL the user handed you is not the canonical base).",
      "Hunt for the machine-readable spec by feeding the docs page HTML to html-links. Filter for hrefs matching openapi, swagger, postman, schema, or .json / .yaml suffixes. An OpenAPI spec is gold — it documents every endpoint, every parameter, every response shape deterministically. If found, fetch it (separate call outside this pack) and feed it to json-format / json-query in steps 6-7 to navigate the schema. If not found, fall back to fishing on conventional paths: /openapi.json, /swagger.json, /v1/openapi, /.well-known/openapi.",
      "Once you have an actual JSON response (from the live API or the spec), pretty-print it with json-format. Two-space-indented JSON is much faster to scan than a flat line, especially for nested envelopes (RFC 7807 errors, JSON:API resource objects, HAL _links/_embedded structures). This is the cheapest possible reality check that you've correctly understood the wire format.",
      "Drill into specific fields with json-query — JSONPath ($.data[*].id) is the deterministic way to verify 'does this response actually contain the field I'm going to depend on?' Use it to validate assumptions before writing integration code: confirm the pagination cursor is at $.meta.next_cursor not $.next_page; confirm the array of items is at $.data not $.results; confirm error envelopes are at $.errors[*].detail not $.error.message. Wrong assumption here = the entire integration breaks later when the second-page response shape differs from the first.",
    ],
    claudePrompt:
      "Investigate this API endpoint using Agent402: https://api.example.com/v1/users. (1) url-parse the URL: scheme=https, host=api.example.com, path=/v1/users — flag that this is a versioned, multi-tenant-ish path. (2) http-check it (unauthenticated). Expect a 401 — record the response time and confirm the host resolves. If you get 404 or connection-refused, stop and ask the user for the correct URL. (3) http-headers — record Content-Type, WWW-Authenticate scheme, all X-RateLimit-* values, any X-API-Version header, and any vendor-prefixed (X-*) hints. (4) extract https://docs.example.com (or /docs, /api, /reference — try in that order until one returns a real article body). Skim for auth + rate-limit + versioning sections. (5) feed the docs HTML to html-links and filter for hrefs matching /openapi|swagger|schema|\\.json$|\\.yaml$/. If found, that's the spec URL — note it. If not found, try probing /openapi.json directly via http-check. (6) Once you have any sample JSON response from the API (provided by the user or fetched via http-check on an OPTIONS endpoint), json-format it for easy reading. (7) Use json-query to verify the expected fields are where you think they are: $.data[*].id for resource IDs, $.meta.next_cursor for pagination, $.errors[*] for error envelope. Return: {baseUrl, authScheme, contentType, version, rateLimit: {requests, window}, openApiSpecUrl, sampleResponseStructure: {pagination, dataLocation, errorEnvelope}, integrationNotes}.",
  },
  {
    slug: "text-hygiene",
    title: "Text hygiene",
    tagline:
      "Turn a wall of dirty text — chat logs, scraped pages, user-generated content, log dumps — into something safe to store, search, and pipe into the next step. Measure first, redact PII before anything else touches the data, then dedupe, sort, extract entities, surface keywords, and grade the readability of what's left.",
    useCase:
      "You inherited a text dump (support tickets, exported chat history, scraped reviews, log files) and need to prepare it for analysis or storage. The pack enforces the one ordering that matters: redact PII before any other step caches an intermediate result. Every step after redact is allowed to be sloppy with retention because the secrets are already gone. Output: a cleaned, deduped, sorted stream plus an entity index and a readability score telling you whether the cleaned text is still human-grade.",
    promptArgs: [
      { name: "text", description: "The raw text dump to clean (max 500KB)", required: true, substitute: "support log dump" },
    ],
    // Seven tools, ordered to enforce a single security-relevant invariant:
    // measure → REDACT FIRST → mutate freely. text-stats measures the
    // baseline so you can report what got dropped; redact strips PII before
    // any cache, log, or intermediate result can capture it; dedupe + sort
    // normalize the cleaned stream; extract-entities indexes what survived;
    // keywords gives a routing/tagging signal; readability grades whether
    // the cleaned output is still human-grade. Composes kit (text-stats,
    // keywords) + kit2 (redact, dedupe-lines, sort-lines, extract-entities,
    // readability). All seven tools are pure-CPU and PoW-eligible.
    toolSlugs: [
      "text-stats",
      "redact",
      "dedupe-lines",
      "sort-lines",
      "extract-entities",
      "keywords",
      "readability",
    ],
    workflow: [
      "Measure the baseline with text-stats. Get the raw counts (characters, words, sentences, paragraphs, estimated LLM tokens) before any mutation. This is what you'll compare against at the end to report how much noise was actually removed — 'started at 50k tokens, deduped + cleaned to 12k tokens' is a much better summary than 'cleaned the text'. It also catches the silly case where the input is too small to bother with the rest of the pipeline.",
      "Redact PII with redact — this MUST run before any other step. The redact tool strips emails, phone numbers, credit-card-shaped digits, SSNs, and IPv4 addresses, replacing them with [EMAIL] / [PHONE] / [CARD] / [SSN] / [IP] markers and returning a count by type. Doing this first is the only safe ordering: if you dedupe + sort + extract first, intermediate results have already cached the PII in your logs, retry buffers, and downstream queues. Get the secrets out of the data while you're still inside the pack, not after.",
      "Dedupe-lines on the redacted text. Chat logs and scraped pages are full of exact-duplicate lines (timestamps stripped, boilerplate footers, repeated error messages). Removing them tightens the signal-to-noise ratio without losing anything. Note: dedupe runs after redact deliberately, so two messages that differed only by phone number now collapse to one — a tiny privacy-positive side effect.",
      "Sort-lines to normalize ordering. Once duplicates are gone, sort gives you a stable canonical form — diffable across runs, mergeable across sources, and friendly to downstream chunking. Optional, skip if order is semantically meaningful (timeline data) — but for tickets / reviews / unstructured comments, sort is almost always the right call.",
      "Index entities with extract-entities. Pulls deduped lists of emails, URLs, IPv4s, @mentions, and #hashtags out of what survived redaction. The interesting outputs here are URLs (where users were linking) and mentions/hashtags (who/what users were talking about) — emails and IPs should be mostly empty if redact did its job, and a non-zero count is a useful audit signal that redact missed something (custom email formats, IPv6, weird Unicode).",
      "Surface topics with keywords. Returns top words and two-word phrases by frequency with stopwords removed — cheap, deterministic, no model required. Use the top-N as routing tags (route to the right support queue, the right analyst, the right downstream pipeline) or as a quick gist for human triage. Two-word phrases catch domain language that single-word frequency misses ('refund request', 'login failed', 'card declined').",
      "Grade the cleaned output with readability. Returns Flesch Reading Ease and Flesch–Kincaid grade level. The score tells you whether the cleaned text is still human-grade or whether dedupe + sort destroyed enough context that the result is now incoherent. A grade level that jumped from 9 (high school) to 22 (post-doc) is a sign that sentence boundaries got mangled by sort; a reading-ease that dropped to single digits means the surviving content is dense terminology you should hand to a domain expert. This is the closing audit step.",
    ],
    claudePrompt:
      "Clean this support log dump using Agent402. (1) text-stats on the raw input — record characters / words / sentences / estimatedTokens as the baseline. If words < 100, stop and tell the user the input is too small to be worth running the full pipeline. (2) redact the text. Save the result; also record counts.email / counts.phone / counts.card / counts.ssn / counts.ip — these are the headline 'how much PII did we strip' numbers. From here forward, work only on the redacted text — never reference the raw input again. (3) dedupe-lines on the redacted output. Record before/after line counts. (4) sort-lines on the deduped output — skip this step only if the user said the order matters semantically. (5) extract-entities on the final cleaned text. Surface emails / urls / ipv4 — if emails or ipv4 are non-empty, that's a signal redact missed something (alert the user, don't fail silently). Report URL count and the top 10 by frequency, plus all @mentions and #hashtags. (6) keywords on the cleaned text — return top 15 unigrams and top 10 bigrams as a tagging signal. (7) readability on the cleaned text — return readingEase + gradeLevel. Compare to a reasonable benchmark (gradeLevel between 7 and 14 = normal human prose). Final return: {baseline: {words, tokens}, redactionCounts: {email, phone, card, ssn, ip}, beforeLines, afterLines, residualEntities: {emails, urls, ipv4}, topKeywords, topBigrams, readingEase, gradeLevel, cleanedText, oneLineSummary: 'Started at X tokens, removed Y PII items, deduped to Z lines, grade level G.'}. All seven tools are pure-CPU (PoW-eligible / free tier). Budget ≤ $0.012 even paid.",
  },
  {
    slug: "csv-profile",
    title: "CSV profile",
    tagline:
      "Hand the pack a CSV and get back a column-by-column profile: descriptive stats, outliers, pairwise correlations, and a baseline linear regression. The deterministic 'what's in this dataset?' workup before deciding what to actually model.",
    useCase:
      "You inherited a CSV (export from a data warehouse, a CSV from finance, a survey dump, scraped table from a wiki). Before deciding what's worth analyzing, you need to know: which columns are numeric? what are the ranges? are there outliers that will distort everything downstream? do any two columns move together? would a straight-line fit even be reasonable? This pack runs that workup mechanically — no model required, no judgment calls, just the numbers — so you walk into the actual analysis already knowing the shape of the data.",
    promptArgs: [
      { name: "csv", description: "Raw CSV text (max 500KB; first row is treated as the header)", required: true, substitute: "year,revenue,cost\n2022,1000,800\n2023,1500,1100\n2024,2100,1400" },
      { name: "columnA", description: "Primary numeric column to profile in depth (e.g. revenue)", required: true, substitute: "revenue" },
      { name: "columnB", description: "Second numeric column for correlation + regression (e.g. cost)", required: true, substitute: "cost" },
    ],
    // Six tools, ordered as the standard data-profiling workup: load (csv-to-json
    // gives you rows of objects), extract one column as an array of numbers
    // (json-query with $.[*].columnName), then run the four stats-kit tools
    // in cost-and-information order: descriptive stats first (cheapest, sets
    // the scale), outliers next (decide whether you trust the stats), then
    // pairwise correlation (do any two columns move together?), and finally
    // a baseline linear regression (the simplest model — if this can't fit,
    // nothing will). Composes kit (csv-to-json, json-query) + stats-kit.
    // All six tools are pure-CPU and PoW-eligible.
    toolSlugs: [
      "csv-to-json",
      "json-query",
      "stats-summary",
      "outliers",
      "correlation",
      "linear-regression",
    ],
    workflow: [
      "Load the CSV with csv-to-json. Returns an array of objects keyed by the header row. Inspect the keys to inventory the columns and a small sample of values to spot-check parsing (a stray quote or unescaped comma in the source CSV will surface here as junk fields). If the first row isn't actually headers — some exports use a metadata banner row — fail loudly and ask the user to strip it; don't silently treat data as headers.",
      "Extract one column at a time with json-query. JSONPath $.[*].columnName collapses the row-objects into a flat array of values for that column. Do this once per numeric column you care about. Catch the silent failures here: a column that looks numeric in Excel but is actually strings (because of a stray '$' or thousands separator) will show up as an array of strings — surface that as a parse warning, don't just NaN it downstream.",
      "Run stats-summary on the column array. Twelve descriptive stats in one call: count, sum, mean, median, mode, stddev, variance, min, max, range, q1, q3, IQR. This is the cheapest possible 'know the shape of this column' step. Mean vs. median tells you skew; stddev vs. range tells you whether outliers are dragging the spread; IQR is the robust spread measure to quote when stddev is misleading.",
      "Find anomalies with outliers. Combines IQR-based (1.5×IQR fence) and z-score (>3σ) methods so you catch both heavy-tailed and gross-error outliers. Critical second step: if you skip this and feed an outlier-laden column into correlation or regression, you'll get an apparent strong fit driven entirely by a handful of leverage points. Decide here whether to keep, cap, or drop them — and remember the decision when interpreting steps 5-6.",
      "Check pairwise relationships with correlation. Pearson r on two columns of equal length. r near +1 / -1 = strong linear relationship; r near 0 = no linear relationship (but possibly a non-linear one — Pearson doesn't see U-shapes). r² is the 'fraction of variance explained' — useful for setting expectations on the regression in step 6. A perfect r of 1.0 on real-world data is almost always a sign that the two columns are mechanically the same thing (column B is column A in different units, or column B is computed from column A).",
      "Fit a baseline with linear-regression. Ordinary least squares: y = mx + b, with slope, intercept, and r² returned. Even when you know the real relationship is non-linear, the OLS line is still the right first benchmark — it tells you the dominant linear trend and surfaces the residuals you'd need to model with something fancier. If r² < 0.3, the linear model is genuinely bad and you should reach for a different functional form (log, polynomial, segmented) rather than tweaking it. Composes cleanly with the forecasting-bake-off pack if this column is time-indexed.",
    ],
    claudePrompt:
      "Profile this CSV using Agent402:\nyear,revenue,cost\n2022,1000,800\n2023,1500,1100\n2024,2100,1400\n\nColumns to profile: revenue (primary), cost (for pairwise checks). (1) csv-to-json the input. Confirm parsed row count matches expectations and surface the parsed columns. (2) json-query with $.[*].revenue to get the revenue array; do the same for cost. Confirm both are numeric (no string leakage from currency symbols / thousands separators). (3) stats-summary on the revenue array — report mean, median, stddev, q1/q3/IQR. Same for cost. Note skew (mean vs. median) and spread (IQR). (4) outliers on the revenue array, then on cost. If any are flagged, list them with their row indices and decide: keep, cap at fence, or drop. Use the same decision consistently for the next two steps. (5) correlation with x=revenue, y=cost. Report r and r². Flag if r > 0.99 as 'likely mechanically related, not independent' and warn before treating as a real finding. (6) linear-regression with x=revenue, y=cost. Report slope (cost-per-dollar-of-revenue), intercept, and r². If r² < 0.3, recommend a non-linear functional form in the writeup. Final return: {columns: [...], parsedRows: N, revenue: {summary, outliers}, cost: {summary, outliers}, correlation: {r, rSquared, interpretation}, regression: {slope, intercept, rSquared}, takeaways: [3-5 bullet points], suggestedNextStep}. All six tools are pure-CPU (free tier eligible). Budget ≤ $0.01 even paid.",
  },
  {
    slug: "location-intel",
    title: "Location intel",
    tagline:
      "Point at an address (or even a rough place name) and assemble the situational brief: precise coordinates, the canonical postal address, what's within walking distance, the live weather forecast, active NWS hazard alerts, and recent seismic activity. The deterministic 'what should I know about this place right now?' workup.",
    useCase:
      "A field-ops agent (sales rep about to visit a customer, contractor scoping a job site, traveler arriving in a new city, emergency-response coordinator) hands the pack an address and needs the full pre-arrival brief in one workup. Geocode pins the spot, reverse-geocode confirms the canonical postal form (catches stale addresses where the building number changed), place-search surfaces nearby POIs (gas, coffee, hospital, supplies), weather-forecast covers the next 24-48h conditions, weather-alerts surfaces any active NWS warning (red flag / flood / heat / tornado), and earthquakes filters recent seismic activity in the region. US-centric for hazards/forecast; geocoding works globally.",
    promptArgs: [
      { name: "address", description: "Address or place name (e.g. '1600 Pennsylvania Ave NW Washington DC' or 'Joshua Tree National Park')", required: true, substitute: "1600 Pennsylvania Ave NW Washington DC" },
    ],
    // Six tools, ordered as the standard situational-brief workup: pin
    // (geocode) → verify (reverse-geocode catches typos and stale addresses
    // by round-tripping back to canonical form) → context (place-search for
    // POIs) → conditions (weather-forecast) → hazards (weather-alerts for
    // active warnings, earthquakes for recent seismic activity in the
    // region). geocode/reverse-geocode/place-search work globally (OSM /
    // Nominatim); weather-forecast + weather-alerts are US-only (NWS);
    // earthquakes is global (USGS). Composes geo-kit + data-kit + gov-kit.
    // All six tools touch external egress — wallet-only / not PoW-eligible.
    toolSlugs: [
      "geocode",
      "reverse-geocode",
      "place-search",
      "weather-forecast",
      "weather-alerts",
      "earthquakes",
    ],
    workflow: [
      "Pin the location with geocode. Free-form input ('1600 Penn Ave', 'Joshua Tree', 'Eiffel Tower') resolves to lat/lon + display name + bounding box via OpenStreetMap/Nominatim. The bounding box matters: a query like 'New York' resolves to a city-sized box, whereas '1600 Penn Ave' resolves to a building-sized box. The box size tells you immediately whether the next steps will return city-wide or building-specific results.",
      "Round-trip with reverse-geocode using the lat/lon from step 1. This is the verification step — if you got the wrong place (an obscure 'Springfield' in a different state, a homonym match in another country) the canonical postal address surfaced here won't match what the user expected, and the agent should stop and ask rather than confidently brief on the wrong location. It also returns the structured ISO country code, which gates whether the US-only steps (4 and 5) will work at all.",
      "Pull nearby POIs with place-search around the lat/lon. Useful pre-arrival categories: gas stations, coffee, ATM, hospital, hardware store, supplies. Each result includes distance + bearing, so the agent can render directional context ('coffee 200m N'). For pure tourism arrivals this surfaces sights; for emergency contexts this surfaces critical infrastructure (hospital, police, fire). For sales/customer-visit contexts, surface restaurants near the customer site for the post-meeting lunch suggestion.",
      "Layer current conditions with weather-forecast. US-only (api.weather.gov / NWS) — takes the lat/lon and returns a 7-day forecast in 12-hour blocks. If reverse-geocode in step 2 returned a non-US country code, skip this step and surface in the writeup. Pre-arrival you want the next 24-48h: temp range, precip probability, wind, hazards (ice/snow/heat). For multi-day deployments include the full 7-day window so the team can pack accordingly.",
      "Check for active hazards with weather-alerts using the two-letter US state code from step 2's reverse-geocode result. Active NWS alerts cover everything from severe thunderstorms to red flag (fire-weather) warnings to coastal flood watches. Even if the forecast looks calm, an active alert in the state is critical: 'no rain at this address tomorrow but a red flag warning means an avoidable burn restriction'. Skip with a note if the location isn't in the US.",
      "Survey recent seismic activity with earthquakes (USGS, global). Filter the result list by proximity to the lat/lon from step 1 — recent activity within ~200km matters; a 5.0 across the planet doesn't. For non-seismic regions (most of the Midwest, most of Europe) the result is reassuringly empty. For Pacific Rim regions / California / Japan / New Zealand / Italy the historical baseline isn't zero, so the framing is 'is recent activity within 200km elevated vs. the regional baseline?' Composes nicely with the structured-scrape pack if the user wants to chase a quake into a deeper bulletin.",
    ],
    claudePrompt:
      "Build a location situational brief for: 1600 Pennsylvania Ave NW Washington DC. (1) geocode 'q=1600 Pennsylvania Ave NW Washington DC&limit=1'. Record the lat / lon / display name / bounding-box size. Flag if bounding box is city-sized when the user clearly asked for a specific building. (2) reverse-geocode with the lat/lon from step 1. Confirm the canonical postal address matches what the user asked for. Extract the two-letter US state code (e.g. DC) and the country code (e.g. US) — these gate the next steps. (3) place-search around the lat/lon at a 1km radius. Categorize results into: food (cafes/restaurants), services (gas/ATM/pharmacy), and critical (hospital/police/fire). Top 5 in each category by distance. (4) IF country == US: weather-forecast for lat/lon. Surface next-24h temp range, precip probability, wind, any in-period hazards (NWS sometimes embeds advisory text in the forecast itself). Otherwise note 'weather-forecast US-only, skipped'. (5) IF country == US: weather-alerts for the state code from step 2. List active alerts: event, severity, headline, area, onset/expires. Flag severity in (Severe, Extreme) as a hard 'do not travel' signal. (6) earthquakes for period=week, minMag=2.5. Filter to events within ~200km of the lat/lon from step 1 — use the haversine of (lat,lon) vs each quake's (lat,lon). If the filtered list is non-empty, sort by magnitude desc and report the top 3. If empty for a non-seismic region, report 'baseline quiet'. Final return: {location: {displayName, lat, lon, country, state}, nearby: {food, services, critical}, weather: {next24h, precipProbability, hazards}, activeAlerts: [{event, severity, headline}], seismic: {recentNear, status}, travelRecommendation: 'green'|'yellow'|'red', oneLineBrief}. All six tools touch external APIs (egress) — wallet-only, budget ≤ $0.02 per address.",
  },
  {
    slug: "meeting-scheduler",
    title: "Meeting scheduler",
    tagline:
      "Schedule a meeting across timezones without the round-tripping. Convert a proposed UTC slot into every attendee's local time, verify it lands on a working day for each, project the end time, generate human-readable countdowns, expand recurring rules, and report exactly how far out the slot sits — in one deterministic pass.",
    useCase:
      "A scheduling agent (admin coordinating an exec sync, hiring manager booking an interview panel across three regions, project lead spinning up a weekly standup for a globally distributed team) needs to translate one proposed slot into per-attendee local context. The pack chains the standard scheduling questions: 'what time is it now in their TZ?', 'when is this meeting in their local clock?', 'is that a business day for them?', 'when does it end?', 'how do I phrase the reminder?', 'when does the recurring instance next fire?', and 'how far out is this from now?'. No back-and-forth needed.",
    promptArgs: [
      { name: "proposedTime", description: "Proposed start time in UTC ISO 8601 (e.g. '2026-07-15T14:00:00Z')", required: true, substitute: "2026-07-15T14:00:00Z" },
      { name: "attendeeTzs", description: "Comma-separated IANA timezones (e.g. 'America/New_York, Europe/London, Asia/Tokyo')", required: true, substitute: "America/New_York, Europe/London, Asia/Tokyo" },
      { name: "durationStr", description: "Meeting duration as a duration string (e.g. '1h30m' or '45m')", required: true, substitute: "1h" },
    ],
    // Seven tools, ordered as the natural scheduling-agent workflow: anchor
    // (time gives you 'now' in each attendee's TZ to establish the reference
    // frame), translate (time-convert renders the proposed UTC slot in each
    // attendee local clock), validate (business-days confirms it's a working
    // day per region — Friday in Tel Aviv ≠ Friday in NYC), project
    // (add-time computes the end-time slot), narrate (relative-time turns
    // ISO timestamps into 'in 3 days, 6 hours' for invite reminders),
    // recur (cron-next expands 'every Monday 9am' into the next 5 dates),
    // confirm (date-diff produces the headline 'this meeting is 2d 4h
    // from now' for the calendar invite). All seven tools are pure-CPU
    // and PoW-eligible. Composes kit (time/time-convert/cron-next/duration/
    // date-diff) + kit2 (business-days, relative-time, add-time).
    toolSlugs: [
      "time",
      "time-convert",
      "business-days",
      "add-time",
      "relative-time",
      "cron-next",
      "date-diff",
    ],
    workflow: [
      "Anchor with time — call it once per attendee IANA timezone to establish 'what time is it right now over there?'. This is the reference frame for the rest of the workup. An attendee currently at 23:00 local is going to feel a 'morning' invite differently than one at 09:00. The dayOfWeek field also surfaces the lurking weekend-boundary bug: it's Saturday in Tokyo when it's Friday afternoon in NYC, and a 'Friday 5pm Eastern' meeting silently lands on Saturday for the Tokyo attendee.",
      "Translate the proposed UTC slot with time-convert into every attendee's local timezone. Pass the same UTC ISO timestamp and rotate the tz parameter across attendees. The output gives you {utc, local, timezone} per attendee — render the local time + offset prominently in the invite ('14:00 UTC / 10:00 EDT / 16:00 CEST / 23:00 JST'). This is the single most important translation step; getting it wrong by one DST boundary is the classic scheduling mistake.",
      "Validate working-day with business-days. For each attendee TZ, compute business-days between today and the proposed date. If the count is zero (proposed date is a weekend or public holiday for that region), surface it — the meeting will land outside working hours for that attendee even if the clock-time looks reasonable. Bonus signal: the same call gives you 'this meeting is N business days out', useful for SLA-driven scheduling ('two business days lead time required for this kind of review').",
      "Project the end time with add-time using the meeting duration. add-time on the proposed UTC start + the duration string ('1h30m') returns the ISO end timestamp. Pipe that back through time-convert per attendee to render the local end time — invites that show only the start time are notoriously incomplete for cross-TZ teams who need to know whether the meeting eats their entire lunch or runs into bedtime.",
      "Narrate with relative-time. Takes any ISO timestamp and renders 'in 3 days, 6 hours' or '2 weeks ago'. Use this to generate the natural-language countdown in the invite body and follow-up reminders ('your interview is in 4 hours'). The output is locale-neutral and deterministic — exactly what an agent wants for templated comms rather than a date-fns localized string that varies by runtime environment.",
      "Expand recurrence with cron-next if the meeting is recurring. Pass the cron expression (e.g. '0 14 * * 1' for every Monday 14:00 UTC) and a count of 5 — get back the next 5 ISO instances. Round-trip these through time-convert + business-days to surface 'next 5 Mondays + each attendee's local time + whether any hits a US holiday'. For non-recurring meetings, skip this step.",
      "Confirm with date-diff between now() and the proposed UTC slot — the headline 'this meeting is 2d 4h from now' line that goes at the top of the invite. Also surfaces the absolute difference in every unit (ms / seconds / minutes / hours / days), which is the right shape for downstream reminder scheduling: 'fire a reminder webhook at start - 30m' is much easier when you know the start is at start.epochMillis - 1800000 directly.",
    ],
    claudePrompt:
      "Schedule a cross-TZ meeting using Agent402. Proposed: 2026-07-15T14:00:00Z. Attendees in: America/New_York, Europe/London, Asia/Tokyo. Duration: 1h. (1) time for each of the three attendee timezones. Record current local time + day-of-week per attendee to ground the rest of the workup. (2) time-convert the proposed UTC slot for each tz. Surface {tz, local, offsetVsUTC}. Watch for DST boundaries — Europe/London is +0 or +1 depending on the date, Asia/Tokyo is +9 year-round, America/New_York is -4 or -5. (3) business-days from today to the proposed date in each tz. If the proposed local date lands on a weekend or known public holiday for any attendee region, flag it. (4) add-time the proposed UTC start + duration '1h' → endIso. time-convert endIso per attendee → local end time. Surface 'start–end' per attendee. (5) relative-time the proposed UTC slot from now → render 'in X' string for the invite body. (6) IF the user said this is recurring: cron-next with the user-provided cron expression, count=5. For each instance, run time-convert per attendee and report. Otherwise skip. (7) date-diff between now() and the proposed UTC slot. Use the human-readable result as the invite headline. Final return: {proposedUtc, perAttendee: [{tz, localStart, localEnd, dayOfWeek, businessDayCount, weekendOrHolidayFlag}], reminder: 'starts in 2d 4h', recurrencePreview: [...], oneLineHeader: 'July 15, 14:00 UTC — 1h — 10am EDT / 15:00 BST / 23:00 JST'}. All seven tools are pure-CPU (PoW-eligible / free tier). Budget ≤ $0.01 even paid.",
  },
  {
    slug: "jwt-forensics",
    title: "JWT forensics",
    tagline:
      "Someone hands you a JWT and asks 'is this valid?' Decode without verification first to see the shape, render the time claims (iat/nbf/exp) in human time, compute exactly how long until expiry, then HMAC-verify against the secret. Optional follow-ups: decode any base64-looking custom claims, verify embedded SHA fingerprints.",
    useCase:
      "An SSO/OAuth/API-token debugging session: a developer pasted a JWT into a support thread and asks 'why is the gateway rejecting this?' The pack runs the deterministic workup: decode reveals the alg + claims (you immediately see if the algorithm is HS256/384/512 or something asymmetric the verify step can't handle); time-convert + date-diff render the exp claim as ISO + 'expires in 14 minutes' (the most common gateway-reject reason — token already expired); jwt-verify confirms the HMAC signature against the shared secret. Two optional follow-ups handle the long tail: base64 decodes custom claims that look base64-encoded (common pattern for embedded metadata), and hash verifies any SHA fingerprint claims (common in mTLS pinning + sender-constrained tokens).",
    promptArgs: [
      { name: "token", description: "The JWT to inspect (three dot-separated base64url segments)", required: true, substitute: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudDQwMiIsIm5hbWUiOiJkZW1vIGFnZW50IiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjk5OTk5OTk5OTl9.NqggPBGuLX1OA7YuSlQ4S0INJfCOWnwXWT0XUIUrt3s" },
      { name: "secret", description: "Shared HMAC secret to verify the signature against (only used in step 4)", required: true, substitute: "my-secret" },
    ],
    // Six tools, ordered to match the standard JWT debugging workup: decode
    // BEFORE verify (you need to know the alg before you can decide whether
    // HMAC verify is even applicable — RS256 / ES256 / EdDSA tokens fail
    // jwt-verify by design and you should report 'unsupported alg' instead
    // of 'invalid signature'). time-convert + date-diff make exp/iat/nbf
    // human-readable — 'token expires in 14 minutes' is far more useful
    // than 'exp: 1781172000'. jwt-verify is the conclusive answer for
    // HMAC tokens. base64 + hash are the two long-tail follow-ups that
    // catch the patterns simpler inspectors miss: base64-encoded custom
    // claims (a common embedded-metadata trick) and SHA-fingerprint claims
    // (mTLS pinning, sender-constrained tokens). All six tools are
    // pure-CPU and PoW-eligible. Composes kit (jwt-decode, time-convert,
    // date-diff, base64, hash) + kit2 (jwt-verify).
    toolSlugs: [
      "jwt-decode",
      "time-convert",
      "date-diff",
      "jwt-verify",
      "base64",
      "hash",
    ],
    workflow: [
      "Decode the token with jwt-decode first — no verification, just see the shape. Returns header, payload, signaturePresent, expired (computed from the exp claim against current time), and expiresInSeconds. The header.alg field is the gating signal: HS256/HS384/HS512 means step 4 (HMAC verify) is applicable; RS256/ES256/EdDSA means asymmetric crypto and the verify step won't work with a shared secret — you'd need a JWKS / public key flow instead. The signaturePresent flag catches the classic mistake of pasting just the header.payload without the third segment.",
      "Render the time claims with time-convert. Loop over iat, nbf, and exp from the payload — each is an epoch-seconds integer that time-convert renders as ISO + (optionally) a human timezone. Doing this surfaces three concrete numbers that the user can sanity-check: 'issued at 2026-06-21T14:00:00Z' tells you whether the token came from the issuer you expected; 'not-before at 2026-06-21T14:00:01Z' surfaces clock-skew bugs; 'expires at 2026-06-21T15:00:00Z' is the headline. If the payload has no exp / iat / nbf, surface that — opaque tokens with no time bounds are themselves a security finding.",
      "Compute the headline countdown with date-diff between now() and the exp claim. The human-readable output ('expires in 14 minutes' / 'expired 3 hours ago') is the single most useful sentence in the report. It also reveals two more subtle problems: a token whose exp is years in the future is suspicious (overly long-lived tokens are a common misconfiguration); a token whose iat is in the future indicates a clock-skew issue between the issuer and your server.",
      "Verify the HMAC signature with jwt-verify against the shared secret. Returns {valid, algorithm, expired, payload}. Three outcomes to handle distinctly: (a) valid=true → signature is correct, secret is right, token is authentic; (b) valid=false with reason='Unsupported alg' → the token uses asymmetric crypto and you can't verify it here, surface that and recommend the JWKS flow; (c) valid=false without a reason → either the secret is wrong, the token was tampered with, or the token was signed by a different issuer than the secret you're checking against. The expired field is recomputed here too — re-check it against step 3 for consistency.",
      "Long-tail follow-up: decode any base64-looking custom claims with base64. Some issuers pack metadata into custom claims as base64-encoded JSON or base64-encoded raw bytes (Kubernetes service-account tokens, vendor SDKs, custom RBAC payloads). For each payload key whose value matches /^[A-Za-z0-9+/_-]+={0,2}$/ and is at least 16 characters, try decoding — if the result is valid UTF-8 (especially JSON), surface it. Skip the standard registered claims (iss, sub, aud, exp, iat, nbf, jti) — those are never base64-encoded.",
      "Final long-tail: verify any SHA fingerprint claims with hash. Patterns like cnf.x5t#S256 (RFC 8705 mTLS sender-constrained tokens), cnf.jkt (DPoP proof-of-possession), or vendor 'fingerprint'/'hash' claims encode a SHA-256 of a client certificate or public key. If the user has the underlying material (cert PEM, public key bytes), run hash on it and compare to the claim value — a mismatch means the token was issued for a different client and is being replayed. For standard tokens with no such claims, this step is a no-op.",
    ],
    claudePrompt:
      "Inspect this JWT using Agent402. Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudDQwMiIsIm5hbWUiOiJkZW1vIGFnZW50IiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjk5OTk5OTk5OTl9.NqggPBGuLX1OA7YuSlQ4S0INJfCOWnwXWT0XUIUrt3s. Secret: my-secret. (1) jwt-decode — extract header.alg, payload claims, signaturePresent, and the computed expired flag. If alg is not HS256/HS384/HS512, surface 'asymmetric algorithm, HMAC verify not applicable' and continue with steps 2-3, skip 4. (2) time-convert each of payload.iat, payload.nbf, payload.exp (if present) — render as ISO 8601 UTC. Note any that are missing (especially exp — opaque, never-expiring tokens are a security finding). (3) date-diff between now() and payload.exp. Headline: 'expires in X' or 'expired X ago'. Flag iat in the future as a clock-skew bug. Flag exp > now + 1 year as 'unusually long-lived token, double-check this is intentional'. (4) IF alg is HS256/HS384/HS512: jwt-verify with token + secret. Report {valid, algorithm, expired}. If valid=false, distinguish: 'unsupported alg' / 'signature mismatch (wrong secret or tampered)' / 'malformed'. (5) For each payload key NOT in [iss, sub, aud, exp, iat, nbf, jti]: if the value is a base64-looking string ≥16 chars, run base64 decode. If the decoded result parses as JSON or is valid UTF-8, surface it under 'embeddedClaims'. (6) IF payload contains cnf.x5t#S256, cnf.jkt, or any 'fingerprint'/'hash' claim: prompt the user for the underlying material (cert PEM or public key), run hash with alg=sha256, compare. Report match/mismatch. Final return: {alg, sigValid, expired, expiresIn, claims: {iat, nbf, exp, iss, sub, aud}, embeddedClaims, fingerprintChecks, oneLineVerdict: 'authentic / expired in 14m / wrong-secret / unsupported-alg / opaque-no-exp'}. All six tools are pure-CPU (PoW-eligible / free tier). Budget ≤ $0.01 even paid.",
  },
];

// HTML escape — copied from guides.js/pages.js to keep skills self-contained.
const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Build a quick { slug → toolDef } map from the CATALOG. CATALOG is keyed by
// "METHOD /path", so we have to scan the values.
function indexCatalog(catalog) {
  const ix = new Map();
  for (const def of Object.values(catalog || {})) {
    if (def?.slug) ix.set(def.slug, def);
  }
  return ix;
}

const SKILLS_CSS = `
.skill-grid { display:grid; gap:14px; margin-top:24px; }
.skill-card { display:block; padding:18px 20px; border:1px solid #1e2638; border-radius:12px; background:#0f1420; color:inherit; text-decoration:none; transition:border-color .15s; }
.skill-card:hover { border-color:#4ade80; }
.skill-card h3 { margin:0 0 6px; font-size:1.1rem; color:#e6e9f0; }
.skill-card p { margin:0; color:#8b93a7; font-size:.93rem; line-height:1.55; }
.skill-card .meta { display:block; margin-top:10px; color:#4ade80; font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; }
.tool-list { margin:18px 0 8px; padding:0; list-style:none; }
.tool-list li { padding:14px 16px; border:1px solid #1e2638; border-radius:10px; margin-bottom:10px; background:#0f1420; }
.tool-list .row { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.tool-list .name { font-weight:600; color:#e6e9f0; }
.tool-list .price { color:#4ade80; font-family:ui-monospace,Menlo,monospace; font-size:.85rem; }
.tool-list .route { color:#8b93a7; font-family:ui-monospace,Menlo,monospace; font-size:.8rem; }
.tool-list .desc { display:block; margin-top:6px; color:#8b93a7; font-size:.9rem; line-height:1.55; }
.tool-list .missing { color:#f87171; font-style:italic; }
.workflow { counter-reset: step; margin:18px 0; padding:0; list-style:none; }
.workflow li { position:relative; padding:14px 16px 14px 56px; border-left:2px solid #1e2638; margin-bottom:8px; color:#c5cad8; font-size:.95rem; line-height:1.6; counter-increment: step; }
.workflow li::before { content: counter(step); position:absolute; left:14px; top:14px; width:26px; height:26px; border-radius:50%; background:#1e2638; color:#4ade80; font-family:ui-monospace,Menlo,monospace; font-weight:700; font-size:.85rem; display:flex; align-items:center; justify-content:center; }
.prompt-box { position:relative; margin:14px 0; }
.prompt-box pre { background:#0f1420; border:1px solid #1e2638; border-radius:10px; padding:14px 16px; overflow-x:auto; font-size:.85rem; line-height:1.55; white-space:pre-wrap; color:#e6e9f0; }
`;

function shell(baseUrl, title, description, path, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Agent402</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${baseUrl}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${baseUrl}/card.png">
<meta name="twitter:card" content="summary_large_image">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; }
  body { background:var(--bg); color:var(--fg); font:17px/1.7 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:820px; margin:0 auto; padding:48px 20px 24px; }
  h1 { font-size:1.9rem; line-height:1.25; margin:0 0 8px; }
  h2 { font-size:1.25rem; margin-top:36px; color:var(--accent); }
  a { color:var(--accent); } .muted { color:var(--muted); }
  pre { background:#0f1420; border:1px solid #1e2638; border-radius:10px; padding:14px 16px; overflow-x:auto; font-size:.85rem; line-height:1.55; }
  code { font-family:ui-monospace,Menlo,monospace; }
  p > code, li > code { background:#0f1420; padding:1px 6px; border-radius:6px; font-size:.85em; }
  ${CHROME_CSS}
  ${SKILLS_CSS}
</style>
</head>
<body>${renderHeader(path)}<div class="wrap">${body}</div>${renderFooter()}</body></html>`;
}

export function skillsIndex(baseUrl) {
  const cards = SKILL_PACKS.map(
    (p) => `<a class="skill-card" href="/skills/${p.slug}">
  <h3>${esc(p.title)}</h3>
  <p>${esc(p.tagline)}</p>
  <span class="meta">${p.toolSlugs.length} tools</span>
</a>`
  ).join("\n");
  const body = `<h1>Skill packs</h1>
<p class="muted">Curated, multi-tool workflows for specific jobs — pay per call (USDC on Base) or run free with proof-of-work. Each pack is one paste of context for your agent.</p>
<div class="skill-grid">${cards}</div>
<h2 style="margin-top:48px">Install once, use any pack</h2>
<pre>claude mcp add agent402 -s user -- npx -y agent402-mcp@latest</pre>
<p class="muted">Then ask Claude to run the pack's example prompt — it discovers the tools automatically via the hosted MCP connector.</p>`;
  return shell(
    baseUrl,
    "Skill packs: curated multi-tool workflows for AI agents",
    "Pre-built workflows — security audit, email deliverability, financial research, macro economics, DNS health, crypto research, content extraction. Pay per call in USDC or run free with proof-of-work.",
    "/skills",
    body
  );
}

function renderToolList(pack, ix) {
  return pack.toolSlugs
    .map((slug) => {
      const t = ix.get(slug);
      if (!t) {
        return `<li><span class="row"><span class="name">${esc(slug)}</span> <span class="missing">— tool not currently in catalog</span></span></li>`;
      }
      return `<li>
  <span class="row">
    <span class="name"><a href="/tools/${esc(slug)}">${esc(t.name)}</a></span>
    <span class="price">${esc(t.price)}</span>
    <span class="route">${esc(t.route)}</span>
  </span>
  <span class="desc">${esc(t.description)}</span>
</li>`;
    })
    .join("\n");
}

export function skillPackPage(baseUrl, slug, catalog) {
  const pack = SKILL_PACKS.find((p) => p.slug === slug);
  if (!pack) return null;
  const ix = indexCatalog(catalog);
  const tools = renderToolList(pack, ix);
  const steps = pack.workflow.map((s) => `<li>${esc(s)}</li>`).join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: pack.title,
    description: pack.tagline,
    url: `${baseUrl}/skills/${pack.slug}`,
    step: pack.workflow.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      text: s,
    })),
  };

  const body = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<h1>${esc(pack.title)}</h1>
<p class="muted">${esc(pack.tagline)}</p>

<h2>When to use this pack</h2>
<p>${esc(pack.useCase)}</p>

<h2>Tools in this pack</h2>
<ul class="tool-list">${tools}</ul>

<h2>Workflow</h2>
<ol class="workflow">${steps}</ol>

<h2>Run it in Claude</h2>
<pre>claude mcp add agent402 -s user -- npx -y agent402-mcp@latest</pre>
<p class="muted">Then paste this prompt into Claude:</p>
<div class="prompt-box"><pre>${esc(pack.claudePrompt)}</pre></div>

<p class="muted" style="margin-top:36px"><a href="/skills">← All skill packs</a></p>`;
  return shell(
    baseUrl,
    `${pack.title} — Agent402 skill pack`,
    pack.tagline,
    `/skills/${pack.slug}`,
    body
  );
}

export const skillSlugs = () => SKILL_PACKS.map((p) => p.slug);

// Machine-readable shape served at /api/skill-packs.json — also what the
// stdio agent402-mcp npm package fetches at startup to register its prompts.
// We strip internal-only fields like `substitute` (a render hint) and expose
// the public schema that any MCP client or discovery aggregator needs.
export function skillPacksJson() {
  return {
    packs: SKILL_PACKS.map((p) => ({
      slug: p.slug,
      title: p.title,
      tagline: p.tagline,
      useCase: p.useCase,
      toolSlugs: p.toolSlugs,
      workflow: p.workflow,
      claudePrompt: p.claudePrompt,
      promptArgs: (p.promptArgs || []).map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required ?? true,
      })),
    })),
  };
}

// Build an MCP prompt response for a skill pack — `messages` array + a top-level
// `description`. Two design choices baked in here, both Option-A from the
// trade-off matrix:
//   1. We name the exact tool slug at each step so the agent doesn't have to
//      search the catalog first (deterministic; fewer round-trips).
//   2. We pre-split the tool list into "free here" vs "wallet required" so the
//      agent can short-circuit before getting a 402 — `freeSlugs` is computed
//      per-session in mcp-http.js's buildServer().
// `args` is the MCP-prompt arguments object the client passes (e.g.
// `{ domain: "stripe.com" }`). For each entry in `pack.promptArgs` that
// declares a `substitute` string, we replace literal occurrences of that
// string in the prompt body — keeps the existing example-driven claudePrompt
// reusable as a template without introducing curly-brace placeholders that
// would leak into the HTML render.
export function buildPromptMessages(pack, args = {}, { freeSlugs } = {}) {
  let body = pack.claudePrompt;
  let useCase = pack.useCase;
  for (const a of pack.promptArgs || []) {
    const v = args && args[a.name];
    if (v && a.substitute) {
      body = body.split(a.substitute).join(String(v));
      useCase = useCase.split(a.substitute).join(String(v));
    }
  }

  const freeSet = freeSlugs instanceof Set ? freeSlugs : null;
  const free = [];
  const wallet = [];
  for (const slug of pack.toolSlugs) {
    if (!freeSet) continue;
    (freeSet.has(slug) ? free : wallet).push(slug);
  }

  // Per-step plan: if the workflow narrative and toolSlugs are 1:1, zip them
  // so the agent sees "step N → call this slug". Otherwise (e.g. security-audit
  // has one extra tool covered by a multi-tool step) list them in parallel
  // sections so we don't misalign instructions and tools.
  let plan;
  if (pack.toolSlugs.length === pack.workflow.length) {
    plan = pack.workflow
      .map((w, i) => `${i + 1}. call_tool { slug: "${pack.toolSlugs[i]}" } — ${w}`)
      .join("\n");
  } else {
    plan = [
      "Tools (in order):",
      ...pack.toolSlugs.map((s, i) => `  ${i + 1}. ${s}`),
      "",
      "Workflow:",
      ...pack.workflow.map((w, i) => `  ${i + 1}. ${w}`),
    ].join("\n");
  }

  const accessLines = [];
  if (free.length)
    accessLines.push(`Free on this hosted connector (compute-only, rate-limited): ${free.join(", ")}`);
  if (wallet.length)
    accessLines.push(
      `Wallet required (USDC via x402): ${wallet.join(", ")}. ` +
        `For paid access, use the agent402-mcp npm server with AGENT_KEY set, or call over HTTP with any x402 client.`
    );

  const text = [
    body,
    "",
    "---",
    "",
    `Context — ${pack.title}: ${useCase}`,
    "",
    "Tool plan (call each via the `call_tool` tool on this connector):",
    "",
    plan,
    ...(accessLines.length ? ["", "Access:", ...accessLines] : []),
  ].join("\n");

  return {
    description: `${pack.title}: ${pack.tagline}`,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

// Lexical ranker for skill packs, mirroring the one in find.js so /api/find and
// the MCP search_tools surface can recommend a *workflow* when the agent's query
// matches a multi-tool task (e.g. "audit a domain" → security-audit) instead of
// just returning the best individual tool. Scoring stays modest so packs only
// rank alongside tools when the lexical signal is strong:
//   slug exact match           = 12  (a pack is a richer answer than a single tool)
//   slug substring             =  5
//   title substring            =  3
//   tagline substring          =  2
//   useCase substring          =  1
//   tool slug in pack.toolSlugs =  4 ("check spf" → email-deliverability via spf-check)
//   workflow narrative hit     =  1
const PACK_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "to", "for", "with", "by", "and", "or",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "as", "at",
  "from", "into", "onto", "my", "me", "i", "you", "your", "we", "our",
  "do", "does", "did", "can", "will", "would", "should",
]);

export function rankSkillPacks(query, { k = 2, baseUrl = "", minScore = 4 } = {}) {
  const q = String(query || "").slice(0, 500);
  const rawTerms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const terms = rawTerms.filter((t) => t.length > 1 && !PACK_STOPWORDS.has(t)).slice(0, 32);
  if (!terms.length) return [];

  const scored = [];
  for (const pack of SKILL_PACKS) {
    const slug = pack.slug.toLowerCase();
    const title = (pack.title || "").toLowerCase();
    const tagline = (pack.tagline || "").toLowerCase();
    const useCase = (pack.useCase || "").toLowerCase();
    const toolSet = new Set((pack.toolSlugs || []).map((s) => String(s).toLowerCase()));
    const workflowHay = (pack.workflow || []).join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 12;
      else if (slug.includes(term)) score += 5;
      if (title.includes(term)) score += 3;
      if (tagline.includes(term)) score += 2;
      if (useCase.includes(term)) score += 1;
      if (toolSet.has(term)) score += 4;
      if (workflowHay.includes(term)) score += 1;
    }
    if (score >= minScore) scored.push([score, pack]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].slug.length - b[1].slug.length || a[1].slug.localeCompare(b[1].slug));

  return scored.slice(0, Math.min(Math.max(k, 1), SKILL_PACKS.length)).map(([score, p]) => ({
    slug: p.slug,
    title: p.title,
    tagline: p.tagline,
    toolSlugs: p.toolSlugs,
    score,
    url: baseUrl ? `${baseUrl}/skills/${p.slug}` : `/skills/${p.slug}`,
    promptName: p.slug, // matches the MCP prompts/list name; agents can prompts/get this directly
  }));
}
