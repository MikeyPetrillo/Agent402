// Why a 4xx happened, as a CLASS and never as the caller's words.
//
// Built 2026-09-19 after a question telemetry could not answer. The metered
// chat tier read as refusing 89% of its callers over twenty days, which looked
// like a product on fire; it was two bursts from bot clients sending a body we
// reject in under seven milliseconds, and every other day was clean. A scanner
// sending garbage and a paying customer who mistyped one field produce the
// SAME `tool_call` row today - status 400, errored true, nothing else - so the
// first reading of that number was wrong and took four queries to correct.
// The input-alias work had the same problem in reverse: it had to be inferred
// from 400 COUNTS because no cause was recorded anywhere.
//
// So this maps our OWN error messages onto a fixed vocabulary, the same shape
// as the payment classifier behind /x402-test. Two rules make it safe to send
// to a third-party analytics service:
//
//   1. The output is one of the constants below and nothing else. The caller's
//      message, values, field contents and credentials never leave here - a
//      400 often quotes what the buyer sent, and that is exactly the text an
//      analytics pipeline must never receive.
//   2. An unrecognised message is "other", never the message. That keeps the
//      vocabulary a closed set a query can GROUP BY, and it means a new error
//      string cannot silently start exporting buyer text.
//
// The value of `other` climbing is itself the signal to add a rule here.
export const REFUSAL_REASONS = Object.freeze([
  "missing_required",     // a required field was absent
  "unknown_field_value",  // an enum / allowlist value we do not serve
  "wrong_type",           // right name, wrong shape
  "out_of_range",         // a number or length past a documented bound
  "too_large",            // body or field over a size cap
  "model_not_allowed",    // the gateway allowlist refused the model
  "unknown_model",        // a model id the upstream's live list does not carry
  "model_wrong_tier",     // real model, served by a different tier
  "quote_mismatch",       // metered: the served body is not the quoted one
  "over_cap",             // metered: quote above the per-call ceiling
  "unsupported_field",    // a field we refuse by name rather than ignore
  "malformed_body",       // not parseable as the documented shape
  "not_found",            // the named resource does not exist upstream
  // Routing refusals (2026-09-21). Added after a question telemetry could not
  // answer: how many calls do we fail to route because no seller clears the
  // settlement gate? Every one of these used to classify as "other", so the
  // gate's cost was invisible and the two very different causes below could
  // not be separated.
  "no_seller_matched",    // nothing in the index does this task on this chain
  "no_seller_eligible",   // sellers DO this task, every one is below the gate
  "underlying_over_cap",  // a seller matched, priced above this tier's cap
  "network_unsupported",  // the buyer paid on a chain we cannot route from
  "routing_disabled",     // external routing is off on this host
  "routing_paused",       // a spend ceiling paused routing for now
  "routing_budget_spent", // resolution used the request's time budget
  "judged_no_match",      // candidates matched the words; the judgment found none does the task
  // In-flight coverage refusals (src/inflight-cover.js): a 429 before the run
  // starts, because the wallet's balance was not shown to cover its paid
  // calls in flight plus this one. The class is the error's own
  // `coverRefusal` where the caller has the error, else read from our text.
  "cover_short",          // the balance read does not cover the calls in flight plus this one
  "cover_settling",       // another call of the wallet is still settling; cover not confirmed yet
  "cover_beside",         // not covered beside a run another container holds
  "cover_unread",         // balance unreadable and never read lately: past the allowance of calls at once
  "cover_kept",           // balance unreadable: judged on the wallet's last good read, not covered
  "robots_disallowed",    // the URL's robots.txt disallows our fetch token for it (src/tools/robots-gate.js)
  "caller_limit",         // a tool's own documented per-caller limit (the error's callerLimit), e.g. a per-address faucet cap
  "other",
]);

// Ordered: the FIRST match wins, so the specific patterns precede the generic
// ones. Each is anchored on words our own `bad()` calls actually use.
// Bounded repetition throughout: these run over an error message, and a kit's
// 400 can quote the caller's own input, so an unbounded [a-z_ ]* next to a
// literal is the same polynomial-backtracking shape CodeQL flagged in the
// Gemini path alias. Forty characters is far past any real field name.
// `err.coverRefusal` (src/inflight-cover.js) -> its class.
const COVER_REASONS = Object.freeze({ short: "cover_short", settling: "cover_settling", beside: "cover_beside", unread: "cover_unread", kept: "cover_kept" });
// WHICH SPEND RULE OF OURS REFUSED, as a word a caller can branch on. A spend
// refusal read as prose only, and its 429 read as rate_limited, so an
// integrator could not tell this server's own spend ceiling from a limit on
// its calls or from its input. Each rule carries its hint, the next step and a
// Retry-After; the answer carries the code as `rule` beside reason
// routing_paused (src/tool-error-fields.js). Codes are only ever added, never
// renamed. The decisions come from src/external-spend-guard.js (the first
// four) and the router's per-minute window in src/x402-buyer.js.
export const SPEND_RULES = Object.freeze({
  payer_unsettled_ceiling: Object.freeze({ hint: "spend-payer-ceiling", retryAfter: 30, fix: "Your input is fine. This wallet's earlier calls here have not settled yet; retry the same call after Retry-After, once they have." }),
  global_unsettled_ceiling: Object.freeze({ hint: "spend-global-ceiling", retryAfter: 30, fix: "Your input is fine. This server's own ceiling on unsettled outside spend paused purchases from outside sellers for every buyer; retry the same call after Retry-After." }),
  wallet_daily_ceiling: Object.freeze({ hint: "spend-wallet-day-ceiling", retryAfter: 3600, fix: "Your input is fine. This server's spending wallet on this chain reached its daily ceiling, which pauses purchases there for every buyer; retry the same call after Retry-After." }),
  spend_ledger_unreadable: Object.freeze({ hint: "spend-ledger-unreadable", retryAfter: 30, fix: "Your input is fine. This server could not read its own spend ledger for this chain, which pauses purchases there for every buyer; retry the same call after Retry-After." }),
  router_minute_ceiling: Object.freeze({ hint: "spend-minute-ceiling", retryAfter: 60, fix: "Your input is fine. This server's own per-minute ceiling on outside purchases was reached for every buyer; retry the same call after Retry-After." }),
});
/** The fields a thrown spend refusal carries into its answer: attribution
 *  "ours", and for a decision with a known code the rule (`spendRule`), its
 *  hint, a next step and a Retry-After. */
export function spendRefusalFields(decision) {
  const code = decision && typeof decision.code === "string" && Object.hasOwn(SPEND_RULES, decision.code) ? decision.code : null;
  if (!code) return { attribution: "ours" };
  const r = SPEND_RULES[code];
  return { attribution: "ours", spendRule: code, hint: r.hint, fix: r.fix, retryAfter: r.retryAfter };
}
/** The spend refusal's rule code from the error's own `spendRule`, else null. */
export function spendRuleOf(err) {
  const c = err && typeof err.spendRule === "string" ? err.spendRule : null;
  return c && Object.hasOwn(SPEND_RULES, c) ? c : null;
}
/** The coverage refusal's reason code (`cover_short` ...) from the error's own
 *  `coverRefusal`, else null: a fixed word of ours, never the error's text. */
export function coverReasonOf(err) {
  const c = err && typeof err.coverRefusal === "string" ? err.coverRefusal : null;
  return c && Object.hasOwn(COVER_REASONS, c) ? COVER_REASONS[c] : null;
}

const RULES = [
  // The robots gate's sentence ends in fixed words of ours; the URL it quotes
  // comes before them, so this is read first, before any rule the URL's own
  // text could match.
  [/\bdoes not allow [A-Za-z0-9-]{1,40} to read this URL \(.{0,240}\), so it was not fetched$/, "robots_disallowed"],
  // Coverage refusals first: sentences from src/inflight-cover.js, for a
  // caller that holds the message only.
  [/\bits balance could not be read to confirm it also covers this one\b/i, "cover_unread"],
  [/\bis still settling, and until it has, the wallet's balance cannot be confirmed\b/i, "cover_settling"],
  [/\bbalance no longer covers this run\b|\bits balance does not cover this one as well\b/i, "cover_short"],
  // Routing first: these are specific sentences from route-execute, and the
  // generic rules below would otherwise claim them (an "above this endpoint's
  // $X underlying cap" message matches the over_cap rule).
  [/\bno external (x402|MPP|x402 or MPP) seller (matched|is eligible)\b.*\ball of them are below\b/i, "no_seller_eligible"],
  [/\bbelow (our|the) settlement (gate|floor)\b/i, "no_seller_eligible"],
  // Judgment-step refusals (src/tool-judge.js).
  [/\bno tool under this endpoint'?s .{0,24}cap does that task\b/i, "underlying_over_cap"],
  [/\bdoes that task \((?:judged|matched too few)/i, "judged_no_match"],
  [/\bno external (x402|MPP|x402 or MPP) seller matched\b/i, "no_seller_matched"],
  // NOT \$[0-9.]+ : the real template is `above this endpoint's $${cap}
  // underlying cap`, so the amount is an interpolation and a digit class here
  // matched the string I typed into the test and never the one we emit. The
  // phrase alone is distinctive.
  [/\bunderlying cap\b/i, "underlying_over_cap"],
  [/\bexternal routing settles on\b|\bpay on a supported (chain|network)\b/i, "network_unsupported"],
  [/\bexternal routing is not enabled on this host\b/i, "routing_disabled"],
  [/\bexternal routing on .{0,24} is paused\b|\bexternal routing is paused\b/i, "routing_paused"],
  [/\bused (?:the Tempo|this payment's) time budget\b|\bcredentials expire\b/i, "routing_budget_spent"],
  [/\bis not in the gateway allowlist\b/i, "model_not_allowed"],
  [/\bis not a chat model id the upstream serves\b/i, "unknown_model"],
  [/\bis served by the .* tier\b|\bcall \/v1\/[a-z0-9/-]+ .*instead\b/i, "model_wrong_tier"],
  [/\bbut the body being served quotes\b|\bresend the request exactly as it should be served\b/i, "quote_mismatch"],
  [/\babove the \$[0-9.]+ per-call cap\b|\bper-call cap of\b/i, "over_cap"],
  [/\bis not supported on this route\b|\bis refused\b|\bnot served on this route\b/i, "unsupported_field"],
  // NOTE the missing \b after the closing quote: `must be "text/plain" or ...`
  // has a space next, and quote-to-space is non-word to non-word, so a word
  // boundary there never matches. The first cut had one and classified the
  // commonest enum refusal we serve as "other".
  [/\bmust be one of\b|\bmust be "[^"]*"|\bunknown [a-z_ ]{0,40}(mode|type|period|unit|format|category|network|chain)\b/i, "unknown_field_value"],
  [/\bis required\b|\bmust be a non-empty\b|\bneeds? an? "/i, "missing_required"],
  [/\bmust be an? (object|array|string|number|boolean|integer)\b|\bmust be a JSON object\b/i, "wrong_type"],
  // Format constraints on a field the caller DID send: right name, wrong
  // shape. "code must be 8-14 digits (a UPC/EAN barcode)" is the one that
  // started this - it is the single most common refusal we have ever served
  // and the first cut classified it "other".
  [/\bmust be \d+([-\u2013]\d+)? (digits|characters|chars|bytes)\b|\bmust be a valid\b|\bmust match\b|\bmust look like\b/i, "wrong_type"],
  [/\bis capped at\b|\btoo many\b|\bexceeds\b|\bmust be between\b|\bmust be at (most|least)\b/i, "out_of_range"],
  [/\btoo large\b|\bover the .* limit\b|\bpayload too large\b/i, "too_large"],
  [/\bdoes not exist\b|\bnot found\b|\bunknown (ticker|symbol|series|manager|company)\b/i, "not_found"],
  [/\bcould not be parsed\b|\bis not valid JSON\b|\bmalformed\b|\binvalid JSON\b/i, "malformed_body"],
];

/** Classify one refusal. Returns a member of REFUSAL_REASONS, always.
 *  @param message our own error text (never the caller's input)
 *  @param status  the HTTP status we answered with
 *  @param err     the error itself, when the caller has it (read for `coverRefusal` only) */
export function refusalReason(message, status, err = null) {
  const code = Number(status) || 0;
  if (code < 400 || code >= 500) return null; // only a refusal has a reason
  // The coverage check names its own class on the error (a fixed word of
  // ours; anything else falls through to the text).
  const cover = code === 429 && err && typeof err.coverRefusal === "string" && Object.hasOwn(COVER_REASONS, err.coverRefusal) ? COVER_REASONS[err.coverRefusal] : null;
  if (cover) return cover;
  if (code === 429 && spendRuleOf(err)) return "routing_paused";
  if (code === 403 && err?.robotsDisallowed === true) return "robots_disallowed";
  if (code === 429 && err?.callerLimit === true) return "caller_limit";
  if (code === 413) return "too_large";
  // The router's no-match refusals answer 404 too; their own words name
  // the class, so a 404 is read as not_found only when they do not.
  if (code === 404) {
    const text = typeof message === "string" ? message : "";
    for (const [re, reason] of RULES) if ((reason === "judged_no_match" || reason === "no_seller_matched") && re.test(text)) return reason;
    return "not_found";
  }
  const text = typeof message === "string" ? message : "";
  if (!text) return "other";
  for (const [re, reason] of RULES) if (re.test(text)) return reason;
  return "other";
}
