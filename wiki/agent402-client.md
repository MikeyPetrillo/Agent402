# agent402-client

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

[`agent402-client`](https://www.npmjs.com/package/agent402-client) is the buyer-side SDK for Agent402 and any Agent402 instance: resolve a task to a tool, then call it, with payment handled for you. MIT licensed, no runtime dependencies.

```bash
npm install agent402-client
```

```js
import { Agent402 } from "agent402-client";

const a = new Agent402();                        // https://agent402.tools, or { baseUrl } for your own server
const [best] = await a.find("extract the article from a url");
const out = await a.call("hash", { text: "hello world", algo: "sha256" });
```

## How it pays

- **Free tools**: the proof-of-work is solved for you on a worker thread; no wallet.
- **Wallet-only tools**: pass a payment-aware `fetch` (x402 or MPP) and it pays 402s; the SDK never touches your key.
- **A credits key**: pass `creditsKey`, and it is sent as `Authorization: Bearer a402_...`; see [[Credits keys|Credits]] for how a call is debited.
- **A Circle Gateway deposit**: batched payments with no gas per call ([[Circle Gateway (batched USDC)|Circle-Gateway]]).

## What it guards

- Spending caps (`maxPerCallUsd`, `dailyLimitUsd`, `maxPerHostUsd`), a payee allowlist, and a chain preference.
- A stable `Idempotency-Key` per operation, so a retried lost response replays the paid answer on the credits and proof-of-work paths.
- Paid calls never follow redirects, and `verifyReceipt` checks a signed receipt.

The [package README](https://github.com/MikeyPetrillo/Agent402/blob/main/client/README.md) is the full reference. See also [[Adapters]] and [[MCP Connector]].
