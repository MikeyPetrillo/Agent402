// Pluggable stats sinks for the tollbooth — turn the in-memory counter into
// something that survives restart and aggregates across processes / isolates.
//
// A sink is just:
//   {
//     incr(field, n=1)   // fire-and-forget; sync from the gate's perspective
//     flush()            // optional — run at end of request via ctx.waitUntil
//     snapshot()         // returns the aggregated counts as { field: number, ... }
//   }
//
// Shipped sinks:
//   memorySink()                       — default, in-process, zero config.
//   kvStatsSink(kv, opts)              — Cloudflare KV (append-only, eventually consistent).
//   httpStatsSink(url, opts)           — POST batched deltas to any collector.
//
// Want strong consistency on Cloudflare? Back it with a Durable Object that
// implements the same { incr, snapshot } interface and pass it as `statsSink`.

const KNOWN_FIELDS = ["requests", "freeAllowed", "wouldCharge", "charged", "powSolved", "x402Paid"];
const ZERO = () => Object.fromEntries(KNOWN_FIELDS.map((k) => [k, 0]));

// Filter an untrusted JSON blob (KV value or HTTP collector response) to only
// the known numeric counters. Prevents a compromised store from injecting
// arbitrary keys or non-numeric values that downstream renderers (e.g.
// dashboard.js) might treat as HTML. Defense in depth — the dashboard also
// coerces, but trim at the boundary.
const sanitize = (obj) => {
  const out = ZERO();
  if (!obj || typeof obj !== "object") return out;
  for (const k of KNOWN_FIELDS) {
    const v = Number(obj[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  if (typeof obj.since === "string" && obj.since.length < 64) out.since = obj.since;
  return out;
};

/** In-process counter. Synchronous; loses state on restart. */
export function memorySink() {
  const c = { since: new Date().toISOString(), ...ZERO() };
  return {
    incr(field, n = 1) { c[field] = (c[field] || 0) + n; },
    flush() { return Promise.resolve(); },
    snapshot() { return { ...c }; },
  };
}

/**
 * Cloudflare KV-backed sink. Writes are append-only delta records under
 * `tb:stats:${bucket}:*`; snapshot lists + sums them. Bounded by `ttlSeconds`.
 *
 * Pattern notes:
 *  - Cloudflare Workers don't run timers between requests. The gate calls
 *    `incr()` synchronously into an in-isolate buffer; the Worker entry must
 *    call `flush()` (typically inside `ctx.waitUntil(...)`) so the buffered
 *    delta becomes a KV write. Without that, deltas stay in isolate memory
 *    and die with the isolate.
 *  - KV has no atomic increment, so we never RMW a shared counter. Each
 *    flush writes a brand-new key (unique id + ts) — concurrent isolates
 *    can't lose each other's deltas. Snapshot sums every key under the prefix.
 *  - Tradeoff: snapshot reads list+get every key, which is fine for low traffic
 *    (deltas batched per request) but expensive for very high traffic. For
 *    that, back with a Durable Object instead.
 */
export function kvStatsSink(kv, { bucket = "default", ttlSeconds = 60 * 60 * 24 * 30 } = {}) {
  const prefix = `tb:stats:${bucket}:`;
  const buf = {};
  const isDirty = () => Object.keys(buf).length > 0;
  return {
    incr(field, n = 1) { buf[field] = (buf[field] || 0) + n; },
    flush() {
      if (!isDirty()) return Promise.resolve();
      const payload = { ...buf, _ts: Date.now() };
      for (const k of Object.keys(buf)) delete buf[k];
      const key = prefix + `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return Promise.resolve(kv.put(key, JSON.stringify(payload), { expirationTtl: ttlSeconds })).catch(() => {});
    },
    async snapshot() {
      const result = ZERO();
      let oldest = Infinity;
      let cursor;
      do {
        const page = await kv.list({ prefix, cursor });
        for (const { name } of page.keys) {
          let raw;
          try { raw = await kv.get(name); } catch { continue; }
          if (!raw) continue;
          let obj; try { obj = JSON.parse(raw); } catch { continue; }
          if (typeof obj._ts === "number" && obj._ts < oldest) oldest = obj._ts;
          // Whitelist + numeric coerce: a misconfigured (or compromised) KV
          // entry can't smuggle arbitrary keys or strings into the snapshot.
          for (const k of KNOWN_FIELDS) {
            const v = Number(obj[k]);
            if (Number.isFinite(v) && v >= 0) result[k] = (result[k] || 0) + v;
          }
        }
        cursor = page.cursor;
        if (page.list_complete || !cursor) break;
      } while (cursor);
      if (oldest !== Infinity) result.since = new Date(oldest).toISOString();
      return result;
    },
  };
}

/**
 * HTTP-backed sink. Batched POSTs of `{ incr: { field: n, ... }, ts }`.
 * GET on the same URL returns the aggregated snapshot — wire that up on your
 * collector (a tiny Vercel route hander, an Express app, anything).
 *
 *   incr(): buffers locally and schedules a flush via setTimeout (Node) or
 *           returns immediately on the edge (caller should invoke flush()
 *           inside ctx.waitUntil so the POST survives the response).
 *   flush(): force-send the current buffer right now (used by edge entries).
 *   snapshot(): GET the collector URL.
 *
 * Auth: pass `token` to include `Authorization: Bearer <token>`.
 */
export function httpStatsSink(url, { token, batchMs = 2000, fetchImpl, allowInsecure } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== "function") throw new Error("httpStatsSink: no fetch available (pass fetchImpl or run on Node 18+)");
  // Bearer tokens MUST NOT leak over plaintext. Require HTTPS unless the caller
  // explicitly opts in (loopback dev, in-cluster service mesh that terminates
  // TLS upstream). The token is the only thing protecting the collector from
  // forged stats batches.
  if (token) {
    let proto = "";
    try { proto = new URL(url).protocol; } catch { /* let fetch surface the error later */ }
    if (proto && proto !== "https:" && !allowInsecure) {
      throw new Error("httpStatsSink: refusing to send a bearer token over a non-HTTPS URL. Use https:// or pass { allowInsecure: true } for trusted private networks.");
    }
  }
  const buf = {};
  let timer = null;
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  async function postBuf() {
    timer = null;
    if (Object.keys(buf).length === 0) return;
    const payload = { ...buf };
    for (const k of Object.keys(buf)) delete buf[k];
    try {
      await f(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ incr: payload, ts: Date.now() }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* fire-and-forget: stats loss is acceptable here */ }
  }
  return {
    incr(field, n = 1) {
      buf[field] = (buf[field] || 0) + n;
      // Batched flush. setTimeout works on Node; on the edge the caller should
      // still invoke flush() inside ctx.waitUntil because timers don't fire
      // after the response is returned.
      if (!timer && typeof setTimeout === "function") timer = setTimeout(postBuf, batchMs);
    },
    flush: postBuf,
    async snapshot() {
      try {
        const r = await f(url, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return ZERO();
        // Sanitize at the trust boundary — a compromised or misconfigured
        // collector cannot inject non-numeric values or extra keys that the
        // dashboard would render as HTML.
        return sanitize(await r.json());
      } catch { return ZERO(); }
    },
  };
}
