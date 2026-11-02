#!/usr/bin/env node
// A Tempo seller that answers the paid request with an error: what the buyer
// is told, what stays booked, and whether the router tries the next seller.
// Offline: a stub MPP seller on a local socket, a throwaway signing key that
// builds real pull credentials (an expiring-nonce 0x76 transaction), and an
// injected chain reader, so nothing is spent and no network is touched.
//
//   proof     the credential is unused only when the chain has reached its
//             validBefore and no USDC.e left its signer since it was signed;
//             a debit, an unreadable chain, a chain still short of the expiry,
//             a block window that does not reach back far enough, or a
//             credential we cannot decode is "may have been charged"
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

const scratch = mkdtempSync(join(tmpdir(), "tempo-refusal-proof-"));
process.env.WALLET_DAILY_LEDGER_FILE = join(scratch, "wallet-daily-spend.json");
process.env.OUTBOUND_LEDGER_FILE = join(scratch, "outbound-spend.ndjson");
process.env.X402_INDEX_CRAWL = "off";

(await import("../src/tools/sanctions-kit.js")).__seedPayoutListForTests();
const { payTempo, tempoCredentialVerdict, TEMPO_USDC, TEMPO_CAIP2 } = await import("../src/tempo-buyer.js");
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

/** A real pull credential for the challenge in `res402`: a sender-signed
 *  expiring-nonce Tempo transaction, `validBeforeS` seconds. */
let validBeforeS = Math.floor(Date.now() / 1000) + 25;
const mint = async (res402) => {
  const [ch] = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": res402.headers.get("www-authenticate") }));
  const env = TxEnvelopeTempo.from({ chainId: 4217, calls: [{ to: TEMPO_USDC, data: "0x" }], nonceKey: 2n ** 256n - 1n, nonce: 0n, validBefore: validBeforeS, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, feePayerSignature: null });
  const sig = Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(env), privateKey: PK });
  const signature = TxEnvelopeTempo.serialize(env, { signature: { type: "secp256k1", signature: sig } });
  return Credential.serialize({ challenge: ch, payload: { type: "transaction", signature } });
};

/** A chain stub. `head` is the latest block's timestamp; blocks are one per
 *  second back from block 10000. `logs` answers eth_getLogs. */
const chain = ({ head = () => validBeforeS, logs = () => [], fail = false, sparse = false } = {}) => {
  const calls = [];
  const fn = async (method, params) => {
    calls.push({ method, params });
    if (fail) throw new Error("rpc down");
    if (method === "eth_getBlockByNumber") {
      const tag = params[0];
      const n = tag === "latest" ? 10000 : parseInt(tag, 16);
      // `sparse`: older blocks are newer than they should be (the window
      // would not reach back to the signing time).
      const ts = tag === "latest" ? head() : (sparse ? head() : head() - (10000 - n));
      return { number: "0x" + n.toString(16), timestamp: "0x" + ts.toString(16) };
    }
    if (method === "eth_getLogs") return logs(params[0]);
    throw new Error(`unexpected ${method}`);
  };
  fn.calls = calls;
  return fn;
};

// ---- the verdict itself ----
{
  const res402 = new Response(null, { status: 402, headers: { "www-authenticate": Challenge.serialize(Challenge.from({ realm: "seller.test", method: "tempo", intent: "charge", request: { amount: "2000", currency: TEMPO_USDC, recipient: RECIPIENT, methodDetails: { chainId: 4217 } }, secretKey: "s" })) } });
  validBeforeS = Math.floor(Date.now() / 1000) + 25;
  const cred = await mint(res402);
  const signedAtMs = Date.now();
  const rpc = chain();
  const v = await tempoCredentialVerdict(cred, { signedAtMs, maxWaitMs: 5000, rpcFn: rpc });
  ok(v && v.used === false && v.expired === true, `no transfer from the signer by the expiry block -> unused and expired (got ${JSON.stringify(v)})`);
  const q = rpc.calls.find((c) => c.method === "eth_getLogs")?.params[0];
  ok(q && q.address === TEMPO_USDC && q.topics[0] === TRANSFER_TOPIC && q.topics[1] === "0x" + SIGNER.slice(2).padStart(64, "0") && q.topics[2] == null, "the read is every USDC.e Transfer FROM the credential's own signer, to anyone");
  const fromN = parseInt(q.fromBlock, 16);
  ok(10000 - fromN >= validBeforeS - Math.floor(signedAtMs / 1000), `the window reaches back past the signing time (from block ${fromN})`);
  const debited = await tempoCredentialVerdict(cred, { signedAtMs, maxWaitMs: 5000, rpcFn: chain({ logs: () => [{ topics: [TRANSFER_TOPIC] }] }) });
  ok(debited && debited.used === true, "a transfer from the signer in the window -> used (a concurrent buy reads as used too: the safe direction)");
  ok(await tempoCredentialVerdict(cred, { signedAtMs, maxWaitMs: 5000, rpcFn: chain({ fail: true }) }) === null, "an unreadable chain -> no verdict");
  const t0 = Date.now();
  const early = await tempoCredentialVerdict(cred, { signedAtMs, maxWaitMs: 1200, rpcFn: chain({ head: () => validBeforeS - 5 }) });
  ok(early === null && Date.now() - t0 < 3000, "a chain that has not reached the expiry inside the wait -> no verdict, inside the wait bound");
  ok(await tempoCredentialVerdict(cred, { signedAtMs, maxWaitMs: 5000, rpcFn: chain({ sparse: true }) }) === null, "a block window that does not reach back to the signing time -> no verdict");
  ok(await tempoCredentialVerdict("Payment ZmFrZQ", { signedAtMs, maxWaitMs: 5000, rpcFn: chain() }) === null, "a credential that does not decode -> no verdict");
  ok(await tempoCredentialVerdict(cred, { signedAtMs, maxWaitMs: 0, rpcFn: chain() }) === null, "no wait budget -> no verdict");
  // A sponsored credential (the 0x78 fee-payer envelope viem sends when the
  // challenge sets feePayer) names its sender; it reads the same way.
  const [ch] = Challenge.fromHeadersList(new Headers({ "WWW-Authenticate": res402.headers.get("www-authenticate") }));
  const env = TxEnvelopeTempo.from({ chainId: 4217, calls: [{ to: TEMPO_USDC, data: "0x" }], nonceKey: 2n ** 256n - 1n, nonce: 0n, validBefore: validBeforeS, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, feePayerSignature: null });
  const sig = Secp256k1.sign({ payload: TxEnvelopeTempo.getSignPayload(env), privateKey: PK });
  const sponsored = Credential.serialize({ challenge: ch, payload: { type: "transaction", signature: TxEnvelopeTempo.serialize(env, { format: "feePayer", sender: SIGNER, signature: { type: "secp256k1", signature: sig } }) } });
  const rpc2 = chain();
  const vs = await tempoCredentialVerdict(sponsored, { signedAtMs, maxWaitMs: 5000, rpcFn: rpc2 });
  ok(vs && vs.used === false && rpc2.calls.find((c) => c.method === "eth_getLogs")?.params[0].topics[1] === "0x" + SIGNER.slice(2).padStart(64, "0"), "a sponsored 0x78 credential is read against its sender");
  // With the spending wallet configured, a credential naming another sender
  // is not ours to judge: no verdict.
  process.env.TEMPO_UPSTREAM_BUYER_KEY = "0x" + "77".repeat(32);
  ok(await tempoCredentialVerdict(sponsored, { signedAtMs, maxWaitMs: 5000, rpcFn: chain() }) === null, "a credential whose sender is not the configured spending wallet -> no verdict");
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
const buy = (path, extra = {}) => payTempo(`${base}${path}`, { method: "POST", body: { url: "https://example.com" }, maxAtomic: 5000n, trusted: true, timeoutMs: 8000, createCredential: mint, proof: async () => ({ count: 4000, payers: 50 }), memoizeDelivery: true, refusalProof: proofWith(), refusalMaxWaitMs: 5000, ...extra }).then(() => null, (e) => e);
const origin = base;

{
  validBeforeS = Math.floor(Date.now() / 1000) + 25;
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
  ok(e && e.committed === true && e.signedUsd === 0.002 && /^Seller failed after payment \(HTTP 400\)/.test(e.message) && !rpcNow.calls.length, "a 400 carrying a receipt is after payment, committed, and the chain is not read");
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
    payExternal: (url, opts) => payTempo(url, { ...opts, trusted: true, memoizeDelivery: true, createCredential: mint, proof: async () => ({ count: 4000, payers: 50 }), refusalProof: proofWith() }),
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
  validBeforeS = Math.floor(Date.now() / 1000) + 25;
  rpcNow = chain();
  mode = { status: 400, receipt: false };
  const { e } = await route([cand("/bad"), cand("/good")]);
  ok(e && e.committed !== true && /failed: Seller refused the request before taking payment \(HTTP 400\)/.test(e.message), `ROUTER: a proven-unused refusal reaches the buyer as a refusal before payment (got "${e?.message}")`);
  ok(!hits.get("/good:paid"), "ROUTER: ...and, like a Solana refusal, ends the request after the wait (no second seller)");
  ok(near(tempoDay(), 0), `ROUTER: ...and nothing stays booked on the Tempo day (got $${tempoDay()})`);
}

console.warn = origWarn;
srv.close();
console.log(`\n${pass} passed`);
process.exit(0);
