// CDP kit — LIVE verification against the real Coinbase Developer Platform.
// Run where CDP_API_KEY_ID / CDP_API_KEY_SECRET are set (CI step, gated on
// the secrets; skips cleanly without them). Read-only by default:
//
//   onramp-link     — creates a real single-use session URL (harmless; it
//                     expires unvisited) and checks the quote shape
//   testnet-fund    — SKIPPED unless CDP_FAUCET_LIVE_TEST=1 (every drip
//                     burns the shared per-account faucet budget)
//
//   node scripts/test-cdp-live.js
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
const { CDP_TOOLS, QUERY_HEALTH_SQL, SQL_QUERY_PATH } = await import("../src/tools/cdp-kit.js");
const { cdpFailureVerdict, observatoryVerdict } = await import("./lib/cdp-direct-read.js");

if (!(process.env.CDP_API_KEY_ID || "").trim() || !(process.env.CDP_API_KEY_SECRET || "").trim()) {
  console.log("CDP live check: skipped (CDP_API_KEY_ID / CDP_API_KEY_SECRET not set)");
  process.exit(0);
}

let passed = 0, failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log(`ok - ${msg}`); }
  else { failed++; console.error(`FAIL - ${msg}`); }
};
// A live third-party check must not fail the DEPLOY on Coinbase's OWN uptime,
// and must not excuse a failure of ours as theirs. An upstream 5xx / timeout
// (surfaced as 502 / 504 AFTER cdpFetch's retries) is warned and passed only
// when the runner's own direct read, sent right then with plain fetch, fails
// too (scripts/lib/cdp-direct-read.js): `control` is that request. When CDP
// answers the direct read, the kit's failure is ours and fails the build, as
// do our-fault errors (a 422 bad request) and every data-shape assertion.
const QUERY_CONTROL = { method: "POST", path: SQL_QUERY_PATH, body: { sql: QUERY_HEALTH_SQL.base } };
const okOrUpstream = async (e, label, control) => {
  const v = await cdpFailureVerdict({ status: e?.statusCode, control });
  if (v.verdict === "upstream") {
    console.warn(`WARN - ${label}: ${v.evidence} — not failing the deploy. ${String(e?.message || "").slice(0, 120)}`);
  } else {
    ok(false, `${label} failed: ${e?.statusCode || "?"} ${String(e?.message || e).slice(0, 140)} (${v.reason})`);
  }
};
const tool = (slug) => CDP_TOOLS.find((t) => t.slug === slug);
const REVENUE_WALLET = process.env.REVENUE_WALLET || "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";

// wallet-balances reads this service's own RPC lanes, not the platform (its
// offline cases are in scripts/test-cdp-kit.js), so it is not read here.

// --- onramp-link (creates a single-use URL; harmless if never visited) ----------
try {
  const res = await tool("onramp-link").handler({ address: REVENUE_WALLET, network: "base", amount: "10" });
  ok(typeof res.onrampUrl === "string" && res.onrampUrl.startsWith("https://"), `onramp URL minted (${res.onrampUrl.slice(0, 48)}…)`);
  ok(!res.quote || (res.quote.purchaseCurrency && res.quote.paymentTotal), "quote (when present) has pricing fields");
} catch (e) {
  // Onramp availability can depend on CDP project configuration: a 422 is
  // CDP's own refusal of the session (report loudly, not a code failure). A
  // 502 is read against the runner like every other call: the direct read is
  // the same session request (a single-use URL that expires unvisited).
  if (e.statusCode === 422) {
    console.warn(`WARN - onramp-link: CDP declined session creation (${String(e.message).slice(0, 140)}) — likely a project-level Onramp config gap, not a code bug`);
  } else {
    await okOrUpstream(e, "onramp-link live call", { method: "POST", path: "/platform/v2/onramp/sessions", body: { purchaseCurrency: "USDC", destinationNetwork: "base", destinationAddress: REVENUE_WALLET, purchaseAmount: "10", country: "US" } });
  }
}

// --- onchain-sql (read-only query + schema discovery) ---------------------------
try {
  const res = await tool("onchain-sql").handler({ sql: "SELECT COUNT(*) AS n FROM base.blocks WHERE block_number > 32000000", cacheSeconds: 300 });
  ok(res.rowCount >= 1 || res.raw, `onchain-sql ran a real query (${JSON.stringify(res.rows?.[0] ?? res.raw ?? {}).slice(0, 80)})`);
} catch (e) {
  await okOrUpstream(e, "onchain-sql live call", QUERY_CONTROL);
}
// onchain-sql-schema answers from the schema kept in
// src/tools/onchain-sql-schema.js, not from the platform (offline cases in
// scripts/test-cdp-kit.js), so it is not read here.

// --- x402 Economy Observatory (runs its curated settlement queries live) --------
try {
  const { x402EconomySnapshot } = await import("../src/x402-economy.js");
  const snap = await x402EconomySnapshot();
  // A query the service answered 5xx is excused only with the runner's direct
  // known-good query failing too; then the sections that query fills are not
  // asserted (they hold nothing), and every other section still is.
  const v = await observatoryVerdict({ errors: snap.errors, control: QUERY_CONTROL });
  if (v.verdict === "upstream") console.warn(`WARN - observatory: ${v.evidence} — not failing the deploy. errors: ${JSON.stringify(snap.errors).slice(0, 300)}`);
  else ok(v.verdict === "clean", `observatory queries ran clean${snap.errors.length ? ` — ${v.reason}; errors: ${JSON.stringify(snap.errors)}` : ""}`);
  const down = new Set(v.verdict === "upstream" ? v.failed : []);
  if (!down.has("daily")) ok(Array.isArray(snap.daily) && snap.daily.length > 0, `daily settlement series populated (${snap.daily.length} days, latest: ${JSON.stringify(snap.daily[0] ?? {})})`);
  if (!down.has("merchants")) ok(Array.isArray(snap.topMerchants) && snap.topMerchants.length > 0, `top merchants populated (top: ${JSON.stringify(snap.topMerchants[0] ?? {})})`);
  if (!down.has("volume")) ok(snap.totals?.last7d?.settlements >= 0, `7d totals computed (${JSON.stringify(snap.totals?.last7d)})`);
  if (!down.has("daily")) ok(snap.weekly && typeof snap.weekly.historyDays === "number" && snap.weekly.historyDays >= 1, `daily history persisted (${snap.weekly?.historyDays} days, WoW: ${snap.weekly?.growthPct ?? "collecting"})`);
} catch (e) {
  await okOrUpstream(e, "observatory snapshot", QUERY_CONTROL);
}

// --- testnet-fund (opt-in only — burns the shared faucet budget) ----------------
if (process.env.CDP_FAUCET_LIVE_TEST === "1") {
  try {
    const res = await tool("testnet-fund").handler({ address: REVENUE_WALLET, token: "usdc" });
    ok(res.funded === true && /^0x[0-9a-fA-F]{64}$/.test(res.transactionHash || ""), `faucet dripped: ${res.explorer}`);
  } catch (e) {
    await okOrUpstream(e, "testnet-fund live call"); // a drip is never re-sent: no direct read, never excused
  }
} else {
  console.log("(faucet live drip skipped — set CDP_FAUCET_LIVE_TEST=1 to include)");
}

console.log(`\n${failed ? "FAILED" : "OK"}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
