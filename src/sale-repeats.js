// One settlement, one sale.
//
// A Solana payment is one signed transaction: its signature names one
// transfer from one payer, so the ledger holds at most one sale for it. A row
// that names a signature an earlier row already holds is a repeat of that
// sale, never a second one. The rule is scoped to where it is true of the
// chain: a card invoice, a subscription charge and a split contract's payout
// can each stand behind more than one sale, so those rows are never read as
// repeats.
//
// This module is the rule alone (no store, no imports), shared by the ledger's
// writer and readers (src/sales-ledger.js) and the operator's listing
// (scripts/sale-repeats.js, src/sale-repeats-correction.js).

/** The rail a settlement of this kind is booked on. */
export const ONE_SALE_RAIL = "usdc";
/** Networks whose settlement id names exactly one payment. */
const ONE_SALE_NETWORK = /^solana(?::|$)/;

/** True when this row's settlement id can stand behind one sale only. */
export function isOneSaleSettlement({ rail, network, tx } = {}) {
  return rail === ONE_SALE_RAIL && typeof tx === "string" && tx !== "" && ONE_SALE_NETWORK.test(String(network || ""));
}

/** The same test as a SQL term (SQLite and Postgres), on an optional table alias. */
export function oneSaleScopeSql(alias = "") {
  const a = alias ? `${alias}.` : "";
  return `${a}rail = '${ONE_SALE_RAIL}' AND (${a}network = 'solana' OR ${a}network LIKE 'solana:%') AND ${a}tx IS NOT NULL AND ${a}tx <> ''`;
}

/** Every repeat row: a row in scope with an earlier row (lower id) in scope under the same settlement id. */
export function repeatRowsSql(table = "sales") {
  return `SELECT r.id FROM ${table} r WHERE ${oneSaleScopeSql("r")} AND EXISTS (SELECT 1 FROM ${table} f WHERE f.tx = r.tx AND f.id < r.id AND ${oneSaleScopeSql("f")})`;
}
