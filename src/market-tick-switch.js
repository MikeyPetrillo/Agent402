// MARKET_TICK=on lists the market tick read (GET /api/market/tick). Off, the
// route is absent, as an unknown route is, and nothing public names it. It
// ships off: the data terms of both tools it reads from are under review, and
// a route is listed only once what it serves is settled. Kept apart from the
// kit so the sweeps and the corpus can read the switch without importing a
// tool kit (same shape as src/rugcheck-switch.js).
export const MARKET_TICK_SLUG = "market-tick";
export function marketTickEnabled(env = process.env) {
  return String(env.MARKET_TICK || "").trim().toLowerCase() === "on";
}
