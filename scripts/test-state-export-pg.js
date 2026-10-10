// scripts/state-export.js: the way back to file mode. A volume-shaped
// fixture is imported by the stores, more rows land in the database only
// (the interval a rollback would otherwise lose), the database is exported to
// an empty directory, and the files are checked against it: row for row (the
// ledger checksum), count for count (the migration verifier), the money
// figures the ledgers' own file-mode readers print against their database
// readers, and a file-mode boot of every store on the exported directory.
// Requires STATE_DATABASE_URL (CI fails without it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema: S } = requireTestPg({ label: "test-state-export-pg" });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "state-export-"));
const data = join(DIR, "data"), out = join(DIR, "out"), empty = join(DIR, "empty");
mkdirSync(empty);
const fileEnv = { ...process.env, FREE_MODE: "true" }; delete fileEnv.STATE_DATABASE_URL; delete fileEnv.STATE_DB_SCHEMA;
const dbEnv = { ...process.env, STATE_DB_SCHEMA: S, FREE_MODE: "true" };
const run = (args, env = dbEnv) => spawnSync(process.execPath, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const c = new pg.Client({ connectionString: url });
try {
  ok(run(["scripts/lib/state-fixture.mjs", "seed", data], fileEnv).status === 0, "fixture written in file mode");
  ok(run(["scripts/lib/state-stores.mjs", "boot", data]).status === 0, "the stores import the fixture");
  await c.connect();
  // Rows only the database holds: written after the volume stopped being read.
  await c.query(`INSERT INTO ${S}.sales (ts, slug, price_usd, rail, network, payer, tx, internal) SELECT 1760000000000 + g, 'after-' || g, 0.000123456 * g, 'x402', 'base', '0xafter' || g, '0xaftertx' || g, 0 FROM generate_series(1, 5) g`);
  await c.query(`INSERT INTO ${S}.refunds (evidence, slug, network, payer, price_usd, http_status, synthetic, created_at, status, paid_tx, resolved_at) VALUES ('0xafter-r1', 'after', 'base', '0xp', 0.0042, 502, 0, 1760000000001, 'owed', NULL, NULL), ('0xafter-r2', 'after', 'base', '0xp', 0.0043, 502, 0, 1760000000002, 'paid', '0xpaidafter', 1760000000003)`);
  await c.query(`INSERT INTO ${S}.documents (name, body) VALUES ('followups.json', '{"seqs": {"a": 9007199254740993}}'::jsonb), ('email-status.json', '"bare"'::jsonb)`);
  await c.query(`INSERT INTO ${S}.records (collection, id, body) VALUES ('credits', 'k_after', '{"balanceMicro": 9007199254740993}'::jsonb)`);
  await c.query(`INSERT INTO ${S}.log_lines (stream, body) VALUES ('outbound-spend', '{"usd": 0.5, "tx": "0xafter"}'::jsonb)`);

  const ex = run(["scripts/state-export.js", "--out", out]);
  ok(ex.status === 0 && !/UNMAPPED/.test(ex.stdout), `the export runs with every table mapped${ex.status ? ` (${(ex.stderr || ex.stdout).slice(-400)})` : ""}`);
  const again = run(["scripts/state-export.js", "--out", out]);
  ok(again.status === 1 && /not empty/.test(again.stderr), "a non-empty --out is refused without --force");

  const cs = run(["scripts/state-ledger-checksum.js", "--data", out, "--json"]);
  let csr = []; try { csr = JSON.parse(cs.stdout); } catch { /* reported below */ }
  ok(cs.status === 0 && csr.length >= 15 && csr.every((r) => r.equal), `every money ledger in the export equals its table row for row (${csr.filter((r) => !r.equal).map((r) => r.name).join(", ") || csr.length + " compared"})`);
  ok(csr.find((r) => r.name === "sales.sales")?.rowsFile === 605 && csr.find((r) => r.name === "refunds.refunds")?.rowsFile === 262, "the rows written after the import are in the files");
  const vf = run(["scripts/state-migration-verify.js", "--data", out]);
  ok(vf.status === 0, `the migration verifier finds every store's count equal${vf.status ? `:\n${vf.stdout.split("\n").filter((l) => /\sNO\s/.test(l)).join("\n")}` : ""}`);
  ok(readFileSync(join(out, "followups.json"), "utf8").includes("9007199254740993") && JSON.parse(readFileSync(join(out, "email-status.json"), "utf8")) === "bare", "documents are written exactly, bare strings and big numbers included");
  ok(readFileSync(join(out, "credits", "k_after.json"), "utf8").includes("9007199254740993"), "a credit record keeps a balance above 2^53 exactly");
  ok(readFileSync(join(out, "x402-index-cache.ndjson"), "utf8").trim().split("\n").length === 6, "the crawl cache has its header line and every origin");

  // The money figures: file-mode readers on the export against the database.
  const summary = (mode) => {
    const env = mode === "file"
      ? { ...fileEnv, CUTOVER_MODE: "file", SALES_LEDGER_DB: join(out, "agent402-sales.db"), REFUND_DB_DIR: out, DECIDE_LEDGER_DB: join(out, "agent402-decide.db") }
      : { ...dbEnv, CUTOVER_MODE: "pg", CUTOVER_KEEP_SCHEMA: "1", SALES_LEDGER_DB: join(empty, "agent402-sales.db"), REFUND_DB_DIR: empty, DECIDE_LEDGER_DB: join(empty, "agent402-decide.db") };
    const r = run(["scripts/lib/cutover-summary.mjs", "with-decide"], env);
    try { const j = JSON.parse(r.stdout.trim().split("\n").pop()); delete j.mode; return j; } catch { return { error: r.stderr.slice(-300) }; }
  };
  const fileFig = summary("file"), dbFig = summary("pg");
  ok(!fileFig.error && fileFig.rows?.sales === 605 && fileFig.refunds?.count === 262, `file mode on the export reads every sale and refund (${JSON.stringify(fileFig.rows || fileFig.error)})`);
  ok(JSON.stringify(fileFig) === JSON.stringify(dbFig), `counts and money totals equal in both modes${JSON.stringify(fileFig) === JSON.stringify(dbFig) ? "" : `:\n  file ${JSON.stringify(fileFig).slice(0, 400)}\n  db   ${JSON.stringify(dbFig).slice(0, 400)}`}`);

  // Every store boots in file mode on the export, and the boot changes no ledger row.
  const boot = run(["scripts/lib/state-stores.mjs", "boot", out], fileEnv);
  ok(boot.status === 0, `every store boots in file mode on the exported directory${boot.status ? ` (${boot.stderr.slice(-300)})` : ""}`);
  const after = run(["scripts/state-ledger-checksum.js", "--data", out]);
  ok(after.status === 0, "after the file-mode boot every ledger still equals the database");
  // A table with no file shape is never dropped silently.
  await c.query(`CREATE TABLE ${S}.unknown_store (k TEXT PRIMARY KEY)`);
  await c.query(`INSERT INTO ${S}.unknown_store VALUES ('a')`);
  await c.query(`INSERT INTO ${S}.log_lines (stream, body) VALUES ('unknown-stream', '{}'::jsonb)`);
  const un = run(["scripts/state-export.js", "--out", join(DIR, "out2")]);
  ok(un.status === 1 && /UNMAPPED: table unknown_store/.test(un.stdout) && /UNMAPPED: log stream unknown-stream/.test(un.stdout), "an unmapped table or stream is named and fails the export");
} finally {
  await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => {});
  await c.end().catch(() => {});
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
