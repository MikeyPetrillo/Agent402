// Headers a tool handler sets for its ANSWER are part of the answer.
//
// A binary answer may carry headers of its own (the dub tool's translation
// rides beside the audio in X-Dub-Translation). The dispatcher sets them on
// the response before the body, and every payment gate that settles after
// the handler (the x402 middleware, the Tempo gate, the MPP shim on top of
// x402, the card capture, credits) buffers or replaces the BODY when the
// payment then fails, never the headers already set. So the rule lives here,
// once, for every gate:
//
//   no header a handler set for its answer is sent on a final status of 400
//   or above.
//
// setAnswerHeader() records the name on the request as it sets the header;
// the guard wraps writeHead (the one place every response's status and
// headers become final, the implicit one included) and removes the recorded
// names when the status is 400 or above. Mounted before every payment gate:
// a gate that swaps writeHead for a buffer keeps the function it found and
// puts it back, so a wrapper installed after such a gate is discarded and
// one installed before it is the function the final write goes through.
const NAMES = Symbol("a402.answerHeaderNames");

/** Set a header that carries part of a handler's answer, and remember it. */
export function setAnswerHeader(req, res, name, value) {
  if (typeof name !== "string" || !name) return;
  try {
    if (req && typeof req === "object") {
      if (!Object.hasOwn(req, NAMES)) Object.defineProperty(req, NAMES, { value: new Set(), enumerable: false, configurable: true });
      req[NAMES].add(name.toLowerCase());
    }
  } catch { /* an unrecorded name is still stripped below when the guard cannot tell: see fallback */ }
  res.setHeader(name, value);
}

/** The answer-header names recorded on this request (lowercase). */
export function answerHeaderNamesOf(req) {
  return req && typeof req === "object" && Object.hasOwn(req, NAMES) ? [...req[NAMES]] : [];
}

/** Remove every recorded answer header from a response that is not sent yet. */
export function stripAnswerHeaders(req, res) {
  let n = 0;
  if (!res || res.headersSent) return n;
  for (const name of answerHeaderNamesOf(req)) {
    try { if (res.getHeader(name) !== undefined) { res.removeHeader(name); n++; } } catch { /* headers already final */ }
  }
  return n;
}

/**
 * Middleware. Mount before every payment gate.
 * The status is read from writeHead's own argument when it carries one
 * (writeHead(402, ...)), else from the response.
 */
export function answerHeadersGuard() {
  return function answerHeadersGuardMw(req, res, next) {
    const orig = res.writeHead;
    res.writeHead = function answerHeadersWriteHead(...args) {
      try {
        const status = typeof args[0] === "number" ? args[0] : res.statusCode;
        if (status >= 400) stripAnswerHeaders(req, res);
      } catch { /* never break a response */ }
      return orig.apply(this, args);
    };
    next();
  };
}
