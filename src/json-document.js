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
//
// A load that gives up is not the end: the document keeps re-reading in the
// background with a backoff until the row is read, hands the body to the
// store (load's onLoad), and saves resume. Until then the document is named
// in the state database's list of unloaded stores, so the status word reads
// degraded, and a save issued while the first load is still running is held
// too (a body built from empty memory would replace the stored one). The
// load counts as done only once the store has the body (after any roll-forward
// re-import and its second read), so no save lands in between.
//
// A whole-body save that fails (the database went away after the document
// loaded) is not dropped: the newest body is kept and re-sent with a backoff
// until it lands, and a newer save always replaces the one waiting (an older
// body is never sent after a newer one). Until it lands the document is named
// in the state database's list of unsaved stores (the status word reads
// degraded) and every failure goes to failLog. A statement that succeeds after
// a connection failure wakes the waiting saves and re-reads at once, and
// flushJsonDocuments() sends what is waiting (the shutdown flush).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { documents, imports, onStateDbRecovered, setUnloadedStoresProbe, setUnsavedStoresProbe, stateDbEnabled, stateDbSchema, stateQuery } from "./state-db.js";

/** Returned by an update() mutator to leave the stored body unchanged. */
export const SKIP_UPDATE = Symbol("json-document.skip-update");
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // bounded backoff; not unref'd, so an awaited retry keeps a short-lived process alive
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

// Database documents whose load is running or failed, for the status word.
const notLoaded = new Set();
/** Names of the database documents whose stored body has not been read yet (load running or failed). */
export function unloadedDocuments() { return [...new Set([...notLoaded].map((d) => `document ${d.name}`))]; }
setUnloadedStoresProbe(unloadedDocuments, "json-document");
// Database documents holding a whole-body save that has not landed yet.
const unsavedDocs = new Set();
/** Names of the database documents whose latest save has not reached the row yet (it is being re-sent). */
export function unsavedDocuments() { return [...new Set([...unsavedDocs].map((d) => `document ${d.name} (save pending)`))]; }
setUnsavedStoresProbe(unsavedDocuments, "json-document");
// Every database document with a timer to cut short when the database answers
// again (a held save's retry, a failed load's re-read).
const waiting = new Set();
onStateDbRecovered(() => { for (const d of [...waiting]) { try { d._wake(); } catch { /* never throws */ } } });
/**
 * Send every waiting whole-body save now and wait for the attempts, bounded
 * by `timeoutMs` (the shutdown flush). Resolves the names still unsaved.
 */
export async function flushJsonDocuments({ timeoutMs = 5_000 } = {}) {
  const docs = [...new Set([...unsavedDocs, ...waiting])];
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(r, timeoutMs); timer.unref?.(); });
  await Promise.race([Promise.allSettled(docs.map((d) => d.flush())), deadline]).finally(() => clearTimeout(timer));
  return unsavedDocuments();
}
const envMs = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

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
export function createJsonDocument({ name = null, file = null, log = console.warn, failLog = console.warn, importFromFile = true, writeThroughFiles = true, loadRetryDelaysMs = LOAD_RETRY_DELAYS_MS } = {}) {
  const docName = name || documentNameOf(file);
  if (!NAME_RE.test(docName)) throw new Error(`document name "${docName}" must match ${NAME_RE}`);
  const usePg = stateDbEnabled();
  let memory = undefined;
  let lastError = null;
  // "unread": no load attempted (a save-only store may save); "loading": a
  // load is running and has not read the row yet; "ok": the row (or its
  // absence) was read; "failed": the last load could not read it. In
  // "loading" and "failed" a whole-body save would overwrite a body nobody
  // read and is refused.
  let loadState = "unread";
  let api = null;
  // Background re-read after a failed load (see the header note).
  let lateTimer = null;
  let lateDelay = 0;
  let lateFailures = 0;
  const lateHandlers = [];
  let refusalLogged = false;
  function setLoadState(s) {
    loadState = s;
    if (s === "loading" || s === "failed") notLoaded.add(api);
    else { notLoaded.delete(api); refusalLogged = false; }
    if (s === "failed") scheduleLateRead();
  }
  // Whole-body saves coalesce: one put in flight, the newest body waiting.
  // Two saves issued back to back can never land in the wrong order, and a
  // burst of persist() calls costs one write.
  let inFlight = null;
  let pendingBody = undefined;
  const say = (m) => { try { log(`[json-document] ${docName}: ${m}`); } catch { /* logging never throws */ } };
  // An unread body and a held save are named even when the store's own log is
  // quiet: the operator's clue to a store that is not persisting.
  const alert = (m) => { say(m); if (failLog && failLog !== log) { try { failLog(`[json-document] ${docName}: ${m}`); } catch { /* logging never throws */ } } };
  function scheduleLateRead() {
    if (lateTimer || lateReading || !usePg) return;
    lateDelay = lateDelay ? Math.min(envMs("STATE_STORE_RETRY_MAX_MS", 60_000), lateDelay * 2) : envMs("STATE_STORE_RETRY_MS", 1000);
    lateTimer = setTimeout(lateRead, lateDelay);
    lateTimer.unref?.();
    waiting.add(api);
  }
  let lateReading = false;
  async function lateRead() {
    if (lateTimer) { clearTimeout(lateTimer); lateTimer = null; }
    if (!saveTimer) waiting.delete(api);
    if (loadState === "ok" && !lateHandlers.length) { lateDelay = 0; return; }
    if (lateReading) return;
    lateReading = true;
    let r;
    try {
      lateFailures++;
      // Not done until the re-import (if any) and its second read are over.
      r = await readRow({ quiet: true });
      if (r.ok) {
        alert(`load landed after ${lateFailures} background attempt(s); saves resume`);
        lateDelay = 0; lateFailures = 0;
        setLoadState("ok"); // the handlers below take the body in this same turn
        for (const h of lateHandlers.splice(0)) {
          try { h.onLoad(r.exists ? r.body : h.fallback); } catch (e) { say(`applying the late body failed: ${String(e?.message || e).slice(0, 120)}`); }
        }
      }
    } finally { lateReading = false; }
    if (!r?.ok) scheduleLateRead();
  }
  // A whole-body save that failed waits here for its retry (see the header note).
  let saveTimer = null;
  let saveDelay = 0;
  let saveFailures = 0;
  function scheduleSaveRetry() {
    if (saveTimer || inFlight) return;
    saveDelay = saveDelay ? Math.min(envMs("STATE_STORE_RETRY_MAX_MS", 60_000), saveDelay * 2) : envMs("STATE_STORE_RETRY_MS", 1000);
    saveTimer = setTimeout(() => { saveTimer = null; if (!lateTimer) waiting.delete(api); if (pendingBody !== undefined) void startSaving(); }, saveDelay);
    saveTimer.unref?.();
    waiting.add(api);
  }
  /** One put loop: the newest body each round; on a failure the newest body is kept and retried later. */
  function startSaving() {
    if (inFlight) return inFlight;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; if (!lateTimer) waiting.delete(api); }
    inFlight = (async () => {
      let okAll = true;
      while (pendingBody !== undefined) {
        const next = pendingBody; pendingBody = undefined;
        try {
          const v = await documents.put(docName, next);
          lastError = null; writeThrough(next, v);
          if (pendingBody === undefined && unsavedDocs.has(api)) {
            unsavedDocs.delete(api);
            alert(`the held save landed after ${saveFailures} failed attempt(s)`);
            saveFailures = 0; saveDelay = 0;
          }
        } catch (e) {
          okAll = false;
          lastError = String(e?.message || e).slice(0, 160);
          // A newer body issued while this one was in flight replaces it.
          if (pendingBody === undefined) pendingBody = next;
          saveFailures++;
          unsavedDocs.add(api);
          alert(`save failed (attempt ${saveFailures}): ${lastError}; the latest body is kept and re-sent`);
          break;
        }
      }
      inFlight = null;
      if (pendingBody !== undefined) scheduleSaveRetry();
      return okAll;
    })();
    return inFlight;
  }

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

  /**
   * The read behind read() and load(): { ok, exists, body, version }. It
   * marks a failed read (the document is then held), never a good one: the
   * caller marks the load done once the body is where it belongs.
   */
  async function readRow({ retry = false, quiet = false } = {}) {
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
          const fresher = await reimportIfFileNewer(row);
          lastError = null;
          if (fresher !== null) { const again = await documents.get(docName); return { ok: true, exists: true, body: again ? again.body : fresher, version: again ? again.version : null }; }
          return { ok: true, exists: true, body: row.body, version: row.version };
        }
        const imported = await importOnce();
        if (imported !== null) {
          const again = await documents.get(docName);
          lastError = null;
          return { ok: true, exists: true, body: again ? again.body : imported, version: again ? again.version : null };
        }
        lastError = null;
        return { ok: true, exists: false, body: null, version: 0 };
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        if (!delays.length) {
          const first = loadState !== "failed";
          setLoadState("failed");
          if (!quiet || first) alert(`load failed: ${lastError}; saves are held until a load succeeds (re-reading in the background)`);
          return { ok: false, exists: false, body: null, version: null, error: lastError };
        }
        await sleep(delays.shift());
      }
    }
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

  api = {
    name: docName,
    backend: usePg ? "pg" : file ? "file" : "memory",
    get lastError() { return lastError; },
    /** Whether a load has read the stored body (always true without a database). */
    get loaded() { return !usePg || loadState === "ok"; },
    /** "unread" | "loading" | "ok" | "failed" (see loadState above). */
    get loadState() { return usePg ? loadState : "ok"; },
    /**
     * The stored body, or `fallback` when there is none (or it is unreadable).
     * With a database a failed read is retried with a backoff; when every try
     * fails the fallback is returned and the document stays unloaded (save()
     * is refused until a later load succeeds). read() tells the two apart.
     *
     * `onLoad(body)` is called once with the body the load read: at once when
     * this load reads it, or later when the background re-read does (a failed
     * load never calls it with the fallback). A store that only saves passes
     * it to take the stored body in when it finally arrives.
     */
    async load(fallback = null, { onLoad = null } = {}) {
      if (usePg && loadState !== "ok") setLoadState("loading");
      const r = await readRow({ retry: true });
      if (r.ok) {
        const body = r.exists ? r.body : fallback;
        // Done only now, after any re-import and its second read: the store
        // takes the body in this same turn (onLoad, or the caller's await),
        // so no save can land before it has it. A save onLoad makes itself
        // (a merge of what changed meanwhile) is allowed.
        if (usePg) setLoadState("ok");
        if (onLoad) { try { onLoad(body); } catch (e) { say(`applying the loaded body failed: ${String(e?.message || e).slice(0, 120)}`); } }
        return body;
      }
      if (onLoad) lateHandlers.push({ onLoad, fallback });
      return fallback;
    },
    /**
     * One read that says what happened: { ok, exists, body, version }.
     * ok:false is an error (never "no row"). `retry` uses the load backoff.
     */
    async read({ retry = false, quiet = false } = {}) {
      const r = await readRow({ retry, quiet });
      if (r.ok && usePg) setLoadState("ok");
      return r;
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
      if (loadState === "failed" || loadState === "loading") {
        lastError = lastError || "not loaded";
        const m = loadState === "loading"
          ? "save refused: the first load has not read the stored body yet; it is kept as it is"
          : "save refused: the stored body was never read (last load failed); it is kept as it is";
        if (!refusalLogged) { refusalLogged = true; alert(m); } else say(m);
        return Promise.resolve(false);
      }
      pendingBody = body;
      return startSaving();
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
    /**
     * Resolves once no save is in flight (tests and shutdown). A save waiting
     * for its retry is sent now. Resolves true when nothing is left unsaved.
     */
    async flush() {
      if (usePg && pendingBody !== undefined && !inFlight) void startSaving();
      while (inFlight) await inFlight;
      return pendingBody === undefined;
    },
    /** Cut a backoff short (the database answered again). */
    _wake() {
      if (saveTimer && pendingBody !== undefined) void startSaving();
      if (lateTimer) void lateRead();
    },
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
     * Compare-and-set of the whole body: written only when the row is still at
     * `version` (as read()), or created when `version` is 0/null and there is
     * no row. Resolves { ok:true, version } or { ok:false, conflict } (and
     * { ok:false, error } on a database error). Without a database: a plain save.
     */
    async saveIfVersion(body, version) {
      if (!usePg) { const okSave = await api.save(body); return okSave ? { ok: true, version: null } : { ok: false, error: lastError }; }
      try {
        const r = Number(version) > 0
          ? await stateQuery(`UPDATE ${table()} SET body = $2::jsonb, version = version + 1, updated_at = now() WHERE name = $1 AND version = $3 RETURNING version`, [docName, JSON.stringify(body ?? null), Number(version)])
          : await stateQuery(`INSERT INTO ${table()} (name, body) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING RETURNING version`, [docName, JSON.stringify(body ?? null)]);
        if (!r.rowCount) return { ok: false, conflict: true };
        const v = Number(r.rows[0].version);
        lastError = null; setLoadState("ok");
        writeThrough(body, v);
        return { ok: true, version: v };
      } catch (e) {
        lastError = String(e?.message || e).slice(0, 160);
        say(`conditional save failed: ${lastError}`);
        return { ok: false, error: lastError };
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
          setLoadState("ok");
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
