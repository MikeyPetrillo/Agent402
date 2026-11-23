// What the /v1 model gateway does, in one sentence: the surfaces that describe
// the gateway as a whole (/llms.txt, /docs, /openapi.json's /v1 tag, the
// category blurb) read it from here, and the README and wiki carry the
// published form verbatim (scripts/test-gateway-product-copy.js).
//
// Each clause names something the gateway itself does: the price is set before
// the call runs (a flat tier price, or a quote from the request on the metered
// routes, src/tools/llm-gateway-kit.js), `auto` routes per task, a failed
// model walks to the next one on its tier (the tier's failover chain), and,
// while receipts are signed (receiptsServed(), src/receipt-signing.js), a
// settled paid answer carries a signed receipt.

/** The sentence, with the receipt clause only where receipts are signed. */
export function gatewayProductSentence({ receipts = true } = {}) {
  const acts = [
    "prices each call before it runs (a flat tier price, or a quote from the request on the metered routes)",
    "routes `auto` chat calls to a model chosen for the task",
    "falls back to the next model on a chat tier when one fails",
  ];
  if (receipts) acts.push("signs a receipt for each settled paid answer");
  return `The gateway is an Agent402 service: it ${acts.slice(0, -1).join(", ")}, and ${acts.at(-1)}.`;
}

/** The same sentence for an HTML page (code spans as <code>). */
export function gatewayProductHtml(opts) {
  return gatewayProductSentence(opts).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** The published form (receipts on), carried verbatim by the README and the wiki. */
export const GATEWAY_PRODUCT_SENTENCE = gatewayProductSentence();
