// A challenge must outlive the run it pays for.
//
// The card gate and the Tempo gate check a challenge's expiry when the
// credential arrives, run the handler, and only then capture or broadcast,
// through a library call that asserts the expiry again. A challenge that
// expires during the run therefore cannot be settled: the work is done and
// nothing can be charged. So the life a challenge has LEFT is checked before
// the handler, against what the route needs:
//
//   run seconds + CAPTURE_ALLOWANCE_SECONDS
//
// where the run seconds are the route's own measured bound (EVM_RUN_SECONDS,
// src/evm-validity.js: the figures the EVM validity floor already uses for the
// reports and the media tiers) or, for a route with none, the gate's default.
// A credential short of that is refused before anything runs, with a fresh
// challenge and nothing charged. The moment the capture must begin
// (expiry less the allowance) is also presented to the handler as the end of
// its settleable window (presentRunWindow), so a handler that reads the window
// (the chat tiers) ends its upstream work by it instead of running past it.
//
// The MPP evm wire has no such check to make: the shim hands the signed
// authorization to the x402 middleware, which settles it by its own
// validBefore and never reads the challenge's expiry again; that window is
// already the request's settleable window (evmCredentialSettleableMs).
import { EVM_RUN_SECONDS, presentRunWindow } from "./evm-validity.js";

/** Seconds kept after the run for the capture or broadcast call to begin
 *  while the challenge is still unexpired. */
export const CAPTURE_ALLOWANCE_SECONDS = 10;

/** The measured run seconds of a route, or 0 when it has none. */
export function routeRunSeconds(slug) {
  return typeof slug === "string" && Object.hasOwn(EVM_RUN_SECONDS, slug) ? EVM_RUN_SECONDS[slug] : 0;
}

/**
 * Pure decision. Null when a challenge expiring at `expiresAtMs` may pay for a
 * run of `runSeconds` (or the gate's `defaultRunSeconds` when the route has
 * none), else { remainingSeconds, requiredSeconds }.
 */
export function challengeLifeShortfall({ expiresAtMs, runSeconds = 0, defaultRunSeconds = 0, nowMs = Date.now() } = {}) {
  if (!Number.isFinite(expiresAtMs)) return null;
  const run = Number(runSeconds) > 0 ? Number(runSeconds) : Math.max(0, Number(defaultRunSeconds) || 0);
  const requiredSeconds = run + CAPTURE_ALLOWANCE_SECONDS;
  const remainingSeconds = (expiresAtMs - nowMs) / 1000;
  return remainingSeconds >= requiredSeconds ? null : { remainingSeconds: Math.max(0, Math.floor(remainingSeconds)), requiredSeconds };
}

/** The sentence a refusal for it carries. */
export function challengeLifeReason(s) {
  return `this challenge expires in about ${s.remainingSeconds} s, before this route's run and the charge after it can finish (about ${s.requiredSeconds} s are needed). Nothing ran and nothing was charged`;
}

/** Present the moment the capture must begin as the end of the run's window. */
export function presentChallengeWindow(req, expiresAtMs) {
  return presentRunWindow(req, expiresAtMs - CAPTURE_ALLOWANCE_SECONDS * 1000);
}
