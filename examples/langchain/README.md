# LangChain.js + Agent402 -- runnable demo

Proves that the [`agent402-langchain`](https://www.npmjs.com/package/agent402-langchain) adapter works: `agent402ToolSpecs()` returns four meta-tools (find/route/call/about) with built-in proof-of-work payment. No wallet, no API key, no framework install required.

## Run it

```bash
cd examples/langchain
npm install
node run.js
```

Expected output:

```
[demo] Agent402 base: https://agent402.tools
[demo] 4 meta-tools loaded: agent402_find, agent402_route, agent402_call, agent402_about
[demo] calling hash tool via agent402_call...
[demo] result: { algo: 'sha256', text: 'hello world',
                 hex: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' }
PASS -- LangChain adapter round trip works end-to-end.
```

## Using with real LangChain

Install the peer dependencies (`npm install @langchain/core zod`) and use `agent402Tools()` instead of `agent402ToolSpecs()`:

```js
import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { agent402Tools } from "agent402-langchain";

const tools = await agent402Tools();
const model = new ChatOpenAI({ model: "gpt-4o-mini" });
// wire tools into your agent as usual
```

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** -- point at a local instance: `AGENT402_BASE_URL=http://localhost:3000 node run.js` after `FREE_MODE=true npm start` in the repo root.
- **`agent402-langchain` not found** -- run `npm install` in this folder first.

## See also

- [Adapter source](../../adapters/langchain)
- [Agent402 wiki](https://github.com/MikeyPetrillo/Agent402/wiki)
