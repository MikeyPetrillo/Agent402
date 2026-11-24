# Upgrading a self-hosted server

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

1. **Read what changed.** [CHANGELOG.md](https://github.com/MikeyPetrillo/Agent402/blob/main/CHANGELOG.md) lists every version's changes, and each version has a [GitHub release](https://github.com/MikeyPetrillo/Agent402/releases) cut from its changelog section.
2. **Pull and install with the lockfile.**
   ```bash
   git pull
   npm ci
   ```
   Check the `engines` field in `package.json` first: it names the Node version the server needs.
3. **Check your settings.** Settings are read at boot. A new feature stays off until its key or switch is set, and the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md) lists every variable with its default.
4. **Restart and verify.**
   ```bash
   curl -s localhost:3000/health          # { ok, meta: { toolCount, build } }
   TARGET_URL=http://localhost:3000 node scripts/test-all.js
   ```

## State

- With `STATE_DATABASE_URL` (Postgres), two containers can overlap during a deploy, so an upgrade has no gap.
- Without it, state is SQLite and files under `/data`; keep that directory across the upgrade.

## Retired routes

A retired route answers `410` with its replacement, so a caller learns where it moved instead of meeting a `404`.

See also [[Troubleshooting]] and [[Self-Hosting]].
