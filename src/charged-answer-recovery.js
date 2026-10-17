// A charged answer stays deliverable: when a paid request settles but its
// buyer is gone before the answer arrives, the answer is kept, and a retry
// that carries the SAME signed payment for the same route and the same input
// is served that answer with 200 and the original receipt, settling nothing.
//
// Why: @x402/express runs the handler, then settles, then writes the buffered
// answer. A buyer whose connection closes in between (a client timeout shorter
// than the run, a close during the settle call itself, a hang-up past the
// forgiveness budget in src/hangup-forgiveness.js, a route whose effect
// outlives the answer) has paid and received nothing, and until now the only
// remedy was a refund-ledger debt. The signed payment is single-use, so a
// resend of it could only be refused (src/replay-guard.js answers 409). With
// the answer kept, the resend is how the buyer collects what it paid for.
//
// Identity. A record is keyed on the payment credential exactly as the buyer
// sent it: the x402 header (PAYMENT-SIGNATURE, else X-PAYMENT, the same order
// the middleware settles from, src/payer.js) or an MPP `Authorization:
// Payment` credential. Every rail's credential is single-use (an EIP-3009 or
// Permit2 nonce, a signed Solana/Stellar/Algorand transaction, a Tempo
// transfer, a Stripe token), so the header bytes name one payment. A prepaid
// credits key is reusable and names no single payment: credits use the
// Idempotency-Key cache (src/idempotency.js) instead.
//
// Binding. The record also binds the method, the full request URL (path and
// query) and a hash of the parsed body, and serves only an exact match. A
// settled authorization becomes readable on chain, so the credential alone is
// not a secret; the input is the second factor. For that reason the
// identity-bound routes (memory, my-usage, attest, receipts, feedback, whose
// answers are the payer's own records) are never kept here: their retry path
// is the Idempotency-Key cache, whose key the client chooses and never
// publishes.
//
// Storage. Redis (REDIS_URL, the shared client) when reachable, always mirrored
// in this process, so a Redis outage keeps what this process stored. Keys and
// bindings are HMACs under a server secret (CHARGED_ANSWER_SECRET, else
// POW_SECRET, else MPP_SECRET_KEY), and the answer is sealed with AES-256-GCM
// under a key derived from the secret, the credential and the binding: a
// reader of the store holds neither. Without a stable secret the records still
// work inside one process. Each body is capped (CHARGED_ANSWER_MAX_BYTES), the
// local mirror is capped in total, and Redis is capped per UTC day; a record
// lives CHARGED_ANSWER_TTL_MS (24 h).
//
// What is kept: a 200 whose settlement is proven (the caller's evidenceOf:
// a PAYMENT-RESPONSE with success:true, or the Tempo/Stripe gate's own settled
// flag), not a stream (text/event-stream is cut once it starts; it keeps
// today's behavior), and whose buyer was gone before the response finished
// (closed before the first byte, or closed while the body was being written).
// A delivered answer is never kept.
//
// A retry, in order: a kept answer that matches -> replayed (200, the original
// status line, content type and receipt headers, X-Payment-Recovered: true);
// the original request is still finishing (its buyer left and it has not
// ended) -> 409 with Retry-After; anything else -> on to the payment gates,
// which treat it exactly as before (a spent authorization is refused).
//
// Delivery is recorded. When a replay's response finishes, onDelivered runs
// with the settlement evidence, and the server voids the refund-ledger debt
// the hang-up booked for it ("delivered on retry"), so an answer the buyer
// received is never also refunded.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSharedRedisClient } from "./shared-limit.js";
import { paymentHeaderOf } from "./payer.js";

const envNum = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
export const RECOVERY_TTL_MS = envNum("CHARGED_ANSWER_TTL_MS", 24 * 60 * 60 * 1000);
export const RECOVERY_MAX_BODY_BYTES = envNum("CHARGED_ANSWER_MAX_BYTES", 4 * 1024 * 1024);
const LOCAL_MAX_BYTES = envNum("CHARGED_ANSWER_LOCAL_MAX_BYTES", 64 * 1024 * 1024);
const LOCAL_MAX_ENTRIES = 5000;
const REDIS_DAY_MAX_BYTES = envNum("CHARGED_ANSWER_REDIS_DAY_MAX_BYTES", 512 * 1024 * 1024);
// The original request after its buyer left: past any run plus settle.
const PENDING_TTL_SECONDS = 300;
export const RETRY_AFTER_SECONDS = 3;
const PREFIX = "answer:";
const REDIS_OP_MS = 1_000;
// The note recordHangupDebt writes on a debt whose answer was kept; the refund
// planner (scripts/refund-run.js) holds such a row until the window closes.
export const KEPT_NOTE_PREFIX = "answer kept for a retry with the same payment";
export const DELIVERED_NOTE = "delivered on retry: the kept answer was served to the same payment";
// Response headers a replay restores. Content-Length and Content-Encoding are
// left to the stack (compression runs outside this module).
const KEEP_HEADERS = ["content-type", "payment-response", "x-payment-response", "payment-receipt", "x-metered-usd"];

export function recoveryEnabled() {
  return String(process.env.CHARGED_ANSWER_RECOVERY || "").trim().toLowerCase() !== "off";
}

let processSecret = null;
function secret() {
  const s = String(process.env.CHARGED_ANSWER_SECRET || process.env.POW_SECRET || process.env.MPP_SECRET_KEY || "").trim();
  if (s) return s;
  processSecret ??= randomBytes(32).toString("hex");
  return processSecret;
}
const hmac = (...parts) => createHmac("sha256", secret()).update(parts.join("\n")).digest();

/** The single-use payment credential this request carries, as sent, or null.
 *  Own read of the raw headers at arrival, before any shim rewrites them. */
export function paymentCredentialOf(req) {
  const x402 = paymentHeaderOf(req);
  if (typeof x402 === "string" && x402) return { kind: "x402", raw: x402 };
  const auth = req?.headers?.authorization;
  if (typeof auth === "string" && /^Payment\s+\S/i.test(auth)) return { kind: "mpp", raw: auth.trim() };
  return null;
}

/** The input binding: method, full URL and parsed body. */
export function requestBindingOf(req) {
  let body = "-";
  try { if (req.body && typeof req.body === "object" && Object.keys(req.body).length) body = JSON.stringify(req.body); else if (typeof req.body === "string" && req.body) body = req.body; } catch { body = "?"; }
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${req.method} ${req.originalUrl || req.url}\n${bodyHash}`;
}

function idOf(cred) { return hmac("rec", cred.kind, cred.raw).toString("hex"); }
function bindingTag(cred, binding) { return hmac("bind", cred.kind, cred.raw, binding).toString("hex"); }
function seal(cred, binding, plain) {
  const key = hmac("key", cred.kind, cred.raw, binding);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
function unseal(cred, binding, rec) {
  const key = hmac("key", cred.kind, cred.raw, binding);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(rec.iv, "base64"));
  d.setAuthTag(Buffer.from(rec.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(rec.ct, "base64")), d.final()]);
}
const sameHex = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The store: Redis when reachable, always mirrored in this process. */
export function createRecoveryStore({ redis = getSharedRedisClient, ttlMs = RECOVERY_TTL_MS, localMaxBytes = LOCAL_MAX_BYTES, redisDayMaxBytes = REDIS_DAY_MAX_BYTES } = {}) {
  const local = new Map(); // id -> { at, rec, bytes }
  const pending = new Map(); // id -> until
  let localBytes = 0;
  const client = async () => { try { return await redis(); } catch { return null; } };
  const op = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("redis op timeout")), REDIS_OP_MS);
    t.unref?.();
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  const localGet = (id) => {
    const hit = local.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at >= ttlMs) { localBytes -= hit.bytes; local.delete(id); return null; }
    return hit.rec;
  };
  const localPut = (id, rec, bytes) => {
    const old = local.get(id);
    if (old) { localBytes -= old.bytes; local.delete(id); }
    while ((local.size >= LOCAL_MAX_ENTRIES || localBytes + bytes > localMaxBytes) && local.size) {
      const k = local.keys().next().value; const v = local.get(k); localBytes -= v.bytes; local.delete(k);
    }
    if (bytes > localMaxBytes) return;
    local.set(id, { at: Date.now(), rec, bytes });
    localBytes += bytes;
  };
  return {
    async get(id) {
      const c = await client();
      if (c) {
        try { const raw = await op(c.get(PREFIX + "r:" + id)); if (raw != null) return JSON.parse(raw); } catch { /* the local mirror below */ }
      }
      return localGet(id);
    },
    async put(id, rec) {
      const json = JSON.stringify(rec);
      const bytes = Buffer.byteLength(json);
      localPut(id, rec, bytes);
      const c = await client();
      if (!c) return "local";
      try {
        const day = PREFIX + "bytes:" + new Date().toISOString().slice(0, 10);
        const used = Number(await op(c.incrBy(day, bytes)));
        await op(c.expire(day, 2 * 86_400));
        if (used > redisDayMaxBytes) return "local"; // the day's shared budget is spent: this process still holds it
        await op(c.set(PREFIX + "r:" + id, json, { PX: ttlMs }));
        return "shared";
      } catch { return "local"; }
    },
    async markPending(id) {
      pending.set(id, Date.now() + PENDING_TTL_SECONDS * 1000);
      const c = await client();
      if (c) { try { await op(c.set(PREFIX + "p:" + id, "1", { EX: PENDING_TTL_SECONDS })); } catch { /* local only */ } }
    },
    async clearPending(id) {
      pending.delete(id);
      const c = await client();
      if (c) { try { await op(c.del(PREFIX + "p:" + id)); } catch { /* it lapses */ } }
    },
    async isPending(id) {
      const until = pending.get(id);
      if (until && until > Date.now()) return true;
      if (until) pending.delete(id);
      const c = await client();
      if (c) { try { return (await op(c.get(PREFIX + "p:" + id))) != null; } catch { /* local answer */ } }
      return false;
    },
    size() { return local.size; },
  };
}

const counters = { kept: 0, keptShared: 0, replayed: 0, delivered: 0, inFlight409: 0, mismatched: 0, tooLarge: 0 };
/** Counts for the operator surface. */
export function recoveryStatus() {
  return { enabled: recoveryEnabled(), ttlHours: Math.round((RECOVERY_TTL_MS / 3_600_000) * 100) / 100, maxBodyBytes: RECOVERY_MAX_BODY_BYTES, ...counters };
}

/** True when this request is a replay of a kept answer (it settles and owes nothing). Own property only. */
export function isRecoveryReplay(req) {
  return !!req && typeof req === "object" && Object.hasOwn(req, "__a402RecoveryReplay") && req.__a402RecoveryReplay === true;
}
/** When this request's answer was kept for a retry: { untilMs } or null. Own property only. */
export function answerKeptFor(req) {
  return req && typeof req === "object" && Object.hasOwn(req, "__a402AnswerKept") ? req.__a402AnswerKept : null;
}

/**
 * @param {object} o
 * @param {(req) => ({ slug: string, identityBound?: boolean } | null)} o.routeOf  the catalog route, or null
 * @param {(req, res) => ({ tx: string | null } | null)} o.evidenceOf  proof the charge settled, or null
 * @param {(info: { tx: string | null, slug: string, req }) => void} [o.onDelivered]
 * @param {(info: { slug: string, req, where: string }) => void} [o.onKept]
 */
export function createChargedAnswerRecovery({ routeOf, evidenceOf, onDelivered = () => {}, onKept = () => {}, store = createRecoveryStore(), maxBodyBytes = RECOVERY_MAX_BODY_BYTES, log = console } = {}) {
  return async function chargedAnswerRecovery(req, res, next) {
    if (!recoveryEnabled() || req.method === "HEAD" || req.method === "OPTIONS") return next();
    let route = null, cred = null;
    try { route = routeOf(req); cred = route && !route.identityBound ? paymentCredentialOf(req) : null; } catch { return next(); }
    if (!route || !cred) return next();
    const binding = requestBindingOf(req);
    const id = idOf(cred);
    const tag = bindingTag(cred, binding);

    // ---- a retry: a kept answer, or the original still finishing
    let rec = null;
    try { rec = await store.get(id); } catch { rec = null; }
    if (rec && rec.v === 1) {
      if (sameHex(rec.b, tag)) {
        let kept = null;
        try { kept = JSON.parse(unseal(cred, binding, rec).toString("utf8")); } catch { kept = null; }
        if (kept && typeof kept.body === "string") {
          counters.replayed++;
          Object.defineProperty(req, "__a402RecoveryReplay", { value: true, enumerable: false, configurable: true });
          for (const [k, v] of Object.entries(kept.headers || {})) { if (KEEP_HEADERS.includes(k) && typeof v === "string") res.setHeader(k, v); }
          res.setHeader("X-Payment-Recovered", "true");
          res.setHeader("Cache-Control", "no-store, private");
          res.on("finish", () => {
            if (res.statusCode !== 200) return;
            counters.delivered++;
            log.warn?.(`[recovery] DELIVERED ON RETRY: a kept answer was served to the same payment (${req.method} ${req.path} tx=${kept.tx || "?"})`);
            try { onDelivered({ tx: kept.tx || null, slug: kept.slug || route.slug, req }); } catch { /* bookkeeping only */ }
          });
          res.status(200);
          return res.end(Buffer.from(kept.body, "base64"));
        }
      } else {
        counters.mismatched++;
      }
      // A different route or input with this payment: the gates refuse it as before.
      return next();
    }
    let pendingNow = false;
    try { pendingNow = await store.isPending(id); } catch { pendingNow = false; }
    if (pendingNow) {
      counters.inFlight409++;
      res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
      return res.status(409).json({
        error: "payment_settling",
        hint: `The first request with this payment is still finishing. Retry the same request with the same payment in ${RETRY_AFTER_SECONDS} s to receive its answer; nothing was charged for this request.`,
      });
    }

    // ---- a first use: watch for a buyer who leaves before the answer finishes
    const chunks = [];
    let size = 0, overflow = false, markedPending = false, decided = false, goneBeforeEnd = false;
    const take = (chunk, enc) => {
      if (overflow || chunk == null || typeof chunk === "function") return;
      let b;
      try { b = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof enc === "string" ? enc : "utf8"); } catch { overflow = true; return; }
      size += b.length;
      if (size > maxBodyBytes) { overflow = true; chunks.length = 0; return; }
      chunks.push(b);
    };
    res.once("close", () => {
      if (res.writableFinished) return;
      if (!res.writableEnded) {
        goneBeforeEnd = true;
        markedPending = true;
        store.markPending(id).catch(() => {});
      }
    });
    const keep = (snapshot) => {
      const headers = {};
      for (const k of KEEP_HEADERS) { const v = res.getHeader(k); if (v != null) headers[k] = String(v); }
      const plain = Buffer.from(JSON.stringify({ body: snapshot.body.toString("base64"), headers, tx: snapshot.tx, slug: route.slug }), "utf8");
      const rec = { v: 1, b: tag, at: Date.now(), ...seal(cred, binding, plain) };
      store.put(id, rec).then((where) => {
        counters.kept++;
        if (where === "shared") counters.keptShared++;
        log.warn?.(`[recovery] ANSWER KEPT: the buyer left before a settled answer arrived; a retry with the same payment receives it (${req.method} ${req.path} tx=${snapshot.tx || "?"}, ${where})`);
        try { onKept({ slug: route.slug, req, where }); } catch { /* bookkeeping only */ }
      }).catch(() => {}).finally(() => { if (markedPending) store.clearPending(id).catch(() => {}); });
    };
    const decide = () => {
      if (res.statusCode !== 200) return null;
      if (overflow) { counters.tooLarge++; return null; }
      if (/event-stream/i.test(String(res.getHeader("content-type") || ""))) return null;
      let ev = null;
      try { ev = evidenceOf(req, res); } catch { ev = null; }
      if (!ev) return null;
      return { tx: ev.tx || null };
    };
    const innerWrite = res.write;
    const innerEnd = res.end;
    res.write = function recoveryWrite(chunk, enc, cb) { take(chunk, enc); return innerWrite.apply(this, arguments); };
    res.end = function recoveryEnd(chunk, enc, cb) {
      if (decided) return innerEnd.apply(this, arguments);
      decided = true;
      if (typeof chunk !== "function") take(chunk, enc);
      const verdict = decide();
      const gone = verdict && (goneBeforeEnd || Object.hasOwn(req, "__a402ClientGoneAt"));
      // Before the inner end: the hang-up recorder (inner) books the debt and
      // notes that the answer is kept, so the refund planner waits for a retry.
      if (gone) Object.defineProperty(req, "__a402AnswerKept", { value: { untilMs: Date.now() + RECOVERY_TTL_MS }, enumerable: false, configurable: true });
      const out = innerEnd.apply(this, arguments);
      if (verdict) {
        const snapshot = { body: Buffer.concat(chunks), tx: verdict.tx };
        if (gone) keep(snapshot);
        else res.once("close", () => { if (!res.writableFinished) keep(snapshot); }); // cut while the body was being written
      }
      if (!verdict && markedPending) store.clearPending(id).catch(() => {});
      return out;
    };
    next();
  };
}

/** Test-only. */
export function __resetRecoveryCounters() { for (const k of Object.keys(counters)) counters[k] = 0; }
