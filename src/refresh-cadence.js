// How often the background reads behind public pages refresh, and the words
// the pages use for it. One place, so a cadence change cannot leave copy that
// still says the old one. No imports: page modules read it without loading
// the scanners.

/** Base seller leaderboard (src/leaderboard.js). LEADERBOARD_REFRESH_MS overrides. */
export const LEADERBOARD_DEFAULT_REFRESH_MS = 4 * 60 * 60_000;
export const LEADERBOARD_REFRESH_MS = Number(process.env.LEADERBOARD_REFRESH_MS) || LEADERBOARD_DEFAULT_REFRESH_MS;

/** Live rail scan behind /revenue (src/revenue-live.js). REVENUE_SNAPSHOT_TTL_MS overrides. */
export const REVENUE_SNAPSHOT_DEFAULT_TTL_MS = 4 * 60 * 60_000;
export const REVENUE_SNAPSHOT_TTL_MS = parseInt(process.env.REVENUE_SNAPSHOT_TTL_MS, 10) || REVENUE_SNAPSHOT_DEFAULT_TTL_MS;

/** "hourly", "every 4 hours", or "every 30 minutes". */
export function cadenceWords(ms) {
  const h = ms / 3_600_000;
  if (Number.isInteger(h)) return h === 1 ? "hourly" : `every ${h} hours`;
  return `every ${Math.max(1, Math.round(ms / 60_000))} minutes`;
}
/** A short badge form: "HOURLY", "EVERY 4H", "EVERY 30M". */
export function cadenceBadge(ms) {
  const h = ms / 3_600_000;
  if (Number.isInteger(h)) return h === 1 ? "HOURLY" : `EVERY ${h}H`;
  return `EVERY ${Math.max(1, Math.round(ms / 60_000))}M`;
}
export const leaderboardCadence = () => cadenceWords(LEADERBOARD_REFRESH_MS);
export const revenueSnapshotCadence = () => cadenceWords(REVENUE_SNAPSHOT_TTL_MS);
