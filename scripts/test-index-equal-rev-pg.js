// Two containers, one seller index: copies of an origin at the SAME revision
// with different content. The upsert accepts a row whose stored revision is
// at most the new one, and the pull skipped a row unless it was newer than
// the copy held, so the second of two equal-revision writes landed in the
// table and the first writer never read it: the two containers served
// different catalogs for that origin until its next crawl. Each row now
// carries the hash of its content, and (revision, hash) orders two copies the
// same way in the upsert and in the pull, so both containers and the table
// converge on one copy whichever wrote first.
//   STATE_DATABASE_URL=postgres://... node scripts/test-index-equal-rev-pg.js
import "./lib/own-stats.js"; // a stats store of this suite's own (see the file)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTestPg } from "./lib/test-pg.js";
requireTestPg({ label: "test-index-equal-rev-pg" });

process.env.X402_INDEX_CRAWL = "off";
const DIR = mkdtempSync(join(tmpdir(), "index-equal-rev-pg-"));
process.env.INDEX_CACHE_FILE = join(DIR, "x402-index-cache.json");
process.env.REMOVED_ORIGINS_FILE = join(DIR, "removed-origins.json");

const sdb = await import("../src/state-db.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`ok - ${m}`); } else { fail++; console.error(`FAIL - ${m}`); } };
const entry = (price, fetchedAt, extra = {}) => ({ manifest: { x402Version: 1, name: "seller" }, tools: [{ route: "/t", price }], fetchedAt, error: null, source: "crawl", history: [], paywall: null, discoveryPath: null, ...extra });
const COLLECTION = "x402-index";
const priceIn = (m, o) => m._cacheForTests().get(o)?.tools?.[0]?.price;
const rowPrice = async (o) => (await sdb.records.get(COLLECTION, o))?.tools?.[0]?.price;
const settle = async (...ms) => { for (let i = 0; i < 2; i++) for (const m of ms) await m.pullIndexChanges(); };

try {
  const A = await import("../src/x402-index.js?container=a");
  const B = await import("../src/x402-index.js?container=b");
  await A.warmStartIndexFromStateDb(); await B.warmStartIndexFromStateDb();
  await A.pullIndexChanges(); await B.pullIndexChanges(); // both watermarks set before any write

  // ---- equal revision, different content, either write order ---------------
  // Two copies of one revision, written A-then-B on one origin and B-then-A
  // on the other. Each pair is chosen so the FIRST writer's copy has the
  // higher hash: "last write wins" would keep the other copy on both. And,
  // where the database's default collation is a language one (en_US, as a
  // stock image is), so that collation orders the two hashes the other way:
  // the SQL must compare bytes, as JavaScript does, or the table and the
  // pull disagree.
  const R = 1_700_000_000_000;
  const P = "https://seller-p.example", Q = "https://seller-q.example";
  const { persistedHashOf } = A.__testSlices();
  const candidates = (o) => {
    const out = [];
    for (let i = 1; i < 2_000; i++) {
      const first = `$0.${10_000 + i}`, second = "$0.0100";
      const h1 = persistedHashOf(o, entry(first, R)), h2 = persistedHashOf(o, entry(second, R));
      if (h1 > h2) out.push([first, second, h1, h2]);
    }
    return out;
  };
  const firstWins = async (o) => {
    const all = candidates(o);
    const r = await sdb.stateQuery("SELECT i FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS u(a, b, i) WHERE a < b LIMIT 1", [all.map((c) => c[2]), all.map((c) => c[3])]);
    const pick = r.rows.length ? all[Number(r.rows[0].i) - 1] : all[0];
    if (!r.rows.length) console.log("# the database collates these hashes bytewise; the collation case is not exercised here");
    return pick.slice(0, 2);
  };
  const [pFirst, pSecond] = await firstWins(P), [qFirst, qSecond] = await firstWins(Q);
  A.__testSeedCache([[P, entry(pFirst, R)], [Q, entry(qSecond, R)]]);
  B.__testSeedCache([[P, entry(pSecond, R)], [Q, entry(qFirst, R)]]);
  // The upsert alone (no pull first). It deletes the rows of origins it is not
  // given, so each call names every origin that container has written.
  const held = (m, ...os) => os.map((o) => [o, m.__testSlices().persistedEntryOf(m._cacheForTests().get(o))]);
  await A.__testPersistToStateDb(held(A, P)); // A writes P first
  await B.__testPersistToStateDb(held(B, P, Q)); // B writes P second, Q first
  await A.__testPersistToStateDb(held(A, P, Q)); // A writes Q second
  await settle(A, B);
  for (const [o, first] of [[P, pFirst], [Q, qFirst]]) {
    const [a, b, row] = [priceIn(A, o), priceIn(B, o), await rowPrice(o)];
    ok(a === b && b === row, `${o === P ? "A then B" : "B then A"}: both containers and the table hold one copy (A ${a}, B ${b}, row ${row})`);
    ok(row === first, `${o === P ? "A then B" : "B then A"}: the copy whose hash orders last survives, not the last write (${row}, expected ${first})`);
  }

  // Each container's full save after converging writes nothing back.
  const reads0 = A.__testPullBodyReads() + B.__testPullBodyReads();
  await A.persistIndexCacheAsync(); await B.persistIndexCacheAsync();
  await settle(A, B);
  ok(A.__testPullBodyReads() + B.__testPullBodyReads() === reads0, `once converged, saves and pulls read no row again (read ${A.__testPullBodyReads() + B.__testPullBodyReads() - reads0})`);

  // ---- through the full save: each pulls first, then writes ----------------
  const S = "https://seller-s.example";
  A.__testSeedCache([[S, entry("$0.003", R + 5)]]);
  B.__testSeedCache([[S, entry("$0.004", R + 5)]]);
  await A.persistIndexCacheAsync(); await B.persistIndexCacheAsync();
  await settle(A, B);
  ok(priceIn(A, S) === priceIn(B, S) && priceIn(B, S) === await rowPrice(S), `full saves at one revision converge (A ${priceIn(A, S)}, B ${priceIn(B, S)}, row ${await rowPrice(S)})`);

  // ---- clock skew ----------------------------------------------------------
  // A's clock runs ahead: its crawl is stamped later than B's although B
  // crawled after it in real time. The later stamp wins everywhere, B's write
  // included, and neither container keeps its own copy.
  const K = "https://seller-k.example";
  A.__testSeedCache([[K, entry("$0.005", R + 60_000)]]);
  await A.persistIndexCacheAsync();
  B.__testSeedCache([[K, entry("$0.006", R + 1_000)]]);
  await B.__testPersistToStateDb(held(B, ...B._cacheForTests().keys())); // lands after A's, no pull first
  await settle(A, B);
  ok(priceIn(A, K) === "$0.005" && priceIn(B, K) === "$0.005" && await rowPrice(K) === "$0.005", `the later stamp wins on both containers and the table under skew (A ${priceIn(A, K)}, B ${priceIn(B, K)}, row ${await rowPrice(K)})`);
  // Skewed so the two stamps tie: same answer as an equal revision.
  const T = "https://seller-t.example";
  A.__testSeedCache([[T, entry("$0.007", R + 9)]]);
  B.__testSeedCache([[T, entry("$0.008", R + 9)]]);
  await B.persistIndexCacheAsync(); await A.persistIndexCacheAsync();
  await settle(A, B);
  ok(priceIn(A, T) === priceIn(B, T) && priceIn(B, T) === await rowPrice(T), `tied stamps from skewed clocks converge (A ${priceIn(A, T)}, B ${priceIn(B, T)}, row ${await rowPrice(T)})`);

  // ---- own rows are still not read back ------------------------------------
  const W = "https://seller-w.example";
  A.__testSeedCache([[W, entry("$0.009", R + 20)]]);
  await A.persistIndexCacheAsync();
  const r0 = A.__testPullBodyReads();
  await A.pullIndexChanges();
  ok(A.__testPullBodyReads() === r0, `a pull right after this container's persist reads none of its own rows (read ${A.__testPullBodyReads() - r0})`);
  const rB = B.__testPullBodyReads();
  await B.pullIndexChanges();
  ok(B.__testPullBodyReads() === rB + 1 && priceIn(B, W) === "$0.009", "the other container reads that row once");
  const rB2 = B.__testPullBodyReads();
  await B.persistIndexCacheAsync(); await B.pullIndexChanges();
  ok(B.__testPullBodyReads() === rB2, "a row folded by the pull is held at its stored hash, so it is not read again");

  // ---- a row written before rows carried a hash ------------------------------
  // It orders below any hashed copy at the same revision: a container holding
  // that revision neither reads it nor keeps it from being replaced.
  const L = "https://seller-l.example";
  await sdb.records.put(COLLECTION, L, entry("$0.010", R + 30));
  await settle(A, B);
  ok(priceIn(A, L) === "$0.010" && priceIn(B, L) === "$0.010", "a row with no hash is folded by both containers");
  const rL = A.__testPullBodyReads() + B.__testPullBodyReads();
  await A.persistIndexCacheAsync(); await B.persistIndexCacheAsync();
  await settle(A, B);
  ok(priceIn(A, L) === "$0.010" && priceIn(B, L) === "$0.010" && await rowPrice(L) === "$0.010" && A.__testPullBodyReads() + B.__testPullBodyReads() === rL, `saving both containers leaves the unhashed row one copy, read by neither again (reads ${A.__testPullBodyReads() + B.__testPullBodyReads() - rL})`);
  A.__testSeedCache([[L, entry("$0.013", R + 30)]]);
  await A.persistIndexCacheAsync(); await settle(A, B);
  ok(await rowPrice(L) === "$0.013" && priceIn(B, L) === "$0.013", `a hashed copy at the same revision replaces the unhashed row on the table and the other container (row ${await rowPrice(L)}, B ${priceIn(B, L)})`);
  // A key the newer row leaves out is not kept from the held copy, so the
  // folded copy is the row's content and hashes as the row does.
  const D = "https://seller-d.example";
  B.__testSeedCache([[D, entry("$0.011", R + 40, { redirectedTo: "https://seller-d2.example" })]]);
  await B.persistIndexCacheAsync();
  await A.pullIndexChanges();
  A.__testSeedCache([[D, entry("$0.012", R + 41)]]);
  await A.persistIndexCacheAsync();
  await B.pullIndexChanges();
  const rD = B.__testPullBodyReads();
  await B.persistIndexCacheAsync(); await settle(A, B);
  ok(!("redirectedTo" in B._cacheForTests().get(D)) && !("redirectedTo" in (await sdb.records.get(COLLECTION, D))) && B.__testPullBodyReads() === rD, "a key the newer row leaves out is dropped from the held copy, and the copies stay one");
  ok(!("contentHash" in A._cacheForTests().get(Q)) && !("contentHash" in B._cacheForTests().get(P)) && !("contentHash" in B._cacheForTests().get(W)), "the row's hash is not carried into an entry the pull folds");
  const C = await import("../src/x402-index.js?container=c");
  await C.warmStartIndexFromStateDb();
  ok(C._cacheForTests().has(W) && [...C._cacheForTests().values()].every((e) => !("contentHash" in e)), "nor into an entry a warm start folds");
  const rC = C.__testPullBodyReads();
  await C.persistIndexCacheAsync(); await C.pullIndexChanges();
  ok(C.__testPullBodyReads() === rC && priceIn(C, P) === pFirst, `a warm-started container holds every row at its stored hash: its save and pull read nothing (read ${C.__testPullBodyReads() - rC}; P ${priceIn(C, P)}, expected ${pFirst})`);
} finally {
  await sdb.__dropStateSchema();
  await sdb.closeStateDb();
  rmSync(DIR, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
