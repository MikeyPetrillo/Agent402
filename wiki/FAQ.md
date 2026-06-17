# FAQ

**Do I need an account or API key?**
No. Nothing here has a signup. Payment (USDC or proof-of-work) is the only credential, per call.

**What does it cost?**
Flat per-call prices, $0.001–$0.02, published in [`/api/pricing`](https://agent402.tools/api/pricing) and quoted exactly in every 402 response. No subscriptions or tiers.

**Can I use it without any money?**
Yes — ~1,040 pure-CPU tools accept proof-of-work (sub-second of your CPU), and the hosted MCP connector runs the same set free (rate-limited). See [[Paying with Compute]].

**What is x402?**
An open HTTP payment standard built on the `402 Payment Required` status code, with settlement infrastructure from Coinbase and Stripe. See [[Paying with x402]].

**Which chain/asset?**
USDC on Base mainnet (`eip155:8453`). The buyer needs only USDC — gas is sponsored by the facilitator.

**Does using this spend my AI tokens?**
No. There's no LLM anywhere in the serving path — every tool is deterministic code. Proof-of-work spends your CPU; x402 spends USDC.

**Is my data stored?**
Tool inputs are processed in memory and not persisted — except the memory tools, whose purpose is storage (wallet-keyed, owner-deletable, TTL-able). Full policy: [agent402.tools/privacy](https://agent402.tools/privacy).

**How do I know the service is honest?**
The server is fully open source; CI re-tests every endpoint against its own documented example before each deploy; and revenue settles on-chain to **`agent402.base.eth`** (the named public receiving wallet) — anyone can audit it on [Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).

**What if a tool fails after I paid?**
x402 settles before the handler runs, so the operating principle is: anything that can't be served reliably is removed from the catalog rather than left to charge-and-502. Failure rates are watched by CI and a 15-minute production heartbeat.

**Can I list my own service alongside this, or integrate?**
Agent402 is also listed on the agent402.app marketplace and the Coinbase CDP Bazaar; the catalog is consumable via OpenAPI/x402 discovery. Open an [issue](https://github.com/MikeyPetrillo/Agent402/issues) to talk integrations.

**Can I find tools on other x402 sellers from here?**
Yes — Agent402 is also an [[x402 Index + Smart Order Router|x402-Index-and-Router]]. `POST /api/route` ranks tools across every x402 seller it has crawled (auto-discovered from the Coinbase CDP Bazaar, refreshed hourly), filters out unhealthy ones, and tiebreaks on health then price. Browse the live index at [`/index`](https://agent402.tools/index).

**How do I see which x402 sellers are most used?**
[`GET /api/leaderboard`](https://agent402.tools/api/leaderboard) returns the live on-chain ranking of every x402 seller by **Base USDC settled volume** (calls served, totalUsd, unique buyers per seller). The pipeline walks every page of the Coinbase CDP Bazaar, queries `eth_getLogs` on Base USDC for each seller's `payTo` wallet, filters per-call settlements within a $0.50 ceiling (larger inbound is funding, not buys), and aggregates. Snapshot refreshes hourly. Use `?include=external` to exclude Agent402 itself. Full details in [[x402-Leaderboard]].

**Who runs this?**
[Mikey Petrillo](https://github.com/MikeyPetrillo) — a named maintainer, which most x402 sellers (anonymous wallets) don't offer.
