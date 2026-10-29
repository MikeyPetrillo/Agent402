// Translate the ONE v1-era field name a live buyer still sends.
//
// Measured 2026-08-30: a client sent a payment header to /api/render roughly
// nine times a minute for twenty-one hours and was refused every time. Once the
// rejection classifier could report WHICH field of the echoed `accepted` block
// differed from what we advertise, the answer was a single key:
// `maxAmountRequired` - the x402 v1 name for what v2 calls `amount`. Everything
// else in their block matched ours exactly (the classifier reports the UNION of
// differing keys and reported only this one).
//
// x402 deep-equals the echoed entry against the advertised one, so that single
// rename made an otherwise-correct payment unmatchable, and it failed before
// the facilitator with a bare 402.
//
// WHY THIS IS SAFE, and the property that makes it worth doing at all:
//
//   1. STRICTLY NON-REGRESSIVE. It fires only when `accepted.maxAmountRequired`
//      is present AND `accepted.amount` is absent - a shape that is refused
//      100% of the time today. It can only turn a guaranteed failure into a
//      normal match attempt; it can never change the outcome of a payment that
//      works now.
//   2. IT DOES NOT TOUCH THE SIGNATURE. The EIP-3009 authorization signs
//      from/to/value/validAfter/validBefore/nonce. The `accepted` block is the
//      echoed requirements used for matching and is not signed, so renaming a
//      key inside it forges nothing and weakens no cryptography.
//   3. IT DOES NOT WEAKEN THE CHECK. The value is carried across unchanged and
//      the deep-equal still decides. A client that agreed to a DIFFERENT amount
//      still fails to match, exactly as before - this only removes a
//      vocabulary difference, never a disagreement about terms.
//
// AGENT402_X402_V1_ACCEPTS=off disables it.
import { ALGORAND_MAINNET_CAIP2, ALGORAND_MAINNET_LEGACY_CAIP2 } from "./avm-network.js";

/** The v1 name and its v2 equivalent. Deliberately a single, explicit pair -
 *  this is a known compatibility wart, not a general aliasing layer for the
 *  payment path. */
const V1_TO_V2 = Object.freeze({ maxAmountRequired: "amount" });

// The second explicit pair, with the same safety property: the full-hash
// spelling of Algorand mainnet is folded to the CAIP-2 id every 402 now
// carries. A payment naming the full hash can only have come from a client
// that keeps its own copy of the id; without the fold it never deep-equals an
// advertised accept and is refused before the facilitator. The Algorand
// signature covers the transaction group (whose genesis hash is the chain
// itself), not this block, and the facilitator reads both spellings as one
// chain, so the fold forges nothing and weakens no check.
const NETWORK_ALIASES = Object.freeze({ [ALGORAND_MAINNET_LEGACY_CAIP2]: ALGORAND_MAINNET_CAIP2 });

/**
 * Do two price fields name the SAME base-unit amount? Numeric equality, not
 * JSON equality: the surplus-alias rule below shipped 2026-08-30 comparing
 * `JSON.stringify` of both, and the /api/render buyer came back on 2026-09-03
 * still refused ~1,800 times in fourteen hours with the classifier naming
 * `maxAmountRequired` beside an `amount` that matched ours. A client that
 * copies the v2 string into a v1 NUMBER (`10000` vs `"10000"`) says the same
 * price twice, and a rule that reads those as a disagreement keeps refusing a
 * correct payment. Both values must parse as whole non-negative integers;
 * anything else falls back to exact JSON equality, so a genuinely different
 * price (or junk) is still left exactly as sent.
 */
function sameAmount(a, b) {
  const asInt = (v) => {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
    if (typeof v === "string" && /^\d{1,40}$/.test(v)) return BigInt(v);
    return null;
  };
  const x = asInt(a), y = asInt(b);
  if (x != null && y != null) return x === y;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function v1AcceptsTranslationEnabled() {
  return String(process.env.AGENT402_X402_V1_ACCEPTS || "").trim().toLowerCase() !== "off";
}

/**
 * @param {unknown} payload a decoded x402 payment payload
 * @returns {{payload: object, translated: string[]}|null} null when nothing applies
 */
export function translateV1Accepts(payload) {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const accepted = payload.accepted;
    if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) return null;
    const translated = [];
    const next = { ...accepted };
    for (const [v1, v2] of Object.entries(V1_TO_V2)) {
      if (!Object.hasOwn(next, v1)) continue;
      if (!Object.hasOwn(next, v2)) {
        // v1 name only: carry the value across under the v2 name.
        next[v2] = next[v1];
        delete next[v1];
        translated.push(v1);
      } else if (sameAmount(next[v1], next[v2])) {
        // BOTH names, SAME value: a hybrid client that emits the v2 field and
        // also keeps the v1 alias. The v1 key is surplus - we never advertised
        // it - and dropping it cannot change the terms agreed, because the
        // value it carries is identical to the one that stays. Measured
        // 2026-08-30: renaming alone did not convert the live buyer, because
        // their payload was this shape, not the v1-only one.
        delete next[v1];
        translated.push(`${v1}(surplus)`);
      }
      // BOTH names with DIFFERENT values: left exactly as sent. That is a real
      // disagreement about price, not a vocabulary difference, and it must
      // fail.
    }
    if (typeof next.network === "string" && Object.hasOwn(NETWORK_ALIASES, next.network)) {
      next.network = NETWORK_ALIASES[next.network];
      translated.push("network(alias)");
    }
    if (!translated.length) return null;
    return { payload: { ...payload, accepted: next }, translated };
  } catch { return null; }
}
