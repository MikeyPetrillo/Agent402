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
import { readFileSync, existsSync } from "node:fs";
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
    priceUsd: 0.003,
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
    kit: "price-feed",
    path: "/api/price-pyth",
    method: "POST",
    body: { ids: ["ETHUSD"] },
    priceUsd: 0.001,
    check: (r) => {
      const eth = Array.isArray(r.feeds) && r.feeds.find((f) => f.alias === "ETHUSD");
      return (eth && typeof eth.price === "number" && eth.price > 80 && eth.price < 50000)
        || `expected feeds[ETHUSD].price in (80, 50000), got ${JSON.stringify(r).slice(0, 120)}`;
    },
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
    check: (r) => (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0) || `expected choices[0].message.content, got ${JSON.stringify(r).slice(0, 100)}`,
  },
  {
    // Nano tier — the loop-priced gateway. Same upstream path as the base
    // tier; this leg proves the tier constants + model allowlist against a
    // REAL completion daily (gpt-4.1-nano already served via v1-chat before
    // the nano tier existed, so the model id itself is prod-proven).
    kit: "llm-nano",
    path: "/v1/nano/chat/completions",
    method: "POST",
    body: { model: "openai/gpt-4.1-nano", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 5 },
    priceUsd: 0.003,
    check: (r) => (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0) || `expected choices[0].message.content, got ${JSON.stringify(r).slice(0, 100)}`,
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
      (typeof r.choices?.[0]?.message?.content === "string" && r.choices[0].message.content.length > 0 &&
        r.agent402_router?.category === "general" && r.agent402_router?.quality === "balanced" &&
        typeof r.agent402_router?.served === "string") ||
      `expected routed completion + agent402_router {category, quality, served}, got ${JSON.stringify(r).slice(0, 120)}`,
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
    priceUsd: 0.04,
    check: (r) => (r.pack === "financial-analysis" && Array.isArray(r.steps) && r.steps.filter((s) => s.ok).length >= 2) || `expected pack=financial-analysis with >=2 ok steps, got ${JSON.stringify(r).slice(0, 120)}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/market-brief",
    method: "POST",
    body: { coin: "bitcoin" },
    priceUsd: 0.025,
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
    priceUsd: 0.25,
    check: (r) => (r.pack === "domain-intel" && r.steps?.every(s => s.ok)) || `expected ALL steps ok, got ${r.steps?.map(s=>s.ok?'✓':'✗ '+s.slug).join(',')}`,
  },
  {
    kit: "skill-pack",
    path: "/api/skill/company-dossier",
    method: "POST",
    body: { ticker: "AAPL" },
    priceUsd: 0.50,
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
  "https://base.llamarpc.com",
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
  { key: "polygon", label: "Polygon", token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", rpcs: ["https://polygon.drpc.org", "https://polygon.llamarpc.com"] },
  { key: "arbitrum", label: "Arbitrum", token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.llamarpc.com"] },
  { key: "monad", label: "Monad", token: "0x754704bc059f8c67012fed69bc8a327a5aafb603", rpcs: ["https://rpc.monad.xyz", "https://rpc2.monad.xyz"] },
  { key: "celo", label: "Celo", token: "0xceba9300f2b948710d2653dd7b07f33a8b32118c", rpcs: ["https://forno.celo.org"] },
  { key: "avalanche", label: "Avalanche", token: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", rpcs: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"] },
  { key: "sei", label: "Sei", token: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", rpcs: ["https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com"] },
  { key: "optimism", label: "Optimism", token: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"] },
  { key: "robinhood", label: "Robinhood Chain (USDG)", token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", rpcs: ["https://rpc.mainnet.chain.robinhood.com"] },
];

/** Pure verdict over the chain-balance sweep, exported for offline tests:
 *  low = readable balances under the threshold; unreadable = every-RPC-failed
 *  chains (reported, never treated as low — an RPC outage must not page as a
 *  funding problem). */
export function chainLowWaterReport(balances, { chainLowWater }) {
  const low = [];
  const unreadable = [];
  for (const { key, label, usd } of balances) {
    if (usd == null) unreadable.push(key);
    else if (usd < chainLowWater) low.push({ key, label, usd });
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

  const warnings = rows
    .filter((r) => r.cls !== "settled")
    .map((r) => `${r.kit}:${r.path} [${r.cls}]${r.status ? ` HTTP ${r.status}` : ""}${typeof r.shapeOk === "string" ? ` — ${r.shapeOk}` : ""}`);

  return { broken: reasons.length > 0, coreSettled, settled, unsettled, unreachable, rows, warnings, reasons };
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
      const row = { kit: t.kit, path: t.path, status: res.status, shapeOk, priceUsd: t.priceUsd };
      results.push(row);
      const cls = classifyResult(row);
      if (cls === "settled") console.log(`OK    ${t.kit.padEnd(10)} ${t.path}  → settled $${t.priceUsd.toFixed(3)}`);
      else console.warn(`WARN  ${t.kit}:${t.path} [${cls}] HTTP ${res.status}${typeof shapeOk === "string" ? ` — ${shapeOk}` : ` ${JSON.stringify(body).slice(0, 100)}`}`);
    } catch (e) {
      results.push({ kit: t.kit, path: t.path, status: null, shapeOk: false, transportError: true, priceUsd: t.priceUsd });
      console.warn(`WARN  ${t.kit}:${t.path} [unreachable] ${(e?.message || String(e)).slice(0, 140)}`);
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
      } else if (res.status === 402) {
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
        console.warn(`\nWARN  solana leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
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
        console.warn(`\nWARN  robinhood leg: expected a 402 challenge from /api/hash, got HTTP ${bare.status}`);
        return;
      }
      let paymentRequired;
      try {
        const bareBody = await bare.json().catch(() => undefined);
        paymentRequired = http.getPaymentRequiredResponse((n) => bare.headers.get(n), bareBody);
      } catch (e) {
        console.warn(`\nWARN  robinhood leg: could not parse the 402 challenge: ${(e?.message || String(e)).slice(0, 120)}`);
        return;
      }
      const rh = (paymentRequired.accepts || []).filter((a) => String(a.network || "") === "eip155:4663");
      if (!rh.length) {
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
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        console.warn(`\nWARN  robinhood leg did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded USDG burner, facilitator outage, or EIP-712 domain drift)`);
      } else {
        console.warn(`\nWARN  robinhood leg: HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  robinhood leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
    }
  })();

  // MPP dual-stack leg — proves the NATIVE MPP wire end to end on prod: the
  // live 402 must carry WWW-Authenticate: Payment (src/mpp-shim.js minted it,
  // so MPP_SECRET_KEY is live), a stock mppx client must sign that challenge
  // (EIP-3009 over Base USDC), the buy goes out as Authorization: Payment —
  // NOT PAYMENT-SIGNATURE — and the settled 200 must return an MPP
  // Payment-Receipt. The credential is created from a response containing
  // ONLY the WWW-Authenticate header, so the client cannot silently fall
  // back to the x402 wire (which every other leg already proves). Same Base
  // burner, $0.001. Informational: failures WARN, never page (the EVM
  // verdict above decides paging) — but a WARN that WWW-Authenticate is
  // missing is the early signal the shim (or its secret) dropped out of prod.
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
        console.warn(`\nWARN  mpp leg: expected a 402 challenge from /api/uuid, got HTTP ${bare.status}`);
        return;
      }
      const wwwAuth = bare.headers.get("www-authenticate");
      if (!wwwAuth) {
        console.warn(`\nWARN  mpp leg: 402 has NO WWW-Authenticate: Payment header — the MPP shim is not live (MPP_SECRET_KEY unset on prod, or src/mpp-shim.js unmounted)`);
        return;
      }
      const credential = await mpp.createCredential(
        new Response(null, { status: 402, headers: { "WWW-Authenticate": wwwAuth } })
      );
      if (!/^Payment /.test(credential)) {
        console.warn(`\nWARN  mpp leg: client produced a non-MPP credential (${credential.slice(0, 24)}…) — native path not taken`);
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
        console.log(`\nOK    mpp        /api/uuid  → settled $0.001 over the NATIVE MPP wire (Authorization: Payment, payer ${account.address})${ref ? `\n      Payment-Receipt tx: https://basescan.org/tx/${ref}` : receiptHdr ? "" : "\n      WARN: no Payment-Receipt header on the settled 200"}`);
        if (!receiptHdr) console.warn(`WARN  mpp leg settled but the 200 carried no Payment-Receipt header`);
      } else if (paid.status === 402) {
        const reason = settleRejectReason(paid.headers);
        console.warn(`\nWARN  mpp leg did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)}`);
      } else {
        console.warn(`\nWARN  mpp leg: HTTP ${paid.status} ${JSON.stringify(body).slice(0, 120)}`);
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
        console.warn(`\nWARN  mpp-celo leg: no eip155:42220 challenge on the live 402 (MPP_CHALLENGE_NETWORKS changed on prod?)`);
        return;
      }
      const celoCred = await celoClient.createCredential(
        new Response(null, { status: 402, headers: { "WWW-Authenticate": MppChallenge.serialize(celoCh) } })
      );
      const celoPaid = await celoClient.rawFetch(url, { headers: { ...heartbeatHeaders(), Authorization: celoCred } });
      const celoBody = await celoPaid.json().catch(() => ({}));
      if (celoPaid.status === 200 && Array.isArray(celoBody.uuids)) {
        const celoReceiptHdr = celoPaid.headers.get("payment-receipt");
        let celoRef = null;
        if (celoReceiptHdr) {
          try { celoRef = MppReceipt.deserialize(celoReceiptHdr)?.reference || null; } catch { /* best-effort */ }
        }
        console.log(`\nOK    mpp-celo   /api/uuid  → settled $0.001 over the NATIVE MPP wire on Celo (payer ${account.address})${celoRef ? `\n      Payment-Receipt tx: https://celoscan.io/tx/${celoRef}` : ""}`);
      } else if (celoPaid.status === 402) {
        const reason = settleRejectReason(celoPaid.headers);
        console.warn(`\nWARN  mpp-celo leg did NOT settle (HTTP 402, payer ${account.address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded Celo USDC burner, Celo facilitator outage/sequencer nonce hiccup, or domain drift)`);
      } else {
        console.warn(`\nWARN  mpp-celo leg: HTTP ${celoPaid.status} ${JSON.stringify(celoBody).slice(0, 120)}`);
      }
    } catch (e) {
      console.warn(`\nWARN  mpp leg errored: ${(e?.message || String(e)).slice(0, 160)}`);
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
    { key: "sei", caip2: "eip155:1329", sym: "USDC", chainLabel: "Sei", tx: (h) => `https://seitrace.com/tx/${h}?chain=pacific-1` },
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
      } else if (res.status === 402) {
        // Ask the CHAIN before believing the 402. See stellarDebitedSince().
        const reason = settleRejectReason(res.headers);
        const late = await stellarDebitedSince(keypair.publicKey(), legStart);
        if (late) {
          railFail("stellar",
            `SETTLED LATE — we answered 402 (facilitator reason ${JSON.stringify(reason)}) but ` +
            `${late.amount} USDC left the payer on-chain at ${late.created_at}. The rail is NOT broken; ` +
            `we judged the settle before Stellar could close a ledger, so the buyer WAS charged and got nothing.`);
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
      } else if (res.status === 402) {
        const reason = settleRejectReason(res.headers);
        console.warn(`\nWARN  algorand leg did NOT settle (HTTP 402, payer ${address}) — facilitator reason: ${JSON.stringify(reason)} (unfunded or not-opted-in USDC burner, facilitator outage, or algorand missing from the live accepts)`);
      } else {
        console.warn(`\nWARN  algorand leg: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
      }
    } catch (e) {
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
  if (railFailures.length) {
    console.error(
      `\nPAID CANARY FAILED — ${railFailures.length} rail leg(s) did not settle cleanly:\n  ` +
        railFailures.join("\n  ") +
        `\n  (the tool legs are fine: ${decision.settled}/${results.length} settled. A rail leg is a ` +
        `per-chain payment proof and is graded separately.)`
    );
    process.exit(1);
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
    CHAIN_FUNDING.map(async (c) => ({ key: c.key, label: c.label, usd: await erc20BalanceUsd(account.address, c) }))
  );
  const { low, unreadable } = chainLowWaterReport(chainBalances, { chainLowWater });
  if (unreadable.length) console.warn(`WARN  chain balance sweep: unreadable on ${unreadable.join(", ")} (all RPCs failed) — not treated as low`);
  if (baseLow || low.length) {
    const parts = [];
    if (baseLow) parts.push(`Base $${endBalance.toFixed(4)} (low-water $${lowWater.toFixed(2)})`);
    for (const c of low) parts.push(`${c.label} $${c.usd.toFixed(4)} (low-water $${chainLowWater.toFixed(2)})`);
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
