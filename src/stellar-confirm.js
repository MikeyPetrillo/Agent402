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
// happen, which would hand out the tool for free. So, on the settle path
// (confirmStellarPayment):
//   * a transaction counts only if it carries THIS request's signed payment:
//     the same token transfer call and the payer's signed authorization entry,
//     where that call pays the advertised token contract, to our payTo, at
//     least the price
//   * the transaction must be `successful` on-chain
//   * each confirmed transaction is claimed once, so it confirms one request
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

// ---- The settle path: confirm THIS payment, and only this payment ----------
//
// A settle the chain confirms is matched to the payment it signed: asset,
// amount and transaction. The facilitator rebuilds the buyer's transaction
// around its own source account before submitting it, so the hash of the
// payload's envelope is not the hash that lands. What survives the rebuild
// byte for byte is the single invokeHostFunction operation: the token
// `transfer(from, to, amount)` call and the buyer's signed Soroban
// authorization entry (address credentials: nonce, expiration, signature).
// The network consumes that (address, nonce) once, so a confirmed transaction
// carrying this entry is this payment's own transaction and no other.
//
// So the payment is read from the request's own signed payload and checked
// against the requirements (the token contract we advertise, our payTo, at
// least the price in the asset's units), and an on-chain transaction counts
// only when it succeeded and its operation carries the same call and the same
// signed entry. Each confirmed transaction is then claimed (src/settlement-
// claims.js, shared across replicas), so one transaction confirms one request.
// Any doubt returns null and the original settle failure stands.

const STELLAR_DECIMALS = 7n;
const MAX_ENVELOPE_CHARS = 32_768;
const TX_HASH = /^[0-9a-f]{64}$/;

/** The one invokeHostFunction operation of an envelope, or null. A fee bump
 *  is unwrapped to its inner transaction. */
function soleInvokeOp(env) {
  const kind = env?.switch?.().name;
  let tx = null;
  if (kind === "envelopeTypeTx") tx = env.v1().tx();
  else if (kind === "envelopeTypeTxFeeBump") {
    const inner = env.feeBump().tx().innerTx();
    if (inner.switch().name !== "envelopeTypeTx") return null;
    tx = inner.v1().tx();
  } else return null;
  const ops = tx.operations();
  if (!Array.isArray(ops) || ops.length !== 1) return null;
  const body = ops[0].body();
  if (body.switch().name !== "invokeHostFunction") return null;
  return body.invokeHostFunctionOp();
}

/** `transfer(from, to, amount)` on a contract, or null. */
function transferCallOf(sdk, op) {
  const fn = op.hostFunction();
  if (fn.switch().name !== "hostFunctionTypeInvokeContract") return null;
  const call = fn.invokeContract();
  if (call.functionName().toString() !== "transfer") return null;
  const args = call.args();
  if (args.length !== 3) return null;
  const contract = sdk.Address.fromScAddress(call.contractAddress()).toString();
  const from = sdk.scValToNative(args[0]);
  const to = sdk.scValToNative(args[1]);
  const amount = sdk.scValToNative(args[2]);
  if (typeof from !== "string" || typeof to !== "string" || typeof amount !== "bigint") return null;
  return { contract, from, to, amount };
}

/**
 * What the request's own signed payload pays, checked against its
 * requirements, or null when it does not pay them exactly enough:
 *   { payer, payTo, asset, amount (bigint, asset units), hostFunction, auth[] }
 * `hostFunction` and `auth` are base64 XDR: the call and the payer's signed
 * address-credential entries, which an on-chain transaction must repeat.
 */
export async function stellarSignedPaymentOf(paymentPayload, paymentRequirements) {
  try {
    const envXdr = paymentPayload?.payload?.transaction;
    if (typeof envXdr !== "string" || !envXdr || envXdr.length > MAX_ENVELOPE_CHARS) return null;
    const asset = String(paymentRequirements?.asset || "");
    const payTo = String(paymentRequirements?.payTo || "");
    if (!/^C[A-Z2-7]{55}$/.test(asset) || !/^G[A-Z2-7]{55}$/.test(payTo)) return null;
    if (!/^[0-9]+$/.test(String(paymentRequirements?.amount ?? ""))) return null;
    const price = BigInt(String(paymentRequirements.amount));
    if (price <= 0n) return null;
    const sdk = await import("@stellar/stellar-sdk");
    const op = soleInvokeOp(sdk.xdr.TransactionEnvelope.fromXDR(envXdr, "base64"));
    if (!op) return null;
    const call = transferCallOf(sdk, op);
    if (!call || call.contract !== asset || call.to !== payTo || call.amount < price) return null;
    const auth = [];
    for (const entry of op.auth()) {
      const cred = entry.credentials();
      if (cred.switch().name !== "sorobanCredentialsAddress") continue;
      if (sdk.Address.fromScAddress(cred.address().address()).toString() !== call.from) continue;
      auth.push(entry.toXDR("base64"));
    }
    if (!auth.length) return null;
    return { payer: call.from, payTo, asset, amount: call.amount, hostFunction: op.hostFunction().toXDR("base64"), auth };
  } catch {
    return null;
  }
}

/**
 * The payer's signed authorization entries in a Stellar payload, as the
 * network consumes them: [{ signer, nonce }] for each address-credential entry
 * of the sole transfer call signed by its `from` (nonce as a decimal string,
 * signer as spelled on chain), or null. A re-encoded copy of the same signed
 * entry yields the same list, so it names the payment whatever the envelope
 * around it (src/settlement-claims.js claims each one; src/replay-guard.js
 * keys the replay on them).
 */
export async function stellarAuthorizationsOf(paymentPayload) {
  try {
    const envXdr = paymentPayload?.payload?.transaction;
    if (typeof envXdr !== "string" || !envXdr || envXdr.length > MAX_ENVELOPE_CHARS) return null;
    const sdk = await import("@stellar/stellar-sdk");
    const op = soleInvokeOp(sdk.xdr.TransactionEnvelope.fromXDR(envXdr, "base64"));
    if (!op) return null;
    const call = transferCallOf(sdk, op);
    if (!call) return null;
    const out = [];
    const seen = new Set();
    for (const entry of op.auth()) {
      const cred = entry.credentials();
      if (cred.switch().name !== "sorobanCredentialsAddress") continue;
      const a = cred.address();
      const signer = sdk.Address.fromScAddress(a.address()).toString();
      if (signer !== call.from) continue;
      const nonce = a.nonce().toString();
      if (!/^-?[0-9]{1,20}$/.test(nonce) || seen.has(nonce)) continue;
      seen.add(nonce);
      out.push({ signer, nonce });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Asset units as Horizon spells them ("0.0010000"). */
function unitsToDecimal(n) {
  const scale = 10n ** STELLAR_DECIMALS;
  return `${n / scale}.${(n % scale).toString().padStart(Number(STELLAR_DECIMALS), "0")}`;
}

/** Does this on-chain transaction carry the signed payment? true (it does),
 *  false (it is on-chain and does not), null (not readable yet). */
async function txCarriesPayment({ hash, signed, base, fetchImpl, timeoutMs }) {
  const tx = await getJson(`${base}/transactions/${encodeURIComponent(hash)}`, fetchImpl, timeoutMs);
  if (!tx) return null;
  if (typeof tx.hash === "string" && tx.hash.toLowerCase() !== hash) return false;
  if (tx.successful !== true) return false;
  if (typeof tx.envelope_xdr !== "string" || !tx.envelope_xdr || tx.envelope_xdr.length > MAX_ENVELOPE_CHARS * 2) return false;
  try {
    const sdk = await import("@stellar/stellar-sdk");
    const op = soleInvokeOp(sdk.xdr.TransactionEnvelope.fromXDR(tx.envelope_xdr, "base64"));
    if (!op) return false;
    if (op.hostFunction().toXDR("base64") !== signed.hostFunction) return false;
    const onChain = new Set(op.auth().map((e) => e.toXDR("base64")));
    return signed.auth.every((a) => onChain.has(a));
  } catch {
    return false;
  }
}

/** Candidate transactions from the payer's recent debits (a lookup only:
 *  every candidate must still carry the signed payment). */
async function payerCandidates({ payer, sinceMs, base, fetchImpl, timeoutMs }) {
  const eff = await getJson(`${base}/accounts/${encodeURIComponent(payer)}/effects?order=desc&limit=25`, fetchImpl, timeoutMs);
  const out = [];
  for (const d of eff?._embedded?.records || []) {
    if (d?.type !== "account_debited" || d?.asset_type === "native") continue;
    const t = Date.parse(d?.created_at || "");
    if (!Number.isFinite(t) || t < sinceMs) continue;
    const opHref = d?._links?.operation?.href;
    const opId = String(d?.id || "").split("-")[0];
    const opUrl = (typeof opHref === "string" && opHref) || (/^\d+$/.test(opId) ? `${base}/operations/${encodeURIComponent(opId)}` : null);
    if (!opUrl) continue;
    const op = await getJson(opUrl, fetchImpl, timeoutMs);
    const h = typeof op?.transaction_hash === "string" ? op.transaction_hash.toLowerCase() : "";
    if (op && op.transaction_successful !== false && TX_HASH.test(h)) out.push(h);
  }
  return out;
}

/**
 * Confirm the signed payment on-chain after a failed settle. `signed` is
 * stellarSignedPaymentOf(...) for this request; `txHash` a hash a facilitator
 * named; `claimTx(hash)` resolves true only when this request now owns that
 * transaction. Returns { transaction, amount } or null.
 */
export async function confirmStellarPayment({
  signed,
  txHash = null,
  sinceMs,
  claimTx,
  horizon = process.env.STELLAR_HORIZON_URL || DEFAULT_HORIZON,
  waitMs = 8_000,
  stepMs = 1_500,
  timeoutMs = 4_000,
  fetchImpl = fetch,
} = {}) {
  if (!signed || typeof signed.hostFunction !== "string" || !Array.isArray(signed.auth) || !signed.auth.length) return null;
  if (typeof claimTx !== "function") return null;
  const base = String(horizon).replace(/\/+$/, "");
  const named = typeof txHash === "string" && TX_HASH.test(txHash.toLowerCase()) ? txHash.toLowerCase() : null;
  const scan = typeof signed.payer === "string" && signed.payer && Number.isFinite(sinceMs);
  if (!named && !scan) return null;
  const settledNo = new Set();   // on-chain and not this payment: never re-read
  const deadline = Date.now() + waitMs;
  for (;;) {
    const candidates = named ? [named] : [];
    if (scan) {
      for (const h of await payerCandidates({ payer: signed.payer, sinceMs, base, fetchImpl, timeoutMs })) {
        if (!candidates.includes(h)) candidates.push(h);
      }
    }
    for (const hash of candidates) {
      if (settledNo.has(hash)) continue;
      const verdict = await txCarriesPayment({ hash, signed, base, fetchImpl, timeoutMs });
      if (verdict === false) { settledNo.add(hash); continue; }
      if (verdict !== true) continue;
      let owned = false;
      try { owned = (await claimTx(hash)) === true; } catch { owned = false; }
      return owned ? { transaction: hash, amount: unitsToDecimal(signed.amount) } : null;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---- The refund verifier's lookup (src/payment-verify.js) ------------------
// Not used on the settle path. The refund verifier binds what this returns to
// the transaction and amount its debt recorded.
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
 * @param {(o:{payer:string|null, txHash:string|null}) => Promise<object|null>} p.confirm  Horizon check that this payment landed
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
  // 1. Did the primary's submission land anyway? (the settle-late race) - the
  //    confirmer accepts only a transaction carrying this request's signed
  //    payment; a hash the facilitator named is a candidate, not proof.
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
