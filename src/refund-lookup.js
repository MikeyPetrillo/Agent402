// Refund lookup: "did Agent402 refund this payment?", answerable by anyone who
// holds the settlement transaction.
//
// Why it exists (2026-09-29): a Base refund is a USDC transfer from one of our
// sending wallets, and a wallet app shows it with no memo, so a buyer who
// receives one cannot tell it came from us or which payment it repays.
// (Stellar and Algorand refunds carry an "agent402 refund" memo; since
// 2026-09-30 an EVM refund carries "agent402 refund for <settlement tx>" as a
// UTF-8 suffix on its input data, readable on an explorer, not in wallets.)
//
// What it may say. The caller presents a transaction hash, which is already
// public on chain, and learns only facts about THAT payment that the chain
// shows or that repay it: the refund status, the amount, the network it
// settled on, and our refund transaction (itself public) once sent. Never the
// payer address, never the tool bought, never the ledger's notes, never
// another row. Exact match only: the input must look like one transaction
// hash, so there is no prefix search and nothing to enumerate, and an unknown
// transaction answers in exactly the same shape as a known one with no refund
// ("none"), so the answer does not say whether we ever saw that payment.
import { refundByEvidence } from "./refund-ledger.js";

const CAIP_TO_CHAIN = {
  "eip155:8453": "base", "eip155:137": "polygon", "eip155:42161": "arbitrum", "eip155:10": "optimism",
  "eip155:43114": "avalanche", "eip155:42220": "celo", "eip155:143": "monad", "eip155:1329": "sei",
  "eip155:4663": "robinhood", "eip155:4217": "tempo",
};
const EXPLORER = {
  base: (h) => `https://basescan.org/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  optimism: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  avalanche: (h) => `https://snowtrace.io/tx/${h}`,
  celo: (h) => `https://celoscan.io/tx/${h}`,
  monad: (h) => `https://monadscan.com/tx/${h}`,
  sei: (h) => `https://seiscan.io/tx/${h}`,
  robinhood: (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
  tempo: (h) => `https://explore.tempo.xyz/tx/${h}`,
  solana: (h) => `https://solscan.io/tx/${h}`,
  stellar: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
  algorand: (h) => `https://allo.info/tx/${h}`,
};

/** The friendly chain name for a network as the ledger recorded it (CAIP-2 or
 *  a rail name). null when unrecognised. */
export function chainOf(network) {
  const n = String(network || "").trim();
  if (!n) return null;
  const lower = n.toLowerCase();
  if (CAIP_TO_CHAIN[lower]) return CAIP_TO_CHAIN[lower];
  if (lower.startsWith("solana:")) return "solana";
  if (lower.startsWith("stellar:")) return "stellar";
  if (lower.startsWith("algorand:")) return "algorand";
  return EXPLORER[lower] ? lower : null;
}

export function explorerTxUrl(network, tx) {
  const c = chainOf(network);
  return c && tx ? EXPLORER[c](tx) : null;
}

// One transaction hash, nothing else: 0x + 64 hex (EVM, Tempo), 64 hex
// (Stellar), base58 of a Solana signature, base32 of an Algorand txid.
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;
const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const BASE32_TXID = /^[A-Z2-7]{52}$/;

/** The candidate ledger keys for one presented hash, or null when the input
 *  is not shaped like exactly one transaction hash. Hex is case-insensitive
 *  by definition, so a hex hash is tried as given and lowercased; base58 and
 *  base32 are exact. */
export function lookupKeys(input) {
  const t = typeof input === "string" ? input.trim() : "";
  if (!t || t.length > 100) return null;
  if (HEX64.test(t)) return [...new Set([t, t.toLowerCase()])];
  if (BASE58_SIG.test(t) || BASE32_TXID.test(t)) return [t];
  return null;
}

const NOTES = {
  none: "No refund is recorded for this transaction. A payment is refunded only when it settled and the call failed to deliver; a call that returned an error before settlement was never charged.",
  owed: "A refund is recorded and owed. It is sent to the paying wallet on the same network after the payment is re-verified on chain.",
  sending: "The refund is being sent now.",
  paid: "Refunded. refundTx is our transfer back to the paying wallet on the same network.",
  void: "This payment was reviewed and no refund is due (for example, the call was delivered after all).",
};

/** The public answer for one row (or null = none). Same key set always. */
export function publicRefundView(tx, row) {
  const status = row && NOTES[row.status] ? row.status : "none";
  const has = status !== "none";
  const refundTx = has && status === "paid" && row.paidTx ? String(row.paidTx) : null;
  return {
    tx,
    status,
    amountUsd: has ? Number(Number(row.priceUsd || 0).toFixed(6)) : null,
    network: has ? (row.network || null) : null,
    chain: has ? chainOf(row.network) : null,
    refundTx,
    refundTxUrl: refundTx ? explorerTxUrl(row.network, refundTx) : null,
    refundedAt: refundTx && row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
    note: NOTES[status],
  };
}

/** Look one presented transaction up. Throws a 400 for input that is not one
 *  transaction hash; otherwise always answers the same shape. */
export function refundLookup(input, { byEvidence = refundByEvidence } = {}) {
  const keys = lookupKeys(input);
  if (!keys) {
    const e = new Error("\"tx\" must be one settlement transaction hash (0x-prefixed hex on EVM chains, a signature on Solana, a transaction id on Stellar or Algorand).");
    e.statusCode = 400;
    throw e;
  }
  let row = null;
  for (const k of keys) { row = byEvidence(k); if (row) break; }
  return publicRefundView(keys[0], row);
}

/** A caller's own refunds, for identity-bound surfaces (my-usage, digest).
 *  The settlement tx is included here: the caller proved the wallet. */
export function ownRefundsView(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({
    ...publicRefundView(String(r.evidence || ""), r),
    recordedAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
  })).map(({ note, ...rest }) => rest);
  // A row keyed on the payer|slug|minute fallback has no settlement tx to show.
  for (const r of list) if (!lookupKeys(r.tx)) r.tx = null;
  const sum = (s) => Number(list.filter((r) => r.status === s).reduce((a, r) => a + (r.amountUsd || 0), 0).toFixed(6));
  return { count: list.length, owedUsd: Number((sum("owed") + sum("sending")).toFixed(6)), paidUsd: sum("paid"), rows: list };
}
