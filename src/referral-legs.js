// The split legs of each proven /ref sale, for the operator's books.
//
// A /ref payment goes to the network's split contract, which pays our
// merchant's share to our payout wallet and the rest to the legs its routed
// event names (src/referral-proof.js reads the receipt). The sales ledger
// books one row at the net (`.claude/rules/payments.md`, the rail
// `referral`); this keeps, per proven payment, what the receipt showed: the
// gross, the event's four leg words, the merchant amount and every transfer
// out of the contract with its recipient address. So totals per recipient
// address per year can be produced from our own records.
//
// Operator only: nothing here reaches a public surface. With a state database
// each payment is one `records` row (collection `referral-legs`, id the
// payment's replay key, so a second write of the same payment replaces it);
// without one the last MEMORY_MAX are kept in this process.
import { stateDbEnabled, records } from "./state-db.js";

export const LEGS_COLLECTION = "referral-legs";
const MEMORY_MAX = 2000;
const RECENT = 20;
const ADDR = /^0x[0-9a-f]{40}$/;
const UNITS = /^\d{1,78}$/;

/** The stored shape of one proven payment's split, or null when it is not one. */
export function legsRow({ key, slug, payer, tx, split, at }) {
  if (!key || !split || typeof split !== "object") return null;
  const units = (v) => (UNITS.test(String(v ?? "")) ? String(v) : null);
  const legs = Array.isArray(split.legs) ? split.legs.slice(0, 8).map(units) : [];
  const recipients = Array.isArray(split.recipients)
    ? split.recipients.slice(0, 16).filter((r) => ADDR.test(String(r?.to || "").toLowerCase()) && units(r?.amount)).map((r) => ({ to: String(r.to).toLowerCase(), amount: String(r.amount) }))
    : [];
  return {
    key: String(key).slice(0, 200), slug: String(slug || "").slice(0, 120), payer: String(payer || "").slice(0, 64), tx: String(tx || "").slice(0, 80),
    gross: units(split.gross), merchant: units(split.merchant), legs, recipients, at: Number(at) || Date.now(),
  };
}

/** Per recipient address, the sum and count of transfers in one UTC year. */
export function totalsByRecipient(rows, year) {
  const y = Number(year);
  const out = new Map();
  for (const r of rows) {
    if (!r || new Date(Number(r.at)).getUTCFullYear() !== y) continue;
    for (const t of r.recipients || []) {
      const o = out.get(t.to) || { to: t.to, units: 0n, transfers: 0 };
      try { o.units += BigInt(t.amount); o.transfers++; } catch { continue; }
      out.set(t.to, o);
    }
  }
  return [...out.values()].sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0)).map((o) => ({ to: o.to, units: o.units.toString(), transfers: o.transfers }));
}

export function createReferralLegs({ db = stateDbEnabled(), store = records, log = console } = {}) {
  const memory = [];
  let recorded = 0, failures = 0;

  async function record(input) {
    const row = legsRow(input);
    if (!row) return false;
    memory.push(row);
    if (memory.length > MEMORY_MAX) memory.splice(0, memory.length - MEMORY_MAX);
    if (!db) { recorded++; return true; }
    try { await store.put(LEGS_COLLECTION, row.key, row); recorded++; return true; } catch (e) {
      failures++;
      try { log.warn?.(`[referral-legs] a split record was not written (${String(e?.message || e).slice(0, 120)}); kept in memory`); } catch { /* logging only */ }
      return false;
    }
  }

  /** Every stored row (the database's when there is one, else this process's). */
  async function allRows() {
    if (!db) return memory.slice();
    const out = [];
    let after = "";
    for (let i = 0; i < 1000; i++) {
      const page = await store.list(LEGS_COLLECTION, { limit: 1000, after });
      for (const p of page) out.push(p.body);
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
    return out;
  }

  /** Counts and the latest rows, for /__operator/referral.json. */
  function view() {
    return { store: db ? "database" : "memory", recorded, failures, recent: memory.slice(-RECENT).reverse() };
  }

  async function totals(year) {
    return { year: Number(year), byRecipient: totalsByRecipient(await allRows(), year) };
  }

  return { record, view, totals, allRows };
}
