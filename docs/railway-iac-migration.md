# Railway IaC migration: facilitator and worker services

`agent402-facilitator` and `agent402-worker` hold their build and deploy
settings on the service itself. Railway stops reading Config as Code files on
2026-12-01, and the repository no longer carries one; the table below is the
record of what each service is set to. `.railway/railway.ts` declares the same
settings as Infrastructure as Code. Nothing in CI reads or applies it: an
owner plans and applies it by hand with the steps below.

## What the file sets

| Setting | agent402-facilitator | agent402-worker |
|---|---|---|
| Builder | `DOCKERFILE` | `DOCKERFILE` |
| Dockerfile | `Dockerfile.facilitator` | `Dockerfile.worker` |
| Watch patterns | `facilitator/**`, `Dockerfile.facilitator` | none |
| Healthcheck | `/health`, 60 s | `/health`, 90 s |
| Restart policy | `ON_FAILURE`, 5 retries | `ON_FAILURE`, 5 retries |
| Replicas | 1 | 1 |
| Source | this repository, `main` | none (deployed by upload) |
| Sleep when idle | unchanged (off) | on |

The file exports a named partial (`agent402`), so an apply manages only these
two services: every other service, database and volume is left alone even
though the file does not mention it. Variables are unmanaged
(`variables: { managed: false }`), so no service variable is declared, changed
or deleted. `scripts/test-railway-iac.js` keeps this table in step with the
IaC file and keeps the retired config files out of the repository.

## Owner steps before 2026-12-01

Run from a clone of `main` linked to the production environment
(`railway link`), with the Railway CLI 5.71.0 or newer (`railway --version`;
it has `railway config migrate status` and `cutover`). Every
command below up to step 5 only reads; steps 5 and 6 write. Do the writes right
after a merge has deployed, never while a deploy.yml run is in progress.

1. Confirm no service reads a Config as Code file. This is the check that
   matters for the cutoff:

   ```sh
   railway config migrate status
   ```

   Expect `No services in production read Config as Code.` If a service is
   listed, keep going: steps 4 to 6 move it off its file.

2. Install the SDK and type checker the file is evaluated with, and type-check
   it:

   ```sh
   npm ci --ignore-scripts --prefix .railway
   npm run --prefix .railway typecheck
   ```

3. Confirm the `agent402` partial owns exactly the two services:

   ```sh
   railway config partials list
   ```

   Expect `agent402` with `service.agent402-facilitator` and
   `service.agent402-worker`, and nothing else under it.

4. Plan:

   ```sh
   railway config plan --verbose
   ```

   Read the summary line. It must say `0 to add` and `0 to destroy`, with no
   `- Delete` line, no `source` change and no variable line (the header reads
   `variables: unmanaged`). Every change listed must move a setting from unset
   (`null`) or a different value to the value in the table above; the
   restart policy type (`deploy.restartPolicyType (null -> "ON_FAILURE")`) is
   the one such change expected on a service whose policy was never written
   by an apply. Anything else: stop.

5. Only if step 4 listed changes, apply them, outside a CI run:

   ```sh
   railway config apply
   ```

   Confirm the change set it prints is the one the plan showed.

6. Only if step 1 listed a service, switch it off its file. This saves the
   current Config as Code paths so the switch can be reversed:

   ```sh
   railway config migrate cutover
   ```

   To reverse it: `railway config migrate undo`. Without the CLI, empty the
   Config as Code path field in the service's Settings instead.

## Verify afterwards

```sh
railway config migrate status
railway config plan --detailed-exit-code
curl -s https://agent402.tools/health
```

- `migrate status` lists no service reading Config as Code.
- `plan --detailed-exit-code` exits 0 (no change pending; 2 means a change is
  still pending).
- `/health` on the main site and on each service answers, and `meta.build`
  is the build that was live before (a settings change can redeploy a
  service's current source).

A service that still reads a Config as Code path has its own values underneath
unset. That fixes the order above: apply first, so the service holds its own
values, and only then switch it off its file. Switching first would leave the
worker without a Dockerfile path. Before the cutover, nothing needs undoing:
the file the path names still overrides the service values. After it, the
service's own settings are the only source, and this table and the IaC file
record them.
