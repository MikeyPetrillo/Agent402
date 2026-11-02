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
  const has = (list, origin) => list.some((o) => o === origin); // exact origin match, never a substring
  ok(has(sellers1, A) && has(sellers1, B), "the warm-started origins are served");
  ok(has(m1.seedList(), A) && has(m1.seedList(), B), "warm-started origins re-enter the crawl seeds (no orphans)");

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
  const ndOrigins = existsSync(ndFile) ? readFileSync(ndFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).map((r) => (Array.isArray(r) ? r[0] : r?.origin)) : [];
  ok(has(ndOrigins, C), "the NDJSON twin is written through while its directory exists (a rollback warm-starts from it)");

  // ---- a seller row of many megabytes ------------------------------------------
  // Sent inside a jsonb[] literal, the driver escapes every quote of the body in
  // one synchronous pass (over a second for an 82 MB row); a large row travels
  // alone as a scalar parameter, and the stored row is the same.
  {
    const BIG = "https://seller-big.example";
    const tools = Array.from({ length: 120_000 }, (_, i) => ({ route: `/api/r${i}`, slug: `r${i}`, name: `Route "${i}"`, description: "Quotes \"inside\" and a back\\slash.", price: "$0.001", networks: ["eip155:8453"] }));
    m1.__testSeedCache([[BIG, entry("/big", { tools, fetchedAt: 1700000000001 })]]);
    // The bound is relative to this machine: twice the time one JSON.stringify
    // of the row takes here (the old array path was over ten times that).
    const t0 = performance.now();
    const mb = JSON.stringify(m1._cacheForTests().get(BIG)).length / 1_048_576;
    const bound = Math.max(Number(process.env.LOOP_SLICE_BOUND_MS || 120), 2 * (performance.now() - t0));
    let last = performance.now(), worst = 0;
    const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 2); last = now; }, 2);
    const storedBig = await m1.persistIndexCacheAsync(process.env.INDEX_CACHE_FILE);
    worst = Math.max(worst, performance.now() - last - 2); // the gap still open when persist settles
    clearInterval(iv);
    const row = await sdb.records.get(COLLECTION, BIG);
    ok(storedBig === true && row?.tools?.length === 120_000 && row.tools[17].name === 'Route "17"' && row.tools[0].description === "Quotes \"inside\" and a back\\slash.", "a multi-megabyte row is stored whole, quotes and backslashes intact");
    ok(worst < bound, `persisting a ${mb.toFixed(0)} MB row never holds the loop past ${Math.round(bound)} ms (longest ${Math.round(worst)} ms)`);
    // Newer wins on the single-row path as on the batch path: an older copy in
    // memory never overwrites the stored row, a newer one replaces it.
    // Both copies are past the single-row size, so each takes that path. The
    // older one goes straight to the upsert (no pull first), as a second
    // container's write does when it lands between this one's pull and write.
    const older = tools.map((t) => ({ ...t, price: "$0.009" }));
    await m1.__testPersistToStateDb([[BIG, entry("/big", { tools: older, fetchedAt: 1700000000000 })]]);
    ok((await sdb.records.get(COLLECTION, BIG))?.tools?.[5]?.price === "$0.001", "an older copy of a large row does not overwrite the stored row (the SQL newer-wins rule)");
    const newer = tools.map((t) => ({ ...t, price: "$0.002" }));
    m1.__testSeedCache([[BIG, entry("/big", { tools: newer, fetchedAt: 1700000000002 })]]);
    await m1.persistIndexCacheAsync(process.env.INDEX_CACHE_FILE);
    ok((await sdb.records.get(COLLECTION, BIG))?.tools?.[5]?.price === "$0.002", "a newer copy of a large row replaces the stored row");
    // Out of the table and the cache again, so the boots below see A and C only.
    await sdb.records.del(COLLECTION, BIG);
    m1._cacheForTests().delete(BIG);
    ok((await ids()).join() === [A, C].join(), "the large row is removed again before the next boot");
  }

  // ---- the pull: own rows are not read back, another container's are ----------
  // After a persist the pull used to read every row this container had just
  // written and parse it in the driver in one call (over 300 ms for a 35 MB
  // seller). It now reads a row whole only when it is newer than what this
  // container holds, as UTF-8 byte ranges parsed across turns.
  {
    const HUGE = "https://seller-huge.example";
    // Mostly three-byte characters, so byte-range boundaries fall inside them.
    const mk = (price, fetchedAt) => entry("/huge", { fetchedAt, tools: Array.from({ length: 100_000 }, (_, i) => ({ route: `/api/h${i}`, slug: `h${i}`, name: `名前 ${i} 😀`, description: `${"説明".repeat(40)} "${i}" \\`, price, networks: ["eip155:8453"] })) });
    const gap = async (fn) => {
      let last = performance.now(), worst = 0;
      const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 2); last = now; }, 2);
      try { const out = await fn(); worst = Math.max(worst, performance.now() - last - 2); return { out, worst: Math.round(worst) }; } finally { clearInterval(iv); }
    };
    const stampOf = async (id) => (await sdb.stateQuery(`SELECT updated_at::text AS t FROM ${process.env.STATE_DB_SCHEMA}.records WHERE collection = $1 AND id = $2`, [COLLECTION, id])).rows[0]?.t ?? null;
    m1.__testSeedCache([[HUGE, mk("$0.001", 1700000000100)]]);
    await m1.persistIndexCacheAsync(process.env.INDEX_CACHE_FILE);
    ok((await sdb.records.get(COLLECTION, HUGE))?.tools?.length === 100_000, "the large seller's row is stored");
    const reads0 = m1.__testPullBodyReads();
    const { worst: wOwn } = await gap(() => m1.pullIndexChanges());
    ok(m1.__testPullBodyReads() === reads0, `a pull right after this container's persist reads none of the rows it wrote (read ${m1.__testPullBodyReads() - reads0})`);

    // Another container writes a newer copy: this one reads it, whole and once.
    await sdb.records.put(COLLECTION, HUGE, mk("$0.002", 1700000000200));
    const stored = await sdb.records.get(COLLECTION, HUGE); // the driver's one-call parse
    const t0 = performance.now();
    JSON.parse(JSON.stringify(stored));
    const oneParse = performance.now() - t0;
    const heldBefore = m1._cacheForTests().get(HUGE);
    const reads1 = m1.__testPullBodyReads();
    const { out: folded, worst: wForeign } = await gap(() => m1.pullIndexChanges());
    ok(folded === 1 && m1.__testPullBodyReads() === reads1 + 1, `another container's newer row is read and folded once (folded ${folded}, read ${m1.__testPullBodyReads() - reads1})`);
    const after = m1._cacheForTests().get(HUGE);
    ok(JSON.stringify(after) === JSON.stringify({ ...heldBefore, ...stored }) && after.tools[5].price === "$0.002", "the folded entry is byte-identical to the held entry merged with the row as the driver parses it");
    const bound = Math.max(60, Math.min(Number(process.env.LOOP_SLICE_BOUND_MS || 120), oneParse));
    ok(Math.max(wOwn, wForeign) < bound, `neither pull holds the loop past ${Math.round(bound)} ms (one-call parse ${Math.round(oneParse)} ms; own ${wOwn} ms, foreign ${wForeign} ms)`);
    // Held as stored: this container's next save leaves the row alone.
    const stamp = await stampOf(HUGE);
    await m1.persistIndexCacheAsync(process.env.INDEX_CACHE_FILE);
    ok(stamp && (await stampOf(HUGE)) === stamp, "the pulled row is held as stored, so the next save does not write it back");

    // A removal made on the other container reaches this one on its pull.
    const rm = m2.removeOrigin(HUGE, { note: "test" });
    ok(rm?.removed === true, "the other container removes the origin");
    for (let i = 0; i < 40 && m1._cacheForTests().has(HUGE); i++) { await new Promise((r) => setTimeout(r, 50)); await m1.pullIndexChanges(); }
    ok(!m1._cacheForTests().has(HUGE) && m1.isRemovedOrigin(HUGE), "the pull purges an origin the other container removed");
    await sdb.records.del(COLLECTION, HUGE);
    m2._cacheForTests().delete(HUGE);
    ok((await ids()).join() === [A, C].join(), "the large seller's row is removed again before the next boot");
  }

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
  ok(has(s3, A) && has(s3, C) && !has(s3, B), "the fresh instance serves A and C and not the deleted B");
  ok((await sdb.stateStoresReady()) === "ready", "no store is left pending");
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
