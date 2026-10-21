// Router worker thread (the other half of src/router-pool.js).
//
// Imports the index module itself, so the scoring code is the same code the
// main thread runs, and holds a replica of every store a route query reads.
// The main thread ships the stores as deltas (a crawl's cache.set, a Bazaar
// refresh, a succession, the circular wallet set, the removals flag, the
// delivery observations) and queries as messages; each query runs the
// synchronous routeQuery here and answers with the result and the time it
// held this thread, which the main thread charges to its CPU budgets.
//
// Nothing here fetches, persists or crawls: the pool's env for this thread
// turns the crawler off and points every file-backed store at a scratch
// directory, and the replica flag makes the two reads that would consult
// this thread's own (empty) state read the shipped values instead.
import "./tls-distrust-boot.js"; // refuse TLS chains through a distrusted intermediate CA
import { parentPort } from "node:worker_threads";

const xi = await import("./x402-index.js");
const obs = await import("./response-observation.js");

const replica = { removalsKnown: false, circular: { wallets: new Set(), version: "replica:0" } };
xi._installRouterReplica(replica);

// One catalog object per shipped id, so the index module's identity-keyed
// local-pool memo works here as it does on the main thread.
const catalogs = new Map(); // id -> { catalog, prices }
const CATALOG_MAX = 8;
// Scored-ranking memos by the main thread's memo id (one /api/route call
// scores once for its page and its shortlist).
const memos = new Map(); // id -> memo object
const MEMO_MAX = 32;
const testHooks = process.env.ROUTER_WORKER_TEST_HOOKS === "1";

function post(m) { parentPort.postMessage(m); }

function runQuery(m) {
  const t0 = performance.now();
  post({ t: "started", id: m.id });
  try {
    if (testHooks && m.args && m.args.__testHangMs) {
      const until = performance.now() + Number(m.args.__testHangMs);
      while (performance.now() < until) { /* a hung worker, on purpose */ }
    }
    const { catalogId, memoId, __testHangMs, ...rest } = m.args || {};
    const cat = catalogId != null ? catalogs.get(catalogId) : null;
    let memo = null;
    if (memoId != null) {
      memo = memos.get(memoId);
      if (!memo) {
        if (memos.size >= MEMO_MAX) memos.delete(memos.keys().next().value);
        memo = {};
        memos.set(memoId, memo);
      }
    }
    const result = xi.routeQuery({ ...rest, catalog: cat ? cat.catalog : undefined, prices: cat ? cat.prices : undefined, scoredMemo: memo });
    post({ t: "result", id: m.id, result, busyMs: performance.now() - t0 });
  } catch (e) {
    post({ t: "error", id: m.id, message: String(e?.message || e), statusCode: e?.statusCode, busyMs: performance.now() - t0 });
  }
}

parentPort.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  switch (m.t) {
    case "cache":
    case "bazaarTools":
    case "bazaarQuality":
    case "state":
      xi._routerReplicaApply(m);
      if (m.t === "state" && Array.isArray(m.observations)) obs.applyObservationsSnapshot(m.observations);
      if (m.seq != null) post({ t: "ack", seq: m.seq });
      return;
    case "catalog":
      if (catalogs.size >= CATALOG_MAX) catalogs.delete(catalogs.keys().next().value);
      catalogs.set(m.id, { catalog: m.catalog, prices: m.prices });
      return;
    case "warm": {
      // Build the candidate index now, off any query's clock.
      const t0 = performance.now();
      if (testHooks && Number(process.env.ROUTER_WORKER_TEST_WARM_DELAY_MS) > 0) {
        const until = performance.now() + Number(process.env.ROUTER_WORKER_TEST_WARM_DELAY_MS);
        while (performance.now() < until) { /* a slow load, on purpose */ }
      }
      let n = 0;
      try { n = xi.warmRouteIndex(); } catch { /* the first query builds it instead */ }
      post({ t: "warmed", seq: m.seq, tools: n, ms: Math.round(performance.now() - t0) });
      return;
    }
    case "query":
      runQuery(m);
      return;
    case "stats": {
      const mem = process.memoryUsage();
      post({ t: "stats", id: m.id, heapUsedMb: Math.round(mem.heapUsed / 1048576), rssMb: Math.round(mem.rss / 1048576), cacheSize: xi._cacheForTests().size, routeIndex: xi._routeIndexStatsForTest() });
      return;
    }
    case "__testCrash":
      if (testHooks) throw new Error("router worker test crash");
      return;
    default:
      return;
  }
});

post({ t: "ready" });
