// The metered gateway as the agent-facing surfaces lead with it: the routes
// per wire, one sentence on what the quote is, one runnable call, and the flat
// tiers one line below. Every surface that offers a model (llms.txt, openapi,
// SKILL.md, the MCP connector, the home page, the guides, the flat tiers' 402)
// reads this module, so the wording and the figures cannot drift apart.
// Prices and the default model are read from the tier table, never typed.
import { TIERS, tierPriceLabel, isFlatTier } from "./tools/llm-gateway-kit.js";
import { MESSAGES_PATH_BY_TIER } from "./tools/llm-messages-kit.js";
import { RESPONSES_PATH_BY_TIER } from "./tools/llm-responses-kit.js";
import { GEMINI_PATH_BY_TIER } from "./tools/llm-gemini-kit.js";

/** The metered route on each wire, the OpenAI chat wire first. */
export const METERED_WIRES = Object.freeze([
  Object.freeze({ slug: "v1-chat-metered", path: TIERS["v1-chat-metered"].route.split(" ")[1], wire: "OpenAI chat" }),
  Object.freeze({ slug: "v1-chat-metered-messages", path: MESSAGES_PATH_BY_TIER["v1-chat-metered"], wire: "Anthropic Messages" }),
  Object.freeze({ slug: "v1-chat-metered-responses", path: RESPONSES_PATH_BY_TIER["v1-chat-metered"], wire: "OpenAI Responses" }),
]);

const metered = () => TIERS["v1-chat-metered"];

/** "$0.001": the floor the catalog lists the metered tier at ("from"). */
export function meteredFromPrice() {
  return `$${tierPriceLabel(metered().price)}`;
}

/** The model a metered call that names none is served. */
export function meteredDefaultModel() {
  return metered().defaultModel;
}

/** One sentence: what the quote is, and that settlement never exceeds it. */
export function meteredQuoteSentence() {
  return "The 402 quotes this exact request from its own body (the input counted exactly plus your `max_tokens`, at the model's list price plus a fee), and settlement never exceeds that quote: an `exact` payer pays the quote, and an `upto` payer (where the 402 offers it) or a credits key settles what the answer used.";
}

/** The three routes as one inline list. */
export function meteredRoutesInline() {
  return METERED_WIRES.map((w) => `\`POST ${w.path}\``).join(", ");
}

/** A call anyone can run: unpaid, it answers 402 with this body's quote. */
export function meteredCurl(baseUrl) {
  return [
    `curl -i -X POST ${baseUrl}${METERED_WIRES[0].path} -H 'content-type: application/json' \\`,
    `  -d '{"model":"${meteredDefaultModel()}","messages":[{"role":"user","content":"Summarize x402 in one line"}],"max_tokens":200}'`,
    "# unpaid: HTTP 402 quoting this body; an x402 or MPP client pays the quote and resends",
  ].join("\n");
}

/** The flat chat tiers (nano, base, pro, premium), cheapest first. */
export function flatTierRows() {
  return Object.entries(TIERS)
    .filter(([slug]) => isFlatTier(slug))
    .map(([slug, t]) => ({ slug, path: t.route.split(" ")[1].replace("/chat/completions", "") || "/v1", price: t.price }))
    .sort((a, b) => a.price - b.price);
}

/** One line on the flat tiers, the predictable-price option. */
export function flatTiersLine() {
  const rows = flatTierRows();
  if (!rows.length) return "";
  const lo = rows[0].price, hi = rows.at(-1).price;
  return `Flat tiers stay as the predictable-price option: one price per call whatever the length, $${tierPriceLabel(lo)} to $${tierPriceLabel(hi)} (${rows.map((r) => `\`${r.path}\``).join(", ")}; \`GET /v1/models\` lists every model with its tier).`;
}

/** The metered twin of a flat chat tier on the same wire, by slug
 *  (v1-chat-pro-messages -> v1-chat-metered-messages); null for anything that
 *  is not a flat chat tier. The caller checks the twin is in its catalog. */
export function meteredTwinSlug(slug) {
  const s = String(slug || "");
  const wire = s.match(/-(?:messages|responses|gemini)$/)?.[0] || "";
  const tier = wire ? s.slice(0, -wire.length) : s;
  if (!tier.startsWith("v1-chat") || !isFlatTier(tier)) return null;
  return `v1-chat-metered${wire}`;
}

const TWIN_PATHS = Object.freeze({
  ...Object.fromEntries(METERED_WIRES.map((w) => [w.slug, w.path])),
  "v1-chat-metered-gemini": GEMINI_PATH_BY_TIER["v1-chat-metered"],
});

/** The path of a flat chat tier's metered twin, or null. */
export function meteredTwinPath(slug) {
  const twin = meteredTwinSlug(slug);
  return twin ? TWIN_PATHS[twin] || null : null;
}
