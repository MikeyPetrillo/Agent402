# Tollbooth for SEO agencies

A playbook for agencies (boutique → mid-market) that want to add **"we'll
help you opt out of AI training, and you're already set up to monetize the
moment buyer-side x402 lands at OpenAI / Anthropic / Perplexity"** to their
service menu — without locking clients into a single CDN.

> If you're a publisher with one or two sites, the install page at
> [agent402.tools/tollbooth](https://agent402.tools/tollbooth) is enough.
> This page is for someone deploying across 10-100 client properties.

## The pitch (to your client)

In 2024-2025 every major news publisher, SaaS, e-commerce, and DTC brand
quietly discovered that **AI training crawlers had been eating their content
for years**. The Cloudflare AI Crawl Toll is the loudest answer; it's also a
single-vendor lock-in priced as a CDN add-on. Tollbooth is the open,
portable alternative:

- **Block AI training scrapers today** (no AI vendor cooperation required —
  PoW is a free deterrent).
- **Be ready to monetize** the instant OpenAI / Anthropic / Perplexity ship
  buyer-side x402 (USDC settles direct to the publisher's wallet — *no
  Stripe, no merchant of record, no agency in the middle of the money*).
- **Portable across hosts**: Express, Next.js middleware, a reverse proxy,
  a Cloudflare Worker, Deno or Bun. WordPress plugin in beta. Move a client
  off Cloudflare, the gate moves with them.

## Pricing & partner economics

| | Solo | Team | Agency | Enterprise |
|---|---|---|---|---|
| Price | $19/mo | $99/mo | $299/mo | Contact |
| Sites | 1 | 25 | 100 | Unlimited |
| Retention | 30d | 90d | 1y | Custom |

Annual prepay = 16% off (2 months free). Full pricing and waitlist at
[agent402.tools/tollbooth/cloud](https://agent402.tools/tollbooth/cloud).

**Partner program**: 20% lifetime recurring on every Team or Agency plan
you refer. Paid via Stripe — *not* USDC — so the protocol's non-custodial
promise stays clean (we never touch the publisher's settled funds, and
neither does your kickback). Apply via the **partner-program** link on
the Cloud page.

**Two-sided kicker**: any wallet running a verified Tollbooth install
earns **1.5× bonus Agent402.tools credit** per dollar of settled USDC. Your
clients can spend it on the [1,234 paid tools](https://agent402.tools/tools)
they'd otherwise be paying API vendors for — useful for client deliverables
(content extraction, SERP scraping, geocoding, OCR, PDF tooling, …).

## A 5-step deployment playbook for many sites

### Step 1 · Inventory client UA traffic before you sell

Run [`agent402-tollbooth`](https://www.npmjs.com/package/agent402-tollbooth)
in **observe mode** on each candidate site for 7-14 days. The gate
classifies every request as human-vs-crawler and counts what *would* have
been charged — but never returns 402. This gives you a real number to put
in the client deck instead of an industry-average guess.

```js
import { createTollbooth } from "agent402-tollbooth";
app.use(createTollbooth({ observe: true }));
```

Or as a Cloudflare Worker / Next.js middleware — see
[Pay-per-crawl Walkthrough](Pay-per-crawl-Walkthrough). When you flip on
enforcement, *the same code* starts returning 402; nothing about the
classifier changes.

### Step 2 · Pick the right charge mode per client

| Mode | Who pays | When to use it |
|---|---|---|
| `bots` (default) | The 25 known AI/LLM crawler UAs | News publishers, blogs, anyone who still wants Googlebot/Bingbot. **Pick this by default.** |
| `all` | Anyone but a `free()` match | API endpoints, paywalled APIs, anything where you don't want passive scraping |
| `strict` | Anyone without a real-browser UA + HTML `Accept` | Premium content where you accept some false-positive friction |

Configure per-site via the `mode` option or the `TOLLBOOTH_MODE` env. You
can also override with custom `charge(req)` / `free(req)` predicates for
client-specific allowlists (e.g. "always free for the client's monitoring
bot").

### Step 3 · One wallet per client, one shared stats sink

Each client site sets its own `payTo` wallet — the USDC settles direct to
the client, never to you. For multi-site rollup, point every site's
`statsSink` at the same HTTP endpoint (your hosted dashboard on Tollbooth
Cloud, or your own ingest service). The OSS gate ships both `kvStatsSink`
(Cloudflare KV, per-Worker) and `httpStatsSink` (any HTTP endpoint).

```js
import { createTollbooth, httpStatsSink } from "agent402-tollbooth";

app.use(createTollbooth({
  payTo: process.env.CLIENT_USDC_WALLET,
  price: "$0.002",
  observe: true,                                  // Phase 1
  statsSink: httpStatsSink({
    url: "https://stats.your-agency.com/ingest",
    token: process.env.TOLLBOOTH_INGEST_TOKEN,
    siteId: "client-acme",                        // tag for multi-site rollup
  }),
}));
```

The wire format is documented in
[`tollbooth/sinks.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/sinks.js)
— it's minute-level aggregate counters per `siteId`, never per-request
data. You can ingest into Postgres, ClickHouse, BigQuery, or just keep it
in KV.

### Step 4 · Set per-client alert thresholds

Cloud Team and Agency tiers let you set per-site alert rules without code.
The defaults you'll want for most clients:

- **Spike alert**: charged requests in last hour > 5× the trailing-7-day
  median → email + Slack. Catches a new crawler campaign before it racks
  up cost (or, in observe mode, before it gobbles content).
- **Settlement alert**: any settled USDC > $0 → email. The first time a
  client's wallet gets paid is the moment that converts the client from
  "interested" to "evangelist."
- **Health alert**: classification rate (charged / total) drops to 0 for
  > 30 min → email. Means either the gate broke or you got knocked offline.

### Step 5 · Monthly client report

The Cloud Team plan ships a monthly PDF per `siteId` with:

- Total requests, classified bot %, top 5 bot user-agents
- USDC settled this month, lifetime USDC settled (linked to a Basescan
  proof URL — clients love trustless evidence)
- Most-charged paths (which content is most attractive to AI crawlers —
  doubles as a content-strategy signal)
- A graph of bot share over time (the chart you put in next quarter's
  retainer renewal deck)

You can also pull the same data via the `/api/cloud/report` API (Team
tier and up) to drop into your existing reporting stack.

## Deploying across heterogeneous client stacks

| Client stack | Recommended deployment |
|---|---|
| **Node / Express** | `app.use(createTollbooth(...))` directly. ~5 min. |
| **Next.js** | `middleware.ts` template at `tollbooth/deploy/nextjs`. ~5 min. |
| **Anything behind Cloudflare** | Cloudflare Worker template at `tollbooth/deploy/cloudflare`. ~10 min, KV-backed, no origin change. |
| **WordPress** | `agent402-tollbooth-wp` plugin (beta — see `tollbooth/deploy/wordpress`). Upload, activate, paste your wallet, done. |
| **Any other backend** | Run the package as a reverse proxy: `TOLLBOOTH_UPSTREAM=https://origin.example.com agent402-tollbooth`. Drop into a Docker compose. |
| **Static (Netlify / Vercel)** | Sit a Cloudflare Worker in front. The Worker template works unchanged. |

The portability is the agency selling point: your install playbook is
*the same gate on any of the above stacks*, just a different deploy
target. You're not selling a CDN — you're selling AI-crawl monetization
that survives a hosting migration.

## White-label setup (Agency plan)

1. Create a CNAME record: `tollbooth.your-agency.com → cloud.agent402.tools`.
2. In the Agency dashboard, register the subdomain. We provision a TLS
   cert (Let's Encrypt) and serve your branded dashboard at the CNAME.
3. Set your agency name + logo. The dashboard, the monthly PDF, and the
   alert emails all show your brand. The footer says "powered by Agent402"
   — that's the only attribution.

## What we don't do (so you can plan around it)

- **We don't email or sell to your clients.** Cloud customer-of-record is
  the agency on Team/Agency plans. Your client never sees our checkout.
- **We don't take a cut of settled USDC.** Ever. The protocol's
  non-custodial promise is structural, not aspirational. Your client's
  wallet is the only address that ever holds their pay-per-crawl revenue.
- **We don't ship a "managed bot intelligence" feed.** The classifier is
  the static UA list in [`tollbooth/bots.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/bots.js)
  plus the `strict` heuristic; we don't run a SaaS-fed signature service.
  If a new AI crawler shows up, you (or a community PR) add it to the list.

## Apply

- Pricing + plan comparison: [agent402.tools/tollbooth/cloud](https://agent402.tools/tollbooth/cloud)
- Waitlist (pre-launch — anyone in gets the launch price for life):
  link on the Cloud page
- Partner program application: also on the Cloud page (separate form)
- Questions: [open an issue](https://github.com/MikeyPetrillo/Agent402/issues) on the repo

---

See also:
- [Pay-per-crawl (the Tollbooth)](Pay-per-crawl) — protocol-level reference
- [Pay-per-crawl Walkthrough](Pay-per-crawl-Walkthrough) — 30-minute install
  guide for a single site
- [Security Model](Security-Model) — what the gate does and doesn't
  protect against
