---
paths:
  - "src/x402-index.js"
  - "src/index-parts.js"
  - "src/seller-tool-cap.js"
  - "src/seller-docs-url.js"
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
  - "src/upstream-buyer-status.js"
  - "src/seller-load.js"
  - "src/user-agents.js"
  - "src/operator-key.js"
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
- **Our User-Agents:** `src/user-agents.js` is the one list of what each component sends to a
  seller, rendered on /crawler: `Agent402-Crawler` (document and registry reads; robots.txt is
  matched on it, and an `Agent402` group still applies), `Agent402-Probe` (paywall, quote and
  network probes; `probePublicUrl`'s default), `Agent402-Router` (the pre-payment probe, the
  model-list read and the purchase, with `X-Agent402-Via: router`), `Agent402-Fetch` (a tool
  fetching a caller's URL; `safeFetch`'s default, or `NETWORK_KIT_USER_AGENT` in network-kit2 when
  set) and `Agent402Bot` (the site-crawl tool). The older `Agent402/1.0` token is left only in the
  kits that call one data provider's fixed API, a list `scripts/test-user-agents.js` pins. Every
  robots.txt group naming one of our tokens is combined (RFC 9309; `robotsAllows` in kit.js).
- **Seller load:** `src/seller-load.js`. Process memory decides every request; the shared limits
  store is written behind it (per key, never awaited by a caller) and read once per crawl cycle by
  `sellerLoad.prefetch(due)`, one parallel batch bounded by `PREFETCH_WAIT_MS`, so a slow store
  never adds a round trip per origin or to a buyer's probe (`scripts/test-crawl-cycle-health.js`,
  `scripts/test-router-probe-load.js`). An unchanged manifest and OpenAPI (304 or the same body hash) on a scheduled crawl
  doubles that origin's wait from an hour up to `SELLER_REVISIT_MAX_HOURS` (default 12, at most 24,
  `off` disables); a change, a failed crawl, a router purchase that did not deliver
  (`noteSellerDeliveryFailure`) or a re-registration resets it, and an unscheduled read never
  lengthens it. Every crawler read and probe is counted per operator (`src/operator-key.js`) per
  UTC day; past `SELLER_PROBE_DAILY_BUDGET` (default 200, `off` disables) the scheduled crawl and
  its paywall and quote probes and the MPP index's crawl reads wait, while reads inside a started
  crawl are counted and never refused. The unpaid probes (paywall, quote, mpp-probe) take at most
  `PROBE_SHARE` (half) of the day (`|probes` count), so the document reads keep the rest. A
  registration's reads (`registerOrigin` runs in the `unscheduledReads` scope; the MPP index's
  ungated verify) are counted on the origin's `|unscheduled` count, never on its day and never
  refused, and their redirect landings on a `|landed-unscheduled` allowance of their own, so a
  registration anyone makes never spends a domain's scheduled crawl (`scripts/test-crawl-own-limits.js`).
  Shared-hosting suffixes in `src/operator-key.js` (cloud API, CDN and Pages hosts included) key
  each hostname as its own operator. The router's pre-payment probe
  (`sendRouterProbe`) has its own day count, is never refused and never counts against the crawl's
  budget. A request that reaches another operator's host through a redirect (a probe sent where
  the documents moved, `chargeTo`; a document read's hop, `landingGate` through safeFetch's
  `beforeRedirect`, the MPP index's document read included) is counted on the crawled origin's day
  and on the landing host's landed count, a second day's budget there: past it the request is not
  sent (`LandingHeld`), the crawl ends with the entry, history and revisit wait untouched and no
  vote in the cycle tally, and the origin's scheduled turn reads `landing` until the day rolls.
  Origins known to land on one such host take one turn in the cycle together, read one after
  another, least recently read first (`landingTurns`, `scripts/test-crawl-landing-turns.js`), so a
  day's allowance refreshes each in turn and ends partway through at most one read. That turn
  ends inside the cycle (`groupTurnGoesOn`): it reads ceil(members / CRAWL_CONCURRENCY), then goes
  on only while another turn of the cycle is open, so a slow group closes the cycle at most one
  read after a side-by-side read would; members not reached read `turn` (no vote, entry kept) and
  go first next cycle.
  The landing host's own day, crawl and router probes never read the landed count; a new
  redirect-following crawler read passes the gate (`scripts/test-crawl-redirect-budget.js`).
  A 429 or 503 on a crawler read or
  a probe holds that hostname's scheduled crawl and probes until Retry-After (30 minutes without
  one, at most a day), the MPP index's included; a router purchase is never held. A skipped origin
  keeps its entry; one backed off for unchanged documents votes healthy (not our side) in
  `cycleOkFraction` and the cycle tally, a throttled, budgeted or landing-held one is left out, and an origin read
  after a wait gets the hold window (`INDEX_CRAWL_HOLD_HOURS`) counted from the end of that wait,
  or from the last scheduled turn our limits passed over (`turnNotReadAt`: any skip reason), so a
  seller is never dropped because we chose not to read it; once a read has failed
  (`readIncomplete`), the start stays at `holdFromAt`, so a dark origin drops after the hold.
  Registration (`unscheduled`) document reads and paywall/mpp probes (not route quotes, which keep
  the reprice allowance): at most `SELLER_REGISTRATION_HOURLY_MAX` (default 20) per registrant
  (the register route's IP key, `runAsRegistrant`) per operator of the target host per clock hour
  (`RequestHeld` "registration-hour"; the register routes answer 429 with Retry-After), so one
  registrant never spends another's. Across registrants, past `SELLER_REGISTRATION_HOST_HOURLY_MAX`
  (default 200) per host-hour the reads are paced one per `REGISTRATION_PACE_MS` (30 s), never
  refused. Names under wildcard or dynamic DNS suffixes (sslip.io, duckdns.org) are shared-hosting
  tenants, each counted on its own hostname's day like any other; never pool them by the address
  they resolve to, since anyone can point such a name at another seller's address.
  `CRAWL_SLOW_ORIGINS` is by the clock: a slow origin's scheduled read sets a per-lane flag
  (`noteSlowRead`, x402 and mpp) in the shared store, merged at prefetch, and `slowWaiting` /
  `crawlPlan` skip "slow" until `SLOW_READ_INTERVAL_MS` has passed, so boots and extra cycles do not
  read it early; it applies to the MPP index too (`mppCrawlDue`). Counts on
  `/__operator/seller-load.json`; `?host=` gives the request log (per component and minute, two
  days: one counter per host, minute and component in a shared-store tally per host and hour, so
  a write never reads the host's history; a process holds a few minutes per host, at most 32
  entries). Tests: `scripts/test-seller-load.js`, `scripts/test-crawl-revisit.js`,
  `scripts/test-mpp-seller-load.js`.
- **Live price reads:** a paid route's 402 is read once, then after `LIVE_QUOTE_MAX_AGE_MS` /
  `NETWORKS_VERIFY_AGE_MS` (src/crawl-cadence.js, a week). A manifest price that fills an OpenAPI
  row keeps `originDeclaredPrice`, and a carried quote that confirms a snapshot price keeps its age,
  so a rebuilt row is not due every cycle. A route above every route-execute tier
  (`readThisWeekAboveRouterCaps`) is read weekly at most whatever else makes it due, except on a
  re-registration; the paywall probe asks the cheapest paid GET route
  (`scripts/test-quote-weekly.js`).
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
- **Our read is not the seller's answer:** a crawl read that failed on our side (our time limit, our
  resolver, our byte cap: `crawlReadFailureIsOurs` in `src/x402-index.js`) counts toward a path's
  backoff only once per `CRAWL_OURS_PER_STEP` (3) in a row; a connection the seller's host refused,
  reset or failed TLS on (`source-unreachable`) and a name that does not resolve are the seller's
  answer and count like any other. A failed
  crawl with such a read keeps an entry whose last completed crawl succeeded as it was, with
  `readIncomplete` beside it (`lastReadIncomplete` on `?seller=` and the index rows), while that crawl
  is under `INDEX_CRAWL_HOLD_HOURS` old (default 6), or whatever its age when at least half of the last
  cycle's crawls ended on our side (`oursShare` in the cycle summary); past that it reads unroutable
  with `errorKind: "our-read-incomplete"` (`scripts/test-crawl-read-incomplete.js`). A paywall probe
  that read no status, or a 400/415/422 to our bare request, is no verdict (`ok: null`, `unknown`), never
  a failure. A chain count we could not read is unknown, never 0: Algorand keeps the last completed count
  and re-reads the catalog in minutes; Solana throws `countUnknown` when unread transactions could reach
  the floor. The delivery memo counts one payer's same request (method, URL, body) once, and again at its
  3rd and 5th failure; the same request from another payer, or a call naming no payer, is its own strike.
  A 500 whose body names the request goes unstruck only when the chain proves the credential expired
  unused; whenever we may have paid (a receipt, a debit, a live credential, an unreadable chain or no
  chain read on the rail) it strikes, on every rail; a refusal note is never written for an accept this signer cannot make
  (Gateway rail, transfer-then-prove), a challenge differing only in the caller's query, or a refusal
  naming validBefore after our window cut the seller's; each note records its `kind` (`offer` or
  `paid-retry`) for the dossier.
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
- **Spending wallet trend:** `upstreamBuyer.trend` on `/api/gateway-status` reads `draining` after
  `UPSTREAM_BUYER_DROP_READS` (default 3) consecutive reads more than `UPSTREAM_BUYER_DROP_TOLERANCE_USD`
  (default 0.5) under the Base wallet's high-water mark (`src/upstream-buyer-status.js`). The mark,
  the count and the last acknowledgement are one state document (`upstream-buyer-trend`; without a
  state database the file `UPSTREAM_BUYER_TREND_FILE`, else process memory), so a restart neither
  forgets a drain nor reopens an explained one. An operator who withdrew sends
  `POST /__operator/upstream-buyer/acknowledge` (X-Operator-Token only): the mark is re-baselined to
  the current balance (or the next readable read), the next read is fresh and `ok`, and the
  heartbeat closes its issue; 503 when the store did not take it. Words only, never a figure
  (`scripts/test-buyer-balance-trend.js`).
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
  Its phrase rules are a mitigation; the primary defense is each prompt's own rule that seller
  text is quoted data, never instructions. A paraphrase the rules miss is expected: add it to
  `scripts/redteam-corpus.json` and extend the rule, rather than treat each one as a blocker.
- **Seller reputation:** `src/seller-reputation.js`. A leased hourly pass (`seller-reputation-pass`,
  `SELLER_REPUTATION_INTERVAL_MS`, first after `SELLER_REPUTATION_FIRST_MS`, waiting for the index to
  load) folds each indexed seller's newest crawl, paywall probe (its `ms`, the probe's answer time)
  and live-price reading into a per-day record in the state document `seller-reputation`
  (`SELLER_REPUTATION_FILE`; 30 days, at most `SELLER_REPUTATION_MAX_SELLERS`, 8000). The router's
  own purchases add delivery outcomes (`noteSellerDeliveryOutcome`: a settled 200 on the
  `memoizeDelivery` path, or a struck failure after the repeat rule), only for a request whose scope
  is not ours (`scope.isOurs`, set by the paid handler from `callIsOurs`), folded every minute into
  `seller-delivery-outcomes` (`SELLER_DELIVERY_FILE`, at most `SELLER_REPUTATION_MAX_DELIVERY_ORIGINS`,
  4000, and 64 routes each). It runs only where `crawlSwitch("X402_INDEX_CRAWL")` is on
  (`SELLER_REPUTATION=off` turns it off alone). Served on `/api/reputation?seller=` (a key lookup
  through two Maps rebuilt at most every 30 s, rows capped at 200 with the partial-answer fields),
  as `reputation` on `?seller=` and its rows, and on the chain page's seller card. A metric scores
  only past its minimum sample; no field is a payment, buyer or settlement count
  (`scripts/test-seller-reputation.js`). Method: `wiki/Seller-Reputation.md`. Correction path:
  `POST /api/reputation/recheck?seller=` (free; one accepted request per seller per
  `SELLER_REPUTATION_RECHECK_HOST_MS`, a repeat answers the one scheduled; per-caller limit
  across replicas) records the request in `seller-reputation-meta` (`SELLER_REPUTATION_META_FILE`);
  the crawl reads `pendingRecheckOrigins()` each cycle and `originsDueThisCycle`'s `prefer` gives
  the origin one of its operator's places (never an extra read; `crawlPlan` budgets still apply);
  the pass sets `rk`, served as `lastRecheckedAt`. A cycle whose `oursShare` reaches
  `CRAWL_OURS_SIDE_SHARE` calls `noteOurSideIssue`: that day's crawl, paywall and latency samples
  are left out of every seller's scores (`measurementIssue`, "measurement issue on our side").
  Reputation output and copy carry no judgment words (`scripts/test-reputation-wording.js`).
- **Seller docs link:** `src/seller-docs-url.js`. A tool row on `/api/index?seller=<host>` carries
  `sellerDocsUrl` when the seller's own OpenAPI operation names `externalDocs.url`, kept only as an
  https link on the seller's exact host (under its own path for a seller listed with a path) and
  dropped on a row the listing screen flags; the detail then carries `sellerDocsUrlLegend`. The index
  never fetches it, and it changes no price, quote, routing or payment. `?seller=` is its only surface.
