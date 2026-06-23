# LlamaIndex + Agent402 -- runnable demo

Proves that the [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) adapter works: `agent402-client` calls an Agent402 tool with built-in proof-of-work payment. The adapter wraps the same client to produce LlamaIndex `FunctionTool` instances for any agent runner (OpenAIAgent, AnthropicAgent, ReActAgent). No wallet, no API key required.

## Run it

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

## Using with real LlamaIndex

Install `llamaindex` and use `agent402Tools()` to get FunctionTool instances:

```js
import { OpenAIAgent } from "llamaindex";
import { agent402Tools } from "agent402-llamaindex";

const { tools } = await agent402Tools({ slugs: ["hash", "extract", "render"] });
const agent = new OpenAIAgent({ tools });
const res = await agent.chat({ message: "Hash 'hello world' with SHA-256" });
```

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** -- point at a local instance: `AGENT402_BASE_URL=http://localhost:3000 node run.js` after `FREE_MODE=true npm start` in the repo root.
- **`agent402-client` not found** -- run `npm install` in this folder first.

## See also

- [Adapter source](../../adapters/llamaindex)
- [Client source](../../client)
- [Agent402 wiki](https://github.com/MikeyPetrillo/Agent402/wiki)
