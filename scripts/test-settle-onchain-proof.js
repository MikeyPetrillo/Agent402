#!/usr/bin/env node
// A facilitator that broadcasts a transferWithAuthorization and then answers
// the same /settle "authorization nonce already submitted; transaction already
// on-chain" leaves a buyer who paid holding a 402. src/settle-onchain-proof.js
// recovers that settlement, and only when the chain proves the transfer is
// THIS request's: the AuthorizationUsed(payer, nonce) log on the asset, in a
// successful transaction that moved at least the price from the payer to our
// payTo, mined no earlier than this request's payment was first seen, not a
// recorded sale, with this request holding the authorization's claim and
// claiming the tx (src/settlement-claims.js). The same words come back for a
// REPLAY of a payload that already settled; that must never be served twice.
//
// Boots PAID servers against a stub facilitator and a stub RPC and sends real
// paid requests through the middleware:
//   proof found                          -> 200 + PAYMENT-RESPONSE naming the tx
//   the same, thrown as a non-2xx        -> 200
//   log indexed only on a later poll     -> 200
//   nonce spent paying someone else      -> 402
//   short transfer / reverted / RPC down -> 402
//   any other settle error               -> 402, the chain is never read
//   tx mined before the request arrived  -> 402
//   a replay of a payload that settled   -> refused before the facilitator
//   two concurrent replays               -> at most one 200
//   a replay racing an original settle   -> only the original answers
//   a tx already in the sales ledger     -> 402 (fresh boot: no claims held)
// With REDIS_URL set (CI's redis step) the concurrent cases also run across
// TWO servers sharing that Redis; under CI a missing REDIS_URL is a failure.
//
//   node scripts/test-settle-onchain-proof.js
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/test-settle-onchain-proof.js
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePorts } from "./lib/free-port.js";

const REDIS_URL = (process.env.REDIS_URL || "").trim();
const [PORT_A, PORT_B, FAC_PORT] = await getFreePorts(3);
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x00000000000000000000000000000000000000ee";
const AUTH_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ON_CHAIN = "authorization nonce already submitted; transaction already on-chain";
const DIR = mkdtempSync(join(tmpdir(), "a402-onchain-"));
const LEDGER = join(DIR, "sales.db");

let pass = 0, facilitator = null;
const procs = new Map(); // port -> child
const serverLog = [];
const cleanup = () => { for (const p of procs.values()) p.kill("SIGKILL"); facilitator?.close(); try { rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } };
const fail = (m) => { console.error(`FAIL - ${m}`); for (const l of serverLog.slice(-30)) console.error("  server:", l); cleanup(); process.exit(1); };
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else fail(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const txOf = (nonce) => "0x" + createHash("sha256").update(String(nonce)).digest("hex");

if (process.env.CI && !REDIS_URL) fail("CI must run this with REDIS_URL (the cross-replica half is not optional there)");

// --- The claim layer on its own ------------------------------------------
// The server's replay guard (src/replay-guard.js) refuses most replays before
// the paywall, so a booted server cannot show what the settlement claims do
// by themselves. Here the claim hooks and the recovery decision run against
// a fake resource server: each "request" is its own req object, as two
// requests (or two replicas) would be. With REDIS_URL set the claims go
// through Redis, and the local state is dropped between requests so only the
// shared store can answer.
{
  const claims = await import("../src/settlement-claims.js");
  const { recoverAlreadyOnChain } = await import("../src/settle-onchain-proof.js");
  const hooks = { beforeVerify: [], beforeSettle: [], afterSettle: [], settleFailure: [] };
  const fake = {
    onBeforeVerify: (f) => hooks.beforeVerify.push(f), onBeforeSettle: (f) => hooks.beforeSettle.push(f),
    onAfterSettle: (f) => hooks.afterSettle.push(f), onSettleFailure: (f) => hooks.settleFailure.push(f),
  };
  claims.registerSettlementClaimHooks(fake);
  claims.registerSettlementClaimRelease(fake);
  const NET = "eip155:8453";
  const ctxFor = (nonce, req = {}) => ({
    transportContext: { request: { adapter: { req } } },
    requirements: { network: NET, scheme: "exact" },
    paymentPayload: { payload: { authorization: { nonce, from: "0x" + "a1".repeat(20) } } },
  });
  const otherReplica = () => { if (REDIS_URL) claims.__resetSettlementClaims(); };
  const run = async (list, ctx) => { let out; for (const f of list) { const r = await f(ctx); if (r !== undefined) out = r; } return out; };
  const uniq = () => word(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const provedTx = (tx) => async () => ({ proven: true, transaction: tx, payer: "0x" + "a1".repeat(20) });
  const unsold = async () => null;

  // A second request with the same authorization is refused before settle.
  let nonce = uniq();
  const a = ctxFor(nonce), b = ctxFor(nonce);
  await run(hooks.beforeVerify, a); await run(hooks.beforeVerify, b);
  ok((await run(hooks.beforeSettle, a)) === undefined, "claims: the first request to reach settle proceeds");
  otherReplica();
  const refusal = await run(hooks.beforeSettle, b);
  ok(refusal?.abort === true && refusal.reason === claims.DUPLICATE_AUTHORIZATION, `claims: a second request with the same authorization is aborted before the facilitator (${refusal?.reason})`);
  // ...and cannot recover the original's transaction either.
  otherReplica();
  let rb = await recoverAlreadyOnChain(b, { prove: provedTx("0x" + "c1".repeat(32)), saleByTx: unsold });
  ok(!rb.recovered && /another request owns this authorization/.test(rb.reason), `claims: the replay's recovery is refused (${rb.reason})`);
  // The original settles normally; a later replay still cannot recover.
  await run(hooks.afterSettle, { ...a, result: { success: true, transaction: "0x" + "c1".repeat(32), network: NET } });
  otherReplica();
  const c = ctxFor(nonce);
  await run(hooks.beforeVerify, c);
  ok((await run(hooks.beforeSettle, c))?.abort === true, "claims: after the original settled, the same authorization is still refused");

  // A failed settle nobody recovered releases the authorization for a retry.
  nonce = uniq();
  const d = ctxFor(nonce), e = ctxFor(nonce);
  await run(hooks.beforeVerify, d); await run(hooks.beforeSettle, d);
  await run(hooks.settleFailure, { ...d, error: new Error("insufficient_funds") });
  otherReplica();
  await run(hooks.beforeVerify, e);
  ok((await run(hooks.beforeSettle, e)) === undefined, "claims: after an unrecovered failure, a retry of the authorization proceeds");

  // Recovery: the holder recovers once; the tx cannot be served twice.
  const txR = "0x" + "d1".repeat(32);
  let rr = await recoverAlreadyOnChain(e, { prove: provedTx(txR), saleByTx: unsold });
  ok(rr.recovered && rr.result.transaction === txR, "claims: the authorization's holder recovers its own transaction");
  nonce = uniq();
  const f = ctxFor(nonce);
  await run(hooks.beforeVerify, f); await run(hooks.beforeSettle, f);
  otherReplica();
  rr = await recoverAlreadyOnChain(f, { prove: provedTx(txR), saleByTx: unsold });
  ok(!rr.recovered && /already served this transaction/.test(rr.reason), `claims: a transaction already served is never recovered again (${rr.reason})`);
  // A recorded sale refuses even with no claim held.
  nonce = uniq();
  const g = ctxFor(nonce);
  await run(hooks.beforeVerify, g); await run(hooks.beforeSettle, g);
  rr = await recoverAlreadyOnChain(g, { prove: provedTx("0x" + "e1".repeat(32)), saleByTx: async () => ({ id: 1 }) });
  ok(!rr.recovered && /already a recorded sale/.test(rr.reason), `claims: a transaction in the sales ledger is refused (${rr.reason})`);
  // The proof is asked for "no earlier than first seen".
  let asked = null;
  await recoverAlreadyOnChain(g, { prove: async (o) => { asked = o.notBeforeMs; return { proven: false, reason: "x" }; }, saleByTx: unsold });
  ok(typeof asked === "number" && asked <= Date.now() && asked > Date.now() - 60_000, "claims: the proof is bound to the time this request's payment was first seen");
  // No stamp, no recovery.
  rr = await recoverAlreadyOnChain(ctxFor(uniq()), { prove: provedTx("0x" + "f1".repeat(32)), saleByTx: unsold });
  ok(!rr.recovered, `claims: a request with no first-seen stamp never recovers (${rr.reason})`);
  if (REDIS_URL) { const { closeSharedRedis } = await import("../src/shared-limit.js"); await closeSharedRedis(); }
}

// Stub state.
let settleMode = "on-chain";    // on-chain | on-chain-thrown | other | ok | first-wins
let rpcMode = "proof";          // proof | late | elsewhere | short | reverted | down
let minedMode = "now";          // now | before
let settleDelayMs = 0;
let settles = 0, rpcCalls = 0, logCalls = 0;
const payments = new Map();     // nonce(lower) -> { payer, asset, amount, tx }
const settledNonces = new Set();

const infoFor = (nonce) => payments.get(String(nonce).toLowerCase());
const rpcAnswer = (method, params) => {
  if (method === "eth_blockNumber") return "0x1000";
  if (method === "eth_getBlockByNumber") {
    const s = Math.floor(Date.now() / 1000) - (minedMode === "before" ? 120 : 0);
    return { number: params[0], timestamp: "0x" + s.toString(16) };
  }
  if (method === "eth_getLogs") {
    logCalls++;
    const f = params[0];
    const p = infoFor(f.topics?.[2]);
    if (!p || f.topics?.[0] !== AUTH_USED || f.topics?.[1] !== topic(p.payer)) return [];
    if (rpcMode === "late" && logCalls < 2) return [];
    return [{ address: p.asset, topics: [AUTH_USED, topic(p.payer), f.topics[2]], transactionHash: p.tx, blockNumber: "0xfff", data: "0x" }];
  }
  if (method === "eth_getTransactionReceipt") {
    const p = [...payments.values()].reverse().find((x) => x.tx === params[0]);
    if (!p) return null;
    const to = rpcMode === "elsewhere" ? OTHER : PAY_TO;
    const value = rpcMode === "short" ? BigInt(p.amount) - 1n : BigInt(p.amount);
    return {
      status: rpcMode === "reverted" ? "0x0" : "0x1", transactionHash: p.tx, blockNumber: "0xfff",
      logs: [
        { address: p.asset, topics: [AUTH_USED, topic(p.payer), p.nonce], data: "0x" },
        { address: p.asset, topics: [TRANSFER, topic(p.payer), topic(to)], data: word(value) },
      ],
    };
  }
  return null;
};

facilitator = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
    const reply = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    let parsed = {}; try { parsed = JSON.parse(body || "{}"); } catch { /* */ }
    const auth = parsed?.paymentPayload?.payload?.authorization || {};
    const payer = auth.from;
    if (req.url === "/supported") return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} });
    if (req.url === "/verify") return reply(200, { isValid: true, payer });
    if (req.url === "/settle") {
      settles++;
      if (settleDelayMs) await sleep(settleDelayMs);
      const n = String(auth.nonce || "").toLowerCase();
      const success = () => { settledNonces.add(n); return reply(200, { success: true, transaction: infoFor(n)?.tx, network: "eip155:8453", payer }); };
      const onChain = (status = 200) => reply(status, { success: false, errorReason: "invalid_payload", errorMessage: ON_CHAIN, transaction: "", network: "eip155:8453", payer });
      if (settleMode === "ok") return success();
      if (settleMode === "first-wins") return settledNonces.has(n) ? onChain() : success();
      if (settleMode === "other") return reply(200, { success: false, errorReason: "invalid_payload", errorMessage: "authorization signature invalid", transaction: "", network: "eip155:8453", payer });
      if (settleMode === "on-chain-thrown") return onChain(400);
      return onChain();
    }
    if (req.url === "/rpc") {
      rpcCalls++;
      if (rpcMode === "down") return reply(503, { error: "down" });
      return reply(200, { jsonrpc: "2.0", id: parsed.id ?? 1, result: rpcAnswer(parsed.method, parsed.params || []) });
    }
    return reply(404, {});
  });
});
await new Promise((r) => facilitator.listen(FAC_PORT, "127.0.0.1", r));

async function boot(port) {
  const proc = spawn("node", ["src/server.js"], {
    env: {
      ...process.env, PORT: String(port), FREE_MODE: "",
      WALLET_ADDRESS: PAY_TO, NETWORK: "base", PAYMENT_NETWORKS: "base",
      FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`, AGENT402_BASE_RPC: `http://127.0.0.1:${FAC_PORT}/rpc`,
      EVM_RPC_8453: `http://127.0.0.1:${FAC_PORT}/rpc`, PAYMENT_SETTLE_FALLBACK: "",
      SALES_LEDGER_DB: LEDGER, STATS_ALLOW_EPHEMERAL: "true", STATE_DATABASE_URL: "",
      REDIS_URL, CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "", MPP_SECRET_KEY: "",
      X402_INDEX_CRAWL: "off", MPP_INDEX_CRAWL: "off", MONITOR_SCHEDULER: "off", FREE_ALERTS: "off", FOLLOWUPS: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keepLog = (chunk) => { for (const line of String(chunk).split("\n")) { if (line.trim()) serverLog.push(`[${port}] ${line.slice(0, 400)}`); } if (serverLog.length > 120) serverLog.splice(0, serverLog.length - 120); };
  proc.stdout.on("data", keepLog); proc.stderr.on("data", keepLog);
  procs.set(port, proc);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* booting */ } await sleep(500); }
  fail(`server on ${port} did not boot`);
}
async function stop(port) {
  const p = procs.get(port);
  if (!p) return;
  p.kill("SIGTERM");
  await new Promise((r) => { p.once("exit", r); setTimeout(r, 8000); });
  procs.delete(port);
}

const TOOL = { path: "/api/hash", body: JSON.stringify({ text: "x" }) };
let accepted = null, n = 0;
async function newPayment(base, { tx = null } = {}) {
  if (!accepted) {
    const r = await fetch(`${base}${TOOL.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: TOOL.body });
    ok(r.status === 402, `unpaid ${TOOL.path} -> 402 (got ${r.status})`);
    const req402 = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf-8"));
    accepted = (req402.accepts || []).find((a) => a.network === "eip155:8453" && a.scheme === "exact");
    ok(!!accepted, "offers exact on Base");
  }
  n++;
  const nonce = word(1000 + n + Math.floor(Math.random() * 1e9) * 1000);
  const p = { payer: "0x" + (0xa000 + n).toString(16).padStart(40, "0"), nonce, asset: accepted.asset, amount: accepted.amount, tx: tx || txOf(nonce) };
  payments.set(nonce.toLowerCase(), p);
  p.cred = Buffer.from(JSON.stringify({
    x402Version: 2, resource: accepted.resource, accepted,
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: p.payer, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce } },
  })).toString("base64");
  return p;
}
async function send(base, p) {
  const t0 = Date.now();
  const r = await fetch(`${base}${TOOL.path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": p.cred }, body: TOOL.body });
  const body = Buffer.from(await r.arrayBuffer()).toString("utf8");
  let receipt = null;
  const hdr = r.headers.get("payment-response");
  if (hdr) { try { receipt = JSON.parse(Buffer.from(hdr, "base64").toString("utf-8")); } catch { /* */ } }
  return { status: r.status, receipt, ms: Date.now() - t0, body, replayed: r.headers.get("x-replayed-answer") === "1" };
}
async function one(base, label, opts) {
  const p = await newPayment(base, opts);
  const before = settles; logCalls = 0; rpcCalls = 0;
  const r = await send(base, p);
  ok(settles === before + 1, `${label}: settled exactly once (${settles - before})`);
  return { ...r, p };
}

const A = `http://127.0.0.1:${PORT_A}`, Bsrv = `http://127.0.0.1:${PORT_B}`;
try {
  await boot(PORT_A);

  // --- The genuine case and the proof rules ------------------------------
  settleMode = "on-chain"; rpcMode = "proof"; minedMode = "now";
  let r = await one(A, "proof");
  ok(r.status === 200 && r.receipt?.success === true && r.receipt?.transaction === r.p.tx, `proof found -> 200 with PAYMENT-RESPONSE naming the tx (status ${r.status}, tx ${String(r.receipt?.transaction).slice(0, 12)})`);
  ok(serverLog.some((l) => l.includes(`recovered eip155:8453 settlement from chain proof: tx ${r.p.tx}`)), "the recovery is logged with its tx");
  const soldTx = r.p.tx;

  settleMode = "on-chain-thrown";
  r = await one(A, "proof, thrown");
  ok(r.status === 200 && r.receipt?.transaction === r.p.tx, `the same error as a non-2xx settle answer -> 200 (status ${r.status})`);

  settleMode = "on-chain"; rpcMode = "late";
  r = await one(A, "late index");
  ok(r.status === 200 && r.receipt?.transaction === r.p.tx && logCalls >= 2, `log indexed only on a later poll -> 200 (status ${r.status}, getLogs ${logCalls})`);

  rpcMode = "elsewhere";
  r = await one(A, "nonce spent elsewhere");
  ok(r.status === 402, `nonce spent by a transfer to someone else -> 402 (status ${r.status})`);
  rpcMode = "short";
  r = await one(A, "short");
  ok(r.status === 402, `transfer short of the price -> 402 (status ${r.status})`);
  rpcMode = "reverted";
  r = await one(A, "reverted");
  ok(r.status === 402, `reverted transaction -> 402 (status ${r.status})`);
  rpcMode = "down";
  r = await one(A, "rpc down");
  ok(r.status === 402 && r.ms < 20_000 && rpcCalls >= 2, `RPC down -> 402 inside the bound (status ${r.status}, ${r.ms} ms, ${rpcCalls} RPC tries)`);
  settleMode = "other"; rpcMode = "proof";
  r = await one(A, "other error");
  ok(r.status === 402 && rpcCalls === 0, `another settle error -> 402 and the chain is never read (status ${r.status}, RPC calls ${rpcCalls})`);

  // --- Replays -------------------------------------------------------------
  settleMode = "on-chain"; rpcMode = "proof"; minedMode = "before";
  r = await one(A, "mined before");
  ok(r.status === 402 && serverLog.some((l) => l.includes("mined before this request's payment was first seen")), `a tx mined before the request's payment was first seen -> 402 (status ${r.status})`);
  minedMode = "now";

  // The production shape: a payload that settled normally, sent again.
  settleMode = "ok";
  const orig = await newPayment(A);
  let first = await send(A, orig);
  ok(first.status === 200 && first.receipt?.transaction === orig.tx, `original settles normally -> 200 (status ${first.status})`);
  settleMode = "on-chain";
  let before = settles;
  let again = await send(A, orig);
  // On this plain catalog route an identical resend is either refused or
  // answered from its first answer (marked, byte-identical); never settled again.
  const replayOk = again.status === 200 && again.replayed && again.body === first.body;
  ok((again.status !== 200 || replayOk) && settles === before, `the same payload again -> refused or replayed from its first answer, before the facilitator (status ${again.status}, replayed ${again.replayed}, settles +${settles - before})`);

  // Two concurrent replays, both told "already on-chain": at most one answer.
  async function concurrent(label, baseX, baseY, mode) {
    settleMode = mode; settleDelayMs = 400;
    const p = await newPayment(baseX);
    const before = settles;
    const [x, y] = await Promise.all([send(baseX, p), send(baseY, p)]);
    settleDelayMs = 0;
    const wins = [x, y].filter((q) => q.status === 200);
    ok(wins.length === 1, `${label}: exactly one 200 (statuses ${x.status}, ${y.status})`);
    ok(wins.every((q) => q.receipt?.transaction === p.tx), `${label}: the answer names the payment's own tx`);
    ok(settles - before <= 2, `${label}: settle calls ${settles - before}`);
  }
  await concurrent("two concurrent replays", A, A, "on-chain");
  await concurrent("a replay racing an original that settles normally", A, A, "first-wins");

  // --- Cross-replica, over the shared Redis ------------------------------
  if (REDIS_URL) {
    await boot(PORT_B);
    await concurrent("two concurrent replays on two servers", A, Bsrv, "on-chain");
    await concurrent("a replay on server B racing an original on server A", A, Bsrv, "first-wins");
    settleMode = "ok";
    const origX = await newPayment(A);
    first = await send(A, origX);
    settleMode = "on-chain"; before = settles;
    again = await send(Bsrv, origX);
    ok(first.status === 200 && again.status !== 200 && settles === before, `a payload settled on A, replayed on B -> refused before the facilitator (statuses ${first.status}, ${again.status})`);
    await stop(PORT_B);
  } else {
    console.log("# REDIS_URL unset: the cross-replica cases run in CI's redis step");
  }

  // --- The sales ledger -----------------------------------------------------
  // A fresh boot holds no claims, so only the ledger can refuse: a new
  // payload whose proof points at a tx already recorded as a sale.
  await stop(PORT_A);
  if (REDIS_URL) {
    const { createClient } = await import("redis");
    const c = createClient({ url: REDIS_URL }); await c.connect();
    for await (const keys of c.scanIterator({ MATCH: "settle-claim:*", COUNT: 500 })) { for (const k of [].concat(keys)) await c.del(k); }
    await c.quit();
  }
  await boot(PORT_A);
  settleMode = "on-chain"; rpcMode = "proof"; minedMode = "now";
  r = await one(A, "already a sale", { tx: soldTx });
  ok(r.status === 402 && serverLog.some((l) => l.includes("the transaction is already a recorded sale")), `a tx already in the sales ledger -> 402 (status ${r.status})`);

  // --- A Redis that stops answering never holds a settle ----------------------
  {
    const { __setTestClient } = await import("../src/shared-limit.js");
    const claims = await import("../src/settlement-claims.js");
    const never = () => new Promise(() => {});
    __setTestClient({ isReady: true, set: never, get: never, del: never });
    const t0 = Date.now();
    const a = await claims.claimSettlementKey("stall:1", "holder-a", { ttlSeconds: 60 });
    const b = await claims.claimSettlementKey("stall:1", "holder-b", { ttlSeconds: 60 });
    await claims.extendSettlementKey("stall:1", "holder-a");
    await claims.releaseSettlementKey("stall:1", "holder-a");
    const took = Date.now() - t0;
    __setTestClient(null);
    ok(a.claimed && !b.claimed, "a stalled Redis falls back to this process: the first holder claims, a second is refused");
    ok(took < claims.COMMAND_DEADLINE_MS * 8, `every command gives up at the deadline (${took} ms for 4 calls, deadline ${claims.COMMAND_DEADLINE_MS} ms)`);
  }

  console.log(`\nOK: ${pass} passed, 0 failed`);
} catch (e) {
  fail(`unexpected: ${e.stack || e}`);
}
cleanup();
process.exit(0);
