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
// book. Values in the copy are frozen: a change replaces an entry, it never
// edits one in place (an in-place edit would throw, never go unwritten).
//
// ROLL FORWARD. A head that still holds a map as a section (the whole-book
// shape a build before this one wrote, read once at the first write, or
// written by such a build during a deploy's overlap) is folded into rows by
// the next write, a row already standing for a key winning over the section's
// copy, and the head is written back without it. A build before this one
// reads the new head as a book with no open entries and cannot be rolled back
// to safely: fix forward (.claude/rules/ops.md).
//
// WITHOUT A DATABASE the document is a json-document (a file, or memory).
import { existsSync, readFileSync } from "node:fs";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { stateDbEnabled, stateDbSchema, withStateTx } from "./state-db.js";

/** How long one update waits for another process's write to the same document (ms). */
export const ROWS_LOCK_WAIT_MS = 5_000;
const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * @param {object} o
 * @param {string} o.name      the head's document name
 * @param {string[]} o.parts   the sections stored one row per key
 * @param {string|null} [o.file]  the file without a database, and the one-time import source with one
 */
export function createJsonRowsDocument({ name, parts, file = null, log = console.warn, lockWaitMs = ROWS_LOCK_WAIT_MS } = {}) {
  if (!stateDbEnabled()) return createJsonDocument({ name, file, log });
  if (!Array.isArray(parts) || !parts.length) throw new Error("a rows document needs its parts");
  const PARTS = [...parts];
  const collection = `${name}.rows`;
  const T = (t) => `${stateDbSchema()}.${t}`;
  const say = (m) => { try { log(`[json-rows-document] ${name}: ${m}`); } catch { /* logging never throws */ } };
  const emptyParts = () => Object.fromEntries(PARTS.map((p) => [p, {}]));
  // This process's copy: the head version it reflects (-1: none read), the
  // head without the parts (and its text, to tell a change), and the parts.
  let copy = { version: -1, head: {}, headText: "{}", parts: emptyParts() };
  const stats = { updates: 0, rowsWritten: 0, rowsDeleted: 0, headWrites: 0, bytes: 0, refreshes: 0, folded: 0, lastBytes: 0 };
  let lastError = null;

  const splitHead = (body) => {
    const head = isMap(body) ? { ...body } : {};
    const sections = {};
    for (const p of PARTS) { if (p in head) { if (isMap(head[p])) sections[p] = head[p]; delete head[p]; } }
    return { head, sections };
  };
  const assemble = (c) => {
    const body = JSON.parse(c.headText);
    for (const p of PARTS) body[p] = { ...c.parts[p] };
    return body;
  };
  /** The copy as of head version `version` (whose body is `headBody`), read inside `client`'s transaction. */
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
    const { head, sections } = splitHead(headBody);
    return { version, head, headText: JSON.stringify(head), parts: next, sections };
  }
  const importBody = () => {
    if (!file || !existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { say(`file ${file} is unreadable (${String(e?.message || e).slice(0, 120)}); not imported`); return null; }
  };
  /** Lock the head (creating it from the import or `fallback` the first time); the copy as the row stands. */
  async function lockedCopy(client, fallback, lock = "FOR UPDATE") {
    const sel = `SELECT version, CASE WHEN version = $2 THEN NULL ELSE body END AS body FROM ${T("documents")} WHERE name = $1 ${lock}`;
    let r = await client.query(sel, [name, copy.version]);
    if (!r.rows.length) {
      if (lock !== "FOR UPDATE") return null;
      const first = importBody() ?? fallback ?? {};
      await client.query(`INSERT INTO ${T("documents")} (name, body) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING`, [name, JSON.stringify(isMap(first) ? first : {})]);
      r = await client.query(sel, [name, -1]);
    }
    const version = Number(r.rows[0].version);
    if (version === copy.version) return { ...copy, sections: {} };
    return readCopy(client, version, r.rows[0].body);
  }
  /** Fold a whole-book section into the copy: a key already a row is kept as the row has it. */
  const foldSections = (c) => {
    const fold = [];
    for (const p of Object.keys(c.sections || {})) for (const [k, v] of Object.entries(c.sections[p])) if (!(k in c.parts[p])) { c.parts[p] = c.parts[p] === copy.parts[p] ? { ...c.parts[p] } : c.parts[p]; c.parts[p][k] = Object.freeze(v); fold.push([p, k]); }
    return fold;
  };

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
        const hasSections = Object.keys(c.sections || {}).length > 0;
        const fold = foldSections(c);
        // A copy holding a folded section is not taken as the row's version: the next write folds it for real.
        copy = { version: hasSections || fold.length ? -1 : c.version, head: c.head, headText: c.headText, parts: c.parts };
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
          const fold = foldSections(c);
          const hadSections = Object.keys(c.sections || {}).length > 0;
          const given = assemble(c);
          const out = mutate(given);
          if (out === SKIP_UPDATE && !hadSections) return { c, changed: false };
          // (undefined: the change was made in place on the body it was given.)
          const next = out === SKIP_UPDATE ? assemble(c) : out === undefined ? given : out;
          const ups = [], dels = [];
          const parts2 = {};
          const folded = new Set(fold.map(([p, k]) => `${p}:${k}`));
          for (const p of PARTS) {
            const now_ = isMap(next[p]) ? next[p] : {};
            const was = c.parts[p];
            const kept = {};
            for (const k of Object.keys(now_)) {
              const v = now_[k];
              if (v === undefined) continue;
              if (was[k] !== v || folded.has(`${p}:${k}`)) ups.push([`${p}:${k}`, v]);
              kept[k] = v !== null && typeof v === "object" ? Object.freeze(v) : v;
            }
            for (const k of Object.keys(was)) if (!(k in kept)) dels.push(`${p}:${k}`);
            parts2[p] = kept;
          }
          const { head } = splitHead(next);
          const headText = JSON.stringify(head);
          const headChanged = headText !== c.headText || hadSections;
          const version = c.version + 1;
          let bytes = 0;
          if (ups.length) {
            const text = JSON.stringify(ups);
            bytes += text.length;
            await client.query(`INSERT INTO ${T("records")} (collection, id, body) SELECT $1, e->>0, jsonb_build_object('v', $2::bigint, 'b', e->1) FROM jsonb_array_elements($3::jsonb) AS e ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`, [collection, version, text]);
          }
          if (dels.length) await client.query(`DELETE FROM ${T("records")} WHERE collection = $1 AND id = ANY($2::text[])`, [collection, dels]);
          if (headChanged) bytes += headText.length;
          const r = await client.query(`UPDATE ${T("documents")} SET version = version + 1, updated_at = now()${headChanged ? ", body = $3::jsonb" : ""} WHERE name = $1 AND version = $2 RETURNING version`, headChanged ? [name, c.version, headText] : [name, c.version]);
          // (The row is locked: its version is the one read. A miss is a fault, never a lost change.)
          if (!r.rowCount) throw new Error("the head row moved under its lock");
          return { c: { version, head, headText, parts: parts2 }, changed: true, ups: ups.length, dels: dels.length, headChanged, bytes, hadSections };
        });
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        // What this process holds may be behind what landed (a lost COMMIT reply): read again next time.
        copy = { ...copy, version: -1 };
        say(`update failed: ${lastError}`);
        return { ok: false, error: lastError };
      }
      lastError = null;
      copy = { version: landed.c.version, head: landed.c.head, headText: landed.c.headText, parts: landed.c.parts };
      if (!landed.changed) return { ok: true, body: assemble(copy), version: copy.version, changed: false, bytes: 0 };
      stats.updates++;
      stats.rowsWritten += landed.ups;
      stats.rowsDeleted += landed.dels;
      if (landed.headChanged) stats.headWrites++;
      stats.bytes += landed.bytes;
      stats.lastBytes = landed.bytes;
      if (landed.hadSections) { stats.folded++; say(`whole-book sections folded into rows (head version ${copy.version})`); }
      return { ok: true, body: assemble(copy), version: copy.version, changed: true, bytes: landed.bytes };
    },
    /** Write counters since boot (tests, the operator view). */
    rowStats: () => ({ ...stats }),
  };
  return api;
}
