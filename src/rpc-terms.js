// Chain RPC endpoints and their terms of use. This server's payment
// verification, settlement proofs, refunds, revenue reads and ops scripts are
// commercial use, so they read only endpoints whose terms permit it: a keyed
// Alchemy lane (the account's plan), the PublicNode public endpoints and the
// other hosts in PERMITTED_RPC_SOURCES, each with the terms clause it rests on.
//
// NON_COMMERCIAL_RPC_HOSTS are public endpoints whose terms limit use to
// personal or non-commercial purposes, or bar production workloads. No code
// default names one; an operator may still set one through a variable (each
// reader's override), which is a deliberate choice outside the defaults.
// scripts/test-rpc-host-terms.js fails a default that names one anywhere in
// the shipped code and the ops scripts.
//
// Dependency-free.

/** Hosts whose terms bar commercial or production use (never a default). */
export const NON_COMMERCIAL_RPC_HOSTS = Object.freeze([
  "mainnet.optimism.io",            // OP Mainnet public RPC: personal, non-commercial use
  "rpc.monad.xyz",                  // Monad public RPC: personal, non-commercial; not for production
  "rpc2.monad.xyz",
  "rpc.mainnet.chain.robinhood.com", // Robinhood Chain public RPC: not for production or embedding
  "api.avax.network",               // Avalanche public API: personal, non-commercial terms
  "api.mainnet-beta.solana.com",    // Solana Foundation public RPC: no commercial use without approval
]);

/** PublicNode's public endpoints for the chains it serves. */
export const PUBLICNODE_RPCS = Object.freeze({
  base: "https://base-rpc.publicnode.com",
  ethereum: "https://ethereum-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com",
  gnosis: "https://gnosis-rpc.publicnode.com",
  avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  robinhood: "https://robinhood-rpc.publicnode.com",
  sei: "https://sei-evm-rpc.publicnode.com",
  solana: "https://solana-rpc.publicnode.com",
});

/** OnFinality's public (keyless) endpoints, read as a backup lane only. */
export const ONFINALITY_RPCS = Object.freeze({
  monad: "https://monad-mainnet.api.onfinality.io/public",
});

/** Endpoint operators whose terms permit this server's own commercial use
 *  (payment verification, settlement proofs, refunds: our internal business,
 *  never a resold read), with the clause each rests on. A lane added to a
 *  chain on the strength of an operator's terms is added here with its source
 *  (scripts/test-rpc-host-terms.js reads the hosts). */
export const PERMITTED_RPC_SOURCES = Object.freeze([
  Object.freeze({
    hosts: /\.g\.alchemy\.com$/,
    operator: "Alchemy (keyed lane, the account's plan)",
    terms: "https://legal.alchemy.com/",
    clause: "Terms of Service v3.0 (effective 2026-11-12) section 2.1: use solely for your internal business purposes",
    read: "2026-11-23",
  }),
  Object.freeze({
    hosts: /(^|\.)publicnode\.com$/,
    operator: "PublicNode (Allnodes)",
    terms: "https://www.publicnode.com/terms",
    clause: "Automated Access: access by automated means for development and production purposes, no prior authorization required; no resale as a standalone RPC or data API service",
    read: "2026-11-24",
  }),
  Object.freeze({
    hosts: /^[a-z0-9-]+\.api\.onfinality\.io$/,
    operator: "OnFinality (public endpoints)",
    terms: "https://onfinality.io/terms",
    clause: "Terms (updated 2024-12-03) clause 5.1: Free Services are under these Terms; clause 6.1(a)(i): use for your own internal business purposes; 6.1(a)(iii): no resale or third-party access",
    read: "2026-11-24",
  }),
]);

/** The permitted source a URL's host rests on, or null. */
export function permittedRpcSource(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
  return PERMITTED_RPC_SOURCES.find((s) => s.hosts.test(host)) || null;
}

/** Alchemy's network name per CAIP-2 chain (a keyed lane when ALCHEMY_API_KEY is set). */
export const ALCHEMY_NETWORKS = Object.freeze({
  "eip155:8453": "base-mainnet",
  "eip155:137": "polygon-mainnet",
  "eip155:42161": "arb-mainnet",
  "eip155:43114": "avax-mainnet",
  "eip155:10": "opt-mainnet",
  "eip155:42220": "celo-mainnet",
  "eip155:143": "monad-mainnet",
  "eip155:1329": "sei-mainnet",
  "eip155:4663": "robinhood-mainnet",
  "eip155:5042": "arc-mainnet",
  "eip155:57073": "ink-mainnet",
});

/** The keyed Alchemy URL for a CAIP-2 chain, or null without a key or a network. */
export function alchemyRpcFor(network, env = process.env) {
  const key = String(env.ALCHEMY_API_KEY || "").trim();
  const net = ALCHEMY_NETWORKS[String(network || "")];
  return key && net ? `https://${net}.g.alchemy.com/v2/${key}` : null;
}

/** The keyed Alchemy Solana URL, or null without a key. */
export function alchemySolanaRpc(env = process.env) {
  const key = String(env.ALCHEMY_API_KEY || "").trim();
  return key ? `https://solana-mainnet.g.alchemy.com/v2/${key}` : null;
}

/** The default Solana JSON-RPC list: the keyed lane when set, then PublicNode. */
export function defaultSolanaRpcs(env = process.env) {
  return [alchemySolanaRpc(env), PUBLICNODE_RPCS.solana].filter(Boolean);
}

/** Does `url` name an endpoint whose terms bar commercial use? */
export function isNonCommercialRpc(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return NON_COMMERCIAL_RPC_HOSTS.includes(host);
}
