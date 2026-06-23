# Paying with Compute (proof-of-work)

Agents without a wallet can pay for the **pure-CPU tools** (~1,100 of 1,323) by solving a small sha256 puzzle — a fraction of a second of the caller's own CPU. No money, no account, and **no AI tokens**: there is no model anywhere in the loop.

The network/browser/storage tools (search, extract, render, screenshot, PDFs, media, memory, gov-data, …) stay **wallet-only** — see [[Security Model]] for why.

## Protocol

1. `GET https://agent402.tools/api/pow/challenge?slug={tool}` → `{ challenge, difficulty, token, expiresAt }`
2. Find an integer `nonce` such that `sha256(challenge + ":" + nonce)` has at least `difficulty` (currently **16**) leading zero bits.
3. Retry the tool request with header `X-Pow-Solution: <token>:<nonce>`.

Challenges are **single-use**, **short-lived**, and **strictly scoped to one tool slug** — a solved challenge can never be replayed or retargeted at a different tool.

## Reference solver (Node, ~20 lines)

```js
import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };

const c = await (await fetch("https://agent402.tools/api/pow/challenge?slug=hash")).json();
let n = 0;
while (lz(createHash("sha256").update(`${c.challenge}:${n}`).digest()) < c.difficulty) n++;

const res = await fetch("https://agent402.tools/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Pow-Solution": `${c.token}:${n}` },
  body: JSON.stringify({ text: "hello world" }),
});
console.log(res.status, await res.json()); // 200 …
```

Difficulty 16 ≈ 65k hashes ≈ well under a second on any modern CPU — costly enough to stop bulk abuse, cheap enough to be a genuine free tier.

## Where it's accepted

- Direct HTTP, as above (`GET /api/pow` lists every eligible slug).
- The `agent402-mcp` npm server solves challenges automatically when no `AGENT_KEY` is configured.
- The hosted MCP connector at `/mcp` executes the same tool set free (rate-limited) without requiring the client to solve anything — see [[MCP Connector]].
