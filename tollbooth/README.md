# agent402-tollbooth

**Open-source, self-hostable pay-per-crawl for x402 and MPP. Put it in front of
any site or API: humans browse free, AI crawlers and agents pay per request** -
in USDC over the [x402 protocol](https://x402.org), over
[MPP](https://mpp.dev) (the Machine Payments Protocol `Payment` HTTP auth
scheme, settled through the same stack), or for free by solving a
proof-of-work. No platform lock-in, no card processor required, no Merchant-of-Record, no signup.
The first self-hostable pay-per-crawl gate that speaks both wires on one 402 -
the sell side of [Agentic Finance](https://agent402.tools/agentic-finance),
where agents pay and sites get paid, per request, with no account in between.

Tollbooth is an **open-source monetization gateway**: MIT-licensed, running in
front of *any* origin (Express, a reverse proxy, Next.js, a Cloudflare Worker),
non-custodial (you hold the wallet, no signup or Merchant-of-Record), settling
over x402 and MPP on one 402 - including native MPP on Tempo with split
payments - and with a **proof-of-work free tier** so a walletless agent still
has a path through. Built on the same hardened 402 + proof-of-work machinery as
[Agent402](https://github.com/MikeyPetrillo/Agent402).

## See it work (one command)

```bash
npx agent402-tollbooth   # then, in the repo:  npm run --prefix tollbooth demo
```

```text
agent402-tollbooth - live pay-per-crawl demo

① A human opens the page (normal browser)
   → HTTP 200 FREE  "📄 The Future of Machine Payments - full article text…"
   Humans are never charged.

② An AI crawler hits the same page (ClaudeBot)
   → HTTP 402 Payment Required
   pay with USDC: $0.002 USDC on base → 0x…
   …or free with proof-of-work: a 18-bit sha256 puzzle

③ The crawler has no wallet, so it spends CPU instead
   solved in 0.32s (nonce=100208)
   → HTTP 200 OK (paid via pow)  "📄 The Future of Machine Payments - full article text…"

✓ Pay-per-crawl, end to end - humans free, bots pay (USDC or compute).
```

## Install

```bash
npm install agent402-tollbooth
```

## Use it as Express middleware

```js
import express from "express";
import { createTollbooth } from "agent402-tollbooth";

const app = express();

// Humans pass through; known AI crawlers get 402 and must pay or solve a PoW.
app.use(createTollbooth({ price: "$0.002" }));

app.get("/article", (_req, res) => res.send("…your content…"));
app.listen(3000);
```

```bash
curl -A "Mozilla/5.0" localhost:3000/article     # human  -> 200, free
curl -A "ClaudeBot/1.0" localhost:3000/article   # bot    -> 402 Payment Required
```

The 402 body advertises both rails:

```jsonc
{
  "error": "Payment Required",
  "message": "…humans browse free; bots pay in USDC via x402 or by solving a proof-of-work.",
  "accepts": [{ "scheme": "exact", "network": "base", "maxAmountRequired": "$0.002", "asset": "USDC", "payTo": "0x…", "resource": "/article" }],
  "proofOfWork": { "algorithm": "sha256", "challenge": "…", "difficulty": 18, "token": "…", "rule": "Find a nonce so sha256(challenge+\":\"+nonce) has >= 18 leading zero bits; resend with header X-Pow-Solution: <token>:<nonce>" }
}
```

A crawler that can't (or won't) pay USDC solves the puzzle and retries with
`X-Pow-Solution: <token>:<nonce>` - sub-second of CPU, single-use, bound to that
exact URL.

## Use it as a reverse proxy (any language/framework)

Point it at your existing site - no code changes there:

```bash
TOLLBOOTH_UPSTREAM=https://your-site.com \
TOLLBOOTH_PAYTO=0xYourWallet \
TOLLBOOTH_FACILITATOR_URL=https://x402.org/facilitator \
npx agent402-tollbooth          # listens on :4021, proxies humans free, charges bots
```

With `TOLLBOOTH_PAYTO` **and** `TOLLBOOTH_FACILITATOR_URL` set, the proxy
settles real money over **both wires** from env alone (0.8.0): it builds the
standard `@x402/express` v2 stack in-process (verify, proxy the request, settle
only on a successful response, exactly once) and mints MPP challenges on the
same 402, so a stock `@x402/fetch` client and a stock `mppx` client both pay.
Install the x402 packages next to it once (`npm i @x402/express @x402/core
@x402/evm`; they are optional peers so the package stays dependency-free
otherwise) and pick a facilitator that settles your network - keyless free
tiers exist for mainnet chains, and `https://x402.org/facilitator` covers
base-sepolia for a dry run. USDC on the EVM chains in `TOLLBOOTH_NETWORK`'s
list (`base` default); other assets and rails use the library API below.
`TOLLBOOTH_PAYTO` alone still only *advertises* a quote (nothing can verify or
settle it, every paid request is refused) and now says so loudly at boot.

## Run on the edge (Cloudflare Workers, Next.js, Deno, Bun)

The same gate is also built on the Web Crypto + Fetch APIs (`edge.js`), so it runs
anywhere - no Node required. The gate returns a `402 Response` when the client
must pay, or `null` to let it through.

**Ready-to-deploy templates** (copy a folder, don't assemble from docs):

- **Cloudflare Workers** → [`deploy/cloudflare/`](deploy/cloudflare/) - a ready
  `wrangler.toml` + a 3-step deploy guide.
- **Next.js / Vercel** → [`deploy/nextjs/`](deploy/nextjs/) - a drop-in
  `middleware.js` + a 3-step deploy guide.
- **Docker** → [`deploy/docker/`](deploy/docker/) - a `Dockerfile` +
  `docker-compose.yml` to run the reverse proxy in front of any site with
  `docker compose up -d` (includes the live `/__tollbooth` dashboard).

The short version of each:

```toml
# wrangler.toml  (full template: deploy/cloudflare/wrangler.toml)
name = "tollbooth"
main = "node_modules/agent402-tollbooth/worker.js"
compatibility_date = "2026-01-01"
[vars]
TOLLBOOTH_UPSTREAM = "https://your-origin.example.com"
TOLLBOOTH_PAYTO    = "0xYourWallet"   # optional: advertise a USDC x402 quote
# npx wrangler secret put TOLLBOOTH_SECRET
# optional single-use replay store:  [[kv_namespaces]] binding = "TOLLBOOTH_KV"
```

```js
// middleware.js  (full template: deploy/nextjs/middleware.js)
import { NextResponse } from "next/server";
import { createEdgeTollbooth } from "agent402-tollbooth/edge";
const gate = createEdgeTollbooth({ secret: process.env.TOLLBOOTH_SECRET });

export async function middleware(req) {
  return (await gate(req)) ?? NextResponse.next();
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
```

**Any Fetch-API runtime** (Deno, Bun, custom): `const gate = createEdgeTollbooth({ secret }); const blocked = await gate(request); return blocked ?? fetch(request);`

> On the edge, pass a stable `secret` (PoW tokens are HMAC-signed). For
> single-use replay protection across stateless invocations, supply a `store`
> (e.g. a Cloudflare KV wrapper - the Worker entry wires this for you).
> The `x402:` middleware mode and the native Tempo rail are Node/Express
> features; the edge gate offers proof-of-work plus the `verifyX402` callback,
> and since 0.10.0 **MPP on that same verifier**: with `secret`, `payTo` and
> `verifyX402` set, every 402 also carries a `WWW-Authenticate: Payment`
> evm/charge challenge for the quote, and an `Authorization: Payment`
> credential (HMAC-bound to our challenge, unexpired, minted for that exact
> resource) is translated to `PAYMENT-SIGNATURE` and handed to `verifyX402` as
> if an x402 client had sent it. `mpp:false` turns it off; `mppAssetAddress` +
> `mppAssetName` name a token outside the built-in USDC table (Base, Celo,
> Polygon, Arbitrum, Optimism, Avalanche, Sei).

## Accepting USDC: x402 and MPP on the same 402

The proof-of-work rail works with **zero config**. To also settle real money,
hand the gate your standard, audited x402 middleware (`@x402/express` v2) as
`x402:` - the gate never reinvents settlement, it delegates to it:

```js
import { createTollbooth } from "agent402-tollbooth";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" }))
  .register("eip155:8453", new ExactEvmScheme());
const x402 = paymentMiddleware(
  { "GET /*": { accepts: [{ scheme: "exact", network: "eip155:8453", price: "$0.001", payTo: "0xYourWallet" }] } },
  server,
);

app.use(createTollbooth({ payTo: "0xYourWallet", x402 }));
```

What you get on every charged request:

- **x402 v2 clients pay.** The gate lifts the middleware's `PAYMENT-REQUIRED`
  header onto its own 402, so a stock `@x402/fetch` client negotiates and pays
  as if the middleware were mounted bare. Verify, your handler, and settlement
  run in the middleware's own order (v2 settles after the handler ends the
  response) - exactly once.
- **MPP clients pay** (default on when `x402` is set; `mpp: false` to turn off).
  The same 402 gains `WWW-Authenticate: Payment` challenges (`evm`/`charge`,
  one per EVM chain the middleware advertises among `mppNetworks`, default
  Base + Celo). An inbound `Authorization: Payment` credential whose challenge
  id HMAC-verifies is re-encoded as `PAYMENT-SIGNATURE` and settled by the
  same middleware; the settled response carries a `Payment-Receipt`. A stock
  [`mppx`](https://www.npmjs.com/package/mppx) client works unmodified. The
  codec is dependency-free (no mppx on the server side) and byte-compatible
  with the reference client - proven in the parent repo's CI by a real mppx
  purchase through this package.
- **Proof-of-work first**, unchanged: a walletless agent always has a free path.

Set a stable `TOLLBOOTH_SECRET` (or `mppSecret`) so MPP challenge ids verify
across workers - the same caveat as proof-of-work tokens.

### `verifyX402` (legacy, deprecated in 0.7.0)

Older versions took a verify-only callback (`verifyX402(req, opts) => boolean`)
and shipped `x402VerifierFromExpress()` to build one from a payment middleware.
**With `@x402/express` v2 that helper grants on verify and never settles**: v2
settles after the handler ends the response, and the helper handed it a stub
response the real handler never ended, so buyers were served and never charged
(measured in the parent repo's test suite). It only ever settled with v1
middlewares that settled before calling `next()`. It still works for those and
for custom verifiers you wrote yourself, and now warns once at construction;
everyone else should pass the middleware as `x402:` above. `verifyX402` still
receives `opts.signal` (aborted on `TOLLBOOTH_VERIFY_TIMEOUT_MS`).

## Native MPP on Tempo (0.9.0)

Tollbooth can charge crawlers in USDC.e **natively on Tempo** - MPP's own
payment method - with no x402 facilitator at all, and (optionally) split every
payment with a platform fee in the same on-chain transaction:

```js
app.use(createTollbooth({
  price: "$0.001",
  tempo: {
    apiKey: process.env.TEMPO_API_KEY,        // Tempo API key with the mpp:write scope
    recipient: "0xYourTempoPayTo",
    // currency: defaults to USDC.e on Tempo mainnet; currencies: [...] to offer more than one
    splits: [{ recipient: "0xPlatform", amount: "0.0002" }], // optional, up to 10, total < price
  },
}));
```

The `tempo` object takes `apiKey` (required), `recipient` (required, your
Tempo payTo), `currency` or `currencies` (TIP-20 token addresses; default USDC.e
`0x20C000000000000000000000b9537d11c60E8b50`, one challenge minted per currency,
first = preferred), `splits` (up to 10, total below the price, same transaction),
`chainId` (default 4217, Tempo mainnet), `apiBaseUrl` (relay, default
`https://api.tempo.xyz`), `decimals` (6), `timeoutSeconds` (300), plus the
confirm knobs below. A bad config throws at construction - the gate never boots
minting unpayable challenges.

Or from env on the CLI: `TOLLBOOTH_TEMPO_API_KEY`, `TOLLBOOTH_TEMPO_RECIPIENT`
(defaults to `TOLLBOOTH_PAYTO`), optional `TOLLBOOTH_TEMPO_CURRENCY` (CSV of
token addresses), `TOLLBOOTH_TEMPO_SPLITS="0xabc:0.0002,0xdef:0.0001"`,
`TOLLBOOTH_TEMPO_API_BASE` (relay override), `TOLLBOOTH_TEMPO_RPC_URL` (confirm
RPC override). Tempo works with NO x402 middleware at all (a Tempo-only
tollbooth) and next to one.

Every 402 then carries a `WWW-Authenticate: Payment` tempo/charge challenge
(next to any evm challenges from the x402 rail, if you run both); a stock
`mppx` client with `tempo.charge({ account })` pays it. The gate validates the
credential with Tempo's relay BEFORE your handler runs, buffers the response,
and broadcasts ONLY after a successful (<400) response - the same
settle-after-handler discipline as the x402 rail - then replays the response
with a `Payment-Receipt` header and `X-Tollbooth-Paid: mpp-tempo`. A refused
credential gets a 402 with fresh challenges and an RFC 9457 `problem` in the
body. Challenges are HMAC-bound to your `TOLLBOOTH_SECRET`; each credential is
single-use (share a `replayStore` across workers). No new dependency: the
relay is spoken to over plain `fetch`.

**Chain-truth confirm (0.9.2):** a relay can report settlement failure for a
payment that actually landed - measured live: a buyer whose packed signature
ends with a yParity-style v byte (0x00/0x01) gets normalized by the Tempo
node, so the canonical txid stops matching the hash of the submitted bytes
and the relay's post-broadcast check refuses a settled payment; the buyer is
told 402 and retries into a double charge. On any broadcast failure the gate
now derives the only txids the credential's own signed bytes could have
landed under (submitted form + v-swapped twin - the txid commits to the
bytes, so the binding is exact) and, if one of them succeeded on-chain paying
your recipient at least the challenge amount in the challenge currency,
serves the response as paid. Verification only - nothing is re-broadcast, so
it can never double-charge; every uncertainty fails closed to the 402.
Options: `confirm: false` disables, `confirmRpcUrl` overrides the Tempo RPC
(default `https://rpc.tempo.xyz`, env `TOLLBOOTH_TEMPO_RPC_URL`). Still
dependency-free (keccak-256 is implemented in-package and pinned against the
live incident transaction in the tests).

## Configuration

| Option | Default | What |
|---|---|---|
| `price` | `"$0.001"` | Advertised price per request (x402 quote) |
| `payTo` | – | Wallet address; set to advertise a USDC x402 quote |
| `network` | `"base"` | x402 network |
| `pow` | `true` | Enable the free proof-of-work rail |
| `powDifficulty` | `18` | PoW difficulty in leading zero bits (~0.1–0.5s of CPU) |
| `mode` | `"bots"` | Who pays: `"bots"` (AI-crawler UAs) · `"all"` (everyone but `free()`) · `"strict"` (anything that isn't a real-browser request) |
| `adaptive` | `false` | Raise PoW difficulty as charged-request load climbs (anti-abuse under traffic spikes) |
| `maxDifficulty` | `base+6` | Ceiling for adaptive difficulty |
| `adaptivePerBit` | `300` | +1 difficulty bit per N charged requests/min |
| `botUserAgents` | `AI_BOTS` | User-agents to charge in `"bots"` mode |
| `charge(req)` | mode | Custom "should this client pay?" predicate (wins over `mode`) |
| `free(req)` | – | Custom force-allow predicate (wins over everything) |
| `x402` | – | Your `@x402/express` `paymentMiddleware(...)`: owns verify + settle; enables x402 v2 clients and (by default) MPP |
| `mpp` | `true` when `x402` set | Accept MPP (`WWW-Authenticate: Payment` / `Authorization: Payment`) through the `x402` middleware |
| `mppSecret` | `powSecret` / `TOLLBOOTH_SECRET` | HMAC secret binding MPP challenge ids (stable across workers) |
| `mppNetworks` | `[8453, 42220]` | EVM chain ids to offer as MPP challenges (`"all"` = every EVM chain the middleware advertises) |
| `tempo` | env (`TOLLBOOTH_TEMPO_*`) or off | Native MPP on Tempo (0.9.0): `{ apiKey, recipient, currency \| currencies, splits, chainId, apiBaseUrl, decimals, timeoutSeconds, confirm, confirmRpcUrl }` - mints `tempo/charge` challenges, validates with Tempo's relay before the handler, broadcasts after a <400 response. Works with or without `x402` |
| `tempo.confirm` | `true` | Chain-truth confirm (0.9.2): on a relay broadcast failure, check the chain for the credential's own txid before answering 402; `false` disables |
| `tempo.confirmRpcUrl` | `https://rpc.tempo.xyz` (`TOLLBOOTH_TEMPO_RPC_URL`) | Tempo JSON-RPC used by the confirm step |
| `verifyX402(req, opts)` | – | Legacy verify-only USDC check (deprecated for settle-after-handler middlewares; see above) |
| `resourceBaseUrl` | `""` | Absolute base used for the `resource` field / PoW binding |
| `observe` | `false` | Observe-only: classify and count, but never 402. For pre-launch traffic measurement. |
| `statsSink` | in-memory | Durable stats backend. Built-ins: `memorySink`, `kvStatsSink(kv)`, `httpStatsSink(url)`. |
| `replayStore` | **this process's memory** | Shared single-use record for solved proof-of-work tokens. Required for multi-worker / multi-instance / serverless. Built-ins: `sqliteReplayStore(db)`, `redisReplayStore(client)`. See below. |

### Environment variables

Read by the bundled proxy / Express entry point (`index.js`):

| env | default | meaning |
|---|---|---|
| `TOLLBOOTH_UPSTREAM` | – | Origin the built-in reverse proxy forwards to |
| `TOLLBOOTH_PAYTO` | – | Wallet address; advertises a USDC x402 quote (and, with `TOLLBOOTH_FACILITATOR_URL`, settles it) |
| `TOLLBOOTH_FACILITATOR_URL` | – | x402 facilitator that settles your network. With `TOLLBOOTH_PAYTO` the CLI builds a real `@x402/express` middleware and takes payment over x402 **and** MPP (0.8.0). Needs `@x402/express @x402/core @x402/evm` installed; refuses to start without them |
| `TOLLBOOTH_FACILITATOR_HEADERS` | – | Optional JSON object of auth headers sent on the facilitator's `/verify`, `/settle`, `/supported` (e.g. `{"X-API-Key":"…"}`) |
| `TOLLBOOTH_CDP_API_KEY_ID` + `TOLLBOOTH_CDP_API_KEY_SECRET` | – | Settle through Coinbase's facilitator (CDP) instead of a URL (no fee is taken from the payment itself; Coinbase's facilitator is free for the first 1,000 settlements a month and $0.001 each after). Needs `npm i @coinbase/x402`. This is how a Coinbase Business account gets paid by agents: `TOLLBOOTH_PAYTO` = the account's USDC (Base) receive address. |
| `TOLLBOOTH_PRICE` | `"$0.001"` | Advertised price per request |
| `TOLLBOOTH_NETWORK` | `"base"` | x402 network. CLI settlement mode accepts `base`, `base-sepolia`, `polygon`, `arbitrum`, `optimism`, `avalanche`, `celo`, `sei`, `monad`, or a raw `eip155:<id>` |
| `TOLLBOOTH_MPP` | on when `x402` set | `false` to switch MPP off |
| `TOLLBOOTH_MPP_SECRET` | `TOLLBOOTH_SECRET` | HMAC secret for MPP challenge ids |
| `TOLLBOOTH_MPP_NETWORKS` | `8453,42220` | CSV of EVM chain ids to offer as MPP challenges, or `all` |
| `TOLLBOOTH_TEMPO_API_KEY` | – | Tempo API key (`mpp:write` scope). Presence switches on the native Tempo rail (0.9.0) |
| `TOLLBOOTH_TEMPO_RECIPIENT` | `TOLLBOOTH_PAYTO` | Tempo payTo (0x address) |
| `TOLLBOOTH_TEMPO_CURRENCY` | USDC.e on Tempo | CSV of TIP-20 token addresses to offer (one challenge each, first = preferred) |
| `TOLLBOOTH_TEMPO_SPLITS` | – | `0xabc:0.0002,0xdef:0.0001` - split recipients + USD amounts paid in the same transaction (≤10, total below the price) |
| `TOLLBOOTH_TEMPO_API_BASE` | `https://api.tempo.xyz` | Tempo relay base URL override |
| `TOLLBOOTH_TEMPO_RPC_URL` | `https://rpc.tempo.xyz` | Tempo JSON-RPC for the chain-truth confirm step (0.9.2) |
| `TOLLBOOTH_ASSET` | `"USDC"` | Asset symbol in the quote (`USDG` charges in USDG on Robinhood Chain) |
| `TOLLBOOTH_POW_BITS` | `18` | Proof-of-work difficulty in leading zero bits |
| `TOLLBOOTH_MODE` | `"bots"` | Who pays: `bots` · `all` · `strict` |
| `TOLLBOOTH_ADAPTIVE` | `false` | Raise PoW difficulty as charged-request load climbs |
| `TOLLBOOTH_ADAPTIVE_PER_BIT` | `300` | +1 difficulty bit per N charged requests/min |
| `TOLLBOOTH_SECRET` | random | HMAC secret binding PoW challenges (set it to survive restarts / run multiple instances) |
| `TOLLBOOTH_REPLAY_SQLITE` | – | Path to a SQLite file every process shares as the single-use PoW record. Set it whenever more than one process serves the same `TOLLBOOTH_SECRET`. Needs Node 22.5+ (built-in `node:sqlite`) or an installed `better-sqlite3`; refuses to start if neither can open the file |
| `TOLLBOOTH_RESOURCE_BASE` | `TOLLBOOTH_UPSTREAM` | Absolute base used for the `resource` field / PoW binding |
| `TOLLBOOTH_VERIFY_TIMEOUT_MS` | `10000` | Abort an x402 settlement check after this long |
| `TOLLBOOTH_OBSERVE` | `false` | Observe-only: classify and count, never 402 |
| `TOLLBOOTH_ADMIN_TOKEN` | – | Token gating the `/__tollbooth` dashboard **and** `/__tollbooth/stats`. Unset logs a warning and leaves the dashboard publicly reachable (aggregate counts only) |
| `TOLLBOOTH_STATS_TOKEN` | – | Legacy token gating `/__tollbooth/stats` only |
| `PORT` | `4021` | Listen port |

Cloudflare Worker only (`worker.js`, bound in `wrangler.toml`):

| binding / env | meaning |
|---|---|
| `TOLLBOOTH_REPLAY` | Durable Object binding giving **atomic**, strict single-use PoW replay protection across isolates. Required in enforcing mode |
| `TOLLBOOTH_ALLOW_NON_ATOMIC_REPLAY` | `"true"` explicitly accepts non-atomic (KV or per-isolate) replay protection instead of a Durable Object. Without it, enforcing mode refuses to start |
| `TOLLBOOTH_KV` | KV namespace for durable stats |
| `TOLLBOOTH_STATS_BUCKET` | Stats bucket name within `TOLLBOOTH_KV` (default `"default"`) |

## How it decides who pays

By default (`mode: "bots"`) it charges requests whose `User-Agent` matches a known
**AI/LLM crawler** (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider,
Google-Extended, Amazonbot, …). Classic search indexers (Googlebot, Bingbot) are
intentionally **not** charged so your SEO indexing stays free.

**Don't want to play whack-a-mole with bot detection?** That's the point of the
other modes - you stop trying to *identify* bots and instead make access *cost
something*:
- `mode: "all"` charges every client (except a `free()` match). A "more
  sophisticated" bot gains nothing by disguising itself - everyone pays or solves
  a proof-of-work.
- `mode: "strict"` charges anything that isn't a real-browser request (browser-like
  UA **and** an HTML `Accept`), letting genuine human page-loads through free.
  Heads-up: that's a heuristic, not a security boundary - a bot that sets
  `User-Agent: Mozilla/5.0 …` + `Accept: text/html` gets the same free pass a
  human gets. Use `mode: "all"` (or your own `charge:` predicate) for hard
  guarantees.
- `adaptive: true` makes proof-of-work **harder as load climbs**, so a high-volume
  scraper pays escalating CPU per request regardless of how it looks - detection is
  cat-and-mouse, economics isn't.

## Observe before charging

Don't want to flip a meter on cold? **Run the gate in observe-only mode for a
week first** - every request is still classified (bot vs. human) and counted,
but nothing ever gets a 402:

```js
app.use(createTollbooth({ observe: true })); // or: TOLLBOOTH_OBSERVE=true
```

On the edge / Cloudflare Worker / Next.js: set `TOLLBOOTH_OBSERVE=true` in env.

The dashboard grows a **"Would charge"** counter so you can show your team -
or your client - exactly how much of their traffic is AI bots **before** you
start returning 402s. Removing the flag flips on enforcement with no other
changes. Bots see a `X-Tollbooth-Observed: would-charge` header in observe mode
(handy for log filtering); humans see nothing.

## Analytics

The middleware keeps aggregate counters (no per-request data):
- `gate.stats()` → sync, in-process mirror: `{ requests, freeAllowed, wouldCharge, charged, powSolved, x402Paid, mppPaid, tempoPaid, difficultyNow, observe }`.
- `gate.snapshot()` → async, reads from the configured durable sink (defaults to memory).
- `gate.flush()` → flush any buffered deltas to the durable sink (call inside `ctx.waitUntil` on edge runtimes).

The reverse-proxy CLI exposes them as JSON at **`/__tollbooth/stats`** and as a
live **dashboard at `/__tollbooth`** - requests, how many were charged,
proof-of-work solves, USDC collected, and what share of your traffic is bots.

## Durable stats (survive restart, aggregate across instances)

By default, stats live in process memory - fine for single-instance Node,
useless across multiple replicas or on the edge. Pass a `statsSink` to make
them survive:

```js
// Cloudflare Workers: aggregate across all isolates using the same KV namespace
// that holds the PoW single-use store.
import { createEdgeTollbooth, kvStatsSink } from "agent402-tollbooth/edge";
const gate = createEdgeTollbooth({
  secret: env.TOLLBOOTH_SECRET,
  statsSink: kvStatsSink(env.TOLLBOOTH_KV, { bucket: "default" }),
});
// inside fetch():
ctx.waitUntil(gate.flush()); // make sure deltas land in KV after the response
```

```js
// Any Node deploy: POST batched deltas to a tiny collector (Vercel KV /
// Upstash / your own API).
import { createTollbooth, httpStatsSink } from "agent402-tollbooth";
app.use(createTollbooth({
  statsSink: httpStatsSink(process.env.TOLLBOOTH_STATS_URL, {
    token: process.env.TOLLBOOTH_STATS_TOKEN,
  }),
}));
```

Sink interface (build your own - e.g. a Cloudflare Durable Object for strict
consistency):

```ts
type StatsSink = {
  incr(field: string, n?: number): void;        // fire-and-forget
  flush?(): Promise<void>;                       // optional explicit flush
  snapshot(): Promise<Record<string, number>>;   // aggregated view
};
```

## Single-use proof-of-work across workers and instances (`replayStore`)

**The default single-use record lives in ONE PROCESS'S MEMORY.** Read that
sentence twice if you run more than one process, because the two settings
interact:

- A stable `TOLLBOOTH_SECRET` is what makes a token minted by worker 1 verify on
  worker 2. Without it, multi-process deploys reject every solution.
- With it, and with no shared replay store, each process keeps its own
  "already used" list. One 18-bit solve is then redeemable **once per process**
  inside the token's 5-minute TTL, and again after a worker recycles. Four
  workers means four requests for one solve.

Pass a `replayStore` and every process claims against the same record:

```js
// Several Node workers on one host (cluster, pm2, one container with N processes).
import Database from "better-sqlite3";                 // or node:sqlite on Node 22.5+
import { createTollbooth, sqliteReplayStore } from "agent402-tollbooth";

const db = new Database("/var/lib/tollbooth/replay.db");
db.pragma("journal_mode = WAL");     // concurrent writers
db.pragma("busy_timeout = 5000");    // wait for the write lock instead of throwing

app.use(createTollbooth({ replayStore: sqliteReplayStore(db) }));
```

```js
// Instances across hosts, or a serverless runtime that can reach Redis.
import { createClient } from "redis";
import { createTollbooth, redisReplayStore } from "agent402-tollbooth";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
app.use(createTollbooth({ replayStore: redisReplayStore(redis) }));
```

`redisReplayStore` also accepts an ioredis client (their `SET` signatures differ;
the factory detects which one it was handed). Neither driver is a dependency of
this package: you pass a client you already opened, so the tollbooth still
installs with nothing but Express.

The bundled reverse proxy takes the SQLite path from the environment, so the CLI
needs no code:

```bash
TOLLBOOTH_SECRET=$(openssl rand -hex 32) \
TOLLBOOTH_REPLAY_SQLITE=/var/lib/tollbooth/replay.db \
TOLLBOOTH_UPSTREAM=https://your-origin.example \
npx agent402-tollbooth
```

Store interface (build your own against Postgres, DynamoDB, a Durable Object -
this is the same contract the edge gate's `store` option uses, so an
implementation ports between the two unchanged):

```ts
type ReplayStore = {
  // MUST be atomic: true only the first time this token is seen, false after.
  claim(token: string, expiresAtMs: number): boolean | Promise<boolean>;
};
```

Three things worth knowing before you write one:

- **It may be async.** `claim` can return a promise; `verify()` then returns a
  promise too, and the gate awaits it. A synchronous store keeps the gate
  synchronous, so existing single-process deploys are unaffected.
- **A throw is a refusal, not a pass.** If `claim` throws or rejects, the gate
  answers `402` with `X-Pow-Error: replay store unavailable`. Let your store
  throw when its backend is unreachable - guessing "probably unused" would hand
  out exactly the free passes the store exists to stop.
- **Non-atomic is not enough.** A separate "read, then write" pair lets two
  concurrent redemptions of one token both see "unseen" and both pass. SQLite's
  `INSERT OR IGNORE` on a primary key and Redis `SET NX` are atomic; a plain
  eventually-consistent key/value `get` + `put` is not.

Scope note: the SQLite store's guarantee is per **database file**, which covers
many processes sharing a disk. It does not cover hosts sharing a network
filesystem (SQLite locking is not reliable there) - use Redis or Postgres for
that shape.

## Edge analytics (Cloudflare Worker / Next.js)

The Cloudflare Worker entry (`worker.js`) auto-mounts both the dashboard and
JSON endpoint, BEFORE the gate so they're never paywalled:

- **`/__tollbooth`** → live dashboard
- **`/__tollbooth/stats`** → JSON snapshot (gate with `TOLLBOOTH_STATS_TOKEN` for bearer-auth)

With a `TOLLBOOTH_KV` namespace bound, the stats aggregate across all isolates
of all Cloudflare colos serving the Worker - one consistent view.

On Next.js / Vercel Edge, middleware can't mount dashboards itself (it'd gate
them), so a companion **route handler** at `app/__tollbooth/stats/route.js`
serves the JSON; a static **page** at `app/__tollbooth/page.jsx` renders the
dashboard HTML. Both are in [`deploy/nextjs/middleware.js`](deploy/nextjs/middleware.js)
as drop-in copyable snippets.

## Production checklist (read this)

- **Set a stable `TOLLBOOTH_SECRET`.** Required for any multi-process/clustered
  Node deploy and for all edge deploys - without it, proof-of-work tokens use a
  random per-process secret and are rejected across restarts/workers/isolates.
- **If more than one process shares that secret, supply a `replayStore`.** The
  default single-use record is per process, so a stable secret plus no shared
  store means one solve buys one free request per worker within its TTL. Node:
  `replayStore: sqliteReplayStore(db)` / `redisReplayStore(client)`, or
  `TOLLBOOTH_REPLAY_SQLITE=<path>` for the bundled proxy
  ([details](#single-use-proof-of-work-across-workers-and-instances-replaystore)).
- **For serverless/edge, supply a durable replay `store`** (bind a Durable Object
  as `TOLLBOOTH_REPLAY` for atomic claims; KV is eventually consistent and the
  Worker entry refuses to enforce on it without an explicit override). The
  in-memory default is per-isolate, so a solved token could otherwise be reused
  across isolates within its TTL.
- **The reverse proxy pins the host** to your configured upstream (a client can't
  redirect it elsewhere) and **strips client-forged trust/forwarding headers**
  (`X-Tollbooth-Paid`, `X-Forwarded-Host`, etc.) before forwarding.
- **UA matching is the default, not a security boundary** - a bot can forge a
  human UA to get the *same free access a human gets* (it gains nothing more). To
  stop relying on detection entirely, use `mode: "all"` / `mode: "strict"`, and
  turn on `adaptive` so high-volume abuse pays escalating proof-of-work.

## Notes

- Proof-of-work tokens are HMAC-signed, expiry-checked, single-use, and bound to
  the exact resource (path + query, dots and all) - a solution for one URL can't
  be replayed or reused on another. Single-use is recorded **per process** unless
  you pass a `replayStore`.
- MIT licensed. Part of [Agent402](https://github.com/MikeyPetrillo/Agent402).

## Charge in USDG on Robinhood Chain

The quote's network and asset are operator-configured, so the gate can charge
crawlers in **USDG (Global Dollar) on Robinhood Chain** (chain id 4663)
instead of USDC:

```bash
TOLLBOOTH_PAYTO=0xYourWallet \
TOLLBOOTH_NETWORK=eip155:4663 \
TOLLBOOTH_ASSET=USDG \
npx agent402-tollbooth          # advertises the USDG quote; settle it via the library API below
```

(The CLI's built-in settlement mode - `TOLLBOOTH_FACILITATOR_URL` - registers
the exact **USDC** scheme only and refuses to start with another asset rather
than advertise a quote it cannot settle.) In code: `createTollbooth({ payTo, network: "eip155:4663", asset: "USDG", x402 })`,
where `x402` is a `@x402/express` middleware whose facilitator settles chain
4663 (advertise `eip155:4663` in its `accepts`). Defaults are unchanged (USDC
on Base). MPP challenges are only minted for chains in `mppNetworks` (Base +
Celo by default - what a stock mppx client can sign); add `4663` there or pass
`"all"` if your buyers' MPP clients can sign USDG on Robinhood Chain.

## Legal

Use of the hosted instance at agent402.tools is subject to its [Terms of Service](https://agent402.tools/terms) (acceptable-use policy included) and [Privacy Policy](https://agent402.tools/privacy). This package is MIT-licensed; the hosted server is AGPL-3.0. Both are provided as-is without warranty, and self-hosted deployments are their operator's responsibility.

## Get paid into a Coinbase Business account

Coinbase Business accounts receive x402 payments from AI agents directly. The
tollbooth is the "integrate x402 into your API" step: point `TOLLBOOTH_PAYTO`
at the account's USDC receive address on Base and settle through Coinbase's
facilitator with a CDP API key.

```bash
npm i agent402-tollbooth @x402/express @x402/core @x402/evm @coinbase/x402
TOLLBOOTH_PAYTO=0xYourCoinbaseBusinessBaseAddress \
TOLLBOOTH_CDP_API_KEY_ID=... TOLLBOOTH_CDP_API_KEY_SECRET=... \
TOLLBOOTH_PRICE='$0.005' TOLLBOOTH_UPSTREAM=http://localhost:8080 \
npx agent402-tollbooth
```

Load the three values from a `.env` or a secret store rather than typing the
key on the command line. Live-proven 2026-08-27 with real USDC through
Coinbase's facilitator ([tx](https://basescan.org/tx/0x8175178ac4e2229dfd9385a3c78c491ffe554b08fdf52cf92f99425c983ec5d1));
note the facilitator refuses a payer paying itself (`self_send_not_allowed`),
so test from a second wallet. Every paid request settles as USDC into the Coinbase Business account; humans
browse your site normally. Full walkthrough with an Express example:
https://agent402.tools/guides/coinbase-business-get-paid-by-agents

