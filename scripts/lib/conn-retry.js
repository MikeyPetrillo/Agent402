// One retry of a request whose connection failed before any response arrived:
// a kept-alive socket the edge already closed answers the next write with
// ECONNRESET (or undici's "other side closed"), and the request never reaches
// the server. Only a transport error is retried, never an HTTP answer, and
// only once, after a short pause. A paid request is retried with the same
// credential: the server's replay guard reads that payment as one, so the
// retry can settle at most once.
const CONN_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNABORTED"]);

export function isConnectionReset(err) {
  let e = err;
  for (let i = 0; i < 5 && e; i++) {
    if (CONN_CODES.has(e.code)) return true;
    if (/other side closed|socket hang up/i.test(String(e.message || ""))) return true;
    e = e.cause;
  }
  return false;
}

export async function withConnRetry(fn, { pauseMs = 500, onRetry = () => {} } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (!isConnectionReset(e)) throw e;
    onRetry(e);
    await new Promise((r) => setTimeout(r, pauseMs));
    return fn();
  }
}
