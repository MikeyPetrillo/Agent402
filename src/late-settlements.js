// Settlements that failed while naming a transaction, booked until the chain
// says what happened to it.
//
// A settle answer that is not a success but carries a transaction hash (our
// own Robinhood relayer's settlement_pending after its receipt wait, or any
// facilitator timeout, 5xx or refusal that names a transaction) leaves the
// buyer refused with a 402: nothing was served. The transfer can still land
// on-chain moments later, and then the buyer paid for nothing. So the hash is
// booked here, keyed by network and transaction, and a leased reconcile pass
// reads its receipt:
//
//   mined, status 1, and the token moved at least the required amount from
//   the payer to the payTo the buyer signed for -> unless that tx was served
//   after all (a sale recorded for it, or another request holding its
//   settlement claim), the charge happened and nothing was served: it becomes
//   an owed refund keyed by the tx (settled_after_402), repaid only after
//   on-chain proof (src/payment-verify.js). Dropped once the ledger holds it.
//   mined but reverted, or mined without that transfer -> nothing moved to
//   us for this payment: closed, nothing owed.
//   not found -> checked again with a backoff. Closed as not landed only
//   when the chain answered, WINDOW_MS has passed AND the authorization's
//   validBefore is behind us (mined after that, the transfer reverts).
//   unreadable (the RPC fails), or an authorization still valid -> kept
//   with a backoff; past MAX_AGE_MS it becomes `unresolved`: never dropped,
//   listed on the operator view for a human, and logged.
//
// Only EVM networks with a configured RPC (src/evm-rpcs.js) are booked; any
// other network is skipped and the skip logged. Tempo is left to its own
// confirm path (src/tempo-confirm.js); Arc's pending answers carry no hash and
// are booked by src/circle-pending.js.
//
// Stored in the state database when one is configured, in the file otherwise
// (src/json-document.js), the same way as the Arc pending book. The reconcile
// pass runs under a lease that covers its whole time budget, so two
// containers never resolve one entry at once, and the owed write is
// insert-if-absent by transaction (src/refund-ledger.js), so one transfer is
// never owed twice.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady } from "./state-db.js";
import { rpc, evmTransferredInReceipt } from "./payment-verify.js";
import { evmRpcFor } from "./evm-rpcs.js";
import { authorizationUsed, findAuthorizationTx, blockNear } from "./robinhood-outage.js";
import { ownFirstAttemptOf } from "./robinhood-order.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const TEMPO_NETWORK = "eip155:4217";

export const SETTLED_AFTER_402 = "settled_after_402";
export const MAX_ENTRIES = 2000;
/** How long an absent transaction is looked for before it is closed. */
export const WINDOW_MS = 60 * 60_000;
export const FIRST_CHECK_MS = 30_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
/** An entry whose absence is never proven becomes unresolved after this. */
export const MAX_AGE_MS = 24 * 3600_000;
/** Consecutive passes whose handling of one entry threw. */
export const FAILURE_LIMIT = 12;
/** Worst-case pass length; the reconcile lease must outlast it. */
export const MAX_PASS_MS = 60_000;
/** The lease: the pass budget, plus one RPC read that started inside it, plus margin. */
export const RECONCILE_LEASE_MS = MAX_PASS_MS + 60_000;
const RPC_TIMEOUT_MS = 8_000;

/** The route slug a refund row names, from the resource URL the buyer paid. */
function slugOf(resourceUrl) {
  try {
    const p = new URL(String(resourceUrl)).pathname.replace(/\/+$/, "");
    return (p.startsWith("/api/") ? p.slice(5) : p.replace(/^\//, "")).slice(0, 120) || "unknown";
  } catch { return "unknown"; }
}

/**
 * An authorization's validBefore as unix seconds, or null when it is missing,
 * unreadable or past any date a clock reaches (a "never expires" value such
 * as 2^64-1). Null means NOT expired: such an entry is never closed as not
 * landed, only marked unresolved for a human at MAX_AGE_MS.
 */
export const VALID_BEFORE_NEVER = null;
export function validBeforeOf(v) {
  let n;
  try { n = BigInt(String(v ?? "").trim()); } catch { return VALID_BEFORE_NEVER; }
  if (n <= 0n || n > 10_000_000_000n) return VALID_BEFORE_NEVER; // beyond year 2286
  return Number(n);
}
const authorizationExpired = (validBefore, t) => validBefore != null && Number(validBefore) > 0 && t > Number(validBefore) * 1000;

export const lateKey = (network, tx) => `${String(network)}|${String(tx).toLowerCase()}`;
/** An entry booked by AUTHORIZATION (no transaction known yet): the one an
 *  ambiguous facilitator failure leaves (src/robinhood-outage.js). */
export const lateAuthKey = (network, payer, nonce) => `${String(network)}|auth|${String(payer).toLowerCase()}|${String(nonce).toLowerCase()}`;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
// How far back an authorization-keyed entry looks for the transaction that
// used it: before its booking, since the facilitator may have broadcast first.
const AUTH_LOOKBACK_MS = 10 * 60_000;

/** How a log line names an entry: its transaction, or its authorization. */
const labelOf = (e) => (e.tx ? `tx ${e.tx}` : `auth ${e.payer}/${e.nonce}`);
const backoff = (checks) => Math.min(FIRST_CHECK_MS * 2 ** Math.max(0, checks), MAX_BACKOFF_MS);

/**
 * The entry a settle failure leaves, or null: a non-success that names a
 * transaction hash. `ctx` is the @x402/core settle-failure context; a
 * fallback that stopped the settle chain on its own answer leaves that
 * answer's transaction on `ctx.__a402LateTx` (src/payments.js).
 */
export function lateSettleCandidate(ctx) {
  const tx = String(ctx?.__a402LateTx?.transaction || ctx?.error?.transaction || "");
  const req = ctx?.requirements || {};
  const auth = ctx?.paymentPayload?.payload?.authorization || ctx?.paymentPayload?.payload?.permit2Authorization || {};
  // After an ambiguous failure the AUTHORIZATION is booked: whichever
  // transaction later uses it (the facilitator's or our relayer's) is found
  // on chain. It wins over a named transaction, which may be a no-op of ours.
  const la = ctx?.__a402LateAuth;
  if (la && NONCE.test(String(la.nonce || ""))) {
    return {
      network: String(req.network || ""), tx: null, nonce: String(la.nonce), payer: String(la.payer || auth.from || ""),
      payTo: String(req.payTo || ""), asset: String(req.asset || ""), amount: String(req.amount ?? ""),
      resource: ctx?.paymentPayload?.resource?.url || null, validBefore: validBeforeOf(la.validBefore ?? auth.validBefore), via: la.via || "ambiguous facilitator",
    };
  }
  if (!TX.test(tx)) return null;
  return {
    network: String(req.network || ""),
    tx,
    payer: String(auth.from || ctx?.error?.payer || ""),
    payTo: String(req.payTo || ""),
    asset: String(req.asset || ""),
    amount: String(req.amount ?? ""),
    resource: ctx?.paymentPayload?.resource?.url || null,
    validBefore: validBeforeOf(auth.validBefore ?? auth.deadline),
    // A payment our relayer settled first (the facilitator read dry) named
    // its transaction as the primary's answer: the entry says whose it is.
    via: ctx?.__a402LateTx?.via || (ownFirstAttemptOf(ctx?.paymentPayload, req.network) ? "own relayer" : "primary"),
  };
}

export function createLateSettleBook({
  file = process.env.LATE_SETTLE_FILE || "/data/late-settlements.json",
  // The refund ledger loads on first use: the settle path imports this
  // module, and most passes book nothing.
  recordOwed = async (row) => (await import("./refund-ledger.js")).recordRefundOwed(row),
  owedRecorded = async (tx) => !!(await (await import("./refund-ledger.js")).refundByEvidenceFresh(tx)),
  wasServed = async () => false,
  rpcFor = evmRpcFor,
  fetchImpl = fetch,
  now = () => Date.now(),
  log = console.warn,
  maxEntries = MAX_ENTRIES,
  // Where a booking whose store write failed is kept until it lands: the
  // money journals' dead-letter (local disk, or Redis with
  // LEDGER_JOURNAL_REDIS=on), built on first use.
  journal = null,
  alarm = console.error,
} = {}) {
  let state = { pending: {} };
  const absorb = (s) => { if (s && typeof s === "object" && s.pending && typeof s.pending === "object") state = { pending: { ...s.pending } }; };
  const doc = createJsonDocument({ name: "late-settlements", file, log: () => {} });
  absorb(doc.loadSync(null));
  const ready = trackStoreReady(doc.backend === "pg" ? doc.load(null).then(absorb) : Promise.resolve(), "late-settlements");
  const PG = doc.backend === "pg";

  // Decisions read the SHARED store, never this process's memory alone: two
  // replicas share one book.
  const refresh = async () => {
    try {
      const b = PG ? await doc.load(null) : doc.loadSync(null);
      if (b && typeof b === "object") absorb(b);
      else state = { pending: {} };
    } catch { /* keep the last body read */ }
  };
  // Read-modify-write against the stored body, so two containers booking or
  // resolving at once never drop each other's entries.
  const change = async (fn) => {
    if (!PG) {
      await refresh();
      const next = { pending: { ...state.pending } };
      fn(next.pending);
      if (!(await doc.save(next))) return false;
      state = next;
      return true;
    }
    const r = await doc.update((b) => {
      const pending = { ...((b && typeof b === "object" && b.pending) || {}) };
      fn(pending);
      return { pending };
    }, { fallback: null });
    if (r.ok) absorb(r.body);
    return !!r.ok;
  };
  const entries = () => Object.values(state.pending);
  let journalImpl = journal;
  const journalOf = async () => {
    if (journalImpl) return journalImpl;
    const { createDeadLetter } = await import("./ledger-mirror.js");
    const { stateDbSchema } = await import("./state-db.js");
    journalImpl = createDeadLetter({ file: `${file}.pending.ndjson`, name: "lateSettlements", journalKey: PG ? `${stateDbSchema()}:lateSettlements` : "" });
    return journalImpl;
  };
  const write = async (entry) => {
    try { return await change((p) => { if (!p[entry.key]) p[entry.key] = entry; }); } catch { return false; }
  };
  // Lands what the journal holds (a booking whose store write failed earlier,
  // in this process or one that has since stopped).
  const drainJournal = async () => {
    let j;
    try { j = await journalOf(); } catch { return 0; }
    if (!j || !(j.size?.() > 0)) return 0;
    try { return await j.drain(async (e) => (e?.payload?.key ? ((await write(e.payload)) ? "landed" : "stop") : "drop")); } catch { return 0; }
  };
  const call = (url, method, params) => rpc(url, method, params, fetchImpl, RPC_TIMEOUT_MS, []);

  return {
    ready,
    refresh,
    /** Book one failed settlement that names a transaction. Answers whether
     *  it is booked (or already was). */
    async book(c = {}) {
      const network = String(c.network || "");
      if (!network.startsWith("eip155:") || network === TEMPO_NETWORK) {
        log(`[late-settle] ${network || "unknown network"} settlement ${c.tx || ""} failed naming a transaction; no receipt reader for this network, not booked`);
        return false;
      }
      if (!rpcFor(network)) {
        log(`[late-settle] ${network} settlement ${c.tx} failed naming a transaction; no RPC configured, not booked`);
        return false;
      }
      const byAuth = !c.tx && NONCE.test(String(c.nonce || ""));
      if ((!byAuth && !TX.test(String(c.tx || ""))) || !ADDR.test(String(c.payer || "")) || !ADDR.test(String(c.payTo || "")) || !ADDR.test(String(c.asset || "")) || !/^[0-9]{1,30}$/.test(String(c.amount || ""))) return false;
      const key = byAuth ? lateAuthKey(network, c.payer, c.nonce) : lateKey(network, c.tx);
      await refresh();
      if (state.pending[key]) return true;
      if (entries().length >= maxEntries) {
        log(`[late-settle] book is full (${maxEntries}); ${network} ${byAuth ? `auth ${c.payer}/${c.nonce}` : `tx ${c.tx}`} NOT booked - resolve the unresolved entries`);
        return false;
      }
      const t = now();
      const entry = {
        key, network, tx: byAuth ? null : String(c.tx).toLowerCase(), ...(byAuth ? { nonce: String(c.nonce).toLowerCase() } : {}), payer: String(c.payer), payTo: String(c.payTo), asset: String(c.asset),
        amount: String(c.amount), validBefore: validBeforeOf(c.validBefore), slug: slugOf(c.resource), via: String(c.via || "primary").slice(0, 60),
        at: t, nextCheckAt: t + FIRST_CHECK_MS, checks: 0, unreadable: 0, failures: 0, state: "pending",
      };
      if (await write(entry)) {
        log(byAuth
          ? `[late-settle] ${network} authorization ${c.payer} nonce ${c.nonce} (via ${entry.via}): outcome unknown; booked until it is read on chain`
          : `[late-settle] ${network} settlement failed naming tx ${c.tx} (via ${entry.via}); booked until its receipt is read`);
        return true;
      }
      // The store did not take it: kept in the journal and landed by the next
      // reconcile pass, never dropped in silence.
      let id = null;
      try { const j = await journalOf(); id = j ? j.add("late", entry) : null; } catch { id = null; }
      if (id == null) {
        alarm(`[late-settle] ${network} ${byAuth ? `auth ${c.payer}/${c.nonce}` : `tx ${c.tx}`} failed and could NOT be recorded (store and journal both refused); if it lands the buyer is owed ${entry.amount} of ${entry.asset} from ${entry.payer}`);
        return false;
      }
      log(`[late-settle] ${network} ${byAuth ? `auth ${c.payer}/${c.nonce}` : `tx ${c.tx}`} (via ${entry.via}): the store write failed; kept in the journal until the next reconcile lands it`);
      return true;
    },
    /** The entries as last read; call refresh() first for the shared view. */
    list() { return entries(); },
    /** Operator view from the shared store: every open entry, no amounts. */
    async operatorView() {
      await refresh();
      const all = entries();
      return {
        total: all.length,
        bound: maxEntries,
        unresolved: all.filter((e) => e.state === "unresolved").length,
        open: all.map((e) => ({ key: e.key, network: e.network, tx: e.tx, slug: e.slug, via: e.via, state: e.state, at: e.at, checks: e.checks })),
      };
    },
    /**
     * One reconcile pass over the entries whose next check is due, oldest
     * first, at most maxChecks of them within maxPassMs. A throw while
     * handling one entry is counted and that entry backs off; the pass
     * continues with the next.
     */
    async reconcile({ maxChecks = 50, maxPassMs = MAX_PASS_MS } = {}) {
      const out = { checked: 0, owed: 0, served: 0, reverted: 0, notOurs: 0, absent: 0, pending: 0, unreadable: 0, unresolved: 0, errors: 0, journaled: 0 };
      out.journaled = await drainJournal();
      await refresh();
      const started = now();
      const due = entries()
        .filter((e) => e.state === "pending" && (e.nextCheckAt || 0) <= started)
        .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0) || a.at - b.at)
        .slice(0, maxChecks);
      for (const e of due) {
        if (now() - started >= maxPassMs) break;
        out.checked++;
        try {
          await this._one(e, out);
        } catch {
          out.errors++;
          const failures = (e.failures || 0) + 1;
          const stuck = failures >= FAILURE_LIMIT;
          try {
            await change((p) => {
              if (!p[e.key]) return;
              p[e.key] = { ...p[e.key], failures, nextCheckAt: now() + backoff(failures), ...(stuck ? { state: "unresolved", unresolvedAt: now() } : {}) };
            });
          } catch { /* the store itself is failing: the next pass retries */ }
          if (stuck) { out.unresolved++; log(`[late-settle] ${e.network} ${labelOf(e)} unresolved after ${failures} failed passes; operator action needed`); }
        }
      }
      return out;
    },
    async _one(e0, out) {
      const url = rpcFor(e0.network);
      let e = e0;
      let receipt;
      let readable = true;
      // A used authorization is never closed as not landed, whatever this pass
      // could read of its transaction.
      let usedAuth = false;
      if (!e.tx && e.nonce) {
        // Booked by authorization: unused means nothing has landed (yet); used
        // means the transaction that used it is found and judged like any
        // other booked transaction.
        try {
          if (!url) throw new Error("no RPC");
          const c = (m, p) => call(url, m, p);
          if (await authorizationUsed(c, e.asset, e.payer, e.nonce)) {
            usedAuth = true;
            const { head, from } = await blockNear(c, e.at - AUTH_LOOKBACK_MS);
            const start = Number.isFinite(e.scanFrom) ? e.scanFrom : from;
            const f = await findAuthorizationTx(c, { token: e.asset, authorizer: e.payer, nonce: e.nonce, fromBlock: start, toBlock: head });
            if (f.tx) e = { ...e, tx: f.tx };
            else {
              await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], scanFrom: f.scannedTo + 1 }; });
            }
          }
        } catch { readable = false; }
      }
      if (readable && e.tx) {
        try { receipt = url ? await call(url, "eth_getTransactionReceipt", [e.tx]) : undefined; } catch { readable = false; }
      }
      if (!url) readable = false;
      const drop = async () => change((p) => { delete p[e.key]; });
      if (readable && receipt) {
        if (String(receipt.status) !== "0x1") {
          await drop();
          out.reverted++;
          log(`[late-settle] ${e.network} tx ${e.tx} reverted on chain; nothing moved, nothing owed`);
          return;
        }
        const moved = evmTransferredInReceipt(receipt, { token: e.asset, from: e.payer, toSet: [e.payTo] });
        if (moved < BigInt(e.amount) || moved === 0n) {
          await drop();
          out.notOurs++;
          log(`[late-settle] ${e.network} tx ${e.tx} mined without this payment's transfer (moved ${moved} of ${e.amount}); nothing owed`);
          return;
        }
        if (await wasServed({ tx: e.tx, network: e.network, key: e.key })) {
          await drop();
          out.served++;
          return;
        }
        // decimals() is read, never assumed (src/payment-verify.js).
        const decimals = Number(BigInt(await call(url, "eth_call", [{ to: e.asset, data: "0x313ce567" }, "latest"]) || "0x0"));
        if (!Number.isFinite(decimals) || decimals > 36) throw new Error("token decimals unreadable");
        await recordOwed({
          slug: e.slug, network: e.network, payer: e.payer, priceUsd: Number(e.amount) / 10 ** decimals,
          tx: e.tx, httpStatus: 402, wire: "x402",
          note: `${SETTLED_AFTER_402}: the transfer landed on chain after the buyer was refused`,
        });
        // Dropped only once the ledger holds the debt (a new row or one
        // already there for this tx); a write that did not land is retried.
        if (await owedRecorded(e.tx).catch(() => false)) {
          await drop();
          out.owed++;
          log(`[late-settle] ${e.network} tx ${e.tx} landed after a 402; booked owed (${SETTLED_AFTER_402})`);
        } else {
          await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], failures: 0, nextCheckAt: now() + FIRST_CHECK_MS }; });
          out.pending++;
        }
        return;
      }
      const checks = e.checks + 1;
      const unreadable = readable ? e.unreadable : e.unreadable + 1;
      const t = now();
      // Absent can be closed only once the chain answered (this read) AND the
      // authorization can no longer move money: past the window and past its
      // validBefore, a transaction mined later reverts.
      const authExpired = authorizationExpired(e.validBefore, t);
      if (t - e.at >= WINDOW_MS && readable && authExpired && !usedAuth) {
        await drop();
        out.absent++;
        log(`[late-settle] ${e.network} ${labelOf(e)} never mined within ${Math.round(WINDOW_MS / 60_000)} min and its authorization has expired; closed as not landed`);
        return;
      }
      if (t - e.at >= MAX_AGE_MS) {
        // Absence never proven (reads failing, or an authorization still
        // valid): kept for a human, never dropped.
        await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], checks, unreadable, state: "unresolved", unresolvedAt: t }; });
        out.unresolved++;
        log(`[late-settle] ${e.network} ${labelOf(e)} unresolved after ${checks} checks (${unreadable} unreadable); operator action needed`);
        return;
      }
      await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], checks, unreadable, failures: 0, nextCheckAt: now() + backoff(checks) }; });
      if (readable) out.pending++; else out.unreadable++;
    },
  };
}

/**
 * Registered AFTER every settle-failure hook that can recover a payment
 * (src/payments.js), so it runs only when nothing settled it: a failure that
 * names a transaction is booked. `bookFor()` resolves the shared book.
 */
export function registerLateSettleHook(server, bookFor) {
  server.onSettleFailure(async (ctx) => {
    try {
      const c = lateSettleCandidate(ctx);
      if (!c) return;
      const b = await bookFor();
      if (b) await b.book(c);
    } catch { /* booking never breaks the settle path */ }
  });
  return server;
}
