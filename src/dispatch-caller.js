// The caller a request-less handler call runs for. The in-process executors
// (decide's steps, route-execute's local tier) invoke a tool as
// `def.handler(params)` with no request, on purpose: a step must never see the
// paying request's credential or payer. A per-caller admission rule (the
// large-image slot in src/tools/ocr-kit.js, the audio decode pool in
// src/tools/media-kit.js) still needs to know whose call it
// is, so the executor runs the step inside runAsCallerOf(req, fn): an opaque
// key (the verified signed payer, a credits key, a Tempo sender, else the client
// address, an IPv6 one folded to its /64 as every per-address bound folds it)
// is held in async context (every key the request carries, callerKeysOf),
// never the request itself. The generic
// dispatches (the HTTP tool route, the hosted MCP connector) and the skill
// packs run every handler that way, so a tool that calls other tools'
// handlers in-process passes its caller on.
import { AsyncLocalStorage } from "node:async_hooks";
import { identityPayerOf } from "./payer.js";
import { limiterKey } from "./rate-limit.js";

const scope = new AsyncLocalStorage();
/** The key every request-less call with no caller of its own shares, so its
 *  places are still counted (and one caller's run of them stays visible). */
export const IN_PROCESS_CALLER = "in-process";

/** Every caller key a request carries, strongest first: the identity payer
 *  (identityPayerOf: null in FREE_MODE, where no payment header is verified,
 *  so a header a caller typed never chooses a key there), a credits key, a
 *  Tempo sender, then the client address. One caller is all of them at once:
 *  a per-caller admission rule counts a place under each, so a party that
 *  signs with several wallets from one address, or one wallet from several
 *  addresses, is still one caller (src/caller-places.js). */
export function callerKeysOf(req) {
  if (!req || typeof req !== "object") return [];
  const keys = [];
  const payer = identityPayerOf(req);
  if (payer) keys.push(`payer:${payer}`);
  if (req.creditsKeyId) keys.push(`credits:${req.creditsKeyId}`);
  if (req.mppTempoSender) keys.push(`tempo:${String(req.mppTempoSender).toLowerCase()}`);
  if (req.ip) keys.push(`ip:${limiterKey(String(req.ip))}`);
  return keys;
}

/** The caller key of a request (its strongest, callerKeysOf), or null when
 *  it names none. */
export function callerKeyOf(req) {
  return callerKeysOf(req)[0] || null;
}

/** The caller key the current request-less call runs for, or null. */
export function currentDispatchCaller() {
  return scope.getStore()?.[0] || null;
}

/** Every caller key the current request-less call runs for, or null. */
export function currentDispatchCallerKeys() {
  return scope.getStore() || null;
}

/** The keys a per-caller admission rule holds a place under: the request's
 *  (callerKeysOf), else those an in-process executor runs this call for,
 *  else the one shared key, so a place is never held uncounted. */
export function admissionCallerOf(req) {
  const keys = callerKeysOf(req);
  if (keys.length) return keys;
  return currentDispatchCallerKeys() || [IN_PROCESS_CALLER];
}

/** Run `fn` with the caller of `req` (or the enclosing dispatch's caller)
 *  held for the request-less handler calls inside it. */
export function runAsCallerOf(req, fn) {
  const own = callerKeysOf(req);
  const keys = own.length ? Object.freeze(own) : currentDispatchCallerKeys();
  return keys ? scope.run(keys, fn) : fn();
}
