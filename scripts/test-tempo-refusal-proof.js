#!/usr/bin/env node
// A Tempo seller that answers the paid request with an error: what the buyer
// is told, what stays booked, and whether the router tries the next seller.
// Offline: a stub MPP seller on a local socket, a throwaway signing key that
// builds real pull credentials (an expiring-nonce 0x76 transaction), and an
// injected chain reader, so nothing is spent and no network is touched.
//
//   proof     the credential is unused only when the chain has reached its
//             validBefore, no USDC.e left its signer from a head read before
//             it was sent, its own transaction has no receipt, and the head
//             block reads back unchanged; a debit, a receipt, an unreadable
//             chain, a head that changed, a chain still short of the expiry,
//             an expiry past the wait, no start block, a sponsored
//             credential, or one we cannot decode is "may have been charged"
//   budget    the wait is what is left of the caller's bound after the
//             purchase; an expiry past it is not polled for
//   signBy    a buyer authorization past its signing bound signs nothing
//   buyer     a proven-unused refusal says so, carries no committed stamp,
//             records no outbound debt and no delivery strike; every other
//             failure after the credential left is booked exactly as before
//   router    a Tempo candidate that spent nothing before its credential left
//             falls through to the next candidate; a committed or waited-on
//             failure does not
import "./lib/file-mode.js";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const scratch = mkdtempSync(join(tmpdir(), "tempo-refusal-proof-"));
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";

(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const { payTempo, tempoCredentialVerdict, tempoHeadNumber, TEMPO_USDC, TEMPO_CAIP2 } = await import("../src/tempo-buyer.js");
const { sellerDeliveryMemoEntries, __resetSellerDeliveryFailuresForTest } = await import("../src/x402-buyer.js");
const guard = await import("../src/external-spend-guard.js");
const { buildRouteExecuteTool, EXEC_TIERS } = await import("../src/tools/route-execute.js");
const { Challenge, Credential } = await import("mppx");
const { TxEnvelopeTempo } = await import("ox/tempo");
const { Secp256k1, Address } = await import("ox");

let pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { console.error("FAIL:", m); process.exit(1); } };
const origWarn = console.warn;
console.warn = () => {};

const PK = Secp256k1.randomPrivateKey();
const SIGNER = Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey: PK })).toLowerCase();
const RECIPIENT = "0x" + "11".repeat(20);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A real pull credential for the challenge in `res402`: a complete
 *  sender-signed expiring-nonce Tempo transaction (0x76, no fee payer), so
 *  its hash is fixed, expiring at `validBeforeS`. */
let validBeforeS = Math.floor(Date.now() / 1000) + 3;
let lastTxHash = null;
const mint = async (res402) => {
  const [ch] = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": res402.headers.get("www-authenticate") }));
  const env = TxEnvelopeTempo.from({ chainId: 4217, calls: [{ to: TEMPO_USDC, data: "0x" }], nonceKey: 2n ** 256n - 1n, nonce: 0n, validBefore: validBeforeS, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  const sig = Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(env), privateKey: PK });
  const signature = TxEnvelopeTempo.serialize(env, { signature: { type: "secp256k1", signature: sig } });
  lastTxHash = TxEnvelopeTempo.hash(TxEnvelopeTempo.deserialize(signature)).toLowerCase();
  return Credential.serialize({ challenge: ch, payload: { type: "transaction", signature } });
};

/** A chain stub. `head` is the latest block's timestamp; blocks are one per
 *  second back from block 10000. `logs` answers eth_getLogs, `receipt`
 *  eth_getTransactionReceipt. `reorg`: block 10000 reads back with another
 *  hash after the log read. `headAt`: what eth_blockNumber answers. */
const START = 9990;
const blockHash = (n, salt = "") => "0x" + createHash("sha256").update(`${n}${salt}`).digest("hex");
const chain = ({ head = () => validBeforeS, logs = () => [], fail = false, receipt = () => null, receiptFail = false, reorg = false, headAt = () => START } = {}) => {
  const calls = [];
  const fn = async (method, params) => {
    calls.push({ method, params });
    if (fail) throw new Error("rpc down");
    if (method === "eth_blockNumber") return "0x" + headAt().toString(16);
    if (method === "eth_getBlockByNumber") {
      const tag = params[0];
      const n = tag === "latest" ? 10000 : parseInt(tag, 16);
      const ts = head() - (10000 - n);
      const reread = tag !== "latest" && calls.some((c) => c.method === "eth_getLogs");
      return { number: "0x" + n.toString(16), timestamp: "0x" + ts.toString(16), hash: blockHash(n, reorg && reread ? "b" : "") };
    }
    if (method === "eth_getLogs") return logs(params[0]);
    if (method === "eth_getTransactionReceipt") { if (receiptFail) throw new Error("receipt read failed"); return receipt(params[0]); }
    throw new Error(`unexpected ${method}`);
  };
  fn.calls = calls;
  return fn;
};
const headWith = (rpcFn) => () => tempoHeadNumber({ rpcFn });

// ---- the verdict itself ----
{
  const res402 = new Response(null, { status: 402, headers: { "www-authenticate": Challenge.serialize(Challenge.from({ realm: "seller.test", method: "tempo", intent: "charge", request: { amount: "2000", currency: TEMPO_USDC, recipient: RECIPIENT, methodDetails: { chainId: 4217 } }, secretKey: "s" })) } });
  validBeforeS = Math.floor(Date.now() / 1000) + 3;
  const cred = await mint(res402);
  const W = 60_000;
  const rpc = chain();
  const v = await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: rpc });
  ok(v && v.used === false && v.expired === true, `no transfer from the signer by the expiry block, no receipt, the head unchanged -> unused and expired (got ${JSON.stringify(v)})`);
  const q = rpc.calls.find((c) => c.method === "eth_getLogs")?.params[0];
  ok(q && q.address === TEMPO_USDC && q.topics[0] === TRANSFER_TOPIC && q.topics[1] === "0x" + SIGNER.slice(2).padStart(64, "0") && q.topics[2] == null, "the read is every USDC.e Transfer FROM the credential's own signer, to anyone");
  const fromN = parseInt(q.fromBlock, 16);
  ok(fromN < START && START - fromN <= 10 && parseInt(q.toBlock, 16) === 10000, `the window starts a few blocks before the head read ahead of the send and ends at the expiry head (from block ${fromN})`);
  const rc = rpc.calls.find((c) => c.method === "eth_getTransactionReceipt");
  ok(rc && rc.params[0].toLowerCase() === lastTxHash, "the credential's own transaction hash is looked up for a receipt");
  const order = rpc.calls.map((c) => c.method);
  const lastBlockRead = order.lastIndexOf("eth_getBlockByNumber");
  ok(lastBlockRead > order.indexOf("eth_getLogs") && rpc.calls[lastBlockRead].params[0] === "0x" + (10000).toString(16), "the head block is read again by number after the log read");
  // CHAIN-ANCHORED WINDOW: no wall clock decides where it starts. A transfer
  // in the block right after the head read is inside it.
  const atStart = await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain({ logs: (f) => (parseInt(f.fromBlock, 16) <= START + 1 ? [{ topics: [TRANSFER_TOPIC] }] : []) }) });
  ok(atStart && atStart.used === true, "a transfer in the block after the recorded head is in the window -> used");
  ok(await tempoCredentialVerdict(cred, { maxWaitMs: W, rpcFn: chain() }) === null, "no recorded start block -> no verdict");
  ok(await tempoCredentialVerdict(cred, { fromBlock: 10_050, maxWaitMs: W, rpcFn: chain() }) === null, "a start block past the expiry head -> no verdict");
  const debited = await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain({ logs: () => [{ topics: [TRANSFER_TOPIC] }] }) });
  ok(debited && debited.used === true, "a transfer from the signer in the window -> used (a concurrent buy reads as used too: the safe direction)");
  // EMPTY LOGS ARE NOT ENOUGH ON THEIR OWN.
  const mined = await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain({ receipt: (h) => (String(h).toLowerCase() === lastTxHash ? { status: "0x1" } : null) }) });
  ok(mined && mined.used === true, "empty logs but a receipt for the credential's own transaction -> used");
  ok(await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain({ receiptFail: true }) }) === null, "a receipt read that fails -> no verdict");
  ok(await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain({ receipt: () => undefined }) }) === null, "a receipt read with no answer -> no verdict");
  ok(await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain({ reorg: true }) }) === null, "the head block reading back with another hash after the log read -> no verdict");
  ok(await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain({ fail: true }) }) === null, "an unreadable chain -> no verdict");
  const t0 = Date.now();
  const early = await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: 1200, rpcFn: chain({ head: () => validBeforeS - 5 }) });
  ok(early === null && Date.now() - t0 < 3000, "a chain that has not reached the expiry inside the wait -> no verdict, inside the wait bound");
  // AN EXPIRY PAST THE WAIT IS NOT POLLED FOR: no head can reach it in time.
  validBeforeS = Math.floor(Date.now() / 1000) + 25;
  const late = await mint(res402);
  const rpcLate = chain({ head: () => validBeforeS - 20 });
  const t1 = Date.now();
  const vLate = await tempoCredentialVerdict(late, { fromBlock: START, maxWaitMs: 16_000, rpcFn: rpcLate });
  ok(vLate === null && Date.now() - t1 < 500 && rpcLate.calls.length === 0, `an expiry 25 s out against a 16 s wait -> no verdict at once, no chain read (${Date.now() - t1} ms, ${rpcLate.calls.length} calls)`);
  validBeforeS = Math.floor(Date.now() / 1000) + 3;
  ok(await tempoCredentialVerdict("Payment ZmFrZQ", { fromBlock: START, maxWaitMs: W, rpcFn: chain() }) === null, "a credential that does not decode -> no verdict");
  ok(await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: 0, rpcFn: chain() }) === null, "no wait budget -> no verdict");
  // A sponsored credential (the 0x78 fee-payer envelope viem sends when the
  // challenge sets feePayer, or a 0x76 awaiting a fee payer) gets its final
  // hash from the fee payer's co-signature, so its receipt cannot be looked
  // up: no verdict, and the failure stays committed.
  const [ch] = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": res402.headers.get("www-authenticate") }));
  const env = TxEnvelopeTempo.from({ chainId: 4217, calls: [{ to: TEMPO_USDC, data: "0x" }], nonceKey: 2n ** 256n - 1n, nonce: 0n, validBefore: validBeforeS, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, feePayerSignature: null });
  const sig = Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(env), privateKey: PK });
  const sponsored = Credential.serialize({ challenge: ch, payload: { type: "transaction", signature: TxEnvelopeTempo.serialize(env, { format: "feePayer", sender: SIGNER, signature: { type: "secp256k1", signature: sig } }) } });
  const awaiting = Credential.serialize({ challenge: ch, payload: { type: "transaction", signature: TxEnvelopeTempo.serialize(env, { signature: { type: "secp256k1", signature: sig } }) } });
  ok(await tempoCredentialVerdict(sponsored, { fromBlock: START, maxWaitMs: W, rpcFn: chain() }) === null, "a sponsored 0x78 credential -> no verdict (its final hash is the fee payer's)");
  ok(await tempoCredentialVerdict(awaiting, { fromBlock: START, maxWaitMs: W, rpcFn: chain() }) === null, "a 0x76 credential awaiting a fee payer -> no verdict");
  // With the spending wallet configured, a credential naming another sender
  // is not ours to judge: no verdict.
  process.env.TEMPO_UPSTREAM_BUYER_KEY = "0x" + "77".repeat(32);
  ok(await tempoCredentialVerdict(cred, { fromBlock: START, maxWaitMs: W, rpcFn: chain() }) === null, "a credential whose sender is not the configured spending wallet -> no verdict");
  delete process.env.TEMPO_UPSTREAM_BUYER_KEY;
}

// ---- payTempo against a stub seller ----
const challenge = () => Challenge.serialize(Challenge.from({
  realm: "seller.test", method: "tempo", intent: "charge", expires: new Date(Date.now() + 60_000),
  request: { amount: "2000", currency: TEMPO_USDC, recipient: RECIPIENT, methodDetails: { chainId: 4217, feePayer: true } }, secretKey: "seller-secret",
}));
let mode = { status: 400, receipt: false };
const hits = new Map();
const srv = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const path = req.url;
    const paid = /^Payment /.test(req.headers.authorization || "");
    hits.set(`${path}:${paid ? "paid" : "bare"}`, (hits.get(`${path}:${paid ? "paid" : "bare"}`) || 0) + 1);
    if (path.startsWith("/slowdown")) { setTimeout(() => { res.writeHead(503); res.end("{}"); }, 2500); return; }
    if (path.startsWith("/down")) { res.writeHead(503); return res.end("{}"); }
    if (!paid) { res.writeHead(402, { "www-authenticate": challenge() }); return res.end("{}"); }
    if (path.startsWith("/slow400")) { setTimeout(() => { res.writeHead(400, { "content-type": "application/json" }); res.end("{}"); }, 1500); return; }
    if (path.startsWith("/good")) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"answer":42}'); }
    const h = { "content-type": "application/json" };
    if (mode.receipt) h["payment-receipt"] = "x";
    res.writeHead(mode.status, h);
    res.end('{"error":"bad request"}');
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const outbound = () => existsSync(process.env.OUTBOUND_LEDGER_FILE) ? readFileSync(process.env.OUTBOUND_LEDGER_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
let rpcNow = chain();
const proofWith = () => (cred, o) => tempoCredentialVerdict(cred, { ...o, rpcFn: rpcNow });
const buy = (path, extra = {}) => payTempo(`${base}${path}`, { method: "POST", body: { url: "https://example.com" }, maxAtomic: 5000n, trusted: true, timeoutMs: 8000, createCredential: mint, proof: async () => ({ count: 4000, payers: 50 }), memoizeDelivery: true, refusalProof: proofWith(), refusalHead: () => tempoHeadNumber({ rpcFn: rpcNow }), refusalMaxWaitMs: 5000, ...extra }).then(() => null, (e) => e);
const origin = base;

{
  validBeforeS = Math.floor(Date.now() / 1000) + 3;
  __resetSellerDeliveryFailuresForTest();
  rpcNow = chain();
  const before = outbound().length;
  mode = { status: 400, receipt: false };
  const e = await buy("/bad");
  ok(e && /refused the request before taking payment \(HTTP 400\); the credential expired unused, nothing charged/.test(e.message) && !/after payment/.test(e.message), `a proven-unused 400 says the seller refused before payment (got "${e?.message}")`);
  ok(e.committed === false && e.signedUsd === undefined && e.refused === true, "...and carries no committed stamp and no signed amount");
  ok(outbound().length === before, "...and records no outbound payment");
  mode = { status: 502, receipt: false };
  const e5 = await buy("/bad5");
  ok(e5 && e5.committed === false && /before taking payment \(HTTP 502\)/.test(e5.message) && sellerDeliveryMemoEntries().length === 0 && outbound().length === before, "a proven-unused 502 is a refusal: no delivery strike, no outbound row");
  mode = { status: 402, receipt: false };
  const e2 = await buy("/bad402");
  ok(e2 && e2.committed === false && /^Seller refused the payment \(HTTP 402\); the credential expired unused, nothing charged/.test(e2.message), "a proven-unused 402 reads as the payment refused, nothing charged");
}
// POSSIBLY PAID: booked exactly as before.
for (const [label, setup] of [
  ["a debit from the signer", () => { rpcNow = chain({ logs: () => [{ topics: [TRANSFER_TOPIC] }] }); }],
  ["an unreadable chain", () => { rpcNow = chain({ fail: true }); }],
  ["no wait budget", () => { rpcNow = chain(); }],
]) {
  setup();
  __resetSellerDeliveryFailuresForTest();
  for (const status of [400, 500]) {
    mode = { status, receipt: false };
    const before = outbound().length;
    const e = await buy(`/maybe${status}`, label === "no wait budget" ? { refusalMaxWaitMs: 0 } : {});
    ok(e && e.committed === true && e.signedUsd === 0.002, `${label}, HTTP ${status}: committed with the $0.002 signed (got ${e?.committed}, ${e?.signedUsd})`);
    ok(new RegExp(`after the payment was sent \\(HTTP ${status}\\); it may have been charged`).test(e.message) && !/refused/.test(e.message), `${label}, HTTP ${status}: the message says the payment may have been taken (got "${e.message}")`);
    const rows = outbound().slice(before);
    if (status >= 500) ok(rows.length === 1 && rows[0].result === "undelivered" && rows[0].chain === "tempo" && sellerDeliveryMemoEntries().some((m) => m.chain === "tempo" && m.origin === origin), `${label}, HTTP 500: one undelivered outbound row and a first delivery strike, as before`);
    else ok(rows.length === 0, `${label}, HTTP 400 with no receipt: no outbound row, as before`);
  }
}
{
  // A receipt on the error: the seller says it took the payment. No chain wait.
  rpcNow = chain();
  mode = { status: 400, receipt: true };
  const e = await buy("/receipted");
  ok(e && e.committed === true && e.signedUsd === 0.002 && /^Seller failed after payment \(HTTP 400\)/.test(e.message) && !rpcNow.calls.some((c) => c.method !== "eth_blockNumber"), "a 400 carrying a receipt is after payment, committed, and the chain is not read past the head");
}
{
  // THE WAIT IS WHAT IS LEFT, not the whole bound again: a seller that took
  // 1.5 s to refuse leaves the verdict at most the rest of a 4.5 s bound,
  // which a credential expiring 6 s out cannot fit.
  validBeforeS = Math.floor(Date.now() / 1000) + 6;
  rpcNow = chain();
  const seen = [];
  const e = await buy("/slow400", { refusalMaxWaitMs: 4500, refusalProof: (cred, o) => { seen.push(o); return tempoCredentialVerdict(cred, { ...o, rpcFn: rpcNow }); } });
  ok(seen.length === 1 && seen[0].maxWaitMs <= 4500 - 1400, `the verdict waits only what the purchase left of the bound (got ${seen[0]?.maxWaitMs} ms of 4500 after a 1.5 s seller)`);
  ok(seen[0].fromBlock === START, `the verdict's window starts at the head read before the send (got ${seen[0]?.fromBlock})`);
  ok(e && e.committed === true, "...and an expiry past what is left is no verdict: committed");
}
{
  // NO RECORDED HEAD, NO RELEASE: an unreadable head before the send leaves
  // no window start, so the refusal stays committed and the chain is not read.
  validBeforeS = Math.floor(Date.now() / 1000) + 3;
  rpcNow = chain();
  let proofCalls = 0;
  mode = { status: 400, receipt: false };
  const e = await buy("/nohead", { refusalHead: async () => { throw new Error("head unreadable"); }, refusalProof: async () => { proofCalls++; return { used: false, expired: true }; } });
  ok(e && e.committed === true && e.signedUsd === 0.002 && proofCalls === 0 && /it may have been charged/.test(e.message), `an unreadable head before the send keeps the refusal committed without a verdict (got ${e?.committed}, ${proofCalls} verdicts)`);
}
{
  // signBy: an EVM buyer routed to a Tempo seller whose own authorization
  // can no longer settle signs nothing.
  let minted = 0;
  const counting = async (r) => { minted++; return mint(r); };
  const e = await buy("/good", { createCredential: counting, signBy: Date.now() - 1 });
  ok(e && e.statusCode === 504 && /Nothing was signed/.test(e.message) && minted === 0 && e.committed === undefined && !hits.get("/good:paid"), `a signBy already past refuses before signing, uncommitted (got ${e?.statusCode} "${e?.message}", ${minted} minted)`);
  const fine = await buy("/good", { createCredential: counting, signBy: Date.now() + 60_000 });
  ok(fine === null && minted === 1, "a signBy still ahead signs and buys as before");
}

// ---- route-execute ----
guard.__reset();
const near = (a, b) => Math.abs(a - b) < 1e-9;
const tempoDay = () => guard.walletDailySpentUsd("tempo");
const cand = (path) => ({ seller: `${base}${path}`, slug: path.slice(1), url: `${base}${path}`, method: "POST", price: "$0.002", priceUsd: 0.002, networks: [TEMPO_CAIP2], wire: "mpp" });
let ipSeq = 0;
const route = async (list) => {
  const tool = buildRouteExecuteTool({
    getCatalog: () => ({}), tier: EXEC_TIERS[0],
    resolveExternal: async () => list,
    payExternal: (url, opts) => payTempo(url, { ...opts, trusted: true, memoizeDelivery: true, createCredential: mint, proof: async () => ({ count: 4000, payers: 50 }), refusalProof: proofWith(), refusalHead: () => tempoHeadNumber({ rpcFn: rpcNow }) }),
    externalEnabled: () => true, externalChains: () => ["tempo"],
  });
  const req = { mppTempoCredential: true, headers: {}, header: () => undefined, ip: `198.51.100.${++ipSeq}` };
  try { return { r: await tool.handler({ task: "t", include: "external", params: {} }, req) }; } catch (e) { return { e }; }
};
{
  validBeforeS = Math.floor(Date.now() / 1000) + 25;
  rpcNow = chain();
  hits.clear();
  const { r, e } = await route([cand("/down"), cand("/good")]);
  ok(r && r.result?.answer === 42 && hits.get("/good:paid") === 1, `ROUTER: a Tempo seller that failed before any credential left -> the next candidate serves${e ? ` (threw ${e.message})` : ""}`);
}
{
  // A Tempo buyer's own window bounds the fallthrough: with under 4 s of it
  // left after the first seller, no second seller is started.
  guard.__reset(); hits.clear();
  process.env.SOR_TEMPO_BUDGET_MS = "6000";
  const { e } = await route([cand("/slowdown"), cand("/good")]);
  delete process.env.SOR_TEMPO_BUDGET_MS;
  ok(e && !hits.get("/good:paid") && !hits.get("/good:bare"), `ROUTER: a pre-payment failure that leaves under 4 s of a Tempo buyer's window starts no second seller (got "${e?.message}")`);
}
{
  guard.__reset(); hits.clear();
  rpcNow = chain({ fail: true });
  mode = { status: 400, receipt: false };
  const { e } = await route([cand("/maybe"), cand("/good")]);
  ok(e && e.committed === true && !hits.get("/good:paid") && /External seller ".*" failed: Seller failed after the payment was sent \(HTTP 400\); it may have been charged/.test(e.message), `ROUTER: a possibly-paid Tempo failure tries no other seller and says it may have been charged (got "${e?.message}")`);
  ok(near(tempoDay(), 0.002), `ROUTER: ...and keeps the $0.002 signed booked on the Tempo day (got $${tempoDay()})`);
}
{
  guard.__reset(); hits.clear();
  validBeforeS = Math.floor(Date.now() / 1000) + 3;
  rpcNow = chain();
  mode = { status: 400, receipt: false };
  const { e } = await route([cand("/bad"), cand("/good")]);
  ok(e && e.committed !== true && /failed: Seller refused the request before taking payment \(HTTP 400\)/.test(e.message), `ROUTER: a proven-unused refusal reaches the buyer as a refusal before payment (got "${e?.message}")`);
  ok(!hits.get("/good:paid"), "ROUTER: ...and, like a Solana refusal, ends the request after the wait (no second seller)");
  ok(near(tempoDay(), 0), `ROUTER: ...and nothing stays booked on the Tempo day (got $${tempoDay()})`);
}
{
  // A stock mppx credential expires 25 s after signing, past a Tempo buyer's
  // 16 s budget: the refusal is not waited on at all, and stays committed.
  guard.__reset(); hits.clear();
  validBeforeS = Math.floor(Date.now() / 1000) + 25;
  rpcNow = chain({ head: () => validBeforeS - 20 });
  mode = { status: 400, receipt: false };
  const t0 = Date.now();
  const { e } = await route([cand("/bad"), cand("/good")]);
  ok(e && e.committed === true && Date.now() - t0 < 3000 && !rpcNow.calls.some((c) => c.method !== "eth_blockNumber"), `ROUTER: an expiry past the Tempo buyer's budget ends at once, committed, with no chain wait (${Date.now() - t0} ms, ${rpcNow.calls.length} calls)`);
  ok(near(tempoDay(), 0.002), `ROUTER: ...and keeps the $0.002 signed booked (got $${tempoDay()})`);
}

console.warn = origWarn;
srv.close();
console.log(`\n${pass} passed`);
process.exit(0);
