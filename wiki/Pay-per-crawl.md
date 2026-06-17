# Pay-per-crawl (the Tollbooth)

Agent402 is two-sided. The main server lets **agents buy tools**. The
[`agent402-tollbooth`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth)
package is the inverse: it lets **any site charge the AI bots that crawl it**.

> Put it in front of any site or API: human visitors browse free, while AI
> crawlers and agents pay per request — in USDC over x402, or for free by solving
> a proof-of-work. The open, self-hostable answer to Cloudflare's closed
> pay-per-crawl: no CDN lock-in, no Stripe, no Merchant-of-Record, no signup.

### Three ways to use it

| | Best for | Where |
|---|---|---|
| **Run it yourself** | 1–2 sites, you control the deploy | `npm i agent402-tollbooth` · [product page](https://agent402.tools/tollbooth) |
| **Tollbooth Cloud** (managed) | Don't want to host gates, dashboards, KV | [agent402.tools/tollbooth/cloud](https://agent402.tools/tollbooth/cloud) — Solo / Team / Agency / Enterprise, join the waitlist |
| **For SEO / pay-per-crawl agencies** | 10+ client properties, partner economics | [[Tollbooth for Agencies\|Tollbooth-for-Agencies]] |

## Two ways to run it

**Express middleware** — humans pass; known AI crawlers get `402`:

```js
import express from "express";
import { createTollbooth } from "agent402-tollbooth";

const app = express();
app.use(createTollbooth({ price: "$0.002" }));
app.get("/article", (_req, res) => res.send("…your content…"));
app.listen(3000);
```

**Reverse proxy** — wrap any existing site, any language, zero code changes:

```bash
TOLLBOOTH_UPSTREAM=https://your-site.com node tollbooth/index.js
```

```bash
curl -A "Mozilla/5.0" localhost:4021/article     # human -> 200, free
curl -A "ClaudeBot/1.0" localhost:4021/article   # bot   -> 402 Payment Required
```

## How it works

- **Who pays:** by default, requests whose `User-Agent` matches a known AI/LLM
  crawler (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider, Google-Extended,
  …). Classic search indexers (Googlebot, Bingbot) are **not** charged, so SEO
  stays free. Override with `botUserAgents`, or a custom `charge(req)` predicate.
- **Free rail (proof-of-work):** works out of the box, no wallet. A crawler
  solves a single-use, resource-bound sha256 puzzle and retries with
  `X-Pow-Solution: <token>:<nonce>` — the same hardened scheme the main server
  uses (see [[Paying with Compute]]).
- **Paid rail (x402 USDC):** set `payTo` and supply a `verifyX402` hook wired to
  the standard x402 stack — settlement is reused, not reinvented (see
  [[Paying with x402]]).

## Beyond UA detection (the cat-and-mouse answer)

UA matching is the default, but it's evadable — so the tollbooth lets you stop
*detecting* bots and instead make access *cost something* (opt-in, defaults
unchanged):

- **`mode`:** `"bots"` (default) · `"all"` (charge everyone but a `free()` match)
  · `"strict"` (charge anything that isn't a real-browser request). A more
  sophisticated bot gains nothing — it pays or solves a proof-of-work like
  everyone else.
- **`adaptive: true`:** proof-of-work difficulty **rises with load** (capped), so
  a high-volume scraper pays escalating CPU per request regardless of disguise.
  Detection is an arms race; economics isn't.
- **Analytics:** `gate.stats()` and a `/__tollbooth/stats` endpoint show requests,
  how many were charged, proof-of-work solves, and USDC collected — so you can see
  how much of your traffic is bots and what it's worth.

## Observe before charging (`observe: true`)

You don't have to flip the meter on cold. **Observe-only mode** classifies every
request as bot vs. human and counts it, but never returns `402`. Deploy for a
week, watch the dashboard fill, then flip the flag off to start enforcing — no
other code changes.

```js
app.use(createTollbooth({ observe: true })); // or TOLLBOOTH_OBSERVE=true
```

The dashboard grows a **"Would charge"** counter, and bots see a
`X-Tollbooth-Observed: would-charge` header for log filtering.

## Durable stats + edge analytics

By default, stats live in process memory: fine for single-instance Node,
useless on the edge or across replicas. Pass a `statsSink` to make them
survive restarts and aggregate across instances:

```js
// Cloudflare Workers: aggregate across every isolate using KV
import { createEdgeTollbooth, kvStatsSink } from "agent402-tollbooth/edge";
const gate = createEdgeTollbooth({
  secret: env.TOLLBOOTH_SECRET,
  statsSink: kvStatsSink(env.TOLLBOOTH_KV),
});
ctx.waitUntil(gate.flush()); // ensure deltas land in KV after the response
```

On the Cloudflare Worker entry, **`/__tollbooth`** and **`/__tollbooth/stats`**
are auto-mounted before the gate (so they're free and unblockable). With KV
bound, the dashboard shows one consistent number across every colo.

On Next.js / Vercel Edge, middleware can't host endpoints itself, so a
companion **route handler** + dashboard **page** ship as drop-in snippets in
`deploy/nextjs/middleware.js`. The middleware writes via `httpStatsSink` to
the route handler, which persists into Vercel KV / Upstash.

Build your own sink by implementing `{ incr(field, n?), flush?(), snapshot() }`
— e.g. a Durable Object for strongly-consistent counters, or pipe into Cloudflare
Analytics Engine.

## One-click deploy

Ready-to-copy templates: [`deploy/cloudflare/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare)
(Cloudflare Workers), [`deploy/nextjs/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/nextjs)
(Next.js / Vercel middleware), [`deploy/docker/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/docker)
(`docker compose up -d` reverse proxy), and [`deploy/wordpress/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/wordpress)
(beta — drop-in WordPress plugin, pure PHP classifier, optional Worker for the
PoW + USDC rails). The reverse proxy also serves a live operator
**dashboard at `/__tollbooth`** (and JSON at `/__tollbooth/stats`).

Running 10+ client sites? See [Tollbooth for Agencies](Tollbooth-for-Agencies)
for the multi-site playbook, partner program, and Cloud pricing.

## Why it exists

The big platforms shipped pay-per-crawl as a closed, fiat, you-must-be-on-our-CDN
feature. This is the open, crypto-native, run-it-yourself version, built on the
same 402 + proof-of-work machinery as the rest of Agent402. It turns the project
into both sides of the x402 economy: agents buy capabilities, and sites charge
agents.

Full docs and config table: [tollbooth/README.md](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/README.md).
MIT licensed.
