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
import { RAILS, GATED_RAILS } from "./rails.js";
import { paymentRailsLive, acceptsForItem } from "./payments.js";
import { isGatewayBatchedPayment } from "./gateway-wire.js";
import { gateMounted } from "./gate-mounts.js";
import { mppShimEnabled, challengeEnabledForChain } from "./mpp-shim.js";
import { tempoEnabled, tempoSettlementMode } from "./mpp-tempo.js";
import { stripeEnabled } from "./mpp-stripe.js";
import { humanCheckoutEnabled } from "./human-checkout.js";
import { creditsSalesEnabled, TERMS_VERSION } from "./credits-sales.js";
import { hangupForgivenessConfig } from "./hangup-forgiveness.js";
import { IDEM_TTL_MS } from "./idempotency-store.js";
import { IDEMPOTENCY_CREDENTIALS } from "./idempotency.js";
import { gatewayOfferPublic } from "./gateway-nanopayments.js";
import { refundClauses, REPAYMENT_FAMILIES } from "./refund-terms.js";

export { CONFORMANCE_PATH };
export const CONFORMANCE_VERSION = 1;
const TEMPO_CAIP2 = "eip155:4217";

/** The features, in column order. */
export const FEATURES = Object.freeze([
  { id: "settleAfterAnswer", title: "Settle after a successful answer", description: "The payment is settled only after the route answered below 400; an error answer is not charged." },
  { id: "idempotencyKey", title: "Idempotency key", description: "An Idempotency-Key header bound to the credential, route and body replays a served answer without a second charge." },
  { id: "paymentIdentifier", title: "x402 payment-identifier", description: "The x402 payment-identifier extension is honored as an idempotency key under the same binding." },
  { id: "replayGuard", title: "Replay guard", description: "A credential already used, or in use, is refused before it can pay for a second run." },
  { id: "refundOnChargedFailure", title: "Refund on charged failure", description: "A charge that did not deliver is recorded as owed and repaid; `detail` says how." },
  { id: "hangupForgiveness", title: "Hang-up forgiveness", description: "A buyer whose connection closes before the first answer byte is not charged, within a budget." },
  { id: "sanctionsScreening", title: "Payer sanctions screening", description: "The paying address is checked against the OFAC SDN list before the paid handler runs." },
  { id: "receipt", title: "Receipt header", description: "A paid answer carries a receipt header naming the settlement." },
  { id: "signedReceipt", title: "Receipt signed by this server", description: "The receipt carries a signature by this server over the answer." },
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
    pow: gateMounted("pow"),
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
    ? cell(true, `${how} Within a per-wallet, per-IP and service-wide budget; a route whose effect outlives the answer is settled and the undelivered charge recorded as owed.`, "src/hangup-settlement.js")
    : cell(false, L.hangupHook ? "Off on this server (HANGUP_FORGIVE=off): a charge whose answer was not delivered is recorded as owed." : "No paid gate is mounted on this server.", "src/hangup-forgiveness.js");
}
function refundCell(network, how) {
  const family = repaymentFamilyOf(network);
  return family
    ? cell(true, `${how} recorded as owed in the refund ledger and repaid to the paying wallet on ${REPAYMENT_FAMILIES.find(([f]) => f === family)[1]}, after the payment is proven on chain.`, "src/refund-ledger.js")
    : cell(false, "A charge whose answer was not delivered is recorded as owed, but the refund run repays chain payments only and has no sender for this rail.", "scripts/refund-run.js");
}
const NOT_SIGNED = (header) => cell(false, `${header} is the settlement's own record; this server adds no signature of its own.`, null);

function x402Row(L, { scheme, network, batched, offered }) {
  const { chain, asset } = chainOf(network);
  const kind = batched ? "gateway-batched" : scheme;
  const settle = batched
    ? cell(true, "Settled at Circle Gateway after the answer; an answer whose payment Gateway has not confirmed is withheld (402 settlement_pending) and served on the resend of the same payment.", "src/gateway-nanopayments.js")
    : cell(true, "The paywall runs the route first and settles only an answer below 400; a 4xx or 5xx cancels settlement.", "src/payments.js");
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
      sanctionsScreening: L.payerScreen
        ? cell(true, network.startsWith("eip155:") ? "The signed EVM payer (authorization.from, or the Permit2 signer) is checked after verification and before the route runs; a listed payer is refused 403 and not charged." : "The transaction's signers are checked after verification and before the route runs; a listed signer is refused 403 and not charged.", "src/x402-payer-screen.js")
        : cell(false, "The x402 payer screen is not mounted on this server.", "src/x402-payer-screen.js"),
      receipt: cell(true, "PAYMENT-RESPONSE: the settlement result, with the transaction.", "src/payments.js"),
      signedReceipt: NOT_SIGNED("PAYMENT-RESPONSE"),
    },
  };
}

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
      receipt: cell(true, "Payment-Receipt, mirrored from the x402 settlement result.", "src/mpp-shim.js"),
      signedReceipt: NOT_SIGNED("Payment-Receipt"),
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
        ? cell(false, "A push credential names a transfer already final before the route runs; if the route then fails, the amount is recorded as owed.", "src/mpp-tempo.js")
        : cell(true, "The signed transaction is broadcast only after the route answered below 400.", "src/mpp-tempo.js"),
      idempotencyKey: idempotencyCell(L, "mpp-tempo"),
      paymentIdentifier: NA("An x402 extension; an MPP credential carries none."),
      replayGuard: L.tempo
        ? cell(true, push ? "The transfer's hash is claimed once; a second request naming it is refused." : "The credential is claimed before the route runs and held after it is broadcast.", "src/mpp-tempo.js")
        : cell(false, "The Tempo gate is not mounted on this server.", "src/mpp-tempo.js"),
      refundOnChargedFailure: refundCell(TEMPO_CAIP2, push ? "A transfer whose route failed, or whose answer was not delivered:" : "A charge that did not deliver:"),
      hangupForgiveness: push
        ? cell(false, "The transfer is final before the route runs; an answer not delivered is recorded as owed.", "src/hangup-settlement.js")
        : hangupCell(L, "The transaction is not broadcast (499, nothing spent)."),
      sanctionsScreening: screened
        ? cell(true, "Direct settlement (TEMPO_RELAY=off) checks every payment party, and the paying wallet's recent funders, before any money moves; no Tempo challenge is offered while the list is not loaded.", "src/mpp-tempo.js")
        : cell(false, "Settled through Tempo's relay (the default); this server does not screen Tempo payment parties in that mode.", "src/mpp-tempo.js"),
      receipt: cell(true, "Payment-Receipt, naming the Tempo transaction.", "src/mpp-receipt.js"),
      signedReceipt: NOT_SIGNED("Payment-Receipt"),
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
      sanctionsScreening: cell(false, "This server runs no screen of its own on a card payment.", null),
      receipt: cell(true, "Payment-Receipt, naming the Stripe payment.", "src/mpp-receipt.js"),
      signedReceipt: NOT_SIGNED("Payment-Receipt"),
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
      sanctionsScreening: cell(false, "This server runs no screen of its own on a credits call.", null),
      receipt: cell(false, "The answer carries X-Credits-Balance, the key's balance; there is no per-call receipt header.", "src/credits.js"),
      signedReceipt: cell(false, "No per-call receipt.", null),
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
      sanctionsScreening: cell(false, "This server runs no screen of its own on a card checkout.", null),
      receipt: cell(false, "No receipt header; the report link is the delivery.", null),
      signedReceipt: cell(false, "No receipt header.", null),
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
  add(powRow(L));
  return rows;
}

/** The refund terms as data: the clauses /terms prints, word for word. */
export function refundTermsDocument(baseUrl = "") {
  return {
    terms: `${baseUrl}/terms`,
    termsVersion: TERMS_VERSION,
    governs: "The terms of service govern; this copy states the same clauses as data.",
    clauses: refundClauses({ gatewayBatched: !!gatewayOfferPublic() }),
  };
}

export function conformanceDocument(baseUrl = "") {
  return {
    document: "agent402-conformance",
    version: CONFORMANCE_VERSION,
    url: `${baseUrl}${CONFORMANCE_PATH}`,
    generatedAt: new Date().toISOString(),
    legend: { supported: "true: implemented on this rail; false: not implemented; null: does not apply to this rail", offered: "true while this server accepts payment on the rail" },
    features: FEATURES,
    rails: conformanceRails(),
    refundTerms: refundTermsDocument(baseUrl),
  };
}
