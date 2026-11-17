// Per-caller places in a bounded shared queue (the large-image OCR slot in
// src/tools/ocr-kit.js, the audio decode pool in src/tools/media-kit.js).
// A caller (`who`) is one key or a list of keys, strongest first
// (src/dispatch-caller.js admissionCallerOf: the signed payer, a credits key,
// a Tempo sender, then the client address). The caller IS its own key: the
// first of the list, so its strongest signed key, or its address only when
// it signs nothing. Each place it holds (a slot, a queued place) is counted
// under that key. When the queue is full, a newcomer whose own key holds no
// place is never refused for want of room while a queued place belongs to a
// caller whose own key holds more than one place: that place is taken
// (newest first) and its waiter answered busy, so one caller's run of calls
// cannot hold every place. Buyers behind one address (a NAT, a hosted agent
// platform, an IPv6 /64) are each their own caller, for admission as for
// eviction: one buyer's place is never taken because another signs from the
// same address, a buyer is never refused because another at its address
// holds places, and an unsigned caller's place is never taken for a signed
// buyer's place at its address. One party paying from several wallets is
// several callers. A request that names no caller at all (ANONYMOUS_CALLER)
// is always a newcomer: its places are counted together under that key, so
// a run of them gives up its newest queued place to any newcomer, but one
// such request holding a place never refuses the next.
import { IN_PROCESS_CALLER, ANONYMOUS_CALLER } from "./dispatch-caller.js";

/** The keys a place is counted under: `who` itself, or each of a list of
 *  keys (strongest first), or the one shared key when it names none. */
export function placeKeysOf(who) {
  const list = Array.isArray(who) ? [...new Set(who.filter((k) => typeof k === "string" && k))] : (typeof who === "string" && who ? [who] : []);
  return list.length ? list : [IN_PROCESS_CALLER];
}

const bump = (map, k, d) => { const n = (map.get(k) || 0) + d; if (n > 0) map.set(k, n); else map.delete(k); };

export function createCallerPlaces() {
  const held = new Map(); // key -> places held under it (slots and queued), every key of each caller
  const own = new Map(); // a caller's own key (placeKeysOf(who)[0]) -> places that caller holds
  return {
    hold(who) { const keys = placeKeysOf(who); for (const k of keys) bump(held, k, 1); bump(own, keys[0], 1); },
    free(who) { const keys = placeKeysOf(who); for (const k of keys) bump(held, k, -1); bump(own, keys[0], -1); },
    /** The places the caller holds under its own key. */
    count(who) { return own.get(placeKeysOf(who)[0]) || 0; },
    /** Keys holding a place (0 when every place is free). */
    callers() { return held.size; },
    /** The indexes in `waiters` (each `{ who }`) whose places a newcomer `who`
     *  takes so that `fits(indexes)` holds, newest first, each from a caller
     *  whose own key still holds more than one place once the earlier ones
     *  are taken; null when the caller's own key already holds a place (an
     *  anonymous request never does) or no such set fits. */
    victims(waiters, who, fits = (idx) => idx.length >= 1) {
      const mine = placeKeysOf(who)[0];
      if (mine !== ANONYMOUS_CALLER && own.has(mine)) return null;
      const left = new Map(own);
      const chosen = [];
      for (let i = waiters.length - 1; i >= 0; i--) {
        const k = placeKeysOf(waiters[i].who)[0];
        if ((left.get(k) || 0) <= 1) continue;
        left.set(k, left.get(k) - 1);
        chosen.push(i);
        if (fits(chosen)) return chosen;
      }
      return null;
    },
  };
}
