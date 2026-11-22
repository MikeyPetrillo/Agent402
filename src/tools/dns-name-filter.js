// One filter for every DNS lookup of a caller-chosen name.
//
// A lookup from this server goes to the resolver it is configured with, which
// can answer for names that exist only inside its network. So a name the
// caller picks is refused before the query when it can only be internal:
//   - the special-use and site-local zones (.internal, .local, .localhost,
//     .localdomain, .home.arpa);
//   - a single-label name (resolved through the search domains, if any);
//   - a reverse name (in-addr.arpa / ip6.arpa) that lies wholly inside a
//     private, loopback, link-local or shared range.
//
// ONE NAME. A resolver does not ask for the text it is handed: it reads a
// trailing dot as the root, ignores case, maps a name written outside ASCII
// to its ASCII form (full-width letters, the other dot characters, characters
// it drops) and reads a backslash as an escape. So the name is put in its
// canonical form once (canonicalDnsName), THAT form is judged, and that form
// is the only thing a caller may hand a resolver (assertQueryableName returns
// it). A caller never judges one spelling and asks for another. Pure: no I/O.
import { domainToASCII } from "node:url";

const INTERNAL_ZONES = /(^|\.)(internal|local|localhost|localdomain|home\.arpa)$/i;

// True when every address under the octets a reverse name spells (most
// significant first) lies inside one private range.
function v4Private(octets) {
  const [a, b] = octets;
  if (octets.length >= 1 && (a === 10 || a === 127)) return true;
  if (octets.length >= 2) {
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function v6Private(nibbles) {
  // nibbles: most significant first, as hex digits.
  const n = nibbles.map((x) => parseInt(x, 16));
  if (n.length >= 2 && n[0] === 0xf && (n[1] === 0xc || n[1] === 0xd)) return true; // fc00::/7
  if (n.length >= 3 && n[0] === 0xf && n[1] === 0xe && n[2] >= 0x8 && n[2] <= 0xb) return true; // fe80::/10
  if (n.length === 32) {
    if (n.slice(0, 31).every((x) => x === 0) && n[31] === 1) return true; // ::1
    // ::ffff:a.b.c.d (IPv4-mapped): judge the embedded IPv4 address.
    if (n.slice(0, 20).every((x) => x === 0) && n.slice(20, 24).every((x) => x === 0xf)) {
      const o = [];
      for (let i = 24; i < 32; i += 2) o.push(n[i] * 16 + n[i + 1]);
      if (v4Private(o)) return true;
    }
  }
  return false;
}

/**
 * The canonical form of a name: the spelling a resolver would put on the
 * wire. Trimmed, mapped to ASCII when it is written outside it (the mapping
 * the resolver itself applies), every trailing dot removed, lowercased. ""
 * when the name has none: a backslash (a resolver's escape, which can spell
 * any character), or text outside ASCII that is not a host name. Idempotent.
 */
export function canonicalDnsName(name) {
  let s = String(name ?? "").trim();
  if (s.includes("\\")) return "";
  if (/[^\x00-\x7f]/.test(s)) {
    // domainToASCII reads its argument as a URL host, so the characters that
    // end or split one are refused first rather than cut off.
    if (/[\s/?#@:%[\]]/.test(s)) return "";
    s = domainToASCII(s);
  }
  // Every trailing dot, by position (a pattern anchored at the end rescans a
  // long run of dots from each of them).
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 46) end--;
  return s.slice(0, end).toLowerCase();
}

/**
 * Why a caller-chosen DNS name is refused, or null when its canonical form
 * (canonicalDnsName) may be queried.
 * @param {string} name
 * @returns {string|null}
 */
export function internalNameReason(name) {
  // Judged by its labels: an empty one (".redis", "db..internal") is refused
  // by a resolver and never makes a name public.
  const s = canonicalDnsName(name).split(".").filter(Boolean).join(".");
  if (!s) return "Invalid domain name";
  if (INTERNAL_ZONES.test(s)) return "Private or link-local zones are not resolvable here";
  if (!s.includes(".")) return "Single-label names are not resolvable here; send a fully qualified domain name";
  const v4 = s.match(/^((?:\d{1,3}\.){0,4})in-addr\.arpa$/);
  if (v4) {
    const labels = v4[1].split(".").filter(Boolean);
    const octets = labels.reverse().map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o > 255)) return null; // not an address name; nothing private to protect
    if (octets.length && v4Private(octets)) return "Reverse names for private address ranges are not resolvable here";
    return null;
  }
  const v6 = s.match(/^((?:[0-9a-f]\.){0,32})ip6\.arpa$/);
  if (v6) {
    const nibbles = v6[1].split(".").filter(Boolean).reverse();
    if (nibbles.length && v6Private(nibbles)) return "Reverse names for private address ranges are not resolvable here";
    return null;
  }
  return null;
}

/** Throws a 400 when the name is refused; returns the canonical name
 *  otherwise: the name that was judged, and the one to query. */
export function assertQueryableName(name) {
  const why = internalNameReason(name);
  if (why) throw Object.assign(new Error(why), { statusCode: 400 });
  return canonicalDnsName(name);
}
