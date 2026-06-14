// x402-kit tests. Strict on deterministic logic (transfer-authorization typed
// data + input validation); live RPC reads are tolerant of upstream flake.
// Fails only on a real assertion break or if EVERY live RPC call fails.
import { X402_TOOLS } from "../src/tools/x402-kit.js";

const h = (slug) => X402_TOOLS.find((t) => t.slug === slug).handler;
let assertFail = 0, liveOk = 0, liveErr = 0;
const ok = (c, m) => { if (c) console.log(`ok - ${m}`); else { assertFail++; console.error(`ASSERT FAIL - ${m}`); } };

// --- transfer-authorization: pure CPU, fully deterministic ---
const ta = h("transfer-authorization")({ from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", amount: 0.01 });
ok(ta.typedData.domain.chainId === 8453, "transfer-auth chainId 8453");
ok(ta.typedData.message.value === "10000", "transfer-auth 0.01 USDC -> 10000 atomic");
ok(/^0x[0-9a-f]{64}$/.test(ta.typedData.message.nonce), "transfer-auth 32-byte nonce");
ok(ta.typedData.primaryType === "TransferWithAuthorization", "transfer-auth primaryType");

// --- validation (deterministic) ---
for (const [slug, args, label] of [
  ["usdc-balance", { address: "nope" }, "usdc-balance rejects bad address"],
  ["tx-status", { hash: "0x123" }, "tx-status rejects bad hash"],
  ["x402-verify", { hash: "deadbeef" }, "x402-verify rejects bad hash"],
  ["transfer-authorization", { from: "bad", to: "0x2222222222222222222222222222222222222222", amount: 1 }, "transfer-auth rejects bad from"],
  ["x402-quote", { url: "https://example.com", method: "DELETE" }, "x402-quote rejects bad method"],
]) {
  try { await h(slug)(args); ok(false, label); }
  catch (e) { ok(e.statusCode === 400, label + ` (got ${e.statusCode})`); }
}

// --- live RPC reads (tolerant of upstream flake) ---
async function live(slug, args, check, label) {
  try {
    const r = await h(slug)(args);
    if (check(r)) { liveOk++; console.log(`ok - ${label}: ${JSON.stringify(r).slice(0, 140)}`); }
    else { assertFail++; console.error(`ASSERT FAIL - ${label}: ${JSON.stringify(r).slice(0, 200)}`); }
  } catch (e) { liveErr++; console.warn(`warn - ${label}: upstream (${e.statusCode || "?"}) ${e.message} — tolerated`); }
}
await live("usdc-balance", { address: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0" }, (r) => typeof r.usdc === "string" && r.token === "USDC", "usdc-balance revenue wallet");
await live("gas-estimate", {}, (r) => typeof r.gasPriceWei === "string" && r.network === "base", "gas-estimate base");
await live("tx-status", { hash: "0x" + "0".repeat(64) }, (r) => r.status === "not_found", "tx-status zero hash -> not_found");
await live("x402-verify", { hash: "0x" + "0".repeat(64) }, (r) => r.settled === false, "x402-verify zero hash -> not settled");
await live("x402-quote", { url: "https://agent402.tools/api/hash", method: "POST" }, (r) => r.status === 402 && r.paymentRequired === true, "x402-quote our own 402");

console.log(`\nasserts failed: ${assertFail} | live ok: ${liveOk} | live upstream-errors (tolerated): ${liveErr}`);
if (assertFail > 0 || liveOk === 0) { console.error("x402-kit: FAILED"); process.exit(1); }
console.log("x402-kit: OK");
