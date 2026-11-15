// A wallet's concurrent paid runs must be covered by its balance TOGETHER.
//
// The facilitator verifies each EIP-3009 authorization on its own, against the
// wallet's balance at that moment, and settlement happens after the handler.
// This check adds the sum: for every paid route that is not proof-of-work
// payable (the routes the settle breaker consults: each costs an upstream
// read, a model call or a vendor call per run), a run that would be this
// wallet's second or later in flight is admitted only when the wallet's
// balance on the paying chain covers every run it has in flight plus this
// one. That is exactly the
// set of runs that can all settle. A buyer whose balance is read and covers
// what they start is never refused;
// a run the balance cannot also cover could never have been paid for, and is
// refused before it starts (429, nothing runs, nothing is charged) instead of
// after the work is done.
//
// Scope and cost:
//   - A payment whose payer, token and amount are known after its gate
//     verified it (coverTermsOfRequest): an x402 EVM payment (an EIP-3009
//     authorization or a Permit2 authorization, the two shapes the exact
//     scheme's verify accepts; the MPP evm wire arrives as one through the
//     shim), a Tempo pull credential from a sender the gate verified, and a
//     Solana, Algorand or Stellar x402 payment (src/rail-cover.js). Not
//     covered, because the price is not drawn from the wallet after the
//     handler: credits (held at authorize), a card, a Tempo push credential
//     (final before the handler). A Circle Gateway batched payment is
//     judged on the signer's Gateway balance (src/rail-cover.js), which is
//     where it is paid from.
//     A payment with no readable terms is not judged here; the settle
//     breaker counts its runs in flight (src/gateway-settle-breaker.js).
//   - The first run in flight needs no read: verify already proved the
//     balance covers it (unless a run of the wallet settled after the request
//     arrived: verify may predate that payment, so the run is judged). A later one reads balanceOf once, cached for a few
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
//   - THE RULES. On the report and media routes (EXPENSIVE_COMPOSITE_SLUGS)
//     a run is judged as it always was: a run the balance would not cover
//     while another is settling waits up to COMPOSITE_SETTLE_WAIT_MS (5 s)
//     for it to leave, a balance read is given that long, and an unread
//     balance admits INFLIGHT_COVER_UNREAD_MAX runs in flight (default 4)
//     for every wallet. On every other paid route nothing is held:
//       read: the balance is read inside ADMIT_WAIT_MS (about a second).
//         The run is admitted if and only if the balance covers every run
//         the wallet has in flight plus this one, however many those are.
//         Otherwise it is refused at once (429, Retry-After, nothing run,
//         nothing charged).
//       not read now (the read failed, did not answer inside that wait, or
//         the account is one this server cannot read): the run is judged on
//         the wallet's LAST GOOD READ, when it has one no older than
//         GOOD_READ_MAX_MS (15 minutes), less everything this server has
//         taken or holds since (what its settlements took, and the
//         runs in flight). Covered: admitted. Not covered: the allowance
//         below applies, so a kept read is never stricter than no read (the
//         wallet may have been funded since).
//       never read (no such read, and none to be had now): a fixed allowance
//         of runs in flight, never an open door: INFLIGHT_COVER_UNREAD_MAX
//         (default 4) for a wallet that had no paid record when the
//         admission began, INFLIGHT_COVER_UNREAD_PAID_MAX (default 16) for
//         one that had (src/paid-record.js). A run past it is refused at
//         once.
//     A wallet gets a last good read from any read made for it, and from one
//     read taken in the background when a payment of its settles and it has
//     none younger than GOOD_READ_REFRESH_MS (5 minutes).
//     There is no bound on a wallet's runs at once other than its balance,
//     and no call waits for another call's settlement to make room.
//   - The read lane (MAX_READS_IN_FLIGHT reads at once, all wallets) is a
//     queue: a read that finds it full waits for a place, inside the
//     admission wait, and is made; an admission whose wait ends first is
//     judged as not read.
//   - A balance record under a second old is judged on as it is (a wallet
//     sending call after call past its balance costs no read per refusal),
//     and a read whose turn in the lane comes after every admission that
//     asked for it has gone is not made.
//   - A read is judged with what has left the ledger since it began taken
//     off (a lower bound), so a run that leaves while a read is under way
//     never forces another read; a judgment that fails on that lower bound
//     alone takes one fresh read while time is left (and when nothing is
//     settling, that read is let finish, bounded by READ_TIMEOUT_MS, rather
//     than the admission wait: the earlier read already reflected the
//     settlement taken off it). A judgment that has had
//     a read keeps it: a later read that does not answer never turns it into
//     an unread one. A read that is merely slow marks nothing and goes on;
//     a read that FAILS marks THAT ACCOUNT's reads as
//     down for READ_DOWN_MS (an account this server can never read, a
//     Stellar contract account, is marked the same way: its own state,
//     nobody else's): until one succeeds, an admission for that account
//     waits only READ_DOWN_WAIT_MS for a read, and one read a second is made
//     for it (READ_FAIL_GAP_MS). When the wait ends undecided
//     (another run of the wallet is settling and the balance cannot yet be
//     confirmed), the refusal says so and asks for a retry in a few seconds.
//   - Each admitted run is marked on its request (coveredRunStateOf):
//     "covered" (verify's proof or a balance read), "trusted" (unread, a
//     payer that had a paid record, inside its allowance) or "unread"
//     (unread, no paid record, inside the small allowance), which the settle
//     breaker reads.
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
//     ledger (inside the admission wait: ADMIT_WAIT_MS, or
//     COMPOSITE_SETTLE_WAIT_MS on the report and media routes) and is judged again,
//     against every run in flight at that moment. Runs woken together share
//     that read and are admitted one at a time, each counting the ones before
//     it, so they are covered together too.
//   - A run another container holds may be settling too, and this process
//     cannot see that: its payment may be off the wallet while its
//     reservation is still in the window. A run the balance would not cover
//     beside one waits the same way, inside the same admission wait: it looks
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
// INFLIGHT_COVER: unset, the check as described. `composite` restores the
// scope it had before it covered every paid route: the report and media
// routes only (EXPENSIVE_COMPOSITE_SLUGS), and no count of runs in flight in
// the settle breaker. `off` disables the check everywhere (and that count
// with it).

import { paymentHeaderOf } from "./payer.js";
import { shared, sharedLimitsEnabled, sharedWrite, noteSharedLimitsDegraded } from "./shared-limits.js";
import { decodePaymentHeader } from "./payment-header.js";
import { isGatewayBatchedRequest } from "./gateway-wire.js";
import { tempoCoverTermsOf, nonEvmCoverTermsOf, readRailBalance } from "./rail-cover.js";
import { RAILS, GATED_RAILS, railKey } from "./rails.js";
import { hasPaidRecord, notePaidSettlement } from "./paid-record.js";
import { COVER_STATE, coveredRunStateOf, inflightCoverMode } from "./inflight-cover-state.js";
export { coveredRunStateOf, inflightCoverMode };

// CAIP-2 id -> the chain's key in the EVM read table (src/revenue-live.js
// EVM), from the rails table: every EVM rail, offered or gated.
export const CHAIN_BY_CAIP2 = Object.freeze(Object.fromEntries([...RAILS, ...GATED_RAILS].filter((r) => Number.isInteger(r.chainId)).map((r) => [r.caip2, railKey(r)])));
const CAIP2_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(CHAIN_BY_CAIP2).map(([c, n]) => [n, c])));

const CACHE_MS = 10_000;
const READ_TIMEOUT_MS = 2_500;
const MAX_READS_IN_FLIGHT = 8;
const READ_AHEAD_WAIT_MS = 250;
const LAST_VIEW_MAX_KEYS = 10_000;
/** The whole admission wait on every route but the report and media ones: reads and settling runs together. */
const ADMIT_WAIT_MS = 1_000;
/** After an account's read fails, no admission for that account waits for a
 *  read for this long (or until one succeeds). */
const READ_DOWN_MS = 10_000;
/** What an admission waits for a read while its account's reads are down. */
const READ_DOWN_WAIT_MS = 25;
/** While an account's reads are failing, the gap between reads made for it. */
const READ_FAIL_GAP_MS = 1_000;
/** A balance record this young is judged on without another read. */
const FRESH_ENOUGH_MS = 1_000;
const READS_DOWN_MAX_KEYS = 20_000;
/** The admission wait on the report and media routes (what it always was). */
const COMPOSITE_SETTLE_WAIT_MS = 5_000;
const FOREIGN_POLL_MS = 100;
const FOREIGN_POLL_MAX_MS = 1_000;
const FOREIGN_REREAD_MS = 250;
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
// LIVE_MARK: this build's process ids begin with it (see LIVENESS below).
const LIVE_MARK = "live~";
const PROC = `${LIVE_MARK}${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let runSeq = 0;
const isOurs = (member) => String(member).startsWith(`${PROC}:`);
/** True when the shared half writes through (a shared store is configured). */
export const _inflightCoverShared = SHARED;

const ledger = new Map(); // coverKey -> { count, atomic: bigint, settling }
const waiters = new Map(); // coverKey -> Set<() => void>, woken when a run leaves
// PER-WALLET STATE, one object per coverKey:
//   taken     the sum of what this process's runs took from the wallet: a
//             settlement's amount, nothing for a run refused or failed with
//             no settlement (see release());
//   good      the wallet's LAST GOOD READ, a read record, or null;
//   settledAt when a run of the wallet last left on a settlement success;
//   readAt    when a balance read for it was last begun;
//   open      judgments and reads under way that hold this object.
// A read record is { atomic: bigint, at, seq, taken0, w }: `seq` is when the
// read began and `taken0` is the wallet's `taken` when the read was asked for,
// so lowerOf(record) = atomic - (taken now - taken0) is a lower bound on the
// balance for as long as the record is held by anyone, in a map or not. Only
// a transfer this server did not make can put the real balance under it.
// The store is bounded: a wallet with nothing in flight and nothing open goes
// once it has not been touched for GOOD_READ_MAX_MS, and the least recently
// touched go first past WALLETS_MAX.
/** How old a wallet's last good read may be and still be judged on when its
 *  balance cannot be read now: the reservation window's length, long enough
 *  to ride out a balance source that is down for several minutes. Past it
 *  the wallet is one this server has not read, and the allowance applies. */
export const GOOD_READ_MAX_MS = 15 * 60_000;
const WALLETS_MAX = 50_000;
/** A wallet whose payment settles gets a read in the background when its
 *  last good read is older than this (or it has none). */
const GOOD_READ_REFRESH_MS = 5 * 60_000;
const wallets = new Map(); // coverKey -> state; least recently touched first
function walletOf(coverKey, now = Date.now()) {
  let w = wallets.get(coverKey);
  if (w) wallets.delete(coverKey); else w = { taken: 0n, good: null, settledAt: 0, readAt: 0, open: 0, touched: now };
  w.touched = now;
  wallets.set(coverKey, w);
  // Bounded work per call: look at the few least recently touched.
  let looked = 0;
  for (const [k, v] of wallets) {
    if (++looked > 8) break;
    const over = wallets.size > WALLETS_MAX;
    if (!over && now - v.touched < GOOD_READ_MAX_MS) break;
    if (v.open > 0 || ledger.has(k)) { if (over) { wallets.delete(k); v.touched = now; wallets.set(k, v); } continue; }
    wallets.delete(k);
  }
  return w;
}
const lowerOf = (rec) => rec.atomic - (rec.w.taken - rec.taken0);
/** The wallet's last good read while it is young enough to judge on, or null. */
function keptRead(w, now = Date.now()) {
  return w.good && now - w.good.at <= GOOD_READ_MAX_MS ? w.good : null;
}
const pendingReads = new Map(); // coverKey -> a read record with its promise `p`, the read under way
const readsDown = new Map(); // coverKey -> until when that account's reads are treated as down
// One log line a minute per network, never an account.
const downLogged = new Map();
function markReadDown(coverKey) {
  const t0 = Date.now();
  const network = networkOf(coverKey);
  if (!((readsDown.get(coverKey) || 0) > t0)) {
    stats.readsWentDown++;
    if (t0 - (downLogged.get(network) || 0) > 60_000) {
      downLogged.set(network, t0);
      console.warn(`[inflight-cover] a balance read on ${network} failed: that account's calls are judged on its last good read, or on the unread allowance, until a read succeeds`);
    }
  }
  readsDown.delete(coverKey);
  readsDown.set(coverKey, Date.now() + READ_DOWN_MS);
  if (readsDown.size > READS_DOWN_MAX_KEYS) { const t = Date.now(); for (const [k, until] of readsDown) { if (until > t && readsDown.size <= READS_DOWN_MAX_KEYS) break; readsDown.delete(k); } }
}
// The read lane: MAX_READS_IN_FLIGHT reads at once; a read past that waits
// its turn (first come, first served). A place is handed straight to the
// next waiter.
// One lane per network, so reads that hang on one chain take no place from
// a wallet on another.
const lanes = new Map(); // network -> { inFlight, waiters: [] }
const networkOf = (coverKey) => String(coverKey).split("|")[0];
const laneOf = (network) => { let l = lanes.get(network); if (!l) { l = { inFlight: 0, bg: 0, waiters: [], bgWaiters: [] }; lanes.set(network, l); } return l; };
let laneGen = 0; // bumped by the test reset: a read begun before it returns no place
// A read an admission waits for takes a place before any background read
// that is queued, and background reads hold at most BG_IN_FLIGHT_MAX of a
// lane's places at once, so the reads taken after settlements never stand
// between a call and its judgment. A queued background read an admission
// then asks for is moved up (promote).
const BG_IN_FLIGHT_MAX = MAX_READS_IN_FLIGHT / 2;
function laneEnter(network, entry) {
  const l = laneOf(network);
  if (entry.background === true) {
    if (l.inFlight < MAX_READS_IN_FLIGHT && l.bg < BG_IN_FLIGHT_MAX) { l.inFlight++; l.bg++; entry.countedBg = true; return null; }
    return new Promise((resolve) => {
      const grant = () => { entry.promote = null; resolve(); };
      grant.entry = entry;
      l.bgWaiters.push(grant);
      entry.promote = () => {
        const at = l.bgWaiters.indexOf(grant);
        if (at < 0) return;
        l.bgWaiters.splice(at, 1);
        entry.background = false;
        if (l.inFlight < MAX_READS_IN_FLIGHT) { l.inFlight++; grant(); } else l.waiters.push(grant);
      };
    });
  }
  if (l.inFlight < MAX_READS_IN_FLIGHT) { l.inFlight++; return null; }
  return new Promise((resolve) => l.waiters.push(resolve));
}
function laneLeave(network, entry) {
  const l = laneOf(network);
  l.inFlight--;
  if (entry.countedBg) { entry.countedBg = false; l.bg--; }
  const next = l.waiters.shift();
  if (next) { l.inFlight++; next(); return; }
  if (l.bgWaiters.length && l.bg < BG_IN_FLIGHT_MAX) { l.inFlight++; l.bg++; const g = l.bgWaiters.shift(); g.entry.countedBg = true; g(); }
}
const readsQueuedNow = () => { let n = 0; for (const l of lanes.values()) n += l.waiters.length + l.bgWaiters.length; return n; };
// BACKGROUND READS (the one taken when a wallet's payment settles). Queued in
// the network's lane like any read, unless BG_QUEUE_MAX reads already wait
// there; and after a background read on a network fails none is asked for
// there until BG_BACKOFF_MS later (a read that succeeds ends that), so
// wallets settling by the thousand make no read each while reads fail.
const BG_QUEUE_MAX = 32, BG_BACKOFF_MS = 10_000;
const noSourceKey = (coverKey) => String(coverKey).startsWith("stellar") && /^C/.test(String(coverKey).split("|")[2] || "");
const netFailedAt = new Map(); // network -> when a background read on it last failed
const queuedReads = new Map(); // coverKey -> { p, seq: Infinity }, the one read that follows the read under way
// The other containers' runs the latest view of a wallet showed, kept while
// it shows any: coverKey -> { members: Set, at }. Most recently viewed last.
const lastForeign = new Map();
// The order of events in this process: a shared view takes the next value
// when it lands, a balance read takes the next when it begins.
let eventSeq = 0;
const judging = new Map(); // coverKey -> Set<{ left }>, runs being judged; release() counts in `left`
// The settled-release of an admitted run, kept on its request (own,
// non-enumerable) for the settle hook, which sees only the request.
const SETTLED = Symbol("a402.inflightCoverSettled");
// How an admitted run was admitted: "covered" (verify's proof for a first run
// in flight, or a balance read that covers the sum) or "unread" (the balance
// could not be read; inside the small unread allowance). The mark is
// COVER_STATE (src/inflight-cover-state.js).
const stats = { admitted: 0, foreignSettlementsSeen: 0, backgroundReadsSkipped: 0, admittedPastKeptRead: 0, backgroundReads: 0, readsWentDown: 0, admittedOnKeptRead: 0, refusedOnKeptRead: 0, judgedAfterSettlement: 0, reservationsWrittenBack: 0, readsDropped: 0, deadReservationsIgnored: 0, settledReleases: 0, admittedByRead: 0, admittedUnread: 0, admittedTrusted: 0, refusedSettling: 0, freshReads: 0, readsTimedOut: 0, refused: 0, refusedUnread: 0, settleWaits: 0, foreignWaits: 0, withdrawals: 0, putBackMisses: 0, sharedMisses: 0, foreignReads: 0 };

/**
 * The OTHER runs a shared window read reports: everything but this run's own
 * reservation. `foreign` are the members another container holds, with their
 * count and sum (`foreignCount`, `foreignAtomic`); all three are null when the
 * window was too large to list, and the totals stand in. `selfIn`: the run's
 * own reservation is in the window (false while it waits outside it), so an
 * unlisted total is not reduced by a reservation it does not hold.
 */
function othersOf(r, selfId, selfAtomic, selfIn = true) {
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
  const count = Math.max(0, (Number(r.count) || 0) - (selfIn ? 1 : 0));
  const atomic = BigInt(Math.max(0, Math.round(Number(r.sum) || 0))) - (selfIn ? selfAtomic : 0n);
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
function noteDeparture(coverKey, { local = false, leftAtomic = 0n } = {}) {
  if (local) {
    // A run of this process left. What it took (release() says how much) is
    // added to the wallet's `taken`: every read record of the wallet, held
    // in a map or by a judgment only, is a lower bound from then on, and
    // nobody has to read again for it; a judgment that fails on the lower
    // bound alone takes a fresh read.
    if (leftAtomic > 0n) walletOf(coverKey).taken += leftAtomic;
  } else {
    // A run of another container left (or its reservation was dropped):
    // whether it settled is not known here. The last good read is forgotten
    // and a read under way is neither shared from here on nor kept.
    const w = walletOf(coverKey);
    w.good = null;
    const under = pendingReads.get(coverKey);
    if (under) under.detached = true;
    pendingReads.delete(coverKey);
  }
  const judges = judging.get(coverKey);
  if (judges) for (const j of judges) { j.left += 1; if (!local) j.foreignLeft += 1; }
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
// LIVENESS. A reservation is counted only while the process that wrote it is
// alive: each process keeps a short-lived key of its own in the shared store
// (written before its first reservation, renewed on a timer), and a
// reservation older than the grace whose process has no such key is ignored
// and removed. A process that dies mid-run (a crash, a kill) therefore stops
// being counted within LIVE_TTL_MS instead of the window's 15 minutes. A
// liveness read that does not answer counts the reservation (as before).
// Only a reservation whose id says its process keeps such a key is judged
// this way (LIVE_MARK, the prefix of this build's process ids). A build that
// keeps no key writes ids without it, and its reservations count until they
// age out of the window, as they always did: during a deploy both builds
// serve, and the older one's runs must not be dropped for a key it never
// wrote.
const LIVE_NAME = "inflight-cover-live";
// When a run of a wallet last settled, for the other containers: a flag per
// wallet whose `until` is that time plus SETTLED_MARK_MS (it lapses after).
const SETTLED_NAME = "inflight-cover-settled";
export const SETTLED_MARK_MS = 120_000;
const LIVE_TTL_MS = () => { const n = Number(process.env.INFLIGHT_COVER_LIVE_TTL_MS); return Number.isFinite(n) && n >= 500 ? n : 30_000; };
const LIVE_CACHE_MS = 2_000;
const procOf = (member) => String(member).slice(0, String(member).lastIndexOf(":"));
const liveSeen = new Map(); // process id -> { alive, at }
let liveBeat = null, liveTimer = null;
// This process's own reservations in the shared window: id -> { coverKey, atomic }.
const ownReservations = new Map();
let lastBeatAt = 0;
/**
 * One renewal of this process's liveness key. A renewal that comes later than
 * the key lasts means the process was stalled past it: other containers may
 * have dropped its reservations meanwhile, so each one it still holds is
 * written back (the key first).
 */
async function beatOnce(now = Date.now()) {
  const stalled = lastBeatAt > 0 && now - lastBeatAt > LIVE_TTL_MS();
  lastBeatAt = now;
  await sharedWrite(SHARED_NAME, shared.flagSet(LIVE_NAME, PROC, now + LIVE_TTL_MS()));
  if (!stalled) return 0;
  let n = 0;
  for (const [id, r] of ownReservations) {
    n++;
    void sharedWrite(SHARED_NAME, shared.windowAdd(SHARED_NAME, r.coverKey, { windowMs: SHARED_WINDOW_MS(), member: id, weight: Number(r.atomic), now }));
  }
  stats.reservationsWrittenBack += n;
  return n;
}
/** Test seam: one renewal at a given time. */
export const _liveBeatForTest = beatOnce;
function keepAlive() {
  if (liveBeat) return liveBeat;
  const beat = () => beatOnce();
  liveBeat = Promise.resolve(beat()).catch(() => {});
  liveTimer = setInterval(() => { void Promise.resolve(beat()).catch(() => {}); }, Math.max(250, Math.floor(LIVE_TTL_MS() / 3)));
  liveTimer.unref?.();
  return liveBeat;
}
async function procAlive(proc, now) {
  const hit = liveSeen.get(proc);
  if (hit && now - hit.at < LIVE_CACHE_MS) return hit.alive;
  let alive = true;
  try { const r = await shared.flagGet(LIVE_NAME, proc, { now }); if (r?.ok) alive = r.until > now; } catch { alive = true; }
  liveSeen.set(proc, { alive, at: now });
  if (liveSeen.size > 2_000) liveSeen.delete(liveSeen.keys().next().value);
  return alive;
}
/** A window reading without the reservations of processes that are gone. */
async function withoutDead(coverKey, r, now = Date.now()) {
  if (!r?.ok || !Array.isArray(r.entries) || !r.entries.length) return r;
  const grace = LIVE_TTL_MS();
  const dead = [];
  for (const e of r.entries) {
    if (isOurs(e.member)) continue;
    if (!String(e.member).startsWith(LIVE_MARK)) continue; // a build that keeps no liveness key
    if (Number.isFinite(Number(e.score)) && now - Number(e.score) < grace) continue; // newer than a liveness key can lapse
    if (!(await procAlive(procOf(e.member), now))) dead.push(e);
  }
  if (!dead.length) return r;
  stats.deadReservationsIgnored += dead.length;
  for (const e of dead) void sharedWrite(SHARED_NAME, shared.windowRemove(SHARED_NAME, coverKey, { member: e.member, weight: e.weight }));
  // A dropped reservation is a departure like any other container's: its
  // process may have settled it, or may be stalled and settle it yet, so the
  // wallet's next judgment is made on a read taken after it.
  noteDeparture(coverKey);
  const gone = new Set(dead.map((e) => e.member));
  const entries = r.entries.filter((e) => !gone.has(e.member));
  return { ...r, entries, count: entries.length, sum: entries.reduce((a, e) => a + Number(e.weight || 0), 0) };
}
const sharedWindowAdd = async (coverKey, member, atomic, now) => {
  ownReservations.set(member, { coverKey, atomic });
  return withoutDead(coverKey, await shared.windowAdd(SHARED_NAME, coverKey, { windowMs: SHARED_WINDOW_MS(), member, weight: Number(atomic), now }), now);
};
const sharedWindowRead = async (coverKey) => withoutDead(coverKey, await shared.windowRead(SHARED_NAME, coverKey, { windowMs: SHARED_WINDOW_MS() }));
const removeShared = (coverKey, id, atomic) => { ownReservations.delete(id); return sharedWrite(SHARED_NAME, shared.windowRemove(SHARED_NAME, coverKey, { member: id, weight: Number(atomic) })); };

function unreadPaidMax() {
  const n = Number(process.env.INFLIGHT_COVER_UNREAD_PAID_MAX);
  return Number.isInteger(n) && n >= 1 ? n : 16;
}
function unreadMax() {
  const n = Number(process.env.INFLIGHT_COVER_UNREAD_MAX);
  return Number.isInteger(n) && n >= 1 ? n : 4;
}
export function inflightCoverEnabled() {
  return inflightCoverMode() !== "off";
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

/** The payer's balance of the paying token, by rail. */
const readBalance = (terms) => (terms?.rail && terms.rail !== "evm" ? readRailBalance(terms) : readTokenBalance(terms));
let reader = readBalance;
/** Test seam. */
export function _setBalanceReaderForTest(fn) { reader = typeof fn === "function" ? fn : readBalance; }

/**
 * What the verified payment on this request draws on, on any rail this check
 * covers: { rail, payer, network, asset, atomic }, or null. A Tempo pull
 * credential first (it carries no x402 header); a Circle Gateway batched
 * payment never (its funds are not in the wallet); then the x402 EVM shapes;
 * then Solana, Algorand and Stellar.
 */
export async function coverTermsOfRequest(req) {
  if (!req || typeof req !== "object") return null;
  if (req.tempoSettling === true) return tempoCoverTermsOf(req);
  const header = paymentHeaderOf(req);
  if (!header) return null;
  let batched = false;
  try { batched = isGatewayBatchedRequest(req); } catch { return null; }
  const evm = coverTermsOf(header);
  // A batched payment is the same signed authorization, paid from the
  // signer's Gateway balance on that network's domain.
  if (batched) return evm ? { rail: "gateway", payer: evm.payer, network: evm.network, asset: "gateway", atomic: evm.atomic } : null;
  if (evm) return { rail: "evm", ...evm };
  try { return await nonEvmCoverTermsOf(req); } catch { return null; }
}

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
// time, never one read per run. A full lane is a queue: the read waits its
// turn (the admission that asked waits no longer than its own deadline).
function balanceFor(coverKey, terms, now, minSeq = 0, background = false) {
  const w = walletOf(coverKey, now);
  const hit = w.good;
  if (hit && now - hit.at < CACHE_MS && hit.seq > minSeq) return hit;
  const pending = pendingReads.get(coverKey);
  if (pending && pending.seq > minSeq) return pending;
  const queued = queuedReads.get(coverKey);
  if (queued) return queued;
  // While this account's reads are failing, one read a second is made for
  // it (the probe that finds them back); every other caller is not read.
  if (!pending && (readsDown.get(coverKey) || 0) > now && now - w.readAt < READ_FAIL_GAP_MS) return null;
  w.readAt = now;
  let held = false;
  const gen = laneGen, network = networkOf(coverKey);
  const entry = { p: null, seq: Infinity, taken0: w.taken, w, atomic: null, at: 0, reading: false, waiters: 0, asked: false, detached: false, background, countedBg: false, promote: null };
  w.open++;
  entry.p = (async () => {
    try {
      if (pending) {
        await settledWithin(pending.p, READ_AHEAD_WAIT_MS);
        if (queuedReads.get(coverKey) === entry) queuedReads.delete(coverKey);
        pendingReads.set(coverKey, entry);
      } else await null;
      // A full lane is waited for, never read as unknown.
      const turn = laneEnter(network, entry);
      if (turn) await turn;
      held = true;
      // Its turn in the lane has come and every admission that asked for it
      // has gone (refused, admitted another way, hung up): the read is not
      // made. It says nothing about the account's reads.
      if (entry.asked && entry.waiters <= 0) { stats.readsDropped++; return null; }
      entry.seq = ++eventSeq;
      entry.reading = true;
      const atomic = await reader(terms);
      if (typeof atomic !== "bigint" || atomic < 0n) { markReadDown(coverKey); if (entry.background && !noSourceKey(coverKey)) netFailedAt.set(network, Date.now()); return null; }
      readsDown.delete(coverKey);
      netFailedAt.delete(network);
      entry.atomic = atomic;
      entry.at = Date.now();
      // A run of another container that left while this read was under way
      // detached it: it may predate that run's settlement, so it is not kept
      // for anyone who asks after. Otherwise it is the wallet's last good
      // read unless a later one already is.
      if (!entry.detached && (!w.good || w.good.seq < entry.seq)) w.good = entry;
      return entry;
    } catch { markReadDown(coverKey); if (entry.background && !noSourceKey(coverKey)) netFailedAt.set(network, Date.now()); return null; }
    finally {
      entry.reading = false;
      w.open--;
      if (held && gen === laneGen) laneLeave(network, entry);
      if (pendingReads.get(coverKey) === entry) pendingReads.delete(coverKey);
      if (queuedReads.get(coverKey) === entry) queuedReads.delete(coverKey);
    }
  })();
  if (pending) queuedReads.set(coverKey, entry); else pendingReads.set(coverKey, entry);
  return entry;
}
/**
 * The read record an admission is judged on, or null (unread). Waits for a
 * read no later than `until` (a monotonic time); a read that outlasts it marks
 * the account's reads as down and goes on in the background. While they are
 * down a cached record still answers, and a read is waited for only briefly.
 */
async function readWithin(coverKey, terms, minSeq, until) {
  const r = balanceFor(coverKey, terms, Date.now(), minSeq);
  if (!r || r.atomic !== null || !r.p) return r && r.atomic !== null ? r : null;
  // This account's reads are down: this one is given a moment (it is the
  // probe that finds them back), never the whole wait.
  const down = (readsDown.get(coverKey) || 0) > Date.now();
  const waitMs = Math.max(0, Math.min(until - mono(), down ? READ_DOWN_WAIT_MS : Infinity));
  let timer = null;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(readWithin), waitMs); });
  r.asked = true;
  r.waiters++;
  if (r.promote) r.promote();
  let rec;
  try { rec = await Promise.race([r.p, timedOut]); } finally { r.waiters--; clearTimeout(timer); }
  if (rec !== readWithin) return rec;
  // A read that is merely slow says nothing about the account's reads: it
  // goes on, and is the wallet's last good read when it answers.
  if (!down && r.reading) stats.readsTimedOut++;
  return null;
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
 * run cannot be admitted (see the rules at the top of this file).
 * The release function carries settling(): call it when the run's handler has
 * returned and its settlement is under way.
 * `expensive`: the route is one of the report and media routes.
 * `settleWaitMs` is the whole admission wait (reads and settling runs).
 */
export async function admitCoveredRun(req, { now = Date.now(), expensive = false, settleWaitMs = null, arrivedAt = null } = {}) {
  const mode = inflightCoverMode();
  if (mode === "off") return null;
  if (mode === "composite" && !expensive) return null;
  // The report and media routes are judged as they always were, in either
  // mode: the 5 s wait, four runs on an unread balance for every wallet.
  const asBefore = expensive;
  if (settleWaitMs == null) settleWaitMs = asBefore ? COMPOSITE_SETTLE_WAIT_MS : ADMIT_WAIT_MS;
  const terms = await coverTermsOfRequest(req);
  if (!terms) return null;
  // One ledger key per balance: a payment that names no asset draws on the
  // chain's own token, the same balance as one that names it.
  if (terms.rail === "evm" && !terms.asset) {
    try { const { EVM } = await import("./revenue-live.js"); const t = EVM[CHAIN_BY_CAIP2[terms.network]]?.token; if (typeof t === "string" && HEX_ADDR.test(t)) terms.asset = t.toLowerCase(); } catch { /* keyed without it */ }
  }
  const coverKey = `${terms.network}|${terms.asset || "-"}|${terms.payer}`;
  // The wallet the paid record is kept under (a Solana payment draws on a
  // token account; its authority is the wallet).
  const owner = terms.owner || terms.payer;
  // Read once, here: the allowance on an unread balance is the one the wallet
  // had when this admission began.
  const paidAtStart = hasPaidRecord(owner);
  const waitUntil = mono() + settleWaitMs;
  // `left` counts this wallet's runs that leave the ledger while this one is
  // judged (release() bumps it). Once one has, verify's proof no longer holds
  // and the no-read admission is off: this run is judged on a read.
  // `foreignLeft` counts the ones another container held.
  const me = { left: 0, foreignLeft: 0 };
  const w = walletOf(coverKey, now);
  w.open++;
  // When the request arrived, before its gate verified the payment (the
  // server stamps it); without a stamp, when this admission began.
  const arrived = Number.isFinite(Number(arrivedAt)) && Number(arrivedAt) > 0 ? Number(arrivedAt) : now;
  const judges = judging.get(coverKey) || new Set();
  judging.set(coverKey, judges);
  judges.add(me);
  // The shared reservation goes in before the judgment, so two containers
  // judging one wallet at once each see the other's run; it is taken back on
  // a refusal and when the admitted run leaves.
  const sharedId = SHARED ? `${PROC}:${++runSeq}` : null;
  let others = null, sharedSeq = 0;
  if (sharedId) {
    await keepAlive();
    const r = await sharedWindowAdd(coverKey, sharedId, terms.atomic, now);
    // A run another container held at this wallet's last view and no longer
    // holds has left: this run is judged on a read, whatever else is in flight.
    if (r.ok) { others = othersOf(r, sharedId, terms.atomic); sharedSeq = ++eventSeq; noteView(coverKey, others); }
    else { stats.sharedMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
  }
  let admitted = false, how = "covered";
  try {
    // A read must have begun after `freshAfter` to be judged on.
    let freshAfter = 0;
    let lastRec = null, markRead = false;
    // Only a read BEGUN inside this judgment is its own (lastRec). A read
    // cached from before it is the wallet's last good read like any other.
    const seqAtAdmission = eventSeq;
    // A run another container held that leaves during a judgment sends it to
    // a read taken after the departure, at most twice past the wait (each
    // such read given FOREIGN_REREAD_MS).
    let readUntil = waitUntil, foreignRereads = 0;
    // The follow-up read of a judgment whose read already reflected a
    // settlement (taken off it again, so undecided with nothing in flight) is
    // let finish, bounded by the read timeout, instead of the admission wait:
    // judged on a stale lower bound it would be refused with nothing in flight.
    let followUpRead = false;
    const rereadAfterForeign = () => {
      if (mono() >= waitUntil && foreignRereads >= 2) return false;
      foreignRereads++;
      readUntil = Math.max(waitUntil, mono() + FOREIGN_REREAD_MS);
      return true;
    };
    for (;;) {
      const held = ledger.get(coverKey);
      // Nothing in flight: verify's proof stands, unless a run of the wallet
      // settled after this request arrived (verify may have seen the balance
      // before that payment left it): then this run is judged like any other.
      if (me.left === 0 && (!held || held.count <= 0) && !foreignHeld(others, held)) {
        // Another container may have settled a run of this wallet: its mark
        // is read once, before verify's proof is trusted.
        if (sharedId && !markRead) {
          markRead = true;
          try {
            const m = await shared.flagGet(SETTLED_NAME, coverKey, { now: Date.now() });
            const at = m?.ok && m.until > Date.now() ? m.until - SETTLED_MARK_MS : 0;
            // A settlement this process did not make: its amount was never
            // taken off this wallet's reads, so the last good read goes.
            if (at > w.settledAt) { w.settledAt = at; w.good = null; stats.foreignSettlementsSeen++; }
          } catch { /* the mark could not be read: this process's own stands */ }
          continue;
        }
        const settledSince = w.settledAt > arrived;
        if (!settledSince) break;
        stats.judgedAfterSettlement++;
      }
      const foreignLeftBefore = me.foreignLeft;
      const seqAtStart = eventSeq;
      // Another container's run is in flight: verify's proof may predate its
      // settlement, so only a read begun after the shared view decides.
      const foreign = foreignHeld(others, held, judges.size);
      if (foreign) stats.foreignReads++;
      const until = followUpRead ? Math.max(readUntil, mono() + READ_TIMEOUT_MS) : readUntil;
      followUpRead = false;
      let rec = await readWithin(coverKey, terms, Math.max(freshAfter, foreign ? sharedSeq : 0), until);
      // NOT READ NOW. A read this judgment already had stands in (a later
      // read that does not answer never turns a judged call into an unread
      // one); else, off the report and media routes, the wallet's last good
      // read. Either is a lower bound: what left since is taken off it.
      let kept = false, keptOwn = false;
      if (rec) { if (rec.seq > seqAtAdmission) lastRec = rec; }
      else {
        const g = lastRec || (asBefore ? null : keptRead(w));
        if (g) { rec = g; kept = true; keptOwn = g === lastRec; noteDecidedUnread(coverKey, terms); }
      }
      // A run of another container left while the balance was being read: the
      // read may predate its settlement. Judge again on a read taken after it.
      if (me.foreignLeft !== foreignLeftBefore && rereadAfterForeign()) continue;
      if (others) {
        const r = await sharedWindowRead(coverKey);
        if (r.ok) {
          const next = othersOf(r, sharedId, terms.atomic);
          // A window too large to list names nobody: this run's own two
          // counts are then the only sign that a run left.
          const unlistedGone = (!others.foreign || !next.foreign) && foreignDeparted(others, next);
          others = next; sharedSeq = ++eventSeq;
          if (!noteView(coverKey, next) && unlistedGone) noteDeparture(coverKey);
        } else { stats.sharedMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
        if (me.foreignLeft !== foreignLeftBefore && rereadAfterForeign()) continue;
      }
      // Re-read the ledger AFTER the awaits: other runs may have been admitted
      // meanwhile, and the check and the admission (synchronous, below) must
      // see the same numbers, with another container's runs added on.
      const cur = judgedSet(ledger.get(coverKey) || { count: 0, atomic: 0n, settling: 0 }, others);
      const need = cur.atomic + terms.atomic;
      const beside = foreignHeld(others, ledger.get(coverKey), judges.size);
      // Why this run cannot start now, or null when it can.
      let block = null;
      // The allowance: a fixed number of runs in flight on a balance that
      // was not read. The report and media routes keep the one they always
      // had, for every wallet.
      const withinAllowance = () => cur.count < (paidAtStart && !asBefore ? unreadPaidMax() : unreadMax());
      if (!rec) {
        // NOT READ, and no read of this wallet to stand in: the allowance,
        // and past it a refusal at once.
        noteDecidedUnread(coverKey, terms);
        if (withinAllowance()) how = paidAtStart ? "trusted" : "unread";
        else block = "unread";
      // READ: admitted if and only if the balance covers every run in flight
      // plus this one.
      } else if (lowerOf(rec) >= need) { how = "covered"; if (kept) stats.admittedOnKeptRead++; }
      // The wallet's LAST GOOD READ does not cover it. A kept read is never
      // stricter than no read at all (the wallet may have been funded since):
      // the run falls to the allowance.
      else if (kept && !keptOwn) {
        if (withinAllowance()) { how = paidAtStart ? "trusted" : "unread"; stats.admittedPastKeptRead++; }
        else block = "kept";
      }
      // A read THIS judgment had, with no fresh one to be had: it stands.
      // Undecided only while a run is settling.
      else if (kept) block = cur.settling > 0 ? "settling" : "kept";
      // Not covered on the lower bound. Undecided while the read itself would
      // cover it (a settlement may be counted twice: once in the read, once
      // taken off it) or while a run is settling (its payment may be off the
      // wallet while the ledger still counts it); short otherwise.
      // Beside another container's run only (whose settling this process
      // cannot see), the call waits the same way and, with nobody gone, is
      // refused as short, as it would have been at once.
      else block = rec.atomic >= need || cur.settling > 0 ? "settling" : beside ? "beside" : "short";
      if (!block) break;

      // Inside the admission wait only, and never on an unread balance.
      if (block !== "unread" && mono() < waitUntil) {
        // A record that began before this judgment (a cached read): one read
        // begun now settles it, whichever way.
        // A record a second old or less is taken as it is: a wallet that
        // sends call after call past its balance costs no read per refusal.
        if (!kept && rec.seq <= seqAtStart && Date.now() - rec.at > FRESH_ENOUGH_MS) { stats.freshReads++; freshAfter = eventSeq; continue; }
        // A fresh read left it undecided with nothing settling: a settlement
        // landed while it was under way. Read once more, and let that read
        // finish (bounded by the read timeout) before deciding.
        if (!kept && block === "settling" && cur.settling <= 0 && !beside) { stats.freshReads++; freshAfter = eventSeq; followUpRead = true; continue; }
        if (block === "settling" || block === "beside") {
          // A run that is settling may already be paid for on chain while it
          // still counts here: wait for a run to leave (here, or on another
          // container), inside the admission wait, then judge again.
          if (cur.settling > 0) stats.settleWaits++; else stats.foreignWaits++;
          const leftAtWait = me.left;
          let withdrawn = false;
          if (beside && sharedId) {
            // Beside another container's run, step out of the window while
            // waiting (put back below, before any judgment).
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
            const r = await sharedWindowRead(coverKey);
            if (r.ok) {
              const seen = othersOf(r, sharedId, terms.atomic, !withdrawn);
              if (!noteView(coverKey, seen) && (!others.foreign || !seen.foreign) && foreignDeparted(others, seen)) noteDeparture(coverKey);
            } else { stats.sharedMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
            if (me.left !== leftAtWait || mono() >= waitUntil) break;
            pollMs = Math.min(pollMs * 2, FOREIGN_POLL_MAX_MS);
          }
          let back = true;
          if (withdrawn) {
            // Back into the window before any judgment. A reservation that
            // could not be put back would leave this run unseen by the other
            // container, which could then admit beside it: refused instead.
            const r = await sharedWindowAdd(coverKey, sharedId, terms.atomic, Date.now());
            if (r.ok) { others = othersOf(r, sharedId, terms.atomic); sharedSeq = ++eventSeq; noteView(coverKey, others); }
            else { back = false; stats.sharedMisses++; stats.putBackMisses++; noteSharedLimitsDegraded(SHARED_NAME, r); }
          }
          // A run left: judged again (on the record held, and on a fresh read
          // if that leaves it undecided). Nobody left: the judgment stands.
          if (back && me.left !== leftAtWait) continue;
        }
      }
      stats.refused++;
      if (block === "unread") stats.refusedUnread++;
      if (block === "settling") stats.refusedSettling++;
      if (kept) stats.refusedOnKeptRead++;
      // The report and media routes answer in the words and with the
      // Retry-After they always had.
      const undecided = block === "settling" && !asBefore;
      const e = new Error(block === "unread"
        ? `This wallet already has ${cur.count} paid runs in progress here, and its balance could not be read to confirm it also covers this one. Your input is fine: retry the same call after Retry-After, once one of them has settled. You have not been charged.`
        : block === "kept" && !asBefore
        ? `This wallet's balance could not be read just now, and the last balance read for it, less what its payments here have taken and its calls in progress hold, does not cover this one. Your input is fine: ${cur.count > 0 ? "retry the same call after Retry-After, once one of its calls in progress has settled" : "add funds to this wallet, then retry the same call"}. You have not been charged.`
        : undecided
        ? `Another call from this wallet is still settling, and until it has, the wallet's balance cannot be confirmed to cover this one as well. Your input is fine: retry the same call after Retry-After, once that call has settled. You have not been charged.`
        : cur.count <= 0
          ? `This wallet's balance no longer covers this run: another paid run from this wallet settled after this payment was checked, and the balance left does not cover this one too. Your input is fine: add funds to this wallet, then retry the same call. You have not been charged.`
          : `This wallet already has ${cur.count} paid runs in progress here, and its balance does not cover this one as well. Each payment is checked on its own, but settling them all needs the sum. Your input is fine: ${block === "short" ? "add funds to this wallet, then retry the same call" : "retry the same call after Retry-After, once one of them has settled, or add funds"}. You have not been charged.`);
      e.statusCode = 429;
      // The refusal's class, for the tool log (src/refusal-reason.js).
      e.coverRefusal = block;
      // Not the caller's input: this server's own admission limit, so the
      // answer carries no input schema (src/tool-error-fields.js
      // notCallersInput). The attribution vocabulary (src/upstream-deadline.js)
      // has no payer-side word, so every class reads "ours": this server's
      // limit. The hint names the class (`reason` is derived from coverRefusal
      // there), and `fix` is the next step for a payer that can pay: waiting
      // helps only while a call of the wallet is in flight to settle or end
      // (settling a call lowers the balance and the amount held together, so
      // a short balance needs funds).
      e.attribution = "ours";
      e.hint = `cover-${block}`;
      e.fix = block === "short" || (block === "kept" && cur.count <= 0)
        ? "Your input is fine. Add funds to this wallet, then retry the same call."
        : "Your input is fine. Retry the same call after Retry-After, when a paid call this wallet has in flight has settled.";
      e.retryAfter = asBefore ? 30 : block === "short" || block === "beside" ? 30 : 5;
      throw e;
    }
    admitted = true;
  } finally {
    w.open--;
    judges.delete(me);
    if (!judges.size && judging.get(coverKey) === judges) judging.delete(coverKey);
    if (sharedId && !admitted) void removeShared(coverKey, sharedId, terms.atomic);
  }
  if (how === "unread") stats.admittedUnread++; else if (how === "trusted") stats.admittedTrusted++; else stats.admittedByRead++;
  const entry = ledger.get(coverKey) || { count: 0, atomic: 0n, settling: 0 };
  entry.count += 1;
  entry.atomic += terms.atomic;
  ledger.set(coverKey, entry);
  stats.admitted++;
  let released = false, settling = false;
  const release = (settled = false, settledAtomic = null) => {
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
    // A settlement is this wallet's paid record from now on.
    // What the run took from the wallet. A settlement: the amount it reports
    // when it reports one (a settle under a ceiling takes less than the
    // ceiling), else the amount the payment commits. A run whose answer ended
    // at 400 or above with no settlement reported took nothing (a gate
    // settles only an answer under 400, and answers 402 when the settle is
    // refused). Any other end (an answer under 400 with no settlement
    // reported, an answer that never got a status) is counted in full: a
    // settler this process was not told of may have taken it.
    let took = terms.atomic;
    if (settled !== true) {
      const status = Number(req?.res?.statusCode);
      if (status >= 400) took = 0n;
    } else {
      try { const a = settledAtomic == null ? null : BigInt(settledAtomic); took = a != null && a > 0n && a <= terms.atomic ? a : terms.atomic; } catch { took = terms.atomic; }
      stats.settledReleases++;
      notePaidSettlement(owner);
      const at = Date.now();
      walletOf(coverKey).settledAt = at;
      // The mark other containers read before they trust verify's proof.
      if (SHARED) void sharedWrite(SHARED_NAME, shared.flagSet(SETTLED_NAME, coverKey, at + SETTLED_MARK_MS));
    }
    // Every read record held for the wallet takes this run's amount off (it
    // stays a lower bound), every run being judged is told a run has left,
    // and every run waiting for one to leave is woken.
    noteDeparture(coverKey, { local: true, leftAtomic: took });
    // A wallet that has just paid gets a last good read to be judged on
    // should its balance become unreadable: one read in the background, when
    // it has none younger than GOOD_READ_REFRESH_MS and the lane has room
    // (at most one such read per wallet in that time; nothing waits for it).
    if (settled === true) {
      const w2 = walletOf(coverKey);
      const net = networkOf(coverKey);
      const backingOff = Date.now() - (netFailedAt.get(net) || 0) < BG_BACKOFF_MS;
      if ((!w2.good || Date.now() - w2.good.at > GOOD_READ_REFRESH_MS) && !pendingReads.has(coverKey)) {
        if (backingOff || laneOf(net).bgWaiters.length >= BG_QUEUE_MAX) stats.backgroundReadsSkipped++;
        else {
          const r = balanceFor(coverKey, terms, Date.now(), 0, true);
          if (r && r.atomic === null) stats.backgroundReads++;
        }
      }
    }
  };
  // What the response-end hook calls: the run left without a settlement
  // success being reported (it failed, was refused, or never settled).
  const releaseAtEnd = () => release(false);
  releaseAtEnd.settling = () => {
    if (released || settling) return;
    settling = true;
    const e = ledger.get(coverKey);
    if (e) e.settling += 1;
  };
  // Settlement succeeded: the payment is off the wallet, so the run leaves
  // the ledger now rather than when its response ends. Same release, once.
  releaseAtEnd.settled = (settledAtomic = null) => release(true, settledAtomic);
  try { Object.defineProperty(req, SETTLED, { value: releaseAtEnd.settled, configurable: true }); } catch { /* the response-end release still applies */ }
  try { Object.defineProperty(req, COVER_STATE, { value: how, configurable: true }); } catch { /* read as not admitted: the breaker then counts the run in flight */ }
  return releaseAtEnd;
}

/**
 * Called when a request's settlement has SUCCEEDED on chain. Releases that
 * request's in-flight reservation at once (a no-op when it holds none or has
 * already left). Never call it for a failed or pending settlement: a run whose
 * payment is not taken must keep counting against the balance.
 */
export function markCoveredRunSettled(req, settledAtomic = null) {
  if (!req || typeof req !== "object" || !Object.hasOwn(req, SETTLED)) return false;
  const fn = req[SETTLED];
  if (typeof fn !== "function") return false;
  fn(settledAtomic);
  return true;
}

// Admissions decided without a balance read made for them (on a kept read, or
// on the allowance), admitted or refused: when the last one was, and, for the
// sustained verdict, which accounts they were for in each of the last ten
// minutes. An account with no balance source at all (a Stellar contract
// account) is always decided that way and says nothing about balance reads,
// so it is left out of the verdict.
let lastDecidedUnreadAt = 0;
const READS_WORD_WINDOW_MS = 10 * 60_000;
const SUSTAINED_MINUTES = 3, SUSTAINED_ACCOUNTS = 3, MINUTE_ACCOUNTS_MAX = 64;
const unreadMinutes = new Map(); // minute -> Set of accounts
const hasNoBalanceSource = (terms) => terms?.rail === "stellar" && /^C/.test(String(terms.payer || ""));
function noteDecidedUnread(coverKey, terms, now = Date.now()) {
  lastDecidedUnreadAt = now;
  if (hasNoBalanceSource(terms)) return;
  const minute = Math.floor(now / 60_000);
  let set = unreadMinutes.get(minute);
  if (!set) {
    set = new Set();
    unreadMinutes.set(minute, set);
    for (const m of unreadMinutes.keys()) if (m <= minute - READS_WORD_WINDOW_MS / 60_000) unreadMinutes.delete(m);
  }
  if (set.size < MINUTE_ACCOUNTS_MAX) set.add(coverKey);
}
/**
 * For /api/gateway-status. `status`: "off" when the check is off, "degraded"
 * when an admission was decided without a balance read made for it inside the
 * last ten minutes, else "ok". `sustained`: such decisions fell in three or
 * more separate minutes of the last ten AND were for three or more distinct
 * accounts: balance reads are failing for buyers at large, not for one wallet
 * (one buyer, however it sends, never makes it true). Pagers act on
 * `sustained` only.
 */
export function coverageReadsVerdict(now = Date.now()) {
  if (!inflightCoverEnabled()) return { status: "off", sustained: false };
  const status = lastDecidedUnreadAt && now - lastDecidedUnreadAt < READS_WORD_WINDOW_MS ? "degraded" : "ok";
  const from = Math.floor(now / 60_000) - READS_WORD_WINDOW_MS / 60_000;
  let minutes = 0; const accounts = new Set();
  for (const [m, set] of unreadMinutes) { if (m <= from || !set.size) continue; minutes++; for (const a of set) accounts.add(a); }
  return { status, sustained: status === "degraded" && minutes >= SUSTAINED_MINUTES && accounts.size >= SUSTAINED_ACCOUNTS };
}
export function coverageReadsWord(now = Date.now()) { return coverageReadsVerdict(now).status; }
/** Test-only: the decisions recorded so far are made `ms` older. */
export function _ageUnreadDecisionsForTest(ms) {
  lastDecidedUnreadAt -= ms;
  const shift = Math.round(ms / 60_000);
  const moved = [...unreadMinutes].map(([m, set]) => [m - shift, set]);
  unreadMinutes.clear();
  for (const [m, set] of moved) unreadMinutes.set(m, set);
}

/** Counts only - never a wallet. */
export function inflightCoverStatus() {
  let runs = 0;
  for (const e of ledger.values()) runs += e.count;
  return { enabled: inflightCoverEnabled(), mode: inflightCoverMode(), readsQueued: readsQueuedNow(), walletsKept: wallets.size, accountsReadDown: [...readsDown.values()].filter((t) => t > Date.now()).length, goodReadMaxMs: GOOD_READ_MAX_MS, unreadPaidMax: unreadPaidMax(), shared: SHARED, walletsInFlight: ledger.size, runsInFlight: runs, viewsKept: lastForeign.size, unreadMax: unreadMax(), ...stats };
}

/** Test-only: every kept read is made `ms` older. */
export function _ageKeptReadsForTest(ms) { for (const w of wallets.values()) { if (w.good) w.good.at -= ms; w.touched -= ms; } }
/** Test-only. */
export function _resetInflightCoverForTest() {
  ledger.clear(); wallets.clear(); downLogged.clear(); ownReservations.clear(); lastBeatAt = 0; unreadMinutes.clear(); pendingReads.clear(); queuedReads.clear(); lastForeign.clear(); judging.clear(); liveSeen.clear(); readsDown.clear(); lastDecidedUnreadAt = 0; laneGen++; for (const l of lanes.values()) for (const w of [...l.waiters.splice(0), ...l.bgWaiters.splice(0)]) w(); lanes.clear(); netFailedAt.clear(); reader = readBalance;
  for (const set of waiters.values()) for (const wake of [...set]) wake();
  waiters.clear();
  for (const k of Object.keys(stats)) stats[k] = 0;
}
