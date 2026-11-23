# Troubleshooting a self-hosted server

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

Each entry names what you see, why, and the setting that changes it. Every variable is in the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md).

## The server exits at boot

- **Neither free nor paid mode is configured.** Set `FREE_MODE=true`, or the paid-mode settings in [[Self-Hosting]] (`WALLET_ADDRESS`, a facilitator, `POW_SECRET`).
- **`Unsupported primary network`**: `NETWORK` names a chain the server does not know. The error lists the known names.
- **No facilitator for the primary network.** Set `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` or `FACILITATOR_URL`; with neither, only `NETWORK=base-sepolia` boots, on the public testnet facilitator.

## A chain is missing from the 402

- **Solana, Stellar or Algorand**: each needs its own receiving address (`SOLANA_WALLET_ADDRESS`, `STELLAR_WALLET_ADDRESS`, `ALGORAND_WALLET_ADDRESS`). Unset, the server logs a boot warning and leaves that option out. See [[Solana]], [[Stellar]], [[Algorand]].
- **Arc** is configured only while `CIRCLE_FACILITATOR_API_KEY` is set, and offered only while the facilitator's `/supported` lists it. See [[Arc]].
- **Ink** is configured only with `INK_FACILITATOR_URL`; an `ink` entry without it is dropped with a boot warning. See [[Ink]].
- **Any chain** whose facilitator's `/supported` read fails at boot is dropped with a boot warning that names the facilitator, and rejoins the offer when a background re-read answers.

## Payments fail on Solana while the 402 looks healthy

The receiving address must already hold a USDC token account, or every payment fails on-chain simulation. Send the address any amount of USDC on Solana once; boot checks this and warns.

## A tool answers 503

- **The tool needs a key you have not set** (search, model, media and some data tools). `/api/pricing` and `/openapi.json` describe each tool; the configuration reference names each key.
- **`/v1` model routes** need `OPENROUTER_API_KEY`; without it every model route answers 503.
- **Transcription** needs `ffmpeg` on the host for every file except PCM WAV; **`image-ocr`** needs the language data from `node scripts/fetch-tessdata.js`. The project's `Dockerfile` installs both.

## `/api/decide` answers 404

Decide runs as its own service (`npm run start:decide`, `services/decide`, with its own Postgres). The main server serves `/api/decide` only when `DECIDE_SERVICE_URL` and `DECIDE_INTERNAL_TOKEN` (24 characters or more) are both set. See [[Decide]].

## Every visitor shares one rate limit

Behind a reverse proxy, set `TRUST_PROXY_HOPS` to the number of proxies in front (`1` behind a single edge). Unset, the client address is the connection's, so every visitor reads as the proxy; the server logs a warning at boot.

## State does not survive a deploy

Without `STATE_DATABASE_URL`, state lives in SQLite and files under `/data`: that directory must be writable and persistent. With it, state lives in Postgres and two containers can overlap during a deploy. See [[Self-Hosting]].

## Checking the whole catalog

```bash
FREE_MODE=true PORT=3000 node src/server.js &
TARGET_URL=http://localhost:3000 node scripts/test-all.js
```

Every tool answers its own published example; a failure names the tool.
