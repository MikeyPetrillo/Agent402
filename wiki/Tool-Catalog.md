# Tool Catalog

~1,083 endpoints. All deterministic — **no LLM in the serving path**: same input, same output, full input/output schemas. Discover them machine-readably (don't hardcode this page):

- [`/api/pricing`](https://agent402.tools/api/pricing) — slug, route, price, category, description for everything
- [`/openapi.json`](https://agent402.tools/openapi.json) — OpenAPI 3.1 with schemas
- [`/tools`](https://agent402.tools/tools) — human-readable docs, one page per tool with a working example
- x402 Bazaar discovery extension — every 402 response self-describes

## The headline tools (wallet-only)

These exist because an agent mid-task cannot give itself a browser, a paid search index, or a disk:

| Tool | Price | What it does |
|---|---|---|
| `search` | $0.01 | Live web search over a paid index (Brave) — no signup, the wallet is the credential |
| `render` | $0.02 | Real headless Chromium, JavaScript executed — reads SPAs that `extract` can't |
| `screenshot` | $0.02 | PNG of any public page (viewport or full-page) |
| `extract` | $0.005 | Main-article extraction → clean markdown (title, byline, word count) |
| `pdf`, `pdf-to-markdown`, `pdf-merge`, `pdf-extract-pages`, `pdf-rotate`, `images-to-pdf`, `pdf-info` | $0.005–$0.01 | Read and manipulate PDFs |
| `audio-convert`, `audio-normalize`, `media-info` | $0.005–$0.02 | Real ffmpeg: transcode to mp3, EBU R128 loudness normalize, probe |
| `memory-*` (10 tools) | $0.002–$0.003 | Durable wallet-keyed state + cross-wallet coordination — see [[Memory and Coordination]] |
| `meta`, `dns`, `http-check`, `tls-cert`, `whois`, `robots-check`, `sitemap`, `email-validate`, `ip-info` | $0.002–$0.005 | Network truth: metadata, DNS, TLS, liveness |
| `gov-data`, `weather-alerts`, `earthquakes` | $0.003 | US government open data (data.gov CKAN, weather.gov alerts, USGS quakes), keyless |

## The long tail (pure-CPU, also payable with compute)

~1,040 utilities at mostly **$0.001**: hashing/HMAC, base58/base32/base64, JWT decode+verify, UUIDs, CRC32, morse, HTML entities, text stats/dedupe/sort/truncate/diff (Levenshtein), JSON/CSV/YAML conversion and querying, date math and cron calculators, validators (email syntax, IP, IBAN-style checksums…), math/stats, QR codes, and ~970 generated **unit conversions** (`GET /api/convert/{from}-to-{to}?value=N` across length, mass, volume, area, speed, time, data, pressure, energy, power, angle, frequency, temperature).

Why would an agent pay $0.001 instead of writing the code? Because writing, testing, and debugging a CSV parser mid-task burns 10–100× that in tokens — and some sandboxes can't execute code at all.

## Quality guarantees

- Every endpoint is re-tested **against its own documented example** in CI before any deploy reaches production.
- Tools that can't be served honestly get removed rather than left to take money and 502 (this has happened — see [[Operations]]).
- Errors are structured: a specific message naming the invalid field, never a bare 500.
