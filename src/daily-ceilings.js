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
// refuses), over (past the alarm ceiling, still serving), ok. over and capped
// page. No figure is printed here.
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

/** The status word for a day's booked spend in micro-dollars. */
export function ceilingWord(spentMicro, { alarmUsd, hardUsd }) {
  const at = (usd) => spentMicro >= Math.round(usd * 1e6);
  return alarmUsd === 0 ? "off" : at(hardUsd) ? "capped" : at(alarmUsd) ? "over" : "ok";
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
