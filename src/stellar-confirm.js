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
/** The transaction hash a failed settle names, if any: the facilitator's
 *  timeout body carries `transaction` when something was submitted before
 *  its bound (2026-08-28), so the chain can be asked about THAT transaction
 *  instead of scanning the payer's recent effects. Exported for tests. */
export function settleTxOf(resultOrError) {
  const r = resultOrError;
  const h = r?.transaction || r?.response?.transaction || r?.data?.transaction;
  return typeof h === "string" && /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null;
}

/** Confirm ONE named transaction: it must be on-chain, successful, and carry
 *  an account_credited effect to our payTo in the pinned asset. Any miss ->
 *  null (the caller falls back to the payer scan). */
async function confirmByHash({ txHash, payTo, assetCode, base, fetchImpl, timeoutMs }) {
  const tx = await getJson(`${base}/transactions/${encodeURIComponent(txHash)}`, fetchImpl, timeoutMs);
  if (!tx || tx.successful !== true) return null;
  const txEff = await getJson(`${base}/transactions/${encodeURIComponent(txHash)}/effects?limit=50`, fetchImpl, timeoutMs);
  const credited = (txEff?._embedded?.records || []).find((e) => e?.type === "account_credited" && e?.account === payTo && (!assetCode || !e?.asset_code || e.asset_code === assetCode));
  return credited ? { transaction: txHash, amount: credited.amount || null } : null;
}

export async function confirmStellarTransfer({
  payer,
  payTo,
  sinceMs,
  txHash = null,
  horizon = process.env.STELLAR_HORIZON_URL || DEFAULT_HORIZON,
  assetCode = "USDC",          // pin the asset; see the filter below
  waitMs = 8_000,
  stepMs = 1_500,
  timeoutMs = 4_000,
  fetchImpl = fetch,
} = {}) {
  const base = String(horizon).replace(/\/+$/, "");
  // A named transaction is checked first and exactly - no window, no payer
  // matching (the same-buyer-window ambiguity the refund verifier had to
  // close). It is polled for the wait window too: a settle that timed out
  // right after submission lands a ledger or two later.
  if (txHash && payTo) {
    const hashDeadline = Date.now() + waitMs;
    for (;;) {
      const found = await confirmByHash({ txHash, payTo, assetCode, base, fetchImpl, timeoutMs });
      if (found) return found;
      if (Date.now() >= hashDeadline || !payer) break;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    if (!payer) return null;
  }
  if (!payer || !payTo || !Number.isFinite(sinceMs)) return null;
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
      // Resolve the transaction via the effect's OPERATION.
      //
      // A Horizon EFFECT carries no transaction hash and no transaction link -
      // its _links are operation/succeeds/precedes only. The first version read
      // `transaction_hash` and a `_links.transaction.href` that do not exist, so
      // every candidate was skipped and this function returned null for every
      // real payment. It looked correct because the unit-test stub injected
      // `transaction_hash`; against live Horizon it never confirmed anything,
      // which made both the late-settle fix and the Stellar refund verifier
      // inert. The operation DOES carry transaction_hash, and the operation id
      // is the effect id up to the dash.
      const opHref = d?._links?.operation?.href;
      const opId = String(d?.id || "").split("-")[0];
      const opUrl = (typeof opHref === "string" && opHref) || (opId ? `${base}/operations/${encodeURIComponent(opId)}` : null);
      if (!opUrl) continue;
      const op = await getJson(opUrl, fetchImpl, timeoutMs);
      // transaction_successful false = the operation is on-ledger but its
      // transaction failed, so nothing moved.
      if (!op || op.transaction_successful === false) continue;
      const txHash = op.transaction_hash;
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


/**
 * Settle a Stellar payment through the PRIMARY facilitator, and when it fails
 * WITHOUT the transfer landing on-chain, re-submit the SAME signed payload
 * through a FALLBACK facilitator (2026-08-26: our own facilitator's RPC
 * rejected a submission with `status=ERROR` and no result XDR; OpenZeppelin's
 * channel service was up the whole time).
 *
 * Why this cannot double-charge: the payload is one signed Stellar envelope,
 * so it can land at most once whichever facilitator submits it - a second
 * submission of a landed tx is refused by the network. And every failure is
 * checked against Horizon BEFORE the fallback is tried and again AFTER it, so a
 * primary submission that landed late is honoured, never re-broadcast. The
 * only unsafe direction is claiming a payment that did not occur, and every
 * path here returns the original failure unless a facilitator succeeded or the
 * chain shows the transfer.
 *
 * @param {object} p
 * @param {() => Promise<object>} p.primary          settle via the primary
 * @param {(() => Promise<object>)|null} p.fallback  settle via the fallback (null = none configured)
 * @param {(o:{payer:string|null}) => Promise<object|null>} p.confirm  Horizon check for a confirmed transfer
 * @param {(msg:string) => void} [p.log]
 * @returns {Promise<object>} an x402 settle result
 */
export async function settleWithStellarFallback({ primary, fallback = null, confirm, log = console.warn }) {
  const honour = (res, found, why) => {
    log(`[stellar] ${why} but ${found.transaction} is confirmed on-chain - honouring the settlement`);
    return { ...(res && typeof res === "object" ? res : {}), success: true, errorReason: undefined, errorMessage: undefined, transaction: found.transaction, ...(found.amount ? { amount: found.amount } : {}) };
  };
  let primaryRes = null, primaryErr = null;
  try { primaryRes = await primary(); } catch (e) { primaryErr = e; }
  if (primaryRes && primaryRes.success !== false) return primaryRes;
  const failure = primaryErr || primaryRes;
  const payer = settlePayerOf(failure);
  const txHash = settleTxOf(failure);
  // 1. Did the primary's submission land anyway? (the settle-late race) - by
  //    the exact hash when the facilitator named one, else by the payer scan.
  let found = await confirm({ payer, txHash });
  if (found) return honour(primaryRes, found, primaryErr ? `settle threw (${String(primaryErr?.message || primaryErr).slice(0, 120)})` : `facilitator said ${JSON.stringify(primaryRes?.errorReason || "failed")}`);
  // 2. Not on chain: same signed envelope through the fallback facilitator.
  if (typeof fallback === "function") {
    log(`[stellar] primary facilitator failed (${JSON.stringify(primaryRes?.errorReason || primaryErr?.message || "failed").slice(0, 120)}) and no transfer is on-chain - re-submitting the same payload via the fallback facilitator`);
    let fbRes = null, fbErr = null;
    try { fbRes = await fallback(); } catch (e) { fbErr = e; }
    if (fbRes && fbRes.success !== false) {
      log(`[stellar] fallback facilitator settled ${fbRes.transaction || "(no tx id)"} - primary failure was a facilitator fault, not a payment fault`);
      return { ...fbRes, viaFallback: true };
    }
    // 3. Both refused: the primary may still have landed late, or the fallback's.
    found = await confirm({ payer: settlePayerOf(fbErr || fbRes) || payer, txHash: settleTxOf(fbErr || fbRes) || txHash });
    if (found) return honour(primaryRes, found, "both facilitators reported failure");
    // errorReason alone hid what the fallback objected to (canary run
    // 32972751838: "unexpected_verify_error" and nothing else) - carry the
    // facilitator's own message, bounded.
    log(`[stellar] fallback facilitator also failed (${JSON.stringify(fbRes?.errorReason || fbErr?.message || "failed").slice(0, 120)}${fbRes?.errorMessage ? `: ${String(fbRes.errorMessage).slice(0, 300)}` : ""}${fbRes?.payer ? ` payer=${fbRes.payer}` : ""}) - returning the primary failure`);
  }
  if (primaryErr) throw primaryErr;
  return { ...primaryRes, ...(typeof fallback === "function" ? { fallbackTried: true } : {}) };
}
