# Browser + media worker isolation — staged plan (audit R-04 / R-05 / R-06)

This is the actionable, phased plan for the three "isolation" findings the
re-audit left open. They cannot be closed with an in-repo code change alone:
they need Railway platform config and (for the full fix) a second service. This
doc turns the recommendations in [`security-infra-hardening.md`](./security-infra-hardening.md)
into concrete phases, each independently shippable and independently
rollback-able, with acceptance tests.

**Nothing here should be deployed without an owner-approved Railway preview.**
Each phase gates the next; ship them in order.

## The findings, restated

| ID | Finding | Root cause |
|---|---|---|
| R-04 | Chromium runs with `--no-sandbox` in the primary secret-bearing container (`src/tools/render.js:86`) | The container has no user-namespace / seccomp profile for Chromium's own sandbox, so the flag can't be removed without Chromium failing to launch. |
| R-05 | Chromium DNS validation-to-connect race (`render.js` route guard vs Chromium's own resolver) | The app validates the hostname, but Chromium resolves and connects independently — a rebinding host can pass validation then connect to a private IP. |
| R-06 | Native media parsing (`ffmpeg`/`ffprobe`, `src/tools/media-kit.js`) is unisolated and the Bookworm ffmpeg is CVE-affected (CVE-2026-8461, MagicYUV) | Caller-controlled media is parsed in the primary container; the apt ffmpeg is not version-pinned to a fixed build. |

**Shared root cause:** attacker-controlled Chromium and ffmpeg run in the SAME
container that holds payment/DB/operator/provider secrets and the `/data`
volume. A renderer or parser compromise lands next to everything. Non-root
(A402-01, shipped) reduced "escape == root" but not "escape == read the
payment/provider secrets and the DB."

## What is already in place (Phase 0 — shipped)

- Non-root runtime (UID 1000) via the gosu entrypoint (A402-01).
- Bounded browser pool: 3 active / 24 queued, queue deadline, disconnect-abort,
  and — as of R-09 — execution-deadline context cancellation (`render.js`).
- Per-request byte budget + per-resource cap on renders.
- App-layer SSRF guard on every browser subrequest (`context.route` +
  `hostIsPublic`) and on `safeFetch` (Undici connect-time validation).
- STT/media duration + byte caps before any ffmpeg spend.

These stay as defense-in-depth. The phases below add the isolation the audit
wants around them.

---

## Phase 1 — Harden the current single container (no new service)

Lowest-effort, highest-immediate-return: shrink the blast radius of a
compromise on the container we already run, via Railway/platform config only.
No code change, no second service.

**Steps (Railway service config):**
1. `no-new-privileges` + drop all Linux capabilities the app doesn't need
   (it needs none for serving; gosu drops privileges at boot).
2. Read-only root filesystem, with `/tmp` (tmpfs, size-capped) and the `/data`
   volume as the only writable mounts. Media temp files already live under a
   temp dir — point them at the tmpfs.
3. A restrictive seccomp profile (start from the Docker default, deny the
   exotic syscalls neither Node, Chromium-headless, nor ffmpeg need).
4. Egress network policy at the platform layer: deny the container's outbound
   path to loopback, RFC1918, link-local (169.254.0.0/16), CGNAT
   (100.64.0.0/10), IPv6 ULA/link-local, and the cloud metadata endpoint
   (169.254.169.254). This makes the app-layer SSRF guard defence-in-depth, not
   the only control (R-05 partial, R-02 defence-in-depth).

**Acceptance:**
- Container boots, `/health` 200, a render + a screenshot + an audio-convert all
  still succeed on the preview.
- From inside the container, a curl to `http://169.254.169.254/` and to an
  RFC1918 address is refused at the network layer (not just by the app guard).
- Writing outside `/tmp` and `/data` fails (read-only rootfs proven).

**Rollback:** revert the Railway service settings; no image or code change.

---

## Phase 2 — Browser worker service (secretless, sandbox-on)

Move Chromium off the API container. This is the real R-04 fix.

**Shape:**
- New Railway service `agent402-browser-worker`, non-root, with **no**
  payment/DB/operator/provider/analytics env and **no** `/data` mount.
- User namespace + seccomp enabled so Chromium's own sandbox initialises — then
  remove `--no-sandbox` from `render.js:86` (R-04). If userns is unavailable on
  the platform, keep `--no-sandbox` but rely on the worker having no secrets +
  Phase-1 seccomp/caps (still a large improvement).
- Egress only through a validating/pinning proxy (Phase 2b), direct egress
  denied by the Phase-1 network policy applied to this service too.
- The bounded queue + deadlines from R-08/R-09 move WITH `render.js` into the
  worker.

**API ↔ worker contract:** a small, schema-validated private HTTP call. The API
process does NO direct browser work; it POSTs `{url, mode: "markdown"|"png",
fullPage?}` to the worker over Railway's private network and gets back only the
rendered artifact (markdown / PNG), never a raw internal response. The API keeps
enforcing payment, idempotency, and the byte/time caps; the worker enforces the
SSRF/DNS policy.

**Phase 2b — DNS pinning (R-05):** the worker's egress proxy resolves the
hostname ONCE, validates the resolved IP against the block ranges, and pins the
connection to that IP (or refuses). Redirects are re-validated. This closes the
validate-then-Chromium-re-resolves race that the app-layer guard cannot.

**Acceptance:**
- The worker's `env` dump on the preview contains **no** application secret
  (grep for wallet/CDP/OpenRouter/operator keys → none).
- From the worker, metadata/loopback/RFC1918 are unreachable at the network
  layer; a controlled DNS-rebinding host (public A record at validate time,
  private at connect time) **cannot** connect to the private target.
- Chromium starts with its sandbox active (`--no-sandbox` removed) — verified
  via launch diagnostics; render + screenshot still return correct output.
- End-to-end: a paid `/api/render` and `/api/screenshot` through the API still
  work, latency within tolerance.

**Rollback:** flip the API back to in-process `renderArticle` (keep the old code
path behind a flag for one release); stop the worker service. No data migration.

---

## Phase 3 — Media worker service (secretless, no post-input egress)

Same pattern for ffmpeg/ffprobe (`media-kit.js`, `stt-kit.js`).

**Shape:**
- New Railway service `agent402-media-worker`, non-root, no secrets, no `/data`,
  read-only rootfs + capped tmpfs for the transcode scratch files.
- Network egress DENIED after the input is fetched (the worker receives the
  already-downloaded bytes from the API, or fetches once through the validating
  proxy, then has no outbound path) — a parser exploit can't exfiltrate.
- The duration/byte caps (`assertWithinDurationCap`, `probeDurationSeconds`)
  move with the kit.

**R-06 immediate (do this regardless of Phase 3 timing):**
1. Read the live `/app/.ffmpeg-version` privately (Railway shell) — the build
   already records the version + MagicYUV presence (`Dockerfile`,
   `scripts/check-ffmpeg-cve.sh`).
2. If the MagicYUV decoder is present AND the version predates the fixed
   Debian build: either pin/upgrade ffmpeg to a fixed build, or rebuild ffmpeg
   with `--disable-decoder=magicyuv`. Our tools only touch audio (`-vn`), so
   disabling the video decoder is behaviour-safe.
3. Add a **build-time gate**: fail the image build if the installed ffmpeg is
   CVE-affected or the disallowed decoder is compiled in (extend
   `check-ffmpeg-cve.sh` into a build step so a regressed base can't ship
   silently).

**Acceptance:**
- Worker `env` dump: no application secret.
- Worker cannot reach metadata/loopback/private ranges or `/data`/DB.
- A malicious/timeout media job terminates with no lingering process; the caps
  hold; `/api/audio-*` still works end-to-end through the API.
- `check-ffmpeg-cve.sh` in the deployed image reports the decoder ABSENT or the
  version fixed; the build gate is green for the right reason.

**Rollback:** flip media parsing back in-process behind the same style of flag;
stop the worker.

---

## Sequencing, effort, and cost

| Phase | Effort | New infra | Risk | Closes |
|---|---|---|---|---|
| 1 — container hardening | S (config only) | none | Low | R-05 partial, R-02 depth |
| 2 — browser worker + DNS pin | L | 1 service + proxy | Med | R-04, R-05 |
| 3 — media worker + ffmpeg gate | M | 1 service | Med | R-06 |

Recommended order: **Phase 1 now** (cheap, immediate blast-radius cut) →
**R-06 immediate** (version check + build gate, independent of Phase 3) →
**Phase 2** → **Phase 3**. Phases 2/3 add two always-on Railway services
(cost) and a private-network hop (latency, mitigated by keeping the worker warm
and co-located). Get owner sign-off on the added services before building them.

## Stop conditions (from the handoff)

Pause and get owner action if: enabling the Chromium sandbox fails on the
preview; worker isolation needs a new paid service or network product (Phase
2/3 — expected, needs sign-off); or the live deployment SHA can't be tied to the
reviewed source.
