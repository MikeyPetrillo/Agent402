// Paid-path canary — buys ONE tool from each live-data kit to prove that
// *buying* still settles end-to-end AND that each kit's handler still
// delivers a documented payload. Total spend: ~$0.059 per run (nine tools).
//
// Deliberately ordered cheapest → most-likely-to-be-flaky so a fast-fail on
// the baseline aborts the rest. Each tool has a strict shape check; a 200
// with garbage content fails the canary, same as a non-200.
//
// Exit codes:
//   0 = ALL tools settled & verified
//   1 = at least one paid call failed (alert opens GitHub issue)
//   2 = misconfigured (no BURNER_KEY)
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const TARGET = process.env.TARGET_URL || "https://agent402.tools";
const KEY_FILE = process.env.KEY_FILE || "/tmp/agent-key";
const pk = (process.env.BURNER_KEY || "").trim() || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
if (!pk) { console.error("paid-canary: no BURNER_KEY / KEY_FILE — cannot run the paid check"); process.exit(2); }

const account = privateKeyToAccount(pk);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const payFetch = wrapFetchWithPayment(fetch, client);

// Per-tool spec: { kit, path, method, body?, priceUsd, check(body) → bool|string }
// `check` returns true on success or a string explaining what was wrong.
// `priceUsd` is informational — the actual amount is set by the server's 402
// envelope, not by us. It's tallied for the cost report at the end.
const TOOLS = [
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
    // SEC's CIK for Apple is 0000320193 — a stable known-good value.
    check: (r) => r.cik === "0000320193" || `expected cik 0000320193, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "search",
    path: "/api/search?q=bitcoin&count=1",
    method: "GET",
    priceUsd: 0.01,
    // Brave Web Search returns >=1 result for a popular term. Swapped from
    // /api/search-suggest after canary surfaced that Suggest is on a different
    // Brave subscription tier than Web Search — the deployment's BRAVE_API_KEY
    // is authorized for /web/search but not /suggest/search.
    check: (r) => (Array.isArray(r.results) && r.results.length > 0) || `expected non-empty results array, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "macro",
    path: "/api/treasury-yield-curve",
    method: "GET",
    priceUsd: 0.005,
    // 10y Treasury yield has been between 0.5% and 25% across every recorded
    // year since 1953. If yr10 sits outside this band, FRED returned junk OR
    // our parser is broken.
    check: (r) => (typeof r.yr10 === "number" && r.yr10 > 0 && r.yr10 < 25) || `expected yr10 in (0, 25), got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "finance",
    path: "/api/stock-quote?symbol=AAPL",
    method: "GET",
    priceUsd: 0.005,
    // AAPL always trades >$1, denominated in USD, on any market day. Out of
    // hours Yahoo still returns the last close in the meta block.
    check: (r) => (r.symbol === "AAPL" && r.currency === "USD" && r.price > 1) || `expected AAPL/USD/price>1, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "crypto",
    path: "/api/crypto-price?coins=BTC",
    method: "GET",
    priceUsd: 0.005,
    // BTC has been >$1k since 2017; assertion floor is intentionally generous
    // to ride out a black-swan drawdown without false-positive alerting.
    check: (r) => (r.coins?.bitcoin?.price > 1000) || `expected bitcoin.price > 1000, got ${JSON.stringify(r).slice(0, 80)}`,
  },
  {
    kit: "chain",
    path: "/api/gas-snapshot",
    method: "POST",
    body: { network: "base" },
    priceUsd: 0.001,
    // End-to-end probe of ALCHEMY_API_KEY: x402 settles BEFORE the handler
    // runs, so a missing/expired key returns 503 AFTER payment — same env-var-
    // flap class that bit yahoo-relay. Base gas has lived between 0.001 and
    // 50 gwei since launch; baseFeeGwei outside (0, 1000) means Alchemy
    // returned junk OR our fee parser broke. fast.totalGwei must be at least
    // baseFeeGwei (priority can be 0 in idle blocks).
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
    // Pyth Hermes is keyless but rate-limited per-IP; the 5xx retry above
    // absorbs a transient throttle. ETH has traded between $80 and $5000
    // across every minute since 2018 — assertion floor/ceiling deliberately
    // wide so a black-swan move doesn't false-alert.
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
    // "Speed of light" is encyclopedia-stable — answer text doesn't drift with
    // the news cycle, and Brave's index always carries Wikipedia/Britannica
    // citations for it. Validates both the SSE assembler (answer present) and
    // the <citation> parser (citationCount > 0). Probes BRAVE_ANSWERS_API_KEY,
    // which is on a distinct Brave subscription from BRAVE_API_KEY — same
    // failure mode that bit /api/search-suggest. Placed last because it's the
    // most expensive AND the most likely to flake on plan-tier issues.
    check: (r) => (typeof r.answer === "string" && r.answer.length > 0 && r.citationCount > 0) || `expected non-empty answer + citationCount>0, got ${JSON.stringify(r).slice(0, 80)}`,
  },
];

let passed = 0, failed = 0, spentUsd = 0;
const failures = [];

// Config preflight: /health.flags.yahooRelay must be true.
// If it's false, /api/stock-quote will hit Yahoo through Railway's
// null-routed egress and ETIMEDOUT — wasting USDC on a doomed call when
// the real cause is a missing env var. Recorded as a regular failure so
// the rest of the canary still runs and independent regressions surface.
try {
  const health = await (await fetch(`${TARGET}/health`)).json();
  if (health?.flags?.yahooRelay !== true) {
    failed++;
    const msg = `preflight: /health.flags.yahooRelay=${health?.flags?.yahooRelay} — set YAHOO_RELAY_URL and YAHOO_RELAY_TOKEN in Railway`;
    failures.push(msg);
    console.error(`FAIL  ${msg}`);
  } else {
    console.log(`OK    preflight /health.flags.yahooRelay=true`);
  }
} catch (e) {
  failed++;
  const msg = `preflight: GET ${TARGET}/health failed: ${(e && e.message ? e.message : String(e)).slice(0, 160)}`;
  failures.push(msg);
  console.error(`FAIL  ${msg}`);
}

// One-shot retry on 5xx — absorbs transient upstream throttles (CoinGecko
// rate-limits, Yahoo blips, Brave plan-tier hiccups) without papering over
// real paywall/facilitator outages: those persist past a 10s backoff and
// the second attempt fails again. The cost is one extra paid call in the
// failure case (Agent402 settles USDC before the handler runs, so a 5xx
// has already spent); at ≤$0.03/tool the insurance is cheap.
async function payOnceWithRetryOn5xx(url, init) {
  const first = await payFetch(url, init);
  if (first.status < 500 || first.status > 599) return first;
  // Read+discard the first body so the connection releases, then back off.
  await first.text().catch(() => "");
  console.warn(`  retry ${init.method} ${url} after HTTP ${first.status} (10s backoff)`);
  await new Promise((r) => setTimeout(r, 10000));
  return payFetch(url, init);
}

for (const t of TOOLS) {
  const url = `${TARGET}${t.path}`;
  const init = { method: t.method };
  if (t.body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(t.body);
  }
  try {
    const res = await payOnceWithRetryOn5xx(url, init);
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      failed++;
      const msg = `${t.kit}:${t.path} → HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`;
      failures.push(msg);
      console.error(`FAIL  ${msg}`);
      continue;
    }
    const check = t.check(body);
    if (check === true) {
      passed++;
      spentUsd += t.priceUsd;
      console.log(`OK    ${t.kit.padEnd(8)} ${t.path}  → settled $${t.priceUsd.toFixed(3)}`);
    } else {
      failed++;
      const msg = `${t.kit}:${t.path} → shape check: ${check}`;
      failures.push(msg);
      console.error(`FAIL  ${msg}`);
    }
  } catch (e) {
    failed++;
    const msg = `${t.kit}:${t.path} → ${(e && e.message ? e.message : String(e)).slice(0, 160)}`;
    failures.push(msg);
    console.error(`FAIL  ${msg}`);
  }
}

console.log(`\npayer ${account.address}`);
console.log(`tools: ${passed} ok, ${failed} failed | spent: $${spentUsd.toFixed(3)} USDC on Base`);
if (failed > 0) {
  console.error(`\nPAID CANARY FAILED (${failed}/${TOOLS.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`paid-canary OK — all ${passed} kits delivered through the paid x402 path`);
process.exit(0);
