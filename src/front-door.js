// The front door: the few lines an agent reads first on every machine surface
// (/llms.txt, /agents.md, the MCP server.describe answer and the unpaid 402
// body). One source, so every surface says the same thing: the call to make
// first and its price, how access works, when to use the service and when not
// to, and what happens when a call fails.
//
// Prices and routes are READ FROM THE CATALOG at render time, never typed: a
// slug missing from the catalog renders "see /api/pricing" in place of a price.
// The recovery lines state each rule only where it holds (the settlement rule
// on x402, the implicit replay on an EVM x402 payment outside identity-bound,
// lasting-effect and streamed calls); scripts/test-front-door.js reads every
// surface and fails on a missing scope word, a price that is not the
// catalog's, or a block that does not lead.
import { FLAGSHIP_MCP_NAMES, AGENT402_MCP_VERSION } from "./mcp-flagship.js";
import { IDEM_MAX_BODY_LABEL } from "./idempotency-limits.js";
import { RAILS_OR } from "./rails.js";
import { mppOfferShortProse } from "./mpp-offers.js";
import { isComputePayable } from "./pow.js";
import { TYPICAL_PRICE_RANGE } from "./typical-price-range.js";

/** The first call. Live web search: the widest first job, a flat price with no
 *  model in its serving path, and the start of most research chains. */
export const FRONT_DOOR_SLUG = "search";
/** Named beside it: the cited answer, and the read for a URL already held. */
const ANSWER_SLUG = "answer";
const EXTRACT_SLUG = "extract";
const RENDER_SLUG = "render";

/** The agent-facing page that carries this block first. */
export const AGENTS_MD_PATH = "/agents.md";

function routeOf(catalog, slug) {
  for (const [key, def] of Object.entries(catalog || {})) {
    if (def && def.slug === slug) {
      const [method, path] = key.split(" ");
      return { method, path, price: typeof def.price === "string" ? def.price : null, modelBacked: def.modelBacked === true };
    }
  }
  return null;
}

const priceText = (r) => (r && r.price ? r.price : "see /api/pricing");

/** The block as data: what every surface renders. `code` wraps a route or a
 *  header name (backticks in markdown, plain in JSON). */
export function frontDoor(catalog, baseUrl, { code = (s) => s } = {}) {
  const first = routeOf(catalog, FRONT_DOOR_SLUG) || { method: "GET", path: `/api/${FRONT_DOOR_SLUG}`, price: null };
  const answer = routeOf(catalog, ANSWER_SLUG);
  const extract = routeOf(catalog, EXTRACT_SLUG);
  const render = routeOf(catalog, RENDER_SLUG);
  const mcpName = FLAGSHIP_MCP_NAMES[FRONT_DOOR_SLUG];
  const firstUrl = `${baseUrl}${first.path}?q=your+query`;
  const answerClause = answer
    ? ` For a cited answer, ${FLAGSHIP_MCP_NAMES[ANSWER_SLUG]} (${code(`${answer.method} ${answer.path}`)}, ${priceText(answer)}${answer.modelBacked ? ", model-backed" : ""}).`
    : "";
  const readClause = extract
    ? `read it with ${code(`${extract.method} ${extract.path}`)}${render ? `, or ${FLAGSHIP_MCP_NAMES[RENDER_SLUG]} for JavaScript pages` : ""}`
    : "read it directly";
  return {
    firstCall: {
      text: `${mcpName}: ${code(`${first.method} ${firstUrl}`)}, ${priceText(first)} per call: ranked live web results as JSON (title, URL, snippet, age).${answerClause}`,
      mcpName,
      slug: FRONT_DOOR_SLUG,
      method: first.method,
      route: first.path,
      url: firstUrl,
      price: first.price,
    },
    access: `No account, no API key: pay per call in USDC over x402 or MPP (Tempo settles in its own stablecoins), and the 402 quotes the price before you pay. The pure-CPU tools in the free tier also take proof-of-work (${mcpName} is wallet-only).`,
    useWhen: `You need live web data newer than your training, or a capability your sandbox lacks (a headless browser, OCR, PDF and media processing, market data), one paid call at a time.`,
    doNotUseWhen: `You already hold the URL (${readClause}), or the work is a local computation you can run yourself.`,
    recovery: [
      `On x402 a call the tool fails is not charged: settlement runs after the tool and only for a response under 400, and no ${code("PAYMENT-RESPONSE")} header means nothing settled. On MPP a Tempo push payment is sent before the call, so a failure there is booked as a refund owed.`,
      `On an EVM x402 payment, re-send the same request with the same signed payment inside the replay window for the first answer (${code("X-Replayed-Answer: 1")}) with no second settlement; not on identity-bound routes, routes with a lasting effect or streamed calls.`,
      `Send an ${code("Idempotency-Key")}: the same key with the same credential (an x402 payment, a proof-of-work token or a credits key), route and body returns the first 200 answer (up to ${IDEM_MAX_BODY_LABEL}) without a second charge.`,
      `On a slow route, send the paid call with ${code("Prefer: respond-async")} for a 202 and a job link, then poll ${code("GET /api/jobs/{id}")} (free); payment settles only on the delivered answer.`,
    ],
    guide: `${baseUrl}${AGENTS_MD_PATH}`,
  };
}

/** Markdown: /llms.txt and /agents.md. */
export function frontDoorMarkdown(catalog, baseUrl) {
  const d = frontDoor(catalog, baseUrl, { code: (s) => `\`${s}\`` });
  return `## Start here

- **First call:** ${d.firstCall.text}
- **Access:** ${d.access}
- **Use when:** ${d.useWhen}
- **Do not use when:** ${d.doNotUseWhen}
- **If a call fails:** ${d.recovery[0]}
- **If an answer is lost:** ${d.recovery[1]}
- **To retry:** ${d.recovery[2]}
- **If a call is slow:** ${d.recovery[3]}`;
}

/** JSON: the MCP server.describe answer and the unpaid 402 body. Built once
 *  per catalog, base URL and route count (every unpaid 402 carries it). */
const jsonMemo = new WeakMap();
export function frontDoorJson(catalog, baseUrl) {
  const size = Object.keys(catalog || {}).length;
  const hit = catalog && typeof catalog === "object" ? jsonMemo.get(catalog) : null;
  if (hit && hit.baseUrl === baseUrl && hit.size === size) return hit.value;
  const value = buildFrontDoorJson(catalog, baseUrl);
  if (catalog && typeof catalog === "object") jsonMemo.set(catalog, { baseUrl, size, value });
  return value;
}
function buildFrontDoorJson(catalog, baseUrl) {
  const d = frontDoor(catalog, baseUrl);
  return {
    firstCall: d.firstCall.text,
    access: d.access,
    useWhen: d.useWhen,
    doNotUseWhen: d.doNotUseWhen,
    recovery: d.recovery,
    guide: d.guide,
  };
}

/** /agents.md: the front door first, then how to connect, how to pay and
 *  where the rest of the catalog is. Rails, MPP methods, the free-tier count
 *  and the price band are read from their own sources. */
export function agentsMd(baseUrl, catalog) {
  const defs = Object.values(catalog || {}).filter((d) => d && d.slug);
  const powCount = new Set(defs.filter(isComputePayable).map((d) => d.slug)).size;
  const mpp = mppOfferShortProse();
  return `# Agent402.Tools for agents

500+ tools an agent calls and pays for per request. Base URL: ${baseUrl}

${frontDoorMarkdown(catalog, baseUrl)}

## Connect

- **Plain HTTP:** call any route. An unpaid call answers HTTP 402 with the price and both offers (x402 \`PAYMENT-REQUIRED\` and MPP \`WWW-Authenticate: Payment\`); pay from your wallet and send the call again with the payment.
- **MCP, hosted (streamable HTTP, nothing to install):** \`${baseUrl}/mcp\`. The proof-of-work tools run free there with no wallet.
- **MCP over stdio, with a wallet for paid tools:** \`npx -y agent402-mcp@${AGENT402_MCP_VERSION}\` with \`AGENT_KEY\` set to a new wallet holding a few dollars of USDC, never your main wallet.
- **Buyer SDK:** \`npm install agent402-client\` resolves a task to a tool and calls it: proof-of-work is solved for you on the free tools, and paid tools use the payment-aware fetch you pass in.

## Pay

- **x402:** ${RAILS_OR}. Gas is sponsored on the EVM chains, so a wallet needs only the stablecoin.${mpp ? `\n- **MPP:** ${mpp}, on the same 402.` : ""}
- **Proof-of-work:** ${powCount} pure-CPU tools take a sha256 puzzle instead of payment. Get one at \`GET ${baseUrl}/api/pow/challenge?slug=hash\` and send the solution as \`X-Pow-Solution\`.
- **Prices:** most tools ${TYPICAL_PRICE_RANGE.text} per call; every price is in \`${baseUrl}/api/pricing\` and quoted in the 402 before you pay.

## Find more

- \`GET ${baseUrl}/api/find?q=<task>\`: the best-matching tools for a task, with route, price, input schema and a ready example.
- [/llms.txt](${baseUrl}/llms.txt) and [/llms-full.txt](${baseUrl}/llms-full.txt): the full index, every route with its price.
- [/openapi.json](${baseUrl}/openapi.json): every input and output schema.
- [/.well-known/x402](${baseUrl}/.well-known/x402): the x402 discovery document.
- [/status](${baseUrl}/status): live health, measured from outside production.

Maintained by Havok Holdings LLC.
`;
}

/** One sentence for an origin-level description (the OpenAPI info and the
 *  x402 discovery document): what the first call gets for its price. */
export function frontDoorOneLine(catalog) {
  const first = routeOf(catalog, FRONT_DOOR_SLUG) || { method: "GET", path: `/api/${FRONT_DOOR_SLUG}`, price: null };
  return `Start here: ${first.method} ${first.path}?q=<query> returns ranked live web results as JSON (title, URL, snippet, age) for ${priceText(first)} a call, with no account and no API key; the first request answers HTTP 402 with the price, and ${AGENTS_MD_PATH} has the recovery contract.`;
}

/** The unpaid 402 body's part of the block: access and the recovery contract,
 *  the lines that bear on paying for the call already chosen, plus the link to
 *  the whole block. The 402 body's own fields have a byte budget
 *  (scripts/test-bazaar-contracts.js), so the first-call and use lines stay on
 *  the discovery surfaces. */
export function frontDoor402Json(catalog, baseUrl) {
  const { access, recovery, guide } = frontDoorJson(catalog, baseUrl);
  return { access, recovery, guide };
}
