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
The server is fully open source; CI re-tests every endpoint against its own documented example before each deploy; and revenue settles on-chain to a public wallet anyone can audit on [Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).

**What if a tool fails after I paid?**
x402 settles before the handler runs, so the operating principle is: anything that can't be served reliably is removed from the catalog rather than left to charge-and-502. Failure rates are watched by CI and a 15-minute production heartbeat.

**Can I list my own service alongside this, or integrate?**
Agent402 is also listed on the agent402.app marketplace and the Coinbase CDP Bazaar; the catalog is consumable via OpenAPI/x402 discovery. Open an [issue](https://github.com/MikeyPetrillo/Agent402/issues) to talk integrations.

**Who runs this?**
[Mikey Petrillo](https://github.com/MikeyPetrillo) — a named maintainer, which most x402 sellers (anonymous wallets) don't offer.
