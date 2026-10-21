// Paid and per-caller answers are never stored by a shared cache.
//
// A cache in front of the origin (a CDN proxy, a corporate proxy) may keep a
// response the origin marks public. A 402 carries a per-request challenge, a
// paid answer belongs to the buyer who paid for it, and operator surfaces are
// private, so none of them may be kept. Set when the response head is
// written (whichever code path wrote the body):
//   - every 402: Cache-Control: no-store;
//   - an answer to a request that carried a way to pay (src/payment-attempt.js)
//     or that carries a payment receipt or credits balance: private, no-store,
//     unless the handler already said no-store;
//   - every /__operator answer: private, no-store.
// A response that already says no-store keeps its own header.
import { carriesPaymentAttempt } from "./payment-attempt.js";

const PAID_RESPONSE_HEADERS = ["payment-response", "payment-receipt", "x-credits-balance"];

/** The Cache-Control a response must carry, or null to leave it as is. */
export function requiredCacheControl({ status, path, paidRequest, responseHeaders }) {
  const current = String(responseHeaders["cache-control"] ?? "");
  if (/\bno-store\b/i.test(current)) return null;
  if (status === 402) return "no-store";
  const paidAnswer = paidRequest || PAID_RESPONSE_HEADERS.some((h) => responseHeaders[h] != null && responseHeaders[h] !== "");
  if (paidAnswer || /^\/__operator(?:\/|$)/.test(path || "")) return "private, no-store";
  return null;
}

export function paidNoStoreMiddleware() {
  return function paidNoStore(req, res, next) {
    const writeHead = res.writeHead;
    res.writeHead = function writeHeadNoStore(statusCode, ...rest) {
      try {
        if (!res.headersSent) {
          const status = Number(statusCode) || res.statusCode;
          const headers = res.getHeaders();
          // writeHead(status, headers) form: those headers count too.
          const inline = rest.find((a) => a && typeof a === "object" && !Array.isArray(a));
          if (inline) for (const [k, v] of Object.entries(inline)) headers[k.toLowerCase()] = v;
          const cc = requiredCacheControl({ status, path: String(req.originalUrl || req.url || "").split("?")[0], paidRequest: carriesPaymentAttempt(req), responseHeaders: headers });
          if (cc) {
            if (inline) for (const k of Object.keys(inline)) if (k.toLowerCase() === "cache-control") delete inline[k];
            res.setHeader("Cache-Control", cc);
          }
        }
      } catch { /* a header policy must never break a response */ }
      return writeHead.call(this, statusCode, ...rest);
    };
    next();
  };
}
