// Unit tests for the paid-canary's decision logic — proves the canary pages on
// real BUYING failures and only warns on upstream/data hiccups (the chronic
// false-alarm fix). Pure, no network, no wallet.
import { classifyResult, decideCanary, settleRejectReason, settleRejectDetail, classifyRailOutcome, errText, cacheRepeatOk } from "./paid-canary.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

// Build a full 9-tool run, all settled, then override specific kits.
const KITS = ["core", "edgar", "search", "macro", "finance", "crypto", "chain", "price-feed", "answer"];
const run = (overrides = {}) => KITS.map((kit) => overrides[kit] || { kit, path: `/api/${kit}`, status: 200, shapeOk: true });

// --- classifyResult ---
ok(classifyResult({ status: 200, shapeOk: true }) === "settled", "200 + good shape → settled");
ok(classifyResult({ status: 200, shapeOk: "wrong" }) === "bad-shape", "200 + bad shape → bad-shape");
ok(classifyResult({ status: 402 }) === "unsettled", "402 → unsettled");
ok(classifyResult({ status: 503 }) === "upstream", "503 → upstream (payment settled, data errored)");
ok(classifyResult({ status: 504 }) === "upstream", "504 → upstream");
ok(classifyResult({ status: 404 }) === "request-error", "404 → request-error");
ok(classifyResult({ transportError: true }) === "unreachable", "transport error → unreachable");

// --- REAL failures from 2026-06-25: must NOT page (buying worked) ---
// Re-run: CoinGecko rate-limited crypto-price (503), everything else settled.
let d = decideCanary(run({ crypto: { kit: "crypto", path: "/api/crypto-price", status: 503 } }));
ok(d.broken === false, "CoinGecko 503 on one tool → NOT broken (buying works)");
ok(d.warnings.some((w) => w.includes("crypto") && w.includes("upstream")), "CoinGecko 503 surfaces as an upstream warning");

// First run: price-pyth returned an isolated 402, rest settled.
d = decideCanary(run({ "price-feed": { kit: "price-feed", path: "/api/price-pyth", status: 402 } }));
ok(d.broken === false, "single isolated 402 (price-pyth) → NOT broken");
ok(d.warnings.some((w) => w.includes("price-feed") && w.includes("unsettled")), "isolated 402 surfaces as an unsettled warning");

// --- genuine buying breaks: MUST page ---
ok(decideCanary(run({ core: { kit: "core", path: "/api/hash", status: 402 } })).broken === true, "core tool 402 → broken (settlement down)");
ok(decideCanary(run({ core: { kit: "core", path: "/api/hash", status: 503 } })).broken === true, "core tool 5xx → broken (deterministic tool should never fail)");
ok(decideCanary(run({ core: { kit: "core", path: "/api/hash", status: null, transportError: true } })).broken === true, "core unreachable → broken (site down)");
ok(decideCanary(KITS.map((kit) => ({ kit, path: `/api/${kit}`, status: 402 }))).broken === true, "all 402 → broken (nothing settles)");

// Half-or-more failing to settle → systemic → page (5 of 9 unsettled, core ok).
const fiveDown = run({
  edgar: { kit: "edgar", path: "/api/x", status: 402 },
  search: { kit: "search", path: "/api/x", status: 402 },
  macro: { kit: "macro", path: "/api/x", status: 402 },
  finance: { kit: "finance", path: "/api/x", status: 402 },
  crypto: { kit: "crypto", path: "/api/x", status: 402 },
});
ok(decideCanary(fiveDown).broken === true, "5/9 unsettled → broken (systemic settlement failure)");

// A few upstream 5xx across data tools (all settled payment) → still NOT broken.
d = decideCanary(run({
  crypto: { kit: "crypto", path: "/api/x", status: 503 },
  answer: { kit: "answer", path: "/api/x", status: 502 },
  finance: { kit: "finance", path: "/api/x", status: 503 },
}));
ok(d.broken === false, "3 upstream 5xx (payment settled) → NOT broken");

// All good → not broken, no warnings.
d = decideCanary(run());
ok(d.broken === false && d.warnings.length === 0, "all settled → not broken, no warnings");

// --- settleRejectReason ---
// A settle-failure 402 carries the FAILED receipt in PAYMENT-RESPONSE; the
// payment-required header is just a fresh challenge. The helper must read the
// receipt first (the 2026-07-16 Robinhood rejection printed "reason: null"
// because only the challenge was decoded).
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const hdrs = (map) => ({ get: (n) => map[n] ?? null });

ok(
  settleRejectReason(hdrs({ "payment-response": b64({ success: false, errorReason: "insufficient_funds", network: "eip155:4663" }) })) === "insufficient_funds",
  "failed receipt → errorReason"
);
ok(
  settleRejectReason(hdrs({ "payment-response": b64({ success: false, errorMessage: "balance too low" }) })) === "balance too low",
  "failed receipt without errorReason → errorMessage"
);
ok(
  settleRejectReason(hdrs({ "x-payment-response": b64({ success: false, errorReason: "expired_authorization" }) })) === "expired_authorization",
  "v1 header name also read"
);
// A SUCCESS receipt on a 402 is not a settle rejection — fall through to the challenge.
ok(
  settleRejectReason(hdrs({
    "payment-response": b64({ success: true, transaction: "0xabc" }),
    "payment-required": b64({ error: "verify failed: bad signature" }),
  })) === "verify failed: bad signature",
  "success receipt → falls through to the challenge error"
);
ok(
  settleRejectReason(hdrs({ "payment-required": b64({ error: "no payment attached" }) })) === "no payment attached",
  "no receipt → challenge error"
);
ok(settleRejectReason(hdrs({ "payment-response": "!!!garbage!!!" })) === null, "malformed receipt, no challenge → null");
ok(settleRejectReason(hdrs({})) === null, "no headers → null");

// --- settleRejectDetail (Stellar simulation_failed needs the HostError too) ---
{
  const d = settleRejectDetail(hdrs({
    "payment-response": b64({
      success: false,
      errorReason: "invalid_exact_stellar_payload_simulation_failed",
      errorMessage: "HostError: Error(Auth, InvalidAction)",
      network: "stellar:pubnet",
    }),
  }));
  ok(d?.errorReason === "invalid_exact_stellar_payload_simulation_failed", "detail keeps errorReason");
  ok(d?.errorMessage === "HostError: Error(Auth, InvalidAction)", "detail keeps errorMessage");
  ok(d?.network === "stellar:pubnet", "detail keeps network");
}
ok(settleRejectDetail(hdrs({})) === null, "detail: no headers → null");

// --- classifyRailOutcome (2026-08-10: Stellar-only fail must not be exit 1) ---
ok(classifyRailOutcome({ toolBroken: false, railFailures: [] }) === "ok", "tools green + no rail fails → ok");
ok(classifyRailOutcome({ toolBroken: false, railFailures: ["stellar: simulation_failed"] }) === "partial-rail", "tools green + rail fail → partial-rail");
ok(classifyRailOutcome({ toolBroken: true, railFailures: ["stellar: simulation_failed"] }) === "broken", "tools broken + rail fail → broken (systemic wins)");
ok(classifyRailOutcome({ toolBroken: true, railFailures: [] }) === "broken", "tools broken alone → broken");

// A failed leg's text carries undici's network cause.
{
  const e = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { code: "ETIMEDOUT" }) });
  const t = errText(e);
  ok(/fetch failed/.test(t) && /ETIMEDOUT/.test(t) && /10\.0\.0\.1:443/.test(t), "a failed leg's error names the network cause");
  ok(errText(new Error("plain")) === "plain", "an error without a cause is reported as is");
}
// The cache legs pass only when unpaid -> 402 and paid -> an unsettled cache hit.
{
  const good = { unpaidStatus: 402, paidStatus: 200, xCache: "hit", sameAnswer: true, settled: false };
  ok(cacheRepeatOk(good), "a cached repeat passes when unpaid gets 402 and paid gets an unsettled hit");
  ok(!cacheRepeatOk({ ...good, unpaidStatus: 200 }), "an unpaid repeat answered 200 fails the cache leg");
  ok(!cacheRepeatOk({ ...good, settled: true }), "a settled paid repeat fails the cache leg");
  ok(!cacheRepeatOk({ ...good, xCache: "miss" }), "a miss on the paid repeat fails the cache leg");
  ok(!cacheRepeatOk({ ...good, sameAnswer: false }), "a different answer fails the cache leg");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
