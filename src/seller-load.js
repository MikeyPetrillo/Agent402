// How much of a seller's hosting our own requests use, and the controls that
// keep it small. Some sellers run on plans where every request counts against
// a quota, a 304 or a 402 included, so a request we do not need is a cost we
// put on them.
//
//   1. Revisit back-off. When a crawl reads a seller's discovery documents
//      (the x402 manifest and /openapi.json) and nothing changed (a 304, or a
//      body with the same hash as the last read), the time until that origin
//      is crawled again doubles, from one crawl cycle up to REVISIT_CAP_MS
//      (SELLER_REVISIT_MAX_HOURS, default 12). A changed document, a failed
//      crawl, a failed router purchase or a re-registration puts it back on the
//      normal cycle.
//   2. Per-host daily budget. Every request the index and its probes send to a
//      host (crawler reads, the paywall probe, price probes, the MPP index's
//      reads) is counted per operator (src/operator-key.js: the registrable
//      domain, or the whole hostname on shared hosting) per UTC day. Past
//      DAILY_BUDGET (SELLER_PROBE_DAILY_BUDGET, default 200) the crawl and the
//      unpaid probes skip that host until the day rolls; the unpaid probes take
//      at most PROBE_SHARE of it, so the document reads keep the rest. A read
//      made for a registration (`unscheduled`) is counted apart and never
//      spends the day. The router's probe for
//      a paying caller is counted on a day count of its own, never skipped and
//      never counted against the crawl's budget. A request that reaches a host
//      through another operator's redirect (a document read following it, or
//      a probe sent where the documents moved) is counted on the crawled
//      origin's day and on the landing host's landed count, which has a day's
//      budget of its own: past it the request is not made (LandingHeld), and
//      the landing host's own day, crawl and router probes never read it.
//   3. Retry-After. A 429 or 503 from a seller to the crawler or a probe holds
//      that host's crawl and probes until its Retry-After (or THROTTLE_DEFAULT_MS
//      when it names none), never past THROTTLE_MAX_MS. A router purchase is
//      never held.
//   4. A request log: how many requests each component sent each host per
//      minute, kept REQUEST_LOG_KEEP_MS (two days), for the operator view a
//      seller's question is checked against. Every component /crawler lists is
//      in it: the crawl and the probes through the budget, and the catalog's
//      fetches for a caller, the site-crawl tool and the router's purchase
//      through noteHostRequest (host counts only). The store keeps one counter
//      per host, minute and component (a tally per host and hour), so a write
//      never reads the host's history; this process keeps at most 5,000 hosts
//      and, per host, the counts it has not written and the last few minutes.
//
// A skip never changes a listing: the entry stays exactly as the last
// completed read left it.
//
// STATE: this process's memory decides, and the shared limits store
// (src/shared-limits.js: Redis, shared by every container) is written behind
// it and read once per crawl cycle (see createSellerLoad), so a slow store
// never slows a crawl or a buyer's probe. Counts for the operator view:
// sellerLoadStatus(), on /__operator/seller-load.json.
import { createHash } from "node:crypto";
import { shared as sharedLimits, createMemoryLimits, noteSharedLimitsDegraded } from "./shared-limits.js";
import { operatorKey } from "./operator-key.js";
import { CRAWL_INTERVAL_MS, SLOW_ORIGIN_EVERY_CYCLES, isSlowOrigin } from "./crawl-cadence.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A number of hours from the environment: `off` (or 0) reads 0, a value that
 *  is not a positive number reads as the default, never above `max`. */
function hoursKnob(name, dflt, max) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return 0;
  const n = Number(raw);
  return Math.min(max, Number.isFinite(n) && n > 0 ? n : dflt) * HOUR_MS;
}
function countKnob(name, dflt) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0") return 0;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** The longest an unchanged origin waits between crawls (0 = no back-off). */
export const REVISIT_CAP_MS = hoursKnob("SELLER_REVISIT_MAX_HOURS", 12, 24);
/** The first wait after an unchanged read: two crawl cycles, then doubling. */
export const REVISIT_BASE_MS = CRAWL_INTERVAL_MS;
// A crawl cycle starts a little after the last one did, so the wait is cut by
// this much: an origin due "in an hour" is due on the cycle an hour later.
const REVISIT_SLACK_MS = 2 * 60_000;
/** Requests per operator per UTC day before unpaid probes skip it (0 = no budget). */
export const DAILY_BUDGET = countKnob("SELLER_PROBE_DAILY_BUDGET", 200);
/** The share of a day's budget the unpaid price and paywall probes may use, so
 *  the document reads always keep the rest. */
export const PROBE_SHARE = 0.5;
/** PROBE_SHARE as prose: "half". */
export const probeShareLabel = () => (PROBE_SHARE === 0.5 ? "half" : `${Math.round(PROBE_SHARE * 100)}%`);
/** The probe kinds held to PROBE_SHARE of the day (a document read is not). */
const PROBE_SHARE_KINDS = new Set(["paywall", "quote", "mpp-probe"]);
/** The time between two scheduled reads of an origin its operator asked us to
 *  read less often (CRAWL_SLOW_ORIGINS), by the clock: one crawl cycle less a
 *  little, so a cycle that starts a minute early still reads it. */
export const SLOW_READ_INTERVAL_MS = CRAWL_INTERVAL_MS * SLOW_ORIGIN_EVERY_CYCLES - 2 * 60_000;
/** A 429 or 503 with no usable Retry-After holds the host this long. */
export const THROTTLE_DEFAULT_MS = 30 * 60_000;
/** No Retry-After holds a host longer than this. */
export const THROTTLE_MAX_MS = DAY_MS;

/** The probe kinds the daily budget counts. `router-probe` is essential. */
export const PROBE_KINDS = Object.freeze(["crawler", "paywall", "quote", "router-probe", "mpp-crawler", "mpp-probe"]);

const REVISIT = "seller-revisit";      // window per origin: one member, the state
const THROTTLE = "seller-throttle";    // flag per hostname: held until
const BUDGET = "seller-probe-day";     // counter per day and operator
const SLOW = "seller-slow-read";       // flag per lane and slow origin: its next scheduled read waits until
const STATE_KEEP_MS = 14 * DAY_MS;     // a revisit state not written for this long is forgotten

/** The wait after `streak` unchanged reads in a row: 0 for none, then one
 *  base interval doubled per read (1 h, 2 h, 4 h, 8 h, ...), capped. */
export function revisitIntervalMs(streak, { baseMs = REVISIT_BASE_MS, capMs = REVISIT_CAP_MS } = {}) {
  const n = Math.floor(Number(streak) || 0);
  if (n <= 0 || capMs <= 0) return 0;
  return Math.min(capMs, baseMs * 2 ** Math.min(n, 20));
}

/** A short stable hash of a document body, or null for none. */
export function bodyHash(body) {
  if (typeof body !== "string" && !Buffer.isBuffer(body)) return null;
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

const normOrigin = (o) => String(o || "").trim().replace(/\/+$/, "");
function hostnameOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase() || null; } catch { return null; }
}
function originOf(u) {
  try { return new URL(String(u)).origin; } catch { return null; }
}
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
/** Seconds from a Retry-After value (a number, delta-seconds or an HTTP date
 *  read against `now`), or null when it names no wait. */
export function retryAfterSecondsAt(value, now) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) { const n = Number(raw); return n > 0 ? n : null; }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  const secs = Math.ceil((at - now) / 1000);
  return secs > 0 ? secs : null;
}

function encodeState(s) { return `${s.streak}:${s.nextAt}:${s.mh || "-"}:${s.oh || "-"}`; }
function decodeState(member) {
  const [streak, nextAt, mh, oh] = String(member || "").split(":");
  const st = { streak: Math.max(0, Math.floor(Number(streak) || 0)), nextAt: Math.max(0, Number(nextAt) || 0), mh: mh && mh !== "-" ? mh : null, oh: oh && oh !== "-" ? oh : null };
  return st;
}

/** How long a cycle's prefetch of the shared state waits before deciding on
 *  this process's own view (src/x402-index.js runCrawl). */
export const PREFETCH_WAIT_MS = 2_000;
/** How many origins' reads the prefetch starts in one turn of the event loop. */
const PREFETCH_CHUNK = 100;
/** The request log keeps counts per host, component and minute this long. */
export const REQUEST_LOG_KEEP_MS = 2 * DAY_MS;
const REQUEST_LOG_FLUSH_MS = 5_000;
const REQUEST_LOG = "seller-request-log"; // tally per hostname and hour: `${minute}|${kind}` -> requests
/** Hosts whose recent counts this process holds. */
const LOG_HOSTS_CAP = 5_000;
/** Minutes of a host's counts this process keeps after writing them. */
const LOG_MEMORY_MINUTES = 2;
/** Counts (minute and component) this process holds for one host at most. */
const LOG_MEMORY_ENTRIES_PER_HOST = 32;

/**
 * The controls over one store.
 *
 * This process's memory (`local`) decides every request: a crawl or a probe
 * never waits on the shared store. Each write lands in memory first and goes
 * to the store behind it (in order per key, never awaited by a caller), and
 * what other containers wrote reaches memory through `prefetch`, which the
 * crawl calls once per cycle for the origins it is about to visit: one batch
 * of reads in parallel, bounded by `prefetchWaitMs`. A store that is slow or
 * down therefore costs a cycle at most that wait, not a round trip per origin.
 */
export function createSellerLoad({
  store = sharedLimits,
  local = createMemoryLimits(),
  now = () => Date.now(),
  revisitCapMs = REVISIT_CAP_MS,
  revisitBaseMs = REVISIT_BASE_MS,
  dailyBudget = DAILY_BUDGET,
  prefetchWaitMs = PREFETCH_WAIT_MS,
  probeShare = PROBE_SHARE,
  slowReadIntervalMs = SLOW_READ_INTERVAL_MS,
} = {}) {
  const probeCap = Math.max(1, Math.floor(dailyBudget * probeShare));
  let clock = now;
  const shares = store && store !== local;
  const counts = {
    unchangedReads: 0, changedReads: 0,
    skipped: { unchanged: 0, throttled: 0, budget: 0, landing: 0, slow: 0 },
    resets: {},
    throttles: { noted: 0, withRetryAfter: 0 },
    requests: {}, refused: {},
    prefetch: { cycles: 0, timedOut: 0, merged: 0 },
  };
  // This process's view, for the operator counts: origins currently backed
  // off, and requests counted per operator today. Bounded.
  const backedOff = new Map();     // origin -> nextAt
  const hostDay = new Map();       // `${day}|${operator}` -> count
  const slowUntil = new Map();     // `${lane}|${origin}` -> the next scheduled read of a slow origin waits until
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const bounded = (map, cap = 20_000) => { while (map.size > cap) map.delete(map.keys().next().value); };

  // ---- the write-behind to the shared store ----------------------------------
  const chains = new Map();        // store key -> the tail of its write chain
  const pending = new Set();
  /** Run `fn(store)` after the last write queued for `key`; never awaited by a
   *  decision, never rejects. */
  function behind(key, fn) {
    if (!shares) return Promise.resolve(null);
    const prev = chains.get(key) || Promise.resolve();
    const p = prev.then(() => fn(store)).then(
      (r) => { if (!r?.ok) noteSharedLimitsDegraded("seller-load", r); return r; },
      (e) => { noteSharedLimitsDegraded("seller-load", { error: e?.message }); return null; },
    );
    chains.set(key, p);
    pending.add(p);
    p.finally(() => { pending.delete(p); if (chains.get(key) === p) chains.delete(key); });
    return p;
  }
  /** A shared read that never throws: the store's answer, or null. */
  async function shared(fn) {
    if (!shares) return null;
    try { const r = await fn(store); if (r?.ok) return r; noteSharedLimitsDegraded("seller-load", r); } catch (e) { noteSharedLimitsDegraded("seller-load", { error: e?.message }); }
    return null;
  }

  // ---- revisit state -----------------------------------------------------------
  const lastEntry = (r) => {
    const entries = Array.isArray(r?.entries) ? r.entries : [];
    return entries.length ? entries.reduce((a, b) => (b.score >= a.score ? b : a)) : null;
  };
  async function readRevisitEntry(origin) {
    return lastEntry(await local.windowRead(REVISIT, normOrigin(origin), { windowMs: STATE_KEEP_MS, now: clock() }));
  }
  async function readRevisit(origin) {
    const e = await readRevisitEntry(origin);
    return e ? decodeState(e.member) : null;
  }
  async function setLocalRevisit(key, member, score) {
    await local.windowClear(REVISIT, key);
    await local.windowAdd(REVISIT, key, { windowMs: STATE_KEEP_MS, member, now: clock(), score });
  }
  async function writeRevisit(origin, st) {
    const key = normOrigin(origin);
    const t = clock();
    if (st.streak > 0) { backedOff.set(key, st.nextAt); bounded(backedOff); } else backedOff.delete(key);
    const member = encodeState(st);
    await setLocalRevisit(key, member, t);
    void behind(`r|${key}`, async (s) => {
      const c = await s.windowClear(REVISIT, key);
      if (!c?.ok) return c;
      return s.windowAdd(REVISIT, key, { windowMs: STATE_KEEP_MS, member, now: t, score: t });
    });
  }

  // ---- the day's counts --------------------------------------------------------
  const budgetKey = (origin, t) => `${dayOf(t)}|${operatorKey(origin)}`;
  /** Raise this process's count of `key` to `value` when another container's
   *  requests put the shared one higher. */
  async function mergeCount(key, value) {
    const v = Number(value) || 0;
    const have = Number((await local.counterGet(BUDGET, key, { now: clock() }))?.value) || 0;
    if (v > have) { await local.counterAdd(BUDGET, key, v - have, 2 * DAY_MS, { now: clock() }); counts.prefetch.merged++; }
  }
  async function countLocal(key, delta = 1) {
    const r = await local.counterAdd(BUDGET, key, delta, 2 * DAY_MS, { now: clock() });
    return Number(r?.value) || 0;
  }
  function countShared(key, delta = 1) {
    const t = clock();
    void behind(`b|${key}`, async (s) => {
      const r = await s.counterAdd(BUDGET, key, delta, 2 * DAY_MS, { now: t });
      if (r?.ok) await mergeCount(key, r.value);
      return r;
    });
  }

  // ---- the request log (counts per host, component and minute) -----------------
  // The store holds one counter per (host, minute, component): a tally per host
  // and hour whose fields are `${minute}|${kind}`, so a write adds to a counter
  // and never reads the host's history. This process holds only the minutes it
  // has not written yet and the last LOG_MEMORY_MINUTES, at most
  // LOG_MEMORY_ENTRIES_PER_HOST per host.
  const logBuckets = new Map();    // hostname -> Map(`${minute}|${kind}` -> { n, flushed })
  const logTimers = new Map();
  let logEntries = 0;
  function dropLogHost(host) {
    const m = logBuckets.get(host);
    if (!m) return;
    logEntries -= m.size;
    logBuckets.delete(host);
    const tm = logTimers.get(host);
    if (tm) { clearTimeout(tm); logTimers.delete(host); }
  }
  /** Called right after a flush: drop from `m` the minutes before the last
   *  few, then the oldest past the per-host cap. */
  function trimLog(m) {
    const keepFrom = Math.floor(clock() / 60_000) * 60_000 - (LOG_MEMORY_MINUTES - 1) * 60_000;
    for (const [k, b] of m) {
      if (m.size <= LOG_MEMORY_ENTRIES_PER_HOST && Number(k.split("|")[0]) >= keepFrom) break;
      m.delete(k); logEntries--;
    }
  }
  function noteRequest(url, kind) {
    const host = hostnameOf(url);
    if (!host) return;
    const minute = Math.floor(clock() / 60_000) * 60_000;
    let m = logBuckets.get(host);
    if (!m) {
      m = new Map(); logBuckets.set(host, m);
      // Past the host cap the oldest host goes, its unwritten counts first.
      while (logBuckets.size > LOG_HOSTS_CAP) {
        const old = logBuckets.keys().next().value;
        const om = logBuckets.get(old);
        flushLog(old, om);
        dropLogHost(old);
      }
    }
    const k = `${minute}|${kind}`;
    let b = m.get(k);
    if (!b) { b = { n: 0, flushed: 0 }; m.set(k, b); logEntries++; }
    b.n++;
    if (m.size > LOG_MEMORY_ENTRIES_PER_HOST) { flushLog(host, m); trimLog(m); }
    if (shares && !logTimers.has(host)) {
      const tm = setTimeout(() => flushLog(host), REQUEST_LOG_FLUSH_MS);
      tm.unref?.();
      logTimers.set(host, tm);
    }
  }
  function flushLog(host, m = logBuckets.get(host)) {
    const tm = logTimers.get(host);
    if (tm) { clearTimeout(tm); logTimers.delete(host); }
    if (!m) return Promise.resolve();
    const byHour = new Map();    // hour -> [[`${minute}|${kind}`, delta]]
    for (const [k, b] of m) {
      const delta = b.n - b.flushed;
      if (delta <= 0 || !shares) continue;
      b.flushed = b.n;
      const hour = Math.floor(Number(k.split("|")[0]) / HOUR_MS) * HOUR_MS;
      if (!byHour.has(hour)) byHour.set(hour, []);
      byHour.get(hour).push([k, delta]);
    }
    const writes = [];
    for (const [hour, increments] of byHour) {
      const t = clock();
      writes.push(behind(`l|${host}`, (s) => (typeof s.tallyAdd === "function"
        ? s.tallyAdd(REQUEST_LOG, `${host}|${hour}`, increments, REQUEST_LOG_KEEP_MS + HOUR_MS, { now: t })
        : { ok: false, error: "no tally" })));
    }
    if (m === logBuckets.get(host)) trimLog(m);
    return Promise.all(writes);
  }

  // ---- reading other containers' writes ---------------------------------------
  /** Merge what the shared store holds for `origin` into this process's view:
   *  the newer revisit state, the later hold, the higher count. */
  async function hydrate(origin) {
    if (!shares) return;
    const key = normOrigin(origin);
    const host = hostnameOf(origin);
    const t = clock();
    await Promise.all([
      shared((s) => s.windowRead(REVISIT, key, { windowMs: STATE_KEEP_MS, now: t })).then(async (r) => {
        const theirs = lastEntry(r);
        if (!theirs) return;
        const mine = await readRevisitEntry(origin);
        if (!mine || theirs.score > mine.score) {
          await setLocalRevisit(key, theirs.member, theirs.score);
          const st = decodeState(theirs.member);
          if (st.streak > 0) { backedOff.set(key, st.nextAt); bounded(backedOff); }
          counts.prefetch.merged++;
        }
      }),
      host ? shared((s) => s.flagGet(THROTTLE, host, { now: t })).then(async (r) => {
        const until = Number(r?.until) || 0;
        const mine = Number((await local.flagGet(THROTTLE, host, { now: clock() }))?.until) || 0;
        if (until > mine) { await local.flagSet(THROTTLE, host, until, { now: clock() }); counts.prefetch.merged++; }
      }) : null,
      originOf(origin) ? shared((s) => s.counterGet(BUDGET, budgetKey(origin, t), { now: t })).then((r) => (r ? mergeCount(budgetKey(origin, t), r.value) : null)) : null,
      originOf(origin) ? shared((s) => s.counterGet(BUDGET, `${budgetKey(origin, t)}|probes`, { now: t })).then((r) => (r ? mergeCount(`${budgetKey(origin, t)}|probes`, r.value) : null)) : null,
      ...(isSlowOrigin(key) ? ["x402", "mpp"].map((lane) => shared((s) => s.flagGet(SLOW, `${lane}|${key}`, { now: t })).then((r) => {
        const until = Number(r?.until) || 0;
        if (until > (slowUntil.get(`${lane}|${key}`) || 0)) { slowUntil.set(`${lane}|${key}`, until); bounded(slowUntil, 1_000); counts.prefetch.merged++; }
      })) : []),
    ]);
  }

  return {
    /** Test seam: the clock every decision reads. */
    setClock(fn) { clock = typeof fn === "function" ? fn : now; },
    revisitIntervalMs: (streak) => revisitIntervalMs(streak, { baseMs: revisitBaseMs, capMs: revisitCapMs }),
    readRevisit,

    /** Read the shared state of `origins` into this process before a crawl
     *  cycle decides them: all at once, waiting at most `prefetchWaitMs`.
     *  Resolves `{ origins, timedOut }`; never throws. */
    async prefetch(origins, { waitMs = prefetchWaitMs } = {}) {
      const list = [...new Set((origins || []).map(normOrigin).filter(Boolean))];
      if (!shares || !list.length) return { origins: 0, timedOut: false };
      counts.prefetch.cycles++;
      let timer, stop = false;
      // Started PREFETCH_CHUNK origins at a time with a turn of the event loop
      // between: every read is still in flight together, but the work of
      // resolving them (each merges into this process's memory) never runs as
      // one long turn for thousands of origins.
      const all = (async () => {
        const runs = [];
        for (let i = 0; i < list.length && !stop; i += PREFETCH_CHUNK) {
          if (i) await new Promise((r) => setImmediate(r));
          for (const o of list.slice(i, i + PREFETCH_CHUNK)) runs.push(hydrate(o).catch(() => {}));
        }
        await Promise.allSettled(runs);
        return false;
      })();
      const wait = new Promise((r) => { timer = setTimeout(() => r(true), Math.max(0, waitMs)); timer.unref?.(); });
      const timedOut = await Promise.race([all, wait]);
      stop = true;
      clearTimeout(timer);
      if (timedOut) counts.prefetch.timedOut++;
      return { origins: list.length, timedOut };
    },

    /** Test seam: wait for every write queued to the shared store. */
    async flush() {
      for (const host of [...logTimers.keys()]) { clearTimeout(logTimers.get(host)); flushLog(host); }
      while (pending.size) await Promise.allSettled([...pending]);
    },

    /** Is `origin` due a crawl? `{ due, streak, nextAt, intervalMs }`. An
     *  origin with no state, or one whose state cannot be read, is due. */
    async revisitDue(origin) {
      const st = await readRevisit(origin).catch(() => null);
      if (!st || st.streak <= 0) return { due: true, streak: 0, nextAt: 0, intervalMs: 0 };
      const intervalMs = revisitIntervalMs(st.streak, { baseMs: revisitBaseMs, capMs: revisitCapMs });
      return { due: clock() >= st.nextAt, streak: st.streak, nextAt: st.nextAt, intervalMs };
    },

    /** Record a completed read of the discovery documents. Each hash is the
     *  document's body hash, or `undefined` when it answered 304 (the same
     *  document as before), or null when it was not read. Unchanged = every
     *  document the same as the last read; the wait then doubles. `advance`
     *  false (a read the seller asked for) records the hashes and keeps the
     *  origin on the normal cycle. */
    async noteDiscoveryRead(origin, { manifestHash, openapiHash, advance = true } = {}) {
      const prev = await readRevisit(origin).catch(() => null);
      const mh = manifestHash === undefined ? prev?.mh ?? null : manifestHash;
      const oh = openapiHash === undefined ? prev?.oh ?? null : openapiHash;
      const unchanged = Boolean(prev) && (manifestHash === undefined || mh === prev.mh) && (openapiHash === undefined || oh === prev.oh)
        && (mh !== null || oh !== null);
      const streak = unchanged && advance && revisitCapMs > 0 ? (prev.streak || 0) + 1 : 0;
      const intervalMs = revisitIntervalMs(streak, { baseMs: revisitBaseMs, capMs: revisitCapMs });
      const nextAt = intervalMs > 0 ? clock() + Math.max(0, intervalMs - REVISIT_SLACK_MS) : 0;
      if (unchanged) counts.unchangedReads++; else counts.changedReads++;
      await writeRevisit(origin, { streak, nextAt, mh, oh });
      return { unchanged, streak, nextAt, intervalMs };
    },

    /** Back to the normal cycle: a changed document, a failed crawl, a failed
     *  router purchase or a re-registration. The document hashes are kept. */
    async resetRevisit(origin, reason = "other") {
      const prev = await readRevisit(origin).catch(() => null);
      if (!prev || prev.streak <= 0) { backedOff.delete(normOrigin(origin)); return false; }
      bump(counts.resets, String(reason).slice(0, 40));
      await writeRevisit(origin, { ...prev, streak: 0, nextAt: 0 });
      return true;
    },

    /** Until when the host of `url` asked us to wait (ms), or 0. */
    async throttledUntil(url) {
      const host = hostnameOf(url);
      if (!host) return 0;
      const r = await local.flagGet(THROTTLE, host, { now: clock() });
      return Number(r?.until) > clock() ? Number(r.until) : 0;
    },

    /** A 429 or 503 from a seller's host: hold its crawl and probes until its
     *  Retry-After (seconds or an HTTP date), or the default. Any other status
     *  is ignored. Never throws. */
    async noteThrottle(url, status, retryAfter = null) {
      const st = Number(status);
      if (st !== 429 && st !== 503) return 0;
      const host = hostnameOf(url);
      if (!host) return 0;
      const secs = retryAfterSecondsAt(retryAfter, clock());
      const holdMs = Math.min(THROTTLE_MAX_MS, secs ? secs * 1000 : THROTTLE_DEFAULT_MS);
      const until = clock() + holdMs;
      counts.throttles.noted++;
      if (secs) counts.throttles.withRetryAfter++;
      const held = await this.throttledUntil(url).catch(() => 0);
      if (held >= until) return held;
      await local.flagSet(THROTTLE, host, until, { now: clock() });
      const t = clock();
      void behind(`t|${host}`, async (s) => {
        // Never cut short a longer hold another container recorded.
        const theirs = Number((await s.flagGet(THROTTLE, host, { now: t }))?.until) || 0;
        return theirs >= until ? { ok: true } : s.flagSet(THROTTLE, host, until, { now: t });
      });
      return until;
    },

    /** Count one request to the host of `url` and decide it. Non-essential
     *  requests past the day's budget are refused (and not counted). The
     *  router's probe for a paying caller (`router-probe`, essential) is
     *  counted on a day count of its own and never refused, so a seller busy
     *  with buyers does not use up the crawl's budget; any other essential
     *  request (a read inside a crawl already started) is counted on the day's
     *  budget and never refused. Never waits on the shared store.
     *
     *  `chargeTo` is the origin whose crawl sends the request. When it is
     *  another operator's than the host of `url` (its discovery documents
     *  moved there), the request is counted on `chargeTo`'s day, so the host
     *  it lands on keeps its own day and its own crawl; the requests that
     *  land on a host this way are counted apart, and past a day's budget of
     *  them one more is refused, essential or not.
     *  `{ ok, used, budget }`. */
    async takeBudget(url, kind, { essential = false, chargeTo = null, unscheduled = false } = {}) {
      const k = String(kind || "other");
      const target = originOf(url);
      const cause = chargeTo ? originOf(chargeTo) : null;
      const moved = Boolean(target && cause && operatorKey(cause) !== operatorKey(target));
      const origin = moved ? cause : target;
      if (!origin) { bump(counts.requests, k); return { ok: true, used: 0, budget: dailyBudget }; }
      const t = clock();
      if (essential && k === "router-probe") {
        const key = `${budgetKey(target, t)}|router`;
        const used = await countLocal(key);
        countShared(key);
        bump(counts.requests, k);
        noteRequest(url, k);
        return { ok: true, used, budget: dailyBudget, routine: false };
      }
      // A read we did not schedule (a registration's, which anyone can ask
      // for any origin) is counted on a day count of its own, the crawled
      // origin's, and never refused: it never spends the day the scheduled
      // crawl and its probes read. One that lands on another operator's host
      // is held to a landed allowance of its own there, apart from the one
      // the scheduled reads of moved origins share.
      if (unscheduled) {
        const key = `${budgetKey(origin, t)}|unscheduled`;
        if (moved && dailyBudget > 0) {
          const landedKey = `${budgetKey(target, t)}|landed-unscheduled`;
          const landed = await countLocal(landedKey);
          if (landed > dailyBudget) {
            await countLocal(landedKey, -1);
            bump(counts.refused, `${k}:landed-unscheduled`);
            return { ok: false, used: 0, budget: dailyBudget, unscheduled: true };
          }
          countShared(landedKey);
        }
        const used = await countLocal(key);
        countShared(key);
        bump(counts.requests, `${k}:unscheduled`);
        noteRequest(url, k);
        return { ok: true, used, budget: dailyBudget, unscheduled: true };
      }
      if (dailyBudget <= 0) { bump(counts.requests, k); noteRequest(url, k); return { ok: true, used: 0, budget: dailyBudget }; }
      const key = budgetKey(origin, t);
      const used = await countLocal(key);
      if (!essential && used > dailyBudget) {
        await countLocal(key, -1);
        bump(counts.refused, k);
        return { ok: false, used: used - 1, budget: dailyBudget };
      }
      // The unpaid probes take at most PROBE_SHARE of the day, so the
      // document reads of the scheduled crawl always keep the rest.
      const probeKey = !essential && PROBE_SHARE_KINDS.has(k) ? `${key}|probes` : null;
      if (probeKey) {
        const probes = await countLocal(probeKey);
        if (probes > probeCap) {
          await countLocal(probeKey, -1);
          await countLocal(key, -1);
          bump(counts.refused, `${k}:probe-share`);
          return { ok: false, used: used - 1, budget: dailyBudget };
        }
      }
      if (moved) {
        const landedKey = `${budgetKey(target, t)}|landed`;
        const landed = await countLocal(landedKey);
        if (landed > dailyBudget) {
          await countLocal(landedKey, -1);
          await countLocal(key, -1);
          if (probeKey) await countLocal(probeKey, -1);
          bump(counts.refused, `${k}:landed`);
          return { ok: false, used: used - 1, budget: dailyBudget };
        }
        countShared(landedKey);
      }
      countShared(key);
      if (probeKey) countShared(probeKey);
      bump(counts.requests, k);
      noteRequest(url, k);
      hostDay.set(key, used); bounded(hostDay);
      return { ok: true, used, budget: dailyBudget };
    },

    /** Note one request to the host of `url` in the request log only: no
     *  budget, no hold (see noteHostRequest). */
    logRequest(url, kind) { noteRequest(url, String(kind || "other")); },

    /** Requests counted today for the operator of `url`, and whether the
     *  budget is spent. */
    async budgetSpent(url) {
      const origin = originOf(url);
      if (!origin || dailyBudget <= 0) return { spent: false, used: 0, budget: dailyBudget };
      const r = await local.counterGet(BUDGET, budgetKey(origin, clock()), { now: clock() });
      const used = Number(r?.value) || 0;
      return { spent: used >= dailyBudget, used, budget: dailyBudget };
    },

    /** The requests other operators' crawls landed today on the operator of
     *  `url` (their documents moved there); never part of its own day. */
    async landedToday(url) {
      const origin = originOf(url);
      if (!origin) return 0;
      return Number((await local.counterGet(BUDGET, `${budgetKey(origin, clock())}|landed`, { now: clock() }))?.value) || 0;
    },

    /** Whether a request `chargeTo`'s crawl would land on the operator of
     *  `url` has no room left today: another operator's host, and the day's
     *  landed allowance there is spent. Reads only. */
    async landingSpent(url, chargeTo) {
      const target = originOf(url), cause = originOf(chargeTo);
      if (!target || !cause || dailyBudget <= 0 || operatorKey(cause) === operatorKey(target)) return false;
      return (await this.landedToday(target)) >= dailyBudget;
    },

    /** The router's probes counted today for the operator of `url`. */
    async routerProbesToday(url) {
      const origin = originOf(url);
      if (!origin) return 0;
      return Number((await local.counterGet(BUDGET, `${budgetKey(origin, clock())}|router`, { now: clock() }))?.value) || 0;
    },

    /** Why an unpaid request to `url` should wait (a Retry-After hold, a spent
     *  day), or null. Reads only; counts nothing. */
    async hold(url) {
      if (await this.throttledUntil(url)) return "throttled";
      if ((await this.budgetSpent(url)).spent) return "budget";
      return null;
    },

    /** The scheduled crawl's plan for `origin`: `skip` is why it waits this
     *  cycle ("throttled" for a Retry-After, "budget" for a spent day,
     *  "landing" when its documents are read from another operator's host
     *  (`landsOn`) whose landed allowance is spent, "unchanged" for a
     *  back-off) or null, and `intervalMs` the back-off the origin is on (0 on
     *  the normal cycle). Never throws, and an unreadable state crawls. */
    async crawlPlan(origin, { landsOn = null, lane = "x402" } = {}) {
      try {
        if (this.slowWaiting(origin, lane)) { counts.skipped.slow++; return { skip: "slow", intervalMs: 0 }; }
        const held = await this.hold(origin);
        if (held) { counts.skipped[held]++; return { skip: held, intervalMs: 0 }; }
        for (const to of [].concat(landsOn || [])) {
          if (await this.landingSpent(to, origin)) { counts.skipped.landing++; return { skip: "landing", intervalMs: 0 }; }
        }
        const due = await this.revisitDue(origin);
        if (!due.due) { counts.skipped.unchanged++; return { skip: "unchanged", intervalMs: due.intervalMs }; }
        return { skip: null, intervalMs: due.intervalMs };
      } catch { return { skip: null, intervalMs: 0 }; }
    },

    /** Does the scheduled read of a slow origin (CRAWL_SLOW_ORIGINS) in `lane`
     *  ("x402" or "mpp") wait? By the clock, from the last scheduled read any
     *  container made (merged at prefetch), so a restart never reads it early.
     *  False for every other origin. Synchronous: this process's view. */
    slowWaiting(origin, lane = "x402", at = clock()) {
      const key = normOrigin(origin);
      if (!isSlowOrigin(key)) return false;
      return (slowUntil.get(`${lane}|${key}`) || 0) > at;
    },
    /** A scheduled read of a slow origin in `lane` starts now: the next one
     *  waits SLOW_READ_INTERVAL_MS, here and (written behind) in the store. */
    noteSlowRead(origin, lane = "x402") {
      const key = normOrigin(origin);
      if (!isSlowOrigin(key) || slowReadIntervalMs <= 0) return 0;
      const t = clock();
      const until = t + slowReadIntervalMs;
      slowUntil.set(`${lane}|${key}`, until); bounded(slowUntil, 1_000);
      void behind(`s|${lane}|${key}`, (s) => s.flagSet(SLOW, `${lane}|${key}`, until, { now: t }));
      return until;
    },

    /** Why an unpaid probe to `url` should not be sent, or null; counts it
     *  against the day's budget (of `chargeTo`, see takeBudget) when it may be. */
    async probeRefusal(url, kind, { chargeTo = null } = {}) {
      try {
        if (await this.throttledUntil(url)) { bump(counts.refused, `${kind}:throttled`); return "throttled"; }
        const b = await this.takeBudget(url, kind, { chargeTo });
        return b.ok ? null : "budget";
      } catch { return null; }
    },

    /** The requests we sent the host `hostname` over the last two days, per
     *  component and minute, oldest first: this process's own counts merged
     *  with what every container wrote to the shared store. */
    async requestLog(hostname) {
      const host = String(hostname || "").trim().toLowerCase();
      const cutoff = clock() - REQUEST_LOG_KEEP_MS;
      const byKey = new Map();
      const add = (minute, kind, n) => { if (minute > cutoff) { const k = `${minute}|${kind}`; byKey.set(k, (byKey.get(k) || 0) + n); } };
      let complete = true;
      if (shares) {
        await flushLog(host);
        const hours = [];
        for (let h = Math.floor(cutoff / HOUR_MS) * HOUR_MS; h <= clock(); h += HOUR_MS) hours.push({ name: REQUEST_LOG, key: `${host}|${h}` });
        const r = await shared((s) => (typeof s.tallyReadMany === "function" ? s.tallyReadMany(hours, { now: clock() }) : { ok: false, error: "no tally" }));
        if (r && Array.isArray(r.results)) for (const one of r.results) for (const [k, n] of Object.entries(one?.fields || {})) { const [minute, kind] = k.split("|"); add(Number(minute), kind, Number(n) || 0); }
        else complete = false;
      }
      if (!shares || !complete) for (const [k, b] of logBuckets.get(host) || []) { const [minute, kind] = k.split("|"); add(Number(minute), kind, b.n); }
      const rows = [...byKey].map(([k, n]) => { const [minute, kind] = k.split("|"); return { minute: new Date(Number(minute)).toISOString(), kind, requests: n }; })
        .sort((a, b) => (a.minute < b.minute ? -1 : a.minute > b.minute ? 1 : a.kind < b.kind ? -1 : 1));
      return { host, keptHours: REQUEST_LOG_KEEP_MS / HOUR_MS, complete, rows, total: rows.reduce((n, r) => n + r.requests, 0) };
    },

    /** Counts for the operator view: never an origin or a host. */
    status() {
      const t = clock();
      const today = dayOf(t);
      let hostsCountedToday = 0, hostsOverBudgetToday = 0;
      for (const [k, n] of hostDay) {
        if (!k.startsWith(`${today}|`)) continue;
        hostsCountedToday++;
        if (dailyBudget > 0 && n >= dailyBudget) hostsOverBudgetToday++;
      }
      let backedOffNow = 0;
      for (const [, at] of backedOff) if (at > t) backedOffNow++;
      return {
        revisit: { capHours: revisitCapMs / HOUR_MS, firstWaitMinutes: revisitIntervalMs(1, { baseMs: revisitBaseMs, capMs: revisitCapMs }) / 60_000, originsBackedOff: backedOffNow, unchangedReads: counts.unchangedReads, changedReads: counts.changedReads, resets: { ...counts.resets } },
        budget: { perOperatorPerDay: dailyBudget, probesPerOperatorPerDay: probeCap, hostsCountedToday, hostsOverBudgetToday, requests: { ...counts.requests }, refused: { ...counts.refused }, routerProbesCountedApart: true },
        throttle: { defaultMinutes: THROTTLE_DEFAULT_MS / 60_000, maxHours: THROTTLE_MAX_MS / HOUR_MS, ...counts.throttles },
        crawlsSkipped: { ...counts.skipped },
        prefetch: { ...counts.prefetch, waitMs: prefetchWaitMs },
        requestLog: { keptHours: REQUEST_LOG_KEEP_MS / HOUR_MS, hostsInMemory: logBuckets.size, entriesInMemory: logEntries },
        store: store?.mode || "memory",
        writesPending: pending.size,
      };
    },
  };
}

/** One probe the router sends for a paying caller (src/server.js): counted on
 *  the host's router count and noted in the request log without waiting on
 *  any store, sent whatever the day's crawl budget reads, and a 429 or 503
 *  answer holds the host's unpaid probes (never this purchase). `send()`
 *  makes the request and resolves the Response. */
export async function sendRouterProbe(url, send, { load = sellerLoad } = {}) {
  void Promise.resolve().then(() => load.takeBudget(url, "router-probe", { essential: true })).catch(() => {});
  const p = await send();
  const st = Number(p?.status);
  if (st === 429 || st === 503) void Promise.resolve().then(() => load.noteThrottle(url, st, p.headers?.get?.("retry-after"))).catch(() => {});
  return p;
}

/** The process's controls, over the shared limits store. */
export const sellerLoad = createSellerLoad();

/** Thrown instead of following a redirect onto another operator's host whose
 *  landed allowance for the day is spent: the request was not made. Our own
 *  limit, never the crawled origin's answer. */
export class LandingHeld extends Error {
  constructor(host) {
    super(`not sent: the day's allowance of requests reaching ${host || "that host"} through other sites' redirects is spent`);
    this.landingHeld = true;
    this.landingHost = host || null;
  }
}
/** The check a redirect-following read of `chargeTo`'s documents makes before
 *  each hop (safeFetch `beforeRedirect`): the hop is counted on `chargeTo`'s
 *  day, and one onto another operator's host also on that host's landed
 *  allowance, past which it throws LandingHeld and nothing is sent. */
export function landingGate(chargeTo, kind, { load = sellerLoad, unscheduled = false } = {}) {
  return async (nextUrl) => {
    const b = await load.takeBudget(nextUrl, kind, { essential: true, chargeTo, unscheduled });
    if (b?.ok === false) throw new LandingHeld(hostnameOf(nextUrl));
  };
}

/** Note one request a component of ours sent the host of `url`, in the
 *  request log only (host, component and minute; never a path or a caller):
 *  the components outside the crawl's budget, a catalog tool fetching for its
 *  caller (`fetch`), the site-crawl tool (`site-crawl`) and the router's
 *  purchase (`router-buy`). Never throws, never waits. */
export function noteHostRequest(url, kind) {
  try { sellerLoad.logRequest(url, kind); } catch { /* the log never fails a request */ }
}
export const sellerLoadStatus = () => sellerLoad.status();
