// MPP (Machine Payments Protocol) dual-stack shim — serve MPP clients from the
// same routes as x402 clients, with @x402/express keeping SOLE settlement
// authority. MPP (tempoxyz/mpp, IETF-track "Payment" HTTP auth scheme,
// paymentauth.org) uses the same 402 lifecycle as x402 with standard headers:
//
//   challenge   WWW-Authenticate: Payment …     (x402: PAYMENT-REQUIRED)
//   credential  Authorization: Payment <b64url> (x402: PAYMENT-SIGNATURE)
//   receipt     Payment-Receipt: <b64url>       (x402: PAYMENT-RESPONSE)
//
// MPP's `evm` method is the same primitive as x402 exact (EIP-3009
// transferWithAuthorization), so this shim is a pure header translation layer:
//
//   OUTBOUND  every paywall 402 that carries PAYMENT-REQUIRED also gains a
//             WWW-Authenticate: Payment challenge per EVM `accepts` entry,
//             HMAC-bound via MPP_SECRET_KEY (spec challenge-id binding). The
//             exact advertised accepts entry rides along in challenge meta
//             (client MUST echo opaque unchanged), so the inbound direction is
//             stateless and byte-exact.
//   INBOUND   Authorization: Payment credentials whose challenge HMAC-verifies
//             are re-encoded as a PAYMENT-SIGNATURE header and fall through to
//             @x402/express untouched — verify + settle happen exactly once,
//             and every paywall invariant (replay guard, payer attribution,
//             settlement ordering, idempotency) keys off the same header it
//             always has. Invalid/expired MPP credentials are simply ignored:
//             the paywall answers with a fresh 402 carrying new challenges.
//   RECEIPT   on a settled 200 for an MPP-credential request, the paywall's
//             PAYMENT-RESPONSE is mirrored as an MPP Payment-Receipt.
//
// EVM stablecoin rails only (eip155:*) — SVM/Stellar/Algorand accepts entries
// are never offered as MPP challenges (their payloads aren't EIP-3009).
// Enabled only when MPP_SECRET_KEY is set (env-gated no-op, like other
// optional rails). mppx is the reference MPP implementation; we use only its
// codec primitives here — its request-guard/settlement path is deliberately
// NOT mounted (double-settle risk vs @x402/express).
import { Challenge, Credential, PaymentRequest, Receipt, x402, evm } from "mppx";
import { mppProblem, markMppProblem } from "./mpp-problem.js";
import { RAILS } from "./rails.js";
import { diagnoseEvmAuthorizationDomain, domainMismatchDetail } from "./mpp-evm-domain.js";
import { evmDomainFallbackEnabled, noteWrongDomainSigner, mppChallengesSuppressed } from "./mpp-fallback.js";
import { capturePostHogVerifyFailed } from "./posthog.js";

/** Replay of the paywall's own header names (see @x402/core http). */
const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_SIGNATURE_HEADER = "payment-signature"; // req.headers keys are lowercase
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Challenge meta key carrying the verbatim advertised x402 accepts entry. */
const META_ACCEPTS_KEY = "x402";

/** All our EVM rails settle 6-decimal stablecoins (Circle USDC + Paxos USDG). */
const STABLECOIN_DECIMALS = 6;

// Which EVM chains get an MPP challenge on each 402. A stock mppx client can
// only natively sign assets in its built-in registry (Base + Celo mainnets),
// and every extra challenge adds ~800 bytes to EVERY 402 (a high-volume,
// crawler-swept response) — so the default covers exactly what stock clients
// can pay. MPP_CHALLENGE_NETWORKS overrides: "all" (every eip155 accepts
// entry) or a CSV of chain ids. Call-time read, like other rollout knobs.
//
// VERIFIED against the installed mppx@0.8.17 source (2026-08-16, previously
// an unconfirmed in-code claim): `mppx/evm`'s Chains.ts defines exactly four
// chain ids (base 8453, baseSepolia 84532, celo 42220, celoSepolia
// 11142220), and Assets.ts's known-USDC registry covers only those same four
// - a stock client's Charge.ts resolves an accepted currency via
// Assets.matches() against ONLY this registry, so a challenge for any other
// chain has nothing for it to auto-sign without the caller manually passing
// a raw address + explicit network override. Mainnets only, hence {8453,
// 42220}. scripts/test-mpp-shim-mppx-registry.js locks this against the
// installed package so a future mppx bump that adds a mainnet fails loudly
// here instead of silently leaving that chain's challenge unoffered.
const DEFAULT_CHALLENGE_CHAIN_IDS = new Set([8453, 42220]);

/** @param {number} chainId */
export function challengeEnabledForChain(chainId) {
  const raw = (process.env.MPP_CHALLENGE_NETWORKS || "").trim();
  if (!raw) return DEFAULT_CHALLENGE_CHAIN_IDS.has(chainId);
  if (raw.toLowerCase() === "all") return true;
  return raw.split(",").some((s) => Number(s.trim()) === chainId);
}

/** Whether the shim itself is actually mounted — MPP_SECRET_KEY presence is
 *  the rollout switch (see createMppShim below). Call-time read, like every
 *  other rollout knob here — never cached at module load. */
export function mppShimEnabled() {
  return !!process.env.MPP_SECRET_KEY;
}

/** RAILS entries we currently issue an MPP challenge for on OUR OWN paywall —
 *  derived live from challengeEnabledForChain() (and gated on the shim
 *  actually being mounted) so this can never drift from the real gate.
 *  Distinct from the x402 marketplace's "by chain" seller breakdown: that's
 *  a directory of what OTHER sellers accept, this is what WE accept. Empty
 *  when the shim isn't mounted — never a stale/fabricated chain list. */
export function mppChallengeRails() {
  if (!mppShimEnabled()) return [];
  return RAILS.filter((r) => typeof r.chainId === "number" && challengeEnabledForChain(r.chainId));
}

/**
 * Builds the Express middleware. Returns null when no secret is configured —
 * caller mounts nothing and the server stays pure-x402.
 *
 * @param {object} opts
 * @param {string} opts.secretKey - HMAC secret binding challenge ids (MPP_SECRET_KEY).
 * @param {string} opts.realm - Protection-space identifier (our hostname).
 * @returns {import("express").RequestHandler|null}
 */
export function createMppShim({ secretKey, realm }) {
  if (!secretKey) return null;

  return function mppShim(req, res, next) {
    // ---- OUTBOUND: append WWW-Authenticate on 402s, Payment-Receipt on 200s ----
    // Installed first so it is in place however the inbound half below
    // resolves (it reads req at writeHead time, long after either path).
    const origWriteHead = res.writeHead;
    res.writeHead = function mppWriteHead(...args) {
      try {
        if (res.statusCode === 402 && !res.getHeader("WWW-Authenticate")) {
          // A client that has proven it signs EIP-3009 under the wrong token
          // domain gets NO challenge: its MPP path cannot settle here, and a
          // manager that prefers MPP only falls back to x402 when there is
          // nothing to select. See src/mpp-fallback.js.
          const pr = mppChallengesSuppressed(req) ? null : res.getHeader(PAYMENT_REQUIRED_HEADER);
          if (pr) {
            const header = challengeHeaderFromPaymentRequired(String(pr), { secretKey, realm });
            if (header) res.setHeader("WWW-Authenticate", header);
          }
        } else if (res.statusCode === 200 && req.mppCredential) {
          const settle = res.getHeader(PAYMENT_RESPONSE_HEADER);
          if (settle) {
            const receipt = receiptFromPaymentResponse(String(settle));
            if (receipt) res.setHeader("Payment-Receipt", receipt);
          }
        }
      } catch {
        // Translation is strictly additive — never let it break the response.
      }
      return origWriteHead.apply(this, args);
    };

    // ---- INBOUND: Authorization: Payment → PAYMENT-SIGNATURE ----
    // Never touch a request that already speaks x402 (incl. mppx clients using
    // their bare-x402 protocol path) — pass-through is the no-regression rule.
    const auth = req.headers.authorization;
    if (
      !(
        typeof auth === "string" &&
        /^payment\s/i.test(auth) &&
        !req.headers[PAYMENT_SIGNATURE_HEADER] &&
        !req.headers["x-payment"]
      )
    ) {
      return next();
    }

    const t = translateCredentialDetailed(auth, { secretKey });
    if (!t.paymentSignature) {
      if (t.reject && t.reject.kind !== "method-unsupported") {
        // Invalid evm credential: fall through untranslated - the paywall
        // re-issues a 402 whose outbound hook above mints fresh MPP
        // challenges - and that 402's body becomes RFC 9457 problem+json
        // naming WHY (spec shape; mppx's own server does the same).
        // "method-unsupported" here means "not evm/charge" - most likely a
        // tempo credential the tempo gate (mounted after us) will judge, so
        // we leave the verdict to it.
        markMppProblem(req, res, mppProblem(t.reject.kind, t.reject.detail));
      }
      return next();
    }

    // The credential is ours, unexpired and well-shaped. One last LOCAL check
    // before the paywall spends a facilitator round trip on it: was it signed
    // under this token's own EIP-712 domain name? A credential signed under a
    // different known name can never verify here or on chain, and the client
    // that does it has a working x402 path we can steer it to instead.
    const accept = () => {
      req.headers[PAYMENT_SIGNATURE_HEADER] = t.paymentSignature;
      // The scheme is consumed; leaving it would only invite double-reads.
      delete req.headers.authorization;
      req.mppCredential = true;
    };
    if (!evmDomainFallbackEnabled()) {
      accept();
      return next();
    }
    diagnoseEvmAuthorizationDomain({ accepted: t.accepted, authorization: t.authorization, signature: t.signature })
      .then((d) => {
        if (d.verdict !== "domain-mismatch") {
          // "matches" is the healthy path; "unknown" is an ordinary bad
          // signature, and the facilitator is the settlement authority that
          // gets to say so - not us.
          accept();
          return;
        }
        noteWrongDomainSigner(req);
        markMppProblem(req, res, mppProblem("verification-failed", domainMismatchDetail(d)));
        try {
          capturePostHogVerifyFailed({
            network: `eip155:${d.chainId}`,
            scheme: "mpp-evm",
            // req.path, never originalUrl: a relative originalUrl keeps its
            // query string through posthog's URL parse, and tool inputs ride
            // there. The route is all this event needs.
            resource: req.path || req.url,
            errorReason: `mpp_evm_domain_mismatch signed=${d.signedName} expected=${d.expectedName}`,
          });
        } catch {
          // Telemetry is never load-bearing for a payment path.
        }
      })
      .catch(() => {
        // Fail OPEN: an unreadable diagnosis must never cost a good buyer
        // their purchase. Hand it to the facilitator exactly as before.
        accept();
      })
      .finally(() => next());
  };
}

/**
 * OUTBOUND half: decode our own PAYMENT-REQUIRED header and mint one
 * HMAC-bound MPP challenge per EVM accepts entry.
 *
 * @param {string} paymentRequiredHeader - Encoded PAYMENT-REQUIRED value.
 * @param {{secretKey: string, realm: string}} opts
 * @returns {string|null} WWW-Authenticate header value, or null when no entry qualifies.
 */
export function challengeHeaderFromPaymentRequired(paymentRequiredHeader, { secretKey, realm }) {
  // Envelope decode, not the strict schema: our accepts list also carries
  // non-EVM rails (solana:/stellar:/algorand:) that mppx's eip155-typed
  // PaymentRequirementsSchema rejects — filter per entry like mppx's own
  // client protocol does.
  const paymentRequired = x402.Header.decodePaymentRequiredEnvelope(paymentRequiredHeader);
  const challenges = [];
  for (const rawAccepts of paymentRequired.accepts) {
    const parsed = x402.PaymentRequirementsSchema.safeParse(rawAccepts);
    if (!parsed.success) continue;
    const accepts = parsed.data;
    if (accepts.scheme !== "exact") continue;
    if (typeof accepts.network !== "string" || !accepts.network.startsWith("eip155:")) continue;
    const chainId = Number(accepts.network.slice("eip155:".length));
    if (!Number.isInteger(chainId)) continue;
    if (!challengeEnabledForChain(chainId)) continue;
    challenges.push(
      Challenge.from({
        realm,
        method: "evm",
        intent: "charge",
        // Native MPP clients sign validBefore = expires; keep it inside the
        // advertised x402 window so facilitator timeout semantics match.
        expires: new Date(Date.now() + accepts.maxTimeoutSeconds * 1000),
        request: {
          amount: accepts.amount,
          currency: accepts.asset,
          recipient: accepts.payTo,
          methodDetails: {
            chainId,
            credentialTypes: ["authorization"],
            decimals: STABLECOIN_DECIMALS,
          },
        },
        // The verbatim accepts entry (RAW, not schema-parsed — parsing strips
        // unknown fields and the paywall's requirement matching deep-equals the
        // full advertised object), HMAC-bound via the challenge id (meta folds
        // into `opaque`, slot 6 of the id binding) and echoed back by the
        // client — inbound rebuilds `accepted` byte-exact and stateless.
        meta: { [META_ACCEPTS_KEY]: JSON.stringify(rawAccepts) },
        secretKey,
      })
    );
  }
  if (challenges.length === 0) return null;
  return challenges.map((c) => Challenge.serialize(c)).join(", ");
}

/**
 * INBOUND half: MPP credential → encoded x402 PAYMENT-SIGNATURE value.
 * Returns null for anything that isn't a valid, unexpired, HMAC-bound
 * evm/charge credential of ours — callers fall through to the plain paywall.
 *
 * @param {string} authorizationHeader - Full `Payment <b64url>` header value.
 * @param {{secretKey: string}} opts
 * @returns {string|null}
 */
export function translateCredential(authorizationHeader, { secretKey }) {
  return translateCredentialDetailed(authorizationHeader, { secretKey }).paymentSignature || null;
}

/** Same as translateCredential but says WHY it refused, as an RFC 9457 kind
 *  + buyer-safe detail: {paymentSignature} on success, {reject:{kind,detail}}
 *  otherwise. Exported for the shim test. */
export function translateCredentialDetailed(authorizationHeader, { secretKey }) {
  const reject = (kind, detail) => ({ reject: { kind, detail } });
  let credential;
  try {
    credential = Credential.deserialize(authorizationHeader);
  } catch {
    return reject("malformed-credential", "Credential is malformed: the Authorization: Payment value does not decode.");
  }
  const challenge = credential.challenge;
  if (challenge.method !== "evm" || challenge.intent !== "charge") return reject("method-unsupported", `Challenge method ${JSON.stringify(challenge.method)}/${JSON.stringify(challenge.intent)} is not evm/charge.`);
  // HMAC binding (spec: servers MUST bind ids to challenge params). This also
  // proves the echoed accepts entry in meta is ours and untampered.
  if (!Challenge.verify(challenge, { secretKey })) return reject("invalid-challenge", `Challenge "${challenge.id}" is invalid: not issued by this server or tampered.`);
  if (challenge.expires && Date.parse(challenge.expires) < Date.now()) return reject("invalid-challenge", `Challenge "${challenge.id}" is invalid: expired at ${challenge.expires}. Request the resource again for a fresh challenge.`);
  // Deserialized challenges keep the wire-shaped `opaque` (base64url JCS)
  // rather than a decoded `meta` — accept either.
  let meta = challenge.meta;
  if (!meta && challenge.opaque) {
    try {
      meta = PaymentRequest.deserialize(challenge.opaque);
    } catch {
      return reject("invalid-challenge", `Challenge "${challenge.id}" is invalid: opaque data does not decode.`);
    }
  }
  const acceptedJson = meta?.[META_ACCEPTS_KEY];
  if (!acceptedJson) return reject("invalid-challenge", `Challenge "${challenge.id}" is invalid: missing the x402 accepts binding.`);
  let accepted;
  try {
    accepted = JSON.parse(acceptedJson);
  } catch {
    return reject("invalid-challenge", `Challenge "${challenge.id}" is invalid: accepts binding is not JSON.`);
  }
  const payload = evm.AuthorizationPayloadSchema.safeParse(credential.payload);
  if (!payload.success) return reject("invalid-payload", "Credential payload does not match the evm/charge schema (from, to, value, validAfter, validBefore, nonce, signature).");
  const { from, to, value, validAfter, validBefore, nonce, signature } = payload.data;
  const authorization = { from, to, value, validAfter, validBefore, nonce };
  // mppx's encoder runs the payload through ITS zod schema, which STRIPS every
  // field its eip155-typed PaymentRequirements does not declare - and our
  // first accept declares `outputSchema` (src/accept-output-schema.js), which
  // the paywall deep-equals against the echoed `accepted`. So: validate the
  // shape through mppx exactly as before (a malformed payload still throws
  // here), then emit the same base64-JSON wire with the accept RAW - the
  // HMAC-bound bytes the client echoed, byte-exact what the paywall
  // advertised. Found 2026-09-02 by test-mpp-shim's native buy: the schema
  // strip turned every MPP payment into "no matching requirements".
  const validated = x402.Header.encodePaymentSignature({
    x402Version: 2,
    accepted,
    payload: { authorization, signature },
  });
  const canonical = JSON.parse(Buffer.from(validated, "base64").toString("utf8"));
  return {
    paymentSignature: Buffer.from(JSON.stringify({ ...canonical, accepted }), "utf8").toString("base64"),
    // Returned so the caller can run the EIP-712 domain diagnosis without
    // decoding the credential a second time (src/mpp-evm-domain.js).
    accepted,
    authorization,
    signature,
  };
}

/**
 * RECEIPT half: settled PAYMENT-RESPONSE → MPP Payment-Receipt value.
 *
 * @param {string} paymentResponseHeader - Encoded PAYMENT-RESPONSE value.
 * @returns {string|null}
 */
export function receiptFromPaymentResponse(paymentResponseHeader) {
  const settle = x402.Header.decodePaymentResponse(paymentResponseHeader);
  if (!settle.success) return null;
  return Receipt.serialize({
    method: "evm",
    status: "success",
    reference: settle.transaction,
    timestamp: new Date().toISOString(),
  });
}
