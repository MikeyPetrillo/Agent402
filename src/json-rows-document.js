// A JSON document whose large maps are stored one row per key: the same
// load/update API as a json-document (src/json-document.js), for a store whose
// body is a few small sections beside maps that grow to thousands of keys
// (the referral settlement book, src/referral-book.js).
//
// WITH A DATABASE. The small sections stay in the `documents` row (the HEAD);
// each key of a named map (`parts`) is one row of the `records` table, in the
// collection `<name>.rows`, id `<part>:<key>`, body `{ v, b }` (`b` the value,
// `v` the head version that wrote it). An update:
//   1. locks the head row (SELECT ... FOR UPDATE), so writers in every process
//      take turns and none of them reads a body another is about to replace;
//   2. brings this process's copy up to date when the head version moved:
//      one read of the row ids, with the body only of rows written after the
//      version it holds (a row that is gone was deleted);
//   3. runs the change on that copy and writes ONLY what changed: the rows
//      whose value is a new object, the deletions, and the head (its body
//      only when the small sections changed; its version always).
// A write is then the size of the entries it touches, not the size of the
// book (the mirror below is off by default; a writer that turns it on puts
// the whole body in the head too). Values in the copy are frozen: a change replaces an entry, it never
// edits one in place (an in-place edit would throw, never go unwritten).
//
// THE OVERLAP WITH A BUILD BEFORE ROWS (the release that brought rows ran
// with the mirror on; every build after it runs with it off). A build before
// rows reads and writes the book as ONE document (the head's body, by
// compare-and-set on its version) and runs beside this one for a deploy's
// overlap (and after a rollback). So that each sees every change the other
// makes:
//   - with `mirror: true` a build writes the WHOLE body into the head beside
//     the rows, with a mark naming the head version it wrote (`__rowsAt`):
//     an older build reads every entry, mark and record, and its own write
//     is based on them (its compare-and-set re-reads after any write here);
//   - a head whose mark is not its own version was written last by an older
//     build (which never keeps the mark): its sections are the book as that
//     build left it, and they are TAKEN AS WRITTEN: a key it added becomes a
//     row, a key it changed is rewritten, and a row it no longer holds (an
//     entry it closed) is deleted. The same holds for the whole-book head a
//     build before this one left behind, read once at the first write.
// The mirror costs a whole-book head write per update while it is on (about
// 1.8 MB at 2,000 open entries), so it is off by default (`mirror: false`)
// now that no build before rows serves: the rows alone are written, and a
// rollback past the release that brought rows would read an empty book. A
// head that still carries a mirror (its mark) is rewritten WITHOUT it by the first write made with the mirror off, whatever
// that write changed: a mirror left beside a newer version would read, to
// every later reader, as the book an older build wrote, and be taken over
// the rows. So a process with the mirror off runs safely beside one that
// still writes it (each such head is rewritten once), and a head written
// with the mirror off holds neither parts nor mark.
//
// WITHOUT A DATABASE the document is a json-document (a file, or memory).
import { existsSync, readFileSync } from "node:fs";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { stateDbEnabled, stateDbSchema, withStateTx } from "./state-db.js";

/** How long one update waits for another process's write to the same document (ms). */
export const ROWS_LOCK_WAIT_MS = 5_000;
/** The head field naming the head version whose write carried the mirror (an older build never keeps it). */
export const ROWS_MARK = "__rowsAt";
const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * The whole body a head and its rows stand for (`rows`: { [part]: { key: value } }):
 * the rows, unless the head was written last by a build before rows (its mark
 * is not `version`), whose sections are then the book as it stands. Pure:
 * the store's own read and the state export (scripts/state-export.js) agree.
 */
export function wholeBodyOf({ body, version, rows, parts }) {
  const out = isMap(body) ? { ...body } : {};
  const mirrored = Object.hasOwn(out, ROWS_MARK) && Number(out[ROWS_MARK]) === Number(version);
  delete out[ROWS_MARK];
  for (const p of parts) {
    if (!mirrored && isMap(out[p])) continue; // taken as the older build wrote it
    out[p] = { ...(rows?.[p] || {}) };
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.name      the head's document name
 * @param {string[]} o.parts   the sections stored one row per key
 * @param {string|null} [o.file]  the file without a database, and the one-time import source with one
 */
export function createJsonRowsDocument({ name, parts, file = null, log = console.warn, lockWaitMs = ROWS_LOCK_WAIT_MS, mirror = false } = {}) {
  if (!stateDbEnabled()) return createJsonDocument({ name, file, log });
  if (!Array.isArray(parts) || !parts.length) throw new Error("a rows document needs its parts");
  const PARTS = [...parts];
  const collection = `${name}.rows`;
  const T = (t) => `${stateDbSchema()}.${t}`;
  const say = (m) => { try { log(`[json-rows-document] ${name}: ${m}`); } catch { /* logging never throws */ } };
  const emptyParts = () => Object.fromEntries(PARTS.map((p) => [p, {}]));
  // This process's copy: the head version it reflects (-1: none read), the
  // head without the parts (and its text, to tell a change), the parts, and
  // whether the head body as stored carries the mirror's mark (`marked`).
  let copy = { version: -1, head: {}, headText: "{}", parts: emptyParts(), marked: false };
  const stats = { updates: 0, rowsWritten: 0, rowsDeleted: 0, headWrites: 0, bytes: 0, refreshes: 0, folded: 0, lastBytes: 0, lastRowBytes: 0 };
  let lastError = null;

  /** The head without the parts and the mark, the sections an older build wrote (none when the mark is `version`), and whether the body carried the mark at all. */
  const splitHead = (body, version) => {
    const head = isMap(body) ? { ...body } : {};
    const marked = Object.hasOwn(head, ROWS_MARK);
    const mirrored = marked && Number(head[ROWS_MARK]) === Number(version);
    delete head[ROWS_MARK];
    const sections = {};
    for (const p of PARTS) { if (p in head) { if (!mirrored && isMap(head[p])) sections[p] = head[p]; delete head[p]; } }
    return { head, sections, marked };
  };
  const assemble = (c) => {
    const body = JSON.parse(c.headText);
    for (const p of PARTS) body[p] = { ...c.parts[p] };
    return body;
  };
  /**
   * The copy as of head version `version` (whose body is `headBody`), read
   * inside `client`'s transaction. When an older build wrote the head last,
   * `parts` are its sections (taken as written) and `rows` what the rows hold,
   * so the next write brings the rows to the sections; `rows` is null otherwise.
   */
  async function readCopy(client, version, headBody) {
    const base = copy;
    const r = await client.query(`SELECT id, CASE WHEN (body->>'v')::bigint > $2 THEN body->'b' END AS b, (body->>'v')::bigint > $2 AS fresh FROM ${T("records")} WHERE collection = $1`, [collection, base.version]);
    let next = emptyParts();
    let missing = false;
    for (const row of r.rows) {
      const id = String(row.id);
      const cut = id.indexOf(":");
      const p = id.slice(0, cut), k = id.slice(cut + 1);
      if (!next[p]) continue;
      if (row.fresh) next[p][k] = Object.freeze(row.b);
      else if (base.parts[p] && k in base.parts[p]) next[p][k] = base.parts[p][k];
      else { missing = true; break; }
    }
    if (missing) {
      // A row this copy never held and that is not newer than it: read every body.
      const all = await client.query(`SELECT id, body->'b' AS b FROM ${T("records")} WHERE collection = $1`, [collection]);
      next = emptyParts();
      for (const row of all.rows) { const id = String(row.id); const cut = id.indexOf(":"); const p = id.slice(0, cut); if (next[p]) next[p][id.slice(cut + 1)] = Object.freeze(row.b); }
    }
    stats.refreshes++;
    const { head, sections, marked } = splitHead(headBody, version);
    if (!Object.keys(sections).length) return { version, head, headText: JSON.stringify(head), parts: next, rows: null, marked };
    const taken = { ...next };
    for (const p of Object.keys(sections)) taken[p] = Object.fromEntries(Object.entries(sections[p]).map(([k, v]) => [k, v !== null && typeof v === "object" ? Object.freeze(v) : v]));
    return { version, head, headText: JSON.stringify(head), parts: taken, rows: next, marked };
  }
  const importBody = () => {
    if (!file || !existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { say(`file ${file} is unreadable (${String(e?.message || e).slice(0, 120)}); not imported`); return null; }
  };
  /** Lock the head (creating it from the import or `fallback` the first time); the copy as the row stands. */
  async function lockedCopy(client, fallback, lock = "FOR UPDATE") {
    // (A head this build wrote carries the whole body as its mirror: read without it.)
    const sel = `SELECT version, CASE WHEN version = $2 THEN NULL WHEN body->>'${ROWS_MARK}' = version::text THEN body - $3::text[] ELSE body END AS body FROM ${T("documents")} WHERE name = $1 ${lock}`;
    let r = await client.query(sel, [name, copy.version, PARTS]);
    if (!r.rows.length) {
      if (lock !== "FOR UPDATE") return null;
      const first = importBody() ?? fallback ?? {};
      await client.query(`INSERT INTO ${T("documents")} (name, body) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING`, [name, JSON.stringify(isMap(first) ? first : {})]);
      r = await client.query(sel, [name, -1, PARTS]);
    }
    const version = Number(r.rows[0].version);
    if (version === copy.version) return { ...copy, rows: null };
    return readCopy(client, version, r.rows[0].body);
  }

  const api = {
    name,
    backend: "pg-rows",
    get lastError() { return lastError; },
    get loaded() { return copy.version >= 0; },
    loadState: "ok",
    loadSync(fallback = null) { return fallback; },
    /** The body as it stands (the head and every row), or `fallback` when there is no head yet. */
    async load(fallback = null) {
      try {
        const c = await withStateTx(async (client) => {
          const got = await lockedCopy(client, fallback, "FOR SHARE");
          return got;
        });
        if (!c) return fallback;
        // A copy taken from an older build's sections is not the rows' version: the next write brings the rows to it.
        copy = { version: c.rows ? -1 : c.version, head: c.head, headText: c.headText, parts: c.parts, marked: c.marked === true };
        lastError = null;
        return assemble(copy);
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        say(`load failed: ${lastError}`);
        return fallback;
      }
    },
    async read() { const body = await api.load(null); return { ok: lastError === null, exists: body !== null, body, version: copy.version }; },
    /**
     * Read-modify-write under the head's row lock (see the header note).
     * Resolves { ok, body, version, changed, bytes } or { ok:false, error }
     * (never throws; a `mutate` that throws rolls the write back and the
     * error is returned).
     */
    async update(mutate, { fallback = null } = {}) {
      if (typeof mutate !== "function") throw new Error("update needs a function");
      let landed = null;
      try {
        landed = await withStateTx(async (client) => {
          await client.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(Number(lockWaitMs) || ROWS_LOCK_WAIT_MS))}`);
          const c = await lockedCopy(client, fallback);
          const hadSections = !!c.rows;
          const given = assemble(c);
          const out = mutate(given);
          if (out === SKIP_UPDATE && !hadSections) return { c, changed: false };
          // (undefined: the change was made in place on the body it was given.)
          const next = out === SKIP_UPDATE ? assemble(c) : out === undefined ? given : out;
          const ups = [], dels = [];
          const parts2 = {};
          for (const p of PARTS) {
            const now_ = isMap(next[p]) ? next[p] : {};
            // (Against what the rows hold: after an older build's write, every key it holds is written and every row it dropped deleted.)
            const was = (c.rows || c.parts)[p];
            const kept = {};
            for (const k of Object.keys(now_)) {
              const v = now_[k];
              if (v === undefined) continue;
              if (was[k] !== v) ups.push([`${p}:${k}`, v]);
              kept[k] = v !== null && typeof v === "object" ? Object.freeze(v) : v;
            }
            for (const k of Object.keys(was)) if (!(k in kept)) dels.push(`${p}:${k}`);
            parts2[p] = kept;
          }
          const { head } = splitHead(next, null);
          const headText = JSON.stringify(head);
          const version = c.version + 1;
          // With the mirror on, the head carries the whole body and the mark of this version (header note).
          // With it off, a head that still carries a mirror's mark is rewritten without the mirror (header note).
          const headChanged = mirror || headText !== c.headText || hadSections || c.marked === true;
          const bodyText = mirror ? JSON.stringify({ ...head, ...parts2, [ROWS_MARK]: version }) : headText;
          let bytes = 0;
          if (ups.length) {
            const text = JSON.stringify(ups);
            bytes += text.length;
            await client.query(`INSERT INTO ${T("records")} (collection, id, body) SELECT $1, e->>0, jsonb_build_object('v', $2::bigint, 'b', e->1) FROM jsonb_array_elements($3::jsonb) AS e ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`, [collection, version, text]);
          }
          if (dels.length) await client.query(`DELETE FROM ${T("records")} WHERE collection = $1 AND id = ANY($2::text[])`, [collection, dels]);
          if (headChanged) bytes += bodyText.length;
          const r = await client.query(`UPDATE ${T("documents")} SET version = version + 1, updated_at = now()${headChanged ? ", body = $3::jsonb" : ""} WHERE name = $1 AND version = $2 RETURNING version`, headChanged ? [name, c.version, bodyText] : [name, c.version]);
          // (The row is locked: its version is the one read. A miss is a fault, never a lost change.)
          if (!r.rowCount) throw new Error("the head row moved under its lock");
          return { c: { version, head, headText, parts: parts2, marked: headChanged ? mirror : c.marked === true }, changed: true, ups: ups.length, dels: dels.length, headChanged, bytes, rowBytes: bytes - (headChanged ? bodyText.length : 0), hadSections };
        });
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        // What this process holds may be behind what landed (a lost COMMIT reply): read again next time.
        copy = { ...copy, version: -1 };
        say(`update failed: ${lastError}`);
        return { ok: false, error: lastError };
      }
      lastError = null;
      copy = { version: landed.c.version, head: landed.c.head, headText: landed.c.headText, parts: landed.c.parts, marked: landed.c.marked === true };
      if (!landed.changed) return { ok: true, body: assemble(copy), version: copy.version, changed: false, bytes: 0 };
      stats.updates++;
      stats.rowsWritten += landed.ups;
      stats.rowsDeleted += landed.dels;
      if (landed.headChanged) stats.headWrites++;
      stats.bytes += landed.bytes;
      stats.lastBytes = landed.bytes;
      stats.lastRowBytes = landed.rowBytes;
      if (landed.hadSections) { stats.folded++; say(`the book as an older build wrote it was taken into rows (head version ${copy.version})`); }
      return { ok: true, body: assemble(copy), version: copy.version, changed: true, bytes: landed.bytes };
    },
    /** Write counters since boot (tests, the operator view). */
    rowStats: () => ({ ...stats }),
  };
  return api;
}
