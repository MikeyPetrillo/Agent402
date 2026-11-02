// A Solana payment refused because the paying wallet is not funded, said so,
// and a loop on it slowed down.
//
// A Solana x402 payment from a wallet with no USDC token account, or with
// less USDC than the price, fails the facilitator's verify in simulation:
// `...simulation_failed: ... InstructionError:[2 InvalidAccountData]` (the
// transfer's source account does not exist) or `[2 map[Custom:1]]` (the SPL
// token program's InsufficientFunds). Instruction 2 is the TransferChecked in
// every exact-scheme transaction (compute limit, compute price, transfer).
// The 402 then said "sign a fresh authorization", and clients did, every few
// seconds, for as long as the wallet stayed empty: a fresh signature cannot
// change a balance.
//
// Two parts:
//   1. classifySvmFundingRefusal names the two cases from the facilitator's
//      own text, and fundingHint words them for the buyer: what is missing,
//      what to do (fund the wallet with USDC on Solana, or pay on another
//      network in accepts, or proof-of-work where the route offers it),
//      `retry: "fund-wallet"` and a Retry-After of RETRY_AFTER_S. The
//      classification reads the refusal text only, never a balance.
//   2. After HOLD_AFTER identical refusals (same network, same paying
//      authority and source token account, same case) inside WINDOW_MS, the
//      next attempts from that wallet are answered with the same funding 402
//      from a beforeVerify hook, without asking the facilitator, until a hold
//      of RETRY_AFTER_S passes. The hold never outlives the Retry-After the
//      buyer was given, so a wallet funded and retried after it reaches
//      verify; a valid verify for the wallet clears its window and holds.
//
// The throttle key is the transfer's authority AND its source token account,
// read from the signed transaction (src/svm-payer.js). A transaction that names
// someone else's wallet as authority but a source account that is not theirs
// holds only that (authority, source) pair, never the wallet's real account.
// A transaction whose transfer accounts cannot be read is never held.
//
// State: src/shared-limits.js (Redis across replicas), falling back to this
// process's own memory when the shared store does not answer. A hold answer is
// a verify refusal: no handler ran, nothing settled, and no settle-failure
// breaker or composite guard sees it.
import { createHash } from "node:crypto";
import { shared, createMemoryLimits } from "./shared-limits.js";
import { svmTransferAccounts, svmPayerFromPayload } from "./svm-payer.js";
import { envPositive } from "./env-num.js";

/** Seconds a funding refusal asks the buyer to wait, and the hold's length (SVM_FUNDING_RETRY_AFTER_S). */
export const RETRY_AFTER_S = () => Math.round(envPositive("SVM_FUNDING_RETRY_AFTER_S", 300));
/** Identical refusals inside the window before verify is held (SVM_FUNDING_HOLD_AFTER). */
export const HOLD_AFTER = () => Math.round(envPositive("SVM_FUNDING_HOLD_AFTER", 3));
/** The window the refusals are counted in (SVM_FUNDING_WINDOW_MS). */
export const WINDOW_MS = () => envPositive("SVM_FUNDING_WINDOW_MS", 10 * 60_000);
/** SVM_FUNDING_THROTTLE=off answers every attempt through verify (the hint stays). */
export const throttleEnabled = (env = process.env) => !/^(0|off|false|no)$/i.test(String(env.SVM_FUNDING_THROTTLE ?? "").trim());

/** The refusal reason the beforeVerify hold answers with (the PAYMENT-REQUIRED `error`). */
export const HOLD_REASON = "wallet_not_funded";

/** The two cases, as the refusal class a 402 names in `reason`. */
export const FUNDING_REASONS = Object.freeze({ noAccount: "no-token-account", short: "insufficient-funds" });

// "InstructionError:[2 InvalidAccountData]", "[2 map[Custom:1]]",
// {"InstructionError":[2,{"Custom":1}]}, InstructionError(2, Custom(1)).
const IX_ERROR = /InstructionError[^A-Za-z0-9]{0,4}(\d{1,2})[^A-Za-z0-9]{1,6}(?:map\[)?(InvalidAccountData|Custom[^A-Za-z0-9]{0,3}(\d{1,3}))/i;
const TRANSFER_INDEX = 2;
const TOKEN_INSUFFICIENT_FUNDS = 1;

/**
 * The funding case of a Solana verify refusal, or null. Pure; reads only the
 * network and the facilitator's text.
 * @returns {"no-token-account"|"insufficient-funds"|null}
 */
export function classifySvmFundingRefusal({ network, reason } = {}) {
  if (!/^solana:/.test(String(network || ""))) return null;
  const r = String(reason || "").slice(0, 2000);
  if (!/simulation[_ ]failed/i.test(r)) return null;
  const m = r.match(IX_ERROR);
  if (!m || Number(m[1]) !== TRANSFER_INDEX) return null;
  if (/^InvalidAccountData$/i.test(m[2])) return FUNDING_REASONS.noAccount;
  if (m[3] != null && Number(m[3]) === TOKEN_INSUFFICIENT_FUNDS) return FUNDING_REASONS.short;
  return null;
}

const shortAddr = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : null);

/**
 * The buyer-facing words for one funding case. Pure.
 * @returns {{reason:string, retry:"fund-wallet", retryAfterSeconds:number, hint:string}}
 */
export function fundingHint({ kind, payer = null, priceUsd = null, held = false, retryAfterSeconds = RETRY_AFTER_S() } = {}) {
  const who = shortAddr(payer) ? `The paying wallet ${shortAddr(payer)}` : "The paying wallet";
  const price = Number.isFinite(priceUsd) && priceUsd > 0 ? ` ($${priceUsd.toFixed(priceUsd < 0.01 ? 4 : 3)})` : "";
  const what = kind === FUNDING_REASONS.noAccount
    ? `${who} has no USDC token account on Solana, so the transfer cannot run.`
    : `${who} holds less USDC on Solana than this call costs${price}.`;
  const todo = kind === FUNDING_REASONS.noAccount
    ? "Send USDC on Solana to the wallet (receiving USDC creates that account), or pay on another network listed in accepts."
    : "Add USDC on Solana to the wallet, or pay on another network listed in accepts.";
  const when = held
    ? `This repeats the last check for this wallet; the next payment from it is checked again after ${retryAfterSeconds} seconds.`
    : `A new signature from the same wallet is refused the same way until it is funded; try again after funding, at least ${retryAfterSeconds} seconds from now.`;
  return { reason: kind, retry: "fund-wallet", retryAfterSeconds, hint: `${what} Nothing was charged. ${todo} ${when}` };
}

/** The sentence added when the 402 body offers proof-of-work (altPayment). */
export const POW_SENTENCE = "This tool also runs free with proof-of-work: see altPayment.";

/**
 * The throttle key of one Solana payment: network, transfer authority and
 * source token account, hashed. Null when the transfer cannot be read.
 */
export function fundingKeyOf(paymentPayload, network) {
  if (!/^solana:/.test(String(network || ""))) return null;
  const tx = paymentPayload?.payload?.transaction ?? paymentPayload?.transaction;
  const t = svmTransferAccounts(tx);
  if (!t) return null;
  return createHash("sha256").update(`${network}|${t.authority}|${t.source}`).digest("hex").slice(0, 32);
}

/** The paying wallet named by the payment (the transfer's authority, else the non-fee-payer signer). */
export function fundingPayerOf(paymentPayload, { feePayer } = {}) {
  const tx = paymentPayload?.payload?.transaction ?? paymentPayload?.transaction;
  return svmTransferAccounts(tx)?.authority || svmPayerFromPayload(paymentPayload, { feePayer }) || null;
}

// Shared store first, this process's memory when it does not answer.
const local = createMemoryLimits({ keyCap: 10_000 });
let store = shared;
async function op(name, ...args) {
  try {
    const r = await store[name](...args);
    if (r?.ok) return r;
  } catch { /* fall through to memory */ }
  return local[name](...args);
}
const WIN = "svmfund-win";
const HOLD = "svmfund-hold";

/**
 * Count one funding refusal; set the hold when it is the HOLD_AFTER-th inside
 * the window. Returns { count, held }.
 */
export async function noteFundingRefusal({ key, kind, now = Date.now() } = {}) {
  if (!key || !kind || !throttleEnabled()) return { count: 0, held: false };
  const k = `${key}|${kind}`;
  const w = await op("windowAdd", WIN, k, { windowMs: WINDOW_MS(), member: `${now}-${Math.random().toString(36).slice(2, 8)}`, now });
  const count = Number(w?.count) || 0;
  if (count < HOLD_AFTER()) return { count, held: false };
  await op("flagSet", HOLD, k, now + RETRY_AFTER_S() * 1000, { now });
  return { count, held: true };
}

/** The active hold for this payment's wallet: { kind, untilMs } or null. */
export async function fundingHoldOf({ key, now = Date.now() } = {}) {
  if (!key || !throttleEnabled()) return null;
  const kinds = Object.values(FUNDING_REASONS);
  const rows = await Promise.all(kinds.map((kind) => op("flagGet", HOLD, `${key}|${kind}`, { now })));
  let best = null;
  rows.forEach((r, i) => { const until = Number(r?.until) || 0; if (until > now && (!best || until > best.untilMs)) best = { kind: kinds[i], untilMs: until }; });
  return best;
}

/** A valid verify for the wallet: its window and holds go. */
export async function clearFundingState({ key } = {}) {
  if (!key) return;
  await Promise.all(Object.values(FUNDING_REASONS).flatMap((kind) => [
    op("windowClear", WIN, `${key}|${kind}`), op("flagSet", HOLD, `${key}|${kind}`, 0),
  ]));
}

/**
 * The beforeVerify hold and the verify-success clear on an x402 resource
 * server. `remember(paymentPayload, hint)` stores the 402 hint under the
 * payment's credential (src/verify-hint.js); `count(network, kind, held)` is
 * the failure monitor's counter.
 */
export function registerSvmFundingHold(server, { remember, count = () => {}, now = () => Date.now() } = {}) {
  server.onBeforeVerify(async (ctx) => {
    try {
      const network = ctx?.requirements?.network;
      const key = fundingKeyOf(ctx?.paymentPayload, network);
      if (!key) return undefined;
      const t = now();
      const hold = await fundingHoldOf({ key, now: t });
      if (!hold) return undefined;
      const retryAfterSeconds = Math.max(1, Math.ceil((hold.untilMs - t) / 1000));
      const amount = Number(ctx?.requirements?.amount);
      const h = fundingHint({ kind: hold.kind, payer: fundingPayerOf(ctx?.paymentPayload, { feePayer: ctx?.requirements?.extra?.feePayer }), priceUsd: Number.isFinite(amount) ? amount / 1e6 : null, held: true, retryAfterSeconds });
      try { remember?.(ctx?.paymentPayload, { ...h, network, svmFunding: hold.kind }); } catch { /* the hold still answers */ }
      try { count(network, hold.kind, true); } catch { /* bookkeeping only */ }
      return { abort: true, reason: HOLD_REASON, message: h.hint };
    } catch { return undefined; }
  });
  server.onAfterVerify(async (ctx) => {
    if (ctx?.result?.isValid !== true) return;
    try { await clearFundingState({ key: fundingKeyOf(ctx?.paymentPayload, ctx?.requirements?.network) }); } catch { /* best-effort */ }
  });
  return server;
}

/** Test seams. */
export function _setFundingStoreForTest(s) { store = s || shared; }
export function _resetFundingForTest() { local._clear(); }
