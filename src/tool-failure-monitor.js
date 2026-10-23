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
//              canceled: a buyer who left, a drain). Split by origin:
//              outside (inside a buyer's request), synthetic, background (no
//              request: warmers, crawlers, timers).
//   facilitator refusals  a settle refused for an out-of-funds or billing
//              class, per network and facilitator label.
//   answers    per slug, every final 200 of a catalog route, by what the body
//              carries (src/answer-shape.js): ok, empty, error-shaped,
//              unchecked. Split by origin like the tool classes. The last few
//              non-ok answers per slug keep their reasons (field names only,
//              never a value or a payer). toolAnswers reads degraded when one
//              slug's outside empty-or-error-shaped share of its checked
//              answers reaches TOOL_ANSWER_BAD_RATE over the last hour (at
//              least TOOL_ANSWER_MIN_HOUR checked) or the last day (at least
//              TOOL_ANSWER_MIN_DAY). The operator view also lists live-data
//              slugs whose outside sales all returned one identical body
//              (the sales ledger's response_sha256; detail only, no word).
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
// Public surface: /api/gateway-status carries toolFailures, upstreamHealth,
// facilitatorFunds and toolAnswers as one word each. Slugs, upstream names, counts and
// messages are on /__operator/tool-failures.json only.
import { randomUUID } from "node:crypto";
import { ANSWER_CLASSES, identicalAnswerFlags } from "./answer-shape.js";
import { registerMemoryStore } from "./memory-stores.js";

export const BUCKET_MS = 5 * 60_000;
export const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
export const TOOL_CLASSES = ["ok", "buyer", "fail", "timeout", "payment", "gone", "shed"];
export const UPSTREAM_KINDS = ["ok", "s5xx", "timeout", "network", "throttled", "aborted"];
export const WORDS = ["ok", "degraded", "failing"];
export const FUNDS_WORDS = ["ok", "low", "refused", "demoted"];
export const ANSWER_WORDS = ["ok", "degraded"];
export { ANSWER_CLASSES };
const LAST_ANSWERS_PER_SLUG = 5;
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
    // A settlement signer's gas reading (src/facilitator-gas.js) counts while
    // it is this recent; an older one (its checker stopped) counts for nothing.
    gasFreshMs: num(env.FACILITATOR_GAS_FRESH_MS, 45 * 60_000),
    // toolAnswers degraded: one slug's outside empty + error-shaped share of
    // its checked 200s (ok + empty + error-shaped) at or above this rate,
    // over at least answerMinHour checked in 1 h or answerMinDay in 24 h.
    answerBadRate: num(env.TOOL_ANSWER_BAD_RATE, 0.5),
    answerMinHour: num(env.TOOL_ANSWER_MIN_HOUR, 10),
    answerMinDay: num(env.TOOL_ANSWER_MIN_DAY, 30),
    // Identical-answer detail: a live-data slug with at least this many
    // outside sales in the window, every one the same response digest.
    sameAnswerMinSales: num(env.TOOL_ANSWER_SAME_MIN_SALES, 5),
    sameAnswerWindowMs: num(env.TOOL_ANSWER_SAME_WINDOW_H, 24) * HOUR_MS,
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
const emptyAns = () => ANSWER_CLASSES.map(() => 0);
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

export function createToolFailureMonitor({ now = () => Date.now(), store = null, replicaId = null, env = process.env, isDemoted = () => [], identicalAnswers = () => [] } = {}) {
  const id = String(replicaId || env.RAILWAY_REPLICA_ID || randomUUID()).slice(0, 64);
  const tools = new Map();      // slug -> Map(bucket -> { o: [], s: [] })
  const upstreams = new Map();  // name -> Map(bucket -> { o: [], s: [], b: [] })
  const lastToolError = new Map(); // slug -> { at, status, message, synthetic }
  const answers = new Map();    // slug -> Map(bucket -> { o: [], s: [] }) over ANSWER_CLASSES
  const lastAnswer = new Map(); // slug -> [{ at, klass, reasons, synthetic }] (non-ok, newest last)
  const lastUpstream = new Map();  // name -> { at, kind, host, status }
  const refusals = [];          // { at, network, facilitator, reason }
  let relayerGas = [];          // the last gas check's readings (src/facilitator-gas.js)
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

  /** Count one final 200's answer class (src/answer-shape.js classifyAnswer). */
  function noteAnswer(slug, klass, { synthetic = false, reasons = [], at = now() } = {}) {
    const s = String(slug || "");
    const i = ANSWER_CLASSES.indexOf(klass);
    if (!s || i < 0) return null;
    let m = answers.get(s);
    if (!m) { if (answers.size >= MAX_SLUGS) return null; m = new Map(); answers.set(s, m); }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = { o: emptyAns(), s: emptyAns() }; m.set(b, row); prune(m, at); }
    row[synthetic ? "s" : "o"][i]++;
    if (klass !== "ok") {
      const list = lastAnswer.get(s) || [];
      list.push({ at, klass, reasons: (Array.isArray(reasons) ? reasons : []).slice(0, 8).map((r) => String(r).slice(0, 64)), synthetic: !!synthetic });
      while (list.length > LAST_ANSWERS_PER_SLUG) list.shift();
      lastAnswer.set(s, list);
    }
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

  /** The latest settlement-signer gas readings, replacing the previous set. */
  function noteRelayerGas(readings = []) {
    relayerGas = (Array.isArray(readings) ? readings : []).slice(0, 50).map((r) => ({
      network: String(r?.network || "").slice(0, 64),
      facilitator: String(r?.facilitator || "unknown").slice(0, 120),
      signer: r?.signer ? String(r.signer).slice(0, 64) : null,
      balanceEth: Number.isFinite(r?.balanceEth) ? r.balanceEth : null,
      runway: Number.isFinite(r?.runway) ? r.runway : null,
      status: ["ok", "low", "unread", "unknown"].includes(r?.status) ? r.status : "unread",
      ...(r?.error ? { error: String(r.error).slice(0, 120) } : {}),
      at: Number(r?.at) || now(),
    }));
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
      answers: pack(answers),
      lastAnswer: Object.fromEntries([...lastAnswer].map(([k, v]) => [k, v.filter((x) => x.at > t - DAY_MS)]).filter(([, v]) => v.length)),
      lastToolError: Object.fromEntries([...lastToolError].filter(([, v]) => v.at > t - DAY_MS)),
      lastUpstream: Object.fromEntries([...lastUpstream].filter(([, v]) => v.at > t - DAY_MS)),
      refusals: refusals.filter((r) => r.at > t - DAY_MS),
      gas: relayerGas.filter((r) => r.at > t - DAY_MS),
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
    const toolsM = {}, upM = {}, lastT = {}, lastU = {}, ansM = {}, lastA = {};
    const refs = [];
    const gasM = {}; // newest reading per (network, facilitator, signer)
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
      for (const [slug, rows] of Object.entries(s.answers || {})) {
        const dst = (ansM[slug] ||= {});
        for (const [b, row] of Object.entries(rows)) {
          const d = (dst[b] ||= { o: emptyAns(), s: emptyAns() });
          add(d.o, row.o); add(d.s, row.s);
        }
      }
      for (const [k, v] of Object.entries(s.lastAnswer || {})) if (Array.isArray(v)) (lastA[k] ||= []).push(...v);
      for (const [k, v] of Object.entries(s.lastToolError || {})) if (!lastT[k] || lastT[k].at < v.at) lastT[k] = v;
      for (const [k, v] of Object.entries(s.lastUpstream || {})) if (!lastU[k] || lastU[k].at < v.at) lastU[k] = v;
      for (const r of s.refusals || []) refs.push(r);
      for (const r of s.gas || []) {
        const k = `${r.network}|${r.facilitator}|${r.signer || ""}`;
        if (!gasM[k] || gasM[k].at < r.at) gasM[k] = r;
      }
    }
    for (const k of Object.keys(lastA)) lastA[k] = lastA[k].sort((a, b) => a.at - b.at).slice(-LAST_ANSWERS_PER_SLUG);
    return { tools: toolsM, upstreams: upM, answers: ansM, lastAnswer: lastA, lastToolError: lastT, lastUpstream: lastU, refusals: refs.sort((a, b) => a.at - b.at), gas: Object.values(gasM) };
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
    const ansRows = [];
    let ansWord = "ok";
    const shareOf = (c) => ({ checked: c.ok + c.empty + c["error-shaped"], bad: c.empty + c["error-shaped"] });
    const over = (x, min) => x.checked >= min && x.bad / x.checked >= th.answerBadRate;
    // Every slug's answers summed, so the operator sees what was read even
    // when nothing was flagged.
    const totals = { hour: { o: emptyAns(), s: emptyAns() }, day: { o: emptyAns(), s: emptyAns() } };
    for (const [slug, rows] of Object.entries(m.answers || {})) {
      const h = sumWindow(rows, ["o", "s"], ANSWER_CLASSES.length, hourFloor);
      const d = sumWindow(rows, ["o", "s"], ANSWER_CLASSES.length, dayFloor);
      add(totals.hour.o, h.o); add(totals.hour.s, h.s); add(totals.day.o, d.o); add(totals.day.s, d.s);
      const ho = named(ANSWER_CLASSES, h.o), dO = named(ANSWER_CLASSES, d.o);
      const hs = shareOf(ho), ds = shareOf(dO);
      const word = over(hs, th.answerMinHour) || over(ds, th.answerMinDay) ? "degraded" : "ok";
      if (word === "degraded") ansWord = "degraded";
      const anyBad = d.o[1] + d.o[2] + d.s[1] + d.s[2] > 0;
      if (!anyBad && word === "ok") continue;
      ansRows.push({
        slug, status: word,
        hour: { outside: ho, synthetic: named(ANSWER_CLASSES, h.s), outsideChecked: hs.checked, outsideBad: hs.bad },
        day: { outside: dO, synthetic: named(ANSWER_CLASSES, d.s), outsideChecked: ds.checked, outsideBad: ds.bad },
        last: (m.lastAnswer?.[slug] || []).map((x) => ({ ...x, at: new Date(x.at).toISOString() })),
      });
    }
    const recent = m.refusals.filter((r) => r.at > t - th.fundsWindowMs);
    let demoted = [];
    try { demoted = isDemoted() || []; } catch { demoted = []; }
    // Gas runway of the facilitators' settlement signers: low, or unreadable
    // past the checker's retries, reads "low" (a warning before refusals). A
    // facilitator that publishes no signer ("unknown") has nothing to watch
    // and never pages.
    const gas = (m.gas || []).filter((r) => r.at > t - th.gasFreshMs);
    const gasLow = gas.filter((r) => r.status === "low" || r.status === "unread");
    const fundsWord = demoted.length ? "demoted" : recent.length ? "refused" : gasLow.length ? "low" : "ok";
    const rank = { failing: 0, degraded: 1, ok: 2 };
    toolRows.sort((a, b) => rank[a.status] - rank[b.status] || b.hour.outside5xx - a.hour.outside5xx || a.slug.localeCompare(b.slug));
    upRows.sort((a, b) => rank[a.status] - rank[b.status] || b.hour.failures - a.hour.failures || a.upstream.localeCompare(b.upstream));
    ansRows.sort((a, b) => rank[a.status] - rank[b.status] || b.day.outsideBad - a.day.outsideBad || a.slug.localeCompare(b.slug));
    return {
      toolFailures: toolWord, upstreamHealth: upWord, facilitatorFunds: fundsWord, toolAnswers: ansWord,
      thresholds: th, tools: toolRows, upstreams: upRows, answers: ansRows,
      answerTotals: Object.fromEntries(Object.entries(totals).map(([w, v]) => [w, { outside: named(ANSWER_CLASSES, v.o), synthetic: named(ANSWER_CLASSES, v.s) }])),
      facilitatorRefusals: recent.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
      facilitatorRefusals24h: m.refusals.filter((r) => r.at > t - DAY_MS).length,
      demoted,
      relayerGas: gas.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
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
    if (!full) return { toolFailures: { status: e.toolFailures }, upstreamHealth: { status: e.upstreamHealth }, facilitatorFunds: { status: e.facilitatorFunds }, toolAnswers: { status: e.toolAnswers } };
    const failingTools = e.tools.filter((r) => r.status !== "ok");
    const badUps = e.upstreams.filter((r) => r.status !== "ok");
    return {
      toolFailures: { status: e.toolFailures, tools: failingTools.map((r) => ({ slug: r.slug, status: r.status, outside5xx: r.hour.outside5xx, outsideCalls: r.hour.outsideCalls })) },
      upstreamHealth: { status: e.upstreamHealth, upstreams: badUps.map((r) => ({ upstream: r.upstream, status: r.status, failures: r.hour.failures, calls: r.hour.calls })) },
      facilitatorFunds: { status: e.facilitatorFunds, refusals1h: e.facilitatorRefusals.length, demoted: e.demoted, relayersLow: e.relayerGas.filter((r) => r.status === "low").length, relayersUnread: e.relayerGas.filter((r) => r.status === "unread").length },
      toolAnswers: { status: e.toolAnswers, tools: e.answers.filter((r) => r.status !== "ok").map((r) => ({ slug: r.slug, status: r.status, outsideBad1h: r.hour.outsideBad, outsideChecked1h: r.hour.outsideChecked, outsideBad24h: r.day.outsideBad, outsideChecked24h: r.day.outsideChecked })) },
    };
  }

  /** The operator endpoint's body. */
  async function report({ t = now() } = {}) {
    await refreshRemote(t, { maxAgeMs: 0 });
    const e = evaluate(t);
    const sharedOk = !!store && remote.ok;
    // Identical answers: read on the operator's request only (one grouped
    // query over the window), never for the public word.
    let identical = { slugs: [], read: false };
    try {
      const rows = await identicalAnswers({ sinceMs: t - e.thresholds.sameAnswerWindowMs, untilMs: t + 1 });
      identical = { slugs: identicalAnswerFlags(rows, { minSales: e.thresholds.sameAnswerMinSales }), read: true };
    } catch { identical = { slugs: [], read: false }; }
    return {
      scope: sharedOk ? "shared" : "instance",
      replica: id,
      replicasRead: sharedOk ? remote.snapshots.length + 1 : 1,
      note: sharedOk ? "Counts merge every replica's latest snapshot (published every minute) with this process's live counts."
        : "Counts are this process's own (no shared store answered); another replica's failures are not in them.",
      bucketMinutes: BUCKET_MS / 60_000,
      ...e,
      identicalAnswers: { windowHours: e.thresholds.sameAnswerWindowMs / HOUR_MS, minSales: e.thresholds.sameAnswerMinSales, read: identical.read, slugs: identical.slugs },
      // Names and words, for the operator (public issues carry the word only).
      issueSummary: {
        tools: e.tools.filter((r) => r.status !== "ok").map((r) => `${r.slug} (${r.status})`),
        upstreams: e.upstreams.filter((r) => r.status !== "ok").map((r) => `${r.upstream.startsWith("facilitator:") ? "facilitator" : r.upstream} (${r.status})`),
        facilitatorNetworks: [...new Set([...e.facilitatorRefusals.map((r) => r.network), ...e.relayerGas.filter((r) => r.status === "low" || r.status === "unread").map((r) => r.network)])],
        answers: e.answers.filter((r) => r.status !== "ok").map((r) => `${r.slug} (${r.status})`),
        identicalAnswers: identical.slugs.map((r) => r.slug),
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
    id, noteTool, noteAnswer, noteToolMessage, noteUpstream, observeFetch, noteFacilitatorRefusal, noteRelayerGas, registerUpstreamHost, upstreamNameOf,
    snapshot, publish, refreshRemote, merged, evaluate, status, report, start, stop,
    _reset() { tools.clear(); upstreams.clear(); answers.clear(); lastAnswer.clear(); lastToolError.clear(); lastUpstream.clear(); refusals.length = 0; relayerGas = []; remote = { at: 0, snapshots: [], ok: false, merged: null }; cached = null; },
  };
}

// ---- the process's instance ----------------------------------------------------
let singleton = null;
/** The process's monitor; the Redis store is attached when shared limits are on. */
export function toolFailureMonitor() {
  if (singleton) return singleton;
  singleton = createToolFailureMonitor({ store: lazyStore, isDemoted: () => demotedReader(), identicalAnswers: (w) => identicalAnswerReader(w) });
  return singleton;
}
let demotedReader = () => [];
/** The settle-demotion module hands in its reader (avoids an import cycle). */
export function setDemotedReader(fn) { if (typeof fn === "function") demotedReader = fn; }
let identicalAnswerReader = () => [];
/** The server hands in the sales-ledger read, already narrowed to live-data
 *  slugs: ({ sinceMs, untilMs }) -> [{ slug, sales, distinctAnswers, payers }]. */
export function setIdenticalAnswerReader(fn) { if (typeof fn === "function") identicalAnswerReader = fn; }

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

// Operator heap read (/__operator/heap.json `stores`).
registerMemoryStore("tool-failure-monitor", () => singleton, { note: "failure buckets" });
