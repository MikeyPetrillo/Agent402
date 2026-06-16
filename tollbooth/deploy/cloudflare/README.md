# Deploy agent402-tollbooth to Cloudflare Workers

Open, crypto-native pay-per-crawl — on the incumbent's own platform. Humans
browse free; AI crawlers pay per request (USDC via x402, or free proof-of-work).
The Worker sits in front of your origin and proxies allowed traffic to it.

## Recommended flow: observe first, charge later

Don't flip a meter on cold. The Worker ships an **observe mode** that classifies
every request as human vs. crawler and counts what *would* have been charged —
but never returns 402. Run it for a week, watch the `/__tollbooth` dashboard,
then enable enforcement when the numbers look right.

1. **Week 1 — observe.** Deploy with `TOLLBOOTH_OBSERVE=true`. Real traffic flows
   to your origin untouched; the dashboard fills in with would-be-charged counts.
2. **Review.** Open `https://your-worker.example.com/__tollbooth` (HTML
   dashboard) or `/__tollbooth/stats` (JSON). Bots see an
   `X-Tollbooth-Observed: would-charge` response header so you can verify
   classification from logs without hitting the dashboard.
3. **Week 2 — enforce.** Remove `TOLLBOOTH_OBSERVE` (or set it to `false`) and
   redeploy. Same code, same classification, but crawlers now get 402.

## 3-step deploy

```bash
# 1. In your project, install the package and grab the wrangler.toml template
npm install agent402-tollbooth
curl -O https://raw.githubusercontent.com/MikeyPetrillo/Agent402/main/tollbooth/deploy/cloudflare/wrangler.toml

# 2. Edit wrangler.toml — set TOLLBOOTH_UPSTREAM (your origin) and, optionally,
#    TOLLBOOTH_PAYTO to advertise a USDC quote. Set the signing secret:
npx wrangler secret put TOLLBOOTH_SECRET     # paste any long random string

# 3. Deploy in observe mode first (recommended)
TOLLBOOTH_OBSERVE=true npx wrangler deploy
```

Point your domain (or a route) at the Worker. Open
`https://your-worker.example.com/__tollbooth` to see the live dashboard.

## Recommended for production: bind a KV namespace

A single KV binding powers **two** things at once:

- **Single-use replay store** for proof-of-work tokens — without it a solved
  token could be reused across isolates within its short TTL.
- **Durable stats** — without it the dashboard resets on every cold start, so
  the numbers you collect during observe mode are useless.

```bash
npx wrangler kv namespace create TOLLBOOTH_KV
```

Paste the returned `id` into the `[[kv_namespaces]]` block in `wrangler.toml`
(uncomment it) and redeploy. The Worker auto-detects the binding and uses it
for both purposes.

## Lock down the stats endpoint

`/__tollbooth/stats` is unauthenticated by default. Even though it only exposes
aggregate counts (no per-request data), set a bearer token in any production
deploy:

```bash
npx wrangler secret put TOLLBOOTH_STATS_TOKEN   # any long random string
```

Then call it with `Authorization: Bearer <token>`. The HTML dashboard at
`/__tollbooth` stays public (and pulls the same data) — handy for sharing a
read-only URL without exposing a scriptable endpoint.

## Verify it works

```bash
curl -A "Mozilla/5.0" https://your-worker.example.com/      # human  -> 200 (proxied, free)
curl -A "ClaudeBot/1.0" https://your-worker.example.com/    # crawler -> 402 Payment Required
                                                            #         (or 200 + X-Tollbooth-Observed
                                                            #          in observe mode)
```

The 402 body advertises both rails (USDC x402 quote + a proof-of-work
challenge). See the [tollbooth README](../../README.md) for the full
configuration reference.
