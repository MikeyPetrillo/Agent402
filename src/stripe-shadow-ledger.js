// Stripe SHADOW ledger - a read-only mirror of our on-chain settlements into
// Stripe as PaymentIntents, so card revenue (Checkout, subscriptions, credits,
// stripe/charge over MPP) and crypto revenue can eventually live in one set of
// books.
//
// THIS IS NOT A SOURCE OF TRUTH AND MUST NEVER BECOME ONE.
// Our own sales ledger (src/sales-ledger.js) + the chain remain authoritative.
// /revenue never reads this module. Nothing here can decide whether a buyer is
// charged, whether a tool serves, or what any public surface reports. The only
// consequences a Stripe outage / rejection / shape change is ALLOWED to have
// are a row in this table, a counter, and a log line.
//
// The structural guarantees, in the order they matter:
//   1. The caller is handed a SYNCHRONOUS void function. record() returns
//      undefined - never a promise - so no caller can await it, and no rejected
//      promise can escape into a request. Every body here is inside try/catch.
//   2. It is called from res.on("finish") AFTER recordSale(), i.e. after the
//      response bytes are gone and after our own books are written. It has no
//      reference to req or res and cannot touch either.
//   3. Every network call happens on an unref'd drain timer, never on the
//      request path. The queue is the only thing the serving path touches.
//   4. OFF unless STRIPE_SHADOW_LEDGER=on AND STRIPE_SECRET_KEY is present.
//      Disabled means inert: no database file is opened, no timer is armed,
//      no fetch is ever constructed.
//
// IDEMPOTENCY is two-layer, and the durable layer is ours:
//   - local: the on-chain tx hash is the table's PRIMARY KEY, so a replay is an
//     INSERT OR IGNORE no-op. This survives restarts, which is the layer that
//     actually protects us.
//   - Stripe: every create carries `Idempotency-Key: <tx hash>` (per Stripe's
//     own x402 sample), so even a retry after a lost response returns the SAME
//     PaymentIntent instead of creating a second one. Stripe retains those keys
//     ~24h, which is why it is the belt and ours is the braces.
//
// WHAT WE VERIFIED AGAINST STRIPE'S DOCS (2026-08-22):
//   https://docs.stripe.com/payments/machine/x402
//     - `POST /v1/crypto/deposit_addresses` with `network=base`, header
//       `Stripe-Version: 2026-05-27.preview`.
//     - Record a settled payment with paymentIntents.create({ amount (CENTS),
//       currency:"usd", confirm:true, payment_method_data:{type:"crypto"},
//       payment_method_types:["crypto"], payment_method_options:{ crypto:{
//       mode:"transaction_verification", transaction_verification_options:{
//       network, transaction_hash } } } }, { idempotencyKey: txHash }).
//     - Their own sample drops anything under one cent: `if (amountInCents < 1)
//       return;`
//     - transaction_verification supports USDC on Tempo, Base, Solana ONLY.
//   https://docs.stripe.com/payments/machine.md
//     - "For stablecoin payments, the minimum amount is 0.01 USDC."
//
// WHAT WE DID **NOT** VERIFY, AND WHY IT IS BUILT AS AN EXPERIMENT:
//   Stripe's x402 guide has you create a Stripe crypto deposit address and use
//   THAT as your x402 `payTo`, so the funds land in a Stripe-controlled address
//   ("This is the on-chain address where Base payments are sent"). Our payTo is
//   our own treasury wallet. No page states outright whether
//   transaction_verification will verify a transaction that credited an address
//   Stripe does not control, and the plausible reading is that it will not.
//   So the EXPECTED first-week outcome is that Stripe rejects most or all of
//   these, and the operator surface is designed to make that legible rather
//   than to hide it. Nothing about our serving path depends on the answer.
//
// The SDK is not used: stripe@22.5.0 defaults to API version 2026-07-29.dahlia
// and exposes no `stripe.crypto.depositAddresses` resource, so these preview
// fields would be fought rather than helped. A plain fetch with the version
// header also gives us an explicit timeout and zero uncontrolled SDK retries.
//
// STORE: a SQLite file on the volume (agent402-stripe-shadow.db), or, when the
// state database is configured (STATE_DATABASE_URL), the stripe_shadow table
// there, with the same columns. The first boot with the database on imports
// the file's rows once (insert-if-absent, so two containers booting at once
// are safe) and records the import. With the database the drain CLAIMS its
// batch in one UPDATE ... RETURNING, so two containers that overlap on a
// deploy never send the same row, and a row left in `sending` is reclaimed
// only once it is older than any post could be in flight.
import Database from "better-sqlite3";
import { importOnce, leased, stateDbEnabled, stateDbSchema, stateQuery, trackStoreReady, withStateTx, withSchemaLock } from "./state-db.js";
import { retryingLoad } from "./store-retry.js";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logSafe } from "./log-safe.js";

// The preview version that documents transaction_verification. Overridable
// because a preview version WILL move, and a version bump must be an env
// change, never a redeploy-and-hope.
export const SHADOW_API_VERSION = process.env.STRIPE_SHADOW_API_VERSION || "2026-05-27.preview";
const STRIPE_API_BASE = process.env.STRIPE_SHADOW_API_BASE || "https://api.stripe.com";

// Stripe's transaction_verification network vocabulary. Both our friendly
// labels (src/stats.js CAIP2_NAMES) and the raw CAIP-2 ids map here, because a
// chain added before it gets a friendly name records under its raw id.
const STRIPE_NETWORKS = new Map([
  ["base", "base"],
  ["eip155:8453", "base"],
  ["solana", "solana"],
  ["solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp", "solana"],
  ["tempo", "tempo"],
  ["eip155:4217", "tempo"],
]);

const MICRO = 1_000_000;
// A Stripe error code/type is an enum-ish token; a message is an upstream body.
// Only the token shape is ever kept, and only behind operator auth.
const SAFE_CODE = /^[a-z0-9_]{1,64}$/;

/** Exact whole cents, or null. Never rounds a sub-cent price UP: overstating a
 *  price by 10x to clear Stripe's floor would be a fabricated amount. */
export function exactCents(priceUsd) {
  const n = Number(priceUsd);
  if (!Number.isFinite(n) || n <= 0) return null;
  const micro = Math.round(n * MICRO);
  if (micro % 10_000 !== 0) return null; // sub-cent precision (our $0.001 tools)
  return micro / 10_000;
}

/** Why this settlement is not postable, or null if it is. Pure, no I/O. */
export function eligibility({ rail, network, priceUsd, tx, synthetic }) {
  if (synthetic) return { skip: "internal" };
  if (rail !== "usdc") return { skip: "rail-not-onchain" };
  if (typeof tx !== "string" || !tx.trim()) return { skip: "no-tx" };
  const net = STRIPE_NETWORKS.get(String(network || "").toLowerCase());
  if (!net) return { skip: "network-unsupported" };
  const cents = exactCents(priceUsd);
  if (cents === null) return { skip: "sub-cent-amount" };
  if (cents < 1) return { skip: "below-minimum" };
  return { ok: true, stripeNetwork: net, cents };
}

/** Stripe's form encoding for the create body. Exported so the test can pin the
 *  wire shape against the documented sample without a live call. */
export function paymentIntentForm({ cents, stripeNetwork, tx, slug }) {
  const p = new URLSearchParams();
  p.set("amount", String(cents));
  p.set("currency", "usd");
  p.set("confirm", "true");
  p.set("payment_method_data[type]", "crypto");
  p.set("payment_method_types[0]", "crypto");
  p.set("payment_method_options[crypto][mode]", "transaction_verification");
  p.set("payment_method_options[crypto][transaction_verification_options][network]", stripeNetwork);
  p.set("payment_method_options[crypto][transaction_verification_options][transaction_hash]", tx);
  // Metadata is our own text only. Never a payer address: the tx hash already
  // carries that on a public chain, and there is no reason to hand Stripe a
  // wallet-to-slug map it did not ask for.
  p.set("metadata[agent402_shadow]", "1");
  if (slug) p.set("metadata[agent402_slug]", String(slug).slice(0, 64));
  return p;
}

/** Is the shadow ledger switched on? Both must be true, and the switch is an
 *  explicit "on" - a truthy accident like "false" or "0" leaves it off. */
export function shadowLedgerEnabled(env = process.env) {
  return String(env.STRIPE_SHADOW_LEDGER || "").trim().toLowerCase() === "on"
    && Boolean(env.STRIPE_SECRET_KEY);
}

const DEFAULT_DIR = () => (existsSync("/data") ? "/data" : "/tmp");
export const SHADOW_DB_FILE = "agent402-stripe-shadow.db";
// With the database, a `sending` row older than this is a crash, not a post
// in flight (a post is bounded by timeoutMs, ten seconds by default).
const SENDING_STALE_MS = () => Math.max(60_000, Number(process.env.STRIPE_SHADOW_SENDING_STALE_MS) || 10 * 60_000);
const T = () => `${stateDbSchema()}.stripe_shadow`;
const PG_COLS = "tx, stripe_net, chain, slug, cents, price_usd, status, reason, pi_id, attempts, created_at, updated_at, next_at";
const PG_DDL = () => `
  CREATE TABLE IF NOT EXISTS ${T()} (
    tx           TEXT PRIMARY KEY,
    stripe_net   TEXT,
    chain        TEXT,
    slug         TEXT,
    cents        INTEGER NOT NULL DEFAULT 0,
    price_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
    status       TEXT NOT NULL,
    reason       TEXT,
    pi_id        TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    next_at      BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS stripe_shadow_status ON ${T()} (status, next_at);
`;
const num = (v) => (v == null ? v : Number(v));
/** A Postgres row in the shape the SQLite rows have (bigints and sums arrive as strings). */
const rowOf = (r) => ({ ...r, cents: num(r.cents), price_usd: num(r.price_usd), attempts: num(r.attempts), created_at: num(r.created_at), updated_at: num(r.updated_at), next_at: num(r.next_at) });

/** Copy every row of the SQLite file into the table, insert-if-absent. */
async function importSqliteFile(file) {
  if (!file || !existsSync(file)) return { bytes: 0, rows: 0 };
  const src = new Database(file, { readonly: true, fileMustExist: true });
  let rows = [];
  try { rows = src.prepare("SELECT * FROM shadow").all(); } finally { src.close(); }
  await withStateTx(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO ${T()} (${PG_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (tx) DO NOTHING`,
        [r.tx, r.stripe_net ?? null, r.chain ?? null, r.slug ?? null, Number(r.cents) || 0, Number(r.price_usd) || 0, String(r.status || "pending"), r.reason ?? null, r.pi_id ?? null, Number(r.attempts) || 0, Number(r.created_at) || 0, Number(r.updated_at) || 0, Number(r.next_at) || 0],
      );
    }
  });
  return { bytes: statSync(file).size, rows: rows.length };
}

/** The reconciliation numbers from the three aggregate reads (either backend). */
function buildReport(base, byStatus, byReason, recent) {
  const counts = {};
  const usd = {};
  let seen = 0;
  let ourUsd = 0;
  for (const r of byStatus) {
    counts[r.status] = r.n;
    usd[r.status] = Math.round((r.usd || 0) * 1e6) / 1e6;
    seen += r.n;
    ourUsd += r.usd || 0;
  }
  const recordedCents = byStatus.filter((r) => r.status === "recorded").reduce((a, r) => a + (r.cents || 0), 0);
  return {
    ...base,
    ourSide: {
      settlementsSeen: seen,
      usdTotal: Math.round(ourUsd * 1e6) / 1e6,
      source: "sales ledger settlements handed to record(), priced at catalog list price",
    },
    stripeSide: {
      paymentIntents: counts.recorded || 0,
      usdTotal: Math.round(recordedCents) / 100,
      source: "PaymentIntents Stripe returned 2xx for",
    },
    counts,
    usd,
    reasons: byReason.map((r) => ({ status: r.status, reason: r.reason, n: r.n, usd: Math.round((r.usd || 0) * 1e6) / 1e6 })),
    recent,
    compare: "For a week: stripeSide.paymentIntents/usdTotal against the Stripe Dashboard, and ourSide.usdTotal minus usd.skipped against /api/revenue/daily external USDC totals for the same window. counts.skipped with reason below-minimum/sub-cent-amount is expected to dominate: Stripe's stablecoin floor is $0.01 and most catalog tools are $0.001.",
  };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.env]            defaults to process.env
 * @param {string} [deps.dbFile]         absolute path; defaults to /data
 * @param {Function} [deps.fetchImpl]    injected fetch (tests)
 * @param {() => number} [deps.now]
 * @param {(s: string) => void} [deps.log]
 * @param {number} [deps.batchSize]      rows drained per tick
 * @param {number} [deps.maxAttempts]    transient retries before `abandoned`
 * @param {number} [deps.timeoutMs]      per-call abort
 * @param {number} [deps.intervalMs]     drain cadence
 */
export function createShadowLedger(deps = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    log = console.log,
    batchSize = Number(env.STRIPE_SHADOW_BATCH) || 10,
    maxAttempts = Number(env.STRIPE_SHADOW_MAX_ATTEMPTS) || 5,
    timeoutMs = Number(env.STRIPE_SHADOW_TIMEOUT_MS) || 10_000,
    intervalMs = Number(env.STRIPE_SHADOW_INTERVAL_MS) || 30_000,
    backoffMs = Number(env.STRIPE_SHADOW_BACKOFF_MS) || 60_000,
  } = deps;

  const enabled = shadowLedgerEnabled(env);
  // The backend: the state database when it is configured, else the SQLite
  // file. Decided once, at construction, like every other store.
  const usePg = enabled && stateDbEnabled();
  const dbFile = deps.dbFile || join(DEFAULT_DIR(), SHADOW_DB_FILE);
  let db = null;
  let initError = null;
  let timer = null;
  let draining = false;
  let pgLoader = null;  // the first load (table, import, reclaim), retried until it lands

  // Disabled = inert. No file is opened, no timer armed. Any failure to open
  // the store degrades to the SAME inert object: a shadow ledger that cannot
  // persist must do nothing at all rather than post without a dedupe layer.
  if (enabled && !usePg) {
    try {
      if (!deps.dbFile) { try { mkdirSync(DEFAULT_DIR(), { recursive: true }); } catch { /* exists */ } }
      db = new Database(dbFile);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS shadow (
          tx           TEXT PRIMARY KEY,      -- on-chain hash/signature = the idempotency key
          stripe_net   TEXT,                  -- base | solana | tempo (null when skipped)
          chain        TEXT,                  -- our own recorded network label
          slug         TEXT,
          cents        INTEGER NOT NULL DEFAULT 0,
          price_usd    REAL    NOT NULL DEFAULT 0,
          status       TEXT    NOT NULL,      -- pending|sending|recorded|rejected|abandoned|skipped
          reason       TEXT,                  -- redacted code only, never an upstream body
          pi_id        TEXT,                  -- Stripe PaymentIntent id on success
          attempts     INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          next_at      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS shadow_status ON shadow (status, next_at);
      `);
      // A row stranded in `sending` by a restart is safe to re-drive: the
      // Idempotency-Key means Stripe returns the SAME PaymentIntent rather
      // than creating a second one. Reclaim at boot so a crash mid-flight
      // does not silently drop a settlement forever.
      const reclaimed = db.prepare("UPDATE shadow SET status='pending' WHERE status='sending'").run().changes;
      if (reclaimed > 0) log(`[stripe-shadow] reclaimed ${reclaimed} row(s) stranded mid-send by a restart`);
    } catch (e) {
      initError = String(e?.message || e).slice(0, 200);
      db = null;
      console.warn(`[stripe-shadow] store unavailable, ledger inert: ${logSafe(initError)}`);
    }
  }
  if (usePg) {
    // The table, the one-time import of the SQLite file, and the reclaim of
    // rows another container (or this one, before a restart) left in
    // `sending` longer than a post can be in flight. A row claimed seconds
    // ago may be mid-send on the other half of a deploy: it is left alone.
    // A failed load is retried (by the next call and a background timer),
    // never left dead: records made meanwhile wait in `pendingInserts`.
    pgLoader = retryingLoad("[stripe-shadow] store:", async () => {
      await withSchemaLock((c) => c.query(PG_DDL()));
      const imp = await importOnce(SHADOW_DB_FILE, { source: dbFile, run: () => importSqliteFile(dbFile) });
      if (imp.imported && imp.rows) log(`[stripe-shadow] imported ${imp.rows} row(s) from ${dbFile}`);
      const reclaimed = await reclaimStale();
      if (reclaimed > 0) log(`[stripe-shadow] reclaimed ${reclaimed} row(s) stranded mid-send by a restart`);
      initError = null;
      return true;
    }, { log: (m) => { try { console.warn(logSafe(m, 300)); } catch { /* nothing left to do */ } }, onLoaded: () => { if (pendingInserts.length) void drainInserts(); } });
    trackStoreReady(pgLoader.eventually);
    pgLoader.ready().catch((e) => { initError = String(e?.message || e).slice(0, 200); });
  }
  /** True once the first load has landed; a failed attempt answers false and is retried. */
  const pgReady = () => pgLoader.ready().then(() => true, (e) => { initError = String(e?.message || e).slice(0, 200); return false; });

  const live = () => enabled && (db !== null || usePg);

  const stmts = db ? {
    ins: db.prepare(`INSERT OR IGNORE INTO shadow
      (tx, stripe_net, chain, slug, cents, price_usd, status, reason, attempts, created_at, updated_at, next_at)
      VALUES (@tx, @stripe_net, @chain, @slug, @cents, @price_usd, @status, @reason, 0, @ts, @ts, @ts)`),
    due: db.prepare("SELECT * FROM shadow WHERE status='pending' AND next_at <= ? ORDER BY created_at ASC LIMIT ?"),
    claim: db.prepare("UPDATE shadow SET status='sending', attempts=attempts+1, updated_at=@ts WHERE tx=@tx AND status='pending'"),
    finish: db.prepare("UPDATE shadow SET status=@status, reason=@reason, pi_id=@pi_id, updated_at=@ts, next_at=@next_at WHERE tx=@tx"),
    byStatus: db.prepare("SELECT status, COUNT(*) n, SUM(price_usd) usd, SUM(cents) cents FROM shadow GROUP BY status"),
    byReason: db.prepare("SELECT status, reason, COUNT(*) n, SUM(price_usd) usd FROM shadow WHERE reason IS NOT NULL GROUP BY status, reason ORDER BY n DESC"),
    recent: db.prepare("SELECT tx, slug, chain, stripe_net, cents, price_usd, status, reason, pi_id, attempts, created_at, updated_at FROM shadow ORDER BY created_at DESC LIMIT ?"),
    count: db.prepare("SELECT COUNT(*) n FROM shadow"),
  } : null;

  // ---- the database path ------------------------------------------------------
  // Inserts from the serving path wait in `pendingInserts` and are written in
  // order, never awaited by the caller: record() stays a synchronous void. A
  // failed insert keeps its row (and every later one) and is retried by the
  // next record, flush or retry timer; past PENDING_INSERTS_MAX the oldest is
  // dropped, logged. flush() resolves once a drain has tried them all.
  const PENDING_INSERTS_MAX = 50_000;
  const pendingInserts = [];
  let insertDraining = null;
  let insertRetry = null;
  let lastInsertError = "";
  function drainInserts() {
    if (insertDraining) return insertDraining;
    insertDraining = (async () => {
      try {
        if (!(await pgReady())) { scheduleInsertRetry(); return false; }
        while (pendingInserts.length) {
          try { await pgInsert(pendingInserts[0]); }
          catch (e) {
            const why = logSafe(e?.message || e);
            if (why !== lastInsertError) { try { console.warn(`[stripe-shadow] enqueue failed, kept for retry: ${why}`); } catch { /* nothing left to do */ } }
            lastInsertError = why;
            scheduleInsertRetry();
            return false;
          }
          pendingInserts.shift(); lastInsertError = "";
        }
        return true;
      } finally { insertDraining = null; }
    })();
    return insertDraining;
  }
  function scheduleInsertRetry() {
    if (insertRetry) return;
    insertRetry = setTimeout(() => { insertRetry = null; void drainInserts(); }, 5_000);
    insertRetry.unref?.();
  }
  function enqueueInsert(row) {
    pendingInserts.push(row);
    if (pendingInserts.length > PENDING_INSERTS_MAX) { pendingInserts.shift(); try { console.warn(`[stripe-shadow] more than ${PENDING_INSERTS_MAX} rows waiting for the database; the oldest was dropped`); } catch { /* nothing left to do */ } }
    void drainInserts();
  }
  async function reclaimStale() {
    const t = now();
    const r = await stateQuery(`UPDATE ${T()} SET status='pending', updated_at=$1 WHERE status='sending' AND updated_at < $2`, [t, t - SENDING_STALE_MS()]);
    return r.rowCount;
  }
  async function pgInsert(row) {
    await stateQuery(
      `INSERT INTO ${T()} (${PG_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,0,$9,$9,$9) ON CONFLICT (tx) DO NOTHING`,
      [row.tx, row.stripe_net, row.chain, row.slug, row.cents, row.price_usd, row.status, row.reason, row.ts],
    );
  }
  /** Claim up to `batchSize` due rows in ONE statement: the rows another container claimed are skipped. */
  async function pgClaimDue() {
    const t = now();
    const r = await stateQuery(
      `UPDATE ${T()} s SET status='sending', attempts=s.attempts+1, updated_at=$1
       WHERE s.tx IN (SELECT tx FROM ${T()} WHERE status='pending' AND next_at <= $1 ORDER BY created_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING ${PG_COLS}`,
      [t, batchSize],
    );
    return r.rows.map(rowOf);
  }
  async function pgFinish(f) {
    await stateQuery(
      `UPDATE ${T()} SET status=$2, reason=$3, pi_id=$4, updated_at=$5, next_at=$6 WHERE tx=$1 AND status='sending'`,
      [f.tx, f.status, f.reason, f.pi_id, f.ts, f.next_at],
    );
  }
  async function pgAggregates(limit) {
    const byStatus = (await stateQuery(`SELECT status, COUNT(*)::int AS n, SUM(price_usd)::float8 AS usd, SUM(cents)::bigint AS cents FROM ${T()} GROUP BY status`)).rows
      .map((r) => ({ status: r.status, n: Number(r.n), usd: Number(r.usd) || 0, cents: Number(r.cents) || 0 }));
    const byReason = (await stateQuery(`SELECT status, reason, COUNT(*)::int AS n, SUM(price_usd)::float8 AS usd FROM ${T()} WHERE reason IS NOT NULL GROUP BY status, reason ORDER BY n DESC`)).rows
      .map((r) => ({ status: r.status, reason: r.reason, n: Number(r.n), usd: Number(r.usd) || 0 }));
    const recent = (await stateQuery(`SELECT tx, slug, chain, stripe_net, cents, price_usd, status, reason, pi_id, attempts, created_at, updated_at FROM ${T()} ORDER BY created_at DESC LIMIT $1`, [limit])).rows.map(rowOf);
    return { byStatus, byReason, recent };
  }

  /**
   * Enqueue one settled on-chain payment. SYNCHRONOUS, returns undefined,
   * never throws. This is the only function the serving path calls.
   */
  function record(sale) {
    try {
      if (!live()) return undefined;
      const { slug, priceUsd, rail, network, tx, synthetic } = sale || {};
      const verdict = eligibility({ rail, network, priceUsd, tx, synthetic });
      const ts = now();
      // A settlement with no tx hash still belongs in the reconciliation count,
      // but it can never be posted (there is nothing to verify and no safe
      // idempotency key), so it is stored under a NON-POSTABLE synthetic key.
      const key = verdict.skip === "no-tx"
        ? `notx:${String(slug || "?")}:${Math.floor(ts / 60_000)}`
        : String(tx);
      const row = {
        tx: key,
        stripe_net: verdict.ok ? verdict.stripeNetwork : null,
        chain: network ? String(network) : null,
        slug: slug ? String(slug) : null,
        cents: verdict.ok ? verdict.cents : 0,
        price_usd: Number(priceUsd) || 0,
        status: verdict.ok ? "pending" : "skipped",
        reason: verdict.ok ? null : verdict.skip,
        ts,
      };
      if (usePg) enqueueInsert(row); // queued, in order, never awaited here
      else stmts.ins.run(row);
      if (verdict.ok) ensureTimer();
    } catch (e) {
      // Accounting must never break serving, and the shadow ledger must never
      // even break the accounting. Swallow, count nothing, say so once.
      try { console.warn(`[stripe-shadow] enqueue failed: ${logSafe(e?.message || e)}`); } catch { /* nothing left to do */ }
    }
    return undefined;
  }

  /** One Stripe create. Resolves to a verdict object; never rejects. */
  async function postOne(row) {
    const ac = new AbortController();
    const t = setTimeout(() => { try { ac.abort(); } catch { /* already gone */ } }, timeoutMs);
    try {
      const httpRes = await fetchImpl(`${STRIPE_API_BASE}/v1/payment_intents`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.STRIPE_SECRET_KEY}:`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Version": SHADOW_API_VERSION,
          // The on-chain tx hash. A retry can therefore never mint a second
          // PaymentIntent - Stripe replays the first response.
          "Idempotency-Key": row.tx,
        },
        body: paymentIntentForm({
          cents: row.cents, stripeNetwork: row.stripe_net, tx: row.tx, slug: row.slug,
        }).toString(),
      });
      const status = Number(httpRes?.status) || 0;
      let body = null;
      try { body = await httpRes.json(); } catch { body = null; }
      if (status >= 200 && status < 300) {
        const id = typeof body?.id === "string" ? body.id.slice(0, 64) : null;
        return { status: "recorded", reason: null, piId: id };
      }
      // REDACTION: the status plus Stripe's enum-ish code/type, nothing else.
      // Stripe's `error.message` is an upstream body and never leaves here.
      const code = [body?.error?.code, body?.error?.type]
        .map((v) => (typeof v === "string" ? v : ""))
        .find((v) => SAFE_CODE.test(v));
      const reason = `http_${status}${code ? `:${code}` : ""}`;
      // 429 and 5xx are transient. Every other 4xx is a shape/permission
      // problem that will not fix itself, so it is terminal - retrying it
      // would be a loop against a fixed answer.
      const transient = status === 429 || status >= 500 || status === 0;
      return { status: transient ? "retry" : "rejected", reason, piId: null };
    } catch (e) {
      const aborted = e?.name === "AbortError";
      return { status: "retry", reason: aborted ? "timeout" : "network-error", piId: null };
    } finally {
      clearTimeout(t);
    }
  }

  /** Drain up to `batchSize` due rows. Never throws, never runs concurrently. */
  // Under a lease: two containers (a deploy's overlap, a second replica)
  // never run this tick at once; without a database it is the plain tick.
  const drain = leased("stripe-shadow-drain", { ttlMs: 300000, log: console.warn }, drainUnleased);
  async function drainUnleased() {
    if (!live() || draining) return { attempted: 0 };
    if (usePg && !(await pgReady())) return { attempted: 0 };
    draining = true;
    let attempted = 0;
    try {
      let rows;
      if (usePg) {
        // Rows another container left mid-send past the stale window come
        // back to pending first; then this tick's batch is claimed in one
        // statement, so no row is ever claimed twice.
        await reclaimStale();
        rows = await pgClaimDue();
      } else {
        rows = stmts.due.all(now(), batchSize);
      }
      for (const row of rows) {
        // Claim before the network call. If the process dies mid-flight the row
        // sits in `sending` and is reclaimed at next boot, never re-driven by a
        // concurrent tick. (With the database the claim was the UPDATE above.)
        if (!usePg && stmts.claim.run({ tx: row.tx, ts: now() }).changes !== 1) continue;
        attempted++;
        const attempts = usePg ? row.attempts : row.attempts + 1;
        const v = await postOne({ ...row, attempts });
        const exhausted = v.status === "retry" && attempts >= maxAttempts;
        const status = v.status === "retry" ? (exhausted ? "abandoned" : "pending") : v.status;
        const storedReason = exhausted ? `${v.reason}:max-attempts` : v.reason;
        const fin = {
          tx: row.tx,
          status,
          reason: storedReason,
          pi_id: v.piId,
          ts: now(),
          next_at: status === "pending" ? now() + backoffMs * attempts : 0,
        };
        if (usePg) await pgFinish(fin); else stmts.finish.run(fin);
        if (status === "rejected" || status === "abandoned") {
          log(`[stripe-shadow] ${status} ${logSafe(row.slug)} ${row.cents}c on ${logSafe(row.stripe_net)}: ${logSafe(storedReason)}`);
        }
      }
      if (usePg && attempted) await refreshSnapshot();
    } catch (e) {
      try { console.warn(`[stripe-shadow] drain failed: ${logSafe(e?.message || e)}`); } catch { /* nothing left to do */ }
    } finally {
      draining = false;
    }
    return { attempted };
  }

  function ensureTimer() {
    if (timer || !live() || intervalMs <= 0) return;
    timer = setInterval(() => { drain().catch(() => {}); }, intervalMs);
    // Unref'd: the shadow ledger must never hold the process open, and must
    // never delay a graceful drain on deploy.
    if (typeof timer.unref === "function") timer.unref();
  }

  function start() {
    if (!live()) return false;
    ensureTimer();
    return true;
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  /** The reconciliation surface. Read-only; safe to call when disabled.
   *  On the SQLite file it reads live. On the database it returns the last
   *  SNAPSHOT (taken after every drain, and refreshed by each call for the
   *  next one, at most every few seconds) so the caller stays synchronous;
   *  reportAsync() reads the database fresh. */
  const baseReport = () => ({
    enabled,
    live: live(),
    apiVersion: SHADOW_API_VERSION,
    mode: "transaction_verification",
    authoritative: false,
    backend: usePg ? "pg" : "sqlite",
    note: "SHADOW ONLY. Our sales ledger and the chain are authoritative; /revenue never reads this. Stripe's x402 guide expects payments to land on a Stripe-created deposit address, and our payTo is our own wallet, so rejections here are an expected result, not an outage.",
  });
  function disabledReport() {
    const base = baseReport();
    if (!enabled) return { ...base, reason: env.STRIPE_SECRET_KEY ? "STRIPE_SHADOW_LEDGER not set to 'on'" : "STRIPE_SHADOW_LEDGER/STRIPE_SECRET_KEY not set" };
    if (!live()) return { ...base, reason: "store unavailable", initError };
    return null;
  }
  let snapshot = null;
  let snapshotAt = 0;
  let snapshotLimit = 50;
  let refreshing = null;
  const SNAPSHOT_MIN_MS = 2_000;
  function refreshSnapshot(limit = snapshotLimit) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!(await pgReady())) return;
      const { byStatus, byReason, recent } = await pgAggregates(limit);
      snapshot = buildReport(baseReport(), byStatus, byReason, recent);
      snapshotAt = now();
      snapshotLimit = limit;
    })().catch((e) => { try { console.warn(`[stripe-shadow] report failed: ${logSafe(e?.message || e)}`); } catch { /* nothing left to do */ } })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  function report({ limit = 50 } = {}) {
    const off = disabledReport();
    if (off) return off;
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    if (usePg) {
      if (!snapshot || now() - snapshotAt >= SNAPSHOT_MIN_MS || lim !== snapshotLimit) void refreshSnapshot(lim);
      if (!snapshot) return { ...baseReport(), reason: "snapshot pending: the first read of the database is in flight, read again" };
      return { ...snapshot, snapshotAt: new Date(snapshotAt).toISOString() };
    }
    try {
      return buildReport(baseReport(), stmts.byStatus.all(), stmts.byReason.all(), stmts.recent.all(lim));
    } catch (e) {
      return { ...baseReport(), reason: "report failed", error: logSafe(e?.message || e, 200) };
    }
  }
  /** The same surface, read fresh (awaits the database; the file is read at once). */
  async function reportAsync(opts = {}) {
    if (!usePg) return report(opts);
    const off = disabledReport();
    if (off) return off;
    await flush();
    await refreshSnapshot(Math.max(1, Math.min(500, Number(opts.limit) || 50)));
    return report(opts);
  }
  /** Resolves once every queued write has landed (tests and shutdown). */
  async function flush() { if (usePg) await drainInserts(); }

  return { record, drain, start, stop, report, reportAsync, flush, ready: () => (usePg ? pgReady() : Promise.resolve(db !== null)), enabled, backend: usePg ? "pg" : "sqlite", live: live(), _db: db, _drainUnleased: drainUnleased };
}

// ---------------------------------------------------------------------------
// Module singleton. Built lazily so that importing this file has NO side
// effect when the switch is off - no file opened, no timer, nothing.
let singleton = null;
function instance() {
  if (singleton === null) {
    try { singleton = createShadowLedger(); }
    catch { singleton = { record: () => undefined, start: () => false, report: () => ({ enabled: false, reason: "init failed" }) }; }
  }
  return singleton;
}

/** Fire and forget. Synchronous, returns undefined, never throws. */
export function recordShadowSettlement(sale) {
  try { instance().record(sale); } catch { /* shadow ledger can never surface */ }
  return undefined;
}
export function startShadowLedger() {
  try { return instance().start(); } catch { return false; }
}
export function shadowLedgerReport(opts) {
  try { return instance().report(opts); } catch { return { enabled: false, reason: "report failed" }; }
}
/** The report read fresh from the store (a promise; on the SQLite file it is the same read). */
export async function shadowLedgerReportAsync(opts) {
  try { return await instance().reportAsync(opts); } catch { return { enabled: false, reason: "report failed" }; }
}
