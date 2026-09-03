// /stellar — the Stellar x402 marketplace page. Thin wrapper over the
// chain-agnostic renderer in src/market-page.js; keeps the original export
// names so server.js and scripts/test-stellar-page.js need no changes.
// Honesty rules (spec): never invent receipts, say plainly when Agent402 is
// the only listed seller. Listing for external sellers is automatic — the
// index crawler picks up any origin whose 402s advertise a stellar network.
import { marketSellers, marketTools, marketActivityHtml, marketPage } from "./market-page.js";

export const stellarSellers = (snapshot) => marketSellers("stellar", snapshot);
export const stellarTools = (snapshot) => marketTools("stellar", snapshot);
export const stellarActivityHtml = (activity, selected) => marketActivityHtml("stellar", activity, selected);

export function stellarPage(baseUrl, { snapshot, rail, activity, selectedSeller, stellarWallet, host = null } = {}) {
  return marketPage("stellar", baseUrl, { snapshot, rail, activity, selectedSeller, wallet: stellarWallet, host });
}
