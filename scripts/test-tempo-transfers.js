// Tempo transfer feed (src/tempo-transfers.js) + its use as the MPP
// leaderboard's primary source (src/mpp-leaderboard.js). Offline: stub fetch.
import { emptyFeedState, foldTransfers, syncTempoTransfers, feedStats, feedHistoryDays, pruneFeedState, tempoFeedEnabled } from "../src/tempo-transfers.js";
import { computeMppLeaderboard, __testReset } from "../src/mpp-leaderboard.js";
import { TEMPO_USDC } from "../src/tempo-buyer.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("ok -", m); } else { fail++; console.log("FAIL -", m); } };
const R1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", R2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-08-19T18:00:00Z");
const tx = (id, recipient, sender, minutesAgo, units = "1000", token = TEMPO_USDC) => ({ id, transactionHash: `0x${id}`, logIndex: 0, blockNumber: 1, recipient, sender, timestamp: new Date(NOW - minutesAgo * 60e3).toISOString(), sourceAmount: { baseUnits: units, decimals: 6 }, sourceToken: { address: token } });

// ---- fold / stats / history ----
{
  const st = emptyFeedState();
  const added = foldTransfers(st, [tx("a", R1, "0x01", 10), tx("b", R1, "0x02", 20, "5000"), tx("c", R2, "0x01", 30), tx("a", R1, "0x01", 10), tx("d", R1, "0x03", 60 * 30), tx("e", R1, "0x09", 5, "1000", "0x20c0000000000000000000000000000000000000")], { token: TEMPO_USDC });
  ok(added === 4, `fold: 4 new (one duplicate id and one other-token transfer skipped) (got ${added})`);
  ok(st.cursorTs === new Date(NOW - 5 * 60e3).toISOString() || st.cursorTs === new Date(NOW - 10 * 60e3).toISOString(), `fold: cursor advances to the newest folded timestamp (${st.cursorTs})`);
  const s24 = feedStats(st, [R1, R2, "0xcccccccccccccccccccccccccccccccccccccccc"], { windowMs: 24 * 3600e3, now: NOW });
  ok(s24.get(R1).transfers === 2 && s24.get(R1).payers.size === 2 && s24.get(R1).volumeAtomic === 6000n, `stats 24h: R1 2 transfers, 2 payers, 6000 base units (30h-old one excluded) (got ${s24.get(R1).transfers}/${s24.get(R1).payers.size}/${s24.get(R1).volumeAtomic})`);
  ok(s24.get(R2).transfers === 1 && s24.get("0xcccccccccccccccccccccccccccccccccccccccc").transfers === 0, "stats: unknown recipient is 0, not missing");
  const s48 = feedStats(st, [R1], { windowMs: 48 * 3600e3, now: NOW });
  ok(s48.get(R1).transfers === 3, "stats 48h: the 30h-old transfer counts");
  const days = feedHistoryDays(st);
  ok(Object.keys(days).length === 2 && days["2026-08-19"][R1].t === 2 && days["2026-08-18"][R1].t === 1, `history days from hour buckets (${Object.keys(days).join(",")})`);
  const old = emptyFeedState(); foldTransfers(old, [tx("z", R1, "0x01", 60 * 24 * 40)]);
  pruneFeedState(old, NOW);
  ok(Object.keys(old.buckets).length === 0, "prune drops buckets past 31 days");
}

// ---- bounded state: untracked recipients keep counts only (no payer list) and
// are pruned after 48h; tracked ones keep full detail for 31 days ----
{
  const st = emptyFeedState();
  const track = new Set([R1]);
  foldTransfers(st, [tx("u1", R2, "0x01", 10), tx("u2", R2, "0x02", 10), tx("t1", R1, "0x01", 10), tx("u3", R2, "0x03", 60 * 60), tx("t2", R1, "0x03", 60 * 60)], { track });
  const hkNow = Object.keys(st.buckets).sort().pop();
  ok(st.buckets[hkNow][R2].t === 2 && st.buckets[hkNow][R2].p === undefined, "untracked recipient: counts kept, no payer list");
  ok(st.buckets[hkNow][R1].p.length === 1, "tracked recipient: payer list kept");
  ok(feedStats(st, [R2], { now: NOW }).get(R2).transfers === 2 && feedStats(st, [R2], { now: NOW }).get(R2).payers.size === 0, "stats on an untracked recipient: transfers count, payers 0 (not a throw)");
  ok(feedStats(st, [R2], { now: NOW }).get(R2).payersPartial === true && !feedStats(st, [R1], { now: NOW }).get(R1).payersPartial,
     "an hour kept as counts only marks the payer figure partial (the proven floor reads it as unknown, never as 0 payers); a tracked recipient is not partial");
  pruneFeedState(st, NOW, { track });
  ok(Object.values(st.buckets).some((b) => b[R2]), "prune at 48h: recent untracked buckets survive");
  pruneFeedState(st, NOW + 49 * 3600e3, { track });
  ok(!Object.values(st.buckets).some((b) => b[R2]) && Object.values(st.buckets).some((b) => b[R1]), "prune past 48h: untracked entries dropped, tracked entries kept");
}

// ---- sync with a stub API: cursor paging, overlap dedupe, first-page failure throws, mid-page failure keeps what it got ----
{
  const { feedCovers } = await import("../src/tempo-transfers.js");
  const st = emptyFeedState();
  const calls = [];
  const pages = {
    "": { data: Array.from({ length: 50 }, (_, i) => tx(`p1-${i}`, R1, "0x0" + (i % 3), 120 - i)), nextCursor: "c2" },
    c2: { data: [tx("p2-0", R2, "0x05", 60)], nextCursor: null },
  };
  const fetchImpl = async (url) => { const u = new URL(url); calls.push(u.searchParams.get("cursor") || ""); const page = pages[u.searchParams.get("cursor") || ""]; return { ok: true, status: 200, json: async () => page }; };
  const r = await syncTempoTransfers(st, { apiKey: "k", token: TEMPO_USDC, fetchImpl, now: NOW });
  ok(r.pages === 2 && r.added === 51 && r.complete === true && st.syncs === 1 && st.lastError === null, `sync: walked 2 pages via nextCursor, folded 51, complete (got ${JSON.stringify(r)})`);
  ok(calls[0] === "" && calls[1] === "c2", "sync: cursor passed back on the second page");
  ok(st.coverageFromTs === new Date(NOW - 24 * 3600e3).toISOString() && feedCovers(st, { windowMs: 24 * 3600e3, now: NOW }) === true, "coverage: a completed first sync with a 24h backfill covers a 24h window");
  ok(feedCovers(st, { windowMs: 48 * 3600e3, now: NOW }) === false, "coverage: not a 48h window");
  ok(feedCovers(st, { windowMs: 24 * 3600e3, now: NOW + 3 * 3600e3 }) === false, "coverage: lapses once the head is older than the lag bound (no sync for hours)");
  // second sync overlaps by 5 min and dedupes by id
  const before = st.cursorTs;
  const fetch2 = async (url) => { const u = new URL(url); const from = Date.parse(u.searchParams.get("timestamp.from")); ok(from <= Date.parse(before) - 4 * 60e3, "sync: re-reads with a 5-minute overlap"); return { ok: true, status: 200, json: async () => ({ data: [tx("p2-0", R2, "0x05", 60), tx("n1", R2, "0x06", 1)], nextCursor: null }) }; };
  const r2 = await syncTempoTransfers(st, { apiKey: "k", token: TEMPO_USDC, fetchImpl: fetch2, now: NOW });
  ok(r2.added === 1 && feedStats(st, [R2], { now: NOW }).get(R2).transfers === 2, "sync: overlap duplicates are dropped, new transfer folded");
  let threw = null; try { await syncTempoTransfers(emptyFeedState(), { apiKey: "k", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { code: "unauthorized" } }) }), now: NOW }); } catch (e) { threw = e; }
  ok(/HTTP 401/.test(threw?.message || ""), "sync: first page unreadable -> throws (caller falls back)");
  threw = null; try { await syncTempoTransfers(emptyFeedState(), { apiKey: "", fetchImpl: async () => ({}), now: NOW }); } catch (e) { threw = e; }
  ok(/TEMPO_DATA_API_KEY/.test(threw?.message || ""), "sync: no key -> throws");
  const st3 = emptyFeedState(); let n = 0;
  const r3 = await syncTempoTransfers(st3, { apiKey: "k", fetchImpl: async () => { n++; if (n === 1) return { ok: true, status: 200, json: async () => ({ data: Array.from({ length: 50 }, (_, i) => tx(`x${i}`, R1, "0x01", 3 + i)), nextCursor: "more" }) }; throw new Error("boom"); }, now: NOW });
  ok(r3.pages === 1 && r3.added === 50 && r3.complete === false && /boom/.test(st3.lastError), `sync: a mid-pagination failure keeps the folded page and records lastError (${JSON.stringify(r3)} ${st3.lastError})`);
  ok(feedCovers(st3, { windowMs: 24 * 3600e3, now: NOW }) === false, "coverage: an incomplete backfill (more pages pending, head hours behind) does not cover the window");
}

// ---- leaderboard uses the feed when given (no RPC call), RPC otherwise ----
{
  __testReset();
  const snapshot = { sellers: [
    { verified: true, serviceUrl: "https://a.example", name: "A", offers: [{ method: "tempo", intent: "charge", recipient: R1, currency: TEMPO_USDC.toLowerCase(), chainId: 4217 }], endpoints: [] },
    { verified: true, serviceUrl: "https://b.example", name: "B", offers: [{ method: "tempo", intent: "charge", recipient: R2, currency: TEMPO_USDC.toLowerCase(), chainId: 4217 }], endpoints: [] },
  ] };
  const feed = emptyFeedState();
  foldTransfers(feed, [...Array.from({ length: 25 }, (_, i) => tx(`f${i}`, R1, `0x${String(i % 4).padStart(2, "0")}`, 10 + i)), tx("g", R2, "0x07", 5)]);
  feed.syncs = 1; feed.lastSyncAt = NOW;
  let rpcCalls = 0;
  const lb = await computeMppLeaderboard({ snapshot, feed, now: NOW, rpcFn: async () => { rpcCalls++; return "0x1"; }, history: { cursor: 5, gaps: 0, days: { "2026-08-01": { [R2]: { t: 7, v: "7000" } } } } });
  ok(rpcCalls === 0 && lb.window.source === "tempo-api" && lb.window.hours === 24, `feed source: no RPC call, 24h time window (${JSON.stringify(lb.window).slice(0, 80)})`);
  const a = lb.rows.find((r) => r.recipient === R1), b = lb.rows.find((r) => r.recipient === R2);
  ok(a.transfers === 25 && a.payers === 4 && a.proven === true && a.routable === true && a.rank === 1, `R1: 25 transfers / 4 payers in the window -> proven + routable, ranked #1 (got ${a.transfers}/${a.payers} proven=${a.proven})`);
  ok(b.transfers === 1 && b.proven === false && b.d30.transfers === 8, `R2: 1 transfer (not proven), d30 merges the feed day with the older RPC-folded day (got d30 ${b.d30.transfers})`);
  ok(lb.totals.transfers === 26, "totals from the feed");
  const lbRpc = await computeMppLeaderboard({ snapshot, feed: null, now: NOW, rpcFn: async (m) => { rpcCalls++; return m === "eth_blockNumber" ? "0x30000" : []; } });
  ok(rpcCalls > 0 && lbRpc.window.source === "rpc", "no feed -> RPC path, window source rpc");
  ok(tempoFeedEnabled() === false || process.env.TEMPO_DATA_API_KEY, "feed is off without TEMPO_DATA_API_KEY");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
