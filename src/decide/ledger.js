// Decisions the main app sold, their execution credits and execution runs.
//
// This is money state, so it lives beside the other payment ledgers (SQLite on
// the volume) rather than in the decide service: the execute route prices its
// 402 from it synchronously, and a credit must never depend on another
// service being up to be honoured. Amounts are integer micro-dollars.
//
// CREDIT LIFECYCLE. minted `pending` when a decision is answered; `active`
// only once that answer's payment SETTLED (the dispatcher's final-status hook);
// `redeemed` atomically by one execute run; back to `active` if that run
// fails before spending. A pending credit (its payment never settled) can
// never be redeemed. The token is shown once; only its hash is stored.
//
// STATE DATABASE. With STATE_DATABASE_URL set (src/state-db.js) the ledger
// lives in Postgres, in tables of its own in the state schema, and every
// method RETURNS A PROMISE; without it the SQLite file is used and every
// method answers synchronously, exactly as before. The first open with the
// database on imports the SQLite file once (insert-if-absent, so two
// containers booting at once are safe) and records the import. The atomic
// steps (activate, redeem, restore, the run booking under its caps, a seller
// hold under its cap) are conditional statements or short transactions, so
// any number of writers is safe. The two reads the 402 quote needs
// synchronously (getDecisionSync, creditAvailableUsdSync) come from an
// in-memory mirror that the first load fills, this process's writes update,
// and a stale or missing entry refreshes in the background; the quote is an
// offer the handler re-validates against the database before anything is
// charged, so a stale mirror can only make a quote the paid retry corrects.
// While the SQLite file still exists on the volume, every database write is
// also applied to it (best effort, never the verdict), so a rollback to the
// previous build reads current credits and runs.

import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { stateDbEnabled, stateDbSchema, stateQuery, withStateTx, importOnce, trackStoreReady } from "../state-db.js";

const micro = (usd) => Math.round(Number(usd) * 1e6);
const RUN_MAX_MS = 15 * 60_000;
const RETENTION_MS = 30 * 86_400_000;
const usd = (m) => Math.round(Number(m)) / 1e6;
export const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");

/** The SQLite ledger is one file on one volume: it is correct only while one
 *  process writes it. With more than one replica, two ledgers would each
 *  honour the same credit and each apply the caps, so decide stays off. On
 *  the state database the conditional statements make it safe for any
 *  number of writers. */
export function singleWriterTopology(env = process.env) {
  if (stateDbEnabled(env)) return true;
  const n = Number(env.RATE_LIMIT_REPLICAS || 1);
  return !(Number.isFinite(n) && n > 1);
}

/** The run-booking refusals, shared by both backends: a cap that the booking
 *  would cross, checked against exposures read inside the same atomic step. */
function capRefusal(caps, budgetUsd, payer, ex) {
  if (!caps) return null;
  if (payer && caps.payerHourUsd != null && ex.payerHour + budgetUsd > caps.payerHourUsd) return "payerHour";
  if (caps.globalDayUsd != null && ex.globalDay + budgetUsd > caps.globalDayUsd) return "global";
  if (payer && caps.payerDayUsd != null && ex.payerDay + budgetUsd > caps.payerDayUsd) return "payerDay";
  return null;
}

function ensureSqliteSchema(db) {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, depth TEXT NOT NULL,
      price_micro INTEGER NOT NULL, payer TEXT, plan_json TEXT NOT NULL,
      cost_via_micro INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS credits (
      token_hash TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT,
      amount_micro INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credits_decision ON credits (decision_id);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT, status TEXT NOT NULL,
      budget_micro INTEGER NOT NULL, spent_micro INTEGER NOT NULL DEFAULT 0,
      credit_micro INTEGER NOT NULL DEFAULT 0, steps_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_payer ON runs (payer, created_at);
    CREATE TABLE IF NOT EXISTS feedback (
      decision_id TEXT NOT NULL, step INTEGER NOT NULL, tool_id TEXT,
      outcome TEXT NOT NULL, quality INTEGER, latency_ms INTEGER, created_at INTEGER NOT NULL,
      PRIMARY KEY (decision_id, step)
    );
    CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at);
    CREATE TABLE IF NOT EXISTS seller_spend (
      run_id TEXT NOT NULL, seller TEXT NOT NULL, micro INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS seller_spend_seller ON seller_spend (seller, created_at);
    CREATE INDEX IF NOT EXISTS runs_status ON runs (status, created_at);
  `);
  // Added after the first schema: the hash of the decision's feedback token.
  try { db.exec("ALTER TABLE decisions ADD COLUMN feedback_hash TEXT"); } catch { /* already there */ }
  // A caller's run key: one run per (decision, key), so a client that timed out
  // and paid again cannot run the same plan twice.
  try { db.exec("ALTER TABLE runs ADD COLUMN run_key TEXT"); } catch { /* already there */ }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_decision_key ON runs (decision_id, run_key) WHERE run_key IS NOT NULL");
}

function prepareSqlite(db) {
  return {
    saveDecision: db.prepare("INSERT OR REPLACE INTO decisions (id, created_at, depth, price_micro, payer, plan_json, cost_via_micro, settled, feedback_hash) VALUES (?,?,?,?,?,?,?,0,?)"),
    feedback: db.prepare("INSERT INTO feedback (decision_id, step, tool_id, outcome, quality, latency_ms, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(decision_id, step) DO UPDATE SET tool_id = excluded.tool_id, outcome = excluded.outcome, quality = excluded.quality, latency_ms = excluded.latency_ms, created_at = excluded.created_at"),
    feedbackExisting: db.prepare("SELECT 1 FROM feedback WHERE decision_id = ? AND step = ?"),
    getDecision: db.prepare("SELECT * FROM decisions WHERE id = ?"),
    settleDecision: db.prepare("UPDATE decisions SET settled = 1 WHERE id = ?"),
    mint: db.prepare("INSERT INTO credits (token_hash, decision_id, payer, amount_micro, expires_at, state, created_at) VALUES (?,?,?,?,?, 'pending', ?)"),
    activate: db.prepare("UPDATE credits SET state = 'active' WHERE token_hash = ? AND state = 'pending'"),
    credit: db.prepare("SELECT * FROM credits WHERE token_hash = ?"),
    redeem: db.prepare("UPDATE credits SET state = 'redeemed', run_id = ? WHERE token_hash = ? AND decision_id = ? AND state = 'active' AND expires_at > ?"),
    restore: db.prepare("UPDATE credits SET state = 'active', run_id = NULL WHERE token_hash = ? AND state = 'redeemed' AND run_id = ?"),
    createRun: db.prepare("INSERT INTO runs (id, decision_id, payer, status, budget_micro, credit_micro, created_at, run_key) VALUES (?,?,?, 'running', ?, ?, ?, ?)"),
    runByKey: db.prepare("SELECT id, status, payer, spent_micro, steps_json FROM runs WHERE decision_id = ? AND run_key = ?"),
    releaseRunKey: db.prepare("UPDATE runs SET run_key = NULL WHERE id = ?"),
    finishRun: db.prepare("UPDATE runs SET status = ?, spent_micro = ?, steps_json = ?, finished_at = ? WHERE id = ?"),
    getRun: db.prepare("SELECT * FROM runs WHERE id = ?"),
    payerSince: db.prepare("SELECT COALESCE(SUM(spent_micro),0) AS s FROM runs WHERE payer = ? AND created_at >= ?"),
    // A run older than the longest possible run is not "running" for the caps.
    payerRunning: db.prepare("SELECT COALESCE(SUM(budget_micro),0) AS s FROM runs WHERE payer = ? AND status = 'running' AND created_at >= ?"),
    // The global ceiling guards the spending wallet: it counts what left for
    // outside sellers (holds included), not our own tools' list prices.
    globalSince: db.prepare("SELECT COALESCE(SUM(micro),0) AS s FROM seller_spend WHERE created_at >= ?"),
    globalRunning: db.prepare("SELECT COALESCE(SUM(budget_micro),0) AS s FROM runs WHERE status = 'running' AND created_at >= ?"),
    sellerSpend: db.prepare("INSERT INTO seller_spend (run_id, seller, micro, created_at) VALUES (?,?,?,?)"),
    sellerHoldSet: db.prepare("UPDATE seller_spend SET micro = ? WHERE rowid = ?"),
    sellerHoldDrop: db.prepare("DELETE FROM seller_spend WHERE rowid = ?"),
    sellerSince: db.prepare("SELECT COALESCE(SUM(micro),0) AS s FROM seller_spend WHERE seller = ? AND created_at >= ?"),
  };
}

const defaultPath = () => process.env.DECIDE_LEDGER_DB || join(existsSync("/data") ? "/data" : "/tmp", "agent402-decide.db");

/**
 * Open the ledger. Without a state database every method is synchronous;
 * with one (STATE_DATABASE_URL) every method returns a promise, and
 * `getDecisionSync` / `creditAvailableUsdSync` are the two mirror reads the
 * synchronous 402 quote uses (`ledger.async` tells the two apart).
 */
export function openDecideLedger(path = defaultPath()) {
  return stateDbEnabled() ? openDatabaseLedger(path) : openFileLedger(path);
}

function openFileLedger(path) {
  const db = new Database(path);
  ensureSqliteSchema(db);

  // A run still "running" when this process starts was cut off by a restart:
  // it will never finish, and must not hold spend-ceiling headroom forever.
  // Its whole budget is booked as spent: a cut-off run may have paid sellers,
  // and an unknown spend must count against the ceilings, not vanish.
  db.prepare("UPDATE runs SET status = 'abandoned', spent_micro = budget_micro, finished_at = ? WHERE status = 'running'").run(Date.now());
  // Retention: decisions, credits, runs and feedback older than 30 days go.
  {
    const cut = Date.now() - RETENTION_MS;
    db.prepare("DELETE FROM decisions WHERE created_at < ?").run(cut);
    db.prepare("DELETE FROM seller_spend WHERE created_at < ?").run(cut);
    db.prepare("DELETE FROM credits WHERE expires_at < ?").run(cut);
    db.prepare("DELETE FROM runs WHERE created_at < ?").run(cut);
    db.prepare("DELETE FROM feedback WHERE created_at < ?").run(cut);
  }

  const st = prepareSqlite(db);
  const payerExposure = (payer, sinceMs, now) => usd(st.payerSince.get(payer || "", sinceMs).s + st.payerRunning.get(payer || "", now - RUN_MAX_MS).s);
  const globalExposure = (sinceMs, now) => usd(st.globalSince.get(sinceMs).s + st.globalRunning.get(now - RUN_MAX_MS).s);
  const insertRun = ({ runId, decisionId, payer, budgetUsd, creditUsd, runKey, now }) => {
    try { st.createRun.run(runId, decisionId, payer || null, micro(budgetUsd), micro(creditUsd), now, runKey); return true; }
    catch (e) { if (runKey && /UNIQUE/.test(String(e?.message))) return false; throw e; }
  };
  // The caps and the booking in one transaction (see bookRun).
  const bookRunTx = db.transaction((o) => {
    const payer = o.payer || null;
    const reason = capRefusal(o.caps, o.budgetUsd, payer, {
      payerHour: o.caps ? payerExposure(payer, o.caps.hourSinceMs, o.now) : 0,
      globalDay: o.caps ? globalExposure(o.caps.daySinceMs, o.now) : 0,
      payerDay: o.caps ? payerExposure(payer, o.caps.daySinceMs, o.now) : 0,
    });
    if (reason) return { ok: false, reason };
    return insertRun(o) ? { ok: true } : { ok: false, reason: "key" };
  });
  const holdTx = db.transaction(({ runId, seller, amountUsd, now, capUsd, sinceMs }) => {
    if (capUsd != null && usd(st.sellerSince.get(String(seller), sinceMs).s) + amountUsd > capUsd) return false;
    return Number(st.sellerSpend.run(runId, String(seller), micro(amountUsd), now).lastInsertRowid);
  });

  const api = {
    db,
    async: false,
    ready: Promise.resolve(),
    saveDecision({ decisionId, depth, priceUsd, payer, plan, costViaUsd, feedbackHash = null, now = Date.now() }) {
      st.saveDecision.run(decisionId, now, depth, micro(priceUsd), payer || null, JSON.stringify(plan), micro(costViaUsd), feedbackHash);
    },
    /** True when `token` is the feedback token minted with this decision, the
     *  decision's payment settled, and it is no older than `maxAgeMs`. */
    feedbackTokenOk(decisionId, token, { now = Date.now(), maxAgeMs = 7 * 86_400_000 } = {}) {
      if (typeof token !== "string" || !token) return false;
      const r = st.getDecision.get(String(decisionId || ""));
      return !!r && !!r.feedback_hash && r.feedback_hash === hashToken(token) && r.settled === 1 && now - r.created_at <= maxAgeMs;
    },
    /** One verdict per (decision, step); a later report replaces it. Returns
     *  true when this replaced an earlier one. */
    saveFeedback({ decisionId, step, toolId, outcome, quality = null, latencyMs = null, now = Date.now() }) {
      const had = !!st.feedbackExisting.get(decisionId, step);
      st.feedback.run(decisionId, step, toolId || null, outcome, quality, latencyMs, now);
      return had;
    },
    getDecision(id) {
      const r = st.getDecision.get(String(id || ""));
      if (!r) return null;
      return { id: r.id, createdAt: r.created_at, depth: r.depth, priceUsd: usd(r.price_micro), payer: r.payer, plan: JSON.parse(r.plan_json), costViaUsd: usd(r.cost_via_micro), settled: !!r.settled };
    },
    markDecisionSettled(id) { st.settleDecision.run(id); },

    /** `expiresAt` wins over `ttlMs`: a leftover credit inherits its decision's
     *  expiry, so no credit ever outlives the decision it came from. */
    mintCredit({ decisionId, amountUsd, ttlMs, expiresAt: fixedExpiry = null, payer, now = Date.now() }) {
      const token = `dc_${randomBytes(24).toString("base64url")}`;
      const expiresAt = Number.isFinite(fixedExpiry) ? fixedExpiry : now + ttlMs;
      st.mint.run(hashToken(token), decisionId, payer || null, micro(amountUsd), expiresAt, now);
      return { token, hash: hashToken(token), amountUsd: usd(micro(amountUsd)), expiresAt };
    },
    activateCredit(hash) { return st.activate.run(hash).changes === 1; },
    /** Spendable amount of a credit for this decision right now, or 0. Read-only. */
    creditAvailableUsd(token, decisionId, now = Date.now()) {
      if (typeof token !== "string" || !token) return 0;
      const r = st.credit.get(hashToken(token));
      if (!r || r.decision_id !== decisionId || r.state !== "active" || r.expires_at <= now) return 0;
      return usd(r.amount_micro);
    },
    creditState(token) { const r = typeof token === "string" ? st.credit.get(hashToken(token)) : null; return r ? { state: r.state, expiresAt: r.expires_at, amountUsd: usd(r.amount_micro), decisionId: r.decision_id } : null; },
    /** Atomic: exactly one run can redeem a credit. Returns the amount or 0. */
    redeemCredit(token, decisionId, runId, now = Date.now()) {
      if (typeof token !== "string" || !token) return 0;
      const h = hashToken(token);
      const ok = st.redeem.run(runId, h, decisionId, now).changes === 1;
      return ok ? usd(st.credit.get(h).amount_micro) : 0;
    },
    restoreCredit(token, runId) { if (typeof token === "string" && token) st.restore.run(hashToken(token), runId); },

    /** Returns false when a run with this (decision, runKey) already exists. */
    createRun({ runId, decisionId, payer, budgetUsd, creditUsd, runKey = null, now = Date.now() }) {
      return insertRun({ runId, decisionId, payer, budgetUsd, creditUsd, runKey, now });
    },
    /** createRun with the spend ceilings checked in the SAME atomic step as the
     *  booking: `caps` = { payerHourUsd, payerDayUsd, globalDayUsd (null when
     *  the plan pays no outside seller), hourSinceMs, daySinceMs }. Answers
     *  { ok: true } or { ok: false, reason: "key" | "payerHour" | "global" |
     *  "payerDay" }; a refused booking writes nothing. */
    bookRun({ runId, decisionId, payer, budgetUsd, creditUsd, runKey = null, now = Date.now(), caps = null }) {
      return bookRunTx({ runId, decisionId, payer, budgetUsd, creditUsd, runKey, now, caps });
    },
    runByKey(decisionId, runKey) {
      const r = runKey ? st.runByKey.get(decisionId, runKey) : null;
      if (!r) return null;
      let steps = [];
      try { steps = JSON.parse(r.steps_json || "[]"); } catch { /* keep [] */ }
      return { id: r.id, status: r.status, payer: r.payer, spentUsd: usd(r.spent_micro), steps };
    },
    // A run that failed having spent nothing frees its key, so the same key can
    // be retried; any run that spent keeps it (a retry must not pay twice).
    finishRun({ runId, status, spentUsd, steps, now = Date.now() }) {
      st.finishRun.run(status, micro(spentUsd), JSON.stringify(steps || []), now, runId);
      if (status === "failed" && !(micro(spentUsd) > 0)) st.releaseRunKey.run(runId);
    },
    getRun(id) { const r = st.getRun.get(id); return r ? { ...r, budgetUsd: usd(r.budget_micro), spentUsd: usd(r.spent_micro), creditUsd: usd(r.credit_micro), steps: JSON.parse(r.steps_json) } : null; },
    /** Spent in the window plus everything still running (its whole budget). */
    payerExposureUsd(payer, sinceMs, now = Date.now()) { return payerExposure(payer, sinceMs, now); },
    /** What an outside seller was paid (or may have been paid) through runs. */
    noteSellerSpend({ runId, seller, amountUsd, now = Date.now() }) { if (seller && amountUsd > 0) st.sellerSpend.run(runId, String(seller), micro(amountUsd), now); },
    // Book a leg's worst case against the seller BEFORE paying, so concurrent
    // runs see it; settle it to what actually left once the leg is known
    // (0 removes it). Returns the hold's id, or null when nothing was booked.
    // With `capUsd` (and `sinceMs`) the seller's daily ceiling is checked in
    // the same atomic step: `false` means the hold would cross it (nothing booked).
    holdSellerSpend({ runId, seller, amountUsd, now = Date.now(), capUsd = null, sinceMs = 0 }) {
      if (!seller || !(amountUsd > 0)) return null;
      return holdTx({ runId, seller, amountUsd, now, capUsd, sinceMs });
    },
    settleSellerHold(holdId, amountUsd) {
      if (holdId == null || holdId === false) return;
      if (amountUsd > 0) st.sellerHoldSet.run(micro(amountUsd), holdId); else st.sellerHoldDrop.run(holdId);
    },
    sellerSpendUsd(seller, sinceMs) { return usd(st.sellerSince.get(String(seller || ""), sinceMs).s); },
    globalExposureUsd(sinceMs, now = Date.now()) { return globalExposure(sinceMs, now); },
  };
  // The synchronous reads the 402 quote uses: on this backend, the reads themselves.
  api.getDecisionSync = api.getDecision;
  api.creditAvailableUsdSync = api.creditAvailableUsd;
  return api;
}

// ---- state database backend --------------------------------------------------

const PG_DDL = (T) => `
  CREATE TABLE IF NOT EXISTS ${T("decisions")} (
    id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, depth TEXT NOT NULL,
    price_micro BIGINT NOT NULL, payer TEXT, plan_json TEXT NOT NULL,
    cost_via_micro BIGINT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, feedback_hash TEXT
  );
  CREATE TABLE IF NOT EXISTS ${T("credits")} (
    token_hash TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT,
    amount_micro BIGINT NOT NULL, expires_at BIGINT NOT NULL,
    state TEXT NOT NULL, run_id TEXT, created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decide_ledger_credits_decision ON ${T("credits")} (decision_id);
  CREATE TABLE IF NOT EXISTS ${T("runs")} (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, payer TEXT, status TEXT NOT NULL,
    budget_micro BIGINT NOT NULL, spent_micro BIGINT NOT NULL DEFAULT 0,
    credit_micro BIGINT NOT NULL DEFAULT 0, steps_json TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL, finished_at BIGINT, run_key TEXT
  );
  CREATE INDEX IF NOT EXISTS decide_ledger_runs_payer ON ${T("runs")} (payer, created_at);
  CREATE INDEX IF NOT EXISTS decide_ledger_runs_created ON ${T("runs")} (created_at);
  CREATE INDEX IF NOT EXISTS decide_ledger_runs_status ON ${T("runs")} (status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS decide_ledger_runs_decision_key ON ${T("runs")} (decision_id, run_key) WHERE run_key IS NOT NULL;
  CREATE TABLE IF NOT EXISTS ${T("feedback")} (
    decision_id TEXT NOT NULL, step INTEGER NOT NULL, tool_id TEXT,
    outcome TEXT NOT NULL, quality INTEGER, latency_ms INTEGER, created_at BIGINT NOT NULL,
    PRIMARY KEY (decision_id, step)
  );
  CREATE TABLE IF NOT EXISTS ${T("seller_spend")} (
    id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL, seller TEXT NOT NULL, micro BIGINT NOT NULL, created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decide_ledger_seller_spend_seller ON ${T("seller_spend")} (seller, created_at);
  CREATE INDEX IF NOT EXISTS decide_ledger_seller_spend_created ON ${T("seller_spend")} (created_at);
`;
const num = (v) => (v == null ? null : Number(v));

function openDatabaseLedger(path) {
  const schema = stateDbSchema();
  const T = (t) => `${schema}.decide_ledger_${t}`;
  const q = (text, params = []) => stateQuery(text, params);
  const log = (m) => console.log(`[decide] ledger: ${m}`);
  const warn = (m) => console.warn(`[decide] ledger: ${m}`);

  // Write-through to the SQLite file while it exists: the same statements the
  // file backend runs, after the database write. Best effort, logged once.
  let wt = null;
  let wtWarned = false;
  const sellerHoldRowid = new Map(); // database hold id -> file rowid
  if (existsSync(path)) {
    try { const fdb = new Database(path); ensureSqliteSchema(fdb); wt = prepareSqlite(fdb); }
    catch (e) { warn(`write-through to ${basename(path)} is off: ${String(e?.message || e).slice(0, 120)}`); }
  }
  const through = (fn) => {
    if (!wt) return;
    try { fn(wt); }
    catch (e) { if (!wtWarned) { wtWarned = true; warn(`write-through to ${basename(path)} failed: ${String(e?.message || e).slice(0, 120)}`); } }
  };

  // Mirror for the synchronous quote reads.
  const decisions = new Map();
  const credits = new Map();
  const rowDecision = (r) => (r ? { id: r.id, createdAt: num(r.created_at), depth: r.depth, priceUsd: usd(r.price_micro), payer: r.payer, plan: JSON.parse(r.plan_json), costViaUsd: usd(r.cost_via_micro), settled: num(r.settled) === 1, feedbackHash: r.feedback_hash || null } : null);
  const rowCredit = (r) => (r ? { hash: r.token_hash, decisionId: r.decision_id, payer: r.payer, amountMicro: num(r.amount_micro), expiresAt: num(r.expires_at), state: r.state, runId: r.run_id, createdAt: num(r.created_at) } : null);
  const publicDecision = ({ feedbackHash, ...d }) => d;
  const remember = (d) => { if (d) decisions.set(d.id, d); return d; };
  const rememberCredit = (c) => { if (c) credits.set(c.hash, c); return c; };
  function pruneMirror(now = Date.now()) {
    if (decisions.size + credits.size < 10_000) return;
    for (const [id, d] of decisions) if (d.createdAt < now - RETENTION_MS) decisions.delete(id);
    for (const [h, c] of credits) if (c.expiresAt <= now) credits.delete(h);
  }
  // A missing or not-yet-final mirror entry is refreshed in the background,
  // once per id at a time and not more than once every few seconds, so the
  // paid retry of a quote sees what another container wrote.
  const refreshing = new Set();
  const refreshedAt = new Map();
  function refresh(key, run) {
    if (refreshing.has(key)) return;
    const last = refreshedAt.get(key);
    if (last && Date.now() - last < 3000) return;
    if (refreshedAt.size > 5000) refreshedAt.clear();
    refreshedAt.set(key, Date.now());
    refreshing.add(key);
    Promise.resolve().then(run).catch(() => {}).finally(() => refreshing.delete(key));
  }

  async function importFile() {
    const name = basename(path);
    return importOnce(name, {
      source: path,
      run: async () => {
        if (!existsSync(path)) return { bytes: 0, rows: 0 };
        let src;
        try { src = new Database(path, { readonly: true, fileMustExist: true }); }
        catch { src = new Database(path, { fileMustExist: true }); }
        let rows = 0;
        try {
          const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
          if (tables.has("decisions")) for (const r of src.prepare("SELECT * FROM decisions").all()) {
            await q(`INSERT INTO ${T("decisions")} (id, created_at, depth, price_micro, payer, plan_json, cost_via_micro, settled, feedback_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
              [r.id, r.created_at, r.depth, r.price_micro, r.payer ?? null, r.plan_json, r.cost_via_micro, r.settled ? 1 : 0, r.feedback_hash ?? null]); rows++;
          }
          if (tables.has("credits")) for (const r of src.prepare("SELECT * FROM credits").all()) {
            await q(`INSERT INTO ${T("credits")} (token_hash, decision_id, payer, amount_micro, expires_at, state, run_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (token_hash) DO NOTHING`,
              [r.token_hash, r.decision_id, r.payer ?? null, r.amount_micro, r.expires_at, r.state, r.run_id ?? null, r.created_at]); rows++;
          }
          if (tables.has("runs")) for (const r of src.prepare("SELECT * FROM runs").all()) {
            await q(`INSERT INTO ${T("runs")} (id, decision_id, payer, status, budget_micro, spent_micro, credit_micro, steps_json, created_at, finished_at, run_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
              [r.id, r.decision_id, r.payer ?? null, r.status, r.budget_micro, r.spent_micro ?? 0, r.credit_micro ?? 0, r.steps_json ?? "[]", r.created_at, r.finished_at ?? null, r.run_key ?? null]); rows++;
          }
          if (tables.has("feedback")) for (const r of src.prepare("SELECT * FROM feedback").all()) {
            await q(`INSERT INTO ${T("feedback")} (decision_id, step, tool_id, outcome, quality, latency_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (decision_id, step) DO NOTHING`,
              [r.decision_id, r.step, r.tool_id ?? null, r.outcome, r.quality ?? null, r.latency_ms ?? null, r.created_at]); rows++;
          }
          if (tables.has("seller_spend")) for (const r of src.prepare("SELECT * FROM seller_spend").all()) {
            await q(`INSERT INTO ${T("seller_spend")} (run_id, seller, micro, created_at) VALUES ($1,$2,$3,$4)`, [r.run_id, r.seller, r.micro, r.created_at]); rows++;
          }
        } finally { src.close(); }
        log(`imported ${rows} row(s) from ${name}`);
        return { bytes: statSync(path).size, rows };
      },
    });
  }
  async function boot() {
    const now = Date.now();
    // A run still "running" past the longest possible run was cut off (a
    // restart; a container that is gone). Only those: a younger one may be
    // running in the other container of a deploy's overlap. Its whole budget
    // is booked as spent, so an unknown spend counts against the ceilings.
    await q(`UPDATE ${T("runs")} SET status = 'abandoned', spent_micro = budget_micro, finished_at = $1 WHERE status = 'running' AND created_at < $2`, [now, now - RUN_MAX_MS]);
    const cut = now - RETENTION_MS;
    await q(`DELETE FROM ${T("decisions")} WHERE created_at < $1`, [cut]);
    await q(`DELETE FROM ${T("seller_spend")} WHERE created_at < $1`, [cut]);
    await q(`DELETE FROM ${T("credits")} WHERE expires_at < $1`, [cut]);
    await q(`DELETE FROM ${T("runs")} WHERE created_at < $1`, [cut]);
    await q(`DELETE FROM ${T("feedback")} WHERE created_at < $1`, [cut]);
  }
  async function loadMirror() {
    const now = Date.now();
    for (const r of (await q(`SELECT * FROM ${T("decisions")} WHERE created_at >= $1`, [now - RETENTION_MS])).rows) remember(rowDecision(r));
    for (const r of (await q(`SELECT * FROM ${T("credits")} WHERE expires_at > $1`, [now])).rows) rememberCredit(rowCredit(r));
  }
  const ready = (async () => { await q(PG_DDL(T)); await importFile(); await boot(); await loadMirror(); })();
  ready.catch((e) => console.error("[decide] ledger: database setup failed:", String(e?.message || e).slice(0, 200)));
  trackStoreReady(ready);

  const getDecisionRow = async (id) => remember(rowDecision((await q(`SELECT * FROM ${T("decisions")} WHERE id = $1`, [String(id || "")])).rows[0]));
  const getCreditRow = async (hash) => rememberCredit(rowCredit((await q(`SELECT * FROM ${T("credits")} WHERE token_hash = $1`, [hash])).rows[0]));
  const sum = (r) => Number(r.rows[0]?.s || 0);
  const payerExposureWith = async (run, payer, sinceMs, now) => usd(
    sum(await run(`SELECT COALESCE(SUM(spent_micro),0)::bigint AS s FROM ${T("runs")} WHERE payer = $1 AND created_at >= $2`, [payer || "", sinceMs]))
    + sum(await run(`SELECT COALESCE(SUM(budget_micro),0)::bigint AS s FROM ${T("runs")} WHERE payer = $1 AND status = 'running' AND created_at >= $2`, [payer || "", now - RUN_MAX_MS])));
  const globalExposureWith = async (run, sinceMs, now) => usd(
    sum(await run(`SELECT COALESCE(SUM(micro),0)::bigint AS s FROM ${T("seller_spend")} WHERE created_at >= $1`, [sinceMs]))
    + sum(await run(`SELECT COALESCE(SUM(budget_micro),0)::bigint AS s FROM ${T("runs")} WHERE status = 'running' AND created_at >= $1`, [now - RUN_MAX_MS])));
  const insertRunWith = async (run, { runId, decisionId, payer, budgetUsd, creditUsd, runKey, now }) => {
    const r = await run(`INSERT INTO ${T("runs")} (id, decision_id, payer, status, budget_micro, credit_micro, created_at, run_key) VALUES ($1,$2,$3,'running',$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [runId, decisionId, payer || null, micro(budgetUsd), micro(creditUsd), now, runKey]);
    if (r.rowCount === 1) { through((w) => w.createRun.run(runId, decisionId, payer || null, micro(budgetUsd), micro(creditUsd), now, runKey)); return true; }
    if (runKey) return false;
    throw new Error("run id already exists");
  };

  const api = {
    db: null,
    async: true,
    ready,
    async saveDecision({ decisionId, depth, priceUsd, payer, plan, costViaUsd, feedbackHash = null, now = Date.now() }) {
      await ready;
      const planJson = JSON.stringify(plan);
      const r = await q(`INSERT INTO ${T("decisions")} (id, created_at, depth, price_micro, payer, plan_json, cost_via_micro, settled, feedback_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)
        ON CONFLICT (id) DO UPDATE SET created_at = EXCLUDED.created_at, depth = EXCLUDED.depth, price_micro = EXCLUDED.price_micro, payer = EXCLUDED.payer, plan_json = EXCLUDED.plan_json, cost_via_micro = EXCLUDED.cost_via_micro, settled = 0, feedback_hash = EXCLUDED.feedback_hash
        RETURNING *`, [decisionId, now, depth, micro(priceUsd), payer || null, planJson, micro(costViaUsd), feedbackHash]);
      remember(rowDecision(r.rows[0]));
      pruneMirror(now);
      through((w) => w.saveDecision.run(decisionId, now, depth, micro(priceUsd), payer || null, planJson, micro(costViaUsd), feedbackHash));
    },
    async feedbackTokenOk(decisionId, token, { now = Date.now(), maxAgeMs = 7 * 86_400_000 } = {}) {
      await ready;
      if (typeof token !== "string" || !token) return false;
      const d = await getDecisionRow(decisionId);
      return !!d && !!d.feedbackHash && d.feedbackHash === hashToken(token) && d.settled === true && now - d.createdAt <= maxAgeMs;
    },
    async saveFeedback({ decisionId, step, toolId, outcome, quality = null, latencyMs = null, now = Date.now() }) {
      await ready;
      // xmax <> 0 on the returned row: the insert found a row and updated it.
      const r = await q(`INSERT INTO ${T("feedback")} (decision_id, step, tool_id, outcome, quality, latency_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (decision_id, step) DO UPDATE SET tool_id = EXCLUDED.tool_id, outcome = EXCLUDED.outcome, quality = EXCLUDED.quality, latency_ms = EXCLUDED.latency_ms, created_at = EXCLUDED.created_at
        RETURNING (xmax <> 0) AS had`, [decisionId, step, toolId || null, outcome, quality, latencyMs, now]);
      through((w) => w.feedback.run(decisionId, step, toolId || null, outcome, quality, latencyMs, now));
      return r.rows[0]?.had === true;
    },
    async getDecision(id) { await ready; const d = await getDecisionRow(id); return d ? publicDecision(d) : null; },
    async markDecisionSettled(id) {
      await ready;
      await q(`UPDATE ${T("decisions")} SET settled = 1 WHERE id = $1`, [id]);
      const d = decisions.get(id); if (d) d.settled = true;
      through((w) => w.settleDecision.run(id));
    },
    async mintCredit({ decisionId, amountUsd, ttlMs, expiresAt: fixedExpiry = null, payer, now = Date.now() }) {
      await ready;
      const token = `dc_${randomBytes(24).toString("base64url")}`;
      const hash = hashToken(token);
      const expiresAt = Number.isFinite(fixedExpiry) ? fixedExpiry : now + ttlMs;
      const r = await q(`INSERT INTO ${T("credits")} (token_hash, decision_id, payer, amount_micro, expires_at, state, created_at) VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
        [hash, decisionId, payer || null, micro(amountUsd), expiresAt, now]);
      rememberCredit(rowCredit(r.rows[0]));
      through((w) => w.mint.run(hash, decisionId, payer || null, micro(amountUsd), expiresAt, now));
      return { token, hash, amountUsd: usd(micro(amountUsd)), expiresAt };
    },
    async activateCredit(hash) {
      await ready;
      const r = await q(`UPDATE ${T("credits")} SET state = 'active' WHERE token_hash = $1 AND state = 'pending' RETURNING *`, [hash]);
      if (r.rowCount === 1) { rememberCredit(rowCredit(r.rows[0])); through((w) => w.activate.run(hash)); }
      return r.rowCount === 1;
    },
    async creditAvailableUsd(token, decisionId, now = Date.now()) {
      await ready;
      if (typeof token !== "string" || !token) return 0;
      const c = await getCreditRow(hashToken(token));
      if (!c || c.decisionId !== decisionId || c.state !== "active" || c.expiresAt <= now) return 0;
      return usd(c.amountMicro);
    },
    async creditState(token) {
      await ready;
      const c = typeof token === "string" ? await getCreditRow(hashToken(token)) : null;
      return c ? { state: c.state, expiresAt: c.expiresAt, amountUsd: usd(c.amountMicro), decisionId: c.decisionId } : null;
    },
    async redeemCredit(token, decisionId, runId, now = Date.now()) {
      await ready;
      if (typeof token !== "string" || !token) return 0;
      const h = hashToken(token);
      const r = await q(`UPDATE ${T("credits")} SET state = 'redeemed', run_id = $1 WHERE token_hash = $2 AND decision_id = $3 AND state = 'active' AND expires_at > $4 RETURNING *`, [runId, h, decisionId, now]);
      if (r.rowCount !== 1) return 0;
      const c = rememberCredit(rowCredit(r.rows[0]));
      through((w) => w.redeem.run(runId, h, decisionId, now));
      return usd(c.amountMicro);
    },
    async restoreCredit(token, runId) {
      await ready;
      if (typeof token !== "string" || !token) return;
      const h = hashToken(token);
      const r = await q(`UPDATE ${T("credits")} SET state = 'active', run_id = NULL WHERE token_hash = $1 AND state = 'redeemed' AND run_id = $2 RETURNING *`, [h, runId]);
      if (r.rowCount === 1) { rememberCredit(rowCredit(r.rows[0])); through((w) => w.restore.run(h, runId)); }
    },
    async createRun({ runId, decisionId, payer, budgetUsd, creditUsd, runKey = null, now = Date.now() }) {
      await ready;
      return insertRunWith(q, { runId, decisionId, payer, budgetUsd, creditUsd, runKey, now });
    },
    async bookRun({ runId, decisionId, payer, budgetUsd, creditUsd, runKey = null, now = Date.now(), caps = null }) {
      await ready;
      return withStateTx(async (c) => {
        const run = (text, params) => c.query(text, params);
        // One booking at a time across every container: the exposures below
        // are read with no other booking in between.
        await run(`SELECT pg_advisory_xact_lock(hashtext('decide-ledger'), hashtext('book-run'))`);
        // A run cut off longer ago than any run can last is booked as spent
        // here, so the ceilings never forget an unknown spend.
        await run(`UPDATE ${T("runs")} SET status = 'abandoned', spent_micro = budget_micro, finished_at = $1 WHERE status = 'running' AND created_at < $2`, [now, now - RUN_MAX_MS]);
        const p = payer || null;
        if (caps) {
          const reason = capRefusal(caps, budgetUsd, p, {
            payerHour: p ? await payerExposureWith(run, p, caps.hourSinceMs, now) : 0,
            globalDay: caps.globalDayUsd != null ? await globalExposureWith(run, caps.daySinceMs, now) : 0,
            payerDay: p ? await payerExposureWith(run, p, caps.daySinceMs, now) : 0,
          });
          if (reason) return { ok: false, reason };
        }
        const booked = await insertRunWith(run, { runId, decisionId, payer, budgetUsd, creditUsd, runKey, now });
        return booked ? { ok: true } : { ok: false, reason: "key" };
      });
    },
    async runByKey(decisionId, runKey) {
      await ready;
      const r = runKey ? (await q(`SELECT id, status, payer, spent_micro, steps_json FROM ${T("runs")} WHERE decision_id = $1 AND run_key = $2`, [decisionId, runKey])).rows[0] : null;
      if (!r) return null;
      let steps = [];
      try { steps = JSON.parse(r.steps_json || "[]"); } catch { /* keep [] */ }
      return { id: r.id, status: r.status, payer: r.payer, spentUsd: usd(r.spent_micro), steps };
    },
    async finishRun({ runId, status, spentUsd, steps, now = Date.now() }) {
      await ready;
      const stepsJson = JSON.stringify(steps || []);
      await q(`UPDATE ${T("runs")} SET status = $1, spent_micro = $2, steps_json = $3, finished_at = $4 WHERE id = $5`, [status, micro(spentUsd), stepsJson, now, runId]);
      const release = status === "failed" && !(micro(spentUsd) > 0);
      if (release) await q(`UPDATE ${T("runs")} SET run_key = NULL WHERE id = $1`, [runId]);
      through((w) => { w.finishRun.run(status, micro(spentUsd), stepsJson, now, runId); if (release) w.releaseRunKey.run(runId); });
    },
    async getRun(id) {
      await ready;
      const r = (await q(`SELECT * FROM ${T("runs")} WHERE id = $1`, [id])).rows[0];
      if (!r) return null;
      const row = { ...r, budget_micro: num(r.budget_micro), spent_micro: num(r.spent_micro), credit_micro: num(r.credit_micro), created_at: num(r.created_at), finished_at: num(r.finished_at) };
      return { ...row, budgetUsd: usd(row.budget_micro), spentUsd: usd(row.spent_micro), creditUsd: usd(row.credit_micro), steps: JSON.parse(r.steps_json) };
    },
    async payerExposureUsd(payer, sinceMs, now = Date.now()) { await ready; return payerExposureWith(q, payer, sinceMs, now); },
    async noteSellerSpend({ runId, seller, amountUsd, now = Date.now() }) {
      await ready;
      if (!(seller && amountUsd > 0)) return;
      await q(`INSERT INTO ${T("seller_spend")} (run_id, seller, micro, created_at) VALUES ($1,$2,$3,$4)`, [runId, String(seller), micro(amountUsd), now]);
      through((w) => w.sellerSpend.run(runId, String(seller), micro(amountUsd), now));
    },
    async holdSellerSpend({ runId, seller, amountUsd, now = Date.now(), capUsd = null, sinceMs = 0 }) {
      await ready;
      if (!seller || !(amountUsd > 0)) return null;
      const id = await withStateTx(async (c) => {
        const run = (text, params) => c.query(text, params);
        if (capUsd != null) {
          await run(`SELECT pg_advisory_xact_lock(hashtext('decide-ledger'), hashtext($1))`, [`seller:${seller}`]);
          const spent = usd(sum(await run(`SELECT COALESCE(SUM(micro),0)::bigint AS s FROM ${T("seller_spend")} WHERE seller = $1 AND created_at >= $2`, [String(seller), sinceMs])));
          if (spent + amountUsd > capUsd) return false;
        }
        const r = await run(`INSERT INTO ${T("seller_spend")} (run_id, seller, micro, created_at) VALUES ($1,$2,$3,$4) RETURNING id`, [runId, String(seller), micro(amountUsd), now]);
        return Number(r.rows[0].id);
      });
      if (id !== false) through((w) => { sellerHoldRowid.set(id, Number(w.sellerSpend.run(runId, String(seller), micro(amountUsd), now).lastInsertRowid)); });
      return id;
    },
    async settleSellerHold(holdId, amountUsd) {
      await ready;
      if (holdId == null || holdId === false) return;
      if (amountUsd > 0) await q(`UPDATE ${T("seller_spend")} SET micro = $1 WHERE id = $2`, [micro(amountUsd), holdId]);
      else await q(`DELETE FROM ${T("seller_spend")} WHERE id = $1`, [holdId]);
      const rowid = sellerHoldRowid.get(holdId);
      if (rowid != null) { sellerHoldRowid.delete(holdId); through((w) => { if (amountUsd > 0) w.sellerHoldSet.run(micro(amountUsd), rowid); else w.sellerHoldDrop.run(rowid); }); }
    },
    async sellerSpendUsd(seller, sinceMs) {
      await ready;
      return usd(sum(await q(`SELECT COALESCE(SUM(micro),0)::bigint AS s FROM ${T("seller_spend")} WHERE seller = $1 AND created_at >= $2`, [String(seller || ""), sinceMs])));
    },
    async globalExposureUsd(sinceMs, now = Date.now()) { await ready; return globalExposureWith(q, sinceMs, now); },

    // ---- synchronous mirror reads (the 402 quote) -------------------------
    getDecisionSync(id) {
      const key = String(id || "");
      const d = decisions.get(key);
      if (!d || !d.settled) refresh(`d:${key}`, () => getDecisionRow(key));
      return d ? publicDecision(d) : null;
    },
    creditAvailableUsdSync(token, decisionId, now = Date.now()) {
      if (typeof token !== "string" || !token) return 0;
      const h = hashToken(token);
      const c = credits.get(h);
      if (!c || c.state === "pending") refresh(`c:${h}`, () => getCreditRow(h));
      if (!c || c.decisionId !== decisionId || c.state !== "active" || c.expiresAt <= now) return 0;
      return usd(c.amountMicro);
    },
  };
  return api;
}
