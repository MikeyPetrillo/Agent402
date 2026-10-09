// Opt-in idempotency for catalog routes, mounted by src/server.js right after
// the credits gate and before the paywall. Lives here so its tests drive the
// same code the server runs (scripts/test-idempotency-inflight.js).
import { createHash } from "node:crypto";
import { paymentHeaderOf, paymentIdentifierOf } from "./payer.js";
import { IDEM_MAX_BODY_BYTES } from "./idempotency-limits.js";
import { createIdempotencyStore, IDEM_TTL_MS } from "./idempotency-store.js";

/** isCatalogRoute(req): true for a priced catalog route. freeMode: dev/test boot with no paywall. */
export function createIdempotency({ isCatalogRoute, freeMode = false, store = createIdempotencyStore() }) {
  // Opt-in idempotency (safe retry for paid/proven calls). If a client sends an
  // `Idempotency-Key`, a successful gated call is cached keyed by that key + the
  // gate credential it presented (the x402 payment authorization or the
  // proof-of-work token — both single-use). A retry with the SAME Idempotency-Key
  // AND the SAME credential replays the stored result WITHOUT re-charging — so an
  // agent that paid but lost the response doesn't pay twice. Because the cache key
  // includes the credential (which only the original payer/solver holds), it can
  // never serve a paid result to a non-payer; requests without the header are
  // completely unaffected (default behavior, normal billing). Runs before the
  // paywall so a replay hit skips settlement.
  // The answers and the in-flight claims live in src/idempotency-store.js:
  // Redis when one is reachable (so a retry that lands on another container
  // still replays), else this process. IDEM_MAX_BODY_BYTES lives in
  // src/idempotency-limits.js (the tool pages quote it); IDEM_TTL_MS in the store.
  void IDEM_TTL_MS;
  const idemHashKey = (req) => {
    // The x402 `payment-identifier` extension (declared on every route's 402) is
    // honoured as an ALIAS of the Idempotency-Key header under the SAME binding
    // rules below (exact credential + route + body) - so a stock x402 client that
    // attaches a payment id gets the paid-retry replay without knowing our
    // header. It is NOT a cross-authorization dedupe: the id is client-chosen
    // text on a payload nothing has verified yet at this point in the chain, so
    // only the exact original credential can replay (a fresh authorization with
    // the same id is a new payment). Header wins when both are present.
    const idem = req.header("idempotency-key") || paymentIdentifierOf(req);
    if (!idem || idem.length > 256) return null;
    // Must match @x402/express's OWN precedence exactly (payment-signature wins
    // when both are present, verified against node_modules/@x402/express) - the
    // credential that actually settles the payment is the only one allowed to
    // seed the cache key. Checking x-payment first let an attacker settle for
    // real via a valid Payment-Signature while binding the cache entry to a
    // SELF-CHOSEN, non-secret X-Payment string - any third party who later knew
    // that string (the payer can simply publish it) could replay the same
    // Idempotency-Key + that string + the same body and hit the cache BEFORE
    // the paywall middleware below ever runs, with no payment of their own.
    // A prepaid credits key is a credential too (it authorizes and debits the
    // call): bind its HASH so a credits buyer's retry replays the paid answer
    // instead of re-debiting, exactly like an x402 buyer's (audit 2026-08-26 -
    // the plugin README promised this and the server ignored the header).
    const creditsCred = /^Bearer a402_[A-Za-z0-9_-]{16,80}$/.test(String(req.headers?.authorization || ""))
      ? "credits:" + createHash("sha256").update(req.headers.authorization.slice(7)).digest("hex") : null;
    // A credits-settled request binds to its key hash FIRST: the gate already
    // authorized it, and an unverified x-pow-solution riding alongside would
    // otherwise bind a paid entry to a public string anyone could replay.
    const cred = paymentHeaderOf(req) || (req.creditsSettled === true ? creditsCred : null) || req.header("x-pow-solution") || creditsCred;
    if (!cred) return null; // nothing to securely bind the key to → don't cache
    // Bind to the exact route AND the request body, so the same key+credential
    // can't be used to retrieve a cached response from a different payload or
    // different endpoint. Body is hashed (not stored) so the key stays compact.
    const bodyHash = req.body && Object.keys(req.body).length
      ? createHash("sha256").update(JSON.stringify(req.body)).digest("hex")
      : "-";
    return createHash("sha256").update(`${req.method} ${req.path}\n${idem}\n${cred}\n${bodyHash}`).digest("hex");
  };
  return async (req, res, next) => {
    if (!isCatalogRoute(req)) return next();
    const key = idemHashKey(req);
    if (!key) return next();
    let hit;
    try { hit = await store.get(key); } catch { hit = null; }
    if (hit !== null && hit !== undefined) {
      res.setHeader("X-Idempotent-Replay", "true");
      return res.status(200).json(hit);
    }
    // The same keyed call is still running (a client that timed out and retried
    // before the first answer finished). A single-use credential (an x402
    // authorization, a PoW token) already refuses this duplicate at its own replay
    // guard, but a prepaid credits key is reusable: both copies would run and both
    // would be debited. Refuse the copy before its handler runs; the gate ahead of
    // us releases its hold on a non-200, so it is never charged, and a retry after
    // the first finishes replays the stored answer.
    let claimed = false;
    try { claimed = await store.claim(key); } catch { claimed = true; }
    if (!claimed) {
      res.setHeader("Retry-After", "2");
      return res.status(409).json({
        error: "idempotent_request_in_flight",
        hint: "A call with this Idempotency-Key, credential and body is still running. Retry shortly with the same Idempotency-Key to receive its answer; this request was not charged.",
      });
    }
    res.once("close", () => { store.release(key).catch(() => {}); });
    // Settlement-aware caching (FR4-01). @x402/express (v2.16) runs the handler
    // FIRST, then settles, and ONLY on a <400 response; on settlement FAILURE it
    // replaces the buffered 200 with a 402. So committing to the cache at
    // res.json() time (handler completion, BEFORE settlement) would store a result
    // whose payment never settled, and a retry could replay it for free. Capture
    // the body at res.json() but COMMIT only on 'finish', when res.statusCode is
    // the post-settlement reality: a final 200 means settlement succeeded (the
    // paywall would have written a 402 otherwise). PoW (free) requests never enter
    // the settle path, so their 200 is final at finish too — cached correctly.
    let captured;
    const origJson = res.json.bind(res);
    res.json = (body) => { captured = body; return origJson(body); };
    res.on("finish", () => {
      if (res.statusCode !== 200 || captured === undefined) return;
      // Only a credential the server actually VERIFIED may seed the cache.
      //
      // idemHashKey binds the entry to `x-pow-solution` as presented, and this
      // middleware runs BEFORE the PoW gate, so at key time that header is just
      // an attacker-chosen string. That was safe only because an unauthenticated
      // caller could never reach a 200 to seed anything - the bogus solution
      // produced X-Pow-Error and a 402. The trial changed that: it returns 200
      // with no credential at all, so one trial plus a made-up solution seeded an
      // entry that ANY client could then replay, unpaid, for the whole TTL -
      // defeating the "1 per tool per hour" bound the trial advertises.
      //
      // At finish the verdict is known, so require it here: a settled payment, or
      // a PoW the gate accepted. A trial NEVER seeds the cache - it is one call,
      // not a reusable receipt. (FREE_MODE has no paywall to bind to and is
      // dev/test only, so it keeps caching.)
      if (res.getHeader("X-Trial-Accepted") === "true") return;
      const powVerified = res.getHeader("X-Pow-Accepted") === "true";
      const paid = Boolean(paymentHeaderOf(req)) || req.creditsSettled === true || req.tempoSettled === true;
      if (!freeMode && !paid && !powVerified) return;
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(captured), "utf8"); } catch { bytes = 0; }
      if (!bytes || bytes > IDEM_MAX_BODY_BYTES) return;
      store.set(key, captured, bytes).catch(() => {});
    });
    next();
  };
}
