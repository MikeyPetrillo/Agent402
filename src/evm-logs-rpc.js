// EVM eth_getLogs over RECENT blocks: public RPC first, the configured list
// (keyed lane first) behind it.
//
// The keyed lane meters every getLogs. A recent, narrow range (the revenue
// ledger's tail: the few minutes since its last tick) is something a public
// node serves too, so it goes there first. Historical and wide ranges stay
// keyed-first: the public nodes measured refuse them (archive gates, range
// caps) or, worse, some answer an empty list for blocks they do not have.
//
// A public answer is accepted only when it is explicitly complete:
//   * it comes back from ONE batched request that also carries that node's
//     own eth_blockNumber, and that head is at or past the range's last block
//     (several public nodes answer [] for a range past their head, with no
//     error: measured, so a lagging node must never read as "no transfers");
//   * no error on either half, the logs are a list, and every log is inside
//     the range, from the filtered contract and matches the filtered topics.
// Anything else (error, timeout, rate limit, range cap, behind its head,
// malformed) falls through to the configured list, exactly the read that ran
// before this module. A lane is skipped, never tried, for a range wider than
// its measured cap or older than `maxDepthBlocks` (or the lane's own depth,
// in seconds at the live block time) behind the head.
//
// EVM_LOGS_ALCHEMY_FIRST=on is the rollback: every read goes straight to the
// configured list, as before.
// EVM_LOGS_PUBLIC_RPCS_<CHAIN> (comma-separated URLs) replaces a chain's
// public lanes; an empty value turns them off for that chain.
import { rpcCall } from "./revenue-live.js";
import { redactSecrets } from "./tools/redact.js";
import { blocksForSeconds } from "./chain-block-time.js";

const onFlag = (v) => /^(1|on|true|yes)$/i.test(String(v || "").trim());

// Measured from outside production with a handful of calls per endpoint
// (range caps as each endpoint stated them; depth where it gates history).
// Endpoints that refused every getLogs, or that answered [] past their head
// and also refused ranges, are not listed: base.drpc.org, polygon.drpc.org,
// arbitrum.drpc.org (every range refused on the free plan), mainnet.base.org
// (every getLogs refused). The head check above covers the ones that answer
// [] past their head.
export const EVM_LOGS_PUBLICS = Object.freeze({
  // Depth is TIME: 9,000 blocks at Base's original 2 s, counted at the live
  // block time (src/chain-block-time.js) so it stays five hours across Denim.
  // maxRange is the provider's per-request block cap and stays in blocks.
  base: [{ url: "https://base-rpc.publicnode.com", maxRange: 9_000, maxDepthSeconds: 18_000 }],
  arbitrum: [{ url: "https://arb1.arbitrum.io/rpc", maxRange: 9_000 }],
  monad: [{ url: "https://rpc2.monad.xyz", maxRange: 9_000 }, { url: "https://rpc.monad.xyz", maxRange: 100 }],
  celo: [{ url: "https://forno.celo.org", maxRange: 5_000 }],
  avalanche: [{ url: "https://api.avax.network/ext/bc/C/rpc", maxRange: 9_000 }, { url: "https://avalanche-c-chain-rpc.publicnode.com", maxRange: 9_000 }],
  optimism: [{ url: "https://mainnet.optimism.io", maxRange: 9_000 }, { url: "https://optimism-rpc.publicnode.com", maxRange: 9_000 }],
  robinhood: [{ url: "https://rpc.mainnet.chain.robinhood.com", maxRange: 9_000 }],
  // Refuses 10,000-block ranges; serves 4,900. A rate-limit answer cools it.
  arc: [{ url: "https://rpc.mainnet.arc.io", maxRange: 4_900 }],
});

/** A lane's depth gate in blocks: `maxDepthSeconds` at the chain's live block
 *  time, else a fixed `maxDepth` block count. */
export function laneDepthBlocks(lane, chain) {
  if (Number.isFinite(lane?.maxDepthSeconds)) return blocksForSeconds(chain, lane.maxDepthSeconds);
  return lane?.maxDepth ?? Infinity;
}

export function evmLogsPublicLanes(chain, env = process.env) {
  const k = `EVM_LOGS_PUBLIC_RPCS_${String(chain).toUpperCase()}`;
  if (env[k] != null) return String(env[k]).split(",").map((s) => s.trim()).filter(Boolean).map((url) => ({ url, maxRange: 9_000 }));
  return EVM_LOGS_PUBLICS[chain] || [];
}
export const evmLogsAlchemyFirst = (env = process.env) => onFlag(env.EVM_LOGS_ALCHEMY_FIRST);

// ---- counters ---------------------------------------------------------------
const callers = new Map();   // caller -> counts
const laneState = new Map(); // url -> { coolUntil, strikes }
const recent = [];           // "public" | "fallback" | "none"
let startedAt = Date.now();
const countsOf = (caller) => {
  let c = callers.get(caller);
  if (!c) { c = { publicServed: 0, fallbackServed: 0, failed: 0, publicRejected: { error: 0, rangeCap: 0, behindHead: 0, rateLimited: 0, timeout: 0, malformed: 0 }, publicSkipped: { range: 0, depth: 0, cooling: 0 } }; callers.set(caller, c); }
  return c;
};
const note = (o) => { recent.push(o); if (recent.length > 200) recent.shift(); };
const stateOf = (url) => { let s = laneState.get(url); if (!s) { s = { coolUntil: 0, strikes: 0 }; laneState.set(url, s); } return s; };
function cool(st, baseMs) { st.strikes = Math.min(st.strikes + 1, 8); st.coolUntil = Date.now() + Math.min(300_000, baseMs * 2 ** (st.strikes - 1)); }

export const RANGE_RE = /too many blocks|exceeds? range|limited to a \d+ range|range too large|block range|ranges over|query returned more than|exceeds max results|retry with the range|archive/i;
const RATE_RE = /too many requests|rate.?limit|request limit/i;
const host = (u) => { try { return new URL(u).host; } catch { return "rpc"; } };
const lc = (s) => String(s || "").toLowerCase();

/** Does every log belong to the filter and the range? */
export function logsMatchFilter(logs, filter, from, to) {
  const addr = lc(filter.address);
  const topics = filter.topics || [];
  for (const l of logs) {
    if (!l || typeof l !== "object") return false;
    const b = parseInt(l.blockNumber, 16);
    if (!(b >= from && b <= to)) return false;
    if (addr && lc(l.address) !== addr) return false;
    for (let i = 0; i < topics.length; i++) {
      const want = topics[i];
      if (want == null) continue;
      const got = lc(l.topics?.[i]);
      if (Array.isArray(want) ? !want.map(lc).includes(got) : lc(want) !== got) return false;
    }
  }
  return true;
}

/** One public lane, one batched request. Resolves { kind, logs?, why? }. */
async function tryPublic(url, filter, from, to, timeoutMs, fetchImpl) {
  let r, j;
  try {
    r = await fetchImpl(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [filter] }]),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const t = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { kind: t ? "timeout" : "error", why: t ? "timeout" : redactSecrets(String(e?.message || e)).slice(0, 80) };
  }
  if (r.status === 429) return { kind: "rateLimited", why: "HTTP 429" };
  try { j = await r.json(); } catch { return { kind: "malformed", why: `HTTP ${r.status} non-JSON` }; }
  if (!Array.isArray(j)) {
    const msg = String(j?.error?.message || `HTTP ${r.status}`);
    return { kind: RATE_RE.test(msg) ? "rateLimited" : RANGE_RE.test(msg) ? "rangeCap" : "error", why: msg.slice(0, 80) };
  }
  const head = j.find((x) => x && x.id === 1), logs = j.find((x) => x && x.id === 2);
  for (const part of [head, logs]) {
    if (!part) return { kind: "malformed", why: "batch answer incomplete" };
    if (part.error) {
      const msg = String(part.error.message || part.error.code);
      return { kind: RATE_RE.test(msg) ? "rateLimited" : RANGE_RE.test(msg) ? "rangeCap" : "error", why: msg.slice(0, 80) };
    }
  }
  const h = parseInt(head.result, 16);
  if (!Number.isFinite(h)) return { kind: "malformed", why: "no head" };
  if (h < to) return { kind: "behindHead", why: `head ${h} < ${to}` };
  if (!Array.isArray(logs.result) || !logsMatchFilter(logs.result, filter, from, to)) return { kind: "malformed", why: "logs outside the filter" };
  return { kind: "ok", logs: logs.result };
}

/**
 * eth_getLogs for `filter` (fromBlock/toBlock hex). Options:
 *   caller          counter label (required)
 *   chain           chain key (picks the public lanes)
 *   rpcs            the configured list (keyed first): the fallback, and the whole read on rollback
 *   head            the caller's latest block (depth is measured from it)
 *   maxDepthBlocks  a public lane is used only when fromBlock >= head - this
 *   timeoutMs       per-call deadline on the configured list (default 8000)
 *   publicTimeoutMs per-call deadline on a public lane (default 5000)
 *   lanes, fetchImpl, fallback   test seams (fallback(rpcs, method, params, timeoutMs))
 */
export async function evmLogsRead(filter, opts = {}) {
  const env = opts.env || process.env;
  const caller = opts.caller || "unnamed";
  const c = countsOf(caller);
  const fallback = opts.fallback || rpcCall;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const from = parseInt(filter.fromBlock, 16), to = parseInt(filter.toBlock, 16);
  const failures = [];
  if (!evmLogsAlchemyFirst(env) && Number.isFinite(from) && Number.isFinite(to) && to >= from) {
    const lanes = opts.lanes || evmLogsPublicLanes(opts.chain, env);
    const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    const head = Number(opts.head);
    const depth = Number(opts.maxDepthBlocks);
    for (const lane of lanes) {
      const st = stateOf(lane.url);
      if (to - from + 1 > (lane.maxRange || 9_000)) { c.publicSkipped.range++; continue; }
      const laneMax = Number.isFinite(lane.maxDepthSeconds) ? laneDepthBlocks(lane, opts.chain) : (lane.maxDepth ?? Infinity);
      const laneDepth = Math.min(Number.isFinite(depth) ? depth : Infinity, laneMax);
      if (!Number.isFinite(head) || !Number.isFinite(laneDepth) || from < head - laneDepth) { c.publicSkipped.depth++; continue; }
      if (st.coolUntil > Date.now()) { c.publicSkipped.cooling++; continue; }
      const out = await tryPublic(lane.url, filter, from, to, opts.publicTimeoutMs ?? 5000, fetchImpl);
      if (out.kind === "ok") { c.publicServed++; st.strikes = 0; note("public"); return out.logs; }
      c.publicRejected[out.kind] = (c.publicRejected[out.kind] || 0) + 1;
      // A lane that says it cannot do this range is not unhealthy; the others cool.
      if (out.kind === "rateLimited") cool(st, 30_000);
      else if (out.kind !== "rangeCap" && out.kind !== "behindHead") cool(st, 10_000);
      failures.push(`${host(lane.url)}: ${out.why}`);
    }
  }
  try {
    const logs = await fallback(opts.rpcs || [], "eth_getLogs", [filter], timeoutMs);
    c.fallbackServed++; note("fallback");
    return logs;
  } catch (e) {
    c.failed++; note("none");
    if (failures.length) e.message = `${e.message} | public: ${failures.join(" | ")}`.slice(0, 600);
    throw e;
  }
}

/**
 * For /api/gateway-status. Public: one word. Operator: per-caller counts.
 *   idle      no read since restart
 *   publics   public lanes served at least half of the recent reads
 *   fallback  the configured list served most recent reads
 *   failing   most recent reads failed on every lane
 */
export function evmLogsStatus({ full = false, extra = null } = {}) {
  const n = recent.length;
  let status = "idle";
  if (n) {
    const pub = recent.filter((o) => o === "public").length;
    const none = recent.filter((o) => o === "none").length;
    status = none * 2 > n ? "failing" : pub * 2 >= n ? "publics" : "fallback";
  }
  if (!full) return { status };
  return {
    status, sinceRestart: true, since: new Date(startedAt).toISOString(),
    order: evmLogsAlchemyFirst() ? "keyed-first" : "public-first (recent ranges)",
    callers: Object.fromEntries([...callers].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])),
    ...(extra || {}),
  };
}

export function __resetEvmLogsForTest() { callers.clear(); laneState.clear(); recent.length = 0; startedAt = Date.now(); }
