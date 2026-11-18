// MARKET_TICK=on lists the market tick read (GET /api/market/tick). Off, the
// route is absent, as an unknown route is, and nothing public names it. It
// ships off and is listed only once the operator turns it on. Its equity leg
// is the stock-quote tool, so it is listed only while a stock provider is
// active as well (src/tools/stock-provider.js). Kept apart from the kit so the
// sweeps and the corpus can read the switch without importing a tool kit
// (same shape as src/rugcheck-switch.js).
import { stockDataEnabled } from "./tools/stock-provider.js";

export const MARKET_TICK_SLUG = "market-tick";
export function marketTickEnabled(env = process.env) {
  return String(env.MARKET_TICK || "").trim().toLowerCase() === "on" && stockDataEnabled(env);
}
