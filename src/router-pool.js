// Router worker pool: route queries (/api/route, /api/find's seller bridge,
// the route-execute resolver) score in a worker thread instead of this one.
//
// Why. A route query costs its full CPU even when sliced: on prod a query
// whose words are common in seller descriptions scores tens of thousands of
// rows, 0.5-3 s of CPU, and twenty concurrent ones take turns at the slice
// boundaries so every other request (a paid tool call, /health) waits behind
// the whole burst. The event-loop monitor read "blocked 1388ms". Moving the
// scoring to another thread leaves this one a message post per query.
//
// How. The worker (src/router-worker-thread.js) imports the index module and
// holds a replica of every store a query reads. The index module reports each
// mutation of those stores through `_setRouterReplicaObserver`; the pool
// collects the touched keys and ships their CURRENT values (one message per
// event-loop turn, and synchronously before every query, so a result never
// reads a store older than the caller's own view). Successions, the circular
// wallet set, the removals flag and the delivery observations travel as one
// versioned state message, re-sent only when a version moved. A fresh worker
// gets a full resync in batches with an event-loop turn between them.
//
// Safety. The pool never refuses service: with no loaded worker (pool off,
// worker still importing, resyncing, crashed, queue full) the query runs on
// this thread as before (`routeQueryAsyncInThread`). A worker that crashes is
// replaced, its in-flight queries run here, and a worker that dies young is
// respawned with a growing delay. A query that runs past its deadline in the
// worker fails with a clear error and the worker is recycled; the queries
// behind it run here.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setRouterReplicaObserver, _setRouterOffload, _routerStateVersion, _routerStateSnapshot,
  _routerStoresForReplica, _routerReplicaEntryOf, _routerReplicaQualityOf, routeQueryAsyncInThread,
} from "./x402-index.js";
import { observationsVersion, observationsSnapshot } from "./response-observation.js";

const WORKER_FILE = fileURLToPath(new URL("./router-worker-thread.js", import.meta.url));
const envInt = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : d; };
/** Workers configured: ROUTER_WORKERS (default 1; 0 or "off" keeps queries on this thread).
 *  With the crawler off the index holds nothing a worker could serve, so the
 *  default there is 0 unless ROUTER_WORKERS is set. */
export function configuredRouterWorkers(env = process.env) {
  const raw = String(env.ROUTER_WORKERS ?? "").trim().toLowerCase();
  if (raw === "off") return 0;
  if (raw === "") return String(env.X402_INDEX_CRAWL || "").toLowerCase() === "off" ? 0 : 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 4) : 1;
}
let deadlineMs = envInt("ROUTER_QUERY_DEADLINE_MS", 10_000) || 10_000;
const QUEUE_MAX = envInt("ROUTER_QUEUE_MAX", 256) || 256;
const SYNC_BATCH_ENTRIES = 200; // cache entries per resync message
const SYNC_BATCH_ROWS = 1000; // Bazaar map rows per resync message
const YOUNG_DEATH_MS = 30_000; // a worker that dies this soon after loading is respawned with backoff
const BACKOFF_MAX_MS = 60_000;

const workers = []; // live worker records
let enabled = false;
let wanted = 0; // workers the pool keeps alive once started
let nextWorkerId = 0;
let nextJobId = 0;
let nextCatalogId = 0;
const catalogIds = new WeakMap(); // catalog object -> { id, prices, keys }
const memoIds = new WeakMap(); // scoredMemo object -> id
let nextMemoId = 0;
let scratchDir = null;
let respawnBackoffMs = 0;
let respawnTimer = null;
const loadWaiters = [];
const stats = { served: { worker: 0, inThread: 0 }, fallbacks: 0, queueFull: 0, deadlines: 0, crashes: 0, restarts: 0, cloneMs: 0, cloneFailures: 0, resyncs: 0, lastResyncMs: 0, busyMs: 0 };

const yieldToLoop = () => new Promise((r) => setImmediate(r));

// --- shipping helpers -------------------------------------------------------
/** A deep copy with functions and symbols left out: what a catalog entry or a
 *  price table looks like once it can cross a thread boundary. */
function plainClone(v, depth = 0) {
  if (v === null || typeof v !== "object") return typeof v === "function" || typeof v === "symbol" ? undefined : v;
  if (depth > 12) return undefined;
  if (Array.isArray(v)) return v.map((x) => plainClone(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    const c = plainClone(v[k], depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}
// The catalog fields buildLocalEntry (src/x402-index.js) reads; nothing else
// about a local tool reaches a route result.
const CATALOG_KEYS = ["route", "slug", "name", "description", "aliases", "category", "tags", "price"];
function slimCatalog(catalog) {
  const out = {};
  for (const [route, def] of Object.entries(catalog)) {
    const row = {};
    if (def && typeof def === "object") for (const k of CATALOG_KEYS) if (def[k] !== undefined) row[k] = plainClone(def[k]);
    out[route] = row;
  }
  return out;
}
function workerEnv() {
  const env = { ...process.env };
  // The worker holds a replica; it never reads or writes a store of its own.
  delete env.STATE_DATABASE_URL;
  delete env.REDIS_URL;
  delete env.LEDGER_JOURNAL_REDIS;
  env.X402_INDEX_CRAWL = "off";
  env.ROUTER_WORKERS = "0";
  env.AGENT402_ROUTER_WORKER = "1";
  // A module the worker imports must never refuse to load for lack of a
  // durable store: production has no /data volume, and the worker is denied
  // the state database above, so a module-level "no persistent volume" guard
  // (pow, stats, memory) would process.exit the worker on import, every time,
  // and queries would run on the main thread forever. The worker serves no
  // request, so none of those stores holds anything here.
  env.STATS_ALLOW_EPHEMERAL = "true";
  env.POW_ALLOW_EPHEMERAL = "true";
  env.MEMORY_ALLOW_EPHEMERAL = "true";
  if (!scratchDir) { try { scratchDir = mkdtempSync(join(tmpdir(), "a402-router-worker-")); } catch { scratchDir = tmpdir(); } }
  env.STATS_DB_DIR = scratchDir;
  return env;
}

// --- worker records ---------------------------------------------------------
function newRecord() {
  return {
    id: ++nextWorkerId, worker: null, state: "starting", // starting | syncing | loaded | dead
    gen: 0, seq: 0, loadSeq: 0, inflight: new Map(), catalogs: new Set(),
    pending: { cache: { clear: false, keys: new Set() }, bazaarTools: { clear: false, keys: new Set() }, bazaarQuality: { clear: false, keys: new Set() } },
    flushScheduled: false, shipped: { successions: -1, circular: null, removalsKnown: null, observations: -1 },
    lastProgressAt: 0, loadedAt: 0, spawnedAt: Date.now(), served: 0,
  };
}

function observe(kind, op, key) {
  for (const w of workers) {
    if (w.state === "dead") continue;
    const p = w.pending[kind];
    if (!p) continue;
    if (op === "clear") { p.clear = true; p.keys.clear(); }
    else p.keys.add(key);
    if (w.state === "loaded") scheduleFlush(w);
  }
}
function scheduleFlush(w) {
  if (w.flushScheduled) return;
  w.flushScheduled = true;
  setImmediate(() => { w.flushScheduled = false; if (w.state === "loaded") flushPending(w); });
}
/** Ship every touched key's current value to one worker, now. */
function flushPending(w) {
  const stores = _routerStoresForReplica();
  for (const kind of ["cache", "bazaarTools", "bazaarQuality"]) {
    const p = w.pending[kind];
    if (!p.clear && !p.keys.size) continue;
    const store = stores[kind];
    const set = [], del = [];
    for (const k of p.keys) {
      const v = store.get(k);
      if (v === undefined) del.push(k);
      else set.push([k, kind === "cache" ? _routerReplicaEntryOf(v) : kind === "bazaarQuality" ? _routerReplicaQualityOf(v) : v]);
    }
    const msg = { t: kind, clear: p.clear, del, set };
    p.clear = false; p.keys.clear();
    postStore(w, msg);
  }
}
/** postMessage with the clone timed, and an entry that cannot be cloned
 *  (something non-plain in a crawled document) re-sent through JSON. */
function postStore(w, msg) {
  const t0 = performance.now();
  try { w.worker.postMessage(msg); }
  catch (e) {
    const set = [];
    for (const [k, v] of msg.set || []) {
      try { set.push([k, JSON.parse(JSON.stringify(v))]); }
      catch { stats.cloneFailures++; }
    }
    try { w.worker.postMessage({ ...msg, set }); } catch (e2) { stats.cloneFailures++; }
  }
  stats.cloneMs += performance.now() - t0;
}
/** The versioned state parts, sent when a version moved (or all, on `force`). */
function syncState(w, force = false) {
  const ver = _routerStateVersion();
  const obsVer = observationsVersion();
  const msg = { t: "state" };
  let any = false;
  if (force || w.shipped.successions !== ver.successions || w.shipped.circular !== ver.circular || w.shipped.removalsKnown !== ver.removalsKnown) {
    const snap = _routerStateSnapshot();
    Object.assign(msg, snap);
    w.shipped.successions = ver.successions; w.shipped.circular = ver.circular; w.shipped.removalsKnown = ver.removalsKnown;
    any = true;
  }
  if (force || w.shipped.observations !== obsVer) {
    msg.observations = observationsSnapshot();
    w.shipped.observations = obsVer;
    any = true;
  }
  if (any) postStore(w, msg);
}

async function resync(w) {
  w.state = "syncing";
  const gen = ++w.gen;
  const t0 = performance.now();
  stats.resyncs++;
  const stores = _routerStoresForReplica();
  const live = () => w.gen === gen && w.state === "syncing";
  // Origins listed once; each batch reads the CURRENT entry, so a crawl that
  // lands mid-sync is carried whether it came before or after its batch.
  const origins = [...stores.cache.keys()];
  for (let i = 0; i < origins.length; i += SYNC_BATCH_ENTRIES) {
    const set = [];
    for (const o of origins.slice(i, i + SYNC_BATCH_ENTRIES)) {
      const v = stores.cache.get(o);
      if (v !== undefined) set.push([o, _routerReplicaEntryOf(v)]);
    }
    postStore(w, { t: "cache", set });
    await yieldToLoop();
    if (!live()) return;
  }
  for (const kind of ["bazaarTools", "bazaarQuality"]) {
    const keys = [...stores[kind].keys()];
    for (let i = 0; i < keys.length; i += SYNC_BATCH_ROWS) {
      const set = [];
      for (const k of keys.slice(i, i + SYNC_BATCH_ROWS)) {
        const v = stores[kind].get(k);
        if (v !== undefined) set.push([k, kind === "bazaarQuality" ? _routerReplicaQualityOf(v) : v]);
      }
      postStore(w, { t: kind, set });
      await yieldToLoop();
      if (!live()) return;
    }
  }
  syncState(w, true);
  w.loadSeq = ++w.seq;
  w.worker.postMessage({ t: "warm", seq: w.loadSeq });
  stats.lastResyncMs = Math.round(performance.now() - t0);
}

function markLoaded(w) {
  if (w.state !== "syncing") return;
  w.state = "loaded";
  w.loadedAt = Date.now();
  w.lastProgressAt = Date.now();
  respawnBackoffMs = 0;
  flushPending(w); // whatever moved while it synced
  while (loadWaiters.length) loadWaiters.shift()();
}

function spawn() {
  const w = newRecord();
  workers.push(w);
  let worker;
  try { worker = new Worker(WORKER_FILE, { env: workerEnv() }); }
  catch (e) {
    workers.splice(workers.indexOf(w), 1);
    console.warn(`[router-pool] worker spawn failed: ${String(e?.message || e).slice(0, 160)}`);
    scheduleRespawn();
    return null;
  }
  w.worker = worker;
  worker.unref(); // in-flight queries hold the loop through their deadline timers
  worker.on("message", (m) => onMessage(w, m));
  worker.on("error", (e) => { console.warn(`[router-pool] worker ${w.id} error: ${String(e?.message || e).slice(0, 160)}`); });
  worker.on("exit", (code) => onExit(w, code));
  return w;
}

function onMessage(w, m) {
  if (!m || typeof m !== "object" || w.state === "dead") return;
  switch (m.t) {
    case "ready":
      resync(w).catch((e) => { console.warn(`[router-pool] resync failed: ${String(e?.message || e).slice(0, 160)}`); recycle(w, "resync-failed"); });
      return;
    case "warmed":
      if (m.seq === w.loadSeq) {
        markLoaded(w);
        console.log(`[router-pool] worker ${w.id} loaded: ${m.tools} tools indexed in ${m.ms} ms, resync ${stats.lastResyncMs} ms (${Math.round(stats.cloneMs)} ms cloning so far)`);
      }
      return;
    case "started": {
      const job = w.inflight.get(m.id);
      w.lastProgressAt = Date.now();
      if (job) job.started = true;
      return;
    }
    case "result": {
      const job = w.inflight.get(m.id);
      w.lastProgressAt = Date.now();
      if (!job) return;
      w.inflight.delete(m.id);
      clearTimeout(job.timer);
      w.served++; stats.served.worker++; stats.busyMs += m.busyMs || 0;
      try { if (job.opts?.onBusy) job.opts.onBusy(m.busyMs || 0); } catch { /* a meter never fails a query */ }
      job.resolve(m.result);
      return;
    }
    case "error": {
      const job = w.inflight.get(m.id);
      w.lastProgressAt = Date.now();
      if (!job) return;
      w.inflight.delete(m.id);
      clearTimeout(job.timer);
      try { if (job.opts?.onBusy) job.opts.onBusy(m.busyMs || 0); } catch { /* see above */ }
      const err = new Error(m.message || "router query failed in the worker");
      if (m.statusCode) err.statusCode = m.statusCode;
      job.reject(err);
      return;
    }
    case "stats":
      if (statsWaiters.has(m.id)) { statsWaiters.get(m.id)(m); statsWaiters.delete(m.id); }
      return;
    default:
      return;
  }
}

/** Every query this worker holds runs on this thread instead. */
function failOver(w, reason) {
  for (const job of w.inflight.values()) {
    clearTimeout(job.timer);
    stats.fallbacks++;
    job.resolve(routeQueryAsyncInThread(job.args, job.opts));
  }
  w.inflight.clear();
  if (reason) console.warn(`[router-pool] worker ${w.id} ${reason}: queries run on the main thread until a worker is loaded`);
}

function onExit(w, code) {
  if (w.state === "dead") return;
  const wasLoaded = w.state === "loaded";
  w.state = "dead";
  stats.crashes++;
  failOver(w, `exited (code ${code})`);
  workers.splice(workers.indexOf(w), 1);
  if (!enabled) return;
  // A worker that never loaded, or died soon after, is respawned with backoff
  // (a repeating crash must not become a spawn loop); a long-lived one at once.
  if (!wasLoaded || Date.now() - w.loadedAt < YOUNG_DEATH_MS) respawnBackoffMs = Math.min(BACKOFF_MAX_MS, respawnBackoffMs ? respawnBackoffMs * 2 : 1000);
  else respawnBackoffMs = 0;
  scheduleRespawn();
}
function scheduleRespawn() {
  if (respawnTimer || !enabled) return;
  respawnTimer = setTimeout(() => {
    respawnTimer = null;
    if (!enabled) return;
    while (workers.length < wanted) { stats.restarts++; if (!spawn()) break; }
  }, respawnBackoffMs);
  respawnTimer.unref?.();
}
function recycle(w, reason) {
  if (w.state === "dead") return;
  const wasLoaded = w.state === "loaded";
  w.state = "dead";
  failOver(w, reason);
  workers.splice(workers.indexOf(w), 1);
  try { w.worker.terminate(); } catch { /* already gone */ }
  if (!enabled) return;
  if (!wasLoaded) respawnBackoffMs = Math.min(BACKOFF_MAX_MS, respawnBackoffMs ? respawnBackoffMs * 2 : 1000);
  scheduleRespawn();
}

// --- queries ----------------------------------------------------------------
function pickWorker() {
  let best = null;
  for (const w of workers) {
    if (w.state !== "loaded") continue;
    if (!best || w.inflight.size < best.inflight.size) best = w;
  }
  return best;
}
function ensureCatalog(w, catalog, prices) {
  if (!catalog || typeof catalog !== "object") return null;
  const keys = Object.keys(catalog).length;
  let rec = catalogIds.get(catalog);
  if (!rec || rec.prices !== prices || rec.keys !== keys) { rec = { id: ++nextCatalogId, prices, keys }; catalogIds.set(catalog, rec); }
  if (!w.catalogs.has(rec.id)) {
    if (w.catalogs.size >= 8) w.catalogs.delete(w.catalogs.values().next().value); // mirrors the worker's eviction
    w.catalogs.add(rec.id);
    postStore(w, { t: "catalog", id: rec.id, catalog: slimCatalog(catalog), prices: plainClone(prices) });
  }
  return rec.id;
}
function memoIdOf(memo) {
  if (!memo || typeof memo !== "object") return null;
  let id = memoIds.get(memo);
  if (id == null) { id = ++nextMemoId; memoIds.set(memo, id); }
  return id;
}
function armDeadline(job) {
  job.timer = setTimeout(() => onDeadline(job), deadlineMs);
}
function onDeadline(job) {
  const w = job.w;
  if (w.state === "dead" || !w.inflight.has(job.id)) return;
  if (!job.started) {
    // Queued behind others. A worker that is making progress gets to keep its
    // queue; one that has shown none for a whole deadline is hung between
    // queries and is replaced.
    if (Date.now() - w.lastProgressAt < deadlineMs) { armDeadline(job); return; }
    recycle(w, "made no progress for a deadline");
    return;
  }
  // The query itself ran past the deadline: this caller gets the error, the
  // rest run on this thread, and the worker (still inside the query) goes.
  w.inflight.delete(job.id);
  stats.deadlines++;
  const err = new Error(`router query exceeded its ${deadlineMs} ms deadline in the worker; the worker was recycled`);
  err.statusCode = 503;
  err.code = "router_query_deadline";
  job.reject(err);
  recycle(w, `query ${job.id} exceeded ${deadlineMs} ms`);
}
/** The offload installed into routeQueryAsync: a worker's answer, or null to
 *  run on this thread. Rejects only on a deadline or a scoring error. */
function offload(args, opts = {}) {
  if (!enabled) return null;
  const w = pickWorker();
  if (!w) { stats.served.inThread++; return null; }
  if (w.inflight.size >= QUEUE_MAX) { stats.queueFull++; stats.served.inThread++; return null; }
  flushPending(w);
  syncState(w);
  const { catalog, prices, scoredMemo, ...rest } = args || {};
  const shipped = { ...rest, catalogId: ensureCatalog(w, catalog, prices), memoId: memoIdOf(scoredMemo) };
  const id = ++nextJobId;
  return new Promise((resolve, reject) => {
    const job = { id, w, args, opts, resolve, reject, started: false, timer: null };
    w.inflight.set(id, job);
    armDeadline(job);
    try { w.worker.postMessage({ t: "query", id, args: shipped }); }
    catch (e) {
      w.inflight.delete(id);
      clearTimeout(job.timer);
      stats.fallbacks++;
      resolve(routeQueryAsyncInThread(args, opts));
    }
  });
}

// --- lifecycle ----------------------------------------------------------------
/** Start the pool (idempotent). Returns the number of workers configured. */
export function startRouterPool({ workers: n = configuredRouterWorkers() } = {}) {
  if (enabled) return workers.length;
  if (!n || process.env.AGENT402_ROUTER_WORKER === "1") return 0;
  enabled = true;
  wanted = n;
  _setRouterReplicaObserver(observe);
  _setRouterOffload(offload);
  for (let i = 0; i < n; i++) spawn();
  console.log(`[router-pool] ${n} router worker(s) starting; queries run on the main thread until one is loaded (deadline ${deadlineMs} ms)`);
  return n;
}
export async function stopRouterPool() {
  enabled = false;
  wanted = 0;
  _setRouterReplicaObserver(null);
  _setRouterOffload(null);
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  const all = workers.splice(0);
  for (const w of all) { w.state = "dead"; failOver(w, null); }
  await Promise.all(all.map((w) => w.worker ? w.worker.terminate().catch(() => {}) : null));
}
export function routerPoolStatus() {
  return {
    enabled,
    configured: configuredRouterWorkers(),
    deadlineMs,
    workers: workers.map((w) => ({ id: w.id, state: w.state, inflight: w.inflight.size, served: w.served })),
    loaded: workers.some((w) => w.state === "loaded"),
    ...stats,
    cloneMs: Math.round(stats.cloneMs),
    busyMs: Math.round(stats.busyMs),
  };
}
/** Resolves once a worker is loaded (or at once when one is). */
export function routerPoolLoaded() {
  if (workers.some((w) => w.state === "loaded")) return Promise.resolve();
  return new Promise((r) => loadWaiters.push(r));
}

// --- test hooks -----------------------------------------------------------------
const statsWaiters = new Map();
export const _routerPoolForTest = {
  setDeadlineMs(ms) { deadlineMs = ms; },
  /** Make the loaded worker throw an uncaught error (ROUTER_WORKER_TEST_HOOKS=1). */
  crashWorker() { const w = pickWorker(); if (w) w.worker.postMessage({ t: "__testCrash" }); return !!w; },
  /** A query the worker busy-waits on for `ms` before scoring (ROUTER_WORKER_TEST_HOOKS=1). */
  hangQuery(ms, args, opts) { return offload({ ...args, __testHangMs: ms }, opts); },
  workerStats() {
    const w = pickWorker();
    if (!w) return Promise.resolve(null);
    const id = ++nextJobId;
    return new Promise((resolve) => {
      statsWaiters.set(id, resolve);
      w.worker.postMessage({ t: "stats", id });
      setTimeout(() => { if (statsWaiters.delete(id)) resolve(null); }, 5000).unref?.();
    });
  },
  workers() { return workers; },
  flush() { for (const w of workers) if (w.state === "loaded") flushPending(w); },
};
