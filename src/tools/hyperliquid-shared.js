// One cache for the Hyperliquid info reads that crypto-signals-kit and
// derivatives-kit both make.
//
// Hyperliquid meters its info endpoint per IP: 1200 weight per minute, and
// the universe-wide reads used here (metaAndAssetCtxs, meta,
// predictedFundings, the HIP-3 dex listings) weigh 20 each, so the whole
// host gets about 60 of them a minute. Both kits call the same endpoint from
// the same egress IP, so a per-kit cache would still spend the budget twice;
// this module is the one place either kit reads those documents.
//
// TTLs, chosen against that budget:
//   * 5 s for documents that carry live prices, funding or open interest.
//     One key then costs at most 12 reads a minute (240 weight, a fifth of
//     the budget) however many buyers call, which leaves the rest for the
//     reads that are never shared (candles, order books, funding history).
//     Hyperliquid's own oracle moves every few seconds and funding settles
//     hourly, so a 5 s bound is inside what any snapshot tool can promise.
//   * 60 s for listings that change on governance time (the universe, the
//     dex list, every dex's market list): one read a minute.
// Only payloads made of `type` (and `dex`) are shared by default. A read with
// a coin, a time window or a user is cached only when the caller names its own
// key and TTL (perp-funding's hour-aligned funding history).
//
// Rate-limit refusals (a transport error carrying `rateLimited`):
//   * a read is tried once more after a jittered pause, so parallel callers
//     that met the same refusal do not return in lockstep;
//   * a shared document whose last good copy is at most HL_STALE_MAX_MS old is
//     served from that copy, and the read is recorded as stale so the tool's
//     answer can say so (see withHlFreshness); with no copy the refusal stands.
import { AsyncLocalStorage } from "node:async_hooks";
import { createTtlCache } from "./ttl-dedupe.js";

export const HL_LIVE_TTL_MS = 5_000;
export const HL_LISTING_TTL_MS = 60_000;
export const HL_HISTORY_TTL_MS = 30_000;
export const HL_STALE_MAX_MS = Number(process.env.HL_STALE_MAX_MS) || 60_000;
// After a refusal for rate, the stale copy answers without a live read for
// this long, so a burst that meets one refusal spends no more of the budget.
export const HL_REFUSAL_HOLD_MS = 5_000;
const RETRY_JITTER_MIN_MS = 250;
const RETRY_JITTER_SPAN_MS = 750;

export const HL_SHARED_TTLS = Object.freeze({
  metaAndAssetCtxs: HL_LIVE_TTL_MS,
  predictedFundings: HL_LIVE_TTL_MS,
  perpDexStatus: HL_LIVE_TTL_MS,
  perpsAtOpenInterestCap: HL_LIVE_TTL_MS,
  perpDeployAuctionStatus: HL_LIVE_TTL_MS,
  perpDexLimits: HL_LISTING_TTL_MS,
  meta: HL_LISTING_TTL_MS,
  perpDexs: HL_LISTING_TTL_MS,
  allPerpMetas: HL_LISTING_TTL_MS,
});

const cache = createTtlCache({ maxEntries: 64 });
const LAST_GOOD_MAX = 128;
const lastGood = new Map(); // key -> { at, value }
const freshness = new AsyncLocalStorage();
let pauseFn = (ms) => new Promise((r) => setTimeout(r, ms));
let jitterFn = () => RETRY_JITTER_MIN_MS + Math.floor(Math.random() * RETRY_JITTER_SPAN_MS);
let nowFn = () => Date.now();

/** TTL for a payload, or 0 when it must not be shared. */
export function sharedTtlFor(payload) {
  if (!payload || typeof payload !== "object") return 0;
  const keys = Object.keys(payload);
  if (keys.some((k) => k !== "type" && k !== "dex")) return 0;
  return HL_SHARED_TTLS[payload.type] ?? 0;
}

const keyOf = (payload) => `${payload.type}|${payload.dex ?? ""}`;

function remember(key, value) {
  if (lastGood.has(key)) lastGood.delete(key);
  while (lastGood.size >= LAST_GOOD_MAX) lastGood.delete(lastGood.keys().next().value);
  lastGood.set(key, { at: nowFn(), value });
}

// One read, and one more after a jittered pause when the first is refused for
// rate. Any other failure, or a second refusal, is the caller's error.
async function readOnceMore(payload, fetchInfo) {
  try { return await fetchInfo(payload); }
  catch (err) {
    if (!err?.rateLimited) throw err;
    await pauseFn(jitterFn());
    return fetchInfo(payload);
  }
}

function noteStale(at) {
  const scope = freshness.getStore();
  if (scope && (scope.oldestAt == null || at < scope.oldestAt)) scope.oldestAt = at;
}

/**
 * Read a Hyperliquid info document through the shared cache. `fetchInfo` is
 * the calling kit's own transport (its error mapping stays its own); only a
 * value it RETURNS is stored. Payloads that are not shareable go straight to
 * `fetchInfo` (with the one rate-limit retry) unless the caller passes its own
 * `cacheKey` and `ttlMs`.
 */
export async function hlSharedInfo(payload, fetchInfo, { cacheKey, ttlMs } = {}) {
  const ttl = cacheKey && ttlMs > 0 ? ttlMs : sharedTtlFor(payload);
  if (!ttl) return readOnceMore(payload, fetchInfo);
  const key = cacheKey && ttlMs > 0 ? cacheKey : keyOf(payload);
  const held = lastGood.get(key);
  if (held?.refusedAt != null && nowFn() - held.refusedAt < HL_REFUSAL_HOLD_MS && nowFn() - held.at <= HL_STALE_MAX_MS) {
    noteStale(held.at);
    return held.value;
  }
  try {
    const { value, cached } = await cache.get(key, ttl, () => readOnceMore(payload, fetchInfo));
    if (!cached) remember(key, value);
    return value;
  } catch (err) {
    const copy = err?.rateLimited ? lastGood.get(key) : null;
    if (copy && nowFn() - copy.at <= HL_STALE_MAX_MS) { copy.refusedAt = nowFn(); noteStale(copy.at); return copy.value; }
    throw err;
  }
}

/**
 * Run `fn` and report whether any shared read inside it was served from a
 * stale copy: { result, staleSince } where staleSince is the epoch ms of the
 * oldest such copy, or null when every read was live or inside its TTL.
 */
export async function withHlFreshness(fn) {
  const scope = { oldestAt: null };
  const result = await freshness.run(scope, fn);
  return { result, staleSince: scope.oldestAt };
}

/**
 * Wrap a kit's tool list so an answer built from a stale copy says so in
 * fields: `stale: true`, `dataAsOf` (when the copy was read) and
 * `staleAgeSeconds`. A live answer is returned unchanged.
 */
export function labelHlStaleness(tools) {
  return tools.map((t) => ({
    ...t,
    handler: async (input, ctx) => {
      const { result, staleSince } = await withHlFreshness(() => t.handler(input, ctx));
      if (staleSince == null || !result || typeof result !== "object" || Array.isArray(result)) return result;
      return {
        ...result,
        stale: true,
        dataAsOf: new Date(staleSince).toISOString(),
        staleAgeSeconds: Math.max(0, Math.round((nowFn() - staleSince) / 1000)),
        staleReason: "Hyperliquid refused the live read for rate; this answer is built from the last good read, at most " + Math.round(HL_STALE_MAX_MS / 1000) + " seconds old",
      };
    },
  }));
}

export const __hlShared = {
  clear: () => { cache.clear(); lastGood.clear(); },
  setClock: ({ now, pause, jitter } = {}) => {
    if (now) nowFn = now;
    if (pause) pauseFn = pause;
    if (jitter) jitterFn = jitter;
  },
  lastGoodSize: () => lastGood.size,
  size: () => cache.size(),
  stats: () => cache.stats(),
};
