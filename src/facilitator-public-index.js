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

// A URL's hostname, or "" when it does not parse. Only a parsed hostname is
// printed (letters, digits, dots, hyphens), never the raw variable.
function hostOf(url) {
  try {
    const h = new URL(String(url || "").trim()).hostname.toLowerCase();
    return /^[a-z0-9.-]+$/.test(h) ? h : "";
  } catch { return ""; }
}

/** The host of the facilitator each listed chain publishes through: Robinhood's
 *  first listed facilitator (ROBINHOOD_FACILITATOR_URL) and Solana's last
 *  fallback (SOLANA_FALLBACK_FACILITATOR_URL). "" when unset. */
export function publicIndexHosts(env = process.env) {
  const first = String(env.ROBINHOOD_FACILITATOR_URL || "").split(",")[0];
  return { robinhood: hostOf(first), solana: hostOf(env.SOLANA_FALLBACK_FACILITATOR_URL) };
}

function named(hosts) {
  const list = [...new Set(hosts.filter(Boolean))];
  return list.length ? ` (${list.join(", ")})` : "";
}

/** The privacy page's paragraph for `chains`, or "" when none is listed. */
export function publicIndexPrivacyText(chains = publicIndexChains(), hosts = publicIndexHosts()) {
  const rh = chains.includes("robinhood");
  const sol = chains.includes("solana");
  if (!rh && !sol) return "";
  const who = `the facilitator that settles the payment${named([rh ? hosts.robinhood : "", sol ? hosts.solana : ""])}`;
  const where = rh && sol
    ? `On Robinhood Chain, and on Solana when a settlement falls back past its first facilitators, ${who}`
    : rh
      ? `On Robinhood Chain, ${who}`
      : `On Solana, only for a settlement that falls back past its first facilitators, ${who}`;
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
