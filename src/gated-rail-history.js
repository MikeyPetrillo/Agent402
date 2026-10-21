// Has this server ever offered a gated rail (src/gated-rails.js)?
//
// A gated rail that its facilitator does not list (Circle answering /supported
// without Arc) is deliberately absent, not degraded: /api/rails leaves it out,
// so the heartbeat does not hold a rails-degraded issue open for a rail that
// was never live. Once the rail has been in the live offer, the same answer is
// a drop and reads degraded like any other rail. This remembers the first.
//
// Stored in the state database when one is configured, in the file otherwise
// (src/json-document.js); shared across replicas and kept across deploys.
import { createJsonDocument } from "./json-document.js";

let doc = null;
const docOf = () => {
  if (!doc) doc = createJsonDocument({ name: "gated-rail-history", file: process.env.GATED_RAIL_HISTORY_FILE || "/data/gated-rail-history.json", log: () => {} });
  return doc;
};
const bodyOf = (b) => (b && typeof b === "object" && b.offered && typeof b.offered === "object" ? b : { offered: {} });

/** True when `caip2` was in the live offer on any earlier (or this) boot. */
export async function gatedRailWasOffered(caip2) {
  try {
    const d = docOf();
    const b = bodyOf(d.backend === "pg" ? await d.load(null) : d.loadSync(null));
    return !!b.offered[String(caip2)];
  } catch {
    // Unknown history reads as "was offered": a drop that cannot be told apart
    // from an outage alarms rather than hides.
    return true;
  }
}

/** Record that `caip2` is in the live offer (first time only). */
export async function recordGatedRailOffered(caip2, at = Date.now()) {
  try {
    const d = docOf();
    if (d.backend === "pg") {
      await d.update((b) => { const x = bodyOf(b); if (!x.offered[caip2]) x.offered[caip2] = at; return x; }, { fallback: null });
    } else {
      const x = bodyOf(d.loadSync(null));
      if (!x.offered[caip2]) { x.offered[caip2] = at; await d.save(x); }
    }
  } catch { /* history is a convenience for the alarm, never on the paid path */ }
}
