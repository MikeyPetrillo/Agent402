// POST /api/mpp/monitors/subscribe: the challenge/credential pair in one
// route, the shape every MPP client already knows. No Authorization header ->
// 402 with a tempo/subscription challenge; the signed credential -> the first
// period settles and the subscription exists (src/mpp-subscriptions.js).
//
// A module of its own so the route's answers (which engine errors reach the
// buyer, in which shape) are tested through HTTP with a stub engine
// (scripts/test-mpp-subscription-activation-owed.js, section 11).
import { mppProblem, sendMppProblem } from "./mpp-problem.js";
import { tempoRefusalProblem } from "./mpp-tempo.js";
import { redactSecrets } from "./tools/redact.js";

/**
 * @param {object} deps
 * @param {object} deps.engine          the subscription engine (mintOffer, activateFromCredential)
 * @param {(req)=>boolean} deps.rateLimited  true when this caller is over the checkout limit
 * @param {(req)=>boolean} deps.isCanary     true for a caller carrying a valid heartbeat token
 * @param {(...a)=>void} [deps.warn]
 */
export function mppSubscribeHandler({ engine, rateLimited, isCanary, warn = console.warn }) {
  return async (req, res) => {
    if (!req.__checkoutRateChecked && rateLimited(req)) return res.status(429).json({ error: "Too many requests, please slow down." });
    res.set("Cache-Control", "no-store");
    const auth = req.headers.authorization;
    // The rail canary's own product is mintable ONLY for a caller that carries a
    // valid POW_SECRET-signed heartbeat token. An outside buyer cannot mint one,
    // so asking for it without the token resolves to "unknown product" exactly
    // as any other unknown string would - the gate leaks nothing about it.
    const canary = isCanary(req);
    const mint = () => engine.mintOffer({ product: req.body?.product, target: req.body?.target, email: req.body?.email, canary });
    if (!auth || !/^payment\s/i.test(auth)) {
      try {
        const offer = await mint();
        // A bare unpaid 402 stays body-less by house convention: the challenge
        // is in WWW-Authenticate and GET /api/mpp/monitors explains the rest.
        return res.status(402).set("WWW-Authenticate", offer.header).json({});
      } catch (e) {
        if (e?.statusCode && e.statusCode < 500) return res.status(e.statusCode).json({ error: redactSecrets(String(e.message)).slice(0, 200) });
        warn("[mpp-subs] mintOffer failed:", redactSecrets(String(e?.message || e)).slice(0, 200));
        return res.status(500).json({ error: "Could not start a subscription right now." });
      }
    }
    try {
      const r = await engine.activateFromCredential(auth);
      if (r.receipt) res.set("Payment-Receipt", r.receipt);
      return res.json(r);
    } catch (e) {
      // The paying wallet was screened out before anything was sent: the
      // per-call Tempo rail's own refusal, and no fresh challenge (another
      // signature from this wallet would be refused the same way).
      if (e?.screenRejected) return sendMppProblem(res, tempoRefusalProblem("screen-rejected"));
      if (e?.statusCode === 402) {
        // Spec shape for a rejected credential: 402 + a FRESH challenge + an
        // RFC 9457 problem saying why, same as the tempo/charge gate answers.
        try { res.set("WWW-Authenticate", (await mint()).header); } catch { /* the caller can GET the offer */ }
        const kind = e.binding ? "invalid-challenge" : "verification-failed";
        return sendMppProblem(res, mppProblem(kind, `Subscription was not accepted: ${redactSecrets(String(e.message)).slice(0, 200)}`));
      }
      if (e?.statusCode && e.statusCode < 500) return res.status(e.statusCode).json({ error: redactSecrets(String(e.message)).slice(0, 200) });
      // The first payment settled and no subscription was recorded: the
      // engine's own text says so (retry inside the challenge window, else
      // refunded). Relayed on the engine's flag, never on its wording.
      if (e?.settledNotRecorded === true) {
        warn("[mpp-subs] activation settled but was not recorded");
        return res.status(500).json({ error: redactSecrets(String(e.message)).slice(0, 300), paymentSettled: true });
      }
      warn("[mpp-subs] activation failed:", redactSecrets(String(e?.message || e)).slice(0, 200));
      return res.status(500).json({ error: "Could not complete the subscription right now." });
    }
  };
}
