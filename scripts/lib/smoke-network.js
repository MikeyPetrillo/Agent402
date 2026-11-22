// The one network scripts/smoke-buy.js pays on: Base, or the EVM buyer chain
// SMOKE_NETWORK names (a chain name or its CAIP-2 id from
// src/evm-buyer-chains.js, the table the router's own buyer pays from). One
// network per run, so the exact scheme and the signing guard are registered
// for that chain alone and no other accept can be selected.
import { EVM_BUYER_CHAINS, EVM_BUYER_CHAIN_BY_NETWORK } from "../../src/evm-buyer-chains.js";

export const SMOKE_NETWORK_NAMES = Object.freeze(Object.keys(EVM_BUYER_CHAINS));

/** The CAIP-2 network for a SMOKE_NETWORK value; Base when unset; null when it
 *  names no chain in the buyer table. */
export function smokeNetwork(raw) {
  const k = String(raw ?? "").trim().toLowerCase();
  if (!k) return EVM_BUYER_CHAINS.base.caip2;
  if (Object.hasOwn(EVM_BUYER_CHAINS, k)) return EVM_BUYER_CHAINS[k].caip2;
  return Object.hasOwn(EVM_BUYER_CHAIN_BY_NETWORK, k) ? k : null;
}
