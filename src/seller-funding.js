// Seller-funded payments are not settlement evidence (2026-09-28).
//
// A payment into wallet W is the seller's own money coming home when W sent its
// payer the USDC that pays it: a seller can fund a fleet of fresh wallets and
// have them "buy" from it, and every one of those reads as a distinct buyer.
// Measured before building this: several sellers the router would pay drew
// most of their settled volume from wallets their own payTo had funded first.
//
// THE RULE, per (wallet W, payer P), in chain order, FIRST IN FIRST OUT:
//   - every non-zero USDC transfer W -> P adds its amount to P's "pool";
//   - every payment P -> W the leaderboard counts takes what the pool can
//     cover (up to its own amount) out of the pool: that much of the payment
//     is self-funded. A payment at least half covered does not count as a
//     settlement at all.
//   - a transfer P -> W the leaderboard does NOT count (above the per-call
//     ceiling: not a tool call, so never evidence) is P's own money going to
//     W: it first pays back the pool, and what is left is P's "credit", which
//     a later W -> P transfer spends before it adds to the pool (the refund of
//     a payment that was never counted is P's own money coming back, not the
//     seller's).
//   - a W -> P transfer that fits inside P's counted payments made with its
//     own money and not yet refunded is a REFUND of them (2026-09-28): the
//     refunded payments, NEWEST FIRST (a refund follows the call it returns),
//     are taken out of the evidence altogether - neither a settled call nor
//     self-funding, and not in the dollars the circular share is judged on:
//     they did not happen as revenue. Only the excess becomes pool. A payment
//     is removed once at least half of it is refunded. A NETTED payment is
//     never refundable, so fund -> pay -> fund -> pay stays netted, and a
//     payer ping-ponging one dollar through pay / refund is left with at most
//     its unrefunded payments counted, however many rounds it runs. Only the
//     newest REFUNDABLE_MAX genuine payments per payer are refundable; a
//     refund reaching further back becomes pool (it nets, never counts).
//     Before this, a flaky tool that refunded twice and was retried twice
//     read 2/3 self-funded and could be marked circular.
// So a refund (W -> P after P paid) never makes the earlier payment
// self-funded; a seller that funds a buyer once is netted until that buyer
// has spent the money, and never after. Judged by DOLLARS: a wallet is "circular" when more
// than half of the dollars it received (of what has been read) were
// self-funded. Counting calls or payers instead would let anyone flip an
// honest seller with a few cheap calls from wallets the seller once refunded.
//
// ONLY THE PAID WALLET'S OWN OUTBOUND COUNTS. Crediting funding from "sibling"
// wallets (other wallets listed under the same host) let a third party whose
// listing lands in a seller's host group demote it with dust transfers to its
// buyers, and it added nothing against a seller who simply funds from a wallet
// that is not a payTo. Funding through an intermediary, a sibling wallet, an
// exchange withdrawal, or another chain is not caught: a documented residual.
//
// EVERY PAYER'S WHOLE HISTORY IS READ, ONCE, THE FIRST TIME IT PAYS (2026-09-28,
// after review). The first cut read a new wallet's outbound only from a fixed
// lookback before the scan window, so a seller that funded its fleet and then
// waited longer than the lookback before the fleet bought was credited in full.
// Now each wallet keeps the set of its KNOWN payers. When a payer first shows
// up in a scan, its whole history with the wallet is read with two targeted
// filters - the wallet's transfers to it from the token's deployment up to the
// wallet's cursor, and (only when the wallet ever funded it) its transfers to
// the wallet before the scan window - and its pool is built from that before
// any of its payments are judged. Its later funding is caught by the wallet's
// incremental outbound read, which records transfers to known payers only. So
// waiting buys nothing: however long before its first purchase a payer was
// funded, that funding is read. A recipient that never pays is never recorded,
// so no amount of transfers to non-payers can fill the pool caps.
// A payer forgotten for being idle (knownTtlBlocks, with no pool left) is read
// again from the start if it pays again, and so is every payer of a wallet
// whose whole state was dropped: forgetting only costs a read.
//
// The funding facts are PERSISTED (src/leaderboard.js keeps this state on the
// volume beside the snapshot) and read INCREMENTALLY: each wallet has a cursor,
// each hourly scan reads only the blocks since it, and each (W, P) pool
// survives until it is spent.
//
// COST BOUNDS: one eth_getLogs per job, at most `maxCalls` per scan across the
// outbound read, the history reads and the gap reads, and at most
// `dayMaxCalls` RETRIES - history and gap calls past a wallet's plan, or
// picking up a read refused at every width last time - in any rolling day
// (persisted with the state); first reads of new payers are bounded by the
// scan's budget alone, so a burst of retries never keeps a new wallet from
// being read. Wallets that clear the router's floor on gross figures are read
// first. A
// history read packs up to 200 wallets and 200 payers into one call; a
// steady-state outbound read is one call per 200 wallets, and a wallet whose
// outbound is too large to read that way is read targeted at its known payers
// from then on (see readSellerFunding). A refusal splits only the job that
// was refused: its wallet list first (isolating the heavy source), then its
// payer list when the RPC said the answer was too large, else it narrows the
// block width that job reads next (by four while no width has been answered,
// by two after). A history job reads its range front to back, one width at a
// time; the width doubles again after each read that is answered, so a dense
// stretch of history narrows only the reads that cross it. An unreachable RPC
// is retried once and then stops the read for this scan rather than fanning
// out; a timed-out read, or one that fails for no stated reason, is split
// like a refusal at most three times a scan (counts shared by every pass of
// the scan, `newFundingReadControl`), then the read stops. A rate-limit
// answer stops the read for the scan (splitting would only send more requests
// to a provider that is throttling), and so does an RPC that says it LIMITS
// the block range of eth_getLogs, when the read is a whole-history one: that
// is a property of the RPC, no split of this job can fit the history under
// it, and the log line says whether FUNDING_HISTORY_CHUNK_BLOCKS could.
// ONE WALLET CANNOT SPEND THE READS (2026-09-28, after three reviews). Each
// wallet's history and gap reads are an EPISODE kept with its state: the calls
// they were planned to take and the calls spent, ACROSS SCANS, until the reads
// complete and the wallet is worked. A read is charged to every wallet in it.
// Planned work goes first - wallets with a little of their plan left, then
// the rest one at a time in priority order, so a wallet with many payers
// finishes rather than every wallet ending the scan half read - and calls
// past a plan after it. A wallet may spend its plan plus `walletMaxCalls`
// more on splits (0: only what was planned); past that it WAITS - one day,
// then twice as long each time it has to wait again before its reads
// complete, up to a week - and while it waits it costs no call. A read never
// answered at any width whose reads left, at the width it has narrowed to,
// are more than one scan's budget stops the same way, and so does a wallet
// whose retries the day's allowance holds back. A wallet stopped only because
// the scan's budget ran out keeps its episode and carries on in the next scan.
// PROGRESS PERSISTS, per chunk of payers: where each history job had got to
// (its next block, the width it had learned, and the transfers it had read
// below that block) is kept with the wallet, so the next attempt resumes there
// and a chunk read in full is not read again. A wallet that waited resumes a
// read that had been answered at twice the width it had reached (a narrowing
// from a passing refusal heals), and a read refused at every width it tried at
// the next width it had not tried - first, before any other read of that
// wallet, none of which is taken until that one is answered. New payers are
// read at the configured width, whatever another read of the wallet learned.
// A wallet whose remaining reads need more calls than one scan's budget is not
// started, and waits. A history too dense to hold between scans (more than
// `maxPartialLogsPerWallet` transfers kept for it) loses its progress, and is
// not read again while the payers holding most of it are still new to it.
// RESIDUAL: such a history, or one refused at every width a scan can afford, is
// not read (see sellerFundingFigures for how such a wallet is counted).
// A wallet whose history reads did not complete this scan, or whose pools
// start before the window and whose gap before it was not read
// (readFundingGaps), is not advanced: it is "behind". What is known still nets it, what is not is unknown, and a circular
// wallet behind is credited nothing.
//
// The state also keeps what the router needs to net THIRD-PARTY counts of the
// same wallet (src/evidence-binding.js): per known payer the last position it
// paid with its own money and the last it paid with the wallet's, and per day
// how many payments were netted, over the Bazaar's 30-day window.
// Those counts cover 30 days and a scan window 7, and a payment is netted once
// a scan's window has seen its payer, so the 30-day counts fill in over the
// first 30 days a wallet is read (when this state starts, or after it was
// dropped). A funded payer that pays inside a window has its earlier payments
// read with its history and netted.
/** A setting that is a whole number of at least 0, else `fallback`. */
function nonNegativeInt(raw, fallback) {
  const n = parseInt(raw ?? "", 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
export const FUNDING_DEFAULTS = {
  maxCalls: parseInt(process.env.LEADERBOARD_FUNDING_MAX_CALLS || "400", 10),
  minRangeBlocks: 1000,
  // The widest block range one history read asks for. Unbounded by default:
  // a targeted read's answer is tiny whatever the range, and a refusal splits
  // it. A provider that times out on very wide ranges can be given a bound.
  historyChunkBlocks: parseInt(process.env.FUNDING_HISTORY_CHUNK_BLOCKS || "0", 10) > 0 ? parseInt(process.env.FUNDING_HISTORY_CHUNK_BLOCKS, 10) : Infinity,
  walletChunk: 200,
  payerChunk: 200,
  // Calls one wallet may spend on history and gap reads, across scans until
  // its reads complete, beyond the ones they were planned to take (splits
  // after refusals; 0: only the planned ones), and how long a wallet whose
  // reads went past that, were refused over the narrowest range, or were cut
  // short when a budget ran out, waits before it is read again: a day, then
  // twice as long each time it has to wait again, up to the maximum.
  walletMaxCalls: nonNegativeInt(process.env.LEADERBOARD_FUNDING_WALLET_MAX_CALLS, 32),
  retryBackoffMs: 86_400_000,
  maxRetryBackoffMs: 7 * 86_400_000,
  // History and gap calls in any rolling day, across scans.
  dayMaxCalls: nonNegativeInt(process.env.LEADERBOARD_FUNDING_DAY_MAX_CALLS, 1600),
  dayMs: 86_400_000,
  // Transfers kept for unfinished history reads (their progress), per wallet
  // and in total. Past either, that wallet's progress is dropped and it waits;
  // past its own cap it is also marked too dense to hold (see capProgress).
  maxPartialLogsPerWallet: 50_000,
  maxPartialLogsTotal: 200_000,
  // A wallet whose untargeted outbound read had to be isolated is read
  // targeted at its known payers for this long before the split is re-learned.
  outboundHeavyMs: 7 * 86_400_000,
  // A wallet that sent at least this many transfers in an answered outbound
  // read split out of a refused one is marked the same way: packed with
  // others it is what made them too large, even when it fits on its own.
  outboundBusyLogs: 1_000,
  // Pools kept per wallet and in total. Only a known payer ever has one; past
  // a cap, dust pools of payers not paying this scan make way first, and a
  // wallet that still cannot record one is flagged truncated.
  maxPairsPerWallet: 20_000,
  maxPairsTotal: 300_000,
  // Known payers per wallet: past it, the idlest ones with no pool are
  // forgotten first (they are read again if they pay again).
  maxKnownPerWallet: 100_000,
  // ...and across every wallet: listings can name any busy wallet, so the
  // total is bounded too (the idlest go first, across wallets).
  maxKnownTotal: 600_000,
  // Funded payments remembered per wallet (the window's netted payments).
  maxRecordsPerWallet: 100_000,
  // How long a wallet stays "circular" for the Bazaar's sake after the last
  // scan that found it so: the Bazaar counts a 30-day window.
  circularWindowMs: 30 * 86_400_000,
  // The same 30 days in Base blocks at 2 s each: the window the netted counts
  // that third-party figures are reduced by cover. The leaderboard scan
  // replaces this and the two TTLs below with counts read from block
  // timestamps (fundingWindowBlocks in src/leaderboard.js), so they stay 30
  // and 45 days when the block time changes; these are the floors it keeps.
  bazaarWindowBlocks: 1_296_000,
  // The netted-count bucket: a fixed block granularity (a day at 2 s). It keys
  // persisted state, so it stays fixed; only the windows above are measured.
  bucketBlocks: 43_200,
  // A known payer with no pool, no credit and no payment for this many blocks
  // is forgotten (45 days: longer than the 30-day count, so no payer inside it
  // is ever lost).
  knownTtlBlocks: 1_944_000,
  // A wallet's state with nothing left to remember (no pool, no verdict) is
  // dropped once it has not been scanned for this long.
  walletTtlMs: 45 * 86_400_000,
  // A payer's credit (see THE RULE) with no activity for this many blocks is
  // forgotten (about 30 days of Base blocks).
  creditTtlBlocks: 1_296_000,
  // A payment is netted as a call when at least this share of it was covered.
  coveredShareToNet: 0.5,
};

// The first block a payer's history read covers, per token: the token
// contract's deployment block (Base USDC, measured with eth_getCode). An
// unlisted token reads from block 0, which is correct and only wider.
// FUNDING_HISTORY_FROM_BLOCK overrides it.
export const TOKEN_HISTORY_FROM = Object.freeze({ "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 2_797_221 });
export function historyFromBlockFor(token) {
  const env = parseInt(process.env.FUNDING_HISTORY_FROM_BLOCK || "", 10);
  if (Number.isSafeInteger(env) && env >= 0) return env;
  return TOKEN_HISTORY_FROM[String(token || "").toLowerCase()] ?? 0;
}

export const ZERO_ADDRESS = "0x" + "0".repeat(40);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EVM = /^0x[0-9a-f]{40}$/;
const lower = (a) => String(a || "").toLowerCase();
const pad = (a) => "0x" + "0".repeat(24) + String(a).replace(/^0x/, "");
const addrFromTopic = (t) => (typeof t === "string" && t.length >= 42 ? ("0x" + t.slice(-40)).toLowerCase() : null);
/** A log's position on the chain, orderable: block, then log index. */
export const posOf = (block, logIndex) => Number(block) * 1_000_000 + Number(logIndex);
/** The last position inside a block. */
export const endOfBlock = (block) => posOf(block, 999_999);

/** Neither the zero address (mints and burns) nor the token contract is a
 *  seller's wallet: never a scanned payTo, never a funding source. */
export function isScannableWallet(wallet, token) {
  const w = lower(wallet);
  return EVM.test(w) && w !== ZERO_ADDRESS && w !== lower(token);
}

// --- state ---------------------------------------------------------------------

/** Empty funding state for one token. */
export function createFundingState(token) {
  // `day`: [time, calls] per pass, the history and gap calls of the last day.
  return { v: 2, token: lower(token), wallets: new Map(), day: [] };
}
function newWalletState(windowStartBlock, now) {
  // `cursor`: the last block whose outbound transfers to KNOWN payers are
  // read (inclusive). `through`: the chain position up to which each pool has
  // been worked through against the payments the scan counted. `known`: payer
  // -> [addedAt, lastOwnMoneyPos, lastSellerMoneyPos, preWindowEnd] (positions,
  // -1 for never; preWindowEnd is the last block before the window when it
  // became known), and optionally a fifth: the payer's REFUNDABLE payments,
  // flat [position, amount, unrefunded, ...] oldest first (its counted
  // payments made with its own money, newest REFUNDABLE_MAX; absent when
  // none, so a state written before it existed reads as none).
  // `refunded`: day bucket -> payments removed as refunded.
  // `netted`: day bucket -> payments netted.
  // `retryAt`: a wallet whose history or gap reads went past its share waits
  // until then (ms) before they are tried again. The read accounting (see ONE
  // WALLET CANNOT SPEND THE READS): `ep` the current episode { pl planned, sp
  // spent, t last charged }, `st` how many times it has had to wait since its
  // reads last completed, `hp` the progress of its unfinished reads (segments,
  // see newSegment), and `td` the payers whose transfers were too many to hold
  // (see capProgress). `oh`: when its untargeted outbound read last had to be
  // isolated (ms; see readSellerFunding).
  const s = Math.max(0, windowStartBlock);
  return { cursor: s - 1, through: posOf(s, 0) - 1, since: s, truncated: false, lastSeenAt: now, lastCircularAt: null, retryAt: 0, ep: null, st: 0, hp: [], td: null, oh: 0, pairs: new Map(), known: new Map(), netted: new Map(), refunded: new Map() };
}
// A read's progress, kept between scans: kind `k` ("o" the wallet's transfers
// to new payers, "i" those payers' transfers to it before the window, "c" a
// known payer's transfers to it before it became known, "g" the gap before the
// window), `h` the fixed end block of a "c" read (or the start block of a "g"
// one; -1 otherwise), `p` its payers, `lo` the next block to read, `w` the
// width it had learned (0: none), `l` the transfers read below `lo`, flat
// [payer index, position, value, ...], `pg`: 2 when it had been read in full
// up to `lo`, 1 when the attempt that saved it got further (or never got a
// turn), 0 when it was refused, read on its own wallet, at every width it
// tried; and `g`: a group (0: none). Reads left unread in one job after the
// job they were packed in was refused and split share a group, so the next
// scan packs them together again and carries on splitting that job where it
// stopped, instead of packing them afresh (see pairsReader).
function newSegment(k, h, p, lo, w, logs, pg = 1, g = 0) {
  const idx = new Map(p.map((x, i) => [x, i]));
  const l = [];
  for (const [payer, list] of logs || []) { const i = idx.get(payer); if (i === undefined) continue; for (const [pos, v] of list) l.push(i, pos, v); }
  return { k, h, p, lo, w: Number.isFinite(w) && w > 0 ? w : 0, l, pg: pg === 2 ? 2 : pg ? 1 : 0, g: Number.isSafeInteger(g) && g > 0 ? g : 0 };
}
/** Whether a saved segment shows its wallet is heavy: its read was refused on
 *  its own wallet, or stopped part-way through its range. A read that never
 *  got a turn, that only rode in a packed job that was refused, or that was
 *  read in full, shows nothing of the kind (`start`: where that read starts). */
const segmentShowsHeavy = (g, start) => g.pg === 0 || (g.pg === 1 && g.lo > start);
/** A segment's transfers as Map(payer -> [[position, value]]), in order. */
function segmentLogs(seg) {
  const m = new Map();
  for (let i = 0; i + 2 < seg.l.length; i += 3) {
    const p = seg.p[seg.l[i]];
    if (!p) continue;
    if (!m.has(p)) m.set(p, []);
    m.get(p).push([seg.l[i + 1], seg.l[i + 2]]);
  }
  for (const list of m.values()) list.sort((a, b) => a[0] - b[0]);
  return m;
}
const segmentLogCount = (ws) => (ws.hp || []).reduce((n, g) => n + g.l.length / 3, 0);
/** Transfers held by unfinished reads, in the whole state. */
export function fundingPartialLogCount(state) {
  let n = 0;
  for (const ws of state?.wallets?.values?.() || []) n += segmentLogCount(ws);
  return n;
}
// `h`: 1 once the payer's transfers to the wallet before it became known are
// accounted for (its credit); a pool is never worked without it.
// `rf`: [payment position, micro refunded] for the payer's refunded payments.
function newPair(h = 0) { return { pool: 0, credit: 0, at: 0, recs: [], pend: [], h, rf: [] }; }
// Refundable payments kept per payer (see the rule above).
export const REFUNDABLE_MAX = 16;
// Below this a pool is dust (token units: $0.01 of USDC).
const DUST_UNITS = 10_000;
// Payers kept per wallet marked too dense to hold (see capProgress).
const MAX_DENSE_PAYERS = 64;
/** Drop the wallet's pools that hold less than DUST_UNITS, net nothing yet,
 *  and belong to no current payer. Returns how many were dropped. */
function dropDustPairs(ws, payers) {
  let n = 0;
  for (const [p, pair] of ws.pairs) {
    if (payers?.has(p) || pair.recs.length || pair.rf?.length || pair.credit > 0) continue;
    const held = pair.pool + pair.pend.reduce((a, [, v]) => a + v, 0);
    if (held < DUST_UNITS) { ws.pairs.delete(p); n++; }
  }
  return n;
}
export function fundingPairCount(state) {
  let n = 0;
  for (const ws of state?.wallets?.values?.() || []) n += ws.pairs.size;
  return n;
}
export function fundingKnownCount(state) {
  let n = 0;
  for (const ws of state?.wallets?.values?.() || []) n += ws.known.size;
  return n;
}

/** Plain JSON for the volume. Compact: flat number lists per pair. */
export function serializeFundingState(state, { now = Date.now() } = {}) {
  const wallets = {};
  for (const [w, ws] of state.wallets) {
    const p = {}, k = {}, b = {};
    const rb = {};
    for (const [payer, pair] of ws.pairs) p[payer] = [pair.pool, pair.recs.flat(), pair.pend.flat(), pair.credit, pair.at, pair.h ? 1 : 0, ...(pair.rf?.length ? [pair.rf.flat()] : [])];
    for (const [payer, e] of ws.known) k[payer] = Array.isArray(e[4]) && e[4].length ? e : e.slice(0, 4);
    for (const [day, n] of ws.netted) b[day] = n;
    for (const [day, n] of ws.refunded || []) rb[day] = n;
    wallets[w] = {
      c: ws.cursor, t: ws.through, s: ws.since, x: ws.truncated ? 1 : 0, seen: ws.lastSeenAt, lc: ws.lastCircularAt || null,
      ...(ws.retryAt > 0 ? { ra: ws.retryAt } : {}),
      ...(ws.ep ? { ep: [ws.ep.pl, ws.ep.sp, ws.ep.t] } : {}),
      ...(ws.st > 0 ? { st: ws.st } : {}),
      ...(ws.hp?.length ? { hp: ws.hp.map((g) => [g.k, g.h, g.p, g.lo, g.w, g.l, g.pg, ...(g.g ? [g.g] : [])]) } : {}),
      ...(ws.td?.length ? { td: ws.td } : {}),
      ...(ws.oh > 0 ? { oh: ws.oh } : {}),
      p, k, b,
      ...(Object.keys(rb).length ? { rb } : {}),
    };
  }
  return JSON.stringify({ v: 2, token: state.token, savedAt: new Date(now).toISOString(), wallets, d: (state.day || []).map(([t, n]) => [t, n]) });
}
const int = (x) => (Number.isSafeInteger(x) ? x : null);
function triples(flat, n) {
  const out = [];
  if (!Array.isArray(flat) || flat.length % n) return out;
  for (let i = 0; i < flat.length; i += n) {
    const t = flat.slice(i, i + n);
    if (t.every((x) => int(x) !== null && x >= 0)) out.push(t);
  }
  return out;
}
/** Parse what serializeFundingState wrote. A state for another token, of
 *  another version, or unreadable, yields an empty state (every payer is read
 *  from its history again). */
export function parseFundingState(text, token) {
  const state = createFundingState(token);
  let j;
  try { j = JSON.parse(text); } catch { return state; }
  if (!j || j.v !== 2 || lower(j.token) !== state.token || typeof j.wallets !== "object" || !j.wallets) return state;
  for (const [w0, e] of Object.entries(j.wallets)) {
    const w = lower(w0);
    if (!isScannableWallet(w, token) || !e || typeof e !== "object") continue;
    if (int(e.c) === null || int(e.t) === null || int(e.s) === null) continue;
    const ep = Array.isArray(e.ep) && e.ep.length === 3 && e.ep.every((x) => int(x) !== null && x >= 0) ? { pl: e.ep[0], sp: e.ep[1], t: e.ep[2] } : null;
    const hp = [];
    for (const g of Array.isArray(e.hp) ? e.hp : []) {
      if (!Array.isArray(g) || g.length < 6 || g.length > 8) continue;
      const [k, h, p, lo, wd, l, pg = 1, gr = 0] = g;
      if (!["o", "i", "c", "g"].includes(k) || int(h) === null || h < -1 || int(lo) === null || lo < 0 || int(wd) === null || wd < 0 || !Array.isArray(p) || !Array.isArray(l) || l.length % 3) continue;
      const payers = p.map(lower);
      if (!payers.length || !payers.every((x) => EVM.test(x))) continue;
      if (!l.every((x, i) => int(x) !== null && x >= 0 && (i % 3 || x < payers.length))) continue;
      hp.push({ k, h, p: payers, lo, w: wd, l: l.slice(), pg: pg === 0 ? 0 : pg === 2 ? 2 : 1, g: int(gr) !== null && gr > 0 ? gr : 0 });
    }
    const td = Array.isArray(e.td) ? [...new Set(e.td.map(lower))].filter((x) => EVM.test(x)).slice(0, MAX_DENSE_PAYERS) : [];
    const ws = { cursor: e.c, through: e.t, since: e.s, truncated: e.x === 1, lastSeenAt: Number(e.seen) || 0, lastCircularAt: typeof e.lc === "string" ? e.lc : null, retryAt: int(e.ra) !== null && e.ra > 0 ? e.ra : 0, ep, st: int(e.st) !== null && e.st > 0 ? e.st : 0, hp, td: td.length ? td : null, oh: int(e.oh) !== null && e.oh > 0 ? e.oh : 0, pairs: new Map(), known: new Map(), netted: new Map(), refunded: new Map() };
    for (const [p0, v] of Object.entries(e.k || {})) {
      const p = lower(p0);
      if (!EVM.test(p) || !Array.isArray(v) || (v.length !== 4 && v.length !== 5) || !v.slice(0, 4).every((x) => int(x) !== null && x >= -1)) continue;
      const k = v.slice(0, 4);
      // Refundable payments; anything else in the fifth place reads as none.
      const rf = v.length === 5 ? triples(v[4], 3).slice(-REFUNDABLE_MAX) : [];
      if (rf.length) k.push(rf.flat());
      ws.known.set(p, k);
    }
    for (const [p0, v] of Object.entries(e.p || {})) {
      const p = lower(p0);
      if (!EVM.test(p) || !Array.isArray(v) || int(v[0]) === null || v[0] < 0) continue;
      ws.pairs.set(p, { pool: v[0], recs: triples(v[1], 3), pend: triples(v[2], 2), credit: int(v[3]) !== null && v[3] >= 0 ? v[3] : 0, at: int(v[4]) !== null && v[4] >= 0 ? v[4] : 0, h: v[5] === 1 ? 1 : 0, rf: triples(v[6], 2) });
      // A pool always belongs to a known payer.
      if (!ws.known.has(p)) ws.known.set(p, [0, -1, -1, -1]);
    }
    for (const [d, n] of Object.entries(e.b || {})) if (int(Number(d)) !== null && int(n) !== null && n > 0) ws.netted.set(Number(d), n);
    for (const [d, n] of Object.entries(e.rb || {})) if (int(Number(d)) !== null && int(n) !== null && n > 0) ws.refunded.set(Number(d), n);
    state.wallets.set(w, ws);
  }
  for (const x of Array.isArray(j.d) ? j.d : []) if (Array.isArray(x) && x.length === 2 && int(x[0]) !== null && int(x[1]) !== null && x[1] >= 0) state.day.push([x[0], x[1]]);
  return state;
}

/** Drop what nothing needs any more (and keep the progress of unfinished
 *  reads within its caps, see capProgress): a payer's credit idle for
 *  `creditTtlBlocks` (when nothing else is left in its pair), a known payer
 *  with no pool idle for `knownTtlBlocks`, netted-count days older than the
 *  30-day window, and a wallet not scanned for `walletTtlMs` with no pool left
 *  and no verdict inside the circular window. */
export function pruneFundingState(state, { now = Date.now(), latest = null, walletTtlMs = FUNDING_DEFAULTS.walletTtlMs, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, creditTtlBlocks = FUNDING_DEFAULTS.creditTtlBlocks, knownTtlBlocks = FUNDING_DEFAULTS.knownTtlBlocks, bazaarWindowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks, maxPartialLogsPerWallet = FUNDING_DEFAULTS.maxPartialLogsPerWallet, maxPartialLogsTotal = FUNDING_DEFAULTS.maxPartialLogsTotal, counts = null } = {}) {
  let dropped = 0;
  if (Number.isFinite(latest)) {
    const cutoff = posOf(latest - creditTtlBlocks, 0);
    const knownCut = posOf(latest - knownTtlBlocks, 0);
    const dayCut = Math.floor((latest - bazaarWindowBlocks) / bucketBlocks) - 1;
    for (const ws of state.wallets.values()) {
      for (const [p, pair] of ws.pairs) {
        if (pair.pool <= 0 && !pair.recs.length && !pair.rf?.length && !pair.pend.length && pair.at < cutoff) ws.pairs.delete(p);
      }
      for (const [p, k] of ws.known) if (!ws.pairs.has(p) && Math.max(k[0], k[1], k[2]) < knownCut) ws.known.delete(p);
      for (const d of ws.netted.keys()) if (d < dayCut) ws.netted.delete(d);
      for (const d of ws.refunded?.keys?.() || []) if (d < dayCut) ws.refunded.delete(d);
    }
  }
  for (const [w, ws] of state.wallets) {
    if (now - (ws.lastSeenAt || 0) < walletTtlMs) continue;
    const verdict = ws.lastCircularAt && now - Date.parse(ws.lastCircularAt) < circularWindowMs;
    const pooled = [...ws.pairs.values()].some((p) => p.pool > 0 || p.pend.length || p.credit > 0);
    if (!verdict && !pooled) { state.wallets.delete(w); dropped++; }
  }
  // The progress of unfinished reads stays within its caps, and the day's
  // record holds the last day only.
  const progressDropped = capProgress(state, now, { maxPartialLogsPerWallet, maxPartialLogsTotal });
  fundingDayCalls(state, now);
  if (counts) counts.progressDropped = progressDropped;
  return dropped;
}

// --- the incremental read --------------------------------------------------------

const TOO_MANY = /response size|more than [\d,]+ (?:results|logs)|too many (?:results|logs)|returned more than|(?:results|logs) exceed|exceed(?:s|ed)? (?:the )?(?:max(?:imum)? )?(?:[\d,]+ )?(?:results|logs)|log response|query returned/i;
const UNREACHABLE = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|non-JSON \(5\d\d\)/i;
const TIMEOUT = /timed? ?out|TimeoutError|ETIMEDOUT|aborted/i;
// The provider is throttling us: more requests only make it worse.
const RATE_LIMITED = /"code":\s*429\b|\b429\b|rate[- ]?limit|too many requests|compute units per second|exceeded (?:its|your) (?:compute|request|throughput)/i;
// The provider limits the block RANGE of eth_getLogs, whatever the answer's
// size ("eth_getLogs is limited to a 2,000 range", "block range too large",
// "exceeds the maximum block range"). Checked after TOO_MANY: a size refusal
// that also names a range it would accept is about THIS job, not the RPC.
const RANGE_LIMITED = /limited to a [\d,]+(?: blocks?)? range|block range (?:is )?too (?:large|wide|big)|range (?:is )?too (?:large|wide)|exceed(?:s|ed)? (?:the )?max(?:imum)? (?:block )?range|max(?:imum)? block range|maximum is set to|too many blocks|up to a [\d,.]+k? block range/i;
/** The range limit a RANGE_LIMITED answer states, or null. */
function statedRangeLimit(msg) {
  const m = /limited to a ([\d,]+)|max(?:imum)?(?: block)? range(?: is| of)?:? ([\d,]+)|maximum is set to ([\d,]+)/i.exec(msg);
  const n = m ? parseInt(String(m[1] || m[2] || m[3]).replace(/,/g, ""), 10) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
// A timed-out read may simply be too large to answer in time, so it is split
// like a refusal - but only this many times in one scan (shared by every pass,
// see newFundingReadControl), so an RPC that hangs on everything costs a few
// timeouts, not the budget.
const MAX_TIMEOUTS_PER_READ = 3;
// An error that names no known cause (an RPC's "Internal error") is split like
// a refusal only this many times in a row across the scan's reads; past that
// the read stops for the scan. Splitting on every such answer spent the whole
// allowance on refused calls when an RPC failed every read that way.
const MAX_UNKNOWN_ERRORS = 3;
/** How to answer a failed read: split the job (refused, too large, or one
 *  slow read), stop the read for the scan ("stop": keeps timing out; "rate":
 *  throttled; "errors": keeps failing for no stated reason), retry once then
 *  stop ("unreachable"), or "range" (the RPC limits the block range: narrow
 *  it, or stop a whole-history read). Counts the scan's timeouts and its
 *  unexplained errors in `ctl`. */
function failureKind(msg, ctl) {
  if (TOO_MANY.test(msg)) return "split";
  if (RATE_LIMITED.test(msg)) return "rate";
  if (RANGE_LIMITED.test(msg)) return "range";
  if (TIMEOUT.test(msg)) return ctl.timeouts++ < MAX_TIMEOUTS_PER_READ ? "split" : "stop";
  if (UNREACHABLE.test(msg)) return "unreachable";
  return ctl.unknown++ < MAX_UNKNOWN_ERRORS ? "split" : "errors";
}
/** The scan's reason to stop, for a failure kind that is not a split. */
const stopReason = (kind) => ({ range: "range-limited", rate: "rate-limited", stop: "timeouts", errors: "errors" })[kind] || "unreachable";
/** Yield to the event loop every so many steps: a run of splits and drops
 *  never waits on the RPC, and each step orders the whole queue. */
const YIELD_EVERY = 32;
const yieldNow = () => new Promise((r) => setImmediate(r));
/**
 * What the reads of ONE scan share: the timeouts and the transport retry are
 * counted once for the scan (not once per pass), a reason the read stopped
 * ends every later pass without a call, and each wallet's calls (`spent`) and
 * planned calls (`allow`) on history and gap reads are kept across passes, so
 * its share of the scan is one share. runLeaderboard makes one per scan.
 */
export function newFundingReadControl() {
  // `dayLeft`: history and gap calls the rolling day still allows (set by the
  // first pass that reads, from the state); `stopped`: wallets a pass of this
  // scan made wait (a later pass skips them without counting them again);
  // `waitingSeen`: wallets already counted as waiting this scan.
  // `unknown`: unexplained errors in a row (an answered read resets it).
  // `groups`: groups handed out this scan (see newSegment's `g`).
  return { timeouts: 0, unknown: 0, transportRetried: false, stop: null, dayLeft: null, dayCapped: false, stopped: new Set(), waitingSeen: new Set(), groups: 0 };
}
/** A group id for reads left unread in one split job: the scan's second, then
 *  a counter (unique across scans an hour or more apart). */
const nextGroup = (ctl, now) => Math.floor(now / 1000) * 1_000_000 + (++ctl.groups % 1_000_000);
/** History and gap calls recorded in the rolling day ending `now` (older
 *  records are dropped). */
export function fundingDayCalls(state, now = Date.now(), { dayMs = FUNDING_DEFAULTS.dayMs } = {}) {
  if (!Array.isArray(state?.day)) return 0;
  state.day = state.day.filter(([t]) => now - t < dayMs);
  return state.day.reduce((n, [, c]) => n + c, 0);
}
function openDay(ctl, state, now, dayMaxCalls) {
  if (ctl.dayLeft === null || ctl.dayLeft === undefined) ctl.dayLeft = Math.max(0, dayMaxCalls - fundingDayCalls(state, now));
}
function noteDay(state, now, calls) {
  if (!state || !(calls > 0)) return;
  if (!Array.isArray(state.day)) state.day = [];
  state.day.push([now, calls]);
}
/** A transfer log's value in token units, or null (zero, unreadable, or past
 *  the safe-integer range). Zero-value logs are free to forge (a zero
 *  transferFrom needs no allowance): never funding, never a payment. */
function valueOf(l) {
  let v;
  try { v = BigInt(l?.data || "0x0"); } catch { return null; }
  return v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}
function posOfLog(l) {
  const block = parseInt(l?.blockNumber, 16), idx = parseInt(l?.logIndex, 16);
  return Number.isFinite(block) && Number.isFinite(idx) ? posOf(block, idx) : null;
}

/**
 * Read the non-zero transfers each wallet sent its KNOWN payers since its
 * cursor, into `state` (mutated). `wallets` is [{ wallet, payers: Set }] in
 * the order to read them (highest priority first); `payers` are this scan's
 * payers (their dust pools are never dropped to make room). A wallet with no
 * state starts at the window; a wallet with no known payer has nothing to read
 * and its cursor moves to `latest` (its payers' history is read by
 * readPayerHistory, which then covers up to that cursor).
 *
 * Wallets are read 200 to a call, untargeted (every transfer they sent), and
 * only transfers to known payers are recorded. A wallet that sends so much to
 * others that such a read is refused even when it reads alone - or that sent
 * `outboundBusyLogs` or more in an answered read split out of a refused one,
 * where it fits alone but not packed with others like it - is marked (`oh`,
 * kept with its state and re-learned after `outboundHeavyMs`), so the next
 * scans do not spend the calls that isolate it again every hour: one with few
 * known payers is read TARGETED at them (exactly what is recorded anyway),
 * packed with other such wallets; one with many is read alone, its range
 * split as it needs.
 *
 * @returns counts only: { calls, refusals, wallets, caughtUp, behind, stuck,
 *   truncated, fresh, targeted, events, budgetExhausted, transportError }
 */
export async function readSellerFunding({ rpc, token, state, wallets = [], latest, windowStartBlock, walletChunk = FUNDING_DEFAULTS.walletChunk, payerChunk = FUNDING_DEFAULTS.payerChunk, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, maxPairsTotal = FUNDING_DEFAULTS.maxPairsTotal, outboundHeavyMs = FUNDING_DEFAULTS.outboundHeavyMs, outboundBusyLogs = FUNDING_DEFAULTS.outboundBusyLogs, ignore = new Set(), now = Date.now(), onProgress = () => {}, ctl = newFundingReadControl() } = {}) {
  const tok = lower(token);
  // `marked`: wallets marked this scan as needing an outbound read of their own.
  const stats = { calls: 0, refusals: 0, wallets: 0, caughtUp: 0, behind: 0, stuck: 0, truncated: 0, fresh: 0, targeted: 0, marked: 0, events: 0, budgetExhausted: false, transportError: null };
  // Wallets that were in a refused untargeted read with other wallets.
  const inRefusedPack = new Set();
  const payersOf = new Map();
  const order = [];
  for (const e of wallets) {
    const w = lower(e?.wallet);
    if (!isScannableWallet(w, tok) || payersOf.has(w)) continue;
    let ws = state.wallets.get(w);
    if (!ws) { ws = newWalletState(windowStartBlock, now); state.wallets.set(w, ws); stats.fresh++; }
    ws.lastSeenAt = now;
    payersOf.set(w, e.payers instanceof Set ? new Set([...e.payers].map(lower)) : new Set((e.payers || []).map(lower)));
    order.push(w);
  }
  stats.wallets = order.length;
  let totalPairs = fundingPairCount(state);
  const stuck = new Set();
  const knownOf = (w) => [...state.wallets.get(w).known.keys()];
  const heavyNow = (ws) => ws.oh > 0 && now - ws.oh < outboundHeavyMs;
  // Jobs by start block, keeping the priority order (in steady state every
  // wallet starts at the same block: one job per 200 wallets). Wallets known
  // to need a targeted read are grouped apart.
  // Targeted costs one call per `payerChunk` known payers: worth it for a
  // wallet with few of them.
  const fewKnown = (w) => state.wallets.get(w).known.size <= 2 * payerChunk;
  const groups = new Map(), heavy = new Map(), alone = [];
  for (const w of order) {
    const ws = state.wallets.get(w);
    // Nothing is recorded for a wallet with no known payer: no read needed.
    if (!ws.known.size) { ws.cursor = Math.max(ws.cursor, latest); continue; }
    const start = ws.cursor + 1;
    if (start > latest) continue;
    if (heavyNow(ws) && !fewKnown(w)) { alone.push(w); continue; }
    const g = heavyNow(ws) ? heavy : groups;
    if (!g.has(start)) g.set(start, []);
    g.get(start).push(w);
  }
  // A targeted job: its wallets, and the union of their known payers.
  const targeted = (froms, lo, hi, lineage) => ({ froms, lo, hi, tos: [...new Set(froms.flatMap(knownOf))], lineage });
  /** Pack wallets read targeted: up to walletChunk wallets and payerChunk
   *  payers per job (a wallet with more known payers than that reads alone). */
  const packTargeted = (ws, lo, hi) => {
    const jobs = [];
    let cur = null, n = 0;
    for (const w of ws) {
      const k = state.wallets.get(w).known.size;
      if (!cur || cur.length >= walletChunk || n + k > payerChunk) { cur = []; n = 0; jobs.push(cur); }
      cur.push(w); n += k;
    }
    return jobs.map((f) => targeted(f, lo, hi, { limit: Infinity }));
  };
  // Each job carries its LINEAGE: the widest block range known to work for it.
  // A refusal narrows its own lineage only (the halves share it, so a sibling
  // range is pre-split without spending a call); a wallet-list split hands
  // each half a copy, and no other job's range ever narrows.
  const queue = [];
  for (const [start, ws] of groups) for (let i = 0; i < ws.length; i += walletChunk) queue.push({ froms: ws.slice(i, i + walletChunk), lo: start, hi: latest, tos: null, lineage: { limit: Infinity } });
  for (const [start, ws] of heavy) { stats.targeted += ws.length; queue.push(...packTargeted(ws, start, latest)); }
  for (const w of alone) queue.push({ froms: [w], lo: state.wallets.get(w).cursor + 1, hi: latest, tos: null, lineage: { limit: Infinity } });

  const record = (logs, froms) => {
    const fromSet = new Set(froms);
    for (const l of Array.isArray(logs) ? logs : []) {
      const from = addrFromTopic(l?.topics?.[1]);
      const to = addrFromTopic(l?.topics?.[2]);
      if (!from || !to || !fromSet.has(from)) continue;
      const value = valueOf(l);
      if (value === null) continue;
      if (to === from || !isScannableWallet(to, tok) || ignore.has(to)) continue;
      const ws = state.wallets.get(from);
      // Only a KNOWN payer's funding is recorded: a recipient that has never
      // paid has its whole history read if it ever does (readPayerHistory).
      if (!ws.known.has(to)) continue;
      const pos = posOfLog(l);
      if (pos === null) continue;
      let pair = ws.pairs.get(to);
      if (!pair) {
        // Past a cap, a payer paying this scan is still recorded (it is what
        // the rule is for); for any other, dust pools make way first.
        const full = () => ws.pairs.size >= maxPairsPerWallet || totalPairs >= maxPairsTotal;
        if (full() && !payersOf.get(from)?.has(to)) {
          totalPairs -= dropDustPairs(ws, payersOf.get(from));
          if (full()) { ws.truncated = true; continue; }
        }
        pair = newPair(0);
        ws.pairs.set(to, pair);
        totalPairs++;
      }
      pair.pend.push([pos, value]);
      stats.events++;
    }
  };
  const filter = (froms, tos, lo, hi) => ({
    fromBlock: "0x" + Math.max(0, lo).toString(16),
    toBlock: "0x" + hi.toString(16),
    address: tok,
    topics: [TRANSFER, froms.map(pad), tos ? tos.map(pad) : null],
  });
  const BUDGET = Symbol("budget");

  let steps = 0;
  while (queue.length && !ctl.stop) {
    if (++steps % YIELD_EVERY === 0) await yieldNow();
    const job = queue.shift();
    // Contiguity: a wallet reads a range only right after its cursor; one
    // whose earlier range failed this scan (stuck) sits out the rest.
    const froms = job.froms.filter((w) => !stuck.has(w) && state.wallets.get(w).cursor + 1 === job.lo);
    if (!froms.length) continue;
    if (job.hi - job.lo + 1 > job.lineage.limit) {
      const mid = job.lo + Math.floor((job.hi - job.lo) / 2);
      const half = (lo, hi) => (job.tos ? targeted(froms, lo, hi, job.lineage) : { ...job, froms, lo, hi });
      queue.unshift(half(job.lo, mid), half(mid + 1, job.hi));
      continue;
    }
    if (stats.calls >= maxCalls) { stats.budgetExhausted = true; break; }
    let logs = [];
    try {
      if (job.tos) {
        for (let i = 0; i < job.tos.length; i += payerChunk) {
          if (stats.calls >= maxCalls) throw BUDGET;
          stats.calls++;
          const part = await rpc("eth_getLogs", [filter(froms, job.tos.slice(i, i + payerChunk), job.lo, job.hi)]);
          if (Array.isArray(part)) logs.push(...part);
        }
      } else {
        stats.calls++;
        logs = await rpc("eth_getLogs", [filter(froms, null, job.lo, job.hi)]);
      }
    } catch (e) {
      if (e === BUDGET) { stats.budgetExhausted = true; break; }
      const msg = String(e?.message || e);
      // A range limit is answered here by narrowing the range: the ranges
      // this read asks for are the blocks since each cursor, not a history.
      const kind0 = failureKind(msg, ctl);
      const kind = kind0 === "range" ? "split" : kind0;
      if (kind !== "split") {
        // The RPC is not answering, or is throttling us: retry an unreachable
        // one once, then stop the read for this scan (cursors stay; the next
        // scan carries on).
        if (kind === "unreachable" && !ctl.transportRetried) { ctl.transportRetried = true; queue.unshift({ ...job, froms }); continue; }
        ctl.stop = stopReason(kind);
        stats.transportError = msg.slice(0, 160);
        onProgress(`      funding read stopped (${ctl.stop}): ${stats.transportError}`);
        break;
      }
      stats.refusals++;
      const span = job.hi - job.lo + 1;
      if (job.tos) {
        // A targeted read refused: fewer wallets, then a narrower range; one
        // wallet refused over the narrowest range sits out this scan.
        if (froms.length > 1) { const mid = Math.ceil(froms.length / 2); queue.unshift(targeted(froms.slice(0, mid), job.lo, job.hi, { ...job.lineage }), targeted(froms.slice(mid), job.lo, job.hi, { ...job.lineage })); continue; }
        if (span > minRangeBlocks) { job.lineage.limit = Math.min(job.lineage.limit, span - 1); const mid = job.lo + Math.floor((job.hi - job.lo) / 2); queue.unshift(targeted(froms, job.lo, mid, job.lineage), targeted(froms, mid + 1, job.hi, job.lineage)); continue; }
        stuck.add(froms[0]);
        onProgress(`      funding read gave up on one wallet at blocks ${job.lo}-${job.hi}: ${msg.slice(0, 120)}`);
        continue;
      }
      if (froms.length > 1) for (const w of froms) inRefusedPack.add(w);
      const splitFroms = () => { const mid = Math.ceil(froms.length / 2); queue.unshift({ ...job, froms: froms.slice(0, mid), lineage: { ...job.lineage } }, { ...job, froms: froms.slice(mid), lineage: { ...job.lineage } }); };
      const splitRange = () => { job.lineage.limit = Math.min(job.lineage.limit, span - 1); const mid = job.lo + Math.floor((job.hi - job.lo) / 2); queue.unshift({ ...job, froms, hi: mid }, { ...job, froms, lo: mid + 1 }); };
      if (froms.length > 1 && (TOO_MANY.test(msg) || span <= minRangeBlocks)) { splitFroms(); continue; }
      // ONE wallet whose untargeted read is too large: it sends too much to
      // others. That is kept for the next scans; with few known payers it is
      // read targeted at them now (exactly what is recorded anyway).
      if (froms.length === 1 && TOO_MANY.test(msg)) {
        if (!(state.wallets.get(froms[0]).oh > 0 && now - state.wallets.get(froms[0]).oh < outboundHeavyMs)) stats.marked++;
        state.wallets.get(froms[0]).oh = now;
        if (fewKnown(froms[0])) { stats.targeted++; queue.unshift(targeted(froms, job.lo, job.hi, { limit: Infinity })); continue; }
      }
      if (span > minRangeBlocks) { splitRange(); continue; }
      if (froms.length > 1) { splitFroms(); continue; }
      // One wallet no untargeted read can serve: read it targeted at its
      // known payers, which is exactly what is recorded anyway (complete).
      if (state.wallets.get(froms[0]).known.size) { queue.unshift(targeted(froms, job.lo, job.hi, job.lineage)); continue; }
      stuck.add(froms[0]);
      continue;
    }
    ctl.unknown = 0;
    record(logs, froms);
    for (const w of froms) state.wallets.get(w).cursor = job.hi;
    // An untargeted read answered after its packed job was refused: a wallet
    // that sent a large share of it is marked, so the next scans read it
    // apart instead of learning the same split again.
    if (!job.tos && Array.isArray(logs) && froms.some((w) => inRefusedPack.has(w))) {
      const sent = new Map();
      for (const l of logs) { const f = addrFromTopic(l?.topics?.[1]); if (f) sent.set(f, (sent.get(f) || 0) + 1); }
      for (const w of froms) {
        const ws = state.wallets.get(w);
        if (!inRefusedPack.has(w) || (sent.get(w) || 0) < outboundBusyLogs || (ws.oh > 0 && now - ws.oh < outboundHeavyMs)) continue;
        ws.oh = now; stats.marked++;
      }
    }
  }
  for (const w of order) {
    const ws = state.wallets.get(w);
    if (ws.cursor >= latest) stats.caughtUp++; else stats.behind++;
    if (ws.truncated) stats.truncated++;
  }
  stats.stuck = stuck.size;
  return stats;
}

// --- a payer's whole history, read once ---------------------------------------------
//
// Targeted reads of the transfers between a wallet and a set of its payers:
// `dir` "out" is wallet -> payer (topics [T, wallets, payers]), "in" is payer
// -> wallet. A REQUEST is one wallet, at most `payerChunk` of its payers and a
// block range [lo, hi], and it keeps its own progress: a wallet with more
// payers than that has one request per chunk of them, so a chunk read in full
// is never read again while the rest of the wallet's reads take longer.
// Requests with the same range and width are packed up to `walletChunk`
// wallets and `payerChunk` payers per job. A job reads its range front to
// back: [lo, lo + width - 1], then on; a refusal halves the width of that job
// alone (after its wallet list, then its payer list, is split), and an
// answered read doubles it again (never past `maxSpanBlocks`, nor past a
// range limit the RPC stated). Every call is charged to every wallet in it, in
// the wallet's episode (`acct`, see ONE WALLET CANNOT SPEND THE READS). Each
// request ends the pass done, or with a frontier (the first block not read),
// the width it had learned, and the transfers read below the frontier - which
// the caller keeps as the request's progress.
//
// `stopOnRangeLimit`: a whole-history read stops for the scan when the RPC
// says it limits the block range (no width fits a history under it at an
// affordable number of calls); a gap read narrows to the stated limit instead.
/** One call per payer chunk: the probe a read that got nowhere last time is planned. */
const probeCalls = (r, payerChunk = FUNDING_DEFAULTS.payerChunk) => Math.ceil(r.payers.length / Math.max(1, payerChunk));
/** The calls a read of `span` blocks at `width` blocks per call, for `payers`
 *  payers, is planned to take (a width of 0 or Infinity: one per payer chunk).
 *  `answered`: the read has been answered before, so past the stretch that
 *  narrowed it its width doubles back (about log2(span / width) reads);
 *  otherwise the width it is at is taken to hold for the whole span. */
export function plannedCalls(span, width, payers, payerChunk = FUNDING_DEFAULTS.payerChunk, answered = false) {
  if (!(span > 0) || !(payers > 0)) return 0;
  const chunks = Math.ceil(payers / Math.max(1, payerChunk));
  if (!(width > 0) || width >= span) return chunks;
  return (answered ? Math.ceil(Math.log2(span / width + 1)) : Math.ceil(span / width)) * chunks;
}
/** Order two job keys (see pairsReader); null (nothing to read) sorts last. */
function compareKeys(a, b) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
// Planned work left under this is "a little": such wallets go before the
// wallets with many payers, which then go one at a time (see keyOf).
const LIGHT_PLAN = 4;
// Why a job cannot be taken now (see keyOf).
const BLOCKED = Symbol("blocked"), DAY = Symbol("day");
// A refused job split out of another with at most this many wallets is split
// into one job per wallet (see step).
const SPLIT_TO_SINGLES = 8;
function pairsReader({ rpc, token, dir, budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, maxSpanBlocks = Infinity, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, walletMaxPlan = Infinity, maxPartialLogsPerWallet = FUNDING_DEFAULTS.maxPartialLogsPerWallet, ctl = newFundingReadControl(), stopOnRangeLimit = false, acct, now = Date.now(), prio = new Map(), gate = new Map() }) {
  const tok = lower(token);
  const failed = new Set(), overShare = new Set(), gaveUp = new Set(), tooLarge = new Set(), tooDense = new Set();
  // Per wallet: transfers held for its requests (carried and read), and the
  // transfers and calls of this pass (the rate the too-dense stop projects).
  const held_ = new Map(), readNow = new Map(), callsNow = new Map();
  const bump = (m, w, n) => m.set(w, (m.get(w) || 0) + n);
  const dayHeld = new Set(); // wallets with a retry the day's allowance held back
  const queue = [];
  const held = new Map(); // request key -> how many queued jobs hold it
  const requests = [];
  const out = new Map(); // request key -> Map(payer -> [[pos, value]])
  const dropped = new Map(); // request key -> { lo, w } of a job left when its wallet stopped
  const lastWidth = new Map(); // request key -> the width after its last answered read
  const seen = new Set();
  let halted = null; // "budget" | "stop"
  const widthOf = (x) => (x > 0 ? Math.min(x, maxSpanBlocks) : maxSpanBlocks);
  // Every change to the queue goes through these, so whether a request still
  // has a job queued is a lookup (isDone), not a walk of the queue.
  const count = (jobs, d) => { for (const j of jobs) for (const r of j.rs) held.set(r.key, (held.get(r.key) || 0) + d); };
  const enqueue = (...jobs) => { count(jobs, 1); queue.push(...jobs); };
  const requeue = (...jobs) => { count(jobs, 1); queue.unshift(...jobs); };
  const take = (i) => { const [j] = queue.splice(i, 1); count([j], -1); return j; };
  // A job carries `split` (it is part of a packed job that was refused: its
  // reads isolate a heavy wallet, and go after the first reads, see keyOf)
  // and `depth` (how many times its wallet list was split); `grew` / `fails`
  // follow a single wallet's width (see the too-dense stop in step).
  const mkJob = (rs, tos, lo, hi, width, cap, split = false, depth = 0) => ({ rs, tos: [...new Set(tos)], ws: [...new Set(rs.map((r) => r.w))], lo, hi, width, cap, split, depth, grew: false, fails: 0 });
  const sub = (job, rs) => ({ ...mkJob(rs, job.tos.filter((p) => rs.some((r) => r.payerSet.has(p))), job.lo, job.hi, job.width, job.cap, job.split, job.depth), grew: job.grew, fails: job.fails });
  const pack = (rs, lo, hi, width, split = false) => {
    const jobs = [];
    let cur = null;
    for (const r of rs) {
      // A request that picks up earlier progress (or of a wallet that has
      // had to wait) reads alone: its wallet is the one that was heavy, and
      // packing it again would spend the same isolating splits every scan.
      if (r.alone || r.payers.length > payerChunk) {
        for (let i = 0; i < r.payers.length; i += payerChunk) jobs.push(mkJob([r], r.payers.slice(i, i + payerChunk), lo, hi, width, Infinity, split));
        continue;
      }
      const curWallets = cur ? new Set(cur.rs.map((x) => x.w)) : null;
      if (!cur || (!curWallets.has(r.w) && curWallets.size >= walletChunk) || cur.tos.length + r.payers.length > payerChunk) { cur = { rs: [], tos: [], lo, hi, width }; jobs.push(cur); }
      cur.rs.push(r); cur.tos.push(...r.payers);
    }
    return jobs.map((j) => (j.ws ? j : mkJob(j.rs, j.tos, j.lo, j.hi, j.width, Infinity, split)));
  };
  /** Add requests: { key, w, payers, lo, hi, width, logs, grp } (logs: what
   *  an earlier pass read below `lo`, kept as it is; grp: its group, whose
   *  members are packed only with each other, as a job already split). */
  function add(reqs) {
    const byRange = new Map();
    for (const r of reqs) {
      r.payerSet = new Set(r.payers);
      requests.push(r);
      const m = new Map();
      for (const [p, list] of r.logs || []) { m.set(p, list.slice()); bump(held_, r.w, list.length); }
      out.set(r.key, m);
      if (!(r.hi >= r.lo) || !r.payers.length) continue; // nothing to read: done
      const width = widthOf(r.width);
      const g = r.grp > 0 && !r.alone ? r.grp : 0;
      const k = `${r.lo}:${r.hi}:${width}:${g}`;
      if (!byRange.has(k)) byRange.set(k, []);
      byRange.get(k).push(r);
    }
    for (const [k, rs] of byRange) enqueue(...pack(rs, rs[0].lo, rs[0].hi, widthOf(rs[0].width), !k.endsWith(":0")));
  }
  // The order (keyOf, compared by compareKeys). A read that picks up progress
  // which got nowhere last time (refused at every width it tried) goes after
  // every other, and while a wallet has such a read not yet answered this pass
  // none of its other reads is taken: a wallet whose earlier read cannot be
  // answered spends nothing on reads it could only use once that one is.
  // Then planned work before any call past a plan: first reads (every
  // wallet's reads as they were packed, and a wallet's second read once its
  // first is done) - the jobs of wallets with a little of their plan left,
  // then the rest in priority order, one wallet at a time, so a wallet with
  // many payers finishes instead of every wallet ending the scan half read -
  // and only then the jobs split out of a packed job that was refused, the
  // shallowest splits first: isolating a heavy wallet never keeps another
  // wallet's first read waiting, and the light wallets packed with it come
  // out of the first splits. Among calls past a plan, the job with the fewest
  // reads left at its width first (a history with one dense stretch
  // finishes; one refused all the way through falls behind), then the least
  // overrun, then the least spent. Ties go to the front of the queue.
  // A RETRY - a call past a plan, or one picking up a read refused at every
  // width last time - is taken only while the day's allowance for retries
  // lasts (dayMaxCalls); first reads never wait for it.
  const keyOf = (job) => {
    const stalled = job.rs.every((r) => r.stalled) ? 1 : 0;
    if (!stalled && job.ws.some((w) => gate.get(w)?.size)) return BLOCKED;
    let ov = 0, sp = 0, left = Infinity, pr = Infinity;
    for (const w of job.ws) {
      const a = acct(w);
      ov = Math.max(ov, a.sp + 1 - a.pl); sp = Math.max(sp, a.sp); left = Math.min(left, a.pl - a.sp);
      pr = Math.min(pr, prio.get(w) ?? Number.MAX_SAFE_INTEGER);
    }
    if ((ov > 0 || stalled) && !(ctl.dayLeft > 0)) return DAY;
    if (ov > 0) return [stalled, 1, plannedCalls(job.hi - job.lo + 1, job.width, 1), ov, sp];
    return job.split ? [stalled, 0, 1, job.depth, pr] : [stalled, 0, 0, left > LIGHT_PLAN ? 1 : 0, pr];
  };
  const pickIndex = () => {
    let bi = -1, bk = null;
    for (let i = 0; i < queue.length; i++) {
      const k = keyOf(queue[i]);
      if (k === DAY) { ctl.dayCapped = true; for (const w of queue[i].ws) dayHeld.add(w); continue; }
      if (k === BLOCKED) continue;
      if (!bk || compareKeys(k, bk) < 0) { bk = k; bi = i; }
    }
    return { index: bi, key: bk };
  };
  const noteDrop = (r, job) => {
    const e = dropped.get(r.key);
    if (!e || job.lo < e.lo) dropped.set(r.key, { lo: job.lo, w: Math.min(e?.w ?? Infinity, job.width) });
    else e.w = Math.min(e.w, job.width);
  };
  const record = (job, logs, end) => {
    const byWP = new Map();
    for (const r of job.rs) for (const p of job.tos) if (r.payerSet.has(p)) byWP.set(`${r.w}:${p}`, r);
    for (const l of Array.isArray(logs) ? logs : []) {
      const a = addrFromTopic(l?.topics?.[1]), b = addrFromTopic(l?.topics?.[2]);
      const w = dir === "out" ? a : b, p = dir === "out" ? b : a;
      const r = w && p ? byWP.get(`${w}:${p}`) : null;
      if (!r) continue;
      const value = valueOf(l), pos = posOfLog(l);
      if (value === null || pos === null || pos < posOf(job.lo, 0) || pos > endOfBlock(end)) continue;
      const k = `${r.key}:${p}:${pos}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const m = out.get(r.key);
      if (!m.has(p)) m.set(p, []);
      m.get(p).push([pos, value]);
      stats.events++;
      bump(held_, r.w, 1); bump(readNow, r.w, 1);
    }
  };
  // TOO DENSE TO HOLD, found mid-scan. A wallet that cannot finish its reads
  // on what is left of its share, and at the rate it has been reading would
  // end the attempt holding more transfers than its progress may keep
  // between scans (maxPartialLogsPerWallet), stops now: that progress would
  // be dropped at the end of the scan (capProgress) and every call past this
  // one would buy nothing. The reads left are counted at the width a read
  // has narrowed to once it has twice failed to grow back (a history dense
  // all the way through), else by the doubling rule (a stretch that passes).
  const readsLeft = (w) => {
    let n = 0;
    for (const j of queue) {
      if (!j.ws.includes(w)) continue;
      const answered = j.fails < 2 && j.rs.some((r) => r.advanced || r.answeredBefore);
      n += plannedCalls(j.hi - j.lo + 1, j.width, j.tos.length, payerChunk, answered);
    }
    return n;
  };
  const checkDense = (w) => {
    const held = held_.get(w) || 0, calls = callsNow.get(w) || 0;
    if (failed.has(w) || !held || calls < 3) return;
    const a = acct(w);
    const shareLeft = Math.max(0, a.pl + walletMaxCalls - a.sp);
    const left = readsLeft(w);
    if (left > shareLeft && held + shareLeft * ((readNow.get(w) || 0) / calls) > maxPartialLogsPerWallet) { failed.add(w); tooDense.add(w); }
  };
  /** One step: read (or split, or drop) the job picked next. "halt" when
   *  the budget is spent or the scan's read stopped. */
  async function step() {
    if (halted) return "halt";
    const { index } = pickIndex();
    if (index < 0) return "empty";
    const job = take(index);
    // A wallet whose next call would pass its plan plus walletMaxCalls stops
    // here. So does one whose read has never been answered and whose reads
    // left, at the width it has narrowed to, are more than a whole scan could
    // make (a read that has been answered widens again past the stretch that
    // narrowed it, so it is left to its share).
    for (const w of job.ws) if (!failed.has(w)) { const a = acct(w); if (a.sp + 1 > a.pl + walletMaxCalls) { failed.add(w); overShare.add(w); } }
    if (job.ws.length === 1 && !failed.has(job.ws[0]) && job.rs.every((r) => !r.advanced && !r.answeredBefore) && plannedCalls(job.hi - job.lo + 1, job.width, job.tos.length, payerChunk) > walletMaxPlan) { failed.add(job.ws[0]); tooLarge.add(job.ws[0]); }
    const live = job.rs.filter((r) => !failed.has(r.w));
    if (live.length < job.rs.length) {
      for (const r of job.rs) if (failed.has(r.w)) noteDrop(r, job);
      if (live.length) requeue(sub(job, live));
      return "ok";
    }
    if (ctl.stop) { requeue(job); halted = "stop"; return "halt"; }
    if (budget.calls >= budget.max) { stats.budgetExhausted = true; requeue(job); halted = "budget"; return "halt"; }
    const end = job.width >= job.hi - job.lo + 1 ? job.hi : job.lo + job.width - 1;
    const span = end - job.lo + 1;
    // A retry counts toward the day's allowance for retries (keyOf only
    // picks one while the day allows it).
    const retry = job.rs.every((r) => r.stalled) || job.ws.some((w) => { const a = acct(w); return a.sp + 1 > a.pl; });
    budget.calls++; stats.calls++;
    if (retry) { ctl.dayLeft--; stats.retries++; }
    for (const w of job.ws) { const a = acct(w); a.sp++; a.t = now; bump(callsNow, w, 1); }
    let logs;
    try {
      const walletTopics = job.ws.map(pad), payerTopics = job.tos.map(pad);
      logs = await rpc("eth_getLogs", [{ fromBlock: "0x" + job.lo.toString(16), toBlock: "0x" + end.toString(16), address: tok, topics: dir === "out" ? [TRANSFER, walletTopics, payerTopics] : [TRANSFER, payerTopics, walletTopics] }]);
    } catch (e) {
      const msg = String(e?.message || e);
      const kind = failureKind(msg, ctl);
      if (kind === "range" && !stopOnRangeLimit && span > minRangeBlocks) {
        // A gap read under a range limit: narrow this job to it, for good.
        stats.refusals++;
        const stated = statedRangeLimit(msg);
        job.cap = Math.min(job.cap, stated ?? Infinity);
        job.width = Math.max(1, Math.min(span - 1, stated ?? Math.floor(span / 2)));
        requeue(job);
        return "ok";
      }
      if (kind !== "split") {
        if (kind === "unreachable" && !ctl.transportRetried) { ctl.transportRetried = true; requeue(job); return "ok"; }
        ctl.stop = stopReason(kind);
        if (kind === "range") ctl.rangeLimit = statedRangeLimit(msg);
        stats.transportError = msg.slice(0, 160); requeue(job); halted = "stop"; return "halt";
      }
      stats.refusals++;
      if (job.ws.length > 1) {
        // Which of its wallets made it too large is not known yet: the reads
        // that isolate it are planned for every one of them, so a light
        // wallet packed with a heavy one is never charged for it.
        for (const w of job.ws) acct(w).pl++;
        const part = (rs) => Object.assign(sub(job, rs), { split: true, depth: job.depth + 1 });
        // A few wallets left from a job that was itself split out of a
        // refused one are most likely heavy together: each is read on its
        // own (as many calls as halving would spend when one is heavy, fewer
        // when they all are). Otherwise the list is halved.
        if (job.split && job.ws.length <= SPLIT_TO_SINGLES) { requeue(...job.ws.map((w) => part(job.rs.filter((r) => r.w === w)))); return "ok"; }
        const mid = Math.ceil(job.ws.length / 2);
        const left = new Set(job.ws.slice(0, mid));
        requeue(part(job.rs.filter((r) => left.has(r.w))), part(job.rs.filter((r) => !left.has(r.w))));
        return "ok";
      }
      // Refused on its own wallet: that is the read that got nowhere, not
      // the wallets it was packed with.
      for (const r of job.rs) r.refusedAlone = true;
      if (job.grew) { job.fails++; job.grew = false; }
      // One wallet: narrow the width first (the payers of a dense stretch
      // ride along in the same calls, and a width that grows back after it
      // costs nothing elsewhere); split its payer list only once the width
      // cannot narrow further. A read never answered at any width narrows
      // four times at a time while it looks for one that is (one extra read
      // doubles it back); one that has been answered halves.
      if (span > minRangeBlocks) {
        const searching = job.rs.every((r) => !r.advanced && !r.answeredBefore);
        const quarter = Math.floor(span / 4);
        job.width = Math.max(1, searching && quarter >= minRangeBlocks ? quarter : Math.floor(span / 2));
        requeue(job);
        checkDense(job.ws[0]);
        return "ok";
      }
      if (job.tos.length > 1) {
        const mid = Math.ceil(job.tos.length / 2);
        requeue({ ...job, tos: job.tos.slice(0, mid) }, { ...job, tos: job.tos.slice(mid) });
        return "ok";
      }
      onProgress(`      payer history read gave up on one wallet at blocks ${job.lo}-${end}: ${msg.slice(0, 120)}`);
      failed.add(job.ws[0]); gaveUp.add(job.ws[0]);
      for (const r of job.rs) noteDrop(r, job);
      return "ok";
    }
    ctl.unknown = 0;
    record(job, logs, end);
    for (const r of job.rs) {
      if (r.stalled) { r.stalled = false; gate.get(r.w)?.delete(r.key); }
      r.advanced = true;
    }
    job.lo = end + 1;
    if (job.grew) job.fails = 0;
    const was = job.width;
    if (Number.isFinite(job.width)) job.width = Math.min(maxSpanBlocks, job.cap, job.width * 2);
    job.grew = job.width > was;
    for (const r of job.rs) lastWidth.set(r.key, job.width);
    if (job.lo <= job.hi) requeue(job);
    if (job.ws.length === 1) checkDense(job.ws[0]);
    return "ok";
  }
  return {
    add,
    step,
    /** Why the reader stopped: "budget", "stop", or null. */
    haltedFor: () => halted,
    /** The order key of the job this reader would read next (null when it has none it may take). */
    nextKey: () => (halted || !queue.length ? null : pickIndex().key),
    /** Whether the request has been read in full (so far this pass). */
    isDone: (r) => !failed.has(r.w) && !(held.get(r.key) > 0) && !dropped.has(r.key),
    /** Whether any transfer for (request, payer) has been read, earlier passes included. */
    hasLogs: (r, p) => !!out.get(r.key)?.get(p)?.length,
    /**
     * Every request, with `done`, `frontier` (the first block not read),
     * `width` (the width it had learned), and `logs` (Map payer -> sorted
     * list; for an unfinished request, only what lies below its frontier).
     * `overShare` / `gaveUp` / `tooLarge` / `tooDense`: wallets that stopped for those reasons.
     */
    result() {
      // Reads left in a job split out of a refused packed job share a group.
      for (const j of queue) if (j.split) { const g = nextGroup(ctl, now); for (const r of j.rs) if (!r.grpOut) r.grpOut = g; }
      const pend = new Map();
      for (const j of queue) for (const r of j.rs) {
        const e = pend.get(r.key);
        if (!e || j.lo < e.lo) pend.set(r.key, { lo: j.lo, w: Math.min(e?.w ?? Infinity, j.width) });
        else e.w = Math.min(e.w, j.width);
      }
      for (const [k, d] of dropped) {
        const e = pend.get(k);
        if (!e || d.lo < e.lo) pend.set(k, { lo: d.lo, w: Math.min(e?.w ?? Infinity, d.w) });
        else e.w = Math.min(e.w, d.w);
      }
      for (const r of requests) {
        const m = out.get(r.key);
        for (const list of m.values()) list.sort((x, y) => x[0] - y[0]);
        const p = pend.get(r.key);
        if (!p) { r.done = true; r.frontier = Math.max(r.lo, r.hi + 1); r.endWidth = lastWidth.get(r.key) ?? widthOf(r.width); r.out = m; continue; }
        r.done = false; r.frontier = p.lo; r.endWidth = p.w;
        const cut = posOf(p.lo, 0);
        const below = new Map();
        for (const [payer, list] of m) { const keep = list.filter(([pos]) => pos < cut); if (keep.length) below.set(payer, keep); }
        r.out = below;
      }
      if (overShare.size) onProgress(`      ${overShare.size} wallet(s) spent their share of the reads; each waits before it is tried again`);
      return { requests, overShare, gaveUp, tooLarge, tooDense, failed, halted, dayHeld };
    },
  };
}

// --- the read accounting, per wallet ---------------------------------------------------
//
// See ONE WALLET CANNOT SPEND THE READS above.
/** Whether a wallet may be read now. A wallet whose wait is over resumes a
 *  read that had been answered at twice the width it had reached (a
 *  narrowing from a passing refusal heals); a read refused at every width it
 *  tried resumes at the next width it had not tried, so it is never refused
 *  at the same width twice. Counts a waiting wallet once a scan. */
function mayRead(ws, w, now, ctl, stats, retryBackoffMs) {
  if (ctl.stopped.has(w)) return false; // stopped by an earlier pass of this scan (counted there)
  if (ws.retryAt > now) {
    if (!ctl.waitingSeen.has(w)) { ctl.waitingSeen.add(w); stats.waiting++; }
    return false;
  }
  if (ws.retryAt) {
    ws.retryAt = 0;
    for (const g of ws.hp) if (g.w > 0 && g.pg === 1) g.w *= 2;
  }
  // An episode idle for a day (nothing charged to it) starts over.
  if (ws.ep && now - ws.ep.t > retryBackoffMs) ws.ep = null;
  return true;
}
/** The wallet waits: a day, doubling each time it has to wait again, up to the maximum. */
function makeWait(ws, w, now, ctl, { retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, maxRetryBackoffMs = FUNDING_DEFAULTS.maxRetryBackoffMs } = {}) {
  ws.st = (ws.st || 0) + 1;
  ws.retryAt = now + Math.min(maxRetryBackoffMs, retryBackoffMs * 2 ** Math.min(ws.st - 1, 20));
  ws.ep = null;
  ctl?.stopped.add(w);
}
/** Replace the wallet's progress segments `was` with those saved from this
 *  pass's requests (done ones too: a later scan only extends them). */
function saveSegments(ws, was, reqs, kindH) {
  const drop = new Set(was);
  ws.hp = ws.hp.filter((g) => !drop.has(g));
  // Read in full (2); got further (1); refused on its own wallet and never
  // answered (0). A read that never got a turn, or only rode in packed jobs
  // that were refused, keeps what it was, and the group of the split job it
  // was left in.
  for (const r of reqs) {
    const pg = r.done ? 2 : r.advanced ? 1 : r.refusedAlone ? 0 : r.seg ? r.seg.pg : 1;
    ws.hp.push(newSegment(r.kind, kindH(r), r.payers, r.frontier, r.endWidth, r.out, pg, pg === 1 && !r.advanced ? r.grpOut || 0 : 0));
  }
}
/** A wallet found too dense to hold mid-scan (see pairsReader): as capProgress
 *  does at the end of a scan, it keeps the payers holding most of what it had
 *  read, loses its progress, and waits. */
function dropTooDense(ws, w, now, ctl, waitOpts) {
  ws.td = densestPayers(ws);
  ws.hp = [];
  makeWait(ws, w, now, ctl, waitOpts);
}
/** The payers holding most of a wallet's kept transfers, most first. */
function densestPayers(ws) {
  const n = new Map();
  for (const g of ws.hp || []) for (let i = 0; i + 2 < g.l.length; i += 3) { const p = g.p[g.l[i]]; if (p) n.set(p, (n.get(p) || 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, MAX_DENSE_PAYERS).map(([p]) => p);
}
/** Keep the progress of unfinished reads within its caps: a wallet over its
 *  own cap, then the wallets holding most while the total is over, lose it and
 *  wait. A wallet over its OWN cap has a history too dense to hold between
 *  scans: the payers holding most of it are kept (`td`), and while any of them
 *  is still new to the wallet it is not read again (reading it from the start
 *  would only fill the cap again). Returns how many wallets lost their progress. */
function capProgress(state, now, { maxPartialLogsPerWallet = FUNDING_DEFAULTS.maxPartialLogsPerWallet, maxPartialLogsTotal = FUNDING_DEFAULTS.maxPartialLogsTotal, ...waitOpts } = {}) {
  let n = 0;
  // (a wallet this scan already made wait is not made to wait twice)
  const drop = (w, ws, dense) => { if (dense) ws.td = densestPayers(ws); ws.hp = []; if (!(ws.retryAt > now)) makeWait(ws, w, now, null, waitOpts); n++; };
  for (const [w, ws] of state.wallets) if (segmentLogCount(ws) > maxPartialLogsPerWallet) drop(w, ws, true);
  let total = fundingPartialLogCount(state);
  if (total <= maxPartialLogsTotal) return n;
  const heavy = [...state.wallets].filter(([, ws]) => ws.hp?.length).sort((a, b) => segmentLogCount(b[1]) - segmentLogCount(a[1]));
  for (const [w, ws] of heavy) { if (total <= maxPartialLogsTotal) break; total -= segmentLogCount(ws); drop(w, ws, false); }
  return n;
}
/** Whether a wallet marked too dense to hold still has one of those payers
 *  among `pending` (the payers its reads would cover). */
const stillTooDense = (ws, pending) => !!ws.td?.length && ws.td.some((p) => pending.has(p));
/** The reason a range-limited history read gives in the log, and whether a
 *  bounded history range could fit under that limit within a scan's budget. */
function rangeHintOf(limit, span, walletMaxPlan) {
  const fits = !!limit && plannedCalls(span, limit, 1) <= walletMaxPlan;
  return fits
    ? { fits, text: `this RPC limits the block range of eth_getLogs; FUNDING_HISTORY_CHUNK_BLOCKS at or under ${limit} reads a history within a scan, or LEADERBOARD_FUNDING_SCAN=off` }
    : { fits, text: "this RPC limits the block range of eth_getLogs too narrowly to read a history within a scan; use a primary RPC without that limit, or LEADERBOARD_FUNDING_SCAN=off" };
}

/**
 * The whole history, with each wallet, of every payer it has not seen before,
 * read once (see EVERY PAYER'S WHOLE HISTORY above), plus the credit of a known
 * payer whose pool is about to receive its first funding:
 *   1. the wallet's transfers to its NEW payers, from `historyFromBlock` up to
 *      its cursor (after readSellerFunding, so the two reads meet exactly);
 *   2. for the new payers it ever funded, their transfers to it before the
 *      window (the window's own payments come from the scan);
 *   3. for a known payer whose first funding is pending, its transfers to the
 *      wallet before it became known (its credit: money of its own the
 *      funding may be returning).
 * Each read resumes where an earlier scan's left off (the wallet's `hp`).
 * `wallets` is [{ wallet, payers }] in priority order, `payers` this scan's.
 *
 * @returns { histories: Map(wallet -> { upTo, covered: Set, funds, ins, credits }),
 *   stats } - a wallet appears only when every read it needed completed.
 */
export async function readPayerHistory({ rpc, token, state, wallets = [], windowStartBlock, historyFromBlock = historyFromBlockFor(token), historyChunkBlocks = FUNDING_DEFAULTS.historyChunkBlocks, walletChunk = FUNDING_DEFAULTS.walletChunk, payerChunk = FUNDING_DEFAULTS.payerChunk, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, maxRetryBackoffMs = FUNDING_DEFAULTS.maxRetryBackoffMs, dayMaxCalls = FUNDING_DEFAULTS.dayMaxCalls, maxPartialLogsPerWallet = FUNDING_DEFAULTS.maxPartialLogsPerWallet, scanMaxCalls = maxCalls, now = Date.now(), ctl = newFundingReadControl(), onProgress = () => {} } = {}) {
  const tok = lower(token);
  // overShare / gaveUp: wallets whose reads stopped for the reasons pairsReader
  // names; tooLarge: not started, their remaining reads needing more calls
  // than a scan has; tooDense: not started, marked too dense to hold (see
  // capProgress); waiting: not read this scan because an earlier scan made
  // them wait; dayHeld: made to wait when the day's allowance for retries held
  // a read of theirs back. resumed: reads that picked up an earlier scan's
  // progress. retries: calls past a wallet's plan, or picking up a read
  // refused at every width last time (what the day's allowance counts).
  const stats = { calls: 0, retries: 0, dayHeld: 0, refusals: 0, wallets: 0, payers: 0, funded: 0, creditReads: 0, read: 0, failed: 0, overShare: 0, gaveUp: 0, tooLarge: 0, tooDense: 0, waiting: 0, resumed: 0, events: 0, budgetExhausted: false, dayCapReached: false, transportError: null, stopped: null, rangeLimitFits: null };
  const budget = { calls: 0, max: Math.max(0, maxCalls) };
  openDay(ctl, state, now, dayMaxCalls);
  const from = Math.max(0, historyFromBlock);
  const maxSpan = historyChunkBlocks > 0 ? historyChunkBlocks : Infinity;
  const walletMaxPlan = Math.max(1, scanMaxCalls);
  const waitOpts = { retryBackoffMs, maxRetryBackoffMs };
  let seq = 0;
  // One request per chunk of payers, each keeping its own progress.
  const reqsFor = (w, kind, seg, payers, lo, hi, width, h = -1) => {
    const logs = seg ? segmentLogs(seg) : null;
    const list = [];
    for (let i = 0; i < payers.length; i += payerChunk) {
      const ps = payers.slice(i, i + payerChunk), pset = new Set(ps);
      list.push({ key: `${kind}${++seq}`, kind, w, seg, payers: ps, lo, hi, width, h, logs: logs ? new Map([...logs].filter(([p]) => pset.has(p))) : null, stalled: !!seg && seg.pg === 0, segDone: !!seg && seg.pg === 2, answeredBefore: !!seg && seg.lo > from, grp: seg && seg.pg === 1 ? seg.g : 0 });
    }
    return list;
  };
  const estimate = (r) => plannedCalls(r.hi - r.lo + 1, r.width > 0 ? Math.min(r.width, maxSpan) : maxSpan, r.payers.length, payerChunk, r.answeredBefore);
  const plan = new Map(); // wallet -> { ws, fresh: Set, o: [], i: [], c: [], was: [segments resumed], iBuilt }
  const prio = new Map(), gate = new Map();
  for (const e of wallets) {
    const w = lower(e?.wallet);
    const ws = state.wallets.get(w);
    if (!ws || prio.has(w)) continue;
    prio.set(w, prio.size);
    const ps = [...new Set([...(e.payers || [])].map(lower))].filter((p) => EVM.test(p) && p !== w && isScannableWallet(p, tok) && !ws.known.has(p));
    const cr = [];
    for (const [p, pair] of ws.pairs) if (!pair.h && pair.pend.length) cr.push({ payer: p, hi: ws.known.get(p)?.[3] ?? -1 });
    if (!ps.length && !cr.length) continue;
    if (!mayRead(ws, w, now, ctl, stats, retryBackoffMs)) continue;
    if (stillTooDense(ws, new Set([...ps, ...cr.map((c) => c.payer)]))) { stats.tooDense++; stats.failed++; makeWait(ws, w, now, ctl, waitOpts); continue; }
    stats.wallets++;
    const fresh = new Set(ps);
    const p1 = { ws, fresh, o: [], i: [], c: [], was: [], iBuilt: false };
    // 1: the progress of earlier scans first, then the payers none of it
    // covers - read at the configured width: how far another read of this
    // wallet had to narrow says nothing about them.
    const coveredO = new Set();
    for (const g of ws.hp) if (g.k === "o" && g.p.some((p) => fresh.has(p))) { p1.o.push(...reqsFor(w, "o", g, g.p, g.lo, ws.cursor, g.w)); p1.was.push(g); for (const p of g.p) coveredO.add(p); }
    const newO = ps.filter((p) => !coveredO.has(p));
    if (newO.length) p1.o.push(...reqsFor(w, "o", null, newO, from, ws.cursor, 0));
    // 2, resumed: payers an earlier part of read 1 already found funded.
    for (const g of ws.hp) if (g.k === "i" && g.p.some((p) => fresh.has(p))) { p1.i.push(...reqsFor(w, "i", g, g.p, g.lo, windowStartBlock - 1, g.w)); p1.was.push(g); }
    // 3: per fixed end block.
    const byHi = new Map();
    for (const { payer, hi } of cr) { stats.creditReads++; if (!byHi.has(hi)) byHi.set(hi, []); byHi.get(hi).push(payer); }
    for (const [hi, payers] of byHi) {
      const pset = new Set(payers), cov = new Set();
      for (const g of ws.hp) if (g.k === "c" && g.h === hi && g.p.some((p) => pset.has(p))) { p1.c.push(...reqsFor(w, "c", g, g.p, g.lo, hi, g.w, hi)); p1.was.push(g); for (const p of g.p) cov.add(p); }
      const rest = payers.filter((p) => !cov.has(p));
      if (rest.length) p1.c.push(...reqsFor(w, "c", null, rest, from, hi, 0, hi));
    }
    const all = [...p1.o, ...p1.i, ...p1.c];
    // A wallet that has had to wait, or whose earlier read was refused on its
    // own or stopped part-way, reads alone: it is the heavy one, and packing
    // it again would spend the same isolating splits every scan. One whose
    // reads never got a turn is packed like any other, and one left in a
    // split job goes back to its group.
    const alone = ws.st > 0 || p1.was.some((g) => segmentShowsHeavy(g, from));
    for (const r of all) r.alone = alone;
    const need = all.reduce((n, r) => n + estimate(r), 0);
    if (need > walletMaxPlan) {
      // More than a scan can afford: not started. At widths it LEARNED, it
      // waits; at the configured bound (FUNDING_HISTORY_CHUNK_BLOCKS), nothing
      // will change until the setting does, so it is only skipped.
      stats.tooLarge++; stats.failed++;
      if (all.some((r) => r.width > 0 && r.width < maxSpan)) makeWait(ws, w, now, ctl, waitOpts);
      continue;
    }
    // The calls planned: a read that got nowhere last time is planned one
    // probe (anything past it is overrun), the rest what they need. Within
    // an episode a resumed read is not planned again, except for the blocks a
    // read that had finished now has to cover since.
    if (!ws.ep) ws.ep = { pl: all.reduce((n, r) => n + (r.stalled ? probeCalls(r, payerChunk) : estimate(r)), 0), sp: 0, t: now };
    else ws.ep.pl += all.filter((r) => !r.seg || r.segDone).reduce((n, r) => n + estimate(r), 0);
    for (const r of all) if (r.stalled) { if (!gate.has(w)) gate.set(w, new Set()); gate.get(w).add(r.key); }
    stats.payers += ps.length;
    stats.resumed += p1.was.length;
    plan.set(w, p1);
  }
  const acct = (w) => state.wallets.get(w).ep;
  const common = { rpc, token: tok, budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, maxSpanBlocks: maxSpan, walletMaxCalls, walletMaxPlan, maxPartialLogsPerWallet, ctl, stopOnRangeLimit: true, acct, now, prio, gate };
  // ONE schedule for both directions (see ONE WALLET CANNOT SPEND THE READS):
  // the step taken next is always the first by keyOf of either reader, so a
  // wallet's read 2 (planned work) goes before another wallet's splits of
  // read 1. A wallet's read 2 is queued the moment its read 1 is complete;
  // ties go to read 1.
  const a = pairsReader({ ...common, dir: "out" });
  const b = pairsReader({ ...common, dir: "in" });
  a.add([...plan.values()].flatMap((p1) => p1.o));
  b.add([...plan.values()].flatMap((p1) => [...p1.c, ...p1.i]));
  const queueFunded = () => {
    const add = [];
    for (const [w, p1] of plan) {
      if (p1.iBuilt || !p1.o.every((r) => a.isDone(r))) continue;
      p1.iBuilt = true;
      const funded = [...p1.fresh].filter((p) => p1.o.some((r) => a.hasLogs(r, p)));
      stats.funded += funded.length;
      const coveredI = new Set(p1.i.flatMap((r) => r.payers));
      const rest = funded.filter((p) => !coveredI.has(p));
      if (!rest.length) continue;
      const rs = reqsFor(w, "i", null, rest, from, windowStartBlock - 1, 0);
      const alone = p1.o.some((x) => x.alone);
      for (const r of rs) r.alone = alone;
      p1.i.push(...rs);
      p1.ws.ep.pl += rs.reduce((n, r) => n + estimate(r), 0);
      add.push(...rs);
    }
    if (add.length) b.add(add);
  };
  queueFunded();
  for (let steps = 1; ; steps++) {
    if (steps % YIELD_EVERY === 0) await yieldNow();
    const ka = a.nextKey(), kb = b.nextKey();
    if (!ka && !kb) break;
    const best = compareKeys(ka, kb) <= 0 ? a : b;
    const res = await best.step();
    if (res === "halt") break;
    if (best === a) queueFunded();
  }
  const ra = a.result(), rb = b.result();
  const overShare = new Set([...ra.overShare, ...rb.overShare]), gaveUp = new Set([...ra.gaveUp, ...rb.gaveUp]), hopeless = new Set([...ra.tooLarge, ...rb.tooLarge]);
  const dense = new Set([...ra.tooDense, ...rb.tooDense]);
  const stoppedW = new Set([...overShare, ...gaveUp, ...hopeless]);
  const dayHeld = new Set([...ra.dayHeld, ...rb.dayHeld]);
  const histories = new Map();
  for (const [w, p1] of plan) {
    const ws = p1.ws;
    const reqs = [...p1.o, ...p1.i, ...p1.c];
    saveSegments(ws, p1.was, reqs, (r) => (r.kind === "c" ? r.h : -1));
    if (dense.has(w) && !stoppedW.has(w)) { dropTooDense(ws, w, now, ctl, waitOpts); stats.tooDense++; stats.failed++; continue; }
    if (stoppedW.has(w)) { makeWait(ws, w, now, ctl, waitOpts); stats.failed++; continue; }
    const unfinished = reqs.some((r) => !r.done) || !p1.iBuilt;
    // Unfinished when the scan's budget ran out: it keeps its progress and
    // its episode, and the next scan carries on where it stopped. Held back
    // by the day's allowance for retries: it waits, as it could not go on
    // before that allowance frees up.
    if (unfinished && dayHeld.has(w)) { makeWait(ws, w, now, ctl, waitOpts); stats.dayHeld++; stats.failed++; continue; }
    if (unfinished) { stats.failed++; continue; }
    const funds = new Map(), ins = new Map(), credits = new Map();
    for (const r of p1.o) for (const [p, list] of r.out) if (p1.fresh.has(p)) funds.set(p, [...(funds.get(p) || []), ...list].sort((x, y) => x[0] - y[0]));
    for (const r of p1.i) for (const [p, list] of r.out) if (p1.fresh.has(p)) ins.set(p, [...(ins.get(p) || []), ...list].sort((x, y) => x[0] - y[0]));
    for (const r of p1.c) { for (const p of r.payers) if (!credits.has(p)) credits.set(p, []); for (const [p, list] of r.out) credits.set(p, [...credits.get(p), ...list].sort((x, y) => x[0] - y[0])); }
    histories.set(w, { upTo: ws.cursor, covered: new Set(p1.o.flatMap((r) => r.payers)), funds, ins, credits });
    stats.read++;
  }
  stats.overShare = overShare.size; stats.gaveUp = gaveUp.size; stats.tooLarge += hopeless.size;
  stats.stopped = ctl.stop;
  stats.dayCapReached = !!ctl.dayCapped;
  noteDay(state, now, stats.retries);
  if (stats.transportError) {
    const hint = ctl.stop === "range-limited" ? rangeHintOf(ctl.rangeLimit, Math.max(0, windowStartBlock - from), walletMaxPlan) : null;
    if (hint) stats.rangeLimitFits = hint.fits;
    onProgress(`      payer history read stopped (${ctl.stop || "RPC unreachable"}): ${stats.transportError}${hint ? ` - ${hint.text}` : ""}`);
  }
  return { histories, stats };
}

// --- the gap: what funded payers paid BEFORE the window ---------------------------
//
// The scan's inbound read covers its window only. A wallet that fell behind by
// more than a window has pools that start before the window, and would have
// them inflated by every payment its payers made in between, which that read
// never saw - and a pool only drains as the payer spends, so a payer in a
// steady two-way flow with the seller would be netted for good. So once, for
// such a wallet, the transfers its FUNDED payers sent it between its pools'
// position and the window's start are read (targeted: those payers to that
// wallet, a handful of calls) and worked through the pools in order. Until that
// read completes, the wallet's pools are not advanced (it reads as behind).
// It shares each wallet's read accounting with the history read, and resumes
// the same way.
export async function readFundingGaps({ rpc, token, state, wallets = [], windowStartBlock, maxCalls = FUNDING_DEFAULTS.maxCalls, minRangeBlocks = FUNDING_DEFAULTS.minRangeBlocks, payerChunk = FUNDING_DEFAULTS.payerChunk, walletChunk = FUNDING_DEFAULTS.walletChunk, walletMaxCalls = FUNDING_DEFAULTS.walletMaxCalls, retryBackoffMs = FUNDING_DEFAULTS.retryBackoffMs, maxRetryBackoffMs = FUNDING_DEFAULTS.maxRetryBackoffMs, dayMaxCalls = FUNDING_DEFAULTS.dayMaxCalls, maxPartialLogsPerWallet = FUNDING_DEFAULTS.maxPartialLogsPerWallet, scanMaxCalls = maxCalls, now = Date.now(), ctl = newFundingReadControl(), onProgress = () => {} } = {}) {
  const tok = lower(token);
  const stats = { calls: 0, retries: 0, dayHeld: 0, refusals: 0, wallets: 0, read: 0, failed: 0, overShare: 0, gaveUp: 0, tooLarge: 0, tooDense: 0, waiting: 0, resumed: 0, events: 0, budgetExhausted: false, dayCapReached: false, transportError: null };
  const gaps = new Map();
  const budget = { calls: 0, max: Math.max(0, maxCalls) };
  openDay(ctl, state, now, dayMaxCalls);
  const walletMaxPlan = Math.max(1, scanMaxCalls);
  const waitOpts = { retryBackoffMs, maxRetryBackoffMs };
  let seq = 0;
  const plan = new Map(); // wallet -> { ws, need, reqs, was }
  const prio = new Map(), gate = new Map();
  for (const w0 of wallets) {
    const w = lower(w0);
    const ws = state.wallets.get(w);
    if (!ws || prio.has(w)) continue;
    prio.set(w, prio.size);
    const n = gapNeeded(ws, windowStartBlock);
    if (!n) continue;
    // Progress of a gap that no longer starts where it did (the pools moved) is stale.
    ws.hp = ws.hp.filter((g) => g.k !== "g" || g.h === n.from);
    if (!mayRead(ws, w, now, ctl, stats, retryBackoffMs)) continue;
    const payers = [...ws.pairs.keys()];
    if (stillTooDense(ws, new Set(payers))) { stats.tooDense++; stats.failed++; makeWait(ws, w, now, ctl, waitOpts); continue; }
    stats.wallets++;
    const pset = new Set(payers), cov = new Set();
    const reqs = [], was = [];
    // One request per chunk of payers, each keeping its own progress.
    const mk = (seg, ps0, lo, width) => {
      const logs = seg ? segmentLogs(seg) : null;
      for (let i = 0; i < ps0.length; i += payerChunk) {
        const ps = ps0.slice(i, i + payerChunk), cs = new Set(ps);
        reqs.push({ key: `g${++seq}`, kind: "g", w, seg, payers: ps, lo, hi: n.to, width, logs: logs ? new Map([...logs].filter(([p]) => cs.has(p))) : null, stalled: !!seg && seg.pg === 0, segDone: !!seg && seg.pg === 2, answeredBefore: !!seg && seg.lo > n.from, grp: seg && seg.pg === 1 ? seg.g : 0 });
      }
    };
    for (const g of ws.hp) if (g.k === "g" && g.p.some((p) => pset.has(p))) { mk(g, g.p, g.lo, g.w); was.push(g); for (const p of g.p) cov.add(p); }
    const rest = payers.filter((p) => !cov.has(p));
    if (rest.length) mk(null, rest, n.from, 0);
    const estimate = (r) => plannedCalls(r.hi - r.lo + 1, r.width, r.payers.length, payerChunk, r.answeredBefore);
    for (const q of reqs) q.alone = ws.st > 0 || was.some((g) => segmentShowsHeavy(g, n.from));
    const need = reqs.reduce((x, r) => x + estimate(r), 0);
    if (need > walletMaxPlan) { stats.tooLarge++; stats.failed++; makeWait(ws, w, now, ctl, waitOpts); continue; }
    if (!ws.ep) ws.ep = { pl: reqs.reduce((x, r) => x + (r.stalled ? probeCalls(r, payerChunk) : estimate(r)), 0), sp: 0, t: now };
    else ws.ep.pl += reqs.filter((r) => !r.seg || r.segDone).reduce((x, r) => x + estimate(r), 0);
    for (const r of reqs) if (r.stalled) { if (!gate.has(w)) gate.set(w, new Set()); gate.get(w).add(r.key); }
    stats.resumed += was.length;
    plan.set(w, { ws, need: n, reqs, was });
  }
  const acct = (w) => state.wallets.get(w).ep;
  const r = pairsReader({ rpc, token: tok, dir: "in", budget, walletChunk, payerChunk, minRangeBlocks, onProgress, stats, walletMaxCalls, walletMaxPlan, maxPartialLogsPerWallet, ctl, stopOnRangeLimit: false, acct, now, prio, gate });
  r.add([...plan.values()].flatMap((x) => x.reqs));
  for (let steps = 1; (await r.step()) === "ok"; steps++) if (steps % YIELD_EVERY === 0) await yieldNow();
  const res = r.result();
  const stoppedW = new Set([...res.overShare, ...res.gaveUp, ...res.tooLarge]);
  for (const [w, x] of plan) {
    saveSegments(x.ws, x.was, x.reqs, () => x.need.from);
    if (res.tooDense.has(w) && !stoppedW.has(w)) { dropTooDense(x.ws, w, now, ctl, waitOpts); stats.tooDense++; stats.failed++; continue; }
    if (stoppedW.has(w)) { makeWait(x.ws, w, now, ctl, waitOpts); stats.failed++; continue; }
    const unfinished = x.reqs.some((q) => !q.done);
    if (unfinished && res.dayHeld.has(w)) { makeWait(x.ws, w, now, ctl, waitOpts); stats.dayHeld++; stats.failed++; continue; }
    if (unfinished) { stats.failed++; continue; }
    const ins = new Map();
    for (const q of x.reqs) for (const [p, list] of q.out) ins.set(p, [...(ins.get(p) || []), ...list].sort((a, b) => a[0] - b[0]));
    gaps.set(w, { toBlock: x.need.to, ins });
    stats.read++;
  }
  stats.overShare = res.overShare.size; stats.gaveUp = res.gaveUp.size; stats.tooLarge += res.tooLarge.size;
  stats.dayCapReached = !!ctl.dayCapped;
  noteDay(state, now, stats.retries);
  if (stats.transportError) onProgress(`      funding gap read stopped (${ctl.stop || "RPC unreachable"}): ${stats.transportError}`);
  return { gaps, stats };
}

/** The block range [from, to] of payments a wallet's pools have not seen that
 *  the window's inbound read cannot supply, or null. */
function gapNeeded(ws, windowStartBlock) {
  if (!ws || !ws.pairs.size) return null;
  const from = Math.floor((ws.through + 1) / 1_000_000);
  const to = Math.min(windowStartBlock - 1, ws.cursor);
  return from <= to ? { from, to } : null;
}

// --- working the pools through the counted payments --------------------------------

function paymentsOf(v) {
  const pos = Array.isArray(v?.pos) ? v.pos : [];
  const micro = Array.isArray(v?.micro) ? v.micro : [];
  const out = [];
  const each = v?.calls ? Math.round((Number(v.usd) || 0) * 1e6 / v.calls) : 0;
  for (let i = 0; i < pos.length; i++) out.push([pos[i], Number.isFinite(micro[i]) ? micro[i] : each]);
  return out;
}
const payerKeysOf = (row) => new Set([...(row?.perPayer?.keys?.() || [])].map(lower));

/**
 * Work every (W, P) pool through the payments the scan counted, in chain order,
 * up to `throughFor(wallet)` (the position the scan's inbound read is complete
 * through) and the wallet's cursor. Mutates `state`. Payments already worked
 * through in an earlier scan are not touched again: their result is in `recs`.
 *
 * A wallet is worked only when everything it needs was read this scan: the
 * history of every payer it has not seen before (`histories`, from
 * readPayerHistory), the credit of every known payer whose first funding is
 * pending, and the gap before the window when its pools start before it
 * (`gaps`). Otherwise it is left behind, untouched.
 */
export function processSellerFunding(state, byWallet, { throughFor = () => Infinity, windowStartBlock = 0, gaps = new Map(), histories = new Map(), classify = () => 1, coveredShareToNet = FUNDING_DEFAULTS.coveredShareToNet, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks, maxRecordsPerWallet = FUNDING_DEFAULTS.maxRecordsPerWallet, maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, maxPairsTotal = FUNDING_DEFAULTS.maxPairsTotal, maxKnownPerWallet = FUNDING_DEFAULTS.maxKnownPerWallet, maxKnownTotal = FUNDING_DEFAULTS.maxKnownTotal } = {}) {
  const rows = new Map();
  const payingNow = new Map();
  for (const row of byWallet.values()) rows.set(lower(row.wallet), row);
  const total = { n: fundingPairCount(state), max: maxPairsTotal };
  for (const [w, ws] of state.wallets) {
    // A wallet this scan did not look at has payments we have not seen: its
    // pools are not worked, only its remembered payments are trimmed below.
    const row = rows.get(w);
    const limit = Math.min(endOfBlock(ws.cursor), throughFor(w));
    if (row && limit > ws.through) {
      const need = gapNeeded(ws, windowStartBlock);
      const gap = need ? gaps.get(w) : null;
      const current = payerKeysOf(row);
      payingNow.set(w, current);
      const freshPayers = [...current].filter((p) => p !== w && !ws.known.has(p));
      const hist = histories.get(w) || null;
      const creditPending = [...ws.pairs].filter(([, pair]) => !pair.h && pair.pend.some(([pos]) => pos <= limit)).map(([p]) => p);
      const historyOk = (!freshPayers.length || (hist && hist.upTo === ws.cursor && freshPayers.every((p) => hist.covered.has(p))))
        && (!creditPending.length || (hist && creditPending.every((p) => hist.credits.has(p))));
      if ((!need || (gap && gap.toBlock >= need.to)) && historyOk) {
        const fresh = new Map();
        for (const p of freshPayers) {
          ws.known.set(p, [limit, -1, -1, windowStartBlock - 1]);
          const funds = hist?.funds?.get(p);
          if (!funds?.length) continue;
          if (ws.pairs.size >= maxPairsPerWallet || total.n >= total.max) { ws.truncated = true; continue; }
          const pair = newPair(1);
          pair.pend = funds.slice();
          ws.pairs.set(p, pair);
          total.n++;
          fresh.set(p, hist.ins.get(p) || []);
        }
        for (const p of creditPending) {
          const pair = ws.pairs.get(p);
          // Money of its own the payer sent before it became known: with no
          // funding before then its pool was empty, so all of it is credit.
          // Its counted payments then were its own money too: refund room.
          for (const [pos, m] of hist.credits.get(p) || []) {
            if (classify(w, m) !== 1) pair.credit += m;
            else addRefundable(ws, p, pos, m, m);
          }
          pair.h = 1;
        }
        workPools(ws, row, limit, { fresh, freshPayers: new Set(freshPayers), maxPairsPerWallet, total, gapIns: gap?.ins || null, classify: (micro) => classify(w, micro), coveredShareToNet, bucketBlocks });
        evictKnown(ws, current, maxKnownPerWallet);
        clearConsumedProgress(ws, { read: !!hist || !!gap });
      }
    }
    trimWallet(ws, windowStartBlock, maxRecordsPerWallet);
  }
  evictKnownTotal(state, payingNow, maxKnownTotal);
  return state;
}
// Past the total cap, forget the idlest known payers across every wallet, with
// the same exemptions as the per-wallet cap (a pool, or paying this scan).
function evictKnownTotal(state, payingNow, maxKnownTotal) {
  let n = 0;
  for (const ws of state.wallets.values()) n += ws.known.size;
  if (n <= maxKnownTotal) return;
  const idle = [];
  for (const [w, ws] of state.wallets) {
    const current = payingNow.get(w);
    for (const [p, k] of ws.known) if (!ws.pairs.has(p) && !current?.has(p)) idle.push([Math.max(k[0], k[1], k[2]), ws, p]);
  }
  idle.sort((x, y) => x[0] - y[0]);
  for (const [, ws, p] of idle.slice(0, n - maxKnownTotal)) ws.known.delete(p);
}
/** Record a counted payment made (at least partly) with the payer's own money
 *  as refundable: its position, amount and the part a refund may give back. */
function addRefundable(ws, p, pos, amt, own) {
  const k = ws.known.get(p);
  if (!k || !(own > 0)) return;
  const list = Array.isArray(k[4]) ? k[4] : [];
  list.push(pos, amt, own);
  if (list.length > 3 * REFUNDABLE_MAX) list.splice(0, list.length - 3 * REFUNDABLE_MAX);
  k[4] = list;
}
/** A seller transfer of `amt` to payer p: refund its refundable payments,
 *  newest first. A payment at least `coveredShareToNet` refunded is removed
 *  from the evidence (recorded in pair.rf and the day's refunded count).
 *  Returns how much of `amt` was a refund. */
function refundPayments(ws, p, pair, amt, { coveredShareToNet, bucketBlocks }) {
  const k = ws.known.get(p);
  const list = k && Array.isArray(k[4]) ? k[4] : null;
  let left = amt;
  if (!list || !(left > 0)) return 0;
  if (!pair.rf) pair.rf = [];
  if (!ws.refunded) ws.refunded = new Map();
  while (left > 0 && list.length) {
    const i = list.length - 3;
    const [pos, full, rem] = list.slice(i);
    const take = Math.min(rem, left);
    left -= take;
    let e = null;
    for (let j = pair.rf.length - 1; j >= 0; j--) if (pair.rf[j][0] === pos) { e = pair.rf[j]; break; }
    const before = e ? e[1] : 0;
    if (e) e[1] += take; else pair.rf.push([pos, take]);
    if (before < full * coveredShareToNet && before + take >= full * coveredShareToNet) {
      const day = Math.floor(pos / 1_000_000 / bucketBlocks);
      ws.refunded.set(day, (ws.refunded.get(day) || 0) + 1);
    }
    if (take >= rem) list.splice(i, 3); else list[i + 2] = rem - take;
  }
  if (!list.length) k.length = 4;
  pair.rf.sort((x, y) => x[0] - y[0]);
  return amt - left;
}
function workPools(ws, row, limit, { fresh = new Map(), freshPayers = new Set(), maxPairsPerWallet = FUNDING_DEFAULTS.maxPairsPerWallet, total = { n: 0, max: Infinity }, gapIns = null, classify = () => 1, coveredShareToNet = FUNDING_DEFAULTS.coveredShareToNet, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks } = {}) {
  const from = ws.through;
  // A payer seen for the first time has never been worked: all of its events
  // up to the limit count, not only those past the wallet's position.
  const lowFor = (p) => (freshPayers.has(p) ? -Infinity : from);
  const inRange = (p) => { const lo = lowFor(p); return ([pos]) => pos > lo && pos <= limit; };
  // Per known payer: the last payment made with its own money, and the last
  // made with the wallet's (the 30-day payer count); per day, payments netted.
  const note = (p, pos, netted) => {
    const k = ws.known.get(p);
    if (!k) return;
    if (netted) {
      k[2] = Math.max(k[2], pos);
      const day = Math.floor(pos / 1_000_000 / bucketBlocks);
      ws.netted.set(day, (ws.netted.get(day) || 0) + 1);
    } else k[1] = Math.max(k[1], pos);
  };
  const byPayer = new Map();
  for (const [p0, v] of row.perPayer || []) {
    const p = lower(p0);
    const pays = paymentsOf(v).filter(inRange(p));
    if (!pays.length) continue;
    if (ws.pairs.has(p)) byPayer.set(p, pays);
    else for (const [pos, m] of pays) { note(p, pos, false); addRefundable(ws, p, pos, m, m); } // never funded: its own money
  }
  // Uncounted money a KNOWN payer sent this wallet: its credit, kept even
  // before the wallet has sent that payer anything (a refund can come later).
  const uncounted = new Map();
  for (const [p0, v] of row.uncountedIn || []) {
    const p = lower(p0);
    if (!ws.known.has(p)) continue;
    const ins = paymentsOf({ ...v, calls: v.pos.length }).filter(inRange(p));
    if (!ins.length) continue;
    if (!ws.pairs.has(p)) {
      if (ws.pairs.size >= maxPairsPerWallet || total.n >= total.max) continue; // credit is a courtesy to the seller; losing it only nets more
      // A payer seen for the first time with no funding: everything before
      // the window is irrelevant until it is funded, when its credit is read.
      ws.pairs.set(p, newPair(0));
      total.n++;
    }
    uncounted.set(p, ins);
  }
  for (const [p, pair] of ws.pairs) {
    const r = inRange(p);
    const funds = pair.pend.filter(([pos]) => pos <= limit);
    const pays = byPayer.get(p) || [];
    const ins = uncounted.get(p) || [];
    // What this payer sent the wallet before the window: from its history
    // read when it is new, from the gap read when the wallet fell behind.
    // Counted-sized payments spend the pool, anything larger is payback /
    // credit, exactly as inside the window.
    const beforeSrc = fresh.has(p) ? fresh.get(p) : (gapIns?.get(p) || []).filter(r);
    const before = beforeSrc.map(([pos, m]) => [pos, classify(m) === 1 ? 1 : 2, m]);
    if (!funds.length && !pays.length && !ins.length && !before.length) continue;
    pair.pend = pair.pend.filter(([pos]) => pos > limit);
    const events = [...funds.map(([pos, a]) => [pos, 0, a]), ...pays.map(([pos, b]) => [pos, 1, b]), ...ins.map(([pos, u]) => [pos, 2, u]), ...before].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (const [pos, kind, amt] of events) {
      pair.at = Math.max(pair.at || 0, pos);
      if (kind === 0) {
        // The seller sends: first give back the payer's own uncounted money,
        // then refund its genuine payments (removing them); only the rest is pool.
        const refund = Math.min(pair.credit || 0, amt);
        pair.credit = (pair.credit || 0) - refund;
        const refunded = refundPayments(ws, p, pair, amt - refund, { coveredShareToNet, bucketBlocks });
        pair.pool += amt - refund - refunded;
      } else if (kind === 1) {
        const covered = Math.min(pair.pool, amt);
        if (covered > 0) { pair.pool -= covered; pair.recs.push([pos, covered, amt]); }
        const netted = covered > 0 && covered >= amt * coveredShareToNet;
        note(p, pos, netted);
        // A netted payment is never refundable: its refund would launder the loop.
        if (!netted) addRefundable(ws, p, pos, amt, amt - covered);
      } else {
        // Uncounted money from the payer: it pays back the pool first, the
        // rest is the payer's credit.
        const back = Math.min(pair.pool, amt);
        pair.pool -= back;
        pair.credit = (pair.credit || 0) + amt - back;
      }
    }
  }
  ws.through = limit;
}
// A wallet just worked: the progress it was worked from is spent (its payers
// are known, its credits and its gap accounted for), and when reads were
// needed for it and all completed, its read accounting starts over.
function clearConsumedProgress(ws, { read }) {
  const keep = [];
  for (const g of ws.hp || []) {
    if (g.k === "g") continue;
    const stay = (p) => (g.k === "c" ? ws.pairs.has(p) && !ws.pairs.get(p).h : !ws.known.has(p));
    if (g.p.every(stay)) { keep.push(g); continue; }
    const logs = segmentLogs(g);
    const payers = g.p.filter(stay);
    if (payers.length) keep.push(newSegment(g.k, g.h, payers, g.lo, g.w, new Map([...logs].filter(([p]) => payers.includes(p))), g.pg));
  }
  ws.hp = keep;
  if (read) { ws.ep = null; ws.st = 0; ws.td = null; }
}
// Past the per-wallet cap, forget the idlest known payers with no pool and not
// paying this scan (they are read again from their history if they pay).
function evictKnown(ws, current, maxKnownPerWallet) {
  if (ws.known.size <= maxKnownPerWallet) return;
  const idle = [...ws.known].filter(([p]) => !ws.pairs.has(p) && !current.has(p)).sort((x, y) => Math.max(x[1][0], x[1][1], x[1][2]) - Math.max(y[1][0], y[1][1], y[1][2]));
  for (const [p] of idle.slice(0, ws.known.size - maxKnownPerWallet)) ws.known.delete(p);
}
// Keep only what a later scan's window can still contain, and forget a pair
// with nothing left in it (its payer stays known).
function trimWallet(ws, windowStartBlock, maxRecordsPerWallet) {
  const keepFrom = posOf(windowStartBlock, 0);
  let recs = 0;
  for (const [p, pair] of ws.pairs) {
    if (pair.recs.length && pair.recs[0][0] < keepFrom) pair.recs = pair.recs.filter(([pos]) => pos >= keepFrom);
    if (pair.rf?.length && pair.rf[0][0] < keepFrom) pair.rf = pair.rf.filter(([pos]) => pos >= keepFrom);
    recs += pair.recs.length + (pair.rf?.length || 0);
    if (pair.pool <= 0 && !pair.recs.length && !pair.rf?.length && !pair.pend.length && !(pair.credit > 0)) ws.pairs.delete(p);
  }
  if (recs > maxRecordsPerWallet) {
    const cut = [...ws.pairs.values()].flatMap((pair) => pair.recs.map((r) => r[0])).sort((a, b) => a - b)[recs - maxRecordsPerWallet];
    for (const pair of ws.pairs.values()) pair.recs = pair.recs.filter(([pos]) => pos >= cut);
    ws.truncated = true;
  }
}

/**
 * What the wallet netted over the Bazaar's window ending at `latest`: payments
 * netted (by day, so up to a day wider), and payers that paid it only with its
 * own money inside the window. Counts only.
 */
export function selfFundedOver(ws, latest, { windowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks } = {}) {
  if (!ws || !Number.isFinite(latest)) return { calls: 0, payers: 0, refunded: 0 };
  const cutBlock = Math.max(0, latest - windowBlocks);
  const cutDay = Math.floor(cutBlock / bucketBlocks);
  let calls = 0, refunded = 0;
  for (const [day, n] of ws.netted) if (day >= cutDay) calls += n;
  for (const [day, n] of ws.refunded || []) if (day >= cutDay) refunded += n;
  const cut = posOf(cutBlock, 0);
  let payers = 0;
  for (const k of ws.known.values()) if (k[2] >= cut && k[1] < cut) payers++;
  return { calls, payers, refunded };
}

/**
 * The funding figures for one scanned wallet row, from its state `ws` (null
 * when the wallet has none). Payments past `ws.through` are UNKNOWN: counted
 * as they are, unless the wallet is circular, in which case a wallet not read
 * up to `latest` is credited nothing until it is (a wallet already found to
 * pay itself does not get its unread payments counted as buyers).
 *
 * `carriedAt`: the last verdict from an earlier scan (ISO string or null).
 */
export function sellerFundingFigures(row, ws, { latest, now = Date.now(), carriedAt = null, circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, coveredShareToNet = FUNDING_DEFAULTS.coveredShareToNet, bazaarWindowBlocks = FUNDING_DEFAULTS.bazaarWindowBlocks, bucketBlocks = FUNDING_DEFAULTS.bucketBlocks } = {}) {
  const through = ws ? ws.through : -Infinity;
  const caughtUp = !!ws && through >= endOfBlock(latest);
  const grossCalls = row.callsSettled || 0;
  const grossBuyers = row.perPayer ? row.perPayer.size : 0;
  const grossMicro = Math.round((Number(row.totalUsd) || 0) * 1e6);
  let fundedCalls = 0, fundedMicro = 0, unknownMicro = 0, netPayers = 0, refundedCalls = 0, refundedMicro = 0, refundedPayers = 0;
  for (const [p0, v] of row.perPayer || []) {
    const pair = ws?.pairs.get(lower(p0));
    const covered = pair && pair.recs.length ? new Map(pair.recs.map(([pos, c]) => [pos, c])) : null;
    const back = pair && pair.rf?.length ? new Map(pair.rf.map(([pos, r]) => [pos, r])) : null;
    let netted = false;
    const pos = Array.isArray(v?.pos) ? v.pos : [];
    const micro = Array.isArray(v?.micro) ? v.micro : [];
    const each = v?.calls ? Math.round((Number(v.usd) || 0) * 1e6 / v.calls) : 0;
    // Payments with no chain position have nothing to net them against.
    let genuine = pos.length < (v?.calls || 0);
    for (let i = 0; i < pos.length; i++) {
      const b = Number.isFinite(micro[i]) ? micro[i] : each;
      if (pos[i] > through) { unknownMicro += b; genuine = true; continue; }
      // A refunded payment did not happen as revenue: not a call, not
      // self-funding, and not in the dollars the share is judged on.
      const r = Math.min(b, back?.get(pos[i]) || 0);
      if (r > 0 && r >= b * coveredShareToNet) { refundedCalls++; refundedMicro += b; continue; }
      refundedMicro += r;
      const c = covered?.get(pos[i]) || 0;
      fundedMicro += c;
      if (c > 0 && c >= b * coveredShareToNet) { fundedCalls++; netted = true; }
      else genuine = true;
    }
    if (genuine) netPayers++;
    else if (!netted) refundedPayers++;
  }
  const knownMicro = Math.max(0, grossMicro - unknownMicro - refundedMicro);
  const circularNow = knownMicro > 0 && fundedMicro * 2 > knownMicro;
  const nowIso = new Date(now).toISOString();
  const carried = typeof carriedAt === "string" && now - Date.parse(carriedAt) < circularWindowMs ? carriedAt : null;
  const lastCircularAt = circularNow ? nowIso : carried;
  // A circular wallet whose reads are behind is credited nothing until they
  // catch up: its unread payments are the ones most likely to be its own.
  const withheldUntilRead = !caughtUp && !!lastCircularAt;
  const over = selfFundedOver(ws, latest, { windowBlocks: bazaarWindowBlocks, bucketBlocks });
  return {
    netCalls: withheldUntilRead ? 0 : Math.max(0, grossCalls - fundedCalls - refundedCalls),
    netPayers: withheldUntilRead ? 0 : netPayers,
    grossCalls, grossBuyers,
    fundedCalls,
    // Payers every one of whose payments in the window was netted.
    fundedPayers: Math.max(0, grossBuyers - netPayers - refundedPayers),
    // Payments removed as refunded (every payment of `refundedPayers` was).
    refundedCalls, refundedPayers, refundedUsd: refundedMicro / 1e6,
    fundedUsd: fundedMicro / 1e6,
    grossUsd: grossMicro / 1e6,
    unknownUsd: unknownMicro / 1e6,
    // The same, over the Bazaar's 30-day window.
    fundedCalls30d: over.calls,
    fundedPayers30d: over.payers,
    refundedCalls30d: over.refunded,
    circular: circularNow,
    lastCircularAt,
    read: caughtUp,
    withheldUntilRead,
    truncated: !!ws?.truncated,
  };
}

/** The wallets whose Bazaar and chain-join figures the router disregards:
 *  circular in the last scan, or in any scan within `circularWindowMs`, and not
 *  cleared by the operator (`cleared`: anything with has(wallet)). */
export function circularWalletsFrom(walletEvidence, { now = Date.now(), circularWindowMs = FUNDING_DEFAULTS.circularWindowMs, cleared = null } = {}) {
  const out = new Set();
  if (!walletEvidence || typeof walletEvidence !== "object") return out;
  const isCleared = (w) => !!(cleared && typeof cleared.has === "function" && cleared.has(w));
  for (const [w0, e] of Object.entries(walletEvidence)) {
    const w = w0.toLowerCase();
    if (isCleared(w)) continue;
    if (e?.circular === true) { out.add(w); continue; }
    const t = typeof e?.lastCircularAt === "string" ? Date.parse(e.lastCircularAt) : NaN;
    if (Number.isFinite(t) && now - t < circularWindowMs) out.add(w);
  }
  return out;
}
