# Anthropic Connector Directory — submission package

Submit at: **https://claude.com/docs/connectors/building/submission**
(Anthropic account required — this is the one step only a human can do.)

Everything below is ready to paste. All technical requirements are already
live: tool titles + read-only safety annotations on every tool, a stable
privacy policy, public docs, and a no-auth streamable-HTTP endpoint.

---

## Basic information

| Field | Value |
|---|---|
| Server name | Agent402 |
| Server URL | `https://agent402.tools/mcp` |
| Transport | Streamable HTTP |
| Auth type | None (anonymous; no account, no API key) |
| Read/write | Read-only (all tools carry `readOnlyHint: true`; nothing destructive) |
| Website | https://agent402.tools |
| Public docs | https://agent402.tools/llms.txt (also /tools and /openapi.json) |
| Privacy policy | https://agent402.tools/privacy |
| Support contact | https://github.com/MikeyPetrillo/Agent402/issues |
| Maintainer | Mikey Petrillo — https://github.com/MikeyPetrillo |
| Source code | https://github.com/MikeyPetrillo/Agent402 (MIT, fully open source) |

## Tagline (short)

> The headless browser, live web search, and durable memory your agent's sandbox doesn't have — plus 1,000+ instant utilities. No signup, no API key.

## Description

> Agent402 gives Claude a catalog of 1,000+ small, deterministic web tools it
> can call instantly: encoding and hashing, unit and data conversions, JSON/CSV
> wrangling, text processing, date/cron math, validators, and more. There is no
> account, no API key, and no setup — the pure-CPU tools run free on the hosted
> connector (rate-limited). No LLM is involved in serving: same input, same
> output, with full input schemas. The server is open source, and the catalog
> is also reachable programmatically over the x402 payment protocol for
> autonomous agents with their own wallets.

## Tools exposed (3, each with title + safety annotations)

1. **search_tools** — "Search the Agent402 tool catalog". Finds tools by
   description across the full catalog; returns slugs, prices, and input
   schemas. Read-only.
2. **call_tool** — "Run an Agent402 tool". Executes a catalog tool by slug.
   On this hosted connector only the pure-CPU, deterministic tools execute
   (~1,040 of them); network/browser/storage tools return guidance instead of
   running. Read-only, idempotent, no external side effects.
3. **about_agent402** — "About this connector". Static service description.

## Connection requirements

None. Anonymous streamable HTTP; stateless (every JSON-RPC message is
self-contained). Per-client rate limit: 20 calls/min, 120/hour.

## Example prompts (use cases)

- "Decode this JWT and tell me when it expires."
- "Convert 250 horsepower to kilowatts."
- "Generate a UUID and its sha256 hash."
- "When will the cron expression `0 9 * * MON` fire next?"
- "Dedupe and sort these 200 lines."
- "Validate these 5 email addresses' syntax."

## Reliability / review notes

- Every endpoint is re-tested against its own documented example in CI before
  any deploy; the MCP connector itself has an end-to-end JSON-RPC test gating
  both CI and the production rollout.
- A heartbeat probes production every 15 minutes (health, catalog, paid call,
  MCP initialize).
- Errors are structured and human-readable (each tool returns a specific
  message naming the missing/invalid field, never a bare 500).
- No data collection: no accounts, no cookies, no trackers. IPs are used only
  for rate limiting (in-memory, ≤1 h). See /privacy.
