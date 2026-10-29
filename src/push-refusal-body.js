// What a failed call tells a Tempo PUSH payer.
//
// A handler's refusal says "not charged" because on x402, MPP evm, card and
// credits settlement runs after the handler and a status of 400 or above
// cancels it. A Tempo push credential is the exception: the transfer was on
// chain before the request arrived, the gate claimed it before the handler
// ran (src/mpp-tempo.js), and a handler answer of 400 or above is booked as
// a refund owed to the sender (server.js, src/tempo-push-debts.js). The
// sentence is true for every other rail, so it stays in the handlers; for a
// push credential the gate installs this wrapper on the response, and a JSON
// body of 400 or above goes out with that sentence rewritten and the fields
// a client reads (charged, transferClaimed, refundOwed, payment) set.
//
// Only a JSON object body sent before the headers went out is touched; a
// stream, HTML, a Buffer or a 2xx goes out byte-identical. A claim the refund
// run already holds (req.tempoPushRefunded) is answered by server.js with its
// own refunded body and is never rewritten. It never throws: any failure
// sends the original body.

/** The sentence a push payer reads in place of "not charged". */
const NOTE_BODY = "The Tempo transfer this credential names was claimed before the call ran, so this failure is recorded as a refund owed to the sending wallet; a retry is a new payment";
export const PUSH_FAILURE_NOTE = `${NOTE_BODY}.`;

// A whole sentence that says nothing was charged. Replaced by the note, with
// the sentence's own terminator kept ("; resend ..." stays a clause).
const STANDALONE = /(?:Nothing (?:was|is|has been) (?:spent and nothing is )?charged(?: for this (?:request|call)| to you| yet)?|You (?:were|are) not charged|Not charged)((?: (?:on|over) (?:x402|evm|the evm (?:path|method)))?)(?=[.;!]|\s*$|\s*[-(])([.;!]?)/g;
// The same claim inside a sentence ("so nothing was charged", "is not
// charged", "- not charged; retry shortly"). Replaced in place.
const CLAUSE = [
  [/\bnothing (?:was|is|has been) charged\b/gi, "the transfer you sent is recorded as owed"],
  [/\b(is|are|was|were|be) (?:not|never) charged\b/gi, "$1 owed a refund"],
  [/\b(?:not|never) charged\b/gi, "a refund is owed"],
  [/\bno charge\b/gi, "a refund owed"],
];
// A sentence already scoped to another rail stays as written.
const SCOPED = /\b(?:on|over) (?:x402|evm|card|credits)\b/i;

/** The text with every "not charged" claim restated for a push payer.
 *  Unchanged text is returned as is. */
export function rewriteNotChargedForPush(text) {
  if (typeof text !== "string" || !/charged?\b/i.test(text)) return text;
  let out = text.replace(STANDALONE, (m, scope, term) => (scope ? m : `${NOTE_BODY}${term}`));
  // Clause forms are rewritten sentence by sentence, so a scoped sentence
  // ("not charged on x402") is left alone while an unscoped one changes.
  out = out.split(/(?<=[.;!?])\s+/).map((sentence) => {
    if (SCOPED.test(sentence) || sentence.includes(PUSH_FAILURE_NOTE)) return sentence;
    let s = sentence;
    for (const [re, to] of CLAUSE) s = s.replace(re, to);
    return s;
  }).join(" ");
  return out;
}

/** True when the text makes a "not charged" claim this module rewrites. */
export function claimsNotCharged(text) {
  return typeof text === "string" && rewriteNotChargedForPush(text) !== text;
}

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The body a push payer is sent for a refusal: string fields rewritten
 *  (one level of nesting, so a problem's `detail` and a hint's text are
 *  covered), and the payment fields set. Null when the text is not a JSON
 *  object. */
export function pushRefusalBody(bodyText) {
  try {
    if (typeof bodyText !== "string" || !bodyText.trimStart().startsWith("{")) return null;
    const body = JSON.parse(bodyText);
    if (!isPlainObject(body)) return null;
    const rewrite = (o) => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") o[k] = rewriteNotChargedForPush(v);
      }
    };
    rewrite(body);
    for (const v of Object.values(body)) if (isPlainObject(v)) rewrite(v);
    return JSON.stringify({ ...body, charged: true, transferClaimed: true, refundOwed: true, payment: PUSH_FAILURE_NOTE });
  } catch {
    return null;
  }
}

/** Wraps res.send for one request paid with a claimed push credential. */
export function installPushRefusalBody(req, res) {
  const origSend = res.send;
  res.send = function pushRefusalSend(chunk) {
    try {
      if (typeof chunk === "string" && res.statusCode >= 400 && !res.headersSent && req.tempoPushRefunded !== true) {
        const rewritten = pushRefusalBody(chunk);
        if (rewritten !== null) chunk = rewritten;
      }
    } catch {
      // A rewrite must never break a refusal.
    }
    return origSend.call(this, chunk);
  };
}
