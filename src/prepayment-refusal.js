// A /v1 input refusal answered BEFORE any payment gate (an unknown model id,
// an input over the model's character cap) records what a handler 400
// records: the "[tool-error]" log line, the tool_calls row and the PostHog
// tool_error and tool_call events, each marked pre-payment. The message is our
// own (counts and the model id, bounded by the writers), never prompt text;
// the shape is top-level key names only. server.js builds the recorder with
// its own helpers, so the two paths share one log line and one row writer.
import { PUSH_EXCEPTION } from "./tempo-push-debts.js";

//
// A refusal is free to send, so its writes are bounded per caller:
// `allowWrites(req)` (server.js: a per-address budget at the refused-credential
// figures) answers whether this one may write the row and the PostHog events.
// Past it the refusal is answered exactly the same and still reaches the
// sampled log line (counted in its summary); only the row and the two events
// are left out. Our own synthetic traffic is never budgeted.

/** Returns `record(req, slug, status, message, startedAt)`; never throws. */
export function createPrePaymentRefusalRecorder({ logToolError, recordToolCall, captureToolCall, isSynthetic, requestShape, redact = (s) => s, refusalReason = () => null, allowWrites = () => true, now = Date.now } = {}) {
  return function recordPrePaymentRefusal(req, slug, status, message, startedAt = now()) {
    try {
      const synthetic = !!isSynthetic(req);
      const errorMessage = redact(String(message || ""));
      let writes = true;
      if (!synthetic) { try { writes = allowWrites(req) !== false; } catch { writes = true; } }
      logToolError(slug, status, errorMessage, requestShape(req), synthetic, false, { prePayment: true, capture: writes });
      if (!writes) return;
      const latencyMs = Math.max(0, now() - startedAt);
      Promise.resolve(recordToolCall({ slug, latencyMs, cached: false, errored: true, status, synthetic, probe: false, prePayment: true })).catch(() => {});
      captureToolCall({ slug, latencyMs, cached: false, errored: true, status, synthetic, probe: false, refusalReason: refusalReason(errorMessage, status), prePayment: true });
    } catch { /* telemetry never breaks a response */ }
  };
}

// A log line carries text a caller chose (an echoed model id, a body's key
// names): every C0 and C1 control character, DEL and the Unicode line and
// paragraph separators become a space, so one request is always one line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** `value` as text with every control character replaced by a space. */
export function stripControlChars(value) {
  return String(value ?? "").replace(CONTROL_CHARS, " ");
}

// Pre-payment refusals are free to send, so their "[tool-error]" lines are
// bounded: the first `perMinute` in a clock minute are printed as usual, the
// rest are counted, and one summary line per minute names how many were left
// out and the slugs that sent most of them. The row, the PostHog events and
// the failure monitor still see every refusal.
const SUMMARY_SLUGS = 5;
const SUMMARY_MAX_KEYS = 200;
/** Returns `{ allow(slug), flush(), tick() }`; allow() answers whether to print. */
export function createPrePaymentLogSampler({ perMinute = 20, now = Date.now, log = (line) => console.error(line) } = {}) {
  let minute = -1, printed = 0, suppressed = 0, bySlug = new Map();
  function flush() {
    if (suppressed > 0) {
      const top = [...bySlug].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, SUMMARY_SLUGS)
        .map(([s, n]) => `${stripControlChars(s).slice(0, 64)}=${n}`).join(",");
      try { log(`[tool-error] 4xx prepay=true summary suppressed=${suppressed} slugs=[${top}]`); } catch { /* logging never throws */ }
    }
    printed = 0; suppressed = 0; bySlug = new Map();
  }
  function allow(slug) {
    const m = Math.floor(now() / 60_000);
    if (m !== minute) { flush(); minute = m; }
    if (printed < perMinute) { printed++; return true; }
    suppressed++;
    const key = String(slug ?? "");
    if (bySlug.has(key) || bySlug.size < SUMMARY_MAX_KEYS) bySlug.set(key, (bySlug.get(key) || 0) + 1);
    return false;
  }
  // Prints a finished minute's summary when no refusal has arrived since.
  function tick() {
    const m = Math.floor(now() / 60_000);
    if (minute !== -1 && m !== minute) { flush(); minute = m; }
  }
  return { allow, flush, tick };
}

/** A refusal's "Nothing was charged." with the Tempo push exception added
 *  when `push` (a push credential the Tempo gate answers: its transfer is
 *  final before the call and is recorded as owed). Anything else unchanged. */
export function withPushExceptionText(message, push) {
  if (!push || typeof message !== "string") return message;
  return message.replace(/Nothing was charged\./g, `Nothing was charged${PUSH_EXCEPTION}.`);
}
