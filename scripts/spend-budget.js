// Reserve-before-spend budget for paying THIRD-PARTY x402 sellers, plus the
// on-chain check that decides whether a failed request actually took our money.
//
// WHY THIS EXISTS (a real overshoot, 2026-07-25)
//   scripts/algorand-external-buy.js used to count a buy against its cap only
//   when the seller returned a `payment-response` receipt header. That is a safe
//   assumption for OUR stack — @x402/express cancels settlement on any handler
//   status >= 400, so a 4xx/5xx is never charged — but it is NOT safe for a
//   third party, whose server may settle first and fail afterwards.
//
//   That is exactly what happened: a seller's paid endpoint returned
//   HTTP 502 with no receipt header, the run logged it as "not charged", and
//   $0.05 had in fact left the wallet on-chain. The run's true spend was $0.396
//   against its own $0.35 cap. Small in absolute terms, but a cap that can be
//   exceeded is the wrong shape.
//
// THE RULE
//   A cap must bound the WORST CASE, not the confirmed case. Any payment we
//   have signed and sent might settle, so it is committed the moment it goes out
//   and released only on positive evidence it did not land. "No receipt header"
//   is not evidence. An indexer lookup that finds no matching transfer is.
//   Anything inconclusive (indexer down, request threw) stays committed, which
//   can only ever make us spend LESS than the cap.

/** Budget that commits a spend before the request and releases only on proof.
 *  Pure and synchronous so scripts/test-spend-budget.js can pin the arithmetic. */
export function makeBudget(maxUsd) {
  let committed = 0;
  let released = 0;
  return {
    get committedUsd() { return committed; },
    get releasedUsd() { return released; },
    remaining() { return Math.max(0, maxUsd - committed); },
    /** True only if the FULL amount fits under the cap. */
    canAfford(usd) { return usd > 0 && committed + usd <= maxUsd + 1e-9; },
    /** Call immediately BEFORE sending a signed payment. */
    reserve(usd) { committed += usd; },
    /** Call ONLY when the payment is proven not to have settled. */
    release(usd) { committed = Math.max(0, committed - usd); released += usd; },
  };
}

const USDC_ASA = 31566704;

/** Did `payer` send exactly `amountAtomic` of USDC to `payTo` in this txn list?
 *  Pure given the indexer's transaction array, so the matching rule is testable
 *  without the network. */
export function findSettlement(transactions, { payer, payTo, amountAtomic }) {
  for (const tx of transactions || []) {
    const ax = tx["asset-transfer-transaction"];
    if (!ax) continue;
    if (Number(ax["asset-id"] ?? tx["asset-id"]) !== USDC_ASA) continue;
    if (tx.sender !== payer) continue;
    if (ax.receiver !== payTo) continue;
    if (String(ax.amount) !== String(amountAtomic)) continue;
    return tx.id || tx["tx-id"] || "unknown";
  }
  return null;
}

/** Ask the chain whether a payment landed. Returns {settled, tx, conclusive}.
 *
 *  `conclusive` is the important field: only a successful indexer read that
 *  found nothing lets the caller release the reservation. An indexer failure
 *  returns conclusive:false, and the caller must KEEP the money committed.
 *  Retries because the indexer lags a round or two behind settlement — calling
 *  it once immediately would report "not settled" for a payment that is simply
 *  not indexed yet, which is the very mistake this function exists to prevent. */
export async function verifySettlement(
  { payer, payTo, amountAtomic, sinceIso },
  { getJsonAcross, bases, attempts = 3, delayMs = 4000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  const path =
    `/v2/accounts/${payer}/transactions?asset-id=${USDC_ASA}&tx-type=axfer` +
    `&after-time=${encodeURIComponent(sinceIso)}&limit=200`;
  let sawAnyOk = false;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    let res;
    try { res = await getJsonAcross(bases, path, { timeoutMs: 10000 }); }
    catch { continue; }
    if (!res?.ok) continue;
    sawAnyOk = true;
    const tx = findSettlement(res.json?.transactions, { payer, payTo, amountAtomic });
    if (tx) return { settled: true, tx, conclusive: true };
  }
  // Every read failed -> we cannot say it did not settle.
  return { settled: false, tx: null, conclusive: sawAnyOk };
}
