// Accept the obvious other name for a required parameter.
//
// Measured 2026-08-29 from 60 days of telemetry: the buyers who explored the
// catalog and left did not hit payment errors. Every one of their failures was
// a 400. One walked 77 tools and was rejected 723 times; another 55 tools and
// 70 times. The control that makes this readable is a walker that used our
// DOCUMENTED EXAMPLES: 2,591 calls across 1,382 slugs, 25 errors, 1%.
//
// Driving the same tools by hand reproduced it: a third of plausible
// first attempts failed on the NAME alone - `roman` wants `value` and a caller
// reaches for `number`, `tls-cert` wants `host` and a caller sends `domain`,
// `edgar-company-lookup` wants `ticker` and a caller sends `q`. An agent that
// reads our OpenAPI gets these right; an agent that infers from the tool name
// does not, and inferring is what agents do. Each one is a request we validated
// correctly and a sale we did not make.
//
// This is deliberately NOT fuzzy matching. It is a curated, DIRECTED table -
// "a tool that requires `host` also accepts `domain`" - applied under three
// rules that make it impossible to change the meaning of a call:
//
//   1. Only a REQUIRED property the caller did not supply is ever filled.
//      A value the caller sent is never overwritten, and an optional
//      parameter is never invented.
//   2. The synonym must not itself be a declared property of that tool. If a
//      tool has both `host` and `domain` they mean different things, and
//      taking one for the other would corrupt the call.
//   3. Exactly one synonym may match. Two candidates is ambiguity, and the
//      400 (which names the field it wants) is the better answer.
//
// The advertised contract does not change: the schema still names the
// canonical parameter, and that is still what the docs, the examples and the
// 400's `expected` block say to send.

// canonical -> other names a caller plausibly reaches for. Directed on purpose:
// requiring `host` accepts `domain`, and requiring `domain` accepts `host`, but
// each direction is written out so neither is inferred.
export const PARAM_ALIASES = {
  host: ["hostname", "domain", "site", "server"],
  hostname: ["host", "domain"],
  domain: ["host", "hostname", "site"],
  value: ["number", "num", "n", "input", "val"],
  number: ["value", "num", "n"],
  text: ["content", "str", "string", "input", "body", "data"],
  content: ["text", "body"],
  query: ["q", "search", "term", "keyword", "question"],
  q: ["query", "search", "term", "keyword"],
  ticker: ["symbol", "q", "query", "company"],
  symbol: ["ticker", "coin", "asset"],
  address: ["addr", "wallet", "account"],
  wallet: ["address", "addr"],
  url: ["link", "uri", "href", "page"],
  lat: ["latitude"],
  latitude: ["lat"],
  lon: ["lng", "long", "longitude"],
  longitude: ["lon", "lng", "long"],
  expr: ["expression", "formula", "calc", "input"],
  code: ["source", "src"],
  city: ["place", "location"],
  cik: ["company", "issuer"],
  token: ["jwt", "accessToken"],
  contract: ["contractAddress", "token", "address"],
  tokenId: ["id", "token_id"],
  from: ["source", "src", "start"],
  to: ["target", "dest", "destination", "end"],
  limit: ["count", "max", "top", "n"],
  slug: ["tool", "name", "id"],
  ticker_or_cik: ["ticker", "cik", "company"],
};

/** Required property names a tool declares, from its own discovery schema. */
function requiredOf(def) {
  const s = def?.discovery?.inputSchema;
  const req = Array.isArray(s?.required) ? s.required : [];
  return req.filter((k) => typeof k === "string");
}

/** Every property name the tool declares (required or not). */
function declaredOf(def) {
  const s = def?.discovery?.inputSchema;
  return new Set(Object.keys(s?.properties || {}));
}

/** Fill missing REQUIRED parameters from an accepted synonym, in place.
 *  Returns the canonical names that were filled (for telemetry); [] is the
 *  overwhelmingly common case and costs one Set lookup per required field. */
export function applyInputAliases(input, def) {
  if (!input || typeof input !== "object" || !def) return [];
  const required = requiredOf(def);
  if (!required.length) return [];
  const declared = declaredOf(def);
  const filled = [];
  for (const name of required) {
    if (input[name] !== undefined && input[name] !== null && input[name] !== "") continue; // rule 1
    const candidates = PARAM_ALIASES[name];
    if (!candidates) continue;
    let found;
    for (const alt of candidates) {
      if (declared.has(alt)) continue; // rule 2: it means something else here
      const v = input[alt];
      if (v === undefined || v === null || v === "") continue;
      if (found !== undefined) { found = undefined; break; } // rule 3: ambiguous
      found = v;
    }
    if (found !== undefined) { input[name] = found; filled.push(name); }
  }
  return filled;
}
