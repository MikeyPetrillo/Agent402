// Memory audit-log retention settings, apart from src/tools/memory.js so a
// page that states them (src/privacy.js) does not open the memory store.
// The sweep itself, and what it removes and redacts, is in memory.js
// (auditSweepSql, sweepMemoryAudit).
export const AUDIT_RETENTION_DEFAULT_DAYS = 90;
/** Days an audit entry is kept (MEMORY_AUDIT_RETENTION_DAYS, a positive integer; anything else reads as the default). */
export function auditRetentionDays(env = process.env) {
  const n = Number(String(env.MEMORY_AUDIT_RETENTION_DAYS ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : AUDIT_RETENTION_DEFAULT_DAYS;
}
/** How often the sweep runs; also the bound on how long a deleted key's name stays in the log. */
export const AUDIT_SWEEP_MS = 10 * 60 * 1000;
