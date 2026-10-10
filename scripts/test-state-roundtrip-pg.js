// Full round trip of the state backup over every REAL store table: the stores
// create their tables (scripts/lib/state-stores.mjs boot), every table is
// seeded with edge values per column type, the whole schema is staged the
// way the nightly run does (one snapshot, encrypted with a throwaway key),
// restored into an EMPTY schema that nothing booted, and compared table by
// table, row for row. Then a default insert goes into every serial table:
// none may collide with a restored id. Requires STATE_DATABASE_URL (CI fails
// without it).
import pg from "pg";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema: SRC } = requireTestPg({ label: "test-state-roundtrip-pg" });
const DST = `${SRC}_dst`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "state-roundtrip-"));
const c = new pg.Client({ connectionString: url });
await c.connect();
const q = (t, p) => c.query(t, p);
try {
  const boot = spawnSync(process.execPath, ["scripts/lib/state-stores.mjs", "boot", join(DIR, "files")], { env: { ...process.env, STATE_DB_SCHEMA: SRC }, encoding: "utf8" });
  ok(boot.status === 0, `the stores create their tables${boot.status ? ` (${String(boot.stderr).slice(-300)})` : ""}`);
  const tables = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1", [SRC])).rows.map((r) => r.table_name).filter((t) => t !== "leases");
  ok(tables.length >= 30, `every store table exists (${tables.length})`);
  const serialCols = (await q("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND column_default LIKE 'nextval(%'", [SRC])).rows;
  ok(serialCols.length >= 8, `the serial columns are there to test (${serialCols.map((r) => `${r.table_name}.${r.column_name}`).join(", ")})`);

  // Seed: edge values per type; serial columns take their default.
  const N = 1500;
  for (const t of tables) {
    const cs = (await q("SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [SRC, t])).rows;
    const ins = cs.filter((x) => !(x.column_default || "").startsWith("nextval("));
    const exprs = ins.map((x) => {
      const nul = (e) => (x.is_nullable === "YES" ? `CASE WHEN g % 7 = 0 THEN NULL ELSE ${e} END` : e);
      switch (x.data_type) {
        case "jsonb": return `CASE g % 6 WHEN 0 THEN to_jsonb('bare string é ' || g) WHEN 1 THEN jsonb_build_object('amount', '123456789012345678901234567890', 'n', g, 'big', 9007199254740993::numeric, 'f', 0.1 + g, 'nested', jsonb_build_object('arr', jsonb_build_array(1, null, 'x', true)), 'esc', E'line\\n"q"\\\\') WHEN 2 THEN 'null'::jsonb WHEN 3 THEN jsonb_build_array(g, 'a') WHEN 4 THEN to_jsonb(g) ELSE '{}'::jsonb END`;
        case "text": return nul(`'${t}-${x.column_name}-' || g || CASE WHEN g % 5 = 0 THEN E' ü\\t\\n''"' ELSE '' END`);
        case "bigint": return nul(`CASE WHEN g = 3 THEN 9007199254740993 ELSE 1700000000000 + g END`);
        case "integer": return nul("(g % 1000)");
        case "smallint": return nul("(g % 2)::smallint");
        case "boolean": return nul("(g % 2 = 0)");
        case "numeric": return nul("(g * 1.000001)::numeric");
        case "double precision": case "real": return nul("CASE WHEN g % 4 = 0 THEN 0.1 WHEN g % 4 = 1 THEN 1e-7 * g ELSE 0.30000000000000004 + g END");
        case "timestamp with time zone": return "'2026-10-09 12:34:56.123456+00'::timestamptz + (g || ' microseconds')::interval";
        default: throw new Error(`no seed for ${t}.${x.column_name} ${x.data_type}`);
      }
    });
    await q(`INSERT INTO ${SRC}.${t} (${ins.map((x) => `"${x.column_name}"`).join(",")}) SELECT ${exprs.join(",")} FROM generate_series(1, ${N}) g ON CONFLICT DO NOTHING`);
  }
  const seeded = Number((await q(`SELECT count(*) AS n FROM ${SRC}.sales`)).rows[0].n);
  ok(seeded >= N, `tables seeded (${seeded} sales)`);

  // Stage the whole schema as the nightly run does, encrypted.
  process.env.STATE_DB_SCHEMA = SRC;
  const keyHex = randomBytes(32).toString("hex");
  const { stageStateTables, encryptBackupBuffer, parseEncKey } = await import("../src/backup.js");
  const stageDir = join(DIR, "stage"), dayDir = join(DIR, "day");
  const staged = await stageStateTables(stageDir, { pageRows: 700 });
  ok(staged.failed.length === 0 && staged.tables.length === tables.length, `every table staged (${staged.tables.length}, failed ${staged.failed.length})`);
  (await import("node:fs")).mkdirSync(dayDir);
  for (const f of readdirSync(stageDir)) writeFileSync(join(dayDir, `${f}.enc`), encryptBackupBuffer(readFileSync(join(stageDir, f)), parseEncKey(keyHex)));
  const { closeStateDb } = await import("../src/state-db.js");
  await closeStateDb();

  // Restore into an empty schema through the CLI.
  const r = spawnSync(process.execPath, ["scripts/state-restore.js", "--dir", dayDir], { env: { ...process.env, STATE_DB_SCHEMA: DST, BACKUP_ENCRYPTION_KEY: keyHex }, encoding: "utf8" });
  ok(r.status === 0, `state-restore.js --dir restores into an empty schema${r.status ? ` (${String(r.stderr).slice(-300)})` : ""}`);

  let differ = 0;
  for (const t of tables) {
    let n;
    try {
      n = Number((await q(`SELECT count(*) AS n FROM ((SELECT row_to_json(x)::jsonb FROM ${SRC}.${t} x EXCEPT ALL SELECT row_to_json(y)::jsonb FROM ${DST}.${t} y) UNION ALL (SELECT row_to_json(y)::jsonb FROM ${DST}.${t} y EXCEPT ALL SELECT row_to_json(x)::jsonb FROM ${SRC}.${t} x)) z`)).rows[0].n);
    } catch (e) { n = -1; console.error(`  ${t}: ${e.message}`); }
    if (n) { differ++; console.error(`  ${t}: ${n} row(s) differ`); }
  }
  ok(differ === 0, `every table restored row for row (${tables.length} tables, ${differ} differ)`);

  const collide = [];
  for (const { table_name: t, column_name: col } of serialCols) {
    const max = (await q(`SELECT max(${col})::text AS m FROM ${DST}.${t}`)).rows[0].m;
    const next = (await q(`SELECT nextval(pg_get_serial_sequence('${DST}.${t}', '${col}'))::text AS v`)).rows[0].v;
    if (max !== null && BigInt(next) <= BigInt(max)) collide.push(`${t}.${col} max=${max} next=${next}`);
  }
  ok(collide.length === 0, `no serial column hands out a restored id (${collide.join("; ") || serialCols.length + " checked"})`);
} finally {
  await q(`DROP SCHEMA IF EXISTS ${SRC} CASCADE`).catch(() => {});
  await q(`DROP SCHEMA IF EXISTS ${DST} CASCADE`).catch(() => {});
  await c.end();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
