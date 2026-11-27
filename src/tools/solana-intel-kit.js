// Solana intel kit - token risk facts, liquidity and price intel for SPL
// tokens, from public keyless APIs and our own Solana RPC:
//
//   RugCheck    api.rugcheck.xyz      authorities, metadata, LP lock, top
//                                     holders, markets, lockers, insiders
//                                     (its own score, risk levels and verdict
//                                     words are never passed through: the
//                                     answers list named facts, each computed
//                                     here from the report's fields, with the
//                                     token facts notice, src/token-claims.js)
//   DexScreener api.dexscreener.com   pairs per mint (and the price read from
//                                     them), search, boosted/new tokens
//   Jupiter     lite-api.jup.ag       token search/audit (an input to the
//                                     safety and search answers)
//   Solana RPC  SOLANA_RPC_URL        holder accounts, mint decimals and slot
//
// Every handler validates the base58 mint BEFORE any egress, keeps ONE request
// per upstream (sol-token-safety fans out to two small ones in parallel), bounds
// every list, trims upstream payloads to the fields an agent acts on, and never
// relays an upstream error body (only our own status mapping: 429 -> 503,
// 5xx -> 502, other 4xx -> 422 with a plain message; a read that outlives its
// deadline, or an upstream that cannot be reached, is a 503 naming the
// upstream and the step, see DEADLINES below).
//
// Shapes were verified live on 2026-08-22 with curl; notes on drift:
//   - The public Solana RPC (api.mainnet-beta.solana.com) throttles
//     getTokenLargestAccounts per method ("Too many requests for a specific RPC
//     call") even at one call per minute, so holder concentration comes from
//     RugCheck's report (topHolders carries pct + owner + insider flag), not
//     the RPC.
//   - RugCheck's full report can be large on blue chips (JUP: 2.8MB, 1,400
//     markets, 1.2s) and small on memecoins (~10KB). We trim to the top
//     markets and never echo knownAccounts (290KB on JUP) except as labels.
//
// All tools egress, so every slug belongs in WALLET_ONLY_SLUGS (registered
// by the coordinator in src/pow.js). Covered offline by
// scripts/test-solana-intel-kit.js (stubbed fetch).

import { markUntrusted } from "./provenance.js";
import { partialFields } from "../partial-answer.js";
import { createTtlCache } from "./ttl-dedupe.js";
import { HANDLER_BUDGET_MS, OPTIONAL_READ_FLOOR_MS, budgetOf, budgetSpentError, upstreamFetch, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS, capOf, currentBudget } from "../upstream-deadline.js";
import { RUGCHECK_SLUGS, rugcheckEnabled } from "../rugcheck-switch.js";
import { rugcheckPause, rugcheckFailureKind, rugcheckInputKey } from "../rugcheck-pause.js";
export { RUGCHECK_SLUGS, rugcheckEnabled };
import { TOKEN_FACTS_NOTICE } from "../token-claims.js";
const MAX_BODY_BYTES = 24 * 1024 * 1024;  // the hard ceiling on any one upstream document read here.
import { readBytesCapped, readTextCapped, decodeUtf8 } from "../capped-body.js";
import { JUPITER_ATTRIBUTION, RUGCHECK_ATTRIBUTION, attribute, creditAnswers } from "../data-attribution.js";
// Read a body under a byte cap: `res.text()` has no cap of its own, so a
// broken or hostile upstream could push an unbounded buffer into memory once
// per concurrent call. A declared Content-Length over the cap is refused before
// reading; a body without one stops at the cap (src/capped-body.js). Either is
// a 502.
async function readBodyWithinCap(res, capBytes, label) {
  const tooLarge = () => Object.assign(new Error(`${label} response is larger than the ${Math.round(capBytes / 1048576)}MB cap`), { statusCode: 502 });
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared && declared > capBytes) throw tooLarge();
  const { bytes, truncated } = await readBytesCapped(res, capBytes);
  if (truncated) throw tooLarge();
  return decodeUtf8(bytes);
}

// DEADLINES. Every upstream read carries its own cap, and every handler runs
// under one budget, so the longest path (the full report, then the two RPC
// fallback reads) still answers while a short payment window is open: this
// server's own router signs 30 s authorizations and the facilitator refuses one
// within six seconds of expiry, so the answer must be on the wire inside 20 s.
// The caps are sized from measured normal answers (summary, Jupiter and
// DexScreener reads under a second; the RugCheck full report 1.2 s on a blue
// chip at 2.8 MB) with room for a slow day. A read that outlives its cap is the
// upstream's outage: the tool answers a 503 that names the upstream and the
// step (never charged, settlement runs after the handler) instead of waiting
// it out, and an optional step (the RPC holder table) is skipped when the
// budget cannot hold it. AbortSignal.timeout bounds headers AND body, so a
// stalled body read ends at the same deadline. The budget, the caps'
// composition and the two 503 classes are src/upstream-deadline.js, shared
// with every other kit that reads an upstream.
const RUGCHECK_SUMMARY_MS = 8_000;
// 15 s: a slow day ran a healthy report past 12 s; the holders tool's
// optional RPC fill still fits the 20 s budget behind it.
const RUGCHECK_REPORT_MS = 15_000;
const JUPITER_MS = 8_000;
const DEXSCREENER_MS = 8_000;
const RPC_MS = 5_000;
// An optional read is not started with less than this left in the budget.
const RPC_FLOOR_MS = 1_500;
// The safety tool's optional full-report read is not started with less than
// this left: the report is measured at 1.2 to 3.6 s on a blue chip.
const FULL_REPORT_FLOOR_MS = 4_000;
// ...and gets a shorter cap than the report tools' own read: the safety tool
// is the fast headline read (summary + index answer in well under a second),
// so an optional fill must not hold it for the report tools' full cap.
// Measured 2026-10-14: a healthy report answers in 1.2 to 3.6 s; a slow day
// ran past 12 s, where the fill gives up and the answer says why.
const RUGCHECK_FALLBACK_MS = 6_000;
const UA = "Mozilla/5.0 (compatible; Agent402/1.0; +https://agent402.tools)";

const RUGCHECK = "https://api.rugcheck.xyz/v1";
const DEXSCREENER = "https://api.dexscreener.com";
// Jupiter's keyless lite-api is deprecated (its cutoff is postponed, no date
// yet); api.jup.ag takes an x-api-key. Switching is a variable change:
// JUPITER_API_BASE=https://api.jup.ag with JUPITER_API_KEY set. Read at call
// time so a Railway variable write needs no code change.
const JUPITER_DEFAULT = "https://lite-api.jup.ag";
export function jupiterBase(env = process.env) {
  const v = String(env.JUPITER_API_BASE || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+$/i.test(v) ? v : JUPITER_DEFAULT;
}
export function jupiterHeaders(url, env = process.env) {
  const key = String(env.JUPITER_API_KEY || "").trim();
  // The key goes only to the Jupiter host it was issued for.
  return key && String(url).startsWith(jupiterBase(env) + "/") ? { "x-api-key": key } : {};
}

// Well-known mints used in examples and as defaults.
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
};

// Base58 alphabet (no 0, O, I, l). Solana pubkeys encode to 32-44 chars.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function takeMint(raw, field = "mint") {
  if (typeof raw !== "string") throw bad(`"${field}" is required: a base58 Solana token mint address`);
  const s = raw.trim();
  if (!BASE58_RE.test(s)) throw bad(`"${field}" must be a base58 Solana address (32-44 chars, no 0/O/I/l)`);
  return s;
}

function takeLimit(raw, dflt, max) {
  if (raw == null || raw === "") return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) throw bad(`"limit" must be an integer between 1 and ${max}`);
  return n;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, places = 4) {
  const n = num(v);
  if (n == null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// One shared egress helper. Upstream bodies are NEVER relayed to the buyer:
// the only text that leaves here is our own, keyed off the status class.
// RugCheck reads report their outcome, keyed by the mint they read, to the
// automatic pause (src/rugcheck-pause.js), and a RugCheck outage names a
// retry delay.
async function upstreamJson(url, opts = {}) {
  if (opts.label !== "RugCheck") return upstreamJsonOnce(url, opts);
  // A read capped below its own timeout by the handler's budget times out on
  // the caller's clock, not RugCheck's.
  const ownCap = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : JUPITER_MS;
  const budgetShortened = capOf(ownCap, opts.budget === undefined ? currentBudget() : opts.budget) < ownCap;
  try {
    const out = await upstreamJsonOnce(url, opts);
    rugcheckPause.noteSuccess();
    return out;
  } catch (err) {
    const kind = rugcheckFailureKind(err, { budgetShortened });
    if (kind === "answer") { rugcheckPause.noteSuccess(); throw err; }
    if (kind !== "neutral") rugcheckPause.noteFailure(`${opts.step || "read"}: ${err.upstreamFailure || err.statusCode}`, { key: rugcheckInputKey(url), kind });
    if (!Number.isInteger(err.retryAfter)) err.retryAfter = Math.max(30, rugcheckPause.state().retryAfterSeconds);
    throw err;
  }
}

async function upstreamJsonOnce(url, { label, step = "data", timeoutMs = JUPITER_MS, budget, method = "GET", body, notFound } = {}) {
  // The read gets its own cap, or what is left of the handler's budget if
  // that is shorter; a budget already spent refuses before any egress
  // (upstreamFetch). The deadline classes are the shared module's.
  const ctx = { label, step, timeoutMs, budget, tag: "[solana-intel]" };
  const res = await upstreamFetch(url, {
    method,
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(label === "Jupiter" ? jupiterHeaders(url) : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, ctx);
  if (res.status === 429) throw bad(`${label} rate limit reached upstream - retry shortly`, 503);
  if (res.status >= 500) throw bad(`${label} upstream error (HTTP ${res.status})`, 502);
  if (res.status === 404 || res.status === 400) {
    // RugCheck answers 400 {"error":"invalid token mint"} for a non-mint
    // pubkey. That is "we
    // cannot say anything about this input", not a server fault. But RugCheck
    // also answers 400/404 {"error":"unable to generate report"} for EVERY
    // mint while its report builder is down (measured 2026-09-25 on JUP and
    // BONK): that is its outage, not the buyer's input, so it is a retryable
    // 503 rather than a 422 blaming the mint.
    const errText = await readTextCapped(res, 4096).then((t) => t.slice(0, 500)).catch(() => "");
    if (/unable to generate|temporarily|try again|timeout/i.test(errText)) {
      // RugCheck answered for this input; the pause does not count it.
      throw Object.assign(bad(`${label} could not produce a report right now (upstream) - retry shortly`, 503), { rugcheckNoReport: true });
    }
    throw bad(notFound || `${label} has no data for that input`, 422);
  }
  if (!res.ok) throw bad(`${label} refused the request (HTTP ${res.status})`, 502);
  let text;
  // The same signal bounds the body, so a body that stalls past the cap ends
  // as the deadline it is, not as an unreadable response.
  try { text = await bodyUnderDeadline(readBodyWithinCap(res, MAX_BODY_BYTES, label), ctx); } catch (err) {
    if (err?.statusCode) throw err;
    throw bad(`${label} response could not be read`, 502);
  }
  try { return JSON.parse(text); } catch { throw bad(`${label} returned non-JSON`, 502); }
}

const stamp = () => new Date().toISOString();

// The full report, read once per mint at a time. sol-token-report,
// sol-token-holders and the safety tool's fallback all read this document;
// the brief composite runs two of them in parallel for one mint, so
// concurrent reads share one request (src/tools/ttl-dedupe.js, dedupe only:
// a multi-megabyte document is never held after it is answered).
const reportReads = createTtlCache({ maxEntries: 1 });
async function rugcheckReport(mint, budget, timeoutMs = RUGCHECK_REPORT_MS) {
  // A caller joining a read already in flight waits on that read's own cap.
  const { value } = await reportReads.get(mint, 0, () => upstreamJson(`${RUGCHECK}/tokens/${mint}/report`, { label: "RugCheck", step: "report", timeoutMs, budget, notFound: "RugCheck has no report for that mint (not an SPL token mint?)" }));
  return value;
}

// ---------------------------------------------------------------------------
// Named facts
// ---------------------------------------------------------------------------
// The Solana token answers list named facts computed here from the sources'
// structured fields, never the source's own score, risk levels or verdict
// words. Each flag: an id, a description and the measured value. A fact the
// sources did not report is listed in `unknown` with why, never read as the
// absence of a flag.
const SOL_FLAG_RULES = Object.freeze([
  { id: "mint-authority-live", field: "mintAuthorityDisabled", when: (v) => v === false, says: "a mint authority is set, so new supply can be minted", value: (x) => x.mintAuthority ?? true },
  { id: "freeze-authority-live", field: "freezeAuthorityDisabled", when: (v) => v === false, says: "a freeze authority is set, so holder token accounts can be frozen", value: (x) => x.freezeAuthority ?? true },
  { id: "metadata-mutable", field: "metadataMutable", when: (v) => v === true, says: "the update authority can change the token's name, symbol and image", value: (x) => x.updateAuthority ?? true },
  { id: "transfer-fee", field: "transferFeePct", when: (v) => v != null && v > 0, says: "transfers pay a fee set in the token's transfer-fee extension (percent)" },
  { id: "lp-locked-under-50", field: "lpLockedPct", when: (v) => v != null && v < 50, says: "under 50% of the liquidity pool tokens are locked (percent locked)" },
  { id: "top-holders-50-or-more", field: "topHoldersPct", when: (v) => v != null && v >= 50, says: "the largest holders together hold 50% or more of supply (percent)" },
]);
export const SOL_FLAG_IDS = Object.freeze(SOL_FLAG_RULES.map((r) => r.id));

/** The named facts found in `x` (the fields above, each null when the
 *  sources did not report it), and the ones that could not be checked. */
export function solanaTokenFlags(x, why = {}) {
  const flags = [], unknown = [];
  for (const r of SOL_FLAG_RULES) {
    if (!(r.field in x)) continue;
    const v = x[r.field];
    if (v == null) { unknown.push({ field: r.field, reason: why[r.field] || "not reported by the sources read" }); continue; }
    if (r.when(v)) flags.push({ id: r.id, field: r.field, description: r.says, value: r.value ? r.value(x) : v });
  }
  return { flags, unknown };
}

// "is this mint/freeze authority still live?" - null, the system program
// (111...) and "" all mean revoked/none.
function authorityState(v) {
  if (!v || v === "11111111111111111111111111111111") return { revoked: true, address: null };
  return { revoked: false, address: String(v) };
}

/**
 * The top token accounts for a mint, read from OUR Solana RPC.
 *
 * RugCheck stopped populating `topHolders` for every mint at some point before
 * 2026-09-19 (measured that day: 5 of 5 majors answered HTTP 200 with
 * `topHolders: []` while `totalHolders` stayed populated - JUP read 0 rows
 * against 2,882,275 holders). The field is still DECLARED in their report, so
 * nothing errored: the tool kept answering 200 with an empty table and a null
 * concentration block, which is the hollow-200 shape that is indistinguishable
 * from "this token has no whales" and was being sold at $0.005.
 *
 * The kit header's note that the public RPC throttles getTokenLargestAccounts
 * still stands, and is exactly why this reads OUR configured RPC
 * (`SOLANA_RPC_URL`, an Alchemy endpoint in production) rather than
 * api.mainnet-beta. Two calls: the largest accounts, then one batched
 * getMultipleAccounts to resolve each token account's OWNER wallet, which is
 * the field a buyer actually acts on. Returns null - never an empty list - when
 * the RPC is unset or unhappy, so the caller can tell "no data" from "no
 * holders".
 *
 * The fan-out is bounded: at most two RPC reads (the RPC itself returns at most
 * 20 largest accounts; the owners come back in ONE batched read), each under
 * RPC_MS and under what remains of the handler's budget, and neither is started
 * when the budget cannot hold it. Returns { rows, why }: rows is null, never an
 * empty list, when there is no table, and why names the reason the tool's
 * note repeats (unset, budget, deadline, unreachable, refused, empty).
 */
const RPC_TABLE_MAX = 20;
async function topAccountsFromRpc(mint, supplyRaw, budget) {
  const url = (process.env.SOLANA_RPC_URL || "").trim();
  if (!url) return { rows: null, why: "unset" };
  if (budget && budget.remaining() < RPC_FLOOR_MS) return { rows: null, why: "budget" };
  const call = async (body, step) => {
    const r = await upstreamJson(url, { label: "Solana RPC", step, timeoutMs: RPC_MS, budget, method: "POST", body });
    // No upstream text: this module's own rule is that an upstream body is
    // never relayed to the buyer. Unreachable today (both call sites catch and
    // fall back to null), which is exactly why it is worth deleting rather
    // than trusting - it is one removed `try` away from becoming a live relay.
    if (r?.error) throw bad("Solana RPC refused the read", 502);
    return r?.result?.value ?? null;
  };
  const whyOf = (e) => (e?.upstreamFailure === "deadline" || e?.upstreamFailure === "unreachable" ? e.upstreamFailure : "refused");
  let largest;
  try { largest = await call({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [mint] }, "getTokenLargestAccounts"); } catch (e) { return { rows: null, why: whyOf(e) }; }
  if (!Array.isArray(largest) || !largest.length) return { rows: null, why: "empty" };
  const rows = largest.slice(0, RPC_TABLE_MAX);
  // Owners are a refinement: with the budget spent or the read refused the
  // table still answers, owner null, rather than the tool losing the table.
  let owners = [];
  if (!budget || budget.remaining() >= RPC_FLOOR_MS) {
    try {
      owners = (await call({ jsonrpc: "2.0", id: 2, method: "getMultipleAccounts", params: [rows.map((r) => r.address), { encoding: "jsonParsed" }] }, "getMultipleAccounts")) || [];
    } catch { owners = []; }
  }
  // pct is computed against the mint's own raw supply, so it matches the
  // figure RugCheck used to publish rather than a share of the top 20.
  const supply = Number(supplyRaw);
  return {
    why: null,
    rows: rows.map((r, idx) => {
      const info = owners[idx]?.data?.parsed?.info || {};
      const raw = Number(r?.amount);
      return {
        address: r?.address ?? null,
        owner: info?.owner ?? null,
        uiAmount: num(r?.uiAmount),
        pct: Number.isFinite(supply) && supply > 0 && Number.isFinite(raw) ? (raw / supply) * 100 : null,
        insider: false,
      };
    }),
  };
}

/** An empty table that was never READ (no RPC, no budget, a deadline, a refusal)
 *  is not a complete answer of zero rows: partialFields(0, 0) would say
 *  complete, which is absence published as evidence of absence, so these two
 *  fields are set by hand there. An RPC that answered no accounts is complete. */
function unreadTableFields(rows, why) {
  return rows.length === 0 && why && why !== "empty" ? { complete: false, truncated: true } : {};
}

/** The sentence an empty holder table carries, exact about which source said what. */
function noTableNote(why) {
  const rpc = {
    unset: "no Solana RPC is configured here",
    budget: "the Solana RPC read was not started because the report read used the time budget",
    deadline: "the Solana RPC did not answer within its deadline",
    unreachable: "the Solana RPC could not be reached",
    refused: "the Solana RPC refused the read",
    empty: "the Solana RPC returned no token accounts",
  }[why] || "the Solana RPC returned no token accounts";
  return `No top-holder table is available for this mint: RugCheck published none and ${rpc}. totalHolders, when present, is still RugCheck's own count.`;
}

function shapeHolders(report, limit, rpcRows) {
  const known = report?.knownAccounts && typeof report.knownAccounts === "object" ? report.knownAccounts : {};
  const reported = Array.isArray(report?.topHolders) ? report.topHolders : [];
  // RugCheck first (it carries the insider flag we cannot derive), the RPC only
  // when RugCheck publishes nothing.
  const src = reported.length ? reported : (Array.isArray(rpcRows) ? rpcRows : []);
  // Concentration is computed over EVERY holder the source returns (20); the
  // row list alone is cut to `limit`.
  const all = src.slice(0, 20).map((h) => {
    const label = known[h?.owner] || known[h?.address] || null;
    return {
      tokenAccount: h?.address ?? null,
      owner: h?.owner ?? null,
      uiAmount: num(h?.uiAmount),
      pct: round(h?.pct, 4),
      insider: Boolean(h?.insider),
      label: label ? { name: String(label.name ?? ""), type: String(label.type ?? "") } : null,
    };
  });
  const pctOf = (n) => round(all.slice(0, n).reduce((s, r) => s + (r.pct || 0), 0), 4);
  // Concentration that excludes labelled pool/locker accounts: an AMM vault
  // holding 30% is liquidity, not a whale.
  const unlabeled = all.filter((r) => !r.label);
  const unlabeledPct = (n) => round(unlabeled.slice(0, n).reduce((s, r) => s + (r.pct || 0), 0), 4);
  return {
    rows: all.slice(0, limit),
    // The table the sources publish is at most 20 rows (both RugCheck and the
    // RPC cap it there); the partial-answer fields read against that table.
    tableRows: all.length,
    concentration: {
      top1Pct: pctOf(1),
      top5Pct: pctOf(5),
      top10Pct: pctOf(10),
      top20Pct: pctOf(20),
      top10PctExcludingPools: unlabeledPct(10),
      insiderHolders: all.filter((r) => r.insider).length,
      labeledPoolOrLockerAccounts: all.filter((r) => r.label).length,
    },
  };
}

function shapeMarkets(report, limit) {
  const markets = Array.isArray(report?.markets) ? report.markets.slice() : [];
  // Sort by LP USD value so the deepest pools come first; the raw report is
  // unordered and can hold 1,400 entries on a blue chip.
  const usd = (m) => (num(m?.lp?.baseUSD) || 0) + (num(m?.lp?.quoteUSD) || 0);
  markets.sort((a, b) => usd(b) - usd(a));
  return {
    total: markets.length,
    rows: markets.slice(0, limit).map((m) => ({
      pool: m?.pubkey ?? null,
      type: m?.marketType ?? null,
      mintA: m?.mintA ?? null,
      mintB: m?.mintB ?? null,
      liquidityUsd: round(usd(m), 2),
      lpLockedPct: round(m?.lp?.lpLockedPct, 2),
      lpLockedUsd: round(m?.lp?.lpLockedUSD, 2),
      lpProviders: num(m?.lp?.holders),
    })),
  };
}

function shapeLockers(report, limit) {
  const lockers = report?.lockers && typeof report.lockers === "object" ? Object.entries(report.lockers) : [];
  return {
    total: lockers.length,
    rows: lockers.slice(0, limit).map(([account, l]) => ({
      account,
      type: l?.type ?? null,
      owner: l?.owner ?? null,
      usdLocked: round(l?.usdcLocked, 2),
      unlockDate: num(l?.unlockDate) ? new Date(Number(l.unlockDate) * 1000).toISOString() : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// DexScreener shaping
// ---------------------------------------------------------------------------
function shapePair(p) {
  const created = num(p?.pairCreatedAt);
  const row = {
    pairAddress: p?.pairAddress ?? null,
    dex: p?.dexId ?? null,
    labels: Array.isArray(p?.labels) ? p.labels.slice(0, 5) : [],
    base: { address: p?.baseToken?.address ?? null, symbol: p?.baseToken?.symbol ?? null, name: p?.baseToken?.name ?? null },
    quote: { address: p?.quoteToken?.address ?? null, symbol: p?.quoteToken?.symbol ?? null },
    priceUsd: num(p?.priceUsd),
    priceNative: num(p?.priceNative),
    liquidityUsd: num(p?.liquidity?.usd),
    fdv: num(p?.fdv),
    marketCap: num(p?.marketCap),
    volume: { m5: num(p?.volume?.m5), h1: num(p?.volume?.h1), h6: num(p?.volume?.h6), h24: num(p?.volume?.h24) },
    priceChangePct: { m5: num(p?.priceChange?.m5), h1: num(p?.priceChange?.h1), h6: num(p?.priceChange?.h6), h24: num(p?.priceChange?.h24) },
    txns24h: { buys: num(p?.txns?.h24?.buys), sells: num(p?.txns?.h24?.sells) },
    txns1h: { buys: num(p?.txns?.h1?.buys), sells: num(p?.txns?.h1?.sells) },
    txns6h: { buys: num(p?.txns?.h6?.buys), sells: num(p?.txns?.h6?.sells) },
    txns5m: { buys: num(p?.txns?.m5?.buys), sells: num(p?.txns?.m5?.sells) },
    websites: Array.isArray(p?.info?.websites) ? p.info.websites.map((w) => w?.url).filter(Boolean).slice(0, 2) : [],
    socials: Array.isArray(p?.info?.socials) ? p.info.socials.map((x) => x?.url || (x?.type && x?.handle ? `${x.type}:${x.handle}` : null)).filter(Boolean).slice(0, 3) : [],
    pairCreatedAt: created ? new Date(created).toISOString() : null,
    ageHours: created ? round((Date.now() - created) / 3_600_000, 1) : null,
    // A filled-in DexScreener profile (image/website/socials). Impostor
    // tokens that copy a ticker rarely have one; spoofed liquidity is common.
    hasProfile: Boolean(p?.info && (p.info.imageUrl || (p.info.websites || []).length || (p.info.socials || []).length)),
    url: p?.url ?? null,
  };
  row.signals = pairSignals(row);
  return row;
}

// ---------------------------------------------------------------------------
// Computed signals. Each list route answers what the pair index's figures
// mean, not only the figures: depth and age bands, the 24h buy share, how
// many times the pool's liquidity traded in a day (a very high turnover on a
// thin pool is the usual wash-trading shape), and named flags. Thresholds are
// fixed here so the same figures always read the same way.
// ---------------------------------------------------------------------------
const LIQUIDITY_BANDS = [[1_000_000, "deep"], [100_000, "moderate"], [10_000, "thin"], [0, "dust"]];
const NEW_PAIR_HOURS = 24, YOUNG_PAIR_HOURS = 168;
const HIGH_TURNOVER = 10;           // 24h volume over liquidity
const ONE_SIDED_MIN_TXNS = 50, ONE_SIDED_SHARE = 0.85;
const PAIR_SIGNAL_FLAGS = Object.freeze(["dust-liquidity", "thin-liquidity", "new-pair", "no-profile", "one-sided-flow", "high-turnover"]);
function liquidityBand(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return null;
  return LIQUIDITY_BANDS.find(([min]) => usd >= min)[1];
}
function pairSignals(r) {
  const liq = r.liquidityUsd, vol = r.volume?.h24;
  const buys = r.txns24h?.buys, sells = r.txns24h?.sells;
  const txns = (buys || 0) + (sells || 0);
  const buyShare = txns > 0 && buys != null && sells != null ? round(buys / txns, 2) : null;
  const turnover = liq > 0 && vol != null ? round(vol / liq, 2) : null;
  const band = liquidityBand(liq);
  const age = r.ageHours == null ? null : r.ageHours < NEW_PAIR_HOURS ? "new" : r.ageHours < YOUNG_PAIR_HOURS ? "young" : "established";
  const flags = [];
  if (band === "dust") flags.push("dust-liquidity");
  else if (band === "thin") flags.push("thin-liquidity");
  if (age === "new") flags.push("new-pair");
  if (!r.hasProfile) flags.push("no-profile");
  if (buyShare != null && txns >= ONE_SIDED_MIN_TXNS && (buyShare >= ONE_SIDED_SHARE || buyShare <= 1 - ONE_SIDED_SHARE)) flags.push("one-sided-flow");
  if (turnover != null && turnover >= HIGH_TURNOVER) flags.push("high-turnover");
  return { liquidityBand: band, age, buyShare24h: buyShare, turnover24h: turnover, flags };
}
/** Across one token's pairs: where its liquidity sits. `topPairSharePct` is
 *  the deepest pair's share of the total; `concentration` is the
 *  Herfindahl index of the pairs' liquidity shares (1 = all in one pair). */
function pairsAnalysis(rows) {
  const liq = rows.map((r) => r.liquidityUsd || 0);
  const total = liq.reduce((a, b) => a + b, 0);
  const shares = total > 0 ? liq.map((x) => x / total) : [];
  const ages = rows.map((r) => r.ageHours).filter((x) => x != null);
  const flagged = {};
  for (const r of rows) for (const f of r.signals?.flags || []) flagged[f] = (flagged[f] || 0) + 1;
  return {
    dexCount: new Set(rows.map((r) => r.dex).filter(Boolean)).size,
    topPairSharePct: shares.length ? round(Math.max(...shares) * 100, 1) : null,
    concentration: shares.length ? round(shares.reduce((a, x) => a + x * x, 0), 3) : null,
    deepPairs: rows.filter((r) => r.signals?.liquidityBand === "deep").length,
    oldestPairAgeHours: ages.length ? Math.max(...ages) : null,
    flaggedPairs: flagged,
  };
}
/** Across a search's rows: how many distinct mints answer to the query's
 *  ticker, and which of them holds the most liquidity. A row whose base token
 *  shares that ticker with a deeper mint is marked `tickerShadow` (the usual
 *  impostor shape: a copied ticker on a thinner pool). */
function searchAnalysis(rows, query) {
  const want = searchKey(query);
  const byMint = new Map();
  for (const r of rows) {
    const mint = r.base?.address;
    if (!mint || searchKey(r.base?.symbol) !== want) continue;
    byMint.set(mint, (byMint.get(mint) || 0) + (r.liquidityUsd || 0));
  }
  let deepest = null;
  for (const [mint, liq] of byMint) if (!deepest || liq > deepest.liq) deepest = { mint, liq };
  for (const r of rows) {
    if (!r.signals) continue;
    r.signals.tickerShadow = Boolean(deepest && byMint.size > 1 && byMint.has(r.base?.address) && r.base.address !== deepest.mint);
  }
  return { tickerMints: byMint.size, deepestTickerMint: deepest ? deepest.mint : null, deepestTickerLiquidityUsd: deepest ? round(deepest.liq, 2) : null };
}

const byLiquidity = (a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0);

// sol-token-search fallback. The pair index's search answers its top 30 pairs
// across every chain, so a ticker busy elsewhere can leave Solana with no row.
// The fallback asks a Solana token index for the query's mints (in that
// index's own search order, at most SEARCH_FALLBACK_MINTS; its verified flag
// neither ranks nor is passed through), then reads their pairs from the pair
// index by mint, in parallel: each listed mint's top pair in one read, and
// the first mint's full pair list in another.
const SEARCH_FALLBACK_MINTS = 5;
const SEARCH_FALLBACK_SOURCES = ["dexscreener", "jupiter"];
const SEARCH_NOTE = "Rows keep DexScreener relevance order. Several tokens can share a ticker; check hasProfile, liquidity and age, then confirm the mint, its pairs and its liquidity with sol-token-pairs.";
const FALLBACK_NOTE = "No Solana pair in DexScreener's search matched the query, so the mints came from a Solana token index (listed in fallback.mints). Row order: the first mint's pairs where it is the base token, by liquidity; the other mints' pairs in that order; the search's own Solana rows in relevance order; then pairs that hold a listed mint only as the quote token. Several tokens can share a ticker; check hasProfile, liquidity and age, then confirm the mint, its pairs and its liquidity with sol-token-pairs.";

const searchKey = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** The whole query and each word of it, folded to letters and digits. */
function searchKeys(query) {
  const keys = new Set([searchKey(query)]);
  for (const w of String(query).split(/[\s/,|]+/)) keys.add(searchKey(w));
  keys.delete("");
  return keys;
}
/** A row answers the query when its base token is the queried mint, or its
 *  base symbol or name equals the query or one word of it ("$WIF" is "wif"). */
function pairMatchesQuery(row, query, keys = searchKeys(query)) {
  if (row?.base?.address && row.base.address === query) return true;
  return keys.has(searchKey(row?.base?.symbol)) || keys.has(searchKey(row?.base?.name));
}

function fallbackFailure(err, upstream, step) {
  const reason = err?.upstreamFailure || (err?.statusCode === 503 ? "rate-limited" : "upstream-error");
  return { upstream, step, reason };
}

/** Resolve the query's mints and read their pairs. Never throws: a read that
 *  does not answer is reported in the result (status "unavailable" when no
 *  pair could be read, "partial" when one of the two pair reads failed). */
async function searchFallback(query, budget) {
  if (budget && budget.remaining() < OPTIONAL_READ_FLOOR_MS) {
    return { status: "unavailable", mints: [], pairs: [], unavailable: { upstream: "Jupiter", step: "token search", reason: "budget" }, error: null };
  }
  let list;
  try {
    list = await upstreamJson(`${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(query)}`, { label: "Jupiter", step: "token search", timeoutMs: JUPITER_MS, budget });
  } catch (err) {
    return { status: "unavailable", mints: [], pairs: [], unavailable: fallbackFailure(err, "Jupiter", "token search"), error: err };
  }
  const mints = (Array.isArray(list) ? list : [])
    .filter((t) => typeof t?.id === "string" && BASE58_RE.test(t.id))
    .slice(0, SEARCH_FALLBACK_MINTS)
    .map((t) => ({ mint: t.id, symbol: t.symbol ?? null, name: t.name ?? null }));
  if (!mints.length) return { status: "nothing-found", mints, pairs: [], unavailable: null, error: null };
  if (budget && budget.remaining() < OPTIONAL_READ_FLOOR_MS) {
    return { status: "unavailable", mints, pairs: [], unavailable: { upstream: "DexScreener", step: "pairs by mint", reason: "budget" }, error: null };
  }
  const ids = mints.map((m) => m.mint);
  const [top, all] = await Promise.allSettled([
    upstreamJson(`${DEXSCREENER}/tokens/v1/solana/${ids.join(",")}`, { label: "DexScreener", step: "pairs by mint", timeoutMs: DEXSCREENER_MS, budget }),
    upstreamJson(`${DEXSCREENER}/token-pairs/v1/solana/${ids[0]}`, { label: "DexScreener", step: "token pairs", timeoutMs: DEXSCREENER_MS, budget }),
  ]);
  const read = (r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []);
  const pairs = [...read(all), ...read(top)].filter((p) => p?.chainId === "solana").map(shapePair);
  const failed = [top, all].filter((r) => r.status === "rejected");
  if (failed.length === 2) {
    return { status: "unavailable", mints, pairs: [], unavailable: fallbackFailure(failed[0].reason, "DexScreener", "pairs by mint"), error: failed[0].reason };
  }
  if (failed.length === 1) {
    const step = top.status === "rejected" ? "pairs by mint" : "token pairs";
    return { status: "partial", mints, pairs, unavailable: fallbackFailure(failed[0].reason, "DexScreener", step), error: failed[0].reason };
  }
  return { status: pairs.length ? "found" : "nothing-found", mints, pairs, unavailable: null, error: null };
}

/** Row order: the listed mints' pairs as base token, by mint order and then
 *  liquidity (one token per group, so a liquidity sort cannot lift an
 *  impostor), the search's Solana rows in relevance order, then pairs holding a
 *  listed mint only as the quote. Deduped by pair address, first seen wins. */
function mergeFallbackRows(searchRows, fb) {
  const rank = new Map(fb.mints.map((m, k) => [m.mint, k]));
  const asBase = fb.pairs.filter((p) => rank.has(p.base.address))
    .sort((a, b) => (rank.get(a.base.address) - rank.get(b.base.address)) || byLiquidity(a, b));
  const asQuote = fb.pairs.filter((p) => !rank.has(p.base.address)).sort(byLiquidity);
  const seen = new Set();
  const out = [];
  for (const r of [...asBase, ...searchRows, ...asQuote]) {
    const key = r.pairAddress;
    if (key != null) { if (seen.has(key)) continue; seen.add(key); }
    out.push(r);
  }
  return out;
}

function sumPairs(rows) {
  return {
    liquidityUsd: round(rows.reduce((s, r) => s + (r.liquidityUsd || 0), 0), 2),
    volume24hUsd: round(rows.reduce((s, r) => s + (r.volume.h24 || 0), 0), 2),
    txns24h: rows.reduce((s, r) => s + (r.txns24h.buys || 0) + (r.txns24h.sells || 0), 0),
  };
}

function shapeLinks(links) {
  return (Array.isArray(links) ? links : []).slice(0, 6).map((l) => ({
    type: l?.type ?? l?.label ?? "website",
    url: l?.url ?? null,
  }));
}

// ---------------------------------------------------------------------------
// sol-price: a mint's USD price from the deepest pair that trades it
// ---------------------------------------------------------------------------
export const SOL_PRICE_MAX_MINTS = 50;
// The pair index reads at most this many token addresses in one request.
const PAIR_READ_MAX_MINTS = 30;

/** A mint's price from the pairs read: the deepest pair holding it as the
 *  base token gives its USD price and 24h change; with none, the deepest pair
 *  holding it as the quote gives the price (the base's USD price over its
 *  price in the quote token) and no change. Liquidity sums every pair read
 *  that holds the mint, each pair once. Null when no pair prices it. */
export function priceOfMint(mint, rawPairs) {
  const seen = new Set();
  const rows = [];
  for (const p of rawPairs) {
    const base = p?.baseToken?.address, quote = p?.quoteToken?.address;
    if (base !== mint && quote !== mint) continue;
    const key = p?.pairAddress ?? `${base}/${quote}/${rows.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ side: base === mint ? "base" : "quote", priceUsd: num(p?.priceUsd), priceNative: num(p?.priceNative), liquidityUsd: num(p?.liquidity?.usd) || 0, change24h: num(p?.priceChange?.h24) });
  }
  const deepest = (side) => rows.filter((r) => r.side === side && r.priceUsd > 0 && (side === "base" || r.priceNative > 0)).sort((x, y) => y.liquidityUsd - x.liquidityUsd)[0] || null;
  const liquidityUsd = round(rows.reduce((sum, r) => sum + r.liquidityUsd, 0), 2);
  const b = deepest("base");
  if (b) return { priceUsd: b.priceUsd, priceChange24hPct: round(b.change24h, 4), liquidityUsd, from: "base" };
  const q = deepest("quote");
  if (q) return { priceUsd: Number((q.priceUsd / q.priceNative).toPrecision(10)), priceChange24hPct: null, liquidityUsd, from: "quote" };
  return null;
}

/** The mint accounts, read once on OUR Solana RPC (SOLANA_RPC_URL): each
 *  account's parsed data carries the mint's decimals, and the answer's
 *  context names the slot. { accounts: null, slot: null } when the RPC is
 *  unset, the budget cannot hold the read, or it fails; never a throw. */
async function mintAccountsOnChain(mints, budget) {
  const url = (process.env.SOLANA_RPC_URL || "").trim();
  if (!url || (budget && budget.remaining() < RPC_FLOOR_MS)) return { accounts: null, slot: null };
  try {
    const r = await upstreamJson(url, { label: "Solana RPC", step: "getMultipleAccounts", timeoutMs: RPC_MS, budget, method: "POST", body: { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [mints, { encoding: "jsonParsed" }] } });
    const value = r?.result?.value;
    if (r?.error || !Array.isArray(value)) return { accounts: null, slot: null };
    return { accounts: value, slot: num(r?.result?.context?.slot) };
  } catch {
    return { accounts: null, slot: null };
  }
}

// ---------------------------------------------------------------------------
// Jupiter shaping
// ---------------------------------------------------------------------------
// Jupiter's audit block omits mintAuthorityDisabled/freezeAuthorityDisabled
// on some tokens (USDC, live authorities); the top-level authority field is
// present there, so derive from it rather than report null.
function authorityDisabled(auditFlag, t, field) {
  if (typeof auditFlag === "boolean") return auditFlag;
  if (field in t) return !t[field];
  return null;
}

function shapeJupStats(x) {
  if (!x) return null;
  return {
    priceChangePct: round(x.priceChange, 2), holderChangePct: round(x.holderChange, 2), liquidityChangePct: round(x.liquidityChange, 2), volumeChangePct: round(x.volumeChange, 2),
    buyVolumeUsd: round(x.buyVolume, 2), sellVolumeUsd: round(x.sellVolume, 2), buyOrganicVolumeUsd: round(x.buyOrganicVolume, 2), sellOrganicVolumeUsd: round(x.sellOrganicVolume, 2),
    numBuys: num(x.numBuys), numSells: num(x.numSells), numTraders: num(x.numTraders), numOrganicBuyers: num(x.numOrganicBuyers), numNetBuyers: num(x.numNetBuyers),
  };
}
const RATING_TAG_RE = /verif|strict|organic|trust|score/i;
function shapeJupToken(t) {
  if (!t) return null;
  return {
    mint: t.id ?? null,
    name: t.name ?? null,
    symbol: t.symbol ?? null,
    decimals: num(t.decimals),
    priceUsd: num(t.usdPrice),
    marketCapUsd: num(t.mcap),
    fdvUsd: num(t.fdv),
    liquidityUsd: num(t.liquidity),
    holderCount: num(t.holderCount),
    circulatingSupply: num(t.circSupply),
    totalSupply: num(t.totalSupply),
    // The source's own verification flag and scores are its rating of the
    // token, not a fact read from the chain: never passed on (nor the tags
    // that carry the same rating).
    tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === "string" && !RATING_TAG_RE.test(x)).slice(0, 12) : [],
    audit: {
      mintAuthorityDisabled: authorityDisabled(t.audit?.mintAuthorityDisabled, t, "mintAuthority"),
      freezeAuthorityDisabled: authorityDisabled(t.audit?.freezeAuthorityDisabled, t, "freezeAuthority"),
      topHoldersPct: round(t.audit?.topHoldersPercentage, 2),
      devBalancePct: round(t.audit?.devBalancePercentage, 2),
      devMints: num(t.audit?.devMints),
    },
    mintAuthority: t.mintAuthority ?? null,
    freezeAuthority: t.freezeAuthority ?? null,
    launchpad: t.launchpad ?? null,
    dev: t.dev ?? null,
    firstPool: t.firstPool ? { id: t.firstPool.id ?? null, createdAt: t.firstPool.createdAt ?? null } : null,
    stats24h: shapeJupStats(t.stats24h),
    // Intraday flow (Jupiter serves 5m/1h/6h too): a 24h total hides a dump
    // in the last hour, and the ORGANIC split is Jupiter's own wash-trade
    // signal - buyOrganicVolume vs buyVolume.
    stats1h: shapeJupStats(t.stats1h),
    stats6h: shapeJupStats(t.stats6h),
    website: t.website ?? null,
    twitter: t.twitter ?? null,
    createdAt: t.createdAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export const SOLANA_INTEL_TOOLS = [
  // =========================================================================
  // sol-token-safety - risk facts: RugCheck summary + Jupiter audit
  // =========================================================================
  {
    route: "POST /api/sol-token-safety",
    name: "Solana token risk facts",
    slug: "sol-token-safety",
    category: "crypto",
    price: "$0.005",
    description:
      "Risk facts for any Solana SPL token mint, read from two keyless public sources in parallel: whether the mint authority and the freeze authority are revoked or still set (with their addresses), the share of liquidity pool tokens locked, the largest holders' combined share, dev balance and dev mints, holder count, decimals and the token program. The answer lists each named fact it found (flags: an id, a description and the measured value), what the sources did not report (unknown, with why), and a fixed notice that these are facts read from the chain and named public sources and not investment advice. Each flag is computed here from the sources' fields; no outside score, risk level or rating is passed through, and there is no verdict, so no flags is not a statement about the token. The full token report is read only when the aggregator does not index the mint, and fullReport names the fields it filled.",
    tags: ["solana", "token", "authorities", "liquidity", "holders", "spl", "onchain"],
    discovery: {
      bodyType: "json",
      input: { mint: MINTS.JUP },
      inputSchema: {
        properties: {
          mint: { type: "string", maxLength: 44, description: "Base58 SPL token mint address." },
        },
        required: ["mint"],
      },
      output: {
        example: {
          mint: MINTS.JUP,
          flags: [{ id: "lp-locked-under-50", field: "lpLockedPct", description: "under 50% of the liquidity pool tokens are locked (percent locked)", value: 8.98 }],
          unknown: [],
          lpLockedPct: 8.98,
          tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          token: { name: "Jupiter", symbol: "JUP", decimals: 6, holderCount: 835540, launchpad: null },
          authorities: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, mintAuthority: null, freezeAuthority: null },
          holders: { topHoldersPct: 15.28, devBalancePct: null, devMints: 1 },
          fullReport: null,
          notice: TOKEN_FACTS_NOTICE,
          source: ["rugcheck", "jupiter"], fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const mint = takeMint(i.mint);
      const budget = budgetOf();
      // SUMMARY FIRST. The summary (a few hundred bytes, measured ~0.4 s) and
      // Jupiter's index entry carry every field this tool publishes for the
      // tokens it is asked about. The full report (megabytes on a blue chip,
      // measured 3.6 s for JUP) is read only when Jupiter does not index the
      // mint (token, authorities). That read is optional: when it cannot
      // finish, the fields stay null and `fullReport` says why. The summary's
      // own score and risk levels are never read into the answer.
      const [summary, jupList] = await Promise.all([
        upstreamJson(`${RUGCHECK}/tokens/${mint}/report/summary`, { label: "RugCheck", step: "report summary", timeoutMs: RUGCHECK_SUMMARY_MS, budget, notFound: "RugCheck has no report for that mint (not an SPL token mint?)" }),
        upstreamJson(`${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(mint)}`, { label: "Jupiter", step: "token search", timeoutMs: JUPITER_MS, budget }),
      ]);
      const jt = shapeJupToken((Array.isArray(jupList) ? jupList : []).find((t) => t?.id === mint) || null);
      const need = [];
      if (!jt) need.push("token", "authorities");
      let full = null, fullReport = null;
      if (need.length) {
        if (budget && budget.remaining() < FULL_REPORT_FLOOR_MS) {
          fullReport = { read: false, needed: need, filled: [], why: "budget" };
        } else {
          try {
            full = await rugcheckReport(mint, budget, RUGCHECK_FALLBACK_MS);
          } catch (e) {
            fullReport = { read: false, needed: need, filled: [], why: e?.statusCode === 503 ? "deadline-or-refused" : e?.statusCode === 422 ? "no-report" : "upstream-error" };
          }
        }
      }
      const filled = [];
      let token = jt ? { name: jt.name, symbol: jt.symbol, decimals: jt.decimals, holderCount: jt.holderCount, launchpad: jt.launchpad } : null;
      let authorities = jt ? { mintAuthorityDisabled: jt.audit.mintAuthorityDisabled, freezeAuthorityDisabled: jt.audit.freezeAuthorityDisabled, mintAuthority: jt.mintAuthority, freezeAuthority: jt.freezeAuthority } : null;
      if (full && !jt) {
        // The report's own fields.
        token = {
          name: full?.tokenMeta?.name ?? full?.fileMeta?.name ?? null,
          symbol: full?.tokenMeta?.symbol ?? full?.fileMeta?.symbol ?? null,
          decimals: num(full?.token?.decimals),
          // RugCheck reports 0 when it has not counted (measured on USDC):
          // a zero is "no count", never "no holders".
          holderCount: num(full?.totalHolders) > 0 ? num(full.totalHolders) : null,
          launchpad: full?.launchpad?.name ?? full?.launchpad?.platform ?? null,
        };
        const m = authorityState(full?.token?.mintAuthority ?? full?.mintAuthority);
        const f = authorityState(full?.token?.freezeAuthority ?? full?.freezeAuthority);
        authorities = { mintAuthorityDisabled: m.revoked, freezeAuthorityDisabled: f.revoked, mintAuthority: m.address, freezeAuthority: f.address };
        filled.push("token", "authorities");
      }
      if (full) fullReport = { read: true, needed: need, filled };
      const lpLockedPct = round(summary?.lpLockedPct, 2);
      const holders = jt ? { topHoldersPct: jt.audit.topHoldersPct, devBalancePct: jt.audit.devBalancePct, devMints: jt.audit.devMints } : null;
      const { flags, unknown } = solanaTokenFlags({
        mintAuthorityDisabled: authorities?.mintAuthorityDisabled ?? null, mintAuthority: authorities?.mintAuthority ?? null,
        freezeAuthorityDisabled: authorities?.freezeAuthorityDisabled ?? null, freezeAuthority: authorities?.freezeAuthority ?? null,
        lpLockedPct, topHoldersPct: holders?.topHoldersPct ?? null,
      }, jt ? {} : { mintAuthorityDisabled: "the aggregator does not index the mint and the full report did not answer", freezeAuthorityDisabled: "the aggregator does not index the mint and the full report did not answer", topHoldersPct: "the aggregator does not index the mint" });
      return {
        mint,
        flags,
        unknown,
        lpLockedPct,
        tokenProgram: summary?.tokenProgram ?? full?.tokenProgram ?? null,
        token,
        authorities,
        holders,
        // null when the summary and Jupiter carried everything (the usual
        // case); otherwise which fields needed the full report, which it
        // filled, and why it could not when it could not.
        fullReport,
        note: "Flags are computed here from the sources' fields; no outside score or risk level is passed through. Jupiter fields are null when Jupiter does not index the mint; token and authorities then come from the full report when it answers (fullReport says which), and holders stays null.",
        notice: TOKEN_FACTS_NOTICE,
        source: filled.length ? ["rugcheck", "jupiter", "rugcheck-report"] : ["rugcheck", "jupiter"],
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-token-report - the full token report's facts, trimmed
  // =========================================================================
  {
    route: "POST /api/sol-token-report",
    name: "Solana token risk facts (full report)",
    slug: "sol-token-report", aliases: ["solana-token-risk-report", "solana-token-risk"],
    category: "crypto",
    price: "$0.010",
    description:
      "The facts in a public token report for a Solana token mint, trimmed to what an agent acts on: mint/freeze authority state, metadata mutability and update authority, supply and decimals, creator and creator balance, top 20 holders with percent, owner, insider flag and pool/locker labels, concentration totals, the deepest markets (liquidity, LP locked %), lockers, total market liquidity, LP providers, holder count, insider-network count, launchpad and transfer-fee config. The answer lists each named fact found (flags: an id, a description and the measured value, computed here from the report's fields), what the report did not carry (unknown) and a fixed notice that these are facts read from the chain and named public sources and not investment advice; the report's own score, risk levels and verdict words are never passed through. One report read, plus at most two bounded reads from our Solana RPC (the 20 largest token accounts, then one batched owner lookup) only when the report carries no holder table; every read runs under a deadline, so a slow upstream answers as a retryable refusal, never a charge. The holders and markets blocks carry returned, matched and complete fields. Blue-chip reports run to megabytes upstream and come back here in a few KB.",
    pageSummary:
      "Facts from a public token report for one Solana mint, trimmed to a few KB. Covers mint and freeze authority state, metadata mutability, supply, creator balance, top 20 holders with pool and locker labels, concentration, deepest markets with LP locked %, lockers, holder count, launchpad and transfer-fee config. Lists each named fact found (flags, computed here from the report's fields), what the report did not carry (unknown) and a fixed notice that these are facts read from the chain and named public sources and not investment advice; the report's own score, risk levels and verdict words are never passed through. Every read runs under a deadline, so a slow upstream answers as a retryable refusal, never a charge.",
    tags: ["solana", "token", "report", "holders", "liquidity", "authorities", "spl"],
    discovery: {
      bodyType: "json",
      input: { mint: MINTS.JUP, marketLimit: 5, holderLimit: 10 },
      inputSchema: {
        properties: {
          mint: { type: "string", maxLength: 44, description: "Base58 SPL token mint address." },
          marketLimit: { type: "number", description: "Deepest markets to include (1-25, default 5)." },
          holderLimit: { type: "number", description: "Top holders to include (1-20, default 20)." },
        },
        required: ["mint"],
      },
      output: {
        example: {
          mint: MINTS.JUP,
          token: { name: "Jupiter", symbol: "JUP", decimals: 6, supply: 6862431164.93, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", metadataMutable: true, updateAuthority: "61aq585V8cR2sZBeawJFt2NPqmN7zDi1sws4KLs5xHXV" },
          authorities: { mint: { revoked: true, address: null }, freeze: { revoked: true, address: null } },
          flags: [{ id: "metadata-mutable", field: "metadataMutable", description: "the update authority can change the token's name, symbol and image", value: "61aq585V8cR2sZBeawJFt2NPqmN7zDi1sws4KLs5xHXV" }, { id: "top-holders-50-or-more", field: "topHoldersPct", description: "the largest holders together hold 50% or more of supply (percent)", value: 66.1 }],
          unknown: [],
          creator: null, creatorBalance: 0, launchpad: null, detectedAt: "2024-05-29T00:40:51Z",
          priceUsd: 0.2027, totalMarketLiquidityUsd: 3585833.66, totalLpProviders: 173, totalHolders: 2873512, insiderNetworks: 0,
          transferFee: { pct: 0, maxAmount: 0 },
          holders: { rows: [{ tokenAccount: "6G4X...", owner: "EXJH...", uiAmount: 1700000000.1, pct: 24.77, insider: false, label: null }], returned: 10, matched: 20, complete: false, truncated: true, maxHolders: 20, concentration: { top1Pct: 24.77, top5Pct: 57.67, top10Pct: 66.1, top20Pct: 75.2, top10PctExcludingPools: 66.1, insiderHolders: 0, labeledPoolOrLockerAccounts: 0 } },
          markets: { total: 1409, rows: [{ pool: "C8Gr...", type: "meteoraDlmm", mintA: MINTS.JUP, mintB: MINTS.SOL, liquidityUsd: 1260729.15, lpLockedPct: 0, lpLockedUsd: 0, lpProviders: 0 }], returned: 5, matched: 1409, complete: false, truncated: true, maxMarkets: 25 },
          lockers: { total: 2, rows: [] },
          notice: TOKEN_FACTS_NOTICE,
          source: "rugcheck", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const mint = takeMint(i.mint);
      const marketLimit = takeLimit(i.marketLimit, 5, 25);
      const holderLimit = takeLimit(i.holderLimit, 20, 20);
      const budget = budgetOf();
      const r = await rugcheckReport(mint, budget);
      const decimals = num(r?.token?.decimals);
      const rawSupply = num(r?.token?.supply);
      const rpc = Array.isArray(r?.topHolders) && r.topHolders.length ? { rows: null, why: null } : await topAccountsFromRpc(mint, rawSupply, budget);
      const holdersShaped = shapeHolders(r, holderLimit, rpc.rows);
      const marketsShaped = shapeMarkets(r, marketLimit);
      const mintAuth = authorityState(r?.token?.mintAuthority ?? r?.mintAuthority);
      const freezeAuth = authorityState(r?.token?.freezeAuthority ?? r?.freezeAuthority);
      const transferFee = r?.transferFee ? { pct: num(r.transferFee.pct), maxAmount: num(r.transferFee.maxAmount) } : null;
      const conc = holdersShaped.rows.length ? holdersShaped.concentration : null;
      const { flags, unknown } = solanaTokenFlags({
        mintAuthorityDisabled: mintAuth.revoked, mintAuthority: mintAuth.address,
        freezeAuthorityDisabled: freezeAuth.revoked, freezeAuthority: freezeAuth.address,
        metadataMutable: typeof r?.tokenMeta?.mutable === "boolean" ? r.tokenMeta.mutable : null, updateAuthority: r?.tokenMeta?.updateAuthority ?? null,
        transferFeePct: transferFee ? transferFee.pct ?? 0 : 0,
        topHoldersPct: num(conc?.top10Pct),
      }, { topHoldersPct: "no holder table was read" });
      return {
        mint,
        token: {
          name: r?.tokenMeta?.name ?? r?.fileMeta?.name ?? null,
          symbol: r?.tokenMeta?.symbol ?? r?.fileMeta?.symbol ?? null,
          decimals,
          supply: rawSupply != null && decimals != null ? round(rawSupply / 10 ** decimals, 2) : null,
          tokenProgram: r?.tokenProgram ?? null,
          metadataMutable: r?.tokenMeta?.mutable ?? null,
          updateAuthority: r?.tokenMeta?.updateAuthority ?? null,
          uri: r?.tokenMeta?.uri ?? null,
        },
        authorities: { mint: mintAuth, freeze: freezeAuth },
        flags,
        unknown,
        creator: r?.creator ?? null,
        creatorBalance: num(r?.creatorBalance),
        launchpad: r?.launchpad?.name ?? r?.launchpad?.platform ?? null,
        detectedAt: r?.detectedAt ?? null,
        priceUsd: num(r?.price),
        totalMarketLiquidityUsd: round(r?.totalMarketLiquidity, 2),
        totalStableLiquidityUsd: round(r?.totalStableLiquidity, 2),
        totalLpProviders: num(r?.totalLPProviders),
        totalHolders: num(r?.totalHolders),
        insiderNetworks: num(r?.graphInsidersDetected),
        transferFee,
        // Same RugCheck-empty fallback as /api/sol-token-holders: without it
        // this block's rows and concentration go hollow on every mint.
        holders: {
          rows: holdersShaped.rows,
          ...partialFields(holdersShaped.tableRows, holdersShaped.rows.length),
          ...unreadTableFields(holdersShaped.rows, rpc.why),
          maxHolders: 20,
          ...(holdersShaped.rows.length === 0 ? { note: noTableNote(rpc.why) } : {}),
          concentration: holdersShaped.concentration,
        },
        markets: { ...marketsShaped, ...partialFields(marketsShaped.total, marketsShaped.rows.length), maxMarkets: 25 },
        lockers: shapeLockers(r, 10),
        notice: TOKEN_FACTS_NOTICE,
        source: "rugcheck",
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-token-holders - top-holder concentration
  // =========================================================================
  {
    route: "POST /api/sol-token-holders",
    name: "Solana token holder concentration",
    slug: "sol-token-holders", aliases: ["solana-token-holder-concentration", "solana-token-holders"],
    category: "crypto",
    price: "$0.005",
    description:
      "Top-holder concentration for a Solana token mint: the 20 largest holders with token account, owner wallet, balance, percent of supply, insider flag and a pool/locker label when the account is a known AMM vault or locker, plus top-1/5/10/20 share, top-10 share excluding labeled pool accounts, insider count, total holder count and supply. Use it to tell a whale-held launch from one whose largest holder is the liquidity pool. Read from a public token-risk report; when that report carries no holder table, at most two bounded reads from our Solana RPC fill it (the 20 largest token accounts, then one batched owner lookup). Every read runs under a deadline, so a slow upstream answers as a retryable refusal, never a charge; the answer carries returned, matched and complete fields against the 20-row table.",
    tags: ["solana", "token", "holders", "whales", "concentration", "memecoin", "spl"],
    discovery: {
      bodyType: "json",
      input: { mint: MINTS.JUP, limit: 10 },
      inputSchema: {
        properties: {
          mint: { type: "string", maxLength: 44, description: "Base58 SPL token mint address." },
          limit: { type: "number", description: "Holders to return (1-20, default 20)." },
        },
        required: ["mint"],
      },
      output: {
        example: {
          mint: MINTS.JUP, symbol: "JUP", decimals: 6, supply: 6862431164.93, totalHolders: 2873512,
          holders: [{ tokenAccount: "6G4X...", owner: "EXJH...", uiAmount: 1700000000.1, pct: 24.77, insider: false, label: null }],
          returned: 10, matched: 20, complete: false, truncated: true, maxHolders: 20,
          concentration: { top1Pct: 24.77, top5Pct: 57.67, top10Pct: 66.1, top20Pct: 75.2, top10PctExcludingPools: 66.1, insiderHolders: 0, labeledPoolOrLockerAccounts: 0 },
          notice: TOKEN_FACTS_NOTICE,
          source: "rugcheck", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const mint = takeMint(i.mint);
      const limit = takeLimit(i.limit, 20, 20);
      const budget = budgetOf();
      const r = await rugcheckReport(mint, budget);
      const decimals = num(r?.token?.decimals);
      const rawSupply = num(r?.token?.supply);
      const fromRugcheck = Array.isArray(r?.topHolders) && r.topHolders.length > 0;
      const rpc = fromRugcheck ? { rows: null, why: null } : await topAccountsFromRpc(mint, rawSupply, budget);
      const h = shapeHolders(r, limit, rpc.rows);
      return {
        mint,
        symbol: r?.tokenMeta?.symbol ?? null,
        decimals,
        supply: rawSupply != null && decimals != null && (rawSupply > 0 || h.rows.length) ? round(rawSupply / 10 ** decimals, 2) : null,
        // RugCheck's own holder COUNT, and null whenever it does not publish a
        // positive one - never 0. Two reasons, and the second only appeared
        // once the RPC fallback landed: a mint RugCheck does not track answers
        // 0, which reads as "this token has no holders" (corpus, 2026-09-06);
        // and RugCheck's counts degraded with its topHolders (BONK read
        // 2,069,663 and then 0 within hours on 2026-09-19), so with a filled
        // table from the RPC the old expression printed `totalHolders: 0`
        // beside twenty holders - a self-contradicting answer. The table and
        // the count come from different sources now, so each says its own
        // truth and neither invents the other.
        totalHolders: num(r?.totalHolders) > 0 ? num(r?.totalHolders) : null,
        ...(h.rows.length === 0 ? { note: noTableNote(rpc.why) } : {}),
        holders: h.rows,
        // The table either source publishes is at most 20 rows: returned is
        // what this answer holds, matched what the table held.
        ...partialFields(h.tableRows, h.rows.length),
        ...unreadTableFields(h.rows, rpc.why),
        maxHolders: 20,
        concentration: h.rows.length ? h.concentration : null,
        // Say which source produced the TABLE. The insider flag and the
        // pool/locker labels only exist on the RugCheck path, so a buyer reading
        // `rpc` knows `insider` is false-by-absence rather than measured.
        source: fromRugcheck ? "rugcheck" : h.rows.length ? "rugcheck+rpc" : "rugcheck",
        holdersSource: h.rows.length ? (fromRugcheck ? "rugcheck" : "solana-rpc") : null,
        insiderFlagAvailable: fromRugcheck,
        notice: TOKEN_FACTS_NOTICE,
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-token-pairs - DexScreener pairs for a mint
  // =========================================================================
  {
    route: "POST /api/sol-token-pairs",
    name: "Solana token trading pairs",
    slug: "sol-token-pairs",
    category: "crypto",
    price: "$0.003",
    description:
      "Every DEX pair trading a Solana token mint (Raydium, Orca, Meteora, Pump.fun AMM and the rest), sorted by liquidity: pair address, DEX, price in USD and in the quote token, liquidity, FDV and market cap, 5m/1h/6h/24h volume and price change, buy/sell transaction counts, pair age in hours, plus totals across pairs. Computed on top: per pair a liquidity band, an age band, the 24h buy share, the 24h turnover (volume over liquidity) and named flags (thin or dust liquidity, new pair, no profile, one-sided flow, high turnover); per token where its liquidity sits (the deepest pair's share, a concentration index from 0 to 1, deep pairs, DEX count, oldest pair). One request to a public DEX pair index, keyless.",
    tags: ["solana", "dex", "pairs", "liquidity", "volume", "raydium", "memecoin", "spl"],
    discovery: {
      bodyType: "json",
      input: { mint: MINTS.JUP, limit: 5 },
      inputSchema: {
        properties: {
          mint: { type: "string", maxLength: 44, description: "Base58 SPL token mint address." },
          limit: { type: "number", description: "Pairs to return, deepest first (1-30, default 10)." },
        },
        required: ["mint"],
      },
      output: {
        example: {
          mint: MINTS.JUP, totalPairs: 30, totals: { liquidityUsd: 95000000, volume24hUsd: 160000000, txns24h: 40000 },
          analysis: { dexCount: 6, topPairSharePct: 75.3, concentration: 0.58, deepPairs: 4, oldestPairAgeHours: 14000, flaggedPairs: { "thin-liquidity": 9, "no-profile": 3 } },
          pairs: [{ pairAddress: "EoFt...", dex: "meteora", labels: ["DLMM"], base: { address: MINTS.JUP, symbol: "JUP", name: "Jupiter" }, quote: { address: "METv...", symbol: "MET" }, priceUsd: 0.2034, priceNative: 0.9139, liquidityUsd: 71508214.54, fdv: 1395785031, marketCap: 675335464, volume: { m5: 257492.32, h1: 1424742.93, h6: 37797815.88, h24: 149471020.95 }, priceChangePct: { m5: 0.1, h1: -0.4, h6: -0.01, h24: -6.39 }, txns24h: { buys: 1180, sells: 1249 }, txns1h: { buys: 23, sells: 43 }, pairCreatedAt: "2025-10-28T04:06:45.000Z", ageHours: 7160.2, hasProfile: true, url: "https://dexscreener.com/solana/eoft...", signals: { liquidityBand: "deep", age: "established", buyShare24h: 0.49, turnover24h: 2.09, flags: [] } }],
          source: "dexscreener", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const mint = takeMint(i.mint);
      const limit = takeLimit(i.limit, 10, 30);
      const list = await upstreamJson(`${DEXSCREENER}/token-pairs/v1/solana/${mint}`, { label: "DexScreener", step: "token pairs", timeoutMs: DEXSCREENER_MS });
      const rows = (Array.isArray(list) ? list : []).filter((p) => p?.chainId === "solana").map(shapePair).sort(byLiquidity);
      return {
        mint,
        totalPairs: rows.length,
        totals: sumPairs(rows),
        analysis: pairsAnalysis(rows),
        pairs: rows.slice(0, limit),
        source: "dexscreener",
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-token-search - DexScreener search, Solana only
  // =========================================================================
  {
    route: "POST /api/sol-token-search",
    name: "Search Solana tokens and pairs",
    slug: "sol-token-search", aliases: ["search-solana-tokens-and-pairs", "solana-token-search"],
    category: "crypto",
    price: "$0.003",
    description:
      "Find Solana tokens and pairs by name, ticker or address across every DEX a public pair index covers, filtered to Solana only, in the index's relevance order. When that search holds no matching Solana pair (a ticker busy on other chains), the mints come from a Solana token index, in that index's own search order, and their pairs are read by mint. Each row: base and quote token, mint addresses, DEX, price, liquidity, 24h volume and change, transaction counts, pair age and whether the token has a filled-in profile (ticker impostors usually do not), with computed signals per row (liquidity and age bands, 24h buy share, turnover, flags). When several mints answer to the query's ticker, the answer names the one with the most liquidity and marks every other one's rows tickerShadow. Resolve a ticker to a mint here before calling sol-token-pairs or sol-price, which take mint addresses, not tickers. Keyless.",
    tags: ["solana", "search", "token", "ticker", "dex", "memecoin", "spl"],
    discovery: {
      bodyType: "json",
      input: { query: "JUP", limit: 5 },
      inputSchema: {
        properties: {
          query: { type: "string", maxLength: 80, description: "Token name, ticker, or address (1-80 chars)." },
          limit: { type: "number", description: "Pairs to return (1-30, default 10)." },
        },
        required: ["query"],
      },
      output: {
        example: {
          query: "JUP", totalSolanaPairs: 28,
          pairs: [{ pairAddress: "EoFt...", dex: "meteora", labels: ["DLMM"], base: { address: MINTS.JUP, symbol: "JUP", name: "Jupiter" }, quote: { address: MINTS.SOL, symbol: "SOL" }, priceUsd: 0.2034, priceNative: 0.00217, liquidityUsd: 1260729.15, fdv: 1395785031, marketCap: 675335464, volume: { m5: 1000, h1: 20000, h6: 100000, h24: 500000 }, priceChangePct: { m5: 0, h1: -0.3, h6: 0.2, h24: -2.4 }, txns24h: { buys: 900, sells: 850 }, txns1h: { buys: 30, sells: 28 }, pairCreatedAt: "2025-01-01T00:00:00.000Z", ageHours: 14000, hasProfile: true, url: "https://dexscreener.com/solana/eoft...", signals: { liquidityBand: "deep", age: "established", buyShare24h: 0.51, turnover24h: 0.4, flags: [], tickerShadow: false } }],
          analysis: { tickerMints: 3, deepestTickerMint: MINTS.JUP, deepestTickerLiquidityUsd: 1260729.15 },
          returned: 5, matched: 28, complete: false, truncated: true,
          fallback: { ran: false, why: null, status: "not-needed", mints: [] },
          note: "Rows keep DexScreener relevance order.",
          source: "dexscreener", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      if (typeof i.query !== "string" || !i.query.trim()) throw bad('"query" is required (token name, ticker, or address)');
      const query = i.query.trim();
      if (query.length > 80) throw bad('"query" must be 80 characters or fewer');
      const limit = takeLimit(i.limit, 10, 30);
      const budget = budgetOf();
      const data = await upstreamJson(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(query)}`, { label: "DexScreener", step: "pair search", timeoutMs: DEXSCREENER_MS, budget });
      // Upstream relevance order is kept on purpose: re-sorting by liquidity
      // put ticker impostors with spoofed nine-figure liquidity above the real
      // token (measured live on "JUP"). hasProfile + liquidity let the caller
      // rank further.
      const searchRows = (Array.isArray(data?.pairs) ? data.pairs : []).filter((p) => p?.chainId === "solana").map(shapePair);
      // The index's search answers only its top 30 pairs across every chain,
      // so a ticker busy on other chains can leave no Solana row at all
      // (measured 2026-11-07: "WIF" answered 30 pairs, none on Solana). When
      // no Solana row's base token matches the query, the mints come from a
      // Solana token index instead and their pairs are read by mint.
      if (searchRows.some((r) => pairMatchesQuery(r, query))) {
        const analysis = searchAnalysis(searchRows, query);
        return {
          query,
          totalSolanaPairs: searchRows.length,
          analysis,
          pairs: searchRows.slice(0, limit),
          ...partialFields(searchRows.length, Math.min(searchRows.length, limit)),
          fallback: { ran: false, why: null, status: "not-needed", mints: [] },
          note: SEARCH_NOTE,
          source: "dexscreener",
          fetchedAt: stamp(),
        };
      }
      const why = searchRows.length ? "no-matching-solana-pairs" : "no-solana-pairs";
      const fb = await searchFallback(query, budget);
      const rows = mergeFallbackRows(searchRows, fb);
      if (!rows.length && fb.unavailable) {
        // Nothing found, and a read that could have found it did not answer
        // (the whole fallback, or one of its two pair reads while the other
        // held no Solana pair): an empty 200 would read as "no such token".
        // Answer the upstream's 5xx instead (never charged, settlement runs
        // after the handler).
        const e = fb.error;
        if (e && e.statusCode >= 500) throw e;
        // No read was sent: the call's own budget ran out first. That is ours.
        if (fb.unavailable.reason === "budget") {
          const spent = budgetSpentError(fb.unavailable.upstream, fb.unavailable.step, budget.totalMs);
          spent.message = `Solana token search found no pairs. ${spent.message}`;
          throw spent;
        }
        // What is left is an answer that was not results: the upstream's own
        // HTTP 4xx refusal (upstreamJsonOnce's 422 for a 400 or 404 it
        // answered; attributed to it, and said as such), or a reply that was
        // not usable with no status to show whose side it was.
        if (e && e.statusCode >= 400 && e.statusCode < 500) throw Object.assign(bad(`Solana token search found no pairs and the ${fb.unavailable.upstream} ${fb.unavailable.step} read answered with a refusal (HTTP 4xx) instead of results - retry shortly`, 503), { attribution: "upstream" });
        throw Object.assign(bad(`Solana token search found no pairs and the ${fb.unavailable.upstream} ${fb.unavailable.step} read gave no usable answer - retry shortly`, 503), { attribution: "unknown" });
      }
      const incomplete = fb.status === "unavailable" || fb.status === "partial";
      const analysis = searchAnalysis(rows, query);
      return {
        query,
        totalSolanaPairs: rows.length,
        analysis,
        pairs: rows.slice(0, limit),
        ...partialFields(rows.length, Math.min(rows.length, limit)),
        // A mint read that did not answer leaves pairs unread: this answer is
        // not the whole list, whatever its row count says.
        ...(incomplete ? { complete: false, truncated: true } : {}),
        fallback: { ran: true, why, status: fb.status, mints: fb.mints, ...(fb.unavailable ? { unavailable: fb.unavailable } : {}) },
        note: fb.status === "found" || fb.status === "partial" ? FALLBACK_NOTE : SEARCH_NOTE,
        // The fallback asked the Solana token index for the mints, then the
        // pair index for their pairs: the answer names both.
        source: [...SEARCH_FALLBACK_SOURCES],
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-trending - DexScreener top boosts + latest profiles, Solana only
  // =========================================================================
  {
    route: "POST /api/sol-trending",
    name: "Trending and newly profiled Solana tokens",
    slug: "sol-trending", aliases: ["trending-solana-tokens", "solana-trending-tokens"],
    category: "crypto",
    price: "$0.003",
    description:
      "What Solana tokens are being pushed right now: a public DEX pair index's top boosted tokens (paid promotion, ranked by boost amount - a signal of marketing spend, not quality) and the latest token profiles (fresh listings with a filled-in profile), both filtered to Solana. Each row carries the mint, the index's token page URL, description snippet and links. Computed on top: each boost's share of the Solana boost spend and the top five's share, the mints that are both boosted and newly profiled, community takeovers, and per row the link count and whether it lists a website and socials. Feed the mints into sol-token-pairs to read each one's pairs, liquidity, volume and pair age, or into sol-price for its USD price, before going further. Keyless; two small reads in parallel.",
    tags: ["solana", "trending", "boosts", "new-tokens", "memecoin", "discovery", "spl"],
    discovery: {
      bodyType: "json",
      input: { limit: 10 },
      inputSchema: {
        properties: {
          limit: { type: "number", description: "Rows per list (1-30, default 10)." },
          list: { type: "string", description: "\"boosts\", \"profiles\", or \"both\" (default both)." },
        },
      },
      output: {
        example: {
          boosts: [{ mint: "918p...pump", boostAmount: 500, boostSharePct: 21.7, description: "The cats have arrived", links: [{ type: "website", url: "https://example.com" }], linkCount: 1, hasWebsite: true, hasSocials: false, alsoNewProfile: false, url: "https://dexscreener.com/solana/918p..." }],
          profiles: [{ mint: "AiRG...pump", description: "", communityTakeover: false, links: [{ type: "twitter", url: "https://x.com/..." }], linkCount: 1, hasWebsite: false, hasSocials: true, alsoBoosted: false, url: "https://dexscreener.com/solana/airg..." }],
          counts: { boostsSolana: 24, boostsAll: 30, profilesSolana: 30, profilesAll: 30 },
          analysis: { boostTotal: 2300, top5BoostSharePct: 64.1, boostedAndNewlyProfiled: [], communityTakeovers: 2 },
          source: "dexscreener", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const limit = takeLimit(i.limit, 10, 30);
      const list = i.list == null || i.list === "" ? "both" : String(i.list).toLowerCase();
      if (!["boosts", "profiles", "both"].includes(list)) throw bad('"list" must be "boosts", "profiles", or "both"');
      const wantBoosts = list !== "profiles";
      const wantProfiles = list !== "boosts";
      const budget = budgetOf();
      const [boosts, profiles] = await Promise.all([
        wantBoosts ? upstreamJson(`${DEXSCREENER}/token-boosts/top/v1`, { label: "DexScreener", step: "top boosts", timeoutMs: DEXSCREENER_MS, budget }) : Promise.resolve([]),
        wantProfiles ? upstreamJson(`${DEXSCREENER}/token-profiles/latest/v1`, { label: "DexScreener", step: "latest profiles", timeoutMs: DEXSCREENER_MS, budget }) : Promise.resolve([]),
      ]);
      const bAll = Array.isArray(boosts) ? boosts : [];
      const pAll = Array.isArray(profiles) ? profiles : [];
      const bSol = bAll.filter((t) => t?.chainId === "solana");
      const pSol = pAll.filter((t) => t?.chainId === "solana");
      // Computed over every Solana row the index returned, not only the rows
      // shown: each boost's share of the Solana boost spend, how much of it
      // the top five hold, the mints that are both boosted and newly
      // profiled, and how complete each row's links are.
      const amountOf = (t) => num(t.totalAmount ?? t.amount) || 0;
      const boostTotal = bSol.reduce((a, t) => a + amountOf(t), 0);
      const top5 = bSol.map(amountOf).sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
      const boostedMints = new Set(bSol.map((t) => t.tokenAddress).filter(Boolean));
      const inBoth = [...new Set(pSol.map((t) => t.tokenAddress).filter((m) => m && boostedMints.has(m)))];
      const linkSignals = (links) => {
        const shaped = shapeLinks(links);
        const kinds = new Set(shaped.map((l) => String(l.type || "").toLowerCase()));
        return { linkCount: shaped.length, hasWebsite: kinds.has("website"), hasSocials: [...kinds].some((k) => k && k !== "website") };
      };
      return {
        boosts: wantBoosts ? bSol.slice(0, limit).map((t) => ({
          mint: t.tokenAddress ?? null,
          boostAmount: num(t.totalAmount ?? t.amount),
          boostSharePct: boostTotal > 0 ? round((amountOf(t) / boostTotal) * 100, 1) : null,
          description: t.description ? String(t.description).slice(0, 200) : null,
          links: shapeLinks(t.links),
          ...linkSignals(t.links),
          alsoNewProfile: inBoth.includes(t.tokenAddress),
          url: t.url ?? null,
        })) : null,
        profiles: wantProfiles ? pSol.slice(0, limit).map((t) => ({
          mint: t.tokenAddress ?? null,
          description: t.description ? String(t.description).slice(0, 200) : null,
          communityTakeover: Boolean(t.cto),
          links: shapeLinks(t.links),
          ...linkSignals(t.links),
          alsoBoosted: boostedMints.has(t.tokenAddress),
          url: t.url ?? null,
        })) : null,
        counts: { boostsSolana: bSol.length, boostsAll: bAll.length, profilesSolana: pSol.length, profilesAll: pAll.length },
        analysis: {
          boostTotal: wantBoosts ? round(boostTotal, 2) : null,
          top5BoostSharePct: wantBoosts && boostTotal > 0 ? round((top5 / boostTotal) * 100, 1) : null,
          boostedAndNewlyProfiled: wantBoosts && wantProfiles ? inBoth.slice(0, limit) : null,
          communityTakeovers: wantProfiles ? pSol.filter((t) => t.cto).length : null,
        },
        note: "Boosts are paid promotion ranked by amount; profiles are the newest tokens with a filled-in DexScreener profile. Neither is a fact about the token's contract or holders.",
        source: "dexscreener",
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-price - the deepest DEX pair per mint, decimals and slot on chain
  // =========================================================================
  {
    route: "POST /api/sol-price",
    name: "Solana token prices",
    slug: "sol-price",
    category: "crypto",
    price: "$0.001",
    description:
      `USD prices for up to ${SOL_PRICE_MAX_MINTS} Solana token mints in one batch call: each mint's price and 24h change from the deepest DEX market that trades it, its liquidity, and its decimals with the slot they were read at on chain. A mint nothing prices comes back listed under missing rather than erroring the batch. Pass mint addresses, not tickers (resolve tickers with sol-token-search).`,
    tags: ["solana", "price", "token", "spl", "batch"],
    discovery: {
      bodyType: "json",
      input: { mints: [MINTS.SOL, MINTS.JUP] },
      inputSchema: {
        properties: {
          mints: { type: "array", items: { type: "string" }, description: `1-${SOL_PRICE_MAX_MINTS} base58 mint addresses (array, or a comma-separated string).` },
        },
        required: ["mints"],
      },
      output: {
        example: {
          count: 2, missing: [],
          prices: { [MINTS.SOL]: { priceUsd: 93.7085, priceChange24hPct: 3.93, liquidityUsd: 48142746.9, decimals: 9, blockId: 440919037 }, [MINTS.JUP]: { priceUsd: 0.2035, priceChange24hPct: -2.4, liquidityUsd: 3092234.59, decimals: 6, blockId: 440919037 } },
          priceFrom: { [MINTS.SOL]: "base", [MINTS.JUP]: "base" },
          source: "dexscreener", fetchedAt: "2026-11-23T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      let raw = i.mints;
      if (typeof raw === "string") raw = raw.split(",");
      if (!Array.isArray(raw) || raw.length === 0) throw bad(`"mints" is required: 1-${SOL_PRICE_MAX_MINTS} base58 mint addresses`);
      if (raw.length > SOL_PRICE_MAX_MINTS) throw bad(`"mints" must contain at most ${SOL_PRICE_MAX_MINTS} entries (got ${raw.length})`);
      const mints = [...new Set(raw.map((m) => takeMint(m, "mints[]")))];
      // The handler's own budget: every read here ends inside it.
      const budget = currentBudget() || undefined;
      const chunks = [];
      for (let k = 0; k < mints.length; k += PAIR_READ_MAX_MINTS) chunks.push(mints.slice(k, k + PAIR_READ_MAX_MINTS));
      // The pair reads decide the answer; the on-chain read only fills
      // decimals and the slot, so it runs beside them and may come back empty.
      const [lists, chain] = await Promise.all([
        Promise.all(chunks.map((ids) => upstreamJson(`${DEXSCREENER}/tokens/v1/solana/${ids.join(",")}`, { label: "DexScreener", step: "pairs by mint", timeoutMs: DEXSCREENER_MS, budget }))),
        mintAccountsOnChain(mints, budget),
      ]);
      const pairs = lists.flatMap((l) => (Array.isArray(l) ? l : [])).filter((p) => p?.chainId === "solana");
      const prices = {};
      const priceFrom = {};
      const missing = [];
      mints.forEach((m, idx) => {
        const p = priceOfMint(m, pairs);
        if (!p) { missing.push(m); return; }
        const acct = chain.accounts ? chain.accounts[idx] : null;
        prices[m] = {
          priceUsd: p.priceUsd,
          priceChange24hPct: p.priceChange24hPct,
          liquidityUsd: p.liquidityUsd,
          decimals: num(acct?.data?.parsed?.info?.decimals),
          blockId: chain.slot,
        };
        priceFrom[m] = p.from;
      });
      return { count: Object.keys(prices).length, missing, prices, priceFrom, source: "dexscreener", fetchedAt: stamp() };
    },
  },
];
// Attribution the Jupiter API license requires on any product that serves its
// data ("Powered by Jupiter", SDK & API License Agreement clause 8.4,
// https://developers.jup.ag/docs/legal/sdk-api-license-agreement). The tools
// that read Jupiter end their description with it; the vendor-name check in
// scripts/test-no-third-party-names.js allows it there and nowhere else.
export { JUPITER_ATTRIBUTION };
const JUPITER_SLUGS = new Set(["sol-token-safety", "sol-token-search"]);
for (const t of SOLANA_INTEL_TOOLS) if (JUPITER_SLUGS.has(t.slug)) attribute(t, "jupiter");
// RugCheck's report is the source of these three answers (the safety read's
// summary, the trimmed report, the holder table and count), credited by name
// and link on every answer (src/data-attribution.js).
const RUGCHECK_CREDITED = new Set(["sol-token-safety", "sol-token-report", "sol-token-holders"]);
for (const t of SOLANA_INTEL_TOOLS) if (RUGCHECK_CREDITED.has(t.slug)) creditAnswers(t, RUGCHECK_ATTRIBUTION);

/** The token index entries for a mint, ticker or name, exact mint match
 *  first: one input the token brief reads (src/tools/token-brief-kit.js) and
 *  computes from. Not a catalog route. */
export async function tokenIndexLookup(query, limit = 1) {
  const q = String(query || "").trim();
  if (!q || q.length > 80) throw bad('"query" must be 1-80 characters');
  const list = await upstreamJson(`${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(q)}`, { label: "Jupiter", step: "token search", timeoutMs: JUPITER_MS });
  const rows = (Array.isArray(list) ? list : []).map(shapeJupToken).filter(Boolean);
  if (BASE58_RE.test(q)) rows.sort((a, b) => (b.mint === q) - (a.mint === q));
  return { query: q, count: Math.min(rows.length, limit), tokens: rows.slice(0, limit) };
}

// Exported for offline unit tests (pure shaping, no network).
export const __test = { PAIR_SIGNAL_FLAGS, pairSignals, takeMint, takeLimit, searchKeys, pairMatchesQuery, mergeFallbackRows, shapeHolders, shapeMarkets, shapePair, shapeJupToken, priceOfMint, authorityState, solanaTokenFlags, BASE58_RE, budgetOf, topAccountsFromRpc,
  DEADLINES: Object.freeze({ HANDLER_BUDGET_MS, RUGCHECK_SUMMARY_MS, RUGCHECK_REPORT_MS, JUPITER_MS, DEXSCREENER_MS, RPC_MS, RPC_FLOOR_MS, FULL_REPORT_FLOOR_MS, RUGCHECK_FALLBACK_MS }), reportReadsInflight: () => reportReads.inflightSize() };

// Free text in these results is written by third parties (headlines, posts,
// casts, token names and descriptions, page titles). Anyone can mint a token or
// publish a post, so this is the cheapest prompt-injection delivery vehicle in
// the catalog: flag it as data, never instructions, the way site-crawl does.
const UNTRUSTED_TEXT_SLUGS = new Set(["sol-trending", "sol-token-search", "sol-token-pairs", "sol-token-report", "sol-token-safety"]);
for (const t of SOLANA_INTEL_TOOLS) {
  if (!UNTRUSTED_TEXT_SLUGS.has(t.slug)) continue;
  const inner = t.handler;
  t.handler = async (...args) => markUntrusted(await inner(...args));
}

// Every handler runs under one budget (src/upstream-deadline.js).
underBudgetAll(SOLANA_INTEL_TOOLS, PAYMENT_WINDOW_BUDGET_MS);

// The tools whose answer is a RugCheck read. They are listed only while
// RUGCHECK_TOOLS=on: with the upstream unreachable each one can only fail, and
// an unlisted route is honest where a listed one quotes a price it cannot
// serve. The handlers stay exported in SOLANA_INTEL_TOOLS, so the token brief
// keeps probing them (each probe is non-fatal there) and the unit tests run.
export function solanaIntelToolsEnabled(env = process.env) {
  return rugcheckEnabled(env) ? SOLANA_INTEL_TOOLS : SOLANA_INTEL_TOOLS.filter((t) => !RUGCHECK_SLUGS.has(t.slug));
}
