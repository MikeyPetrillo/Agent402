#!/usr/bin/env node
// A facilitator that broadcasts the buyer's transfer and then answers
// `settlement_pending` ("transaction did not confirm in time: context deadline
// exceeded") with the transaction hash used to leave a buyer who paid with a
// 402, and the late-settlement book then found the transfer mined seconds
// later and booked a refund. src/pending-settle.js reads that transaction's
// receipt for a bounded time first, and serves the answer only when the
// receipt proves the transfer is this payment's.
//
// Part 1, offline units: the classifier, which failures it applies to, the
// receipt verdict, the bounds (the wait, the CDN answer window, validBefore),
// a buyer gone before the first byte, and the failure monitor's forgiveness.
// Part 2 boots a PAID server against a stub facilitator and a stub RPC (port
// 0) and sends real paid requests through the middleware:
//   receipt appears within the wait (thrown 5xx and graceful) -> 200 with
//     PAYMENT-RESPONSE naming the tx, one sale at the paid price, nothing in
//     the late-settlement book or refunds, the facilitator's pending 5xx
//     answers not counted as upstream failures, and a resend of the same
//     payment answered from the idempotency cache
//   the breaker counts recovered calls as settled (a failure blocks the next)
//   never mined / reverted / another payTo / short / no authorization log /
//   RPC errors -> 402, booked in the late-settlement book as before
//   client gone during settle -> not served, booked
//   a genuine 5xx with no tx -> 402, the chain is never read, still counted
//
//   node scripts/test-pending-settle.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";

let pass = 0;
const procs = [];
let stubs = [];
const serverLog = [];
const DIR = mkdtempSync(join(tmpdir(), "a402-pending-"));
const cleanup = () => { for (const p of procs) p.kill("SIGKILL"); for (const s of stubs) s.close(); try { rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } };
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-40)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const txOf = (s) => "0x" + createHash("sha256").update(String(s)).digest("hex");
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x00000000000000000000000000000000000000ee";
const PENDING_MSG = "transaction did not confirm in time: context deadline exceeded";

// ============================================================ part 1: units
{
  const ps = await import("../src/pending-settle.js");
  const { createToolFailureMonitor } = await import("../src/tool-failure-monitor.js");
  const TX = txOf("unit");
  const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const payer = "0x" + "a1".repeat(20), nonce = word(77);
  const pend = (extra = {}) => ({ errorReason: "settlement_pending", errorMessage: PENDING_MSG, transaction: TX, ...extra });

  ok(ps.pendingSettleTxOf(pend()) === TX.toLowerCase(), "settlement_pending with a tx is pending");
  ok(ps.pendingSettleTxOf({ errorReason: "unexpected_settle_error", errorMessage: PENDING_MSG, transaction: TX }) === TX.toLowerCase(), "the timeout words with a tx read as pending");
  ok(ps.pendingSettleTxOf(pend({ transaction: "" })) === null, "pending with no tx is not handled");
  ok(ps.pendingSettleTxOf({ errorReason: "invalid_exact_evm_payload_signature", errorMessage: PENDING_MSG, transaction: TX }) === null, "a payment verdict is never pending");
  ok(ps.pendingSettleTxOf({ errorReason: "unexpected_settle_error", errorMessage: "boom", transaction: TX }) === null, "another failure naming a tx is not pending");
  ok(ps.pendingSettleWaitMs({}) === 12_000 && ps.pendingSettleWaitMs({ PENDING_SETTLE_RECEIPT_WAIT_MS: "999999" }) === 30_000 && ps.pendingSettleWaitMs({ PENDING_SETTLE_RECEIPT_WAIT_MS: "0" }) === 0, "the wait defaults to 12 s, is capped at 30 s, and 0 turns it off");

  const rq = (network = "eip155:8453") => ({ scheme: "exact", network, asset: ASSET, payTo: PAY_TO, amount: "5000" });
  const ctxOf = ({ network, error = pend(), req = null, validBefore = String(Math.floor(Date.now() / 1000) + 300), auth = true } = {}) => ({
    requirements: rq(network), error,
    paymentPayload: { payload: auth ? { authorization: { from: payer, to: PAY_TO, value: "5000", validAfter: "0", validBefore, nonce } } : { permit2Authorization: { from: payer } } },
    ...(req ? { transportContext: { request: { adapter: { req } } } } : {}),
  });
  const rpcFor = (n) => (n.startsWith("eip155:") ? "http://rpc.invalid" : null);
  ok(ps.pendingSettleApplies(ctxOf(), { rpcFor }), "applies on Base with an RPC");
  ok(!ps.pendingSettleApplies(ctxOf({ network: "eip155:4663" }), { rpcFor }), "never on Robinhood 4663 (its own outage path)");
  ok(!ps.pendingSettleApplies(ctxOf({ network: "eip155:5042" }), { rpcFor }), "never on Arc (its own pending book)");
  ok(!ps.pendingSettleApplies(ctxOf({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), { rpcFor }), "never off EVM");
  ok(!ps.pendingSettleApplies(ctxOf({ auth: false }), { rpcFor }), "never on a payload without an EIP-3009 authorization");
  ok(!ps.pendingSettleApplies(ctxOf(), { rpcFor: () => null }), "never without a configured RPC");

  const receipt = ({ status = "0x1", to = PAY_TO, value = 5000n, authLog = true } = {}) => ({
    status, transactionHash: TX, blockNumber: "0x10",
    logs: [
      ...(authLog ? [{ address: ASSET, topics: [AUTH_USED, topic(payer), nonce], data: "0x" }] : []),
      { address: ASSET, topics: [TRANSFER, topic(payer), topic(to)], data: word(value) },
    ],
  });
  const facts = { asset: ASSET, payer, nonce, payTo: PAY_TO, amount: "5000" };
  ok(ps.judgePendingReceipt(receipt(), facts).ours, "a mined transfer of the price to our payTo, using this authorization, is ours");
  ok(!ps.judgePendingReceipt(receipt({ status: "0x0" }), facts).ours, "a reverted receipt is not");
  ok(!ps.judgePendingReceipt(receipt({ to: OTHER }), facts).ours, "a transfer to another payTo is not");
  ok(!ps.judgePendingReceipt(receipt({ value: 4999n }), facts).ours, "a short transfer is not");
  ok(!ps.judgePendingReceipt(receipt({ authLog: false }), facts).ours, "a transfer that did not use this authorization is not");

  // The bounded read, against an in-process RPC.
  const fetchWith = (answer) => async (_u, init) => {
    const { method } = JSON.parse(init.body);
    const r = await answer(method);
    if (r instanceof Error) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message: r.message } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: r }) };
  };
  const unsold = async () => null;
  let reads = 0;
  const t0 = Date.now();
  let r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => { reads++; return Date.now() - t0 > 250 ? receipt() : null; }), waitMs: 3000, pollMs: 100, saleByTx: unsold });
  ok(r.recovered && r.result.transaction === TX.toLowerCase() && r.result.payer === payer && reads >= 2, `a receipt that appears within the wait recovers (${reads} reads)`);
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 3000, pollMs: 100, saleByTx: async () => ({ id: 1 }) });
  ok(!r.recovered && /recorded sale/.test(r.reason), "a tx already in the sales ledger is not recovered");
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 3000, pollMs: 100, saleByTx: async () => { throw new Error("db down"); } });
  ok(!r.recovered && /sales ledger/.test(r.reason), "an unreadable sales ledger fails closed");
  let t = Date.now();
  r = await ps.confirmPendingSettle(ctxOf(), { rpcFor, fetchImpl: fetchWith(() => new Error("upstream down")), waitMs: 600, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered && /could not read the chain/.test(r.reason) && Date.now() - t < 1500, `RPC errors until the deadline are refused inside the bound (${Date.now() - t} ms)`);
  // CDN answer window shorter than the wait.
  t = Date.now();
  r = await ps.confirmPendingSettle(ctxOf({ req: { cdnSyncDeadlineMs: Date.now() + ps.CDN_MARGIN_MS + 400 } }), { rpcFor, fetchImpl: fetchWith(() => null), waitMs: 10_000, pollMs: 100, saleByTx: unsold, clientGone: () => false });
  ok(!r.recovered && Date.now() - t < 1500, `the wait ends inside the CDN answer window, less its margin (${Date.now() - t} ms of a 10 s wait)`);
  r = await ps.confirmPendingSettle(ctxOf({ req: { cdnSyncDeadlineMs: Date.now() + 1000 } }), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 10_000, pollMs: 100, saleByTx: unsold, clientGone: () => false });
  ok(!r.recovered && /no time left/.test(r.reason), "a CDN window already inside its margin reads nothing");
  // The authorization's validBefore bounds the wait.
  t = Date.now();
  r = await ps.confirmPendingSettle(ctxOf({ validBefore: String(Math.floor(Date.now() / 1000) + 1) }), { rpcFor, fetchImpl: fetchWith(() => null), waitMs: 10_000, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered && Date.now() - t < 2500, `the wait ends at the authorization's validBefore (${Date.now() - t} ms)`);
  // A buyer gone before the first byte is not served, even with the proof.
  reads = 0;
  r = await ps.confirmPendingSettle(ctxOf({ req: {} }), { rpcFor, fetchImpl: fetchWith(() => { reads++; return receipt(); }), waitMs: 3000, pollMs: 100, saleByTx: unsold, clientGone: () => true });
  ok(!r.recovered && /buyer left/.test(r.reason) && reads === 0, "a buyer gone before the first byte is not served");
  let goneNow = false;
  r = await ps.confirmPendingSettle(ctxOf({ req: {} }), { rpcFor, fetchImpl: fetchWith(() => { goneNow = true; return receipt(); }), waitMs: 3000, pollMs: 100, saleByTx: unsold, clientGone: () => goneNow });
  ok(!r.recovered && /buyer left/.test(r.reason), "a buyer who leaves during the read is not served");
  r = await ps.confirmPendingSettle(ctxOf({ error: { errorReason: "unexpected_settle_error", transaction: "" } }), { rpcFor, fetchImpl: fetchWith(() => receipt()), waitMs: 3000, pollMs: 100, saleByTx: unsold });
  ok(!r.recovered, "a failure that is not pending is never read");

  // Noting pending 5xx answers, and the monitor's forgiveness.
  const payload = {};
  const client = { settle: async () => { throw Object.assign(new Error("settlement_pending"), { statusCode: 500, ...pend() }); } };
  ps.notePendingSettleAnswers(client, "https://fac.example/x402");
  for (let i = 0; i < 2; i++) { try { await client.settle(payload, {}); } catch { /* expected */ } }
  const graceful = { settle: async () => ({ success: false, ...pend() }) };
  ps.notePendingSettleAnswers(graceful, "https://fac.example/x402");
  const payload2 = {};
  await graceful.settle(payload2, {});
  const notes = ps.takePendingAnswers(payload);
  ok(notes.length === 2 && notes.every((n) => n.host === "fac.example") && ps.takePendingAnswers(payload).length === 0 && ps.takePendingAnswers(payload2).length === 0, "each pending 5xx answer is noted once on its payload; a graceful one is not (the meter counted it ok)");
  const m = createToolFailureMonitor({});
  m.registerUpstreamHost("https://fac.example/x402", "facilitator:fac.example");
  const at = Date.now();
  m.noteUpstream("fac.example", "s5xx", { origin: "outside", at });
  m.noteUpstream("fac.example", "s5xx", { origin: "outside", at });
  ok(m.forgiveUpstream("fac.example", "s5xx", { at }) === true, "forgiveUpstream moves one s5xx to ok");
  const row = (await m.report()).upstreams.find((u) => u.upstream === "facilitator:fac.example");
  ok(row?.hour?.outside?.s5xx === 1 && row?.hour?.outside?.ok === 1, `one counted failure stays (${JSON.stringify(row?.hour?.outside)})`);
  ok(m.forgiveUpstream("fac.example", "s5xx", { at }) === true && m.forgiveUpstream("fac.example", "s5xx", { at }) === false, "never forgives more than was counted");
}

// ============================================================ part 2: booted
const [PORT, FAC_PORT, RPC_PORT] = await getFreePorts(3);
const LATE = join(DIR, "late.json");
const LEDGER = join(DIR, "sales.db");
const OP = "op-" + Math.random().toString(36).slice(2);

let settleMode = "pending";   // pending | pending-graceful | plain-5xx
let rpcMode = "mined";        // mined | never | reverted | elsewhere | short | noauth | error
let mineAfterMs = 1200;
let settleDelayMs = 0;
let settles = 0, receiptReads = 0;
const payments = new Map();   // nonce(lower) -> payment
const minedAt = new Map();    // tx -> ms

const reply = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

const fac = createServer(async (req, res) => {
  const parsed = await readBody(req);
  const auth = parsed?.paymentPayload?.payload?.authorization || {};
  if (req.url === "/supported") return reply(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
  if (req.url === "/verify") return reply(res, 200, { isValid: true, payer: auth.from });
  if (req.url === "/settle") {
    settles++;
    if (settleDelayMs) await sleep(settleDelayMs);
    const p = payments.get(String(auth.nonce || "").toLowerCase());
    if (settleMode === "plain-5xx") return reply(res, 502, { success: false, errorReason: "unexpected_settle_error", errorMessage: "upstream failure", transaction: "", network: "eip155:8453", payer: auth.from });
    if (p && !minedAt.has(p.tx)) minedAt.set(p.tx, Date.now() + mineAfterMs);
    const body = { success: false, errorReason: "settlement_pending", errorMessage: PENDING_MSG, transaction: p?.tx || "", network: "eip155:8453", payer: auth.from };
    return reply(res, settleMode === "pending-graceful" ? 200 : 500, body);
  }
  return reply(res, 404, {});
});
const rpcSrv = createServer(async (req, res) => {
  const parsed = await readBody(req);
  const rpcReply = (result) => reply(res, 200, { jsonrpc: "2.0", id: parsed.id ?? 1, result });
  if (parsed.method === "eth_getTransactionReceipt") {
    receiptReads++;
    if (rpcMode === "error") return reply(res, 200, { jsonrpc: "2.0", id: parsed.id ?? 1, error: { code: -32603, message: "upstream timeout" } });
    const tx = parsed.params?.[0];
    const p = [...payments.values()].find((x) => x.tx === tx);
    if (!p || rpcMode === "never" || !(minedAt.get(tx) <= Date.now())) return rpcReply(null);
    const to = rpcMode === "elsewhere" ? OTHER : PAY_TO;
    const value = rpcMode === "short" ? BigInt(p.amount) - 1n : BigInt(p.amount);
    return rpcReply({
      status: rpcMode === "reverted" ? "0x0" : "0x1", transactionHash: tx, blockNumber: "0x10",
      logs: [
        ...(rpcMode === "noauth" ? [] : [{ address: p.asset, topics: [AUTH_USED, topic(p.payer), p.nonce], data: "0x" }]),
        { address: p.asset, topics: [TRANSFER, topic(p.payer), topic(to)], data: word(value) },
      ],
    });
  }
  if (parsed.method === "eth_blockNumber") return rpcReply("0x10");
  if (parsed.method === "eth_call") return rpcReply(word(6));
  return rpcReply(null);
});
stubs = [fac, rpcSrv];
await new Promise((r) => fac.listen(FAC_PORT, "127.0.0.1", r));
await new Promise((r) => rpcSrv.listen(RPC_PORT, "127.0.0.1", r));

const proc = spawn("node", ["src/server.js"], {
  env: {
    ...process.env, PORT: String(PORT), FREE_MODE: "",
    WALLET_ADDRESS: PAY_TO, NETWORK: "base", PAYMENT_NETWORKS: "base",
    FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${RPC_PORT}/rpc`,
    EVM_RPC_8453: `http://127.0.0.1:${RPC_PORT}/rpc`, PAYMENT_SETTLE_FALLBACK: "",
    PENDING_SETTLE_RECEIPT_WAIT_MS: "4000", PENDING_SETTLE_POLL_MS: "400",
    GATEWAY_SETTLE_BREAKER_MAX: "1", GATEWAY_SETTLE_BREAKER_MIN_FAIL_SHARE: "0",
    LATE_SETTLE_FILE: LATE, REFUND_DB_DIR: DIR, SALES_LEDGER_DB: LEDGER, STATS_ALLOW_EPHEMERAL: "true", STATE_DATABASE_URL: "",
    AGENT402_OPERATOR_TOKEN: OP,
    REDIS_URL: "", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
    X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
procs.push(proc);
const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) if (line.trim()) serverLog.push(line.slice(0, 400)); if (serverLog.length > 200) serverLog.splice(0, serverLog.length - 200); };
proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);
const BASE = `http://127.0.0.1:${PORT}`;
let booted = false;
for (let i = 0; i < 120 && !booted; i++) { try { booted = (await fetch(`${BASE}/health`)).ok; } catch { /* booting */ } if (!booted) await sleep(500); }
if (!booted) fail("server did not boot");

const ROUTES = { hash: { path: "/api/hash", body: JSON.stringify({ text: "x" }) }, usage: { path: "/api/my-usage", body: JSON.stringify({ days: 1 }) } };
const accepted = {};
let n = 0;
async function newPayment(route, { payer = null } = {}) {
  const R = ROUTES[route];
  if (!accepted[route]) {
    const r = await fetch(`${BASE}${R.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: R.body });
    ok(r.status === 402, `unpaid ${R.path} -> 402 (got ${r.status})`);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
    accepted[route] = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    ok(!!accepted[route], `${R.path} offers exact on Base`);
  }
  const a = accepted[route];
  n++;
  const nonce = word(BigInt(Date.now()) * 1000n + BigInt(n));
  const p = { route, payer: payer || "0x" + (0xb000 + n).toString(16).padStart(40, "0"), nonce, asset: a.asset, amount: a.amount, tx: txOf(`${nonce}-${n}`) };
  payments.set(nonce.toLowerCase(), p);
  p.cred = Buffer.from(JSON.stringify({
    x402Version: 2, resource: a.resource, accepted: a,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: p.payer, to: a.payTo, value: a.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce } },
  })).toString("base64");
  return p;
}
async function send(p, { abortAfterMs = 0 } = {}) {
  const R = ROUTES[p.route];
  const t0 = Date.now();
  const ctl = new AbortController();
  if (abortAfterMs) setTimeout(() => ctl.abort(), abortAfterMs);
  try {
    const r = await fetch(`${BASE}${R.path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": p.cred }, body: R.body, signal: ctl.signal });
    const body = await r.text();
    let receipt = null;
    const hdr = r.headers.get("payment-response");
    if (hdr) { try { receipt = JSON.parse(Buffer.from(hdr, "base64").toString("utf-8")); } catch { /* */ } }
    return { status: r.status, receipt, body, ms: Date.now() - t0, replayed: r.headers.get("x-replayed-answer") === "1" };
  } catch (e) {
    return { status: 0, aborted: true, ms: Date.now() - t0, error: String(e?.name || e) };
  }
}
const Database = (await import("better-sqlite3")).default;
const salesFor = (tx) => { if (!existsSync(LEDGER)) return []; const db = new Database(LEDGER, { readonly: true, fileMustExist: true }); try { return db.prepare("SELECT slug, price_usd, network, payer, tx FROM sales WHERE lower(tx) = lower(?)").all(tx); } finally { db.close(); } };
const refundsFor = (tx) => { const f = join(DIR, "agent402-refunds.db"); if (!existsSync(f)) return []; const db = new Database(f, { readonly: true, fileMustExist: true }); try { return db.prepare("SELECT * FROM refunds").all().filter((r) => JSON.stringify(r).toLowerCase().includes(tx.toLowerCase())); } catch { return []; } finally { db.close(); } };
const lateHas = (tx) => existsSync(LATE) && readFileSync(LATE, "utf8").toLowerCase().includes(tx.toLowerCase());
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };
const facUp = async () => {
  const r = await fetch(`${BASE}/__operator/tool-failures.json`, { headers: { "X-Operator-Token": OP } });
  const j = await r.json();
  return j.upstreams.find((u) => u.upstream === `facilitator:127.0.0.1:${FAC_PORT}`)?.hour?.outside || { s5xx: 0, ok: 0 };
};

try {
  // --- recovered: thrown 5xx pending, receipt mined within the wait -------
  settleMode = "pending"; rpcMode = "mined"; mineAfterMs = 1200;
  const before5xx = (await facUp()).s5xx;
  let p = await newPayment("hash");
  let s0 = settles, r0 = receiptReads;
  let r = await send(p);
  ok(r.status === 200 && r.receipt?.success === true && r.receipt?.transaction === p.tx.toLowerCase(), `pending 5xx, mined within the wait -> 200 with PAYMENT-RESPONSE naming the tx (status ${r.status}, ${r.ms} ms)`);
  ok(receiptReads - r0 >= 2 && settles - s0 === 2, `the receipt was polled (${receiptReads - r0} reads) after the facilitator's answer and its single retry (${settles - s0} settles)`);
  ok(serverLog.some((l) => l.includes(`recovered eip155:8453 settlement after a pending answer: tx ${p.tx.toLowerCase()}`)), "the recovery is logged with its tx");
  ok(await waitFor(() => salesFor(p.tx).length === 1), `one sale booked for the tx (${salesFor(p.tx).length})`);
  const sale = salesFor(p.tx)[0];
  const listUsd = Number(accepted.hash.amount) / 1e6;
  ok(sale && Math.abs(sale.price_usd - listUsd) < 1e-9 && sale.network === "base" && sale.payer === p.payer.toLowerCase(), `the sale is booked at the paid price (${sale?.price_usd} vs ${listUsd}, ${sale?.network})`);
  await sleep(300);
  ok(!lateHas(p.tx) && refundsFor(p.tx).length === 0, "nothing in the late-settlement book or the refund ledger");
  const after5xx = (await facUp()).s5xx;
  ok(after5xx === before5xx, `the facilitator's pending 5xx answers that recovered are not counted as failures (s5xx ${before5xx} -> ${after5xx})`);
  // Idempotency: the same signed payment again is answered from the first answer.
  s0 = settles;
  const again = await send(p);
  ok(again.status === 200 && again.replayed && again.body === r.body && settles === s0, `a resend of the recovered payment is answered from its first answer, never settled again (status ${again.status}, replayed ${again.replayed}, settles +${settles - s0})`);
  ok(salesFor(p.tx).length === 1, "still one sale for the tx");

  // --- recovered: graceful 200 pending ------------------------------------
  settleMode = "pending-graceful";
  p = await newPayment("hash");
  r = await send(p);
  ok(r.status === 200 && r.receipt?.transaction === p.tx.toLowerCase(), `graceful pending answer, mined within the wait -> 200 (status ${r.status})`);

  // --- the breaker counts a recovered call as settled ---------------------
  settleMode = "pending";
  const P = "0x" + "c1".repeat(20);
  for (let i = 0; i < 3; i++) {
    p = await newPayment("usage", { payer: P });
    r = await send(p);
    ok(r.status === 200 && r.receipt?.transaction === p.tx.toLowerCase(), `breaker (max 1 failure): recovered call ${i + 1} from one wallet -> 200 (status ${r.status})`);
  }
  // The control: one unrecovered pending call does block that wallet's next.
  const Q = "0x" + "d1".repeat(20);
  rpcMode = "never";
  p = await newPayment("usage", { payer: Q });
  r = await send(p);
  ok(r.status === 402, `control: an unrecovered pending call -> 402 (status ${r.status})`);
  rpcMode = "mined";
  p = await newPayment("usage", { payer: Q });
  s0 = settles;
  r = await send(p);
  ok(r.status === 429 && settles === s0, `control: that wallet's next call is refused by the breaker (status ${r.status})`);

  // --- not proven: today's path -------------------------------------------
  for (const mode of ["never", "reverted", "elsewhere", "short", "noauth", "error"]) {
    rpcMode = mode; settleMode = "pending";
    p = await newPayment("hash");
    r0 = receiptReads;
    const s5 = (await facUp()).s5xx;
    r = await send(p);
    ok(r.status === 402 && r.receipt?.success !== true, `${mode}: 402, not served (status ${r.status}, ${r.ms} ms, ${receiptReads - r0} receipt reads)`);
    ok((await facUp()).s5xx === s5 + 2, `${mode}: the facilitator's two pending 5xx answers stay counted`);
    ok(r.ms < 4000 + 2 * 20_000, `${mode}: answered inside the bound`);
    ok(await waitFor(() => lateHas(p.tx)), `${mode}: booked in the late-settlement book as before`);
    ok(salesFor(p.tx).length === 0, `${mode}: no sale`);
  }
  rpcMode = "never";
  const t0 = Date.now();
  p = await newPayment("hash");
  await send(p);
  ok(Date.now() - t0 < 4000 + 3000, `never mined: the wait ends at PENDING_SETTLE_RECEIPT_WAIT_MS (${Date.now() - t0} ms for 4000 ms)`);

  // --- client gone during the settle -------------------------------------
  rpcMode = "mined"; mineAfterMs = 0; settleDelayMs = 1200;
  p = await newPayment("hash");
  r = await send(p, { abortAfterMs: 500 });
  settleDelayMs = 0;
  ok(r.aborted, "the buyer hung up while the facilitator was settling");
  ok(await waitFor(() => lateHas(p.tx), 8000), "client gone: the tx is booked in the late-settlement book as before");
  ok(salesFor(p.tx).length === 0, "client gone: not served, no sale");
  ok(serverLog.some((l) => l.includes("pending settle not recovered: the buyer left")), "client gone: the refusal names the reason");

  // --- a genuine 5xx with no tx: unchanged --------------------------------
  settleMode = "plain-5xx"; rpcMode = "mined";
  const s5Before = (await facUp()).s5xx;
  p = await newPayment("hash");
  r0 = receiptReads;
  r = await send(p);
  ok(r.status === 402 && receiptReads === r0, `a 5xx with no tx -> 402 and the chain is never read (status ${r.status}, reads ${receiptReads - r0})`);
  ok((await facUp()).s5xx > s5Before, "a genuine 5xx stays counted against the facilitator");
  await sleep(200);
  ok(!lateHas(p.tx), "a 5xx with no tx books nothing");

  console.log(`\nOK: ${pass} passed, 0 failed`);
} catch (e) {
  fail(`unexpected: ${e.stack || e}`);
}
cleanup();
process.exit(0);
