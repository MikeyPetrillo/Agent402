// A settle the facilitator calls failed although its own transfer landed.
//
// A facilitator can broadcast an EIP-3009 transferWithAuthorization and then
// answer the same /settle with "authorization nonce already submitted;
// transaction already on-chain" (its own retry found its own transaction).
// The buyer has paid, and without this the middleware answers 402.
//
// The words are not proof. The authorization's nonce can be spent by ANY
// authorization the payer signed with that nonce, including one paying
// someone else, so a used nonce alone proves nothing. Proof is the
// AuthorizationUsed(payer, nonce) log on the asset contract, whose
// transaction succeeded and moved at least the required amount of that asset
// from the payer to our payTo. Only then is the settlement recovered with that
// transaction. Without proof (not found in the bound, RPC down, a transfer to
// someone else, short, reverted) the failure stands exactly as before. This
// never settles again: it only reads the chain.

import { rpc, evmTransferredInReceipt } from "./payment-verify.js";
import { evmRpcFor } from "./evm-rpcs.js";

export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

// How far back the log search reaches. A settle failure arrives seconds after
// the broadcast; 1,000 blocks is minutes on the fastest chain we serve and
// stays inside public RPCs' getLogs range limits.
const LOG_WINDOW_BLOCKS = 1000;

const ALREADY_ON_CHAIN = [
  /\bnonce already (submitted|used)\b/i,
  /\btransaction already on-?chain\b/i,
];

/** True when a settle failure says the authorization already reached the chain. */
export function isAlreadyOnChainSettleError(err) {
  if (!err) return false;
  const text = [err.errorReason, err.errorMessage, err.message].filter((s) => typeof s === "string").join(" ");
  return ALREADY_ON_CHAIN.some((re) => re.test(text));
}

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const isB32 = (h) => /^0x[0-9a-fA-F]{64}$/.test(String(h || ""));
const topicOf = (addr) => `0x${"0".repeat(24)}${String(addr).slice(2).toLowerCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Find the on-chain proof for an EVM exact (EIP-3009) payment. Returns
 * `{ transaction, payer }` on proof, or `{ proven: false, reason }`.
 */
export async function proveAuthorizationSettled({
  paymentPayload,
  requirements,
  rpcFor = evmRpcFor,
  fetchImpl = fetch,
  deadlineMs = 15_000,
  pollDelaysMs = [0, 1500, 3000, 4500, 6000],
  callTimeoutMs = 4000,
} = {}) {
  const network = String(requirements?.network || "");
  if (!network.startsWith("eip155:")) return { proven: false, reason: "not an EVM network" };
  if (String(requirements?.scheme || "").toLowerCase() !== "exact") return { proven: false, reason: "not an exact payment" };
  const auth = paymentPayload?.payload?.authorization;
  if (!auth || !isAddr(auth.from) || !isB32(auth.nonce)) return { proven: false, reason: "no EIP-3009 authorization in the payload" };
  const payTo = requirements?.payTo;
  const asset = requirements?.asset;
  if (!isAddr(payTo) || !isAddr(asset)) return { proven: false, reason: "requirements carry no EVM payTo or asset" };
  let required;
  try { required = BigInt(requirements.amount); } catch { return { proven: false, reason: "requirements amount unreadable" }; }
  if (required <= 0n) return { proven: false, reason: "requirements amount is zero" };
  const url = rpcFor(network);
  if (!url) return { proven: false, reason: `no RPC for ${network}` };

  const started = Date.now();
  const call = (method, params) => {
    const left = deadlineMs - (Date.now() - started);
    if (left <= 0) throw new Error("deadline reached");
    return rpc(url, method, params, fetchImpl, Math.min(callTimeoutMs, left), []);
  };
  let lastReason = "authorization not found on chain";
  for (const delay of pollDelaysMs) {
    if (delay) {
      if (Date.now() - started + delay >= deadlineMs) break;
      await sleep(delay);
    }
    try {
      const head = Number(BigInt(await call("eth_blockNumber", [])));
      const fromBlock = `0x${Math.max(0, head - LOG_WINDOW_BLOCKS).toString(16)}`;
      const logs = await call("eth_getLogs", [{ address: asset, fromBlock, toBlock: "latest", topics: [AUTHORIZATION_USED_TOPIC, topicOf(auth.from), String(auth.nonce).toLowerCase()] }]);
      const log = (logs || []).find((l) => String(l?.address || "").toLowerCase() === String(asset).toLowerCase() && isB32(l?.transactionHash));
      if (!log) { lastReason = "authorization not found on chain"; continue; }
      const receipt = await call("eth_getTransactionReceipt", [log.transactionHash]);
      if (!receipt) { lastReason = "transaction receipt not available yet"; continue; }
      // From here the chain has answered: the nonce is spent by this
      // transaction, so waiting longer cannot change the verdict.
      if (String(receipt.status) !== "0x1") return { proven: false, reason: `transaction did not succeed on chain (status ${receipt.status})` };
      const moved = evmTransferredInReceipt(receipt, { token: asset, from: auth.from, toSet: [payTo] });
      if (moved === 0n) return { proven: false, reason: "the authorization's transaction moved nothing from the payer to our payTo" };
      if (moved < required) return { proven: false, reason: `transfer is short: moved ${moved} < required ${required} (atomic)` };
      return { proven: true, transaction: log.transactionHash, payer: auth.from };
    } catch (e) {
      lastReason = `could not read the chain: ${String(e?.message || e).slice(0, 120)}`;
    }
  }
  return { proven: false, reason: lastReason };
}
