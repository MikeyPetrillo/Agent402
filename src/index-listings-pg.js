// The tool directory's rows in the state database, in place of an in-memory
// copy on every container.
//
// Without it, each container flattens every crawled seller's tool rows into a
// directory array (one object per row, about 200,000 of them) and keeps a
// lowercased search text beside each one, so /marketplace/tools and
// /api/index/tools can filter and page in memory. That copy is rebuilt every
// few minutes while the crawl replaces entries, and every container holds its
// own. INDEX_LISTINGS_STORE=pg keeps the rows in one table instead: each
// container writes only the origins that changed (compared by a content hash,
// so the second container's identical write is a no-op), and a directory page
// is a filtered, ordered, paged query.
//
// The answer is the in-memory directory's, row for row:
//   - a row is the same projection (x402-index.js flatRowOf), computed at read
//     time from the stored crawled tool, so per-request fields stay current;
//   - the order is the same interleave: described rows first, then a round
//     robin over sellers in collated name order, each seller's rows in
//     collated route order. Stored as (described, rank within the seller's
//     pass, the seller's place in the collated order), so a page is an ordered
//     scan instead of a sort of the whole directory;
//   - the filters (source, category, network, search terms) are the same
//     tests, as SQL: substring search over the same lowercased text, served by
//     a trigram index where the database has pg_trgm.
// Off (the default), nothing here runs and the directory is built in memory
// exactly as before.

import { createHash } from "node:crypto";
import { stateDbEnabled, stateDbSchema, stateQuery, withSchemaLock, withStateTx } from "./state-db.js";

/** On only when asked for and a state database is configured. */
export function listingsStoreEnabled(env = process.env) {
  return String(env.INDEX_LISTINGS_STORE || "").trim().toLowerCase() === "pg" && stateDbEnabled(env);
}

const OURS_ORIGIN = "agent402:ours";
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
// Directory counts per filter, kept briefly: every page of one search reads
// the same counts, and the in-memory directory is itself up to minutes stale.
const COUNTS_TTL_MS = 30_000;
const COUNTS_MAX = 200;

/**
 * @param {object} o
 * @param {(origin: string) => null | { sellerKey: string, sellerName: string, rows: Array<{ method: string, route: string, t: object, flat: object }> }} o.rowsForOrigin
 *   the origin's directory rows now (null when it is not listed or not cached)
 * @param {(origin: string, t: object, sellerName: string) => object} o.projectRow  flatRowOf
 * @param {(a: string, b: string) => number} o.collate  the in-memory directory's collator
 * @param {(q: string) => string[]} o.terms  the in-memory directory's query terms
 * @param {(row: object) => string} o.hayOf  the in-memory directory's search text
 */
export function createListingsStore({ rowsForOrigin, keyForOrigin = null, projectRow, collate, terms, hayOf, log = console.warn, sliceMs = 8 } = {}) {
  const S = () => stateDbSchema();
  let ready = null;
  let trigram = false;
  const dirty = new Set();
  let flushing = null;
  let sellerKeys = null; // sorted [{ key, ord }] loaded once, kept in step with the table
  const counts = new Map(); // filter key -> { at, matched, described }
  let totalsMemo = null; // { at, total, ours }
  let oursRef = null, oursHash = null;
  let seeding = null;
  const stats = { writes: 0, skipped: 0, deletes: 0, rankUpdates: 0, queries: 0, renumbers: 0 };

  async function ensure() {
    if (ready) return ready;
    ready = (async () => {
      const s = S();
      // The extension is tried on its own statement: a failure inside the
      // schema transaction would abort every statement after it.
      try { await stateQuery("CREATE EXTENSION IF NOT EXISTS pg_trgm"); trigram = true; }
      catch { trigram = (await stateQuery("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'").catch(() => ({ rows: [] }))).rows.length > 0; }
      await withSchemaLock(async (c) => {
        // Rows are narrow (what a filter, a count and the order read); each
        // row's body is in its own table, read only for the page's rows, so a
        // count over a broad search never reads the bodies.
        await c.query(`
          CREATE TABLE IF NOT EXISTS ${s}.index_listing_origins (origin TEXT PRIMARY KEY, seq BIGSERIAL, hash TEXT NOT NULL, seller_key TEXT,
            n_rows INTEGER NOT NULL DEFAULT 0, n_described INTEGER NOT NULL DEFAULT 0, n_ours INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS ${s}.index_listing_bodies (origin TEXT NOT NULL, pos INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (origin, pos));
          CREATE TABLE IF NOT EXISTS ${s}.index_listing_sellers (seller_key TEXT PRIMARY KEY, ord DOUBLE PRECISION NOT NULL);
          CREATE TABLE IF NOT EXISTS ${s}.index_listings (
            origin TEXT NOT NULL, method TEXT NOT NULL, route TEXT NOT NULL, pos INTEGER NOT NULL,
            ours BOOLEAN NOT NULL, seller_key TEXT NOT NULL, described BOOLEAN NOT NULL,
            category TEXT NOT NULL, category_served TEXT NOT NULL, networks TEXT NOT NULL, hay TEXT NOT NULL,
            rank INTEGER NOT NULL DEFAULT 0, seller_ord DOUBLE PRECISION NOT NULL DEFAULT 0,
            PRIMARY KEY (origin, pos));
          CREATE INDEX IF NOT EXISTS index_listings_order_idx ON ${s}.index_listings (described DESC, rank, seller_ord);
          CREATE INDEX IF NOT EXISTS index_listings_seller_idx ON ${s}.index_listings (seller_key);
          CREATE INDEX IF NOT EXISTS index_listings_category_idx ON ${s}.index_listings (category);`);
        if (trigram) {
          // Inside the schema lock like every other DDL; the extension lives in
          // the database, its operator class is schema-qualified by search path.
          try { await c.query(`CREATE INDEX IF NOT EXISTS index_listings_hay_trgm ON ${s}.index_listings USING gin (hay gin_trgm_ops)`); }
          catch (e) { trigram = false; log(`[listings] trigram index not created (${String(e?.message || e).slice(0, 80)}); search reads the table`); }
        }
      });
      const r = await stateQuery(`SELECT seller_key, ord FROM ${s}.index_listing_sellers`);
      sellerKeys = r.rows.map((x) => ({ key: x.seller_key, ord: Number(x.ord) })).sort((a, b) => collate(a.key, b.key));
      if (!trigram) log("[listings] pg_trgm is not available: directory search scans the table");
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  // ------------------------------------------------------------ seller order
  /** The ord for a seller key, inserting it between its collated neighbors.
   *  Ords are spaced doubles, so a new seller never renumbers the others
   *  until a gap closes (then every seller is renumbered once). */
  async function ordFor(key, client) {
    let lo = 0, hi = sellerKeys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const c = collate(sellerKeys[mid].key, key); if (c < 0) lo = mid + 1; else hi = mid; }
    if (lo < sellerKeys.length && sellerKeys[lo].key === key) return sellerKeys[lo].ord;
    const prev = lo > 0 ? sellerKeys[lo - 1].ord : 0;
    const next = lo < sellerKeys.length ? sellerKeys[lo].ord : prev + 2 ** 20;
    let ord = (prev + next) / 2;
    sellerKeys.splice(lo, 0, { key, ord });
    if (!(ord > prev && ord < next)) {
      // The gap closed: renumber every seller, rows included, a few hundred
      // sellers per statement so no one statement walks the whole table.
      sellerKeys.forEach((k, i) => { k.ord = (i + 1) * 2 ** 20; });
      ord = sellerKeys[lo].ord;
      await writeSellerOrds(sellerKeys, client, { rows: true });
      stats.renumbers++;
      return ord;
    }
    await client.query(`INSERT INTO ${S()}.index_listing_sellers (seller_key, ord) VALUES ($1, $2) ON CONFLICT (seller_key) DO UPDATE SET ord = EXCLUDED.ord`, [key, ord]);
    return ord;
  }

  async function writeSellerOrds(list, client, { rows = false } = {}) {
    const s = S();
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const keys = chunk.map((k) => k.key), ords = chunk.map((k) => k.ord);
      await client.query(`INSERT INTO ${s}.index_listing_sellers (seller_key, ord) SELECT * FROM unnest($1::text[], $2::float8[])
        ON CONFLICT (seller_key) DO UPDATE SET ord = EXCLUDED.ord`, [keys, ords]);
      if (rows) await client.query(`UPDATE ${s}.index_listings l SET seller_ord = u.ord FROM unnest($1::text[], $2::float8[]) AS u(seller_key, ord)
        WHERE l.seller_key = u.seller_key AND l.seller_ord IS DISTINCT FROM u.ord`, [keys, ords]);
    }
  }
  /** Place every seller key known now in one pass, spaced, before any row is
   *  written: keys then arrive in cache order, not collated order, and placing
   *  them one by one between neighbors would close the gaps and renumber the
   *  whole table again and again. A key already placed keeps its ord. */
  async function seedSellers(keys) {
    await ensure();
    const known = new Set(sellerKeys.map((k) => k.key));
    const fresh = [...new Set(keys.filter((k) => k && !known.has(k)))];
    if (!fresh.length) return 0;
    if (!sellerKeys.length || fresh.length > 50) {
      // Many new keys at once (the first backfill, a warm start into a table
      // that holds only a few): place them all in one renumber, rows included.
      sellerKeys = [...sellerKeys.map((k) => k.key), ...fresh].sort(collate).map((key, i) => ({ key, ord: (i + 1) * 2 ** 20 }));
      await withStateTx((c) => writeSellerOrds(sellerKeys, c, { rows: true }));
      stats.renumbers++;
      return fresh.length;
    }
    await withStateTx(async (c) => { for (const k of fresh.sort(collate)) await ordFor(k, c); });
    return fresh.length;
  }

  /** Rank every row of one seller group, per described pass, in the in-memory
   *  directory's order: collated route, ties in insertion order (ours first,
   *  then origins in cache order, then each origin's tool order). */
  async function rerank(key, client) {
    const s = S();
    const r = await client.query(`SELECT l.origin, l.route, l.pos, l.ours, l.described, COALESCE(o.seq, 0) AS seq
      FROM ${s}.index_listings l LEFT JOIN ${s}.index_listing_origins o ON o.origin = l.origin WHERE l.seller_key = $1`, [key]);
    const rows = r.rows.map((x) => ({ ...x, seq: Number(x.seq) }));
    const ins = (a, b) => (a.ours !== b.ours ? (a.ours ? -1 : 1) : a.seq - b.seq || a.pos - b.pos);
    const origins = [], positions = [], ranks = [];
    for (const d of [true, false]) {
      const pass = rows.filter((x) => x.described === d).sort(ins).sort((a, b) => collate(String(a.route), String(b.route)));
      pass.forEach((x, i) => { origins.push(x.origin); positions.push(x.pos); ranks.push(i); });
    }
    if (!origins.length) return;
    await client.query(`UPDATE ${s}.index_listings l SET rank = u.rank FROM unnest($1::text[], $2::int[], $3::int[]) AS u(origin, pos, rank)
      WHERE l.origin = u.origin AND l.pos = u.pos AND l.rank IS DISTINCT FROM u.rank`, [origins, positions, ranks]);
    stats.rankUpdates++;
  }

  // ------------------------------------------------------------------ writes
  /** Write one origin's rows (or remove them) as one transaction; a write
   *  whose content hash matches the stored one is skipped. */
  async function writeOrigin(origin, listed) {
    const s = S();
    const rows = listed?.rows || [];
    const hash = listed ? sha(JSON.stringify([listed.sellerKey, listed.sellerName, rows.map((x) => [x.method, x.route, x.t, x.ours ? x.flat : null])])) : null;
    await withStateTx(async (c) => {
      const prev = await c.query(`SELECT hash, seller_key FROM ${s}.index_listing_origins WHERE origin = $1 FOR UPDATE`, [origin]);
      const was = prev.rows[0] || null;
      if (!listed) {
        if (!was) { stats.skipped++; return; }
        await c.query(`DELETE FROM ${s}.index_listings WHERE origin = $1`, [origin]);
        await c.query(`DELETE FROM ${s}.index_listing_bodies WHERE origin = $1`, [origin]);
        await c.query(`DELETE FROM ${s}.index_listing_origins WHERE origin = $1`, [origin]);
        stats.deletes++;
        if (was.seller_key) await rerank(was.seller_key, c);
        return;
      }
      if (was && was.hash === hash) { stats.skipped++; return; }
      const ord = rows.length ? await ordFor(listed.sellerKey, c) : 0;
      const nDescribed = rows.filter((x) => x.flat.described).length, nOurs = rows.filter((x) => x.ours).length;
      await c.query(`INSERT INTO ${s}.index_listing_origins (origin, hash, seller_key, n_rows, n_described, n_ours) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (origin) DO UPDATE SET hash = EXCLUDED.hash, seller_key = EXCLUDED.seller_key, n_rows = EXCLUDED.n_rows, n_described = EXCLUDED.n_described, n_ours = EXCLUDED.n_ours`,
        [origin, hash, rows.length ? listed.sellerKey : null, rows.length, nDescribed, nOurs]);
      await c.query(`DELETE FROM ${s}.index_listings WHERE origin = $1`, [origin]);
      await c.query(`DELETE FROM ${s}.index_listing_bodies WHERE origin = $1`, [origin]);
      if (rows.length) {
        const cols = { method: [], route: [], pos: [], ours: [], described: [], category: [], categoryServed: [], networks: [], hay: [], body: [] };
        rows.forEach((x, i) => {
          cols.method.push(x.method); cols.route.push(x.route); cols.pos.push(i); cols.ours.push(!!x.ours);
          cols.described.push(!!x.flat.described); cols.category.push(String(x.flat.category || "").toLowerCase());
          cols.categoryServed.push(String(x.flat.category || "other"));
          cols.networks.push((x.flat.networks || []).map((n) => String(n).toLowerCase()).join("\n"));
          cols.hay.push(hayOf(x.flat));
          cols.body.push(JSON.stringify(x.ours ? { row: x.flat } : { t: x.t, sellerName: listed.sellerName }));
        });
        await c.query(`INSERT INTO ${s}.index_listings (origin, method, route, pos, ours, seller_key, described, category, category_served, networks, hay, seller_ord)
          SELECT $1, u.method, u.route, u.pos, u.ours, $2, u.described, u.category, u.category_served, u.networks, u.hay, $3
          FROM unnest($4::text[], $5::text[], $6::int[], $7::bool[], $8::bool[], $9::text[], $10::text[], $11::text[], $12::text[])
            AS u(method, route, pos, ours, described, category, category_served, networks, hay)`,
          [origin, listed.sellerKey, ord, cols.method, cols.route, cols.pos, cols.ours, cols.described, cols.category, cols.categoryServed, cols.networks, cols.hay]);
        await c.query(`INSERT INTO ${s}.index_listing_bodies (origin, pos, body) SELECT $1, u.pos, u.body FROM unnest($2::int[], $3::text[]) AS u(pos, body)`,
          [origin, cols.pos, cols.body]);
      }
      stats.writes++;
      if (rows.length) await rerank(listed.sellerKey, c);
      if (was?.seller_key && was.seller_key !== listed.sellerKey) await rerank(was.seller_key, c);
    });
    counts.clear(); totalsMemo = null;
  }

  /** Mark an origin changed (the cache set or delete hook). */
  function markDirty(origin) { dirty.add(origin); }

  /** Write every marked origin, one at a time, yielding between them. */
  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await ensure();
      if (seeding) await seeding.catch(() => {});
      let until = performance.now() + sliceMs;
      // One pass over what is marked now: an origin whose write fails is
      // marked again for the next flush, and three failures in a row (the
      // database away) end this one instead of walking every origin.
      const batch = [...dirty];
      dirty.clear();
      // The batch's seller keys are placed first, in one pass (see seedSellers).
      if (keyForOrigin) {
        try { await seedSellers(batch.map(keyForOrigin).filter(Boolean)); }
        catch (e) { for (const o of batch) dirty.add(o); log(`[listings] seller order failed: ${String(e?.message || e).slice(0, 120)}`); return; }
      }
      let failures = 0;
      for (let i = 0; i < batch.length; i++) {
        const origin = batch[i];
        try { await writeOrigin(origin, rowsForOrigin(origin)); failures = 0; }
        catch (e) {
          dirty.add(origin);
          log(`[listings] write for ${origin} failed: ${String(e?.message || e).slice(0, 120)}`);
          if (++failures >= 3) { for (const o of batch.slice(i + 1)) dirty.add(o); break; }
        }
        if (performance.now() >= until) { await new Promise((r) => setImmediate(r)); until = performance.now() + sliceMs; }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  /** Our own catalog rows, written when they change. */
  function setOurs(ourTools) {
    if (ourTools === oursRef) return false;
    oursRef = ourTools;
    const h = sha(JSON.stringify(ourTools));
    if (h === oursHash) return false;
    oursHash = h;
    dirty.add(OURS_ORIGIN);
    return true;
  }
  function oursListing() {
    const rows = (oursRef || []).map((r) => ({ method: r.method || "POST", route: r.route || "/", t: null, flat: r, ours: true }));
    const key = rows.length ? (rows[0].flat.sellerName || rows[0].flat.seller) : "";
    // Ours share one seller group when they share one seller name, as the
    // in-memory interleave groups them; a mixed set keeps its own keys below.
    return { sellerKey: key, sellerName: key, rows };
  }

  // ------------------------------------------------------------------- reads
  function whereFor({ search = "", category = "", network = "", source = "", excludeOrigin = "" }) {
    const params = [], parts = [];
    const add = (sql, v) => { params.push(v); parts.push(sql.replace("?", `$${params.length}`)); };
    const self = String(excludeOrigin || "").replace(/\/+$/, "").toLowerCase();
    if (self) add("lower(origin) <> ?", self);
    const src = String(source || "").trim().toLowerCase();
    if (src === "ours") parts.push("ours");
    if (src === "third-party") parts.push("NOT ours");
    const cat = String(category || "").trim().toLowerCase();
    if (cat) add("category = ?", cat);
    const net = String(network || "").trim().toLowerCase();
    if (net) add("networks LIKE ? ESCAPE '\\'", `%${likeEscape(net)}%`);
    const q = String(search || "").trim().toLowerCase();
    for (const term of q ? terms(q) : []) add("hay LIKE ? ESCAPE '\\'", `%${likeEscape(term)}%`);
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
  }

  /** A directory page: the in-memory directory's answer shape. */
  async function directory(args = {}) {
    await ensure();
    // Our own rows are written in line when they change (a few hundred rows,
    // and a page without them would be wrong); crawled origins are written by
    // the flush timer, so a read never waits on a crawl's backlog.
    if (Array.isArray(args.ourTools) && setOurs(args.ourTools)) {
      dirty.delete(OURS_ORIGIN);
      try { await writeOrigin(OURS_ORIGIN, oursListing()); } catch (e) { dirty.add(OURS_ORIGIN); throw e; }
    }
    const s = S();
    const { sql, params } = whereFor(args);
    const off = Math.max(0, parseInt(args.offset, 10) || 0);
    const lim = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);
    const now = Date.now();
    stats.queries++;
    const self = String(args.excludeOrigin || "").replace(/\/+$/, "").toLowerCase();
    if (!totalsMemo || totalsMemo.self !== self || now - totalsMemo.at > COUNTS_TTL_MS) {
      // Per-origin counts kept by each write: a sum over a few thousand rows
      // instead of a count over every listing.
      const t = await stateQuery(`SELECT COALESCE(sum(n_rows), 0)::int AS total, COALESCE(sum(n_ours), 0)::int AS ours, COALESCE(sum(n_described), 0)::int AS described
        FROM ${s}.index_listing_origins ${self ? "WHERE lower(origin) <> $1" : ""}`, self ? [self] : []);
      totalsMemo = { at: now, self, total: t.rows[0].total, ours: t.rows[0].ours, described: t.rows[0].described };
    }
    const ck = JSON.stringify([sql, params]);
    let c = counts.get(ck);
    // Unfiltered (only this server excluded): the totals already are the counts.
    const unfiltered = params.length === (self ? 1 : 0) && !/\bours\b/.test(sql);
    if (unfiltered) c = { at: now, matched: totalsMemo.total, described: totalsMemo.described };
    else if (!c || now - c.at > COUNTS_TTL_MS) {
      const r = await stateQuery(`SELECT count(*)::int AS matched, count(*) FILTER (WHERE described)::int AS described FROM ${s}.index_listings ${sql}`, params);
      c = { at: now, matched: r.rows[0].matched, described: r.rows[0].described };
      counts.set(ck, c);
      if (counts.size > COUNTS_MAX) counts.delete(counts.keys().next().value);
    }
    const page = await stateQuery(`SELECT p.origin, p.ours, b.body FROM (SELECT origin, pos, ours, described, rank, seller_ord FROM ${s}.index_listings ${sql}
      ORDER BY described DESC, rank, seller_ord LIMIT ${lim} OFFSET ${off}) p JOIN ${s}.index_listing_bodies b ON b.origin = p.origin AND b.pos = p.pos
      ORDER BY p.described DESC, p.rank, p.seller_ord`, params);
    // Text, not jsonb: jsonb reorders object keys, and a served row keeps the
    // key order the in-memory directory serves.
    const results = page.rows.map((x) => { const b = JSON.parse(x.body); return x.ours ? b.row : projectRow(x.origin, b.t, b.sellerName); });
    return {
      total: totalsMemo.total,
      ours: totalsMemo.ours,
      thirdParty: totalsMemo.total - totalsMemo.ours,
      matched: c.matched,
      offset: off,
      limit: lim,
      described: c.described,
      results,
    };
  }

  /** Category rollup over third-party rows, most first. */
  async function categories(excludeOrigin = "") {
    await ensure();
    const self = String(excludeOrigin || "").replace(/\/+$/, "").toLowerCase();
    // The row's category is the crawled one or "other" (flatRowOf); ties in
    // count are ordered by name here, where the in-memory rollup keeps first
    // appearance.
    const r = await stateQuery(`SELECT category_served AS c, count(*)::int AS n FROM ${S()}.index_listings
      WHERE NOT ours ${self ? "AND lower(origin) <> $1" : ""} GROUP BY 1 ORDER BY n DESC, 1`, self ? [self] : []);
    return r.rows.map((x) => ({ category: x.c, count: x.n }));
  }

  return {
    ensure, markDirty, flush, setOurs, directory, categories, writeOrigin, seedSellers,
    /** Place these seller keys before the next flush writes rows. */
    seed: (keys) => { seeding = seedSellers(keys).catch((e) => { log(`[listings] seller order seed failed: ${String(e?.message || e).slice(0, 120)}`); }); return seeding; },
    oursOrigin: OURS_ORIGIN, oursListing,
    pending: () => dirty.size,
    /** Test hook: forget the cached counts (the next page counts afresh). */
    _resetCountsForTest: () => { counts.clear(); totalsMemo = null; },
    status: () => ({ trigram, pending: dirty.size, sellers: sellerKeys ? sellerKeys.length : null, ...stats }),
  };
}
