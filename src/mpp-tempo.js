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
// A buyer whose connection closes before the handler's answer could be sent
// is not broadcast while the run holds a hang-up forgiveness ticket
// (src/hangup-settlement.js): the gate checks for it after the handler and
// before the broadcast, answers 499, and keeps the credential spent so it
// cannot buy a second run. Without a ticket, and for a close that lands while
// the broadcast itself is in flight, the charge goes through and server.js
// books it as owed in the refund ledger.
//
// Two credential kinds pay (credential.payload.type): "transaction" (PULL, a
// signed transaction the relay broadcasts after the handler, as above) and
// "hash" (PUSH, a transfer the buyer already sent). A push transfer is on
// chain before the request arrives, so the gate finalizes it BEFORE the
// handler and every undelivered answer on it is booked as owed.
//
// Scope: the one-shot `tempo.charge()` method only. Tempo also has a
// stateful session/channel protocol (TIP-1034, for pay-per-token streaming)
// — deliberately out of scope here; see the approved plan.
import { AsyncLocalStorage } from "node:async_hooks";
import { mppProblem, markMppProblem, sendMppProblem } from "./mpp-problem.js";
import { Challenge, Credential, Method, Receipt } from "mppx";
import { tempo } from "mppx/server";
import { mppChallengesSuppressed, clientFingerprint } from "./mpp-fallback.js";
import { TxEnvelopeTempo, SignatureEnvelope, KeyAuthorization } from "ox/tempo";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { Abis, Addresses } from "viem/tempo";
import { chargeCancelledForClientGone, CLIENT_GONE_TEXT } from "./hangup-settlement.js";
import { tempoPushSender } from "./tempo-confirm.js";

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

// Bounded relay retry (2026-09-24). Relay calls have hit UND_ERR_CONNECT_TIMEOUT
// (undici's 10 s connect bound) and ended in a bare 402 after 10-22 s.
//   - VALIDATE is non-mutating, so ANY transport failure, a per-attempt
//     timeout, or a 502/503/504 is retried, up to TEMPO_RELAY_VALIDATE_ATTEMPTS
//     (default 2, max 3), each attempt bounded by TEMPO_RELAY_VALIDATE_TIMEOUT_MS.
//   - BROADCAST moves money, so it is retried ONCE and only for a failure that
//     provably happened before the request left this process: a connect-phase
//     error (the TCP/TLS connection was never established, so the relay never
//     saw the bytes). mppx also sends an idempotency-key on every broadcast. Any
//     other broadcast failure keeps today's path: chain-truth confirm, then 402.
const CONNECT_PHASE_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
function transportCode(e) {
  return String(e?.cause?.code || e?.code || e?.cause?.cause?.code || e?.name || "");
}
/** True when a fetch failure provably happened before any request bytes were
 *  sent (exported for tests). */
export function isConnectPhaseError(e) {
  return CONNECT_PHASE_CODES.has(String(e?.cause?.code || "")) || CONNECT_PHASE_CODES.has(String(e?.code || "")) || CONNECT_PHASE_CODES.has(String(e?.cause?.cause?.code || ""));
}
function validateAttempts() {
  const n = Number(process.env.TEMPO_RELAY_VALIDATE_ATTEMPTS);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 3) : 2;
}
function validateTimeoutMs() {
  const n = Number(process.env.TEMPO_RELAY_VALIDATE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6000;
}
function pathOf(input) {
  try { return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname; } catch { return ""; }
}

async function relayFetch(input, init = {}) {
  const store = relayTrace.getStore();
  const path = pathOf(input);
  const isValidate = /\/v1\/mpp\/validate$/.test(path);
  const isBroadcast = /\/v1\/mpp\/broadcast$/.test(path);
  const maxAttempts = isValidate ? validateAttempts() : isBroadcast ? 2 : 1;
  const started = Date.now();
  let res;
  for (let attempt = 1; ; attempt++) {
    if (store) store.relayAttempts = attempt;
    try {
      const signals = [];
      if (init.signal) signals.push(init.signal);
      if (isValidate) signals.push(AbortSignal.timeout(validateTimeoutMs()));
      res = await globalThis.fetch(input, signals.length ? { ...init, signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : init);
      if (isValidate && attempt < maxAttempts && (res.status === 502 || res.status === 503 || res.status === 504)) {
        try { await res.arrayBuffer(); } catch { /* drained */ }
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      break;
    } catch (e) {
      const retryable = attempt < maxAttempts && (isValidate || (isBroadcast && isConnectPhaseError(e)));
      if (retryable) { await new Promise((r) => setTimeout(r, 200)); continue; }
      // The fetch itself failed — no HTTP verdict at all (socket closed by the
      // relay, reset, DNS, abort). mppx reports this as the same bare "Payment
      // verification failed" as a business rejection; the elapsed time is the
      // tell (a relay-side deadline closes the socket after a fixed wait).
      // Measured live 2026-08-18: broadcast=21816ms then this path.
      if (store) {
        store.networkError = true;
        store.connectPhase = isConnectPhaseError(e);
        store.relayError = `relay ${path || "?"} NETWORK ERROR after ${Date.now() - started}ms: ${String(transportCode(e) || e?.cause?.message || e?.message || e).slice(0, 160)} (attempts ${attempt})`;
      }
      throw e;
    }
  }
  if (!store) return res;
  if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) store.relayUnavailable = res.status;
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

/** One reason class per relay / verify refusal, and the buyer-facing words for
 *  it. The raw relay body is READ here to pick the class (pattern match) and is
 *  never copied out: `detail` and `hint` are fixed strings from this table, so
 *  the buyerReason safety rule (no upstream body in a public 402) holds. The
 *  2026-09-20 first-session refusal said only "Payment verification failed"
 *  while the relay had said "memo is not bound to this challenge"; the buyer
 *  could not act on the first and could on the second. Exported for tests. */
export const TEMPO_REFUSAL_CLASSES = Object.freeze({
  "relay-unreachable": {
    kind: "internal-payment-error", status: 503, retryAfter: 5,
    detail: "The Tempo payment relay could not be reached, so the credential was not checked and nothing was charged.",
    hint: "Retry the same request in a few seconds with a fresh challenge. Nothing was broadcast.",
  },
  "relay-unavailable": {
    kind: "internal-payment-error", status: 503, retryAfter: 30,
    detail: "The Tempo payment relay is not accepting requests from this server right now, so the credential was not checked and nothing was charged.",
    hint: "Retry shortly, or pay over another method offered in the WWW-Authenticate header (x402 USDC or MPP evm/charge).",
  },
  "memo-unbound": {
    kind: "verification-failed", status: 402,
    detail: "The transfer's memo is not bound to this challenge: it must carry this server's realm fingerprint and a value derived from the challenge id you are paying.",
    hint: "Sign against the tempo challenge in the 402 you were just issued (realm agent402.tools). A challenge fetched earlier, one from another origin, or a hand-built memo will not match. Request the resource again and pay the fresh challenge.",
  },
  "transfer-mismatch": {
    kind: "verification-failed", status: 402,
    detail: "The signed transaction does not contain a transfer of exactly the challenge amount, in the challenge currency, to the challenge recipient.",
    hint: "Pay request.amount (base units) of request.currency to request.recipient exactly as the challenge states; do not round the amount or pay in another token.",
  },
  "insufficient-funds": {
    kind: "verification-failed", status: 402,
    detail: "The paying wallet does not hold enough of the challenge currency on Tempo (chain 4217) to cover the amount and fee.",
    hint: "Fund the wallet with the challenge currency (USDC.e) on Tempo mainnet, or pay over another method in the WWW-Authenticate header.",
  },
  expired: {
    kind: "payment-expired", status: 402,
    detail: "The credential's validity window closed before it could be checked.",
    hint: "Request the resource again and send the signed credential promptly; do not reuse a credential signed earlier.",
  },
  replay: {
    kind: "invalid-challenge", status: 402,
    detail: "This credential or its transaction was already used.",
    hint: "Request the resource again for a fresh challenge and sign a new credential; a credential pays for one request only.",
  },
  "simulation-failed": {
    kind: "verification-failed", status: 402,
    detail: "The signed transaction failed simulation on Tempo, so it would not settle.",
    hint: "Check the wallet's balance and that the transaction pays the challenge exactly, then pay a fresh challenge.",
  },
  "policy-denied": {
    kind: "verification-failed", status: 402,
    detail: "The Tempo relay declined this payment under its own policy.",
    hint: "Pay over another method offered in the WWW-Authenticate header.",
  },
  unknown: {
    kind: "verification-failed", status: 402,
    detail: "Payment verification failed.",
    hint: "Request the resource again and pay the fresh challenge; if it keeps failing, pay over another method in the WWW-Authenticate header.",
  },
});

export function classifyTempoRefusal(e) {
  const trace = e?.__relayTrace || {};
  const code = e?.details && typeof e.details === "object" && typeof e.details.code === "string" ? e.details.code : "";
  const raw = String(trace.relayError || "");
  const text = `${String(e?.message || "")} ${code} ${raw}`.toLowerCase();
  if (trace.networkError) return "relay-unreachable";
  if (trace.relayUnavailable) return "relay-unavailable";
  if (/memo is not bound/.test(text)) return "memo-unbound";
  if (/already[ _]used|already been used|already been submitted|nonce too low/.test(text)) return "replay";
  if (/insufficient[ _]funds|insufficient balance|exceeds balance/.test(text)) return "insufficient-funds";
  if (/\bexpired\b|validbefore|valid before/.test(text)) return "expired";
  if (/no matching (payment call|transfer)/.test(text)) return "transfer-mismatch";
  if (/simulation[ _]failed|reverted/.test(text)) return "simulation-failed";
  if (/policy[ _]denied|screen[ _]rejected/.test(text)) return "policy-denied";
  if (/temporarily[ _]unavailable/.test(text)) return "relay-unavailable";
  return "unknown";
}

/** The problem document for a refusal class. The class also rides in
 *  `details.reason` so a client can switch on it without parsing prose. */
export function tempoRefusalProblem(cls, fallbackReason) {
  const c = TEMPO_REFUSAL_CLASSES[cls] || TEMPO_REFUSAL_CLASSES.unknown;
  const detail = cls === "unknown" && fallbackReason
    ? `Payment verification failed: ${String(fallbackReason).slice(0, 160)}`
    : c.detail;
  return mppProblem(c.kind, detail, { status: c.status, hint: c.hint, details: { reason: cls in TEMPO_REFUSAL_CLASSES ? cls : "unknown", charged: false } });
}

// Operator log line for EVERY refused Tempo credential: reason class, route,
// amount and timings. Never the payer address or any credential material; the
// relay's own words (describeRelayFailure) ride along with addresses masked.
function maskAddresses(s) {
  return String(s || "").replace(/did:pkh:[^\s"']+/gi, "did:pkh:<masked>").replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, "0x<addr>");
}
export function logTempoRefusal(req, { cls, amountAtomic = null, timings = {}, detail = "" } = {}) {
  const t = Object.entries(timings).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => `${k}=${v}ms`).join(" ");
  const line = `[mpp-tempo] refused class=${cls} route="${req?.method || "?"} ${req?.path || "?"}" amount=${amountAtomic == null ? "?" : String(amountAtomic)}${t ? ` ${t}` : ""}${detail ? ` detail=${maskAddresses(detail).slice(0, 400)}` : ""}`;
  console.warn(line);
  return line;
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

/** How long a push credential's sender read may take before it names
 *  nobody (the same bound tempoPushSender applies to its RPC call). */
export const PUSH_SENDER_WAIT_MS = 3000;

/** The transaction hash a PUSH credential names (lowercased), else null.
 *  The evidence a refund-owed row for an unclaimed push transfer is keyed on. */
export function pushHashOf(authorizationHeader) {
  try {
    const p = Credential.deserialize(authorizationHeader)?.payload;
    const h = p?.type === "hash" ? String(p.hash || "").toLowerCase() : "";
    return /^0x[0-9a-f]{64}$/.test(h) ? h : null;
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
  // Only the two credential kinds that pay: a signed transaction for the
  // relay to broadcast (pull), or the hash of a transfer the buyer already
  // sent (push). A "proof" credential moves no money and is valid only for a
  // zero-amount challenge, which this server never mints; refusing it here
  // costs the caller nothing.
  const payloadType = credential?.payload?.type;
  if (payloadType !== "transaction" && payloadType !== "hash") return bad(`credential payload type ${JSON.stringify(payloadType ?? null)} does not pay this challenge`);
  // CLASSIFICATION-GRADE payer only (sales ledger / telemetry / internal-vs-
  // external), never identity and never a per-buyer key: `source` is
  // client-supplied (did:pkh) and is not checked against the signer. Spoofing
  // it to a burner address only hides the spoofer's own purchases from OUR
  // revenue stats; identity-bound routes refuse tempo credentials outright,
  // so it can never touch memory/my-usage; and every per-buyer bound keys on
  // the verified sender (inspectTempoSender below) instead. Same trust tier as
  // the facilitator settle receipt fallback in payer.js. Added 2026-08-20 —
  // before this, tempo sales recorded payer null and a self-funded test wallet
  // classified as external.
  const src = String(credential?.source || "");
  const m = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(src);
  const payerHint = m ? m[1].toLowerCase() : null;
  // A route whose handler spends before the buyer's payment settles (it pays
  // an outside seller from our own wallet, or runs long upstream work) takes a
  // pull credential only from a sender the gate can verify (see the gate).
  const verifiedSenderRequired = item.verifiedSenderRequired === true;
  return { ok: true, challenge: ch, amountAtomic: amount, expectedAtomic: expected, payerHint, payloadType, verifiedSenderRequired };
}

// ---------------------------------------------------------------------------
// The sender of a pull credential, and whether it is VERIFIED.
//
// A Tempo transaction names its sender in more than one way, and only some of
// them are proven by the signature. Decoding the transaction (ox
// TxEnvelopeTempo.deserialize) yields a `from` that is:
//   - for a secp256k1 envelope, the address recovered from the signature over
//     the sender's sign payload (proven);
//   - for a p256 / webAuthn envelope, the address of the public key the
//     envelope CARRIES (proven only once that signature is checked against
//     that key);
//   - for a keychain envelope, the account the envelope NAMES (the signature
//     is by an access key; the account is proven only if that key is active
//     for it on chain, or if the transaction itself carries the account's
//     own authorization of that key and the chain holds no record of the key:
//     the first use of a new access key, before any transaction installed it);
//   - for a multisig envelope, the account it names;
//   - and, whatever the envelope, an address placed in the fee-payer slot,
//     taken as written.
// A per-buyer bound keys on a sender only when it is VERIFIED here; otherwise
// it keys on the client IP (the callers' own fallback), never on an
// unverified sender.
// ---------------------------------------------------------------------------
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const lcAddress = (a) => (typeof a === "string" && ADDRESS_RE.test(a) ? a.toLowerCase() : null);
const PRIMITIVE_ENVELOPES = new Set(["secp256k1", "p256", "webAuthn"]);

/** Does a key authorization carried inline by a keychain transaction prove
 *  that `account` authorized `accessKey`? It must authorize exactly that key,
 *  for the key type that signed, on Tempo mainnet (or chain 0, which the
 *  protocol reads as every chain), unexpired at `now`, bound to no other
 *  account, and be signed by the account's OWN key (a primitive signature
 *  that recovers to the account and verifies). Offline; never throws. */
function inlineAuthorizationProves(ka, { account, accessKey, keyType, now }) {
  try {
    if (!ka || lcAddress(ka.address) !== accessKey || ka.type !== keyType) return false;
    const chainId = BigInt(ka.chainId);
    if (chainId !== BigInt(TEMPO_MAINNET_CHAIN_ID) && chainId !== 0n) return false;
    if (ka.expiry != null && !(Number(ka.expiry) > Math.floor(now / 1000))) return false;
    if (ka.account !== undefined && lcAddress(ka.account) !== account) return false;
    const s = ka.signature;
    if (!s || !PRIMITIVE_ENVELOPES.has(s.type)) return false;
    const payload = KeyAuthorization.getSignPayload(ka);
    if (lcAddress(SignatureEnvelope.extractAddress({ payload, signature: s })) !== account) return false;
    return SignatureEnvelope.verify(s, { address: account, payload }) === true;
  } catch {
    return false;
  }
}

/** Who a pull credential says paid, and what its signature proves.
 *  Returns { claimed, verified, envelope, keychain, reason }:
 *    claimed  - the sender the transaction names (NEVER a key for a bound);
 *    verified - the same address once the signature proves it, else null;
 *    keychain - { account, accessKey, inlineAuthorization } for a keychain
 *               envelope whose access key signature verifies; whether that
 *               key is authorized for the account is an on-chain read
 *               (verifyTempoKeychainSender), so the account is not verified
 *               here. inlineAuthorization is true when the transaction also
 *               carries the account's own authorization of that key
 *               (inlineAuthorizationProves), which the read accepts only
 *               while the chain holds no record of the key. Else null.
 *  Offline and synchronous; never throws. Exported for tests. */
export function inspectTempoSender(authorizationHeader, { now = Date.now() } = {}) {
  const out = { claimed: null, verified: null, envelope: null, keychain: null, reason: "" };
  let payload;
  try { payload = Credential.deserialize(authorizationHeader)?.payload; } catch { return { ...out, reason: "credential does not decode" }; }
  if (payload?.type !== "transaction" || typeof payload.signature !== "string") return { ...out, reason: "not a pull credential" };
  const raw = payload.signature;
  if (!/^0x7[68](?:[0-9a-fA-F]{2})+$/.test(raw)) return { ...out, reason: "not a Tempo transaction" };
  let tx;
  try { tx = TxEnvelopeTempo.deserialize(raw); } catch { return { ...out, reason: "transaction does not decode" }; }
  const sig = tx?.signature;
  out.claimed = lcAddress(tx?.from);
  out.envelope = typeof sig?.type === "string" ? sig.type : null;
  if (!out.claimed || !sig) return { ...out, reason: "transaction names no sender" };
  try {
    const signPayload = TxEnvelopeTempo.getSignPayload(TxEnvelopeTempo.from(tx));
    if (PRIMITIVE_ENVELOPES.has(sig.type)) {
      // SignatureEnvelope.verify binds the address itself for all three types
      // (recovery for secp256k1, the carried key's address for p256/webAuthn);
      // the recovered-signer compare is kept beside it as a belt.
      const signer = lcAddress(SignatureEnvelope.extractAddress({ payload: signPayload, signature: sig }));
      if (signer === out.claimed && SignatureEnvelope.verify(sig, { address: out.claimed, payload: signPayload })) return { ...out, verified: out.claimed, reason: "signature" };
      return { ...out, reason: "the signature does not prove the named sender" };
    }
    if (sig.type === "keychain") {
      const account = lcAddress(sig.userAddress);
      if (account !== out.claimed) return { ...out, reason: "the keychain account is not the named sender" };
      const inner = sig.inner;
      if (!inner || !PRIMITIVE_ENVELOPES.has(inner.type)) return { ...out, reason: "unsupported access key signature" };
      // Keychain V2 binds the account into what the access key signs; V1 does not.
      const keyPayload = sig.version === "v1" ? signPayload : TxEnvelopeTempo.getSignPayload(TxEnvelopeTempo.from(tx), { from: account });
      const accessKey = lcAddress(SignatureEnvelope.extractAddress({ payload: keyPayload, signature: inner }));
      if (!accessKey || !SignatureEnvelope.verify(inner, { address: accessKey, payload: keyPayload })) return { ...out, reason: "the access key signature does not verify" };
      // Signed by the account's own key: that proves the account outright.
      if (accessKey === account) return { ...out, verified: account, reason: "signature" };
      if (!tx.keyAuthorization) return { ...out, keychain: { account, accessKey, inlineAuthorization: false }, reason: "access key authorization not checked" };
      const inlineAuthorization = inlineAuthorizationProves(tx.keyAuthorization, { account, accessKey, keyType: inner.type, now });
      return { ...out, keychain: { account, accessKey, inlineAuthorization }, reason: inlineAuthorization ? "access key authorized in this transaction" : "the key authorization it carries does not prove the account" };
    }
  } catch {
    return { ...out, reason: "the signature does not verify" };
  }
  return { ...out, reason: `${out.envelope || "unknown"} envelope` };
}

/** The VERIFIED sender of a pull credential when its signature alone proves
 *  it (lowercased address), else null: a push credential, anything that does
 *  not decode, a keychain or multisig envelope, or a sender the signature
 *  does not prove. A keychain sender is verified only through
 *  verifyTempoKeychainSender (an on-chain read). Never throws. Exported for
 *  tests. */
export function tempoSenderOf(authorizationHeader) {
  return inspectTempoSender(authorizationHeader).verified;
}

function accessKeyTimeoutMs() {
  const n = Number(process.env.TEMPO_ACCESS_KEY_CHECK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 2500;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** What the AccountKeychain precompile holds for `accessKey` on `account`:
 *  one eth_call (getKey), the read mppx's own isActiveAccessKey makes.
 *    "active"     - present, unrevoked, unexpired;
 *    "absent"     - no record at all (an empty key id, not revoked);
 *    "revoked", "expired", "mismatch" (a record for another key id);
 *    "unreadable" - a timeout, an RPC error, a malformed address or result.
 *  Never throws. Exported for tests. */
export async function tempoAccessKeyState({ account, accessKey } = {}, {
  rpcUrl = process.env.TEMPO_RPC_URL || "https://rpc.tempo.xyz",
  fetchImpl = globalThis.fetch,
  timeoutMs = accessKeyTimeoutMs(),
  now = Date.now(),
} = {}) {
  const acct = lcAddress(account);
  const key = lcAddress(accessKey);
  if (!acct || !key) return "unreadable";
  try {
    const data = encodeFunctionData({ abi: Abis.accountKeychain, functionName: "getKey", args: [acct, key] });
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: Addresses.accountKeychain, data }, "latest"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return "unreadable";
    const body = await res.json();
    if (!body || body.error || typeof body.result !== "string") return "unreadable";
    const k = decodeFunctionResult({ abi: Abis.accountKeychain, functionName: "getKey", data: body.result });
    const keyId = lcAddress(k?.keyId);
    if (!keyId || typeof k.isRevoked !== "boolean") return "unreadable";
    if (k.isRevoked) return "revoked";
    if (keyId === key) return BigInt(k.expiry) > BigInt(Math.floor(now / 1000)) ? "active" : "expired";
    return keyId === ZERO_ADDRESS ? "absent" : "mismatch";
  } catch {
    return "unreadable";
  }
}

/** Is `accessKey` an active (present, unrevoked, unexpired) access key of
 *  `account` on Tempo? tempoAccessKeyState read as a yes/no; fails closed.
 *  Exported for tests. */
export async function tempoAccessKeyActive(keychain = {}, opts = {}) {
  return (await tempoAccessKeyState(keychain, opts)) === "active";
}

/** A cached, deduplicated and concurrency-bounded keychain check. Resolves to
 *  the account (lowercased) when its access key is active on chain, or when
 *  the chain holds no record of the key and the credential carries the
 *  account's own authorization of it (keychain.inlineAuthorization, checked
 *  offline by inspectTempoSender); else null. A revoked, expired or
 *  unreadable key is never accepted. Never rejects. `check` resolves to a
 *  tempoAccessKeyState word (true reads as "active"). An active key is
 *  remembered for `ttlMs`, any other state for `negativeTtlMs`; a remembered
 *  "absent" is not reused for a credential WITHOUT an inline authorization
 *  (the key may have been installed since), which reads again. Past
 *  `maxInFlight` concurrent reads the answer is null without a read
 *  (unverified, never a guess). Exported for tests. */
export function createKeychainSenderVerifier({ check = tempoAccessKeyState, ttlMs = 60_000, negativeTtlMs = 15_000, maxInFlight = 16, maxEntries = 5000 } = {}) {
  const cache = new Map(); // "account:key" -> { state, until }
  const inFlight = new Map(); // "account:key" -> Promise<state>
  const stateOf = (v) => (v === true || v === "active" ? "active" : typeof v === "string" ? v : "inactive");
  return async function verifyKeychainSender(keychain, now = Date.now()) {
    const account = lcAddress(keychain?.account);
    const accessKey = lcAddress(keychain?.accessKey);
    if (!account || !accessKey) return null;
    const inline = keychain.inlineAuthorization === true;
    const decide = (state) => (state === "active" || (state === "absent" && inline) ? account : null);
    const k = `${account}:${accessKey}`;
    const hit = cache.get(k);
    if (hit && hit.until > now && (hit.state !== "absent" || inline)) return decide(hit.state);
    let p = inFlight.get(k);
    if (!p) {
      if (inFlight.size >= maxInFlight) return null;
      p = Promise.resolve().then(() => check({ account, accessKey })).then(stateOf, () => "unreadable");
      inFlight.set(k, p);
      p.then((state) => {
        inFlight.delete(k);
        cache.delete(k);
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(k, { state, until: Date.now() + (state === "active" ? ttlMs : negativeTtlMs) });
      });
    }
    return decide(await p);
  };
}
const verifyTempoKeychainSenderDefault = createKeychainSenderVerifier();
/** The production keychain check (TEMPO_RPC_URL, cached). */
export function verifyTempoKeychainSender(keychain) {
  return verifyTempoKeychainSenderDefault(keychain);
}

/** Reason class + buyer words for a binding refusal (checked before any relay
 *  call). The detail is the binding check's own sentence (our words, never an
 *  upstream body); the class and hint make it actionable. Exported for tests. */
export function bindingRefusal(reason) {
  const r = String(reason || "");
  const fresh = "Request the resource again for a fresh challenge from this server and pay that one.";
  if (/does not deserialize/.test(r)) return { cls: "malformed", kind: "malformed-credential", detail: "Credential is malformed: the Authorization: Payment value does not decode.", hint: undefined };
  if (/HMAC/.test(r)) return { cls: "not-minted-here", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}.`, hint: `The challenge id is not one this server issued (a challenge copied from another server, or edited). ${fresh}` };
  if (/realm/.test(r)) return { cls: "wrong-realm", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}.`, hint: fresh };
  if (/expired/.test(r)) return { cls: "expired", kind: "payment-expired", detail: `Challenge is invalid: ${r}.`, hint: `Challenges are valid for a few minutes. ${fresh}` };
  if (/currency/.test(r)) return { cls: "wrong-currency", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}.`, hint: `Pay one of the currencies named in this server's tempo challenges (USDC.e first). ${fresh}` };
  if (/recipient/.test(r)) return { cls: "wrong-recipient", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}.`, hint: `The challenge must name this server's Tempo payTo as recipient. ${fresh}` };
  if (/chainId/.test(r)) return { cls: "wrong-chain", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}.`, hint: `Tempo payments here are on Tempo mainnet (chain 4217). ${fresh}` };
  if (/amount .* below/.test(r)) return { cls: "amount-too-low", kind: "payment-insufficient", detail: `Challenge is invalid: ${r}.`, hint: `A challenge is priced for the route it was issued on; pay the challenge from this route's own 402. ${fresh}` };
  if (/not an integer/.test(r)) return { cls: "malformed-amount", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}.`, hint: fresh };
  if (/identity bound|runs longer/.test(r)) return { cls: "method-unsupported", kind: "method-unsupported", detail: `Challenge is invalid: ${r}.`, hint: undefined };
  if (/payload type/.test(r)) return { cls: "malformed", kind: "malformed-credential", detail: `Credential is malformed: ${r}.`, hint: "Pay the tempo challenge with a signed transaction or the hash of the transfer you sent." };
  if (/no price/.test(r)) return { cls: "no-price", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}.`, hint: "This route is free; call it without a payment." };
  return { cls: "invalid-challenge", kind: "invalid-challenge", detail: `Challenge is invalid: ${r}. Request the resource again for a fresh challenge.`, hint: undefined };
}

/** The refusal a pull credential meets on a route that requires a verified
 *  sender (checkTempoCredentialBinding's verifiedSenderRequired) when its
 *  signer is not proven. Answered before any relay call; nothing charged.
 *  Exported for tests. */
export const TEMPO_SENDER_UNVERIFIED = Object.freeze({
  cls: "sender-unverified",
  kind: "verification-failed",
  detail: "This route accepts a Tempo pull credential only when its signature proves the paying account: signed by the account's own key, or by an access key that is active for that account on Tempo or that the transaction authorizes with the account's own key. This credential's signer could not be verified, so it was not sent for validation and nothing was charged.",
  hint: "Pay with a credential signed by the account's key, or by an access key that is active on chain or carries the account's authorization for it, or pay this route over another method offered in the WWW-Authenticate header.",
});

/** Best-effort amount (base units) from a credential, for the refusal log only. */
function amountOfCredential(authorizationHeader) {
  try { return String(Credential.deserialize(authorizationHeader)?.challenge?.request?.amount ?? "?"); } catch { return "?"; }
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
    return { ok: false, error: describeRelayFailure(e), reason: buyerReason(e), cls: classifyTempoRefusal(e) };
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
    return { ok: false, error: describeRelayFailure(e), reason: buyerReason(e), cls: classifyTempoRefusal(e) };
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
/** Test seam: the relay fetch wrapper under a fresh trace. */
export async function __testRelayFetch(url, init) {
  const trace = {};
  try { return { res: await relayTrace.run(trace, () => relayFetch(url, init)), trace }; }
  catch (error) { return { error, trace }; }
}
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
/** Whether a route is offered a tempo challenge at all. ONE predicate, read by
 *  the 402 appender below and by the /openapi.json discovery offers, so the
 *  document never promises a method the live 402 withholds. Identity-bound
 *  routes are paid with the payer AS the identity and a tempo credential
 *  carries no verified payer; long-running routes outlive a pull credential. */
export function tempoOfferedFor(item) {
  return !!item && !item.identityBound && !item.longRunning;
}

// Challenge ORDER. mppx picks the first challenge it has a method for (ties on
// its own preference weights break on header order) and never falls back to
// the next one when a credential is refused. So the tempo challenge leads the
// header - an agent holding Tempo funds and a Base wallet pays over Tempo -
// EXCEPT for a client whose tempo credential the relay just refused (an empty
// Tempo balance is the common case): that client would pick tempo again on
// every retry and never reach the Base challenge it can pay. For a while after
// such a refusal it gets the old order, evm first. Keyed like the wrong-domain
// steering (ip + User-Agent); an empty User-Agent is never keyed.
const TEMPO_DEMOTE_MS = Number(process.env.MPP_TEMPO_DEMOTE_MS || 30 * 60 * 1000);
const TEMPO_DEMOTE_MAX = 2000;
const tempoDemoted = new Map(); // fingerprint -> expiresAt
export function noteTempoRefusal(req, now = Date.now()) {
  const key = clientFingerprint(req);
  if (!key) return false;
  if (tempoDemoted.size >= TEMPO_DEMOTE_MAX) {
    for (const [k, exp] of tempoDemoted) if (exp <= now) tempoDemoted.delete(k);
    if (tempoDemoted.size >= TEMPO_DEMOTE_MAX) tempoDemoted.delete(tempoDemoted.keys().next().value);
  }
  tempoDemoted.set(key, now + TEMPO_DEMOTE_MS);
  return true;
}
export function tempoLeads(req, now = Date.now()) {
  const key = clientFingerprint(req);
  if (!key) return true;
  const exp = tempoDemoted.get(key);
  if (!exp) return true;
  if (exp <= now) { tempoDemoted.delete(key); return true; }
  return false;
}
/** Test seam only. */
export function _resetTempoDemotion() { tempoDemoted.clear(); }

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
          if (tempoOfferedFor(item)) {
            const header = mintTempoChallenge({
              priceUsd: item.priceUsd,
              description: item.description,
              realm,
              secretKey,
            });
            if (header) {
              const existing = res.getHeader("WWW-Authenticate");
              res.setHeader("WWW-Authenticate", !existing ? header : tempoLeads(req) ? `${header}, ${existing}` : `${existing}, ${header}`);
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
export function createTempoGate({ validate = validateTempoCredential, broadcast = broadcastTempoCredential, confirmSettlement = null, earlyConfirm = null, replayGuard, secretKey, realm, priceFor, preValidate = null, verifyKeychainSender = verifyTempoKeychainSender, pushSender = tempoPushSender, onPushNotClaimed = null, onPushInputRefused = null, pushClaimAllowed = null } = {}) {
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
    const tStart = Date.now();
    if (!isTempoCredential(auth)) {
      // A "Payment" credential that does not even deserialize belongs to no
      // gate (the evm shim cannot read it either) and used to leave no line at
      // all - the 2026-09-20 553 ms refusal. Log it; evm credentials, which
      // deserialize fine, are the shim's to judge and are not logged here.
      if (typeof auth === "string" && /^payment\s/i.test(auth)) {
        let undecodable = false;
        try { Credential.deserialize(auth); } catch { undecodable = true; }
        if (undecodable) logTempoRefusal(req, { cls: "malformed", timings: { total: Date.now() - tStart } });
      }
      return next();
    }

    // Binding FIRST, before any relay round trip: is this a challenge we
    // minted, unexpired, for our payTo, in a currency we offer, on Tempo
    // mainnet, for at least this route's price? Anything else falls through
    // to a fresh 402 exactly like an invalid evm credential.
    const binding = checkTempoCredentialBinding(auth, { secretKey, realm, priceFor, method: req.method, path: req.path, req });
    if (!binding.ok) {
      // Not a tempo credential at all -> not our verdict to give (the evm
      // shim ahead of us already judged it). Everything else is a rejection
      // of OUR challenge binding: say so in the 402's problem+json body, with
      // a reason class and a next step.
      if (binding.reason !== "not a tempo/charge challenge") {
        const b = bindingRefusal(binding.reason);
        logTempoRefusal(req, { cls: b.cls, amountAtomic: amountOfCredential(auth), timings: { total: Date.now() - tStart }, detail: `before validate: ${binding.reason}` });
        markMppProblem(req, res, mppProblem(b.kind, b.detail, { hint: b.hint, details: { reason: b.cls, charged: false } }));
      }
      return next();
    }

    // The request's own input is checked BEFORE the relay round trip. A paid
    // call whose body the handler would refuse with a 400 used to spend ~1.2 s
    // on relay validation first (2026-09-23, a first paid call): nothing was
    // charged, but the buyer waited for a verdict the input had already
    // decided. Only a credential that has already passed the binding check
    // reaches this, so an unpaid request still gets its 402 first - the same
    // order as x402, where an unpaid bad body is a 402 and a paid one reaches
    // the handler's 400. Answered here: nothing validated, nothing broadcast.
    // Not for a PUSH credential: its transfer is already on chain, so "not
    // charged" would be false. It is input-checked below, after the relay has
    // confirmed the transfer and BEFORE the hash is claimed.
    if (typeof preValidate === "function" && binding.payloadType !== "hash") {
      let bad = null;
      try { bad = preValidate(req); } catch { bad = null; }
      if (bad && bad.status >= 400 && bad.status < 500) {
        logTempoRefusal(req, { cls: "input-invalid", amountAtomic: binding.amountAtomic, timings: { total: Date.now() - tStart }, detail: String(bad.body?.error || "").slice(0, 160) });
        res.setHeader("Cache-Control", "no-store");
        return res.status(bad.status).json({ ...bad.body, charged: false });
      }
    }

    // WHO PAID (pull credentials only; a push transfer is on chain before
    // this request and is finalized before the handler). The signature proves
    // a primitive-key sender outright. A keychain sender is proven by an
    // on-chain read of its access key (active, or absent with the account's
    // own authorization carried inline), started here beside relay validation.
    // A route that spends before the buyer's payment settles
    // (verifiedSenderRequired) waits for that proof and refuses a pull
    // credential without it, before any relay call. Every other route keys its
    // bounds on the keychain account only if the read has answered by the time
    // validation has, else on the client IP: no added latency, and never an
    // unverified sender.
    const isPull = binding.payloadType === "transaction";
    const senderInfo = isPull ? inspectTempoSender(auth) : null;
    const signedSender = senderInfo?.verified || null;
    let keychainSender = null;
    let keychainRead = null;
    if (isPull && !signedSender && senderInfo.keychain && typeof verifyKeychainSender === "function") {
      keychainRead = Promise.resolve().then(() => verifyKeychainSender(senderInfo.keychain)).then((a) => lcAddress(a), () => null);
      keychainRead.then((a) => { keychainSender = a; });
    }
    const SENDER_REFUSED = Symbol("sender-refused");
    let t0 = Date.now();
    const senderGate = isPull && binding.verifiedSenderRequired && !signedSender
      ? (keychainRead || Promise.resolve(null)).then((a) => !!a)
      : Promise.resolve(true);
    senderGate.then((allowed) => {
      if (!allowed) {
        logTempoRefusal(req, { cls: TEMPO_SENDER_UNVERIFIED.cls, amountAtomic: binding.amountAtomic, timings: { total: Date.now() - tStart }, detail: `before validate: ${senderInfo?.envelope || "?"} envelope, ${senderInfo?.reason || "no sender"}${keychainRead ? "; the chain read did not vouch for the key" : ""}` });
        noteTempoRefusal(req);
        markMppProblem(req, res, mppProblem(TEMPO_SENDER_UNVERIFIED.kind, TEMPO_SENDER_UNVERIFIED.detail, { hint: TEMPO_SENDER_UNVERIFIED.hint, details: { reason: TEMPO_SENDER_UNVERIFIED.cls, charged: false } }));
        next();
        return SENDER_REFUSED;
      }
      t0 = Date.now();
      return validate(auth);
    }).then(async (v) => {
      if (v === SENDER_REFUSED) return;
      const tValidated = Date.now();
      if (!v.ok) {
        // Loud on ambiguity, same doctrine as facilitator-diagnostics.js —
        // an unlogged rejection here is exactly what made the 2026-08-17
        // live-verify failure undiagnosable from Railway logs alone.
        const cls = v.cls || "unknown";
        logTempoRefusal(req, { cls, amountAtomic: binding.amountAtomic, timings: { validate: tValidated - t0, total: tValidated - tStart }, detail: v.error || "(no error detail)" });
        const c = TEMPO_REFUSAL_CLASSES[cls] || TEMPO_REFUSAL_CLASSES.unknown;
        if (c.status === 503) {
          // The relay could not be reached (or refused OUR key) before the
          // credential was checked: not the buyer's fault, nothing charged,
          // retryable. A 503 with Retry-After says that; a bare 402 after a
          // 10-22 s wait said "your payment failed". No demotion: the buyer's
          // Tempo credential was never judged.
          res.setHeader("Retry-After", String(c.retryAfter || 5));
          return sendMppProblem(res, tempoRefusalProblem(cls));
        }
        // This client's next 402 lists the evm challenge first (see tempoLeads).
        noteTempoRefusal(req);
        // Fall through to a fresh 402 (same as an invalid evm credential) -
        // whose body now says verification-failed with the reason class.
        markMppProblem(req, res, tempoRefusalProblem(cls, v.reason));
        return next();
      }

      // Claim the credential's identity BEFORE the handler runs — the whole
      // point is to close the concurrent-replay window, not just the
      // sequential one. Released only when the handler itself fails (>= 400,
      // nothing of value produced) so a legitimate retry of the still-valid
      // credential still works; once a handler has produced a <400 the
      // credential stays spent whatever happens next.
      // Mark the request as paid over MPP/tempo BEFORE the handler runs, so
      // handlers that route by the buyer's payment rail (route-execute's
      // chain-matched external leg) can see it - a tempo credential carries
      // no x402 payment header for buyerPaymentNetwork() to read.
      req.mppTempoCredential = true;
      // Classification-grade payer for the sales ledger (see the binding
      // check's payerHint comment) — read at the recordSale site in server.js.
      req.mppTempoPayer = binding.payerHint || null;
      // The VERIFIED sender (see inspectTempoSender; null for a push
      // credential and for any sender the signature or the chain did not
      // prove), which per-buyer bounds key on instead of the hint. With null,
      // every bound falls back to the client IP.
      req.mppTempoSender = signedSender || keychainSender || null;
      // The payer the sales ledger and a refund-owed row name: a sender the
      // signature, the keychain read or (push) the chain proved, never the
      // client-written `source` hint. Filled in once the payment settles;
      // null when nothing proved one (the row then names nobody, and a manual
      // refund reads the payer off the transaction the row records).
      req.mppTempoLedgerPayer = req.mppTempoSender;
      const replayKey = replayGuard ? tempoReplayKey(auth) : null;
      if (replayGuard && replayKey) {
        const verdict = await replayGuard.begin(replayKey);
        if (verdict !== "ok") {
          logTempoRefusal(req, { cls: "replay", amountAtomic: binding.amountAtomic, timings: { validate: tValidated - t0, total: Date.now() - tStart }, detail: `replay guard: ${verdict}` });
          // Spec shape for a spent/in-flight credential: 402 + fresh challenge
          // (the outbound tempo hook appends one at writeHead) + problem+json
          // invalid-challenge - not a bare 409 an MPP client cannot act on.
          return sendMppProblem(res, mppProblem("invalid-challenge", `Challenge is invalid: this credential was already used or is in flight (${verdict}).`, { hint: TEMPO_REFUSAL_CLASSES.replay.hint, details: { reason: "replay", charged: false } }));
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
      for (const h of ["payment-signature", "x-payment", "payment-identifier", "x-pow-solution"]) delete req.headers[h];

      // PUSH credential: the buyer already SENT the transfer (mppx push mode,
      // chosen by a json-rpc account: sendTransaction first, then the hash as
      // the credential), and validate just confirmed it pays this challenge.
      // The money moved before this request arrived, so nothing is left to
      // decide after the handler: finalize now (the relay claims the hash, so
      // it can never pay for a second request), mark the request settled, and
      // let the handler answer directly. An answer that is not delivered - a
      // handler >= 400, or a buyer gone before the first byte - is then a
      // charge on a settled payment, and server.js books it as owed. Before
      // this, such a credential was never finalized and never booked: a real
      // transfer with no record, and a buyer told nothing was charged.
      if (binding.payloadType === "hash") {
        // The input check, now that the relay has confirmed the transfer and
        // BEFORE finalize claims it. A body the handler would refuse used to
        // be finalized first and then booked as a charged failure and an owed
        // refund. Nothing is claimed yet, so the same credential still pays
        // for this request once the body is corrected (until the challenge
        // expires): say so, and release the replay key so it can.
        // Bounded here as well as inside tempoPushSender: an injected reader
        // gets the same ceiling, and a read past it names nobody.
        const readPushSender = async () => {
          if (typeof pushSender !== "function") return null;
          let timer = null;
          try {
            const bound = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PUSH_SENDER_WAIT_MS); timer.unref?.(); });
            return lcAddress(await Promise.race([Promise.resolve().then(() => pushSender(auth)), bound]));
          } catch { return null; } finally { if (timer) clearTimeout(timer); }
        };
        const pushHash = pushHashOf(auth);
        req.mppTempoPushHash = pushHash;
        const pushAmountUsd = Number(binding.amountAtomic) / 10 ** envDecimals();
        if (typeof preValidate === "function") {
          let bad = null;
          try { bad = preValidate(req); } catch { bad = null; }
          if (bad && bad.status >= 400 && bad.status < 500) {
            releaseReplay();
            // Until it is claimed we hold the buyer's money for nothing, and
            // they may never come back: book it as owed now. A later claim
            // that is served voids the row (see src/tempo-push-debts.js).
            let owed = false;
            if (typeof onPushInputRefused === "function") {
              const payer = await readPushSender();
              try { owed = (await onPushInputRefused(req, { hash: pushHash, payer, amountAtomic: String(binding.amountAtomic), amountUsd: pushAmountUsd, status: bad.status })) === true; } catch { owed = false; }
            }
            logTempoRefusal(req, { cls: "input-invalid", amountAtomic: binding.amountAtomic, timings: { validate: tValidated - t0, total: Date.now() - tStart }, detail: `push credential, transfer not claimed (${owed ? "booked as owed until claimed" : "no debt booked"}): ${String(bad.body?.error || "").slice(0, 160)}` });
            res.setHeader("Cache-Control", "no-store");
            return res.status(bad.status).json({ ...bad.body, charged: false, transferClaimed: false, payment: `The transfer you sent has not been claimed. Send this request again with a corrected body and the same credential before the challenge expires (${binding.challenge?.expires || "see the challenge"}) and it pays for that request.${owed ? " Until then it is recorded as owed to the sender." : ""}` });
          }
        }
        // A transfer whose debt is already being refunded (or was) no longer
        // pays for a request: claiming it now would serve AND refund it.
        if (typeof pushClaimAllowed === "function" && pushHash) {
          let allowed = true;
          try { allowed = (await pushClaimAllowed(pushHash)) !== false; } catch { allowed = true; }
          if (!allowed) {
            settleReplay();
            logTempoRefusal(req, { cls: "push-refunded", amountAtomic: binding.amountAtomic, timings: { validate: tValidated - t0, total: Date.now() - tStart }, detail: `push transfer ${pushHash} is refunded or being refunded` });
            return sendMppProblem(res, mppProblem("invalid-challenge", "The transfer this credential names has been refunded (or is being refunded), so it no longer pays for a request.", { status: 402, hint: "Request the resource again and pay the fresh challenge.", details: { reason: "refunded", transferClaimed: false } }));
          }
        }
        const tFinal0 = Date.now();
        const f = await broadcast(auth);
        if (!f.ok) {
          const fcls = f.cls || "unknown";
          logTempoRefusal(req, { cls: `finalize:${fcls}`, amountAtomic: binding.amountAtomic, timings: { validate: tValidated - t0, finalize: Date.now() - tFinal0, total: Date.now() - tStart }, detail: f.error || "" });
          const fc = TEMPO_REFUSAL_CLASSES[fcls] || TEMPO_REFUSAL_CLASSES.unknown;
          if (fc.status === 503) {
            // The relay could not be reached: the hash is NOT claimed, so the
            // same credential can be presented again.
            releaseReplay();
            res.setHeader("Retry-After", String(fc.retryAfter || 5));
            return sendMppProblem(res, mppProblem(fc.kind, "The Tempo payment relay could not be reached to claim the transfer you sent. It has not been claimed, so it still pays for this request.", { status: 503, hint: "Retry the same request with the same credential in a few seconds.", details: { reason: fcls, transferClaimed: false } }));
          }
          settleReplay();
          // The relay confirmed a transfer paying this challenge to our
          // recipient, and it was not claimed for this request. Unless the
          // relay says the hash was already claimed (it paid for an earlier
          // request), that transfer is money we hold for nothing delivered:
          // book it as owed before answering, keyed on the hash.
          let owed = false;
          if (fcls !== "replay" && typeof onPushNotClaimed === "function") {
            const payer = await readPushSender();
            const hash = pushHash;
            try { owed = (await onPushNotClaimed(req, { hash, payer, amountAtomic: String(binding.amountAtomic), amountUsd: pushAmountUsd, cls: fcls })) === true; } catch { owed = false; }
            console.warn(`[mpp-tempo] CHARGED-BUT-NOT-SERVED: push transfer confirmed by the relay could not be claimed (${req.method} ${req.path} tx=${hash || "?"} reason=${fcls}) - ${owed ? "recorded as owed in the refund ledger" : "NOT recorded"}`);
          }
          return sendMppProblem(res, mppProblem(fc.kind, `The transfer this credential names could not be claimed for this request: ${fc.detail}${owed ? " The transfer was received and is recorded as owed to the sender." : ""}`, { status: 402, hint: fc.hint, details: { reason: fcls, ...(owed ? { refundOwed: true } : {}) } }));
        }
        const receiptHeader = tempoReceiptHeader(f.receipt);
        if (receiptHeader) res.setHeader("Payment-Receipt", receiptHeader);
        // THE HANDLER NEVER WAITS ON THE SENDER READ (2026-09-28). It is one
        // Tempo RPC round trip (bounded at PUSH_SENDER_WAIT_MS) and was awaited
        // here, so an honest buyer waited on it whenever the RPC was slow. It
        // now runs beside the handler; only the bookings that name the payer
        // (the sale, a debt) wait for it, at finish (server.js
        // whenTempoLedgerPayerKnown). A read that fails or times out leaves
        // the payer null, as before.
        req.mppTempoLedgerPayerRead = readPushSender().then((p) => {
          if (p) req.mppTempoLedgerPayer = p;
          req.mppTempoLedgerPayerReadDone = true;
          return p;
        });
        settleReplay();
        req.tempoSettled = true;
        console.log(`[mpp-tempo] settled push credential before the handler ${req.method} ${req.path} tx=${f.receipt?.reference || "?"} [validate=${tValidated - t0}ms finalize=${Date.now() - tFinal0}ms]`);
        return next();
      }

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
      // A client that hangs up before the handler's answer could be sent is
      // NOT broadcast while the run holds a granted forgiveness ticket
      // (src/hangup-settlement.js): the buyer could not have received
      // anything, so nothing is charged, and the credential stays spent so it
      // cannot buy a second run. Without a ticket (the budget is spent) the
      // credential is broadcast as usual and the undelivered charge is booked
      // as owed in the refund ledger; so is a close that lands while the
      // broadcast itself is in flight. Same rule as every other rail.
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
      // The buyer left before anything could reach them and the run holds a
      // forgiveness ticket: do not broadcast. The credential stays spent (it
      // cannot buy a second run); the 499 goes through the hang-up hook's
      // res.end wrapper. Without a ticket, fall through to the broadcast.
      if (chargeCancelledForClientGone(req)) {
        bufferedCalls = [];
        restore();
        settleReplay();
        console.warn(`[mpp-tempo] client gone before the handler's answer could be sent (${req.method} ${req.path}) - not broadcast, not charged`);
        try { res.removeHeader("Content-Length"); res.statusCode = 499; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: CLIENT_GONE_TEXT, charged: false })); } catch { /* socket already gone */ }
        return;
      }
      const tHandled = Date.now();
      // EARLY CONFIRM. The relay answers a broadcast ~2 s after the payment is
      // in a block (measured 2026-10-08: broadcast p50 ~4.1 s, inclusion ~1.5 s
      // after submit). The relay stays the only broadcaster; alongside it,
      // the chain is read for THIS credential's own transaction (the txid
      // commits to the signed bytes, the memo to this challenge, the log to
      // currency, recipient and amount, and its block must be finalized:
      // tempo-confirm.js), and whichever proves settlement first answers. Nothing is submitted, so
      // this can never charge twice; the watcher stops when the relay answers.
      let b;
      let early = false;
      const watch = {};
      if (earlyConfirm) {
        let relayAnswered = false;
        const relayP = Promise.resolve(broadcast(auth)).then((r) => { relayAnswered = true; return r; }, (e) => { relayAnswered = true; throw e; });
        const chainP = Promise.resolve(earlyConfirm(auth, () => relayAnswered, watch)).catch((e) => { watch.error = watch.error || String(e?.message || e).slice(0, 60); return null; })
          .then((c) => (c ? c : new Promise(() => {})));
        const first = await Promise.race([relayP.then((r) => ({ relay: r })), chainP.then((c) => ({ chain: c }))]);
        if (first.chain) {
          early = true;
          b = { ok: true, receipt: { method: "tempo", status: "success", reference: first.chain.txId, timestamp: new Date().toISOString() } };
          // The relay finishes on its own; its verdict no longer decides
          // anything, but a disagreement is worth seeing.
          relayP.then((r) => { if (!r?.ok) console.warn(`[mpp-tempo] relay answered after the chain had confirmed ${req.method} ${req.path} tx=${first.chain.txId}: ${String(r?.error || "?").slice(0, 160)}`); }, () => {});
        } else b = first.relay;
      } else {
        b = await broadcast(auth);
      }
      const tBroadcast = Date.now();
      const watched = earlyConfirm && !early ? ` watch=reads:${watch.reads || 0}${watch.seenAt ? ` seen:+${watch.seenAt - tHandled}ms` : ""}${watch.finalizedLag != null ? ` lag:${watch.finalizedLag}` : ""}${watch.error ? ` err:${watch.error}` : ""}` : "";
      const timing = `validate=${tValidated - t0}ms handler=${tHandled - tValidated}ms broadcast=${tBroadcast - tHandled}ms${early ? " (chain-confirmed)" : ""}${watched}`;
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
        console.warn(`[mpp-tempo] broadcast failed AFTER a successful handler (${req.method} ${req.path}) — buyer answered 402, not charged by us: ${maskAddresses(b.error)} [${timing}]`);
        const bcls = b.cls || "unknown";
        logTempoRefusal(req, { cls: `broadcast:${bcls}`, amountAtomic: binding.amountAtomic, timings: { validate: tValidated - t0, handler: tHandled - tValidated, broadcast: tBroadcast - tHandled, total: Date.now() - tStart } });
        bufferedCalls = [];
        restore();
        // Never a 503 here: after a failed broadcast whose outcome the chain
        // could not confirm, the spec answer is 402 + a fresh challenge. The
        // class still says why (e.g. relay-unreachable: retry, nothing landed
        // that the chain can see).
        const bc = TEMPO_REFUSAL_CLASSES[bcls] || TEMPO_REFUSAL_CLASSES.unknown;
        const bkind = bc.status === 503 ? "verification-failed" : bc.kind;
        const bdetail = bcls === "unknown" && b.reason ? `Tempo settlement was not accepted (${String(b.reason).slice(0, 160)}).` : `Tempo settlement was not accepted: ${bc.detail.replace(/,? so the credential was not checked and nothing was charged\./, ". Nothing settled that the chain can see.")}`;
        sendMppProblem(res, mppProblem(bkind, bdetail, { hint: bc.status === 503 ? "Request the resource again and pay a fresh challenge in a moment; this credential was not settled." : bc.hint, details: { reason: bcls } }));
        // The handler already ran and produced a <400 for this credential, so
        // it stays spent: presenting it again must not run the handler again.
        // The 402 above carries a fresh challenge to pay instead.
        settleReplay();
        return;
      }
      console.log(`[mpp-tempo] settled ${req.method} ${req.path} tx=${b.receipt?.reference || "?"} [${timing}]`);
      // A keychain sender whose chain read had not answered when the bounds
      // were keyed has usually answered by now (the handler and the broadcast
      // took longer): the ledger takes it. Never waited for, so no added
      // latency; a read still pending leaves the row naming nobody.
      if (!req.mppTempoLedgerPayer && keychainSender) req.mppTempoLedgerPayer = keychainSender;
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
