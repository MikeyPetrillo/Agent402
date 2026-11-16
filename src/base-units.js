// Dollar amounts to a token's base units, in integer arithmetic.
//
// A price multiplied as a float by 10 ** decimals drifts once the product
// passes 2 ** 53: at 18 decimals Math.round(0.00391 * 1e18) is
// 3910000000000001, while the challenge minted from the same price
// (toFixed, parseUnits) names 3910000000000000, so a buyer who paid exactly
// the minted amount was refused as one base unit short. Here the number is
// read as its shortest decimal spelling (the one JavaScript prints, so 0.003
// is "0.003") and scaled by moving the decimal point, so one price gives the
// same figure at 6, 7 or 18 decimals: the amount at d decimals times
// 10 ** (e - d) is the amount at e decimals whenever the price has no more
// than d decimal places. A price with more places than the token rounds half
// up at the last place the token carries.
//
// Every place that mints an amount and every place that checks one against a
// price reads it here, so the two cannot disagree.
//
// A leaf: no imports beyond the x402 core helper the money parsers use.
import { numberToDecimalString } from "@x402/core/utils";

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** The plain decimal spelling of a dollar amount (a finite non-negative
 *  number, or a string such as "0.003" or "$0.003"); throws RangeError on
 *  anything else, as BigInt(Math.round(NaN)) did before. */
export function decimalStringOf(usd) {
  let s;
  if (typeof usd === "number") {
    if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`not a dollar amount: ${usd}`);
    s = numberToDecimalString(usd);
  } else if (typeof usd === "string") {
    s = usd.trim().replace(/^\$/, "");
  } else if (typeof usd === "bigint") {
    if (usd < 0n) throw new RangeError(`not a dollar amount: ${usd}`);
    s = usd.toString();
  } else {
    throw new RangeError(`not a dollar amount: ${typeof usd}`);
  }
  if (!DECIMAL.test(s)) throw new RangeError(`not a dollar amount: ${String(usd).slice(0, 40)}`);
  return s;
}

/** A dollar amount in base units of a token with `decimals` places, as a
 *  BigInt. Exact whenever the amount has no more places than the token;
 *  otherwise rounded half up at the token's last place. */
export function usdToBaseUnits(usd, decimals) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) throw new RangeError(`not a token decimals value: ${decimals}`);
  const [, int, frac = ""] = DECIMAL.exec(decimalStringOf(usd));
  const kept = frac.slice(0, d).padEnd(d, "0");
  let units = BigInt(int + kept);
  if (frac.length > d && frac.charCodeAt(d) >= 53 /* "5" */) units += 1n;
  return units;
}

/** Base units back to a plain decimal string with exactly `decimals` places
 *  ("3000", 6 -> "0.003000"): the spelling an SDK that parses a decimal
 *  amount at `decimals` places reads back to the same base units. */
export function baseUnitsToDecimalString(units, decimals) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) throw new RangeError(`not a token decimals value: ${decimals}`);
  const s = BigInt(units).toString();
  if (s.startsWith("-")) throw new RangeError("negative base units");
  if (d === 0) return s;
  const padded = s.padStart(d + 1, "0");
  return `${padded.slice(0, -d)}.${padded.slice(-d)}`;
}

/** A dollar amount as the decimal string a token with `decimals` places
 *  carries: usdToBaseUnits, spelled back as a decimal. */
export function usdToTokenDecimalString(usd, decimals) {
  return baseUnitsToDecimalString(usdToBaseUnits(usd, decimals), decimals);
}
