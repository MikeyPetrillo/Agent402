// The sentence a refusal ends with when the caller has no way to pay or has
// reached the free limit: what to do next, with an address a person can tap
// on a phone. Read by the hosted connector (src/mcp-http.js: the paid-tool
// refusal and both rate-limit answers) and the proof-of-work redemption limit
// (src/server.js). Only message text is built here; no field, code or shape
// of an answer depends on it.
//
// Each offer reads the switch that sells it: the credits connector address
// is named only while credits are on sale AND the connector sign-in is on
// (creditsConnectorOn, the pair /start reads); otherwise the sentence names
// the free tools on a phone and the wallet setup, and nothing about cards.
import { creditsConnectorOn, creditsSalesEnabled, CREDITS_CONNECTOR_PATH } from "./credits-sales.js";

/** /start's sections a next step links to (src/start-page.js ids). */
export const START_PHONE_PATH = "/start#phone";
export const START_WALLET_PATH = "/start#fund";
export const START_APPS_PATH = "/start#apps";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A wait in words: the limiter's whole seconds, kept exactly, and minutes or
 * hours beside them once the wait is long enough that seconds read badly.
 */
export function waitInWords(retryAfterSeconds) {
  const s = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1));
  if (s < 120) return plural(s, "second");
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `about ${plural(minutes, "minute")} (${s} seconds)`;
  return `about ${plural(Math.round(s / 3600), "hour")} (${s} seconds)`;
}

/**
 * The next step for a caller on the hosted connector.
 * `limited`: the caller reached the free limit (a free tool), else it asked
 * for a paid tool with no payment. `connector` defaults to this boot's switches.
 * `creditsPay`: whether the credits connector would pay for the tool refused
 * (src/mcp-http.js derives it with creditsConnectorPays from the same checks
 * the credits gate and the connector's credits path refuse on); a tool it
 * would refuse is never offered the credits connector.
 */
export function connectorNextStep(baseUrl, { limited = false, connector = creditsConnectorOn(), creditsPay = true } = {}) {
  const b = String(baseUrl || "").replace(/\/$/, "");
  if (connector && limited) {
    return `Free tools on a phone: ${b}${START_PHONE_PATH}; most paid tools also run from a phone through ${b}${CREDITS_CONNECTOR_PATH}, which pays from prepaid credits bought by card after an email sign-in (${b}${START_APPS_PATH}).`;
  }
  if (connector && creditsPay) {
    return `To pay from a phone, add ${b}${CREDITS_CONNECTOR_PATH} as your connector and sign in with your email: it pays from prepaid credits bought by card (${b}${START_APPS_PATH}).`;
  }
  return limited
    ? `Free tools on a phone: ${b}${START_PHONE_PATH}; to call past the free limit, run it from a computer with a wallet that pays per call (${b}${START_WALLET_PATH}).`
    : `This tool runs from a computer with a wallet that pays per call (${b}${START_WALLET_PATH}); on a phone, the free tools work with no wallet (${b}${START_PHONE_PATH}).`;
}

/**
 * The proof-of-work redemption limit's message (HTTP 429, `error`): when the
 * limit resets and how to be served before then. A credits key is named only
 * while credits are on sale.
 */
export function powLimitMessage(baseUrl, retryAfterSeconds, { credits = creditsSalesEnabled() } = {}) {
  const b = String(baseUrl || "").replace(/\/$/, "");
  const pay = credits
    ? `pay per call in USDC via x402 (${b}${START_WALLET_PATH}) or with a prepaid credits key bought by card (${b}/credits)`
    : `pay per call in USDC via x402 (${b}${START_WALLET_PATH})`;
  return `Free-tier rate limit reached for proof-of-work redemption; it resets in ${waitInWords(retryAfterSeconds)}. Retry then, or ${pay}.`;
}
