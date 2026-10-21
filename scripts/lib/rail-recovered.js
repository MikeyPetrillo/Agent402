// Did a dropped rail's own facilitator recover? The rail self-heal
// (scripts/rail-selfheal.js) restarts production only on a yes, so a yes must
// mean exactly what the boot check would accept. For Arc that is Circle's
// /supported read through the same parser the payment client uses
// (src/circle-supported.js arcKindsFromSupported, dependency-free so this runs
// without the package install): an answer the boot check would reject is not
// a recovery, or the healer would restart every hour into the same drop.
import { arcKindsFromSupported, ARC_CAIP2 } from "../../src/circle-supported.js";

/** @param {string} rail network name as /api/rails reports it ("arc", "celo", ...)
 *  @param {{ ok: boolean, status: number, body: any }} answer the /supported read */
export function railRecovered(rail, answer) {
  if (!answer || !answer.ok || !answer.body) return false;
  if (rail === "arc") {
    try {
      return arcKindsFromSupported(answer.body).kinds.some((k) => k.scheme === "exact" && k.network === ARC_CAIP2);
    } catch {
      return false;
    }
  }
  return Array.isArray(answer.body.kinds);
}
