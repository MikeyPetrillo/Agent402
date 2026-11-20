// The `nextStep` field of a refused payment whose wallet cannot cover the
// call: what state the payment is in, who has to act, what they do, and how
// long to wait before trying again. The prose `hint` beside it says the same
// to a person; this is the same advice in fields an agent can branch on.
//
//   state    one word from NEXT_STEP_STATES:
//              wallet-empty           the paying wallet holds none of the asset (read on Base)
//              wallet-below-price     it holds some, less than this call costs (read on Base)
//              wallet-short           the transfer came up short; the balance was not read
//              no-token-account       no account for the asset on that network (Solana
//                                     token account, Stellar trustline, Algorand opt-in)
//              gateway-deposit-short  the Circle Gateway deposit behind a batched payment is short
//   whoActs  "wallet-owner" when only whoever controls the funds can fix it (a
//            transfer in, a trustline, an opt-in, a deposit); "caller" when the
//            calling agent can act now (a balance that covers a cheaper route)
//   command  one imperative sentence, plus `fund` when funding is the fix:
//            { network, asset, amount (base units), usd } from the route's own
//            requirements, the least that makes this call payable
//   wait     { retryAfterSeconds, until }: the earliest retry worth sending
//            and the condition that makes it worth sending
//
// Pure: everything comes from the refusal the verify hint already holds
// (src/verify-hint.js). Never a balance figure beyond what the hint states,
// never another wallet, never a price that is not this route's own.
import { POW_LIST_PATH } from "./front-door.js";

export const NEXT_STEP_STATES = Object.freeze(["wallet-empty", "wallet-below-price", "wallet-short", "no-token-account", "gateway-deposit-short"]);
export const NEXT_STEP_ACTORS = Object.freeze(["wallet-owner", "caller"]);
const DEFAULT_WAIT_S = 60;

function fundOf(needs) {
  if (!needs || typeof needs !== "object") return null;
  const { network, asset, amount, usd } = needs;
  if (typeof network !== "string" || typeof asset !== "string" || typeof amount !== "string") return null;
  return { network, asset, amount, ...(Number.isFinite(usd) ? { usd } : {}) };
}
const waitOf = (seconds, until) => ({ retryAfterSeconds: Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_WAIT_S, until });

/**
 * The next step for one refused payment, or null when the refusal is not a
 * funding one (a malformed payment, a wrong network, our own side).
 * @param {object} h  the verify hint entry: { retry, reasonClass|reason, balanceUsd, priceUsd, needs, retryAfterSeconds }
 */
export function nextStepForRefusal(h) {
  if (!h || typeof h !== "object") return null;
  const retry = h.retry;
  const reason = h.reasonClass || h.reason || null;
  const fund = fundOf(h.needs);
  const balance = Number.isFinite(h.balanceUsd) ? h.balanceUsd : null;
  const after = Number.isSafeInteger(h.retryAfterSeconds) ? h.retryAfterSeconds : null;
  if (retry === "lower-price-route") {
    return {
      state: "wallet-below-price",
      whoActs: "caller",
      command: "Call a route this balance covers (GET /api/pricing lists every route and its price; /api/find?q=<task> ranks them), or have the wallet funded and sign a new authorization for this one.",
      ...(fund ? { fund } : {}),
      wait: waitOf(0, "now, for a route the balance covers; after funding, for this one"),
    };
  }
  if (retry === "fund-gateway-deposit") {
    return {
      state: "gateway-deposit-short",
      whoActs: "wallet-owner",
      command: "Deposit USDC into Circle Gateway for the signing address, or pay the plain accept from the wallet, then sign a new authorization.",
      wait: waitOf(after, "the Gateway deposit is confirmed"),
    };
  }
  if (retry !== "fund-wallet") return null;
  if (reason === "no-token-account") {
    return {
      state: "no-token-account",
      whoActs: "wallet-owner",
      command: "Create the wallet's account for the asset on this network (a USDC token account on Solana, a trustline on Stellar, an opt-in on Algorand) and fund it, or pay on another network listed in accepts, then sign a new payment.",
      ...(fund ? { fund } : {}),
      wait: waitOf(after, "the wallet holds the asset on this network"),
    };
  }
  const state = balance === null ? "wallet-short" : balance <= 0 ? "wallet-empty" : "wallet-below-price";
  return {
    state,
    whoActs: "wallet-owner",
    command: `${state === "wallet-empty" ? "Send the asset to the paying wallet" : "Top up the paying wallet"} on this network (at least the amount in fund), or pay on another network listed in accepts, then sign a new authorization; the same signed payment will keep failing.`,
    ...(fund ? { fund } : {}),
    wait: waitOf(after, "the transfer into the wallet is confirmed"),
  };
}

/** The empty-wallet path in general terms, for payment.info (no request in hand). */
export function emptyWalletGuide(baseUrl = "") {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  return {
    state: "wallet-empty",
    whoActs: "wallet-owner",
    command: "Fund the paying wallet with USDC on a network the route's 402 lists in accepts (each accept's amount is that network's price in base units), then sign a new authorization. A refused payment's 402 carries nextStep with the exact amount for that call.",
    wait: { retryAfterSeconds: DEFAULT_WAIT_S, until: "the transfer into the wallet is confirmed" },
    meanwhile: `Tools marked proof-of-work run free with no wallet: ${origin}${POW_LIST_PATH}.`,
  };
}
