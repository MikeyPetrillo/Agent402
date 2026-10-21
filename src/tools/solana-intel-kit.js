// Solana intel kit - token safety, liquidity, price and swap intel for SPL
// tokens, all from public keyless APIs:
//
//   RugCheck    api.rugcheck.xyz      risk score, risks, authorities, LP lock,
//                                     top holders, markets, lockers, insiders
//   DexScreener api.dexscreener.com   pairs per mint, search, boosted/new tokens
//   Jupiter     lite-api.jup.ag       price v3, swap quote, token search/audit
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
//   - Jupiter price v2 (api.jup.ag/price/v2) answers 404 - v3 on lite-api is
//     the keyless host. The v3 map only carries mints it knows; unknown mints
//     are simply absent (no error).
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
import { HANDLER_BUDGET_MS, budgetOf, upstreamFetch, bodyUnderDeadline, underBudgetAll, PAYMENT_WINDOW_BUDGET_MS, capOf, currentBudget } from "../upstream-deadline.js";
import { RUGCHECK_SLUGS, rugcheckEnabled } from "../rugcheck-switch.js";
import { rugcheckPause, rugcheckFailureKind, rugcheckInputKey } from "../rugcheck-pause.js";
export { RUGCHECK_SLUGS, rugcheckEnabled };
const MAX_BODY_BYTES = 24 * 1024 * 1024;  // DefiLlama bulk docs run ~11MB; this is the hard ceiling.
// Refuse an over-large body BEFORE reading it into a string: `res.text()` has
// no cap of its own, so a broken or hostile upstream could push an unbounded
// buffer into memory once per concurrent call.
function assertBodyWithinCap(res, capBytes, label) {
  const declared = Number(res.headers?.get?.("content-length") || 0);
  if (declared && declared > capBytes) {
    const e = new Error(`${label} response is larger than the ${Math.round(capBytes / 1048576)}MB cap`);
    e.statusCode = 502; throw e;
  }
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
    // pubkey; Jupiter quote answers 400 TOKEN_NOT_TRADABLE. Both are "we
    // cannot say anything about this input", not a server fault. But RugCheck
    // also answers 400/404 {"error":"unable to generate report"} for EVERY
    // mint while its report builder is down (measured 2026-09-25 on JUP and
    // BONK): that is its outage, not the buyer's input, so it is a retryable
    // 503 rather than a 422 blaming the mint.
    const errText = await res.text().then((t) => t.slice(0, 500)).catch(() => "");
    if (/unable to generate|temporarily|try again|timeout/i.test(errText)) {
      // RugCheck answered for this input; the pause does not count it.
      throw Object.assign(bad(`${label} could not produce a report right now (upstream) - retry shortly`, 503), { rugcheckNoReport: true });
    }
    throw bad(notFound || `${label} has no data for that input`, 422);
  }
  if (!res.ok) throw bad(`${label} refused the request (HTTP ${res.status})`, 502);
  let text;
  assertBodyWithinCap(res, MAX_BODY_BYTES, label);
  // The same signal bounds the body, so a body that stalls past the cap ends
  // as the deadline it is, not as an unreadable response.
  try { text = await bodyUnderDeadline(res.text(), ctx); } catch (err) {
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
// RugCheck shaping
// ---------------------------------------------------------------------------
function shapeRisks(risks) {
  return (Array.isArray(risks) ? risks : []).slice(0, 25).map((r) => ({
    name: String(r?.name ?? ""),
    level: String(r?.level ?? ""),
    score: num(r?.score),
    value: r?.value ? String(r.value).slice(0, 120) : null,
    description: r?.description ? String(r.description).slice(0, 240) : null,
  }));
}

function riskCounts(risks) {
  const c = { danger: 0, warn: 0, info: 0 };
  for (const r of risks) {
    const lvl = String(r?.level || "").toLowerCase();
    if (lvl in c) c[lvl] += 1;
  }
  return c;
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
  return {
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
}

const byLiquidity = (a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0);

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
    isVerified: Boolean(t.isVerified),
    organicScore: round(t.organicScore, 2),
    organicScoreLabel: t.organicScoreLabel ?? null,
    tags: Array.isArray(t.tags) ? t.tags.slice(0, 12) : [],
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
  // sol-token-safety - headline safety read: RugCheck summary + Jupiter audit
  // =========================================================================
  {
    route: "POST /api/sol-token-safety",
    name: "Solana token risk check",
    slug: "sol-token-safety",
    category: "crypto",
    price: "$0.005",
    description:
      "Safety headline for any Solana SPL token mint: a public token-risk score (raw + 0-100 normalized), the named risks with level (danger/warn/info), LP locked percentage, and the aggregator's audit facts - mint authority and freeze authority revoked or live, top-holder share, dev mints, holder count, verified flag and organic score. Two keyless public sources read in parallel; one compact verdict for pre-trade screening of memecoins and new launches. The full token-risk report is read only when a published field needs it (the aggregator does not index the mint, or the summary carries no score), and fullReport names the fields it filled.",
    tags: ["solana", "token", "safety", "memecoin", "risk", "spl"],
    discovery: {
      bodyType: "json",
      input: { mint: MINTS.JUP },
      inputSchema: {
        properties: {
          mint: { type: "string", description: "Base58 SPL token mint address." },
        },
        required: ["mint"],
      },
      output: {
        example: {
          mint: MINTS.JUP,
          score: 3550201, scoreNormalised: 97, lpLockedPct: 8.98,
          risks: [{ name: "Mutable metadata", level: "warn", score: 100, value: null, description: "Token metadata can be changed by the update authority" }],
          riskCounts: { danger: 0, warn: 1, info: 0 },
          token: { name: "Jupiter", symbol: "JUP", decimals: 6, holderCount: 835540, isVerified: true, organicScore: 99.3, organicScoreLabel: "high", launchpad: null },
          authorities: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, mintAuthority: null, freezeAuthority: null },
          holders: { topHoldersPct: 15.28, devBalancePct: null, devMints: 1 },
          riskLevel: "good",
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
      // measured 3.6 s for JUP) is read only when a published field would
      // otherwise be null: the summary carried no score, or Jupiter does not
      // index the mint (token, authorities). That read is optional: when it
      // cannot finish, the fields stay null and `fullReport` says why.
      const [summary, jupList] = await Promise.all([
        upstreamJson(`${RUGCHECK}/tokens/${mint}/report/summary`, { label: "RugCheck", step: "report summary", timeoutMs: RUGCHECK_SUMMARY_MS, budget, notFound: "RugCheck has no report for that mint (not an SPL token mint?)" }),
        upstreamJson(`${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(mint)}`, { label: "Jupiter", step: "token search", timeoutMs: JUPITER_MS, budget }),
      ]);
      const jt = shapeJupToken((Array.isArray(jupList) ? jupList : []).find((t) => t?.id === mint) || null);
      const need = [];
      if (num(summary?.score_normalised) == null) need.push("score");
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
      let risks = shapeRisks(summary?.risks);
      let score = num(summary?.score);
      let normalised = num(summary?.score_normalised);
      if (full && need.includes("score") && num(full?.score_normalised) != null) {
        score = num(full.score); normalised = num(full.score_normalised); risks = shapeRisks(full.risks); filled.push("score", "risks");
      }
      const counts = riskCounts(risks);
      let token = jt ? { name: jt.name, symbol: jt.symbol, decimals: jt.decimals, holderCount: jt.holderCount, isVerified: jt.isVerified, organicScore: jt.organicScore, organicScoreLabel: jt.organicScoreLabel, launchpad: jt.launchpad } : null;
      let authorities = jt ? { mintAuthorityDisabled: jt.audit.mintAuthorityDisabled, freezeAuthorityDisabled: jt.audit.freezeAuthorityDisabled, mintAuthority: jt.mintAuthority, freezeAuthority: jt.freezeAuthority } : null;
      if (full && !jt) {
        // The report's own fields; Jupiter-only facts (organic score) stay null.
        token = {
          name: full?.tokenMeta?.name ?? full?.fileMeta?.name ?? null,
          symbol: full?.tokenMeta?.symbol ?? full?.fileMeta?.symbol ?? null,
          decimals: num(full?.token?.decimals),
          // RugCheck reports 0 when it has not counted (measured on USDC):
          // a zero is "no count", never "no holders".
          holderCount: num(full?.totalHolders) > 0 ? num(full.totalHolders) : null,
          isVerified: full?.verification ? Boolean(full.verification.jup_verified) : null,
          organicScore: null, organicScoreLabel: null,
          launchpad: full?.launchpad?.name ?? full?.launchpad?.platform ?? null,
        };
        const m = authorityState(full?.token?.mintAuthority ?? full?.mintAuthority);
        const f = authorityState(full?.token?.freezeAuthority ?? full?.freezeAuthority);
        authorities = { mintAuthorityDisabled: m.revoked, freezeAuthorityDisabled: f.revoked, mintAuthority: m.address, freezeAuthority: f.address };
        filled.push("token", "authorities");
      }
      if (full) fullReport = { read: true, needed: need, filled };
      // Deterministic band from RugCheck's own numbers (lower is safer). Note
      // RugCheck flags "LP Vault unlocked" as danger on established tokens too,
      // so an old blue chip can land in "danger"; the authorities/holders
      // fields carry the rest of the picture.
      let riskLevel = "unknown";
      if (normalised != null) {
        if (counts.danger > 0 || normalised > 60) riskLevel = "danger";
        else if (normalised > 20 || counts.warn > 1) riskLevel = "warn";
        else riskLevel = "good";
      }
      return {
        mint,
        score,
        scoreNormalised: normalised,
        lpLockedPct: round(summary?.lpLockedPct, 2),
        tokenProgram: summary?.tokenProgram ?? full?.tokenProgram ?? null,
        risks,
        riskCounts: counts,
        token,
        authorities,
        holders: jt ? { topHoldersPct: jt.audit.topHoldersPct, devBalancePct: jt.audit.devBalancePct, devMints: jt.audit.devMints } : null,
        riskLevel,
        // null when the summary and Jupiter carried everything (the usual
        // case); otherwise which fields needed the full report, which it
        // filled, and why it could not when it could not.
        fullReport,
        note: "riskLevel bands RugCheck's own score and risk levels (lower score is safer, normalized 0-100); it is not a recommendation. Jupiter fields are null when Jupiter does not index the mint; token and authorities then come from RugCheck's full report when it answers (fullReport says which), and holders stays null.",
        source: filled.length ? ["rugcheck", "jupiter", "rugcheck-report"] : ["rugcheck", "jupiter"],
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-token-report - RugCheck full report, trimmed
  // =========================================================================
  {
    route: "POST /api/sol-token-report",
    name: "Solana token risk report (full)",
    slug: "sol-token-report", aliases: ["solana-token-risk-report", "solana-token-risk"],
    category: "crypto",
    price: "$0.010",
    description:
      "Full public token-risk report for a Solana token mint, trimmed to what an agent acts on: score and risks, mint/freeze authority state, metadata mutability and update authority, supply and decimals, creator and creator balance, top 20 holders with percent, owner, insider flag and pool/locker labels, concentration totals, the deepest markets (liquidity, LP locked %), lockers, total market liquidity, LP providers, holder count, rugged flag, insider-network count, launchpad and transfer-fee config. One report read, plus at most two bounded reads from our Solana RPC (the 20 largest token accounts, then one batched owner lookup) only when the report carries no holder table; every read runs under a deadline, so a slow upstream answers as a retryable refusal, never a charge. The holders and markets blocks carry returned, matched and complete fields. Blue-chip reports run to megabytes upstream and come back here in a few KB.",
    tags: ["solana", "token", "report", "holders", "liquidity", "risk", "spl"],
    discovery: {
      bodyType: "json",
      input: { mint: MINTS.JUP, marketLimit: 5, holderLimit: 10 },
      inputSchema: {
        properties: {
          mint: { type: "string", description: "Base58 SPL token mint address." },
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
          score: 3550201, scoreNormalised: 97, rugged: false, risks: [], riskCounts: { danger: 0, warn: 0, info: 0 },
          creator: null, creatorBalance: 0, launchpad: null, detectedAt: "2024-05-29T00:40:51Z",
          priceUsd: 0.2027, totalMarketLiquidityUsd: 3585833.66, totalLpProviders: 173, totalHolders: 2873512, insiderNetworks: 0,
          transferFee: { pct: 0, maxAmount: 0 },
          holders: { rows: [{ tokenAccount: "6G4X...", owner: "EXJH...", uiAmount: 1700000000.1, pct: 24.77, insider: false, label: null }], returned: 10, matched: 20, complete: false, truncated: true, maxHolders: 20, concentration: { top1Pct: 24.77, top5Pct: 57.67, top10Pct: 66.1, top20Pct: 75.2, top10PctExcludingPools: 66.1, insiderHolders: 0, labeledPoolOrLockerAccounts: 0 } },
          markets: { total: 1409, rows: [{ pool: "C8Gr...", type: "meteoraDlmm", mintA: MINTS.JUP, mintB: MINTS.SOL, liquidityUsd: 1260729.15, lpLockedPct: 0, lpLockedUsd: 0, lpProviders: 0 }], returned: 5, matched: 1409, complete: false, truncated: true, maxMarkets: 25 },
          lockers: { total: 2, rows: [] },
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
      const risks = shapeRisks(r?.risks);
      const decimals = num(r?.token?.decimals);
      const rawSupply = num(r?.token?.supply);
      const rpc = Array.isArray(r?.topHolders) && r.topHolders.length ? { rows: null, why: null } : await topAccountsFromRpc(mint, rawSupply, budget);
      const holdersShaped = shapeHolders(r, holderLimit, rpc.rows);
      const marketsShaped = shapeMarkets(r, marketLimit);
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
        authorities: {
          mint: authorityState(r?.token?.mintAuthority ?? r?.mintAuthority),
          freeze: authorityState(r?.token?.freezeAuthority ?? r?.freezeAuthority),
        },
        score: num(r?.score),
        scoreNormalised: num(r?.score_normalised),
        rugged: Boolean(r?.rugged),
        risks,
        riskCounts: riskCounts(risks),
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
        transferFee: r?.transferFee ? { pct: num(r.transferFee.pct), maxAmount: num(r.transferFee.maxAmount) } : null,
        verification: r?.verification ? { jupVerified: Boolean(r.verification.jup_verified), jupStrict: Boolean(r.verification.jup_strict) } : null,
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
          mint: { type: "string", description: "Base58 SPL token mint address." },
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
      "Every DEX pair trading a Solana token mint (Raydium, Orca, Meteora, Pump.fun AMM and the rest), sorted by liquidity: pair address, DEX, price in USD and in the quote token, liquidity, FDV and market cap, 5m/1h/6h/24h volume and price change, buy/sell transaction counts, pair age in hours, plus totals across pairs. One request to a public DEX pair index, keyless.",
    tags: ["solana", "dex", "pairs", "liquidity", "volume", "raydium", "memecoin", "spl"],
    discovery: {
      bodyType: "json",
      input: { mint: MINTS.JUP, limit: 5 },
      inputSchema: {
        properties: {
          mint: { type: "string", description: "Base58 SPL token mint address." },
          limit: { type: "number", description: "Pairs to return, deepest first (1-30, default 10)." },
        },
        required: ["mint"],
      },
      output: {
        example: {
          mint: MINTS.JUP, totalPairs: 30, totals: { liquidityUsd: 95000000, volume24hUsd: 160000000, txns24h: 40000 },
          pairs: [{ pairAddress: "EoFt...", dex: "meteora", labels: ["DLMM"], base: { address: MINTS.JUP, symbol: "JUP", name: "Jupiter" }, quote: { address: "METv...", symbol: "MET" }, priceUsd: 0.2034, priceNative: 0.9139, liquidityUsd: 71508214.54, fdv: 1395785031, marketCap: 675335464, volume: { m5: 257492.32, h1: 1424742.93, h6: 37797815.88, h24: 149471020.95 }, priceChangePct: { m5: 0.1, h1: -0.4, h6: -0.01, h24: -6.39 }, txns24h: { buys: 1180, sells: 1249 }, txns1h: { buys: 23, sells: 43 }, pairCreatedAt: "2025-10-28T04:06:45.000Z", ageHours: 7160.2, hasProfile: true, url: "https://dexscreener.com/solana/eoft..." }],
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
      "Find Solana tokens and pairs by name, ticker or address across every DEX a public pair index covers, filtered to Solana only, in the index's relevance order: base and quote token, mint addresses, DEX, price, liquidity, 24h volume and change, transaction counts, pair age and whether the token has a filled-in profile (ticker impostors usually do not). Resolve a ticker to a mint before calling sol-token-safety or sol-swap-quote. Keyless.",
    tags: ["solana", "search", "token", "ticker", "dex", "memecoin", "spl"],
    discovery: {
      bodyType: "json",
      input: { query: "JUP", limit: 5 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "Token name, ticker, or address (1-80 chars)." },
          limit: { type: "number", description: "Pairs to return (1-30, default 10)." },
        },
        required: ["query"],
      },
      output: {
        example: {
          query: "JUP", totalSolanaPairs: 28,
          pairs: [{ pairAddress: "EoFt...", dex: "meteora", labels: ["DLMM"], base: { address: MINTS.JUP, symbol: "JUP", name: "Jupiter" }, quote: { address: MINTS.SOL, symbol: "SOL" }, priceUsd: 0.2034, priceNative: 0.00217, liquidityUsd: 1260729.15, fdv: 1395785031, marketCap: 675335464, volume: { m5: 1000, h1: 20000, h6: 100000, h24: 500000 }, priceChangePct: { m5: 0, h1: -0.3, h6: 0.2, h24: -2.4 }, txns24h: { buys: 900, sells: 850 }, txns1h: { buys: 30, sells: 28 }, pairCreatedAt: "2025-01-01T00:00:00.000Z", ageHours: 14000, hasProfile: true, url: "https://dexscreener.com/solana/eoft..." }],
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
      const data = await upstreamJson(`${DEXSCREENER}/latest/dex/search?q=${encodeURIComponent(query)}`, { label: "DexScreener", step: "pair search", timeoutMs: DEXSCREENER_MS });
      // Upstream relevance order is kept on purpose: re-sorting by liquidity
      // put ticker impostors with spoofed nine-figure liquidity above the real
      // token (measured live on "JUP"). hasProfile + liquidity let the caller
      // rank further.
      const rows = (Array.isArray(data?.pairs) ? data.pairs : []).filter((p) => p?.chainId === "solana").map(shapePair);
      return {
        query,
        totalSolanaPairs: rows.length,
        pairs: rows.slice(0, limit),
        note: "Rows keep DexScreener relevance order. Several tokens can share a ticker; check hasProfile, liquidity and age, then confirm the mint with sol-token-safety.",
        source: "dexscreener",
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
      "What Solana tokens are being pushed right now: a public DEX pair index's top boosted tokens (paid promotion, ranked by boost amount - a signal of marketing spend, not quality) and the latest token profiles (fresh listings with a filled-in profile), both filtered to Solana. Each row carries the mint, the index's token page URL, description snippet and links. Feed the mints into sol-token-safety to separate the promoted from the sound. Keyless; two small reads in parallel.",
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
          boosts: [{ mint: "918p...pump", boostAmount: 500, description: "The cats have arrived", links: [{ type: "website", url: "https://example.com" }], url: "https://dexscreener.com/solana/918p..." }],
          profiles: [{ mint: "AiRG...pump", description: "", communityTakeover: false, links: [{ type: "twitter", url: "https://x.com/..." }], url: "https://dexscreener.com/solana/airg..." }],
          counts: { boostsSolana: 24, boostsAll: 30, profilesSolana: 30, profilesAll: 30 },
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
      return {
        boosts: wantBoosts ? bSol.slice(0, limit).map((t) => ({
          mint: t.tokenAddress ?? null,
          boostAmount: num(t.totalAmount ?? t.amount),
          description: t.description ? String(t.description).slice(0, 200) : null,
          links: shapeLinks(t.links),
          url: t.url ?? null,
        })) : null,
        profiles: wantProfiles ? pSol.slice(0, limit).map((t) => ({
          mint: t.tokenAddress ?? null,
          description: t.description ? String(t.description).slice(0, 200) : null,
          communityTakeover: Boolean(t.cto),
          links: shapeLinks(t.links),
          url: t.url ?? null,
        })) : null,
        counts: { boostsSolana: bSol.length, boostsAll: bAll.length, profilesSolana: pSol.length, profilesAll: pAll.length },
        note: "Boosts are paid promotion ranked by amount; profiles are the newest tokens with a filled-in DexScreener profile. Neither is a safety signal.",
        source: "dexscreener",
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-price - Jupiter price v3, up to 50 mints
  // =========================================================================
  {
    route: "POST /api/sol-price",
    name: "Solana token prices",
    slug: "sol-price",
    category: "crypto",
    price: "$0.001",
    description:
      "USD price for up to 50 Solana token mints in one call from a Solana DEX aggregator's price API: price, 24h change, liquidity, decimals and the block the price was read at. Mints the aggregator does not price come back listed under missing rather than erroring the batch. Pass mint addresses, not tickers (resolve tickers with sol-token-search or sol-token-lookup). Keyless.",
    tags: ["solana", "price", "token", "spl", "batch"],
    discovery: {
      bodyType: "json",
      input: { mints: [MINTS.SOL, MINTS.JUP, MINTS.USDC] },
      inputSchema: {
        properties: {
          mints: { type: "array", items: { type: "string" }, description: "1-50 base58 mint addresses (array, or a comma-separated string)." },
        },
        required: ["mints"],
      },
      output: {
        example: {
          count: 3, missing: [],
          prices: { [MINTS.SOL]: { priceUsd: 93.7085, priceChange24hPct: 3.93, liquidityUsd: 748142746.9, decimals: 9, blockId: 440919037 }, [MINTS.JUP]: { priceUsd: 0.2035, priceChange24hPct: -2.4, liquidityUsd: 3092234.59, decimals: 6, blockId: 440919030 } },
          source: "jupiter", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      let raw = i.mints;
      if (typeof raw === "string") raw = raw.split(",");
      if (!Array.isArray(raw) || raw.length === 0) throw bad('"mints" is required: 1-50 base58 mint addresses');
      if (raw.length > 50) throw bad(`"mints" must contain at most 50 entries (got ${raw.length})`);
      const mints = [...new Set(raw.map((m) => takeMint(m, "mints[]")))];
      const data = await upstreamJson(`${jupiterBase()}/price/v3?ids=${mints.join(",")}`, { label: "Jupiter", step: "price", timeoutMs: JUPITER_MS });
      const prices = {};
      const missing = [];
      for (const m of mints) {
        const p = data && typeof data === "object" ? data[m] : null;
        if (!p || typeof p !== "object") { missing.push(m); continue; }
        prices[m] = {
          priceUsd: num(p.usdPrice),
          priceChange24hPct: round(p.priceChange24h, 4),
          liquidityUsd: round(p.liquidity, 2),
          decimals: num(p.decimals),
          blockId: num(p.blockId),
        };
      }
      return { count: Object.keys(prices).length, missing, prices, source: "jupiter", fetchedAt: stamp() };
    },
  },

  // =========================================================================
  // sol-swap-quote - Jupiter quote
  // =========================================================================
  {
    route: "POST /api/sol-swap-quote",
    name: "Solana swap quote",
    slug: "sol-swap-quote", aliases: ["solana-swap-quote-jupiter", "solana-swap-quote", "jupiter-quote"],
    category: "crypto",
    price: "$0.003",
    description:
      "Executable swap quote on Solana from a DEX aggregator: input and output mint, amount in base units, slippage in bps - returns out amount, minimum out after slippage, price impact percent, the routed DEX labels in hop order with split percentages, the USD value of the swap and the context slot. A real multi-hop route across Solana DEX liquidity, so the number reflects depth, not a spot price. Quote only - nothing is signed or sent. Keyless.",
    tags: ["solana", "swap", "quote", "dex", "price-impact", "spl"],
    discovery: {
      bodyType: "json",
      input: { inputMint: MINTS.SOL, outputMint: MINTS.USDC, amount: "1000000000", slippageBps: 50 },
      inputSchema: {
        properties: {
          inputMint: { type: "string", description: "Base58 mint you sell." },
          outputMint: { type: "string", description: "Base58 mint you buy." },
          amount: { type: "string", description: "Input amount in base units (integer string; 1 SOL = 1000000000 lamports, 1 USDC = 1000000)." },
          slippageBps: { type: "number", description: "Slippage tolerance in basis points (0-5000, default 50 = 0.5%)." },
        },
        required: ["inputMint", "outputMint", "amount"],
      },
      output: {
        example: {
          inputMint: MINTS.SOL, outputMint: MINTS.USDC, inAmount: "1000000000", outAmount: "93708783", minOutAmount: "93240240",
          slippageBps: 50, priceImpactPct: 0, swapUsdValue: 93.7, swapMode: "ExactIn", hops: 2,
          route: [{ label: "BisonFi", percent: 100, inputMint: MINTS.SOL, outputMint: "Es9v...", inAmount: "1000000000", outAmount: "93720054" }, { label: "SolFi V2", percent: 100, inputMint: "Es9v...", outputMint: MINTS.USDC, inAmount: "93720054", outAmount: "93708783" }],
          contextSlot: 440919041, source: "jupiter", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      const inputMint = takeMint(i.inputMint, "inputMint");
      const outputMint = takeMint(i.outputMint, "outputMint");
      if (inputMint === outputMint) throw bad('"inputMint" and "outputMint" must differ');
      const amountStr = typeof i.amount === "number" ? String(i.amount) : String(i.amount ?? "").trim();
      if (!/^[1-9]\d{0,29}$/.test(amountStr)) throw bad('"amount" must be a positive integer in base units (string or number, e.g. "1000000000" for 1 SOL)');
      let slippageBps = 50;
      if (i.slippageBps != null && i.slippageBps !== "") {
        slippageBps = Number.parseInt(i.slippageBps, 10);
        if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw bad('"slippageBps" must be an integer between 0 and 5000');
      }
      const url = `${jupiterBase()}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountStr}&slippageBps=${slippageBps}`;
      const q = await upstreamJson(url, { label: "Jupiter", step: "swap quote", timeoutMs: JUPITER_MS, notFound: "Jupiter cannot route that swap (token not tradable or no liquidity)" });
      const plan = Array.isArray(q?.routePlan) ? q.routePlan : [];
      return {
        inputMint,
        outputMint,
        inAmount: q?.inAmount != null ? String(q.inAmount) : amountStr,
        outAmount: q?.outAmount != null ? String(q.outAmount) : null,
        minOutAmount: q?.otherAmountThreshold != null ? String(q.otherAmountThreshold) : null,
        slippageBps,
        priceImpactPct: round(q?.priceImpactPct, 6),
        swapUsdValue: round(q?.swapUsdValue, 4),
        swapMode: q?.swapMode ?? null,
        hops: plan.length,
        route: plan.slice(0, 12).map((h) => ({
          label: h?.swapInfo?.label ?? null,
          percent: num(h?.percent),
          inputMint: h?.swapInfo?.inputMint ?? null,
          outputMint: h?.swapInfo?.outputMint ?? null,
          inAmount: h?.swapInfo?.inAmount != null ? String(h.swapInfo.inAmount) : null,
          outAmount: h?.swapInfo?.outAmount != null ? String(h.swapInfo.outAmount) : null,
        })),
        contextSlot: num(q?.contextSlot),
        source: "jupiter",
        fetchedAt: stamp(),
      };
    },
  },

  // =========================================================================
  // sol-token-lookup - Jupiter token search (mint, ticker or name)
  // =========================================================================
  {
    route: "POST /api/sol-token-lookup",
    name: "Solana token lookup",
    slug: "sol-token-lookup", aliases: ["solana-token-lookup-jupiter", "solana-token-lookup"],
    category: "crypto",
    price: "$0.002",
    description:
      "Resolve a Solana token by mint, ticker or name through a Solana DEX aggregator's token index and get its profile in one read: name, symbol, decimals, price, market cap, FDV, liquidity, holder count, circulating and total supply, verified flag, organic score (the aggregator's wash-trade-resistant activity score), tags, launchpad, dev wallet, first pool and date, audit facts (mint and freeze authority disabled, top-holder share, dev mints) and 24h stats (price, holder and liquidity change, buy/sell volume, traders, net buyers). Up to 20 matches for a name search; a mint returns its exact match first. Keyless.",
    tags: ["solana", "token", "lookup", "metadata", "ticker", "spl"],
    discovery: {
      bodyType: "json",
      input: { query: MINTS.JUP, limit: 3 },
      inputSchema: {
        properties: {
          query: { type: "string", description: "Mint address, ticker, or token name (1-80 chars)." },
          limit: { type: "number", description: "Matches to return (1-20, default 5)." },
        },
        required: ["query"],
      },
      output: {
        example: {
          query: MINTS.JUP, count: 1,
          tokens: [{ mint: MINTS.JUP, name: "Jupiter", symbol: "JUP", decimals: 6, priceUsd: 0.2034, marketCapUsd: 675335464.98, fdvUsd: 1395785031.78, liquidityUsd: 3092754.48, holderCount: 835540, circulatingSupply: 3320312968.08, totalSupply: 6862431164.93, isVerified: true, organicScore: 99.31, organicScoreLabel: "high", tags: ["strict", "verified", "defi"], audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPct: 15.28, devBalancePct: null, devMints: 1 }, mintAuthority: null, freezeAuthority: null, launchpad: null, dev: "JUPh...", firstPool: { id: "2psp...", createdAt: "2024-01-29T17:33:29Z" }, stats24h: { priceChangePct: -2.4, holderChangePct: 0.1, liquidityChangePct: -1.2, buyVolumeUsd: 26000000, sellVolumeUsd: 25000000, numBuys: 1696, numSells: 1735, numTraders: 1191, numNetBuyers: 668 }, createdAt: "2025-07-25T13:18:02Z" }],
          source: "jupiter", fetchedAt: "2026-08-22T12:00:00.000Z",
        },
      },
    },
    handler: async (i) => {
      if (typeof i.query !== "string" || !i.query.trim()) throw bad('"query" is required (mint address, ticker, or token name)');
      const query = i.query.trim();
      if (query.length > 80) throw bad('"query" must be 80 characters or fewer');
      const limit = takeLimit(i.limit, 5, 20);
      const list = await upstreamJson(`${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(query)}`, { label: "Jupiter", step: "token search", timeoutMs: JUPITER_MS });
      let rows = (Array.isArray(list) ? list : []).map(shapeJupToken).filter(Boolean);
      // Exact mint match first when the query is an address.
      if (BASE58_RE.test(query)) rows.sort((a, b) => (b.mint === query) - (a.mint === query));
      return { query, count: Math.min(rows.length, limit), tokens: rows.slice(0, limit), source: "jupiter", fetchedAt: stamp() };
    },
  },
];
// Attribution the Jupiter API license requires on any product that serves its
// data ("Powered by Jupiter", SDK & API License Agreement clause 8.4,
// https://developers.jup.ag/docs/legal/sdk-api-license-agreement). The tools
// that read Jupiter end their description with it; the vendor-name check in
// scripts/test-no-third-party-names.js allows it there and nowhere else.
export const JUPITER_ATTRIBUTION = "Powered by Jupiter.";
const JUPITER_SLUGS = new Set(["sol-token-safety", "sol-price", "sol-swap-quote", "sol-token-lookup"]);
for (const t of SOLANA_INTEL_TOOLS) if (JUPITER_SLUGS.has(t.slug)) t.description = `${t.description} ${JUPITER_ATTRIBUTION}`;

// Exported for offline unit tests (pure shaping, no network).
export const __test = { takeMint, takeLimit, shapeHolders, shapeMarkets, shapePair, shapeJupToken, authorityState, riskCounts, BASE58_RE, budgetOf, topAccountsFromRpc,
  DEADLINES: Object.freeze({ HANDLER_BUDGET_MS, RUGCHECK_SUMMARY_MS, RUGCHECK_REPORT_MS, JUPITER_MS, DEXSCREENER_MS, RPC_MS, RPC_FLOOR_MS, FULL_REPORT_FLOOR_MS, RUGCHECK_FALLBACK_MS }), reportReadsInflight: () => reportReads.inflightSize() };

// Free text in these results is written by third parties (headlines, posts,
// casts, token names and descriptions, page titles). Anyone can mint a token or
// publish a post, so this is the cheapest prompt-injection delivery vehicle in
// the catalog: flag it as data, never instructions, the way site-crawl does.
const UNTRUSTED_TEXT_SLUGS = new Set(["sol-trending", "sol-token-search", "sol-token-pairs", "sol-token-lookup", "sol-token-report", "sol-token-safety"]);
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
