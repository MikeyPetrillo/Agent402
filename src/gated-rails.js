// Rails that appear on runtime surfaces only while they are actually offered.
//
// A gated rail (none today; Arc was one until it settled in production) is
// known to the payment stack but is not part of the static rails list
// (src/rails.js RAILS) that public copy is derived from.
// It is named on a runtime surface (the /.well-known/x402 chain list, the
// how-to-pay page, the /<chain> page, the nav, the sitemap, the live revenue
// read) only after src/payments.js has finished the boot offer and the rail
// survived it: its key is set AND its facilitator's /supported check passed.
// Until then those surfaces are byte-identical to a build without the rail.
//
// Dependency-free so payments.js, rails.js, market-page.js and revenue-live.js
// can all read it without an import cycle.

const offered = new Set();
const listeners = [];

/** Called by src/payments.js once per gated rail that is in the final offer. */
export function markGatedRailOffered(caip2) {
  const k = String(caip2 || "");
  if (!k || offered.has(k)) return;
  offered.add(k);
  for (const fn of listeners) {
    try { fn(k); } catch { /* a listener failing never blocks the offer */ }
  }
}

/** True once the rail is in the live offer. */
export function gatedRailOffered(caip2) {
  return offered.has(String(caip2 || ""));
}

/** Run fn(caip2) for each gated rail as it becomes offered (and for any already offered). */
export function onGatedRailOffered(fn) {
  listeners.push(fn);
  for (const k of offered) {
    try { fn(k); } catch { /* same rule */ }
  }
}

/** Test-only. */
export function __resetGatedRailsForTests() {
  offered.clear();
}
