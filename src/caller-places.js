// Per-caller places in a bounded shared queue (the audio decode pool in
// src/tools/media-kit.js, the OCR room in src/caller-turns.js).
// A caller (`who`) is one key or a list of keys, strongest first
// (src/dispatch-caller.js admissionCallerOf: the signed payer, a credits key,
// a Tempo sender, then the client address). The caller IS its own key: the
// first of the list, so its strongest signed key, or its address only when
// it signs nothing. Each place it holds (a slot, a queued place) is counted
// under that key, and under every other key it carries.
//
// The queue has two bounds (`admit`). Inside the first (`fits`) every call is
// admitted. At it:
//   - a caller whose own key already holds a place is the one refused
//     ("own"): its own excess, and the only refusal short of the hard bound;
//   - a caller whose own key holds nothing (a newcomer) is admitted OVER the
//     bound and nobody gives way, up to the hard bound (`fitsHard`, sized by
//     the memory the waiting calls may hold).
// Only at the hard bound does a newcomer take a queued place, and only from
// the party holding the most, newest place first (`victims`):
//   1. the caller whose own key holds the most places, while one holds more
//      than one, so one caller's run of calls cannot hold every place;
//   2. failing that, the key (an address several wallets pay from) that holds
//      the most places, while one holds more than one, so that party cannot
//      hold every place either. Keys that hold as many each are taken alike,
//      newest place first: a party spread over two addresses is still the
//      party holding the most.
// A place is never taken from a caller holding a single one while another
// party holds several, and never when every party holds one: then the
// newcomer is refused ("full") and the hard bound holds. The waiter that
// gives up its place is answered busy. Buyers behind one address (a NAT, a
// hosted agent platform, an IPv6 /64) are each their own caller: a buyer is
// never refused because another at its address holds places, and its only
// place is taken under rule 2 alone, at the hard bound, when its address
// holds more places than any single caller and as many as any other address.
// A request that names no caller at all (ANONYMOUS_CALLER) is always a
// newcomer: its places are counted together under that key, so a run of them
// gives up its newest queued place at the hard bound to any newcomer, but one
// such request holding a place never refuses the next; it takes nothing under
// rule 2.
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
  /** True when the caller's own key holds no place (a request that names no caller always reads so). */
  const newcomer = (who) => { const mine = placeKeysOf(who)[0]; return mine === ANONYMOUS_CALLER || !own.has(mine); };
  /** The indexes in `waiters` (each `{ who }`) whose places a newcomer `who`
   *  takes so that `fits(indexes)` holds, newest first: places of the caller
   *  whose own key holds the most once the earlier ones are taken, while one
   *  holds more than one; then (never for a request-less or anonymous
   *  newcomer) places counted under the key that holds the most, while one
   *  holds more than one. Never more places than `fits` needs. null when the
   *  caller's own key already holds a place (an anonymous request never
   *  does) or no such set fits. */
  function victims(waiters, who, fits = (idx) => idx.length >= 1) {
    const mine = placeKeysOf(who)[0];
    if (!newcomer(who)) return null;
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
    // The newest waiting place of whoever holds the most by `count`, while that is more than one.
    const takeFromMost = (count) => {
      for (;;) {
        let at = -1, most = 1;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (chosen.includes(i)) continue;
          const n = count(placeKeysOf(waiters[i].who));
          if (n > most) { most = n; at = i; }
        }
        if (at < 0) return false;
        take(at);
        if (fits(chosen)) return true;
      }
    };
    if (takeFromMost((ks) => left.get(ks[0]) || 0)) return needed();
    if (mine === ANONYMOUS_CALLER || mine === IN_PROCESS_CALLER) return null;
    if (takeFromMost((ks) => { let n = 0; for (const k of ks) n = Math.max(n, leftAny.get(k) || 0); return n; })) return needed();
    return null;
  }
  return {
    hold(who) { const keys = placeKeysOf(who); for (const k of keys) bump(held, k, 1); bump(own, keys[0], 1); },
    free(who) { const keys = placeKeysOf(who); for (const k of keys) bump(held, k, -1); bump(own, keys[0], -1); },
    /** The places the caller holds under its own key. */
    count(who) { return own.get(placeKeysOf(who)[0]) || 0; },
    /** Keys holding a place (0 when every place is free). */
    callers() { return held.size; },
    /** The most places held under any one of the caller's keys. */
    most(who) { let m = 0; for (const k of placeKeysOf(who)) m = Math.max(m, held.get(k) || 0); return m; },
    newcomer,
    victims,
    /**
     * Whether a new call of `who` joins `waiters` (each `{ who }`).
     * `fits(indexes)` and `fitsHard(indexes)` say whether the call fits the
     * queue's bound and its hard bound once the waiters at `indexes` have
     * left. Answers `{ taken: [], over }` (admitted; `over` when past the
     * first bound), `{ taken: [i, ...], over: true }` (admitted at the hard
     * bound in the places of those waiters, which the caller answers busy),
     * or `{ refused: "own" }` (the caller's own key already holds a place)
     * or `{ refused: "full" }` (the hard bound, and nobody gives way).
     */
    admit(waiters, who, { fits, fitsHard = fits }) {
      if (fits([])) return { taken: [], over: false };
      if (!newcomer(who)) return { refused: "own" };
      if (fitsHard([])) return { taken: [], over: true };
      const taken = victims(waiters, who, fitsHard);
      return taken ? { taken, over: true } : { refused: "full" };
    },
  };
}
