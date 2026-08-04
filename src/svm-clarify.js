// Say "insufficient funds" when that is what happened, instead of the
// facilitator's timeout.
//
// 2026-08-03: our best Solana customer (an autonomous agent) spent its wallet
// to $0.00 mid-basket. Its last four purchases failed on-chain with
// "Error: insufficient funds" (SPL Token, custom error 0x1) - and PayAI
// reported every one as `settle_exact_svm_transaction_confirmation_timed_out`.
// That string reads as OUR outage: it sent the operator asking "is Solana
// down?" and us decoding transactions before either side knew the wallet was
// simply empty. An agent's logs saying "confirmation timed out" tell its
// operator to wait; "insufficient funds, top up" tells them exactly what to
// do. The buyer's 402 receipt and our own settle_failed telemetry both carry
// this reason, so one honest string fixes both sides' diagnosis.
//
// This module measures instead of relabelling: on an AMBIGUOUS settle failure
// on Solana it reads the payer's USDC balance from the chain, and only when
// the balance is genuinely below the price does it rewrite the reason.
//
// SAFETY RULES, in the same spirit as stellar-confirm.js:
//   * only AMBIGUOUS reasons (timeouts, confirmation failures) are eligible.
//     A specific reason - invalid_signature, expired, wallet_blocked - is
//     never overwritten: an empty wallet does not make "bad signature" wrong,
//     and mislabelling a specific failure is worse than leaving a vague one.
//   * "insufficient funds" is only claimed when MEASURED: balance readable
//     AND below the required amount. Any RPC error, timeout, or unparseable
//     response returns null and the original reason stands.
//   * read-only - one balance read on the failure path, nothing broadcast,
//     nothing retried. The happy path never gets here.

const SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];

// Reasons vague enough that a balance check adds information. Everything else
// is specific, and specific beats measured-but-unrelated.
const AMBIGUOUS = /(timed?[_ ]?out|confirmation|broadcast_failed|unknown_error)/i;

/** Sum the payer's balance of `mint` across their token accounts, in atomic
 *  units (bigint), or null when it cannot be read. */
async function atomicBalanceOf(payer, mint, { rpcs, fetchImpl, timeoutMs }) {
  for (const rpc of rpcs) {
    try {
      const res = await fetchImpl(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
          params: [payer, { mint }, { encoding: "jsonParsed" }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const value = (await res.json())?.result?.value;
      if (!Array.isArray(value)) continue;
      let total = 0n;
      for (const acct of value) {
        const amt = acct?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (typeof amt === "string" && /^\d+$/.test(amt)) total += BigInt(amt);
      }
      return total;                      // 0n is a real answer: no accounts = no funds
    } catch { /* try the next RPC; never let a flake decide */ }
  }
  return null;
}

/**
 * Given a failed Solana settle, return `{ reason, message }` when the payer's
 * measured balance is below the price - otherwise null, meaning "keep the
 * facilitator's reason".
 *
 * `requirements` is the x402 PaymentRequirements the settle ran against:
 * `amount` (atomic units, USDC = 6 decimals) and `asset` (the mint) come from
 * it, so the check is against the exact token and price of THIS purchase.
 */
export async function clarifySvmSettleFailure({
  network,
  reason,
  payer,
  requirements,
  rpcs = SOLANA_RPCS,
  fetchImpl = fetch,
  timeoutMs = 4_000,
} = {}) {
  if (!String(network || "").startsWith("solana:")) return null;
  if (!payer || typeof payer !== "string") return null;
  if (!AMBIGUOUS.test(String(reason || ""))) return null;

  const mint = requirements?.asset;
  const amountRaw = String(requirements?.amount ?? "");
  if (!mint || !/^\d+$/.test(amountRaw)) return null;   // no price to compare = no claim
  const amount = BigInt(amountRaw);

  const balance = await atomicBalanceOf(payer, mint, { rpcs, fetchImpl, timeoutMs });
  if (balance === null || balance >= amount) return null;

  const fmt = (a) => (Number(a) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return {
    reason: "insufficient_funds",
    message:
      `payer holds ${fmt(balance)} USDC on Solana but this call costs ${fmt(amount)} - ` +
      `top up the wallet and retry (facilitator reported: ${reason})`,
  };
}
