// The hosted connector's MCP tool listings on the Bazaar, for the listing
// scripts (refresh-bazaar.js MODE=mcp, bazaar-presence.js, bazaar-validate.js
// --mcp, keepalive-plan.js mcp). Pure functions over /api/pricing rows, feed
// rows and an x402 PaymentRequired; the one import is keepalive-plan.js's own
// pure helpers, so the heartbeat can run the plan without an install.
//
// A fixed-price flagship tool is listed as an MCP tool beside its HTTP route:
// the connector's x402 offer for it names the resource `${origin}/mcp` and a
// discovery extension of type "mcp" (the dotted tool name, its input schema,
// transport "streamable-http"; src/mcp-x402-routes.js). The Bazaar feed holds
// one row per tool, its resource `${origin}/mcp#<toolName>` and its type
// "mcp", minted by a payment made through the connector's x402 transport: a
// payment on the tool's HTTP route refreshes the HTTP row only.
import { usdMicros, exemptKind } from "./keepalive-plan.js";

/** catalog slug -> the dotted MCP tool name it is listed under. The server's
 *  own list is MCP_X402_SLUGS x FLAGSHIP_MCP_NAMES (src/mcp-x402-routes.js,
 *  src/mcp-flagship.js); scripts/test-mcp-listing-tools.js holds the two equal. */
export const MCP_LISTING_TOOLS = Object.freeze({
  "pdf-to-markdown": "pdf.markdown",
  "us-macro-series": "macro.series",
  "weather-current": "weather.current",
  "stock-quote": "market.quote",
  render: "browser.render",
  "memory-read": "memory.read",
});
/** MCP tool listings this server no longer offers (a deliberate flagship
 *  change): the Bazaar may keep their rows for a while after the twins are
 *  gone. The presence check logs one still in the feed as expected and never
 *  counts it seen or missing; a buy or validation never names one. */
export const RETIRED_MCP_LISTING_TOOLS = Object.freeze(["web.search", "web.news", "web.answer"]);
export const MCP_ENDPOINT_PATH = "/mcp";
export const MCP_LISTING_TRANSPORT = "streamable-http";
export const MCP_LISTING_NETWORK = "eip155:8453";
/** USDC on Base (the token contract), the one asset a listing is bought in. */
export const MCP_LISTING_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** The longest validity window a listing offer may ask a signature for. */
export const MCP_OFFER_MAX_VALIDITY_SECONDS = 600;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && EVM_ADDRESS_RE.test(a) && a.toLowerCase() === b.toLowerCase();

/** dotted MCP tool name -> catalog slug (the inverse of MCP_LISTING_TOOLS). */
export function mcpListingSlugOf(name) {
  const n = String(name ?? "").trim();
  if (Object.hasOwn(MCP_LISTING_TOOLS, n)) return n;
  for (const [slug, tool] of Object.entries(MCP_LISTING_TOOLS)) if (tool === n) return slug;
  return null;
}

/** A dispatched list (catalog slugs, dotted tool names, or both) as catalog
 *  slugs, each once, in the order asked: { slugs, unknown }. Anything that is
 *  neither is `unknown`, and the caller refuses the whole list. */
export function mcpListingSlugsOf(list) {
  const slugs = [], unknown = [];
  for (const raw of String(list ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const slug = mcpListingSlugOf(raw);
    if (!slug) unknown.push(raw);
    else if (!slugs.includes(slug)) slugs.push(slug);
  }
  return { slugs, unknown };
}

/** The server's published EVM receiving address, from its service manifest
 *  (/.well-known/x402 payment.x402.payTo), or null. */
export function publishedPayTo(manifest) {
  const v = manifest?.payment?.x402?.payTo;
  return typeof v === "string" && EVM_ADDRESS_RE.test(v) ? v : null;
}

/** The accepts of an offer a listing buy may sign: exact, on Base, in USDC,
 *  by a plain EIP-3009 transfer authorization (not Permit2, not a batched
 *  Gateway authorization, which carry other validity windows and spenders). */
export function mcpListingAccepts(pr) {
  const accepts = Array.isArray(pr?.accepts) ? pr.accepts : [];
  return accepts.filter((a) => a && typeof a === "object" && a.network === MCP_LISTING_NETWORK && a.scheme === "exact"
    && sameAddress(a.asset, MCP_LISTING_ASSET)
    && (a.extra?.assetTransferMethod === undefined || a.extra.assetTransferMethod === "eip3009")
    && a.extra?.verifyingContract === undefined);
}

/** The offer a buy signs: the checked accept and no other, so the signer
 *  cannot select an accept the check did not read. null when there is not
 *  exactly one. */
export function mcpSignableOffer(pr) {
  const own = mcpListingAccepts(pr);
  return own.length === 1 ? { ...pr, accepts: [own[0]] } : null;
}
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** The key an MCP tool listing is read by: the path and fragment of its feed resource. */
export const mcpListingKey = (toolName) => `${MCP_ENDPOINT_PATH}#${toolName}`;

/** A feed resource URL -> the MCP tool it lists on `host`, else null. */
export function mcpToolOfResource(resource, host) {
  try {
    const u = new URL(String(resource));
    if (u.host.toLowerCase() !== String(host).toLowerCase() || u.pathname !== MCP_ENDPOINT_PATH) return null;
    const tool = decodeURIComponent(u.hash.replace(/^#/, ""));
    return TOOL_NAME_RE.test(tool) ? tool : null;
  } catch { return null; }
}

/** Whether a feed row is an MCP listing (its type, or the connector's path). */
export function isMcpFeedRow(it) {
  if (!it || typeof it !== "object") return false;
  if (it.type === "mcp") return true;
  try { return new URL(String(it.resource)).pathname === MCP_ENDPOINT_PATH; } catch { return false; }
}

/** The MCP tool listings a catalog can have, in the list's order:
 *  [{ slug, toolName, key, path, method, micros, price, exempt }]. `path` and
 *  `method` are the tool's HTTP route (where its example is published). A slug
 *  the catalog does not carry (a key-gated tool on that boot) has none. */
export function mcpListingRoutes(pricing) {
  const rows = Array.isArray(pricing) ? pricing : pricing?.endpoints || pricing?.tools || [];
  const bySlug = new Map();
  for (const r of rows) if (r && typeof r === "object" && typeof r.slug === "string" && typeof r.path === "string" && !bySlug.has(r.slug)) bySlug.set(r.slug, r);
  const out = [];
  for (const [slug, toolName] of Object.entries(MCP_LISTING_TOOLS)) {
    const r = bySlug.get(slug);
    if (!r) continue;
    out.push({ slug, toolName, key: mcpListingKey(toolName), path: r.path, method: String(r.method || "GET").toUpperCase(), micros: usdMicros(r.price), price: r.price, exempt: exemptKind(r) });
  }
  return out;
}

/** An explicit slug list against the catalog: the listings to buy, one per
 *  slug, and every asked slug that is refused with why. Any refusal refuses
 *  the whole run (the caller's rule): nothing outside the listed slugs is
 *  ever bought, and a slug asked twice is bought once. */
export function selectMcpListings(pricing, slugs) {
  const asked = [...new Set((Array.isArray(slugs) ? slugs : []).map((s) => String(s).trim()).filter(Boolean))];
  const live = new Map(mcpListingRoutes(pricing).map((r) => [r.slug, r]));
  const routes = [];
  const refused = [];
  for (const slug of asked) {
    if (!Object.hasOwn(MCP_LISTING_TOOLS, slug)) { refused.push({ slug, why: "not an MCP tool listing" }); continue; }
    const r = live.get(slug);
    if (!r) { refused.push({ slug, why: "not in the live catalog" }); continue; }
    if (r.exempt) { refused.push({ slug, why: `exempt kind (${r.exempt})` }); continue; }
    if (!(r.micros > 0)) { refused.push({ slug, why: "unpriced" }); continue; }
    routes.push(r);
  }
  return { asked, routes, refused };
}

/** "$0.005" for 5000 micro-USD: the catalog's own figure, trailing zeros cut to three places at least. */
export function usdText(micros) {
  const s = (Math.round(micros) / 1e6).toFixed(6).replace(/0+$/, "");
  const [whole, frac = ""] = s.split(".");
  return `$${whole}.${frac.padEnd(3, "0")}`;
}

/**
 * Why an x402 PaymentRequired is not the MCP listing's offer for `toolName`
 * ([] when it is). A payment signed against anything else would settle a
 * different resource: the tool's HTTP route (a build without the twins), or
 * another tool. `micros`, when given, is the list price the Base accept must
 * ask exactly. `payTo`, when given, is the receiving address it must pay (the
 * server's published one; a buy always gives it). The offer must hold exactly
 * one accept a buy may sign (mcpListingAccepts), and its validity window is
 * bounded (MCP_OFFER_MAX_VALIDITY_SECONDS).
 */
export function mcpOfferProblems(pr, { toolName, origin, micros = null, payTo = null } = {}) {
  const out = [];
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) return ["no PaymentRequired object"];
  if (pr.x402Version !== 2) out.push(`x402Version is ${JSON.stringify(pr.x402Version)}, not 2`);
  const want = `${String(origin || "").replace(/\/+$/, "")}${MCP_ENDPOINT_PATH}`;
  if (pr.resource?.url !== want) out.push(`resource is ${JSON.stringify(pr.resource?.url ?? null)}, not ${want}`);
  const ext = pr.extensions?.bazaar;
  const input = ext?.info?.input;
  if (!ext || typeof ext !== "object") out.push("no bazaar discovery extension");
  else if (!input || typeof input !== "object") out.push("the bazaar extension has no info.input");
  else {
    if (input.type !== "mcp") out.push(`extension type is ${JSON.stringify(input.type ?? null)}, not "mcp"`);
    if (input.toolName !== toolName) out.push(`extension toolName is ${JSON.stringify(input.toolName ?? null)}, not ${toolName}`);
    if (input.transport !== MCP_LISTING_TRANSPORT) out.push(`extension transport is ${JSON.stringify(input.transport ?? null)}, not ${MCP_LISTING_TRANSPORT}`);
    if (!input.inputSchema || typeof input.inputSchema !== "object" || Array.isArray(input.inputSchema)) out.push("extension inputSchema is not an object");
    else if (input.inputSchema.type !== "object") out.push("extension inputSchema is not of type object");
    // The Bazaar indexes an MCP tool by calling it with this example as the
    // arguments; a missing or empty one is not indexed, so a buy would be spent.
    if (!input.example || typeof input.example !== "object" || Array.isArray(input.example)) out.push("extension example is not an object");
    else if (!Object.keys(input.example).length) out.push("extension example holds no argument");
    if (!ext.schema || typeof ext.schema !== "object") out.push("the bazaar extension has no schema");
  }
  const own = mcpListingAccepts(pr);
  if (!own.length) out.push(`no exact accept on ${MCP_LISTING_NETWORK}`);
  else if (own.length !== 1) out.push(`${own.length} exact USDC accepts on ${MCP_LISTING_NETWORK}, not exactly one`);
  else {
    const a = own[0];
    if (micros != null && String(a.amount) !== String(micros)) out.push("the Base accept does not ask the list price");
    if (payTo != null && !sameAddress(a.payTo, payTo)) out.push("the Base accept does not pay the server's published receiving address");
    const t = a.maxTimeoutSeconds;
    if (!Number.isInteger(t) || t < 1 || t > MCP_OFFER_MAX_VALIDITY_SECONDS) out.push(`the Base accept's validity window is ${JSON.stringify(t ?? null)} s, not 1 to ${MCP_OFFER_MAX_VALIDITY_SECONDS}`);
  }
  return out;
}
