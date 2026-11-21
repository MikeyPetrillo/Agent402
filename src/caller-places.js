// Per-caller places in a bounded shared queue (the audio decode pool in
// src/tools/media-kit.js, the OCR room in src/caller-turns.js).
// A caller (`who`) is one key or a list of keys, strongest first
// (src/dispatch-caller.js admissionCallerOf: the signed payer, a credits key,
// a Tempo sender, then the client address). The caller IS its own key: the
// first of the list, so its strongest signed key, or its address only when
// it signs nothing. Each place it holds (a slot, a queued place) is counted
// under that key, and under every other key it carries.
//
// When the queue is full, a newcomer whose own key holds no place is never
// refused for want of room while a queued place can be given up, newest first:
//   1. a place of a caller whose own key holds more than one, so one caller's
//      run of calls cannot hold every place;
//   2. failing that, and for a newcomer none of whose keys holds a place (a
//      new payer from a new address), a place counted under a key that holds
//      more than one: several wallets paying from one address are one party
//      at a full queue, so that party cannot hold every place either.
// The waiter that gives up its place is answered busy. Buyers behind one
// address (a NAT, a hosted agent platform, an IPv6 /64) are otherwise each
// their own caller: a buyer is never refused because another at its address
// holds places (rule 1 serves it as a newcomer), and one buyer's only place
// is taken under rule 2 alone, when the queue is full, its address holds
// several places and the caller arriving holds none anywhere. A request that
// names no caller at all (ANONYMOUS_CALLER) is always a newcomer under rule 1:
// its places are counted together under that key, so a run of them gives up
// its newest queued place to any newcomer, but one such request holding a
// place never refuses the next; it takes nothing under rule 2.
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
    /** The most places held under any one of the caller's keys. */
    most(who) { let m = 0; for (const k of placeKeysOf(who)) m = Math.max(m, held.get(k) || 0); return m; },
    /** The indexes in `waiters` (each `{ who }`) whose places a newcomer `who`
     *  takes so that `fits(indexes)` holds, newest first: places of callers
     *  whose own key still holds more than one once the earlier ones are
     *  taken, then (for a newcomer none of whose keys holds a place) places
     *  counted under any key that still holds more than one. Never more
     *  places than `fits` needs. null when the caller's own key already
     *  holds a place (an anonymous request never does) or no such set fits. */
    victims(waiters, who, fits = (idx) => idx.length >= 1) {
      const keys = placeKeysOf(who);
      const mine = keys[0];
      if (mine !== ANONYMOUS_CALLER && own.has(mine)) return null;
      const left = new Map(own), leftAny = new Map(held);
      const chosen = [];
      const take = (i) => {
        const ks = placeKeysOf(waiters[i].who);
        left.set(ks[0], (left.get(ks[0]) || 0) - 1);
        for (const k of ks) leftAny.set(k, (leftAny.get(k) || 0) - 1);
        chosen.push(i);
      };
      // No more places than the fit needs: drop each one the rest fit without.
      const needed = () => {
        for (let n = chosen.length - 1; n >= 0 && chosen.length > 1; n--) {
          const without = chosen.filter((_, j) => j !== n);
          if (fits(without)) chosen.splice(n, 1);
        }
        return chosen;
      };
      for (let i = waiters.length - 1; i >= 0; i--) {
        const k = placeKeysOf(waiters[i].who)[0];
        if ((left.get(k) || 0) <= 1) continue;
        take(i);
        if (fits(chosen)) return needed();
      }
      if (mine === ANONYMOUS_CALLER || mine === IN_PROCESS_CALLER || keys.some((k) => held.has(k))) return null;
      // The newest place under the key that holds the most, while one holds several.
      for (;;) {
        let at = -1, most = 1;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (chosen.includes(i)) continue;
          let n = 0;
          for (const k of placeKeysOf(waiters[i].who)) n = Math.max(n, leftAny.get(k) || 0);
          if (n > most) { most = n; at = i; }
        }
        if (at < 0) return null;
        take(at);
        if (fits(chosen)) return needed();
      }
    },
  };
}
