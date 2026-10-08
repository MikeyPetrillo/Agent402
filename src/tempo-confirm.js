// Tempo settlement confirmation — the stellar-confirm doctrine on the MPP
// rail: VERIFICATION, NEVER A RE-BROADCAST. Built 2026-08-20 after a live
// incident: the Tempo relay's /v1/mpp/broadcast reported
// `invalid_payment: "Broadcast transaction hash does not match the signed
// transaction"` for TWO payments that had both SETTLED on-chain
// (0xbb2e11e3… and 0x753f5655…, AgentCore/Privy buyer) — the buyer was told
// 402, retried, and was charged twice. Mechanism: the buyer's packed
// signature ends with a yParity-style v byte (0x00/0x01); the node accepts
// the transaction and stores the canonical 27/28 form, so the canonical
// txid no longer equals keccak(submitted bytes) and the relay's
// post-broadcast hash comparison fails a payment that landed.
//
// The fix exploits the same fact that makes the failure confusing: a txid
// commits to the ENTIRE signed transaction, so the credential's own bytes
// determine exactly which transaction could have landed — the submitted
// form and its v-normalized twin. Look those two receipts up on the chain;
// if one exists, succeeded, and carries the challenge's transfer
// (currency, recipient, >= amount), the payment settled and the buyer must
// be served, whatever the relay said. There is no time-window heuristic and
// no payer matching, so one buyer's genuine payment can never vouch for a
// DIFFERENT purchase (the Stellar deep-review lesson) — the binding is the
// transaction hash itself. Fails closed on every uncertainty: an RPC error,
// a missing receipt, a reverted transaction, a transfer that does not match
// the challenge — all return null and the original relay failure stands
// (buyer answered 402, exactly as before this module existed).
//
// BOUND TO THIS CHALLENGE (2026-09-24). The hash binding says which
// transaction the credential carries; the memo says which purchase it was
// made for. Every mppx charge memo carries a nonce derived from its challenge
// id (tempo/Attribution.js: TAG, version, server and client fingerprints,
// keccak256(challengeId)[0..6]), so the transfer must be a TransferWithMemo
// to our recipient whose memo is bound to the challenge this credential
// presents. A transaction matches at most one challenge.
import { Credential } from "mppx";
import { keccak256, fromRlp, toBytes } from "viem";

// TIP-20 TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)
export const TRANSFER_WITH_MEMO_TOPIC = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));
const MPP_TAG = keccak256(toBytes("mpp")).slice(2, 10);

/** Is this bytes32 memo an MPP attribution memo bound to `challengeId`?
 *  Mirrors mppx tempo/Attribution.js verifyChallengeBinding: TAG (4 bytes),
 *  version 0x01, and bytes 25..31 = keccak256(challengeId)[0..6]. */
export function memoBoundToChallenge(memo, challengeId) {
  const hex = String(memo || "").toLowerCase().replace(/^0x/, "");
  if (hex.length !== 64 || typeof challengeId !== "string" || !challengeId) return false;
  if (hex.slice(0, 8) !== MPP_TAG || hex.slice(8, 10) !== "01") return false;
  const nonce = keccak256(toBytes(challengeId)).slice(2, 16);
  return hex.slice(50, 64) === nonce;
}

/** The txids this signed transaction could have landed under: the submitted
 *  bytes, and (when the trailing byte is a recognisable v) the v-swapped
 *  twin — yParity (0/1) <-> legacy (27/28). Tempo's type-0x76 envelope ends
 *  with the 65-byte packed signature as its LAST RLP field, so the final
 *  byte of the whole envelope IS v; that is verified against the decoded
 *  RLP before any swap (a tx whose last field is not the packed signature
 *  gets only the identity candidate — never a blind byte edit). */
export function candidateTxIds(signedTx) {
  const out = [];
  const hex = String(signedTx || "").toLowerCase();
  if (!/^0x76[0-9a-f]{2,}$/.test(hex) || hex.length % 2 !== 0) return out;
  out.push(keccak256(hex));
  let fields;
  try { fields = fromRlp(`0x${hex.slice(4)}`, "hex"); } catch { return out; }
  const last = fields[fields.length - 1];
  const sigIsLast = typeof last === "string" && last.length === 2 + 65 * 2 && hex.endsWith(last.slice(2));
  if (!sigIsLast) return out;
  const swap = { "00": "1b", "01": "1c", "1b": "00", "1c": "01" }[hex.slice(-2)];
  if (swap) out.push(keccak256(hex.slice(0, -2) + swap));
  return out;
}

async function rpcCall(fetchImpl, rpcUrl, method, params, timeoutMs = 0) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`rpc ${method}: ${String(body.error.message || body.error.code)}`);
  return body.result;
}

/** Did this credential's transaction settle on-chain despite what the relay
 *  said? Returns { txId, amountAtomic } when a candidate receipt exists,
 *  succeeded, and pays the challenge's recipient at least the challenge's
 *  amount in the challenge's currency — else null. Polls briefly (the
 *  transaction may still be sitting in a block the RPC has not indexed when
 *  the relay answers). Never throws. */
export async function confirmTempoSettlement(authorizationHeader, {
  rpcUrl = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz",
  fetchImpl = fetch,
  attempts = 4,
  delayMs = 2000,
  // The early watcher (createTempoGate's earlyConfirm) waits before its first
  // read, bounds each read, and stops as soon as the relay has answered.
  initialDelayMs = 0,
  rpcTimeoutMs = 0,
  stop = null,
  // Answer only once the payment's block is FINALIZED. Tempo's consensus is
  // deterministic (a finalized block cannot be reverted) and its docs say to
  // treat finalized blocks as settled; a receipt can be visible a block
  // earlier. The early watcher sets this; the post-failure check keeps its
  // original behavior.
  requireFinalized = false,
  // Optional: filled with what the reads saw, for the settle log line.
  trace = null,
} = {}) {
  try {
    const credential = Credential.deserialize(authorizationHeader);
    const ch = credential?.challenge;
    const payload = credential?.payload;
    if (!ch || ch.method !== "tempo" || payload?.type !== "transaction") return null;
    const r = ch.request || {};
    const currency = String(r.currency || "").toLowerCase();
    const recipient = String(r.recipient || "").toLowerCase();
    let minAmount;
    try { minAmount = BigInt(String(r.amount)); } catch { return null; }
    if (!currency.startsWith("0x") || !recipient.startsWith("0x") || !(minAmount > 0n)) return null;
    const candidates = candidateTxIds(payload.signature);
    if (!candidates.length) return null;

    for (let i = 0; i < attempts; i++) {
      const wait = i > 0 ? delayMs : initialDelayMs;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (stop?.()) return null;
      for (const txId of candidates) {
        let receipt;
        if (trace) trace.reads = (trace.reads || 0) + 1;
        try { receipt = await rpcCall(fetchImpl, rpcUrl, "eth_getTransactionReceipt", [txId], rpcTimeoutMs); }
        catch (e) { if (trace && !trace.error) trace.error = String(e?.name === "TimeoutError" ? "timeout" : e?.message || e).slice(0, 60); continue; }
        if (trace && receipt && trace.seenAt == null) trace.seenAt = Date.now();
        if (!receipt || receipt.status !== "0x1") continue;
        for (const log of receipt.logs || []) {
          if (String(log.address || "").toLowerCase() !== currency) continue;
          if ((log.topics || [])[0] !== TRANSFER_WITH_MEMO_TOPIC) continue;
          const to = `0x${String(log.topics[2] || "").slice(-40)}`.toLowerCase();
          if (to !== recipient) continue;
          if (!memoBoundToChallenge(log.topics[3], ch.id)) continue;
          let value;
          try { value = BigInt(log.data); } catch { continue; }
          if (value < minAmount) continue;
          if (requireFinalized) {
            let fin;
            try { fin = await rpcCall(fetchImpl, rpcUrl, "eth_getBlockByNumber", ["finalized", false], rpcTimeoutMs); }
            catch (e) { if (trace && !trace.error) trace.error = String(e?.message || e).slice(0, 60); continue; }
            const finalized = Number.parseInt(String(fin?.number || ""), 16), included = Number.parseInt(String(receipt.blockNumber || ""), 16);
            if (trace) trace.finalizedLag = Number.isFinite(finalized) && Number.isFinite(included) ? included - finalized : null;
            if (!Number.isFinite(finalized) || !Number.isFinite(included) || included > finalized) continue;
          }
          return { txId, amountAtomic: value };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The account that sent a PUSH credential's transfer, read from the chain:
 *  the `from` of the TransferWithMemo log in the named transaction that pays
 *  the challenge's recipient at least the challenge's amount in the
 *  challenge's currency, with a memo bound to this challenge (the same match
 *  confirmTempoSettlement makes). A push credential carries no signature this
 *  server can recover, and its `source` field is whatever the client wrote,
 *  so this is the only sender of a push payment we can vouch for: the sales
 *  ledger and a refund-owed row name it, or name nobody. One read, bounded by
 *  `timeoutMs`. Returns the lowercased address, or null on any uncertainty.
 *  Never throws. */
export async function tempoPushSender(authorizationHeader, {
  rpcUrl = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz",
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  try {
    const credential = Credential.deserialize(authorizationHeader);
    const ch = credential?.challenge;
    const payload = credential?.payload;
    if (!ch || ch.method !== "tempo" || payload?.type !== "hash") return null;
    const hash = String(payload.hash || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return null;
    const r = ch.request || {};
    const currency = String(r.currency || "").toLowerCase();
    const recipient = String(r.recipient || "").toLowerCase();
    let minAmount;
    try { minAmount = BigInt(String(r.amount)); } catch { return null; }
    if (!currency.startsWith("0x") || !recipient.startsWith("0x") || !(minAmount > 0n)) return null;
    const bounded = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const receipt = await rpcCall(bounded, rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (!receipt || receipt.status !== "0x1") return null;
    for (const log of receipt.logs || []) {
      if (String(log.address || "").toLowerCase() !== currency) continue;
      const topics = log.topics || [];
      if (topics[0] !== TRANSFER_WITH_MEMO_TOPIC) continue;
      if (`0x${String(topics[2] || "").slice(-40)}`.toLowerCase() !== recipient) continue;
      if (!memoBoundToChallenge(topics[3], ch.id)) continue;
      let value;
      try { value = BigInt(log.data); } catch { continue; }
      if (value < minAmount) continue;
      const from = `0x${String(topics[1] || "").slice(-40)}`.toLowerCase();
      return /^0x[0-9a-f]{40}$/.test(from) && from !== "0x0000000000000000000000000000000000000000" ? from : null;
    }
    return null;
  } catch {
    return null;
  }
}
