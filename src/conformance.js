// The conformance document (/.well-known/agent402-conformance.json): per
// payment rail this server accepts, which protocol features it implements,
// and the refund terms as data.
//
// Every row and every cell is computed at request time from the code that
// serves payments, never typed as a table:
//   - x402 rows: the accepts a plain catalog route's 402 carries, built by the
//     same acceptsForItem() the paywall calls, over the rails the booted
//     paywall offers (src/payments.js paymentRailsLive); every listed chain
//     (src/rails.js RAILS) has an exact row, offered or not;
//   - every other rail: whether its gate is in this process's request chain
//     (src/gate-mounts.js, marked by src/server.js where it mounts each gate)
//     and the switch that rail reads at call time;
//   - feature cells: the switch or the mounted gate that implements each
//     feature on that rail (hang-up forgiveness, the payer screen, the Tempo
//     settlement mode, the replay guard, idempotency) and the chain family the
//     refund run repays on.
// scripts/test-conformance.js boots servers with switches flipped and checks
// the cells change, and pays each wire to check the claims against what it
// does (settle after the answer, the receipt header, replay and idempotency).
import { CONFORMANCE_PATH } from "./conformance-path.js";
import { REFUND_TERMS_PATH } from "./refund-terms-path.js";
import { RAILS, GATED_RAILS } from "./rails.js";
import { paymentRailsLive, acceptsForItem } from "./payments.js";
import { isGatewayBatchedPayment } from "./gateway-wire.js";
import { gateMounted } from "./gate-mounts.js";
import { mppShimEnabled, challengeEnabledForChain } from "./mpp-shim.js";
import { tempoEnabled, tempoSettlementMode } from "./mpp-tempo.js";
import { stripeEnabled } from "./mpp-stripe.js";
import { humanCheckoutEnabled } from "./human-checkout.js";
import { subscriptionsEnabled } from "./stripe-subscriptions.js";
import { creditsSalesEnabled, TERMS_VERSION } from "./credits-sales.js";
import { hangupForgivenessConfig } from "./hangup-forgiveness.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { IDEMPOTENCY_CREDENTIALS } from "./idempotency.js";
import { gatewayOfferPublic } from "./gateway-nanopayments.js";
import { refundClauses, REPAYMENT_FAMILIES } from "./refund-terms.js";
import { sanctionsScreenStatus } from "./sanctions-screen.js";
import { PAYER_SCREEN_RAILS, x402ScreenKey } from "./payer-screen-rails.js";
import { receiptsServed, SIGNED_RAILS, RECEIPT_HEADER, RECEIPT_KEYS_PATH, RECEIPT_SSE_COMMENT, RECEIPT_VERIFY_PATH, RECEIPT_URL_HEADER, RECEIPT_FETCH_PATH } from "./receipt-signing.js";
import { SETTLE_FIRST_SENTENCE } from "./settle-first-copy.js";

export { CONFORMANCE_PATH };
export const CONFORMANCE_VERSION = 1;
const TEMPO_CAIP2 = "eip155:4217";

/** The features, in column order. */
export const FEATURES = Object.freeze([
  { id: "settleAfterAnswer", title: "Settle after a successful answer", description: `An x402 payment is settled only after the route answered below 400; an error answer is not charged on x402 (a Tempo push transfer is final before the call; see its row). ${SETTLE_FIRST_SENTENCE}` },
  { id: "idempotencyKey", title: "Idempotency key", description: "An Idempotency-Key header bound to the credential, route and body replays a served answer without a second charge." },
  { id: "paymentIdentifier", title: "x402 payment-identifier", description: "The x402 payment-identifier extension is honored as an idempotency key under the same binding." },
  { id: "replayGuard", title: "Replay guard", description: "A credential already used, or in use, is refused before it can pay for a second run." },
  { id: "refundOnChargedFailure", title: "Refund on charged failure", description: "A charge that did not deliver is recorded as owed and repaid; `detail` says how." },
  { id: "hangupForgiveness", title: "Hang-up forgiveness", description: "A buyer whose connection closes before the first answer byte is not charged, within a budget." },
  { id: "sanctionsScreening", title: "Payer sanctions screening", description: "The paying address is checked against the OFAC SDN list before the paid handler runs; a payer not on the list is never refused by the screen. `identifier` names what the rail's screen reads, null where the rail carries no payer address." },
  { id: "receipt", title: "Receipt header", description: "A paid answer carries a receipt header naming the settlement." },
  { id: "signedReceipt", title: "Receipt signed by this server", description: "The paid answer carries a receipt this server signs over the request, the answer and the settlement, verifiable against its published keys." },
]);

/** The chain family a repayment is sent on for `network`, or null when the
 *  refund run has no sender for it (the same rule as scripts/refund-run.js
 *  familyOf; scripts/test-conformance.js checks they agree). */
export function repaymentFamilyOf(network) {
  const n = String(network || "");
  if (n === TEMPO_CAIP2) return "tempo";
  if (n.startsWith("eip155:")) return "evm";
  if (n.startsWith("solana:")) return "solana";
  if (n.startsWith("stellar:")) return "stellar";
  if (n.startsWith("algorand:")) return "algorand";
  return null;
}

const cell = (supported, detail, source) => ({ supported, detail, source });
// A sanctionsScreening cell names the identifier the rail's screen reads
// (src/payer-screen-rails.js PAYER_SCREEN_RAILS), null where none exists.
const screenCell = (supported, detail, key) => ({ ...cell(supported, detail, PAYER_SCREEN_RAILS[key]?.source || null), identifier: PAYER_SCREEN_RAILS[key]?.identifier ?? null });
const NO_PAYER_ADDRESS = (what) => `No payer address exists on this rail (${what}), so this server runs no screen of its own; the card processor screens the cardholder.`;
const NA = (detail) => cell(null, detail, null);

// A plain priced catalog route: no identity binding, no long run, no lasting
// effect, every network. Its accepts are what most of the catalog offers.
const PROBE_ROUTE = Object.freeze({ slug: "conformance-probe", price: "$0.01" });

function chainOf(caip2) {
  const r = [...RAILS, ...GATED_RAILS].find((x) => x.caip2 === caip2);
  return r ? { chain: r.name, asset: r.asset } : { chain: caip2 === TEMPO_CAIP2 ? "Tempo" : null, asset: null };
}

/** The switches and mounts the cells read, gathered once per document. */
function liveState() {
  const hang = hangupForgivenessConfig();
  return {
    rails: paymentRailsLive(),
    x402: gateMounted("x402"),
    payerScreen: gateMounted("x402PayerScreen"),
    // fresh | stale | missing: while no list is loaded the x402 screen fails
    // open (src/x402-payer-screen.js) and the cell says so.
    screenList: sanctionsScreenStatus(),
    replayGuard: gateMounted("replayGuard"),
    idempotency: gateMounted("idempotency"),
    hangupHook: gateMounted("hangupHook"),
    hangupOn: gateMounted("hangupHook") && hang.enabled,
    mppShim: gateMounted("mppShim") && mppShimEnabled(),
    tempo: gateMounted("tempo") && tempoEnabled(),
    tempoMode: tempoSettlementMode(),
    stripe: gateMounted("stripe") && stripeEnabled(),
    credits: gateMounted("credits"),
    checkout: humanCheckoutEnabled(),
    // Monitor subscriptions: by card (the Stripe key builds the engine) and
    // over MPP on Tempo (src/server.js marks it when the engine is built).
    cardSubscriptions: subscriptionsEnabled(),
    mppSubscriptions: gateMounted("mppSubscriptions"),
    pow: gateMounted("pow"),
    // Signed receipts: the signer is in the chain and a key is loaded.
    receiptSigner: receiptsServed(),
  };
}

const idemMinutes = Math.round(IDEM_TTL_MS / 60000);
function idempotencyCell(L, credential) {
  const on = L.idempotency && IDEMPOTENCY_CREDENTIALS.includes(credential);
  return on
    ? cell(true, `Idempotency-Key header; a repeat of the same credential, route and body within ${idemMinutes} minutes replays a served JSON answer (X-Idempotent-Replay: true).`, "src/idempotency.js")
    : cell(false, "An Idempotency-Key is not bound to this credential; a repeat is answered by the replay guard instead.", "src/idempotency.js");
}
function hangupCell(L, how) {
  return L.hangupOn
    ? cell(true, `${how} Within a per-wallet, per-IP and service-wide budget; a route whose effect outlives the answer is settled and the undelivered charge recorded as owed; refundOnChargedFailure says how it is repaid.`, "src/hangup-settlement.js")
    : cell(false, L.hangupHook ? "Off on this server (HANGUP_FORGIVE=off): a charge whose answer was not delivered is recorded as owed; refundOnChargedFailure says how it is repaid." : "No paid gate is mounted on this server.", "src/hangup-forgiveness.js");
}
function refundCell(network, how) {
  const family = repaymentFamilyOf(network);
  return family
    ? cell(true, `${how} recorded as owed in the refund ledger and repaid to the paying wallet on ${REPAYMENT_FAMILIES.find(([f]) => f === family)[1]}, after the payment is proven on chain.`, "src/refund-ledger.js")
    : cell(false, "A charge whose answer was not delivered is recorded as owed, but the refund run repays chain payments only and has no sender for this rail.", "scripts/refund-run.js");
}
const NOT_SIGNED = (header) => cell(false, `${header} is the settlement's own record; this server adds no signature of its own.`, null);
// True only where src/receipt-signing.js signs: the signer mounted with a key
// loaded, and the rail one it signs on.
function signedCell(L, rail, header) {
  return L.receiptSigner && SIGNED_RAILS.includes(rail)
    ? cell(true, `${RECEIPT_HEADER}: a compact JWS (EdDSA, Ed25519) this server signs over the route, the request digest, the answer's digest, the price, the rail, the payer and the settlement ${header} names, on a final 200 after settlement. ${STREAM_DELIVERY} Keys at ${RECEIPT_KEYS_PATH}.`, "src/receipt-signing.js")
    : NOT_SIGNED(header);
}
// How a streamed answer's receipt is delivered (src/receipt-signing.js).
const STREAM_DELIVERY = `An event-stream answer (text/event-stream) gets the receipt after its last byte, over every byte streamed, as a final \`: ${RECEIPT_SSE_COMMENT} <receipt>\` server-sent comment line, which event-stream parsers skip; a streamed answer to a request that sent TE: trailers on HTTP/1.1 gets it as an ${RECEIPT_HEADER} trailer. Every streamed answer's head names ${RECEIPT_URL_HEADER}, and GET ${RECEIPT_FETCH_PATH}/<settlement> answers the same receipt once the answer finished, so a stream that is neither still gets it.`;

function x402ScreenCell(L, key, evm) {
  if (!L.payerScreen) return screenCell(false, "The x402 payer screen is not mounted on this server.", key);
  if (L.screenList === "missing") return screenCell(false, "The x402 payer screen is mounted but no sanctions list is loaded right now, so it fails open: payers are served unscreened until the list loads.", key);
  if (key === "x402-batch-settlement") return screenCell(true, "The channel's payer (channelConfig.payer), the voucher signer it names and a Permit2 deposit's funder are checked after verification and before the route runs, on the deposit that opens or tops up the channel, on every voucher call and on a refund request; a listed payer is refused 403 and its channel is not charged. While no list is loaded the screen fails open (served unscreened).", key);
  return screenCell(true, evm ? "The signed EVM payer (authorization.from, or the Permit2 signer) is checked after verification and before the route runs; a listed payer is refused 403 and not charged. While no list is loaded the screen fails open (served unscreened)." : "The transaction's signers are checked after verification and before the route runs; a listed signer is refused 403 and not charged. While no list is loaded the screen fails open (served unscreened).", key);
}

function x402Row(L, { scheme, network, batched, offered }) {
  const { chain, asset } = chainOf(network);
  const kind = batched ? "gateway-batched" : scheme;
  const settle = batched
    ? cell(true, "Settled at Circle Gateway after the answer; an answer whose payment Gateway has not confirmed is withheld (402 settlement_pending) and served on the resend of the same payment.", "src/gateway-nanopayments.js")
    : cell(true, `The x402 paywall runs the route first and settles only an answer below 400; a 4xx or 5xx cancels settlement. ${SETTLE_FIRST_SENTENCE}`, "src/payments.js");
  return {
    id: `x402:${kind}:${network}`,
    protocol: "x402",
    scheme,
    kind,
    network,
    chain,
    asset,
    offered,
    features: {
      settleAfterAnswer: settle,
      idempotencyKey: idempotencyCell(L, "x402"),
      paymentIdentifier: L.idempotency && IDEMPOTENCY_CREDENTIALS.includes("x402")
        ? cell(true, "Declared on every 402; honored as an alias of Idempotency-Key, bound to the exact signed payment, route and body.", "src/idempotency.js")
        : cell(false, "Idempotency is not mounted on this server.", "src/idempotency.js"),
      replayGuard: L.replayGuard
        ? cell(true, "The payment's nonce (or the transaction it carries) is claimed before the route runs and held after it settles.", "src/replay-guard.js")
        : cell(false, "The x402 paywall is not mounted on this server.", "src/replay-guard.js"),
      refundOnChargedFailure: refundCell(network, batched ? "A Gateway payment settled for a request never served:" : "A charge that did not deliver:"),
      hangupForgiveness: hangupCell(L, "Settlement is aborted before any facilitator call (client_disconnected)."),
      sanctionsScreening: x402ScreenCell(L, x402ScreenKey(network, { batched, scheme }), network.startsWith("eip155:")),
      receipt: cell(true, "PAYMENT-RESPONSE: the settlement result, with the transaction.", "src/payments.js"),
      signedReceipt: signedCell(L, batched ? "gateway-batched" : "x402", "PAYMENT-RESPONSE"),
    },
  };
}

/** Test seam: one x402 row as conformanceRails builds it, with the screen mounted and a list loaded. */
export function __x402RowForTest(o, L = { payerScreen: true, screenList: "ok" }) { return x402Row(L, o); }

function mppEvmRow(L, network, offered) {
  const base = x402Row(L, { scheme: "exact", network, batched: false, offered });
  return {
    ...base,
    id: `mpp:evm:${network}`,
    protocol: "mpp",
    scheme: "evm",
    kind: "evm",
    features: {
      ...base.features,
      settleAfterAnswer: cell(true, "Translated onto the x402 paywall, which settles only an answer below 400.", "src/mpp-shim.js"),
      paymentIdentifier: NA("An x402 extension; an MPP credential carries none."),
      sanctionsScreening: x402ScreenCell(L, "mpp-evm", true),
      receipt: cell(true, "Payment-Receipt, mirrored from the x402 settlement result.", "src/mpp-shim.js"),
      signedReceipt: signedCell(L, "mpp-evm", "Payment-Receipt"),
    },
  };
}

function tempoRow(L, push) {
  const screened = L.tempoMode === "direct";
  return {
    id: `mpp:tempo:${push ? "push" : "pull"}`,
    protocol: "mpp",
    scheme: "tempo",
    kind: push ? "push" : "pull",
    network: TEMPO_CAIP2,
    ...chainOf(TEMPO_CAIP2),
    offered: L.tempo,
    features: {
      settleAfterAnswer: push
        ? cell(false, "A push credential names a transfer already final before the route runs; if the route then fails, the amount is recorded as owed; refundOnChargedFailure says how it is repaid.", "src/mpp-tempo.js")
        : cell(true, "The signed transaction is broadcast only after the route answered below 400.", "src/mpp-tempo.js"),
      idempotencyKey: idempotencyCell(L, "mpp-tempo"),
      paymentIdentifier: NA("An x402 extension; an MPP credential carries none."),
      replayGuard: L.tempo
        ? cell(true, push ? "The transfer's hash is claimed once; a second request naming it is refused." : "The credential is claimed before the route runs and held after it is broadcast.", "src/mpp-tempo.js")
        : cell(false, "The Tempo gate is not mounted on this server.", "src/mpp-tempo.js"),
      refundOnChargedFailure: refundCell(TEMPO_CAIP2, push ? "A transfer whose route failed, or whose answer was not delivered:" : "A charge that did not deliver:"),
      hangupForgiveness: push
        ? cell(false, "The transfer is final before the route runs; an answer not delivered is recorded as owed; refundOnChargedFailure says how it is repaid.", "src/hangup-settlement.js")
        : hangupCell(L, "The transaction is not broadcast (499, nothing spent)."),
      sanctionsScreening: screened
        ? screenCell(true, "Direct settlement (TEMPO_RELAY=off) checks every payment party, and the paying wallet's recent funders, before any money moves; no Tempo challenge is offered while the list is not loaded.", "mpp-tempo-direct")
        : L.screenList === "missing"
        ? screenCell(false, "Settled through Tempo's relay (the default): the payer screen is in place but no sanctions list is loaded right now, so it fails open: payers are served unscreened until the list loads.", "mpp-tempo-relay")
        : screenCell(true, `Settled through Tempo's relay (the default): the paying wallet the credential names is checked before the relay is asked, and the sender the relay settled on after it answers; a listed payer is refused before the route runs${push ? " (its transfer is not claimed for the request)" : ", and nothing is broadcast or charged"}. While no list is loaded the screen fails open (served unscreened).`, "mpp-tempo-relay"),
      receipt: cell(true, "Payment-Receipt, naming the Tempo transaction.", "src/mpp-receipt.js"),
      signedReceipt: signedCell(L, "mpp-tempo", "Payment-Receipt"),
    },
  };
}

function stripeRow(L) {
  return {
    id: "mpp:stripe", protocol: "mpp", scheme: "stripe", kind: "card", network: null, chain: null, asset: "USD", offered: L.stripe,
    features: {
      settleAfterAnswer: cell(true, "The card payment is captured only after the route answered below 400.", "src/mpp-stripe.js"),
      idempotencyKey: idempotencyCell(L, "mpp-stripe"),
      paymentIdentifier: NA("An x402 extension; an MPP credential carries none."),
      replayGuard: L.stripe ? cell(true, "Each challenge and payment token is claimed once.", "src/mpp-stripe.js") : cell(false, "The card gate is not mounted on this server.", "src/mpp-stripe.js"),
      refundOnChargedFailure: refundCell("stripe", ""),
      hangupForgiveness: hangupCell(L, "The payment is not captured (499, not charged)."),
      sanctionsScreening: screenCell(false, NO_PAYER_ADDRESS("a card payment"), "mpp-stripe"),
      receipt: cell(true, "Payment-Receipt, naming the Stripe payment.", "src/mpp-receipt.js"),
      signedReceipt: signedCell(L, "mpp-stripe", "Payment-Receipt"),
    },
  };
}

function creditsRow(L) {
  return {
    id: "credits", protocol: "credits", scheme: "bearer-key", kind: "prepaid", network: null, chain: null, asset: "USD", offered: L.credits, onSale: creditsSalesEnabled(),
    features: {
      settleAfterAnswer: cell(true, "The price is held when the call starts and debited only on a final 200; any other answer releases the hold.", "src/credits.js"),
      idempotencyKey: idempotencyCell(L, "credits"),
      paymentIdentifier: NA("An x402 extension; a credits call carries none."),
      replayGuard: NA("A credits key is reusable by design; each call holds its own price."),
      refundOnChargedFailure: NA("A call that fails is not debited, so nothing is owed."),
      hangupForgiveness: hangupCell(L, "The hold is released when the abandoned answer ends."),
      sanctionsScreening: screenCell(false, NO_PAYER_ADDRESS("a prepaid key bought by card"), "credits"),
      receipt: cell(false, "The answer carries X-Credits-Balance, the key's balance; there is no per-call receipt header.", "src/credits.js"),
      signedReceipt: L.receiptSigner && SIGNED_RAILS.includes("credits")
        ? cell(true, `${RECEIPT_HEADER}: a compact JWS (EdDSA, Ed25519) this server signs over the route, the request digest, the answer's digest, the amount debited, the key's id (never the key) and the debit's id, on a final 200 whose debit landed before the answer ended. ${STREAM_DELIVERY} Keys at ${RECEIPT_KEYS_PATH}.`, "src/credits.js")
        : cell(false, "No per-call receipt.", null),
    },
  };
}

function checkoutRow(L) {
  return {
    id: "card:checkout", protocol: "card", scheme: "stripe-checkout", kind: "report", network: null, chain: null, asset: "USD", offered: L.checkout,
    features: {
      settleAfterAnswer: cell(false, "A report is paid at checkout, before it is generated.", "src/human-checkout.js"),
      idempotencyKey: NA("A checkout session is the unit of purchase."),
      paymentIdentifier: NA("An x402 extension; a checkout carries none."),
      replayGuard: cell(true, "A report is generated once per paid, Stripe-verified session.", "src/human-checkout.js"),
      refundOnChargedFailure: cell(true, "A report whose generation fails is refunded to the card automatically.", "src/human-checkout.js"),
      hangupForgiveness: NA("The report is delivered by link and email, not on the paying connection."),
      sanctionsScreening: screenCell(false, NO_PAYER_ADDRESS("a card checkout"), "card-checkout"),
      receipt: cell(false, "No receipt header; the report link is the delivery.", null),
      signedReceipt: L.receiptSigner && SIGNED_RAILS.includes("card-checkout")
        ? cell(true, `A compact JWS (EdDSA, Ed25519) this server signs at delivery over the checkout (product and input), the report's text, the amount collected and the payment intent, shown on the report page and in the delivery email; checked at ${RECEIPT_VERIFY_PATH} against the keys at ${RECEIPT_KEYS_PATH}. A purchase that paid nothing (a 100% promotion code) gets none.`, "src/human-checkout.js")
        : cell(false, "No receipt header.", null),
    },
  };
}

// A monitor subscription's paid period receipt (src/receipt-signing.js
// createSubscriptionReceipt), per subscription rail.
function subscriptionSignedCell(L, rail, settlement, source) {
  return L.receiptSigner && SIGNED_RAILS.includes(rail)
    ? cell(true, `A compact JWS (EdDSA, Ed25519) this server signs for each paid period, the first and every renewal, once its payment is final: over the subscribe call (product, target and subscription), a period statement (the subscription, product, target, period, settlement and amount), the amount paid and ${settlement}. Kept on the subscription and shown with its period statement ${rail === "card-subscription" ? "on the confirmation page" : "in the subscribe answer and on the subscription's status link"} and in each monitor email after that payment; checked at ${RECEIPT_VERIFY_PATH} against the keys at ${RECEIPT_KEYS_PATH}.${rail === "card-subscription" ? " A period that paid nothing (a 100% promotion code) gets none." : ""}`, source)
    : cell(false, "No receipt signed by this server.", null);
}
const PREPAID_MONTH = "A monitor bills monthly in advance: each period is paid before that period's reports run.";

function cardSubscriptionRow(L) {
  return {
    id: "card:subscription", protocol: "card", scheme: "stripe-subscription", kind: "monitor", network: null, chain: null, asset: "USD", offered: L.cardSubscriptions,
    features: {
      settleAfterAnswer: cell(false, PREPAID_MONTH, "src/stripe-subscriptions.js"),
      idempotencyKey: NA("A paid invoice is the unit of payment."),
      paymentIdentifier: NA("An x402 extension; a card subscription carries none."),
      replayGuard: cell(true, "Each paid invoice is booked once, by its invoice id, across redelivered webhook events and restarts.", "src/stripe-subscriptions.js"),
      refundOnChargedFailure: cell(false, "A paid month is not refunded automatically: a subject that cannot be read keeps its free daily check and runs no further paid reports, and canceling stops the next renewal.", "src/monitor-scheduler.js"),
      hangupForgiveness: NA("Reports are delivered by link and email, not on the paying connection."),
      sanctionsScreening: screenCell(false, NO_PAYER_ADDRESS("a card subscription"), "card-subscription"),
      receipt: cell(false, "No receipt header; the Stripe invoice is the payment's record.", null),
      signedReceipt: subscriptionSignedCell(L, "card-subscription", "the paid invoice's id", "src/stripe-subscriptions.js"),
    },
  };
}

function mppSubscriptionRow(L) {
  const key = "mpp-subscription";
  return {
    id: "mpp:subscription", protocol: "mpp", scheme: "tempo-subscription", kind: "monitor", network: TEMPO_CAIP2, ...chainOf(TEMPO_CAIP2), offered: L.mppSubscriptions,
    features: {
      settleAfterAnswer: cell(false, `${PREPAID_MONTH} The first period's transfer is confirmed before the subscription starts, and each renewal is pulled before its period's reports run.`, "src/mpp-subscriptions.js"),
      idempotencyKey: NA("A signed subscription authorization is the unit of payment."),
      paymentIdentifier: NA("An x402 extension; an MPP credential carries none."),
      replayGuard: cell(true, "Each challenge names an access key minted for one offer, and a period is charged once: a renewal whose send timed out is looked up on chain before any new transfer.", "src/mpp-subscriptions.js"),
      refundOnChargedFailure: refundCell(TEMPO_CAIP2, "A first payment that settled without starting its subscription is"),
      hangupForgiveness: NA("Reports are delivered by link and email, not on the paying connection."),
      sanctionsScreening: L.screenList === "missing"
        ? screenCell(false, "The subscription payer screen is in place but no sanctions list is loaded right now, so it fails open: payments are sent unscreened until the list loads.", key)
        : screenCell(true, "The paying wallet, and its recent funders, are checked before the first payment and before every renewal; a refused wallet is sent nothing, and a renewal refused this way ends the subscription. While no list is loaded the screen fails open (sent unscreened).", key),
      receipt: cell(true, "Payment-Receipt on the subscribe answer, naming the first period's Tempo transaction; the latest renewal's transaction is on the subscription's status link.", "src/mpp-subscriptions.js"),
      signedReceipt: subscriptionSignedCell(L, "mpp-subscription", "the confirmed transfer's transaction hash", "src/mpp-subscriptions.js"),
    },
  };
}

function powRow(L) {
  return {
    id: "pow", protocol: "pow", scheme: "proof-of-work", kind: "free", network: null, chain: null, asset: null, offered: L.pow,
    features: {
      settleAfterAnswer: NA("Nothing is charged."),
      idempotencyKey: idempotencyCell(L, "pow"),
      paymentIdentifier: NA("An x402 extension; a solved challenge carries none."),
      replayGuard: L.pow ? cell(true, "Each solved challenge is redeemed once.", "src/pow.js") : cell(false, "The proof-of-work gate is not mounted on this server.", "src/pow.js"),
      refundOnChargedFailure: NA("Nothing is charged."),
      hangupForgiveness: NA("Nothing is charged."),
      sanctionsScreening: NA("No payment is made."),
      receipt: NA("No payment is made."),
      signedReceipt: NA("No payment is made."),
    },
  };
}

/** Every rail row, from the live offer and mounts. */
export function conformanceRails(L = liveState()) {
  const accepts = L.x402 && L.rails ? acceptsForItem(PROBE_ROUTE, L.rails) : [];
  const offered = accepts.map((a) => ({ scheme: a.scheme, network: a.network, batched: isGatewayBatchedPayment(a) }));
  const rows = [];
  const seen = new Set();
  const add = (r) => { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } };
  // Every listed chain has an exact row, in listing order; then each further
  // offered accept (upto, batched, a gated rail) in the 402's own order.
  for (const r of RAILS) add(x402Row(L, { scheme: "exact", network: r.caip2, batched: false, offered: offered.some((o) => o.network === r.caip2 && o.scheme === "exact" && !o.batched) }));
  for (const o of offered) add(x402Row(L, { ...o, offered: true }));
  const exactOffered = new Set(offered.filter((o) => o.scheme === "exact" && !o.batched).map((o) => o.network));
  for (const r of RAILS) {
    if (typeof r.chainId === "number" && challengeEnabledForChain(r.chainId)) add(mppEvmRow(L, r.caip2, L.mppShim && exactOffered.has(r.caip2)));
  }
  add(tempoRow(L, false));
  add(tempoRow(L, true));
  add(stripeRow(L));
  add(creditsRow(L));
  add(checkoutRow(L));
  add(cardSubscriptionRow(L));
  add(mppSubscriptionRow(L));
  add(powRow(L));
  return rows;
}

/** The refund terms as data: the clauses /terms prints, word for word. */
export function refundTermsDocument(baseUrl = "") {
  return {
    terms: `${baseUrl}/terms`,
    termsVersion: TERMS_VERSION,
    governs: "The terms of service govern; this copy states the same clauses as data.",
    // The same terms per rail, with the switches they read (src/refund-terms-doc.js).
    perRail: `${baseUrl}${REFUND_TERMS_PATH}`,
    clauses: refundClauses({ gatewayBatched: !!gatewayOfferPublic() }),
  };
}

export function conformanceDocument(baseUrl = "", { freeMode = false } = {}) {
  return {
    document: "agent402-conformance",
    version: CONFORMANCE_VERSION,
    url: `${baseUrl}${CONFORMANCE_PATH}`,
    generatedAt: new Date().toISOString(),
    // FREE_MODE answers every tool without payment, so every rail (proof of
    // work included) reads offered:false; this flag says why.
    freeMode: !!freeMode,
    legend: { supported: "true: implemented on this rail; false: not implemented; null: does not apply to this rail", offered: "true while this server accepts payment on the rail", freeMode: "true when this server answers every tool without payment or proof of work, so no rail is offered" },
    features: FEATURES,
    rails: conformanceRails(),
    refundTerms: refundTermsDocument(baseUrl),
  };
}

// The document is built once per CONFORMANCE_CACHE_MS (the gates are fixed
// once the server listens; a rail dropped by the boot check or a list that
// loads shows within the window, and the list status is part of the key).
// src/server.js clears it when the server starts listening.
export const CONFORMANCE_CACHE_MS = 60_000;
let docCache = null; // { key, at, value }
export function resetConformanceCache() { docCache = null; }
export function conformanceDocumentCached(baseUrl = "", { freeMode = false, now = Date.now() } = {}) {
  const key = `${baseUrl}|${!!freeMode}|${sanctionsScreenStatus(now)}`;
  if (docCache && docCache.key === key && now - docCache.at >= 0 && now - docCache.at < CONFORMANCE_CACHE_MS) return docCache.value;
  const value = conformanceDocument(baseUrl, { freeMode });
  docCache = { key, at: now, value };
  return value;
}
