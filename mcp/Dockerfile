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
FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
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
