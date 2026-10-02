// Offline tests for the MPP leaderboard (src/mpp-leaderboard.js) and the
// live-offer capture it ranks on (src/mpp-index.js parseOffers). Stub RPC,
// no network, no server boot.
//
// What must hold, and why each is pinned:
//  - the recipient comes from the seller's LIVE challenge (mppx codec), never
//    the registry - a registry can name any address; the 402 names where the
//    seller is actually paid;
//  - one batched eth_getLogs per block chunk with EVERY recipient in topics[2]
//    (never one query per seller - ~140 sellers would be ~140 calls a refresh);
//  - counts, distinct payers and volume are grouped by the `to` topic, so a
//    transfer to a recipient nobody advertises is ignored, two sellers sharing
//    a recipient share one row, and our own recipient is a self-flagged row;
//  - a chunk that errors is split, and a failure that survives splitting keeps
//    the PREVIOUS snapshot up (marked stale with the error) - a blank board on
//    one bad RPC minute reads as "nobody is selling";
//  - the read primes the router's proven-seller cache, so a routed buy to a
//    ranked seller does not re-scan the chain;
//  - the page renders the ranking and marks routable rows, and the JSON shape
//    stays what /api/mpp-leaderboard consumers see.
import { parseOffers } from "../src/mpp-index.js";
import { rankableRecipients, computeMppLeaderboard, refreshMppLeaderboard, mppLeaderboardSnapshot, __testReset, MPP_LB_WINDOW_BLOCKS } from "../src/mpp-leaderboard.js";
import { tempoInboundCount, __testResetProofCache, TEMPO_USDC } from "../src/tempo-buyer.js";
import { mppMarketPage } from "../src/mpp-market-page.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222", C = "0x3333333333333333333333333333333333333333", SELF = "0x4444444444444444444444444444444444444444", NOBODY = "0x5555555555555555555555555555555555555555";
const P1 = "0xaaaa000000000000000000000000000000000001", P2 = "0xaaaa000000000000000000000000000000000002", P3 = "0xaaaa000000000000000000000000000000000003";
const USDC = TEMPO_USDC.toLowerCase();
const xfer = (from, to, atomic) => ({ topics: [T, topic(from), topic(to)], data: "0x" + BigInt(atomic).toString(16) });

// --- 1. live-offer capture -----------------------------------------------------
{
  const req = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = `Payment id="c1", realm="s", method="tempo", intent="charge", request="${req({ amount: "1000", currency: TEMPO_USDC, recipient: A, methodDetails: { chainId: 4217 } })}", Payment id="c2", realm="s", method="evm", intent="charge", request="${req({ amount: "1000", currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", recipient: B, methodDetails: { chainId: 8453 } })}"`;
  const offers = await parseOffers(header);
  ok(offers.length === 2, `parseOffers reads every challenge on the header (${offers.length})`);
  ok(offers[0].method === "tempo" && offers[0].recipient === A && offers[0].currency === USDC && offers[0].chainId === 4217 && offers[0].amount === "1000", "tempo/charge offer: recipient lower-cased, currency, chain 4217, amount");
  ok(offers[1].method === "evm" && offers[1].recipient === B.toLowerCase() && offers[1].chainId === 8453, "evm offer captured too (recipient on Base)");
  const junk = await parseOffers("Payment garbage");
  ok(Array.isArray(junk) && junk.length === 0, "an unparseable challenge yields [] and never throws (a leaderboard gap must not demote a listing)");
  const badRecipient = await parseOffers(`Payment id="c3", realm="s", method="tempo", intent="charge", request="${req({ amount: "1", currency: TEMPO_USDC, recipient: "not-an-address" })}"`);
  ok(badRecipient.length === 1 && badRecipient[0].recipient === null, "a malformed recipient is null, not ranked");
}

// --- 2. rankable recipients ------------------------------------------------------
const seller = (name, origin, offers, verified = true) => ({ name, origin, serviceUrl: origin, url: origin, verified, verifiedAt: 1, lastProbeAt: 1, endpoints: [], offers });
const snap = {
  verifiedSellers: 5, discoveredTotal: 6,
  sellers: [
    seller("Alpha", "https://alpha.example", [{ method: "tempo", intent: "charge", recipient: A, currency: USDC, chainId: 4217 }]),
    seller("Alpha Pro", "https://pro.alpha.example", [{ method: "tempo", intent: "charge", recipient: A, currency: USDC, chainId: 4217 }]), // shares A's recipient
    seller("Beta", "https://beta.example", [{ method: "tempo", intent: "charge", recipient: B, currency: USDC, chainId: 4217 }]),
    seller("Gamma", "https://gamma.example", [{ method: "tempo", intent: "charge", recipient: C, currency: USDC, chainId: 4217 }]),
    seller("Delta-evm-only", "https://delta.example", [{ method: "evm", intent: "charge", recipient: NOBODY, currency: "0x8335", chainId: 8453 }]),
    seller("Eps-pathusd", "https://eps.example", [{ method: "tempo", intent: "charge", recipient: NOBODY, currency: "0x20c0000000000000000000000000000000000000", chainId: 4217 }]),
    seller("Sigma-session", "https://sigma.example", [{ method: "tempo", intent: "session", recipient: C, currency: USDC, chainId: 4217 }]), // session-only on Gamma's recipient? no - its own intent list on C
    seller("Zeta-unverified", "https://zeta.example", [{ method: "tempo", intent: "charge", recipient: NOBODY, currency: USDC, chainId: 4217 }], false),
  ],
};
{
  const rows = rankableRecipients(snap, { self: SELF });
  const keys = rows.map((r) => r.recipient).sort();
  ok(keys.join(",") === [A, B, C, SELF].map((x) => x.toLowerCase()).sort().join(","), "rankable = verified tempo/charge USDC.e recipients + self; evm-only, PathUSD-only and unverified are excluded");
  const a = rows.find((r) => r.recipient === A.toLowerCase());
  ok(a.sellers.length === 2 && a.sellers.map((s) => s.name).sort().join(",") === "Alpha,Alpha Pro", "two sellers sharing one recipient collapse to one row naming both");
  const c = rows.find((r) => r.recipient === C.toLowerCase());
  ok(c.intents.slice().sort().join(",") === "charge,session" && c.sellers.length === 2, "tempo/session sellers rank too (paid to the same kind of recipient); intents are recorded per row");
  ok(rows.find((r) => r.recipient === SELF.toLowerCase()).self === true && !a.self, "our own recipient is a self-flagged row; others are not");
}

// --- 3. batched read, grouping, ranking, priming --------------------------------
{
  __testResetProofCache();
  const calls = [];
  const LATEST = 200_000;
  const logsAll = [
    ...Array.from({ length: 30 }, (_, i) => xfer([P1, P2, P3][i % 3], A, 1000)),  // A: 30 transfers, 3 payers, $0.03
    ...Array.from({ length: 5 }, () => xfer(P3, B, 250_000)),                     // B: 5 transfers, 1 payer, $1.25
    xfer(P1, SELF, 1000),                                                          // self: 1 transfer
    xfer(P1, NOBODY, 999_999_999),                                                 // to an address nobody advertises: ignored
    { topics: [T, topic(P2), topic(C)], data: "0xzz" },                             // C: malformed data - counted, amount skipped
  ];
  const rpcFn = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_blockNumber") return "0x" + LATEST.toString(16);
    if (method === "eth_getLogs") {
      const f = params[0];
      ok(f.address === TEMPO_USDC && f.topics[0] === T && f.topics[1] === null && Array.isArray(f.topics[2]), "getLogs filter: USDC.e address, Transfer topic, any payer, recipient list") ;
      // return everything on the first chunk only (a real chain spreads them; the sum is what matters)
      return parseInt(f.fromBlock, 16) === LATEST - MPP_LB_WINDOW_BLOCKS + 1 ? logsAll : [];
    }
    throw new Error("unexpected " + method);
  };
  const lb = await computeMppLeaderboard({ snapshot: snap, rpcFn, now: 1_000_000, self: SELF });
  const getLogs = calls.filter((c) => c.method === "eth_getLogs");
  ok(getLogs.length === 3, `one batched getLogs per 33k-block chunk over 99k blocks (${getLogs.length} calls, not one per seller)`);
  ok(getLogs.every((c) => c.params[0].topics[2].length === 4), "every chunk carries EVERY rankable recipient in topics[2]");
  ok(lb.window.fromBlock === LATEST - MPP_LB_WINDOW_BLOCKS + 1 && lb.window.toBlock === LATEST && lb.window.blocks === MPP_LB_WINDOW_BLOCKS, "window = exactly the last 99k blocks (under the rpc cap) ending at latest");
  const byR = Object.fromEntries(lb.rows.map((r) => [r.recipient, r]));
  ok(byR[A.toLowerCase()].transfers === 30 && byR[A.toLowerCase()].payers === 3 && Math.abs(byR[A.toLowerCase()].volumeUsdc - 0.03) < 1e-9, "A: 30 transfers, 3 distinct payers, $0.03 volume");
  ok(byR[B.toLowerCase()].transfers === 5 && byR[B.toLowerCase()].payers === 1 && Math.abs(byR[B.toLowerCase()].volumeUsdc - 1.25) < 1e-9, "B: 5 transfers, 1 payer, $1.25");
  ok(byR[C.toLowerCase()].transfers === 1 && byR[C.toLowerCase()].volumeUsdc === 0, "C: malformed data still counts the transfer, skips the amount");
  ok(byR[SELF.toLowerCase()].transfers === 1 && byR[SELF.toLowerCase()].self === true, "self row counted like everyone else");
  ok(!byR[NOBODY.toLowerCase()], "a transfer to an unadvertised address is ignored");
  ok(lb.rows.map((r) => r.rank).join(",") === "1,2,3,4" && lb.rows[0].recipient === A.toLowerCase() && lb.rows[1].recipient === B.toLowerCase(), "ranked by transfers desc (A, B, then the 1-transfer rows), ranks 1..n");
  ok(lb.rows[0].proven === true && lb.rows[0].routable === true && lb.rows[1].proven === false && lb.rows[1].routable === false && lb.provenFloor === 20, "proven = transfers >= router floor (default 20) and >= 3 distinct payers: A yes, B no; routable follows when a charge offer exists");
  {
    const sessionOnly = { sellers: [seller("S", "https://s.example", [{ method: "tempo", intent: "session", recipient: B, currency: USDC, chainId: 4217 }])] };
    const rpc2 = async (m, p) => m === "eth_blockNumber" ? "0x" + LATEST.toString(16) : (parseInt(p[0].fromBlock, 16) === LATEST - MPP_LB_WINDOW_BLOCKS + 1 ? Array.from({ length: 25 }, (_, i) => xfer([P1, P2, P3][i % 3], B, 1000)) : []);
    const lb2 = await computeMppLeaderboard({ snapshot: sessionOnly, rpcFn: rpc2, now: 1, self: null });
    ok(lb2.rows[0].proven === true && lb2.rows[0].routable === false, "a session-only recipient over the floor is proven but NOT routable (the router pays tempo/charge only)");
  }
  // Ecosystem totals exclude our own self row (cost audit 2026-08-19: at
  // ~1,000 self-buys/day the self row would be most of "the MPP economy").
  ok(lb.recipients === 4 && lb.activeRecipients === 3 && lb.totals.transfers === 36 && Math.abs(lb.totals.volumeUsdc - 1.28) < 1e-9 && lb.totals.selfTransfers === 1, `totals over active EXTERNAL recipients (30+5+1 transfers, $0.03+$1.25+$0), self row (1 transfer) reported separately (got ${lb.totals.transfers}/${lb.activeRecipients}/self ${lb.totals.selfTransfers})`);
  // THE PAYER FLOOR (2026-09-28). The same transfer count from two wallets,
  // or with the recipient paying itself, is not proven: the count alone was
  // cheap to reach from wallets the seller holds.
  {
    const FAKE = [
      ...Array.from({ length: 30 }, (_, i) => xfer(i % 2 ? P1 : P2, B, 1000)),     // 30 transfers, 2 payers
      ...Array.from({ length: 30 }, () => xfer(B, B, 1000)),                         // + 30 from itself
    ];
    const rpc3 = async (m, p) => m === "eth_blockNumber" ? "0x" + LATEST.toString(16) : (parseInt(p[0].fromBlock, 16) === LATEST - MPP_LB_WINDOW_BLOCKS + 1 ? FAKE : []);
    const one = { sellers: [seller("F", "https://f.example", [{ method: "tempo", intent: "charge", recipient: B, currency: USDC, chainId: 4217 }])] };
    const lb3 = await computeMppLeaderboard({ snapshot: one, rpcFn: rpc3, now: 1, self: null });
    ok(lb3.rows[0].transfers === 60 && lb3.rows[0].evidencePayers === 2 && lb3.rows[0].proven === false && lb3.rows[0].routable === false,
       "60 transfers from two wallets plus the recipient itself are NOT proven: the payer floor excludes the recipient and needs 3 distinct payers");
    const HONEST = Array.from({ length: 30 }, (_, i) => xfer([P1, P2, P3][i % 3], B, 1000));
    const rpc4 = async (m, p) => m === "eth_blockNumber" ? "0x" + LATEST.toString(16) : (parseInt(p[0].fromBlock, 16) === LATEST - MPP_LB_WINDOW_BLOCKS + 1 ? HONEST : []);
    const lb4 = await computeMppLeaderboard({ snapshot: one, rpcFn: rpc4, now: 1, self: null });
    ok(lb4.rows[0].proven === true && lb4.rows[0].routable === true, "control: the same count from three outside payers is proven and routable");
  }
  // priming: the router's gate now answers from cache without an RPC
  const before = calls.length;
  const n = await tempoInboundCount(A, { rpcFn: async () => { throw new Error("must not be called"); }, now: 1_000_000 + 1000 });
  ok(n === 30 && calls.length === before, "the read primes tempo-buyer's proven-seller cache (no re-scan for a routed buy)");
}

// --- 4. chunk splitting + failure keeps the previous snapshot -----------------
{
  __testReset();
  const LATEST = 150_000;
  let mode = "ok";
  const seen = [];
  const rpcFn = async (method, params) => {
    if (method === "eth_blockNumber") return "0x" + LATEST.toString(16);
    const f = params[0]; const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    seen.push(to - from + 1);
    if (mode === "big-chunk-fails" && to - from + 1 > 20_000) throw new Error("response too large");
    if (mode === "dead") throw new Error("rpc down");
    return from === LATEST - MPP_LB_WINDOW_BLOCKS + 1 ? [xfer(P1, A, 1000), xfer(P1, A, 1000)] : [];
  };
  mode = "big-chunk-fails";
  const lb = await computeMppLeaderboard({ snapshot: snap, rpcFn, now: 5, self: null });
  ok(seen.some((n) => n > 20_000) && seen.some((n) => n <= 20_000) && lb.rows[0].transfers === 2, "an oversized chunk is split until it succeeds; the result is complete");
  // scheduler path: first good, then dead RPC keeps the last good board (stale + error)
  seen.length = 0; mode = "ok";
  const first = await refreshMppLeaderboard({ snapshot: snap, rpcFn, now: 10, self: null });
  ok(first.rows.length === 3 && first.rows[0].transfers === 2 && mppLeaderboardSnapshot(11).stale === false, "refresh publishes a fresh snapshot");
  ok(mppLeaderboardSnapshot(11).provenMinPayers === 3 && mppLeaderboardSnapshot(11).provenFloor === 20, "the snapshot carries the payer rule beside the transfer floor");
  mode = "dead";
  const second = await refreshMppLeaderboard({ snapshot: snap, rpcFn, now: 20, self: null });
  ok(second.rows.length === 3 && second.rows[0].transfers === 2 && /rpc down/.test(second.lastError || ""), "an RPC failure keeps the PREVIOUS board up and records the error");
  ok(mppLeaderboardSnapshot(20 + 4 * 60 * 60 * 1000).stale === true, "a board that has not been rebuilt in 90 min reads stale at read time");
  __testReset();
  ok(mppLeaderboardSnapshot().rows.length === 0 && mppLeaderboardSnapshot().stale === true, "cold snapshot is empty + stale, never fabricated");
}

// --- 4b. rolling history: only NEW blocks fold per refresh; 7d/30d sum buckets ---
{
  const { foldHistory, historySum, emptyHistory } = await import("../src/mpp-leaderboard.js");
  const DAY = 86400e3;
  const t0 = Date.UTC(2026, 7, 18, 12); // 2026-08-18T12:00Z
  const lg = (bn, atomic = 1000) => ({ topics: [T, topic(P1), topic(A)], data: "0x" + BigInt(atomic).toString(16), blockNumber: "0x" + bn.toString(16) });
  const a = A.toLowerCase();
  // refresh 1: cold cursor, window [1000, 1099]: 3 transfers seed today
  let h = foldHistory(emptyHistory(), new Map([[a, [lg(1000), lg(1050), lg(1099)]]]), { latest: 1099, from: 1000, now: t0 });
  ok(h.cursor === 1099 && h.days["2026-08-18"][a].t === 3 && h.days["2026-08-18"][a].v === "3000", "first refresh seeds today's bucket with the whole window and sets the cursor to latest");
  // refresh 2 (30 min later): window [1010, 1109] overlaps; only blocks > 1099 are new
  h = foldHistory(h, new Map([[a, [lg(1050), lg(1099), lg(1100), lg(1109)]]]), { latest: 1109, from: 1010, now: t0 + 1800e3 });
  ok(h.days["2026-08-18"][a].t === 5 && h.cursor === 1109 && h.gaps === 0, "overlapping window: only blocks above the cursor are added (3 + 2 new = 5), no double count");
  // refresh 3: next UTC day
  h = foldHistory(h, new Map([[a, [lg(1200), lg(1201)]]]), { latest: 1300, from: 1110, now: t0 + DAY });
  ok(h.days["2026-08-19"][a].t === 2 && h.days["2026-08-18"][a].t === 5, "a new UTC day opens a new bucket; earlier buckets are untouched");
  ok(historySum(h, a, 7, t0 + DAY).transfers === 7 && historySum(h, a, 1, t0 + DAY).transfers === 2 && Math.abs(historySum(h, a, 7, t0 + DAY).volumeUsdc - 0.007) < 1e-12, "historySum rolls the last N days inclusive of today (7d = 7 transfers / $0.007, 1d = 2)");
  // refresh 4: window moved past the cursor (RPC was down longer than the window): gap counted, blocks between never invented
  h = foldHistory(h, new Map([[a, [lg(5000)]]]), { latest: 5099, from: 5000, now: t0 + DAY + 3600e3 });
  ok(h.gaps === 1 && h.days["2026-08-19"][a].t === 3, "a refresh whose window starts above the cursor counts a gap and folds only what it saw");
  // pruning: buckets older than 30 days drop
  h.days["2026-07-01"] = { [a]: { t: 999, v: "1" } };
  h = foldHistory(h, new Map(), { latest: 5100, from: 5001, now: t0 + DAY + 7200e3 });
  ok(!h.days["2026-07-01"] && historySum(h, a, 30, t0 + DAY + 7200e3).transfers === 8, "buckets beyond 30 days are pruned; 30d sum covers what remains");
  // through computeMppLeaderboard: history rides in and out, ranking prefers 7d
  const LATEST = 300_000;
  const bnA = (i) => LATEST - MPP_LB_WINDOW_BLOCKS + 1 + i;
  const rpcFn = async (m, p) => m === "eth_blockNumber" ? "0x" + LATEST.toString(16)
    : (parseInt(p[0].fromBlock, 16) === LATEST - MPP_LB_WINDOW_BLOCKS + 1 ? [
        { topics: [T, topic(P1), topic(B)], data: "0x3e8", blockNumber: "0x" + bnA(1).toString(16) },
        { topics: [T, topic(P1), topic(B)], data: "0x3e8", blockNumber: "0x" + bnA(2).toString(16) },
        { topics: [T, topic(P2), topic(A)], data: "0x3e8", blockNumber: "0x" + bnA(3).toString(16) },
      ] : []);
  const seeded = { cursor: LATEST - MPP_LB_WINDOW_BLOCKS, gaps: 0, days: { [new Date(t0 - 2 * DAY).toISOString().slice(0, 10)]: { [a]: { t: 500, v: "500000" } } } };
  const lb = await computeMppLeaderboard({ snapshot: snap, rpcFn, now: t0, self: null, history: seeded });
  const rA = lb.rows.find((r) => r.recipient === a), rB = lb.rows.find((r) => r.recipient === B.toLowerCase());
  ok(rA.transfers === 1 && rA.d7.transfers === 501 && rB.transfers === 2 && rB.d7.transfers === 2, "d7 = prior buckets + this refresh's new blocks; window counts stay the window");
  ok(rA.rank === 1 && rB.rank === 2, "ranking is by 7d transfers first (A: 501 beats B: 2 despite B leading the window)");
  ok(lb.history.cursor === LATEST && lb.history.daysCovered === 2 && lb.history.since === new Date(t0 - 2 * DAY).toISOString().slice(0, 10) && lb.totals.d7Transfers === 503, "history rides out with cursor/daysCovered/since; totals carry d7");
  // scheduler carries history across refreshes without the caller passing it
  __testReset();
  const first = await refreshMppLeaderboard({ snapshot: snap, rpcFn, now: t0, self: null });
  const second = await refreshMppLeaderboard({ snapshot: snap, rpcFn, now: t0 + 1800e3, self: null });
  ok(first.rows.find((r) => r.recipient === a).d7.transfers === 1 && second.rows.find((r) => r.recipient === a).d7.transfers === 1 && second.history.cursor === LATEST, "refresh threads the previous history through: a re-read of the same blocks adds nothing");
  __testReset();
}

// --- 5. page --------------------------------------------------------------------
{
  const lb = { generatedAt: Date.now(), window: { fromBlock: 1, toBlock: 99_000, blocks: 99_000, approxHours: 15.4 }, provenFloor: 20, stale: false, lastError: null,
    rows: [
      { rank: 1, recipient: A.toLowerCase(), sellers: [{ name: "Alpha", origin: "https://alpha.example", url: "https://alpha.example" }, { name: "Alpha Pro", origin: "https://pro.alpha.example", url: "https://pro.alpha.example" }], intents: ["charge"], self: false, transfers: 4184, payers: 40, volumeUsdc: 41.84, d7: { transfers: 20000, volumeUsdc: 200 }, d30: { transfers: 20000, volumeUsdc: 200 }, proven: true, routable: true },
      { rank: 2, recipient: SELF.toLowerCase(), sellers: [], intents: ["charge"], self: true, transfers: 3, payers: 1, volumeUsdc: 0.003, proven: false, routable: false },
      { rank: 3, recipient: C.toLowerCase(), sellers: Array.from({ length: 7 }, (_, i) => ({ name: `Gw${i}`, origin: `https://gw${i}.example`, url: `https://gw${i}.example` })), intents: ["session"], self: false, transfers: 50, payers: 5, volumeUsdc: 1, proven: true, routable: false },
      { rank: 4, recipient: B.toLowerCase(), sellers: [{ name: "Beta", origin: "https://beta.example", url: "https://beta.example" }], intents: ["charge"], self: false, transfers: 0, payers: 0, volumeUsdc: 0, proven: false, routable: false },
    ] };
  const html = mppMarketPage("https://x.test", snap, lb);
  ok(/MPP leaderboard/.test(html) && /id="leaderboard"/.test(html), "page renders the leaderboard section");
  ok(/Alpha<\/a>, <a[^>]*>Alpha Pro<\/a>/.test(html), "a shared recipient row names every seller behind it");
  // The host card says ranked rows never include the host: our own recipient
  // is left out of the ranked table and the ranks renumber over what shows.
  ok(!/\(this server\)/.test(html) && !/explore\.tempo\.xyz\/address\/${SELF.toLowerCase()}/.test(html), "our own recipient is not a ranked row");
  ok(/<td class="num">2<\/td>\s*<td><a[^>]*>Gw0/.test(html), "ranks renumber over the shown rows, leaving no gap where the host sat");
  // The router's real rule, not the floor alone.
  const lbRule = { ...lb, provenMinPayers: 3, rows: [...lb.rows, { rank: 5, recipient: "0x" + "9".repeat(40), sellers: [{ name: "Few", origin: "https://few.example", url: "https://few.example" }], intents: ["charge"], self: false, transfers: 40, payers: 2, evidencePayers: 2, volumeUsdc: 1, proven: false, routable: false }, { rank: 6, recipient: "0x" + "8".repeat(40), sellers: [{ name: "Small", origin: "https://small.example", url: "https://small.example" }], intents: ["charge"], self: false, transfers: 7, payers: 4, evidencePayers: 4, volumeUsdc: 0.1, proven: false, routable: false }] };
  const ruled = mppMarketPage("https://x.test", snap, lbRule);
  ok(/at least 20 inbound transfers in the window from at least 3 distinct payers other than the recipient, plus a tempo\/charge offer/.test(ruled) && !/floor 20 in the window =/.test(ruled), "the routable rule names the transfer floor, the payer rule and the charge offer");
  ok(/too few payers \(2 of 3\)/.test(ruled), "a row over the transfer floor but short on payers says that, not 'below floor'");
  ok(/below floor \(7 of 20 transfers\)/.test(ruled), "a row under the transfer floor says by how much");
  ok(!/Beta<\/a><div><a class="mlb-addr"/.test(html) && /1 more verified recipient with no inbound transfer/.test(html), "zero-transfer recipients are counted, not ranked");
  ok(/routable &middot; #1/.test(html), "the roster row for a proven seller carries its rank badge");
  ok(/Gw3<\/a> <span[^>]*>\+3 more on this recipient<\/span>/.test(html) && !/>Gw5</.test(html), "a shared recipient shows 4 names + a count, the rest in a title");
  ok(/session only/.test(html) && (html.match(/class="mpr-proven"/g) || []).length >= 1, "an over-floor session-only recipient is marked session only, never routable");
  ok(/href="\/api\/mpp-leaderboard"/.test(html) && /href="\/api\/mpp-index"/.test(html), "machine-readable links point at our own JSON, not only the upstream registry");
  ok(/explore\.tempo\.xyz\/address\/0x1111/.test(html), "recipient links to the Tempo explorer");
  ok(/<td class="num">20,000<\/td>/.test(html) && /Volume 7d/.test(html), "7d/30d columns render from the rolling history; volume column is 7d");
  const withHist = mppMarketPage("https://x.test", snap, { ...lb, history: { since: "2026-08-18", daysCovered: 3, gaps: 1, cursor: 1 } });
  ok(/since 2026-08-18 \(3 UTC days, 1 refresh gap lost blocks\)/.test(withHist), "history note states the coverage start, day count and any gaps - never reads as lifetime");
  const stale = mppMarketPage("https://x.test", snap, { ...lb, stale: true, lastError: "rpc down" });
  ok(/stale/.test(stale) && /rpc down/.test(stale), "a stale board says so, with the error");
  const none = mppMarketPage("https://x.test", snap, null);
  ok(/First on-chain read pending/.test(none), "no board yet is said plainly, not rendered as an empty ranking");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
