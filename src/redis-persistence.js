// Whether the Redis behind REDIS_URL keeps what it is given.
//
// The money journals (src/ledger-journal-redis.js) move to Redis because an
// entry there outlives the container, and that holds only while append-only
// persistence is on. This reads `INFO persistence` through the shared client
// (src/shared-limit.js) shortly after boot and then on a timer, under a
// bounded timeout and never on a request's path, and reduces it to one word:
//   on        aof_enabled:1, the last AOF write and the last rewrite both ok
//   degraded  append-only on, but a last status not ok
//   off       aof_enabled:0
//   unknown   no REDIS_URL, not read yet, or the read failed
// The word is what /api/gateway-status publishes; the parsed fields stay with
// the operator view (`full`). A read that fails keeps the last parsed fields
// for the operator and the word goes to unknown until a read succeeds.
import { getSharedRedisClient } from "./shared-limit.js";

/** How often persistence is re-read once a read has answered (REDIS_PERSISTENCE_CHECK_MS, default five minutes). */
export const CHECK_MS = () => Math.max(1_000, Number(process.env.REDIS_PERSISTENCE_CHECK_MS) || 300_000);
/** How soon a read is retried while the word is unknown (REDIS_PERSISTENCE_RETRY_MS). */
export const RETRY_MS = () => Math.max(100, Number(process.env.REDIS_PERSISTENCE_RETRY_MS) || 5_000);
/** How long after start the first read runs (REDIS_PERSISTENCE_FIRST_MS). */
export const FIRST_MS = () => Math.max(0, Number(process.env.REDIS_PERSISTENCE_FIRST_MS ?? 2_000));
/** A read that has not answered within this is a failure (REDIS_PERSISTENCE_OP_MS). */
export const OP_MS = () => Math.max(50, Number(process.env.REDIS_PERSISTENCE_OP_MS) || 1_500);

/**
 * The fields of an `INFO persistence` answer this module reads, or null when
 * the text is not one (no `aof_enabled` line). A field that is missing or not
 * a number where one is expected reads null.
 */
export function parsePersistenceInfo(text) {
  if (typeof text !== "string") return null;
  const kv = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    kv.set(line.slice(0, i), line.slice(i + 1));
  }
  if (!kv.has("aof_enabled")) return null;
  const int = (k) => { const v = kv.get(k); return v === undefined || !/^-?\d+$/.test(v) ? null : Number(v); };
  const str = (k) => (kv.has(k) ? kv.get(k) : null);
  const aofEnabled = int("aof_enabled");
  return {
    appendonly: aofEnabled === null ? null : aofEnabled === 1,
    aofEnabled,
    aofLastWriteStatus: str("aof_last_write_status"),
    aofLastBgrewriteStatus: str("aof_last_bgrewrite_status"),
    aofRewriteInProgress: int("aof_rewrite_in_progress"),
    rdbLastSaveTime: int("rdb_last_save_time"),
    rdbChangesSinceLastSave: int("rdb_changes_since_last_save"),
    rdbLastBgsaveStatus: str("rdb_last_bgsave_status"),
    loading: int("loading"),
  };
}

/** One word for parsed fields (see the module note). */
export function persistenceWord(fields) {
  if (!fields || fields.aofEnabled === null || fields.aofEnabled === undefined) return "unknown";
  if (fields.aofEnabled === 0) return "off";
  if (fields.aofEnabled !== 1) return "unknown";
  return fields.aofLastWriteStatus === "ok" && fields.aofLastBgrewriteStatus === "ok" ? "on" : "degraded";
}

/** Resolves `p`, or rejects once `ms` has passed (the command keeps running on its client). */
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("redis persistence: read timed out")), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * One monitor. `redis()` resolves the client (null when not configured or not
 * reachable), `enabled()` says whether there is a Redis to read at all.
 * `start()` schedules the first read; `check()` reads now (one read in flight
 * at a time); `onChange(fn)` is called with (word, previousWord) when the word
 * changes; `firstRead()` resolves once any read has finished.
 */
export function createPersistenceMonitor({ redis = getSharedRedisClient, enabled = () => Boolean(String(process.env.REDIS_URL || "").trim()), now = Date.now, log = console } = {}) {
  let word = "unknown";
  let reason = "not_read";
  let fields = null;       // the last PARSED answer
  let readAt = null;       // when it was read (ms)
  let failedAt = null;     // the last failed read (ms)
  let failure = null;      // why it failed: unreachable / timeout / read_failed / unreadable
  let timer = null;
  let inflight = null;
  let started = false;
  let stopped = false;
  const listeners = new Set();
  let resolveFirst;
  const first = new Promise((r) => { resolveFirst = r; });

  const setWord = (w, why) => {
    const prev = word;
    word = w; reason = why;
    if (w !== prev) for (const fn of listeners) { try { fn(w, prev); } catch (e) { log.error?.(`[redis-persistence] listener failed: ${e?.message || e}`); } }
  };
  const schedule = (ms) => {
    if (stopped || !started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; check(); }, ms);
    timer.unref?.();
  };

  // Not an async function: every caller during one read gets that read's promise.
  function check() {
    if (inflight) return inflight;
    inflight = (async () => {
      const at = now();
      try {
        if (!enabled()) { setWord("unknown", "no_redis_url"); return word; }
        let c = null;
        try { c = await redis(); } catch { c = null; }
        if (!c) { failedAt = at; failure = "unreachable"; setWord("unknown", "unreachable"); return word; }
        const text = await withTimeout(c.info("persistence"), OP_MS());
        const f = parsePersistenceInfo(text);
        if (!f) { failedAt = at; failure = "unreadable"; setWord("unknown", "unreadable"); return word; }
        fields = f; readAt = at; failure = null;
        const w = persistenceWord(f);
        setWord(w, w === "unknown" ? "unreadable" : null);
      } catch (e) {
        failedAt = at;
        failure = /timed out/.test(String(e?.message || "")) ? "timeout" : "read_failed";
        setWord("unknown", failure);
      }
      return word;
    })().finally(() => {
      inflight = null;
      resolveFirst();
      schedule(word === "unknown" ? RETRY_MS() : CHECK_MS());
    });
    return inflight;
  }

  return {
    /** Schedules the first read; a no-op without a Redis to read, and the second call does nothing. */
    start() {
      if (started) return;
      started = true;
      if (!enabled()) { setWord("unknown", "no_redis_url"); resolveFirst(); return; }
      schedule(FIRST_MS());
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    check,
    word: () => (enabled() ? word : "unknown"),
    firstRead: () => first,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /**
     * `{ status }` for everyone; `full` adds why, when it was read, the parsed
     * fields (rdb_last_save_time as an age) and the last failure.
     */
    status({ full = false } = {}) {
      const w = enabled() ? word : "unknown";
      if (!full) return { status: w };
      const why = enabled() ? reason : "no_redis_url";
      const t = now();
      return {
        status: w,
        reason: why,
        readAt: readAt == null ? null : new Date(readAt).toISOString(),
        failedAt: failedAt == null ? null : new Date(failedAt).toISOString(),
        failure,
        fields: fields ? {
          appendonly: fields.appendonly,
          aofEnabled: fields.aofEnabled,
          aofLastWriteStatus: fields.aofLastWriteStatus,
          aofLastBgrewriteStatus: fields.aofLastBgrewriteStatus,
          aofRewriteInProgress: fields.aofRewriteInProgress,
          rdbLastSaveAgeSeconds: fields.rdbLastSaveTime == null ? null : Math.max(0, Math.floor(t / 1000) - fields.rdbLastSaveTime),
          rdbChangesSinceLastSave: fields.rdbChangesSinceLastSave,
          rdbLastBgsaveStatus: fields.rdbLastBgsaveStatus,
        } : null,
      };
    },
  };
}

// ---- the process's one monitor ----------------------------------------------
// The client every read uses: the shared one (src/shared-limit.js). A test may
// hand its own getter; with one set the monitor reads even without REDIS_URL.
let clientOf = getSharedRedisClient;
let testClient = false;
let monitor = null;
export function __setRedisPersistenceClientForTest(fn) { clientOf = fn || getSharedRedisClient; testClient = Boolean(fn); }
export function __resetRedisPersistenceForTest() { monitor?.stop(); monitor = null; }
const configured = () => testClient || Boolean(String(process.env.REDIS_URL || "").trim());

/** The process's monitor (made on first use, not started). */
export function redisPersistenceMonitor() {
  if (!monitor) monitor = createPersistenceMonitor({ redis: () => clientOf(), enabled: configured });
  return monitor;
}
/** Starts the first read shortly after boot and the timer after it (idempotent). */
export function startRedisPersistenceMonitor() {
  const m = redisPersistenceMonitor();
  m.start();
  return m;
}
/** The current word: on / degraded / off / unknown. */
export function redisPersistenceWord() { return redisPersistenceMonitor().word(); }
/** redisPersistence on /api/gateway-status: one word publicly, the fields for the operator. */
export function redisPersistenceStatus(opts) { return redisPersistenceMonitor().status(opts); }
