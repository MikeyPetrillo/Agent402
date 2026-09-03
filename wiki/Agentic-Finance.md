# Agentic Finance

**Agentic Finance** is software agents transacting on their own: discovering a service, reading a machine-readable price, paying per request from a non-custodial wallet over open protocols (x402, MPP), receiving a verifiable receipt, and, on the other side, earning per request for what they serve. No accounts, no API keys, no invoices. The payment is the identity and every settlement is on a public ledger.

Full explainer with structured data: https://agent402.tools/agentic-finance

## Agentic payments vs agentic finance

- **Agentic payments** is the plumbing: a wire format that lets a program pay another program. Today the two open ones are [[x402|Paying-with-x402]] and [[MPP|Paying-with-MPP]].
- **Agentic finance** is the machine-to-machine economy that forms on top: price discovery, routing between competing sellers, reliability signals, spend controls, receipts and transparent revenue - operated by and for autonomous agents.

## The stack

| Layer | What | Who |
|---|---|---|
| Agents | Autonomous software with a wallet: MCP-connected assistants, crawlers, research and trading agents | buyers and, increasingly, sellers |
| Applied layer | Discovery, routing, pricing, reliability, receipts, transparency | **Agent402**: tools, index, router, tollbooth |
| Payment protocols | x402 (HTTP 402 with machine-readable requirements), MPP (the Payment HTTP auth scheme) | the wire |
| Rails and money | USDC on Base, Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand; USDG on Robinhood Chain; native Tempo | twelve rails |

## Where Agent402 sits

- **Buy** - 500+ pay-per-call tools over x402 or MPP ([[Tool Catalog]]).
- **Route** - the open index and Smart Order Router that resolve a task to the best seller across the ecosystem and pay them on the agent's behalf ([[x402 Index and Smart Order Router|x402-Index-and-Router]]).
- **Sell** - the open-source tollbooth: charge agents per request on your own site or API over both wires ([[Pay-per-crawl]]).
- **Prove** - live transaction counts by rail and wire (external revenue underneath; our own canary/volume traffic is never counted as earnings), the on-chain seller leaderboard ([[x402 Leaderboard]]), uptime measured from outside, refunds ledgered.

## Related

- [[Paying with x402]] · [[Paying with MPP]] · [[Paying with Compute]]
- https://agent402.tools/what-is-x402 · https://agent402.tools/what-is-mpp
- Glossary (every term defined once, with anchors): https://agent402.tools/glossary
- Long form: https://agent402.tools/blog/what-is-agentic-finance-aifi
