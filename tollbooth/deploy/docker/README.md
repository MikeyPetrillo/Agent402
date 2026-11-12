# Run agent402-tollbooth with Docker

A one-command reverse proxy that charges AI crawlers and lets humans through
free: in front of any site, no code changes to your origin.

## 3-step deploy

```bash
# 1. Grab these three files (Dockerfile, tollbooth-entrypoint.sh and
#    docker-compose.yml) from the repo: tollbooth/deploy/docker/
# 2. Edit docker-compose.yml, set TOLLBOOTH_UPSTREAM (your origin) and a long
#    random TOLLBOOTH_SECRET (and optionally TOLLBOOTH_PAYTO + TOLLBOOTH_FACILITATOR_URL
#    to charge USDC over x402 and MPP; PAYTO alone only advertises a quote).
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

- **Live stats dashboard:** open `http://localhost:4021/__tollbooth`: requests, how
  many were charged, proof-of-work solves, USDC collected, and what share of your
  traffic is bots. Raw JSON at `/__tollbooth/stats`.
- **Runs as the unprivileged `node` user.** To share one proof-of-work replay
  record across processes, set `TOLLBOOTH_REPLAY_SQLITE=/var/lib/tollbooth/replay.db`
  (that directory belongs to `node`; mount a volume there to keep it across restarts).
  The entrypoint starts as root only to hand that record to `node`, then runs the
  proxy as `node`.

## Upgrading from an image that ran as root

Earlier images ran the proxy as root, so a replay record they wrote on a volume
is owned by root. Rebuild with all three files above: on its first boot the
entrypoint hands the record, its `-wal` and `-shm` files and its directory to
`node` (the log says so with `[entrypoint] handing ...` lines), and claims write
as before. The record and its directory are handed over only when the
directory is `/var/lib/tollbooth` or sits on a mounted volume (judged on its
resolved path, and never through a directory that is itself a link); anywhere
else (for example `/app`) the log warns and the proxy cannot write the record,
so keep it in `/var/lib/tollbooth` or on a volume. Starting the container with `--user` skips the hand-over: give that
user the record's files yourself (`chown -R 1000:1000` on the volume for `node`).
- **Production notes** (stable secret, durable replay store, charge modes, adaptive
  proof-of-work): see the [tollbooth README](../../README.md).
