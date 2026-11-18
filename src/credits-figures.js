// The figures the credits balance page runs on, and the words copy prints
// for them. Every sentence that states one (the sign-in emails and pages,
// /privacy, /terms, the low-balance email and the balance page) reads it
// here, so changing a figure changes every sentence that states it.
// No imports: the legal pages and the emails read this without loading the
// credits store.

/** A sign-in link works once, for this long. */
export const SIGN_IN_TTL_MS = 15 * 60_000;
/** A balance page session ends after this long without use... */
export const SESSION_IDLE_MS = 30 * 60_000;
/** ...and after this long at most. */
export const SESSION_MAX_MS = 12 * 3600_000;
/** A balance under this (with what is held) is low: the low-balance notice is
 *  sent once each time a charge takes the balance across it. */
export const LOW_BALANCE_MICRO = 2 * 1_000_000;

/** A duration in the largest whole unit that states it exactly: "15 minutes", "12 hours", "1 day". */
export function durationWords(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  for (const [unit, size] of [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000], ["second", 1000]]) {
    if (n >= size && n % size === 0) { const k = n / size; return `${k} ${unit}${k === 1 ? "" : "s"}`; }
  }
  return `${Math.max(1, Math.round(n / 1000))} seconds`;
}

export const signInLifeWords = () => durationWords(SIGN_IN_TTL_MS);
export const sessionIdleWords = () => durationWords(SESSION_IDLE_MS);
export const sessionMaxWords = () => durationWords(SESSION_MAX_MS);
/** The low-balance threshold as dollars: "$2.00". */
export const lowBalanceUsd = () => LOW_BALANCE_MICRO / 1_000_000;
export const lowBalanceWords = () => `$${lowBalanceUsd().toFixed(2)}`;
