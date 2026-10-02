// Leaderboard warm-start persistence — offline unit test. No network.
//   node scripts/test-lb-warmstart.js
//
// Guards the post-deploy cold-window fix: the full leaderboard snapshot (with
// origins) is persisted to /data and reloaded at boot, so getLeaderboardSnapshot
// serves real reliability data from the first request instead of the empty
// "warming" placeholder that made the SOR resolver find zero proven sellers for
// the minutes its first on-chain scan takes after each deploy.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";

const FILE = join(tmpdir(), `lb-warmstart-${process.pid}.json`);
process.env.LEADERBOARD_SNAPSHOT_FILE = FILE;
process.env.X402_SYNC_ON_START = "false"; // no live scan at boot — isolate warm-start

const { getLeaderboardSnapshot, startLeaderboardRefresh, stopLeaderboardRefresh, loadPersistedLeaderboardSnapshot, _resetLeaderboardCacheForTests } =
  await import("../src/leaderboard.js");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "ok" : "FAIL"} - ${m}`); };

try {
  // cold cache + no disk file → warming placeholder (empty leaderboard)
  _resetLeaderboardCacheForTests();
  ok(getLeaderboardSnapshot().leaderboard.length === 0, "cold + no disk → empty warming placeholder");
  ok(loadPersistedLeaderboardSnapshot() === null, "no persisted file → load returns null");

  // simulate a prior deploy having persisted a real snapshot
  writeFileSync(FILE, JSON.stringify({
    spec: "x402-leaderboard/1", asOf: "2026-07-20T00:00:00.000Z", windowLabel: "Last 7d",
    leaderboard: [
      { rank: 1, homepage: "https://x402.agentutility.ai", origins: ["https://x402.agentutility.ai"], callsSettled: 6371 },
      { rank: 2, homepage: "https://x402.ottoai.services", origins: ["https://x402.ottoai.services"], callsSettled: 47570 },
    ],
  }));
  ok((loadPersistedLeaderboardSnapshot()?.leaderboard || []).length === 2, "persisted file loads 2 rows");

  // warm-start: a fresh boot (cache reset, boot scan skipped) must populate
  // cached.snapshot from disk immediately — no live scan
  _resetLeaderboardCacheForTests();
  startLeaderboardRefresh({ intervalMs: 3600_000 });
  const s = getLeaderboardSnapshot();
  ok(s.leaderboard.length === 2, `warm-start serves persisted rows at boot (got ${s.leaderboard.length})`);
  ok(s.staleFromDisk === true, "warm-started snapshot marked staleFromDisk");
  ok(s.leaderboard[1].callsSettled === 47570 && s.leaderboard[1].origins[0] === "https://x402.ottoai.services",
    "origins + settled survive the round-trip (the SOR reliability join needs these)");
  stopLeaderboardRefresh();

  // The per-wallet evidence the router's evidence binding reads (2026-09-28)
  // persists and warm-starts with the snapshot, and never reaches a served
  // copy: every public path spreads getLeaderboardSnapshot().
  const { getLeaderboardWalletEvidence } = await import("../src/leaderboard.js");
  const W = "0x" + "1".repeat(40);
  writeFileSync(FILE, JSON.stringify({
    spec: "x402-leaderboard/1", asOf: "2026-07-20T00:00:00.000Z", windowLabel: "Last 7d",
    leaderboard: [{ rank: 1, homepage: "https://seller-a.example", origins: ["https://seller-a.example"], wallet: W, wallets: [W], callsSettled: 90, uniqueBuyers: 5 }],
    walletEvidence: { [W]: { callsSettled: 90, uniqueBuyers: 5, origins: ["https://seller-a.example"] } },
  }));
  _resetLeaderboardCacheForTests();
  startLeaderboardRefresh({ intervalMs: 3600_000 });
  const served = getLeaderboardSnapshot();
  ok(!("walletEvidence" in served) && served.leaderboard.every((r) => !("walletEvidence" in r)) && !JSON.stringify(served).includes("walletEvidence"),
    "the served snapshot carries no walletEvidence, at the top level or on any row");
  ok(getLeaderboardWalletEvidence()[W]?.uniqueBuyers === 5, "the per-wallet evidence warm-starts for the router");
  stopLeaderboardRefresh();
} finally {
  try { rmSync(FILE, { force: true }); } catch { /* best-effort */ }
}

console.log(`\n${fail ? "FAILED" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
