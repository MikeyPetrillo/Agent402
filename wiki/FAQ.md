# FAQ

> **Payment wires:** every paid endpoint accepts **x402** and **MPP** (Machine Payments Protocol) on the same 402 - see [[Paying with x402]] and [[Paying with MPP]]. Agent402 is the applied layer of [[Agentic Finance]]: agents that pay and get paid on their own.

**Do I need an account or API key?**
No. Nothing here has a signup. Payment (USDC over x402 or MPP, or proof-of-work) is the only credential, per call. If you have a card and no wallet, buy a finished report by card at [`/reports`](https://agent402.tools/reports). Prepaid credits are not on sale at the moment; an `a402_…` key already issued still pays any tool except the wallet-identity-bound ones with one header, and it is a balance, not an account (see [[Reports, Monitors and Credits|Reports-and-Monitors]]).

**What does it cost?**
Flat per-call prices starting at **$0.001**. Most tools are $0.001–$0.02 and premium inference and media are priced higher; multi-tool skill packs are priced from the tools they run (the current range is on [`/skills`](https://agent402.tools/skills)). Every price is published in [`/api/pricing`](https://agent402.tools/api/pricing) and quoted exactly in every 402 response. Report products (`/v1/research`, `/v1/dossier`, `/v1/ticker-pack`, `/v1/fund`, `/v1/filing-report`, `/v1/domain-audit`, `/v1/recall-report`, `/v1/insider-report`, `/v1/token-brief`, `/v1/token-risk`, `/v1/linkedin-article`) and the deterministic `/v1/ipo-report` digest are priced per finished report over x402 or MPP, or by card at [`/reports`](https://agent402.tools/reports) - the card price includes payment processing, and an agent paying per call pays the lower tool price for the same report. Monitors at [`/monitors`](https://agent402.tools/monitors) are the one subscription, billed monthly per target. The LLM gateway's metered tier (`/v1/metered/*`) is where the 402 quotes each request from its body rather than a flat price.

**Can I pay by card?**
Yes: a finished report at [`/reports`](https://agent402.tools/reports) or a monitor at [`/monitors`](https://agent402.tools/monitors). Prepaid credits at [`/credits`](https://agent402.tools/credits) are not on sale at the moment; keys already issued keep spending on every tool (debited only on a successful call, never expire). Routes at or above the card minimum (fifty cents) also accept cards over the MPP wire (Stripe `stripe/charge`) when the operator enables it.
Identity-bound tools (memory, `my-usage`) need a wallet payment because the wallet is the identity.

**Can I use it without any money?**
Yes: 150+ pure-CPU tools accept proof-of-work (sub-second of your CPU), and the hosted MCP connector runs the same set free (rate-limited) through `catalog.call`. See [[Paying with Compute]].

**What is x402?**
An open HTTP payment standard built on the `402 Payment Required` status code, with settlement infrastructure from Coinbase and open client tooling from Stripe. See [[Paying with x402]].

**Which chain/asset?**
USDC on Base (primary), Solana, Polygon, Arbitrum, Monad, Celo, Avalanche, Sei, Optimism, Stellar, or Algorand - plus USDG (Global Dollar) on Robinhood Chain. Gas is sponsored by the facilitator on the EVM chains, so the buyer needs only the stablecoin there.

**Does using this spend my AI tokens?**
No. The utility tools are deterministic code with no model in their serving path. Proof-of-work spends your CPU; x402 or MPP spends USDC. The tools that do run a model are marked `modelBacked: true` in [`/api/pricing`](https://agent402.tools/api/pricing), among them the `/v1` gateway tiers (inference you ask for explicitly), the report products (evidence gathering plus a grounded, cited synthesis), and the image, speech, transcription, embedding and AI-answer tools. Their model use is billed in the call's price, never to your own tokens.

**Is my data stored?**
Tool inputs are processed in memory and not persisted - except the memory tools, whose purpose is storage (wallet-keyed, owner-deletable, TTL-able). Full policy: [agent402.tools/privacy](https://agent402.tools/privacy).

**How do I know the service is honest?**
The server is fully open source; CI re-tests every endpoint outside the metered set (model tiers, keyed search, report products) against its own documented example before each deploy; and revenue settles on-chain to **`agent402.base.eth`** (the named public receiving wallet) - anyone can audit it on [Basescan](https://basescan.org/address/0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0#tokentxns).

**What if a tool fails after I paid?**
Then you weren't charged. The paywall runs the **handler first and settles afterwards**, and it settles only a response with a status below `400`. Any `4xx` or `5xx` cancels settlement, so a failed call takes no money. (A `200` is charged only once settlement succeeds; if settlement itself fails you get a `402`, not a bill.) On top of that, anything that can't be served reliably is removed from the catalog rather than left to fail repeatedly. Failure rates are watched by CI and a 15-minute production heartbeat.

**Can I list my own service alongside this, or integrate?**
Agent402 is listed on the Coinbase CDP Bazaar; the catalog is consumable via OpenAPI/x402 discovery. Open an [issue](https://github.com/MikeyPetrillo/Agent402/issues) to talk integrations.

**Can I find tools on other x402 sellers from here?**
Yes - Agent402 is also an [[x402 Index + Smart Order Router|x402-Index-and-Router]]. `POST /api/route` ranks tools across every x402 seller it has crawled (auto-discovered from the Coinbase CDP Bazaar, refreshed hourly), filters out unhealthy ones, and orders the shortlist by match, then crawl health, then distinct payers over the last 30 days, then price. Browse the live index at [`/marketplace`](https://agent402.tools/marketplace).

**How do I see which x402 sellers are most used?**
[`GET /api/leaderboard`](https://agent402.tools/api/leaderboard) returns the head of the live on-chain ranking of x402 sellers by **Base USDC settled volume** (calls served, totalUsd, unique buyers per seller). It is a **top-N slice, not the whole board** - 25 rows by default, 50 the ceiling with `?top=N`, and `totalSellers` in the response says how many are ranked in all, so a seller missing from your rows may simply rank below them. The pipeline walks every page of the Coinbase CDP Bazaar, queries `eth_getLogs` on Base USDC for each seller's `payTo` wallet, filters per-call settlements within the per-call ceiling reported as `maxCallUsd` (**$0.75** by default; larger inbound is funding, not buys), and aggregates. Snapshot refreshes hourly. Agent402 itself is excluded by default (`include=external`); `?include=all` adds its row, flagged `self: true`. Full details in [[x402-Leaderboard]].

**Who runs this?**
[Havok Holdings LLC](https://github.com/MikeyPetrillo/Agent402) - a public, contactable maintainer. Contact: [mike@agent402.tools](mailto:mike@agent402.tools) · [@Agent402Tools on X](https://x.com/Agent402Tools).

**Is there an acceptable-use policy? Who is responsible for generated content?**
Yes - the hosted instance's [Terms of Service](https://agent402.tools/terms) include a generative-content acceptable-use policy (and the upstream model providers' usage policies apply to `/v1` traffic). Outputs are generated by third-party models from the inputs you send: Agent402 doesn't review, own, publish, or retain them, and you are responsible for your inputs and how you use the outputs. Wallets used for prohibited content are blocked before settlement, so they are never charged. Report abuse: [mike@agent402.tools](mailto:mike@agent402.tools).

