# Contributing

Issues, tool ideas, and integration reports are all welcome —
[open an issue](https://github.com/MikeyPetrillo/Agent402/issues).

## Ground rules for new tools

A tool ships only if it can be served *honestly*:

1. **Deterministic** — no LLM in the serving path; same input, same output.
2. **Self-describing** — every tool declares its price, description, input
   schema, and a working example in the catalog entry. Docs pages, OpenAPI,
   llms.txt, MCP exposure, and CI tests are all generated from that one entry.
3. **Tested against its own example** — CI calls every endpoint with its
   documented example and blocks the deploy on any failure.
4. **Priceable** — if an upstream is flaky from datacenter IPs or can't be
   relied on, the tool gets removed rather than charge-and-502 (x402 settles
   before the handler runs).
5. **Free-tier safe or wallet-only** — anything that spends real resources per
   call (browser, egress, paid APIs, disk) goes in `WALLET_ONLY_SLUGS`.

## Dev quickstart

```bash
npm install
FREE_MODE=true npm start                 # no payments, port 3000
node scripts/test-kit2.js                # exact-output tests, pure-CPU tools
node scripts/test-all.js                 # every endpoint vs its own example
node scripts/test-mcp-http.js            # the hosted MCP connector
```

The wiki is edited in [`wiki/`](wiki/) in this repo (CI syncs it); don't edit
the GitHub wiki directly.
