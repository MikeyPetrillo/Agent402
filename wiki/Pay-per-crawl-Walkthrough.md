# Pay-per-crawl walkthrough - observe → bots → enforce in 30 minutes of work

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

A copy/paste recipe for taking a real site from **"I have no idea who's crawling me"** to **"AI agents pay me per request"** in three deploys. Hands-on time: ~30 minutes, plus the observation windows between phases; total written code: ~5 lines.

This is the safe rollout. Each phase is reversible by changing one flag and redeploying.

- **Phase 1 (10 min): Observe.** Deploy in observe mode - no enforcement, no risk. Watch the [dashboard](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth#analytics) for 24h to see what's actually crawling you.
- **Phase 2 (10 min): Charge known bots.** Flip to `mode: "bots"`. Real AI crawlers get 402. Humans and search engines pass.
- **Phase 3 (10 min): Charge everyone non-human.** Flip to `mode: "strict"` (or `"all"`, which charges browsers too) once your dashboard says it's safe.

> `observe` and `mode` are **different options**: `observe` is a boolean, `mode` is `bots` / `all` / `strict`. `mode: "observe"` is not a thing and would silently leave you on the charging default.

## Prereqs

- A Node 20+ runtime in front of your site (`agent402-tollbooth` declares `engines.node >= 20`) (Express, or a Cloudflare Worker, or a Next.js middleware - all supported).
- A wallet address to receive USDC on a chain your x402 facilitator settles. The reverse-proxy CLI builds settlement for USDC on Base, Polygon, Arbitrum, Optimism, Avalanche, Celo, Sei and Monad; other rails take the library API with the matching x402 scheme. (Or skip it entirely and accept proof-of-work only - no wallet needed.)
- ~30 minutes.

## Phase 1: Observe (10 minutes)

Install the gate and put it in front of your routes - **observe mode means nothing gets blocked**. Every request is classified (`human` / `bot` / `paid` / `would-charge`) and counted, so you can see who's crawling you before you ever touch enforcement.

```bash
npm install agent402-tollbooth
```

```js
// app.js
import express from "express";
import { createTollbooth } from "agent402-tollbooth";
import { timingSafeEqual } from "node:crypto";

const app = express();
const gate = createTollbooth({
  payTo: "0xYourWalletHere",          // future-proof; not used yet
  price: "$0.002",
  observe: true,                       // <- no 402s sent yet
});

// The middleware does NOT register any route. Serve your own stats endpoint
// from gate.stats() (sync, in-process) or gate.snapshot() (async, durable
// sink), and gate it yourself.
const ADMIN_TOKEN = process.env.TOLLBOOTH_ADMIN_TOKEN || "";
const presented = (req) => {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return typeof req.headers["x-admin-token"] === "string" ? req.headers["x-admin-token"] : "";
};
const authed = (req) => {
  const got = presented(req);
  if (!ADMIN_TOKEN || got.length !== ADMIN_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(ADMIN_TOKEN));
};
app.get("/__stats", (req, res) =>
  authed(req) ? res.json(gate.stats()) : res.status(401).send("Unauthorized"));

app.use(gate);
app.use(yourExistingRoutes);
app.listen(3000);
```

```bash
TOLLBOOTH_ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") \
  node app.js
```

Then read your counters with the token in a **header** (never a query string, which lands in access logs):

```bash
curl -H "Authorization: Bearer $TOLLBOOTH_ADMIN_TOKEN" http://localhost:3000/__stats
```

If instead you run the package as a **reverse proxy** (`TOLLBOOTH_UPSTREAM=https://your-site.com npx agent402-tollbooth`), it mounts the dashboard for you at `/__tollbooth` with JSON at `/__tollbooth/stats`, gated by `TOLLBOOTH_ADMIN_TOKEN` (or `TOLLBOOTH_STATS_TOKEN` for the JSON only) using the same `Authorization: Bearer` / `X-Admin-Token` headers. Either way you get:

- Total requests by classification (human / would-charge / bot-paid / errors)
- Top user-agents seen
- Top paths hit
- 24h rolling counters

**Wait 24 hours.** Real traffic is louder than any synthetic test. You're looking for:
- Is there *any* AI-bot traffic? (If your dashboard says zero would-charge after a day on real traffic, pay-per-crawl isn't worth deploying yet.)
- Are humans getting misclassified as bots? (Should be near zero; investigate before flipping.)
- Are there UAs you didn't expect - internal tools, vendor probes, monitoring bots - that need to be allow-listed?

## Phase 2: Charge known AI bots (10 minutes)

Once Phase 1 shows realistic-looking numbers, flip one flag. The 28 user-agents in `AI_BOTS` get 402: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, Claude-User, anthropic-ai, PerplexityBot, Perplexity-User, CCBot, Bytespider, Google-Extended, Amazonbot, cohere-ai, Meta-ExternalAgent, Meta-ExternalFetcher, Applebot-Extended, Diffbot, Omgilibot, ImagesiftBot, YouBot, Timpibot, DuckAssistBot, PetalBot, FriendlyCrawler, AI2Bot, plus the generic scraper signatures Scrapy and python-requests. The live list is [`tollbooth/bots.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/bots.js) (`AI_BOTS`); add your own with `botUserAgents: [...]`. Everyone else passes.

```js
app.use(createTollbooth({
  payTo: "0xYourWalletHere",
  price: "$0.002",
  // observe: true,                 // <- delete this line
  mode: "bots",                      // <- enforce against the AI-bot list
}));
```

Note the shape: **`observe` is a boolean, and `mode` is one of `bots` / `all` / `strict`.** They are separate options. There is no `mode: "observe"`. That string is not a valid mode, so it falls through to the `bots` default and you would start charging while believing you were only counting.

Redeploy. Now:

- Humans visit free.
- Search-engine crawlers (Googlebot etc.) pass.
- AI crawlers see a 402. With no `x402` middleware passed (the config above), its body is exactly this shape:
  ```json
  {
    "error": "Payment Required",
    "message": "This resource charges automated / AI clients per request. …",
    "accepts": [{ "scheme": "exact", "network": "base", "maxAmountRequired": "$0.002",
                  "asset": "USDC", "payTo": "0xYourWallet",
                  "resource": "https://yoursite.com/article" }],
    "proofOfWork": { "algorithm": "sha256", "challenge": "…", "difficulty": 18,
                     "expires": 1750000000000, "token": "…",
                     "rule": "Find an integer nonce so sha256(\"<challenge>:\" + nonce) has >= 18 leading zero bits, then resend the request with header  X-Pow-Solution: <token>:<nonce>" }
  }
  ```
  Two things to code against rather than assume: the gate emits **no `x402Version` field**, and `maxAmountRequired` / `asset` are echoed **verbatim from your config** (the `price` string and the `asset` symbol), not converted to base units or a token address. `accepts` is an empty array when no `payTo` is set, leaving proof-of-work as the only rail.
- **The config above advertises a USDC quote and settles nothing:** with `payTo` alone, a request carrying a payment is answered with a fresh 402, so proof-of-work is the only rail that opens the page. To take USDC, pass your `@x402/express` `paymentMiddleware(...)` as `x402:` (see [[Pay-per-crawl]]), or run the reverse proxy with `TOLLBOOTH_PAYTO` + `TOLLBOOTH_FACILITATOR_URL`. With that in place the 402 also carries the middleware's `PAYMENT-REQUIRED` header and MPP challenges, and any standard x402 client ([`agent402-client`](https://www.npmjs.com/package/agent402-client), `@x402/fetch`, …) can pay it.

**Verify it's working:**

```bash
# Human - should be 200
curl -A "Mozilla/5.0" https://yoursite.com/article

# AI bot - should be 402
curl -A "ClaudeBot/1.0" https://yoursite.com/article

# Watch real settlement
curl -H "Authorization: Bearer $TOLLBOOTH_ADMIN_TOKEN" https://yoursite.com/__stats
# powSolved counts proof-of-work unlocks; x402Paid / mppPaid count settled payments once an x402 middleware is wired
```

With an x402 middleware wired, USDC settles to your `payTo` wallet directly on-chain through your facilitator, with no holding period. You can verify any payment on [Basescan](https://basescan.org/address/0xYourWalletHere#tokentxns).

**Leave it here for a week** before considering Phase 3. The bot list catches the vast majority of revenue; charging everything is mostly upside-on-the-margins and downside-on-edge-cases.

## Phase 3: Charge everything non-human (10 minutes)

Once Phase 2 has been stable, you can go stricter. Two modes available:

```js
app.use(createTollbooth({
  payTo: "0xYourWalletHere",
  price: "$0.002",
  mode: "strict",    // <- charge anything that isn't a real-browser request
  // mode: "all",    // <- charge EVERY client, browsers included
}));
```

Read these two carefully, because the names are less intuitive than they look. From the code (`shouldCharge` in `tollbooth/index.js`):

- **`"strict"`** charges anything that is **not** a real-browser-shaped request: `return !looksHuman(req)`, where `looksHuman` requires both a `Mozilla/5.0` user-agent **and** a `text/html` `Accept` header. So it catches undeclared bots, headless scrapers, and empty UAs, while a normal browser visit still passes free. This is the stricter-than-`bots` step most content sites want.
- **`"all"`** charges **every** client, browsers included: `return true`, subject only to a `free()` predicate you supply. It is a paywall, not a bot filter. Useful for high-value APIs and data feeds; almost never the right call for content sites.

An explicit `charge(req)` / `free(req)` predicate wins over whichever mode is set, so client-specific allowlists do not require a mode change.

**Backstop:** in either mode, the proof-of-work rail (on by default; `adaptive: true` raises its difficulty with load) means the page is still reachable for free; the cost is just CPU time. So you're not actually locking anyone out - you're just making cheap bulk scraping economically unattractive.

## Deploying somewhere other than Express

The same gate runs **at the edge** with no Node, no servers:

- **Cloudflare Workers** - see [`tollbooth/deploy/cloudflare/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare). One `wrangler deploy`, KV namespace for durable stats and replay protection.
- **Next.js middleware** - see [`tollbooth/deploy/nextjs/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/nextjs). One file, `middleware.js`.
- **Docker reverse proxy** - see [`tollbooth/deploy/docker/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/docker). Wrap any backend regardless of language.

The Worker and Next.js templates share the edge build's Web-Crypto core; the Docker template runs the Node reverse proxy (`npx agent402-tollbooth`). All three follow the same observe → bots → all/strict flow.

## What can go wrong (and how to roll back)

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard says 0 would-charge after 24h on real traffic | UA matcher misses your traffic | Add custom UAs via `botUserAgents: [...]` |
| Browsers being charged | `mode: "all"` charges every client. `strict` is the one that lets real browsers through | Use `mode: "strict"`, or roll back to `mode: "bots"` |
| You set `mode: "observe"` and it charged anyway | Not a valid mode, so it fell through to the `bots` default | Use the separate `observe: true` boolean |
| 402 with no PoW or USDC option | Missing `payTo` and `pow: false` | Set one or both - at least one rail must be on |
| Dashboard/stats returns 401 | Token missing or wrong, or sent as `?token=` | Send `Authorization: Bearer <token>` or `X-Admin-Token: <token>`; the query-string form is not accepted |
| Worker complains about KV | KV binding not wired | See [Cloudflare README](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare) |

**Hard rollback to free in 5 seconds:** set `observe: true` (or `TOLLBOOTH_OBSERVE=true`), or remove the `app.use(...)` line entirely, and redeploy. No data is lost, and the counters keep going.

## See also

- [[Pay-per-crawl]] - full reference (modes, dashboards, deploy templates)
- [[AWS Bedrock AgentCore]] - the buy side: agents paying tollbooths over x402
- [`tollbooth/demo.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/demo.js) - `node demo.js` narrated end-to-end demo
- [`examples/agentcore-tollbooth/`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-tollbooth) - Strands agent paying a tollbooth
