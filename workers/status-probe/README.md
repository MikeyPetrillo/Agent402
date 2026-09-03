# status-probe

Cloudflare Worker that observes `agent402.tools` from outside production every
5 minutes and records the result on `POST /api/status/probe`, which is what
`/status` renders.

## Why

`/status` is only as trustworthy as its observer, and the observer used to be a
single GitHub Actions schedule. GitHub delivers a `*/15` cron **roughly once an
hour** (measured 2026-07-27: 60-72 minute gaps, plus one 3.3 hour stall). The
staleness threshold for these components is 45 minutes, so a completely healthy
production kept reporting "degraded" simply because nobody was looking.

The heartbeat now re-probes several times within each run, which handles routine
throttling. This Worker handles the case that cannot fix: GitHub not running at
all. Cloudflare cron is a separate scheduler on separate infrastructure, so a
GitHub incident and a Cloudflare incident are not the same event.

## What it checks

`api` (health), `catalog` (route count above the floor), `mcp` (connector
handshake), `paywall` (an unpaid call still 402s), `rails` (Base still in the
402 offer).

It deliberately does **not** run the paid-call probe. That needs a 16-bit
proof-of-work solve plus an `X-Heartbeat-Token` minted from `POW_SECRET`.
Copying that secret to a second platform widens its blast radius, and without it
every probe would count as real external free-tier demand: 288 synthetic calls a
day against roughly 130 genuine ones, which would corrupt the free-tier series
on `/revenue`. `paid-call` therefore stays the GitHub heartbeat's job, and
`src/status.js` sizes that component's staleness against *its* observer.

## Deploy

```sh
cd workers/status-probe
wrangler secret put OPERATOR_TOKEN   # same value as AGENT402_OPERATOR_TOKEN on Railway
wrangler deploy
```

Verify it end to end (should return `"recorded": true`):

```sh
curl -s -X POST https://agent402-status-probe.<your-subdomain>.workers.dev/run \
  -H "X-Operator-Token: $AGENT402_OPERATOR_TOKEN" | jq
```

Then confirm the observation landed with a `cloudflare-cron` source:

```sh
curl -s https://agent402.tools/api/status | jq '.overall, .measurement'
```

## Rotating the token

`OPERATOR_TOKEN` here and `AGENT402_OPERATOR_TOKEN` on Railway are the same
secret. Rotate Railway first, then `wrangler secret put OPERATOR_TOKEN`. Between
those two steps this Worker's observations are rejected and `/status` shows a
gap rather than wrong data, which is the intended failure direction.

## What this Worker deliberately cannot do

It cannot start the GitHub heartbeat, and that is on purpose. A `workflow_dispatch`
needs `Actions: Read and write`, which is repo-wide over Actions with no
per-workflow scoping - so "let the Worker kick the heartbeat" is really "let a
second platform deploy production, post as the company, and run the workflows
that move money" (`deploy.yml`, `announce.yml`, `refund.yml`, `paid-canary.yml`,
`tempo-volume.yml`, `algorand-external-buy.yml`). That was built on 2026-08-30
and reverted the same hour for this reason.

The Worker holds exactly two secrets: `STATUS_PROBE_TOKEN` (write to
`POST /api/status/probe`, one route, nothing else) and `GITHUB_ISSUES_TOKEN`
(`Issues: write` on this repository only, so it can open and close its own alarm
issues). If you find a `GITHUB_DISPATCH_TOKEN` on the Cloudflare account or a
matching PAT on GitHub, nothing reads it - revoke it.

Verify the Worker with the probe token, not the operator token:

```sh
curl -s -X POST https://<worker>/run -H "X-Operator-Token: $STATUS_PROBE_TOKEN" | jq .alarms
```

