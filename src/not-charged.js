// The one sentence a refusal uses to say a call was not charged, and the rule
// for when a handler may print it.
//
// The route binder adds the Tempo push exception to this exact sentence
// (prepayment-refusal.js withPushExceptionText), so a refusal that words the
// claim any other way would read as true to a Tempo push buyer whose transfer
// was final before the call and is recorded as owed.
//
// The sentence is printed on a route call only: a skill-pack step, a decide
// step and a route-execute first-party step run inside an answer that is
// charged, and print the step's error there, where the claim would be false.
//
// Two ways to know. A handler that holds the request asks notChargedOn(req):
// the route binder passes `req`, a step is called request-less
// (`handler(input)`). Code with no request in reach (a shared fetch helper,
// a worker pool, a pacing gate) asks notChargedHere(), which reads an
// async-context mark: the dispatchers that answer a caller directly (the HTTP
// tool route, the hosted MCP connector) run the handler inside
// runAsRouteCall(fn), and every in-process executor runs its step inside
// runAsStep(fn). A step mark overrides both readings, so the one executor
// that hands a step the paying request itself (decide-execute's outside step
// calls the router with `req`: the router reads the payer, the payment header
// and the hang-up ticket from it) still prints no claim, and neither does
// anything the step dispatches. With no mark at all notChargedHere() is
// silent. The request is never copied or changed.
//
// A pool that builds its error later, outside the caller's async context (a
// worker's exit, a queue timer), marks it with claimLater(err) and the entry
// point the caller awaits finishes it with claimNow(err).
//
// A shared promise (a single-flight read, an in-flight cache) rejects every
// waiter with one error, built in the scope of whoever started it. A step
// that receives one gets a copy without the sentence (runAsStep); new shared
// code marks its error with claimLater and lets each waiter call claimNow.
//
// A handler that returns is a delivered answer, and a delivered answer is
// charged. A composite catches a leg's error and either returns its text (one
// of several searches failed) or throws it as the whole call's refusal (every
// search failed), so the leg cannot know which it will be. The route call
// knows: when a call that printed the sentence returns, runAsRouteCall removes
// the sentence from the strings of the returned object (copied, never changed
// in place); when it throws, the refusal goes out as written. A leg can also
// receive an error another call printed (a shared in-flight read rejects every
// waiter with the error built in its starter's scope), so a call during which
// any call printed the sentence is read the same way; an answer from a call
// during which none was printed is returned unread. A streamed body is not
// read: a stream writes no leg error into a delivered answer.
import { AsyncLocalStorage } from "node:async_hooks";
import { keepAnswerCharges } from "./answer-charges.js";

export const NOT_CHARGED = "Nothing was charged.";

const scope = new AsyncLocalStorage();
const ROUTE = "route", STEP = "step";
const kindOf = (store) => (store && typeof store === "object" ? store.kind : store);

const SENTENCE_RE = / ?Nothing was charged\./g;
const WALK_MAX_DEPTH = 12, WALK_MAX_NODES = 200_000;
const isPlain = (v) => { if (!v || typeof v !== "object") return false; const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
/** `value` with the charge sentence removed from every string of a plain
 *  object or array (copied along the changed paths only, never in place), and
 *  how many strings changed. Anything else is returned as it is. */
export function withoutChargeSentence(value) {
  let removed = 0, nodes = 0;
  const walk = (v, depth) => {
    if (typeof v === "string") {
      if (!v.includes(NOT_CHARGED)) return v;
      removed++;
      return v.replace(SENTENCE_RE, "").trimStart();
    }
    if (depth >= WALK_MAX_DEPTH || ++nodes > WALK_MAX_NODES) return v;
    if (Array.isArray(v)) {
      let out = null;
      for (let i = 0; i < v.length; i++) { const n = walk(v[i], depth + 1); if (n !== v[i]) { out ??= v.slice(); out[i] = n; } }
      return out || v;
    }
    if (isPlain(v)) {
      let out = null;
      for (const k of Object.keys(v)) { const n = walk(v[k], depth + 1); if (n !== v[k]) { out ??= { ...v }; out[k] = n; } }
      return out || v;
    }
    return v;
  };
  const out = Array.isArray(value) || isPlain(value) ? walk(value, 0) : value;
  return { value: out, removed };
}

let removals = 0;
/** Delivered answers whose strings carried the sentence since boot. */
export function chargeSentenceRemovals() { return removals; }
// Every sentence printed since boot, in any scope: a call whose count moved
// while it ran may hold a leg error another call printed.
let printed = 0;
function delivered(store, value) {
  if (!store.claimed && printed === store.printedAtStart) return value;
  let r;
  try { r = withoutChargeSentence(value); } catch { return value; }
  if (!r.removed) return value;
  removals++;
  return keepAnswerCharges(value, r.value);
}

/** Run `fn` as the handler of a call answered directly to its caller. What
 *  it returns is the delivered answer (the sentence is removed from it, see
 *  above); what it throws is the refusal, passed on unchanged. */
export function runAsRouteCall(fn) {
  const store = { kind: ROUTE, claimed: false, printedAtStart: printed };
  const out = scope.run(store, fn);
  if (out && typeof out.then === "function") return out.then((v) => delivered(store, v));
  return delivered(store, out);
}
/** Run `fn` as a step of an answer that is charged: no handler inside it
 *  prints the charge sentence. */
export function runAsStep(fn) {
  let out;
  try { out = scope.run(STEP, fn); } catch (e) { throw stepError(e); }
  if (out && typeof out.then === "function") return out.then((v) => v, (e) => { throw stepError(e); });
  return out;
}
// An error can reach a step already carrying the sentence: a shared promise
// rejects every waiter with the error its first caller's scope built. The
// step gets a copy without it; the shared error object is left as it is.
function stepError(err) {
  if (!err || typeof err !== "object" || typeof err.message !== "string" || !err.message.includes(NOT_CHARGED)) return err;
  const clean = err.message.replace(SENTENCE_RE, "").trimStart();
  try {
    const copy = new Error(clean);
    for (const k of Object.keys(err)) copy[k] = err[k];
    if (err.name && err.name !== "Error") copy.name = err.name;
    return copy;
  } catch { return err; }
}
/** True inside runAsStep. */
export function inStep() {
  return kindOf(scope.getStore()) === STEP;
}
const said = () => { printed++; const store = scope.getStore(); if (kindOf(store) === ROUTE) store.claimed = true; return ` ${NOT_CHARGED}`; };

/** True when the handler was called by the route binder (it passes `req`)
 *  and is not running as a step of another answer. */
export function isRouteCall(req) {
  return !!(req && typeof req === "object" && req.headers && typeof req.headers === "object") && !inStep();
}

/** `text` with the shared sentence taken out and the spacing closed up: for
 *  an error recorded inside an answer that can itself be charged (a step
 *  error of a decide run), where the claim would describe the wrong call. */
export function withoutChargeClaim(text) {
  return String(text ?? "").split(NOT_CHARGED).map((part) => part.trim()).filter(Boolean).join(" ");
}

/** " Nothing was charged." on a route call, "" otherwise: append to a sentence. */
export function notChargedOn(req) {
  return isRouteCall(req) ? said() : "";
}

/** Mark an error built outside its caller's async context (a worker event, a
 *  queue timer): the sentence, then `tail`, are added by claimNow(err) at the
 *  entry point the caller awaits. */
export function claimLater(err, tail = "") {
  if (err && typeof err === "object") err.chargeClaimTail = String(tail);
  return err;
}
/** Finish a claimLater error's message in the current async context. */
export function claimNow(err) {
  if (err && typeof err === "object" && typeof err.chargeClaimTail === "string" && typeof err.message === "string") {
    err.message = `${err.message}${notChargedHere()}${err.chargeClaimTail}`;
    delete err.chargeClaimTail;
  }
  return err;
}

/** The same for code that holds no request: " Nothing was charged." inside
 *  runAsRouteCall and outside any step, "" otherwise. */
export function notChargedHere() {
  return kindOf(scope.getStore()) === ROUTE ? said() : "";
}

// Any wording of the claim, the shared sentence or a handler's own: "not",
// "never" or a contraction ("isn't", "won't be"), then "charged" or "billed";
// "nothing (was) charged" or "billed"; "no charge"; "uncharged", "unbilled".
const ANY_CHARGE_CLAIM = /(?:\b(?:not|never)|n['\u2019]t)\s+(?:be\s+|been\s+)?(?:charged|billed)\b|\bnothing\s+(?:(?:was|is|will be|has been)\s+)?(?:charged|billed)\b|\bno charge\b|\bun(?:charged|billed)\b/i;

/** `text` without each sentence that says nothing was charged, whatever its
 *  wording: for a gate whose payment was taken before the handler ran (the
 *  AWS Marketplace front door, src/aws-marketplace-gate.js), where a handler's
 *  claim would be false and the gate states the payment's state itself. */
export function withoutChargeSentences(text) {
  return String(text ?? "").split(/(?<=[.!?;])\s+/).filter((s) => !ANY_CHARGE_CLAIM.test(s)).join(" ").trim();
}
