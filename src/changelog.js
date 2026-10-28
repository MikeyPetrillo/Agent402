import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const ENTRIES = [
  {
    date: "2026-10-27",
    title: "agent402-mcp 0.13.20: clearer tool safety labels and a $5 session budget",
    items: [
      "agent402-mcp 0.13.20: tools that reach the network are labelled not read-only and open-world, so hosts ask before running them; only the local describe and payment lookups are read-only.",
      "agent402-mcp 0.13.20: the session spend budget defaults to $5 (AGENT402_BUDGET; off removes it). Before, no session cap applied by default.",
      "agent402-mcp 0.13.20: router.execute and sellers.list are listed only when a wallet or credits key is set, or with AGENT402_SHOW_ROUTER=1. Calls to them still work.",
      "agent402-mcp 0.13.20: install commands are pinned to a published version. The startup instructions list tools and prices, without install commands.",
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

export function changelogRss(baseUrl) {
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = ENTRIES.map((e) =>
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

  const timelineHtml = ENTRIES.map((entry) => {
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
