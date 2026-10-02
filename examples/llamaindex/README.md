# LlamaIndex + Agent402 -- runnable demo

Proves that the [`agent402-llamaindex`](https://www.npmjs.com/package/agent402-llamaindex) adapter works: `agent402-client` calls an Agent402 tool with built-in proof-of-work payment. The adapter wraps the same client to produce LlamaIndex `FunctionTool` instances for a LlamaIndex agent workflow. No wallet, no API key required.

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

Install the agent workflow and an LLM, then pass `agent402Tools()` to an agent:

```bash
npm install llamaindex @llamaindex/workflow @llamaindex/openai agent402-llamaindex
```

```js
import { agent } from "@llamaindex/workflow";
import { openai } from "@llamaindex/openai";
import { agent402Tools } from "agent402-llamaindex";

// The default (freeOnly: true) keeps only compute-payable tools.
const { tools } = await agent402Tools({ slugs: ["hash", "uuid", "json-to-csv"] });
const myAgent = agent({ tools, llm: openai({ model: "gpt-4o-mini" }) });
const res = await myAgent.run("Compute SHA-256 of 'hello world'");
```

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** -- point at a local instance: `AGENT402_BASE_URL=http://localhost:3000 node run.js` after `FREE_MODE=true npm start` in the repo root.
- **`agent402-client` not found** -- run `npm install` in this folder first.

## See also

- [Adapter source](../../adapters/llamaindex)
- [Client source](../../client)
- [Agent402 wiki](https://github.com/MikeyPetrillo/Agent402/wiki)
