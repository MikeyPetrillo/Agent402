// Has this payer ever settled a payment with us?
//
// Two bounds on unsettled runs are smaller for a payer with no paid record
// (runs in flight on a balance that could not be read, src/inflight-cover.js;
// payments with no readable terms, src/gateway-settle-breaker.js), so the
// answer errs toward "paid" whenever it cannot be read:
//   - a settlement this process saw succeed (notePaidSettlement), kept in
//     memory, is a paid record at once, before the sale row is written;
//   - else the sales ledger's paid-sale read (payerHasPaidSale), handed in by
//     the server at import (this module never imports the ledger: the decide
//     service reaches it through the gateway kit);
//   - a ledger whose first load has not landed, or a read that throws, counts
//     as paid.
// With no ledger registered (a unit test, a process that serves no payments)
// only the in-memory marks answer.
// The payer is the address as the ledger spells it: lowercase for EVM, case
// kept for Solana, Algorand and Stellar.
import { normalizePayerAddress } from "./payer.js";

const RECENT_MAX = 50_000;
const recent = new Map(); // payer -> last settlement seen (ms); least recently set first
let reader = null, loaded = null, override = null;

/** The server: the sales ledger's paid-sale read and its loaded state. */
export function setPaidRecordLedger({ payerHasPaidSale, salesLedgerLoaded } = {}) {
  reader = typeof payerHasPaidSale === "function" ? payerHasPaidSale : null;
  loaded = typeof salesLedgerLoaded === "function" ? salesLedgerLoaded : null;
}
/** A settlement from this payer succeeded just now. */
export function notePaidSettlement(payer, now = Date.now()) {
  const p = normalizePayerAddress(payer);
  if (!p) return false;
  recent.delete(p);
  recent.set(p, now);
  while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
  return true;
}
/** True when the payer has settled a payment with us, or that cannot be read. */
export function hasPaidRecord(payer) {
  const p = normalizePayerAddress(payer);
  if (!p) return false;
  if (override) { try { return !!override(p); } catch { return true; } }
  if (recent.has(p)) return true;
  if (!reader) return false;
  try { if (loaded && !loaded()) return true; return !!reader(p); } catch { return true; }
}
/** Tests: stand in for the whole answer (null restores it), and clear the marks. */
export function _setPaidRecordForTest(fn) { override = typeof fn === "function" ? fn : null; }
export function _resetPaidRecordForTest() { recent.clear(); override = null; }
