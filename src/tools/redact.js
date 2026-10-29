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
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|MNEMONIC|PRIVATE)/i;
const URL_NAME_RE = /URLS?$/i;
const DB_URL_NAME_RE = /(DATABASE|REDIS|POSTGRES|PG|MONGO|AMQP)_?URLS?$/i;
const CREDENTIAL_PARAM_RE = /^(key|api[-_]?key|apikey|token|access[-_]?token|auth|secret|password|pass|sig|signature|x-api-key)$/i;
// Bounded parts, so the scan is linear: error text can carry a caller's input
// (100 KB of "a.a.a..." once took seconds with an unbounded scheme).
const USERINFO_IN_TEXT_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}:)([^\s@/]{1,256})@/gi;
const MIN_SECRET_LEN = 8;

/** The credential-bearing strings in one URL-named variable's value. */
function urlSecrets(name, value) {
  const out = [];
  for (const entry of value.split(/[\s,]+/)) {
    if (!entry) continue;
    let u = null;
    try { u = new URL(entry); } catch { /* not a URL */ }
    const parts = [];
    if (u) {
      if (u.password) parts.push(decodeURIComponent(u.password), u.password);
      for (const [k, v] of u.searchParams) if (CREDENTIAL_PARAM_RE.test(k) && v) parts.push(v);
    }
    if (DB_URL_NAME_RE.test(name) || parts.length || (u && u.username)) out.push(entry, ...parts);
  }
  return out;
}

function secretValues() {
  const out = [];
  for (const [name, raw] of Object.entries(process.env)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value.length < MIN_SECRET_LEN) continue;
    if (SECRET_NAME_RE.test(name)) out.push(value);
    else if (URL_NAME_RE.test(name)) out.push(...urlSecrets(name, value));
  }
  // Longest first, so a whole URL goes before the password inside it.
  return [...new Set(out.filter((v) => v.length >= MIN_SECRET_LEN))].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text) {
  let out = String(text ?? "");
  if (!out) return out;
  for (const value of secretValues()) {
    if (out.includes(value)) out = out.split(value).join("[redacted]");
  }
  if (!out.includes("://") || !out.includes("@")) return out;
  return out.replace(USERINFO_IN_TEXT_RE, "$1[redacted]@");
}
