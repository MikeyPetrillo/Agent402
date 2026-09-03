# FAQ

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

**Do I need an account or API key?**
No. Nothing here has a signup. Payment (USDC over x402 or MPP, or proof-of-work) is the only credential, per call. If you have a card and no wallet, prepaid credits from [`/credits`](https://agent402.tools/credits) give you an `a402_…` key that pays any tool with one header; it is a balance, not an account (see [[Reports, Monitors and Credits|Reports-and-Monitors]]).

**What does it cost?**
Flat per-call prices starting at **$0.001**. Most tools are $0.001–$0.02; premium inference, media, and multi-tool skill packs are priced higher (up to $1.50 for the biggest pack). Every price is published in [`/api/pricing`](https://agent402.tools/api/pricing) and quoted exactly in every 402 response. Report products (`/v1/research`, `/v1/dossier`, `/v1/ticker-pack`, `/v1/fund`, `/v1/filing-report`, `/v1/domain-audit`, `/v1/recall-report`, `/v1/insider-report`, `/v1/token-brief`, `/v1/token-risk`, `/v1/linkedin-article`) are priced per finished report, $0.60 to $2.00 over x402 or MPP ($0.05 for the deterministic `/v1/ipo-report` digest), or $2 to $5 by card at [`/reports`](https://agent402.tools/reports) - the card price includes payment processing, and an agent paying per call pays the lower tool price for the same report. Monitors at [`/monitors`](https://agent402.tools/monitors) are the one subscription, $5 per month per target. The LLM gateway's metered tier (`POST /v1/metered/chat/completions`) is the one route whose 402 quotes each request from its body rather than a flat price.

**Can I pay by card?**
Yes, three ways: a finished report at [`/reports`](https://agent402.tools/reports), a monitor at [`/monitors`](https://agent402.tools/monitors), or prepaid credits at [`/credits`](https://agent402.tools/credits) that spend on every tool (debited only on a successful call, never expire). Routes at or above the card minimum (fifty cents) also accept cards over the MPP wire (Stripe `stripe/charge`) when the operator enables it.
Identity-bound tools (memory, `my-usage`) need a wallet payment because the wallet is the identity.

**Can I use it without any money?**
Yes: 150+ pure-CPU tools accept proof-of-work (sub-second of your CPU), and the hosted MCP connector runs the same set free (rate-limited) through `catalog.call`. See [[Paying with Compute]].

**What is x402?**
An open HTTP payment standard built on the `402 Payment Required` status code, with settlement infrastructure from Coinbase and open client tooling from Stripe. See [[Paying with x402]].

**Which chain/asset?**
USDC on Base (primary), Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, or Algorand - plus USDG (Global Dollar) on Robinhood Chain. The buyer needs only the stablecoin - gas/fees are sponsored by the facilitator on every rail.

**Does using this spend my AI tokens?**
No. There's no LLM in the serving path of the utility tools - they are deterministic code. Proof-of-work spends your CPU; x402 or MPP spends USDC. (The report products are the exception by design: deterministic evidence gathering plus a grounded, cited synthesis, priced per report, and the `/v1` LLM gateway is inference you ask for explicitly.)

**Is my data stored?**
Tool inputs are processed in memory and not persisted - except the memory tools, whose purpose is storage (wallet-keyed, owner-deletable, TTL-able). Full policy: [agent402.tools/privacy](https://agent402.tools/privacy).

**How do I know the service is honest?**
The server is fully open source; CI re-tests every endpoint against its own documented example before each deploy; and revenue settles on-chain to **`agent402.base.eth`** (the named public receiving wallet) - anyone can audit it on [Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).

**What if a tool fails after I paid?**
Then you weren't charged. The paywall runs the **handler first and settles afterwards**, and it settles only a response with a status below `400`. Any `4xx` or `5xx` cancels settlement, so a failed call takes no money. (A `200` is charged only once settlement succeeds; if settlement itself fails you get a `402`, not a bill.) On top of that, anything that can't be served reliably is removed from the catalog rather than left to fail repeatedly. Failure rates are watched by CI and a 15-minute production heartbeat.

**Can I list my own service alongside this, or integrate?**
Agent402 is listed on the Coinbase CDP Bazaar; the catalog is consumable via OpenAPI/x402 discovery. Open an [issue](https://github.com/MikeyPetrillo/Agent402/issues) to talk integrations.

**Can I find tools on other x402 sellers from here?**
Yes - Agent402 is also an [[x402 Index + Smart Order Router|x402-Index-and-Router]]. `POST /api/route` ranks tools across every x402 seller it has crawled (auto-discovered from the Coinbase CDP Bazaar, refreshed hourly), filters out unhealthy ones, and tiebreaks on health then price. Browse the live index at [`/marketplace`](https://agent402.tools/marketplace).

**How do I see which x402 sellers are most used?**
[`GET /api/leaderboard`](https://agent402.tools/api/leaderboard) returns the live on-chain ranking of every x402 seller by **Base USDC settled volume** (calls served, totalUsd, unique buyers per seller). The pipeline walks every page of the Coinbase CDP Bazaar, queries `eth_getLogs` on Base USDC for each seller's `payTo` wallet, filters per-call settlements within the per-call ceiling reported as `maxCallUsd` (**$0.75** by default; larger inbound is funding, not buys), and aggregates. Snapshot refreshes hourly. Use `?include=external` to exclude Agent402 itself. Full details in [[x402-Leaderboard]].

**Who runs this?**
[Havok Holdings LLC](https://github.com/MikeyPetrillo/Agent402) - a public, contactable maintainer. Contact: [mike@agent402.tools](mailto:mike@agent402.tools) · [@Agent402Tools on X](https://x.com/Agent402Tools).

**Is there an acceptable-use policy? Who is responsible for generated content?**
Yes - the hosted instance's [Terms of Service](https://agent402.tools/terms) include a generative-content acceptable-use policy (and the upstream model providers' usage policies apply to `/v1` traffic). Outputs are generated by third-party models from the inputs you send: Agent402 doesn't review, own, publish, or retain them, and you are responsible for your inputs and how you use the outputs. Wallets used for prohibited content are blocked before settlement, so they are never charged. Report abuse: [mike@agent402.tools](mailto:mike@agent402.tools).

