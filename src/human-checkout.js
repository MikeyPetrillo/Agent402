// human-checkout - the HUMAN front door for the premium products. Standard
// Stripe Checkout (card + Link), NOT the agent SPT/MPP flow: it sells the SAME
// endpoints agents already buy over x402, so one backend serves two payment
// surfaces - a human's card and an agent's wallet - from one product.
//
// Design for v1:
// - Single purchase per report (no account, no subscription); credit packs are
//   a possible later addition.
// - Payment is verified with Stripe BEFORE any report is generated - a buyer
//   can never get a free report by guessing a session id.
// - Generation is idempotent per checkout session and generate-once (a reload or
//   a double-poll does not re-spend upstream; the claim is persisted so a
//   second process does not regenerate either).
// - A failed report AUTO-REFUNDS the card (the restricted key carries Refunds
//   write) - the "if it's bad, we refund" promise, enforced in code. A refund
//   that itself fails is persisted as OWED (retried on later polls, listed for
//   the operator) - never silently reported as refunded.
// - A claim ABANDONED by a restart (deploy / OOM mid-generation) is taken over:
//   a "generating" claim older than STALE_CLAIM_MS with no local job is
//   regenerated - bounded to one takeover; a second abandonment refunds.
//   Without this a buyer whose report was in flight at deploy time paid and
//   polled "Generating..." forever (review finding, 2026-08-22).
//   On the database the window runs from the claim's last HEARTBEAT, not from
//   the claim: the owning container refreshes `beatAt` every HEARTBEAT_MS
//   while its job runs and while it holds a final record that has not landed
//   (marking that claim `generatedAt` once a report exists), so another
//   container never takes over a claim whose owner is alive and reaching the
//   database, and a claim marked generated is regenerated after an abandonment
//   but never refunded on the strength of it.
// Storage: ONE FILE PER SESSION under a directory (atomic tmp+rename), so a poll
// never parses the whole store, a crash never corrupts every report, and two
// processes never overwrite each other's records. Tiny side indexes track
// in-flight claims and owed refunds so the boot sweep / operator view read a
// few bytes, not every report. A legacy single-file store is imported once.
// Rollout switch = STRIPE_SECRET_KEY (same key as the MPP gate). The key needs
// Checkout Sessions + Refunds write; it settles to your Stripe balance only.
//
// STATE DATABASE. With STATE_DATABASE_URL set (src/state-db.js) every record
// is a row of the `records` table (collection "human-checkout", id = the
// session id, or the index's underscore name: _inflight, _issues, _public,
// _failures), and the methods that read or write them RETURN PROMISES:
// fulfill and recoverAbandoned always did; listIssues, setPublic and peek do
// so only on the database (synchronous on the files, as before). The claim
// is one conditional statement (a session is claimed only when no record
// exists, or the stale "generating" claim the caller saw is still the one on
// the row), so two containers never generate the same paid session twice.
// The public readers stay synchronous: on the database they serve an
// in-memory mirror of the public index and its reports, filled at the first
// load, updated by this process's toggles and refreshed in the background.
// Reads come from the rows (no memory cache); the first boot with the
// database on imports the directory once. While the directory exists, every
// row write is also written to its file (best effort, never the verdict), so
// a rollback to the previous build reads current claims and reports.
import Stripe from "stripe";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { sendReportReadyEmail } from "./email.js";
import { stateDbEnabled, stateDbSchema, stateQuery, importOnce, imports, trackStoreReady } from "./state-db.js";
import { retryingLoad } from "./store-retry.js";
import { createDeadLetter, everyMs } from "./ledger-mirror.js";

// The products the human door sells by card. The CARD price is not the agent
// price: the card processor takes a percentage plus a fixed fee per charge, and
// the card price must clear that fee AND the report's MEASURED worst-case
// upstream. Agents paying over x402 or MPP have no fixed fee and pay the tier
// price in the kit.
// cheap agent tools stay crypto/agent-only. `slug` maps to the paid endpoint's
// handler so humans and agents run the identical pipeline.
// The CARD ladder is DERIVED from the agent tier, never typed per product.
//
// Hand-setting it produced a storefront where Standard and Pro were both $2:
// three distinct agent tiers ($0.60 / $0.85 / $1.10) collapsed onto two card
// prices, so the page offered an upgrade that cost the same as not upgrading.
// Deriving it means the card ladder mirrors the work ladder by construction.
//
// The floor is set by the card processor's fixed fee. Every rung below clears
// its measured worst-case upstream (scripts/test-report-margins.js).
// Read lazily through a tiny shim rather than importing the tier registry at
// module scope: that registry imports every report kit, and this module is
// imported by pages the kits do not know about.
import { priceUsdFor as agentPriceUsdFor } from "./report-tiers.js";
import { randomBytes } from "node:crypto";

// ---- Public reports -------------------------------------------------------
// A buyer may make a delivered report public: it gets a second, unguessable
// id (rp_...) and is served indexable at /reports/public/<id> with its own
// title and preview tags - the paid artifact becomes a page that can be
// shared and linked, which /r/<session> deliberately never is. The session
// id stays the only credential for the toggle (whoever holds it bought the
// report); the public id reveals nothing about the session and is revocable.
// These readers are module-level so the public routes serve with or without
// a Stripe-configured engine (the records are files under the store dir).
const PUBLIC_ID_RE = /^rp_[A-Za-z0-9_-]{12,24}$/;
const PUBLIC_INDEX = (dir) => join(dir, "_public.json");
// The page title of a report, for EVERY kind: the report's own H1 when the
// markdown carries one (every kit writes one: "Domain Security Audit: x",
// "NVIDIA CORP (NVDA): Company Due-Diligence Dossier", a research question),
// else the product label and the subject. A record's stored `title` is often
// just the buyer's input ("havok.holdings"), which is not a page title.
export function reportHeadline(r, label) {
  const m = /^#\s+(.+?)\s*$/m.exec(String(r?.report || "").slice(0, 4000));
  let h1 = m ? m[1].replace(/[*_`]/g, "").replace(/\s*[\u2014\u2013]\s*/g, ": ").replace(/\s+/g, " ").trim() : "";
  // House style: no em or en dashes in anything a person reads; an all-caps
  // heading (the fund report writes one) is title-cased, tickers and codes
  // (parenthesised, or carrying a digit) kept as written.
  if (h1 && !/[a-z]/.test(h1)) h1 = h1.replace(/[A-Z][A-Z']*/g, (w, i, str) => (/\d/.test(w) || str[i - 1] === "(" ? w : w[0] + w.slice(1).toLowerCase()));
  if (h1) return h1;
  const lab = String(label || HUMAN_PRODUCTS[r?.product]?.label || "Report");
  const t = String(r?.title || r?.input || "").trim();
  return t ? `${lab}: ${t}` : lab;
}
// The view of a delivered, public report, or null for anything else.
function publicView(rec, publicId) {
  if (!rec || rec.status !== "done" || rec.public !== true || rec.publicId !== publicId) return null;
  const productKey = Object.keys(HUMAN_PRODUCTS).find((k) => HUMAN_PRODUCTS[k].slug === rec.slug) || null;
  // Everything on a done record is the report itself; nothing buyer-identifying is stored on it.
  return { status: "done", publicView: true, publicId, product: productKey, kind: rec.kind, slug: rec.slug, input: rec.input, title: rec.title, report: rec.report, sources: rec.sources || [], tables: rec.tables || [], ...(rec.images ? { images: rec.images } : {}), at: rec.at, publishedAt: rec.publishedAt || null, priceUsd: productKey ? HUMAN_PRODUCTS[productKey].price / 100 : null };
}
/** readPublicReport, for a link published moments ago on another container:
 *  on a miss the mirror is refreshed once (at most once a second across all
 *  callers, bounded at 2 s) and read again, so the buyer's first open of a
 *  link they just published is not a 404. */
export async function readPublicReportFresh(publicId, dir = DEFAULT_DIR()) {
  const hit = readPublicReport(publicId, dir);
  if (hit || !USE_PG || typeof publicId !== "string" || !PUBLIC_ID_RE.test(publicId)) return hit;
  if (Date.now() - pub.lastAt > 1000 || pub.refreshing) {
    await Promise.race([refreshPublicMirror(), new Promise((r) => setTimeout(r, 2000).unref?.())]);
  }
  return readPublicReport(publicId, dir);
}
export function readPublicReport(publicId, dir = DEFAULT_DIR()) {
  if (typeof publicId !== "string" || !PUBLIC_ID_RE.test(publicId)) return null;
  if (USE_PG) {
    const sessionId = Object.hasOwn(pub.idx, publicId) ? pub.idx[publicId] : null;
    const rec = sessionId ? pub.recs.get(sessionId) : null;
    if (!rec) nudgePublicMirror(); // published by another container, perhaps: the next read sees it
    return publicView(rec, publicId);
  }
  const idx = readJson(PUBLIC_INDEX(dir)) || {};
  const sessionId = Object.hasOwn(idx, publicId) ? idx[publicId] : null;
  if (!sessionId || !SESSION_RE.test(String(sessionId))) return null;
  return publicView(readJson(join(dir, `${sessionId}.json`)), publicId);
}
export function listPublicReports(dir = DEFAULT_DIR()) {
  const idx = USE_PG ? pub.idx : readJson(PUBLIC_INDEX(dir)) || {};
  const out = [];
  for (const [publicId, sessionId] of Object.entries(idx)) {
    if (!PUBLIC_ID_RE.test(publicId) || !SESSION_RE.test(String(sessionId))) continue;
    const rec = USE_PG ? pub.recs.get(sessionId) : readJson(join(dir, `${sessionId}.json`));
    if (rec && rec.status === "done" && rec.public === true && rec.publicId === publicId) out.push({ publicId, title: rec.title, kind: rec.kind, at: rec.publishedAt || rec.at });
  }
  return out;
}

const CARD_LADDER = [
  { maxAgentUsd: 0.60, cents: 200 },
  { maxAgentUsd: 0.85, cents: 300 },
  { maxAgentUsd: 1.10, cents: 400 },
  { maxAgentUsd: Infinity, cents: 500 },
];
export function cardCentsForAgentPrice(agentUsd) {
  const n = Number(agentUsd);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (CARD_LADDER.find((r) => n <= r.maxAgentUsd + 1e-9) ?? CARD_LADDER.at(-1)).cents;
}

export const HUMAN_PRODUCTS = {
  "research": { label: "Deep research report", price: 200, kind: "research", slug: "research", inputField: "query", inputLabel: "your research question" },
  "research-pro": { label: "Deep research report - Pro", price: 200, kind: "research", slug: "research-pro", inputField: "query", inputLabel: "your research question" },
  "research-max": { label: "Deep research report - Max", price: 300, kind: "research", slug: "research-max", inputField: "query", inputLabel: "your research question" },
  "dossier": { label: "Company due-diligence dossier", price: 200, kind: "dossier", slug: "dossier", inputField: "ticker", inputLabel: "a US stock ticker" },
  "dossier-max": { label: "Due-diligence dossier - Max", price: 300, kind: "dossier", slug: "dossier-max", inputField: "ticker", inputLabel: "a US stock ticker" },
  "fund-report": { label: "Fund portfolio report (13F)", price: 200, kind: "fund", slug: "fund-report", inputField: "manager", inputLabel: "a fund name, ticker, or CIK" },
  "fund-report-max": { label: "Fund portfolio report - Deep", price: 200, kind: "fund", slug: "fund-report-max", inputField: "manager", inputLabel: "a fund name, ticker, or CIK" },
  "domain-audit": { label: "Domain security audit", price: 200, kind: "domain", slug: "domain-audit", inputField: "domain", inputLabel: "a domain, e.g. example.com" },
  "domain-audit-pro": { label: "Domain security audit - Pro", price: 200, kind: "domain", slug: "domain-audit-pro", inputField: "domain", inputLabel: "a domain, e.g. example.com" },
  "filing-report": { label: "SEC filing report", price: 200, kind: "filing", slug: "filing-report", inputField: "ticker", inputLabel: "a US stock ticker" },
  "token-brief": { label: "Solana token due-diligence brief", price: 200, kind: "token", slug: "token-brief", inputField: "mint", inputLabel: "a Solana token mint address" },
  "recall-report": { label: "FDA recall report", price: 200, kind: "recall", slug: "recall-report", inputField: "query", inputLabel: "a drug, food, brand or device, e.g. losartan" },
  "insider-report": { label: "Insider flow report (Form 4)", price: 200, kind: "insider", slug: "insider-report", inputField: "ticker", inputLabel: "a US stock ticker" },
  "market-brief": { label: "Market / competitor brief", price: 200, kind: "research", slug: "market-brief", inputField: "query", inputLabel: "a market, category or company" },
  "ticker-pack": { label: "Ticker pack: dossier, insider flow and holders", price: 400, kind: "ticker", slug: "ticker-pack", inputField: "ticker", inputLabel: "a US stock ticker" },
  "linkedin-article": { label: "LinkedIn article, ready to publish", price: 400, kind: "linkedin", slug: "linkedin-article", inputField: "topic", inputLabel: "the topic of your article" },
};

// Applied at module load: each product's card price comes from its agent tier,
// so the two ladders cannot drift apart again. Products with no agent tier
// (none today) keep whatever the table declared.
for (const p of Object.values(HUMAN_PRODUCTS)) {
  const cents = cardCentsForAgentPrice(agentPriceUsdFor(p.slug));
  if (cents) p.price = cents;
}

// Stripe metadata: <= 50 keys, value <= 500 chars. Inputs are capped at 2000
// chars (createSession), so four 500-char chunks always suffice.
const CHUNK = 500;
export function chunkInput(input) {
  const s = String(input ?? "");
  const out = {};
  for (let i = 0, k = 1; i < s.length && k <= 4; i += CHUNK, k++) out[k === 1 ? "input" : `input${k}`] = s.slice(i, i + CHUNK);
  return out;
}
export function unchunkInput(meta) {
  return ["input", "input2", "input3", "input4"].map((k) => (typeof meta?.[k] === "string" ? meta[k] : "")).join("") || null;
}

export function humanCheckoutEnabled() {
  return Boolean((process.env.STRIPE_SECRET_KEY || "").trim());
}

export const STALE_CLAIM_MS = 10 * 60_000;   // a claim older than this with no local job is abandoned
const MAX_TAKEOVERS = 1;                      // one regeneration after an abandonment, then refund
// The owner of a claim refreshes it this often (database mode); far inside STALE_CLAIM_MS.
const HEARTBEAT_MS = Math.max(50, Number(process.env.HUMAN_CHECKOUT_HEARTBEAT_MS) || 60_000);
/** When a claim last showed its owner alive: its heartbeat, else the claim itself. */
const lastSignOf = (rec) => Math.max(Number(rec?.claimedAt) || Date.parse(rec?.at) || 0, Number(rec?.beatAt) || 0);
const REFUND_RETRY_MS = 30_000;
const MAX_REFUND_ATTEMPTS = 6;
// Failure breaker (review 2026-09-03): every failed generation is refunded, and Stripe keeps its fee on a
// refund, so an input engineered to fail costs us the fee plus the upstream spend each time. After
// FAIL_MAX failures from one buyer address inside FAIL_WINDOW_MS the next paid session is refunded
// WITHOUT a generation attempt (the fee is still lost, the upstream spend is not). Default: see CLAUDE.local.md.
const FAIL_MAX = Math.max(1, Number(process.env.HUMAN_CHECKOUT_FAIL_MAX) || 3);
const FAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MEM_CACHE_MAX = 500;
const SESSION_RE = /^cs_[A-Za-z0-9_]+$/;

const DATA_ROOT = () => (existsSync("/data") ? "/data" : "/tmp");
const DEFAULT_DIR = () => join(DATA_ROOT(), "human-checkout");
const LEGACY_FILE = () => join(DATA_ROOT(), "human-checkout.json");

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function writeJsonAtomic(path, obj) {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

// ---- state database: the records of this collection ----------------------
const USE_PG = stateDbEnabled();
const COLL = "human-checkout";
const RT = () => `${stateDbSchema()}.records`;
const indexId = (path) => basename(path, ".json"); // _inflight.json -> _inflight
const INDEX_IDS = ["_inflight", "_issues", "_public", "_failures"];
// A file written this much later than the newest row was written by a build
// that used the files alone (a rollback); write-through lands within milliseconds.
export const ROLL_FORWARD_GRACE_MS = 60_000;
const pgGet = async (id) => (await stateQuery(`SELECT body FROM ${RT()} WHERE collection = $1 AND id = $2`, [COLL, id])).rows[0]?.body ?? null;
const pgPut = async (id, body) => { await stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`, [COLL, id, JSON.stringify(body)]); };
const pgPutIfAbsent = async (id, body) => (await stateQuery(`INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT (collection, id) DO NOTHING`, [COLL, id, JSON.stringify(body)])).rowCount === 1;
// A final record (done, or an error): it replaces only a "generating" claim
// or an error whose refund is not recorded yet, so a replayed write never
// undoes a report delivered (or made public) or a refund already recorded.
// With `claimId` (the claim the writer held when it made the record) it
// replaces a "generating" claim only while that claim is still the writer's:
// once another container took the claim over (and regenerates or refunds),
// a late record from the old owner books nothing. Resolves true when it
// wrote; false means the row holds a final record, or a claim not the
// writer's.
const pgPutFinal = async (id, body, claimId = null) => (await stateQuery(
  `INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb)
   ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()
   WHERE (${RT()}.body ->> 'status' = 'generating'
          AND ($4::text IS NULL OR ${RT()}.body ->> 'claimId' IS NOT DISTINCT FROM $4::text))
      OR (${RT()}.body ->> 'status' = 'error' AND EXCLUDED.body ->> 'status' = 'error' AND ${RT()}.body ->> 'refundId' IS NULL)`,
  [COLL, id, JSON.stringify(body), claimId == null ? null : String(claimId)],
)).rowCount === 1;
const pgIds = async () => (await stateQuery(`SELECT id FROM ${RT()} WHERE collection = $1`, [COLL])).rows.map((r) => r.id);
const pgClear = async () => { await stateQuery(`DELETE FROM ${RT()} WHERE collection = $1`, [COLL]); };
// One key of an index row set or dropped in one statement (the row is created
// when absent); resolves the index body.
const pgPatchIndex = async (id, key, value) => (await stateQuery(
  `INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb)
   ON CONFLICT (collection, id) DO UPDATE SET body = (${RT()}.body || $3::jsonb) - $4::text[], updated_at = now()
   RETURNING body`,
  [COLL, id, JSON.stringify(value === null ? {} : { [key]: value }), value === null ? [key] : []],
)).rows[0].body;
// A failure timestamp appended to the buyer's list in one statement.
const pgAppendFailure = async (key, at) => (await stateQuery(
  `INSERT INTO ${RT()} (collection, id, body) VALUES ($1, '_failures', jsonb_build_object($2::text, jsonb_build_array($3::bigint)))
   ON CONFLICT (collection, id) DO UPDATE SET body = jsonb_set(${RT()}.body, ARRAY[$2::text], COALESCE(${RT()}.body -> $2::text, '[]'::jsonb) || jsonb_build_array($3::bigint)), updated_at = now()
   RETURNING body`,
  [COLL, key, at],
)).rows[0].body;
// THE CLAIM. The record becomes this "generating" claim only when no record
// exists, or the record is the stale "generating" claim the caller saw
// (its claimedAt matches) and its owner has still shown no sign of life
// since `staleBefore` (no heartbeat landed after the caller read it): a
// record another container finished, claimed since, or is still beating,
// is never overwritten. Resolves true when this call holds the claim.
const pgClaim = async (id, claim, seenClaimedAt, staleBefore) => (await stateQuery(
  `INSERT INTO ${RT()} (collection, id, body) VALUES ($1, $2, $3::jsonb)
   ON CONFLICT (collection, id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()
   WHERE ${RT()}.body ->> 'status' = 'generating' AND $4::numeric IS NOT NULL AND COALESCE((${RT()}.body ->> 'claimedAt')::numeric, 0) = $4::numeric
     AND COALESCE((${RT()}.body ->> 'beatAt')::numeric, 0) <= $5::numeric
   RETURNING id`,
  [COLL, id, JSON.stringify(claim), seenClaimedAt == null ? null : Number(seenClaimedAt), Number(staleBefore) || 0],
)).rowCount === 1;
// THE HEARTBEAT. Each claim this container still owns (the row is the
// "generating" claim with the claimedAt it wrote) gets `beatAt`, and
// `generatedAt` when its report exists but its final record has not landed.
// Resolves the ids it refreshed.
const pgBeat = async (owned, at) => (await stateQuery(
  `UPDATE ${RT()} AS r SET body = r.body || jsonb_build_object('beatAt', $4::bigint)
     || CASE WHEN o.generated THEN jsonb_build_object('generatedAt', COALESCE(r.body -> 'generatedAt', to_jsonb($4::bigint))) ELSE '{}'::jsonb END,
     updated_at = now()
   FROM unnest($2::text[], $3::numeric[], $5::boolean[]) AS o(id, claimed, generated)
   WHERE r.collection = $1 AND r.id = o.id AND r.body ->> 'status' = 'generating'
     AND COALESCE((r.body ->> 'claimedAt')::numeric, 0) = o.claimed
   RETURNING r.id`,
  [COLL, owned.map((o) => o.id), owned.map((o) => o.claimedAt), at, owned.map((o) => o.generated)],
)).rows.map((r) => r.id);

// The public index and its reports, mirrored for the synchronous readers
// (served on every page load, with or without a Stripe engine).
const pub = { idx: {}, recs: new Map(), refreshing: null, lastAt: 0 };
export async function refreshPublicMirror() {
  if (!USE_PG) return;
  if (pub.refreshing) return pub.refreshing;
  pub.refreshing = (async () => {
    const idx = (await pgGet("_public")) || {};
    const recs = new Map();
    for (const [publicId, sid] of Object.entries(idx)) {
      if (!PUBLIC_ID_RE.test(publicId) || !SESSION_RE.test(String(sid))) continue;
      const rec = await pgGet(sid);
      if (rec) recs.set(sid, rec);
    }
    pub.idx = idx; pub.recs = recs; pub.lastAt = Date.now();
  })().catch(() => {}).finally(() => { pub.refreshing = null; });
  return pub.refreshing;
}
const nudgePublicMirror = () => { if (USE_PG && Date.now() - pub.lastAt > 2000) refreshPublicMirror(); };
if (USE_PG) {
  trackStoreReady(refreshPublicMirror());
  const t = setInterval(() => { refreshPublicMirror(); }, 60_000);
  t.unref?.();
}

/**
 * @param {object} deps
 * @param {Stripe} deps.stripe            Stripe client (injectable for tests)
 * @param {(kind,slug,input,ctx)=>Promise<object>} deps.generate  runs the real report handler
 * @param {string} deps.baseUrl
 * @param {string} [deps.storeDir]        override for tests
 * @param {(sale:object)=>void} [deps.onSale]  called once per DELIVERED report (accounting)
 * @param {()=>number} [deps.now]
 * @param {(s:string)=>void} [deps.log]
 */
export function createHumanCheckout({ stripe, generate, baseUrl, storeDir, onSale, onDelivered = null, onFailed = null, now = () => Date.now(), log = console.log }) {
  const dir = storeDir || DEFAULT_DIR();
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort; writes will fail loudly below */ }
  const INFLIGHT = join(dir, "_inflight.json");   // sessionId -> claimedAt (ms)
  const ISSUES = join(dir, "_issues.json");       // sessionId -> { kind, at, ... } (owed refunds etc.)
  const FAILURES = join(dir, "_failures.json");   // sha256(buyer email) prefix -> [failure ms] inside FAIL_WINDOW_MS
  const recPath = (id) => join(dir, `${id}.json`); // id already validated by SESSION_RE

  const mem = new Map();            // sessionId -> terminal record (bounded cache; file backend only)
  const inFlight = new Map();       // sessionId -> Promise (generate-once within a process)
  const negative = new Map();       // sessionId -> { status, until }
  const NEG_TTL = { not_found: 60_000, unpaid: 10_000 };

  // One-time import of the legacy single-file store (reports sold before the
  // per-session layout) so every "yours to keep" link keeps resolving.
  (function migrateLegacy() {
    const legacy = readJson(LEGACY_FILE());
    if (!legacy || typeof legacy !== "object") return;
    let n = 0;
    for (const [id, rec] of Object.entries(legacy)) {
      if (!SESSION_RE.test(id) || existsSync(recPath(id))) continue;
      if (writeJsonAtomic(recPath(id), rec)) n++;
    }
    try { renameSync(LEGACY_FILE(), `${LEGACY_FILE()}.migrated`); } catch { /* keep it; idempotent next boot */ }
    log(`[human-checkout] migrated ${n} legacy report record(s) into ${dir}`);
  })();

  // ---- the store: files, or rows with the files written through ------------
  // Every primitive answers at once on the files and in a promise on the
  // database; the callers await either.
  let throughWarned = false;
  const through = (path, body) => {
    if (!USE_PG || !existsSync(dir)) return;
    if (!writeJsonAtomic(path, body) && !throughWarned) { throughWarned = true; log(`[human-checkout] write-through to ${dir} failed (the database row is the record)`); }
  };
  async function importDir() {
    const files = (() => { try { return readdirSync(dir); } catch { return []; } })();
    let bytes = 0, n = 0;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!(SESSION_RE.test(id) || INDEX_IDS.includes(id))) continue;
      const body = readJson(join(dir, f));
      if (!body) continue;
      await pgPutIfAbsent(id, body);
      try { bytes += statSync(join(dir, f)).size; } catch { /* counted as 0 */ }
      if (SESSION_RE.test(id)) n++;
    }
    log(`[human-checkout] imported ${n} report record(s) from ${dir} into the state database`);
    await refreshPublicMirror();
    return { bytes, records: n };
  }
  // Roll-forward (the shape of json-document's reimportIfFileNewer): a record
  // or index file written after the newest row, beyond the write-through
  // grace, was written by the previous build running on the files alone (a
  // rollback window): every record and index is re-read with the FILE
  // WINNING per id, and the replacement is logged.
  async function rollForwardIfFilesNewer() {
    const files = (() => { try { return readdirSync(dir).filter((f) => f.endsWith(".json") && (SESSION_RE.test(f.slice(0, -5)) || INDEX_IDS.includes(f.slice(0, -5)))); } catch { return []; } })();
    let mtime = 0;
    for (const f of files) { try { mtime = Math.max(mtime, statSync(join(dir, f)).mtimeMs); } catch { /* gone */ } }
    if (!mtime) return 0;
    const newest = await stateQuery(`SELECT max(updated_at) AS at FROM ${RT()} WHERE collection = $1`, [COLL]);
    let rowAt = newest.rows[0]?.at ? new Date(newest.rows[0].at).getTime() : 0;
    if (!rowAt) { const mark = await imports.done(basename(dir)); rowAt = mark?.importedAt ? new Date(mark.importedAt).getTime() : 0; }
    if (!rowAt || mtime <= rowAt + ROLL_FORWARD_GRACE_MS) return 0;
    let records = 0, indexes = 0;
    for (const f of files) {
      const body = readJson(join(dir, f));
      if (!body) continue;
      const id = f.slice(0, -5);
      await pgPut(id, body);
      if (SESSION_RE.test(id)) records++; else indexes++;
    }
    log(`[human-checkout] rolled forward ${records} record(s) and ${indexes} index(es) from ${dir}: the files were written ${Math.round((mtime - rowAt) / 1000)} s after the newest row (a rollback window), the files win`);
    await refreshPublicMirror();
    return records + indexes;
  }
  // The first load is retried until it lands: a failed attempt is
  // forgotten, so the next call tries again, and a background timer retries
  // for a store nobody calls.
  const loader = USE_PG ? retryingLoad("[human-checkout]", async () => {
    await importOnce(basename(dir), { source: dir, run: importDir });
    await rollForwardIfFilesNewer();
  }, { log }) : null;
  const readyP = () => (loader ? loader.ready() : Promise.resolve());
  if (loader) { trackStoreReady(loader.eventually); readyP().catch(() => {}); }

  const readRec = USE_PG ? async (id) => { await readyP(); return pgGet(id); } : (id) => readJson(recPath(id));
  const writeRec = USE_PG
    ? async (id, rec) => { await readyP(); await pgPut(id, rec); through(recPath(id), rec); }
    : (id, rec) => {
      writeJsonAtomic(recPath(id), rec);
      if (rec.status === "done" || rec.status === "error") {
        if (mem.size >= MEM_CACHE_MAX) mem.delete(mem.keys().next().value);
        mem.set(id, rec);
      }
    };
  // The claim (see pgClaim). On the files the write is the claim: one process.
  const claimRec = USE_PG
    ? async (id, claim, seenClaimedAt) => { await readyP(); const held = await pgClaim(id, claim, seenClaimedAt, now() - STALE_CLAIM_MS); if (held) through(recPath(id), claim); return held; }
    : (id, claim) => { writeRec(id, claim); return true; };
  const readIndex = USE_PG ? async (p) => { await readyP(); return (await pgGet(indexId(p))) || {}; } : (p) => readJson(p) || {};
  const patchIndex = USE_PG
    ? async (p, id, value) => { await readyP(); const body = await pgPatchIndex(indexId(p), id, value); through(p, body); return body; }
    : (p, id, value) => {
      const idx = readIndex(p);
      if (value === null) delete idx[id]; else idx[id] = value;
      writeJsonAtomic(p, idx);
      return idx;
    };
  // ---- final records that must outlive a database failure (database mode) --
  // A delivered report (after the upstream spend) and an error record (before
  // its refund is issued) are written with pgPutFinal under the writer's
  // claim; one that does not land is kept in the journal (Redis with
  // REDIS_URL set, shared by every container; else, or when Redis does not
  // take it, an NDJSON file in the store directory) and in memory, and
  // replayed on a timer until Postgres holds it. Never a refund for a report
  // that was made.
  // ONE OUTCOME PER PURCHASE. A record kept only on this container's disk is
  // never answered to the buyer (they see "generating"), and its delivery
  // (the email, the follow-ups, the sale) waits for its replay: if another
  // container takes the stale claim over first, it regenerates or refunds,
  // and this record's replay, written under the old claim, books nothing. A
  // record in Redis is answered at once and delivered: another container
  // that finds the claim stale books it from the journal instead of taking
  // over (and, when it cannot read the journal, waits).
  const pendingFinals = new Map(); // sessionId -> record not yet in the database
  const sharedFinals = new Set(); // sessionIds whose pending record is in a shared store (Redis)
  const heldAnswers = new WeakSet(); // recordError answers whose record the row refused
  const finalsDeadLetter = USE_PG ? createDeadLetter({ file: join(dir, "_pending-finals.ndjson"), name: "checkoutFinals", journalKey: `${stateDbSchema()}:checkoutFinals` }) : null;
  const FINALS_REPLAY_MS = Number(process.env.HUMAN_CHECKOUT_REPLAY_MS) || 5_000;
  // Claims this container holds (sessionId -> claimedAt): beaten while the
  // job runs or its final record waits here (see pgBeat). Dropped when the
  // job ends with nothing waiting, or once the final record lands or is refused.
  const owned = new Map();
  // The claim id (claimId on the row) each claim this container made carries;
  // a final record is written under it (see pgPutFinal).
  const claimIds = new Map(); // sessionId -> claimId
  const releaseOwned = (id) => { if (!inFlight.has(id) && !pendingFinals.has(id)) owned.delete(id); };
  let beating = false;
  async function beat() {
    if (!owned.size || beating) return 0;
    beating = true;
    try {
      const list = [...owned].map(([id, claimedAt]) => ({ id, claimedAt, generated: pendingFinals.get(id)?.status === "done" }));
      const live = new Set(await pgBeat(list, now()));
      // A claim no longer ours (finished or taken over) is not beaten again
      // once nothing for it is running or waiting here.
      for (const o of list) if (!live.has(o.id) && !inFlight.has(o.id) && !pendingFinals.has(o.id)) owned.delete(o.id);
      return live.size;
    } catch { return 0; /* the database is away: the next beat retries */ }
    finally { beating = false; }
  }
  async function afterFinal(id, rec) {
    try { await patchIndex(INFLIGHT, id, null); } catch { /* the boot sweep clears a finished claim */ }
    if (rec.status === "error") {
      try { await patchIndex(ISSUES, id, rec.refundId ? null : { kind: "refund-owed", at: rec.at, attempts: rec.refundAttempts }); }
      catch (e) { log(`[human-checkout] issues index for ${id} not updated: ${String(e?.message || e).slice(0, 120)}`); }
    }
  }
  /**
   * Write a final record. Resolves true when Postgres holds THIS record now,
   * "held" when the row already held a final record this one may not replace
   * (a delivered report, or a recorded refund): nothing was written, and the
   * caller must not act as if it had been (no refund, no issues entry), and
   * false when it was kept on local disk for replay.
   */
  // Resolves "shared" when the record did not reach Postgres but is in Redis
  // (the buyer may be answered and the report delivered), false when it is
  // kept on this container's disk or in memory only (neither, yet).
  async function landFinal(id, rec) {
    const claimId = claimIds.get(id) ?? null;
    try {
      await readyP();
      const wrote = await pgPutFinal(id, rec, claimId);
      pendingFinals.delete(id);
      sharedFinals.delete(id);
      owned.delete(id);
      claimIds.delete(id);
      if (!wrote) return "held";
      through(recPath(id), rec);
      await afterFinal(id, rec);
      return true;
    } catch (e) {
      pendingFinals.set(id, rec);
      sharedFinals.delete(id);
      // Say so on the claim at once if a short statement still lands (a
      // final refused on its own): a report exists, never refund this claim.
      beat().catch(() => {});
      // In Redis the writer delivers (it answers the buyer now); on local
      // disk the replay that books it delivers.
      const { where } = await finalsDeadLetter.addAsync("final", { id, rec, claimId, deliver: "writer" }, { localPayload: { id, rec, claimId, deliver: "replay" } });
      if (where === "redis" && pendingFinals.get(id) === rec) sharedFinals.add(id);
      log(`[human-checkout] the ${rec.status} record for ${id} did not land (${String(e?.message || e).slice(0, 120)}); kept ${where === "redis" ? "in Redis" : where === "local" ? "on local disk" : "in memory only"} for replay`);
      return where === "redis" ? "shared" : false;
    }
  }
  // Book a record a journal holds: under the claim it was made for, so a
  // record whose claim was taken over books nothing. A record that waited on
  // local disk is delivered by the write that books it.
  async function bookJournaled(id, payload) {
    const { rec, claimId = null, deliver: by = null } = payload;
    const newest = pendingFinals.get(id);
    const body = newest && Date.parse(newest.at || 0) > Date.parse(rec.at || 0) ? newest : rec;
    let wrote = await pgPutFinal(id, body, claimId);
    if (wrote) through(recPath(id), body);
    else {
      // The row may hold this very record (its first write landed and the
      // reply was lost): that is this record booked, not another outcome.
      const row = await pgGet(id);
      const same = row && row.status === body.status && row.at === body.at && row.report === body.report && row.refundId === body.refundId;
      if (same) wrote = true;
      else log(`[human-checkout] the journaled ${body.status} record for ${id} booked nothing: the row holds a final record or a claim taken over since`);
    }
    const held = pendingFinals.get(id);
    if (held && !(Date.parse(held.at || 0) > Date.parse(body.at || 0))) { pendingFinals.delete(id); sharedFinals.delete(id); }
    releaseOwned(id);
    // A record the row refused (it holds a delivered report, a recorded
    // refund, or another container's claim) is dropped without touching the
    // issues index.
    if (wrote) {
      await afterFinal(id, body);
      if (by === "replay" && body.status === "done") await deliverLater(id).catch((e) => log(`[human-checkout] delivery of ${id} after its replay failed: ${String(e?.message || e).slice(0, 120)}`));
    }
    return wrote;
  }
  // One replay at a time; a caller arriving during one waits for it.
  let replayingFinals = null;
  function replayFinals() {
    if (!finalsDeadLetter || !finalsDeadLetter.size()) return Promise.resolve(0);
    if (!replayingFinals) replayingFinals = replayFinalsOnce().finally(() => { replayingFinals = null; });
    return replayingFinals;
  }
  async function replayFinalsOnce() {
    let landed = 0;
    try {
      await readyP();
      // Claimed (one drainer across containers), each entry removed only
      // once its write committed. A newer final for the same session (a
      // refund recorded after its intent) replaces an older one.
      landed = await finalsDeadLetter.drain(async (e) => {
        const { id, rec } = e.payload || {};
        if (!SESSION_RE.test(String(id)) || !rec) return "drop";
        await bookJournaled(id, e.payload);
        return "landed";
      });
    } catch { /* the database is still away: the next tick retries */ }
    if (landed) log(`[human-checkout] landed ${landed} record(s) kept on local disk`);
    return landed;
  }
  if (USE_PG) {
    readyP().then(() => replayFinals()).catch(() => {});
    everyMs(() => replayFinals(), FINALS_REPLAY_MS);
    everyMs(() => beat(), HEARTBEAT_MS);
  }

  const negGet = (id) => { const n = negative.get(id); if (n && n.until > now()) return { status: n.status }; if (n) negative.delete(id); return null; };
  const negSet = (id, status) => { if (negative.size > 5000) negative.clear(); negative.set(id, { status, until: now() + (NEG_TTL[status] || 10_000) }); return { status }; };

  async function createSession(productKey, inputValue) {
    const p = Object.hasOwn(HUMAN_PRODUCTS, String(productKey)) ? HUMAN_PRODUCTS[productKey] : null;
    if (!p) { const e = new Error("Unknown product"); e.statusCode = 400; throw e; }
    const input = String(inputValue ?? "").trim();
    if (!input) { const e = new Error(`Please provide ${p.inputLabel}.`); e.statusCode = 400; throw e; }
    if (input.length > 2000) { const e = new Error("Input is too long."); e.statusCode = 400; throw e; }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Promotion codes are created in the Stripe dashboard (a first-report
      // code, a partner code); the one-shot flow accepted none until 2026-08-28.
      allow_promotion_codes: true,
      ...(String(process.env.STRIPE_AUTOMATIC_TAX || "").toLowerCase() === "true" ? { automatic_tax: { enabled: true } } : {}),
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: p.price,
          product_data: { name: p.label, description: `On: ${input.slice(0, 120)}` },
        },
      }],
      // The report input rides in metadata - we NEVER trust the client for it on
      // fulfillment; it comes back from Stripe with the paid session. Stripe caps
      // a metadata VALUE at 500 chars, so a long input is chunked across keys.
      metadata: { product: productKey, ...chunkInput(input) },
      success_url: `${baseUrl}/r/{CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/reports?canceled=1`,
      // No customer account created; a one-off charge.
      payment_intent_data: { description: `Agent402 ${p.label}` },
    });
    return { id: session.id, url: session.url };
  }

  // Refund the session's PaymentIntent. Returns the refund id, or null when it
  // failed - the CALLER persists the owed state; nothing here is silent.
  async function refundSession(session) {
    try {
      const pi = session?.payment_intent;
      if (pi) {
        const piId = typeof pi === "string" ? pi : pi.id;
        // On the database the refund carries a key of its own, so a refund
        // issued again for the same payment (a retry whose reply was lost)
        // returns the first one instead of failing or doubling.
        const r = USE_PG ? await stripe.refunds.create({ payment_intent: piId }, { idempotencyKey: `agent402-refund-${piId}` }) : await stripe.refunds.create({ payment_intent: piId });
        return r.id;
      }
    } catch (e) { log(`[human-checkout] refund failed: ${String(e?.message || e).slice(0, 160)}`); }
    return null;
  }
  // Persist an error outcome; an unrefunded one is OWED (indexed, retried).
  // `intent`: the record written BEFORE a refund is issued (database mode):
  // owed, no attempt counted, due at once.
  async function recordError(id, session, refundId, message, { intent = false } = {}) {
    let prev = {};
    try { prev = pendingFinals.get(id) || (await readRec(id)) || {}; } catch (e) { if (!USE_PG) throw e; }
    if (!intent) import("./posthog.js").then(({ capturePostHogHumanFunnel }) => capturePostHogHumanFunnel({ step: "failed", product: prev.slug || null, reason: refundId ? "refunded" : "refund-owed" })).catch(() => {});
    const rec = {
      status: "error", refundId,
      error: refundId ? `${message} Your payment has been refunded.` : `${message} Your refund is being processed.`,
      refundOwed: !refundId, refundAttempts: (prev.refundAttempts || 0) + (intent ? 0 : 1), lastRefundAttemptAt: intent ? 0 : now(),
      paymentIntent: typeof session?.payment_intent === "string" ? session.payment_intent : session?.payment_intent?.id || null,
      at: new Date(now()).toISOString(),
    };
    if (USE_PG) {
      if ((await landFinal(id, rec)) !== "held") return rec;
      // The row holds a final record this one may not replace: answer with
      // that row, marked so a caller never refunds on the strength of it.
      let row = null;
      try { row = await readRec(id); } catch { /* answered below */ }
      const answer = row && row.status !== "generating" ? row : { status: "generating" };
      heldAnswers.add(answer);
      return answer;
    }
    await writeRec(id, rec);
    await patchIndex(INFLIGHT, id, null);
    await patchIndex(ISSUES, id, refundId ? null : { kind: "refund-owed", at: rec.at, attempts: rec.refundAttempts });
    return rec;
  }
  // Refund a session and record it. On the database the owed record lands
  // FIRST (kept on local disk if Postgres is away), so a refund is never
  // issued that no record names; while that record has not landed the
  // refund waits (an owed record's refund is retried on the next poll).
  async function refundAndRecord(id, session, message) {
    if (!USE_PG) { const refundId = await refundSession(session); return recordError(id, session, refundId, message); }
    const owed = await recordError(id, session, null, message, { intent: true });
    if (pendingFinals.has(id)) return owed;
    // The pre-refund record did not land on the row (it already holds a
    // delivered report or a recorded refund): no refund is issued.
    if (heldAnswers.has(owed)) return owed;
    const refundId = await refundSession(session);
    return recordError(id, session, refundId, message);
  }
  // An owed refund is retried on later polls (bounded, paced).
  async function retryOwedRefund(id, rec) {
    if (!rec.refundOwed || rec.refundId) return rec;
    if ((rec.refundAttempts || 0) >= MAX_REFUND_ATTEMPTS) return rec;
    if (now() - (rec.lastRefundAttemptAt || 0) < REFUND_RETRY_MS) return rec;
    if (USE_PG && pendingFinals.has(id)) return rec; // its owed record has not landed yet
    const refundId = await refundSession({ payment_intent: rec.paymentIntent });
    return recordError(id, { payment_intent: rec.paymentIntent }, refundId, rec.error.replace(/ Your refund is being processed\.$/, ""));
  }

  const failKeyOf = (session) => {
    const e = String(session?.customer_details?.email || session?.customer_email || "").trim().toLowerCase();
    return e ? createHash("sha256").update(e).digest("hex").slice(0, 24) : null;
  };
  const inWindow = (list) => (list || []).filter((t) => now() - Number(t) < FAIL_WINDOW_MS);
  const recentFailures = USE_PG
    ? async (k) => (k ? inWindow((await readIndex(FAILURES))[k]) : [])
    : (k) => (k && inWindow(readIndex(FAILURES)[k])) || [];
  const noteFailure = USE_PG
    ? async (k) => { if (!k) return; await readyP(); through(FAILURES, await pgAppendFailure(k, now())); }
    : (k) => { if (!k) return; patchIndex(FAILURES, k, [...recentFailures(k), now()]); };

  // A delivered report's effects: the ready email, the follow-ups and the
  // sale. Run once per report, by the container whose record the buyer is
  // answered from (see ONE OUTCOME above).
  function deliver(sessionId, session, p, input) {
    const email = session.customer_details?.email || session.customer_email;
    // `kind` + baseUrl let the email carry the matching MONITOR offer with
    // this target prefilled (the retention loop); a kind with no monitor
    // simply gets no offer. See src/report-upgrade.js.
    if (email) sendReportReadyEmail({ to: email, reportUrl: `${baseUrl}/r/${sessionId}`, productLabel: p.label, subjectOf: input, kind: p.kind, baseUrl }).catch(() => {});
    // Post-purchase sequence (src/followups.js): the only moment the buyer's
    // address is in hand next to what they bought. Never stored on the record.
    if (email) { try { onDelivered?.({ sessionId, email, product: p.slug, kind: p.kind, label: p.label, input }); } catch { /* follow-ups never break delivery */ } }
    // Book what Stripe actually collected (a promotion code lowers it), never the list price.
    const paidUsd = Number.isFinite(Number(session.amount_total)) ? Number(session.amount_total) / 100 : p.price / 100;
    try { onSale?.({ sessionId, product: p.slug, priceUsd: paidUsd, listPriceUsd: p.price / 100, paymentIntent: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null }); } catch { /* accounting never breaks delivery */ }
  }
  // The same, for a record a replay booked: the session (the address, what
  // was paid) is read again from Stripe, never kept in the journal.
  async function deliverLater(sessionId) {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const p = Object.hasOwn(HUMAN_PRODUCTS, String(session?.metadata?.product)) ? HUMAN_PRODUCTS[session.metadata.product] : null;
    if (!p) return;
    deliver(sessionId, session, p, unchunkInput(session.metadata || {}));
  }

  // `seenClaimedAt` is the claimedAt of the stale claim this call is taking
  // over (null when it saw no record): the claim lands only if that is still
  // what the store holds, so a session is generated by exactly one job.
  function startJob(sessionId, session, p, input, { takeover = 0, seenClaimedAt = null } = {}) {
    const claim = { status: "generating", kind: p.kind, slug: p.slug, at: new Date(now()).toISOString(), claimedAt: now(), claimId: randomBytes(9).toString("base64url"), takeovers: takeover, pid: process.pid };
    const job = (async () => {
      try {
        // On the files these three steps stay synchronous (no await), so the
        // generation starts in the same turn as the claim, as it always did.
        const held = USE_PG ? await claimRec(sessionId, claim, seenClaimedAt) : claimRec(sessionId, claim, seenClaimedAt);
        if (!held) return { status: "generating", claimedElsewhere: true };
        if (USE_PG) { owned.set(sessionId, claim.claimedAt); claimIds.set(sessionId, claim.claimId); }
        if (USE_PG) await patchIndex(INFLIGHT, sessionId, now()); else patchIndex(INFLIGHT, sessionId, now());
        const failKey = failKeyOf(session);
        const failures = USE_PG ? await recentFailures(failKey) : recentFailures(failKey);
        let generated = false;
        try {
          if (failures.length >= FAIL_MAX) {
            log(`[human-checkout] ${sessionId} (${p.slug}): buyer address has ${FAIL_MAX}+ failed reports in the window - refunded without a generation attempt`);
            return await refundAndRecord(sessionId, session, "Recent reports for this email address could not be completed, so this purchase was refunded without a new attempt. Please try again tomorrow, or email us with the input you used.");
          }
          // generate() may return a plain report string (legacy / tests) or a
          // bundle { report, title, sources, tables }. Normalize either way.
          const g = await generate(p.kind, p.slug, input, { buyerKey: `human:${sessionId}`, rail: "card", priceUsd: Number(p.price) / 100 });
          const bundle = (g && typeof g === "object") ? g : { report: String(g ?? "") };
          if (!bundle.report) throw new Error("empty report");
          generated = true;
          const rec = {
            status: "done", kind: p.kind, slug: p.slug, input,
            report: bundle.report,
            title: bundle.title || input,
            sources: Array.isArray(bundle.sources) ? bundle.sources : [],
            tables: Array.isArray(bundle.tables) ? bundle.tables : [],
            ...(Array.isArray(bundle.images) && bundle.images.length ? { images: bundle.images } : {}),
            at: new Date(now()).toISOString(),
          };
          // The report exists and the upstream spend is made: from here a
          // database failure keeps the record for replay, never a refund.
          if (USE_PG) {
            const landed = await landFinal(sessionId, rec);
            // On local disk only: the buyer is not answered and nothing is
            // delivered until a replay books it (see ONE OUTCOME above).
            if (landed === false) return { status: "generating" };
            if (landed === "held") { log(`[human-checkout] ${sessionId}: the report was made but the row holds another outcome; nothing delivered from this container`); return { status: "generating" }; }
          } else { await writeRec(sessionId, rec); await patchIndex(INFLIGHT, sessionId, null); }
          deliver(sessionId, session, p, input);
          return rec;
        } catch (err) {
          log(`[human-checkout] report failed for ${sessionId} (${p.slug}): ${String(err?.message || err).slice(0, 160)}`);
          if (USE_PG && generated) throw err; // the record is kept (landFinal); a failure after it is not a failed report
          if (USE_PG) {
            try { await noteFailure(failKey); } catch (e) { log(`[human-checkout] failure count for ${sessionId} not recorded: ${String(e?.message || e).slice(0, 120)}`); }
            const rec = await refundAndRecord(sessionId, session, "We couldn't complete this report.");
            const failEmail = session.customer_details?.email || session.customer_email;
            if (failEmail) { try { onFailed?.({ email: failEmail, product: p.slug, label: p.label, refunded: Boolean(rec.refundId) }); } catch { /* never breaks the refund path */ } }
            return rec;
          }
          await noteFailure(failKey);
          const refundId = await refundSession(session);
          const failEmail = session.customer_details?.email || session.customer_email;
          if (failEmail) { try { onFailed?.({ email: failEmail, product: p.slug, label: p.label, refunded: Boolean(refundId) }); } catch { /* never breaks the refund path */ } }
          return await recordError(sessionId, session, refundId, "We couldn't complete this report.");
        }
      } finally { inFlight.delete(sessionId); releaseOwned(sessionId); }
    })();
    // A claim or read that failed (the database away) ends the job; the next
    // poll tries again. Never an unhandled rejection.
    job.catch((e) => log(`[human-checkout] job for ${sessionId} stopped: ${String(e?.message || e).slice(0, 160)}`));
    inFlight.set(sessionId, job);
  }

  // Idempotent, generate-once, refund-on-failure. Returns a status object the
  // page polls. NEVER generates without a verified-paid Stripe session.
  async function fulfill(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { status: "invalid" };
    const cached = USE_PG ? null : mem.get(sessionId);
    if (cached) return cached.status === "error" ? retryOwedRefund(sessionId, cached) : cached;
    if (inFlight.has(sessionId)) return { status: "generating" };
    const kept = USE_PG ? pendingFinals.get(sessionId) : null;
    if (kept) {
      // Only a record in a shared store is answered: one on this disk alone
      // may yet be superseded by another container's takeover.
      if (!sharedFinals.has(sessionId)) return { status: "generating" };
      return kept.status === "error" ? retryOwedRefund(sessionId, kept) : kept;
    }
    let disk = await readRec(sessionId);
    // A stale claim with records waiting in the journal (this store's own
    // disk after a restart, or another container's in Redis): land them
    // first, then decide on the row.
    if (USE_PG && disk?.status === "generating" && now() - lastSignOf(disk) >= STALE_CLAIM_MS && finalsDeadLetter.size()) {
      await replayFinals();
      disk = await readRec(sessionId);
    }
    // Before taking a stale claim over: a final record for THIS claim in the
    // shared journal (its owner answered the buyer from it) is booked, never
    // regenerated or refunded. A journal that cannot be read is not "empty":
    // the claim is left alone until it can be.
    if (USE_PG && disk?.status === "generating" && now() - lastSignOf(disk) >= STALE_CLAIM_MS) {
      let entries;
      try { entries = await finalsDeadLetter.entries({ strict: true }); }
      catch { return { status: "generating" }; }
      const mine = entries.filter((e) => e.kind === "final" && e.payload?.id === sessionId && e.payload?.rec
        && (e.payload.claimId == null || e.payload.claimId === disk.claimId));
      mine.sort((a, b) => Date.parse(b.payload.rec.at || 0) - Date.parse(a.payload.rec.at || 0));
      if (mine.length) {
        await bookJournaled(sessionId, mine[0].payload);
        disk = await readRec(sessionId);
      }
    }
    if (disk && (disk.status === "done" || disk.status === "error")) {
      if (!USE_PG) writeRec(sessionId, disk); // warms the memory cache
      return disk.status === "error" ? retryOwedRefund(sessionId, disk) : disk;
    }
    let takeover = 0, seenClaimedAt = null;
    let generatedElsewhere = false;
    if (disk && disk.status === "generating") {
      // Silent since its last heartbeat (or since the claim, before the first one).
      const age = now() - lastSignOf(disk);
      if (age < STALE_CLAIM_MS) return { status: "generating" };
      // Abandoned claim (restart mid-generation). One takeover regenerates;
      // a second abandonment means something is wrong with this job: refund,
      // unless the claim says its report was made (its final record was lost
      // with its container): that one is generated again, never refunded.
      takeover = (disk.takeovers || 0) + 1;
      seenClaimedAt = disk.claimedAt || 0;
      generatedElsewhere = Number(disk.generatedAt) > 0;
      log(`[human-checkout] abandoned claim ${sessionId} (${Math.round(age / 1000)}s silent, takeover #${takeover}${generatedElsewhere ? ", its report was made" : ""})`);
    }

    const neg = negGet(sessionId);
    if (neg) return neg;
    let session;
    try { session = await stripe.checkout.sessions.retrieve(sessionId); } catch { return negSet(sessionId, "not_found"); }
    // "no_payment_required" is a 100%-off promotion code the operator created
    // in the dashboard: fulfil it (the operator chose that) but book $0.
    if (!session || (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")) return negSet(sessionId, "unpaid");
    if (session.mode && session.mode !== "payment") return { status: "invalid" };

    const productKey = session.metadata?.product;
    const input = unchunkInput(session.metadata || {});
    const p = Object.hasOwn(HUMAN_PRODUCTS, String(productKey)) ? HUMAN_PRODUCTS[productKey] : null;
    if (!p || !input) {
      // Paid for a report we cannot identify (our bug, not theirs): refund it.
      return refundAndRecord(sessionId, session, "This purchase is missing its report details.");
    }
    if (takeover > MAX_TAKEOVERS && !generatedElsewhere) {
      // On the database the stale claim is taken first (the same guarded
      // claim a regeneration takes), so a claim whose owner beat, or whose
      // final record landed, since it was read is never refunded.
      if (USE_PG) {
        if (inFlight.has(sessionId)) return { status: "generating" };
        let held = false;
        const claim = { status: "generating", kind: p.kind, slug: p.slug, at: new Date(now()).toISOString(), claimedAt: now(), claimId: randomBytes(9).toString("base64url"), takeovers: takeover, pid: process.pid };
        try { held = await claimRec(sessionId, claim, seenClaimedAt); } catch { held = false; }
        if (held) { owned.set(sessionId, claim.claimedAt); claimIds.set(sessionId, claim.claimId); } // the refund's records are written under this claim
        if (!held) {
          // The row moved since it was read: answer with what it holds now.
          let cur = null;
          try { cur = await readRec(sessionId); } catch { /* answered below */ }
          return cur && (cur.status === "done" || cur.status === "error") ? cur : { status: "generating" };
        }
      }
      return refundAndRecord(sessionId, session, "We couldn't complete this report after a retry.");
    }
    if (inFlight.has(sessionId)) return { status: "generating" };
    startJob(sessionId, session, p, input, { takeover, seenClaimedAt });
    return { status: "generating" };
  }

  // Boot sweep: any claim left in the in-flight index by a previous process is
  // abandoned (the index is cleared on completion). Re-drive each through
  // fulfill() so it regenerates (or refunds) without waiting for a poll - the
  // buyer may have closed the tab. Bounded and sequential.
  async function recoverAbandoned({ limit = 10 } = {}) {
    const idx = await readIndex(INFLIGHT);
    const ids = Object.keys(idx).filter((id) => SESSION_RE.test(id) && !inFlight.has(id)).slice(0, limit);
    const out = [];
    for (const id of ids) {
      const rec = await readRec(id);
      if (!rec || rec.status !== "generating") { await patchIndex(INFLIGHT, id, null); continue; }
      // Only claims older than the stale window are taken over; a fresh one may
      // belong to a process that is still running (another replica).
      if (now() - lastSignOf(rec) < STALE_CLAIM_MS) continue;
      try { out.push({ id, result: (await fulfill(id)).status }); } catch (e) { out.push({ id, result: "error", error: String(e?.message || e).slice(0, 120) }); }
    }
    if (out.length) log(`[human-checkout] recovered ${out.length} abandoned claim(s): ${out.map((o) => `${o.id}=${o.result}`).join(", ")}`);
    return out;
  }

  // Operator view: what needs a human - owed refunds, stuck claims.
  const issuesOf = (inflight, issues) => ({
    inflight: Object.entries(inflight).map(([id, at]) => ({ id, claimedAt: new Date(at).toISOString(), ageMs: now() - at, stale: now() - at >= STALE_CLAIM_MS })),
    refundOwed: Object.entries(issues).map(([id, v]) => ({ id, ...v })),
    storeDir: dir,
  });
  function listIssues() {
    if (USE_PG) return (async () => issuesOf(await readIndex(INFLIGHT), await readIndex(ISSUES)))();
    return issuesOf(readIndex(INFLIGHT), readIndex(ISSUES));
  }

  function peek(sessionId) {
    const valid = SESSION_RE.test(String(sessionId));
    if (USE_PG) return (async () => { if (valid && pendingFinals.has(sessionId)) return sharedFinals.has(sessionId) ? pendingFinals.get(sessionId) : { status: "generating" }; const rec = valid ? await readRec(sessionId) : null; if (rec) return rec; if (inFlight.has(sessionId)) return { status: "generating" }; return null; })();
    const rec = mem.get(sessionId) || (valid ? readRec(sessionId) : null);
    if (rec) return rec;
    if (inFlight.has(sessionId)) return { status: "generating" };
    return null;
  }

  // Buyer toggle: make a delivered report public (mint the public id once) or
  // private again (the id stays reserved and dead: a revoked link never
  // resolves, and a re-publish reuses it so old links work again).
  function setPublic(sessionId, flag) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return USE_PG ? Promise.resolve({ status: "invalid" }) : { status: "invalid" };
    const want = flag === true;
    const toggle = (rec) => {
      if (want && !rec.publicId) rec.publicId = `rp_${randomBytes(12).toString("base64url")}`;
      rec.public = want;
      if (want) rec.publishedAt = new Date(now()).toISOString();
      return { status: "done", public: want, publicId: want ? rec.publicId : null };
    };
    if (USE_PG) {
      return (async () => {
        const rec = await readRec(sessionId);
        if (!rec || rec.status !== "done") return { status: rec?.status || "not_found" };
        const out = toggle(rec);
        await writeRec(sessionId, rec);
        if (rec.publicId) {
          pub.idx = await patchIndex(PUBLIC_INDEX(dir), rec.publicId, want ? sessionId : null);
          if (want) pub.recs.set(sessionId, rec); else pub.recs.delete(sessionId);
        }
        return out;
      })();
    }
    const rec = mem.get(sessionId) || readRec(sessionId);
    if (!rec || rec.status !== "done") return { status: rec?.status || "not_found" };
    const out = toggle(rec);
    writeRec(sessionId, rec);
    if (rec.publicId) patchIndex(PUBLIC_INDEX(dir), rec.publicId, want ? sessionId : null);
    return out;
  }

  // Test/ops: number of records (excluding indexes).
  function _count() {
    if (USE_PG) return (async () => { await readyP(); return (await pgIds()).filter((id) => SESSION_RE.test(id)).length; })();
    try { return readdirSync(dir).filter((f) => f.startsWith("cs_") && f.endsWith(".json")).length; } catch { return 0; }
  }
  function _reset() {
    try { for (const f of readdirSync(dir)) unlinkSync(join(dir, f)); } catch { /* ignore */ }
    mem.clear(); negative.clear();
    if (USE_PG) return (async () => { await readyP(); await pgClear(); pub.idx = {}; pub.recs = new Map(); })();
  }

  return { createSession, fulfill, peek, recoverAbandoned, listIssues, setPublic, _count, _reset, ready: () => readyP(), backend: USE_PG ? "pg" : "file" };
}
