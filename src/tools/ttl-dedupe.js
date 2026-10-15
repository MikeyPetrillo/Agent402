// In-process TTL cache with in-flight dedupe, for upstream reads that share
// one rate budget.
//
// src/cache.js is the ROUTE cache: Redis, keyed on a route's inputs, and by
// its security invariant only for free routes. The reads this module serves
// sit below a paid handler (a universe-wide market document, a search page)
// and are the same bytes for every buyer, so they are cached where they are
// fetched, before any buyer-specific shaping, and never through the route
// cache.
//
// Two rules:
//   * only a SUCCESS is stored. A refusal or an outage is never cached; the
//     next call tries again.
//   * concurrent misses for one key share one upstream request. Without it a
//     burst of N calls in the same instant spends N requests of the shared
//     budget before the first answer lands, which is exactly the burst that
//     trips an upstream's per-IP cap.
//
// Bounded: the oldest entry is evicted past `maxEntries` (Map insertion order).

export function createTtlCache({ maxEntries = 256, now = () => Date.now() } = {}) {
  const store = new Map(); // key -> { at, ttlMs, value }
  const inflight = new Map(); // key -> Promise<value>
  let stats = { hits: 0, misses: 0, joined: 0 };

  function fresh(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (now() - hit.at >= hit.ttlMs) { store.delete(key); return null; }
    return hit;
  }

  function put(key, value, ttlMs) {
    if (store.has(key)) store.delete(key);
    while (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
    store.set(key, { at: now(), ttlMs, value });
  }

  /**
   * The cached value for `key`, or `loader()`'s. Resolves to
   * { value, cached, ageMs }: `cached` is true when this call spent no
   * upstream request (a stored hit, or a join onto a request already in
   * flight), and `ageMs` is how old the stored value is (0 for a fresh read).
   * A ttlMs of 0 or less bypasses the store but still dedupes in-flight calls.
   */
  async function get(key, ttlMs, loader) {
    const hit = ttlMs > 0 ? fresh(key) : null;
    if (hit) { stats.hits++; return { value: hit.value, cached: true, ageMs: Math.max(0, now() - hit.at) }; }
    const pending = inflight.get(key);
    if (pending) { stats.joined++; const value = await pending; return { value, cached: true, ageMs: 0 }; }
    stats.misses++;
    const p = (async () => loader())();
    inflight.set(key, p);
    try {
      const value = await p;
      if (ttlMs > 0) put(key, value, ttlMs);
      return { value, cached: false, ageMs: 0 };
    } finally {
      if (inflight.get(key) === p) inflight.delete(key);
    }
  }

  return {
    get,
    clear() { store.clear(); inflight.clear(); stats = { hits: 0, misses: 0, joined: 0 }; },
    size: () => store.size,
    inflightSize: () => inflight.size,
    stats: () => ({ ...stats }),
  };
}
