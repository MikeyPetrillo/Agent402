// Offline unit tests for the x402-trending momentum tool (src/tools/x402-kit.js
// computeTrending) and its history persistence hooks (src/leaderboard.js
// persistLeaderboardHistoryPoint / readLeaderboardHistory). No network, no boot.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTrending } from "../src/tools/x402-kit.js";
import { persistLeaderboardHistoryPoint, readLeaderboardHistory } from "../src/leaderboard.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`ok - ${msg}`); } else { fail++; console.error(`FAIL - ${msg}`); } };

const SELF = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const row = (over = {}) => ({
  rank: 1, name: "seller", origins: [], homepage: "https://seller.example", endpoints: 3,
  wallet: "0x1111111111111111111111111111111111111111",
  wallets: ["0x1111111111111111111111111111111111111111"], walletCount: 1,
  network: "base", callsSettled: 100, totalUsd: 1, uniqueBuyers: 50,
  ...over,
});
const snap = (leaderboard, over = {}) => ({
  spec: "x402-leaderboard/1", asOf: "2026-07-14T12:00:00.000Z", windowLabel: "24h", leaderboard, ...over,
});

// --- organicScore math (the wash-trade-resistance signal) --------------------
{
  const washy = row({ name: "washy", wallet: "0x2222222222222222222222222222222222222222", wallets: ["0x2222222222222222222222222222222222222222"], callsSettled: 1000, uniqueBuyers: 2, totalUsd: 10 });
  const organic = row({ name: "organic", wallet: "0x3333333333333333333333333333333333333333", wallets: ["0x3333333333333333333333333333333333333333"], callsSettled: 1000, uniqueBuyers: 400, totalUsd: 5 });
  const out = computeTrending(snap([washy, organic]), { sort: "organic" });
  const w = out.sellers.find((s) => s.name === "washy");
  const o = out.sellers.find((s) => s.name === "organic");
  ok(w.organicScore === 0.002, `1000 calls / 2 buyers → organicScore 0.002 (got ${w.organicScore})`);
  ok(o.organicScore === 0.4, `1000 calls / 400 buyers → organicScore 0.4 (got ${o.organicScore})`);
  ok(out.sellers[0].name === "organic", "sort=organic ranks the diverse-buyer seller first");
  ok(w.avgTicketUsd === 0.01, `avgTicketUsd = totalUsd/calls (got ${w.avgTicketUsd})`);
}

// --- divide-by-zero + clamp --------------------------------------------------
{
  const zero = row({ name: "zero", callsSettled: 0, uniqueBuyers: 0, totalUsd: 0 });
  const out = computeTrending(snap([zero]), {});
  ok(out.sellers[0].organicScore === 0 && out.sellers[0].avgTicketUsd === 0, "callsSettled=0 → organicScore 0 and avgTicketUsd 0 (no NaN/Infinity)");
  // buyers can never exceed calls in real data, but the clamp holds regardless
  const weird = row({ name: "weird", callsSettled: 2, uniqueBuyers: 10 });
  ok(computeTrending(snap([weird]), {}).sellers[0].organicScore === 1, "organicScore clamps to 1");
}

// --- sort modes ---------------------------------------------------------------
{
  const a = row({ name: "a", wallet: "0x4444444444444444444444444444444444444444", wallets: ["0x4444444444444444444444444444444444444444"], totalUsd: 100, callsSettled: 10, uniqueBuyers: 5 });
  const b = row({ name: "b", wallet: "0x5555555555555555555555555555555555555555", wallets: ["0x5555555555555555555555555555555555555555"], totalUsd: 1, callsSettled: 900, uniqueBuyers: 300 });
  const s = snap([a, b]);
  ok(computeTrending(s, {}).sort === "usd", "default sort is usd");
  ok(computeTrending(s, { sort: "usd" }).sellers[0].name === "a", "sort=usd ranks by totalUsd");
  ok(computeTrending(s, { sort: "calls" }).sellers[0].name === "b", "sort=calls ranks by callsSettled");
  ok(computeTrending(s, { sort: "buyers" }).sellers[0].name === "b", "sort=buyers ranks by uniqueBuyers");
  ok(computeTrending(s, { sort: "bogus" }).sort === "usd", "unknown sort falls back to usd (echoed)");
  ok(computeTrending(s, {}).sellers[0].rank === 1 && computeTrending(s, {}).sellers[1].rank === 2, "ranks are consecutive after sorting");
}

// --- include: external excludes our own wallet --------------------------------
{
  const ours = row({ name: "us", wallet: SELF, wallets: [SELF] });
  const theirs = row({ name: "them", wallet: "0x6666666666666666666666666666666666666666", wallets: ["0x6666666666666666666666666666666666666666"] });
  const s = snap([ours, theirs]);
  const ext = computeTrending(s, {}, { selfWallet: SELF });
  ok(ext.include === "external" && ext.sellers.length === 1 && ext.sellers[0].name === "them", "include=external (default) excludes our wallet");
  ok(ext.totalSellers === 1, "totalSellers reflects the include filter");
  const all = computeTrending(s, { include: "all" }, { selfWallet: SELF });
  ok(all.sellers.length === 2, "include=all keeps our row");
  // multi-wallet group containing our wallet is also excluded
  const grouped = row({ name: "group", wallet: "0x7777777777777777777777777777777777777777", wallets: ["0x7777777777777777777777777777777777777777", SELF] });
  ok(computeTrending(snap([grouped]), {}, { selfWallet: SELF }).sellers.length === 0, "external also excludes a group whose wallets contain our wallet");
  // case-insensitive match (env may carry a checksummed address)
  ok(computeTrending(s, {}, { selfWallet: SELF.toUpperCase().replace("0X", "0x") }).sellers.length === 1, "self-wallet match is case-insensitive");
}

// --- limit ---------------------------------------------------------------------
{
  const many = Array.from({ length: 60 }, (_, i) =>
    row({ name: `s${i}`, wallet: `0x${String(i).padStart(40, "0")}`, wallets: [`0x${String(i).padStart(40, "0")}`], totalUsd: 60 - i })
  );
  ok(computeTrending(snap(many), {}).sellers.length === 10, "default limit is 10");
  ok(computeTrending(snap(many), { limit: 999 }).sellers.length === 50, "limit caps at 50");
  ok(computeTrending(snap(many), { limit: "3" }).sellers.length === 3, "string limit (GET query) parses");
}

// --- empty / warming snapshot: clean envelope, never throws --------------------
{
  const out = computeTrending(snap([], { warming: true }), {});
  ok(Array.isArray(out.sellers) && out.sellers.length === 0 && out.totalSellers === 0, "empty snapshot → sellers:[] totalSellers:0");
  ok(out.window === "24h" && typeof out.generatedAt === "string", "envelope keeps window + generatedAt on empty snapshot");
  ok(out.warming === true, "warming flag passes through");
  const nullOut = computeTrending(null, {});
  ok(nullOut.totalSellers === 0 && nullOut.wow.available === false, "null snapshot → clean empty envelope");
}

// --- WoW: honest activation ------------------------------------------------------
{
  const cur = snap([
    row({ name: "riser", wallet: "0x8888888888888888888888888888888888888888", wallets: ["0x8888888888888888888888888888888888888888"], callsSettled: 200, totalUsd: 4, uniqueBuyers: 80 }),
    row({ name: "flatty", wallet: "0x9999999999999999999999999999999999999999", wallets: ["0x9999999999999999999999999999999999999999"], callsSettled: 100, totalUsd: 1, uniqueBuyers: 40 }),
    row({ name: "cooler", wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", wallets: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], callsSettled: 50, totalUsd: 1, uniqueBuyers: 20 }),
    row({ name: "newbie", wallet: "0xcccccccccccccccccccccccccccccccccccccccc", wallets: ["0xcccccccccccccccccccccccccccccccccccccccc"], callsSettled: 10, totalUsd: 0.1, uniqueBuyers: 8 }),
  ]);
  // No history → wow off, no delta fields anywhere.
  const cold = computeTrending(cur, {});
  ok(cold.wow.available === false, "no history → wow.available false");
  ok(cold.sellers.every((s) => s.deltaVsPrevWeek === undefined && s.trend === undefined), "no history → no delta/trend fields (never faked)");
  // History point too young (2 days) → still off.
  const young = [{ day: "2026-07-12", asOf: "2026-07-12T12:00:00.000Z", sellers: [{ wallets: ["0x8888888888888888888888888888888888888888"], callsSettled: 1, totalUsd: 0, uniqueBuyers: 1 }] }];
  ok(computeTrending(cur, {}, { history: young }).wow.available === false, "point only 2 days old → wow stays off (6-10 day band)");
  // Proper ~7-day-old baseline → deltas + trends activate.
  const baseline = [{
    day: "2026-07-07", asOf: "2026-07-07T12:00:00.000Z",
    sellers: [
      { wallets: ["0x8888888888888888888888888888888888888888"], callsSettled: 100, totalUsd: 2, uniqueBuyers: 40 },
      { wallets: ["0x9999999999999999999999999999999999999999"], callsSettled: 99, totalUsd: 1, uniqueBuyers: 40 },
      { wallets: ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], callsSettled: 100, totalUsd: 2, uniqueBuyers: 40 },
    ],
  }];
  const warm = computeTrending(cur, { limit: 50 }, { history: baseline });
  ok(warm.wow.available === true && warm.wow.comparedTo === "2026-07-07", "7-day-old point → wow.available true with comparedTo");
  const riser = warm.sellers.find((s) => s.name === "riser");
  const flatty = warm.sellers.find((s) => s.name === "flatty");
  const cooler = warm.sellers.find((s) => s.name === "cooler");
  const newbie = warm.sellers.find((s) => s.name === "newbie");
  ok(riser.deltaVsPrevWeek.callsSettled === 100 && riser.deltaVsPrevWeek.totalUsd === 2, "deltaVsPrevWeek math (calls +100, usd +2)");
  ok(riser.trend === "rising", "calls up 100% → rising");
  ok(flatty.trend === "flat", "calls +1 within ±5% band → flat");
  ok(cooler.trend === "cooling", "calls halved → cooling");
  ok(newbie.trend === "new" && newbie.newThisWindow === true, "seller absent from baseline → trend new + newThisWindow");
  ok(riser.newThisWindow === false, "seller present in baseline → newThisWindow false");
}

// --- history persistence roundtrip (temp file — the /data hook) -----------------
{
  const dir = mkdtempSync(join(tmpdir(), "lb-hist-"));
  const file = join(dir, "leaderboard-history.json");
  ok(readLeaderboardHistory(file).length === 0, "missing history file reads as []");
  const s1 = snap([row({ callsSettled: 10, totalUsd: 1, uniqueBuyers: 5 })], { asOf: "2026-07-13T01:00:00.000Z" });
  ok(persistLeaderboardHistoryPoint(s1, file) === true, "persist writes a point");
  // Same-day re-persist replaces (hourly refresh keeps the day's latest scan).
  const s2 = snap([row({ callsSettled: 20, totalUsd: 2, uniqueBuyers: 9 })], { asOf: "2026-07-13T09:00:00.000Z" });
  persistLeaderboardHistoryPoint(s2, file);
  let hist = readLeaderboardHistory(file);
  ok(hist.length === 1 && hist[0].sellers[0].callsSettled === 20, "same-day re-persist replaces that day's point");
  // Next day appends.
  persistLeaderboardHistoryPoint(snap([row()], { asOf: "2026-07-14T01:00:00.000Z" }), file);
  hist = readLeaderboardHistory(file);
  ok(hist.length === 2 && hist[0].day === "2026-07-13" && hist[1].day === "2026-07-14", "next-day persist appends, sorted oldest-first");
  // scanSkipped snapshots are never persisted (an empty RPC-outage snapshot would poison WoW).
  ok(persistLeaderboardHistoryPoint({ scanSkipped: true, leaderboard: [] }, file) === false, "scanSkipped snapshot is not persisted");
  // Unwritable path → false, never throws. (A path beneath a regular file:
  // a missing parent directory is created now, so it is no longer unwritable.)
  writeFileSync(join(dir, "a-file"), "");
  ok(persistLeaderboardHistoryPoint(s1, join(dir, "a-file", "x.json")) === false, "unwritable path returns false (no throw)");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
