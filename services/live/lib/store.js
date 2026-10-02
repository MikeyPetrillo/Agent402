// In-memory payment store: the last hour of events (for the live page and its
// replay) plus per-minute rollups for 24 hours of stats. Nothing persists; a
// restart backfills the hour from the chain, so the 24-hour figures cover only
// the time since the start minus an hour until a full day has passed
// (`coverage24hSince`, which the page shows on every 24h figure).
const HOUR = 3600_000, DAY = 24 * HOUR;
const MAX_EVENTS = 30_000;

export function makeStore({ now = () => Date.now() } = {}) {
  const events = [];            // oldest first
  const seen = new Set();       // tx:logIndex
  const minutes = new Map();    // minute -> { x402:{n,usd}, mpp:{n,usd}, sellers: Map(key->{n,usd,chain}) }
  const buyers = new Map();     // chain:payer -> last ts
  const startedAt = now();

  function add(ev) {
    const id = `${ev.chain}:${ev.tx}:${ev.logIndex}`;
    if (seen.has(id)) return false;
    seen.add(id);
    ev.id = id;
    // Keep order by time: backfill arrives newest first beside live events,
    // so insert in place (binary search) rather than re-sort.
    if (!events.length || events[events.length - 1].ts <= ev.ts) events.push(ev);
    else {
      let lo = 0, hi = events.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].ts <= ev.ts) lo = mid + 1; else hi = mid; }
      events.splice(lo, 0, ev);
    }
    const m = Math.floor(ev.ts / 60_000);
    const b = minutes.get(m) || { x402: { n: 0, usd: 0 }, mpp: { n: 0, usd: 0 }, sellers: new Map() };
    b[ev.chain].n++; b[ev.chain].usd += ev.amountUsd;
    const s = b.sellers.get(ev.seller.key) || { n: 0, usd: 0, chain: ev.chain };
    s.n++; s.usd += ev.amountUsd;
    b.sellers.set(ev.seller.key, s);
    minutes.set(m, b);
    const bk = `${ev.chain}:${ev.payer}`;
    buyers.set(bk, Math.max(buyers.get(bk) || 0, ev.ts));
    prune();
    return true;
  }

  function prune() {
    const t = now();
    while (events.length && (t - events[0].ts > HOUR || events.length > MAX_EVENTS)) seen.delete(events.shift().id);
    const cut = Math.floor((t - DAY) / 60_000);
    for (const m of minutes.keys()) if (m < cut) minutes.delete(m);
    if (buyers.size > 200_000) for (const [k, ts] of buyers) if (t - ts > DAY) buyers.delete(k);
  }

  /** Stats for one scope ("x402", "mpp" or "all") over a window. */
  function window(scope, ms, sellerInfo) {
    const t = now(), cut = Math.floor((t - ms) / 60_000);
    let n = 0, usd = 0;
    const bySeller = new Map();
    for (const [m, b] of minutes) {
      if (m < cut) continue;
      for (const c of ["x402", "mpp"]) if (scope === "all" || scope === c) { n += b[c].n; usd += b[c].usd; }
      for (const [k, s] of b.sellers) {
        if (scope !== "all" && s.chain !== scope) continue;
        const e = bySeller.get(k) || { n: 0, usd: 0 };
        e.n += s.n; e.usd += s.usd;
        bySeller.set(k, e);
      }
    }
    let unique = 0;
    for (const [k, ts] of buyers) if (t - ts <= ms && (scope === "all" || k.startsWith(scope + ":"))) unique++;
    const top = [...bySeller.entries()].sort((a, b) => b[1].usd - a[1].usd || b[1].n - a[1].n).slice(0, 8).map(([k, v]) => ({ ...sellerInfo(k), payments: v.n, usd: +v.usd.toFixed(4) }));
    return { payments: n, usd: +usd.toFixed(4), buyers: unique, topSellers: top };
  }

  function perMinute(scope) {
    const t = now(), from = Math.floor(t / 60_000) - 5;
    let n = 0;
    for (const [m, b] of minutes) if (m >= from && m < Math.floor(t / 60_000)) for (const c of ["x402", "mpp"]) if (scope === "all" || scope === c) n += b[c].n;
    return +(n / 5).toFixed(1);
  }

  return {
    add,
    recent: (limit = 5000) => events.slice(-limit),
    stats(sellerInfo) {
      const out = { startedAt, coverage24hSince: Math.max(startedAt - HOUR, now() - DAY) };
      for (const scope of ["all", "x402", "mpp"]) out[scope] = { perMinute: perMinute(scope), h1: window(scope, HOUR, sellerInfo), h24: window(scope, DAY, sellerInfo) };
      return out;
    },
    size: () => events.length,
  };
}
