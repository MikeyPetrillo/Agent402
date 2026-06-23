# OpenAI Agents SDK + Agent402 -- runnable demo

Proves that the [`agent402-openai-agents`](https://www.npmjs.com/package/agent402-openai-agents) adapter works: `agent402ToolSpecs()` returns four meta-tools (find/route/call/about) with built-in proof-of-work payment. No wallet, no API key, no framework install required.

## Run it

```bash
cd examples/openai-agents
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
PASS -- OpenAI Agents SDK adapter round trip works end-to-end.
```

## Using with the real Agents SDK

Install the peer dependencies (`npm install @openai/agents zod`) and use `agent402Tools()` instead of `agent402ToolSpecs()`:

```js
import { Agent, run } from "@openai/agents";
import { agent402Tools } from "agent402-openai-agents";

const tools = await agent402Tools();
const agent = new Agent({ name: "x402-agent", tools });
const out = await run(agent, "Hash 'hello world' with SHA-256");
```

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** -- point at a local instance: `AGENT402_BASE_URL=http://localhost:3000 node run.js` after `FREE_MODE=true npm start` in the repo root.
- **`agent402-openai-agents` not found** -- run `npm install` in this folder first.

## See also

- [Adapter source](../../adapters/openai-agents)
- [Agent402 wiki](https://github.com/MikeyPetrillo/Agent402/wiki)
