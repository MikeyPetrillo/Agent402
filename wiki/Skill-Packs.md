# Skill Packs

**39 curated multi-tool workflows.** Each pack solves a real job that no single tool covers — auditing a domain, working up a time series, decoding an opaque blob, pulling the macro backdrop — and ships as a single MCP **prompt**. An agent calls `prompts/get { name: "<pack>", arguments: { … } }` and gets back a ready-to-run plan with the right Agent402 tools wired in (in the right order, with the right inputs).

- **Browse on the live site:** [`agent402.tools/skills`](https://agent402.tools/skills) (full templates, arguments, examples)
- **MCP discovery:** every MCP-aware client picks them up via `prompts/list` → `prompts/get`
- **Find-by-task:** [`/api/find?q=<task>`](https://agent402.tools/api/find?q=audit+a+domain) also recommends a matching pack alongside individual tools, so a task-shaped query points at the workflow, not just the raw tools.

## How to call a pack

```jsonc
// MCP (any MCP-aware client — Claude Desktop, Cline, etc.)
prompts/get { "name": "security-audit", "arguments": { "domain": "stripe.com" } }

// HTTP (plain GET — no wallet needed to render a template)
GET https://agent402.tools/skills/security-audit?domain=stripe.com
```

The template is the **plan** — the agent then executes each step. Payment (USDC via x402 or free proof-of-work) only happens when the agent actually calls each tool.

---

## Security & trust (4)

| Pack | What it solves |
|---|---|
| [**security-audit**](https://agent402.tools/skills/security-audit) | Enumerate a domain's external attack surface in one workflow: certs, DNS posture, email auth, HTTP headers, tech stack. |
| [**email-deliverability**](https://agent402.tools/skills/email-deliverability) | Diagnose why a domain's email lands in spam: SPF posture, DMARC policy, DKIM key strength, MX. |
| [**fraud-signals**](https://agent402.tools/skills/fraud-signals) | Is this domain trustworthy, or is it a phishing site / typosquat / scam? Pull the reputation signals. |
| [**jwt-forensics**](https://agent402.tools/skills/jwt-forensics) | Someone hands you a JWT and asks "is this valid?" Decode, check expiry, verify the signature. |

## Web extraction & document intelligence (5)

| Pack | What it solves |
|---|---|
| [**content-extraction**](https://agent402.tools/skills/content-extraction) | Turn arbitrary URLs and PDFs into clean structured text — articles, page metadata, PDF pages. |
| [**structured-scrape**](https://agent402.tools/skills/structured-scrape) | Pull structured data out of any page deterministically — articles, tables, lists, select-by-CSS. |
| [**any-to-markdown**](https://agent402.tools/skills/any-to-markdown) | "I have a URL but it might be HTML, PDF, or an image — give me clean markdown either way." |
| [**document-intel**](https://agent402.tools/skills/document-intel) | Turn any PDF or image URL into structured data — metadata, text, page ranges, OCR, barcodes. |
| [**link-preview**](https://agent402.tools/skills/link-preview) | Turn a URL into a card-shaped preview — OpenGraph/Twitter metadata + thumbnail. |

## Finance (5)

| Pack | What it solves |
|---|---|
| [**financial-research**](https://agent402.tools/skills/financial-research) | SEC filings + real-time quotes + history + macro context for a single ticker. |
| [**loan-comparison**](https://agent402.tools/skills/loan-comparison) | Compare two or more loan offers on a single rubric (monthly payment, total cost, NPV, IRR). |
| [**investment-decision**](https://agent402.tools/skills/investment-decision) | Run a capital allocation decision (equipment, expansion, acquisition) — NPV, IRR, sensitivity. |
| [**retirement-planning**](https://agent402.tools/skills/retirement-planning) | Will my retirement plan actually work? Project the accumulation phase with compound interest. |
| [**savings-goal**](https://agent402.tools/skills/savings-goal) | How much do I need to save each month to hit $X in N years? Pin down the required contribution. |

## Macro & SEC (4)

| Pack | What it solves |
|---|---|
| [**macro-economics**](https://agent402.tools/skills/macro-economics) | Pull the canonical US macro dataset — yield curve, CPI, unemployment, fed funds, Sahm rule. |
| [**macro-context**](https://agent402.tools/skills/macro-context) | "Is the economic backdrop you're modeling against still current?" — refresh the macro snapshot. |
| [**sec-filings-deep-dive**](https://agent402.tools/skills/sec-filings-deep-dive) | Full EDGAR picture of a US public company: filings, facts, insider trades, 13F holdings. |
| [**regulatory-watch**](https://agent402.tools/skills/regulatory-watch) | "Who just filed / who just bought / what just IPO'd / what does the full-text search show?" |

## Time series & forecasting (2)

| Pack | What it solves |
|---|---|
| [**trend-analysis**](https://agent402.tools/skills/trend-analysis) | Take any numeric time series — stock close, FRED indicator, yield — and characterize the trend. |
| [**forecasting-bake-off**](https://agent402.tools/skills/forecasting-bake-off) | Don't guess which forecasting method to trust. Backtest all four (naive/drift, SES, Holt, Holt-Winters) and pick the winner by MAPE. |

## Network, DevOps & API work (4)

| Pack | What it solves |
|---|---|
| [**dns-network-ops**](https://agent402.tools/skills/dns-network-ops) | End-to-end DNS health check: records, multi-resolver propagation, WHOIS, ASN, robots.txt. |
| [**status-snapshot**](https://agent402.tools/skills/status-snapshot) | "Is this site healthy, addressable, and crawlable — right now?" |
| [**api-investigation**](https://agent402.tools/skills/api-investigation) | Point at an unknown API endpoint and figure out how to use it: auth, content type, schema. |
| [**schema-evolution**](https://agent402.tools/skills/schema-evolution) | "Did this API contract change in a way that breaks our integration?" — diff two OpenAPI specs. |

## Data engineering & RAG (4)

| Pack | What it solves |
|---|---|
| [**csv-profile**](https://agent402.tools/skills/csv-profile) | Hand it a CSV and get back a column-by-column profile: stats, outliers, correlations. |
| [**data-interchange**](https://agent402.tools/skills/data-interchange) | Bring data in from any structured format, normalize through JSON, fan out to YAML/CSV/JSON. |
| [**text-hygiene**](https://agent402.tools/skills/text-hygiene) | Turn a wall of dirty text into something downstream code can trust — redact, dedupe, sort, extract. |
| [**rag-prep**](https://agent402.tools/skills/rag-prep) | Turn a raw document into a vector-DB-ready JSONL dataset, deterministically. |

## Decoding & inspection (2)

| Pack | What it solves |
|---|---|
| [**decode-blob**](https://agent402.tools/skills/decode-blob) | Hand the agent an opaque string — JWT, base64 JSON, gzipped API response — and identify + decode it. |
| [**webhook-debug**](https://agent402.tools/skills/webhook-debug) | A webhook hit your endpoint — confirm it's authentic, valid, and safe to log. |

## Identity & onboarding (2)

| Pack | What it solves |
|---|---|
| [**user-onboarding**](https://agent402.tools/skills/user-onboarding) | Take a signup form and run the full onboarding deterministically: validate, hash, slugify. |
| [**identity-mint**](https://agent402.tools/skills/identity-mint) | Server-side identity-issuance round-trip: UUIDv4 + deterministic UUIDv5 + slug + password. |

## Location & time (3)

| Pack | What it solves |
|---|---|
| [**location-intel**](https://agent402.tools/skills/location-intel) | Point at an address (or rough place name) and assemble the situational brief — geo, weather, alerts. |
| [**meeting-scheduler**](https://agent402.tools/skills/meeting-scheduler) | Schedule a meeting across timezones without the round-tripping — convert and present a slot. |
| [**trip-planner**](https://agent402.tools/skills/trip-planner) | Plan a multi-stop journey: geocode each stop, sum pairwise distances, add travel + buffer time. |

## Crypto (1)

| Pack | What it solves |
|---|---|
| [**crypto-research**](https://agent402.tools/skills/crypto-research) | Live price, market structure, OHLC history, trending status, global market context for any coin. |

## Search & citations (1)

| Pack | What it solves |
|---|---|
| [**search-and-cite**](https://agent402.tools/skills/search-and-cite) | Research a question, return an answer with citations. Brave answer + supporting search snippets. |

## Media & accessibility (2)

| Pack | What it solves |
|---|---|
| [**media-pipeline**](https://agent402.tools/skills/media-pipeline) | "User uploaded a thing, normalize it before storing." Probe → resize → thumbnail → convert. |
| [**a11y-audit**](https://agent402.tools/skills/a11y-audit) | Deterministic WCAG 2.x audit of an HTML page from a string and a fg/bg color pair. |

---

## Why packs and not just tools

A single tool answers a question. A pack answers a **job**.

When an agent says *"audit a domain"*, picking one tool (whois? dns? tls-cert? cert-transparency?) is a guess — the right answer is "all of them in the right order, then synthesize." That's what a pack encodes:

- **The plan is in the template, not in the model.** Same pack, same plan, every time — no token-spending discovery loop.
- **The tools are pinned.** When a new better tool ships, the pack template gets updated server-side; agents calling `prompts/get` always get the current best plan.
- **Pricing is transparent.** Each tool's price is deterministic; the pack template lists every call so total cost is predictable before the first call.
- **No LLM in the serving path.** The pack rendering itself is deterministic — no hidden inference, no surprise dependencies.

## Adding a pack

Packs live in [`src/skills.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/src/skills.js). A pack is `{ slug, title, tagline, useCase, toolSlugs[], arguments[], workflow[], notes[] }` — see the existing entries for the shape. CI's "answers its own example" check covers the underlying tools; pack templates are validated by `scripts/test-mcp-all.js` (`prompts/list` returns N typed entries; `prompts/get` renders each one without throwing).

## See also

- [[Tool Catalog]] — the underlying 1,275 tools the packs orchestrate
- [[MCP Connector]] — how to wire the connector into Claude / Cline / any MCP-aware client
- [[Getting Started]] — your first call (free, no wallet) in 60 seconds
- [[x402-Index-and-Router]] — what Agent402 looks like inside the wider x402 ecosystem
