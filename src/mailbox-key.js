// The mailbox an address reaches, for counting mail sent to it: spellings a
// provider delivers to one inbox (a "+tag" suffix; for Gmail the dots in the
// local part and the googlemail.com domain) count as one. Mail still goes to
// the address as typed; this is only the key a per-recipient limit reads.
// Dependency-free: src/credits-account.js and src/mcp-oauth.js import it.
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** The canonical mailbox of `email` (lowercased), or "" for no address. */
export function mailboxKey(email) {
  const s = String(email ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return s;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) { domain = "gmail.com"; local = local.replace(/\./g, ""); }
  return `${local}@${domain}`;
}
