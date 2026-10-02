// The MPP methods this instance offers, in the order its 402 lists them.
//
// ONE description of the MPP offer, read by every surface that publishes it
// (/openapi.json x-payment-info, /llms.txt, /.well-known/x402), so none of
// them can promise a method, chain or currency the live 402 does not carry,
// or list them in a different order. The live 402 is assembled by three
// middlewares (src/mpp-tempo.js, src/mpp-stripe.js, src/mpp-shim.js); each
// helper here reads the SAME predicate and env its middleware reads:
//
//   1. tempo/charge - one challenge per TEMPO_CURRENCY entry, listed first
//      (tempoLeads), withheld on identity-bound and long-running routes
//      (tempoOfferedFor).
//   2. evm/charge - one challenge per EVM rail that is both accepted
//      (PAYMENT_NETWORKS) and challenge-enabled (MPP_CHALLENGE_NETWORKS).
//   3. stripe/charge - on routes whose price clears the card minimum, never
//      on identity-bound routes.
//
// A client whose tempo credential the relay just refused sees evm first for a
// while (src/mpp-tempo.js tempoLeads); discovery documents the default order.

import { tempoDiscoveryInfo, tempoOfferedFor, TEMPO_USDC_E_ADDRESS } from "./mpp-tempo.js";
import { mppEvmDiscoveryRails } from "./mpp-shim.js";
import { stripeDiscoveryInfo } from "./mpp-stripe.js";

const PATH_USD_LC = "0x20c0000000000000000000000000000000000000";

/** A readable name for a Tempo TIP-20 currency address. */
export function tempoCurrencyLabel(address) {
  const a = String(address || "").toLowerCase();
  if (a === TEMPO_USDC_E_ADDRESS.toLowerCase()) return "USDC.e";
  if (a === PATH_USD_LC) return "PathUSD";
  return String(address || "");
}

/** Ordered MPP offers for one route, as its 402 would list them.
 *  item: { priceUsd, identityBound, longRunning }. Each entry:
 *  { method, intent, currency, decimals, chainId?, description }. */
export function mppOffersFor(item = {}) {
  const out = [];
  const tempo = tempoOfferedFor(item) ? tempoDiscoveryInfo() : null;
  if (tempo) {
    for (const currency of tempo.currencies) {
      out.push({ method: "tempo", intent: "charge", currency, decimals: tempo.decimals, chainId: 4217, rail: "Tempo", description: `${tempoCurrencyLabel(currency)} on Tempo` });
    }
  }
  for (const r of mppEvmDiscoveryRails()) {
    out.push({ method: "evm", intent: "charge", currency: r.currency, decimals: 6, chainId: r.chainId, rail: r.name, description: `${r.asset} on ${r.name}` });
  }
  const stripe = stripeDiscoveryInfo();
  if (stripe && !item.identityBound && Number(item.priceUsd) >= stripe.minUsd) {
    out.push({ method: "stripe", intent: "charge", currency: "usd", decimals: 2, rail: "card", description: "Card via Stripe" });
  }
  return out;
}

/** The places one route's MPP offers settle, in 402 order, as prose
 *  ("Tempo, Base or Celo"); "" when the route carries no MPP offer. Read from
 *  mppOffersFor, so the phrase names exactly what that route's 402 lists. */
export function mppRailsPhrase(offers) {
  const rails = [];
  for (const o of offers || []) if (o.rail && !rails.includes(o.rail)) rails.push(o.rail);
  return listOr(rails);
}

/** Instance-wide summary of the MPP offer, for prose and manifests. */
export function mppMethodsSummary() {
  const tempo = tempoDiscoveryInfo();
  const evm = mppEvmDiscoveryRails();
  const stripe = stripeDiscoveryInfo();
  return {
    enabled: !!(tempo || evm.length || stripe),
    order: [...(tempo ? ["tempo"] : []), ...(evm.length ? ["evm"] : []), ...(stripe ? ["stripe"] : [])],
    tempo: tempo ? { currencies: tempo.currencies.map((c) => ({ address: c, label: tempoCurrencyLabel(c) })), chainId: 4217, withheldOn: ["identity-bound routes", "long-running routes"] } : null,
    evm: evm.length ? { rails: evm.map((r) => ({ chain: r.name, chainId: r.chainId, asset: r.asset, currency: r.currency })) } : null,
    stripe: stripe ? { minUsd: stripe.minUsd } : null,
  };
}

const listOr = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/** One sentence naming the methods in 402 order, e.g.
 *  "tempo/charge (USDC.e or PathUSD on Tempo), then evm/charge (USDC on Base or Celo)". */
export function mppMethodsProse() {
  const s = mppMethodsSummary();
  if (!s.enabled) return "";
  const parts = [];
  if (s.tempo) parts.push(`\`tempo\` charge (${listOr(s.tempo.currencies.map((c) => c.label))} on Tempo, settled natively via Tempo's own relay; not offered on identity-bound or long-running routes)`);
  if (s.evm) parts.push(`\`evm\` charge (USDC on ${listOr(s.evm.rails.map((r) => r.chain))}, EIP-3009, settles on-chain identically to x402)`);
  if (s.stripe) parts.push(`\`stripe\` charge (card, on routes priced $${s.stripe.minUsd.toFixed(2)} or more)`);
  return parts.join(", then ");
}

/** Short, instance-wide phrase for what MPP settles in, in 402 order, e.g.
 *  "USDC.e or PathUSD natively on Tempo, or USDC on Base or Celo"; "" when no
 *  MPP method is on. Same summary every other surface reads. */
export function mppOfferShortProse() {
  const s = mppMethodsSummary();
  if (!s.enabled) return "";
  const parts = [];
  if (s.tempo) parts.push(`${listOr(s.tempo.currencies.map((c) => c.label))} natively on Tempo`);
  if (s.evm) parts.push(`USDC on ${listOr(s.evm.rails.map((r) => r.chain))}`);
  if (s.stripe) parts.push(`a card on routes priced $${s.stripe.minUsd.toFixed(2)} or more`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
}
