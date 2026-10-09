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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { documents, imports, stateDbEnabled } from "./state-db.js";

const NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,120}$/;

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
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {string} o.name   document name in the database (defaults to the file's basename)
 * @param {string|null} [o.file]  the file it lives in without a database, and the import source with one
 * @param {(e:string)=>void} [o.log]
 * @param {boolean} [o.importFromFile=true]  read the file once when the database has no row
 */
export function createJsonDocument({ name = null, file = null, log = console.warn, importFromFile = true, writeThroughFiles = true } = {}) {
  const docName = name || documentNameOf(file);
  if (!NAME_RE.test(docName)) throw new Error(`document name "${docName}" must match ${NAME_RE}`);
  const usePg = stateDbEnabled();
  let memory = undefined;
  let lastError = null;
  // Whole-body saves coalesce: one put in flight, the newest body waiting.
  // Two saves issued back to back can never land in the wrong order, and a
  // burst of persist() calls costs one write.
  let inFlight = null;
  let pendingBody = undefined;
  const say = (m) => { try { log(`[json-document] ${docName}: ${m}`); } catch { /* logging never throws */ } };

  let writeThroughWarned = false;
  function writeThrough(body) {
    if (!file || !writeThroughFiles) return;
    try { if (existsSync(dirname(file))) writeJsonFile(file, body); }
    catch (e) { if (!writeThroughWarned) { writeThroughWarned = true; say(`write-through to ${file} failed: ${String(e?.message || e).slice(0, 120)}`); } }
  }

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

  return {
    name: docName,
    backend: usePg ? "pg" : file ? "file" : "memory",
    get lastError() { return lastError; },
    /** The stored body, or `fallback` when there is none (or it is unreadable). */
    async load(fallback = null) {
      try {
        if (usePg) {
          const row = await documents.get(docName);
          if (row) { lastError = null; return row.body; }
          const imported = await importOnce();
          lastError = null;
          return imported === null ? fallback : imported;
        }
        if (file) { if (!existsSync(file)) return fallback; return readJsonFile(file).body; }
        return memory === undefined ? fallback : memory;
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        say(`load failed: ${lastError}`);
        return fallback;
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
      pendingBody = body;
      if (!inFlight) {
        inFlight = (async () => {
          let okAll = true;
          while (pendingBody !== undefined) {
            const next = pendingBody; pendingBody = undefined;
            try { await documents.put(docName, next); lastError = null; writeThrough(next); }
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
      if (usePg) { void this.save(body); return true; }
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
          writeThrough(out.body);
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
    /** Size of the file this document would import from, for diagnostics. */
    fileBytes() { try { return file ? statSync(file).size : 0; } catch { return 0; } },
  };
}
