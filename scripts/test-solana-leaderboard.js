#!/usr/bin/env node
// Solana SPL leaderboard (src/solana-leaderboard.js) + the gate seams it
// feeds: detail mode on the credit counter, the primed proof cache, the
// index's Solana payTo list, ranking, stale-on-error, persistence. Offline: a
// stub Solana RPC serves token accounts, signatures and parsed transactions.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const A = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";   // proven-ish seller: 3 credits from a facilitator + 1 self-funded
const B = "8Y9wxHqJt3mfMUv7pQnBRZUKGdCwjrLBGWtaeu6AGFfe";   // no USDC account
const C = "AQqnMFBwTdWhMsS4xA5v7zGiNzLh6dBGfMd1jJKYBn9E";   // RPC error on signatures
const FAC = "FacilitatorAccount11111111111111111111111111";
const now = Math.floor(Date.now() / 1000);
let rpcCalls = 0;
const rpc = createServer((req, res) => {
  let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
    rpcCalls++;
    const { method, params } = JSON.parse(body);
    const reply = (result) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result })); };
    const err = (msg) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: msg } })); };
    if (method === "getTokenAccountsByOwner") {
      const owner = params[0];
      if (owner === B) return reply({ value: [] });
      return reply({ value: [{ pubkey: `ATA-${owner.slice(0, 6)}`, account: {} }] });
    }
    if (method === "getSignaturesForAddress") {
      const ata = params[0];
      if (ata.startsWith("ATA-" + C.slice(0, 6))) return err("429 Too Many Requests");
      return reply(["s1", "s2", "s3", "s4"].map((sig, i) => ({ signature: sig, blockTime: now - 60 * (i + 1), err: null })));
    }
    if (method === "getTransaction") {
      const sig = params[0];
      const selfFunded = sig === "s4";
      return reply({ meta: { err: null,
        preTokenBalances: [ { accountIndex: 0, mint: USDC, owner: A, uiTokenAmount: { amount: "1000" } }, { accountIndex: 1, mint: USDC, owner: selfFunded ? A : FAC, uiTokenAmount: { amount: "9000" } } ],
        postTokenBalances: [ { accountIndex: 0, mint: USDC, owner: A, uiTokenAmount: { amount: "2000" } }, { accountIndex: 1, mint: USDC, owner: selfFunded ? A : FAC, uiTokenAmount: { amount: "8000" } } ] } });
    }
    err("unknown method " + method);
  });
});
await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
process.env.SOLANA_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.SOLANA_LB_CACHE_FILE = join(mkdtempSync(join(tmpdir(), "solana-lb-")), "lb.json");

const buyer = await import("../src/solana-buyer.js");
const lb = await import("../src/solana-leaderboard.js");
const idx = await import("../src/x402-index.js");

// ---- 1. detail mode on the credit counter ----------------------------------
{
  const d = await buyer.solanaInboundCount(A, { detail: true });
  ok(d.credits === 3 && d.payers === 1 && d.truncated === false && d.read === 4, `detail mode: 3 credits (the self-funded one excluded), 1 funder (the facilitator), not truncated (got ${JSON.stringify(d)})`);
  const t = await buyer.solanaInboundCount(A, { detail: true, maxTxReads: 2 });
  ok(t.truncated === true && t.read === 2 && t.credits === 2, "past the read cap the row says truncated with the count it reached");
  ok(await buyer.solanaInboundCount(A) === 3, "the bare call still returns the number (gates unchanged)");
  ok((await buyer.solanaInboundCount(B, { detail: true })).credits === 0, "no USDC account: zero credits, no throw");
}
// ---- 2. the payTo list from the index ---------------------------------------
{
  const cache = idx._cacheForTests(); cache.clear();
  cache.set("https://sol.example", { manifest: {}, tools: [{ seller: "https://sol.example", route: "/a", payToByNetwork: { [MAINNET]: A, "eip155:8453": "0x" + "a".repeat(40) } }], fetchedAt: Date.now(), error: null, history: [1] });
  cache.set("https://sol2.example", { manifest: {}, tools: [{ seller: "https://sol2.example", route: "/b", payToByNetwork: { "solana": A } }, { seller: "https://sol2.example", route: "/c", payToByNetwork: { "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": B } }], fetchedAt: Date.now(), error: null, history: [1] });
  const m = idx.allSolanaPayToOrigins();
  ok(m.get(A)?.size === 2 && [...m.get(A)].sort().join(",") === "https://sol.example,https://sol2.example", "one payTo shared by two origins maps to both (mainnet CAIP-2 and bare 'solana' labels)");
  ok(!m.has(B) && !m.has("0x" + "a".repeat(40)), "a DEVNET label and an EVM payTo are never listed");
  cache.clear();
}
// ---- 3. the incremental reader ----------------------------------------------
// Cycle 1 on a payTo reads its token account, its recent signatures and each
// transaction; cycle 2 passes `until` = the newest signature seen and reads
// NOTHING new (one RPC call); a payTo with no USDC account costs one call and
// is then skipped for a day; events outside the window are pruned.
{
  const rpcLog = [];
  const rpcFn = async (method, params) => { rpcLog.push(method); const res = await fetch(process.env.SOLANA_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await res.json(); if (j.error) throw new Error("Solana RPC error: " + j.error.message); return j.result; };
  const windowMs = 7 * 24 * 3600e3;
  const st = {};
  const r1 = await lb.readPayToIncremental(A, st, { rpc: rpcFn, creditFromTx: buyer.creditFromTx, windowMs });
  ok(r1.credits === 3 && r1.payers === 1 && r1.rpcCalls === 6 && st.ata && st.lastSig === "s1" && st.events.length === 3, `cycle 1: account + signatures + 4 tx reads = 6 RPC calls, 3 credits, cursor at the newest signature (got ${JSON.stringify(r1)})`);
  rpcLog.length = 0;
  const r2 = await lb.readPayToIncremental(A, st, { rpc: rpcFn, creditFromTx: buyer.creditFromTx, windowMs });
  ok(r2.credits === 3 && r2.rpcCalls === 1 && rpcLog.join(",") === "getSignaturesForAddress", `cycle 2: ONE signatures read with until=lastSig, no transaction reads, credits carried (got ${r2.rpcCalls} calls: ${rpcLog.join(",")})`);
  const stB = {};
  const b1 = await lb.readPayToIncremental(B, stB, { rpc: rpcFn, creditFromTx: buyer.creditFromTx, windowMs });
  rpcLog.length = 0;
  const b2 = await lb.readPayToIncremental(B, stB, { rpc: rpcFn, creditFromTx: buyer.creditFromTx, windowMs });
  ok(b1.rpcCalls === 1 && b2.rpcCalls === 0 && stB.ata === null && b2.credits === 0, "a payTo with no USDC account costs one call, then nothing for a day");
  const b3 = await lb.readPayToIncremental(B, stB, { rpc: rpcFn, creditFromTx: buyer.creditFromTx, windowMs, now: Date.now() + 25 * 3600e3 });
  ok(b3.rpcCalls === 1, "and is re-checked after the day");
  const pruned = await lb.readPayToIncremental(A, st, { rpc: rpcFn, creditFromTx: buyer.creditFromTx, windowMs, now: Date.now() + 8 * 24 * 3600e3 });
  ok(pruned.credits === 0 && st.events.length === 0, "events older than the window are pruned on the next read");
}
// ---- 3b. the scan: ranking, self, stale-on-error, evidence ------------------
{
  const payTos = new Map([[A, new Set(["https://sol.example"])], [B, new Set(["https://none.example"])], [C, new Set(["https://flaky.example"])]]);
  const readFn = (p) => buyer.solanaInboundCount(p, { detail: true });
  const snap = await lb.scanSolanaSellers(payTos, { readFn, concurrency: 2, previous: [{ payTo: C, origins: ["https://flaky.example"], credits: 25, payers: 1, at: 1 }], retryPauseMs: 0 });
  ok(snap.scanned === 3 && snap.errors === 1, `three payTos scanned, one unreadable (${snap.errors})`);
  const byP = Object.fromEntries(snap.rows.map((r) => [r.payTo, r]));
  ok(byP[A].credits === 3 && byP[B].credits === 0 && byP[C].credits === 25 && byP[C].stale === true, "an RPC failure keeps the PREVIOUS row marked stale rather than zeroing a proven seller");
  lb.__setSolanaLeaderboardForTest(snap);
  const view = lb.getSolanaLeaderboardSnapshot({ self: A });
  ok(view.rows[0].payTo === C && view.rows[0].rank === 1 && view.rows[1].payTo === A && view.rows[1].self === true && view.active === 2, "ranked by credits desc; the host's own payTo is flagged self and ranked like everyone else");
  ok(view.stale === false && view.sellers === 3 && typeof view.scannedAt === "string", "the snapshot says when it was scanned and is not stale right after");
  const ev = lb.solanaEvidenceByOrigin(snap);
  ok(ev.settled.get("https://sol.example") === 3 && ev.payers.get("https://sol.example") === 1 && ev.settled.get("https://flaky.example") === 25, "evidence maps are keyed by origin for the resolver");
  ok(lb.getSolanaLeaderboardSnapshot({ now: Date.now() + 7 * 60 * 60_000 }).stale === true, "a two-hourly board older than three refreshes reads stale");
  ok(view.rows.every((r) => !("error" in r)) && snap.rows.some((r) => r.error), "public rows never carry the RPC's error text (the internal row keeps it)");
  let attempts = 0;
  const flaky = await lb.scanSolanaSellers(new Map([[A, new Set(["https://sol.example"])]]), { readFn: async (p) => { if (++attempts === 1) throw new Error("Solana RPC HTTP 429"); return buyer.solanaInboundCount(p, { detail: true }); }, retryPauseMs: 0 });
  ok(attempts === 2 && flaky.errors === 0 && flaky.rows[0].credits === 3, "a 429 on the first read is retried once before the row is marked unreadable");
}
// ---- 4. priming the pay-time gate --------------------------------------------
{
  buyer.__resetSvmProofCacheForTest();
  const before = rpcCalls;
  buyer.primeSvmInboundCount(A, 40);
  ok(await buyer.cachedSolanaInboundCount(A, { stopAt: 20 }) === 40 && rpcCalls === before, "a primed count that clears the floor answers with NO RPC call");
  buyer.primeSvmInboundCount(A, 5);
  const live = await buyer.cachedSolanaInboundCount(A, { stopAt: 20 });
  ok(live === 3 && rpcCalls > before, "a primed count BELOW the floor falls through to a live read (never refuse on stale data)");
  ok(buyer.primedSvmInboundCount(A, Date.now() + 2 * 60 * 60_000) === null, "a primed count expires after the TTL");
  const gate = await buyer.assertProvenSolanaSeller(A, { minCount: 3 }).then(() => "passed", (e) => e.statusCode);
  ok(gate === "passed", "the gate itself reads through the cached path (3 live credits, floor 3)");
  buyer.primeSvmInboundCount(A, 100);
  const c0 = rpcCalls;
  const g2 = await buyer.passesSolanaResolveGate({ header: Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: MAINNET, asset: USDC, amount: "5000", payTo: A }] })).toString("base64"), minCount: 20 });
  ok(g2.ok === true && g2.inbound === 100 && rpcCalls === c0, "the resolve-time gate takes the primed count without touching the chain");
  buyer.__resetSvmProofCacheForTest();
}
// ---- 5. refresh (incremental, stateful) + persist + warm start ---------------
{
  lb.__resetSolanaLeaderboardForTest();
  const primed = [];
  const rpcFn = async (method, params) => { const res = await fetch(process.env.SOLANA_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await res.json(); if (j.error) throw new Error("Solana RPC error: " + j.error.message); return j.result; };
  const listPayTos = async () => new Map([[A, new Set(["https://sol.example"])], [B, new Set(["https://none.example"])]]);
  await lb.refreshSolanaLeaderboard({ listPayTos, rpc: rpcFn, creditFromTx: buyer.creditFromTx, prime: (p, n) => primed.push([p, n]), windowHours: 168 });
  const first = lb.getSolanaLeaderboardSnapshot();
  ok(primed.length === 2 && primed[0][0] === A && primed[0][1] === 3, "a refresh primes every readable row into the gate");
  ok(first.rpcCallsLastScan === 7 && lb._stateForTest()[A]?.lastSig === "s1", `first refresh: 7 RPC calls (6 for the active payTo, 1 for the empty one), cursor stored (got ${first.rpcCallsLastScan})`);
  await lb.refreshSolanaLeaderboard({ listPayTos, rpc: rpcFn, creditFromTx: buyer.creditFromTx, prime: () => {}, windowHours: 168 });
  const second = lb.getSolanaLeaderboardSnapshot();
  ok(second.rpcCallsLastScan === 1 && second.rows.find((r) => r.payTo === A)?.credits === 3, `second refresh: ONE RPC call in total (nothing new on the active payTo, the empty one skipped for a day) (got ${second.rpcCallsLastScan})`);
  lb.__resetSolanaLeaderboardForTest();
  ok(lb.getSolanaLeaderboardSnapshot().rows.length === 0, "reset is empty");
  ok(lb.loadPersistedSolanaLeaderboard() === true && lb.getSolanaLeaderboardSnapshot().rows.length === 2 && lb.getSolanaLeaderboardSnapshot().warmStarted === true && lb._stateForTest()[A]?.lastSig === "s1", "the persisted board AND its per-payTo cursors warm-start the next boot");
}
rpc.close();
console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
