# Pay-per-crawl (the Tollbooth)

Agent402 is two-sided. The main server lets **agents buy tools**. The
[`agent402-tollbooth`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth)
package is the inverse: it lets **any site charge the AI bots that crawl it**.

> Put it in front of any site or API: human visitors browse free, while AI
> crawlers and agents pay per request — in USDC over x402, or for free by solving
> a proof-of-work. The open, self-hostable answer to Cloudflare's closed
> pay-per-crawl: no CDN lock-in, no Stripe, no Merchant-of-Record, no signup.

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

## One-click deploy

Ready-to-copy templates: [`deploy/cloudflare/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare)
(Cloudflare Workers), [`deploy/nextjs/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/nextjs)
(Next.js / Vercel middleware), and [`deploy/docker/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/docker)
(`docker compose up -d` reverse proxy). The reverse proxy also serves a live
operator **dashboard at `/__tollbooth`** (and JSON at `/__tollbooth/stats`).

## Why it exists

The big platforms shipped pay-per-crawl as a closed, fiat, you-must-be-on-our-CDN
feature. This is the open, crypto-native, run-it-yourself version, built on the
same 402 + proof-of-work machinery as the rest of Agent402. It turns the project
into both sides of the x402 economy: agents buy capabilities, and sites charge
agents.

Full docs and config table: [tollbooth/README.md](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/README.md).
MIT licensed.
