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
// read from the signed transaction (src/svm-payer.js), and only when that
// authority is one of the message's required signers and its ed25519
// signature over the message verifies here: a transaction that merely names
// someone else's wallet never counts toward, sets or meets a hold, and its
// refusal gets the facilitator's own answer. A transaction whose transfer
// cannot be read is never held. An insufficient-funds hold keeps the smallest
// amount refused and holds only attempts at or above it, so the same wallet
// paying a cheaper route reaches verify.
//
// State: src/shared-limits.js (Redis across replicas), falling back to this
// process's own memory when the shared store does not answer, and going
// straight to memory for a while after it did not (a hung store costs one
// command timeout, not one per payment). A hold answer is a verify refusal:
// no handler ran, nothing settled, and no settle-failure breaker or composite
// guard sees it.
import { createHash } from "node:crypto";
import { shared, createMemoryLimits, sharedLimitsWord, DEGRADED_HOLD_MS } from "./shared-limits.js";
import { svmTransferAccounts, svmSignedTransfer, svmPayerFromPayload } from "./svm-payer.js";
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

/**
 * A dollar figure the way the catalog prints a price (src/pages.js
 * displayPrice: at least two decimals, no trailing zeros past them, so 0.08
 * is "$0.08" and 0.001 is "$0.001"), to the micro-dollar. Pure.
 */
export function catalogPriceText(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return null;
  const [whole, frac = ""] = n.toFixed(6).split(".");
  const f = frac.replace(/0+$/, "");
  return `$${whole}.${f.length < 2 ? f.padEnd(2, "0") : f}`;
}

const shortAddr = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : null);

/**
 * The buyer-facing words for one funding case. Pure.
 * @returns {{reason:string, retry:"fund-wallet", retryAfterSeconds:number, hint:string}}
 */
export function fundingHint({ kind, payer = null, priceUsd = null, held = false, retryAfterSeconds = RETRY_AFTER_S() } = {}) {
  const who = shortAddr(payer) ? `The paying wallet ${shortAddr(payer)}` : "The paying wallet";
  const price = Number.isFinite(priceUsd) && priceUsd > 0 ? ` (${catalogPriceText(priceUsd)})` : "";
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
 * The throttle key of one Solana payment, only when its transfer authority
 * signed it (src/svm-payer.js svmSignedTransfer: a required signer whose
 * ed25519 signature over the message verifies): `id` hashes the network, the
 * authority and the source token account; `amount` is the transfer's base
 * units. Null when the transfer cannot be read or the authority did not sign,
 * so a transaction that only NAMES a wallet never counts toward its hold.
 * @returns {{id:string, amount:number}|null}
 */
export function fundingKeyOf(paymentPayload, network) {
  if (!/^solana:/.test(String(network || ""))) return null;
  const tx = paymentPayload?.payload?.transaction ?? paymentPayload?.transaction;
  const t = svmSignedTransfer(tx);
  if (!t) return null;
  const id = createHash("sha256").update(`${network}|${t.authority}|${t.source}`).digest("hex").slice(0, 32);
  return { id, amount: Number(t.amount) };
}

/** The paying wallet named by the payment (the transfer's authority, else the non-fee-payer signer). */
export function fundingPayerOf(paymentPayload, { feePayer } = {}) {
  const tx = paymentPayload?.payload?.transaction ?? paymentPayload?.transaction;
  return svmTransferAccounts(tx)?.authority || svmPayerFromPayload(paymentPayload, { feePayer }) || null;
}

// Shared store first, this process's memory when it does not answer. After a
// shared command fails (or while the process's shared-limits word reads
// degraded), the shared store is skipped for DEGRADED_HOLD_MS, so a hung
// Redis costs one command timeout, not one per payment.
const local = createMemoryLimits({ keyCap: 10_000 });
let store = shared;
let sharedSkipUntil = 0;
const sharedSkipped = (t = Date.now()) => t < sharedSkipUntil || (store === shared && store.mode === "redis" && sharedLimitsWord(t) === "degraded");
async function op(name, ...args) {
  if (!sharedSkipped()) {
    try {
      const r = await store[name](...args);
      if (r?.ok) return r;
    } catch { /* fall through to memory */ }
    sharedSkipUntil = Date.now() + DEGRADED_HOLD_MS();
  }
  return local[name](...args);
}
const WIN = "svmfund-win";
const HOLD = "svmfund-holds";
const idOf = (key) => (typeof key === "string" ? key : key?.id) || null;
const amountOf = (key, amount) => {
  const a = Number(amount ?? (typeof key === "object" ? key?.amount : NaN));
  return Number.isFinite(a) && a >= 0 ? Math.trunc(a) : null;
};

/**
 * Count one funding refusal; set the hold when it is the HOLD_AFTER-th inside
 * the window. An insufficient-funds hold carries the smallest amount refused
 * in the window and refuses only attempts at or above it; a no-token-account
 * hold refuses every amount (no amount can move from an account that does not
 * exist). A refusal whose amount is unknown is not counted. Returns
 * { count, held, minAmount }.
 */
export async function noteFundingRefusal({ key, kind, amount, now = Date.now() } = {}) {
  const id = idOf(key), amt = amountOf(key, amount);
  if (!id || !kind || amt == null || !throttleEnabled()) return { count: 0, held: false };
  const w = await op("windowAdd", WIN, `${id}|${kind}`, { windowMs: WINDOW_MS(), member: `${now}-${Math.random().toString(36).slice(2, 8)}`, weight: amt, now });
  const count = Number(w?.count) || 0;
  if (count < HOLD_AFTER()) return { count, held: false };
  const weights = Array.isArray(w?.entries) ? w.entries.map((e) => Number(e.weight)).filter((n) => Number.isFinite(n) && n >= 0) : [];
  const minAmount = kind === FUNDING_REASONS.noAccount ? 0 : Math.min(amt, ...weights);
  await op("windowAdd", HOLD, id, { windowMs: RETRY_AFTER_S() * 1000, member: `${kind}:${minAmount}`, weight: minAmount, now });
  return { count, held: true, minAmount };
}

/**
 * One read (one shared round trip) of a wallet's funding state: the hold that
 * applies to an attempt of `amount` base units, and whether any state exists
 * for the key at all (refusals in the window or a hold), which decides
 * whether a valid verify has anything to clear.
 */
async function readFundingState({ key, amount, now = Date.now() } = {}) {
  const id = idOf(key);
  if (!id || !throttleEnabled()) return { hold: null, found: false };
  const holdMs = RETRY_AFTER_S() * 1000;
  const kinds = Object.values(FUNDING_REASONS);
  const r = await op("windowReadMany", [{ name: HOLD, key: id, windowMs: holdMs }, ...kinds.map((k) => ({ name: WIN, key: `${id}|${k}`, windowMs: WINDOW_MS() }))], { now });
  const results = Array.isArray(r?.results) ? r.results : [];
  const found = results.some((x) => Number(x?.count) > 0);
  const amt = amountOf(key, amount);
  let hold = null;
  for (const e of Array.isArray(results[0]?.entries) ? results[0].entries : []) {
    const colon = String(e.member).lastIndexOf(":");
    const kind = String(e.member).slice(0, colon);
    if (!kinds.includes(kind)) continue;
    const minAmount = Number(e.weight);
    if (kind === FUNDING_REASONS.short && (amt == null || !Number.isFinite(minAmount) || amt < minAmount)) continue;
    const untilMs = Number(e.score) + holdMs;
    if (untilMs > now && (!hold || untilMs > hold.untilMs)) hold = { kind, untilMs, minAmount };
  }
  return { hold, found };
}

/**
 * The active hold for this payment's wallet at this amount: { kind, untilMs,
 * minAmount } or null. `key` is fundingKeyOf's answer (its amount is the
 * attempt's), or an id string with `amount` beside it.
 */
export async function fundingHoldOf({ key, amount, now = Date.now() } = {}) {
  return (await readFundingState({ key, amount, now })).hold;
}

/** A valid verify for the wallet: its windows and holds go. */
export async function clearFundingState({ key } = {}) {
  const id = idOf(key);
  if (!id) return;
  await Promise.all([op("windowClear", HOLD, id), ...Object.values(FUNDING_REASONS).map((kind) => op("windowClear", WIN, `${id}|${kind}`))]);
}

/**
 * The beforeVerify hold and the verify-success clear on an x402 resource
 * server. `remember(paymentPayload, hint)` stores the 402 hint under the
 * payment's credential (src/verify-hint.js); `count(network, kind, held)` is
 * the failure monitor's counter. The clear runs only when the beforeVerify
 * read found state for the key (the same payload object reaches both hooks),
 * so a wallet with nothing recorded costs one read per payment.
 */
export function registerSvmFundingHold(server, { remember, count = () => {}, now = () => Date.now() } = {}) {
  const hadState = new WeakSet();
  server.onBeforeVerify(async (ctx) => {
    try {
      const network = ctx?.requirements?.network;
      const key = fundingKeyOf(ctx?.paymentPayload, network);
      if (!key) return undefined;
      const t = now();
      const { hold, found } = await readFundingState({ key, now: t });
      if (found && ctx?.paymentPayload && typeof ctx.paymentPayload === "object") hadState.add(ctx.paymentPayload);
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
    const payload = ctx?.paymentPayload;
    if (!payload || typeof payload !== "object" || !hadState.has(payload)) return;
    hadState.delete(payload);
    try { await clearFundingState({ key: fundingKeyOf(payload, ctx?.requirements?.network) }); } catch { /* best-effort */ }
  });
  return server;
}

/** Test seams. */
export function _setFundingStoreForTest(s) { store = s || shared; }
export function _resetFundingForTest() { local._clear(); sharedSkipUntil = 0; }
