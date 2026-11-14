// What a route refusal's `error` reads as for each payer class, composed the
// way the server composes it: the route binder first (server.js
// withPushException), then, for a push payer whose transfer was claimed, the
// send wrapper the Tempo gate installs (src/push-refusal-body.js).
import { withPushExceptionText } from "../../src/prepayment-refusal.js";
import { pushRefusalBody, PUSH_FAILURE_NOTE } from "../../src/push-refusal-body.js";
import { NOT_CHARGED } from "../../src/not-charged.js";

/** payer: "other" (x402, MPP evm, card, credits, unpaid), "push-unclaimed"
 *  (a push credential refused before its transfer was claimed) or "push"
 *  (a claimed push transfer). */
export function renderRefusal(message, payer) {
  const bound = withPushExceptionText(message, payer !== "other");
  if (payer !== "push") return bound;
  return JSON.parse(pushRefusalBody(JSON.stringify({ error: bound }))).error;
}

/** The text a claimed push payer must read for a message that carries the
 *  shared sentence: that sentence replaced whole by the owed note. */
export const expectedForPush = (message) => message.split(NOT_CHARGED).join(PUSH_FAILURE_NOTE);

/** Why a rendered refusal is malformed, or null: a clause said twice, a
 *  sentence that starts in lower case, or a claim left standing. */
export function malformed(text, payer) {
  if ((text.match(/\bowed\b/g) || []).length > 1) return "says \"owed\" twice";
  if (/[.!?] [a-z]/.test(text)) return "a sentence starts in lower case";
  if (payer === "push" && /nothing was charged|not charged/i.test(text)) return "a claimed push payer is told nothing was charged";
  if (payer === "push" && !text.includes(PUSH_FAILURE_NOTE)) return "the owed note is missing";
  return null;
}
