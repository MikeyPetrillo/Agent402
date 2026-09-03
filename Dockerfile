# SECURITY REVIEW / VERIFY-BEFORE-DEPLOY — infra hardening PR (audit A402-01/06
# + mutable-artifacts). Still needs a Railway PREVIEW build before the deploy
# path (the image isn't built in CI), but the /data volume behaviour this design
# hinges on was VERIFIED against the live Railway deployment on 2026-07-18:
# agent402-volume mounts at /data owned by root:root, so the non-root switch is
# done via a root entrypoint that chowns /data then drops to node (below), NOT a
# Dockerfile USER. See the Security-Model wiki page for the full checklist.
#
# Base image pinned by DIGEST for reproducible builds and CVE traceability
# (audit: "mutable deployment artifacts"). node:22-slim as of 2026-07-18. Re-pin
# after a deliberate base bump with:
#   docker pull node:22-slim
#   docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# ffmpeg powers the audio tools (normalize/convert/info); gosu drops privileges
# at startup (see the entrypoint). Installed alongside Chromium's deps.
RUN npm ci --omit=dev && npx playwright install --with-deps chromium \
  && apt-get update && apt-get install -y --no-install-recommends ffmpeg gosu \
  && rm -rf /var/lib/apt/lists/* \
  # sanity-check gosu works (it silently no-ops on a broken install)
  && gosu node true \
  # A402-06 / CVE-2026-8461 (FFmpeg MagicYUV) build gate: the audio toolchain
  # MUST be present — a base-image drift that drops ffmpeg/ffprobe should FAIL
  # the build loudly, not ship an image that 500s every media tool. Then record
  # the exact build + whether the vulnerable MagicYUV *video* decoder is present.
  # We do NOT fail on its presence: our tools only decode AUDIO (`-vn` on every
  # ffmpeg call, enforced by scripts/test-ffmpeg-novideo.js), so the decoder is
  # unreachable through our flags; failing would just break builds over an
  # unexploitable path. scripts/check-ffmpeg-cve.sh reads the recorded status.
  && { command -v ffmpeg >/dev/null || { echo "FATAL: ffmpeg missing from image"; exit 1; }; } \
  && { command -v ffprobe >/dev/null || { echo "FATAL: ffprobe missing from image"; exit 1; }; } \
  && ffmpeg -version | head -1 > /app/.ffmpeg-version \
  && (ffmpeg -hide_banner -decoders 2>/dev/null | grep -i magicyuv >> /app/.ffmpeg-version || echo "magicyuv-decoder: absent" >> /app/.ffmpeg-version)

# Container hardening (audit R-04/R-05 blast-radius reduction — the achievable
# subset). Strip the setuid/setgid bit from every binary in the image so a
# post-compromise attacker inside the container has NO local privilege-escalation
# helper (su, mount, chsh, Chromium's SUID sandbox, …). Safe for our runtime:
# the server already runs non-root; gosu drops privileges via syscalls as root,
# not via a setuid bit; and Chromium runs with --no-sandbox so the SUID sandbox
# helper is unused. `-xdev` keeps the sweep on the image filesystem.
#
# NOTE: seccomp, capability-drop, a read-only root filesystem, and network
# egress firewalling are the REST of the container-hardening story — Railway's
# platform does not expose Docker security-opt / egress controls, so they are
# NOT settable from this repo. Closing them needs the secretless worker services
# in the Security-Model wiki page (worker isolation) or a platform that supports them.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

COPY src ./src
# start.js is the shared-image dispatcher; worker/ is the secretless browser+media
# worker it boots when WORKER_MODE=true. Both services run THIS image (railway.toml
# pins every service to Dockerfile); WORKER_MODE unset → the main API server.
COPY start.js ./
COPY worker ./worker
# Only the two scripts the SERVER actually uses at runtime, never the whole
# directory. `COPY scripts ./scripts` shipped ~90 test files into the production
# image and, worse, put a cache-busting layer in front of everything below it:
# a test-only edit is the most common change in this repo, and each one
# invalidated this layer and every layer after it. Measured 2026-08-25: a deploy
# whose only change was one comment in src/ took 391s from creation to serving.
#
# Both entries are load-bearing and verified, not guessed:
#   demo-payment.js       served at /demo.js (src/server.js readFileSync)
#   revenue-scan-solana.js imported by src/revenue-live.js and revenue-ledger.js
# Adding a runtime dependency on another script means adding it HERE too, and
# scripts/test-image-runtime-scripts.js fails the build if one is missing.
COPY scripts/demo-payment.js scripts/revenue-scan-solana.js ./scripts/
# wiki/ is the source of truth for /docs (server-rendered) and is CI-synced
# to the GitHub wiki. Must be in the image or /docs is empty.
COPY wiki ./wiki
# assets/fonts is embedded into the brand images at boot — a missing file is
# a boot crash, not a degraded render.
COPY assets ./assets

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# A402-01: run the server as the unprivileged `node` user, NOT root. A renderer
# or media-parser compromise then lands as UID 1000 — unable to touch root-owned
# files or escalate — instead of as root in the container.
#
# We do NOT use a Dockerfile `USER node`, on purpose: VERIFIED on the live
# Railway deployment (2026-07-18) that the persistent volume `agent402-volume`
# mounts at /data owned by root:root at RUNTIME, and it holds the memory/stats
# SQLite (~1GB). A `USER node` container could not write it and the memory
# boot-fail-loud would fire on deploy. Instead docker-entrypoint.sh runs as root
# JUST long enough to chown /data to node, then execs the server via gosu so the
# process itself is non-root. `exec` keeps node as PID 1 so it receives SIGTERM
# for the graceful drain.
#
# NOTE (--no-sandbox stays): src/tools/render.js still launches Chromium with
# --no-sandbox because this container has no user-namespace / seccomp profile
# for Chromium's own sandbox. Removing it REQUIRES enabling that at the platform
# level first (see the Security-Model wiki page) — dropping it here blindly
# 503s every browser tool. Non-root already removes the "escape == root" impact.
#
# NOTE (full isolation is a follow-up): the browser and media parsers still
# share this container with the payment/DB/operator env. True A402-01/02/06
# isolation is a separate browser/media worker service with no secrets — see
# the design doc. This PR does not implement it.
ENTRYPOINT ["docker-entrypoint.sh"]
EXPOSE 3000
# start.js dispatches: WORKER_MODE=true → the secretless worker, else the API.
# Still `node <script>` so the gosu entrypoint keeps dropping to the node user.
# V8 young generation 16 MB -> 64 MB per semi-space. Boot parses a ~50 MB JSON
# cache into ~2,900 seller objects and the first-import CPU profile (2026-08-25)
# put 4.3 s of the boot stall in the garbage collector: with the default nursery
# that allocation burst is hundreds of scavenges. A bigger nursery is a few tens
# of MB of RSS for a shorter, quieter boot; it is a launch flag, not a Railway
# variable, so it cannot trigger the variable-write redeploy race.
ENV NODE_OPTIONS="--max-semi-space-size=64"
CMD ["node", "start.js"]
