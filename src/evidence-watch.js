// Operator watch list for settlement evidence that looks staged.
//
// The router's floor (settled calls from distinct payers at the wallet a
// seller's 402 names) is a count anyone can buy their way past with a few
// fresh wallets. Tightening the floor would drop real sellers, most of whom
// clear it on one heavy integration, so it stays as it is. This report only
// lists wallets that clear the floor with signals that are cheap to fake
// together, for a person to look at. It changes no verdict and nothing
// public reads it.
//
// Signals, each read from the leaderboard row the floor itself reads:
//   lowVolume          settled dollars in the window below LOW_VOLUME_USD
//   isolatedPayers     no payer of this wallet pays any other seller
//   topPayerCarries    the floor is not met without the busiest payer
//   singlePayerShare   one payer made most of the calls (the row's own flag)
// A row is listed when it clears the floor, its payers pay no other seller
// (fresh wallets made for one seller look like this), and at least one more
// signal holds. Cheap volume or one heavy payer on their own are the normal
// shape of a small real integration, so neither lists a row by itself.

export const LOW_VOLUME_USD = 1;
export const MIN_SIGNALS = 2;

/** One leaderboard row -> its signals (empty when none). */
export function evidenceSignals(row, { minSettled = 50, minPayers = 3, lowVolumeUsd = LOW_VOLUME_USD } = {}) {
  const out = [];
  const usd = Number(row?.totalUsd) || 0;
  if (usd < lowVolumeUsd) out.push("lowVolume");
  if (row?.multiSellerPayers === 0) out.push("isolatedPayers");
  const w = row?.withoutTopPayer;
  if (w && !((Number(w.callsSettled) || 0) >= minSettled && (Number(w.uniqueBuyers) || 0) >= minPayers)) out.push("topPayerCarries");
  if (row?.concentration) out.push("singlePayerShare");
  return out;
}

/**
 * Rows that clear the floor and look staged, most signals first, then the
 * smallest dollar volume. `self` (lowercased wallets) are our own and skipped.
 */
export function evidenceWatchList(rows, { minSettled = 50, minPayers = 3, lowVolumeUsd = LOW_VOLUME_USD, self = new Set() } = {}) {
  const listed = [];
  let clearing = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const wallet = String(r?.wallet || "").toLowerCase();
    if (!wallet || self.has(wallet)) continue;
    if (!((Number(r.callsSettled) || 0) >= minSettled && (Number(r.uniqueBuyers) || 0) >= minPayers)) continue;
    clearing++;
    const signals = evidenceSignals(r, { minSettled, minPayers, lowVolumeUsd });
    if (signals.length < MIN_SIGNALS || !signals.includes("isolatedPayers")) continue;
    listed.push({
      wallet,
      network: r.network || null,
      name: r.name || null,
      origins: Array.isArray(r.origins) ? r.origins.slice(0, 10) : [],
      callsSettled: Number(r.callsSettled) || 0,
      uniqueBuyers: Number(r.uniqueBuyers) || 0,
      totalUsd: Number(r.totalUsd) || 0,
      multiSellerPayers: r.multiSellerPayers ?? null,
      topPayerCallsShare: r.topPayerCallsShare ?? null,
      withoutTopPayer: r.withoutTopPayer || null,
      signals,
    });
  }
  listed.sort((a, b) => b.signals.length - a.signals.length || a.totalUsd - b.totalUsd);
  return { clearing, listed };
}
