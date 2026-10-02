// The Base twin of the unproven Solana tier (2026-09-30).
//
// On Base the router pays only sellers whose own wallet clears the settlement
// floor, so a new seller could never earn its first routed settlement: it had
// to bring its own buyers first. A seller below the floor is now tried under a
// small per-call ceiling, only after every proven candidate for the task, only
// when the floor is the ONLY thing standing in the way (a self-funded history,
// a shared or mismatched wallet, a wrong EIP-712 domain or a failing delivery
// still refuse), paid only at the wallet its own live 402 names, and flagged
// `sellerProof: "unproven"` on the receipt. The ceiling is re-checked against
// the quote the router signs (payX402).
//
// Env SOR_BASE_UNPROVEN_MAX_USD, default $0.01; `0` or `off` restores the hard
// floor. A malformed value reads as the default, never as a wider ceiling.

export const BASE_UNPROVEN_DEFAULT_USD = 0.01;

export function baseUnprovenAllowanceUsd() {
  const raw = String(process.env.SOR_BASE_UNPROVEN_MAX_USD ?? "").trim().toLowerCase();
  if (raw === "") return BASE_UNPROVEN_DEFAULT_USD;
  if (raw === "off") return 0;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) return BASE_UNPROVEN_DEFAULT_USD;
  return usd;
}

/** The same ceiling in USDC atomic units (6 decimals). */
export function baseUnprovenAllowanceAtomic() {
  return BigInt(Math.round(baseUnprovenAllowanceUsd() * 1e6));
}
