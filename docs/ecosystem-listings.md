# Ecosystem listing PRs — ready to submit

Two high-signal directories accept PRs. Both need your GitHub account (forking
external repos), so the content below is copy-paste ready.

---

## 1. awesome-mcp-servers (punkpeye/awesome-mcp-servers)

The most-starred MCP list on GitHub. Section: **🔗 Aggregators** ("servers for
accessing many apps and tools through a single MCP server"). Entries are
alphabetical by repo name; legend: 📇 = TypeScript/JavaScript, ☁️ = cloud/hosted,
🏠 = local.

**Steps**
1. Fork https://github.com/punkpeye/awesome-mcp-servers and edit `README.md`.
2. In the Aggregators section, insert alphabetically:

```markdown
- [MikeyPetrillo/Agent402](https://github.com/MikeyPetrillo/Agent402) 📇 ☁️ 🏠 - The headless browser, live web search, OCR, and durable wallet-keyed memory an agent's sandbox doesn't have — plus 1,000+ deterministic utilities — rented per call via x402 (USDC on Base) or free with proof-of-work. Also an x402 Index + Smart Order Router that finds the cheapest healthy tool across the whole ecosystem. Hosted remote connector at agent402.tools/mcp.
```

3. PR title: `Add Agent402 (aggregator: 1,000+ pay-per-call web tools over x402)`

---

## 2. x402 ecosystem page (coinbase/x402 → x402.org/ecosystem)

Coinbase reviews within ~5 business days. Category: **Services/Endpoints**.

**Steps**
1. Fork https://github.com/coinbase/x402.
2. Download the logo: https://agent402.tools/logo.png → save as
   `typescript/site/public/logos/agent402.png`.
3. Create `typescript/site/app/ecosystem/partners-data/agent402/metadata.json`
   (check a sibling directory for the exact filename convention — copy whatever
   an existing entry like `metadata.json` uses):

```json
{
  "name": "Agent402",
  "description": "Headless browser, live web search, OCR, and durable wallet-keyed memory an AI agent's sandbox doesn't have — rented per call via x402 (USDC on Base) — plus 1,000+ deterministic utilities. Also an x402 Index + Smart Order Router that ranks the cheapest healthy tool across the whole ecosystem (auto-discovered from the CDP Bazaar). $0.001–$0.02/call, or free with proof-of-work. Open source, MCP server included.",
  "logoUrl": "/logos/agent402.png",
  "websiteUrl": "https://agent402.tools",
  "category": "Services/Endpoints"
}
```

4. PR title: `Ecosystem: add Agent402 (Services/Endpoints)`
   PR body: one paragraph + a proof line — e.g. "Live since 2026; revenue
   wallet and settled calls verifiable on Basescan:
   https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns —
   also discoverable via the CDP Bazaar discovery endpoint."

---

## 3. Smithery (smithery.ai)

Smithery auto-scans MCP servers — no PR needed, no `smithery.yaml` required.
The whole submission is one form post.

**Steps**
1. Visit https://smithery.ai/new (Smithery login required).
2. Paste the streamable-HTTP MCP URL:

   ```
   https://agent402.tools/mcp
   ```

3. Smithery scans the endpoint and extracts metadata automatically. Confirm
   the proposed name (`@MikeyPetrillo/agent402` or similar) and submit.

If the auto-scan ever fails, the fallback is to serve a
`/.well-known/mcp/server-card.json` from agent402.tools. Not needed today —
the catalog endpoint already returns proper MCP capabilities.

**CLI alternative** (same result; needs `npm install -g @smithery/cli`):

```bash
smithery mcp publish "https://agent402.tools/mcp" -n @MikeyPetrillo/agent402
```

---

## 4. AWS Bedrock AgentCore samples (awslabs/agentcore-samples)

AWS Labs' official sample repo accepts third-party integration entries
(identity providers, observability platforms, etc.). Agent402 fits — the
buy side is a Strands agent calling Agent402 tools; the sell side is a
tollbooth-gated endpoint paid by an AgentCore agent.

**Steps**
1. File an issue first (their CONTRIBUTING asks for it on significant work):
   https://github.com/awslabs/agentcore-samples/issues/new

   Draft body:

   > **Proposal: Add `integrations/agent402/` sample — x402 buy + sell side**
   >
   > Agent402 is an open-source x402 + MCP server with 1,275 pay-per-call web
   > tools, plus `agent402-tollbooth` for pay-per-crawl on the other side.
   > Both speak vanilla x402, so an AgentCore-hosted Strands agent works
   > end-to-end with no protocol bridging.
   >
   > Happy to PR a small `integrations/agent402/` folder containing:
   > 1. A buy-side Strands agent calling Agent402 tools via the published
   >    `agent402-strands` adapter (proof-of-work free tier; AgentCore Payments
   >    + CDP signs for wallet-only tools). Working code:
   >    https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore
   > 2. A sell-side reverse-flow demo: a Strands agent paying a
   >    self-hostable tollbooth gate. Working code:
   >    https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-tollbooth
   > 3. A README pointing at the 5-minute integration guide:
   >    https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore
   >
   > Closes the loop for the AgentCore Payments demo
   > (`aws-samples/sample-agentcore-cloudfront-x402-payments`) by giving it a
   > real buy-side counterparty + an open-source sell-side gate.
   >
   > Will follow this issue with a PR once you confirm the folder location.

2. After the issue is acked, open a PR adding `integrations/agent402/`:
   - `README.md` — short overview + link to the wiki guide + the two example
     subfolder links.
   - `buy-side/` — copy of `examples/agentcore/`.
   - `sell-side/` — copy of `examples/agentcore-tollbooth/`.

   Code is already prepared in this repo; the PR is a copy + path edits.

---

## 5. mcpservers.org (Awesome MCP Servers — hosted site)

A curated MCP server site (separate from `punkpeye/awesome-mcp-servers` —
mcpservers.org maintains its own index). Submission is a single form post
that takes a GitHub repo URL; no PR, no fork.

**Steps**
1. Visit https://mcpservers.org/submit
2. Fill the form:

   - **GitHub repo URL:** `https://github.com/MikeyPetrillo/Agent402`
   - **Name:** `Agent402`
   - **Short description (one line, ~150 chars):**

     ```
     1,275 pay-per-call web tools + 39 skill packs for AI agents over x402 (USDC on Base) — or free via proof-of-work. Browser, search, OCR, finance, EDGAR, durable memory.
     ```

   - **Long description / why (if asked):**

     ```
     Agent402 gives AI agents the headless browser, live web search + answers
     with citations, OCR, PDF text extraction, financial/crypto/macro data
     (Yahoo, CoinGecko, FRED, ECB, World Bank), SEC EDGAR filings, DNS/TLS/WHOIS,
     wallet-keyed shared memory, and ~1,000 deterministic utilities (hash, JWT,
     regex, compression, forecasting, statistics, finance math, etc.) — paid per
     call in USDC on Base via the x402 protocol, or free via built-in
     proof-of-work for the pure-CPU tools.

     One config block, no per-tool signups, no API keys. Self-hostable
     (open source MIT) or use the hosted remote at https://agent402.tools/mcp.
     Also publishes 39 curated multi-tool skill packs as MCP prompts.
     ```

   - **Category / tags (pick what's offered):** `aggregator`, `payments`,
     `web-search`, `browser-automation`, `finance`, `developer-tools`
   - **Author:** `Mikey Petrillo / MikeyPetrillo`
   - **License:** MIT
   - **Logo URL:** `https://raw.githubusercontent.com/MikeyPetrillo/Agent402/main/docs/logo-400.png`

3. Submit. mcpservers.org auto-reviews; turnaround is usually a few days.

---

Already listed (no action): official MCP Registry (with the hosted remote),
npm, Coinbase CDP Bazaar discovery (verified 2026-06-16: 64 Agent402 endpoints
in the public Bazaar index), agent402.app marketplace, Glama, mcp.so
(verified 2026-06-21: live at mcp.so/server/agent402).
Pending review: Cline MCP Marketplace (filed 2026-06-21 as
cline/mcp-marketplace#1849).
Not a submittable directory: Cursor (users add MCP servers to their own
`~/.cursor/mcp.json`; cursor.directory is a third-party Cursor *rules* site,
not an MCP listing).
Next up once submitted: the Anthropic connector directory
(see anthropic-directory-submission.md).
