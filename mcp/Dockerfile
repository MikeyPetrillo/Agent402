# Dockerfile for the agent402-mcp stdio server - written for Glama's built-
# server evaluation (glama.ai clones the repo and builds this from the REPO
# ROOT, so every COPY is mcp/-prefixed; local build: docker build -f
# mcp/Dockerfile .). Their check only needs the server to start and answer
# MCP introspection over stdio - it does so keyless (the catalog loads from
# the hosted API; payment credentials are only read when a paid call is
# attempted).
#
# Kept in mcp/ ON PURPOSE: a repo-root Dockerfile would be auto-detected by
# Railway and silently replace the Railpack build that deploys production.
#
# Same hardening as the root Dockerfile.mcp (scripts/test-mcp-dockerfiles.js
# holds the two to it): the base pinned by digest, dependency install with no
# lifecycle scripts, and the server run as the unprivileged `node` user.
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./
# --ignore-scripts: the mcp deps are pure JS, so no dependency lifecycle
# script needs to run during install and none can execute during it.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# Every file index.js imports (scripts/test-mcp-dockerfiles.js checks this list).
COPY mcp/index.js mcp/async-job.js mcp/known-assets.js mcp/networks.js mcp/output-schemas.js mcp/discovery.js mcp/README.md ./
# The stdio server writes nothing to disk, so the copied files stay root-owned
# and world-readable and no ownership fixup is needed.
USER node
# stdio transport: the MCP client speaks JSON-RPC over stdin/stdout.
ENTRYPOINT ["node", "index.js"]
