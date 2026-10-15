# Railway IaC migration: facilitator and worker services

Two services still read a Config as Code file: `agent402-facilitator`
(`railway.facilitator.json`) and `agent402-worker` (`railway.worker.json`).
Railway stops reading those files on 2026-12-01. `.railway/railway.ts` carries
the same settings as Infrastructure as Code. It is prepared and checked in, and
nothing reads it until an owner applies it.

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
or deleted. `scripts/test-railway-iac.js` keeps these settings equal to the
legacy files while both exist.

Today every one of these settings comes from the config file; the service-level
values underneath are unset. That fixes the order below: apply first, so the
service holds its own values, and only then stop it reading the file. Clearing
the file path first would leave the worker without a Dockerfile path.

## Owner steps

Run from a clone linked to the production environment (`railway link`), with
the Railway CLI at 5.68.0 or newer.

1. Install the SDK the CLI evaluates the file with:
   `npm ci --ignore-scripts --prefix .railway`
2. Plan: `railway config plan --verbose`. Expect `0 to add, 4 to change,
   0 to destroy`: builder, Dockerfile path, watch patterns, healthcheck and
   restart policy on the two services, each moving from unset to the value in
   the table.
3. Check the plan has no deletes: no `- Delete` line, `0 to destroy`, no
   `source` change and no variable line. If it shows anything else, stop.
4. Apply outside a CI run (no deploy.yml run in progress, not during a merge):
   `railway config apply`, and confirm the same change set the plan showed.
   The first apply also records the `agent402` partial as the owner of the two
   services (`railway config partials list` shows it).
5. Clear each service's config file path: in each service's Settings, empty
   the Config as Code path field (`/railway.facilitator.json`,
   `/railway.worker.json`). `railway config migrate status` should then list
   no service reading Config as Code.
6. Verify: re-run `railway config plan`; it should report the configuration
   up to date. Read `GET /health` on each service and on
   https://agent402.tools/health, and check `meta.build` is the build that was
   live before (a settings change can redeploy the service's current source).
7. In a later change, delete `railway.facilitator.json` and
   `railway.worker.json` from the repository. Not before step 5: until then
   the platform still reads them.

To undo before step 5, nothing is needed: the config file still overrides the
service values. After step 5, restoring a service's config file path returns it
to the file.
