// Pure classifiers for the Algorand rail canary (scripts/algorand-rail-canary.js).
// Extracted into a side-effect-free module so they can be unit-tested without
// booting the sweep (the canary self-runs on import). See
// scripts/test-algorand-canary-classify.js.
import { railsReportSubcentPause, sponsorshipRowMonth } from "../src/avm-sponsorship.js";
import { REJECTION_REASONS } from "../src/payment-reject.js";

/**
 * What a SUB-CENT route's missing Algorand accept means (the paid canary's
 * Algorand leg). While the facilitator's sponsored sub-cent allowance is spent
 * the server withdraws Algorand from sub-cent 402s and says so on GET
 * /api/rails; that is the only excuse. Returns:
 *   "offered"   the sub-cent 402 carries Algorand;
 *   "withdrawn" it does not, and /api/rails reports the Algorand pause;
 *   "missing"   it does not and /api/rails reports no pause (or could not be
 *               read): the rail dropped out of the sub-cent offer - a failure;
 *   "no-rail"   the one-cent route carries no Algorand accept either, so there
 *               is nothing to compare (the leg's own buy decides).
 */
export function subcentAcceptVerdict({ centAccept, subcentAccept, rails } = {}) {
  if (subcentAccept) return "offered";
  if (!centAccept) return "no-rail";
  return railsReportSubcentPause(rails) ? "withdrawn" : "missing";
}

// A 402 that comes back faster than this never reached the chain (real Algorand
// round trips measured 5s+): the AVM-specific shape of a throttle/burst reject.
export const FAST_REJECT_MS = Number(process.env.CANARY_FAST_REJECT_MS || "1500");

// OUR OWN settle-failure breaker, not a vendor. It answers 429 to a wallet
// whose payments verified and then failed to settle, and the window is
// GATEWAY_SETTLE_BREAKER_WINDOW_MS (15 minutes by default), not seconds.
//
// This has to be its own class because the sweep is ONE wallet buying ~500
// tools back to back: three settle failures in a window and every later
// wallet-only tool is refused before its handler runs. On 2026-09-21 an
// upstream facilitator failed at 13:31 after 145 clean settlements and 346 of
// the remaining attempts came back as this - reported as "upstream throttles
// (vendor refused us even after a backoff)", which is our own guard described
// as somebody else's, and it points the next reader at the wrong system.
//
// Matched on OUR text rather than on 429 alone: a real vendor 429 is still a
// vendor 429 and still belongs in isThrottle.
export const isOurSettleBreaker = (status, body) =>
  status === 429 && /failed to settle|settle breaker|paid catalog is paused/i.test(String(body || ""));

// The facilitator is refusing THIS wallet's volume (429, or a 503 that says so),
// not a rail defect - this sweep buys ~500 tools back to back.
export const isThrottle = (status, body) =>
  !isOurSettleBreaker(status, body) &&
  (status === 429 || (status === 503 && /rate.?limit|throttl|too many|overload/i.test(String(body || ""))));

// A THIRD-PARTY or EDGE failure: a vendor 5xx, a router "Seller rejected the
// paid retry", or Railway's edge returning 502 "upstream error" mid-deploy
// (which hits pure-CPU tools too, so it is never a handler defect). A >=400
// cancels settlement, so the buyer is never charged and the fault is not our
// rail or handler - reported, never fails the run.
export const isUpstreamOutage = (status, body) =>
  status === 502 || status === 503 || status === 504 ||
  /Seller rejected the paid retry|upstream error|operation was aborted|aborted due to timeout|ECONNRESET|ETIMEDOUT|socket hang up|Bad Gateway|Gateway Time-?out|fetch failed/i.test(String(body || ""));

// OUR OWN gate refusing the credential before any facilitator is asked: the
// body names the refusal class in a top-level `reason` (requirements-mismatch,
// unsupported-network, authorization-expired ...). It is fast BECAUSE nothing
// went to the chain, and that speed used to read as "throttle" - the metered
// Messages wire failed this way for two weekly runs (2026-08-31, 09-07) and
// was filed as our own wallet being rate-limited. A named refusal is a rail
// verdict whatever its latency.
//
// Read as parsed JSON, keyed on the reason the classifier publishes. The 402
// body also carries the full offer (it mirrors the PAYMENT-REQUIRED header),
// and a refusal that explains itself carries no `error` at all (not "Payment
// rejected", not the header's sentence), and a substring match could hit a
// `reason` nested in an extension's example.
// facilitator-quota is left out: it comes from a SETTLE refusal, which was
// never a gate refusal.
const GATE_REASONS = new Set(REJECTION_REASONS.map((r) => r.reason).filter((r) => r !== "facilitator-quota"));
export const isGateRefusal = (status, body) => {
  if (status !== 402) return false;
  let d;
  try { d = JSON.parse(String(body || "")); } catch { return false; }
  return !!d && typeof d === "object" && !Array.isArray(d) && GATE_REASONS.has(d.reason);
};

// Terminal shape of one paid attempt:
// "ok" | "empty" | "breaker" | "fast-402" | "throttle" | "slow-402" | "other".
//
// `breaker` is tested BEFORE the 402 shapes and before isThrottle, because it
// is the one outcome that says nothing about the tool under test: the request
// was refused before its handler ran, so the sweep measured nothing and must
// not report a verdict either way.
export const outcomeOf = (a) =>
  a.status === 200 && String(a.body || "").trim() ? "ok"
    : a.status === 200 ? "empty"
      : isOurSettleBreaker(a.status, a.body) ? "breaker"
      : isGateRefusal(a.status, a.body) ? "slow-402"
      : a.status === 402 && a.elapsedMs < FAST_REJECT_MS ? "fast-402"
        : isThrottle(a.status, a.body) ? "throttle"
          : a.status === 402 ? "slow-402"
            : "other";

// ---------------------------------------------------------------------------
// SUB-CENT BUDGET (2026-09-22). GoPlausible sponsors the Algorand fee on every
// settlement we serve and gives each payTo a free sponsored sub-cent
// (< $0.01) settlements per UTC month; at or above $0.01 is unlimited. The
// weekly sweep is ~470 sub-cent buys from one wallet, so in September it spent
// the whole allowance by itself - 1,325 settlements, zero outside buyers - and
// from the 21st every sub-cent buyer on the rail was refused. The operator
// chose to wait for the October reset rather than buy Settlement Units, so the
// sweep must never again be the thing that spends the allowance.
//
// Two pure pieces, tested without booting the sweep:
//   subcentBudget  - how many sub-cent settles THIS run may make, from the live
//                    quota read minus a reserve kept for real buyers, capped.
//   rotateSubcent  - which sub-cent tools get this run's budget, moving the
//                    window each week so the whole catalog is still exercised
//                    over a month instead of the same first N forever.

/** Sub-cent settles this run may make. `status` is the facilitator's
 *  /sponsorship/status row for our payTo (quota, usedMonth, suBalance), or
 *  null when it could not be read - then the fixed cap alone applies, because
 *  a quota we cannot read is not a licence to spend. Never negative. */
export function subcentBudget({ status, max, reserve, now = Date.now() }) {
  const cap = Math.max(0, Math.floor(Number(max) || 0));
  if (!status || !Number.isFinite(Number(status.quota))) return { budget: cap, source: "cap-only", remaining: null };
  // A row last written in an EARLIER UTC month is last month's count: the
  // allowance reset on the 1st and the facilitator may only roll its counter on
  // the next write. Budget it as reset (the server's rule, src/avm-sponsorship.js);
  // if the facilitator has NOT reset, the first sub-cent buy is refused and
  // that is a rail failure the run reports, instead of a zero budget that
  // excuses it every week. A row whose updatedTs is present but not a
  // readable time cannot name its month, and here the safer reading differs
  // from the gate's: the gate fails open for buyers, but the budget spends
  // what buyers would be left, so an unreadable row's usedMonth is taken at
  // its word and the reserve kept for buyers holds.
  const month = sponsorshipRowMonth(status, now);
  const notThisMonth = month === "earlier-month";
  const quota = Number(status.quota), used = notThisMonth ? 0 : (Number(status.usedMonth) || 0), su = Number(status.suBalance) || 0;
  const remaining = Math.max(0, quota - used) + Math.max(0, su);
  const spendable = Math.max(0, remaining - Math.max(0, Number(reserve) || 0));
  const source = month === "earlier-month" ? "live (row from an earlier month, counted as reset)"
    : month === "unreadable" ? "live (row's updatedTs is not a readable time, usedMonth taken at its word)" : "live";
  return { budget: Math.min(cap, spendable), source, remaining };
}

/** Order the sweep's tools so that this week's window of sub-cent tools comes
 *  first and the rest of the sub-cent tools are marked to skip. Tools at or
 *  above one cent are untouched and never budgeted. Deterministic in `week`,
 *  so two runs in the same week cover the same tools and next week's cover the
 *  next window; with cap C over N sub-cent tools the whole set is exercised in
 *  ceil(N / C) weeks. */
export function rotateSubcent(tools, { week, cap }) {
  const sub = tools.filter((t) => Number(t.priceUsd) < 0.01).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  const n = sub.length;
  const c = Math.max(0, Math.floor(Number(cap) || 0));
  if (n === 0 || c === 0) return tools.map((t) => ({ ...t, subcentSkip: Number(t.priceUsd) < 0.01 }));
  const start = (Math.max(0, Math.floor(Number(week) || 0)) * c) % n;
  const chosen = new Set();
  for (let i = 0; i < Math.min(c, n); i++) chosen.add(sub[(start + i) % n].slug);
  return tools.map((t) => ({ ...t, subcentSkip: Number(t.priceUsd) < 0.01 && !chosen.has(t.slug) }));
}
