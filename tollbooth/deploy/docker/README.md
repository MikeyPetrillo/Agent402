# Run agent402-tollbooth with Docker

A one-command reverse proxy that charges AI crawlers and lets humans through
free — in front of any site, no code changes to your origin.

## 3-step deploy

```bash
# 1. Grab these two files (Dockerfile + docker-compose.yml) from the repo:
#    tollbooth/deploy/docker/
# 2. Edit docker-compose.yml — set TOLLBOOTH_UPSTREAM (your origin) and a long
#    random TOLLBOOTH_SECRET (and optionally TOLLBOOTH_PAYTO for a USDC quote).
# 3. Run it:
docker compose up -d
```

The tollbooth listens on `:4021` and proxies allowed traffic to your origin.
Point your domain/CDN at it (or run it as a sidecar) and you're charging bots.

## See it working

```bash
curl -A "Mozilla/5.0" localhost:4021/        # human   -> 200 (proxied, free)
curl -A "ClaudeBot/1.0" localhost:4021/      # crawler -> 402 Payment Required
```

- **Live stats dashboard:** open `http://localhost:4021/__tollbooth` — requests, how
  many were charged, proof-of-work solves, USDC collected, and what share of your
  traffic is bots. Raw JSON at `/__tollbooth/stats`.
- **Production notes** (stable secret, durable replay store, charge modes, adaptive
  proof-of-work): see the [tollbooth README](../../README.md).
