#!/bin/bash
# Deploy the Nasdaq calendar relay worker to Cloudflare and wire it into Railway.
# Run from repo root: bash scripts/deploy-nasdaq-relay.sh
set -euo pipefail

echo "=== Deploying Nasdaq relay worker ==="
cd workers/nasdaq-relay

# Generate a random relay token
TOKEN=$(openssl rand -hex 32)
echo "Generated RELAY_TOKEN: $TOKEN"

# Deploy to Cloudflare
echo ""
echo "Deploying to Cloudflare Workers..."
npx wrangler deploy

# Set the secret
echo ""
echo "Setting RELAY_TOKEN secret..."
echo "$TOKEN" | npx wrangler secret put RELAY_TOKEN

# Get the worker URL
WORKER_URL=$(npx wrangler deployments list --json 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8'))?.[0]?.url || 'https://agent402-nasdaq-relay.<your-account>.workers.dev'" 2>/dev/null || echo "https://agent402-nasdaq-relay.<your-account>.workers.dev")

echo ""
echo "=== Done! Now set these on Railway: ==="
echo ""
echo "  NASDAQ_RELAY_URL=$WORKER_URL"
echo "  NASDAQ_RELAY_TOKEN=$TOKEN"
echo ""
echo "Via Railway CLI:"
echo "  railway variables set NASDAQ_RELAY_URL=$WORKER_URL"
echo "  railway variables set NASDAQ_RELAY_TOKEN=$TOKEN"
