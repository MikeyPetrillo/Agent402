// Solana HISTORY reads: getTransaction by signature, public RPC first.
//
// A transaction read by signature is immutable once finalized, so any node
// that holds it answers it identically. The keyed provider is the scarce lane
// (it meters every call); the public mainnet RPC is free but rate-limited per
// IP. This module puts the public lane first for these reads and keeps the
// keyed lane behind it, the same split `cheapRpcs` makes for the EVM rails.
//
// Rules, each one tested in scripts/test-solana-history-rpc.js:
//   * A public lane that errors, times out, rate-limits (HTTP 429, JSON-RPC
//     429 / -32429, "too many requests") or answers NULL falls through to the
//     next lane. A public node may have pruned a transaction or not indexed it
//     yet, so its null is never taken as "no such transaction".
//   * Null is authoritative only from a keyed lane. When a keyed lane exists
//     and every keyed lane fails, the read THROWS (the caller's batch fails and
//     retries, exactly as it would with the keyed lane alone), never a null.
//     With no keyed lane configured (a local run), a null is returned as before.
//   * Public lanes are paced (requests per second per lane, shared by every
//     caller in the process). A read that would wait longer than `maxWaitMs`
//     for its slot skips the lane instead. A rate limit or a timeout cools the
//     lane with exponential backoff (honoring Retry-After), so a busy public
//     node is skipped rather than hammered.
//   * Non-null answers are cached by signature (bounded), so a surface that
//     re-reads the same recent transactions every few minutes reads each once.
//
// Lane order (SOLANA_HISTORY_ALCHEMY_FIRST=on restores keyed-first):
//   1. SOLANA_HISTORY_PUBLIC_RPCS (default: the public mainnet RPC),
//   2. the keyed lanes: SOLANA_RPCS entries on alchemy.com, plus SOLANA_RPC_URL
//      when it is set to anything other than a public lane,
//   3. the remaining SOLANA_RPCS entries (fallback only).
import { redactSecrets } from "./tools/redact.js";

const PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

// The shared Solana JSON-RPC list (revenue-live re-exports it). Keyed first for
// live head reads: the balance read timed out against the rate-limited public
// RPCs from the datacenter, so getTokenAccountsByOwner and friends stay on it.
export const SOLANA_RPCS = (process.env.SOLANA_RPCS || [
  ...(process.env.ALCHEMY_API_KEY ? [`https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : []),
  PUBLIC_MAINNET,
  "https://solana-rpc.publicnode.com",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const isKeyedUrl = (u) => /alchemy\.com/i.test(u);
const onFlag = (v) => /^(1|on|true|yes)$/i.test(String(v || "").trim());

/** Label for a lane: a host, never a path (a keyed URL carries its key in the path). */
export function laneLabel(url) {
  try {
    const host = new URL(url).host;
    return isKeyedUrl(url) ? "alchemy" : host;
  } catch { return "rpc"; }
}

/** The history lanes in the order they are tried. Read per call so env changes in tests apply. */
export function solanaHistoryLanes(env = process.env) {
  const rpcs = env.SOLANA_RPCS ? list(env.SOLANA_RPCS) : SOLANA_RPCS;
  const publicFirst = env.SOLANA_HISTORY_PUBLIC_RPCS != null ? list(env.SOLANA_HISTORY_PUBLIC_RPCS) : [PUBLIC_MAINNET];
  const pub = new Set(publicFirst);
  const keyed = [];
  for (const u of rpcs) if (isKeyedUrl(u) && !keyed.includes(u)) keyed.push(u);
  const primary = String(env.SOLANA_RPC_URL || "").trim();
  // SOLANA_RPC_URL is the lane the leaderboard used alone before this module;
  // it counts as keyed unless it is one of the listed unkeyed endpoints.
  if (primary && !pub.has(primary) && !keyed.includes(primary) && (isKeyedUrl(primary) || !rpcs.includes(primary))) keyed.push(primary);
  const rest = rpcs.filter((u) => !pub.has(u) && !keyed.includes(u));
  const lanes = [
    ...publicFirst.map((url) => ({ url, keyed: false })),
    ...keyed.map((url) => ({ url, keyed: true })),
    ...rest.map((url) => ({ url, keyed: false })),
  ];
  if (onFlag(env.SOLANA_HISTORY_ALCHEMY_FIRST)) {
    // Rollback: keyed first, then every other lane in its SOLANA_RPCS order.
    return [...lanes.filter((l) => l.keyed), ...lanes.filter((l) => !l.keyed)];
  }
  return lanes;
}

// ---- per-lane state: pacing, cooldown, counters ---------------------------
const laneState = new Map();   // url -> { nextAt, coolUntil, strikes }
const counters = new Map();    // label -> { served, nulls, rateLimited, failed, skipped, keyed }
let cacheHits = 0, allFailed = 0, startedAt = Date.now();
const recent = [];             // last outcomes: "public" | "keyed" | "none"
const RECENT_MAX = 200;

const stateOf = (url) => { let s = laneState.get(url); if (!s) { s = { nextAt: 0, coolUntil: 0, strikes: 0 }; laneState.set(url, s); } return s; };
const countOf = (lane) => {
  const k = laneLabel(lane.url);
  let c = counters.get(k);
  if (!c) { c = { served: 0, nulls: 0, rateLimited: 0, failed: 0, skipped: 0, keyed: lane.keyed }; counters.set(k, c); }
  return c;
};
const noteOutcome = (o) => { recent.push(o); if (recent.length > RECENT_MAX) recent.shift(); };

function cool(st, baseMs, retryAfterMs = 0) {
  st.strikes = Math.min(st.strikes + 1, 8);
  const backoff = Math.min(120_000, baseMs * 2 ** (st.strikes - 1));
  st.coolUntil = Date.now() + Math.min(300_000, Math.max(backoff, retryAfterMs));
}

// Bounded LRU of non-null transactions by signature (finalized = immutable).
const cache = new Map();
const cacheKey = (method, params) => (method === "getTransaction" && typeof params?.[0] === "string") ? `${params[0]}|${JSON.stringify(params[1] || {})}` : null;
function cacheGet(k) { if (!k || !cache.has(k)) return undefined; const v = cache.get(k); cache.delete(k); cache.set(k, v); return v; }
function cachePut(k, v, max) {
  if (!k || v == null || max <= 0) return;
  cache.set(k, v);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_RE = /too many requests|rate.?limit/i;
const isRateLimitError = (e) => e && (e.code === 429 || e.code === -32429 || RATE_LIMIT_RE.test(String(e.message || "")));
// A node refuses a transaction newer than the version the caller said it
// supports, and names the version to ask for. The answer is read once more
// with that version (the parsed form a caller reads is the same for every
// version), and the lane remembers it for its later reads.
const TX_VERSION_RE = /Transaction version \((\d+)\) is not supported/i;
const txVersionOf = (params) => Number(params?.[1]?.maxSupportedTransactionVersion ?? -1);
const withTxVersion = (params, v) => [params[0], { ...(params[1] || {}), maxSupportedTransactionVersion: v }];

async function postOnce(url, method, params, timeoutMs, fetchImpl) {
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 429) {
    const ra = Number(r.headers?.get?.("retry-after"));
    return { kind: "rateLimited", retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0 };
  }
  let j = null;
  try { j = await r.json(); } catch { /* fall through as a failure */ }
  if (!r.ok && !j) return { kind: "failed", why: `HTTP ${r.status}` };
  if (j?.error) return isRateLimitError(j.error) ? { kind: "rateLimited", retryAfterMs: 0 } : { kind: "failed", why: String(j.error.message || j.error.code).slice(0, 80) };
  if (!j || j.result === undefined) return { kind: "failed", why: `HTTP ${r.status}` };
  return j.result === null ? { kind: "null" } : { kind: "ok", result: j.result };
}

/**
 * One history read across the lanes. Options:
 *   timeoutMs        per-call deadline on a keyed lane (default 6000)
 *   publicTimeoutMs  per-call deadline on a public lane (SOLANA_HISTORY_PUBLIC_TIMEOUT_MS, default 4000)
 *   maxWaitMs        longest a read queues for a public lane's pacing slot before skipping it
 *                    (SOLANA_HISTORY_PUBLIC_MAX_WAIT_MS, default 10000; 0 = never wait)
 *   lanes, fetchImpl test seams
 */
export async function solanaHistoryRead(method, params, opts = {}) {
  const env = process.env;
  // keyedFirst: a deadline-bound caller (the revenue card and activity scan)
  // keeps the keyed lane first and never queues for a public slot; it still
  // shares the cache, the fallbacks and the counters.
  const keyedFirst = !!opts.keyedFirst;
  const ordered = opts.lanes || solanaHistoryLanes(env);
  const lanes = keyedFirst ? [...ordered.filter((l) => l.keyed), ...ordered.filter((l) => !l.keyed)] : ordered;
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 6000;
  const publicTimeoutMs = opts.publicTimeoutMs ?? num(env.SOLANA_HISTORY_PUBLIC_TIMEOUT_MS, 4000);
  const maxWaitMs = opts.maxWaitMs ?? (keyedFirst ? 0 : env.SOLANA_HISTORY_PUBLIC_MAX_WAIT_MS != null ? Math.max(0, Number(env.SOLANA_HISTORY_PUBLIC_MAX_WAIT_MS) || 0) : 10_000);
  const note = (o) => { if (!keyedFirst) noteOutcome(o); };
  // The public mainnet RPC answered about ten requests per ten seconds from
  // one IP when measured (the eleventh was rate-limited), under its published
  // per-method figure, so the default pace leaves headroom below that.
  const rps = num(env.SOLANA_HISTORY_PUBLIC_RPS, 0.8);
  const cacheMax = env.SOLANA_HISTORY_CACHE != null ? Math.max(0, Number(env.SOLANA_HISTORY_CACHE) || 0) : 256;

  const ck = cacheKey(method, params);
  const hit = cacheGet(ck);
  if (hit !== undefined) { cacheHits++; return hit; }

  const hasKeyed = lanes.some((l) => l.keyed);
  let sawNull = false;
  const failures = [];
  for (const lane of lanes) {
    const st = stateOf(lane.url);
    const c = countOf(lane);
    const now = Date.now();
    if (!lane.keyed) {
      if (st.coolUntil > now) { c.skipped++; failures.push(`${laneLabel(lane.url)}: cooling`); continue; }
      // Pacing: claim the lane's next slot; skip the lane if it is too far off.
      const at = Math.max(now, st.nextAt);
      if (at - now > maxWaitMs) { c.skipped++; failures.push(`${laneLabel(lane.url)}: paced`); continue; }
      st.nextAt = at + 1000 / rps;
      if (at > now) {
        await sleep(at - now);
        // A rate limit that landed while this read waited for its slot cools
        // the lane for it too.
        if (st.coolUntil > Date.now()) { c.skipped++; failures.push(`${laneLabel(lane.url)}: cooling`); continue; }
      }
    }
    const laneTimeout = lane.keyed ? timeoutMs : publicTimeoutMs;
    const post = async (p) => {
      try { return await postOnce(lane.url, method, p, laneTimeout, fetchImpl); }
      catch (e) { return { kind: "failed", why: redactSecrets(String(e?.name === "TimeoutError" ? "timeout" : (e?.message || e))).slice(0, 80), timeout: e?.name === "TimeoutError" || e?.name === "AbortError" }; }
    };
    // A version this lane already answered with is asked for up front.
    let laneParams = (method === "getTransaction" && Number(st.txVersion) > txVersionOf(params)) ? withTxVersion(params, st.txVersion) : params;
    let out = await post(laneParams);
    if (out.kind === "failed" && method === "getTransaction") {
      const m = TX_VERSION_RE.exec(out.why || "");
      const v = m ? Number(m[1]) : NaN;
      if (Number.isInteger(v) && v > txVersionOf(laneParams)) {
        laneParams = withTxVersion(laneParams, v);
        out = await post(laneParams);
        if (out.kind === "ok" || out.kind === "null") st.txVersion = v;
      }
    }

    if (out.kind === "ok") {
      c.served++; st.strikes = 0;
      note(lane.keyed ? "keyed" : "public");
      cachePut(ck, out.result, cacheMax);
      return out.result;
    }
    if (out.kind === "null") {
      c.nulls++; st.strikes = 0;
      if (lane.keyed) { note("keyed"); return null; }
      sawNull = true;
      continue;
    }
    if (out.kind === "rateLimited") {
      c.rateLimited++;
      if (!lane.keyed) cool(st, 5_000, out.retryAfterMs);
      failures.push(`${laneLabel(lane.url)}: rate limited`);
      continue;
    }
    c.failed++;
    if (!lane.keyed) cool(st, out.timeout ? 10_000 : 2_000);
    failures.push(`${laneLabel(lane.url)}: ${out.why}`);
  }
  if (sawNull && !hasKeyed) { note("public"); return null; }
  allFailed++; note("none");
  const err = new Error(`solana history read failed on every lane - ${failures.join(" | ")}`.slice(0, 300));
  err.lanes = failures;
  throw err;
}

/** Route getTransaction through the history lanes; every other method to `other`. */
export function historyAwareRpc(other, opts = {}) {
  return (method, params) => (method === "getTransaction" ? solanaHistoryRead(method, params, opts) : other(method, params));
}

/**
 * Counters for /api/gateway-status. Public: one word. Operator: per-lane counts.
 *   idle      no history read since restart
 *   publics   public lanes served at least half of the recent reads
 *   fallback  the keyed lane served most recent reads
 *   failing   most recent reads failed on every lane
 */
export function solanaHistoryStatus({ full = false } = {}) {
  const n = recent.length;
  let status = "idle";
  if (n) {
    const pub = recent.filter((o) => o === "public").length;
    const none = recent.filter((o) => o === "none").length;
    status = none * 2 > n ? "failing" : pub * 2 >= n ? "publics" : "fallback";
  }
  if (!full) return { status };
  const lanes = {};
  let servedPublic = 0, servedKeyed = 0;
  for (const [k, c] of counters) {
    lanes[k] = { ...c };
    if (c.keyed) servedKeyed += c.served + c.nulls; else servedPublic += c.served;
  }
  const total = servedPublic + servedKeyed;
  return {
    status, sinceRestart: true, since: new Date(startedAt).toISOString(),
    order: onFlag(process.env.SOLANA_HISTORY_ALCHEMY_FIRST) ? "keyed-first" : "public-first",
    lanes, cacheHits, failedEveryLane: allFailed,
    publicShare: total ? Number((servedPublic / total).toFixed(3)) : null,
  };
}

export function __resetSolanaHistoryForTest() {
  laneState.clear(); counters.clear(); cache.clear(); recent.length = 0;
  cacheHits = 0; allFailed = 0; startedAt = Date.now();
}
