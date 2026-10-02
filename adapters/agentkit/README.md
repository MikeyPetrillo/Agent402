# agent402-agentkit

[Agent402](https://agent402.tools) as a [Coinbase AgentKit](https://github.com/coinbase/agentkit)
action provider: give an agent with a CDP, Privy, ZeroDev or viem-backed
wallet 500+ pay-per-call web tools through three actions, paying under the
hood over x402 in USDC from the agent's own wallet; the pure-CPU tools are
free via proof-of-work.

> **Agent402 is the applied layer of [Agentic Finance](https://agent402.tools/agentic-finance)** - agents that pay and get paid on their own over the two open wires, [x402](https://x402.org) and MPP.

## Install

```bash
npm install agent402-agentkit @coinbase/agentkit @x402/fetch @x402/evm zod
```

## Use

```ts
import { AgentKit, CdpEvmWalletProvider } from "@coinbase/agentkit";
import { agent402ActionProvider } from "agent402-agentkit";

const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
  networkId: "base-mainnet",
});

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [await agent402ActionProvider()],
});
// hand agentKit.getActions() to your framework (LangChain, Vercel AI SDK, ...)
```

The agent now has:

| Action | Wallet | What it does |
|---|---|---|
| `agent402_find` | no | Resolve a task to the best-matching tools: slug, price, whether a wallet is needed, a ready example. Free. |
| `agent402_call` | yes | Call a tool by slug with its input. Free-tier tools are paid with a few seconds of proof-of-work; wallet-only tools are paid over x402 in USDC on Base, signed by the wallet provider. Returns the tool's JSON. |
| `agent402_about` | no | What Agent402 is, how it is paid, live tool counts. Free. |

The x402 signer is derived from the wallet provider the same way AgentKit's own
x402 action provider derives it (`toSigner()` plus `readContract`), so CDP,
Privy, ZeroDev and viem-backed wallets all work (proven live with viem).
Live-proven 2026-08-27 against production: a `ViemWalletProvider` over a
funded Base wallet ran `agent402_find` then `agent402_call` on a wallet-only
tool and paid $0.002 over x402 ([transaction](https://basescan.org/tx/0x1c0592f73d1f9182ee9bd40eb34d9b6c70b3196814b111589b82df4e79e7fb59)).

Hosts that wrap actions themselves can take the raw list:

```js
import { agent402Actions } from "agent402-agentkit";
const actions = await agent402Actions();   // [{ name, description, schema, invoke }]
```

## Example: buy data, ship it to Base

[`examples/agentkit-data-to-deploy`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentkit-data-to-deploy)
is one script on one wallet: `agent402_call` buys the live ETH price over x402
(`crypto-price`), then `walletProvider.sendTransaction` deploys a contract to Base
mainnet that stores the price and the payment transaction hash. Proven from CI
against production.

## Options and spend bounds

`agent402ActionProvider({ baseUrl, fetchImpl, zod, maxPerCallUsd, dailyLimitUsd, maxPerHostUsd, payees })`

- `maxPerCallUsd` (default `1`): a paid call above this is refused before any
  signature. `dailyLimitUsd` and `maxPerHostUsd` bound rolling 24-hour spend.
- `payees`: an allowlist of `payTo` addresses; a 402 naming any other address
  is refused before signing, so a mis-set `baseUrl` cannot spend the wallet.
- `baseUrl` for a self-hosted Agent402, `fetchImpl` to inject a fetch, `zod` to
  pass the host's zod module.

## What Agent402 serves

Web search, news and cited answers, browser render and screenshots, PDFs and
OCR, live market and crypto data, SEC filings, DNS and TLS checks, a code
sandbox, wallet-keyed memory, finished reports, and an OpenAI-compatible model
gateway. Most tools are deterministic code; the model gateway, the reports and
the media, embedding and answer tools are model-backed (`modelBacked` on
`/api/pricing`). Prices are per call; the live list is `/api/pricing`. Catalog:
https://agent402.tools/tools · agent-readable docs: https://agent402.tools/llms.txt

MIT. Maintained by Havok Holdings LLC.

Spend ceilings (`maxPerCallUsd`, `dailyLimitUsd`, `maxPerHostUsd`) are measured against one client per wallet provider for the life of the actions, so the daily ceiling holds across calls. `creditsKey` (a prepaid `a402_...` key) pays wallet-only tools without a wallet.
