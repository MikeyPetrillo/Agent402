// Durable record of the Tempo late-landing watches (src/mpp-tempo.js
// watchLateTempoLanding).
//
// A pull credential answered 402 after its broadcast failed can still land on
// chain inside its validity. The in-process watch reads the chain again on a
// few delays and books a landed transfer as owed. Two things used to lose a
// watch with no record: the per-process bound (past it a watch was skipped)
// and a process that stopped mid-watch (a deploy or restart). So every watch
// is written here when it starts and removed when it ends. A watch past the
// bound runs nowhere in process; the sweep (a leased tick in server.js) reads
// each entry that no live watch on this process owns once its last delay has
// passed, books a landed transfer through the same path, and removes the
// entry. Booking is keyed by the transaction hash (the refund ledger's
// evidence is unique), so an entry read twice books once.
//
// An entry whose read keeps failing is kept and read again on the next tick,
// for at most LATE_WATCH_GIVE_UP_MS; then it is logged as an error and
// dropped. Past LATE_WATCH_KEEP_MAX entries the oldest is logged and dropped.
// The stored entry carries the credential (the chain read needs it), the
// route, the amount, the ledger payer when known and whether the request was
// our own synthetic traffic; nothing else about the request.
import { createHash } from "node:crypto";
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";

export const LATE_WATCH_DOC = "tempo-late-watches";
export const LATE_WATCH_KEEP_MAX = 2000;
// Read by the sweep only this long after the watch's last delay, so a live
// watch on another container (a deploy overlap) finishes first.
export const LATE_WATCH_GRACE_MS = 30_000;
export const LATE_WATCH_GIVE_UP_MS = 24 * 3600_000;
export const LATE_WATCH_SWEEP_PER_TICK = 25;
const EMPTY = Object.freeze({ watches: {} });

export const lateWatchKey = (auth) => createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);

export function createLateWatchLedger({
  doc = createJsonDocument({ name: LATE_WATCH_DOC, file: process.env.TEMPO_LATE_WATCH_FILE || null, log: () => {} }),
  now = Date.now,
  log = console.warn,
} = {}) {
  const running = new Set(); // keys a live watch on this process owns
  const counts = { recorded: 0, recordFailed: 0, dropped: 0, sweptLanded: 0, sweptAbsent: 0, sweptFailed: 0, gaveUp: 0 };

  /** Write an entry before its watch starts. Resolves false when nothing was stored. */
  async function record(key, entry) {
    let r = null;
    // The update callback can run more than once (a write conflict retries
    // it), so what it dropped is counted and logged once, after the write.
    let droppedNow = 0;
    try {
      r = await doc.update((b) => {
        droppedNow = 0;
        const watches = { ...((b && b.watches) || {}) };
        watches[key] = entry;
        const keys = Object.keys(watches);
        if (keys.length > LATE_WATCH_KEEP_MAX) {
          keys.sort((a, c) => (Number(watches[a]?.startedAt) || 0) - (Number(watches[c]?.startedAt) || 0));
          for (const k of keys.slice(0, keys.length - LATE_WATCH_KEEP_MAX)) { delete watches[k]; droppedNow++; }
        }
        return { ...(b || {}), watches };
      }, { fallback: EMPTY });
    } catch { r = null; }
    if (r?.ok && droppedNow) {
      counts.dropped += droppedNow;
      log(`[mpp-tempo] ERROR late-landing watch list is full (${LATE_WATCH_KEEP_MAX}): ${droppedNow} oldest entr${droppedNow === 1 ? "y was" : "ies were"} dropped unread`);
    }
    if (r?.ok) counts.recorded++;
    else { counts.recordFailed++; log("[mpp-tempo] late-landing watch could not be recorded; it runs in this process only"); }
    return !!r?.ok;
  }

  async function remove(key) {
    try {
      await doc.update((b) => {
        if (!b?.watches?.[key]) return SKIP_UPDATE;
        const watches = { ...b.watches };
        delete watches[key];
        return { ...b, watches };
      }, { fallback: EMPTY });
    } catch { /* the next sweep reads it again; booking is idempotent */ }
  }

  /**
   * One pass: every stored entry this process does not own, whose last delay
   * plus the grace has passed, read once (oldest first, at most perTick).
   * `confirm(auth, { trace })` resolves { txId, amountAtomic } when the
   * transfer landed and null otherwise; a null with trace.error set is a read
   * that failed (src/tempo-confirm.js never throws), so the entry is kept.
   */
  async function sweep({ confirm, book, perTick = LATE_WATCH_SWEEP_PER_TICK } = {}) {
    const out = { read: 0, landed: 0, absent: 0, failed: 0, gaveUp: 0, waiting: 0 };
    if (typeof confirm !== "function" || typeof book !== "function") return out;
    let r;
    try { r = await doc.read(); } catch { return out; }
    if (!r?.ok) return out;
    const t = now();
    const entries = Object.entries((r.body && r.body.watches) || {})
      .filter(([k]) => !running.has(k))
      .sort(([, a], [, c]) => (Number(a?.startedAt) || 0) - (Number(c?.startedAt) || 0));
    for (const [key, e] of entries) {
      if (out.read >= perTick) break;
      const startedAt = Number(e?.startedAt) || 0;
      if (t < startedAt + (Number(e?.lastDelayMs) || 0) + LATE_WATCH_GRACE_MS) { out.waiting++; continue; }
      out.read++;
      let found = null;
      const trace = {};
      let readFailed = false;
      try { found = await confirm(e.auth, { attempts: 1, delayMs: 0, trace }); } catch { readFailed = true; }
      if (!found?.txId && trace.error) readFailed = true;
      if (readFailed) {
        out.failed++; counts.sweptFailed++;
        if (t - startedAt > LATE_WATCH_GIVE_UP_MS) {
          out.gaveUp++; counts.gaveUp++;
          log(`[mpp-tempo] ERROR late-landing watch for ${e.method || "?"} ${e.path || "?"} could not read the chain for ${Math.round(LATE_WATCH_GIVE_UP_MS / 3600_000)} h; dropped without an answer`);
          await remove(key);
        }
        continue;
      }
      if (found?.txId) {
        let booked = false;
        try { booked = (await book(e, found)) === true; } catch { booked = false; }
        if (!booked) { out.failed++; counts.sweptFailed++; continue; } // kept: read and booked again next tick
        out.landed++; counts.sweptLanded++;
      } else { out.absent++; counts.sweptAbsent++; }
      await remove(key);
    }
    return out;
  }

  return {
    record, remove, sweep,
    own: (key) => { running.add(key); },
    release: (key) => { running.delete(key); },
    stats: () => ({ ...counts, runningHere: running.size }),
    _doc: doc,
  };
}

export const LATE_WATCH_SWEEP_INTERVAL_MS = 60_000;
const LATE_WATCH_SWEEP_LEASE = "tempo-late-watch-sweep";
let sweepTimer = null;
/** Start the sweep under its lease, once per process. `sweepOnce()` is the
 *  gate's sweepLateWatches (it holds the booking path). */
export function startLateWatchSweep({ sweepOnce, intervalMs = LATE_WATCH_SWEEP_INTERVAL_MS } = {}) {
  if (sweepTimer || typeof sweepOnce !== "function") return null;
  sweepTimer = "starting";
  const ready = (async () => {
    const [{ leased }, { contained }] = await Promise.all([import("./state-db.js"), import("./contained-turn.js")]);
    const tick = leased(LATE_WATCH_SWEEP_LEASE, { ttlMs: Math.max(intervalMs * 2, 120_000) }, () => sweepOnce());
    sweepTimer = setInterval(contained(LATE_WATCH_SWEEP_LEASE, () => tick().catch(() => {})), intervalMs);
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  })().catch((e) => { sweepTimer = null; console.warn(`[mpp-tempo] late-landing sweep did not start: ${String(e?.message || e).slice(0, 120)}`); });
  return ready;
}
