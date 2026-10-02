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
// INFLIGHT_COVER=off disables the check.

import { paymentHeaderOf } from "./payer.js";

const CHAIN_BY_CAIP2 = Object.freeze({
  "eip155:8453": "base", "eip155:137": "polygon", "eip155:42161": "arbitrum", "eip155:143": "monad",
  "eip155:42220": "celo", "eip155:43114": "avalanche", "eip155:1329": "sei", "eip155:10": "optimism",
  "eip155:4663": "robinhood",
});
const CAIP2_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(CHAIN_BY_CAIP2).map(([c, n]) => [n, c])));

const CACHE_MS = 10_000;
const READ_TIMEOUT_MS = 2_500;
const MAX_READS_IN_FLIGHT = 8;
const SETTLE_WAIT_MS = 5_000;
const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;

const ledger = new Map(); // coverKey -> { count, atomic: bigint, settling }
const waiters = new Map(); // coverKey -> Set<() => void>, woken when a run leaves
const balances = new Map(); // coverKey -> { atomic: bigint, at }
const pendingReads = new Map(); // coverKey -> { p: Promise<bigint|null> }
const judging = new Map(); // coverKey -> Set<{ left }>, runs being judged; release() counts in `left`
let readsInFlight = 0;
// The settled-release of an admitted run, kept on its request (own,
// non-enumerable) for the settle hook, which sees only the request.
const SETTLED = Symbol("a402.inflightCoverSettled");
const stats = { admitted: 0, admittedByRead: 0, admittedUnread: 0, refused: 0, refusedUnread: 0, settleWaits: 0 };

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
  try { p = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")); } catch { return null; }
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

async function balanceFor(coverKey, terms, now) {
  const hit = balances.get(coverKey);
  if (hit && now - hit.at < CACHE_MS) return hit.atomic;
  if (pendingReads.has(coverKey)) return pendingReads.get(coverKey).p;
  if (readsInFlight >= MAX_READS_IN_FLIGHT) return null; // never queue: a full lane reads as unknown
  readsInFlight++;
  const entry = { p: null };
  entry.p = (async () => {
    try {
      const atomic = await reader(terms);
      if (typeof atomic !== "bigint" || atomic < 0n) return null;
      // A run that left while this read was under way detached it (release()
      // drops the pending entry): it may predate that run's settlement, so it
      // is not kept for anyone who asks after the departure.
      if (pendingReads.get(coverKey) === entry) balances.set(coverKey, { atomic, at: Date.now() });
      return atomic;
    } catch { return null; }
    finally { readsInFlight--; if (pendingReads.get(coverKey) === entry) pendingReads.delete(coverKey); }
  })();
  pendingReads.set(coverKey, entry);
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
  const waitUntil = Date.now() + settleWaitMs;
  // `left` counts this wallet's runs that leave the ledger while this one is
  // judged (release() bumps it). Once one has, verify's proof no longer holds
  // and the no-read admission is off: this run is judged on a read.
  const me = { left: 0 };
  const judges = judging.get(coverKey) || new Set();
  judging.set(coverKey, judges);
  judges.add(me);
  try {
    let at = now;
    for (;;) {
      const held = ledger.get(coverKey);
      if (me.left === 0 && (!held || held.count <= 0)) break;
      const leftBefore = me.left;
      const balance = await balanceFor(coverKey, terms, at);
      // A run left while the balance was being read: the read may predate its
      // settlement. Judge again on a read taken after the departure.
      if (me.left !== leftBefore) { at = Date.now(); continue; }
      // Re-read the ledger AFTER the await: other runs may have been admitted
      // meanwhile, and the check and the admission (synchronous, below) must
      // see the same numbers.
      const cur = ledger.get(coverKey) || { count: 0, atomic: 0n, settling: 0 };
      const need = cur.atomic + terms.atomic;
      const unread = balance === null;
      const covered = unread ? cur.count < unreadMax() : balance >= need;
      if (covered) {
        if (unread) stats.admittedUnread++; else stats.admittedByRead++;
        break;
      }
      // A settling run may already be paid for on chain while it still counts
      // here: wait for it to leave, then judge again against a fresh read.
      if (!unread && cur.settling > 0 && Date.now() < waitUntil) {
        stats.settleWaits++;
        await nextRelease(coverKey, waitUntil - Date.now());
        at = Date.now();
        continue;
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
  } finally {
    judges.delete(me);
    if (!judges.size && judging.get(coverKey) === judges) judging.delete(coverKey);
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
    balances.delete(coverKey);
    pendingReads.delete(coverKey);
    const judges = judging.get(coverKey);
    if (judges) for (const j of judges) j.left += 1;
    const set = waiters.get(coverKey);
    if (set) for (const wake of [...set]) wake();
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
  return { enabled: inflightCoverEnabled(), walletsInFlight: ledger.size, runsInFlight: runs, unreadMax: unreadMax(), ...stats };
}

/** Test-only. */
export function _resetInflightCoverForTest() {
  ledger.clear(); balances.clear(); pendingReads.clear(); judging.clear(); readsInFlight = 0; reader = readTokenBalance;
  for (const set of waiters.values()) for (const wake of [...set]) wake();
  waiters.clear();
  for (const k of Object.keys(stats)) stats[k] = 0;
}
