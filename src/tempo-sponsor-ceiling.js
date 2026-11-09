// Our own ceiling on Tempo subscription gas sponsorship.
//
// The subscription sponsor (TEMPO_SUBSCRIPTION_FEE_PAYER_KEY) co-signs the gas
// for every activation and renewal. mppx bounds ONE transaction (its fee-payer
// policy: maxGas and maxTotalFee) and the low-balance alarm watches the
// wallet, but nothing bounded how many transactions the sponsor pays for in a
// day. This module is that bound: a rolling 24 h window of sponsored
// transactions, counted and summed by their fee bound (gas limit x
// maxFeePerGas, the most the transaction can cost the sponsor), shared across
// replicas through src/shared-limits.js.
//
// It sits on the RPC transport of the subscription clients, so it sees the
// exact bytes about to be broadcast: a raw transaction carrying a fee-payer
// signature is admitted into the window before the send, or refused, and a
// refused one never leaves the process. Nothing else about a subscription
// changes: the buyer's authorization, the challenge binding and the period
// accounting run as before, and a refused renewal lands in past_due (backoff,
// grace) exactly like any other failed charge.
//
// Knobs (Railway):
//   MPP_SUB_SPONSOR_DAILY_MAX_TX   sponsored transactions per rolling 24 h (default 100)
//   MPP_SUB_SPONSOR_DAILY_MAX_USD  fee bound per rolling 24 h, in dollars (default 2)
// A malformed or non-positive value keeps the default: a typo never lifts the
// ceiling. A transaction is counted once it is handed to the send, and stays
// counted whatever the RPC answers (a send that timed out may have landed), so
// the window can only over-count, the safe direction.
import { keccak256 } from "viem";
import { Transaction } from "viem/tempo";
import { shared, sharedLimitsEnabled, createMemoryLimits, noteSharedLimitsDegraded } from "./shared-limits.js";

export const SPONSOR_WINDOW_MS = 24 * 3_600_000;
export const SPONSOR_DAILY_MAX_TX_DEFAULT = 100;
export const SPONSOR_DAILY_MAX_USD_DEFAULT = 2;
const NAME = "tempo-sub-sponsor";
const KEY = "all";
const CONTROL = "tempo-sub-sponsor";
// Tempo prices gas in attodollars (1e-18 USD), so gas x maxFeePerGas / 1e12 is
// the fee bound in micro-dollars (1e-6 USD), the unit the window sums.
const ATTO_PER_MICRO = 10n ** 12n;

const positive = (raw, dflt) => {
  const v = Number(String(raw ?? "").trim());
  return String(raw ?? "").trim() && Number.isFinite(v) && v > 0 ? v : dflt;
};
/** The ceiling in force: { maxTx, maxUsd }. */
export function sponsorCeilingLimits(env = process.env) {
  return {
    maxTx: Math.floor(positive(env.MPP_SUB_SPONSOR_DAILY_MAX_TX, SPONSOR_DAILY_MAX_TX_DEFAULT)),
    maxUsd: positive(env.MPP_SUB_SPONSOR_DAILY_MAX_USD, SPONSOR_DAILY_MAX_USD_DEFAULT),
  };
}

export class SponsorCeilingError extends Error {
  constructor(message) {
    super(message);
    this.name = "SponsorCeilingError";
    // The JSON-RPC "transaction rejected" code, for any reader that classifies
    // by code. The guard sits outside the transport's own retry loop, so a
    // refusal is one attempt, and its message names no send call or timeout:
    // the subscription engine reads it as a definite failure before any send
    // (never a send-phase ambiguity).
    this.code = -32003;
    this.sponsorCeiling = true;
  }
}

/** For a raw Tempo transaction: is it fee-sponsored, its hash, and its fee bound in micro-dollars. Null when it does not decode. */
export function sponsoredFeeBound(serialized) {
  if (typeof serialized !== "string" || !serialized.startsWith("0x")) return null;
  let tx;
  try { tx = Transaction.deserialize(serialized); } catch { return null; }
  if (!tx || typeof tx !== "object") return null;
  const sponsored = Boolean(tx.feePayerSignature);
  const gas = typeof tx.gas === "bigint" ? tx.gas : 0n;
  const maxFee = typeof tx.maxFeePerGas === "bigint" ? tx.maxFeePerGas : 0n;
  // Rounded up: a fee bound under one micro-dollar still weighs one.
  const atto = gas * maxFee;
  const micro = atto === 0n ? 0n : (atto + ATTO_PER_MICRO - 1n) / ATTO_PER_MICRO;
  return { sponsored, hash: keccak256(serialized), feeMicroUsd: Number(micro) };
}

// This process's own window: what decides when the shared store does not
// answer (never looser than one replica alone).
let local = createMemoryLimits();

async function addToWindow(member, weight, now) {
  const args = { windowMs: SPONSOR_WINDOW_MS, member, weight, now };
  if (sharedLimitsEnabled()) {
    const mine = local.windowAdd(NAME, KEY, args);
    const r = await shared.windowAdd(NAME, KEY, args);
    if (r?.ok) return { r, store: shared };
    noteSharedLimitsDegraded(CONTROL, r);
    return { r: await mine, store: local };
  }
  return { r: await shared.windowAdd(NAME, KEY, args), store: shared };
}

/**
 * Admit one raw transaction into the window, or throw SponsorCeilingError.
 * A transaction with no fee-payer signature is not ours to bound and passes.
 * The same transaction sent twice (a retry) is one entry.
 */
export async function admitSponsoredSend(serialized, { now = Date.now(), env = process.env, log = console.warn } = {}) {
  const bound = sponsoredFeeBound(serialized);
  if (!bound || !bound.sponsored) return { admitted: false, sponsored: false };
  const { maxTx, maxUsd } = sponsorCeilingLimits(env);
  const { r, store } = await addToWindow(bound.hash, bound.feeMicroUsd, now);
  const count = Number(r?.count) || 0;
  const sumMicro = Number(r?.sum) || 0;
  const overCount = count > maxTx;
  const overFee = sumMicro > Math.round(maxUsd * 1e6);
  if (overCount || overFee) {
    const entry = { member: bound.hash, weight: bound.feeMicroUsd };
    await store.windowRemove(NAME, KEY, entry);
    if (store !== local) await local.windowRemove(NAME, KEY, entry);
    const cause = overCount ? "MPP_SUB_SPONSOR_DAILY_MAX_TX" : "MPP_SUB_SPONSOR_DAILY_MAX_USD";
    log(`[mpp-subs] sponsored send refused: the 24 h sponsor ceiling (${cause}) is reached; nothing broadcast`);
    throw new SponsorCeilingError(`subscription gas sponsorship refused: the 24 h sponsor ceiling (${cause}) is reached`);
  }
  return { admitted: true, sponsored: true, count, feeMicroUsd: bound.feeMicroUsd };
}

const SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendRawTransactionSync"]);
/** Wrap a viem transport so every raw send passes admitSponsoredSend first. */
export function withSponsorCeiling(transport, opts = {}) {
  return (config) => {
    const t = transport(config);
    const request = async (args, options) => {
      if (args && SEND_METHODS.has(args.method)) await admitSponsoredSend(args.params?.[0], opts);
      return t.request(args, options);
    };
    return { ...t, request };
  };
}

/** The word for /api/gateway-status: ok, reached (a new sponsored send would be refused), or unknown. */
export async function sponsorCeilingWord({ now = Date.now(), env = process.env } = {}) {
  try {
    let r = await shared.windowRead(NAME, KEY, { windowMs: SPONSOR_WINDOW_MS, now });
    if (!r?.ok) r = await local.windowRead(NAME, KEY, { windowMs: SPONSOR_WINDOW_MS, now });
    if (!r?.ok) return "unknown";
    const { maxTx, maxUsd } = sponsorCeilingLimits(env);
    return (Number(r.count) || 0) >= maxTx || (Number(r.sum) || 0) >= Math.round(maxUsd * 1e6) ? "reached" : "ok";
  } catch { return "unknown"; }
}

/** Test seam: empty both windows. */
export async function _resetSponsorCeiling() {
  local = createMemoryLimits();
  await shared.windowClear(NAME, KEY);
}
