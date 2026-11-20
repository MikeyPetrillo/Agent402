# Operator runbook

Procedures for running the hosted service from this repository. Every value named here (keys,
tokens, addresses, limits) is set on the host or as a GitHub Actions secret or variable and is never
written into the repository. The configuration reference is [configuration.md](configuration.md);
the security mapping is [security-checklist.md](security-checklist.md); deeper subsystem rules
live in `.claude/rules/`.

## Ship a change

1. Work on the development branch and commit with `[test]` in the subject line (never `[deploy]`
   on that branch: `main` is the branch the host deploys from).
2. Push and open a draft pull request. Every push to the development branch runs every test lane
   in `.github/workflows/deploy.yml`; read the push-event run, not the pull-request-event run.
3. Merge only with `scripts/merge-on-green.sh <pr>`: it requires a push-event run with every
   required check green on the tested commit, waits for the security review summary of that
   commit, and merges pinned to that commit.
4. A merge to `main` tests and deploys. A run on `main` is never canceled by a newer push; a
   second merge's run waits for the first.
5. Verify the release: `GET /health` reports the new build in `meta.build`, and
   `GET /api/gateway-status` reads its normal words. The deploy job also validates the Bazaar
   listing against production after the release.
6. A merge is not a package release: compare `npm view <package> version` with the local
   `package.json` and release packages with a `[publish]` commit on `main`.

## Roll back

1. Find the last good build: the host's deployment history, or the `meta.build` that `/health`
   reported before the release.
2. Redeploy that build on the host, or revert the merge commit on a branch and ship the revert
   through the normal flow (a revert is reviewed and tested like any change).
3. Roll back the server before, or together with, the status Worker (`workers/status-probe`), never
   the Worker alone: an older Worker misreads newer refusal words.
4. Read the rule file for any subsystem the rolled-back range touched: `.claude/rules/ops.md` and
   `.claude/rules/payments.md` record, per change, what a rollback past it leaves behind (an
   alarm issue to close by hand, a document an older build ignores, a cap window per build).
5. Re-read `/health` and `/api/gateway-status`, and watch the next heartbeat run.

## Change a setting

- A variable write on the host redeploys `main`'s head. Set a variable that a pending change needs
  with the host's skip-deploys option ahead of the merge, or right after a merge lands; never
  during a CI run.
- After any write, re-read `/health` (`meta.build`) and the status words.
- A new variable the code reads gets its purpose line in `docs/configuration.json` and a
  regenerated `docs/configuration.md` (`node scripts/gen-config-reference.js --write`) in the same
  change.

## Rotate a key

1. Create the new credential at its issuer. Keep the old one valid until step 4.
2. Set the new value on the host (skip-deploys when a merge is pending), and in the matching
   GitHub Actions secret when a workflow reads the same credential.
3. Redeploy (or let the next merge deploy) and confirm the boot log and `/health`: a key the server
   cannot parse is refused at boot with the reason, never the value.
4. Revoke the old credential at its issuer.
5. A signing key with published public keys (signed receipts) rotates by adding a new key id;
   the old public key stays published (`RECEIPT_RETIRED_KEYS`) so earlier receipts still verify.
6. The upstream cost table rotates the same way: edit the private copy, then update both the host
   variable and the Actions secret; the boot log fingerprint shows whether production matches.

## Pages and the issues they open

Production is watched from outside: `heartbeat.yml` on a schedule and the status Worker
(`workers/status-probe`). Each opens one GitHub issue per alarm title and closes it on recovery;
no open alarm issue means healthy. A page means:

| Page | First reads |
| --- | --- |
| Production down | `/health`, the host's deployment logs, the last merge |
| A status word on `/api/gateway-status` (every word has a pager) | The word's rule in `.claude/rules/ops.md`; the operator view of the same surface with the operator token |
| Refunds owed (`refundsOwed=owed`) | The refund section below |
| A wallet or signer below its low-water mark | Fund it from the operator's treasury process; the page closes on the next read above the mark |
| Bazaar listing invalid or a route missing | `node scripts/bazaar-validate.js` (read-only); `bazaar-presence.yml` buys a missing route once within its cap |
| Security advisory in triage too long | The repository's Security tab |
| Model drift | `model-drift.yml` output (redacted); a cost table edit, not a code change |

Never write an alarm off as noise: trace it to its cause before closing anything by hand.

## Refunds

A charged call that failed is recorded as a debt (`src/refund-ledger.js`) and repaid only after
on-chain proof of the payment (`src/payment-verify.js`).

1. Dispatch `refund.yml` as a dry run (the default). Read the plan: each debt, its proof and its
   amount against the per-refund, per-run and per-payer caps in `scripts/refund-run.js`.
2. The live run, which sends money, is started by the owner after reading the dry run.
3. Confirm `refundsOwed` returns to `ok` on `/api/gateway-status`; the page then closes.

## Drain and restarts

- A deploy overlaps the old and new containers, so there is no gap. On SIGTERM the server stops
  taking new work, lets ordinary requests finish, and aborts report composites still running
  (their 503 is never settled, so nobody is charged).
- A scheduled turn that throws is contained and counted by name (`containedTurns`); a name that
  keeps throwing pages.
- The `[drain]` marker (or a `drain` dispatch) moves the CI burner's balance back to the revenue
  wallet through paid tool calls; it never touches a buyer's funds.

## Backups and restore

- `src/backup.js` writes an encrypted offsite backup nightly. The `backup` status word reads
  `unencrypted` without the encryption key and `unconfigured` without the bucket settings in
  production, and both page.
- Restore with the app stopped: download the objects, then
  `node scripts/backup-restore.js --state-dir <day>/state` (the state database: schema first, then
  each table); a build that still keeps files on a volume also restores those with
  `node scripts/backup-restore.js <object-file> --unbundle <dir>`. Start the app and read
  `/health`.

## Emergency levers

- `SIGNING_HALTED`: halts every outbound signing path at call time, no restart needed; a paid
  call that would sign answers 503, and a 503 is never settled on x402, MPP evm, card or credits.
- `LOAD_SHED=off`, `MONITOR_SCHEDULER=off`, `X402_INDEX_CRAWL=off`, `MPP_INDEX_CRAWL=off`: each
  turns off one subsystem; see [configuration.md](configuration.md) for every switch.
- Never block, cap or pause a paying buyer to protect spend: protect spend with the per-chain and
  per-payer guards the code already enforces.
