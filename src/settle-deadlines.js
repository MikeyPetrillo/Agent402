// Per-network settle deadlines: how long one x402 EVM settle may hold the
// buyer's answer, and what happens at each step.
//
// @x402/core gives every facilitator /settle call the library's 90 s request
// timeout. A facilitator that is slow on one network (a single signer that
// sends about one transaction every few seconds, or a fixed wait after the
// block) then holds each buyer's answer for as long as it takes, with nothing
// in between. This wrapper sits around a routing facilitator client's settle
// and, for an EIP-3009 `exact` payment on a network in the table below:
//
//   1. Chain check. From `checkAfterMs` after the settle started, and then
//      every `checkEveryMs`, the chain is read for this payment's transfer
//      (src/settle-onchain-proof.js proveAuthorizationSettled: the asset's
//      AuthorizationUsed(payer, nonce) log, a successful receipt moving at
//      least the price from the payer to our payTo, mined after this request's
//      payment was first seen). A transfer proven to be this payment's is
//      claimed for this request (recoverAlreadyOnChain: the authorization's
//      claim, no recorded sale, the transaction's claim) and served as
//      settled before the facilitator answers. While that claim is being
//      taken nothing else decides the settle, so a transfer this request
//      claimed is always the one it serves. The reads are bounded per
//      network, whatever the number of settles hung on it: the head is read
//      once per `checkEveryMs` for every settle watching that network (one
//      read in flight, shared), at most SETTLE_CHAIN_CHECK_MAX_PER_NETWORK
//      (default 4) log reads run at once on a network (a settle with no slot
//      waits for its next turn), a settle's checks back off after each miss
//      (`checkEveryMs`, then twice that, up to 8 s), and a head that cannot be
//      read skips the log read. Nothing here decides a buyer's answer: the
//      facilitator's answer and the cap do whenever the chain is not read.
//   2. Slow-primary switch. Each facilitator's own /settle time is measured
//      per network, from the call to its answer. A settle is SLOW when it
//      takes longer than `slowMs`, or has not answered by the cap. After
//      SETTLE_SLOW_AFTER (default 2) slow settles in a row the facilitator is
//      marked slow on that network for SETTLE_SLOW_COOLDOWN_MS (default
//      10 min): while it is, on a network whose row has `switch` on, the next
//      settle asks that network's settle fallbacks first (the same candidates
//      the settle-fallback chain uses, only with PAYMENT_SETTLE_FALLBACK on).
//      A fallback that refuses before sending anything hands the settle on to
//      the next one and then to the primary; any other failure of a fallback
//      ends the settle there, unconfirmed (it may have sent the transfer).
//      Recovery: once the cool-down ends the primary is asked first again,
//      and one settle at or under `slowMs` clears its streak. A slow one marks
//      it slow again at once (the streak is not cleared by the cool-down).
//      Per process, like the settle demotion (src/settle-demotion.js).
//   3. Hard cap. When nothing has answered by `capMs`, the settle ends with a
//      time-limit failure this module tags (settleDeadlineStopOf). The
//      settle-failure hook (src/payments.js) answers it as an unconfirmed
//      stop (markUnconfirmedStop): the buyer's 402 says the transfer may still
//      land, the authorization is booked in the late-settlement book
//      (src/late-settlements.js) and stays claimed, and a transfer that lands
//      later is booked owed once (insert-if-absent by transaction in
//      src/refund-ledger.js). The facilitator call itself is left to finish
//      on its own: its answer can no longer change what the buyer was told.
//
// Everything else passes through untouched: another scheme, a Permit2 or
// batched payment, a network not in the table (Robinhood, Ink and Arc have
// settle paths of their own), a network with no RPC to read (the late book
// could not book it), and every later settle call for a payment this wrapper
// has already handled (the settle-fallback chain's own calls).
//
// The same payment sent again after a cut (src/idempotency.js): its kept
// answer comes back with nothing run. When the route's answer could be kept
// (a route whose answers replay: no lasting effect, no identity binding, not
// streamed) and the chain now proves the transfer landed, the resend is
// served that answer instead (cappedResendVerdict), with the transfer's debt
// voided first when the late book has booked one, so one payment is served
// once and never both served and refunded.
import { SettleError } from "@x402/core/types";
import { blockMs } from "./chain-block-time.js";
import { evmRpcFor } from "./evm-rpcs.js";
import { positiveNum as num } from "./env-num.js";
import { settleClaimStateOf } from "./settlement-claims.js";

/** The networks the table covers, by name (CAIP-2). Every one settles USDC
 *  (6 decimals) with EIP-3009 and has an RPC the late book reads. */
export const SETTLE_DEADLINE_NETWORKS = Object.freeze({
  base: "eip155:8453",
  polygon: "eip155:137",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  avalanche: "eip155:43114",
  celo: "eip155:42220",
  monad: "eip155:143",
  sei: "eip155:1329",
});
const NAME_OF = Object.freeze(Object.fromEntries(Object.entries(SETTLE_DEADLINE_NETWORKS).map(([n, c]) => [c, n])));
/** The cap's floor: over any settle that succeeds today (so nothing served
 *  today is cut), under the library's 90 s, and with the route's own time
 *  still under the CDN's 100 s window for a first byte. */
export const CAP_FLOOR_MS = 60_000;
/** Celo's floor: 20 s, where a slow primary was traced and the switch is on. */
const CAP_FLOOR_BY_NETWORK = Object.freeze({ celo: 20_000 });
/** Networks whose slow primary switches to the fallback by default: Celo,
 *  where a slow primary was traced. Every other network keeps the order its
 *  facilitators were chosen in (Base and the CDP chains stay CDP first). */
const SWITCH_BY_DEFAULT = new Set(["celo"]);

/**
 * The default row for a network, from its block time now
 * (src/chain-block-time.js; measured, scheduled or nominal):
 *   checkAfterMs  max(2 s, 2 blocks): a healthy settle lands within a couple
 *                 of blocks and answers, so the chain is not read for it;
 *   checkEveryMs  max(1 s, 1 block): no read can see a new block sooner;
 *   slowMs        max(6 s, 4 blocks): a broadcast, two blocks and the
 *                 receipt read, with room; the traced slow primary's fixed
 *                 wait after the block alone was over 6 s;
 *   capMs         max(60 s, 10 blocks); Celo max(20 s, 10 blocks);
 *   switch        on for Celo only.
 */
export function defaultDeadlineRow(name, { now = Date.now(), env = process.env } = {}) {
  const b = blockMs(name, { now, env });
  return {
    checkAfterMs: Math.max(2000, 2 * b),
    checkEveryMs: Math.max(1000, b),
    slowMs: Math.max(6000, 4 * b),
    capMs: Math.max(CAP_FLOOR_BY_NETWORK[name] ?? CAP_FLOOR_MS, 10 * b),
    switch: SWITCH_BY_DEFAULT.has(name),
  };
}

const FIELDS = ["checkAfterMs", "checkEveryMs", "slowMs", "capMs"];
let parsed = { raw: undefined, off: false, rows: {} };
/**
 * SETTLE_DEADLINES: "off" turns every deadline off (the library's own
 * timeout only). Otherwise a JSON object keyed by network name or CAIP-2;
 * a value "off" leaves that network out, an object overrides any of
 * checkAfterMs, checkEveryMs, slowMs, capMs (milliseconds) and switch
 * (true/false). A malformed entry is ignored with a warning.
 */
function overrides(env) {
  const raw = String(env.SETTLE_DEADLINES ?? "").trim();
  if (raw === parsed.raw) return parsed;
  const out = { raw, off: false, rows: {} };
  if (/^(off|false|0|no)$/i.test(raw)) out.off = true;
  else if (raw) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch { obj = null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) console.warn("[settle-deadlines] SETTLE_DEADLINES ignored: not \"off\" and not a JSON object");
    else for (const [k, v] of Object.entries(obj)) {
      const name = NAME_OF[k] || (Object.hasOwn(SETTLE_DEADLINE_NETWORKS, k) ? k : null);
      if (!name) { console.warn(`[settle-deadlines] SETTLE_DEADLINES entry ignored: ${String(k).slice(0, 40)} is not a network the table covers`); continue; }
      if (v === "off" || v === false) { out.rows[name] = "off"; continue; }
      if (!v || typeof v !== "object" || Array.isArray(v)) { console.warn(`[settle-deadlines] SETTLE_DEADLINES entry for ${name} ignored: not an object or "off"`); continue; }
      const row = {};
      let bad = false;
      for (const f of FIELDS) if (v[f] !== undefined) { const n = Number(v[f]); if (Number.isFinite(n) && n > 0 && n <= 600_000) row[f] = Math.round(n); else bad = true; }
      if (v.switch !== undefined) { if (typeof v.switch === "boolean") row.switch = v.switch; else bad = true; }
      if (bad) { console.warn(`[settle-deadlines] SETTLE_DEADLINES entry for ${name} ignored: a field is not a positive number of milliseconds (switch: true or false)`); continue; }
      out.rows[name] = row;
    }
  }
  parsed = out;
  return out;
}

/** The deadlines in force for `network` (CAIP-2), or null when it has none. */
export function deadlineFor(network, { now = Date.now(), env = process.env } = {}) {
  const name = NAME_OF[String(network || "")];
  if (!name) return null;
  const o = overrides(env);
  if (o.off || o.rows[name] === "off") return null;
  const row = { ...defaultDeadlineRow(name, { now, env }), ...(o.rows[name] || {}) };
  // A row whose cap does not come after the first chain check or the slow
  // mark cannot work as written: the cap is moved past both.
  row.capMs = Math.max(row.capMs, row.checkAfterMs + row.checkEveryMs, row.slowMs + 1);
  return { network: String(network), name, ...row };
}

/** The table as it stands now: one row per network (operator detail, docs). */
export function settleDeadlineTable({ now = Date.now(), env = process.env } = {}) {
  return Object.values(SETTLE_DEADLINE_NETWORKS).map((c) => deadlineFor(c, { now, env }) || { network: c, name: NAME_OF[c], off: true });
}

// ---- the slow-primary record --------------------------------------------------
const SLOW_AFTER = () => Math.max(1, Math.floor(num(process.env.SETTLE_SLOW_AFTER, 2)));
const SLOW_COOLDOWN_MS = () => num(process.env.SETTLE_SLOW_COOLDOWN_MS, 10 * 60_000);
const slow = new Map(); // "network|label" -> { n, until, lastMs }
const slowKey = (network, label) => `${network}|${label}`;

/**
 * One facilitator settle's time on `network`. `cut`: it had not answered by
 * the cap. Answers the record after it.
 */
export function noteSettleTime(network, label, ms, { slowMs, cut = false, now = Date.now(), log = console.warn } = {}) {
  const k = slowKey(network, label);
  const isSlow = cut || !(Number(ms) <= Number(slowMs));
  const s = slow.get(k) || { n: 0, until: 0, lastMs: 0 };
  s.lastMs = Math.round(Number(ms) || 0);
  if (!isSlow) {
    if (s.n > 0 || s.until > now) {
      if (s.until > now || s.n >= SLOW_AFTER()) log(`[settle-deadlines] ${label} on ${network} settled in ${s.lastMs} ms (at or under ${slowMs}); it is asked first again`);
      slow.delete(k);
    }
    return null;
  }
  s.n++;
  if (s.n >= SLOW_AFTER() && s.until <= now) {
    s.until = now + SLOW_COOLDOWN_MS();
    log(`[settle-deadlines] ${label} on ${network} marked slow after ${s.n} slow settles in a row (the last ${cut ? "cut at the cap" : `${s.lastMs} ms`}, over ${slowMs}); fallbacks are asked first where the network switches, until ${new Date(s.until).toISOString()}`);
  }
  slow.set(k, s);
  return s;
}

export function isSlowPrimary(network, label, now = Date.now()) {
  const s = slow.get(slowKey(network, label));
  return !!s && s.until > now;
}

/** Every facilitator marked slow now (operator detail). */
export function slowPrimaryList(now = Date.now()) {
  const out = [];
  for (const [k, s] of slow) {
    if (s.until <= now) continue;
    const i = k.indexOf("|");
    out.push({ network: k.slice(0, i), facilitator: k.slice(i + 1), consecutive: s.n, until: new Date(s.until).toISOString(), lastMs: s.lastMs });
  }
  return out;
}

/** Test seam. */
export function _resetSettleDeadlines() { slow.clear(); heads.clear(); checking.clear(); parsed = { raw: undefined, off: false, rows: {} }; }

// ---- the stop the settle-failure hook answers as unconfirmed ---------------------
const STOPS = new WeakMap(); // error -> { kind: "cap" | "fallback", via }
/** How this module ended a settle with `err`, or null: `cap` (nothing answered
 *  by the cap) or `fallback` (a fallback asked first failed in a way that
 *  does not prove nothing was sent), with the facilitator it ended at. */
export function settleDeadlineStopOf(err) {
  return err && typeof err === "object" ? STOPS.get(err) || null : null;
}
function tagStop(err, kind, via) {
  if (err && typeof err === "object") { try { STOPS.set(err, { kind, via: String(via || "primary").slice(0, 80) }); } catch { /* frozen */ } }
  return err;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
/** An EIP-3009 exact payment the late book can book by its authorization. */
export function deadlineEligible(payload, requirements, { rpcFor = evmRpcFor } = {}) {
  if (String(requirements?.scheme || "").toLowerCase() !== "exact") return false;
  const inner = payload?.payload;
  if (!inner || typeof inner !== "object" || inner.permit2Authorization != null) return false;
  const a = inner.authorization;
  if (!a || typeof a !== "object" || typeof a.from !== "string" || !ADDR.test(a.from) || typeof a.nonce !== "string" || !B32.test(a.nonce)) return false;
  return !!rpcFor(String(requirements?.network || ""));
}

// A payload this wrapper has handled: every later settle call for it (the
// settle-fallback chain's) passes through.
const handled = new WeakSet();
// The settle-hook context of a payment being settled (noteSettleContext), for
// the chain check: it needs the request's first-seen stamp and claims.
const contexts = new WeakMap();
/** Kept from a beforeSettle hook: the context of the payment about to settle. */
export function noteSettleContext(ctx) {
  const p = ctx?.paymentPayload;
  if (p && typeof p === "object") contexts.set(p, ctx);
}

// ---- the chain check's reads, per network ----------------------------------------
/** The longest a settle's chain check waits between two reads after misses. */
export const CHAIN_CHECK_BACKOFF_MAX_MS = 8000;
/** SETTLE_CHAIN_CHECK_MAX_PER_NETWORK: log reads at once on one network (default 4, at most 64). */
export function chainCheckMaxPerNetwork(env = process.env) {
  const n = Number(String(env?.SETTLE_CHAIN_CHECK_MAX_PER_NETWORK ?? "").trim() || NaN);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 64) : 4;
}
/** The wait before a settle's next chain read after `misses` reads that did not prove it. */
export function chainCheckDelayMs(row, misses) {
  const every = Math.max(1, Number(row?.checkEveryMs) || 1000);
  return Math.min(Math.max(every, CHAIN_CHECK_BACKOFF_MAX_MS), every * 2 ** Math.min(16, Math.max(0, misses - 1)));
}
// network -> { at, head, promise }: the head every watching settle reads.
const heads = new Map();
// network -> log reads in flight.
const checking = new Map();
function sharedHead(network, everyMs, readHead, now) {
  const h = heads.get(network);
  if (h && (h.promise || now() - h.at < everyMs)) return h.promise || Promise.resolve(h.head);
  const entry = { at: now(), head: null, promise: null };
  entry.promise = Promise.resolve()
    .then(() => readHead(network))
    .then((v) => (Number.isSafeInteger(v) && v >= 0 ? v : null), () => null)
    .then((v) => { entry.head = v; entry.at = now(); entry.promise = null; return v; });
  heads.set(network, entry);
  return entry.promise;
}

async function defaultProve(args) {
  const { proveAuthorizationSettled } = await import("./settle-onchain-proof.js");
  return proveAuthorizationSettled(args);
}
async function defaultReadHead(network, rpcFor) {
  const { readChainHead } = await import("./settle-onchain-proof.js");
  return readChainHead({ network, rpcFor });
}
async function defaultRecover(ctx, opts) {
  const { recoverAlreadyOnChain } = await import("./settle-onchain-proof.js");
  return recoverAlreadyOnChain(ctx, opts);
}

/**
 * Wrap `client.settle` with the deadlines. `labelOf(network)` names the
 * client per network (the slow record's key); `alternatesFor(network)` is the
 * network's settle-fallback candidates ([{ name, client, own? }]), read only
 * while the primary is marked slow on a network that switches;
 * `isPreBroadcast(err)` is the fallback chain's own classifier; `exclude`
 * leaves a payment out (a batched one). `prove`, `recover`, `readHead` and
 * `now` are test seams.
 */
export function withSettleDeadline(client, {
  labelOf = () => "primary", alternatesFor = () => [], isPreBroadcast = () => false, exclude = () => false,
  prove = defaultProve, recover = defaultRecover, rpcFor = evmRpcFor, readHead = (network) => defaultReadHead(network, rpcFor), noteAsked = () => {},
  now = () => Date.now(), log = console.warn, env = process.env,
} = {}) {
  if (!client || typeof client.settle !== "function" || client.settle.__a402Deadline) return client;
  const orig = client.settle;
  const asError = (r) => Object.assign(new Error(String(r?.errorMessage || r?.errorReason || "settle rejected")), { errorReason: r?.errorReason, errorMessage: r?.errorMessage });
  const settle = async function deadlineSettle(payload, requirements, ...rest) {
    const network = String(requirements?.network || "");
    const row = deadlineFor(network, { now: now(), env });
    let skip = !row || handled.has(payload) || !payload || typeof payload !== "object";
    if (!skip) { try { skip = exclude(payload, requirements) === true || !deadlineEligible(payload, requirements, { rpcFor }); } catch { skip = true; } }
    if (skip) return orig.call(client, payload, requirements, ...rest);
    handled.add(payload);
    const label = String(labelOf(network) || "primary");
    const t0 = now();

    // The facilitator side: the fallbacks first while the primary is slow on
    // a network that switches, then the primary, timed.
    let primaryAt = null, primaryNoted = false;
    const notePrimary = (ms, cut) => {
      if (primaryNoted) return;
      primaryNoted = true;
      try { noteSettleTime(network, label, ms, { slowMs: row.slowMs, cut, now: now(), log }); } catch { /* bookkeeping only */ }
    };
    const facilitatorSide = async () => {
      if (row.switch && isSlowPrimary(network, label, now())) {
        let list = [];
        try { list = alternatesFor(network) || []; } catch { list = []; }
        for (const alt of list) {
          if (!alt?.client || typeof alt.client.settle !== "function" || alt.own || alt.client === client) continue;
          try { noteAsked(payload, network, alt.name); } catch { /* bookkeeping only */ }
          log(`[settle-deadlines] ${label} is marked slow on ${network}: asking ${alt.name} first`);
          try {
            const r = await alt.client.settle(payload, requirements, ...rest);
            if (r?.success === true) return r;
            if (isPreBroadcast(asError(r))) continue;
            return r;
          } catch (err) {
            if (isPreBroadcast(err)) continue;
            throw tagStop(err, "fallback", alt.name);
          }
        }
      }
      primaryAt = now();
      try {
        return await orig.call(client, payload, requirements, ...rest);
      } finally {
        notePrimary(now() - primaryAt, false);
      }
    };

    const outcome = await new Promise((resolve) => {
      let decided = false, claiming = false, held = null;
      // The chain check's wait, ended at once when the settle is decided, so
      // nothing holds this request after it answers.
      let waiting = null;
      const wait = (ms) => new Promise((r) => { waiting = { r, timer: setTimeout(() => { waiting = null; r(); }, Math.max(0, ms)) }; });
      const decide = (o) => {
        if (decided) return;
        // A transfer being claimed for this request decides first: once it
        // is claimed this request serves it, whatever else arrived meanwhile.
        if (claiming && o.kind !== "chain") { held ||= o; return; }
        decided = true;
        clearTimeout(capTimer);
        if (waiting) { clearTimeout(waiting.timer); const w = waiting.r; waiting = null; w(); }
        resolve(o);
      };
      facilitatorSide().then((r) => decide({ kind: "answer", r }), (e) => decide({ kind: "error", e }));
      const capTimer = setTimeout(() => decide({ kind: "cap" }), Math.max(0, row.capMs - (now() - t0)));
      const ctx = contexts.get(payload);
      if (!ctx) return;
      const maxChecks = chainCheckMaxPerNetwork(env);
      void (async () => {
        await wait(row.checkAfterMs - (now() - t0));
        let misses = 0;
        while (!decided) {
          const left = row.capMs - (now() - t0);
          if (left <= 0) return;
          let proof = { proven: false, unread: true };
          const head = await sharedHead(network, row.checkEveryMs, readHead, now);
          if (decided) return;
          // No head (the RPC is not answering) or no free slot on this
          // network: no log read this turn.
          if (head !== null && (checking.get(network) || 0) < maxChecks) {
            checking.set(network, (checking.get(network) || 0) + 1);
            try {
              proof = await prove({
                paymentPayload: payload, requirements, rpcFor, notBeforeMs: seenAtOf(ctx), head,
                pollDelaysMs: [0], deadlineMs: Math.max(500, Math.min(4000, left)), callTimeoutMs: Math.max(500, Math.min(2000, left)),
              });
            } catch { proof = { proven: false, unread: true }; }
            finally {
              const n = (checking.get(network) || 1) - 1;
              if (n > 0) checking.set(network, n); else checking.delete(network);
            }
          }
          if (decided) return;
          if (proof?.proven === true) {
            claiming = true;
            let r = null;
            try { r = await recover(ctx, { prove: async () => proof }); } catch { r = null; }
            claiming = false;
            if (r?.recovered === true && r.result) { decide({ kind: "chain", r: r.result }); return; }
            if (held) { const h = held; held = null; decide(h); }
            return;
          }
          // The chain answered a verdict that is not this payment's transfer
          // (reverted, short, sent elsewhere, mined before this request):
          // reading again cannot change it.
          if (proof?.unread !== true) return;
          misses++;
          await wait(chainCheckDelayMs(row, misses));
        }
      })().catch(() => {});
    });

    if (outcome.kind === "answer") return outcome.r;
    if (outcome.kind === "error") throw outcome.e;
    if (outcome.kind === "chain") {
      log(`[settle-deadlines] ${network} transfer ${outcome.r.transaction} read on chain after ${now() - t0} ms, before ${label} answered; served as settled`);
      return outcome.r;
    }
    // The cap: whoever was asked has not answered.
    if (primaryAt != null) notePrimary(now() - primaryAt, true);
    const ms = now() - t0;
    log(`[settle-deadlines] ${network} settle at ${label} not answered within ${row.capMs} ms: answered unconfirmed; the authorization is booked until it is read on chain`);
    const err = new SettleError(504, {
      success: false, errorReason: "timeout",
      errorMessage: `settlement did not confirm within ${Math.round(ms / 1000)} s`,
      network, payer: payload?.payload?.authorization?.from, transaction: "",
    });
    throw tagStop(err, "cap", label);
  };
  settle.__a402Deadline = true;
  settle.__a402Labelled = orig.__a402Labelled;
  client.settle = settle;
  return client;
}

// When this request's payment was first seen (src/settlement-claims.js), or null.
function seenAtOf(ctx) {
  const s = settleClaimStateOf(ctx?.transportContext?.request?.adapter?.req);
  return s && Number.isFinite(Number(s.seenAt)) ? Number(s.seenAt) : null;
}

// ---- the same payment sent again after a cut -------------------------------------
/** What a request cut by this module keeps on itself for the resend
 *  (src/idempotency.js reads it when it keeps the unconfirmed answer). */
export const CAPPED = Symbol.for("agent402.settleCapped");
export function noteCappedRequest(req, ctx) {
  if (!req || typeof req !== "object") return null;
  const r = ctx?.requirements || {};
  const a = ctx?.paymentPayload?.payload?.authorization || {};
  if (!ADDR.test(String(a.from || "")) || !B32.test(String(a.nonce || "")) || !ADDR.test(String(r.payTo || "")) || !ADDR.test(String(r.asset || "")) || !/^[0-9]{1,30}$/.test(String(r.amount || ""))) return null;
  const seenAt = seenAtOf(ctx);
  const rec = {
    network: String(r.network), asset: String(r.asset), payTo: String(r.payTo), amount: String(r.amount),
    from: String(a.from), nonce: String(a.nonce).toLowerCase(), seenAt: seenAt ?? Date.now(),
  };
  try { Object.defineProperty(req, CAPPED, { value: rec, configurable: true, writable: true, enumerable: false }); } catch { return null; }
  return rec;
}

/** The claim holder a resend of one cut payment takes its transfer under:
 *  the same for every resend of that payment, so a resend whose answer was
 *  lost can be served again, and never another payment's. */
export const cappedResendHolder = (p) => `settle-cap:${p.network}:${String(p.from).toLowerCase()}:${String(p.nonce).toLowerCase()}`;

/**
 * The verdict for the same payment sent again after a cut, when its route's
 * answer was kept: { serve: true, tx, receipt } once the chain proves this
 * payment's transfer landed and it is this payment's to serve; a refusal
 * { serve: false, status, body, retryAfter? } when its debt is being or was
 * repaid; null when the kept unconfirmed answer stands (not landed yet, not
 * readable, or the late book is still booking it).
 *
 * deps: prove(args) (proveAuthorizationSettled), claimTx(network, tx, holder)
 * -> { claimed, holder }, isLateHolder(holder), rowOf(tx) (the refund row or
 * null), replayVerdict(tx) (src/idempotency.js chargedReplayVerdict over the
 * ledger's void-on-resend), book({ tx, network, payer, priceUsd }) (books the
 * serve, bookCappedServe), refundLookup(tx), and ledgerShared: true only when
 * the refund ledger is the state database, whose void marks the evidence
 * before any later owed insert can land. On any other store a void racing
 * the late book's insert could leave a payment both served and owed, so
 * there the resend is answered the kept 402, as before this path existed.
 */
export async function cappedResendVerdict(p, deps) {
  if (deps?.ledgerShared !== true) return null;
  if (!p || typeof p !== "object" || !ADDR.test(String(p.from || "")) || !B32.test(String(p.nonce || "")) || !NAME_OF[String(p.network || "")]) return null;
  let proof = null;
  try {
    proof = await deps.prove({
      paymentPayload: { payload: { authorization: { from: p.from, nonce: p.nonce } } },
      requirements: { network: p.network, scheme: "exact", asset: p.asset, payTo: p.payTo, amount: p.amount },
      notBeforeMs: Number(p.seenAt) || null, pollDelaysMs: [0], deadlineMs: 5000, callTimeoutMs: 2500,
    });
  } catch { proof = null; }
  if (proof?.proven !== true || !B32.test(String(proof.transaction || ""))) return null;
  const tx = String(proof.transaction).toLowerCase();
  let c;
  try { c = await deps.claimTx(p.network, tx, cappedResendHolder(p)); } catch { return null; }
  const receipt = Buffer.from(JSON.stringify({ success: true, transaction: tx, network: p.network, payer: p.from })).toString("base64");
  const serve = async () => {
    try { await deps.book({ tx, network: p.network, payer: p.from, priceUsd: Number(p.amount) / 1e6 }); } catch { /* the serve does not wait on the books */ }
    return { serve: true, tx, receipt };
  };
  if (c?.claimed === true) return serve();
  if (!deps.isLateHolder(c?.holder)) return null;
  // The late book holds the transfer: it has booked (or is booking) it owed.
  // Its debt is voided before the answer goes out; with no row yet the kept
  // answer stands until the row lands.
  let row = null;
  try { row = await deps.rowOf(tx); } catch { row = null; }
  if (!row) return null;
  const v = await deps.replayVerdict(tx);
  if (v?.verdict === "serve") return serve();
  if (v?.verdict === "pending") {
    return { serve: false, status: 503, retryAfter: 10, body: {
      error: "replay_pending",
      hint: "This payment's transfer landed and the answer it bought is stored; the ledger has not yet confirmed it as served. Nothing more is charged. Retry shortly with the same payment to receive it.",
    } };
  }
  const st = ["owed", "sending", "paid"].includes(v?.row?.status) ? v.row.status : "owed";
  return { serve: false, status: 402, body: {
    error: "payment_refunded",
    hint: "The payment this request carries was refunded (or is being refunded) because its settlement did not confirm in time, so it no longer pays for a request. Request the resource again with a fresh payment.",
    refund: { status: st, lookup: deps.refundLookup(tx) },
  } };
}

/**
 * Book a resend served after a cut the way the normal served path books a
 * settled call (src/server.js): the sale on its real rail and wire (`wire`:
 * "mpp" when the payment came through the MPP shim, else "x402"), the
 * served-call counter (MPP counted as MPP) and the payment_settled event.
 * Once per transfer: a resend served again after its answer was lost finds
 * the sale (saleExists) and books nothing more. `networkName(caip2)` names
 * the chain as the books do. Answers whether it booked.
 */
export async function bookCappedServe({ slug, tx, network, payer, priceUsd, wire, internal = false, synthetic = false, clientUa = null, ownWallet = false }, sinks) {
  let exists = false;
  try { exists = !!(await sinks.saleExists(tx)); } catch { exists = false; }
  if (exists) return false;
  const net = sinks.networkName(network) || network;
  const w = wire === "mpp" ? "mpp" : "x402";
  try { await sinks.recordSale({ slug, priceUsd, rail: "usdc", network: net, payer, tx, synthetic, wire: w }); } catch { /* never break serving for accounting */ }
  try { sinks.recordServedCall(slug, "usdc", net, w === "mpp" ? "mpp" : null, { internal }); } catch { /* counting only */ }
  try { sinks.capturePostHogSettlement({ slug, rail: "usdc", network: net, priceUsd, synthetic, payer, clientUa, wire: w, ownWallet }); } catch { /* telemetry only */ }
  return true;
}
