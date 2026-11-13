// Switch a better-sqlite3 handle to WAL, waiting out a brief lock.
//
// Several processes opening one fresh file at once (servers sharing a data
// directory on one machine) race on the switch: it needs a lock another
// opener holds for a moment, and SQLite can answer SQLITE_BUSY there at once
// without calling the busy handler. So the switch is retried on SQLITE_BUSY,
// with a short sleep between tries, for up to `maxWaitMs`; any other error,
// or a lock that outlasts the wait, is thrown as before. It waits
// synchronously, so call it where the handle is opened. Most stores open at
// boot; a file-mode store opened lazily (status-store, memory's SQLite
// handle) makes the switch on its first use, which can be a request, and a
// lock held then can hold that request for up to `maxWaitMs`. Database mode
// opens neither.

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function isBusy(e) {
  const code = String(e?.code || "");
  return code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_") || /database is locked/i.test(String(e?.message || ""));
}

/** `db.pragma("journal_mode = WAL")`, retried on SQLITE_BUSY. */
export function enableWal(db, { maxWaitMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try { return db.pragma("journal_mode = WAL"); }
    catch (e) {
      if (!isBusy(e) || Date.now() >= deadline) throw e;
      Atomics.wait(SLEEP, 0, 0, stepMs);
    }
  }
}
