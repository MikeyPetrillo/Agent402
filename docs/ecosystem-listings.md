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
- [MikeyPetrillo/Agent402](https://github.com/MikeyPetrillo/Agent402) 📇 ☁️ 🏠 - 1,000+ pay-per-call web tools for agents (encoding, conversions, validation, search, browser, PDF, wallet-keyed memory) settled via x402 (USDC on Base) or free with proof-of-work. Hosted remote connector at agent402.tools/mcp.
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
  "description": "1,000+ pay-per-call web tools for AI agents — live search, browser rendering, screenshots, PDFs, durable wallet-keyed memory, and ~1,000 deterministic utilities — priced $0.001–$0.02/call and settled in USDC on Base via x402. Open source, MCP server included, with a proof-of-work free tier for wallet-less agents.",
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

Already listed (no action): official MCP Registry (with the hosted remote),
npm, Coinbase CDP Bazaar discovery, agent402.app marketplace, Glama, mcp.so.
Next up once submitted: the Anthropic connector directory
(see anthropic-directory-submission.md).
