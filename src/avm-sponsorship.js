// Withdraw the Algorand accept from SUB-CENT routes while the facilitator's
// sponsored sub-cent allowance for our payTo is spent.
//
// WHY (2026-09-28). The Algorand facilitator sponsors the fee on every
// settlement and gives each payTo a monthly count of sponsored SUB-CENT
// settlements; at or above one cent it does not meter. Once the month's count
// is spent it refuses every sub-cent settle with `subcent_quota_exceeded`
// until the reset on the 1st. Our 402s kept OFFERING Algorand on sub-cent
// routes the whole time, and @x402/express runs the handler before it
// settles, so an outside buyer paying there was verified, SERVED, and then
// refused at settle: not charged, our upstream spend absorbed, and the settle
// breaker counted each one against the buyer. Measured: one buyer, 175
// served-then-refused sub-cent calls in 45 minutes.
//
// WHAT. Per request, after @x402/core builds the requirements list - the one
// object that is both the 402 and what a payment is matched against - drop an
// Algorand USDC requirement priced under one cent while its payTo is paused.
// Dropping it THERE drops it from both: an Algorand payment on a sub-cent
// route is then refused BEFORE the handler ("no matching requirements"), so
// nothing is served and nothing reaches the breaker, and the 402 lists the
// networks that will settle. A route of one cent or more keeps its Algorand
// accept. Same prototype seam as src/accept-output-schema.js.
//
// WHEN PAUSED. On evidence, never on a schedule:
//   - the facilitator's own /sponsorship/status for the payTo reads
//     usedMonth >= quota with no purchased Settlement Units (the rule the
//     paid canary and the weekly sweep already apply), read by a boot timer
//     every AVM_SPONSORSHIP_REFRESH_MS - NEVER on a request, so no request
//     waits on it and the free-tier egress probe cannot attribute it to a tool;
//   - or a settle came back `subcent_quota_exceeded`: the refusal itself, so
//     the pause starts at the first refused buyer even while the status read
//     lags or fails.
// Cleared by a status read STARTED after that evidence that shows headroom
// (used < quota, or purchased units), and by the UTC month turning (the
// allowance resets on the 1st). A pause a REFUSAL set is not cleared by
// headroom until AVM_SPONSORSHIP_REFUSAL_HOLD_MS has passed since that
// refusal: a status that reads headroom while its own settles still refuse
// would otherwise reopen the rail on every read (~90 s) and serve-then-refuse
// a buyer each time, and those refusals are kept off the buyer's breaker
// count. Headroom reads inside the hold keep the pause fresh (the status is
// readable; a refusal contradicts it), so such a facilitator costs one
// refused settle per hold, not one per read.
// A status row LAST UPDATED in an earlier UTC
// month is not evidence about this one: the document carries no month field,
// and its `usedMonth` is a stored counter that may only roll over on the
// facilitator's next write - which a paused rail would never send. So after
// the 1st only a fresh `subcent_quota_exceeded` refusal (or a row the
// facilitator has rewritten this month) can pause again. A row whose
// `updatedTs` is PRESENT but not a plausible time (0, a negative or small
// number, text that is not a date) cannot name its month either and is not
// evidence the same way; a row with NO `updatedTs` is taken at its word (see
// sponsorshipRowMonth). FAILS OPEN: evidence older than
// AVM_SPONSORSHIP_STALE_MS (the status unreadable since) offers the rail
// again, so an unreachable status endpoint costs at most one refused settle
// per window, never a silently withdrawn rail. Transitions are logged once.
//
// The discovery surfaces (/api/pricing, /openapi.json, /.well-known/x402)
// describe the CONFIGURED rails and are left alone: the 402 is the live
// per-request offer (it already differs by route and by body), and a pause is
// published where configured-versus-offered already is, /api/rails.
// AVM_SUBCENT_GATE=off disarms the filter, the refusal flip and the timer.

import { isPaymentVerdictReason } from "./payment-reject.js";
import { paymentHeaderOf } from "./payer.js";

const PATCHED = Symbol.for("agent402.avmSubcentGate");
export const ALGORAND_PREFIX = "algorand:";
/** USDC on Algorand, mainnet and testnet ASA ids - both six decimals, so one cent is 10000 base units. */
const USDC_ASA_IDS = new Set(["31566704", "10458941"]);
export const SUBCENT_ATOMIC = 10000n;

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** How often the boot timer re-reads the facilitator's sponsorship status. */
export const REFRESH_MS = num(process.env.AVM_SPONSORSHIP_REFRESH_MS, 90_000);
/** Evidence older than this no longer pauses anything (fail open). */
export const STALE_MS = num(process.env.AVM_SPONSORSHIP_STALE_MS, 10 * 60_000);
/** A pause a settle REFUSAL set is not cleared by a headroom read until this
 *  long after the last refusal: the facilitator's status and its settles can
 *  disagree, and the refusal is the one that cost a served call. */
export const REFUSAL_HOLD_MS = num(process.env.AVM_SPONSORSHIP_REFUSAL_HOLD_MS, 30 * 60_000);

export function avmSubcentGateEnabled(env = process.env) {
  return String(env.AVM_SUBCENT_GATE || "").toLowerCase() !== "off";
}

/** Pure: the Algorand row of a /sponsorship/status document (usedMonth lives only there), or null. */
export function sponsorshipRowOf(json) {
  const rows = Array.isArray(json?.chains) ? json.chains : [];
  return rows.find((c) => c && c.chain === "algorand") || null;
}

const readable = (row) => !!row && Number.isFinite(Number(row.quota)) && Number.isFinite(Number(row.usedMonth));

/** Pure: the month's sponsored sub-cent allowance is spent and no purchased
 *  units remain. An unreadable row is NOT exhausted (fail open). */
export function isSponsorshipExhausted(row) {
  if (!readable(row)) return false;
  return Number(row.usedMonth) >= Number(row.quota) && !(Number(row.suBalance || 0) > 0);
}

export const utcMonthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

// The window a row's updatedTs must fall in to be read as a time: epoch
// seconds or milliseconds from 2001-09-09 (1e9 s, 1e12 ms) through the end of
// year 9999. Below it a number is 0, negative or a small count, which no write
// time is; past it a Date no longer prints a four-digit year, and month
// strings stop comparing in order.
const EARLIEST_TS_MS = 1e12;
const LATEST_TS_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const absentTs = (v) => v === null || v === undefined || v === "";
const plausibleTs = (ms) => (Number.isFinite(ms) && ms >= EARLIEST_TS_MS && ms <= LATEST_TS_MS ? ms : null);

/** Pure: when the row was last written, in epoch ms, or null (absent, or not
 *  a plausible time). The live document sends `updatedTs` as epoch
 *  MILLISECONDS (a number; read 2026-09-28); epoch seconds, a numeric string
 *  and an ISO string are read too. A NUMERIC value (a number or numeric text)
 *  is read only as seconds (1e9 up to 1e12) or milliseconds and never handed
 *  to Date.parse, which reads "0" or "-5" as a day in 2000 or 2001: 0, a
 *  negative or a small number is unreadable, not a month. */
export function sponsorshipRowUpdatedAt(row) {
  const v = row?.updatedTs;
  if (absentTs(v) || typeof v === "boolean") return null;
  const text = String(v).trim();
  if (typeof v === "number" || NUMERIC_TEXT.test(text)) {
    // Under 1e12 it is seconds; 0, a negative or anything under 1e9 then
    // lands before the window (and NaN/Infinity outside it): unreadable.
    const n = Number(text);
    return plausibleTs(n < 1e12 ? n * 1000 : n);
  }
  return plausibleTs(Date.parse(text));
}

/**
 * Pure: whether a /sponsorship/status row can speak for the UTC month of `now`.
 *   "this-month"    updatedTs reads as a time in this month (up to a day
 *                   ahead of ours, for clock skew);
 *   "earlier-month" it reads as a time before this month began: last month's
 *                   count, NOT evidence about this one;
 *   "unreadable"    updatedTs is PRESENT but not a plausible time (0, a
 *                   negative or small number, text that is not a date, a
 *                   time more than a day in the future): it
 *                   cannot name its month, so it is NOT evidence either, and
 *                   the gate fails open on it (only a refusal pauses);
 *   "undated"       the row carries NO updatedTs at all (absent, null or
 *                   empty): taken at its word, the rule the canaries applied
 *                   before the field was read, so a document that drops the
 *                   field keeps pausing on its own counts. Its stale-month
 *                   risk is bounded the same way as any pause: the refusal
 *                   and staleness rules, the month turning, and the canaries
 *                   warning when a pause outlives the 1st.
 */
export function sponsorshipRowMonth(row, now = Date.now()) {
  if (absentTs(row?.updatedTs)) return "undated";
  const ts = sponsorshipRowUpdatedAt(row);
  // A time more than a day ahead of ours is a sentinel, an odd encoding or a
  // skewed clock, not this month: it would keep a stale count "current" into
  // every month that follows.
  if (ts === null || ts > now + 86_400_000) return "unreadable";
  return utcMonthOf(ts) < utcMonthOf(now) ? "earlier-month" : "this-month";
}

/** Pure: the row was last written in an EARLIER UTC month than `now`, so its
 *  usedMonth describes that month, not this one. Undated and unreadable rows
 *  are not "earlier" (sponsorshipRowMonth says what each one is). */
export function isSponsorshipRowFromEarlierMonth(row, now = Date.now()) {
  return sponsorshipRowMonth(row, now) === "earlier-month";
}

/** Pure: the row is evidence about THIS month's allowance - dated this month,
 *  or undated and taken at its word. A row from an earlier month, or with an
 *  unreadable updatedTs, is not. The one definition the canaries share. */
export function isSponsorshipRowEvidence(row, now = Date.now()) {
  const m = sponsorshipRowMonth(row, now);
  return m === "this-month" || m === "undated";
}
const mask = (a) => { const s = String(a || ""); return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };

// payTo -> { exhausted, evidenceAt, source, detail, effective, pausedSince, lastRead, heldAt, heldLogged }
// heldAt: the last headroom read the refusal hold set aside - proof the
// status is still being read, so the refusal's pause does not go stale while
// its hold runs. Only the hold writes it, always after the refusal it holds
// for; any later evidence moves evidenceAt past it, so it never outlives the
// episode that set it and needs no reset.
const state = new Map();
let log = (msg) => console.warn(msg);
// Set once the filter is on the resource server's prototype: only then does a
// refusal the gate answers for actually leave the next 402.
let gateInstalled = false;
// http request -> the requirements @x402/core built for it, BEFORE this gate
// filtered them: what the route offers, so a refusal can be checked against
// what the NEXT 402 for that route would still offer. Weak: dies with the request.
const offeredByRequest = new WeakMap();
const entry = (payTo) => {
  const k = String(payTo);
  if (!state.has(k)) state.set(k, { exhausted: false, evidenceAt: 0, source: null, detail: null, effective: false, pausedSince: null, lastRead: null, heldAt: null, heldLogged: false });
  return state.get(k);
};

/** Is the sub-cent Algorand accept withdrawn for this payTo right now? A read: logs nothing, fetches nothing. */
export function isSubcentPaused(payTo, now = Date.now()) {
  const s = state.get(String(payTo || ""));
  if (!s || !s.exhausted) return false;
  // A refusal's pause stays fresh while held headroom reads keep arriving
  // (the status is readable, and the refusal outranks it for the hold).
  const freshAt = Math.max(s.evidenceAt, s.heldAt || 0);
  if (now - freshAt > STALE_MS) return false;                     // stale evidence: fail open
  if (utcMonthOf(s.evidenceAt) !== utcMonthOf(now)) return false; // the allowance reset on the 1st
  return true;
}

/** Log ONE line per transition of the effective state. */
function reconcile(payTo, now) {
  const s = state.get(String(payTo));
  if (!s) return;
  const paused = isSubcentPaused(payTo, now);
  if (paused === s.effective) return;
  s.effective = paused;
  if (paused) {
    s.pausedSince = now;
    log(`[avm-subcent] Algorand PAUSED on routes priced under one cent (payTo ${mask(payTo)}): ${s.detail}. Routes of one cent and more keep Algorand; this is the facilitator's sponsored sub-cent allowance, not an outage.`);
  } else {
    s.pausedSince = null;
    const why = !s.exhausted ? "the facilitator reports headroom" : utcMonthOf(s.evidenceAt) !== utcMonthOf(now) ? "a new UTC month (the allowance resets)" : "the evidence went stale and the status is unreadable (failing open)";
    log(`[avm-subcent] Algorand OFFERED again on routes priced under one cent (payTo ${mask(payTo)}): ${why}.`);
  }
}

/**
 * Record a /sponsorship/status read. `readStartedAt` guards the one race that
 * matters: a read that began before a settle refusal cannot clear the pause
 * that refusal set. Nor can a later headroom read, until REFUSAL_HOLD_MS has
 * passed since that refusal ("held"). A row last updated in an earlier UTC
 * month, or whose updatedTs is not a readable time, is not evidence either
 * way (see the header). Returns "exhausted" | "headroom" | "held" |
 * "unreadable" | "predates-refusal" | "earlier-month" | "unreadable-timestamp".
 */
export function noteSponsorshipStatus(payTo, row, { now = Date.now(), readStartedAt = now } = {}) {
  if (!payTo) return "unreadable";
  const s = entry(payTo);
  if (!readable(row)) {
    if (s.lastRead !== "unreadable") log(`[avm-subcent] sponsorship status for payTo ${mask(payTo)} unreadable - keeping the last evidence until it is ${Math.round(STALE_MS / 60_000)} min old, then offering Algorand on every route (fail open)`);
    s.lastRead = "unreadable";
    reconcile(payTo, now);
    return "unreadable";
  }
  const month = sponsorshipRowMonth(row, now);
  if (month === "earlier-month") {
    if (s.lastRead !== "earlier-month") log(`[avm-subcent] sponsorship status for payTo ${mask(payTo)} was last updated ${new Date(sponsorshipRowUpdatedAt(row)).toISOString()}, before this UTC month began - not evidence for this month; only a fresh subcent_quota_exceeded refusal can pause sub-cent Algorand until the facilitator rewrites it`);
    s.lastRead = "earlier-month";
    reconcile(payTo, now);
    return "earlier-month";
  }
  if (month === "unreadable") {
    if (s.lastRead !== "unreadable-timestamp") log(`[avm-subcent] sponsorship status for payTo ${mask(payTo)} carries an updatedTs that is not a readable time (${JSON.stringify(String(row.updatedTs)).slice(0, 40)}) - it cannot name its month, so it is not evidence; only a fresh subcent_quota_exceeded refusal can pause sub-cent Algorand, and that pause fails open once stale`);
    s.lastRead = "unreadable-timestamp";
    reconcile(payTo, now);
    return "unreadable-timestamp";
  }
  s.lastRead = "ok";
  const exhausted = isSponsorshipExhausted(row);
  if (!exhausted && s.exhausted && s.source === "settle-refusal") {
    if (readStartedAt < s.evidenceAt) {
      reconcile(payTo, now);
      return "predates-refusal";
    }
    // Only a pause still in force is held: one that already failed open
    // (stale) or ended with the month is not brought back by a headroom read.
    if (now - s.evidenceAt < REFUSAL_HOLD_MS && isSubcentPaused(payTo, now)) {
      s.heldAt = now;
      if (!s.heldLogged) log(`[avm-subcent] the facilitator's status reads headroom for payTo ${mask(payTo)} but a sub-cent settle was refused ${Math.round((now - s.evidenceAt) / 1000)} s ago - keeping sub-cent Algorand withdrawn until ${Math.round(REFUSAL_HOLD_MS / 60_000)} min after that refusal, so a status that disagrees with its own settles cannot reopen the rail on every read`);
      s.heldLogged = true;
      reconcile(payTo, now);
      return "held";
    }
  }
  s.exhausted = exhausted;
  s.evidenceAt = now;
  s.source = "facilitator-status";
  s.detail = `the facilitator's status reads ${Number(row.usedMonth)}/${Number(row.quota)} sponsored sub-cent settlements used this month and no purchased units`;
  reconcile(payTo, now);
  return exhausted ? "exhausted" : "headroom";
}

/** The settle's own words name the sub-cent allowance: its errorReason does,
 *  or - only when that reason is generic, never a verdict about the payment
 *  (insufficient_funds, transaction_failed, invalid_*, *_expired) - its
 *  message does. The same rule src/payment-reject.js isBillingRefusalReceipt
 *  applies: words in a verdict's message cannot relabel it. */
function namesSubcentAllowance(errorReason, message) {
  if (/subcent_quota_exceeded/i.test(String(errorReason || ""))) return true;
  if (isPaymentVerdictReason(errorReason)) return false;
  return /subcent_quota_exceeded/i.test(String(message || ""));
}

/** A settle refused for the sub-cent allowance pauses that payTo at once.
 *  `errorReason` is the facilitator's own reason and `reason` any text around
 *  it (the summarised error); a payment verdict pauses nothing, whatever the
 *  text says. Returns true when it paused. */
export function noteAvmSettleRefusal({ network, payTo, reason, errorReason, now = Date.now() } = {}) {
  if (!avmSubcentGateEnabled()) return false;
  if (!String(network || "").startsWith(ALGORAND_PREFIX) || !payTo) return false;
  if (!namesSubcentAllowance(errorReason, reason)) return false;
  const s = entry(payTo);
  s.exhausted = true;
  s.evidenceAt = now;
  s.source = "settle-refusal";
  s.heldLogged = false; // a new refusal is a new hold, logged again once
  s.detail = "a settlement came back subcent_quota_exceeded";
  reconcile(payTo, now);
  return true;
}

/** Record what a route OFFERED this request, before the gate filtered it.
 *  The patched build calls it with the http request @x402/express hands the
 *  core; exported for the tests. */
export function rememberOfferedRequirements(req, requirements) {
  if (req && typeof req === "object" && Array.isArray(requirements)) offeredByRequest.set(req, requirements);
}

/** The requirement a request paid against: the offered one its payment
 *  header's `accepted` names (network, scheme, payTo, asset, amount). Null
 *  when the header is missing, undecodable, v1 or names nothing offered. */
function paidRequirementOf(req, offered) {
  const header = paymentHeaderOf(req);
  if (!header || !Array.isArray(offered)) return null;
  let accepted;
  try { accepted = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"))?.accepted; } catch { return null; }
  if (!accepted || typeof accepted !== "object") return null;
  const same = (a, b) => String(a ?? "") === String(b ?? "");
  return offered.find((r) => r && same(r.network, accepted.network) && same(r.scheme, accepted.scheme) && same(r.payTo, accepted.payTo)
    && same(r.asset, accepted.asset) && same(r.amount ?? r.maxAmountRequired, accepted.amount ?? accepted.maxAmountRequired)) || null;
}

/**
 * A settle receipt (decoded PAYMENT-RESPONSE) that THIS gate answers for: an
 * Algorand settle refused for the sub-cent allowance (never a payment verdict
 * whose message merely mentions it) while the gate is armed and installed,
 * on a requirement this request was offered that is under one cent, paid to a
 * payTo paused right now, AND that the next 402 for the same route actually
 * drops - a route whose only accept is that one keeps it (a 402 nobody can
 * pay is worse), and then nothing closes the loop. The settle-failure hook
 * has already paused the payTo (it runs before the response is written), so
 * the next sub-cent 402 no longer offers Algorand and the loop is closed here.
 * The settle breaker uses this, and only this, to keep such a refusal off the
 * BUYER's count. Every other billing refusal - another network, another
 * facilitator, the gate switched off, nothing withdrawn - has nothing
 * withdrawing its offer, so the breakers' bounds stay on it.
 */
export function isWithdrawnSubcentRefusal(receipt, { req = null, now = Date.now() } = {}) {
  if (!gateInstalled || !avmSubcentGateEnabled()) return false;
  if (!receipt || typeof receipt !== "object" || receipt.success !== false) return false;
  if (!String(receipt.network || "").startsWith(ALGORAND_PREFIX)) return false;
  if (!namesSubcentAllowance(receipt.errorReason, receipt.errorMessage)) return false;
  const offered = req && typeof req === "object" ? offeredByRequest.get(req) : null;
  const paid = paidRequirementOf(req, offered);
  if (!paid || String(paid.network) !== String(receipt.network)) return false;
  const paused = (p) => isSubcentPaused(p, now);
  // The requirement paid is the kind the gate withdraws...
  if (!isAvmSubcentRequirement(paid) || !paused(paid.payTo)) return false;
  // ...and the route's next 402 really withdraws something: the filter hands
  // back the SAME list when it drops nothing, which is also what the
  // never-empty rule does for a route whose only accept is the paused one.
  // (When it does drop, it drops every paused sub-cent Algorand accept, so
  // the one paid is among them.)
  return withoutPausedSubcentAvm(offered, paused) !== offered;
}

/** Pure: an Algorand USDC requirement priced under one cent. Anything unreadable is not. */
export function isAvmSubcentRequirement(r) {
  if (!r || typeof r !== "object" || !String(r.network || "").startsWith(ALGORAND_PREFIX)) return false;
  if (!USDC_ASA_IDS.has(String(r.asset ?? ""))) return false;
  let amount;
  try { amount = BigInt(String(r.amount ?? r.maxAmountRequired)); } catch { return false; }
  return amount < SUBCENT_ATOMIC;
}

/** Pure: `requirements` minus the sub-cent Algorand ones whose payTo is paused.
 *  Never returns an empty list (a 402 nobody can pay is worse than one rail
 *  that will refuse), and returns the SAME array when nothing is dropped. */
export function withoutPausedSubcentAvm(requirements, isPaused = isSubcentPaused) {
  if (!Array.isArray(requirements)) return requirements;
  const kept = requirements.filter((r) => !(isAvmSubcentRequirement(r) && isPaused(r.payTo)));
  return kept.length === requirements.length || kept.length === 0 ? requirements : kept;
}

/** Install once on the resource server class (idempotent). Returns true when it patched. */
export function installAvmSubcentGate(ResourceServerClass) {
  const proto = ResourceServerClass?.prototype;
  if (!proto || typeof proto.buildPaymentRequirementsFromOptions !== "function") return false;
  if (proto.buildPaymentRequirementsFromOptions[PATCHED]) { gateInstalled = true; return false; }
  const orig = proto.buildPaymentRequirementsFromOptions;
  const build = async function buildPaymentRequirementsFromOptions(paymentOptions, context) {
    const requirements = await orig.call(this, paymentOptions, context);
    try {
      // @x402/express hands the core { adapter } with the Express request on it.
      rememberOfferedRequirements(context?.adapter?.req, requirements);
      return withoutPausedSubcentAvm(requirements);
    } catch { return requirements; }
  };
  // Carry the inner patch's own marker (accept-output-schema) so its
  // install-once check still sees itself through this wrapper.
  for (const sym of Object.getOwnPropertySymbols(orig)) build[sym] = orig[sym];
  build[PATCHED] = true;
  proto.buildPaymentRequirementsFromOptions = build;
  gateInstalled = true;
  return true;
}

/**
 * The boot timer that reads /sponsorship/status. Unref'd, one read in flight
 * at a time, each bounded by `timeoutMs`; every tick also reconciles, so a
 * staleness or month transition is logged within one interval. Returns stop().
 */
export function startAvmSponsorshipRefresher({ facilitatorUrl, payTos, intervalMs = REFRESH_MS, firstDelayMs = 2_000, timeoutMs = 5_000, fetchImpl = globalThis.fetch } = {}) {
  const list = [...new Set((payTos || []).map((p) => String(p || "").trim()).filter(Boolean))];
  if (!facilitatorUrl || !list.length || typeof fetchImpl !== "function") return () => {};
  const base = String(facilitatorUrl).replace(/\/+$/, "");
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const payTo of list) {
        const readStartedAt = Date.now();
        let row = null;
        try {
          const r = await fetchImpl(`${base}/sponsorship/status?wallet=${encodeURIComponent(payTo)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
          if (r.ok) row = sponsorshipRowOf(await r.json());
        } catch { row = null; }
        noteSponsorshipStatus(payTo, row, { now: Date.now(), readStartedAt });
      }
    } finally { running = false; }
  };
  const first = setTimeout(tick, firstDelayMs);
  const every = setInterval(tick, intervalMs);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}

/** For /api/rails: status words and times only - never a payTo, never the counts. */
export function avmSubcentOfferStatus(now = Date.now()) {
  let since = null, source = null;
  for (const [payTo, s] of state) {
    if (!isSubcentPaused(payTo, now)) continue;
    if (since === null || (s.pausedSince ?? now) < since) { since = s.pausedSince ?? now; source = s.source; }
  }
  if (since === null) return [];
  return [{
    network: "algorand",
    scope: "routes priced under one cent",
    status: "paused",
    since: new Date(since).toISOString(),
    source,
    reason: "the facilitator's sponsored allowance for sub-cent settlements is spent for this month; routes of one cent and more still take Algorand",
    resumes: source === "settle-refusal"
      ? `when the facilitator reports headroom, no sooner than ${Math.round(REFUSAL_HOLD_MS / 60_000)} minutes after the last refused settlement, and no later than the first day of the next UTC month`
      : "when the facilitator reports headroom, and no later than the first day of the next UTC month",
  }];
}

/** Pure: a GET /api/rails document reports the pause avmSubcentOfferStatus
 *  publishes (a restriction {network:"algorand", status:"paused"}). The
 *  canaries excuse a sub-cent route without an Algorand accept ONLY on this;
 *  any other missing accept is the rail dropping out of the offer. An
 *  unreadable document reports nothing, so it excuses nothing. */
export function railsReportSubcentPause(rails) {
  return Array.isArray(rails?.restrictions) && rails.restrictions.some((r) => r?.network === "algorand" && r?.status === "paused");
}

/** Test-only. `installed` overrides the install flag (the prototype patch
 *  itself is process-wide and cannot be undone). */
export function _resetAvmSponsorshipForTest({ logger, installed } = {}) {
  state.clear();
  log = logger || ((msg) => console.warn(msg));
  if (typeof installed === "boolean") gateInstalled = installed;
}
