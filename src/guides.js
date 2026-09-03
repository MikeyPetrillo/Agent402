// Server-rendered technical guides — the prose layer for organic search.
// Machine surfaces (llms.txt, OpenAPI) serve agents; these serve the humans
// googling "x402 example" or "AI agent payments" before their agents do.
import { marked } from "marked";
// Headings carry ids (GitHub-style slugs) so the dev shortlinks (/claude ->
// /guides/agent-hosts#claude-code) and readers can deep-link a section.
// The id is computed from the heading's PLAIN TEXT (the tokens' text, never
// the rendered html), so no markup is ever part of the id.
export const headingId = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
const tokenText = (tokens) => (tokens || []).map((t) => (t.tokens ? tokenText(t.tokens) : (t.text ?? ""))).join("");
marked.use({ renderer: { heading({ tokens, depth }) { const html = this.parser.parseInline(tokens); return `<h${depth} id="${headingId(tokenText(tokens))}">${html}</h${depth}>\n`; } } });
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { RAILS_OR, RAILS_AMP } from "./rails.js";
import { TIERS, METERED_MAX_QUOTE_USD, EMBEDDINGS_PRICE } from "./tools/llm-gateway-kit.js";
// Derived at module load from the live tier table so the guide can never say a
// price the gateway does not charge (the first version typed these).
const FLAT_TIER_ROWS = Object.entries(TIERS)
  .filter(([slug, t]) => slug.startsWith("v1-chat") && !t.stealth && !t.lockedModel && !t.metered)
  .map(([slug, t]) => ({ slug, label: slug === "v1-chat" ? "base" : slug.replace("v1-chat-", "") + (t.router ? (slug.endsWith("grounded") ? " (web search on every call)" : " (routed)") : ""), path: t.route.split(" ")[1].replace("/chat/completions", ""), price: t.price < 0.01 ? t.price.toFixed(3) : t.price.toFixed(2), maxTokens: t.maxTokens }));
const FLAT_TIER_TABLE = "| tier | baseUrl path | per call | max output tokens |\n|---|---|---|---|\n" + FLAT_TIER_ROWS.map((r) => `| ${r.label} | \`${r.path}\` | $${r.price} | ${r.maxTokens} |`).join("\n");

const GUIDES = [
  {
    slug: "x402-in-5-minutes",
    title: "Make your AI agent pay for what it needs: x402 in 5 minutes",
    description:
      `A working example of the x402 payment protocol: your agent calls an API, gets an HTTP 402 quote, pays ${RAILS_OR} from its own wallet, and gets the result - no signup, no API key.`,
    md: `
The useful web hides behind signups, captchas, and API keys - none of which an
autonomous agent can obtain mid-task. [x402](https://x402.org) fixes this with
the HTTP status code that sat unused for thirty years: **402 Payment Required**.
Settlement infrastructure exists from Coinbase, with open client tooling from Stripe; this guide uses a
live service ([agent402.tools](https://agent402.tools)) you can pay right now.

## The protocol in one paragraph

Your client calls a paid endpoint. The server replies \`402\` with a
machine-readable quote - price, asset (USDC), network (Base), pay-to address.
Your client signs a USDC transfer authorization from its own wallet (no gas
needed; the facilitator sponsors it) and retries the request with the payment
header. The server verifies, settles on-chain, and serves the result. Seconds,
end to end. **The payment is the identity** - no account ever existed.

## See a quote (free)

\`\`\`bash
curl -i -X POST https://agent402.tools/api/extract \\
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
# HTTP/2 402 … {"x402Version":2,"accepts":[{"price":"$0.010","network":"eip155:8453",…}]}
\`\`\`

## Pay it (JavaScript)

Fund a wallet with a little ${RAILS_OR} (no gas needed on EVM chains - the facilitator sponsors it), then:

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

That one wrapped \`fetch\` now covers 500+ tools - browser rendering,
live search, PDFs, durable memory - most a flat $0.001–$0.02 per call, with premium AI, media and multi-tool packs priced higher.
The full catalog is machine-readable at
[/api/pricing](https://agent402.tools/api/pricing).

## Or from the command line

Stripe's open-source [purl](https://github.com/stripe/purl) is "curl for paid
endpoints":

\`\`\`bash
purl wallet add --name me --type evm -k 0xYOUR_KEY -p pass --set-active=true
purl "https://agent402.tools/api/dns?name=example.com&type=A"
\`\`\`

## No wallet? Pay with CPU

Most of the tools also accept **proof-of-work** - a sub-second sha256
puzzle solved by the caller, no money involved (the exact free-tier count is
always current at [/api/pricing](https://agent402.tools/api/pricing)):

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
the moment it discovers it needs them - and the seller can prove every cent of
revenue on-chain. Every claim in this guide is verifiable: the server is
[open source](https://github.com/MikeyPetrillo/Agent402) and settled calls land
at a [public wallet](https://agent402.tools/api/stats).
`,
  },
  {
    slug: "durable-memory-for-agents",
    title: "Durable memory for AI agents - no accounts, the wallet is the identity",
    description:
      "How autonomous agents persist state across sessions and share it across owners using wallet-keyed memory: writes, cross-wallet grants, tamper-evident audit logs, and semantic recall - authenticated by payment, not API keys.",
    md: `
Agent sessions are ephemeral. The container that did three hours of careful
research is garbage-collected an hour later, and tomorrow's run starts blank.
Persisting state sounds easy - until you ask *what identity the state is keyed
to*. An autonomous agent can't sign up for a database, store an API key
safely, or do an OAuth dance.

It already holds the answer: **its wallet**. On
[agent402.tools](https://agent402.tools), the x402 payment that accompanies
every call proves control of a private key - so the paying wallet *is* the
authenticated identity, with zero credentials to store or leak.

## Write today, read next week, different machine

\`\`\`bash
# machine A, today ($0.002)
POST /api/memory   {"key":"deploy-fix","value":{"cause":"build OOM","fix":"NODE_VERSION=22"}}

# machine B, next week - same wallet key, nothing else
GET  /api/memory?key=deploy-fix
\`\`\`

Namespaces are isolated per wallet: only the wallet that wrote a key can read
it. TTLs expire what shouldn't live forever; deletes are owner-only.

## The unusual part: memory shared across owners

Two agents that **don't share an owner** can share state - payment identity is
the only primitive needed:

\`\`\`bash
# wallet A grants wallet B read access (time-boxed)
POST /api/memory/grant   {"grantee":"0xB…","mode":"read","ttlSeconds":86400}

# wallet B reads A's namespace by naming the owner
GET  /api/memory?key=deploy-fix&owner=0xA…
\`\`\`

Add \`POST /api/memory/incr\` - an atomic counter - and you have a
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
deterministic - no LLM, no external API in the serving path.

## Why not just use a database?

You could - if you can keep credentials, run migrations, and pay a monthly
bill. The point of wallet-keyed memory is that an agent **mid-task** can't do
any of that, and doesn't need to: the credential it already holds for payment
doubles as its identity, the marginal cost is $0.002 a call, and state outlives
any single sandbox. The whole implementation is
[open source](https://github.com/MikeyPetrillo/Agent402) - see the
[memory wiki page](https://github.com/MikeyPetrillo/Agent402/wiki/Memory-and-Coordination)
for the full API.
`,
  },
  {
    slug: "sell-your-api-over-x402",
    title: "Sell your API to AI agents over x402 - no billing system required",
    description:
      `Put a per-call USDC paywall in front of any HTTP endpoint with the x402 protocol: quote over HTTP 402, settle on ${RAILS_AMP} through a facilitator, and get discovered by agents - no accounts, invoices, or payment forms.`,
    md: `
If you run an API, the next wave of customers can't sign up for it. Autonomous
agents don't have credit cards, can't pass captchas, and won't wait for a sales
call - but they hold funded wallets and speak HTTP. [x402](https://x402.org)
lets you charge them per call with about as much code as adding a middleware.

## The seller's side of the protocol

You return \`402 Payment Required\` with a quote (price, USDC, network, your
wallet address). The buyer signs a transfer authorization and retries; a
**facilitator** (Coinbase's is free; Stripe also operates x402 infrastructure)
verifies the signature and settles on-chain to your wallet. You never touch
keys, cards, or PCI anything - your "billing system" is one HTTP header check.

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

[agent402.tools](https://agent402.tools) runs ~500+ paid endpoints this way -
[fully open source](https://github.com/MikeyPetrillo/Agent402). The lessons:

1. **x402 settles before your handler runs.** If your tool then fails, you took
   money for nothing. Anything that can't be served reliably (upstreams that
   block datacenter IPs, flaky APIs) should be removed, not monetized.
2. **Discovery is half the product.** Publish a machine-readable catalog
   (/api/pricing, OpenAPI, llms.txt) and register with the
   [x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar) - agents
   browse it by pay-to address.
3. **Trust is provable, so prove it.** Your revenue wallet is public; link it.
   Run your test suite against your own documented examples in CI. Anonymous
   sellers are the default in this economy - a named maintainer and an
   auditable repo are differentiation.
4. **Offer a free taste.** Pure-CPU endpoints can accept a
   [proof-of-work](/guides/x402-in-5-minutes) instead of money - it converts
   wallet-less agents into integrated users who fund a wallet later.
5. **Expose it over MCP too.** A hosted connector
   (\`https://agent402.tools/mcp\` is ours) puts your tools one paste away from
   every Claude user, and an npm MCP server with client-side spend caps makes
   paid adoption safe for buyers.

The entire stack described here - paywall, PoW tier, MCP servers, CI, even the
on-chain customer detector - is in
[one repo](https://github.com/MikeyPetrillo/Agent402) you can fork.
`,
  },
  {
    slug: "x402-payments-toolkit",
    title: "Let your agent pay anyone: the non-custodial x402 payments toolkit",
    description:
      "Discover a 402 quote, resolve an ENS recipient, check USDC balance and gas, build the EIP-3009 authorization your agent signs with its own key, and verify the settlement on-chain - across Base, Polygon, Arbitrum, Optimism, Ethereum, and Robinhood Chain. Agent402 never touches funds.",
    md: `
An autonomous agent that can *pay* is far more useful than one that can't - but
you don't want a middleman holding your money. Agent402's payments tools are
**non-custodial**: they help an agent move its *own* USDC with its *own* key.
Agent402 never holds, signs, or sends funds - it decodes quotes, reads public
chain state, and builds the authorization *you* sign. Everything below works on
**Base, Polygon, Arbitrum, Optimism, Ethereum, and Robinhood Chain** (\`network\` param, default
base), and needs no API key.

## 1. What does this endpoint cost? - \`/api/x402-quote\`

Point it at any paid URL and get the decoded HTTP 402 terms:

\`\`\`bash
curl "https://agent402.tools/api/x402-quote?url=https://api.example.com/paid&method=GET"
# { "status": 402, "paymentRequired": true,
#   "accepts": [{ "scheme":"exact","network":"base","asset":"USDC","maxAmountRequired":"1000","payTo":"0x…" }] }
\`\`\`

## 2. Who am I paying? - \`/api/ens-resolve\`

Turn a human-readable name into a payable address:

\`\`\`bash
curl "https://agent402.tools/api/ens-resolve?name=vitalik.eth"
# { "name":"vitalik.eth", "address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "found":true }
\`\`\`

## 3. Can I afford it? - \`/api/usdc-balance\` + \`/api/gas-estimate\`

\`\`\`bash
curl "https://agent402.tools/api/usdc-balance?address=0xYOURWALLET&network=base"
# { "usdc":"12.5", "raw":"12500000", "network":"base" }
curl "https://agent402.tools/api/gas-estimate?network=base"
# { "gasPriceGwei":"0.0051", "network":"base" }
\`\`\`

## 4. Build the authorization to sign - \`/api/transfer-authorization\`

This returns the exact EIP-3009 \`transferWithAuthorization\` typed data for a
**gasless** USDC transfer. Agent402 builds it; your agent signs it locally:

\`\`\`bash
curl -X POST https://agent402.tools/api/transfer-authorization \\
  -H "Content-Type: application/json" \\
  -d '{"from":"0xYOURWALLET","to":"0xRECIPIENT","amount":0.01,"network":"base"}'
# { "typedData": { "domain":{...}, "primaryType":"TransferWithAuthorization", "message":{...} }, ... }
\`\`\`

Sign it with your own key - Agent402 never sees it:

\`\`\`js
import { privateKeyToAccount } from "viem/accounts";
const account = privateKeyToAccount(process.env.AGENT_KEY);
const { typedData } = await (await fetch("https://agent402.tools/api/transfer-authorization", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: account.address, to: recipient, amount: 0.01 }),
})).json();
const signature = await account.signTypedData(typedData); // submit to the facilitator / payTo's x402 flow
\`\`\`

## 5. Did it settle? - \`/api/x402-verify\`

After a payment lands, confirm it on-chain - and optionally that it paid the
right address at least a minimum amount:

\`\`\`bash
curl "https://agent402.tools/api/x402-verify?hash=0xTXHASH&network=base&to=0xRECIPIENT&min=0.001"
# { "settled":true, "status":"success", "transfers":[{"from":"0x…","to":"0x…","usdc":"0.001"}], "matched":true }
\`\`\`

## Why non-custodial matters

Custodial "pay for me" services have to hold your funds - which means money
transmission, KYC/AML, and trust in a middleman. These tools never touch your
money: you keep your key, you sign, you send. That's the right architecture for
agent payments, and it's the one Agent402 ships. The whole kit is
[open source](https://github.com/MikeyPetrillo/Agent402) and priced per call in
USDC (or proof-of-work on the free tools).
`,
  },
  {
    slug: "usdg-payments-robinhood-chain",
    title: "Accept USDG payments on Robinhood Chain over x402",
    description:
      "How AI agents pay in USDG (Global Dollar) on Robinhood Chain via the x402 protocol - and how to accept it as a seller: chain parameters, gasless EIP-3009 settlement, buyer code, and how to verify a settlement on-chain.",
    md: `
Robinhood Chain (an Arbitrum Orbit L2, chain id **4663**) reached mainnet on
2026-07-01, and its canonical stablecoin is **USDG (Global Dollar)** - not
Circle USDC. Agent402 settled a real x402 payment in USDG on the chain's
second day of mainnet, and this guide documents everything that took: the
chain parameters, the buyer flow, the seller config, and how to recognize an
x402 settlement on a block explorer.

## Chain parameters

| | |
|---|---|
| Chain id | 4663 (CAIP-2: \`eip155:4663\`) |
| RPC | \`https://rpc.mainnet.chain.robinhood.com\` |
| Explorer | \`https://robinhoodchain.blockscout.com\` |
| Stablecoin | USDG (Global Dollar) - \`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168\`, 6 decimals |
| EIP-712 domain | name \`"Global Dollar"\`, version \`"1"\` |

## How a payment works (same x402, different stablecoin)

Nothing about the protocol changes: the buyer hits a paid endpoint, gets an
HTTP **402** whose \`accepts\` includes an \`eip155:4663\` option carrying the
USDG contract address and its EIP-712 domain, signs an **EIP-3009
\`transferWithAuthorization\`** with its own key, and retries. A facilitator
submits the transfer on-chain and pays the gas - the buyer needs only USDG,
no ETH, no bridge, no account.

## Buy something on Robinhood Chain (JavaScript)

The standard x402 EVM client signs USDG as-is (asset + domain come from the
402's \`accepts\` entry). One subtlety: a multi-chain seller offers several
networks, and the default client may pick another chain - filter the accepts
to \`eip155:4663\` to force USDG settlement:

\`\`\`js
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const http = new x402HTTPClient(client);

const url = "https://agent402.tools/api/hash";
const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello" }) };
const challenge = await fetch(url, init);                       // → 402
const required = http.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.json().catch(() => undefined));
const robinhood = required.accepts.filter((a) => a.network === "eip155:4663");
const payload = await client.createPaymentPayload({ ...required, accepts: robinhood });
const res = await fetch(url, { ...init, headers: { ...init.headers, ...http.encodePaymentSignatureHeader(payload) } });
// 200 - and the PAYMENT-RESPONSE header carries the on-chain tx hash
\`\`\`

## Accept USDG as a seller (self-hosted Agent402)

The open-source server ships the rail; enabling it is config:

\`\`\`bash
PAYMENT_NETWORKS=base,solana,polygon,arbitrum,stellar,robinhood \\
ROBINHOOD_FACILITATOR_URL=<an x402 facilitator that settles eip155:4663> \\
WALLET_ADDRESS=0xYourRevenueWallet npm start
\`\`\`

Every paid route's 402 now offers USDG on Robinhood Chain alongside USDC on
the other chains. If the facilitator URL is unset, the server degrades
gracefully - the robinhood option is simply omitted; every other rail keeps
serving.

## How to recognize an x402 settlement on Blockscout

On-chain there is no "402" label - the tell is the shape of the transaction:

1. **Method is \`transferWithAuthorization\`** (EIP-3009, selector
   \`0xe3ee160e\`) on the USDG contract - not a plain \`transfer\`.
2. **The tx sender is the facilitator's relayer**, not the buyer - the buyer
   only signed; it paid no gas. "Sender ≠ the address whose USDG moved" is
   the gasless-settlement signature.
3. **The decoded transfer** shows \`from\` = the buyer's wallet, \`to\` = the
   seller's revenue wallet, value = the quoted price.

A real example - the settlement that verified this guide:
[\`0xae8e3e40…f826\`](https://robinhoodchain.blockscout.com/tx/0xae8e3e4048a28a1db30ad17ac83d998885623c764d0e3d27abf8e817f578f826).

## Reads, not just payments

Agent402's keyless chain tools speak Robinhood Chain too - \`tx-status\` and
\`gas-estimate\` accept \`network=robinhood\` against the public RPC, so an
agent can verify its own settlement for a fraction of a cent without an RPC key.
`,
  },
  {
    slug: "create-agent-wallet",
    title: "Give your agent a wallet - non-custodial, from zero to first x402 payment",
    description:
      "The secure way to create and fund a wallet for an AI agent: generate the key locally (it never touches any server, including ours), rehearse the full x402 payment loop with faucet USDC on Base Sepolia, then fund it for real with a card via a single-use Coinbase Onramp link.",
    md: `
Agents need wallets, and the single most important property of an agent
wallet is that **nobody else ever sees the private key** - not a SaaS,
not a marketplace, and not Agent402. This guide is the flow we test in CI
end to end: a keypair born inside the test runner completes a real x402
purchase, and the run fails if the key ever appears in any log.

## The trust model, stated plainly

- **Your key is generated on YOUR machine** and never transmitted. Every
  Agent402 tool below takes only your **address** - public information.
- **Payments are gasless.** The x402 "exact" scheme uses EIP-3009
  \`transferWithAuthorization\`: your agent signs an off-chain
  authorization and the facilitator pays the gas. A fresh wallet needs
  only USDC - no ETH, ever.
- **Rehearse before you risk.** The full payment loop runs on Base
  Sepolia with free faucet USDC first; the mainnet flow is byte-for-byte
  identical.

## 1. Create the wallet (locally - one line)

\`\`\`js
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const pk = generatePrivateKey();          // stays on YOUR machine
const account = privateKeyToAccount(pk);
console.log("agent address:", account.address);  // the ONLY thing you share
\`\`\`

Store \`pk\` in your secret manager (env var, keychain, KMS) - never in
code, never in git. If you prefer managed custody, Coinbase's
[Embedded Wallets](https://docs.cdp.coinbase.com/) give end users
email-login wallets where you never handle keys at all; everything below
works the same since only addresses are exchanged.

## 2. Rehearse on testnet (free money)

Fund the new address with testnet USDC via the paid
[\`testnet-fund\`](/tools/testnet-fund) tool - a tenth of a cent buys a
full testnet dollar from the Coinbase faucet:

\`\`\`bash
curl -X POST https://agent402.tools/api/testnet-fund \\
  -H "Content-Type: application/json" \\
  -d '{"address":"<your agent address>","token":"usdc"}'
\`\`\`

Then point your x402 client at any base-sepolia seller (or run the
open-source Agent402 server locally with \`NETWORK=base-sepolia\`) and
make a paid call:

\`\`\`js
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("http://localhost:3000/api/hash", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "first paid call" }),
});
// The PAYMENT-RESPONSE header carries the on-chain settlement tx.
\`\`\`

## 3. Fund it for real

When the rehearsal settles, fund the same address with real USDC on Base.
Two ways:

- **Card / Apple Pay** - [\`onramp-link\`](/tools/onramp-link) mints a
  single-use Coinbase Onramp URL for your agent's address with a
  fee-inclusive quote. Open it, pay, done.
- **Transfer** - send USDC on Base from any exchange or wallet to the
  agent's address.

Verify with [\`wallet-balances\`](/tools/wallet-balances), then the same
buyer code works against every seller in [the index](/index) - and every
tool here. Budget guardrails: the
[agent402-mcp](https://www.npmjs.com/package/agent402-mcp) server adds
pre-signature spend controls (per-call and per-session caps) on top.

## How we hold ourselves to this

The exact flow above runs in our CI as a gated test: a **fresh keypair is
generated inside the runner**, faucet-funded, and completes a real x402
settlement against a paid-mode server - then the test scans every byte of
its own output and the server's full log for the key material (all
prefix/case forms) and **fails on any hit**. Keys in, addresses out,
provably.
`,
  },
  {
    slug: "smart-order-router",
    title: "One payment, any proven seller: the x402 Smart Order Router",
    description:
      "Describe a task, pay once, and the router resolves the best tool - from Agent402's own 500+ catalog or from any PROVEN external x402 seller in the open economy - pays it on your behalf on the chain you paid on (Base or Algorand), and relays the result with an on-chain receipt.",
    md: `
The open x402 economy has a discovery problem and a trust problem. Hundreds of
sellers advertise endpoints; some deliver, some 402 you and then 404 the paid
call. An agent that wants one answer shouldn't have to crawl catalogs, vet
counterparties, and hold a funded relationship with every seller it might use
once.

**Route-and-execute** collapses all of that into one call: describe the task,
pay a single flat price, get the result and a receipt. If the best tool is in
Agent402's own 500+ catalog, it runs internally. If it lives with an external
seller in the open index, **we pay that seller from our own wallet on your
behalf** and relay the output. Two on-chain settlements, one request, and the
counterparty risk stays on our side of the fee.

## The three tiers

| Route | Price | Covers tools up to |
| --- | --- | --- |
| \`POST /api/route/execute\` | $0.01 | $0.005 |
| \`POST /api/route/execute-plus\` | $0.05 | $0.04 (the proportional middle rung - a $0.02 tool costs $0.05 through the router, not $0.55) |
| \`POST /api/route/execute-max\` | $0.55 | $0.50 (the top tier) |

\`GET /api/route?q=<task>\` is the free quote: it names the best match and the
exact tier that can execute it, so there is never any guessing.

## Internal dispatch (any chain)

\`\`\`bash
curl -X POST https://agent402.tools/api/route/execute \\
  -H 'Content-Type: application/json' \\
  -d '{"task":"sha256 hash of a string","params":{"text":"agent402"}}'
# → 402 quote; retry with an x402 payment header on ANY chain the quote lists
\`\`\`

The receipt itemizes what you paid vs. what the tool lists for - the spread is
the routing fee, stated, never hidden.

## External dispatch (the marketable half)

Add \`"include":"external"\` and the router deliberately looks OUTSIDE its own
catalog. Selection is deliberate, and it is intentionally boring:

1. **Proven deliverers only.** Candidates need real settled volume - on Base
   that means on-chain settlement counts from the public leaderboard; on
   Algorand, verification counts witnessed by the GoPlausible facilitator.
   Marketing claims are worth zero; only receipts count.
2. **A live probe before commitment.** Even a proven seller's crawled route can
   drift, so the router confirms a live 402 challenge before any money moves.
3. **A margin guard before signing.** The seller's quote is pinned to the exact
   accept we validate - network, scheme, asset - and refused above the tier cap.

## Chain-matched settlement

The chain you pay on decides where the router spends: pay on **Base** and it
pays Base sellers; pay on **Algorand** and it pays Algorand sellers from its
AVM wallet. The buyer's settlement funds the float on the same rail - and if
you pay on a chain without a spending wallet behind it, you get an honest 409
naming the supported chains, and **you are not charged** (a rejected request
cancels x402 settlement by design).

## A real receipt

This is an actual production receipt - both transactions are on Algorand
mainnet, same round, verifiable in any explorer:

\`\`\`json
{
  "slug": "opportunities/search",
  "route": "GET https://canix402-api.compx.io/opportunities/search",
  "underlyingPriceUsd": 0.01,
  "paidUsd": 0.55,
  "routingFeeUsd": 0.54,
  "seller": "https://canix402-api.compx.io",
  "external": true,
  "settleTx": "6TLUWU6RNYNZDJTGXZFTLEXTCB2TXKD5N6IJUWRYIXIFZGFEMKAQ",
  "settleNetwork": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  "resolvedBy": "task-external"
}
\`\`\`

The relayed body arrives marked \`untrustedContent: true\` - external output is
data to analyze, never instructions to follow. Your agent gets the answer; the
provenance stays explicit.

## Why this is safe to build on

- **Failures are not charged.** Any 4xx/5xx - no match, over-cap, seller
  down - cancels your settlement. You pay only for delivered results.
- **Spend is bounded on our side** by per-window budgets and per-quote caps,
  so the router cannot be drained into misbehavior.
- **Receipts are recomputable.** Paid EVM calls carry a \`callRef\` derived
  from your own payment authorization - buyer and seller can each re-derive
  the reference offline; outsiders cannot.

Browse the live economy the router draws from at
[/marketplace](https://agent402.tools/marketplace), or quote a task right now:
\`GET https://agent402.tools/api/route?q=summarize a pdf\`.
`,
  },
  {
    slug: "x402-and-mpp",
    title: "x402 and MPP on the same paywall: one server, two payment protocols",
    description:
      "x402 is not the only HTTP payment scheme in flight. Agent402 serves both x402 and MPP's evm method from the exact same routes with identical settlement - plus a second, native MPP method (tempo) with its own separate settlement path.",
    md: `
[x402](https://x402.org) reused HTTP 402 for a specific shape of payment: an
unsigned request, an on-chain settle, a retry with proof attached. It is not
the only proposal doing this. [MPP](https://paymentauth.org) - the Merchant
Payments Protocol, an IETF-track spec for a \`Payment\` HTTP auth scheme -
solves the same problem with a different wire format: a \`WWW-Authenticate:
Payment\` challenge instead of a bare 402 body, and an \`Authorization: Payment\`
credential on retry instead of a custom header.

Two clients, two conventions, one seller who doesn't want to run two paywalls.
So Agent402 speaks both, from the same routes, with the same settlement
underneath - for MPP's \`evm\` method specifically.

**MPP itself now has a second method, \`tempo\`, that this guide's "shim"
model does NOT cover.** Tempo (the chain MPP's own reference implementation
targets) settles natively via TIP-1034/TIP-20 primitives through Tempo's own
relay - not EIP-3009, no x402 facilitator involved, a genuinely separate
settlement path from everything below. Every 402 on this server now carries
BOTH \`evm\` and \`tempo\` MPP challenges (buyer's client picks whichever it
speaks), but only \`evm\`'s mechanics are what the rest of this guide
describes.

## What actually changes on the wire (the \`evm\` method)

Nothing about settlement. **\`@x402/express\` keeps sole settlement
authority** - it still verifies, still settles, still decides pass or fail.
What changes is the envelope around it:

- A 402 also carries \`WWW-Authenticate: Payment\`, one HMAC-bound challenge
  per EVM rail we offer. The x402 \`accepts\` entry for that rail rides inside
  the challenge's own metadata, verbatim - so the challenge needs nothing
  stored server-side to issue or check later. Same statelessness x402 already
  has, extended to a second header.
- An inbound \`Authorization: Payment\` credential that verifies against that
  HMAC gets re-encoded as \`PAYMENT-SIGNATURE\` and falls through the normal
  x402 pipeline unchanged - the same replay guard, the same payer
  attribution, the same idempotency-key handling an x402 buyer gets.
- A settled 200 mirrors its \`PAYMENT-RESPONSE\` back as \`Payment-Receipt\`,
  MPP's expected receipt header.

The shim is a pure translation layer sitting in front of the paywall, not a
second payment path beside it. \`mppx\` (the reference codec) is only used for
encode/decode primitives here - its own request-guard and settle path are
never mounted, because two components with settlement authority is how you
get a double-settle bug.

## Try it

If you already have an MPP-capable client, point it at any paid Agent402
route the normal way - no separate config, no MPP-specific endpoint:

\`\`\`bash
curl -i -X POST https://agent402.tools/api/hash -d '{"text":"hi","algo":"sha256"}'
# HTTP/2 402
# www-authenticate: Payment realm="agent402.tools", evm=eip155:8453;charge="…"
\`\`\`

Sign against that challenge the way your MPP client already knows how to,
retry with \`Authorization: Payment ...\`, and you get back \`200\` plus a
\`Payment-Receipt\` header - not a custom Agent402 format, the receipt shape
MPP itself defines.

## One thing to get right: the EIP-712 domain name

An \`evm\`/\`charge\` credential is an EIP-3009 \`TransferWithAuthorization\`
signed under the **token's own EIP-712 domain**, and that domain's \`name\` is
not the same on every chain. Base USDC is \`"USD Coin"\`. Celo, Monad and Sei
USDC each report \`"USDC"\`. A client that hardcodes one of them signs a digest
that no facilitator and no contract will accept on the chains that use the
other, and the failure is quiet: the signature is well-formed, so it looks like
a rejected payment rather than a wrong one.

You never have to guess. The challenge carries the exact x402 accepts entry it
was minted from, and that entry's \`extra.name\` and \`extra.version\` are the
domain to sign under, read from the token on chain.

If a credential does arrive signed under a different known name, we recover the
signer and recognise it before spending a facilitator round trip on it. You get
a \`402\` with an RFC 9457 \`application/problem+json\` body naming both the name
you signed under and the one the token uses, so the mistake is readable instead
of looking like an outage. That response also carries no \`WWW-Authenticate\`
header, on purpose: a client whose manager prefers MPP has nothing to select and
falls through to the x402 offer sitting in the same \`402\`, which the same wallet
can pay today. It is a short, self-clearing hold, and any request that presents a
credential is never held.

## Why bother running two protocols

Because the buyer shouldn't have to guess which one a seller picked. An agent
built against MPP tooling should be able to pay an x402-native seller without
a special case, and vice versa - and that only holds if sellers on both sides
actually do it, not just say they support it. This one is verified end to
end: a real \`mppx\` client buying over the native wire against this server,
one verify-and-settle, the EIP-712 signature checked against Base USDC's
actual on-chain domain, x402 traffic on the same routes untouched, and a
tampered or expired challenge rejected before it reaches a handler.

Rollout is a single switch server-side (present or absent, no partial state),
and which EVM rails get an MPP challenge is configurable per deployment - so
a seller can offer MPP on their primary chain without promising it everywhere
they offer x402. The two protocols don't have to agree on everything to both
work today.
`,
  },
  {
    slug: "why-twelve-chains",
    title: "Why Agent402 settles on twelve chains instead of just Base",
    description:
      "Base is where x402 volume actually is today. Agent402 also settles on Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, Algorand, and Robinhood Chain (USDG) anyway - here's the actual reason, chain by chain.",
    md: `
Most x402 volume, ours included, settles on Base. That's not a secret and
this guide isn't going to pretend otherwise. So the honest question is: why
run eleven more rails if that's where the traffic already is?

## The reason isn't "more chains, more revenue"

It's optionality. An agent doesn't get to choose what chain its wallet
already holds USDC on - it was funded once, for some other reason, on
whatever chain that happened to be. A seller who only accepts Base is
invisible to every agent funded anywhere else, no matter how good the tool
is. Twelve rails means twelve populations of already-funded buyers who never
have to bridge, swap, or wait for a transfer just to pay for one API call.

## What's actually live, and who settles it

Every rail below is a real, working \`payTo\` you can quote against right now
- \`GET https://agent402.tools/api/pricing\` lists the live \`accepts\` for any
tool, per network:

- **Base** - the primary rail, settled via Coinbase's CDP facilitator (also
  where [x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar)
  discovery lives).
- **Solana, Polygon, Arbitrum, Avalanche, Sei** - settled via the PayAI
  facilitator, free up to a generous monthly settlement quota.
- **Optimism** - settled via Solvador, a fee-charging facilitator; the price
  quoted on Optimism is bumped to cover that fee, so what you're quoted is
  what actually clears.
- **Monad, Celo** - each on its own dedicated facilitator.
- **Stellar** - USDC via a Soroban-based facilitator (OpenZeppelin Channels);
  settlement here is confirmed against the chain itself, not just trusted
  from the facilitator's word, because Stellar's ~5-second ledger close can
  outlast a synchronous HTTP request.
- **Algorand** - USDC via a dedicated AVM facilitator (GoPlausible); every
  payment carries a signed validity window sized to the tool it's paying
  for, so a slow tool can never receive a payment that expires mid-call.
- **Robinhood Chain** - the one non-USDC rail: USDG, via a keyless
  facilitator.

Every facilitator is health-checked at boot. One going down drops only its
own rail from the offer - the other eleven, and the free proof-of-work tier,
are unaffected.

## What doesn't change per chain

The guarantee is identical everywhere: a failed or unmatched call never
settles, regardless of which of the twelve rails it failed on. Chain choice
changes *where* the USDC moves, never *whether* a bad call gets charged.

## The Smart Order Router uses this directly

When [the router](/guides/smart-order-router) pays an external seller on
your behalf, it settles on the SAME chain you paid it on - an Algorand
payment funds an Algorand purchase, a Base payment funds a Base purchase.
Twelve rails isn't just about who can pay us; it's what lets the router keep
your money on the chain you already trusted it on, instead of quietly
routing everything through one chain regardless of what you sent.
`,
  },
  {
    slug: "pay-with-coinbase-agentic-wallet",
    title: "Pay Agent402 from Coinbase's own agent tooling: Agentic Wallet CLI, Agentic Wallet MCP, purl, and the CDP SDK",
    description:
      "Already holding a Coinbase Agentic Wallet, the Agentic Wallet MCP tools, Stripe's purl, or a CDP-managed wallet in code? Every Agent402 endpoint is a plain x402 resource on Base, so those pay it unchanged - here are the exact commands, the spend caps to set, and the two extensions we honour (payment-identifier, bazaar).",
    md: `
Agent402 is indexed on the Coinbase x402 Bazaar and every paid endpoint is a
plain x402 v2 resource settling USDC on Base (plus eleven more rails). So the
buyer tooling Coinbase and Stripe ship for x402 pays it with no Agent402-specific
setup. This guide is the command sheet. Nothing here needs an API key from us:
the payment is the identity.

## Agentic Wallet CLI (\`awal\`)

Coinbase's wallet CLI for agents signs x402 payments from a hosted Agentic
Wallet. Sign in once, then discover and pay:

\`\`\`bash
npx awal@latest auth login you@example.com      # one-time sign-in
npx awal@latest status

# find us on the Bazaar (keyword search over the x402 index; cached 12h)
npx awal@latest x402 bazaar search "decode a VIN" -k 5
npx awal@latest x402 details https://agent402.tools/api/vin-decode

# pay a GET endpoint (query params with -q), capped at $0.01 (atomic USDC units)
npx awal@latest x402 pay https://agent402.tools/api/vin-decode -q '{"vin":"1HGCM82633A004352"}' --max-amount 10000

# pay a POST endpoint with a JSON body
npx awal@latest x402 pay https://agent402.tools/api/extract -X POST \\
  -d '{"url":"https://example.com/article"}' --max-amount 10000 --json
\`\`\`

\`--max-amount\` is the per-payment ceiling in atomic units (USDC has 6
decimals: \`10000\` = $0.01). Read the price off the 402 first with
\`x402 details\`; every Agent402 price is also in
[/api/pricing](https://agent402.tools/api/pricing).

## Agentic Wallet MCP (Claude, Cursor, any MCP host)

The same wallet exposed as MCP tools. The flow an agent follows is:
\`list-bazaar-resources\` or \`get-resource-details\` to find the endpoint,
\`check-payment-requirements\` to read our 402 (price, network, pay-to) without
paying, then \`make-x402-request\` to pay and fetch. Point them at any
\`https://agent402.tools/api/...\` URL from [/api/pricing](https://agent402.tools/api/pricing)
or resolve a task first with \`GET https://agent402.tools/api/find?q=<task>\`
(free) and hand the returned \`url\` to \`make-x402-request\`.

## Stripe's \`purl\` (x402 curl)

Stripe's open-source x402 client. Install with Homebrew (\`brew install
stripe/purl/purl\`) or build from [github.com/stripe/purl](https://github.com/stripe/purl),
add a wallet, and treat any paid URL like curl:

\`\`\`bash
purl wallet add --name agent --type evm -k 0x<private key> --set-active=true
purl --dry-run "https://agent402.tools/api/dns?name=example.com&type=A"   # parse the 402 quote, pay nothing
purl "https://agent402.tools/api/dns?name=example.com&type=A"             # pay and fetch
\`\`\`

We run purl against production in CI, so a purl that cannot parse our 402 is a
failing build on our side, not a surprise on yours.

## CDP SDK in code (\`CdpX402Client\`)

A CDP-managed wallet with server-side spend controls, wrapped around fetch:

\`\`\`ts
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new CdpX402Client({
  spendControls: {
    maxAmountPerPayment: { atomic: 50_000n, asset: USDC_BASE },   // $0.05 per call
    maxCumulativeSpend:  { atomic: 2_000_000n, asset: USDC_BASE }, // $2 per window
    maxCumulativeSpendWindow: "24h",
    allowedNetworks: ["eip155:8453"],
  },
});
const pay = wrapFetchWithPayment(globalThis.fetch, client);
const r = await pay("https://agent402.tools/api/extract", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
\`\`\`

Or swap the wallet for our buyer SDK's caps: \`new Agent402({ fetch: pay,
maxPerCallUsd: 0.05, dailyLimitUsd: 2 })\` from
[agent402-client](https://www.npmjs.com/package/agent402-client) adds
\`find()\`, caching and idempotent retries on top of any payment-aware fetch.

## Two x402 extensions we honour

- **payment-identifier** - every 402 declares it (optional). Attach a
  \`pay_...\` id to your payment payload and an exact retry of that payment
  (same credential, same body) replays the original result with no second
  settle, exactly as our \`Idempotency-Key\` header does. A fresh
  authorization carrying the same id is a new payment.
- **bazaar** - every endpoint carries the discovery extension (input schema,
  output example), which is what makes it show up in \`awal x402 bazaar
  search\` and the Agentic Wallet MCP's resource list at all.

## What you get back

A \`200\` with JSON and a \`PAYMENT-RESPONSE\` header (the settle receipt).
A \`4xx\`/\`5xx\` never charges: settlement runs after the handler and only
for a successful response, and you can verify that from the headers you hold
(no \`PAYMENT-RESPONSE\` = nothing settled). Prefer MPP? The same 402 also
carries a \`WWW-Authenticate: Payment\` challenge - see
[x402 and MPP on the same paywall](/guides/x402-and-mpp).
`,
  },
  {
    slug: "coinbase-business-get-paid-by-agents",
    title: "Get paid by AI agents into your Coinbase Business account with agent402-tollbooth",
    description:
      "Coinbase Business accounts receive x402 payments from AI agents. agent402-tollbooth is the one-middleware way to put a USDC price on your API or site, settle through Coinbase's facilitator, and land every payment in that account. Three env vars, one command, one example server.",
    md: `
Coinbase Business now takes payments from AI agents over x402: an agent pays
your x402 URL in USDC and the funds settle into your Coinbase Business account,
where you reconcile, withdraw, or hold them. Coinbase's own path is a hosted
checkout that returns an x402 URL. If you sell an API and want a price on every
request, this guide puts x402 in front of the API itself and settles into the
same account.

[agent402-tollbooth](https://www.npmjs.com/package/agent402-tollbooth) is an
open-source (MIT) gate for Express, Next.js, Cloudflare or a plain reverse
proxy: humans browse normally, AI agents and crawlers get a 402 with a USDC
price and pay it, and the gate settles through the facilitator you name. Point
it at your Coinbase Business address and every settled call lands there.

## 1. Two things from Coinbase

1. Your **USDC receive address on Base** from the Coinbase Business account
   (Receive, network Base, asset USDC; Coinbase's Deposit Destinations API is
   the programmatic route to a receive address). This is the \`payTo\` on
   every 402 you serve, so funds settle straight into the account.
2. A **CDP API key** (id + secret) from the Coinbase Developer Platform. The
   tollbooth uses it to sign requests to Coinbase's x402 facilitator, which
   verifies and settles each payment. On Base no fee is taken from the payment itself; Coinbase's facilitator is free for the first 1,000 settlements a month and $0.001 each after.

## 2. One command in front of anything

\`\`\`bash
npm i agent402-tollbooth @x402/express @x402/core @x402/evm @coinbase/x402
TOLLBOOTH_PAYTO=0xYourCoinbaseBusinessBaseAddress \\
TOLLBOOTH_CDP_API_KEY_ID=organizations/.../apiKeys/... \\
TOLLBOOTH_CDP_API_KEY_SECRET='-----BEGIN EC PRIVATE KEY-----...' \\
TOLLBOOTH_PRICE='$0.005' \\
TOLLBOOTH_UPSTREAM=http://localhost:8080 \\
npx agent402-tollbooth
\`\`\`

Keep the key out of your shell history: put the three values in a \`.env\`
file and load it (\`set -a; . ./.env; set +a\`) or use your secret store.

That is a reverse proxy in front of your existing API on :8080. In the
default mode known AI crawlers (matched by user agent) get a 402 quoting $0.005
in USDC on Base, pay it, and are proxied through; the payment settles into the
Coinbase Business account before the response is released, and browsers pass
untouched. To charge every non-browser caller, stock x402 clients included, set
\`TOLLBOOTH_MODE=all\` and whitelist your own clients with \`free()\`.

## 3. Or as Express middleware, with the price per route

\`\`\`js
import express from "express";
import { createTollbooth } from "agent402-tollbooth";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";

const PAY_TO = process.env.COINBASE_BUSINESS_ADDRESS;  // USDC receive address on Base
const facilitator = new HTTPFacilitatorClient(
  createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET)
);
const server = new x402ResourceServer(facilitator).register("eip155:8453", new ExactEvmScheme());
const x402 = paymentMiddleware(
  { "GET /api/quote": { accepts: [{ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, price: "$0.005" }] } },
  server
);

const app = express();
app.use(createTollbooth({ x402 }));            // humans free, agents pay, MPP accepted too
app.get("/api/quote", (req, res) => res.json({ price: 42 }));
app.listen(8080);
\`\`\`

The gate delegates verify and settle to \`@x402/express\` in its own order
(verify, run your handler, settle only on a success response) and, by default,
also accepts the MPP wire, so agents on either protocol can pay. The full
runnable example is in the repo:
[examples/coinbase-business-tollbooth](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/coinbase-business-tollbooth).

## 4. Prove it with one paid call

We ran exactly this path with real money before publishing: the CLI's own
middleware built from CDP keys, paid $0.001 by a stock x402 client, settled
through Coinbase's facilitator on Base
([transaction](https://basescan.org/tx/0x8175178ac4e2229dfd9385a3c78c491ffe554b08fdf52cf92f99425c983ec5d1)).
One rule to know: Coinbase's facilitator refuses a payment whose payer is the
payTo (\`self_send_not_allowed\`), so test from a second wallet, never from the
receiving address.

Any stock x402 client pays it; we proved it with \`@x402/fetch\` and the
[agent402-client](https://www.npmjs.com/package/agent402-client) SDK speaks the
same wire. The receipt on the 200 response (\`PAYMENT-RESPONSE\`) carries the
settlement; it lands on Base within seconds and Coinbase credits the deposit on
its normal schedule.

## What you get

- Payments from agents settle in USDC into the account you already reconcile
  from, with no card network, no invoices and no agent accounts.
- Discoverable: list the endpoint on Agent402's open index ([/sell](/sell));
  agents can find it at once, and once it shows settled transactions the
  router at [/api/route](/api/route) can pay you on their behalf;
  a route can also carry the x402 Bazaar discovery extension for Coinbase's
  own directory.
- The rest of the tollbooth: proof-of-work for callers with no wallet,
  observe-before-charge mode, per-route prices, analytics, and native MPP on
  Tempo if you want a second rail. See [/tollbooth](/tollbooth).
`,
  },
  {
    slug: "agent-hosts",
    title: "Use Agent402 from Claude Code, Cursor, VS Code, Windsurf, Cline, Roo Code, Codex CLI, Gemini CLI, Continue, ElizaOS, AgentCore and any OpenAI SDK",
    description:
      "Two doors into Agent402 from the agent host you already run: models through an OpenAI-compatible base URL with a prepaid credits key (metered, from $" + TIERS["v1-chat-metered"].price + " a call), and 500+ tools through MCP. Copy the block for your host.",
    md: `
Agent402 opens two doors to an agent host, and both are paid with the same
key:

- **Models**: an OpenAI-compatible gateway. Point any client that accepts a
  base URL at \`https://agent402.tools/v1/metered\` with a credits key as the API
  key. Each request is quoted from its own body (input plus your \`max_tokens\`
  at the model's list price, x1.15) and a card or credits buyer settles what
  the call actually used, from $${TIERS["v1-chat-metered"].price} a call.
  \`GET https://agent402.tools/v1/models\` lists every id with its price and
  input cap; \`auto\` (routed per prompt, flat
  $${TIERS["v1-chat-auto"].price}) lives at \`https://agent402.tools/v1/auto\`.
- **Tools**: the hosted MCP connector at \`https://agent402.tools/mcp\`
  (discovery and the free tier need no key at all), or the
  [\`agent402-mcp\`](https://www.npmjs.com/package/agent402-mcp) stdio server,
  which pays wallet-only tools by card when \`AGENT402_CREDITS_KEY\` is set.

Get the key once: buy a pack by card at
[agent402.tools/credits](https://agent402.tools/credits); the key (\`a402_…\`)
is shown once and emailed. \`GET /api/credits/balance\` (Bearer) reports what
is left. Prefer a wallet? Every route also answers a stock x402 \`402\`
(${RAILS_OR}) and an MPP challenge, so any x402 client pays per call with no key.

## Claude Code

Claude Code as an LLM client, billed per request under a quoted ceiling. Point
it at the metered tier with your credits key as the auth token (Bearer), keep
your usual model names - dated ids like \`claude-haiku-4-5-20251001\` resolve
to the live model:

\`\`\`bash
export ANTHROPIC_BASE_URL=https://agent402.tools/v1/metered
export ANTHROPIC_AUTH_TOKEN=a402_...
claude --model claude-sonnet-5
\`\`\`

Verified 2026-08-27 with claude-cli 2.1.250: a full turn (110 KB system
prompt + 22 tool schemas, adaptive thinking, streaming) and a tool-use round
trip both complete; each turn is quoted from its own body (\`/v1/metered\`
accepts bodies to 1 MB / 200k input chars) and settles at actual usage, so an
idle turn costs cents, never the ceiling. Not carried on this wire:
\`output_config\`, \`context_management\` (dropped, the model default applies)
and server-side tools (web search, computer use) - Claude Code's own tools are
client tools and work as usual.

Tools over the hosted connector (free tier and discovery, no key):

\`\`\`bash
claude mcp add --transport http agent402 https://agent402.tools/mcp
\`\`\`

Paid tools by card, through the stdio server:

\`\`\`bash
claude mcp add agent402 -e AGENT402_CREDITS_KEY=a402_... -- npx -y agent402-mcp
\`\`\`

Or in \`.mcp.json\` at the project root:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "\${AGENT402_CREDITS_KEY}" }
    }
  }
}
\`\`\`

## Cursor

\`.cursor/mcp.json\` in the project (or \`~/.cursor/mcp.json\` for every
project). Remote, no key:

\`\`\`json
{ "mcpServers": { "agent402": { "url": "https://agent402.tools/mcp" } } }
\`\`\`

Paid tools by card:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "a402_..." }
    }
  }
}
\`\`\`

## Continue

\`config.yaml\`. A model entry for chat, plus the connector for agent mode:

\`\`\`yaml
models:
  - name: Agent402 (metered)
    provider: openai
    apiBase: https://agent402.tools/v1/metered
    apiKey: a402_...
    model: openai/gpt-4o-mini
    roles:
      - chat
mcpServers:
  - name: Agent402
    type: streamable-http
    url: https://agent402.tools/mcp
\`\`\`

Any id from \`/v1/models\` works as \`model\`; the metered route takes up to
85,000 characters of input per request.

## ElizaOS

Tools: the [\`elizaos-plugin-agent402\`](https://www.npmjs.com/package/elizaos-plugin-agent402)
plugin adds \`AGENT402_FIND\` / \`AGENT402_CALL\` / \`AGENT402_ABOUT\` actions
(\`"plugins": ["elizaos-plugin-agent402"]\`, setting \`AGENT402_CREDITS_KEY\`).
Models: the OpenAI plugin reads its base URL from the environment, so no code changes:

\`\`\`bash
OPENAI_BASE_URL=https://agent402.tools/v1/metered
OPENAI_API_KEY=a402_...
OPENAI_LARGE_MODEL=anthropic/claude-sonnet-5
OPENAI_MEDIUM_MODEL=openai/gpt-4o-mini
# embeddings live at /v1/embeddings ($${EMBEDDINGS_PRICE} a call), off the metered path
OPENAI_EMBEDDING_URL=https://agent402.tools/v1
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
\`\`\`

## Any OpenAI SDK

\`\`\`python
from openai import OpenAI
client = OpenAI(base_url="https://agent402.tools/v1/metered", api_key="a402_...")
r = client.chat.completions.create(model="openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "One sentence on x402."}], max_tokens=60)
print(r.choices[0].message.content)
\`\`\`

\`\`\`js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://agent402.tools/v1/metered", apiKey: "a402_..." });
const r = await client.chat.completions.create({ model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "One sentence on x402." }], max_tokens: 60 });
console.log(r.choices[0].message.content);
\`\`\`

Send an \`Idempotency-Key\` header on retries and a retried call replays the
paid answer instead of paying again.

The same metered pricing is on the Responses wire too, for the OpenAI Agents
SDK and \`responses.create()\`: base URL \`https://agent402.tools/v1/metered\`
(route \`/v1/metered/responses\`), function tools only, \`store\` always false.

## Any Anthropic SDK (Messages wire)

The same metered pricing on the Anthropic Messages wire, at
\`https://agent402.tools/v1/metered\` (route \`/v1/metered/messages\`). Pass the
credits key as the SDK's \`auth_token\` (sent as \`Authorization: Bearer\`, which
the credits gate reads), not \`api_key\` (sent as \`x-api-key\`):

\`\`\`python
from anthropic import Anthropic
client = Anthropic(base_url="https://agent402.tools/v1/metered", auth_token="a402_...")
m = client.messages.create(model="anthropic/claude-haiku-4.5", max_tokens=60,
    messages=[{"role": "user", "content": "One sentence on x402."}])
print(m.content[0].text)
\`\`\`

\`\`\`js
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "https://agent402.tools/v1/metered", authToken: "a402_..." });
const m = await client.messages.create({ model: "anthropic/claude-haiku-4.5", max_tokens: 60,
  messages: [{ role: "user", content: "One sentence on x402." }] });
console.log(m.content[0].text);
\`\`\`

## Amazon Bedrock AgentCore

An AgentCore Gateway turns \`https://agent402.tools/openapi.json\` into MCP
tools with an OpenAPI target (\`agentcore add gateway-target --type
open-api-schema --schema <path to openapi.json>\`), or aggregates the hosted
connector as an MCP server target. Paid calls ride
[AgentCore Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments-concepts.html):
the agent forwards our \`402\` payload, AgentCore signs it from its managed
wallet, and the retry carries the proof in \`X-PAYMENT\`; every Agent402 route
answers a stock x402 v2 challenge, so nothing on our side needs configuring.

## VS Code

GitHub Copilot's agent mode reads \`.vscode/mcp.json\` in the workspace (or
the user profile via the \`MCP: Open User Configuration\` command; \`MCP: Add
Server\` in the palette writes either). Remote, free tier, no key:

\`\`\`json
{ "servers": { "agent402": { "type": "http", "url": "https://agent402.tools/mcp" } } }
\`\`\`

Paid tools by card, through the stdio server with a credits key held in a
prompted input (VS Code stores it, the file never carries it):

\`\`\`json
{
  "inputs": [{ "type": "promptString", "id": "agent402-key", "description": "Agent402 credits key (a402_...)", "password": true }],
  "servers": {
    "agent402": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "\${input:agent402-key}" }
    }
  }
}
\`\`\`

## Windsurf

Cascade reads \`~/.codeium/windsurf/mcp_config.json\` (Streamable HTTP, SSE
and stdio are all supported; note Cascade caps the tools it can see at 100 in
total across servers, and this connector lists a small fixed set, not the
whole catalog). Remote, free tier:

\`\`\`json
{ "mcpServers": { "agent402": { "serverUrl": "https://agent402.tools/mcp" } } }
\`\`\`

Paid tools by card, with the key read from the environment (\`\${env:VAR}\`
interpolation is Windsurf's own):

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "\${env:AGENT402_CREDITS_KEY}" }
    }
  }
}
\`\`\`

## Cline

MCP Servers icon in the top toolbar, Configure tab, then Configure MCP
Servers (the CLI reads \`~/.cline/mcp.json\`). Remote, free tier:

\`\`\`json
{
  "mcpServers": {
    "agent402": { "type": "streamableHttp", "url": "https://agent402.tools/mcp", "disabled": false, "autoApprove": [] }
  }
}
\`\`\`

Paid tools by card:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "a402_..." },
      "disabled": false,
      "autoApprove": []
    }
  }
}
\`\`\`

Cline's own "OpenAI Compatible" provider also accepts a base URL, so the
models door works too: base URL \`https://agent402.tools/v1/metered\`, the
credits key as the API key, and a model id from \`/v1/models\`.

## Roo Code

Settings icon in the Roo pane, then Edit Global MCP (\`mcp_settings.json\`) or
Edit Project MCP (\`.roo/mcp.json\`, which wins on a name clash). Remote,
free tier:

\`\`\`json
{
  "mcpServers": {
    "agent402": { "type": "streamable-http", "url": "https://agent402.tools/mcp", "alwaysAllow": [], "disabled": false }
  }
}
\`\`\`

Paid tools by card:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "a402_..." },
      "alwaysAllow": [],
      "disabled": false
    }
  }
}
\`\`\`

## OpenAI Codex CLI

One command for the free tier:

\`\`\`bash
codex mcp add agent402 --url https://agent402.tools/mcp
\`\`\`

Or in \`~/.codex/config.toml\`, paid tools by card through the stdio server:

\`\`\`toml
[mcp_servers.agent402]
command = "npx"
args = ["-y", "agent402-mcp"]
env = { AGENT402_CREDITS_KEY = "a402_..." }
\`\`\`

Codex as a model host: its \`model_providers\` speak the Responses wire, and
the metered tier serves it at \`/v1/metered/responses\` (quoted per request
from the body, settled at actual usage for a credits key). In
\`~/.codex/config.toml\`:

\`\`\`toml
model_provider = "agent402"
model = "anthropic/claude-haiku-4.5"

[model_providers.agent402]
name = "Agent402 (metered)"
base_url = "https://agent402.tools/v1/metered"
env_key = "AGENT402_CREDITS_KEY"
wire_api = "responses"
\`\`\`

Then \`export AGENT402_CREDITS_KEY=a402_...\` and run \`codex\`. The route is
proven daily by the paid canary; a full Codex session against it has not yet
been run end to end, so if a turn is refused, the 400 body says exactly which
field (server tools and \`previous_response_id\` are not served).

## Gemini CLI

One command for the free tier:

\`\`\`bash
gemini mcp add --transport http agent402 https://agent402.tools/mcp
\`\`\`

Or in \`~/.gemini/settings.json\` (\`httpUrl\` is the Streamable HTTP key;
\`url\` means SSE), paid tools by card through the stdio server:

\`\`\`json
{
  "mcpServers": {
    "agent402": {
      "command": "npx",
      "args": ["-y", "agent402-mcp"],
      "env": { "AGENT402_CREDITS_KEY": "a402_..." }
    }
  }
}
\`\`\`

## What the same key buys

The credits key that pays for chat pays for the rest: three wires on every
tier (OpenAI chat, OpenAI Responses, Anthropic Messages), embeddings, rerank,
images, speech and transcription, 500+ tools, finished reports
and monitors, and a router that buys from other proven sellers on your
agent's behalf. Why pay here, with the proof links:
[agent402.tools/why](https://agent402.tools/why).
`,
  },
  {
    slug: "openclaw-model-provider",
    title: "Use Agent402 as your OpenClaw model provider - pay by card, no wallet",
    description:
      "Point OpenClaw at Agent402's OpenAI-compatible gateway with a prepaid credits key: one config block, auto-routed models at a flat per-call price, paid by card. Or pay per call in USDC from a wallet over x402.",
    md: `
[OpenClaw](https://openclaw.ai) talks to any OpenAI-compatible provider through
one block in \`openclaw.json\`. Agent402's LLM gateway is one of those, with a
twist: it can be paid **by card**, through a prepaid credits key, so an agent
runs without a crypto wallet. USDC over x402 works too, if you'd rather.

## 1. Get a credits key (card, two minutes)

Buy a pack at [agent402.tools/credits](https://agent402.tools/credits) by card.
The key (\`a402_…\`) is shown once on the thanks page and emailed. It spends on
any paid route, including every gateway tier below, and
\`GET /api/credits/balance\` (Bearer) reports what is left.

Put it in the environment OpenClaw runs in:

\`\`\`bash
export AGENT402_CREDITS_KEY=a402_…
\`\`\`

## 2. Add the provider

OpenClaw sends roughly 70k characters of system prompt and tool schemas before
your first word, so the model it talks to must accept that much input. The
routed \`auto\` tier caps input at ${TIERS["v1-chat-auto"].maxInputChars.toLocaleString("en-US")} characters and OpenClaw refuses it
as a context overflow before any call is made; the metered route
(\`${TIERS["v1-chat-metered"].route.split(" ")[1].replace("/chat/completions", "")}\`, up to ${TIERS["v1-chat-metered"].maxInputChars.toLocaleString("en-US")} characters, each request quoted from its
body from $${TIERS["v1-chat-metered"].price}) is the one to point OpenClaw at:

\`\`\`json5
// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: {
      model: { primary: "agent402/anthropic/claude-haiku-4.5" },
    },
  },
  models: {
    providers: {
      agent402: {
        baseUrl: "https://agent402.tools${TIERS["v1-chat-metered"].route.split(" ")[1].replace("/chat/completions", "")}",
        apiKey: "\${AGENT402_CREDITS_KEY}",
        api: "openai-completions",
        timeoutSeconds: 120,
        models: [
          {
            id: "anthropic/claude-haiku-4.5",
            name: "Claude Haiku 4.5 via Agent402 (metered, from $${TIERS["v1-chat-metered"].price}/call)",
            reasoning: false,
            input: ["text"],
            // Agent402 bills per call (the 402 quotes each request), not per token,
            // so OpenClaw's per-token cost display does not apply and stays at zero.
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: ${Math.floor(TIERS["v1-chat-metered"].maxInputChars / 4)},
            maxTokens: ${TIERS["v1-chat-metered"].maxTokens},
          },
        ],
      },
    },
  },
}
\`\`\`

Restart the gateway (\`openclaw gateway restart\`). Every model call now goes to
\`${TIERS["v1-chat-metered"].route}\` with your credits key, paying what
that call costs (exact-BPE input plus \`max_tokens\` at the model's list price,
times 1.15, capped at $${METERED_MAX_QUOTE_USD} per call). Any id from
[\`/v1/models\`](https://agent402.tools/v1/models) can take Haiku's place.

## Explicit models and the other tiers

The gateway has ${FLAT_TIER_ROWS.length} flat chat tiers, each a fixed price per call, plus a metered route, \`${TIERS["v1-chat-metered"].route.split(" ")[1].replace("/chat/completions", "")}\`, that quotes each request from its body (from $${TIERS["v1-chat-metered"].price} per call):

${FLAT_TIER_TABLE}

To pin a model, add a second provider whose \`baseUrl\` is that tier's path and
whose \`models[]\` list ids from [\`/v1/models\`](https://agent402.tools/v1/models),
for example \`baseUrl: "https://agent402.tools/v1/premium"\` with
\`{ id: "openai/gpt-5" }\` and \`{ id: "anthropic/claude-opus-5" }\`. A model sent
to the wrong tier is answered with a 400 that names its home tier; nothing is
charged.

## Pay from a wallet instead

Every tier answers an x402 \`402\` (${RAILS_OR}) and an MPP challenge, so any
x402-capable client can pay per call with no key at all. For OpenClaw the
[\`agent402-openclaw\`](https://www.npmjs.com/package/agent402-openclaw) plugin
runs a loopback proxy that pays and forwards, with a credits key or an x402
wallet, and writes the provider block for you. Explicit models go to the metered
route by default (each request quoted from its body, from
$${TIERS["v1-chat-metered"].price}); \`--flat\` keeps the flat tiers:

\`\`\`bash
openclaw plugins install agent402-openclaw
npx agent402-openclaw setup --write        # no key? it mints a wallet and prints the address to fund
openclaw gateway restart
\`\`\`

With no credits key and no \`AGENT402_WALLET_KEY\`, \`setup\` generates a wallet
into \`~/.openclaw/agent402/wallet.key\` (0600, never printed) and tells you the
address: send it USDC on Base and every call is paid from it over x402, from
$${TIERS["v1-chat-metered"].price} a call. \`agent402-openclaw wallet\` shows the
balance; \`--credits-key a402_...\` is the card path instead. Every forwarded
call carries an \`Idempotency-Key\`, so a retry replays the paid answer instead
of paying twice. The plain config block above needs no plugin and
stays the simplest path for a credits key.

## What you get that a plain router does not

The same key and the same base URL reach the rest of the catalog: 500+
deterministic tools (search, extract, render, PDF, EDGAR, openFDA, on-chain
data), the [smart order router](https://agent402.tools/guides/smart-order-router)
that pays other x402 sellers on your agent's behalf, and receipts for every
call. Every price on this page is rendered from the live gateway configuration.

## What else the same key buys

The credits key (or the wallet) that pays for chat is the same one that pays
for everything else on the gateway and the catalog, with one 402 shape and one
receipt shape:

- **Three wires on every tier**: OpenAI chat, OpenAI Responses and Anthropic
  Messages, plus streaming, embeddings, rerank, images, video, speech and
  transcription, and a grounded tier that cites the web on every answer.
- **500+ tools** over MCP or HTTP: web search, news, cited
  answers, browser render, market quotes, SEC filings, crypto and DeFi data,
  PDFs, OCR, DNS and TLS checks, a code sandbox, wallet-keyed memory.
- **Finished reports and monitors**: dossiers, insider flow, 13F holdings,
  domain audits, token risk, deep research, market briefs, a LinkedIn article
  package; monitors that re-run a report only when the facts change.
- **Routing that buys on your behalf**: \`POST /api/route/execute\` pays the
  best proven external seller for a task and relays the result.

Why pay here, in one page with the proof links:
[agent402.tools/why](https://agent402.tools/why). The short version: usage is
priced under a ceiling you see before you pay, a failed call is not charged and the
receipt proves it, a keyed retry never pays twice, and uptime and transactions are published from
outside production.
`,
  },
];

const GUIDE_INDEX_CSS = `
.gi-wrap{max-width:1180px;margin:0 auto;padding:56px 30px;}
.gi-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;}
.gi-wrap h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;}
.gi-desc{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px;max-width:640px;}
.gi-list{display:flex;flex-direction:column;gap:20px;}
.gi-card{display:block;background:var(--card);border:1px solid var(--hairline);padding:24px 26px;text-decoration:none;transition:border-color .2s;}
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
.gp-wrap h1{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 28px;color:var(--ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;}
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
.gp-body pre{background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:13px;line-height:1.55;padding:16px 20px;overflow-x:auto;margin:0 0 16px;border:1px solid var(--hairline);}
.gp-body pre code{background:none;border:none;padding:0;color:inherit;font-size:13px;}
.gp-back{display:inline-block;margin-top:28px;font-family:var(--font-mono);font-size:13px;color:var(--accent);text-decoration:none;font-weight:700;}
.gp-back:hover{text-decoration:underline;}
`;

export function guidesIndex(baseUrl) {
  const title = "Guides: x402 payments, MPP, and memory for AI agents";
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
  <section>
  <div class="gi-eyebrow">$ GET /guides</div>
  <h1>Guides</h1>
  <p class="gi-desc">Working code, no fluff - everything here runs against the live service.</p>
  </section>
  <section>
  <div class="gi-list">
      ${items}
  </div>
  </section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss: GUIDE_INDEX_CSS, body });
}

export function guidePage(baseUrl, slug) {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) return null;

  const title = `${g.title} - Agent402`;
  const canonical = `${baseUrl}/guides/${g.slug}`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: g.title,
    description: g.description,
    url: canonical,
    image: `${baseUrl}/card.png`,
    author: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
    publisher: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
  };

  const body = `<div class="gp-wrap">
  <div class="gp-crumb"><a href="/">Home</a> / <a href="/guides">Guides</a> / ${esc(g.title)}</div>
  <h1 title="${esc(g.title)}">${esc(g.title)}</h1>
  <div class="gp-body">
    ${marked.parse(g.md)}
  </div>
  <a href="/guides" class="gp-back">Back to guides</a>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description: g.description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss: GUIDE_PAGE_CSS, body });
}

export const guideSlugs = () => GUIDES.map((g) => g.slug);
