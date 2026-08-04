// Did the money actually arrive? Ask the chain, not the facilitator.
//
// A refund row is created when the settle receipt says success:true. That
// receipt is unforgeable by a buyer - it is a response header written only by
// @x402/express - but "unforgeable" is not "true". A facilitator can be wrong,
// and we PROVED it can this week, in the opposite direction: on Stellar the
// channel service reported settle_channel_service_failed for transfers that
// then confirmed on-chain. The mirror of that bug - reporting success for a
// transfer that never landed, or that reverted - would have us refunding money
// we never received, out of our own wallet, with no attacker involved at all.
//
// So before any refund leaves, the payment it repays must be confirmed
// independently: the SAME payer, to OUR payTo, for AT LEAST the amount, in a
// transaction that actually succeeded. This module answers that and nothing
// else.
//
// FAIL CLOSED. Every failure - unreadable RPC, unknown chain, missing tx,
// amount short, wrong recipient - returns a `verified:false` with a reason,
// and the executor HOLDS the row. The debt stays on the books; nobody is paid
// on an unproven claim. That asymmetry is the whole point: withholding a real
// refund costs a delay and is visible in the ledger, while paying an unreal
// one costs money and is invisible.

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const fail = (reason) => ({ verified: false, reason });
const pass = (detail) => ({ verified: true, ...detail });

/** 32-byte topic -> 0x-prefixed lowercase address (EVM is case-insensitive,
 *  the one family where lowercasing is correct rather than destructive). */
function addrFromTopic(topic) {
  if (typeof topic !== "string" || topic.length < 42) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

async function rpc(url, method, params, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || "error"}`);
  return j.result;
}

/**
 * EVM: read the recorded transaction and prove it moved the token from the
 * payer to our payTo. Everything is taken from the transaction itself - we
 * never trust the ledger row's own claim about what happened.
 */
async function verifyEvm({ tx, payer, payTo, amountUsd, asset, rpcUrl, fetchImpl, timeoutMs }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(tx || ""))) return fail("no usable transaction hash recorded");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(payer || ""))) return fail("payer is not an EVM address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(payTo || ""))) return fail("payTo is not an EVM address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(asset || ""))) return fail("no token address for this network");

  let receipt, decimalsHex;
  try {
    receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [tx], fetchImpl, timeoutMs);
  } catch (e) { return fail(`could not read the transaction: ${e.message}`); }
  if (!receipt) return fail("transaction not found on chain");
  // status 0x0 is a REVERTED transaction: the facilitator may have broadcast
  // it and called that success, but no tokens moved.
  if (String(receipt.status) !== "0x1") return fail(`transaction did not succeed on chain (status ${receipt.status})`);

  try {
    // decimals() - never assumed. Assuming 6 and being wrong by a factor of a
    // million is the kind of mistake that only shows up in the loss column.
    decimalsHex = await rpc(rpcUrl, "eth_call", [{ to: asset, data: "0x313ce567" }, "latest"], fetchImpl, timeoutMs);
  } catch (e) { return fail(`could not read token decimals: ${e.message}`); }
  const decimals = Number(BigInt(decimalsHex || "0x0"));
  if (!Number.isFinite(decimals) || decimals > 36) return fail("token decimals unreadable");
  const expected = BigInt(Math.round(Number(amountUsd) * 10 ** decimals));
  if (expected <= 0n) return fail("expected amount is zero");

  const from = String(payer).toLowerCase();
  const to = String(payTo).toLowerCase();
  const token = String(asset).toLowerCase();
  let moved = 0n;
  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== token) continue;      // the right token only
    const topics = log.topics || [];
    if (String(topics[0] || "").toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (addrFromTopic(topics[1]) !== from) continue;                     // from the SAME payer
    if (addrFromTopic(topics[2]) !== to) continue;                       // to OUR wallet
    try { moved += BigInt(log.data); } catch { /* unparseable value - ignore this log */ }
  }
  if (moved === 0n) return fail("no transfer from this payer to our payTo in that transaction");
  // >= not ==: premium-priced chains quote MORE than list, and the debt is
  // recorded at list, so the buyer legitimately paid at least the expected sum.
  if (moved < expected) return fail(`transfer is short: moved ${moved} < expected ${expected} (atomic)`);
  return pass({ movedAtomic: moved.toString(), decimals, tx });
}

/**
 * Confirm the inbound payment a refund row claims. Returns
 * `{ verified:true, … }` or `{ verified:false, reason }` - never throws.
 *
 * `rpcFor(network)` supplies the RPC URL, `acceptsFor(network)` the live 402
 * accepts entry (asset + payTo) so the token and recipient come from our own
 * offer rather than a hand-maintained table.
 */
export async function verifyInboundPayment({
  network, payer, amountUsd, tx, createdAt,
  acceptsFor = () => null,
  rpcFor = () => null,
  stellarConfirm = null,       // injected: (opts) => Promise<{transaction}|null>
  fetchImpl = fetch,
  timeoutMs = 8_000,
} = {}) {
  try {
    const accepts = acceptsFor(network);
    const payTo = accepts?.payTo;
    if (!payTo) return fail(`no live payTo for ${network} - cannot prove where the money went`);
    const n = String(network || "");

    if (n.startsWith("eip155:")) {
      const rpcUrl = rpcFor(network);
      if (!rpcUrl) return fail(`no RPC configured for ${network}`);
      return await verifyEvm({ tx, payer, payTo, amountUsd, asset: accepts.asset, rpcUrl, fetchImpl, timeoutMs });
    }

    if (n.startsWith("stellar:")) {
      if (typeof stellarConfirm !== "function") return fail("no Stellar verifier available");
      // Reuses the same payer->payTo, same-transaction proof the late-settle
      // fix already relies on; the window opens just before the debt was
      // recorded so a late confirmation still counts.
      const found = await stellarConfirm({
        payer, payTo, sinceMs: Number(createdAt || 0) - 120_000, waitMs: 0,
      });
      return found ? pass({ tx: found.transaction, amount: found.amount }) : fail("no confirmed transfer from this payer to our payTo");
    }

    // Deliberately unimplemented rather than assumed. A family without a
    // verifier holds its rows: unverifiable is not the same as unpaid, and the
    // debt stays visible until someone can prove it.
    return fail(`no on-chain verifier for ${n.split(":")[0] || "unknown"} yet - debt held, not written off`);
  } catch (e) {
    return fail(`verification error: ${(e?.message || String(e)).slice(0, 120)}`);
  }
}
