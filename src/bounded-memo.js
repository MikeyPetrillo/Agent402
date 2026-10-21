// A bounded, single-flight memo for caller-keyed surfaces.
//
// surfaceMemo in server.js holds a fixed set of keys and never evicts, which
// is right for it and wrong for any key a caller chooses: one entry per
// distinct value would grow without limit. This memo holds at most `max`
// entries AND at most `maxBytes` of values (by `sizeOf`, string length by
// default), evicting the least recently used entry past either bound. A value
// larger than `maxBytes` on its own is returned to its callers and not kept.
//
// Per key:
//   - a fresh value is returned at once;
//   - a stale value is returned at once and ONE rebuild runs behind it
//     (stale-while-rebuild), if `admit()` allows a build right now;
//   - a miss joins the build already running for that key, if there is one,
//     so concurrent callers share one build;
//   - otherwise a miss asks `admit()`; refused, get() resolves to SHED and
//     nothing is built. Only builds count against admission: hits and joins
//     never do.
// A failed build is not cached; the previous value (if any) stays.
// A value the builder marks partial (isPartial) lives `partialTtlMs` at most.

export const SHED = Symbol("bounded-memo-shed");

const defaultSizeOf = (v) => (typeof v === "string" ? v.length : 0);

export function createBoundedMemo({ max = 256, maxBytes = Infinity, sizeOf = defaultSizeOf, ttlMs = 60_000, partialTtlMs = 2_000, isPartial = () => false, onError = null } = {}) {
  const cap = Math.max(1, Math.floor(Number(max)) || 1);
  const byteCap = Number(maxBytes) > 0 ? Number(maxBytes) : Infinity;
  let bytes = 0;
  const entries = new Map(); // key -> { at, value, partial, size } in LRU order (oldest first)
  const pending = new Map(); // key -> Promise of the build in progress
  const stats = { builds: 0, hits: 0, stale: 0, joins: 0, shed: 0, evictions: 0, failures: 0 };

  const fresh = (e, now) => now - e.at < (e.partial ? Math.min(ttlMs, partialTtlMs) : ttlMs);
  const touch = (key, e) => { entries.delete(key); entries.set(key, e); };
  const drop = (key) => { const e = entries.get(key); if (e) { bytes -= e.size; entries.delete(key); } };
  const store = (key, e) => {
    drop(key);
    if (e.size > byteCap) return;
    entries.set(key, e);
    bytes += e.size;
    while (entries.size > cap || bytes > byteCap) { drop(entries.keys().next().value); stats.evictions++; }
  };
  const start = (key, build) => {
    stats.builds++;
    // build() starts synchronously (a caller's admission gauge sees it at
    // once); the pending entry is cleared in a .finally, which always runs on
    // a later turn, so it never outlives a build that threw synchronously.
    const p = (async () => {
      try {
        const partial = !!isPartial();
        const value = await build();
        store(key, { at: Date.now(), value, partial, size: Math.max(0, Number(sizeOf(value)) || 0) });
        return value;
      } catch (e) {
        stats.failures++;
        throw e;
      }
    })().finally(() => { if (pending.get(key) === p) pending.delete(key); });
    pending.set(key, p);
    return p;
  };

  return {
    /** The value for `key`, building it with `build()` when needed; SHED when
     *  a build was needed and `admit()` refused it. */
    async get(key, build, { admit = () => true } = {}) {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && fresh(hit, now)) { stats.hits++; touch(key, hit); return hit.value; }
      if (hit) {
        stats.stale++;
        touch(key, hit);
        if (!pending.has(key) && admit()) {
          start(key, build).catch((e) => { if (onError) onError(key, e); });
        }
        return hit.value;
      }
      const running = pending.get(key);
      if (running) { stats.joins++; return running; }
      if (!admit()) { stats.shed++; return SHED; }
      return start(key, build);
    },
    size: () => entries.size,
    bytes: () => bytes,
    pendingSize: () => pending.size,
    max: cap,
    has: (key) => entries.has(key),
    stats: () => ({ ...stats, size: entries.size, bytes, pending: pending.size, max: cap, maxBytes: Number.isFinite(byteCap) ? byteCap : null }),
    clear() { entries.clear(); bytes = 0; },
  };
}
