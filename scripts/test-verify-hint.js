#!/usr/bin/env node
// A rejected payment is answered in the buyer's language (src/verify-hint.js):
// balance short vs stale authorization, on the 402, with a retry verb. Offline.
import { unclassifiedPaymentHint } from "../src/payment-reject.js";
import { encodeFunctionResult, decodeFunctionData } from "viem";
import { hintFor, balanceBucket, noteVerifyFailure, hintForCredential, credentialKeyOf, credentialKeyFromHeader, verifyHintMiddleware, usdcBalanceOnBase, _testResetForTest, _inflightForTest, _queuedForTest, _limitsForTest, decodeBalanceMulticall, baseRpcUrls } from "../src/verify-hint.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };
const PAYER = "0xc59e74ed6386b2a12d892fff2509a6965a0498dc";
const REVERT = "[CDP (Base)] invalid_payload: contract call failed: unable to call contract: execution reverted";

// hintFor
const empty = hintFor({ reason: REVERT, balanceUsd: 0, priceUsd: 0.005, network: "eip155:8453", payer: PAYER });
ok(empty.retry === "fund-wallet" && /holds \$0\.0000 USDC on Base and this call costs \$0\.0050/.test(empty.hint) && /sign a NEW authorization/.test(empty.hint), "execution reverted + empty wallet -> fund-wallet, with the balance and the price");
// SUPERSEDED, not deleted (2026-09-19). This used to assert that a balance
// under the price is "fund-wallet" like an empty one. Measured on 30 days of
// production: 6,473 of 6,582 Base verify failures were this exact state - 20
// wallets holding USDC, just less than the price - each retrying the same
// doomed authorization 300-plus times, while a truly EMPTY wallet accounted
// for 10 attempts. "Fund the wallet" is a dead end for a buyer who can already
// afford something; naming what the balance covers is a route they can take
// now. An empty wallet still gets fund-wallet, which the case above pins.
const short = hintFor({ reason: REVERT, balanceUsd: 0.002, priceUsd: 0.005, payer: PAYER });
ok(short.retry === "lower-price-route" && short.wantsAffordable === true && /holds \$0\.0020/.test(short.hint), "a FUNDED wallet under the price is pointed at what it can afford, not told to top up");
ok(/\/api\/pricing/.test(short.hint) && /\/api\/find/.test(short.hint), "and the hint names the two surfaces that answer 'what can I afford'");
const stale = hintFor({ reason: REVERT, balanceUsd: 12.5, priceUsd: 0.005, payer: PAYER });
ok(stale.retry === "fresh-authorization" && /nonce was already spent or its validity window has passed/.test(stale.hint) && /Never re-send/.test(stale.hint), "execution reverted with a funded wallet -> the authorization is stale: sign a fresh one");
ok(hintFor({ reason: REVERT, balanceUsd: null, priceUsd: 0.005 }).retry === "fresh-authorization", "unreadable balance never claims the wallet is empty");
ok(hintFor({ reason: "unsupported network eip155:1" , network: "eip155:1" }).retry === "other-network", "an unsupported network points at accepts");
ok(hintFor({ reason: "authorization expired (validBefore)" }).retry === "fresh-authorization", "expired -> fresh authorization");
ok(balanceBucket(null) === "unknown" && balanceBucket(0, 0.005) === "zero" && balanceBucket(0.001, 0.005) === "under-price" && balanceBucket(1, 0.005) === "covers-price", "balance buckets for telemetry carry no number");

// noteVerifyFailure + hintForCredential (stubbed balance read, controllable clock)
const SIG = "0x" + "11".repeat(65);
const cred = (nonce, from = PAYER) => ({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: { signature: SIG, authorization: { from, to: "0x000000000000000000000000000000000000dEaD", value: "5000", validAfter: "0", validBefore: "9999999999", nonce } } });
const toHeader = (c) => Buffer.from(JSON.stringify(c)).toString("base64");
const C1 = cred("0x" + "aa".repeat(32));
const K1 = credentialKeyOf(C1);
_testResetForTest();
let t = 1_000_000; const now = () => t;
const noted = await noteVerifyFailure({ paymentPayload: C1, network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now, balanceReader: async () => 0 });
ok(noted.bucket === "zero" && noted.retry === "fund-wallet" && noted.key === K1 && hintForCredential(K1, { now })?.retry === "fund-wallet", "the hook stores the hint under the failed CREDENTIAL's key and reports the bucket");
ok(credentialKeyFromHeader(toHeader(C1)) === K1, "the raw payment header hashes to the same credential key the hook stored under");
ok(credentialKeyOf(cred("0x" + "aa".repeat(32), PAYER.toUpperCase().replace("0X", "0x"))) === K1, "credential key is case-insensitive on the address");
ok(credentialKeyOf(cred("0x" + "bb".repeat(32))) !== K1 && hintForCredential(credentialKeyOf(cred("0x" + "bb".repeat(32))), { now }) === null, "a FRESH authorization from the same wallet is a new key with no inherited hint");
const forged = { ...C1, payload: { ...C1.payload, signature: "0x" + "99".repeat(65) } };
ok(credentialKeyOf(forged) !== K1 && hintForCredential(credentialKeyOf(forged), { now }) === null, "a header naming the same payer with a different signature never sees that payer's hint (no balance oracle by address)");
t += 5 * 60_000 + 1;
ok(hintForCredential(K1, { now }) === null, "a hint expires after five minutes");
ok((await noteVerifyFailure({ payer: "not-an-address", network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now })) === null, "a non-EVM payer gets no balance read and no hint");
let reads = 0;
const C2 = cred("0x" + "cc".repeat(32));
await noteVerifyFailure({ paymentPayload: C2, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", reason: REVERT, priceUsd: 0.005, now, balanceReader: async () => { reads++; return 1; } });
ok(reads === 0 && hintForCredential(credentialKeyOf(C2), { now })?.retry === "fresh-authorization", "a non-Base network never reads the Base balance; the hint still says to sign fresh");

// usdcBalanceOnBase: one multicall eth_call, cache, unreadable -> null
const AGG3 = [{ type: "function", name: "aggregate3", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];
const MC3 = "0xca11bde05977b3631167028862be2a173976ca11";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// A stub Base RPC answering aggregate3 the way Multicall3 does: balanceOf per
// inner call, from a balance table keyed by address (default zero).
const rpcAnswer = (body, table = {}) => {
  const { args } = decodeFunctionData({ abi: AGG3, data: body.params[0].data });
  const result = encodeFunctionResult({ abi: AGG3, functionName: "aggregate3", result: args[0].map((c) => {
    const who = "0x" + c.callData.slice(-40).toLowerCase();
    return { success: c.target.toLowerCase() === USDC, returnData: "0x" + BigInt(table[who] ?? 0).toString(16).padStart(64, "0") };
  }) });
  return { jsonrpc: "2.0", id: body.id, result };
};
_testResetForTest();
let calls = [];
const fetchOk = async (url, init) => { const b = JSON.parse(init.body); calls.push(b); return { json: async () => rpcAnswer(b, { [PAYER]: 1_250_000 }) }; };
const b1 = await usdcBalanceOnBase(PAYER, { fetchImpl: fetchOk, now, rpcUrls: ["https://rpc.test"] });
const b2 = await usdcBalanceOnBase(PAYER, { fetchImpl: fetchOk, now, rpcUrls: ["https://rpc.test"] });
const inner = calls[0] && decodeFunctionData({ abi: AGG3, data: calls[0].params[0].data }).args[0];
ok(b1 === 1.25 && b2 === 1.25 && calls.length === 1 && calls[0].method === "eth_call" && calls[0].params[0].to.toLowerCase() === MC3
  && inner.length === 1 && inner[0].target.toLowerCase() === USDC && inner[0].callData === "0x70a08231" + PAYER.slice(2).padStart(64, "0"),
  "balanceOf(payer) on Base USDC through Multicall3, decoded at 6 decimals, cached for a minute");
ok((await usdcBalanceOnBase(PAYER, { fetchImpl: async () => { throw new Error("rpc down"); }, now: () => t + 120_000, rpcUrls: ["https://rpc.test"] })) === null, "an RPC failure reads as unknown, never zero");
ok(decodeBalanceMulticall(encodeFunctionResult({ abi: AGG3, functionName: "aggregate3", result: [{ success: false, returnData: "0x" }] }), 1)[0] === null, "a failed inner call reads as unknown, never zero");
{
  const urls = baseRpcUrls({ ALCHEMY_API_KEY: "k" });
  ok(urls[0] === "https://mainnet.base.org" && /alchemy/.test(urls[2]) && urls.length === 3, "RPC order: two public endpoints first, Alchemy last (a forged header must not buy a metered read first)");
  ok(baseRpcUrls({ ALCHEMY_API_KEY: "k", AGENT402_BASE_RPC: "http://127.0.0.1:1/rpc" }).join() === "http://127.0.0.1:1/rpc", "an explicit AGENT402_BASE_RPC is used alone, so a stubbed boot never reaches a public node");
  ok(baseRpcUrls({}).length === 2 && baseRpcUrls({})[0] === "https://mainnet.base.org", "with no configuration the read still has a public fallback");
}
// Fallback: the first RPC answers a JSON-RPC rate-limit error, the second answers.
{
  _testResetForTest();
  const seen = [];
  const f = async (url, init) => { seen.push(url); const b = JSON.parse(init.body);
    return { json: async () => (url === "https://a.test" ? { jsonrpc: "2.0", id: 1, error: { code: -32016, message: "over rate limit" } } : rpcAnswer(b, { [PAYER]: 2_000_000 })) }; };
  const v = await usdcBalanceOnBase(PAYER, { fetchImpl: f, now: () => Date.now(), rpcUrls: ["https://a.test", "https://b.test"] });
  ok(v === 2 && seen.join() === "https://a.test,https://b.test", "a rate-limited RPC falls through to the next one inside the same read");
}

// middleware: merge on a 402 that carries the SAME credential only
_testResetForTest();
await noteVerifyFailure({ paymentPayload: C1, network: "eip155:8453", reason: REVERT, priceUsd: 0.005, now: () => Date.now(), balanceReader: async () => 0 });
const mw = verifyHintMiddleware();
const H1 = toHeader(C1);
const mkRes = (status) => { const r = { statusCode: status, headersSent: false, headers: {}, out: null, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.out = b; return this; } }; return r; };
const r1 = mkRes(402); mw({ headers: { "payment-signature": H1 } }, r1, () => {}); r1.json({ x402Version: 2, error: REVERT, accepts: [{ network: "eip155:8453" }] });
ok(r1.out.error === REVERT && r1.out.accepts.length === 1 && r1.out.retry === "fund-wallet" && /holds \$0\.0000/.test(r1.out.hint) && r1.out.payerUsdcOnBase === 0 && r1.headers["Retry-After"] === "60", "a 402 to the retried credential carries error + accepts untouched plus hint, retry, the payer's own balance and Retry-After");
const r2 = mkRes(402); let passed = false; mw({ headers: {} }, r2, () => { passed = true; }); r2.json({ x402Version: 2, accepts: [] });
ok(passed && r2.out.hint === undefined && r2.headers["Retry-After"] === undefined, "a bare 402 (no payment header) is untouched");
const r3 = mkRes(200); mw({ headers: { "payment-signature": H1 } }, r3, () => {}); r3.json({ ok: true });
ok(r3.out.hint === undefined && Object.keys(r3.out).join() === "ok", "a 200 to a paying request is untouched");
const r6 = mkRes(402); mw({ headers: { "payment-signature": toHeader(forged) } }, r6, () => {}); r6.json({ x402Version: 2 });
ok(r6.out.hint === undefined && r6.out.payerUsdcOnBase === undefined, "a forged header naming the same payer gets NO hint and NO balance (the hint is bound to the credential, not the address)");
const r7 = mkRes(402); mw({ headers: { "x-payment": "bm90LWEtcGF5bWVudA" } }, r7, () => {}); r7.json({ x402Version: 2 });
ok(r7.out.hint === undefined, "an undecodable payment header is untouched");
_testResetForTest();
const r5 = mkRes(402); mw({ headers: { "payment-signature": H1 } }, r5, () => {}); r5.json({ x402Version: 2 });
ok(r5.out.hint === undefined, "no remembered failure for this credential -> no hint (never a guess)");

// --- a SETTLEMENT refused on our billing quota names the rail, not the wallet -
// The vendor writes the settle receipt as a PAYMENT-RESPONSE header and then
// `res.status(402).json({})`; before 2026-09-28 that `{}` was all the buyer got.
{
  _testResetForTest();
  const mkSettled = (receipt) => {
    const r = mkRes(402);
    r.getHeader = (k) => (/^payment-response$/i.test(k) && receipt ? Buffer.from(JSON.stringify(receipt)).toString("base64") : undefined);
    return r;
  };
  const ALGO = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
  const req = { headers: { "payment-signature": H1 } };
  const q = mkSettled({ success: false, errorReason: "subcent_quota_exceeded", errorMessage: "subcent_quota_exceeded", network: ALGO, transaction: "" });
  mw(req, q, () => {}); q.json({ altPayment: { protocol: "proof-of-work" } });
  ok(q.out.reason === "facilitator-quota" && q.out.retry === "other-network" && q.out.network === ALGO, `a quota-refused settlement answers reason facilitator-quota, retry other-network, and the network (got ${JSON.stringify({ reason: q.out.reason, retry: q.out.retry })})`);
  ok(/temporarily unavailable/i.test(q.out.error) && /Algorand facilitator/.test(q.out.hint) && /not because of your wallet/.test(q.out.hint) && /Nothing was charged/.test(q.out.hint) && /another network/.test(q.out.hint), `the words name the rail as unavailable, clear the wallet, say nothing was charged and point to the other networks (got: ${q.out.hint})`);
  ok(q.out.altPayment?.protocol === "proof-of-work" && q.headers["Retry-After"] === undefined, "the rest of the body survives, and no Retry-After invites a retry on the same rail");
  ok(req.__paymentRejectReason === "facilitator-quota", "the paywall rollup records the class");
  const g = mkSettled({ success: false, errorReason: "free_tier_exhausted", network: "eip155:43114" });
  mw({ headers: { "payment-signature": H1 } }, g, () => {}); g.json({});
  ok(g.out.reason === "facilitator-quota" && g.out.network === "eip155:43114", "an EVM facilitator's free_tier_exhausted gets the same answer, naming its network id");
  // Control: a buyer-side settle failure is NOT relabelled as ours.
  const f = mkSettled({ success: false, errorReason: "insufficient_funds", network: ALGO });
  mw({ headers: { "payment-signature": H1 } }, f, () => {}); f.json({});
  ok(f.out.reason !== "facilitator-quota" && f.out.retry !== "other-network", "a genuine settle failure (insufficient_funds) is never answered as a facilitator quota");
  const t = mkSettled({ success: false, errorReason: "transaction_failed", errorMessage: "rpc quota exceeded", network: "eip155:43114" });
  mw({ headers: { "payment-signature": H1 } }, t, () => {}); t.json({});
  ok(t.out.reason !== "facilitator-quota", "nor is a payment verdict (transaction_failed) whose message happens to mention a quota");
  _testResetForTest();
}

// BURST (reproduces 2026-09-28: ~30 distinct zero-balance wallets in one
// minute, half read "unknown" because the fifth concurrent read was refused).
// 42 distinct wallets at once now all read, in ONE RPC request.
{
  _testResetForTest();
  const addr = (i) => "0x" + String(i).padStart(40, "0");
  let requests = 0, concurrent = 0, peak = 0;
  const f = async (url, init) => { requests++; concurrent++; peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 30)); concurrent--; const b = JSON.parse(init.body); return { json: async () => rpcAnswer(b) }; };
  const got = await Promise.all(Array.from({ length: 42 }, (_, i) => usdcBalanceOnBase(addr(i + 1), { fetchImpl: f, now: () => Date.now(), rpcUrls: ["https://rpc.test"] })));
  ok(got.every((v) => v === 0), `a burst of 42 distinct zero-balance wallets reads every balance as zero (unknown: ${got.filter((v) => v == null).length})`);
  ok(requests === 1, `and costs one RPC request, not 42 (made ${requests})`);
  ok(_inflightForTest() === 0 && _queuedForTest() === 0, "queue and in-flight count drain after the burst");
  // Past one batch: 250 wallets -> ceil(250/100) requests, never more than the in-flight bound at once.
  _testResetForTest(); requests = 0; peak = 0;
  const many = await Promise.all(Array.from({ length: 250 }, (_, i) => usdcBalanceOnBase(addr(1000 + i), { fetchImpl: f, now: () => Date.now(), rpcUrls: ["https://rpc.test"] })));
  ok(many.every((v) => v === 0) && requests === 3 && peak <= _limitsForTest.MAX_BATCHES_INFLIGHT, `250 wallets read in ${requests} requests with at most ${peak} in flight (bound ${_limitsForTest.MAX_BATCHES_INFLIGHT})`);
}
// BOUNDS that stop this being an amplifier: a stalled RPC never holds a
// caller past the wait, and a flood past the queue cap answers unknown at once.
{
  _testResetForTest();
  const addr = (i) => "0x" + String(i).padStart(40, "0");
  let release; const gate = new Promise((r) => { release = r; });
  let requests = 0;
  const stall = async (url, init) => { requests++; await gate; return { json: async () => rpcAnswer(JSON.parse(init.body)) }; };
  const start = Date.now();
  const flood = Array.from({ length: 500 }, (_, i) => usdcBalanceOnBase(addr(5000 + i), { fetchImpl: stall, now: () => Date.now(), rpcUrls: ["https://rpc.test"] }));
  const extraStart = Date.now();
  const extra = await usdcBalanceOnBase(addr(9999), { fetchImpl: stall, now: () => Date.now(), rpcUrls: ["https://rpc.test"] });
  ok(extra === null && Date.now() - extraStart < 100, "past the queue cap a new wallet reads unknown at once (never an unbounded queue)");
  const r = await Promise.all(flood);
  const took = Date.now() - start;
  ok(r.every((v) => v === null) && took < _limitsForTest.WAIT_MS + 400, `a stalled RPC holds no caller past the wait (${took} ms, bound ${_limitsForTest.WAIT_MS})`);
  ok(requests <= _limitsForTest.MAX_BATCHES_INFLIGHT, `a stalled RPC gets at most ${_limitsForTest.MAX_BATCHES_INFLIGHT} requests however many wallets ask (made ${requests})`);
  release();
  await new Promise((r) => setTimeout(r, 50));
  _testResetForTest();
}

// --- an UNCLASSIFIED refusal is no longer silent to the buyer -------------
// It used to be telemetry only: a developer whose client failed in a way we had
// no name for got an unadorned 402 from the one system that could see exactly
// what they sent. It is also as likely to be our defect as theirs.
{
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const paymentHeader = b64({
    x402Version: 2, scheme: "exact", network: "eip155:8453",
    accepted: { amount: "1000", asset: "0xAAAA" },
    payload: { authorization: { from: "0xF00D", to: "0xBEEF", value: "1000", nonce: "0xdead" }, signature: "0xSIGNATURE" },
  });
  const paymentRequiredHeader = b64({
    x402Version: 2,
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xAAAA", payTo: "0xBEEF", maxTimeoutSeconds: 300, extra: { name: "USD Coin" } }],
  });
  const h = unclassifiedPaymentHint({ paymentHeader, paymentRequiredHeader });
  ok(h && h.reason === "unclassified", "a decodable payment that matches nothing produces a buyer-facing hint");
  ok(/top level: accepted, network, payload, scheme, x402Version/.test(h.detail), "it names the top-level field NAMES the client sent");
  ok(/authorization: from, nonce, to, value/.test(h.detail), "and the authorization field names, sorted");
  ok(/amount, asset, maxTimeoutSeconds, network, payTo, scheme/.test(h.detail), "and what one accepts entry actually carries, so the two can be compared");

  // The rule that makes this safe to print: a payment header is a credential.
  for (const secret of ["0xSIGNATURE", "0xdead", "0xF00D", "0xAAAA", "1000"]) {
    ok(!h.detail.includes(secret), `no VALUE is echoed (${secret})`);
  }
  ok(/the fault may be ours/.test(h.detail), "it invites a report, because an unclassified refusal is as likely to be our defect");

  ok(unclassifiedPaymentHint({ paymentHeader: "not-base64", paymentRequiredHeader }) === null, "an undecodable header is left to the malformed-header class");
  ok(unclassifiedPaymentHint({ paymentHeader, paymentRequiredHeader: null }) === null, "with no advertised requirements there is nothing to compare against, so it stays quiet");
}

// --- the published reason table cannot drift from the classifier ----------
// /x402-test teaches developers this vocabulary. A class the classifier can
// emit and the table does not document is a developer reading a page that does
// not describe the server answering them.
{
  const { readFileSync } = await import("node:fs");
  const { REJECTION_REASONS } = await import("../src/payment-reject.js");
  const src = readFileSync(new URL("../src/payment-reject.js", import.meta.url), "utf8");
  const emitted = new Set([...src.matchAll(/reason:\s*"([a-z-]+)"/g)].map((m) => m[1]));
  const documented = new Set(REJECTION_REASONS.map((r) => r.reason));
  const undocumented = [...emitted].filter((r) => !documented.has(r));
  ok(undocumented.length === 0, `every reason the classifier emits is documented${undocumented.length ? ` - missing: ${undocumented.join(", ")}` : ""}`);
  const phantom = [...documented].filter((r) => !emitted.has(r));
  ok(phantom.length === 0, `and the table documents nothing the classifier cannot emit${phantom.length ? ` - phantom: ${phantom.join(", ")}` : ""}`);
  ok(REJECTION_REASONS.every((r) => typeof r.means === "string" && r.means.length > 30), "each documented reason explains itself in a sentence, not a restated slug");
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
