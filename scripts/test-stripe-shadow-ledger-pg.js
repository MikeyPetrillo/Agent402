#!/usr/bin/env node
// The Stripe SHADOW ledger (src/stripe-shadow-ledger.js) on the state
// database: the SQLite file is imported once at the first boot with the
// database on (and never again), record() writes land in the stripe_shadow
// table where a fresh instance reads them, and the money invariant holds on
// Postgres: a settlement is mirrored at most once (the tx hash is the primary
// key), a claimed row is never sent by a second drain while it is in flight
// (two drains overlapping claim disjoint rows; a `sending` row younger than
// the stale window is left alone, an older one is reclaimed). No network: X
// is a stub fetch that replays by Idempotency-Key the way Stripe does.
//
// Needs STATE_DATABASE_URL (CI fails without it; locally it prints SKIP).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-stripe-shadow-ledger-pg" });
const sdb = await import("../src/state-db.js");
const { createShadowLedger, SHADOW_DB_FILE } = await import("../src/stripe-shadow-ledger.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const DIR = mkdtempSync(join(tmpdir(), "shadow-pg-"));
const ENV_ON = { STRIPE_SHADOW_LEDGER: "on", STRIPE_SECRET_KEY: "sk_test_shadow" };
const quiet = () => {};
const T = `${process.env.STATE_DB_SCHEMA}.stripe_shadow`;
const TX = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
const SALE = { slug: "research-deep", priceUsd: 5, rail: "usdc", network: "base", tx: TX("a"), synthetic: false };

/** A stub Stripe: replays by Idempotency-Key, so a second POST for one tx is visible as a second call but never a second PaymentIntent. */
function stubStripe({ delayMs = 0, status = 200 } = {}) {
  const calls = [];
  const byKey = new Map();
  let n = 0;
  const impl = async (url, init) => {
    calls.push({ key: init.headers["Idempotency-Key"] });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const key = init.headers["Idempotency-Key"];
    if (status !== 200) return { status, json: async () => ({ error: { type: "api_error" } }) };
    if (!byKey.has(key)) byKey.set(key, { id: `pi_stub_${++n}` });
    return { status: 200, json: async () => byKey.get(key) };
  };
  return { impl, calls, created: () => byKey.size };
}
const rowsOf = async (where = "TRUE", params = []) => (await sdb.stateQuery(`SELECT * FROM ${T} WHERE ${where} ORDER BY tx`, params)).rows;

try {
  // ---- 1. import once ----------------------------------------------------------
  const dbFile = join(DIR, SHADOW_DB_FILE);
  {
    const src = new Database(dbFile);
    src.exec(`CREATE TABLE shadow (tx TEXT PRIMARY KEY, stripe_net TEXT, chain TEXT, slug TEXT, cents INTEGER NOT NULL DEFAULT 0, price_usd REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT, pi_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_at INTEGER NOT NULL DEFAULT 0)`);
    const ins = src.prepare("INSERT INTO shadow (tx, stripe_net, chain, slug, cents, price_usd, status, reason, pi_id, attempts, created_at, updated_at, next_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    ins.run(TX("1"), "base", "base", "old-recorded", 500, 5, "recorded", null, "pi_old_1", 1, 1000, 1000, 0);
    ins.run(TX("2"), "base", "base", "old-pending", 1500, 15, "pending", null, null, 0, 2000, 2000, 0);
    ins.run(TX("3"), null, "polygon", "old-skipped", 0, 5, "skipped", "network-unsupported", null, 0, 3000, 3000, 0);
    src.close();
  }
  const s1 = stubStripe();
  const a = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s1.impl, intervalMs: 0, log: quiet });
  ok(a.backend === "pg", "with STATE_DATABASE_URL the ledger's backend is pg");
  ok(await a.ready() === true, "the table is created and the file imported at the first boot");
  const imported = await rowsOf();
  ok(imported.length === 3 && imported.map((r) => r.slug).sort().join() === "old-pending,old-recorded,old-skipped", `the SQLite file's rows are in the table (${imported.length})`);
  ok(imported.find((r) => r.tx === TX("1"))?.pi_id === "pi_old_1" && imported.find((r) => r.tx === TX("2"))?.status === "pending", "statuses and PaymentIntent ids are carried over");
  const mark = await sdb.imports.done(SHADOW_DB_FILE);
  ok(mark && mark.source === dbFile && mark.bytes > 0, `the import is marked under the file's basename (${SHADOW_DB_FILE})`);
  // A row added to the file after the import must NOT appear: a second boot
  // sees the mark and does not re-import.
  {
    const src = new Database(dbFile);
    src.prepare("INSERT INTO shadow (tx, stripe_net, chain, slug, cents, price_usd, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(TX("9"), "base", "base", "late-file-row", 100, 1, "pending", 9000, 9000);
    src.close();
  }
  const b = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s1.impl, intervalMs: 0, log: quiet });
  await b.ready();
  ok((await rowsOf("tx = $1", [TX("9")])).length === 0, "a second boot does not re-import the file (a row added to it later is not in the table)");
  ok(a._db === null && b._db === null, "no SQLite handle is opened in pg mode");

  // ---- 2. writes go to the table; a fresh instance sees them -------------------
  a.record(SALE);
  a.record({ ...SALE, tx: TX("b"), priceUsd: 0.001, slug: "sub-cent" });
  await a.flush();
  const c = createShadowLedger({ env: ENV_ON, dbFile: join(DIR, "other-dir", SHADOW_DB_FILE), fetchImpl: s1.impl, intervalMs: 0, log: quiet });
  await c.ready();
  const fresh = await c.reportAsync();
  ok(fresh.backend === "pg" && fresh.counts.pending === 2 && fresh.counts.skipped === 2 && fresh.counts.recorded === 1, `a fresh instance reads the rows (${JSON.stringify(fresh.counts)})`);
  ok(fresh.ourSide.settlementsSeen === 5, "the imported rows and the new ones are one ledger");
  const sync1 = c.report();
  ok(sync1.counts?.pending === 2 && typeof sync1.snapshotAt === "string", "the synchronous report() answers from the snapshot the async read took");

  // ---- 3. the invariant: at most once, never re-sent in flight ----------------
  a.record(SALE); a.record({ ...SALE, slug: "other", priceUsd: 9 }); // replays of one tx
  await a.flush();
  ok((await rowsOf("tx = $1", [SALE.tx])).length === 1, "a replayed settlement is one row: the tx hash is the primary key");
  // Two drains overlapping (two containers, or two ticks) claim disjoint rows.
  const slow = stubStripe({ delayMs: 150 });
  const d1 = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: slow.impl, intervalMs: 0, log: quiet, batchSize: 1 });
  const d2 = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: slow.impl, intervalMs: 0, log: quiet, batchSize: 1 });
  await Promise.all([d1.ready(), d2.ready()]);
  const [r1, r2] = await Promise.all([d1.drain(), d2.drain()]);
  ok(r1.attempted === 1 && r2.attempted === 1 && slow.calls.length === 2 && new Set(slow.calls.map((x) => x.key)).size === 2, `two overlapping drains claim DIFFERENT rows (${slow.calls.map((x) => x.key.slice(0, 6)).join(",")})`);
  await Promise.all([d1.drain(), d2.drain()]);
  ok(slow.calls.length === 2 && slow.created() === 2, "nothing is sent twice: both pending rows are recorded after one send each");
  const recorded = await rowsOf("status = 'recorded'");
  ok(recorded.length === 3 && recorded.every((r) => r.pi_id), "every posted row holds its PaymentIntent id");
  // A row mid-send on another container (sending, young) is left alone by a
  // boot and a drain; one past the stale window is reclaimed and sent once.
  const t = Date.now();
  await sdb.stateQuery(`INSERT INTO ${T} (tx, stripe_net, chain, slug, cents, price_usd, status, attempts, created_at, updated_at, next_at) VALUES ($1,'base','base','in-flight',500,5,'sending',1,$2,$2,0), ($3,'base','base','crashed',500,5,'sending',1,$4,$4,0)`, [TX("c"), t, TX("d"), t - 60 * 60_000]);
  const s3 = stubStripe();
  const e = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s3.impl, intervalMs: 0, log: quiet });
  await e.ready();
  const after = Object.fromEntries((await rowsOf("tx = ANY($1)", [[TX("c"), TX("d")]])).map((r) => [r.slug, r.status]));
  ok(after["in-flight"] === "sending" && after.crashed === "pending", `a boot reclaims only the stale sending row (${JSON.stringify(after)})`);
  await e.drain();
  ok(s3.calls.length === 1 && s3.calls[0].key === TX("d"), "the drain sends the reclaimed row once and never the one in flight");
  ok((await rowsOf("tx = $1", [TX("c")]))[0].status === "sending", "the in-flight row is still the other container's");

  // ---- 4. a transient failure retries with backoff, then abandons, on the table
  const s5 = stubStripe({ status: 503 });
  const f = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: s5.impl, intervalMs: 0, log: quiet, maxAttempts: 2, backoffMs: 0 });
  await f.ready();
  f.record({ ...SALE, tx: TX("e"), slug: "flaky" });
  await f.flush();
  await f.drain();
  ok((await rowsOf("tx = $1", [TX("e")]))[0].status === "pending", "a 503 puts the row back to pending");
  await f.drain();
  const fr = (await rowsOf("tx = $1", [TX("e")]))[0];
  ok(fr.status === "abandoned" && String(fr.reason).endsWith(":max-attempts") && Number(fr.attempts) === 2, `exhausted after maxAttempts (${fr.status}, ${fr.reason})`);
  const rep = await f.reportAsync({ limit: 3 });
  ok(rep.recent.length === 3 && rep.counts.abandoned === 1 && typeof rep.recent[0].created_at === "number", "the report's recent list honours its limit and carries numbers, not strings");

  // ---- 5. a finish lands only on the row this drain still holds -------------
  // While this drain's post is in flight, the row is reclaimed and recorded by
  // another container (a post that outlived the stale window). This drain's
  // answer (a transient failure) must not put the recorded row back to pending.
  let g = null;
  const raced = { impl: async () => {
    await sdb.stateQuery(`UPDATE ${T} SET status = 'recorded', pi_id = 'pi_other', updated_at = $2 WHERE tx = $1`, [TX("f"), Date.now()]);
    return { status: 503, json: async () => ({ error: { type: "api_error" } }) };
  } };
  g = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: raced.impl, intervalMs: 0, log: quiet, backoffMs: 0 });
  await g.ready();
  g.record({ ...SALE, tx: TX("f"), slug: "raced" });
  await g.flush();
  await g.drain();
  const gr = (await rowsOf("tx = $1", [TX("f")]))[0];
  ok(gr.status === "recorded" && gr.pi_id === "pi_other", `a finish does not overwrite a row another container recorded meanwhile (${gr.status}, ${gr.pi_id})`);

  // ---- 6. a store whose first load failed is not inert for good -------------
  // (the boot-blip suite covers the database refusing at boot; here the
  // import bookkeeping is unreachable for one load, then back.)
  const S = process.env.STATE_DB_SCHEMA;
  await sdb.stateQuery(`ALTER TABLE ${S}.imports RENAME TO imports_away`);
  const h = createShadowLedger({ env: ENV_ON, dbFile, fetchImpl: stubStripe().impl, intervalMs: 0, log: quiet });
  const firstLoad = await h.ready();
  h.record({ ...SALE, tx: TX("9"), slug: "while-away" });
  await sdb.stateQuery(`ALTER TABLE ${S}.imports_away RENAME TO imports`);
  ok(firstLoad === false && (await h.ready()) === true, `the first load fails while the table is away, and the next call retries it (${firstLoad})`);
  await h.flush();
  ok(h.report().live === true && (await rowsOf("tx = $1", [TX("9")])).length === 1, "and the record made meanwhile lands; the ledger is live");
  for (const l of [a, b, c, d1, d2, e, f, g, h]) l.stop();
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} assertions, ${fail} failures`);
process.exit(fail ? 1 : 0);
