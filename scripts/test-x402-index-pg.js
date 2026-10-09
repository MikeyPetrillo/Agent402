// The x402 index crawl cache against a REAL Postgres: the NDJSON twin on the
// volume is imported once (a second boot reads the rows, not the file), a
// crawl cycle's persist upserts the rows whose entry changed and deletes the
// rows of origins the cache no longer holds, one row per origin however often
// it is written, and a fresh instance warm-starts from the rows in pages with
// indexWarmStartInProgress() raised until the last page. Requires
// STATE_DATABASE_URL (CI fails without it).
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-x402-index-pg" });

process.env.X402_INDEX_CRAWL = "off";
const DIR = mkdtempSync(join(tmpdir(), "x402-index-pg-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");
const ndFile = join(DIR, "x402-index-cache.ndjson");

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const A = "https://seller-a.example", B = "https://seller-b.example", C = "https://seller-c.example";
const entry = (route, extra = {}) => ({ manifest: { x402Version: 1, name: route }, tools: [{ route, price: "$0.001" }], fetchedAt: 1700000000000, error: null, source: "crawl", history: [], paywall: null, discoveryPath: null, ...extra });
const snapArgs = { baseUrl: "https://agent402.tools", catalog: {}, prices: {}, network: "base", toolCount: 0, walletName: "test" };
const COLLECTION = "x402-index";
const ids = async () => (await sdb.records.list(COLLECTION)).map((r) => r.id).sort();

try {
  // The volume's file: header line, then one [origin, entry] per line.
  writeFileSync(ndFile, JSON.stringify({ savedAt: 1700000000000, format: "ndjson-v1", origins: 2 }) + "\n" + JSON.stringify([A, entry("/a")]) + "\n" + JSON.stringify([B, entry("/b")]) + "\n");

  // ---- boot 1: the file is imported once and the rows warm the cache ----------
  const m1 = await import("../src/x402-index.js");
  const n1 = await m1.warmStartIndexFromStateDb();
  ok(n1 === 2, `the first warm start imports the file and folds its 2 origins (got ${n1})`);
  ok((await ids()).join() === [A, B].join(), "one row per origin in the records table");
  const mark = await sdb.imports.done("x402-index-cache.ndjson");
  ok(mark && mark.source === ndFile, `the import is marked under the file's basename (${JSON.stringify(mark?.source)})`);
  const sellers1 = m1.indexSnapshot(snapArgs).sellers.map((s) => s.origin);
  ok(sellers1.includes(A) && sellers1.includes(B), "the warm-started origins are served");
  ok(m1.seedList().includes(A) && m1.seedList().includes(B), "warm-started origins re-enter the crawl seeds (no orphans)");

  // ---- boot 2: the rows are read, the file is NOT re-imported ------------------
  // A row changed in the database and a row deleted from it: a second boot
  // must see the change and not resurrect the deletion from the file.
  await sdb.records.put(COLLECTION, A, entry("/a-changed"));
  await sdb.records.del(COLLECTION, B);
  const m2 = await import("../src/x402-index.js?boot=2");
  const n2 = await m2.warmStartIndexFromStateDb();
  ok(n2 === 1, `a second boot folds the 1 row the database holds, not the file's 2 (got ${n2})`);
  ok((await ids()).join() === A, "the deleted origin is not re-imported from the file");
  const a2 = m2.sellerDetail ? m2.indexSnapshot(snapArgs).sellers.find((s) => s.origin === A) : null;
  ok(!m2.indexSnapshot(snapArgs).sellers.some((s) => s.origin === B), "the deleted origin is not served by the second boot");
  ok((await sdb.records.get(COLLECTION, A))?.manifest?.name === "/a-changed", "the changed row is what the database holds (the file's copy was not restored)");
  void a2;

  // ---- a crawl cycle's persist: upsert changed, delete no longer held ----------
  // In instance 1 the cache gains C, and B fails with nothing to show (an
  // errored entry without a catalogue is not persisted), so the persist must
  // write A (its stored hash is unknown after a warm start) and C, and delete B.
  await sdb.records.put(COLLECTION, B, entry("/b")); // back in the database, as if another cycle wrote it
  const m1hashes = await m1.warmStartIndexFromStateDb(); // instance 1 now holds B's row in its held set again
  void m1hashes;
  m1.__testSeedCache([[C, entry("/c")], [B, { error: "timeout", tools: [], manifest: null, fetchedAt: 1700000000000, history: [] }]]);
  const stored = await m1.persistIndexCacheAsync(process.env.INDEX_CACHE_FILE);
  ok(stored === true, "persist resolves true once the rows are stored");
  ok((await ids()).join() === [A, C].join(), `after the persist the table holds exactly the origins the cache holds with a catalogue (${(await ids()).join(", ")})`);
  ok((await sdb.records.get(COLLECTION, C))?.tools?.[0]?.route === "/c", "the new origin's entry is the slim entry");
  const again = await m1.persistIndexCacheAsync(process.env.INDEX_CACHE_FILE);
  ok(again === true && (await sdb.records.count(COLLECTION)) === 2, "persisting again keeps one row per origin (upsert, never a duplicate)");
  ok(existsSync(ndFile) && readFileSync(ndFile, "utf8").includes(C), "the NDJSON twin is written through while its directory exists (a rollback warm-starts from it)");

  // ---- boot 3: a fresh instance warm-starts from the rows, in pages ------------
  process.env.INDEX_WARM_START_BATCH = "1"; // one row per page, so the in-progress flag is observable across turns
  const m3 = await import("../src/x402-index.js?boot=3");
  let sawTrue = false, done = false;
  const p = m3.warmStartIndexFromStateDb().then((n) => { done = true; return n; });
  (function sample() { if (done) return; if (m3.indexWarmStartInProgress()) sawTrue = true; setImmediate(sample); })();
  const n3 = await p;
  ok(n3 === 2, `a fresh instance warm-starts the 2 rows (got ${n3})`);
  ok(sawTrue === true, "indexWarmStartInProgress() is true while the pages load");
  ok(m3.indexWarmStartInProgress() === false, "indexWarmStartInProgress() is false after the last page");
  const s3 = m3.indexSnapshot(snapArgs).sellers.map((s) => s.origin);
  ok(s3.includes(A) && s3.includes(C) && !s3.includes(B), "the fresh instance serves A and C and not the deleted B");
  ok((await sdb.stateStoresReady()) === "ready", "no store is left pending");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
