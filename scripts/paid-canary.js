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
// The x402 client + viem are imported dynamically inside main() so this module
// can be imported for unit tests (of the pure decision logic) without those
// packages installed — CI installs them just before the canary runs.

export const CORE_KIT = "core"; // deterministic baseline (hash): no upstream, so a failure = paywall/facilitator down

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
    priceUsd: 0.001,
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
    kit: "finance",
    path: "/api/stock-quote?symbol=AAPL",
    method: "GET",
    priceUsd: 0.005,
    check: (r) => (r.symbol === "AAPL" && r.currency === "USD" && r.price > 1) || `expected AAPL/USD/price>1, got ${JSON.stringify(r).slice(0, 80)}`,
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
    priceUsd: 0.001,
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
];

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
  const payFetch = wrapFetchWithPayment(fetch, client);

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
    if (health?.flags?.yahooRelay !== true) console.warn(`WARN  preflight: /health.flags.yahooRelay=${health?.flags?.yahooRelay} (set YAHOO_RELAY_URL/TOKEN) — finance tool may warn`);
    else console.log("OK    preflight /health.flags.yahooRelay=true");
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
      const body = await res.json().catch(() => ({}));
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

  const decision = decideCanary(results);
  const spentUsd = decision.rows.filter((r) => r.cls === "settled").reduce((s, r) => s + (r.priceUsd || 0), 0);
  console.log(`\npayer ${account.address}`);
  console.log(`tools: ${decision.settled} settled, ${results.length - decision.settled} not | spent ~$${spentUsd.toFixed(3)} USDC on Base`);
  if (decision.warnings.length) console.warn(`\nwarnings (non-blocking — upstream/data, not payments):\n  ${decision.warnings.join("\n  ")}`);

  if (decision.broken) {
    console.error(`\nPAID CANARY FAILED — buying looks broken:\n  ${decision.reasons.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`\npaid-canary OK — buying works (${decision.settled}/${results.length} settled${decision.warnings.length ? `; ${decision.warnings.length} upstream warning(s)` : ""}).`);
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
