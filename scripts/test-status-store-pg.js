// The /status probe store against a REAL Postgres (STATE_DATABASE_URL set):
//   1. the SQLite file is imported once at the first boot with the database
//      on, the import is marked, and a second boot does not import again;
//   2. writes go to the table and a fresh instance (a new container) reads
//      them from the table, not from a file;
//   3. the invariant: idempotent on (source, component, ts) and the count the
//      page prints is exactly the table's count, after duplicates, after a
//      batch with a duplicate inside, and after the OTHER container's writes
//      arrive through the refresh (read twice: the margin re-read adds nothing);
//   4. the page builds from the store as it does in production.
// Requires STATE_DATABASE_URL (CI fails without it; locally it skips).
//
//   node scripts/test-status-store-pg.js
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-status-store-pg" });
const sdb = await import("../src/state-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const dir = mkdtempSync(join(tmpdir(), "a402-status-pg-"));
const FILE = join(dir, "status.db");
process.env.STATUS_DB_PATH = FILE;
const NOW = Date.now();
const DAY = 86400000;
const S = () => `${process.env.STATE_DB_SCHEMA}.status_probes`;
const dbCount = async () => Number((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM ${S()}`)).rows[0].n);
const seedFile = (rows) => {
  const g = new Database(FILE);
  g.exec(`CREATE TABLE IF NOT EXISTS status_probes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, component TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT, url TEXT);
          CREATE UNIQUE INDEX IF NOT EXISTS status_probes_unique ON status_probes (source, component, ts);`);
  const ins = g.prepare("INSERT OR IGNORE INTO status_probes (ts, source, component, ok, detail, url) VALUES (?, ?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(r.ts, r.source, r.component, r.ok ? 1 : 0, r.detail ?? null, r.url ?? null);
  g.close();
};
const instances = [];
try {
  // ---- 1. import once ---------------------------------------------------------
  const OLD = NOW - 400 * DAY; // outside the mirror's window: only the aggregates see it
  seedFile([
    { ts: OLD, source: "heartbeat", component: "api", ok: true },
    { ts: NOW - 2 * DAY, source: "heartbeat", component: "api", ok: false, detail: "/health", url: "https://example.test/run/1" },
    { ts: NOW - DAY, source: "cloudflare-cron", component: "api", ok: true },
  ]);
  const a = await import("../src/status-store.js");
  instances.push(a);
  ok(await a.statusStoreReady(), "first boot: the store loads");
  const mark = await sdb.imports.done("status.db");
  ok(mark && mark.source === FILE, "first boot: the import is marked under the file's basename");
  ok((await dbCount()) === 3, "first boot: every row of the file is in the table");
  ok(a.totalObservations() === 3 && a.earliestObservation() === OLD, "the count and the earliest observation cover the whole table, window or not");
  ok(a.probeRows("api", 0).length === 2 && a.probeRows("api", 0)[0].ts === NOW - 2 * DAY, "the window rows read oldest first (the row outside the window is not materialized)");
  ok(a.probeCounts("api", NOW - 3 * DAY).observed === 2 && a.probeCounts("api", NOW - 3 * DAY).up === 1, "probeCounts counts the window");
  const latest = a.latestByComponent();
  ok(latest.length === 1 && latest[0].component === "api" && latest[0].ts === NOW - DAY && latest[0].ok === 1, "latestByComponent is the newest row");
  ok(a.latestBySource("api").map((r) => r.source).join() === "cloudflare-cron,heartbeat" && a.latestBySource("api")[1].detail === "/health", "latestBySource lists each observer's newest row, by source");
  ok(a.statusPersistent() === true, "history is persistent (the database)");

  // A row written to the file AFTER the import (a rollback would do this) is
  // not imported by the next boot: the mark holds.
  seedFile([{ ts: NOW - 12 * 3600_000, source: "heartbeat", component: "mcp", ok: true }]);
  const b = await import("../src/status-store.js?second");
  instances.push(b);
  ok(await b.statusStoreReady(), "second boot: the store loads");
  ok((await dbCount()) === 3 && b.totalObservations() === 3 && b.latestByComponent().length === 1, "second boot: the file is not imported again (the mark holds)");

  // ---- 2. writes go to the table; a fresh instance reads them -----------------
  ok(a.recordProbe({ ts: NOW - 60_000, source: "heartbeat", component: "api", ok: true }) === true, "recordProbe answers synchronously");
  ok(a.probeRows("api", NOW - 120_000).length === 1 && a.latestByComponent()[0].ts === NOW - 60_000, "the row is in the mirror at once (the next render shows it)");
  await a.statusStoreFlush();
  ok((await dbCount()) === 4 && a.totalObservations() === 4, "the row is in the table and counted once it landed");
  const c = await import("../src/status-store.js?third");
  instances.push(c);
  ok(await c.statusStoreReady(), "a fresh instance loads");
  ok(c.totalObservations() === 4 && JSON.stringify(c.probeRows("api", 0)) === JSON.stringify(a.probeRows("api", 0)), "a fresh instance reads the same rows from the table");

  // ---- 3. idempotent on (source, component, ts); the count stays exact ---------
  a.recordProbe({ ts: NOW - 60_000, source: "heartbeat", component: "api", ok: true });
  await a.statusStoreFlush();
  ok((await dbCount()) === 4 && a.totalObservations() === 4 && a.probeRows("api", NOW - 120_000).length === 1, "a duplicate is ignored by the table and by the mirror");
  const written = a.recordProbes([
    { ts: NOW - 50_000, source: "backfill", component: "api", ok: true },
    { ts: NOW - 40_000, source: "backfill", component: "api", ok: true },
    { ts: NOW - 50_000, source: "backfill", component: "api", ok: true }, // duplicate inside the batch
    { ts: NOW - 60_000, source: "heartbeat", component: "api", ok: true }, // duplicate of a stored row
  ]);
  ok(written === 2, `a batch reports only its genuinely new rows (${written})`);
  await a.statusStoreFlush();
  ok((await dbCount()) === 6 && a.totalObservations() === 6, "the count follows the batch exactly");

  // The OTHER container writes; this one sees it at the next refresh, and a
  // second refresh (which re-reads the margin) adds nothing.
  b.recordProbe({ ts: NOW - 30_000, source: "cloudflare-cron", component: "api", ok: false, detail: "health 503" });
  b.recordProbe({ ts: NOW - 500 * DAY, source: "backfill", component: "mcp", ok: true }); // outside the window: aggregates only
  await b.statusStoreFlush();
  ok(b.totalObservations() === 5 && a.totalObservations() === 6, "before the refresh each container counts only what it loaded and wrote itself");
  const arrived = await a.statusStoreRefresh();
  ok(arrived === 2 && a.totalObservations() === 8 && (await dbCount()) === 8, `the other container's rows arrive through the refresh (${arrived})`);
  ok(a.latestByComponent().find((r) => r.component === "api")?.detail === "health 503", "and the newest row per component follows");
  ok(a.earliestObservation() === NOW - 500 * DAY && a.latestByComponent().some((r) => r.component === "mcp"), "a row outside the window still moves the earliest observation and the newest-per-component");
  ok(a.probeRows("mcp", 0).length === 0, "but it is not materialized in the window");
  ok((await a.statusStoreRefresh()) === 0 && a.totalObservations() === 8, "a second refresh re-reads the margin and adds nothing");
  // Both containers accept the same new observation at once: one insert wins,
  // both counts end exact.
  a.recordProbe({ ts: NOW - 20_000, source: "heartbeat", component: "paywall", ok: true });
  b.recordProbe({ ts: NOW - 20_000, source: "heartbeat", component: "paywall", ok: true });
  await Promise.all([a.statusStoreFlush(), b.statusStoreFlush()]);
  await a.statusStoreRefresh(); await b.statusStoreRefresh();
  const n = await dbCount();
  ok(n === 9 && a.totalObservations() === 9 && b.totalObservations() === 9, `the same row from two containers is one row and both counts equal the table (${n})`);
  ok((await sdb.stateQuery(`SELECT count(*)::bigint AS n FROM (SELECT DISTINCT source, component, ts FROM ${S()}) d`)).rows[0].n === String(n), "(source, component, ts) is unique in the table");
  const cFresh = await import("../src/status-store.js?fourth");
  instances.push(cFresh);
  await cFresh.statusStoreReady();
  ok(cFresh.totalObservations() === 9 && cFresh.latestByComponent().map((r) => r.component).join() === "api,mcp,paywall", "a container booted now reads the whole picture");
  await b.statusStoreRefresh();
  ok(b.totalObservations() === 9, "the container that lagged catches up on its refresh");

  // ---- 4. the page builds from the store ----------------------------------------
  const { statusSnapshot, statusPage, STRIP_DAYS } = await import("../src/status.js");
  const snap = statusSnapshot({ baseUrl: "https://example.test", nowMs: NOW, live: {} });
  ok(snap.measurement.totalObservations === 9 && snap.measurement.persistent === true, "the snapshot prints the table's count");
  const api = snap.components.find((x) => x.key === "api");
  ok(api.current.state === "outage" && api.windows["90d"].observed === api.observed, "the api component reads its current state and its windows from the mirror");
  ok(typeof statusPage("https://example.test", {}, snap) === "string", "the page renders");
  const statusSrc = readFileSync(new URL("../src/status.js", import.meta.url), "utf8");
  const longest = Math.max(...[...statusSrc.matchAll(/ms:\s*(\d+)\s*\*\s*DAY/g)].map((m) => Number(m[1])));
  ok(longest * DAY <= a.MIRROR_WINDOW_MS && STRIP_DAYS * DAY <= a.MIRROR_WINDOW_MS, `the mirror holds the page's longest window (${longest} days)`);
} finally {
  for (const i of instances) i._resetForTest();
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\ntest-status-store-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
