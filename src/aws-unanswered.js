// The record of AWS Marketplace payments that bought no answer.
//
// AWS Marketplace captures a payment when it issues the buyer's payment
// token, before the request reaches this server, and has no seller refund
// call (src/aws-marketplace-gate.js). EVERY paid attempt that ends without a
// delivered answer is therefore recorded here at once (a failed run, or a
// connection closed before the answer, on any attempt), with whether the
// payment can still be retried: attempts left and the payment's validity.
// A later attempt that is served marks the entry answered; the operator's
// review marks it reviewed. An entry that is neither, whose payment can no
// longer be retried, reads owed past a notice (awsUnansweredWord, folded into
// refundsOwed on /api/gateway-status), for the operator's review and any
// billing adjustment made through AWS Marketplace. Each entry holds exactly
// what AWS_UNANSWERED_SENTENCE (printed by /aws/start and /terms) says: the
// payment id, the tool, the times, the status the last attempt ended with and
// why (the tool failed, or the connection closed before the answer), the
// attempts made and left, the payment's validity and the list price. No buyer
// id, address or input is kept.
//
// The record is one JSON document (src/json-document.js): the state database
// row when one is configured, a file otherwise (AWS_UNANSWERED_FILE), so a
// deploy keeps it. It is bounded: the newest AWS_UNANSWERED_MAX entries, and
// none older than AWS_UNANSWERED_KEEP_DAYS. Read by /__operator/aws.json.
import { createJsonDocument, SKIP_UPDATE } from "./json-document.js";
export { AWS_UNANSWERED_SENTENCE } from "./aws-unanswered-copy.js";

export const AWS_UNANSWERED_DOC = "aws-unanswered";
export const AWS_UNANSWERED_MAX = 2000;
export const AWS_UNANSWERED_KEEP_DAYS = 400;
/** Why a paid run ended without an answer. */
export const AWS_UNANSWERED_REASONS = Object.freeze({ tool: "tool_error", closed: "connection_closed" });

const ID = /^[\x21-\x7e]{1,200}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One entry from what the gate knows, or null when it cannot be recorded. */
export function unansweredEntry({ at, paymentId, slug, status, priceUsd, attemptsLeft = 0, retryUntilMs = null }) {
  const id = String(paymentId ?? "");
  const s = String(slug ?? "");
  if (!ID.test(id) || !SLUG.test(s)) return null;
  const code = Number(status);
  const st = Number.isInteger(code) && code >= 100 && code < 600 ? code : 500;
  const price = Number(priceUsd);
  const left = Number(attemptsLeft);
  const until = Number(retryUntilMs);
  const iso = new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
  return {
    at: iso,
    lastAt: iso,
    paymentId: id,
    slug: s,
    status: st,
    reason: st === 499 ? AWS_UNANSWERED_REASONS.closed : AWS_UNANSWERED_REASONS.tool,
    priceUsd: Number.isFinite(price) && price >= 0 ? price : null,
    attempts: 1,
    attemptsLeft: Number.isInteger(left) && left > 0 ? left : 0,
    retryUntil: Number.isFinite(until) && until > 0 ? new Date(until).toISOString() : null,
    resolved: null,
    resolvedAt: null,
  };
}

/** When an unresolved entry's payment stopped being retryable (ms), or null while it still is. */
function dueAt(e, now) {
  if (e.resolved) return null;
  const last = Date.parse(e.lastAt || e.at);
  if (!(Number(e.attemptsLeft) > 0)) return last;
  const until = Date.parse(e.retryUntil || "");
  if (!Number.isFinite(until)) return last;
  return until <= now ? until : null;
}

/** An entry as read: `retryable` while it is unresolved, has attempts left and its payment is valid. */
function withStanding(e, now) {
  const until = Date.parse(e.retryUntil || "");
  return {
    ...e,
    lastAt: e.lastAt || e.at,
    attempts: Number(e.attempts) || 1,
    attemptsLeft: Number(e.attemptsLeft) || 0,
    retryUntil: e.retryUntil || null,
    resolved: e.resolved || null,
    resolvedAt: e.resolvedAt || null,
    retryable: !e.resolved && Number(e.attemptsLeft) > 0 && Number.isFinite(until) && until > now,
  };
}

/**
 * The record's word: none, owed (an unresolved entry whose payment can no
 * longer be retried, past `noticeMinutes`), aging (one past `owedHours`), or
 * unknown when the record could not be read (`entries` null). Counts for the
 * operator.
 */
export function awsUnansweredWord(entries, { now = Date.now(), noticeMinutes = 15, owedHours = 48 } = {}) {
  if (!Array.isArray(entries)) return { status: "unknown", owed: null, aging: null, retryable: null, unresolved: null };
  let owed = 0, aging = 0, retryable = 0, unresolved = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || raw.resolved) continue;
    unresolved++;
    const e = withStanding(raw, now);
    if (e.retryable) { retryable++; continue; }
    const due = dueAt(raw, now);
    if (due == null) continue;
    if (now - due >= noticeMinutes * 60_000) owed++;
    if (now - due >= owedHours * 3_600_000) aging++;
  }
  return { status: aging ? "aging" : owed ? "owed" : "none", owed, aging, retryable, unresolved };
}

function bounded(entries, now, max) {
  const floor = now - AWS_UNANSWERED_KEEP_DAYS * 86_400_000;
  const kept = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === "object" && Date.parse(e.at) >= floor);
  return kept.length > max ? kept.slice(kept.length - max) : kept;
}

export function createAwsUnansweredBook({
  file = process.env.AWS_UNANSWERED_FILE || "/data/aws-unanswered.json",
  doc = null,
  now = () => Date.now(),
  max = AWS_UNANSWERED_MAX,
  log = (m) => console.warn(m),
} = {}) {
  const store = doc || createJsonDocument({ name: AWS_UNANSWERED_DOC, file, log: () => {} });
  return {
    /** Record one unanswered attempt (the first, or a later one of the same
     *  payment, which updates its entry); resolves true when the store took it. Never throws. */
    async record(fields) {
      const entry = unansweredEntry({ ...fields, at: fields?.at ?? now() });
      if (!entry) return false;
      try {
        const r = await store.update((b) => {
          const entries = bounded(b && typeof b === "object" ? b.entries : [], now(), max - 1);
          // One entry per payment: a later attempt updates it, keeping its first time.
          const prior = entries.find((e) => e.paymentId === entry.paymentId);
          const next = prior ? { ...entry, at: prior.at, attempts: (Number(prior.attempts) || 1) + 1 } : entry;
          return { entries: [...entries.filter((e) => e.paymentId !== entry.paymentId), next] };
        }, { fallback: { entries: [] } });
        if (r && r.ok) return true;
        throw new Error(String(r?.error?.message || r?.error || "write refused"));
      } catch (e) {
        try { log(`[aws-marketplace] the record of a paid call without an answer was not saved (payment ${entry.paymentId}, ${entry.slug}): ${String(e?.message || e).slice(0, 160)}`); } catch { /* never throws */ }
        return false;
      }
    },
    /** Mark an unresolved entry answered ("served") or "reviewed"; true when one was. Never throws. */
    async resolve(paymentId, how) {
      const id = String(paymentId ?? "");
      const kind = how === "served" ? "served" : how === "reviewed" ? "reviewed" : null;
      if (!ID.test(id) || !kind) return false;
      let changed = false;
      try {
        const r = await store.update((b) => {
          changed = false; // the mutation may run again on a write conflict
          const entries = bounded(b && typeof b === "object" ? b.entries : [], now(), max);
          const next = entries.map((e) => {
            if (e.paymentId !== id || e.resolved) return e;
            changed = true;
            return { ...e, resolved: kind, resolvedAt: new Date(now()).toISOString() };
          });
          return changed ? { entries: next } : SKIP_UPDATE;
        }, { fallback: { entries: [] } });
        return !!(r && r.ok) && changed;
      } catch (e) {
        try { log(`[aws-marketplace] the record of payment ${id} could not be marked ${kind}: ${String(e?.message || e).slice(0, 160)}`); } catch { /* never throws */ }
        return false;
      }
    },
    /** The entries, oldest first: { ok, entries } (ok false when the store could not be read). */
    async list() {
      try {
        const r = await store.read({ quiet: true });
        if (!r || !r.ok) return { ok: false, entries: [] };
        const t = now();
        return { ok: true, entries: bounded(r.body && typeof r.body === "object" ? r.body.entries : [], t, max).map((e) => withStanding(e, t)) };
      } catch {
        return { ok: false, entries: [] };
      }
    },
  };
}
