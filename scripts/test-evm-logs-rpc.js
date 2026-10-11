#!/usr/bin/env node
// Recent EVM getLogs, public lane first (src/evm-logs-rpc.js), and the revenue
// ledger's tail read through it. Offline: stub RPCs on port 0.
//
// What must hold: a public answer is taken only when it is explicitly
// complete (one batch, its own head at or past the range, every log inside
// the filter); every other public answer (error, range cap, behind its head,
// a lone non-batch answer, logs outside the filter, timeout, rate limit)
// falls back to the configured list; a range wider than a lane's cap or older
// than the depth never reaches the public lane; EVM_LOGS_ALCHEMY_FIRST=on
// sends every read to the configured list; and the ledger records the same
// rows whichever lane served it.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "evm-logs-"));
process.env.REVENUE_LEDGER_DB = join(dir, "ledger.db");
process.env.SALES_LEDGER_DB = join(dir, "sales.db");
delete process.env.STATE_DATABASE_URL;
delete process.env.EVM_LOGS_ALCHEMY_FIRST;

const L = await import("../src/evm-logs-rpc.js");
const RL = await import("../src/revenue-live.js");
const LEDGER = await import("../src/revenue-ledger.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.log(`FAIL: ${m}`); } };

const TOKEN = RL.EVM.base.token;
const TRANSFER = RL.TRANSFER_TOPIC;
const WALLET = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const hex = (n) => "0x" + n.toString(16);
const LOGS = [];
for (let b = 1_000; b <= 3_000; b += 7) LOGS.push({ address: TOKEN, topics: [TRANSFER, RL.pad("0x" + (b % 13).toString(16).padStart(40, "1")), RL.pad(WALLET)], data: "0x" + (1000 * (1 + (b % 5))).toString(16).padStart(64, "0"), blockNumber: hex(b), logIndex: "0x0", transactionHash: "0x" + b.toString(16).padStart(64, "a") });
const matching = (p, headLimit = Infinity) => {
  const f = parseInt(p.fromBlock, 16), t = parseInt(p.toBlock, 16);
  return LOGS.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= f && b <= t && b <= headLimit; });
};

// mode: ok | error | range | behind | nobatch | foreign | slow | ratelimit
let publicMode = "ok", publicHead = 5_000, publicCalls = 0, keyedCalls = 0;
const pub = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
    publicCalls++;
    const send = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const j = JSON.parse(body || "null");
    if (publicMode === "ratelimit") return send({ error: "too many requests" }, 429);
    if (publicMode === "slow") await new Promise((r) => setTimeout(r, 400));
    const batch = Array.isArray(j) ? j : [j];
    const out = batch.map((x) => {
      if (x.method === "eth_blockNumber") return { jsonrpc: "2.0", id: x.id, result: hex(publicHead) };
      const p = x.params[0];
      if (publicMode === "error") return { jsonrpc: "2.0", id: x.id, error: { code: -32000, message: "internal error" } };
      if (publicMode === "range") return { jsonrpc: "2.0", id: x.id, error: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" } };
      // A node behind the range answers [] for blocks it does not have, no error.
      if (publicMode === "behind") return { jsonrpc: "2.0", id: x.id, result: matching(p, publicHead) };
      if (publicMode === "foreign") return { jsonrpc: "2.0", id: x.id, result: [...matching(p), { ...LOGS[0], address: "0x" + "9".repeat(40) }] };
      return { jsonrpc: "2.0", id: x.id, result: matching(p) };
    });
    send(publicMode === "nobatch" ? out[out.length - 1] : (Array.isArray(j) ? out : out[0]));
  });
});
const keyed = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    keyedCalls++;
    const j = JSON.parse(body || "{}");
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(5_000) });
    if (j.method === "eth_getBlockByNumber") return send({ jsonrpc: "2.0", id: j.id, result: { timestamp: hex(1_790_000_000 + parseInt(j.params[0], 16) * 2) } });
    if (j.method === "eth_getLogs") return send({ jsonrpc: "2.0", id: j.id, result: matching(j.params[0]) });
    send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
  });
});
await new Promise((r) => pub.listen(0, "127.0.0.1", r));
await new Promise((r) => keyed.listen(0, "127.0.0.1", r));
const PUB = `http://127.0.0.1:${pub.address().port}/`;
const KEYED = `http://127.0.0.1:${keyed.address().port}/`;
const lanes = [{ url: PUB, maxRange: 2_000 }];

const filter = (from, to) => ({ address: TOKEN, topics: [TRANSFER, null, RL.pad(WALLET)], fromBlock: hex(from), toBlock: hex(to) });
const read = (from, to, extra = {}) => L.evmLogsRead(filter(from, to), { caller: "test", chain: "base", rpcs: [KEYED], head: 5_000, maxDepthBlocks: 4_500, lanes, publicTimeoutMs: 200, ...extra });
const truth = (from, to) => JSON.stringify(matching({ fromBlock: hex(from), toBlock: hex(to) }));

// Control: the public stub answers in full when healthy.
{
  publicMode = "ok"; publicCalls = 0; keyedCalls = 0;
  const logs = await read(1_000, 2_500);
  ok(JSON.stringify(logs) === truth(1_000, 2_500) && logs.length > 100, `control: a healthy public lane serves the range (${logs.length} logs)`);
  ok(publicCalls === 1 && keyedCalls === 0, "and the configured list is not called");
}
for (const mode of ["error", "range", "behind", "nobatch", "foreign", "slow", "ratelimit"]) {
  L.__resetEvmLogsForTest();
  publicMode = mode; publicCalls = 0; keyedCalls = 0;
  if (mode === "behind") publicHead = 2_000;
  const logs = await read(1_000, 2_500);
  publicHead = 5_000;
  ok(JSON.stringify(logs) === truth(1_000, 2_500), `public "${mode}": the answer is the configured list's, complete`);
  ok(publicCalls === 1 && keyedCalls === 1, `public "${mode}": one public try, then the fallback (${publicCalls}/${keyedCalls})`);
  const c = L.evmLogsStatus({ full: true }).callers.test;
  ok(c.fallbackServed === 1 && c.publicServed === 0, `public "${mode}": counted as a fallback`);
}
{
  // The behind-head control: the same node, caught up, is trusted.
  L.__resetEvmLogsForTest(); publicMode = "behind"; publicHead = 2_600; keyedCalls = 0;
  const logs = await read(1_000, 2_500);
  ok(JSON.stringify(logs) === truth(1_000, 2_500) && keyedCalls === 0, "control: a node whose head is past the range is trusted");
  publicHead = 5_000;
}
{
  L.__resetEvmLogsForTest(); publicMode = "ok"; publicCalls = 0; keyedCalls = 0;
  await read(1_000, 3_500);
  ok(publicCalls === 0 && keyedCalls === 1, "a range wider than the lane's cap never reaches it");
  publicCalls = 0; keyedCalls = 0;
  await read(100, 1_000);
  ok(publicCalls === 0 && keyedCalls === 1, "a range older than the depth never reaches it");
  ok(L.evmLogsStatus({ full: true }).callers.test.publicSkipped.range === 1 && L.evmLogsStatus({ full: true }).callers.test.publicSkipped.depth === 1, "and both skips are counted");
}
{
  // A lane that failed cools: the next read skips it.
  L.__resetEvmLogsForTest(); publicMode = "error"; publicCalls = 0;
  await read(1_000, 2_000); await read(1_000, 2_000);
  ok(publicCalls === 1, `a failed lane cools and is skipped by the next read (${publicCalls} public call)`);
}
{
  process.env.EVM_LOGS_ALCHEMY_FIRST = "on";
  L.__resetEvmLogsForTest(); publicMode = "ok"; publicCalls = 0; keyedCalls = 0;
  const logs = await read(1_000, 2_000);
  ok(JSON.stringify(logs) === truth(1_000, 2_000) && publicCalls === 0 && keyedCalls === 1, "EVM_LOGS_ALCHEMY_FIRST=on: every read goes to the configured list");
  ok(L.evmLogsStatus({ full: true }).order === "keyed-first", "and the operator view says so");
  delete process.env.EVM_LOGS_ALCHEMY_FIRST;
}
{
  // Every lane failing throws with each reason, and a range error reaches the
  // ledger's narrowing.
  L.__resetEvmLogsForTest(); publicMode = "range";
  let err = null;
  try { await L.evmLogsRead(filter(1_000, 1_500), { caller: "test", chain: "base", rpcs: [], head: 5_000, maxDepthBlocks: 4_500, lanes, fallback: async () => { throw new Error("all 1 RPCs failed - keyed: query exceeds range, retry smaller (max block range 500, got 501)"); } }); } catch (e) { err = e; }
  ok(err && /public: .*ranges over/.test(err.message), "a failure on every lane names the public lane's reason too");
  ok(LEDGER.nextChunkSpan(err?.message, 501) === 500, "and the keyed lane's stated range limit still narrows the ledger's chunk");
  ok(L.evmLogsStatus({ full: false }).status === "failing" && Object.keys(L.evmLogsStatus()).join() === "status", "the public view is one word");
}

// The ledger's tail through the lanes: the same rows from either lane.
{
  RL.EVM.base.rpcs.length = 0; RL.EVM.base.rpcs.push(KEYED);
  process.env.REVENUE_LEDGER_FROM_BASE = "900";
  process.env.EVM_LOGS_PUBLIC_RPCS_BASE = PUB;
  L.__resetEvmLogsForTest(); publicMode = "ok"; publicCalls = 0; keyedCalls = 0;
  // A first sync is a backfill (older than the depth): keyed-first.
  await LEDGER.syncEvmChain("base", WALLET);
  const s1 = LEDGER.ledgerSummary({ walletAddress: WALLET }).perChain.base;
  ok(s1.inboundCount === LOGS.length, `the backfill records every transfer (${s1.inboundCount} of ${LOGS.length})`);
  const c1 = L.evmLogsStatus({ full: true }).callers["revenue-ledger"];
  ok(c1.publicServed === 0 && c1.fallbackServed > 0, "the backfill is older than an hour of blocks: keyed-first");
  // New transfers at the head: the tail goes to the public lane.
  for (let b = 5_100; b <= 5_400; b += 11) LOGS.push({ address: TOKEN, topics: [TRANSFER, RL.pad("0x" + "2".repeat(40)), RL.pad(WALLET)], data: "0x" + (2000).toString(16).padStart(64, "0"), blockNumber: hex(b), logIndex: "0x1", transactionHash: "0x" + b.toString(16).padStart(64, "b") });
  publicHead = 6_000;
  keyed.removeAllListeners("request");
  keyed.on("request", (req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      keyedCalls++;
      const j = JSON.parse(body || "{}");
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(5_600) });
      if (j.method === "eth_getBlockByNumber") return send({ jsonrpc: "2.0", id: j.id, result: { timestamp: hex(1_790_000_000 + parseInt(j.params[0], 16) * 2) } });
      if (j.method === "eth_getLogs") return send({ jsonrpc: "2.0", id: j.id, result: matching(j.params[0]) });
      send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
    });
  });
  L.__resetEvmLogsForTest();
  const r = await LEDGER.syncEvmChain("base", WALLET);
  const s2 = LEDGER.ledgerSummary({ walletAddress: WALLET }).perChain.base;
  ok(s2.inboundCount === LOGS.length, `the tail through the public lane records every new transfer, none twice (${s2.inboundCount} of ${LOGS.length})`);
  const c2 = L.evmLogsStatus({ full: true }).callers["revenue-ledger"];
  ok(c2.publicServed >= 1 && c2.fallbackServed === 0, `the tail was served by the public lane (${c2.publicServed} public, ${c2.fallbackServed} fallback)`);
  ok(r.next <= 5_600 && r.next > 5_590, `the tail stops a few seconds of blocks short of the head (${r.next})`);
}

pub.close(); keyed.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAIL" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
