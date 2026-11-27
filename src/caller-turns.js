// Fair turns on a few serial engines (the OCR engines in src/tools/ocr-kit.js).
//
// Work arrives on a LANE (one engine: a language's worker, or the one
// large-image engine). A lane runs one call at a time, and at most
// `maxRunning` lanes run at once. Everything else waits in one room, bounded
// by count (in all and per lane) and by the bytes the waiting calls hold.
//
// WHOSE TURN. Fairness is across callers, not requests. A caller (`who`) is
// its list of keys, strongest first (src/dispatch-caller.js admissionCallerOf:
// the signed payer, a credits key, a Tempo sender, then the client address).
// Waiting calls are served in the order they arrived, except that a caller's
// calls are ordered as if each had arrived when its earlier one left the
// engine: every key carries the time its last call held an engine until, and
// a waiting call stands in line at the later of its own arrival and that
// time under any of its keys. So:
//   - one caller's second call waits behind every other caller's call that
//     arrived before its first one ended, however many it queued at once;
//   - several wallets behind one address share that address's time, and one
//     wallet used from several addresses shares the wallet's, so neither is a
//     way to more turns;
//   - engine time that ended without an answer (`release({ unpaid: true })`:
//     a failed decode, a deadline, a turn given up, a caller that left)
//     counts `unpaidWeight` times, so that caller's next call stands behind
//     the calls other callers send in the meantime. The weighted time is
//     written only under an identity that belongs to that caller alone (its
//     first key when that is the signed payer, a credits key or a Tempo
//     sender: OWN_IDENTITY) and read only by calls whose own key it is; every
//     other key it carries, the shared client address included, takes the
//     plain engine time. A caller that names none of those (its first key is
//     its address) gets the plain time alone, under every key. So a wallet
//     still cannot gain turns by changing address, and no caller behind an
//     address ever stands behind what someone else left unanswered. Nobody
//     is refused for it: with no one else waiting, the call runs at once.
// A call never loses its place to one that arrives later, so no stream of
// new callers can keep it waiting: what is ahead of it is what was there
// when it came.
//
// A FULL ROOM has two bounds (src/caller-places.js `admit`). At the first
// (`maxWaiters`, `maxWaitersOf`, `maxBytes`) a caller that already holds a
// place is the one refused ("own": its own excess), and a caller that holds
// nothing is admitted over it, nobody giving way, up to the hard bound
// (`hardWaiters`, `hardWaitersOf`, `hardBytes`: what the waiting calls may
// hold in memory at most). Only at the hard bound does a caller that holds
// nothing take a waiting place:
//   - one of the party holding the most (`victims`: the caller whose own key
//     holds the most, then the address holding the most, while one holds
//     several; never from a caller holding one place while another party
//     holds several);
//   - failing that, the place that stands last in line, when it stands behind
//     the caller arriving (a call whose caller's earlier time puts it later,
//     or one that came after the arriving caller's kept place).
// That place is answered busy and the newcomer waits in it. A newcomer is
// refused ("full") only at the hard bound, when every waiting place is the
// only one its caller holds under every key and stands ahead of it.
//
// A PLACE IN LINE IS KEPT. A call that waited out its time, found the room
// full or gave up its place leaves a ticket under its own key for `ticketMs`
// (two minutes, renewed by each retry): when that caller comes back it stands
// where it first stood, ahead of everything that came after, and (above)
// takes a place from what stands behind it. So what a caller waits for is
// what stood ahead of it when it first came, each for one turn, however many
// callers arrive later and however full they keep the room. A caller that
// was itself turned away holds a ticket too, so "ahead" counts the callers
// turned away in the `ticketMs` before it as well as those in the room.
//
// GIVING WAY. A running call can be asked to give way, and whether it is
// depends on what its caller has already used:
//   - a caller with no engine time in the trailing `freshWindowMs` (ten
//     minutes), so this is its first call in that window, is never asked:
//     its call runs to the owner's own run limit even while others wait
//     (`turn.fresh`, `yieldAt` is Infinity). Ordinary demand never ends a
//     caller's one long call;
//   - a caller that has used an engine in the window (answered or not) is
//     asked: `yieldAt(turnMs)` is `turnMs` after the latest of the run's own
//     start, the arrival of a waiting call from another caller, and that
//     call's place in line. So an engine a returning caller holds changes
//     hands every `turnMs` once someone else waits.
// The engine's owner ends the run then (the scheduler only says when).
// Waiting calls from the running caller itself never count.
//
// THE RECORD of who used an engine is every key of every call, written when
// its turn starts and again when it ends (so a call that never ends, fails,
// is abandoned or changes its input leaves it all the same; nothing a caller
// does clears it, only the window passing). A new wallet on an address in
// the record, or a wallet in the record from a new address, is a caller in
// the record. It holds at most `keysMax` keys, least recently used first
// out: when a key still inside the window has to go, every caller the record
// cannot place is taken to have used an engine for one window, so filling
// the record never buys anyone the long turn.
import { createCallerPlaces, placeKeysOf } from "./caller-places.js";
import { IN_PROCESS_CALLER, ANONYMOUS_CALLER } from "./dispatch-caller.js";

const SHARED_KEYS = new Set([IN_PROCESS_CALLER, ANONYMOUS_CALLER]);
/** The keys src/dispatch-caller.js gives an identity of one caller's own (the
 *  signed payer, a credits key, a Tempo sender); an `ip:` key is shared by
 *  everyone behind that address. */
const OWN_IDENTITY = /^(?:payer|credits|tempo):/;

/** Why a call got no turn: "own" (the room is full and its caller already
 *  holds a place), "full" (the room is at its hard bound and nobody gives
 *  way), "wait" (its wait ran out), "gave-way" (its place went to a caller
 *  holding nothing) or "left" (its own caller cancelled it). */
export class TurnRefused extends Error {
  constructor(why) { super(`no turn: ${why}`); this.name = "TurnRefused"; this.why = why; }
}

export function createCallerTurns({
  maxRunning = Infinity,
  maxWaiters = 64,
  maxWaitersOf = () => Infinity,
  maxBytes = Infinity,
  hardWaiters = 2 * maxWaiters,
  hardWaitersOf = (lane) => 2 * maxWaitersOf(lane),
  hardBytes = 1.5 * maxBytes,
  unpaidWeight = 4,
  ticketMs = 2 * 60_000,
  ticketsMax = 1024,
  freshWindowMs = 10 * 60_000,
  keysMax = 8192,
  now = Date.now,
} = {}) {
  const running = new Map(); // lane -> turn
  const waiters = []; // in arrival order
  const places = createCallerPlaces();
  // key -> { until: the time its last call held an engine until,
  //          own: the same, weighted for engine time left unanswered by a
  //               caller whose own key this is (read only by such calls),
  //          usedAt: when a call under it last started or ended }, least recently used first
  const record = new Map();
  let overflowAt = -Infinity; // when a key still inside the window last left the record
  const tickets = new Map(); // own key -> { since, seq, expires }
  let seq = 0;
  let queuedBytes = 0;

  /** The time a call with `keys` (its own key `own`) stands behind: the
   *  plain time under every key, and the weighted time under its own. */
  const untilOf = (keys, own = null) => {
    let m = 0;
    for (const k of keys) {
      const r = record.get(k);
      if (!r) continue;
      if (r.until > m) m = r.until;
      if (k === own && r.own > m) m = r.own;
    }
    return m;
  };
  /** True when any of the keys used an engine inside the window (or the record cannot say). */
  const usedLately = (keys, t) => t - overflowAt < freshWindowMs || keys.some((k) => { const r = record.get(k); return !!r && t - r.usedAt < freshWindowMs; });
  /** Write a use of the engine under every key: now, and (at a release) the
   *  time it stands until; `ownUntil` (the weighted time) under `own` alone. */
  function note(keys, t, until = 0, own = null, ownUntil = 0) {
    for (const k of keys) {
      const was = record.get(k);
      record.delete(k);
      const mine = k === own ? ownUntil : 0;
      record.set(k, { until: Math.max(until, was?.until ?? 0), own: Math.max(mine, was?.own ?? 0), usedAt: t });
    }
    while (record.size > keysMax) {
      const [k, r] = record.entries().next().value;
      record.delete(k);
      if (t - r.usedAt < freshWindowMs || r.until > t || r.own > t) overflowAt = t;
    }
  }
  /** Where a waiting call stands in line: the later of its arrival and its
   *  caller's earlier time; at the same instant a call standing at its own
   *  arrival comes before one standing at its caller's earlier time, then
   *  the earlier arrival. */
  const placeOf = (w) => { const held = untilOf(w.keys, w.own); return { at: Math.max(w.since, held), pushed: held >= w.since ? 1 : 0, seq: w.seq }; };
  const before = (a, b) => a.at - b.at || a.pushed - b.pushed || a.seq - b.seq;
  const laneCount = (lane) => { let n = 0; for (const w of waiters) if (w.lane === lane) n++; return n; };
  const canStart = (lane) => !running.has(lane) && running.size < maxRunning;

  function changed() {
    for (const t of running.values()) { try { t.onChange?.(); } catch { /* a listener never breaks the room */ } }
  }

  function leaveTicket(w) {
    if (SHARED_KEYS.has(w.own) || !(ticketMs > 0)) return;
    tickets.delete(w.own);
    tickets.set(w.own, { since: w.since, seq: w.seq, expires: now() + ticketMs });
    if (tickets.size <= ticketsMax) return;
    // Past the cap: the expired ones go, then the ticket that stands last (a
    // later place never costs an earlier one).
    const t0 = now();
    for (const [k, t] of tickets) { if (t.expires <= t0) tickets.delete(k); }
    while (tickets.size > ticketsMax) {
      let last = null, at = -Infinity;
      for (const [k, t] of tickets) { if (t.since >= at) { at = t.since; last = k; } }
      tickets.delete(last);
    }
  }
  function takeTicket(own) {
    const t = tickets.get(own);
    if (!t) return null;
    tickets.delete(own);
    return t.expires > now() ? t : null;
  }

  function remove(w) {
    const i = waiters.indexOf(w);
    if (i < 0) return false;
    waiters.splice(i, 1);
    clearTimeout(w.timer);
    queuedBytes -= w.bytes;
    return true;
  }

  /** The places that stand last in line, behind `w`, that `w` (a caller
   *  holding nothing under its own key) takes so that `fits`; null if none do. */
  function lastBehind(w, fits) {
    if (!SHARED_KEYS.has(w.own) && places.count(w.keys) > 0) return null;
    const mine = placeOf(w);
    const behind = waiters.map((o, i) => ({ i, ...placeOf(o) }))
      .filter((o) => before(mine, o) < 0)
      .sort((a, b) => before(b, a));
    const chosen = [];
    for (const o of behind) {
      chosen.push(o.i);
      if (!fits(chosen)) continue;
      for (let n = chosen.length - 2; n >= 0; n--) { const without = chosen.filter((_, j) => j !== n); if (fits(without)) chosen.splice(n, 1); }
      return chosen;
    }
    return null;
  }

  function start(w) {
    const startedAt = now();
    const fresh = !usedLately(w.keys, startedAt);
    note(w.keys, startedAt);
    const turn = {
      lane: w.lane, keys: w.keys, own: w.own, startedAt, waitedMs: startedAt - w.at, onChange: null, done: false,
      /** True when the caller had used no engine in the window before this turn: it is never asked to give way. */
      fresh,
      /** When this run should give way to a waiting call of another caller (epoch ms), or Infinity. */
      yieldAt(turnMs) {
        let at = Infinity;
        if (fresh) return at;
        const capped = running.size >= maxRunning;
        for (const o of waiters) {
          if (o.lane !== turn.lane && !(capped && !running.has(o.lane))) continue;
          if (o.keys.some((k) => turn.keys.includes(k))) continue;
          at = Math.min(at, Math.max(turn.startedAt, o.at, untilOf(o.keys, o.own)) + turnMs);
        }
        return at;
      },
      /** End the turn. The time it held the engine stands against the
       *  caller's next call, `unpaidWeight` times when it ended unanswered. */
      release({ unpaid = false } = {}) {
        if (turn.done) return;
        turn.done = true;
        const t = now();
        const held = Math.max(0, t - turn.startedAt);
        // The weighted time goes under the caller's own identity alone, and
        // never under a key others share (an address, the request-less or
        // anonymous key).
        const own = unpaid && OWN_IDENTITY.test(turn.own) ? turn.own : null;
        note(turn.keys, t, turn.startedAt + held, own, own ? turn.startedAt + held * unpaidWeight : 0);
        places.free(turn.keys);
        if (running.get(turn.lane) === turn) running.delete(turn.lane);
        grant();
        changed();
      },
    };
    running.set(w.lane, turn);
    return turn;
  }

  function grant() {
    while (running.size < maxRunning) {
      let pick = null, best = null;
      for (const w of waiters) {
        if (running.has(w.lane)) continue;
        const place = placeOf(w);
        if (!pick || before(place, best) < 0) { pick = w; best = place; }
      }
      if (!pick) return;
      remove(pick);
      pick.resolve(start(pick));
    }
  }

  /**
   * Ask for a turn on `lane`. Resolves to the turn ({ release(), yieldAt(),
   * waitedMs, onChange }) or rejects with a TurnRefused. The promise carries
   * `cancel()`: the caller left, so its waiting place is given up at once
   * (no ticket); a turn already granted is the holder's to release.
   */
  function acquire(lane, who, { waitMs = 0, bytes = 0 } = {}) {
    const keys = placeKeysOf(who);
    const own = keys[0];
    const ticket = takeTicket(own);
    const at = now();
    const w = { lane, keys, who: keys, own, at, since: ticket ? Math.min(ticket.since, at) : at, seq: ticket ? ticket.seq : ++seq, bytes: Math.max(0, Number(bytes) || 0) };
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      if (canStart(lane)) { places.hold(keys); resolve(start(w)); return; }
      if (!(waitMs > 0)) { leaveTicket(w); reject(new TurnRefused("wait")); return; }
      const fitsWithin = (max, maxOf, maxHeld) => (taken = []) => {
        let freed = 0, inLane = 0;
        for (const i of taken) { freed += waiters[i].bytes; if (waiters[i].lane === lane) inLane++; }
        return waiters.length - taken.length < max && laneCount(lane) - inLane < maxOf(lane) && queuedBytes - freed + w.bytes <= maxHeld;
      };
      const fits = fitsWithin(maxWaiters, maxWaitersOf, maxBytes);
      if (!fits()) {
        // Past the first bound: the caller's own excess is refused, a caller
        // holding nothing is admitted up to the hard bound, and only there
        // does a place change hands.
        const fitsHard = fitsWithin(Math.max(hardWaiters, maxWaiters), (l) => Math.max(hardWaitersOf(l), maxWaitersOf(l)), Math.max(hardBytes, maxBytes));
        const admitted = places.admit(waiters, keys, { fits, fitsHard });
        const taken = admitted.taken || (admitted.refused === "full" ? lastBehind(w, fitsHard) : null);
        if (!taken) { leaveTicket(w); reject(new TurnRefused(admitted.refused === "own" ? "own" : "full")); return; }
        for (const v of taken.map((i) => waiters[i])) {
          remove(v);
          places.free(v.keys);
          leaveTicket(v);
          v.reject(new TurnRefused("gave-way"));
        }
      }
      places.hold(keys);
      queuedBytes += w.bytes;
      w.resolve = resolve;
      w.reject = reject;
      w.timer = setTimeout(() => {
        if (!remove(w)) return;
        places.free(keys);
        leaveTicket(w);
        reject(new TurnRefused("wait"));
        changed();
      }, waitMs);
      waiters.push(w);
      cancel = () => {
        if (!remove(w)) return;
        places.free(keys);
        reject(new TurnRefused("left"));
        changed();
      };
      changed();
    });
    promise.cancel = () => cancel();
    return promise;
  }

  return {
    acquire,
    /** For tests and status: one lane's holder and line, and the room's totals. */
    state(lane) {
      const t = running.get(lane);
      return { busy: !!t, holder: t ? t.own : null, fresh: t ? t.fresh : null, waiting: laneCount(lane), running: running.size, waitingAll: waiters.length, queuedBytes, callers: places.callers(), tickets: tickets.size, recorded: record.size };
    },
    /** How many of this caller's own waiting calls stand ahead of one it
     *  would make now (its kept place counted): the calls certain to be
     *  served before it, whoever else waits. */
    ownAhead(who) {
      const keys = placeKeysOf(who), own = keys[0];
      const t = now(), kept = tickets.get(own);
      const mine = placeOf({ keys, own, since: kept && kept.expires > t ? Math.min(kept.since, t) : t, seq: kept && kept.expires > t ? kept.seq : Infinity });
      let n = 0;
      for (const o of waiters) if (o.own === own && before(placeOf(o), mine) < 0) n++;
      return n;
    },
    /** Forget every kept place and every caller's engine time (tests). */
    reset() { tickets.clear(); record.clear(); overflowAt = -Infinity; },
  };
}
