#!/usr/bin/env node
// Export the state database back into the volume's file formats: the way back
// to file mode (a rollback to a build that reads /data) after the volume's own
// copies are gone or stale.
//
//   STATE_DATABASE_URL=... [STATE_DB_SCHEMA=state] node scripts/state-export.js --out <dir> [--force]
//
// <dir> becomes a volume-shaped directory, in the exact format each store
// reads in file mode:
//   - every SQLite ledger (agent402-sales.db, agent402-refunds.db, the Decide,
//     stats, memory, status, economy, revenue, Stripe shadow and replay-set
//     files): each file is CREATED BY ITS OWN MODULE in file mode (its schema,
//     indexes, triggers and migration marks), then filled with the table's
//     rows (column for column; a camelCase SQLite column takes the snake_case
//     state column)
//   - every JSON document as <name> (the body exactly as stored)
//   - every record collection as a directory of <id>.json files (credits/,
//     human-checkout/, mcp-tasks/, async-jobs/, traffic/)
//   - the crawl cache as x402-index-cache.ndjson (header line, then one
//     [origin, entry] per line)
//   - every log stream as its NDJSON file (outbound-spend.ndjson, wishes.jsonl)
// Every table is read inside ONE repeatable-read transaction: the export is
// one consistent snapshot. The bookkeeping tables (imports, leases) are not
// exported. A state table, collection or stream with no file shape is listed
// and makes the exit code 1, so nothing is dropped silently.
//
// To roll back: stop the app, run this into an empty directory, check it
// (scripts/state-ledger-checksum.js --data <dir> and
// scripts/state-migration-verify.js --data <dir> compare it row for row and
// count for count against the database), copy it onto the volume, then start
// the file-mode build. Refuses a non-empty --out unless --force.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import pg from "pg";
import { SQLITE_STORES, RECORD_DIRS, LOG_FILES, INDEX_CACHE } from "./lib/state-stores.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BOOKKEEPING = new Set(["imports", "leases"]);
const GENERIC = new Set(["documents", "records", "log_lines"]);
const snake = (c) => c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const PAGE = 2000;

async function* cursorRows(client, sql, params = []) {
  await client.query(`DECLARE a402_export_cur NO SCROLL CURSOR FOR ${sql}`, params);
  try {
    for (;;) {
      const page = await client.query(`FETCH ${PAGE} FROM a402_export_cur`);
      if (!page.rows.length) break;
      yield* page.rows;
    }
  } finally { await client.query("CLOSE a402_export_cur"); }
}
const writeLines = async (file, gen) => {
  const out = createWriteStream(file);
  let n = 0;
  for await (const line of gen) { if (!out.write(line + "\n")) await new Promise((r) => out.once("drain", r)); n++; }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  return n;
};

/** Export the state database into `outDir`. Returns a report. */
export async function exportState(outDir, { url = process.env.STATE_DATABASE_URL, schema = process.env.STATE_DB_SCHEMA || "state", force = false, log = () => {} } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error(`bad schema "${schema}"`);
  const out = resolve(outDir);
  if (existsSync(out) && readdirSync(out).length && !force) throw new Error(`${out} is not empty (pass --force to write into it)`);
  mkdirSync(out, { recursive: true });

  // 1. Every SQLite file, created by its own module in file mode.
  const env = { ...process.env, FREE_MODE: "true" };
  delete env.STATE_DATABASE_URL; delete env.STATE_DB_SCHEMA;
  const boot = spawnSync(process.execPath, [join(here, "lib", "state-stores.mjs"), "boot", out], { env, encoding: "utf8" });
  if (boot.status !== 0) throw new Error(`creating the SQLite files failed: ${(boot.stderr || "").slice(-600)}`);

  const report = { out, schema, sqlite: {}, documents: 0, records: {}, logs: {}, droppedColumns: {}, unmapped: [] };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'", [schema])).rows.map((r) => r.table_name));
    const covered = new Set([...BOOKKEEPING, ...GENERIC]);

    // 2. SQLite ledgers.
    for (const store of SQLITE_STORES) {
      const db = new Database(join(out, store.file));
      try {
        for (const [sTable, pTable] of Object.entries(store.tables)) {
          covered.add(pTable);
          if (!tables.has(pTable)) { report.sqlite[`${store.file}:${sTable}`] = 0; continue; }
          const sCols = db.prepare(`PRAGMA table_info("${sTable}")`).all().map((c) => c.name);
          if (!sCols.length) throw new Error(`${store.file} has no ${sTable} table after its module created it`);
          const pTypes = Object.fromEntries((await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2", [schema, pTable])).rows.map((r) => [r.column_name, r.data_type]));
          const pairs = sCols.map((c) => [c, c in pTypes ? c : snake(c) in pTypes ? snake(c) : null]).filter(([, p]) => p);
          const dropped = Object.keys(pTypes).filter((p) => !pairs.some(([, x]) => x === p));
          if (dropped.length) report.droppedColumns[pTable] = dropped;
          const conv = pairs.map(([, p]) => {
            const t = pTypes[p];
            if (/^(bigint|integer|smallint)$/.test(t)) return (v) => (v === null ? null : BigInt(v));
            if (t === "boolean") return (v) => (v === null ? null : v ? 1 : 0);
            if (/^jsonb?$/.test(t)) return (v) => (v === null ? null : JSON.stringify(v));
            if (/^timestamp/.test(t)) return (v) => (v === null ? null : new Date(v).getTime());
            if (t === "numeric") return (v) => (v === null ? null : Number(v));
            return (v) => v;
          });
          db.prepare(`DELETE FROM "${sTable}"`).run();
          const ins = db.prepare(`INSERT INTO "${sTable}" (${pairs.map(([c]) => `"${c}"`).join(", ")}) VALUES (${pairs.map(() => "?").join(", ")})`);
          // json/jsonb columns come back as text so a large number stays exact.
          const sel = pairs.map(([, p]) => (/^jsonb?$/.test(pTypes[p]) ? `"${p}"::text AS "${p}"` : `"${p}"`)).join(", ");
          const jsonText = new Set(pairs.filter(([, p]) => /^jsonb?$/.test(pTypes[p])).map(([, p]) => p));
          let n = 0, batch = [];
          const flush = db.transaction((rows) => { for (const r of rows) ins.run(...r); });
          for await (const row of cursorRows(client, `SELECT ${sel} FROM ${schema}.${pTable}`)) {
            batch.push(pairs.map(([, p], i) => (jsonText.has(p) ? row[p] : conv[i](row[p]))));
            if (batch.length >= PAGE) { flush(batch); n += batch.length; batch = []; }
          }
          flush(batch); n += batch.length;
          report.sqlite[`${store.file}:${sTable}`] = n;
          log(`${store.file} ${sTable}: ${n} row(s)`);
        }
        db.pragma("wal_checkpoint(TRUNCATE)");
      } finally { db.close(); }
    }

    // 3. JSON documents, exactly as stored.
    if (tables.has("documents")) {
      for await (const row of cursorRows(client, `SELECT name, body::text AS body FROM ${schema}.documents ORDER BY name`)) {
        if (!/^[a-z0-9][a-z0-9._:-]{0,120}$/.test(row.name)) { report.unmapped.push(`document ${row.name}`); continue; }
        writeFileSync(join(out, row.name), row.body);
        report.documents++;
      }
    }

    // 4. Record collections: a directory each; the crawl cache as its NDJSON file.
    if (tables.has("records")) {
      const collections = (await client.query(`SELECT collection, count(*)::bigint AS n FROM ${schema}.records GROUP BY collection ORDER BY collection`)).rows;
      for (const { collection, n } of collections) {
        if (collection === INDEX_CACHE.collection) {
          const lines = (async function* () {
            yield JSON.stringify({ savedAt: Date.now(), format: "ndjson-v1", origins: Number(n) });
            for await (const r of cursorRows(client, `SELECT id, body::text AS body FROM ${schema}.records WHERE collection = $1 ORDER BY id`, [collection])) yield `[${JSON.stringify(r.id)},${r.body}]`;
          })();
          report.records[collection] = (await writeLines(join(out, INDEX_CACHE.file), lines)) - 1;
          continue;
        }
        const spec = RECORD_DIRS.find((d) => d.collection === collection);
        if (!spec) report.unmapped.push(`records collection ${collection} (${n} row(s)) written to ${collection}/`);
        const dir = join(out, spec ? spec.dir : collection);
        mkdirSync(dir, { recursive: true });
        let k = 0;
        for await (const r of cursorRows(client, `SELECT id, body::text AS body FROM ${schema}.records WHERE collection = $1 ORDER BY id`, [collection])) {
          const name = spec ? spec.fileOf(r.id) : `${r.id}.json`;
          if (!/^[A-Za-z0-9_.:-]+$/.test(name) || name.includes("..")) { report.unmapped.push(`record ${collection}/${r.id}`); continue; }
          writeFileSync(join(dir, name), r.body);
          k++;
        }
        report.records[collection] = k;
      }
    }

    // 5. Log streams, in order.
    if (tables.has("log_lines")) {
      const streams = (await client.query(`SELECT DISTINCT stream FROM ${schema}.log_lines ORDER BY stream`)).rows.map((r) => r.stream);
      for (const stream of streams) {
        const spec = LOG_FILES.find((l) => l.stream === stream);
        if (!spec) report.unmapped.push(`log stream ${stream} written to ${stream}.ndjson`);
        const file = join(out, spec ? spec.file : `${String(stream).replace(/[^a-z0-9._-]/gi, "_")}.ndjson`);
        const lines = (async function* () { for await (const r of cursorRows(client, `SELECT body::text AS body FROM ${schema}.log_lines WHERE stream = $1 ORDER BY id`, [stream])) yield r.body; })();
        report.logs[stream] = await writeLines(file, lines);
      }
    }

    for (const t of tables) if (!covered.has(t)) report.unmapped.push(`table ${t} (no file shape)`);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { await client.end().catch(() => {}); }
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  if (!opt("--out")) { console.error("usage: STATE_DATABASE_URL=... node scripts/state-export.js --out <dir> [--force]"); process.exit(2); }
  if (!String(process.env.STATE_DATABASE_URL || "").trim()) { console.error("STATE_DATABASE_URL is required"); process.exit(2); }
  try {
    const r = await exportState(opt("--out"), { force: args.includes("--force"), log: (m) => console.log(m) });
    console.log(`documents: ${r.documents}`);
    for (const [k, v] of Object.entries(r.records)) console.log(`records ${k}: ${v}`);
    for (const [k, v] of Object.entries(r.logs)) console.log(`log ${k}: ${v} line(s)`);
    for (const [k, v] of Object.entries(r.droppedColumns)) console.log(`note: ${k} columns with no file column (the file shape never held them): ${v.join(", ")}`);
    for (const u of r.unmapped) console.log(`UNMAPPED: ${u}`);
    console.log(`exported ${r.schema} into ${r.out}${r.unmapped.length ? ` with ${r.unmapped.length} unmapped item(s)` : ""}`);
    process.exit(r.unmapped.length ? 1 : 0);
  } catch (e) { console.error(String(e?.message || e)); process.exit(1); }
}
