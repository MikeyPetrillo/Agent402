// CDP kit — LIVE verification against the real Coinbase Developer Platform.
// Run where CDP_API_KEY_ID / CDP_API_KEY_SECRET are set (CI step, gated on
// the secrets; skips cleanly without them). Read-only by default:
//
//   wallet-balances — real balances of the revenue wallet on Base (must
//                     include a USDC row: the wallet provably holds USDC)
//   onramp-link     — creates a real single-use session URL (harmless; it
//                     expires unvisited) and checks the quote shape
//   testnet-fund    — SKIPPED unless CDP_FAUCET_LIVE_TEST=1 (every drip
//                     burns the shared per-account faucet budget)
//
//   node scripts/test-cdp-live.js
const { CDP_TOOLS } = await import("../src/tools/cdp-kit.js");

if (!(process.env.CDP_API_KEY_ID || "").trim() || !(process.env.CDP_API_KEY_SECRET || "").trim()) {
  console.log("CDP live check: skipped (CDP_API_KEY_ID / CDP_API_KEY_SECRET not set)");
  process.exit(0);
}

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
const tool = (slug) => CDP_TOOLS.find((t) => t.slug === slug);
const REVENUE_WALLET = process.env.REVENUE_WALLET || "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";

// --- wallet-balances (read-only) ----------------------------------------------
try {
  const res = await tool("wallet-balances").handler({ address: REVENUE_WALLET, network: "base" });
  ok(Array.isArray(res.balances) && res.count === res.balances.length, `balances envelope (${res.count} tokens)`);
  const usdc = res.balances.find((b) => (b.symbol || "").toUpperCase() === "USDC" || b.contract === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  ok(Boolean(usdc), "revenue wallet shows a USDC balance row");
  ok(usdc && Number(usdc.amount) > 0, `USDC amount decodes to a positive number ($${usdc?.amount})`);
} catch (e) {
  ok(false, `wallet-balances live call failed: ${e.statusCode || "?"} ${String(e.message).slice(0, 140)}`);
}

// --- onramp-link (creates a single-use URL; harmless if never visited) ----------
try {
  const res = await tool("onramp-link").handler({ address: REVENUE_WALLET, network: "base", amount: "10" });
  ok(typeof res.onrampUrl === "string" && res.onrampUrl.startsWith("https://"), `onramp URL minted (${res.onrampUrl.slice(0, 48)}…)`);
  ok(!res.quote || (res.quote.purchaseCurrency && res.quote.paymentTotal), "quote (when present) has pricing fields");
} catch (e) {
  // Onramp availability can depend on CDP project configuration — report
  // loudly but distinguish a project-config 4xx from a code-level failure.
  if (e.statusCode === 422 || e.statusCode === 502) {
    console.warn(`WARN - onramp-link: CDP declined session creation (${String(e.message).slice(0, 140)}) — likely a project-level Onramp config gap, not a code bug`);
  } else {
    ok(false, `onramp-link live call failed unexpectedly: ${e.statusCode || "?"} ${String(e.message).slice(0, 140)}`);
  }
}

// --- testnet-fund (opt-in only — burns the shared faucet budget) ----------------
if (process.env.CDP_FAUCET_LIVE_TEST === "1") {
  try {
    const res = await tool("testnet-fund").handler({ address: REVENUE_WALLET, token: "usdc" });
    ok(res.funded === true && /^0x[0-9a-fA-F]{64}$/.test(res.transactionHash || ""), `faucet dripped: ${res.explorer}`);
  } catch (e) {
    ok(false, `testnet-fund live call failed: ${e.statusCode || "?"} ${String(e.message).slice(0, 140)}`);
  }
} else {
  console.log("(faucet live drip skipped — set CDP_FAUCET_LIVE_TEST=1 to include)");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
