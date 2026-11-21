// Two ids per request.
//
// `req.requestId` (echoed as X-Request-Id) is for grepping logs when a buyer
// or operator forwards a failing response: honored from upstream (the load
// balancer) when well formed, otherwise generated. It is caller text, so two
// callers can send the same one.
//
// `req.debtKey` is always made here and never read from the request: it keys
// a refund debt that has no settle transaction (src/refund-ledger.js
// fallbackEvidence), so two buyers who send the same X-Request-Id and fail on
// the same route in the same minute are two debts, never one.
import { randomUUID } from "node:crypto";

const REQUEST_ID_RE = /^[A-Za-z0-9_.-]{6,128}$/;

export function requestIdMiddleware() {
  return function requestId(req, res, next) {
    const incoming = req.header("x-request-id");
    req.requestId = typeof incoming === "string" && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    req.debtKey = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  };
}
