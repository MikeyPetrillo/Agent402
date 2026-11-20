// Which payment gates this process mounted, recorded by src/server.js at the
// line that mounts each one. The conformance document (src/conformance.js)
// reads it so a rail is listed as offered only when its gate is in the chain
// that serves requests, never from a switch alone.
const MOUNTED = new Set();

export const GATE_NAMES = Object.freeze(["hangupHook", "mppShim", "tempo", "stripe", "credits", "idempotency", "x402", "x402PayerScreen", "replayGuard", "pow", "receiptSigner", "mppSubscriptions"]);

/** Record that `names` are mounted. An unknown name throws, so a typo cannot
 *  leave a mounted gate unread. */
export function markGateMounted(...names) {
  for (const n of names) {
    if (!GATE_NAMES.includes(n)) throw new Error(`unknown gate name: ${n}`);
    MOUNTED.add(n);
  }
}

/** True when this process mounted the gate named `name`. */
export function gateMounted(name) { return MOUNTED.has(name); }
