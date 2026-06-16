# Pay-per-crawl walkthrough — observe → bots → enforce in 30 minutes

A copy/paste recipe for taking a real site from **"I have no idea who's crawling me"** to **"AI agents pay me per request"** in three deploys. Total elapsed time: ~30 minutes; total written code: ~5 lines.

This is the safe rollout. Each phase is reversible by changing one flag and redeploying.

- **Phase 1 (10 min): Observe.** Deploy in observe mode — no enforcement, no risk. Watch the [dashboard](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth#dashboard) for 24h to see what's actually crawling you.
- **Phase 2 (10 min): Charge known bots.** Flip to `mode: "bots"`. Real AI crawlers get 402. Humans and search engines pass.
- **Phase 3 (10 min): Charge everyone non-human.** Flip to `mode: "all"` (or `"strict"`) once your dashboard says it's safe.

## Prereqs

- A Node 18+ runtime in front of your site (Express, or a Cloudflare Worker, or a Next.js middleware — all supported).
- An EVM wallet address to receive USDC on Base. (Or skip it entirely and accept proof-of-work only — no wallet needed.)
- ~30 minutes.

## Phase 1: Observe (10 minutes)

Install the gate and put it in front of your routes — **observe mode means nothing gets blocked**. Every request is classified (`human` / `bot` / `paid` / `would-charge`) and counted, so you can see who's crawling you before you ever touch enforcement.

```bash
npm install agent402-tollbooth
```

```js
// app.js
import express from "express";
import { createTollbooth } from "agent402-tollbooth";

const app = express();
app.use(createTollbooth({
  payTo: "0xYourWalletHere",          // future-proof; not used yet
  price: "$0.002",
  observe: true,                       // <- no 402s sent yet
  statsToken: process.env.TOLLBOOTH_STATS_TOKEN,
}));
app.use(yourExistingRoutes);
app.listen(3000);
```

```bash
TOLLBOOTH_STATS_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") \
  node app.js
```

Then open `http://localhost:3000/__tollbooth?token=<the token you set>` in a browser. You'll see a live dashboard with:

- Total requests by classification (human / would-charge / bot-paid / errors)
- Top user-agents seen
- Top paths hit
- 24h rolling counters

**Wait 24 hours.** Real traffic is louder than any synthetic test. You're looking for:
- Is there *any* AI-bot traffic? (If your dashboard says zero would-charge after a day on real traffic, pay-per-crawl isn't worth deploying yet.)
- Are humans getting misclassified as bots? (Should be near zero; investigate before flipping.)
- Are there UAs you didn't expect — internal tools, vendor probes, monitoring bots — that need to be allow-listed?

## Phase 2: Charge known AI bots (10 minutes)

Once Phase 1 shows realistic-looking numbers, flip one flag. Known AI crawlers (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider, Google-Extended, OAI-SearchBot, Meta-ExternalAgent, Amazonbot, AndroidAIBot, plus everything in [`tollbooth/bots.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/bots.js)) get 402. Everyone else passes.

```js
app.use(createTollbooth({
  payTo: "0xYourWalletHere",
  price: "$0.002",
  // observe: true,                 // <- delete this line
  mode: "bots",                      // <- enforce against the AI-bot list
  statsToken: process.env.TOLLBOOTH_STATS_TOKEN,
}));
```

Redeploy. Now:

- Humans visit free.
- Search-engine crawlers (Googlebot etc.) pass.
- AI crawlers see a 402 with:
  ```json
  {
    "x402Version": 1,
    "accepts": [{ "scheme": "exact", "network": "base", "payTo": "0xYourWallet",
                  "asset": "0x...USDC", "maxAmountRequired": "2000" }],
    "proofOfWork": { "challenge": "…", "difficulty": 18, "token": "…",
                     "rule": "Find a nonce so sha256(challenge+':'+nonce) has >= 18 leading zero bits;
                              resend with header X-Pow-Solution: <token>:<nonce>" }
  }
  ```
- An agent that wants the page either signs an x402 USDC transaction (any standard x402 client does this — [`agent402-client`](https://www.npmjs.com/package/agent402-client), `@x402/fetch`, AWS Bedrock AgentCore Payments, …), or solves the proof-of-work for free.

**Verify it's working:**

```bash
# Human — should be 200
curl -A "Mozilla/5.0" https://yoursite.com/article

# AI bot — should be 402
curl -A "ClaudeBot/1.0" https://yoursite.com/article

# Watch real settlement
open https://yoursite.com/__tollbooth?token=<your token>
# the "paid" counter should start incrementing within hours
```

USDC settles to your `payTo` wallet directly on Base via the standard x402 facilitator — no Stripe, no Merchant-of-Record, no holding period. You can verify any payment on [Basescan](https://basescan.org/address/0xYourWalletHere#tokentxns).

**Leave it here for a week** before considering Phase 3. The bot list catches the vast majority of revenue; charging everything is mostly upside-on-the-margins and downside-on-edge-cases.

## Phase 3: Charge everything non-human (10 minutes)

Once Phase 2 has been stable, you can go stricter. Two modes available:

```js
app.use(createTollbooth({
  payTo: "0xYourWalletHere",
  price: "$0.002",
  mode: "all",       // <- charge everything except humans (whitelisted UA shapes)
  // mode: "strict", // <- charge everything, including humans (paywall mode)
  statsToken: process.env.TOLLBOOTH_STATS_TOKEN,
}));
```

- `"all"` charges any non-human-looking UA. Catches bots that don't identify themselves, plus headless scrapers using "ChromeHeadless" or empty UAs.
- `"strict"` doesn't try to detect humans at all — everyone pays. Useful for high-value APIs / data feeds; almost never the right call for content sites.

**Backstop:** in either mode, adaptive proof-of-work means the page is still reachable for free; the cost is just CPU time. So you're not actually locking anyone out — you're just making cheap bulk scraping economically unattractive.

## Deploying somewhere other than Express

The same gate runs **at the edge** with no Node, no servers:

- **Cloudflare Workers** — see [`tollbooth/deploy/cloudflare/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare). One `wrangler deploy`, KV namespace for durable stats and replay protection.
- **Next.js middleware** — see [`tollbooth/deploy/nextjs/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/nextjs). One file in `middleware.ts`.
- **Docker reverse proxy** — see [`tollbooth/deploy/docker/`](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/docker). Wrap any backend regardless of language.

All three share the same Web-Crypto core and the same observe → bots → all/strict flow.

## What can go wrong (and how to roll back)

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard says 0 would-charge after 24h on real traffic | UA matcher misses your traffic | Add custom UAs via `botUserAgents: [...]` |
| Dashboard says humans being charged | Mode set to `strict` or `all` too early | Roll back to `mode: "bots"` |
| 402 with no PoW or USDC option | Missing `payTo` and `pow: false` | Set one or both — at least one rail must be on |
| Dashboard unreachable | Token missing or wrong | Re-set `TOLLBOOTH_STATS_TOKEN` and re-deploy |
| Worker complains about KV | KV binding not wired | See [Cloudflare README](https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare) |

**Hard rollback to free in 5 seconds:** flip `mode` back to `"observe"` (or remove the `app.use(...)` line entirely) and redeploy. No data is lost — the dashboard counters keep going.

## See also

- [[Pay-per-crawl]] — full reference (modes, dashboards, deploy templates)
- [[AWS Bedrock AgentCore]] — the buy side: agents paying tollbooths over x402
- [`tollbooth/demo.js`](https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/demo.js) — `node demo.js` narrated end-to-end demo
- [`examples/agentcore-tollbooth/`](https://github.com/MikeyPetrillo/Agent402/tree/main/examples/agentcore-tollbooth) — Strands agent paying a tollbooth
