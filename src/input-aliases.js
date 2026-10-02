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

  // ---------------------------------------------------------------------
  // Second pass (2026-09-19). The first pass covered 22 names; a sweep of
  // every route's OWN required list found 186 distinct required names, so
  // 164 had no synonym at all across 255 routes. These are the ones where a
  // competent agent would plausibly reach for a different word, chosen by
  // reading each tool's description rather than by pattern. The three rules
  // still make a wrong guess structurally impossible: only a MISSING required
  // field is ever filled, never an overwrite; a synonym that the tool itself
  // declares is skipped, so `key` on a memory tool and `key` on a crypto tool
  // cannot be confused; and two matching synonyms is ambiguity, which keeps
  // the 400. Deliberately NOT aliased: the wire-standard names an SDK already
  // sends verbatim (messages, contents, max_tokens, tools) - a caller holding
  // an OpenAI or Google client sends those exactly, so a synonym there is
  // noise that can only add ambiguity.
  code: ["source", "src", "barcode", "upc", "ean", "gtin"],
  coin: ["symbol", "id", "ticker", "asset", "currency"],
  input: ["text", "data", "str", "string", "body", "content"],
  values: ["data", "series", "numbers", "nums", "points"],
  json: ["data", "body", "input", "obj", "object"],
  prompt: ["text", "input", "description", "q", "query"],
  html: ["content", "body", "markup", "text", "source"],
  hash: ["tx", "txid", "txHash", "tx_hash", "transaction", "signature"],
  mint: ["token", "mintAddress", "address", "contract", "tokenAddress"],
  spec: ["openapi", "schema", "document", "doc", "definition"],
  payload: ["body", "data", "claims", "message"],
  secret: ["key", "password", "passphrase"],
  data: ["input", "body", "payload", "content"],
  image: ["imageUrl", "image_url", "src", "file", "photo"],
  country: ["countryCode", "country_code", "cc", "iso", "nation"],
  principal: ["amount", "p", "balance", "loan"],
  years: ["term", "duration", "period", "nper"],
  horizon: ["periods", "steps", "ahead", "forecast"],
  seriesId: ["series", "series_id", "id"],
  manager: ["fund", "firm", "company", "name"],
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

// ---------------------------------------------------------------------------
// Request shapes (2026-09-24). Agents that already pay for web search and page
// contents elsewhere send their requests in the field names common search and
// page-contents APIs use, and the base URL is often the only thing they
// change. The required-name table above already takes `query` for our `q` and
// `link`/`uri` for `url`. What it could not take is an OPTIONAL field
// (`numResults` for our `count`) or a list of URLs where our tool reads one.
// This table covers those, scoped by slug to the tools where the meaning is
// the same, under the same three rules:
//
//   1. A field is filled only when the caller did not send it. For an optional
//      field the TOOL must also declare it (or, for the two domain lists, its
//      handler must read it - see `hidden` below): a name is never invented
//      for a tool that would not act on it.
//   2. The synonym must not be a declared property of that tool.
//   3. Exactly one synonym may match. Two is ambiguity: nothing is filled, and
//      both names are reported back as ignored rather than guessed between.
//
// A field with no equivalent is never a 400 (the call still answers what it
// can) and never silent either: every recognised field we did not apply is
// named in the answer's `ignoredParams`, so a caller that asked for a date
// range or raw HTML can see it was not applied. The advertised contract does
// not change: schemas, examples and docs still name `q`, `count` and `url`.

const WEB_SEARCH = ["search", "search-lite", "search-news"];
const ALL_SEARCH = [...WEB_SEARCH, "search-images", "search-videos"];
const CONTENTS = ["extract", "render"];
export const SINGLE_URL_TOOLS = [...CONTENTS, "site-map"];

export const SHAPE_ALIASES = [
  {
    // Result count: how many results to return, the same meaning on every one
    // of these tools. Each keeps its own range, so an out-of-range value gets
    // that tool's own answer (search clamps, search-lite refuses and points at
    // search).
    slugs: ALL_SEARCH,
    fill: { count: ["numResults", "num_results", "maxResults", "max_results", "num", "limit"] },
  },
  {
    // Domain allow and deny lists. No search tool declares them; the three web
    // search handlers read `includeDomains` / `excludeDomains`, apply them as
    // site: operators on the query and say so in `domainFilter`. Listed here so
    // the other spellings reach the same two fields.
    slugs: WEB_SEARCH,
    fill: {
      includeDomains: ["include_domains", "includedDomains", "included_domains"],
      excludeDomains: ["exclude_domains", "excludedDomains", "excluded_domains"],
    },
    hidden: ["includeDomains", "excludeDomains"],
  },
  {
    // A list of URLs where the tool reads one. A single-element list is that
    // URL; a longer list is refused by shapeRefusal, because quietly reading
    // the first of several would bill one page and drop the rest.
    slugs: SINGLE_URL_TOOLS,
    arrayOfOne: { url: ["urls"] },
  },
];

// Recognised fields with no equivalent on these tools: accepted, not applied,
// named in `ignoredParams`. A function marks the values that ask for exactly
// what the tool already does (markdown output, main content only), which are
// honoured by construction and so not reported.
const onlyMarkdown = (v) => {
  const list = Array.isArray(v) ? v : [v];
  return list.length > 0 && list.every((f) => f === "markdown" || (f && typeof f === "object" && f.type === "markdown"));
};
const isTrue = (v) => v === true || v === "true";
export const SHAPE_IGNORED = [
  {
    slugs: ALL_SEARCH,
    fields: {
      type: null, category: null, topic: null,
      startPublishedDate: null, endPublishedDate: null, start_published_date: null, end_published_date: null,
      startCrawlDate: null, endCrawlDate: null, start_crawl_date: null, end_crawl_date: null,
      days: null, time_range: null, search_depth: null,
      contents: null, text: null, highlights: null, summary: null, livecrawl: null,
      include_answer: null, include_raw_content: null, include_images: null, useAutoprompt: null,
      scrapeOptions: null,
    },
  },
  {
    // Image and video search take no domain lists.
    slugs: ["search-images", "search-videos"],
    fields: { includeDomains: null, excludeDomains: null, include_domains: null, exclude_domains: null },
  },
  {
    slugs: CONTENTS,
    fields: {
      formats: onlyMarkdown, onlyMainContent: isTrue, text: isTrue,
      includeTags: null, excludeTags: null, waitFor: null, timeout: null, mobile: null, actions: null,
      headers: null, highlights: null, summary: null, livecrawl: null, livecrawlTimeout: null,
      subpages: null, extras: null, maxAge: null, parsePDF: null, proxy: null, blockAds: null,
      removeBase64Images: null, location: null,
    },
  },
];

const hasValue = (v) => v !== undefined && v !== null && v !== "";

/** Fill optional and list-shaped fields for the scoped tools, in place.
 *  Returns the canonical names filled. Same three rules as applyInputAliases. */
export function applyShapeAliases(input, def) {
  if (!input || typeof input !== "object" || !def?.slug) return [];
  const declared = declaredOf(def);
  const filled = [];
  for (const entry of SHAPE_ALIASES) {
    if (!entry.slugs.includes(def.slug)) continue;
    for (const [name, synonyms] of Object.entries(entry.fill || {})) {
      if (!declared.has(name) && !(entry.hidden || []).includes(name)) continue; // rule 1: never invented
      if (hasValue(input[name])) continue; // rule 1: never overwritten
      const present = synonyms.filter((alt) => !declared.has(alt) && hasValue(input[alt])); // rule 2
      if (present.length !== 1) continue; // rule 3 (0 = nothing to fill)
      input[name] = input[present[0]];
      filled.push(name);
    }
    for (const [name, synonyms] of Object.entries(entry.arrayOfOne || {})) {
      if (hasValue(input[name])) continue;
      const present = synonyms.filter((alt) => !declared.has(alt) && hasValue(input[alt]));
      if (present.length !== 1) continue;
      const v = input[present[0]];
      const one = Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
      if (typeof one !== "string" || !one) continue; // several, or not a string: shapeRefusal and the 400 decide
      input[name] = one;
      filled.push(name);
    }
  }
  return filled;
}

/** Recognised request-shape fields on this call that were NOT applied: the
 *  no-equivalent list, plus any synonym left unused (ambiguity, or the caller
 *  also sent the canonical name). Sorted; [] outside the scoped tools. */
export function ignoredShapeParams(input, def) {
  if (!input || typeof input !== "object" || !def?.slug) return [];
  const declared = declaredOf(def);
  const out = new Set();
  for (const entry of SHAPE_IGNORED) {
    if (!entry.slugs.includes(def.slug)) continue;
    for (const [name, honoured] of Object.entries(entry.fields)) {
      if (declared.has(name) || !hasValue(input[name])) continue;
      if (typeof honoured === "function" && honoured(input[name])) continue;
      out.add(name);
    }
  }
  for (const entry of SHAPE_ALIASES) {
    if (!entry.slugs.includes(def.slug)) continue;
    for (const [name, synonyms] of Object.entries({ ...(entry.fill || {}), ...(entry.arrayOfOne || {}) })) {
      for (const alt of synonyms) {
        if (declared.has(alt) || !hasValue(input[alt])) continue;
        const v = input[alt];
        const used = input[name] === v || (Array.isArray(v) && v.length === 1 && input[name] === v[0]);
        if (!used) out.add(alt);
      }
    }
  }
  return [...out].sort();
}

/** A shape we recognise and refuse rather than half-serve: several URLs sent to
 *  a tool that reads one. Returns the 400 message, or null. Only when `url` is
 *  absent: a caller who sent both is served the `url` they named, and the list
 *  is reported in `ignoredParams`. */
export function shapeRefusal(input, def) {
  if (!input || typeof input !== "object" || !def?.slug || !SINGLE_URL_TOOLS.includes(def.slug)) return null;
  if (hasValue(input.url)) return null;
  const v = input.urls;
  if (Array.isArray(v) && v.length > 1) {
    return `"urls" carries ${v.length} URLs and this tool reads one per call: send "url" (or "urls" with exactly one entry) and make one call per page. To read several pages in one call, find a multi-URL contents tool: GET /api/find?q=read+several+urls`;
  }
  return null;
}
