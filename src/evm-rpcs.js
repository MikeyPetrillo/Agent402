// Public RPCs for the EVM rails we settle on, read by the refund runner and by
// the settle path's on-chain proof. Overridable per chain via EVM_RPC_<id> or
// REFUND_RPC_<id> (e.g. REFUND_RPC_8453). Every default is an endpoint whose
// terms permit commercial use (src/rpc-terms.js); a chain with no such public
// endpoint (Monad) reads the keyed Alchemy lane when ALCHEMY_API_KEY is set.
// A chain with neither has no RPC: a caller refuses loudly rather than
// reading through a guessed endpoint.
import { PUBLICNODE_RPCS, alchemyRpcFor } from "./rpc-terms.js";

export const EVM_RPCS = {
  "eip155:8453": "https://mainnet.base.org",
  // polygon-rpc.com was shut off 2026-07-31 (probe: "tenant disabled", 403) and
  // was the ONLY Polygon RPC here, so every Polygon refund held unpaid.
  "eip155:137": "https://polygon-bor-rpc.publicnode.com",
  "eip155:42161": "https://arb1.arbitrum.io/rpc",
  "eip155:43114": PUBLICNODE_RPCS.avalanche,
  "eip155:10": PUBLICNODE_RPCS.optimism,
  "eip155:42220": "https://forno.celo.org",
  "eip155:1329": "https://evm-rpc.sei-apis.com",
  // Monad (eip155:143) has no public endpoint whose terms permit commercial
  // use: it reads the keyed lane (evmRpcFor below).
  // Robinhood Chain through PublicNode (probe 2026-11-24: chainId 0x1237).
  "eip155:4663": PUBLICNODE_RPCS.robinhood,
  // Arc mainnet public RPC (probe 2026-10-20: chainId 0x13b2, USDC at
  // 0x3600...0000 answers decimals() 6). Refund proof and settle chain proof.
  "eip155:5042": "https://rpc.mainnet.arc.io",
  // Ink mainnet public RPC (probe 2026-11-06: chainId 0xdef1, USDC at
  // 0x2D27...AEEd answers decimals() 6). rpc-qnd.inkonchain.com is the
  // second public host (EVM_RPC_57073 to switch). Its receipts are read at
  // the sequencer's head, whose pre-confirmations can be revoked.
  "eip155:57073": "https://rpc-gel.inkonchain.com",
};

/** The RPC URL for an EVM network (CAIP-2), or null. */
export function evmRpcFor(network, env = process.env) {
  const n = String(network || "");
  if (!n.startsWith("eip155:")) return null;
  const id = n.split(":")[1];
  return (env[`EVM_RPC_${id}`] || env[`REFUND_RPC_${id}`] || EVM_RPCS[n] || alchemyRpcFor(n, env) || "").trim() || null;
}

/** Every permitted lane for an EVM network: the operator's override, the
 *  public default and the keyed lane, each once. */
export function evmRpcLanesFor(network, env = process.env) {
  const n = String(network || "");
  if (!n.startsWith("eip155:")) return [];
  const id = n.split(":")[1];
  return [env[`EVM_RPC_${id}`], env[`REFUND_RPC_${id}`], EVM_RPCS[n], alchemyRpcFor(n, env)]
    .map((u) => String(u || "").trim()).filter((u, i, a) => u && a.indexOf(u) === i);
}
