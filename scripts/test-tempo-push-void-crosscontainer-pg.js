// Two containers, one Tempo push transfer, on a REAL Postgres. Container A
// (this process, behind a relay the test cuts) refuses the first request's
// input and books the push as owed; container B (a child process, its own
// ledger directory, a healthy connection) serves the corrected retry and
// voids that debt. The void must never be undone by A's debt landing later:
//   - A's debt waits in A's local dead-letter (the database is away from A),
//     B serves and voids while no row exists yet, then A's replay lands:
//     the row is not owed, no owed listing shows it, a send cannot claim it;
//   - A's debt and B's void race on the database (many hashes at once):
//     none ends owed, whichever statement ran first;
//   - control: A's debt lands first, then B voids: the row is void.
// The dead-letter here is A's local disk (no REDIS_URL); with the journals in
// Redis the same void tombstone holds (test-ledger-journal-redis-pg.js).
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";

const SELF = fileURLToPath(import.meta.url);
delete process.env.REDIS_URL; // A's journal is its local disk; B inherits this environment
const debtsOf = (rl, createTempoPushDebts) => createTempoPushDebts({
  recordOwed: rl.recordRefundOwed, voidOnClaim: rl.voidOwedOnClaim, renoteOwed: rl.renoteOwedRefund,
  refundByEvidence: rl.refundByEvidence, promoteToHangup: rl.promoteOwedToHangup,
  restateHandlerFailure: rl.restateOwedAsHandlerFailure, recordChargedFailure: () => {}, slugOf: () => "dns-lookup",
});

if (process.argv[2] === "child") {
  // Container B: serves the claimed retry of each hash (at XC_START_AT when given).
  process.env.REFUND_DB_DIR = mkdtempSync(join(tmpdir(), "push-xc-B-"));
  const sdb = await import("../src/state-db.js");
  const rl = await import("../src/refund-ledger.js");
  const { createTempoPushDebts } = await import("../src/tempo-push-debts.js");
  const debts = debtsOf(rl, createTempoPushDebts);
  await rl.refundLedgerReady();
  const hashes = process.argv.slice(3);
  const at = Number(process.env.XC_START_AT) || 0;
  if (at) await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
  const voided = await Promise.all(hashes.map((h) => debts.served({ mppTempoPushHash: h, tempoSettled: true }, { statusCode: 200 })));
  await rl.refundLedgerFlush();
  console.log(JSON.stringify({ voided }));
  await sdb.closeStateDb();
  process.exit(0);
}

requireTestPg({ label: "test-tempo-push-void-crosscontainer-pg" });
const DIRECT = process.env.STATE_DATABASE_URL;
const relay = await startPgRelay(DIRECT);
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
process.env.STATE_DB_QUERY_TIMEOUT_MS = "3000";
process.env.REFUND_DB_DIR = mkdtempSync(join(tmpdir(), "push-xc-A-"));
const sdb = await import("../src/state-db.js");
const rl = await import("../src/refund-ledger.js");
const { createTempoPushDebts } = await import("../src/tempo-push-debts.js");
const debts = debtsOf(rl, createTempoPushDebts);
const schema = sdb.stateDbSchema();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const pgDirect = async (sql, params) => {
  const pg = (await import("pg")).default; const c = new pg.Client({ connectionString: DIRECT }); await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
};
const statusOf = async (h) => (await pgDirect(`SELECT status FROM ${schema}.refunds WHERE evidence = $1`, [h])).rows[0]?.status ?? null;
const runB = (hashes, env = {}) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [SELF, "child", ...hashes], { env: { ...process.env, STATE_DATABASE_URL: DIRECT, STATE_DB_SCHEMA: schema, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  c.on("exit", (code) => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { reject(new Error(`child exited ${code}: ${out}`)); } });
});
const hash = () => `0x${randomBytes(32).toString("hex")}`;
const refused = (h) => debts.inputRefused({}, { hash: h, payer: `0x${"2".repeat(40)}`, amountUsd: 0.01, status: 400 });

await rl.refundLedgerReady();
try {
  // ---- 1. A's debt waits in its dead-letter; B voids; A's replay lands ----------
  {
    const h = hash();
    relay.cut();
    await refused(h);
    ok(rl.refundDeadLetterCount() >= 1, `dead-letter: A's debt waits on A's disk while A cannot reach the database (waiting ${rl.refundDeadLetterCount()})`);
    const b = await runB([h]);
    ok(b.voided[0] === false && (await statusOf(h)) === null, `dead-letter: B serves the claimed retry while no row exists yet (void ${b.voided[0]}, row ${await statusOf(h)})`);
    relay.heal();
    await rl.refundLedgerRefresh();
    const st = await statusOf(h);
    ok(rl.refundDeadLetterCount() === 0 && st !== "owed", `dead-letter: after A's replay the row is not owed (row ${st}, dead-letter ${rl.refundDeadLetterCount()})`);
    const owedNow = rl.listRefunds({ status: "owed", limit: 500 }).filter((r) => r.evidence === h);
    ok(owedNow.length === 0, `dead-letter: the owed listing the refund run reads does not name it (${owedNow.length})`);
    const row = rl.refundByEvidence(h);
    ok(!row || (await rl.claimRefundForSend(row.id, "test")) === false, `dead-letter: a refund send cannot claim it (${row ? `row #${row.id} ${row.status}` : "no row"})`);
  }

  // ---- 2. debt and void race on the database ---------------------------------
  {
    const hs = Array.from({ length: 24 }, hash);
    const at = Date.now() + 1500;
    const bP = runB(hs, { XC_START_AT: String(at) });
    await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
    await Promise.all(hs.map((h) => refused(h)));
    await bP;
    await rl.refundLedgerRefresh();
    const owed = (await pgDirect(`SELECT evidence FROM ${schema}.refunds WHERE evidence = ANY($1::text[]) AND status = 'owed'`, [hs])).rows.length;
    ok(owed === 0, `race: none of ${hs.length} hashes whose debt and void ran at once ends owed (${owed} owed)`);
  }

  // ---- 3. control: the debt lands first, then B voids ---------------------------
  {
    const h = hash();
    await refused(h);
    ok((await statusOf(h)) === "owed", `control: A's debt lands owed (${await statusOf(h)})`);
    const b = await runB([h]);
    ok(b.voided[0] === true && (await statusOf(h)) === "void", `control: B's void finds the row and voids it (void ${b.voided[0]}, row ${await statusOf(h)})`);
  }
} finally {
  relay.heal();
  await rl.refundLedgerFlush();
  try { await pgDirect(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* best effort */ }
  await sdb.closeStateDb(); await relay.close();
}
console.log(`\ntest-tempo-push-void-crosscontainer-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
