// A wallet's concurrent paid runs must be covered by its balance TOGETHER.
//
// The facilitator verifies each EIP-3009 authorization on its own, against the
// wallet's balance at that moment, and settlement happens after the handler.
// This check adds the sum: for the expensive routes (EXPENSIVE_COMPOSITE_SLUGS:
// the reports and the media tiers), a run that would be this wallet's second
// or later in flight is admitted only when the wallet's balance on the paying
// chain covers every run it has in flight plus this one. That is exactly the
// set of runs that can all settle. A buyer whose balance covers what they start is never refused;
// a run the balance cannot also cover could never have been paid for, and is
// refused before it starts (429, nothing runs, nothing is charged) instead of
// after the work is done.
//
// Scope and cost:
//   - Only an EVM payment whose signed payer is known: an EIP-3009
//     authorization or a Permit2 authorization, the two shapes the exact
//     scheme's verify accepts; every expensive route is EVM exact only.
//     Credits holds its price at authorize and needs nothing here.
//   - The first run in flight needs no read: verify already proved the
//     balance covers it. A later one reads balanceOf once, cached for a few
//     seconds and shared by concurrent callers, so a burst costs one read.
//     One wallet has one read under way at a time: a run that needs a later
//     read than the one under way waits for it and shares the single read
//     that follows, with every run that asks meanwhile. That one begins
//     when the read ahead ends, or after READ_AHEAD_WAIT_MS if it has not.
//   - That proof holds only until a run of the same wallet leaves the
//     ledger: the departed run's settlement may have come out of the balance
//     this payment was verified against. A run judged across such a departure
//     is judged on a balance read taken after it, whether or not the ledger
//     is empty by then; a read already under way when a run leaves is neither
//     used for the decision nor cached.
//   - An unreadable balance (RPC down, the read lane full) admits up to
//     INFLIGHT_COVER_UNREAD_MAX runs in flight (default 4) and refuses beyond.
//   - A run leaves the ledger when its settlement SUCCEEDS (the x402
//     afterSettle hook with a success result, markCoveredRunSettled in
//     src/payments.js; a settlement recovered through the PAYMENT_SETTLE_
//     FALLBACK chain fires no afterSettle, so that chain calls the same
//     release, releaseCoverOnSettled): its payment is then off the wallet, so
//     the balance reflects it and counting it too would ask the wallet for it
//     twice. A slow response body after that (a large report to a slow
//     client) must not hold a run the balance already covers. A run whose
//     settlement failed leaves when its response ends, however it ends
//     (src/hangup-settlement.js onResponseEnd). Whichever comes first
//     releases; the second is a no-op.
//   - Between its handler's return and its response's end a run is SETTLING:
//     its payment may already be taken on chain, so a balance read then can
//     reflect it while the ledger still counts it. A run the balance would
//     not cover while another is settling waits for that one to leave the
//     ledger (at most SETTLE_WAIT_MS) and is judged again on a fresh read,
//     against every run in flight at that moment. Runs woken together share
//     that read and are admitted one at a time, each counting the ones before
//     it, so they are covered together too.
//   - A run another container holds may be settling too, and this process
//     cannot see that: its payment may be off the wallet while its
//     reservation is still in the window. A run the balance would not cover
//     beside one waits the same way, inside the same SETTLE_WAIT_MS: it looks
//     at the window again (after FOREIGN_POLL_MS, then twice as long each
//     time up to FOREIGN_POLL_MAX_MS, and once more when the wait runs out;
//     a look costs no balance read) until a run leaves, here or there. While
//     it waits it takes its own reservation out of the window: it is not
//     admitted, so it draws on nothing, and a run of this wallet waiting on
//     the other container for the same reason sees it gone and is judged
//     again instead of waiting on it in turn. Before it is judged again on a
//     fresh read it puts its reservation back, so that judgment, like every
//     other, is made with the reservation in the window. When the wait ends
//     with nobody gone the run is refused as it would have been at once, on
//     the same read.
//   - Across containers (src/shared-limits.js): every admitted run is also a
//     reservation in a shared window keyed by wallet and chain (member = run
//     id, weight = atomic amount), written before the run is judged and
//     removed when it leaves, so a run on another container counts here
//     exactly as a local one does: the judged set is this process's ledger
//     plus every reservation another container holds (admitted there or still
//     being judged there; run ids carry the process, so this process's own
//     reservations are not counted twice). A run another container holds
//     drew on a balance verify never saw, so while one is in the window only
//     a read that began after that view decides (the two are ordered by a
//     count this process keeps, never by the clock: a view and a read inside
//     one millisecond still have an order); and a run of another
//     container that leaves is a departure like a local one: this process
//     keeps the other containers' runs its last view of a wallet showed, and
//     a view that no longer shows one of them drops the cached balance,
//     detaches a read under way and sends every run being judged (and the
//     run whose view it is, even with nothing else in flight) to a read
//     taken after it. A store that does not answer
//     leaves the decision to this process's ledger, which is what one replica
//     always had. A reservation nobody removed (a container that died mid-run)
//     ages out after INFLIGHT_COVER_SHARED_WINDOW_MS.
// INFLIGHT_COVER=off disables the check.

import { paymentHeaderOf } from "./payer.js";
import { shared, sharedLimitsEnabled, sharedWrite, noteSharedLimitsDegraded } from "./shared-limits.js";
import { decodePaymentHeader } from "./payment-header.js";

const CHAIN_BY_CAIP2 = Object.freeze({
  "eip155:8453": "base", "eip155:137": "polygon", "eip155:42161": "arbitrum", "eip155:143": "monad",
  "eip155:42220": "celo", "eip155:43114": "avalanche", "eip155:1329": "sei", "eip155:10": "optimism",
  "eip155:4663": "robinhood", "eip155:5042": "arc", "eip155:57073": "ink",
});
const CAIP2_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(CHAIN_BY_CAIP2).map(([c, n]) => [n, c])));

const CACHE_MS = 10_000;
const READ_TIMEOUT_MS = 2_500;
const MAX_READS_IN_FLIGHT = 8;
const READ_AHEAD_WAIT_MS = 250;
const LAST_VIEW_MAX_KEYS = 10_000;
const SETTLE_WAIT_MS = 5_000;
const FOREIGN_POLL_MS = 100;
const FOREIGN_POLL_MAX_MS = 1_000;
// The waits are measured on a clock that only moves forward.
const mono = () => performance.now();
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;

// The shared half: on with a shared store. Run ids carry this process's
// prefix, so a member of the shared window is known to be ours or another
// container's by its id alone.
const SHARED = sharedLimitsEnabled();
const SHARED_NAME = "inflight-cover";
const SHARED_WINDOW_MS = () => Math.max(60_000, Number(process.env.INFLIGHT_COVER_SHARED_WINDOW_MS) || 15 * 60_000);
const PROC = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let runSeq = 0;
const isOurs = (member) => String(member).startsWith(`${PROC}:`);
/** True when the shared half writes through (a shared store is configured). */
export const _inflightCoverShared = SHARED;

const ledger = new Map(); // coverKey -> { count, atomic: bigint, settling }
const waiters = new Map(); // coverKey -> Set<() => void>, woken when a run leaves
const balances = new Map(); // coverKey -> { atomic: bigint, at, seq } (seq: when its read began)
const pendingReads = new Map(); // coverKey -> { p: Promise<bigint|null>, seq }, the read under way
const queuedReads = new Map(); // coverKey -> { p, seq: Infinity }, the one read that follows the read under way
// The other containers' runs the latest view of a wallet showed, kept while
// it shows any: coverKey -> { members: Set, at }. Most recently viewed last.
const lastForeign = new Map();
// The order of events in this process: a shared view takes the next value
// when it lands, a balance read takes the next when it begins.
let eventSeq = 0;
const judging = new Map(); // coverKey -> Set<{ left }>, runs being judged; release() counts in `left`
let readsInFlight = 0;
// The settled-release of an admitted run, kept on its request (own,
// non-enumerable) for the settle hook, which sees only the request.
const SETTLED = Symbol("a402.inflightCoverSettled");
const stats = { admitted: 0, admittedByRead: 0, admittedUnread: 0, refused: 0, refusedUnread: 0, settleWaits: 0, foreignWaits: 0, withdrawals: 0, sharedMisses: 0, foreignReads: 0 };

/**
 * The OTHER runs a shared window read reports: everything but this run's own
 * reservation. `foreign` are the members another container holds, with their
 * count and sum (`foreignCount`, `foreignAtomic`); all three are null when the
 * window was too large to list, and the totals stand in.
 */
function othersOf(r, selfId, selfAtomic) {
  const entries = Array.isArray(r.entries) ? r.entries.filter((e) => e.member !== selfId) : null;
  if (entries) {
    let atomic = 0n, foreignAtomic = 0n;
    const foreign = new Set();
    for (const e of entries) {
      const w = BigInt(Math.trunc(e.weight));
      atomic += w;
      if (!isOurs(e.member)) { foreign.add(e.member); foreignAtomic += w; }
    }
    return { count: entries.length, atomic, foreign, foreignCount: foreign.size, foreignAtomic };
  }
  const count = Math.max(0, (Number(r.count) || 0) - 1);
  const atomic = BigInt(Math.max(0, Math.round(Number(r.sum) || 0))) - selfAtomic;
  return { count, atomic: atomic > 0n ? atomic : 0n, foreign: null, foreignCount: null, foreignAtomic: null };
}
/**
 * The runs judged against the balance: this process's ledger (its own runs,
 * admitted one at a time) plus every run another container holds in the
 * shared window, admitted or still being judged there (either may settle).
 * This process's own reservations of runs still being judged here are not
 * counted twice: they enter the ledger in turn. A window too large to list is
 * judged on the larger of the two totals.
 */
function judgedSet(loc, others) {
  if (!others) return loc;
  if (others.foreignCount != null) return { count: loc.count + others.foreignCount, atomic: loc.atomic + others.foreignAtomic, settling: loc.settling };
  return { count: Math.max(loc.count, others.count), atomic: loc.atomic > others.atomic ? loc.atomic : others.atomic, settling: loc.settling };
}
/** A run of another container left the window between two readings. */
function foreignDeparted(before, after) {
  if (!before) return false;
  if (!before.foreign || !after.foreign) return after.count < before.count;
  for (const m of before.foreign) if (!after.foreign.has(m)) return true;
  return false;
}
/** Another container holds a run of this wallet (or, unlisted, may). */
function foreignHeld(others, held, judgesHere = 1) {
  if (!others) return false;
  if (others.foreign) return others.foreign.size > 0;
  return others.count > (held?.count || 0) + judgesHere - 1;
}
/**
 * A run of this wallet has left (here or on another container), so its
 * settlement may have come out of the balance: the cached read is dropped, a
 * read under way is detached (it is neither shared from here on nor cached),
 * every run being judged is told, and every run waiting for one to leave is
 * woken. The read queued behind it begins after the departure and stays.
 */
function noteDeparture(coverKey) {
  balances.delete(coverKey);
  pendingReads.delete(coverKey);
  const judges = judging.get(coverKey);
  if (judges) for (const j of judges) j.left += 1;
  const set = waiters.get(coverKey);
  if (set) for (const wake of [...set]) wake();
}
/**
 * Records a listed view of the shared window. True when a run another
 * container held in the view before it is no longer there: that run left, and
 * the departure is noted for the wallet. A window too large to list changes
 * nothing here (the judging run compares its own two counts).
 */
function noteView(coverKey, others, now = Date.now()) {
  if (!others.foreign) return false;
  const prev = lastForeign.get(coverKey);
  let gone = false;
  if (prev) for (const m of prev.members) if (!others.foreign.has(m)) { gone = true; break; }
  lastForeign.delete(coverKey);
  if (others.foreign.size) {
    lastForeign.set(coverKey, { members: others.foreign, at: now });
    // Bounded: a view older than the shared window names runs that have aged
    // out of it, and past the key cap the least recently viewed wallet goes.
    const cutoff = now - SHARED_WINDOW_MS();
    for (const [k, v] of lastForeign) {
      if (lastForeign.size <= LAST_VIEW_MAX_KEYS && v.at >= cutoff) break;
      lastForeign.delete(k);
    }
  }
  if (gone) noteDeparture(coverKey);
  return gone;
}
const removeShared = (coverKey, id, atomic) => sharedWrite(SHARED_NAME, shared.windowRemove(SHARED_NAME, coverKey, { member: id, weight: Number(atomic) }));

function unreadMax() {
  const n = Number(process.env.INFLIGHT_COVER_UNREAD_MAX);
  return Number.isInteger(n) && n >= 1 ? n : 4;
}
export function inflightCoverEnabled() {
  return String(process.env.INFLIGHT_COVER || "").trim().toLowerCase() !== "off";
}

/**
 * What an x402 payment header commits: { payer, network, asset, atomic }, all
 * from the signed authorization (EIP-3009, or Permit2 with its permitted
 * amount) and the accept it answered, or null when the header is neither.
 * Read after the paywall verified it. Pure; exported for the test.
 */
export function coverTermsOf(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  let p;
  try { p = decodePaymentHeader(headerValue); } catch { return null; }
  const inner = p?.payload;
  let payer, value;
  if (inner?.authorization && typeof inner.authorization === "object") {
    payer = String(inner.authorization.from || "");
    value = String(inner.authorization.value ?? "");
  } else if (inner?.permit2Authorization && typeof inner.permit2Authorization === "object") {
    payer = String(inner.permit2Authorization.from || "");
    value = String(inner.permit2Authorization.permitted?.amount ?? "");
  } else return null;
  if (!HEX_ADDR.test(payer) || !UINT.test(value)) return null;
  const network = typeof p?.accepted?.network === "string" ? p.accepted.network
    : (CAIP2_BY_NAME[String(p?.network || "").toLowerCase()] || null);
  if (!network || !Object.hasOwn(CHAIN_BY_CAIP2, network)) return null;
  const asset = typeof p?.accepted?.asset === "string" && HEX_ADDR.test(p.accepted.asset) ? p.accepted.asset.toLowerCase() : null;
  return { payer: payer.toLowerCase(), network, asset, atomic: BigInt(value) };
}

/** balanceOf(owner) on the paying chain, or null when it cannot be read. */
export async function readTokenBalance({ network, asset, payer }) {
  const chain = CHAIN_BY_CAIP2[network];
  if (!chain) return null;
  const { EVM, rpcCall } = await import("./revenue-live.js");
  const cfg = EVM[chain];
  const token = asset || cfg?.token;
  if (!cfg || !token || !HEX_ADDR.test(token)) return null;
  // Base reads go where every other Base read of ours goes (AGENT402_BASE_RPC
  // when set), so one variable points them all at a node.
  const base = String(process.env.AGENT402_BASE_RPC || "").trim();
  const rpcs = chain === "base" && base ? [base] : cfg.rpcs;
  const data = "0x70a08231" + payer.slice(2).toLowerCase().padStart(64, "0");
  const hex = await rpcCall(rpcs, "eth_call", [{ to: token, data }, "latest"], READ_TIMEOUT_MS);
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) return null;
  return BigInt(hex);
}

let reader = readTokenBalance;
/** Test seam. */
export function _setBalanceReaderForTest(fn) { reader = typeof fn === "function" ? fn : readTokenBalance; }

/** Resolves when `p` does, or after `ms`, whichever is first. */
function settledWithin(p, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    p.then(() => { clearTimeout(timer); resolve(); });
  });
}
// `minSeq`: the caller's shared view. A cached or pending read that began
// before it does not count (another container's run may have drawn on the
// balance since), however recently it finished. A read begins one microtask
// after it is asked for and is later than every view until then (Infinity),
// so runs whose views land together share the one read that follows them all.
// A wallet has one read under way at a time: a caller the read under way is
// too early for shares the one queued behind it, which begins when that one
// ends (or after READ_AHEAD_WAIT_MS), so a staggered burst costs a read at a
// time, never one read per run. A full lane reads as unknown, never queued.
function balanceFor(coverKey, terms, now, minSeq = 0) {
  const hit = balances.get(coverKey);
  if (hit && now - hit.at < CACHE_MS && hit.seq > minSeq) return hit.atomic;
  const pending = pendingReads.get(coverKey);
  if (pending && pending.seq > minSeq) return pending.p;
  const queued = queuedReads.get(coverKey);
  if (queued) return queued.p;
  let held = false;
  if (!pending) {
    if (readsInFlight >= MAX_READS_IN_FLIGHT) return null; // never queue: a full lane reads as unknown
    readsInFlight++;
    held = true;
  }
  const entry = { p: null, seq: Infinity };
  entry.p = (async () => {
    try {
      if (pending) {
        await settledWithin(pending.p, READ_AHEAD_WAIT_MS);
        if (queuedReads.get(coverKey) === entry) queuedReads.delete(coverKey);
        pendingReads.set(coverKey, entry);
        if (readsInFlight >= MAX_READS_IN_FLIGHT) return null;
        readsInFlight++;
        held = true;
      } else await null;
      entry.seq = ++eventSeq;
      const atomic = await reader(terms);
      if (typeof atomic !== "bigint" || atomic < 0n) return null;
      // A run that left while this read was under way detached it
      // (noteDeparture drops the pending entry): it may predate that run's
      // settlement, so it is not kept for anyone who asks after the departure.
      if (pendingReads.get(coverKey) === entry) balances.set(coverKey, { atomic, at: Date.now(), seq: entry.seq });
      return atomic;
    } catch { return null; }
    finally {
      if (held) readsInFlight--;
      if (pendingReads.get(coverKey) === entry) pendingReads.delete(coverKey);
      if (queuedReads.get(coverKey) === entry) queuedReads.delete(coverKey);
    }
  })();
  if (pending) queuedReads.set(coverKey, entry); else pendingReads.set(coverKey, entry);
  return entry.p;
}

/** Resolves when a run leaves `coverKey`'s ledger, or after `ms`. */
function nextRelease(coverKey, ms) {
  return new Promise((resolve) => {
    const set = waiters.get(coverKey) || new Set();
    waiters.set(coverKey, set);
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size && waiters.get(coverKey) === set) waiters.delete(coverKey);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    set.add(done);
  });
}

/**
 * Admit a paid run into this wallet's in-flight ledger, or refuse it.
 * Resolves to a release function (call it once when the response ends), or to
 * null when the payment is not one this check covers. Throws a 429 when the
 * wallet's balance does not cover this run on top of its runs in flight.
 * The release function carries settling(): call it when the run's handler has
 * returned and its settlement is under way.
 */
export async function admitCoveredRun(req, { now = Date.now(), settleWaitMs = SETTLE_WAIT_MS } = {}) {
  if (!inflightCoverEnabled()) return null;
  const terms = coverTermsOf(paymentHeaderOf(req));
  if (!terms) return null;
  const coverKey = `${terms.network}|${terms.asset || "-"}|${terms.payer}`;
  const waitUntil = mono() + settleWaitMs;
  // `left` counts this wallet's runs that leave the ledger while this one is
  // judged (release() bumps it). Once one has, verify's proof no longer holds
  // and the no-read admission is off: this run is judged on a read.
  const me = { left: 0 };
  const judges = judging.get(coverKey) || new Set();
  judging.set(coverKey, judges);
  judges.add(me);
  // The shared reservation goes in before the judgment, so two containers
  // judging one wallet at once each see the other's run; it is taken back on
  // a refusal and when the admitted run leaves.
  const sharedId = SHARED ? `${PROC}:${++runSeq}` : null;
  let others = null, sharedSeq = 0;
  if (sharedId) {
    const r = await shared.windowAdd(SHARED_NAME, coverKey, { windowMs: SHARED_WINDOW_MS(), member: sharedId, weight: Number(terms.atomic), now });
    // A run another container held at this wallet's last view and no longer
    // holds has left: this run is judged on a read, whatever else is in flight.
    if (r.ok) { others = othersOf(r, sharedId, terms.atomic); sharedSeq = ++eventSeq; noteView(coverKey, others); }
    else { stats.sharedMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
  }
  let admitted = false;
  try {
    let at = now;
    for (;;) {
      const held = ledger.get(coverKey);
      if (me.left === 0 && (!held || held.count <= 0) && !foreignHeld(others, held)) break;
      const leftBefore = me.left;
      // Another container's run is in flight: verify's proof may predate its
      // settlement, so only a read begun after the shared view decides.
      const foreign = foreignHeld(others, held, judges.size);
      if (foreign) stats.foreignReads++;
      const balance = await balanceFor(coverKey, terms, at, foreign ? sharedSeq : 0);
      // A run left while the balance was being read: the read may predate its
      // settlement. Judge again on a read taken after the departure.
      if (me.left !== leftBefore) { at = Date.now(); continue; }
      if (others) {
        const r = await shared.windowRead(SHARED_NAME, coverKey, { windowMs: SHARED_WINDOW_MS() });
        if (r.ok) {
          const next = othersOf(r, sharedId, terms.atomic);
          // A window too large to list names nobody: this run's own two
          // counts are then the only sign that a run left.
          const unlistedGone = (!others.foreign || !next.foreign) && foreignDeparted(others, next);
          others = next; sharedSeq = ++eventSeq;
          if (!noteView(coverKey, next) && unlistedGone) noteDeparture(coverKey);
        } else { stats.sharedMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
        // A run left while the window was being read, here or (seen in this
        // view or another run's) on another container: the balance read above
        // may predate its settlement. Judge again on a read taken after it.
        if (me.left !== leftBefore) { at = Date.now(); continue; }
      }
      // Re-read the ledger AFTER the await: other runs may have been admitted
      // meanwhile, and the check and the admission (synchronous, below) must
      // see the same numbers, with another container's runs added on.
      const cur = judgedSet(ledger.get(coverKey) || { count: 0, atomic: 0n, settling: 0 }, others);
      const need = cur.atomic + terms.atomic;
      const unread = balance === null;
      const covered = unread ? cur.count < unreadMax() : balance >= need;
      if (covered) {
        if (unread) stats.admittedUnread++; else stats.admittedByRead++;
        break;
      }
      // A settling run may already be paid for on chain while it still counts
      // here: wait for it to leave, then judge again against a fresh read.
      // So may a run another container holds, whose settling this process
      // cannot see: the window is looked at again until a run leaves it.
      const beside = foreignHeld(others, ledger.get(coverKey), judges.size);
      if (!unread && (cur.settling > 0 || beside) && mono() < waitUntil) {
        if (cur.settling > 0) stats.settleWaits++; else stats.foreignWaits++;
        const leftAtWait = me.left;
        // Beside another container's run, step out of the window while
        // waiting (put back below, before any judgment).
        let withdrawn = false;
        if (beside && sharedId) {
          withdrawn = true;
          stats.withdrawals++;
          await removeShared(coverKey, sharedId, terms.atomic);
        }
        let pollMs = FOREIGN_POLL_MS;
        for (;;) {
          const remaining = Math.max(0, waitUntil - mono());
          await nextRelease(coverKey, beside ? Math.min(remaining, pollMs) : remaining);
          if (me.left !== leftAtWait || !beside) break;
          // A look at the window, and one last look when the wait runs out.
          const r = await shared.windowRead(SHARED_NAME, coverKey, { windowMs: SHARED_WINDOW_MS() });
          if (r.ok) {
            const seen = othersOf(r, sharedId, terms.atomic);
            if (!noteView(coverKey, seen) && (!others.foreign || !seen.foreign) && foreignDeparted(others, seen)) noteDeparture(coverKey);
          } else { stats.sharedMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
          if (me.left !== leftAtWait || mono() >= waitUntil) break;
          pollMs = Math.min(pollMs * 2, FOREIGN_POLL_MAX_MS);
        }
        if (me.left !== leftAtWait) {
          // A run left: back into the window, then judged again on a view
          // taken now and a read begun after it.
          if (withdrawn) {
            const r = await shared.windowAdd(SHARED_NAME, coverKey, { windowMs: SHARED_WINDOW_MS(), member: sharedId, weight: Number(terms.atomic), now: Date.now() });
            if (r.ok) { others = othersOf(r, sharedId, terms.atomic); sharedSeq = ++eventSeq; noteView(coverKey, others); }
            else { stats.sharedMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
          }
          at = Date.now();
          continue;
        }
        // Nobody left in the whole wait: nothing this judgment rests on has
        // changed, so it stands (no further read). A run that stayed in the
        // window (it waited on a settling run here only) is judged again, as
        // it always was; it reuses the read it was judged on.
        if (!withdrawn && cur.settling > 0) { at = Date.now(); continue; }
      }
      stats.refused++;
      if (unread) stats.refusedUnread++;
      const e = new Error(unread
        ? `This wallet already has ${cur.count} paid runs in progress here, and its balance could not be read to confirm it also covers this one. Retry when one of them finishes. You have not been charged.`
        : cur.count <= 0
          ? `This wallet's balance no longer covers this run: another paid run from this wallet settled after this payment was checked, and the balance left does not cover this one too. Add funds and retry. You have not been charged.`
          : `This wallet already has ${cur.count} paid runs in progress here, and its balance does not cover this one as well. Each payment is checked on its own, but settling them all needs the sum. Retry when one of them finishes, or add funds. You have not been charged.`);
      e.statusCode = 429;
      e.retryAfter = 30;
      throw e;
    }
    admitted = true;
  } finally {
    judges.delete(me);
    if (!judges.size && judging.get(coverKey) === judges) judging.delete(coverKey);
    if (sharedId && !admitted) void removeShared(coverKey, sharedId, terms.atomic);
  }
  const entry = ledger.get(coverKey) || { count: 0, atomic: 0n, settling: 0 };
  entry.count += 1;
  entry.atomic += terms.atomic;
  ledger.set(coverKey, entry);
  stats.admitted++;
  let released = false, settling = false;
  const release = () => {
    if (released) return;
    released = true;
    if (sharedId) void removeShared(coverKey, sharedId, terms.atomic);
    const e = ledger.get(coverKey);
    if (e) {
      e.count -= 1;
      e.atomic -= terms.atomic;
      if (settling) e.settling -= 1;
      if (e.count <= 0) ledger.delete(coverKey);
    }
    // The balance has likely moved (this run settled, or failed to): the next
    // concurrent check reads it again, a read already under way is detached
    // from the cache, and every run being judged is told a run has left.
    noteDeparture(coverKey);
  };
  release.settling = () => {
    if (released || settling) return;
    settling = true;
    const e = ledger.get(coverKey);
    if (e) e.settling += 1;
  };
  // Settlement succeeded: the payment is off the wallet, so the run leaves
  // the ledger now rather than when its response ends. Same release, once.
  release.settled = () => release();
  try { Object.defineProperty(req, SETTLED, { value: release.settled, configurable: true }); } catch { /* the response-end release still applies */ }
  return release;
}

/**
 * Called when a request's settlement has SUCCEEDED on chain. Releases that
 * request's in-flight reservation at once (a no-op when it holds none or has
 * already left). Never call it for a failed or pending settlement: a run whose
 * payment is not taken must keep counting against the balance.
 */
export function markCoveredRunSettled(req) {
  if (!req || typeof req !== "object" || !Object.hasOwn(req, SETTLED)) return false;
  const fn = req[SETTLED];
  if (typeof fn !== "function") return false;
  fn();
  return true;
}

/** Counts only - never a wallet. */
export function inflightCoverStatus() {
  let runs = 0;
  for (const e of ledger.values()) runs += e.count;
  return { enabled: inflightCoverEnabled(), shared: SHARED, walletsInFlight: ledger.size, runsInFlight: runs, viewsKept: lastForeign.size, unreadMax: unreadMax(), ...stats };
}

/** Test-only. */
export function _resetInflightCoverForTest() {
  ledger.clear(); balances.clear(); pendingReads.clear(); queuedReads.clear(); lastForeign.clear(); judging.clear(); readsInFlight = 0; reader = readTokenBalance;
  for (const set of waiters.values()) for (const wake of [...set]) wake();
  waiters.clear();
  for (const k of Object.keys(stats)) stats[k] = 0;
}
