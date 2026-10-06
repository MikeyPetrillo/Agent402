# Strands + Agent402 on AWS Bedrock AgentCore — runnable demo

A 30-second proof that the [`agent402-strands`](https://www.npmjs.com/package/agent402-strands) adapter does what the [wiki](https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore) claims: a [Strands Agent](https://strandsagents.com) calls Agent402 tools and the adapter handles payment underneath (proof-of-work for free tools, x402+USDC for wallet-only).

This example runs **locally** with a stubbed `@strands-agents/sdk` so you can verify the wiring without an AWS account. The same code runs **unchanged on AWS Bedrock AgentCore** — only the import is swapped for the real SDK and Identity supplies the CDP credentials. See "Deploying on AgentCore" below.

## Run it

With a wallet (an EVM key holding USDC on Base), the agent runs a web search and then a cited answer, each paid per call over x402:

```bash
cd examples/agentcore
npm install
AGENT_KEY=0x... node run.js
```

```
[demo] catalog: 2 Agent402 tools wired into Strands
[demo] search({"q":"x402 payment protocol adoption"}): { query: ..., results: [ ... ] }
[demo] answer({"q":"what is the x402 payment protocol?"}): { answer: ..., citations: [ ... ] }
PASS: Strands → Agent402 web search and answer, paid from the wallet.
```

That's the full flow:
1. `agent402Tools()` pulls the live Agent402 catalog
2. The Strands Agent picks the tools from natural-language input
3. Each call answers 402 with its price; the x402 fetch signs the USDC payment and retries
4. agent402.tools returns the real, structured result, and settles only on success

**No wallet yet?** The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet. Run `node run.js` with no `AGENT_KEY` and the demo calls `hash` instead:

```
[demo] agent picked tool: hash
[demo] tool result: { algo: 'sha256', text: 'hello world',
                       hex: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9' }
PASS: Strands → Agent402 round trip works end-to-end.
```

## Deploying on AgentCore

To run the same agent on AWS Bedrock AgentCore, swap two things:

1. **Remove the SDK stub** at the top of `run.js`. Install the real Strands SDK with `npm install @strands-agents/sdk` (the adapter already declares it).
2. **For wallet-only tools** (paid in USDC, not free via PoW), set `freeOnly: false` in `agent402Tools({...})` and pass the `fetch` AgentCore Payments hands you — it signs with the CDP key in Identity:

   ```ts
   const { tools } = await agent402Tools({
     freeOnly: false,
     fetch: agentcoreX402Fetch,    // from AgentCore Payments
   });
   ```

That's the whole port. AgentCore handles the CDP credentials, CloudWatch observability, and rate limits — your code is identical.

## What's in this folder

- `run.js` — the demo (stubs the SDK, wires the adapter, invokes the tool)
- `package.json` — declares the adapter dependency
- `README.md` — this file

## Troubleshooting

- **`ECONNREFUSED agent402.tools`** — your network can't reach the hosted catalog. Point `baseUrl` at your own instance: `agent402Tools({ baseUrl: "http://localhost:3000", ... })` after `FREE_MODE=true npm start` in the repo root.
- **`expected at least one tool`** — the slug filter ruled out everything; try without `slugs:` to see the full catalog.
- **`agent402-strands` not found** — run `npm install` in this folder first.

## See also

- [Wiki: AWS Bedrock AgentCore](https://github.com/MikeyPetrillo/Agent402/wiki/AWS-Bedrock-AgentCore) — the 5-minute integration recipe
- [Adapter source](../../adapters/strands) — the npm package this demo uses
- [`examples/agentcore-tollbooth/`](../agentcore-tollbooth) — reverse-flow demo: a Strands agent **paying** a tollbooth-gated endpoint over x402 (agents paying agents)
