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
FROM node:22-slim
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev
COPY mcp/index.js mcp/networks.js mcp/output-schemas.js mcp/README.md ./
ENTRYPOINT ["node", "index.js"]
