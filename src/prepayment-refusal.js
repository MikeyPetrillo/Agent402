// A /v1 input refusal answered BEFORE any payment gate (an unknown model id,
// an input over the model's character cap) records what a handler 400
// records: the "[tool-error]" log line, the tool_calls row and the PostHog
// tool_error and tool_call events, each marked pre-payment. The message is our
// own (counts and the model id, bounded by the writers), never prompt text;
// the shape is top-level key names only. server.js builds the recorder with
// its own helpers, so the two paths share one log line and one row writer.

/** Returns `record(req, slug, status, message, startedAt)`; never throws. */
export function createPrePaymentRefusalRecorder({ logToolError, recordToolCall, captureToolCall, isSynthetic, requestShape, redact = (s) => s, refusalReason = () => null, now = Date.now } = {}) {
  return function recordPrePaymentRefusal(req, slug, status, message, startedAt = now()) {
    try {
      const synthetic = !!isSynthetic(req);
      const errorMessage = redact(String(message || ""));
      logToolError(slug, status, errorMessage, requestShape(req), synthetic, false, { prePayment: true });
      const latencyMs = Math.max(0, now() - startedAt);
      Promise.resolve(recordToolCall({ slug, latencyMs, cached: false, errored: true, status, synthetic, probe: false, prePayment: true })).catch(() => {});
      captureToolCall({ slug, latencyMs, cached: false, errored: true, status, synthetic, probe: false, refusalReason: refusalReason(errorMessage, status), prePayment: true });
    } catch { /* telemetry never breaks a response */ }
  };
}
