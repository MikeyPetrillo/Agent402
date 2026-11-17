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
// A pending settle whose answers named more than one transaction (the
// library's single retry can broadcast again: src/pending-settle.js) books
// every one of them, each carrying the authorization's nonce (`authNonce`):
// such an entry is owed only when its receipt also carries the asset's
// AuthorizationUsed(payer, nonce) log, and one EIP-3009 nonce is used once, so
// one authorization is never owed twice, whichever of its transactions lands.
//
// A transaction-keyed EVM entry also carries its EIP-3009 authorization's
// nonce: before a transaction never found is closed as not landed, the
// authorization's state is read. Used means another transaction (a
// rebroadcast, another facilitator's) moved it: that transaction is found
// and judged like the booked one; a read that fails keeps the entry.
//
// EVM networks with a configured RPC (src/evm-rpcs.js) are booked, and so are
// Solana and Algorand failures that name a broadcast transaction in the
// chain's own id format (a base58 signature, a 52-character Algorand id; kept
// exactly as written, never case-folded). Those are read by the rails' own
// verifier (verifyInboundPayment, src/payment-verify.js), and a transaction
// never found closes only once it can no longer land: its recent blockhash
// reads expired (Solana; a durable-nonce transaction never closes), or every
// indexer that answered "not found" has indexed past its lastValid round
// (Algorand), so an indexer that lags never closes a landed transfer. Any other network is
// skipped and the skip logged. Tempo is left to its own confirm path
// (src/tempo-confirm.js); Arc's pending answers carry no hash and are booked
// by src/circle-pending.js.
//
// Stored in the state database when one is configured, in the file otherwise
// (src/json-document.js), the same way as the Arc pending book. The reconcile
// pass runs under a lease that covers its whole time budget, so two
// containers never resolve one entry at once, and the owed write is
// insert-if-absent by transaction (src/refund-ledger.js), so one transfer is
// never owed twice.
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
import { shortPayer } from "./verify-failure-log.js";
import { trackStoreReady } from "./state-db.js";
import { rpc, evmTransferredInReceipt, verifyInboundPayment, SOLANA_RPCS, ALGORAND_INDEXERS } from "./payment-verify.js";
import { evmRpcFor } from "./evm-rpcs.js";
import { authorizationUsed, findAuthorizationTx, blockNear } from "./robinhood-outage.js";
import { ownFirstAttemptOf } from "./robinhood-order.js";
import { pendingNotedTxsFor, takePendingAnswers, peekPendingAnswers, receiptUsesAuthorization } from "./pending-settle.js";
import { stripControlChars as oneLine } from "./prepayment-refusal.js";
import { x402McpEntryOf, mcpX402SlugOfToolName } from "./mcp-x402-routes.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;
const TEMPO_NETWORK = "eip155:4217";
// Solana: a base58 signature (64 bytes) and base58 addresses (32 bytes).
const SVM_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SVM_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Algorand: a 52-character base32 transaction id, 58-character addresses, a numeric asset id.
const AVM_TX = /^[A-Z2-7]{52}$/;
const AVM_ADDR = /^[A-Z2-7]{58}$/;
const AVM_ASSET = /^[0-9]{1,20}$/;
// The rails' USDC: 6 decimals on Solana and Algorand alike.
const RAIL_USDC_DECIMALS = 6;

/** The rail a network settles on: evm, svm (Solana), avm (Algorand), or null. */
export function railOf(network) {
  const n = String(network || "");
  if (n.startsWith("eip155:")) return "evm";
  if (n.startsWith("solana:")) return "svm";
  if (n.startsWith("algorand:")) return "avm";
  return null;
}
/** A transaction id in its chain's own format. */
const txOk = (network, tx) => {
  const r = railOf(network), t = String(tx || "");
  return r === "evm" ? TX.test(t) : r === "svm" ? SVM_SIG.test(t) : r === "avm" ? AVM_TX.test(t) : false;
};
const addrOk = (rail, a) => (rail === "evm" ? ADDR : rail === "svm" ? SVM_ADDR : AVM_ADDR).test(String(a || ""));
const assetOk = (rail, a) => (rail === "evm" ? ADDR : rail === "svm" ? SVM_ADDR : AVM_ASSET).test(String(a || ""));
/** Hex is case-insensitive and is lowercased; base58 and base32 ids are kept exactly. */
const txKeyOf = (network, tx) => (railOf(network) === "evm" ? String(tx).toLowerCase() : String(tx));

export const SETTLED_AFTER_402 = "settled_after_402";
/** The bound on OPEN (pending) entries. Unresolved entries wait for a human
 *  and never count toward it, so they cannot crowd out a new booking. */
export const MAX_ENTRIES = 2000;
/** The word reads near_capacity from this share of the bound. */
export const NEAR_CAPACITY_SHARE = 0.8;
/** How long the status word's read of the shared store is reused. */
export const STATUS_TTL_MS = 10_000;
/** How long an absent transaction is looked for before it is closed. */
export const WINDOW_MS = 60 * 60_000;
export const FIRST_CHECK_MS = 30_000;
export const MAX_BACKOFF_MS = 10 * 60_000;
// The most open entries one EVM payer may hold, per network, from settle
// chains that ended unconfirmed (src/payments.js markUnconfirmedStop). Past
// it a new one is kept in the journal (a record that lands once the payer's
// open entries fall under the bound; the word reads unresolved only once it
// has waited JOURNAL_PAGE_AFTER_MS) and a log line names it (one per payer per
// HELD_LOG_EVERY_MS, with the count since): never dropped in silence. The book's own bound
// (MAX_ENTRIES) covers everything else.
export const UNCONFIRMED_PER_PAYER_MAX = Number(process.env.LATE_SETTLE_UNCONFIRMED_PER_PAYER_MAX) > 0 ? Math.floor(Number(process.env.LATE_SETTLE_UNCONFIRMED_PER_PAYER_MAX)) : 25;
/** The most bookings one reconcile pass tries to land from the journal; the
 *  rest wait for the next pass. A booking held by its payer's bound is kept
 *  without a store read once that payer is seen at its bound in the pass. */
export const DRAIN_MAX_PER_PASS = 50;
/** A payer's per-payer-bound log line is written at most this often; the
 *  line names how many were held since the last one. */
export const HELD_LOG_EVERY_MS = 60_000;
/** Bookings held by their payer's bound read as unresolved on the status
 *  word only once the oldest has waited this long or there are this many:
 *  each lands on its own once one of its payer's open entries closes. */
export const JOURNAL_PAGE_AFTER_MS = 60 * 60_000;
export const JOURNAL_PAGE_SIZE = 500;
/** An entry whose absence is never proven becomes unresolved after this. */
export const MAX_AGE_MS = 24 * 3600_000;
/** Consecutive passes whose handling of one entry threw. */
export const FAILURE_LIMIT = 12;
/** Worst-case pass length; the reconcile lease must outlast it. */
export const MAX_PASS_MS = 60_000;
/** The lease: the pass budget, plus one RPC read that started inside it, plus margin. */
export const RECONCILE_LEASE_MS = MAX_PASS_MS + 60_000;
const RPC_TIMEOUT_MS = 8_000;
/** An unresolved entry is read on chain again this often (a slow cadence), so
 *  one that later shows as settled, reverted or absent resolves itself. */
export const UNRESOLVED_RECHECK_MS = 6 * 3600_000;
/** At most this many unresolved entries are re-read per pass. */
export const UNRESOLVED_RECHECK_PER_PASS = 5;
/** A booking recorded nowhere reads `unresolved` for this long after it
 *  happened, unless an operator acknowledges it first. */
export const UNRECORDED_WINDOW_MS = 24 * 3600_000;
// Most unrecorded-booking times the resolutions document keeps.
const UNRECORDED_KEPT = 200;
/** How many operator resolutions the resolution record keeps. */
export const RESOLUTIONS_KEPT = 500;
/** What an operator may resolve an unresolved entry as. */
export const OPERATOR_OUTCOMES = Object.freeze(["booked_owed", "paid", "dismissed"]);
const KEY_RE = /^(?:eip155:[0-9]{1,12}\|(?:0x[0-9a-f]{64}|auth\|0x[0-9a-f]{40}\|0x[0-9a-f]{64})|solana:[-_a-zA-Z0-9]{1,64}\|[1-9A-HJ-NP-Za-km-z]{64,88}|algorand:[-_a-zA-Z0-9=+/]{1,64}\|[A-Z2-7]{52})$/;

const SLUG_RE = /^[a-z0-9][a-z0-9._/-]{0,119}$/i;

/** The catalog slug of a connector x402 twin's payment
 *  (src/mcp-x402-routes.js), or null: read from the request the twin gate
 *  flagged, else, for a payment whose resource is the connector itself, from
 *  the MCP tool name its discovery extension carries. A twin's resource URL
 *  is `${BASE_URL}/mcp`, which names no tool. */
export function lateSlugOfTwin(ctx) {
  try {
    const twin = x402McpEntryOf(ctx?.transportContext?.request?.adapter?.req);
    if (twin) return twin.slug;
    const url = ctx?.paymentPayload?.resource?.url;
    if (typeof url !== "string" || new URL(url).pathname.replace(/\/+$/, "") !== "/mcp") return null;
    return mcpX402SlugOfToolName(ctx?.paymentPayload?.extensions?.bazaar?.info?.input?.toolName);
  } catch { return null; }
}

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

export const lateKey = (network, tx) => `${String(network)}|${txKeyOf(network, tx)}`;
/** An entry booked by AUTHORIZATION (no transaction known yet): the one an
 *  ambiguous facilitator failure leaves (src/robinhood-outage.js). */
export const lateAuthKey = (network, payer, nonce) => `${String(network)}|auth|${String(payer).toLowerCase()}|${String(nonce).toLowerCase()}`;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
// How far back an authorization-keyed entry looks for the transaction that
// used it: before its booking, since the facilitator may have broadcast first.
const AUTH_LOOKBACK_MS = 10 * 60_000;

/** How a log line names an entry: its transaction, or its authorization. */
// A log line names the payer by its first characters; the row keeps it whole.
const labelOf = (e) => (e.tx ? `tx ${e.tx}` : `auth ${shortPayer(e.payer)}/${e.nonce}`);
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
      ...(lateSlugOfTwin(ctx) ? { slug: lateSlugOfTwin(ctx) } : {}),
      ...(ctx?.__a402UnconfirmedStop ? { unconfirmed: true } : {}),
    };
  }
  if (!txOk(req.network, tx)) return null;
  // The EIP-3009 nonce (an exact payment), read before a transaction never
  // found is closed: another transaction may have used the authorization.
  const nonce = railOf(req.network) === "evm" && ctx?.paymentPayload?.payload?.authorization && NONCE.test(String(auth.nonce || "")) ? String(auth.nonce).toLowerCase() : null;
  return {
    network: String(req.network || ""),
    tx,
    ...(nonce ? { nonce } : {}),
    payer: String(auth.from || ctx?.error?.payer || ""),
    payTo: String(req.payTo || ""),
    asset: String(req.asset || ""),
    amount: String(req.amount ?? ""),
    resource: ctx?.paymentPayload?.resource?.url || null,
    ...(lateSlugOfTwin(ctx) ? { slug: lateSlugOfTwin(ctx) } : {}),
    validBefore: validBeforeOf(auth.validBefore ?? auth.deadline),
    // A payment our relayer settled first (the facilitator read dry) named
    // its transaction as the primary's answer: the entry says whose it is.
    via: ctx?.__a402LateTx?.via || (ownFirstAttemptOf(ctx?.paymentPayload, req.network) ? "own relayer" : "primary"),
    ...(ctx?.__a402UnconfirmedStop ? { unconfirmed: true } : {}),
  };
}

/**
 * Every entry a settle failure leaves: the one lateSettleCandidate names, and
 * each other pending transaction noted for the payment (src/pending-settle.js).
 * Entries from noted pending answers carry the authorization's nonce. Each
 * other noted transaction is booked under the facilitator that answered it
 * (the note's label), never under the one that stopped the chain.
 */
export function lateSettleCandidates(ctx) {
  const out = [];
  const c = lateSettleCandidate(ctx);
  let noted = [];
  try { noted = ctx?.__a402LateAuth ? [] : pendingNotedTxsFor(ctx); } catch { noted = []; }
  const nonce = String(ctx?.paymentPayload?.payload?.authorization?.nonce || "");
  const pin = (e) => (noted.includes(String(e.tx || "").toLowerCase()) && NONCE.test(nonce) ? { ...e, authNonce: nonce.toLowerCase() } : e);
  if (c) out.push(pin(c));
  let viaOf = new Map();
  try { viaOf = new Map(peekPendingAnswers(ctx?.paymentPayload).filter((n) => n?.tx && n.via).map((n) => [n.tx, n.via])); } catch { /* labels only */ }
  for (const tx of noted) {
    if (out.some((e) => String(e.tx || "").toLowerCase() === tx)) continue;
    const base = lateSettleCandidate({ ...ctx, error: { transaction: tx }, __a402LateTx: null });
    if (base) out.push(pin({ ...base, tx, ...(viaOf.has(tx) ? { via: viaOf.get(tx) } : {}) }));
  }
  return out;
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
  // Solana RPCs and Algorand indexers the rail reads use.
  svmRpcs = SOLANA_RPCS,
  avmIndexers = ALGORAND_INDEXERS,
  now = () => Date.now(),
  log = console.warn,
  maxEntries = MAX_ENTRIES,
  unconfirmedPerPayerMax = UNCONFIRMED_PER_PAYER_MAX,
  // Where a booking whose store write failed is kept until it lands: the
  // money journals' dead-letter (local disk, or Redis with
  // LEDGER_JOURNAL_REDIS=on), built on first use.
  journal = null,
  // Where a booking held by its payer's bound waits (see heldJournalOf).
  heldJournal = null,
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
  // `fn` returns SKIP_UPDATE when it changed nothing: nothing is written.
  const change = async (fn) => {
    if (!PG) {
      await refresh();
      const next = { pending: { ...state.pending } };
      if (fn(next.pending) === SKIP_UPDATE) return true;
      if (!(await doc.save(next))) return false;
      state = next;
      return true;
    }
    const r = await doc.update((b) => {
      const pending = { ...((b && typeof b === "object" && b.pending) || {}) };
      if (fn(pending) === SKIP_UPDATE) return SKIP_UPDATE;
      return { pending };
    }, { fallback: null });
    if (r.ok) absorb(r.body);
    return !!r.ok;
  };
  const entries = () => Object.values(state.pending);
  const openCount = (pending = state.pending) => Object.values(pending).filter((e) => e?.state !== "unresolved").length;
  // Bookings neither the store nor the journal took, in this process (the
  // alarm line names each one): when each happened. The word reads
  // unresolved while one is inside UNRECORDED_WINDOW_MS and not acknowledged.
  let unrecordedAt = [];
  const unrecordedRecent = () => {
    const cut = now() - UNRECORDED_WINDOW_MS;
    unrecordedAt = unrecordedAt.filter((t) => t > cut);
    return unrecordedAt.length;
  };
  // Every operator resolution, kept in its own document (the book's body is
  // { pending } only, so an older build's writes never drop the record).
  const resolutionsDoc = createJsonDocument({ name: "late-settlements-resolutions", file: `${file}.resolutions.json`, log: () => {} });
  const resolutionsReady = resolutionsDoc.backend === "pg" ? resolutionsDoc.load(null).catch(() => null) : Promise.resolve();
  const recordResolution = async (row, { clearUnrecorded = false } = {}) => {
    await resolutionsReady;
    const r = await resolutionsDoc.update((b) => {
      const body = b && typeof b === "object" ? b : {};
      const list = Array.isArray(body.resolutions) ? body.resolutions : [];
      return { ...body, resolutions: [...list, row].slice(-RESOLUTIONS_KEPT), ...(clearUnrecorded ? { unrecorded: [] } : {}) };
    }, { fallback: null });
    return !!r?.ok;
  };
  // An unrecorded booking's time is also written to the resolutions document,
  // so the word outlives a restart or deploy. When it fires the store is
  // usually refusing too, so a write that did not land is retried on the next
  // status read; until it lands, this process's memory holds it.
  let unrecordedUnsaved = false;
  const saveUnrecorded = async () => {
    try {
      await resolutionsReady;
      const cut = now() - UNRECORDED_WINDOW_MS;
      const mine = unrecordedAt.slice();
      const r = await resolutionsDoc.update((b) => {
        const body = b && typeof b === "object" ? b : {};
        const had = Array.isArray(body.unrecorded) ? body.unrecorded : [];
        const merged = [...new Set([...had, ...mine].map(Number))].filter((t) => Number.isFinite(t) && t > cut).sort((x, y) => x - y).slice(-UNRECORDED_KEPT);
        return { ...body, unrecorded: merged };
      }, { fallback: null });
      unrecordedUnsaved = !r?.ok;
    } catch { unrecordedUnsaved = true; }
  };
  const savedUnrecordedRecent = async () => {
    try {
      await resolutionsReady;
      const b = resolutionsDoc.backend === "pg" ? await resolutionsDoc.load(null) : resolutionsDoc.loadSync(null);
      const cut = now() - UNRECORDED_WINDOW_MS;
      return (Array.isArray(b?.unrecorded) ? b.unrecorded : []).filter((t) => Number(t) > cut).length;
    } catch { return 0; }
  };
  const readResolutions = async () => {
    try {
      await resolutionsReady;
      const b = resolutionsDoc.backend === "pg" ? await resolutionsDoc.load(null) : resolutionsDoc.loadSync(null);
      return Array.isArray(b?.resolutions) ? b.resolutions : [];
    } catch { return []; }
  };
  let wordCache = { at: 0, word: null };
  // Per payer: when its per-payer-bound line was last written, and how many
  // bookings were held since (bounded; the oldest payer goes first).
  const heldLog = new Map();
  const HELD_LOG_KEYS = 1000;
  let journalImpl = journal;
  const journalOf = async () => {
    if (journalImpl) return journalImpl;
    const { createDeadLetter } = await import("./ledger-mirror.js");
    const { stateDbSchema } = await import("./state-db.js");
    journalImpl = createDeadLetter({ file: `${file}.pending.ndjson`, name: "lateSettlements", journalKey: PG ? `${stateDbSchema()}:lateSettlements` : "" });
    return journalImpl;
  };
  // Bookings held by their payer's bound wait in a journal of their own: they
  // land by themselves once one of the payer's open entries closes, so they
  // are not a write that failed. Unnamed, so the money journals' dead-letter
  // word never reads them; the book's own word reads them only once they
  // have waited JOURNAL_PAGE_AFTER_MS or reach JOURNAL_PAGE_SIZE.
  let heldImpl = heldJournal;
  const heldJournalOf = async () => {
    if (heldImpl) return heldImpl;
    const { createDeadLetter } = await import("./ledger-mirror.js");
    const { stateDbSchema } = await import("./state-db.js");
    heldImpl = createDeadLetter({ file: `${file}.held.ndjson`, journalKey: PG ? `${stateDbSchema()}:lateSettlementsHeld` : "" });
    return heldImpl;
  };
  // An EVM payer's open entries from unconfirmed settle chains on one
  // network (an EVM address compares without case; the bound is EVM-only).
  const unconfirmedOf = (p, entry) => {
    const who = String(entry.payer || "").toLowerCase();
    return Object.values(p).filter((e) => e?.unconfirmed === true && e.state !== "unresolved" && e.network === entry.network && String(e.payer || "").toLowerCase() === who).length;
  };
  // One entry into the store: "made" (or already there), "full" (the open
  // bound is reached), "payer_full" (this payer's bound on unconfirmed
  // entries is reached), or "failed" (the write did not land).
  const put = async (entry) => {
    let out = "failed";
    let wrote = false;
    try {
      wrote = await change((p) => {
        if (p[entry.key]) { out = "made"; return SKIP_UPDATE; }
        if (entry.unconfirmed === true && railOf(entry.network) === "evm" && unconfirmedOf(p, entry) >= unconfirmedPerPayerMax) { out = "payer_full"; return SKIP_UPDATE; }
        if (openCount(p) >= maxEntries) { out = "full"; return SKIP_UPDATE; }
        p[entry.key] = entry;
        out = "made";
      });
    } catch { wrote = false; }
    if (out === "full" || out === "payer_full") return out;
    return out === "made" && wrote === true ? "made" : "failed";
  };
  const stateOf = (j) => {
    const st = typeof j?.state === "function" ? j.state() : null;
    return { total: Number(st?.total ?? (typeof j?.size === "function" ? j.size() : 0)) || 0, oldestAt: st?.oldestAt ?? null };
  };
  const journalCount = async () => stateOf(await journalOf()).total;
  const heldCount = async () => stateOf(await heldJournalOf()).total;
  // Lands what the journal holds (a booking whose store write failed earlier,
  // in this process or one that has since stopped).
  // A record held back by its payer's bound stays until that payer's open
  // entries fall under it; the others behind it still land. Once a payer is
  // seen at its bound in a pass, its other held records are kept without a
  // store read, and a pass tries at most DRAIN_MAX_PER_PASS records: the
  // rest wait for the next pass.
  let heldSummaryAt = 0;
  const drainJournal = async () => {
    let landed = 0;
    try {
      const j = await journalOf();
      if (j && j.size?.() > 0) landed += await drainOne(j, { summary: false });
    } catch { /* the next pass */ }
    try {
      const h = await heldJournalOf();
      if (h && h.size?.() > 0) landed += await drainOne(h, { summary: true });
    } catch { /* the next pass */ }
    return landed;
  };
  const drainOne = async (j, { summary }) => {
    const atBound = new Set();
    let tried = 0, held = 0;
    const payerKey = (e) => `${e.network}\n${String(e.payer || "").toLowerCase()}`;
    let landed = 0;
    try {
      landed = await j.drain(async (e) => {
        if (!e?.payload?.key) return "drop";
        if (e.payload.unconfirmed === true && atBound.has(payerKey(e.payload))) { held++; return "keep"; }
        if (tried >= DRAIN_MAX_PER_PASS) return "stop";
        tried++;
        const r = await put(e.payload);
        if (r === "payer_full") { atBound.add(payerKey(e.payload)); held++; return "keep"; }
        return r === "made" ? "landed" : "stop";
      });
    } catch { return 0; }
    if (summary && held > 0 && now() - heldSummaryAt >= HELD_LOG_EVERY_MS) {
      heldSummaryAt = now();
      log(`[late-settle] ${held} booking(s) wait in the journal behind ${atBound.size} payer(s) at the per-payer bound; each lands once one of that payer's open entries closes`);
    }
    return landed;
  };
  const call = (url, method, params) => rpc(url, method, params, fetchImpl, RPC_TIMEOUT_MS, []);

  return {
    ready,
    refresh,
    /** Book one failed settlement that names a transaction. Answers whether
     *  it is booked (or already was). */
    async book(c = {}) {
      const network = String(c.network || "");
      const rail = railOf(network);
      if (!rail || network === TEMPO_NETWORK) {
        log(`[late-settle] ${network || "unknown network"} settlement ${c.tx || ""} failed naming a transaction; no receipt reader for this network, not booked`);
        return false;
      }
      if (rail === "evm" && !rpcFor(network)) {
        log(`[late-settle] ${network} settlement ${c.tx} failed naming a transaction; no RPC configured, not booked`);
        return false;
      }
      const byAuth = rail === "evm" && !c.tx && NONCE.test(String(c.nonce || ""));
      if ((!byAuth && !txOk(network, c.tx)) || !addrOk(rail, c.payer) || !addrOk(rail, c.payTo) || !assetOk(rail, c.asset) || !/^[0-9]{1,30}$/.test(String(c.amount || ""))) return false;
      const key = byAuth ? lateAuthKey(network, c.payer, c.nonce) : lateKey(network, c.tx);
      await refresh();
      if (state.pending[key]) return true;
      const t = now();
      // What proves a rail transaction can no longer land: its recent
      // blockhash (Solana) or its lastValid round (Algorand).
      const lastValid = rail === "avm" && /^[0-9]{1,15}$/.test(String(c.lastValid ?? "")) ? Number(c.lastValid) : null;
      const blockhash = rail === "svm" && SVM_ADDR.test(String(c.blockhash || "")) ? String(c.blockhash) : null;
      const entry = {
        key, network, tx: byAuth ? null : txKeyOf(network, c.tx), ...(byAuth ? { nonce: String(c.nonce).toLowerCase() } : {}),
        ...(!byAuth && rail === "evm" && NONCE.test(String(c.nonce || "")) ? { nonce: String(c.nonce).toLowerCase() } : {}),
        ...(lastValid != null ? { lastValid } : {}), ...(blockhash ? { blockhash } : {}),
        payer: String(c.payer), payTo: String(c.payTo), asset: String(c.asset),
        amount: String(c.amount), validBefore: validBeforeOf(c.validBefore), slug: typeof c.slug === "string" && SLUG_RE.test(c.slug) ? c.slug : slugOf(c.resource), via: String(c.via || "primary").slice(0, 60),
        ...(!byAuth && NONCE.test(String(c.authNonce || "")) ? { authNonce: String(c.authNonce).toLowerCase() } : {}),
        ...(c.unconfirmed === true ? { unconfirmed: true } : {}),
        at: t, nextCheckAt: t + FIRST_CHECK_MS, checks: 0, unreadable: 0, failures: 0, state: "pending",
      };
      const r = await put(entry);
      if (r === "made") {
        log(byAuth
          ? `[late-settle] ${network} authorization ${shortPayer(c.payer)} nonce ${c.nonce} (via ${entry.via}): outcome unknown; booked until it is read on chain`
          : `[late-settle] ${network} settlement failed naming tx ${c.tx} (via ${entry.via}); booked until its receipt is read`);
        return true;
      }
      // The store did not take it (its write failed, or the open bound is
      // reached): kept in the journal and landed by a later reconcile pass
      // once the store takes it, never dropped in silence.
      wordCache = { at: 0, word: null };
      let id = null;
      if (r === "payer_full") { try { const h = await heldJournalOf(); id = h ? h.add("late", entry) : null; } catch { id = null; } }
      if (id == null) { try { const j = await journalOf(); id = j ? j.add("late", entry) : null; } catch { id = null; } }
      if (id == null) {
        unrecordedAt.push(now());
        unrecordedUnsaved = true;
        saveUnrecorded().catch(() => {});
        alarm(`[late-settle] ${network} ${byAuth ? `auth ${c.payer}/${c.nonce}` : `tx ${c.tx}`} failed and could NOT be recorded (store and journal both refused); if it lands the buyer is owed ${entry.amount} of ${entry.asset} from ${entry.payer}`);
        return false;
      }
      if (r === "payer_full") {
        // One line per payer per HELD_LOG_EVERY_MS, naming how many were
        // held since its last line.
        const hk = `${network}\n${String(c.payer || "").toLowerCase()}`;
        const h = heldLog.get(hk) || { at: -Infinity, since: 0 };
        h.since++;
        if (now() - h.at >= HELD_LOG_EVERY_MS) {
          alarm(`[late-settle] ${network} payer ${shortPayer(c.payer)} holds ${unconfirmedPerPayerMax} open unconfirmed settlements (the per-payer bound); ${h.since} booking(s) kept in the journal since the last line, the latest ${byAuth ? `auth ${shortPayer(c.payer)}/${c.nonce}` : `tx ${c.tx}`} (via ${entry.via}); each lands once one of them closes`);
          h.at = now(); h.since = 0;
        }
        heldLog.delete(hk); heldLog.set(hk, h);
        while (heldLog.size > HELD_LOG_KEYS) heldLog.delete(heldLog.keys().next().value);
        return true;
      }
      log(r === "full"
        ? `[late-settle] book is full (${maxEntries} open); ${network} ${byAuth ? `auth ${shortPayer(c.payer)}/${c.nonce}` : `tx ${c.tx}`} (via ${entry.via}) kept in the journal until there is room`
        : `[late-settle] ${network} ${byAuth ? `auth ${shortPayer(c.payer)}/${c.nonce}` : `tx ${c.tx}`} (via ${entry.via}): the store write failed; kept in the journal until the next reconcile lands it`);
      return true;
    },
    /** The entries as last read; call refresh() first for the shared view. */
    list() { return entries(); },
    /**
     * One word for /api/gateway-status, read from the shared store (reused
     * for STATUS_TTL_MS): full (the open bound is reached, so new bookings
     * wait in the journal), unresolved (an entry waits for a human, a booking
     * sits in the journal outside the book, a booking held by its payer's
     * bound has waited JOURNAL_PAGE_AFTER_MS or JOURNAL_PAGE_SIZE of them do,
     * or one could not be recorded
     * anywhere), near_capacity, or ok. Never a number.
     */
    async alarmStatus({ ttlMs = STATUS_TTL_MS } = {}) {
      const t = now();
      if (wordCache.word && t - wordCache.at < ttlMs) return wordCache.word;
      await refresh();
      const open = openCount();
      // A booking whose store write failed reads unresolved at once. One
      // held by its payer's bound lands on its own, so the held journal
      // reads unresolved only once its oldest has waited
      // JOURNAL_PAGE_AFTER_MS or it holds JOURNAL_PAGE_SIZE; an unreadable
      // one reads as waiting too long.
      let journaled = 0;
      try { journaled = await journalCount(); } catch { journaled = 1; }
      let heldStuck = false;
      try {
        const { total, oldestAt } = stateOf(await heldJournalOf());
        const oldest = Number(oldestAt);
        heldStuck = total > 0 && (total >= JOURNAL_PAGE_SIZE || oldestAt == null || !Number.isFinite(oldest) || t - oldest >= JOURNAL_PAGE_AFTER_MS);
      } catch { heldStuck = true; }
      let word = "ok";
      if (unrecordedUnsaved && unrecordedRecent() > 0) await saveUnrecorded();
      const unrecorded = Math.max(unrecordedRecent(), await savedUnrecordedRecent());
      if (open >= maxEntries) word = "full";
      else if (unrecorded > 0 || journaled > 0 || heldStuck || entries().some((e) => e.state === "unresolved")) word = "unresolved";
      else if (open >= Math.ceil(maxEntries * NEAR_CAPACITY_SHARE)) word = "near_capacity";
      wordCache = { at: t, word };
      return word;
    },
    /** Operator view from the shared store: every open entry, no amounts. */
    async operatorView() {
      await refresh();
      const all = entries();
      let journaled = null;
      try { journaled = await journalCount(); } catch { journaled = null; }
      let held = null;
      try { held = await heldCount(); } catch { held = null; }
      return {
        status: await this.alarmStatus({ ttlMs: 0 }),
        total: all.length,
        bound: maxEntries,
        unresolved: all.filter((e) => e.state === "unresolved").length,
        journaled,
        held,
        unrecordedInMemory: unrecordedRecent(),
        open: all.map((e) => ({ key: e.key, network: e.network, tx: e.tx, slug: e.slug, via: e.via, state: e.state, at: e.at, checks: e.checks, ...(e.state === "unresolved" ? { unresolvedAt: e.unresolvedAt ?? null, recheckAt: e.recheckAt ?? null } : {}) })),
        // The latest operator resolutions (no amounts), newest last.
        resolutions: (await readResolutions()).slice(-20).map((r) => ({ key: r.key, outcome: r.outcome, tx: r.tx ?? null, note: r.note, at: r.at })),
        resolve: 'POST /__operator/late-settlements {"action":"resolve","key":"<open[].key>","outcome":"booked_owed"|"paid"|"dismissed","note":"what was checked","tx":"0x... (paid: the refund transfer; booked_owed: the landed transfer when the entry names none)"} or {"action":"acknowledge_unrecorded","note":"..."}',
      };
    },
    /**
     * An operator resolves an UNRESOLVED entry, with a note saying what was
     * checked: booked_owed (the transfer landed: the debt is written to the
     * refund ledger, keyed by the transfer, and the entry closes only once
     * the ledger holds it), paid (the buyer was already repaid: `tx` is the
     * refund transfer), or dismissed (nothing moved to us). Every resolution
     * is written to the resolution record before the entry is dropped, and
     * logged. A pending entry is the reconcile pass's, never an operator's.
     */
    async resolve(key, { outcome, note, tx = null, decimals = null } = {}) {
      if (typeof note !== "string" || !note.trim()) return { ok: false, error: "a note saying what was checked is required" };
      if (!OPERATOR_OUTCOMES.includes(outcome)) return { ok: false, error: `outcome must be ${OPERATOR_OUTCOMES.join(", ")}` };
      const k = String(key || "");
      await refresh();
      const e = KEY_RE.test(k) && Object.hasOwn(state.pending, k) ? state.pending[k] : null;
      if (!e) return { ok: false, error: "no such entry" };
      if (e.state !== "unresolved") return { ok: false, error: "the entry is still pending: the reconcile pass resolves it" };
      const given = tx == null || tx === "" ? null : txKeyOf(e.network, String(tx).trim());
      if (given != null && !txOk(e.network, given)) return { ok: false, error: "tx must be a transaction id in the network's own format (0x-prefixed 32-byte hash on EVM)" };
      if (outcome === "paid" && !given) return { ok: false, error: "paid needs tx: the refund transfer" };
      let evidence = null;
      if (outcome === "booked_owed") {
        evidence = e.tx || given;
        if (!evidence) return { ok: false, error: "booked_owed needs tx: the transfer that landed (the entry names none)" };
        let dec = decimals == null || decimals === "" ? null : Number(decimals);
        if (dec != null && !(Number.isInteger(dec) && dec >= 0 && dec <= 36)) return { ok: false, error: "decimals must be an integer from 0 to 36" };
        if (dec == null && railOf(e.network) !== "evm") return { ok: false, error: "pass decimals for a transfer on this network" };
        if (dec == null) {
          try {
            const url = rpcFor(e.network);
            dec = Number(BigInt(await call(url, "eth_call", [{ to: e.asset, data: "0x313ce567" }, "latest"]) || "0x0"));
          } catch { dec = null; }
          if (!(Number.isInteger(dec) && dec >= 0 && dec <= 36)) return { ok: false, error: "the token's decimals could not be read; pass decimals" };
        }
        await recordOwed({
          slug: e.slug, network: e.network, payer: e.payer, priceUsd: Number(e.amount) / 10 ** dec,
          tx: evidence, httpStatus: 402, wire: "x402",
          note: `${SETTLED_AFTER_402}: booked by an operator: ${note.trim().slice(0, 120)}`,
        });
        if (!(await owedRecorded(evidence).catch(() => false))) return { ok: false, error: "the refund ledger did not take the debt; the entry is kept" };
      }
      const row = { key: e.key, network: e.network, tx: outcome === "paid" ? given : evidence || e.tx || null, outcome, note: note.trim().slice(0, 300), at: now() };
      if (!(await recordResolution(row).catch(() => false))) return { ok: false, error: "the resolution could not be recorded; the entry is kept" };
      let dropped = false;
      try { dropped = await change((p) => { if (p[e.key]?.state === "unresolved") delete p[e.key]; }); } catch { dropped = false; }
      if (!dropped) return { ok: false, error: "the book could not be written; the entry is kept" };
      wordCache = { at: 0, word: null };
      log(`[late-settle] operator resolved ${e.network} ${labelOf(e)} as ${outcome}: ${oneLine(row.note).slice(0, 200)}`);
      return { ok: true, key: e.key, outcome };
    },
    /** An operator acknowledges every unrecorded booking: this process's
     *  memory and the saved times every replica reads (each one was named in
     *  its alarm line); recorded like a resolution. */
    async acknowledgeUnrecorded({ note } = {}) {
      if (typeof note !== "string" || !note.trim()) return { ok: false, error: "a note saying what was checked is required" };
      const count = Math.max(unrecordedRecent(), await savedUnrecordedRecent());
      if (!(await recordResolution({ key: "unrecorded", network: null, tx: null, outcome: "acknowledged", note: note.trim().slice(0, 300), at: now() }, { clearUnrecorded: true }).catch(() => false))) return { ok: false, error: "the acknowledgement could not be recorded" };
      unrecordedAt = [];
      unrecordedUnsaved = false;
      wordCache = { at: 0, word: null };
      log(`[late-settle] operator acknowledged ${count} unrecorded booking(s): ${oneLine(note.trim()).slice(0, 200)}`);
      return { ok: true, acknowledged: count };
    },
    /**
     * One reconcile pass over the entries whose next check is due, oldest
     * first, at most maxChecks of them within maxPassMs. A throw while
     * handling one entry is counted and that entry backs off; the pass
     * continues with the next.
     */
    async reconcile({ maxChecks = 50, maxPassMs = MAX_PASS_MS } = {}) {
      const out = { checked: 0, owed: 0, served: 0, reverted: 0, notOurs: 0, absent: 0, pending: 0, unreadable: 0, unresolved: 0, rechecked: 0, errors: 0, journaled: 0 };
      out.journaled = await drainJournal();
      await refresh();
      const started = now();
      const due = entries()
        .filter((e) => e.state === "pending" && (e.nextCheckAt || 0) <= started)
        .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0) || a.at - b.at)
        .slice(0, maxChecks);
      // Unresolved entries are read again on a slow cadence, a few per pass,
      // so one that later shows as settled (or reverted, or absent) resolves
      // itself.
      const recheckAt = (e) => Number(e.recheckAt ?? (Number(e.unresolvedAt || e.at || 0) + UNRESOLVED_RECHECK_MS));
      const rechecks = entries()
        .filter((e) => e.state === "unresolved" && recheckAt(e) <= started)
        .sort((a, b) => recheckAt(a) - recheckAt(b))
        .slice(0, UNRESOLVED_RECHECK_PER_PASS);
      for (const e of [...due, ...rechecks]) {
        if (now() - started >= maxPassMs) break;
        out.checked++;
        try {
          await this._one(e, out);
        } catch {
          out.errors++;
          if (e.state === "unresolved") {
            try { await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], recheckAt: now() + UNRESOLVED_RECHECK_MS }; }); } catch { /* the next pass retries */ }
            continue;
          }
          const failures = (e.failures || 0) + 1;
          const stuck = failures >= FAILURE_LIMIT;
          try {
            await change((p) => {
              if (!p[e.key]) return;
              p[e.key] = { ...p[e.key], failures, nextCheckAt: now() + backoff(failures), ...(stuck ? { state: "unresolved", unresolvedAt: now(), recheckAt: now() + UNRESOLVED_RECHECK_MS } : {}) };
            });
          } catch { /* the store itself is failing: the next pass retries */ }
          if (stuck) { out.unresolved++; log(`[late-settle] ${e.network} ${labelOf(e)} unresolved after ${failures} failed passes; operator action needed`); }
        }
      }
      return out;
    },
    async _one(e0, out) {
      const rail = railOf(e0.network);
      if (rail === "svm" || rail === "avm") return this._oneRail(e0, out, rail);
      const url = rpcFor(e0.network);
      let e = e0;
      let receipt;
      let readable = true;
      // A used authorization is never closed as not landed, whatever this pass
      // could read of its transaction.
      let usedAuth = false;
      // Used means the transaction that used it is found and judged like any
      // other booked transaction (`e.tx` becomes that one).
      const readAuthorization = async () => {
        if (!url) throw new Error("no RPC");
        const c = (m, p) => call(url, m, p);
        if (!(await authorizationUsed(c, e.asset, e.payer, e.nonce))) return false;
        usedAuth = true;
        const { head, from } = await blockNear(c, e.at - AUTH_LOOKBACK_MS);
        const start = Number.isFinite(e.scanFrom) ? e.scanFrom : from;
        const f = await findAuthorizationTx(c, { token: e.asset, authorizer: e.payer, nonce: e.nonce, fromBlock: start, toBlock: head });
        if (f.tx) e = { ...e, tx: f.tx };
        else await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], scanFrom: f.scannedTo + 1 }; });
        return !!f.tx;
      };
      if (!e.tx && e.nonce) {
        // Booked by authorization: unused means nothing has landed (yet).
        try { await readAuthorization(); } catch { readable = false; }
      }
      if (readable && e.tx) {
        try { receipt = url ? await call(url, "eth_getTransactionReceipt", [e.tx]) : undefined; } catch { readable = false; }
      }
      // A booked transaction not found: its authorization may have been used
      // by another transaction (a rebroadcast, another facilitator's), so its
      // state is read before the entry can ever close as not landed.
      if (readable && url && !receipt && e0.tx && NONCE.test(String(e0.nonce || ""))) {
        try {
          if (await readAuthorization() && e.tx !== e0.tx) receipt = await call(url, "eth_getTransactionReceipt", [e.tx]);
        } catch { readable = false; }
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
        // One of several transactions noted for one authorization: only the
        // one that used it can be this payment's transfer.
        if (e.authNonce && !receiptUsesAuthorization(receipt, { asset: e.asset, payer: e.payer, nonce: e.authNonce })) {
          await drop();
          out.notOurs++;
          log(`[late-settle] ${e.network} tx ${e.tx} mined without using this payment's authorization; nothing owed`);
          return;
        }
        const moved = evmTransferredInReceipt(receipt, { token: e.asset, from: e.payer, toSet: [e.payTo] });
        if (moved < BigInt(e.amount) || moved === 0n) {
          await drop();
          out.notOurs++;
          log(`[late-settle] ${e.network} tx ${e.tx} mined without this payment's transfer (moved ${moved} of ${e.amount}); nothing owed`);
          return;
        }
        // decimals() is read, never assumed (src/payment-verify.js).
        await this._owe(e, out, async () => {
          const decimals = Number(BigInt(await call(url, "eth_call", [{ to: e.asset, data: "0x313ce567" }, "latest"]) || "0x0"));
          if (!Number.isFinite(decimals) || decimals > 36) throw new Error("token decimals unreadable");
          return decimals;
        });
        return;
      }
      // Absent can be closed only once the chain answered (this read) AND the
      // authorization can no longer move money: past the window and past its
      // validBefore, a transaction mined later reverts.
      const authExpired = authorizationExpired(e.validBefore, now());
      await this._notFound(e, out, { readable, canClose: authExpired && !usedAuth, why: "its authorization has expired" });
    },
    // A transaction the chain holds that is this payment's transfer: owed,
    // unless it was served after all. `decimalsOf()` reads the token's.
    async _owe(e, out, decimalsOf) {
      const drop = async () => change((p) => { delete p[e.key]; });
      if (await wasServed({ tx: e.tx, network: e.network, key: e.key })) {
        await drop();
        out.served++;
        return;
      }
      const decimals = await decimalsOf();
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
        await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], failures: 0, nextCheckAt: now() + FIRST_CHECK_MS, ...(p[e.key].state === "unresolved" ? { recheckAt: now() + FIRST_CHECK_MS } : {}) }; });
        out.pending++;
      }
    },
    // A transaction not found (or not readable) this pass: closed as not
    // landed only once the chain answered, the window has passed and
    // `canClose` (it can no longer land); otherwise kept with a backoff, and
    // past MAX_AGE_MS left unresolved for a human.
    async _notFound(e, out, { readable, canClose, why }) {
      const checks = e.checks + 1;
      const unreadable = readable ? e.unreadable : e.unreadable + 1;
      const t = now();
      if (t - e.at >= WINDOW_MS && readable && canClose) {
        await change((p) => { delete p[e.key]; });
        out.absent++;
        log(`[late-settle] ${e.network} ${labelOf(e)} never mined within ${Math.round(WINDOW_MS / 60_000)} min and ${why}; closed as not landed`);
        return;
      }
      if (e.state === "unresolved") {
        // A slow re-read of an unresolved entry that still proves nothing:
        // kept for a human, read again after UNRESOLVED_RECHECK_MS.
        await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], checks, unreadable, recheckAt: t + UNRESOLVED_RECHECK_MS }; });
        out.rechecked++;
        return;
      }
      if (t - e.at >= MAX_AGE_MS) {
        // Absence never proven (reads failing, or an authorization still
        // valid): kept for a human, never dropped.
        await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], checks, unreadable, state: "unresolved", unresolvedAt: t, recheckAt: t + UNRESOLVED_RECHECK_MS }; });
        out.unresolved++;
        log(`[late-settle] ${e.network} ${labelOf(e)} unresolved after ${checks} checks (${unreadable} unreadable); operator action needed`);
        return;
      }
      await change((p) => { if (p[e.key]) p[e.key] = { ...p[e.key], checks, unreadable, failures: 0, nextCheckAt: now() + backoff(checks) }; });
      if (readable) out.pending++; else out.unreadable++;
    },
    // A Solana or Algorand transaction, read by the rails' own verifier.
    async _oneRail(e, out, rail) {
      // Algorand: the indexer's 404 proves absence only up to the round it
      // has indexed, so every indexer's own round is read BEFORE the
      // transaction (a transfer indexed in between is then seen) and must be
      // past the entry's lastValid for the entry to close.
      let avmIndexedPast = false;
      if (rail === "avm" && now() - e.at >= WINDOW_MS) {
        try { avmIndexedPast = await indexersPast(e); } catch { avmIndexedPast = null; }
      }
      const v = await verifyInboundPayment({
        network: e.network, payer: e.payer, amountUsd: Number(e.amount) / 10 ** RAIL_USDC_DECIMALS, tx: e.tx,
        acceptsFor: () => ({ payTo: e.payTo, asset: e.asset }), payToSetFor: () => [e.payTo],
        solanaRpcs: svmRpcs, algorandIndexers: avmIndexers, fetchImpl, timeoutMs: RPC_TIMEOUT_MS,
      });
      const drop = async () => change((p) => { delete p[e.key]; });
      if (v.verified === true) {
        await this._owe(e, out, async () => {
          const d = Number(v.decimals);
          if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error("token decimals unreadable");
          return d;
        });
        return;
      }
      if (v.mined === true) {
        await drop();
        if (v.failedOnChain === true) out.reverted++; else out.notOurs++;
        log(`[late-settle] ${e.network} tx ${e.tx} ${v.failedOnChain === true ? "failed on chain; nothing moved" : `is not this payment's transfer (${String(v.reason || "").slice(0, 80)})`}; nothing owed`);
        return;
      }
      let readable = v.absent === true;
      let canClose = false;
      if (readable && now() - e.at >= WINDOW_MS) {
        if (rail === "avm") { if (avmIndexedPast === null) readable = false; else canClose = avmIndexedPast; }
        else { try { canClose = await railExpired(e); } catch { readable = false; } }
      }
      await this._notFound(e, out, { readable, canClose, why: rail === "svm" ? "its blockhash has expired" : "the indexers are past its last valid round" });
    },
  };
  // Can a Solana transaction no longer land? Throws when the chain cannot
  // be read. No blockhash known (a durable nonce, an unreadable payload)
  // means it may still land: never closed.
  async function railExpired(e) {
    if (!SVM_ADDR.test(String(e.blockhash || ""))) return false;
    let lastErr = null;
    for (const url of svmRpcs) {
      try {
        const r = await rpc(url, "isBlockhashValid", [e.blockhash, { commitment: "finalized" }], fetchImpl, RPC_TIMEOUT_MS, []);
        if (typeof r?.value === "boolean") return r.value === false;
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error("isBlockhashValid unreadable");
  }
  // Has every Algorand indexer indexed past the entry's lastValid round (a
  // transaction valid only up to it can no longer land, and is held by an
  // indexer that is past it)? No lastValid known: never. Throws when an
  // indexer's round cannot be read.
  async function indexersPast(e) {
    if (!Number.isSafeInteger(e.lastValid) || !avmIndexers.length) return false;
    for (const base of avmIndexers) {
      const res = await fetchImpl(`${String(base).replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`indexer health HTTP ${res.status}`);
      const round = Number((await res.json())?.round);
      if (!Number.isSafeInteger(round) || round <= 0) throw new Error("indexer round unreadable");
      if (round <= e.lastValid) return false;
    }
    return true;
  }
}

/**
 * What a Solana or Algorand candidate needs from the signed payment: its
 * payer (read from the payment itself, else the facilitator's answer), and
 * what proves it can no longer land (the recent blockhash, the lastValid
 * round). Unreadable parts are left out.
 */
async function withRailHints(c, ctx) {
  const rail = railOf(c.network);
  if (rail !== "svm" && rail !== "avm") return c;
  const payload = ctx?.paymentPayload;
  try {
    if (rail === "svm") {
      const { svmLifetimeBlockhash, svmPaymentAuthority } = await import("./svm-payer.js");
      const blockhash = svmLifetimeBlockhash(payload?.payload?.transaction);
      const payer = svmPaymentAuthority(payload, { feePayer: ctx?.requirements?.extra?.feePayer });
      return { ...c, ...(blockhash ? { blockhash } : {}), ...(payer ? { payer } : {}) };
    }
    const { lastValidFromPayload } = await import("./avm-validity.js");
    const { avmSender } = await import("./non-evm-payer.js");
    const lv = lastValidFromPayload(payload);
    const payer = await avmSender(payload);
    return { ...c, ...(lv != null ? { lastValid: String(lv) } : {}), ...(payer ? { payer } : {}) };
  } catch { return c; }
}

/**
 * Registered AFTER every settle-failure hook that can recover a payment
 * (src/payments.js), so it runs only when nothing settled it: a failure that
 * names a transaction is booked. `bookFor()` resolves the shared book.
 */
export function registerLateSettleHook(server, bookFor) {
  server.onSettleFailure(async (ctx) => {
    try {
      const all = lateSettleCandidates(ctx);
      if (!all.length) return;
      const b = await bookFor();
      // Whether anything was recorded rides on the context: an unconfirmed
      // answer promises a repayment record only then (src/payments.js).
      let booked = false;
      if (b) for (const c of all) { if ((await b.book(await withRailHints(c, ctx))) === true) booked = true; }
      if (ctx && typeof ctx === "object") ctx.__a402LateBooked = booked;
      // The notes have been booked: a later read of this payment starts clean.
      takePendingAnswers(ctx?.paymentPayload);
    } catch { /* booking never breaks the settle path */ }
  });
  return server;
}
