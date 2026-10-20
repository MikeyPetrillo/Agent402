// Operator-gated, per-request facilitator preference.
//
// @x402/core resolves one facilitator per (version, network, scheme) once, at
// initialize(): the FIRST client in the constructor array that advertises the
// pair wins it, for the 402 offer (getSupportedKind, whose extra.feePayer a
// Solana buyer's transaction must name) and for verify and settle
// (getFacilitatorClient). The order is a boot decision shared by every
// request, so a registry that lists a seller from the settlements its own
// facilitator carries never sees a route while another facilitator is first
// on that chain.
//
// This module lets ONE request be settled elsewhere on purpose, without a
// second paywall and without reordering anything for anyone else:
//
//   X-Agent402-Settle-Via: <name>      honored only when the same request also
//                                      carries the operator token (the caller
//                                      decides, src/server.js operatorAuthed)
//
// Mechanism: the Express middleware runs the rest of the request inside an
// AsyncLocalStorage scope holding the preferred client and ITS /supported
// answer, and the three vendor lookups on the resource server instance are
// wrapped to read that scope first. The 402 for the tagged request then names
// the preferred facilitator's signer, and verify and settle go to it, because
// all three vendor seams read the same scope. The paid retry has to carry the
// header too: a buyer that was quoted the preferred signer and retries without
// it is compared against the default offer, whose extra.feePayer differs, and
// @x402/core refuses it as "No matching payment requirements" before any
// facilitator is asked (paymentRequirementsMatchAccepted compares extra), so
// the two facilitators can never both be asked to settle one payment.
//
// An ordinary request pays one header read and takes the vendor's own lookup
// (the scope is empty, getStore() is a Map read); a tagged request without a
// valid token is treated exactly as an untagged one. A preference for a
// network the preferred facilitator does not advertise falls through to the
// boot order for that network.
import { AsyncLocalStorage } from "node:async_hooks";

export const SETTLE_VIA_HEADER = "x-agent402-settle-via";

const scope = new AsyncLocalStorage();
// name -> { client, label }. Registered at boot by payments.js, read by the
// middleware at request time. Names are lowercase.
const preferences = new Map();

/** Register a facilitator a tagged request may name. Returns the registry. */
export function registerSettlePreference(name, client, label = name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key || !client) return preferences;
  preferences.set(key, { client, label });
  return preferences;
}

/** For tests: forget every registered preference. */
export function resetSettlePreferences() { preferences.clear(); }

/** The names a tagged request may carry. */
export function settlePreferenceNames() { return [...preferences.keys()]; }

/** The header's value, lowercased, or null. One header read; never throws. */
export function settleViaOf(req) {
  const v = req?.headers?.[SETTLE_VIA_HEADER];
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s || null;
}

/** The active preference for the current async scope, or null. */
export function activeSettlePreference() { return scope.getStore() || null; }

/**
 * Express middleware. `authed(req)` decides whether the request may name a
 * facilitator (the operator token check lives in server.js). Untagged,
 * unknown-name and unauthenticated requests continue synchronously and
 * untouched; only an honored request waits for the preferred facilitator's
 * (memoized) /supported answer before continuing inside the scope.
 */
export function settlePreferenceMiddleware({ authed, registry = preferences, log = console } = {}) {
  if (typeof authed !== "function") throw new Error("settlePreferenceMiddleware needs authed(req)");
  return function settlePreference(req, res, next) {
    const via = settleViaOf(req);
    if (!via) return next();
    const pref = registry.get(via);
    if (!pref || !authed(req)) return next();
    // One /supported read per registered client, shared by every tagged
    // request; a rejected read is dropped so the next request asks again.
    let p = pref.supported;
    if (!p) {
      try { p = Promise.resolve(pref.client.getSupported()); } catch (e) { p = Promise.reject(e); }
      pref.supported = p;
      p.catch(() => { if (pref.supported === p) pref.supported = null; });
    }
    // The chain returns what next() returns, so a caller that awaits the
    // dispatcher (Express 5 forwards a rejection to its error handler) sees
    // the tagged path exactly as it sees the untagged one.
    return p.then(
      (supported) => {
        const kinds = Array.isArray(supported?.kinds) ? supported.kinds : [];
        if (!kinds.length) { log.warn?.(`[settle-preference] ${pref.label}: /supported carries no kinds; request takes the default facilitators`); return next(); }
        return scope.run({ via, label: pref.label, client: pref.client, supported, kinds }, () => next());
      },
      (e) => {
        log.warn?.(`[settle-preference] ${pref.label}: /supported failed (${String(e?.message || e).slice(0, 120)}); request takes the default facilitators`);
        return next();
      },
    );
  };
}

function kindIn(ctx, x402Version, network, scheme) {
  return ctx.kinds.find((k) => k && k.x402Version === x402Version && k.network === network && k.scheme === scheme) || null;
}

/**
 * Wrap the three vendor lookups on an x402ResourceServer INSTANCE so a scoped
 * request reads the preferred facilitator first. Returns the server. Outside a
 * scope, or for a pair the preferred facilitator does not advertise, every
 * call is the vendor's own. Idempotent per instance.
 */
const INSTALLED = Symbol.for("agent402.settlePreference");
export function installSettlePreference(server) {
  if (!server || server[INSTALLED]) return server;
  const origKind = server.getSupportedKind.bind(server);
  const origExt = server.getFacilitatorExtensions.bind(server);
  const origClient = server.getFacilitatorClient.bind(server);
  server.getSupportedKind = (x402Version, network, scheme) => {
    const ctx = scope.getStore();
    if (ctx) { const k = kindIn(ctx, x402Version, network, scheme); if (k) return k; }
    return origKind(x402Version, network, scheme);
  };
  server.getFacilitatorExtensions = (x402Version, network, scheme) => {
    const ctx = scope.getStore();
    if (ctx && kindIn(ctx, x402Version, network, scheme)) return ctx.supported?.extensions || [];
    return origExt(x402Version, network, scheme);
  };
  server.getFacilitatorClient = (x402Version, network, scheme) => {
    const ctx = scope.getStore();
    if (ctx && kindIn(ctx, x402Version, network, scheme)) return ctx.client;
    return origClient(x402Version, network, scheme);
  };
  server[INSTALLED] = true;
  return server;
}

/** For tests: run `fn` inside a preference scope built from a /supported answer. */
export function runWithSettlePreference(pref, fn) {
  const kinds = Array.isArray(pref?.supported?.kinds) ? pref.supported.kinds : [];
  return scope.run({ via: pref.via || "test", label: pref.label || "test", client: pref.client, supported: pref.supported, kinds }, fn);
}
