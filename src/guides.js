// Server-rendered technical guides — the prose layer for organic search.
// Machine surfaces (llms.txt, OpenAPI) serve agents; these serve the humans
// googling "x402 example" or "AI agent payments" before their agents do.
import { marked } from "marked";

const GUIDES = [
  {
    slug: "x402-in-5-minutes",
    title: "Make your AI agent pay for what it needs: x402 in 5 minutes",
    description:
      "A working example of the x402 payment protocol: your agent calls an API, gets an HTTP 402 quote, pays USDC on Base from its own wallet, and gets the result — no signup, no API key.",
    md: `
The useful web hides behind signups, captchas, and API keys — none of which an
autonomous agent can obtain mid-task. [x402](https://x402.org) fixes this with
the HTTP status code that sat unused for thirty years: **402 Payment Required**.
Settlement infrastructure exists from Coinbase and Stripe; this guide uses a
live service ([agent402.tools](https://agent402.tools)) you can pay right now.

## The protocol in one paragraph

Your client calls a paid endpoint. The server replies \`402\` with a
machine-readable quote — price, asset (USDC), network (Base), pay-to address.
Your client signs a USDC transfer authorization from its own wallet (no gas
needed; the facilitator sponsors it) and retries the request with the payment
header. The server verifies, settles on-chain, and serves the result. Seconds,
end to end. **The payment is the identity** — no account ever existed.

## See a quote (free)

\`\`\`bash
curl -i -X POST https://agent402.tools/api/extract \\
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
# HTTP/2 402 … {"x402Version":2,"accepts":[{"price":"$0.005","network":"eip155:8453",…}]}
\`\`\`

## Pay it (JavaScript)

Fund a wallet with a little USDC on Base (the payer needs no ETH), then:

\`\`\`js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
console.log(await res.json()); // { title, markdown, wordCount, … }
\`\`\`

That one wrapped \`fetch\` now covers 1,000+ tools — browser rendering,
live search, PDFs, durable memory — each a flat $0.001–$0.02 per call.
The full catalog is machine-readable at
[/api/pricing](https://agent402.tools/api/pricing).

## Or from the command line

Stripe's open-source [purl](https://github.com/stripe/purl) is "curl for paid
endpoints":

\`\`\`bash
purl wallet add --name me --type evm -k 0xYOUR_KEY -p pass --set-active=true
purl "https://agent402.tools/api/convert/kilometers-to-miles?value=42"
\`\`\`

## No wallet? Pay with CPU

About 1,040 of the tools also accept **proof-of-work** — a sub-second sha256
puzzle solved by the caller, no money involved:

\`\`\`js
import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("https://agent402.tools/api/pow/challenge?slug=hash")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
const res = await fetch("https://agent402.tools/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Pow-Solution": c.token + ":" + n },
  body: JSON.stringify({ text: "hello world" }),
});
\`\`\`

Or skip all of this: paste \`https://agent402.tools/mcp\` into Claude as a
custom connector and the free tier just works, or run
\`npx -y agent402-mcp\` with an \`AGENT_KEY\` for the full catalog with spend
caps enforced before any payment is signed.

## Why this matters

Per-call payment with no accounts means an agent can acquire capabilities at
the moment it discovers it needs them — and the seller can prove every cent of
revenue on-chain. Every claim in this guide is verifiable: the server is
[open source](https://github.com/MikeyPetrillo/Agent402) and settled calls land
at a [public wallet](https://agent402.tools/api/stats).
`,
  },
  {
    slug: "durable-memory-for-agents",
    title: "Durable memory for AI agents — no accounts, the wallet is the identity",
    description:
      "How autonomous agents persist state across sessions and share it across owners using wallet-keyed memory: writes, cross-wallet grants, tamper-evident audit logs, and semantic recall — authenticated by payment, not API keys.",
    md: `
Agent sessions are ephemeral. The container that did three hours of careful
research is garbage-collected an hour later, and tomorrow's run starts blank.
Persisting state sounds easy — until you ask *what identity the state is keyed
to*. An autonomous agent can't sign up for a database, store an API key
safely, or do an OAuth dance.

It already holds the answer: **its wallet**. On
[agent402.tools](https://agent402.tools), the x402 payment that accompanies
every call proves control of a private key — so the paying wallet *is* the
authenticated identity, with zero credentials to store or leak.

## Write today, read next week, different machine

\`\`\`bash
# machine A, today ($0.002)
POST /api/memory   {"key":"deploy-fix","value":{"cause":"build OOM","fix":"NODE_VERSION=22"}}

# machine B, next week — same wallet key, nothing else
GET  /api/memory?key=deploy-fix
\`\`\`

Namespaces are isolated per wallet: only the wallet that wrote a key can read
it. TTLs expire what shouldn't live forever; deletes are owner-only.

## The unusual part: memory shared across owners

Two agents that **don't share an owner** can share state — payment identity is
the only primitive needed:

\`\`\`bash
# wallet A grants wallet B read access (time-boxed)
POST /api/memory/grant   {"grantee":"0xB…","mode":"read","ttlSeconds":86400}

# wallet B reads A's namespace by naming the owner
GET  /api/memory?key=deploy-fix&owner=0xA…
\`\`\`

Add \`POST /api/memory/incr\` — an atomic counter — and you have a
coordination primitive: two independent agents handing off jobs through one
shared number, no race conditions. Every access lands in a **hash-chained,
tamper-evident audit log** (\`GET /api/memory/log\`) so the namespace owner can
prove who did what, when.

## Semantic recall, no embeddings API required

\`\`\`bash
POST /api/memory/remember  {"text":"Railway deploy failed: build out of memory"}
POST /api/memory/recall    {"query":"why did the deploy break?","k":3}
\`\`\`

Store prose now, search it by meaning later. The default scorer is local and
deterministic — no LLM, no external API in the serving path.

## Why not just use a database?

You could — if you can keep credentials, run migrations, and pay a monthly
bill. The point of wallet-keyed memory is that an agent **mid-task** can't do
any of that, and doesn't need to: the credential it already holds for payment
doubles as its identity, the marginal cost is $0.002 a call, and state outlives
any single sandbox. The whole implementation is
[open source](https://github.com/MikeyPetrillo/Agent402) — see the
[memory wiki page](https://github.com/MikeyPetrillo/Agent402/wiki/Memory-and-Coordination)
for the full API.
`,
  },
  {
    slug: "sell-your-api-over-x402",
    title: "Sell your API to AI agents over x402 — no billing system required",
    description:
      "Put a per-call USDC paywall in front of any HTTP endpoint with the x402 protocol: quote over HTTP 402, settle on Base through a facilitator, and get discovered by agents — no accounts, invoices, or payment forms.",
    md: `
If you run an API, the next wave of customers can't sign up for it. Autonomous
agents don't have credit cards, can't pass captchas, and won't wait for a sales
call — but they hold funded wallets and speak HTTP. [x402](https://x402.org)
lets you charge them per call with about as much code as adding a middleware.

## The seller's side of the protocol

You return \`402 Payment Required\` with a quote (price, USDC, network, your
wallet address). The buyer signs a transfer authorization and retries; a
**facilitator** (Coinbase's is free; Stripe also operates x402 infrastructure)
verifies the signature and settles on-chain to your wallet. You never touch
keys, cards, or PCI anything — your "billing system" is one HTTP header check.

## Express example

\`\`\`js
import express from "express";
import { paymentMiddleware } from "@x402/express";

const app = express();
app.use(paymentMiddleware({
  payTo: "0xYOUR_WALLET",                     // USDC lands here, on Base
  routes: { "POST /api/summarize": { price: "$0.005" } },
}));
app.post("/api/summarize", (req, res) => res.json({ ok: true }));
\`\`\`

Set Coinbase CDP facilitator keys (free at portal.cdp.coinbase.com) and you're
settling real money on mainnet. Test the buyer side yourself with Stripe's
[purl](https://github.com/stripe/purl): \`purl http://localhost:3000/api/summarize\`.

## What we learned operating one (the honest part)

[agent402.tools](https://agent402.tools) runs ~1,083 paid endpoints this way —
[fully open source](https://github.com/MikeyPetrillo/Agent402). The lessons:

1. **x402 settles before your handler runs.** If your tool then fails, you took
   money for nothing. Anything that can't be served reliably (upstreams that
   block datacenter IPs, flaky APIs) should be removed, not monetized.
2. **Discovery is half the product.** Publish a machine-readable catalog
   (/api/pricing, OpenAPI, llms.txt) and register with the
   [x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar) — agents
   browse it by pay-to address.
3. **Trust is provable, so prove it.** Your revenue wallet is public; link it.
   Run your test suite against your own documented examples in CI. Anonymous
   sellers are the default in this economy — a named maintainer and an
   auditable repo are differentiation.
4. **Offer a free taste.** Pure-CPU endpoints can accept a
   [proof-of-work](/guides/x402-in-5-minutes) instead of money — it converts
   wallet-less agents into integrated users who fund a wallet later.
5. **Expose it over MCP too.** A hosted connector
   (\`https://agent402.tools/mcp\` is ours) puts your tools one paste away from
   every Claude user, and an npm MCP server with client-side spend caps makes
   paid adoption safe for buyers.

The entire stack described here — paywall, PoW tier, MCP servers, CI, even the
on-chain customer detector — is in
[one repo](https://github.com/MikeyPetrillo/Agent402) you can fork.
`,
  },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function shell(baseUrl, title, description, path, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Agent402</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${baseUrl}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${baseUrl}/card.png">
<meta name="twitter:card" content="summary_large_image">
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; }
  body { background:var(--bg); color:var(--fg); font:17px/1.7 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 64px; }
  h1 { font-size:1.9rem; line-height:1.25; } h2 { font-size:1.25rem; margin-top:36px; color:var(--accent); }
  a { color:var(--accent); } .muted { color:var(--muted); }
  pre { background:#0f1420; border:1px solid #1e2638; border-radius:10px; padding:14px 16px; overflow-x:auto; font-size:.85rem; line-height:1.55; }
  code { font-family:ui-monospace,Menlo,monospace; }
  p > code, li > code { background:#0f1420; padding:1px 6px; border-radius:6px; font-size:.85em; }
</style>
</head>
<body><div class="wrap">${body}
<p class="muted" style="margin-top:48px"><a href="/guides">← All guides</a> · <a href="/">agent402.tools</a> — ${"1,000+"} pay-per-call tools for AI agents.</p>
</div></body></html>`;
}

export function guidesIndex(baseUrl) {
  const items = GUIDES.map(
    (g) => `<h2 style="margin-top:28px"><a href="/guides/${g.slug}">${esc(g.title)}</a></h2><p class="muted">${esc(g.description)}</p>`
  ).join("\n");
  return shell(
    baseUrl,
    "Guides: payments and memory for AI agents",
    "Practical guides to the machine-to-machine economy: paying APIs with x402 or proof-of-work, and durable wallet-keyed memory for autonomous agents.",
    "/guides",
    `<h1>Guides</h1>\n<p class="muted">Working code, no fluff — everything here runs against the live service.</p>\n${items}`
  );
}

export function guidePage(baseUrl, slug) {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) return null;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: g.title,
    description: g.description,
    url: `${baseUrl}/guides/${g.slug}`,
    image: `${baseUrl}/card.png`,
    author: { "@type": "Person", name: "Mikey Petrillo", url: "https://github.com/MikeyPetrillo" },
    publisher: { "@type": "Organization", name: "Agent402", url: baseUrl },
  };
  const body = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<h1>${esc(g.title)}</h1>
${marked.parse(g.md)}`;
  return shell(baseUrl, g.title, g.description, `/guides/${g.slug}`, body);
}

export const guideSlugs = () => GUIDES.map((g) => g.slug);
