// credits - PREPAID CARD CREDITS for the tool catalog: a person buys a pack (CREDIT_PACKS) by card (Stripe
// Checkout), gets an `a402_...` key ONCE, and spends it across every paid tool
// with `Authorization: Bearer a402_...` - the card-native equivalent of the
// per-call x402 model, for buyers who will not hold a wallet.
//
// Money discipline (mirrors the x402 paywall):
// - A key is minted only for a Stripe-verified PAID session, exactly once per
//   session (the session id is indexed; a second claim returns "claimed" and
//   never re-shows the key).
// - The gate AUTHORIZES before the handler (balance >= the route's list price)
//   and DEBITS only on a final 200 (res "finish"); a 4xx/5xx is never charged.
//   A buyer whose connection closes before the first response byte is not
//   charged while the run holds a forgiveness ticket (the same rule and budget
//   as every other rail, src/hangup-settlement.js); without one the hold
//   settles and is booked as owed. A stream that already began is settled.
//   Balances are integer micro-dollars (sub-cent prices like $0.001 are exact).
// - Keys are stored HASHED (sha256); the plaintext exists only in the claim
//   response / email. Per-key files under /data/credits, atomic tmp+rename.
// - Accounting: every debit is a sale on the "credits" rail (PAYING_RAILS) with
//   the key id as classification-grade payer; stats count it as viaCredits.
// Rollout switch = STRIPE_SECRET_KEY (shared with the human checkout).
//
// STATE DATABASE. With STATE_DATABASE_URL set (src/state-db.js) every key
// record is a row of the `records` table (collection "credits", id = the key
// file's stem, `k_<hash>`; the claim index is the row `_sessions`), and every
// method that reads or moves money RETURNS A PROMISE: authorize, settle,
// release, charge, balance, status, setDisabled, disableByPaymentIntent,
// keyIdOf, balanceById (claim always did). The gate is then an async
// middleware. Without the database every method answers synchronously, from
// the files, exactly as before. The hold, the debit and the release are each
// one short transaction that locks the key's row (SELECT ... FOR UPDATE), so
// two containers can never double-debit a key; a session is claimed by one
// conditional statement on the index row, so a key is minted once. Reads come
// from the rows (no cache); the first boot with the database on imports the
// directory once. While the directory exists, every row write is also written
// to the key's file (best effort, never the verdict), so a rollback to the
// previous build reads current balances.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { sendEmail } from "./email.js";
import { creditsTopupFields, creditsDailyMaxCents, creditsBalanceMaxCents, creditsTermsVersion, creditsSalesEnabled, purchaseChecks, PURCHASE_REFUSED } from "./credits-sales.js";
import { shared } from "./shared-limits.js";
import { creditsGuards } from "./credits-guards.js";
import { limiterKey } from "./rate-limit.js";
import { chargeCancelledForClientGone, clientGoneBeforeFirstByte, markSettleSent } from "./hangup-settlement.js";
import { meteredUsdOf } from "./gateway-meter.js";
import { envPositive } from "./env-num.js";
import { stateDbEnabled, stateDbSchema, stateQuery, withStateTx, importOnce, imports, trackStoreReady, stateStatementOutsideTx, withLease } from "./state-db.js";
import { getSharedRedisClient } from "./shared-limit.js";
import { sharedLimitsEnabled } from "./shared-limits.js";
import { retryingLoad } from "./store-retry.js";
import { salePathOf } from "./sale-path.js";

// A hold whose buyer left before the first byte is decided when the response
// ends; one that nothing ends within this long is released (call-time read,
// CREDITS_ABANDONED_HOLD_MS, default 10 minutes).
const abandonedHoldMs = () => { const n = Number(process.env.CREDITS_ABANDONED_HOLD_MS); return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000; };
// The longest a running request keeps its hold fresh against the sweep (a
// response that never ends); never under the abandoned window. Call-time read,
// CREDITS_HOLD_REFRESH_MAX_MS, default 6 hours.
export const holdRefreshMaxMs = () => { const n = Number(process.env.CREDITS_HOLD_REFRESH_MAX_MS); return Math.max(abandonedHoldMs(), Number.isFinite(n) && n > 0 ? n : 6 * 60 * 60 * 1000); };

// The packs, smallest first. Every surface that names a pack or its price
// reads this table (the /credits cards, /api/pricing, the share card, the
// checkout's product name), so a pack is added or repriced here alone. `note`
// is the line under the price on /credits.
export const CREDIT_PACKS = {
  "credits-5": { label: "Try", cents: 500, note: "a first key: try the tools before you commit" },
  "credits-10": { label: "Starter", cents: 1000, note: "wire one agent to the catalog and run it end to end" },
  "credits-20": { label: "Regular", cents: 2000, note: "everyday calls across the catalog; never expires" },
  "credits-50": { label: "Builder", cents: 5000, note: "try the whole catalog; research, dossiers, audits included" },
  "credits-100": { label: "Pro", cents: 10000, note: "for a team or an agent fleet; never expires" },
};
// What Stripe records a pack or a top-up as: Nontaxable. The pack is a
// prepayment for our own services, taxed (where a call is taxable) when it is
// spent (src/nc-sales-tax.js), never at sale. Never a gift-card code.
export const CREDITS_TAX_CODE = "txcd_00000000";
// The product a pack or top-up checkout sells, as Stripe shows and records it.
// No name or description calls it a gift card or a wallet
// (scripts/test-credits-terms.js).
export function creditsProductData(p, { topup = false } = {}) {
  const usd = `$${(p.cents / 100).toFixed(0)}`;
  return topup
    ? { name: `Agent402 credits top-up (${usd})`, description: "Added to your existing Agent402 credits balance. A prepayment for Agent402's own pay-per-call services, for business and developer use. Spent per request at list price; never expire; no fees; the unspent balance is refunded to the card that paid on request; not cash, not transferable.", tax_code: CREDITS_TAX_CODE }
    : { name: `Agent402 credits - ${p.label} (${usd})`, description: "A prepayment for Agent402's own pay-per-call services, for business and developer use. Spent per request at list price; never expire; no fees; the unspent balance is refunded to this card on request; not cash, not transferable.", tax_code: CREDITS_TAX_CODE };
}
// A key: the recognizable prefix KEY_PREFIX and 32 random bytes (base64url).
// Keys issued before the prefix ("a402_" and 24 random bytes) keep working;
// KEY_RE matches both, and KEY_SCAN_RE finds one in any text (secret scanning,
// log redaction). Only the key's sha256 is stored.
export const KEY_PREFIX = "a402_ck_";
export const KEY_RE = /^a402_[A-Za-z0-9_-]{32,64}$/;
export const KEY_SCAN_RE = /a402_[A-Za-z0-9_-]{32,64}/g;
export const newKeyString = () => `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
// Disable causes under which a call already running takes nothing more.
const FROZEN = new Set(["disputed", "fraud-warning"]);
// A charge whose card review outcome is one the private table lists
// (src/credits-guards.js flagged) issues nothing. Without the table every
// charge counts as flagged: nothing is issued that the checks did not see.
export const chargeFlagged = (charge) => {
  const f = creditsGuards()?.flagged;
  if (!f) return true;
  const o = charge && typeof charge === "object" ? charge.outcome : null;
  return Boolean(o) && (f.outcomeTypes.includes(String(o.type)) || f.riskLevels.includes(String(o.risk_level)));
};
// The packs on offer: those within the cap on one key's balance
// (creditsBalanceMaxCents, src/credits-sales.js).
// A pack above the daily purchase limit is not offered either: no one buyer
// could complete it.
export const sellablePacks = () => Object.fromEntries(Object.entries(CREDIT_PACKS).filter(([, p]) => p.cents <= Math.min(creditsBalanceMaxCents(), creditsDailyMaxCents())));
// PURCHASE LIMIT. One buyer (matched by email or card fingerprint) may buy at most creditsDailyMaxCents() (src/credits-sales.js) of
// credits in any 24 hours. A purchase that would pass it is refunded in full
// and no key is issued; its session is recorded as refused so a later claim
// answers the same.
export { creditsDailyMaxCents };
// A refused session's index entry: "<kind>:pending" while its refund is
// being made, then "<kind>:refunded" or "<kind>:failed" (a refund to make by
// hand, raised as creditsRefunds on /api/gateway-status). Kinds: "refused"
// (the daily purchase limit) and "refused-taxid" (an EU or UK billing address
// with no business tax ID).
// "refused-cap" is a pack above the cap on one key's balance.
// "refused-topup" is a top-up whose balance can no longer take it (refunded,
// disabled, replaced, or not the signed-in buyer's).
// "refused-review" is a purchase a purchase check refused (src/credits-sales.js
// purchaseChecks, a flagged payment); its answer never names the check.
const REFUSAL_KINDS = { limit: "refused", taxId: "refused-taxid", refunded: "refused-refunded", cap: "refused-cap", topup: "refused-topup", review: "refused-review" };
const isRefused = (v) => typeof v === "string" && v.startsWith("refused");
// "<kind>:pending@<ms>" carries when the refusal began, so a refund stuck
// there (a crash between refusing and refunding) is owed after STUCK_MS.
const refusalOutcome = (v) => (isRefused(v) ? String(v).slice(String(v).lastIndexOf(":") + 1).replace(/@\d+$/, "") : null);
const pendingSince = (v) => { const m = /:pending@(\d+)$/.exec(String(v)); return m ? Number(m[1]) : 0; };
const STUCK_MS = 5 * 60_000;
// A refund Stripe accepted but has not finished (status "pending") waits for
// its webhook; one still pending after this long is owed (creditsRefunds).
const SENT_STUCK_MS = 7 * 86_400_000;
const refusalRefunded = (v) => { const o = refusalOutcome(v); return o === "refunded" ? true : o === "failed" ? false : null; };
// EU member states and the United Kingdom: VAT is due on digital services to
// a consumer there from the first sale, so a buyer billed there gives a
// business tax ID (CREDITS_EU_UK_REQUIRE_TAX_ID=off lifts this).
const EU_UK = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB"]);
const euUkTaxIdRequired = () => !/^(0|false|off|no)$/i.test(String(process.env.CREDITS_EU_UK_REQUIRE_TAX_ID || "").trim());
const DAY_MS = 86_400_000;
const SESSION_RE = /^cs_[A-Za-z0-9_]+$/;
const MICRO = 1_000_000;
// A file written this much later than the newest row was written by a build
// that used the files alone (a rollback); write-through lands within milliseconds.
export const ROLL_FORWARD_GRACE_MS = 60_000;

const DATA_ROOT = () => (existsSync("/data") ? "/data" : "/tmp");
// CREDITS_DIR points the key files elsewhere (a test server keeps its own).
const DEFAULT_DIR = () => String(process.env.CREDITS_DIR || "").trim() || join(DATA_ROOT(), "credits");
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
function writeJsonAtomic(p, obj) {
  try { const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, p); return true; } catch { return false; }
}
export const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");
// A requested refund as one part per payment it draws on. A request written
// before parts existed is one part, on the key's first payment.
export function partsOf(rec) {
  const rr = rec?.refundRequest;
  if (!rr) return [];
  if (Array.isArray(rr.parts)) return rr.parts.map((p) => ({ ...p, ...(Array.isArray(p.failedIds) ? { failedIds: [...p.failedIds] } : {}) }));
  const pi = Array.isArray(rec.paymentIntents) ? rec.paymentIntents[0] || null : null;
  const state = rr.state === "done" ? "done" : rr.state === "failed" ? "failed" : "pending";
  return [{ pi, cents: rr.cents, targetCents: rr.targetCents, state, refundId: rr.refundId || null, ...(Array.isArray(rr.failedIds) ? { failedIds: [...rr.failedIds] } : {}), ...(rr.sentAt ? { sentAt: rr.sentAt } : {}), ...(rr.why ? { why: rr.why } : {}), ...(rr.doneAt ? { doneAt: rr.doneAt } : {}) }];
}
// The request's own state from its parts: done when every part is, failed
// (owed) when any part failed, pending otherwise.
export function withPartsState(rr, parts, now = () => Date.now()) {
  const state = parts.length && parts.every((p) => p.state === "done") ? "done" : parts.some((p) => p.state === "failed") ? "failed" : "pending";
  const out = { micro: rr.micro, cents: rr.cents, at: rr.at, state, parts };
  if (state === "done") out.doneAt = rr.state === "done" && rr.doneAt ? rr.doneAt : new Date(now()).toISOString();
  return out;
}
// The key's history, newest last: charges by tool, purchases, top-ups,
// refunds and new keys, kept to the last HISTORY_MAX entries; byTool keeps
// every tool's running totals.
export const HISTORY_MAX = 300;
export function noteEvent(rec, ev, at = Date.now()) {
  rec.history = [...(Array.isArray(rec.history) ? rec.history : []), { t: at, ...ev }].slice(-HISTORY_MAX);
  if (ev.k === "charge" && ev.slug) {
    const by = { ...(rec.byTool || {}) };
    const cur = Object.hasOwn(by, ev.slug) ? by[ev.slug] : { n: 0, m: 0 };
    if (ev.slug === "__proto__") return;
    by[ev.slug] = { n: (Number(cur.n) || 0) + 1, m: (Number(cur.m) || 0) + (Number(ev.m) || 0) };
    rec.byTool = by;
  }
}
// A balance under LOW_BALANCE_MICRO (with what is held) is low: the
// low-balance notice is sent once each time a charge takes the balance
// across it (src/credits-figures.js, which the copy stating it reads).
import { LOW_BALANCE_MICRO } from "./credits-figures.js";
export { LOW_BALANCE_MICRO };
export const usdToMicro = (usd) => Math.round(Number(usd) * MICRO);

// ONE NORMALIZED EMAIL. The email a balance is found by is normalized once,
// here (trimmed, NFC, lowercased by JS), stored on the key's record as
// `emailKey` beside the email as given, and compared as stored: the balance
// page never lowercases in SQL, whose lower() follows the database's locale
// and does not agree with JS for every letter ("İ"). A row an older build
// wrote without the field is given it at the next load (computed here); until
// then the lookup falls back to lower() of its email.
export function emailKeyOf(email) {
  const e = String(email ?? "").trim().normalize("NFC").toLowerCase();
  return e || null;
}
const sameEmail = (a, b) => { const k = emailKeyOf(a); return k !== null && k === emailKeyOf(b); };
const recEmailKey = (rec) => (typeof rec?.emailKey === "string" && rec.emailKey ? rec.emailKey : emailKeyOf(rec?.email));

// THE BALANCE PAGE'S TWO LOOKUPS and the expression indexes they use (partial,
// on the credits rows of the shared records table). The collection is written
// into the statement so the planner can match the indexes' predicate.
export const CREDITS_LOOKUP_SQL = Object.freeze({
  keyId: (t) => `SELECT id, body FROM ${t} WHERE collection = 'credits' AND id LIKE 'k\\_%' ESCAPE '\\' AND (body->>'keyId') = $1`,
  email: (t) => `SELECT id, body FROM ${t} WHERE collection = 'credits' AND id LIKE 'k\\_%' ESCAPE '\\' AND COALESCE(body->>'emailKey', lower(body->>'email')) = $1`,
});
export const CREDITS_INDEXES = Object.freeze([
  { name: "credits_email_key_idx", expr: "(COALESCE(body->>'emailKey', lower(body->>'email')))" },
  { name: "credits_key_id_idx", expr: "((body->>'keyId'))" },
]);
// Built CONCURRENTLY (writes go on during the build), each statement on a
// connection of its own outside any transaction (Postgres refuses one inside
// a transaction block), never in the boot's schema setup, which runs in one
// transaction under the schema lock. One container builds at a time (the
// lease); an index a failed build left INVALID is dropped and built again.
// The store starts it in the background CREDITS_INDEX_DELAY_MS (default 60 s)
// after its first load; CREDITS_INDEXES=off leaves it to an operator.
export async function ensureCreditsIndexes({ log = console.log } = {}) {
  if (!stateDbEnabled()) return { ran: false, reason: "no-db" };
  const schema = stateDbSchema();
  return withLease("credits-indexes", { ttlMs: 120_000, log }, async () => {
    const have = async () => new Map((await stateQuery(
      `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2)`,
      [schema, CREDITS_INDEXES.map((x) => x.name)],
    )).rows.map((r) => [r.name, r.valid === true]));
    const found = await have();
    const built = [], rebuilt = [];
    for (const ix of CREDITS_INDEXES) {
      if (found.get(ix.name) === true) continue;
      if (found.has(ix.name)) {
        await stateStatementOutsideTx(`DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${ix.name}`);
        rebuilt.push(ix.name);
      }
      const t0 = Date.now();
      await stateStatementOutsideTx(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix.name} ON ${schema}.records ${ix.expr} WHERE collection = 'credits'`);
      built.push(ix.name);
      log(`[credits] index ${ix.name} built concurrently in ${Date.now() - t0} ms${rebuilt.includes(ix.name) ? " (an invalid one was dropped first)" : ""}`);
    }
    return { built, rebuilt };
  });
}
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
// A key's per-grant day records: only today's are kept.
const pruneGrantDays = (days, day) => Object.fromEntries(Object.entries(days || {}).filter(([, g]) => g?.d === day));
export const microToUsd = (m) => Math.round(Number(m) / 100) / 10000; // 4 dp

/**
 * @param {object} deps
 * @param {import("stripe")} deps.stripe
 * @param {string} deps.baseUrl
 * @param {string} [deps.storeDir]
 * @param {(sale:object)=>void} [deps.onDebit]   accounting hook per charged call
 * @param {(sale:object)=>void} [deps.onLoad]    accounting hook per pack purchase
 * @param {(n:object)=>void} [deps.onLowBalance] a charge took a key under LOW_BALANCE_MICRO (sales on)
 * @param {(r:object)=>void} [deps.onReceipt]    a purchase or top-up was loaded (sales on)
 * @param {()=>number} [deps.now]
 * @param {(s:string)=>void} [deps.log]
 */
// True when the answer was served with no handler run that this hold pays
// for: the pre-paywall gateway cache (it marks req.gatewayCacheHit) or an
// idempotent replay of a call this key already paid for.
function servedWithoutRun(req, res) {
  return req?.gatewayCacheHit === true
    || String(res.getHeader?.("X-Idempotent-Replay") || "").toLowerCase() === "true";
}

export function createCredits({ stripe, baseUrl, storeDir, onDebit, onLoad, onLowBalance = null, onReceipt = null, onNewKey = null, onSpendLimit = null, tagSecret = null, now = () => Date.now(), log = console.log }) {
  const dir = storeDir || DEFAULT_DIR();
  try { mkdirSync(dir, { recursive: true }); } catch { /* writes fail loudly below */ }
  const SESSIONS = join(dir, "_sessions.json"); // sessionId -> key hash (claim-once)
  const WARNED = join(dir, "_warned.json"); // paymentIntent -> { at } (a fraud warning before any key)
  const recPath = (hash) => join(dir, `k_${hash}.json`);
  const usePg = stateDbEnabled();
  const cache = new Map(); // hash -> record (write-through; file backend only)

  const load = (hash) => cache.get(hash) || (() => { const r = readJson(recPath(hash)); if (r) cache.set(hash, r); return r; })();
  function save(hash, rec) { cache.set(hash, rec); writeJsonAtomic(recPath(hash), rec); idxPut(hash, rec); }
  // The file store's lookup index (key id -> hash, email -> hashes), built on
  // the first lookup from the files and kept by every write here, so the
  // balance page reads one record instead of every key file.
  let fileIdx = null;
  function idxForget(hash) {
    const o = fileIdx?.of.get(hash);
    if (!o) return;
    fileIdx.of.delete(hash);
    if (o.k && fileIdx.byKeyId.get(o.k) === hash) fileIdx.byKeyId.delete(o.k);
    const set = fileIdx.byEmail.get(o.e);
    if (set) { set.delete(hash); if (!set.size) fileIdx.byEmail.delete(o.e); }
  }
  function idxPut(hash, rec) {
    if (!fileIdx) return;
    idxForget(hash);
    if (!rec) return;
    const k = typeof rec.keyId === "string" ? rec.keyId : "", e = recEmailKey(rec) || "";
    fileIdx.of.set(hash, { k, e });
    if (k) fileIdx.byKeyId.set(k, hash);
    if (e) { let set = fileIdx.byEmail.get(e); if (!set) fileIdx.byEmail.set(e, (set = new Set())); set.add(hash); }
  }
  function fileIndex() {
    if (!fileIdx) {
      fileIdx = { byKeyId: new Map(), byEmail: new Map(), of: new Map() };
      for (const f of keyFiles()) { const hash = f.slice(2, -5); idxPut(hash, load(hash)); }
    }
    return fileIdx;
  }
  const sessionsIdx = () => readJson(SESSIONS) || {};
  const warnedIdx = () => readJson(WARNED) || {};
  const keyFiles = () => { try { return readdirSync(dir).filter((f) => f.startsWith("k_") && f.endsWith(".json")); } catch { return []; } };

  // ---- state database primitives ------------------------------------------
  const COLL = "credits";
  const recId = (hash) => `k_${hash}`;
  const RT = () => `${stateDbSchema()}.records`;
  const pgGet = async (id) => (await stateQuery(`SELECT body FROM ${RT()} WHERE collection = $1 AND id = $2`, [COLL, id])).rows[0]?.body ?? null;
  const pgPutIfAbsent = async (id, body) => (await stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO NOTHING`, [COLL, id, JSON.stringify(body)])).rowCount === 1;
  const pgDel = async (id) => { await stateQuery(`DELETE FROM ${RT()} WHERE collection = $1 AND id = $2`, [COLL, id]); };
  // Every key row: the underscore in the prefix is literal.
  const pgKeys = async () => (await stateQuery(`SELECT id, body FROM ${RT()} WHERE collection = $1 AND id LIKE 'k\\_%' ESCAPE '\\' ORDER BY id`, [COLL])).rows.map((r) => ({ hash: r.id.slice(2), rec: r.body }));
  // Every key row without its history: the readers that walk every key (the
  // operator status, the owed-refunds word) never read the history, so the
  // database leaves it out of the rows it sends.
  const pgKeysLite = async () => (await stateQuery(`SELECT id, body - 'history' AS body FROM ${RT()} WHERE collection = $1 AND id LIKE 'k\\_%' ESCAPE '\\' ORDER BY id`, [COLL])).rows.map((r) => ({ hash: r.id.slice(2), rec: r.body }));
  // The key rows one balance-page lookup needs, found by the database: by key
  // id, or every row bought with an email.
  // (CREDITS_LOOKUP_SQL, on their expression indexes once built.)
  const pgKeysByKeyId = async (keyId) => (await stateQuery(CREDITS_LOOKUP_SQL.keyId(RT()), [keyId])).rows.map((r) => ({ hash: r.id.slice(2), rec: r.body }));
  const pgKeysByEmail = async (email) => (await stateQuery(CREDITS_LOOKUP_SQL.email(RT()), [email])).rows.map((r) => ({ hash: r.id.slice(2), rec: r.body }));
  // Every key row an older build wrote without `emailKey` is given it,
  // computed in JS, in one merge per row that leaves every other field as it is.
  async function backfillEmailKeys() {
    const rows = (await stateQuery(`SELECT id, body->>'email' AS email FROM ${RT()} WHERE collection = $1 AND id LIKE 'k\\_%' ESCAPE '\\' AND NOT (body ? 'emailKey') AND COALESCE(body->>'email', '') <> ''`, [COLL])).rows;
    let n = 0;
    for (const r of rows) {
      const k = emailKeyOf(r.email);
      if (!k) continue;
      n += (await stateQuery(`UPDATE ${RT()} SET body = body || jsonb_build_object('emailKey', $3::text) WHERE collection = $1 AND id = $2 AND NOT (body ? 'emailKey')`, [COLL, r.id, k])).rowCount;
    }
    if (n) log(`[credits] gave ${n} key record(s) their normalized email`);
    return n;
  }
  // Write-through to the directory while it is there, so a rollback reads
  // current balances. Best effort: a failure is logged once, never the verdict.
  let throughWarned = false;
  const through = (path, body) => {
    if (!usePg || !existsSync(dir)) return;
    if (!writeJsonAtomic(path, body) && !throughWarned) { throughWarned = true; log(`[credits] write-through to ${dir} failed (the database row is the record)`); }
  };
  async function importDir() {
    const files = (() => { try { return readdirSync(dir); } catch { return []; } })();
    let bytes = 0, n = 0;
    for (const f of files) {
      const id = f.startsWith("k_") && f.endsWith(".json") ? f.slice(0, -5) : f === "_sessions.json" ? "_sessions" : f === "_warned.json" ? "_warned" : null;
      if (!id) continue;
      const body = readJson(join(dir, f));
      if (!body) continue;
      await pgPutIfAbsent(id, body);
      try { bytes += statSync(join(dir, f)).size; } catch { /* counted as 0 */ }
      if (id.startsWith("k_")) n++;
    }
    log(`[credits] imported ${n} key record(s) from ${dir} into the state database`);
    return { bytes, records: n };
  }
  // Roll-forward (the shape of json-document's reimportIfFileNewer): a key
  // file or the index written after the newest row, beyond the write-through
  // grace, was written by the previous build running on the files alone (a
  // rollback window): every key record and the index are re-read with the
  // FILE WINNING per id, and the replacement is logged.
  async function rollForwardIfFilesNewer() {
    const files = (() => { try { return readdirSync(dir).filter((f) => (f.startsWith("k_") && f.endsWith(".json")) || f === "_sessions.json" || f === "_warned.json"); } catch { return []; } })();
    let mtime = 0;
    for (const f of files) { try { mtime = Math.max(mtime, statSync(join(dir, f)).mtimeMs); } catch { /* gone */ } }
    if (!mtime) return 0;
    const newest = await stateQuery(`SELECT max(updated_at) AS at FROM ${RT()} WHERE collection = $1`, [COLL]);
    let rowAt = newest.rows[0]?.at ? new Date(newest.rows[0].at).getTime() : 0;
    if (!rowAt) { const mark = await imports.done(basename(dir)); rowAt = mark?.importedAt ? new Date(mark.importedAt).getTime() : 0; }
    if (!rowAt || mtime <= rowAt + ROLL_FORWARD_GRACE_MS) return 0;
    let keys = 0, index = 0;
    for (const f of files) {
      const body = readJson(join(dir, f));
      if (!body) continue;
      const id = f.slice(0, -5);
      await stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`, [COLL, id, JSON.stringify(body)]);
      if (id.startsWith("k_")) keys++; else index++;
    }
    log(`[credits] rolled forward ${keys} key record(s) and ${index} index from ${dir}: the files were written ${Math.round((mtime - rowAt) / 1000)} s after the newest row (a rollback window), the files win`);
    return keys + index;
  }
  // The first load (import once, roll forward, sweep abandoned holds) is
  // retried until it lands: a failed attempt is forgotten, so the next call
  // tries again, and a background timer retries for a store nobody calls.
  const loader = usePg ? retryingLoad("[credits]", async () => {
    await importOnce(basename(dir), { source: dir, run: importDir });
    await rollForwardIfFilesNewer();
    await backfillEmailKeys();
    await sweepAbandonedHolds().catch((e) => log(`[credits] hold sweep failed: ${String(e?.message || e).slice(0, 120)}`));
  }, { log }) : null;
  const readyP = () => (loader ? loader.ready() : Promise.resolve());
  if (loader) { trackStoreReady(loader.eventually); readyP().catch(() => {}); }
  // The lookup indexes, in the background once the store has loaded (ensureCreditsIndexes).
  if (loader && String(process.env.CREDITS_INDEXES || "").toLowerCase() !== "off") {
    const delay = Math.max(0, Number(process.env.CREDITS_INDEX_DELAY_MS ?? 60_000) || 0);
    Promise.resolve(loader.eventually).then(() => {
      const t = setTimeout(() => { ensureCreditsIndexes({ log }).catch((e) => log(`[credits] index build failed (the lookups run without it): ${String(e?.message || e).slice(0, 160)}`)); }, delay);
      t.unref?.();
    }, () => {});
  }

  // ---- abandoned holds (database only) --------------------------------------
  // Each hold on the database is also an entry `holds[id] = { m, at }` on the
  // key's row. A settle or release that could not land after its retries
  // leaves the entry (and the money in heldMicro); the sweep, at the first
  // load and every few minutes, returns every entry older than
  // CREDITS_ABANDONED_HOLD_MS that no request in this process still holds,
  // and logs it. Held micro-dollars with no entry (holds placed by a build
  // without entries) are returned the same way once the row has been quiet
  // for that long. A settle that arrives for a swept hold takes nothing.
  // A hold marked settling (its call answered a final 200, marked as the
  // response ends with the amount the debit takes) is never returned: the
  // sweep turns it into spend and books the sale, and a settle that lands
  // later moves nothing and books nothing.
  const liveHolds = new Set(); // hold ids of requests in flight here
  // A request in flight refreshes its hold's `at` every third of the window,
  // so a sweep on another container (which cannot see this process's
  // liveHolds) never returns a hold a running request still holds.
  const holdRefreshers = new Map(); // hold id -> interval
  function keepHoldFresh(hash, holdId) {
    if (!usePg || !holdId || holdRefreshers.has(holdId)) return;
    const started = Date.now();
    const t = setInterval(() => {
      // Refreshed for the run's whole life: the settle or release that decides
      // the hold stops it (later()). Only a hold whose response never ends is
      // left to the sweep, after holdRefreshMaxMs().
      if (Date.now() - started > holdRefreshMaxMs()) { stopHoldFresh(holdId); return; }
      mutatePgNow(hash, (rec) => {
        const h = rec?.holds?.[holdId];
        if (!h) return { result: false };
        rec.holds = { ...rec.holds, [holdId]: { ...h, at: now() } };
        return { rec, result: true };
      }).then((still) => { if (still === false) stopHoldFresh(holdId); }).catch(() => { /* the next tick tries again */ });
    }, Math.max(250, Math.floor(abandonedHoldMs() / 3)));
    t.unref?.();
    holdRefreshers.set(holdId, t);
  }
  function stopHoldFresh(holdId) {
    const t = holdId ? holdRefreshers.get(holdId) : null;
    if (t) { clearInterval(t); holdRefreshers.delete(holdId); }
  }
  const holdTotal = (holds) => Object.values(holds || {}).reduce((a, h) => a + (Number(h?.m) || 0), 0);
  async function sweepAbandonedHolds() {
    if (!usePg) return { released: 0, micro: 0 };
    const age = abandonedHoldMs();
    const cut = now() - age;
    const rows = (await stateQuery(`SELECT id, updated_at FROM ${RT()} WHERE collection = $1 AND id LIKE 'k\\_%' ESCAPE '\\' AND (body->>'heldMicro')::bigint > 0`, [COLL])).rows;
    let released = 0, micro = 0, settled = 0, settledMicro = 0;
    for (const row of rows) {
      const hash = row.id.slice(2);
      const quietRow = new Date(row.updated_at).getTime() < cut;
      const out = await mutatePgNow(hash, (rec) => {
        if (!rec || !(rec.heldMicro > 0)) return { result: null };
        const holds = { ...(rec.holds || {}) };
        let back = 0, leaving = 0, n = 0;
        const spends = []; // settling holds: [id, held, taken, slug, via]
        for (const [id, h] of Object.entries(holds)) {
          if (liveHolds.has(id) || !(Number(h?.at) < cut)) continue;
          const held = Number(h.m) || 0;
          leaving += held;
          if (h.s) { const taken = Math.max(0, Math.min(held, Number(h.s.m) || 0)); spends.push([id, held, taken, h.s.slug ?? null, h.s.via ?? null]); back += held - taken; grantHoldDone(rec, h, held, taken); }
          else { back += held; n++; grantHoldDone(rec, h, held, 0); }
          delete holds[id];
        }
        // Held money no entry accounts for, on a row nobody has touched for the whole window.
        const untracked = rec.heldMicro - leaving - holdTotal(holds);
        if (quietRow && untracked > 0 && ![...liveHolds].some((id) => id.startsWith(`${hash.slice(0, 12)}:`))) { back += untracked; leaving += untracked; n++; }
        if (!n && !spends.length) return { result: null };
        const spent = spends.reduce((a, x) => a + x[2], 0);
        leaving = Math.min(leaving, rec.heldMicro);
        back = Math.max(0, Math.min(back, leaving - spent));
        rec.holds = holds;
        rec.heldMicro -= leaving; rec.balanceMicro += back; rec.spentMicro = (rec.spentMicro || 0) + spent;
        let low = null;
        if (spends.length) {
          const at = now();
          rec.calls = (rec.calls || 0) + spends.length; rec.lastUsedAt = new Date(at).toISOString();
          rec.settledHolds = recentSettled({ ...(rec.settledHolds || {}), ...Object.fromEntries(spends.map(([id, held, taken]) => [id, { m: taken, h: held, at, booked: true }])) });
          for (const [, , taken, slug] of spends) note(rec, { k: "charge", slug: slug ?? null, m: taken });
          if (lowCrossed(rec, spent)) low = lowNotice(rec);
        }
        const keyId = rec.keyId;
        return { rec, result: { n, back, s: spends.length, spent, keyId }, after: () => { for (const [, , taken, slug, via] of spends) onDebit?.({ slug, priceUsd: microToUsd(taken), keyId, via }); low?.(); } };
      });
      if (out?.n) { released += out.n; micro += out.back; log(`[credits] released ${out.n} abandoned hold(s) on key ${out.keyId} ($${microToUsd(out.back)}): no settle or release landed within ${Math.round(age / 1000)} s`); }
      if (out?.s) { settled += out.s; settledMicro += out.spent; log(`[credits] debited ${out.s} settling hold(s) on key ${out.keyId} ($${microToUsd(out.spent)}): their calls answered 200 and no settle landed within ${Math.round(age / 1000)} s`); }
    }
    return { released, micro, settled, settledMicro };
  }
  if (usePg) {
    const every = Math.max(60_000, Math.min(15 * 60_000, Math.floor(abandonedHoldMs() / 2)));
    const t = setInterval(() => { if (loader.isLoaded()) sweepAbandonedHolds().catch((e) => log(`[credits] hold sweep failed: ${String(e?.message || e).slice(0, 120)}`)); }, every);
    t.unref?.();
  }
  // One key's record, moved under its row lock: `fn(rec)` answers
  // { rec?, result, after? }; `rec` is written back, `after` runs once it is.
  async function mutatePg(hash, fn) {
    await readyP();
    return mutatePgNow(hash, fn);
  }
  async function mutatePgNow(hash, fn) {
    const out = await withStateTx(async (c) => {
      const r = await c.query(`SELECT body FROM ${RT()} WHERE collection = $1 AND id = $2 FOR UPDATE`, [COLL, recId(hash)]);
      const o = fn(r.rows[0]?.body ?? null);
      if (o.rec) await c.query(`UPDATE ${RT()} SET body = $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2`, [COLL, recId(hash), JSON.stringify(o.rec)]);
      return o;
    });
    if (out.rec) through(recPath(hash), out.rec);
    if (out.after) { try { out.after(); } catch { /* accounting never breaks serving */ } }
    return out.result;
  }
  function mutateFile(hash, fn) {
    const out = fn(load(hash));
    if (out.rec) save(hash, out.rec);
    if (out.after) { try { out.after(); } catch { /* accounting never breaks serving */ } }
    return out.result;
  }
  const mutate = usePg ? mutatePg : mutateFile;
  const readRec = usePg ? async (hash) => { await readyP(); return pgGet(recId(hash)); } : load;
  const allKeys = usePg ? async () => { await readyP(); return pgKeys(); } : () => keyFiles().map((f) => ({ hash: f.slice(2, -5), rec: readJson(join(dir, f)) })).filter((x) => x.rec);
  const allKeysLite = usePg ? async () => { await readyP(); return pgKeysLite(); } : allKeys;
  // The record(s) for one key id, or bought with one email: a lookup, never a
  // walk of every key. Each hit is checked against the record itself.
  async function keysByKeyId(keyId) {
    if (typeof keyId !== "string" || !keyId) return [];
    if (usePg) { await readyP(); return (await pgKeysByKeyId(keyId)).filter((x) => x.rec?.keyId === keyId); }
    const hash = fileIndex().byKeyId.get(keyId);
    const rec = hash ? load(hash) : null;
    return rec && rec.keyId === keyId ? [{ hash, rec }] : [];
  }
  async function keysByEmail(email) {
    if (!email) return [];
    const k = emailKeyOf(email);
    if (!k) return [];
    if (usePg) { await readyP(); return (await pgKeysByEmail(k)).filter((x) => recEmailKey(x.rec) === k); }
    return [...(fileIndex().byEmail.get(k) || [])].map((hash) => ({ hash, rec: load(hash) })).filter((x) => x.rec && recEmailKey(x.rec) === k);
  }
  const answer = (v) => (usePg ? Promise.resolve(v) : v);
  const note = (rec, ev) => noteEvent(rec, ev, now());
  // A charge that takes the balance (with what is held) from at least
  // LOW_BALANCE_MICRO to under it: the low-balance notice goes out once for
  // that crossing, while credits are on sale, to a key with an email that has
  // not turned the notice off.
  const lowCrossed = (rec, taken) => {
    const left = (Number(rec.balanceMicro) || 0) + (Number(rec.heldMicro) || 0);
    return taken > 0 && left < LOW_BALANCE_MICRO && left + taken >= LOW_BALANCE_MICRO;
  };
  const lowNotice = (rec) => {
    if (!onLowBalance || !creditsSalesEnabled() || !rec.email || rec.lowNoticeOff || rec.disabled) return null;
    rec.lowNoticeAt = new Date(now()).toISOString();
    const snap = { keyId: rec.keyId, email: rec.email, balanceUsd: microToUsd(rec.balanceMicro), heldUsd: microToUsd(rec.heldMicro || 0) };
    return () => { try { onLowBalance(snap); } catch { /* a notice never breaks a debit */ } };
  };

  // ---- purchase checks ---------------------------------------------------------
  // A tag stands for an email, a client or a balance where Stripe or the shared
  // counters need one: a keyed digest, never the value itself.
  const tagOf = (kind, v) => (v ? (tagSecret ? createHmac("sha256", tagSecret) : createHash("sha256")).update(`credits-${kind}|${String(v)}`).digest("hex").slice(0, 24) : null);
  /** The tag a client address is counted under (an IPv6 address by its /64). */
  const sourceTag = (ip) => tagOf("src", limiterKey(String(ip || "")));
  const unavailablePurchase = () => Object.assign(new Error("Credits purchases are unavailable right now. Try again later."), { statusCode: 503, buyerSafe: true });
  const refusedPurchase = () => Object.assign(new Error(PURCHASE_REFUSED), { statusCode: 429, buyerSafe: true, refused: true });
  // Counted in the shared store, so every server sees one count. A store that
  // does not answer lets the check pass on this server's own count.
  const HOUR_MS = 60 * 60_000;
  async function countIn(name, key, windowMs, add) {
    const r = add ? await shared.windowAdd(name, key, { windowMs, member: `${now()}:${randomBytes(6).toString("hex")}`, now: now() }) : await shared.windowRead(name, key, { windowMs, now: now() });
    return r?.ok ? Number(r.count) || 0 : 0;
  }
  async function held(tag) {
    if (!tag) return false;
    const r = await shared.flagGet("credits-hold", tag, { now: now() });
    return Boolean(r?.ok && r.until > now());
  }
  /** Before a checkout starts: false when a check refuses this client or account. */
  async function checkoutAllowed({ email = null, ip = null } = {}) {
    const c = purchaseChecks();
    if (!c) throw unavailablePurchase();
    const src = sourceTag(ip), acct = tagOf("acct", emailKeyOf(email));
    if (await held(src) || await held(acct)) return false;
    for (const tag of [src, acct].filter(Boolean)) {
      if (await countIn("credits-start-h", tag, HOUR_MS, false) >= c.sourcePerHour) return false;
      if (await countIn("credits-start-d", tag, DAY_MS, false) >= c.sourcePerDay) return false;
    }
    for (const tag of [src, acct].filter(Boolean)) { await countIn("credits-start-h", tag, HOUR_MS, true); await countIn("credits-start-d", tag, DAY_MS, true); }
    return true;
  }
  /** A credits payment that did not go through (the payment_intent.payment_failed
   *  webhook): counted against its client and its card; past the count, each is
   *  held from new purchases for a while. */
  async function notePaymentFailed({ source = null, cardFingerprint = null } = {}) {
    const c = purchaseChecks();
    if (!c) return;
    for (const tag of [source ? String(source).slice(0, 64) : null, cardFingerprint ? tagOf("card", cardFingerprint) : null].filter(Boolean)) {
      const n = await countIn("credits-failed", tag, c.failedWindowMs, true);
      if (n >= c.failedMax) await shared.flagSet("credits-hold", tag, now() + c.failedHoldMs, { now: now() });
    }
  }
  // Purchases this buyer completed inside `windowMs` before `at` (each pack
  // and top-up payment counts once). A buyer matches by email, card or Stripe
  // customer; the session being decided never counts against itself.
  async function purchasesIn(buyer, at, windowMs, sessionId = null) {
    let n = 0;
    for (const { rec } of await allKeys()) {
      if (!rec) continue;
      const same = (buyer.email && recEmailKey(rec) === buyer.email)
        || (buyer.cardFingerprint && rec.cardFingerprint === buyer.cardFingerprint)
        || (buyer.customer && rec.customer === buyer.customer);
      if (!same) continue;
      if (Array.isArray(rec.payments) && rec.payments.length) {
        for (const p of rec.payments) if (Number(p.at) > at - windowMs && !(sessionId && p.session === sessionId)) n++;
        continue;
      }
      if (!(Date.parse(rec.createdAt) > at - windowMs)) continue;
      if (sessionId && Array.isArray(rec.sessions) && rec.sessions.includes(sessionId)) continue;
      n++;
    }
    return n;
  }
  /** At issue: true when a check refuses this paid session (it is refunded, no key). */
  async function purchaseRefused(buyer, sessionId) {
    if (buyer.flagged) return true;
    if (await held(buyer.cardFingerprint ? tagOf("card", buyer.cardFingerprint) : null) || await held(tagOf("acct", buyer.email))) return true;
    const c = purchaseChecks();
    if (!c) return true;
    if (await purchasesIn(buyer, now(), HOUR_MS, sessionId) >= c.buyerPerHour) return true;
    if (await purchasesIn(buyer, now(), DAY_MS, sessionId) >= c.buyerPerDay) return true;
    return false;
  }
  // What a checkout tells Stripe: card authentication requested on every
  // payment, and neutral tags Stripe's own rules can read (never a key, an
  // email or an address).
  const checkoutGuards = (packKey, p, { email = null, ip = null, keyId = null } = {}) => ({
    payment_method_options: { card: { request_three_d_secure: "any" } },
    piMetadata: { credits_pack: packKey, ref_pack_usd: String(p.cents / 100), ...(email ? { ref_buyer: tagOf("acct", emailKeyOf(email)) } : {}), ...(ip ? { ref_source: sourceTag(ip) } : {}), ...(keyId ? { ref_balance: tagOf("bal", keyId) } : {}) },
  });

  // `returnTo`: { success, cancel } URLs on this site for a purchase started
  // somewhere other than the credits page (the connector sign-in,
  // src/mcp-oauth.js); success must carry {CHECKOUT_SESSION_ID}. Every caller
  // passes the signed-in email and the client address, so the same purchase
  // checks, card authentication and limits apply on every path.
  async function createCheckout(packKey, { email = null, ip = null, returnTo = null } = {}) {
    const p = Object.hasOwn(CREDIT_PACKS, String(packKey)) ? CREDIT_PACKS[packKey] : null;
    if (!p) {
      // Self-correcting: an agent cannot guess "credits-20" from a bare 20,
      // and /api/pricing used to publish the dollar amounts only (found by an
      // outside reviewer 2026-08-28, who brute-forced the id).
      const e = new Error(`Unknown credit pack. Valid packs: ${Object.keys(sellablePacks()).join(", ")}`);
      e.statusCode = 400; e.validPacks = Object.keys(sellablePacks()); e.buyerSafe = true; throw e;
    }
    // No key holds more than the balance cap, and a pack is one key's whole balance.
    if (p.cents > creditsBalanceMaxCents()) {
      const e = new Error(`This pack is above the $${creditsBalanceMaxCents() / 100} most one key's balance may hold. Valid packs: ${Object.keys(sellablePacks()).join(", ")}`);
      e.statusCode = 400; e.validPacks = Object.keys(sellablePacks()); e.buyerSafe = true; throw e;
    }
    if (p.cents > creditsDailyMaxCents()) {
      const e = new Error(`This pack is above the $${creditsDailyMaxCents() / 100} one buyer may buy in a day. Valid packs: ${Object.keys(sellablePacks()).join(", ")}`);
      e.statusCode = 400; e.validPacks = Object.keys(sellablePacks()); e.buyerSafe = true; throw e;
    }
    if (!(await checkoutAllowed({ email, ip }))) throw refusedPurchase();
    const guard = checkoutGuards(packKey, p, { email, ip });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(email ? { customer_email: email } : {}),
      payment_method_options: guard.payment_method_options,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.cents, product_data: creditsProductData(p) } }],
      // A billing address sources sales tax (src/nc-sales-tax.js); a business
      // may add its tax ID; the buyer confirms business or developer use and
      // accepts the terms, both required and kept on the key's record. Tax is
      // included in the price and accounted at use, so Stripe adds none here.
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      custom_fields: [
        { key: "use", label: { type: "custom", custom: "Use" }, type: "dropdown", optional: false, dropdown: { options: [{ label: "Business or developer use", value: "business" }] } },
        { key: "terms", label: { type: "custom", custom: "Terms of Service" }, type: "dropdown", optional: false, dropdown: { options: [{ label: "I agree to the Terms of Service", value: "agreed" }] } },
      ],
      // The buyer sees the terms and the credit rules on the pay button's page.
      custom_text: { submit: { message: `By paying you agree to the Terms of Service (${baseUrl}/terms). Credits are for business and developer use, are spent only on Agent402's own services, never expire and carry no fees, and the unspent balance on the key is refunded to this card on request. Prices include North Carolina sales tax where it applies.` } },
      metadata: { credits_pack: packKey, terms: creditsTermsVersion(), ...(email ? { credits_account: emailKeyOf(email) } : {}) },
      success_url: returnTo?.success || `${baseUrl}/credits/thanks?session={CHECKOUT_SESSION_ID}`,
      cancel_url: returnTo?.cancel || `${baseUrl}/credits?canceled=1`,
      payment_intent_data: { description: `Agent402 credits ${p.label}`, metadata: guard.piMetadata },
    });
    return { id: session.id, url: session.url };
  }

  // The answer for a session somebody already claimed: the key is never re-shown.
  // A top-up session answers what it added instead.
  const claimedAnswer = (rec, sessionId = null) => {
    const top = sessionId && Array.isArray(rec?.payments) ? rec.payments.find((p) => p.session === sessionId && p.kind === "topup") : null;
    if (top) return { status: "topped_up", keyId: rec.keyId, addedUsd: (Number(top.cents) || 0) / 100, balanceUsd: microToUsd(rec.balanceMicro) };
    return { status: "claimed", keyId: rec?.keyId || null, balanceUsd: rec ? microToUsd(rec.balanceMicro) : null };
  };
  // refunded: true (done), false (failed; we refund it by hand) or null (in progress).
  const overLimitAnswer = (refunded) => ({ status: "over_limit", refunded, limitUsd: creditsDailyMaxCents() / 100 });
  const taxIdAnswer = (refunded) => ({ status: "tax_id_required", refunded });
  const capAnswer = (refunded) => ({ status: "over_balance_cap", refunded, capUsd: creditsBalanceMaxCents() / 100 });
  // A payment Stripe had already refunded in full when it was claimed: no key.
  const refundedAnswer = () => ({ status: "refunded" });
  const topupRefusedAnswer = (refunded) => ({ status: "topup_refused", refunded });
  const reviewAnswer = (refunded) => ({ status: "not_completed", refunded, error: PURCHASE_REFUSED });
  const refusedAnswer = (v) => (String(v).startsWith(REFUSAL_KINDS.review) ? reviewAnswer(refusalRefunded(v)) : String(v).startsWith(REFUSAL_KINDS.taxId) ? taxIdAnswer(refusalRefunded(v)) : String(v).startsWith(REFUSAL_KINDS.refunded) ? refundedAnswer() : String(v).startsWith(REFUSAL_KINDS.cap) ? capAnswer(refusalRefunded(v)) : String(v).startsWith(REFUSAL_KINDS.topup) ? topupRefusedAnswer(refusalRefunded(v)) : overLimitAnswer(refusalRefunded(v)));
  // Who bought: lowercased email and the card's fingerprint, whichever the
  // session carries, and how much of the payment Stripe has refunded already
  // (cents). A read that fails leaves a field null; the other still matches.
  async function buyerOf(session, paymentIntent) {
    const email = emailKeyOf(session.customer_details?.email || session.customer_email);
    let cardFingerprint = null, refundedCents = 0, flagged = false;
    if (paymentIntent && stripe.paymentIntents?.retrieve) {
      try {
        const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ["latest_charge"] });
        cardFingerprint = pi?.latest_charge?.payment_method_details?.card?.fingerprint || null;
        refundedCents = Math.max(0, Number(pi?.latest_charge?.amount_refunded) || 0);
        flagged = chargeFlagged(pi?.latest_charge);
      } catch { /* the email still matches */ }
    }
    const customer = typeof session.customer === "string" ? session.customer : session.customer?.id || null;
    return { email, cardFingerprint, customer, refundedCents, flagged };
  }
  // Credits this buyer was issued in the 24 hours before `at`, in cents.
  // A key minted for `sessionId` itself never counts against that session.
  async function boughtInDayCents(buyer, at, sessionId = null) {
    let micro = 0;
    for (const { rec } of await allKeys()) {
      if (!rec) continue;
      const same = (buyer.email && recEmailKey(rec) === buyer.email)
        || (buyer.cardFingerprint && rec.cardFingerprint === buyer.cardFingerprint);
      if (!same) continue;
      // A key topped up counts each payment on its own day.
      if (Array.isArray(rec.payments) && rec.payments.length) {
        for (const p of rec.payments) if (Number(p.at) > at - DAY_MS && !(sessionId && p.session === sessionId)) micro += (Number(p.cents) || 0) * 10_000;
        continue;
      }
      if (!(Date.parse(rec.createdAt) > at - DAY_MS)) continue;
      if (sessionId && Array.isArray(rec.sessions) && rec.sessions.includes(sessionId)) continue;
      micro += Number(rec.loadedMicro) || 0;
    }
    return Math.round(micro / 10_000);
  }
  // Record a session as refused, claim-once like a minted one. True only when
  // THIS call wrote the entry: only that call refunds. A refusal whose
  // outcome is already known (the payment was refunded before the claim, so
  // there is nothing to refund) is claimed with that outcome in the same
  // write, so no second write can leave it pending, which would list it as
  // owed.
  async function refuseSession(sessionId, prefix, outcome = null) {
    const pending = outcome ? `${prefix}:${outcome}` : `${prefix}:pending@${now()}`;
    if (usePg) return !!(await claimSessionPg(sessionId, pending));
    const idx = sessionsIdx();
    if (idx[sessionId]) return false;
    idx[sessionId] = pending; writeJsonAtomic(SESSIONS, idx);
    return true;
  }
  // The refund outcome ("refunded" or "failed") on a refused session, keeping its kind.
  async function setRefusal(sessionId, outcome) {
    if (usePg) {
      await stateQuery(
        `UPDATE ${RT()} SET body = body || jsonb_build_object($2::text, regexp_replace(body->>$2::text, ':[a-z]+(@[0-9]+)?$', ':' || $3::text)), updated_at = now() WHERE collection = $1 AND id = '_sessions' AND body->>$2::text LIKE 'refused%'`,
        [COLL, sessionId, outcome]);
      return;
    }
    const idx = sessionsIdx();
    if (isRefused(idx[sessionId])) { idx[sessionId] = idx[sessionId].replace(/:[a-z]+(@\d+)?$/, `:${outcome}`); writeJsonAtomic(SESSIONS, idx); }
  }
  /** Refused sessions whose refund failed, or never finished (pending past
   *  STUCK_MS): refund each by hand, then mark it. */
  async function refusalsToRefund() {
    if (usePg) await readyP();
    const idx = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
    const t = now();
    return Object.entries(idx).filter(([, v]) => refusalOutcome(v) === "failed" || (refusalOutcome(v) === "pending" && t - pendingSince(v) > STUCK_MS)).map(([sessionId]) => sessionId);
  }
  /** After a by-hand refund of a refused session. */
  async function markRefusalRefunded(sessionId) { await setRefusal(String(sessionId), "refunded"); }
  // Refuse a paid session (claim-once) and refund it; only the call that
  // recorded the refusal refunds. Answers what the buyer is told.
  async function refuseAndRefund(sessionId, paymentIntent, prefix, why) {
    if (!(await refuseSession(sessionId, prefix))) {
      const theirs = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
      return isRefused(theirs[sessionId]) ? refusedAnswer(theirs[sessionId]) : claimedAnswer(theirs[sessionId] ? await readRec(theirs[sessionId]) : null);
    }
    let refunded = false;
    try { if (paymentIntent) { await stripe.refunds.create({ payment_intent: paymentIntent, metadata: { credits_refused: why } }); refunded = true; } } catch (e) { log(`[credits] ${why} refund FAILED for session ${sessionId}: ${String(e?.message || e).slice(0, 160)} - refund it by hand, then mark it (creditsRefunds on /api/gateway-status)`); }
    await setRefusal(sessionId, refunded ? "refunded" : "failed").catch((e) => log(`[credits] could not record the refund outcome for session ${sessionId} (${String(e?.message || e).slice(0, 80)}); it is listed as owed after ${STUCK_MS / 60_000} minutes`));
    log(`[credits] session ${sessionId} refused (${why}); ${refunded ? "refunded" : "NOT refunded"}, no key issued`);
    return refusedAnswer(`${prefix}:${refunded ? "refunded" : "failed"}`);
  }
  // One buyer's purchases are decided one at a time, so two claims cannot
  // both pass the daily limit on the same total: in this process by a chain
  // per buyer key, and across servers by a short Redis lock per email and per
  // card (SET NX PX, released by token, expiring after BUYER_LOCK_MS so a
  // crashed holder frees it). No database connection is held while a claim
  // runs, and the card refund happens outside any transaction. Without the
  // shared store the in-process chain still serializes this server.
  const BUYER_LOCK_MS = 30_000;
  const buyerChains = new Map();
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  async function sharedBuyerLock(keys) {
    if (!keys.length || !sharedLimitsEnabled()) return null;
    let c;
    try { c = await getSharedRedisClient(); } catch { c = null; }
    if (!c) return null;
    const token = randomBytes(12).toString("hex");
    const held = [];
    const deadline = now() + BUYER_LOCK_MS + 5_000;
    try {
      for (const k of keys) {
        const name = `a402:credits-buyer:${k}`;
        for (;;) {
          if ((await c.set(name, token, { NX: true, PX: BUYER_LOCK_MS })) === "OK") { held.push(name); break; }
          if (now() > deadline) throw new Error("buyer lock wait exceeded");
          await sleepMs(50);
        }
      }
    } catch (e) {
      await releaseShared(c, held, token);
      log(`[credits] buyer lock unavailable (${String(e?.message || e).slice(0, 80)}); deciding on this server's order`);
      return null;
    }
    return { c, held, token };
  }
  async function releaseShared(c, held, token) {
    for (const name of held) {
      try { await c.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", { keys: [name], arguments: [token] }); } catch { /* it expires */ }
    }
  }
  async function withBuyerLock(buyer, fn) {
    const keys = [buyer.email && `e:${buyer.email}`, buyer.cardFingerprint && `c:${buyer.cardFingerprint}`].filter(Boolean).sort();
    const run = async () => {
      const lock = await sharedBuyerLock(keys);
      try { return await fn(); } finally { if (lock) await releaseShared(lock.c, lock.held, lock.token); }
    };
    const k0 = keys[0] || "anon";
    const prev = buyerChains.get(k0) || Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    buyerChains.set(k0, next);
    try { return await next; } finally { if (buyerChains.get(k0) === next) buyerChains.delete(k0); }
  }
  // Claim-once on the database: the index row gains this session only when it
  // does not carry it yet (one conditional statement). Resolves the index
  // body when this call claimed it, null when another one did.
  async function claimSessionPg(sessionId, hash) {
    const r = await stateQuery(
      `INSERT INTO ${RT()} (collection, id, body) VALUES ($1, '_sessions', jsonb_build_object($2::text, $3::text))
       ON CONFLICT (collection, id) DO UPDATE SET body = ${RT()}.body || jsonb_build_object($2::text, $3::text), updated_at = now()
       WHERE NOT (${RT()}.body ? $2::text)
       RETURNING body`,
      [COLL, sessionId, hash],
    );
    return r.rowCount === 1 ? r.rows[0].body : null;
  }

  // A fraud warning on a payment that has no key yet (the claim comes later,
  // or its webhook failed) is remembered in the store, so a later claim or
  // top-up on that payment issues nothing and is refunded in full.
  async function rememberWarned(paymentIntent, warningId = null) {
    const entry = { at: now(), ...(warningId ? { id: String(warningId).slice(0, 64) } : {}) };
    if (usePg) {
      await readyP();
      const r = await stateQuery(
        `INSERT INTO ${RT()} (collection, id, body) VALUES ($1, '_warned', jsonb_build_object($2::text, $3::jsonb))
         ON CONFLICT (collection, id) DO UPDATE SET body = ${RT()}.body || jsonb_build_object($2::text, $3::jsonb), updated_at = now()
         RETURNING body`,
        [COLL, paymentIntent, JSON.stringify(entry)]);
      if (r.rows[0]?.body) through(WARNED, r.rows[0].body);
      return;
    }
    const idx = warnedIdx();
    if (idx[paymentIntent]) return;
    idx[paymentIntent] = entry;
    if (!writeJsonAtomic(WARNED, idx)) throw new Error("could not record the warned payment");
  }
  async function warnedPayment(paymentIntent) {
    if (!paymentIntent) return false;
    if (usePg) { await readyP(); return Boolean(((await pgGet("_warned")) || {})[paymentIntent]); }
    return Boolean(warnedIdx()[paymentIntent]);
  }
  // A warning recorded while this payment was being issued (the warning saw
  // no key yet, the claim saw no warning yet) freezes the key it now names.
  async function warnedAfterIssue(paymentIntent) {
    if (paymentIntent && await warnedPayment(paymentIntent)) await fraudWarning(paymentIntent).catch((e) => log(`[credits] fraud warning on ${paymentIntent} after issue not applied (${String(e?.message || e).slice(0, 80)}); Stripe delivers it again`));
  }

  // Claim the key for a paid session: mints ONCE; later claims say "claimed".
  async function claim(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { status: "invalid" };
    if (usePg) await readyP();
    const idx = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
    if (isRefused(idx[sessionId])) return refusedAnswer(idx[sessionId]);
    if (idx[sessionId]) return claimedAnswer(await readRec(idx[sessionId]), sessionId);
    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); } catch { return { status: "not_found" }; }
    if (!session || session.mode !== "payment" || session.payment_status !== "paid") return { status: "unpaid" };
    const packKey = session.metadata?.credits_pack;
    const p = Object.hasOwn(CREDIT_PACKS, String(packKey)) ? CREDIT_PACKS[packKey] : null;
    if (!p) return { status: "invalid" };
    const email = session.customer_details?.email || session.customer_email || null;
    const loadedMicro = p.cents * 10_000;
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
    const buyer = await buyerOf(session, paymentIntent);
    // A top-up (started from the balance page) adds to the balance it names.
    const topupOf = session.metadata?.credits_topup;
    if (typeof topupOf === "string" && topupOf) return withBuyerLock(buyer, () => topUp({ session, sessionId, packKey, p, paymentIntent, buyer, keyId: topupOf, account: emailKeyOf(session.metadata?.credits_account) }));
    return withBuyerLock(buyer, () => issue({ session, sessionId, packKey, p, email, loadedMicro, paymentIntent, buyer }));
  }

  // Decide and issue one paid session, holding the buyer's lock.
  async function issue({ session, sessionId, packKey, p, email, loadedMicro, paymentIntent, buyer }) {
    // Re-check the index right before minting (two tabs, or the webhook and
    // the thanks page, claiming at once).
    const again = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
    if (isRefused(again[sessionId])) return refusedAnswer(again[sessionId]);
    if (again[sessionId]) return claimedAnswer(await readRec(again[sessionId]), sessionId);
    // An EU or UK billing address needs a business tax ID (VAT is reverse
    // charged to a business; a consumer sale there is not offered).
    const country = String(session.customer_details?.address?.country || "").toUpperCase();
    const hasTaxId = Array.isArray(session.customer_details?.tax_ids) && session.customer_details.tax_ids.some((t) => t?.value && (t.type === "eu_vat" || t.type === "gb_vat"));
    if (buyer.refundedCents < p.cents && await warnedPayment(paymentIntent)) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.review, "fraud_warning");
    if (euUkTaxIdRequired() && EU_UK.has(country) && !hasTaxId) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.taxId, "eu_uk_tax_id_required");
    // The cap on one key's balance (lowered after this checkout began).
    if (p.cents > creditsBalanceMaxCents()) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.cap, "balance_cap");
    // The daily purchase limit, checked before anything is issued.
    if ((await boughtInDayCents(buyer, now(), sessionId)) + p.cents > creditsDailyMaxCents()) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.limit, "daily_purchase_limit");
    if (buyer.refundedCents < p.cents && await purchaseRefused(buyer, sessionId)) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.review, "purchase_check");
    // A payment already refunded in full mints nothing (claim-once, nothing
    // to refund); a partial refund is minted net of what went back.
    if (buyer.refundedCents >= p.cents) {
      // Claimed with its outcome in one write: nothing is owed for it.
      if (!(await refuseSession(sessionId, REFUSAL_KINDS.refunded, "refunded"))) {
        const theirs = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
        return isRefused(theirs[sessionId]) ? refusedAnswer(theirs[sessionId]) : claimedAnswer(theirs[sessionId] ? await readRec(theirs[sessionId]) : null);
      }
      log(`[credits] session ${sessionId} was refunded before its claim; no key issued`);
      return refundedAnswer();
    }
    const refundedMicro = buyer.refundedCents * 10_000;
    const key = newKeyString();
    const hash = hashKey(key);
    const keyId = hash.slice(0, 12);
    // Where the buyer is billed (sales tax sourcing) and any business tax ID given.
    const addr = session.customer_details?.address || {};
    const billing = addr.country ? { country: String(addr.country).toUpperCase(), state: addr.state ? String(addr.state).toUpperCase() : null, postal: addr.postal_code ? String(addr.postal_code) : null } : null;
    const taxIds = Array.isArray(session.customer_details?.tax_ids) ? session.customer_details.tax_ids.map((t) => ({ type: String(t?.type || ""), value: String(t?.value || "") })).filter((t) => t.value) : [];
    // The buyer's answers to the required checkout fields (business use, terms).
    const fields = Object.fromEntries((Array.isArray(session.custom_fields) ? session.custom_fields : []).map((f) => [String(f?.key || ""), String(f?.dropdown?.value || "")]));
    const consent = { use: fields.use || null, terms: fields.terms === "agreed" ? session.metadata?.terms || null : null };
    const rec = { keyId, balanceMicro: loadedMicro - refundedMicro, loadedMicro, ...(refundedMicro ? { refundedMicro } : {}), spentMicro: 0, calls: 0, createdAt: new Date(now()).toISOString(), email, emailKey: emailKeyOf(email), cardFingerprint: buyer.cardFingerprint, ...(buyer.customer ? { customer: buyer.customer } : {}), billing, consent, taxIds, sessions: [sessionId], paymentIntents: paymentIntent ? [paymentIntent] : [], pack: packKey, lastUsedAt: null };
    note(rec, { k: "purchase", m: loadedMicro - refundedMicro });
    if (usePg) {
      // The record first (nobody holds its key yet), then the claim; a claim
      // another container won in between leaves an orphan row, removed here.
      await pgPutIfAbsent(recId(hash), rec);
      const index = await claimSessionPg(sessionId, hash);
      if (!index) {
        await pgDel(recId(hash)).catch(() => {});
        const theirs = (await pgGet("_sessions")) || {};
        if (isRefused(theirs[sessionId])) return refusedAnswer(theirs[sessionId]);
        return claimedAnswer(theirs[sessionId] ? await pgGet(recId(theirs[sessionId])) : null);
      }
      through(recPath(hash), rec);
      through(SESSIONS, index);
    } else {
      save(hash, rec);
      again[sessionId] = hash; writeJsonAtomic(SESSIONS, again);
    }
    await warnedAfterIssue(paymentIntent);
    try { onLoad?.({ sessionId, pack: packKey, priceUsd: p.cents / 100, keyId, paymentIntent }); } catch { /* accounting never breaks minting */ }
    if (email) {
      sendEmail({ to: email, subject: "Your Agent402 credits key",
        text: `Your prepaid credits are ready: $${(p.cents / 100).toFixed(2)} loaded.\n\nYour key (keep it secret, it is shown only here and on the thanks page):\n\n${key}\n\nUse it on our paid tools (the wallet-scoped routes and the routes that buy from an outside seller take a wallet):\ncurl -H "Authorization: Bearer ${key}" ${baseUrl}/api/whois?domain=example.com\n\nBalance: GET ${baseUrl}/api/credits/balance with the same header.\nRefund the unspent balance to your card: POST ${baseUrl}/api/credits/refund with the same header (the key is then disabled).\nAnother key: ${baseUrl}/credits${creditsSalesEnabled() ? `\nYour balance, its history, top-ups and a new key if you lose this one: sign in with this email at ${baseUrl}/credits/account` : ""}\n\nAgent402`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111315"><h2 style="font-weight:700">Your Agent402 credits key</h2><p>$${(p.cents / 100).toFixed(2)} loaded. Keep the key secret - it is shown only here and on the thanks page.</p><pre style="background:#0c0d0f;color:#e9eaec;padding:14px 16px;border-radius:4px;font-size:13px;overflow:auto">${key}</pre><p>Use it on our paid tools (the wallet-scoped routes and the routes that buy from an outside seller take a wallet):</p><pre style="background:#f3f4f5;padding:12px 14px;border-radius:4px;font-size:13px;overflow:auto">curl -H "Authorization: Bearer ${key}" ${baseUrl}/api/whois?domain=example.com</pre><p style="color:#626970;font-size:13px">Balance: <code>GET ${baseUrl}/api/credits/balance</code> with the same header · Refund the unspent balance: <code>POST ${baseUrl}/api/credits/refund</code> with the same header (disables the key) · Another key at <a href="${baseUrl}/credits">${baseUrl}/credits</a></p></div>` }).catch(() => {}); // design-tokens: literal (email body)
    }
    receipt({ kind: "purchase", email, keyId, cents: p.cents, balanceMicro: rec.balanceMicro, paymentIntent, sessionId });
    log(`[credits] minted key ${keyId} ($${(p.cents / 100).toFixed(2)}) for session ${sessionId}`);
    return { status: "minted", key, keyId, balanceUsd: microToUsd(rec.balanceMicro) };
  }
  // Our own receipt for a purchase or a top-up (sales on, an email on file).
  function receipt(r) {
    if (!onReceipt || !creditsSalesEnabled() || !r.email) return;
    try { onReceipt({ kind: r.kind, email: r.email, keyId: r.keyId, amountUsd: r.cents / 100, balanceUsd: microToUsd(r.balanceMicro), at: new Date(now()).toISOString(), paymentIntent: r.paymentIntent || null, sessionId: r.sessionId }); } catch { /* a receipt never breaks a purchase */ }
  }

  // TOP-UP. A paid session started from the balance page names the balance it
  // adds to (metadata credits_topup, the key id) and the signed-in buyer
  // (credits_account). It is decided like a purchase (tax ID, daily limit, a
  // payment already refunded) and then added under the key's lock, where the
  // record's own session list makes it land once: the balance must still be
  // the buyer's, enabled, with no refund asked, and with room under the cap
  // for the whole top-up. Anything else is refused and refunded in full.
  async function keyHashById(keyId) {
    const hit = (await keysByKeyId(keyId))[0];
    return hit ? hit.hash : null;
  }
  async function topUp({ session, sessionId, packKey, p, paymentIntent, buyer, keyId, account }) {
    const again = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
    if (isRefused(again[sessionId])) return refusedAnswer(again[sessionId]);
    if (again[sessionId]) return claimedAnswer(await readRec(again[sessionId]), sessionId);
    const country = String(session.customer_details?.address?.country || "").toUpperCase();
    const hasTaxId = Array.isArray(session.customer_details?.tax_ids) && session.customer_details.tax_ids.some((t) => t?.value && (t.type === "eu_vat" || t.type === "gb_vat"));
    if (buyer.refundedCents < p.cents && await warnedPayment(paymentIntent)) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.review, "fraud_warning");
    if (euUkTaxIdRequired() && EU_UK.has(country) && !hasTaxId) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.taxId, "eu_uk_tax_id_required");
    if ((await boughtInDayCents(buyer, now(), sessionId)) + p.cents > creditsDailyMaxCents()) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.limit, "daily_purchase_limit");
    if (buyer.refundedCents < p.cents && await purchaseRefused(buyer, sessionId)) return refuseAndRefund(sessionId, paymentIntent, REFUSAL_KINDS.review, "purchase_check");
    if (buyer.refundedCents >= p.cents) {
      if (!(await refuseSession(sessionId, REFUSAL_KINDS.refunded, "refunded"))) {
        const theirs = usePg ? (await pgGet("_sessions")) || {} : sessionsIdx();
        return isRefused(theirs[sessionId]) ? refusedAnswer(theirs[sessionId]) : claimedAnswer(theirs[sessionId] ? await readRec(theirs[sessionId]) : null, sessionId);
      }
      return refundedAnswer();
    }
    const hash = await keyHashById(keyId);
    const addMicro = (p.cents - buyer.refundedCents) * 10_000;
    const out = hash ? await mutate(hash, (rec) => {
      if (!rec || rec.keyId !== keyId) return { result: { why: "topup_target" } };
      if (Array.isArray(rec.sessions) && rec.sessions.includes(sessionId)) return { result: { dup: true } };
      if (!account || !sameEmail(recEmailKey(rec), account) || rec.disabled || rec.refundRequest) return { result: { why: "topup_target" } };
      if ((Number(rec.balanceMicro) || 0) + (Number(rec.heldMicro) || 0) + p.cents * 10_000 > creditsBalanceMaxCents() * 10_000) return { result: { why: "balance_cap" } };
      const pays = Array.isArray(rec.payments) && rec.payments.length ? rec.payments : (() => {
        const first = Array.isArray(rec.paymentIntents) ? rec.paymentIntents[0] || null : null;
        return [{ pi: first, cents: Math.round((Number(rec.loadedMicro) || 0) / 10_000), refundedCents: Math.round((Number(rec.refundedMicro) || 0) / 10_000), at: Date.parse(rec.createdAt) || 0, kind: "purchase", session: Array.isArray(rec.sessions) ? rec.sessions[0] || null : null }];
      })();
      rec.payments = [...pays, { pi: paymentIntent, cents: p.cents, refundedCents: buyer.refundedCents, at: now(), kind: "topup", session: sessionId, pack: packKey }];
      rec.loadedMicro = (Number(rec.loadedMicro) || 0) + p.cents * 10_000;
      rec.refundedMicro = rec.payments.reduce((a, x) => a + (Number(x.refundedCents) || 0) * 10_000, 0);
      rec.balanceMicro = (Number(rec.balanceMicro) || 0) + addMicro;
      rec.sessions = [...(Array.isArray(rec.sessions) ? rec.sessions : []), sessionId];
      rec.paymentIntents = [...(Array.isArray(rec.paymentIntents) ? rec.paymentIntents : []), ...(paymentIntent ? [paymentIntent] : [])];
      if ((Number(rec.balanceMicro) || 0) + (Number(rec.heldMicro) || 0) >= LOW_BALANCE_MICRO) delete rec.lowNoticeAt;
      note(rec, { k: "topup", m: addMicro });
      return { rec, result: { ok: true, email: rec.email, balanceMicro: rec.balanceMicro } };
    }) : { why: "topup_target" };
    if (out?.why) return refuseAndRefund(sessionId, paymentIntent, out.why === "balance_cap" ? REFUSAL_KINDS.cap : REFUSAL_KINDS.topup, out.why);
    if (usePg) {
      const index = await claimSessionPg(sessionId, hash);
      if (index) through(SESSIONS, index);
    } else {
      const idx = sessionsIdx();
      if (!idx[sessionId]) { idx[sessionId] = hash; writeJsonAtomic(SESSIONS, idx); }
    }
    if (!out?.dup) await warnedAfterIssue(paymentIntent);
    const rec = await readRec(hash);
    if (out?.dup) return claimedAnswer(rec, sessionId);
    try { onLoad?.({ sessionId, pack: packKey, priceUsd: p.cents / 100, keyId, paymentIntent }); } catch { /* accounting never breaks a top-up */ }
    receipt({ kind: "topup", email: out.email, keyId, cents: p.cents, balanceMicro: out.balanceMicro, paymentIntent, sessionId });
    log(`[credits] topped up key ${keyId} ($${(p.cents / 100).toFixed(2)}) for session ${sessionId}`);
    return claimedAnswer(rec, sessionId);
  }

  // A top-up checkout for a balance the signed-in buyer holds. The cap is
  // checked here, before any payment: a pack the balance has no room for is
  // refused with the room left. Answers { url } or throws a buyer-safe 4xx.
  async function createTopupCheckout(keyId, account, packKey, { ip = null } = {}) {
    const p = Object.hasOwn(CREDIT_PACKS, String(packKey)) ? CREDIT_PACKS[packKey] : null;
    const bad = (msg, extra = {}) => Object.assign(new Error(msg), { statusCode: 400, buyerSafe: true, ...extra });
    if (!p) throw bad(`Unknown credit pack. Valid packs: ${Object.keys(sellablePacks()).join(", ")}`, { validPacks: Object.keys(sellablePacks()) });
    const hash = await keyHashById(String(keyId || ""));
    const rec = hash ? await readRec(hash) : null;
    if (!rec || !account || !sameEmail(recEmailKey(rec), account)) throw Object.assign(new Error("No balance with that id is on this account."), { statusCode: 404, buyerSafe: true });
    if (rec.disabled || rec.refundRequest) throw bad("This balance is closed (refunded or switched off), so it cannot be topped up.");
    const capCents = creditsBalanceMaxCents();
    const usedCents = Math.ceil(((Number(rec.balanceMicro) || 0) + (Number(rec.heldMicro) || 0)) / 10_000);
    const roomCents = Math.max(0, capCents - usedCents);
    if (p.cents > roomCents) throw bad(`This balance holds at most $${(capCents / 100).toFixed(2)} and has room for $${(roomCents / 100).toFixed(2)} more, so a $${(p.cents / 100).toFixed(2)} top-up is refused before any payment.`, { roomUsd: roomCents / 100, capUsd: capCents / 100 });
    if (!(await checkoutAllowed({ email: rec.email, ip }))) throw refusedPurchase();
    const guard = checkoutGuards(packKey, p, { email: rec.email, ip, keyId: rec.keyId });
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: rec.email,
      payment_method_options: guard.payment_method_options,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.cents, product_data: creditsProductData(p, { topup: true }) } }],
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      custom_fields: [
        { key: "use", label: { type: "custom", custom: "Use" }, type: "dropdown", optional: false, dropdown: { options: [{ label: "Business or developer use", value: "business" }] } },
        { key: "terms", label: { type: "custom", custom: "Terms of Service" }, type: "dropdown", optional: false, dropdown: { options: [{ label: "I agree to the Terms of Service", value: "agreed" }] } },
      ],
      custom_text: { submit: { message: `By paying you agree to the Terms of Service (${baseUrl}/terms). The top-up is added to your existing balance, is spent only on Agent402's own services, never expires and carries no fees, and the unspent balance is refunded to the card that paid on request. Prices include North Carolina sales tax where it applies.` } },
      metadata: { credits_pack: packKey, credits_topup: rec.keyId, credits_account: account, terms: creditsTermsVersion() },
      success_url: `${baseUrl}/credits/account?topup={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/credits/account`,
      payment_intent_data: { description: `Agent402 credits top-up ${p.label}`, metadata: guard.piMetadata },
    });
    return { id: session.id, url: session.url };
  }

  // What a key spent on the current UTC day (for the holder's daily limit).
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const daySpentMicro = (rec) => (rec.daySpent && rec.daySpent.d === dayOf(now()) ? Number(rec.daySpent.m) || 0 : 0);
  const addDaySpent = (rec, micro) => { if (!(micro > 0)) return; rec.daySpent = { d: dayOf(now()), m: daySpentMicro(rec) + micro }; };

  // ---- the money moves, as pure steps on one record --------------------------
  // Each answers { rec?, result, after? }: `rec` is the record to write back
  // (absent when nothing changed), `after` the accounting hook to run once it
  // is written. The file and the database backends apply them the same way.
  // `grant` (a connector grant, src/mcp-oauth.js): { id, capUsd }. Its day's
  // spend and holds live on the key's own record (rec.grantDays), so the cap
  // is checked and held under the same lock as the balance, on every replica.
  function authorizeOn(rec, hash, need, priceUsd, holdId = null, grant = null) {
    if (!rec) return { result: { ok: false, reason: "unknown" } };
    // A key frozen while a payment that loaded it is questioned (a dispute or
    // a fraud warning, FROZEN) spends nothing, on a key or a connector grant.
    if (rec.disabled && FROZEN.has(rec.disabledReason)) return { result: { ok: false, reason: "frozen", balanceUsd: microToUsd(rec.balanceMicro) } };
    if (rec.disabled) return { result: { ok: false, reason: "disabled", balanceUsd: microToUsd(rec.balanceMicro), ...(rec.disabledReason === "revoked" ? { revoked: true } : {}) } };
    // The holder's own limits (set on the balance page): a most per call, and
    // a most per UTC day counting what is spent and what is held.
    const lim = rec.limits || {};
    if (Number(lim.perCallMicro) > 0 && need > Number(lim.perCallMicro)) return { result: { ok: false, reason: "over_call_limit", balanceUsd: microToUsd(rec.balanceMicro), priceUsd, limitUsd: microToUsd(lim.perCallMicro) } };
    if (Number(lim.dailyMicro) > 0 && daySpentMicro(rec) + (Number(rec.heldMicro) || 0) + need > Number(lim.dailyMicro)) {
      const today = dayOf(now());
      const notify = rec.limitNoticeDay !== today && !rec.lowNoticeOff && onSpendLimit && rec.email ? { keyId: rec.keyId, email: rec.email, limitUsd: microToUsd(lim.dailyMicro) } : null;
      if (notify) rec.limitNoticeDay = today;
      return { ...(notify ? { rec, after: () => { try { onSpendLimit(notify); } catch { /* a notice never breaks a call */ } } } : {}), result: { ok: false, reason: "over_daily_limit", balanceUsd: microToUsd(rec.balanceMicro), priceUsd, limitUsd: microToUsd(lim.dailyMicro) } };
    }
    if (rec.balanceMicro < need) return { result: { ok: false, reason: "insufficient", balanceUsd: microToUsd(rec.balanceMicro), priceUsd } };
    let g = null;
    if (grant) {
      const day = utcDay(now());
      const prev = rec.grantDays?.[grant.id];
      g = prev && prev.d === day ? { ...prev } : { d: day, s: 0, h: 0 };
      const capMicro = usdToMicro(grant.capUsd);
      if ((Number(g.s) || 0) + (Number(g.h) || 0) + need > capMicro) return { result: { ok: false, reason: "daily_cap", balanceUsd: microToUsd(rec.balanceMicro), priceUsd, capUsd: microToUsd(capMicro), spentTodayUsd: microToUsd(Number(g.s) || 0) } };
      g.h = (Number(g.h) || 0) + need;
      rec.grantDays = { ...pruneGrantDays(rec.grantDays, day), [grant.id]: g };
    }
    rec.balanceMicro -= need; rec.heldMicro = (rec.heldMicro || 0) + need;
    if (holdId) rec.holds = { ...(rec.holds || {}), [holdId]: { m: need, at: now(), ...(g ? { g: grant.id, gd: g.d } : {}) } };
    return { rec, result: { ok: true, hash, keyId: rec.keyId, heldMicro: need, balanceUsd: microToUsd(rec.balanceMicro), priceUsd, ...(holdId ? { holdId } : {}) } };
  }
  // A grant hold ends: what it held leaves the grant's day, and what the
  // debit took (if any) is that day's spend. A hold from a day already over
  // moves nothing (the new day started from zero).
  function grantHoldDone(rec, entry, held, taken) {
    const id = entry?.g;
    if (!id || !rec.grantDays || !Object.hasOwn(rec.grantDays, id)) return;
    const g = { ...rec.grantDays[id] };
    if (g.d !== entry.gd) return;
    g.h = Math.max(0, (Number(g.h) || 0) - held);
    g.s = (Number(g.s) || 0) + Math.max(0, taken);
    rec.grantDays = { ...rec.grantDays, [id]: g };
  }
  // A hold the sweep already returned (its entry is gone) is worth nothing
  // now: the settle or release that finally arrives moves no money.
  // A caller that names no hold ends the oldest entry of that size, so the
  // entries keep matching heldMicro and the sweep never returns money twice.
  function takeHold(rec, heldMicro, holdId) {
    if (!rec.holds) return heldMicro;
    if (!holdId) {
      // A connector grant's hold is always named; an unnamed end never takes it.
      const hit = Object.entries(rec.holds).filter(([, h]) => Number(h?.m) === Number(heldMicro) && !h?.g).sort((a, b) => a[1].at - b[1].at)[0];
      if (hit) delete rec.holds[hit[0]];
      return heldMicro;
    }
    if (!Object.hasOwn(rec.holds, holdId)) { log(`[credits] key ${rec.keyId}: hold ${holdId.slice(-8)} was already returned by the sweep; nothing moves`); return 0; }
    delete rec.holds[holdId];
    return heldMicro;
  }
  function settleOn(rec, heldMicro, slug, chargeUsd, holdId = null, via = null, debitId = null) {
    if (!rec) return { result: null };
    // A retried settle whose first attempt landed (its reply was lost): the
    // row already says what that settle took. Nothing moves again, and the
    // sale is booked at that amount (the first attempt never booked it).
    const prior = holdId && !Object.hasOwn(rec.holds || {}, holdId) ? rec.settledHolds?.[holdId] : null;
    // A hold the sweep debited (`booked`) already booked its sale.
    if (prior) {
      const taken = Number(prior.m) || 0;
      return { result: { balanceUsd: microToUsd(rec.balanceMicro), chargedUsd: microToUsd(taken), heldUsd: microToUsd(Number(prior.h) || taken), returnedUsd: microToUsd(Math.max(0, (Number(prior.h) || taken) - taken)) }, ...(prior.booked ? {} : { after: () => onDebit?.({ slug, priceUsd: microToUsd(taken), keyId: rec.keyId, via }) }) };
    }
    // A key frozen while this call ran (a dispute or a fraud warning on the
    // payment that loaded it) takes nothing more: the hold goes back.
    if (rec.disabled && FROZEN.has(rec.disabledReason)) {
      const back = releaseOn(rec, heldMicro, holdId);
      return { rec, result: { balanceUsd: back.result.balanceUsd, chargedUsd: 0, heldUsd: microToUsd(heldMicro), returnedUsd: microToUsd(heldMicro) } };
    }
    const entry = holdId && rec.holds && Object.hasOwn(rec.holds, holdId) ? rec.holds[holdId] : null;
    heldMicro = takeHold(rec, heldMicro, holdId);
    const held = Math.min(heldMicro, rec.heldMicro || 0);
    const want = Number.isFinite(Number(chargeUsd)) && Number(chargeUsd) > 0 ? usdToMicro(Number(chargeUsd)) : held;
    const taken = Math.min(held, want);
    grantHoldDone(rec, entry, held, taken);
    const returned = held - taken;
    rec.heldMicro = (rec.heldMicro || 0) - held; rec.balanceMicro += returned; rec.spentMicro += taken; rec.calls += 1; rec.lastUsedAt = new Date(now()).toISOString();
    addDaySpent(rec, taken);
    if (holdId) rec.settledHolds = recentSettled({ ...(rec.settledHolds || {}), [holdId]: { m: taken, h: held, at: now() } });
    // `d`: the debit id a signed receipt names as its settlement.
    note(rec, { k: "charge", slug: slug ?? null, m: taken, ...(typeof debitId === "string" && debitId ? { d: debitId } : {}) });
    const low = lowCrossed(rec, taken) ? lowNotice(rec) : null;
    return { rec, result: { balanceUsd: microToUsd(rec.balanceMicro), chargedUsd: microToUsd(taken), heldUsd: microToUsd(held), returnedUsd: microToUsd(returned) }, after: () => { onDebit?.({ slug, priceUsd: microToUsd(taken), keyId: rec.keyId, via }); low?.(); } };
  }
  // What each recent settle took, by hold id (database only): kept long
  // enough for a retry of a settle whose reply was lost, then dropped.
  const SETTLED_KEEP_MS = 15 * 60_000, SETTLED_KEEP_MAX = 200;
  function recentSettled(map) {
    const cut = now() - SETTLED_KEEP_MS;
    const live = Object.entries(map).filter(([, v]) => Number(v?.at) >= cut).sort((a, b) => b[1].at - a[1].at).slice(0, SETTLED_KEEP_MAX);
    return Object.fromEntries(live);
  }
  function releaseOn(rec, heldMicro, holdId = null) {
    if (!rec) return { result: null };
    const entry = holdId && rec.holds && Object.hasOwn(rec.holds, holdId) ? rec.holds[holdId] : null;
    heldMicro = takeHold(rec, heldMicro, holdId);
    const back = Math.min(heldMicro, rec.heldMicro || 0);
    grantHoldDone(rec, entry, back, 0);
    rec.heldMicro = (rec.heldMicro || 0) - back; rec.balanceMicro += back;
    return { rec, result: { balanceUsd: microToUsd(rec.balanceMicro) } };
  }
  function chargeOn(a, priceUsd, slug) {
    if (!a) return { result: null };
    const need = usdToMicro(priceUsd);
    const taken = Math.min(need, a.balanceMicro);
    a.balanceMicro -= taken; a.spentMicro += taken; a.calls += 1; a.lastUsedAt = new Date(now()).toISOString();
    addDaySpent(a, taken);
    note(a, { k: "charge", slug: slug ?? null, m: taken });
    const low = lowCrossed(a, taken) ? lowNotice(a) : null;
    return { rec: a, result: { balanceUsd: microToUsd(a.balanceMicro), chargedUsd: microToUsd(taken) }, after: () => { onDebit?.({ slug, priceUsd: microToUsd(taken), keyId: a.keyId }); low?.(); } };
  }

  // Pre-handler authorization WITH RESERVATION: the list price is moved from
  // the available balance into a hold before the handler runs, so N concurrent
  // calls on one key can never collectively exceed the balance (without the
  // hold, every call passed the balance check and only floor(balance/price)
  // debits landed - the rest were served free). settle() converts the hold to
  // spend on a final 200; release() returns it on any other outcome.
  function authorize(keyString, priceUsd) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return answer({ ok: false, reason: "malformed" });
    const hash = hashKey(keyString);
    const need = usdToMicro(priceUsd);
    const holdId = usePg ? `${hash.slice(0, 12)}:${randomBytes(8).toString("hex")}` : null;
    return mutate(hash, (rec) => authorizeOn(rec, hash, need, priceUsd, holdId));
  }
  // A connector grant's hold (src/mcp-oauth.js): by key id (a grant never
  // holds the key), under the grant's daily cap. Always a named hold, so the
  // settle or release finds the grant it counts against. Async on both backends.
  async function authorizeGrant(keyId, priceUsd, grant) {
    const hash = await keyHashById(String(keyId || ""));
    if (!hash) return { ok: false, reason: "unknown" };
    const need = usdToMicro(priceUsd);
    const holdId = `${hash.slice(0, 12)}:${randomBytes(8).toString("hex")}`;
    return mutate(hash, (rec) => (rec && rec.keyId === keyId ? authorizeOn(rec, hash, need, priceUsd, holdId, grant) : { result: { ok: false, reason: "unknown" } }));
  }
  /** What a grant spent on its key today (USD), for the balance page. */
  async function grantSpentToday(keyId, grantId) {
    const hash = await keyHashById(String(keyId || ""));
    const rec = hash ? await readRec(hash) : null;
    const g = rec?.grantDays?.[grantId];
    return g && g.d === utcDay(now()) ? microToUsd(Number(g.s) || 0) : 0;
  }
  /** The key id and purchase email a claimed Checkout session loaded, or null (internal; never on a public answer). */
  async function sessionOwner(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return null;
    const idx = usePg ? (await readyP(), (await pgGet("_sessions")) || {}) : sessionsIdx();
    const hash = idx[sessionId];
    if (!hash || isRefused(hash)) return null;
    const rec = await readRec(hash);
    return rec?.email ? { keyId: rec.keyId, email: rec.email } : null;
  }
  // Final 200: the hold becomes spend. `chargeUsd` (the meter's actual x
  // markup on a metered route) takes LESS than the hold and returns the rest
  // to the balance; it can never take more than was held.
  // `via`: the path the call arrived on (src/sale-path.js), passed to onDebit.
  function settle(hash, heldMicro, slug, chargeUsd = null, holdId = null, via = null, debitId = null) {
    return mutate(hash, (rec) => settleOn(rec, heldMicro, slug, chargeUsd, holdId, via, debitId));
  }
  // A final 200 is about to end: mark the hold settling with what the debit
  // takes, so a sweep that finds it after its settle could not land turns it
  // into spend instead of returning it (database only).
  function markSettling(hash, holdId, chargeUsd, slug, via) {
    return mutatePgNow(hash, (rec) => {
      const h = rec?.holds?.[holdId];
      if (!h) return { result: false };
      const want = Number.isFinite(Number(chargeUsd)) && Number(chargeUsd) > 0 ? usdToMicro(Number(chargeUsd)) : Number(h.m) || 0;
      rec.holds = { ...rec.holds, [holdId]: { ...h, s: { m: Math.min(Number(h.m) || 0, want), slug, via } } };
      return { rec, result: true };
    });
  }
  // Any non-200 outcome (4xx/5xx, client abort before the response finished):
  // the hold goes back to the balance - nothing was charged.
  function release(hash, heldMicro, holdId = null) {
    return mutate(hash, (rec) => releaseOn(rec, heldMicro, holdId));
  }
  // Kept for direct callers/tests: an immediate debit without a prior hold.
  function charge(hash, priceUsd, slug) {
    return mutate(hash, (a) => chargeOn(a, priceUsd, slug));
  }

  const balanceOf = (rec) => (rec ? { keyId: rec.keyId, balanceUsd: microToUsd(rec.balanceMicro), heldUsd: microToUsd(rec.heldMicro || 0), loadedUsd: microToUsd(rec.loadedMicro), spentUsd: microToUsd(rec.spentMicro), calls: rec.calls, createdAt: rec.createdAt, lastUsedAt: rec.lastUsedAt, disabled: !!rec.disabled, ...(rec.disabled && rec.disabledReason === "revoked" ? { revoked: true } : {}), ...(rec.limits && (rec.limits.dailyMicro || rec.limits.perCallMicro) ? { limits: { dailyUsd: microToUsd(rec.limits.dailyMicro || 0) || null, perCallUsd: microToUsd(rec.limits.perCallMicro || 0) || null } } : {}), ...(rec.refundRequest ? { refund: { state: rec.refundRequest.state === "done" ? "refunded" : "pending", amountUsd: (Number(rec.refundRequest.cents) || 0) / 100 } } : {}) } : null);
  function balance(keyString) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return answer(null);
    const rec = readRec(hashKey(keyString));
    return usePg ? rec.then(balanceOf) : balanceOf(rec);
  }

  // Operator: totals + per-key rows (key id only - never the key or its hash).
  const statusOf = (keys) => {
    const tot = (k) => keys.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    return {
      keys: keys.length, loadedUsd: microToUsd(tot("loadedMicro")), spentUsd: microToUsd(tot("spentMicro")), outstandingUsd: microToUsd(tot("balanceMicro")), heldUsd: microToUsd(tot("heldMicro")), calls: tot("calls"),
      rows: keys.sort((a, b) => String(b.lastUsedAt || b.createdAt).localeCompare(String(a.lastUsedAt || a.createdAt))).slice(0, 200).map((r) => ({ keyId: r.keyId, balanceUsd: microToUsd(r.balanceMicro), spentUsd: microToUsd(r.spentMicro), calls: r.calls, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, disabled: !!r.disabled, disabledReason: r.disabled ? r.disabledReason || null : null })),
    };
  };
  function status() {
    if (usePg) return allKeysLite().then((xs) => statusOf(xs.map((x) => x.rec)));
    return statusOf(allKeys().map((x) => x.rec));
  }
  // The operator's switch. A disable records "operator" as the reason, which
  // no webhook path overrides or lifts: only this switch clears it.
  const operatorSwitch = (r, disabled) => { r.disabled = !!disabled; r.disabledReason = disabled ? "operator" : null; };
  function setDisabled(keyId, disabled) {
    if (usePg) return allKeys().then((xs) => { const hit = xs.find((x) => x.rec?.keyId === keyId); return hit ? mutatePg(hit.hash, (r) => (r ? { rec: (operatorSwitch(r, disabled), r), result: true } : { result: false })) : false; });
    for (const { hash, rec: r } of allKeys()) { if (r?.keyId === keyId) { operatorSwitch(r, disabled); save(hash, r); return true; } }
    return false;
  }

  // A refunded or disputed pack payment claws its key back. Looked up by
  // PaymentIntent id from the Stripe webhook (charge.refunded /
  // charge.dispute.created). A refund with an amount takes that much (the
  // charge's running total, so a second refund takes only its own part) off
  // the balance, and disables the key only once the payment is fully
  // refunded; a dispute, or a refund with no amount, disables it outright.
  // Disable causes rank: an operator disable is kept over a refund, a refund
  // over a dispute, so the reason on the key is the strongest cause and a
  // dispute closing lifts nothing a stronger cause holds. The dispute itself
  // is recorded beside it (disputedPaymentIntent, disputeAt). Returns the
  // key id or null.
  const paidBy = (r, paymentIntent) => r && Array.isArray(r.paymentIntents) && r.paymentIntents.includes(paymentIntent);
  // The record of one charged payment's refund total, kept per payment on a
  // key loaded more than once and as the key's total otherwise.
  function noteRefundedTo(rec, pi, targetCents) {
    if (Array.isArray(rec.payments) && rec.payments.some((p) => p.pi === pi)) {
      rec.payments = rec.payments.map((p) => (p.pi === pi ? { ...p, refundedCents: Math.max(Number(p.refundedCents) || 0, Number(targetCents) || 0) } : p));
      rec.refundedMicro = rec.payments.reduce((a, p) => a + (Number(p.refundedCents) || 0) * 10_000, 0);
      return;
    }
    rec.refundedMicro = Math.max(Number(rec.refundedMicro) || 0, Number(targetCents) * 10_000);
  }
  function unnoteRefunded(rec, pi, cents) {
    if (Array.isArray(rec.payments) && rec.payments.some((p) => p.pi === pi)) {
      rec.payments = rec.payments.map((p) => (p.pi === pi ? { ...p, refundedCents: Math.max(0, (Number(p.refundedCents) || 0) - (Number(cents) || 0)) } : p));
      rec.refundedMicro = rec.payments.reduce((a, p) => a + (Number(p.refundedCents) || 0) * 10_000, 0);
      return;
    }
    rec.refundedMicro = Math.max(0, (Number(rec.refundedMicro) || 0) - (Number(cents) || 0) * 10_000);
  }
  // What Stripe says of one refund of a requested refund, applied to the
  // record as it stands under the key's lock (the request's retries and the
  // refund webhooks both land here):
  //   - succeeded: the part for that payment is done, once, whichever of its
  //     refunds succeeded; a later success for the same part changes nothing.
  //   - failed or canceled: the part fails (owed; asking again sends anew)
  //     only when that refund is the one the part is waiting on, or it waits
  //     on none. A failure of an older refund, arriving after a newer one was
  //     sent, is only remembered: it never replaces the newer refund's id.
  //     A part that succeeded and then fails at Stripe is owed again.
  //   - pending: the part waits on that refund, unless it already waits on
  //     another or that refund failed before.
  // Answers true (the request changed), "noted" (only the failure list) or null.
  function applyRefundOn(rec, { keyId, pi, id, st }) {
    if (!rec?.refundRequest || rec.keyId !== keyId) return null;
    const parts = partsOf(rec);
    const part = parts.find((p) => p.pi === pi);
    if (!part) return null;
    const failed = Array.isArray(part.failedIds) ? part.failedIds : [];
    const at = new Date(now()).toISOString();
    if (st === "succeeded") {
      if (part.state === "done") {
        if (id && part.refundId && id !== part.refundId) log(`[credits] key ${keyId}: a second refund (${id}) succeeded for a request already refunded by ${part.refundId}; check it in Stripe`);
        return null;
      }
      Object.assign(part, { state: "done", refundId: id || part.refundId || null, doneAt: at });
      noteRefundedTo(rec, pi, part.targetCents);
      log(`[credits] key ${keyId}: unspent balance refunded on request ($${((Number(part.cents) || 0) / 100).toFixed(2)}${id ? `, ${id}` : ""})`);
    } else if (st === "failed" || st === "canceled") {
      if (id && failed.includes(id)) return null;
      const current = part.state === "done" ? part.refundId === id : !part.refundId || part.refundId === id;
      if (!current) {
        if (!id) return null;
        part.failedIds = [...failed, id].slice(-20);
        rec.refundRequest = withPartsState(rec.refundRequest, parts, now);
        return "noted";
      }
      if (part.state === "done") unnoteRefunded(rec, pi, part.cents);
      Object.assign(part, { state: "failed", why: `refund_${st}`, refundId: null, failedIds: [...failed, ...(id ? [id] : [])].slice(-20) });
      delete part.doneAt;
      log(`[credits] key ${keyId}: refund on request ${st} at Stripe${id ? ` (${id})` : ""}; owed: asking again sends it anew, or refund it by hand (creditsRefunds on /api/gateway-status)`);
    } else if (st === "pending" || st === "requires_action") {
      if (!id || part.state === "done" || failed.includes(id) || part.refundId) return null;
      Object.assign(part, { state: "pending", refundId: id, sentAt: now() });
    } else return null;
    rec.refundRequest = withPartsState(rec.refundRequest, parts, now);
    return true;
  }
  // "refund-requested": the holder asked for the unspent balance back (requestRefund).
  const CAUSE_RANK = { operator: 3, "fraud-warning": 2, revoked: 2, refunded: 2, "refund-requested": 2, disputed: 1 };
  function disableByPaymentIntent(paymentIntent, reason = "refunded", { amountRefundedCents = null, fullyRefunded = null } = {}) {
    if (!paymentIntent) return answer(null);
    const cents = amountRefundedCents == null ? null : Number(amountRefundedCents);
    const clawback = (r) => {
      if (reason === "disputed") { r.disputedPaymentIntent = paymentIntent; r.disputeAt = new Date(now()).toISOString(); }
      if (reason === "refunded" && cents !== null && Number.isFinite(cents) && cents >= 0) {
        // `cents` is this charge's running total. A key loaded by more than
        // one payment (a top-up) keeps each payment's own total; a key with
        // one payment keeps it as the key's total, as before.
        const pays = Array.isArray(r.payments) && r.payments.length ? r.payments.map((p) => ({ ...p })) : null;
        const pay = pays ? pays.find((p) => p.pi === paymentIntent) : null;
        const before = pay ? Number(pay.refundedCents) || 0 : Math.round((r.refundedMicro || 0) / 10_000);
        const delta = (Math.round(cents) - before) * 10_000;
        if (delta > 0) {
          const off = Math.min(Math.max(0, r.balanceMicro), delta);
          r.balanceMicro = Math.max(0, r.balanceMicro - delta);
          r.refundedMicro = (r.refundedMicro || 0) + delta;
          if (pay) { pay.refundedCents = Math.round(cents); r.payments = pays; }
          if (off > 0) note(r, { k: "refund", m: off });
        }
        // A requested refund made by hand in Stripe is done once the charge shows it.
        // One we sent (its Stripe refund id is recorded) is settled by that
        // refund's own events instead: a charge counts a pending refund too.
        if (r.refundRequest && r.refundRequest.state !== "done") {
          const part = partsOf(r).find((p) => p.pi === paymentIntent);
          if (part && part.state !== "done" && !part.refundId && Number(part.targetCents) > 0 && Math.round(cents) >= Number(part.targetCents)) applyRefundOn(r, { keyId: r.keyId, pi: paymentIntent, id: null, st: "succeeded" });
        }
        const whole = pays && pays.length > 1 ? pays.every((p) => (Number(p.refundedCents) || 0) + (Number(p.lostCents) || 0) >= (Number(p.cents) || 0)) : fullyRefunded === true || Math.round(cents) * 10_000 >= (r.loadedMicro || 0);
        if (!whole) { log(`[credits] key ${r.keyId}: $${(cents / 100).toFixed(2)} refunded (${paymentIntent}), balance reduced`); return r.keyId; }
      }
      // A key disabled with no recorded cause was switched off by the operator
      // (the one path that recorded none): it ranks as such.
      if (r.disabled === true && !CAUSE_RANK[r.disabledReason]) r.disabledReason = "operator";
      const held = r.disabled === true ? CAUSE_RANK[r.disabledReason] : 0;
      r.disabled = true;
      if ((CAUSE_RANK[reason] || 0) >= held) r.disabledReason = reason;
      log(`[credits] key ${r.keyId} disabled (${reason}, ${paymentIntent}${r.disabledReason !== reason ? `; kept ${r.disabledReason}` : ""})`);
      return r.keyId;
    };
    if (usePg) return allKeys().then((xs) => { const hit = xs.find((x) => paidBy(x.rec, paymentIntent)); return hit ? mutatePg(hit.hash, (r) => (paidBy(r, paymentIntent) ? { rec: r, result: clawback(r) } : { result: null })) : null; });
    for (const { hash, rec: r } of allKeys()) {
      if (paidBy(r, paymentIntent)) { const id = clawback(r); save(hash, r); return id; }
    }
    return null;
  }

  // The reverse of a dispute clawback: the dispute closed in our favor (won,
  // or an inquiry closed without a chargeback), so the key it disabled is
  // enabled again. Lifted only when that dispute, on that payment, is the
  // key's sole disable cause: a key the operator switched off, or whose
  // payment was refunded, before or after the dispute, stays disabled
  // (disableByPaymentIntent keeps the stronger cause). Returns the key id or
  // null.
  // The dispute on this payment, recorded on the key, is closed whatever the
  // key's cause (a stronger cause, a fraud warning or the operator, keeps the
  // key disabled, but the dispute no longer stands in the way of a refund).
  // A fraud review the dispute held is owed again. Answers true when it closed one.
  const closeDisputeOn = (r, paymentIntent, outcome) => {
    if (!paidBy(r, paymentIntent) || r.disputedPaymentIntent !== paymentIntent || !disputeOpen(r)) return false;
    r.disputeClosedAt = new Date(now()).toISOString();
    r.disputeOutcome = outcome;
    if (r.fraudReview?.state === "disputed") r.fraudReview = { ...r.fraudReview, state: "owed" };
    return true;
  };
  function enableByPaymentIntent(paymentIntent, reason = "disputed") {
    if (!paymentIntent) return answer(null);
    const held = (r) => paidBy(r, paymentIntent) && r.disabled === true && r.disabledReason === reason
      && (reason !== "disputed" || !r.disputedPaymentIntent || r.disputedPaymentIntent === paymentIntent);
    // A key a stronger cause holds: only the dispute's own record changes.
    const closesOnly = (r) => reason === "disputed" && !held(r) && paidBy(r, paymentIntent) && r.disputedPaymentIntent === paymentIntent && disputeOpen(r);
    const decide = (r) => {
      if (closesOnly(r)) { closeDisputeOn(r, paymentIntent, "won"); log(`[credits] key ${r.keyId}: dispute closed in our favor; kept ${r.disabledReason || "enabled"} (${paymentIntent})`); return { rec: r, result: null }; }
      return held(r) ? { rec: r, result: lift(r) } : { result: null };
    };
    const lift = (r) => {
      if (reason === "disputed") { if (!closeDisputeOn(r, paymentIntent, "won")) r.disputeClosedAt = new Date(now()).toISOString(); }
      // A fraud warning that arrived during the dispute keeps the key frozen
      // under its own cause; its review, held while the dispute ran, is owed again.
      if (reason === "disputed" && Array.isArray(r.fraudWarnings) && r.fraudWarnings.length) {
        r.disabledReason = "fraud-warning";
        if (r.fraudReview?.state === "disputed") r.fraudReview = { ...r.fraudReview, state: "owed" };
        log(`[credits] key ${r.keyId}: dispute closed in our favor; still frozen for a fraud warning (${paymentIntent})`);
        return r.keyId;
      }
      r.disabled = false; r.disabledReason = null;
      log(`[credits] key ${r.keyId} enabled again (${reason} closed in our favor, ${paymentIntent})`);
      return r.keyId;
    };
    const match = (r) => held(r) || closesOnly(r);
    if (usePg) return allKeys().then((xs) => { const hit = xs.find((x) => match(x.rec)); return hit ? mutatePg(hit.hash, (r) => (r ? decide(r) : { result: null })) : null; });
    for (const { hash, rec: r } of allKeys()) {
      if (match(r)) { const out = decide(r); if (out.rec) save(hash, r); return out.result; }
    }
    return null;
  }

  // A dispute LOST: the card network returned the disputed amount to the
  // cardholder. That amount, never more than the payment has left, leaves the
  // balance once (the payment records it as `lostCents`, and a refund never
  // draws on it again). What the key's other payments funded stays the
  // buyer's: a key the dispute alone froze is enabled again while any payment
  // on it is left; one whose every payment is gone stays disabled. A stronger
  // cause keeps the key as it is, and a fraud review the dispute held is owed
  // again for what is left. Returns the key id or null.
  function disputeLostByPaymentIntent(paymentIntent, { amountCents = null } = {}) {
    if (!paymentIntent) return answer(null);
    const match = (r) => paidBy(r, paymentIntent) && r.disputedPaymentIntent === paymentIntent && disputeOpen(r);
    const take = (r) => {
      const pays = Array.isArray(r.payments) && r.payments.length ? r.payments.map((p) => ({ ...p })) : (() => {
        const first = Array.isArray(r.paymentIntents) ? r.paymentIntents[0] || null : null;
        return [{ pi: first, cents: Math.round((Number(r.loadedMicro) || 0) / 10_000), refundedCents: Math.round((Number(r.refundedMicro) || 0) / 10_000), at: Date.parse(r.createdAt) || 0, kind: "purchase", session: Array.isArray(r.sessions) ? r.sessions[0] || null : null }];
      })();
      const pay = pays.find((p) => p.pi === paymentIntent);
      if (pay) {
        const left = Math.max(0, (Number(pay.cents) || 0) - (Number(pay.refundedCents) || 0) - (Number(pay.lostCents) || 0));
        const asked = Number(amountCents);
        const lost = Number.isFinite(asked) && asked > 0 ? Math.min(left, Math.round(asked)) : left;
        pay.lostCents = (Number(pay.lostCents) || 0) + lost;
        r.payments = pays;
        const off = Math.min(Math.max(0, Number(r.balanceMicro) || 0), lost * 10_000);
        r.balanceMicro = Math.max(0, (Number(r.balanceMicro) || 0) - lost * 10_000);
        if (off > 0) note(r, { k: "dispute-lost", m: off });
      }
      closeDisputeOn(r, paymentIntent, "lost");
      const anyLeft = pays.some((p) => (Number(p.cents) || 0) - (Number(p.refundedCents) || 0) - (Number(p.lostCents) || 0) > 0);
      if (r.disabled === true && r.disabledReason === "disputed" && anyLeft) {
        if (Array.isArray(r.fraudWarnings) && r.fraudWarnings.length) r.disabledReason = "fraud-warning";
        else { r.disabled = false; r.disabledReason = null; }
      }
      if (r.fraudReview?.state === "owed" && !((Number(r.balanceMicro) || 0) + (Number(r.heldMicro) || 0) > 0)) r.fraudReview = { ...r.fraudReview, state: "nothing", decidedAt: now() };
      log(`[credits] key ${r.keyId}: dispute lost (${paymentIntent}); ${r.disabled ? `kept ${r.disabledReason}` : "the other payments' share is usable again"}`);
      return r.keyId;
    };
    if (usePg) return allKeys().then((xs) => { const hit = xs.find((x) => match(x.rec)); return hit ? mutatePg(hit.hash, (r) => (r && match(r) ? { rec: r, result: take(r) } : { result: null })) : null; });
    for (const { hash, rec: r } of allKeys()) {
      if (match(r)) { const id = take(r); save(hash, r); return id; }
    }
    return null;
  }
  /** The charge.dispute.closed hook: won (or an inquiry closed) lifts what the
   *  dispute alone held; lost takes the disputed payment off the balance. */
  function disputeClosed(paymentIntent, { won = false, status = null, amountCents = null } = {}) {
    if (won) return enableByPaymentIntent(paymentIntent, "disputed");
    if (status === "lost") return disputeLostByPaymentIntent(paymentIntent, { amountCents });
    return answer(null);
  }

  // REFUND ON REQUEST. The holder of a key asks for its unspent balance back
  // (POST /api/credits/refund, presenting the key). Under the key's lock the
  // balance leaves the key and the key is disabled, so nothing spends it while
  // the card refund is made; a key with a call in flight (a hold) answers
  // "in_flight" and moves nothing. The refund is the whole unspent balance,
  // rounded up to the cent and never more than the charge has left, with no
  // fee, to the card that bought the key. Each request sends under one Stripe
  // idempotency key, and a later send first reads the charge: a refund that
  // already landed (a lost reply, or one made by hand) is recorded, never sent
  // again. A send that fails leaves the request "failed" (owed: creditsRefunds
  // on /api/gateway-status); asking again retries it. The request is done only
  // when Stripe says the refund succeeded: a pending one waits for its webhook
  // (settleRefund), and a failed or canceled one is owed and sent again on the
  // next request under a new idempotency key. A key the operator switched off
  // keeps its unspent balance refundable; a key whose payment is under an open
  // dispute answers "disputed" (the dispute settles what goes back).
  const disputeOpen = (rec) => Boolean(rec.disputedPaymentIntent) && (!rec.disputeClosedAt || String(rec.disputeAt || "") > String(rec.disputeClosedAt));
  // A request is sent as one card refund per payment it draws on (a key
  // topped up holds more than one payment). Part 0 keeps the idempotency key
  // a one-payment request always had.
  const refundIdemKey = (keyId, rr, part, i = 0) => {
    const failed = Array.isArray(part?.failedIds) ? part.failedIds.length : 0;
    return `credits-refund-${keyId}-${rr.at}${i ? `-p${i}` : ""}${failed ? `-${failed}` : ""}`;
  };
  // The whole unspent balance, rounded up to the cent, split over the payments
  // that loaded the key, newest first, never more than a payment has left.
  function refundPlan(rec) {
    const balanceCents = Math.ceil(rec.balanceMicro / 10_000);
    if (!(Array.isArray(rec.payments) && rec.payments.length)) {
      const refundedCents = Math.round((Number(rec.refundedMicro) || 0) / 10_000);
      const cents = Math.max(0, Math.min(balanceCents, Math.round((Number(rec.loadedMicro) || 0) / 10_000) - refundedCents));
      const pi = Array.isArray(rec.paymentIntents) ? rec.paymentIntents[0] || null : null;
      return { cents, parts: cents ? [{ pi, cents, targetCents: refundedCents + cents, state: "pending" }] : [] };
    }
    const parts = [];
    let left = balanceCents;
    for (const p of [...rec.payments].reverse()) {
      if (left <= 0) break;
      const had = Number(p.refundedCents) || 0;
      // A share a lost dispute returned to the card is never refunded again.
      const take = Math.min(left, Math.max(0, (Number(p.cents) || 0) - had - (Number(p.lostCents) || 0)));
      if (take > 0) { parts.push({ pi: p.pi || null, cents: take, targetCents: had + take, state: "pending" }); left -= take; }
    }
    return { cents: parts.reduce((a, p) => a + p.cents, 0), parts };
  }
  async function requestRefund(keyString) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return { status: "malformed" };
    return requestRefundOf(hashKey(keyString));
  }
  async function requestRefundOf(hash) {
    const start = await mutate(hash, (rec) => {
      if (!rec) return { result: { status: "unknown" } };
      const rr = rec.refundRequest;
      if (rr && rr.state === "done") return { result: { status: "refunded", keyId: rec.keyId, refundedUsd: (Number(rr.cents) || 0) / 100 } };
      if (rr) return { result: { status: "retry", keyId: rec.keyId, rr: { ...rr, parts: partsOf(rec) } } };
      if (rec.disabled && (rec.disabledReason === "disputed" || disputeOpen(rec))) return { result: { status: "disputed", keyId: rec.keyId } };
      if ((Number(rec.heldMicro) || 0) > 0) return { result: { status: "in_flight", keyId: rec.keyId } };
      // The amount, and the charge total each part brings its charge to, are
      // fixed here, under the lock, so every send of this request is the same one.
      const plan = refundPlan(rec);
      if (!(rec.balanceMicro > 0) || plan.cents === 0) return { result: { status: "nothing_to_refund", keyId: rec.keyId } };
      const fresh = { micro: rec.balanceMicro, cents: plan.cents, at: now(), state: "pending", parts: plan.parts };
      // An operator disable stays the key's cause (it ranks above a request).
      const keepCause = rec.disabled === true && rec.disabledReason !== "refund-requested" && (CAUSE_RANK[rec.disabledReason] || 3) > CAUSE_RANK["refund-requested"];
      rec.refundRequest = fresh; rec.balanceMicro = 0; rec.disabled = true; rec.disabledReason = keepCause ? (rec.disabledReason || "operator") : "refund-requested";
      note(rec, { k: "refund", m: fresh.micro });
      return { rec, result: { status: "new", keyId: rec.keyId, rr: { ...fresh, parts: fresh.parts.map((p) => ({ ...p })) } } };
    });
    if (start.status !== "new" && start.status !== "retry") return start;
    const { keyId, rr } = start;
    // Every outcome is decided under the key's lock from the record as it is
    // then (applyRefundOn), never from what this request read earlier: a
    // retry racing a webhook cannot write an older refund over a newer one.
    const step = (patch) => mutate(hash, (rec) => {
      if (!rec?.refundRequest || rec.keyId !== keyId) return { result: null };
      const out = patch(rec);
      return out ? { rec, result: out } : { result: null };
    });
    const report = (r, pi) => step((rec) => (applyRefundOn(rec, { keyId, pi, id: r?.id || null, st: String(r?.status || "") }) ? true : null));
    const failPart = (pi, why) => step((rec) => {
      const parts = partsOf(rec);
      const part = parts.find((p) => p.pi === pi);
      if (!part || part.state === "done" || part.refundId) return null;
      part.state = "failed"; part.why = why;
      rec.refundRequest = withPartsState(rec.refundRequest, parts, now);
      return true;
    });
    for (let i = 0; i < rr.parts.length; i++) {
      const part = rr.parts[i];
      if (part.state === "done") continue;
      const pi = part.pi;
      if (!pi) { await failPart(pi, "no_payment"); log(`[credits] key ${keyId}: refund requested but the key names no payment - refund it by hand (creditsRefunds on /api/gateway-status)`); continue; }
      // A refund we sent and Stripe holds as pending: read where it stands now.
      if (part.state === "pending" && part.refundId) {
        try { await report(await stripe.refunds.retrieve(part.refundId), pi); } catch { /* decided later */ }
        continue;
      }
      // What the charge shows now: its amount and how much of it was refunded.
      let charge = null;
      try {
        const p = await stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge"] });
        const c = p?.latest_charge;
        if (c && Number.isFinite(Number(c.amount))) charge = { amount: Number(c.amount), refunded: Math.max(0, Number(c.amount_refunded) || 0) };
      } catch { /* decided below */ }
      // A refund that already landed (a lost reply, a send from another
      // container, or one made by hand) is recorded, never sent again; on a
      // later send, a charge that cannot be read sends nothing.
      if (charge && charge.refunded >= part.targetCents) {
        // The charge's total can still count a refund that failed, so the
        // refunds themselves decide: the live ones (not failed or canceled)
        // reach the target, and ours among them settles by its status, or none
        // of ours means it was made by hand. Unreadable: decided later.
        let list = null;
        try { list = await stripe.refunds.list({ payment_intent: pi, limit: 100 }); } catch { continue; }
        const failedIds = Array.isArray(part.failedIds) ? part.failedIds : [];
        const live = (list?.data || []).filter((x) => x && x.status !== "failed" && x.status !== "canceled" && !failedIds.includes(x.id));
        if (live.reduce((n, x) => n + (Number(x.amount) || 0), 0) >= part.targetCents) {
          const mine = live.find((x) => x?.metadata?.credits_refund_request === keyId);
          await report(mine || { id: null, status: "succeeded" }, pi);
          continue;
        }
      }
      if (!charge && start.status === "retry") continue;
      try {
        const r = await stripe.refunds.create({ payment_intent: pi, amount: part.cents, metadata: { credits_refund_request: keyId } }, { idempotencyKey: refundIdemKey(keyId, rr, part, i) });
        await report(r, pi);
        const st = String(r?.status || "");
        if (st === "failed" || st === "canceled") log(`[credits] key ${keyId}: refund on request ${st} at Stripe; asking again sends it anew, or refund it by hand (creditsRefunds on /api/gateway-status)`);
      } catch (e) {
        try { await failPart(pi, "send_failed"); } catch { /* owed once pending passes STUCK_MS */ }
        log(`[credits] key ${keyId}: refund on request FAILED (${String(e?.message || e).slice(0, 120)}); asking again retries it, or refund it by hand (creditsRefunds on /api/gateway-status)`);
      }
    }
    const end = await readRec(hash);
    const now_ = end?.refundRequest;
    if (now_?.state === "done") {
      log(`[credits] key ${keyId}: unspent balance refunded on request ($${((Number(now_.cents) || 0) / 100).toFixed(2)})`);
      return { status: "refunded", keyId, refundedUsd: (Number(now_.cents) || 0) / 100 };
    }
    return { status: "pending", keyId, refundUsd: (Number(rr.cents) || 0) / 100 };
  }
  /** Keys whose requested refund failed, or never finished: not sent (pending
   *  past STUCK_MS), or sent and still pending at Stripe past SENT_STUCK_MS. */
  async function refundRequestsOwed() {
    const t = now();
    return (await allKeysLite()).filter(({ rec }) => {
      // A frozen key whose refund waits for a person's approval, listed until
      // the review is resolved; only an open dispute (which decides what goes
      // back) holds it off the list.
      const review = rec?.fraudReview?.state;
      if ((review === "owed" || review === "disputed") && !rec.refundRequest && (Number(rec.balanceMicro) || 0) + (Number(rec.heldMicro) || 0) > 0) return !disputeOpen(rec);
      const rr = rec?.refundRequest;
      if (!rr || rr.state === "done") return false;
      if (rr.state === "failed") return true;
      return partsOf(rec).some((p) => p.state === "failed" || (p.state !== "done" && (p.refundId ? t - Number(p.sentAt || rr.at) > SENT_STUCK_MS : t - Number(rr.at) > STUCK_MS)));
    }).map(({ rec }) => rec.keyId);
  }

  // The one word /api/gateway-status shows for owed card refunds. Both reads
  // walk every key record, and that surface is public and uncached, so the
  // word is computed at most once per OWED_WORD_TTL_MS and concurrent readers
  // share one walk; a failed walk is not kept.
  const OWED_WORD_TTL_MS = 30_000;
  let owedWordMemo = null;
  function refundsOwedWord(ttlMs = OWED_WORD_TTL_MS) {
    const t = Date.now();
    if (owedWordMemo && t - owedWordMemo.at < ttlMs) return owedWordMemo.p;
    const p = Promise.all([refusalsToRefund(), refundRequestsOwed()]).then(([a, b]) => (a.length || b.length ? "owed" : "ok"));
    owedWordMemo = { at: t, p };
    p.catch(() => { if (owedWordMemo?.p === p) owedWordMemo = null; });
    return p;
  }

  // A Stripe refund event (refund.updated, refund.failed,
  // charge.refund.updated) for a refund we sent on request, matched by its
  // metadata and payment, decided by applyRefundOn under the key's lock.
  // Idempotent: a retried delivery changes nothing. Returns the key id it
  // changed, or null.
  function settleRefund(refund) {
    const keyId = refund?.metadata?.credits_refund_request;
    const id = typeof refund?.id === "string" ? refund.id : null;
    const pi = typeof refund?.payment_intent === "string" ? refund.payment_intent : refund?.payment_intent?.id || null;
    const st = String(refund?.status || "");
    if (!keyId || !id || !pi) return answer(null);
    const step = (rec) => {
      if (!rec?.refundRequest || rec.keyId !== keyId || !paidBy(rec, pi)) return { result: null };
      const changed = applyRefundOn(rec, { keyId, pi, id, st });
      return changed ? { rec, result: changed === "noted" ? null : keyId } : { result: null };
    };
    if (usePg) return allKeys().then((xs) => { const hit = xs.find((x) => x.rec?.keyId === keyId); return hit ? mutatePg(hit.hash, step) : null; });
    for (const { hash, rec } of allKeys()) { if (rec?.keyId === keyId) return mutateFile(hash, step); }
    return null;
  }

  // On the database, a settle or release after the answer is a promise nobody
  // awaits. A release is retried a few times; one that never lands leaves the
  // hold to the sweep, which returns it to the balance. A settle (`persist`)
  // is retried with backoff until shortly before the sweep window, while its
  // hold stays live and fresh; one that never lands leaves a hold the sweep
  // debits when it was marked settling, and returns otherwise.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The hold stays in `liveHolds` until its settle or release has landed or
  // given up.
  function later(label, fn, onDone = null, holdId = null, { persist = false } = {}) {
    (async () => {
      const deadline = Date.now() + Math.floor(abandonedHoldMs() * 0.9);
      try {
        for (let i = 0; ; i++) {
          try { const c = await fn(); onDone?.(c); return; }
          catch (e) {
            const wait = persist ? Math.min(30_000, 500 * 2 ** i) : 500 * (i + 1);
            if (persist ? Date.now() + wait >= deadline : i === 2) { log(`[credits] ${label} failed after retries (the sweep takes the hold after ${Math.round(abandonedHoldMs() / 1000)} s): ${String(e?.message || e).slice(0, 120)}`); return; }
            await sleep(wait);
          }
        }
      } finally { if (holdId) { liveHolds.delete(holdId); stopHoldFresh(holdId); } }
    })();
  }

  // GUESSING WATCH. A key is 32 random bytes (24 for keys issued before the
  // prefix), so it cannot be guessed, and a key works only when its hash is a
  // stored record, so it cannot be made up. Refusing a client after failed
  // keys would also refuse a paying customer behind the same address, so a
  // valid key is ALWAYS served: only failed lookups are slowed. Per client
  // (req.ip, an IPv6 address by its /64), a client that sends the private
  // table's badKey.failedMax unknown, malformed or revoked keys within its
  // badKey.windowMs (src/credits-guards.js) is logged once, counted on the
  // operator credits view, and its further failed lookups are answered 429
  // until that window ends (a key that works is answered as usual). The count
  // is kept in the shared store too; this process's own map (bounded) answers
  // when the store does not. Without the table nobody is held: a key cannot
  // be guessed either way, and a valid key is served regardless.
  const badKeys = new Map(); // client -> { n, until }
  const badKeyBound = () => creditsGuards()?.badKey || null;
  const badKeyMax = () => badKeyBound()?.failedMax ?? Infinity;
  const badKeyWindowMs = () => badKeyBound()?.windowMs ?? 0;
  const badKeyStats = { failures: 0, clientsOverThreshold: 0 };
  function noteBadKey(client, at = now()) {
    const k = limiterKey(String(client || "?"));
    badKeyStats.failures++;
    if (!badKeyBound()) return;
    let e = badKeys.get(k);
    if (!e || e.until <= at) { e = { n: 0, until: at + badKeyWindowMs() }; }
    e.n++;
    badKeys.delete(k); badKeys.set(k, e);
    while (badKeys.size > 5000) badKeys.delete(badKeys.keys().next().value);
    if (e.n === badKeyMax()) { badKeyStats.clientsOverThreshold++; log("[credits] a client passed the failed-key bound"); }
    // Past the bound here the client is held already: nothing more is
    // written. Below it, one fixed counter per client per window (INCRBY and
    // an expiry), so a flood of failed keys keeps the store O(1) per client.
    if (e.n > badKeyMax()) return;
    const tag = tagOf("badkey", k);
    shared.counterAdd("credits-badkey", tag, 1, badKeyWindowMs(), { now: at })
      .then((r) => { if (r?.ok && Number(r.value) >= badKeyMax()) return shared.flagSet("credits-badkey-hold", tag, at + badKeyWindowMs(), { now: at }); })
      .catch(() => {});
  }
  /** Whether a client is past the failed-key bound: this process's count, then the shared one. */
  function badKeyHeldHere(client, at = now()) {
    const e = badKeys.get(limiterKey(String(client || "?")));
    return Boolean(e && e.until > at && e.n >= badKeyMax());
  }
  async function badKeyHeld(client, at = now()) {
    if (!badKeyBound()) return false;
    if (badKeyHeldHere(client, at)) return true;
    const r = await shared.flagGet("credits-badkey-hold", tagOf("badkey", limiterKey(String(client || "?"))), { now: at }).catch(() => null);
    return Boolean(r?.ok && r.until > at);
  }
  // A lookup that found no usable key: unknown, malformed or revoked.
  const failedLookup = (a) => Boolean(a) && !a.ok && (a.reason === "unknown" || a.reason === "malformed" || a.revoked === true);
  const BAD_KEY_BUSY = { error: "Too many requests with a credits key from this client. Try again later.", reason: "rate_limited" };

  // Express gate: mount BEFORE the x402 paywall. `priceFor(method, path)` ->
  // { priceUsd } for catalog routes, null otherwise. A Bearer a402_ key on a
  // priced route either authorizes (req.creditsSettling = true, debit on 200)
  // or answers 402 with the balance and a top-up link; non-credit requests
  // pass through untouched. On the database the middleware is async (the
  // hold is a row lock away); on the files it is synchronous, as before.
  // `settleBeforeEnd()`: when it answers true (src/server.js: signed receipts
  // are served), a final 200 is debited as its answer ENDS, before the last
  // bytes leave, so the receipt signer (mounted before this gate) signs a
  // landed debit: req.creditsDebitId names it. A debit that does not land
  // in CREDITS_DEBIT_WAIT_MS (default 3000) ends the answer without a
  // receipt and is retried as before; the hold is never released for it.
  // `grantOf(req)`: a connector grant this request is paid under (src/mcp-oauth.js:
  // the connector's own loopback names it beside its secret marker), or null.
  // A grant spends its key by id, under the grant's daily cap.
  function gate(priceFor, { settleBeforeEnd = null, grantOf = null } = {}) {
    // What every request does before the hold: null = not ours, pass through;
    // `{ done: true }` = answered here; else the key (or grant) and the priced item.
    const begin = (req, res) => {
      const grant = grantOf ? grantOf(req) : null;
      const auth = String(req.headers?.authorization || "");
      if (!grant && !/^Bearer a402_/.test(auth)) return null;
      const key = grant ? null : auth.slice(7).trim();
      const item = priceFor(req.method, req.path, req);
      if (!item && grant) {
        // A grant pays priced catalog routes only; anything else is refused, never served free on its say-so.
        res.setHeader("X-Credits-Error", "not-priced");
        res.status(402).json({ error: "This route is not sold for credits.", reason: "not-priced" });
        return { done: true };
      }
      if (!item) return null; // not a priced catalog route - let the site handle it
      // Identity-bound routes (wallet-keyed memory, my-usage) derive the caller
      // from a SIGNED x402 payer; a credits key carries no verified wallet, so
      // they are refused here (same rule as the Tempo and Stripe gates).
      if (item.identityBound) {
        res.setHeader("X-Credits-Error", "identity-bound");
        res.status(402).json({ error: "This route is wallet-identity bound (the payment IS the identity); prepaid credits carry no verified wallet. Pay it over an x402 rail.", reason: "identity-bound" });
        return { done: true };
      }
      // Credits are spent only on Agent402's own services: a route that buys
      // from an outside seller with our wallet is sold for a wallet payment
      // only (src/third-party-routes.js).
      if (item.paysThirdParty) {
        res.setHeader("X-Credits-Error", "third-party-purchase");
        res.status(402).json({ error: "Prepaid credits are spent only on Agent402's own services. This route buys from an outside seller with our wallet and is sold for a wallet payment only (x402, or MPP on a chain).", reason: "third-party-purchase" });
        return { done: true };
      }
      return { key, grant, item };
    };
    // After the hold: the refusal, or the settle-on-finish wiring.
    const arm = (req, res, next, a, item, heldShared = false) => {
      if (!a.ok) {
        // Only a failed lookup is slowed; a key that works is never refused here.
        // A connector grant names its key by id from the connector itself, never
        // a guessed key, so its refusal is not a failed lookup of this client.
        if (failedLookup(a) && !grantOf?.(req)) {
          const busy = heldShared || badKeyHeldHere(req.ip);
          noteBadKey(req.ip);
          if (busy) { res.setHeader("X-Credits-Error", "rate_limited"); return res.status(429).json(BAD_KEY_BUSY); }
        }
        res.setHeader("X-Credits-Error", a.reason);
        const said = a.reason === "insufficient" ? `Insufficient credits: this call costs $${item.priceUsd} and the key holds $${a.balanceUsd}.`
          : a.reason === "daily_cap" ? `This connection's daily spending cap is reached: $${a.spentTodayUsd} of $${a.capUsd} spent today (UTC). Raise the cap on your balance page, or wait for the next day.`
          : a.reason === "frozen" ? "This credits balance is on hold while a payment that loaded it is reviewed, so it cannot pay for calls right now."
          : a.reason === "unknown" ? "Unknown credits key." : a.reason === "disabled" ? "This credits key is disabled."
          : a.reason === "over_call_limit" ? `This call costs $${item.priceUsd}, above the $${a.limitUsd} per-call limit set on this balance. Change it from the balance page.`
          : a.reason === "over_daily_limit" ? `This call would pass the $${a.limitUsd} daily limit set on this balance. It resets at 00:00 UTC; change it from the balance page.` : "Malformed credits key.";
        return res.status(402).json({ error: said, reason: a.reason, balanceUsd: a.balanceUsd ?? null, priceUsd: item.priceUsd, ...(a.limitUsd != null ? { limitUsd: a.limitUsd } : {}), ...(a.reason === "daily_cap" ? { capUsd: a.capUsd, spentTodayUsd: a.spentTodayUsd } : {}), ...creditsTopupFields(baseUrl) });
      }
      // Accepted: the x402 dispatcher is bypassed for this request, so any
      // UNSIGNED payment headers riding alongside must not survive to a handler
      // that reads authorization.from (payerFromRequest) - strip them, exactly
      // as the Tempo and Stripe gates do on acceptance.
      for (const h of ["payment-signature", "x-payment", "payment-identifier", "x-pow-solution"]) { if (req.headers && h in req.headers) delete req.headers[h]; }
      req.creditsSettling = true; req.creditsSettled = true; req.creditsKeyId = a.keyId; req.creditsPriceUsd = item.priceUsd;
      if (a.holdId && usePg) { liveHolds.add(a.holdId); keepHoldFresh(a.hash, a.holdId); }
      res.setHeader("X-Credits-Balance", String(a.balanceUsd));
      const slug = item.slug || req.path;
      const via = salePathOf(req);
      // The id of this call's debit: recorded on the key's history and named
      // as the settlement of its signed receipt (never the key or its hash).
      const debitId = `cd_${randomBytes(12).toString("base64url")}`;
      // The two outcomes of the hold. On the files they answer at once; on the
      // database they are scheduled (and retried), and the charged amount is
      // recorded when the debit lands.
      const settleHold = (chargeUsd = null) => {
        if (!usePg) { const c = settle(a.hash, a.heldMicro, slug, chargeUsd, a.holdId ?? null, via, debitId); if (c) req.creditsCharged = c.chargedUsd; return; }
        later(`debit of key ${a.keyId}`, () => settle(a.hash, a.heldMicro, slug, chargeUsd, a.holdId, via, debitId), (c) => { if (c) req.creditsCharged = c.chargedUsd; }, a.holdId, { persist: true });
      };
      const releaseHold = () => {
        if (!usePg) { release(a.hash, a.heldMicro, a.holdId ?? null); return; }
        later(`release of key ${a.keyId}`, () => release(a.hash, a.heldMicro, a.holdId), null, a.holdId);
      };
      let done = false;
      // Debit ONLY when the response actually finished with a 200 (Node's default
      // statusCode is 200 before anything is written, so a client abort before
      // the first byte would otherwise read as a served 200 and be charged).
      // The same rule decides a response whose client left after its headers
      // went out (decideAfterHeaders below).
      const decideFinal = () => {
        if (done) return; done = true;
        // A prompt-cache hit answered BEFORE the paywall (req.gatewayCacheHit)
        // cost nothing upstream and is served free to x402 buyers - credits
        // buyers get the same. The header alone is not that signal: a route
        // result cache inside a handler also sets X-Cache: hit, after the
        // paywall, and that answer is charged on every rail.
        // An idempotent REPLAY (X-Idempotent-Replay: true, server.js) served the
        // stored body of a call this key already paid for: no handler ran, no
        // upstream spend, so it is released like a cache hit. Before this the
        // replay middleware, mounted AFTER this gate, answered 200 into a live
        // hold and a credits buyer's keyed retry was debited a second time - on
        // a metered route at the FULL worst-case hold, since no X-Metered-Usd
        // header exists on a replay (found in the 2026-08-26 security review).
        const cacheHit = servedWithoutRun(req, res);
        // A metered route reports actual usage x markup on X-Metered-Usd, or,
        // for a stream whose usage frame came after the headers, on the
        // request (gateway-meter.js); the debit is that, never more than the hold.
        const metered = meteredUsdOf(req, res);
        if (res.statusCode === 200 && !cacheHit) settleHold(Number.isFinite(metered) && metered > 0 ? metered : null);
        else releaseHold();
      };
      res.on("finish", decideFinal);
      // A client that drops the socket before the response finished (`finish`
      // never fires on a destroyed socket). After the first byte (a stream
      // that began) the response was partly delivered, and the hold is decided
      // when the response ENDS by the finish rule above: a >= 400, an
      // idempotent replay or a cache hit is not charged, and a metered call
      // takes its metered amount (the stream writer records it on the request
      // as it ends), never the whole hold. A close after the end decides at
      // once; a response nobody ends within CREDITS_ABANDONED_HOLD_MS is
      // decided then, on what it had sent.
      //
      // Before the FIRST byte the close alone decides nothing: the handler may
      // still be running, and what happens to the hold is the same rule every
      // other rail follows (src/hangup-settlement.js), read when the abandoned
      // response ENDS - its final status is known then:
      //   - a >= 400 (the dispatcher refusing to start a handler for a client
      //     already gone, or a handler that failed) is never charged;
      //   - a run holding a granted forgiveness ticket is not charged;
      //   - otherwise (the forgiveness budget is spent, or the route reserved
      //     no ticket) the hold settles, exactly as before this rule, and
      //     creditsChargedOnClose tells the hang-up hook to book it as owed.
      //     That keeps an abort from being a free expensive run on this rail
      //     (the 2026-08-28 finding: /v1/research ran, nothing was debited).
      // The dispatcher always ends a response; a hold nobody ends within
      // CREDITS_ABANDONED_HOLD_MS is released (nothing was delivered).
      let goneEarly = false;
      const decideGone = () => {
        if (done) return; done = true;
        const cacheHit = servedWithoutRun(req, res);
        if (res.statusCode >= 400 || cacheHit || chargeCancelledForClientGone(req)) { releaseHold(); return; }
        // The debit leaves from here (a buyer already gone records nothing).
        markSettleSent(req);
        if (usePg) {
          // The hang-up hook reads the owed amount as the response ends, before
          // the row is written: the hold is what this debit takes.
          req.creditsCharged = microToUsd(a.heldMicro); req.creditsChargedOnClose = microToUsd(a.heldMicro);
          settleHold();
          return;
        }
        const c = settle(a.hash, a.heldMicro, slug, null, a.holdId ?? null, via, debitId);
        if (c) { req.creditsCharged = c.chargedUsd; req.creditsChargedOnClose = c.chargedUsd; }
      };
      const priorEnd = res.end;
      let goneAfterHeaders = false;
      // The settle-before-end debit's wait, and a close that landed in it.
      let debitInFlight = false, goneDuringDebit = false;
      res.end = function creditsAwareEnd(...args) {
        // Debit first, then end: a settled 200 whose answer is still being
        // written, while signed receipts are served.
        if (!goneEarly && !goneAfterHeaders && !done && res.statusCode === 200 && !servedWithoutRun(req, res) && settleBeforeEnd?.() === true) {
          done = true;
          const metered = meteredUsdOf(req, res);
          const chargeUsd = Number.isFinite(metered) && metered > 0 ? metered : null;
          const landed = (c) => { if (c) { req.creditsCharged = c.chargedUsd; req.creditsDebitId = debitId; } };
          if (!usePg) {
            try { landed(settle(a.hash, a.heldMicro, slug, chargeUsd, a.holdId ?? null, via, debitId)); } catch (e) { log(`[credits] debit of key ${a.keyId} failed: ${String(e?.message || e).slice(0, 120)}`); }
            return priorEnd.apply(this, args);
          }
          const self = this;
          // A buyer already gone with a granted forgiveness ticket is not
          // debited: the hold is released and nothing is sent. Otherwise the
          // debit leaves from here while the buyer is connected.
          if (chargeCancelledForClientGone(req)) {
            releaseHold();
            return priorEnd.apply(this, args);
          }
          markSettleSent(req);
          // A close during the wait below lands after the debit left: the
          // hang-up hook books it as owed (creditsChargedOnClose), as on every
          // rail whose settle call was in flight when the buyer left.
          debitInFlight = true;
          let timer = null;
          const waitMs = Math.max(100, envPositive("CREDITS_DEBIT_WAIT_MS", 3000));
          markSettling(a.hash, a.holdId, chargeUsd, slug, via).catch(() => { /* the settle below retries */ });
          const first = settle(a.hash, a.heldMicro, slug, chargeUsd, a.holdId, via, debitId);
          Promise.race([first.then((c) => ({ c })), new Promise((r) => { timer = setTimeout(() => r({ late: true }), waitMs); timer.unref?.(); })])
            .then((out) => {
              if (out.late) {
                // Still in flight: a retry of the same hold takes what the
                // first landed and never moves the balance twice.
                later(`debit of key ${a.keyId}`, () => settle(a.hash, a.heldMicro, slug, chargeUsd, a.holdId, via, debitId), (c) => { if (c) req.creditsCharged = c.chargedUsd; }, a.holdId, { persist: true });
                return;
              }
              landed(out.c);
              liveHolds.delete(a.holdId); stopHoldFresh(a.holdId);
            }, () => {
              later(`debit of key ${a.keyId}`, () => settle(a.hash, a.heldMicro, slug, chargeUsd, a.holdId, via, debitId), (c) => { if (c) req.creditsCharged = c.chargedUsd; }, a.holdId, { persist: true });
            })
            .finally(() => {
              clearTimeout(timer);
              debitInFlight = false;
              // The buyer left during the debit: the answer is not delivered
              // and the debit stands, so the hang-up hook books what it took.
              if (goneDuringDebit || clientGoneBeforeFirstByte(req)) {
                req.creditsChargedOnClose = Number(req.creditsCharged) > 0 ? req.creditsCharged : (chargeUsd ?? microToUsd(a.heldMicro));
              }
              try { priorEnd.apply(self, args); } catch (e) { log(`[credits] answer end failed: ${String(e?.message || e).slice(0, 120)}`); }
            });
          return this;
        }
        if (goneEarly) decideGone();
        else if (usePg && a.holdId && !done && res.statusCode === 200 && !servedWithoutRun(req, res)) {
          const metered = meteredUsdOf(req, res);
          markSettling(a.hash, a.holdId, Number.isFinite(metered) && metered > 0 ? metered : null, slug, via).catch(() => { /* the settle that follows retries */ });
        }
        if (!goneAfterHeaders) return priorEnd.apply(this, args);
        try { return priorEnd.apply(this, args); } finally { decideFinal(); }
      };
      res.on("close", () => {
        if (debitInFlight && !res.headersSent) { goneDuringDebit = true; return; }
        if (done) return;
        if (res.headersSent) {
          if (res.writableEnded) { decideFinal(); return; }
          goneAfterHeaders = true;
          const t = setTimeout(decideFinal, abandonedHoldMs());
          t.unref?.();
          return;
        }
        goneEarly = true;
        const t = setTimeout(() => { if (!done) { done = true; releaseHold(); } }, abandonedHoldMs());
        t.unref?.();
      });
      return next();
    };
    const hold = (b) => (b.grant ? authorizeGrant(b.grant.keyId, b.item.priceUsd, { id: b.grant.id, capUsd: b.grant.capUsd }) : authorize(b.key, b.item.priceUsd));
    if (!usePg) {
      return (req, res, next) => {
        const b = begin(req, res);
        if (!b) return next();
        if (b.done) return;
        if (!b.grant) return arm(req, res, next, authorize(b.key, b.item.priceUsd), b.item);
        return hold(b).then((a) => arm(req, res, next, a, b.item), () => {
          res.setHeader("X-Credits-Error", "unavailable");
          res.status(503).json({ error: "Prepaid credits are unavailable right now; nothing was charged. Retry shortly.", reason: "unavailable" });
        });
      };
    }
    return async (req, res, next) => {
      const b = begin(req, res);
      if (!b) return next();
      if (b.done) return;
      let a;
      try { a = await hold(b); }
      catch (e) {
        // No hold could be placed: nothing is charged and nothing is served.
        log(`[credits] hold failed: ${String(e?.message || e).slice(0, 120)}`);
        res.setHeader("X-Credits-Error", "unavailable");
        return res.status(503).json({ error: "Prepaid credits are unavailable right now; nothing was charged. Retry shortly.", reason: "unavailable" });
      }
      return arm(req, res, next, a, b.item, failedLookup(a) && !b.grant ? await badKeyHeld(req.ip) : false);
    };
  }

  /** A presented key -> its id (null for an unknown key): presenting the key is the proof. */
  function keyIdOf(keyString) {
    if (typeof keyString !== "string" || !KEY_RE.test(keyString)) return answer(null);
    const rec = readRec(hashKey(keyString));
    return usePg ? rec.then((r) => (r ? r.keyId : null)) : rec ? rec.keyId : null;
  }
  /** USD balance for a key id (the caller never needs the key itself). */
  /** keyId -> billing address, for the keys asked (one read of the store). */
  async function billingByKeyId(keyIds) {
    const want = new Set(keyIds || []);
    const out = new Map();
    for (const { rec } of await allKeys()) if (rec && want.has(rec.keyId)) out.set(rec.keyId, rec.billing || null);
    return out;
  }
  // ---- the balance page (signed in by email, src/credits-account.js) --------
  // Every balance bought with this email: what the page lists. Never the key
  // or its hash; the key id is the handle the page acts on.
  const capRoomUsd = (rec) => Math.max(0, creditsBalanceMaxCents() - Math.ceil(((Number(rec.balanceMicro) || 0) + (Number(rec.heldMicro) || 0)) / 10_000)) / 100;
  async function balancesForEmail(email) {
    const e = emailKeyOf(email);
    if (!e) return [];
    return (await keysByEmail(e))
      .map(({ rec }) => ({ ...balanceOf(rec), roomUsd: rec.disabled || rec.refundRequest ? 0 : capRoomUsd(rec), lowNotice: !rec.lowNoticeOff, disabledReason: rec.disabled ? rec.disabledReason || "operator" : null }))
      .sort((a, b) => String(b.lastUsedAt || b.createdAt).localeCompare(String(a.lastUsedAt || a.createdAt)));
  }
  // ---- the holder's controls and the freezes ------------------------------------
  // Disable a key for `reason` unless a stronger cause already holds it.
  const disableFor = (r, reason) => {
    if (r.disabled === true && !CAUSE_RANK[r.disabledReason]) r.disabledReason = "operator";
    const held = r.disabled === true ? CAUSE_RANK[r.disabledReason] || 0 : 0;
    r.disabled = true;
    if ((CAUSE_RANK[reason] || 0) >= held) r.disabledReason = reason;
  };
  /**
   * An early fraud warning on a payment that loaded a key. The key is frozen
   * at once (no further spend; a call running on it takes nothing) and the
   * warning is recorded on it. Then its unspent balance goes back:
   *  - automatically (CREDITS_EFW_AUTO_REFUND, on unless set off) when the
   *    whole unspent balance is refundable on the warned payment itself (a
   *    refund only ever goes to that payment's own charge) and the day's total
   *    of these card refunds made without review stays inside the private table's day total;
   *  - otherwise it is listed as owed for a person to approve
   *    (refundRequestsOwed, the operator credits view and the refundsOwed
   *    word; approveFraudRefund sends it).
   * Answers { status }; "in_flight" or a throw means try again (the webhook
   * is delivered again). Idempotent: a payment already handled moves nothing.
   */
  const efwAutoRefund = () => !/^(0|false|off|no)$/i.test(String(process.env.CREDITS_EFW_AUTO_REFUND || "").trim());
  // The day's automatic total, from the private table; none without it (every such refund waits for approval).
  const efwDayMaxCents = () => { const n = Number(creditsGuards()?.efw?.warningRefundDayMaxUsd); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0; };
  const setReview = (hash, patch) => mutate(hash, (rec) => (rec?.fraudReview ? { rec: (rec.fraudReview = { ...rec.fraudReview, ...patch }, rec), result: true } : { result: null }));
  async function fraudWarning(paymentIntent, { warningId = null } = {}) {
    if (!paymentIntent) return { status: "unknown" };
    let hit = (await allKeys()).find((x) => paidBy(x.rec, paymentIntent));
    if (!hit) {
      // No key yet: remember the payment (a later claim on it issues nothing),
      // then look again for a key minted meanwhile (the claim checks after it mints).
      await rememberWarned(paymentIntent, warningId);
      hit = (await allKeys()).find((x) => paidBy(x.rec, paymentIntent));
      if (!hit) { log(`[credits] fraud warning on ${paymentIntent} before any key; a claim on it is refused and refunded`); return { status: "unknown", remembered: true }; }
    }
    const first = await mutate(hit.hash, (r) => {
      if (!paidBy(r, paymentIntent)) return { result: null };
      const seen = Array.isArray(r.fraudWarnings) ? r.fraudWarnings : [];
      if (!seen.some((w) => w.pi === paymentIntent)) r.fraudWarnings = [...seen, { pi: paymentIntent, at: new Date(now()).toISOString(), ...(warningId ? { id: String(warningId).slice(0, 64) } : {}) }].slice(-10);
      // A key already frozen by a dispute keeps that cause: the dispute's
      // outcome decides it, and a dispute won later moves the freeze to the
      // warning (enableByPaymentIntent) instead of lifting it.
      if (r.disabled === true && r.disabledReason === "disputed") r.disabled = true;
      else disableFor(r, "fraud-warning");
      if (!r.refundRequest && !r.fraudReview) r.fraudReview = { pi: paymentIntent, at: now(), state: "owed" };
      log(`[credits] key ${r.keyId} frozen (fraud-warning, ${paymentIntent})`);
      return { rec: r, result: { keyId: r.keyId, review: r.fraudReview ? { ...r.fraudReview } : null } };
    });
    if (!first) return { status: "unknown" };
    const review = first.review;
    if (!review || review.state !== "owed" || review.pi !== paymentIntent) return { status: "frozen", keyId: first.keyId };
    if (!efwAutoRefund()) return { status: "frozen", keyId: first.keyId, owed: true };
    const rec = await readRec(hit.hash);
    if (!rec) return { status: "unknown" };
    if ((Number(rec.heldMicro) || 0) > 0) return { status: "in_flight", keyId: rec.keyId };
    const plan = refundPlan(rec);
    if (plan.cents === 0) { await setReview(hit.hash, { state: "nothing", decidedAt: now() }); return { status: "nothing_to_refund", keyId: rec.keyId }; }
    // Without review, only the warned payment's own card charge is ever refunded.
    if (plan.parts.some((p) => p.pi !== paymentIntent)) { log(`[credits] key ${rec.keyId}: fraud-warning refund spans other payments; owed for approval`); return { status: "frozen", keyId: rec.keyId, owed: true }; }
    // The day's automatic total, shared across servers.
    const day = `d${new Date(now()).toISOString().slice(0, 10)}`;
    const add = await shared.counterAdd("credits-efw-auto", day, plan.cents, 2 * DAY_MS, { now: now() });
    if (!add?.ok || Number(add.value) > efwDayMaxCents()) {
      if (add?.ok) await shared.counterAdd("credits-efw-auto", day, -plan.cents, 2 * DAY_MS, { now: now() });
      log(`[credits] key ${rec.keyId}: fraud-warning refund over the automatic day total; owed for approval`);
      return { status: "frozen", keyId: rec.keyId, owed: true };
    }
    let r;
    try { r = await requestRefundOf(hit.hash); }
    catch (e) { await shared.counterAdd("credits-efw-auto", day, -plan.cents, 2 * DAY_MS, { now: now() }); throw e; }
    if (r.status === "in_flight") { await shared.counterAdd("credits-efw-auto", day, -plan.cents, 2 * DAY_MS, { now: now() }); return r; }
    // Only a refund that was sent (refunded, or pending at the card network)
    // counts against the day and closes the review. Any other answer sent
    // nothing: the day total goes back and the review stays open (or waits on
    // the dispute, which decides what goes back).
    if (r.status !== "refunded" && r.status !== "pending") {
      await shared.counterAdd("credits-efw-auto", day, -plan.cents, 2 * DAY_MS, { now: now() });
      if (r.status === "disputed") await setReview(hit.hash, { state: "disputed" });
      else if (r.status === "nothing_to_refund") await setReview(hit.hash, { state: "nothing", decidedAt: now() });
      log(`[credits] key ${rec.keyId}: fraud-warning refund not sent (${r.status}); ${r.status === "disputed" ? "the dispute decides it" : "owed for approval"}`);
      return { status: r.status, keyId: rec.keyId, ...(r.status === "nothing_to_refund" ? {} : { owed: true }) };
    }
    await setReview(hit.hash, { state: "sent-on-warning", cents: plan.cents, decidedAt: now() });
    log(`[credits] key ${rec.keyId}: fraud-warning refund of $${(plan.cents / 100).toFixed(2)} sent to ${paymentIntent} (${r.status})`);
    return { ...r, auto: true };
  }
  /** Operator: approve the refund a fraud review holds, by key id (the same
   *  refund on request every other path uses). */
  async function approveFraudRefund(keyId) {
    const hit = (await keysByKeyId(String(keyId || ""))).find((x) => x.rec?.fraudReview?.state === "owed");
    if (!hit) return { status: "unknown" };
    const r = await requestRefundOf(hit.hash);
    // Only a refund actually sent closes the review; an open dispute holds it
    // (the dispute's close makes it owed again), and anything else leaves it owed.
    if (r.status === "refunded" || r.status === "pending") await setReview(hit.hash, { state: "approved", decidedAt: now() });
    else if (r.status === "disputed") await setReview(hit.hash, { state: "disputed" });
    else if (r.status === "nothing_to_refund") await setReview(hit.hash, { state: "nothing", decidedAt: now() });
    return r;
  }
  /** Operator view: every key a fraud warning froze, and what became of its balance. */
  async function fraudReviews() {
    return (await allKeysLite()).filter(({ rec }) => rec?.fraudReview).map(({ rec }) => ({ keyId: rec.keyId, state: rec.fraudReview.state, cents: rec.fraudReview.cents ?? null, at: new Date(Number(rec.fraudReview.at) || 0).toISOString(), balanceUsd: microToUsd(rec.balanceMicro) }));
  }
  /** Disable a key presented in full, without spending it. The same answer for
   *  any key, live or not: nothing says whether the key existed. */
  const REVOKED = { status: "received", message: "If this is a live credits key, it is now disabled and cannot be spent. Its unspent balance stays refundable to the card that bought it, from the balance page." };
  async function revokeByKey(keyString) {
    if (typeof keyString === "string" && KEY_RE.test(keyString)) {
      await mutate(hashKey(keyString), (r) => {
        if (!r) return { result: null };
        if (r.disabled && CAUSE_RANK[r.disabledReason] >= CAUSE_RANK.revoked) return { result: null };
        disableFor(r, "revoked");
        note(r, { k: "revoked" });
        log(`[credits] key ${r.keyId} revoked by key`);
        return { rec: r, result: true };
      });
    }
    return { ...REVOKED };
  }
  /** The holder revokes a balance's key from the balance page. */
  async function revokeFor(keyId, email) {
    const hit = await ownedRec(keyId, email);
    if (!hit) return { status: "unknown" };
    await mutate(hit.hash, (r) => {
      if (!r || recEmailKey(r) !== emailKeyOf(email)) return { result: null };
      if (r.disabled && CAUSE_RANK[r.disabledReason] >= CAUSE_RANK.revoked) return { result: null };
      disableFor(r, "revoked"); note(r, { k: "revoked" });
      return { rec: r, result: true };
    });
    return { status: "revoked", keyId };
  }
  /** The holder's limits on one balance: a most per UTC day and a most per
   *  call, in USD (0 or null clears one). Answers the limits as set. */
  async function setLimits(keyId, email, { dailyUsd = null, perCallUsd = null } = {}) {
    const hit = await ownedRec(keyId, email);
    if (!hit) return { status: "unknown" };
    const toMicro = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(usdToMicro(n), creditsBalanceMaxCents() * 10_000) : 0; };
    const limits = { dailyMicro: toMicro(dailyUsd), perCallMicro: toMicro(perCallUsd) };
    await mutate(hit.hash, (r) => {
      if (!r || recEmailKey(r) !== emailKeyOf(email)) return { result: null };
      r.limits = limits;
      return { rec: r, result: true };
    });
    return { status: "set", keyId, limits: { dailyUsd: microToUsd(limits.dailyMicro) || null, perCallUsd: microToUsd(limits.perCallMicro) || null } };
  }

  async function ownedRec(keyId, email) {
    const e = emailKeyOf(email);
    const hit = e ? (await keysByKeyId(keyId)).find((x) => recEmailKey(x.rec) === e) : null;
    return hit || null;
  }
  /** One balance's history (newest first), its totals by tool and what is held now; null when the email does not hold it. */
  async function historyFor(keyId, email) {
    const hit = await ownedRec(keyId, email);
    if (!hit) return null;
    const rec = hit.rec;
    const rows = (Array.isArray(rec.history) ? rec.history : []).slice().reverse().map((h) => ({ at: new Date(Number(h.t) || 0).toISOString(), type: String(h.k || ""), tool: h.slug ?? null, amountUsd: microToUsd(Number(h.m) || 0) }));
    const holds = Object.values(rec.holds || {}).map((h) => ({ at: new Date(Number(h.at) || 0).toISOString(), type: "hold", tool: h?.s?.slug ?? null, amountUsd: microToUsd(Number(h.m) || 0) }));
    // A hold the record keeps no entry for (the file backend) still shows as one line.
    const untracked = (Number(rec.heldMicro) || 0) - Object.values(rec.holds || {}).reduce((a, h) => a + (Number(h?.m) || 0), 0);
    if (untracked > 0) holds.push({ at: rec.lastUsedAt || rec.createdAt, type: "hold", tool: null, amountUsd: microToUsd(untracked) });
    const byTool = Object.entries(rec.byTool || {}).map(([tool, v]) => ({ tool, calls: Number(v?.n) || 0, spentUsd: microToUsd(Number(v?.m) || 0) })).sort((a, b) => b.spentUsd - a.spentUsd || a.tool.localeCompare(b.tool));
    const rr = rec.refundRequest;
    return { keyId: rec.keyId, balance: balanceOf(rec), holds, rows, byTool, historyFrom: rows.length >= HISTORY_MAX ? rows[rows.length - 1].at : null, ...(rr ? { refund: { state: rr.state === "done" ? "refunded" : "pending", amountUsd: (Number(rr.cents) || 0) / 100, requestedAt: new Date(Number(rr.at) || 0).toISOString() } } : {}) };
  }
  /** The refund on request for a balance the signed-in email holds (the same path as presenting the key). */
  async function requestRefundFor(keyId, email) {
    const hit = await ownedRec(keyId, email);
    return hit ? requestRefundOf(hit.hash) : { status: "unknown" };
  }
  /** Turn the low-balance notice off (or on) for a balance; by key id. */
  async function setLowNotice(keyId, on) {
    const hash = await keyHashById(String(keyId || ""));
    if (!hash) return false;
    return !!(await mutate(hash, (rec) => {
      if (!rec || rec.keyId !== keyId) return { result: false };
      if (on) delete rec.lowNoticeOff; else rec.lowNoticeOff = new Date(now()).toISOString();
      return { rec, result: true };
    }));
  }
  // LOST KEY. A new key for a balance the signed-in email holds: the record
  // moves to the new key's hash in one step under its lock (the key id, the
  // balance and the history stay), so the old key stops working at once. A
  // balance with a call in flight answers in_flight and moves nothing. The new
  // key is answered once and never stored.
  async function issueNewKey(keyId, email) {
    const hit = await ownedRec(keyId, email);
    if (!hit) return { status: "unknown" };
    const key = newKeyString();
    const next = hashKey(key);
    const move = (rec) => {
      if (!rec || rec.keyId !== keyId || !sameEmail(recEmailKey(rec), email)) return { status: "unknown" };
      if ((Number(rec.heldMicro) || 0) > 0) return { status: "in_flight" };
      const out = { ...rec, rotatedAt: new Date(now()).toISOString() };
      delete out.holds; delete out.settledHolds;
      note(out, { k: "key" });
      return { status: "ok", rec: out };
    };
    let r;
    if (usePg) {
      await readyP();
      r = await withStateTx(async (c) => {
        const cur = await c.query(`SELECT body FROM ${RT()} WHERE collection = $1 AND id = $2 FOR UPDATE`, [COLL, recId(hit.hash)]);
        const m = move(cur.rows[0]?.body ?? null);
        if (m.status !== "ok") return m;
        await c.query(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb)`, [COLL, recId(next), JSON.stringify(m.rec)]);
        await c.query(`DELETE FROM ${RT()} WHERE collection = $1 AND id = $2`, [COLL, recId(hit.hash)]);
        // The claim index follows the record, so a purchase's thanks page still finds it.
        for (const sid of Array.isArray(m.rec.sessions) ? m.rec.sessions : []) {
          await c.query(`UPDATE ${RT()} SET body = body || jsonb_build_object($2::text, $3::text), updated_at = now() WHERE collection = $1 AND id = '_sessions' AND body->>$2::text = $4`, [COLL, String(sid), next, hit.hash]);
        }
        return m;
      });
      if (r.status === "ok") { through(recPath(next), r.rec); try { if (existsSync(recPath(hit.hash))) unlinkSync(recPath(hit.hash)); } catch { /* the row is the record */ } }
    } else {
      r = move(load(hit.hash));
      if (r.status === "ok") {
        save(next, r.rec); cache.delete(hit.hash); idxForget(hit.hash); try { unlinkSync(recPath(hit.hash)); } catch { /* gone already */ }
        const idx = sessionsIdx();
        let moved = false;
        for (const sid of Array.isArray(r.rec.sessions) ? r.rec.sessions : []) if (idx[sid] === hit.hash) { idx[sid] = next; moved = true; }
        if (moved) writeJsonAtomic(SESSIONS, idx);
      }
    }
    if (r.status !== "ok") return { status: r.status };
    log(`[credits] key ${keyId}: a new key was issued from the balance page; the old key no longer works`);
    try { onNewKey?.({ keyId, email: r.rec.email }); } catch { /* a notice never breaks the move */ }
    return { status: "issued", key, keyId, balanceUsd: microToUsd(r.rec.balanceMicro) };
  }
  function balanceById(keyId) {
    const pick = (xs) => { const hit = xs.find((x) => x.rec && x.rec.keyId === keyId); return hit ? microToUsd(hit.rec.balanceMicro) : null; };
    return usePg ? allKeys().then(pick) : pick(allKeys());
  }
  return { authorizeGrant, grantSpentToday, sessionOwner, refundsOwedWord, createCheckout, createTopupCheckout, claim, authorize, settle, release, charge, balance, status, setDisabled, disableByPaymentIntent, enableByPaymentIntent, gate, keyIdOf, balanceById, billingByKeyId, refusalsToRefund, markRefusalRefunded, requestRefund, refundRequestsOwed, settleRefund, noteBadKey, balancesForEmail, historyFor, requestRefundFor, issueNewKey, setLowNotice, fraudWarning, approveFraudRefund, fraudReviews, disputeClosed, disputeLostByPaymentIntent, revokeByKey, revokeFor, setLimits, notePaymentFailed, sourceTag, badKeyHeld, failedLookup, _internals: { boughtInDayCents, refuseAndRefund, refuseSession, purchasesIn }, badKeyStats: () => ({ ...badKeyStats, clientsTracked: badKeys.size }), _dir: dir, ready: () => readyP(), sweepAbandonedHolds, backend: usePg ? "pg" : "file" };
}
