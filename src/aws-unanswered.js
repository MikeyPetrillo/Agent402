// The record of AWS Marketplace payments that bought no answer.
//
// AWS Marketplace captures a payment when it issues the buyer's payment
// token, before the request reaches this server, and has no seller refund
// call (src/aws-marketplace-gate.js). A paid call whose last attempt ends
// without a delivered answer is therefore recorded here, for the operator's
// review and any billing adjustment made through AWS Marketplace. Each entry
// holds exactly what /aws/start and /terms say is recorded: the payment id,
// the tool, the time, the status the last attempt ended with and why (the
// tool failed, or the connection closed before the answer), and the list
// price. No buyer id, address or input is kept.
//
// The record is one JSON document (src/json-document.js): the state database
// row when one is configured, a file otherwise, so a deploy keeps it. It is
// bounded: the newest AWS_UNANSWERED_MAX entries, and none older than
// AWS_UNANSWERED_KEEP_DAYS. Read by /__operator/aws.json only.
import { createJsonDocument } from "./json-document.js";

export const AWS_UNANSWERED_DOC = "aws-unanswered";
export const AWS_UNANSWERED_MAX = 2000;
export const AWS_UNANSWERED_KEEP_DAYS = 400;
/** Why a paid run ended without an answer. */
export const AWS_UNANSWERED_REASONS = Object.freeze({ tool: "tool_error", closed: "connection_closed" });

const ID = /^[\x21-\x7e]{1,200}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One entry from what the gate knows, or null when it cannot be recorded. */
export function unansweredEntry({ at, paymentId, slug, status, priceUsd }) {
  const id = String(paymentId ?? "");
  const s = String(slug ?? "");
  if (!ID.test(id) || !SLUG.test(s)) return null;
  const code = Number(status);
  const st = Number.isInteger(code) && code >= 100 && code < 600 ? code : 500;
  const price = Number(priceUsd);
  return {
    at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
    paymentId: id,
    slug: s,
    status: st,
    reason: st === 499 ? AWS_UNANSWERED_REASONS.closed : AWS_UNANSWERED_REASONS.tool,
    priceUsd: Number.isFinite(price) && price >= 0 ? price : null,
  };
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
    /** Record one entry; resolves true when the store took it. Never throws. */
    async record(fields) {
      const entry = unansweredEntry({ ...fields, at: fields?.at ?? now() });
      if (!entry) return false;
      try {
        const r = await store.update((b) => {
          const entries = bounded(b && typeof b === "object" ? b.entries : [], now(), max - 1);
          // One entry per payment: a second record of the same id replaces it.
          return { entries: [...entries.filter((e) => e.paymentId !== entry.paymentId), entry] };
        }, { fallback: { entries: [] } });
        if (r && r.ok) return true;
        throw new Error(String(r?.error?.message || r?.error || "write refused"));
      } catch (e) {
        try { log(`[aws-marketplace] the record of a paid call without an answer was not saved (payment ${entry.paymentId}, ${entry.slug}): ${String(e?.message || e).slice(0, 160)}`); } catch { /* never throws */ }
        return false;
      }
    },
    /** The entries, oldest first: { ok, entries } (ok false when the store could not be read). */
    async list() {
      try {
        const r = await store.read({ quiet: true });
        if (!r || !r.ok) return { ok: false, entries: [] };
        return { ok: true, entries: bounded(r.body && typeof r.body === "object" ? r.body.entries : [], now(), max) };
      } catch {
        return { ok: false, entries: [] };
      }
    },
  };
}
