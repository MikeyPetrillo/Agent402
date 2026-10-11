#!/usr/bin/env node
// Solana history reads public-first (src/solana-history-rpc.js). Offline: stub
// JSON-RPC servers on port 0 play a public lane and a keyed lane.
//
//   * publics serve: the keyed lane is never touched
//   * a public 429 (HTTP or JSON-RPC), timeout or NULL: the keyed lane serves,
//     and the Solana board's result is identical to a keyed-only run
//   * every lane down: the read throws and the board batch fails as before
//     (no silent zero, the cursor does not move)
//   * a keyed null is authoritative; a public null alone is not
//   * a rate-limited public lane cools down instead of being hammered
//   * per-lane counters, the public one-word status, lane order and rollback
import { createServer } from "node:http";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYTO = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
const FAC = "FacilitatorAccount11111111111111111111111111";
const now = Math.floor(Date.now() / 1000);
const SIGS = Array.from({ length: 30 }, (_, i) => `sig${i}`);
const txFor = (sig) => {
  const i = Number(sig.slice(3));
  const selfFunded = i % 7 === 6;
  const amt = 1000 + i * 10;
  return { blockTime: now - 60 * (i + 1), meta: { err: null,
    preTokenBalances: [{ accountIndex: 0, mint: USDC, owner: PAYTO, uiTokenAmount: { amount: "1000" } }, { accountIndex: 1, mint: USDC, owner: selfFunded ? PAYTO : FAC, uiTokenAmount: { amount: "900000" } }],
    postTokenBalances: [{ accountIndex: 0, mint: USDC, owner: PAYTO, uiTokenAmount: { amount: String(1000 + amt) } }, { accountIndex: 1, mint: USDC, owner: selfFunded ? PAYTO : FAC, uiTokenAmount: { amount: String(900000 - amt) } }] } };
};

// A stub lane. `mode` (ok | http429 | rpc429 | null | hang | error) applies to
// getTransaction; account and signature reads always answer.
function stubLane(name) {
  const lane = { name, mode: "ok", hits: 0, txHits: 0, nullFor: new Set(), server: null, url: "" };
  lane.server = createServer((req, res) => {
    let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
      lane.hits++;
      const { method, params } = JSON.parse(body);
      const send = (o, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (method === "getTransaction") lane.txHits++;
      if (method === "getTransaction" && lane.mode === "hang") return;                           // never answers; the client times out
      if (method === "getTransaction" && lane.mode === "http429") { res.statusCode = 429; res.setHeader("retry-after", "1"); return res.end("Too Many Requests"); }
      if (method === "getTransaction" && lane.mode === "rpc429") return send({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "rate limit exceeded" } });
      if (method === "getTransaction" && lane.mode === "error") return send({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "internal" } }, 500);
      if (method === "getTokenAccountsByOwner") return send({ jsonrpc: "2.0", id: 1, result: { value: [{ pubkey: "ATA-1", account: {} }] } });
      if (method === "getSignaturesForAddress") {
        const until = params[1]?.until;
        let list = SIGS.map((signature, i) => ({ signature, blockTime: now - 60 * (i + 1), err: null }));
        if (until) list = list.slice(0, list.findIndex((s) => s.signature === until));
        return send({ jsonrpc: "2.0", id: 1, result: list });
      }
      if (method === "getTransaction") {
        if (lane.mode === "null" || lane.nullFor.has(params[0])) return send({ jsonrpc: "2.0", id: 1, result: null });
        return send({ jsonrpc: "2.0", id: 1, result: txFor(params[0]) });
      }
      send({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown" } });
    });
  });
  return lane;
}
const pub = stubLane("public"), keyed = stubLane("keyed");
for (const l of [pub, keyed]) {
  await new Promise((r) => l.server.listen(0, "127.0.0.1", r));
  l.url = `http://127.0.0.1:${l.server.address().port}`;
}
// A lane nobody listens on: bind, read the port, close.
const dead = createServer(); await new Promise((r) => dead.listen(0, "127.0.0.1", r));
const deadUrl = `http://127.0.0.1:${dead.address().port}`; await new Promise((r) => dead.close(r));

process.env.SOLANA_HISTORY_PUBLIC_RPS = "1000";   // pacing has its own case below
const H = await import("../src/solana-history-rpc.js");
const { readPayToIncremental } = await import("../src/solana-leaderboard.js");
const { creditFromTx } = await import("../src/solana-buyer.js");

const LANES = () => [{ url: pub.url, keyed: false }, { url: keyed.url, keyed: true }];
const opts = { lanes: LANES(), publicTimeoutMs: 400, timeoutMs: 2000, maxWaitMs: 10_000 };
const reset = () => { H.__resetSolanaHistoryForTest(); for (const l of [pub, keyed]) { l.mode = "ok"; l.hits = 0; l.txHits = 0; l.nullFor.clear(); } };
const TXARGS = { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 };

// The board, read the way the server reads it: getTransaction through the
// history lanes, the signature and account reads straight to the keyed stub.
const direct = (url) => async (method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error("rpc error " + j.error.message); return j.result;
};
async function board(rpc) {
  const st = {};
  const r = await readPayToIncremental(PAYTO, st, { rpc, creditFromTx, budget: { left: 1000 }, backfillDays: 1, txConcurrency: 6 });
  return { r: JSON.stringify({ credits: r.credits, payers: r.payers, windows: r.windows, skipped: r.skipped }), hours: JSON.stringify(st.hours), lastSig: st.lastSig };
}

// ---- 0. the keyed-only baseline -------------------------------------------
reset();
const baseline = await board(direct(keyed.url));
ok(JSON.parse(baseline.r).credits > 0, `baseline: the keyed lane alone yields a board with credits (${JSON.parse(baseline.r).credits})`);

// ---- 1. publics serve: the keyed lane is untouched ------------------------
{
  reset();
  const b = await board(H.historyAwareRpc(direct(pub.url), opts));
  ok(keyed.hits === 0, `publics serve every read: the keyed lane saw ${keyed.hits} requests`);
  ok(b.r === baseline.r && b.hours === baseline.hours && b.lastSig === baseline.lastSig, "the board is identical to the keyed-only board");
  const s = H.solanaHistoryStatus({ full: true });
  const pl = H.laneLabel(pub.url);
  ok(s.lanes[pl]?.served === SIGS.length && !s.lanes[H.laneLabel(keyed.url)], `counter: the public lane served ${s.lanes[pl]?.served} of ${SIGS.length}, the keyed lane none`);
  ok(s.publicShare === 1 && s.status === "publics", `publicShare 1 and status "publics" (${s.publicShare}, ${s.status})`);
}

// ---- 2. public failure modes: the keyed lane serves, the board is identical ---
for (const mode of ["http429", "rpc429", "null", "hang", "error"]) {
  reset();
  pub.mode = mode;
  const t0 = Date.now();
  const b = await board(H.historyAwareRpc(direct(keyed.url), opts));
  ok(b.r === baseline.r && b.hours === baseline.hours && b.lastSig === baseline.lastSig, `public ${mode}: the board is identical to the keyed-only board (${Date.now() - t0} ms)`);
  ok(keyed.txHits === SIGS.length, `public ${mode}: the keyed lane served all ${SIGS.length} transaction reads (${keyed.txHits})`);
  const s = H.solanaHistoryStatus({ full: true });
  const c = s.lanes[H.laneLabel(pub.url)] || {};
  const field = { http429: "rateLimited", rpc429: "rateLimited", null: "nulls", hang: "failed", error: "failed" }[mode];
  ok(c[field] > 0 && s.status === "fallback", `public ${mode}: counted under ${field} (${JSON.stringify(c)}), status "fallback"`);
  if (mode !== "null") ok(pub.txHits < SIGS.length / 2, `public ${mode}: the lane cooled down instead of taking every read (${pub.txHits} of ${SIGS.length} reached it)`);
}

// ---- 3. a NULL for one existing transaction falls through ------------------
{
  // One read, no caller retry to hide behind: a rate-limited public lane
  // hands that same read to the keyed lane.
  for (const mode of ["http429", "rpc429"]) {
    reset();
    pub.mode = mode;
    let tx = null, err = null;
    try { tx = await H.solanaHistoryRead("getTransaction", ["sig2", TXARGS], opts); } catch (e) { err = e; }
    ok(!err && tx?.meta && pub.txHits === 1 && keyed.txHits === 1, `a single read rate-limited by the public lane (${mode}) is served by the keyed lane in the same call${err ? ` (threw ${err.message})` : ""}`);
  }
  reset();
  pub.nullFor.add("sig3");
  const tx = await H.solanaHistoryRead("getTransaction", ["sig3", TXARGS], opts);
  ok(tx && tx.meta && keyed.txHits === 1, "a public null is not 'no transaction': the keyed lane is asked and its answer returned");
  reset();
  keyed.nullFor.add("sig4");
  pub.mode = "null";
  ok(await H.solanaHistoryRead("getTransaction", ["sig4", TXARGS], opts) === null, "a keyed null is authoritative");
  reset();
  pub.mode = "null"; keyed.mode = "error";
  let threw = false; try { await H.solanaHistoryRead("getTransaction", ["sig5", TXARGS], opts); } catch { threw = true; }
  ok(threw, "a public null with the keyed lane failing THROWS (the batch retries), never a null");
  reset();
  pub.mode = "null";
  ok(await H.solanaHistoryRead("getTransaction", ["sig6", TXARGS], { ...opts, lanes: [{ url: pub.url, keyed: false }] }) === null, "with no keyed lane configured, a public null is returned as before");
}

// ---- 4. every lane down: the batch fails, nothing is folded ----------------
{
  reset();
  pub.mode = "error"; keyed.mode = "error";
  const st = {};
  let threw = false;
  try { await readPayToIncremental(PAYTO, st, { rpc: H.historyAwareRpc(async (m, p) => { if (m === "getTransaction") throw new Error("unreachable"); return direct(pub.url)(m, p); }, opts), creditFromTx, budget: { left: 1000 }, backfillDays: 1 }); }
  catch { threw = true; }
  ok(threw && !st.lastSig && Object.keys(st.hours || {}).length === 0, "every lane down: the read throws, nothing is folded and the cursor does not move (no silent zero)");
  const deadLanes = [{ url: deadUrl, keyed: false }, { url: deadUrl.replace("127.0.0.1", "localhost"), keyed: true }];
  let threw2 = false;
  try { await H.solanaHistoryRead("getTransaction", ["sig1", TXARGS], { ...opts, lanes: deadLanes }); } catch (e) { threw2 = /every lane/.test(e.message); }
  ok(threw2, "connection refused on every lane: throws, naming the lanes");
  const s = H.solanaHistoryStatus({ full: true });
  ok(s.failedEveryLane >= 1, `failedEveryLane counted (${s.failedEveryLane})`);
}

// ---- 5. pacing: a public lane is not asked faster than its rate -------------
// (Reads still in flight from the failed batch above settle first.)
await new Promise((r) => setTimeout(r, 1500));
{
  reset();
  process.env.SOLANA_HISTORY_PUBLIC_RPS = "20";
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 10 }, (_, i) => H.solanaHistoryRead("getTransaction", [`sig${i}`, TXARGS], opts)));
  const ms = Date.now() - t0;
  ok(ms >= 400 && pub.txHits === 10 && keyed.txHits === 0, `ten concurrent reads at 20/s are spread out (${ms} ms) and all served by the public lane (${pub.txHits}/${keyed.txHits})`);
  reset();
  process.env.SOLANA_HISTORY_PUBLIC_RPS = "2";
  await Promise.all(Array.from({ length: 6 }, (_, i) => H.solanaHistoryRead("getTransaction", [`sig${i}`, TXARGS], { ...opts, maxWaitMs: 600 })));
  ok(pub.txHits >= 1 && pub.txHits < 6 && keyed.txHits === 6 - pub.txHits, `past maxWaitMs a read skips the paced lane to the keyed one (${pub.txHits} public, ${keyed.txHits} keyed)`);
  process.env.SOLANA_HISTORY_PUBLIC_RPS = "1000";
}

// ---- 6. cache: a finalized transaction is read once ------------------------
{
  reset();
  await H.solanaHistoryRead("getTransaction", ["sig9", TXARGS], opts);
  await H.solanaHistoryRead("getTransaction", ["sig9", TXARGS], opts);
  ok(pub.txHits === 1 && H.solanaHistoryStatus({ full: true }).cacheHits === 1, "a repeated read of the same signature is served from the cache");
  pub.mode = "null";
  await H.solanaHistoryRead("getTransaction", ["sig10", TXARGS], { ...opts, lanes: [{ url: pub.url, keyed: false }] });
  await H.solanaHistoryRead("getTransaction", ["sig10", TXARGS], { ...opts, lanes: [{ url: pub.url, keyed: false }] });
  ok(pub.txHits === 3, "a null is never cached");
}

// ---- 7. keyedFirst (the deadline-bound revenue reads) ----------------------
{
  reset();
  await H.solanaHistoryRead("getTransaction", ["sig11", TXARGS], { ...opts, keyedFirst: true });
  ok(keyed.txHits === 1 && pub.txHits === 0, "keyedFirst asks the keyed lane first");
  keyed.mode = "error";
  const tx = await H.solanaHistoryRead("getTransaction", ["sig12", TXARGS], { ...opts, keyedFirst: true });
  ok(tx && pub.txHits === 1, "keyedFirst still falls back to the public lane");
}

// ---- 8. public view is one word; operator view carries the counts ----------
{
  const p = H.solanaHistoryStatus();
  ok(Object.keys(p).join(",") === "status", `the public view is the status word only (${JSON.stringify(p)})`);
  reset();
  ok(H.solanaHistoryStatus().status === "idle", "idle before any read");
}

// ---- 9. lane order, env, rollback ------------------------------------------
{
  const KEY = "https://solana-mainnet.g.alchemy.com/v2/KEYXYZ";
  const env = { SOLANA_RPCS: `${KEY},https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com` };
  const order = H.solanaHistoryLanes(env).map((l) => `${H.laneLabel(l.url)}:${l.keyed ? "k" : "p"}`).join(" ");
  ok(order === "api.mainnet-beta.solana.com:p alchemy:k solana-rpc.publicnode.com:p", `default order: public mainnet, keyed, then the remaining fallback (${order})`);
  const rb = H.solanaHistoryLanes({ ...env, SOLANA_HISTORY_ALCHEMY_FIRST: "on" }).map((l) => H.laneLabel(l.url)).join(" ");
  ok(rb === "alchemy api.mainnet-beta.solana.com solana-rpc.publicnode.com", `SOLANA_HISTORY_ALCHEMY_FIRST=on restores keyed-first (${rb})`);
  const withUrl = H.solanaHistoryLanes({ SOLANA_RPCS: "https://api.mainnet-beta.solana.com", SOLANA_RPC_URL: "https://rpc.example.org/k" });
  ok(withUrl.length === 2 && withUrl[1].keyed && withUrl[1].url === "https://rpc.example.org/k", "SOLANA_RPC_URL (the board's configured lane) joins as keyed");
  ok(!H.laneLabel(KEY).includes("KEYXYZ"), "a lane label never carries the key");
  const own = H.solanaHistoryLanes({ SOLANA_RPCS: KEY, SOLANA_HISTORY_PUBLIC_RPCS: "" });
  ok(own.length === 1 && own[0].keyed, "SOLANA_HISTORY_PUBLIC_RPCS='' leaves only the keyed lane");
}

for (const l of [pub, keyed]) { l.server.closeAllConnections?.(); l.server.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
