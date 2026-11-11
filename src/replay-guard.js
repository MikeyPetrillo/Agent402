/**
 * Payment-nonce replay guard (M3) — defense-in-depth against Attack II
 * ("replay / insufficient idempotency") from the "Five Attacks on x402
 * Agentic Payment Protocol" analysis.
 *
 * Agent402 already settles-before-grant: the paywall buffers the handler's
 * bytes, settles the payment on-chain, and flushes the response ONLY on settle
 * success. Because an EIP-3009 `transferWithAuthorization` nonce is single-use
 * on-chain, a replayed authorization fails at the facilitator, so the
 * duplicate-grant rate is already 1. This guard is a strictly-earlier, cheaper
 * layer: it rejects a duplicate authorization BEFORE it ever reaches the
 * facilitator, and — crucially — closes the concurrent-replay window the paper
 * exploits (the same authorization fired N times at once, racing the settle) by
 * refusing every duplicate while the first is still in flight.
 *
 * Release-on-failure: the nonce is only marked consumed when the gated call is
 * actually granted (a 200 — which, under settle-before-grant, means the payment
 * settled). If the call is NOT granted (the facilitator rejected settlement, the
 * handler threw, the client aborted), the nonce is released so a legitimate
 * retry of the still-valid authorization can succeed. It never blocks a payer
 * from re-using an authorization the chain hasn't consumed.
 *
 * CROSS-REPLICA (2026-08-16): prod runs multiple replicas (RATE_LIMIT_REPLICAS),
 * and the guard below was per-process only - a concurrent replay landing on
 * TWO DIFFERENT replicas within the same request window was invisible to it
 * (each replica's inFlight Set only sees its own traffic). The chain's own
 * nonce single-use property still prevented a double-CHARGE, but the HANDLER
 * ran twice - for a tool that makes a real paid upstream call, that is a real
 * cost duplication bounded only by how fast an attacker can fire one
 * authorization at two replicas.
 *
 * Now backed by the SAME Redis connection shared-limit.js already maintains
 * (via getSharedRedisClient - one connection per process, not a second one to
 * the same server) when REDIS_URL is configured and reachable. With no shared
 * store configured (one process) the per-process Map/Set is the guarantee. A
 * caller that passes `requireShared` gets "unavailable" whenever a shared
 * store is configured but cannot be reached, and refuses the call before any
 * payment is taken. The x402 dispatcher in server.js, the Tempo gate and the
 * card gate each pass sharedClaimRequired() (src/replay-topology.js): the
 * shared claim is required on a long-running or composite route always, and
 * on every route while another container may be serving (more than one
 * replica, a deploy's overlap window, a drain), because a per-process claim
 * on two containers lets one signed payment run the handler on each and
 * reach the facilitator twice, where only later layers (the chain's nonce,
 * the settlement claims, the sales ledger) keep the second from being served.
 * A lone container past its overlap window serves a fast route on the
 * per-process claim, so a store outage does not stop sales there. A caller
 * that does not pass it falls back to the per-process claim on a Redis
 * failure.
 */
import { createHash, randomUUID } from "node:crypto";
import algosdk from "algosdk";
import { getTransactionDecoder } from "@solana/kit";
import { paymentHeaderOf } from "./payer.js";
import { getSharedRedisClient, sharedLimitEnabled } from "./shared-limit.js";
import { decodePaymentHeader, isEvmNetworkName, canonicalNonce } from "./payment-header.js";
import { stellarAuthorizationsOf } from "./stellar-confirm.js";
import { base64BytesOf } from "./base64-bytes.js";

// The claim's lifetime in Redis without a renewal. A claim is renewed every
// INFLIGHT_RENEW_MS while its call is open (the slow routes run for minutes),
// so a healthy call keeps it until settle()/release(), and a replica that
// dies mid-request without releasing stops renewing and its claim lapses
// within this.
const INFLIGHT_TTL_SECONDS = 120;
export const INFLIGHT_RENEW_MS = 30_000;
// Renewal stops after this long, so a caller that never settles or releases
// cannot hold a nonce (or a timer) forever. Far past any run budget.
const MAX_HOLD_MS = 30 * 60_000;
const REDIS_PREFIX = "replay:";

/**
 * Stable replay identity for the x402 payment credential on this request, or
 * null when there is nothing to guard (no payment header — a proof-of-work
 * call or an unpaid discovery crawl).
 *
 * Prefers the EIP-3009 nonce scoped to its network and its signed payer: the
 * chain consumes a nonce per (token, from), so two wallets that sign the same
 * nonce are two payments, and so are two networks. A re-encoded-but-equivalent
 * authorization still maps to one identity. The network is read where each
 * wire carries it (v2 on `accepted`, v1 at the top level); an EVM payer is
 * lowercased, any other spelling is kept as signed. A payment whose nonce we
 * can't parse keys on the transaction the chain consumes (chainTxIdentityOf):
 * "t2:<identity>:<legacy>", <legacy> the raw-credential hash an earlier build
 * keyed the same header on (honored as for "n2:"). A transaction field that is
 * present but not decoded keys on its decoded bytes, under "t2:" too. A
 * payload with no transaction field keys on its signed payload ("p2:", same
 * layout).
 * Bytes that do not decode to a payload key on the raw credential ("c:").
 *
 * A nonce key reads "n2:<identity>:<legacy>": <legacy> is the key an earlier
 * build used for the same credential (network as v1 spells it, nonce only).
 * The guard honors claims and consumed marks under that legacy key that an
 * earlier build wrote, and writes its own there tagged, so across a deploy
 * neither build lets the other's in-flight or consumed payment run again
 * (see legacyOf below).
 */
export function paymentReplayKey(req) {
  const cred =
    paymentHeaderOf(req);   // middleware order — see src/payer.js
  if (!cred || typeof cred !== "string") return null;
  try {
    const p = decodePaymentHeader(cred);
    const auth = p?.payload?.authorization;
    const nonce = auth?.nonce;
    if (typeof nonce === "string" && nonce) {
      const n = nonce.toLowerCase();
      const network = p?.accepted?.network || p?.network || p?.payload?.network || "?";
      const rawFrom = typeof auth?.from === "string" ? auth.from.trim() : "";
      const from = /^0x[0-9a-fA-F]{40}$/.test(rawFrom) ? rawFrom.toLowerCase() : rawFrom;
      const id = createHash("sha256").update(`${network}\n${from}\n${n}`).digest("hex");
      const legacyNetwork = p?.network || p?.payload?.network || "?";
      const legacy = createHash("sha256").update(`${legacyNetwork}:${n}`).digest("hex");
      return `n2:${id}:${legacy}`;
    }
    // A Permit2 payment: the signed permit's network, owner and nonce. Its
    // other payload fields (and any key a sender adds) are not part of what
    // the chain consumes, so they must not give one permit a second identity.
    const p2 = p?.payload?.permit2Authorization;
    // (The decoder leaves a Permit2 block only on an EVM network; the check
    // here keeps this branch from ever keying a signed transaction.)
    const p2Network = p?.accepted?.network || p?.network || p?.payload?.network || "?";
    if (p2 && typeof p2 === "object" && typeof p2.nonce === "string" && p2.nonce && typeof p2.from === "string" && p2.from && isEvmNetworkName(p2Network)) {
      const network = p2Network;
      const id = createHash("sha256").update(`permit2\n${network}\n${p2.from.trim().toLowerCase()}\n${canonicalNonce(p2.nonce)}`).digest("hex");
      return `p2:${id}:${createHash("sha256").update(cred).digest("hex")}`;
    }
    // No parseable nonce (a signed Solana transaction, an Algorand group):
    // key on the transaction the chain consumes, read from the fields the
    // facilitator reads, so neither the echoed offer around it nor a field
    // the facilitator ignores can give one signed payment a second identity.
    const legacy = createHash("sha256").update(cred).digest("hex");
    const chainId = chainTxIdentityOf(p);
    if (chainId) return `t2:${createHash("sha256").update(chainId).digest("hex")}:${legacy}`;
    // No transaction field (the facilitator refuses such a payload at
    // verify): the signed payload as a whole, sorted and depth-bounded.
    if (p?.payload && typeof p.payload === "object") {
      const id = createHash("sha256").update(`payload\n${canonicalJson(p.payload)}`).digest("hex");
      return `p2:${id}:${legacy}`;
    }
  } catch {
    /* not base64 JSON, or no parseable nonce — fall through to raw identity */
  }
  return "c:" + createHash("sha256").update(cred).digest("hex");
}

// JSON with object keys sorted at every depth: one spelling per value. Nesting
// past CANONICAL_MAX_DEPTH throws, and the caller keys on the raw credential.
const CANONICAL_MAX_DEPTH = 32;
function canonicalJson(v, depth = 0) {
  if (depth > CANONICAL_MAX_DEPTH) throw new Error("payload nested too deep");
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, depth + 1)).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k], depth + 1)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

// The largest decoded transaction read. A Solana wire transaction is at most
// 4096 bytes (a v1 message; a v0 one 1232). A longer Solana one is not decoded
// (it cannot verify). The cap is on the
// decoded bytes (src/base64-bytes.js), so characters a decoder skips cannot
// push a transaction past it.
const MAX_TX_BYTES = 4500;
// An Algorand transaction is decoded at any size a request header can carry
// (Node's 16 KB header limit bounds it): a large multisig transfer is valid
// past MAX_TX_BYTES, and keying it on its bytes would give each signer subset
// of one payment its own identity. Its id excludes the signatures.
const MAX_AVM_TX_BYTES = 16 * 1024;
// An Algorand group holds at most 16 transactions.
const MAX_AVM_GROUP = 16;
const solanaTxDecoder = getTransactionDecoder();

/**
 * What the chain consumes for a nonce-less payment, as a string, or null when
 * the payload carries no transaction field the facilitators read. Only the
 * fields the reference facilitators read are read, so a field they ignore
 * cannot change it. The chain family alone is in the identity, not its
 * spelling: a Solana message names its recent blockhash and an Algorand
 * transaction its genesis hash, so the bytes already bind the network, and a
 * network alias cannot split one payment into two. Every encoded field is
 * read as the bytes it decodes to (base64BytesOf), never as its text.
 *
 * Solana (@x402/svm exact): `payload.transaction`, the base64 wire
 * transaction. The facilitator's fee payer is account 0, so signature slot 0
 * is the fee payer's and arrives empty (zeros) from the buyer; the buyer fills
 * slots 1.. over the same message bytes. The facilitator signs slot 0 at
 * settle, deterministically over the message, so the transaction id the chain
 * dedupes on follows from the message bytes alone. The identity is the hash
 * of those bytes, the same key the facilitator's own duplicate-settlement
 * cache uses; the signature section is never read, so whatever a client puts
 * in any slot cannot give one message two identities.
 *
 * Algorand (@x402/avm exact): `payload.paymentGroup[payload.paymentIndex]`,
 * decoded signed (else unsigned) with algosdk as the facilitator does. A
 * grouped transaction keys on its group id, which every member shares and
 * the chain commits atomically, so pointing paymentIndex at another member
 * does not change it; an ungrouped one keys on its transaction id. Both are
 * computed from the transaction's fields, not from its encoding or signature.
 *
 * A transaction field that is present but does not decode, or decodes past
 * MAX_TX_BYTES, keys on its decoded bytes (txBytesIdentity), never on the
 * payload around it, so fields beside it cannot fork it. Such a transaction is
 * keyed rather than refused here: the facilitator's verify, which runs before
 * the handler, refuses a transaction it cannot decode or that is larger than
 * any valid one, so it never runs a handler either way, and a key that one
 * spelling of it cannot leave keeps its retries to one claim. Stellar keys
 * here the same way, on its envelope's bytes; paymentReplayKeyAsync replaces
 * that with the signed authorization entries when the envelope decodes.
 */
function chainTxIdentityOf(p) {
  const network = p?.accepted?.network || p?.network || p?.payload?.network;
  if (typeof network !== "string") return null;
  const payload = p?.payload;
  if (!payload || typeof payload !== "object") return null;
  if (network.startsWith("solana")) {
    const bytes = base64BytesOf(payload.transaction);
    if (!bytes) return null;
    if (bytes.length <= MAX_TX_BYTES) {
      try {
        const msg = solanaTxDecoder.decode(Uint8Array.from(bytes))?.messageBytes;
        if (msg && msg.length) return `solana\n${createHash("sha256").update(Uint8Array.from(msg)).digest("hex")}`;
      } catch { /* keyed on its bytes below */ }
    }
    return txBytesIdentity("solana", bytes);
  }
  if (network.startsWith("algorand")) {
    const group = payload.paymentGroup;
    const idx = payload.paymentIndex;
    if (!Array.isArray(group) || group.length < 1 || group.length > MAX_AVM_GROUP) return null;
    if (!Number.isInteger(idx) || idx < 0 || idx >= group.length) return null;
    const bytes = base64BytesOf(group[idx]);
    if (!bytes) return null;
    if (bytes.length <= MAX_AVM_TX_BYTES) {
      try {
        const raw = new Uint8Array(bytes);
        let txn;
        try { txn = algosdk.decodeSignedTransaction(raw).txn; } catch { txn = algosdk.decodeUnsignedTransaction(raw); }
        if (txn) {
          const g = txn.group;
          if (g && g.length && g.some((b) => b !== 0)) return `algorand\ngroup\n${Buffer.from(g).toString("hex")}`;
          return `algorand\ntxn\n${txn.txID()}`;
        }
      } catch { /* keyed on its bytes below */ }
    }
    return txBytesIdentity(`algorand\n${idx}`, bytes);
  }
  if (network.startsWith("stellar")) {
    const bytes = base64BytesOf(payload.transaction);
    return bytes ? txBytesIdentity("stellar", bytes) : null;
  }
  return null;
}

// A transaction field that is not decoded, keyed on its family (with, for an
// Algorand group, the index read) and the bytes it decodes to.
function txBytesIdentity(scope, bytes) {
  return `${scope}\nbytes\n${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * paymentReplayKey, with a Stellar payment keyed on what the network consumes:
 * its network and the payer's signed authorization entries (signer, nonce),
 * read from the signed entry (src/stellar-confirm.js stellarAuthorizationsOf),
 * so a re-encoded copy of one signed entry maps to one identity. The envelope
 * needs the Stellar SDK to decode, which loads on first use, hence async. A
 * Stellar key reads "s2:<identity>:<legacy>", <legacy> the raw-credential hash
 * an earlier build keyed the same header on (honored as for "n2:"). Any other
 * credential, or a Stellar one that does not decode, keys as paymentReplayKey.
 */
export async function paymentReplayKeyAsync(req) {
  const key = paymentReplayKey(req);
  if (!key || !(key.startsWith("c:") || key.startsWith("p2:") || key.startsWith("t2:"))) return key;
  // The raw-credential hash an earlier build keyed this header on.
  const raw = key.startsWith("c:") ? key.slice(2) : key.split(":")[2];
  try {
    const p = decodePaymentHeader(paymentHeaderOf(req));
    const network = p?.accepted?.network || p?.network || p?.payload?.network;
    if (typeof network !== "string" || !network.startsWith("stellar:")) return key;
    const entries = await stellarAuthorizationsOf(p);
    if (!entries) return key;
    const parts = entries.map((e) => `${e.signer}\n${e.nonce}`).sort();
    const id = createHash("sha256").update(`${network}\n${parts.join("\n")}`).digest("hex");
    return `s2:${id}:${raw}`;
  } catch {
    return key;
  }
}

// A key's Redis name and, for a nonce key, the name an earlier build used for
// the same credential. An earlier build's entries hold a bare timestamp; ours
// at the legacy name hold LEGACY_TAG + our own name, so we skip another
// payer's tagged entry there and honor an untagged one (it may be this very
// payment, claimed or consumed by the earlier build).
const LEGACY_TAG = "v2|";
function namesOf(key) {
  const st = /^s2:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(String(key));
  if (st) return { primary: `s2:${st[1]}`, legacy: `c:${st[2]}` };
  const pl = /^p2:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(String(key));
  if (pl) return { primary: `p2:${pl[1]}`, legacy: `c:${pl[2]}` };
  const tx = /^t2:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(String(key));
  if (tx) return { primary: `t2:${tx[1]}`, legacy: `c:${tx[2]}` };
  const m = /^n2:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(String(key));
  if (!m) return { primary: String(key), legacy: null };
  return { primary: `n2:${m[1]}`, legacy: `n:${m[2]}` };
}
// The per-process state keys a Stellar, chain-transaction or payload-keyed
// payment on its identity alone: two encodings of one signed artifact share it, while their legacy parts (each
// header's own hash) differ.
const localKeyOf = (key) => (/^(?:s2|p2|t2):/.test(String(key)) ? namesOf(key).primary : key);
const isLegacyEntry = (v) => v != null && !String(v).startsWith(LEGACY_TAG);

// A settled payment's consumed mark is kept at least this long. /privacy and
// the dataHandling list on /.well-known/x402 quote it.
export const SETTLED_HOLD_MS = 60 * 60_000;
/** The settled hold in words for those surfaces ("an hour", "2 hours", "30 minutes"). */
export function settledHoldText() {
  const hours = SETTLED_HOLD_MS / 3_600_000;
  if (Number.isInteger(hours) && hours >= 1) return hours === 1 ? "an hour" : `${hours} hours`;
  return `${Math.round(SETTLED_HOLD_MS / 60_000)} minutes`;
}
// A consumed mark is kept at least this long past the authorization's own
// validBefore (clock skew between us, the facilitator and the chain).
export const CONSUMED_VALIDITY_MARGIN_MS = 10 * 60_000;
// A validBefore further out than this is read as this far out: an
// authorization signed to stay valid for a century is held for a century.
const MAX_VALIDITY_HOLD_MS = 100 * 365 * 24 * 3600_000;
// A SETTLED payment's mark is also kept while its authorization stays valid
// (plus the margin), when that is longer than SETTLED_HOLD_MS: the chain
// refuses the spent nonce, but a reader that runs before the paywall
// (src/gateway-cache-scope.js) takes a still-valid authorization the guard
// does not hold as its payer's proof, so the mark must not lapse first. That
// hold ends this long after the settle at the latest, so a settled call
// keeps a key for a bounded time whatever validBefore its client signed (a
// settled nonce cannot be charged again, so nothing is owed past it). /privacy
// and the dataHandling list quote it.
export const MAX_SETTLED_VALIDITY_HOLD_MS = 30 * 24 * 3600_000;
/** The settled bound in words for those surfaces ("30 days"). */
export function settledValidityHoldText() {
  const days = MAX_SETTLED_VALIDITY_HOLD_MS / (24 * 3600_000);
  return Number.isInteger(days) && days >= 1 ? (days === 1 ? "a day" : `${days} days`) : `${Math.round(MAX_SETTLED_VALIDITY_HOLD_MS / 3_600_000)} hours`;
}

/**
 * When the signed authorization on this request stops being settleable, in
 * ms since the epoch, or null when the credential names no EIP-3009
 * validBefore (an SVM transaction, a Stellar or Algorand payment). A granted
 * request's consumed mark is held until at least then (plus a margin): a
 * hang-up inside the forgiveness budget is granted (the 200 default status)
 * without being settled, and the buyer was told it was free, so the same
 * authorization must not settle on a re-send while the chain would still
 * accept it.
 */
export function paymentValidBeforeMs(req) {
  const cred = paymentHeaderOf(req);
  if (!cred || typeof cred !== "string") return null;
  try {
    const p = decodePaymentHeader(cred);
    const raw = p?.payload?.authorization?.validBefore;
    // Digits as long as a uint256 (the gateway cache reader accepts the
    // same): a spelling that reader takes never reads as no expiry here.
    const sec = typeof raw === "string" && /^\d{1,78}$/.test(raw.trim()) ? Number(raw.trim()) : (Number.isSafeInteger(raw) ? raw : NaN);
    return Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, Date.now() + MAX_VALIDITY_HOLD_MS) : null;
  } catch {
    return null;
  }
}

/**
 * settle()'s options for a granted x402 request: its authorization's
 * validBefore, and whether the grant was settled (a forgiven hang-up or a
 * first-call allowance was not). Every grant is held while its authorization
 * stays valid; a settled one no longer than MAX_SETTLED_VALIDITY_HOLD_MS.
 */
export function consumedHoldFor(req, { settled = true } = {}) {
  return { validBeforeMs: paymentValidBeforeMs(req), settled: settled === true };
}

/**
 * Replay guard. Redis-backed (shared across replicas) when configured and
 * reachable; otherwise the original per-process fallback below. `consumed`
 * maps a settled nonce → the time it settled; `inFlight` is the set of nonces
 * whose gated call is open on this process. All three methods are async (a
 * Redis round trip on the common path) - the server.js call site already runs
 * inside an async middleware.
 *
 * This process's own marks are read first: a payment it consumed, or holds in
 * flight, is refused here whichever backend answered when the mark was made,
 * so a store that fails between begin() and settle() (or recovers between
 * them) never lets one payment be claimed twice on this process. A consumed
 * mark is always kept locally as well as in Redis; when the Redis write fails
 * after its bounded retries the failure is logged and counted
 * (replayGuardStoreStatus) and the write is retried in the background until
 * it lands or the hold ends.
 *
 * A Redis claim holds a per-claim token: renewals and the drop on settle or
 * release act only while the name still holds that token, so a claim that
 * lapsed and was taken by another request is never dropped or kept alive by
 * its first holder. A claim taken on this process while the store did not
 * answer is written to the store once it answers, so other replicas see it.
 *
 * Bounded: entries expire after `ttlMs`, or at the authorization's own
 * validBefore plus CONSUMED_VALIDITY_MARGIN_MS when the caller passes it and
 * it is later. The validBefore hold matters for a GRANTED request that was not
 * settled (a hang-up inside the forgiveness budget: the buyer was told it was
 * free): its nonce is still live on chain, so only this mark stops a re-send
 * from settling it. A SETTLED request passes it too, with `settled`: its mark
 * is held to the same time, and no longer than MAX_SETTLED_VALIDITY_HOLD_MS
 * from the settle (`settledMaxHoldMs`). Total LOCAL consumed entries, and background writes, are
 * each capped at `maxEntries` with FIFO eviction (Redis expires its own keys
 * via TTL, no separate cap needed). For a settled nonce eviction is safe (the
 * chain refuses it); for an unsettled granted one it is not, which is one
 * reason the paid x402 path requires the shared store whenever one is
 * configured (server.js).
 */
// Act on one name only while it still holds `value`: one script on a real
// Redis; a read then the command on a client without EVAL (test doubles).
const DEL_IF = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const EXPIRE_IF = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
async function delIfValue(c, name, value) {
  if (typeof c.eval === "function") return c.eval(DEL_IF, { keys: [name], arguments: [String(value)] });
  if ((await c.get(name)) === value) return c.del(name);
  return 0;
}
async function expireIfValue(c, name, value, seconds) {
  if (typeof c.eval === "function") return c.eval(EXPIRE_IF, { keys: [name], arguments: [String(value), String(seconds)] });
  if ((await c.get(name)) === value) return c.expire(name, seconds);
  return 0;
}

// Consumed marks the shared store did not take, across every guard in this
// process. `pending` counts the ones still being retried in the background.
const storeHealth = { consumedWriteFailures: 0, consumedWritesRecovered: 0, consumedWritesAbandoned: 0, pending: 0, pendingSince: 0, lastFailAt: 0, lastError: null };
/** How long the word must read pending without a break before `alert` reads sustained. */
export const REPLAY_STORE_ALERT_AFTER_MS = 10 * 60_000;
/**
 * One word for the consumed marks the shared store missed: "pending" while a
 * mark is held on this process only and retried in the background, else "ok".
 * A second word, `alert`, for the pagers: "sustained" once pending has held
 * without a break for REPLAY_STORE_ALERT_AFTER_MS (a store blip clears on the
 * next retry pass, seconds later, and is not a page), else "ok".
 * `full` adds the counts.
 */
export function replayGuardStoreStatus({ full = false, now = Date.now() } = {}) {
  const status = storeHealth.pending > 0 ? "pending" : "ok";
  const alert = status === "pending" && storeHealth.pendingSince && now - storeHealth.pendingSince >= REPLAY_STORE_ALERT_AFTER_MS ? "sustained" : "ok";
  if (!full) return { status, alert };
  const { pending, consumedWriteFailures, consumedWritesRecovered, consumedWritesAbandoned, lastFailAt, lastError } = storeHealth;
  return { status, alert, pending, consumedWriteFailures, consumedWritesRecovered, consumedWritesAbandoned, lastFailAgoMs: lastFailAt ? Date.now() - lastFailAt : null, lastError };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createReplayGuard({
  ttlMs = SETTLED_HOLD_MS, settledMaxHoldMs = MAX_SETTLED_VALIDITY_HOLD_MS, maxEntries = 50_000, inflightTtlSeconds = INFLIGHT_TTL_SECONDS, renewMs = INFLIGHT_RENEW_MS, maxHoldMs = MAX_HOLD_MS,
  // Waits between the tries of a consumed-mark write (the first try runs at once).
  consumedRetryDelaysMs = [50, 250],
  // How often a consumed mark the store missed is written again.
  pendingRetryMs = 2_000,
} = {}) {
  // Local (per-process) state. `consumed` and `inFlight` are this process's
  // own marks, kept whatever backend answered; with no store configured they
  // are the whole guarantee, and a Redis outage degrades to a per-replica
  // one, never to zero protection.
  const consumed = new Map(); // key -> expiresAt (ms): settledAt + ttlMs
  // key -> expiresAt (ms) for a mark held past ttlMs (a long-lived
  // authorization). Kept apart: in one map such an entry sat at the head
  // while the hour-long ones behind it expired unpruned, the map filled, and
  // the FIFO eviction then dropped the long-held mark first.
  const consumedLong = new Map();
  const inFlight = new Set();
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  // key -> this process's claim: { token, legacyTag, legacyHeld, shared }.
  // `shared` is true once the claim is in Redis under `token`.
  const claims = new Map();
  // key -> interval renewing this process's Redis claim on it.
  const renewers = new Map();
  // key -> { settledAt, until, claim }: a consumed mark the store missed,
  // oldest first, written again by one shared retry loop (schedulePending).
  const pending = new Map();

  function startRenew(key) {
    stopRenew(key);
    const until = Date.now() + maxHoldMs;
    const { primary, legacy } = namesOf(key);
    const t = setInterval(async () => {
      const claim = claims.get(key);
      if (!claim || Date.now() >= until) { stopRenew(key); return; }
      try {
        const c = await getSharedRedisClient();
        if (!c) return;
        if (!claim.shared) {
          // Taken here while the store did not answer: written there now,
          // so another replica reads this payment in flight. A name another
          // request holds is left to it; this process's own mark still
          // refuses the payment here.
          if (await c.set(REDIS_PREFIX + "f:" + primary, claim.token, { NX: true, EX: inflightTtlSeconds })) {
            claim.shared = true;
            // Settled or released while the write was out: give it back.
            if (claims.get(key) !== claim) await delIfValue(c, REDIS_PREFIX + "f:" + primary, claim.token);
          }
          return;
        }
        await expireIfValue(c, REDIS_PREFIX + "f:" + primary, claim.token, inflightTtlSeconds);
        if (claim.legacyHeld && legacy) await expireIfValue(c, REDIS_PREFIX + "f:" + legacy, claim.legacyTag, inflightTtlSeconds);
      } catch { /* the next tick retries */ }
    }, renewMs);
    t.unref?.();
    renewers.set(key, t);
  }
  function stopRenew(key) {
    const t = renewers.get(key);
    if (t) { clearInterval(t); renewers.delete(key); }
  }

  // Prune expired local consumed entries from the head (insertion order).
  // The default-hold map expires in the order it was written. A long-held
  // entry can sit at its map's head longer than the ones behind it, so
  // pruning stops there and a lookup also checks the entry it reads
  // (isConsumedLocal).
  function pruneLocal(now) {
    for (const m of [consumed, consumedLong]) {
      for (const [k, until] of m) {
        if (until <= now) m.delete(k);
        else break;
      }
    }
  }
  function isConsumedLocal(key, now) {
    for (const m of [consumed, consumedLong]) {
      const until = m.get(key);
      if (until === undefined) continue;
      if (until > now) return true;
      m.delete(key);
    }
    return false;
  }
  // Each map is capped at maxEntries, oldest first out.
  function markConsumedLocal(lk, until, long) {
    consumed.delete(lk);
    consumedLong.delete(lk);
    const m = long ? consumedLong : consumed;
    while (m.size >= maxEntries) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    m.set(lk, until);
  }
  // How long a consumed mark is held: ttlMs, or until the authorization's
  // validBefore plus a margin when that is later; for a settled payment
  // that longer hold ends settledMaxHoldMs after the settle at the latest
  // (never under ttlMs).
  function holdMsOf(now, validBeforeMs, settled) {
    const v = Number(validBeforeMs);
    if (!(Number.isFinite(v) && v > 0)) return ttlMs;
    const toExpiry = v + CONSUMED_VALIDITY_MARGIN_MS - now;
    return Math.max(ttlMs, settled ? Math.min(toExpiry, settledMaxHoldMs) : toExpiry);
  }

  // Write the consumed mark (and its tagged legacy twin), trying again after
  // each of `delays`; then drop this process's claim. True once the mark is
  // written. Consumed mark FIRST, then the claim is dropped: at every moment
  // one of the two exists, so a begin() racing this settle reads "consumed"
  // or fails its SET NX ("inflight").
  async function writeConsumed(c, key, settledAt, until, claim, delays) {
    const { primary, legacy } = namesOf(key);
    let lastError = null;
    for (let i = 0; ; i++) {
      try {
        const ex = Math.max(1, Math.ceil((until - Date.now()) / 1000));
        if (!c) throw new Error("shared store unavailable");
        await c.set(REDIS_PREFIX + "c:" + primary, String(settledAt), { EX: ex });
        // An earlier build still running reads any entry at the legacy name
        // as consumed. Tagged, so this build reads it as another payer's;
        // an earlier build's own mark there is never overwritten.
        if (legacy) await c.set(REDIS_PREFIX + "c:" + legacy, LEGACY_TAG + primary, { NX: true, EX: ex });
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (i >= delays.length) break;
        await sleep(delays[i]);
        try { c = await getSharedRedisClient(); } catch { c = null; }
      }
    }
    if (lastError) return { written: false, error: lastError };
    try {
      if (claim?.shared) await delIfValue(c, REDIS_PREFIX + "f:" + primary, claim.token);
      if (claim?.legacyHeld && legacy) await delIfValue(c, REDIS_PREFIX + "f:" + legacy, claim.legacyTag);
    } catch { /* the claim expires with its TTL; the mark is written */ }
    return { written: true };
  }

  // One retry loop for every consumed mark the store missed, over a bounded
  // queue (`pending`, insertion order, at most `maxEntries`): a timer per
  // mark held one closure and one interval each, so an outage that missed
  // tens of thousands of marks grew the heap with them. Every pendingRetryMs
  // the loop walks the queue oldest first, drops a mark whose hold has ended
  // (abandoned), and writes the rest again; the pass stops at the first write
  // the store refuses, since the store is still down for the ones after it.
  let pendingTimer = null;
  let pendingBusy = false;
  function stopPendingLoop() {
    if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
  }
  function clearPending(key) {
    if (!pending.delete(key)) return false;
    storeHealth.pending = Math.max(0, storeHealth.pending - 1);
    if (storeHealth.pending === 0) storeHealth.pendingSince = 0;
    if (pending.size === 0) stopPendingLoop();
    return true;
  }
  async function retryPendingPass() {
    if (pendingBusy) return;
    pendingBusy = true;
    try {
      const t0 = Date.now();
      for (const [key, entry] of [...pending]) {
        if (entry.until <= t0) { if (pending.get(key) === entry && clearPending(key)) storeHealth.consumedWritesAbandoned++; }
      }
      if (pending.size === 0) return;
      let c = null;
      try { c = await getSharedRedisClient(); } catch { c = null; }
      if (!c) return;
      for (const [key, entry] of [...pending]) {
        if (pending.get(key) !== entry) continue;
        if (Date.now() >= entry.until) { if (clearPending(key)) storeHealth.consumedWritesAbandoned++; continue; }
        let r;
        try { r = await writeConsumed(c, key, entry.settledAt, entry.until, entry.claim, []); } catch (e) { r = { written: false, error: e }; }
        if (!r.written) break;
        if (pending.get(key) === entry && clearPending(key)) {
          storeHealth.consumedWritesRecovered++;
          console.warn("[replay-guard] a consumed mark the shared store missed is now written");
        }
      }
    } catch { /* the next tick retries */ } finally { pendingBusy = false; }
  }
  // A consumed mark the store did not take: queued, and written again by the
  // shared loop every pendingRetryMs until it lands or its hold ends. This
  // process refuses the payment meanwhile (its local mark).
  function schedulePending(key, settledAt, until, claim) {
    clearPending(key);
    while (pending.size >= maxEntries) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined || !clearPending(oldest)) break;
      storeHealth.consumedWritesAbandoned++;
    }
    if (storeHealth.pending === 0) storeHealth.pendingSince = Date.now();
    storeHealth.pending++;
    pending.set(key, { settledAt, until, claim });
    if (!pendingTimer) {
      pendingTimer = setInterval(() => { void retryPendingPass(); }, pendingRetryMs);
      pendingTimer.unref?.();
    }
  }

  return {
    /**
     * Claim the nonce for this in-flight call. Returns:
     *   "ok"       — first use; caller proceeds to the paywall
     *   "inflight" — an identical authorization is mid-settle (concurrent replay)
     *   "consumed" — this authorization already settled (sequential replay)
     *   "unavailable": only with `requireShared`; a shared store is
     *                   configured and did not answer; the caller refuses
     */
    async begin(key, now = Date.now(), { requireShared = false } = {}) {
      pruneLocal(now);
      const lk = localKeyOf(key);
      // This process's own marks first: they hold whatever backend answered
      // when they were made.
      if (isConsumedLocal(lk, now)) return "consumed";
      if (inFlight.has(lk)) return "inflight";
      const c = await getSharedRedisClient();
      if (!c && requireShared && sharedLimitEnabled()) return "unavailable";
      if (c) {
        const { primary, legacy } = namesOf(key);
        const token = randomUUID();
        const legacyTag = LEGACY_TAG + primary + "|" + token;
        let claimedPrimary = false;
        let legacyHeld = false;
        try {
          if (await c.get(REDIS_PREFIX + "c:" + primary)) return "consumed";
          if (legacy && isLegacyEntry(await c.get(REDIS_PREFIX + "c:" + legacy))) return "consumed";
          // SET NX is the atomic claim: two replicas racing this same key
          // cannot both receive a non-null reply, which is exactly the
          // property inFlight.add() gave for free within one process.
          const claimed = await c.set(REDIS_PREFIX + "f:" + primary, token, { NX: true, EX: inflightTtlSeconds });
          if (!claimed) return "inflight";
          claimedPrimary = true;
          const back = async (verdict) => { await delIfValue(c, REDIS_PREFIX + "f:" + primary, token); if (legacyHeld) await delIfValue(c, REDIS_PREFIX + "f:" + legacy, legacyTag); return verdict; };
          if (legacy) {
            // An earlier build's claim on this credential is honored; another
            // payer's tagged claim there is not ours to wait on.
            legacyHeld = Boolean(await c.set(REDIS_PREFIX + "f:" + legacy, legacyTag, { NX: true, EX: inflightTtlSeconds }));
            if (!legacyHeld && isLegacyEntry(await c.get(REDIS_PREFIX + "f:" + legacy))) return back("inflight");
          }
          // Read the consumed mark again under the claim: a settle writes its
          // mark before it drops its claim, so a settle that finished between
          // the first read and the claim is seen here.
          if (await c.get(REDIS_PREFIX + "c:" + primary)) return back("consumed");
          if (legacy && isLegacyEntry(await c.get(REDIS_PREFIX + "c:" + legacy))) return back("consumed");
          inFlight.add(lk);
          claims.set(key, { token, legacyTag, legacyHeld, shared: true });
          startRenew(key);
          return "ok";
        } catch (e) {
          // A claim this call took before the store failed is dropped (best
          // effort), so the buyer's retry is not refused as in flight for the
          // claim's whole life on a payment that was never used.
          if (claimedPrimary) {
            try { await delIfValue(c, REDIS_PREFIX + "f:" + primary, token); } catch { /* expires with its TTL */ }
            if (legacyHeld) { try { await delIfValue(c, REDIS_PREFIX + "f:" + legacy, legacyTag); } catch { /* expires with its TTL */ } }
          }
          if (requireShared) {
            console.error("[replay-guard] redis begin failed; refusing a route that requires the shared store:", e.message);
            return "unavailable";
          }
          console.error("[replay-guard] redis begin failed, falling back to local state:", e.message);
          // fall through to the local path below
        }
      }
      // Checked again: another call on this process may have claimed the
      // payment while this one waited on the store.
      if (inFlight.has(lk)) return "inflight";
      inFlight.add(lk);
      // With a store configured, the claim is written there once it answers.
      if (c || sharedLimitEnabled()) {
        claims.set(key, { token: randomUUID(), legacyTag: null, legacyHeld: false, shared: false });
        startRenew(key);
      }
      return "ok";
    },
    /**
     * Read-only twin of begin(): what this guard holds for `key`, claiming
     * nothing. Returns "consumed", "inflight", "unavailable" (a configured
     * shared store did not answer) or null (nothing held). Read by a gate that
     * runs before begin() and must not serve a credential begin() would
     * refuse (src/gateway-cache-scope.js); every non-null answer means "held".
     */
    async held(key, now = Date.now()) {
      if (!key) return null;
      const lk = localKeyOf(key);
      // This process's own marks answer whenever the store holds nothing (or
      // does not answer): they hold whatever backend answered when made.
      const local = () => (isConsumedLocal(lk, now) ? "consumed" : inFlight.has(lk) ? "inflight" : null);
      let c = null;
      try { c = await getSharedRedisClient(); } catch { return local() || (sharedLimitEnabled() ? "unavailable" : null); }
      if (!c) return local() || (sharedLimitEnabled() ? "unavailable" : null);
      try {
        // Every name in one round trip (MGET): this read runs before the
        // paywall on a gateway cache candidate.
        const { primary, legacy } = namesOf(key);
        const names = [REDIS_PREFIX + "c:" + primary, REDIS_PREFIX + "f:" + primary];
        if (legacy) names.push(REDIS_PREFIX + "c:" + legacy, REDIS_PREFIX + "f:" + legacy);
        const vals = typeof c.mGet === "function" ? await c.mGet(names) : await Promise.all(names.map((n) => c.get(n)));
        if (!Array.isArray(vals) || vals.length !== names.length) return local() || "unavailable";
        const [cP, fP, cL, fL] = vals;
        if (cP || (legacy && isLegacyEntry(cL))) return "consumed";
        if (fP || (legacy && isLegacyEntry(fL))) return "inflight";
        return local();
      } catch {
        return local() || "unavailable";
      }
    },
    /** Mark the nonce consumed: call only when the gated call was granted
     *  (200). `validBeforeMs` (paymentValidBeforeMs) holds the mark until the
     *  authorization itself expires when that is later than ttlMs. Pass
     *  `settled: true` with it for a grant that WAS settled: that
     *  authorization is spent on chain, so its mark is held to its validBefore
     *  only up to settledMaxHoldMs from now, and a far validBefore does not
     *  keep one long-lived key per paid call. A grant that was not settled (a
     *  forgiven hang-up, a first-call allowance) is still live on chain and is
     *  held to its validBefore in full. */
    async settle(key, now = Date.now(), { validBeforeMs = null, settled = false } = {}) {
      stopRenew(key);
      const claim = claims.get(key);
      claims.delete(key);
      const holdMs = holdMsOf(now, validBeforeMs, settled === true);
      const until = now + holdMs;
      const lk = localKeyOf(key);
      inFlight.delete(lk);
      // Kept here whatever the store does, so this process never claims the
      // payment again while the mark is held.
      markConsumedLocal(lk, until, holdMs > ttlMs);
      let c = null;
      try { c = await getSharedRedisClient(); } catch { c = null; }
      // No store configured: the local mark is the guarantee.
      if (!c && !sharedLimitEnabled()) return;
      const r = await writeConsumed(c, key, now, until, claim, consumedRetryDelaysMs);
      if (r.written) { clearPending(key); return; }
      storeHealth.consumedWriteFailures++;
      storeHealth.lastFailAt = Date.now();
      storeHealth.lastError = String(r.error?.message || r.error || "unavailable").slice(0, 120);
      console.error(`[replay-guard] redis settle failed after ${consumedRetryDelaysMs.length + 1} tries; the consumed mark is held on this process and written again in the background:`, storeHealth.lastError);
      schedulePending(key, now, until, claim);
    },
    /** Release the nonce — call when the gated call was NOT granted, so a
     *  legitimate retry of the still-valid authorization can proceed. Only
     *  this process's own claim is dropped: a name another request holds
     *  is left to it. */
    async release(key) {
      stopRenew(key);
      const claim = claims.get(key);
      claims.delete(key);
      inFlight.delete(localKeyOf(key));
      if (!claim?.shared) return;
      try {
        const c = await getSharedRedisClient();
        if (!c) return;
        const { primary, legacy } = namesOf(key);
        await delIfValue(c, REDIS_PREFIX + "f:" + primary, claim.token);
        if (claim.legacyHeld && legacy) await delIfValue(c, REDIS_PREFIX + "f:" + legacy, claim.legacyTag);
      } catch (e) {
        console.error("[replay-guard] redis release failed; the claim expires with its TTL:", e.message);
      }
    },
    /** Introspection for tests / stats: LOCAL state only; Redis state is
     *  shared and has no single-process notion of "size". */
    _state() {
      return { consumed: consumed.size + consumedLong.size, inFlight: inFlight.size, renewing: renewers.size, pendingConsumed: pending.size };
    },
  };
}
