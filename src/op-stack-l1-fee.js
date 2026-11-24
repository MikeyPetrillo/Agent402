// The L1 data fee of an OP Stack chain (Ink, eip155:57073). A transaction on
// such a chain pays its L2 execution gas (gas x gas price, what
// eth_estimateGas and eth_gasPrice price) AND a fee for posting its bytes to
// L1, charged from the sender's balance on top. The chain's GasPriceOracle
// predeploy (0x420000000000000000000000000000000000000F) prices it:
//   getL1Fee(bytes)               the fee for one unsigned, RLP-encoded transaction
//   getL1FeeUpperBound(uint256)   an upper bound for an unsigned transaction of that size
// Each read is one eth_call, bounded by its own timeout; a read that fails or
// answers no number throws, so the caller treats the fee as unknown.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
/** The networks whose transactions pay an L1 data fee (OP Stack). */
export const L1_FEE_NETWORKS = Object.freeze(new Set(["eip155:57073"]));
export const paysL1DataFee = (network) => L1_FEE_NETWORKS.has(String(network));
/** An unsigned transferWithAuthorization transaction's size, rounded up:
 *  4 + 9 x 32 bytes of calldata plus the EIP-1559 envelope's fields. */
export const SETTLE_TX_UNSIGNED_BYTES = 400;
export const L1_FEE_READ_TIMEOUT_MS = 5_000;

const ABI = parseAbi(["function getL1Fee(bytes _data) view returns (uint256)", "function getL1FeeUpperBound(uint256 _unsignedTxSize) view returns (uint256)"]);

const bounded = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not answer within ${ms} ms`)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
};
const asFee = (v) => {
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n) throw new Error("the L1 fee read answered a negative number");
  return n;
};

/** The call data of getL1FeeUpperBound(size) (for a raw eth_call). */
export const l1FeeUpperBoundCallData = (size = SETTLE_TX_UNSIGNED_BYTES) => encodeFunctionData({ abi: ABI, functionName: "getL1FeeUpperBound", args: [BigInt(size)] });

/**
 * The L1 fee of one unsigned serialized transaction, in wei, read through a
 * viem public client. Throws when the read fails, times out or answers no fee.
 */
export async function readL1Fee(pub, unsignedSerialized, { timeoutMs = L1_FEE_READ_TIMEOUT_MS } = {}) {
  const data = encodeFunctionData({ abi: ABI, functionName: "getL1Fee", args: [unsignedSerialized] });
  const r = await bounded(pub.call({ to: GAS_PRICE_ORACLE, data }), timeoutMs, "the L1 fee read");
  if (!r?.data || r.data === "0x") throw new Error("the L1 fee read answered no value");
  return asFee(decodeFunctionResult({ abi: ABI, functionName: "getL1Fee", data: r.data }));
}

/**
 * An upper bound on one settlement's L1 fee, in wei, through a JSON-RPC
 * `rpc(method, params)` that answers the result as a bigint (the gas check's
 * reader). Throws when the read fails or times out.
 */
export async function readL1FeeUpperBound(rpc, { size = SETTLE_TX_UNSIGNED_BYTES, timeoutMs = L1_FEE_READ_TIMEOUT_MS } = {}) {
  return asFee(await bounded(rpc("eth_call", [{ to: GAS_PRICE_ORACLE, data: l1FeeUpperBoundCallData(size) }, "latest"]), timeoutMs, "the L1 fee read"));
}
