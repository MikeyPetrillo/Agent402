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
import Database from "better-sqlite3";
import { leased } from "./state-db.js";
import { existsSync, mkdirSync } from "node:fs";
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
  let db = null;
  let initError = null;
  let timer = null;
  let draining = false;

  // Disabled = inert. No file is opened, no timer armed. Any failure to open
  // the store degrades to the SAME inert object: a shadow ledger that cannot
  // persist must do nothing at all rather than post without a dedupe layer.
  if (enabled) {
    try {
      if (!deps.dbFile) { try { mkdirSync(DEFAULT_DIR(), { recursive: true }); } catch { /* exists */ } }
      db = new Database(deps.dbFile || join(DEFAULT_DIR(), "agent402-stripe-shadow.db"));
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

  const live = () => enabled && db !== null;

  const stmts = live() ? {
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
      stmts.ins.run({
        tx: key,
        stripe_net: verdict.ok ? verdict.stripeNetwork : null,
        chain: network ? String(network) : null,
        slug: slug ? String(slug) : null,
        cents: verdict.ok ? verdict.cents : 0,
        price_usd: Number(priceUsd) || 0,
        status: verdict.ok ? "pending" : "skipped",
        reason: verdict.ok ? null : verdict.skip,
        ts,
      });
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
    draining = true;
    let attempted = 0;
    try {
      const rows = stmts.due.all(now(), batchSize);
      for (const row of rows) {
        // Claim before the network call. If the process dies mid-flight the row
        // sits in `sending` and is reclaimed at next boot, never re-driven by a
        // concurrent tick.
        if (stmts.claim.run({ tx: row.tx, ts: now() }).changes !== 1) continue;
        attempted++;
        const v = await postOne({ ...row, attempts: row.attempts + 1 });
        const attempts = row.attempts + 1;
        const exhausted = v.status === "retry" && attempts >= maxAttempts;
        const status = v.status === "retry" ? (exhausted ? "abandoned" : "pending") : v.status;
        const storedReason = exhausted ? `${v.reason}:max-attempts` : v.reason;
        stmts.finish.run({
          tx: row.tx,
          status,
          reason: storedReason,
          pi_id: v.piId,
          ts: now(),
          next_at: status === "pending" ? now() + backoffMs * attempts : 0,
        });
        if (status === "rejected" || status === "abandoned") {
          log(`[stripe-shadow] ${status} ${logSafe(row.slug)} ${row.cents}c on ${logSafe(row.stripe_net)}: ${logSafe(storedReason)}`);
        }
      }
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

  /** The reconciliation surface. Read-only; safe to call when disabled. */
  function report({ limit = 50 } = {}) {
    const base = {
      enabled,
      live: live(),
      apiVersion: SHADOW_API_VERSION,
      mode: "transaction_verification",
      authoritative: false,
      note: "SHADOW ONLY. Our sales ledger and the chain are authoritative; /revenue never reads this. Stripe's x402 guide expects payments to land on a Stripe-created deposit address, and our payTo is our own wallet, so rejections here are an expected result, not an outage.",
    };
    if (!enabled) return { ...base, reason: env.STRIPE_SECRET_KEY ? "STRIPE_SHADOW_LEDGER not set to 'on'" : "STRIPE_SHADOW_LEDGER/STRIPE_SECRET_KEY not set" };
    if (!live()) return { ...base, reason: "store unavailable", initError };
    try {
      const counts = {};
      const usd = {};
      let seen = 0;
      let ourUsd = 0;
      for (const r of stmts.byStatus.all()) {
        counts[r.status] = r.n;
        usd[r.status] = Math.round((r.usd || 0) * 1e6) / 1e6;
        seen += r.n;
        ourUsd += r.usd || 0;
      }
      const recordedCents = stmts.byStatus.all().filter((r) => r.status === "recorded").reduce((a, r) => a + (r.cents || 0), 0);
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
        reasons: stmts.byReason.all().map((r) => ({ status: r.status, reason: r.reason, n: r.n, usd: Math.round((r.usd || 0) * 1e6) / 1e6 })),
        recent: stmts.recent.all(Math.max(1, Math.min(500, Number(limit) || 50))),
        compare: "For a week: stripeSide.paymentIntents/usdTotal against the Stripe Dashboard, and ourSide.usdTotal minus usd.skipped against /api/revenue/daily external USDC totals for the same window. counts.skipped with reason below-minimum/sub-cent-amount is expected to dominate: Stripe's stablecoin floor is $0.01 and most catalog tools are $0.001.",
      };
    } catch (e) {
      return { ...base, reason: "report failed", error: logSafe(e?.message || e, 200) };
    }
  }

  return { record, drain, start, stop, report, enabled, live: live(), _db: db };
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
