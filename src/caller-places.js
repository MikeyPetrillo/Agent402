// Per-caller places in a bounded shared queue (the large-image OCR slot in
// src/tools/ocr-kit.js, the audio decode pool in src/tools/media-kit.js).
// A caller (`who`) is one key or a list of keys (src/dispatch-caller.js
// admissionCallerOf: the signed payer, a credits key, a Tempo sender AND the
// client address), and each place it holds (a slot, a queued place) is
// counted under every one of its keys, so a party that signs with several
// wallets from one address is one caller, as is one wallet used from several
// addresses. When the queue is full, a caller none of whose keys holds a
// place is never refused for want of room while a queued place belongs to
// a caller one of whose keys holds more than one place: that place is taken
// (newest first) and its waiter answered busy, so one caller's run of calls
// cannot hold every place. A caller that already holds a place under any of
// its keys never takes one from anyone.
import { IN_PROCESS_CALLER } from "./dispatch-caller.js";

/** The keys a place is counted under: `who` itself, or each of a list of
 *  keys (strongest first), or the one shared key when it names none. */
export function placeKeysOf(who) {
  const list = Array.isArray(who) ? [...new Set(who.filter((k) => typeof k === "string" && k))] : (typeof who === "string" && who ? [who] : []);
  return list.length ? list : [IN_PROCESS_CALLER];
}

export function createCallerPlaces() {
  const held = new Map(); // key -> places held (slots and queued)
  const most = (map, keys) => keys.reduce((n, k) => Math.max(n, map.get(k) || 0), 0);
  return {
    hold(who) { for (const k of placeKeysOf(who)) held.set(k, (held.get(k) || 0) + 1); },
    free(who) {
      for (const k of placeKeysOf(who)) {
        const n = (held.get(k) || 0) - 1;
        if (n > 0) held.set(k, n); else held.delete(k);
      }
    },
    /** The most places any one of the caller's keys holds. */
    count(who) { return most(held, placeKeysOf(who)); },
    /** Keys holding a place (0 when every place is free). */
    callers() { return held.size; },
    /** The indexes in `waiters` (each `{ who }`) whose places a newcomer `who`
     *  takes so that `fits(indexes)` holds, newest first, each from a caller
     *  one of whose keys still holds more than one place once the earlier ones
     *  are taken; null when any of `who`'s keys already holds a place or no
     *  such set fits. */
    victims(waiters, who, fits = (idx) => idx.length >= 1) {
      if (placeKeysOf(who).some((k) => held.has(k))) return null;
      const left = new Map(held);
      const chosen = [];
      for (let i = waiters.length - 1; i >= 0; i--) {
        const keys = placeKeysOf(waiters[i].who);
        if (most(left, keys) <= 1) continue;
        for (const k of keys) left.set(k, (left.get(k) || 0) - 1);
        chosen.push(i);
        if (fits(chosen)) return chosen;
      }
      return null;
    },
  };
}
