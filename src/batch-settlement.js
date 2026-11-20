// x402 `batch-settlement` (payment channels): one deposit, a cumulative
// voucher per call, claimed and settled in batches, the unused remainder
// refunded. Off unless X402_BATCH_SETTLEMENT_NETWORKS names a network.
//
// The protocol is @x402/evm's own (`@x402/evm/batch-settlement/server`): the
// scheme verifies each voucher against the channel record before the handler
// runs, and commits the call's charge in its beforeSettle hook, which
// @x402/core runs AFTER every manual beforeSettle hook (hang-up, blocklist,
// settle-sent mark) and only for an answer below 400. So a failed call, a
// refused settle and a forgiven hang-up leave the channel's charged total
// where it was. The voucher store is ours (Redis, atomic per channel across
// replicas); the claim, settle and idle-refund calls go to the facilitator
// that advertises the scheme, on a timer under a lease.
//
// Offered on a network only when ALL hold (checked once, at boot):
//   1. the operator listed it (X402_BATCH_SETTLEMENT_NETWORKS, CSV of CAIP-2);
//   2. it is in the plain EVM offer;
//   3. a routing facilitator's /supported lists the `batch-settlement` kind
//      there and the scheme accepts that kind (validateFacilitatorSupport:
//      a receiver authorizer the facilitator holds, since this server holds
//      no authorizer key) - a kind the scheme rejects would make @x402/core
//      refuse to initialize EVERY rail, so it is never registered;
//   4. no price floor and no settlement premium (the same rule as upto);
//   5. a durable shared store: Redis, or X402_BATCH_SETTLEMENT_STORE=memory
//      for a single process (tests, a one-container self-host).
import { randomUUID } from "node:crypto";
import { BatchSettlementEvmScheme, InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { RedisChannelStorage } from "@x402/evm/batch-settlement/server/redis-storage";
import { paymentHeaderOf } from "./payer.js";
import { decodePaymentHeader } from "./payment-header.js";

export const BATCH_SCHEME = "batch-settlement";
export const BATCH_WIRE = "x402-batch";
const KEY_PREFIX = "a402-batch";

const CAIP2_ID = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
/** The CAIP-2 ids the switch lists, each once (CSV). An entry that is not a
 *  CAIP-2 id (0, false, off, no, any other text) is not a network and is
 *  dropped here, so unset, empty and such a word all name none, and nothing
 *  downstream carries the variable's raw text. */
export function batchNetworksListed(env = process.env) {
  const raw = String(env.X402_BATCH_SETTLEMENT_NETWORKS ?? "").trim();
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => CAIP2_ID.test(s)))];
}

/** The networks the operator asked for that the plain EVM offer carries. */
export function batchNetworksWanted(env = process.env, evmCaip2 = []) {
  return batchNetworksListed(env).filter((c) => evmCaip2.includes(c));
}

/** True when the switch names a network. */
export function batchSettlementRequested(env = process.env) {
  return batchNetworksListed(env).length > 0;
}

/** "redis" (the default, needs REDIS_URL), "memory" (named only), or null
 *  when no durable store is available (the option is then not offered). */
export function batchStoreMode(env = process.env) {
  const named = String(env.X402_BATCH_SETTLEMENT_STORE || "").trim().toLowerCase();
  if (named === "memory") return "memory";
  if (named && named !== "redis") return null;
  return String(env.REDIS_URL || "").trim() ? "redis" : null;
}

const posInt = (v, dflt, min = 1) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : dflt;
};
export function batchIntervals(env = process.env) {
  return {
    claimSecs: posInt(env.X402_BATCH_CLAIM_INTERVAL_SECONDS, 300, 5),
    refundSecs: posInt(env.X402_BATCH_REFUND_INTERVAL_SECONDS, 900, 5),
    idleRefundSecs: posInt(env.X402_BATCH_IDLE_REFUND_SECONDS, 86_400, 5),
  };
}

/** The `batch-settlement` kind a /supported answer lists for `caip2`, or null. */
export function batchKindOf(supported, caip2) {
  for (const k of supported?.kinds || []) {
    if (String(k?.scheme || "").toLowerCase() === BATCH_SCHEME && String(k?.network || "") === caip2) return k;
  }
  return null;
}

/** The voucher store and the per-channel admission lock. */
export async function makeBatchStores(mode, { redisClient = null } = {}) {
  if (mode === "memory") {
    const mem = new InMemoryChannelStorage();
    return { storage: mem, lockStorage: mem, mode };
  }
  if (mode === "redis") {
    const client = redisClient || await (await import("./shared-limit.js")).getSharedRedisClient();
    if (!client) return null;
    const redisStore = new RedisChannelStorage({ client, keyPrefix: KEY_PREFIX });
    return {
      storage: redisStore,
      lockStorage: redisStore,
      mode,
    };
  }
  return null;
}

/**
 * Decide the networks, at boot. `reads` is facilitatorClients' /supported
 * answers in routing order (null for one that could not be read); the first
 * client listing the kind on a network is the one @x402/core routes it to,
 * and the one the channel manager claims through. `makeScheme(caip2)` builds
 * the scheme as it will be registered; `canPrice(scheme, caip2)` proves the
 * money parser. Returns { networks: [{ caip2, client, kind, scheme }], refused: [{ caip2, why }] }.
 */
export async function selectBatchNetworks({ wanted, clients, reads, floored = () => false, premium = () => 0, makeScheme, canPrice }) {
  const networks = [];
  const refused = [];
  for (const caip2 of wanted) {
    if (floored(caip2)) { refused.push({ caip2, word: "floor", why: "carries a price floor" }); continue; }
    if (premium(caip2) > 0) { refused.push({ caip2, word: "premium", why: "carries a settlement premium" }); continue; }
    let idx = -1, kind = null;
    for (let i = 0; i < reads.length; i++) { const k = batchKindOf(reads[i], caip2); if (k) { idx = i; kind = k; break; } }
    if (!kind) { refused.push({ caip2, word: "not-advertised", why: "no facilitator we route through lists the batch-settlement kind" }); continue; }
    const scheme = makeScheme(caip2);
    let problem = null;
    try { problem = scheme.validateFacilitatorSupport(caip2, kind, reads[idx]?.extensions || []) || null; } catch (e) { problem = String(e?.message || e); }
    if (problem) { refused.push({ caip2, word: "kind-refused", why: String(problem).slice(0, 200) }); continue; }
    try { await canPrice(scheme, caip2); } catch (e) { refused.push({ caip2, word: "price", why: `cannot price it (${String(e?.message || e).slice(0, 120)})` }); continue; }
    networks.push({ caip2, client: clients[idx], kind, scheme });
  }
  return { networks, refused };
}

/** A new scheme for one network over the shared stores. */
export function newBatchScheme(payTo, stores) {
  return new BatchSettlementEvmScheme(payTo, { storage: stores.storage, lockStorage: stores.lockStorage });
}

/** May this route offer a batch-settlement accept? Never an identity-bound
 *  route (its caller is the EIP-3009 `from`), a route whose effect outlives
 *  the answer, or a long-running report: the same routes the Gateway batched
 *  option and upto stay off. */
export function batchAcceptEligible(item, { hasLastingEffect, evmOnly }) {
  if (!item || item.identityBound) return false;
  if (hasLastingEffect(item)) return false;
  if (evmOnly(item)) return false;
  return true;
}

/** True when this request's payment names the batch-settlement scheme. */
export function isBatchSettlementRequest(req) {
  const header = paymentHeaderOf(req);
  if (!header) return false;
  try {
    const p = decodePaymentHeader(header);
    return String(p?.accepted?.scheme ?? p?.scheme ?? "").toLowerCase() === BATCH_SCHEME;
  } catch { return false; }
}

/** The channel id a batch payment names (null otherwise). */
export function batchChannelIdOf(req) {
  const header = paymentHeaderOf(req);
  if (!header) return null;
  try {
    const p = decodePaymentHeader(header);
    if (String(p?.accepted?.scheme ?? "").toLowerCase() !== BATCH_SCHEME) return null;
    const id = p?.payload?.voucher?.channelId;
    return typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id) ? id.toLowerCase() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// The live offer, for /api/rails and the copy that reads the switch.
let offer = { requested: false, networks: [], refused: [], store: null, stores: null };
export function setBatchOffer(o) { offer = { ...offer, ...o }; }
export function batchSettlementOffered() { return offer.networks.length > 0; }
export function batchOfferedNetworks() { return [...offer.networks]; }
/** /api/rails field: present only while the switch names a network. Our
 *  own words and times only, never a facilitator's text: `claims` reads
 *  failing while the last claim, settle or refund pass failed. */
export function batchSettlementStatus() {
  if (!offer.requested) return null;
  return {
    status: offer.networks.length ? (offer.refused.length ? "partial" : "offered") : "dropped",
    networks: [...offer.networks],
    dropped: offer.refused.map((r) => ({ network: r.caip2, reason: r.word || "config" })),
    store: offer.store,
    claims: managerState.lastError ? "failing" : "ok",
    lastClaimAt: managerState.lastClaimAt, lastSettleAt: managerState.lastSettleAt, lastRefundAt: managerState.lastRefundAt,
  };
}

// ---------------------------------------------------------------------------
// Claim, settle and idle refund, per network, on timers under a lease.
const managerState = { lastClaimAt: null, lastSettleAt: null, lastRefundAt: null, lastError: null };
const timers = [];

/**
 * One pass for one network: claim every charged voucher, refund the
 * remainder of channels idle past the window (a refund claims that channel's
 * charge first), then settle what is claimed to payTo. Each step's failure is
 * logged and leaves the store as it was (the manager marks a voucher claimed
 * only after the facilitator's success). A claim whose settle failed is
 * settled on a later pass (`pendingSettle`, per manager).
 */
export async function runBatchPass(manager, { idleRefundSecs, doClaim = true, doRefund = true, log = console.warn, now = () => Date.now() } = {}) {
  const out = { claims: [], settle: null, refunds: [] };
  if (doClaim) {
    try {
      out.claims = await manager.claim();
      if (out.claims.length) { managerState.lastClaimAt = new Date(now()).toISOString(); pendingSettle.add(manager); }
    } catch (e) { out.failed = true; managerState.lastError = `claim: ${String(e?.message || e).slice(0, 160)}`; log(`[batch] claim failed: ${managerState.lastError}`); }
  }
  if (doRefund && Number.isFinite(idleRefundSecs)) {
    try {
      out.refunds = await manager.refundIdleChannels({ idleSecs: idleRefundSecs });
      if (out.refunds.length) { managerState.lastRefundAt = new Date(now()).toISOString(); pendingSettle.add(manager); }
    } catch (e) { out.failed = true; managerState.lastError = `refund: ${String(e?.message || e).slice(0, 160)}`; log(`[batch] refund failed: ${managerState.lastError}`); }
  }
  if (!out.failed) managerState.lastError = null;
  if (pendingSettle.has(manager)) {
    try {
      out.settle = await manager.settle();
      pendingSettle.delete(manager);
      managerState.lastSettleAt = new Date(now()).toISOString();
    } catch (e) { managerState.lastError = `settle: ${String(e?.message || e).slice(0, 160)}`; log(`[batch] settle failed: ${managerState.lastError}`); }
  }
  return out;
}
const pendingSettle = new WeakSet();

/** Start the per-network timers. `withLease(name, opts, fn)` keeps one
 *  replica on each pass (state-db's lease, or the in-process guard). */
export function startBatchManagers({ networks, payTo, intervals, withLease, log = console.log }) {
  const managers = networks.map((n) => ({ caip2: n.caip2, manager: n.scheme.createChannelManager(n.client, n.caip2) }));
  const tick = (kind) => async () => {
    for (const { caip2, manager } of managers) {
      try {
        await withLease(`x402-batch:${kind}:${caip2}`, { ttlMs: 120_000 }, () => runBatchPass(manager, {
          idleRefundSecs: intervals.idleRefundSecs,
          doClaim: kind === "claim", doRefund: kind === "refund",
        }));
      } catch (e) { managerState.lastError = String(e?.message || e).slice(0, 160); }
    }
  };
  const claimTimer = setInterval(tick("claim"), intervals.claimSecs * 1000);
  const refundTimer = setInterval(tick("refund"), intervals.refundSecs * 1000);
  claimTimer.unref?.(); refundTimer.unref?.();
  timers.push(claimTimer, refundTimer);
  log(`x402 batch-settlement: channel claims every ${intervals.claimSecs} s, idle refunds after ${intervals.idleRefundSecs} s, on ${networks.map((n) => n.caip2).join(", ")} (payTo ${String(payTo).slice(0, 6)}...)`);
  return managers;
}

/** Stop the timers and, with `flush`, claim and settle what is charged. */
export async function stopBatchManagers(managers = [], { flush = false } = {}) {
  while (timers.length) clearInterval(timers.pop());
  if (!flush) return;
  for (const { manager } of managers) { try { await runBatchPass(manager, { doRefund: false }); } catch { /* best effort */ } }
}

/**
 * Give a committed call's charge back to its channel (a hang-up after the
 * charge was committed). Lowers the channel's charged total by `amount`
 * atomic units when that stays at or above what was already claimed on
 * chain; the buyer's next voucher is then signed against the lower base (the
 * corrective 402 carries it). Returns "credited", or why it was not.
 */
export async function creditBatchChannel(storage, channelId, amountAtomic) {
  if (!storage || !channelId) return "no-channel";
  let amt;
  try { amt = BigInt(amountAtomic); } catch { return "bad-amount"; }
  if (amt <= 0n) return "bad-amount";
  let outcome = "no-channel";
  const r = await storage.updateChannel(channelId, (cur) => {
    if (!cur) { outcome = "no-channel"; return cur; }
    const charged = BigInt(cur.chargedCumulativeAmount);
    const claimed = BigInt(cur.totalClaimed);
    if (charged - amt < claimed) { outcome = "already-claimed"; return cur; }
    outcome = "credited";
    return { ...cur, chargedCumulativeAmount: (charged - amt).toString() };
  });
  if (outcome === "credited" && r.status !== "updated") return "conflict";
  return outcome;
}

/**
 * Give a hung-up call's committed charge back to its channel. `receipt` is
 * the decoded settle answer (its `extra.chargedAmount` is what this call
 * added). Returns "credited", or why not. Reached from a hang-up only
 * through hungUpBatchCall, which decides whether the charge may be given back.
 */
export async function creditHungUpBatchCall(req, receipt) {
  const id = batchChannelIdOf(req);
  const amount = receipt?.extra?.chargedAmount;
  if (!id || typeof amount !== "string" || !/^\d+$/.test(amount)) return "unreadable";
  try { return await creditBatchChannel(offer.stores?.storage, id, amount); } catch { return "store-failed"; }
}

// The decision for each hung-up request, kept off the request object.
const hungUpDecided = new WeakMap();

/**
 * A buyer who left after its channel call's charge was committed. The charge
 * goes back to the channel only where every other rail would not have taken
 * it: the request holds a GRANTED forgiveness ticket (src/hangup-forgiveness.js;
 * with one, the settle hook withholds the charge, so a committed charge means
 * the close landed inside the settle call), the buyer left before the first
 * byte (`reason` null: not a connector that stopped waiting for an answer
 * written in full and stored), and the route's effect does not outlive the
 * answer. Anything else (a ticket denied on a budget or for a lasting
 * effect, or none at all) keeps the charge on the buyer: the answer is
 * `{ row }`, the caller books it as owed exactly as every other rail books an
 * undelivered charge, and the channel is not touched. A credit that lands
 * calls `onCredited()`; one the channel cannot take (already claimed on
 * chain) is handed to `onCreditRefused(row, how)` to be booked as owed. One
 * decision per request: a second call answers the first one again, under
 * the same evidence, and credits nothing. `row` is the owed row's fields;
 * its evidence is unique to the request.
 */
export function hungUpBatchCall(req, receipt, { forgiven = false, lastingEffect = false, reason = null, row = {}, onCredited = () => {}, onCreditRefused = () => {} } = {}) {
  const keyed = req !== null && typeof req === "object";
  const prior = keyed ? hungUpDecided.get(req) : undefined;
  if (prior) return prior;
  const owed = { ...row, tx: `batch-hangup:${randomUUID()}`, wire: BATCH_WIRE };
  const credit = forgiven === true && lastingEffect !== true && !reason;
  let answer;
  if (credit) {
    const credited = creditHungUpBatchCall(req, receipt).catch(() => "store-failed").then((how) => {
      try { if (how === "credited") onCredited(); else onCreditRefused(owed, how); } catch { /* booking only */ }
      return how;
    });
    answer = { credited: true, outcome: credited };
  } else {
    answer = { row: owed };
  }
  if (keyed) hungUpDecided.set(req, answer);
  return answer;
}

/** The public description of the channel offer while it is on (null off):
 *  /api/pricing's `payment.paymentChannels` and the llms.txt line read it, so
 *  no surface offers channels the 402 does not carry. */
export function batchOfferPublic(env = process.env) {
  if (!offer.networks.length) return null;
  return {
    scheme: BATCH_SCHEME,
    networks: [...offer.networks],
    idleRefundSeconds: batchIntervals(env).idleRefundSecs,
    perCall: "a cumulative voucher; no transaction per call",
    charged: "only on a final 200",
  };
}
