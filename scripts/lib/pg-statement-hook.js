// Intercept every statement the state database runs on a pool, on BOTH paths a
// statement can take: pool.query(), and query() on a client checked out with
// pool.connect(). stateQuery runs each statement on a checked-out client under
// its own read timer (src/state-db.js, pooledQuery), so a test hook on
// pool.query alone sees only the pool's other callers and never the store's
// own reads and writes.
//
//   const unhook = hookStatements(pool, async (sql, values, run) => {
//     if (/UPDATE .*records/.test(sql)) await somethingFirst();
//     const r = await run();            // the driver's own promise
//     if (armed(sql)) throw lost();     // or fail the caller after it landed
//     return r;
//   });
//
// `around(sql, values, run)` wraps one promise-style statement: call run() to
// execute it and return its result, or act before or after. Callback-style
// statements pass through untouched (the driver's own timer handles them).
// Hooks layer: a later hookStatements wraps the earlier one, and its unhook()
// puts the earlier one back.
export function hookStatements(pool, around) {
  const origQuery = pool.query;
  const origConnect = pool.connect;
  const sqlOf = (t) => (typeof t === "string" ? t : String(t?.text || ""));
  const valuesOf = (t, v) => (Array.isArray(v) ? v : Array.isArray(t?.values) ? t.values : []);
  pool.query = function hookedPoolQuery(text, values, cb) {
    if (typeof values === "function" || typeof cb === "function") return origQuery.call(this, text, values, cb);
    return around(sqlOf(text), valuesOf(text, values), () => origQuery.call(this, text, values));
  };
  pool.connect = function hookedConnect(...a) {
    if (typeof a[0] === "function") return origConnect.apply(this, a);
    return origConnect.apply(this, a).then((client) => {
      const oq = client.query;
      const rel = client.release;
      client.query = function hookedClientQuery(cfg, v, cb) {
        if (typeof v === "function" || typeof cb === "function") return oq.call(this, cfg, v, cb);
        return around(sqlOf(cfg), valuesOf(cfg, v), () => oq.call(this, cfg, v));
      };
      client.release = function (e) { client.query = oq; client.release = rel; return rel.call(this, e); };
      return client;
    });
  };
  return () => { pool.query = origQuery; pool.connect = origConnect; };
}
