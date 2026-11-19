// KALSHI_TOOLS=on lists the tools that read the Kalshi API
// (src/tools/prediction-market-kit.js). Unset (the default) or any other
// value: the tools are absent from every listing surface, their routes answer
// a free 503 not-offered ahead of every payment gate, and the kit makes no
// upstream read. Kept apart from the kit so the product tables, the sweeps and
// the tests can read it without importing a tool kit.

/** Every catalog tool that reads the Kalshi API. */
export const KALSHI_SLUGS = Object.freeze(new Set(["kalshi-markets", "kalshi-event", "kalshi-live-data", "kalshi-weather-index"]));

/** True only with KALSHI_TOOLS=on (trimmed, any case). */
export function kalshiToolsEnabled(env = process.env) {
  return String(env.KALSHI_TOOLS || "").trim().toLowerCase() === "on";
}

/** The refusal every Kalshi read gives with the switch off. Never charged (a
 *  status >= 400 cancels settlement). The same words as the stock switch's. */
export function kalshiNotOffered() {
  return Object.assign(new Error("This tool is not currently offered on this server."), { statusCode: 503, notOffered: true });
}
