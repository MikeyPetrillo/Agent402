// The per-minute ceilings on what the router's spending wallet holds for
// outside sellers through payX402 (src/x402-buyer.js reserveSpend), summed
// across buyers: an alarm ceiling the buyer keeps serving past, since every
// purchase there is for a buyer who is paying for it, and a hard ceiling where
// a purchase is refused as the stop for a runaway.
//
//   SOR_SPEND_CAP_ATOMIC       the alarm, in atomic USDC per minute (default
//                              2000000). Blank or malformed reads as the
//                              default, never as off. 0 is the switch: every
//                              purchase is refused.
//   SOR_SPEND_HARD_CAP_ATOMIC  the stop. Default HARD_MULTIPLIER times the
//                              alarm. Blank, malformed or 0 reads as the
//                              default; a value under the alarm reads as the
//                              alarm.
//
// The word on /api/gateway-status (routerSpendWindow): off (the switch),
// capped (a purchase was refused at the stop inside the last hour), over (a
// minute's holds passed the alarm inside the last hour, still serving), ok.
// over and capped page. A minute is far shorter than a pager's interval, so
// each mark is held REFUSAL_HOLD_MS, and it is also a flag in the shared store
// (src/shared-limits.js): the word reads the later of this process's mark and
// the shared one, so a new process does not read ok inside another's hold. No
// figure is printed here; the operator view carries the two ceilings.
import { withLoopDeadline } from "./loop-deadline.js";
import { HARD_MULTIPLIER, REFUSAL_HOLD_MS, STATUS_READ_MS, STATUS_FRESH_MS } from "./daily-ceilings.js";
import { shared, sharedLimitsEnabled, sharedWrite } from "./shared-limits.js";

const DEFAULT_ALARM_ATOMIC = 2_000_000n;
const readAtomic = (raw) => { const s = String(raw ?? "").trim(); return s.length <= 18 && /^\d+$/.test(s) ? BigInt(s) : null; };

/** { alarmAtomic, hardAtomic } as BigInt; both 0n while the switch is 0. */
export function spendWindowCeilings(env = process.env) {
  const alarmAtomic = readAtomic(env.SOR_SPEND_CAP_ATOMIC) ?? DEFAULT_ALARM_ATOMIC;
  if (alarmAtomic === 0n) return { alarmAtomic, hardAtomic: 0n };
  const h = readAtomic(env.SOR_SPEND_HARD_CAP_ATOMIC);
  const hardAtomic = h ? (h > alarmAtomic ? h : alarmAtomic) : alarmAtomic * BigInt(HARD_MULTIPLIER);
  return { alarmAtomic, hardAtomic };
}

const FLAG = "x402-buyer-window-mark";
const CONTROL = "x402-buyer";
// A mark already written to the shared store is written again only after this
// long, so a busy minute past the alarm costs one write, not one per purchase.
const SHARED_REWRITE_MS = 60_000;
const marks = {
  over: { until: 0, sharedUntil: 0, wroteAt: -Infinity },
  capped: { until: 0, sharedUntil: 0, wroteAt: -Infinity },
};
function mark(kind, now) {
  const m = marks[kind];
  const fresh = m.until <= now;
  m.until = now + REFUSAL_HOLD_MS;
  if (sharedLimitsEnabled() && now - m.wroteAt >= SHARED_REWRITE_MS) {
    m.wroteAt = now;
    void sharedWrite(CONTROL, shared.flagSet(FLAG, kind, m.until, { now }));
  }
  return fresh;
}

/** A minute's holds passed the alarm; the purchase is served. True when the mark is new. */
export function noteSpendWindowOver(now = Date.now(), log = console.warn) {
  const fresh = mark("over", now);
  if (fresh) log("[x402-buyer] a minute's holds for outside sellers passed SOR_SPEND_CAP_ATOMIC: still serving, the status word reads over for an hour (SOR_SPEND_HARD_CAP_ATOMIC is the stop)");
  return fresh;
}
/** A purchase was refused at the stop. True when the mark is new. */
export function noteSpendWindowRefused(now = Date.now(), log = console.warn) {
  const fresh = mark("capped", now);
  if (fresh) log("[x402-buyer] a purchase from an outside seller was refused at SOR_SPEND_HARD_CAP_ATOMIC: the status word reads capped for an hour");
  return fresh;
}

let readAt = -Infinity, inflight = null;
/** One bounded read of the shared marks, reused for STATUS_FRESH_MS; never rejects. */
export function refreshSpendWindowShared(now = Date.now(), { readMs = STATUS_READ_MS, freshMs = STATUS_FRESH_MS } = {}) {
  if (!sharedLimitsEnabled()) return Promise.resolve(false);
  if (inflight) return inflight;
  if (now - readAt < freshMs && now >= readAt) return Promise.resolve(false);
  const read = Promise.resolve().then(() => Promise.all([shared.flagGet(FLAG, "over", { now }), shared.flagGet(FLAG, "capped", { now })]));
  inflight = withLoopDeadline(read, readMs, null).catch(() => null).then((v) => {
    inflight = null;
    readAt = now;
    if (!v || !v[0]?.ok || !v[1]?.ok) return false;
    marks.over.sharedUntil = Number(v[0].until) || 0;
    marks.capped.sharedUntil = Number(v[1].until) || 0;
    return true;
  });
  return inflight;
}

const held = (m, now) => Math.max(m.until, m.sharedUntil) > now;
/** off / capped / over / ok. */
export function spendWindowWord(now = Date.now(), env = process.env) {
  if (spendWindowCeilings(env).alarmAtomic === 0n) return "off";
  return held(marks.capped, now) ? "capped" : held(marks.over, now) ? "over" : "ok";
}
/** The word alone publicly; the operator also reads the ceilings and when each mark ends. */
export function spendWindowStatus({ full = false, now = Date.now(), env = process.env } = {}) {
  const status = spendWindowWord(now, env);
  if (!full) return { status };
  const c = spendWindowCeilings(env);
  const end = (m) => { const u = Math.max(m.until, m.sharedUntil); return u > now ? new Date(u).toISOString() : null; };
  return { status, alarmAtomic: String(c.alarmAtomic), hardAtomic: String(c.hardAtomic), overUntil: end(marks.over), cappedUntil: end(marks.capped) };
}

/** Test seam: this process's marks and its cached shared read (the shared flags too). */
export function _resetSpendWindowMarks(now = Date.now()) {
  for (const kind of ["over", "capped"]) {
    Object.assign(marks[kind], { until: 0, sharedUntil: 0, wroteAt: -Infinity });
    if (sharedLimitsEnabled()) void sharedWrite(CONTROL, shared.flagSet(FLAG, kind, 0, { now }));
  }
  readAt = -Infinity;
}
