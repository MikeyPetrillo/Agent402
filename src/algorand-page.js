// /algorand — the Algorand x402 marketplace page. Thin wrapper over the
// chain-agnostic renderer in src/market-page.js; keeps the original export
// names so server.js and scripts/test-algorand-page.js need no changes.
// Honesty rules (spec): never invent receipts, say plainly when Agent402 is
// the only listed seller. Listing for external sellers is automatic — the
// index crawler picks up any origin whose 402s advertise an Algorand
// mainnet network.
import { marketSellers, marketTools, marketActivityHtml, marketPage } from "./market-page.js";

export const algorandSellers = (snapshot) => marketSellers("algorand", snapshot);
export const algorandTools = (snapshot) => marketTools("algorand", snapshot);
export const algorandActivityHtml = (activity, selected) => marketActivityHtml("algorand", activity, selected);

export function algorandPage(baseUrl, { snapshot, rail, activity, selectedSeller, algorandWallet, host = null } = {}) {
  return marketPage("algorand", baseUrl, { snapshot, rail, activity, selectedSeller, wallet: algorandWallet, host });
}
