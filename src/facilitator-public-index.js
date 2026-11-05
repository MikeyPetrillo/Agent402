// FACILITATOR_PUBLIC_INDEX_CHAINS (comma list from robinhood, solana; unset =
// none): the chains on which a facilitator we settle through publishes each
// settlement it relays on its own public index. /privacy and /terms read it at
// render time, so their disclosure appears only while it applies and names
// exactly the chains listed. Unknown names are ignored.
const KNOWN = ["robinhood", "solana"];

export const PUBLIC_INDEX_ANCHOR = "public-settlement-index";

/** The listed chains, in a fixed order (robinhood, then solana). */
export function publicIndexChains(env = process.env) {
  const listed = new Set(String(env.FACILITATOR_PUBLIC_INDEX_CHAINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return KNOWN.filter((c) => listed.has(c));
}

/** The privacy page's paragraph for `chains`, or "" when none is listed. */
export function publicIndexPrivacyText(chains = publicIndexChains()) {
  const rh = chains.includes("robinhood");
  const sol = chains.includes("solana");
  if (!rh && !sol) return "";
  const where = rh && sol
    ? "On Robinhood Chain, and on Solana when a settlement falls back past its first facilitators, the facilitator that settles the payment"
    : rh
      ? "On Robinhood Chain, the facilitator that settles the payment"
      : "On Solana, only for a settlement that falls back past its first facilitators, the facilitator that settles the payment";
  return `${where} publishes each settlement it relays on its public index: payer and payee wallets, amount, time, transaction hash and the service paid. Pay on another chain to keep a payment off that index.`;
}

/** The terms page's pointer to that paragraph, or "" when none is listed. */
export function publicIndexTermsText(chains = publicIndexChains()) {
  const rh = chains.includes("robinhood");
  const sol = chains.includes("solana");
  if (!rh && !sol) return "";
  const where = rh && sol ? "On Robinhood Chain, and on Solana for a settlement that falls back," : rh ? "On Robinhood Chain," : "On Solana, for a settlement that falls back,";
  return `${where} the facilitator that settles a payment publishes it on its public index, as the <a href="/privacy#${PUBLIC_INDEX_ANCHOR}">privacy policy</a> describes.`;
}
