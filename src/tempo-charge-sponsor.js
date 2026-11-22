// Tempo gas sponsorship for per-call tempo/charge payments.
//
// OFF unless TEMPO_GAS_SPONSORSHIP=on. While on, a tempo/charge challenge can
// ask the buyer for a fee-sponsored transaction (mppx `feePayer: true` in the
// challenge's methodDetails): the buyer signs the transfer, this server
// co-signs as fee payer with the subscription gas sponsor's key
// (TEMPO_SUBSCRIPTION_FEE_PAYER_KEY, fees in PathUSD) and broadcasts it
// itself over TEMPO_RPC_URL. A buyer then needs no gas of its own.
//
// The decision is made when the challenge is MINTED, never at settlement: a
// credential signed for a sponsored challenge cannot settle unsponsored, so
// once a challenge has offered sponsorship this server pays that fee. Every
// limit below therefore only decides whether the NEXT challenge is sponsored;
// a buyer past a limit is offered the ordinary challenge and pays its own fee,
// exactly as without the switch. Nothing here refuses a buyer for a limit.
//
// A challenge is sponsored only while every one of these holds:
//   - the switch is on and the sponsor key parses;
//   - outbound signing is not halted (src/signing-halt.js);
//   - the payment-party screen has a list loaded: this server settles a
//     sponsored transaction itself, so it screens it as direct mode does
//     (src/sanctions-screen.js), and without a list it would refuse it;
//   - the sponsor's PathUSD balance, read in the background, is at or above
//     TEMPO_GAS_SPONSOR_RESERVE_USD (default 2). That floor is held for the
//     subscription rail: subscription activations and renewals keep the
//     wallet's first dollars, and charge sponsorship stops before it can
//     spend them. An unread balance counts as under the floor.
//   - the subscription sponsor ceiling (src/tempo-sponsor-ceiling.js) does
//     not read "reached": while subscriptions are held at their own ceiling,
//     charges do not spend the wallet either;
//   - the rolling 24 h sum of sponsored fees is under
//     TEMPO_GAS_SPONSOR_DAILY_MAX_USD (default 5), all payers together;
//   - the client (ip and User-Agent, as src/mpp-fallback.js keys it) is not
//     tied to a payer whose own 24 h sum reached
//     TEMPO_GAS_SPONSOR_PAYER_DAILY_MAX_USD (default 1), and has not sent a
//     sponsored pull from a sender the gate cannot prove.
//
// Each settled sponsored send is booked by its fee bound (gas limit x
// maxFeePerGas, the most it can cost the sponsor) into the shared 24 h
// windows (src/shared-limits.js) and a short in-memory list for the operator
// view (/__operator/tempo-gas-sponsorship.json). One transaction's fee is
// bounded by mppx's fee-payer policy (TEMPO_GAS_SPONSOR_MAX_FEE_USD, default
// 0.01). A challenge minted while under a limit may still settle after it is
// reached, so a window can pass its cap by the sponsored sales of one
// challenge lifetime; it never passes the per-transaction bound per sale.
import { AsyncLocalStorage } from "node:async_hooks";
import { privateKeyToAccount } from "viem/accounts";
import { Transaction } from "viem/tempo";
import { shared, sharedLimitsEnabled, createMemoryLimits, noteSharedLimitsDegraded } from "./shared-limits.js";
import { sponsoredFeeBound, sponsorCeilingWord } from "./tempo-sponsor-ceiling.js";
import { signingHalted } from "./signing-halt.js";
import { sanctionsScreenStatus } from "./sanctions-screen.js";
import { clientFingerprint } from "./mpp-fallback.js";

export const PATH_USD_ADDRESS = "0x20c0000000000000000000000000000000000000";
export const SPONSOR_WINDOW_MS = 24 * 3_600_000;
export const TEMPO_GAS_SPONSOR_DEFAULTS = Object.freeze({ payerDailyMaxUsd: 1, dailyMaxUsd: 5, reserveUsd: 2, maxFeeUsd: 0.01 });
/** How often the background read of the sponsor's balance and windows runs. */
export const SPONSOR_REFRESH_MS = 60_000;
/** A state older than this is not trusted at mint time (the refresh stalled). */
export const SPONSOR_STATE_MAX_AGE_MS = 5 * 60_000;
const NAME = "tempo-charge-sponsor";
const ALL = "all";
const CONTROL = "tempo-charge-sponsor";
const CLIENT_MAX = 5000;
const RECENT_MAX = 50;
const TXID_MAX = 5000;
const TXID_TTL_MS = 30 * 60_000;
// Tempo prices gas in attodollars (1e-18 USD).
const ATTO_PER_USD = 10n ** 18n;

const positive = (raw, dflt) => {
  const s = String(raw ?? "").trim();
  const v = Number(s);
  return s && Number.isFinite(v) && v > 0 ? v : dflt;
};
/** Call-time settings. A malformed or non-positive value reads as the default. */
export function tempoGasSponsorConfig(env = process.env) {
  return {
    enabled: String(env.TEMPO_GAS_SPONSORSHIP ?? "").trim().toLowerCase() === "on",
    payerDailyMaxUsd: positive(env.TEMPO_GAS_SPONSOR_PAYER_DAILY_MAX_USD, TEMPO_GAS_SPONSOR_DEFAULTS.payerDailyMaxUsd),
    dailyMaxUsd: positive(env.TEMPO_GAS_SPONSOR_DAILY_MAX_USD, TEMPO_GAS_SPONSOR_DEFAULTS.dailyMaxUsd),
    reserveUsd: positive(env.TEMPO_GAS_SPONSOR_RESERVE_USD, TEMPO_GAS_SPONSOR_DEFAULTS.reserveUsd),
    maxFeeUsd: Math.min(1, positive(env.TEMPO_GAS_SPONSOR_MAX_FEE_USD, TEMPO_GAS_SPONSOR_DEFAULTS.maxFeeUsd)),
  };
}
/** The sponsor account (the subscription gas sponsor's key), or null. */
export function chargeSponsorAccount(env = process.env) {
  const raw = String(env.TEMPO_SUBSCRIPTION_FEE_PAYER_KEY || "").trim();
  if (!raw) return null;
  try { return privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`); } catch { return null; }
}
/** mppx's fee-payer policy for one sponsored transaction: its fee bound in attodollars, and a gas ceiling. */
export function chargeSponsorPolicy(env = process.env, maxGas = 6_000_000n) {
  const micro = BigInt(Math.round(tempoGasSponsorConfig(env).maxFeeUsd * 1e6));
  return { maxGas, maxTotalFee: (micro * ATTO_PER_USD) / 1_000_000n };
}
/** Is the credential's challenge a sponsored one (methodDetails.feePayer true)? HMAC binding is the gate's. */
export function isSponsoredChallengeRequest(request) {
  return request?.methodDetails?.feePayer === true;
}

// ---- the background state the mint reads synchronously --------------------
const state = { at: 0, balanceUsd: null, globalMicro: 0, subCeiling: "unknown", reading: null };
const payerMicro = new Map(); // payer -> { micro, at }
const clientPayer = new Map(); // client fingerprint -> payer (last sponsored sale)
const withheld = new Map(); // client fingerprint -> until (unproven sender)
const recent = []; // newest last: { at, payer, feeBoundUsd, tx }
const txids = new Map(); // challenge id -> { hash, at }
const counts = { offered: 0, declined: 0, booked: 0, unproven: 0, bookFailures: 0 };
const declinedBy = {};
let timer = null;
let local = createMemoryLimits();

async function readBalanceUsd(address, env = process.env) {
  const rpcUrl = String(env.TEMPO_RPC_URL || "https://rpc.tempo.xyz").trim();
  const data = "0x70a08231" + address.toLowerCase().slice(2).padStart(64, "0");
  try {
    // TEMPO_RPC_URL, an operator setting.
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PATH_USD_ADDRESS, data }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const hex = (await res.json())?.result;
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
    return Number(BigInt(hex === "0x" ? "0x0" : hex)) / 1e6;
  } catch { return null; }
}
async function readWindow(key, now) {
  let r = await shared.windowRead(NAME, key, { windowMs: SPONSOR_WINDOW_MS, now });
  if (!r?.ok) r = await local.windowRead(NAME, key, { windowMs: SPONSOR_WINDOW_MS, now });
  return r?.ok ? Number(r.sum) || 0 : null;
}

/** One background read: the sponsor's balance, the 24 h fee window and the subscription ceiling word. */
export async function refreshChargeSponsorState({ now = Date.now(), env = process.env } = {}) {
  const acct = chargeSponsorAccount(env);
  if (!acct) { state.at = now; state.balanceUsd = null; return { ...state }; }
  const [balanceUsd, globalMicro, subCeiling] = await Promise.all([
    readBalanceUsd(acct.address, env),
    readWindow(ALL, now).catch(() => null),
    sponsorCeilingWord({ now, env }).catch(() => "unknown"),
  ]);
  state.balanceUsd = balanceUsd;
  if (globalMicro !== null) state.globalMicro = globalMicro;
  state.subCeiling = subCeiling;
  state.at = now;
  return { ...state };
}
function kickRefresh() {
  if (state.reading) return;
  state.reading = refreshChargeSponsorState().catch(() => null).finally(() => { state.reading = null; });
}
function ensureTimer() {
  if (timer) return;
  kickRefresh();
  timer = setInterval(() => { if (tempoGasSponsorConfig().enabled) kickRefresh(); }, SPONSOR_REFRESH_MS);
  timer.unref?.();
}

/** Why a sponsored challenge is not offered right now (the service-wide half), or null when it can be. */
export function chargeSponsorshipPause({ now = Date.now(), env = process.env } = {}) {
  const cfg = tempoGasSponsorConfig(env);
  if (!cfg.enabled) return "off";
  if (!chargeSponsorAccount(env)) return "no-key";
  ensureTimer();
  if (signingHalted()) return "signing-halted";
  if (sanctionsScreenStatus(now) === "missing") return "screen-unavailable";
  if (!state.at || now - state.at > SPONSOR_STATE_MAX_AGE_MS) { kickRefresh(); return "state-unread"; }
  if (state.balanceUsd === null) return "balance-unread";
  if (state.balanceUsd < cfg.reserveUsd) return "reserve";
  if (state.subCeiling === "reached") return "subscription-ceiling";
  if (state.globalMicro >= Math.round(cfg.dailyMaxUsd * 1e6)) return "daily-cap";
  return null;
}
/** The client half: why this request's client is not offered sponsorship, or null. */
function clientPause(req, cfg, now) {
  const fp = clientFingerprint(req);
  if (!fp) return null;
  const until = withheld.get(fp);
  if (until && until > now) return "unproven-sender";
  if (until) withheld.delete(fp);
  const payer = clientPayer.get(fp);
  const p = payer ? payerMicro.get(payer) : null;
  if (p && now - p.at < SPONSOR_WINDOW_MS && p.micro >= Math.round(cfg.payerDailyMaxUsd * 1e6)) return "payer-cap";
  return null;
}
/**
 * Should the challenge minted for this request be sponsored? Synchronous: it
 * reads only the state the background refresh keeps. Counts its answer.
 */
export function sponsorChargeFor(req, { now = Date.now(), env = process.env } = {}) {
  const cfg = tempoGasSponsorConfig(env);
  if (!cfg.enabled) return false;
  const why = chargeSponsorshipPause({ now, env }) || clientPause(req, cfg, now);
  if (why) { counts.declined++; declinedBy[why] = (declinedBy[why] || 0) + 1; return false; }
  counts.offered++;
  return true;
}

// ---- request context: the client a sponsored send is booked against --------
const context = new AsyncLocalStorage();
/** Run the rest of a request with its client fingerprint in reach of the booking (mpp-tempo's appender). */
export function runWithSponsorContext(req, fn) {
  return context.run({ fingerprint: clientFingerprint(req) }, fn);
}
/** Run a sponsored broadcast with its challenge id in reach of the booking. */
export function runSponsoredBroadcast(challengeId, fn) {
  const outer = context.getStore() || {};
  return context.run({ ...outer, challengeId: challengeId || null }, fn);
}
function bound(map, max) { while (map.size > max) map.delete(map.keys().next().value); }
/** The client of the current request sent a sponsored pull the gate cannot prove: its next challenges are not sponsored for a day. */
export function withholdSponsorshipForCurrentClient({ now = Date.now() } = {}) {
  counts.unproven++;
  const fp = context.getStore()?.fingerprint;
  if (!fp) return false;
  withheld.delete(fp);
  withheld.set(fp, now + SPONSOR_WINDOW_MS);
  bound(withheld, CLIENT_MAX);
  return true;
}

async function addTo(key, member, weight, now) {
  const args = { windowMs: SPONSOR_WINDOW_MS, member, weight, now };
  if (sharedLimitsEnabled()) {
    const mine = local.windowAdd(NAME, key, args);
    const r = await shared.windowAdd(NAME, key, args);
    if (r?.ok) return r;
    noteSharedLimitsDegraded(CONTROL, r);
    return mine;
  }
  return shared.windowAdd(NAME, key, args);
}
/**
 * Book one sponsored raw transaction about to be sent: its fee bound into the
 * service-wide and the payer's 24 h windows, the client's payer, the
 * challenge's final transaction id (the chain-truth confirm reads it), and
 * the operator list. Never throws and never refuses: the send goes ahead.
 */
export async function bookSponsoredSend(serialized, { now = Date.now() } = {}) {
  try {
    const b = sponsoredFeeBound(serialized);
    if (!b || !b.sponsored) return null;
    let payer = null;
    try { payer = String(Transaction.deserialize(serialized)?.from || "").toLowerCase() || null; } catch { payer = null; }
    const ctx = context.getStore() || {};
    if (ctx.challengeId) {
      txids.delete(ctx.challengeId);
      txids.set(ctx.challengeId, { hash: b.hash, at: now });
      bound(txids, TXID_MAX);
    }
    const all = await addTo(ALL, b.hash, b.feeMicroUsd, now);
    if (all?.ok) state.globalMicro = Math.max(state.globalMicro, Number(all.sum) || 0);
    if (payer) {
      const mine = await addTo(`payer:${payer}`, b.hash, b.feeMicroUsd, now);
      payerMicro.delete(payer);
      payerMicro.set(payer, { micro: mine?.ok ? Number(mine.sum) || 0 : b.feeMicroUsd, at: now });
      bound(payerMicro, CLIENT_MAX);
      if (ctx.fingerprint) { clientPayer.delete(ctx.fingerprint); clientPayer.set(ctx.fingerprint, payer); bound(clientPayer, CLIENT_MAX); }
    }
    counts.booked++;
    recent.push({ at: new Date(now).toISOString(), payer, feeBoundUsd: b.feeMicroUsd / 1e6, tx: b.hash });
    if (recent.length > RECENT_MAX) recent.shift();
    return { payer, feeMicroUsd: b.feeMicroUsd, hash: b.hash };
  } catch {
    counts.bookFailures++;
    return null;
  }
}
const SEND_METHODS = new Set(["eth_sendRawTransaction", "eth_sendRawTransactionSync"]);
/** Wrap a viem transport so every raw send is booked first (never refused). */
export function withSponsorBooking(transport) {
  return (config) => {
    const t = transport(config);
    const request = async (args, options) => {
      if (args && SEND_METHODS.has(args.method)) await bookSponsoredSend(args.params?.[0]);
      return t.request(args, options);
    };
    return { ...t, request };
  };
}
/** The co-signed transaction id a sponsored challenge was sent under, if this process sent it. */
export function sponsoredTxIdFor(challengeId, { now = Date.now() } = {}) {
  const hit = challengeId ? txids.get(challengeId) : null;
  if (!hit) return null;
  if (now - hit.at > TXID_TTL_MS) { txids.delete(challengeId); return null; }
  return hit.hash;
}

/** One word for /api/gateway-status: off, on, or paused (sponsorship stopped by a limit; buyers pay their own fee). */
export function chargeSponsorshipWord({ now = Date.now(), env = process.env } = {}) {
  const why = chargeSponsorshipPause({ now, env });
  if (why === "off") return "off";
  return why ? "paused" : "on";
}
/** The reserve floor the low-balance word reads while sponsorship is on, else null. */
export function chargeSponsorReserveUsd(env = process.env) {
  const cfg = tempoGasSponsorConfig(env);
  return cfg.enabled ? cfg.reserveUsd : null;
}

/** Operator view: settings, why it is paused, the 24 h sum, counts and the latest bookings (fee bounds; payer addresses shortened). */
export async function tempoGasSponsorshipReport({ now = Date.now(), env = process.env } = {}) {
  const cfg = tempoGasSponsorConfig(env);
  const acct = chargeSponsorAccount(env);
  const globalMicro = acct ? await readWindow(ALL, now).catch(() => null) : null;
  const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : null);
  return {
    ...cfg,
    sponsor: acct ? short(acct.address.toLowerCase()) : null,
    word: chargeSponsorshipWord({ now, env }),
    pausedBecause: chargeSponsorshipPause({ now, env }),
    balanceBucket: state.balanceUsd === null ? "unread" : state.balanceUsd < cfg.reserveUsd ? "under-reserve" : "above-reserve",
    stateReadAt: state.at ? new Date(state.at).toISOString() : null,
    subscriptionCeiling: state.subCeiling,
    sponsoredFeeBoundUsd24h: globalMicro === null ? null : globalMicro / 1e6,
    counts: { ...counts, declinedBy: { ...declinedBy } },
    payersTracked: payerMicro.size,
    clientsWithheld: withheld.size,
    recent: recent.slice(-20).map((r) => ({ ...r, payer: short(r.payer) })),
  };
}

/** Test seam: forget everything, and seed the background state. */
export async function _resetChargeSponsor(seed = null) {
  payerMicro.clear(); clientPayer.clear(); withheld.clear(); txids.clear(); recent.length = 0;
  for (const k of Object.keys(counts)) counts[k] = 0;
  for (const k of Object.keys(declinedBy)) delete declinedBy[k];
  local = createMemoryLimits();
  await shared.windowClear(NAME, ALL);
  Object.assign(state, { at: 0, balanceUsd: null, globalMicro: 0, subCeiling: "unknown", reading: null }, seed || {});
  if (timer) { clearInterval(timer); timer = null; }
}
/** Test seam: clear one payer's shared window. */
export async function _clearPayerWindow(payer) { await shared.windowClear(NAME, `payer:${String(payer).toLowerCase()}`); }
