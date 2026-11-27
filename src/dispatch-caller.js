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
import { createHash } from "node:crypto";
import { identityPayerOf, paymentHeaderOf, freeModeOn } from "./payer.js";
import { limiterKey } from "./rate-limit.js";
import { chargeCancelledForClientGone, clientGoneBeforeFirstByte, clientGoneError } from "./hangup-settlement.js";

const scope = new AsyncLocalStorage();
/** The key every request-less call with no caller of its own shares, so its
 *  places are still counted (and one caller's run of them stays visible). */
export const IN_PROCESS_CALLER = "in-process";
/** The key of a request that names no caller: no signed key, and an address
 *  that is the CDN edge's, not its client's. Its places and runs are counted
 *  under this key, but it identifies no one: a per-caller admission rule
 *  treats each such request as a newcomer (src/caller-places.js), so one of
 *  them holding places never locks the others out. */
export const ANONYMOUS_CALLER = "anonymous";
const isRequest = (req) => !!req && typeof req === "object";

/** Every caller key a request carries, strongest first: the identity payer
 *  (identityPayerOf: null in FREE_MODE, where no payment header is verified,
 *  so a header a caller typed never chooses a key there), a credits key, a
 *  Tempo sender, then the client address (left out when a CDN request
 *  carries no proof of it). A per-caller admission rule counts a place under
 *  each and decides by the first (src/caller-places.js): buyers behind one
 *  address stay separate callers, one wallet from several addresses is one
 *  caller, and an unsigned caller is told apart by its address. */
export function callerKeysOf(req) {
  return keysOf(req, false);
}

function keysOf(req, withUnprovenAddress) {
  if (!req || typeof req !== "object") return [];
  const keys = [];
  const payer = identityPayerOf(req);
  if (payer) keys.push(`payer:${payer}`);
  if (req.creditsKeyId) keys.push(`credits:${req.creditsKeyId}`);
  if (req.mppTempoSender) keys.push(`tempo:${String(req.mppTempoSender).toLowerCase()}`);
  // A CDN request without proof of its client's address (src/cdn-client-ip.js
  // cdnUnproven) has the edge's address, shared by every client behind it.
  if (req.ip && (withUnprovenAddress || req.cdnUnproven !== true)) keys.push(`ip:${limiterKey(String(req.ip))}`);
  return keys;
}

/** The key a per-caller concurrency cap counts one call under,
 *  or null when the request carries nothing to key on. Never one bucket for
 *  unrelated callers: the request's signed key (identity payer, credits key,
 *  Tempo sender); else, for a call that carries a payment (one that signs no
 *  EVM authorization, so names no identity payer), that payment itself, so a
 *  paid call is never refused because of other callers; else the client
 *  address the server derived (the edge's for an unproven CDN request), so
 *  two addresses never share a count. */
export function callerKeyOf(req) {
  const [first] = keysOf(req, true);
  if (first && !first.startsWith("ip:")) return first;
  return paidCallKeyOf(req) || first || null;
}
// A payment credential reaches a handler only past the paywall's verify; in
// FREE_MODE nothing is verified, so a header there keys nothing.
function paidCallKeyOf(req) {
  if (!isRequest(req) || freeModeOn()) return null;
  const header = paymentHeaderOf(req);
  return header ? `paid:${createHash("sha256").update(String(header)).digest("hex").slice(0, 32)}` : null;
}

/** The cap key the current request-less call runs for (callerKeyOf of the
 *  dispatching request), or null. */
export function currentDispatchCaller() {
  return scope.getStore()?.capKey || null;
}

/** For a request-less call inside a dispatch whose payment settles after its
 *  handler: a function that adds a hook the dispatcher runs once with whether
 *  that request's final response was a settled 200 (the hook list on the
 *  request, `__onSettled`; the request itself is never handed out). Null
 *  when the call runs for no such request. A step whose effect is kept only
 *  when the call is paid for (src/tools/price-webhook-kit.js) registers its
 *  outcome here. */
export function currentSettleHook() {
  return scope.getStore()?.onSettled || null;
}

/** A signal for work that waits on the dispatching request's behalf (a
 *  place in a line): aborted when that request's connection closed before
 *  the first response byte AND its call is no longer charged (the charge was
 *  canceled, src/hangup-settlement.js; in FREE_MODE nothing is charged). A
 *  caller that is still charged keeps its place. Null with no such request. */
export function currentCallerLeftSignal() {
  return scope.getStore()?.left?.() || null;
}

/** Every caller key the current request-less call runs for, or null. */
export function currentDispatchCallerKeys() {
  return scope.getStore()?.keys || null;
}

/** The keys a per-caller admission rule holds a place under: the request's
 *  (callerKeysOf); for a request that names no caller, the anonymous key;
 *  with no request, those an in-process executor runs this call for, else
 *  the one shared key, so a place is never held uncounted. */
export function admissionCallerOf(req) {
  const keys = callerKeysOf(req);
  if (keys.length) return keys;
  if (isRequest(req)) return [ANONYMOUS_CALLER];
  return currentDispatchCallerKeys() || [IN_PROCESS_CALLER];
}

const ANONYMOUS_KEYS = Object.freeze([ANONYMOUS_CALLER]);
const IN_PROCESS_SCOPE = Object.freeze({ keys: Object.freeze([IN_PROCESS_CALLER]), capKey: IN_PROCESS_CALLER });
let anonymousRequests = 0;
/** Run `fn` with the caller of `req` held for the request-less handler calls
 *  inside it. The admission keys (currentDispatchCallerKeys) are the
 *  request's keys, or the anonymous key for a request that names no caller;
 *  the cap key (currentDispatchCaller) is callerKeyOf(req), and a request
 *  with nothing to key on gets a key of its own, never one shared with
 *  another request. With no request, the enclosing dispatch's scope, else the
 *  shared in-process one. A scope is always open, so a per-caller cap a
 *  request-less step reads always has a key. */
export function runAsCallerOf(req, fn) {
  if (!isRequest(req)) return scope.run(scope.getStore() || IN_PROCESS_SCOPE, fn);
  const own = callerKeysOf(req);
  const keys = own.length ? Object.freeze(own) : ANONYMOUS_KEYS;
  const capKey = callerKeyOf(req) || `${ANONYMOUS_CALLER}:${++anonymousRequests}`;
  // Only a request whose response the dispatcher waits on reports its
  // settlement to the hooks on it.
  const onSettled = req.res && typeof req.res.once === "function" ? (hook) => { if (typeof hook === "function") (req.__onSettled ||= []).push(hook); } : null;
  // Made only when a waiting helper asks for it; the request never leaves here.
  let leftCtl = null;
  const left = () => {
    if (leftCtl) return leftCtl.signal;
    const res = req.res;
    if (!res || typeof res.once !== "function") return null;
    leftCtl = new AbortController();
    const check = () => {
      if (leftCtl.signal.aborted) return;
      let gone = false;
      try { gone = chargeCancelledForClientGone(req) || (freeModeOn() && clientGoneBeforeFirstByte(req)); } catch { gone = false; }
      if (gone) leftCtl.abort(clientGoneError());
    };
    res.once("close", check);
    check();
    return leftCtl.signal;
  };
  return scope.run(Object.freeze({ keys, capKey, onSettled, left }), fn);
}
