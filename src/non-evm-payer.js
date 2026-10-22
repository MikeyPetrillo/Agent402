// The signer behind a non-EVM x402 payment (Solana, Algorand, Stellar), read
// from the signed transaction or payload itself.
//
// payerFromRequest (src/payer.js) is EVM only, because only EIP-3009 carries a
// signed `authorization.from`. A spend ceiling still needs a stable key for the
// other rails, and each of them names its signer inside what was signed:
//   - Solana: the first required signer that is not the accept's fee payer
//     (src/svm-payer.js);
//   - Algorand: the sender of the payment transaction at `paymentIndex` in the
//     signed group;
//   - Stellar: the `from` argument of the token `transfer` the transaction
//     invokes, whose authorization entry the payer must sign.
// A tool handler runs only after the facilitator verified the payment, so at
// that point these are the addresses that signed. The result is prefixed by
// rail (`svm:`, `avm:`, `stellar:`) and never case-folded: base58, Algorand
// base32 and Stellar strkeys are case-sensitive. Null on any shape mismatch;
// the caller falls back to its next key.
import { paymentHeaderOf } from "./payer.js";
import { svmPayerFromPayload } from "./svm-payer.js";

function decodePayload(req) {
  const header = paymentHeaderOf(req);
  if (!header || header.length > 65536) return null;
  try { return JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { return null; }
}

/** The network a decoded payload pays on (v2 `accepted.network`, v1 `network`). */
function networkOf(payload) {
  return String(payload?.accepted?.network || payload?.network || "");
}

/** Algorand: the sender of the signed payment transaction, or null. */
async function avmSender(payload) {
  try {
    const group = payload?.payload?.paymentGroup;
    if (!Array.isArray(group) || group.length === 0 || group.length > 16) return null;
    const idx = Number.isInteger(payload?.payload?.paymentIndex) ? payload.payload.paymentIndex : 0;
    const raw = group[idx];
    if (typeof raw !== "string" || !raw) return null;
    const { default: algosdk } = await import("algosdk");
    // Only a SIGNED transaction names its signer; a sponsored fee txn is unsigned.
    const stx = algosdk.decodeSignedTransaction(new Uint8Array(Buffer.from(raw, "base64")));
    if (!stx?.sig && !stx?.msig && !stx?.lsig) return null;
    const s = stx.txn?.sender;
    const addr = s == null ? null : (typeof s === "string" ? s : s.toString());
    return typeof addr === "string" && /^[A-Z2-7]{58}$/.test(addr) ? addr : null;
  } catch { return null; }
}

/** Stellar: the `from` of the single invoked token transfer, or null. */
async function stellarFrom(payload) {
  try {
    const xdr = payload?.payload?.transaction;
    if (typeof xdr !== "string" || !xdr || xdr.length > 32768) return null;
    const sdk = await import("@stellar/stellar-sdk");
    let tx = sdk.TransactionBuilder.fromXDR(xdr, sdk.Networks.PUBLIC);
    if (tx?.innerTransaction) tx = tx.innerTransaction;
    if (!tx?.operations || tx.operations.length !== 1) return null;
    const op = tx.operations[0];
    if (op.type !== "invokeHostFunction" || op.func?.switch?.().name !== "hostFunctionTypeInvokeContract") return null;
    const call = op.func.invokeContract();
    if (call.functionName().toString() !== "transfer") return null;
    const args = call.args();
    if (args.length !== 3) return null;
    const from = sdk.scValToNative(args[0]);
    return typeof from === "string" && /^[GC][A-Z2-7]{55}$/.test(from) ? from : null;
  } catch { return null; }
}

/**
 * A rail-prefixed signer key for a verified non-EVM x402 payment on this
 * request, or null (EVM, no payment, unreadable shape).
 * @returns {Promise<string|null>}
 */
export async function nonEvmPayerFromRequest(req) {
  const payload = decodePayload(req);
  if (!payload || typeof payload !== "object") return null;
  const network = networkOf(payload);
  if (/^solana:/.test(network)) {
    const feePayer = payload?.accepted?.extra?.feePayer;
    const svm = svmPayerFromPayload(payload, { feePayer: typeof feePayer === "string" ? feePayer : undefined });
    return svm ? `svm:${svm}` : null;
  }
  if (/^algorand:/.test(network)) {
    const a = await avmSender(payload);
    return a ? `avm:${a}` : null;
  }
  if (/^stellar:/.test(network)) {
    const s = await stellarFrom(payload);
    return s ? `stellar:${s}` : null;
  }
  return null;
}
