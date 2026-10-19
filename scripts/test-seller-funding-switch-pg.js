// The seller-funding operator switch on two containers sharing one state
// database: a choice made on A applies on B after one re-read of the row, a
// choice made back on B reaches A the same way, and B's own choice is never
// undone by a re-read that was already in flight when it was made.
//   STATE_DATABASE_URL=postgres://... node scripts/test-seller-funding-switch-pg.js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-seller-funding-switch-pg" });

const DIR = mkdtempSync(join(tmpdir(), "funding-switch-pg-"));
process.env.LEADERBOARD_FUNDING_SWITCH_FILE = join(DIR, "leaderboard-funding-switch.json");
process.env.LEADERBOARD_SNAPSHOT_FILE = join(DIR, "leaderboard-snapshot.json");
delete process.env.LEADERBOARD_FUNDING_SCAN;

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };

try {
  const A = await import("../src/leaderboard.js?container=a");
  const B = await import("../src/leaderboard.js?container=b");
  ok(A.sellerFundingEnabled() === true && B.sellerFundingEnabled() === true, "both containers start on (no operator choice)");
  await sdb.stateStoresReady?.();
  await A.refreshSellerFundingSwitch(); await B.refreshSellerFundingSwitch();

  const off = A.setSellerFundingEnabled(false, { note: "operator off" });
  ok(off.enabled === false, "A is off at once");
  // Let A's write land.
  for (let i = 0; i < 50 && A.sellerFundingSwitch().operator?.persisted !== true; i++) await new Promise((r) => setTimeout(r, 20));
  ok(A.sellerFundingSwitch().operator?.persisted === true, "A's choice is stored in the row");
  ok(B.sellerFundingEnabled() === true, "B has not re-read yet");
  const changed = await B.refreshSellerFundingSwitch();
  ok(changed === true && B.sellerFundingEnabled() === false, "B is off after one re-read of the row");
  ok(B.sellerFundingSwitch().source === "operator" && B.sellerFundingSwitch().operator?.note === "operator off", "B names the operator's choice and note");

  // And back the other way.
  B.setSellerFundingEnabled(true, { note: "back on" });
  for (let i = 0; i < 50 && B.sellerFundingSwitch().operator?.persisted !== true; i++) await new Promise((r) => setTimeout(r, 20));
  await A.refreshSellerFundingSwitch();
  ok(A.sellerFundingEnabled() === true, "B's choice reaches A after one re-read");

  // A re-read already in flight when a local choice is made does not undo it.
  const inflight = A.refreshSellerFundingSwitch();
  A.setSellerFundingEnabled(false, { note: "local wins" });
  await inflight;
  ok(A.sellerFundingEnabled() === false, "a re-read in flight never undoes the choice made after it started");
  for (let i = 0; i < 50 && A.sellerFundingSwitch().operator?.persisted !== true; i++) await new Promise((r) => setTimeout(r, 20));
  await B.refreshSellerFundingSwitch();
  ok(B.sellerFundingEnabled() === false, "and it reaches B");
} catch (e) {
  fail++; console.error(`FAIL - threw: ${e?.stack || e}`);
} finally {
  try { await sdb.__dropStateSchema(); } catch {}
  try { await sdb.closeStateDb?.(); } catch {}
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
