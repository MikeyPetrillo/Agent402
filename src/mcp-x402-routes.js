// Internal x402 twins of six fixed-price flagship tools, for the hosted MCP
// connector's x402 wire.
//
// Each twin answers at /__mcp-x402/<slug>, and only a request that carries the
// connector's loopback marker (src/mcp-loopback.js: the per-process secret on
// a loopback socket) reaches it. Such a request is rewritten, before any gate
// runs, to the tool's own catalog path and flagged here, so it runs the HTTP
// route's own chain unchanged: the same handler, idempotency, replay guard,
// settlement hooks, booking and refund ledger (final-200 rule). The flag only
// changes what the paywall quotes: the HTTP route's accepts (the same builder,
// so the same price on every chain, a rail restored after boot included),
// with the resource named `${BASE_URL}/mcp` and a Bazaar discovery extension
// of type "mcp" (the dotted tool name, its input schema, its example
// arguments, transport "streamable-http").
//
// Any other request to /__mcp-x402/* is passed on untouched, so it answers the
// app's ordinary 404. The twins are not catalog entries: no listing, pricing
// row, openapi path, sitemap URL or llms.txt line names them.
//
// A sale made through a twin books the arrival path "x402-mcp"
// (src/sale-path.js), and its catalog slug (x402McpEntryOf) wherever a book
// would otherwise read the slug from the resource URL. The flag lives in a
// WeakMap that only the rewrite below writes, so no request header or body
// can set it. A flagged request the twins' paywall does not price is sent to
// the HTTP route's paywall (mcpX402Dispatch), never on unpaid.
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { isMcpLoopback } from "./mcp-loopback.js";
import { FLAGSHIP_MCP_NAMES, MACRO_SERIES_SLUG } from "./mcp-flagship.js";
import { boundedSchema } from "./openapi-schema.js";

/** The flagship slugs that have an internal x402 twin (fixed-price tools). */
export const MCP_X402_SLUGS = Object.freeze(["pdf-to-markdown", MACRO_SERIES_SLUG, "weather-current", "stock-quote", "render", "memory-read"]);
export const MCP_X402_PREFIX = "/__mcp-x402/";
/** The arrival path a twin's sale books (sales ledger `via`). */
export const MCP_X402_SALE_PATH = "x402-mcp";
export const MCP_X402_TRANSPORT = "streamable-http";
/** Byte bound on the twin's declared input schema (the same bound the HTTP listing uses). */
export const MCP_X402_INPUT_SCHEMA_MAX_BYTES = 900;

/** The internal path of a slug's twin. */
export const mcpX402PathOf = (slug) => `${MCP_X402_PREFIX}${slug}`;

const flagged = new WeakMap();

/** True only for a request the twin gate below rewrote. */
export function isX402McpRequest(req) {
  return !!req && typeof req === "object" && flagged.has(req);
}

/** The twin a flagged request runs ({ slug, toolName, route, method, path }), or null. */
export function x402McpEntryOf(req) {
  if (!req || typeof req !== "object") return null;
  const e = flagged.get(req);
  return e ? { slug: e.slug, toolName: e.toolName, route: e.route, method: e.method, path: e.path } : null;
}

/** The twin slug a dotted MCP tool name stands for, or null. */
export function mcpX402SlugOfToolName(name) {
  if (typeof name !== "string") return null;
  return MCP_X402_SLUGS.find((s) => FLAGSHIP_MCP_NAMES[s] === name) || null;
}

/** The paywall a request runs: a flagged request goes to the twins' paywall
 *  only when that paywall prices it (`knows`); any other flagged request,
 *  and every other request, goes to the HTTP route's own paywall. A flagged
 *  request is never passed on unpaid. */
export function mcpX402Dispatch({ main, mcp, knows }) {
  if (!mcp) return main;
  return function paymentMiddlewareWithMcpTwins(req, res, next) {
    let twin = false;
    if (isX402McpRequest(req)) { try { twin = knows(req) === true; } catch { twin = false; } }
    return (twin ? mcp : main)(req, res, next);
  };
}

/** `knows` for mcpX402Dispatch: whether an x402 HTTP resource server prices
 *  this request, read the way @x402/express reads it. */
export function mcpX402Knows(httpServer) {
  return (req) => {
    const path = req.path;
    let decodedPath = path;
    try { decodedPath = decodeURIComponent(path); } catch { decodedPath = path; }
    return httpServer.requiresPayment({ adapter: { getMethod: () => req.method }, path, decodedPath, method: req.method }) === true;
  };
}

// RFC 7240 respond-async, as src/async-jobs.js reads it.
const PREFER_ASYNC_TOKEN = /(^|[\s,;])respond-async(?=$|[\s,;=])/gi;

/** A route priced the same for every request (no per-request quote). */
export const isFixedPriceDef = (def) => typeof def?.quote !== "function" && typeof def?.tierQuote !== "function";
const isFixedPrice = isFixedPriceDef;

/** The twins a catalog can serve: [{ slug, toolName, route, method, path, def }].
 *  A slug missing from the catalog (a key-gated tool on this boot) or priced
 *  per request has none. */
export function mcpX402Entries(catalog) {
  const bySlug = new Map();
  for (const [route, def] of Object.entries(catalog || {})) {
    if (def && typeof def.slug === "string" && MCP_X402_SLUGS.includes(def.slug)) bySlug.set(def.slug, [route, def]);
  }
  const out = [];
  for (const slug of MCP_X402_SLUGS) {
    const hit = bySlug.get(slug);
    if (!hit) continue;
    const [route, def] = hit;
    if (!isFixedPrice(def) || typeof FLAGSHIP_MCP_NAMES[slug] !== "string") continue;
    const sp = route.indexOf(" ");
    out.push({ slug, toolName: FLAGSHIP_MCP_NAMES[slug], route, method: route.slice(0, sp), path: route.slice(sp + 1), def });
  }
  return out;
}

/** The MCP tool's input schema as the connector lists it, byte-bounded. */
export function mcpX402InputSchema(def) {
  const s = def?.discovery?.inputSchema;
  const full = s && typeof s === "object" ? { type: "object", ...s } : { type: "object" };
  return boundedSchema(full, MCP_X402_INPUT_SCHEMA_MAX_BYTES) || { type: "object" };
}

/** Example arguments for a twin whose HTTP route publishes an empty example
 *  (memory-read lists keys with no argument). The Bazaar indexes an MCP tool
 *  by calling it with its example as the arguments, and an empty example is
 *  not indexed. The key is the one memory-write's published example writes. */
export const MCP_X402_EXAMPLE_FALLBACKS = Object.freeze({
  "memory-read": Object.freeze({ key: "research/task-42" }),
});

/** The tool's published example arguments, when they are an object with at
 *  least one argument; else the twin's fallback, when it has one. */
export function mcpX402Example(def) {
  const ex = def?.discovery?.input ?? def?.discovery?.example;
  if (ex && typeof ex === "object" && !Array.isArray(ex) && Object.keys(ex).length) return ex;
  const fallback = typeof def?.slug === "string" && Object.hasOwn(MCP_X402_EXAMPLE_FALLBACKS, def.slug) ? MCP_X402_EXAMPLE_FALLBACKS[def.slug] : undefined;
  return fallback ? { ...fallback } : undefined;
}

/** The twin's Bazaar discovery extension ({ bazaar: ... }), built by the
 *  protocol's own helper. */
export function mcpX402DiscoveryExtension(entry) {
  const example = mcpX402Example(entry.def);
  return declareDiscoveryExtension({
    toolName: entry.toolName,
    transport: MCP_X402_TRANSPORT,
    inputSchema: mcpX402InputSchema(entry.def),
    ...(example !== undefined ? { example } : {}),
  });
}

/** What buildPaymentMiddleware takes for the twins: the HTTP route each one
 *  quotes beside, and its MCP extension. */
export function mcpX402PaymentSpecs(catalog) {
  return mcpX402Entries(catalog).map((e) => ({ route: e.route, toolName: e.toolName, extensions: mcpX402DiscoveryExtension(e) }));
}

/**
 * The twin gate, mounted right after the loopback marker is read and before
 * every other middleware. A genuine marked request for a known twin, on the
 * tool's own method, is rewritten to the tool's catalog path (query kept) and
 * flagged; a gate credential other than an x402 payment header is removed
 * from it (the twins are x402 only), and so is a respond-async preference: a
 * job's replay would reach the twin's path without the marker, so a twin
 * always answers in the request. Anything else under the prefix goes on
 * unchanged to the app's 404.
 */
export function createMcpX402Gate({ getCatalog }) {
  let bySlug = null;
  return function mcpX402Gate(req, _res, next) {
    const path = req.path;
    if (typeof path !== "string" || !path.startsWith(MCP_X402_PREFIX)) return next();
    if (!bySlug) bySlug = new Map(mcpX402Entries(getCatalog()).map((e) => [e.slug, e]));
    const entry = bySlug.get(path.slice(MCP_X402_PREFIX.length));
    if (!entry || req.method !== entry.method || !isMcpLoopback(req)) return next();
    const headers = req.headers || {};
    delete headers.authorization;
    delete headers["x-pow-solution"];
    if (typeof headers.prefer === "string" && /respond-async/i.test(headers.prefer)) {
      const rest = headers.prefer.replace(PREFER_ASYNC_TOKEN, "$1").replace(/^[\s,;]+|[\s,;]+$/g, "").replace(/,\s*,/g, ",");
      if (rest) headers.prefer = rest; else delete headers.prefer;
    }
    flagged.set(req, entry);
    const q = req.url.indexOf("?");
    req.url = entry.path + (q >= 0 ? req.url.slice(q) : "");
    return next();
  };
}
