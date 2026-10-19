// Two containers, one leaderboard. The refresh runs under a lease, so the
// container that does not hold it skips the scan; it used to keep its boot
// snapshot for good, and router evidence differed by container. A skipped tick
// now adopts the newer snapshot the other container saved.
//   STATE_DATABASE_URL=postgres://... node scripts/test-leaderboard-peer-adopt-pg.js
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-leaderboard-peer-adopt-pg" });

const sdb = await import("../src/state-db.js");
const A = await import("../src/leaderboard.js?container=a");
const B = await import("../src/leaderboard.js?container=b");
// A third copy only waits for the saved row to land, so B is changed by its own tick alone.
const W = await import("../src/leaderboard.js?container=watch");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (asOf, origin) => ({ asOf, windowLabel: "7d", leaderboard: [{ rank: 1, origin, settled: 60, payers: 4 }] });

try {
  await sdb.ensureStateSchema?.();
  // The other container holds the scan's lease for this tick.
  const held = await sdb.leases.acquire("leaderboard-refresh", { owner: "other-container", ttlMs: 60_000 });
  ok(held === true || held?.owner === "other-container" || held, "the other container holds the refresh lease");
  // ...and has saved a fresh board.
  A.__persistLeaderboardSnapshotForTest(snap("2026-10-19T15:00:00.000Z", "https://fresh.example"));
  for (let i = 0; i < 50; i++) { await wait(100); if (await W.adoptPeerLeaderboardSnapshot().catch(() => false)) break; }
  ok(B.getLeaderboardSnapshot()?.asOf !== "2026-10-19T15:00:00.000Z", "before its tick, B does not have the saved board");
  // A tick on B is skipped by the lease and adopts what was saved.
  const r = await B.__refreshTickForTest({});
  ok(r && r.skipped, `B's tick is skipped by the lease (${JSON.stringify(r)})`);
  const s = B.getLeaderboardSnapshot();
  ok(s?.asOf === "2026-10-19T15:00:00.000Z" && s.leaderboard?.[0]?.origin === "https://fresh.example", `B serves the board the other container saved (asOf ${s?.asOf})`);
  // An older saved board never replaces a newer one held.
  A.__persistLeaderboardSnapshotForTest(snap("2026-10-19T14:00:00.000Z", "https://older.example"));
  for (let i = 0; i < 20; i++) { await wait(100); }
  await B.__refreshTickForTest({});
  ok(B.getLeaderboardSnapshot()?.leaderboard?.[0]?.origin === "https://fresh.example", "an older saved board does not replace a newer one");
} catch (e) {
  fail++; console.error("FAIL - threw:", e?.stack || e);
} finally {
  await sdb.__dropStateSchema?.().catch(() => {});
  await sdb.closeStateDb?.();
}
console.log(`\ntest-leaderboard-peer-adopt-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
