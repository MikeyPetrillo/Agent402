// Money records kept for their retention period, then removed.
//
//   - sales ledger: 7 years (LEDGER_RETENTION_SALES_YEARS, never under 7)
//   - refund ledger, resolved rows (paid or void): 7 years; an owed, sending
//     or blocked row is never removed
//   - sanctions events: 10 years (src/sanctions-events.js; never under 10,
//     and an event still waiting for its report is never removed)
//
// DRY RUN BY DEFAULT. A daily pass under the lease `ledger-retention` counts
// what is past its period and logs the counts; it deletes only while
// LEDGER_RETENTION=apply. The last pass is on /__operator/ledger-retention.json.
// The first pass runs ten minutes after boot.
import { leased } from "./state-db.js";
import { contained } from "./contained-turn.js";

export const SALES_RETENTION_MIN_YEARS = 7;
export const REFUNDS_RETENTION_MIN_YEARS = 7;
const DAY_MS = 86_400_000;

const yearsOf = (v, min) => { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.floor(n) : min; };
export function retentionSettings(env = process.env) {
  return {
    apply: String(env.LEDGER_RETENTION || "").trim().toLowerCase() === "apply",
    salesYears: yearsOf(env.LEDGER_RETENTION_SALES_YEARS, SALES_RETENTION_MIN_YEARS),
    refundYears: yearsOf(env.LEDGER_RETENTION_REFUND_YEARS, REFUNDS_RETENTION_MIN_YEARS),
  };
}
/** The time `years` calendar years before `now` (UTC). */
export function yearsBefore(now, years) {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.getTime();
}

let last = null;
/** The last pass, for the operator view. */
export function ledgerRetentionStatus() { return last ? { ...last } : { ran: false, ...retentionSettings() }; }

/**
 * One pass. `deps` are the three prune functions (tests pass stubs). Never
 * throws: a part that fails is reported with its error and the rest run.
 */
export async function runLedgerRetention({ now = Date.now(), env = process.env, deps = null, log = console.log } = {}) {
  const s = retentionSettings(env);
  const d = deps || {
    sales: async (cut, o) => (await import("./sales-ledger.js")).pruneSalesBefore(cut, o),
    refunds: async (cut, o) => (await import("./refund-ledger.js")).pruneResolvedRefundsBefore(cut, o),
    sanctions: async (o) => (await import("./sanctions-events.js")).pruneSanctionsEvents(o),
  };
  const out = { ran: true, at: new Date(now).toISOString(), apply: s.apply, salesYears: s.salesYears, refundYears: s.refundYears, parts: {} };
  const part = async (name, fn) => {
    try { out.parts[name] = await fn(); }
    catch (e) { out.parts[name] = { error: String(e?.message || e).slice(0, 160) }; }
  };
  await part("sales", () => d.sales(yearsBefore(now, s.salesYears), { apply: s.apply }));
  await part("refunds", () => d.refunds(yearsBefore(now, s.refundYears), { apply: s.apply }));
  await part("sanctions", () => d.sanctions({ apply: s.apply, now }));
  const line = Object.entries(out.parts).map(([k, v]) => (v.error ? `${k} error (${v.error})` : `${k} ${v.due} past retention${s.apply ? `, ${v.removed} removed` : ""}`)).join("; ");
  log(`[ledger-retention] ${s.apply ? "applied" : "dry run (LEDGER_RETENTION=apply deletes)"}: ${line}`);
  last = out;
  return out;
}

/** The daily pass under its lease; returns a stop function. */
export function startLedgerRetention({ firstMs = 10 * 60_000, everyMs = DAY_MS, log = console.log } = {}) {
  const tick = leased("ledger-retention", { ttlMs: 10 * 60_000, log: console.warn }, () => runLedgerRetention({ log }));
  const run = contained("ledger-retention", () => Promise.resolve().then(tick).catch((e) => log(`[ledger-retention] pass failed: ${String(e?.message || e).slice(0, 160)}`)));
  const first = setTimeout(run, firstMs); first.unref?.();
  const timer = setInterval(run, everyMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
