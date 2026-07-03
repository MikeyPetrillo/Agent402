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

// --- wallet-balances on Solana (read-only) --------------------------------------
try {
  const sol = process.env.SOLANA_REVENUE_WALLET || "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
  const res = await tool("wallet-balances").handler({ address: sol, network: "solana" });
  ok(Array.isArray(res.balances), `solana balances envelope (${res.count} tokens)`);
  const usdc = res.balances.find((b) => (b.symbol || "").toUpperCase() === "USDC" || b.contract === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  ok(Boolean(usdc), "solana revenue wallet shows a USDC (SPL) balance row");
} catch (e) {
  ok(false, `wallet-balances solana live call failed: ${e.statusCode || "?"} ${String(e.message).slice(0, 140)}`);
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

// --- onchain-sql (read-only query + schema discovery) ---------------------------
try {
  const res = await tool("onchain-sql").handler({ sql: "SELECT COUNT(*) AS n FROM base.blocks WHERE block_number > 32000000", cacheSeconds: 300 });
  ok(res.rowCount >= 1 || res.raw, `onchain-sql ran a real query (${JSON.stringify(res.rows?.[0] ?? res.raw ?? {}).slice(0, 80)})`);
} catch (e) {
  ok(false, `onchain-sql live call failed: ${e.statusCode || "?"} ${String(e.message).slice(0, 160)}`);
}
try {
  const res = await tool("onchain-sql-schema").handler({});
  ok(Boolean(res.schema), "onchain-sql-schema returned a schema document");
  // Print every table's column names + the full column detail for
  // base.events — ground truth for the x402 Economy Observatory queries
  // (these log lines ARE the discovery deliverable).
  const tables = res.schema?.tables || res.schema?.schema?.tables || [];
  for (const t of tables) {
    const tname = t.name || t.table || "?";
    const cols = (t.columns || []).map((c) => c.name).join(",");
    console.log(`TABLE ${tname}: ${cols}`);
    if (/events$/.test(String(tname)) && !/encoded/.test(String(tname))) {
      console.log(`EVENTS DETAIL: ${JSON.stringify(t.columns).slice(0, 2500)}`);
    }
  }
  if (!tables.length) console.log(`SCHEMA RAW (first 2000): ${JSON.stringify(res.schema).slice(0, 2000)}`);
} catch (e) {
  ok(false, `onchain-sql-schema live call failed: ${e.statusCode || "?"} ${String(e.message).slice(0, 160)}`);
}

// --- x402 Economy Observatory (runs its curated settlement queries live) --------
try {
  const { x402EconomySnapshot } = await import("../src/x402-economy.js");
  const snap = await x402EconomySnapshot();
  ok(snap.errors.length === 0, `observatory queries ran clean${snap.errors.length ? ` — errors: ${JSON.stringify(snap.errors)}` : ""}`);
  ok(Array.isArray(snap.daily) && snap.daily.length > 0, `daily settlement series populated (${snap.daily.length} days, latest: ${JSON.stringify(snap.daily[0] ?? {})})`);
  ok(Array.isArray(snap.topMerchants) && snap.topMerchants.length > 0, `top merchants populated (top: ${JSON.stringify(snap.topMerchants[0] ?? {})})`);
  ok(snap.totals?.last7d?.settlements >= 0, `7d totals computed (${JSON.stringify(snap.totals?.last7d)})`);
  ok(snap.weekly && typeof snap.weekly.historyDays === "number" && snap.weekly.historyDays >= 1, `daily history persisted (${snap.weekly?.historyDays} days, WoW: ${snap.weekly?.growthPct ?? "collecting"})`);
} catch (e) {
  ok(false, `observatory snapshot failed: ${e.statusCode || "?"} ${String(e.message).slice(0, 200)}`);
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
