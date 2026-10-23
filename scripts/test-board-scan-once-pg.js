// Two containers, one chain scan per cadence, against a REAL state database:
// the Base board (src/leaderboard.js), the Solana board
// (src/solana-leaderboard.js) and the MPP board (src/mpp-leaderboard.js).
// Each board's refresh runs under a lease, which only serializes scans: a tick
// that landed after the other container's scan had ended held the lease and
// read the same window again (two replicas, two scans per interval), and every
// boot kick scanned however fresh the saved board was. Stub chains count every
// RPC call, so each rule below is a count:
//   * the second container's tick adopts the board the first one saved and
//     makes no RPC call
//   * a tick on the first container right after its own scan (a boot kick
//     after a restart) reads nothing
//   * a saved board OLDER than the one a container holds is never adopted:
//     the tick scans, and the board served is its own, newer one
//   * a saved board older than the freshness window is not this tick's
//     answer: the tick scans
//   * the Base scan after an adopt reads only the blocks since the log
//     cache's cursor: fewer calls than the first read of the window
//   STATE_DATABASE_URL=postgres://... node scripts/test-board-scan-once-pg.js
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-board-scan-once-pg" });
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const guard = setTimeout(() => { console.error("FAIL - the suite did not finish in time"); process.exit(1); }, 180_000);

// The documents keep their production names (basenames) in this test's own
// schema; the files are import sources that do not exist here.
const dir = mkdtempSync(join(tmpdir(), "board-scan-once-"));
process.env.LEADERBOARD_SNAPSHOT_FILE = join(dir, "leaderboard-snapshot.json");
process.env.LEADERBOARD_HISTORY_FILE = join(dir, "leaderboard-history.json");
process.env.LEADERBOARD_FUNDING_FILE = join(dir, "leaderboard-funding.json");
process.env.LEADERBOARD_LOG_CACHE_DIR = join(dir, "leaderboard-logs");
process.env.SOLANA_LB_CACHE_FILE = join(dir, "solana-leaderboard.json");
process.env.MPP_LB_CACHE_FILE = join(dir, "mpp-leaderboard-cache.json");
process.env.LEADERBOARD_FUNDING_SCAN = "off";
process.env.SOLANA_LB_CHECKPOINT_MS = "0";
process.env.SOLANA_LB_RETRY_PAUSE_MS = "0";
delete process.env.ALCHEMY_API_KEY;

const sdb = await import("../src/state-db.js");
await sdb.stateDb();
/** Wait for a queued document save to land (saveSync on Postgres queues the write). */
const landed = async (name, pred) => { for (let i = 0; i < 200; i++) { const row = await sdb.documents.get(name).catch(() => null); if (row && pred(row.body)) return row.body; await sleep(50); } return null; };

// ---- the Base board: a stub Bazaar + JSON-RPC, every call counted -----------
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hex = (n) => "0x" + n.toString(16);
const addr = (prefix, i) => "0x" + prefix + i.toString(16).padStart(40 - prefix.length, "0");
const topic = (a) => "0x" + "0".repeat(24) + a.slice(2);
let seed = 9;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const SELLERS = Array.from({ length: 60 }, (_, i) => addr("5e11", i));
const PAYERS = Array.from({ length: 40 }, (_, i) => addr("ba7e", i));
const LOGS = [];
for (let block = 1; block <= 6_000; block++) {
  const n = rnd() < 0.3 ? 1 + Math.floor(rnd() * 2) : 0;
  for (let li = 0; li < n; li++) {
    const to = SELLERS[Math.floor(rnd() * SELLERS.length)], from = PAYERS[Math.floor(rnd() * PAYERS.length)];
    LOGS.push({ address: USDC, topics: [TRANSFER, topic(from), topic(to)], data: "0x" + (10_000).toString(16).padStart(64, "0"), blockNumber: hex(block), logIndex: hex(li) });
  }
}
const HEAD = 6_000;
const evm = { calls: 0 };
const srv = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/bazaar")) {
      const items = SELLERS.map((w, i) => ({ resource: `https://s${i}.example/api`, accepts: [{ network: "eip155:8453", asset: USDC, payTo: w, amount: "10000" }] }));
      return send(/offset=0/.test(req.url) ? { items, pagination: { total: items.length } } : { items: [] });
    }
    const j = JSON.parse(body || "{}");
    evm.calls++;
    if (j.method === "eth_blockNumber") return send({ jsonrpc: "2.0", id: j.id, result: hex(HEAD) });
    if (j.method === "eth_getLogs") {
      const p = j.params[0];
      const from = parseInt(p.fromBlock, 16), to = parseInt(p.toBlock, 16);
      const tos = new Set((p.topics[2] || []).map((t) => t.toLowerCase()));
      return send({ jsonrpc: "2.0", id: j.id, result: LOGS.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to && tos.has(l.topics[2]); }) });
    }
    return send({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "no" } });
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const baseOpts = { bazaarUrl: `${base}/bazaar`, rpcs: [`${base}/rpc`], spanBlocks: 4_000, chunkBlocks: 1_000, walletChunk: 20, fundingScan: false, peerFreshMs: 60_000 };

// ---- the Solana board: an in-memory chain as the RPC, every call counted ----
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const P1 = "Pay1111111111111111111111111111111111111111", P2 = "Pay2222222222222222222222222222222222222222", P3 = "Pay3333333333333333333333333333333333333333";
const nowSec = Math.floor(Date.now() / 1000);
const mkChain = (tag, n) => Array.from({ length: n }, (_, i) => ({ signature: `${tag}${n - i}`, blockTime: nowSec - 5 - i * 60, buyer: `Buyer${(n - i) % 9}`, amount: 1000 + ((n - i) % 7) }));
const chains = new Map([[P1, mkChain("a", 12)], [P2, mkChain("b", 7)], [P3, mkChain("c", 3)]]);
const txOf = new Map();
for (const [payTo, chain] of chains) for (const x of chain) txOf.set(x.signature, { payTo, x });
function solanaRpc() {
  const calls = { total: 0 };
  const fn = async (method, params) => {
    calls.total++;
    if (method === "getTokenAccountsByOwner") return chains.has(params[0]) ? { value: [{ pubkey: `ATA-${params[0]}` }] } : { value: [] };
    if (method === "getSignaturesForAddress") {
      const chain = chains.get(params[0].slice(4)) || [];
      const { limit = 1000, before, until } = params[1] || {};
      let i = before ? chain.findIndex((x) => x.signature === before) + 1 : 0;
      const out = [];
      for (; i < chain.length && out.length < limit; i++) { if (chain[i].signature === until) break; out.push(chain[i]); }
      return out.map(({ signature, blockTime }) => ({ signature, blockTime, err: null }));
    }
    if (method === "getTransaction") {
      const { payTo, x } = txOf.get(params[0]);
      return { blockTime: x.blockTime, meta: { err: null,
        preTokenBalances: [{ accountIndex: 0, mint: SOL_USDC, owner: payTo, uiTokenAmount: { amount: "0" } }, { accountIndex: 1, mint: SOL_USDC, owner: x.buyer, uiTokenAmount: { amount: "999999" } }],
        postTokenBalances: [{ accountIndex: 0, mint: SOL_USDC, owner: payTo, uiTokenAmount: { amount: String(x.amount) } }, { accountIndex: 1, mint: SOL_USDC, owner: x.buyer, uiTokenAmount: { amount: String(999999 - x.amount) } }] } };
    }
    throw new Error("unknown " + method);
  };
  return { fn, calls };
}
const listPayTos = async () => new Map([[P1, new Set(["https://one.example"])], [P2, new Set(["https://two.example"])], [P3, new Set(["https://three.example"])]]);

// ---- the MPP board: a verified index snapshot and a counting Tempo RPC ------
const TOPIC = TRANSFER;
const RA = "0x1111111111111111111111111111111111111111", RB = "0x2222222222222222222222222222222222222222";
const seller = (name, origin, recipient) => ({ name, origin, serviceUrl: origin, url: origin, verified: true, verifiedAt: 1, lastProbeAt: 1, endpoints: [], offers: [{ method: "tempo", intent: "charge", recipient, currency: "0x20c0000000000000000000000000000000000000", chainId: 4217 }] });
function tempoRpc(usdc) {
  const calls = { total: 0 };
  const fn = async (method) => {
    calls.total++;
    if (method === "eth_blockNumber") return hex(200_000);
    if (method === "eth_getLogs") return [{ topics: [TOPIC, topic(addr("c0ffee", 1)), topic(RA)], data: "0x" + (5_000_000).toString(16) }];
    throw new Error("unknown " + method);
  };
  return { fn, calls };
}

try {
  // ===== Base =====
  {
    const A = await import("../src/leaderboard.js?container=a");
    const B = await import("../src/leaderboard.js?container=b");
    const tick = (M, extra = {}) => M.__refreshTickForTest({ ...baseOpts, ...extra });
    evm.calls = 0;
    await tick(A);
    const first = evm.calls, snapA = A.getLeaderboardSnapshot();
    ok(first > 0 && snapA?.leaderboard?.length > 0 && !snapA.adoptedFromPeer, `Base: the first container scans the stub chain (${first} RPC calls, ${snapA?.leaderboard?.length} sellers)`);
    ok(await landed("leaderboard-snapshot.json", (b) => b?.asOf === snapA.asOf), "Base: the board is saved as a state document");
    evm.calls = 0;
    const rb = await tick(B);
    const snapB = B.getLeaderboardSnapshot();
    ok(rb?.adopted === true && evm.calls === 0 && snapB?.asOf === snapA.asOf && snapB.adoptedFromPeer === true, `Base: the second container's tick adopts the saved board and makes no RPC call (${evm.calls} calls, asOf ${snapB?.asOf})`);
    evm.calls = 0;
    const ra2 = await tick(A);
    ok(ra2?.adopted === true && evm.calls === 0 && A.getLeaderboardSnapshot().asOf === snapA.asOf, `Base: a tick right after the container's own scan (a boot kick) reads nothing (${evm.calls} calls)`);
    // A saved board older than the one held: never adopted; the tick scans.
    const olderAsOf = new Date(Date.parse(snapA.asOf) - 20_000).toISOString();
    await sdb.documents.put("leaderboard-snapshot.json", { ...snapA, asOf: olderAsOf, leaderboard: snapA.leaderboard.slice(0, 1) });
    evm.calls = 0;
    const rb2 = await tick(B);
    const snapB2 = B.getLeaderboardSnapshot();
    ok(!rb2?.adopted && evm.calls > 0 && snapB2.asOf > snapA.asOf && !snapB2.adoptedFromPeer && snapB2.leaderboard.length === snapA.leaderboard.length, `Base: a saved board older than the one held is not adopted; the tick scans (${evm.calls} calls) and serves its own newer board (asOf ${snapB2.asOf})`);
    ok(evm.calls < first, `Base: that scan read only the blocks since the log cache's cursor (${evm.calls} calls, the first read of the window took ${first})`);
    ok(await landed("leaderboard-snapshot.json", (b) => b?.asOf === snapB2.asOf), "Base: the second container's scan is saved");
    // A saved board older than the freshness window is not this tick's answer.
    await sleep(20);
    evm.calls = 0;
    const ra3 = await tick(A, { peerFreshMs: 10 });
    ok(!ra3?.adopted && evm.calls > 0 && A.getLeaderboardSnapshot().asOf > snapB2.asOf, `Base: a saved board older than the freshness window is not adopted; the tick scans (${evm.calls} calls)`);
  }
  // ===== Solana =====
  {
    const A = await import("../src/solana-leaderboard.js?container=a");
    const B = await import("../src/solana-leaderboard.js?container=b");
    const { creditFromTx } = await import("../src/solana-buyer.js");
    const tick = (M, rpc, extra = {}) => M.refreshSolanaLeaderboard({ listPayTos, rpc: rpc.fn, creditFromTx, prime: () => {}, windowHours: 168, peerFreshMs: 60_000, ...extra });
    const rpcA = solanaRpc();
    await tick(A, rpcA);
    const sA = A.getSolanaLeaderboardSnapshot();
    ok(rpcA.calls.total > 0 && sA.rows.length === 3 && sA.scannedAt, `Solana: the first container scans every payTo (${rpcA.calls.total} RPC calls)`);
    ok(await landed("solana-leaderboard.json", (b) => b?.at && new Date(b.at).toISOString() === sA.scannedAt), "Solana: the board and cursors are saved as a state document");
    const rpcB = solanaRpc();
    const rb = await tick(B, rpcB);
    const sB = B.getSolanaLeaderboardSnapshot();
    ok(rb?.adopted === true && rpcB.calls.total === 0 && sB.scannedAt === sA.scannedAt && sB.rows.length === 3, `Solana: the second container's tick adopts the saved board and makes no RPC call (${rpcB.calls.total} calls)`);
    const rpcA2 = solanaRpc();
    const ra2 = await tick(A, rpcA2);
    ok(ra2?.adopted === true && rpcA2.calls.total === 0, `Solana: a tick right after the container's own scan reads nothing (${rpcA2.calls.total} calls)`);
    // A saved board older than the one held: never adopted; the tick scans.
    const stored = await sdb.documents.get("solana-leaderboard.json");
    const olderAt = Date.parse(sA.scannedAt) - 20_000;
    await sdb.documents.put("solana-leaderboard.json", { ...stored.body, at: olderAt, stateAt: olderAt, rows: stored.body.rows.slice(0, 1) });
    await sleep(5);
    const rpcB2 = solanaRpc();
    const rb2 = await tick(B, rpcB2);
    const sB2 = B.getSolanaLeaderboardSnapshot();
    ok(!rb2?.adopted && rpcB2.calls.total > 0 && Date.parse(sB2.scannedAt) > Date.parse(sA.scannedAt) && sB2.rows.length === 3, `Solana: a saved board older than the one held is not adopted; the tick scans (${rpcB2.calls.total} calls) and serves its own newer board`);
    ok(rpcB2.calls.total < rpcA.calls.total, `Solana: that scan read from the saved cursors (${rpcB2.calls.total} calls, the first scan took ${rpcA.calls.total})`);
    ok(await landed("solana-leaderboard.json", (b) => b?.at && new Date(b.at).toISOString() === sB2.scannedAt), "Solana: the second container's scan is saved");
    await sleep(20);
    const rpcA3 = solanaRpc();
    const ra3 = await tick(A, rpcA3, { peerFreshMs: 10 });
    ok(!ra3?.adopted && rpcA3.calls.total > 0 && Date.parse(A.getSolanaLeaderboardSnapshot().scannedAt) > Date.parse(sB2.scannedAt), `Solana: a saved board older than the freshness window is not adopted; the tick scans (${rpcA3.calls.total} calls)`);
  }
  // ===== MPP =====
  {
    const A = await import("../src/mpp-leaderboard.js?container=a");
    const B = await import("../src/mpp-leaderboard.js?container=b");
    const { TEMPO_USDC } = await import("../src/tempo-buyer.js");
    const snapshot = { verifiedSellers: 2, discoveredTotal: 2, sellers: [seller("Alpha", "https://alpha.example", RA), seller("Beta", "https://beta.example", RB)].map((s) => ({ ...s, offers: s.offers.map((o) => ({ ...o, currency: TEMPO_USDC.toLowerCase() })) })) };
    const tick = (M, rpc, extra = {}) => M.refreshMppLeaderboard({ snapshot, rpcFn: rpc.fn, feed: null, self: null, peerFreshMs: 60_000, ...extra });
    const rpcA = tempoRpc(TEMPO_USDC);
    await tick(A, rpcA);
    const mA = A.mppLeaderboardSnapshot();
    ok(rpcA.calls.total > 0 && mA.generatedAt > 0 && mA.rows.length === 2, `MPP: the first container rebuilds from the stub chain (${rpcA.calls.total} RPC calls)`);
    ok(await landed("mpp-leaderboard-cache.json", (b) => b?.generatedAt === mA.generatedAt), "MPP: the board is saved as a state document");
    const rpcB = tempoRpc(TEMPO_USDC);
    const rb = await tick(B, rpcB);
    const mB = B.mppLeaderboardSnapshot();
    ok(rb?.adopted === true && rpcB.calls.total === 0 && mB.generatedAt === mA.generatedAt && mB.rows.length === 2, `MPP: the second container's tick adopts the saved board and makes no RPC call (${rpcB.calls.total} calls)`);
    const rpcA2 = tempoRpc(TEMPO_USDC);
    const ra2 = await tick(A, rpcA2);
    ok(ra2?.adopted === true && rpcA2.calls.total === 0, `MPP: a tick right after the container's own rebuild reads nothing (${rpcA2.calls.total} calls)`);
    const stored = await sdb.documents.get("mpp-leaderboard-cache.json");
    await sdb.documents.put("mpp-leaderboard-cache.json", { ...stored.body, generatedAt: mA.generatedAt - 20_000, rows: stored.body.rows.slice(0, 1) });
    await sleep(5);
    const rpcB2 = tempoRpc(TEMPO_USDC);
    const rb2 = await tick(B, rpcB2);
    const mB2 = B.mppLeaderboardSnapshot();
    ok(!rb2?.adopted && rpcB2.calls.total > 0 && mB2.generatedAt > mA.generatedAt && mB2.rows.length === 2, `MPP: a saved board older than the one held is not adopted; the tick rebuilds (${rpcB2.calls.total} calls) and serves its own newer board`);
    ok(await landed("mpp-leaderboard-cache.json", (b) => b?.generatedAt === mB2.generatedAt), "MPP: the second container's rebuild is saved");
    await sleep(20);
    const rpcA3 = tempoRpc(TEMPO_USDC);
    const ra3 = await tick(A, rpcA3, { peerFreshMs: 10 });
    ok(!ra3?.adopted && rpcA3.calls.total > 0 && A.mppLeaderboardSnapshot().generatedAt > mB2.generatedAt, `MPP: a saved board older than the freshness window is not adopted; the tick rebuilds (${rpcA3.calls.total} calls)`);
  }
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  srv.close();
  await sdb.__dropStateSchema?.().catch(() => {});
  await sdb.closeStateDb?.();
  clearTimeout(guard);
}
console.log(`\ntest-board-scan-once-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
