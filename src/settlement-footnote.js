// The one sentence a page says about a paid call that fails, shared by every
// tool page and every integration page so the copies cannot drift apart.
//
// Scoped per rail on purpose (CLAUDE.md "x402 settlement ordering"): x402, MPP
// evm, a Tempo charge credential and a card settle only after an answer under
// 400, and a credits key is debited only on a 200, so on those a failure is
// not charged. A Tempo PUSH credential is a transfer already final before the
// tool runs (src/mpp-tempo.js), so a failure there is a refund owed
// (src/tempo-push-debts.js), not a canceled charge; the exception sentence is
// added wherever that credential is offered. scripts/test-copy-absolutes.js
// refuses any unscoped "not charged".

const listWords = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

export const TEMPO_PUSH_EXCEPTION = "The exception is a Tempo push credential, a transfer the buyer sent before the call: it settles before the tool runs, so if the tool then fails the payment is recorded as a refund owed to the paying wallet.";

/** Plain text (no markup), safe to escape or to drop into HTML as is.
 *  `rails`: the payment paths the page's call takes, x402 first.
 *  `tempoPush`: true where a Tempo push credential is offered. */
export function failedCallFootnote({ rails = ["x402"], tempoPush = false } = {}) {
  const list = (Array.isArray(rails) && rails.length ? rails : ["x402"]);
  return `A paid call that ends in any status of 400 or above is not charged over ${listWords(list)}: settlement runs after the tool and only on a successful response.${tempoPush ? ` ${TEMPO_PUSH_EXCEPTION}` : ""}`;
}
