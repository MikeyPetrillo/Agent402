// The Tempo TIP-20 dollar tokens this server can take over MPP's tempo/charge,
// in one place: the addresses, the names TEMPO_CURRENCY accepts for them, and
// the label a public surface prints. Each is a six-decimal dollar token at the
// same address on Tempo mainnet (4217) and its testnet (42431); the addresses
// match viem's token definitions (scripts/test-tempo-currencies.js reads them).
//
// TEMPO_CURRENCY is read in order and one challenge is minted per entry; a
// stock mppx client pays the first tempo challenge it can, so the currency
// most buyers hold goes first (USDC.e), and OUSD goes after it.
// A leaf module: no imports, so the low-level readers (price-usd.js,
// sanctions-screen.js) can share it without an import cycle.

export const TEMPO_PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
export const TEMPO_USDC_E_ADDRESS = "0x20C000000000000000000000b9537d11c60E8b50";
export const TEMPO_OUSD_ADDRESS = "0x20c0000000000000000000006a37DA5C996874BE";

/** Every Tempo dollar token this server names, with its alias and label. */
export const TEMPO_DOLLAR_TOKENS = Object.freeze([
  Object.freeze({ alias: "usdc", label: "USDC.e", address: TEMPO_USDC_E_ADDRESS, decimals: 6 }),
  Object.freeze({ alias: "pathusd", label: "PathUSD", address: TEMPO_PATH_USD_ADDRESS, decimals: 6 }),
  Object.freeze({ alias: "ousd", label: "OUSD", address: TEMPO_OUSD_ADDRESS, decimals: 6 }),
]);

/** One TEMPO_CURRENCY entry: an alias (any case) becomes its address; anything else is kept as written. */
export function resolveTempoCurrency(entry) {
  const s = String(entry ?? "").trim();
  const hit = TEMPO_DOLLAR_TOKENS.find((t) => t.alias === s.toLowerCase());
  return hit ? hit.address : s;
}

/** The label of a Tempo token address ("USDC.e", "PathUSD", "OUSD"), or null for one not listed here. */
export function tempoTokenLabel(address) {
  const a = String(address || "").toLowerCase();
  return TEMPO_DOLLAR_TOKENS.find((t) => t.address.toLowerCase() === a)?.label || null;
}

/** The listed Tempo dollar-token addresses, lowercased. */
export const TEMPO_DOLLAR_ADDRESSES_LC = Object.freeze(TEMPO_DOLLAR_TOKENS.map((t) => t.address.toLowerCase()));
