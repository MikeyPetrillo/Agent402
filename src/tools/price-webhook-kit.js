// price-webhook-kit - `POST /api/price-webhook`: register an https URL that
// gets a signed POST when the list price of a watched tool changes.
// The rules (what is watched, the signature, the retries, the bounds) are in
// src/price-webhooks.js; this file is the catalog entry, its input checks,
// who the registrant is and when the registration is kept.
//
// The registration outlives the answer, so the slug is in the lasting-effect
// list (src/lasting-effect-slugs.js): a hang-up is never forgiven, the call is
// never replayed implicitly and it is never settled in a batch.
//
// KEPT ONLY WHEN THE CALL SETTLES. The payment gate settles after the handler
// and turns a failed settlement into a 402, so the handler stores the
// subscription as pending and leaves a hook on the request
// (`req.__onSettled`, which the dispatcher runs once with whether the final
// response was a settled 200; src/hangup-settlement.js onSettleOutcome): a
// settled call confirms it, any other outcome removes it. A step an in-process
// executor runs (route-execute, decide-execute) has no request of its own: it
// is kept on the same terms against the PAYING request it runs for, whose
// dispatcher reports that request's final response (currentSettleHook). Only
// a call that has no paying request to wait for (no payment settles after it,
// as in FREE_MODE) is kept at once.
import { createHash } from "node:crypto";
import { priceWebhooks, PRICE_WEBHOOK_SLUG, UNSUBSCRIBE_PATH, SIGNATURE_HEADER, DELIVERY_HEADER, SIGNATURE_SCHEME, EVENT_PRICE_CHANGED, MAX_SLUGS, MAX_URL_CHARS, RETRY_DELAYS_MS, lifetimeMs, maxPerRegistrant } from "../price-webhooks.js";
import { identityPayerOf, paymentHeaderOf, freeModeOn } from "../payer.js";
import { nonEvmPayerFromRequest } from "../non-evm-payer.js";
import { currentDispatchCaller, currentSettleHook, IN_PROCESS_CALLER, ANONYMOUS_CALLER } from "../dispatch-caller.js";
import { limiterKey } from "../rate-limit.js";

// The catalog's slugs, handed over by server.js once the catalog is built.
let knownSlugs = () => null;
export function setPriceWebhookCatalog(fn) { knownSlugs = typeof fn === "function" ? fn : () => null; }

/**
 * The registrant of a call: the party whose subscriptions its cap counts
 * (src/price-webhooks.js). The route is paid by a wallet, so that is the
 * payer the gate verified before the handler ran, on whichever rail it paid:
 *   - the signed EVM payer (identityPayerOf), a credits key, a Tempo sender;
 *   - the signer of a Solana, Algorand or Stellar payment (case kept);
 *   - any other paid call (a credential that names no wallet this server can
 *     read): that payment itself, so it is a registrant of its own and is
 *     never counted with another party's.
 * In FREE_MODE no payment is verified, so there is no payer (identityPayerOf
 * is null and a header a caller typed keys nothing): the registrant is the
 * client address (an IPv6 one folded to its /64), held to the same cap, and
 * the store's own bound applies. With no request (a step an in-process
 * executor runs) it is the caller that dispatched the step.
 */
export async function registrantOf(req) {
  if (!req || typeof req !== "object" || !req.headers) return currentDispatchCaller() || IN_PROCESS_CALLER;
  const payer = identityPayerOf(req);
  if (payer) return `payer:${payer}`;
  if (req.creditsKeyId) return `credits:${req.creditsKeyId}`;
  if (req.mppTempoSender) return `tempo:${String(req.mppTempoSender).toLowerCase()}`;
  if (!freeModeOn()) {
    let signer = null;
    try { signer = await nonEvmPayerFromRequest(req); } catch { signer = null; }
    if (signer) return signer; // `svm:`, `avm:` or `stellar:` and the address, case kept
    let credential = null;
    try { credential = paymentHeaderOf(req) || req.headers.authorization || null; } catch { credential = null; }
    if (typeof credential === "string" && credential) return `paid:${createHash("sha256").update(credential).digest("hex").slice(0, 32)}`;
  }
  return req.ip ? `ip:${limiterKey(String(req.ip))}` : ANONYMOUS_CALLER;
}

/** True when the dispatcher reports this request's final response to the hooks on it. */
const settlesLater = (req) => Boolean(req && typeof req === "object" && req.res && typeof req.res.once === "function");
/** Where this call's outcome is reported: its own request's hooks; for a
 *  request-less step, those of the paying request it runs for; else none. */
const settleHookOf = (req) => {
  if (settlesLater(req)) return (hook) => { (req.__onSettled ||= []).push(hook); };
  if (!req || typeof req !== "object" || !req.headers) return currentSettleHook();
  return null;
};

export function makePriceWebhookHandler(deps = {}) {
  const store = deps.store || priceWebhooks;
  return async (input, req) => {
    const body = input && typeof input === "object" ? input : {};
    const opts = { known: (deps.known || knownSlugs)(), registrant: await (deps.registrantOf || registrantOf)(req) };
    const onSettled = settleHookOf(req);
    if (!onSettled) return store().register({ url: body.url, slugs: body.slugs }, opts);
    const { answer, settle } = await store().registerPending({ url: body.url, slugs: body.slugs }, opts);
    // Kept only when the FINAL response is a settled 200 (settlement runs after this handler).
    onSettled((settledOk) => { Promise.resolve(settle(settledOk === true)).catch(() => {}); });
    return answer;
  };
}

const ATTEMPTS = RETRY_DELAYS_MS.length + 1;
// Read once at load, as the catalog's descriptions are (the defaults unless the operator set them).
const LIFETIME_DAYS = Math.round(lifetimeMs() / 86_400_000);
const PER_REGISTRANT = maxPerRegistrant();

export const PRICE_WEBHOOK_TOOLS = [
  {
    route: "POST /api/price-webhook",
    name: "Price change webhook",
    slug: PRICE_WEBHOOK_SLUG,
    category: "payments",
    price: "$0.01",
    description:
      `Register an https URL and get a signed POST when the list price of a tool you watch changes on this server (a retry carries the same ${DELIVERY_HEADER} id). Give "url" and, optionally, "slugs" (up to ${MAX_SLUGS} tool slugs; omit it to watch every tool). The answer carries the subscription id and its secret: each delivery is JSON ({ type: "${EVENT_PRICE_CHANGED}", changes: [{ slug, from, to }] }) with an ${SIGNATURE_HEADER} header, t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>, so the receiver can check it came from here. A subscription lasts ${LIFETIME_DAYS} days ("expiresAt"); register the same url again from the same wallet to renew it (same id and secret). One wallet holds up to ${PER_REGISTRANT}. A watched tool that is retired or no longer served is announced once, as { slug, from, to: null, status: "retired" or "unavailable" }, with "replacement" when a retired tool names one. A delivery is tried up to ${ATTEMPTS} times; a 2xx ends it and a 410 removes the subscription. To make room for a new registration, subscriptions whose deliveries keep failing are removed; a working subscription never is. When the server holds as many as it keeps and none is failing, a new registration is refused with 503 and Retry-After before any settlement, so it is not charged on x402, MPP evm, card or credits. Remove it yourself, free, with POST ${UNSUBSCRIBE_PATH} and the id and secret. The watched price is the list price on /api/pricing; a tool that is quoted per request keeps its list price there. Deterministic code, no model.`,
    pageSummary:
      `Register an https URL and get a signed POST when the list price of a tool you watch changes on this server. Optional "slugs" (up to ${MAX_SLUGS}) narrows the watch. The answer carries the subscription id and secret; each delivery is JSON {type:"${EVENT_PRICE_CHANGED}",changes:[{slug,from,to}]} signed in ${SIGNATURE_HEADER}, tried up to ${ATTEMPTS} times. Lasts ${LIFETIME_DAYS} days; the same url and wallet renew it. One wallet holds up to ${PER_REGISTRANT}. To make room, subscriptions whose deliveries keep failing are removed; a working subscription never is. When full with none failing, a new registration is refused with 503 and Retry-After before any settlement, so it is not charged on x402, MPP evm, card or credits. Unsubscribe free: POST ${UNSUBSCRIBE_PATH}. Deterministic code, no model.`,
    tags: ["webhook", "price", "pricing", "notification", "callback", "subscribe"],
    aliases: ["price-alert", "price-change-webhook", "pricing-webhook"],
    discovery: {
      bodyType: "json",
      // The root of a documentation host: answered in full, nothing stored or sent
      // (a path on a reserved example host is refused by scripts/test-example-urls-fetchable.js).
      input: { url: "https://example.com/", slugs: ["search", "answer"] },
      inputSchema: {
        properties: {
          url: { type: "string", maxLength: MAX_URL_CHARS, description: "The https URL that receives the signed POST. No credentials in the URL; it must resolve to a public address." },
          slugs: { type: "array", items: { type: "string" }, description: `Tool slugs to watch (up to ${MAX_SLUGS}), as listed on /api/pricing. Omit it to watch every tool.` },
        },
        required: ["url"],
      },
      output: {
        example: {
          id: "pw_3f9a1c2e4b6d8f0a1c3e5a7b9d1f2e4c",
          url: "https://example.com/",
          slugs: ["answer", "search"],
          secret: "a402whsec_<64 hex characters>",
          signature: { header: SIGNATURE_HEADER, scheme: SIGNATURE_SCHEME },
          event: EVENT_PRICE_CHANGED,
          unsubscribe: { method: "POST", url: `https://agent402.tools${UNSUBSCRIBE_PATH}`, body: { id: "pw_3f9a1c2e4b6d8f0a1c3e5a7b9d1f2e4c", secret: "<the secret above>" } },
          expiresAt: "2027-02-19T12:00:00.000Z",
          registered: false,
          delivers: false,
          note: "example.com is a documentation host: the registration is answered as a real one would be, and nothing is stored or sent.",
        },
      },
    },
    handler: makePriceWebhookHandler(),
  },
];
