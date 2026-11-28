// The skill pack pages' own short copy (src/skills.js skillPackPage): a lead
// under the title, a when-to-use line and the workflow steps, for a pack whose
// tagline, useCase or workflow runs past the page's reading budget. The pack's
// full text stays the agent's copy (the MCP prompt, the skill resource and
// /api/skill-packs.json); a field left out here is read from the pack itself.
// Budgets (scripts/test-pack-page-words.js): a lead or a when-to-use line of
// at most 40 words, a step of at most 20.
export const PACK_PAGE_COPY = {
  "fixed-income-desk": {
    lead: "Read the rate environment and price a bond in one workflow: the live Treasury curve, its 2s10s and 3M-10Y spreads, CPI from the U.S. Bureau of Labor Statistics, then bond price and yield.",
    use: "Evaluating a bond or building a rates view: the current curve, the 2s10s spread, inflation context and the price and yield math on one coupon bond, from live Treasury data.",
    steps: [
      "Pull the live Treasury curve, 1M to 30Y, with treasury-yield-curve.",
      "Read the 2s10s and 3M-10Y spreads in basis points, with inversion flags, from yield-curve-spread.",
      "Get year-over-year CPI from cpi-yoy to read the curve in real terms.",
      "Price a coupon bond with bond-price, using the curve's yield for its maturity.",
      "Confirm the yield from a market price with bond-ytm and compare it to the curve.",
    ],
  },
  "market-brief": {
    steps: [
      "Get the coin's live price, 24h change, market cap and volume from crypto-price.",
      "Pull the top trending coins from crypto-trending.",
      "Get total market cap, BTC dominance, 24h volume and active coins from crypto-global.",
    ],
  },
  "crypto-research": {
    steps: [
      "Get the live price, 24h change, volume and market cap from crypto-price.",
      "Pull supply, all-time high and 7d/30d performance from crypto-market.",
      "Read the window's return, volatility and max drawdown from crypto-history.",
      "Check crypto-trending for whether the coin is on the most-searched list.",
      "Pull total market cap, BTC dominance and 24h volume from crypto-global.",
      "Read the last week of headlines for the coin with search-news.",
      "Convert the top two or three articles to clean markdown with extract.",
    ],
  },
  "decode-blob": {
    use: "An opaque string from a log, webhook, cookie or API response, and what is inside it. Every step is pure-CPU and free over proof-of-work.",
    steps: [
      "Read the prefix: \"eyJ\" is a JWT, \"H4sI\" is base64 gzip, even-length hex is hex.",
      "For a JWT, call jwt-decode for the header and payload, without verifying the signature.",
      "For an \"H4sI\" prefix, call gunzip on the base64 string.",
      "If gzip is ruled out and the bytes are still binary, try brotli-decompress.",
      "Otherwise decode with base64; binary output means another layer to peel.",
      "For even-length [0-9a-f] text, decode with hex.",
      "Pretty-print the final JSON with json-format, or verify a digest with hash.",
    ],
  },
  "document-brief": {
    lead: "A PDF's metadata, a model-written summary and a preview of its opening pages: what a document says without reading all of it. document-intel covers format extraction with no summary.",
    use: "An agent has a PDF link (a paper, an earnings report, a contract) and needs the gist before reading further. document-brief answers what the document says.",
    steps: [
      "Run pdf-info for page count, title, author, encryption and size.",
      "Run pdf-summarize for a factual, model-written summary, naming the model that served it.",
      "Run pdf-extract-pages for a preview of the opening pages (default \"1-2\").",
    ],
  },
  "user-onboarding": {
    lead: "Run a signup form through the full onboarding workup: validate the email, score the password, mint an ID, derive a handle, generate a secret, fingerprint with a hash and verify the 2FA code.",
    use: "An account-provisioning agent gets a signup payload and needs every field validated, every identifier minted and a storable record, or a clear reason to reject the signup.",
    steps: [
      "Validate the address with email-validate; reject malformed ones and domains with no mail servers.",
      "Score the password with password-strength and name the specific weakness when it is too weak.",
      "Mint the stable internal ID once with uuid.",
      "Derive a URL-safe handle from the display name with slugify.",
      "Generate a recovery code or API key with password.",
      "Fingerprint values with hash; store passwords with a salted slow hash instead.",
      "Verify the 2FA setup code against the enrollment secret with totp.",
    ],
  },
  "search-and-cite": {
    lead: "One call returns a cited answer to a question (the answer step is model-backed) beside web and news results, then fetches the top citation and extracts its entities.",
    use: "Research where every claim must trace to a page: the answer step drafts with citations, and the fetch and entity steps check what the cited pages actually say.",
    steps: [
      "Get a cited draft answer with answer; treat it as a hypothesis.",
      "Pull the top web results with search and compare them to the citations.",
      "Pull recent coverage with search-news and check the result dates.",
      "Fetch the top two or three citations as clean markdown with extract.",
      "List each article's entities with extract-entities and check the answer's names against them.",
    ],
  },
  "any-to-markdown": {
    lead: "Convert anything at a URL (HTML, PDF or an image) to clean markdown: detect the content type, run the matching extractor, and report word and token counts for the result.",
    use: "An agent has a URL that may be an article, a PDF or a screenshot and needs clean text either way, with a size estimate before feeding a model.",
    steps: [
      "Read the Content-Type with http-headers, and stop early on a 4xx or 5xx.",
      "For HTML, call extract for the article body as markdown.",
      "For a PDF, call pdf-to-markdown; scanned pages need image-ocr.",
      "For an image, call image-ocr for the text with per-word confidence.",
      "Use html-to-markdown for the full page, or when extract returns an empty body.",
      "Count characters, words and estimated tokens with text-stats.",
    ],
  },
  "onchain-analyst": {
    use: "An answer that lives on-chain, such as wallets touching a contract this week. Read-only SQL runs against Base events, transactions and blocks, with the schema in the same response.",
    steps: [
      "Read the tables and columns from onchain-sql-schema.",
      "Write SELECT-only SQL bounded by a time or block range; results cap at 1,000 rows.",
      "Run it with onchain-sql; compare addresses in lowercase.",
      "Refine and rerun; pass cacheSeconds (up to 900) for repeated queries.",
      "Read count, mean, median and quartiles of the first numeric column from stats-summary.",
    ],
  },
  "crypto-dossier": {
    steps: [
      "Get the live price, 24h change, market cap and volume from crypto-price.",
      "Read the 90-day return, volatility and drawdown from crypto-history.",
      "Check crypto-trending for whether the coin is on the most-searched list.",
      "Pull total market cap, BTC dominance and 24h volume from crypto-global.",
      "Search the web for recent news about the coin with search.",
      "Convert the top article to clean markdown with extract.",
    ],
  },
  "wallet-audit": {
    steps: [
      "Get the native and token balances for the address from wallet-balance.",
      "Pull recent activity from wallet-transactions.",
      "Look up a token the wallet holds with token-metadata; no tokens gets a 422.",
    ],
  },
  "url-inspector": {
    use: "Before recommending, embedding or crawling a URL: its parsed parts, whether it is live (status, latency, redirects) and its title, description and OG tags.",
  },
  "macro-snapshot": {
    use: "Economic context in one payment: the fed funds rate, unemployment and CPI, three us-macro-series reads from the New York Fed and the Bureau of Labor Statistics.",
  },
  "tx-forensics": {
    use: "You have a transaction hash and need its story: whether it confirmed, which function it called with what arguments, and who the counterparty is.",
    steps: [
      "Get success, revert or pending, gas used and block from tx-status.",
      "Pull from, to, value and calldata with evm-rpc eth_getTransactionByHash.",
      "Decode the function and typed parameters with calldata-decode.",
      "Match the 4-byte selector against known signatures with selector-lookup.",
      "Label the counterparty with address-label.",
    ],
  },
  "locale-brief": {
    use: "Scheduling across borders: a country's currency and languages, holidays this week, business days left and the current local time.",
    steps: [
      "Get capital, currency, languages, calling code and timezones from country-info.",
      "Pull this year's holidays with public-holidays and note the next seven days.",
      "Count the coming week's working days with business-days.",
      "Convert the current UTC time to local time with timezone-convert.",
    ],
  },
  "number-crunch": {
    use: "A series of numbers and the full statistical picture in one call: center, spread, anomalies and trend direction.",
    steps: [
      "Compute count, mean, median, stddev, quartiles, min and max with stats-summary.",
      "Correlate values with their positions using correlation; r near 1 or -1 means a trend.",
      "Flag anomalous values with outliers, by IQR fence and z-score.",
    ],
  },
  "loan-comparison": {
    use: "Choosing between loan offers or terms (15 vs. 30 years, fixed vs. variable). Compare on present value and opportunity cost, not raw totals. Every step is free over PoW.",
    steps: [
      "Get each offer's payment, total paid and total interest from loan-payment.",
      "Compare year-one balances with amortization to see equity built.",
      "Price investing the payment difference with compound-interest.",
      "Compare each loan's cashflow in present-value terms with npv.",
      "For points, balloons or fees, get the all-in effective rate with irr.",
    ],
  },
  "defi-protocol-scanner": {
    use: "Before allocating to a DeFi protocol or its token: you want its price, market scale, supply and valuation profile, and the latest news without hopping between explorers.",
    steps: [
      "Get the token's live price and 24h move with crypto-price.",
      "Read market cap, volume and rank from crypto-market for scale and liquidity.",
      "Read supply, fully diluted value, all-time high and low from coin-profile.",
      "Search the web for recent news, audits or incidents the data does not yet show.",
    ],
  },
  "macro-economics": {
    steps: [
      "Pull the live Treasury yield curve, 1M to 30Y, with treasury-yield-curve.",
      "Get the 10Y-2Y and 10Y-3M spreads from yield-curve-spread.",
      "Read headline CPI year over year with cpi-yoy.",
      "Read the headline U-3 unemployment rate with unemployment-rate.",
      "Get the effective fed funds rate with fed-funds.",
      "Compute the Sahm rule recession indicator with sahm-rule.",
    ],
  },
  "content-extraction": {
    steps: [
      "Use extract on an article URL for clean markdown, title, byline and word count.",
      "Use meta for OpenGraph card data: title, description, image, canonical.",
      "Convert a PDF at a URL with pdf-to-markdown, or a page range with pdf-extract-pages.",
      "Use render for a page that needs JavaScript; it returns the post-script HTML.",
      "Read the text in an image URL, such as a receipt or screenshot, with image-ocr.",
      "Chain render into extract for client-rendered sites.",
    ],
  },
  "trend-analysis": {
    lead: "Run any numeric time series, such as a US stock's daily closes (venue bars at least 24 hours old, not consolidated) or a US economic indicator, through descriptives, trend, outliers and a forecast with a 95% interval.",
    use: "For a numerical answer to \"is this trending, and what comes next?\": slope, r², outlier dates and a forecast with its interval. Stats and forecast steps are free over PoW.",
    steps: [
      "Fetch the series: stock-history closes (at least 24 hours old, not consolidated) or us-macro-series values.",
      "Run stats-summary for mean, median, spread and quartiles.",
      "Smooth the series with moving-average, comparing SMA and EMA.",
      "Fit linear-regression on the index for slope and r².",
      "Flag anomalies with outliers (IQR) and map them back to dates.",
      "For a comparison, align a benchmark series and run correlation.",
      "Backtest drift, SES and Holt with forecast-eval; the lowest RMSE wins.",
      "Forecast forward with the winner, reporting the point and 95% interval.",
    ],
  },
  "fraud-signals": {
    lead: "Is this domain what it claims to be, or a phishing site, typosquat or scam? Read domain age, certificate history, hosting, DNS, tech stack and page content for red flags.",
    use: "Check a link before signing in, paying or downloading. The security-audit pack checks your own domain; this one checks someone else's.",
    steps: [
      "Read domain age, expiry, DNSSEC and transfer lock with whois.",
      "Read certificate history with cert-transparency; one brand-new cert is a warning.",
      "Inspect the live certificate with tls-cert: self-signed, wildcard and validity window.",
      "Look up the hosting network with asn-info; its registry country is a weak signal only.",
      "Map MX, CNAME and A records with dns-lookup for gaps and fast-flux patterns.",
      "Fingerprint the site with tech-stack and compare it with the claimed brand.",
      "Scan the extract page text for scam language, then roll up low, medium or high.",
    ],
  },
  "trip-planner": {
    lead: "Plan a multi-stop trip: resolve each stop, sum the distances, estimate arrivals, count business days to each and pull the daily forecast at every stop, anywhere in the world.",
    use: "When an itinerary needs distance, timing, business days and weather in one place. Stops are city or town names resolved worldwide, and a single step can be re-run alone.",
    steps: [
      "Resolve each stop to coordinates and timezone with place-lookup; this step is paid.",
      "Sum great-circle distances per leg with geo-distance; label 1.3x as estimated driving distance.",
      "Add driving time plus a buffer per leg with add-time for each arrival.",
      "Count business days to each arrival with business-days and flag weekend arrivals.",
      "Show each arrival in local time with time-convert and flag timezone crossings.",
      "Pull up to 16 days of weather per stop with weather-daily; this step is paid.",
    ],
  },
  "media-pipeline": {
    lead: "Normalize a user upload before storing it: probe the file with media-info, decode any barcodes or QR codes, resize, thumbnail and convert the image, and normalize audio loudness.",
    use: "When a product accepts uploads and every stored file should have predictable dimensions, format and loudness, with any embedded barcode or QR payload already in its metadata.",
    steps: [
      "Probe format, codec, dimensions and orientation with media-info; trust it over the extension.",
      "Decode any barcode or QR payload with barcode-decode; an empty result is fine.",
      "Resize to a 2000px long edge with image-resize, upright and with GPS stripped.",
      "Make a 200x200 cover-crop thumbnail with image-thumbnail.",
      "Convert the image and thumbnail to WebP with image-convert.",
      "For audio, normalize loudness to an EBU R128 target with audio-normalize.",
    ],
  },
  "status-snapshot": {
    lead: "Is this site healthy, reachable and crawlable right now? DNS, HTTP reachability, security headers, TLS expiry and robots policy in one structured status payload.",
    use: "A one-shot answer to \"can I reach this site, and should I?\" before a paid extract, as an uptime alert body, or as the first step of a site audit.",
    steps: [
      "Confirm the host resolves with dns-lookup; fail fast on no answer.",
      "Read status, latency and final URL with http-check; over 3 seconds is a warning.",
      "Score the security headers (HSTS, CSP, nosniff) from http-headers.",
      "Read days remaining and SANs with tls-cert; under 14 days fails.",
      "Check the path is allowed for your agent with robots-check, and collect sitemaps.",
    ],
  },
  "seo-audit": {
    use: "Before launch, after a migration, or on any site: the technical indexability picture, from uptime and TLS to robots rules for search and AI crawlers, sitemap and meta tags.",
    steps: [
      "Read status, latency and redirect chain with http-check.",
      "Check issuer, expiry and chain trust with tls-cert.",
      "Check crawler access with robots-check, including AI crawler user agents.",
      "Read the sitemap's type, URL count and parse errors with sitemap.",
      "Check title, description, canonical and OpenGraph tags with meta.",
      "Look for noindex, cache and charset issues in http-headers, then rank the fixes.",
    ],
  },
  "ipo-watch": {
    steps: [
      "Pull recent IPO and S-1 filings from EDGAR over the last 14 days.",
      "Search the web for recent IPO filings and pricing news.",
      "Pull recent news on pricing dates, debuts and withdrawals with search-news.",
    ],
  },
  "ssl-audit": {
    steps: [
      "Inspect the live TLS certificate: issuer, expiry, SANs, chain validity.",
      "Fetch HTTP response headers: HSTS, CSP and other security headers.",
      "Check CAA DNS records for which CAs may issue certificates for the domain.",
    ],
  },
  "content-grade": {
    use: "When a page needs a content review: extract its clean text, then score topic focus, keyword density and readability. Chain mode runs keywords on the extracted text, not raw HTML.",
    steps: [
      "Pull the readable content as clean markdown with extract.",
      "Find the top terms and their frequency with keywords.",
      "Score Flesch reading ease and grade level with readability-score.",
    ],
  },
  "contact-verify": {
    use: "Before storing or emailing an address: check its syntax, that its domain has mail servers and publishes SPF. Catches malformed addresses, disposable domains and domains with no mail servers.",
    steps: [
      "Check syntax and the domain's MX records with email-validate.",
      "Confirm the domain's MX records with dns-lookup.",
      "Check the domain's SPF record with spf-check.",
    ],
  },
  "entity-enrich": {
    use: "For KYB, lead enrichment or counterparty checks: from a company name, establish that the entity is real, who it legally is and what its web presence looks like.",
    steps: [
      "Resolve the name to a Wikidata entity with wikidata-entity.",
      "Read the legal name, jurisdiction and address from lei-lookup (GLEIF).",
      "Find the SEC EDGAR filer and CIK with edgar-company-lookup.",
      "Read domain age and expiry with whois.",
      "Fingerprint CMS, framework and CDN with tech-stack.",
      "Grab the brand favicon with favicon-grab.",
    ],
  },
  "jwt-toolkit": {
    steps: [
      "Decode the header and claims with jwt-decode, without verifying.",
      "Check the signature with jwt-verify using secret='test'.",
      "Re-issue a fresh token from the claims with jwt-sign.",
    ],
  },
  "json-pipeline": {
    use: "When raw JSON from an API, a webhook or a user must be validated, formatted for reading and converted to CSV for a spreadsheet or data pipeline.",
  },
  "timezone-planner": {
    use: "When coordinating across time zones: convert a time, count business days between dates and preview when a cron schedule fires next.",
  },
  "security-audit": {
    steps: [
      "Enumerate every subdomain a CA has issued a cert for with cert-transparency.",
      "Resolve apex A and CAA records, then up to three subdomains, with dns-lookup.",
      "Check whether the domain can be spoofed in email with spf-check and dmarc-check.",
      "Score security headers on the apex and up to two subdomains with http-headers.",
      "Inspect the live TLS chain, expiry and SANs with tls-cert.",
      "Fingerprint the CMS, framework and CDN with tech-stack to research known CVEs.",
    ],
  },
  "macro-dashboard": {
    use: "Keep a live macro dashboard warm: the same basket of macro, Treasury, crypto and gas reads every refresh, for one call and one payment, every series in one JSON envelope.",
    steps: [
      "Read fed funds (New York Fed EFFR), CPI, unemployment (BLS) and the Sahm Rule.",
      "Read the Treasury curve, 90 days of history, the 10y-2y spread, debt and average rates.",
      "Snapshot crypto: top coins by market cap, trending coins and global market stats.",
      "Read live Base gas with gas-estimate so execution cost rides the same refresh.",
    ],
  },
  "sec-filings-deep-dive": {
    steps: [
      "Resolve the ticker to its stable SEC CIK with edgar-company-lookup.",
      "Pull recent 10-K, 10-Q, 8-K and proxy filings with edgar-filings.",
      "Read every XBRL fact the company has filed, as time series, with edgar-company-facts.",
      "Compare one metric across years, such as us-gaap:Revenues, with edgar-company-concept.",
      "List Form 4 officer and director buys and sells with edgar-insider-trades.",
      "Full-text search the company's filings for any phrase with edgar-search.",
      "Optionally check an institutional manager's 13F position in the company with edgar-13f-holdings.",
    ],
  },
  "forecasting-bake-off": {
    use: "Let the data pick the method: every method runs the same holdout backtest, the lowest RMSE wins and forecasts forward. Pure CPU; only the data fetch is paid.",
    steps: [
      "Fetch up to 250 venue closes, at least 24 hours old and not consolidated, with stock-history.",
      "Or fetch a macro series, such as unemployment or CPI, with us-macro-series.",
      "Backtest naive or drift, SES, Holt and Holt-Winters with forecast-eval; lowest RMSE wins.",
      "If naive or drift won, forecast with forecast-naive; the interval widens with the horizon.",
      "If SES won, forecast with forecast-ses and report the alpha it picked.",
      "If Holt won, forecast the fitted trend with forecast-holt and its 95% interval.",
      "If Holt-Winters won, forecast with forecast-holt-winters and its period, reporting the interval.",
    ],
  },
  "api-investigation": {
    use: "Recon an API before writing code: decompose the URL, read auth, versioning and rate-limit headers, find the docs and any OpenAPI link, then inspect a real JSON response.",
    steps: [
      "Decompose the URL into scheme, host, port, path and query with url-parse.",
      "Probe liveness, status and auth scheme with http-check before going further.",
      "Read content type, auth, rate-limit, version and CORS headers with http-headers.",
      "Pull the human-readable docs page as markdown with extract.",
      "Find OpenAPI, Swagger or schema links in the docs page with html-links.",
      "Pretty-print a real JSON response with json-format.",
      "Confirm the fields your integration depends on with JSONPath via json-query.",
    ],
  },
  "macro-context": {
    lead: "Macro backdrop snapshot: CPI year-over-year, unemployment, fed funds, the Treasury yield curve and spreads, the Sahm Rule and a G10 FX dashboard, each figure with its as-of date and source.",
    use: "Pin the dated macro backdrop a forecast or cashflow model cites, from BLS, Treasury and New York Fed series. It reports published series and makes no forecast.",
    steps: [
      "Pull CPI year-over-year (BLS CPI-U) with cpi-yoy and flag a stale observation.",
      "Pull the BLS unemployment rate and its 6-month change with unemployment-rate.",
      "Pull the New York Fed's daily EFFR and its year-over-year change with fed-funds.",
      "Pull the daily Treasury curve, 1M to 30Y, with treasury-yield-curve.",
      "Read 10Y-2Y and 10Y-3M spreads with their inversion flags from yield-curve-spread.",
      "Compute the Sahm Rule with sahm-rule, with its as-of date.",
      "Read USD against the G10 currencies and year-to-date change with fx-dashboard.",
    ],
  },
  "schema-evolution": {
    lead: "Compare two OpenAPI snapshots in one call: structural diff, lint score, endpoint list, required params, an empty body checked against the first endpoint, and a security summary.",
    use: "Find out what changed upstream before traffic breaks: renamed fields, tightened enums, new required parameters, moved endpoints or security scheme changes between yesterday's and today's spec.",
    steps: [
      "Diff the old and new specs structurally with openapi-diff; bucket breaking versus additive.",
      "Score the new spec for agent-readiness regressions with openapi-lint.",
      "List every path, method and operationId in the new spec with openapi-extract.",
      "Read required parameters per endpoint with openapi-required-params.",
      "Check a request body against the new schema with openapi-validate-payload.",
      "Summarize security schemes and flag auth changes with openapi-security-summary.",
    ],
  },
  "weather-brief": {
    use: "One weather picture for a location: current conditions, the daily outlook and air quality together, for trip checks, severe-weather warnings or outdoor work safety.",
    steps: [
      "Read temperature, wind, humidity and conditions now with weather-current; flag severe weather.",
      "Read the daily outlook with weather-daily; flag heavy rain or strong gusts.",
      "Read PM2.5, PM10, ozone and the US AQI category with weather-air-quality.",
    ],
  },
  "cheapest-rail": {
    use: "Pick the chain and the moment for real onchain work: compare gas across chains, read the winner's tiers, estimate your transaction and convert to dollars. x402 payments themselves are gasless.",
    steps: [
      "Compare current gas on Ethereum, Base, Arbitrum, Optimism and Polygon with l2-gas-comparison.",
      "Read slow, standard and fast tiers on the cheapest chain with gas-snapshot.",
      "Estimate gas units for your transaction type on that chain with gas-estimate.",
      "Convert the cost to dollars with the ETH price from crypto-price.",
      "Report the cheapest chain, its tiers, the dollar cost and whether to act now.",
    ],
  },
  "inflation-check": {
    steps: [
      "Pull CPI year-over-year for the headline inflation read.",
      "Get the effective fed funds rate for the current policy stance.",
      "Pull the unemployment rate (U-3).",
      "Compute the Sahm Rule: 3-month unemployment average 0.5pp above its 12-month low.",
    ],
  },
  "article-digest": {
    use: "A fast overview of a topic: the top five web results plus a cited answer, for research briefs, meeting prep or seeding a longer document.",
    steps: [
      "Get the top five web results for the topic with search.",
      "Get a cited answer with answer and check it against the results.",
      "Surface recent developments the general index may lag on with search-news.",
    ],
  },
  "api-health": {
    use: "Check an API before production calls: reachability and latency, rate-limit, auth and CORS headers, and a valid TLS cert that is not expiring soon.",
    steps: [
      "Check status code, response time and redirects with http-check.",
      "Inspect rate-limit, auth, CORS and cache headers with http-headers.",
      "Check the host's certificate validity, issuer, expiry and chain with tls-cert.",
    ],
  },
  "domain-age": {
    use: "Basic legitimacy checks for a website: registration age, whether it resolves, and a valid TLS cert. For fraud checks, link safety and vendor due diligence.",
    steps: [
      "Read the domain's age, expiry, DNSSEC and transfer lock with whois.",
      "Confirm the domain resolves to an IP address with dns-lookup.",
      "Check the certificate issuer, validity period and chain with tls-cert.",
    ],
  },
  "feed-watch": {
    steps: [
      "Parse the latest items' titles, links, dates and summaries with feed-parse.",
      "Read the top item's linked page in full with extract.",
      "Run keywords over titles and summaries to see what the cycle is about.",
      "Diff against your previous snapshot with text-diff to find new items.",
    ],
  },
  "text-analyze": {
    use: "Size up a text: words, sentences and paragraphs, its key topics, and how many LLM tokens it uses. For content pipelines, RAG prep and prompt budgets.",
  },
  "openapi-audit": {
    use: "A quick quality check on an OpenAPI spec URL: lint warnings, required-field validation of a sample payload and its auth posture, before publishing or generating SDKs.",
    steps: [
      "Read lint warnings and errors for the spec with openapi-lint.",
      "Validate an empty payload to surface required fields with openapi-validate-payload.",
      "Map declared security schemes and unprotected operations with openapi-security-summary.",
    ],
  },
  "webhook-intake": {
    lead: "The accept-or-reject gate for an incoming webhook in one call: signature check, body schema check, a raw-bytes fingerprint for redelivery dedup, event time in UTC and epoch, and PII redaction. Pure CPU.",
    use: "Run it on every incoming webhook: reject an invalid signature first, then validate the body, fingerprint it for dedup, normalize its time and redact PII before logging.",
    steps: [
      "Verify the provider signature over the raw body with webhook-verify; reject when invalid.",
      "Check the trusted body against a provider envelope schema with json-validate.",
      "Fingerprint the raw bytes with hash (sha256) as the redelivery dedup key.",
      "Normalize the event timestamp to UTC ISO and epoch with time-convert.",
      "Redact emails, IPs, phone numbers and card fragments with redact before logging.",
    ],
  },
  "email-deliverability": {
    lead: "One chained call runs each mail check as its own step and returns each output: SPF, DMARC, DKIM key strength, a 0-100 score, a postmaster address check and the mail servers.",
    steps: [
      "Parse the SPF record with spf-check: over 10 lookups, +all and syntax errors.",
      "Read the DMARC policy with dmarc-check; p=none means receivers ignore failures.",
      "Probe 14 common DKIM selectors with dkim-lookup; warn on weak keys and testing mode.",
      "Score SPF, DMARC, DKIM and MX together, 0 to 100, with email-deliverability.",
      "Confirm one recipient address's syntax and its domain's MX records with email-validate.",
      "Read the MX records with dns-lookup type=MX against the sending setup.",
    ],
  },
  "dns-network-ops": {
    steps: [
      "Resolve A, AAAA, MX, TXT, NS and CAA records on the apex with dns-lookup.",
      "Ask several public resolvers for the same record with dns-propagation; divergence means a stale cache.",
      "Look up the ASN and prefix behind the apex with asn-info.",
      "Pull registration age, expiry, DNSSEC and transfer lock with whois.",
      "Read status, response time and final URL after redirects with http-check.",
      "Confirm robots.txt does not disallow the whole site with robots-check.",
    ],
  },
  "structured-scrape": {
    use: "Pulling a price, a stats table, a roster or a link list from a page that has the data but no public API, with a repeatable answer.",
    steps: [
      "For prose pages, try extract first: clean markdown in one call.",
      "For script-built pages, fall back to render for the post-JavaScript HTML.",
      "Pull specific elements with html-select and a CSS selector; use attr for attribute values.",
      "Turn a table into header-keyed JSON rows or CSV with html-table.",
      "Get plain text from one subtree with html-strip and a selector.",
      "List outlinks, resolved and deduped, with html-links; filter by regex.",
      "Read title, description, OpenGraph, canonical and JSON-LD from HTML with html-meta.",
    ],
  },
  "document-intel": {
    lead: "Turn a PDF or image URL into structured data: metadata, text, page slices, OCR for scanned documents and decoded barcodes or QR codes, for documents where pdf-to-markdown alone returns nothing useful.",
    use: "A PDF link (invoice, contract, receipt, filing) or an image URL (label, scanned form, ticket) needs structured fields, including scanned pages, barcodes and reassembled PDFs.",
    steps: [
      "Confirm the URL serves a PDF, and read page count and encryption, with pdf-info.",
      "Convert digital-native PDFs to markdown with pdf-to-markdown.",
      "For a long document, slice the pages you need with pdf-extract-pages first.",
      "If pdf-to-markdown returns almost no text, OCR the page image with image-ocr.",
      "Decode barcodes and QR codes on the page image with barcode-decode.",
      "Combine extracted slices from several PDFs into one with pdf-merge.",
      "Wrap a set of photos or scans into one shareable PDF with images-to-pdf.",
    ],
  },
  "location-intel": {
    lead: "One call turns a place name into a brief: coordinates, country, region and timezone, the US county and state, a three-day forecast, active US hazard alerts and the past week's earthquakes.",
    use: "A field visit, job site or trip needs a pre-arrival brief from a city or region name. Street addresses are not resolved; county and alert steps are US only.",
    steps: [
      "Pin the place with place-lookup: coordinates, country, region and timezone; confirm the match.",
      "For a US place, add county and state code with geo-lookup.",
      "Read daily high, low, precipitation, wind and UV for the coordinates with weather-daily.",
      "Check active NWS alerts for the US state with weather-alerts.",
      "List recent USGS earthquakes with earthquakes and keep those within about 200 km.",
    ],
  },
  "regulatory-watch": {
    lead: "One call searches recent SEC filings for a theme, then pulls the top match's filings and insider trades, a reference institutional holdings report and recent S-1 IPO registrations.",
    use: "Watching a theme across companies rather than one company in depth: material-event filings, insider transactions, institutional holdings and new IPO registrations, all from SEC EDGAR.",
    steps: [
      "Seed the watch list with edgar-search full-text search for a theme.",
      "Pull each match's recent filings with edgar-filings; flag 8-Ks from the last 7 days.",
      "Read Form 4 buys and sells by officers and directors with edgar-insider-trades.",
      "Read the latest quarterly 13F holdings changes with edgar-13f-holdings; they describe the prior quarter.",
      "List recent S-1 registrations with edgar-recent-ipos and note theme matches.",
    ],
  },
  "link-preview": {
    lead: "Turn a URL into a card preview: OpenGraph and Twitter card metadata, an article-body description fallback, a 1200x630 card image, a 400x400 thumbnail and the body's links and mentions.",
    use: "A bot, chat client or CMS is handed a URL and needs a rich link preview in one card-ready JSON payload, with a normalized image and thumbnail.",
    steps: [
      "Read title, description, image, canonical URL and favicon with meta.",
      "Get the readable body as markdown with extract, the description fallback.",
      "Resize the card image to 1200x630 with image-resize.",
      "Make a 400x400 square thumbnail with image-thumbnail.",
      "Pull URLs, mentions and hashtags from the body with extract-entities.",
    ],
  },
  "wallet-readiness": {
    use: "Before a paid session or batch job: does the wallet hold USDC where it pays, what is gas doing, and where can a human top it up by card?",
    steps: [
      "Read the wallet's USDC on Base with wallet-balances: its x402 spending power.",
      "If it also pays on Solana, call wallet-balances with network solana.",
      "Read slow, standard and fast gas on Base with gas-snapshot.",
      "If USDC is below budget, mint a hosted top-up URL with onramp-link.",
      "Report ready against the budget the caller stated, with balances, gas and link.",
    ],
  },
  "domain-intel": {
    steps: [
      "Pull registration age, expiry, DNSSEC and transfer lock with whois.",
      "Resolve A records with dns-lookup to identify hosting and CDN fronting.",
      "Inspect the live certificate's issuer, expiry, SANs and chain with tls-cert.",
      "Read security, caching and server headers with http-headers.",
      "Fingerprint CMS, framework, CDN and analytics with tech-stack.",
      "Read crawl directives in robots.txt with robots-check.",
    ],
  },
  "fx-monitor": {
    steps: [
      "Pull EUR/USD, GBP/USD and JPY/USD spot rates with fx-rate.",
      "Get the wider view of currency moves with fx-dashboard.",
      "Pull the recent EUR/USD series with fx-historical to read spot against its trend.",
    ],
  },
  "pdf-pipeline": {
    use: "A PDF URL needs a quick read: page count and metadata, the full text as markdown, and page 1, in one payment instead of three.",
  },
  "world-data": {
    use: "Basic economic context for a country: GDP, population, and GDP per capita derived from the two, plus annual inflation.",
    steps: [
      "Get GDP in current USD with world-bank-indicator NY.GDP.MKTP.CD.",
      "Get total population with world-bank-indicator SP.POP.TOTL.",
      "Get annual consumer-price inflation with world-bank-indicator FP.CPI.TOTL.ZG.",
    ],
  },
  "contract-audit": {
    use: "Before approving, transferring to or calling an unfamiliar contract: scan its verified source, check its address label and simulate the call before anything is signed.",
    steps: [
      "Fetch verified Solidity source with contract-source; an unverified contract is a finding.",
      "Scan the source for heuristic findings such as tx.origin and delegatecall with solidity-scan.",
      "Resolve the calldata's 4-byte selector with selector-lookup.",
      "Check the address against known labels with address-label.",
      "Dry-run the call, read-only, with tx-simulate to see success or revert.",
    ],
  },
  "subtitle-pipeline": {
    steps: [
      "Transcribe the audio with transcribe, with language detection and duration.",
      "Turn the transcript into SRT, WebVTT, text or JSON cues with srt-convert.",
      "Read word count, sentences and reading time with text-stats.",
    ],
  },
  "schema-guard": {
    use: "Before trusting a third-party or agent payload: does it still match the agreed schema, and which fields drifted if not?",
    steps: [
      "Validate the payload against the expected schema with json-validate.",
      "Infer the schema the payload implies with json-schema-infer.",
      "Diff expected against inferred with json-diff: added, changed and dropped fields.",
      "Pretty-print a canonical copy with json-format.",
    ],
  },
  "text-hygiene": {
    lead: "Clean dirty text such as chat logs, scraped pages or log dumps: measure, redact matched PII first, then dedupe, sort, extract entities, find keywords and grade readability.",
    use: "Preparing a text dump for analysis or storage. Redaction runs before any other step, so no later step sees the emails, phone numbers, card numbers, SSNs and IPv4 addresses it matched.",
    steps: [
      "Measure characters, words, sentences and tokens with text-stats.",
      "Redact emails, phones, card numbers, SSNs and IPv4s with redact, before anything else.",
      "Remove duplicate lines with dedupe-lines.",
      "Sort lines into a stable order with sort-lines; skip for timelines.",
      "Index URLs, mentions and hashtags with extract-entities.",
      "Find top words and two-word phrases with keywords.",
      "Grade the cleaned text with readability: Flesch Reading Ease and grade level.",
    ],
  },
  "markdown-convert": {
    use: "Markdown needs HTML output for email, a CMS or rendering, with a round-trip check of what survives the conversion.",
    steps: [
      "Convert markdown to semantic HTML with markdown-to-html.",
      "Convert the HTML back to markdown with html-to-markdown.",
      "Diff original against round-trip with text-diff; an empty diff means lossless.",
    ],
  },
};

// The same, for a pack as it is listed without its stock step (WITHOUT_STOCK_COPY
// in src/skills.js): read for each field that copy replaces.
export const PACK_PAGE_COPY_WITHOUT_STOCK = {
  "earnings-deep-dive": {
    steps: [
      "Read the filing history from edgar-filings for the reporting window.",
      "Pull revenue, margins, EPS and cash flow from company-financials.",
      "List recent filings with edgar-filings to catch any 8-K, guidance or S-1.",
      "Search the web for analyst expectations and recent news with search.",
    ],
  },
  "company-dossier": {
    steps: [
      "Pull revenue, income, assets, liabilities, equity, EPS and cash flow from company-financials.",
      "List the 5 most recent SEC filings with edgar-filings.",
      "Read Form 4 insider trades from the last 90 days with edgar-insider-trades.",
      "Search the web for recent company news with search.",
    ],
  },
  "financial-research": {
    steps: [
      "List recent 10-K, 10-Q and 8-K filings with edgar-filings.",
      "Pull XBRL revenue, net income, assets and shares from edgar-company-facts.",
      "Check Form 4 filings from the last 90 days with edgar-insider-trades.",
      "Add CPI, fed funds and unemployment from us-macro-series.",
    ],
  },
  "earnings-watch": {
    steps: [
      "Read the newest SEC filings from edgar-filings; an earnings report arrives as an 8-K.",
      "Search the web for recent earnings coverage and analyst expectations.",
      "Compare what the filing reports with what coverage expected.",
    ],
  },
  "trend-analysis": {
    lead: "Run a US economic series, such as unemployment, CPI or fed funds, through descriptives, moving averages, a trend line, outliers, optional correlation and a forecast with a 95% interval.",
    use: "Answer \"is unemployment trending up?\" with slope, r², outlier dates and a forecast interval. Stats and forecast steps are pure CPU; only the macro read is paid.",
    steps: [
      "Fetch the series values by id, such as UNRATE, with us-macro-series.",
      "Read mean, median, spread and quartiles with stats-summary.",
      "Compare simple and exponential moving averages with moving-average.",
      "Fit a trend line and read its slope and r² with linear-regression.",
      "Flag anomalies with IQR fences via outliers and map them back to dates.",
      "Optionally correlate against a benchmark series with correlation.",
      "Backtest drift, SES and Holt with forecast-eval; the lowest RMSE wins.",
      "Forecast with the winning method and report its 95% interval.",
    ],
  },
  "insider-alert": {
    steps: [
      "Pull Form 4 insider trades from the last 30 days with edgar-insider-trades.",
      "List the 3 most recent SEC filings with edgar-filings.",
      "Flag clusters of insiders filing the same direction and filings that follow a disclosure.",
    ],
  },
  "forecasting-bake-off": {
    use: "Let the data pick the forecast method: every method runs the same holdout backtest and the lowest RMSE wins. Free over PoW; only the data fetch is paid.",
    steps: [
      "Fetch the series with us-macro-series by series id.",
      "Backtest drift, ses, holt and holt-winters with forecast-eval; lowest RMSE wins.",
      "If naive or drift won, forecast with forecast-naive.",
      "If ses won, forecast with forecast-ses and report alpha.",
      "If holt won, forecast the trend with forecast-holt.",
      "If holt-winters won, forecast with forecast-holt-winters and its period.",
    ],
  },
};
