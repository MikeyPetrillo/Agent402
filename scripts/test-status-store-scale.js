// The /status reads cost the same on any size of history.
//
// status_probes is never pruned: the page prints the whole span it has
// measured and the count of every observation, so old rows stay. The
// Cloudflare observer adds a row per component every 5 minutes, and the page
// rebuilds after every probe write, synchronously. The reads that picked each
// component's newest row ran a MAX(ts) subquery per row of the table, and the
// count scanned it, so every render grew with the history (measured on two
// million rows: about 0.8 s per build, against about 30 ms for the same page
// from the new reads).
//
// Two million rows are laid down with the table as production has it today
// (no count row, no triggers), then the store opens it, which is exactly what
// a deploy does, and more rows arrive through the store the way the observers
// write them. Pinned:
//   - the page is unchanged: the snapshot and the rendered HTML built from the
//     store equal the ones built from the whole-table queries the store used
//     before, on the same table;
//   - every history-independent read is an index SEARCH (no SCAN of the table,
//     no temporary sort), read from the store's own prepared statements;
//   - those reads stay fast on two million rows, and the whole snapshot builds
//     far faster than the whole-table version on the same machine;
//   - the kept count equals COUNT(*) after the first open, after live inserts,
//     after ignored duplicates and after a backfill batch;
//   - a backfilled older row never becomes a component's newest, and a tie on
//     ts goes to the row recorded last.
//
// Run: node scripts/test-status-store-scale.js
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "a402-status-scale-"));
const DB = join(dir, "status.db");
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}${detail ? ` (${detail})` : ""}`); }
};

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const TARGET_ROWS = 2_000_000;

// ── An empty store answers without rows ─────────────────────────────────────
// A second module instance (the query string) reads its own STATUS_DB_PATH.
{
  process.env.STATUS_DB_PATH = join(dir, "empty.db");
  const empty = await import("../src/status-store.js?empty");
  check("empty store: no components", empty.latestByComponent().length === 0);
  check("empty store: no sources", empty.latestBySource("paid-call").length === 0);
  check("empty store: count is 0", empty.totalObservations() === 0);
  check("empty store: no earliest observation", empty.earliestObservation() === null);
  empty._resetForTest();
}

// ── Two million rows, laid down with today's production schema ──────────────
// Set before status.js loads the store it reads through; the store opens the
// file lazily, so nothing touches it until the rows are down.
process.env.STATUS_DB_PATH = DB;
const { RAIL_COMPONENTS } = await import("../src/status.js");
{
  const t0 = performance.now();
  const g = new Database(DB);
  g.pragma("journal_mode = OFF");
  g.pragma("synchronous = OFF");
  // The table and indexes exactly as the store created them before this
  // change: no status_meta, no triggers. The store must adopt it on open.
  g.exec(`
    CREATE TABLE status_probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      component TEXT NOT NULL,
      ok INTEGER NOT NULL,
      detail TEXT,
      url TEXT
    );
    CREATE UNIQUE INDEX status_probes_unique ON status_probes (source, component, ts);
    CREATE INDEX status_probes_ts ON status_probes (component, ts);
    CREATE INDEX status_probes_ts_only ON status_probes (ts);
  `);
  const ins = g.prepare("INSERT INTO status_probes (ts, source, component, ok, detail, url) VALUES (?, ?, ?, ?, ?, ?)");
  // Deterministic PRNG so a failure reproduces.
  let seed = 0x5eed1234;
  const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
  const five = ["api", "catalog", "mcp", "paywall", "rails", "paid-call"];
  const hourly = [...five, "settlement"];
  const rails = RAIL_COMPONENTS.map((c) => c.key);
  let n = 0;
  let outageLeft = 0;
  g.transaction(() => {
    // Newest first, so the history ends a minute before NOW. Each observer
    // writes at its own offset inside the minute: no two sources share a ts
    // for a component, which keeps the comparison with the whole-table query
    // exact (that query picked arbitrarily among tied rows).
    for (let t = NOW - 60_000; n < TARGET_ROWS; t -= 5 * 60_000) {
      if (outageLeft === 0 && rnd() < 0.0015) outageLeft = 1 + Math.floor(rnd() * 12);
      const down = outageLeft > 0;
      if (outageLeft > 0) outageLeft--;
      for (const c of five) {
        const ok = c === "api" ? !down : rnd() > 0.002;
        ins.run(t + 21, "cloudflare-cron", c, ok ? 1 : 0, ok ? null : (c === "api" ? "health 503" : `${c}(1)`), null); n++;
      }
      if (t % 3600_000 === 3540_000) {
        for (const c of hourly) {
          const ok = rnd() > 0.01;
          ins.run(t + 13, "heartbeat", c, ok ? 1 : 0, ok ? null : `${c} probe failed`, "https://github.com/example/actions/runs/1"); n++;
        }
      }
      if (t % DAY === DAY - 60_000) {
        for (const c of rails) { ins.run(t + 17, "paid-canary", c, rnd() > 0.05 ? 1 : 0, null, null); n++; }
      }
    }
  })();
  g.close();
  console.log(`       (laid down ${n.toLocaleString()} rows in ${Math.round(performance.now() - t0)} ms)`);
}

// ── The store adopts the table, then the observers keep writing ─────────────
const store = await import("../src/status-store.js");
const { statusSnapshot, statusPage, COMPONENTS } = await import("../src/status.js");
const ref = new Database(DB, { readonly: true });
const refCount = () => ref.prepare("SELECT COUNT(*) AS n FROM status_probes").get().n;

check("the count kept on first open equals COUNT(*) of the existing table", store.totalObservations() === refCount(), `${store.totalObservations()} vs ${refCount()}`);

// Live rows through the store, as the probe intake writes them.
check("a live observation is recorded", store.recordProbe({ ts: NOW - 30_000, source: "cloudflare-cron", component: "api", ok: true }));
check("a live paid-call failure from the heartbeat is recorded", store.recordProbe({ ts: NOW - 45_000, source: "heartbeat", component: "paid-call", ok: false, detail: "pow-paid-call" }));
store.recordProbe({ ts: NOW - 30_000, source: "cloudflare-cron", component: "api", ok: true }); // duplicate: ignored
// A backfill batch inserted AFTER the live rows, reaching further back, with
// one duplicate inside the batch and one of the existing rows.
const backfill = [];
for (let i = 0; i < 500; i++) backfill.push({ ts: NOW - 1200 * DAY + i * 3600_000 + 7, source: "backfill", component: "api", ok: i % 50 !== 0, detail: i % 50 === 0 ? "backfilled failure" : null });
backfill.push({ ...backfill[0] });
backfill.push({ ts: NOW - 30_000, source: "cloudflare-cron", component: "api", ok: true });
check("the backfill writes only its new rows", store.recordProbes(backfill) === 500);
check("the kept count still equals COUNT(*) after live, duplicate and backfill writes", store.totalObservations() === refCount(), `${store.totalObservations()} vs ${refCount()}`);
check("the table is past two million rows", refCount() > TARGET_ROWS);

// ── The page is unchanged ───────────────────────────────────────────────────
// The whole-table reads the store used before this change, verbatim.
const refStore = {
  probeRows: store.probeRows,
  statusPersistent: store.statusPersistent,
  latestByComponent: () => ref.prepare(
    `SELECT component, ts, ok, detail, url FROM status_probes p
     WHERE ts = (SELECT MAX(ts) FROM status_probes q WHERE q.component = p.component)
     GROUP BY component
     ORDER BY component ASC`).all(),
  latestBySource: (component) => ref.prepare(
    `SELECT source, ts, ok, detail, url FROM status_probes p
     WHERE component = ?
       AND ts = (SELECT MAX(ts) FROM status_probes q WHERE q.component = p.component AND q.source = p.source)
     GROUP BY source
     ORDER BY source ASC`).all(String(component)),
  earliestObservation: () => ref.prepare("SELECT MIN(ts) AS ts FROM status_probes").get()?.ts ?? null,
  totalObservations: refCount,
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check("newest row per component matches the whole-table query", same(store.latestByComponent(), refStore.latestByComponent()));
const everyKey = [...COMPONENTS.map((c) => c.key), ...RAIL_COMPONENTS.map((c) => c.key), "never-observed"];
check("newest row per observer matches the whole-table query for every component",
  everyKey.every((k) => same(store.latestBySource(k), refStore.latestBySource(k))));
check("earliest observation matches (the backfill moved it back)", store.earliestObservation() === refStore.earliestObservation() && store.earliestObservation() === NOW - 1200 * DAY + 7);

const live = { gateway: "ok", upstreamBuyer: "ok" };
let tRef = performance.now();
const snapRef = statusSnapshot({ baseUrl: "https://example.test", nowMs: NOW, live, store: refStore });
tRef = performance.now() - tRef;
const snapNew = statusSnapshot({ baseUrl: "https://example.test", nowMs: NOW, live });
check("the snapshot /api/status serves is identical", same(snapNew, snapRef));
check("the /status page renders byte for byte the same", statusPage("https://example.test", {}, snapNew) === statusPage("https://example.test", {}, snapRef));
// The comparison has to cover what the reads decide, or equal pages prove little.
const pc = snapNew.components.find((c) => c.key === "paid-call");
check("the compared page carries a per-observer verdict (the live heartbeat failure)", pc.current.state === "outage" && pc.current.source === "heartbeat");
check("the compared page carries the whole count and span", snapNew.measurement.totalObservations === refCount() && snapNew.measurement.measuringSince === new Date(NOW - 1200 * DAY + 7).toISOString());
check("the compared page carries incidents and a full strip", snapNew.incidents.length > 0 && snapNew.components.find((c) => c.key === "api").daily.every((d) => d.observed > 0));

// ── Every history-independent read is an index search ───────────────────────
{
  const plans = store._statusReadPlansForTest();
  const names = Object.keys(plans);
  check("the plan check sees the store's own statements", ["newestOfComponent", "nextComponent", "newestOfSource", "nextSource", "earliest", "count"].every((k) => names.includes(k)), names.join(","));
  for (const [name, lines] of Object.entries(plans)) {
    const scan = lines.find((l) => /\bSCAN\b/.test(l) || /TEMP B-TREE/.test(l));
    check(`${name}: an index search, never a scan or a temporary sort`, !scan && lines.some((l) => /\bSEARCH\b/.test(l)), lines.join(" | "));
  }
}

// ── Fast on two million rows ────────────────────────────────────────────────
{
  const perSource = COMPONENTS.filter((c) => c.perSource).map((c) => c.key);
  const reads = () => {
    store.latestByComponent();
    for (const k of perSource) store.latestBySource(k);
    store.totalObservations();
    store.earliestObservation();
  };
  const ms = [];
  for (let i = 0; i < 7; i++) { const t = performance.now(); reads(); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  const median = ms[3];
  // Measured about 0.1 ms here; the whole-table reads took about 780 ms.
  check(`history-independent reads on ${refCount().toLocaleString()} rows stay under 25 ms (median ${median.toFixed(2)} ms)`, median < 25);
  const snapMs = [];
  for (let i = 0; i < 3; i++) { const t = performance.now(); statusSnapshot({ baseUrl: "https://example.test", nowMs: NOW, live }); snapMs.push(performance.now() - t); }
  snapMs.sort((a, b) => a - b);
  // Both builds run here, on the same table: the ratio holds on any machine.
  check(`the snapshot builds at least 5x faster than from the whole-table reads (${snapMs[1].toFixed(0)} ms vs ${tRef.toFixed(0)} ms)`, snapMs[1] * 5 < tRef);
}

// ── Row choice at the edges ─────────────────────────────────────────────────
{
  store.recordProbe({ ts: NOW - 10 * DAY, source: "backfill", component: "catalog", ok: false, detail: "old" });
  const cat = store.latestByComponent().find((r) => r.component === "catalog");
  check("a backfilled older row, recorded last, never becomes the newest", cat.ts === NOW - 60_000 + 21 && cat.detail !== "old");
  store.recordProbe({ ts: NOW - 5000, source: "cloudflare-cron", component: "tie-check", ok: true });
  store.recordProbe({ ts: NOW - 5000, source: "heartbeat", component: "tie-check", ok: false, detail: "second" });
  const tie = store.latestByComponent().find((r) => r.component === "tie-check");
  check("two observers in the same millisecond: the row recorded last is the newest", tie && tie.ok === 0 && tie.detail === "second");
  check("both observers still read on their own", store.latestBySource("tie-check").length === 2);
  check("the kept count follows every write", store.totalObservations() === refCount());
}

ref.close();
store._resetForTest();
console.log(`\n${fail ? "FAIL" : "OK"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
