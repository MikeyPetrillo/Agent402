# agent402-tollbooth

**Open-source, self-hostable x402 "pay-per-crawl". Put it in front of any site or
API: humans browse free, AI crawlers and agents pay per request** — either in
USDC over the [x402 protocol](https://x402.org), or for free by solving a
proof-of-work. No Cloudflare, no Stripe, no Merchant-of-Record, no signup.

The big platforms ([Cloudflare](https://stackoverflow.blog/2026/02/26/how-pay-per-crawl-is-reshaping-data-monetization/),
Stack Overflow) shipped pay-per-crawl as a closed, fiat, you-must-be-on-our-CDN
feature. This is the open, crypto-native, run-it-yourself version — built on the
same hardened 402 + proof-of-work machinery as [Agent402](https://github.com/MikeyPetrillo/Agent402).

## See it work (one command)

```bash
npx agent402-tollbooth   # then, in the repo:  npm run --prefix tollbooth demo
```

```text
agent402-tollbooth — live pay-per-crawl demo

① A human opens the page (normal browser)
   → HTTP 200 FREE  "📄 The Future of Machine Payments — full article text…"
   Humans are never charged.

② An AI crawler hits the same page (ClaudeBot)
   → HTTP 402 Payment Required
   pay with USDC: $0.002 USDC on base → 0x…
   …or free with proof-of-work: a 18-bit sha256 puzzle

③ The crawler has no wallet, so it spends CPU instead
   solved in 0.32s (nonce=100208)
   → HTTP 200 OK (paid via pow)  "📄 The Future of Machine Payments — full article text…"

✓ Pay-per-crawl, end to end — humans free, bots pay (USDC or compute).
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
`X-Pow-Solution: <token>:<nonce>` — sub-second of CPU, single-use, bound to that
exact URL.

## Use it as a reverse proxy (any language/framework)

Point it at your existing site — no code changes there:

```bash
TOLLBOOTH_UPSTREAM=https://your-site.com \
TOLLBOOTH_PAYTO=0xYourWallet \
npx agent402-tollbooth          # listens on :4021, proxies humans free, charges bots
```

## Run on the edge (Cloudflare Workers, Next.js, Deno, Bun)

The same gate is also built on the Web Crypto + Fetch APIs (`edge.js`), so it runs
anywhere — no Node required. The gate returns a `402 Response` when the client
must pay, or `null` to let it through.

**Ready-to-deploy templates** (copy a folder, don't assemble from docs):

- **Cloudflare Workers** → [`deploy/cloudflare/`](deploy/cloudflare/) — a ready
  `wrangler.toml` + a 3-step deploy guide (the open pay-per-crawl, on the
  incumbent's own platform).
- **Next.js / Vercel** → [`deploy/nextjs/`](deploy/nextjs/) — a drop-in
  `middleware.js` + a 3-step deploy guide.
- **Docker** → [`deploy/docker/`](deploy/docker/) — a `Dockerfile` +
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
> (e.g. a Cloudflare KV wrapper — the Worker entry wires this for you).

## Accepting USDC (x402)

The proof-of-work rail works with **zero config**. To also settle real USDC,
set `payTo` and supply `verifyX402` — wire it to the standard, audited x402
server stack (`@x402/express` / your facilitator) rather than reinventing
settlement:

```js
import { paymentMiddleware } from "x402-express"; // or @x402/express
const x402 = paymentMiddleware(/* your wallet + facilitator config */);

app.use(createTollbooth({
  payTo: "0xYourWallet",
  network: "base",
  // Reuse the standard middleware to verify the X-PAYMENT header:
  verifyX402: (req) => new Promise((resolve) =>
    x402(req, { setHeader() {}, status() { return this; }, json() { resolve(false); } }, () => resolve(true))),
}));
```

(PoW is checked first, so an agent without a wallet always has a free path.)

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
| `verifyX402(req, reqs)` | – | Async USDC settlement check (return `true` to allow) |
| `resourceBaseUrl` | `""` | Absolute base used for the `resource` field / PoW binding |
| `observe` | `false` | Observe-only: classify and count, but never 402. For pre-launch traffic measurement. |
| `statsSink` | in-memory | Durable stats backend. Built-ins: `memorySink`, `kvStatsSink(kv)`, `httpStatsSink(url)`. |

Environment variables: `TOLLBOOTH_UPSTREAM`, `TOLLBOOTH_PAYTO`, `TOLLBOOTH_PRICE`,
`TOLLBOOTH_NETWORK`, `TOLLBOOTH_POW_BITS`, `TOLLBOOTH_MODE`, `TOLLBOOTH_ADAPTIVE`,
`TOLLBOOTH_MAX_POW_BITS`, `TOLLBOOTH_ADAPTIVE_PER_BIT`, `TOLLBOOTH_SECRET`,
`TOLLBOOTH_OBSERVE`, `TOLLBOOTH_STATS_TOKEN`, `TOLLBOOTH_STATS_BUCKET`, `PORT`.

## How it decides who pays

By default (`mode: "bots"`) it charges requests whose `User-Agent` matches a known
**AI/LLM crawler** (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider,
Google-Extended, Amazonbot, …). Classic search indexers (Googlebot, Bingbot) are
intentionally **not** charged so your SEO indexing stays free.

**Don't want to play whack-a-mole with bot detection?** That's the point of the
other modes — you stop trying to *identify* bots and instead make access *cost
something*:
- `mode: "all"` charges every client (except a `free()` match). A "more
  sophisticated" bot gains nothing by disguising itself — everyone pays or solves
  a proof-of-work.
- `mode: "strict"` charges anything that isn't a real-browser request (browser-like
  UA **and** an HTML `Accept`), letting genuine human page-loads through free.
- `adaptive: true` makes proof-of-work **harder as load climbs**, so a high-volume
  scraper pays escalating CPU per request regardless of how it looks — detection is
  cat-and-mouse, economics isn't.

## Observe before charging

Don't want to flip a meter on cold? **Run the gate in observe-only mode for a
week first** — every request is still classified (bot vs. human) and counted,
but nothing ever gets a 402:

```js
app.use(createTollbooth({ observe: true })); // or: TOLLBOOTH_OBSERVE=true
```

On the edge / Cloudflare Worker / Next.js: set `TOLLBOOTH_OBSERVE=true` in env.

The dashboard grows a **"Would charge"** counter so you can show your team —
or your client — exactly how much of their traffic is AI bots **before** you
start returning 402s. Removing the flag flips on enforcement with no other
changes. Bots see a `X-Tollbooth-Observed: would-charge` header in observe mode
(handy for log filtering); humans see nothing.

## Analytics

The middleware keeps aggregate counters (no per-request data):
- `gate.stats()` → sync, in-process mirror: `{ requests, freeAllowed, wouldCharge, charged, powSolved, x402Paid, difficultyNow, observe }`.
- `gate.snapshot()` → async, reads from the configured durable sink (defaults to memory).
- `gate.flush()` → flush any buffered deltas to the durable sink (call inside `ctx.waitUntil` on edge runtimes).

The reverse-proxy CLI exposes them as JSON at **`/__tollbooth/stats`** and as a
live **dashboard at `/__tollbooth`** — requests, how many were charged,
proof-of-work solves, USDC collected, and what share of your traffic is bots.

## Durable stats (survive restart, aggregate across instances)

By default, stats live in process memory — fine for single-instance Node,
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

Sink interface (build your own — e.g. a Cloudflare Durable Object for strict
consistency):

```ts
type StatsSink = {
  incr(field: string, n?: number): void;        // fire-and-forget
  flush?(): Promise<void>;                       // optional explicit flush
  snapshot(): Promise<Record<string, number>>;   // aggregated view
};
```

## Edge analytics (Cloudflare Worker / Next.js)

The Cloudflare Worker entry (`worker.js`) auto-mounts both the dashboard and
JSON endpoint, BEFORE the gate so they're never paywalled:

- **`/__tollbooth`** → live dashboard
- **`/__tollbooth/stats`** → JSON snapshot (gate with `TOLLBOOTH_STATS_TOKEN` for bearer-auth)

With a `TOLLBOOTH_KV` namespace bound, the stats aggregate across all isolates
of all Cloudflare colos serving the Worker — one consistent view.

On Next.js / Vercel Edge, middleware can't mount dashboards itself (it'd gate
them), so a companion **route handler** at `app/__tollbooth/stats/route.js`
serves the JSON; a static **page** at `app/__tollbooth/page.jsx` renders the
dashboard HTML. Both are in [`deploy/nextjs/middleware.js`](deploy/nextjs/middleware.js)
as drop-in copyable snippets.

## Production checklist (read this)

- **Set a stable `TOLLBOOTH_SECRET`.** Required for any multi-process/clustered
  Node deploy and for all edge deploys — without it, proof-of-work tokens use a
  random per-process secret and are rejected across restarts/workers/isolates.
- **For serverless/edge, supply a durable replay `store`** (e.g. bind a Cloudflare
  KV namespace as `TOLLBOOTH_KV`). The in-memory default is per-isolate, so a
  solved token could be reused across isolates within its TTL. The Worker entry
  warns when no KV is bound.
- **The reverse proxy pins the host** to your configured upstream (a client can't
  redirect it elsewhere) and **strips client-forged trust/forwarding headers**
  (`X-Tollbooth-Paid`, `X-Forwarded-Host`, etc.) before forwarding.
- **UA matching is the default, not a security boundary** — a bot can forge a
  human UA to get the *same free access a human gets* (it gains nothing more). To
  stop relying on detection entirely, use `mode: "all"` / `mode: "strict"`, and
  turn on `adaptive` so high-volume abuse pays escalating proof-of-work.

## Notes

- Proof-of-work tokens are HMAC-signed, expiry-checked, single-use, and bound to
  the exact resource (path + query, dots and all) — a solution for one URL can't
  be replayed or reused on another.
- MIT licensed. Part of [Agent402](https://github.com/MikeyPetrillo/Agent402).
