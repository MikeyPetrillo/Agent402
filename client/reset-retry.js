// resetRetryFetch(baseFetch) returns a fetch that resends a request ONCE when
// its connection failed before any response arrived: a kept-alive socket the
// server's edge already closed answers the next write with ECONNRESET (or
// undici's "other side closed"), and the request never reached the server.
//
// Only a transport error is retried, never an HTTP answer, and only for a
// body that can be sent again (none, a string, bytes, URLSearchParams, a
// Blob); a streamed body is not. The resend carries the same headers, so a
// signed payment is resent as signed: an EIP-3009 authorization's nonce can
// settle only once, and the server answers a re-sent signed payment from its
// first answer, so the resend can never pay twice. Wrap it UNDER a payment
// wrapper (wrapFetchWithPayment(resetRetryFetch(fetch), client)), never over
// one: over a wrapper, a retry would sign a fresh authorization.
const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNABORTED"]);

/** Did this fetch error fail on the connection before any response? */
export function isConnectionReset(err) {
  let e = err;
  for (let i = 0; i < 5 && e; i++) {
    if (RESET_CODES.has(e.code)) return true;
    if (/other side closed|socket hang up/i.test(String(e.message || ""))) return true;
    e = e.cause;
  }
  return false;
}

function replayableBody(body) {
  if (body === undefined || body === null || typeof body === "string") return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  return false;
}

export function resetRetryFetch(baseFetch = globalThis.fetch, { pauseMs = 300 } = {}) {
  if (typeof baseFetch !== "function") throw new Error("resetRetryFetch needs a fetch function");
  return async function fetchWithResetRetry(input, init) {
    try {
      return await baseFetch(input, init);
    } catch (e) {
      const isRequest = typeof Request !== "undefined" && input instanceof Request;
      if (!isConnectionReset(e) || init?.signal?.aborted || isRequest || !replayableBody(init?.body)) throw e;
      await new Promise((r) => setTimeout(r, pauseMs));
      return baseFetch(input, init);
    }
  };
}
