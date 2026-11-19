// The paid-call funnel, per UTC day and per arrival path (operator only).
//
// For every request to a paid route (a catalog route, or a marketplace copy
// under /ref) the finish hook names one outcome:
//   probe      no payment credential and no proof of work (any answer)
//   challenge  a 402 was served (to a probe, or to a refused credential)
//   attempt    the request carried a payment credential
//   settled    an attempt answered 2xx with a settlement receipt
//   refused    an attempt answered 402; its refusal class is counted
//   errorAnswered an attempt answered another 4xx or a 5xx (settlement is
//              canceled on x402, MPP evm and credits; a Tempo push transfer
//              is final before the call, so there the call is booked owed)
//   free       answered 2xx without a credential (proof of work, a trial)
// and our own traffic (signed probes, our wallets) is counted apart as `ours`.
//
// Why a 402 did not become a payment, where knowable:
//   refusal classes  the refusal reason the paywall already names
//                    (src/payment-reject.js REJECTION_REASONS), folded into
//                    unfundedWallet, wrongNetwork, verifyRefused, ourSide,
//                    unclassified, or noReason (a refusal no classifier named:
//                    an MPP or credits credential, for one)
//   neverRetried     a caller whose first probe in a window was not followed by
//                    any credential from it within FUNNEL_RETRY_WINDOW_MS
//   retried / paidAfterProbe  the callers that did come back, and paid
// The caller is a keyed hash of its address held in memory for the window
// only (a per-process random key, never written anywhere); the store keeps
// counts. A retry served by another replica reads as never retried.
//
// Arrival path of a request: "marketplace" (/ref), "mcp" (the hosted
// connector's loopback or x402 twin, or our MCP package by User-Agent),
// "bazaar" (a User-Agent naming the Bazaar), "direct" (everything else).
// A request carries no sign of where its caller found the URL, so a buyer who
// read a Bazaar listing and calls with a plain client reads "direct".
//
// Beside the arrival, from fixed vocabularies (src/funnel-sources.js), for
// probes (`ua`, `referrer`, `found`) and settlements (`uaPaid`,
// `referrerPaid`, `foundPaid`): the client family its User-Agent names, the
// kind of page its Referer names, and the discovery document the same caller
// read last (llms.txt, openapi.json, /.well-known/x402 and the rest; "none"
// when it read none in the trail's window). A refused attempt whose wallet
// cannot cover the call counts its next-step state (`nextStep`), and an
// attempt answered 408 or 504 counts as `timeouts`.
import { createHmac, randomBytes } from "node:crypto";
import { REJECTION_REASONS } from "./payment-reject.js";
import { salePathOf, salePathGroup, BAZAAR_SALE_PATH } from "./sale-path.js";
import { uaFamilyOf, referrerClassOf, NEXT_STEP_COUNTED } from "./funnel-sources.js";

export const ARRIVALS = Object.freeze(["bazaar", "mcp", "direct", "marketplace", "unknown"]);
export const OUTCOMES = Object.freeze(["probe", "attempt", "free", "ours"]);
export const REFUSAL_CLASSES = Object.freeze(["unfundedWallet", "wrongNetwork", "verifyRefused", "ourSide", "unclassified", "noReason"]);
const KNOWN_REASONS = new Set(REJECTION_REASONS.map((r) => r.reason));
const CLASS_OF = Object.freeze({
  "insufficient-funds": "unfundedWallet",
  "no-token-account": "unfundedWallet",
  "unsupported-network": "wrongNetwork",
  "unsupported-scheme": "wrongNetwork",
  "not-checked": "ourSide",
  "facilitator-quota": "ourSide",
  "settlement-unconfirmed": "ourSide",
  unclassified: "unclassified",
});

/** A refusal reason (one of the fixed classifier words, or anything else) as its funnel class. */
export function refusalClassOf(reason) {
  if (typeof reason !== "string" || !reason) return "noReason";
  if (Object.hasOwn(CLASS_OF, reason)) return CLASS_OF[reason];
  return KNOWN_REASONS.has(reason) ? "verifyRefused" : "unclassified";
}
/** The stored per-reason key: a classifier word, or "other". Bounded by the vocabulary. */
export function refusalReasonKey(reason) {
  return typeof reason === "string" && KNOWN_REASONS.has(reason) ? reason : (reason ? "other" : "none");
}

const MCP_GROUPS = new Set(["mcp", "x402-mcp", "agent402-mcp"]);
/** The arrival group of a stored sale path (src/sale-path.js), by itself. */
function arrivalOfPathGroup(group) {
  if (MCP_GROUPS.has(group)) return "mcp";
  if (group === BAZAAR_SALE_PATH) return "bazaar";
  if (group === "unknown") return "unknown";
  return "direct";
}

/** The arrival path of a live request to a paid route. */
export function arrivalOfRequest(req) {
  try {
    const p = String(req?.originalUrl || req?.url || req?.path || "");
    if (p.startsWith("/ref/")) return "marketplace";
    return arrivalOfPathGroup(salePathGroup(salePathOf(req)));
  } catch { return "direct"; }
}

// Sales no request carried: bought on our own pages or renewed by an
// invoice of a subscription started there.
const STOREFRONT_WIRES = new Set(["stripe-checkout", "stripe-subscription", "mpp-tempo-subscription"]);
/** The arrival path of a sales-ledger row, from its rail, stored path and wire. */
export function arrivalOfSale({ rail, via, wire } = {}) {
  if (rail === "referral" || rail === "marketplace") return "marketplace";
  if (via == null || via === "") return STOREFRONT_WIRES.has(wire) ? "direct" : "unknown";
  return arrivalOfPathGroup(salePathGroup(via));
}

/** True when the request presented a payment credential (any wire). */
export function hadCredential(req) {
  const h = req?.headers || {};
  if (h["payment-signature"] || h["x-payment"]) return true;
  if (/^(Payment\s|Bearer a402_)/i.test(String(h.authorization || ""))) return true;
  return !!(req && (Object.hasOwn(req, "__paymentHeaderAsSent") && req.__paymentHeaderAsSent)) || !!(req && Object.hasOwn(req, "__droppedPaymentAttempt") && req.__droppedPaymentAttempt === true);
}
/** True when the finished response carries a settlement (the traffic classifier's rule). */
export function settledResponse(req, res) {
  if (!(res.statusCode >= 200 && res.statusCode < 300)) return false;
  const g = (k) => { try { return res.getHeader(k); } catch { return null; } };
  return !!(g("payment-response") || g("x-payment-response") || g("payment-receipt") || g("x-credits-balance") || req?.creditsSettled === true || req?.tempoSettled === true || req?.stripeSettled === true);
}

/**
 * One finished request's funnel event: { arrival, outcome, status, settled, reason }.
 * `ours` is the caller's verdict on our own traffic (signed probe, own wallet).
 */
export function funnelEventOf(req, res, { ours = false, ownHost = "" } = {}) {
  const arrival = arrivalOfRequest(req);
  const status = res.headersSent || res.writableEnded ? res.statusCode : 499;
  if (ours) return { arrival, outcome: "ours", status };
  const pow = !!req?.headers?.["x-pow-solution"];
  if (pow) return { arrival, outcome: "free", status };
  const h = req?.headers || {};
  const ua = uaFamilyOf(h["user-agent"]);
  const ref = referrerClassOf(h.referer || h.referrer, ownHost);
  if (hadCredential(req)) {
    const settled = settledResponse(req, res);
    const step = status === 402 && req && Object.hasOwn(req, "__paymentNextStepState") ? req.__paymentNextStepState : null;
    return { arrival, outcome: "attempt", status, settled, reason: status === 402 ? (req.__paymentRejectReason ?? null) : null, ua, ref, step };
  }
  if (status >= 200 && status < 300) return { arrival, outcome: "free", status };
  return { arrival, outcome: "probe", status, ua, ref };
}

export const FUNNEL_DEFAULTS = Object.freeze({
  retryWindowMs: Math.max(60_000, Number(process.env.FUNNEL_RETRY_WINDOW_MS) || 30 * 60_000),
  callerCap: Math.max(100, Number(process.env.FUNNEL_CALLER_CAP) || 50_000),
  sweepEveryMs: 60_000,
});

/**
 * The counter: `bump(day, arrival, field, n, reasonKey)` writes into the
 * store's day rollup (createTrafficStore().bumpFunnel). Pure apart from the
 * in-memory caller map, which is bounded by callerCap and the window.
 */
export function createFunnel({ bump, foundVia = null, retryWindowMs = FUNNEL_DEFAULTS.retryWindowMs, callerCap = FUNNEL_DEFAULTS.callerCap, sweepEveryMs = FUNNEL_DEFAULTS.sweepEveryMs } = {}) {
  if (typeof bump !== "function") throw new Error("createFunnel needs bump");
  const key = randomBytes(32);
  const callers = new Map(); // keyed caller -> { at, day, arrival, retried, paid }
  let lastSweep = 0;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const callerOf = (ip) => createHmac("sha256", key).update(String(ip || "?")).digest("base64url").slice(0, 16);
  function close(e, field) { bump(e.day, e.arrival, field, 1); }
  function sweep(now, all = false) {
    lastSweep = now;
    for (const [k, e] of callers) {
      if (!all && now - e.at < retryWindowMs) break; // insertion order is age order
      callers.delete(k);
      if (!e.retried) close(e, "neverRetried");
    }
  }
  // Where the caller came from (fixed words only; see src/funnel-sources.js).
  function sources(day, a, event, ip, suffix) {
    let found = "none";
    try { found = typeof foundVia === "function" ? foundVia(ip) : "none"; } catch { /* the trail is optional */ }
    if (event.ua) bump(day, a, `ua${suffix}`, 1, event.ua);
    if (event.ref) bump(day, a, `referrer${suffix}`, 1, event.ref);
    bump(day, a, `found${suffix}`, 1, found);
  }
  function record(event, { ip = null, now = Date.now() } = {}) {
    if (!event || !ARRIVALS.includes(event.arrival)) return;
    if (now - lastSweep >= sweepEveryMs) sweep(now);
    const day = dayOf(now);
    const a = event.arrival;
    if (event.outcome === "ours") { bump(day, a, "ours", 1); return; }
    if (event.outcome === "free") { bump(day, a, "free", 1); return; }
    const k = ip == null ? null : callerOf(ip);
    if (event.outcome === "probe") {
      bump(day, a, "probes", 1);
      sources(day, a, event, ip, "");
      if (event.status === 402) bump(day, a, "challenges", 1);
      if (k && !callers.has(k)) {
        if (callers.size >= callerCap) {
          // The oldest open caller is closed early: one that already came
          // back keeps its verdict; one that had not is counted untracked
          // (never as never retried).
          const [ok, oe] = callers.entries().next().value;
          callers.delete(ok);
          if (!oe.retried) bump(oe.day, oe.arrival, "untracked", 1);
        }
        callers.set(k, { at: now, day, arrival: a, retried: false, paid: false });
        bump(day, a, "probedCallers", 1);
      }
      return;
    }
    if (event.outcome !== "attempt") return;
    bump(day, a, "attempts", 1);
    if (event.settled) { bump(day, a, "settled", 1); sources(day, a, event, ip, "Paid"); }
    else if (event.status === 402) {
      bump(day, a, "challenges", 1);
      bump(day, a, "refused", 1);
      bump(day, a, `refusal.${refusalClassOf(event.reason)}`, 1);
      bump(day, a, "reasons", 1, refusalReasonKey(event.reason));
      if (NEXT_STEP_COUNTED.includes(event.step)) bump(day, a, "nextStep", 1, event.step);
    } else {
      bump(day, a, "errorAnswered", 1);
      if (event.status === 408 || event.status === 504) bump(day, a, "timeouts", 1);
    }
    const open = k ? callers.get(k) : null;
    if (open && now - open.at < retryWindowMs) {
      if (!open.retried) { open.retried = true; close(open, "retried"); }
      if (event.settled && !open.paid) { open.paid = true; close(open, "paidAfterProbe"); }
    }
  }
  return { record, sweep: (now = Date.now(), all = false) => sweep(now, all), size: () => callers.size };
}

/** A zero-filled funnel row (the fields one arrival carries per day). */
export function emptyFunnelRow() {
  return {
    probes: 0, challenges: 0, attempts: 0, settled: 0, refused: 0, errorAnswered: 0, free: 0, ours: 0,
    refusal: Object.fromEntries(REFUSAL_CLASSES.map((c) => [c, 0])), reasons: {},
    probedCallers: 0, retried: 0, paidAfterProbe: 0, neverRetried: 0, untracked: 0,
    timeouts: 0, nextStep: {}, ua: {}, referrer: {}, found: {}, uaPaid: {}, referrerPaid: {}, foundPaid: {},
  };
}
