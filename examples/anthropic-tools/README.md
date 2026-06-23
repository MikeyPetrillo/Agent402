# Anthropic tool-use + Agent402 -- runnable demo

Proves that the [`agent402-anthropic-tools`](https://www.npmjs.com/package/agent402-anthropic-tools) adapter works: `agent402-client` calls an Agent402 tool with built-in proof-of-work payment. The adapter wraps the same client to produce Anthropic tool-use definitions (name, description, input_schema). No wallet, no API key required.

## Run it

```bash
cd examples/anthropic-tools
npm install
node run.js
```

Expected output:

```
[demo] Agent402 base: https://agent402.tools
[demo] calling hash tool via agent402-client...
[demo] result: { algo: 'sha256', text: 'hello world',
                 hex: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' }
PASS -- Anthropic tool-use adapter round trip works end-to-end.
```

## Using with real Anthropic

Install `@anthropic-ai/sdk` and use the adapter to get tool definitions plus an executor:

```js
import Anthropic from "@anthropic-ai/sdk";
import { agent402Tools } from "agent402-anthropic-tools";

const anthropic = new Anthropic();
const { tools, execute } = await agent402Tools({ slugs: ["hash", "extract", "render"] });

const res = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  tools,
  messages: [{ role: "user", content: "Hash 'hello world' with SHA-256" }],
});
// when the model returns a tool_use block:
//   const out = await execute(block.name, block.input);
```

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** -- point at a local instance: `AGENT402_BASE_URL=http://localhost:3000 node run.js` after `FREE_MODE=true npm start` in the repo root.
- **`agent402-client` not found** -- run `npm install` in this folder first.

## See also

- [Adapter source](../../adapters/anthropic-tools)
- [Client source](../../client)
- [Agent402 wiki](https://github.com/MikeyPetrillo/Agent402/wiki)
