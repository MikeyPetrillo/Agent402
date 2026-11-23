# Card payments (operator setup)

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

People without a wallet buy report products and monitors by card at `/reports` and `/monitors`; an agent can pay a card over the MPP wire on the routes that offer it. This page is for running the card side on your own server; the buyer side is in [[Reports and Monitors|Reports-and-Monitors]].

## Turning it on

| Setting | Effect |
|---|---|
| `STRIPE_SECRET_KEY` | Mounts the card front door: `/reports` checkout, `/monitors` subscriptions, `/credits` and the credits gate. Unset, none of it is mounted; the `/v1` report routes still sell over x402 and MPP |
| `STRIPE_WEBHOOK_SECRET` | Verifies the Stripe webhook (subscription status, invoices, credits purchases, refunds and disputes). The webhook is verified only when set |
| `STRIPE_PROFILE_ID` | With the secret key, adds cards over the MPP wire (`stripe/charge` with Shared Payment Tokens) on the routes priced high enough to carry a card payment |
| `STRIPE_AUTOMATIC_TAX` | `true` adds Stripe Tax to every Checkout Session (turn on Stripe Tax in the dashboard first) |
| `EMAIL_FROM` with `ZEPTOMAIL_TOKEN` or `RESEND_API_KEY` | Emails report links, monitor reports and credits keys. Without them the card pages still work and the report link is shown on the page |

## How a card charge relates to the work

A card payment is never settled before its run. Card refunds are made by a person, never on a schedule.

Every Stripe variable is in the [configuration reference](https://github.com/MikeyPetrillo/Agent402/blob/main/docs/configuration.md). See also [[Credits]] and [[Troubleshooting]].
