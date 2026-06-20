# agent402-client

A tiny buyer-side client for [Agent402](https://agent402.tools) (and any Agent402
instance). **Resolve a task to a tool, then call it — with payment handled for
you.** Free pure-CPU tools settle with a built-in proof-of-work (no wallet, zero
dependencies); wallet-only tools settle via an x402-wrapped fetch you provide.
Results are cached, and retries reuse an `Idempotency-Key` so a lost response
never double-charges.

```bash
npm install agent402-client
```

## Free tier (proof-of-work, no wallet)

```js
import { Agent402 } from "agent402-client";

const a = new Agent402();                       // → https://agent402.tools

// Don't know the slug? Resolve a task in one call.
const matches = await a.find("extract the article from a url");
// → [{ slug: "extract", route, price, inputSchema, example, … }]

// Call it — proof-of-work is solved automatically for free tools.
const out = await a.call("hash", { text: "hello world", algo: "sha256" });
console.log(out.hex);
```

## Paid tools (USDC via x402)

Wallet-only tools (live search, headless browser, PDFs, durable memory) settle
in USDC. Pass an [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch)-wrapped
fetch — your wallet signs, the client never touches your key:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const a = new Agent402({ fetch: payFetch });
const article = await a.call("extract", { url: "https://example.com/article" });
```

## Workflows (skill packs)

For jobs that no single tool covers — e.g. "audit a domain", "build a stock
brief" — Agent402 ships curated multi-tool **skill packs**: 5–7 catalog tools
composed into a Claude-ready task template. Discover them the same way you'd
discover a tool:

```js
const packs = await a.findWorkflows("security audit");
// → [{ slug: "security-audit", title, tagline, toolSlugs, score, url, promptName }]

// Render the full prompt with arguments substituted in (same output as MCP prompts/get).
const { messages } = await a.getWorkflowPrompt("security-audit", { domain: "stripe.com" });
// → feed messages straight to any LLM
```

## API

| Method | What |
|---|---|
| `new Agent402({ baseUrl?, fetch?, cache?, fetchImpl? })` | `fetch` is your x402-wrapped fetch for paid tools (optional); `cache` (default `true`) memoizes deterministic results |
| `await a.find(task, { k = 5 })` | Resolve a plain-language task to the best-matching tools (route, price, schema, example) |
| `await a.findWorkflows(task, { k = 2 })` | Resolve a task to matching multi-tool workflow templates (skill packs) |
| `await a.getWorkflowPrompt(slug, args)` | Fetch the rendered prompt messages for a skill pack with arguments substituted in |
| `await a.call(slug, params, { idempotencyKey?, cache? })` | Call a tool; auto-pays (PoW for free tools, x402 for wallet-only); returns the JSON result |
| `Agent402.solvePow(pow)` | Solve a proof-of-work challenge object → an `X-Pow-Solution` value |
| `a.clearCache()` | Drop the in-memory result cache |

- **Zero dependencies** for the free/proof-of-work path (uses `node:crypto`).
- **Non-custodial:** paid settlement is your `@x402/fetch` + wallet; this client never sees your key.
- MIT licensed. Part of [Agent402](https://github.com/MikeyPetrillo/Agent402).
