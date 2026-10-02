# Why pay here

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Seven things that are different about paying here. Every claim links to the surface that proves it: what the server does, measured on the server, on the open protocols anyone can build on, x402 and MPP. The live version is https://agent402.tools/why, and the seven points below are copied from it (`src/why.js`).

## 01 / Price - Pay for what the model used, with the ceiling quoted first.

On the metered gateway every 402 quotes this exact request from its own body. A wallet that can pay upto settles the actual usage under that ceiling; provider discounts such as prompt-cache reads pass through. Every settled x402 or MPP response carries a receipt. A JSON answer bought with an EVM wallet can then be attested on Base by that same wallet: POST /api/attest with the settlement transaction writes an Ethereum Attestation Service record of the tool, the response digest and the payment, from our wallet, so an agent can prove afterwards what it acted on. Streamed and binary answers carry no digest, and wallet-scoped routes such as memory are never attested.

- The metered tier: https://agent402.tools/tools/v1-chat-metered
- OpenClaw setup: https://agent402.tools/guides/openclaw-model-provider

## 02 / Failure - A failed call is not charged, and the response proves it.

Settlement runs after the handler answers and an error status cancels it, so a response with no payment receipt, or a receipt marked success:false, moved no money. A retry that carries the same idempotency key and the same payment credential replays the paid answer instead of paying again. The one residual case, a settled receipt on an error response, is detected by our own alarm and recorded as a debt in a refund ledger, never written off silently. Anyone holding the settlement transaction can check it for free at /api/refunds/lookup and see our refund transaction once it is sent.

- Uptime measured from outside: https://agent402.tools/status
- How the paywall settles: https://agent402.tools/guides/x402-and-mpp

## 03 / One key - One key buys everything.

The same wallet pays for five LLM tiers on four wires (OpenAI chat, OpenAI Responses, Anthropic Messages, Gemini generateContent), embeddings, rerank, images, video, speech, transcription, grounded answers with citations, 500+ tools and finished reports, and an EVM wallet also keys its own memory. One paywall, one key.

- The catalog: https://agent402.tools/tools
- Gateway models: https://agent402.tools/v1/models
- Reports: https://agent402.tools/reports

## 04 / No wallet - No wallet required.

Proof-of-work pays for the pure-CPU tools, cards over MPP pay any route priced at $0.50 or more, and card checkout sells the finished reports, beside USDC or USDG on 12 chains and native MPP on Tempo. An agent with a wallet never needs an account.

- Ways to pay: https://agent402.tools/pricing
- Buy a report by card: https://agent402.tools/reports

## 05 / Deliverables - Finished work, ready to use.

Company dossiers, insider flow, 13F holdings, filing reports, IPO digests, domain audits, token risk, deep research, market briefs, recall watch and a LinkedIn article package, grounded in live sources, most with a downloadable data appendix. Monitors check for free on a schedule and re-run the paid report when the facts change, up to 4 full reports in any 30 days; past that a change arrives as an alert.

- Report products: https://agent402.tools/reports
- Monitors: https://agent402.tools/monitors

## 06 / Routing - We buy on your behalf.

Route-and-execute resolves a task to the best seller across the whole ecosystem, ours or anyone else's, pays them from our own wallet on the agent's behalf and relays the result under one receipt. Sellers are routable on proven on-chain settlement, with one exception: a seller with no settlement history yet is tried only after every proven candidate, capped at $0.01 a call on Base and $0.01 a call on Solana, and flagged unproven on the receipt.

- Route-and-execute: https://agent402.tools/tools/route-execute
- The seller index: https://agent402.tools/marketplace

## 07 / Proof - Everything is checkable.

Uptime is observed by two probes outside production, a real-money canary buys through every rail daily, transactions are published by rail and by wire, and the whole server is open source and self-hostable. The deterministic tools are pure code with no model in their path - parsers, hashes, math, a real browser - and the ones that DO run a model are named rather than blended in: the /v1 gateway tiers, the report products, the image, speech, transcription, embedding and AI-answer tools, the Decide planner, and the judgment model that can pick among the router's shortlisted candidates. Every 402 also carries the SHAPE of the answer before you pay: the accept declares an outputSchema, so an agent can check what came back against what was promised instead of taking a status code on trust. The operator is identified on-chain too: Agent402 is agent 94639 in the ERC-8004 Identity Registry on Base, and /.well-known/agent-registration.json is the record that registration points at, beside an A2A agent card at /.well-known/agent-card.json. So an agent can resolve who serves this catalog from the chain rather than from this page.

- Receipts: https://agent402.tools/proof
- Status: https://agent402.tools/status
- Transactions: https://agent402.tools/revenue
- On-chain identity: https://agent402.tools/.well-known/agent-registration.json
- Source: https://github.com/MikeyPetrillo/Agent402

## Start with one call

Add the hosted MCP connector, pay per call in USDC from a wallet, or buy a finished report by card. Selling into it is open too: the tollbooth charges agents per request on your own API over both protocols.

- Add to your agent: https://agent402.tools/docs#add
- Get a report: https://agent402.tools/reports
- Sell your API: https://agent402.tools/sell
- Receipts (settled under the quoted ceiling, with the settle tx): https://agent402.tools/proof
