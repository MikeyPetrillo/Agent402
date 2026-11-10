---
paths:
  - "src/x402-index.js"
  - "src/index-parts.js"
  - "src/seller-tool-cap.js"
  - "src/router-*.js"
  - "src/tools/route-execute.js"
  - "src/*-buyer.js"
  - "src/base-unproven.js"
  - "src/algorand-sellers.js"
  - "src/discovery*.js"
  - "src/find.js"
  - "src/listing-screen.js"
  - "src/dispatch-eligibility.js"
  - "src/own-wallets.js"
  - "src/evidence-binding.js"
  - "src/seller-funding.js"
  - "src/shared-paytos.js"
  - "src/external-spend-guard.js"
  - "src/router-spend-window.js"
---

# Seller index, router and route-execute

Loaded when an index, discovery, router or buyer file is read.

- Self-serve submissions (`POST /api/index/register`) hold at most `INDEX_MAX_SUBMITTED_SEEDS`
  slots (default 4000; unset or 0 reads as the default; `INDEX_TUNNEL_SUBMISSION_SHARE`, 0.25,
  of them for quick tunnels); a slot is released after `INDEX_RELEASE_AFTER_DAYS` (30) with no
  successful probe, `INDEX_SETTLED_RELEASE_AFTER_DAYS` (90, never below the plain window) for a
  seller that has settled, `INDEX_TUNNEL_RELEASE_AFTER_DAYS` (3) for a tunnel. The operator
  seeds past the cap with `POST /__operator/index/seed`. A registration naming one of our own
  hosts (the base URL, a www or trailing-dot twin, our Railway domain, or a host listed in
  `SELF_SELLER_HOSTS`) is refused, and no buyer ever pays one of our own wallets
  (`src/own-wallets.js`, checked by route-execute and again by each buyer before it signs).
- **Index parts and tool cap:** A seller with more than `PART_TOOLS` tools (`src/index-parts.js`, 2000) is stored as a header row
  under its origin naming content-addressed part rows (`x402-index-parts`, about 2000 tools each);
  a save writes only the parts the table lacks and then the header, a reader accepts only the parts
  the header names (else it re-reads the header or keeps its copy), and unnamed parts are swept after
  `INDEX_PARTS_ORPHAN_GRACE_MS` (default 10 minutes). `INDEX_PART_TOOLS` moves the threshold. A build
  from before the parts format reads a header row as a seller with no tools, so before rolling back
  past it set `INDEX_PART_TOOLS` very high and wait one crawl cycle (each seller rewrites as one row on
  its next changed save); otherwise fix forward. The index keeps at most `INDEX_SELLER_TOOL_CAP` tools per seller
  (`src/seller-tool-cap.js`, default 5000; described tools first, then listing order), applied once in
  `IndexCache.set` before the route index, the persist and the replica read the entry; a cut entry
  carries `toolsTotal` and `toolsCapped`, shown beside `toolCount` on `/api/index` rows, the `?seller=`
  detail (with `toolCap` and `toolCapLegend`) and the `index` block of `/__operator/heap.json`
  (`cappedSellers`, `toolsDropped`). A registry-only fallback crawl whose listing passes the cap takes
  the same rows before its whole-list passes (`registryRowsUnderCap`: a step of rows at a time in the
  crawl lane, replacing a row a probe drops) and hands `IndexCache.set` the cut list with its
  `toolsTotal`; any fallback list past 2,000 rows runs each pass in the lane. Such a crawl logs one
  `[x402-index] fallback passes <listed> rows (kept <n>) <origin hash>: pick= copy= vouch= stamp= carry=
  quotes= total= longest=` line when its listing was cut, its passes total over 200 ms or one pass is
  over 100 ms (`scripts/test-fallback-crawl-turn.js`).
- **Paywall probe:** one unpaid request per seller checks that its paid route answers a 402,
  on a rotation capped at `X402_PAYWALL_PROBES_PER_CYCLE` sellers per crawl cycle (default 25; 0 turns
  every paywall probe off, re-checks included). The verdict is kept apart from crawl health: it reports
  and does not re-rank. A failed verdict older than `X402_PAYWALL_FAILED_RECHECK_HOURS` (default 24; a
  value that is not a positive number reads as the default), or one taken at a documentation-template
  path, is re-probed by the next crawl that visits the origin, from a budget of its own:
  `X402_PAYWALL_RECHECKS_PER_CYCLE` (default 25, refilled at the start of each crawl cycle; 0 stops
  re-checks). A seller that keeps failing is stamped again and waits a whole window; a passing verdict
  stays on the rotation; an explicit re-registration probes whenever probes are on (`paywallVerdictExpired` in
  `src/x402-index.js`, `scripts/test-index-paywall-recheck.js`).
- **Unproven tier:** A Base seller below the settlement floor is tried after every proven candidate in the unproven
  tier (`src/base-unproven.js`): its signed quote at most `SOR_BASE_UNPROVEN_MAX_USD` (default
  $0.05), paid only at its live 402's payTo, `sellerProof: "unproven"` on the receipt, and at most
  `SOR_BASE_UNPROVEN_SELLER_DAILY_USD` (default $0.25) per seller (payTo and origin key; a path-scoped
  seller's origin key is its origin plus prefix, passed as `sellerKey`, and a paid URL outside that
  prefix has no key and is not paid; each window keeps a running sum beside it) over a
  rolling 24 h, reserved before signing on the shared-limits window (Redis) and given back only
  when nothing moved. A rolling 24-hour cap across all sellers (`SOR_BASE_UNPROVEN_DAILY_USD`,
  default 5; `off` or 0 removes it; a malformed value reads as the default) is reserved in the same
  script and window store, checked before signing, booked and released under the same rules; a
  seller refused by it gets the same pre-commit 409 and the router moves on. A payTo listed in
  `src/shared-paytos.js` is not a per-seller key: a seller paid at one is capped on its origin alone
  (`configureUnprovenSharedPayTos`, wired in server.js). Solana's tier (`SOR_SVM_UNPROVEN_MAX_USD`,
  `src/solana-buyer.js`) is separate.
- **External spend guard:** `src/external-spend-guard.js` (per payer and per chain wallet).
- **Per-minute spend ceilings:** `SOR_SPEND_CAP_ATOMIC` (atomic USDC, default 2000000) is the
  alarm on what `payX402` holds for outside sellers in one minute, summed across buyers
  (`reserveSpend` in `src/x402-buyer.js`; every chain that payer buys on, so EVM, Solana and
  Algorand; `payTempo` has no per-minute ceiling). Past it a purchase is still made and
  `routerSpendWindow` on `/api/gateway-status` reads `over`. `SOR_SPEND_HARD_CAP_ATOMIC` (default
  5 times the alarm; never under it) is the stop: a purchase that would pass it answers 429
  before anything is signed and the word reads `capped`. `0` on the alarm refuses every purchase
  (`off`); a blank or malformed value reads as the default. Each word holds an hour
  (`REFUSAL_HOLD_MS`) as this process's mark and as a flag in the shared store, and the word
  reads the later of the two (`src/router-spend-window.js`). The status Worker and
  `heartbeat.yml` page on `over` and `capped` under one issue ("Router spend per minute OVER its
  ceiling") and close it on `ok` or `off`. The unsettled loss stays bounded by the external spend
  guard above (`scripts/test-router-spend-window.js`, `scripts/test-spend-words-shared-redis.js`).
- **Seller refusal notes:** a route is benched after two refusals of payments we sent within
  `SOR_SELLER_REFUSAL_TTL_MS` (6 h), and a settled delivery clears it (`src/x402-buyer.js`). When
  `SOR_CHAIN_REFUSAL_OURS_MIN` (default 5) different sellers on one chain refuse our paid retries
  inside `SOR_CHAIN_REFUSAL_WINDOW_MS` (default 30 minutes) with no settle on that chain between
  them, the cause is read as ours: no route on that chain is noted until a payment there settles or
  those refusals age out of the window. A refusal from a seller paid under the Base unproven tier never
  counts toward it (it is noted as the seller's own); the hold logs once when it starts and is listed as `chainRefusalHolds` on
  `/__operator/tool-failures.json`.
- **EVM buyer chains:** `src/evm-buyer-chains.js` lists the EVM chains the one spending wallet
  (`X402_UPSTREAM_BUYER_KEY`) can pay a seller on: Base, Arc, Celo, Polygon, Arbitrum and Robinhood
  (USDG), each with its asset, decimals and EIP-712 domain from our own tables, never the seller's.
  Base is always on; any other chain is dispatched only while `SOR_EVM_CHAINS` lists it (comma
  separated names or CAIP-2 ids; unset = Base only), and payX402 refuses an unlisted one whoever
  calls it. Each enabled chain gets Base's domain check, split-price refusal, evidence wallets,
  capped validity, signed-amount assert and chain-truth refusal read (`EVM_RPC_<id>` overrides the
  RPC), its own rolling 24 h ceiling (`SOR_WALLET_DAILY_MAX_USD_<CHAIN>`, default $25), and a
  low-balance refusal on its own reading of the same address (`UPSTREAM_BUYER_LOW_USD_<CHAIN>`,
  else `UPSTREAM_BUYER_LOW_USD`), one word per chain under `upstreamBuyerEvm` on
  `/api/gateway-status` ("off" with none enabled). The unproven tier stays Base only. Off Base no
  buyer payment settles back into the spending wallet, so each chain's balance is funded by hand.
- **Router evidence:** `src/evidence-binding.js` keeps settlement evidence per wallet;
  `src/seller-funding.js` nets payments made with USDC the paid wallet itself sent the payer
  (each payer's history read once when it first pays, then incremental; state on `/data`);
  `src/shared-paytos.js` lists shared settlement contracts. `src/router-purchases.js` records
  the router's own buys per origin, payTo and chain for 30 days (`SOR_ROUTER_PURCHASES_FILE`),
  and the evidence rule deducts them from an origin's Bazaar counts: a router buy never proves a seller.
  The funding reader can be switched off (`LEADERBOARD_FUNDING_SCAN=off`); off, the router reads
  gross per-wallet evidence with no netting and no verdict.
- **Router worker:** `src/router-pool.js` scores route queries in a worker thread
  (`src/router-worker-thread.js` imports `x402-index.js` and holds a replica of the stores a
  query reads, fed by the index's replica observer); `routeQueryAsync` stays the entry point and
  runs in-thread when no worker is loaded. `ROUTER_WORKERS` (default 1; 0 with the crawler off),
  `ROUTER_QUERY_DEADLINE_MS` (default 10000). Status on `/__operator/perf.json`.
- **Seller fields:** every entry the index cache stores (crawl, Bazaar fallback, pull, warm start, the
  router worker's replica) is cleaned once in `IndexCache.set` (`cleanSellerEntry`): a seller field
  read as text holds a string (a number or boolean becomes its text, anything else is dropped) and a
  list field holds strings (`scripts/test-seller-field-types-serve.js`).
- **Listing screen:** `src/listing-screen.js` (re-exported by `src/x402-index.js`) flags seller
  listing text that tries to instruct its reader; it depends only on `src/hidden-chars.js`, so
  a workflow with no install (`wish-issues.yml`) reads the same rules.
