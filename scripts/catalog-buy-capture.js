// What the catalog buy keeps of each paid answer (scripts/catalog-buy.js), so
// the answers we pay for can improve our examples and our tools
// (scripts/catalog-buy-examples.js).
//
// Kept: the paid 200 JSON body, redacted and bounded, with the tool's grade,
// latency and the shape of its documented example. Never kept:
//   - anything naming the buyer or the payment: payer and receipt fields are
//     blanked, the burner's address is replaced wherever it appears, and a
//     transaction hash the example input did not name is replaced, as is one
//     this run settled and put into the input itself (ownTxs);
//   - an answer from a tool that names outside sellers or counterparties by
//     design (CAPTURE_DENY: the router tiers, seller and index tools, the
//     wallet-keyed reads);
//   - any answer that carries a URL host other than ours or the example input's
//     own hosts, or an EVM address the example input did not name (the guard
//     catches a tool the denylist does not).
// A dropped answer records only its reason, never the host or address that
// caused it, so the artifact and the job summary name no one.
//
// Pure functions, unit-tested offline by scripts/test-catalog-buy-examples.js.
import { trimExample } from "../src/tool-output-examples.js";

export const CAPTURE_MAX_BYTES = 24 * 1024;
export const OUR_HOSTS = ["agent402.tools"];

// Slugs whose answer names outside sellers, counterparties or wallets by design.
export const CAPTURE_DENY = new Set([
  // router tiers and anything that buys from an outside seller
  "route-execute", "route-execute-plus", "route-execute-pro", "route-execute-max", "seller-payability",
  // seller and index tools
  "seller-trust", "seller-dossier", "x402-market-pulse", "x402-trending", "x402-quote", "x402-verify", "x402-audit",
  "demand-radar", "bestsellers", "sellers-list",
  // wallet-keyed and identity-bound reads (the payer is the subject)
  "my-usage", "receipts", "attest", "feedback", "feedback-summary",
  "memory-write", "memory-read", "memory-incr", "memory-cas", "memory-grant", "memory-revoke", "memory-grants",
  "memory-log", "memory-remember", "memory-recall", "memory-forget",
]);
// Families matched by prefix, so a new member is denied without an edit here.
export const CAPTURE_DENY_PREFIXES = ["route-execute", "seller-", "x402-", "memory-", "sor-"];

export const isCaptureDenied = (slug) =>
  CAPTURE_DENY.has(slug) || CAPTURE_DENY_PREFIXES.some((p) => String(slug || "").startsWith(p));

// Keys whose value describes the payment or the request, not the tool's answer.
// The value is blanked, the key kept, so the key set stays comparable with the
// documented example.
export const REDACT_KEY_RE = /^(payer|payer_?address|payment|payment_?response|payment_?receipt|payment_?required|receipt|settlement|settlement_?tx|tx_?hash|transaction_?hash|request_?id|trace_?id|idempotency_?key|x-request-id|x-payment-response|payment-response|authorization)$/i;
export const REDACTED = "<redacted>";

const URL_HOST_RE = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
const BARE_HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const EVM_ADDR_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const TX_HASH_RE = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

const strings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
};

const norm = (host) => String(host || "").toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** The hosts an example input names: URL hosts and bare domain values. */
export function inputHosts(input) {
  const hosts = new Set();
  for (const s of strings(input)) {
    for (const m of s.matchAll(URL_HOST_RE)) hosts.add(norm(m[1]));
    if (BARE_HOST_RE.test(s.trim())) hosts.add(norm(s.trim()));
  }
  return hosts;
}

const allowedHost = (host, allowed) => {
  const h = norm(host);
  if (OUR_HOSTS.some((o) => h === o || h.endsWith(`.${o}`))) return true;
  for (const a of allowed) if (h === a || h.endsWith(`.${a}`)) return true;
  return false;
};

/** URL hosts in `body` that are neither ours nor the example input's own. */
export function foreignHosts(body, input) {
  const allowed = inputHosts(input);
  const out = new Set();
  for (const s of strings(body)) for (const m of s.matchAll(URL_HOST_RE)) if (!allowedHost(m[1], allowed)) out.add(norm(m[1]));
  return [...out];
}

/** EVM addresses in `body` the example input does not name. */
export function foreignAddresses(body, input) {
  const named = new Set(strings(input).flatMap((s) => (s.match(EVM_ADDR_RE) || []).map((a) => a.toLowerCase())));
  const out = new Set();
  for (const s of strings(body)) for (const a of s.match(EVM_ADDR_RE) || []) if (!named.has(a.toLowerCase())) out.add(a.toLowerCase());
  return [...out];
}

/**
 * Blank payment and request fields, replace the payer's address wherever it
 * appears, and replace transaction hashes the example input did not name.
 */
export function redactBody(body, { payer = null, input = null, ownTxs = [] } = {}) {
  const ours = new Set((ownTxs || []).map((t) => String(t).toLowerCase()));
  const namedTx = new Set(strings(input).flatMap((s) => (s.match(TX_HASH_RE) || []).map((t) => t.toLowerCase())).filter((t) => !ours.has(t)));
  const payerLc = payer ? String(payer).toLowerCase() : null;
  const scrub = (s) => {
    let out = s;
    if (payerLc && out.toLowerCase().includes(payerLc)) out = out.replace(new RegExp(payerLc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), REDACTED);
    return out.replace(TX_HASH_RE, (t) => (namedTx.has(t.toLowerCase()) ? t : REDACTED));
  };
  const walk = (v) => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[scrub(k)] = REDACT_KEY_RE.test(k) && x !== null && x !== undefined ? REDACTED : walk(x);
      return o;
    }
    return v;
  };
  return walk(body);
}

/** Bound a body to `maxBytes`: as is when it fits, else trimmed deterministically. */
export function boundBody(body, maxBytes = CAPTURE_MAX_BYTES) {
  const bytes = Buffer.byteLength(JSON.stringify(body ?? null), "utf8");
  if (bytes <= maxBytes) return { body, bytes, truncated: false };
  for (const s of [{ arrayItems: 20, stringChars: 4000, depth: 8 }, { arrayItems: 10, stringChars: 1500, depth: 6 }, { arrayItems: 3, stringChars: 300, depth: 5 }, { arrayItems: 1, stringChars: 120, depth: 3 }]) {
    const t = trimExample(body, s);
    if (Buffer.byteLength(JSON.stringify(t), "utf8") <= maxBytes) return { body: t, bytes, truncated: true };
  }
  return { body: null, bytes, truncated: true };
}

/** The documented example's shape, for comparison without republishing it. */
export function documentedShape(example, source) {
  const obj = example && typeof example === "object" && !Array.isArray(example);
  return {
    source,
    keys: obj ? Object.keys(example) : [],
    populatedArrays: obj ? Object.entries(example).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([k]) => k) : [],
    bytes: example === undefined ? 0 : Buffer.byteLength(JSON.stringify(example), "utf8"),
  };
}

/**
 * One capture record for one graded paid answer. `row` is the catalog row,
 * `graded` the graded result, `answer` { status, body, paid } from the paid
 * attempt. The record always carries the grade and the documented shape; the
 * body only when it survived the denylist, the redaction and both guards.
 */
export function captureRecord(row, graded, answer, { payer = null, maxBytes = CAPTURE_MAX_BYTES, ownTxs = [] } = {}) {
  const docEx = row.op?.responses?.["200"]?.content?.["application/json"]?.example;
  const docSource = row.op?.responses?.["200"]?.content?.["application/json"]?.["x-example-source"] ? "captured" : docEx === undefined || docEx === null || (typeof docEx === "object" && !Array.isArray(docEx) && !Object.keys(docEx).length) ? "none" : "hand-written";
  const input = row.example?.kind === "query" ? row.example.query : row.example?.kind === "json" ? row.example.body : row.example?.fields ?? null;
  const rec = {
    slug: row.slug, path: row.path, method: row.method, usd: row.usd, modelBacked: row.modelBacked === true,
    status: graded.status, grade: graded.grade, pass: graded.pass, ms: graded.ms,
    documented: documentedShape(docEx, docSource),
    captured: null, dropped: null,
  };
  if (!answer || answer.paid !== true || answer.status !== 200) { rec.dropped = "no-paid-200"; return rec; }
  if (!answer.body || typeof answer.body !== "object") { rec.dropped = "non-json"; return rec; }
  if (isCaptureDenied(row.slug)) { rec.dropped = "denylist"; return rec; }
  const redacted = redactBody(answer.body, { payer, input, ownTxs });
  if (foreignHosts(redacted, input).length) { rec.dropped = "foreign-host"; return rec; }
  if (foreignAddresses(redacted, input).length) { rec.dropped = "foreign-address"; return rec; }
  const b = boundBody(redacted, maxBytes);
  if (b.body === null) { rec.dropped = "too-large"; rec.bytes = b.bytes; return rec; }
  rec.captured = { bytes: b.bytes, truncated: b.truncated, body: b.body };
  return rec;
}
