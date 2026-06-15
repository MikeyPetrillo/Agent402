# Deploy agent402-tollbooth to Cloudflare Workers

Open, crypto-native pay-per-crawl — on the incumbent's own platform. Humans
browse free; AI crawlers pay per request (USDC via x402, or free proof-of-work).
The Worker sits in front of your origin and proxies allowed traffic to it.

## 3-step deploy

```bash
# 1. In your project, install the package and grab this wrangler.toml template
npm install agent402-tollbooth
curl -O https://raw.githubusercontent.com/MikeyPetrillo/Agent402/main/tollbooth/deploy/cloudflare/wrangler.toml

# 2. Edit wrangler.toml — set TOLLBOOTH_UPSTREAM (your origin) and, optionally,
#    TOLLBOOTH_PAYTO to advertise a USDC quote. Then set the signing secret:
npx wrangler secret put TOLLBOOTH_SECRET     # paste any long random string

# 3. Deploy
npx wrangler deploy
```

Point your domain (or a route) at the Worker and you're charging crawlers.

## Recommended for production: durable replay store

The in-memory replay guard is per-isolate, so a solved proof-of-work token could
be reused across isolates within its short TTL. Bind a KV namespace to close that:

```bash
npx wrangler kv namespace create TOLLBOOTH_KV
```

Paste the returned `id` into the `[[kv_namespaces]]` block in `wrangler.toml`
(uncomment it) and redeploy. The Worker auto-detects the binding and uses it.

## Verify it works

```bash
curl -A "Mozilla/5.0" https://your-worker.example.com/      # human  -> 200 (proxied, free)
curl -A "ClaudeBot/1.0" https://your-worker.example.com/    # crawler -> 402 Payment Required
```

The 402 body advertises both rails (USDC x402 quote + a proof-of-work challenge).
See the [tollbooth README](../../README.md) for the full configuration reference.
