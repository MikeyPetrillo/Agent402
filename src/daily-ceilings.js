// The two daily spend ceilings a metered upstream kit reads (the X data kit
// and the Exa kit): an alarm ceiling the kit keeps serving past, since every
// call there is paid for by its buyer, and a hard ceiling where it refuses.
//
//   <ALARM env>  default 1. Blank or malformed reads as the default, never as
//                off. 0 is the switch: every call is refused.
//   <HARD env>   default HARD_MULTIPLIER times the alarm ceiling. A blank,
//                malformed or non-positive value reads as the default, and a
//                value under the alarm ceiling reads as the alarm ceiling.
//
// The word on /api/gateway-status: off (the switch), capped (the hard ceiling
// refuses, or refused a call inside the last hour), over (past the alarm
// ceiling, still serving), ok. over and capped page. The word is built from
// the larger of this process's day and the shared day counter, so a new
// process does not read ok on a day already past a ceiling. No figure is
// printed here.
import { withLoopDeadline } from "./loop-deadline.js";

export const HARD_MULTIPLIER = 5;
const DEFAULT_ALARM_USD = 1;

const readNumber = (raw) => { const s = String(raw ?? "").trim(); return s === "" ? NaN : Number(s); };

/** { alarmUsd, hardUsd, refuseAtUsd }: refuseAtUsd is 0 while the switch is 0. */
export function dailyCeilings(alarmEnv, hardEnv, env = process.env) {
  const a = readNumber(env[alarmEnv]);
  const alarmUsd = Number.isFinite(a) && a >= 0 ? a : DEFAULT_ALARM_USD;
  const h = readNumber(env[hardEnv]);
  const hardUsd = Number.isFinite(h) && h > 0 ? Math.max(h, alarmUsd) : alarmUsd * HARD_MULTIPLIER;
  return { alarmUsd, hardUsd: alarmUsd === 0 ? 0 : hardUsd, refuseAtUsd: alarmUsd === 0 ? 0 : hardUsd };
}

/**
 * The status word for a day's booked spend in micro-dollars. `refusing`: a
 * call was refused at the hard ceiling inside the hold (a refused call books
 * nothing, so the total alone can sit under the ceiling while calls are
 * turned away).
 */
export function ceilingWord(spentMicro, { alarmUsd, hardUsd }, { refusing = false } = {}) {
  const at = (usd) => spentMicro >= Math.round(usd * 1e6);
  return alarmUsd === 0 ? "off" : refusing || at(hardUsd) ? "capped" : at(alarmUsd) ? "over" : "ok";
}

/** How long after a refusal at the hard ceiling the word reads capped. */
export const REFUSAL_HOLD_MS = 60 * 60_000;
/** The longest a status read waits on the shared store for one kit's day (loop time). */
export const STATUS_READ_MS = 400;
/** A shared read (or a failed one) is reused this long. */
export const STATUS_FRESH_MS = 5_000;
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * The shared half of a kit's status word. The kit's own counters start empty
 * in a new process, while the day's shared counter (the one the refusal
 * reads) does not, so the word is built from the larger of the two. `refresh`
 * is one bounded read, reused for STATUS_FRESH_MS and shared by concurrent
 * callers; it never rejects, and a read that fails or runs past the bound
 * leaves the last value seen that day (nothing, in a new process: the kit's
 * own counter then decides alone). `sharedSpend` is a createSharedDailySpend.
 */
export function createSharedCeilingView(sharedSpend, { readMs = STATUS_READ_MS, freshMs = STATUS_FRESH_MS } = {}) {
  const seen = { day: "", micro: 0, refusedUntil: 0 };
  let readAt = -Infinity, inflight = null;
  return {
    refresh(now = Date.now()) {
      if (!sharedSpend.enabled) return Promise.resolve(false);
      if (inflight) return inflight;
      if (now - readAt < freshMs && now >= readAt) return Promise.resolve(false);
      inflight = withLoopDeadline(Promise.resolve().then(() => sharedSpend.view(now)), readMs, null).catch(() => null).then((v) => {
        inflight = null;
        readAt = now;
        if (!v) return false;
        seen.day = v.day; seen.micro = Number(v.units) || 0; seen.refusedUntil = Number(v.refusedUntil) || 0;
        return true;
      });
      return inflight;
    },
    /** The shared total last read for this UTC day, in micro-dollars (0 with none). */
    micro(now = Date.now()) { return seen.day === utcDay(now) ? seen.micro : 0; },
    /** True while a refusal any replica noted is inside its hold. */
    refusing(now = Date.now()) { return seen.day === utcDay(now) && seen.refusedUntil > now; },
    reset() { seen.day = ""; seen.micro = 0; seen.refusedUntil = 0; readAt = -Infinity; },
  };
}

/**
 * One log line the first time a UTC day's spend passes the alarm ceiling.
 * `state` is the kit's own day record ({ day, overLogged }).
 */
export function noteOverAlarm(state, tag, alarmEnv, hardEnv, log = console.warn) {
  if (state.overLogged === state.day) return false;
  state.overLogged = state.day;
  log(`${tag} the day's spend passed ${alarmEnv}: still serving, the status word reads over until 00:00 UTC (${hardEnv} is the stop)`);
  return true;
}
