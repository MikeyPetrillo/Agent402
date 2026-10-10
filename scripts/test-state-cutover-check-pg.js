// scripts/state-cutover-check.js on a volume-shaped fixture: the refunds half
// compares EVERY row in every status (not the first 200 owed ones), the gate
// compares rows (the ledger checksum), not only counts and sums, and the
// files it is given are never changed. Requires STATE_DATABASE_URL (CI fails
// without it).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
const { url } = requireTestPg({ label: "test-state-cutover-check-pg" });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "state-cutover-"));
const data = join(DIR, "data");
const fileEnv = { ...process.env }; delete fileEnv.STATE_DATABASE_URL; delete fileEnv.STATE_DB_SCHEMA;
const digest = () => Object.fromEntries(readdirSync(data).filter((f) => f.endsWith(".db")).map((f) => [f, createHash("md5").update(readFileSync(join(data, f))).digest("hex")]));
const c = new pg.Client({ connectionString: url });
try {
  const seed = spawnSync(process.execPath, ["scripts/lib/state-fixture.mjs", "seed", data, "600", "260"], { env: fileEnv, encoding: "utf8" });
  ok(seed.status === 0, "fixture written in file mode");
  const fx = JSON.parse(seed.stdout.trim().split("\n").pop());
  ok(fx.byStatus.owed > 200 && fx.byStatus.paid > 0 && fx.byStatus.void > 0, `refunds in every status, more than 200 owed (${JSON.stringify(fx.byStatus)})`);
  const before = digest();
  const r = spawnSync(process.execPath, ["scripts/state-cutover-check.js", "--sales", join(data, "agent402-sales.db"), "--refunds", join(data, "agent402-refunds.db"), "--decide", join(data, "agent402-decide.db"), "--json"], { env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* reported below */ }
  ok(r.status === 0 && out && out.diffs.length === 0, `MATCH on the fixture${r.status ? ` (${(r.stderr || r.stdout).slice(-400)})` : ""}`);
  for (const side of ["file", "database"]) {
    const rf = out?.[side]?.refunds;
    ok(rf?.count === fx.refunds && JSON.stringify(rf?.byStatus) === JSON.stringify(Object.fromEntries(Object.entries(fx.byStatus).sort())), `${side} side: every refund in every status is compared (${rf?.count}, ${JSON.stringify(rf?.byStatus)})`);
    ok(rf && typeof rf.usdByStatus?.paid === "number" && typeof rf.usdByStatus?.void === "number", `${side} side: paid and void sums are compared too`);
  }
  const cs = out?.checksums || [];
  ok(cs.length >= 8 && cs.every((x) => x.equal), `the gate compares every ledger row for row (${cs.length} tables, ${cs.filter((x) => !x.equal).length} differ)`);
  ok(cs.some((x) => x.name === "refunds.refunds" && x.rowsFile === fx.refunds) && cs.some((x) => x.name === "sales.sales" && x.rowsTable === fx.sales), "the checksums cover every sale and refund row");
  ok(JSON.stringify(digest()) === JSON.stringify(before), "the files given to the gate are unchanged");

  // Negative control: a column the import does not carry. Every figure still
  // matches; only the row comparison sees the loss, and it fails the gate.
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(join(data, "agent402-sales.db"));
  db.exec("ALTER TABLE sales ADD COLUMN extra_note TEXT; UPDATE sales SET extra_note = 'kept only in the file' WHERE id % 50 = 0;");
  db.close();
  const neg = spawnSync(process.execPath, ["scripts/state-cutover-check.js", "--sales", join(data, "agent402-sales.db"), "--refunds", join(data, "agent402-refunds.db"), "--json"], { env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let nout = null; try { nout = JSON.parse(neg.stdout); } catch { /* reported below */ }
  const salesRow = nout?.checksums?.find((x) => x.name === "sales.sales");
  ok(neg.status === 1 && nout?.diffs.length === 0 && salesRow && !salesRow.equal, `a row difference the figures cannot see fails the gate (exit ${neg.status}, ${salesRow?.note || "no sales row"})`);
  const text = spawnSync(process.execPath, ["scripts/state-cutover-check.js", "--sales", join(data, "agent402-sales.db"), "--refunds", join(data, "agent402-refunds.db")], { env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  ok(text.status === 1 && /MISMATCH: 0 figure\(s\) and 1 ledger table\(s\) differ/.test(text.stdout), "the printed verdict names the differing ledger table");

  await c.connect();
  const left = (await c.query("SELECT count(*) AS n FROM pg_namespace WHERE nspname = $1", [out?.schema || "none"])).rows[0].n;
  ok(Number(left) === 0, "the throwaway schema is dropped");
} finally {
  await c.end().catch(() => {});
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
