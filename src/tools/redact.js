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
// a database or Redis URL (*DATABASE_URL, *REDIS_URL) is redacted whole,
// and any *_URL value (or each entry of a comma or space separated list)
// that carries userinfo or a credential query parameter is redacted whole,
// along with its password and that parameter's value on their own. A
// `scheme://user:password@` in the text itself loses its password even when
// no variable names it.
//
// RPC endpoints carry their key in the path (https://host/v2/<key>) as often
// as in the query, so every *_RPC, *_RPCS, *_RPC_URL and *_RPC_URLS entry is
// redacted whole, along with each long path segment and every query value.
// Any other *_URL entry also gives up a long mixed letter-and-digit path
// segment. Each secret's base64 form (alone and as `value:`) is redacted too,
// and a `Basic <credentials>` token in the text loses its credentials whatever
// variable they came from. *_SALT values count as secrets.
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

/** The credential-bearing strings in one URL- or RPC-named variable's value. */
function urlSecrets(name, value) {
  const out = [];
  const rpc = RPC_NAME_RE.test(name);
  for (const entry of value.split(/[\s,]+/)) {
    if (!entry) continue;
    let u = null;
    try { u = new URL(entry); } catch { /* not a URL */ }
    const parts = [];
    if (u) {
      if (u.password) parts.push(decodeURIComponent(u.password), u.password);
      for (const [k, v] of u.searchParams) if ((rpc || CREDENTIAL_PARAM_RE.test(k)) && v) parts.push(v);
      for (const seg of u.pathname.split("/")) {
        if (!PATH_SEGMENT_RE.test(seg)) continue;
        if (rpc || (/[A-Za-z]/.test(seg) && /[0-9]/.test(seg))) parts.push(seg);
      }
    }
    if (rpc || DB_URL_NAME_RE.test(name) || parts.length || (u && u.username)) {
      out.push(entry, ...parts);
      // A client prints the parsed form (trailing slash added, case folded).
      if (u && u.href !== entry) out.push(u.href);
    }
  }
  return out;
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
  const all = [...new Set(plain.filter((v) => v.length >= MIN_SECRET_LEN)).values()].map((v) => [v, false]);
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
