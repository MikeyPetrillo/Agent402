// Capability gaps: tasks this host's own catalog does not do, for which a
// near-named tool would otherwise be picked. One explicit list, read by
// /api/find (src/find.js), /api/route (src/x402-index.js) and route-and-execute
// (src/tools/route-execute.js), so the three agree.
//
// A gap is narrow on purpose. A query is in a family only when it asks for
// that capability in so many words; every other query is ranked and served
// exactly as before. A query in a family is a miss ONLY when no candidate row
// is NAMED for the capability (its slug or name; a description never clears
// it, so text a listing adds to its description cannot take the pick). A row
// that is named for it, an outside seller's included, is the pick.
//
// Adding a family: an `asks` that reads the query, a `covers` that reads a
// row's slug and name, `terms` the ranking also looks rows up by, and a case
// with controls in scripts/test-capability-gaps.js. Deterministic, bounded
// patterns over bounded text; no model, no network.

const TEXT_MAX = 500;
// Lowercase, every run of other characters one space, padded with a space at
// each end so a pattern can ask for whole words.
const norm = (s) => ` ${String(s ?? "").slice(0, TEXT_MAX).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

const IP_WORD = "(?:ip|ips|ipv4|ipv6)";
const IP_RE = new RegExp(` ${IP_WORD} `);
const IP_LITERAL_RE = /(?:^|[^\d.])(?:\d{1,3}\.){3}\d{1,3}(?:[^\d.]|$)/;
// "geoip" and "geo ip" say both halves in one word.
const GEOIP_RE = / geo ?ips? | ip ?geo /;
// Where it is: the location family of words (never a bare "geo").
const PLACE_RE = / (?:geolocat[a-z]{1,8}|geo locat[a-z]{1,8}|location|locations|located|locate|locating|locator) /;
// "where is this IP", never "where is the IP for <a name>" (a DNS lookup).
const WHERE_IP_RE = new RegExp(` where (?:is|are|s) (?:[a-z0-9]+ ){0,3}?${IP_WORD} (?:address(?:es)? )?(?!(?:address(?:es)? )?(?:for|of) )`);
// A row named for it: geoip, or an IP word beside a location word.
const NAMED_PLACE_RE = / (?:geo|geolocat[a-z]{1,8}|location|locations|locate|locator|country|city) /;

export const CAPABILITY_GAPS = Object.freeze([
  Object.freeze({
    id: "ip-geolocation",
    label: "IP geolocation",
    // Words the ranking also looks rows up by, so a row named for the
    // capability is a candidate however the query worded it.
    terms: Object.freeze(["geolocat", "geoip"]),
    asks(n, raw) {
      if (GEOIP_RE.test(n)) return true;
      const aboutIp = IP_RE.test(n) || IP_LITERAL_RE.test(raw);
      if (!aboutIp) return false;
      if (PLACE_RE.test(n)) return true;
      return IP_RE.test(n) && WHERE_IP_RE.test(n);
    },
    covers(n) {
      return GEOIP_RE.test(n) || (IP_RE.test(n) && NAMED_PLACE_RE.test(n));
    },
  }),
]);

/** The gap family a query asks for, or null (nearly every query). */
export function capabilityGap(query) {
  const raw = String(query ?? "").slice(0, TEXT_MAX);
  const n = norm(raw);
  for (const gap of CAPABILITY_GAPS) if (gap.asks(n, raw)) return gap;
  return null;
}

/** Whether a row is named for the gap's capability: slug and name only. */
export function gapNamedBy(gap, slug, name) {
  return !!gap && gap.covers(norm(`${String(slug ?? "").slice(0, 120)} ${String(name ?? "").slice(0, 200)}`));
}

/** The words a refusal names a gap by (its label), from the id an answer carries. */
export function capabilityGapLabel(id) {
  return CAPABILITY_GAPS.find((g) => g.id === id)?.label || "that capability";
}
