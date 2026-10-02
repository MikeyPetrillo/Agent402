// Unit test for the composite-spend guard (research/dossier upstream-drain
// protection). Offline, fast, in CI.
process.env.COMPOSITE_GUARD_MAX_FAILS = "3";
process.env.COMPOSITE_GUARD_WINDOW_MS = "60000";
process.env.COMPOSITE_GUARD_BLOCK_MS = "600";
process.env.COMPOSITE_GUARD_GLOBAL_MAX_FAILS = "6";
process.env.COMPOSITE_GUARD_GLOBAL_PAUSE_MS = "700";

const g = await import("../src/composite-spend-guard.js");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "ok" : "NOT OK") + " - " + m); };

const P = "0xPayerAAA";
ok(!g.compositeGuardBlocked(P), "a clean payer is not blocked");
ok(!g.compositeGuardBlocked(null), "a null/unknown payer is never blocked (no false-positive)");

g.recordCompositeSpendFailure(P);
g.recordCompositeSpendFailure(P);
ok(!g.compositeGuardBlocked(P), "2 failures (under the threshold of 3) does NOT block");
g.recordCompositeSpendFailure(P);
ok(g.compositeGuardBlocked(P), "the 3rd spend-then-fail BLOCKS the payer");

const Q = "0xPayerBBB";
g.recordCompositeSpendFailure(Q);
g.recordCompositeSpendFailure(Q);
g.recordCompositeSpendSuccess(Q); // a genuine paid success
g.recordCompositeSpendFailure(Q);
g.recordCompositeSpendFailure(Q);
ok(!g.compositeGuardBlocked(Q), "a paid success resets the counter (legit buyers never blocked)");

// EVERY composite that fans out to metered upstream must be guarded, or its
// agent path is an unguarded upstream-drain. Locks the class so a new expensive
// product can't ship outside the guard (token-risk spends REAL chain money).
const EXPECTED = [
  "research", "research-pro", "research-max", "dossier", "dossier-max",
  "fund-report", "fund-report-max", "domain-audit", "domain-audit-pro",
  "token-risk", "token-risk-pro",
  "recall-report", "insider-report", "market-brief", "token-brief", "ticker-pack", "filing-report", "linkedin-article",
  "v1-images-fast", "v1-images-pro", "v1-videos",
  "decide-execute",
];
ok(EXPECTED.every((s) => g.EXPENSIVE_COMPOSITE_SLUGS.has(s)), "every expensive composite slug (research/dossier/fund/domain/token-risk/recall/insider/market-brief) is covered");
ok(g.EXPENSIVE_COMPOSITE_SLUGS.size === EXPECTED.length, "the guard set matches the expected composites exactly (no drift)");
ok(!g.EXPENSIVE_COMPOSITE_SLUGS.has("uuid"), "cheap tools are NOT in the guard set");

// Global circuit breaker: rotating keys must not make the total burn unbounded.
g._compositeGuardReset();
ok(!g.compositeGuardGlobalPaused(), "breaker starts closed");
for (let i = 0; i < 5; i++) g.recordCompositeSpendFailure(`0xRotating${i}`);
ok(!g.compositeGuardGlobalPaused(), "5 failures across 5 keys: below the global threshold of 6");
g.recordCompositeSpendFailure(null); // an unkeyed failure still counts globally
ok(g.compositeGuardGlobalPaused(), "the 6th spend-then-fail (any key, even unkeyed) trips the GLOBAL pause");
await new Promise((r) => setTimeout(r, 750));
ok(!g.compositeGuardGlobalPaused(), "the global pause lifts after its window");
// Plan execution keeps the per-buyer bound but cannot pause the report products.
g._compositeGuardReset();
ok(g.OWN_GLOBAL_BOUND_SLUGS.has("decide-execute"), "decide-execute carries its own global bound");
for (let i = 0; i < 20; i++) g.recordCompositeSpendFailure(`0xExec${i}`, { global: false });
ok(!g.compositeGuardGlobalPaused(), "20 decide-execute failures from 20 wallets do NOT trip the global report pause");
for (let i = 0; i < 3; i++) g.recordCompositeSpendFailure("0xExecOne", { global: false });
ok(g.compositeGuardBlocked("0xExecOne"), "...but one wallet failing repeatedly is still blocked per key");
g._compositeGuardReset();

// Usage telemetry accumulates per slug.
g.recordCompositeUsage({ slug: "research", upstreamUsd: 0.25, ok: true, priceUsd: 5 });
g.recordCompositeUsage({ slug: "research", upstreamUsd: 0, ok: false, priceUsd: 5 });
const st = g._compositeGuardState();
ok(st.usage.runs === 2 && st.usage.ok === 1 && st.usage.bySlug.research.upstreamUsd === 0.25, "composite usage telemetry counts runs/outcomes/upstream per slug");

// Long-running composites are advertised on EVM exact ONLY (settle-after-handler
// on SVM/AVM/Tempo fails by construction: blockhash / round / credential expiry).
const { acceptsForItem } = await import("../src/payments.js");
const rails = { evmCaip2: ["eip155:8453"], svmCaip2: ["solana:mainnet"], stellarCaip2: ["stellar:pubnet"], avmCaip2: ["algorand:mainnet"], uptoCaip2: [], walletAddress: "0x" + "1".repeat(40), solanaWallet: "So1", stellarWallet: "GST", algorandWallet: "ALG" };
const slow = acceptsForItem({ slug: "research", price: "$5", longRunning: true }, rails);
const fast = acceptsForItem({ slug: "uuid", price: "$0.001" }, rails);
ok(slow.every((a) => a.network.startsWith("eip155:")) && slow.length === 1, "a longRunning composite advertises EVM exact only");
const onlyBase = acceptsForItem({ slug: "decide-execute", price: "$0.01", longRunning: true, onlyNetworks: ["eip155:8453"] }, { ...rails, evmCaip2: ["eip155:8453", "eip155:137"] });
ok(onlyBase.length === 1 && onlyBase[0].network === "eip155:8453", "a tool naming onlyNetworks is offered on those networks alone");
ok(fast.some((a) => a.network.startsWith("solana:")) && fast.some((a) => a.network.startsWith("algorand:")), "a normal tool still advertises every configured rail");

// A 402 from a FACILITATOR billing refusal COUNTS here. A composite is EVM
// exact only (above), so the Algorand sub-cent refusal the offer gate
// withdraws (src/avm-sponsorship.js) never reaches it, and on an EVM rail
// nothing withdraws a refused offer: the guard's per-payer and global bounds
// are all that stop a billing lapse becoming unbounded served, never-charged
// reports. The predicate itself is pinned too, since the settle breaker words
// its 429 with it.
{
  const { isBillingRefusalReceipt } = await import("../src/payment-reject.js");
  ok(isBillingRefusalReceipt({ success: false, errorReason: "free_tier_exhausted" }), "a free_tier_exhausted receipt is a billing refusal");
  ok(isBillingRefusalReceipt({ success: false, errorReason: "subcent_quota_exceeded" }), "so is subcent_quota_exceeded");
  ok(isBillingRefusalReceipt({ success: false, errorReason: "unexpected_settle_error", errorMessage: "Facilitator settle failed (403): payment required: buy more credits" }), "so is a credits wall named only in the message of a generic reason");
  ok(!isBillingRefusalReceipt({ success: false, errorReason: "insufficient_funds" }), "insufficient_funds is the buyer's");
  ok(!isBillingRefusalReceipt({ success: false, errorReason: "transaction_failed", errorMessage: "rpc quota exceeded" }), "a payment verdict (transaction_failed) is never relabelled by words in its message");
  ok(!isBillingRefusalReceipt({ success: true, errorReason: "free_tier_exhausted" }) && !isBillingRefusalReceipt(null), "a settled or absent receipt is never one");
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const from = server.indexOf("if (compositeGuardBlocked(guardKey))");
  const listener = server.slice(from, server.indexOf("let cacheKey = null;", from));
  ok(/else if \(st === 402 \|\| st >= 500\) recordCompositeSpendFailure\(guardKey, \{ global: !ownGlobalBound \}\);/.test(listener), "the composite finish listener counts every 402 and 5xx, billing refusals included");
  ok(/if \(!ownGlobalBound && compositeGuardGlobalPaused\(\)\)/.test(server), "only slugs without their own global bound honour the global pause");
  ok(!/isBillingRefusalReceipt|isWithdrawnSubcentRefusal/.test(listener), "...with no billing exemption anywhere in it");
}

await new Promise((r) => setTimeout(r, 700));
ok(!g.compositeGuardBlocked(P), "the block lifts after BLOCK_MS (temporary, not permanent)");

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
