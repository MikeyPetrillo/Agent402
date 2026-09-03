// Paid-path canary — buys ONE tool from each live-data kit to prove that
// *buying* still settles end-to-end. Its pass/fail reflects whether PAYMENT
// works, NOT whether every third-party data API happened to respond:
//
//   • 200             → settled + delivered                       (success)
//   • 5xx / timeout   → payment SETTLED (x402 settles BEFORE the handler runs);
//                        the upstream data source errored          (WARNING, not a buying break)
//   • 402             → payment did NOT settle for that call       (settlement signal)
//   • 200 bad-shape   → delivered the wrong payload               (WARNING — tool/upstream quality)
//
// The canary PAGES (exit 1, opens the GitHub issue) only when *buying* is
// actually broken: the deterministic core tool (hash) didn't settle, nothing
// settled at all, or settlement failed on half-or-more of the tools. Isolated
// upstream throttles (CoinGecko / Pyth / Brave free-tier rate limits) are
// reported as warnings and do NOT page — that was the chronic false alarm
// ("PAID CANARY FAILED / buying may be broken" when a single data API blipped).
//
// Exit codes: 0 = buying works (warnings allowed) · 1 = buying broken · 2 = misconfig
//   · 3 = underfunded (settlement proven; burner empty) · 4 = green but burner low
//   · 5 = partial-rail (tools settled; one or more chain rail legs failed)
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
// The x402 client + viem are imported dynamically inside main() so this module
// can be imported for unit tests (of the pure decision logic) without those
// packages installed — CI installs them just before the canary runs.

export const CORE_KIT = "core"; // deterministic baseline (hash): no upstream, so a failure = paywall/facilitator down

// Embeddings cache is DEFAULT-ON, so the llm-embed leg's input carries a
// per-run nonce — otherwise a canary re-run within the 10-min TTL would be
// served from cache for free and fake a "settled". The embed-cache follow-up
// reuses the SAME body to prove the free repeat.
export const EMBED_CANARY_INPUT = `agent402 canary embedding ${Date.now()}`;

// The three text legs below all send "Reply with exactly: OK" - shape checks
// alone (non-empty string) would pass a coherent-looking but WRONG answer,
// which is exactly the class of regression a shape check can't catch. Case-
// insensitive with an optional trailing . or ! so ordinary model formatting
// noise doesn't false-page, but garbled/off-topic/truncated content still
// fails the canary.
const isExactOkReply = (content) => typeof content === "string" && /^ok[.!]?$/i.test(content.trim());

// Per-tool spec: { kit, path, method, body?, priceUsd, check(body) → true | string }
export const TOOLS = [
  {
    kit: "core",
    path: "/api/hash",
    method: "POST",
    body: { text: "hello world" },
    priceUsd: 0.001,
    check: (r) => r.hex?.startsWith("b94d27b9") || `expected hex starting with b94d27b9, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "edgar",
    path: "/api/edgar-company-lookup?ticker=AAPL",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => r.cik === "0000320193" || `expected cik 0000320193, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "search",
    path: "/api/search?q=bitcoin&count=1",
    method: "GET",
    priceUsd: 0.01,
    check: (r) => (Array.isArray(r.results) && r.results.length > 0) || `expected non-empty results array, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "macro",
    path: "/api/treasury-yield-curve",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (typeof r.yr10 === "number" && r.yr10 > 0 && r.yr10 < 25) || `expected yr10 in (0, 25), got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    // Browser render — the ONE canary leg that exercises the secretless
    // browser/media worker (F02/F04/F06). When RENDER_WORKER_URL is set on the
    // API service, /api/render dispatches over the private network to the
    // isolated worker, which runs Chromium behind the F04 validate+pin egress
    // proxy and returns extracted markdown. A 200 here proves the live
    // main->worker hop + Chromium render + extraction end-to-end on the paid
    // path; a worker outage 5xx's, which the canary treats as an upstream
    // warning (payment settles pre-handler), not a buying break. example.com is
    // IANA-reserved and renders a stable "Example Domain" title, so the
    // assertion is deterministic.
    kit: "render",
    path: "/api/render",
    method: "POST",
    body: { url: "https://example.com" },
    priceUsd: 0.02,
    check: (r) => (r.rendered === true && /Example Domain/i.test(r.title || "") && `${r.markdown || ""}${r.excerpt || ""}`.length > 0) || `expected rendered:true + title "Example Domain" + some content, got ${JSON.stringify(r).slice(0, 140)}`,
  },
  {
    // Federal-data pack (NHTSA vPIC). Deterministic VIN -> fixed vehicle, the
    // same assertion src/selfcheck.js enforces. A real Base settlement also
    // seeds the new gov tools into settlement-driven indexes (x402scan surfaces
    // a tool once it has an on-chain paid buy, not from a catalog crawl).
    kit: "gov",
    path: "/api/vin-decode?vin=1HGCM82633A004352",
    method: "GET",
    priceUsd: 0.004,
    check: (r) => (r.vehicle?.make === "HONDA" && r.vehicle?.year === "2003") || `expected vehicle.make HONDA + year 2003, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Federal-data pack (FCC Area API). Fixed coordinates -> fixed county/state.
    kit: "gov",
    path: "/api/geo-lookup?lat=34.0522&lon=-118.2437",
    method: "GET",
    priceUsd: 0.003,
    check: (r) => (r.county === "Los Angeles County" && r.state === "CA") || `expected Los Angeles County/CA, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    kit: "finance",
    path: "/api/stock-quote?symbol=AAPL",
    method: "GET",
    priceUsd: 0.001,
    check: (r) => (r.symbol === "AAPL" && r.currency === "USD" && r.price > 1) || `expected AAPL/USD/price>1, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    // Options-chain rides the Yahoo relay's options endpoint (session-crumb
    // handshake handled server-side) — a different relay path than
    // stock-quote's chart endpoint, so this leg keeps the deployed options
    // route continuously proven. Input is the tool's own discovery example.
    kit: "finance",
    path: "/api/options-chain?symbol=AAPL",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (r.symbol === "AAPL" && Array.isArray(r.expirations) && r.expirations.length > 0 && Array.isArray(r.strikes) && Array.isArray(r.calls) && Array.isArray(r.puts)) || `expected AAPL chain with expirations/strikes/calls/puts, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    kit: "crypto",
    path: "/api/crypto-price?coins=BTC",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (r.coins?.bitcoin?.price > 1000) || `expected bitcoin.price > 1000, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "chain",
    path: "/api/gas-snapshot",
    method: "POST",
    body: { network: "base" },
    priceUsd: 0.005,
    check: (r) => (
      typeof r.baseFeeGwei === "number" && r.baseFeeGwei > 0 && r.baseFeeGwei < 1000 &&
      r.fast && typeof r.fast.totalGwei === "number" && r.fast.totalGwei >= r.baseFeeGwei &&
      r.chainId === 8453
    ) || `expected baseFeeGwei (0,1000) + fast.totalGwei>=baseFee + chainId=8453, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "answer",
    path: "/api/answer?q=what+is+the+speed+of+light",
    method: "GET",
    priceUsd: 0.03,
    check: (r) => (typeof r.answer === "string" && r.answer.length > 0 && r.citationCount > 0) || `expected non-empty answer + citationCount>0, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "llm-gateway",
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.02,
    check: (r) => isExactOkReply(r.choices?.[0]?.message?.content) || `expected an exact "OK" reply, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Nano tier — the loop-priced gateway. Same upstream path as the base
    // tier; this leg proves the tier constants + model allowlist against a
    // REAL completion daily (gpt-5-nano (was gpt-4.1-nano until its 2026-10-23 retirement) already served via v1-chat before
    // the nano tier existed, so the model id itself is prod-proven).
    kit: "llm-nano",
    path: "/v1/nano/chat/completions",
    method: "POST",
    body: { model: "openai/gpt-5-nano", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.003,
    check: (r) => isExactOkReply(r.choices?.[0]?.message?.content) || `expected an exact "OK" reply, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // METERED tier (2026-08-26): the 402 amount is a per-request QUOTE from the
    // body, paid over `exact`. This body (nano model, 5 output tokens) quotes
    // the $0.001 floor, so the leg proves the whole path a stock exact-scheme
    // client walks: per-request price resolved on both the bare request and
    // the paid retry, settled, served. test-canary-coverage pins priceUsd to
    // the quote the kit computes for this exact body, so the display price can
    // never drift from what the rail is asked for.
    kit: "llm-metered",
    path: "/v1/metered/chat/completions",
    method: "POST",
    // max_tokens 2000 on gpt-5-nano quotes ABOVE the $0.001 floor (the kit
    // computes the exact figure; test-canary-coverage pins priceUsd to it), so a
    // quote that silently collapses to the floor - an @x402 adapter change that
    // hides the body, say - changes what this leg pays and the pin fails.
    body: { model: "openai/gpt-5-nano", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 2000 },
    priceUsd: 0.001122,
    check: (r) => isExactOkReply(r.choices?.[0]?.message?.content) || `expected an exact "OK" reply, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // METERED tier on the Anthropic Messages wire (2026-08-27): same per-request
    // quote, priced from the Messages probe. Haiku at max_tokens 300 quotes
    // above the floor (test-canary-coverage pins priceUsd to the kit's quote
    // for this exact body), proving the quote resolves on both the bare
    // request and the paid retry through the Messages route.
    kit: "llm-metered-messages",
    path: "/v1/metered/messages",
    method: "POST",
    body: { model: "anthropic/claude-haiku-4.5", max_tokens: 300, messages: [{ role: "user", content: "Reply with exactly: OK" }] },
    priceUsd: 0.001977,
    check: (r) =>
      (r.type === "message" && r.role === "assistant" && Array.isArray(r.content) && r.content.some((b) => b.type === "text" && typeof b.text === "string") &&
        r.usage && typeof r.usage.output_tokens === "number" && !("cost" in r.usage)) ||
      `expected an Anthropic Messages reply on the metered route, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Metered Responses wire (2026-08-28): the same per-request quote on the
    // OpenAI Responses API - the wire Codex CLI and the OpenAI Agents SDK
    // speak. priceUsd is pinned to the kit's quote for this exact body.
    kit: "llm-metered-responses",
    path: "/v1/metered/responses",
    method: "POST",
    body: { model: "anthropic/claude-haiku-4.5", max_output_tokens: 300, input: "Reply with exactly: OK" },
    priceUsd: 0.001964,
    check: (r) =>
      (r.object === "response" && r.status === "completed" && Array.isArray(r.output) && r.output.some((o) => o.type === "message" && Array.isArray(o.content) && o.content.some((c) => c.type === "output_text" && typeof c.text === "string")) &&
        r.usage && typeof r.usage.output_tokens === "number" && !("cost" in r.usage) && r.store !== true) ||
      `expected an OpenAI Responses reply on the metered route, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Streaming leg — stream: true must settle AND deliver real SSE frames.
    // raw: the check reads the response as text and asserts OpenAI wire
    // framing (data: chunks ending in [DONE]). deepseek-chat is requested
    // directly (proven alive) so this leg tests the streaming path itself,
    // orthogonal to the nano leg above which exercises the failover chain.
    kit: "llm-stream",
    path: "/v1/nano/chat/completions",
    method: "POST",
    raw: true,
    // A 200 that is not SSE is a PAID wrong answer (settlement ran on the 200):
    // 2026-08-27 the relay served every streamed frame as comma-joined byte
    // digits for a day and this leg only WARNed. Wire-format legs fail the run.
    strictShape: true,
    body: { model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5, stream: true },
    priceUsd: 0.003,
    check: (text) => (typeof text === "string" && text.includes("data:") && text.includes("[DONE]")) || `expected SSE frames ending in [DONE], got ${String(text).slice(0, 100)}`,
  },
  {
    // Auto tier — eval-ranked routing. NO model in the body: the gateway must
    // classify server-side, serve via the ranked chain, and disclose the
    // decision. "Reply with exactly: OK" classifies general → gpt-4o-mini
    // heads that ranking (canary-proven daily), so this leg proves the router
    // itself, orthogonal to the nano leg's failover-chain coverage.
    kit: "llm-auto",
    path: "/v1/auto/chat/completions",
    method: "POST",
    body: { messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.01,
    check: (r) =>
      (isExactOkReply(r.choices?.[0]?.message?.content) &&
        r.agent402_router?.category === "general" && r.agent402_router?.quality === "balanced" &&
        typeof r.agent402_router?.served === "string") ||
      `expected an exact "OK" reply + agent402_router {category, quality, served}, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Embeddings tier — OpenAI wire path, loop-priced. Asserts the untouched
    // OpenAI list shape with a real vector; the default-on cache behavior is
    // proven by the embed-cache follow-up below (pays here, repeats free).
    kit: "llm-embed",
    path: "/v1/embeddings",
    method: "POST",
    body: { input: EMBED_CANARY_INPUT, model: "text-embedding-3-small" },
    priceUsd: 0.002,
    check: (r) =>
      (r.object === "list" && Array.isArray(r.data) && Array.isArray(r.data[0]?.embedding) &&
        r.data[0].embedding.length >= 256 && typeof r.model === "string") ||
      `expected an OpenAI embeddings list with a real vector, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Grounded tier: auto router + web search plugin (Exa, 5 results). A real
    // reply with url_citation annotations proves the plugin rode, the clamp
    // held with the search fee inside it, and settlement. Nonce in the prompt
    // (never cached anyway - the web moves).
    kit: "llm-grounded",
    path: "/v1/grounded/chat/completions",
    method: "POST",
    body: { messages: [{ role: "user", content: `What is the current Node.js LTS version? One line, cite the source. (${EMBED_CANARY_INPUT.slice(-16)})` }], max_tokens: 120 },
    priceUsd: 0.03,
    check: (r) =>
      (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0 &&
        Array.isArray(r.choices[0].message.annotations) && r.choices[0].message.annotations.some((a) => a.type === "url_citation") &&
        r.agent402_router?.served && !("cost" in (r.usage || {}))) ||
      `expected a grounded reply with url_citation annotations + agent402_router and no cost, got ${JSON.stringify(r).slice(0, 140)}`,
  },
  {
    // Anthropic Messages wire on the nano tier (OpenRouter /messages upstream,
    // any model served through it). A real Anthropic-shaped reply proves the
    // wire, the tier plumbing and settlement; nonce in the prompt so nothing
    // upstream can answer from a cache.
    kit: "llm-messages",
    path: "/v1/nano/messages",
    method: "POST",
    body: { model: "google/gemini-2.5-flash-lite", max_tokens: 32, messages: [{ role: "user", content: `Reply with exactly the word OK. (${EMBED_CANARY_INPUT.slice(-16)})` }] },
    priceUsd: 0.003,
    check: (r) =>
      (r.type === "message" && r.role === "assistant" && Array.isArray(r.content) && r.content.some((b) => b.type === "text" && typeof b.text === "string") &&
        typeof r.stop_reason === "string" && r.usage && typeof r.usage.output_tokens === "number" && !("cost" in r.usage)) ||
      `expected an Anthropic Messages reply (type message, content[], usage without cost), got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // OpenAI Responses wire on the nano tier (OpenRouter /responses upstream).
    // A real Response object (status completed, output[] with output_text,
    // usage without cost) proves the wire + settlement; nonce in the input.
    kit: "llm-responses",
    path: "/v1/nano/responses",
    method: "POST",
    body: { model: "openai/gpt-5-nano", input: `Reply with exactly the word OK. (${EMBED_CANARY_INPUT.slice(-16)})`, max_output_tokens: 32 },
    priceUsd: 0.003,
    check: (r) =>
      (r.object === "response" && r.status === "completed" && Array.isArray(r.output) && r.output.some((o) => o.type === "message" && Array.isArray(o.content) && o.content.some((c) => c.type === "output_text" && typeof c.text === "string")) &&
        r.usage && typeof r.usage.output_tokens === "number" && !("cost" in r.usage)) ||
      `expected an OpenAI Responses object (status completed, output_text, usage without cost), got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Rerank wire (Cohere shape over OpenRouter /rerank, cohere/rerank-v3.5).
    // A real relevance ordering (the French capital first) proves the wire,
    // the locked model and settlement. Cache is default-on, so the query
    // carries the per-run nonce - a cached hit would be served free and fake
    // a settle (same doctrine as llm-embed).
    kit: "llm-rerank",
    path: "/v1/rerank",
    method: "POST",
    body: { query: `What is the capital of France? ${EMBED_CANARY_INPUT.slice(-24)}`, documents: ["Berlin is the capital of Germany.", "Paris is the capital of France.", "Madrid is the capital of Spain."], top_n: 2 },
    priceUsd: 0.002,
    check: (r) =>
      (Array.isArray(r.results) && r.results.length === 2 && r.results[0]?.index === 1 && typeof r.results[0]?.relevance_score === "number" &&
        r.usage?.search_units === 1 && !("cost" in (r.usage || {}))) ||
      `expected Cohere-wire results ranking the French capital first with usage.search_units 1 and no cost, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Image generation tier — OpenAI images wire over OpenRouter (Gemini
    // flash-image). A real base64 payload of plausible image size proves the
    // modalities translation, the price-capped provider call, and settlement.
    kit: "llm-image",
    path: "/v1/images/generations",
    method: "POST",
    body: { prompt: "A tiny pixel-art lighthouse at dusk" },
    priceUsd: 0.08,
    check: (r) =>
      (Array.isArray(r.data) && typeof r.data[0]?.b64_json === "string" && r.data[0].b64_json.length > 10_000 &&
        typeof r.created === "number") ||
      `expected OpenAI images shape with a real b64_json payload, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // TTS — the response is mp3 BYTES, not JSON: a real audio-sized payload
    // proves the binary sentinel path, the five-model failover chain's head
    // (or a live fallback), and settlement. Re-added 2026-07-16 when the
    // tier moved off OpenRouter's phantom OpenAI TTS ids onto the
    // probe-proven chain (Voxtral → Grok → Kokoro → Zonos → MAI).
    kit: "llm-speech",
    path: "/v1/audio/speech",
    method: "POST",
    raw: true,
    body: { input: "Agent402 canary: text to speech is live.", voice: "alloy" },
    priceUsd: 0.06,
    check: (t) => (typeof t === "string" && t.length > 5_000) || `expected raw audio bytes, got ${String(t).length} chars`,
  },
  {
    // Supply-chain leg — the catalog's first PAID x402 UPSTREAM (blockscout-kit).
    // One canary buy = two settlements: canary → us on Base, then prod's
    // spending wallet → Blockscout ($0.002). Proves daily that the upstream
    // wallet is funded, Blockscout's paywall still interops, and the margin
    // guard + provenance mark survive on prod. Self-referential input: the
    // treasury wallet's own Base profile (stable, always a verified contract).
    kit: "supply-chain",
    path: "/api/address-profile",
    method: "POST",
    body: { chain: "base", address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" },
    priceUsd: 0.005,
    check: (r) => (r.address === "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" && typeof r.isContract === "boolean" && r.untrustedContent === true) || `expected treasury profile with untrustedContent, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Derivatives leg (2026-08-22) - a keyless public upstream, so the only cost
    // is the settle itself. Two jobs: it seeds the new family into the
    // settlement-driven explorers (they index routes that get PAID, the way the
    // gov tools were seeded), and it proves daily that the upstream venue is
    // still answering and the response still carries live numbers.
    kit: "derivatives",
    path: "/api/perp-funding",
    method: "POST",
    body: { coin: "BTC", points: 5 },
    priceUsd: 0.003,
    // Real output shape (derivatives-kit perp-funding): {source, coin, markPx,
    // current:{hourly, per8h, aprPct, premiumPct}}. The first check named a
    // funding.hourlyPct field the tool never had, so this leg had warned on
    // every run since 2026-08-22 and nobody read it.
    check: (r) => (r.coin === "BTC" && typeof r.current?.hourly === "number" && typeof r.current?.aprPct === "number" && typeof r.source === "string") || `expected BTC funding numbers (current.hourly/aprPct), got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Solana intel leg (2026-08-22) - same reasoning as the derivatives leg, on
    // the other new keyless family. Uses a well-known mint so the answer is
    // stable and the check can assert real fields rather than mere shape.
    kit: "solana-intel",
    path: "/api/sol-token-safety",
    method: "POST",
    body: { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
    priceUsd: 0.005,
    check: (r) => (typeof r.riskLevel === "string" && (typeof r.score === "number" || typeof r.normalizedScore === "number") && r.untrustedContent === true) || `expected a graded safety verdict, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Route-and-execute — the SOR's executing surface. Dispatches internally
    // to /api/hash; a real digest in the receipt-bearing envelope proves the
    // resolve → guard → dispatch → receipt chain on prod.
    kit: "route-exec",
    path: "/api/route/execute",
    method: "POST",
    body: { slug: "hash", params: { text: "canary", algo: "sha256" } },
    priceUsd: 0.01,
    check: (r) => (r.receipt?.slug === "hash" && typeof r.result?.hex === "string" && r.result.hex.length === 64) || `expected receipt.slug=hash + 64-char hex, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    // Buyer usage report — payment IS the identity. By this point the run has
    // settled several Base buys from the burner, so the report must echo the
    // payer wallet and show real history: totals >= 1 and a non-empty slug
    // table. Proves the payerFromRequest → sales-ledger read path end to end.
    kit: "my-usage",
    path: "/api/my-usage",
    method: "POST",
    body: { days: 7 },
    priceUsd: 0.005,
    check: (r) =>
      (typeof r.wallet === "string" && /^0x[0-9a-f]{40}$/.test(r.wallet) &&
        r.totals?.calls >= 1 && Array.isArray(r.bySlug) && r.bySlug.length >= 1) ||
      `expected the payer's own usage report, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "edgar",
    path: "/api/company-financials?ticker=AAPL",
    method: "GET",
    priceUsd: 0.02,
    check: (r) => (Array.isArray(r.metrics) && r.metrics.length === 9 && r.metrics[0].label === "Revenue" && r.metrics[0].latestAnnual?.value > 1e9) || `expected 9 metrics with Revenue > $1B, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "search",
    path: "/api/multi-search",
    method: "POST",
    body: { queries: ["x402 protocol", "USDC micropayments"], count: 2 },
    priceUsd: 0.08,
    check: (r) => (Array.isArray(r.searches) && r.searches.length === 2 && r.totalResults > 0) || `expected 2 searches with totalResults>0, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/financial-analysis",
    method: "POST",
    body: { ticker: "AAPL" },
    priceUsd: 0.033,
    check: (r) => (r.pack === "financial-analysis" && Array.isArray(r.steps) && r.steps.filter((s) => s.ok).length >= 2) || `expected pack=financial-analysis with >=2 ok steps, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/market-brief",
    method: "POST",
    body: { coin: "bitcoin" },
    priceUsd: 0.024,
    check: (r) => (r.pack === "market-brief" && Array.isArray(r.steps) && r.steps.filter((s) => s.ok).length >= 2) || `expected pack=market-brief with >=2 ok steps, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  // Stellar (USDC on Stellar) settlement is tested via a separate mechanism —
  // the TOOLS array pays exclusively through Base EVM (registerExactEvmScheme),
  // so adding a Stellar entry here would settle on Base, not prove the Stellar
  // rail. First Stellar settlement confirmed manually 2026-07-04 ($0.001).
  // A dedicated inline Stellar leg (like the Solana/Robinhood legs below) can
  // be added once @x402/stellar/exact/client is available in the SDK.
  {
    kit: "skill-pack",
    path: "/api/skill/domain-intel",
    method: "POST",
    body: { domain: "stripe.com" },
    priceUsd: 0.018,
    check: (r) => (r.pack === "domain-intel" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/company-dossier",
    method: "POST",
    body: { ticker: "AAPL" },
    priceUsd: 0.064,
    check: (r) => (r.pack === "company-dossier" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/crypto-dossier",
    method: "POST",
    body: { coin: "bitcoin" },
    priceUsd: 0.30,
    check: (r) => (r.pack === "crypto-dossier" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
];

// Why a paid request 402'd. On a settle FAILURE the middleware attaches the
// FAILED receipt to the 402's PAYMENT-RESPONSE header ({ success:false,
// errorReason, errorMessage }) — THAT is where the facilitator's actual
// rejection reason lives. The payment-required header on the same response is
// just a fresh challenge (its `error` names a verify failure, if any), which
// is why reading only it printed "facilitator reason: null" for the
// 2026-07-16 Robinhood rejection and discarded the only copy of the reason.
// Pure (takes anything with .get(name)) — unit-tested in test-paid-canary.js.
export function settleRejectReason(headers) {
  for (const name of ["payment-response", "x-payment-response"]) {
    const h = headers.get(name);
    if (!h) continue;
    try {
      const receipt = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (receipt?.success === false) return receipt.errorReason || receipt.errorMessage || null;
    } catch { /* malformed receipt — fall through to the challenge */ }
  }
  const h = headers.get("payment-required");
  if (h) {
    try { return JSON.parse(Buffer.from(h, "base64").toString("utf8"))?.error ?? null; } catch { /* ignore */ }
  }
  return null;
}

/**
 * Full settle-rejection receipt (reason + message + network), for rails where
 * the reason code alone is a bucket (e.g. Stellar simulation_failed) and the
 * facilitator may also return errorMessage with the underlying simulate error.
 * Pure — unit-tested in test-paid-canary.js.
 */
export function settleRejectDetail(headers) {
  for (const name of ["payment-response", "x-payment-response"]) {
    const h = headers.get(name);
    if (!h) continue;
    try {
      const receipt = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
      if (receipt?.success === false) {
        return {
          errorReason: receipt.errorReason || null,
          errorMessage: receipt.errorMessage || null,
          network: receipt.network || null,
        };
      }
    } catch { /* fall through */ }
  }
  const reason = settleRejectReason(headers);
  return reason ? { errorReason: reason, errorMessage: null, network: null } : null;
}

// Classify one tool result. Pure — unit-tested in scripts/test-paid-canary.js.
//   settled | bad-shape | unsettled | upstream | request-error | unreachable
export function classifyResult({ status, shapeOk, transportError } = {}) {
  if (transportError) return "unreachable";
  if (status === 200) return shapeOk === true ? "settled" : "bad-shape";
  if (status === 402) return "unsettled";   // x402 payment did not complete
  if (status >= 500) return "upstream";     // PAID (settles pre-handler); upstream data source errored
  return "request-error";                   // other 4xx — tool-specific, not a buying break
}

// Decide whether BUYING is broken from all tool results. Pure — unit-tested.
/**
 * Distinguish "settlement is broken" from "the canary starved its own wallet".
 *
 * 2026-07-27: the Base burner hit $0.000 mid-sweep. 27 legs came back
 * [unsettled] 402 — the exact signature of a settlement outage — the run
 * exited 1, and /status told the world "outage" while the SAME run had settled
 * 11 real purchases across 8 chains. An empty test wallet is our operational
 * problem, not a service outage, and the page must never conflate them.
 *
 * The gate is deliberately narrow, so a real break still pages:
 *   • every failing leg must be cls "unsettled" (a clean 402 — payment did not
 *     complete). Any 5xx/unreachable/bad-shape leg means something else broke.
 *   • at least one settlement must have succeeded this run (proof the path
 *     works when funded).
 *   • the burner's LIVE Base USDC balance must be below the cheapest failed
 *     leg — the arithmetic proof the 402s were "insufficient funds".
 * Anything else — including a failed balance read — stays "broken".
 */
export function classifyCanaryFailure(decision, { balanceUsd = null } = {}) {
  if (!decision.broken) return "ok";
  const failed = decision.rows.filter((r) => r.cls !== "settled");
  if (!failed.length || !failed.every((r) => r.cls === "unsettled")) return "broken";
  if (decision.settled < 1) return "broken";
  if (balanceUsd == null || !Number.isFinite(balanceUsd)) return "broken";
  const cheapestFailed = Math.min(...failed.map((r) => r.priceUsd || Infinity));
  // No failed leg with a known price = no arithmetic proof possible. The only
  // exception is a balance below the platform's minimum price ($0.001), which
  // cannot afford ANY paid leg regardless of which one failed.
  if (!Number.isFinite(cheapestFailed)) return balanceUsd < 0.001 ? "underfunded" : "broken";
  return balanceUsd < cheapestFailed ? "underfunded" : "broken";
}

/** Burner USDC balance on Base. null only when EVERY RPC fails — callers
 *  treat null as "cannot prove underfunding" and page as an outage, so a
 *  single flaky endpoint must not decide that. Proven live 2026-07-27: the
 *  burner sat at exactly $0.00, mainnet.base.org rejected the read, and an
 *  empty wallet paged as "buying looks broken" instead of exiting 3. */
const BASE_BALANCE_RPCS = [
  "https://mainnet.base.org",
  "https://base.blockscout.com/api/eth-rpc",
];
/** Stablecoin balance (6-decimal ERC-20) via an RPC fallback chain. null only
 *  when EVERY RPC fails; each failed attempt logs which endpoint and why. */
async function erc20BalanceUsd(address, { token, rpcs, label = "" }) {
  const data = "0x70a08231" + address.toLowerCase().replace("0x", "").padStart(64, "0");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] });
  for (const rpc of rpcs) {
    try {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "agent402-paid-canary" },
        body,
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      if (typeof j?.result === "string" && /^0x[0-9a-fA-F]*$/.test(j.result)) {
        return parseInt(j.result, 16) / 1e6;
      }
      console.warn(`WARN  balance read${label ? ` (${label})` : ""}: ${rpc} returned no result (HTTP ${r.status}) — trying next RPC`);
    } catch (e) {
      console.warn(`WARN  balance read${label ? ` (${label})` : ""}: ${rpc} failed (${(e?.message || e).toString().slice(0, 80)}) — trying next RPC`);
    }
  }
  return null;
}
async function baseUsdcBalanceUsd(address) {
  const usd = await erc20BalanceUsd(address, {
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    rpcs: BASE_BALANCE_RPCS,
    label: "Base",
  });
  if (usd == null) console.warn("WARN  balance read: ALL Base RPCs failed — cannot prove underfunding, a funding failure would page as an outage");
  return usd;
}

/** Per-chain funding for the informational chain legs (Base is covered by the
 *  low-water check above; these are the chains where the SAME burner pays the
 *  daily $0.001-0.002 rail-proof legs). Chain legs WARN and never page, so a
 *  starved chain wallet fails SILENTLY: the daily settle proof on /revenue
 *  just stops. This sweep pages ok-low while the rail proof still works —
 *  the Base starvation lesson (2026-07-27) applied to every chain. Solana,
 *  Stellar and Algorand legs use separate wallets/signers and are out of
 *  scope here. Token addresses + RPC chains mirror src/revenue-live.js. */
export const CHAIN_FUNDING = [
  { key: "polygon", label: "Polygon", token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", rpcs: ["https://polygon.drpc.org"] },
  { key: "arbitrum", label: "Arbitrum", token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", rpcs: ["https://arb1.arbitrum.io/rpc"] },
  { key: "monad", label: "Monad", token: "0x754704bc059f8c67012fed69bc8a327a5aafb603", rpcs: ["https://rpc.monad.xyz", "https://rpc2.monad.xyz"] },
  { key: "celo", label: "Celo", token: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", rpcs: ["https://forno.celo.org"] },
  { key: "avalanche", label: "Avalanche", token: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", rpcs: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"] },
  { key: "sei", label: "Sei", token: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", rpcs: ["https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com"] },
  { key: "optimism", label: "Optimism", token: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"] },
  { key: "robinhood", label: "Robinhood Chain (USDG)", token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", rpcs: ["https://rpc.mainnet.chain.robinhood.com"] },
  // Tempo: the 2-hourly tempo-volume.yml buys ~1,000 x $0.001 a day from this
  // burner (~$1/day), so low-water is $5 (5 days), not the $0.05 the one-buy
  // legs use. Funded in USDC.e since 2026-08-19 (25 USDC.e; pays USDC.e-first
  // challenges natively, no swap). PathUSD is the swap-backed reserve (1.99).
  { key: "tempo-usdce", label: "Tempo (USDC.e)", token: "0x20C000000000000000000000b9537d11c60E8b50", rpcs: ["https://rpc.tempo.xyz"], lowWater: 5 },
  { key: "tempo-pathusd", label: "Tempo (PathUSD)", token: "0x20c0000000000000000000000000000000000000", rpcs: ["https://rpc.tempo.xyz"], lowWater: 0 },
];

/** Pure verdict over the chain-balance sweep, exported for offline tests:
 *  low = readable balances under the threshold; unreadable = every-RPC-failed
 *  chains (reported, never treated as low — an RPC outage must not page as a
 *  funding problem). */
export function chainLowWaterReport(balances, { chainLowWater }) {
  const low = [];
  const unreadable = [];
  for (const { key, label, usd, lowWater } of balances) {
    const threshold = Number.isFinite(lowWater) ? lowWater : chainLowWater; // per-chain override (Tempo's daily volume)
    if (usd == null) unreadable.push(key);
    else if (usd < threshold) low.push({ key, label, usd, lowWater: threshold });
  }
  return { low, unreadable };
}

export function decideCanary(results, { coreKit = CORE_KIT } = {}) {
  const rows = results.map((r) => ({ ...r, cls: classifyResult(r) }));
  const core = rows.find((r) => r.kit === coreKit);
  const coreSettled = !!core && core.status === 200; // payment went through on the deterministic baseline
  const settled = rows.filter((r) => r.cls === "settled").length;
  const unsettled = rows.filter((r) => r.cls === "unsettled").length;
  const unreachable = rows.filter((r) => r.cls === "unreachable").length;
  const half = Math.ceil(rows.length / 2);

  const reasons = [];
  if (!coreSettled) reasons.push(`core tool "${coreKit}" did not settle — paywall / facilitator / settlement is down`);
  if (settled === 0) reasons.push("no tool settled — buying is down");
  if ((unsettled + unreachable) >= half) reasons.push(`${unsettled + unreachable}/${rows.length} calls failed to settle — systemic settlement failure`);
  // A strict-shape leg (wire format is the product: the streaming relay) that
  // settled and delivered the wrong bytes is a charged wrong answer, not a
  // quality warning - it fails the run like a rail does.
  for (const r of rows) if (r.cls === "bad-shape" && r.strictShape === true) reasons.push(`${r.kit}:${r.path} settled but delivered the wrong wire shape${typeof r.shapeOk === "string" ? ` — ${r.shapeOk}` : ""}`);

  const warnings = rows
    .filter((r) => r.cls !== "settled")
    .map((r) => `${r.kit}:${r.path} [${r.cls}]${r.status ? ` HTTP ${r.status}` : ""}${typeof r.shapeOk === "string" ? ` — ${r.shapeOk}` : ""}`);

  return { broken: reasons.length > 0, coreSettled, settled, unsettled, unreachable, rows, warnings, reasons };
}

/**
 * Grade rail-leg failures against the tool-leg verdict.
 *
 * 2026-08-10: Stellar alone failed while 30/30 tools settled; exit 1 made
 * /status paint "Active outage" / "could not complete a real USDC purchase"
 * even though buying was proven. Same doctrine as underfunded (2026-07-27):
 * when settlement is proven, do not file a buying-outage observation — page
 * the broken rail separately (exit 5 = partial-rail).
 *
 *   • tools broken (decideCanary.broken) → "broken" regardless of rails
 *   • tools green + rail failures      → "partial-rail"
 *   • tools green + no rail failures   → "ok"
 */
/**
 * Consecutive-failure rule for an upstream tool leg. `recentOk` is the
 * component's prior observations newest-first (from /api/status); this run's
 * own outcome is `ok` and is NOT in that list yet. Pages only when this run
 * failed AND the previous (pageAfter - 1) observations all failed. Fewer
 * observations than that, or none readable, never pages: an alarm that fires
 * on missing evidence is the false-positive class the status page forbids.
 */
export function shouldPageUpstreamLeg({ ok, recentOk, pageAfter = 3 } = {}) {
  if (ok) return false;
  const need = Math.max(1, Number(pageAfter) || 3) - 1;
  if (need === 0) return true;
  if (!Array.isArray(recentOk) || recentOk.length < need) return false;
  return recentOk.slice(0, need).every((v) => v === false);
}

export function classifyRailOutcome({ toolBroken, railFailures = [] } = {}) {
  if (toolBroken) return "broken";
  if (railFailures.length) return "partial-rail";
  return "ok";
}

// Rail-leg failures. The chain legs live outside `results`, so decideCanary()
// never saw them and every one of them was console.warn-only: a rail could fail
// on every run for weeks while the script exited 0 and the workflow went green.
// Measured 2026-08-03 (run 30835380742): "30/30 settled", exit 0, and the
// Stellar leg had not settled on that run or the nine before it.
const railFailures = [];
function railFail(key, detail) {
  railFailures.push(`${key}: ${detail}`);
  console.error(`\nFAIL  ${key} leg — ${detail}`);
  noteRail(key, false, detail);
}

// Per-rail status observations for the /status page — deliberately SEPARATE
// from railFailures above, which drives partial-rail paging (exit 5). This
// array only feeds observability (POSTed to /api/status/probe by the
// workflow's own separate step, same as the existing "settlement"
// component), so a bug here can never change what pages Mike. Solana/
// Algorand/Robinhood are WARN-only by design (their failures must never
// page — see each leg's own comment), so they call noteRail() directly
// instead of railFail(); a skipped leg (no burner key) records nothing,
// matching /status's "no observation is no data, never uptime" rule.
const railStatus = [];
function noteRail(key, ok, detail) {
  railStatus.push({ key, ok, detail: detail ? String(detail).slice(0, 300) : undefined });
}

// Did a Stellar payment land AFTER we answered?
//
// Stellar closes a ledger roughly every 5s, and the facilitator returns
// settle_channel_service_failed when its channel service gives up before that
// close. The transfer then confirms anyway. Measured: we answered 402 at
// 17:10:48.044 and the transfer confirmed at 17:10:52 — four seconds later, on
// every run, because it is a race nobody can win rather than a fault.
//
// A canary that stops at the 402 reports "did not settle" for a payment that
// DID settle, which is the opposite of the truth and sends you looking for an
// outage that is not there. So on a 402 we ask the chain, and the two outcomes
// are graded differently: a late settle means the buyer was CHARGED and got a
// 402 (a real defect, and the worse one), while no debit at all means the
// payment genuinely did not happen.
const HORIZON = (process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org").replace(/\/+$/, "");
async function stellarDebitedSince(payer, sinceMs, { waitMs = 20_000, stepMs = 3_000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const r = await fetch(`${HORIZON}/accounts/${payer}/effects?order=desc&limit=20`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const recs = (await r.json())?._embedded?.records || [];
        const hit = recs.find((e) => {
          if (e.type !== "account_debited" || e.asset_code !== "USDC") return false;
          const t = Date.parse(e.created_at || "");
          return Number.isFinite(t) && t >= sinceMs;
        });
        if (hit) return hit;
      }
    } catch { /* Horizon flake must not decide the verdict — keep polling */ }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// --- CLI (network). Importing this module for tests does NOT run any of this. ---
async function main() {
  const TARGET = process.env.TARGET_URL || "https://agent402.tools";
  const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
  const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
  if (!pk) { console.error("paid-canary: no BURNER_KEY / KEY_FILE — cannot run the paid check"); process.exit(2); }

  const [{ privateKeyToAccount }, { x402Client }, { registerExactEvmScheme }, { wrapFetchWithPayment }] = await Promise.all([
    import("viem/accounts"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("@x402/fetch"),
  ]);
  const account = privateKeyToAccount(pk);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });

  // Mark every canary request as internal traffic: X-Heartbeat-Token =
  // HMAC(POW_SECRET, UTC minute) — the same unspoofable marker the heartbeat
  // probe sends (verified in src/pow.js; rail attribution is unaffected, the
  // buy still settles as usdc). Without it the canary's daily REAL purchases
  // are indistinguishable from external demand in the sales ledger and the
  // PostHog settlement stream. Minted per request (minute-scoped token).
  const secret = (process.env.POW_SECRET || "").trim();
  if (!secret) console.warn("WARN  POW_SECRET not set — canary buys will record as EXTERNAL demand in the sales ledger");
  // @x402/fetch passes a Request object (with the X-PAYMENT header) for the
  // paid retry — build via `new Request` so method/body/payment header are
  // preserved, then ADD the heartbeat header. Rebuilding with
  // fetch(url, {...init, headers}) drops X-PAYMENT and no payment is sent
  // (see test-client-paid-live.js, which hit exactly this).
  const synthFetch = !secret ? fetch : (input, init) => {
    const minute = Math.floor(Date.now() / 60_000);
    const token = createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32);
    const req = new Request(input, init);
    req.headers.set("X-Heartbeat-Token", token);
    return fetch(req);
  };
  const payFetch = wrapFetchWithPayment(synthFetch, client);

  // One-shot retry on 5xx — absorbs a true one-off upstream throttle before we
  // even classify. A persistent upstream issue fails the retry too and is then
  // recorded as an "upstream" warning (payment still settled), not a buying break.
  async function payOnceWithRetryOn5xx(url, init) {
    const first = await payFetch(url, init);
    if (first.status < 500 || first.status > 599) return first;
    await first.text().catch(() => "");
    console.warn(`  retry ${init.method} ${url} after HTTP ${first.status} (10s backoff)`);
    await new Promise((r) => setTimeout(r, 10000));
    return payFetch(url, init);
  }

  // Preflight (config) — a WARNING only; it indicates a missing env var, not a
  // payments outage, so it must not page.
  try {
    const health = await (await fetch(`${TARGET}/health`)).json();
    // /health.flags is operator-gated now (security audit A402-11); the canary
    // has no operator token, so flags is usually absent here. Only assert when
    // it IS present (e.g. a token-carrying run); otherwise skip the preflight.
    const yr = health?.flags?.yahooRelay;
    if (yr === true) console.log("OK    preflight /health.flags.yahooRelay=true");
    else if (health?.flags) console.warn(`WARN  preflight: /health.flags.yahooRelay=${yr} (set YAHOO_RELAY_URL/TOKEN) — finance tool may warn`);
  } catch (e) {
    console.warn(`WARN  preflight: GET ${TARGET}/health failed: ${(e?.message || String(e)).slice(0, 120)}`);
  }

  const results = [];
  for (const t of TOOLS) {
    const url = `${TARGET}${t.path}`;
    const init = { method: t.method };
    if (t.body) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(t.body); }
    try {
      const res = await payOnceWithRetryOn5xx(url, init);
      const body = t.raw ? await res.text().catch(() => "") : await res.json().catch(() => ({}));
      const shapeOk = res.status === 200 ? t.check(body) : false;
      const row = { kit: t.kit, path: t.path, status: res.status, shapeOk, priceUsd: t.priceUsd, strictShape: t.strictShape === true };
      results.push(row);
      const cls = classifyResult(row);
      if (cls === "settled") console.log(`OK    ${t.kit.padEnd(10)} ${t.path}  → settled $${t.priceUsd.toFixed(3)}`);
      else console.warn(`WARN  ${t.kit}:${t.path} [${cls}] HTTP ${res.status}${typeof shapeOk === "string" ? ` — ${shapeOk}` : ` ${JSON.stringify(body).slice(0, 100)}`}`);
    } catch (e) {
      results.push({ kit: t.kit, path: t.path, status: null, shapeOk: false, transportError: true, priceUsd: t.priceUsd });
      console.warn(`WARN  ${t.kit}:${t.path} [unreachable] ${(e?.message || String(e)).slice(0, 140)}`);
    }
  }

  // Supply-chain leg (address-profile -> Blockscout, paid from prod's spending
  // wallet) is graded on a CONSECUTIVE rule. A tool leg is a warning by
  // doctrine (a 5xx never charges the buyer), and that is right for a one-off
  // upstream blip - but this leg failed a third of its runs in 2026-08
  // ("Seller rejected the paid retry (HTTP 500)") and nothing paged, because
  // every failure was its own blip. The previous outcomes come from /status
  // (rail_supply-chain, written by this canary's own status step), so the
  // rule needs no state of its own; unreachable status = no page, never a
  // false one.
  {
    const leg = results.find((r) => r.kit === "supply-chain");
    if (leg) {
      const legOk = classifyResult(leg) === "settled";
      const detail = legOk ? undefined : `HTTP ${leg.status ?? "none"}${typeof leg.shapeOk === "string" ? ` — ${leg.shapeOk}` : ""}`;
      noteRail("supply-chain", legOk, detail);
      if (!legOk) {
        let recentOk = null;
        try {
          const snap = await (await fetch(`${TARGET}/api/status`, { signal: AbortSignal.timeout(20000) })).json();
          recentOk = snap?.railComponents?.find((c) => c.key === "rail_supply-chain")?.recentOk ?? null;
        } catch { recentOk = null; }
        const pageAfter = Number(process.env.CANARY_UPSTREAM_PAGE_AFTER) || 3;
        if (shouldPageUpstreamLeg({ ok: legOk, recentOk, pageAfter })) {
          railFail("supply-chain", `address-profile failed ${pageAfter} consecutive canary runs (${detail}) — Blockscout upstream / spending wallet path is down, not a blip`);
        } else {
          console.warn(`WARN  supply-chain leg failed (${detail}); prior outcomes ${JSON.stringify(recentOk)} — pages after ${pageAfter} consecutive failures`);
        }
      }
    }
  }

  // Optional Solana leg — gated on SOLANA_BURNER_KEY (base58 64-byte secret
  // or JSON byte array; fund it with USDC on Solana). Buys the $0.05
  // skill-decode-blob pack (seven pure-CPU tools, deterministic, no upstream
  // cost) with an SVM-ONLY client, so the payment can only settle on a Solana
  // accept — a true Solana-path proof with no silent EVM fallback. $0.05
  // instead of the $0.001 hash so the transfer clears explorer dust filters;
  // the printed tx signature is still the authoritative proof either way.
  // Informational: failures WARN, never page (the EVM verdict above decides
  // paging), so an unset or unfunded burner cannot open an issue.
  await (async () => {
    const raw = (process.env.SOLANA_BURNER_KEY || "").trim();
    if (!raw) { console.log("\nsolana leg: skipped (no SOLANA_BURNER_KEY)"); return; }
    try {
      const [{ x402Client: SvmClient }, { registerExactSvmScheme }, { wrapFetchWithPayment: wrapSvm }, kit, { createHash }] = await Promise.all([
        import("@x402/core/client"), import("@x402/svm/exact/client"), import("@x402/fetch"), import("@solana/kit"), import("node:crypto"),
      ]);
      const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : new Uint8Array(kit.getBase58Encoder().encode(raw));
      const signer = await kit.createKeyPairSignerFromBytes(bytes);
      const svmPay = wrapSvm(synthFetch, registerExactSvmScheme(new SvmClient(), { signer }));
      const res = await svmPay(`${TARGET}/api/skill/decode-blob`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The pack's own documented example blob (a JWT) — deterministic steps.
        body: JSON.stringify({ blob: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.pack === "decode-blob" && Array.isArray(body.steps) && body.steps.length >= 5) {
        // Print the on-chain proof, not just the claim: the settle receipt
        // (PAYMENT-RESPONSE header, v2; X-PAYMENT-RESPONSE, v1) carries the
        // transaction signature — a clickable solscan link beats "trust the
        // facilitator" (and dust-sized transfers are hidden by default in
        // explorer transfer views, so the signature is the reliable check).
        let tx = null;
        const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
        if (receiptHdr) {
          try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"))?.transaction || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    solana     /api/skill/decode-blob  → settled $0.05 USDC on Solana (payer ${signer.address})${tx ? `\n      tx: https://solscan.io/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
        noteRail("solana", true);
      } else if (res.status === 402) {
        noteRail("solana", false, `did not settle (HTTP 402, payer ${signer.address})`);
        console.warn(`\nWARN  solana leg did NOT settle (HTTP 402, payer ${signer.address}) — decoding diagnostics:`);
        // A settle rejection's reason rides the PAYMENT-RESPONSE header
        // (settleRejectReason reads it); the PAYMENT-REQUIRED header on the
        // same response is the re-issued challenge whose `error` names a
        // VERIFY failure (wrong mint, missing feePayer, insufficient funds,
        // version skew). Decode both so the log names the actual failure
        // instead of guessing.
        const decode402 = (r) => {
          const h = r.headers.get("payment-required");
          if (!h) return null;
          try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; }
        };
        const failReq = decode402(res);
        console.warn(`      settle rejection reason: ${JSON.stringify(settleRejectReason(res.headers))}`);
        console.warn(`      post-payment challenge: error=${JSON.stringify(failReq?.error ?? null)} x402Version=${failReq?.x402Version ?? "?"}`);
        try {
          // Fresh unpaid request → what a Solana buyer is actually offered.
          const bare = await fetch(`${TARGET}/api/skill/decode-blob`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blob: "canary" }) });
          const req = decode402(bare) ?? (await bare.json().catch(() => null));
          const sol = (req?.accepts || []).filter((a) => String(a.network || "").startsWith("solana:"));
          console.warn(`      solana accepts offered: ${sol.length ? JSON.stringify(sol).slice(0, 600) : "NONE — Solana missing from the live 402"}`);
        } catch (e2) {
          console.warn(`      (could not re-fetch challenge for diagnostics: ${(e2?.message || String(e2)).slice(0, 100)})`);
        }
      } else {
        noteRail("solana", false, `HTTP ${res.status}`);
        console.warn(`\nWARN  solana leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      noteRail("solana", false, `errored: ${(e?.message || String(e)).slice(0, 160)}`);
      console.warn(`\nWARN  solana leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Optional Robinhood Chain leg — same burner key as the EVM canary above
  // (one 0x address, funded with USDG on chain 4663). wrapFetchWithPayment
  // lets the client pick ANY eip155 accept (it would settle on Base), so this
  // leg negotiates manually: take the live 402, filter the accepts down to
  // eip155:4663, and pay THAT — settlement can only happen in USDG on
  // Robinhood Chain, a true rail proof with no silent Base fallback. The
  // accept carries the USDG asset + EIP-712 domain (extra.name/version), so
  // the standard EVM scheme signs it as-is. $0.001/call; a funded burner
  // covers years of daily proof. Informational: failures WARN, never page
  // (the EVM verdict above decides paging) — but a WARN here that robinhood
  // is missing from the accepts is the early signal the rail was dropped.
  await (async () => {
    try {
      const { x402HTTPClient } = await import("@x402/core/client");
      const http = new x402HTTPClient(client);
      const reqInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "usdg-canary" }) };
      const bare = await synthFetch(`${TARGET}/api/hash`, reqInit);
      if (bare.status !== 402) {
        noteRail("robinhood", false, `expected a 402, got HTTP ${bare.status}`);
        console.warn(`\nWARN  robinhood leg: expected a 402 challenge from /api/hash, got HTTP ${bare.status}`);
        return;
      }
      let paymentRequired;
      try {
        const bareBody = await bare.json().catch(() => undefined);
        paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
      } catch (e) {
        noteRail("robinhood", false, `could not parse the 402 challenge: ${(e?.message || String(e)).slice(0, 120)}`);
        console.warn(`\nWARN  robinhood leg: could not parse the 402 challenge: ${(e?.message || String(e)).slice(0, 120)}`);
        return;
      }
      const rh = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === "eip155:4663");
      if (!rh.length) {
        noteRail("robinhood", false, "eip155:4663 not among the live 402 accepts");
        console.warn(`\nWARN  robinhood leg: eip155:4663 NOT among the live 402 accepts — the Robinhood/USDG rail has dropped out of the offer (PAYMENT_NETWORKS or ROBINHOOD_FACILITATOR_URL changed on prod?)`);
        return;
      }
      const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: rh });
      const payHeaders = http.encodePaymentSignatureHeader(payload);
      const paid = await synthFetch(`${TARGET}/api/hash`, {
        ...reqInit,
        headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
      });
      const body = await paid.json().catch(() => ({}));
      if (paid.status === 200 && typeof body.hex === "string") {
        let tx = null, net = null;
        const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
        if (receiptHdr) {
          try {
            const receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"));
            tx = receipt?.transaction || null;
            net = receipt?.network || null;
          } catch { /* best-effort */ }
        }
        console.log(`\nOK    robinhood  /api/hash  → settled $0.001 USDG on Robinhood Chain (payer ${account.address}${net ? `, network ${net}` : ""})${tx ? `\n      tx: https://robinhoodchain.blockscout.com/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
        noteRail("robinhood", true);
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        noteRail("robinhood", false, `did not settle (HTTP 402) — ${JSON.stringify(reason)}`);
        console.warn(`\nWARN  robinhood leg did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded USDG burner, facilitator outage, or EIP-712 domain drift)`);
      } else {
        noteRail("robinhood", false, `HTTP ${paid.status}`);
        console.warn(`\nWARN  robinhood leg: HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      noteRail("robinhood", false, `errored: ${(e?.message || String(e)).slice(0, 160)}`);
      console.warn(`\nWARN  robinhood leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // MPP dual-stack legs — prove the NATIVE MPP wire end to end on prod: the
  // live 402 must carry WWW-Authenticate: Payment (src/mpp-shim.js minted it,
  // so MPP_SECRET_KEY is live), a stock mppx client must sign that challenge
  // (EIP-3009), the buy goes out as Authorization: Payment — NOT
  // PAYMENT-SIGNATURE — and the settled 200 must return an MPP Payment-Receipt.
  // The credential is created from a response containing ONLY the
  // WWW-Authenticate header, so the client cannot silently fall back to the
  // x402 wire (which every other leg already proves).
  //
  // Graded via railFail() like the chain rails. These used to be WARN-only,
  // which is the Stellar class of defect: the shim (or its secret) could drop
  // out of prod for weeks while the canary stayed green. Base is the load-
  // bearing proof; Celo pins the second offered challenge network.
  //
  // MPP_CANARY_ROUNDS: runs both legs this many times per canary invocation
  // (sequential, awaited - never concurrent, so the same burner's nonce
  // advances normally between buys). Mike's call 2026-08-13 to raise real
  // MPP-wire settlement volume once we joined mppscan.com's directory -
  // doubling this doubles ONLY the mpp/mpp-celo legs' spend and transaction
  // count, leaving the other 30 legs' cadence and cost untouched. Each round
  // is a genuine new $0.001 settlement, not a replay.
  const MPP_CANARY_ROUNDS = Number(process.env.MPP_CANARY_ROUNDS) || 2;
  for (let mppRound = 1; mppRound <= MPP_CANARY_ROUNDS; mppRound++) {
  await (async () => {
    try {
      const [{ Mppx: MppClientNS, evm: mppEvm }, { Challenge: MppChallenge, Receipt: MppReceipt }] = await Promise.all([
        import("mppx/client"), import("mppx"),
      ]);
      const heartbeatHeaders = () => {
        if (!secret) return {};
        const minute = Math.floor(Date.now() / 60_000);
        return { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32) };
      };
      const mpp = MppClientNS.create({
        methods: [mppEvm.charge({ account, currencies: [mppEvm.assets.base.USDC], maxAmount: "0.01" })],
        polyfill: false,
      });
      const url = `${TARGET}/api/uuid`;
      const bare = await mpp.rawFetch(url, { headers: heartbeatHeaders() });
      if (bare.status !== 402) {
        railFail("mpp", `expected a 402 challenge from /api/uuid, got HTTP ${bare.status} — the MPP wire was never exercised`);
        return;
      }
      const wwwAuth = bare.headers.get("www-authenticate");
      if (!wwwAuth || !/^Payment\b/i.test(wwwAuth.trim())) {
        railFail("mpp", "402 has NO WWW-Authenticate: Payment header — the MPP shim is not live (MPP_SECRET_KEY unset on prod, or src/mpp-shim.js unmounted)");
        return;
      }
      const credential = await mpp.createCredential(
        new Response(null, { status: 402, headers: { "WWW-Authenticate": wwwAuth } })
      );
      if (!/^Payment /.test(credential)) {
        railFail("mpp", `client produced a non-MPP credential (${credential.slice(0, 24)}…) — native path not taken`);
        return;
      }
      const paid = await mpp.rawFetch(url, { headers: { ...heartbeatHeaders(), Authorization: credential } });
      const body = await paid.json().catch(() => ({}));
      if (paid.status === 200 && Array.isArray(body.uuids)) {
        const receiptHdr = paid.headers.get("payment-receipt");
        let ref = null;
        if (receiptHdr) {
          try { ref = MppReceipt.deserialize(receiptHdr)?.reference || null; } catch { /* best-effort */ }
        }
        if (!receiptHdr) {
          railFail("mpp", "settled 200 over Authorization: Payment but carried no Payment-Receipt header — MPP receipt mirroring is broken");
        } else {
          console.log(`\nOK    mpp        /api/uuid  → settled $0.001 over the NATIVE MPP wire (round ${mppRound}/${MPP_CANARY_ROUNDS}, Authorization: Payment, payer ${account.address})${ref ? `\n      Payment-Receipt tx: https://basescan.org/tx/${ref}` : ""}`);
          noteRail("mpp", true);
        }
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        railFail("mpp", `did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)}`);
      } else {
        railFail("mpp", `HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }

      // Celo variant — same native MPP wire, PINNED to eip155:42220: the 402's
      // challenge list is filtered down to the Celo challenge before signing,
      // so settlement can only happen in USDC on Celo through the Celo
      // facilitator. The Base leg above proves the wire; this proves the
      // second offered chain end to end (client registry domain "USDC"/"2",
      // our Celo money parser, Celo facilitator settle with X-API-Key). Same
      // burner, funded with Celo USDC by the pinned celo x402 leg's budget.
      const celoClient = MppClientNS.create({
        methods: [mppEvm.charge({ account, currencies: [mppEvm.assets.celo.USDC], maxAmount: "0.01" })],
        polyfill: false,
      });
      const bareCelo = await celoClient.rawFetch(url, { headers: heartbeatHeaders() });
      const celoAuth = bareCelo.headers.get("www-authenticate");
      const celoCh = celoAuth
        ? MppChallenge.fromHeadersList(new Headers({ "WWW-Authenticate": celoAuth }))
            .find((c) => c.request?.methodDetails?.chainId === 42220)
        : null;
      if (!celoCh) {
        railFail("mpp-celo", "no eip155:42220 challenge on the live 402 (MPP_CHALLENGE_NETWORKS dropped Celo, or the shim is not advertising it)");
        return;
      }
      const celoCred = await celoClient.createCredential(
        new Response(null, { status: 402, headers: { "WWW-Authenticate": MppChallenge.serialize(celoCh) } })
      );
      if (!/^Payment /.test(celoCred)) {
        railFail("mpp-celo", `client produced a non-MPP credential (${celoCred.slice(0, 24)}…) — native path not taken`);
        return;
      }
      const celoPaid = await celoClient.rawFetch(url, { headers: { ...heartbeatHeaders(), Authorization: celoCred } });
      const celoBody = await celoPaid.json().catch(() => ({}));
      if (celoPaid.status === 200 && Array.isArray(celoBody.uuids)) {
        const celoReceiptHdr = celoPaid.headers.get("payment-receipt");
        let celoRef = null;
        if (celoReceiptHdr) {
          try { celoRef = MppReceipt.deserialize(celoReceiptHdr)?.reference || null; } catch { /* best-effort */ }
        }
        if (!celoReceiptHdr) {
          railFail("mpp-celo", "settled 200 over Authorization: Payment on Celo but carried no Payment-Receipt header");
        } else {
          console.log(`\nOK    mpp-celo   /api/uuid  → settled $0.001 over the NATIVE MPP wire on Celo (round ${mppRound}/${MPP_CANARY_ROUNDS}, payer ${account.address})${celoRef ? `\n      Payment-Receipt tx: https://celoscan.io/tx/${celoRef}` : ""}`);
          noteRail("mpp-celo", true);
        }
      } else if (celoPaid.status === 402) {
        const reason = settleRejectReason(celoPaid.headers);
        railFail("mpp-celo", `did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded Celo USDC burner, Celo facilitator outage/sequencer nonce hiccup, or domain drift)`);
      } else {
        railFail("mpp-celo", `HTTP ${celoPaid.status} ${JSON.stringify(celoBody).slice(0, 120)}`);
      }
    } catch (e) {
      railFail("mpp", `errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();
  }

  // Metered tier over `upto` — the settle-ACTUAL path (2026-08-26). The daily
  // llm-metered TOOL leg pays the per-request EXACT quote; this leg buys the
  // same body through the upto scheme (Permit2 allowance on the burner, granted
  // once), so the quote becomes a ceiling and the gateway settles actual usage
  // x 1.15. It is the only live proof of what agent402-openclaw's upto path
  // does for a real buyer: the OUTGOING credential must be scheme "upto" (a
  // client that quietly fell back to exact would still get a 200), the
  // response must carry X-Metered-Usd strictly UNDER the quote, and the
  // receipt must settle. The selector mirrors the plugin's selectAccept
  // (openclaw/index.js). Own try/catch, own rail key.
  await (async () => {
    const path = "/v1/metered/chat/completions";
    const body = { model: "openai/gpt-5-nano", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 2000 };
    const init = () => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const [{ UptoEvmScheme, getPermit2AllowanceReadParams }, { createPublicClient, http }, { base }] = await Promise.all([
        import("@x402/evm/upto/client"), import("viem"), import("viem/chains"),
      ]);
      const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
      const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
      const allowance = await pub.readContract(getPermit2AllowanceReadParams({ tokenAddress: USDC_BASE, ownerAddress: account.address }));
      if (BigInt(allowance) < 10n ** 12n) {
        railFail("metered-upto", `burner ${account.address} has no Permit2 allowance on Base USDC (${allowance}) — run \`agent402-openclaw permit2-approve\` with the burner key once`);
        return;
      }
      const bare = await fetch(`${TARGET}${path}`, init());
      await bare.text().catch(() => "");
      const pr = bare.headers.get("payment-required");
      let accepts = [];
      try { accepts = JSON.parse(Buffer.from(pr || "", "base64").toString("utf8"))?.accepts || []; } catch { /* no challenge */ }
      const upto = accepts.find((a) => a?.scheme === "upto" && a?.network === "eip155:8453");
      if (bare.status !== 402 || !upto) {
        railFail("metered-upto", `live 402 offers no upto accept on eip155:8453 (HTTP ${bare.status}, offered ${JSON.stringify(accepts.map((a) => `${a?.scheme}@${a?.network}`))})`);
        return;
      }
      const quotedUsd = Number(upto.amount) / 1e6;
      const uptoClient = new x402Client((_v, list) => list.find((a) => a?.scheme === "upto" && a?.network === "eip155:8453") || list[0]);
      registerExactEvmScheme(uptoClient, { signer: account });
      uptoClient.register("eip155:8453", new UptoEvmScheme(account));
      let sentScheme = null;
      const capture = (input, reqInit) => {
        const req = new Request(input, reqInit);
        const sig = req.headers.get("payment-signature") || req.headers.get("x-payment");
        if (sig) { try { sentScheme = JSON.parse(Buffer.from(sig, "base64").toString("utf8"))?.accepted?.scheme ?? null; } catch { /* stays null */ } }
        return synthFetch(req);
      };
      const uptoFetch = wrapFetchWithPayment(capture, uptoClient);
      const res = await uptoFetch(`${TARGET}${path}`, init());
      const out = await res.json().catch(() => ({}));
      if (res.status !== 200) { railFail("metered-upto", `HTTP ${res.status} ${JSON.stringify(settleRejectReason(res.headers) ?? out).slice(0, 160)}`); return; }
      const meteredHdr = res.headers.get("x-metered-usd");
      const metered = Number(meteredHdr);
      const receipt = res.headers.get("payment-response") || res.headers.get("x-payment-response");
      const okReply = isExactOkReply(out.choices?.[0]?.message?.content);
      if (sentScheme !== "upto") railFail("metered-upto", `paid over scheme ${JSON.stringify(sentScheme)}, not upto — the settle-actual path was never exercised`);
      else if (!receipt) railFail("metered-upto", "200 with no PAYMENT-RESPONSE receipt");
      else if (okReply !== true) railFail("metered-upto", `settled but the reply was not "OK": ${JSON.stringify(out).slice(0, 100)}`);
      else if (!(metered > 0) || metered >= quotedUsd) railFail("metered-upto", `X-Metered-Usd ${JSON.stringify(meteredHdr)} is not strictly under the quote $${quotedUsd} — actual-usage settlement did not apply`);
      else {
        console.log(`OK    metered-upto ${path}  → settled $${metered.toFixed(6)} ACTUAL over upto (quote ceiling $${quotedUsd}, payer ${account.address})`);
        noteRail("metered-upto", true);
      }
    } catch (e) {
      railFail("metered-upto", `errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Tempo — MPP's OWN native method (src/mpp-tempo.js), architecturally
  // distinct from the mpp/mpp-celo legs above: those settle via
  // @x402/express (translated PAYMENT-SIGNATURE, EIP-3009). Tempo settles
  // via Tempo's own hosted relay instead — no x402 facilitator involved at
  // all, so this leg is the only proof this repo has that the real relay
  // wire format actually works (the offline test suite only proves our own
  // validate/broadcast logic against injected stubs, by design — see PR
  // #812). Own try/catch (not shared with mpp/mpp-celo above): a Tempo
  // failure must never be misattributed to the "mpp" rail key.
  //
  // Same burner as every other leg (BURNER_KEY / `account` — Tempo is the
  // same secp256k1 address space as any EVM chain), funded separately with
  // real PathUSD on Tempo mainnet — no new secret needed. Skips cleanly
  // (no railFail) when the server doesn't offer a tempo challenge at all,
  // which is the honest signal for "TEMPO_API_KEY unset on prod" rather
  // than a rail regression.
  await (async () => {
    try {
      const [{ Mppx: MppClientNS, tempo: mppTempo }, { Challenge: MppChallenge, Receipt: MppReceipt }] = await Promise.all([
        import("mppx/client"), import("mppx"),
      ]);
      const heartbeatHeaders = () => {
        if (!secret) return {};
        const minute = Math.floor(Date.now() / 60_000);
        return { "X-Heartbeat-Token": createHmac("sha256", secret).update(`heartbeat:${minute}`).digest("base64url").slice(0, 32) };
      };
      const url = `${TARGET}/api/uuid`;
      const bare = await fetch(url, { headers: heartbeatHeaders() });
      if (bare.status !== 402) {
        railFail("mpp-tempo", `expected a 402 challenge from /api/uuid, got HTTP ${bare.status} — the leg proved nothing`);
        return;
      }
      const wwwAuth = bare.headers.get("www-authenticate");
      const tempoCh = wwwAuth
        ? MppChallenge.fromHeadersList(new Headers({ "WWW-Authenticate": wwwAuth })).find((c) => c.method === "tempo" && c.intent === "charge")
        : null;
      if (!tempoCh) {
        console.log("\nSKIP  mpp-tempo — no tempo/charge challenge on the live 402 (TEMPO_API_KEY unset on prod; not a rail regression)");
        return;
      }
      // autoSwap: pay a USDC.e-first challenge from the PathUSD-funded burner via Tempo's DEX (no-op when currencies match).
      const tempoClient = MppClientNS.create({ methods: [mppTempo.charge({ account, autoSwap: true })], polyfill: false });
      // Credential creation talks to Tempo's public RPC (nonce, fee fields,
      // simulation) BEFORE any money moves. One visible retry: the 2026-08-18
      // 07:27 run threw "Cannot convert undefined to a BigInt" here (viem's
      // hexToBigInt on a null RPC fee-field reply) with the identical
      // challenge minting fine minutes before and after — a real signing bug
      // reproduces on the second try and still fails the leg; a single null
      // reply from a public RPC no longer pages as a rail regression. The
      // first error is always printed, so a pattern stays visible.
      const mintCredential = async () => tempoClient.createCredential(
        new Response(null, { status: 402, headers: { "WWW-Authenticate": MppChallenge.serialize(tempoCh) } })
      );
      let credential;
      try {
        credential = await mintCredential();
      } catch (e1) {
        console.warn(`WARN  mpp-tempo credential creation threw once (${(e1?.message || String(e1)).slice(0, 120)}) - retrying in 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        credential = await mintCredential();
      }
      if (!/^Payment /.test(credential)) {
        railFail("mpp-tempo", `client produced a non-tempo credential (${credential.slice(0, 24)}…) — native path not taken`);
        return;
      }
      const paid = await fetch(url, { headers: { ...heartbeatHeaders(), Authorization: credential } });
      const body = await paid.json().catch(() => ({}));
      if (paid.status === 200 && Array.isArray(body.uuids)) {
        const receiptHdr = paid.headers.get("payment-receipt");
        let ref = null;
        if (receiptHdr) {
          try { ref = MppReceipt.deserialize(receiptHdr)?.reference || null; } catch { /* best-effort */ }
        }
        if (!receiptHdr) {
          railFail("mpp-tempo", "settled 200 over Authorization: Payment but carried no Payment-Receipt header — Tempo receipt mirroring is broken");
        } else {
          console.log(`\nOK    mpp-tempo   /api/uuid  → settled over Tempo's native relay (Authorization: Payment, payer ${account.address})${ref ? `\n      Payment-Receipt tx: https://explore.tempo.xyz/tx/${ref}` : ""}`);
          noteRail("mpp-tempo", true);
          // VOLUME (2026-08-19): after the rail is proven by the settle above,
          // buy the same $0.001 route TEMPO_CANARY_TX_COUNT-1 more times (DEFAULT
          // 1 = the graded settle only; volume moved to tempo-volume.yml, ~1,000/
          // day from the USDC.e-funded burner) so our own Tempo
          // activity is real on-chain volume: the MPP leaderboard ranks by
          // inbound transfers in a ~15h window, the router's proven-seller
          // gate needs >= SOR_TEMPO_MIN_SETTLED_TX, and Tempo's transfer feed
          // attributes by recipient. Each buy is a fresh 402 -> challenge ->
          // credential -> settle (credentials are single-use). Volume failures
          // never fail the rail verdict (that was the first settle); a low
          // success rate is printed loudly so a relay/burner problem is seen.
          // Default 1: the graded settle above IS the rail proof; the ~1,000/day of
          // Tempo volume Mike asked for rides the 2-hourly tempo-volume.yml
          // (scripts/tempo-volume.js, 12 x 84) so one wallet never signs hundreds
          // of credentials inside the canary's timeout. Raise here only ad hoc.
          const volumeTarget = Math.max(1, Math.min(1000, Number(process.env.TEMPO_CANARY_TX_COUNT || 1)));
          if (volumeTarget > 1) {
            let okCount = 1, failCount = 0, lastErr = null;
            const t0 = Date.now();
            for (let i = 1; i < volumeTarget; i++) {
              try {
                const again402 = await fetch(url, { headers: heartbeatHeaders() });
                const www2 = again402.headers.get("www-authenticate");
                const ch2 = www2 ? MppChallenge.fromHeadersList(new Headers({ "WWW-Authenticate": www2 })).find((c) => c.method === "tempo" && c.intent === "charge") : null;
                if (!ch2) { failCount++; lastErr = `no tempo challenge on 402 #${i}`; continue; }
                const cred2 = await tempoClient.createCredential(new Response(null, { status: 402, headers: { "WWW-Authenticate": MppChallenge.serialize(ch2) } }));
                const paid2 = await fetch(url, { headers: { ...heartbeatHeaders(), Authorization: cred2 } });
                if (paid2.status === 200 && paid2.headers.get("payment-receipt")) okCount++;
                else { failCount++; lastErr = `HTTP ${paid2.status} ${JSON.stringify(settleRejectReason(paid2.headers) || {}).slice(0, 100)}`; }
                await paid2.arrayBuffer().catch(() => {});
              } catch (e) {
                failCount++; lastErr = (e?.message || String(e)).slice(0, 120);
              }
              // Stop early if the rail has clearly gone bad mid-run: 10 straight failures.
              if (failCount >= 10 && okCount <= 1) { console.warn("WARN  mpp-tempo volume: 10 failures with no further success - stopping the volume loop"); break; }
            }
            const secs = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(`      mpp-tempo volume: ${okCount}/${volumeTarget} settled at $0.001 in ${secs}s${failCount ? ` (${failCount} failed; last: ${lastErr})` : ""}`);
            if (okCount < volumeTarget * 0.8) console.warn(`WARN  mpp-tempo volume under 80% (${okCount}/${volumeTarget}) - burner runway or relay health, investigate (rail verdict unaffected)`);
          }
        }
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        railFail("mpp-tempo", `did NOT settle (HTTP 402, payer ${account.address}) — reason: ${JSON.stringify(reason)} (unfunded PathUSD burner on Tempo, relay outage, or a wire-format drift from the last verified relay contract)`);
      } else {
        railFail("mpp-tempo", `HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      railFail("mpp-tempo", `errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Pinned EVM legs — Polygon, Arbitrum, Monad, Celo: same negotiation as the Robinhood
  // leg above (filter the live 402's accepts down to ONE CAIP-2 chain and pay
  // that, so settlement cannot silently fall back to Base). Same burner
  // address, funded with USDC on each chain. $0.001/day per rail keeps a
  // visible internal settle on /revenue for every offered rail. Informational:
  // failures WARN, never page (the Base verdict above decides paging).
  for (const leg of [
    { key: "polygon", caip2: "eip155:137", sym: "USDC", chainLabel: "Polygon", tx: (h) => `https://polygonscan.com/tx/${h}` },
    { key: "arbitrum", caip2: "eip155:42161", sym: "USDC", chainLabel: "Arbitrum", tx: (h) => `https://arbiscan.io/tx/${h}` },
    { key: "monad", caip2: "eip155:143", sym: "USDC", chainLabel: "Monad", tx: (h) => `https://monadscan.com/tx/${h}` },
    { key: "celo", caip2: "eip155:42220", sym: "USDC", chainLabel: "Celo", tx: (h) => `https://celoscan.io/tx/${h}` },
    { key: "avalanche", caip2: "eip155:43114", sym: "USDC", chainLabel: "Avalanche", tx: (h) => `https://snowtrace.io/tx/${h}` },
    { key: "sei", caip2: "eip155:1329", sym: "USDC", chainLabel: "Sei", tx: (h) => `https://seiscan.io/tx/${h}?chain=pacific-1` },
    { key: "optimism", caip2: "eip155:10", sym: "USDC", chainLabel: "Optimism", tx: (h) => `https://optimistic.etherscan.io/tx/${h}` },
  ]) {
    try {
      const { x402HTTPClient } = await import("@x402/core/client");
      const http = new x402HTTPClient(client);
      const reqInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${leg.key}-canary` }) };
      const bare = await synthFetch(`${TARGET}/api/hash`, reqInit);
      if (bare.status !== 402) {
        railFail(leg.key, `expected a 402 challenge from /api/hash, got HTTP ${bare.status} — the leg proved nothing`);
        continue;
      }
      let paymentRequired;
      try {
        const bareBody = await bare.json().catch(() => undefined);
        paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
      } catch (e) {
        railFail(leg.key, `could not parse the 402 challenge: ${(e?.message || String(e)).slice(0, 120)} — the leg proved nothing`);
        continue;
      }
      const accepts = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === leg.caip2);
      if (!accepts.length) {
        railFail(leg.key, `${leg.caip2} NOT among the live 402 accepts — the ${leg.chainLabel} rail has DROPPED OUT of the offer (PAYMENT_NETWORKS changed, or the boot /supported guard dropped it). This is the Celo-outage shape and must never be a silent skip.`);
        continue;
      }
      const payload = await client.createPaymentPayload({ ...paymentRequired, accepts });
      const payHeaders = http.encodePaymentSignatureHeader(payload);
      const paid = await synthFetch(`${TARGET}/api/hash`, {
        ...reqInit,
        headers: { ...reqInit.headers, ...payHeaders, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" },
      });
      const body = await paid.json().catch(() => ({}));
      if (paid.status === 200 && typeof body.hex === "string") {
        let tx = null, net = null;
        const receiptHdr = paid.headers.get("payment-response") || paid.headers.get("x-payment-response");
        if (receiptHdr) {
          try {
            const receipt = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"));
            tx = receipt?.transaction || null;
            net = receipt?.network || null;
          } catch { /* best-effort */ }
        }
        console.log(`\nOK    ${leg.key.padEnd(9)} /api/hash  → settled $0.001 ${leg.sym} on ${leg.chainLabel} (payer ${account.address}${net ? `, network ${net}` : ""})${tx ? `\n      tx: ${leg.tx(tx)}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
        noteRail(leg.key, true);
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        railFail(leg.key, `did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded ${leg.sym} burner on ${leg.chainLabel}, facilitator outage, or EIP-712 domain drift)`);
      } else {
        railFail(leg.key, `HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      railFail(leg.key, `errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  }

  // Optional Stellar leg — gated on STELLAR_BURNER_SECRET (an S… Stellar
  // secret key; fund the account with USDC — Circle trustline — plus a little
  // XLM). A dedicated client registers ONLY the Stellar scheme, so the payment
  // can only settle on a stellar:* accept — a true Stellar-rail proof with no
  // silent EVM fallback (same isolation trick as the Solana leg). Fees are
  // facilitator-sponsored per the exact-scheme spec, so the burner spends
  // USDC, not XLM. Informational: failures WARN, never page.
  await (async () => {
    const secret = (process.env.STELLAR_BURNER_SECRET || "").trim();
    if (!secret) { console.log("\nstellar leg: skipped (no STELLAR_BURNER_SECRET)"); return; }
    try {
      const [{ x402Client: StellarX402Client }, { ExactStellarScheme }, { wrapFetchWithPayment: wrapStellar }, sdk] = await Promise.all([
        import("@x402/core/client"), import("@x402/stellar/exact/client"), import("@x402/fetch"), import("@stellar/stellar-sdk"),
      ]);
      const keypair = sdk.Keypair.fromSecret(secret);
      // ExactStellarScheme wants { address, signAuthEntry } — basicNodeSigner
      // supplies the signing half, the public key is added alongside.
      const signer = { address: keypair.publicKey(), ...sdk.contract.basicNodeSigner(keypair, sdk.Networks.PUBLIC) };
      // The client-side scheme builds the Soroban transfer itself, so it needs
      // a Soroban RPC — mainnet has no default (the SDK throws without one).
      // Override with STELLAR_RPC_URL; the fallback is the free public endpoint
      // from the providers list at developers.stellar.org/docs/data/apis/rpc.
      const rpcUrl = (process.env.STELLAR_RPC_URL || "https://mainnet.sorobanrpc.com").trim();
      const stellarClient = new StellarX402Client();
      stellarClient.register("stellar:*", new ExactStellarScheme(signer, { url: rpcUrl }));
      const stellarPay = wrapStellar(synthFetch, stellarClient);
      // Anchor BEFORE the call, with a small skew allowance, so a late-confirming
      // transfer is still attributable to this attempt. Prior runs are days
      // apart, so this window cannot pick up an older debit.
      const legStart = Date.now() - 5_000;
      const res = await stellarPay(`${TARGET}/api/hash`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "stellar-canary" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && typeof body.hex === "string") {
        let tx = null;
        const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
        if (receiptHdr) {
          try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"))?.transaction || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    stellar    /api/hash  → settled $0.001 USDC on Stellar (payer ${keypair.publicKey()})${tx ? `\n      tx: https://stellar.expert/explorer/public/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
        noteRail("stellar", true);
      } else if (res.status === 402) {
        // Ask the CHAIN before believing the 402. See stellarDebitedSince().
        const reason = settleRejectReason(res.headers);
        const detail = settleRejectDetail(res.headers);
        // simulation_failed is a durable verify-time reject (payload parsed,
        // amount/asset/payTo matched, then Soroban simulateTransaction failed
        // on the facilitator's RPC). It is NOT the late-settle race, and it is
        // NOT an empty burner — those have different signatures. Log the full
        // receipt so the next page names the underlying HostError, not only the
        // bucket code (measured 2026-08-10: three consecutive canaries, OZ
        // fee-bump account quiet since 11:23Z while our offer stayed live).
        if (detail?.errorMessage) {
          console.error(`      stellar facilitator detail: ${JSON.stringify(detail)}`);
        }
        const late = await stellarDebitedSince(keypair.publicKey(), legStart);
        if (late) {
          railFail("stellar",
            `SETTLED LATE — we answered 402 (facilitator reason ${JSON.stringify(reason)}) but ` +
            `${late.amount} USDC left the payer on-chain at ${late.created_at}. The rail is NOT broken; ` +
            `we judged the settle before Stellar could close a ledger, so the buyer WAS charged and got nothing.`);
        } else if (reason === "invalid_exact_stellar_payload_simulation_failed") {
          const msgBit = detail?.errorMessage ? `; errorMessage=${JSON.stringify(detail.errorMessage)}` : "";
          railFail("stellar",
            `VERIFY SIMULATION FAILED (HTTP 402, payer ${keypair.publicKey()}) — OpenZeppelin ` +
            `facilitator rejected the signed Soroban transfer at verify ` +
            `(invalid_exact_stellar_payload_simulation_failed${msgBit}). No USDC left the burner. ` +
            `Our 402 still offers stellar:pubnet; this is facilitator/RPC-side, not a missing ` +
            `accept or an empty wallet.`);
        } else {
          railFail("stellar",
            `did NOT settle (HTTP 402, payer ${keypair.publicKey()}) — facilitator reason ` +
            `${JSON.stringify(reason)}, and no USDC debit appeared on-chain either ` +
            `(missing trustline/funds, facilitator outage, or stellar missing from the live accepts)`);
        }
      } else {
        railFail("stellar", `HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      railFail("stellar", `errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Optional Algorand leg — gated on ALGORAND_BURNER_MNEMONIC (a 25-word
  // Algorand mnemonic; fund the account with USDC — ASA 31566704 — and make
  // sure it has OPTED IN to that asset, or every buy 402s even though it's
  // funded). A dedicated client registers ONLY the Algorand scheme, so the
  // payment can only settle on an algorand:* accept — a true Algorand-rail
  // proof with no silent EVM fallback (same isolation trick as the
  // Solana/Stellar legs). Fees are facilitator-sponsored per the exact-scheme
  // spec, so the burner spends USDC, not ALGO. Informational: failures WARN,
  // never page.
  await (async () => {
    const mnemonic = (process.env.ALGORAND_BURNER_MNEMONIC || "").trim();
    if (!mnemonic) { console.log("\nalgorand leg: skipped (no ALGORAND_BURNER_MNEMONIC)"); return; }
    try {
      const [{ x402Client: AvmX402Client }, { ExactAvmScheme }, { wrapFetchWithPayment: wrapAvm }, { toClientAvmSigner }, algosdk] = await Promise.all([
        import("@x402/core/client"), import("@x402/avm/exact/client"), import("@x402/fetch"), import("@x402/avm"), import("algosdk"),
      ]);
      const account = algosdk.mnemonicToSecretKey(mnemonic);
      const address = account.addr.toString();
      // toClientAvmSigner wants the base64-encoded 64-byte secret key
      // (32-byte seed + 32-byte public key) — exactly algosdk's `sk` format.
      const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
      // The client-side scheme builds the transaction group itself, so it
      // needs an algod URL — mainnet AlgoNode is free and keyless.
      const algodUrl = (process.env.ALGORAND_ALGOD_URL || "https://mainnet-api.algonode.cloud").trim();
      const avmClient = new AvmX402Client();
      avmClient.register("algorand:*", new ExactAvmScheme(signer, { algodUrl }));
      const avmPay = wrapAvm(synthFetch, avmClient);
      const res = await avmPay(`${TARGET}/api/hash`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "algorand-canary" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && typeof body.hex === "string") {
        let tx = null;
        const receiptHdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
        if (receiptHdr) {
          try { tx = JSON.parse(Buffer.from(receiptHdr, "base64").toString("utf8"))?.transaction || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    algorand   /api/hash  → settled $0.001 USDC on Algorand (payer ${address})${tx ? `\n      tx: https://allo.info/tx/${tx}` : "\n      (no settle receipt header found — settlement claimed by 200 only)"}`);
        noteRail("algorand", true);
      } else if (res.status === 402) {
        const reason = settleRejectReason(res.headers);
        noteRail("algorand", false, `did not settle (HTTP 402) — ${JSON.stringify(reason)}`);
        console.warn(`\nWARN  algorand leg did NOT settle (HTTP 402, payer ${address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded or not-opted-in USDC burner, facilitator outage, or algorand missing from the live accepts)`);
      } else {
        noteRail("algorand", false, `HTTP ${res.status}`);
        console.warn(`\nWARN  algorand leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      noteRail("algorand", false, `errored: ${(e?.message || String(e)).slice(0, 160)}`);
      console.warn(`\nWARN  algorand leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // Prompt-cache leg — pays once with cache:true, then repeats the IDENTICAL
  // request unpaid: the pre-paywall cache must answer 200 + X-Cache: hit with
  // the same response object. Real-money proof that opted-in repeats are
  // free. Informational: failures WARN, never page.
  await (async () => {
    try {
      const init = {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek/deepseek-chat", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5, cache: true }),
      };
      const paid = await payOnceWithRetryOn5xx(`${TARGET}/v1/nano/chat/completions`, init);
      const paidBody = await paid.json().catch(() => ({}));
      if (paid.status !== 200 || typeof paidBody.choices?.[0]?.message?.content !== "string") {
        console.warn(`\nWARN  prompt-cache leg: priming buy failed — HTTP ${paid.status} ${JSON.stringify(paidBody).slice(0, 100)}`);
        return;
      }
      const free = await synthFetch(`${TARGET}/v1/nano/chat/completions`, init); // NO payment wrapper — must not need one
      const freeBody = await free.json().catch(() => ({}));
      if (free.status === 200 && free.headers.get("x-cache") === "hit" && freeBody.id === paidBody.id) {
        console.log(`\nOK    prompt-cache /v1/nano/chat/completions  → paid once ($0.003), identical repeat served FREE (X-Cache: hit)`);
      } else {
        console.warn(`\nWARN  prompt-cache leg: repeat was NOT a free hit — HTTP ${free.status}, X-Cache=${free.headers.get("x-cache")}, sameId=${freeBody.id === paidBody.id}`);
      }
    } catch (e) {
      console.warn(`\nWARN  prompt-cache leg errored: ${(e?.message || String(e)).slice(0, 140)}`);
    }
  })();

  // Embeddings cache — DEFAULT-ON (no cache flag anywhere): the llm-embed leg
  // above already paid for this exact body, so an unpaid identical repeat must
  // come back 200 + X-Cache: hit with the same response object. This is the
  // billing-relevant promise in the tool description — prove it daily.
  await (async () => {
    try {
      const init = {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: EMBED_CANARY_INPUT, model: "text-embedding-3-small" }),
      };
      const free = await synthFetch(`${TARGET}/v1/embeddings`, init); // NO payment wrapper — must not need one
      const freeBody = await free.json().catch(() => ({}));
      if (free.status === 200 && free.headers.get("x-cache") === "hit" && Array.isArray(freeBody.data?.[0]?.embedding)) {
        console.log(`\nOK    embed-cache /v1/embeddings  → paid once ($0.002), identical repeat served FREE (X-Cache: hit, default-on)`);
      } else {
        console.warn(`\nWARN  embed-cache leg: repeat was NOT a free hit — HTTP ${free.status}, X-Cache=${free.headers.get("x-cache")}`);
      }
    } catch (e) {
      console.warn(`\nWARN  embed-cache leg errored: ${(e?.message || String(e)).slice(0, 140)}`);
    }
  })();

  const decision = decideCanary(results);
  // Base is graded through `results`/decideCanary, not railFail — its
  // observation is derived read-only from the SAME coreSettled value that
  // already decides the canary's own broken/not-broken verdict above, so
  // this can never disagree with or influence that decision.
  noteRail("base", decision.coreSettled, decision.coreSettled ? undefined : `core tool "${CORE_KIT}" did not settle`);
  // Written unconditionally, before any process.exit() branch below, so
  // per-rail status is captured on every outcome (broken, underfunded,
  // partial-rail, or fully green) - not just the partial-rail path the
  // existing `rails=` output below is scoped to. A skipped leg (no burner
  // key configured) never called noteRail, so it's simply absent here -
  // matching /status's "no observation is no data" rule, not a false "down".
  if (process.env.GITHUB_OUTPUT) {
    try {
      appendFileSync(process.env.GITHUB_OUTPUT, `rail_status=${JSON.stringify(railStatus)}\n`);
    } catch { /* output file missing in local runs — ignore */ }
  }
  const spentUsd = decision.rows.filter((r) => r.cls === "settled").reduce((s, r) => s + (r.priceUsd || 0), 0);
  console.log(`\npayer ${account.address}`);
  console.log(`tools: ${decision.settled} settled, ${results.length - decision.settled} not | spent ~$${spentUsd.toFixed(3)} USDC on Base`);
  if (decision.warnings.length) console.warn(`\nwarnings (non-blocking — upstream/data, not payments):\n  ${decision.warnings.join("\n  ")}`);

  if (decision.broken) {
    const balanceUsd = await baseUsdcBalanceUsd(account.address);
    if (classifyCanaryFailure(decision, { balanceUsd }) === "underfunded") {
      console.error(
        `\nCANARY UNDERFUNDED — the Base burner is down to $${balanceUsd.toFixed(4)} USDC ` +
          `(cheapest failed leg costs more). Settlement itself is PROVEN this run ` +
          `(${decision.settled} tool settle(s) + the chain rails above). ` +
          `Top up ${account.address} on Base. Exiting 3 so this is filed as funding, not an outage.`
      );
      process.exit(3);
    }
    console.error(
      `\nPAID CANARY FAILED — buying looks broken:\n  ${decision.reasons.join("\n  ")}\n` +
        `  (underfunded ruled out: live Base balance ${balanceUsd == null ? "UNREADABLE — see balance-read warnings above" : `$${balanceUsd.toFixed(4)}`})`
    );
    process.exit(1);
  }
  // The rail legs are not part of `results`, so decideCanary() cannot see them.
  // Without this check a rail failure has no path to the exit code at all,
  // which is why Stellar failed ten consecutive runs under a green verdict.
  // Exit 5 (partial-rail), not 1: tools already proved USDC settlement, so
  // /status must not claim a buying outage (mirrors underfunded → exit 3).
  if (classifyRailOutcome({ toolBroken: false, railFailures }) === "partial-rail") {
    const railKeys = railFailures.map((r) => String(r).split(":")[0].trim()).filter(Boolean);
    if (process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(process.env.GITHUB_OUTPUT, `rails=${railKeys.join(",")}\n`);
      } catch { /* output file missing in local runs — ignore */ }
    }
    console.error(
      `\nPAID CANARY PARTIAL — ${railFailures.length} rail leg(s) did not settle cleanly:\n  ` +
        railFailures.join("\n  ") +
        `\n  (settlement PROVEN: ${decision.settled}/${results.length} tools settled. A rail leg is a ` +
        `per-chain payment proof and is graded separately. Exiting 5 so /status records ` +
        `settlement as proven with the failed rail named, not as a buying outage.)`
    );
    process.exit(5);
  }
  console.log(`\npaid-canary OK — buying works (${decision.settled}/${results.length} settled${decision.warnings.length ? `; ${decision.warnings.length} upstream warning(s)` : ""}; all rail legs settled).`);
  // Low-water check AFTER a green verdict: page for a top-up while buying
  // still works, instead of discovering starvation as a 27-leg failure
  // (2026-07-27: the burner silently drained to $0.00 between runs). The
  // threshold covers roughly two full runs; exit 4 = "green but fund soon",
  // handled by the workflow as ok-low. A failed balance read never demotes a
  // green run.
  const lowWater = Number(process.env.CANARY_LOW_WATER_USD || 2);
  const endBalance = await baseUsdcBalanceUsd(account.address);
  const baseLow = Number.isFinite(endBalance) && endBalance < lowWater;
  // Per-chain sweep: the informational chain legs never page, so a starved
  // chain wallet otherwise degrades silently. Threshold default $0.05 —
  // roughly a month of daily $0.001-0.002 legs of warning.
  const chainLowWater = Number(process.env.CANARY_CHAIN_LOW_WATER_USD || 0.05);
  const chainBalances = await Promise.all(
    CHAIN_FUNDING.map(async (c) => ({ key: c.key, label: c.label, lowWater: c.lowWater, usd: await erc20BalanceUsd(account.address, c) }))
  );
  const { low, unreadable } = chainLowWaterReport(chainBalances, { chainLowWater });
  if (unreadable.length) console.warn(`WARN  chain balance sweep: unreadable on ${unreadable.join(", ")} (all RPCs failed) — not treated as low`);
  if (baseLow || low.length) {
    const parts = [];
    if (baseLow) parts.push(`Base $${endBalance.toFixed(4)} (low-water $${lowWater.toFixed(2)})`);
    for (const c of low) parts.push(`${c.label} $${c.usd.toFixed(4)} (low-water $${(c.lowWater ?? chainLowWater).toFixed(2)})`);
    console.warn(
      `\nCANARY BURNER LOW — ${parts.join(" · ")}. ` +
        `Top up ${account.address} before the leg(s) starve. Exiting 4 (green, funding warning).`
    );
    process.exit(4);
  }
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
