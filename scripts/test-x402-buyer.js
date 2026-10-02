// x402-buyer hardening tests (F2 accept-pinning, F3 post-spend read, margin cap).
// Mocks global fetch so no wallet/network is needed. The refusal paths throw
// BEFORE any signing, so they run offline with a throwaway key.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Two cases below settle against a stub seller, and a settled payment writes a
// per-payment ledger line. Point it at a scratch directory before the buyer
// module (and the ledger it imports) is loaded, so a test run never writes to
// the volume path.
process.env.OUTBOUND_LEDGER_FILE = join(mkdtempSync(join(tmpdir(), "x402-buyer-test-")), "outbound-spend.ndjson");
const { quoteWithinCap, readAfterSpend } = await import("../src/x402-buyer.js");

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
const challenge = (accepts) => ({ status: 402, headers: { get: () => null }, json: async () => ({ x402Version: 1, accepts }), text: async () => JSON.stringify({ x402Version: 1, accepts }) });
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

  // signBy: a payment the buyer could no longer settle is never signed. The
  // bound is re-checked after the bare 402 read, just before signing.
  {
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return challenge([payToEntry(PROVEN)]); };
    let late = null;
    try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, signBy: Date.now() - 1 }); } catch (e) { late = e; }
    ok(late && late.statusCode === 504 && /Nothing was signed/.test(late.message) && fetches === 1, `signBy: past its sign-by moment the payer refuses 504 after the bare 402 and sends no paid request (fetches ${fetches}, ${late?.statusCode})`);
    ok(_spentThisWindow() === 0n, "signBy: a refused late signature holds no spend budget");
    fetches = 0;
    let slow = null;
    globalThis.fetch = async () => { fetches++; await new Promise((r) => setTimeout(r, 60)); return challenge([payToEntry(PROVEN)]); };
    try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, signBy: Date.now() + 20 }); } catch (e) { slow = e; }
    ok(slow && slow.statusCode === 504 && fetches === 1, `signBy: a seller whose bare 402 takes past the sign-by moment is not paid (fetches ${fetches}, ${slow?.statusCode})`);
  }

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

  // WRONG EIP-712 DOMAIN NAME (2026-09-10): a v2 Base accept naming "USDC"
  // (the token signs under "USD Coin") is refused BEFORE signing, marked
  // `refused` so route-execute tries the next candidate, and memoized.
  {
    const { sellerRefusedRecently } = await import("../src/x402-buyer.js");
    const v2 = (name) => ({ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: PROVEN, maxTimeoutSeconds: 60, extra: { name, version: "2" } });
    const v2challenge = (accepts) => ({ status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") : null) }, json: async () => ({}), text: async () => "" });
    globalThis.fetch = async () => v2challenge([v2("USDC")]);
    let wd = null;
    try { await payX402("https://wrongdomain.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", memoizeDelivery: true }); } catch (e) { wd = e; }
    ok(wd && /EIP-712 name "USDC"/.test(wd.message) && /"USD Coin"/.test(wd.message) && /Nothing was signed/.test(wd.message), "wrong domain: a Base accept naming \"USDC\" is refused before signing, naming both names");
    ok(wd && wd.refused === true && wd.statusCode === 502, "wrong domain: the error is marked refused (route-execute falls through) with a 502");
    ok(_spentThisWindow() === 0n, "wrong domain: no budget held");
    ok(!sellerRefusedRecently("https://wrongdomain.example", "base"), "wrong domain: one meeting is recorded and benches nothing yet");
    try { await payX402("https://wrongdomain.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", memoizeDelivery: true }); } catch { /* refused again */ }
    ok(!!sellerRefusedRecently("https://wrongdomain.example", "base"), "wrong domain: the second meeting benches that route on base for the TTL");
    // Control: the same accept naming "USD Coin" passes the domain check. It
    // is then refused by the payTo binding one line further down (the proven
    // address differs), which proves the domain check threw nothing AND keeps
    // this offline test from signing against the stub.
    globalThis.fetch = async () => v2challenge([{ ...v2("USD Coin"), payTo: OTHER }]);
    let rd = null;
    try { await payX402("https://rightdomain.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", provenPayTo: PROVEN }); } catch (e) { rd = e; }
    ok(rd && /Refusing to pay/.test(rd.message) && !/EIP-712 name/.test(rd.message) && !sellerRefusedRecently("https://rightdomain.example", "base"), "right domain: \"USD Coin\" passes the domain check (the later payTo binding is what refuses) and is not memoized");
  }

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
  ok(unused.expired === null, "a legacy read with no expiry attached reports expired:null (never final)");

  // --- refuse-then-settle-late (2026-09-03): the wait runs to the credential's
  // own expiry, and only an expiry the clock actually reached makes "unused"
  // final. Fake clock: 1 s per read, expiry at t=10 s.
  {
    const neverUsed = async () => ({ json: async () => ({ result: "0x" + "0".repeat(64) }) });
    let t = 0; const clock = () => (t += 1000);
    const reached = await confirmEvmAuthorizationUnused({ ...args, untilUnix: 10, maxWaitMs: 60_000, pollMs: 0, fetchImpl: neverUsed, now: clock });
    ok(reached.debited === false && reached.expired === true && reached.observed >= 9, "unused through the credential's expiry -> expired:true (provably unpaid)");
    t = 0;
    const cut = await confirmEvmAuthorizationUnused({ ...args, untilUnix: 10, maxWaitMs: 3_000, pollMs: 0, fetchImpl: neverUsed, now: clock });
    ok(cut.debited === false && cut.expired === false && cut.observed <= 4, "a wait cut short by the caller's bound reports expired:false (the credential is still live)");
    t = 0; let reads = 0;
    const lateSettle = async () => ({ json: async () => ({ result: ++reads >= 4 ? "0x" + "0".repeat(63) + "1" : "0x" + "0".repeat(64) }) });
    const consumed = await confirmEvmAuthorizationUnused({ ...args, untilUnix: 10, maxWaitMs: 60_000, pollMs: 0, fetchImpl: lateSettle, now: clock });
    ok(consumed.debited === true && consumed.observed === 4, "a settle that lands INSIDE the window (after the old 8 s grace would have given up) is seen as a debit");
  }

  // Through payX402 on Base: v2 challenge, paid retry refused with 402. The
  // seller's accept says maxTimeoutSeconds 300; the authorization we SIGN must
  // still expire at now + the refusal window, and the accept we ECHO must keep
  // the seller's 300 (the facilitator deep-equals it against the requirements).
  __resetSellerRefusalsForTest();
  let asked = null; let paidAttempts = 0; let sentPayload = null;
  const v2accept = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: "0x" + "ee".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const v2hdr = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [v2accept] })).toString("base64");
  globalThis.fetch = async (url, init) => {
    const paid = init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["payment-signature"] || init?.headers?.["X-PAYMENT"];
    if (!paid) return { status: 402, headers: { get: (h) => (h.toLowerCase() === "payment-required" ? v2hdr : null) }, json: async () => ({}), text: async () => "{}" };
    paidAttempts++;
    try { sentPayload = JSON.parse(Buffer.from(paid, "base64").toString("utf8")); } catch { sentPayload = null; }
    // The seller's payment layer refusing: it answers with its offer again.
    return { status: 402, headers: { get: (h) => (h.toLowerCase() === "payment-required" ? v2hdr : "application/json") }, json: async () => ({ error: "payment_verification_failed" }), text: async () => JSON.stringify({ error: "payment_verification_failed" }) };
  };
  const buy = (notDebited, extra = {}) => payX402("https://refuser.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", memoizeDelivery: true, notDebited, ...extra }).then(() => null, (e) => e);
  const held0 = _spentThisWindow();
  const t0 = Math.floor(Date.now() / 1000);
  const r1 = await buy(async (q) => { asked = q; return { debited: false, observed: 1, expired: true }; }, { refusalMaxWaitMs: 12345 });
  const t1 = Math.floor(Date.now() / 1000);
  ok(r1 && r1.statusCode === 502 && r1.committed === false && r1.refused === true, "Base: refused + nonce unused AFTER expiry -> uncommitted, flagged refused (route-execute tries the next seller)");
  ok(_spentThisWindow() === held0, "Base: and the spend hold was released");
  ok(asked && asked.token === USDC && /^0x[0-9a-f]{40}$/i.test(asked.authorizer) && /^0x[0-9a-f]{64}$/i.test(asked.nonce) && asked.chain === "base", "the chain check is asked about the token, OUR authorizer and the nonce we signed");
  const vb = Number(sentPayload?.payload?.authorization?.validBefore);
  ok(Number.isFinite(vb) && vb <= t1 + 30 && vb >= t0 + 25, `the SIGNED validBefore is now + the 30 s refusal window (got +${vb - t0}s) even though the accept said maxTimeoutSeconds 300`);
  ok(sentPayload?.accepted?.maxTimeoutSeconds === 300, "the ECHOED accept keeps the seller's own maxTimeoutSeconds (the facilitator's requirements match)");
  ok(asked.untilUnix === vb + 5 && asked.maxWaitMs === 12345, "the chain check is told to wait until the signed validBefore (+ slack), bounded by the caller's refusalMaxWaitMs");
  ok(!sellerRefusedRecently("https://refuser.example", "base"), "one refusal is recorded and benches nothing yet");
  await buy(async () => ({ debited: false, observed: 1, expired: true }));
  ok(sellerRefusedRecently("https://refuser.example", "base")?.status === 402 && !sellerRefusedRecently("https://refuser.example", "solana"), "the second benches the refusing route on base only");
  __resetSellerRefusalsForTest();
  const heldLive = _spentThisWindow();
  const rLive = await buy(async () => ({ debited: false, observed: 1, expired: false }));
  ok(rLive && rLive.committed === true && !rLive.refused && /rejected the paid retry/i.test(rLive.message) && _spentThisWindow() === heldLive + 1000n, "Base: unused but the credential is STILL LIVE (bound cut the wait) -> hold stands, no fallthrough");
  ok(!sellerRefusedRecently("https://refuser.example", "base"), "a still-live refusal is not memoized as a refusal");
  const rNoExpiry = await buy(async () => ({ debited: false, observed: 1 }));
  ok(rNoExpiry && rNoExpiry.committed === true && !rNoExpiry.refused, "Base: a checker that attaches no expiry never releases the hold (the old 8 s grace shape is no longer proof)");
  const held1 = _spentThisWindow();
  const r2 = await buy(async () => ({ debited: true, observed: 1 }));
  ok(r2 && r2.committed === true && !r2.refused && _spentThisWindow() === held1 + 1000n, "Base: nonce consumed -> post-commit stance kept, hold stands");
  const r3 = await buy(async () => { throw new Error("RPC 429"); });
  ok(r3 && r3.committed === true && !sellerRefusedRecently("https://refuser.example", "base"), "Base: unreadable chain -> post-commit stance kept, nothing memoized");
  ok(paidAttempts === 6, "one paid attempt per buy (a refusal that does not name X-PAYMENT gets no resend)");
  // The pure cap: never above the window, never rewrites a shorter seller value upward.
  const { capEvmValidity } = await import("../src/x402-buyer.js");
  ok(capEvmValidity({ maxTimeoutSeconds: 300 }, 30).maxTimeoutSeconds === 30 && capEvmValidity({ maxTimeoutSeconds: 10 }, 30).maxTimeoutSeconds === 10 && capEvmValidity({}, 30).maxTimeoutSeconds === 30, "capEvmValidity: min(seller, window), and a missing seller value takes the window");
}

// --- the payment we SIGN re-checks the evidence wallets (2026-09-28) ----------
//
// The resolver binds INHERITED settlement history to the wallets it came from,
// and checks that the PROBE's 402 pays one of them. payX402 then makes its own
// unpaid request and signs whatever that 402 names, and the seller answers
// both - so a seller could show the bound wallet to the probe and another
// address to the payment. `evidenceWallets` carries the binding to the accept
// actually signed. The signer is spied on the live client instance, so "signed
// zero times" is measured at the signing call itself, not inferred from a
// header.
{
  const { payX402, getUpstreamBuyer, getUpstreamBuyerAvm, _spentThisWindow } = await import("../src/x402-buyer.js");
  // Letters in the address on purpose: an all-digit wallet has no case, and
  // the case-insensitive compare is one of the things under test.
  const W1 = "0x" + "1a".repeat(20);
  const X = "0x" + "9".repeat(40);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const accept = (payTo) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
  let paidRequests = 0;
  const seller = (payTo) => async (_url, init) => {
    const h = init?.headers || {};
    if (!(h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"])) {
      return { status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? b64({ x402Version: 2, accepts: [accept(payTo)] }) : null) }, json: async () => ({}), text: async () => "{}" };
    }
    paidRequests++;
    return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "payment-response": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453" }) } });
  };
  const evm = await getUpstreamBuyer();
  const realSign = evm.client.createPaymentPayload.bind(evm.client);
  let signs = 0;
  evm.client.createPaymentPayload = async (...a) => { signs++; return realSign(...a); };
  const pay = (payTo, evidenceWallets, extra = {}) => {
    globalThis.fetch = seller(payTo);
    return payX402("https://tenant.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "base", evidenceWallets, ...extra }).then((r) => ({ r }), (e) => ({ e }));
  };

  // A1 CONTROL, first: the 402 names the bound wallet -> it signs once and
  // settles. Without this the refusals below could be a signer that never
  // works at all.
  signs = 0; paidRequests = 0;
  const a1 = await pay(W1, [W1]);
  ok(!a1.e && a1.r?.result?.answer === 42 && a1.r?.receipt?.transaction && signs === 1 && paidRequests === 1,
    `A1 control: the pay 402 names the evidence wallet -> signed once and settled (signs ${signs}, paid requests ${paidRequests}${a1.e ? `, threw ${a1.e.message}` : ""})`);

  // A2: the pay 402 names another address -> refused before anything is signed.
  signs = 0; paidRequests = 0;
  const held2 = _spentThisWindow();
  const a2 = await pay(X, [W1]);
  ok(a2.e && a2.e.statusCode === 502 && /Nothing was signed/.test(a2.e.message) && a2.e.message.includes(X),
    "A2: a pay 402 naming a wallet outside the evidence wallets is refused 502, naming the normalized address, and says nothing was signed");
  ok(signs === 0 && paidRequests === 0 && _spentThisWindow() === held2, "A2: the signer was called 0 times and no budget was held");
  ok(/belongs to a different wallet/.test(a2.e?.message || ""), "A2: the refusal says the history belongs to a different wallet");

  // A3: an unreadable payTo refuses (unlike provenPayTo, where it is unknown),
  // and no part of the seller's raw string reaches the message.
  const long = "Q9".repeat(150);
  for (const junk of ["not-an-address", long]) {
    signs = 0;
    const a3 = await pay(junk, [W1]);
    const m = a3.e?.message || "";
    ok(a3.e && /Refusing to pay an unreadable address/.test(m) && signs === 0,
      `A3: an unreadable pay 402 payTo (${junk.length} chars) is refused as "an unreadable address", nothing signed`);
    ok(!m.includes("not-an-address") && !m.includes("Q9Q9") && !m.includes(junk.slice(-12)), "A3: the refusal never echoes any part of the seller's raw payTo string");
  }

  // A4: case never decides - an upper-case 402 payTo against a lower-case list signs.
  signs = 0;
  const a4 = await pay(W1.toUpperCase().replace("0X", "0x"), [W1.toLowerCase()]);
  ok(!a4.e && signs === 1, `A4: the same wallet in upper case against a lower-case evidence list is a match and signs${a4.e ? ` (threw ${a4.e.message})` : ""}`);

  // A5: no binding (null, or an empty list) is today's behaviour: pays X.
  signs = 0;
  const a5null = await pay(X, null);
  const a5empty = await pay(X, []);
  ok(!a5null.e && !a5empty.e && signs === 2, "A5: evidenceWallets null or [] checks nothing and pays as before");

  // A6: Base only. On Algorand the accept's payTo is not an EVM address and the
  // Base binding must not refuse it. The AVM signer is replaced by a sentinel,
  // so reaching it proves the check was not applied and nothing touches algod.
  {
    const algosdk = (await import("algosdk")).default;
    process.env.ALGORAND_UPSTREAM_BUYER_MNEMONIC = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    const avm = await getUpstreamBuyerAvm();
    let avmSigns = 0;
    avm.client.createPaymentPayload = async () => { avmSigns++; throw new Error("SENTINEL: reached the AVM signer"); };
    const algoPayTo = algosdk.generateAccount().addr.toString();
    globalThis.fetch = async () => ({ status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? b64({ x402Version: 2, accepts: [{ scheme: "exact", network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", asset: "31566704", amount: "1000", payTo: algoPayTo, maxTimeoutSeconds: 60 }] }) : null) }, json: async () => ({}), text: async () => "{}" });
    let a6 = null;
    try { await payX402("https://tenant.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, chain: "algorand", evidenceWallets: [W1] }); } catch (e) { a6 = e; }
    ok(a6 && /SENTINEL/.test(a6.message) && avmSigns === 1, `A6: on Algorand the Base-only check is not applied (reached the AVM signer${a6 && !/SENTINEL/.test(a6.message) ? `; threw ${a6.message}` : ""})`);
  }

  evm.client.createPaymentPayload = realSign;
}

// A7: the call sites, pinned from source. The payer check above is inert unless
// the resolver SETS the list and route-execute FORWARDS it (a behavioural twin
// of the second pin lives in test-route-execute.js).
{
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("async function resolveExternalSeller("), server.indexOf("async function diagnoseExternalSeller("));
  ok(/evidenceWallets = gate\.evidenceWallets;/.test(fn) && fn.indexOf("evidenceWallets = gate.evidenceWallets;") > fn.indexOf("const gate = baseLiveGate({"),
    "A7: resolveExternalSeller's Base branch sets evidenceWallets from the passed binding gate (the wallets whose own evidence clears)");
  ok(/resolved\.push\(\{[^\n]*\bevidenceWallets,/.test(fn), "A7: the resolved candidate carries evidenceWallets");
  const re = readFileSync(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
  ok(/payExternal\(extUrl, \{[^\n]*evidenceWallets: ext\.evidenceWallets/.test(re), "A7: route-execute passes evidenceWallets: ext.evidenceWallets to payExternal");
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const payFn = buyer.slice(buyer.indexOf("export async function payX402("));
  const at = payFn.indexOf("evidenceWallets.length");
  ok(at > payFn.indexOf("quoteWithinCap(quotedAtomic, maxAtomic)") && at < payFn.indexOf("screenAddressForPayment") && at < payFn.indexOf("reserveSpend(quotedAtomic)"),
    "A7: the check sits after the cap check and before the sanctions screen and any budget hold");
}

// --- Base unproven tier: the ceiling holds on the quote being SIGNED ---------
// The resolver admits a Base seller below the settlement floor only when its
// listed price is within SOR_BASE_UNPROVEN_MAX_USD. The seller answers the
// payment's own 402 separately, so the ceiling is re-checked there.
{
  const { _spentThisWindow } = await import("../src/x402-buyer.js");
  const before = process.env.SOR_BASE_UNPROVEN_MAX_USD;
  const PAYTO = "0x3333333333333333333333333333333333333333";
  const entry = (amt) => ({ ...v1entry({ amt }), payTo: PAYTO });
  const refusal = async (amt, opts = {}) => {
    globalThis.fetch = async () => challenge([entry(amt)]);
    try { await payX402("https://seller.example/x", { maxAtomic: 500000n, trusted: true, method: "POST", body: {}, allowUnproven: true, ...opts }); return null; } catch (e) { return e; }
  };
  delete process.env.SOR_BASE_UNPROVEN_MAX_USD;
  const spentBefore = _spentThisWindow();
  const high = await refusal("20000");
  ok(high && high.statusCode === 409 && /above the unproven ceiling 10000/.test(high.message), "unproven Base: a signed quote above the $0.01 default ceiling is refused 409");
  ok(_spentThisWindow() === spentBefore, "unproven Base: the refusal holds no spend budget (before reserveSpend)");
  process.env.SOR_BASE_UNPROVEN_MAX_USD = "off";
  const off = await refusal("1000");
  ok(off && off.statusCode === 409, "unproven Base: with the tier switched off even a $0.001 quote is refused");
  process.env.SOR_BASE_UNPROVEN_MAX_USD = "not-a-number";
  const junk = await refusal("20000");
  ok(junk && junk.statusCode === 409 && /ceiling 10000/.test(junk.message), "unproven Base: a malformed env reads as the default ceiling, never a wider one");
  if (before === undefined) delete process.env.SOR_BASE_UNPROVEN_MAX_USD; else process.env.SOR_BASE_UNPROVEN_MAX_USD = before;
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const payFn = src.slice(src.indexOf("export async function payX402"));
  const at = payFn.indexOf('chain === "base" && allowUnproven');
  ok(at > payFn.indexOf("quoteWithinCap(quotedAtomic, maxAtomic)") && at < payFn.indexOf("reserveSpend(quotedAtomic)"), "unproven Base: the ceiling check sits after the cap check and before any budget hold or signature");
}

globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
