// Opt-in idempotency for catalog routes, mounted by src/server.js right after
// the credits gate and before the paywall. Lives here so its tests drive the
// same code the server runs (scripts/test-idempotency-inflight.js).
import { createHash } from "node:crypto";
import { paymentHeaderOf, paymentIdentifierOf, paymentNonceIdentityOf } from "./payer.js";
import { IDEM_MAX_BODY_BYTES } from "./idempotency-limits.js";
import { createIdempotencyStore, IDEM_TTL_MS, INFLIGHT_RENEW_MS } from "./idempotency-store.js";
import { onResponseEnd } from "./hangup-settlement.js";

// A stored answer is the body as served, or, when it was charged but never
// delivered (the buyer left while the payment settled), the body under this
// marker with the charge the server booked for it, so the replay can name it.
const STORED = "__a402Stored";
const wrapStored = (body, charged) => ({ [STORED]: 1, body, charged });
const unwrapStored = (hit) => (hit && typeof hit === "object" && !Array.isArray(hit) && hit[STORED] === 1 ? { body: hit.body, charged: hit.charged || null } : { body: hit, charged: null });

/** Whether a re-sent x402 payment on `def`'s route may replay its first
 *  answer implicitly (src/server.js mounts it as `implicitReplay`): never on a
 *  route whose effect outlives the answer, never on an identity-bound route,
 *  never for a streamed call. The two predicates are the server's own. */
export function implicitReplayAllowed(def, req, { hasLastingEffect, isIdentityBound }) {
  return Boolean(def) && !hasLastingEffect(def.slug) && !isIdentityBound(def) && req?.body?.stream !== true;
}

/** isCatalogRoute(req): true for a priced catalog route. freeMode: dev/test boot with no paywall.
 *  implicitReplay(req): true when a re-sent x402 payment on this route may be
 *  answered from its first answer (the server excludes routes with a lasting
 *  effect and streamed calls); absent, no implicit key is derived.
 *  onReplay(req, { implicit, key, charged }): awaited once per stored answer
 *  before it is served; `charged` names the charge ({ tx, network, wire }) when
 *  the stored answer was charged and never delivered (see below), else null.
 *  Resolving { serve: false, status, body } answers that instead of the stored
 *  body (the charge was refunded); any other result serves it. */
export function createIdempotency({ isCatalogRoute, freeMode = false, store = createIdempotencyStore(), implicitReplay = null, onReplay = null }) {
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
    let idem = req.header("idempotency-key") || paymentIdentifierOf(req);
    if (idem && idem.length > 256) return null;
    // IMPLICIT KEY (2026-10-23). A client that re-sends a request with the SAME
    // signed x402 payment (one EIP-3009 authorization, one nonce) after a
    // timeout was answered twice: the first copy settled and was served, the
    // second ran the handler again and its settlement reverted (nonce used),
    // so the buyer read a 402 for a call it had paid for and the settle
    // breaker counted a failure. The nonce is single-use on chain, so a
    // payment's identity (network, signed payer, nonce) names exactly one
    // call: with no explicit key it becomes the key, under the same binding
    // as an explicit one (this exact credential, route and body), so the
    // replay is served from the first answer with no handler run and no
    // settlement. A different body or route under the same nonce is a
    // different key and takes the normal path. Only an EVM payment has such
    // a nonce; a PoW token and a credits key never derive one (the token has
    // its own replay guard, a credits key is reusable, so a repeat is a new
    // call). Routes the server lists as excluded (a lasting effect, a stream)
    // keep their explicit-key behavior only.
    let implicit = false;
    if (!idem && typeof implicitReplay === "function" && implicitReplay(req)) {
      const id = paymentNonceIdentityOf(req);
      if (id) { idem = `nonce:${id.network}:${id.from}:${id.nonce}`; implicit = true; }
    }
    if (!idem) return null;
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
    const x402Cred = paymentHeaderOf(req);
    const powCred = req.header("x-pow-solution");
    const cred = x402Cred || (req.creditsSettled === true ? creditsCred : null) || powCred || creditsCred;
    if (!cred) return null; // nothing to securely bind the key to → don't cache
    // Which presented credential the key is bound to, so the store step can
    // require that it is the one the gate actually verified.
    const kind = cred === x402Cred ? "x402" : cred === creditsCred ? "credits" : "pow";
    // Bind to the exact route AND the request body, so the same key+credential
    // can't be used to retrieve a cached response from a different payload or
    // different endpoint. Body is hashed (not stored) so the key stays compact.
    const bodyHash = req.body && Object.keys(req.body).length
      ? createHash("sha256").update(JSON.stringify(req.body)).digest("hex")
      : "-";
    // A GET tool takes its input on the query string: bound too (as sent), so
    // a repeat with another input is a different call. Added only when there
    // is one, so a query-less key hashes exactly as before.
    const url = String(req.originalUrl || req.url || "");
    const qs = url.includes("?") ? `\n?${url.slice(url.indexOf("?") + 1)}` : "";
    return { key: createHash("sha256").update(`${req.method} ${req.path}${qs}\n${idem}\n${cred}\n${bodyHash}`).digest("hex"), kind, implicit };
  };
  return async (req, res, next) => {
    if (!isCatalogRoute(req)) return next();
    const bound = idemHashKey(req);
    if (!bound) return next();
    const { key, kind, implicit } = bound;
    let hit;
    try { hit = await store.get(key); } catch { hit = null; }
    if (hit !== null && hit !== undefined) {
      // Answered here, before the paywall and the dispatcher: no handler, no
      // settlement, and none of the finish-time bookkeeping behind the gates
      // (the sale, the served-call tally, the tool-answer classes) sees it.
      const { body, charged } = unwrapStored(hit);
      if (typeof onReplay === "function") {
        // The hook runs before the body goes out and may refuse the replay
        // ({ serve: false, status, body }: the charge behind the stored
        // answer was refunded); anything else serves it.
        let verdict;
        try { verdict = await onReplay(req, { implicit, key, charged }); } catch { verdict = undefined; }
        if (verdict && typeof verdict === "object" && verdict.serve === false) {
          return res.status(Number(verdict.status) || 402).json(verdict.body && typeof verdict.body === "object" ? verdict.body : { error: "replay_refused" });
        }
      }
      res.setHeader("X-Idempotent-Replay", "true");
      if (implicit) res.setHeader("X-Replayed-Answer", "1");
      return res.status(200).json(body);
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
        hint: implicit
          ? "A call carrying this same signed payment is still running. Retry shortly with the same payment to receive its answer; this request was not charged."
          : "A call with this Idempotency-Key, credential and body is still running. Retry shortly with the same Idempotency-Key to receive its answer; this request was not charged.",
      });
    }
    const renew = setInterval(() => { store.renew(key).catch(() => {}); }, INFLIGHT_RENEW_MS);
    renew.unref?.();
    res.once("close", () => { clearInterval(renew); store.release(key).catch(() => {}); });
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
    let committed = false;
    const commit = (charged = null) => {
      if (committed || res.statusCode !== 200 || captured === undefined) return;
      committed = true;
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
      // A PoW-served answer is stored only under the PoW token it was served
      // on. The key is computed before the PoW gate, so a payment header riding
      // alongside a valid solution is unverified text: binding the entry to it
      // would let anyone presenting that text replay the answer. Such a call is
      // simply not stored; a call carrying only its solution keeps its replay.
      if (powVerified && kind !== "pow") return;
      const paid = Boolean(paymentHeaderOf(req)) || req.creditsSettled === true || req.tempoSettled === true;
      if (!freeMode && !paid && !powVerified) return;
      const stored = charged ? wrapStored(captured, charged) : captured;
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(stored), "utf8"); } catch { bytes = 0; }
      if (!bytes || bytes > IDEM_MAX_BODY_BYTES) return;
      store.set(key, stored, bytes).catch(() => {});
    };
    res.on("finish", () => commit());
    // CHARGED BUT NEVER DELIVERED. A buyer that leaves before the first byte
    // while its payment settles is charged (no ticket, or the close landed
    // inside the settle call) and Node emits no "finish" for the response the
    // gate then ends, so the answer was dropped and the resend ran the
    // handler again against a used nonce: a 402 for a call already paid. The
    // hang-up recorder books that charge as a debt on the request before the
    // outcome runs (server.js recordHangupDebt, on the receipt's proof only);
    // the answer is committed under it, so the resend of the same payment is
    // served from here and the replay names the charge for the server to
    // void the debt. Registered on every end, not the settle outcome: a close
    // that lands during the settle call holds a granted ticket and reads as
    // forgiven, yet the money moved, and the booked debt is what says so. A
    // hang-up that was not charged books no debt and commits nothing.
    onResponseEnd(req, res, (info) => {
      if (info?.via !== "undelivered") return;
      const debt = Object.hasOwn(req, "__a402HangupDebt") ? req.__a402HangupDebt : null;
      if (!debt || typeof debt !== "object" || typeof debt.tx !== "string" || !debt.tx) return;
      commit({ tx: debt.tx, network: debt.network ?? null, wire: debt.wire ?? null });
    });
    next();
  };
}
