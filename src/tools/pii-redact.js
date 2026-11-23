// The PII patterns the `redact` tool masks, in the order it applies them, and
// one function both `redact` (kit2.js) and `redact-chat` (redact-chat-kit.js)
// run, so the two tools find exactly the same things.
//
// Pattern-based: an email, a card-like run of 13 to 16 digits, a US SSN, a
// phone number and an IPv4 address in the forms below. Anything written
// another way (a name, a street address, a number split oddly) is not found.
//
// `redactText(text)` answers what `redact` always answered: each match becomes
// `[EMAIL]`, `[CARD]` and so on, with counts by type. `{ numbered: true }`
// gives each distinct value its own placeholder (`[EMAIL_1]`, `[EMAIL_2]`; the
// same value twice gets the same one) and returns the map from placeholder to
// original, which never leaves the process unless the caller restores it.

export const PII_PATTERNS = Object.freeze([
  ["email", /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g],
  ["card", /\b(?:\d[ -]*?){13,16}\b/g],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["phone", /\b(?:\+?\d{1,2}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g],
  ["ip", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
]);
export const PII_TYPES = Object.freeze(PII_PATTERNS.map(([type]) => type));

/** A numbered placeholder this module writes: `[EMAIL_3]`. */
export const PLACEHOLDER_RE = /\[(EMAIL|CARD|SSN|PHONE|IP)_(\d{1,9})\]/g;

/**
 * Mask every PII match in `text`. Plain form: `{ text, counts }`. Numbered form
 * (`numbered: true`): also `entries` ([{ type, placeholder, original }], one per
 * distinct value, in first-seen order). `state` carries the numbering across
 * several texts of one call, so a value in two of them gets one placeholder.
 */
export function redactText(text, { numbered = false, state = null } = {}) {
  let t = String(text);
  const counts = {};
  const st = state || newRedactionState([t]);
  for (const [type, re] of PII_PATTERNS) {
    const label = type.toUpperCase();
    t = t.replace(re, (match) => {
      counts[type] = (counts[type] || 0) + 1;
      if (!numbered) return `[${label}]`;
      const key = `${type}\u0000${match}`;
      let placeholder = st.byValue.get(key);
      if (!placeholder) {
        st.next[type] = (st.next[type] || 0) + 1;
        placeholder = `[${label}_${st.next[type]}]`;
        st.byValue.set(key, placeholder);
        st.entries.push({ type, placeholder, original: match });
      }
      return placeholder;
    });
  }
  return numbered ? { text: t, counts, entries: st.entries } : { text: t, counts };
}

/**
 * The numbering state for one call over `texts`. A text that already holds a
 * token shaped like a placeholder (`[EMAIL_1]` typed by the caller) moves that
 * type's numbering past it, so a placeholder this call writes never equals a
 * token the caller wrote, and restoring never rewrites the caller's own token.
 */
export function newRedactionState(texts) {
  const next = {};
  for (const s of texts) {
    for (const m of String(s).matchAll(PLACEHOLDER_RE)) {
      const type = m[1].toLowerCase();
      const n = Number(m[2]);
      // A number this call could reach (one per distinct match, so far under
      // a million): past it, no placeholder written here can equal the token.
      if (n < 1_000_000 && n > (next[type] || 0)) next[type] = n;
    }
  }
  return { next, byValue: new Map(), entries: [] };
}

/** Put the originals back for every placeholder in `entries` that `text` holds. */
export function restorePlaceholders(text, entries) {
  const map = new Map(entries.map((e) => [e.placeholder, e.original]));
  let restored = 0;
  const out = String(text).replace(PLACEHOLDER_RE, (token) => {
    if (!map.has(token)) return token;
    restored++;
    return map.get(token);
  });
  return { text: out, restored };
}
