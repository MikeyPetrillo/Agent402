# Credits keys

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

A credits key already issued (`a402_...`) holds a prepaid balance that pays for this server's own services: send it as `Authorization: Bearer a402_...`. The [`/credits`](https://agent402.tools/credits) page says whether new keys are on sale.

## How a call is paid

- The server authorizes the call against the key's balance before the handler runs and debits the list price only on a successful (200) final response; a refused or failed call debits nothing.
- Every answer carries what is left in `X-Credits-Balance`, and `GET /api/credits/balance` with the same header reads it.
- A credits key pays for this server's own tools only: the routes that buy from an outside seller (the route-execute tiers, `seller-payability`, `decide-execute`) and the wallet-scoped routes (memory, attest, feedback, my-usage) refuse it and need a wallet.
- A credits payment is never settled first.

`agent402-client` takes the key as `creditsKey`, and `agent402-mcp` reads it from `AGENT402_CREDITS_KEY`. See [[agent402-client]] and [[MCP Connector]].

## Running it on your own server

| Setting | Effect |
|---|---|
| `STRIPE_SECRET_KEY` | Mounts `/credits` and the credits gate ([[Card Payments|Card-Payments]]) |
| `CREDITS_SALES` | `on` opens new credit sales; unset keeps them off (the checkout answers 503) and existing keys keep working either way |
| `CREDITS_BALANCE_MAX_USD`, `CREDITS_DAILY_MAX_USD` | The most one key may hold, and the most one buyer may buy in 24 hours; a pack above either is not offered |

Every credits variable is in the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md).
