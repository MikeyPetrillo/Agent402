# Why pay here

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Seven things that are different about paying here. Every claim links to the surface that proves it: what the server does, measured on the server, on the open protocols anyone can build on, x402 and MPP. The live version is https://agent402.tools/why.

## 01 / Price - Pay for what the model used, with the ceiling quoted first.

On the metered gateway every 402 quotes this exact request from its own body. A wallet that can pay upto settles the actual usage under that ceiling; provider discounts such as prompt-cache reads pass through at cost. Every settled x402 or MPP response carries a receipt.

- The metered tier: https://agent402.tools/tools/v1-chat-metered
- OpenClaw setup: https://agent402.tools/guides/openclaw-model-provider

## 02 / Failure - A failed call is not charged, and the response proves it.

Settlement runs after the handler answers and an error status cancels it, so a response with no payment receipt, or a receipt marked success:false, moved no money. A retry that carries the same idempotency key and the same payment credential replays the paid answer instead of paying again. The one residual case, a settled receipt on an error response, is detected by our own alarm and recorded as a debt in a refund ledger, never written off silently.

- Uptime measured from outside: https://agent402.tools/status
- How the paywall settles: https://agent402.tools/guides/x402-and-mpp

## 03 / One key - One key buys everything.

The same wallet or credits key pays for five LLM tiers on three wires (OpenAI chat, OpenAI Responses, Anthropic Messages), embeddings, rerank, images, video, speech, transcription, grounded answers with citations, 500+ tools, wallet-keyed memory and finished reports. One paywall, one key.

- The catalog: https://agent402.tools/tools
- Gateway models: https://agent402.tools/v1/models
- Reports: https://agent402.tools/reports

## 04 / No wallet - No wallet required.

Prepaid credits by card, cards over MPP, and card checkout for reports sit beside USDC or USDG on twelve chains and native MPP on Tempo. An agent with no crypto can be buying in minutes; an agent with a wallet never needs an account.

- Prepaid credits: https://agent402.tools/credits
- Buy a report by card: https://agent402.tools/reports

## 05 / Deliverables - Finished work, ready to use.

Company dossiers, insider flow, 13F holdings, filing reports, IPO digests, domain audits, token risk, deep research, market briefs, recall watch and a LinkedIn article package, grounded in primary sources with a data appendix. Monitors probe daily for free and re-run the paid report when the facts change.

- Report products: https://agent402.tools/reports
- Monitors: https://agent402.tools/monitors

## 06 / Routing - We buy on your behalf.

Route-and-execute resolves a task to the best seller across the whole ecosystem, ours or anyone else's, pays them from our own wallet on the agent's behalf and relays the result under one receipt. Only sellers with proven on-chain settlement are routable.

- Route-and-execute: https://agent402.tools/tools/route-execute
- The seller index: https://agent402.tools/marketplace

## 07 / Proof - Everything is checkable.

Uptime is observed by two probes outside production, a real-money canary buys through every rail daily, transactions are published by rail and by wire, and the whole server is open source and self-hostable. Tools are deterministic: no model in the serving path.

- Status: https://agent402.tools/status
- Transactions: https://agent402.tools/revenue
- Source: https://github.com/MikeyPetrillo/Agent402

## Start with one call

Add the hosted MCP connector, buy prepaid credits by card, or pay per call in USDC from a wallet. All three reach the same catalog. Selling into it is open too: the tollbooth charges agents per request on your own API over both protocols.

- Add to your agent: https://agent402.tools/docs#add
- Prepaid credits: https://agent402.tools/credits
- Get a report: https://agent402.tools/reports
- Sell your API: https://agent402.tools/sell
- Receipts (settled under the quoted ceiling, with the settle tx): https://agent402.tools/proof
