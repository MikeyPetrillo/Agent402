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
// Storage: ONE FILE PER SESSION under a directory (atomic tmp+rename), so a poll
// never parses the whole store, a crash never corrupts every report, and two
// processes never overwrite each other's records. Tiny side indexes track
// in-flight claims and owed refunds so the boot sweep / operator view read a
// few bytes, not every report. A legacy single-file store is imported once.
// Rollout switch = STRIPE_SECRET_KEY (same key as the MPP gate). The key needs
// Checkout Sessions + Refunds write; it settles to your Stripe balance only.
import Stripe from "stripe";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sendReportReadyEmail } from "./email.js";

// The products the human door sells by card. The CARD price is not the agent
// price: Stripe takes 2.9% + $0.30 per charge, so a $1 charge nets $0.671 and a
// $2 charge nets $1.642. The card price must clear the fee AND the report's
// MEASURED worst-case upstream, which is $0.33 for one opus-5 synthesis and
// $1.20 for the three-synthesis pack (PostHog $ai_generation, 30 days: opus-5
// avg $0.107, p95 $0.195, max $0.311). A $1 card price left the deep tiers
// under water once the fee came out, so the floor is $2, $3 for the max tiers
// and $4 for the pack. Agents paying over x402 or MPP have no fixed fee and pay
// the tier price in the kit, which is set to the same measured worst case.
// cheap agent tools stay crypto/agent-only. `slug` maps to the paid endpoint's
// handler so humans and agents run the identical pipeline.
// The CARD ladder is DERIVED from the agent tier, never typed per product.
//
// Hand-setting it produced a storefront where Standard and Pro were both $2:
// three distinct agent tiers ($0.60 / $0.85 / $1.10) collapsed onto two card
// prices, so the page offered an upgrade that cost the same as not upgrading.
// Deriving it means the card ladder mirrors the work ladder by construction.
//
// The floor is set by Stripe, not by cost: 2.9% + $0.30 means a $1 charge nets
// $0.671, and the deep tiers eat most of that. Every rung below clears its
// measured worst-case upstream by well over 40% (scripts/test-report-margins.js).
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
export function readPublicReport(publicId, dir = DEFAULT_DIR()) {
  if (typeof publicId !== "string" || !PUBLIC_ID_RE.test(publicId)) return null;
  const idx = readJson(PUBLIC_INDEX(dir)) || {};
  const sessionId = Object.hasOwn(idx, publicId) ? idx[publicId] : null;
  if (!sessionId || !SESSION_RE.test(String(sessionId))) return null;
  const rec = readJson(join(dir, `${sessionId}.json`));
  if (!rec || rec.status !== "done" || rec.public !== true || rec.publicId !== publicId) return null;
  const productKey = Object.keys(HUMAN_PRODUCTS).find((k) => HUMAN_PRODUCTS[k].slug === rec.slug) || null;
  // Everything on a done record is the report itself; nothing buyer-identifying is stored on it.
  return { status: "done", publicView: true, publicId, product: productKey, kind: rec.kind, slug: rec.slug, input: rec.input, title: rec.title, report: rec.report, sources: rec.sources || [], tables: rec.tables || [], ...(rec.images ? { images: rec.images } : {}), at: rec.at, publishedAt: rec.publishedAt || null, priceUsd: productKey ? HUMAN_PRODUCTS[productKey].price / 100 : null };
}
export function listPublicReports(dir = DEFAULT_DIR()) {
  const idx = readJson(PUBLIC_INDEX(dir)) || {};
  const out = [];
  for (const [publicId, sessionId] of Object.entries(idx)) {
    if (!PUBLIC_ID_RE.test(publicId) || !SESSION_RE.test(String(sessionId))) continue;
    const rec = readJson(join(dir, `${sessionId}.json`));
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
const REFUND_RETRY_MS = 30_000;
const MAX_REFUND_ATTEMPTS = 6;
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
  const recPath = (id) => join(dir, `${id}.json`); // id already validated by SESSION_RE

  const mem = new Map();            // sessionId -> terminal record (bounded cache)
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

  const readRec = (id) => readJson(recPath(id));
  function writeRec(id, rec) {
    writeJsonAtomic(recPath(id), rec);
    if (rec.status === "done" || rec.status === "error") {
      if (mem.size >= MEM_CACHE_MAX) mem.delete(mem.keys().next().value);
      mem.set(id, rec);
    }
  }
  const readIndex = (p) => readJson(p) || {};
  function patchIndex(p, id, value) {
    const idx = readIndex(p);
    if (value === null) delete idx[id]; else idx[id] = value;
    writeJsonAtomic(p, idx);
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
      if (pi) { const r = await stripe.refunds.create({ payment_intent: typeof pi === "string" ? pi : pi.id }); return r.id; }
    } catch (e) { log(`[human-checkout] refund failed: ${String(e?.message || e).slice(0, 160)}`); }
    return null;
  }
  // Persist an error outcome; an unrefunded one is OWED (indexed, retried).
  function recordError(id, session, refundId, message) {
    const prev = readRec(id) || {};
    import("./posthog.js").then(({ capturePostHogHumanFunnel }) => capturePostHogHumanFunnel({ step: "failed", product: prev.slug || null, reason: refundId ? "refunded" : "refund-owed" })).catch(() => {});
    const rec = {
      status: "error", refundId,
      error: refundId ? `${message} Your payment has been refunded.` : `${message} Your refund is being processed.`,
      refundOwed: !refundId, refundAttempts: (prev.refundAttempts || 0) + 1, lastRefundAttemptAt: now(),
      paymentIntent: typeof session?.payment_intent === "string" ? session.payment_intent : session?.payment_intent?.id || null,
      at: new Date(now()).toISOString(),
    };
    writeRec(id, rec);
    patchIndex(INFLIGHT, id, null);
    patchIndex(ISSUES, id, refundId ? null : { kind: "refund-owed", at: rec.at, attempts: rec.refundAttempts });
    return rec;
  }
  // An owed refund is retried on later polls (bounded, paced).
  async function retryOwedRefund(id, rec) {
    if (!rec.refundOwed || rec.refundId) return rec;
    if ((rec.refundAttempts || 0) >= MAX_REFUND_ATTEMPTS) return rec;
    if (now() - (rec.lastRefundAttemptAt || 0) < REFUND_RETRY_MS) return rec;
    const refundId = await refundSession({ payment_intent: rec.paymentIntent });
    return recordError(id, { payment_intent: rec.paymentIntent }, refundId, rec.error.replace(/ Your refund is being processed\.$/, ""));
  }

  function startJob(sessionId, session, p, input, { takeover = 0 } = {}) {
    const claim = { status: "generating", kind: p.kind, slug: p.slug, at: new Date(now()).toISOString(), claimedAt: now(), takeovers: takeover, pid: process.pid };
    writeRec(sessionId, claim);
    patchIndex(INFLIGHT, sessionId, now());
    const job = (async () => {
      try {
        // generate() may return a plain report string (legacy / tests) or a
        // bundle { report, title, sources, tables }. Normalize either way.
        const g = await generate(p.kind, p.slug, input, { buyerKey: `human:${sessionId}`, rail: "card", priceUsd: Number(p.price) / 100 });
        const bundle = (g && typeof g === "object") ? g : { report: String(g ?? "") };
        if (!bundle.report) throw new Error("empty report");
        const rec = {
          status: "done", kind: p.kind, slug: p.slug, input,
          report: bundle.report,
          title: bundle.title || input,
          sources: Array.isArray(bundle.sources) ? bundle.sources : [],
          tables: Array.isArray(bundle.tables) ? bundle.tables : [],
          ...(Array.isArray(bundle.images) && bundle.images.length ? { images: bundle.images } : {}),
          at: new Date(now()).toISOString(),
        };
        writeRec(sessionId, rec);
        patchIndex(INFLIGHT, sessionId, null);
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
        return rec;
      } catch (err) {
        log(`[human-checkout] report failed for ${sessionId} (${p.slug}): ${String(err?.message || err).slice(0, 160)}`);
        const refundId = await refundSession(session);
        const failEmail = session.customer_details?.email || session.customer_email;
        if (failEmail) { try { onFailed?.({ email: failEmail, product: p.slug, label: p.label, refunded: Boolean(refundId) }); } catch { /* never breaks the refund path */ } }
        return recordError(sessionId, session, refundId, "We couldn't complete this report.");
      } finally { inFlight.delete(sessionId); }
    })();
    inFlight.set(sessionId, job);
  }

  // Idempotent, generate-once, refund-on-failure. Returns a status object the
  // page polls. NEVER generates without a verified-paid Stripe session.
  async function fulfill(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { status: "invalid" };
    const cached = mem.get(sessionId);
    if (cached) return cached.status === "error" ? retryOwedRefund(sessionId, cached) : cached;
    if (inFlight.has(sessionId)) return { status: "generating" };
    const disk = readRec(sessionId);
    if (disk && (disk.status === "done" || disk.status === "error")) {
      writeRec(sessionId, disk); // warms the memory cache
      return disk.status === "error" ? retryOwedRefund(sessionId, disk) : disk;
    }
    let takeover = 0;
    if (disk && disk.status === "generating") {
      const age = now() - (disk.claimedAt || Date.parse(disk.at) || 0);
      if (age < STALE_CLAIM_MS) return { status: "generating" };
      // Abandoned claim (restart mid-generation). One takeover regenerates;
      // a second abandonment means something is wrong with this job: refund.
      takeover = (disk.takeovers || 0) + 1;
      log(`[human-checkout] abandoned claim ${sessionId} (${Math.round(age / 1000)}s old, takeover #${takeover})`);
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
      const refundId = await refundSession(session);
      return recordError(sessionId, session, refundId, "This purchase is missing its report details.");
    }
    if (takeover > MAX_TAKEOVERS) {
      const refundId = await refundSession(session);
      return recordError(sessionId, session, refundId, "We couldn't complete this report after a retry.");
    }
    if (inFlight.has(sessionId)) return { status: "generating" };
    startJob(sessionId, session, p, input, { takeover });
    return { status: "generating" };
  }

  // Boot sweep: any claim left in the in-flight index by a previous process is
  // abandoned (the index is cleared on completion). Re-drive each through
  // fulfill() so it regenerates (or refunds) without waiting for a poll - the
  // buyer may have closed the tab. Bounded and sequential.
  async function recoverAbandoned({ limit = 10 } = {}) {
    const idx = readIndex(INFLIGHT);
    const ids = Object.keys(idx).filter((id) => SESSION_RE.test(id) && !inFlight.has(id)).slice(0, limit);
    const out = [];
    for (const id of ids) {
      const rec = readRec(id);
      if (!rec || rec.status !== "generating") { patchIndex(INFLIGHT, id, null); continue; }
      // Only claims older than the stale window are taken over; a fresh one may
      // belong to a process that is still running (another replica).
      if (now() - (rec.claimedAt || 0) < STALE_CLAIM_MS) continue;
      try { out.push({ id, result: (await fulfill(id)).status }); } catch (e) { out.push({ id, result: "error", error: String(e?.message || e).slice(0, 120) }); }
    }
    if (out.length) log(`[human-checkout] recovered ${out.length} abandoned claim(s): ${out.map((o) => `${o.id}=${o.result}`).join(", ")}`);
    return out;
  }

  // Operator view: what needs a human - owed refunds, stuck claims.
  function listIssues() {
    const inflight = readIndex(INFLIGHT);
    const issues = readIndex(ISSUES);
    const stuck = Object.entries(inflight).map(([id, at]) => ({ id, claimedAt: new Date(at).toISOString(), ageMs: now() - at, stale: now() - at >= STALE_CLAIM_MS }));
    const owed = Object.entries(issues).map(([id, v]) => ({ id, ...v }));
    return { inflight: stuck, refundOwed: owed, storeDir: dir };
  }

  function peek(sessionId) {
    const rec = mem.get(sessionId) || (SESSION_RE.test(String(sessionId)) ? readRec(sessionId) : null);
    if (rec) return rec;
    if (inFlight.has(sessionId)) return { status: "generating" };
    return null;
  }

  // Buyer toggle: make a delivered report public (mint the public id once) or
  // private again (the id stays reserved and dead: a revoked link never
  // resolves, and a re-publish reuses it so old links work again).
  function setPublic(sessionId, flag) {
    if (typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) return { status: "invalid" };
    const rec = mem.get(sessionId) || readRec(sessionId);
    if (!rec || rec.status !== "done") return { status: rec?.status || "not_found" };
    const want = flag === true;
    if (want && !rec.publicId) rec.publicId = `rp_${randomBytes(12).toString("base64url")}`;
    rec.public = want;
    if (want) rec.publishedAt = new Date(now()).toISOString();
    writeRec(sessionId, rec);
    if (rec.publicId) patchIndex(PUBLIC_INDEX(dir), rec.publicId, want ? sessionId : null);
    return { status: "done", public: want, publicId: want ? rec.publicId : null };
  }

  // Test/ops: number of records on disk (excluding indexes).
  function _count() { try { return readdirSync(dir).filter((f) => f.startsWith("cs_") && f.endsWith(".json")).length; } catch { return 0; } }
  function _reset() { try { for (const f of readdirSync(dir)) unlinkSync(join(dir, f)); } catch { /* ignore */ } mem.clear(); negative.clear(); }

  return { createSession, fulfill, peek, recoverAbandoned, listIssues, setPublic, _count, _reset };
}
