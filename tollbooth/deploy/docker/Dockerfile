# agent402-tollbooth as a self-contained reverse proxy. Put it in front of any
# site: humans pass free, AI crawlers pay (USDC via x402, or free proof-of-work).
# Configure via env (see README): TOLLBOOTH_UPSTREAM, TOLLBOOTH_SECRET, TOLLBOOTH_PAYTO,
# and TOLLBOOTH_FACILITATOR_URL to actually SETTLE (x402 + MPP) - the x402
# packages are installed here so settlement mode works out of the box.
# Base pinned by the multi-arch index digest (amd64 and arm64 both listed) to
# Node 22.23.5, the patch every other image in this repository runs
# (scripts/test-dockerfile-node-patch.js keeps them on one patch).
FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
# Exact versions: the tollbooth release this tree builds and the x402 packages
# the repository's lockfile tests it against (test-supply-chain-guards keeps
# them equal), so a rebuild never picks up a release nobody here ran.
RUN npm init -y >/dev/null 2>&1 && npm install agent402-tollbooth@0.11.0 @x402/express@2.30.0 @x402/core@2.30.0 @x402/evm@2.30.0
ENV PORT=4021
EXPOSE 4021
# The packages are installed by root and only read at run time, so the proxy
# runs as the image's unprivileged node user. Its one optional file, the shared
# proof-of-work replay record (TOLLBOOTH_REPLAY_SQLITE), goes in
# /var/lib/tollbooth, which that user owns (mount a volume there to keep it).
# su-exec runs the proxy as node from the entrypoint, the alpine counterpart
# of the gosu step in the repository's main image: an exec with no shell or
# process of its own left behind, so the proxy stays PID 1 and gets SIGTERM.
RUN apk add --no-cache su-exec && su-exec node true \
  && mkdir -p /var/lib/tollbooth && chown node:node /var/lib/tollbooth
# Its own name: the node base image already has a docker-entrypoint.sh.
COPY tollbooth-entrypoint.sh /usr/local/bin/tollbooth-entrypoint.sh
RUN chmod 0755 /usr/local/bin/tollbooth-entrypoint.sh
# No Dockerfile USER, on purpose: a replay record written by an earlier image
# that ran as root sits on its volume owned by root, and a proxy started as
# node opens it read-only, so every claim would fail. The entrypoint starts as
# root only to hand that record (and its volume directory) to node, then
# drops to node for good; nothing else runs as root. A container started with
# --user skips the hand-over and runs as that user.
ENTRYPOINT ["/usr/local/bin/tollbooth-entrypoint.sh"]
# Reverse-proxy mode (needs TOLLBOOTH_UPSTREAM); serves the operator dashboard at /__tollbooth.
# The installed bin runs directly: no npx wrapper between the signal and the process.
CMD ["/app/node_modules/.bin/agent402-tollbooth"]
