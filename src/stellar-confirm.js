// Did a Stellar payment actually land, whatever the facilitator said?
//
// Stellar closes a ledger about every 5 seconds. The OpenZeppelin channel
// service gives up before that close and answers settle_channel_service_failed,
// @x402/express then discards the already-computed response body and returns a
// 402 - and the transfer confirms a few seconds later anyway. Measured
// 2026-08-03: we answered 402 at 17:10:48.044, the transfer confirmed at
// 17:10:52, on-chain effects showing account_debited from the payer and
// account_credited to our payTo.
//
// The buyer is therefore CHARGED and receives an error saying they were not.
// The handler had already run, so we did the work, took the money, and threw
// the answer away. That is ours to fix, not the buyer's to absorb.
//
// This asks the chain before we accept the facilitator's verdict. It is only
// ever consulted AFTER a settle failure, so the happy path pays nothing for it.
//
// SAFETY - the only dangerous mistake here is confirming a payment that did not
// happen, which would hand out the tool for free. So:
//   * a transfer counts only if the PAYER was debited and OUR payTo was
//     credited in the SAME transaction, after this attempt began
//   * the transaction must be `successful` on-chain
//   * any error, timeout, or unparseable response returns null, which leaves
//     the original failure standing. Never "assume paid" on a flake.
// Being wrong in the other direction (missing a real payment) costs us the sale
// and is already the status quo, so it is the safe way to fail.

const DEFAULT_HORIZON = "https://horizon.stellar.org";

/**
 * Who paid, according to the FACILITATOR — not according to the payload.
 *
 * The first version of this read `paymentPayload.payload.payer`, which does not
 * exist: a Stellar payload carries `payload.transaction`, a base64 XDR envelope.
 * So the payer was always undefined, confirmStellarTransfer bailed immediately,
 * and the whole fix was dead on arrival while its unit tests passed — they
 * tested the confirmation, and nothing tested where the payer came from.
 *
 * Parsing the XDR would not help either: the transaction's source account is the
 * facilitator's channel account, not the buyer. Measured — the buyer was
 * GBA2DD…NY6O4 while the transaction source was GDR2UY…KGE3T.
 *
 * `SettleError` and the settle response both carry `payer`, populated from the
 * verify step, so the facilitator hands us the buyer's address even when it is
 * telling us the settlement failed. That is the only reliable source.
 */
export function settlePayerOf(resultOrError) {
  const p = resultOrError?.payer;
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

/** One Horizon GET returning parsed JSON, or null on any failure. */
async function getJson(url, fetchImpl, timeoutMs) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Look for a confirmed USDC transfer from `payer` to `payTo` since `sinceMs`.
 *
 * Returns `{ transaction, amount }` when one is found, otherwise null.
 * Polls because the whole point is that the transfer lands LATE.
 */
export async function confirmStellarTransfer({
  payer,
  payTo,
  sinceMs,
  horizon = process.env.STELLAR_HORIZON_URL || DEFAULT_HORIZON,
  assetCode = "USDC",          // pin the asset; see the filter below
  waitMs = 8_000,
  stepMs = 1_500,
  timeoutMs = 4_000,
  fetchImpl = fetch,
} = {}) {
  if (!payer || !payTo || !Number.isFinite(sinceMs)) return null;
  const base = String(horizon).replace(/\/+$/, "");
  const deadline = Date.now() + waitMs;

  for (;;) {
    // Payer-side first: a buyer's account has far fewer recent effects than our
    // payTo, which is credited by every chain we serve.
    const eff = await getJson(
      `${base}/accounts/${encodeURIComponent(payer)}/effects?order=desc&limit=25`,
      fetchImpl, timeoutMs,
    );
    const recs = eff?._embedded?.records || [];
    const debits = recs.filter((e) => {
      if (e?.type !== "account_debited") return false;
      if (e?.asset_type === "native") return false;      // XLM fees are not the payment
      // Pin the ASSET when the caller supplies one. Excluding native alone
      // accepts ANY non-XLM token, and anyone can issue an asset called
      // whatever they like on Stellar - so "a token arrived" proves nothing.
      if (assetCode && e?.asset_code && e.asset_code !== assetCode) return false;
      const t = Date.parse(e?.created_at || "");
      return Number.isFinite(t) && t >= sinceMs;
    });
    for (const d of debits) {
      const txHref = d?._links?.transaction?.href;
      const txHash = d?.transaction_hash
        || (typeof txHref === "string" ? txHref.split("/").filter(Boolean).pop() : null);
      if (!txHash) continue;

      // The debit alone is not proof the money reached US - it could be any
      // payment this buyer made. Confirm the same transaction credited our
      // payTo, and that the transaction itself succeeded.
      const tx = await getJson(`${base}/transactions/${txHash}`, fetchImpl, timeoutMs);
      if (!tx || tx.successful !== true) continue;

      const txEff = await getJson(`${base}/transactions/${txHash}/effects?limit=50`, fetchImpl, timeoutMs);
      const credited = (txEff?._embedded?.records || []).find(
        (e) => e?.type === "account_credited" && e?.account === payTo,
      );
      if (credited) {
        if (assetCode && credited.asset_code && credited.asset_code !== assetCode) continue;
        return { transaction: txHash, amount: credited.amount || d.amount || null };
      }
    }

    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
