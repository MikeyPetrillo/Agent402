// price-webhook-kit - `POST /api/price-webhook`: register an https URL that
// gets one signed POST when the list price of a watched tool changes.
// The rules (what is watched, the signature, the retries, the bounds) are in
// src/price-webhooks.js; this file is the catalog entry and its input checks.
//
// The registration outlives the answer, so the slug is in the lasting-effect
// list (src/lasting-effect-slugs.js): a hang-up is never forgiven, the call is
// never replayed implicitly and it is never settled in a batch.
import { priceWebhooks, PRICE_WEBHOOK_SLUG, UNSUBSCRIBE_PATH, SIGNATURE_HEADER, EVENT_PRICE_CHANGED, MAX_SLUGS, RETRY_DELAYS_MS } from "../price-webhooks.js";

// The catalog's slugs, handed over by server.js once the catalog is built.
let knownSlugs = () => null;
export function setPriceWebhookCatalog(fn) { knownSlugs = typeof fn === "function" ? fn : () => null; }

export function makePriceWebhookHandler(deps = {}) {
  const store = deps.store || priceWebhooks;
  return async (input) => {
    const body = input && typeof input === "object" ? input : {};
    return store().register({ url: body.url, slugs: body.slugs }, { known: (deps.known || knownSlugs)() });
  };
}

const ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export const PRICE_WEBHOOK_TOOLS = [
  {
    route: "POST /api/price-webhook",
    name: "Price change webhook",
    slug: PRICE_WEBHOOK_SLUG,
    category: "payments",
    price: "$0.01",
    description:
      `Register an https URL and get one signed POST when the list price of a tool you watch changes on this server. Give "url" and, optionally, "slugs" (up to ${MAX_SLUGS} tool slugs; omit it to watch every tool). The answer carries the subscription id and its secret, shown once: each delivery is JSON ({ type: "${EVENT_PRICE_CHANGED}", changes: [{ slug, from, to }] }) with an ${SIGNATURE_HEADER} header, t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>, so the receiver can check it came from here. A delivery is tried up to ${ATTEMPTS} times; a 2xx ends it and a 410 removes the subscription. Remove it yourself, free, with POST ${UNSUBSCRIBE_PATH} and the id and secret. The watched price is the list price on /api/pricing; a tool that is quoted per request keeps its list price there. Deterministic code, no model.`,
    tags: ["webhook", "price", "pricing", "notification", "callback", "subscribe"],
    aliases: ["price-alert", "price-change-webhook", "pricing-webhook"],
    discovery: {
      bodyType: "json",
      input: { url: "https://example.com/hooks/agent402-prices", slugs: ["search", "answer"] },
      inputSchema: {
        properties: {
          url: { type: "string", description: "The https URL that receives the signed POST. No credentials in the URL; it must resolve to a public address." },
          slugs: { type: "array", items: { type: "string" }, description: `Tool slugs to watch (up to ${MAX_SLUGS}), as listed on /api/pricing. Omit it to watch every tool.` },
        },
        required: ["url"],
      },
      output: {
        example: {
          id: "pw_3f9a1c2e4b6d8f0a1c3e5a7b9d1f2e4c",
          url: "https://example.com/hooks/agent402-prices",
          slugs: ["answer", "search"],
          secret: "whsec_5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592",
          signature: { header: SIGNATURE_HEADER, scheme: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}` with the secret>" },
          event: EVENT_PRICE_CHANGED,
          unsubscribe: { method: "POST", url: `https://agent402.tools${UNSUBSCRIBE_PATH}`, body: { id: "pw_3f9a1c2e4b6d8f0a1c3e5a7b9d1f2e4c", secret: "<the secret above>" } },
          registered: false,
          delivers: false,
          note: "example.com is a documentation host: the registration is answered as a real one would be, and nothing is stored or sent.",
        },
      },
    },
    handler: makePriceWebhookHandler(),
  },
];
