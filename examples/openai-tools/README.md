# OpenAI function-calling + Agent402 -- runnable demo

Proves that the [`agent402-openai-tools`](https://www.npmjs.com/package/agent402-openai-tools) adapter works: `agent402-client` calls an Agent402 tool with built-in proof-of-work payment. The adapter wraps the same client to produce OpenAI function-calling definitions. The first snippet below runs a web search and then a cited answer, each paid per call from a wallet.

## Search the web, then answer (paid from a wallet)

```bash
npm install openai agent402-openai-tools @x402/fetch @x402/core @x402/evm viem
```

```js
import OpenAI from "openai";
import { agent402Tools } from "agent402-openai-tools";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const payClient = new x402Client();
registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, payClient);

const openai = new OpenAI();
// web search, then a cited answer: both wallet-only, paid per call through payFetch
const { tools, execute } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });

const messages = [{ role: "user", content: "Search the web for x402 payment protocol adoption, then answer with citations: what is the x402 payment protocol?" }];
for (let turn = 0; turn < 4; turn++) {
  const res = await openai.chat.completions.create({ model: "gpt-4o-mini", messages, tools });
  const msg = res.choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) { console.log(msg.content); break; }
  for (const call of msg.tool_calls) {
    const result = await execute(call.function.name, JSON.parse(call.function.arguments));
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}
```

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet. The runnable demo below does exactly that: it calls `hash` with no wallet and no API key.

## Run the free demo

```bash
cd examples/openai-tools
npm install
node run.js
```

Expected output:

```
[demo] Agent402 base: https://agent402.tools
[demo] calling hash tool via agent402-client...
[demo] result: { algo: 'sha256', text: 'hello world',
                 hex: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' }
PASS -- OpenAI function-calling adapter round trip works end-to-end.
```

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** -- point at a local instance: `AGENT402_BASE_URL=http://localhost:3000 node run.js` after `FREE_MODE=true npm start` in the repo root.
- **`agent402-client` not found** -- run `npm install` in this folder first.

## See also

- [Adapter source](../../adapters/openai-tools)
- [Client source](../../client)
- [Agent402 wiki](https://github.com/MikeyPetrillo/Agent402/wiki)
