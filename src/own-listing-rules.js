// The rules our OWN Bazaar listings meet, beyond the protocol's schemas.
//
// Two parts, both pure:
//
// - listingCompletenessGaps (scripts/test-bazaar-contracts.js, on every
//   route's real 402): the fields a listing is ranked and curated on
//   (category, the tool's own tags, an input schema that declares every field
//   the example sends, a description that says more than the name, a sample
//   output, an output schema, a media type), each present and real.
// - ownDirectiveIn (scripts/test-own-listing-screen.js, on every string we
//   publish about a tool): the Bazaar's content policy removes a listing whose
//   metadata could instruct an agent, and screens every resource while it is
//   listed. The router's listing screen (src/listing-screen.js) reads
//   third-party listings for attacks; this reads our own for anything phrased
//   as a directive to the reader, so a safety note is written as a fact about
//   the answer ("results are marked untrustedContent") and never as an order
//   to the agent reading it.
// Directives to the reading agent that a description of a tool never needs.
// Each is phrased about the reader's own conduct: what to treat, follow,
// call first or set aside.
export const OWN_DIRECTIVE_PATTERNS = Object.freeze([
  /\bignore\s+(?:all|any|every|previous|prior|other|earlier|the\s+(?:above|rest|other)|instructions?)\b/i,
  /\bdisregard\b/i,
  /\bnever\s+(?:treat|follow|obey|trust|execute)\b/i,
  /\b(?:treat|read)\s+(?:it|them|this|these|those|the\s+\w+|results?|anything|everything|its\s+\w+)\b[^.]{0,60}?\bas\s+(?:data|information|untrusted|plain\s+text)/i,
  /\binstructions?\s+to\s+(?:follow|obey)\b/i,
  /\bnot\s+(?:as\s+)?instructions\b/i,
  /\bnever\s+(?:as\s+)?instructions\b/i,
  /\bstart\s+here\b/i,
  /\b(?:call|use|pick|choose)\s+(?:this|it|me)\s+(?:first|before\s+any|instead\s+of\s+any)\b/i,
  /\byou\s+(?:must|should\s+always|have\s+to)\b/i,
]);

/** The first own-directive rule a text trips, or null. */
export function ownDirectiveIn(text) {
  const s = String(text ?? "");
  for (const re of OWN_DIRECTIVE_PATTERNS) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  return null;
}

const FILLER = new Set(["agents", "x402", "tools"]);
const exampleKeys = (input) => {
  if (!input || typeof input !== "object") return [];
  const out = [];
  for (const part of ["queryParams", "body"]) {
    const v = input[part];
    if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) out.push([part, k]);
  }
  return out;
};

/** What a route's listing lacks, as plain reasons (empty when complete).
 *  `endpoint` is its /api/pricing row; `listing` the 402's resource block;
 *  `extension` its bazaar extension. */
export function listingCompletenessGaps({ endpoint = {}, listing = {}, extension = {} } = {}) {
  const gaps = [];
  const category = String(endpoint.category || "").trim();
  if (!category) gaps.push("no category");
  const tags = Array.isArray(listing.tags) ? listing.tags : [];
  const own = tags.filter((t) => t && t !== category && !FILLER.has(t));
  if (!own.length) gaps.push(`no tag of its own beyond the category and fillers (${JSON.stringify(tags)})`);
  const name = String(endpoint.name || "").trim().toLowerCase();
  const desc = String(listing.description || "").trim();
  if (!desc || desc.toLowerCase() === name || desc.split(/\s+/).length < 8) gaps.push("description says no more than the name");
  const info = extension?.info || {};
  const input = info.input;
  if (!input || typeof input !== "object") gaps.push("no example input");
  else {
    const method = String(endpoint.method || "GET").toUpperCase();
    if (input.method && String(input.method).toUpperCase() !== method) gaps.push(`example input method ${input.method} is not the route's ${method}`);
    const inSchema = extension?.schema?.properties?.input?.properties || {};
    for (const [part, key] of exampleKeys(input)) {
      const declared = inSchema[part]?.properties;
      if (!declared || typeof declared !== "object" || !(key in declared)) gaps.push(`input schema does not declare ${part}.${key}, which the example sends`);
    }
  }
  if (info.output === undefined || info.output.example === undefined) gaps.push("no sample output");
  if (!extension?.schema?.properties?.output) gaps.push("no output schema");
  if (!listing.mimeType) gaps.push("no mimeType");
  return gaps;
}
