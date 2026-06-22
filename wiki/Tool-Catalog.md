# Tool Catalog

**1,234 endpoints + 39 multi-tool [[Skill Packs|Skill-Packs]].** All deterministic — **no LLM in the serving path**: same input, same output, full input/output schemas. Discover them machine-readably (don't hardcode this page):

- [`/api/find?q={task}`](https://agent402.tools/api/find?q=extract%20article) — **resolve a plain-language task to the right tool** (route, price, schema, ready example) in one call, so an agent skips the token-heavy "search to find a tool" step. Also a `find_tool` MCP tool on the connector.
- [`/api/pricing`](https://agent402.tools/api/pricing) — slug, route, price, category, description for everything
- [`/openapi.json`](https://agent402.tools/openapi.json) — OpenAPI 3.1 with schemas
- [`/tools`](https://agent402.tools/tools) — human-readable docs, one page per tool with a working example
- x402 Bazaar discovery extension — every 402 response self-describes

## The headline tools (wallet-only)

These exist because an agent mid-task cannot give itself a browser, a paid search index, or a disk:

| Tool | Price | What it does |
|---|---|---|
| `search` | $0.01 | Live web search over a paid index (Brave) — no signup, the wallet is the credential |
| `answer` | $0.03 | Web answer with inline citations (Brave Answer API) — a one-call "ask the web" the model couldn't reach otherwise |
| `render` | $0.02 | Real headless Chromium, JavaScript executed — reads SPAs that `extract` can't |
| `screenshot` | $0.02 | PNG of any public page (viewport or full-page) |
| `extract` | $0.005 | Main-article extraction → clean markdown (title, byline, word count) |
| `pdf`, `pdf-to-markdown`, `pdf-merge`, `pdf-extract-pages`, `pdf-rotate`, `images-to-pdf`, `pdf-info` | $0.005–$0.01 | Read and manipulate PDFs |
| `audio-convert`, `audio-normalize`, `media-info` | $0.005–$0.02 | Real ffmpeg: transcode to mp3, EBU R128 loudness normalize, probe |
| `memory-*` (10 tools) | $0.002–$0.003 | Durable wallet-keyed state + cross-wallet coordination — see [[Memory and Coordination]] |
| `x402-quote`, `x402-verify`, `usdc-balance`, `tx-status`, `gas-estimate`, `transfer-authorization`, `ens-resolve` | $0.002–$0.004 | **Non-custodial x402 payment toolkit** — decode 402 quotes, verify settlements, read balances/gas/tx, build EIP-3009 authorizations, resolve ENS. Multi-chain: Base, Polygon, Arbitrum, Optimism, Ethereum. See [[Payments and x402]] |
| `meta`, `dns`, `http-check`, `tls-cert`, `whois`, `robots-check`, `sitemap`, `email-validate`, `ip-info` | $0.002–$0.005 | Network truth: metadata, DNS, TLS, liveness |
| `openapi-diff`, `openapi-lint`, `openapi-extract`, `openapi-to-curl`, `openapi-mock-response`, `openapi-search`, `openapi-validate-payload`, `openapi-redact`, `openapi-resolve-refs`, `openapi-security-summary`, `openapi-required-params` | $0.002 | **API-kit** — work an OpenAPI 3.x / Swagger 2.x spec end-to-end: find the right operation, see its effective auth, know the minimum inputs, build a runnable curl, mock a response, validate a payload, diff two versions, score agent-readiness, shrink for LLM context, inline `$ref`s |
| `fx-rate`, `barcode-lookup`, `gov-data`, `weather-forecast`, `weather-alerts`, `earthquakes` | $0.003 | Live keyless data: ECB currency rates, Open Food Facts product lookup, data.gov datasets, NWS weather, USGS quakes |
| `stock-quote`, `stock-history`, `stock-earnings` | $0.005 | **finance-kit** — Yahoo-backed price + history + upcoming/recent earnings for any ticker. Fresh, no API key required |
| `crypto-price`, `crypto-market`, `crypto-history`, `crypto-trending`, `crypto-global` | $0.003–$0.005 | **crypto-kit** — CoinGecko-backed: prices, market data, OHLC history, trending coins, total market cap. Multi-coin in one call |
| FRED yield curve, treasury, fiscal, CPI, unrate, fed funds, Sahm rule, ECB FX, World Bank, FRED bulk release observations | $0.003–$0.01 | **macro-kit** — official macro time-series from the St. Louis Fed (FRED v1 + v2 bulk), Treasury, ECB, World Bank |
| `edgar-company-lookup`, `edgar-filing-list`, `edgar-10k`, `edgar-13f`, `edgar-insider`, `edgar-ipo`, `edgar-fulltext-search`, `edgar-xbrl-frames` | $0.003–$0.01 | **edgar-kit** — SEC EDGAR: ticker→CIK, filings, 10-K/10-Q text, XBRL frames, insider Form 4, 13F holdings, IPO calendar, full-text search |
| `image-resize`, `image-convert`, `image-thumbnail`, `barcode-decode` | $0.003–$0.005 | Pure-CPU image transforms + barcode/QR decode (jimp / zxing) |

## The long tail (pure-CPU, also payable with compute)

~1,105 utilities at mostly **$0.001**: hashing/HMAC, base58/base32/base64, JWT decode+verify, UUIDs, CRC32, morse, HTML entities, `token-count` (exact OpenAI BPE), `text-chunk` (RAG), `json-validate` (JSON Schema), `jsonl`, text stats/dedupe/sort/truncate/diff (Levenshtein), JSON/CSV/YAML conversion and querying, date math and cron calculators, validators (email syntax, IP, IBAN-style checksums…), math/stats, QR codes, and ~970 generated **unit conversions** (`GET /api/convert/{from}-to-{to}?value=N` across length, mass, volume, area, speed, time, data, pressure, energy, power, angle, frequency, temperature).

Why would an agent pay $0.001 instead of writing the code? Because writing, testing, and debugging a CSV parser mid-task burns 10–100× that in tokens — and some sandboxes can't execute code at all.

## Quality guarantees

- Every endpoint is re-tested **against its own documented example** in CI before any deploy reaches production.
- Tools that can't be served honestly get removed rather than left to take money and 502 (this has happened — see [[Operations]]).
- Errors are structured: a specific message naming the invalid field, never a bare 500.
