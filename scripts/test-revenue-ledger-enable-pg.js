// The revenue ledger's sync loop runs wherever its rows persist: on the
// volume, with REVENUE_LEDGER=true, and with the state database on. Once the
// volume is gone the database is the only thing that persists them, so the
// loop must not depend on /data existing. Requires STATE_DATABASE_URL (CI
// fails without it).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-revenue-ledger-enable-pg" });
const DIR = mkdtempSync(join(tmpdir(), "rev-enable-"));
process.env.REVENUE_LEDGER_DB = join(DIR, "agent402-revenue.db");
delete process.env.REVENUE_LEDGER;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const rl = await import("../src/revenue-ledger.js");
const sdb = await import("../src/state-db.js");
try {
  if (existsSync("/data")) console.log("note - this host has /data, so the loop is on for that reason too");
  ok(rl.revenueLedgerLoopEnabled({ STATE_DATABASE_URL: "postgres://x/y" }, { hasDataDir: false }) === true, "the state database alone enables the loop");
  ok(rl.revenueLedgerLoopEnabled({}, { hasDataDir: false }) === false, "no volume, no database, no REVENUE_LEDGER: the loop stays off");
  ok(rl.revenueLedgerLoopEnabled({ REVENUE_LEDGER: "true" }, { hasDataDir: false }) === true, "REVENUE_LEDGER=true still enables it");
  ok(rl.revenueLedgerLoopEnabled({}, { hasDataDir: true }) === true, "the volume still enables it");
  // The call site: with the database on (this process) and no REVENUE_LEDGER,
  // startRevenueLedger arms the loop. The wallet is a placeholder; the first
  // tick never runs before the process exits.
  ok(rl.revenueLedgerLoopEnabled() === true, "this process (database on) reads enabled");
} finally {
  await Promise.resolve(rl.ledgerStoreReady()).catch(() => {});
  await (await import("../src/sales-ledger.js")).salesLedgerReady();
  await sdb.stateStoresReady().catch(() => {});
  try { await sdb.__dropStateSchema(); } catch { /* dropped */ }
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
