// Per-tool and per-upstream failure counts, and the words that page on them.
//
// Every tool failure was already logged ("[tool-error]", "[paid-timing]"), but
// nothing counted them over time, so a tool or an upstream could fail for a
// day before anyone read the log. This module counts:
//   tools      per slug, every answer of a catalog route that reached its
//              dispatcher, by class: ok (< 400), buyer (4xx), fail (5xx other
//              than 504), timeout (504), payment (402 after the handler: a
//              settle refusal), gone (499: the buyer left), shed (load shed or
//              drain; never a tool failure). Split by origin: outside (a buyer),
//              synthetic (heartbeat token, status probe, our own wallets) or
//              free (an outside call the proof-of-work or trial gate accepted:
//              shown on the operator view, never read by the toolFailures
//              word). Each outcome carries its payment rail, counted per rail
//              as operator detail.
//   upstreams  per named upstream host, every outbound fetch the egress
//              meter sees, by outcome: ok, s5xx, timeout (the transport's own
//              connect or socket timeout), network (refused or reset before
//              an answer, or a host name that does not resolve), throttled (429), aborted (the caller canceled: a
//              buyer who left, a drain), deadline (our own deadline passed:
//              an AbortSignal.timeout of ours, a health check's limit, a
//              handler budget) and egress (our side could not finish a
//              lookup or route to the host: resolver, no route). aborted, deadline and egress
//              prove nothing about the upstream: they are shown on the
//              operator view and never counted as its failure. One pattern of
//              them is read: our deadline firing on ONE upstream on many
//              calls from several callers in a window while another upstream
//              answers in the same buckets (src/unanswered-rule.js) reads
//              upstreamHealth unanswered ("did not answer within our limit");
//              most upstreams held at once is our side and names none
//              (ourSide). Split by
//              origin: outside (inside a buyer's request), synthetic,
//              background (no request: warmers, crawlers, timers).
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
//   replays    per slug, every answer the idempotency middleware served from
//              its store (src/idempotency.js): implicit (a re-sent x402
//              payment, same nonce) or keyed (an Idempotency-Key or
//              payment-identifier). Detail only, never a word; by slug,
//              never by payer.
//   funding refusals  a Solana verify refused because the paying wallet has
//              no USDC token account or too little USDC
//              (src/svm-funding-refusal.js), by network and reason, split
//              into refused (the facilitator said so) and held (answered from
//              the funding hold without a verify). Detail only, never a word.
//   pending settles  per network and facilitator, every settle answered
//              pending with a transaction that src/pending-settle.js read on
//              chain, by outcome (PENDING_OUTCOMES): recovered, settled
//              by the same facilitator's own retry, settled by another
//              facilitator (fallbackSettled: the pending answers stay
//              counted), or not recovered and why (not mined, reverted, wrong
//              transfer, RPC error, buyer gone, no time, capped, rate limited,
//              already sold, held elsewhere, ledger error), plus
//              forgivenPending: each pending 5xx answer moved back to ok in
//              the upstream count. A network and facilitator pair whose
//              counts have all aged out is evicted; past MAX_PENDING_KEYS
//              live pairs a new pair's outcome is dropped and counted
//              (`dropped`). Detail only, never a word.
//   buyer refusals  a settle-breaker refusal (src/gateway-settle-breaker.js)
//              of a key that had settled at least one call inside the
//              breaker's window: a paying buyer was turned away. A count per
//              bucket with no slug and no key. buyerRefusals reads refusing
//              while one landed in a bucket that ended inside the last
//              BUYER_REFUSAL_WINDOW_MS (15 minutes), so the word holds for 15
//              to 20 minutes after the refusal; ok otherwise.
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
// facilitatorFunds, toolAnswers and buyerRefusals as one word each. Slugs,
// upstream names, counts and messages are on /__operator/tool-failures.json only.
import { randomUUID } from "node:crypto";
import { ANSWER_CLASSES, identicalAnswerFlags } from "./answer-shape.js";
import { registerMemoryStore } from "./memory-stores.js";
import { salePathGroup } from "./sale-path.js";
import { positiveNum as num } from "./env-num.js";
import { unansweredSettings, callerOf } from "./unanswered-rule.js";

// The cap src/upstream-deadline.js records on the signal it sends (the same
// registered symbol, read here without importing that module).
const LIMIT_MS = Symbol.for("agent402.upstreamLimitMs");
const HEAVY_INPUT_MARK = Symbol.for("agent402.upstreamHeavyInput");
const secondsOfMs = (ms) => String(Math.max(1, Math.round(ms / 1000)));

export const BUCKET_MS = 5 * 60_000;
export const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
export const TOOL_CLASSES = ["ok", "buyer", "fail", "timeout", "payment", "gone", "shed"];
// Appended only: replicas publish these as positional arrays, so an older
// replica's snapshot (fewer kinds) still merges.
export const UPSTREAM_KINDS = ["ok", "s5xx", "timeout", "network", "throttled", "aborted", "deadline", "egress"];
/** The kinds upstreamHealth counts as the upstream's own failure. */
export const UPSTREAM_FAILURE_KINDS = Object.freeze(["s5xx", "timeout", "network"]);
export const WORDS = ["ok", "degraded", "failing"];
export const REPLAY_KINDS = ["implicit", "keyed"];
/** Pending-settle outcomes (src/pending-settle.js), in count order. */
export const PENDING_OUTCOMES = ["recovered", "retrySettled", "notMined", "reverted", "wrongTransfer", "rpcError", "buyerGone", "noTime", "capped", "rateLimited", "alreadySold", "heldElsewhere", "ledgerError", "forgivenPending", "fallbackSettled"];
// Rails whose outcomes count on the free lane: no payment was taken, so a free
// caller's 5xx is shown, and pages only when nearly every free call to a tool
// fails over many calls (freeFailRate over freeMinCalls), which is a broken
// tool rather than one caller's inputs.
export const FREE_RAILS = new Set(["pow", "trial"]);
/** The lane an outcome counts on: s (ours), f (free rail) or o (outside buyer). */
export function toolLaneOf({ synthetic = false, rail = null } = {}) {
  if (synthetic) return "s";
  return FREE_RAILS.has(String(rail || "")) ? "f" : "o";
}
export { ANSWER_CLASSES };
const LAST_ANSWERS_PER_SLUG = 5;
const MAX_SLUGS = 2_000;
const MAX_PATHS = 64;
const MAX_RAILS = 16;
const MAX_UPSTREAMS = 200;
const MAX_REFUSALS = 200;
const MAX_PENDING_KEYS = 64;
const REMOTE_MAX_AGE_MS = 30_000;

export function thresholds(env = process.env) {
  return {
    // degraded: one tool answered at least this many outside-buyer 5xx in 1 h.
    tool5xxDegraded: num(env.TOOL_FAIL_DEGRADED_5XX, 3),
    // failing: one tool's outside 5xx share passed this over at least minCalls in 1 h.
    toolFailRate: num(env.TOOL_FAIL_RATE, 0.25),
    toolMinCalls: num(env.TOOL_FAIL_MIN_CALLS, 8),
    // failing: one tool's free-lane 5xx share reached this over at least
    // freeMinCalls free calls in 1 h.
    freeFailRate: num(env.TOOL_FREE_FAIL_RATE, 0.9),
    freeMinCalls: num(env.TOOL_FREE_FAIL_MIN_CALLS, 20),
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
    // buyerRefusals reads refusing while a refused paying buyer landed in a
    // bucket that ended inside this window.
    buyerRefusalWindowMs: num(env.BUYER_REFUSAL_WINDOW_MS, 15 * 60_000),
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
// Our side could not finish a lookup or route to the host: no answer from it
// at all. A name answered "no such name" (ENOTFOUND, EAI_NONAME, EAI_NODATA)
// is not here: the host's own name not resolving counts as `network`, so a
// vendor whose domain stops resolving still drives upstreamHealth.
const EGRESS_CODES = new Set(["EAI_AGAIN", "EAI_FAIL", "ESERVFAIL", "EREFUSED", "ETIMEOUT", "ECANCELLED", "EDNSLOOKUPTIMEOUT", "EDNSUNAVAILABLE", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EADDRNOTAVAIL"]);
/** The outcome of an outbound fetch from its rejection (or null for a response). */
export function upstreamKindOfError(err, init) {
  const reason = init?.signal?.reason;
  const code = err?.cause?.code || err?.code;
  // An error already classed by src/upstream-deadline.js: every class but
  // "unreachable" is a deadline of ours (its cap, the handler budget).
  if (typeof err?.upstreamFailure === "string" && err.upstreamFailure !== "unreachable") return "deadline";
  // A TimeoutError is an AbortSignal.timeout of ours firing (a per-read cap,
  // a health check's limit), not an answer from the upstream.
  if (err?.name === "TimeoutError" || reason?.name === "TimeoutError") return "deadline";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  if (EGRESS_CODES.has(code)) return "egress";
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
const NO_OUTCOME = Symbol.for("agent402.noOutcome");

const FIXED_UPSTREAMS = [
  [/(^|\.)databento\.com$/, "databento"],
  [/(^|\.)stlouisfed\.org$/, "fred"],
  [/(^|\.)hyperliquid\.xyz$/, "hyperliquid"],
  [/(^|\.)rugcheck\.xyz$/, "rugcheck"],
  [/(^|\.)sec\.gov$/, "edgar"],
  [/(^|\.)exa\.ai$/, "exa"],
  [/(^|\.)openrouter\.ai$/, "openrouter"],
  // The CDP data API (onchain-sql, balances, onramp). Its facilitator shares
  // the host and is registered by path at boot, so only calls outside that
  // path land here.
  [/^api\.cdp\.coinbase\.com$/, "cdp-data"],
];

const emptyTool = () => TOOL_CLASSES.map(() => 0);
const emptyUp = () => UPSTREAM_KINDS.map(() => 0);
const emptyAns = () => ANSWER_CLASSES.map(() => 0);
const emptyReplay = () => REPLAY_KINDS.map(() => 0);
const emptyPending = () => PENDING_OUTCOMES.map(() => 0);
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
  const replays = new Map();    // slug -> Map(bucket -> [implicit, keyed])
  const buyerRefusals = new Map(); // bucket -> count (no slug, no key)
  const fundingRefusals = new Map(); // "network|reason" -> Map(bucket -> [refused, held])
  const pendingSettles = new Map(); // "network|facilitator" -> Map(bucket -> counts over PENDING_OUTCOMES)
  const pendingDrops = new Map();   // bucket -> outcomes dropped at MAX_PENDING_KEYS
  const paths = new Map();      // arrival path group (src/sale-path.js) -> Map(bucket -> { o: [], s: [], f: [] })
  const rails = new Map();      // payment rail -> Map(bucket -> { o: [], s: [], f: [] })
  let relayerGas = [];          // the last gas check's readings (src/facilitator-gas.js)
  const hosts = [];             // [matcher(host, path) -> bool, name, perFetch, key]
  let remote = { at: 0, snapshots: [], ok: false, merged: null };
  let cached = null;      // { at, e }: the last evaluation the words are read from
  let recomputing = false;

  const bucketOf = (t) => Math.floor(t / BUCKET_MS);
  const prune = (m, t) => { const floor = bucketOf(t - DAY_MS); for (const k of m.keys()) if (k <= floor) m.delete(k); };

  // `path` is the request path when the caller has it (the egress observer);
  // a host registered by path then names only calls under that path. Without
  // a path (a caller that knows only the host, such as a facilitator's
  // pending answer), the registered host's name is read.
  function upstreamNameOf(host, path = null) {
    const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
    if (!h) return null;
    for (const [match, name] of hosts) if (match(h, path)) return name;
    for (const [re, name] of FIXED_UPSTREAMS) if (re.test(h)) return name;
    return null;
  }

  // `perFetch: false` names a host whose caller reports one final outcome per
  // call (noteUpstream) instead of the egress meter counting every attempt:
  // the render worker, whose wake retries are not failures of the call.
  // `byPath: true` names only calls under the URL's path (a facilitator that
  // shares its host with a data API), when the caller knows the path.
  function registerUpstreamHost(url, name, { perFetch = true, byPath = false } = {}) {
    try {
      const u = new URL(String(url));
      const h = u.host.toLowerCase().replace(/:\d+$/, "");
      const prefix = byPath ? u.pathname.replace(/\/+$/, "") : "";
      const key = `${h}${prefix}`;
      if (!h || hosts.some(([, , , k]) => k === key)) return false;
      const under = (p) => !prefix || p === null || p === undefined || String(p) === prefix || String(p).startsWith(`${prefix}/`);
      hosts.push([(x, p) => x === h && under(p), String(name || h), perFetch !== false, key]);
      return true;
    } catch { return false; }
  }

  function noteTool(slug, status, { synthetic = false, shed = false, at = now(), path = null, rail = null } = {}) {
    const s = String(slug || "");
    if (!s) return null;
    let m = tools.get(s);
    if (!m) { if (tools.size >= MAX_SLUGS) return null; m = new Map(); tools.set(s, m); }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = { o: emptyTool(), s: emptyTool(), f: emptyTool() }; m.set(b, row); prune(m, at); }
    const klass = toolClassOf(status, { shed });
    const lane = toolLaneOf({ synthetic, rail });
    (row[lane] ||= emptyTool())[TOOL_CLASSES.indexOf(klass)]++;
    // The same outcome by payment rail (operator detail only).
    const r = String(rail || "none").slice(0, 32);
    let rm = rails.get(r);
    if (!rm && rails.size < MAX_RAILS) { rm = new Map(); rails.set(r, rm); }
    if (rm) {
      let rr = rm.get(b);
      if (!rr) { rr = { o: emptyTool(), s: emptyTool(), f: emptyTool() }; rm.set(b, rr); prune(rm, at); }
      rr[lane][TOOL_CLASSES.indexOf(klass)]++;
    }
    // The same outcome by arrival path (operator detail only): the group, so
    // client versions share one row.
    if (path) {
      const g = salePathGroup(path);
      let pm = paths.get(g);
      if (!pm && paths.size < MAX_PATHS) { pm = new Map(); paths.set(g, pm); }
      if (pm) {
        let pr = pm.get(b);
        if (!pr) { pr = { o: emptyTool(), s: emptyTool(), f: emptyTool() }; pm.set(b, pr); prune(pm, at); }
        (pr[lane] ||= emptyTool())[TOOL_CLASSES.indexOf(klass)]++;
      }
    }
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

  function noteUpstream(host, kind, { origin = "background", status = null, at = now(), path = null, caller = null, limitMs = null, heavy = false } = {}) {
    const name = upstreamNameOf(host, path);
    if (!name || !UPSTREAM_KINDS.includes(kind)) return null;
    let m = upstreams.get(name);
    if (!m) { if (upstreams.size >= MAX_UPSTREAMS) return null; m = new Map(); upstreams.set(name, m); }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = { o: emptyUp(), s: emptyUp(), b: emptyUp() }; m.set(b, row); prune(m, at); }
    const lane = origin === "synthetic" ? "s" : origin === "outside" ? "o" : "b";
    row[lane][UPSTREAM_KINDS.indexOf(kind)]++;
    // Who our deadline fired for (a caller key, never an address), outside
    // the synthetic lane: the unanswered rule needs several callers.
    if (kind === "deadline" && lane !== "s") {
      const c = callerOf(caller);
      const dc = (row.dc ||= []);
      if (dc.length < 32 && !dc.includes(c)) dc.push(c);
      // A deadline on an input long enough to outlast our limit (`hv`): it
      // still counts toward the several-callers rule, never toward the rule
      // that needs no second caller.
      if (heavy) row.hv = (row.hv || 0) + 1;
    }
    const limit = kind === "deadline" && Number(limitMs) > 0 ? Math.round(Number(limitMs)) : null;
    if (kind !== "ok") lastUpstream.set(name, { at, kind, host: String(host).slice(0, 120), status, ...(limit ? { limitMs: limit } : {}) });
    return name;
  }

  /**
   * Move one `kind` outcome counted for `host` at `at` back to ok: a call the
   * fetch observer counted as failed whose outcome later proved good (a
   * facilitator's pending 5xx whose transfer was then read mined,
   * src/pending-settle.js). `origin` is the lane the call was counted in
   * (outside, synthetic, background), and only that lane is touched. Answers
   * whether a count was moved.
   */
  function forgiveUpstream(host, kind, { at = now(), origin = "outside" } = {}) {
    const name = upstreamNameOf(host);
    const i = UPSTREAM_KINDS.indexOf(kind);
    if (!name || i < 0 || kind === "ok") return false;
    const m = upstreams.get(name);
    if (!m) return false;
    const lane = origin === "synthetic" ? "s" : origin === "outside" ? "o" : "b";
    // The observer counted the answer when it arrived; `at` is read later,
    // when the settle returned, so the count may sit in the bucket before.
    // One count is moved at most, from the newer bucket first.
    for (const b of [bucketOf(at), bucketOf(at) - 1]) {
      const row = m.get(b);
      if (row?.[lane]?.[i] > 0) { row[lane][i]--; row[lane][0]++; return true; }
    }
    return false;
  }

  /** Count one pending-settle outcome (src/pending-settle.js PENDING_OUTCOMES). */
  function notePendingSettle({ network, facilitator, outcome, at = now(), n = 1 } = {}) {
    const i = PENDING_OUTCOMES.indexOf(outcome);
    if (i < 0) return null;
    const k = `${String(network || "unknown").slice(0, 64)}|${String(facilitator || "unknown").slice(0, 120)}`;
    let m = pendingSettles.get(k);
    if (!m) {
      // A pair whose counts have all aged out holds no slot.
      if (pendingSettles.size >= MAX_PENDING_KEYS) for (const [pk, pm] of pendingSettles) { prune(pm, at); if (!pm.size) pendingSettles.delete(pk); }
      if (pendingSettles.size >= MAX_PENDING_KEYS) {
        const db = bucketOf(at);
        pendingDrops.set(db, (pendingDrops.get(db) || 0) + 1);
        prune(pendingDrops, at);
        return null;
      }
      m = new Map(); pendingSettles.set(k, m);
    }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = emptyPending(); m.set(b, row); prune(m, at); }
    row[i] += Math.max(1, Math.floor(Number(n) || 1));
    return outcome;
  }

  /** Observe one outbound fetch (the egress meter's observer). */
  function observeFetch(host, promise, init, origin, path = null, caller = null) {
    // A read that marks itself as not an upstream outcome (the model list,
    // src/model-catalog.js) is not counted.
    if (init && init[NO_OUTCOME]) return;
    if (!upstreamNameOf(host, path)) return;
    const h = String(host || "").toLowerCase().replace(/:\d+$/, "");
    if (hosts.some(([m, , perFetch]) => !perFetch && m(h, path))) return;
    Promise.resolve(promise).then(
      (res) => { noteUpstream(host, upstreamKindOfStatus(res?.status), { origin, status: res?.status ?? null, path }); },
      (err) => {
        const kind = upstreamKindOfError(err, init);
        // `caller` is the request's caller key or a function that reads it
        // (hashed only for a deadline, the one kind that keeps it).
        let who = null;
        if (kind === "deadline") { try { who = typeof caller === "function" ? caller() : caller; } catch { /* no key */ } }
        noteUpstream(host, kind, { origin, path, caller: who, limitMs: init?.signal?.[LIMIT_MS] ?? null, heavy: kind === "deadline" && init?.signal?.[HEAVY_INPUT_MARK] === true });
      },
    );
  }

  /** The latest settlement-signer gas readings, replacing the previous set. */
  // `network` given: only that network's rows are replaced, so one gas
  // check per listed-facilitator rail keeps the other's readings.
  function noteRelayerGas(readings = [], { network = null } = {}) {
    const keep = network ? relayerGas.filter((r) => r.network !== String(network)) : [];
    relayerGas = [...keep, ...(Array.isArray(readings) ? readings : []).slice(0, 50).map((r) => ({
      network: String(r?.network || "").slice(0, 64),
      facilitator: String(r?.facilitator || "unknown").slice(0, 120),
      signer: r?.signer ? String(r.signer).slice(0, 64) : null,
      ...(r?.own === true ? { own: true } : {}),
      balanceEth: Number.isFinite(r?.balanceEth) ? r.balanceEth : null,
      runway: Number.isFinite(r?.runway) ? r.runway : null,
      status: ["ok", "low", "unread", "unknown"].includes(r?.status) ? r.status : "unread",
      ...(r?.error ? { error: String(r.error).slice(0, 120) } : {}),
      ...(r?.reason ? { reason: String(r.reason).slice(0, 40) } : {}),
      ...(["gasUsd", "floorUsd", "sharePct", "ethUsd"].reduce((o, k) => (Number.isFinite(r?.[k]) ? { ...o, [k]: r[k] } : o), {})),
      at: Number(r?.at) || now(),
    }))].slice(-100);
  }

  function noteFacilitatorRefusal({ network, facilitator, reason, at = now() } = {}) {
    refusals.push({ at, network: String(network || "").slice(0, 64), facilitator: String(facilitator || "unknown").slice(0, 120), reason: String(reason || "").slice(0, 160) });
    while (refusals.length > MAX_REFUSALS) refusals.shift();
  }

  /** One answer the idempotency middleware served from its store, by slug. */
  function noteReplay(slug, { implicit = false, at = now() } = {}) {
    const s = String(slug || "");
    if (!s) return null;
    let m = replays.get(s);
    if (!m) { if (replays.size >= MAX_SLUGS) return null; m = new Map(); replays.set(s, m); }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = emptyReplay(); m.set(b, row); prune(m, at); }
    row[implicit ? 0 : 1]++;
    return implicit ? "implicit" : "keyed";
  }

  /** The settle breaker refused a key that had settled a call in its window. */
  function noteBuyerRefusal({ at = now() } = {}) {
    const b = bucketOf(at);
    buyerRefusals.set(b, (buyerRefusals.get(b) || 0) + 1);
    prune(buyerRefusals, at);
    return buyerRefusals.get(b);
  }

  /** A Solana funding refusal (src/svm-funding-refusal.js): refused by the
   *  facilitator, or held (answered without a verify). No payer, no key. */
  function noteFundingRefusal({ network, reason, held = false, at = now() } = {}) {
    const k = `${String(network || "unknown").slice(0, 64)}|${String(reason || "unknown").slice(0, 40)}`;
    let m = fundingRefusals.get(k);
    if (!m) { if (fundingRefusals.size >= MAX_SLUGS) return null; m = new Map(); fundingRefusals.set(k, m); }
    const b = bucketOf(at);
    let row = m.get(b);
    if (!row) { row = [0, 0]; m.set(b, row); prune(m, at); }
    row[held ? 1 : 0]++;
    return held ? "held" : "refused";
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
    // Caller keys are read only inside the unanswered window: a bucket older
    // than that window plus one bucket is published without them.
    const dcFloor = bucketOf(t - unansweredSettings(env).windowMs) - 1;
    const packUpstreams = () => {
      const out = pack(upstreams);
      for (const rows of Object.values(out)) {
        for (const [b, row] of Object.entries(rows)) if (row.dc && Number(b) < dcFloor) { const { dc, ...rest } = row; void dc; rows[b] = rest; }
      }
      return out;
    };
    return {
      at: t,
      tools: pack(tools),
      upstreams: packUpstreams(),
      answers: pack(answers),
      lastAnswer: Object.fromEntries([...lastAnswer].map(([k, v]) => [k, v.filter((x) => x.at > t - DAY_MS)]).filter(([, v]) => v.length)),
      lastToolError: Object.fromEntries([...lastToolError].filter(([, v]) => v.at > t - DAY_MS)),
      lastUpstream: Object.fromEntries([...lastUpstream].filter(([, v]) => v.at > t - DAY_MS)),
      refusals: refusals.filter((r) => r.at > t - DAY_MS),
      gas: relayerGas.filter((r) => r.at > t - DAY_MS),
      replays: pack(replays),
      paths: pack(paths),
      rails: pack(rails),
      buyerRefusals: Object.fromEntries([...buyerRefusals].filter(([b]) => b > floor)),
      fundingRefusals: pack(fundingRefusals),
      pendingSettles: pack(pendingSettles),
      pendingDrops: Object.fromEntries([...pendingDrops].filter(([b]) => b > floor)),
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
    const repM = {}, brM = {}, pathM = {}, railM = {}, fundM = {}, pendM = {}, pendDropM = {};
    // A row from a replica that predates the free lane has no f; add reads it as zeros.
    const addLanes = (into, key, rows) => {
      const dst = (into[key] ||= {});
      for (const [b, row] of Object.entries(rows)) {
        const d = (dst[b] ||= { o: emptyTool(), s: emptyTool(), f: emptyTool() });
        add(d.o, row.o); add(d.s, row.s); add(d.f, row.f);
      }
    };
    for (const s of all) {
      for (const [g, rows] of Object.entries(s.paths || {})) addLanes(pathM, g, rows);
      for (const [r, rows] of Object.entries(s.rails || {})) addLanes(railM, r, rows);
      for (const [slug, rows] of Object.entries(s.replays || {})) {
        const dst = (repM[slug] ||= {});
        for (const [b, row] of Object.entries(rows)) add((dst[b] ||= emptyReplay()), row);
      }
      for (const [b, n] of Object.entries(s.buyerRefusals || {})) brM[b] = (brM[b] || 0) + (Number(n) || 0);
      for (const [k, rows] of Object.entries(s.fundingRefusals || {})) {
        const dst = (fundM[k] ||= {});
        for (const [b, row] of Object.entries(rows)) add((dst[b] ||= [0, 0]), row);
      }
      for (const [b, n] of Object.entries(s.pendingDrops || {})) pendDropM[b] = (pendDropM[b] || 0) + (Number(n) || 0);
      for (const [k, rows] of Object.entries(s.pendingSettles || {})) {
        const dst = (pendM[k] ||= {});
        for (const [b, row] of Object.entries(rows)) add((dst[b] ||= emptyPending()), row);
      }
      for (const [slug, rows] of Object.entries(s.tools || {})) addLanes(toolsM, slug, rows);
      for (const [name, rows] of Object.entries(s.upstreams || {})) {
        const dst = (upM[name] ||= {});
        for (const [b, row] of Object.entries(rows)) {
          const d = (dst[b] ||= { o: emptyUp(), s: emptyUp(), b: emptyUp() });
          add(d.o, row.o); add(d.s, row.s); add(d.b, row.b);
          if (Array.isArray(row.dc)) for (const c of row.dc) { d.dc ||= []; if (d.dc.length < 64 && !d.dc.includes(c)) d.dc.push(c); }
          if (Number(row.hv) > 0) d.hv = (d.hv || 0) + Number(row.hv);
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
    return { tools: toolsM, upstreams: upM, answers: ansM, lastAnswer: lastA, lastToolError: lastT, lastUpstream: lastU, refusals: refs.sort((a, b) => a.at - b.at), gas: Object.values(gasM), replays: repM, buyerRefusals: brM, paths: pathM, rails: railM, fundingRefusals: fundM, pendingSettles: pendM, pendingDrops: pendDropM };
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
      const h = sumWindow(rows, ["o", "s", "f"], TOOL_CLASSES.length, hourFloor);
      const d = sumWindow(rows, ["o", "s", "f"], TOOL_CLASSES.length, dayFloor);
      // The word reads the outside lane; synthetic outcomes never count, and
      // the free lane counts only when nearly all of its calls fail.
      const o = named(TOOL_CLASSES, h.o), f = named(TOOL_CLASSES, h.f);
      const s5 = o.fail + o.timeout;
      const calls = o.ok + o.buyer + o.fail + o.timeout;
      const f5 = f.fail + f.timeout, fCalls = f.ok + f.buyer + f.fail + f.timeout;
      let word = "ok";
      if (calls >= th.toolMinCalls && s5 / calls > th.toolFailRate) word = "failing";
      else if (fCalls >= th.freeMinCalls && f5 / fCalls >= th.freeFailRate) word = "failing";
      else if (s5 >= th.tool5xxDegraded) word = "degraded";
      if (word === "failing" || (word === "degraded" && toolWord === "ok")) toolWord = word;
      const anyFail = d.o[2] + d.o[3] + d.s[2] + d.s[3] + d.f[2] + d.f[3] > 0;
      if (!anyFail && word === "ok") continue;
      toolRows.push({
        slug, status: word,
        hour: { outside: o, synthetic: named(TOOL_CLASSES, h.s), free: named(TOOL_CLASSES, h.f), outside5xx: s5, outsideCalls: calls, free5xx: h.f[2] + h.f[3] },
        day: { outside: named(TOOL_CLASSES, d.o), synthetic: named(TOOL_CLASSES, d.s), free: named(TOOL_CLASSES, d.f) },
        lastError: m.lastToolError[slug] ? { ...m.lastToolError[slug], at: new Date(m.lastToolError[slug].at).toISOString() } : null,
      });
    }
    const upRows = [];
    let upWord = "ok";
    for (const [name, rows] of Object.entries(m.upstreams)) {
      const h = sumWindow(rows, ["o", "s", "b"], UPSTREAM_KINDS.length, hourFloor);
      const d = sumWindow(rows, ["o", "s", "b"], UPSTREAM_KINDS.length, dayFloor);
      const counted = named(UPSTREAM_KINDS, add([...h.o], h.b));
      // Only the upstream's own failures (UPSTREAM_FAILURE_KINDS): our
      // deadlines, our egress and a caller's cancel are left out of both.
      const fails = UPSTREAM_FAILURE_KINDS.reduce((n, k) => n + counted[k], 0);
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
    // Unanswered: our deadline firing on one upstream across many calls from
    // several callers inside the window (src/unanswered-rule.js), or on every
    // one of at least allHeldMin calls when fewer callers (or background work
    // alone) reach it, while other
    // upstreams answer in the same five-minute buckets. Says only "did not
    // answer within our limit". When most upstreams with traffic are held at
    // once, or no other upstream answered while this one was held, the cause
    // may be our side (the event loop, our egress): no upstream is named and
    // ourSide is set. Our egress failures (DNS, no route) are never a deadline
    // and never name an upstream; they only feed the ourSide reading.
    const un = unansweredSettings(env);
    const unFloor = bucketOf(t - un.windowMs);
    const unStats = [];
    const okBy = new Map(); // upstream -> Map(bucket -> ok answers), outside and background lanes
    const iOk = UPSTREAM_KINDS.indexOf("ok"), iDl = UPSTREAM_KINDS.indexOf("deadline");
    for (const [name, rows] of Object.entries(m.upstreams)) {
      const w = sumWindow(rows, ["o", "b"], UPSTREAM_KINDS.length, unFloor);
      const c = named(UPSTREAM_KINDS, add([...w.o], w.b));
      const answered = c.ok + c.s5xx + c.timeout + c.network + c.throttled;
      const held = c.deadline + c.egress;
      if (answered + held === 0) continue;
      const callers = new Set();
      const okB = new Map();
      const dlBuckets = [];
      let heavyDl = 0;
      for (const [b, row] of Object.entries(rows)) {
        if (!(Number(b) > unFloor)) continue;
        for (const k of row.dc || []) callers.add(k);
        heavyDl += Number(row.hv) || 0;
        const ok = (row.o?.[iOk] || 0) + (row.b?.[iOk] || 0);
        if (ok) okB.set(Number(b), ok);
        if ((row.o?.[iDl] || 0) + (row.b?.[iDl] || 0)) dlBuckets.push(Number(b));
      }
      okBy.set(name, okB);
      unStats.push({ upstream: name, deadline: c.deadline, shortDeadline: Math.max(0, c.deadline - heavyDl), egress: c.egress, answered, calls: answered + held, callers: callers.size, dlBuckets });
    }
    const heldShare = (x) => (x.calls ? (x.deadline + x.egress) / x.calls : 0);
    const heldUps = unStats.filter((x) => x.calls >= un.minCalls && heldShare(x) >= un.rate);
    const ourSide = heldUps.length > 0 && heldUps.length > unStats.length / 2;
    // Another upstream answered (an ok) in a bucket where this one was held.
    const othersAnswered = (x) => unStats.some((y) => y.upstream !== x.upstream && heldShare(y) < un.rate && x.dlBuckets.some((b) => okBy.get(y.upstream)?.get(b)));
    // Several callers, or (one caller, or background work alone) an upstream
    // that answered none of its calls in the window on allHeldMin of ours
    // whose input was not long enough to outlast the limit.
    const candidates = unStats.filter((x) => x.deadline >= un.minCalls && x.deadline / x.calls >= un.rate
      && (x.callers >= un.minCallers || (x.answered === 0 && x.shortDeadline >= un.allHeldMin)));
    const unanswered = ourSide ? [] : candidates.filter(othersAnswered);
    for (const x of unanswered) {
      const r = upRows.find((u) => u.upstream === x.upstream);
      const last = m.lastUpstream[x.upstream];
      const limit = last?.kind === "deadline" && last.limitMs ? ` ${secondsOfMs(last.limitMs)} s` : "";
      const detail = { deadlines: x.deadline, calls: x.calls, callers: x.callers, note: `${x.upstream} did not answer within our${limit} limit on ${x.deadline} of ${x.calls} calls from ${x.callers} callers in ${Math.round(un.windowMs / 60_000)} min` };
      if (r) { r.unanswered = detail; if (r.status === "ok") r.status = "unanswered"; }
    }
    if (upWord === "ok" && unanswered.length) upWord = "unanswered";
    const unansweredDetail = { ourSide: ourSide || (candidates.length > 0 && unanswered.length < candidates.length), upstreams: unanswered.map((x) => x.upstream), thresholds: un };
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
    // Gas runway of the facilitators' settlement signers: a balance read
    // under the floor reads "low" (a warning before refusals). A balance our
    // checker could not read past its retries ("unread": our RPC read failed,
    // so nothing about the signer is known) reads "unknown", which pages
    // nothing; a real low beside it still reads "low". A facilitator that
    // publishes no signer ("unknown") has nothing to watch and never pages.
    const gas = (m.gas || []).filter((r) => r.at > t - th.gasFreshMs);
    // A listed facilitator's empty or unreadable signer is covered while our
    // own relayer on that network reads ok: payments settle through ours
    // first, so the word does not wait on a wallet we do not fund. Our own
    // relayer low or unread, and the gas-against-floor row, are never covered.
    const ownOk = new Set(gas.filter((r) => r.own && r.status === "ok").map((r) => r.network));
    const covered = gas.filter((r) => !r.own && !r.reason && r.facilitator !== "price floor" && (r.status === "low" || r.status === "unread") && ownOk.has(r.network));
    const gasLow = gas.filter((r) => r.status === "low" && !covered.includes(r));
    const gasUnread = gas.filter((r) => r.status === "unread" && !covered.includes(r));
    const fundsWord = demoted.length ? "demoted" : recent.length ? "refused" : gasLow.length ? "low" : gasUnread.length ? "unknown" : "ok";
    // A refused paying buyer: a bucket counts while it ended inside the window
    // (its start is after t - window - BUCKET_MS), so a refusal is read for at
    // least the window and at most one bucket longer.
    const brFloor = bucketOf(t - th.buyerRefusalWindowMs - BUCKET_MS);
    let buyerRefusalsWindow = 0, buyerRefusalsDay = 0;
    for (const [b, n] of Object.entries(m.buyerRefusals || {})) {
      if (Number(b) > brFloor) buyerRefusalsWindow += n;
      if (Number(b) > dayFloor) buyerRefusalsDay += n;
    }
    const buyerWord = buyerRefusalsWindow > 0 ? "refusing" : "ok";
    // Replays served from the idempotency store, by slug (detail only).
    const replayRows = [];
    const replayTotals = { hour: named(REPLAY_KINDS, emptyReplay()), day: named(REPLAY_KINDS, emptyReplay()) };
    for (const [slug, rows] of Object.entries(m.replays || {})) {
      const h = emptyReplay(), d = emptyReplay();
      for (const [b, row] of Object.entries(rows)) { if (Number(b) > hourFloor) add(h, row); if (Number(b) > dayFloor) add(d, row); }
      if (!d.some(Boolean)) continue;
      replayRows.push({ slug, hour: named(REPLAY_KINDS, h), day: named(REPLAY_KINDS, d) });
      for (const k of REPLAY_KINDS) { replayTotals.hour[k] += named(REPLAY_KINDS, h)[k]; replayTotals.day[k] += named(REPLAY_KINDS, d)[k]; }
    }
    replayRows.sort((a, b) => (b.day.implicit + b.day.keyed) - (a.day.implicit + a.day.keyed) || a.slug.localeCompare(b.slug));
    // Solana funding refusals by network and reason (detail only, never a word).
    const fundingRows = [];
    for (const [k, rows] of Object.entries(m.fundingRefusals || {})) {
      const h = [0, 0], d = [0, 0];
      for (const [b, row] of Object.entries(rows)) { if (Number(b) > hourFloor) add(h, row); if (Number(b) > dayFloor) add(d, row); }
      if (!d[0] && !d[1]) continue;
      const bar = k.lastIndexOf("|");
      fundingRows.push({ network: k.slice(0, bar), reason: k.slice(bar + 1), hour: { refused: h[0], held: h[1] }, day: { refused: d[0], held: d[1] } });
    }
    fundingRows.sort((a, b) => (b.day.refused + b.day.held) - (a.day.refused + a.day.held) || a.network.localeCompare(b.network) || a.reason.localeCompare(b.reason));
    // Pending settles read on chain, by network and facilitator (detail only).
    const pendingRows = [];
    const pendingTotals = { hour: named(PENDING_OUTCOMES, emptyPending()), day: named(PENDING_OUTCOMES, emptyPending()) };
    for (const [k, rows] of Object.entries(m.pendingSettles || {})) {
      const h = emptyPending(), d = emptyPending();
      for (const [b, row] of Object.entries(rows)) { if (Number(b) > hourFloor) add(h, row); if (Number(b) > dayFloor) add(d, row); }
      if (!d.some(Boolean)) continue;
      const cut = k.indexOf("|");
      pendingRows.push({ network: k.slice(0, cut), facilitator: k.slice(cut + 1), hour: named(PENDING_OUTCOMES, h), day: named(PENDING_OUTCOMES, d) });
      PENDING_OUTCOMES.forEach((o, i) => { pendingTotals.hour[o] += h[i]; pendingTotals.day[o] += d[i]; });
    }
    pendingRows.sort((a, b) => a.network.localeCompare(b.network) || a.facilitator.localeCompare(b.facilitator));
    // Outcomes dropped because MAX_PENDING_KEYS pairs were all live.
    const pendingDropped = { hour: 0, day: 0 };
    for (const [b, n] of Object.entries(m.pendingDrops || {})) { if (Number(b) > hourFloor) pendingDropped.hour += Number(n) || 0; if (Number(b) > dayFloor) pendingDropped.day += Number(n) || 0; }
    // Catalog outcomes by arrival path (detail only, never a word).
    const laneRows = (src) => {
      const out = {};
      for (const [g, rows] of Object.entries(src || {})) {
        const h = sumWindow(rows, ["o", "s", "f"], TOOL_CLASSES.length, hourFloor);
        const d = sumWindow(rows, ["o", "s", "f"], TOOL_CLASSES.length, dayFloor);
        const ho = named(TOOL_CLASSES, h.o), dO = named(TOOL_CLASSES, d.o);
        out[g] = {
          hour: { outside: ho, synthetic: named(TOOL_CLASSES, h.s), free: named(TOOL_CLASSES, h.f), outsideErrors: ho.fail + ho.timeout },
          day: { outside: dO, synthetic: named(TOOL_CLASSES, d.s), free: named(TOOL_CLASSES, d.f), outsideErrors: dO.fail + dO.timeout },
        };
      }
      return out;
    };
    const byPath = laneRows(m.paths);
    // Catalog outcomes by payment rail (detail only, never a word).
    const byRail = laneRows(m.rails);
    const rank = { failing: 0, degraded: 1, unanswered: 2, ok: 3 };
    toolRows.sort((a, b) => rank[a.status] - rank[b.status] || b.hour.outside5xx - a.hour.outside5xx || a.slug.localeCompare(b.slug));
    upRows.sort((a, b) => rank[a.status] - rank[b.status] || b.hour.failures - a.hour.failures || a.upstream.localeCompare(b.upstream));
    ansRows.sort((a, b) => rank[a.status] - rank[b.status] || b.day.outsideBad - a.day.outsideBad || a.slug.localeCompare(b.slug));
    return {
      toolFailures: toolWord, upstreamHealth: upWord, upstreamUnanswered: unansweredDetail, facilitatorFunds: fundsWord, toolAnswers: ansWord, buyerRefusals: buyerWord,
      buyerRefusalsWindow, buyerRefusalsDay,
      replays: replayRows, replayTotals, byPath, byRail, fundingRefusals: fundingRows,
      pendingSettles: { rows: pendingRows, totals: pendingTotals, dropped: pendingDropped, maxKeys: MAX_PENDING_KEYS },
      thresholds: th, tools: toolRows, upstreams: upRows, answers: ansRows,
      answerTotals: Object.fromEntries(Object.entries(totals).map(([w, v]) => [w, { outside: named(ANSWER_CLASSES, v.o), synthetic: named(ANSWER_CLASSES, v.s) }])),
      facilitatorRefusals: recent.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
      facilitatorRefusals24h: m.refusals.filter((r) => r.at > t - DAY_MS).length,
      demoted,
      relayerGas: gas.map((r) => ({ ...r, ...(covered.includes(r) ? { coveredByOwnRelayer: true } : {}), at: new Date(r.at).toISOString() })),
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
    if (!full) return { toolFailures: { status: e.toolFailures }, upstreamHealth: { status: e.upstreamHealth }, facilitatorFunds: { status: e.facilitatorFunds }, toolAnswers: { status: e.toolAnswers }, buyerRefusals: { status: e.buyerRefusals } };
    const failingTools = e.tools.filter((r) => r.status !== "ok");
    const badUps = e.upstreams.filter((r) => r.status !== "ok");
    return {
      toolFailures: { status: e.toolFailures, tools: failingTools.map((r) => ({ slug: r.slug, status: r.status, outside5xx: r.hour.outside5xx, outsideCalls: r.hour.outsideCalls })) },
      upstreamHealth: { status: e.upstreamHealth, upstreams: badUps.map((r) => ({ upstream: r.upstream, status: r.status, failures: r.hour.failures, calls: r.hour.calls, ...(r.unanswered ? { unanswered: r.unanswered.note } : {}) })), ourSide: !!e.upstreamUnanswered?.ourSide },
      facilitatorFunds: { status: e.facilitatorFunds, refusals1h: e.facilitatorRefusals.length, demoted: e.demoted, relayersLow: e.relayerGas.filter((r) => r.status === "low" && !r.coveredByOwnRelayer).length, relayersCovered: e.relayerGas.filter((r) => r.coveredByOwnRelayer).length, relayersUnread: e.relayerGas.filter((r) => r.status === "unread" && !r.coveredByOwnRelayer).length, gasNearFloor: e.relayerGas.some((r) => r.reason === "gasNearFloor") },
      toolAnswers: { status: e.toolAnswers, tools: e.answers.filter((r) => r.status !== "ok").map((r) => ({ slug: r.slug, status: r.status, outsideBad1h: r.hour.outsideBad, outsideChecked1h: r.hour.outsideChecked, outsideBad24h: r.day.outsideBad, outsideChecked24h: r.day.outsideChecked })) },
      // Counts only: no key, no address, no slug.
      buyerRefusals: { status: e.buyerRefusals, refusalsWindow: e.buyerRefusalsWindow, refusals24h: e.buyerRefusalsDay, windowMinutes: e.thresholds.buyerRefusalWindowMs / 60_000 },
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
        facilitatorNetworks: [...new Set([...e.facilitatorRefusals.map((r) => r.network), ...e.relayerGas.filter((r) => (r.status === "low" || r.status === "unread") && !r.coveredByOwnRelayer).map((r) => r.network)])],
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
    id, noteTool, noteAnswer, noteToolMessage, noteUpstream, forgiveUpstream, notePendingSettle, observeFetch, noteFacilitatorRefusal, noteRelayerGas, noteReplay, noteBuyerRefusal, noteFundingRefusal, registerUpstreamHost, upstreamNameOf,
    snapshot, publish, refreshRemote, merged, evaluate, status, report, start, stop,
    _reset() { tools.clear(); upstreams.clear(); answers.clear(); lastAnswer.clear(); lastToolError.clear(); lastUpstream.clear(); refusals.length = 0; replays.clear(); paths.clear(); rails.clear(); buyerRefusals.clear(); fundingRefusals.clear(); pendingSettles.clear(); pendingDrops.clear(); relayerGas = []; remote = { at: 0, snapshots: [], ok: false, merged: null }; cached = null; },
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
