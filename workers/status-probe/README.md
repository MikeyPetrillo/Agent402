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
402 offer), and `paid-call` (the proof-of-work path end to end: challenge,
solve, call `/api/hash`, check the answer is the hash of what it sent).

The paid-call check walks a low-difficulty **probe** challenge, not the one a
buyer is issued: its difficulty, TTL and token shape all differ. The GitHub
heartbeat walks the buyer's. Because the two paths differ, `/status` judges
paid-call per observer rather than by the newest row: a failure either one
records stands until that same observer sees the path work again, or its own
reading goes stale (45 minutes for this Worker, 3 hours for the heartbeat). So
this Worker's success every 5 minutes cannot clear a failure only the buyer's
path has (`stateFromSources` in `src/status-store.js`).

The paid-call check does **not** use `POW_SECRET`. The heartbeat marks its call
as internal with an `X-Heartbeat-Token` minted from that secret, and copying it
to a second platform widens what a leak here could forge. Instead the Worker
presents `STATUS_PROBE_TOKEN` (the credential it already holds) as
`X-Operator-Token` when it asks for the challenge. For the `hash` slug only, the
server then issues a 4-bit challenge (16 hashes expected) whose signed token is
marked as the probe's, and books the call it unlocks as internal exactly like
the heartbeat's, so these calls never count as outside free-tier demand. The
token opens nothing else: no other slug, no paid route, no operator surface
(`scripts/test-status-probe-pow.js`).

The Worker is sized to the tightest Workers limits (10 ms of CPU, 50
subrequests per invocation):

- It refuses to solve any challenge above 4 bits. A normal free-tier challenge is
  16 bits and would blow the CPU limit, killing the whole run. That is what a
  server without `STATUS_PROBE_TOKEN`, or one that predates the probe challenge,
  hands back, so the check is then reported as **not observed** (logged, nothing
  recorded) rather than as an outage.
- A solve stops after 256 hashes (16x the expected count); that rare case is
  also "not observed".
- Measured 2026-09-28: `crypto.subtle.digest` costs about 2.5-4.5 us of CPU per
  hash in workerd and about 10 us in Node, so the expected solve is about
  0.05 ms and the hard cap about 1.1 ms (2.6 ms at Node's cost).
- The paid-call adds two subrequests per attempt; the worst possible run
  (retry, alarms opening and closing) is 39, pinned in
  `scripts/test-status-probe-worker.js`.

## Deploy

A push to `main` that touches `workers/status-probe/**` deploys it
(`.github/workflows/deploy-status-probe.yml`), then verifies the running Worker
against production. By hand:

```sh
cd workers/status-probe
wrangler secret put STATUS_PROBE_TOKEN   # same value as STATUS_PROBE_TOKEN on Railway
wrangler deploy
```

Verify it end to end (should return `"recorded": true`, and
`"paidCall": {"observed": true}` once the server carries the probe challenge and
the same `STATUS_PROBE_TOKEN`):

```sh
curl -s -X POST https://agent402-status-probe.<your-subdomain>.workers.dev/run \
  -H "X-Operator-Token: $STATUS_PROBE_TOKEN" | jq '.recorded, .paidCall'
```

Then confirm the observation landed:

```sh
curl -s https://agent402.tools/api/status | jq '.components[] | select(.key=="paid-call") | .current'
```

## Secrets

The Worker holds two secrets: `STATUS_PROBE_TOKEN`, which writes to
`POST /api/status/probe`, and an optional `GITHUB_ISSUES_TOKEN`
(`Issues: write` on this repository only) for opening and closing its own
status issues. It cannot start workflows.

Verify the Worker with the probe token, not the operator token:

```sh
curl -s -X POST https://<worker>/run -H "X-Operator-Token: $STATUS_PROBE_TOKEN" | jq .alarms
```

