# Agent402

**56 pay-per-call tools for AI agents, paid in USDC via the [x402 protocol](https://x402.org).**

**🟢 Live at [agent402.tools](https://agent402.tools)** — USDC on Base mainnet.

No signups, no API keys, no subscriptions. An agent calls an endpoint, gets an
`HTTP 402 Payment Required` challenge, pays a fraction of a cent in USDC on Base
automatically, and gets the result. Every payment goes straight to your wallet.

## The catalogue (56 tools, 9 categories)

| Category | Tools | Highlights |
|---|---|---|
| Web & documents | 5 | `render` (headless Chromium, $0.02), `screenshot`, `pdf`, `extract`, `meta` |
| Agent memory | 2 | Wallet-keyed persistent KV store — the payment IS the login |
| Network & domains | 6 | `dns`, `http-check`, `tls-cert`, `whois` (RDAP), `robots-check`, `sitemap` |
| Data conversion | 10 | JSON ⇄ CSV/YAML/XML, markdown ⇄ HTML, `json-diff`, `json-query` |
| Text processing | 7 | `slugify`, `case`, `text-stats` (token estimates), `keywords`, `text-diff`, `regex`, `lorem` |
| Encoding & crypto | 7 | `hash`, `hmac`, `base64`, `hex`, `url-code`, `jwt-decode`, `totp` |
| Generators & IDs | 5 | `uuid` (v4/v7), `ulid`, `password`, `random`, `qr` (PNG) |
| Time & scheduling | 5 | `time`, `time-convert`, `cron-next`, `duration`, `date-diff` |
| Validation & parsing | 9 | `email-validate` (MX), `url-parse`, `ip-info`, `user-agent`, `color`, `semver`, `mime`, `iban-validate`, `card-validate` |

Free discovery surfaces: [`/tools`](https://agent402.tools/tools) (per-tool docs
pages), [`/api/pricing`](https://agent402.tools/api/pricing) (JSON catalog),
[`/openapi.json`](https://agent402.tools/openapi.json) (OpenAPI 3.1),
[`/llms.txt`](https://agent402.tools/llms.txt) (LLM-readable docs), `/health`.

## No wallet? Pay with compute (proof-of-work)

Agents that can't pay USDC can still use the **41 pure-CPU tools** by spending CPU
instead — a built-in anti-abuse onramp that converts non-payers into integrated
users. The browser/network/storage tools (`render`, `screenshot`, `pdf`,
`memory`, `extract`, `http-check`, …) stay wallet-only.

```js
import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("https://agent402.tools/api/pow/challenge?slug=hash")).json();
let n = 0;                                   // find a nonce with `difficulty` leading zero bits
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
const res = await fetch("https://agent402.tools/api/hash", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Pow-Solution": c.token + ":" + n },
  body: JSON.stringify({ text: "hello world" }),
});
```

Each challenge is signed, single-use, and short-lived; difficulty is tunable via
`POW_DIFFICULTY`. See `GET /api/pow` for the machine-readable description.

**Why agents pay for this instead of building it themselves:**

1. **Capabilities the sandbox doesn't have.** Most agent runtimes have no
   headless browser, restricted network egress, and no durable disk. `render`,
   `screenshot`, and `memory` are infrastructure rented by the call.
2. **State that survives the session.** `memory` is keyed to the paying wallet —
   persist findings today, read them next week from a different machine, zero
   credentials to store or leak.
3. **The token math.** Writing and debugging a CSV parser or cron calculator
   mid-task burns 10–100× more in tokens than a tested $0.001 call.
4. **One integration, 56 tools.** A single x402-wrapped fetch covers the whole
   catalogue. No per-service SDKs or API-key management.

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
