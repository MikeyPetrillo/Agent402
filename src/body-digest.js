// A digest of a request's JSON body, worked out once per request. The
// explicit or implicit idempotency key, the call digest of a kept answer, a
// settle-first credit (src/idempotency.js) and the call a /ref answer was paid
// for (src/referral-gate.js) all bind to it, so one body hashes one way.
import { createHash } from "node:crypto";

const bodyDigests = new WeakMap();
/** sha256 of JSON.stringify(req.body), memoized per request while its body is
 *  the same object. Throws as JSON.stringify does. */
export function bodyDigestOf(req) {
  const memo = bodyDigests.get(req);
  if (memo && memo.body === req.body) return memo.digest;
  const digest = createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
  bodyDigests.set(req, { body: req.body, digest });
  return digest;
}
