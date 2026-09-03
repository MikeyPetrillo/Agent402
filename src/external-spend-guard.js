// Bound what a single buyer can make us spend upstream before they have paid us.
//
// THE HOLE. @x402/express runs the handler FIRST and settles AFTER, and a <400
// response whose settlement then fails has its body discarded and returns 402.
// On the external routing path the handler PAYS A THIRD-PARTY SELLER from our
// spending wallet. So the sequence is: buyer's payment verifies, we pay the
// seller real USDC, our settlement fails, buyer is charged nothing. We are out
// the upstream spend with no revenue and no recourse.
//
// Verify-then-fail-to-settle is not hypothetical: it happens naturally when a
// payer's balance drops between the two (documented on Solana, where our own
// best buyer drained to $0 and its last four purchases "timed out"). Self-dealt
// it is an attack - the same wallet lists the seller and buys from it, so every
// drained dollar lands back in the attacker's pocket, bounded per call only by
// the tier cap. It scales with exactly the cap we want to raise.
//
// The existing guards bound WHAT we pay (canonical-USDC asset pin, tier cap
// re-checked against the live 402, a 50-settlement/3-payer reliability floor).
// None of them bound WHETHER WE GET PAID, because that is decided after the
// handler has already spent.
//
// So: a payer may carry only so much UNSETTLED upstream spend at once. Spend is
// recorded before the buy and resolved on the FINAL response - `res.on("finish")`
// with statusCode 200, i.e. after @x402/express has settled - which is the same
// rule the idempotency cache uses and for the same reason: a 200 is not revenue
// until settlement says so.
//
// Deliberately NOT a reputation system. It is a debt ceiling: pay for what you
// asked for and your exposure clears within seconds. It only ever bites a payer
// whose settlements are failing, which is the population it exists for.

/** Max unsettled upstream spend one payer may carry, in USD.
 *
 *  Sized at TWO top-tier calls (route-execute-pro covers an underlying $3.00),
 *  so a buyer can have a second call in flight while the first is still
 *  settling - agents pipeline, and refusing that would break honest traffic -
 *  while a wallet whose payments never settle is stopped after two rather than
 *  draining indefinitely.
 *
 *  MUST be re-sized whenever a higher execution tier is added, or the new tier
 *  is dead on arrival: a single call larger than this ceiling is refused for
 *  every payer, including the honest ones. That coupling is the reason the
 *  tier table points back at this constant. */
const DEFAULT_MAX_UNSETTLED_USD = Number(process.env.EXTERNAL_MAX_UNSETTLED_USD || 6.0);

/** How long an unresolved spend counts against a payer. A settlement that never
 *  reports (process restart, a response that never finished) must not bar a
 *  payer forever, but it must not clear so fast that a fast loop outruns it. */
const STALE_MS = Number(process.env.EXTERNAL_SPEND_STALE_MS || 10 * 60_000);

/** Payers exempt from the ceiling: our own canary and any operator-listed
 *  wallet. Comma-separated, lowercased for EVM. */
function exemptSet() {
  return new Set(
    String(process.env.EXTERNAL_SPEND_EXEMPT || "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

// payer -> [{ usd, at, settled }]
const ledger = new Map();
let seq = 0;

const keyOf = (payer) => {
  if (typeof payer !== "string" || !payer.trim()) return null;
  // EVM addresses are case-insensitive; base58/Stellar/Algorand are NOT, and
  // folding them merges distinct payers (same rule as src/payer.js).
  const p = payer.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(p) ? p.toLowerCase() : p;
};

function prune(rows, now) {
  return rows.filter((r) => !r.settled && now - r.at < STALE_MS);
}

/** Current unsettled exposure for a payer, in USD. */
export function payerExposureUsd(payer, now = Date.now()) {
  const k = keyOf(payer);
  if (!k) return 0;
  const rows = prune(ledger.get(k) || [], now);
  if (rows.length) ledger.set(k, rows); else ledger.delete(k);
  return rows.reduce((s, r) => s + r.usd, 0);
}

/**
 * May this payer make us spend `usd` upstream right now?
 *
 * An UNKNOWN payer (free mode, a non-EIP-3009 rail we cannot attribute) is
 * allowed: refusing there would break every legitimate buyer on a rail whose
 * payer we cannot read, and the tier cap still bounds a single call. This is a
 * per-payer debt ceiling, not an identity requirement.
 */
export function maySpend(payer, usd, { maxUnsettledUsd = DEFAULT_MAX_UNSETTLED_USD, now = Date.now() } = {}) {
  const k = keyOf(payer);
  if (!k) return { ok: true, reason: "payer not attributable - bounded by the tier cap alone" };
  if (exemptSet().has(k.toLowerCase())) return { ok: true, reason: "exempt" };
  const exposure = payerExposureUsd(k, now);
  const next = exposure + (Number(usd) || 0);
  if (next > maxUnsettledUsd) {
    return {
      ok: false,
      exposure,
      reason:
        `this wallet already has $${exposure.toFixed(3)} of upstream spend from earlier calls whose payment has not settled` +
        ` (ceiling $${maxUnsettledUsd}). It clears as soon as those settle.`,
    };
  }
  return { ok: true, exposure };
}

/** Record an upstream spend as UNSETTLED. Returns a handle to resolve later. */
export function noteSpend(payer, usd, now = Date.now()) {
  const k = keyOf(payer);
  if (!k) return null;
  const row = { id: ++seq, usd: Number(usd) || 0, at: now, settled: false };
  const rows = prune(ledger.get(k) || [], now);
  rows.push(row);
  ledger.set(k, rows);
  return { payer: k, id: row.id };
}

/**
 * Correct a recorded spend to what was ACTUALLY paid, once that is known.
 *
 * The authorize-and-book step runs BEFORE the seller quotes, so it has to book
 * the worst case the call could cost (the tier cap). Booking the seller's
 * DECLARED price instead would let one document set our own debt ceiling: since
 * 2026-08-29 a route's resolved price comes from the origin's own current
 * declaration, so a seller declaring $0.0001 while quoting $0.005 on the live
 * 402 would have each call count as a fiftieth of its real exposure. The per-
 * call spend is bounded either way (payExternal re-checks maxAtomic against the
 * accept it signs), but the CEILING is what stops a run of them.
 *
 * Only ever lowers: the booked figure is the cap, and nothing may exceed it.
 */
export function adjustSpend(handle, usd) {
  if (!handle?.payer) return;
  const rows = ledger.get(handle.payer);
  if (!rows) return;
  const row = rows.find((r) => r.id === handle.id);
  if (!row) return;
  const actual = Number(usd);
  if (!Number.isFinite(actual) || actual < 0) return;
  if (actual < row.usd) row.usd = actual;
}

/**
 * Resolve a recorded spend once the FINAL response is known.
 *
 * `settled` must come from the post-settlement status (res.on("finish") with
 * statusCode === 200), never from the handler's own return: the handler
 * succeeding is precisely the state that precedes a settlement failure.
 */
export function resolveSpend(handle, settled) {
  if (!handle?.payer) return;
  const rows = ledger.get(handle.payer);
  if (!rows) return;
  const row = rows.find((r) => r.id === handle.id);
  if (!row) return;
  if (settled) {
    row.settled = true;
    const left = rows.filter((r) => !r.settled);
    if (left.length) ledger.set(handle.payer, left); else ledger.delete(handle.payer);
  }
  // NOT settled: the row stays as exposure until it ages out. That is the
  // whole point - an unpaid spend must keep counting against the payer.
}

/** Operator view: who currently owes us upstream spend. Counts only. */
export function exposureSnapshot(now = Date.now()) {
  const out = [];
  for (const [payer, rows] of ledger) {
    const live = prune(rows, now);
    if (!live.length) continue;
    out.push({ payer, unsettledUsd: Number(live.reduce((s, r) => s + r.usd, 0).toFixed(6)), calls: live.length });
  }
  return out.sort((a, b) => b.unsettledUsd - a.unsettledUsd);
}

/** Test-only. */
export function __reset() { ledger.clear(); seq = 0; }
export const __config = { DEFAULT_MAX_UNSETTLED_USD, STALE_MS };
