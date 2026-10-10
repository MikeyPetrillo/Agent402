// One JSON document with a name: the shape every whole-file store on the
// volume had (read the file at boot, keep the object in memory, write it back
// whole, tmp + rename). Behind one API it now lives in the state database when
// one is configured, in the file otherwise, and in memory when there is neither.
//
// Import once: the first database load of a document that has no row yet reads
// the file it used to live in, stores it, and records the import, so a deploy
// that turns the database on carries every store across without an operator
// step. The file is left in place until the volume goes.
//
// Writes are awaited by callers that must know (an operator listing answers
// 503 when its write failed) and fire-and-forget elsewhere, logged either way.
//
// Write-through: with a database, a saved body is also written to the file
// when the volume is there (best effort, never the verdict), so the nightly
// backup of the volume stays complete and a rollback to the previous build
// reads current files. The row is what a load reads. This ends when the
// volume is removed and the backup dumps the database instead.
//
// A failed load is not an empty document: load() retries with a backoff and,
// when the row still cannot be read, the document stays unloaded and a
// whole-body save() is refused until a load succeeds, so a body that was
// never read is never overwritten. update() is the read-modify-write for
// stores that two containers write at once: it reads the row, applies the
// change to that fresh body, and writes it only if the row's version is still
// the one it read (retrying on a conflict), so neither writer drops the other.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { documents, imports, stateDbEnabled, stateDbSchema, stateQuery } from "./state-db.js";

/** Returned by an update() mutator to leave the stored body unchanged. */
export const SKIP_UPDATE = Symbol("json-document.skip-update");
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
/** The sidecar that records which row version a write-through file carries. */
export const rowMarkOf = (file) => `${file}.rowmark`;
/** True for a body that holds no data: null, {}, [], or objects of only empty values. */
export function emptyBody(b) {
  if (b === null || b === undefined) return true;
  if (Array.isArray(b)) return b.length === 0;
  if (typeof b === "object") return Object.values(b).every((v) => v === null || (typeof v === "object" && emptyBody(v)));
  return false;
}

const NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,120}$/;
// Kept for callers that still import it; json-document itself no longer
// compares a file's mtime with the database clock (see reimportIfFileNewer).
export const NEWER_FILE_GRACE_MS = 60_000;
/** Backoff between load attempts (ms); the first load at boot tries 1 + length times. */
export const LOAD_RETRY_DELAYS_MS = Object.freeze([250, 1000, 3000]);

/** The volume's own name for a document: the file's basename. */
export function documentNameOf(file) {
  return String(file || "").split("/").pop();
}

function readJsonFile(file) {
  const raw = readFileSync(file, "utf8");
  return { body: JSON.parse(raw), bytes: Buffer.byteLength(raw) };
}
function writeJsonFile(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const raw = JSON.stringify(body);
  writeFileSync(tmp, raw);
  renameSync(tmp, file);
  return raw;
}

/**
 * @param {object} o
 * @param {string} o.name   document name in the database (defaults to the file's basename)
 * @param {string|null} [o.file]  the file it lives in without a database, and the import source with one
 * @param {(e:string)=>void} [o.log]
 * @param {boolean} [o.importFromFile=true]  read the file once when the database has no row
 */
export function createJsonDocument({ name = null, file = null, log = console.warn, importFromFile = true, writeThroughFiles = true, loadRetryDelaysMs = LOAD_RETRY_DELAYS_MS } = {}) {
  const docName = name || documentNameOf(file);
  if (!NAME_RE.test(docName)) throw new Error(`document name "${docName}" must match ${NAME_RE}`);
  const usePg = stateDbEnabled();
  let memory = undefined;
  let lastError = null;
  // "unread": no load attempted (a save-only store may save); "ok": the row
  // (or its absence) was read; "failed": the last load could not read it, so
  // a whole-body save would overwrite a body nobody read and is refused.
  let loadState = "unread";
  // Whole-body saves coalesce: one put in flight, the newest body waiting.
  // Two saves issued back to back can never land in the wrong order, and a
  // burst of persist() calls costs one write.
  let inFlight = null;
  let pendingBody = undefined;
  const say = (m) => { try { log(`[json-document] ${docName}: ${m}`); } catch { /* logging never throws */ } };

  let writeThroughWarned = false;
  /**
   * Write-through: the file gets the saved body and a sidecar names the row
   * version and the hash of what was written (file first, sidecar second, so
   * a crash between them leaves an older version in the sidecar and the file
   * is never taken for a rollback).
   */
  function writeThrough(body, version = null) {
    if (!file || !writeThroughFiles) return;
    try {
      if (!existsSync(dirname(file))) return;
      const raw = writeJsonFile(file, body);
      if (Number.isFinite(version)) writeJsonFile(rowMarkOf(file), { version, sha256: sha256(raw) });
    }
    catch (e) { if (!writeThroughWarned) { writeThroughWarned = true; say(`write-through to ${file} failed: ${String(e?.message || e).slice(0, 120)}`); } }
  }

  /**
   * Roll-forward: after a rollback the old build wrote the file alone. The
   * file is taken over the row only when this store's own write-through
   * wrote the row's CURRENT version to it (the sidecar says so) and the file
   * has changed since (its hash differs): nothing else touched the row in
   * between, and the change is the old build's. A file with no sidecar (a
   * fresh or foreign file), a sidecar for an older version (the row moved on),
   * or a file whose body is empty never replaces a row. No clock is compared.
   * Returns the body or null.
   */
  async function reimportIfFileNewer(row) {
    if (!file || !importFromFile || !writeThroughFiles) return null;
    let raw, mark;
    try { raw = readFileSync(file, "utf8"); } catch { return null; }
    try { mark = JSON.parse(readFileSync(rowMarkOf(file), "utf8")); } catch { return null; }
    if (!mark || Number(mark.version) !== row.version || mark.sha256 === sha256(raw)) return null;
    let body;
    try { body = JSON.parse(raw); } catch { return null; }
    if (emptyBody(body)) { say(`the file changed after the row's write-through but holds no data; the row is kept`); return null; }
    try {
      // Conditional on the version the sidecar named: a row another writer
      // advanced meanwhile is kept.
      const r = await stateQuery(
        `UPDATE ${table()} SET body = $2::jsonb, version = version + 1, updated_at = now() WHERE name = $1 AND version = $3 RETURNING version`,
        [docName, JSON.stringify(body), row.version],
      );
      if (!r.rowCount) return null;
      writeThrough(body, Number(r.rows[0].version));
      say(`re-imported ${Buffer.byteLength(raw)} bytes from ${file}: it changed after the write-through of row version ${row.version} (a rollback window)`);
      return body;
    } catch (e) {
      say(`re-import from ${file} failed: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    }
  }
  const table = () => `${stateDbSchema()}.documents`;

  async function importOnce() {
    if (!importFromFile || !file || !existsSync(file)) return null;
    try {
      const { body, bytes } = readJsonFile(file);
      // Put-if-absent: two containers booting at once cannot overwrite a row
      // the other one already imported and advanced.
      await documents.putIfAbsent(docName, body);
      await imports.mark(docName, { source: file, bytes });
      say(`imported ${bytes} bytes from ${file}`);
      return body;
    } catch (e) {
      say(`import from ${file} failed: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    }
  }

  const api = {
    name: docName,
    backend: usePg ? "pg" : file ? "file" : "memory",
    get lastError() { return lastError; },
    /** Whether a load has read the stored body (always true without a database). */
    get loaded() { return !usePg || loadState === "ok"; },
    /** "unread" | "ok" | "failed" (see loadState above). */
    get loadState() { return usePg ? loadState : "ok"; },
    /**
     * The stored body, or `fallback` when there is none (or it is unreadable).
     * With a database a failed read is retried with a backoff; when every try
     * fails the fallback is returned and the document stays unloaded (save()
     * is refused until a later load succeeds). read() tells the two apart.
     */
    async load(fallback = null) {
      const r = await api.read({ retry: true });
      if (r.ok) return r.exists ? r.body : fallback;
      return fallback;
    },
    /**
     * One read that says what happened: { ok, exists, body, version }.
     * ok:false is an error (never "no row"). `retry` uses the load backoff.
     */
    async read({ retry = false } = {}) {
      if (!usePg) {
        try {
          if (file) { if (!existsSync(file)) return { ok: true, exists: false, body: null, version: null }; return { ok: true, exists: true, body: readJsonFile(file).body, version: null }; }
          return { ok: true, exists: memory !== undefined, body: memory === undefined ? null : memory, version: null };
        } catch (e) {
          lastError = String(e?.message || e).slice(0, 160);
          say(`load failed: ${lastError}`);
          return { ok: false, exists: false, body: null, version: null, error: lastError };
        }
      }
      const delays = retry ? [...loadRetryDelaysMs] : [];
      for (;;) {
        try {
          const row = await documents.get(docName);
          if (row) {
            lastError = null; loadState = "ok";
            const fresher = await reimportIfFileNewer(row);
            if (fresher !== null) { const again = await documents.get(docName); return { ok: true, exists: true, body: again ? again.body : fresher, version: again ? again.version : null }; }
            return { ok: true, exists: true, body: row.body, version: row.version };
          }
          const imported = await importOnce();
          if (imported !== null) {
            const again = await documents.get(docName);
            lastError = null; loadState = "ok";
            return { ok: true, exists: true, body: again ? again.body : imported, version: again ? again.version : null };
          }
          lastError = null; loadState = "ok";
          return { ok: true, exists: false, body: null, version: 0 };
        } catch (e) {
          lastError = String(e?.message || e).slice(0, 160);
          if (!delays.length) {
            loadState = "failed";
            say(`load failed: ${lastError}; saves are held until a load succeeds`);
            return { ok: false, exists: false, body: null, version: null, error: lastError };
          }
          await sleep(delays.shift());
        }
      }
    },
    /**
     * The stored body without waiting: file and memory backends only. The
     * Postgres backend has no synchronous read; callers start from the empty
     * shape and await load() (see ready() on each store).
     */
    loadSync(fallback = null) {
      if (usePg) return fallback;
      try {
        if (file) { if (!existsSync(file)) return fallback; return readJsonFile(file).body; }
        return memory === undefined ? fallback : memory;
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        say(`load failed: ${lastError}`);
        return fallback;
      }
    },
    /** Replace the whole body. Resolves true once this body (or a newer one) is stored. */
    save(body) {
      if (!usePg) {
        try {
          if (file) writeJsonFile(file, body); else memory = body;
          lastError = null;
          return Promise.resolve(true);
        } catch (e) {
          lastError = String(e?.message || e).slice(0, 160);
          say(`save failed: ${lastError}`);
          return Promise.resolve(false);
        }
      }
      // A body that replaced a row nobody read would erase it: held until a
      // load succeeds (the store's next load or tick reads the row again).
      if (loadState === "failed") {
        lastError = lastError || "not loaded";
        say(`save refused: the stored body was never read (last load failed); it is kept as it is`);
        return Promise.resolve(false);
      }
      pendingBody = body;
      if (!inFlight) {
        inFlight = (async () => {
          let okAll = true;
          while (pendingBody !== undefined) {
            const next = pendingBody; pendingBody = undefined;
            try { const v = await documents.put(docName, next); lastError = null; writeThrough(next, v); }
            catch (e) { okAll = false; lastError = String(e?.message || e).slice(0, 160); say(`save failed: ${lastError}`); }
          }
          inFlight = null;
          return okAll;
        })();
      }
      return inFlight;
    },
    /**
     * Synchronous save for the file and memory backends (true when written).
     * On the Postgres backend the write is queued and true means "queued".
     */
    saveSync(body) {
      if (usePg) { void api.save(body); return true; }
      try {
        if (file) writeJsonFile(file, body); else memory = body;
        lastError = null;
        return true;
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        say(`save failed: ${lastError}`);
        return false;
      }
    },
    /** Resolves once no save is in flight (tests and shutdown). */
    async flush() { while (inFlight) await inFlight; },
    /**
     * Merge object keys into the stored body (and drop `dropKeys`), without
     * replacing keys another writer set: the merge-on-save stores. Resolves
     * the merged body, or null when it failed.
     */
    async mergeKeys(patch = {}, dropKeys = []) {
      try {
        if (usePg) {
          const row = await documents.get(docName);
          if (!row) await importOnce();
          const out = await documents.mergeKeys(docName, patch, dropKeys);
          lastError = null;
          writeThrough(out.body, out.version);
          return out.body;
        }
        let cur = {};
        if (file) { try { cur = readJsonFile(file).body; } catch { cur = {}; } }
        else cur = memory && typeof memory === "object" ? memory : {};
        if (!cur || typeof cur !== "object" || Array.isArray(cur)) cur = {};
        const next = { ...cur, ...patch };
        for (const k of dropKeys) delete next[k];
        if (file) writeJsonFile(file, next); else memory = next;
        lastError = null;
        return next;
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        say(`merge failed: ${lastError}`);
        return null;
      }
    },
    /**
     * Read-modify-write that never drops another writer's change. `mutate`
     * gets a copy of the stored body (or of `fallback` when there is none),
     * changes it in place or returns a new body, or returns SKIP_UPDATE to
     * leave the row alone. With a database the write is conditional on the
     * row version that was read; on a conflict the row is read again and
     * `mutate` runs again on the fresh body (so it must decide from the body
     * it is given, not from state captured outside). Resolves
     * { ok, body, version, changed } or { ok:false, error } (never throws).
     */
    async update(mutate, { fallback = null, retries = 12 } = {}) {
      if (typeof mutate !== "function") throw new Error("update needs a function");
      if (!usePg) {
        try {
          let cur;
          if (file) cur = existsSync(file) ? readJsonFile(file).body : clone(fallback);
          else cur = memory === undefined ? clone(fallback) : clone(memory);
          const base = clone(cur);
          const out = mutate(base);
          if (out === SKIP_UPDATE) return { ok: true, body: cur, version: null, changed: false };
          const next = out === undefined ? base : out;
          if (file) writeJsonFile(file, next); else memory = next;
          lastError = null;
          return { ok: true, body: next, version: null, changed: true };
        } catch (e) {
          lastError = String(e?.message || e).slice(0, 160);
          say(`update failed: ${lastError}`);
          return { ok: false, error: lastError };
        }
      }
      try {
        let triedImport = false;
        for (let attempt = 0; attempt <= retries; attempt++) {
          let row = await documents.get(docName);
          if (!row && !triedImport) { triedImport = true; if ((await importOnce()) !== null) row = await documents.get(docName); }
          loadState = "ok";
          const cur = row ? row.body : clone(fallback);
          const base = clone(cur);
          const out = mutate(base);
          if (out === SKIP_UPDATE) { lastError = null; return { ok: true, body: cur, version: row ? row.version : 0, changed: false }; }
          const next = out === undefined ? base : out;
          const r = row
            ? await stateQuery(`UPDATE ${table()} SET body = $2::jsonb, version = version + 1, updated_at = now() WHERE name = $1 AND version = $3 RETURNING version`, [docName, JSON.stringify(next ?? null), row.version])
            : await stateQuery(`INSERT INTO ${table()} (name, body) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING RETURNING version`, [docName, JSON.stringify(next ?? null)]);
          if (r.rowCount) {
            const version = Number(r.rows[0].version);
            lastError = null;
            writeThrough(next, version);
            return { ok: true, body: next, version, changed: true };
          }
          await sleep(5 + Math.floor(Math.random() * 20 * (attempt + 1))); // another writer won this round: read again
        }
        lastError = "update conflict: retries exhausted";
        say(lastError);
        return { ok: false, error: lastError };
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        say(`update failed: ${lastError}`);
        return { ok: false, error: lastError };
      }
    },
    /** Size of the file this document would import from, for diagnostics. */
    fileBytes() { try { return file ? statSync(file).size : 0; } catch { return 0; } },
  };
  return api;
}
