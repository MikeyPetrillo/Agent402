// Server-rendered technical guides — the prose layer for organic search.
// Machine surfaces (llms.txt, OpenAPI) serve agents; these serve the humans
// googling "x402 example" or "AI agent payments" before their agents do.
import { marked } from "marked";
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const GUIDES = [
  {
    slug: "x402-in-5-minutes",
    title: "Make your AI agent pay for what it needs: x402 in 5 minutes",
    description:
      "A working example of the x402 payment protocol: your agent calls an API, gets an HTTP 402 quote, pays USDC on Base (or Solana, Polygon, Arbitrum) from its own wallet, and gets the result — no signup, no API key.",
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

Fund a wallet with a little USDC on Base (or Solana, Polygon, Arbitrum — the payer needs no ETH on EVM chains), then:

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
  {
    slug: "x402-payments-toolkit",
    title: "Let your agent pay anyone: the non-custodial x402 payments toolkit",
    description:
      "Discover a 402 quote, resolve an ENS recipient, check USDC balance and gas, build the EIP-3009 authorization your agent signs with its own key, and verify the settlement on-chain — across Base, Polygon, Arbitrum, Optimism, and Ethereum. Agent402 never touches funds.",
    md: `
An autonomous agent that can *pay* is far more useful than one that can't — but
you don't want a middleman holding your money. Agent402's payments tools are
**non-custodial**: they help an agent move its *own* USDC with its *own* key.
Agent402 never holds, signs, or sends funds — it decodes quotes, reads public
chain state, and builds the authorization *you* sign. Everything below works on
**Base, Polygon, Arbitrum, Optimism, and Ethereum** (\`network\` param, default
base), and needs no API key.

## 1. What does this endpoint cost? — \`/api/x402-quote\`

Point it at any paid URL and get the decoded HTTP 402 terms:

\`\`\`bash
curl "https://agent402.tools/api/x402-quote?url=https://api.example.com/paid&method=GET"
# { "status": 402, "paymentRequired": true,
#   "accepts": [{ "scheme":"exact","network":"base","asset":"USDC","maxAmountRequired":"1000","payTo":"0x…" }] }
\`\`\`

## 2. Who am I paying? — \`/api/ens-resolve\`

Turn a human-readable name into a payable address:

\`\`\`bash
curl "https://agent402.tools/api/ens-resolve?name=vitalik.eth"
# { "name":"vitalik.eth", "address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "found":true }
\`\`\`

## 3. Can I afford it? — \`/api/usdc-balance\` + \`/api/gas-estimate\`

\`\`\`bash
curl "https://agent402.tools/api/usdc-balance?address=0xYOURWALLET&network=base"
# { "usdc":"12.5", "raw":"12500000", "network":"base" }
curl "https://agent402.tools/api/gas-estimate?network=base"
# { "gasPriceGwei":"0.0051", "network":"base" }
\`\`\`

## 4. Build the authorization to sign — \`/api/transfer-authorization\`

This returns the exact EIP-3009 \`transferWithAuthorization\` typed data for a
**gasless** USDC transfer. Agent402 builds it; your agent signs it locally:

\`\`\`bash
curl -X POST https://agent402.tools/api/transfer-authorization \\
  -H "Content-Type: application/json" \\
  -d '{"from":"0xYOURWALLET","to":"0xRECIPIENT","amount":0.01,"network":"base"}'
# { "typedData": { "domain":{...}, "primaryType":"TransferWithAuthorization", "message":{...} }, ... }
\`\`\`

Sign it with your own key — Agent402 never sees it:

\`\`\`js
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(process.env.AGENT_KEY);
const { typedData } = await (await fetch("https://agent402.tools/api/transfer-authorization", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: account.address, to: recipient, amount: 0.01 }),
})).json();
const signature = await account.signTypedData(typedData); // submit to the facilitator / payTo's x402 flow
\`\`\`

## 5. Did it settle? — \`/api/x402-verify\`

After a payment lands, confirm it on-chain — and optionally that it paid the
right address at least a minimum amount:

\`\`\`bash
curl "https://agent402.tools/api/x402-verify?hash=0xTXHASH&network=base&to=0xRECIPIENT&min=0.001"
# { "settled":true, "status":"success", "transfers":[{"from":"0x…","to":"0x…","usdc":"0.001"}], "matched":true }
\`\`\`

## Why non-custodial matters

Custodial "pay for me" services have to hold your funds — which means money
transmission, KYC/AML, and trust in a middleman. These tools never touch your
money: you keep your key, you sign, you send. That's the right architecture for
agent payments, and it's the one Agent402 ships. The whole kit is
[open source](https://github.com/MikeyPetrillo/Agent402) and priced per call in
USDC (or proof-of-work on the free tools).
`,
  },
];

const GUIDE_INDEX_CSS = `
.gi-wrap{max-width:1180px;margin:0 auto;padding:56px 30px;}
.gi-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;}
.gi-wrap h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;}
.gi-desc{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px;max-width:640px;}
.gi-list{display:flex;flex-direction:column;gap:20px;}
.gi-card{display:block;background:var(--card);border:1.5px solid var(--ink);padding:24px 26px;text-decoration:none;transition:border-color .2s;}
.gi-card:hover{border-color:var(--accent);}
.gi-card h2{font-family:var(--font-body);font-weight:800;font-size:20px;line-height:1.15;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink);}
.gi-card p{font-size:15px;line-height:1.55;color:var(--muted);margin:0;}
@media(max-width:600px){.gi-wrap h1{font-size:40px;}}
`;

const GUIDE_PAGE_CSS = `
.gp-wrap{max-width:760px;margin:0 auto;padding:56px 30px 48px;}
.gp-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;}
.gp-crumb{font-family:var(--font-mono);font-size:13px;color:var(--faint);margin-bottom:20px;}
.gp-crumb a{color:var(--accent);text-decoration:none;}
.gp-crumb a:hover{text-decoration:underline;}
.gp-wrap h1{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 28px;color:var(--ink);}
.gp-body{font-size:15px;line-height:1.55;color:var(--muted);}
.gp-body h2{font-family:var(--font-body);font-weight:800;font-size:22px;line-height:1.1;letter-spacing:-.02em;color:var(--ink);margin:32px 0 12px;}
.gp-body p{margin:0 0 16px;}
.gp-body ul,.gp-body ol{margin:0 0 16px;padding-left:24px;}
.gp-body li{margin-bottom:6px;}
.gp-body strong{color:var(--ink);}
.gp-body em{font-style:italic;}
.gp-body a{color:var(--accent);text-decoration:none;}
.gp-body a:hover{text-decoration:underline;}
.gp-body code{font-family:var(--font-mono);font-size:13px;background:var(--card);border:1px solid var(--hairline);padding:2px 6px;}
.gp-body pre{background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:13px;line-height:1.55;padding:16px 20px;overflow-x:auto;margin:0 0 16px;border:1.5px solid var(--ink);}
.gp-body pre code{background:none;border:none;padding:0;color:inherit;font-size:13px;}
.gp-back{display:inline-block;margin-top:28px;font-family:var(--font-mono);font-size:13px;color:var(--accent);text-decoration:none;font-weight:700;}
.gp-back:hover{text-decoration:underline;}
`;

export function guidesIndex(baseUrl) {
  const title = "Guides: payments and memory for AI agents";
  const description = "Practical guides to the machine-to-machine economy: paying APIs with x402 or proof-of-work, and durable wallet-keyed memory for autonomous agents.";
  const canonical = `${baseUrl}/guides`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", url: baseUrl },
  };

  const items = GUIDES.map(
    (g) => `<a href="/guides/${esc(g.slug)}" class="gi-card">
        <h2>${esc(g.title)}</h2>
        <p>${esc(g.description)}</p>
      </a>`
  ).join("\n      ");

  const body = `<div class="gi-wrap">
  <div class="gi-eyebrow">$ GET /guides</div>
  <h1>Guides</h1>
  <p class="gi-desc">Working code, no fluff — everything here runs against the live service.</p>
  <div class="gi-list">
      ${items}
  </div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss: GUIDE_INDEX_CSS, body });
}

export function guidePage(baseUrl, slug) {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) return null;

  const title = `${g.title} — Agent402`;
  const canonical = `${baseUrl}/guides/${g.slug}`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: g.title,
    description: g.description,
    url: canonical,
    image: `${baseUrl}/card.png`,
    author: { "@type": "Person", name: "Mike Petrillo", url: "https://github.com/MikeyPetrillo" },
    publisher: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
  };

  const body = `<div class="gp-wrap">
  <div class="gp-crumb"><a href="/">Home</a> / <a href="/guides">Guides</a> / ${esc(g.title)}</div>
  <h1>${esc(g.title)}</h1>
  <div class="gp-body">
    ${marked.parse(g.md)}
  </div>
  <a href="/guides" class="gp-back">Back to guides</a>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description: g.description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss: GUIDE_PAGE_CSS, body });
}

export const guideSlugs = () => GUIDES.map((g) => g.slug);
