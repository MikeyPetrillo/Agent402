// Data sources this server does not read, serve or credit: each one's terms
// bar commercial use of its data without written permission, and the tools
// that read one were rebuilt on cleared sources. No tracked file outside this
// list and its guard names one (scripts/test-barred-upstreams.js scans the
// shipped code, the ops scripts, the docs, the wiki and the package READMEs),
// so a read, a credit line or a description cannot bring one back.
//
// Dependency-free.

/** Each barred source: the name it goes by, the hosts it serves from (each
 *  host and every subdomain of it is barred) and why, in a few words. */
export const BARRED_UPSTREAMS = Object.freeze([
  Object.freeze({
    name: "GoPlus",
    // The name as a word, any case, with or without a space or dash inside.
    mention: "go[\\s_-]?plus",
    hosts: Object.freeze(["gopluslabs.io"]),
    reason: "its API license bars commercial use of its data without written permission",
    replacedBy: "src/tools/token-facts.js (token-safety, token-risk, token-risk-pro)",
  }),
]);

/** Every barred host, lowercase. */
export const BARRED_UPSTREAM_HOSTS = Object.freeze(BARRED_UPSTREAMS.flatMap((u) => u.hosts.map((h) => h.toLowerCase())));

/** Is `url` (or a bare host) on a barred host or a subdomain of one? */
export function isBarredUpstream(url) {
  let host = String(url ?? "").trim().toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname; } catch { return false; }
  host = host.replace(/\.$/, "");
  return BARRED_UPSTREAM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** `s` as literal text inside a RegExp: every metacharacter, the backslash
 *  included, is escaped. */
function literal(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A pattern that finds a barred source in text: one of its hosts (any
 *  subdomain, each host read as literal text) or its name as a word (each
 *  `mention` is a pattern written in this file). The lists default to this
 *  file's own; a test passes its own. */
export function barredMentionPattern(hostList = BARRED_UPSTREAM_HOSTS, mentions = BARRED_UPSTREAMS.map((u) => u.mention)) {
  const hosts = hostList.map(literal);
  const names = [...mentions];
  return new RegExp(`(?:(?<![a-z0-9-])(?:[a-z0-9-]+\\.)*(?:${hosts.join("|")})(?![a-z0-9-]))|(?:(?<![a-z0-9])(?:${names.join("|")})(?![a-z0-9]))`, "i");
}
