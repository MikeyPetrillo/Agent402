// x402-buyer hardening tests (F2 accept-pinning, F3 post-spend read, margin cap).
// Mocks global fetch so no wallet/network is needed. The refusal paths throw
// BEFORE any signing, so they run offline with a throwaway key.
import { randomBytes } from "node:crypto";
import { quoteWithinCap, readAfterSpend } from "../src/x402-buyer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- margin guard edge cases (the F2-adjacent primitive) --------------------
ok(quoteWithinCap("2000", 5000n) === true, "$0.002 <= $0.005 cap");
ok(quoteWithinCap("5000", 5000n) === true, "exact cap ok");
ok(quoteWithinCap("5001", 5000n) === false, "one over cap refused");
ok(quoteWithinCap("499999999", 500000n) === false, "decoy $500 vs $0.50 cap refused");
ok(quoteWithinCap("", 5000n) === false, "empty quote refused (BigInt('') trap closed)");
ok(quoteWithinCap("-1", 5000n) === false, "negative refused");
ok(quoteWithinCap("1.5", 5000n) === false, "decimal refused");
ok(quoteWithinCap("0x10", 5000n) === false, "hex refused");
ok(quoteWithinCap(null, 5000n) === false, "null refused");

// --- F3: readAfterSpend never throws; truncates oversize / wraps non-JSON ----
const mk = (text, throwOnRead = false) => ({ text: async () => { if (throwOnRead) throw new Error("boom"); return text; } });
const j1 = await readAfterSpend(mk(JSON.stringify({ a: 1 })), 1024);
ok(j1 && j1.a === 1 && !j1._truncated, "F3: small JSON returned verbatim");
const bigObj = await readAfterSpend(mk(JSON.stringify({ big: "x".repeat(5000) })), 100);
ok(bigObj && bigObj._truncated === true, "F3: oversize JSON flagged _truncated, no throw");
const nonJson = await readAfterSpend(mk("<html>not json</html>"), 1024);
ok(nonJson && typeof nonJson.raw === "string" && nonJson.raw.includes("not json"), "F3: non-JSON wrapped as {raw}");
const bigNonJson = await readAfterSpend(mk("y".repeat(9000)), 100);
ok(bigNonJson && bigNonJson._truncated === true && bigNonJson.raw.length <= 4000, "F3: oversize non-JSON truncated + flagged");
const unreadable = await readAfterSpend(mk("", true), 1024);
ok(unreadable && unreadable.relayError, "F3: unreadable body → relayError, no throw");

// --- F2: payX402 signs the EXACT/Base/USDC accept, cap-checks THAT one -------
// v1 challenge (getPaymentRequiredResponse returns a body with x402Version:1 as-is).
// Ephemeral throwaway key generated at runtime — never a literal in the repo
// (the refusal paths throw before signing; getUpstreamBuyer just needs a
// valid-format key to construct the account).
process.env.X402_UPSTREAM_BUYER_KEY = "0x" + randomBytes(32).toString("hex");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const origFetch = globalThis.fetch;
const v1entry = (over) => ({ scheme: over.scheme ?? "exact", network: over.network ?? "base", asset: over.asset ?? USDC, maxAmountRequired: over.amt ?? "1000", payTo: "0xabc", resource: "https://seller.example/x", description: "d", maxTimeoutSeconds: 60 });
const challenge = (accepts) => ({ status: 402, headers: { get: () => null }, json: async () => ({ x402Version: 1, accepts }), text: async () => "" });
const { payX402 } = await import("../src/x402-buyer.js");

// decoy: cheap non-exact first, expensive exact/USDC behind → must refuse (cap)
globalThis.fetch = async () => challenge([
  v1entry({ scheme: "upto", amt: "1" }),
  v1entry({ scheme: "exact", amt: "499999999" }),
]);
let t1 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (e) { t1 = e; }
ok(t1 && /exceeds the .* cap/.test(t1.message), "F2: decoy-first challenge with $500 exact entry refused by cap (not signed)");

// no USDC/exact/Base entry at all → refuse
globalThis.fetch = async () => challenge([v1entry({ asset: "0xother" })]);
let t2 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (e) { t2 = e; }
ok(t2 && /no \w+\/exact\/USDC accept/i.test(t2.message), "F2: non-USDC asset accept refused");

// wrong-chain USDC contract (testnet-style asset) → refuse (asset pin = chain safety)
globalThis.fetch = async () => challenge([v1entry({ asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" /* base-sepolia USDC */ })]);
let t3 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (e) { t3 = e; }
ok(t3 && /no \w+\/exact\/USDC accept/i.test(t3.message), "F2: non-mainnet-USDC asset refused (chain pinned by asset)");

// --- payTo binding: pay the address that EARNED the proven-ness ---------------
//
// The reliability gate joins an origin's ADVERTISED payTo to settlements we
// watched arrive, so the evidence is about an ADDRESS. A seller can advertise
// one it does not own, inherit that wallet's history, clear the gate, and then
// ask to be paid somewhere else. resolveExternalSeller checks the PROBE's 402,
// but the spend is a second request the same seller answers, so the check has
// to run again here against the accept actually signed.
{
  const { _spentThisWindow } = await import("../src/x402-buyer.js");
  const PROVEN = "0x1111111111111111111111111111111111111111";
  const OTHER  = "0x2222222222222222222222222222222222222222";
  const payToEntry = (payTo) => ({ ...v1entry({ amt: "1000" }), payTo });

  // MISMATCH: refuse, and refuse BEFORE anything is signed or held.
  globalThis.fetch = async () => challenge([payToEntry(OTHER)]);
  let m = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { m = e; }
  ok(m && /Refusing to pay/.test(m.message) && m.message.includes(OTHER) && m.message.includes(PROVEN),
    "payTo binding: a live 402 naming a different address than the proven one is refused, naming both");
  ok(m && /Nothing was signed/.test(m.message), "payTo binding: the refusal says nothing was signed");
  ok(_spentThisWindow() === 0n, "payTo binding: a refused mismatch holds no spend budget (it throws before reserveSpend)");

  // The refusal must quote the NORMALIZED address, not the seller's raw string.
  // A checksummed (mixed-case) payTo proves which one the message used: raw
  // would echo the seller's bytes back, normalized is lowercase. The raw value
  // is attacker-written and this message is relayed to the buyer, so echoing it
  // is an injection surface the moment provenPayToMatches widens its address
  // regex for a non-EVM rail.
  globalThis.fetch = async () => challenge([payToEntry("0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd")]);
  let raw = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { raw = e; }
  ok(raw && raw.message.includes("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"),
    "payTo binding: the refusal quotes the NORMALIZED address from the verdict");
  ok(raw && !raw.message.includes("0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd"),
    "payTo binding: the refusal never echoes the seller's raw payTo string back (injection surface)");

  // MATCH (case-insensitive, EVM): must NOT be refused for payTo reasons.
  globalThis.fetch = async () => challenge([payToEntry(PROVEN.toUpperCase().replace("0X", "0x"))]);
  let ma = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { ma = e; }
  ok(!(ma && /Refusing to pay/.test(ma.message)),
    "payTo binding: the same address in different case is a MATCH, never a refusal (EVM is case-insensitive)");

  // UNKNOWN 1: no proven address on record - an honest seller proven by a
  // source that cannot name an address must not be blocked.
  globalThis.fetch = async () => challenge([payToEntry(OTHER)]);
  let u1 = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }); } catch (e) { u1 = e; }
  ok(!(u1 && /Refusing to pay/.test(u1.message)), "payTo binding: no proven address on record does not block");

  // UNKNOWN 2: an unreadable payTo in the live 402 is unknown, not a match and
  // not a refusal.
  globalThis.fetch = async () => challenge([payToEntry("not-an-address")]);
  let u2 = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { u2 = e; }
  ok(!(u2 && /Refusing to pay/.test(u2.message)), "payTo binding: an unreadable live payTo is UNKNOWN, never a refusal");

  // The check must read the accept we SIGN, not accepts[0]: a decoy first entry
  // paying the proven address cannot launder an exact entry paying elsewhere.
  globalThis.fetch = async () => challenge([
    { ...v1entry({ scheme: "upto", amt: "1" }), payTo: PROVEN },
    payToEntry(OTHER),
  ]);
  let d = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { d = e; }
  ok(d && /Refusing to pay/.test(d.message) && d.message.includes(OTHER),
    "payTo binding: a decoy accepts[0] paying the proven address does not launder the exact entry we sign");
  ok(_spentThisWindow() === 0n, "payTo binding: no budget held by any refused attempt");
}

// --- NEW-1: reserveSpend holds budget, releaseSpend refunds unspent holds -----
{
  const { reserveSpend, releaseSpend, _spentThisWindow } = await import("../src/x402-buyer.js");
  const t = reserveSpend("400000"); // $0.40 held
  ok(_spentThisWindow() === 400000n, "budget: reserve holds $0.40");
  releaseSpend("400000", t);         // paid leg failed pre-response → refund
  ok(_spentThisWindow() === 0n, "budget: release refunds the full hold");
  // over-cap is refused (default $2/min cap = 2000000)
  const held = reserveSpend("2000000");
  let over = null; try { reserveSpend("1"); } catch (e) { over = e; }
  ok(over && over.statusCode === 429, "budget: reserve past the window cap throws 429");
  releaseSpend("2000000", held);
  ok(_spentThisWindow() === 0n, "budget: post-test window drained");
  // stale token (wrong window) is a no-op, never drives the counter negative
  releaseSpend("999", "0"); ok(_spentThisWindow() === 0n, "budget: stale-token release is a no-op");
}

// --- Base chain-truth refusal (2026-09-02) -----------------------------------
// A seller's 402/4xx on the paid retry is their word. On Base the exact truth
// is whether the EIP-3009 nonce we signed was consumed on the token
// (authorizationState). Unused after the grace = provably unpaid: the hold is
// released, the error is uncommitted + flagged refused, the seller memoized
// per chain, and route-execute tries the next candidate. Used, or unreadable,
// keeps the post-commit stance.
{
  const { payX402, sellerRefusedRecently, __resetSellerRefusalsForTest, _spentThisWindow } = await import("../src/x402-buyer.js");
  const { authorizationStateCalldata, confirmEvmAuthorizationUnused } = await import("../src/evm-authorization-state.js");
  const { toFunctionSelector } = await import("viem");
  ok(authorizationStateCalldata("0x" + "ab".repeat(20), "0x" + "cd".repeat(32)).startsWith(toFunctionSelector("authorizationState(address,bytes32)")), "the calldata selector is authorizationState(address,bytes32) (viem agrees)");
  ok(authorizationStateCalldata("0x" + "ab".repeat(20), "0x" + "cd".repeat(32)).length === 2 + 8 + 64 + 64, "calldata = selector + padded address + 32-byte nonce");
  let threw = false; try { authorizationStateCalldata("0xshort", "0x" + "cd".repeat(32)); } catch { threw = true; }
  ok(threw, "a malformed authorizer is refused before any RPC call");
  const rpc = (result) => async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  const args = { token: USDC, authorizer: "0x" + "ab".repeat(20), nonce: "0x" + "cd".repeat(32), chain: "base", graceMs: 0, pollMs: 0 };
  const used = await confirmEvmAuthorizationUnused({ ...args, fetchImpl: rpc("0x" + "0".repeat(63) + "1") });
  ok(used.debited === true, "authorizationState true -> debited (the authorization was consumed)");
  const unused = await confirmEvmAuthorizationUnused({ ...args, fetchImpl: rpc("0x" + "0".repeat(64)) });
  ok(unused.debited === false && unused.observed >= 1, "authorizationState false after the grace -> not debited");
  let bad = null; try { await confirmEvmAuthorizationUnused({ ...args, fetchImpl: rpc("0x") }); } catch (e) { bad = e; }
  ok(bad && /unreadable/.test(bad.message), "an unreadable result THROWS (fail closed), never reads as not charged");
  let rpcErr = null; try { await confirmEvmAuthorizationUnused({ ...args, fetchImpl: async () => { throw new Error("ECONNRESET"); } }); } catch (e) { rpcErr = e; }
  ok(rpcErr, "an RPC failure throws too");
  // Polls until the grace expires: two reads of false, then a true on the third read within the grace.
  let n = 0; const flip = async () => ({ json: async () => ({ result: ++n >= 3 ? "0x" + "0".repeat(63) + "1" : "0x" + "0".repeat(64) }) });
  let clock = 0; const late = await confirmEvmAuthorizationUnused({ ...args, graceMs: 10_000, pollMs: 0, fetchImpl: flip, now: () => (clock += 1000) });
  ok(late.debited === true && late.observed === 3, "a settlement that lands during the grace is seen (polled, not read once)");

  // Through payX402 on Base: v2 challenge, paid retry refused with 402.
  __resetSellerRefusalsForTest();
  let asked = null; let paidAttempts = 0;
  const v2accept = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: "0x" + "ee".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const v2hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [v2accept] })).toString("base64");
  globalThis.fetch = async (url, init) => {
    const paid = init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["payment-signature"] || init?.headers?.["X-PAYMENT"];
    if (!paid) return { status: 402, headers: { get: (h) => (h.toLowerCase() === "payment-required" ? v2hdr : null) }, json: async () => ({}), text: async () => "{}" };
    paidAttempts++;
    return { status: 402, headers: { get: () => "application/json" }, json: async () => ({ error: "payment_verification_failed" }), text: async () => JSON.stringify({ error: "payment_verification_failed" }) };
  };
  const buy = (notDebited) => payX402("https://refuser.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", notDebited }).then(() => null, (e) => e);
  const held0 = _spentThisWindow();
  const r1 = await buy(async (q) => { asked = q; return { debited: false, observed: 1 }; });
  ok(r1 && r1.statusCode === 502 && r1.committed === false && r1.refused === true, "Base: refused + nonce unused -> uncommitted, flagged refused (route-execute tries the next seller)");
  ok(_spentThisWindow() === held0, "Base: and the spend hold was released");
  ok(asked && asked.token === USDC && /^0x[0-9a-f]{40}$/i.test(asked.authorizer) && /^0x[0-9a-f]{64}$/i.test(asked.nonce) && asked.chain === "base", "the chain check is asked about the token, OUR authorizer and the nonce we signed");
  ok(sellerRefusedRecently("https://refuser.example", "base")?.status === 402 && !sellerRefusedRecently("https://refuser.example", "solana"), "the refusing seller is memoized on base only");
  __resetSellerRefusalsForTest();
  const held1 = _spentThisWindow();
  const r2 = await buy(async () => ({ debited: true, observed: 1 }));
  ok(r2 && r2.committed === true && !r2.refused && _spentThisWindow() === held1 + 1000n, "Base: nonce consumed -> post-commit stance kept, hold stands");
  const r3 = await buy(async () => { throw new Error("RPC 429"); });
  ok(r3 && r3.committed === true && !sellerRefusedRecently("https://refuser.example", "base"), "Base: unreadable chain -> post-commit stance kept, nothing memoized");
  ok(paidAttempts === 3, "one paid attempt per buy (a refusal that does not name X-PAYMENT gets no resend)");
}

globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
