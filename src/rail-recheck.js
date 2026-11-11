// A rail dropped at boot because a facilitator's /supported read FAILED is
// read again in the background and restored when the facilitator lists it.
//
// The boot guard (src/payments.js) reads every facilitator's /supported once
// (6 s, one retry) and offers only the networks a reachable facilitator
// lists. A read that fails or times out is not an answer: the facilitator may
// list the network a moment later, and until this module the rail stayed off
// the offer until the next restart. So the facilitators whose boot read
// failed are read again on a backoff (first delay doubling to a ceiling), and
// a network one of them then lists `exact` on is handed to `restore`.
//
// A rail the facilitators truly do not list stays dropped: only networks
// dropped while at least one read had failed are candidates, each failed
// facilitator leaves the list as soon as it ANSWERS (with or without the
// network), and when none is left the remaining networks stay dropped and the
// loop ends. A facilitator that answered at boot is never read again here.
//
// Bounded: one read per failed facilitator per tick, each under `timeoutMs`,
// ticks spaced firstMs, 2x, 4x ... up to maxMs, one timer, unref'd. `restore`
// decides whether a listed network can join the live offer: true (restored),
// "defer" (not yet: asked again next tick) or false (not restorable in this
// process: left for the next restart, said once in the log).
export const RAIL_RECHECK_FIRST_MS = 30_000;
export const RAIL_RECHECK_MAX_MS = 10 * 60_000;

/** { enabled, firstMs, maxMs } from X402_RAIL_RECHECK_MS ("off" disables) and X402_RAIL_RECHECK_MAX_MS. */
export function railRecheckSettings(env = process.env) {
  const raw = String(env.X402_RAIL_RECHECK_MS ?? "").trim().toLowerCase();
  const enabled = !/^(0|off|false|no)$/.test(raw);
  const first = Number(raw);
  const firstMs = Number.isFinite(first) && first >= 50 ? Math.round(first) : RAIL_RECHECK_FIRST_MS;
  const max = Number(String(env.X402_RAIL_RECHECK_MAX_MS ?? "").trim());
  const maxMs = Math.max(firstMs, Number.isFinite(max) && max >= 50 ? Math.round(max) : RAIL_RECHECK_MAX_MS);
  return { enabled, firstMs, maxMs };
}

const isExact = (k) => typeof k?.scheme === "string" && k.scheme.toLowerCase() === "exact" && typeof k?.network === "string" && k.network;

/**
 * @param {object} o
 * @param {{client:{getSupported:Function}, label:string}[]} o.failed  facilitators whose boot read failed, in routing order
 * @param {string[]} o.dropped   CAIP-2 networks dropped while a read had failed
 * @param {(caip2:string, by:{client:object,label:string,supported:object}) => (boolean|"defer")} o.restore
 * @returns {{ tick: () => Promise<void>, start: () => void, stop: () => void, pendingNetworks: () => string[], failedLabels: () => string[], ticks: () => number }}
 */
export function createRailRecheck({ failed = [], dropped = [], restore, firstMs = RAIL_RECHECK_FIRST_MS, maxMs = RAIL_RECHECK_MAX_MS, timeoutMs = 6000, log = console.log, warn = console.warn, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const waiting = [...failed];
  const pending = new Set(dropped);
  const notRestorable = new Set();
  let timer = null, delay = firstMs, ticks = 0, running = false, done = false;

  const readOnce = (client) => {
    let t;
    const timeout = new Promise((_, reject) => { t = setTimer(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs); t?.unref?.(); });
    return Promise.race([Promise.resolve().then(() => client.getSupported()), timeout]).finally(() => clearTimer(t));
  };
  const finish = (why) => {
    done = true;
    if (timer) { clearTimer(timer); timer = null; }
    if (why) log(why);
  };

  async function tick() {
    if (done || running) return;
    running = true;
    ticks++;
    try {
      // Read in routing order, so an earlier facilitator's answer is applied first.
      const reads = await Promise.all(waiting.map(async (f) => {
        try { return { f, supported: await readOnce(f.client) }; } catch { return { f, supported: null }; }
      }));
      for (const { f, supported } of reads) {
        if (done) break;
        const kinds = supported && Array.isArray(supported.kinds) ? supported.kinds : null;
        if (!kinds) continue; // still failing: read again next tick
        let deferred = false;
        for (const caip2 of [...pending]) {
          if (!kinds.some((k) => isExact(k) && k.network === caip2)) continue;
          let r = false;
          try { r = restore(caip2, { client: f.client, label: f.label, supported }); } catch (e) {
            warn(`[payments] rail re-read: restoring ${caip2} failed (${String(e?.message || e).slice(0, 140)}); it stays dropped until the next restart`);
          }
          if (r === "defer") { deferred = true; continue; }
          pending.delete(caip2);
          if (r === true) log(`[payments] rail re-read: ${caip2} is offered again - ${f.label} now lists it (dropped at boot when its /supported read failed)`);
          else notRestorable.add(caip2);
        }
        // The facilitator has answered: it leaves the list unless a network it lists is waiting on this process.
        if (!deferred) waiting.splice(waiting.indexOf(f), 1);
      }
      if (!pending.size) return finish(notRestorable.size ? `[payments] rail re-read: done; ${[...notRestorable].join(", ")} can only rejoin the offer at the next restart` : null);
      if (!waiting.length) return finish(`[payments] rail re-read: every facilitator has answered and none lists ${[...pending].join(", ")} - it stays dropped`);
    } finally {
      running = false;
    }
    schedule();
  }

  function schedule() {
    if (done || timer) return;
    const wait = delay;
    delay = Math.min(maxMs, delay * 2);
    timer = setTimer(() => { timer = null; tick().catch(() => { schedule(); }); }, wait);
    timer?.unref?.();
  }

  return {
    tick,
    start: () => { if (!waiting.length || !pending.size) { done = true; return; } schedule(); },
    stop: () => finish(null),
    /** Networks still waiting on a facilitator's answer. */
    pendingNetworks: () => (done ? [] : [...pending]),
    failedLabels: () => waiting.map((f) => f.label),
    ticks: () => ticks,
  };
}
