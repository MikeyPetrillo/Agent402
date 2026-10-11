# Tollbooth for SEO agencies

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

A playbook for agencies (boutique → mid-market) that want to add **"we'll
put a price on AI crawling of your site, and settle it straight to your
wallet"** to their service menu - with an open-source gate you install and run
yourself, not tied to any one host or CDN.

> If you're a publisher with one or two sites, the install page at
> [agent402.tools/tollbooth](https://agent402.tools/tollbooth) is enough.
> This page is for someone deploying across 10-100 client properties.

## The pitch (to your client)

Tollbooth is an open, self-hostable pay-per-crawl gate:

- **Put a cost on AI crawling today**: known AI crawlers get a 402 and must
  pay or solve a proof-of-work, with no cooperation needed from the crawler's
  operator.
- **Get paid by agents that pay**: any x402 or MPP client can settle the 402,
  and USDC settles direct to the publisher's wallet (*no merchant of record,
  no agency in the middle of the money*).
- **Portable across hosts**: Express, Next.js middleware, a reverse proxy,
  a Cloudflare Worker, Deno or Bun. WordPress plugin in beta. When a client
  changes hosts, the gate moves with them.

## A 5-step deployment playbook for many sites

### Step 1 · Inventory client UA traffic before you sell

Run [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth)
in **observe mode** on each candidate site for 7-14 days. The gate
classifies every request as human-vs-crawler and counts what *would* have
been charged - but never returns 402. This gives you a real number to put
in the client deck instead of an industry-average guess.

```js
import { createTollbooth } from "agent402-tollbooth";
app.use(createTollbooth({ observe: true }));
```

Or as a Cloudflare Worker / Next.js middleware - see
[Pay-per-crawl Walkthrough](Pay-per-crawl-Walkthrough). When you flip on
enforcement, *the same code* starts returning 402; nothing about the
classifier changes.

### Step 2 · Pick the right charge mode per client

| Mode | Who pays | When to use it |
|---|---|---|
| `bots` (default) | The 28 crawler/scraper user-agents in `AI_BOTS` | News publishers, blogs, anyone who still wants Googlebot/Bingbot. **Pick this by default.** |
| `all` | Anyone but a `free()` match | API endpoints, paywalled APIs, anything where you don't want passive scraping |
| `strict` | Anyone without a real-browser UA + HTML `Accept` | Premium content where you accept some false-positive friction |

Configure per-site via the `mode` option or the `TOLLBOOTH_MODE` env. You
can also override with custom `charge(req)` / `free(req)` predicates for
client-specific allowlists (e.g. "always free for the client's monitoring
bot").

### Step 3 · One wallet per client, one shared stats sink

Each client site sets its own `payTo` wallet - the USDC settles direct to
the client, never to you. For multi-site rollup, point every site's
`statsSink` at the same HTTP endpoint: an ingest service you run. The OSS
gate ships both `kvStatsSink` (Cloudflare KV, per-Worker) and `httpStatsSink`
(any HTTP endpoint).

```js
import { createTollbooth, httpStatsSink } from "agent402-tollbooth";

app.use(createTollbooth({
  payTo: process.env.CLIENT_USDC_WALLET,
  price: "$0.002",
  observe: true,                                  // Phase 1
  // One collector URL per site (the path is your multi-site tag);
  // the token is sent as Authorization: Bearer and requires https.
  statsSink: httpStatsSink("https://stats.your-agency.com/ingest/client-acme", {
    token: process.env.TOLLBOOTH_INGEST_TOKEN,
  }),
}));
```

The wire format is documented in
[`tollbooth/sinks.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/sinks.js)
- batched POSTs of `{ incr: { field: n, … }, ts }` (aggregate counter
deltas, flushed every 2 seconds by default), never per-request data, and a
GET on the same URL returns the aggregated snapshot. Store it wherever you
like.

### Step 4 · Set per-client alert thresholds

Alerts run on your own collector: it already receives every site's counter
deltas, so a few rules over those numbers cover most clients:

- **Spike alert**: charged requests in last hour > 5× the trailing-7-day
  median → email + Slack. Catches a new crawler campaign before it racks
  up cost (or, in observe mode, before it gobbles content).
- **Settlement alert**: any settled USDC > $0 → email. The first time a
  client's wallet gets paid is the moment that converts the client from
  "interested" to "evangelist."
- **Health alert**: classification rate (charged / total) drops to 0 for
  > 30 min → email. Means either the gate broke or you got knocked offline.

### Step 5 · Monthly client report

Build the report from the counters each gate already keeps (`gate.stats()`,
or the `/__tollbooth/stats` endpoint on your own deployment) and from the
client's wallet history:

- Total requests, charged requests, and how each was answered (paid over
  x402 or MPP, solved a proof-of-work, or let through free)
- USDC settled this month and lifetime, linked to the client's wallet on a
  block explorer (clients love trustless evidence)
- In observe mode, how many requests *would* have been charged
- A graph of the charged share over time (the chart you put in next
  quarter's retainer renewal deck)

## Deploying across heterogeneous client stacks

| Client stack | Recommended deployment |
|---|---|
| **Node / Express** | `app.use(createTollbooth(...))` directly. ~5 min. |
| **Next.js** | `middleware.js` template at `tollbooth/deploy/nextjs`. ~5 min. |
| **Anything behind Cloudflare** | Cloudflare Worker template at `tollbooth/deploy/cloudflare`. ~10 min, KV-backed, no origin change. |
| **WordPress** | The Agent402 Tollbooth plugin (beta - see `tollbooth/deploy/wordpress`). Upload, activate, paste your wallet, done. |
| **Any other backend** | Run the package as a reverse proxy: `TOLLBOOTH_UPSTREAM=https://origin.example.com npx agent402-tollbooth`. Drop into a Docker compose. |
| **Static (Netlify / Vercel)** | Sit a Cloudflare Worker in front. The Worker template works unchanged. |

The portability is the agency selling point: your install playbook is
*the same gate on any of the above stacks*, just a different deploy
target. What you sell is AI-crawl monetization that survives a hosting migration.

## What we don't do (so you can plan around it)

- **We don't sit between you and your clients.** The gate is MIT-licensed
  code you deploy; there is no account, no checkout and no signup.
- **We don't take a cut of settled USDC.** Ever. The protocol's
  non-custodial promise is structural, not aspirational. Your client's
  wallet is the only address that ever holds their pay-per-crawl revenue.
- **We don't ship a "managed bot intelligence" feed.** The classifier is
  the static UA list in [`tollbooth/bots.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/bots.js)
  plus the `strict` heuristic; we don't run a SaaS-fed signature service.
  If a new AI crawler shows up, you (or a community PR) add it to the list.

## Questions

[Open an issue](https://github.com/MikeyPetrillo/Agent402/issues) on the repo.

---

See also:
- [Pay-per-crawl (the Tollbooth)](Pay-per-crawl) - protocol-level reference
- [Pay-per-crawl Walkthrough](Pay-per-crawl-Walkthrough) - 30-minute install
  guide for a single site
- [Security Model](Security-Model) - what the gate does and doesn't
  protect against
