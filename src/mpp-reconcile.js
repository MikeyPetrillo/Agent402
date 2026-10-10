// Daily MPP reconciliation: what the chain says we were paid, against what
// our own books say we sold, against what we actually served.
//
// Three independent records exist for every MPP sale and nothing compared
// them: the on-chain transfer to our Tempo recipient, the sales-ledger row
// (src/sales-ledger.js, wire "mpp-tempo" / "mpp-tempo-subscription" / "mpp" /
// "mpp-stripe"), and the refund ledger's charged-but-failed debts
// (src/refund-ledger.js). Each one can drift from the others without any
// alarm firing today:
//
//   served_unpaid       a ledger row whose tx never reached our recipient on
//                       chain (we served and recorded a payment that did not
//                       land, or recorded the wrong hash)
//   paid_unrecorded     a transfer to our recipient with no ledger row (paid,
//                       and either not served or served and not booked)
//   charged_failed      settle succeeded, the response was non-200: a debt on
//                       the refund ledger (a transfer explained by one of
//                       these is reported here, not as paid_unrecorded)
//   amount_mismatch     matched, but the amount is under the booked price or
//                       over it by more than a documented network premium
//   wrong_currency      matched, but paid in a token we do not offer
//   duplicate_tx        one settlement hash booked on more than one row
//   missing_tx          an MPP row with no settlement reference at all
//   evm_unverified      an MPP evm-leg row (Base/Celo) whose recorded tx does
//                       not prove payer -> our payTo for the amount on chain
//   stripe_mismatch     an SPT row whose PaymentIntent is not succeeded or
//                       charged less than the booked price
//
// Informational, never a mismatch: `non_payment_transfer`, an unmatched
// inbound transfer above MPP_RECONCILE_NON_PAYMENT_USD (default $10) - larger
// than anything we sell per call over MPP, so a treasury movement rather than
// a lost sale - or BELOW the smallest price any route charges ($0.001, the
// settlement floor), which no purchase can have paid. The second bound came
// from 2026-09-28: a one-base-unit ($0.000001) transfer from an unknown sender
// kept the day "mismatch" as a paid-but-unrecorded sale for two days.
//
// Rules this module keeps:
//   * NEVER publishes a payer address. Ledger rows carry the payer only so the
//     EVM check can bind from == payer; nothing here copies it into a summary.
//     The public status (/api/gateway-status `mppReconcile`) is counts and
//     status words; the itemized mismatches (tx hash, slug, amount, category)
//     are operator-only.
//   * A source that could not be read is `unknown`, never `ok`. Checks that do
//     not depend on the unreadable source still run and can still say
//     `mismatch`.
//   * Day boundaries are soft: records are matched across the window plus a
//     margin, and an item is reported in the day its OWN timestamp falls in,
//     so a payment finishing across midnight is not two mismatches.
//   * Idempotent: re-running a day replaces that day's summary with the same
//     answer; nothing accumulates.
//   * Leaf module: every source is injected (server.js wires the real ones),
//     so the whole thing runs offline in scripts/test-mpp-reconcile.js.
import { createJsonDocument } from "./json-document.js";
import { trackStoreReady, leased } from "./state-db.js";

export const CATEGORIES = Object.freeze([
  "served_unpaid", "paid_unrecorded", "charged_failed", "amount_mismatch", "wrong_currency",
  "duplicate_tx", "missing_tx", "evm_unverified", "stripe_mismatch",
]);
export const INFO_CATEGORIES = Object.freeze(["non_payment_transfer"]);
// charged_failed is counted and itemized but does NOT make the day a
// mismatch: the refund ledger already holds the debt (the books agree), and
// it has its own live alarm (`chargedFailed24h`). Every other category is a
// disagreement between records.
export const MISMATCH_CATEGORIES = Object.freeze(CATEGORIES.filter((k) => k !== "charged_failed"));

const DAY_MS = 86_400_000;
const MATCH_MARGIN_MS = 60 * 60_000;         // look this far past each edge when matching
const EPS_USD = 0.000001;                    // one base unit of a 6-decimal stablecoin
const TEMPO_WIRES = new Set(["mpp-tempo", "mpp-tempo-subscription"]);
const TEMPO_NETWORKS = new Set(["tempo", "eip155:4217"]);
const MPP_WIRES = new Set(["mpp", "mpp-tempo", "mpp-stripe", "mpp-tempo-subscription"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RPC_CHUNK_BLOCKS = 99_000;             // rpc.tempo.xyz caps eth_getLogs at 100k blocks

const isTempoRow = (r) => TEMPO_WIRES.has(r.wire) || (r.wire === "mpp" && TEMPO_NETWORKS.has(String(r.network || "").toLowerCase()));
const normTx = (tx) => {
  const t = String(tx || "").trim();
  return /^0x[0-9a-fA-F]+$/.test(t) ? t.toLowerCase() : t; // EVM hashes case-fold; anything else stays exact
};
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayStartMs = (day) => Date.parse(`${day}T00:00:00.000Z`);

function emptyCounts() {
  const c = {};
  for (const k of [...CATEGORIES, ...INFO_CATEGORIES]) c[k] = { total: 0, internal: 0, external: 0, unattributed: 0 };
  return c;
}

/**
 * Pure reconciliation over already-fetched records. Exported for tests.
 *
 * ledgerRows:  sales-ledger MPP rows in [start - margin, end + margin)
 * transfers:   { complete, source, rows: [{ tx, token, amountAtomic, decimals, ts, recipient, sender }] } | null
 * refunds:     refund-ledger rows in [start - margin, end + margin)
 * evmChecks:   Map normTx -> { verified, reason, checked }
 * stripeChecks: { configured, results: Map tx -> { status, amountCents } | { error } }
 */
export function reconcileRecords({
  start, end, ledgerRows = [], transfers = null, refunds = [], evmChecks = new Map(), stripeChecks = { configured: false, results: new Map() },
  currencies = [], premiumUsd = 0, nonPaymentUsd = 10, minSaleUsd = 0.001, isOwnWallet = () => false,
} = {}) {
  const counts = emptyCounts();
  const mismatches = [];
  const info = [];
  const inDay = (ts) => ts >= start && ts < end;
  const side = (internal) => (internal === true ? "internal" : internal === false ? "external" : "unattributed");
  const add = (category, item, internal) => {
    const bucket = INFO_CATEGORIES.includes(category) ? info : mismatches;
    const c = counts[category];
    c.total += 1; c[side(internal)] += 1;
    bucket.push({ category, side: side(internal), ...item });
  };
  const currencySet = new Set(currencies.map((c) => String(c).toLowerCase()));

  // --- refund-ledger debts on an MPP wire (or a Tempo network) -----------
  const mppRefunds = refunds.filter((r) => MPP_WIRES.has(r.wire) || TEMPO_NETWORKS.has(String(r.network || "").toLowerCase()));
  const refundTx = new Set(mppRefunds.map((r) => normTx(r.evidence)));
  for (const r of mppRefunds) {
    if (!inDay(r.createdAt)) continue;
    add("charged_failed", {
      tx: /\|/.test(String(r.evidence)) ? null : String(r.evidence), slug: r.slug, amountUsd: round6(r.priceUsd), wire: r.wire || null,
      at: new Date(r.createdAt).toISOString(),
      explanation: `settle succeeded, response was HTTP ${r.httpStatus ?? "?"}; debt on the refund ledger (status ${r.status})`,
    }, r.synthetic ? true : false);
  }

  // --- ledger-internal checks (no chain needed) --------------------------
  const byTx = new Map();
  for (const r of ledgerRows) {
    if (!r.tx) {
      if (inDay(r.ts)) add("missing_tx", { tx: null, slug: r.slug, amountUsd: round6(r.priceUsd), wire: r.wire, at: new Date(r.ts).toISOString(), explanation: "MPP sale booked with no settlement reference" }, r.internal);
      continue;
    }
    const k = normTx(r.tx);
    (byTx.get(k) || byTx.set(k, []).get(k)).push(r);
  }
  for (const [tx, rows] of byTx) {
    if (rows.length < 2) continue;
    const first = rows[0];
    if (!rows.some((r) => inDay(r.ts))) continue;
    add("duplicate_tx", { tx, slug: first.slug, amountUsd: round6(first.priceUsd), wire: first.wire, at: new Date(first.ts).toISOString(), explanation: `one settlement booked on ${rows.length} ledger rows` }, first.internal);
  }

  // --- Tempo leg: ledger vs chain -----------------------------------------
  let tempoChecked = false;
  if (transfers && Array.isArray(transfers.rows)) {
    tempoChecked = !!transfers.complete;
    // Sum transfers per tx (one payment is one transfer; summing keeps an
    // odd multi-log transaction from reading as an underpayment).
    const chainByTx = new Map();
    for (const t of transfers.rows) {
      const k = normTx(t.tx);
      const dec = Number.isInteger(t.decimals) ? t.decimals : 6;
      let usd = 0;
      try { usd = Number(BigInt(String(t.amountAtomic ?? "0"))) / 10 ** dec; } catch { usd = 0; }
      const e = chainByTx.get(k) || { tx: k, usd: 0, tokens: new Set(), ts: t.ts, senders: new Set() };
      e.usd += usd; e.tokens.add(String(t.token || "").toLowerCase()); e.ts = Math.min(e.ts, t.ts);
      if (t.sender) e.senders.add(String(t.sender).toLowerCase());
      chainByTx.set(k, e);
    }
    const tempoRows = ledgerRows.filter((r) => r.tx && isTempoRow(r));
    const ledgerTempoTx = new Set(tempoRows.map((r) => normTx(r.tx)));
    // served_unpaid is only asserted from a COMPLETE read - a partial one
    // would report every row past the gap.
    if (transfers.complete) {
      for (const r of tempoRows) {
        const k = normTx(r.tx);
        if (chainByTx.has(k) || !inDay(r.ts)) continue;
        add("served_unpaid", { tx: r.tx, slug: r.slug, amountUsd: round6(r.priceUsd), wire: r.wire, at: new Date(r.ts).toISOString(), explanation: "booked as settled over Tempo, but no transfer in that transaction reached our recipient" }, r.internal);
      }
    }
    for (const [k, e] of chainByTx) {
      const rows = byTx.get(k);
      const row = rows?.find(isTempoRow);
      if (!row) {
        if (ledgerTempoTx.has(k) || !inDay(e.ts)) continue;
        const own = [...e.senders].some((s) => { try { return isOwnWallet(s); } catch { return false; } });
        const internal = own ? true : null;
        if (refundTx.has(k)) continue; // already reported as charged_failed
        const item = { tx: e.tx, slug: null, amountUsd: round6(e.usd), wire: "mpp-tempo", at: new Date(e.ts).toISOString() };
        if (e.usd > nonPaymentUsd) { add("non_payment_transfer", { ...item, explanation: `inbound transfer above $${nonPaymentUsd} with no ledger row - likely a treasury movement, not a sale` }, internal); continue; }
        if (e.usd + EPS_USD < minSaleUsd) { add("non_payment_transfer", { ...item, explanation: `inbound transfer below $${minSaleUsd}, the smallest price any route charges - no purchase paid this (a dust or test transfer)` }, internal); continue; }
        const offCurrency = currencySet.size && [...e.tokens].some((t) => !currencySet.has(t));
        add("paid_unrecorded", { ...item, explanation: `transfer to our recipient with no sales-ledger row (paid, then not served or not booked)${offCurrency ? "; also in a token we do not offer" : ""}` }, internal);
        continue;
      }
      if (!inDay(row.ts) && !inDay(e.ts)) continue;
      const tokens = [...e.tokens];
      if (currencySet.size && tokens.some((t) => !currencySet.has(t))) {
        add("wrong_currency", { tx: row.tx, slug: row.slug, amountUsd: round6(e.usd), wire: row.wire, at: new Date(row.ts).toISOString(), explanation: `paid in a token this server does not offer (${tokens.join(",")})` }, row.internal);
      }
      const lo = row.priceUsd;
      const hi = Math.max(row.priceUsd, Number(row.quoteUsd) || 0) + (Number(premiumUsd) || 0);
      if (e.usd + EPS_USD < lo) {
        add("amount_mismatch", { tx: row.tx, slug: row.slug, amountUsd: round6(e.usd), bookedUsd: round6(row.priceUsd), wire: row.wire, at: new Date(row.ts).toISOString(), explanation: `underpaid: on chain $${round6(e.usd)} against a booked $${round6(row.priceUsd)}` }, row.internal);
      } else if (e.usd - EPS_USD > hi) {
        add("amount_mismatch", { tx: row.tx, slug: row.slug, amountUsd: round6(e.usd), bookedUsd: round6(row.priceUsd), wire: row.wire, at: new Date(row.ts).toISOString(), explanation: `overpaid: on chain $${round6(e.usd)} against a booked $${round6(row.priceUsd)} (tolerance $${round6(hi)})` }, row.internal);
      }
    }
  }

  // --- MPP evm leg (Base/Celo): the recorded tx against the chain --------
  let evmChecked = 0, evmUnchecked = 0;
  for (const r of ledgerRows) {
    if (r.wire !== "mpp" || !r.tx || isTempoRow(r) || !inDay(r.ts)) continue;
    const v = evmChecks.get(normTx(r.tx));
    if (!v || !v.checked) { evmUnchecked++; continue; }
    evmChecked++;
    if (!v.verified) add("evm_unverified", { tx: r.tx, slug: r.slug, amountUsd: round6(r.priceUsd), wire: r.wire, network: r.network, at: new Date(r.ts).toISOString(), explanation: `recorded settlement does not verify on chain: ${String(v.reason || "").slice(0, 160)}` }, r.internal);
  }

  // --- Stripe SPT rows (read-only) ----------------------------------------
  let stripe = { checked: false, reason: "not checked (no Stripe key on this server)" };
  if (stripeChecks?.configured) {
    let ok = 0, unreadable = 0;
    for (const r of ledgerRows) {
      if (r.wire !== "mpp-stripe" || !inDay(r.ts)) continue;
      const res = r.tx ? stripeChecks.results.get(r.tx) : null;
      if (!res || res.error) { unreadable++; continue; }
      const want = Math.round(r.priceUsd * 100);
      if (res.status !== "succeeded" || !(Number(res.amountCents) >= want)) {
        add("stripe_mismatch", { tx: r.tx, slug: r.slug, amountUsd: round6(r.priceUsd), wire: r.wire, at: new Date(r.ts).toISOString(), explanation: `PaymentIntent ${res.status}, ${res.amountCents} cents against a booked ${want}` }, r.internal);
      } else ok++;
    }
    stripe = { checked: true, ok, unreadable };
  }

  const mismatchTotal = MISMATCH_CATEGORIES.reduce((a, k) => a + counts[k].total, 0);
  return {
    counts, mismatches, info, mismatchTotal,
    sources: {
      chain: transfers ? { source: transfers.source || null, complete: !!transfers.complete, transfers: transfers.rows?.length || 0, error: transfers.error || null } : { source: null, complete: false, error: "not read" },
      tempoChecked,
      ledgerRows: ledgerRows.filter((r) => inDay(r.ts)).length,
      evm: { checked: evmChecked, unchecked: evmUnchecked },
      stripe,
    },
  };
}

/** The status word for one day summary: mismatch beats unknown beats ok. */
export function statusWordFor(summary) {
  if (!summary) return "unknown";
  if (summary.mismatchTotal > 0) return "mismatch";
  const c = summary.sources?.chain;
  // No Tempo recipient configured means there is no Tempo leg to read.
  if (summary.tempoConfigured !== false && !(c && c.complete)) return "unknown";
  return "ok";
}

// ---------------------------------------------------------------------------
// Chain readers. Both return { complete, source, rows, error } and never throw.

/** Tempo data API (TEMPO_DATA_API_KEY): transfers filtered BY RECIPIENT and
 *  time window, cursor-paged. If the API ever returns a row for a different
 *  recipient the filter was ignored; that read is abandoned after one page
 *  (a token-wide sweep is not affordable here) and the caller falls back. */
export async function fetchTransfersFromFeed({ apiKey, recipients, fromMs, toMs, fetchImpl = fetch, baseUrl = (process.env.TEMPO_API_BASE_URL || "https://api.tempo.xyz"), maxPages = 200 } = {}) {
  const rows = [];
  if (!apiKey) return { complete: false, source: "feed", rows, error: "no data key" };
  for (const recipient of recipients) {
    const r = String(recipient).toLowerCase();
    const base = `${String(baseUrl).replace(/\/$/, "")}/v1/transfers?recipient=${encodeURIComponent(r)}&timestamp.from=${encodeURIComponent(new Date(fromMs).toISOString())}&timestamp.to=${encodeURIComponent(new Date(toMs).toISOString())}&limit=50&order=asc`;
    let cursor = null, pages = 0;
    for (;;) {
      if (pages >= maxPages) return { complete: false, source: "feed", rows, error: `page cap ${maxPages} reached` };
      let res, body;
      try {
        res = await fetchImpl(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base, { headers: { "tempo-api-key": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        body = await res.json();
      } catch (e) { return { complete: false, source: "feed", rows, error: `unreadable (${String(e?.name || "error")})` }; }
      if (!res.ok || !Array.isArray(body?.data)) return { complete: false, source: "feed", rows, error: `HTTP ${res.status}` };
      pages++;
      for (const t of body.data) {
        const rec = String(t?.recipient || "").toLowerCase();
        if (rec !== r) return { complete: false, source: "feed", rows, error: "recipient filter not honoured" };
        const amt = t.destinationAmount?.baseUnits ?? t.sourceAmount?.baseUnits ?? "0";
        const tok = t.destinationToken?.address || t.sourceToken?.address || "";
        const dec = Number.isInteger(t.destinationToken?.decimals) ? t.destinationToken.decimals : Number.isInteger(t.sourceToken?.decimals) ? t.sourceToken.decimals : 6;
        const ts = Date.parse(t.timestamp);
        if (!t.transactionHash || !Number.isFinite(ts)) continue;
        rows.push({ tx: t.transactionHash, token: tok, amountAtomic: String(amt), decimals: dec, ts, recipient: rec, sender: t.sender || null });
      }
      cursor = body.nextCursor || null;
      if (!cursor || body.data.length === 0) break;
    }
  }
  return { complete: true, source: "feed", rows, error: null };
}

/** RPC fallback: Transfer logs with topics[2] = recipient and NO token filter
 *  (so a payment in a token we do not offer is still seen), chunked under the
 *  node's 100k-block cap. Block range from a timestamp binary search; a log's
 *  time is its own `blockTimestamp` when the node sends one, else linearly
 *  interpolated between the two anchor blocks (used only for day assignment,
 *  which already carries a margin). */
export async function fetchTransfersFromRpc({ rpcFn, recipients, fromMs, toMs, chunk = RPC_CHUNK_BLOCKS } = {}) {
  const rows = [];
  try {
    const hexN = (h) => parseInt(String(h), 16);
    const blockTs = async (n) => {
      const b = await rpcFn("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
      return hexN(b?.timestamp) * 1000;
    };
    const latest = hexN(await rpcFn("eth_blockNumber", []));
    const latestTs = await blockTs(latest);
    const findBlock = async (ms) => {
      if (ms >= latestTs) return latest;
      let lo = 0, hi = latest;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if ((await blockTs(mid)) <= ms) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
    const fromBlock = await findBlock(fromMs);
    const toBlock = await findBlock(toMs);
    const fromTs = await blockTs(fromBlock);
    const toTs = await blockTs(toBlock);
    const interp = (n) => (toBlock === fromBlock ? fromTs : fromTs + ((n - fromBlock) / (toBlock - fromBlock)) * (toTs - fromTs));
    const topics = recipients.map((r) => "0x" + String(r).toLowerCase().slice(2).padStart(64, "0"));
    for (let a = fromBlock; a <= toBlock; a += chunk) {
      const b = Math.min(toBlock, a + chunk - 1);
      const logs = await rpcFn("eth_getLogs", [{ fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [TRANSFER_TOPIC, null, topics] }]);
      for (const l of Array.isArray(logs) ? logs : []) {
        const n = hexN(l.blockNumber);
        const ts = l.blockTimestamp ? hexN(l.blockTimestamp) * 1000 : Math.round(interp(n));
        let amt = "0";
        try { amt = BigInt(l.data || "0x0").toString(); } catch { /* keep 0 */ }
        rows.push({ tx: l.transactionHash, token: String(l.address || "").toLowerCase(), amountAtomic: amt, decimals: 6, ts, recipient: "0x" + String(l.topics?.[2] || "").slice(-40).toLowerCase(), sender: "0x" + String(l.topics?.[1] || "").slice(-40).toLowerCase() });
      }
    }
    return { complete: true, source: "rpc", rows, error: null };
  } catch (e) {
    return { complete: false, source: "rpc", rows, error: `unreadable (${String(e?.message || e).slice(0, 120)})` };
  }
}

// ---------------------------------------------------------------------------

/**
 * createMppReconciler(deps) -> { runOnce, status, publicStatus, detail, start, stop }
 *
 * deps:
 *   ledgerRows(since, until)        sales-ledger MPP rows (sales-ledger.mppLedgerRows)
 *   refunds(since, until)           refund-ledger rows (refund-ledger.refundsCreatedBetween)
 *   recipients()                    our Tempo recipient address(es), [] when Tempo is off
 *   currencies()                    token addresses we offer on Tempo
 *   fetchTransfers({recipients, fromMs, toMs}) chain reader (feed then RPC)
 *   verifyEvm(row)                  -> { checked, verified, reason } (optional)
 *   stripeLookup(tx)                -> { status, amountCents } (optional; absent = not checked)
 *   premiumUsd()                    documented per-network price premium on Tempo (default 0)
 *   isOwnWallet(address)            internal attribution for chain-only transfers
 *   file                            persisted state (atomic tmp + rename)
 */
export function createMppReconciler({
  ledgerRows = () => [], refunds = () => [], recipients = () => [], currencies = () => [],
  fetchTransfers = async () => null, verifyEvm = null, stripeLookup = null, premiumUsd = () => 0,
  isOwnWallet = () => false, file = process.env.MPP_RECONCILE_FILE || "/data/mpp-reconcile.json",
  nonPaymentUsd = Number(process.env.MPP_RECONCILE_NON_PAYMENT_USD) > 0 ? Number(process.env.MPP_RECONCILE_NON_PAYMENT_USD) : 10,
  maxEvmChecks = 50, maxStripeChecks = 50, keepDays = 14, now = () => Date.now(), log = console.log,
} = {}) {
  let state = { days: {}, window: null, lastRunAt: null, lastError: null, runs: 0 };
  const doc = createJsonDocument({ file, log: () => {} });
  const absorb = (s) => { if (s && typeof s === "object" && s.days && typeof s.days === "object") state = { ...state, ...s }; };
  absorb(doc.loadSync(null));
  const ready = trackStoreReady(doc.backend === "pg" ? doc.load(null).then(absorb) : Promise.resolve());
  let running = null;
  let timer = null, firstTimer = null;

  // With the database the other container may have run (and stored) a day
  // this one has not: a run starts from the row, and its save writes only
  // the day it computed and the run fields onto the row as it is then.
  const PG = doc.backend === "pg";
  const persist = (d = null) => {
    if (!PG) { void doc.save(state); return true; }
    const mine = { ...state };
    return doc.update((b) => {
      const row = b && typeof b === "object" && b.days && typeof b.days === "object" ? b : { days: {}, window: null, lastRunAt: null, lastError: null, runs: 0 };
      const days = { ...row.days, ...(d && mine.days[d] ? { [d]: mine.days[d] } : {}) };
      for (const k of Object.keys(days).sort().slice(0, -keepDays)) delete days[k];
      const newer = !row.lastRunAt || (mine.lastRunAt && mine.lastRunAt >= row.lastRunAt);
      return {
        ...row, days,
        ...(newer ? { window: d ? mine.window : row.window, lastRunAt: mine.lastRunAt, lastError: mine.lastError, ...(d ? { lastDay: d } : {}) } : {}),
        runs: Math.max(Number(row.runs) || 0, Number(mine.runs) || 0),
      };
    }, { fallback: null }).then((r) => { if (r.ok) absorb(r.body); return r.ok; });
  };

  async function evmChecksFor(rows) {
    const out = new Map();
    if (typeof verifyEvm !== "function") return out;
    let n = 0;
    for (const r of rows) {
      if (r.wire !== "mpp" || !r.tx || isTempoRow(r)) continue;
      if (n++ >= maxEvmChecks) break;
      try { out.set(normTx(r.tx), await verifyEvm(r)); } catch { out.set(normTx(r.tx), { checked: false }); }
    }
    return out;
  }
  async function stripeChecksFor(rows) {
    if (typeof stripeLookup !== "function") return { configured: false, results: new Map() };
    const results = new Map();
    let n = 0;
    for (const r of rows) {
      if (r.wire !== "mpp-stripe" || !r.tx) continue;
      if (n++ >= maxStripeChecks) break;
      try { results.set(r.tx, await stripeLookup(r.tx)); } catch { results.set(r.tx, { error: true }); }
    }
    return { configured: true, results };
  }

  async function reconcileRange(start, end, { transfers }) {
    const lo = start - MATCH_MARGIN_MS, hi = end + MATCH_MARGIN_MS;
    const rows = await ledgerRows(lo, hi);
    const inRange = rows.filter((r) => r.ts >= start && r.ts < end);
    const [evmChecks, stripeChecks] = await Promise.all([evmChecksFor(inRange), stripeChecksFor(inRange)]);
    const summary = reconcileRecords({
      start, end, ledgerRows: rows, transfers, refunds: await refunds(lo, hi), evmChecks, stripeChecks,
      currencies: currencies() || [], premiumUsd: Number(premiumUsd()) || 0, nonPaymentUsd, isOwnWallet,
    });
    return summary;
  }

  /** Reconcile the previous UTC day (or `day`) and the rolling 7 days ending
   *  at that day's end. Concurrent calls share one run. */
  // Under a lease: two containers (a deploy's overlap, a second replica)
  // never run this tick at once; without a database it is the plain tick.
  const runOnce = leased("mpp-reconcile-run", { ttlMs: 1200000, log: log, failOpen: true }, runOnceUnleased);
  async function runOnceUnleased({ day = null } = {}) {
    if (running) return running;
    running = (async () => {
      if (PG) { const r = await doc.read(); if (r.ok && r.exists) absorb(r.body); }
      const t = now();
      const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(t - DAY_MS);
      const start = dayStartMs(d), end = start + DAY_MS;
      const wStart = end - 7 * DAY_MS;
      const recips = (recipients() || []).filter((r) => /^0x[0-9a-fA-F]{40}$/.test(String(r)));
      const tempoConfigured = recips.length > 0;
      try {
        // One chain read covers both the day and the window.
        const transfers = tempoConfigured
          ? await fetchTransfers({ recipients: recips, fromMs: wStart - MATCH_MARGIN_MS, toMs: Math.min(end + MATCH_MARGIN_MS, t) })
          : { complete: true, source: "none", rows: [], error: null };
        const daySum = await reconcileRange(start, end, { transfers });
        const winSum = await reconcileRange(wStart, end, { transfers });
        const pack = (s, extra) => ({ ...extra, generatedAt: new Date(t).toISOString(), tempoConfigured, ...s });
        state.days[d] = pack(daySum, { day: d });
        state.window = pack(winSum, { from: utcDay(wStart), to: d });
        for (const k of Object.keys(state.days).sort().slice(0, -keepDays)) delete state.days[k];
        state.lastRunAt = new Date(t).toISOString();
        state.lastDay = d;
        state.lastError = null;
        state.runs = (state.runs || 0) + 1;
        await persist(d);
        log(`[mpp-reconcile] ${d}: ${daySum.mismatchTotal} mismatch(es), chain ${daySum.sources.chain.source || "-"}${daySum.sources.chain.complete ? "" : " (incomplete)"}; 7d ${winSum.mismatchTotal}`);
        return { ok: true, day: d, summary: state.days[d], window: state.window };
      } catch (e) {
        state.lastError = String(e?.message || e).slice(0, 200);
        state.lastRunAt = new Date(t).toISOString();
        await persist();
        log(`[mpp-reconcile] run failed: ${state.lastError}`);
        return { ok: false, error: state.lastError };
      } finally { running = null; }
    })();
    return running;
  }

  const latestDay = () => (state.lastDay && state.days[state.lastDay]) || null;

  /** Status for /api/gateway-status. `chargedFailed24h` is read LIVE from
   *  the refund ledger (cheap), so the paid-but-failed alarm does not wait for
   *  the next daily run.
   *
   *  full=false is the PUBLIC view and carries status WORDS only - that
   *  endpoint publishes no number at all (scripts/test-gateway-status-privacy.js):
   *  one word per category, the chain source, staleness as a boolean. The
   *  counts, the internal/external split and the 7-day totals are full=true
   *  (operator) only. */
  async function status({ full = false } = {}) {
    const s = latestDay();
    const t = now();
    let word = statusWordFor(s);
    const stale = !state.lastRunAt || t - Date.parse(state.lastRunAt) > 36 * 3600e3;
    if (stale && word === "ok") word = "unknown";
    let cf = { total: 0, internal: 0, external: 0 };
    try {
      for (const r of await refunds(t - DAY_MS, t)) {
        if (!(MPP_WIRES.has(r.wire) || TEMPO_NETWORKS.has(String(r.network || "").toLowerCase()))) continue;
        cf.total++; cf[r.synthetic ? "internal" : "external"]++;
      }
    } catch { cf = null; }
    const chargedFailedStatus = cf === null ? "unknown" : cf.total > 0 ? "charged_failed" : "ok";
    const categories = {};
    if (s) for (const k of CATEGORIES) categories[k] = s.counts[k].total > 0 ? "mismatch" : "ok";
    const base = {
      status: word,
      day: s?.day || null,
      lastRunAt: state.lastRunAt,
      stale,
      chain: s ? { source: s.sources.chain.source, complete: !!s.sources.chain.complete } : null,
      categories,
      window7d: state.window ? (state.window.mismatchTotal > 0 ? "mismatch" : "ok") : "unknown",
      chargedFailedStatus,
    };
    if (!full) return base;
    const counts = {};
    if (s) for (const k of [...CATEGORIES, ...INFO_CATEGORIES]) counts[k] = { ...s.counts[k] };
    return {
      ...base,
      mismatches: s ? s.mismatchTotal : null,
      mismatchesExternal: s ? MISMATCH_CATEGORIES.reduce((a, k) => a + s.counts[k].external, 0) : null,
      counts,
      window7dCounts: state.window ? { from: state.window.from, to: state.window.to, mismatches: state.window.mismatchTotal } : null,
      chargedFailed24h: cf,
    };
  }
  const publicStatus = () => status({ full: false });

  /** Full detail for the operator route. Still no payer addresses: the
   *  summaries never held one. */
  function detail() {
    return { lastRunAt: state.lastRunAt, lastError: state.lastError, runs: state.runs, lastDay: state.lastDay || null, day: latestDay(), window: state.window, days: Object.keys(state.days).sort() };
  }

  function start({ firstDelayMs = Number(process.env.MPP_RECONCILE_FIRST_DELAY_MS) || 5 * 60_000, everyMs = 60 * 60_000 } = {}) {
    if (String(process.env.MPP_RECONCILE || "").toLowerCase() === "off") { log("[mpp-reconcile] disabled (MPP_RECONCILE=off)"); return null; }
    const due = () => state.lastDay !== utcDay(now() - DAY_MS);
    firstTimer = setTimeout(() => { if (due()) runOnce().catch(() => {}); }, firstDelayMs);
    firstTimer.unref?.();
    timer = setInterval(() => { if (due()) runOnce().catch(() => {}); }, everyMs);
    timer.unref?.();
    log(`[mpp-reconcile] daily reconciliation armed (first check in ${Math.round(firstDelayMs / 1000)}s, then hourly; runs once per UTC day)`);
    return timer;
  }
  function stop() { if (timer) clearInterval(timer); if (firstTimer) clearTimeout(firstTimer); timer = firstTimer = null; }

  return { runOnce, status, publicStatus, detail, start, stop, _state: () => state };
}
