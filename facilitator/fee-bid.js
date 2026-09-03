// The inclusion-fee bid, raised above the vendor's hardcoded network minimum.
//
// WHY (measured 2026-08-31, from 30 days of paid-canary observations):
// rail_stellar sat at 25 up / 15 down (62.5%) while rail_base was 40/40, and
// every failure reduced to one cause. @x402/stellar builds the settlement
// transaction with `fee: BASE_FEE` - 100 stroops, the network MINIMUM - at
// dist/esm/exact/facilitator/index.mjs:159, and that is the bid we take into
// Stellar's fee auction. Horizon /fee_stats at the time of the diagnosis:
// ledger_capacity_usage 0.78, fee_charged p90 9,486. We were bidding 100.
//
// Losing the auction shows up in two shapes, both seen in production and both
// this one cause:
//   - the RPC rejects the submission outright, which rpc-diagnostics.js
//     decoded as {"code":"txInsufficientFee"}, and the vendor reports
//     "settle_exact_stellar_transaction_submission_failed";
//   - or the submission is accepted (PENDING), is outbid for the following
//     ledgers, is dropped, and the vendor reports
//     "settle_exact_stellar_transaction_failed" after our poll gives up.
// Neither charges the buyer: Horizon showed no debit for either failed hash,
// so this is a rail-proof failure, not a money failure. The poll cap in
// settle-poll.js is NOT implicated - those transactions never landed at all,
// so polling longer would have bought nothing.
//
// WHY RAISING THE BID IS NEARLY FREE: Stellar charges the auction's CLEARING
// price, not your bid. The same /fee_stats read shows max_fee p50 67,136
// against fee_charged p50 100 - most bidders pay the minimum while bidding
// far above it. So a generous bid costs nothing on a quiet ledger and buys
// inclusion on a busy one. The bid is a CEILING on what we can be charged,
// which is why it is capped rather than unbounded.
//
// WHERE THE PATCH GOES: the vendor imports TransactionBuilder and BASE_FEE as
// ESM bindings we cannot reassign, and constructs the builder inline, so the
// constructor argument is out of reach. TransactionBuilder stores the bid as
// its own `baseFee` property and reads it in build(), so build() is the
// interception point - the same prototype-patch seam rpc-timeout.js,
// rpc-diagnostics.js, rpc-failover.js and settle-poll.js already use, and for
// the same reason (the vendor gives us no injection point).
//
// NOTE we do not configure a feeBumpSigner, so the vendor submits the inner
// transaction it builds here. If one is ever configured, the fee bump is built
// by TransactionBuilder.buildFeeBumpTransaction with the same hardcoded
// BASE_FEE and would need its own patch - assertFeeBumpUnpatched() below
// exists so that stays a loud discovery rather than a silent regression.
import { TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";

/** The vendor's hardcoded bid. We only ever raise a builder sitting AT the
 *  network minimum: anything bidding above it was set deliberately by some
 *  other caller and is not ours to override. */
export const VENDOR_BID_STROOPS = Number(BASE_FEE);

/** Default bid, in stroops, per operation. Chosen to clear the measured
 *  fee_charged p90 (9,486) with room, while capping worst-case exposure at
 *  0.005 XLM (~$0.0015) on a settlement whose typical charge stays 100
 *  stroops. Deliberately a fixed bid rather than a /fee_stats read: an
 *  adaptive bid would put a network call in the settle path, and the
 *  clearing-price rule means the extra precision buys nothing. */
export const DEFAULT_BID_STROOPS = 50_000;

/** Parse FACILITATOR_INCLUSION_FEE_STROOPS. "off"/"0" disables the patch and
 *  restores the vendor's minimum bid. A malformed value falls back to the
 *  DEFAULT, never to disabled: silently reverting to 100 would restore the
 *  very defect this module exists to fix, and a typo must not do that. */
export function resolveBidStroops(raw, { log = console.warn } = {}) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "") return DEFAULT_BID_STROOPS;
  if (value === "off" || value === "0") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    log(`[fee-bid] FACILITATOR_INCLUSION_FEE_STROOPS is not a whole number of stroops: ${JSON.stringify(raw)} - using the default ${DEFAULT_BID_STROOPS}`);
    return DEFAULT_BID_STROOPS;
  }
  return n;
}

/** Patch TransactionBuilder.prototype.build so a builder still carrying the
 *  vendor's network-minimum bid goes out at `bidStroops` instead. Returns
 *  false when the patch is a no-op (disabled, or a bid that would not raise
 *  anything), so the caller can say so at startup instead of implying a
 *  protection that is not installed. */
export function installFeeBid({
  bidStroops = DEFAULT_BID_STROOPS,
  raiseAtOrBelow = VENDOR_BID_STROOPS,
  builder = TransactionBuilder,
  log = console.log,
} = {}) {
  const bid = Number(bidStroops);
  if (!Number.isFinite(bid) || bid <= raiseAtOrBelow) return false;
  const proto = builder?.prototype;
  if (!proto || typeof proto.build !== "function") return false;
  if (proto.__a402FeeBidInstalled) return false;

  const original = proto.build;
  proto.build = function buildWithFeeBid() {
    const current = Number(this.baseFee);
    // Only ever raise, and only from the vendor's minimum. A builder bidding
    // above raiseAtOrBelow made that choice on purpose; a NaN baseFee is not
    // ours to interpret.
    if (Number.isFinite(current) && current <= raiseAtOrBelow) this.baseFee = String(bid);
    return original.call(this);
  };
  proto.__a402FeeBidInstalled = true;
  log(`[startup] Stellar inclusion-fee bid installed: ${bid} stroops per operation (vendor default ${raiseAtOrBelow}; Stellar charges the auction clearing price, so this is a ceiling, not a cost)`);
  return true;
}

/** The fee-bump path carries its own hardcoded BASE_FEE that build() never
 *  sees. We do not configure a feeBumpSigner today, so it is unreachable - but
 *  if that ever changes, the bid silently drops back to 100 on the transaction
 *  we actually submit. Call this with the live scheme so the gap announces
 *  itself instead of reappearing as a 37% failure rate. */
export function assertFeeBumpUnpatched(scheme, { log = console.warn } = {}) {
  if (!scheme?.feeBumpSigner) return true;
  log("[fee-bid] WARNING: a feeBumpSigner is configured, and the fee bump is built with the vendor's hardcoded BASE_FEE (100 stroops) which this patch cannot reach. The submitted transaction bids the network minimum again - see facilitator/fee-bid.js.");
  return false;
}
