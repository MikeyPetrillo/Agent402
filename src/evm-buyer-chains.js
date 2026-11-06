// The EVM chains the router's x402 buyer can pay a seller on, one config each.
//
// One spending wallet (X402_UPSTREAM_BUYER_KEY) signs on every chain here: an
// EIP-3009 authorization is a signature, not a transaction, so the same key
// pays on any EVM chain whose token it holds, and the facilitator pays the gas.
// What differs per chain is the token: its address, its decimals and the
// EIP-712 domain it signs under. Those come from this table and NEVER from the
// seller's accept: a seller names the network and the asset, and an accept
// whose (network, asset) pair is not the row below is not payable at all, so a
// seller cannot hand us its own decimals or its own domain.
//
// Every row's asset and decimals equal client/known-assets.js (the table the
// buyer SDKs price accepts from; scripts/test-evm-buyer-chains.js pins the two
// together), and every USDC row's domain is the separator-verified row in
// src/evm-usdc-domain.js. Robinhood Chain settles USDG (Global Dollar), whose
// domain is the one this host's own Robinhood rail signs under (payments.js).
//
// Base is always on. Every other chain is dispatched only while the operator
// lists it in SOR_EVM_CHAINS (comma separated, chain names or CAIP-2 ids), so
// shipping this table changes nothing until that is set.
import { domainTruthFor } from "./evm-usdc-domain.js";
import { evmRpcFor } from "./evm-rpcs.js";

const usdcRow = (name, caip2, asset) => {
  const truth = domainTruthFor(caip2, asset);
  if (!truth) throw new Error(`evm-buyer-chains: no verified EIP-712 domain for ${caip2} ${asset}`);
  return Object.freeze({ name, caip2, asset: asset.toLowerCase(), decimals: 6, symbol: "USDC", domain: Object.freeze({ name: truth.name, version: truth.version }) });
};

export const EVM_BUYER_CHAINS = Object.freeze({
  base: usdcRow("base", "eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
  arc: usdcRow("arc", "eip155:5042", "0x3600000000000000000000000000000000000000"),
  celo: usdcRow("celo", "eip155:42220", "0xceba9300f2b948710d2653dd7b07f33a8b32118c"),
  polygon: usdcRow("polygon", "eip155:137", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
  arbitrum: usdcRow("arbitrum", "eip155:42161", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
  robinhood: Object.freeze({ name: "robinhood", caip2: "eip155:4663", asset: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, symbol: "USDG", domain: Object.freeze({ name: "Global Dollar", version: "1" }) }),
});

/** CAIP-2 -> chain name, for every chain in the table. */
export const EVM_BUYER_CHAIN_BY_NETWORK = Object.freeze(Object.fromEntries(Object.values(EVM_BUYER_CHAINS).map((c) => [c.caip2, c.name])));

/** True for a chain name this table knows (enabled or not). */
export function isEvmBuyerChain(chain) {
  return Object.hasOwn(EVM_BUYER_CHAINS, String(chain || ""));
}

/** The config row for a chain name, or null. */
export function evmBuyerChain(chain) {
  return isEvmBuyerChain(chain) ? EVM_BUYER_CHAINS[chain] : null;
}

/** The chains the router may pay on: Base, plus each one SOR_EVM_CHAINS lists
 *  (a name or its CAIP-2 id). An entry this table does not know is ignored
 *  with a warning, never read as a new chain. Read at call time. */
const warned = new Set();
export function enabledEvmBuyerChains(env = process.env) {
  const out = ["base"];
  for (const raw of String(env.SOR_EVM_CHAINS || "").split(",")) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const name = isEvmBuyerChain(k) ? k : EVM_BUYER_CHAIN_BY_NETWORK[k] || null;
    if (!name) {
      if (!warned.has(k)) { warned.add(k); console.warn(`[evm-buyer-chains] SOR_EVM_CHAINS entry ignored (not a known buyer chain): ${JSON.stringify(k).slice(0, 40)}`); }
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Is the router allowed to pay on this EVM chain right now? */
export function evmBuyerChainEnabled(chain, env = process.env) {
  return isEvmBuyerChain(chain) && enabledEvmBuyerChains(env).includes(chain);
}

/** The RPC the chain-truth reads use for a chain name (EVM_RPC_<id> overrides). */
export function evmBuyerRpc(chain, env = process.env) {
  const cfg = evmBuyerChain(chain);
  if (!cfg) return null;
  if (chain === "base") return (env.AGENT402_BASE_RPC || evmRpcFor(cfg.caip2, env) || "").trim() || null;
  return evmRpcFor(cfg.caip2, env);
}

/**
 * The accept's EIP-712 domain against the token's own, from the table. A name
 * or version the accept advertises that is not the token's refuses; an accept
 * that names none is refused too, because the stock signer cannot sign without
 * one and a guessed domain is a signature that recovers to nobody.
 *   { ok: true } | { ok: false, field, advertised, expected }
 */
export function evmAcceptDomainCheck(accept, chain) {
  const cfg = evmBuyerChain(chain);
  if (!cfg) return { ok: false, field: "chain", advertised: null, expected: null };
  const name = typeof accept?.extra?.name === "string" ? accept.extra.name.trim() : "";
  const version = typeof accept?.extra?.version === "string" ? accept.extra.version.trim() : "";
  if (!name || name.toLowerCase() !== cfg.domain.name.toLowerCase()) return { ok: false, field: "name", advertised: name.slice(0, 40) || null, expected: cfg.domain.name };
  if (!version || version.toLowerCase() !== cfg.domain.version.toLowerCase()) return { ok: false, field: "version", advertised: version.slice(0, 16) || null, expected: cfg.domain.version };
  return { ok: true };
}
