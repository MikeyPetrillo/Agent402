// Settle order that follows the facilitator that is currently settling.
//
// A network's first registered facilitator is tried first on every settle.
// When that facilitator refuses for an out-of-funds or billing class (its own
// account cannot pay for the settlement, a refusal made before it signs
// anything), the settle-failure hook re-settles through the fallback chain,
// but only when PAYMENT_SETTLE_FALLBACK is on, and every buyer still waits
// for the refusal first. This keeps a count per (network, facilitator): after
// SETTLE_DEMOTE_AFTER consecutive refusals of that class the facilitator is
// demoted for SETTLE_DEMOTE_COOLDOWN_MS, and while it is demoted a settle on
// that network goes to the alternates first. A success clears the count.
// When the cool-down ends the next settle tries it again; one more refusal
// demotes it again at once (the count is not cleared by a refusal).
//
// Safety: an alternate is tried only before anything was asked of the demoted
// facilitator, and the next one (or the demoted primary) only after a
// pre-broadcast refusal, the same rule the fallback chain applies. An
// ambiguous failure (timeout, 5xx) stops at once, because that settler may
// have broadcast.
//
// One settle, one call per facilitator: the wrapper notes, per payment
// payload, which facilitators it asked and that it recorded their refusals
// (settleAttemptOf). The settle-failure hook in src/payments.js reads that
// note, so it neither records the same refusal a second time nor asks a
// facilitator the wrapper already asked.
//
// Per process: each replica demotes on its own refusals, which a refusal
// streak reaches on every replica within a few calls.
import { isFacilitatorBillingRefusal } from "./payment-reject.js";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const AFTER = () => num(process.env.SETTLE_DEMOTE_AFTER, 3);
const COOLDOWN_MS = () => num(process.env.SETTLE_DEMOTE_COOLDOWN_MS, 15 * 60_000);
// The sub-cent quota refusal has its own gate (src/avm-sponsorship.js), which
// withdraws the offer; it never demotes a facilitator.
const SUBCENT = /subcent_quota_exceeded/i;

const streaks = new Map(); // "network|label" -> { n, until, lastReason, lastAt }
// paymentPayload -> { network, asked: Set(name) }: what one settle asked. The
// payload is decoded per request, so the note lives exactly as long as it.
const attempts = new WeakMap();

/** What the demotion wrapper asked while settling this payload on `network`
 *  ({ asked: Set(name) }), or null when it did not handle the settle. */
export function settleAttemptOf(paymentPayload, network) {
  if (!paymentPayload || typeof paymentPayload !== "object") return null;
  const a = attempts.get(paymentPayload);
  return a && a.network === network ? a : null;
}
const keyOf = (network, label) => `${network}|${label}`;

/** True for the refusal class that demotes: the facilitator's own account cannot pay. */
export function isFundsRefusal(textOrResult) {
  const t = typeof textOrResult === "string" ? textOrResult
    : [textOrResult?.errorReason, textOrResult?.errorMessage, textOrResult?.message].filter(Boolean).join(" ");
  return isFacilitatorBillingRefusal(t) && !SUBCENT.test(t);
}

/** Record one settle outcome: "ok", "funds" (out-of-funds class) or "other". */
export function noteSettleOutcome(network, label, outcome, { reason = "", now = Date.now() } = {}) {
  const k = keyOf(network, label);
  if (outcome === "ok") { streaks.delete(k); return null; }
  if (outcome !== "funds") return streaks.get(k) || null;
  const s = streaks.get(k) || { n: 0, until: 0, lastReason: "", lastAt: 0 };
  s.n++;
  s.lastReason = String(reason).slice(0, 160);
  s.lastAt = now;
  if (s.n >= AFTER() && s.until <= now) {
    s.until = now + COOLDOWN_MS();
    console.warn(`[settle-demotion] ${label} demoted on ${network} after ${s.n} consecutive out-of-funds refusals; alternates settle first until ${new Date(s.until).toISOString()}`);
  }
  streaks.set(k, s);
  return s;
}

export function isDemoted(network, label, now = Date.now()) {
  const s = streaks.get(keyOf(network, label));
  return !!s && s.until > now;
}

/** Every facilitator in cool-down now (operator detail). */
export function demotedList(now = Date.now()) {
  const out = [];
  for (const [k, s] of streaks) {
    if (s.until > now) {
      const i = k.indexOf("|");
      out.push({ network: k.slice(0, i), facilitator: k.slice(i + 1), consecutive: s.n, until: new Date(s.until).toISOString(), lastReason: s.lastReason });
    }
  }
  return out;
}

/**
 * Wrap `client.settle` for `network`: record each outcome under `label` and,
 * while the client is demoted, try `alternates()` ([{ name, client }]) first.
 * `isPreBroadcast(err)` is the fallback chain's own classifier. `onRefusal`
 * receives every out-of-funds refusal ({ network, facilitator, reason }).
 */
export function withSettleDemotion(client, { network, label, alternates = () => [], isPreBroadcast, onRefusal = () => {} } = {}) {
  if (!client || typeof client.settle !== "function" || client.settle.__a402Demotion) return client;
  const orig = client.settle;
  const textOf = (x) => [x?.errorReason, x?.errorMessage, x?.message].filter(Boolean).join(" ");
  const record = (name, x, ok) => {
    if (ok) { noteSettleOutcome(network, name, "ok"); return; }
    const funds = isFundsRefusal(x);
    noteSettleOutcome(network, name, funds ? "funds" : "other", { reason: textOf(x) });
    if (funds) { try { onRefusal({ network, facilitator: name, reason: textOf(x) }); } catch { /* bookkeeping only */ } }
  };
  const asError = (r) => Object.assign(new Error(String(r?.errorMessage || r?.errorReason || "settle rejected")), { errorReason: r?.errorReason, errorMessage: r?.errorMessage });
  const settle = async function demotingSettle(payload, requirements, ...rest) {
    if (requirements?.network !== network) return orig.call(client, payload, requirements, ...rest);
    let attempt = null;
    if (payload && typeof payload === "object") {
      attempt = attempts.get(payload);
      if (!attempt || attempt.network !== network) { attempt = { network, asked: new Set() }; attempts.set(payload, attempt); }
    }
    if (isDemoted(network, label)) {
      for (const alt of alternates() || []) {
        if (!alt?.client || typeof alt.client.settle !== "function") continue;
        if (attempt?.asked.has(alt.name)) continue;
        attempt?.asked.add(alt.name);
        try {
          const r = await alt.client.settle(payload, requirements, ...rest);
          if (r?.success === true) { record(alt.name, r, true); return r; }
          record(alt.name, r, false);
          if (isPreBroadcast(asError(r))) continue;
          return r;
        } catch (err) {
          record(alt.name, err, false);
          if (isPreBroadcast(err)) continue;
          throw err;
        }
      }
    }
    attempt?.asked.add(label);
    try {
      const r = await orig.call(client, payload, requirements, ...rest);
      record(label, r, r?.success === true);
      return r;
    } catch (err) {
      record(label, err, false);
      try { err.__a402RefusalRecorded = true; } catch { /* frozen error */ }
      throw err;
    }
  };
  settle.__a402Demotion = true;
  settle.__a402Labelled = orig.__a402Labelled;
  client.settle = settle;
  return client;
}

/** Test seam. */
export function _resetSettleDemotion() { streaks.clear(); }
