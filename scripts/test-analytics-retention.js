// The call log (tool_calls) has a retention and its pool has server-side
// limits. Against a real Postgres (required under CI):
//   - rows older than the cutoff are deleted in bounded batches, oldest first,
//     and newer rows stay; a run stops at its batch bound and says more remain;
//   - while another container holds the lease, a second runner deletes nothing;
//   - a statement slower than the pool's statement limit is canceled by the
//     server, and the insert path does not throw while that happens;
//   - the retention never drops under the dashboard's widest window, and the
//     knob's off value keeps everything.
// Requires STATE_DATABASE_URL (CI fails without it). The table lives in a
// database of its own, created here and dropped at the end, so parallel runs
// never share rows.
import pg from "pg";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { requireTestPg } from "./lib/test-pg.js";
const { url } = requireTestPg({ label: "test-analytics-retention" });

const dbName = `t_calls_${randomBytes(5).toString("hex")}`;
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const own = new URL(url);
own.pathname = `/${dbName}`;
process.env.ANALYTICS_DATABASE_URL = own.toString();
delete process.env.ANALYTICS_TEST_CAPTURE;
delete process.env.TOOL_CALLS_RETENTION_DAYS;
const STATEMENT_MS = 700;
process.env.ANALYTICS_DB_STATEMENT_TIMEOUT_MS = String(STATEMENT_MS);

const sdb = await import("../src/state-db.js");
const adb = await import("../src/analytics-db.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const direct = new pg.Client({ connectionString: own.toString() });
const count = async (where = "TRUE") => (await direct.query(`SELECT count(*)::int AS n FROM tool_calls WHERE ${where}`)).rows[0].n;
const DAY = 86_400_000;

try {
  // The knob.
  ok(adb.toolCallsRetentionDays({}) === 180, "the retention defaults to 180 days");
  ok(adb.toolCallsRetentionDays({ TOOL_CALLS_RETENTION_DAYS: "365" }) === 365, "TOOL_CALLS_RETENTION_DAYS sets it");
  ok(adb.toolCallsRetentionDays({ TOOL_CALLS_RETENTION_DAYS: "7" }) === adb.RETENTION_MIN_DAYS && adb.RETENTION_MIN_DAYS * 24 > adb.MAX_WINDOW_HOURS,
    "a value under the dashboard's widest window is raised past it");
  ok(adb.toolCallsRetentionDays({ TOOL_CALLS_RETENTION_DAYS: "off" }) === 0 && adb.toolCallsRetentionDays({ TOOL_CALLS_RETENTION_DAYS: "0" }) === 0, "off and 0 keep everything");
  ok(adb.toolCallsRetentionDays({ TOOL_CALLS_RETENTION_DAYS: "soon" }) === 180 && adb.toolCallsRetentionDays({ TOOL_CALLS_RETENTION_DAYS: "-3" }) === 180, "a malformed value keeps the default");

  ok(/^startToolCallRetention\(\);$/m.test(readFileSync(new URL("../src/server.js", import.meta.url), "utf8")), "the server starts the daily retention tick");
  const init = await adb.initAnalyticsDb();
  ok(init.ok === true, "the schema is created");
  await direct.connect();

  // 2,300 rows older than 180 days, 40 just inside it, 60 recent.
  const now = Date.now();
  await direct.query(`INSERT INTO tool_calls (ts, slug, latency_ms) SELECT to_timestamp($1::double precision / 1000) - (g || ' minutes')::interval, 'old', 1 FROM generate_series(1, 2300) g`, [now - 181 * DAY]);
  await direct.query(`INSERT INTO tool_calls (ts, slug, latency_ms) SELECT to_timestamp($1::double precision / 1000) + (g || ' minutes')::interval, 'edge', 1 FROM generate_series(1, 40) g`, [now - 180 * DAY]);
  await direct.query(`INSERT INTO tool_calls (ts, slug, latency_ms) SELECT now() - (g || ' hours')::interval, 'new', 1 FROM generate_series(1, 60) g`);

  // The dashboard read is unchanged by the bounded join: every hour of the
  // window is a bucket and the buckets hold the window's rows.
  const a = await adb.getAnalytics({ windowHours: 48 });
  const sum = (a.timeseries || []).reduce((n, r) => n + r.calls, 0);
  ok(a.ok && a.timeseries.length === 49 && a.totals.calls >= 47 && sum >= a.totals.calls && sum <= a.totals.calls + 1, `the hourly series covers the window (${a.totals?.calls} calls, ${sum} in ${a.timeseries?.length} buckets)`);

  // Off: nothing is deleted.
  const off = await adb.pruneToolCalls({ retentionDays: 0, now });
  ok(off.deleted === 0 && off.reason === "off" && (await count()) === 2400, "with retention off nothing is deleted");

  // A bounded run: 2 batches of 500, oldest first, and it says more remain.
  const part = await adb.pruneToolCalls({ batchSize: 500, maxBatches: 2, pauseMs: 0, now });
  ok(part.ok && part.deleted === 1000 && part.batches === 2 && part.more === true, `a run stops at its batch bound (${JSON.stringify(part)})`);
  const oldestLeft = (await direct.query("SELECT extract(epoch from min(ts)) * 1000 AS t FROM tool_calls")).rows[0].t;
  ok((await count("slug = 'old'")) === 1300 && Number(oldestLeft) >= now - 181 * DAY - 1300 * 60_000 - 1000, "the oldest rows went first");

  // A held lease: the leased runner does nothing.
  await sdb.leases.acquire("tool-calls-retention", { owner: "other-container", ttlMs: 60_000 });
  const skipped = await adb.pruneToolCallsLeased({ batchSize: 500, pauseMs: 0, now });
  ok(skipped?.skipped === "leased" && (await count("slug = 'old'")) === 1300, "while another container holds the lease a second runner deletes nothing");
  await sdb.leases.release("tool-calls-retention", { owner: "other-container" });

  // The lease free: the rest goes in batches, newer rows stay.
  const rest = await adb.pruneToolCallsLeased({ batchSize: 500, pauseMs: 0, now });
  ok(rest.ok && rest.deleted === 1300 && rest.batches === 3 && rest.more === false, `the leased run deletes the rest in batches (${JSON.stringify(rest)})`);
  ok((await count("slug = 'old'")) === 0 && (await count("slug = 'edge'")) === 40 && (await count("slug = 'new'")) === 60, "rows inside the retention stay");
  ok((await sdb.leases.holder("tool-calls-retention")) === null, "the lease is released after the run");
  const again = await adb.pruneToolCalls({ pauseMs: 0, now });
  ok(again.ok && again.deleted === 0 && again.batches === 1, "a run with nothing to delete is one empty batch");

  // A lease lost mid-run: the run stops before its next batch and says more
  // remain, so the container that took the lease is the only one deleting.
  await direct.query(`INSERT INTO tool_calls (ts, slug, latency_ms) SELECT to_timestamp($1::double precision / 1000) - (g || ' minutes')::interval, 'lost', 1 FROM generate_series(1, 1200) g`, [now - 181 * DAY]);
  let asked = 0;
  const lost = await adb.pruneToolCalls({ batchSize: 500, pauseMs: 0, now, stillHeld: () => ++asked <= 1 });
  ok(lost.ok && lost.deleted === 500 && lost.batches === 1 && lost.more === true && asked === 2 && (await count("slug = 'lost'")) === 700, `a lease that is gone after the first batch stops the run there, with more to do (${JSON.stringify(lost)}, asked ${asked})`);
  const never = await adb.pruneToolCalls({ batchSize: 500, pauseMs: 0, now, stillHeld: () => false });
  ok(never.ok && never.deleted === 0 && never.batches === 0 && never.more === true && (await count("slug = 'lost'")) === 700, "a lease already gone deletes nothing");
  const held = await adb.pruneToolCalls({ batchSize: 500, pauseMs: 0, now, stillHeld: () => true });
  ok(held.ok && held.deleted === 700 && held.more === false && (await count("slug = 'lost'")) === 0, "control: a lease held throughout deletes the rest");

  // The delete walks the ts index (no sort, no full scan of the table).
  await direct.query("ANALYZE tool_calls");
  await direct.query("SET enable_seqscan = off");
  const plan = (await direct.query("EXPLAIN DELETE FROM tool_calls WHERE id IN (SELECT id FROM tool_calls WHERE ts < now() - interval '180 days' ORDER BY ts ASC LIMIT 5000)")).rows.map((r) => r["QUERY PLAN"]).join("\n");
  ok(/Index (Only )?Scan( Backward)? using tool_calls_ts_idx/.test(plan) && !/\bSort\b/.test(plan), "the batch selects by the ts index, oldest first, with no sort");

  // The statement limit: a statement that outlasts it is canceled by the
  // server, a retention batch that hits it reports the error instead of
  // throwing, and the insert path never throws meanwhile.
  const holder = new pg.Client({ connectionString: own.toString() });
  await holder.connect();
  await direct.query(`INSERT INTO tool_calls (ts, slug, latency_ms) VALUES (now() - interval '400 days', 'locked', 1)`);
  await holder.query("BEGIN");
  await holder.query("SELECT id FROM tool_calls WHERE slug = 'locked' FOR UPDATE");
  const t0 = Date.now();
  const blocked = adb.pruneToolCalls({ pauseMs: 0 }); // waits on the locked row until the server cancels it
  let threw = false;
  const inserts = [];
  for (let i = 0; i < 5; i++) inserts.push(adb.recordToolCall({ slug: "during", latencyMs: 3, status: 200 }).catch(() => { threw = true; }));
  await Promise.all(inserts);
  // Bounded here too, so a pool with no limit fails this check instead of waiting on the lock for good.
  const cut = await Promise.race([blocked, new Promise((r) => setTimeout(() => r({ ok: false, error: "not canceled within 10 s" }), 10_000))]);
  const took = Date.now() - t0;
  ok(cut.ok === false && /statement timeout/i.test(cut.error || "") && took >= STATEMENT_MS - 50 && took < STATEMENT_MS + 8000, `a statement past the limit is canceled by the server (${took} ms, ${cut.error})`);
  ok(!threw && (await count("slug = 'during'")) === 5, "inserts made while a statement waits out its limit land and never throw");
  await holder.query("ROLLBACK");
  await holder.end();
  const freed = await adb.pruneToolCalls({ pauseMs: 0 });
  ok(freed.ok && freed.deleted === 1, "with the lock gone the next run deletes the row");

  // The insert path with the table gone: swallowed, never thrown.
  await direct.query("ALTER TABLE tool_calls RENAME TO tool_calls_gone");
  let insertThrew = false;
  await adb.recordToolCall({ slug: "x", latencyMs: 1, status: 200 }).catch(() => { insertThrew = true; });
  const broken = await adb.pruneToolCalls({ pauseMs: 0 });
  ok(!insertThrew && broken.ok === false && typeof broken.error === "string", "a failing insert is swallowed and a failing retention run reports its error");
} catch (e) {
  ok(false, `unexpected: ${e?.stack || e}`);
} finally {
  await direct.end().catch(() => {});
  await adb.closeAnalyticsDb();
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((e) => console.error(`could not drop ${dbName}: ${e.message}`));
  await admin.end();
}
console.log(`\ntest-analytics-retention: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
