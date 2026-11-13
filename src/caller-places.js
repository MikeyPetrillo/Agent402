// Per-caller places in a bounded shared queue (the large-image OCR slot in
// src/tools/ocr-kit.js, the audio decode pool in src/tools/media-kit.js).
// Each caller's places (a slot it holds, a queued place it waits in) are
// counted under its key (src/dispatch-caller.js admissionCallerOf). When the
// queue is full, a caller holding nothing is never refused for want of room
// while a queued place belongs to a caller that holds more than one place:
// that place is taken (newest first) and its waiter answered busy, so one
// caller's run of calls cannot hold every place. A caller that already holds a
// place never takes one from anyone.
import { IN_PROCESS_CALLER } from "./dispatch-caller.js";

export function createCallerPlaces() {
  const held = new Map(); // caller -> places held (slots and queued)
  const keyOf = (who) => who || IN_PROCESS_CALLER;
  return {
    hold(who) { const k = keyOf(who); held.set(k, (held.get(k) || 0) + 1); },
    free(who) {
      const k = keyOf(who);
      const n = (held.get(k) || 0) - 1;
      if (n > 0) held.set(k, n); else held.delete(k);
    },
    count(who) { return held.get(keyOf(who)) || 0; },
    callers() { return held.size; },
    /** The indexes in `waiters` (each `{ who }`) whose places a newcomer `who`
     *  takes so that `fits(indexes)` holds, newest first, each from a caller
     *  that still holds more than one place once the earlier ones are taken;
     *  null when `who` already holds a place or no such set fits. */
    victims(waiters, who, fits = (idx) => idx.length >= 1) {
      if (held.has(keyOf(who))) return null;
      const left = new Map(held);
      const chosen = [];
      for (let i = waiters.length - 1; i >= 0; i--) {
        const k = keyOf(waiters[i].who);
        if ((left.get(k) || 0) <= 1) continue;
        left.set(k, left.get(k) - 1);
        chosen.push(i);
        if (fits(chosen)) return chosen;
      }
      return null;
    },
  };
}
