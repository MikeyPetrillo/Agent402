// Public RPCs for the EVM rails we settle on, read by the refund runner and by
// the settle path's on-chain proof. Overridable per chain via EVM_RPC_<id> or
// REFUND_RPC_<id> (e.g. REFUND_RPC_8453). A chain with no entry has no RPC:
// a caller refuses loudly rather than reading through a guessed endpoint.
export const EVM_RPCS = {
  "eip155:8453": "https://mainnet.base.org",
  // polygon-rpc.com was shut off 2026-07-31 (probe: "tenant disabled", 403) and
  // was the ONLY Polygon RPC here, so every Polygon refund held unpaid.
  "eip155:137": "https://polygon-bor-rpc.publicnode.com",
  "eip155:42161": "https://arb1.arbitrum.io/rpc",
  "eip155:43114": "https://api.avax.network/ext/bc/C/rpc",
  "eip155:10": "https://mainnet.optimism.io",
  "eip155:42220": "https://forno.celo.org",
  "eip155:1329": "https://evm-rpc.sei-apis.com",
  // Rails that had no entry until the all-chains verifier sweep - without one
  // their rows held as "no RPC configured", which is safe but never repays.
  "eip155:143": "https://rpc.monad.xyz",
  // rpc.robinhoodchain.com answers an EMPTY body; the host the rest of the repo
  // and Robinhood's own docs use is this one (probe: chainId 0x1237).
  "eip155:4663": "https://rpc.mainnet.chain.robinhood.com",
  // Arc mainnet public RPC (probe 2026-10-20: chainId 0x13b2, USDC at
  // 0x3600...0000 answers decimals() 6). Refund proof and settle chain proof.
  "eip155:5042": "https://rpc.mainnet.arc.io",
};

/** The RPC URL for an EVM network (CAIP-2), or null. */
export function evmRpcFor(network, env = process.env) {
  const n = String(network || "");
  if (!n.startsWith("eip155:")) return null;
  const id = n.split(":")[1];
  return (env[`EVM_RPC_${id}`] || env[`REFUND_RPC_${id}`] || EVM_RPCS[n] || "").trim() || null;
}
