// A first boot with the database on imports every store's file at once. With
// large files on a pool of 6, those imports used to take every pooled
// connection, and the reads queued behind them (other stores' loads, the
// first buyer calls) timed out waiting for a connection ("timeout exceeded
// when trying to connect"). One-time imports now run through a small slot
// limiter (STATE_DB_IMPORT_CONCURRENCY, default 2), so the rest of the pool
// stays free for serving.
//
// The boot is modelled behind a relay that throttles each connection's
// upload, so a large import holds its connection for a while and a small
// read barely waits. 20 documents and 4 table imports start together while a
// serving read runs every 50 ms. Expected: no connect timeouts anywhere,
// every document loads its file's body, and the serving reads stay fast.
// Requires STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
import { startPgRelay } from "./lib/pg-relay.js";

const { url } = requireTestPg({ label: "test-state-db-import-congestion-pg" });
const relay = await startPgRelay(url, { bytesPerSec: 1_000_000 });
const DIR = mkdtempSync(join(tmpdir(), "import-congestion-"));
process.env.STATE_DATABASE_URL = relay.url;
process.env.STATE_DB_POOL_MAX = "6";
process.env.STATE_DB_CONNECT_TIMEOUT_MS = "1500";
process.env.STATE_STORE_RETRY_MS = "200";
const sdb = await import("../src/state-db.js");
const { createJsonDocument } = await import("../src/json-document.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const CONNECT_TIMEOUT = /timeout exceeded when trying to connect/i;

const DOCS = 20, TABLES = 4, BYTES = 400_000;
const pad = (i) => "x".repeat(BYTES - 40) + String(i);
try {
  await sdb.stateQuery("SELECT 1"); // the schema is in place
  const lines = [];
  const logLine = (m) => lines.push(String(m));
  const docs = [];
  for (let i = 0; i < DOCS; i++) {
    const file = join(DIR, `store-${i}.json`);
    writeFileSync(file, JSON.stringify({ i, pad: pad(i) }));
    docs.push(createJsonDocument({ file, log: logLine, failLog: logLine, loadRetryDelaysMs: [] }));
  }

  // The serving reads: one every 50 ms for the whole boot.
  const servingMs = [];
  const servingErrors = [];
  let serving = true;
  const server = (async () => {
    while (serving) {
      const t0 = Date.now();
      try { await sdb.stateQuery("SELECT 1"); servingMs.push(Date.now() - t0); }
      catch (e) { servingErrors.push(String(e?.message || e)); }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  const t0 = Date.now();
  const tableImports = [];
  for (let i = 0; i < TABLES; i++) {
    tableImports.push(sdb.importOnce(`table-import-${i}`, {
      source: `table-${i}`,
      run: async () => {
        for (let k = 0; k < 2; k++) await sdb.records.put(`congestion-${i}`, `r${k}`, { pad: pad(i * 10 + k) });
        return { bytes: 2 * BYTES };
      },
    }).then(() => null, (e) => String(e?.message || e)));
  }
  const bodies = await Promise.all(docs.map((d) => d.load(null)));
  const tableErrors = (await Promise.all(tableImports)).filter(Boolean);
  // A failed import is retried in the background; give it time to land.
  const end = Date.now() + 20_000;
  while (docs.some((d) => d.loadState !== "ok") && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  serving = false;
  await server;
  const elapsed = Date.now() - t0;

  const timeouts = [...lines, ...servingErrors, ...tableErrors].filter((l) => CONNECT_TIMEOUT.test(l));
  ok(timeouts.length === 0, `no connect timeouts during the boot (${timeouts.length}: ${JSON.stringify(timeouts[0] || "")})`);
  ok(docs.every((d) => d.loadState === "ok"), `every document loaded (${docs.filter((d) => d.loadState !== "ok").length} not)`);
  ok(bodies.every((b, i) => b?.i === i), `every first load returned its file's body (${bodies.filter((b, i) => b?.i !== i).length} did not)`);
  ok(tableErrors.length === 0, `every table import landed (${JSON.stringify(tableErrors[0] || "")})`);
  for (let i = 0; i < TABLES; i++) ok((await sdb.imports.done(`table-import-${i}`)) !== null, `table import ${i} is marked`);
  const sorted = [...servingMs].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  ok(servingErrors.length === 0, `no serving read failed (${servingErrors.length}: ${JSON.stringify(servingErrors[0] || "")})`);
  ok(servingMs.length >= 10 && max < 1000, `serving reads were not starved during the imports (${servingMs.length} reads, p95 ${p95} ms, max ${max} ms, boot ${elapsed} ms)`);
} finally {
  await sdb.__dropStateSchema().catch(() => {});
  await sdb.closeStateDb();
  await relay.close();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`\ntest-state-db-import-congestion-pg: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
