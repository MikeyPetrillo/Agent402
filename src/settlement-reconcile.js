// Settlement reconciliation: did the money we were told arrived actually arrive?
//
// WHY THIS EXISTS. Settlement is delegated to a facilitator, and we take its
// word for it. `@x402/express` settles after the handler and only for a <400
// response, so a 200 means "the facilitator said this settled" — not "USDC
// moved". Those are different claims, and until this check there was no
// surface anywhere that compared them.
//
// Measured 2026-08-06, Solana: 100 settlements recorded on 08-05 against 89
// transfers on-chain, and 63 against 47 on 08-04. Same buyer throughout, 100
// distinct timestamps (so not replayed), one token account (so nothing was
// missed by looking in the wrong place), and the revenue ledger matched the
// chain exactly on every EVM rail. The gap is settlements that were reported
// successful and never landed: 11% of that rail's calls one day, 25% the next.
// We ran the tool, returned the answer, and were not paid.
//
// This is the mirror of the Stellar defect. There the facilitator reported
// FAILURE for transfers that confirmed, so we did the work and withheld the
// result. Here it reports SUCCESS for transfers that do not, so we do the work
// and hand it over. The first was visible because buyers complained; this one
// is silent, which is why it needs a monitor rather than a bug report.
//
// Amounts are per-call micropayments by design. A rate is the honest unit here,
// not a dollar total: "11 of 100 settlements unconfirmed" is the finding, and
// it stays true whether the tool costs $0.001 or $0.25.
//
// NOT a serving-path fix. The buyer has already been handed the result by the
// time this could run, and blocking a response on chain confirmation would add
// seconds to every call. This detects and reports; it never withholds and never
// tries to claw back.
import { claimedSettlements } from "./sales-ledger.js";
import { onchainTxHashes, ledgerTrackedChains } from "./revenue-ledger.js";
import { getDailyCalls } from "./stats.js";
import { rpcCall } from "./revenue-live.js";
import { SOLANA_RPCS } from "./solana-history-rpc.js";

// A settlement recorded seconds ago has not had time to be scanned, and would
// read as missing. Only rows older than this are judged; anything newer is
// reported separately as pending rather than counted either way.
export const SETTLE_GRACE_MS = Number(process.env.RECONCILE_GRACE_MS) || 60 * 60 * 1000;

// SOLANA ROWS ARE READ ON CHAIN BEFORE THEY COUNT AS UNCONFIRMED. The revenue
// ledger's Solana scan can trail the chain (a page behind, a history read that
// failed and retries), so a settlement it lacks is not yet evidence that
// nothing landed. A landed signature is not evidence that WE were paid either:
// a real but unrelated signature, one that paid another account, or one
// claimed by several rows all land. So a row the ledger lacks is matched only
// when all of these hold:
//   - its tx is a well-formed base58 signature (anything else is counted as
//     notSignature and never sent, so it cannot fail a whole batch);
//   - it is the first row in the window carrying that signature (later rows
//     are counted as duplicate: one transfer pays for one row);
//   - getSignatureStatuses reads it confirmed or finalized with no error;
//   - getTransaction (jsonParsed) carries both balance lists and shows our
//     payTo owner's USDC balance (that mint only) rising by at least the row's
//     amount, in atomic units;
//   - the transaction's blockTime is within SOLANA_TX_TIME_WINDOW_MS of the
//     row's recorded time, so an earlier or later transfer into our payTo is
//     never taken as this row's payment.
// Landed but not verifiable (no payTo set, the transaction read failed, was
// empty or missing a balance list, has no blockTime or one outside the window,
// or fell past the pass deadline or read budget) is counted as
// landedUnverified and the row stays as it was: never confirmed. Not found,
// failed on chain, or a transfer that did not pay us the amount stays
// unconfirmed. A status read that fails or answers a malformed list leaves its
// rows as they were, counted as unread; nothing here moves the top-level
// status. The pass has one deadline: no read starts after it, a read in flight
// is cut at it, and every row it did not reach is unread. The deadline counts
// as passed once its timer fires, whatever the wall clock then reads (a timer
// can fire a millisecond before Date.now() reaches the deadline). Reads go through the
// shared Solana RPC list (keyed lane first), so the outbound hard ceilings
// count each one; they do not go through the history lanes, so these reads
// never feed that status word either.
export const SOLANA_CONFIRM_BATCH_MAX = 256; // the method's own per-call limit
const SOLANA_CONFIRM_BATCH = 100;
const SOLANA_CONFIRM_MAX_READS = 5;          // per pass: at most 500 signatures
const SOLANA_VERIFY_MAX_READS = 40;          // per pass: transaction reads
const SOLANA_VERIFY_CONCURRENCY = 4;
const SOLANA_CONFIRM_TIMEOUT_MS = 6000;
export const SOLANA_PASS_DEADLINE_MS = 15_000;
// A row is recorded when its response finishes, right after settlement, so its
// transfer lands within moments of it; five minutes either side covers a slow
// confirmation and clock skew, and nothing a day or an hour away.
export const SOLANA_TX_TIME_WINDOW_MS = 5 * 60_000;
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Base58 alphabet, case preserved (never case-fold a base58 value).
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
export const isSolanaSignature = (s) => typeof s === "string" && SIGNATURE_RE.test(s);

/** Statuses for `sigs`, aligned by index (null = not found). Throws on failure. */
async function solanaSignatureStatuses(sigs, { deadline } = {}) {
  const res = await rpcCall(SOLANA_RPCS, "getSignatureStatuses", [sigs, { searchTransactionHistory: true }], SOLANA_CONFIRM_TIMEOUT_MS, { deadline });
  return res?.value;
}

/** The parsed transaction for `sig` (null = not found). Throws on failure. */
async function solanaTransaction(sig, { deadline } = {}) {
  return rpcCall(SOLANA_RPCS, "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], SOLANA_CONFIRM_TIMEOUT_MS, { deadline });
}

const landedOk = (s) => Boolean(s) && s.err == null && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");

/** Atomic USDC credited to `owner` by a parsed transaction; null when unreadable. */
export function usdcAtomicCredit(txn, owner, mint = USDC_SOL_MINT) {
  const meta = txn?.meta;
  if (!meta || meta.err != null || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return null;
  const sum = (rows) => {
    let t = 0n;
    for (const b of rows) {
      if (!b || b.owner !== owner || b.mint !== mint) continue;
      const a = b.uiTokenAmount?.amount;
      if (typeof a !== "string" || !/^\d+$/.test(a)) return null;
      t += BigInt(a);
    }
    return t;
  };
  const post = sum(meta.postTokenBalances), pre = sum(meta.preTokenBalances);
  return post == null || pre == null ? null : post - pre;
}

const atomicUsdc = (usd) => BigInt(Math.round((Number(usd) || 0) * 1e6));

/** True when the transaction's blockTime (unix seconds) is near the row's ts (ms). */
export const nearRowTime = (txn, ts) =>
  typeof txn?.blockTime === "number" && Number.isFinite(txn.blockTime) && Number.isFinite(Number(ts)) &&
  Math.abs(txn.blockTime * 1000 - Number(ts)) <= SOLANA_TX_TIME_WINDOW_MS;

/**
 * The pass deadline. `passed()` is true once the wall clock reaches it or once
 * a race against it has been cut by its timer, whichever comes first.
 */
function passDeadline(ms) {
  const at = Date.now() + ms;
  let fired = false;
  const passed = () => fired || Date.now() >= at;
  /** Resolves `p`, or rejects once the deadline passes (the timer never outlives it). */
  const race = (p) => {
    const left = at - Date.now();
    if (fired || left <= 0) { fired = true; return Promise.reject(new Error("deadline passed")); }
    let t;
    return Promise.race([
      Promise.resolve(p).finally(() => clearTimeout(t)),
      new Promise((_, reject) => { t = setTimeout(() => { fired = true; reject(new Error("deadline passed")); }, left); }),
    ]);
  };
  return { at, passed, race };
}

async function confirmSolanaRows(rows, { confirm, readTransaction, payTo, batchSize, maxReads, verifyMaxReads, deadlineMs }) {
  const out = {
    checked: rows.length, reads: 0, readsFailed: 0, matched: 0, notFound: 0, failedOnChain: 0, unread: 0,
    notSignature: 0, duplicate: 0, txReads: 0, landedUnverified: 0, transferMismatch: 0, deadlineHit: false,
  };
  const verdict = new Map(); // row -> "matched" | "unconfirmed"; absent = as it was
  const dl = passDeadline(Math.max(0, Number(deadlineMs ?? SOLANA_PASS_DEADLINE_MS) || 0));
  const deadline = dl.at;
  const size = Math.min(Math.max(1, Math.floor(Number(batchSize)) || SOLANA_CONFIRM_BATCH), SOLANA_CONFIRM_BATCH_MAX);
  const budget = Math.max(0, Math.floor(Number(maxReads ?? SOLANA_CONFIRM_MAX_READS)) || 0);
  const verifyBudget = Math.max(0, Math.floor(Number(verifyMaxReads ?? SOLANA_VERIFY_MAX_READS)) || 0);

  // One row per signature: the first claim is read, later ones are duplicates.
  const firstBySig = new Map();
  for (const r of rows) {
    const sig = String(r.tx);
    if (!isSolanaSignature(sig)) { out.notSignature++; continue; }
    if (firstBySig.has(sig)) { out.duplicate++; verdict.set(r, "unconfirmed"); continue; }
    firstBySig.set(sig, r);
  }
  const candidates = [...firstBySig.values()];

  const landed = [];
  for (let i = 0; i < candidates.length; i += size) {
    const batch = candidates.slice(i, i + size);
    if (out.reads >= budget) { out.unread += batch.length; continue; }
    if (dl.passed()) { out.deadlineHit = true; out.unread += batch.length; continue; }
    out.reads++;
    let statuses;
    try { statuses = await dl.race(confirm(batch.map((r) => String(r.tx)), { deadline })); } catch { statuses = null; }
    if (!Array.isArray(statuses) || statuses.length !== batch.length) {
      if (dl.passed()) out.deadlineHit = true;
      out.readsFailed++; out.unread += batch.length; continue;
    }
    batch.forEach((r, k) => {
      const s = statuses[k];
      if (landedOk(s)) landed.push(r);
      else if (s && s.err != null) { out.failedOnChain++; verdict.set(r, "unconfirmed"); }
      else if (!s) { out.notFound++; verdict.set(r, "unconfirmed"); }
      else out.unread++; // seen but not yet confirmed: undecided, left as it was
    });
  }

  // Landed: matched only when the transaction pays our payTo the row's amount.
  let next = 0;
  const verifyOne = async (r) => {
    if (!payTo || out.txReads >= verifyBudget) { out.landedUnverified++; return; }
    if (dl.passed()) { out.deadlineHit = true; out.landedUnverified++; return; }
    out.txReads++;
    let credit = null;
    try {
      const txn = await dl.race(readTransaction(String(r.tx), { deadline }));
      credit = nearRowTime(txn, r.ts) ? usdcAtomicCredit(txn, payTo) : null;
    } catch { credit = null; }
    if (credit == null) { if (dl.passed()) out.deadlineHit = true; out.landedUnverified++; return; }
    const owed = atomicUsdc(r.usd);
    if (owed > 0n && credit >= owed) { out.matched++; verdict.set(r, "matched"); }
    else { out.transferMismatch++; verdict.set(r, "unconfirmed"); }
  };
  const worker = async () => { while (next < landed.length) await verifyOne(landed[next++]); };
  await Promise.all(Array.from({ length: Math.min(SOLANA_VERIFY_CONCURRENCY, landed.length) }, worker));
  return { verdict, reads: out };
}

/**
 * Compare recorded settlements against transfers seen on-chain.
 *
 * Every row lands in exactly one bucket, and the buckets that mean "we cannot
 * tell" are named rather than folded into either answer — the failure this
 * codebase keeps re-learning is an unreadable result being counted as a clean
 * one.
 *
 * @param {object}   [opts]
 * @param {number}   [opts.days=7]      window to reconcile
 * @param {number}   [opts.now]         injectable clock (tests)
 * @param {function} [opts.dailyCalls]  injectable cross-check counter. Exists so
 *   the UNREADABLE-counter branch is reachable from a test: ESM namespace
 *   objects are frozen, so stubbing the import is impossible, and an untestable
 *   failure path is how the first version of this guard shipped broken.
 * @param {function} [opts.confirmSignatures]  injectable Solana status reader
 *   (sigs -> statuses aligned by index, null = not found; throws on failure)
 * @param {number}   [opts.solanaBatchSize]   signatures per read (held to SOLANA_CONFIRM_BATCH_MAX)
 * @param {number}   [opts.solanaMaxReads]    status reads per pass
 * @param {function} [opts.readTransaction]   injectable Solana transaction reader
 *   (sig -> jsonParsed transaction, null = not found; throws on failure)
 * @param {string}   [opts.solanaPayTo]       our Solana payTo owner (SOLANA_WALLET_ADDRESS)
 * @param {number}   [opts.solanaVerifyMaxReads] transaction reads per pass
 * @param {number}   [opts.solanaDeadlineMs]  the Solana reads' pass deadline
 * @returns {Promise<{asOf:string, status:string, blind:boolean, chains:object[], totals:object}>}
 */
export async function reconcileSettlements({
  days = 7, now = Date.now(), dailyCalls = getDailyCalls,
  confirmSignatures = solanaSignatureStatuses, solanaBatchSize = SOLANA_CONFIRM_BATCH, solanaMaxReads = SOLANA_CONFIRM_MAX_READS,
  readTransaction = solanaTransaction, solanaPayTo = (process.env.SOLANA_WALLET_ADDRESS || "").trim() || null,
  solanaVerifyMaxReads = SOLANA_VERIFY_MAX_READS, solanaDeadlineMs = SOLANA_PASS_DEADLINE_MS,
} = {}) {
  const since = now - days * 86_400_000;
  const cutoff = now - SETTLE_GRACE_MS;
  const rows = claimedSettlements(since, now);
  const tracked = ledgerTrackedChains();

  const byChain = new Map();
  for (const r of rows) {
    const chain = r.network || "(unknown)";
    if (!byChain.has(chain)) {
      byChain.set(chain, { chain, claimed: 0, confirmed: 0, unconfirmed: 0, pending: 0, noTx: 0, unconfirmedUsd: 0, samples: [] });
    }
    const c = byChain.get(chain);
    c.claimed++;
    // No tx to check. Not a discrepancy and NOT a confirmation - some rails
    // return a receipt without a hash, and calling that "confirmed" would be
    // the same wishful accounting this module exists to stop.
    if (!r.tx) { c.noTx++; continue; }
    if (r.ts >= cutoff) { c.pending++; continue; }
    if (!tracked.has(chain)) continue; // classified per-chain below, not per-row
    const seen = c._seen || (c._seen = onchainTxHashes(chain));
    if (seen.has(r.tx)) c.confirmed++;
    else (c._unmatched || (c._unmatched = [])).push(r);
  }

  for (const c of byChain.values()) {
    let unmatched = c._unmatched || [];
    if (c.chain === "solana" && unmatched.length) {
      const { verdict, reads } = await confirmSolanaRows(unmatched, {
        confirm: confirmSignatures, readTransaction, payTo: solanaPayTo,
        batchSize: solanaBatchSize, maxReads: solanaMaxReads, verifyMaxReads: solanaVerifyMaxReads, deadlineMs: solanaDeadlineMs,
      });
      c.signatureReads = reads;
      c.landedUnverified = reads.landedUnverified;
      c.confirmed += reads.matched;
      unmatched = unmatched.filter((r) => verdict.get(r) !== "matched");
    }
    for (const r of unmatched) {
      c.unconfirmed++;
      c.unconfirmedUsd += Number(r.usd) || 0;
      if (c.samples.length < 5) c.samples.push({ slug: r.slug, usd: r.usd, tx: String(r.tx).slice(0, 16) + "…", at: new Date(r.ts).toISOString() });
    }
  }

  const chains = [...byChain.values()].map((c) => {
    delete c._seen;
    delete c._unmatched;
    const t = tracked.get(c.chain);
    // An unscanned chain cannot be reconciled. Say that, loudly, instead of
    // reporting its settlements as missing money.
    const scanned = Boolean(t);
    const judged = c.confirmed + c.unconfirmed;
    return {
      ...c,
      unconfirmedUsd: +c.unconfirmedUsd.toFixed(6),
      scanned,
      caughtUp: t ? t.caughtUp : null,
      // The headline. A rate, because these are micropayments and a dollar
      // total makes a systemic failure look like a rounding error.
      unconfirmedPct: judged ? +((c.unconfirmed / judged) * 100).toFixed(2) : null,
      note: scanned
        ? (judged ? null : "nothing judged yet in this window (all pending or without a tx)")
        : "NOT RECONCILED - no on-chain cursor for this chain, so its settlements are unverifiable here",
    };
  }).sort((a, b) => (b.unconfirmed - a.unconfirmed) || a.chain.localeCompare(b.chain));

  const sum = (k) => chains.reduce((s, c) => s + (c[k] || 0), 0);
  const judgedAll = sum("confirmed") + sum("unconfirmed");

  // IS THIS CHECK ACTUALLY LOOKING AT ANYTHING?
  //
  // The reconciliation reads the sales ledger in the state database. If that
  // store were lost, reset, or simply never written to, the join finds
  // nothing and reports zero unconfirmed — which renders identically to a
  // perfectly healthy service. That is this repo's oldest failure shape (a
  // charged-failure alarm sat dead for months reporting success), reappearing
  // one level up inside the very module built to avoid it.
  //
  // So cross-check against an INDEPENDENT counter: stats.js bumps daily_calls
  // in the same transaction as the lifetime odometer, in a different SQLite
  // file. If it says paid calls were served in this window while the ledger
  // offers nothing to judge, the check is BLIND and must say so loudly rather
  // than return a clean-looking zero.
  const dayKeys = new Set();
  for (let t = since; t <= now; t += 86_400_000) dayKeys.add(new Date(t).toISOString().slice(0, 10));
  dayKeys.add(new Date(now).toISOString().slice(0, 10));
  let paidCallsInWindow = 0;
  let counterReadable = true;
  try {
    for (const d of dailyCalls()) if (dayKeys.has(d.day)) paidCallsInWindow += d.usdc || 0;
  } catch { counterReadable = false; paidCallsInWindow = null; }

  // Nothing to judge is only reassuring if we can PROVE there was nothing to
  // judge. Two ways that proof fails, and both must read BLIND:
  //   - the odometer counted paid calls the ledger cannot account for
  //   - the odometer itself is unreadable, so "no traffic" and "no ledger" are
  //     indistinguishable
  // The first cut of this guard set the unreadable case to -1 and then tested
  // `> 0`, so a dead counter fell through to "ok" - the module's own failure
  // mode, reintroduced inside the fix for it, three lines under a comment
  // promising otherwise.
  const nothingJudged = sum("claimed") === 0;
  const blind = nothingJudged && (!counterReadable || paidCallsInWindow > 0);

  return {
    asOf: new Date(now).toISOString(),
    windowDays: days,
    graceMinutes: Math.round(SETTLE_GRACE_MS / 60000),
    // Loud by construction. An operator or alarm reading only `status` still
    // learns that the answer below cannot be trusted.
    status: blind ? "BLIND" : "ok",
    blind,
    blindReason: !blind ? null
      : counterReadable
        ? `the odometer counted ${paidCallsInWindow} paid call(s) in this window but the sales ledger holds no settlements to reconcile - the check is looking at nothing, which is NOT the same as finding nothing wrong`
        : "the sales ledger holds no settlements to reconcile AND the independent call counter is unreadable, so 'no traffic' cannot be told apart from 'no data' - treat this result as unverified",
    counterReadable,
    paidCallsInWindow,
    chains,
    totals: {
      claimed: sum("claimed"),
      confirmed: sum("confirmed"),
      unconfirmed: sum("unconfirmed"),
      pending: sum("pending"),
      noTx: sum("noTx"),
      // Landed on chain but not shown to pay us; these rows are inside `unconfirmed`.
      landedUnverified: sum("landedUnverified"),
      unconfirmedUsd: +sum("unconfirmedUsd").toFixed(6),
      unconfirmedPct: judgedAll ? +((sum("unconfirmed") / judgedAll) * 100).toFixed(2) : null,
      unscannedChains: chains.filter((c) => !c.scanned).map((c) => c.chain),
    },
  };
}
