// The caller a request-less handler call runs for. The in-process executors
// (decide's steps, route-execute's local tier) invoke a tool as
// `def.handler(params)` with no request, on purpose: a step must never see the
// paying request's credential or payer. A per-caller admission rule (the
// large-image slot in src/tools/ocr-kit.js) still needs to know whose call it
// is, so the executor runs the step inside runAsCallerOf(req, fn): an opaque
// key (the verified signed payer, a credits key, a Tempo sender, else the client
// address, an IPv6 one folded to its /64 as every per-address bound folds it)
// is held in async context, never the request itself. The generic
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

/** The caller key of a request, or null when it names none. The payer is the
 *  identity payer (identityPayerOf: null in FREE_MODE, where no payment header
 *  is verified), so a header a caller typed never chooses its key there. */
export function callerKeyOf(req) {
  if (!req || typeof req !== "object") return null;
  const payer = identityPayerOf(req);
  if (payer) return `payer:${payer}`;
  if (req.creditsKeyId) return `credits:${req.creditsKeyId}`;
  if (req.mppTempoSender) return `tempo:${String(req.mppTempoSender).toLowerCase()}`;
  return req.ip ? `ip:${limiterKey(String(req.ip))}` : null;
}

/** The caller key the current request-less call runs for, or null. */
export function currentDispatchCaller() {
  return scope.getStore() || null;
}

/** Run `fn` with the caller of `req` (or the enclosing dispatch's caller)
 *  held for the request-less handler calls inside it. */
export function runAsCallerOf(req, fn) {
  const key = callerKeyOf(req) || currentDispatchCaller();
  return key ? scope.run(key, fn) : fn();
}
