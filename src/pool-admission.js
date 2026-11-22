// Per-caller admission for the worker pools' queues (src/tools/office-pool.js,
// image-pool.js, html-pool.js, pdf-offthread.js), the rule the audio decode
// pool (src/tools/media-kit.js) and the OCR room (src/caller-turns.js) follow,
// built on src/caller-places.js:
//   - every running job and every waiting one holds a place under each key of
//     its caller (poolCaller(): every key the dispatching request carries, the
//     signed payer, a credits key, a Tempo sender and the client address with
//     an IPv6 one folded to its /64; the one shared in-process key when no
//     request is behind the call);
//   - at the queue's bound (`soft`) a caller whose own key already holds a
//     place is the one answered busy (its own excess), and a caller holding
//     nothing is queued over the bound, nobody giving way, up to the hard bound
//     (`hard` waiting jobs, and `hardBytes` held by them when the pool names
//     its jobs' sizes): the most the waiting jobs may hold in memory;
//   - only at the hard bound does a newcomer take a waiting place: the newest
//     of the party holding the most (by its own key, then by an address
//     several wallets pay from), never from a caller holding one place while
//     another party holds several; the job whose place it takes is answered
//     busy. Every party holding one place each: the newcomer is answered busy;
//   - a worker that frees goes to the waiting job whose caller holds the fewest
//     places under any of its keys, first come among equals, so one caller's
//     run of calls is served in the order it came.
// A caller alone can still fill the queue to `soft`, exactly as before.
import { createCallerPlaces } from "./caller-places.js";
import { IN_PROCESS_CALLER, currentDispatchCallerKeys } from "./dispatch-caller.js";

/** The caller a pool job runs for (src/dispatch-caller.js). */
export function poolCaller() {
  return currentDispatchCallerKeys() || [IN_PROCESS_CALLER];
}

const valueOf = (v) => (typeof v === "function" ? v() : v);

/**
 * `soft` and `hard` are waiting-job counts (numbers, or functions read on each
 * admission); `hardBytes` bounds the bytes the waiting jobs hold past `soft`
 * (each job's `bytes`; Infinity when the pool does not size them).
 */
export function createPoolAdmission({ soft, hard, hardBytes = Infinity }) {
  const places = createCallerPlaces();
  return {
    /**
     * May a job of `who` holding `bytes` join `queue` (the pool's waiting
     * jobs, each `{ who, bytes }`)? Answers `{ evicted: [jobs] }` (admitted;
     * those jobs were taken out of `queue` and are the pool's to answer busy)
     * or `{ refused: "own" | "full" }`. An admitted job is not yet in `queue`
     * and holds no place: the pool pushes it and calls hold().
     */
    admit(queue, who, bytes = 0) {
      const s = valueOf(soft);
      const h = Math.max(valueOf(hard), s);
      const maxBytes = valueOf(hardBytes);
      const queuedBytes = () => queue.reduce((n, j) => n + (Number(j.bytes) || 0), 0);
      const fits = (taken = []) => queue.length - taken.length < s;
      const fitsHard = (taken = []) => {
        let freed = 0;
        for (const i of taken) freed += Number(queue[i].bytes) || 0;
        return queue.length - taken.length < h && queuedBytes() - freed + (Number(bytes) || 0) <= maxBytes;
      };
      if (fits()) return { evicted: [] };
      const admitted = places.admit(queue, who, { fits, fitsHard });
      if (admitted.refused) return { refused: admitted.refused };
      return { evicted: admitted.taken.sort((a, b) => b - a).map((i) => queue.splice(i, 1)[0]) };
    },
    hold(who) { places.hold(who); },
    free(who) { places.free(who); },
    /** The index in `queue` of the job a free worker takes: of those `eligible`, the one whose caller holds the fewest places, first come among equals; -1 when none. */
    next(queue, eligible = () => true) {
      let at = -1, least = Infinity;
      for (let i = 0; i < queue.length; i++) {
        if (!eligible(queue[i])) continue;
        const n = places.most(queue[i].who);
        if (n < least) { least = n; at = i; }
      }
      return at;
    },
    /** Keys holding a place (0 when every place is free), for tests. */
    callers() { return places.callers(); },
  };
}
