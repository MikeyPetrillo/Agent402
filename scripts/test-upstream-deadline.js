// The shared upstream deadline (src/upstream-deadline.js), on the helper and
// on every kit that reads it.
//   1. The helper: a budget counts down; a read's cap is its own or the
//      budget's remainder; underBudget carries the budget through nested
//      awaits; a stalled read ends at the cap as the 503 deadline class in the
//      exact words the strict sweep's runner probe reads; a refused connection
//      is the 503 unreachable class; a spent budget refuses before any egress;
//      the body read and promise-shaped work map the same way; the init (a
//      dispatcher, headers) rides through untouched.
//   2. Every kit: the published example of one tool per kit, with fetch
//      stubbed to stall until the signal the tool passed aborts (the way undici
//      ends a request at AbortSignal.timeout), under a short handler budget
//      (UPSTREAM_HANDLER_BUDGET_MS, the knob the helper reads for exactly
//      this), answers 503, attributed upstream, naming the upstream and the
//      step, at the budget and never at a kit's own longer cap: the proof that
//      the caps compose and that no kit kept a fixed 504.
//   3. Composition: two sequential reads under one budget end as one deadline
//      answer inside the budget, not one cap each.
// Nothing leaves the machine for the stalled reads; keys are fakes so the
// keyed kits reach their fetch.
process.env.UPSTREAM_HANDLER_BUDGET_MS = "1200";
for (const [k, v] of Object.entries({
  ALCHEMY_API_KEY: "test-alchemy", BRAVE_API_KEY: "test-brave", NEYNAR_API_KEY: "test-neynar", X_BEARER_TOKEN: "test-x",
  EXA_API_KEY: "test-exa", HUNTER_API_KEY: "test-hunter", APOLLO_API_KEY: "test-apollo", DATABENTO_API_KEY: "db-test",
  OPENROUTER_API_KEY: "test-openrouter", TYPESAFE_API_KEY: "test-typesafe", JUPITER_API_BASE: "", SOLANA_RPC_URL: "",
  // The spend-capped kits price a read before it leaves; the stalled reads
  // never book, so the caps only need to admit one priced read.
  X_DATA_DAILY_MAX_USD: "1000000", EXA_DAILY_MAX_USD: "1000000",
})) process.env[k] = v;
// The CDP kit signs a JWT per request: a throwaway P-256 key lets it reach its fetch.
process.env.CDP_API_KEY_ID = "organizations/test/apiKeys/test";
process.env.CDP_API_KEY_SECRET = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
// The X and Exa kits refuse before any read without a cost table (they cannot
// enforce their spend caps). With no table configured, the placeholder table
// stands in: the stalled reads are never booked, so no rate is ever read back.
if (!process.env.UPSTREAM_COSTS_JSON && !process.env.UPSTREAM_COSTS_FILE) {
  process.env.UPSTREAM_COSTS_FILE = new URL("../docs/example-upstream-costs.json", import.meta.url).pathname;
}

import { generateKeyPairSync } from "node:crypto";
import {
  HANDLER_BUDGET_MS, PAYMENT_WINDOW_BUDGET_MS, OPTIONAL_READ_FLOOR_MS, budgetOf, capOf, currentBudget, underBudget, withBudget, budgetSpent,
  upstreamFetch, bodyUnderDeadline, workUnderDeadline, upstreamDeadline, upstreamUnreachable, isUpstreamFailure, handlerBudgetMs,
} from "../src/upstream-deadline.js";
import { runnerProbeLabel } from "./test-non-metered-examples.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const BUDGET = handlerBudgetMs();
const SLACK_MS = 1500;
const DEADLINE_RE = /^([\w .-]+?) did not answer the ([\w -]+) read within (\d+) s \(upstream deadline\); nothing was charged - retry shortly(?:; Memento fallback also failed: .*)?$/;
const UNREACHABLE_RE = /^([\w .-]+?) is unreachable from here \(([\w -]+) read failed before any answer\); nothing was charged - retry shortly$/;
const timeoutErr = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
/** A fetch that never answers and rejects only when the tool's signal aborts.
 *  The signal is kept on the call record: AbortSignal.timeout holds its signal
 *  weakly, so a signal nothing else references is collected and its timer
 *  never fires (a real request holds it; a stub must). */
const stallCalls = [];
const stall = (url, init) => new Promise((_, reject) => {
  stallCalls.push({ url: String(url), hasSignal: init?.signal instanceof AbortSignal, signal: init?.signal });
  if (!(init?.signal instanceof AbortSignal)) return reject(new Error("stub: the read carries no AbortSignal"));
  init.signal.addEventListener("abort", () => reject(timeoutErr()), { once: true });
});
// AbortSignal.timeout's timer is unref'd (a server's listener keeps its loop
// alive; this script has nothing else), so hold the loop open for the stalls.
const keepAlive = setInterval(() => {}, 1000);

// ---------------------------------------------------------------------------
// 1. The helper
// ---------------------------------------------------------------------------
{
  ok(BUDGET === 1200 && HANDLER_BUDGET_MS === 20_000, `the test knob shortens the handler budget (${BUDGET} ms) without moving the production constant (${HANDLER_BUDGET_MS} ms)`);
  const b = budgetOf(500);
  ok(b.remaining() > 0 && b.remaining() <= 500 && b.totalMs === 500, "a budget counts down from its total");
  ok(capOf(8000, b) <= 500 && capOf(100, b) === 100 && capOf(8000, null) === 8000, "a read's cap is its own or the budget's remainder, whichever is shorter; no budget means its own");
  ok(budgetSpent({ remaining: () => OPTIONAL_READ_FLOOR_MS - 1 }) === true && budgetSpent({ remaining: () => OPTIONAL_READ_FLOOR_MS }) === false && budgetSpent(null) === false,
    "budgetSpent reads the optional-read floor and is never true outside a budget");
  ok(currentBudget() === null, "outside a handler there is no budget");
  const inner = async () => { await new Promise((r) => setTimeout(r, 5)); return currentBudget(); };
  const seen = await underBudget(async () => [currentBudget(), await inner(), await Promise.all([inner(), inner()])])();
  ok(seen[0] && seen[0] === seen[1] && seen[2].every((x) => x === seen[0]) && seen[0].totalMs === BUDGET, "underBudget carries one budget through nested awaits and Promise.all");
  ok(await withBudget(() => currentBudget()?.totalMs, 333) === 333, "withBudget runs work under a budget of the given size");
  {
    const knob = process.env.UPSTREAM_HANDLER_BUDGET_MS;
    delete process.env.UPSTREAM_HANDLER_BUDGET_MS;
    const sizes = [await underBudget(() => currentBudget().totalMs)(), await underBudget(() => currentBudget().totalMs, PAYMENT_WINDOW_BUDGET_MS)()];
    process.env.UPSTREAM_HANDLER_BUDGET_MS = knob;
    const short = await underBudget(() => currentBudget().totalMs, PAYMENT_WINDOW_BUDGET_MS)();
    ok(sizes[0] === HANDLER_BUDGET_MS && sizes[1] === PAYMENT_WINDOW_BUDGET_MS && short === BUDGET,
      `a handler runs under its own budget size (${sizes.join(" / ")} ms), and the test knob shortens every one of them (${short} ms)`);
  }

  const d = upstreamDeadline("RugCheck", "report summary", 8000);
  ok(d.statusCode === 503 && d.attribution === "upstream" && d.upstreamFailure === "deadline" && DEADLINE_RE.test(d.message) && isUpstreamFailure(d),
    `the deadline class is a 503 attributed upstream in the probe's words (${d.message})`);
  ok(runnerProbeLabel(503, { error: d.message }) === "RugCheck", "the strict sweep's runner probe reads the shared wording");
  const u = upstreamUnreachable("Chain data", "eth_call");
  ok(u.statusCode === 503 && u.attribution === "upstream" && u.upstreamFailure === "unreachable" && UNREACHABLE_RE.test(u.message) && isUpstreamFailure(u),
    `the unreachable class is a 503 attributed upstream (${u.message})`);
  ok(!isUpstreamFailure(Object.assign(new Error("x"), { statusCode: 503 })) && !isUpstreamFailure(null), "a 503 in other words is not an upstream failure class");

  // A stalled read ends at the cap, through the real signal.
  {
    const t0 = Date.now();
    let err = null;
    try { await upstreamFetch("https://stalled.test/x", {}, { label: "Stalled", step: "probe", timeoutMs: 400, budget: null, tag: null, fetchImpl: stall }); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    ok(err?.upstreamFailure === "deadline" && /within 1 s/.test(err.message) && ms >= 350 && ms < 400 + SLACK_MS, `a stalled read ends at its own cap as the deadline class (${ms} ms, "${err?.message}")`);
  }
  // The budget's remainder wins when shorter, and the message says the cap it ran under.
  {
    const t0 = Date.now();
    let err = null;
    try { await upstreamFetch("https://stalled.test/x", {}, { label: "Stalled", step: "probe", timeoutMs: 8000, budget: budgetOf(300), tag: null, fetchImpl: stall }); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    ok(err?.upstreamFailure === "deadline" && ms >= 250 && ms < 300 + SLACK_MS, `the budget's remainder caps a read with a longer cap of its own (${ms} ms)`);
  }
  // A spent budget refuses before any egress.
  {
    let called = false;
    let err = null;
    try { await upstreamFetch("https://x.test/", {}, { label: "Spent", step: "read", timeoutMs: 8000, budget: { remaining: () => 0 }, tag: null, fetchImpl: async () => { called = true; } }); } catch (e) { err = e; }
    ok(err?.upstreamFailure === "deadline" && called === false && /within 8 s/.test(err.message), "a spent budget with no total is the deadline class before any egress, naming the read's own cap");
    err = null;
    try { await upstreamFetch("https://x.test/", {}, { label: "Spent", step: "read", timeoutMs: 8000, budget: { remaining: () => 0, totalMs: 20_000 }, tag: null, fetchImpl: async () => { called = true; } }); } catch (e) { err = e; }
    ok(err?.upstreamFailure === "deadline" && called === false && /within 20 s/.test(err.message), "a spent handler budget names the budget the earlier reads used up");
  }
  // A refused connection is the unreachable class; the init rides through.
  {
    let seenInit = null;
    let err = null;
    const dispatcher = { marker: true };
    try { await upstreamFetch("https://x.test/", { method: "POST", headers: { a: "b" }, dispatcher }, { label: "Refused", step: "read", budget: null, tag: null, fetchImpl: async (_u, init) => { seenInit = init; throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }); } }); } catch (e) { err = e; }
    ok(err?.upstreamFailure === "unreachable" && seenInit?.method === "POST" && seenInit?.headers?.a === "b" && seenInit?.dispatcher === dispatcher && seenInit?.signal instanceof AbortSignal,
      "a refused connection is the unreachable class, and method, headers, dispatcher and a signal all reach fetch");
  }
  // Body reads and promise-shaped work map the same way.
  {
    const ctx = { label: "Body", step: "text", cap: 5000 };
    let err = null;
    try { await bodyUnderDeadline(Promise.reject(timeoutErr()), ctx); } catch (e) { err = e; }
    ok(err?.upstreamFailure === "deadline" && /within 5 s/.test(err.message), "an abort while the body streams is the deadline class at the read's cap");
    err = null;
    try { await bodyUnderDeadline(Promise.reject(new SyntaxError("bad json")), ctx); } catch (e) { err = e; }
    ok(err instanceof SyntaxError, "any other body failure is rethrown unchanged for the kit's own mapping");
    const t0 = Date.now();
    err = null;
    let expired = false;
    try { await workUnderDeadline(new Promise(() => {}), { label: "Work", step: "render", timeoutMs: 300, budget: null, onExpire: () => { expired = true; } }); } catch (e) { err = e; }
    ok(err?.upstreamFailure === "deadline" && expired && Date.now() - t0 < 300 + SLACK_MS, "promise-shaped work ends at its cap as the deadline class and the expiry hook runs");
    ok(await workUnderDeadline(Promise.resolve(7), { label: "Work", step: "x", timeoutMs: 300, budget: null }) === 7, "work that finishes in time resolves with its value");
  }
}

// ---------------------------------------------------------------------------
// 2. Every kit, stalled, under the short budget
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = stall;
const KITS = [
  // [module, export, slug, input, label regex, step regex]
  ["price-feed-kit.js", "PRICE_FEED_TOOLS", "price-coingecko", { ids: ["bitcoin", "ethereum"] }, /^Price feed$/, /^simple price$/],
  ["dex-kit.js", "DEX_TOOLS", "dex-top-pools", { chain: "Base", project: "uniswap-v3", limit: 5 }, /^DeFiLlama$/, /^pools$/],
  ["dex-kit.js", "DEX_TOOLS", "dex-pool", { poolAddress: "0xd0b53d9277642d899df5c87a3966a349a798f224", network: "base" }, /^Chain$/, /^eth_call$/],
  ["chain-kit.js", "CHAIN_TOOLS", "wallet-balance", { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0", network: "base" }, /^Chain$/, /^eth_getBalance$/],
  ["chain-kit.js", "CHAIN_TOOLS", "block-number", { network: "base" }, /^Chain RPC$/, /^eth_blockNumber$/],
  ["alchemy-data-kit.js", "ALCHEMY_DATA_TOOLS", "tx-receipt", { hash: "0x214b3526ee64f7eabfc94ea536b8680bd95a2da634ebf5149aea189d311be56b", network: "ethereum" }, /^Chain data$/, /^batch of 2 calls$/],
  ["nft-market-kit.js", "NFT_MARKET_TOOLS", "nft-floor", { contract: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d" }, /^Alchemy NFT$/, /^getFloorPrice$/],
  ["mev-and-l2-kit.js", "MEV_AND_L2_TOOLS", "mev-recent-blocks", { limit: 5 }, /^MEV relay [\w.-]+$/, /^bidtraces$/],
  ["mev-and-l2-kit.js", "MEV_AND_L2_TOOLS", "l2-tvl", { limit: 10 }, /^DeFiLlama$/, /^chains$/],
  ["onchain-identity-kit.js", "ONCHAIN_IDENTITY_TOOLS", "eas-attestations", { address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", network: "mainnet", limit: 5 }, /^EAS$/, /^attestations$/],
  ["onchain-identity-kit.js", "ONCHAIN_IDENTITY_TOOLS", "ens-bulk-resolve", { addresses: ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "0x000000000000000000000000000000000000dead"] }, /^ENS resolver$/, /^resolve$/],
  ["prediction-market-kit.js", "PREDICTION_MARKET_TOOLS", "kalshi-markets", { status: "open", limit: 5 }, /^Kalshi$/, /^markets$/],
  ["search.js", "SEARCH_TOOLS", "search-lite", { q: "x402 payment protocol", count: 3 }, /^Search$/, /^web search$/],
  ["search.js", "SEARCH_TOOLS", "answer", { q: "what is the x402 payment protocol?" }, /^Web answer$/, /^answer stream$/],
  ["tts-kit.js", "TTS_TOOLS", "tts-lite", { text: "Hello from Agent402!", voice: "alloy", format: "mp3" }, /^Speech upstream$/, /^speech$/],
  ["crypto-signals-kit.js", "CRYPTO_SIGNALS_TOOLS", "crypto-indicators", { coin: "BTC", interval: "1h", limit: 200, points: 5 }, /^Hyperliquid$/, /^\w+$/],
  ["derivatives-kit.js", "DERIVATIVES_TOOLS", "perp-markets", { limit: 10 }, /^Hyperliquid$/, /^\w+$/],
  ["defi-kit.js", "DEFI_TOOLS", "defi-protocols", { category: "Lending", limit: 5 }, /^DefiLlama$/, /^document$/],
  ["crypto-markets-kit.js", "CRYPTO_MARKETS_TOOLS", "exchange-rates", { currencies: "usd,eur,eth,xau" }, /^Market data upstream$/, /^exchange rates$/],
  ["farcaster-social-kit.js", "FARCASTER_SOCIAL_TOOLS", "fc-channel", { id: "base" }, /^Farcaster upstream$/, /^channel$/],
  ["contract-kit.js", "CONTRACT_TOOLS", "contract-abi", { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "base" }, /^[\w .-]+$/, /^lookup$/],
  ["enrich-kit.js", "ENRICH_TOOLS", "github-repo", { owner: "expressjs", repo: "express" }, /^GitHub$/, /^lookup$/],
  ["b2b-enrich-kit.js", "B2B_ENRICH_TOOLS", "hunter-domain-search", { domain: "stripe.com", limit: 10 }, /^[\w .-]+$/, /^lookup$/],
  ["x-data-kit.js", "X_DATA_TOOLS", "x-search-recent", { query: "x402 -is:retweet", max_results: 10 }, /^X API$/, /^tweets search recent$/],
  ["exa-kit.js", "EXA_TOOLS", "exa-search", { query: "how agent-to-agent micropayment protocols settle onchain", numResults: 5 }, /^Exa$/, /^search$/],
  ["cve-kit.js", "CVE_TOOLS", "cve-lookup", { cve: "CVE-2024-3094" }, /^The NVD API$/, /^lookup$/],
  ["llm-context-kit.js", "LLM_CONTEXT_TOOLS", "llm-context", { query: "x402 payment protocol", maxTokens: 2048 }, /^LLM context$/, /^context$/],
  ["web-kit.js", "WEB_TOOLS", "archive-snapshot", { url: "https://example.com" }, /^Wayback Machine$/, /^availability$/],
  ["edgar-kit.js", "EDGAR_TOOLS", "edgar-filings", { ticker: "AAPL", form: "10-K", limit: 5 }, /^EDGAR$/, /^document$/],
  ["crypto-kit.js", "CRYPTO_TOOLS", "crypto-price", { coins: "BTC,ETH,SOL", currency: "usd" }, /^[\w .-]+$/, /^query$/],
  ["captcha-kit.js", "CAPTCHA_TOOLS", "captcha-verify", { provider: "turnstile", secret: "test-secret", token: "test-token" }, /^Captcha provider$/, /^siteverify$/],
  ["cdp-kit.js", "CDP_TOOLS", "wallet-balances", { address: "0x1111111111111111111111111111111111111111", network: "base" }, /^Coinbase Developer Platform$/, /^token balances$/],
  ["solana-intel-kit.js", "SOLANA_INTEL_TOOLS", "sol-price", { mints: ["So11111111111111111111111111111111111111112"] }, /^Jupiter$/, /^price$/],
];
const mods = new Map();
for (const [file, name] of KITS) if (!mods.has(file)) mods.set(file, await import(`../src/tools/${file}`).then((m) => m[name]));
async function stalled(fn, label) {
  const t0 = Date.now();
  let err = null, out = null;
  try { out = await fn(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  return { err, out, ms, label };
}
// The budget each route is wrapped with (the knob above shortens all of them
// for the stalls below; this is the size production runs). Every route runs
// under its payment window, less the facilitator's settle rule and the settle
// margin, so a route keeps every read and retry it had before the helper.
const { DEFAULT_MAX_TIMEOUT_SECONDS, SETTLE_RULE_SECONDS, SETTLE_MARGIN_SECONDS } = await import("../src/evm-validity.js");
ok(PAYMENT_WINDOW_BUDGET_MS === (DEFAULT_MAX_TIMEOUT_SECONDS - SETTLE_RULE_SECONDS - SETTLE_MARGIN_SECONDS) * 1000 && PAYMENT_WINDOW_BUDGET_MS > HANDLER_BUDGET_MS,
  `the payment-window budget is the stock window less the settle rule and margin (${PAYMENT_WINDOW_BUDGET_MS} ms)`);
for (const [file, , slug] of KITS) {
  const tool = (mods.get(file) || []).find((t) => t.slug === slug);
  ok(tool?.handler?.__budgetMs === PAYMENT_WINDOW_BUDGET_MS, `${slug}: runs under the payment-window budget in production (${tool?.handler?.__budgetMs} ms)`);
}
{
  const tvl = (mods.get("price-feed-kit.js") || []).find((t) => t.slug === "defi-tvl");
  ok(tvl?.handler?.__budgetMs === PAYMENT_WINDOW_BUDGET_MS, "defi-tvl, whose protocol document keeps its 25 s cap, runs under the payment-window budget");
}
// Every kit's call runs together: each is its own handler call with its own budget.
const runs = await Promise.all(KITS.map(([file, , slug, input]) => {
  const tool = (mods.get(file) || []).find((t) => t.slug === slug);
  if (!tool) return { err: new Error(`tool ${slug} not found in ${file}`), ms: 0, label: slug };
  ok(tool.handler.__underBudget === true, `${slug}: the handler is wrapped under the budget`);
  return stalled(() => tool.handler(input), slug);
}));
for (let i = 0; i < KITS.length; i++) {
  const [, , slug, , labelRe, stepRe] = KITS[i];
  const { err, out, ms } = runs[i];
  const m = DEADLINE_RE.exec(err?.message || "");
  ok(err?.statusCode === 503 && err?.attribution === "upstream" && err?.upstreamFailure === "deadline",
    `${slug}: a stalled upstream answers 503 attributed upstream, never a 504 (got ${err ? `${err.statusCode} "${err.message}"` : `served ${JSON.stringify(out).slice(0, 80)}`})`);
  ok(!!m && labelRe.test(m[1]) && stepRe.test(m[2]), `${slug}: the body names the upstream and the step (${m ? `"${m[1]}" / "${m[2]}"` : err?.message})`);
  ok(ms >= BUDGET - 100 && ms < BUDGET + SLACK_MS, `${slug}: it answers at the handler budget, not at the kit's own longer cap (${ms} ms against ${BUDGET})`);
}
ok(stallCalls.length >= KITS.length && stallCalls.every((c) => c.hasSignal), `every stalled read carried an AbortSignal (${stallCalls.length} reads)`);
// Two upstreams take the key in the URL by their own design (Alchemy in the
// path, Hunter as a query parameter); every other key travels in a header.
ok(!stallCalls.some((c) => /\btest-(alchemy|brave|neynar|exa|hunter|openrouter|typesafe|x|apollo)\b/.test(c.url) && !/alchemy\.com\/.*test-alchemy|hunter\.io\/.*test-hunter/.test(c.url)),
  "no fake key reached a URL other than the host that takes it there (Alchemy path, Hunter query)");

// Decision-1 and the judge walk (not tool arrays): the same class under a budget.
{
  const { askDecisionOne } = await import("../src/decision-one.js");
  const r = await stalled(() => withBudget(() => askDecisionOne({ state: "x", questions: { q: { type: "noul", instructions: "is it" } } }, { fetchImpl: stall })), "decision-one");
  ok(r.err?.statusCode === 503 && r.err?.mayBeBilled === true && /^Judgment upstream did not answer the judgment read within/.test(r.err?.message || "") && r.ms < BUDGET + SLACK_MS,
    `decision-one: a stalled judgment is a 503 naming the step, may be billed, inside the budget (${r.ms} ms, "${r.err?.message}")`);
  const { judge } = await import("../src/tools/judge-kit.js");
  const j = await stalled(() => judge({ state: "x", questions: { q: { type: "noul", instructions: "is it" } } }, { fetchImpl: stall }), "judge");
  ok(j.err?.statusCode === 503 && j.err?.mayBeBilled === true && /^Judgment upstream did not answer the judgment read within/.test(j.err?.message || "") && j.ms >= BUDGET - 100 && j.ms < BUDGET + SLACK_MS,
    `judge: the backend walk runs under one budget and a stalled first backend ends it as the 503 (${j.ms} ms)`);
}

// ---------------------------------------------------------------------------
// 3. Composition: two sequential reads under one budget are one deadline
// ---------------------------------------------------------------------------
{
  const t0 = Date.now();
  let err = null, reads = 0;
  try {
    await withBudget(async () => {
      const read = (step) => upstreamFetch("https://stalled.test/" + step, {}, { label: "Twice", step, timeoutMs: 5000, tag: null, fetchImpl: (u, i) => { reads++; return stall(u, i); } });
      try { await read("first"); } catch { /* the first read spent the budget */ }
      await read("second");
    }, 600);
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok(err?.upstreamFailure === "deadline" && /the second read within 1 s/.test(err.message) && reads === 1 && ms >= 550 && ms < 600 + SLACK_MS,
    `two sequential reads under one 600 ms budget end as one deadline inside it: the second never leaves (${reads} read(s), ${ms} ms, "${err?.message}")`);
}

clearInterval(keepAlive);
globalThis.fetch = realFetch;
console.log(`\ntest-upstream-deadline: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
