// The `payment` block of a first-contact 402 body: what this call costs in
// dollars and what a caller with no x402 client can do next.
//
// The offer itself (x402Version, resource, accepts, extensions) is the
// PAYMENT-REQUIRED header, mirrored into the body by
// src/payment-required-body.js; its amounts are atomic units per network.
// This block is beside it, body only, and adds nothing an x402 client reads:
//   price     the dollar price of THIS request on `network` (the list price,
//             or the per-request quote, through the same per-network funnel
//             the accept is priced through, so it equals that accept's amount)
//   network   the network that price is for, by its public name
//   how       one sentence that holds on every accept
//   quote     on a route quoted from its body: the model the caller named,
//             the request size and the output cap the caller sent. Only the
//             caller's own inputs and the total; no rate, cost or markup.
//   noWallet  on a proof-of-work tool: the free path and where its flow is
//   docs, howToPay, mcp   the index, the pay section of /agents.md, and the
//             hosted connector
//
// Pure: every figure and switch is passed in by server.js, which reads them
// from the catalog, the request and the live offer.
import { AGENTS_MD_PATH, POW_LIST_PATH } from "./front-door.js";

/** The /agents.md heading the pay instructions live under, and its anchor. */
export const PAY_HEADING = "Pay";
export const HOW_TO_PAY_PATH = `${AGENTS_MD_PATH}#${PAY_HEADING.toLowerCase()}`;
export const HOW_SENTENCE = "Sign one accepts[] entry with an x402 client (its amount is that network's price in the asset's atomic units) and resend this request with the PAYMENT-SIGNATURE header.";

/** "$0.0105" for a dollar figure: micro-dollar precision, trailing zeros cut
 *  (the same spelling src/payments.js gives a per-request quote). */
export function usdText(usd) {
  return "$" + Number(usd).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

// A model id is echoed only in the shape model ids have; anything else is left out.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const positiveInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/** What the quote was computed from, in the caller's own terms. `input` is the
 *  object the handler would be served; `requestBytes` the request's length. */
export function quoteInputs(input, requestBytes) {
  const out = {};
  if (typeof input?.model === "string" && MODEL_RE.test(input.model)) out.model = input.model;
  const bytes = positiveInt(Number(requestBytes));
  if (bytes) out.requestBytes = bytes;
  const cap = positiveInt(input?.max_tokens) ?? positiveInt(input?.max_completion_tokens) ?? positiveInt(input?.max_output_tokens);
  if (cap) out.maxOutputTokens = cap;
  return out;
}

/**
 * @param {object} o
 * @param {string} o.price       "$0.010": this request's price on `network`
 * @param {string} o.network     public network name ("base")
 * @param {string} o.baseUrl     the server's public origin
 * @param {object|null} [o.quote]   quoteInputs() on a route quoted from its body
 * @param {boolean} [o.powEligible] the tool takes proof-of-work
 * @returns {object|null} the block, or null when there is no price to state
 */
export function paymentGuide({ price, network, baseUrl, quote = null, powEligible = false } = {}) {
  if (typeof price !== "string" || !/^\$\d+(\.\d+)?$/.test(price) || !network) return null;
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  return {
    price,
    network,
    how: HOW_SENTENCE,
    ...(quote ? { quote } : {}),
    ...(powEligible ? { noWallet: { method: "proof-of-work", price: "free", how: `${origin}${POW_LIST_PATH}` } } : {}),
    docs: `${origin}/llms.txt`,
    howToPay: `${origin}${HOW_TO_PAY_PATH}`,
    mcp: `${origin}/mcp`,
  };
}
