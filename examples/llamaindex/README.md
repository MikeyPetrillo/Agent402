# LlamaIndex + Agent402 -- runnable demo

Proves that the [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) adapter works: `agent402-client` calls an Agent402 tool with built-in proof-of-work payment. The adapter wraps the same client to produce LlamaIndex `FunctionTool` instances for a LlamaIndex agent workflow. The first snippet below runs a web search and then a cited answer, each paid per call from a wallet.

## Search the web, then answer (paid from a wallet)

```bash
npm install llamaindex @llamaindex/workflow @llamaindex/openai agent402-llamaindex @x402/fetch @x402/core @x402/evm viem
```

```js
import { agent } from "@llamaindex/workflow";
import { openai } from "@llamaindex/openai";
import { agent402Tools } from "agent402-llamaindex";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const payClient = new x402Client();
registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, payClient);

// web search, then a cited answer: both wallet-only, paid per call through payFetch
const { tools } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });
const myAgent = agent({ tools, llm: openai({ model: "gpt-4o-mini" }) });
const res = await myAgent.run("Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?");
```

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet. The runnable demo below does exactly that: it calls `hash` with no wallet and no API key.

## Run the free demo

```bash
cd examples/llamaindex
npm install
node run.js
```

Expected output:

```
[demo] Agent402 base: https://agent402.tools
[demo] calling hash tool via agent402-client...
[demo] result: { algo: 'sha256', text: 'hello world',
                 hex: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' }
PASS -- LlamaIndex adapter round trip works end-to-end.
```

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** -- point at a local instance: `AGENT402_BASE_URL=http://localhost:3000 node run.js` after `FREE_MODE=true npm start` in the repo root.
- **`agent402-client` not found** -- run `npm install` in this folder first.

## See also

- [Adapter source](../../adapters/llamaindex)
- [Client source](../../client)
- [Agent402 wiki](https://github.com/MikeyPetrillo/Agent402/wiki)
