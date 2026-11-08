// x402-buyer hardening tests (F2 accept-pinning, F3 post-spend read, margin cap).
// Mocks global fetch so no wallet/network is needed. The refusal paths throw
// BEFORE any signing, so they run offline with a throwaway key.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Two cases below settle against a stub seller, and a settled payment writes a
// per-payment ledger line. Point it at a scratch directory before the buyer
// module (and the ledger it imports) is loaded, so a test run never writes to
// the volume path.
process.env.OUTBOUND_LEDGER_FILE = join(mkdtempSync(join(tmpdir(), "x402-buyer-test-")), "outbound-spend.ndjson");
// The payout screen refuses every payment while no sanctions list is held;
// this suite drives the payer, so it holds a fixture list.
(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const { quoteWithinCap, readAfterSpend } = await import("../src/x402-buyer.js");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

// --- No call option skips the address guard ---------------------------------
// The buyers once took {trusted:true}, which skipped assertPublicUrl and the
// pinned dispatcher. Passing it now changes nothing: a seller on this host is
// refused before any byte reaches it, on the x402 leg, the Tempo leg and the
// model-list read. Runs before this suite turns the guard off for its stubs.
{
  const http = await import("node:http");
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(402, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${srv.address().port}`;
  const buyer = await import("../src/x402-buyer.js");
  const { payTempo } = await import("../src/tempo-buyer.js");
  ok(buyer.buyerAddressGuardOn() === true, "the buyer address guard is on by default");
  const x = await buyer.payX402(`${local}/x`, { maxAtomic: 500000n, trusted: true, method: "POST", body: {} }).then(() => null, (e) => e);
  ok(x && x.statusCode === 400, `payX402 with trusted:true still refuses a seller on this host (${x?.statusCode} ${x?.message})`);
  const t = await payTempo(`${local}/x`, { maxAtomic: 5000n, trusted: true, method: "POST", body: {}, createCredential: async () => "Payment x", proof: async () => ({ count: 4000, payers: 50 }) }).then(() => null, (e) => e);
  ok(t && t.statusCode === 400, `payTempo with trusted:true still refuses a seller on this host (${t?.statusCode} ${t?.message})`);
  buyer.__resetModelListsForTest?.();
  const v = await buyer.sellerServesModel(`${local}/v1/chat/completions`, "gpt-x", { trusted: true });
  ok(v.verdict === "unknown", `sellerServesModel with trusted:true reads no list from this host (${v.verdict})`);
  ok(hits === 0, `the local seller was never reached (${hits} hits)`);
  srv.close();
  const { readFileSync } = await import("node:fs");
  const sig = (src, name) => { const at = src.indexOf(`export async function ${name}(`); return src.slice(at, src.indexOf(") {", src.indexOf("} = {}", at)) + 3); };
  const xsrc = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const tsrc = readFileSync(new URL("../src/tempo-buyer.js", import.meta.url), "utf8");
  ok(!/\btrusted\b/.test(sig(xsrc, "payX402")) && !/\btrusted\b/.test(sig(xsrc, "sellerServesModel")) && !/\btrusted\b/.test(sig(tsrc, "payTempo")), "no buyer entry point takes a trusted option");
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let threw = false;
  try { buyer.__setBuyerAddressGuardForTest(false); } catch { threw = true; }
  if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  ok(threw && buyer.buyerAddressGuardOn() === true, "the test switch refuses to turn the guard off under NODE_ENV=production");
  buyer.__setBuyerAddressGuardForTest(false); // the rest of this suite's sellers are stubbed fetches
}

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
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {} }); } catch (e) { t1 = e; }
ok(t1 && /exceeds the .* cap/.test(t1.message), "F2: decoy-first challenge with $500 exact entry refused by cap (not signed)");

// no USDC/exact/Base entry at all → refuse
globalThis.fetch = async () => challenge([v1entry({ asset: "0xother" })]);
let t2 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {} }); } catch (e) { t2 = e; }
ok(t2 && /no \w+\/exact\/USDC accept/i.test(t2.message), "F2: non-USDC asset accept refused");

// wrong-chain USDC contract (testnet-style asset) → refuse (asset pin = chain safety)
globalThis.fetch = async () => challenge([v1entry({ asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" /* base-sepolia USDC */ })]);
let t3 = null;
try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {} }); } catch (e) { t3 = e; }
ok(t3 && /no \w+\/exact\/USDC accept/i.test(t3.message), "F2: non-mainnet-USDC asset refused (chain pinned by asset)");

// --- our own wallets are never paid ----------------------------------------
// A listing that fronts this host carries our own payTo; the buyer refuses it
// before anything is signed or held, whatever the index recorded.
{
  const { _spentThisWindow } = await import("../src/x402-buyer.js");
  const OURS = "0x3333333333333333333333333333333333333333";
  const prev = process.env.WALLET_ADDRESS;
  process.env.WALLET_ADDRESS = OURS;
  try {
    globalThis.fetch = async () => challenge([{ ...v1entry({ amt: "1000" }), payTo: OURS.toUpperCase().replace(/^0X/, "0x") }]);
    let e = null;
    try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, allowUnproven: true }); } catch (err) { e = err; }
    ok(e && e.statusCode === 502 && /own wallets/.test(e.message) && /Nothing was signed/.test(e.message), `a challenge naming our own wallet (any letter case) is refused before signing (${e?.statusCode} ${e?.message})`);
    ok(_spentThisWindow() === 0n, "...and holds no spend budget");
  } finally { if (prev === undefined) delete process.env.WALLET_ADDRESS; else process.env.WALLET_ADDRESS = prev; }
}

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
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { m = e; }
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
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { raw = e; }
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
    try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, signBy: Date.now() - 1 }); } catch (e) { late = e; }
    ok(late && late.statusCode === 504 && /Nothing was signed/.test(late.message) && fetches === 1, `signBy: past its sign-by moment the payer refuses 504 after the bare 402 and sends no paid request (fetches ${fetches}, ${late?.statusCode})`);
    ok(_spentThisWindow() === 0n, "signBy: a refused late signature holds no spend budget");
    fetches = 0;
    let slow = null;
    globalThis.fetch = async () => { fetches++; await new Promise((r) => setTimeout(r, 60)); return challenge([payToEntry(PROVEN)]); };
    try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, signBy: Date.now() + 20 }); } catch (e) { slow = e; }
    ok(slow && slow.statusCode === 504 && fetches === 1, `signBy: a seller whose bare 402 takes past the sign-by moment is not paid (fetches ${fetches}, ${slow?.statusCode})`);
  }

  // MATCH (case-insensitive, EVM): must NOT be refused for payTo reasons.
  globalThis.fetch = async () => challenge([payToEntry(PROVEN.toUpperCase().replace("0X", "0x"))]);
  let ma = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { ma = e; }
  ok(!(ma && /Refusing to pay/.test(ma.message)),
    "payTo binding: the same address in different case is a MATCH, never a refusal (EVM is case-insensitive)");

  // UNKNOWN 1: no proven address on record - an honest seller proven by a
  // source that cannot name an address must not be blocked.
  globalThis.fetch = async () => challenge([payToEntry(OTHER)]);
  let u1 = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {} }); } catch (e) { u1 = e; }
  ok(!(u1 && /Refusing to pay/.test(u1.message)), "payTo binding: no proven address on record does not block");

  // UNKNOWN 2: an unreadable payTo in the live 402 is unknown, not a match and
  // not a refusal.
  globalThis.fetch = async () => challenge([payToEntry("not-an-address")]);
  let u2 = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { u2 = e; }
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
    try { await payX402("https://wrongdomain.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", memoizeDelivery: true }); } catch (e) { wd = e; }
    ok(wd && /EIP-712 name "USDC"/.test(wd.message) && /"USD Coin"/.test(wd.message) && /Nothing was signed/.test(wd.message), "wrong domain: a Base accept naming \"USDC\" is refused before signing, naming both names");
    ok(wd && wd.refused === true && wd.statusCode === 502, "wrong domain: the error is marked refused (route-execute falls through) with a 502");
    ok(_spentThisWindow() === 0n, "wrong domain: no budget held");
    ok(!sellerRefusedRecently("https://wrongdomain.example", "base"), "wrong domain: one meeting is recorded and benches nothing yet");
    try { await payX402("https://wrongdomain.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", memoizeDelivery: true }); } catch { /* refused again */ }
    ok(!!sellerRefusedRecently("https://wrongdomain.example", "base"), "wrong domain: the second meeting benches that route on base for the TTL");
    // Control: the same accept naming "USD Coin" passes the domain check. It
    // is then refused by the payTo binding one line further down (the proven
    // address differs), which proves the domain check threw nothing AND keeps
    // this offline test from signing against the stub.
    globalThis.fetch = async () => v2challenge([{ ...v2("USD Coin"), payTo: OTHER }]);
    let rd = null;
    try { await payX402("https://rightdomain.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", provenPayTo: PROVEN }); } catch (e) { rd = e; }
    ok(rd && /Refusing to pay/.test(rd.message) && !/EIP-712 name/.test(rd.message) && !sellerRefusedRecently("https://rightdomain.example", "base"), "right domain: \"USD Coin\" passes the domain check (the later payTo binding is what refuses) and is not memoized");

    // A direct-transfer accept is refused before anything is signed: the
    // seller is asked once (the unpaid request) and never sent a payment.
    let calls = 0;
    globalThis.fetch = async () => { calls++; return v2challenge([{ ...v2("USD Coin"), extra: { name: "USD Coin", version: "2", paymentMethod: "direct-transfer" } }]); };
    let dt = null;
    try { await payX402("https://directtransfer.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base" }); } catch (e) { dt = e; }
    ok(dt && dt.refused === true && /paymentMethod "direct-transfer"/.test(dt.message) && /Nothing was signed/.test(dt.message), "direct transfer: the accept is refused before signing, naming the method");
    ok(calls === 1 && _spentThisWindow() === 0n, `direct transfer: only the unpaid request was sent and no budget held (requests ${calls})`);

    // FIRST PAYABLE ACCEPT WINS: an unsignable Base USDC entry listed ahead of
    // a payable one does not refuse the seller. The payable one is signed for,
    // shown here by the payTo binding reading ITS address (OTHER).
    const gatewayFirst = { ...v2("GatewayWalletBatched"), extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" } };
    const directFirst = { ...v2("USD Coin"), extra: { name: "USD Coin", version: "2", paymentMethod: "direct-transfer" } };
    for (const [label, bad] of [["gateway", gatewayFirst], ["wrong name", v2("USDC")], ["direct transfer", directFirst]]) {
      globalThis.fetch = async () => v2challenge([bad, { ...v2("USD Coin"), payTo: OTHER }]);
      let e1 = null;
      try { await payX402(`https://first-${label.replace(/ /g, "-")}.example/x`, { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", provenPayTo: PROVEN }); } catch (e) { e1 = e; }
      ok(e1 && /Refusing to pay/.test(e1.message) && e1.message.includes(OTHER) && !e1.refused, `first payable: a ${label} accept listed first does not refuse a payable seller (got ${e1 && e1.message.slice(0, 80)})`);
    }
    const { pickPayableAccept } = await import("../src/x402-buyer.js");
    ok(pickPayableAccept([v2("USDC")], "base")?.extra?.name === "USDC", "first payable: with no payable entry the first is still returned, so the refusal names it");
  }

  // The check must read the accept we SIGN, not accepts[0]: a decoy first entry
  // paying the proven address cannot launder an exact entry paying elsewhere.
  globalThis.fetch = async () => challenge([
    { ...v1entry({ scheme: "upto", amt: "1" }), payTo: PROVEN },
    payToEntry(OTHER),
  ]);
  let d = null;
  try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, provenPayTo: PROVEN }); } catch (e) { d = e; }
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
  const buy = (notDebited, extra = {}) => payX402("https://refuser.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", memoizeDelivery: true, notDebited, ...extra }).then(() => null, (e) => e);
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
  ok(asked.untilUnix === vb + 5 && asked.maxWaitMs <= 12345 && asked.maxWaitMs > 12345 - 5000, `the chain check is told to wait until the signed validBefore (+ slack), bounded by what is left of the caller's refusalMaxWaitMs (${asked.maxWaitMs} of 12345 ms)`);
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
    return payX402("https://tenant.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", evidenceWallets, ...extra }).then((r) => ({ r }), (e) => ({ e }));
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
    try { await payX402("https://tenant.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "algorand", evidenceWallets: [W1] }); } catch (e) { a6 = e; }
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
  const { resolvedCandidateOf } = await import("../src/sor-candidates.js");
  const ew = ["0x00000000000000000000000000000000000000aa"];
  ok(/resolved\.push\(resolvedCandidateOf\([^\n]*\bevidenceWallets \}\)\)/.test(fn) && resolvedCandidateOf({ seller: "https://s.example" }, { evidenceWallets: ew }).evidenceWallets === ew,
    "A7: the resolved candidate carries evidenceWallets");
  const re = readFileSync(new URL("../src/tools/route-execute.js", import.meta.url), "utf8");
  ok(/payExternal\(extUrl, \{[^\n]*evidenceWallets: ext\.evidenceWallets/.test(re), "A7: route-execute passes evidenceWallets: ext.evidenceWallets to payExternal");
  const buyer = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const payFn = buyer.slice(buyer.indexOf("export async function payX402("));
  const at = payFn.indexOf("evidenceWallets.length");
  ok(at > payFn.indexOf("quoteWithinCap(quotedAtomic, maxAtomic)") && at < payFn.indexOf("assertPayoutScreened(payable.payTo") && at < payFn.indexOf("reserveSpend(quotedAtomic)"),
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
    try { await payX402("https://seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, allowUnproven: true, ...opts }); return null; } catch (e) { return e; }
  };
  delete process.env.SOR_BASE_UNPROVEN_MAX_USD;
  const spentBefore = _spentThisWindow();
  const high = await refusal("60000");
  ok(high && high.statusCode === 409 && /above the unproven ceiling 50000/.test(high.message), "unproven Base: a signed $0.06 quote above the $0.05 default ceiling is refused 409");
  ok(_spentThisWindow() === spentBefore, "unproven Base: the refusal holds no spend budget (before reserveSpend)");
  process.env.SOR_BASE_UNPROVEN_MAX_USD = "off";
  const off = await refusal("1000");
  ok(off && off.statusCode === 409, "unproven Base: with the tier switched off even a $0.001 quote is refused");
  process.env.SOR_BASE_UNPROVEN_MAX_USD = "not-a-number";
  const junk = await refusal("60000");
  ok(junk && junk.statusCode === 409 && /ceiling 50000/.test(junk.message), "unproven Base: a malformed env reads as the default ceiling, never a wider one");
  if (before === undefined) delete process.env.SOR_BASE_UNPROVEN_MAX_USD; else process.env.SOR_BASE_UNPROVEN_MAX_USD = before;
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/x402-buyer.js", import.meta.url), "utf8");
  const payFn = src.slice(src.indexOf("export async function payX402"));
  const at = payFn.indexOf('chain === "base" && allowUnproven');
  ok(at > payFn.indexOf("quoteWithinCap(quotedAtomic, maxAtomic)") && at < payFn.indexOf("reserveSpend(quotedAtomic)"), "unproven Base: the ceiling check sits after the cap check and before any budget hold or signature");
  const capAt = payFn.indexOf("reserveUnprovenSellerSpend(");
  ok(capAt > at && capAt > payFn.indexOf("let committed = false;\n  try {") && capAt < payFn.indexOf("createPaymentPayload("), "unproven Base: the per-seller daily cap is reserved after the ceiling check, inside the budget hold's try (a refusal gives the hold back), and before any signature");
}

// --- Base unproven tier: the per-seller rolling 24-hour cap ------------------
// SOR_BASE_UNPROVEN_SELLER_DAILY_USD (default $0.25) bounds what the lane pays
// one seller (its payTo and its origin host) in 24 h. The signed amount is
// reserved before signing and kept once the payment may have moved; a payment
// that provably moved nothing gives it back. Driven through payX402 against a
// stub seller that settles, with the real signer (counted at the call).
{
  const BU = await import("../src/base-unproven.js");
  const { getUpstreamBuyer, _spentThisWindow } = await import("../src/x402-buyer.js");
  const savedMax = process.env.SOR_BASE_UNPROVEN_MAX_USD, savedCap = process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
  delete process.env.SOR_BASE_UNPROVEN_MAX_USD; delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
  ok(BU.baseUnprovenAllowanceUsd() === 0.05 && BU.BASE_UNPROVEN_DEFAULT_USD === 0.05, "unproven cap: the Base ceiling defaults to $0.05");
  ok(BU.baseUnprovenSellerDailyUsd() === 0.25, "unproven cap: the per-seller daily cap defaults to $0.25");
  for (const [raw, want, label] of [["off", null, "'off' removes the cap"], ["0", null, "'0' removes the cap"], ["junk", 0.25, "a malformed value reads as the default, never as off"], ["-1", 0.25, "a negative value reads as the default"], ["0.1", 0.1, "a custom cap is honored"]]) {
    process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = raw;
    ok(BU.baseUnprovenSellerDailyUsd() === want, `unproven cap: ${label}`);
  }
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const SELLER_W = "0x" + "5c".repeat(20), OTHER_W = "0x" + "6d".repeat(20);
  const accept = (payTo, amount) => ({ scheme: "exact", network: "eip155:8453", asset: USDC, amount, payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } });
  let paidRequests = 0;
  const stub = (payTo, amount) => async (_url, init) => {
    const h = init?.headers || {};
    if (!(h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"])) {
      return { status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? b64({ x402Version: 2, accepts: [accept(payTo, amount)] }) : null) }, json: async () => ({}), text: async () => "{}" };
    }
    paidRequests++;
    return new Response(JSON.stringify({ answer: 7 }), { status: 200, headers: { "content-type": "application/json", "payment-response": b64({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453" }) } });
  };
  const evm = await getUpstreamBuyer();
  const realSign = evm.client.createPaymentPayload.bind(evm.client);
  let signs = 0;
  evm.client.createPaymentPayload = async (...a) => { signs++; return realSign(...a); };
  const buy = (origin, payTo, amount = "50000", extra = {}) => {
    globalThis.fetch = stub(payTo, amount);
    return payX402(`${origin}/data`, { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", allowUnproven: true, ...extra }).then((r) => ({ r }), (e) => ({ e }));
  };
  await BU.__resetUnprovenSellerLedger();

  // CONTROL: a $0.05 quote (the new ceiling, the old one refused it) is signed and settles.
  signs = 0; paidRequests = 0;
  const first = await buy("https://fresh-seller.example", SELLER_W);
  ok(!first.e && first.r?.result?.answer === 7 && signs === 1 && paidRequests === 1, `unproven cap: a $0.05 unproven quote is signed once and settles (${first.e ? first.e.message : "ok"})`);
  ok(Math.abs(await BU.unprovenSellerSpentUsd({ payTo: SELLER_W, origin: "https://fresh-seller.example" }) - 0.05) < 1e-9, "unproven cap: the settled buy books its signed $0.05 against the seller");
  for (let i = 0; i < 4; i++) await buy("https://fresh-seller.example", SELLER_W);
  ok(Math.abs(await BU.unprovenSellerSpentUsd({ payTo: SELLER_W }) - 0.25) < 1e-9, "unproven cap: five settled $0.05 buys reach the $0.25 cap");
  signs = 0; paidRequests = 0;
  const heldBefore6 = _spentThisWindow();
  const sixth = await buy("https://fresh-seller.example", SELLER_W);
  ok(sixth.e && sixth.e.statusCode === 409 && /daily cap per seller/.test(sixth.e.message) && signs === 0 && paidRequests === 0, `unproven cap: the sixth buy is refused 409 before anything is signed (${sixth.e?.statusCode} ${sixth.e?.message}; signs ${signs})`);
  {
    // Every figure in the cap sentences prints through usdFigure: a sub-cent
    // spend keeps its digits, a whole-dollar cap prints its cents.
    const { unprovenCapMessage } = await import("../src/x402-buyer.js");
    const m1 = unprovenCapMessage("0x1234567890abcdef", { code: "unproven_seller_daily_cap", spentUsd: 0.003, capUsd: 5 });
    const m2 = unprovenCapMessage("0x1234567890abcdef", { code: "unproven_lane_daily_cap", spentUsd: 4.5, capUsd: 5 });
    ok(m1.includes("daily cap per seller ($0.003 of $5.00 in 24 h)") && m2.includes("daily cap across all sellers ($4.50 of $5.00 in 24 h)"), `unproven cap: the buyer-visible 409 prints both figures through usdFigure (${m1} | ${m2})`);
    const s1 = BU._sellerCapRefusal(3000, 5).reason, l1 = BU._laneCapRefusal(4_500_000, 5).reason;
    ok(s1.includes("paid $0.003 through the Base unproven lane") && s1.includes("(cap $5.00 per seller)") && l1.includes("paid $4.50 across all sellers") && l1.includes("(cap $5.00)"), `unproven cap: the seller and lane refusal reasons print through usdFigure (${s1} | ${l1})`);
  }
  ok(sixth.e && sixth.e.committed !== true, "unproven cap: the refusal is pre-commit, so the router may try its next candidate");
  ok(_spentThisWindow() === heldBefore6, "unproven cap: the refusal gives the window budget hold back");
  // The same wallet behind another origin, and another wallet behind the same origin, are the same seller.
  const sameWallet = await buy("https://second-front.example", SELLER_W);
  ok(sameWallet.e && sameWallet.e.statusCode === 409, "unproven cap: the same payTo behind another origin is still capped");
  const sameOrigin = await buy("https://fresh-seller.example", OTHER_W);
  ok(sameOrigin.e && sameOrigin.e.statusCode === 409, "unproven cap: another payTo behind the same origin is still capped");
  signs = 0;
  const other = await buy("https://other-seller.example", OTHER_W);
  ok(!other.e && signs === 1, `unproven cap: a different seller (wallet and origin) is not affected (${other.e?.message || "ok"})`);
  // A proven candidate (allowUnproven false) never reads the lane's cap.
  signs = 0;
  const proven = await buy("https://fresh-seller.example", SELLER_W, "50000", { allowUnproven: false });
  ok(!proven.e && signs === 1, `unproven cap: a proven buy from a capped seller is not refused by the lane's cap (${proven.e?.message || "ok"})`);

  // A payment that provably moved nothing gives its reservation back: signBy
  // in the past refuses after the reservation, before anything is signed.
  await BU.__resetUnprovenSellerLedger();
  signs = 0;
  const late = await buy("https://late-seller.example", SELLER_W, "50000", { signBy: Date.now() - 1000 });
  ok(late.e && late.e.statusCode === 504 && signs === 0, `unproven cap: a refusal before signing (${late.e?.statusCode})`);
  ok(await BU.unprovenSellerSpentUsd({ payTo: SELLER_W, origin: "https://late-seller.example" }) === 0, "unproven cap: ...gives the seller's reservation back");

  // The window rolls: 24 h after the spend, the seller is paid again (clock injected on the ledger).
  await BU.__resetUnprovenSellerLedger();
  const t0 = Date.now();
  const res = [];
  for (let i = 0; i < 6; i++) res.push(await BU.reserveUnprovenSellerSpend({ payTo: SELLER_W, origin: "https://roll.example", atomic: 50000n, now: t0 + i }));
  ok(res.slice(0, 5).every((r) => r.ok) && res[5].ok === false && res[5].code === "unproven_seller_daily_cap", "unproven cap (ledger): five $0.05 reservations fit, the sixth is refused");
  ok((await BU.reserveUnprovenSellerSpend({ payTo: SELLER_W, origin: "https://roll.example", atomic: 50000n, now: t0 + 23 * 3600_000 })).ok === false, "unproven cap (ledger): still refused 23 h later");
  ok((await BU.reserveUnprovenSellerSpend({ payTo: SELLER_W, origin: "https://roll.example", atomic: 50000n, now: t0 + 24 * 3600_000 + 10 })).ok === true, "unproven cap (ledger): allowed again once the first spend is 24 h old");
  const rel = [];
  for (let i = 0; i < 3; i++) rel.push(await BU.reserveUnprovenSellerSpend({ payTo: OTHER_W, origin: "https://release.example", atomic: 40000n, now: t0 + i }));
  BU.releaseUnprovenSellerSpend(rel[0].handle);
  BU.releaseUnprovenSellerSpend(rel[0].handle);
  ok(Math.abs(await BU.unprovenSellerSpentUsd({ payTo: OTHER_W, origin: "https://release.example", now: t0 + 10 }) - 0.08) < 1e-9, "unproven cap (ledger): a release gives back exactly its own amount, once");
  ok((await BU.reserveUnprovenSellerSpend({ payTo: "not-an-address", origin: "not a url", atomic: 1000n })).ok === false, "unproven cap (ledger): a seller with no readable key is not paid in the lane");
  process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = "off";
  ok((await BU.reserveUnprovenSellerSpend({ payTo: SELLER_W, origin: "https://roll.example", atomic: 50000n, now: t0 + 20 })).ok === true, "unproven cap (ledger): switched off, the cap refuses nothing");
  delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;

  // A COMMITTED buy that then fails stays booked: the paid leg answers 500
  // after the request was sent and the chain shows the authorization
  // consumed (the seller took the money), so the seller's $0.05 stands and a
  // buy past its cap is still refused. Control: the same 500 with the chain
  // showing the credential expired unused gives the reservation back.
  {
    const failing = (payTo) => async (_url, init) => {
      const h = init?.headers || {};
      if (!(h["PAYMENT-SIGNATURE"] || h["payment-signature"] || h["X-PAYMENT"])) {
        return { status: 402, headers: { get: (n) => (String(n).toLowerCase() === "payment-required" ? b64({ x402Version: 2, accepts: [accept(payTo, "50000")] }) : null) }, json: async () => ({}), text: async () => "{}" };
      }
      paidRequests++;
      return new Response(JSON.stringify({ error: "backend down" }), { status: 500, headers: { "content-type": "application/json" } });
    };
    const buyFailing = (origin, payTo, notDebited) => {
      globalThis.fetch = failing(payTo);
      return payX402(`${origin}/data`, { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", allowUnproven: true, notDebited, refusalMaxWaitMs: 0 }).then((r) => ({ r }), (e) => ({ e }));
    };
    await BU.__resetUnprovenSellerLedger();
    const TAKER_W = "0x" + "7e".repeat(20);
    signs = 0; paidRequests = 0;
    const took = await buyFailing("https://taker.example", TAKER_W, async () => ({ debited: true, expired: false, observed: 1 }));
    ok(took.e && took.e.committed === true && signs === 1 && paidRequests === 1, `unproven cap: a paid leg answering 500 after the payment was sent is a committed failure (${took.e?.statusCode} committed ${took.e?.committed})`);
    ok(Math.abs(await BU.unprovenSellerSpentUsd({ payTo: TAKER_W, origin: "https://taker.example" }) - 0.05) < 1e-9, "unproven cap: ...and the seller's $0.05 stays booked (the seller took the money)");
    for (let i = 0; i < 4; i++) await buy("https://taker.example", TAKER_W);
    signs = 0;
    const past = await buy("https://taker.example", TAKER_W);
    ok(past.e && past.e.statusCode === 409 && /daily cap per seller/.test(past.e.message) && signs === 0, `unproven cap: the failed-but-charged buy counts toward the cap, so the next buy past it is refused (${past.e?.message || "paid"})`);
    const REFUSER_W = "0x" + "8f".repeat(20);
    const refused = await buyFailing("https://refuser.example", REFUSER_W, async () => ({ debited: false, expired: true, observed: 3 }));
    ok(refused.e && refused.e.committed === false, `unproven cap (control): a 500 the chain proves unpaid is not committed (${refused.e?.committed})`);
    ok(await BU.unprovenSellerSpentUsd({ payTo: REFUSER_W, origin: "https://refuser.example" }) === 0, "unproven cap (control): ...and gives the seller's reservation back");
  }

  // LANE DAILY CAP (SOR_BASE_UNPROVEN_DAILY_USD, default $5): bounds the
  // lane's spend across all sellers, reserved beside the seller's windows.
  {
    const savedLane = process.env.SOR_BASE_UNPROVEN_DAILY_USD;
    delete process.env.SOR_BASE_UNPROVEN_DAILY_USD;
    ok(BU.baseUnprovenLaneDailyUsd() === 5 && BU.BASE_UNPROVEN_LANE_DAILY_DEFAULT_USD === 5, "lane cap: defaults to $5");
    for (const [raw, want, label] of [["off", null, "'off' removes it"], ["0", null, "'0' removes it"], ["junk", 5, "a malformed value reads as the default"], ["-2", 5, "a negative value reads as the default"], ["0.12", 0.12, "a custom cap is honored"]]) {
      process.env.SOR_BASE_UNPROVEN_DAILY_USD = raw;
      ok(BU.baseUnprovenLaneDailyUsd() === want, `lane cap: ${label}`);
    }
    // $0.12 across the lane: two $0.05 buys from two different sellers fit,
    // a third seller (under its own cap) is refused 409 before signing.
    process.env.SOR_BASE_UNPROVEN_DAILY_USD = "0.12";
    await BU.__resetUnprovenSellerLedger();
    signs = 0;
    const l1 = await buy("https://lane-one.example", "0x" + "a1".repeat(20));
    const l2 = await buy("https://lane-two.example", "0x" + "a2".repeat(20));
    ok(!l1.e && !l2.e && signs === 2, `lane cap: two sellers' $0.05 buys fit under $0.12 (${l1.e?.message || l2.e?.message || "ok"})`);
    ok(Math.abs(await BU.unprovenLaneSpentUsd() - 0.10) < 1e-9, "lane cap: the lane reads $0.10 booked across both sellers");
    signs = 0; paidRequests = 0;
    const heldBefore = _spentThisWindow();
    const l3 = await buy("https://lane-three.example", "0x" + "a3".repeat(20));
    ok(l3.e && l3.e.statusCode === 409 && /daily cap across all sellers/.test(l3.e.message) && signs === 0 && paidRequests === 0, `lane cap: a third seller under its own cap is refused 409 before signing (${l3.e?.statusCode} ${l3.e?.message})`);
    ok(l3.e && l3.e.committed !== true && _spentThisWindow() === heldBefore, "lane cap: the refusal is pre-commit and gives the budget hold back, so the router moves on");
    ok(await BU.unprovenSellerSpentUsd({ payTo: "0x" + "a3".repeat(20), origin: "https://lane-three.example" }) === 0, "lane cap: the refused seller's own window holds nothing");
    signs = 0;
    const provenPast = await buy("https://lane-three.example", "0x" + "a3".repeat(20), "50000", { allowUnproven: false });
    ok(!provenPast.e && signs === 1, "lane cap: a proven buy never reads the lane cap");
    // A release gives the lane's room back too; a refusal before signing books nothing.
    const t1 = Date.now();
    await BU.__resetUnprovenSellerLedger();
    const h1 = await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "b1".repeat(20), origin: "https://r1.example", atomic: 50000n, now: t1 });
    const h2 = await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "b2".repeat(20), origin: "https://r2.example", atomic: 50000n, now: t1 });
    const h3 = await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "b3".repeat(20), origin: "https://r3.example", atomic: 50000n, now: t1 });
    ok(h1.ok && h2.ok && h3.ok === false && h3.code === "unproven_lane_daily_cap", `lane cap (ledger): the third seller's reservation is refused by the lane (${h3.code})`);
    BU.releaseUnprovenSellerSpend(h1.handle);
    ok((await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "b3".repeat(20), origin: "https://r3.example", atomic: 50000n, now: t1 + 1 })).ok === true, "lane cap (ledger): a release gives the lane's room back");
    ok((await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "b4".repeat(20), origin: "https://r4.example", atomic: 50000n, now: t1 + 24 * 3600_000 + 10 })).ok === true, "lane cap (ledger): the lane's window rolls after 24 h");
    // A seller refused by its own cap and the lane at once reads as the seller's refusal.
    await BU.__resetUnprovenSellerLedger();
    process.env.SOR_BASE_UNPROVEN_DAILY_USD = "0.05";
    process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = "0.05";
    await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "c1".repeat(20), origin: "https://c1.example", atomic: 50000n, now: t1 });
    ok((await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "c1".repeat(20), origin: "https://c1.example", atomic: 50000n, now: t1 + 1 })).code === "unproven_seller_daily_cap", "lane cap (ledger): when both refuse, the seller's own cap is named");
    // Off: the lane cap refuses nothing.
    process.env.SOR_BASE_UNPROVEN_DAILY_USD = "off";
    delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
    await BU.__resetUnprovenSellerLedger();
    const many = [];
    for (let i = 0; i < 6; i++) many.push(await BU.reserveUnprovenSellerSpend({ payTo: `0x${String(i).repeat(40)}`, origin: `https://off${i}.example`, atomic: 50000n, now: t1 }));
    ok(many.every((r) => r.ok), "lane cap (ledger): switched off, six sellers' $0.05 each are all reserved");
    // Both caps off: no handle at all.
    process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = "off";
    const none = await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "d1".repeat(20), origin: "https://d1.example", atomic: 50000n });
    ok(none.ok && none.handle === null, "lane cap (ledger): with both caps off nothing is reserved");
    delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD;
    if (savedLane === undefined) delete process.env.SOR_BASE_UNPROVEN_DAILY_USD; else process.env.SOR_BASE_UNPROVEN_DAILY_USD = savedLane;
  }

  // A payTo listed as shared (src/shared-paytos.js) is not one seller's
  // wallet: sellers paid at it are keyed on their origins alone, so each keeps
  // its own day; an unlisted payTo still ties its sellers together.
  {
    await BU.__resetUnprovenSellerLedger();
    const SPLIT = "0x" + "e5".repeat(20);
    BU.configureUnprovenSharedPayTos((w) => w === SPLIT);
    ok(BU.unprovenSellerKeys({ payTo: SPLIT.toUpperCase().replace("0X", "0x"), origin: "https://t1.example" }).join(",") === "origin:t1.example", "shared payTo: the key is the origin alone");
    ok(BU.unprovenSellerKeys({ payTo: "0x" + "e6".repeat(20), origin: "https://t1.example" }).length === 2, "shared payTo: an unlisted payTo keeps both keys");
    const t2 = Date.now();
    for (let i = 0; i < 5; i++) await BU.reserveUnprovenSellerSpend({ payTo: SPLIT, origin: "https://t1.example", atomic: 50000n, now: t2 });
    ok((await BU.reserveUnprovenSellerSpend({ payTo: SPLIT, origin: "https://t1.example", atomic: 50000n, now: t2 })).ok === false, "shared payTo: the first tenant still reaches its own $0.25 cap");
    ok((await BU.reserveUnprovenSellerSpend({ payTo: SPLIT, origin: "https://t2.example", atomic: 50000n, now: t2 })).ok === true, "shared payTo: a second tenant behind the same listed payTo keeps its own day");
    ok((await BU.reserveUnprovenSellerSpend({ payTo: SPLIT, origin: "not a url", atomic: 50000n, now: t2 })).ok === false, "shared payTo: a tenant with no readable origin has no key and is not paid in the lane");
    BU.configureUnprovenSharedPayTos(() => { throw new Error("store down"); });
    ok(BU.unprovenSellerKeys({ payTo: SPLIT, origin: "https://t1.example" }).length === 2, "shared payTo: a predicate that throws keeps both keys (the stricter reading)");
    BU.configureUnprovenSharedPayTos(null);
    ok(BU.unprovenSellerKeys({ payTo: SPLIT, origin: "https://t1.example" }).length === 2, "shared payTo: cleared, the payTo is a key again");
    const srv = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8"));
    ok(/configureUnprovenSharedPayTos\(\(w\) => sharedPayToStore\(\)\.has\(w\)\)/.test(srv), "shared payTo: the server hands in its shared-payTo store (pin)");
  }

  // PATH-SCOPED SELLERS. The index keeps `https://host/app/<name>` as its own
  // seller (origin plus prefix); its origin key is that identity, handed in as
  // sellerKey, so tenants on one host each keep their own day, a bare origin
  // is keyed as before, and a tenant cannot buy a fresh day by varying the
  // paid path below its own prefix.
  {
    await BU.__resetUnprovenSellerLedger();
    const TA = "https://shared.example/app/tenant-a", TB = "https://shared.example/app/tenant-b";
    const WA = "0x" + "a7".repeat(20), WB = "0x" + "b7".repeat(20);
    // Through payX402, the caller path route-execute takes.
    for (let i = 0; i < 5; i++) await buy(TA, WA, "50000", { sellerKey: TA });
    signs = 0;
    const capA = await buy(TA, WA, "50000", { sellerKey: TA });
    ok(capA.e && capA.e.statusCode === 409 && /daily cap per seller/.test(capA.e.message) && signs === 0, `path seller: tenant A reaches its own $0.25 cap (${capA.e?.statusCode})`);
    signs = 0;
    const tenB = await buy(TB, WB, "50000", { sellerKey: TB });
    ok(!tenB.e && signs === 1, `path seller: tenant B on the same host keeps its own day (${tenB.e?.message || "ok"})`);
    ok(Math.abs(await BU.unprovenSellerSpentUsd({ origin: TA, sellerKey: TA }) - 0.25) < 1e-9 && Math.abs(await BU.unprovenSellerSpentUsd({ origin: TB, sellerKey: TB }) - 0.05) < 1e-9, "path seller: each tenant's spend is booked on its own key");
    ok(BU.unprovenSellerKeys({ payTo: WA, origin: `${TA}/data`, sellerKey: TA }).join(",") === `payto:${WA},origin:shared.example/app/tenant-a`, "path seller: the keys are the payTo and the origin plus prefix");
    // An ordinary host is unchanged, with or without its seller key.
    ok(BU.unprovenSellerKeys({ payTo: WA, origin: "https://plain.example/data", sellerKey: "https://plain.example" }).join(",") === `payto:${WA},origin:plain.example`, "path seller: a bare-origin seller keeps its host key");
    ok(BU.unprovenSellerKeys({ payTo: WA, origin: "https://plain.example/data" }).join(",") === `payto:${WA},origin:plain.example`, "path seller: a call with no seller key keeps the host key");
    ok(BU.unprovenSellerKeys({ origin: "https://Plain.Example:8443/x", sellerKey: "https://plain.example:8443" }).join(",") === "origin:plain.example:8443", "path seller: the host key carries a non-default port, lowercased");
    // Varying the paid path below the prefix (and the payTo) buys no fresh day.
    const t3 = Date.now();
    const TC = "https://shared.example/app/tenant-c";
    const paths = [`${TC}/x`, `${TC}/y/z`, TC, `${TC}/`, `${TC}/x?q=1`];
    for (let i = 0; i < 5; i++) {
      const r = await BU.reserveUnprovenSellerSpend({ payTo: "0x" + String(i + 1).repeat(40), origin: paths[i], sellerKey: TC, atomic: 50000n, now: t3 });
      ok(r.ok === true, `path seller: tenant C buy ${i + 1} under ${new URL(paths[i]).pathname} is reserved`);
    }
    const sixth = await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "9".repeat(40), origin: `${TC}/deep/er/path`, sellerKey: TC, atomic: 50000n, now: t3 });
    ok(sixth.ok === false && sixth.code === "unproven_seller_daily_cap", "path seller: a sixth buy at another path below the prefix, from a fresh payTo, is still refused");
    // A paid URL outside its own prefix gets no key, so the lane refuses it.
    for (const [url, label] of [["https://shared.example/app/tenant-c2/x", "a sibling sharing the text prefix"], ["https://shared.example/app/other/x", "another tenant's path"], ["https://shared.example/x", "the host root"], ["https://elsewhere.example/app/tenant-c/x", "another host"], ["http://shared.example/app/tenant-c/x", "another scheme"]]) {
      ok(BU.unprovenSellerKeys({ payTo: WA, origin: url, sellerKey: TC }).length === 0, `path seller: ${label} is not under the seller key, so it has no key`);
    }
    const outside = await BU.reserveUnprovenSellerSpend({ payTo: "0x" + "8".repeat(40), origin: "https://shared.example/app/tenant-c2/x", sellerKey: TC, atomic: 50000n, now: t3 });
    ok(outside.ok === false, "path seller: a buy at a URL outside its own prefix is not paid in the lane");
    ok(BU.unprovenSellerKeys({ payTo: WA, origin: "https://shared.example/app/tenant-c/../tenant-d/x", sellerKey: TC }).length === 0, "path seller: a dot segment that resolves outside the prefix has no key");
  }

  evm.client.createPaymentPayload = realSign;
  await BU.__resetUnprovenSellerLedger();
  if (savedMax === undefined) delete process.env.SOR_BASE_UNPROVEN_MAX_USD; else process.env.SOR_BASE_UNPROVEN_MAX_USD = savedMax;
  if (savedCap === undefined) delete process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD; else process.env.SOR_BASE_UNPROVEN_SELLER_DAILY_USD = savedCap;
}

// --- the signed value is the capped value (v1 maxAmountRequired) -----------
// x402 v1 signs maxAmountRequired and v2 signs amount. A seller that quotes a
// small `amount` beside a large `maxAmountRequired` must never get a signature
// for the large figure while the cap and the logs see the small one.
{
  const { __resetSellerRefusalsForTest: resetRef, _spentThisWindow: spent } = await import("../src/x402-buyer.js");
  const run = async (accept, label) => {
    resetRef();
    let signed = null, attempts = 0;
    const body = { x402Version: 1, accepts: [accept] };
    globalThis.fetch = async (url, init) => {
      const paid = init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["payment-signature"] || init?.headers?.["X-PAYMENT"];
      if (!paid) return { status: 402, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
      attempts++;
      try { signed = JSON.parse(Buffer.from(paid, "base64").toString("utf8")); } catch { signed = null; }
      return { status: 402, headers: { get: () => "application/json" }, json: async () => ({ error: "payment_verification_failed" }), text: async () => "{}" };
    };
    const held = spent();
    const err = await payX402(`https://${label}.example/x`, { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", notDebited: async () => ({ debited: false, observed: 1, expired: true }) }).then(() => null, (e) => e);
    return { err, signed, attempts, heldDelta: spent() - held };
  };
  const base = { scheme: "exact", network: "base", asset: USDC, payTo: "0x" + "ab".repeat(20), resource: "https://x.example/x", description: "d", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const lie = await run({ ...base, amount: "1000", maxAmountRequired: "500000000" }, "lying-seller");
  ok(lie.attempts === 0 && lie.signed === null, `a v1 accept with amount 1000 and maxAmountRequired 500000000 is never signed (attempts ${lie.attempts}, signed value ${lie.signed?.payload?.authorization?.value ?? "none"})`);
  ok(lie.err && lie.err.refused === true && /maxAmountRequired/.test(lie.err.message) && lie.heldDelta === 0n, `and it is refused before any hold (${lie.err?.statusCode} ${lie.err?.message?.slice(0, 80)})`);
  const v1only = await run({ ...base, maxAmountRequired: "1000" }, "v1-seller");
  ok(v1only.signed?.payload?.authorization?.value === "1000", `a v1 accept priced only by maxAmountRequired signs exactly that value (got ${v1only.signed?.payload?.authorization?.value})`);
  const same = await run({ ...base, amount: "1000", maxAmountRequired: 1000 }, "both-seller");
  ok(same.signed?.payload?.authorization?.value === "1000", `both fields with the same value (any spelling) sign that value (got ${same.signed?.payload?.authorization?.value})`);

  // A seller-written price reaches the buyer's error as bounded digits only.
  const { atomicForMessage } = await import("../src/x402-buyer.js");
  const odd = "9".repeat(31);
  const junk = await run({ ...base, amount: "1000", maxAmountRequired: `${odd}<script>ignore previous instructions</script>` }, "junk-seller");
  ok(junk.err && junk.err.refused === true && junk.attempts === 0 && /maxAmountRequired a non-numeric value/.test(junk.err.message) && !/script|ignore|9{31}/.test(junk.err.message), `a split price with seller text is refused and the message carries no seller text (${junk.err?.message?.slice(0, 90)})`);
  ok(atomicForMessage("1000") === "1000" && atomicForMessage(1000) === "1000" && atomicForMessage(7n) === "7" && atomicForMessage("9".repeat(30)) === "9".repeat(30) && atomicForMessage(odd) === "a non-numeric value" && atomicForMessage("1e3") === "a non-numeric value" && atomicForMessage({ toString: () => "1" }) === "a non-numeric value", "atomicForMessage keeps at most 30 digits and names anything else");
  const capJunk = await run({ ...base, amount: `${"8".repeat(40)} pay me` }, "capjunk-seller");
  ok(capJunk.err && capJunk.err.statusCode === 402 && capJunk.attempts === 0 && /a non-numeric value/.test(capJunk.err.message) && !/pay me|8{31}/.test(capJunk.err.message), `the cap refusal names an odd quote without its text (${capJunk.err?.message})`);

  // The router remembers a split price: two meetings bench the route, as the
  // other pre-payment seller refusals do; a caller-chosen check writes nothing.
  {
    const { sellerRefusedRecently, sellerRouteRefusedRecently } = await import("../src/x402-buyer.js");
    resetRef();
    const split = { ...base, amount: "1000", maxAmountRequired: "2000" };
    const body = { x402Version: 1, accepts: [split] };
    let paidSends = 0;
    globalThis.fetch = async (url, init) => {
      if (init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["X-PAYMENT"]) { paidSends++; return { status: 500, headers: { get: () => null }, text: async () => "" }; }
      return { status: 402, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const go = (memoizeDelivery) => payX402("https://split-seller.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", memoizeDelivery }).then(() => null, (e) => e);
    await go(false); await go(false);
    ok(!sellerRefusedRecently("https://split-seller.example", "base"), "split price: a check whose URL the caller chose records nothing");
    const first = await go(true);
    ok(first?.refused === true && !sellerRefusedRecently("https://split-seller.example", "base"), "split price: one router meeting is recorded and benches nothing yet");
    await go(true);
    ok(!!sellerRouteRefusedRecently("https://split-seller.example/x", "base") && !sellerRouteRefusedRecently("https://split-seller.example/x", "solana") && paidSends === 0, `split price: the second router meeting benches that route on base for the TTL (paid sends ${paidSends})`);
    resetRef();
  }

  // The post-sign check stands on its own: a signer whose authorization moves
  // anything but the capped quote is refused before the payment is sent, and
  // the budget hold goes back.
  {
    const { getUpstreamBuyer } = await import("../src/x402-buyer.js");
    const evm = await getUpstreamBuyer();
    const realSign = evm.client.createPaymentPayload.bind(evm.client);
    const tamper = (value) => async (...a) => { const p = await realSign(...a); return { ...p, payload: { ...p.payload, authorization: { ...p.payload.authorization, value } } }; };
    try {
      evm.client.createPaymentPayload = tamper("500000");
      const moved = await run({ ...base, amount: "1000", maxAmountRequired: "1000" }, "signer-drift");
      ok(moved.attempts === 0 && moved.err?.refused === true && moved.err?.statusCode === 502 && moved.err?.committed !== true && moved.heldDelta === 0n && /does not equal the capped quote 1000/.test(moved.err.message), `a signed value other than the quote is refused, nothing sent, hold released (attempts ${moved.attempts}, ${moved.err?.message?.slice(0, 80)})`);
      evm.client.createPaymentPayload = tamper("not-a-number");
      const garbled = await run({ ...base, amount: "1000", maxAmountRequired: "1000" }, "signer-garbled");
      ok(garbled.attempts === 0 && garbled.err?.refused === true && garbled.err?.statusCode === 502 && garbled.heldDelta === 0n && /\(a non-numeric value\)/.test(garbled.err.message), `an unreadable signed value is refused the same way (${garbled.err?.message?.slice(0, 80)})`);
      evm.client.createPaymentPayload = tamper(undefined);
      const missing = await run({ ...base, amount: "1000", maxAmountRequired: "1000" }, "signer-missing");
      ok(missing.attempts === 0 && missing.err?.refused === true && missing.heldDelta === 0n && /\(missing\)/.test(missing.err.message), "a payload with no signed value is refused the same way");
    } finally {
      evm.client.createPaymentPayload = realSign;
    }
  }
}

// The refusal wait is a deadline from the call's start: a seller that never
// answers the paid request does not add its timeout on top of the caller's
// remaining budget (route-execute hands that budget in as refusalMaxWaitMs).
{
  const { payX402: pay, __resetSellerRefusalsForTest: resetRefusals } = await import("../src/x402-buyer.js");
  resetRefusals?.();
  const acc = { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "1000", payTo: "0x" + "ef".repeat(20), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const h = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [acc] })).toString("base64");
  globalThis.fetch = async (url, init) => {
    const paidHdr = init?.headers?.["PAYMENT-SIGNATURE"] || init?.headers?.["payment-signature"] || init?.headers?.["X-PAYMENT"];
    if (!paidHdr) return { status: 402, headers: { get: (k) => (k.toLowerCase() === "payment-required" ? h : null) }, json: async () => ({}), text: async () => "{}" };
    return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  };
  const waits = [];
  const notDebited = async ({ maxWaitMs }) => { waits.push(maxWaitMs); await new Promise((r) => setTimeout(r, maxWaitMs)); return { debited: false, expired: false, observed: 0 }; };
  const keep = setInterval(() => {}, 1000);
  const t0 = Date.now();
  const err = await pay("https://hangs.example/x", { maxAtomic: 500000n, method: "POST", body: {}, chain: "base", notDebited, timeoutMs: 600, refusalMaxWaitMs: 1000 }).then(() => null, (e) => e);
  const took = Date.now() - t0;
  clearInterval(keep);
  ok(err?.statusCode === 502 && err?.paidUnanswered === true && err?.committed === true, `an unanswered paid request keeps the hold (${err?.message})`);
  ok(took < 1300 && waits[0] <= 450, `the refusal wait ends inside the caller's budget from the call's start: 1000 ms budget, 600 ms seller timeout, took ${took} ms (chain wait ${waits[0]} ms)`);
}

globalThis.fetch = origFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
