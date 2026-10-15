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
// Only payloads made of `type` (and `dex`) are shared. A read with a coin, a
// time window or a user is never cached here.
import { createTtlCache } from "./ttl-dedupe.js";

export const HL_LIVE_TTL_MS = 5_000;
export const HL_LISTING_TTL_MS = 60_000;

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

/** TTL for a payload, or 0 when it must not be shared. */
export function sharedTtlFor(payload) {
  if (!payload || typeof payload !== "object") return 0;
  const keys = Object.keys(payload);
  if (keys.some((k) => k !== "type" && k !== "dex")) return 0;
  return HL_SHARED_TTLS[payload.type] ?? 0;
}

const keyOf = (payload) => `${payload.type}|${payload.dex ?? ""}`;

/**
 * Read a Hyperliquid info document through the shared cache. `fetchInfo` is
 * the calling kit's own transport (its error mapping stays its own); only a
 * value it RETURNS is stored. Payloads that are not shareable go straight to
 * `fetchInfo`.
 */
export async function hlSharedInfo(payload, fetchInfo) {
  const ttl = sharedTtlFor(payload);
  if (!ttl) return fetchInfo(payload);
  const { value } = await cache.get(keyOf(payload), ttl, () => fetchInfo(payload));
  return value;
}

export const __hlShared = {
  clear: () => cache.clear(),
  size: () => cache.size(),
  stats: () => cache.stats(),
};
