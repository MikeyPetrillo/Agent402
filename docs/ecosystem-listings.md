# Ecosystem listing PRs - ready to submit

## Current product summary (paste-ready, keep evergreen)

Use this block (or any subset) wherever a directory asks what Agent402 is. Every
claim below is served live; verify prices against `/api/pricing` before pasting.

- **Catalog:** 500+ pay-per-call endpoints for AI agents (500+ tools and
  70+ skill packs): live web search and cited answers, headless browser, PDFs, OCR,
  financial / SEC EDGAR / macro / on-chain data, an OpenAI-compatible LLM gateway
  (`/v1`), durable wallet-keyed memory, 200+ pure-CPU utilities.
- **Market and onchain intel (keyless, deterministic, per call):** live perpetuals
  (`perp-markets`, `perp-funding`, `perp-funding-screener`, `perp-basis`,
  `perp-open-interest`, `perp-klines`, `perp-orderbook`, $0.002 to $0.003) and the
  options book (`options-summary`, `crypto-options-chain`, `options-ticker`,
  `options-volume`, $0.002 to $0.005); DeFi yields, TVL, fees, DEX volume and
  stablecoin supply with history siblings (`defi-*`, `stablecoins`, $0.002 to
  $0.003); Solana token due diligence (`sol-token-safety` $0.005,
  `sol-token-report` $0.010, holders, pairs, trending, prices, swap quotes);
  crypto news, computed technical indicators and a whole-market pulse
  ($0.004 to $0.005); broad coin/exchange coverage including price by token
  contract address; indexed EVM chain reads (transfers, balances, allowances,
  decoded receipts, block receipts, token price history); Farcaster social
  (search, feeds, threads, engagement metrics); and whole-site crawling
  (`site-map` $0.005, `site-crawl` $0.02).
- **Images and video, flat per call:** `POST /v1/images/fast` $0.02,
  `POST /v1/images/pro` $0.05, `POST /v1/images/generations` $0.08,
  `POST /v1/videos/generations` $0.20 (one silent 4-second 720p clip). OpenAI
  wire, so any OpenAI SDK works against base_url `https://agent402.tools/v1`;
  priced per picture or per clip rather than per token.
- **Pay any way:** x402 (USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo,
  Avalanche, Sei, Optimism, Stellar, Algorand; USDG on Robinhood Chain - 12 chains),
  MPP (Machine Payments Protocol) on the same 402 (Base/Celo, or natively on Tempo),
  free proof-of-work on the pure-CPU tools, or **prepaid card credits** -
  $20 / $50 / $100 packs at https://agent402.tools/credits, spent on any priced
  route with `Authorization: Bearer a402_…`, debited only on a successful call, never expire.
- **Report products** ($0.20 to $1.10 over x402/MPP, or $1 to $2 by card at
  https://agent402.tools/reports - the card price includes payment processing,
  an agent paying per call pays the lower tool price for the same report):
  deep research `POST /v1/research` (+ `/pro`, `/max`), market brief
  `/v1/research/market-brief`, company dossier `/v1/dossier` (+ `/max`), ticker
  pack `/v1/ticker-pack`, 13F fund report `/v1/fund` (+ `/max`), SEC filing report
  `/v1/filing-report`, domain audit `/v1/domain-audit` (+ `/pro`), FDA recall
  `/v1/recall-report`, insider flow `/v1/insider-report`, Solana token brief
  `/v1/token-brief`, token risk `/v1/token-risk` (+ `/pro`) - $0.60 to $2.00 per
  call for an agent, $2 to $5 by card; current per-route prices at
  https://agent402.tools/pricing.
- **Monitors** ($3/month each, card, https://agent402.tools/monitors): domain
  security, SEC filings, Solana token safety, 13F fund, FDA recall, insider flow,
  IPO pipeline - a cheap daily probe, a full paid re-run and an email only when
  something changes.
- **MCP:** hosted connector `https://agent402.tools/mcp` (dotted tools:
  `catalog.search`, `catalog.find`, `catalog.call`, `payment.info`,
  `server.describe`, `sellers.list`, `demand.request`, plus flagships `web.search`,
  `web.answer`, `web.news`, `browser.render`, `market.quote`, `audio.transcribe`,
  `memory.read`, `memory.write`); wallet-only tools are payable on the connector
  over MPP (JSON-RPC `-32042` + challenges). npm: `agent402-mcp` (stdio, pays by
  wallet or credits key), `agent402-client` (buyer SDK), `agent402-tollbooth`
  (pay-per-crawl: x402 + MPP, native Tempo with split payments).
- **Maintainer:** Havok Holdings LLC. Open source (AGPL-3.0 server, MIT packages).


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
- [MikeyPetrillo/Agent402](https://github.com/MikeyPetrillo/Agent402) 📇 ☁️ 🏠 - The applied layer of Agentic Finance (AIFI): the headless browser, live web search, OCR, and durable wallet-keyed memory an agent's sandbox doesn't have - a catalog of 500+: 500+ pay-per-call tools and curated skill packs, every one tested, priced, and settled on-chain - rented per call via x402 (USDC on Base + 10 more chains (Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand), or USDG on Robinhood Chain - 12 chains) or free with proof-of-work on the 200+ pure-CPU tools; every paid endpoint also accepts MPP (Machine Payments Protocol) clients, settling on Base/Celo or natively on Tempo. Also an x402 Index + Smart Order Router that finds the cheapest healthy tool across the whole ecosystem, and an MPP marketplace of live-verified MPP sellers. Hosted remote connector at agent402.tools/mcp.
```

3. PR title: `Add Agent402 (aggregator: 500+ x402 pay-per-call tools and skill packs)`

---

## 2. x402 ecosystem page (coinbase/x402 → x402.org/ecosystem)

Coinbase reviews within ~5 business days. Category: **Services/Endpoints**.

**Steps**
1. Fork https://github.com/coinbase/x402.
2. Download the logo: https://agent402.tools/logo.png → save as
   `typescript/site/public/logos/agent402.png`.
3. Create `typescript/site/app/ecosystem/partners-data/agent402/metadata.json`
   (check a sibling directory for the exact filename convention - copy whatever
   an existing entry like `metadata.json` uses):

```json
{
  "name": "Agent402",
  "description": "Agentic Finance (AIFI) applied layer: 500+ pay-per-call endpoints for AI agents over x402 - 500+ tools and skill packs, every one tested, priced, and settled on-chain - headless browser, live web search, OCR, PDFs, financial/SEC/macro data, durable wallet-keyed memory, and an OpenAI-compatible LLM gateway (/v1: chat, embeddings, auto-routing) - USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar & Algorand, USDG on Robinhood Chain (12 chains), or free via proof-of-work; dual-stack with MPP (Machine Payments Protocol) on the same 402, settling on Base/Celo or natively on Tempo. Also an x402 Index + Smart Order Router that ranks the cheapest healthy tool across the ecosystem (auto-discovered from the CDP Bazaar), and an MPP marketplace. Open source, self-hostable, MCP server included.",
  "logoUrl": "/logos/agent402.png",
  "websiteUrl": "https://agent402.tools",
  "category": "Services/Endpoints"
}
```

4. PR title: `Ecosystem: add Agent402 (Services/Endpoints)`
   PR body: one paragraph + a proof line - e.g. "Live since 2026; revenue
   wallet and settled calls verifiable on Basescan:
   https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns -
   also discoverable via the CDP Bazaar discovery endpoint."

---

## 3. Smithery (smithery.ai)

Smithery auto-scans MCP servers - no PR needed, no `smithery.yaml` required.
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
`/.well-known/mcp/server-card.json` from agent402.tools. Not needed today -
the catalog endpoint already returns proper MCP capabilities.

**CLI alternative** (same result; needs `npm install -g @smithery/cli`):

```bash
smithery mcp publish "https://agent402.tools/mcp" -n @MikeyPetrillo/agent402
```

---

## 4. AWS Bedrock AgentCore samples (awslabs/agentcore-samples)

AWS Labs' official sample repo accepts third-party integration entries
(identity providers, observability platforms, etc.). Agent402 fits - the
buy side is a Strands agent calling Agent402 tools; the sell side is a
tollbooth-gated endpoint paid by an AgentCore agent.

**Steps**
1. File an issue first (their CONTRIBUTING asks for it on significant work):
   https://github.com/awslabs/agentcore-samples/issues/new

   Draft body:

   > **Proposal: Add `integrations/agent402/` sample - x402 buy + sell side**
   >
   > Agent402 is an open-source x402 + MCP server with a catalog of 500+
   > pay-per-call endpoints (500+ tools and skill packs), plus
   > `agent402-tollbooth` for pay-per-crawl on the other side.
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
   - `README.md` - short overview + link to the wiki guide + the two example
     subfolder links.
   - `buy-side/` - copy of `examples/agentcore/`.
   - `sell-side/` - copy of `examples/agentcore-tollbooth/`.

   Code is already prepared in this repo; the PR is a copy + path edits.

---

## 5. mcpservers.org (Awesome MCP Servers - hosted site)

A curated MCP server site (separate from `punkpeye/awesome-mcp-servers` -
mcpservers.org maintains its own index). Submission is a single form post
that takes a GitHub repo URL; no PR, no fork.

**Steps**
1. Visit https://mcpservers.org/submit
2. Fill the form:

   - **GitHub repo URL:** `https://github.com/MikeyPetrillo/Agent402`
   - **Name:** `Agent402`
   - **Short description (one line, ~150 chars):**

     ```
     500+ pay-per-call web tools + skill packs for AI agents over x402 on 12 chains, or free via proof-of-work. Browser, search, OCR, finance, EDGAR, durable memory.
     ```

   - **Long description / why (if asked):**

     ```
     Agent402 gives AI agents the headless browser, live web search + answers
     with citations, OCR, PDF text extraction, financial/crypto/macro data
     (Yahoo, CoinGecko, FRED, ECB, World Bank), SEC EDGAR filings, DNS/TLS/WHOIS,
     wallet-keyed shared memory, and 200+ deterministic utilities (hash, JWT,
     regex, compression, forecasting, statistics, finance math, etc.) - paid per
     call in USDC on Base (or Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar,
     Algorand) - plus USDG on Robinhood Chain - 12 chains total via the x402
     protocol, or free via built-in proof-of-work for the 200+ pure-CPU tools.

     The catalog is 500+ strong - tools and curated multi-tool skill packs
     (published as MCP prompts); every one is tested against its own example on
     every deploy. Every paid endpoint also accepts MPP (Machine Payments
     Protocol) on the same 402, and prepaid card credits cover agents with no
     wallet. One config block, no per-tool signups, no API keys.
     Self-hostable (open source AGPL-3.0) or use the hosted remote at
     https://agent402.tools/mcp.
     ```

   - **Category / tags (pick what's offered):** `aggregator`, `payments`,
     `web-search`, `browser-automation`, `finance`, `developer-tools`
   - **Author:** `Havok Holdings LLC`
   - **License:** AGPL-3.0 (server); MIT (client SDK, MCP, tollbooth)
   - **Logo URL:** `https://raw.githubusercontent.com/MikeyPetrillo/Agent402/main/docs/logo-400.png`

3. Submit. mcpservers.org auto-reviews; turnaround is usually a few days.

---

## 6. x402scan (x402scan.com) - the explorer featured on solana.com/x402

Merit Systems' x402 ecosystem explorer; solana.com/x402 points buyers here.
Registration is self-serve and automatic: submit a URL, and if it returns a
valid x402 payment-required response it is indexed. Our 402s are v2
(base64 PAYMENT-REQUIRED header) and advertise all twelve chains (Base, Solana,
Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand, Robinhood Chain), so a re-crawl also refreshes any stale listing.

**Steps**
1. Visit https://www.x402scan.com/resources/register
2. Submit flagship paid-route URLs (one per line/form entry):

   ```
   https://agent402.tools/api/search
   https://agent402.tools/api/answer
   https://agent402.tools/api/stock-quote
   https://agent402.tools/api/extract
   https://agent402.tools/api/hash
   ```

3. Verify the listing shows all twelve networks (Base, Solana, Polygon,
   Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand, Robinhood Chain) in the accepts. Also check
   https://www.x402scan.com/facilitator/payAI once the first Solana
   settlement lands - PayAI-settled traffic appears under that view.

---

## 7. awesome-x402 (xpaysh/awesome-x402) - STALE ENTRY, needs 12-chain + The-500 update

We are already listed, but the entry predates the full 12-chain roster and the
500+ strong catalog. PR a one-word-class fix:

**Steps**
1. Fork https://github.com/xpaysh/awesome-x402, find the Agent402 entry.
2. Update the chain list to "USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism,
   Stellar, Algorand - plus USDG on Robinhood Chain (12 chains)" and, if the
   entry cites a tool count, set it to "500+ pay-per-call tools and
   70+ skill packs".
3. PR title: `Update Agent402 entry - 12-chain settlement (USDC + USDG) + 500+ strong catalog`

---

## 7b. Robinhood Chain visibility (no directory yet - mainnet is days old)

There is no public Robinhood Chain ecosystem directory to submit to yet.
Until one exists, the discoverable surfaces are:

1. **On-chain identity**: Blockscout (robinhoodchain.blockscout.com) accepts
   public name tags for addresses - request a tag for the revenue wallet so
   settlements attribute to "Agent402.Tools".
2. **The 402 itself**: every paid route already advertises eip155:4663 in its
   `accepts`, so any Robinhood-side indexer that crawls x402 sellers will find
   us with zero extra work.
3. **First-mover proof**: keep a link to a real USDG settlement tx handy for
   any ecosystem-page submission the moment Robinhood opens one.

---

## 8. Solana ecosystem directory (solana.com/ecosystem)

The directory solana.com/x402 cross-links. Form submission, no PR.

**Steps**
1. Visit https://solana.com/ecosystem/submit-project
2. Fill:
   - **Name:** Agent402.Tools
   - **Category:** AI / Payments / Developer Tools (pick what's offered)
   - **One-liner:**

     ```
     500+ strong: pay-per-call web tools and skill packs for AI agents over x402, every one tested and settled on-chain - USDC on Solana (and Base/Polygon/Arbitrum/Monad/Celo/Avalanche/Sei/Optimism/Stellar/Algorand) plus USDG on Robinhood Chain - 12 chains - or free via proof-of-work. Open-source, self-hostable, MCP-native.
     ```

   - **Description:** reuse the mcpservers.org long description above; lead
     with the Solana angle (PayAI facilitator settlement, SVM signing in the
     agent402-mcp buyer, Solana payTo in every 402).
   - **Website:** https://agent402.tools · **Repo:** github.com/MikeyPetrillo/Agent402
3. Featured placement on solana.com/x402 is curated; the directory listing
   plus verifiable Solana settlements are what such a request needs.

---

Solana-surface status: PayAI facilitator auto-lists merchants in the x402
Bazaar (active since the multi-chain routing deploy - first Solana settlement
will populate it; fund SOLANA_BURNER_KEY so the daily canary provides that
settlement). x402scan indexes our 402s (re-register after chain changes).

---

Already listed (no action): official MCP Registry (with the hosted remote),
npm, Coinbase CDP Bazaar discovery (verified 2026-06-16: 64 Agent402 endpoints
in the public Bazaar index), Glama, mcp.so
(verified 2026-06-21: live at mcp.so/server/agent402).
Pending review: Cline MCP Marketplace (filed 2026-06-21 as
cline/mcp-marketplace#1849) - any follow-up copy on that issue should use the
The-500 framing above (500+: 500+ tools and skill packs, 12 chains).
Not a submittable directory: Cursor (users add MCP servers to their own
`~/.cursor/mcp.json`; cursor.directory is a third-party Cursor *rules* site,
not an MCP listing).
Next up once submitted: the Anthropic connector directory
(see anthropic-directory-submission.md).

---

## 9. July 2026 scour - new surfaces since this playbook was written

### Auto-indexed (verify, don't submit)

- **Agentic.Market (Coinbase)** - the new consumer-facing public directory of
  x402 services (live pricing, volume, top lists). Indexes AUTOMATICALLY from
  CDP-facilitator payments on Bazaar-discovery-enabled endpoints - our 64
  Bazaar-registered routes should already be present. Action: browse
  agentic.market for the Agent402 entries, confirm metadata quality and that
  the accepts show all twelve chains.
- **Onyx Bazaar** - free public leaderboard of every paid x402 service,
  re-derived from the CDP discovery API every 15 minutes. No submission
  surface; we appear iff the Bazaar entry is healthy.
- **kenoodl.com/agentic-market** - third-party mirror of the Agentic.Market
  catalog. Rides the same index; no action.

### Open submission, all chains (good non-EVM visibility)

- **402 Index** - no signature, no chain allowlist: non-EVM families (Stellar,
  Robinhood Chain via custom { id, rpcUrl }) are listable and findable. One of
  the few places the FULL twelve-chain roster can be first-class.
- **PipRail Discovery (piprail.com/discovery)** - one POST to list, no auth,
  no fee, every chain; probed on submit, domain verification for instant go-live.

### Curated directories (apply/PR)

- **gold-402 (24K Labs)** - curated x402 directory, 300+ entries, editorial
  writeups + "verified" badges for production-confirmed services. Apply with
  the on-chain revenue proof.
- **awesome-agentic-commerce (Merit-Systems)** - the same maintainers as
  x402scan; PR an Agent402 entry (aggregator/seller + tollbooth sell-side).

### Identity / reputation registries (per-chain trust layer)

- **AgentZone** - unified explorer combining ERC-8004 identity, x402 payment
  history, reputation, live status across **Base and Arbitrum**. Register an
  erc8004 identity and claim it on AgentZone so Base + Arbitrum settlements
  attribute to it.
- **Solana Agent Registry (solana.com/agent-registry)** + **8004-solana
  (QuantuLabs/PayAI)** - the ERC-8004 port on Solana with on-chain feedback
  and trust tiers, integrated with PayAI (our Solana facilitator). Register
  the Solana revenue wallet as an agent identity; PayAI-settled traffic then
  builds portable reputation.

### Watchlist (no action yet)

- **x402station** - x402 analytics/monitoring platform; check for a
  registration surface once it matures.
- **RelAI (relai.fi)** - "x402 API marketplace" still on their roadmap.
- **Google AP2 x x402** - agents paying via Google's Agent Payments Protocol
  settle over x402; no public AP2 merchant directory yet. Revisit when one
  exists.
- **CoinGecko "x402 ecosystem" category** - token listings only; N/A (no token).
- **Robinhood Chain** - still no ecosystem directory (see 7b); 402 Index /
  PipRail are the interim places its rail can be advertised.

## 10. mpp.dev services directory (tempoxyz/mpp - `schemas/services.ts`)

The curated MPP directory that `mppx services list`, `mpp.dev/api/services`
and the read-only `mpp.dev/mcp/services` all read. Listing = a PR adding an
entry to `schemas/services.ts` (types must pass `pnpm check:types`, build must
pass `pnpm build`); the review bar is "live and accepting payments via MPP,
high quality and novel". A bot comments the checklist on the PR. Recommended
sibling: MPPScan registration (already done - see the MPP integration notes).

Prod's Tempo challenge is USDC.e-first since 2026-08-18 (`TEMPO_CURRENCY=usdc,pathusd`
on Railway; proven by the tempo canary the same day), so `TEMPO_PAYMENT` below is
exactly what the live 402 offers. 138/141 directory sellers quote USDC.e and a
stock mppx client pays the FIRST tempo challenge it sees, which is why the order matters. Every route below is a real, priced, live-verified endpoint; amounts
are base units (6 decimals) at list price. `integration` is `third-party`
(self-hosted, our own `serviceUrl`, not proxied through mpp.tempo.xyz - the
same shape as the self-hosted data sellers already listed).

```ts
  {
    id: "agent402",
    name: "Agent402",
    url: "https://agent402.tools",
    serviceUrl: "https://agent402.tools",
    description:
      "500+ pay-per-call tools for AI agents - live web search and cited answers, headless browser rendering, PDFs, OCR, financial, SEC and on-chain data, an OpenAI-compatible LLM gateway - plus a Smart Order Router that finds and pays the best external seller on the agent's behalf. Every paid endpoint accepts MPP (Tempo natively, or evm on Base/Celo) and x402 on the same 402.",
    icon: "https://agent402.tools/logo.png",
    categories: ["search", "web", "data", "ai", "blockchain"],
    integration: "third-party",
    tags: ["search", "browser", "pdf", "ocr", "sec-filings", "finance", "llm-gateway", "router", "agentic-finance"],
    status: "active",
    docs: {
      homepage: "https://agent402.tools/docs",
      llmsTxt: "https://agent402.tools/llms.txt",
      apiReference: "https://agent402.tools/openapi.json",
    },
    provider: { name: "Havok Holdings LLC", url: "https://agent402.tools" },
    realm: "agent402.tools",
    intent: "charge",
    payments: [
      TEMPO_PAYMENT,
      { method: "evm", currency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    ],
    endpoints: [
      { route: "GET /api/search", desc: "Live web search (title, URL, snippet)", amount: "20000", unitType: "request" },
      { route: "GET /api/answer", desc: "Cited answer grounded in live web search", amount: "80000", unitType: "request" },
      { route: "POST /api/render", desc: "Headless browser render of a URL (title, text, links)", amount: "20000", unitType: "request" },
      { route: "POST /api/route/execute", desc: "Smart Order Router: resolve a task to the best seller across the ecosystem, pay them, relay the result", amount: "10000", unitType: "request" },
      { route: "POST /v1/chat/completions", desc: "OpenAI-compatible chat completions (base tier)", amount: "20000", unitType: "request" },
      { route: "GET /api/pricing", desc: "Machine-readable catalog of every endpoint and price" },
    ],
  },
```

**OPENED 2026-08-18: https://github.com/tempoxyz/mpp/pull/900** (fork
`MikeyPetrillo/mpp`, branch `add-agent402`; their `schemas/services.test.ts`
passes locally, 9,410 assertions; the changed-services bot recognised
`agent402`; the Vercel "failure" is only the preview deploy awaiting a team
member's authorization - same on every external PR). It supersedes #812
(evm-only, opened 2026-07-24), which their `stale-service-prs` workflow
auto-closes any `service-directory` PR **14 days after creation** with no
review - the timer is on `created_at`, so a nudge comment cannot reset it;
only a maintainer review inside 14 days lands it. If #900 times out, the
next attempt should follow a direct line to a maintainer, not a third PR.
Verify amounts against `/api/pricing` before any future re-submission.
