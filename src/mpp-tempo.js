// Tempo support for MPP — a SECOND, independent settlement path alongside
// mpp-shim.js's "evm" translation. Tempo (tempoxyz, Stripe+Paradigm-backed,
// EVM chain id 4217, live mainnet since 2026-03) is MPP's own native payment
// method, built on TIP-1034/TIP-20 primitives that are NOT EIP-3009 — so it
// cannot be translated into our existing x402 PAYMENT-SIGNATURE header the
// way "evm" (Base/Celo) is. No x402 facilitator anywhere supports Tempo
// (checked against docs.x402.org's own network-support page, 2026-08-17), so
// "add a RAILS chain + a facilitator client" — the pattern used for every
// other rail — is not available here.
//
// Instead this rides Tempo's own hosted MPP relay (api.tempo.xyz's
// /v1/mpp/validate + /v1/mpp/broadcast, exposed by mppx's `tempo.charge({
// relay })`), which splits cleanly into a non-mutating `validate` and a
// separate terminal `broadcast` — the same "check first, commit only after
// the handler succeeds" shape as @x402/express's own settlement-ordering
// invariant (see the "x402 settlement ordering" note in CLAUDE.md). We never
// hold a Tempo signing key: the relay broadcasts on our behalf, we only
// supply a receiving address.
//
// Scope: the one-shot `tempo.charge()` method only. Tempo also has a
// stateful session/channel protocol (TIP-1034, for pay-per-token streaming)
// — deliberately out of scope here; see the approved plan.
import { AsyncLocalStorage } from "node:async_hooks";
import { mppProblem, markMppProblem, sendMppProblem } from "./mpp-problem.js";
import { Challenge, Credential, Method, Receipt } from "mppx";
import { tempo } from "mppx/server";
import { mppChallengesSuppressed } from "./mpp-fallback.js";

const DEFAULT_DECIMALS = 6; // matches every other stablecoin rail this repo settles (unconfirmed specifically for pathUSD — decimals() unread, this is the USDC-family convention, not a live lookup)

// PathUSD — Tempo's predeployed-at-genesis, neutral quote-token stablecoin.
// VERIFIED (2026-08-17) against Tempo's own server-integration example at
// tempo.xyz/developers/docs/guide/machine-payments/server, which documents
// this exact address as "PathUSD on Tempo" — not an mppx README placeholder
// (an earlier version of this file treated it as unconfirmed and required
// TEMPO_CURRENCY to be set explicitly with no default; that caution turned
// out to be unnecessary once the primary source was actually read).
const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";

// Tempo mainnet (EVM chain id 4217) — mppx `defaults.chainId.mainnet`. Rides
// every challenge as `methodDetails.chainId` so a client with an
// `expectedChainId` pin can refuse a mismatch, and so the relay is never left
// to guess which network a credential targets.
const TEMPO_MAINNET_CHAIN_ID = 4217;

function envRecipient() {
  return process.env.TEMPO_RECIPIENT_ADDRESS || process.env.WALLET_ADDRESS || "";
}
// TEMPO_CURRENCY is a CSV of TIP-20 token addresses; ONE tempo/charge
// challenge is minted per entry, in order, and a stock mppx client pays the
// FIRST tempo challenge it can (it does not check balances across challenges,
// and auto-swap is off by default), so put the currency your buyers hold
// first. Measured 2026-08-18: 138 of 141 mpp.dev registry sellers quote
// USDC.e (0x20C0…8b50, mppx's own mainnet default) and PathUSD is mppx's
// TESTNET default - so the ecosystem's wallets hold USDC.e. The code default
// stays PathUSD (the currency the daily canary is funded in) until the
// operator flips the env; the canaries pay with autoSwap so a USDC.e-first
// config can be proven before the flip.
export const TEMPO_USDC_E_ADDRESS = "0x20C000000000000000000000b9537d11c60E8b50";
function envCurrencies() {
  const raw = (process.env.TEMPO_CURRENCY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = raw.length ? raw : [PATH_USD_ADDRESS];
  return [...new Set(list.map((c) => (c.toLowerCase() === "usdc" ? TEMPO_USDC_E_ADDRESS : c.toLowerCase() === "pathusd" ? PATH_USD_ADDRESS : c)))];
}
function envCurrency() {
  return envCurrencies()[0];
}
function envDecimals() {
  const n = Number(process.env.TEMPO_DECIMALS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DECIMALS;
}

/** Rollout switch — mirrors MPP_SECRET_KEY's own env-gated-no-op posture.
 *  Call-time read, never cached, like every other rollout knob in this repo.
 *  Currency now has a verified default (PathUSD) so only the key and a
 *  receiving address are required. */
export function tempoEnabled() {
  return !!(process.env.TEMPO_API_KEY && envRecipient());
}
/** Our own Tempo payTo, or null when the tempo method is not enabled - the
 *  MPP leaderboard ranks it as "this server" (self-flagged) so we are held
 *  to the same on-chain measure as everyone else. */
export function tempoSelfRecipient() {
  return tempoEnabled() && /^0x[0-9a-fA-F]{40}$/.test(envRecipient()) ? envRecipient() : null;
}

/** Discovery-surface accessor: the currency/decimals a Tempo challenge would
 *  actually use, for machine-readable metadata (x-payment-info, etc.) that
 *  wants to advertise the tempo method without duplicating the currency
 *  default/env-override logic. Returns null when disabled — callers must
 *  never advertise a method nobody can settle. */
export function tempoDiscoveryInfo() {
  if (!tempoEnabled()) return null;
  return { currency: envCurrency(), currencies: envCurrencies(), decimals: envDecimals() };
}

// Relay error visibility. mppx's Relay.js (node_modules/mppx/dist/tempo/
// server/Relay.js) throws a bare, argument-less failure() whenever
// /v1/mpp/validate or /v1/mpp/broadcast answers non-2xx — the response body
// is discarded before we ever see it, and Tempo's relay puts its actual
// verdict THERE on non-2xx (`{"error":{"code":"api_key_invalid",...}}`,
// 401/403 for key/scope problems, 400 for a malformed credential; measured
// against the live relay 2026-08-18). `.details.code` only ever populates on
// a 2xx-with-success:false, so three straight live rejections logged
// "details=(none)" and nothing distinguished "our key lacks mpp:write" from
// "the credential is bad". Relay.configure accepts its own `fetch`, so we
// hand it one that records any non-2xx relay response — and any 2xx that
// carries success:false, whose `message` mppx also drops — into the CURRENT
// request's trace (AsyncLocalStorage — concurrent buyers never see each
// other's errors) and otherwise passes the response through untouched. It
// reads a CLONE, so the SDK's own body read is unaffected, and it never
// changes the accept/reject decision, which stays with Method.validate/
// broadcastCredential. This replaces an earlier temporary double-request
// probe (same information, one relay round trip instead of two).
const relayTrace = new AsyncLocalStorage();
async function relayFetch(input, init) {
  const store = relayTrace.getStore();
  const started = Date.now();
  let res;
  try {
    res = await globalThis.fetch(input, init);
  } catch (e) {
    // The fetch itself failed — no HTTP verdict at all (socket closed by the
    // relay, reset, DNS, abort). mppx reports this as the same bare "Payment
    // verification failed" as a business rejection; the elapsed time is the
    // tell (a relay-side deadline closes the socket after a fixed wait).
    // Measured live 2026-08-18: broadcast=21816ms then this path.
    if (store) {
      let path = "";
      try { path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname; } catch { /* unlabelled */ }
      store.relayError = `relay ${path || "?"} NETWORK ERROR after ${Date.now() - started}ms: ${String(e?.cause?.code || e?.cause?.message || e?.message || e).slice(0, 160)}`;
    }
    throw e;
  }
  if (!store) return res;
  let body = "";
  try { body = (await res.clone().text()).replace(/\s+/g, " ").slice(0, 400); } catch { body = "(unreadable body)"; }
  // Non-2xx is always a verdict worth keeping. A 2xx is ALSO one when it says
  // success:false — mppx keeps only a fixed allowlist of `error.code` values
  // as `.details` and drops the message; a code outside it (the live relay
  // answers `code:"unknown"` with the real reason ONLY in `message`, e.g.
  // "Invalid transaction: no matching payment call found - amount: ...",
  // measured 2026-08-18) reaches us as a bare "Payment verification failed".
  let rejected2xx = false;
  if (res.ok) {
    try { const j = JSON.parse(body); rejected2xx = j && typeof j === "object" && (j.success === false || j.error != null); } catch { /* non-JSON 2xx: leave it */ }
  }
  if (!res.ok || rejected2xx) {
    let path = "";
    try { path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname; } catch { /* unlabelled */ }
    store.relayError = `relay ${path || "?"} HTTP ${res.status} ${body}`;
  }
  return res;
}
/** Runs `fn` with a fresh relay trace and returns `[result, trace]` — the
 *  trace carries `.relayError` when the relay answered non-2xx inside `fn`. */
async function withRelayTrace(fn) {
  const trace = {};
  try {
    return [await relayTrace.run(trace, fn), trace];
  } catch (e) {
    if (e && typeof e === "object") e.__relayTrace = trace;
    throw e;
  }
}
function describeRelayFailure(e) {
  // A 2xx-with-success:false rejection rides `.details` (the relay's own
  // error code, e.g. insufficient_funds/invalid_payment/policy_denied); a
  // non-2xx answer rides the trace captured by relayFetch. Show whichever
  // exists; both missing means the failure happened before any relay call
  // (HMAC/expiry/shape) or the relay was unreachable.
  const detail = e?.details && typeof e.details === "object" && Object.keys(e.details).length ? JSON.stringify(e.details).slice(0, 200) : null;
  const raw = e?.__relayTrace?.relayError || null;
  const message = String(e?.message || e).slice(0, 200);
  return `${message}${detail ? ` details=${detail}` : ""}${raw ? ` ${raw}` : ""}${!detail && !raw ? " (no relay verdict — failed before/without a relay round trip)" : ""}`;
}
/** The BUYER-facing reason: mppx's own message plus the relay's error CODE
 *  only. Never the raw relay body (`__relayTrace.relayError`) - that is an
 *  upstream response relayed verbatim into a public 402 problem document,
 *  and a relay that echoes our API key or account details in an error would
 *  hand it to every MPP buyer. describeRelayFailure (above) keeps the full
 *  trace for the operator log. (Leak audit 2026-08-19.) */
function buyerReason(e) {
  const code = e?.details && typeof e.details === "object" && typeof e.details.code === "string" ? e.details.code.slice(0, 60) : null;
  const message = String(e?.message || e || "Payment verification failed.").replace(/[\r\n]+/g, " ").slice(0, 120);
  return code ? `${message} (${code})` : message;
}

// The configured Method.Server is cheap to hold but not free to rebuild per
// request; memoize it, keyed on the config values that actually shape it so
// an env change (redeploy-time only, never mid-process) rebuilds cleanly.
let cachedMethod = null;
let cachedKey = "";

function tempoMethod() {
  const key = `${process.env.TEMPO_API_KEY || ""}|${envRecipient()}|${envCurrencies().join(",")}|${envDecimals()}|${process.env.TEMPO_API_BASE_URL || ""}`;
  if (cachedMethod && cachedKey === key) return cachedMethod;
  cachedMethod = tempo.charge({
    currency: envCurrency(),
    decimals: envDecimals(),
    recipient: envRecipient(),
    relay: {
      apiKey: process.env.TEMPO_API_KEY,
      fetch: relayFetch,
      ...(process.env.TEMPO_API_BASE_URL ? { apiBaseUrl: process.env.TEMPO_API_BASE_URL } : {}),
    },
  });
  cachedKey = key;
  return cachedMethod;
}

/** Mint an HMAC-bound `method: "tempo"` MPP challenge for a route's USD
 *  price. Returns null when the feature is disabled or a route has no
 *  parseable price — callers must never advertise a challenge nobody can
 *  actually settle. `secretKey` is the same MPP_SECRET_KEY the "evm" side
 *  already uses (one HMAC secret, not a second one to provision). */
export function mintTempoChallenge({ priceUsd, description, realm, secretKey, timeoutSeconds = 300 }) {
  if (!tempoEnabled()) return null;
  // No secret, no challenge: an HMAC over an empty key is a challenge anyone
  // can mint, and the inbound gate (checkTempoCredentialBinding) would then
  // have nothing to verify against. Same rollout switch as the evm shim.
  if (!secretKey) return null;
  const amount = Number(priceUsd);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const decimals = envDecimals();
  // Built through mppx's OWN challenge builder for this method
  // (Challenge.fromMethod -> the tempo/charge request schema), not a
  // hand-assembled `request` object, so the wire shape is byte-for-byte what
  // an mppx-native server emits: the schema takes a DECIMAL amount and emits
  // the base-units integer string ("0.001" -> "1000" at 6 decimals — the
  // format a real client needs; a decimal string on the wire made the client
  // throw "Cannot convert 0.001000 to a BigInt", caught live 2026-08-17),
  // DROPS `decimals` (a server-side parsing input, not a wire field), and
  // moves `chainId` under `methodDetails`. The first version of this
  // function assembled the request by hand and shipped `decimals` on the
  // wire with no `methodDetails.chainId` at all — a shape the SDK's own
  // builder never produces. Only the fields the SDK's request() hook would
  // add are supplied here: chainId (fixed — Tempo mainnet 4217, mppx's
  // `defaults.chainId.mainnet`); there is no local feePayer, so none is set
  // and the buyer pays their own fee, exactly as the hook would resolve it.
  const method = tempoMethod();
  const challenges = envCurrencies().map((currency) => Challenge.fromMethod(method, {
    realm,
    expires: new Date(Date.now() + timeoutSeconds * 1000),
    request: {
      amount: amount.toFixed(decimals),
      chainId: TEMPO_MAINNET_CHAIN_ID,
      currency,
      decimals,
      recipient: envRecipient(),
      ...(description ? { description: String(description).slice(0, 200) } : {}),
    },
    secretKey,
  }));
  return challenges.map((c) => Challenge.serialize(c)).join(", ");
}

/** Stable replay identity for a tempo credential — the challenge id it's
 *  bound to (HMAC-verified, single-purpose per 402). Mirrors
 *  replay-guard.js's paymentReplayKey() role for the x402 side. Returns
 *  null for anything unparseable (nothing to guard). */
export function tempoReplayKey(authorizationHeader) {
  try {
    const credential = Credential.deserialize(authorizationHeader);
    const id = credential?.challenge?.id;
    return typeof id === "string" && id ? `tempo:${id}` : null;
  } catch {
    return null;
  }
}

/** True when `authorizationHeader` deserializes to a WELL-FORMED credential
 *  bound to a `method: "tempo"` challenge — used to decide whether a request
 *  belongs on the Tempo path at all before doing anything mutating. Never
 *  throws; an unparseable header is simply "not ours". */
export function isTempoCredential(authorizationHeader) {
  if (typeof authorizationHeader !== "string" || !/^payment\s/i.test(authorizationHeader)) return false;
  try {
    const credential = Credential.deserialize(authorizationHeader);
    return credential?.challenge?.method === "tempo";
  } catch {
    return false;
  }
}

/** INBOUND BINDING - the check mppx's own docs say the host must perform
 *  ("validateCredential does not prove that the challenge was issued by a
 *  particular server; hosts that issue challenges must verify that binding
 *  separately") and that mppx's reference server performs before anything
 *  else. Before 2026-08-18 the Tempo gate did NOT: it handed the CLIENT-ECHOED
 *  challenge straight to Method.validateCredential / broadcastCredential, and
 *  with the relay configured those forward {challenge, payload} verbatim - the
 *  relay can only check that the signed transaction matches the challenge's
 *  OWN amount/recipient, never that WE minted it. So a buyer could forge a
 *  challenge for 1 base unit to any recipient (including themselves), sign a
 *  matching Tempo transaction, and be served any paid route for ~$0
 *  (found by the 2026-08-18 security review). Every one of these must hold:
 *    - Challenge.verify against MPP_SECRET_KEY (we minted this id),
 *    - realm is ours, expires is in the future,
 *    - request.currency is one we offer, request.recipient is our payTo,
 *      methodDetails.chainId is Tempo mainnet,
 *    - request.amount (base units) >= this ROUTE's price - a legitimately
 *      minted $0.001 challenge must not buy a $0.50 route (challenges are not
 *      path-bound on the wire, so the price is the binding),
 *    - the route HAS a price (a tempo credential buys nothing on a free route).
 *  Pure, synchronous, never throws. Exported for tests. */
export function checkTempoCredentialBinding(authorizationHeader, { secretKey, realm, priceFor, method, path, req = null, now = Date.now() } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  let credential;
  try { credential = Credential.deserialize(authorizationHeader); } catch { return bad("credential does not deserialize"); }
  const ch = credential?.challenge;
  if (!ch || ch.method !== "tempo" || (ch.intent || "charge") !== "charge") return bad("not a tempo/charge challenge");
  if (!secretKey) return bad("server has no MPP_SECRET_KEY - cannot verify the challenge binding");
  let verified = false;
  try { verified = Challenge.verify(ch, { secretKey }); } catch { verified = false; }
  if (!verified) return bad("challenge id does not HMAC-verify - not minted by this server");
  if (realm && ch.realm !== realm) return bad(`challenge realm ${JSON.stringify(ch.realm)} is not ours`);
  const exp = Date.parse(ch.expires);
  if (!Number.isFinite(exp) || exp <= now) return bad("challenge expired");
  const r = ch.request || {};
  const currencies = envCurrencies().map((c) => c.toLowerCase());
  if (!currencies.includes(String(r.currency || "").toLowerCase())) return bad("challenge currency is not one this server offers");
  if (String(r.recipient || "").toLowerCase() !== String(envRecipient()).toLowerCase()) return bad("challenge recipient is not this server's payTo");
  const chainId = Number(r.methodDetails?.chainId ?? r.chainId);
  if (chainId !== TEMPO_MAINNET_CHAIN_ID) return bad(`challenge chainId ${chainId} is not Tempo mainnet`);
  const item = typeof priceFor === "function" ? priceFor(method, path, req) : null;
  const priceUsd = Number(item?.priceUsd);
  if (!(priceUsd > 0)) return bad("route has no price - a tempo credential buys nothing here");
  // Security review 2026-08-19: the memory family / my-usage derive the
  // caller's identity from the SIGNED x402 payer; Tempo settles through the
  // relay with no payer this server verifies, so a tempo credential must never
  // reach those handlers (it would be served under whatever payer header the
  // request also carried).
  if (item.identityBound) return bad("this route is wallet-identity bound (the payment IS the identity); Tempo credentials carry no payer this server verifies - pay it over an x402 rail");
  if (item.longRunning) return bad("this route runs longer than a Tempo credential stays valid (settlement happens after the handler); pay it over an EVM x402 rail or by card");
  const expected = BigInt(Math.round(priceUsd * 10 ** envDecimals()));
  let amount;
  try { amount = BigInt(String(r.amount)); } catch { return bad("challenge amount is not an integer base-units string"); }
  if (amount < expected) return bad(`challenge amount ${amount} is below this route's price ${expected}`);
  // CLASSIFICATION-GRADE payer only (sales ledger / telemetry / internal-vs-
  // external), never identity: `source` is client-supplied (did:pkh) and this
  // server does not recover the tx signer to verify it. Spoofing it to a
  // burner address only hides the spoofer's own purchases from OUR revenue
  // stats; identity-bound routes refuse tempo credentials outright, so it can
  // never touch memory/my-usage. Same trust tier as the facilitator settle
  // receipt fallback in payer.js. Added 2026-08-20 — before this, tempo sales
  // recorded payer null and a self-funded test wallet classified as external.
  const src = String(credential?.source || "");
  const m = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(src);
  const payerHint = m ? m[1].toLowerCase() : null;
  return { ok: true, challenge: ch, amountAtomic: amount, expectedAtomic: expected, payerHint };
}

/** Non-mutating check (credential shape, relay pre-validation). The HMAC /
 *  route binding is checkTempoCredentialBinding above - this only asks the
 *  relay whether the signed transaction is valid FOR THE CHALLENGE IT CARRIES,
 *  which is necessary but never sufficient. Never broadcasts, never moves money. */
export async function validateTempoCredential(authorizationHeader) {
  try {
    const [validation] = await withRelayTrace(() => Method.validateCredential([tempoMethod()], authorizationHeader));
    return { ok: true, validation };
  } catch (e) {
    // mppx's VerificationFailedError.message is ALWAYS the bare "Payment
    // verification failed." — the relay's verdict is elsewhere; see
    // describeRelayFailure for where.
    return { ok: false, error: describeRelayFailure(e), reason: buyerReason(e) };
  }
}

/** Terminal — actually settles via Tempo's relay. Callers MUST only invoke
 *  this after a successful (<400) handler response; see the server wiring
 *  in server.js for the buffer-then-decide discipline this depends on. */
export async function broadcastTempoCredential(authorizationHeader) {
  try {
    const [receipt] = await withRelayTrace(() => Method.broadcastCredential([tempoMethod()], authorizationHeader));
    return { ok: true, receipt };
  } catch (e) {
    return { ok: false, error: describeRelayFailure(e), reason: buyerReason(e) };
  }
}

/** mppx's broadcastCredential already returns a properly-shaped
 *  Receipt.Receipt ({method:"tempo", status:"success", reference, timestamp})
 *  — this just serializes it for the Payment-Receipt header, same as
 *  mpp-shim.js's receiptFromPaymentResponse does for the evm side. */
export function tempoReceiptHeader(receipt) {
  try {
    return Receipt.serialize(receipt);
  } catch {
    return null;
  }
}

/** Reverse of the above — decodes OUR OWN Payment-Receipt response header
 *  back to its tx reference, for the sales-ledger tally in server.js (the
 *  same role txFromPaymentResponse plays for the x402 settle receipt). */
export function tempoTxFromReceiptHeader(header) {
  try {
    return Receipt.deserialize(String(header)).reference || null;
  } catch {
    return null;
  }
}

// Test-only hook: force the memoized method to rebuild on the next call.
export function __testResetMethodCache() {
  cachedMethod = null;
  cachedKey = "";
}

// ---------------------------------------------------------------------------
// Express wiring — two SEPARATE middlewares, both no-ops unless tempoEnabled().
// Deliberately not folded into mpp-shim.js: that file is a pure evm↔x402
// translator, and Tempo settles through a wholly different path (Tempo's own
// relay, never @x402/express). See server.js for exact mount order.
// ---------------------------------------------------------------------------

/** OUTBOUND: append a `method: "tempo"` challenge to a 402's WWW-Authenticate
 *  header, alongside whatever mpp-shim.js already put there for "evm". Reads
 *  the route's price via `priceFor` (server.js supplies a CATALOG lookup) —
 *  never invents a price, and mints nothing for a route it can't price.
 *  Returns null (mount nothing) when tempoEnabled() is false. */
export function createTempoChallengeAppender({ realm, secretKey, priceFor }) {
  if (!tempoEnabled()) return null;
  return function tempoChallengeAppender(req, res, next) {
    const origWriteHead = res.writeHead;
    res.writeHead = function tempoWriteHead(...args) {
      try {
        // A client that has proven it signs EIP-3009 under the wrong token
        // domain is being steered to our x402 path, and that only works if
        // the 402 carries NO Payment challenge at all - so the tempo half is
        // withheld too, not just the evm one. See src/mpp-fallback.js.
        if (res.statusCode === 402 && !mppChallengesSuppressed(req)) {
          const item = priceFor(req.method, req.path, req);
          // Identity-bound routes (wallet-keyed memory, my-usage) are paid
          // with the payer AS the identity; a tempo credential carries no
          // verified payer, so no tempo challenge is offered for them.
          if (item && !item.identityBound && !item.longRunning) {
            const header = mintTempoChallenge({
              priceUsd: item.priceUsd,
              description: item.description,
              realm,
              secretKey,
            });
            if (header) {
              const existing = res.getHeader("WWW-Authenticate");
              res.setHeader("WWW-Authenticate", existing ? `${existing}, ${header}` : header);
            }
          }
        }
      } catch {
        // Additive only — never let challenge-minting break the response.
      }
      return origWriteHead.apply(this, args);
    };
    next();
  };
}

/** INBOUND: the settlement gate itself. Buffers the real route handler's
 *  response (mirrors @x402/express's own writeHead/write/end/flushHeaders
 *  buffering, node_modules/@x402/express/dist/esm/index.mjs) so broadcast —
 *  the terminal, money-moving call — only ever happens AFTER a successful
 *  (<400) handler response. A non-tempo request is untouched: this is a
 *  no-op unless the Authorization header is a well-formed tempo credential.
 *  `validate`/`broadcast` are injectable (default to the real relay-backed
 *  functions above) so the ordering invariant — handler runs before
 *  broadcast, broadcast only on a successful handler — can be proven in a
 *  fast, deterministic offline test without needing Tempo's real relay wire
 *  format, same pattern mpp-index.js uses for its own injectable `verify`.
 *
 *  `replayGuard` (optional but always passed by server.js in production) is
 *  a src/replay-guard.js instance — dedicated to Tempo, never shared with
 *  the x402 one, since credential identity spaces never collide. THIS gate
 *  bypasses the whole PoW/replay-guard/x402mw dispatcher (that guard only
 *  understands EIP-3009 nonces), so without a Tempo-specific claim here, one
 *  signed credential fired concurrently at the same route could trigger N
 *  free handler executions before Tempo's relay rejects the (N-1) duplicate
 *  broadcasts at settlement time — the same "Five Attacks on x402" Attack II
 *  class replay-guard.js documents, just unguarded on this second path. */
export function createTempoGate({ validate = validateTempoCredential, broadcast = broadcastTempoCredential, confirmSettlement = null, replayGuard, secretKey, realm, priceFor } = {}) {
  if (!tempoEnabled()) return null;
  // Fail CLOSED on the binding inputs: a gate that cannot verify "we minted
  // this challenge for this price" must not exist, because its existence is
  // what lets a tempo credential bypass the whole x402/PoW dispatcher.
  if (!secretKey || typeof priceFor !== "function") {
    console.error("[mpp-tempo] REFUSING to mount the Tempo gate: secretKey (MPP_SECRET_KEY) and priceFor are required to bind credentials to minted challenges and route prices");
    return null;
  }
  return function tempoGate(req, res, next) {
    const auth = req.headers.authorization;
    if (!isTempoCredential(auth)) return next();

    // Binding FIRST, before any relay round trip: is this a challenge we
    // minted, unexpired, for our payTo, in a currency we offer, on Tempo
    // mainnet, for at least this route's price? Anything else falls through
    // to a fresh 402 exactly like an invalid evm credential.
    const binding = checkTempoCredentialBinding(auth, { secretKey, realm, priceFor, method: req.method, path: req.path, req });
    if (!binding.ok) {
      console.warn(`[mpp-tempo] credential rejected before validate(): ${binding.reason}`);
      // Not a tempo credential at all -> not our verdict to give (the evm
      // shim ahead of us already judged it). Everything else is a rejection
      // of OUR challenge binding: say so in the 402's problem+json body.
      if (binding.reason !== "not a tempo/charge challenge") {
        const kind = /does not deserialize/.test(binding.reason) ? "malformed-credential"
          : /amount .* below/.test(binding.reason) ? "payment-insufficient"
          : "invalid-challenge";
        markMppProblem(req, res, mppProblem(kind, kind === "malformed-credential" ? "Credential is malformed: the Authorization: Payment value does not decode." : `Challenge is invalid: ${binding.reason}. Request the resource again for a fresh challenge.`));
      }
      return next();
    }

    const t0 = Date.now();
    validate(auth).then(async (v) => {
      const tValidated = Date.now();
      if (!v.ok) {
        // Loud on ambiguity, same doctrine as facilitator-diagnostics.js —
        // an unlogged rejection here is exactly what made the 2026-08-17
        // live-verify failure undiagnosable from Railway logs alone.
        // v.error is already truncated to 300 chars by validateTempoCredential
        // and is the relay/mppx SDK's own message, never a secret we hold.
        console.warn(`[mpp-tempo] credential rejected by validate(): ${v.error || "(no error detail)"}`);
        // Fall through to a fresh 402 (same as an invalid evm credential) -
        // whose body now says verification-failed with the relay's reason.
        markMppProblem(req, res, mppProblem("verification-failed", `Payment verification failed: ${String(v.reason || "the Tempo relay rejected the credential").slice(0, 160)}`));
        return next();
      }

      // Claim the credential's identity BEFORE the handler runs — the whole
      // point is to close the concurrent-replay window, not just the
      // sequential one. Release-on-failure (handler fails, broadcast fails)
      // so a legitimate retry of the still-valid credential still works.
      // Mark the request as paid over MPP/tempo BEFORE the handler runs, so
      // handlers that route by the buyer's payment rail (route-execute's
      // chain-matched external leg) can see it - a tempo credential carries
      // no x402 payment header for buyerPaymentNetwork() to read.
      req.mppTempoCredential = true;
      // Classification-grade payer for the sales ledger (see the binding
      // check's payerHint comment) — read at the recordSale site in server.js.
      req.mppTempoPayer = binding.payerHint || null;
      const replayKey = replayGuard ? tempoReplayKey(auth) : null;
      if (replayGuard && replayKey) {
        const verdict = await replayGuard.begin(replayKey);
        if (verdict !== "ok") {
          // Spec shape for a spent/in-flight credential: 402 + fresh challenge
          // (the outbound tempo hook appends one at writeHead) + problem+json
          // invalid-challenge - not a bare 409 an MPP client cannot act on.
          return sendMppProblem(res, mppProblem("invalid-challenge", `Challenge is invalid: this credential was already used or is in flight (${verdict}). Request the resource again for a fresh challenge.`));
        }
      }
      const releaseReplay = () => { if (replayGuard && replayKey) replayGuard.release(replayKey).catch(() => {}); };
      const settleReplay = () => { if (replayGuard && replayKey) replayGuard.settle(replayKey).catch(() => {}); };

      // From here on, money can move — buffer the handler's response and
      // decide after it completes. Bypass every x402-specific gate
      // downstream (PoW/replay-guard/x402mw): none of it applies to a
      // credential that was never an x402 payment header.
      req.tempoSettling = true;
      // The tempo credential is the ONLY payment evidence on this request.
      // Drop any x402 payment header that rode alongside it: the dispatcher
      // skips x402 verification for a tempo-settling request, so such a
      // header is unverified, yet payerFromRequest() would read its
      // authorization.from as the payer (memory identity, my-usage,
      // idempotency seeding, telemetry). Security review 2026-08-19.
      for (const h of ["payment-signature", "x-payment", "payment-identifier"]) delete req.headers[h];

      // Buffering mechanics verified against node_modules/@x402/express's
      // own paymentVerified branch (dist/esm/index.mjs) rather than
      // reinvented: while res.end is overridden to only buffer, Node's real
      // 'finish' event NEVER fires (the underlying socket write never
      // happens) — so the synchronization primitive has to be an explicit
      // promise resolved INSIDE the buffered res.end, not res.on("finish").
      const originalWriteHead = res.writeHead.bind(res);
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);
      // flushHeaders MUST be buffered too (as @x402/express does): Node's
      // flushHeaders() calls writeHead() internally, so an unwrapped
      // flushHeaders on a streaming handler (the LLM gateway's SSE writer)
      // committed the headers early and the later replay of the buffered
      // writeHead threw ERR_HTTP_HEADERS_SENT AFTER broadcast - buyer charged,
      // response never finished (found by the 2026-08-18 security review).
      const originalFlushHeaders = typeof res.flushHeaders === "function" ? res.flushHeaders.bind(res) : null;
      let bufferedCalls = [];
      let settled = false;
      let endCalled;
      const endPromise = new Promise((resolve) => { endCalled = resolve; });
      const restore = () => {
        settled = true;
        res.writeHead = originalWriteHead;
        res.write = originalWrite;
        res.end = originalEnd;
        if (originalFlushHeaders) res.flushHeaders = originalFlushHeaders;
      };
      res.writeHead = (...a) => { if (!settled) { bufferedCalls.push(["writeHead", a]); return res; } return originalWriteHead(...a); };
      res.write = (...a) => { if (!settled) { bufferedCalls.push(["write", a]); return true; } return originalWrite(...a); };
      res.end = (...a) => { if (!settled) { bufferedCalls.push(["end", a]); endCalled(); return res; } return originalEnd(...a); };
      if (originalFlushHeaders) res.flushHeaders = () => { if (!settled) { bufferedCalls.push(["flushHeaders", []]); return; } return originalFlushHeaders(); };
      const replay = () => {
        for (const [fn, a] of bufferedCalls) {
          if (fn === "writeHead") originalWriteHead(...a);
          else if (fn === "write") originalWrite(...a);
          else if (fn === "flushHeaders") { if (originalFlushHeaders) originalFlushHeaders(); }
          else originalEnd(...a);
        }
        bufferedCalls = [];
      };

      try {
        next(); // dispatch into the rest of the chain / the real route handler
      } catch (err) {
        restore();
        releaseReplay();
        return next(err);
      }

      await endPromise; // resolves once the (buffered) handler tries to end its response

      if (res.statusCode >= 400) {
        // Handler failed — never broadcast, buyer was never going to be
        // charged, same invariant as every other rail.
        restore();
        replay();
        releaseReplay();
        return;
      }
      const tHandled = Date.now();
      let b = await broadcast(auth);
      const tBroadcast = Date.now();
      const timing = `validate=${tValidated - t0}ms handler=${tHandled - tValidated}ms broadcast=${tBroadcast - tHandled}ms`;
      if (!b.ok && confirmSettlement) {
        // The relay's verdict and the chain's truth can diverge: on
        // 2026-08-20 the relay reported "Broadcast transaction hash does not
        // match the signed transaction" for two payments that had SETTLED
        // (an AgentCore/Privy buyer whose signature carries a yParity-style
        // v byte the node normalizes — canonical txid != keccak(submitted)).
        // Answering 402 then is a charged-but-failed the buyer retries into
        // a double charge. So before discarding the response, ask the CHAIN
        // whether this credential's own transaction landed (the txid commits
        // to the signed bytes — exact binding, no window heuristics; see
        // tempo-confirm.js). Verification, never a re-broadcast: nothing is
        // submitted, so this can never double-charge — the stellar-confirm
        // doctrine on the MPP rail. Fails closed: null keeps the 402.
        const confirmed = await Promise.resolve(confirmSettlement(auth)).catch(() => null);
        if (confirmed) {
          console.warn(`[mpp-tempo] relay reported settlement failure but the credential's transaction SETTLED on-chain (${req.method} ${req.path} tx=${confirmed.txId}) — honouring the settlement that happened (verified from the chain, nothing re-broadcast). Relay said: ${b.error} [${timing} confirm=${Date.now() - tBroadcast}ms]`);
          b = { ok: true, receipt: { method: "tempo", status: "success", reference: confirmed.txId, timestamp: new Date().toISOString() } };
        }
      }
      if (!b.ok) {
        // Broadcast failed AFTER a successful handler — discard the
        // buffered body and answer 402, mirroring @x402/express's own
        // "settlement of a <400 response fails → discard, return 402".
        // LOUD, with per-phase timing: this path was silent through the
        // first live settlement on 2026-08-18, where the buyer's first
        // credential spent 23s here and got a bare 402 with nothing in our
        // logs (only the HTTP access log showed a 23,341ms 402), and the
        // client's retry then settled. Timing matters on this rail: mppx
        // clients sign pull credentials with validBefore = now + 25s, so a
        // slow relay broadcast races the credential's own expiry — a
        // "settlement failed" here is as likely to be OUR latency as the
        // relay's verdict, and only the numbers tell them apart.
        console.warn(`[mpp-tempo] broadcast failed AFTER a successful handler (${req.method} ${req.path}) — buyer answered 402, not charged by us: ${b.error} [${timing}]`);
        bufferedCalls = [];
        restore();
        sendMppProblem(res, mppProblem("verification-failed", `Payment verification failed: Tempo settlement was not accepted (${String(b.reason || "no relay detail").slice(0, 160)}).`));
        releaseReplay();
        return;
      }
      console.log(`[mpp-tempo] settled ${req.method} ${req.path} tx=${b.receipt?.reference || "?"} [${timing}]`);
      const receiptHeader = tempoReceiptHeader(b.receipt);
      restore();
      if (receiptHeader) res.setHeader("Payment-Receipt", receiptHeader);
      settleReplay();
      // Settlement-attribution flag for server.js's shared per-catalog-route
      // stats tally (mounted much later in the chain, after this gate) — a
      // Tempo settlement carries no PAYMENT-RESPONSE header (no @x402/express
      // involvement), so without this it would fall through that code's
      // default and get mislabeled as plain x402.
      req.tempoSettled = true;
      try {
        replay();
      } catch (err) {
        // A throw HERE is after the buyer was charged. Re-entering the chain
        // with next() would be wrong (headers may be committed) and would
        // leave the response hanging with the sale unrecorded; end it loudly
        // instead so the charged-failure detection can see a finished response.
        console.error(`[mpp-tempo] CHARGED-BUT-NOT-SERVED: replay of the buffered response threw after settlement (${req.method} ${req.path} tx=${b.receipt?.reference || "?"}): ${String(err?.message || err).slice(0, 300)}`);
        try { if (!res.writableEnded) { if (!res.headersSent) res.status(500); res.end(); } } catch { /* nothing left to do */ }
      }
    }).catch((err) => {
      console.warn(`[mpp-tempo] gate threw: ${String(err?.message || err).slice(0, 300)}`);
      // Only fall through when nothing has been committed or settled; after
      // settlement the response must be ended, never re-dispatched.
      if (req.tempoSettled || res.headersSent) { try { if (!res.writableEnded) res.end(); } catch { /* ignore */ } return; }
      next();
    });
  };
}
