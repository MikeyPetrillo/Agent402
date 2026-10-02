// Verify-time Algorand validity guard.
//
// Settlement runs AFTER the handler (@x402/express v2.16), so a buyer whose
// signed Algorand txn expires mid-handler is never charged — but our upstream
// spend (OpenAI, OpenRouter, …) is already burned by the time the facilitator
// rejects the dead txn. algokit's DEFAULT validity window is 10 rounds (~28s),
// so any tool slower than that fails deterministically for default-configured
// buyers: proven live by image-gen-premium (~60s of gpt-image-2) in sweep run
// 29974531159 ("txn dead: round 63358474 outside of 63358452--63358462").
//
// This guard rejects BEFORE the handler runs — a 422 cancels settlement, the
// buyer keeps their money, we spend nothing upstream, and the error explains
// the fix (re-sign with a longer validity window). Fail-open by design: any
// decode/algod failure defers to the facilitator's verify as the authority.

import algosdk from "algosdk";
import { paymentHeaderOf } from "./payer.js";
import { ALGORAND_ALGOD_BASES, getJsonAcross } from "./revenue-live.js";

const AVG_ROUND_SECONDS = 2.8;

// Default requirement is deliberately UNDER the 10-round (~28s) default window
// so default-configured buyers of normal tools always pass. Only tools whose
// TYPICAL duration exceeds the default window get a per-slug entry — for those
// the burn is deterministic, not occasional, so rejecting upfront is strictly
// better for both sides.
const DEFAULT_REQUIRED_SECONDS = 20;
export const SLOW_TOOL_SECONDS = {
  "image-gen-premium": 90, // gpt-image-2 medium 1536: ~35-50s typical, 75s upstream cap
  // A decision is answered within its depth budget (at most 26s) plus the
  // service call's margin; the signed window must outlive that.
  "decide": 35,
  // Long-running composites (2-4 min; see payments.js `longRunning`). Not
  // advertised on Algorand at all, but a hand-built payment to the route must
  // still be refused up front rather than burn the upstream run.
  "research": 300, "research-pro": 300, "research-max": 300, "dossier": 300, "dossier-max": 300,
  "fund-report": 300, "fund-report-max": 300, "domain-audit": 300, "domain-audit-pro": 300,
  "token-risk": 300, "token-risk-pro": 300,
  // The rest of the long composites. Each is EVM-exact only, but a hand-built
  // AVM payment must still be refused up front rather than burn the run.
  "ticker-pack": 300, "token-brief": 300, "recall-report": 300, "insider-report": 300, "filing-report": 300, "market-brief": 300,
  // Media tiers + the crawler. The media ones are EVM-only (longRunning), but a
  // hand-built AVM payment must still be refused up front rather than burn the run.
  "v1-images-fast": 240, "v1-images-pro": 240, "v1-videos": 300,
  "site-crawl": 40, "site-map": 20,
  // Pays an outside seller from our Base wallet and runs to its own 55 s
  // deadline (see DEADLINE_MS in seller-payability-kit.js). EVM-exact only via
  // LONG_RUNNING_SLUGS, so no AVM accept is advertised - this entry is the belt
  // that refuses a hand-built AVM payment before the upstream spend, the same
  // reasoning as the composites above.
  "seller-payability": 60,
};

export const requiredSecondsFor = (slug) => SLOW_TOOL_SECONDS[slug] ?? DEFAULT_REQUIRED_SECONDS;

/**
 * Extract lastValid (bigint) of the buyer's payment txn from an x402 payment
 * header value, or null when the header is not an AVM payment / unreadable.
 * AVM payloads are detected structurally (payload.paymentGroup) rather than by
 * the network string, so a client that omits network still gets guarded.
 */
export function lastValidFromPaymentHeader(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    const payload = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
    const network = String(payload?.network || "");
    if (network && !network.startsWith("algorand:")) return null;
    const group = payload?.payload?.paymentGroup;
    if (!Array.isArray(group) || group.length === 0) return null;
    const idx = Number.isInteger(payload?.payload?.paymentIndex) ? payload.payload.paymentIndex : 0;
    const bytes = new Uint8Array(Buffer.from(group[idx] ?? group[0], "base64"));
    // The buyer's txn in the group is signed; a sponsored fee-payer txn is not.
    try {
      return algosdk.decodeSignedTransaction(bytes).txn.lastValid ?? null;
    } catch {
      return algosdk.decodeUnsignedTransaction(bytes).lastValid ?? null;
    }
  } catch {
    return null;
  }
}

/**
 * Pure decision: throws 422 when the payment's remaining validity cannot cover
 * the tool's expected duration. Exported for offline tests.
 */
export function checkAvmValidity(headerValue, slug, currentRound) {
  if (currentRound == null) return;
  const lastValid = lastValidFromPaymentHeader(headerValue);
  if (lastValid == null) return;
  const required = requiredSecondsFor(slug);
  const remaining = (Number(lastValid) - Number(currentRound)) * AVG_ROUND_SECONDS;
  if (remaining < required) {
    const err = new Error(
      `Payment validity window too short for this tool: ~${Math.max(0, Math.round(remaining))}s remain before the Algorand txn's lastValid round, but ${slug} can take up to ~${required}s and x402 settlement happens after the work completes - the txn would be dead before it settles. Re-sign with a longer validity window (e.g. algokit setDefaultValidityWindow(1000)) and retry. You have not been charged.`,
    );
    err.statusCode = 422;
    throw err;
  }
}

// ── Current-round estimate ────────────────────────────────────────────────────
// One algod /v2/status fetch anchors the round; between refreshes the round is
// estimated from wall-clock elapsed (Algorand cadence ~2.8s). Guard precision
// only needs a handful of rounds, so a 5-min anchor is plenty. Concurrent
// first-callers share one in-flight fetch; failure fails open (null).
const ANCHOR_TTL_MS = 5 * 60_000;
let anchor = null; // { round: number, atMs: number }
let anchorInFlight = null;

async function refreshAnchor() {
  try {
    const { ok, json } = await getJsonAcross(ALGORAND_ALGOD_BASES, "/v2/status", { timeoutMs: 5000 });
    const round = Number(json?.["last-round"]);
    if (ok && Number.isFinite(round) && round > 0) anchor = { round, atMs: Date.now() };
  } catch {
    /* fail-open: estimator returns what it has (possibly null) */
  } finally {
    anchorInFlight = null;
  }
}

export async function currentRoundEstimate() {
  const stale = !anchor || Date.now() - anchor.atMs > ANCHOR_TTL_MS;
  if (stale && !anchorInFlight) anchorInFlight = refreshAnchor();
  // A usable (even slightly stale) anchor never blocks the request path; only
  // the truly-cold case waits for the fetch.
  if (!anchor && anchorInFlight) await anchorInFlight;
  if (!anchor) return null;
  return anchor.round + Math.floor((Date.now() - anchor.atMs) / (AVG_ROUND_SECONDS * 1000));
}

/** Express-side entry: cheap no-op unless the request carries an AVM payment. */
export async function assertAvmValidityCovers(req, slug) {
  const header = paymentHeaderOf(req);   // middleware order — see src/payer.js
  if (!header) return;
  const lastValid = lastValidFromPaymentHeader(header);
  if (lastValid == null) return; // not AVM (or unreadable) — facilitator decides
  checkAvmValidity(header, slug, await currentRoundEstimate());
}
