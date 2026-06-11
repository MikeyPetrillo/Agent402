# Agent402

**Pay-per-call web tools for AI agents, paid in USDC via the [x402 protocol](https://x402.org).**

No signups, no API keys, no subscriptions. An agent calls an endpoint, gets an
`HTTP 402 Payment Required` challenge, pays a fraction of a cent in USDC on Base
automatically, and gets the result. Every payment goes straight to your wallet.

## Endpoints

| Endpoint | Price | What it does |
|---|---|---|
| `POST /api/extract` | $0.005 | Any URL → clean markdown (title, byline, main content, boilerplate stripped) |
| `GET /api/meta?url=…` | $0.002 | Page metadata: title, description, OpenGraph, Twitter cards, canonical, favicon |
| `GET /api/dns?name=…&type=A` | $0.001 | DNS lookup (A, AAAA, MX, TXT, NS, CNAME) |
| `GET /api/pricing` | free | Machine-readable catalog of endpoints and prices |
| `GET /health` | free | Health check |

## Deploy on Railway

1. **Create the service**: in [Railway](https://railway.app), *New Project →
   Deploy from GitHub repo* and pick this repo. The included `Dockerfile` and
   `railway.toml` are picked up automatically.
2. **Set environment variables** on the service:
   - `WALLET_ADDRESS` — your Base USDC receiving address (`0x…`). This is where
     the money goes.
   - `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` — free keys from
     [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com). This enables
     real-money settlement on Base mainnet **and** lists your endpoints in the
     [x402 Bazaar](https://docs.cdp.coinbase.com/x402/docs/bazaar) so agents can
     discover and pay you without you lifting a finger.
   - `BASE_URL` — your public Railway URL (e.g. `https://agent402.up.railway.app`),
     used in the docs examples on the landing page.
3. **Generate a public domain** (Service → Settings → Networking → Generate Domain).

To test without real money first, set `NETWORK=base-sepolia` and omit the CDP
keys (the default x402.org facilitator handles testnet).

## Run locally

```bash
npm install
FREE_MODE=true npm start          # demo mode, no payments
# or, with payments:
cp .env.example .env              # fill in WALLET_ADDRESS etc.
node --env-file=.env src/server.js
```

## How agents pay

Any x402 v2 client works. Example with `@x402/fetch`:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://YOUR-URL/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
```

## Architecture

- `src/server.js` — Express app and the endpoint catalog (prices, descriptions,
  discovery schemas).
- `src/payments.js` — x402 v2 wiring: `ExactEvmScheme` (USDC on Base),
  facilitator selection (CDP / custom / testnet default), and Bazaar discovery
  extensions so agents can find the service.
- `src/tools/extract.js` — Readability + Turndown for article → markdown; jsdom
  for metadata parsing.
- `src/tools/fetch-guard.js` — outbound fetch with SSRF protection (private IP
  blocking), 5 MB size cap, 15 s timeout.
- `src/tools/dns.js` — DNS resolution with input validation.
