// Per-tool and per-upstream failure counts, and the words that page on them.
//
// Every tool failure was already logged ("[tool-error]", "[paid-timing]"), but
// nothing counted them over time, so a tool or an upstream could fail for a
// day before anyone read the log. This module counts:
//   tools      per slug, every answer of a catalog route that reached its
//              dispatcher, by class: ok (< 400), buyer (4xx), fail (5xx other
//              than 504), timeout (504), payment (402 after the handler: a
//              settle refusal), gone (499: the buyer left), shed (load shed or
//              drain; never a tool failure). Split by origin: outside (a buyer)
//              or synthetic (heartbeat token, status probe, our own wallets).
//   upstreams  per named upstream host, every outbound fetch the egress
//              meter sees, by outcome: ok, s5xx, timeout, network (refused or
//              reset before an answer), throttled (429), aborted (the caller
//              cancelled: a buyer who left, a drain). Split by origin:
//              outside (inside a buyer's request), synthetic, background (no
//              request: warmers, crawlers, timers).
//   facilitator refusals  a settle refused for an out-of-funds or billing
//              class, per network and facilitator label.
//
// Counts sit in five-minute buckets kept for 24 hours. The words read the
// last hour; the operator view also carries the 24-hour totals.
//
// Shared across replicas: each process publishes its own buckets to Redis
// (one key per replica, kept 25 h, listed in a shared-limits window) every
// TOOL_FAILURE_PUBLISH_MS, and a read merges the other replicas' latest
// snapshots with this process's live counts. Without Redis (or when it does
// not answer) the counts are this process's own, and the operator view says
// so (`scope: "instance"`). A snapshot not republished for
// TOOL_FAILURE_REPLICA_STALE_MS (default 10 minutes) belongs to a replica that
// is gone (an earlier deploy) and is left out of the merge.
//
// Cost: the other replicas' snapshots are read and merged once per
// REMOTE_MAX_AGE_MS (30 s), and the words are computed at most once per that
// window and cached; /api/gateway-status reads the cache. A stale cache is
// served while one recompute runs after the response, so no request waits
// on a merge.
//
// Public surface: /api/gateway-status carries toolFailures, upstreamHealth
// and facilitatorFunds as one word each. Slugs, upstream names, counts and
// messages are on /__operator/tool-failures.json only.
import { randomUUID } from "node:crypto";

export const BUCKET_MS = 5 * 60_000;
export const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
export const TOOL_CLASSES = ["ok", "buyer", "fail", "timeout", "payment", "gone", "shed"];
export const UPSTREAM_KINDS = ["ok", "s5xx", "timeout", "network", "throttled", "aborted"];
export const WORDS = ["ok", "degraded", "failing"];
export const FUNDS_WORDS = ["ok", "refused", "demoted"];
const MAX_SLUGS = 2_000;
const MAX_UPSTREAMS = 200;
const MAX_REFUSALS = 200;
const REMOTE_MAX_AGE_MS = 30_000;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export function thresholds(env = process.env) {
  return {
    // degraded: one tool answered at least this many outside-buyer 5xx in 1 h.
    tool5xxDegraded: num(env.TOOL_FAIL_DEGRADED_5XX, 3),
    // failing: one tool's outside 5xx share passed this over at least minCalls in 1 h.
    toolFailRate: num(env.TOOL_FAIL_RATE, 0.25),
    toolMinCalls: num(env.TOOL_FAIL_MIN_CALLS, 8),
    // degraded: one upstream had at least this many timeouts, 5xx or network
    // failures in 1 h (synthetic traffic excluded).
    upstreamDegraded: num(env.UPSTREAM_FAIL_DEGRADED, 5),
    upstreamFailRate: num(env.UPSTREAM_FAIL_RATE, 0.25),
    upstreamMinCalls: num(env.UPSTREAM_FAIL_MIN_CALLS, 8),
    // facilitatorFunds reads refused while a refusal is this recent.
    fundsWindowMs: num(env.FACILITATOR_FUNDS_WINDOW_MS, HOUR_MS),
  };
}

/** The class of a final tool response. */
export function toolClassOf(status, { shed = false } = {}) {
  const s = Number(status) || 0;
  if (shed) return "shed";
  if (s === 499) return "gone";
  if (s === 402) return "payment";
  if (s === 504) return "timeout";
  if (s >= 500) return "fail";
  if (s >= 400) return "buyer";
  return "ok";
}

const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"]);
/** The outcome of an outbound fetch from its rejection (or null for a response). */
export function upstreamKindOfError(err, init) {
  const reason = init?.signal?.reason;
  const code = err?.cause?.code || err?.code;
  if (err?.name === "TimeoutError" || reason?.name === "TimeoutError" || TIMEOUT_CODES.has(code)) return "timeout";
  if (err?.name === "AbortError" || reason) return "aborted";
  return "network";
}
export function upstreamKindOfStatus(status) {
  const s = Number(status) || 0;
  if (s === 429) return "throttled";
  if (s >= 500) return "s5xx";
  return "ok";
}

// Named upstreams, by host. Facilitator and render-worker hosts are added at
// boot from their configured URLs (registerUpstreamHost), never typed here.
const FIXED_UPSTREAMS = [
  [/(^|\.)databento\.com$/, "databento"],
  [/(^|\.)stlouisfed\.org$/, "fred"],
  [/(^|\.)hyperliquid\.xyz$/, "hyperliquid"],
  [/(^|\.)rugcheck\.xyz$/, "rugcheck"],
  [/(^|\.)sec\.gov$/, "edgar"],
  [/(^|\.)exa\.ai$/, "exa"],
  [/(^|\.)openrouter\.ai$/, "openrouter"],
];

const emptyTool = () => TOOL_CLASSES.map(() => 0);
const emptyUp = () => UPSTREAM_KINDS.map(() => 0);
const add = (a, b) => { for (let i = 0; i < a.length; i++) a[i] += Number(b?.[i]) || 0; return a; };

/** The default cross-replica store: Redis through the shared client. */
export function redisSnapshotStore({ getClient, shared, keyPrefix = "tfm" } = {}) {
  const TTL_MS = DAY_MS + HOUR_MS;
  const key = (id) => `${keyPrefix}:snap:${id}`;
  return {
    async publish(id, json, now = Date.now()) {
      const c = await getClient();
      if (!c) return { ok: false };
      await c.set(key(id), json, { PX: TTL_MS });
      const r = await shared.windowAdd("tfm-replicas", "all", { windowMs: TTL_MS, member: id, now });
      return { ok: !!r?.ok };
    },
    async readAll(now = Date.now()) {
      const r = await shared.windowRead("tfm-replicas", "all", { windowMs: TTL_MS, now });
      if (!r?.ok || !Array.isArray(r.entries)) return { ok: false, snapshots: [] };
      const ids = r.entries.map((e) => e.member);
      if (!ids.length) return { ok: true, snapshots: [] };
      const c = await getClient();
      if (!c) return { ok: false, snapshots: [] };
      const vals = await c.mGet(ids.map(key));
      const snapshots = [];
      (vals || []).forEach((v, i) => { if (v) { try { snapshots.push({ id: ids[i], ...JSON.parse(v) }); } catch { /* a torn value is skipped */ } } });
      return { ok: true, snapshots };
    },
  };
}

export function createToolFailureMonitor({ now = () => Date.now(), store = null, replicaId = null, env = process.env, isDemoted = () => [] } = {}) {
  const id = String(replicaId || env.RAILWAY_REPLICA_ID || randomUUID()).slice(0, 64);
  const tools = new Map();      // slug -> Map(bucket -> { o: [], s: [] })
  const upstreams = new Map();  // name -> Map(bucket -> { o: [], s: [], b: [] })
  const lastToolError = new Map(); // slug -> { at, status, message, synthetic }
  const lastUpstream = new Map();  // name -> { at, kind, host, status }
  const refusals = [];          // { at, network, facilitator, reason }
  const hosts = [];             // [matcher(host) -> bool, name, perFetch]
  let remote = { at: 0, snapshots: [], ok: false, merged: null };
  let cached = null;      // { at, e }: the last evaluation the words are read from
  let recomputing = false;

  const bucketOf = (t) => Math.floor(t / BUCKET_MS);
  const prune = (m, t) => { const floor = bucketOf(t - DAY_MS); for (const k of m.keys()) if (k <= floor) m.delete(k); };

  function upstreamNameOf(host) {
    const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
    if (!h) return null;
    for (const [match, name] of hosts) if (match(h)) return name;
    for (const [re, name] of FIXED_UPSTREAMS) if (re.test(h)) return name;
    return null;
  }

  // `perFetch: false` names a host whose caller reports one final outcome per
  // call (noteUpstream) instead of the egress meter counting every attempt:
  // the render worker, whose wake retries are not failures of the call.
  function registerUpstreamHost(url, name, { perFetch = true } = {}) {
    try {
      const h = new URL(String(url)).host.toLowerCase().replace(/:\d+$/, "");
      if (!h || hosts.some(([m]) => m(h))) return false;
      hosts.push([(x) => x === h, String(name || h), perFetch !== false]);
      return true;
    } catch { return false; }
  }

  function noteTool(slug, status, { synthetic = false, shed = false, at = now() } = {}) {
    const s = String(slug || "");
    if (!s) return null;
    let m = tools.get(s);
    if (!m) { if (tools.size >= MAX_SLUGS) return null; m = new Map(); tools.set(s, m); }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = { o: emptyTool(), s: emptyTool() }; m.set(b, row); prune(m, at); }
    const klass = toolClassOf(status, { shed });
    row[synthetic ? "s" : "o"][TOOL_CLASSES.indexOf(klass)]++;
    return klass;
  }

  function noteToolMessage(slug, status, message, { synthetic = false, at = now() } = {}) {
    if (!(Number(status) >= 500)) return;
    const s = String(slug || "");
    if (!s || (!lastToolError.has(s) && lastToolError.size >= MAX_SLUGS)) return;
    lastToolError.set(s, { at, status: Number(status), message: String(message || "").slice(0, 200), synthetic: !!synthetic });
  }

  function noteUpstream(host, kind, { origin = "background", status = null, at = now() } = {}) {
    const name = upstreamNameOf(host);
    if (!name || !UPSTREAM_KINDS.includes(kind)) return null;
    let m = upstreams.get(name);
    if (!m) { if (upstreams.size >= MAX_UPSTREAMS) return null; m = new Map(); upstreams.set(name, m); }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = { o: emptyUp(), s: emptyUp(), b: emptyUp() }; m.set(b, row); prune(m, at); }
    const lane = origin === "synthetic" ? "s" : origin === "outside" ? "o" : "b";
    row[lane][UPSTREAM_KINDS.indexOf(kind)]++;
    if (kind !== "ok") lastUpstream.set(name, { at, kind, host: String(host).slice(0, 120), status });
    return name;
  }

  /** Observe one outbound fetch (the egress meter's observer). */
  function observeFetch(host, promise, init, origin) {
    if (!upstreamNameOf(host)) return;
    const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
    if (hosts.some(([m, , perFetch]) => !perFetch && m(h))) return;
    Promise.resolve(promise).then(
      (res) => { noteUpstream(host, upstreamKindOfStatus(res?.status), { origin, status: res?.status ?? null }); },
      (err) => { noteUpstream(host, upstreamKindOfError(err, init), { origin }); },
    );
  }

  function noteFacilitatorRefusal({ network, facilitator, reason, at = now() } = {}) {
    refusals.push({ at, network: String(network || "").slice(0, 64), facilitator: String(facilitator || "unknown").slice(0, 120), reason: String(reason || "").slice(0, 160) });
    while (refusals.length > MAX_REFUSALS) refusals.shift();
  }

  // ---- snapshots and the merge ----------------------------------------------
  function snapshot(t = now()) {
    const floor = bucketOf(t - DAY_MS);
    const pack = (m) => {
      const out = {};
      for (const [name, rows] of m) {
        const r = {};
        for (const [b, row] of rows) if (b > floor) r[b] = row;
        if (Object.keys(r).length) out[name] = r;
      }
      return out;
    };
    return {
      at: t,
      tools: pack(tools),
      upstreams: pack(upstreams),
      lastToolError: Object.fromEntries([...lastToolError].filter(([, v]) => v.at > t - DAY_MS)),
      lastUpstream: Object.fromEntries([...lastUpstream].filter(([, v]) => v.at > t - DAY_MS)),
      refusals: refusals.filter((r) => r.at > t - DAY_MS),
    };
  }

  async function publish(t = now()) {
    if (!store) return { ok: false, skipped: true };
    try { return await store.publish(id, JSON.stringify(snapshot(t)), t); } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
  }

  async function refreshRemote(t = now(), { maxAgeMs = REMOTE_MAX_AGE_MS } = {}) {
    if (!store) return remote;
    if (remote.at && t - remote.at < maxAgeMs) return remote;
    const staleMs = num(env.TOOL_FAILURE_REPLICA_STALE_MS, 10 * 60_000);
    try {
      const r = await store.readAll(t);
      // A replica that has not published within staleMs is gone.
      const snapshots = (r.snapshots || []).filter((s) => s.id !== id && Number(s.at) >= t - staleMs);
      remote = { at: t, ok: !!r.ok, snapshots, merged: r.ok ? mergeSnapshots(snapshots) : null };
    } catch { remote = { at: t, ok: false, snapshots: [], merged: null }; }
    return remote;
  }

  /** The live counts plus the other replicas' (merged once per remote read). */
  function merged(t = now()) {
    return mergeSnapshots([snapshot(t), ...(remote.ok && remote.merged ? [remote.merged] : [])]);
  }

  function mergeSnapshots(all) {
    const toolsM = {}, upM = {}, lastT = {}, lastU = {};
    const refs = [];
    for (const s of all) {
      for (const [slug, rows] of Object.entries(s.tools || {})) {
        const dst = (toolsM[slug] ||= {});
        for (const [b, row] of Object.entries(rows)) {
          const d = (dst[b] ||= { o: emptyTool(), s: emptyTool() });
          add(d.o, row.o); add(d.s, row.s);
        }
      }
      for (const [name, rows] of Object.entries(s.upstreams || {})) {
        const dst = (upM[name] ||= {});
        for (const [b, row] of Object.entries(rows)) {
          const d = (dst[b] ||= { o: emptyUp(), s: emptyUp(), b: emptyUp() });
          add(d.o, row.o); add(d.s, row.s); add(d.b, row.b);
        }
      }
      for (const [k, v] of Object.entries(s.lastToolError || {})) if (!lastT[k] || lastT[k].at < v.at) lastT[k] = v;
      for (const [k, v] of Object.entries(s.lastUpstream || {})) if (!lastU[k] || lastU[k].at < v.at) lastU[k] = v;
      for (const r of s.refusals || []) refs.push(r);
    }
    return { tools: toolsM, upstreams: upM, lastToolError: lastT, lastUpstream: lastU, refusals: refs.sort((a, b) => a.at - b.at) };
  }

  const sumWindow = (rows, lanes, size, sinceBucket) => {
    const out = {};
    for (const l of lanes) out[l] = Array(size).fill(0);
    for (const [b, row] of Object.entries(rows)) if (Number(b) > sinceBucket) for (const l of lanes) add(out[l], row[l]);
    return out;
  };
  const named = (keys, arr) => Object.fromEntries(keys.map((k, i) => [k, arr[i]]));

  /** The words and the per-slug, per-upstream rows. */
  function evaluate(t = now(), m = merged(t)) {
    const th = thresholds(env);
    // A bucket counts toward "the last hour" when its start is inside it.
    const hourFloor = bucketOf(t - HOUR_MS);
    const dayFloor = bucketOf(t - DAY_MS);
    const toolRows = [];
    let toolWord = "ok";
    for (const [slug, rows] of Object.entries(m.tools)) {
      const h = sumWindow(rows, ["o", "s"], TOOL_CLASSES.length, hourFloor);
      const d = sumWindow(rows, ["o", "s"], TOOL_CLASSES.length, dayFloor);
      const o = named(TOOL_CLASSES, h.o);
      const s5 = o.fail + o.timeout;
      const calls = o.ok + o.buyer + o.fail + o.timeout;
      let word = "ok";
      if (calls >= th.toolMinCalls && s5 / calls > th.toolFailRate) word = "failing";
      else if (s5 >= th.tool5xxDegraded) word = "degraded";
      if (word === "failing" || (word === "degraded" && toolWord === "ok")) toolWord = word;
      const anyFail = d.o[2] + d.o[3] + d.s[2] + d.s[3] > 0;
      if (!anyFail && word === "ok") continue;
      toolRows.push({
        slug, status: word,
        hour: { outside: o, synthetic: named(TOOL_CLASSES, h.s), outside5xx: s5, outsideCalls: calls },
        day: { outside: named(TOOL_CLASSES, d.o), synthetic: named(TOOL_CLASSES, d.s) },
        lastError: m.lastToolError[slug] ? { ...m.lastToolError[slug], at: new Date(m.lastToolError[slug].at).toISOString() } : null,
      });
    }
    const upRows = [];
    let upWord = "ok";
    for (const [name, rows] of Object.entries(m.upstreams)) {
      const h = sumWindow(rows, ["o", "s", "b"], UPSTREAM_KINDS.length, hourFloor);
      const d = sumWindow(rows, ["o", "s", "b"], UPSTREAM_KINDS.length, dayFloor);
      const counted = named(UPSTREAM_KINDS, add([...h.o], h.b));
      const fails = counted.s5xx + counted.timeout + counted.network;
      const calls = fails + counted.ok + counted.throttled;
      let word = "ok";
      if (fails >= th.upstreamDegraded) word = calls >= th.upstreamMinCalls && fails / calls > th.upstreamFailRate ? "failing" : "degraded";
      if (word === "failing" || (word === "degraded" && upWord === "ok")) upWord = word;
      upRows.push({
        upstream: name, status: word,
        hour: { outside: named(UPSTREAM_KINDS, h.o), background: named(UPSTREAM_KINDS, h.b), synthetic: named(UPSTREAM_KINDS, h.s), failures: fails, calls },
        day: { outside: named(UPSTREAM_KINDS, d.o), background: named(UPSTREAM_KINDS, d.b), synthetic: named(UPSTREAM_KINDS, d.s) },
        last: m.lastUpstream[name] ? { ...m.lastUpstream[name], at: new Date(m.lastUpstream[name].at).toISOString() } : null,
      });
    }
    const recent = m.refusals.filter((r) => r.at > t - th.fundsWindowMs);
    let demoted = [];
    try { demoted = isDemoted() || []; } catch { demoted = []; }
    const fundsWord = demoted.length ? "demoted" : recent.length ? "refused" : "ok";
    const rank = { failing: 0, degraded: 1, ok: 2 };
    toolRows.sort((a, b) => rank[a.status] - rank[b.status] || b.hour.outside5xx - a.hour.outside5xx || a.slug.localeCompare(b.slug));
    upRows.sort((a, b) => rank[a.status] - rank[b.status] || b.hour.failures - a.hour.failures || a.upstream.localeCompare(b.upstream));
    return {
      toolFailures: toolWord, upstreamHealth: upWord, facilitatorFunds: fundsWord,
      thresholds: th, tools: toolRows, upstreams: upRows,
      facilitatorRefusals: recent.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
      facilitatorRefusals24h: m.refusals.filter((r) => r.at > t - DAY_MS).length,
      demoted,
    };
  }

  async function recompute(t = now()) {
    await refreshRemote(t);
    cached = { at: t, e: evaluate(t) };
    return cached.e;
  }

  /** The last evaluation, at most REMOTE_MAX_AGE_MS old; a stale one is served
   *  while a single recompute runs after the response. */
  async function cachedEvaluation(t = now()) {
    if (cached && t - cached.at < REMOTE_MAX_AGE_MS) return cached.e;
    if (!cached) return recompute(t);
    if (!recomputing) {
      recomputing = true;
      setImmediate(() => { recompute().catch(() => {}).finally(() => { recomputing = false; }); });
    }
    return cached.e;
  }

  /** Words for /api/gateway-status (public: the word only). `fresh` recomputes
   *  now instead of reading the cache (tests and one-off reads). */
  async function status({ full = false, t = now(), fresh = false } = {}) {
    const e = fresh ? await recompute(t) : await cachedEvaluation(t);
    if (!full) return { toolFailures: { status: e.toolFailures }, upstreamHealth: { status: e.upstreamHealth }, facilitatorFunds: { status: e.facilitatorFunds } };
    const failingTools = e.tools.filter((r) => r.status !== "ok");
    const badUps = e.upstreams.filter((r) => r.status !== "ok");
    return {
      toolFailures: { status: e.toolFailures, tools: failingTools.map((r) => ({ slug: r.slug, status: r.status, outside5xx: r.hour.outside5xx, outsideCalls: r.hour.outsideCalls })) },
      upstreamHealth: { status: e.upstreamHealth, upstreams: badUps.map((r) => ({ upstream: r.upstream, status: r.status, failures: r.hour.failures, calls: r.hour.calls })) },
      facilitatorFunds: { status: e.facilitatorFunds, refusals1h: e.facilitatorRefusals.length, demoted: e.demoted },
    };
  }

  /** The operator endpoint's body. */
  async function report({ t = now() } = {}) {
    await refreshRemote(t, { maxAgeMs: 0 });
    const e = evaluate(t);
    const sharedOk = !!store && remote.ok;
    return {
      scope: sharedOk ? "shared" : "instance",
      replica: id,
      replicasRead: sharedOk ? remote.snapshots.length + 1 : 1,
      note: sharedOk ? "Counts merge every replica's latest snapshot (published every minute) with this process's live counts."
        : "Counts are this process's own (no shared store answered); another replica's failures are not in them.",
      bucketMinutes: BUCKET_MS / 60_000,
      ...e,
      // What the paging issue lists: names and words only.
      issueSummary: {
        tools: e.tools.filter((r) => r.status !== "ok").map((r) => `${r.slug} (${r.status})`),
        upstreams: e.upstreams.filter((r) => r.status !== "ok").map((r) => `${r.upstream.startsWith("facilitator:") ? "facilitator" : r.upstream} (${r.status})`),
        facilitatorNetworks: [...new Set(e.facilitatorRefusals.map((r) => r.network))],
      },
    };
  }

  let timer = null;
  function start(intervalMs = num(env.TOOL_FAILURE_PUBLISH_MS, 60_000)) {
    if (timer || !store) return false;
    timer = setInterval(() => { void publish(); }, intervalMs);
    timer.unref?.();
    return true;
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return {
    id, noteTool, noteToolMessage, noteUpstream, observeFetch, noteFacilitatorRefusal, registerUpstreamHost, upstreamNameOf,
    snapshot, publish, refreshRemote, merged, evaluate, status, report, start, stop,
    _reset() { tools.clear(); upstreams.clear(); lastToolError.clear(); lastUpstream.clear(); refusals.length = 0; remote = { at: 0, snapshots: [], ok: false, merged: null }; cached = null; },
  };
}

// ---- the process's instance ----------------------------------------------------
let singleton = null;
/** The process's monitor; the Redis store is attached when shared limits are on. */
export function toolFailureMonitor() {
  if (singleton) return singleton;
  singleton = createToolFailureMonitor({ store: lazyStore, isDemoted: () => demotedReader() });
  return singleton;
}
let demotedReader = () => [];
/** The settle-demotion module hands in its reader (avoids an import cycle). */
export function setDemotedReader(fn) { if (typeof fn === "function") demotedReader = fn; }

// Resolved on first use, so importing this module never opens a connection.
const lazyStore = {
  async publish(id, json, t) { const s = await realStore(); return s ? s.publish(id, json, t) : { ok: false }; },
  async readAll(t) { const s = await realStore(); return s ? s.readAll(t) : { ok: false, snapshots: [] }; },
};
let storePromise = null;
function realStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const sl = await import("./shared-limits.js");
      if (!sl.sharedLimitsEnabled()) return null;
      const { getSharedRedisClient } = await import("./shared-limit.js");
      const prefix = String(process.env.SHARED_LIMITS_PREFIX || "").trim().replace(/[^A-Za-z0-9_.-]/g, "");
      return redisSnapshotStore({ getClient: getSharedRedisClient, shared: sl.shared, keyPrefix: prefix ? `tfm:${prefix}` : "tfm" });
    })().catch(() => null);
  }
  return storePromise;
}
