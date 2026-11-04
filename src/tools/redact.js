// redactSecrets — scrub configured secret VALUES out of upstream-derived text
// before it can reach a buyer-facing error message.
//
// The paid kits deliberately relay an upstream 4xx error message (parsed
// error.message or a 200-char body slice) so agents can self-correct — but
// that text comes from the upstream, and an upstream CAN echo the credential
// we sent it (OpenAI's real invalid_api_key message quotes the key; a
// misbehaving or compromised upstream could echo it on any status). The route
// binder returns err.message, so anything a handler throws is buyer-visible
// AND logged; it runs this on every status before either. This helper makes
// the relay categorically safe: any occurrence of a configured secret value is
// replaced with "[redacted]", everything else passes through unchanged.
//
// Scope: every env var whose NAME looks secret-bearing (KEY/TOKEN/SECRET/
// PASSWORD/MNEMONIC/PRIVATE). Values shorter than 8 chars are skipped — real
// keys are longer, and redacting tiny values would mangle innocent substrings.
//
// Connection strings and URLs carry credentials under names that say URL:
// a database or Redis URL (*DATABASE_URL, *REDIS_URL) is redacted whole.
// Any other *_URL value (or each entry of a comma or space separated list)
// gives up only the parts that carry a credential: its password (or a
// credential-looking username), a credential-named or credential-looking
// query value, and a credential-looking path segment (looksLikeCredential:
// a known key shape, or a long run mixing letters with digits, or a long
// random-looking run). The rest of the URL, a docs link included, stays
// readable. A `scheme://user:password@` in the text itself loses its
// password even when no variable names it.
//
// RPC endpoints carry their key in the path (https://host/v2/<key>) as often
// as in the query, so every *_RPC, *_RPCS, *_RPC_URL and *_RPC_URLS entry is
// redacted whole, along with each long path segment and every query value.
// Each secret's base64 form (alone and as `value:`), its percent-encoded and
// hex forms (either case) and its JSON-escaped-slash form are redacted too,
// and a `Basic <credentials>` token in the text loses its credentials whatever
// variable they came from. *_SALT values count as secrets.
import { stripHiddenCharacters } from "../hidden-chars.js";

const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|MNEMONIC|PRIVATE|SALT)/i;
const URL_NAME_RE = /URLS?$/i;
const RPC_NAME_RE = /RPCS?(_URLS?)?$/i;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_-]{16,}$/;
const BASIC_IN_TEXT_RE = /\b(Basic\s+)([A-Za-z0-9+/]{8,1024}={0,2})(?![A-Za-z0-9+/=])/gi;
// An encoded `user:password` is a whole number of 4-character groups and is
// not a plain word ("Basic authentication", "Basic arithmetic").
const looksLikeBase64Token = (t) => t.length % 4 === 0 && /[0-9+/=]|.[A-Z]/.test(t);
const DB_URL_NAME_RE = /(DATABASE|REDIS|POSTGRES|PG|MONGO|AMQP)_?URLS?$/i;
const CREDENTIAL_PARAM_RE = /^(key|api[-_]?key|apikey|token|access[-_]?token|auth|secret|password|pass|sig|signature|x-api-key)$/i;
// Bounded parts, so the scan is linear: error text can carry a caller's input
// (100 KB of "a.a.a..." once took seconds with an unbounded scheme).
const USERINFO_IN_TEXT_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}:)([^\s@/]{1,256})@/gi;
const MIN_SECRET_LEN = 8;

// Known key shapes: provider prefixes, a JWT, a UUID.
const KEY_SHAPE_RE = /^(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}$|^(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abpres])[-_][A-Za-z0-9_-]{8,}$|^(?:AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,}$|^eyJ[A-Za-z0-9_-]{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Shannon entropy of `s`, in bits per character. */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
/** Does one path segment or query value of a *_URL look like a credential?
 *  A known key shape, or a run between separators that is long and mixes
 *  letters with digits, or is long and random-looking. Words joined by
 *  hyphens ("getting-started-guide-2024") do not. */
export function looksLikeCredential(s) {
  const v = String(s || "");
  if (v.length < 16 || v.length > 4096) return false;
  if (KEY_SHAPE_RE.test(v)) return true;
  return v.split(/[-_.~]+/).some((run) => (run.length >= 12 && /[A-Za-z]/.test(run) && /[0-9]/.test(run))
    || (run.length >= 16 && entropy(run) >= 3.7));
}

/** The credential-bearing strings in one URL- or RPC-named variable's value.
 *  An RPC or database URL is redacted whole; any other *_URL gives up only
 *  the parts that carry a credential (a password, a credential-named or
 *  credential-looking query value, a credential-looking path segment). */
function urlSecrets(name, value) {
  const out = [];
  const rpc = RPC_NAME_RE.test(name);
  const whole = rpc || DB_URL_NAME_RE.test(name);
  for (const entry of value.split(/[\s,]+/)) {
    if (!entry) continue;
    let u = null;
    try { u = new URL(entry); } catch { /* not a URL */ }
    const parts = [];
    if (u) {
      if (u.password) parts.push(decodeURIComponent(u.password), u.password);
      else if (u.username && looksLikeCredential(decodeURIComponent(u.username))) parts.push(decodeURIComponent(u.username), u.username);
      for (const [k, v] of u.searchParams) if (v && (rpc || CREDENTIAL_PARAM_RE.test(k) || looksLikeCredential(v))) parts.push(v);
      for (const seg of u.pathname.split("/")) {
        if (!PATH_SEGMENT_RE.test(seg)) continue;
        if (rpc || looksLikeCredential(seg)) parts.push(seg);
      }
    }
    if (whole) {
      out.push(entry);
      // A client prints the parsed form (trailing slash added, case folded).
      if (u && u.href !== entry) out.push(u.href);
    }
    out.push(...parts);
  }
  return out;
}

/** A secret's encoded spellings: percent-encoded (either hex case), hex
 *  (either case) and with JSON-escaped slashes. */
function encodedForms(value) {
  const forms = [];
  const pct = encodeURIComponent(value);
  if (pct !== value) forms.push(pct, pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  const hex = Buffer.from(value, "utf8").toString("hex");
  forms.push(hex, hex.toUpperCase());
  if (value.includes("/")) forms.push(value.replaceAll("/", "\\/"));
  return forms;
}

/** A secret's base64 forms: alone, and as the user part of `value:password`
 *  (its 3-byte-aligned prefix, which begins every such encoding). */
function base64Forms(value) {
  const user = Buffer.from(`${value}:`, "utf8");
  return [Buffer.from(value, "utf8").toString("base64"), user.subarray(0, user.length - (user.length % 3)).toString("base64")];
}

const BASE64_TAIL = "[A-Za-z0-9+/]{0,1024}={0,2}";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** [value, isBase64] pairs, longest first, so a whole URL goes before the
 *  password inside it. */
function secretValues() {
  const plain = [];
  const encoded = new Set();
  for (const [name, raw] of Object.entries(process.env)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length < MIN_SECRET_LEN) continue;
    if (SECRET_NAME_RE.test(name)) {
      plain.push(value);
      for (const form of base64Forms(value)) encoded.add(form);
    }
    if (RPC_NAME_RE.test(name) || URL_NAME_RE.test(name)) plain.push(...urlSecrets(name, value));
  }
  const kept = plain.filter((v) => v.length >= MIN_SECRET_LEN);
  for (const v of [...kept]) kept.push(...encodedForms(v));
  const all = [...new Set(kept).values()].map((v) => [v, false]);
  for (const form of encoded) if (form.length >= MIN_SECRET_LEN) all.push([form, true]);
  return all.sort((a, b) => b[0].length - a[0].length);
}

export function redactSecrets(text) {
  let out = String(text ?? "");
  if (!out) return out;
  if (/basic/i.test(out)) out = out.replace(BASIC_IN_TEXT_RE, (m, head, token) => (looksLikeBase64Token(token) ? `${head}[redacted]` : m));
  for (const [value, isBase64] of secretValues()) {
    if (!out.includes(value)) continue;
    // An encoded form takes the rest of its base64 run with it (the password
    // half of `user:password`, the padding).
    out = isBase64 ? out.replace(new RegExp(escapeRe(value) + BASE64_TAIL, "g"), "[redacted]") : out.split(value).join("[redacted]");
  }
  if (!out.includes("://") || !out.includes("@")) return out;
  return out.replace(USERINFO_IN_TEXT_RE, "$1[redacted]@");
}

// Upstream error text a keyless kit relays to the buyer: the message field of
// a JSON body when there is one (else the text), redacted whole before it is
// cut, with hidden and control characters removed and whitespace folded, at
// most `max` characters. The buyer keeps the upstream's reason, not its page.
const MESSAGE_FIELDS = ["message", "error_message", "error_description", "error", "detail", "details", "msg", "reason", "title"];
function messageOf(v, depth = 0) {
  if (typeof v === "string") return v.trim() || null;
  if (!v || typeof v !== "object" || depth > 2) return null;
  if (Array.isArray(v)) return v.length ? messageOf(v[0], depth + 1) : null;
  for (const k of MESSAGE_FIELDS) {
    const m = messageOf(v[k], depth + 1);
    if (m) return m;
  }
  return null;
}
export function upstreamErrorText(raw, max = 200) {
  let s = typeof raw === "string" ? raw : (raw == null ? "" : JSON.stringify(raw));
  s = redactSecrets(s.slice(0, 65_536));
  if (/^\s*[[{"]/.test(s)) {
    try { const m = messageOf(JSON.parse(s)); if (m) s = m; } catch { /* not JSON: keep the text */ }
  }
  s = stripHiddenCharacters(s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
