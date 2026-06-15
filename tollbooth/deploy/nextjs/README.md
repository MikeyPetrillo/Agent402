# Deploy agent402-tollbooth on Next.js (Vercel)

Open, crypto-native pay-per-crawl in your existing Next.js app — no CDN lock-in,
no Stripe, no signup. Humans browse free; AI crawlers pay per request (USDC via
x402, or free proof-of-work). Runs in Vercel's Edge runtime.

## 3-step deploy

```bash
# 1. Install the package
npm install agent402-tollbooth

# 2. Add middleware.js to your project root (next to app/ or pages/)
curl -o middleware.js https://raw.githubusercontent.com/MikeyPetrillo/Agent402/main/tollbooth/deploy/nextjs/middleware.js

# 3. Set the signing secret, then deploy
#    Vercel → Settings → Environment Variables → add TOLLBOOTH_SECRET (any long random string)
#    optionally add TOLLBOOTH_PAYTO to advertise a USDC quote
vercel deploy   # or push to your connected Git branch
```

That's it — the middleware gates every matched route. Tune `config.matcher` in
`middleware.js` to charge only the paths you want (e.g. `/articles/:path*`).

## Notes for production

- **`TOLLBOOTH_SECRET` is required.** PoW tokens are HMAC-signed and must verify
  across stateless edge invocations; without a stable secret they're rejected.
- **Replay protection is best-effort** at the edge (invocations don't share
  memory). For strict single-use, pass a `store` backed by a durable KV (Vercel
  KV / Upstash) — see the [tollbooth README](../../README.md).
- **UA matching is the default, not a security boundary.** A bot forging a human
  UA only gains the same free access a human has. To charge everyone, pass
  `charge: () => true` to `createEdgeTollbooth`.

## Verify it works

```bash
curl -A "Mozilla/5.0" https://your-app.vercel.app/      # human  -> 200, free
curl -A "ClaudeBot/1.0" https://your-app.vercel.app/    # crawler -> 402 Payment Required
```
