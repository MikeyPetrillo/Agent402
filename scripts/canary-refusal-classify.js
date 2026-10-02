// Is a facilitator's 402 reason the shape of OUR burner being unfunded or
// not opted in - or is it the facilitator refusing for a reason of its own?
//
// Pure and side-effect-free so scripts/test-canary-refusal-classify.js can drive
// it without booting the canary (which buys on import).
//
// WHY THE DISTINCTION EXISTS. The Solana, Algorand and Robinhood legs of the
// paid canary were WARN-only by design: "an unset or unfunded burner cannot
// open an issue". That premise held as long as every failure on those legs was
// our own wallet. On 2026-09-21 it stopped holding. The AVM facilitator began
// refusing sub-cent settlements with `subcent_quota_exceeded`; the Algorand leg
// recorded an outage to /status, printed WARN, and the run still said "all rail
// legs settled" and exited 0. The rail stayed refused for the rest of the day,
// /status showed it, and nothing paged - because the one path that pages never
// saw it. The weekly Algorand sweep had failed the same way that morning, after
// 145 clean sub-cent settlements, and was read as a generic facilitator outage.
//
// So the leg keeps its designed behaviour for the failures the design was
// about - a burner we forgot to fund or opt in - and pages for everything else.
// A reason we cannot classify is "everything else": a refusal we do not
// understand is exactly the kind that should reach a human.
const FUNDING_SHAPED = [
  /insufficient[ _-]?(funds|balance)/i,
  /\bunfunded\b/i,
  /\bnot[ _-]?opted[ _-]?in\b|\bopt[ _-]?in\b/i,
  /asset[ _-]?(not[ _-]?)?(held|missing|not_opted)/i,
  /\bno[ _-]?(usdc|usdg|token)[ _-]?(balance|account|holding)?\b/i,
  /below[ _-]?min(imum)?[ _-]?balance/i,
  /\bbalance[ _-]?too[ _-]?low\b/i,
  /overspend|would[ _-]?overspend/i,
];

/** True when the facilitator's stated reason is our own wallet's funding or
 *  opt-in state - the only class the WARN-only design was ever about. */
export function isFundingShapedRefusal(reason) {
  const text = typeof reason === "string" ? reason : JSON.stringify(reason ?? "");
  if (!text) return false;
  return FUNDING_SHAPED.some((re) => re.test(text));
}

/** How a WARN-only leg should treat a 402 it just received. */
export function legRefusalVerdict(reason) {
  return isFundingShapedRefusal(reason) ? "warn" : "page";
}
