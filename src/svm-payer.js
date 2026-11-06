// The BUYER behind a Solana x402 payment, read from the signed transaction.
//
// verify_failed's derived payer id fell back to the CREDENTIAL for SVM
// payloads ("SVM/Stellar payloads carry no readable payer"), and a credential
// is a signed transaction with a fresh memo nonce every time - so one wallet
// retrying is one id per attempt. Measured 2026-09-03/04: ~200 Solana verify
// failures an hour, every one `simulation failed ... Custom:1` (the token
// program's InsufficientFunds), and 197 distinct payer ids for 197 events. The
// question the id exists to answer - one empty wallet looping, or two hundred
// wallets hitting a fault of ours - could not be asked.
//
// The payload's `transaction` is the base64 wire transaction the buyer
// PARTIALLY signed (the facilitator's fee payer signs later). Its static
// account keys open with the required signers: the fee payer first, then the
// buyer whose token account the transfer debits (solana-buyer.js builds ours
// in exactly that order; @x402/svm's scheme client does the same). So the
// buyer is the first required signer that is not the accept's `extra.feePayer`.
//
// Dependency-free: a compact-u16 reader, a legacy/v0 message header walk and a
// base58 encoder for the comparison, no RPC, no @solana/kit. Pure, bounded,
// never throws: null whenever the bytes are not the shape described, because a
// wrong payer id is worse than none. svmSignedTransfer also checks the
// transfer authority's ed25519 signature with node:crypto.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { base64BytesOf } from "./base64-bytes.js";

// The largest wire transaction read, on its decoded bytes (src/base64-bytes.js),
// so characters the decoder skips cannot push one transaction past it.
const MAX_WIRE_BYTES = 3072;
function wireBytesOf(txBase64) {
  const bytes = base64BytesOf(txBase64);
  return bytes && bytes.length <= MAX_WIRE_BYTES ? bytes : null;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 of a byte array (Bitcoin alphabet, the Solana address form). */
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/** Solana's compact-u16 (shortvec): 1-3 bytes, 7 bits each, little-endian. */
function readCompactU16(bytes, at) {
  let value = 0, shift = 0, pos = at;
  for (let i = 0; i < 3; i++) {
    if (pos >= bytes.length) return null;
    const b = bytes[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  return null;
}

/**
 * The required signers of a wire transaction, as base58 addresses, in
 * account-key order (fee payer first). Null on any shape mismatch.
 * @param {string} txBase64
 */
export function svmRequiredSigners(txBase64) {
  try {
    const bytes = wireBytesOf(txBase64);
    if (!bytes) return null;
    const sigs = readCompactU16(bytes, 0);
    if (!sigs || sigs.value < 1 || sigs.value > 8) return null;
    let at = sigs.next + 64 * sigs.value; // skip the signatures
    if (at >= bytes.length) return null;
    // Versioned messages carry a version prefix byte with the high bit set;
    // a legacy message begins directly with the 3-byte header.
    if ((bytes[at] & 0x80) !== 0) {
      const version = bytes[at] & 0x7f;
      if (version !== 0) return null; // only v0 exists today
      at += 1;
    }
    if (at + 3 > bytes.length) return null;
    const numRequiredSignatures = bytes[at];
    at += 3;
    if (numRequiredSignatures < 1 || numRequiredSignatures !== sigs.value) return null;
    const keys = readCompactU16(bytes, at);
    if (!keys || keys.value < numRequiredSignatures || keys.value > 64) return null;
    at = keys.next;
    if (at + 32 * keys.value > bytes.length) return null;
    const out = [];
    for (let i = 0; i < numRequiredSignatures; i++) out.push(base58Encode(bytes.subarray(at + 32 * i, at + 32 * (i + 1))));
    return out;
  } catch { return null; }
}

// The SPL token programs (classic and Token-2022) and TransferChecked's tag.
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const IX_TRANSFER_CHECKED = 12;

// The transfer instruction of a wire transaction, with what checking its
// signature needs: the account-key indices, the amount (TransferChecked's u64
// after its tag), the signatures and the serialized message they sign (every
// byte after the signatures section, version prefix included). Null on any
// shape mismatch.
function readTransfer(txBase64, index) {
  const bytes = wireBytesOf(txBase64);
  if (!bytes) return null;
  const sigs = readCompactU16(bytes, 0);
  if (!sigs || sigs.value < 1 || sigs.value > 8) return null;
  const messageStart = sigs.next + 64 * sigs.value;
  let at = messageStart;
  if (at >= bytes.length) return null;
  if ((bytes[at] & 0x80) !== 0) {
    if ((bytes[at] & 0x7f) !== 0) return null;
    at += 1;
  }
  if (at + 3 > bytes.length) return null;
  const numRequiredSignatures = bytes[at];
  at += 3;
  const keys = readCompactU16(bytes, at);
  if (!keys || keys.value < 1 || keys.value > 64) return null;
  at = keys.next;
  if (at + 32 * keys.value > bytes.length) return null;
  const keysAt = at;
  const keyBytes = (i) => bytes.subarray(keysAt + 32 * i, keysAt + 32 * (i + 1));
  let p = at + 32 * keys.value + 32; // past the keys and the recent blockhash
  const count = readCompactU16(bytes, p);
  if (!count || count.value <= index || count.value > 16) return null;
  p = count.next;
  for (let i = 0; i < count.value; i++) {
    if (p >= bytes.length) return null;
    const program = bytes[p++];
    const accts = readCompactU16(bytes, p);
    if (!accts || accts.next + accts.value > bytes.length) return null;
    const accountIdx = [...bytes.subarray(accts.next, accts.next + accts.value)];
    p = accts.next + accts.value;
    const data = readCompactU16(bytes, p);
    if (!data || data.next + data.value > bytes.length) return null;
    const tag = data.value > 0 ? bytes[data.next] : -1;
    const dataAt = data.next, dataLen = data.value;
    p = data.next + data.value;
    if (i !== index) continue;
    if (program >= keys.value || !TOKEN_PROGRAMS.has(base58Encode(keyBytes(program)))) return null;
    if (tag !== IX_TRANSFER_CHECKED || accountIdx.length < 4 || accountIdx.slice(0, 4).some((k) => k >= keys.value)) return null;
    const amount = dataLen >= 9 ? bytes.readBigUInt64LE(dataAt + 1) : null;
    return { bytes, sigCount: sigs.value, sigsAt: sigs.next, messageStart, numRequiredSignatures, keyBytes, accountIdx: accountIdx.slice(0, 4), amount };
  }
  return null;
}

/**
 * The accounts of the token transfer in an exact-scheme Solana payment: the
 * instruction at `index` (2 in the scheme's fixed layout: compute limit,
 * compute price, TransferChecked), read from the static account keys. Null
 * unless that instruction is a TransferChecked of a token program whose four
 * accounts all sit in the static keys (an address-table account cannot be
 * read without an RPC, and a guess is worse than nothing). This reads what the
 * transaction NAMES; svmSignedTransfer reads what its authority signed.
 * @param {string} txBase64
 * @returns {{source:string, mint:string, destination:string, authority:string}|null}
 */
export function svmTransferAccounts(txBase64, { index = 2 } = {}) {
  try {
    const t = readTransfer(txBase64, index);
    if (!t) return null;
    const [source, mint, destination, authority] = t.accountIdx.map((k) => base58Encode(t.keyBytes(k)));
    return { source, mint, destination, authority };
  } catch { return null; }
}

// An ed25519 public key as SPKI DER: the fixed 12-byte prefix, then the 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * The token transfer of a Solana payment, only when its authority SIGNED it:
 * the authority is one of the message's required signers and its ed25519
 * signature over the serialized message verifies here, with no RPC. A
 * transaction that only names a wallet as authority (no signer slot, a zero
 * or wrong signature) reads as null. `amount` is the transfer's base units
 * (a BigInt). Pure, bounded, never throws.
 * @param {string} txBase64
 * @returns {{source:string, mint:string, destination:string, authority:string, amount:bigint}|null}
 */
export function svmSignedTransfer(txBase64, { index = 2 } = {}) {
  try {
    const t = readTransfer(txBase64, index);
    if (!t || t.amount == null) return null;
    if (t.numRequiredSignatures < 1 || t.numRequiredSignatures !== t.sigCount) return null;
    const authIdx = t.accountIdx[3];
    if (authIdx >= t.numRequiredSignatures) return null; // not a signer of this message
    const sig = t.bytes.subarray(t.sigsAt + 64 * authIdx, t.sigsAt + 64 * (authIdx + 1));
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, t.keyBytes(authIdx)]), format: "der", type: "spki" });
    if (!cryptoVerify(null, t.bytes.subarray(t.messageStart), key, sig)) return null;
    const [source, mint, destination, authority] = t.accountIdx.map((k) => base58Encode(t.keyBytes(k)));
    return { source, mint, destination, authority, amount: t.amount };
  } catch { return null; }
}

/**
 * The buyer's address for an SVM x402 payment: the first required signer that
 * is not the fee payer named by the accept (`requirements.extra.feePayer`).
 * When no fee payer is known, a two-signer transaction still resolves to its
 * second signer (the scheme's fixed layout); a single-signer one to that
 * signer. Null when the payload carries no readable transaction.
 * @param {object} paymentPayload the decoded x402 payload ({payload:{transaction}})
 * @param {{feePayer?: string}} [opts]
 */
export function svmPayerFromPayload(paymentPayload, { feePayer } = {}) {
  try {
    const tx = paymentPayload?.payload?.transaction ?? paymentPayload?.transaction;
    const signers = svmRequiredSigners(tx);
    if (!signers) return null;
    const fp = typeof feePayer === "string" && feePayer ? feePayer : null;
    if (fp) {
      const buyer = signers.find((s) => s !== fp);
      return buyer || null;
    }
    return signers.length >= 2 ? signers[1] : signers[0];
  } catch { return null; }
}
