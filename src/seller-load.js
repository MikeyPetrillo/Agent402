// How much of a seller's hosting our own requests use, and three controls that
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
//      host (crawler reads, the paywall probe, price probes, the router's
//      pre-payment probe) is counted per operator (src/operator-key.js: the
//      registrable domain, or the whole hostname on shared hosting) per UTC
//      day. Past DAILY_BUDGET (SELLER_PROBE_DAILY_BUDGET, default 200) the
//      crawl and the unpaid probes skip that host until the day rolls. The
//      router's probe for a paying caller is counted and never skipped.
//   3. Retry-After. A 429 or 503 from a seller to the crawler or a probe holds
//      that host's crawl and probes until its Retry-After (or THROTTLE_DEFAULT_MS
//      when it names none), never past THROTTLE_MAX_MS. A router purchase is
//      never held.
//
// A skip never changes a listing: the entry stays exactly as the last
// completed read left it.
//
// STATE is the shared limits store (src/shared-limits.js: Redis, shared by
// every container, the same store the index's re-registration cooldowns use),
// with this process's memory as the floor when the store does not answer.
// Counts for the operator view: sellerLoadStatus(), on
// /__operator/seller-load.json.
import { createHash } from "node:crypto";
import { shared, createMemoryLimits, noteSharedLimitsDegraded } from "./shared-limits.js";
import { operatorKey } from "./operator-key.js";
import { CRAWL_INTERVAL_MS } from "./crawl-cadence.js";

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
/** A 429 or 503 with no usable Retry-After holds the host this long. */
export const THROTTLE_DEFAULT_MS = 30 * 60_000;
/** No Retry-After holds a host longer than this. */
export const THROTTLE_MAX_MS = DAY_MS;

/** The probe kinds the daily budget counts. `router-probe` is essential. */
export const PROBE_KINDS = Object.freeze(["crawler", "paywall", "quote", "router-probe", "mpp-crawler", "mpp-probe"]);

const REVISIT = "seller-revisit";      // window per origin: one member, the state
const THROTTLE = "seller-throttle";    // flag per hostname: held until
const BUDGET = "seller-probe-day";     // counter per day and operator
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

/**
 * The controls over one store. `store` is the shared limits interface;
 * `local` the process-memory floor used when the store does not answer (and
 * written beside it, so a store that goes away leaves a recent view).
 */
export function createSellerLoad({
  store = shared,
  local = createMemoryLimits(),
  mirrorLocal = store !== local && store?.mode === "redis",
  now = () => Date.now(),
  revisitCapMs = REVISIT_CAP_MS,
  revisitBaseMs = REVISIT_BASE_MS,
  dailyBudget = DAILY_BUDGET,
} = {}) {
  let clock = now;
  const counts = {
    unchangedReads: 0, changedReads: 0,
    skipped: { unchanged: 0, throttled: 0, budget: 0 },
    resets: {},
    throttles: { noted: 0, withRetryAfter: 0 },
    requests: {}, refused: {},
  };
  // This process's view, for the operator counts: origins currently backed
  // off, and requests counted per operator today. Bounded.
  const backedOff = new Map();     // origin -> nextAt
  const hostDay = new Map();       // `${day}|${operator}` -> count
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const bounded = (map, cap = 20_000) => { while (map.size > cap) map.delete(map.keys().next().value); };

  async function read(fn) {
    let r;
    try { r = await fn(store); } catch (e) { r = { ok: false, error: e?.message }; }
    if (r?.ok) return r;
    if (store !== local) { noteSharedLimitsDegraded("seller-load", r); return fn(local); }
    return r;
  }
  async function write(fn) {
    let r;
    try { r = await fn(store); } catch (e) { r = { ok: false, error: e?.message }; }
    if (store === local) return r;
    if (r?.ok) {
      if (mirrorLocal) { try { await fn(local); } catch { /* the floor never throws */ } }
      return r;
    }
    noteSharedLimitsDegraded("seller-load", r);
    return fn(local);
  }

  async function readRevisit(origin) {
    const key = normOrigin(origin);
    const r = await read((s) => s.windowRead(REVISIT, key, { windowMs: STATE_KEEP_MS, now: clock() }));
    const entries = Array.isArray(r?.entries) ? r.entries : [];
    if (!entries.length) return null;
    const last = entries.reduce((a, b) => (b.score >= a.score ? b : a));
    return decodeState(last.member);
  }
  async function writeRevisit(origin, st) {
    const key = normOrigin(origin);
    const t = clock();
    if (st.streak > 0) { backedOff.set(key, st.nextAt); bounded(backedOff); } else backedOff.delete(key);
    await write((s) => s.windowClear(REVISIT, key));
    return write((s) => s.windowAdd(REVISIT, key, { windowMs: STATE_KEEP_MS, member: encodeState(st), now: t, score: t }));
  }

  return {
    /** Test seam: the clock every decision reads. */
    setClock(fn) { clock = typeof fn === "function" ? fn : now; },
    revisitIntervalMs: (streak) => revisitIntervalMs(streak, { baseMs: revisitBaseMs, capMs: revisitCapMs }),
    readRevisit,

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
      const r = await read((s) => s.flagGet(THROTTLE, host, { now: clock() }));
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
      await write((s) => s.flagSet(THROTTLE, host, until, { now: clock() }));
      return until;
    },

    /** Count one request to the host of `url` and decide it. Non-essential
     *  requests past the day's budget are refused (and not counted); an
     *  essential one (the router's probe for a paying caller) is always
     *  allowed. `{ ok, used, budget }`. */
    async takeBudget(url, kind, { essential = false } = {}) {
      const k = String(kind || "other");
      const origin = originOf(url);
      if (!origin || dailyBudget <= 0) { bump(counts.requests, k); return { ok: true, used: 0, budget: dailyBudget }; }
      const t = clock();
      const key = `${dayOf(t)}|${operatorKey(origin)}`;
      const r = await write((s) => s.counterAdd(BUDGET, key, 1, 2 * DAY_MS, { now: t }));
      const used = Number(r?.value) || 0;
      if (!essential && used > dailyBudget) {
        await write((s) => s.counterAdd(BUDGET, key, -1, 2 * DAY_MS, { now: t }));
        bump(counts.refused, k);
        return { ok: false, used: used - 1, budget: dailyBudget };
      }
      bump(counts.requests, k);
      hostDay.set(key, used); bounded(hostDay);
      return { ok: true, used, budget: dailyBudget };
    },

    /** Requests counted today for the operator of `url`, and whether the
     *  budget is spent. */
    async budgetSpent(url) {
      const origin = originOf(url);
      if (!origin || dailyBudget <= 0) return { spent: false, used: 0, budget: dailyBudget };
      const key = `${dayOf(clock())}|${operatorKey(origin)}`;
      const r = await read((s) => s.counterGet(BUDGET, key, { now: clock() }));
      const used = Number(r?.value) || 0;
      return { spent: used >= dailyBudget, used, budget: dailyBudget };
    },

    /** The scheduled crawl's plan for `origin`: `skip` is why it waits this
     *  cycle ("throttled" for a Retry-After, "budget" for a spent day,
     *  "unchanged" for a back-off) or null, and `intervalMs` the back-off the
     *  origin is on (0 on the normal cycle). Reads the store; never throws,
     *  and an unreadable state crawls. */
    async crawlPlan(origin) {
      try {
        if (await this.throttledUntil(origin)) { counts.skipped.throttled++; return { skip: "throttled", intervalMs: 0 }; }
        if ((await this.budgetSpent(origin)).spent) { counts.skipped.budget++; return { skip: "budget", intervalMs: 0 }; }
        const due = await this.revisitDue(origin);
        if (!due.due) { counts.skipped.unchanged++; return { skip: "unchanged", intervalMs: due.intervalMs }; }
        return { skip: null, intervalMs: due.intervalMs };
      } catch { return { skip: null, intervalMs: 0 }; }
    },

    /** Why an unpaid probe to `url` should not be sent, or null; counts it
     *  against the day's budget when it may be. */
    async probeRefusal(url, kind) {
      try {
        if (await this.throttledUntil(url)) { bump(counts.refused, `${kind}:throttled`); return "throttled"; }
        const b = await this.takeBudget(url, kind);
        return b.ok ? null : "budget";
      } catch { return null; }
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
        budget: { perOperatorPerDay: dailyBudget, hostsCountedToday, hostsOverBudgetToday, requests: { ...counts.requests }, refused: { ...counts.refused } },
        throttle: { defaultMinutes: THROTTLE_DEFAULT_MS / 60_000, maxHours: THROTTLE_MAX_MS / HOUR_MS, ...counts.throttles },
        crawlsSkipped: { ...counts.skipped },
        store: store?.mode || "memory",
      };
    },
  };
}

/** The process's controls, over the shared limits store. */
export const sellerLoad = createSellerLoad();
export const sellerLoadStatus = () => sellerLoad.status();
