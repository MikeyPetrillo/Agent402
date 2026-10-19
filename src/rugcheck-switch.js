// RUGCHECK_TOOLS=on lists what reads RugCheck: three Solana tools, the token
// brief, its card product and the token watch. Kept apart from the kits so the
// product tables can read it without importing a tool kit.
export const RUGCHECK_SLUGS = Object.freeze(new Set(["sol-token-safety", "sol-token-report", "sol-token-holders"]));
export function rugcheckEnabled(env = process.env) {
  return String(env.RUGCHECK_TOOLS || "").trim().toLowerCase() === "on";
}
