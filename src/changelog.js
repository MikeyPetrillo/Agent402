import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";
import { OFFER_SWEEP_FIRST_MS, OFFER_SWEEP_INTERVAL_MS } from "./mpp-subscription-retention.js";
import { READBACK_FIRST_MS, READBACK_INTERVAL_MS, READBACK_PENDING_INTERVAL_MS } from "./card-refund-readback.js";
import { DEFAULT_WITHHELD_USER_AGENT_PREFIXES, mppOfferGateEnabled } from "./mpp-offer-gate.js";
import { mppMethodsSummary } from "./mpp-offers.js";
import { mppSubscriptionsEnabled } from "./mpp-subscriptions.js";
import { walletSignInEnabled } from "./wallet-sign-in.js";
import { crawlIntervalLabel, slowOriginIntervalLabel, spanLabel as span, LIVE_QUOTE_MAX_AGE_MS } from "./crawl-cadence.js";
import { STT_TIERS, MAX_AUDIO_BYTES as STT_MAX_AUDIO_BYTES, TRANSCRIBE_LONG_RUN_SECONDS, sttLongEnabled, sttAdditions } from "./tools/stt-kit.js";
import { speechAdditions } from "./tools/llm-gateway-kit.js";
import { returningWalletEnabled, WALLET_HINT_HEADER, WALLET_PROOF_HEADER } from "./returning-wallet.js";
import { BOARD_REFRESH_MS } from "./refresh-cadence.js";
import { lifetimeMs as priceWebhookLifetimeMs, maxPerRegistrant as priceWebhookMaxPerRegistrant } from "./price-webhooks.js";
import { REVISIT_CAP_MS, DAILY_BUDGET, REGISTRATION_HOURLY_MAX, REGISTRATION_HOST_HOURLY_MAX, REGISTRATION_PACE_MS, THROTTLE_DEFAULT_MS, THROTTLE_MAX_MS, REQUEST_LOG_KEEP_MS, revisitIntervalMs, probeShareLabel } from "./seller-load.js";

// A timer figure as an entry prints it, read from the module that runs it.
const mins = (ms) => { const n = Math.round(ms / 60_000); return n === 1 ? "a minute" : `${n} minutes`; };

// The offer gate entry: shown while this server sends MPP challenges and the
// gate is on (src/mpp-offer-gate.js).
const mppOfferGateShown = () => mppMethodsSummary().enabled && mppOfferGateEnabled();

// The named audio model entries: shown while this server serves at least one
// such model on the route the entry is about (src/speech-additions.js: the
// NAMED_AUDIO_MODELS switch and the model's admission, read at call time).
export const namedSpeechShown = () => process.env.OPENROUTER_TTS_ENABLED === "true" && speechAdditions().length > 0;
export const namedTranscriptionShown = () => Object.keys(STT_TIERS).some((slug) => (slug !== "transcribe-long" || sttLongEnabled()) && sttAdditions(slug).length > 0);

// The price webhook figures an entry prints, as this server is set (src/price-webhooks.js).
const WEBHOOK_LIFETIME_DAYS = Math.round(priceWebhookLifetimeMs() / 86_400_000);
const WEBHOOK_PER_WALLET = priceWebhookMaxPerRegistrant();

// An entry with `shownWhen` describes something a switch sells: the page and
// the feed show it only while that function reads true (CHANGELOG.md scopes
// the same item to a server that sets the switch).
const ENTRIES = [
  {
    date: "2026-11-21",
    title: "A mid router tier, price webhooks and router benchmarks",
    items: [
      "Router: `route-execute-mid` (`POST /api/route/execute-mid`) is a new execution tier between `route-execute-plus` and `route-execute-max`: one flat price for a tool priced above the plus tier's cap and at or under its own. /api/pricing lists its price, and /api/route names the tier a tool needs in `executeVia`.",
      "Router: `GET /api/router-benchmarks` gives this server's measurements of outside sellers in aggregate: the share of the router's recorded purchases a seller answered 200 after payment, and the uptime, responsiveness and price-match scores of the sellers the router bought from beside the indexed sellers it did not buy from. No seller is named, and a statistic is published only when at least five sellers are scored on it.",
      `Tools: \`price-webhook\` (\`POST /api/price-webhook\`) registers an https URL that gets a signed POST when the list price of a tool it watches changes on this server; a delivery that is not answered 2xx is tried again with the same \`X-Agent402-Delivery\` id, so a receiver can drop a repeat. The answer carries the subscription's id, its secret and \`expiresAt\`; each delivery carries an \`X-Agent402-Signature\` header to check against that secret, a 410 from the receiver removes the subscription, and \`POST /api/price-webhook/unsubscribe\` removes it, free. A subscription lasts ${WEBHOOK_LIFETIME_DAYS} days, and registering the same URL again from the same wallet renews it with the same id and secret. One wallet holds up to ${WEBHOOK_PER_WALLET}, a registration is kept only when the call that made it settles (a call through route-execute or decide-execute included), and many subscriptions may name one receiving host. Each delivery attempt waits a few seconds for the receiver, so a receiver that does not answer does not hold up the others.`,
      "Surfaces: A tool priced per request can carry `fromInput` on `/api/pricing`: a small valid body that its 402 quotes at or under the list price.",
      "Operations: A server with no signing key (`PRICE_WEBHOOK_SIGNING_KEY`, else `POW_SECRET`) answers a price webhook registration 503 and stores nothing; `PRICE_WEBHOOK_DELIVERIES=off` holds deliveries while registrations and removals keep working. `PRICE_WEBHOOK_LIFETIME_DAYS` sets how long a subscription lasts and `PRICE_WEBHOOK_MAX_PER_PAYER` how many one wallet holds.",
      "Operations: `SOR_EVM_UNPROVEN_CHAINS` lists EVM chains other than Base on which the router tries a seller below the settlement floor, under one per-call ceiling (`SOR_EVM_UNPROVEN_MAX_USD`) and the per-seller and daily windows the Base tier uses. Unset, that tier stays on Base alone.",
      "Operations: The Bazaar keep-alive pays a route priced per request with its `fromInput` body, and never above the list price.",
      "Privacy: /privacy and the service manifest's data handling say what a price webhook registration keeps (the URL, the tools it watches and a keyed digest of the registrant) and for how long.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Checked coin prices, FRED terms and mailbox providers",
    items: [
      "Tools: `price-coingecko` rows carry `stale` and, in USD, `divergencePct` against a second source, and the answer's `check` names that source or says why no check ran, as `crypto-price` does.",
      "Tools: `exchange-rates` keeps its BTC-denominated answer (`perBtc`) and adds `rate`, the same cross per 1 `base` (default btc; `base=usd`, `eur`, `eth` or `xau` quotes another unit). A fiat row the European Central Bank publishes carries `referenceRate` and `divergencePct`, the market cross's gap to it in percent.",
      "Tools: coins-list joins the routes that are retired and answer 410; coins-list names coin-search as the replacement.",
      "Tools: Each tool that reads FRED puts a `terms` field in its answer, linking FRED's Terms of Use. `fred-series` answers a series that carries a copyright notice in its FRED notes with a 400 that quotes the name the notice gives, and `fred-release-observations` holds such series back in `withheld` and counts series it could not screen in time in `unscreened`.",
      "Tools: `email-validate` adds `mailboxProvider`: who hosts the domain's mail (`id`, `name`, `type`), read from the MX records it already looks up, and null when the domain has no MX.",
      "Tools: `asn-info` gives its owner-name lookup a 3 second limit of its own; when the name cannot be read, `owner` is null and `ownerUnavailable` is true.",
      "Tools: Input schemas, on `/openapi.json` too, carry `maxLength` on the string fields a tool caps by length, and `dns.type` and the `frequency` and `units` of `fred-series` publish the values they take as `enum`. A cap admits every form the tool accepts (`llm-context.lang`, an X username with its leading @, `fc-user-casts.username`), and `v1-videos.prompt`, `judge.state` and `decisions.input` publish theirs.",
      "Privacy: /privacy names the public resolvers an `asn-info` lookup can pass through when this server's own resolver cannot answer it.",
    ],
  },
  {
    date: "2026-11-21",
    title: "image-ocr turns, replay marks and Solana sales",
    items: [
      "Tools: `image-ocr` reads images in turn across callers, each within a set time. A caller's first image is read to the end even while others wait; a call that waits out its time in line answers 503 with a Retry-After and keeps its place for its retry; and an image that cannot be read in time answers 422 with a note to downscale it.",
      "Tools: A caller whose `image-ocr` call ended without an answer stands further back for its next one; that weight is kept on the wallet it paid with (a caller that names no wallet takes no extra weight), so other callers behind the same address keep their place.",
      "Tools: A freed audio decode slot goes to the waiting caller that holds the fewest places, first come among equals, and wallets paying from one address take their turn as one caller.",
      "Tools: When the `image-ocr` line or the audio decode queue is full, the caller that already has a call running or waiting there is the one answered busy, and a caller with none is still queued, up to a larger bound set by the memory the waiting calls may hold.",
      "Payments: A settled payment's replay mark is kept about an hour after the call, or until the authorization's own validBefore plus 10 minutes when that is later, however far out that is (it was at most 30 days after the call). /privacy and the dataHandling list on /.well-known/x402 state the hold.",
      "Payments: A Solana payment refused because its transaction's recent blockhash is no longer valid carries `reason: \"blockhash-expired\"`, whether that was read when the payment was checked or when it was settled, and its hint says to ask for a fresh 402 and build the transaction on a fresh blockhash.",
      "Payments: A Solana settlement is booked as one sale: the sales ledger keeps at most one sale for a settlement signature, and every count and sum of sales reads it once.",
      "Refunds: An answer that was charged and never delivered (the buyer left while it settled) is served when the same payment is sent again, and its debt is closed first. When the store does not confirm that close, the buyer is asked to retry, and a buyer who does not retry keeps the debt owed.",
      "Refunds: When that payment is sent again twice at once and one of the two is served, its debt stays closed whatever the other attempt's outcome.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Balance checks for calls in flight",
    items: [
      "Payments: On a deployment with more than one server, a wallet's call is admitted at once on its last balance read only when no other server has settled a payment of that wallet since; when one has, the balance is read again first and the calls that arrived together share that read.",
      "Payments: A Solana payment is counted against the balance of the token account it pays from. A wallet that pays from several token accounts at once is counted per account, each account covering its own calls in flight.",
      "Payments: A Solana payment that names its accounts through an address lookup table is counted against the largest single token account of the mint the wallet holds.",
      "Payments: A Solana wallet's calls in flight that name their token account and those that name it through a lookup table are counted together on every server of a deployment, since one account can back both.",
      "Operations: A balance read that is dropped before it is made gives a unit of the daily read budget back only when it took one, so the day's count matches the reads made.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Multisig Tempo payments and DNS names",
    items: [
      "Payments: A Tempo pull credential in a multisig envelope is counted against its account's balance, with no fixed number of calls at once, once a payment from that account under the same multisig config has settled here.",
      "Payments: Until then, and under any other config, calls paid that way run four at once per client address (`INFLIGHT_COVER_UNREAD_MAX` sets the number), whichever account each names; a call past that answers 429 with `Retry-After: 5` (`Retry-After: 30` on the report and media routes) and nothing is charged.",
      "Payments: Calls an account pays for with its own key, or with an access key Tempo confirms for it, are counted against that account's balance alone.",
      "Tools: The DNS, mail and certificate tools look up a name in one normalized form (lowercase, no trailing dots or surrounding spaces), and `dns` answers with that form in `name`.",
      "Tools: `dkim-lookup` answers a selector that makes no DNS name with the domain (an empty label, a label over 63 characters, a whole name over 253) with a 400 that names the field.",
    ],
  },
  {
    date: "2026-11-21",
    title: "The guide site, report links and the brand mark",
    items: [
      "Site: The site menu, the openings of /learn and /how-to-pay, /llms.txt and /llms-full.txt link ask402.ai, the maintainer's plain-language guide to x402 and MPP for people.",
      "Site: /what-is-x402, /what-is-mpp and /learn/x402 are titled for how each protocol runs on this server, and each links the guide's explainer for the general question.",
      "Site: `/reports?product=<id>&input=<value>` opens the storefront with that report selected and its field filled; nothing is submitted until the buyer presses the button.",
      "Site: /integrations/agentcore covers Amazon Bedrock AgentCore: catalog tools through an AgentCore Gateway target, payment through AgentCore Payments, and the buyer sample.",
      "Site: Social cards draw the brand mark from the logo file, and /logo.png, /logo.svg, the favicons and the nav mark serve the same art.",
      "Site: Vulnerability reports go to security@agent402.tools; support, billing, legal and abuse questions go to help@agent402.tools.",
      "Docs: The MPP examples list the tokens the evm method signs for (USDC on Base and on Celo), so they pay as written.",
      "Privacy: /privacy says what a card checkout keeps when the link that led to it names a listed site in `utm_source`: that name, with the sale, in Stripe's record of the checkout and in the sales ledger, and nothing in the browser.",
      `Surfaces: The seller leaderboards (Base, Solana and MPP) rebuild every ${BOARD_REFRESH_MS / 3_600_000} hours, each at its own fixed times an hour apart from the others, and a rebuild that is due waits while another runs. A rebuild held back by memory tries again every hour, and \`/api/gateway-status\` carries \`boardRefresh\`, whose \`status\` reads ok, held or stalled.`,
      "Operations: An issue a scheduled check opens carries a fixed title that names the check and a body that links the run; the reading that tripped it stays in the run log. A check whose issue body is its own saved state keeps that body.",
    ],
  },
  {
    date: "2026-11-21",
    title: "A lower price for a returning wallet",
    shownWhen: returningWalletEnabled,
    items: [
      `Payments: On a server that sets \`RETURNING_WALLET_PRICE=on\`, a buyer that names its wallet in the \`${WALLET_HINT_HEADER}\` request header, and proves it holds that wallet in \`${WALLET_PROOF_HEADER}\`, gets that call's 402 with the route's x402 \`exact\` offer on EVM chains at a lower price, once the wallet has paid on enough distinct days (\`RETURNING_WALLET_MIN_PAID_DAYS\` inside \`RETURNING_WALLET_WINDOW_DAYS\`; \`RETURNING_WALLET_DISCOUNT_BPS\` sets the discount). Every other offer, and every surface that publishes a price, stays at list.`,
      "Payments: The discount is taken from the route's list price; a chain's premium and price floor still apply, so a chain at its floor quotes the same amount, and the 402 names that chain instead of saying the discount was applied there.",
      "Payments: The proof is the wallet's EIP-191 signature over this server's host name, the route, the wallet and a time within five minutes of the server's clock; one proof serves the quote and its signed retry. A wallet named without a valid proof is quoted list, its history is not read, and the 402 says nothing about it.",
      "Payments: The lower price holds only for a payment signed by the named wallet: a payment of the lower amount from any other wallet is answered 402 with the list price, and nothing is charged.",
      "Payments: The ledger reads behind a quote are bounded per client address and across all callers; past a bound a wallet not read yet is quoted list, never refused, and a wallet already read keeps its price.",
      "Payments: Routes priced per request, metered and model-backed routes, and routes whose effect outlives the answer or that spend this server's own wallet are always quoted at list.",
      `Surfaces: With the switch on, /llms-full.txt states the rule, an eligible route's 402 body states the offer in \`returningWalletPrice\`, and its operation in /openapi.json lists the \`${WALLET_HINT_HEADER}\` and \`${WALLET_PROOF_HEADER}\` headers. agent402-client (given a \`walletSigner\`) and agent402-mcp (with \`AGENT_KEY\`) send both on a paid call.`,
      `Privacy: With the switch on, /privacy and the service manifest's data handling say what the \`${WALLET_HINT_HEADER}\` header is read for, that it is read only with a valid proof, and how long the named wallet and a used proof are held in memory.`,
    ],
  },
  {
    date: "2026-11-21",
    title: "Named speech models",
    shownWhen: namedSpeechShown,
    items: [
      "Gateway: On a server that lists them in `NAMED_AUDIO_MODELS`, more speech models (model-backed) can be named in `model` on `POST /v1/audio/speech`, each with its own voices and the default chain behind it as fallbacks, at the route's price and cap. `GET /v1/models` lists the ones the server serves, and a request that names any other model is a 400.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Named transcription models",
    shownWhen: namedTranscriptionShown,
    items: [
      "Tools: On a server that lists them in `NAMED_AUDIO_MODELS`, more transcription models (model-backed) can be named in `model` on the URL transcribe routes, at the tier's price and cap and not beside `diarize`. A tier's input schema lists the ones the server serves on it, the answer names the model that served it, and a request that names any other model is a 400.",
    ],
  },
  {
    date: "2026-11-21",
    title: "x402 by default for python-httpx clients",
    shownWhen: mppOfferGateShown,
    items: [
      `Payments: On a server that offers MPP, a client whose User-Agent starts with \`${DEFAULT_WITHHELD_USER_AGENT_PREFIXES[0]}\` gets a 402 that carries the x402 offer alone: the \`PAYMENT-REQUIRED\` header and the body are unchanged, with no \`WWW-Authenticate: Payment\` challenge, so it pays over x402 with no extra configuration.`,
      "Payments: Such a client gets the MPP challenges back, in the usual order, by sending `X-Payment-Offers: mpp` (or `all`), or an `Accept-Payment` header naming an MPP method such as `tempo/charge`. A request that carries an MPP credential is verified as before.",
      "Surfaces: The agent docs, /what-is-mpp, /x402-test, the guides and the MCP connector's payment note name this rule and the opt-in header while the server offers MPP.",
      "Operations: `MPP_OFFER_WITHHOLD_USER_AGENTS` sets the User-Agent prefixes (a comma list); `off` offers MPP to every client.",
      "Packages: The AgentCore buyer sample hands the payment service the x402 offer alone, and its Tempo probe sends `X-Payment-Offers: mpp`.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Tempo pull credentials and balance cover",
    items: [
      "Payments: A Tempo pull credential signed by an access key that Tempo does not confirm for the account it names now answers that the credential was validated, the transaction was not broadcast and nothing was charged.",
      "Payments: Access-key checks for Tempo pull credentials wait in arrival order; when the queue is full the call answers 503 with a Retry-After at once, and nothing is charged.",
      "Payments: The in-flight balance check counts a Tempo pull credential whose sender is not verified (a multisig account, for one) against the account it draws on, in a ledger kept apart from that account's verified calls.",
      "Payments: A wallet's paid calls are admitted at once on its last balance read while that read is under a minute old (was five minutes); `INFLIGHT_COVER_KEPT_AT_ONCE_MS` sets the window.",
      "Payments: Once this server's daily budget of balance reads is spent, reads are capped per minute across all wallets (`INFLIGHT_COVER_PAST_BUDGET_READS_PER_MIN`), and a call refused for its balance answers Retry-After with the seconds until its wallet is read again, at most 60.",
      "Payments: Solana payments from one wallet share one in-flight ledger whether the transfer names its accounts directly or through an address lookup table, and a delegate's transfer adds the source account's balance.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Card payments and card report refunds",
    items: [
      "Payments: A card payment that Stripe declines after the call ran answers that nothing was charged and asks for a fresh challenge; the same credential is not accepted again.",
      "Payments: A card capture that Stripe does not answer (a timeout, a connection error or a 5xx) is sent once more under the same idempotency key: a charge Stripe confirms is served as paid, with its receipt. When the outcome is still not known the 402 says the charge is not confirmed, the credential is spent, and the possible charge is recorded as owed (the `refundsOwed` word on `/api/gateway-status` reads owed) until it is refunded or shown not to exist.",
      `Payments: A card report refund that Stripe has accepted but not finished is marked pending, read again every ${mins(READBACK_PENDING_INTERVAL_MS)}, and leaves the owed list once it completes.`,
      "Surfaces: The `refundsOwed` word on `/api/gateway-status` carries `ledger` and `card` beside `status`; `card` reads none, pending, refused or unknown.",
      "Reports: The message at a card report's repeat-failure limit says no new attempt was made for the purchase, and ends with the refund's outcome once.",
      "Reports: Publishing a report mints one public link, even when it is published from two places at once.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Router matches and seller records",
    items: [
      "Router: The router buys only from an outside seller whose listing matches enough of the task's words. When none is left, the answer is a 404 that says the sellers matched too few of the task's words and nothing was spent.",
      "Router: Filler words (the, a, an, for, tool, tools, api, apis) no longer count toward a match.",
      "Router: A pause under one of this server's own spend ceilings names its rule: `reason` reads `routing_paused`, `rule` names the ceiling, `attribution` reads `ours`, with a hint, a next step and `retryAfterSeconds`. This covers route-execute, the flight routes, seller-payability and attest.",
      "Index: A paywall check on a seller record that did not read a 402 carries a fixed `reason` code (answered_free, auth_required, redirected, client_error, server_error, probe_malformed, probe_incomplete) and its sentence on `/api/index?seller=`, and the seller dossier names it.",
      "Index: A seller's x402 manifest can set a top-level `revisitAfterSeconds`: each crawl read then waits at least that long, up to the crawler's cap. It only lengthens the wait; /crawler documents it.",
      "Tools: `dns` is served like the other network tools, with the same route, price and example; its lookup ends at a run's time limit.",
    ],
  },
  {
    date: "2026-11-21",
    title: "FDA, CVE, X and wallet data",
    items: [
      "Tools: `drug-shortages` searches the FDA drug shortage list by drug name, therapeutic category or status.",
      "Tools: `drug-orange-book` reads FDA Orange Book products with patents, exclusivity codes and therapeutic equivalence codes, by name, active ingredient or application number.",
      "Tools: `cve-lookup` adds CISA's SSVC decision points with the Track, Track*, Attend or Act decision for a given `missionImpact` (each level without one), and says whether NVD or only the CNA scored the record.",
      "Tools: `x-post-counts` counts posts on X matching a query by day, hour or minute over the last 7 days; `x-trends` reads X's trending topics for a location.",
      "Tools: `wallet-transfers-multichain` reads a wallet's transfers on up to 5 EVM networks in one call, with each network's state in the answer.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Weather answers cached",
    items: [
      "Tools: Current, forecast, historical, plan and probability weather answers are kept for up to an hour, and each listing says for how long; `OPEN_METEO_READ_CACHE=off` reads every request upstream.",
      "Tools: The daily, hourly, historical and probability weather listings lead with the words a buyer searches for.",
      "Surfaces: The `openMeteo` word on `/api/gateway-status` reads `refused` while any Open-Meteo API's last keyed read was refused, so a key that covers some of them and not others shows.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Wallet subscriptions for monitors",
    shownWhen: mppSubscriptionsEnabled,
    items: [
      "Site: On a server with MPP subscriptions on, /monitors shows how to subscribe with a wallet over MPP beside the card checkout.",
      "Payments: A retried subscribe that is handed its subscription no longer also leaves its first payment owed as a refund.",
      "Operations: On a file-backed store, the sweep of unpaid subscription offers gives other requests a turn as it runs.",
    ],
  },
  {
    date: "2026-11-21",
    title: "Wallet sign-in",
    shownWhen: walletSignInEnabled,
    items: [
      "Payments: On a server with wallet sign-in on, each caller and each network holds a bounded number of pending sign-ins; a full bound expires the oldest.",
    ],
  },
  {
    date: "2026-11-21",
    title: "agent402-client 0.10.1 and site analytics",
    items: [
      "Packages: agent402-client 0.10.1: with the `x402Client` passed, a paid request whose connection failed before any answer is resent once with the payment already signed, so it settles at most once (`retryResets: false` turns it off).",
      "Packages: The AgentKit example pins agent402-client 0.10.0.",
      "Site: Automated browsers are tagged as internal traffic in the site's analytics; the page still loads its tag.",
    ],
  },
  {
    date: "2026-11-20",
    title: "First paid request after a restart",
    items: [
      "Payments: The first paid request after a restart is answered at once, even when a fallback settlement service is slow to answer (the first service listed for a network is still waited for); that service rejoins the offer as soon as it answers.",
    ],
  },
  {
    date: "2026-11-20",
    title: "ASN lookups ride out a failing resolver",
    items: [
      "Tools: asn-info reads Team Cymru's DNS zone. When the host's own resolver fails on that zone (a resolver error such as a SERVFAIL or a timeout), the lookup is retried once through public resolvers; a name with no record is still answered at once.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Where errorCode rides",
    items: [
      "Wholesale: Every error answer a tool's route writes, other than a 402, carries `errorCode` beside the message: an input refused before payment, a body the server cannot read (400) or that is over its size limit (413), a run that ended in an error, a retired route (410), a paused or switched-off tool (503), and a tool whose route is not served on this server, which answers 404 as any unknown path under /api does. A 402 is the payment-required answer: it follows the x402 and MPP wire formats and carries no `errorCode`. Its `payment_required` row stays in the contract's code table with the new field `carried: false`; every other row reads `carried: true`.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Retired model ids leave the model list",
    items: [
      "Gateway: `meta-llama/llama-3.2-1b-instruct` and `meta-llama/llama-3.2-3b-instruct` reached their upstream expiration and are no longer listed on the nano tier or `GET /v1/models`. A call naming either is served by `mistralai/ministral-3b-2512` at the tier and price of the route called, the swap named in `agent402_model_substituted`.",
      "Gateway: From a model's retirement date `GET /v1/models` lists its successor in its place (or leaves it out on a tier that does not serve the successor), so every id it prints is served as itself.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Settled answers and interrupted runs",
    items: [
      "Payments: A buyer who leaves while a payment is still settling no longer spends hang-up forgiveness when the charge went through; the charge is booked as owed and repaid.",
      "Payments: A task or job interrupted by a restart now checks whether its payment settled: when a sale tied to that run is on the books, the task says so, names the transaction, and the charge is booked for repayment; when the sale cannot be tied to the run, the task makes neither claim and names the free refund lookup.",
      "Payments: When the shared payment store is briefly unavailable, paid routes now ask for a retry after 5 seconds instead of 30.",
      "Payments: A paid call answered with any success status now uses up its payment authorization, so it cannot run a second time.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Refund pipeline",
    items: [
      "Payments: A refund run reads each payment's receipt from a configured source first and reads an empty answer again before it tries the next, so an older Celo debt can be proven and repaid instead of held.",
      "Payments: Two failed paid calls by one wallet on one route in the same minute are recorded as two refunds owed.",
      "Payments: A refund run can be narrowed to named rows, and stops starting new refunds before its time limit, so no refund is cut off halfway.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Legal claims, receipts and llms.txt",
    items: [
      "Site: /trust says when payer sanctions screening is in force. While no list is loaded, Tempo direct settlement is not offered and the other screens serve payments unscreened. The `sanctionsScreen` word on `/api/gateway-status` says which case holds.",
      "Surfaces: The audit report lists the wallet's own repayments in a refunds block (owed and repaid, with the repayment transaction). They are never netted from the totals.",
      "Site: The privacy policy names the signed receipt kept with a delivered card report, the receipts of a monitor's most recent paid periods, and the MPP evm and Tempo relay payer screens.",
      "Site: The README and /trust say a signed receipt covers the direct routes. A tool bought through a referral link carries none, and a stream carries its receipt as a final event-stream comment line or a trailer.",
      "Surfaces: /llms.txt names each machine surface in one clause and points at /llms-full.txt for every line in full.",
      "Site: The refund terms say a disconnect past the hang-up budget is reviewed before it is repaid, and a credits debit is re-credited to its key.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Crypto answers you can check",
    items: [
      "Tools: `crypto-price` now checks each USD price against a second source, Hyperliquid's oracle price, and adds `divergencePct`, a `stale` flag per coin and a `check` field naming the source.",
      "Tools: `crypto-market` adds turnover and distance below the all-time high, and works as a screener over the top 250 coins (market cap, volume, turnover, 24h change band, distance from the high, sort) with `matched` and `truncated` fields.",
      "Tools: `crypto-history`, `coin-market-chart-range` and `coin-ohlc` lead with the window's return, annualized volatility and max drawdown.",
      "Tools: `rwa-markets` and `rwa-asset` show tokenized gold and silver against the spot price, as a premium in basis points.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Onchain-sql answers and pacing",
    items: [
      "Tools: `onchain-sql`: two calls sent close together are no longer spaced apart; the query service still receives at most two queries a second.",
      "Tools: `onchain-sql`: when every query place is busy, a call waits up to about 3 seconds for one instead of being refused at once; a busy refusal asks for a retry in 4 to 6 seconds.",
      "Tools: `onchain-sql`: a query the service cuts off at its time limit answers 422 with hint `timed-out`, a 502 that returns at once says to retry, and narrow-query answers carry `charged: false` and `upstreamMs`.",
      "Tools: `onchain-sql`: an answer larger than 16 MB is answered 502 and not charged.",
      "Tools: `onchain-sql` and `onchain-sql-schema`: a call paid on Solana finishes within 40 seconds, inside the payment's valid life.",
    ],
  },
  {
    date: "2026-11-20",
    title: "agent402-mcp 0.14.1 and the CI catalog sweep",
    items: [
      "Packages: agent402-mcp 0.14.1 is a version-only release, so the MCP Registry entry carries the current title; each publish now marks every older registry version deprecated, so the registry lists one current version.",
      "Operations: CI's catalog sweep reads CoinGecko and Open-Meteo under a per-run CoinGecko read cap, and a run that spends the cap or meets a rate limit fails.",
    ],
  },
  {
    date: "2026-11-20",
    title: "Long recordings transcription",
    shownWhen: sttLongEnabled,
    items: [
      `Tools: A server that sets \`TRANSCRIBE_LONG=on\` lists and serves \`/api/transcribe-long\` (model-backed), the long-recording transcription tier: an audio file at a URL, up to ${STT_TIERS["transcribe-long"].maxMinutes} minutes and ${Math.round(STT_MAX_AUDIO_BYTES / 1024 / 1024)} MB, answered like the other tiers (\`diarize: true\` adds speaker labels and word timestamps). It runs up to ${TRANSCRIBE_LONG_RUN_SECONDS} seconds on a long file, so it is paid on the EVM \`exact\` rails only, and \`Prefer: respond-async\` returns a job link at once. Without the switch the route is not listed or served.`,
    ],
  },
  {
    date: "2026-11-20",
    title: "Solana activity charts across restarts, call budgets across deploys",
    items: [
      "Site: A Solana chain page's 30-day activity chart keeps its history across restarts, and a wallet too busy for one scan continues from where the last scan stopped until its window is covered. When the newest payments could not be read, the panel prints when they were last read in full (`as of <time> UTC`).",
      "Operations: The Solana activity scans and the Solana leaderboard read transaction history through the public RPC lane first and queue for it. The keyed lane serves those background reads only up to a daily share of its ceiling (`SOLANA_HISTORY_BACKGROUND_KEYED_DAILY_MAX`); past it the views serve what they hold with its age. `SOLANA_ACTIVITY_STORE=off` keeps scan state in memory only.",
      "Operations: The `upstreamBudgets` word on `/api/gateway-status` is built from the UTC day's call count across deploys and replicas when a shared store is configured. The operator view adds which module made the day's calls to the on-chain data provider and seven days of daily counts.",
    ],
  },
  {
    date: "2026-11-19",
    title: "Onchain query answers that cannot be read",
    items: [
      "Tools: `onchain-sql` and `onchain-sql-schema` answer 502, uncharged, when the query service's answer arrives cut off, empty or not JSON; before, such an answer was served as a result with no rows or an empty schema. A query that matches no rows still answers 200 with no rows.",
    ],
  },
  {
    date: "2026-11-19",
    title: "Answer size of the audio and PDF tools",
    items: [
      "Tools: `audio-convert` and `audio-normalize` answer an MP3 of up to 60 MB (43 minutes at 192k). A recording that would encode larger is answered 413 before it is encoded, with the limit and the length that fits, and is not charged; a lower `bitrate` fits a longer one. The PDF tools (`pdf-merge`, `pdf-extract-pages`, `pdf-rotate`, `images-to-pdf`) answer a file of up to 40 MB, and 413 past it.",
    ],
  },
  {
    date: "2026-11-19",
    title: "agent402-client 0.10.0: a default per-call ceiling",
    items: [
      "Packages: agent402-client 0.10.0 holds a $5 per-call ceiling by default (`maxPerCallUsd`), above every catalog price, so a 402 that asks for far more is refused before anything is signed. `0`, `\"off\"` or `null` turns it off; a malformed value keeps the default and prints a warning; a refusal names `maxPerCallUsd` and the per-call `maxUsd` option. The rolling caps stay opt-in.",
    ],
  },
  {
    date: "2026-11-19",
    title: "Solana fresh quote after a refusal, render without a browser",
    items: [
      "Payments: A Solana payment its facilitator refused before broadcasting it (a verify refusal, or a settle refusal that names no transaction) is answered 402 with `requote: true` and words that say to request the route again without a payment header: that fresh 402 names another facilitator's fee payer when one is available, and otherwise the same quote as before. Nothing was charged.",
      "Tools: render reads a page's served HTML without starting the browser when that HTML already carries the page's content, and answers `rendered: false`; a page that needs JavaScript (an app shell, little text, hydrated components, a refused fetch) is rendered in headless Chromium as before and answers `rendered: true`.",
    ],
  },
  {
    date: "2026-11-19",
    title: "Robinhood Chain price",
    items: [
      "Payments: Robinhood Chain (`eip155:4663`) no longer carries a price floor by default. A server that leaves `ROBINHOOD_MIN_PRICE_USD` unset quotes every call there at its list price, like every other chain. A server that sets it keeps that floor, and `/api/pricing` `payment.minPriceUsdByNetwork`, llms.txt and the guides state the floor only when it is set.",
      "Payments: The optional own settler on Robinhood Chain (`ROBINHOOD_RELAYER_KEY`) settles a sale only when its price is at least `ROBINHOOD_RELAYER_MIN_PRICE_USD` (default 0.004). Under it, a refusal from the listed facilitators is answered as a 402 and the x402 payment is not settled.",
    ],
  },
  {
    date: "2026-11-19",
    title: "Lower prices on 40 tools",
    items: [
      "Pricing: Lower prices on 40 tools, among them extract, render, screenshot, pdf, image OCR, whois, DNS lookup, FX rates, FRED series, the Treasury yield curve, EDGAR filings, company financials and the crypto market tools. Every skill pack that runs one of them is repriced by the pack rule, and each listing, 402 answer and the OpenAPI document quote the new prices.",
    ],
  },
  {
    date: "2026-11-19",
    title: "Reputation corrections, transcript language, gateway models",
    items: [
      "Seller index: A seller's reputation record reads the price metric as `priceMatchesListing` (\"price matches listing\"): the share of routes whose live 402 price matches the price the seller's own documents list. `POST /api/reputation/recheck?seller=<host>` asks for a fresh measurement: free, one accepted request per seller every 6 hours (a repeat answers the one already scheduled), limited per caller; the crawl reads the seller on its next cycle inside its operator's crawl budget, and the answer is 202 with `crawlBy` and `recordBy`. The record shows `lastRecheckedAt`, and a day on which our own crawl cycle failed broadly on our side is left out of the crawl and paywall metrics and named under `measurementIssue` (\"measurement issue on our side\"). The method page names the correction contact.",
      "Tools: Transcription answers carry `language` on every tier: the language the model reports, else the caller's `language` hint, else the transcript's language read from its words, else null.",
      "Gateway: The pro tier serves openai/gpt-6.2-sol and gpt-6.2-sol-pro, google/gemini-4-carbon and gemini-4-neon; the premium tier serves openai/gpt-6.2-astra and gpt-6.2-astra-pro in place of gpt-6-astra, and a call naming gpt-6-astra or gpt-6-astra-pro is served by its 6.2 twin; the base tier serves google/gemini-4-hydrogen and lists qwen/qwen4-max by name. Each is on the metered tier too.",
      "Site: The \"Watch a call get paid\" figure lays every step out in one row from 1024 px wide, and stacks them on phones.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Bundle products and wholesale tool data",
    items: [
      "Tools: Three bundle tools each run many catalog tools in one call and return one computed report: weather-risk-brief, a 7-day weather risk read for up to 50 sites (forecast, threshold hits, air quality, the same dates a year earlier and the chance of heavy rain), scored and ranked; filings-brief, the SEC picture of up to 40 US public companies (latest annual and quarterly financials with ratios, filing activity and Form 4 activity), flagged and ranked; and token-diligence, market diligence for up to 20 coins (profile and supply, one-year return, drawdown and volatility, turnover and dilution), flagged and ranked. Each is priced per site, company or coin by the skill-pack rule over the tools it runs, and the 402 quotes the amount for the units in the body. A ticker or coin the source does not know answers 422 naming it. No model writes any part of a report.",
      "Wholesale: `/wholesale` and `GET /api/wholesale/v1` give a reseller one versioned JSON read per tool family (computation tools; SEC filings and company financials; US Treasury rates and debt; weather forecasts, history, air quality and risk), and `GET /api/wholesale/v1/<family>` lists a family's tools: each tool's price, which is the public route's own price with no wholesale discount, the credit to keep with its answers, and its success rate and p50 and p95 latency over the last seven days, marked measured or not enough data. Only sources whose answers may be passed on are listed; market data, search results and model output are not offered. Within v1, fields are only added.",
      "Wholesale: Every tool error answer carries `errorCode` beside the message: one stable code per status (such as `invalid_input`, `upstream_error` and `unavailable`), listed with its meaning in the wholesale contract. A code is only ever added, never renamed or removed.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Yield age limit, MCP cut-offs, unknown coin ids",
    items: [
      "Tools: The Treasury yield tools (`treasury-yield-curve`, `treasury-yield-history`, `yield-curve-spread`) answer 503 with Retry-After, uncharged, when the last good read of the yield file is more than three days old, instead of serving older yields marked stale.",
      "MCP: A paid call on the hosted MCP connector whose settled answer the connector stopped waiting for is booked as owed in the refund ledger, as its cut-off text says, also when the answer was written just as the connector's wait ended. A resend of the same payment with the same idempotency key is served the stored answer and that booking is voided first, so the call is never both served and owed.",
      "Tools: A CoinGecko id the upstream called unknown is answered 422 with no upstream read for the rest of the UTC day unless its list names it, and one address's calls naming unknown ids take at most 8 of the day's reads an hour before their ids are checked against their lists; a real id is always read.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Refund terms, per-tool reliability and payer screening per rail",
    items: [
      "Payments: `/.well-known/agent402-refund-terms.json` states per payment rail whether an error answer is charged, whether a hang-up is forgiven and how a charged failure is repaid, with the rules of the refund ledger, prepaid credits and card reports, computed from the serving code and its switches. Every 402 body's `payment` block and `/api/pricing` link it.",
      "Payments: An MPP Tempo payment settled through Tempo's relay now has its paying wallet screened against the OFAC SDN list before the relay is asked; a payer that is not listed is served as before. Each rail's `sanctionsScreening` cell in the conformance document names the `identifier` its screen reads, and says so where a rail carries no payer address.",
      "Reliability: `/api/reliability/tools` lists every tool with its success rate and median and 95th percentile latency over the last seven days, each marked measured or not enough data; a tool with too few calls in the window has no figure, and an input the caller got wrong is not counted against the tool. `?slug=` returns one tool.",
      "Docs: A proposal for the receipt format and the refund terms document, with this server as the working implementation, is in the repository's docs folder.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Seller reputation",
    items: [
      "Seller index: `GET /api/reputation?seller=<host>` publishes one outside seller's reputation as this server measured it over a rolling 30-day window: manifest uptime, 402 uptime, responsiveness, price matches listing (the live 402 price against the listed price) and delivery (measured from purchases Agent402's router made for buyers), with age. Each metric names its method, sample size and last measurement and is scored only past its minimum sample. No metric counts payments or buyers.",
      "Seller index: `/api/index?seller=` carries the same record as `reputation` and a compact `reputation` on each route row; a seller's card on a chain page shows it in one line.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Audit report",
    items: [
      "Tools: `POST /api/audit-report` returns the paying wallet's paid history over a window of up to a year: each call's time, tool and route, amount, rail, network, settlement, request and response digests and its signed receipt, with totals by tool and by day, as JSON or a CSV file, a page at a time. The report carries a summary receipt over itself that `POST /api/receipts/verify` checks. Keyed to the wallet that pays for the call; EVM x402 only.",
      "Privacy: A signed receipt issued for a call paid from an EVM wallet or over Tempo is kept for the paying wallet's audit report and deleted 400 days after it was issued.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Onchain query capacity",
    items: [
      "Tools: onchain-sql runs up to 8 queries at once on a server (was 2), and every query the server sends to the query service is spaced to stay under that service's rate limit (for up to four replicas at the default spacing). A query past either limit is refused 429 with Retry-After, before any payment is settled.",
      "Status: onchainSqlBusy on /api/gateway-status reads alert when a top paying buyer gets that refusal, from either limit.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Holiday, business-day and market calendars",
    items: [
      "Tools: public-holidays reads the v4 holiday dataset: each holiday adds `calendarDate`, `nationalHoliday`, `subdivisionCodes` and `holidayTypes` (Public, Bank, School, Authorities, Optional, Observance), and the call takes optional `subdivision` and `types` filters. Every existing field keeps its meaning: `date` is still the observed date. Until 2027-01-31 `date` and `localName` come from the earlier source and years outside the v4 window are answered from it; from 2027-02-01 `date` follows the published observance rule where a country has one (US federal, UK substitute days, Japan substitute holidays), `localName` is null, and those years answer 400.",
      "Tools: New holiday tools: bank-holidays, school-holidays, next-holidays (upcoming holidays with days until each), long-weekends (runs of three or more days off with bridge days), country-business-days (check a date, add or subtract business days, count between dates, by country or region, with the US federal, UK substitute-day and Japan substitute-holiday rules applied) and business-day-planner (the first dates that are business days in every listed country or region).",
      "Tools: settlement-calendar: the settlement date for a payment sent on a given date over ACH, Fedwire, SEPA Credit Transfer, SEPA Instant or CHAPS, from each rail's published operating days and bank holidays, with the rule and its official sources in the answer.",
      "Tools: market-calendar: whether NYSE, the London Stock Exchange, Xetra, JPX or HKEX is open at a given moment, the day's sessions, the next open and close, and closures in the coming month, from each exchange's own published calendar. It is pure computation and free through proof of work.",
      "Tools: gtin-validate: checks the GS1 check digit of a GTIN-8, UPC-A, EAN-13 or GTIN-14 barcode number and returns the expected digit and the 14-digit form. It is pure computation and free through proof of work.",
      "Credits: Holiday data by Nager.Date, used under a sponsorship held for this service; every tool that serves it carries the credit.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Site motion and charts",
    items: [
      "Site: Home, /101 and every tool page show one paid call step by step: the request, the 402 with the tool's price, the signature, the settlement, the answer and, while the server signs them, the signed receipt, with the 24-hour median latency and the count of settled outside payments read from /api/stats. It holds still under reduced motion.",
      "Site: /scorecard charts outside paying wallets per month, returning and new; /proof charts each settlement as a share of its quoted ceiling; /leaderboard charts the top ten sellers by USDC settled.",
      "Site: Motion follows the DESIGN.md tokens: interface moves take 200 to 400 ms, an exit takes 70% of its entrance, and every page goes still under reduced motion.",
      "Live view: A walker near the pointer lifts toward it, the gate under the pointer brightens, and each settlement sends a ring out of its gate.",
      "Docs: The READMEs and the wiki show a paid call as an animated image and the architecture as a diagram.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Prediction-market tools not offered",
    items: [
      "Tools: The prediction-market tools are not offered for now: kalshi-markets, kalshi-event, kalshi-live-data and kalshi-weather-index. Their routes answer 503 with no payment asked, and the catalog, /api/pricing, /openapi.json, llms.txt, the MCP tool lists and the sitemap do not list them. The retired Polymarket routes answer 410 with no replacement named.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Signed receipts on every paid call",
    items: [
      "Payments: A streamed paid answer ends with a `: agent402-receipt <receipt>` server-sent comment line, which event-stream parsers skip, carrying the signed receipt over every byte streamed before it, and also carries it as an `Agent402-Receipt` trailer when the client sends `TE: trailers`.",
      "Payments: A call paid with a prepaid credits key is debited before its answer ends and carries a signed receipt naming the key's id (never the key) and the debit's id, which the key's history records.",
      "Payments: A report bought at card checkout carries a signed receipt over the checkout, the amount collected, the payment intent and the report's text, shown on the report page and in the delivery email and checked at `POST /api/receipts/verify`.",
      "MCP: A paid tool result on the hosted MCP connector carries the route's signed receipt in `_meta[\"tools.agent402/receipt\"]`, and a finished async job keeps it in its result's headers.",
      "Site: The lead line reads: Agent402 is the payment and trust layer for agent commerce: agents find, pay for and verify every paid call, across x402 and MPP, with a signed receipt for each one. A server with no signing key keeps the line without the receipt clause.",
      "Packages: agent402-client exports `verifyStreamedReceipt` and `splitStreamedReceipt`, which check the receipt line that ends a streamed answer against the bytes streamed before it.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Stock data tools not offered",
    items: [
      "Tools: stock-quote and stock-history are not offered for now, and neither are the skill packs built on them: options-analytics, price-monitor and financial-analysis. Their routes answer 503 with no payment asked, and the catalog, /api/pricing, /openapi.json, llms.txt, the MCP tool lists and the sitemap do not list them.",
      "Skill packs: earnings-deep-dive, financial-research, company-dossier, earnings-watch, insider-alert, trend-analysis and forecasting-bake-off run without their stock step, each priced by the pack rule over the tools it keeps; trend-analysis and forecasting-bake-off take a FRED series id.",
      "Reports: The company dossier is built from SEC filings, Form 4 insider filings and web research, with no quote step.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Signed receipts",
    items: [
      "Payments: A server run with a receipt signing key (`RECEIPT_SIGNING_KEY`) sends an `Agent402-Receipt` header on each settled paid answer that is not streamed: a compact JWS (EdDSA, Ed25519) over the route, the request digest, the sha256 of the answer, the price, the rail, the network, the payer and the settlement. The public keys are published at `/.well-known/agent402-receipt-key.json`, and `POST /api/receipts/verify` checks a receipt for free. The `signedReceipt` cell of each conformance row reads true only while the server signs.",
      "Packages: agent402-client exports `verifyReceipt`, which checks an `Agent402-Receipt` against the published keys and, when given them, against the answer bytes and the request sent.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Payment and trust layer lead",
    items: [
      "Site: The home page, /llms.txt, /openapi.json, /press and the hosted MCP connector's description, instructions and server.describe lead with one line: Agent402 is the payment and trust layer for agent commerce: agents find, pay for and verify paid calls across x402 and MPP, backed by signed receipts. The signed receipt clause appears only while the server signs receipts. The catalog's size follows as a supporting line, 500+ ready tools on the same rails. The home title, description and social card, /company and the site's structured data follow it.",
      "Packages: The README, the agent402-mcp, agent402-client, agent402-tollbooth and agent402-openclaw READMEs, the package descriptions and the MCP Registry entry carry the same line, with the catalog's size after it.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Ownership statement",
    items: [
      "Repository: NOTICE, the README, CONTRIBUTING.md and /llms-full.txt state that Cardhavok LLC (doing business as Havok Holdings LLC) owns the code in this repository except a small number of trivial lines (seed URLs, a badge line, punctuation) contributed earlier under AGPL-3.0 or MIT, whose authors keep their copyright, and that the contributor license agreement covers new and earlier contributions. The README's receipts section describes the signed receipt header a server sends when a receipt signing key is set.",
    ],
  },
  {
    date: "2026-11-18",
    title: "Copyright agent, cancel paths, fetched-host counts and seller docs links",
    items: [
      "Site: /terms names the copyright agent for notices about material on the site, with the steps for a notice and for a counter-notice, and says how each subscription rail cancels: the portal link for a card subscription, a POST to the cancel link in the monitor emails or revoking the authorization for an MPP subscription. A canceled subscription stays active until the end of the period already paid for.",
      "Site: /privacy says that when a tool fetches a URL you name, the host name in it (never the path, the query or who asked) is counted per minute, so a site that asks how often it was called can be answered; the counts are deleted after two days.",
      "Site: While prepaid credits are on sale, each purchase is a new key holding at most the largest pack (`CREDITS_BALANCE_MAX_USD`), and `POST /api/credits/refund` with the key refunds its unspent balance to the card and disables the key. With sales off, neither is offered.",
      "Seller index: A seller's rows on `/api/index?seller=` carry `sellerDocsUrl` when the seller's own OpenAPI operation names one (`externalDocs.url`): an unverified https link on the seller's exact host, never fetched, that changes no price, quote, routing or payment.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Verify a paid call",
    items: [
      "Site: The /trust page opens with a walkthrough for checking one paid call end to end: the receipt header and its fields, the settlement on chain, the response digest and its attestation, and the conformance cell for the rail paid on. The home page links to it from the hero, and the README and /llms-full.txt carry the same steps.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Internal code changes, stricter reading of payment fields",
    items: [
      "Internal: Internal code changes; malformed seller payment fields and an explicit `cache: null` are handled more strictly. In the seller index, an empty payTo is no address, an amount that is not whole base units gives way to maxAmountRequired, a catalog entry whose network is not text names no chain, and hex addresses match whatever the case of their 0x prefix. In the buyer client, `cache: null` on a call is a fresh purchase, as `cache: false` is, and a paid answer refused on delivery is reported as that refusal.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Ownership, contributor agreement and third-party notices",
    items: [
      "Repository: Outside pull requests carry a DCO sign-off whose email is each commit's author email, and everyone whose commits are in the pull request agrees to the new contributor license agreement (CLA.md, v1.0) by its versioned sentence: the author in the description or an own comment, every other commit author in an own comment. The check runs the base branch's scripts, re-runs on a comment, and names the missing record and how to add it. The owner's pull requests and bot updates are unchanged.",
      "Repository: NOTICE records who holds the copyright (the company for the code it wrote, each outside contributor for their own contributions), how outside contributions and AI-assisted development are covered, and points to THIRD_PARTY_NOTICES.txt, the packages each shipped artifact installs with their licenses, regenerated from the lockfiles and the tracked package manifests by scripts/gen-third-party-notices.js, which refuses a shipped package whose license is not permissive unless it is listed with a reason. The README, CONTRIBUTING.md and /llms-full.txt carry the copyright and licensing summary.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Press kit, MCP server card and one profile list",
    items: [
      "Site: /press is a press kit: how to write the name, the logo and social card files, the operating company and the press contact. /about answers at /company, the entity page.",
      "Site: Structured data on every page lists one set of our profiles for the site and the company (the repository, X, the npm and PyPI packages and the MCP Registry entry) and says what Agent402.Tools is.",
      "Site: The home page description says what a card buys: reports and monitors while prepaid credits are not on sale.",
      "Surfaces: The MCP connector publishes a server card at /mcp/server-card, also at /.well-known/mcp/server-card.json: the name, version, title and streamable HTTP endpoint that /mcp reports, with the tool count.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Seller removal says how a seller returns",
    items: [
      "Operations: Removing a seller from the index can be previewed with a dry run (dryRun: true) that names what the index holds for it and where it is known from, and the removal and its restore say how the seller returns: one listed in a registry or seeded by the operator comes back by itself on the next read and crawl, one only its owner submitted comes back when the owner registers again.",
    ],
  },
  {
    date: "2026-11-17",
    title: "A conformance document for every payment rail",
    items: [
      "Payments: /.well-known/agent402-conformance.json lists each payment rail this server accepts (x402 exact and upto per network, Circle Gateway batched, MPP evm, Tempo pull and push, card over MPP, prepaid credits, card checkout, proof of work) and, for each, whether it settles after a successful answer, honors an Idempotency-Key and the x402 payment-identifier, guards against a replayed credential, repays a charged failure and how, forgives a hang-up, screens the payer and returns a receipt. Each cell is computed at request time from the serving code and its switches. /trust and llms.txt link it.",
      "Payments: The same document carries the refund terms as data (refundTerms): each clause is the sentence /terms prints, read from one source. /terms, dated 2026-11-17, points to it and states that the terms govern where the two differ.",
    ],
  },
  {
    date: "2026-11-17",
    title: "The MCP connector serves protocol revision 2026-07-28",
    items: [
      "Surfaces: /mcp serves MCP revision 2026-07-28 (the per-request envelope and server/discover, with no initialize) beside the 2025 revisions on the same URL. A valid request on an older revision is answered as before, and tools, payments over x402 and MPP, tasks and skills answer the same on both revisions.",
      "Surfaces: A malformed request now gets a clearer refusal: an empty batch is a 400 with -32600, a body with no jsonrpc member is -32600 with its id, a tools/call with no params or with arguments that are not an object is -32602 naming the problem, and an MCP-Protocol-Version header naming an unknown version on a request with no envelope is -32602 naming the missing envelope.",
      "Surfaces: A 2026-07-28 tasks or skills request meets the same Mcp-Method, Mcp-Name and MCP-Protocol-Version checks as every other 2026-07-28 request, and each tools/call in a 2025-era batch reads the tasks extension its own message declares.",
      "Surfaces: A tools/call paid over x402 in the call that the connector stops waiting on says it may have been charged, as an MPP-paid one does.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Package releases: spending caps, request timeouts, typed APIs",
    items: [
      "Packages: agent402-client 0.9.0 keeps every spending cap opt-in (no cap unless the caller sets one) and adds call(slug, params, { maxUsd }), which allows one call up to that amount over the per-call cap the caller set. Each request is given 120 seconds (timeoutMs, the published client timeout for metered calls) and then ends in RequestTimeoutError; a paid request that times out reads paid: \"unknown\" and its amount is held against any caps the caller set.",
      "Packages: agent402-client 0.9.0 signs a Circle Gateway batched accept only when its verifyingContract is the chain's own GatewayWallet contract (GATEWAY_VERIFYING_CONTRACTS, Circle's published address on each mainnet and testnet Gateway serves); gateway.verifyingContracts adds or replaces entries. agent402-client and agent402-mcp 0.14.0 solve proof-of-work on a worker thread and refuse a challenge above 28 bits.",
      "Packages: agent402-mcp 0.14.0 refuses a single call above $5 by default ($4 before), which covers every fixed price in the catalog: AGENT402_MAX_PER_CALL set to 0 or off turns the cap off, a value that is not a USD amount keeps the default and is named on stderr, a refused call names the price, the cap and the setting to raise, and the session budget (AGENT402_BUDGET) stays opt-in; it returns at most 25 catalog.search results, takes params as an object or a JSON string of one on catalog.call and router.execute, marks catalog.call, router.execute and memory.write destructive and the catalog lookups read-only as the hosted connector does, names no demand.request in its instructions (it does not list it), names a wallet key that does not parse at start instead of reporting a configured wallet, and runs on MCP SDK v2 (@modelcontextprotocol/server 2.4.0) with the same answers on the 2024-11-05 through 2025-11-25 revisions.",
      "Packages: agent402-tollbooth 0.12.0 charges every listed AI crawler in strict mode, a browser-like one included; the CLI stops on SIGTERM or SIGINT by letting requests in flight finish and exiting 0 (TOLLBOOTH_SHUTDOWN_GRACE_MS, default 10000, then exit 1); the README settle examples run on Base Sepolia with the x402.org facilitator. agent402-client, agent402-mcp and agent402-tollbooth ship TypeScript declarations.",
      "Packages: agent402-openai-tools, agent402-anthropic-tools, agent402-llamaindex and agent402-strands 0.2.0 pass agent402-client's spending caps through (maxPerCallUsd, dailyLimitUsd, maxPerHostUsd, x402Client; none by default). elizaos-plugin-agent402 0.3.0, agent402-agentkit 0.2.0 and agent402-openclaw 0.6.0 refuse a single paid call above $5 by default ($1, $1 and $2 before) before signing: 0 or off turns the ceiling off (agent402-openclaw no longer needs allowUncappedPayments for it), a value that is not a USD amount keeps the default and is named on stderr, and a refusal names the price, the ceiling and the setting to raise. The adapters accept agent402-client from 0.8.21 up to the next major, 0.9.0 included.",
      "MCP: The hosted connector counts each message of a JSON-RPC batch against its per-client request limit.",
    ],
  },
  {
    date: "2026-11-17",
    title: "The OpenClaw plugin on OpenClaw 2026.11.5",
    items: [
      "Packages: agent402-openclaw 0.6.0 is tested against OpenClaw 2026.11.5 and 2026.11.2. OpenClaw 2026.11.5 installs a bare plugin name from ClawHub, where each release is also published; the README names npm:agent402-openclaw for the npm package on that host, and the real-install test covers the ClawHub and npm installs there.",
    ],
  },
  {
    date: "2026-11-17",
    title: "An unconfirmed settlement is answered as unconfirmed",
    items: [
      "Payments: When a backup settler ends a settlement on an answer that does not show whether the transfer was sent (an HTTP error, a dropped connection, an unreadable answer, or a failure naming a transaction), the call is answered 402 with reason settlement-unconfirmed: the answer says not to sign a new authorization for that call before the expiry the payment carries (an authorization's validBefore, a time by which a Solana transaction's blockhash has expired, an Algorand lastValid round or a Stellar expiration ledger), or when it carries none, until the paying wallet shows whether the transfer landed, names the transaction to watch and its refund lookup when there is one (retry watch-transaction, otherwise check-wallet), carries no new offer, and its receipt reads settlement_unconfirmed.",
      "Payments: Such a payment signed as an EIP-3009 authorization is recorded for the on-chain read, so a transfer that lands is booked once as owed to the paying wallet and repaid after on-chain proof. The same payment sent again, in any encoding, gets the same answer back without the call running, and these answers never count against the paying wallet or its report and media runs.",
      "Payments: A facilitator's pending answer whose transaction is not confirmed within the wait is kept the same way, so the same payment sent again gets that answer back. A backup settler's HTTP 4xx refusal that names a verdict on the buyer's payment and no transaction keeps the earlier answer, as the same verdict answered without an HTTP error does.",
      "Surfaces: /agents.md lists the retry verbs a refused payment names under its recovery lines, and /.well-known/x402 lists the reads an unconfirmed settlement makes: the authorization recorded for the on-chain read, the expiry each payment names, and the stored answer with a digest of the payer's signature.",
    ],
  },
  {
    date: "2026-11-17",
    title: "A non-streamed model call paid on x402 EVM may run to 110 seconds",
    items: [
      "Gateway: A non-streamed call on the chat completions, Messages or Responses routes paid with an x402 EVM authorization waits on the model for 10 seconds plus one second per 30 tokens of its max_tokens (the tier's default output cap when none is sent), at least 90 seconds and at most 110, inside the published 120 second client timeout; the payment window and the time a connection through the CDN waits for an answer still end it sooner. Every other payment method keeps 90 seconds.",
      "Gateway: A model answer that runs out that time while its body is still arriving is answered 504 and says it was not charged, and counts as a timed-out attempt in the model chain, as a timeout before the first byte already did. A model connection that closes mid-answer is answered 504 the same way and the call moves on to the next model; the direct text and image routes answer both cases 504.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Weather probabilities, place names, and six retired routes",
    items: [
      "Tools: weather-probability gives the chance that a day's high, low, mean temperature, rain total or peak wind meets a threshold or falls in a range, as the share of up to 82 ensemble forecast members (ECMWF IFS and NOAA GEFS), with each model's count and the spread, for any place up to 15 days ahead: all 82 reach about 13 days ahead, and the last days answer from the 31 NOAA GEFS members, with the model left out named in the answer. weather-market-brackets takes the brackets of a weather market and the price the caller holds for each and returns each bracket's forecast probability with that price beside it, and weather-market-board does the same for many cities on one date (13 large US cities by default, or up to 20 the caller names). The caller supplies every bracket and price: the tools read no market feed, compare nothing and give no rating or recommendation, and each answer says the figures are raw model output, not calibrated to a station.",
      "Tools: place-lookup resolves a city, town, region or postal-code name to coordinates, country, region, timezone, population and postcodes worldwide, with a qualifier after a comma (\"Austin, TX\", \"Paris, France\") or a country filter; it resolves place names, not street addresses, and credits GeoNames. weather-current, weather-daily, weather-hourly, weather-history and weather-air-quality take a place name in place of lat and lon and echo the place they resolved to; lat and lon still win when given.",
      "Tools: weather-window finds the stretches of hours in the next 1 to 16 days that meet the caller's limits on rain chance, rain amount, wind, gusts, temperature and daylight, or names the limit that ruled out the most hours; weather-thresholds checks up to 8 rules against the hourly forecast and gives the first and last hour each is met. Five calculators run on the free proof-of-work tier with no data source behind them: sun-times, heat-index-calc, aqi-calc, degree-days-calc and wmo-weather-code.",
      "Tools: geocode, reverse-geocode and place-search are retired and answer 410, and name none: place-lookup finds places (cities, towns, regions and postal codes), not street addresses, and nothing live turns coordinates into an address or searches points of interest. exa-search, exa-answer and exa-contents are retired and answer 410 naming search, answer and extract. /api/gateway-status no longer carries exaSpend or exaAllowance.",
      "Tools: the global weather tools and place-lookup answer a repeated identical request from a short-lived cache (ten minutes for forecasts, a day for places).",
      "Packs: skill-trip-planner and skill-location-intel run on place-lookup and the worldwide daily forecast. location-intel takes a place name (a city, town or region) in place of an address, adds the US county and state for a US place, and skips its two US-only steps elsewhere; its nearby-places step is gone. trip-planner resolves stops by name and forecasts any stop in the world. Each pack's price follows its new parts, so both cost more.",
    ],
  },
  {
    date: "2026-11-17",
    title: "A 402 a small header limit can read",
    items: [
      "Payments: A client whose parser caps one header line near 8 KB, such as Python aiohttp at its defaults, can read the 402. A request that sends X-Payment-Compact: 1, or whose User-Agent names aiohttp, gets a PAYMENT-REQUIRED header under 7,500 bytes: the resource, the Bazaar extension and the builder code unchanged, the Base exact accept first, each other exact accept that fits, and a compact field that names the body as the full offer. The 402 body keeps every accept, and a payment signed from the compact header settles the same way. Every other request gets the header it got before, byte for byte, and every 402 that carries it varies on both request headers.",
      "Surfaces: The 402 body states the PAYMENT-REQUIRED header's size and how to ask for the compact one (paymentRequiredHeader), and /llms-full.txt, /how-to-pay, /x402-test and the wiki say how a client with a small header limit reads the 402: raise aiohttp's max_line_size and max_field_size, or send X-Payment-Compact: 1. The compact header and paymentRequiredHeader are served unless PAYMENT_REQUIRED_COMPACT=off.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Computed market answers replace the DeFi analytics routes",
    items: [
      "Tools: Eight new tools answer with figures computed per call: funding-screener (one coin's perpetual funding and basis across every listed venue, with dispersion and annualized carry), stablecoin-depeg-watch (every USD stablecoin above a size floor, its deviation now, over 24 hours and over 7 days), exchange-spread (one coin's price on each venue against the cross-venue median), dex-pool-health (one pool's liquidity, turnover, trade sizes and wallet mix, with a price-impact estimate), defi-screener, dex-volume-board, chain-board, and lending-rates (Aave v3 and Compound v3 supply and borrow rates read from the lending contracts on five networks). The seven market-data tools carry the CoinGecko credit in every answer; lending-rates reads on-chain state only. dex-pool-health and dex-volume-board answer on a deployment that holds a market-data key. Each market-data listing states how often its figures are refreshed: every 5 minutes for exchange-spread and for a pool's recent trades, every 15 for stablecoin-depeg-watch, and every 30 for the rest.",
      "Tools: Fifteen routes are retired and answer 410 Gone with a Sunset date, and name none: defi-dex-volume, defi-yields, defi-yield-history, defi-protocols, defi-protocol, defi-chains, defi-chain-tvl-history, stablecoins, stablecoin-supply-history, defi-fees, defi-tvl, dex-top-pools, l2-tvl, options-volume and crypto-orderbook. The 410 for defi-dex-volume adds that dex-volume-board ranks one network's DEXes by their share of 24-hour volume across its top pools, and that nothing live ranks DEXes across every chain or over longer periods.",
      "Skill packs: defi-protocol-scanner reads the token's supply and valuation profile (coin-profile) where it read locked value, and defi-dashboard reads the DeFi market cap and dominance (global-defi); each pack's price follows its parts.",
    ],
  },
  {
    date: "2026-11-17",
    title: "Live in the header, sample reports served whole",
    items: [
      "Site: The header bar carries Live, the live view of x402 and MPP payments as they settle, after Status at every desktop width; the tap menu keeps it, and the Marketplace menu no longer repeats it.",
      "Site: With no theme chosen, the site follows the device's dark setting; a choice made with the theme toggle is kept and wins.",
      "Site: Each header menu tells assistive technology whether it is open, Escape closes an open menu with focus kept on its trigger, and the header is named as the main navigation.",
      "Site: Sample reports are served as finished pages: the report arrives with the page and reads with no script; its downloads and buy box work as before.",
      "Site: When /api/find marks its rows as word matches only, the /tools search lists them as closest matches and, when an indexed seller does the task, links the seller directory's search for the same words.",
      "Site: Footer link rows wrap into even lines, and the current page's name in a breadcrumb sits on the line of its links.",
      "Tools: seller-dossier names each route's delivery record responseDelivery, as the index's rows do; ourPaidCalls stays beside it with the same value and is deprecated. Its delivery summary says the count includes our router's unpaid non-answers, and its description and flags name the routes our router called rather than routes it paid.",
      "Surfaces: /openapi.json names the service Agent402.tools in its title; the tagline moves into its description.",
      "Surfaces: /api/find reads a query that asks to convert a currency (\"convert currency\", \"convert usd to eur\") as a currency conversion and ranks fx-rate first as a strong match; inside a conversion, currency codes and names count as values, not as the task.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Price reads keep their weekly clock, and the router never uses up a seller's crawl",
    items: [
      `Index: A paid route priced in a seller's manifest and listed without a price in its /openapi.json is read live once and then again after ${span(LIVE_QUOTE_MAX_AGE_MS)}, as every other route is; until now every crawl asked it again, because the merge of the two documents dropped the mark that the price was the seller's own.`,
      `Index: A route priced above everything the router buys is asked at most once in ${span(LIVE_QUOTE_MAX_AGE_MS)}, and when its seller registers again; the check that a seller's routes still ask for payment uses its cheapest paid route, and runs at most once in ${span(LIVE_QUOTE_MAX_AGE_MS)} for a seller whose paid routes are all priced that high.`,
      `Index: Every robots.txt group that names Agent402 or Agent402-Crawler is read as one (RFC 9309): their rules are combined, and the longest rule that matches a path decides it, whichever group it came from.`,
      `Index: The MPP index's reads of a seller count against the same daily allowance, wait out the same Retry-After holds, and follow the slower cycle (${slowOriginIntervalLabel()}) a site asked for. That cycle is timed by the clock from the last read any of our servers made, in both indexes, so a restart does not read such a site early.`,
      `Index: A site whose scheduled read we put off (its day spent, a Retry-After, the slower cycle) keeps its last good listing through a read of ours that then does not complete, for the same hold window counted from the last turn we put off, so it never leaves the router because we chose not to read it. Once such a read has failed, the turns the site then waits no longer extend the hold, so a site that stays unreachable leaves after it.`,
      `Index: One caller's registrations send one site at most ${REGISTRATION_HOURLY_MAX} document reads and paywall checks an hour, whichever origins on it they name; that caller's registration past that is answered 429 with a Retry-After, and nothing is listed or changed. Another caller's registration of the site is never held by it: past ${REGISTRATION_HOST_HOURLY_MAX} such reads of one site in an hour from every caller together, the rest are sent one every ${REGISTRATION_PACE_MS / 1000} seconds. A name under a wildcard or dynamic DNS service is counted on its own allowance, like a site on any other shared hosting, whatever address it points at, so no such name can spend another site's day.`,
      `Operations: The seller load controls decide from each server's own memory and read the shared store once per crawl cycle, so a slow store no longer slows the crawl or a buyer's purchase. A crawl cycle's health counts the sites waiting on unchanged documents as the cycle's reads of sites last read well came out, so a few dark sites still read as theirs and an outage of ours as ours.`,
      `Operations: The request log behind /__operator/seller-load.json also counts the catalog's fetches, the site-crawl tool and the router's purchases per host.`,
    ],
  },
  {
    date: "2026-11-16",
    title: "Our requests to sellers name themselves and back off",
    items: [
      "Index: Each part of the service that sends requests to a seller names itself with its own User-Agent: Agent402-Crawler for the index crawler's document reads, Agent402-Probe for the unpaid price and paywall checks, Agent402-Router for a purchase made for a paying caller (and the request that opens it), and Agent402-Fetch for a tool fetching a URL its caller named. Each keeps the browser-compatible form and links to /crawler, which lists them all; no request to a site in the index or to a URL a caller names carries the older Agent402/1.0 token. robots.txt groups for Agent402 still apply to the crawler.",
      `Index: When a seller's manifest and /openapi.json come back unchanged (a 304, or the same bytes), the wait before the crawler reads that origin again doubles each time, from ${span(revisitIntervalMs(1))} up to ${span(REVISIT_CAP_MS)}. A changed document, a failed crawl, a purchase that did not deliver, or registering again puts it back on the regular cycle (${crawlIntervalLabel()}); a waiting origin's listing stays as it was.`,
      `Index: The crawler, the unpaid price checks and the MPP index's scheduled reads keep to about ${DAILY_BUDGET.toLocaleString("en-US")} requests a day to one site on its own account (a crawl already under way finishes its reads), counted per registrable domain or per hostname on shared hosting (a platform subdomain or a cloud API host); the unpaid price checks take at most ${probeShareLabel()} of that, and past it they wait for the next UTC day. The reads a registration of the site asks for are counted apart and never use that allowance. A site whose documents moved to another site is counted on its own allowance. Every request that follows such a move to the other site, a document read or a price check, is held to ${DAILY_BUDGET.toLocaleString("en-US")} more a day there, apart from that site's own allowance: past it those requests are not sent until the next day, and the moved site's listing stays as it was. Sites that moved to the same site are read one after another, the one read longest ago first, so each is refreshed in turn. The router's request before a purchase for a paying caller is counted on its own and always goes through.`,
      `Index: A 429 or 503 from a seller pauses the crawl and the unpaid price checks for that host until its Retry-After, ${span(THROTTLE_DEFAULT_MS)} when it names none, and never longer than ${span(THROTTLE_MAX_MS)}.`,
      `Operations: /__operator/seller-load.json counts the revisit waits, resets by reason, requests and refusals per kind, the hosts past their day and the Retry-After holds, without naming a seller; with ?host= it lists the requests we sent that host per component and minute over the last ${span(REQUEST_LOG_KEEP_MS)}.`,
    ],
  },
  {
    date: "2026-11-16",
    title: "Settlement wording per rail, and a page for a stopped reconciliation",
    items: [
      "Payments: Every sentence that said a payment settles only on a delivered result names the rail it holds on or its exception: a Tempo transfer sent before the call is final before the run and, if the run fails, is repaid after on-chain proof. This covers the tool pages, llms.txt, skill.md, the async job answers and hints, the buying-at-volume guide, the webhooks page, the wiki and the client and MCP package READMEs.",
      "Payments: A failed async job paid with a Tempo transfer sent before the call says the transfer is recorded as owed and repaid after on-chain proof, whether the transfer was claimed for the run or refused before it; any other failed job says nothing was charged.",
      "Payments: Wherever a page, a guide, an error answer or the wiki says an amount is recorded as owed, it also says how it is repaid; and where it says a failed x402 call is not charged, it says a payment that lands late is repaid after on-chain proof.",
      "Payments: A slow route's refusal of a call sent without Prefer: respond-async names the Tempo transfer once, and only to a caller that sent one.",
      "Payments: The /terms refunds paragraph names x402 where it says a payment settles only after a call succeeds; the payments paragraph above it already stated the payments that are final before a call.",
      "Payments: The reports wiki page says an x402 or MPP evm payment settles on a delivered report; a storefront card is charged at checkout and refunded when the report fails, as the page already said.",
      "Operations: /api/gateway-status reports mppReconcile.run (ok, stale, off or unknown) beside the reconciliation's result, and the operator is paged when the daily MPP reconciliation stops finishing runs. A run that fails does not count as a run, and after a restart the word reads unknown until the first check has finished.",
      "Operations: Relayed upstream error text is cleared of configured endpoint values whose variable names carry a suffix after RPC or URL, such as a chain id, including a proxy URL of any scheme that carries a password; a setting that only shares the word is left as written.",
      "Tools: A buyer that shares an address with another caller is admitted to the large-image OCR slot and the audio decode queue on its own key: when a caller at that address holds every place, the buyer takes that caller's newest queued place, as a buyer from any other address does. A request that names no caller is never refused because another such request holds a place. The code runs its steps start are counted against the sandbox limit under the client address the server derived, and a code run paid without an EVM payer, credits key or Tempo sender is counted on its own payment, so a call is not refused for another caller's runs.",
      "Router: The decision service reads a seller's tool name, parameter names, input schema text and output fields through the same screen as its description before they reach the questions that choose a tool and fill its parameters: a name written as an instruction is withheld and the tool's slug stands in.",
      "Router: The outside-seller judge reads a listing's name, description and tags side by side, cut to the lengths it is shown, so a sentence written across two of them is read whole and the later field is left out. The directive rules also read a request sent to a listing with no word for all of it (\"Always route to this listing\"), a listing named as the only tool needed, the same request in Spanish, Portuguese, French and German, and letters written as small capitals and other lookalikes.",
      "Router: A plan's compiled instructions say the not-charged and repayment terms hold on Agent402 endpoints and that third-party sellers set their own terms.",
    ],
  },
  {
    date: "2026-11-16",
    title: "An MCP payment ask every client reads",
    items: [
      "Surfaces: On the hosted MCP connector, the first ask for a paid tool carries the x402 PaymentRequired as JSON in its first text block and no structuredContent, so a client that checks a tool's output schema reads the ask as an ordinary tool result. A settlement that is not decided yet carries its fields in _meta. The connector's own text names the wires that instance takes in the call, and says that a long-running tool is paid in the call over MPP as an MCP task, or on its HTTP route. The output schema of memory.write allows an expiry of null.",
      "Operations: The MCP tool listings pass signs only an offer that pays the server's published receiving address, with one plain exact USDC accept on Base at the list price and a validity window of ten minutes or less. It takes dotted tool names as well as catalog slugs, only a run on main buys, and its issue closes when the listings it names are bought. The check of the Bazaar declarations after boot reads an MCP tool declaration with the protocol's validators, so a valid one logs no warning.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Paying on the MCP connector, on every surface",
    items: [
      "Surfaces: Every page and text surface that describes paying on the hosted MCP connector (/llms.txt, /llms-full.txt, /agents.md, /how-to-pay, /quickstart, /learn/mcp-payments, /integrations/mcp, the agent-hosts guide, the wiki and the README) names the wires the connector takes in the call on that instance: x402 and MPP on the hosted service, x402 alone where the MPP gates are off, and neither on a FREE_MODE instance, which has no paywall. The listed description of payment.info says the same.",
      "Operations: The Bazaar listing scripts read the connector's MCP tool listings: a pass that takes an explicit list and buys each listing once through the connector's x402 transport, a presence check that reads the listings beside the routes and pages on one that was listed and left, and a check of each tool's offer.",
    ],
  },
  {
    date: "2026-11-16",
    title: "The hosted MCP connector accepts x402",
    items: [
      "Surfaces: The hosted MCP connector at /mcp accepts x402 in the call, over the x402 MCP transport: the first ask for a paid tool carries an x402 PaymentRequired beside the MPP challenges, a client sends the signed payment in _meta[\"x402/payment\"], and a paid answer carries the settle receipt in _meta[\"x402/payment-response\"]. Six flagship tools (web.search, web.news, web.answer, market.quote, browser.render and memory.read) are offered with resource /mcp, and catalog.call and the other flagships with the tool's own HTTP route; that route's x402 paywall verifies the payment, runs the tool and settles only a successful answer.",
      "Surfaces: On the hosted MCP connector, a payment whose settlement is not decided yet (a Circle Gateway batched payment still settling, or a broadcast transfer not yet confirmed) or did not complete is answered with the paid route's explanation and no new offer, so a client does not sign a second payment for one call. A free tool at its rate limit offers its x402 challenge, so a client that pays is served past the limit. A call carrying a payment has its own, larger per-client request limit when it reaches a paid route; any other call keeps the normal one.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Marketplace answers arrive whole or are not settled",
    items: [
      "Payments: An input a tool refuses on a call bought through a marketplace listing is answered with the tool's expected fields, required fields and example, as on the direct route, and this server does not settle the payment.",
      "Payments: An answer larger than a marketplace passes on whole (64,000 bytes) is refused with status 413 before the payment is settled, so we do not settle it: the refusal gives the answer's size and the limit and names the tool's own input fields that narrow the request. No answer is cut to fit, and a tool whose published example answer is over the limit is not offered there.",
      "Payments: The wait for a marketplace settlement to answer is 60 seconds by default, which covers the longest that settlement takes to answer. A call whose run was slow waits less, so its answer starts before the connection's own time limit; a settlement still unanswered then is read from the chain, and the answer is kept for the same payment sent again.",
      "Tools: The published example for edgar-company-facts asks for two named concepts (tags=Revenues,Assets), an answer of a few tens of KB. Every input answers as it did before.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Marketplace sales count in our figures",
    items: [
      "Payments: A sale made through a marketplace listing of one of our tools now counts in the public sales figures: the sales summary, the served-call counters, the tool rankings, the bestsellers feed, the buyer scorecard and the per-network split each count it once, as an outside sale of that tool, at the price its buyer paid.",
      "Payments: On the transactions page, a marketplace sale settled on chain is counted once, and the paying wallets figure counts the buyer who paid for it, not the payment contract the marketplace uses.",
    ],
  },
  {
    date: "2026-11-16",
    title: "CoinGecko answers carry the source credit",
    items: [
      `Tools: Every answer from a tool that serves CoinGecko data carries a credit field, "Data provided by CoinGecko" with a link to the CoinGecko API page, and each such tool's description ends with the same linked sentence. A market tick answer that includes a coin figure carries it too, and a skill pack that runs a CoinGecko tool prints it once, on the pack's answer.`,
    ],
  },
  {
    date: "2026-11-16",
    title: "Large seller indexes and sanctions list copies no longer hold the server",
    items: [
      "Operations: The seller index reads a very large seller's networks and signing domains across turns, in the same order as before, so a seller with tens of thousands of listed routes no longer holds other requests while the router's index of its routes is built.",
      "Operations: The stored copies of the sanctions lists are serialized across turns and written off the event loop, to the state database and to disk alike, one write at a time in the order the lists were loaded, so a large list or a busy disk no longer holds other requests.",
    ],
  },
  {
    date: "2026-11-16",
    title: "CamelCase seller names are read as words",
    items: [
      "Router: /api/route also reads a camelCase seller name as words: an operationId such as webPageToMarkdown or getUSDCPrice splits at its capitals (get usdc price), so a multi-word query covers the name as it covers a snake_case or kebab-case one. The parts are extra words beside the whole name: a brand-cased name (GitHub, OpenAI, DeFi) still matches as one word and scores as before, and a fragment of two letters scores nothing on its own. Query words are read as before.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Weather data reliability and Copernicus credits",
    items: [
      "Tools: The weather tools read their data on a reserved service lane when the server holds a weather data key, and a refusal of that key answers a temporary error that names our side, not the buyer's input, while /api/gateway-status reports openMeteo (off, unknown, ok or refused) and the operator is paged on refused.",
      "Tools: weather-air-quality credits the Copernicus Atmosphere Monitoring Service and weather-history credits the Copernicus Climate Change Service, each with the Copernicus disclaimer, in each tool's description and in a credit field on each answer, beside the Open-Meteo credit; weather-history states its range as 1940 to the most recent days.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Test and CI servers no longer crawl seller hosts",
    items: [
      "Operations: Test and CI servers no longer crawl seller hosts: the x402 and MPP index crawlers start on a production boot only (NODE_ENV=production, which the image sets, or the platform's production environment), never under FREE_MODE or CI, unless X402_INDEX_CRAWL=on or MPP_INDEX_CRAWL=on says so. Before, a local, test or CI server without the switch set ran its own pass over every indexed seller.",
    ],
  },
  {
    date: "2026-11-16",
    title: "A card refund made by hand is recorded",
    items: [
      `Payments: A failed card report whose payment was already refunded outside the server records that refund: when Stripe refuses a new refund, the refund already made for the payment is read back and its id recorded once Stripe reports it succeeded (a refund still pending leaves the payment owed until it does), and a check that runs every ${mins(READBACK_INTERVAL_MS)}, first ${mins(READBACK_FIRST_MS)} after the server starts, reads back every payment still owed a refund without issuing one, so a refund made by hand after the retries stop also shows the payment refunded and leaves the owed refund alarm.`,
      `Payments: The sweep that deletes an unpaid wallet subscription offer's email, subject and signing key runs ${mins(OFFER_SWEEP_FIRST_MS)} after the server starts, as well as every ${mins(OFFER_SWEEP_INTERVAL_MS)}, so a restart does not hold the deletion back.`,
    ],
  },
  {
    date: "2026-11-16",
    title: "Settled subscription payments are never lost",
    items: [
      "Payments: A wallet subscription whose first payment settled but whose record could not be written is booked as owed to the buyer, once, and the buyer is told the payment settled. Sending the same request again before the payment challenge expires hands the subscription back and cancels that debt; a refund already being sent refuses it instead, so a buyer is never both served and refunded. Once the challenge expires the debt stands and the signing key is deleted. A first payment the server stopped before answering is found before its signing key is deleted: the subscription is rebuilt when the offer named a delivery email, and otherwise the payment is booked as owed.",
      "Payments: An unpaid wallet subscription offer's email, subject and signing key are deleted within an hour of the request.",
      "Payments: An owed card report refund is counted from the report's own record, so the refund alarm reads it even when the list of open issues missed it, and stops reading it once the record shows the refund was sent.",
    ],
  },
  {
    date: "2026-11-16",
    title: "One claim per payment, one amount per price",
    items: [
      "Payments: Two requests carrying one payment are claimed once when the shared store answers one of them and not the other: the request whose claim lands in the store reads the claim this server already holds and is refused uncharged: answered 409 (X-Payment-Replay: inflight) on x402, and refused as an invalid challenge (402) on a card or Tempo payment. A claim taken while the store did not answer is written there once this server reaches the store again, without waiting for the claim's 30-second renewal, so a container serving beside this one reads that payment in flight.",
      "Payments: A dollar price becomes a token or card amount by integer arithmetic where a challenge is minted and where a payment is checked against its price, so the two name the same amount at any token decimals: a Tempo credential that pays exactly its challenge is accepted when the token carries 18 decimals, and the card challenge and its check, the published offer amounts, the subscription amounts and the payment proofs on every chain and Circle Gateway read the same figure.",
    ],
  },
  {
    date: "2026-11-16",
    title: "An empty streamed answer is not charged",
    items: [
      "Gateway: A streamed answer on the chat completions, Messages or Responses routes that ends with no answer (every token spent on reasoning or thinking, or an empty refusal) is answered 502 before any byte is sent and is not charged, as a non-streamed call already is; a payment sent before the call is recorded as owed back. The next model in the chain is tried first. A streamed answer with content is sent from its first answer token, with the reasoning before it, so it arrives as fast as before. On a connection that ends a response with no byte for about 100 seconds, a reasoning phase that outlasts that window starts sending before it closes, and is then served and charged as before.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Own sources that do not resolve are ours",
    items: [
      "Tools: when a source a tool reads on its own does not resolve, the answer is a 503, uncharged, never the 400 a URL you supply gets when it does not resolve. The weather, geocoding, holiday, government, Treasury debt and average-rate, FX history, World Bank, FRED, crypto market, SEC filing, market data and npm registry reads answer 503 with Retry-After 5, attribution ours and hint our-egress, so the same call can be sent again; the Treasury yield-curve tools, fx-rate and fx-dashboard keep their own 503 with Retry-After for a source they cannot read.",
    ],
  },
  {
    date: "2026-11-16",
    title: "Late Solana and Algorand payments are repaid",
    items: [
      "Payments: A payment that reaches the chain after its call was refused is found and repaid on Solana and Algorand as on EVM: a settlement that failed while naming its transaction is followed on chain, and once it lands it is recorded as owed to the buyer, once. On EVM, a settlement refused as already submitted whose chain read failed is followed the same way, and a transaction that never appears is closed as not landed only after an exact payment's signed authorization reads unused, so a transfer sent in another transaction is still repaid. On Solana and Algorand one settled transaction answers one request.",
    ],
  },
  {
    date: "2026-11-15",
    title: "Access keys and card tokens are judged per payer",
    items: [
      "Payments: A Tempo pull credential signed by an access key runs only once the chain confirms that key belongs to the account the transaction names; one whose key the chain reports is not that account's is refused 402 before it runs, uncharged, and when the chain cannot be read in time the answer is 503 with Retry-After 3, uncharged, so the same request can be sent again. A confirmed one is judged on that account's balance, together with that account's other calls in flight, as one signed by the account's own key is: a call the balance cannot also cover is refused 429 before it runs, and nothing is charged. A card payment token pays for one run at a time: while a request it pays for is in flight, another credential carrying the same token is refused 402 before its handler, uncharged; the token is free again once that run ends, captured or not, so a token with limit left pays for a later request under a new challenge, while a credential that was captured is refused if it is sent again.",
    ],
  },
  {
    date: "2026-11-15",
    title: "Kept balance reads judged at once",
    items: [
      "Payments: on routes other than the report and media routes, a wallet whose last balance read is under 5 minutes old, and covers every paid call it has in flight plus the new one less what its payments took since, has the new call started at once, with no wait for another read. A call that read does not cover, or a wallet whose read is older, is judged on a new read as before.",
      "Payments: a Solana payment whose transfer names an account through an address lookup table is covered with the wallet's calls in flight too: it is judged on what the paying wallet holds of the token across its accounts.",
    ],
  },
  {
    date: "2026-11-15",
    title: "Yield curve and FX answers name their source",
    items: [
      "Data: the treasury-yield-curve, treasury-yield-history and yield-curve-spread tools read the U.S. Treasury's Daily Treasury Par Yield Curve Rates, with the same tenors, inputs and answer shape, and name it in source or asOf; their descriptions end with \"Source: U.S. Treasury.\" The server keeps the curve in memory and refreshes it in the background every 30 minutes; when a refresh fails, answers carry stale: true and staleAsOf. A call that finds a year it needs not yet held waits at most 20 seconds, then answers 503 with Retry-After.",
      "Data: answers from fx-rate carry source, naming the European Central Bank reference rates, as fx-dashboard answers do. Both read those rates only: when they cannot be read, fx-rate answers 503 with Retry-After, and fx-dashboard serves its marked snapshot of up to a day or answers 503 the same way. The FX tools' descriptions end with \"Source: European Central Bank.\"",
    ],
  },
  {
    date: "2026-11-15",
    title: "Coverage refusals name their class",
    items: [
      "Payments: a 429 from the check that a wallet's balance covers its paid calls in flight carries attribution \"ours\", a hint and a reason naming its class (cover-short and cover_short, and so on) and a fix saying what to do next, in place of the tool's input schema and example. The privacy page and payment.dataHandling in /.well-known/x402 say that each paid call reads the paying wallet's public balance, that a reservation per call in flight is kept for the life of the call, and at most 30 minutes when a server stops mid-call, and that the last balance read is held in memory, used for at most 15 minutes, and dropped once the wallet has been idle 15 minutes, sooner when the server holds 50,000 wallets, or on restart.",
    ],
  },
  {
    date: "2026-11-15",
    title: "Refund lookup lists every refund of a transaction",
    items: [
      "Refunds: the refund lookup, GET /api/refunds?tx=<hash>, also returns refunds: every refund recorded for that transaction, oldest first, each with its own status, priceUsd and refundTx. Where more than one payment settled in one transaction, each has its own entry, and the top-level fields describe the one furthest from repaid. A transaction with one refund answers as before, with one entry.",
    ],
  },
  {
    date: "2026-11-14",
    title: "Calls in flight are covered together",
    items: [
      "Payments: a wallet's paid calls in flight are covered by its balance together. On every paid route that is not free through proof-of-work, a paid call is started only when the wallet's balance of the paying token covers every call it has in flight plus the new one; otherwise it answers 429 before anything runs, and x402, the MPP evm method and a Tempo pull credential are not charged for it. This applies to x402 on EVM, Solana, Algorand and Stellar, to the MPP evm method, to a Tempo pull credential and to a Circle Gateway batched payment, which is judged on the payer's Gateway balance.",
      "Payments: on routes other than the report and media routes the balance is read inside about a second, and a wallet whose balance covers its calls can send as many at once as that balance covers: the coverage check sets no other limit on calls at once, and a route's own limit still applies (the code-run tools: 2 runs at once per EVM payer, credits key or Tempo sender, and 4 per client address for other payers). A call the balance does not cover answers 429 with Retry-After 30. A call that arrives while another call from the same wallet is still settling, and whose cover cannot be confirmed yet, answers 429 with Retry-After 5 within about a second and says so. Either answer takes up to about 3.5 seconds when a settlement lands during the balance read.",
      "Payments: when the balance cannot be read right now on those routes, the call is started if the last balance this server read for that wallet within the past 15 minutes, less what the wallet's payments have taken and its calls in progress hold since, covers it. Otherwise, and for a wallet with no read that recent, the wallet runs up to 4 calls at once (16 for a wallet with a payment on record) while its balance cannot be read, and a call past that answers 429 with Retry-After 5. Each of these answers comes before anything runs, and x402, the MPP evm method and a Tempo pull credential are not charged for it.",
      "Payments: the report and media routes are judged as before: the balance read is given up to five seconds, a call the balance does not cover answers 429 with Retry-After 30, and while the balance cannot be read a wallet runs up to 4 calls at once there, whatever its record.",
      "Payments: a card or Tempo challenge must have enough life left for the route's run and the charge after it. One that would expire during the run answers 402 with a fresh challenge before anything runs.",
      "Payments: the dub tool's X-Dub-Translation header is sent only with the audio: a call whose payment is refused after the run carries neither.",
      "Payments: the settle-failure count for an address with no known payer is kept per IPv6 /64.",
      "Server: /api/gateway-status reports coverageReads. Its status reads ok, degraded or off: degraded when a paid call was started or refused without a balance read made for it inside the last ten minutes. Its alert reads sustained when such calls fell in three or more separate minutes of the last ten for three or more wallets, else ok.",
    ],
  },
  {
    date: "2026-11-14",
    title: "Llama 3.2 successor",
    items: [
      "Gateway: the upstream lists an expiration of 2026-11-20 for meta-llama/llama-3.2-3b-instruct as well as meta-llama/llama-3.2-1b-instruct. A call naming either is served as itself until that day, then by mistralai/ministral-3b-2512 at the tier and price of the route called (nano, base or metered), the swap named in agent402_model_substituted.",
    ],
  },
  {
    date: "2026-11-13",
    title: "Listing types, charge sentences and price keys",
    items: [
      "Index: the seller index also reads the price spellings amount_usd and max_amount_required, beside price_usd, in a seller's manifest and OpenAPI document: amount_usd in a price object and an OpenAPI payment object, max_amount_required on an entry that names its asset, in a payment object and in accepts items. They are read only where the seller's own manifest or OpenAPI document would otherwise give a route no price, so a price those documents already gave is kept, one written as both priceUsd and price_usd included. A price they give counts as the seller's declared price, as the camelCase spelling does: it is listed in place of a price read from the Bazaar or learned from the seller's 402.",
      "Surfaces: a tool that answers with bytes is listed under the content type its example returns: qr, screenshot, image-resize and image-thumbnail as image/png, image-convert as image/jpeg and /v1/audio/speech as audio/mpeg. The x402 listing, /openapi.json and /api/pricing read the type from one field on the tool, /openapi.json lists a route's other answer types after it, and a binary listing names its output type as binary with a sample string that names its bytes.",
      "Surfaces: the hosted /mcp connector reports serverInfo.version as the agent402-mcp package version in the deployed build followed by that build, in the form <package version>+build.<sha>.",
      "Tools: refusals from /api/decide, the route-execute tiers and the /v1 chat completions tiers that say a call was not charged use one sentence, \"Nothing was charged.\", on a call to the route itself. A step error recorded inside a decision run no longer carries that sentence.",
      "Payments: a refusal sent to a Tempo payer whose transfer was claimed before the call ran says in one sentence that the failure is recorded as a refund owed to the sending wallet, in place of the sentence that nothing was charged.",
      "Payments: across a deploy, a payment whose credential is held under an earlier key of the same payment family is refused as the same payment; a different payment in that family is served.",
      "Server: the server and worker image builds print the end of npm's debug log when the install step fails, and fail with npm's exit code.",
    ],
  },
  {
    date: "2026-11-13",
    title: "Payment and input hardening",
    items: [
      "Tools: transcription measures each file's length by decoding it before any upstream call. WMA, raw AAC, AMR and CAF recordings are read and sent as FLAC, an MP4, MKV, WebM or Ogg file holding several audio tracks is measured and sent as its first track, and AAC behind an ID3 tag, an MP3 with leading padding and an Ogg file sent under another format's name are read too. A PCM WAV whose size alone keeps it inside the cap is sent without a decode, and a call that finds the decoder busy waits its turn inside the time its payment allows, or is answered a retryable 503 at once when the queue for the decoder is full, by its count or by the bytes its waiting files hold. A refusal says nothing was charged on a call to the route itself, in the wording that names the Tempo push exception, and not inside a skill-pack step.",
      "Tools: a file sent for transcription whose length cannot be confirmed is transcribed up to its tier's cap, and the answer says so in trimmedToCapSeconds and durationUnconfirmed; both fields are in the output schemas.",
      "Tools: large images sent to image-ocr wait their turn per caller, a step run by a decision, by route-execute or by a skill pack included, so one caller's run of large images cannot hold every place in the queue. The caller is the verified payer, else the client address, an IPv6 address read as its /64. A refusal says nothing was charged on a call to the route itself only.",
      "Tools: code-run and code-run-pro calls made inside route-execute, a decision or a skill pack count against the caller's concurrent-run limit, as a direct call does, and an IPv6 caller is its /64.",
      "Tools: transcription measures and cuts each file by the audio samples it decodes, not by the timestamps its container writes, and a file sent as it came is uploaded under the name of the format it was measured as.",
      "Tools: openapi-resolve-refs resolves long chains of refs, deeply nested documents and long pointers inside cyclic refs in time proportional to their size, and a cycle reached from many top-level keys once. A spec whose refs inside a cycle take more than 1.5 million steps to resolve is refused with a 400 that says to resolve it in parts.",
      "Tools: route-execute does not resell a 200 a seller sent without taking payment when its body is empty or blank, an empty list, an error sent as text, or text, a list or a bare value where the seller promised JSON fields; the next seller is tried. A paid answer that is not JSON on a route that promised JSON fields counts as a missed promise in the seller's delivery record. A paid answer longer than the router reads is judged on the JSON document it closed, and one that cannot be read that way, or cannot be read at all, is counted as unverifiable in the delivery record and the seller dossier.",
      "Tools: report kits remove bracket runs from quoted source text across combining marks, blanks, control characters and the compatibility forms of each bracket.",
      "Tools: the router judges read each listing as quoted data: one JSON object per listing with every line break escaped, under a rule that a speaker label or instruction inside it is the seller's text. The listing text they read rewrites the separator after any short label, in any script and anywhere in a sentence, to a dash, keeping every word, and leaves URLs, times, ratios, prices, paths and IPv6 addresses as written; and /api/route's judge reads the same screened text as route-execute's, with a price label formatted from the parsed price. The paywall probe's judge reads a route's answer as one quoted JSON string.",
      "Tools: /api/route ranks with the same order as before in steps, so a ranking query hands the server back between slices while it sorts.",
      "Payments: a paid answer whose connection closed after its headers went out is kept under its idempotency key, so a retry with the same key, a prepaid credits key included, replays it instead of running and being debited again.",
      "Payments: a subscription whose first payment settled while its record was not written is rebuilt once when the same credential returns: its first period is booked once, and a cancel recorded meanwhile is kept.",
      "Payments: a refused Tempo push transfer is recorded as owed before its credential is released, so a retry with the same credential finds the debt.",
      "Payments: while many /v1 payments fail to settle across the service, only a wallet that has never settled a payment is held after one payment refused for its own reason, and the 429 says why; a wallet that has ever paid is served as before, a caller with no proven wallet keeps the usual count, a failure of unknown cause keeps its usual count, and settlements that fail for an unknown cause or are counted against an address or a credits key never start that bound.",
      "Payments: one signed EVM authorization whose settlement keeps failing for the buyer's reason is refused on its own, and a new authorization from the same wallet is served at once.",
      "Payments: one EVM authorization holds one claim on a server without a shared store, whatever unsigned network fields a copy of its header carries.",
      "Payments: the Circle Gateway batched accept is offered on no route that buys from an outside seller or spends a wallet of ours, /api/decide/execute and the flight routes included; those carry the plain accept. A decision run whose buyer left before the first byte is settled and its review is held, as a route-execute run's is.",
      "Packages: the job-link poller follows a redirect only within the server's own origin and refuses a redirect to any other origin before reading it, saying so in its error. The server-side scripts use it, as do agent402-client 0.8.26 and agent402-mcp 0.13.32, whose MCP output schemas also carry the transcription fields trimmedToCapSeconds and durationUnconfirmed.",
      "Surfaces: MCP connector answers whose indented JSON would pass the size ceiling are sent as compact JSON.",
      "Surfaces: /privacy lists the per-authorization settle-failure count, the list of failing payer wallets and the sales-ledger read the settle refusals use.",
    ],
  },
  {
    date: "2026-11-13",
    title: "Model refresh",
    items: [
      "Gateway: The /v1 chat tiers' defaults move to newer models at the same prices: base gpt-6-luna, pro gpt-6.1-terra, premium claude-opus-5.5; the bare claude-opus, claude-haiku and x-ai/grok names serve opus-5.5, haiku-5.5 and grok-4.7. Every replaced model id is still served when a call names it.",
      "Gateway: Nano admits claude-haiku-5.5 and deepseek-v4.1-flash; qwen3.8-flash joins base, auto, grounded and metered, and takes a rung in auto's fast code ranking; pro admits gemini-3.8-flash and gemini-4-argon; premium admits gemini-4-argon and claude-fable-5.2.",
      "Gateway: A tier serves its own default when a call names it, at that tier's price, and /v1/models lists it under that tier: gpt-6-luna named on base is served on base, on the chat, Messages and Responses wires.",
      "Gateway: /api/llm and /api/llm-pro default to gpt-6-luna. A call there that names no model is served without the temperature and top_p it sends, and the answer names them in agent402_params_not_sent.",
      "Gateway: Image tiers render on gpt-image-2.6 flare and sunburst. A one-link image edit route's refusal no longer names an empty failover.",
      "Gateway: Gateway examples name models each tier serves at its own price: base its default, gpt-6-luna; the /v1/pro tier gpt-6.1-terra.",
      "Speech: TTS (/api/tts, /api/tts-hd): Voxtral TTS 3 joins the backups behind Voxtral Mini, same voices.",
      "Judgment: /v1/judge and /v1/decisions add Gemini Decision-1 and the same pinned Jev version over OpenRouter as fallbacks. The discovery reranker, wish classification and the decide planner ask that Jev version over OpenRouter before Decision-1. Decisions requests carry a no-data-collection preference, and zero data retention where every endpoint offers it.",
      "Judgment: /v1/judge, /v1/judge/vision, /locate and /long keep the other answers when a noul has no probability, marked noProbability: true; an answer with none stays an uncharged 502.",
      "Search: Neural search sends the legacy fast and instant types as lite and says so, and passes upstream warnings and notices through, screened of hidden characters.",
      "Search: /api/route scores our own rows without their attribution sentences, as /api/find and catalog search do.",
      "Server: /privacy says route, decide and demand-board text can also reach judgment models over OpenRouter.",
      "Server: The web framework takes its November security release.",
      "Server: /health stays 200 while a state database write waits for its retry; the stateDb status word reports the outage.",
      "Server: cve-lookup waits up to 25 s for the NVD record read, which now takes several seconds; the EPSS and KEV reads keep 10 s.",
    ],
  },
  {
    date: "2026-11-13",
    title: "Image header bound",
    items: [
      "Server: the TIFF header reader bounds every tag's declared value count by the file size, whatever the tag's type.",
    ],
  },
  {
    date: "2026-11-12",
    title: "Bazaar listings",
    items: [
      "Payments: every route's Bazaar listing carries a service name, five tags led by its category, a PNG icon, a description, and input and output schemas; the typed-judgment routes keep their whole description and judge's model list beside a link to the full sample answer.",
      "Payments: descriptions keep the sentences around a query hint.",
      "Payments: every Bazaar listing that serves third-party data ends with the attribution that source requires (FRED, CoinGecko, Jupiter, OpenStreetMap, Open-Meteo, NVD), the skill packs that run those tools included; their skill pages and MCP skill files carry the same lines. Catalog search no longer ranks tools on these notices.",
      "Payments: a payment signed against the previous release's 402 is accepted when only the output schema it echoes differs.",
      "Payments: output schemas read from examples type numbers as number, so a fractional answer always matches its listing.",
      "Server: the HTTP adapter used by the MCP connector takes its November security release.",
    ],
  },
  {
    date: "2026-11-12",
    title: "Vendor updates: security releases",
    items: [
      "Server: the HTTP client takes the November undici security release; Stripe calls pin their API version; the MPP and Solana libraries take their current releases.",
      "Server: the Railway configuration runbook covers the December 2026 cutover.",
      "Server: the sanctions list refresh reads the list and builds its address and name sets in short slices, so it no longer holds other requests while it runs.",
      "Server: /api/gateway-status reports xSearchAuthors (a day of X search author reads past its alert level) and mppSubscriptions (on, off, or failed to start).",
    ],
  },
  {
    date: "2026-11-12",
    title: "Leftovers: payer keys, lookups, retirements, site polish",
    items: [
      "Payments: a Solana payment is keyed on its transfer authority when other transfer accounts sit in a lookup table, and x402 v1 Solana payments carry a payer key.",
      "Payments: Solana payments are screened on the transfer authority and every required signer other than the fee payer, and version 1 transactions are read.",
      "Payments: a router seller that answers 200 without taking payment and returns no answer is treated as a failed upstream: the next seller is tried, and if none answers the buyer is not charged on x402 (a Tempo push payment is recorded as owed and refunded).",
      "Payments: the proof that an EVM authorization went unused reads chain time, not the host clock.",
      "Payments: Bazaar service names end on a whole word and stay distinct per tier; the OpenAI-compatible image and transcription routes are named \"Image gen\" and \"Transcribe\".",
      "Server: outbound tools resolve hostnames without the shared thread pool, so a name that never answers no longer delays other lookups; a name server that refuses a query falls back to the system resolver once; every resolved address is checked before a fetch, rendered pages included.",
      "Server: the LLM tiers advertise the successors of the OpenAI models retiring 2026-12-11; the retiring ids are still accepted.",
      "Server: /api/llm-premium's refusal lists every model family it accepts.",
      "Server: the insider, LinkedIn article and IPO reports fence the filer- and publisher-written text they read.",
      "Server: daily upstream ceilings no longer count a call the upstream refused.",
      "Server: /mcp and the revenue view redact secrets from error text, including keys split across lines, cut short, or written as bare hex; transaction hashes stay readable.",
      "Server: six more status words page on their alarm values.",
      "Server: the tollbooth Docker image runs on Node 22.23.5 as a non-root user; a replay store in /var/lib/tollbooth or on a mounted volume, written by an older image, is handed to that user at boot.",
      "Site: every code block on the site has the shared copy button.",
      "Site: /company form fields use the control border; tool page breadcrumbs keep their spacing; wrap fixes on /docs, /tools and tool pages.",
      "Site: /llms.txt is shorter; route descriptions for the MPP start routes moved to /llms-full.txt.",
      "Site: /transparency prints its own last-updated date.",
      "Site: /privacy names the paying wallet of a Solana payment (the transfer's authority) beside its signers.",
    ],
  },
  {
    date: "2026-11-12",
    title: "Home page and company contacts",
    items: [
      "Site: the home page shows Agent402's own figures (uptime, external payments, chains, latency) under the pitch, beside the live view, so the hero no longer leaves open space above the headline.",
      "Site: /company lists the operator mailbox once, with the roles it answers, and the page footer links to contact instead of printing the address.",
    ],
  },
  {
    date: "2026-11-11",
    title: "Node security release",
    items: [
      "Server: the server, facilitator, worker and MCP images run on Node 22.23.5, the November 2026 Node.js security release.",
    ],
  },
  {
    date: "2026-11-11",
    title: "Buyer scorecard, trust page and one story",
    items: [
      "Site: /scorecard and GET /api/scorecard publish monthly buyer counts: outside paying wallets, returning wallets, wallets with paid calls on two or more days, and settled calls and USD by chain, for the current month to date and the six before. Our own wallets and internal traffic are not counted; small counts read <3.",
      "Site: /trust gathers subprocessors, encryption, incident response and restore testing on one page; /company lists the business phone, postal address and role mailboxes.",
      "Site: the home page hero shows uptime, external payments, the chains live and median latency, rendered on the server. The site navigation adds Pricing, Company and Status and one primary action, Add to your agent.",
      "Site: one lead sentence describes Agent402 on the home page, README, llms.txt, the MCP connector and the package READMEs in the repository.",
      "Site: design: form controls share one border token, every control shows a 2px focus ring, pages open with a skip link, prose reads at 16px, small targets are at least 24px, and code blocks share one component with a copy button.",
      "Payments: GET /api/refunds?tx=<hash> looks up a refund by settlement transaction, with found, priceUsd and txUrl fields; the /api/refunds/lookup path answers the same lookup.",
      "Payments: the /v1 settle breaker keys a Solana, Algorand or Stellar payment by its signed payer.",
      "Surfaces: /api/gateway-status carries onchainSqlBusy (ok, alert, unknown or off): alert while a top paying buyer was recently told the onchain query service is busy. Busy refusals are counted per day on the operator views; the query limit is unchanged.",
    ],
  },
  {
    date: "2026-11-11",
    title: "Whose side failed, settle verdicts and rail reasons",
    items: [
      "Payments: a paid /v1 call whose settlement failed counts toward the paying wallet's settle refusal only when the failure is a verdict on that payment: too little of the asset, a bad signature, an authorization already used or expired, or a refused payload. A timeout, a store failure or a facilitator error on our side does not count against the wallet. Settlements of unknown cause refuse the wallet only at three times that count, and that answer says only that settlement did not complete.",
      "Payments: a facilitator's definite 4xx answer to a settlement is no longer read as a settlement that did not complete. A settlement answer of 4xx that names no reason (other than 401, 403, 408 or 429) counts as unknown cause.",
      "Payments: a payment whose verification could not be completed (a timeout, a connection that failed, a facilitator 5xx, 408 or 429, or an on-chain signature check that could not finish) answers reason not-checked with retry same-payment and Retry-After 5, before any other reading of the error: nothing was charged, and the same payment can be sent again.",
      "Payments: on Tempo with direct chain reads (TEMPO_RELAY=off), a payment our server could not read on chain answers 503 with reason chain-unreachable: the credential was not checked, and the same credential can be sent again. This server keeps listing Tempo first in the payment challenges it sends that client. A push credential (a transfer already sent) that could not be checked this way, because the payment relay could not be reached, or because the shared payment store did not answer, is told its transfer has not been claimed and, once final, still pays for the request.",
      "Payments: /api/rails gives each payment network left off at startup a reason word (probe-timeout, read-failed, not-advertised or config) and, while the batched option is on, its status and the networks it dropped. The startup read of each facilitator takes up to three tries when it times out and two when it answers with an error.",
      "Router: the seller index keeps a seller routable when our own read of it fails (our time limit, our resolver, our byte cap, our own network path) and its last completed crawl succeeded within 6 hours; a connection the seller's host refused, reset or failed TLS on is the seller's own answer. ?seller= and the index rows carry lastReadIncomplete and errorKind, the seller dossier says our read did not complete, and a paywall probe that read no status records no verdict.",
      "Router: the seller index backs off a seller whose host refuses connections and stops routing to it.",
      "Router: route-and-execute stops buying from a seller that takes payment and then fails. It counts one delivery strike per payer and distinct request, and the same request from the same payer counts again at its third failure; a seller's 500 whose body names the request's own input is not a strike. No refusal is noted against a seller for a payment method our buyer cannot make, for a challenge that differs only in the caller's query, or for a validity window we shortened.",
      "Router: a seller's payment count read on Algorand or Solana that did not complete reads unknown, never zero.",
      "Tools: a tool error names an upstream as failing only when that upstream answered so. Our own read limit, a call budget spent before any request was sent, our DNS lookup, our own key, allowance or request pacing, and our own internal errors say they are ours; an input long enough to outlast the limit is told to send a shorter one, and a caller's URL that did not answer is told to check it or retry. The hosted connector's free answers read the same.",
      "Tools: a seller or tool host whose name does not resolve reads attribution unknown and counts toward upstream health; only a lookup our resolver could not finish is ours.",
      "Tools: when a provider refuses this server's own key, image generation, embeddings, moderation, text generation and the model gateway say the failure is on our side.",
      "Tools: the onchain query health check keeps a failing reading for one minute, then reads the service again.",
      "Tools: stock quotes keep reading the consolidated dataset after a single 400 answer (400s for two different symbols or a symbol and the range read inside the skip window, or one 401 or 403, still switch to the three-venue dataset), and the three-venue note says the consolidated dataset was unavailable only when it answered so for that read.",
      "Tools: text to speech keeps its primary voices when long texts reach our own time limit; later callers move to the backup voices when the primary link stops answering for several callers. Model calls on the direct upstream link move to the fallback route on the upstream's own answers, not on our timeout or DNS failure.",
      "Tools: text to speech and model calls on the direct upstream link move even a single caller to the backup after three unanswered short requests.",
      "Tools: the GPT Image tools (image-gen, image-gen-hd and image-gen-premium) send the provider's less restrictive content filter level by default (send moderation \"auto\" for stricter filtering; a model that does not take the setting runs at the provider's standard level), and a prompt the model's content check refuses gets a plain 400, not charged on x402.",
      "Tools: image generation sends one request instead of two to a model that does not take the moderation setting.",
      "Surfaces: /api/gateway-status carries topBuyerFailures (ok, alert, unknown or off); upstreamHealth reads unanswered when one upstream did not answer within our limit for several callers while others answered, and facilitatorFunds reads unknown when a settlement signer's balance could not be read, with alert sustained once that has held past FACILITATOR_UNREAD_PAGE_HOURS (default 6).",
      "Surfaces: the upstreamHealth word also reads unanswered for an upstream that answered none of its calls with one caller or background work alone.",
    ],
  },
  {
    date: "2026-11-11",
    title: "Spend alarm, funding refusals and connector answers",
    items: [
      "Gateway: a call naming qwen/qwen-2.5-7b-instruct, which has left the upstream model list, is served on the nano, base or metered tier by mistralai/ministral-8b-2512, the swap named in agent402_model_substituted. The generateContent routes carry agent402_model_substituted for a retired id and for an availability successor, as the chat, Messages and Responses routes do.",
      "Gateway: the upstream lists an expiration of 2026-11-20 for meta-llama/llama-3.2-1b-instruct. A call naming it is served as itself until that day, then by meta-llama/llama-3.2-3b-instruct at the tier and price of the route called, the swap named in agent402_model_substituted.",
      "Gateway: each metered route's tool page, /pricing, /docs, the buying-at-volume, agent-hosts and OpenClaw provider guides, the README and the Buying-at-Volume wiki page state the client timeout to set, and a metered route's first-contact 402 body carries it as clientTimeout (seconds, note).",
      "Payments: a payment refused because the paying wallet holds too little of the asset, or no account for it (no USDC account on Solana, no trustline on Stellar, not opted in on Algorand), says so on EVM, Solana, Stellar and Algorand: the refusal carries reason (insufficient-funds or no-token-account), a sentence with the price and the chain's name, and a needs field with the network, asset, base-unit amount and dollars. Stellar amounts are read at 7 decimals.",
      "Payments: a payment refused in simulation on a network whose balance the server does not read (every network but Base, and Base when the read fails) names the chain and the price and says it is one of two things: the paying wallet holds less of the asset than the price, or the authorization's nonce was already spent or its validity window has passed. It no longer says the wallet covers the price.",
      "Payments: a payment network left off the offer because its facilitator could not be read when the server started rejoins on its own once that facilitator lists it: every 402, /api/rails, /.well-known/x402, /api/pricing and /openapi.json follow. Arc, and the upto and batched accepts on a rejoined network, return on the next restart.",
      "Payments: a settled payment's replay mark is kept about an hour after the call, or until the authorization's own validBefore plus 10 minutes when that is later, at most 30 days after the call. The privacy page and the readsOnly list under payment.dataHandling on /.well-known/x402 state the same hold.",
      "Payments: the log line written for a refused payment names the network, the route and the paying address by its first characters, and shortens the paying address where the facilitator's own text repeats it (an EVM address in any letter case, any other address as written). Other payment log lines name a paying address by its first characters too, except a line written when a payment that may be owed back could not be recorded anywhere else, which keeps the full address so the payment can be returned. The privacy page says so.",
      "Payments: a card report page keeps answering while the card processor is slow: a poll waits up to 8 seconds, then answers generating, and the report starts as soon as the payment is confirmed, with no further poll needed. A poll for a refund still being sent answers within the same wait, with the refund shown as being processed.",
      "Payments: a refused payment credential sent again as soon as its 402 arrives gets that 402 and its retry hint again, not a 409.",
      "Router: route-and-execute keeps buying for paying callers through a busy minute. The per-minute spend ceiling is an alarm: past it purchases are still made and routerSpendWindow on /api/gateway-status reads over (its words are ok, over, capped and off). A purchase is refused only at a hard stop above the alarm, where the word reads capped.",
      "Tools: an attest or feedback call made right after a purchase finds that purchase while its ledger write is still landing: the lookup waits up to 5 seconds for the write.",
      "Tools: the transcription duration caps hold the audio a file plays: the audio is decoded on the server and its length read, and the cap applies to the longer of that and the duration the file's headers declare. A file the server cannot decode is held to the shortest length its byte count can play when it is lossy audio-only in one or two channels at a sample rate of 48 kHz or less; any other file (a lossless one, one with a video track, more than two channels, a higher sample rate or no reported sample rate) keeps its declared length.",
      "Tools: the domain audit and token risk reports (model-backed) pass the records they read (DNS, header and certificate values, registration text, token names, symbols and labels, web reputation text) to the model as quoted data, with the rule to describe them and never follow them.",
      "Tools: the daily call ceilings on upstream services count calls that may have reached the upstream. A call that never left the server (a name that did not resolve, a refused connection, a call its caller had canceled before it was made) gives its unit back.",
      "Surfaces: the hosted connector sends Retry-After on its 429, and its free-tier rate-limit answer says in how many seconds there is room again. A free answer over the connector's size ceiling is cut to valid JSON and says what was cut in answerBound (unit, maxBytes, returned, matched, complete, truncated, cuts, cutsListed, cutsTotal); a paid answer is delivered whole. catalog.search takes a limit of 1 to 25 (10 when the limit is missing or zero); a value outside that range is clamped to it. Tools that can charge (every flagship, catalog.call) are not marked read-only; catalog.search, catalog.find, sellers.list, server.describe and payment.info are. memory.write is marked destructive, since it replaces the value a key held.",
      "Surfaces: the page of a retired tool or skill pack answers 410 with its retirement date and, where there is one, a link to the replacement's page, as its API route does.",
      "Surfaces: /status says when a component's last observation is stale and how old it is. Its two observers are named Scheduled heartbeat and Outside probe on the page, in its method notes and in /api/status.",
      "Surfaces: a request the HTTP parser refuses (a malformed request line or header, a header block over the size limit, a request that never finished arriving) is answered with the X-Content-Type-Options, Referrer-Policy and Strict-Transport-Security headers every other answer carries.",
      "Surfaces: the home page's live figures give up a read that stalls for 8 seconds and keep the values they last showed.",
      "Surfaces: the 429 from a direct proof-of-work redemption carries Retry-After, the seconds until there is room again.",
    ],
  },
  {
    date: "2026-11-10",
    title: "Wire parity and payment answers",
    items: [
      "Gateway: a byte-identical paid repeat on /v1/embeddings, /v1/rerank and cache:true chat is served from the payer's cache when paid with the standard x402 v2 client; from 2026-11-06 those repeats were generated and charged again.",
      "Gateway: a metered body that cannot be served (an unlisted model id, an input over the model's cap) answers 400 before any payment requirement on the Messages, Responses and generateContent routes, as it does on chat completions, each in the error shape its own SDK parses.",
      "Gateway: the Messages and Responses routes answer an unlisted metered model id with 400 (code unknown_model, with suggestions), and an input over the cap names the calling wire's own routes.",
      "Gateway: a buffered Messages or Responses call whose provider refuses the request answers 400 naming the model, as chat completions and every streamed call do; it had answered 502.",
      "Gateway: on the chat, Messages and Responses routes a reasoning effort above low is sent as low when the output cap is under the tier's default output budget, and a reasoning or thinking budget is lowered to leave a quarter of the cap for the answer. An answer that came back empty for length gets one more run on the same model at its lowest effort when the price covers another run and the payment window allows. The answer names the change in agent402_reasoning_adjusted (a response header on a stream); the quote reads the buyer's own values.",
      "Gateway: the metered routes advise a client timeout of at least 120 s on llms.txt, llms-full.txt, openapi, the home page, SKILL.md, the x402 guide, a flat tier's 402, the connector's server.describe and payment.info answers and the LLM-Gateway wiki page: the answer is generated and the payment settled before the response is sent, and a charge for an answer the client did not wait for is recorded as owed and reviewed for a refund.",
      "Gateway: an EVM wallet's repeated settle failures on the /v1 routes are counted per network the payment named, so its 429 holds that network only and carries retry, refusedNetwork, retryAfterSeconds and otherNetworksFrom. A burst of settle failures across buyers refuses nobody; it reads as a status word (settleFailures, unsettledReports: ok or burst) on /api/gateway-status.",
      "Gateway: the settleFailures status word also reads burst when one EVM wallet's unsettled /v1 calls reach the per-network refusing count on three networks inside one window. The word refuses nothing: the wallet is held per network as before, and no other buyer is.",
      "Payments: a first-contact 402 body carries a payment block: this request's price in dollars on the network it names, one sentence on paying, the proof-of-work path on a free-tier tool, the caller's own model, request size and output cap on a body-quoted route, and links to /llms.txt, the pay section of /agents.md and the connector. The header and every other field are unchanged; a self-hosted server removes the block with PAYMENT_GUIDE_402=off.",
      "Payments: a tool call sent with conditional or range request headers (If-None-Match, If-Modified-Since, If-Match, If-Unmodified-Since, If-Range, Range) answers a full 200 on every rail and in free mode. Free documents keep their 304.",
      "Payments: a route quoted per request prints one from price on /api/pricing, /openapi.json, its tool page and llms-full.txt: the smallest amount its 402 can ask. Decide reads its quick depth there.",
      "Payments: the paying wallet of an MPP monitor subscription is screened before its first payment and before each renewal, as per-call payers are. A refused first payment answers the Tempo rail's 402 and nothing is sent; a refused renewal is not sent and ends the subscription with the reason payer-not-accepted on its status answer.",
      "Payments: an MPP subscription's signing key is deleted when the subscription is canceled or ends. The ended record is reduced to its id, product, payment rail and wire, a flag for one of our own test subscriptions, wallet, key address, chain, currency, amount, period, dates, final state, cancel reason, last transaction and a marker for a charge that was never confirmed, and deleted 30 days after the end.",
      "Payments: the card report route generates, records and refunds only for a paid Checkout session that names a report product; any other session answers invalid. A report whose product left sale after the purchase is still refunded, and an owed card refund is retried and counted in refundsOwed only when it belongs to a report purchase.",
      "Router: when a seller refuses route-and-execute's paid request as invalid input and the caller's params lack body fields the seller's published request contract requires, the answer is 400 naming those fields; it had been a 502.",
      "Router: one deadline bounds a seller purchase across its requests: a signed payment is not sent or resent past it, and route-and-execute answers 504, with nothing spent and nothing charged, when a candidate would start with too little time left.",
      "Router: a refused Solana purchase releases its hold only when the finalized block height read from our own RPC is past the blockhash's last valid height and a debit scan shows nothing; an unreadable height keeps the hold.",
      "Router: a purchase is recorded when its payment is signed, at the address the signed payment names, and the record is taken back only when the payment provably moved nothing. A listed route whose text joins to a URL outside its seller's key is not ranked.",
      "Router: a Tempo purchase refused before signing names a seller-supplied value (currency, chain id, method, intent) only when it has the shape of a token address, a number or a short identifier, and in fixed wording otherwise.",
      "Router: /api/find ranks a tool named for the opposite conversion direction (the task says X to Y, the tool is Y to X) below every other match and marks the row reversed: true. When no tool states the direction asked for and the top result does not mention both ends, the answer carries direction.served: false with the miss hint. catalog.find on the connector passes the same fields.",
      "Router: a seller tool name longer than 10 words does not score as a slug alias, so a sentence in the name field does not outrank a tool named for the task.",
      "Router: the two per-client 429s on /api/find and /api/route name their rule and say that tool calls, paid or proof-of-work, are not counted against the search limit.",
      "Tools: a transcription call whose upstream answers a 5xx, a rate limit naming a wait of at most three seconds, or a failed connection gets one more attempt on the same model inside the time cap the call already had, when at least 20 s of it remain. A served second attempt carries agent402_retried {attempts, reason}; a 5xx on a route call says nothing was charged and names the other transcription path.",
      "Tools: markdown-to-html gives a document in its ordinary lane 1 s to render; past it the document starts again in the lane for slow documents under that lane's deadline. Waiting in the ordinary lane is fair by client address: the caller with the least render time used goes next, and one address holds at most 128 places.",
      "Tools: the PDF, image, HTML, regex, markdown and office parser workers start with an allowlisted environment.",
      "Tools: exa-search, exa-answer, exa-contents and the X data tools keep serving past their daily alarm ceiling, where exaSpend and xDataSpend on /api/gateway-status read over; at a higher hard ceiling a call answers 503 and the word reads capped. Each word is read from the day's count shared across containers, so it keeps its reading through a restart, and it reads capped for an hour after any call is refused at the hard ceiling.",
      "Operations: /status and /api/status list each observer of the paid call path with its own state, age and staleness bound (current.sources); an observer past its bound reads not current beside the one the component's word comes from.",
      "Operations: on /api/gateway-status, sharedLimits and replayStore carry a second word, alert, that reads sustained once the first has held ten minutes without a break, and backup.status reads unconfigured in production with a state database and no backup bucket. The status Worker and the heartbeat page on these and on gatewayBalance.",
      "Operations: call-log rows older than TOOL_CALLS_RETENTION_DAYS (default 180, never under 31) are deleted daily; the URL tools (extract, meta, dns, render, screenshot, pdf) and the memory routes write one call-log row per call.",
      "Operations: a second merge to main queues behind a running release instead of canceling it, and the deploy, publish and probe jobs carry time bounds.",
      "Operations: timing checks in the test suite read the thread's own time or counted work, so a busy runner does not fail them.",
      "Surfaces: pack and report copy names the data each product reports: the storefront's fund card is headed by a fund's 13F holdings, and the macro packs name the series, its source and its as-of date. Card report copy says the charge is taken at checkout, and llms.txt offers decide-execute for a wallet payment only.",
      "Surfaces: every page that describes a failed call as not charged carries the same late-settle exception.",
      "Privacy: /privacy and /terms list how long an async job's or MCP task's result is kept, the screening of subscription payers, the reduced record of an ended MPP subscription, and the daily count of searches the free search routes turned away.",
      "Docs: the buying-at-volume guide and wiki page state the metered pre-payment refusals for every wire, and the LLM-Gateway wiki page states the provider-refusal 400 for every wire; Self-Hosting documents the payTo variables and BASE_URL; every markdown install line pins the agent402-mcp version.",
    ],
  },
  {
    date: "2026-11-09",
    title: "Tool and payment bounds",
    items: [
      "Tools: image-crop and image-dominant-color decode in the image worker pool, like image-resize, image-convert and image-thumbnail, with a 15 s deadline; a busy pool answers 503 and nothing is charged.",
      "Tools: the image tools read each format's header the way its decoder does (a GIF's first frame and its codes, a PNG's chunk list, a JPEG's frame headers, a TIFF's directories) and answer 400, naming what was wrong, when a file's header and contents disagree. An interlaced PNG is inflated under a bound for its declared size. A TIFF decodes from its first image; a CCITT fax page decodes in an isolated process. TIFF compressions 9 and 34316 are not decoded.",
      "Tools: business-days counts by arithmetic, so a range of any length answers at once.",
      "Tools: markdown-to-html renders every document with the same heading ids as before; documents over 2,500 characters render in a dedicated worker with a 10 s render deadline (400 when the document's markers are the cause, 503 otherwise, never charged).",
      "Tools: json-to-csv writes large sheets in slices and serves up to 10,000,000 cells or 16 MB of CSV; a larger sheet is refused with its row and column counts and how to split it.",
      "Tools: openapi-resolve-refs reuses resolved schemas and serves up to 16 MB; a larger result answers 413 and says to resolve the spec in parts.",
      "Tools: a proof-of-work tool whose input holds a value that cannot be coerced answers 400 with the field named; other errors are unchanged.",
      "Payments: a payment that settles a signed transaction (Solana, Algorand, Stellar) is identified by that transaction alone, and a Permit2 payment by its signed permit, for retries, payer attribution and payer screening; an authorization block no signature covers is removed from the header before anything reads it.",
      "Router: seller-written names and descriptions are cleaned of markdown links and images in a single pass, in time linear in their length.",
      "Router: route-and-execute names no paying chain for a payment header that names two different networks, and answers its ordinary refusal.",
      "Router: a registry-only listing larger than the per-seller tool cap is cut to the cap before the crawl's passes run; stored tools and reported totals are unchanged.",
      "Site: pinned install commands such as agent402-mcp@0.13.31 arrive intact in page HTML for readers that run no script.",
    ],
  },
  {
    date: "2026-11-08",
    title: "Buying at volume",
    items: [
      "Docs: a buying-at-volume guide (/guides/buying-at-volume, wiki page Buying-at-Volume) for agents that buy in bursts: the per-address limits and their Retry-After, retries that never pay twice, async jobs, spend caps in agent402-client, agent402-mcp and agent402-openclaw, which rails settle when, metered model ids and input caps, and the errors to handle. llms.txt and the three package pages link it.",
      "Gateway: the /v1/metered unpaid-quote 429 carries Retry-After: 60, retryAfterSeconds and a guide link.",
      "Gateway: once a client address has paid (a final 200 that settled on any rail, or a credits debit), its unpaid price checks read against 10 times the hourly figure for the rest of that clock hour and for 10 minutes after each paid call, and past the plain /v1/metered quote figure each paid /v1/metered call from that address earns 2 more quotes, used within 10 minutes, up to 10 times each figure; on the shared Worker egress address the whole address keeps its ceiling; a refused payment credential still counts.",
      "Docs: a content-pipeline guide (/guides/content-pipeline, wiki page Content-Pipeline): research, script, voiceover, images, transcription, subtitles, dubbing and media checks as paid calls from one wallet, with a runnable example per stage, an end-to-end flow, the stages that run as jobs, spend caps and Tempo pull and push. llms.txt and the buying-at-volume guide link it.",
      "Gateway: inception/mercury-2.5 reached its upstream expiration and is no longer listed; a call naming it is served by google/gemini-3.1-flash-lite with the swap named.",
      "Payments: a resend of a payment whose answer was charged but never delivered gets a 503 (replay_pending, Retry-After: 10) while the ledger has not yet confirmed that answer as served; nothing more is charged, and a retry with the same payment receives it.",
      "Payments: when the Tempo relay does not answer whether it claimed a push transfer, the 503 says so (transferClaimed: null); when the ledger records the transfer as owed, the 503 also carries refundOwed: true, and a retry with the same credential that pays for the request voids that debt.",
      "Payments: a Tempo pull payment answered 402 after its broadcast failed is read on chain again (by default 15 s, 45 s and 2 minutes later); a transfer that lands after the 402 is booked as owed, to be refunded.",
      "Payments: a keyed call whose client closes its connection keeps its claim until the run ends, so a retry with the same key gets 409 idempotent_request_in_flight, then the stored answer, never a second run.",
      "Payments: a credits call whose client leaves after the response headers is decided when the response ends: a response of 400 or above, a replay or a cache hit is not debited, and a metered call is debited its metered amount, never the whole hold.",
      "Payments: a card subscription status event that arrives late never reactivates a canceled subscription.",
      "Payments: refund recipients are screened like every payout; a held refund logs a fixed reason and stays owed.",
      "Tools: the company-dossier and financial-research packs return 90 days of Form 4 insider trades; their insider step had been read at the 30-day default.",
      "Tools: wallet-audit looks up metadata for a token the wallet holds, not for the wallet address; a wallet holding no tokens gets a 422 on that step.",
      "Tools: report products, the image edit route and the subtitle-pipeline and search-and-cite packs say model-backed in their descriptions.",
      "Router: a seller's 402 must name the URL requested (the same origin, the same path or the route mounted under a path prefix, and the same query); one naming another resource is refused before anything is signed.",
      "Router: a GET seller is probed at its bare listing URL first; while candidates are compared, the caller's inputs reach one only when that probe answers 400 or 422.",
      "Router: Algorand sellers are paid only at the address their settlement proof names.",
      "Router: when several proven sellers on one chain refuse our payments with no settle between them, routes on that chain are not benched until a payment there settles.",
      "Site: the navigation puts live, status and llms.txt in the menus.",
      "Operations: /api/gateway-status reports lateSettlements (ok, near_capacity, full, unresolved) for settlements whose outcome was not known when the call was answered, and replayStore (ok, pending) while a settled payment's consumed mark waits to reach the shared store.",
      "Operations: an operator closes an unresolved late settlement as booked owed, paid (with its refund transaction) or dismissed, and each resolution is recorded before the entry is dropped; unresolved entries are read on chain again every 6 hours and close once the chain answers.",
      "Operations: a Tempo pull transaction that lands after its 402 is booked as owed even past the per-process watch bound or across a restart: every watch is on record, and a one-minute sweep reads any the process did not finish.",
      "Operations: Tempo subscription gas sponsorship has a rolling 24 h ceiling on transactions and fees, with a fifth of each held for renewals; past it a send is refused before broadcast, and /api/gateway-status reads subscriptionFeePayer.ceiling=reached.",
      "Privacy: the shared record that an address paid recently is keyed by a keyed hash of the address, never the address or a plain hash of it, and expires within the hour; /privacy names it.",
      "Privacy: /privacy says a candidate seller may receive a request's inputs unpaid before it is paid, sometimes more than once.",
      "Privacy: /privacy and /.well-known/x402 name the Tempo pull credential kept, with its route, amount and payer, until its late-landing check ends (at most 24 hours while the chain cannot be read).",
      "Privacy: /terms says an x402 payment on an EVM chain, or a Tempo transaction, that lands on chain after an error answer is recorded as owed and repaid, and that a repayment is checked against the published sanctions lists first.",
    ],
  },
  {
    date: "2026-11-07",
    title: "onchain-sql price, X data tools, Solana token search, metered chat, OCR and fetch errors",
    items: [
      "Tools: onchain-sql is $0.030 a call (was $0.040), and a call still sends the query service at most 3 queries. The onchain-analyst pack follows the tool's price.",
      "Tools: x-tweet no longer reads the author: the tweet carries authorId, its author username, name and verified fields are null, and its link is the /i/web/status form.",
      "Tools: x-user-tweets is $0.09. Looked up by username, the account's profile still fills user and each row's author. Looked up by id, the author is not read: rows carry authorId, null author fields and the /i/web/status link, and user carries the id with null username, name and verified.",
      "Tools: x-search-recent is unchanged.",
      "Tools: sol-token-search finds a Solana token whose ticker is busy on other chains: when the pair search holds no matching Solana pair, the mints come from a Solana token index (verified first) and their pairs are read by mint. The answer says whether that fallback ran, names both sources when it did, and carries the partial-answer fields. No pair found while a fallback read did not answer is a 5xx, never an empty answer.",
      "Tools: image-ocr answers 422 for a body that is not an image it reads (a PDF, a webpage, an SVG), naming what it got and the formats it reads (PNG, JPEG, GIF, BMP, TIFF, WebP, PNM), and 422 for an image that does not decode or whose header does not give its size, where it answered 500 \"OCR failed: unknown\". An image over 64 megapixels or 32,767 pixels a side is a 422 (image-too-large) before it is decoded, naming maxMegapixels, maxSide, the image's width, height and megapixels, the longest side to downscale to (downscaleToLongestSide, also in fix) and a howToCall with a note to resend the image downscaled. One image over 16 megapixels is read at a time; another waits up to 15 s, then answers 503 (large-image-busy) with Retry-After.",
      "Tools: a tool that fetches a URL answers a source host that times out or refuses the connection with a 504 carrying attribution \"upstream\" and the hint source-timeout or source-unreachable, so a caller can retry later or pick another host.",
      "Gateway: a metered model id written with a hyphenated version (v4-1 for v4.1) is served as the dotted id when that exact id is on the upstream's live list; any other unknown part is still refused. The unknown-model 400 carries suggestions (the closest served ids, at most three) and a howToCall that retries with the first.",
      "Gateway: the metered routes take 200k input chars on every model and more on a model with a larger context window (three chars per window token, up to 1,000,000), each request still quoted from its own body. An input over the cap is refused with maxInputChars, inputChars, a trim-input hint and models whose window takes it, before payment on /v1/metered/chat/completions.",
      "Operations: a /v1/metered/chat/completions input refusal answered before payment is logged and counted like a handler 400, marked pre-payment.",
    ],
  },
  {
    date: "2026-11-06",
    title: "Ink rail",
    items: [
      "Payments: Ink (chain 57073) is a listed rail: x402 payments settle in native USDC on Ink, named on every surface that lists the chains, with its own chain page.",
      "Payments: a chain page links the service's wallet on the chain explorer even before the rail's first revenue reading.",
      "Packages: the buyer client, MCP server and OpenClaw plugin price and sign Ink USDC accepts, and refuse an Ink accept that names another EIP-712 domain than the token's own (agent402-client 0.8.25, agent402-mcp 0.13.31, agent402-openclaw 0.5.11).",
    ],
  },
  {
    date: "2026-11-06",
    title: "EVM router chains, call hints, package limits",
    items: [
      "Router: the router buys from proven sellers on each EVM chain the operator lists, with the same price binding, validity cap and spending caps per chain as on Base, and each listed chain counts toward the global unsettled-spend ceiling.",
      "Agents: an input-validation 400 carries howToCall: the method, URL and a ready request body from the tool's own example, plus a query-string form where the route serves one; the first-contact 402 body carries the same call, or the method and URL alone when the example is large.",
      "Payments: a cached gateway answer is served only to the payer that settled it, on a payment not already used.",
      "Payments: a Stellar refund or settle confirmation counts USDC only from its pinned issuer, and a refused settle releases the authorization's claims so the buyer can retry.",
      "Packages: the buyer client (with an x402Client), MCP server and OpenClaw plugin refuse to sign an authorization valid for longer than 24 hours, except the client's batched payments, which keep their own limit of seven days and an hour; a held amount is released ten minutes after its authorization expires (agent402-client 0.8.24, agent402-mcp 0.13.30, agent402-openclaw 0.5.10).",
      "Packages: the MCP server redacts its configured keys from every result, error and log line; the OpenClaw proxy removes its credits key from error logs and error answers, and its doctor no longer prints it.",
      "Packages: Tollbooth grants a charged request only when its payment middleware took a payment; a charged request whose method the middleware does not price is answered with a 402, so price every method served (agent402-tollbooth 0.11.0).",
      "Operations: the heartbeat opens one issue when a repository security advisory waits in triage for more than a day; the issue names no advisory.",
      "Agents: a call to a retired tool through catalog.call names its retirement date and replacement, as the HTTP route's 410 does.",
      "Operations: retired-route answers are counted by coarse source (client family, referring host, payment rail, HTTP or MCP), with no address, wallet or full user agent kept.",
      "Operations: the EVM wallet alarm also opens when an enabled chain's balance cannot be read for an hour, and the status probe pages on it.",
    ],
  },
  {
    date: "2026-11-06",
    title: "Stellar settle confirmation",
    items: [
      "Payments: a Stellar settle that the chain confirms is matched to the payment it signed: asset, amount and transaction, and each confirmed transaction serves one request.",
    ],
  },
  {
    date: "2026-11-06",
    title: "Router buyer price binding",
    items: [
      "Router: the router's buyer signs exactly the price it checked against its caps, on every challenge version, and refuses a seller accept whose price fields disagree; a live quote with disagreeing fields reads as unpriced.",
    ],
  },
  {
    date: "2026-11-06",
    title: "Settler alarm, direct upstream switch, facilitator map",
    items: [
      "Payments: a payment whose payload declares an x402 version other than the one this server offers is answered with the 402 offer instead of being matched.",
      "Payments: payment headers are read once at intake through one decoder and passed on in canonical form, so every check reads the same payment.",
      "Payments: a Stellar payment's signed authorization is claimed before it settles, so one signed payment is served once.",
      "Payments: the Tempo buyer pays only challenges whose method details it recognizes.",
      "Payments: MPP subscription renewal reconciliation reads the renewal amount in base units and finds a renewal that landed after a timed-out send.",
      "Payments: MPP subscription activation signs with its own 25 s validity window, so a timed-out activation cannot land after its answer.",
      "Operations: a subscriptionRenewals status word reads unconfirmed when an MPP subscription renewal has stayed unconfirmed for longer than its alert window, and the heartbeat and status Worker page on it.",
      "Operations: a robinhoodSettler status word reads relayer when our own relayer has settled Robinhood Chain sales in place of the listed facilitator for longer than its alert window, and the heartbeat and status Worker page on it.",
      "Operations: the manifest's facilitator map names only chains this server offers.",
      "Payments: a 402 exposes to browsers only the headers it carries, and the MPP charge challenge leaves out the output schema the x402 challenge already holds, so every 402 stays well inside common header limits.",
      "Gateway: an optional direct inference upstream, off unless set, serves listed models on the chat wire with zero data retention requested on every call, and falls back to the usual route on any failure; while it is configured, the privacy page names it under third parties.",
      "Operations: the repo's paid buy scripts price offers from a known asset table, sign only the amount that passed their cap, and refuse a target outside this service unless told otherwise.",
      "Packages: viem is 2.57.16.",
      "Packages: agent402-client 0.8.23, agent402-mcp 0.13.29 and agent402-openclaw 0.5.9 price an offer by the field its challenge version signs, check the signed amount before sending, and openclaw removes its per-call cap only with an explicit acknowledgment.",
      "Packages: agent402-client and agent402-mcp keep a sent payment's signed amount held against their caps until its authorization can no longer settle, and an error after sending reports the payment as unknown rather than unpaid.",
    ],
  },
  {
    date: "2026-11-05",
    title: "Robinhood facilitator order, public-index disclosure, job buys",
    items: [
      "Payments: on Robinhood Chain the server settles through the first listed facilitator whose /supported confirms exact at boot, so a primary that does not answer then leaves the rail on the next one; a listed facilitator's refusal that is not about the buyer's payment moves to the next listed facilitator before our own relayer, and a refusal about the payment itself is never retried.",
      "Privacy: when the facilitator that settles Robinhood Chain publishes settlements on a public index, the privacy page names it and what it publishes, the terms, /.well-known/x402, llms.txt and the Robinhood page point there, and the pages print the date it began.",
      "Operations: the operator view of first-call grants counts refusals of wallets that never paid by reason and route, apart from returning buyers, so a route a newcomer wanted shows up by name.",
      "Operations: every Playwright install in CI goes through the bounded apt helper, and a guard fails any workflow step that runs apt directly.",
      "Operations: the listing pass and the other catalog buy scripts send Prefer: respond-async to slow routes and follow the job to its answer; a failed job counts as a failed buy, and records keep a job's state, never its link.",
    ],
  },
  {
    date: "2026-11-05",
    title: "Payment libraries on x402 2.30, a wider unproven lane, one spend workflow",
    items: [
      "Payments: the x402 libraries are 2.30.0 and mppx 0.17.1. A money or identity check that runs before verify or settle and fails refuses the payment with a 402 and charges nothing; a Tempo charge whose broadcast is rejected as a replay recovers its receipt instead of answering a new 402.",
      "Router: on Base an unproven seller is tried up to $0.05 a call (was $0.01), only after every proven candidate, paid at its own live 402's payTo, with at most $0.25 a day per seller and $5 a day across all unproven sellers.",
      "Router: the unproven lane's terms name only the daily caps that are switched on, and the seller-trust and seller-dossier examples show the lane as the tool answers on a default host.",
      "Tools: linkedin-article takes images only from fast-tier links its resizer can read; the fast tier still serves WebP to buyers.",
      "Router: the per-seller unproven cap keys a path-scoped seller on its origin plus prefix, so tenants on one host keep their own day; each cap window keeps a running sum, rebuilt from the window when invalid and at least daily, so an older build during a deploy overlap cannot drift the cap.",
      "Monitoring: the heartbeat signs its paywall read, and the status Worker pages \"Paywall not observed\" after three unobserved runs.",
      "Security: a standing red-team suite runs in CI against the MCP connector, the seller judge, decide, the fetch guard, the router's payer and report prose. MCP refusals quote an echoed name as data, and the listing and judge screens read markup-split, lookalike and tool-abuse wordings of the same text.",
      "Router: route-execute is graded step by step in CI: 56 fixed tasks run the real paid server, resolver and payer against stub sellers and check every step from the candidate set to the receipt. The unproven lane reads the same verdict as the public label, at the seller's live payTo, so a seller paid at a shared settlement wallet is not tried there.",
      "Security: in FREE_MODE identity-bound routes take no wallet identity from an unverified payment header (memory uses its demo namespace, the others answer 400); TRUST_PROXY_HOPS defaults to 0 when unset, with a boot warning; MCP prompt arguments are quoted as data, bounded and stripped of hidden characters; a paid server answers a job created by a FREE_MODE server as not found.",
      "Upgrade note: TRUST_PROXY_HOPS unset now reads 0 (it read 1), and an explicit 0, which used to read as 1, is honored: set TRUST_PROXY_HOPS=1 behind one edge proxy. With no hop trusted, the server warns once when a loopback or private peer sends X-Forwarded-For. Without it, every visitor behind the proxy reads as the proxy's one address and shares its rate limits.",
      "Limits: the unpaid price-check budget counts per client address (an IPv6 /64 as one) whatever the User-Agent; a named indexer or search crawler reads against ten times the budget on its address, each User-Agent on Cloudflare's shared Worker address gets its own budget under a ceiling for the address, and only our signed probes are exempt.",
      "Index: a failed paywall check is re-run after 24 hours and when a seller registers again, and the check skips a templated route.",
      "Gateway: /v1/images/fast now falls over to Recraft V4.1 Flash (WebP) and /v1/images/generations to MAI-Image-2.6 Flash (PNG), ahead of GPT-5 Image Mini's upstream expiry; the former id is still accepted in model. The live model guard checks every image, video and speech link's upstream expiration date.",
      "Speech: /v1/audio/speech and the /api/tts backups move from MAI-Voice-2 and MAI-Voice-2-Flash (upstream expiry 2026-12-31) to MAI-Voice-2.1 and MAI-Voice-2.1-Flash, with a distinct English voice per voice name; the former model and voice ids are still accepted.",
      "Pages: operator pages tell search engines not to index them, and the sitemap lists only pages that are their own canonical.",
      "Pages: structured data names one site entity, Agent402, part of Havok Holdings LLC, as every page's author and publisher.",
      "Pages: report, skill, blog, guide, docs, category and marketplace pages show a breadcrumb trail that matches their structured data, and seeded SEC report pages carry the date of the newest filing they show.",
      "Surfaces: the agent hosts guide adds Agent402 to a HarnessRouter workspace as a remote MCP server under Add-ons, with a harness create that lists the connector, the free proof-of-work tools, and how paid tools answer on the connector.",
      "Operations: the spend jobs run from one workflow, each behind the same approval; only the listing pass is scheduled (weekly, still waiting for that approval, and paging only when it ran and failed).",
      "Packages: agent402-mcp 0.13.28 runs on x402 2.30 and MCP SDK 1.32.2, and every install pin names it.",
    ],
  },
  {
    date: "2026-11-05",
    title: "Audio-only decoding, refused redirects answer 400, documented gateway fields",
    items: [
      "Index: the index keeps at most 5000 tools per seller, described tools first, and shows the listed count beside it.",
      "Index: a seller listing that cannot be read is dropped alone; every other seller still routes, and /api/gateway-status gains containedTurns and brokenListings.",
      "Gateway: on the Messages wire, citation text counts against the tier's input cap.",
      "Tools: media-info, audio-convert and audio-normalize decode audio streams only. media-info still lists every stream: a video, image or subtitle stream is read from the container headers and carries decoded: false, with null for a resolution only its decoder would know. A file with no audio stream converts to nothing and answers 422, as before.",
      "Tools: render and screenshot answer 400 (not charged) when the page's navigation is redirected to a host the browser may not load, instead of rendering the refusal as the page.",
      "Tools: html-frames runs documents in a browser of its own with the JavaScript JIT off, so WebAssembly is not available to a document; plain script, canvas, SVG and CSS animation render as before. After 5 failed documents from one payer in 10 minutes, the next answers 429 with Retry-After.",
      "Tools: a2a-card-fetch answers the address check's 400 for a host it may not reach, the same answer every URL tool gives.",
      "Tools: URL tools answer 503 with Retry-After when this server's resolver cannot answer a lookup, and the one 400 for a name that does not exist. A host name without a dot is answered with that 400. favicon-grab refuses a non-http scheme.",
      "Gateway: the Responses and Messages wires pass each input item, content block and tool on with its documented fields only.",
      "Index: a seller registration naming one of this server's own hosts is refused.",
      "Index: a seller listing with a number, object or array where text belongs is stored with text fields (numbers become their digits, anything else is dropped), and every seller page, route and search reads it as text.",
      "Reports: a public report's JSON has its own address, /reports/public/<id>.json.",
      "Packages: agent402-client 0.8.22 resends its own request once when the connection failed before any answer (a closed keep-alive socket), with the same headers and Idempotency-Key; retryResets: false turns it off. A caller's payFetch is not wrapped; resetRetryFetch is exported to put under a payment wrapper.",
    ],
  },
  {
    date: "2026-11-04",
    title: "Office files from data, shorter pages, one page per adapter",
    items: [
      "Gateway: inception/mercury-2.5 leaves the auto tier's fast band ahead of its upstream expiration on 2026-11-08, a date every model of its family carries. A call naming it is served as itself until that day, then by google/gemini-3.1-flash-lite at the tier and price of the route called, the swap named in agent402_model_substituted.",
      "Tools: new xlsx-create, docx-create and pptx-create ($0.003 each, wallet only) turn structured data into a real Office file in one call, answered as base64 with its size, content type and filename, the same shape as the PDF tools. xlsx-create takes sheets of rows (arrays, or objects with an optional column order) with a bold, filled, frozen header row by default, optional header styling, column widths (auto-sized otherwise) and number formats; every cell is a literal value and text that starts with = + - or @ is written as text with the Text format, never a formula. docx-create takes a title and markdown (headings, emphasis, lists, task lists, tables, code blocks, quotes, rules, links). pptx-create takes slides with a title, bullets in up to five levels, an optional table and speaker notes, plus an optional title slide.",
      "Tools: the Office builders fetch nothing: a link is written as a hyperlink and an image as its alt text linked to its address. Each call is bounded (sheets, rows, cells, slides, bullets, table sizes and table cells, 100,000 characters of text in a request body of up to 2 MB, an 8 MB file): an input cap answers 400 naming it, the file size cap and the build deadline answer 422, and the file is built in a worker thread.",
      "Surfaces: the agent hosts guide adds Agent402 to a Paperclip company as a custom MCP server, with the free proof-of-work tools, how paid tools answer on the connector, and the per-action Allowed, Ask first and Off settings.",
      "Surfaces: the home page is five blocks: the hero with the live payments panel, the agents and people doors (the free tier in two lines, Decide as a table row), three short claims with one row of chain marks, a two-line seller block, and four questions. The seven full claims and the comparison table moved to /docs#why (/why and /compare redirect there); the seller board lives on /leaderboard, the demand ranking on /tools/bestsellers and the proof-of-work demo on /playground, each linked from the page.",
      "Surfaces: /agentic-finance, /sell, /what-is-x402, /what-is-mpp, /faq and /docs read shorter: one-sentence openings, one call to action per target, one x402 vs MPP table (on /what-is-x402), FAQ questions grouped under headings, and /docs titled Docs; /terms states that prepaid credits are not currently sold.",
      "Surfaces: chain pages and /marketplace keep their shared legend and scope notes in one collapsed \"About these figures\" block; each framework adapter has one page at /integrations/<slug> with its configuration table (/docs/adapters/<slug> redirects there); tool, integration and /markets pages share one failed-call footnote; openings name the chain count and link the one chain list on /pricing; page titles are plain descriptions.",
    ],
  },
  {
    date: "2026-11-03",
    title: "Replay claims at a deploy, pending settles explained, sweeps follow jobs",
    items: [
      "Payments: while another container may be serving (more than one replica configured, the first 120 seconds after a container starts serving, set by DEPLOY_OVERLAP_SECONDS, or a drain), a paid call on any route answers 503 with Retry-After when the shared payment store does not answer, before any payment is verified or settled. A lone container past that window serves fast routes on its own claim, so a store outage does not stop sales; a long-running route needs the shared store as before.",
      "Payments: a re-sent x402 payment is matched by its network, signed payer and nonce, so two wallets or two networks signing the same nonce are two payments; marks an earlier build wrote are still honored across a deploy.",
      "Payments: a settle fallback that answers pending with a transaction is read on chain like the primary's, and the call is served once the transfer to us is proven. When no noted transaction is confirmed in time, the 402 says so: reason settlement-unconfirmed, retry watch-transaction, the network and the transactions to watch, and that a transfer which still lands is booked as owed and repaid after on-chain proof. Listed on /x402-test; the no-receipt exception on /agents.md, /llms-full.txt and the guides names this case beside a timed-out settle and a disconnect during settle.",
      "Payments: a buyer whose connection closes while its settlement is already in flight spends no hang-up forgiveness budget: the log reads SETTLE UNCONFIRMED (a late transfer is booked as owed) in place of NOT CHARGED, and SETTLE WITHHELD when no settlement was sent.",
      "Payments: a settlement sent while the buyer was connected is a settlement outcome whether or not the buyer stays: one that fails after the buyer closes counts toward the wallet's settle breaker and the composite guard like one whose buyer stayed, and one that succeeds records the sale beside the owed charge. The \"settlement sent\" mark is set where the charge leaves: a settle the authorization claim refused is never read as sent, so that hang-up spends forgiveness budget as an abandoned run and feeds the breaker nothing.",
      "Payments: the Tempo gate and the card gate require the shared replay claim on the same rule as the x402 dispatcher: on a long-running route always, and on every route while another container may be serving (more than one replica, a deploy's overlap window, a drain). With the shared store configured but unreachable, a Tempo pull or push credential or a card credential is refused 503 with Retry-After before the handler runs, before a push transfer is claimed and before a card is captured; past the window a lone container serves on its per-process claim.",
      "Payments: a settled payment's consumed mark in the replay guard keeps the guard's default hold (one hour). Only a grant that was not settled (a hang-up the forgiveness budget forgave) is held to the authorization's own validBefore plus a margin, since that authorization is still live on chain. The privacy page and the readsOnly list under payment.dataHandling on /.well-known/x402 name the mark (a digest of the payment's network, signed payer and nonce) and the same hold.",
      "Tools: onchain-sql is $0.040 a call (was $0.020), and a call sends the query service at most 3 queries: the query itself and up to 2 recovery runs (the row-size measure, then the filtered run or a small re-run). A call that reaches the cap without an answer is the uncharged 422 with hint narrow-query; the original query is never resent, and small rows served from the re-run are marked truncated with a note naming the cap. The onchain-analyst pack follows the tool's price.",
      "Tools: an upstream read that would start with under 5 ms of its budget is refused as the budget's deadline before any request leaves, instead of leaving with a cap too small to use.",
      "Surfaces: a seller's own rows on /api/index?seller= carry the same executeVia fields as route rows (callable now, its lane, or when it becomes eligible). html-frames' published example fits its 402 whole, and a paid sweep that meets an example the 402 shortened replays the full one from /openapi.json instead of the placeholder.",
      "Operations: the Bazaar keep-alive sweep follows a slow route to its settlement: a route that refuses a synchronous paid call is called again with Prefer: respond-async and its job polled at the Retry-After it names until it succeeds or fails; a failed job's status and body are read from its error, and it is never retried as a second paid job. The deploy job validates the new build's flagship Bazaar listings after the deploy is verified, keyless, up to three runs a minute apart: a clean run passes, an INVALID run with no clean run fails the job, and three unreadable runs warn.",
      "Operations: every shared-store wait (the hang-up ticket, the per-payer spend reserve, journals, idempotency, the first-call store, the shared market-data and geocoding reads, the cache, the database ping, lease release, the shared limiters) counts loop time, so an answer that landed while the loop was held is read before the deadline expires instead of being booked as a store that did not answer.",
      "Operations: the revenue snapshot's boot warm-ups (a scan of every rail over public chain RPCs) are off under X402_INDEX_CRAWL=off, X402_SYNC_ON_START=false or REVENUE_WARMUP=off; before, two of them ran on every boot that configured a wallet, test boots included.",
    ],
  },
  {
    date: "2026-11-02",
    title: "Agent front door",
    items: [
      "Surfaces: /llms.txt (after its title, summary, base URL and full-text link), /agents.md and the MCP server.describe answer open with the same three-line front door: the first call (web.search, with web.answer beside it) at its catalog price; access with no account or API key, led by the proof-of-work tools that run free with no wallet (counted from the catalog, listed at /api/pow), then pay per call in the stablecoins and over the wires this server offers (named from its live configuration); and when to use the service and when not to, linked to /agents.md. server.describe's startHere.firstJob opens with the same first call. With FRONT_DOOR_402=on, the unpaid 402 body also carries the access line and the /agents.md link (off by default). Rails and wire detail follow unchanged.",
      "Surfaces: new /agents.md (text/markdown, free): the front door, then \"When a call fails\" (four recovery lines, each scoped to where it holds), then how to connect, pay and find more tools. Linked from /llms.txt, listed in the sitemap and robots.txt.",
      "Surfaces: the OpenAPI info description and the /.well-known/x402 summary lead with what the first call returns for its price.",
      "Discovery: the Bazaar listings of web search, web answer, news search and browser render say what one call returns; the search and news sample outputs show two results with a matching count.",
      "Tools: when shareable answers are enabled (ANSWER_SHARE=on, off by default), web.answer takes share=true (same price): the answer also carries share: { url, cardUrl, expiresAt }, a public page of the question, the answer and its cited sources with a 1200x630 preview card, written only once the call settles and kept 30 days (then 410 expired for 90 days; the operator can remove a page, 410 removed). The question is labeled as the caller's; the record is at /answers/<id>.json. The page is not indexed; /privacy describes what it keeps.",
      "Payments: a Solana payment refused because the paying wallet has no USDC account or less USDC than the price now says so (reason no-token-account or insufficient-funds, retry fund-wallet, Retry-After 300) and asks for the wallet to be funded or another listed network, instead of asking for a fresh signature. A wallet refused this way three times in ten minutes gets the same answer without a new check until its Retry-After passes.",
    ],
  },
  {
    date: "2026-11-02",
    title: "Paid answers on a pending settle",
    items: [
      "Payments: an EVM payment whose transfer confirms moments after the facilitator stops waiting for it now receives its answer, instead of a refusal and a later refund: when a settle comes back pending with a transaction, the server reads that transaction on chain for a few seconds and serves the call once the transfer to us is proven.",
    ],
  },
  {
    date: "2026-11-02",
    title: "Router on Tempo and MPP, CDP headers built in-house",
    items: [
      "Router: route-execute moves on to the next Tempo seller when a seller fails before any payment left, as it does on every other chain; each seller is paid with its own freshly signed credential.",
      "Router: a Tempo seller's error after payment is reported as \"it may have been charged\", unless the chain shows the payment was never taken, which is read only when the caller's answer window outlasts the payment's expiry.",
      "Router: an MPP seller whose own llms.txt example takes a list (for example urls: [...]) receives a single url, query or id in that shape; the receipt's paramsAdapted names the rename. An ambiguous case is sent as written, and a seller with a published input schema is unchanged.",
      "Payments: the CDP facilitator's auth headers are built by the server itself, so a self-hosted server no longer installs @coinbase/x402; the same CDP key variables apply.",
      "Surfaces: /revenue's MPP table shows each rail's last settlement by date, marked \"ours\" when it was our own, as the x402 table does.",
    ],
  },
  {
    date: "2026-11-02",
    title: "New pro models, the 2026-12-11 retirements, MCP install text, lite search, Stellar RPC",
    items: [
      "Gateway: the pro tier serves openai/gpt-6.1-terra (and its -pro twin) and moonshotai/kimi-k3.1-pro, both with a 1M-token context and tools.",
      "Gateway: gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-pro, o3 and o3-pro are served as themselves until 2026-12-11, then by their named gpt-5.6 successors at the tier and price of the route called, the swap named in agent402_model_substituted.",
      "Gateway: gpt-5-codex and gpt-5-chat-latest, shut down upstream, are served on the premium and metered tiers by gpt-5.6-sol, the swap named.",
      "Gateway: the metered tier's default model is Claude Haiku 5.5. A call that names no model but sends temperature, top_p, top_k, an assistant prefill or a fixed reasoning budget is served by Claude Haiku 4.5 instead of a 400; /v1/models and the route descriptions name both.",
      "Gateway: the base tier falls back to gpt-6-luna, then deepseek-chat, when the requested model has no available host, as the nano tier does.",
      "Judgment routes run Jev 1.14.0.",
      "Surfaces: server.describe, llms.txt and the README offer the hosted connector at https://agent402.tools/mcp in place of an add-server form that has closed.",
      "Packages: agent402-mcp 0.13.27 carries the same server.describe install text, and every install pin names it.",
      "Tools: exa-search accepts type \"lite\": the fastest search, served from cached pages, with every filter the tool takes. Its published example runs it.",
      "Facilitator: on pubnet an RPC already on version 30 is tried first, ahead of the Protocol 30 vote, and startup logs each RPC's version with a warning for one below protocol 30.",
    ],
  },
  {
    date: "2026-11-01",
    title: "Payment libraries on x402 2.29, model \"default\" served",
    items: [
      "Payments: the server runs the x402 2.29 libraries (core, express, evm, svm, stellar, avm, fetch, extensions) and mppx 0.13.6, and agent402-mcp 0.13.26 runs x402 2.29 core, evm, svm and fetch. The 402 challenge a buyer echoes back is unchanged in size, and a free-tier tool's 402 body still leads with its proof-of-work option.",
      "Payments: the router pays an Algorand seller that advertises the full genesis-hash network id, echoing the seller's own accept.",
      "Gateway: model \"default\" on any chat wire is served as the tier's default model, exactly as an omitted model is, and the metered 402 quotes it that way.",
    ],
  },
  {
    date: "2026-10-29",
    title: "The transactions page updates itself, every rail by name, a cleanup",
    items: [
      "Surfaces: an open /revenue page reads its figures again every minute while the tab is visible (the headline and the rail and MPP tables; the chart every fifth minute), for the same date range (a preset range moves with the day). A failed read keeps what is shown.",
      "Surfaces: /revenue's timestamp line says when the payment figures were last read from the chains (every 5 minutes) apart from the rail status scan behind the Status column (every 4 hours).",
      "Packages: agent402-mcp 0.13.25 accepts every rail by name in AGENT402_NETWORKS (monad, celo, avalanche, sei, optimism, stellar and algorand joined base, polygon, arbitrum, robinhood, arc and solana); a raw CAIP-2 id still works.",
      "Tools: dex-pair, dex-pool and dex-quote answer on a deployment without a provider key, reading public nodes the way evm-rpc does.",
      "Payments: on Algorand the route-execute tiers settle to the router's own spending wallet, as they do on Base. Every other route on Algorand settles to the treasury as before.",
    ],
  },
  {
    date: "2026-10-29",
    title: "The metered gateway leads, speech quoted from the text, each sale's arrival path",
    items: [
      "Surfaces: the metered gateway (/v1/metered/chat/completions and its Messages and Responses twins) is the default way to call a model on /llms.txt, the openapi guidance, SKILL.md, the connector's server.describe and payment.info, the home page, the FAQ, the x402 guide, the README and the wiki: the 402 quotes the request from its body (the input estimated from its tokens with headroom, plus max_tokens), and on x402, Tempo and credits settlement never exceeds that quote; a card payment adds the processor fee. The flat tiers stay as the predictable-price option, and a flat chat tier's unpaid 402 names its metered twin in meteredTwin.",
      "Surfaces: a retired route's 410 carries a Sunset header with its retirement date and, when a replacement is live, a Link header with rel=\"successor-version\" naming it; the retired pairwise converters name /api/unit-convert. The JSON body is unchanged.",
      "Surfaces: /api/revenue's cacheSeconds is the HTTP max-age it sends; refreshesEverySeconds and nextRefreshAt state the cadence of the rail scan behind it. The privacy page (dated 2026-10-29) says the sales ledger keeps how a paid call arrived.",
      "Speech: /api/tts and /api/tts-hd are quoted per request from the length of the text, a floor plus a per-character rate rounded up to the next $0.001, so 2,000 characters costs what the flat price did; the cap stays 2,000 characters on both. The 402, Tempo and credits all read the quote, and /api/pricing, /openapi.json, the tool pages and /llms-full.txt publish the range and the formula. /api/dub keeps its cap and price; /api/tts-lite stays flat.",
      "Speech: /api/tts and /api/tts-hd are called directly; route-execute refuses routes quoted per request, so the 402 carries the real price.",
      "Packages: agent402-client 0.8.21 takes a userAgent option (a calling package's own product token, sent before the client's). agent402-mcp 0.13.24, agent402-agentkit 0.1.10, agent402-ai-sdk 0.2.12, agent402-anthropic-tools 0.1.13, elizaos-plugin-agent402 0.2.10, agent402-google-adk 0.1.12, agent402-langchain 0.2.12, agent402-llamaindex 0.1.13, agent402-openai-agents 0.1.13, agent402-openai-tools 0.1.13, agent402-strands 0.1.13 and agent402-langchain 0.1.6 on PyPI name themselves in the User-Agent of every request; the adapters that pass it require agent402-client 0.8.21 or later. agent402-openclaw 0.5.8 ships its README's metered-default wording.",
      "Packages: agent402-mcp 0.13.24 pins viem, @solana/kit and @modelcontextprotocol/sdk to exact versions, so an install resolves the signing libraries it was tested with. agent402-tollbooth 0.10.8 accepts the x402 packages from 2.0.0 up to, not including, 3. agent402-openclaw 0.5.8, agent402-agentkit 0.1.10 and elizaos-plugin-agent402 0.2.10 cap each optional peer below its next major (the x402 packages and viem below 3, @coinbase/agentkit below 1, zod below 5); agent402-ai-sdk 0.2.12 caps ai below 8 and agent402-llamaindex 0.1.13 caps llamaindex below 1.",
      "Operations: each sale records the path it arrived on (the hosted connector's loopback, one of our client packages by its User-Agent product token, or HTTP; earlier rows read unknown). The operator sales and tool-failure views group by that path, and an operator cohort view lists wallets past a per-day distinct-tool or per-hour call threshold beside a daily series without them. Public figures are unchanged. An operator test wallet that pays the Gateway batched route is booked as our own traffic.",
      "Operations: a catalog call served on the free proof-of-work or trial tier that ends in a 5xx counts on its own lane of the operator tool-failure view, beside a per-rail breakdown; the toolFailures word on /api/gateway-status reads paying buyers' outcomes, and free outcomes only when a tool fails nearly every free call.",
      "Limits: a request body nested more than 64 levels deep answers 400; a compressed request body (any Content-Encoding) on the large-upload routes answers 415; a large upload while this host's in-flight upload budget, or one address's share of it, is full answers 503 with Retry-After; repeated unpaid large bodies from one address to a quoted route answer 429; a PDF whose streams decode past the processing limits answers 422, and a PDF call while the PDF workers and their queue are full answers 503 with Retry-After; base58 text is capped at 4,096 characters (400 past it). None of these is charged.",
      "Live view: where a network holds the event stream back, the page switches to short polls of /api/poll after 8 seconds and keeps updating; its status label reads the connection, so a quiet minute on a working connection reads live.",
    ],
  },
  {
    date: "2026-10-29",
    title: "Lost answers booked at the paid price, budgets fitted under the cap, Algorand by its CAIP-2 id",
    items: [
      "Payments: a card report bought at checkout is generated from the Stripe webhook as well as from the success page, so a buyer who closes the tab still gets it.",
      "Payments: an async job or MCP task whose settled answer was lost is booked as a debt at the price the buyer paid on its chain (premium and floor included, or the metered amount), with the x402 settle receipt as proof.",
      "Payments: a streamed metered call paid with prepaid credits is debited at the usage its last frame reports, not at the quote held when it started.",
      "Payments: a card report refund that could not be sent is read on the refundsOwed word of /api/gateway-status, so the status probe and the heartbeat page on it.",
      "Payments: a buyer that leaves while its payment settles is charged, and a resend of the same payment voids the debt and is served the answer, and a resend after the refund was paid is refused. A hang-up forgiveness ticket is priced on the chain the verified header names.",
      "Payments: a refusal on a Tempo push payment says the transfer was claimed and a refund is owed; copy that says a refusal is not charged names x402, the rail that holds on.",
      "Payments: a credits pack refunded in full before its claim mints no key; a partial refund mints net of it; after minting, a refund takes its amount off the balance and a full refund or a dispute disables the key. A disputed subscription payment drops the subscription from the active list until the dispute is won, which also re-enables a key the dispute disabled.",
      "Payments: the unpaid-quote limiters and the gateway cache count a payment header only when it decodes to a payment on a chain this server sells on.",
      "Payments: agent402-client 0.8.20 pays the Circle Gateway batched accept on Arc and Base with the gateway option (an EIP-712 signer whose address holds a USDC deposit in Circle Gateway): the authorization is signed under the Gateway domain the accept carries, the caps hold before the signature, a pending settlement is resent with the same header, and a 402 with no batched accept falls back to the payment fetch. Off by default. A refusal for a short Gateway balance says to deposit, not to fund the wallet, and reads no wallet balance. The mechanism is on the wiki's Circle Gateway page and in the x402 guide.",
      "LLM gateway: a reasoning or thinking budget is fitted under the output cap the price covers on the chat, Messages and Responses wires, or refused with a 400 when the provider's floor leaves no room.",
      "LLM gateway: /v1/audio/speech stops walking links once its timed-out budget is spent, and a stream the upstream dropped after its first frame ends with an SSE error frame instead of silence.",
      "LLM gateway: o4-mini is served by gpt-5.6-terra and the answer says so in agent402_model_substituted; the premium tier no longer lists it.",
      "Payments: a Solana, Stellar or Algorand x402 payer is screened against the sanctions list after its payment verifies, as an EVM payer already was; a listed signer is refused before the tool runs.",
      "Router: a Solana payer's route-execute leg runs under a time budget, as the Algorand and Tempo legs do; a resolve that used it up is refused before anything is signed.",
      "Router: purchases the router makes with our own wallets never count toward a seller's settlement proof, on every source the floor reads.",
      "Router: /api/route serves a seller's name, homepage, description and tags through the same listing screen as the index, and our own catalog is recognized by canonical host, a redirected manifest included.",
      "MCP connector: server.describe no longer lists the client names seen since boot; a paid call is booked once, by the route it reaches; tasks/cancel reaches a task running on another replica.",
      "MCP connector: a paid blocking call to a slow route from a client without the tasks extension is refused before any payment, with the guidance the HTTP route gives; the free-tier limit copy says the figure is shared across replicas.",
      "Surfaces: each chain's settlement premium is published as payment.premiumUsdByNetwork on /api/pricing, in /llms.txt, in the openapi guidance and on the connector's payment.info, beside the per-chain floors.",
      "Surfaces: Algorand mainnet is offered under its 32-character CAIP-2 id; a payment naming the older full-hash id still settles. agent402-client 0.8.20, agent402-mcp 0.13.22 and agent402-openclaw 0.5.7 read both spellings; the earlier client matches only the old id. agent402-mcp 0.13.22, elizaos-plugin-agent402 0.2.9 and agent402-agentkit 0.1.9 describe a credits key as sold or already issued, and the mcp package shows a buy link only while the service's /api/pricing says credits are on sale.",
      "Surfaces: /health answers cross-origin requests, and a cdnOrigin word on /api/gateway-status reports whether a CDN-range peer reached the origin without its edge secret.",
      "Surfaces: /.well-known/x402 states under payment.dataHandling that payment annotations are not read as readsAnnotationFields, which replaces readsPaymentMetadata; the privacy page names readsOnly and readsAnnotationFields.",
      "Surfaces: the router's dispatch legend on /api/index carries settlementNetting (on or off) and its self-funded reason says it is read only while netting is on; a seller's historyLegend says a crawl outcome counts the routes found, from the manifest or from an OpenAPI, agents.json or llms.txt read.",
      "Surfaces: the home page labels a seller whose name reads as a page title by its host.",
      "Surfaces: the privacy page carries a rights section for readers in the EU and the UK, and its backups wording names the state database.",
      "Operations: the operator view of a public surface reads X-Operator-Token only; an Authorization header there is a buyer's credential. An operator session is known on every operator route across containers.",
      "Operations: the nightly backup runs once a night across replicas; deploy and probe steps that run package code see no job secret; @hono/node-server 2.1.3 in the root and mcp overrides; the agentkit-live lockfile installs again.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Prepaid credits for our own services, with a daily limit and sales tax handled",
    items: [
      "Prepaid credits are a prepayment for Agent402's own services, for business and developer use: not cash, not transferable, never expiring, with no fees. The terms and privacy policy (both dated 2026-10-28) say so, and the checkout shows the rules.",
      "Routes that buy from an outside seller with our wallet (the router's execute tiers, seller-payability, decide-execute and the flight routes) take a wallet payment over x402 or MPP on a chain; prepaid credits and per-call card payments are refused on them with reason third-party-purchase.",
      "One buyer may buy at most $1,000 of credits in any 24 hours, matched by email or card; a purchase past that is refunded in full and issues no key, decided one buyer at a time across servers.",
      "A decision paid with prepaid credits or a card earns no execution credit, so card-funded value never pays decide-execute.",
      "An unspent credits balance under $10 is refunded on request, and a refunded or disputed purchase disables only the key it issued.",
      "Unknown or malformed credits keys are counted per client and shown to the operator; a valid key is never refused because of them.",
      "Credits checkout asks for a billing address, offers a business tax ID field and requires the business-use and terms answers, which the key keeps. A buyer billed in the EU or the UK enters a VAT number, or the purchase is refunded and issues no key. Prices are the same everywhere and include North Carolina sales tax on generated speech, audio and video for a buyer billed in North Carolina by card, which each of those tools' pages states.",
      "agent402-mcp 0.13.21 lists router.execute only with a wallet key; agent402-client 0.8.18, agent402-openclaw 0.5.6, elizaos-plugin-agent402 0.2.8 and agent402-agentkit 0.1.8 carry the updated credits wording.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Cache answers keyed on every input, steadier geocoding and ENS lookups",
    items: [
      "The response cache keys each answer on every input the call sends, so calls to geocode, place-search, fx-rate, weather-alerts, earthquakes and the other cached tools with different inputs never share a cached answer. An answer from the backup geocoder is kept for 10 minutes.",
      "Decide keeps the task's letter case when it reuses a plan, so tasks that differ only in a URL path or an address get their own plan.",
      "Geocoding sends at most one request a second to its primary source across the service; a call that would wait longer is answered by the backup geocoder.",
      "unit-convert reads Kb, Mb, Gb and Tb as bits; MB, mb and every other unit name stay case-insensitive.",
      "ens-resolve reads through the ENS universal resolver, so names whose records moved (nick.eth) resolve; a name with no owner is found: false.",
      "Payment verification reads Solana transactions sent as version 1.",
      "page-change answers to urlwatch, url-watch and watch-page.",
      "Every paid 402 fits the response-header limit of Node's built-in fetch: a route's discovery block trims its input schema first and points to its full output example when it would not fit.",
      "llm-premium serves the retired o3-mini and o4-mini ids with gpt-5.6-terra.",
      "The Kalshi tools read Kalshi's dedicated API host, every GitHub API call names API version 2026-03-10, and hunter-email-verify fills result from status when the source leaves it out.",
    ],
  },
  {
    date: "2026-10-27",
    title: "agent402-mcp 0.13.20: clearer tool safety labels and pinned install commands",
    items: [
      "agent402-mcp 0.13.20: tools that reach the network are labeled not read-only and open-world, so hosts ask before running them; only the local describe and payment lookups are read-only.",
      "agent402-mcp 0.13.20: router.execute and sellers.list are listed only when a wallet or credits key is set, or with AGENT402_SHOW_ROUTER=1. Calls to them still work.",
      "agent402-anthropic-tools, agent402-llamaindex, agent402-openai-tools and agent402-strands 0.1.12: the npm listings name every settlement chain, Arc included. No code change.",
      "agent402-mcp 0.13.20 and the hosted /mcp: every listed tool description is at most 400 characters, cut at a sentence; a paid tool opens with its price. The full description stays on catalog.find.",
      "agent402-mcp 0.13.20: install commands are pinned to a published version, and the startup instructions describe the tools and what they do.",
    ],
  },
  {
    date: "2026-10-23",
    title: "Spending caps count the price you pay",
    items: [
      "agent402-client 0.8.17 and agent402-mcp 0.13.19: with a prepaid credits key, a spending cap counts the route's own price, not a higher price another chain's payment option carries, so a budget lasts as long as it should.",
      "agent402-client 0.8.17 takes payNetworks, the chains a pre-wrapped payment fetch pays on, and counts the dearest option on those chains (the dearest of all when none of a quote's options is on them); without it the cap still counts the dearest option on any chain. Its chain names now cover every chain the gateway offers.",
    ],
  },
  {
    date: "2026-10-22",
    title: "Please upgrade the buyer packages",
    items: [
      "Please upgrade to agent402-client 0.8.16, agent402-mcp 0.13.17, agent402-agentkit 0.1.7, agent402-openclaw 0.5.4, elizaos-plugin-agent402 0.2.7, agent402-langchain 0.2.11, agent402-ai-sdk 0.2.11, agent402-google-adk 0.1.11 and agent402-openai-agents 0.1.12 on npm, and agent402-langchain 0.1.5 on PyPI.",
      "Spending caps are checked against the payment that is signed, priced from the assets the package knows, so a payment over a cap is refused before it is signed, whatever amount the 402 quoted.",
      "A request that can carry a payment does not follow a redirect. The package refuses it and names where it pointed, so a signature or a credits key stays with the host you configured; if the new address is the one you meant, set it as the base URL.",
      "A paid call to a slow route (reports, video, the premium image) now sends Prefer: respond-async for a job link, or Prefer: wait=<maxSeconds> to wait on the connection. A paid call with neither is answered 400 before any payment is taken, so a client that would hang up first is never charged for an answer it did not receive. agent402-client 0.8.16 and later is run as a job on its own, and agent402-mcp 0.13.18 with AGENT402_ASYNC=off sends Prefer: wait.",
    ],
  },
  {
    date: "2026-10-21",
    title: "Slow routes say so, and jobs show their progress",
    items: [
      "Each slow route (reports, video, the premium image) states its typical and maximum run time on its /api/pricing row and /openapi.json operation, marks its /llms.txt line, and its 402 carries X-Async-Recommended with the same advice in the JSON body. The route-execute tiers, seller-payability and the fast and pro image tiers accept Prefer: respond-async too.",
      "GET /api/jobs/{id} keeps its status (working, completed, failed) and adds state (queued, running, succeeded, failed), with a stage (video: submitted, generating, downloading; reports: their named steps), progress from 0 to 1, an ETA and Retry-After on every state that is not final. A route that does not report its own steps shows elapsed time against its typical run, marked as an estimate. Payment still settles only on the delivered answer.",
      "On the MCP connector, every slow paid route runs as an MCP task for a client that declares the tasks extension, and tasks/get carries the same progress.",
      "Faster runs: a domain audit probes in one round instead of three, research reads its source pages at once, the LinkedIn article generates its images together, and video checks for its finished clip every 2 seconds once it is due.",
      "agent402-client 0.8.16 and agent402-mcp 0.13.17 send slow calls as jobs and collect them on their own, honoring Retry-After, with progress callbacks and MCP progress notifications.",
    ],
  },
  {
    date: "2026-10-20",
    title: "Dub, loop gate, email guard, page change and MCP package check",
    items: [
      "New tool dub (POST /api/dub) translates a text into a target language and speaks the translation in one paid call, priced as the sum of the chat tier and the chosen speech tier and quoted in its 402. The audio comes back as raw bytes with the translation in the X-Dub-Translation header, or as JSON with json: true. A failed step answers an error naming the step and is not settled on x402. Model-backed.",
      "New tool loop-gate (POST /api/loop-gate) decides whether an agent loop should continue, stop or escalate after an iteration, with the checks behind the answer and a next step. Budget and iteration limits are checked in code first, and repeats are found lexically before any model runs. Model-backed for the goal and stuck judgments.",
      "New tool email-guard (POST /api/email-guard) reads one email the way a mail-triaging agent should before acting on it, reporting hidden text, invisible Unicode, text present in only one part, links whose text names another host, header signals and sentences phrased as instructions to an AI assistant, each with evidence and offsets. No score and no verdict. Deterministic code, no model.",
      "New tool page-change (POST /api/page-change) tells whether a public page changed since the last look, with nothing stored on our side. It answers a fingerprint of the readable text (a selector narrows it, ignore entries drop timestamps and counters), and a line diff with a similarity score when the previous text is sent back. Deterministic code, no model.",
      "New tool mcp-package-check (POST /api/mcp-package-check) returns the published facts about an npm package that ships an MCP server, read before running it: version and package age, maintainers, provenance, install scripts, dependency counts, deprecation and the GitHub repository the manifest names. Observations only, no score. Deterministic code, no model.",
      "/api/tts and /api/tts-hd back up ElevenLabs with Voxtral, then Grok voice, then MAI-Voice-2 on the same speech wire, each in all six formats.",
      "New pages: /how-to-pay walks the buyer path on every payment rail, and /speech covers the speech tools, with routes, prices and examples read from the catalog.",
      "On the MCP connector, audio from a paid call comes back as an audio block, with dub's translation kept.",
      "agent402-mcp 0.13.14 requires MCP SDK 1.32.1; the server runs follow-redirects 1.16.1 and hono 4.13.13.",
      "Outbound TLS from the server, the render worker, the Stellar facilitator and the canaries refuses a certificate chain through any of eight intermediate CAs whose keys are reported recoverable, keyed on each key's SubjectPublicKeyInfo hash. agent402-client 0.8.14 and agent402-mcp 0.13.15 apply the same refusal to their own requests on a dedicated dispatcher.",
    ],
  },
  {
    date: "2026-10-20",
    title: "Page speed says what to fix",
    items: [
      "page-speed answers an opportunities array from the same single load, so one paid call returns the measurement and what to fix: the LCP element (selector, size, lazy-loaded or waiting for a web font), render-blocking scripts and stylesheets in the head, images without reserved dimensions or larger than shown, fonts without font-display swap, bytes by resource type and resources over 100 KB, responses sent uncompressed or without cache headers, requests to other hosts, long tasks with the script that ran, layout shifts with the element that moved, and console errors. Each carries the measured bytes or milliseconds behind it, null where the load measured neither. Every existing field is unchanged and the price is the same.",
    ],
  },
  {
    date: "2026-10-20",
    title: "html-frames checks frames against a baseline",
    items: [
      "html-frames (POST /api/html-frames) takes an optional compare input: baseline, an array of {t, png} stills, or baselineUrl, a public URL of a second document under the same render contract (window.renderAt(t)), fetched through the public-URL guard and rendered the same way. Each compared frame carries similarity (0 to 1, identical stills score 1) and changedRegions (bounding boxes of the differing cells on a 32x18 grid, largest first, capped and saying so). A compare by baselineUrl renders two documents and is quoted at twice the listed price in its 402; every other body is quoted at the listed price. Deterministic code, no model.",
    ],
  },
  {
    date: "2026-10-19",
    title: "Page speed, HTML frames, and a video retry that collects the clip",
    items: [
      "New tool page-speed (POST /api/page-speed) loads one public URL once in headless Chromium on a mobile or desktop viewport and reports navigation timings, LCP, FCP, CLS, total blocking time, transfer bytes, request count, the heaviest resources, render-blocking scripts and styles, and console errors. Its measurement field says it is a single lab measurement from one server location, not field data from real users. Deterministic code, no model.",
      "New tool html-frames (POST /api/html-frames) renders a self-contained HTML document with network access refused, calls its window.renderAt(t) for each requested time, and returns a PNG per time plus a contact sheet. Loading and every renderAt share one 25 s budget. Deterministic code, no model.",
      "When the browser pool is full, render, screenshot, page-speed and html-frames answer 503 with Retry-After.",
      "/v1/videos/generations: a request that times out answers 504, which is not settled on x402. A wallet payer can send the same request again unchanged within 30 minutes to collect the same clip.",
      "Tools whose upstream is billed per call have a daily call ceiling. Past it, a call answers 503 until 00:00 UTC, and a 503 is not settled on x402.",
      "stock-quote and stock-history read up to the last session the daily bars hold, so a read over a weekend answers instead of being refused.",
    ],
  },
  {
    date: "2026-10-18",
    title: "A guide for new sellers",
    items: [
      "/sell has a New sellers section: listing and being paid by the router are separate gates, how the unproven lane works, and what each routerDispatchReason means with what the seller can do about it.",
      "seller-trust names why our own host is not on the proven lane instead of answering an empty provenBlockers list.",
    ],
  },
  {
    date: "2026-10-17",
    title: "Edit an image with a prompt",
    items: [
      "POST /v1/images/edits edits an image from a prompt and one to four PNG or JPEG reference images (JSON base64 or data: URLs, or one multipart image file, so an OpenAI images.edit() client works unchanged) and returns one JPEG of about one megapixel in the first reference's aspect ratio. Model-backed.",
      "/v1/images/pro and /v1/images/fast gain a fast failover model and keep their 1024x1024 JPEG output.",
      "crypto-news recovers within seconds when every news feed failed once: a retry fetches the feeds again instead of repeating the cached failure.",
    ],
  },
  {
    date: "2026-10-16",
    title: "Both router lanes in seller reports, and pages that read on phones",
    items: [
      "seller-trust and seller-dossier report both router lanes from the router's own verdicts: the proven lane with each route-execute tier that can pay the seller, and the Base unproven tier with its ceiling. routableByOurRouter is true when either lane can pay; routableAsProven keeps the proven meaning.",
      "A crawled seller's price is read the same way whether the seller states it as a dollar label, a number or an object, so label-priced routes count as paid.",
      "Market-data quotes and history answer 503 when the data source stalls mid-answer, and a 503 is not settled on x402. Server instances share one cache of market bars, so a repeat read is served without waiting on the source.",
      "A Solana payment quoted by one server instance and paid on another settles: every instance names the same fee payer.",
      "Site pages read cleanly on phones from 360 px wide: tables become cards, labels stay whole, and text keeps a readable measure.",
    ],
  },
  {
    date: "2026-10-15",
    title: "Questions about images, and search that forgives a typo",
    items: [
      "POST /v1/judge/vision (preview) asks typed questions about up to four PNG or JPEG images: a yes or no probability, a choice, a score, or a box that says where something is, as edges from 0 to 1. Name each image and refer to it as `name` in a question. Built on Jev features its maker labels experimental, and model-backed.",
      "POST /v1/judge/locate (preview) finds up to four things in one image: each comes back with whether it is there and its box. A box is always returned, so found reads false when the model judges the thing absent.",
      "POST /v1/judge/long (preview) runs /v1/judge's questions over a document of up to about 262k tokens in one call.",
      "On /v1/judge, jev-latest is the Jev version we have tested, and every answer names the version that served it; jev-preview reaches the newer release.",
      "/api/find corrects a one-letter slip in a long word and says what it corrected in `corrected`, and when no tool does the task, the nearest matches it still returns are marked `weak`.",
      "Receipts, usage, attestations, feedback, refund lookups, monitor links and Decide quotes read the same record whichever server instance answers.",
      "Site pages were checked and fixed for color contrast, form labels, link styling and keyboard access to scrolling code and tables.",
    ],
  },
  {
    date: "2026-10-15",
    title: "A complete sanctions list, and steadier search under load",
    items: [
      "sanctions-wallet now reads OFAC's full SDN XML export. Since it launched on 2026-09-12 it read the CSV export, which cuts long entries short: it saw about half of the published digital currency addresses, and some Tron, Dogecoin and other case-sensitive addresses were stored in the wrong case. An address in either group could have been answered as not listed. Every published address is now matched exactly as listed.",
      "Search and routing (/api/find, /api/route and the MCP catalog tools) bound every uncached search with a deadline and recover on their own if one stalls; under load they answer 503 with Retry-After instead of hanging.",
      "Every published npm package retries a discovery read that answers 503 with a retry delay, a few times and briefly, and never repeats a paid call.",
      "Data tools that wait on an outside service answer 503 naming the service and the step when it does not answer in time, and nothing is charged.",
      "Transcription with diarize:true adds language_confidence, the model's 0 to 1 confidence in the language it detected. Speech requests, and transcription with diarize:true, route only to model providers that do not collect the data, and to zero-data-retention endpoints wherever every endpoint of the model offers it.",
      "stock-quote and stock-history read an end-of-day summary dataset when one is available: the official close and that dataset's total volume, returned as volume. Each answer names its dataset and coverage; a read that falls back to the three-venue feed says coverage three-venue and returns volume null.",
    ],
  },
  {
    date: "2026-10-09",
    title: "A third model behind every judgment",
    items: [
      "/v1/judge adds microsoft-decision-1 as a backend. The default order is now jev-latest, then microsoft-decision-1, then gpt-6-luna; name any one first with model. The answer names the model that served, and fallbackFrom when the first was unavailable.",
    ],
  },
  {
    date: "2026-10-08",
    title: "Collect slow reports later, and richer free SEC pages",
    items: [
      "A paid call to a slow route (reports, video, the premium image, decide execute) can send Prefer: respond-async: it answers 202 with a job link at once, and GET /api/jobs/{id} returns the answer when it is ready. Payment still settles only on a delivered answer; each slow route now says how long it can take.",
      "An Idempotency-Key call sent again while its first copy is still running gets 409 with Retry-After instead of running twice.",
      "On the chat wires, a model provider refusing the request itself answers 400 with the reason, after failover has tried the next model.",
      "The free SEC company pages add three years of revenue, net income and assets, twelve months of filing activity with the reasons for each 8-K, and recent filings; insider pages total the open-market flow and fund pages show ten holdings.",
      "agent402-mcp 0.13.11 lists route_and_execute as router.execute (the old name still works), and its Docker images include every file the server loads.",
    ],
  },
  {
    date: "2026-10-08",
    title: "Decisions on the OpenAI wire, and two models behind every judgment",
    items: [
      "/v1/judge falls back to gpt-6-luna on the OpenAI Decisions wire when jev-latest is unavailable (a third backend followed on 2026-10-09). The answer shape is unchanged; it names the model that served, and fallbackFrom when the first was unavailable.",
      "POST /v1/decisions speaks OpenAI's Decisions wire: point an OpenAI SDK here and decisions.create works unchanged, paid per call, answered by gpt-6-luna with jev-latest as the fallback.",
      "The transcription examples use a new two-voice sample, so diarize:true shows two speakers, and the image, OCR, PDF and OpenAPI examples read this site's own sample files.",
    ],
  },
  {
    date: "2026-10-07",
    title: "New voices and speaker labels",
    items: [
      "/api/tts and /api/tts-hd move to new speech models: each of the ten voice names has its own voice, 21 more voices can be named directly, and all six formats (mp3, opus, aac, flac, wav, pcm) are served.",
      "Transcription takes diarize:true for speaker labels and word timestamps, on /api/transcribe, /api/transcribe-pro and the OpenAI transcription wire, at the same price and cap.",
      "/api/tts and /api/tts-hd are repriced for the new models; current prices are on /pricing and in every 402.",
      "Most published examples now fetch from agent402.tools and its own sample files, so they work the same for every buyer; the rest follow as their sample files go live.",
    ],
  },
  {
    date: "2026-10-06",
    title: "Claude Code pays from a wallet",
    items: [
      "The local proxy (agent402-openclaw 0.5.0, `npx agent402-openclaw proxy`) now answers the Anthropic Messages wire too: point Claude Code at it with ANTHROPIC_BASE_URL and each turn is paid from your wallet over x402, no key to buy.",
      "The metered Messages route no longer refuses a thinking budget that only collides with its output cap: the budget is clamped along with max_tokens, so Claude Code on Haiku works.",
    ],
  },
  {
    date: "2026-09-30",
    title: "Live payments view",
    items: [
      "live.agent402.tools shows x402 payments on Base and MPP payments on Tempo as they settle, one walker per payment, with sellers named from their public listings. It runs as its own read-only service.",
    ],
  },
  {
    date: "2026-09-30",
    title: "New Base sellers can be routed before they have settlement history",
    items: [
      "The router pays Base sellers with settlement history above the floor. A seller below it is now tried too, under a $0.01 per-call ceiling, only after every proven seller for the task, only at the wallet its own live 402 names, and flagged unproven on the buyer's receipt. Solana has had the same tier since 2026-09-01.",
      "The index shows it: a Base verdict of settlement_required carries unprovenTier when the floor is the only thing in the way and the route's price is within the ceiling.",
      "When a seller's manifest cannot be read and the crawl falls back to its OpenAPI, agents.json or llms.txt, the seller record now names each file that gave nothing and why (fallbackErrors).",
      "/revenue: the MPP table shows outside dollars per rail. Base and Celo MPP payments settle as x402 USDC and are counted in the x402 table.",
    ],
  },
  {
    date: "2026-09-30",
    title: "Decide: a call-ready plan for any job, and a way to run it",
    items: [
      "POST /api/decide turns a task into a plan: which tools, from this catalog and from outside x402 sellers with a recently verified 402, in what order, with fallbacks and input params that validate against each tool's schema. Priced by depth (quick, plan, full); every tool in a plan says whether it is ours, and the ranking has no first-party term. See /decide.",
      "The fee comes back as an execution credit. POST /api/decide/execute runs the plan: our tools directly, outside steps bought from the seller on Base and resold at the seller's price plus a disclosed markup. Spend stops at the budget, fallbacks are tried in order, unspent money returns as a credit, and a run where no step succeeds is not charged.",
      "A parameter the plan could not take from the task is left as a <placeholder> for the agent to fill, and execute never sends a placeholder to a paid tool. Each written value is checked against the task before it is kept.",
      "Outside sellers whose inputs are all optional are now indexed with those inputs named, so a plan can fill them instead of calling the route empty.",
      "decide.feedback on the MCP connector (and POST /api/decide/feedback) records whether a step worked; it is free and feeds the ranking.",
    ],
  },
  {
    date: "2026-09-30",
    title: "Live transfers on /revenue, and tighter proof for the sellers the router pays",
    items: [
      "/revenue, /api/revenue and the chain pages read their recent transfers from the settlement ledger on every load, so a new settlement shows on the first refresh once the ledger has recorded it (it reads the chains every five minutes). Wallet balances still refresh hourly, and the page says so.",
      "The router counts a seller's buyers without the payers whose every payment was refunded, and an MPP seller on Tempo needs three distinct outside payers as well as its transfer count, the same bar as Base. Transfers a seller sends itself and our own payments never count.",
      "A seller that takes the router's payment and then does not deliver is recorded as failing on that route, on Tempo as well as x402, and a later settled answer clears it.",
      "A Tempo payment's payer on sales and refund records is the sender the signature or the chain proves, never a name the client wrote. A push payment whose request is refused before it is served is recorded as owed, and cleared if the same payment is retried and served.",
      "Repeat disconnects past the forgiveness budget are held for review in the refund run instead of planned as ordinary refunds, and a settlement recovered through a backup facilitator frees the wallet's in-flight balance at once.",
      "Re-registering an origin re-checks its routes at once, then at most once every ten minutes; the answer says when the next re-check opens. /api/selfcheck serves a cached run to anyone and a fresh one at most every thirty minutes.",
    ],
  },
  {
    date: "2026-09-29",
    title: "Purchases from other sellers run inside the buyer's authorization, and the paid path has two observers",
    items: [
      "route-execute and seller-payability pay another seller for an EVM buyer only while the buyer's own authorization can still settle after that seller answers. With too little of the window left they answer 504 before paying anyone, and nothing is charged. A stock client's 300-second window always has room, and a payability check run in a shorter window says so in its flags.",
      "On the report products, a wallet's concurrent runs are admitted while its balance covers them together. A run the balance cannot also cover answers 429 before it starts, and nothing is charged.",
      "A paid call to another seller that gets no answer ends that request: route-execute tries no second seller for it and says so in its answer.",
      "Seller routes are judged one at a time: a route whose payment layer turns the router's payment away twice is set aside for a while, the seller's other routes stay routable, and a settled answer from the route brings it back. The seller dossier names a route that is set aside.",
      "Seller answers, 402 bodies and live-402 reads in the index decode the way Response.text() does, so JSON that opens with a byte-order mark parses.",
      "A Tempo pull credential names its sender by its signature: secp256k1, p256 and webAuthn, and access keys, including a new key authorized in the same transaction on its first use. Per-buyer bounds count that sender, and routes that pay another seller before settlement, or run long, accept a pull credential from a sender the signature or the chain proves.",
      "/status: the paid call path is observed every 5 minutes by an outside probe as well as by the GitHub heartbeat, and a failure either observer records stands until that same observer sees the path work again. The page reads from indexes, so it builds as quickly with years of history as with a month.",
      "The hosted connector's paid cut-off and task-cancel messages say that a charge which reached no answer is recorded as owed in the refund ledger and repaid after review.",
    ],
  },
  {
    date: "2026-09-28",
    title: "The 402 body carries the payment requirements",
    items: [
      "Every 402 from the paywall carries the same payment requirements in its JSON body as in the PAYMENT-REQUIRED header: x402Version, resource, accepts and extensions. A refused payment keeps its own explanation in the body beside them.",
      "agent402-mcp 0.13.5, agent402-openclaw 0.4.4 and agent402-client 0.8.9 report a refused payment by its reason.",
      "A paid call whose buyer disconnects before the answer is sent is not settled, within a daily allowance. A call priced above that allowance, a call once it is spent, and a call on a route whose effect outlives the answer (memory writes, attestations, feedback, and purchases from other sellers) settle as before, and the undelivered answer is recorded in the refund ledger and repaid after review.",
      "A Tempo credential whose transfer is already on chain is finalized before the call runs.",
      "Algorand on routes under one cent follows the facilitator's sponsored allowance: while the month's allowance is spent, those routes offer the other rails and GET /api/rails names the restriction. Routes of one cent and more keep Algorand throughout.",
      "Seller index: chains and pay-to addresses learned from a live 402 stay with the method that answered them, and a row with no read of its own is read first.",
      "The x402 leaderboard reads x402 v1 listings that name Base by its shorthand.",
      "deepseek/deepseek-v3.2 is served again.",
    ],
  },
  {
    date: "2026-09-24",
    title: "Integration and learn pages",
    items: [
      "The four Polymarket tools are retired. Each route answers 410 naming the nearest Kalshi tool: kalshi-markets for search and order books, kalshi-event for one market, kalshi-live-data for price history.",
      "New /integrations pages for every published package and /learn explainers for x402, HTTP 402, MPP and agent payments.",
      "/llms-full.txt lists every catalog route with its price.",
      "Tool pages now show parameters, example requests and responses, and related tools.",
      "Model gateway: gpt-6-luna is the nano default and leads the auto router's fast band, gpt-6-sol is on the pro tier, Claude Opus 5.5, Grok 4.5 to 4.7 and qwen3.8-max-prime are served with their own settings, and four DeepSeek models the upstream removes on 2026-09-28 are refused by name with a successor named.",
      "/v1/images/generations is served by FLUX.2 Pro, with GPT-5 Image Mini as the failover, ahead of Gemini 2.5 Flash Image's shutdown on 2026-10-02. The request and response are unchanged: one 1024x1024 PNG per call as inline base64.",
      "Fixed broken links on the FAQ and chain pages.",
      "Seller index: a route that is not in the seller's own manifest or OpenAPI must answer a live 402 at least every 7 days and leaves the listing when it answers 404 or 405 twice at least an hour apart; a 410 removes any route; re-registering re-checks every route. /api/index?seller= shows each route's declared, source and lastVerifiedAt.",
      "Lower prices on web search, news search, render, fed-funds, gas-estimate, edgar-company-lookup and sol-price (current prices on /pricing). Skill packs that use them follow.",
      "kalshi-markets and kalshi-event return yesBidSize and yesAskSize, the resting contracts at the best yes bid and ask. The source retires its liquidity figure on 2026-10-01 and it already reads zero on markets with a live book, so liquidityUsd is now null with a note saying why wherever the source does not publish one.",
    ],
  },
  {
    date: "2026-09-22",
    title: "Five explorer-backed tools retired, and token-risk reads its facts from keyless probes",
    items: [
      "contract-inspect, address-profile, token-info, token-holders and tx-inspect are retired. Each route answers 410 naming its replacement where there is one: contract-inspect to contract-source, address-profile to wallet-balance, token-info to token-metadata, tx-inspect to tx-receipt. token-holders names none, because nothing in the catalog reads a holder list for an arbitrary token.",
      "token-risk and token-risk-pro read every token fact from keyless probes instead: name, symbol, supply, holder count and the top holders with their share come from the token-security probe, the market from the deepest DEX pair that has the token as its base, and source verification from Sourcify. The advertised chains are now exactly the ones that probe serves, so celo is gone and bsc arrives.",
      "A token-security source that does not answer (a rate limit, an upstream error, a timeout) refuses 502 or 503 saying so, rather than a 422 telling the buyer to check an address that is correct. Nothing is charged either way.",
      "The /api/chain/proxy verb is gone with the tool it pointed at; chain-storage reads the same implementation slot by its key. Every other verb in the namespace still resolves.",
    ],
  },
  {
    date: "2026-09-21",
    title: "Typed judgments, a router that says who it is, and a leaderboard that reads the seller's own prices",
    items: [
      "POST /v1/judge: a typed judgment over supplied state - a choice from your named options with a probability for each, a position on levels you describe, or a yes/no as a probability. Model-backed, declared as such, input bounded by bytes so the worst case is knowable before the call.",
      "The router identifies itself on every paid call it makes to an outside seller: User-Agent Mozilla/5.0 (compatible; Agent402-Router/1.0; +https://agent402.tools/crawler) and X-Agent402-Via: router; /crawler documents both.",
      "A seller origin on a non-default port is accepted at x402 registration, MPP registration and MPP discovery, and the port is carried through every later fetch.",
      "Seller leaderboard: a transfer that matches a price the seller publishes counts as a settlement above the flat $0.75 ceiling, up to a $25 price-match ceiling; rows carry settlementsAbovePerCallCeiling and transfersSkippedOverCeiling, and GET /api/leaderboard accepts ?limit= as an alias of ?top=.",
      "priceKnown on every /api/index seller row, /api/route row and seller detail: whether the published price could be read as a number. priceUsd is unchanged.",
      "unit-convert accepts the other spelling of a unit (plural or singular, British spellings, spaces, the statute- prefix); an unknown unit is still a 400.",
      "Heading order fixed on /reports, /monitors, /quickstart and /transparency; /leaderboard no longer prints the same figure twice; about 6 KB of repeated nav style removed from every page.",
    ],
  },
  {
    date: "2026-09-20",
    title: "Equities on a licensed feed, five tools and a pack retired, credits sales paused",
    items: [
      "stock-quote and stock-history read a licensed feed (three US venues, aggregated per session): volume is reported as venueVolume, stock-history takes up to 250 sessions, and the 52-week high/low fields are gone. options-chain, premarket-quote, stock-dividends, earnings-calendar, dividend-calendar and the market-open skill pack are removed.",
      "Prepaid card credits are no longer sold; existing keys keep redeeming.",
      "Google's native generateContent wire on every gateway tier; POST /v1/audio/transcriptions (OpenAI transcription wire, multipart); service_tier \"priority\" on the pro and premium tiers.",
      "New tools: perp-dexs, perp-dex-markets and perp-dex-limits (Hyperliquid HIP-3 dexs); kalshi-live-data and kalshi-weather-index; edgar-13f-datasets and edgar-13f-dataset-head. sol-token-holders restored.",
      "CORS on the machine surfaces (/api/, /v1/, /mcp, /.well-known/, /openapi.json, /llms.txt) with the payment headers exposed; an under-funded buyer's 402 points at what its balance covers; input aliases for 20 more required parameter names.",
    ],
  },
  {
    date: "2026-09-18",
    title: "Settlement evidence read from the chain on every rail we pay on, an identity of our own, and a monthly view",
    items: [
      "Base settlement evidence now seeds its wallet list from our own crawl as well as public discovery registries, so a seller we indexed ourselves is measured too. The crawl is a seed, never evidence: the chain still decides what settled, and each wallet's volume counts only for the origins it is paid at.",
      "On Algorand, router candidates now come from our own index and proof from the chain (inbound USDC transfers to the payTo the seller advertises, self-transfers excluded). Every chain the router spends on now proves settlement from the chain.",
      "For sellers: the index detail view shows your own description and tags, so you can confirm an OpenAPI edit landed, and re-registering an origin re-reads its documents.",
      "An A2A AgentCard at /.well-known/agent-card.json and /.well-known/agent.json, checked by the same validator we sell as a tool; it declares HTTP+JSON, the transport this server runs.",
      `An ERC-8004 identity: agent ${ERC8004_AGENT_ID} on Base, owned by the wallet our 402s name as payTo, pointing at /.well-known/agent-registration.json, which lists every way to reach us.`,
      "/revenue adds a Monthly view beside Daily and Weekly, with distinct buyers counted once per month.",
    ],
  },
  {
    date: "2026-09-18",
    title: "Astra and Fable on premium, effort on the Messages wire, and a faster router",
    items: [
      "Paid routes stay up when a facilitator is unreachable at startup: they answer an error until it comes back instead of the service stopping.",
      "The premium tier admits openai/gpt-6-astra and anthropic/claude-fable-5.1 (1M context, reasoning mandatory).",
      "Messages wire: top-level effort (low to max) on Claude 4.7+, checked against the model's own effort list; a setting a model cannot honor is refused with the fix named rather than dropped silently.",
      "transcribe moves to a newer transcription model ahead of the old one's shutdown, with a 4-minute cap; the two tiers now differ only in cap and price.",
      "Settlement falls back to a second facilitator when the first refuses before broadcasting.",
      "/api/route answers from a candidate index instead of scanning every seller, with the same ranking, and the crawler reads every OpenAPI payment-annotation dialect.",
      "agent402-mcp 0.13.2, agent402-openclaw 0.4.3, elizaos-plugin-agent402 0.2.3 and agent402-agentkit 0.1.3.",
    ],
  },
  {
    date: "2026-09-02",
    title: "Typed 402s, tokenized assets and MPP on the edge",
    items: [
      "Every 402 now carries the answer's typed output schema on its first accept (accepts[0].outputSchema) as well as in the bazaar extension, and every kind of client still settles.",
      "Five tokenized real-world-asset tools: rwa-list, rwa-markets, rwa-asset, rwa-issuers and rwa-issuer, covering tokenized stocks, ETFs and commodities with onchain market data and their issuers.",
      "agent402-tollbooth 0.10.0: the edge build (Workers, Next.js edge, Deno, Bun) takes MPP too, with a WWW-Authenticate: Payment challenge beside the x402 quote.",
      "/api/route rows say whether the router will pay that seller now (routerDispatchEligible, routerDispatchReason, executeViaCallableNow), and a route's chains come from its live 402 even when the seller's manifest lags.",
      "Tempo subscriptions: a renewal that fails on a slow network retries in minutes, and a renewal whose send timed out is checked on the chain before anything is signed again, so a landed transfer is never charged twice.",
      "A refused MCP credential answers the spec's -32043. gpt-4.1-nano and the openai/o4 models retire ahead of their upstream dates (gpt-5.6-luna is the nano default, gpt-5-nano stays, gpt-5.6-terra joins premium), and /v1/images/fast fails over to gpt-5-image-mini.",
      "The Solana seller leaderboard updates incrementally, a deploy never spends on a report and then discards it, every skill pack runs every tool it advertises, and feed-watch reads the newest feed items.",
      "The daily paid canary now proves the Tempo subscription rail after a deploy.",
    ],
  },
  {
    date: "2026-08-26",
    title: "Why pay here, settle-actual for every buyer, and a client that routes",
    items: [
      "agent402-client 0.8.2: the User-Agent header now carries the package version and the test pins it to package.json so it cannot drift again (0.8.1 still sent 0.7.0). Contributed by epistemedeus (PR #985).",
      "agent402-client 0.8.1: route(task, { k, include, network }) ranks tools across the host's current x402/MPP index over the free /api/route, read-only and wallet-free, with executeVia tier hints for route-execute. Contributed by epistemedeus (PR #974).",
      "Why pay here: first-party differences, each linked to the surface that proves it (first at /why, now the #why section of the home page); the same points in /llms.txt, the MCP instructions, the README and the OpenClaw guide",
      "Metered gateway: credits and card buyers settle actual usage like upto buyers; agent402-openclaw 0.3.x pays upto when the wallet holds a Permit2 allowance (permit2-approve), proven daily by the canary's metered-upto leg; the quote is priced from the same object the handler serves",
      "Stellar facilitator: second and third Soroban RPC on transport failures, and a settle fallback",
      "Report inputs: XBRL operating-to-net bridge and verbatim filing excerpts in the dossier, 13F amendments folded, Schedule 13G holders, derivative Form 4s, token-security and DEX market probes in token risk, DNS posture and recursive SPF in domain audits, page bodies and a citation audit in research; LinkedIn article package with LinkedIn-sized images",
      "Wiki accuracy pass across 19 pages, generated from the live catalog and product tables",
    ],
  },
  {
    date: "2026-08-18",
    title: "Agentic Finance, the MPP leaderboard, and a tollbooth that settles from env",
    items: [
      "Positioned under Agentic Finance: /agentic-finance defines the category (DefinedTerm + FAQ structured data), /glossary is one canonical DefinedTermSet for the vocabulary (x402, MPP, 402, facilitator, EIP-3009, receipts, settlement, rails, dual-stack, PoW tier, SOR, tollbooth), and /blog/what-is-agentic-finance-aifi is the long form",
      "MPP leaderboard on /mpp-marketplace: verified MPP sellers ranked by inbound USDC.e transfers on Tempo to the recipient their live challenge names, read from the chain by us (window, rolling 7d/30d, distinct payers, volume; routable rows are the ones the router will pay). Machine-readable at /api/mpp-index and /api/mpp-leaderboard",
      "Smart Order Router pays MPP sellers on Tempo (chain-matched: an MPP/tempo buyer's payment funds a Tempo purchase), gated up front by that leaderboard and at pay time by on-chain proof",
      "Native MPP settlement on Tempo (tempo/charge via Tempo's relay) alongside the Base/Celo evm method; TEMPO_CURRENCY accepts a CSV of currencies",
      "agent402-tollbooth 0.8.0: the reverse-proxy CLI settles x402 AND MPP from env alone (TOLLBOOTH_PAYTO + TOLLBOOTH_FACILITATOR_URL); 0.7.0 added the x402: middleware mode that settles after the handler and MPP on the same 402",
      "agent402-client pays MPP sellers with a stock mppx fetch; every package and identity surface names both wires",
    ],
  },
  {
    date: "2026-07-24",
    title: "MPP dual-stack - every endpoint speaks two payment protocols",
    items: [
      "Every paid endpoint now answers MPP (Machine Payments Protocol, the IETF-track Payment HTTP auth scheme) alongside x402, from the same URL at the same price",
      "402 responses carry a WWW-Authenticate: Payment challenge (EIP-3009 USDC on Base and Celo); Authorization: Payment credentials settle identically to x402; settled responses return a signed Payment-Receipt",
      "Proven live daily: the paid canary buys over the native MPP wire on Base and Celo, receipts on-chain",
      "Listed on MPPScan; /openapi.json now serves MPP discovery metadata (per-operation offers + service info)",
      "MPP adoption is public at /api/stats: toolCallsServed.viaMPPWire",
      "HEAD requests on paid routes now return the same 402 challenges as GET",
      "Explainer: what-is-x402 now covers how x402 and MPP compare",
    ],
  },
  {
    date: "2026-07-23",
    title: "Smart Order Router - Algorand external settlement",
    items: [
      "POST /api/route/execute now settles on the buyer's chain: Algorand buyers are routed to proven AVM sellers and pay in USDC on Algorand",
      "Algorand payment validity windows are checked before execution, so slower tools can't strand a payment",
    ],
  },
  {
    date: "2026-07-21",
    title: "Smart Order Router - external execution",
    items: [
      "POST /api/route/execute can buy from external x402 sellers and resell the result: one payment in, result plus receipt out",
      "Only sellers with verified on-chain settlement history are eligible at launch; unhealthy sellers are never routed to (an unproven tier under a small ceiling followed on 2026-09-01 for Solana and 2026-09-30 for Base)",
    ],
  },
  {
    date: "2026-07-20",
    title: "On-chain intelligence tools + Celo rail",
    items: [
      "contract-inspect and address-profile: verified contract source, ABI, and address token/transaction profiles across major EVM chains (both retired 2026-09-22 with named replacements)",
      "USDC on Celo joins the accepted settlement rails",
    ],
  },
  {
    date: "2026-07-17",
    title: "More settlement rails - USDG on Robinhood Chain, USDC on Avalanche",
    items: [
      "USDG (Global Dollar) on Robinhood Chain accepted for every paid endpoint",
      "USDC on Avalanche accepted for every paid endpoint",
      "Every rail is exercised by a daily paid canary with real settlements",
    ],
  },
  {
    date: "2026-07-16",
    title: "Text-to-speech returns to the /v1 gateway",
    items: [
      "/v1/audio/speech: OpenAI TTS wire format, mp3/pcm output, 2k-character cap",
      "Served by a five-model failover chain - a provider outage never becomes the buyer's error",
      "OpenAI voice names map automatically; native voice ids listed on /v1/models",
    ],
  },
  {
    date: "2026-06-24",
    title: "LLM vision, structured output, and content moderation",
    items: [
      "Vision: send up to 2 image URLs to any LLM tier - screenshot analysis, chart reading, image Q&A",
      "Structured output: response_format with json_object or json_schema for schema-enforced JSON",
      "Content moderation: /api/moderate - check text for harmful content across 13 categories",
      "All guardrails enforced server-side: image count limits, schema size caps, data: URI blocking",
    ],
  },
  {
    date: "2026-06-24",
    title: "Full AI suite - TTS, STT, embeddings via x402",
    items: [
      "Text-to-speech: /api/tts and /api/tts-hd - 10 voices, 6 audio formats",
      "Speech-to-text: /api/transcribe and /api/transcribe-pro - URL-based audio input",
      "Embeddings: /api/embed and /api/embed-large - 1536 or 3072 dimensions for RAG and search",
      "No API key needed - pay per call with USDC on Base, Solana, Polygon & Arbitrum (the rails at the time; the current list is /api/rails)",
      "Self-hosters: bring your own upstream key to run these for free",
    ],
  },
  {
    date: "2026-06-24",
    title: "Code execution sandbox - Python/JS via x402",
    items: [
      "Run Python or JavaScript in isolated cloud sandboxes: /api/code-run and /api/code-run-pro",
      "Returns stdout, stderr, expression result, and error traceback",
      "Pro tier: 60s timeout and 50k char code limit for longer computations",
      "Each call runs in a fresh, isolated VM - nothing persists between calls",
    ],
  },
  {
    date: "2026-06-24",
    title: "Image generation gateway - 3-tier GPT Image via x402",
    items: [
      "Generate images: /api/image-gen, /api/image-gen-hd and /api/image-gen-premium",
      "Text-to-image - no API key needed, pay per call, returns base64 PNG",
      "Three quality tiers from fast drafts to high-fidelity output",
    ],
  },
  {
    date: "2026-06-24",
    title: "LLM proxy gateway - 3-tier inference via x402",
    items: [
      "Chat completions: /api/llm, /api/llm-pro and /api/llm-premium",
      "OpenAI-format interface - no API key needed, pay per call",
      "Models at launch: GPT-4o-mini, GPT-4o, GPT-4.1, o3, o3-mini (the live list is GET /v1/models)",
    ],
  },
  {
    date: "2026-06-23",
    title: "Reliability improvements and observability",
    items: [
      "Per-tool analytics: every call now tracked with latency, cache, and error metrics",
      "Improved upstream reliability for finance and government data tools",
      "Automatic retry on transient network failures for market data endpoints",
    ],
  },
  {
    date: "2026-06-23",
    title: "Developer experience and SEO improvements",
    items: [
      "Proper caching headers on static and discovery routes for faster loads",
      "/health endpoint now reports tool count, uptime, and mode (it has since been trimmed to the tool count and build)",
      "Expanded sitemap with blog posts, adapter docs, and webhook pages",
      "Wiki and docs navigation updated with new developer resources",
    ],
  },
  {
    date: "2026-06-23",
    title: "Crypto-hash, string, and calendar kits - 15 new tools",
    items: [
      "Crypto-hash kit: PBKDF2, scrypt, HKDF, constant-time compare, CRC32/Adler32 checksums (several since retired; the live list is /api/pricing)",
      "String kit: Jaccard similarity, case conversion, fuzzy matching, character frequency, word wrap (several since retired; the live list is /api/pricing)",
      "Calendar kit: ISO week numbers, leap year check, Easter date, epoch conversion, day-of-year",
      "Google ADK adapter published - agent402-google-adk on npm",
    ],
  },
  {
    date: "2026-06-22",
    title: "Validation, encoding, and math kits - 15 new tools",
    items: [
      "Validation kit: phone formatting, XML validation, CSV linting, base detection, IPv6 expansion",
      "Encoding kit: Punycode, NATO phonetic, Soundex, binary-text, Braille conversion (several since retired; the live list is /api/pricing)",
      "Math kit: Roman numerals, Fibonacci, primality check, GCD/LCM, number base conversion (several since retired; the live list is /api/pricing)",
    ],
  },
  {
    date: "2026-06-21",
    title: "Decode-blob and trend-analysis skill packs",
    items: [
      "decode-blob skill pack - automatically detect and decode JWT, gzip, brotli, base64, or hex blobs",
      "trend-analysis skill pack - fetch data, summarize, smooth, detect trends, flag anomalies, benchmark",
      "Compression kit: 5 tools for gzip, brotli, and deflate compression/decompression",
      "Stats kit: 5 tools for summary statistics, correlation, regression, moving averages, and outlier detection",
    ],
  },
  {
    date: "2026-06-20",
    title: "Security-audit and structured-scrape skill packs",
    items: [
      "security-audit skill pack - 7-tool domain audit covering DNS, TLS, WHOIS, HTTP, headers, SPF, and robots.txt",
      "structured-scrape skill pack - render a page and extract structured data in one workflow",
      "HTML kit: 5 tools for extracting text, elements, links, tables, and headings from HTML",
    ],
  },
  {
    date: "2026-06-19",
    title: "x402 economy dashboard and leaderboard",
    items: [
      "/economy - daily x402 ecosystem volume, concentration, and network breakdown (now the economy section of /marketplace)",
      "/leaderboard - public on-chain ranking of x402 sellers by Base USDC settled volume",
      "/api/leaderboard - machine-readable seller rankings",
      "Smart Order Router (/api/route) - rank healthy tools across the x402 ecosystem (the ranking order has grown since; each /api/route row names it)",
    ],
  },
  {
    date: "2026-06-18",
    title: "Docs hub, analytics dashboard, and caching",
    items: [
      "/docs - wiki content rendered on-site with sidebar navigation",
      "/analytics - live tool-level call counts, error rates, and latency percentiles (operator-only since 2026-10-01; public uptime is on /status)",
      "Server-side response caching with cache-hit headers for supported routes",
      "Idempotency support - Idempotency-Key header prevents double-charging on retries",
    ],
  },
  {
    date: "2026-06-17",
    title: "Tollbooth Cloud (since retired) and framework adapters",
    items: [
      "Tollbooth Cloud - hosted multi-site pay-per-crawl dashboard (retired; the self-hosted agent402-tollbooth replaces it)",
      "7 framework adapters on npm: OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, OpenAI Agents, AWS Strands",
      "agent402-client SDK - find() + call() with auto-payment",
    ],
  },
];

/** The dated groups the page and the feed render (read by scripts/test-changelog-parity.js). */
export const CHANGELOG_ENTRIES = ENTRIES;

/** The groups the page and the feed render now: an entry whose switch is off is left out. */
function shownEntries() { return ENTRIES.filter((e) => typeof e.shownWhen !== "function" || e.shownWhen()); }

export function changelogRss(baseUrl) {
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = shownEntries().map((e) =>
    `  <item>
    <title>${xmlEsc(e.title)}</title>
    <link>${baseUrl}/changelog</link>
    <guid isPermaLink="false">agent402-changelog-${e.date}</guid>
    <pubDate>${new Date(e.date + "T12:00:00Z").toUTCString()}</pubDate>
    <description>${xmlEsc(e.items.map((s) => s.trim().replace(/\.+$/, "")).join(". ") + ".")}</description>
  </item>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Agent402 Changelog</title>
  <link>${baseUrl}/changelog</link>
  <description>Recent additions to Agent402: new tools, skill packs, framework adapters, and platform features.</description>
  <language>en</language>
  <atom:link href="${baseUrl}/changelog.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>`;
}

export function changelogPage(baseUrl) {
  const canonical = `${baseUrl}/changelog`;
  const title = "Changelog - what's new at Agent402";
  const description = "Recent additions to Agent402: new tools, skill packs, framework adapters, and platform features.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", url: baseUrl },
  };

  const timelineHtml = shownEntries().map((entry) => {
    const itemsHtml = entry.items.map((item) => `<li>${esc(item)}</li>`).join("\n              ");
    return `
          <div class="tl-entry">
            <div class="tl-dot"></div>
            <div class="tl-card">
              <span class="tl-date">${esc(entry.date)}</span>
              <h2>${esc(entry.title)}</h2>
              <ul>
              ${itemsHtml}
              </ul>
            </div>
          </div>`;
  }).join("\n");

  const extraCss = `
.cl-wrap{max-width:1180px;margin:0 auto;padding:56px 30px;}
.cl-eyebrow{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:10px;}
.cl-wrap h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 14px;}
.cl-desc{font-size:var(--fs-base);line-height:1.55;color:var(--muted);margin:0 0 40px;max-width:640px;}
.cl-rss{font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);text-decoration:none;display:inline-block;margin-bottom:32px;}
.cl-rss:hover{text-decoration:underline;}
.timeline{position:relative;padding-left:28px;}
.timeline::before{content:"";position:absolute;left:7px;top:0;bottom:0;width:1.5px;background:var(--hairline);}
.tl-entry{position:relative;margin-bottom:24px;}
.tl-dot{position:absolute;left:-28px;top:8px;width:16px;height:16px;background:var(--accent);border:3px solid var(--paper);}
.tl-card{background:var(--card);border:1px solid var(--hairline);padding:20px 24px;}
.tl-date{display:inline-block;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:4px;}
.tl-card h2{font-family:var(--font-body);font-weight:700;font-size:var(--fs-lg);line-height:1.15;letter-spacing:-.02em;margin:4px 0 12px;color:var(--ink);}
.tl-card ul{margin:0;padding-left:20px;color:var(--muted);font-size:var(--fs-base);line-height:1.55;}
.tl-card li{margin-bottom:5px;}
.tl-card li:last-child{margin-bottom:0;}
@media(max-width:600px){.cl-wrap h1{font-size:var(--fs-3xl);}.tl-card{padding:16px 18px;}}
`;

  const body = `<div class="cl-wrap">
  <section>
  <div class="cl-eyebrow">$ GET /changelog</div>
  <h1>Changelog</h1>
  <p class="cl-desc">${esc(description)} Each entry describes the service on its date; current prices are on <a href="/pricing">/pricing</a> and in every 402.</p>
  <a class="cl-rss" href="${baseUrl}/changelog.xml">RSS feed</a>
  </section>
  <section>
  <div class="timeline">
${timelineHtml}
  </div>
  </section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}
import { ERC8004_AGENT_ID } from "./tools/a2a-card.js";
