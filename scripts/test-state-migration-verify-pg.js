// scripts/state-migration-verify.js against a volume-shaped fixture imported
// by the stores themselves: a clean import verifies; the crawl cache's header
// line is not an origin; a store whose file is missing from --data while its
// table holds rows is reported; a lazily imported document with no row is
// reported as not imported (and passes only with --allow-lazy). Requires
// STATE_DATABASE_URL (CI fails without it).
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { requireTestPg } from "./lib/test-pg.js";
const { url, schema } = requireTestPg({ label: "test-state-migration-verify-pg" });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "state-verify-"));
const data = join(DIR, "data");
const fileEnv = { ...process.env }; delete fileEnv.STATE_DATABASE_URL; delete fileEnv.STATE_DB_SCHEMA;
const run = (args, env = { ...process.env, STATE_DB_SCHEMA: schema }) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
const verify = (dir, extra = []) => run(["scripts/state-migration-verify.js", "--data", dir, ...extra]);
const line = (out, store) => out.split("\n").find((l) => l.startsWith(store)) || "";
try {
  const seed = run(["scripts/lib/state-fixture.mjs", "seed", data], fileEnv);
  ok(seed.status === 0, `fixture written in file mode${seed.status ? ` (${seed.stderr.slice(-300)})` : ""}`);
  const boot = run(["scripts/lib/state-stores.mjs", "boot", data]);
  ok(boot.status === 0, `the stores import the fixture${boot.status ? ` (${boot.stderr.slice(-300)})` : ""}`);

  const clean = verify(data);
  ok(clean.status === 0, `a clean import verifies${clean.status ? `:\n${clean.stdout.split("\n").filter((l) => / NO /.test(l)).join("\n")}` : ""}`);
  ok(/x402-index-cache\s+origins\s+5\s+5\s+ok/.test(line(clean.stdout, "x402-index-cache")), `the crawl cache counts origins, not its header line (${line(clean.stdout, "x402-index-cache").trim()})`);

  // A store whose file is not in --data, while its table holds rows.
  const partial = join(DIR, "partial");
  cpSync(data, partial, { recursive: true });
  rmSync(join(partial, "agent402-decide.db"));
  const missing = verify(partial);
  ok(missing.status === 1, "a store missing from --data fails the verification");
  ok(/agent402-decide\.db.*NO.*file missing/.test(missing.stdout), `...and is named (${line(missing.stdout, "agent402-decide.db").trim()})`);

  // A ledger whose mirror dead letter still holds rows: the database is behind the file.
  const queued = join(DIR, "queued");
  cpSync(data, queued, { recursive: true });
  { const { default: Database } = await import("better-sqlite3"); const db = new Database(join(queued, "agent402-sales.db"));
    db.exec("CREATE TABLE IF NOT EXISTS pg_dead_letter (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL)");
    db.prepare("INSERT INTO pg_dead_letter (kind, payload, at) VALUES (?, ?, ?)").run("sale", "{}", Date.now()); db.close(); }
  const q1 = verify(queued);
  ok(q1.status === 1 && /agent402-sales\.db\s+pg_dead_letter.*NO\s+rows still queued/.test(q1.stdout), `a non-empty dead letter fails the verification (${q1.stdout.split("\n").find((l) => /pg_dead_letter/.test(l))?.trim() || "no line"})`);
  // Retry ids expire and are never imported: present in the file, not compared.
  { const { default: Database } = await import("better-sqlite3"); const db = new Database(join(queued, "agent402.db"));
    db.prepare("INSERT INTO requests (ns, rid, fp, result, ts) VALUES (?, ?, ?, ?, ?)").run("0xabc", "r1", "fp", "{}", Date.now()); db.close(); }
  const q2 = verify(queued);
  ok(/agent402\.db\s+requests\s+1\s+\S*\s*ok\s+transient/.test(q2.stdout), `memory retry ids are listed as transient (${q2.stdout.split("\n").find((l) => /agent402\.db\s+requests/.test(l))?.trim() || "no line"})`);

  // A lazy document with no row: reported, not passed silently.
  writeFileSync(join(data, "leaderboard-funding.json"), JSON.stringify({ wallets: { a: 1 } }));
  const lazy = verify(data);
  ok(lazy.status === 1 && /leaderboard-funding\.json.*NOT IMPORTED/.test(lazy.stdout), `a lazy document with no row is reported as not imported (${line(lazy.stdout, "leaderboard-funding.json").trim()})`);
  const allowed = verify(data, ["--allow-lazy"]);
  ok(allowed.status === 0 && /leaderboard-funding\.json.*NOT IMPORTED/.test(allowed.stdout), "--allow-lazy accepts it and still prints it");
} finally {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await c.end();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
