// Unit tests for the paid-canary's decision logic — proves the canary pages on
// real BUYING failures and only warns on upstream/data hiccups (the chronic
// false-alarm fix). Pure, no network, no wallet.
import { classifyResult, decideCanary } from "./paid-canary.js";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
