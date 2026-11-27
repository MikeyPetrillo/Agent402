// Server-rendered catalogue pages and the OpenAPI spec — all generated from
// the tool catalog so they never drift from what the API actually serves.
import { EDGAR_MARK_NOTICE, namesEdgar } from "./mark-notices.js";
import { SERVER_VERSION } from "./server-version.js";
import { siteOrgRef } from "./site-org.js";
import { usdToBaseUnits } from "./base-units.js";
import { frontDoorOneLine } from "./front-door.js";
import { leadSentence, SUPPORT_LINE } from "./positioning.js";
import { receiptsServed, RECEIPT_FETCH_PATH, RECEIPT_URL_HEADER, RECEIPT_HEADER } from "./receipt-signing.js";
import { RECEIPT_FETCH_DAYS } from "./receipt-store.js";
import { gatewayProductSentence } from "./gateway-product-copy.js";
import { PAYMENT_RETRY_VERBS_NOTE } from "./tool-error-fields.js";
import { openapiRequestBody } from "./openapi-request.js";
import { asyncAdvice } from "./slow-routes.js";
import { leaderboardCadence } from "./refresh-cadence.js";
import { returningWalletHeaderParams } from "./returning-wallet.js";
import { upstreamKeyHeaderParams } from "./upstream-key.js";
import { binaryTypesOf, responseTypesOf, JSON_MIME } from "./tool-media-type.js";
import { needsAsyncOrWait } from "./slow-sync-window.js";
import { REPO_URL } from "./repo-link.js";
import { isComputePayable } from "./pow.js";
import { responseSchemaFor } from "./openapi-schema.js";
import { sanctionsGeoBlockEnabled } from "./sanctioned-regions.js";
import { captureNote } from "./tool-output-examples.js";
import { ledgerShell, ledgerFooterCompact, esc as ledgerEsc, breadcrumbTrail, codeBlock } from "./ledger-chrome.js";
import { getWalletShortHtml } from "./get-a-wallet.js";
import { firstFit } from "./seo-meta.js";
import { SKILL_PACKS, PACK_PRICE_RANGE } from "./skills.js";
import { TYPICAL_PRICE_RANGE } from "./typical-price-range.js";
import { agentReportPriceRange, cardReportPriceRange, reportLadderProse } from "./report-tiers.js";
import { MONITOR_PRODUCTS } from "./stripe-subscriptions.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { RAILS_OR, RAILS_PAREN, RAILS_SHORT, railsOrFor, x402EvmOnly, x402RailsFor } from "./rails.js";
import { paidCallFigure, paidCallScript, PAID_CALL_CSS } from "./paid-call-figure.js";
import { routeFailedCallLine, TEMPO_PUSH_SHORT } from "./settlement-footnote.js";
import { JOB_PUSH_EXCEPTION } from "./tempo-push-debts.js";
import { publicPremiumUsdByNetwork as premiumUsdByNetworkName } from "./public-networks.js";
import { gatewayOfferPublic } from "./gateway-nanopayments.js";
import { defHasLastingEffect } from "./hangup-forgiveness.js";
import { mppOffersFor, mppRailsPhrase, mppOfferShortProse, mppOfferGateClauseIfOffered, mppOfferGateSentenceIfOffered } from "./mpp-offers.js";
import { tempoOfferedFor, tempoDiscoveryInfo } from "./mpp-tempo.js";
import { WALLET_ONLY_POLICY_REASON, powCostPhrase } from "./pow.js";
import { creditsSalesEnabled } from "./credits-sales.js";
import { paysThirdParty } from "./third-party-routes.js";
import { ncTaxableKind } from "./nc-sales-tax.js";
import { crawlIntervalLabel, discoveryIntervalLabel } from "./crawl-cadence.js";
import { routerRankingSentence, routingProofSentence } from "./routing-proof.js";
import { IDEM_MAX_BODY_LABEL } from "./idempotency-limits.js";
import { mppFlagshipRows } from "./mpp-flagship.js";
import { PRICED_BY_MODEL_NOTE } from "./tools/llm-gateway-kit.js";
import { meteredTwinPath, meteredQuoteSentence, meteredRoutesInline, flatTiersLine, isMeteredChatSlug, meteredTimeoutSentence } from "./metered-lead.js";
import { PARAM_ALIASES } from "./input-aliases.js";
import { kalshiToolsEnabled } from "./kalshi-switch.js";
import { UNIT_CATEGORIES } from "./tools/convert-gen.js";
import { toolJudgeEnabled } from "./tool-judge.js";
import { fromPriceLabel } from "./quoted-from.js";
import { CARD_ART_VERSION } from "./brand-mark.js";
import { SETTLE_FIRST_SENTENCE, settleFirstClause } from "./settle-first-copy.js";
import { ATTRIBUTION_TAILS } from "./data-attribution.js";

// A price in base units of an offer's token (src/base-units.js), or null
// when the price is not a dollar figure.
const baseUnitsOrNull = (usd, decimals) => { try { return String(usdToBaseUnits(usd, decimals)); } catch { return null; } };

export const CATEGORIES = {
  web: { label: "Web & documents", blurb: "Read the live web: browser rendering, screenshots, article extraction, PDFs, metadata." },
  memory: { label: "Agent memory & coordination", blurb: "The stateful layer a stateless agent can't build for itself: durable wallet-keyed KV with TTL, atomic counters/locks, shared namespaces other agents can reach (grants), a tamper-evident audit log, and similarity recall. The payment is the identity - no signup." },
  network: { label: "Network & domains", blurb: "DNS, TLS certificates, WHOIS/RDAP, uptime checks, robots.txt and sitemaps." },
  data: { label: "Live public data", blurb: "Keyless real-time government and market data: dataset search across data.gov, NWS weather alerts, USGS earthquakes, currency rates, barcode product lookup." },
  payments: { label: "Payments & x402", blurb: "Non-custodial x402 tooling: decode HTTP 402 quotes, verify on-chain USDC settlements, read balances, tx status and gas across the EVM chains each tool lists, and build EIP-3009 transfer authorizations. The agent signs with its own key - these tools never touch funds." },
  conversion: { label: "Data conversion", blurb: "JSON ⇄ CSV/YAML/XML, markdown ⇄ HTML, diffs and queries - formats agents juggle constantly." },
  text: { label: "Text processing", blurb: "Slugs, case conversion, diffs, regex, keywords, token estimates, edit distance, readability, PII redaction." },
  math: { label: "Math & finance", blurb: `Safe expression calculator, statistics, unit conversion across ${Object.keys(UNIT_CATEGORIES).length} categories (${Object.keys(UNIT_CATEGORIES).slice(0, 3).join(", ")}, …) via POST /api/unit-convert, percentage/number formatting, CIDR subnets, compound interest and loan math.` },
  encoding: { label: "Encoding & crypto", blurb: "Hashes, HMAC signatures, base64/hex, JWT decoding, TOTP codes." },
  identifiers: { label: "Generators & IDs", blurb: "UUIDs, ULIDs, passwords, secure randomness, QR codes." },
  time: { label: "Time & scheduling", blurb: "Timezone-aware clocks, epoch conversion, cron parsing, durations." },
  validation: { label: "Validation & parsing", blurb: "Emails (with MX), URLs, IPs, user agents, colors, semver, IBAN, card numbers." },
  llm: { label: "LLM gateway", blurb: "OpenAI-compatible pay-per-call inference over x402 - flat quality tiers and a metered tier, plus embeddings and image generation, model-optional auto-routing, streaming, and a default-on prompt cache. See /v1 in the OpenAPI spec for the full wire format." },
  // Every category the catalog actually uses must have an entry here. This map
  // is the source for the /tools category pages, the /api/pricing categories
  // map, /.well-known/x402 capabilities, and llms.txt - so a category missing
  // from it is a 404 page, an unlabelled price row, a capabilities total that
  // does not reconcile, and tools absent from the agent-readable catalog. It
  // was short by ten keys covering 195 entries (37% of the catalog), which is
  // why seller-trust and the chain-read primitives were invisible to agents.
  crypto: { label: "Crypto & onchain data", blurb: "Keyless reads across chains: token prices and metadata, order books, stablecoin peg health, wallet balances and transaction history, NFT holdings and metadata, gas snapshots." },
  chain: { label: "Sanctions & address screening", blurb: "Sanctions checks: screen any blockchain address against every digital currency address on the OFAC SDN list, or a person or company name against the list's entries, with the sanctioned entity named on a match." },
  wallet: { label: "Wallet operations", blurb: "Multi-chain balance reads, testnet funding, onramp links, and SQL over onchain data. Non-custodial: the agent signs with its own key." },
  ai: { label: "AI & compute", blurb: "Inference and generation priced per call: chat tiers, image generation, text-to-speech and speech-to-text." },
  "skill-pack": { label: "Skill packs", blurb: "Multi-tool workflows that run server-side in one request: one payment, one settlement, and a single response with a partial-success envelope if a step fails. Cheaper to integrate than orchestrating the steps yourself." },
  "date-time": { label: "Calendar & date math", blurb: "ISO weeks, leap years, day-of-year, epoch conversion, and movable-feast dates - the calendar edge cases that are easy to get subtly wrong." },
  research: { label: "Market & demand research", blurb: "Analyzed reads over this catalog's own demand and the open x402 ecosystem: what agents ask for, what sells, and company research." },
  agent: { label: "Routing & delegation", blurb: "The Smart Order Router: describe a task and it resolves the best-matching tool and runs it in one call, from this catalog or bought from an external x402 seller and resold to you, in tiers by underlying price." },
  api: { label: "API primitives", blurb: "Building blocks for services that front an agent: CAPTCHA generation and verification." },
  x402: { label: "x402 seller intelligence", blurb: "Evidence about other x402 sellers, at three depths: the router's own gate field by field (crawl health, advertised chains, observed settlement counts), the assembled record for one origin (price provenance, advertised wallets against the wallets actually paid, settlement evidence per source, the dispatch verdict per chain), and a live payability check that buys one real call and reports every leg." },
};

/** Flatten the catalog into renderable tool descriptors. */
export function toolList(catalog) {
  return Object.entries(catalog).map(([route, def]) => {
    const [method, path] = route.split(" ");
    const tool = { route, method, path, ...def };
    // server.js marks a route that may settle first with a non-enumerable
    // `settlesFirst`, which a spread drops; the tool page reads it, and no
    // listing that serializes the entry picks it up.
    if (def && def.settlesFirst === true) Object.defineProperty(tool, "settlesFirst", { value: true, configurable: true });
    return tool;
  });
}


function payExample(baseUrl, tool) {
  const { method, path, discovery } = tool;
  if (method === "GET") return `const res = await payFetch("${baseUrl}${path}${exampleQueryString(tool)}");`;
  return `const res = await payFetch("${baseUrl}${path}", {
  method: "${method}",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(${JSON.stringify(discovery?.input ?? {}, null, 2).split("\n").join("\n  ")}),
});`;
}

// Format a cache TTL (in seconds) as the smallest unit that reads cleanly.
// Used by the "Cached" badge on /tools/{slug}.
function fmtTtl(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const TOOL_TITLE_MAX = 60;

/** The price as a buyer meets it: a flat "$0.001" or, for a route that quotes
 *  each request from its body, the floor it starts at. */
/** A catalog price as USD, e.g. "$0.010" -> 0.01. */
export function priceUsdOf(tool) {
  return Number(String(tool?.price ?? "").replace(/[^0-9.]/g, "")) || 0;
}

/** One display form for a catalog price: at least two decimals, no trailing
 *  zeros past them ("$3.3" -> "$3.30", "$0.010" -> "$0.01", "$0.001" kept). */
export function displayPrice(price) {
  const raw = String(price ?? "");
  const m = raw.match(/^\$(\d+)(?:\.(\d+))?$/);
  if (!m) return raw;
  let frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `$${m[1]}.${frac}`;
}

export function priceWords(tool) {
  if (tool.quoteRange && Number.isFinite(tool.quoteRange.maxUsd) && tool.quoteRange.maxUsd > tool.quoteRange.minUsd) {
    const from = displayPrice(fromPriceLabel(tool));
    return { short: `from ${from}`, long: `quoted per request from ${from}` };
  }
  const p = displayPrice(tool.price);
  return { short: p, long: `${p} per call` };
}

/** Name for a title: parentheticals dropped first, then cut at a word. */
function titleName(name, room) {
  let n = String(name).trim();
  if (n.length <= room) return n;
  const noParen = n.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (noParen.length && noParen.length <= room) return noParen;
  n = noParen || n;
  const cut = n.slice(0, room + 1);
  const ws = cut.lastIndexOf(" ");
  return (ws > room * 0.5 ? cut.slice(0, ws) : n.slice(0, room)).replace(/[\s,;:+&\-]+$/g, "");
}

/** Page title, at most 60 characters: "<Name> API - $0.001/call | Agent402",
 *  shedding the brand, then the parenthetical, then words, never the price. */
export function toolTitle(tool) {
  const p = priceWords(tool).short;
  const tail = ` API - ${p}/call`;
  const brand = " | Agent402";
  const full = `${tool.name}${tail}${brand}`;
  if (full.length <= TOOL_TITLE_MAX) return full;
  const withBrand = `${titleName(tool.name, TOOL_TITLE_MAX - tail.length - brand.length)}${tail}${brand}`;
  const noBrand = `${titleName(tool.name, TOOL_TITLE_MAX - tail.length)}${tail}`;
  // Keep the brand when the name survives it intact, otherwise spend the room on the name.
  const nameIntactWithBrand = titleName(tool.name, TOOL_TITLE_MAX - tail.length - brand.length) === tool.name;
  return nameIntactWithBrand ? withBrand : noBrand;
}

/** First sentence of a description: up to the first period, question mark or
 *  exclamation mark that ends the text or is followed by a capital, a bracket
 *  or a quote. A mark inside an open parenthesis, or the period of "e.g.",
 *  "i.e." or "vs.", ends nothing. */
export function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const end = /[.!?](?=\s+[A-Z(`"]|$)/g;
  let out = s;
  for (let m = end.exec(s); m; m = end.exec(s)) {
    const head = s.slice(0, m.index + 1);
    const last = m.index + 1 === s.length;
    if (!last && (/(?:^|[^a-z])(?:e\.g|i\.e|vs)\.$/i.test(head) || head.split("(").length > head.split(")").length)) continue;
    out = head;
    break;
  }
  return /[.!?]$/.test(out) ? out : `${out}.`;
}

function cutAtWord(text, max) {
  const s = String(text).trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  let cut = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) cut = m.index + 1;
  if (cut >= max * 0.5) return head.slice(0, cut).trim();
  const ws = head.lastIndexOf(" ");
  let words = (ws > 0 ? head.slice(0, ws) : head.slice(0, max)).replace(/[\s,;:\-(]+$/g, "").trim().split(" ");
  // A cut that ends on a connecting word ("... by hash on") reads as broken.
  while (words.length > 3 && /^(a|an|the|of|on|in|to|for|by|and|or|with|from|at|as|via|into|its)$/i.test(words.at(-1))) words.pop();
  return words.join(" ").replace(/[\s,;:\-(]+$/g, "") + ".";
}

/** Meta description, 120-155 characters, built from the tool's own sentence
 *  plus the price and how it is paid - different on every page because the
 *  description, price and route are. */
export function toolMetaDescription(tool, { computePayable = false, mpp = true } = {}) {
  const MAX = 155, MIN = 120;
  const p = priceWords(tool).long;
  const payText = computePayable ? `${p} over x402, or free with proof-of-work.` : `${p} over x402${mpp ? " or MPP" : ""}.`;
  // The price words open their own sentence ("Quoted per request from ...").
  const pay = payText.charAt(0).toUpperCase() + payText.slice(1);
  const room = MAX - pay.length - 2;
  let lead = String(tool.description || tool.name).replace(/\s+/g, " ").trim();
  lead = cutAtWord(lead, room);
  if (!/[.!?]$/.test(lead)) lead += ".";
  let out = `${lead} ${pay}`;
  const fillers = [
    ` ${tool.method} ${tool.path}.`,
    " No API key or signup.",
    (tool.tags || []).length ? ` Tags: ${(tool.tags || []).slice(0, 4).join(", ")}.` : "",
    ` Category: ${CATEGORIES[tool.category]?.label ?? tool.category}.`,
  ];
  for (const f of fillers) {
    if (out.length >= MIN) break;
    if (f && out.length + f.length <= MAX) out += f;
  }
  return out.length > MAX ? out.slice(0, MAX) : out;
}

/** Related tools: same category and shared tags score highest; skill packs
 *  only relate to other packs. Deterministic for a given catalog. */
export function relatedTools(tool, tools, limit = 6) {
  const tags = new Set((tool.tags || []).map((t) => String(t).toLowerCase()));
  const isPack = tool.category === "skill-pack";
  return tools
    .filter((t) => t.slug !== tool.slug && (t.category === "skill-pack") === isPack)
    .map((t) => {
      const shared = (t.tags || []).filter((x) => tags.has(String(x).toLowerCase())).length;
      return { t, score: (t.category === tool.category ? 3 : 0) + shared * 2 };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.t.slug.localeCompare(b.t.slug))
    .slice(0, limit)
    .map((r) => r.t);
}

/** "string", "integer (1-64)", "one of: sha256, sha512" ... from a JSON Schema property. */
function schemaType(v = {}) {
  let t = Array.isArray(v.type) ? v.type.join(" | ") : (v.type || (v.enum ? "string" : "any"));
  if (t === "array" && v.items?.type) t = `array of ${v.items.type}`;
  const bits = [];
  if (Array.isArray(v.enum) && v.enum.length) bits.push(`one of: ${v.enum.slice(0, 12).map(String).join(", ")}${v.enum.length > 12 ? ", ..." : ""}`);
  if (Number.isFinite(v.minimum) || Number.isFinite(v.maximum)) bits.push(`${Number.isFinite(v.minimum) ? v.minimum : ""}-${Number.isFinite(v.maximum) ? v.maximum : ""}`);
  if (v.format) bits.push(v.format);
  if (v.default !== undefined) bits.push(`default ${typeof v.default === "string" ? v.default : JSON.stringify(v.default)}`);
  return bits.length ? `${t} (${bits.join("; ")})` : t;
}

function exampleValueType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length && typeof v[0] === "object" && v[0] !== null ? "array of objects" : v.length ? `array of ${typeof v[0]}` : "array";
  return typeof v;
}

function codeList(names, max = 4) {
  const shown = names.slice(0, max).map((n) => `<code>${ledgerEsc(n)}</code>`);
  const more = names.length > max ? ` and ${names.length - max} more` : "";
  if (shown.length <= 1) return shown.join("") + more;
  return more ? `${shown.join(", ")}${more}` : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** The query string a GET tool's documented input becomes, "" when it has none.
 *  ONE builder for the curl example and the proof-of-work snippet, so the two
 *  cannot send different inputs. */
export function exampleQueryString(tool) {
  const input = tool.discovery?.input ?? {};
  const qs = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
  return qs ? `?${qs}` : "";
}

// Content types a tool answers with as raw bytes (the route binder's
// { __binary, contentType } sentinel): src/tool-media-type.js, shared with the
// x402 listing and /api/pricing.
export { binaryTypesOf };

const listWords = (xs, joiner = "or") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${joiner} ${xs.at(-1)}`);

/** The request the proof-of-work snippet sends: { url, method, headers, body }.
 *  Exported so a test can send exactly what the page publishes. */
export function powSnippetRequest(baseUrl, tool) {
  const input = tool.discovery?.input ?? {};
  const isGet = tool.method === "GET";
  return {
    url: `${baseUrl}${tool.path}${isGet ? exampleQueryString(tool) : ""}`,
    method: tool.method,
    body: isGet ? null : JSON.stringify(input),
  };
}

/** The page's Python sample, standard library only: on a proof-of-work tool
 *  the free call (the same request as the JavaScript snippet), on any other
 *  the 402 and the quote its PAYMENT-REQUIRED header carries. */
export function pythonExample(baseUrl, tool, { computePayable = false } = {}) {
  const req = powSnippetRequest(baseUrl, tool);
  const send = (headers) => `req = urllib.request.Request(${JSON.stringify(req.url)}, method=${JSON.stringify(req.method)}${req.body != null ? `, data=${JSON.stringify(req.body)}.encode()` : ""}, headers={${[...headers, ...(req.body != null ? ['"Content-Type": "application/json"'] : [])].join(", ")}})`;
  if (computePayable) return `import hashlib, json, urllib.request

def zero_bits(digest):
    n = 0
    for b in digest:
        if b:
            return n + 8 - b.bit_length()
        n += 8
    return n

c = json.load(urllib.request.urlopen(${JSON.stringify(`${baseUrl}/api/pow/challenge?slug=${tool.slug}`)}))
n = 0
while zero_bits(hashlib.sha256(f"{c['challenge']}:{n}".encode()).digest()) < c["difficulty"]:
    n += 1
${send(['"X-Pow-Solution": f"{c[\'token\']}:{n}"'])}
print(json.load(urllib.request.urlopen(req)))`;
  return `import base64, json, urllib.error, urllib.request

${send([])}
try:
    urllib.request.urlopen(req)
except urllib.error.HTTPError as e:
    quote = json.loads(base64.b64decode(e.headers["PAYMENT-REQUIRED"]))
    print(e.code, [(a["network"], a["amount"]) for a in quote["accepts"]])  # the price, per chain, in base units`;
}

function curlExample(baseUrl, tool) {
  const input = tool.discovery?.input ?? {};
  if (tool.method === "GET") {
    return `curl -i "${baseUrl}${tool.path}${exampleQueryString(tool)}"`;
  }
  const body = JSON.stringify(input).replace(/'/g, "'\\''");
  return `curl -i -X ${tool.method} ${baseUrl}${tool.path} \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}

/** How an object in a tool's example is described in the response table: its
 *  field count and its first names, each whole. At most six names, and as many
 *  as keep the text within 80 characters (the first is always given); the rest
 *  are counted ("and 2 more"), three short words a narrow cell keeps together
 *  on its last line, where a name cut mid-word left one fragment alone. */
const LONE_NAME_CHARS = 12;
export function objectFieldsSample(v, max = 80) {
  const keys = Object.keys(v);
  const head = `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  if (!keys.length) return head;
  const tail = (shown) => (shown < keys.length ? ` and ${keys.length - shown} more` : "");
  let shown = 1;
  while (shown < Math.min(keys.length, 6) && `${head}: ${keys.slice(0, shown + 1).join(", ")}${tail(shown + 1)}`.length <= max) shown += 1;
  // A whole list that would end on one long name leaves that name alone on a
  // narrow cell's last line: count it instead, so the line ends "and 1 more".
  if (shown === keys.length && shown >= 2 && keys[shown - 1].length >= LONE_NAME_CHARS) shown -= 1;
  return `${head}: ${keys.slice(0, shown).join(", ")}${tail(shown)}`;
}

/** What the input schema itself says about one field, as a sentence for the
 *  parameters table: its allowed values, its default, its range or length,
 *  and the value the published example sends. Each fact is read from the
 *  schema, so a page states only what the route enforces or documents. */
export function paramLimits(v, exampleValue) {
  if (!v || typeof v !== "object") return "";
  const e = ledgerEsc;
  const out = [];
  const lit = (x) => `<code>${e(typeof x === "string" ? x : JSON.stringify(x))}</code>`;
  const en = Array.isArray(v.enum) ? v.enum : Array.isArray(v.items?.enum) ? v.items.enum : null;
  if (en && en.length && en.length <= 12) out.push(`One of ${en.map(lit).join(", ")}.`);
  else if (en && en.length > 12) out.push(`One of ${en.length} listed values.`);
  if (v.default !== undefined && v.default !== null && JSON.stringify(v.default).length <= 40) out.push(`Default ${lit(v.default)}.`);
  const lo = v.minimum ?? v.exclusiveMinimum, hi = v.maximum ?? v.exclusiveMaximum;
  if (Number.isFinite(lo) && Number.isFinite(hi)) out.push(`From ${e(String(lo))} to ${e(String(hi))}.`);
  else if (Number.isFinite(lo)) out.push(`At least ${e(String(lo))}.`);
  else if (Number.isFinite(hi)) out.push(`At most ${e(String(hi))}.`);
  if (Number.isFinite(v.maxLength)) out.push(`Up to ${e(String(v.maxLength))} characters.`);
  if (Number.isFinite(v.maxItems)) out.push(`Up to ${e(String(v.maxItems))} items.`);
  if (typeof v.format === "string") out.push(`Format ${lit(v.format)}.`);
  if (exampleValue !== undefined && exampleValue !== null && typeof exampleValue !== "object" && String(exampleValue).length <= 48 && !en) out.push(`The example sends ${lit(exampleValue)}.`);
  return out.join(" ");
}

// The prose word count scripts/lib/tool-page-prose.js budgets (a token with a
// letter or a digit; <code> spans and tags left out), so the lead can size its
// sentence to the room the badge and the meta row leave. A scan, not a pattern:
// it counts and never sanitizes.
function proseWordCount(html) {
  const src = String(html ?? "");
  let text = "", i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { text += src.slice(i); break; }
    text += src.slice(i, lt) + " ";
    if (src.startsWith("<code", lt) && /[\s>]/.test(src.charAt(lt + 5))) {
      const close = src.indexOf("</code>", lt);
      i = close < 0 ? src.length : close + 7;
      continue;
    }
    const gt = src.indexOf(">", lt);
    i = gt < 0 ? src.length : gt + 1;
  }
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w.replace(/&[a-z]+;|&#\d+;/gi, ""))).length;
}

// Where a cut lead may not stop: a bare number or price, and a connecting
// word (article, preposition, conjunction). scripts/lib/tool-page-prose.js
// holds the same two lists for the served pages.
const LEAD_END_NUMBER = /^[$€£]?\d[\d.,:/-]*%?$/;
const LEAD_END_WORD = /^(?:a|an|the|and|or|nor|but|of|on|in|to|for|by|with|from|at|as|via|into|onto|per|than|that|which|its|is|are|plus|over|under|across|between|through|within|without|when|while|if|vs)$/i;
const LEAD_ABBREVIATION = /(?:^|[^a-z])(?:e\.g|i\.e|vs|etc|approx|incl|dept|inc|corp|co|ltd|no|st|u\.s)\.$/i;

/** A sentence fitted to `n` words. A cut is made, in this order, at:
 *  the last sentence end inside the room (the lead then ends with its own
 *  period); the last clause boundary that leaves 8 words or more (a comma,
 *  semicolon, colon or closing bracket, or the word before a spaced dash or
 *  an opening parenthesis), ending "." after a semicolon and "..." otherwise; the last word that passes the same checks.
 *  No cut lands inside an open parenthesis, bracket, brace or quote, on a
 *  number or price, or on a connecting word. A sentence with no boundary in
 *  the room is cut at a word, which scripts/test-tool-page-words.js fails:
 *  that tool sets a `pageSummary` whose first sentence fits. */
function cutWords(text, n) {
  const words = String(text).trim().split(/\s+/);
  if (words.length <= n) return words.join(" ");
  const room = Math.max(3, n);
  const minKeep = Math.min(8, room);
  const bare = (w) => w.replace(/[\s,;:.!?)\]}"'`]+$/g, "").replace(/^[(\[{"'`]+/, "");
  const clean = (w) => { const b = bare(w); return b !== "" && !LEAD_END_NUMBER.test(b) && !LEAD_END_WORD.test(b); };
  let depth = 0, quote = false, tick = false;
  let sentence = -1, clause = -1, clauseEnds = "", word = -1;
  for (let i = 0; i < room; i++) {
    const w = words[i];
    for (const ch of w) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === '"') quote = !quote;
      else if (ch === "`") tick = !tick;
    }
    if (depth > 0 || quote || tick || w === "-" || !clean(w)) continue;
    const kept = i + 1;
    if (/[.!?]$/.test(w)) { if (kept >= 4 && !LEAD_ABBREVIATION.test(w)) sentence = kept; continue; }
    if (kept < minKeep) continue;
    word = kept;
    const next = words[i + 1] || "";
    const before = next === "-" || next === "\u2013" || next.startsWith("(");
    if (/[,;:)\]}]$/.test(w) || before) { clause = kept; clauseEnds = before ? "" : w.at(-1); }
  }
  const upTo = (k) => words.slice(0, k).join(" ");
  const trimmed = (k) => upTo(k).replace(/[\s,;:\-.]+$/g, "");
  if (sentence > 0) return upTo(sentence);
  if (clause > 0) return trimmed(clause) + (clauseEnds === ";" ? "." : "...");
  if (word > 0) return trimmed(word) + "...";
  const head = words.slice(0, room);
  while (head.length > 3 && !clean(head.at(-1))) head.pop();
  return head.join(" ").replace(/[\s,;:\-(.]+$/g, "") + "...";
}

/** Lead budget in prose words (scripts/test-tool-page-words.js holds every page to it). */
export const TOOL_LEAD_MAX_WORDS = 45;

export function toolPage(baseUrl, tool, related, { computePayable = false, powDifficulty = 0, cacheTtl = null, otherMethodRouted = false, mpp = true } = {}) {
  // MPP rides the shim, which mounts only with MPP_SECRET_KEY: a self-host
  // without it offers x402 alone, so the page names only the rails it has.
  const orMpp = mpp ? " or MPP" : "";
  const e = ledgerEsc;
  const title = toolTitle(tool);
  const canonical = `${baseUrl}/tools/${tool.slug}`;
  const catLabel = CATEGORIES[tool.category]?.label ?? tool.category;
  const catHref = `/tools/category/${tool.category}`;
  const crumbs = breadcrumbTrail(baseUrl, [["Home", "/"], ["Tools", "/tools"], [catLabel, catHref], [tool.name, `/tools/${tool.slug}`]]);
  const pw = priceWords(tool);
  const schema = tool.discovery?.inputSchema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const example = tool.discovery?.output?.example;
  const captured = tool.discovery?.output?.captured || null;
  const input = tool.discovery?.input ?? {};
  // A tool that names its only networks (`onlyNetworks`, e.g. decide-execute:
  // Base) is offered on exactly those (payments.js acceptsForItem), so the page
  // names them (railsOrFor) rather than "EVM chains".
  const evmOnly = x402EvmOnly(tool);
  const binaryTypes = binaryTypesOf(tool);
  const hasOnly = Array.isArray(tool.onlyNetworks) && tool.onlyNetworks.length > 0;
  const evmOne = hasOnly ? railsOrFor(tool) : "USDC on an EVM chain";
  const isPack = tool.category === "skill-pack";
  // The paid-call snippet caps each payment at this tool's own highest price.
  const spendCap = displayPrice(`$${tool.quoteRange && Number.isFinite(tool.quoteRange.maxUsd) ? tool.quoteRange.maxUsd : priceUsdOf(tool)}`);
  const packSlug = isPack ? tool.slug.replace(/^skill-/, "") : null;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebAPI",
      name: `Agent402 ${tool.name}`,
      url: canonical,
      description: tool.description,
      documentation: `${baseUrl}/openapi.json`,
      provider: siteOrgRef(baseUrl),
      offers: {
        "@type": "Offer",
        price: tool.price.replace("$", ""),
        priceCurrency: "USD",
        description: `${pw.long}, paid over x402 in ${railsOrFor(tool)}${orMpp}. No signup, no API key.${computePayable ? " Or free with proof-of-work (no wallet)." : ""}`,
      },
    },
    crumbs.ld,
  ];

  // --- How this tool is paid (the first line under "Errors and behavior").
  // A quoted route says its range here, once.
  const payWhat = tool.quoteRange ? `per request (${displayPrice(fromPriceLabel(tool))} to $${tool.quoteRange.maxUsd}, quoted from this body)` : pw.long;
  const payHow = evmOnly
    ? `Pay ${payWhat} over x402 with ${evmOne}${tool.longRunning ? orMpp : ""}`
    : `Pay ${payWhat} over x402${orMpp}`;
  // A binary tool's example is a note about the bytes, not a response shape.
  const outKeys = !binaryTypes && example && typeof example === "object" && !Array.isArray(example) ? Object.keys(example) : [];
  const binaryPhrase = binaryTypes ? `raw bytes, not JSON, with <code>Content-Type</code> ${listWords(binaryTypes.map((t) => `<code>${ledgerEsc(t)}</code>`))}` : "";
  // The lead is the tool's first sentence; the rest of its description is the
  // Details section. A trailing query hint ("?q=inflation&rows=10") repeats the
  // parameters table and the example request, so neither shows it.
  const dropQueryHint = (t) => t.replace(/(?:\s*Query params?:)?\s*\?[A-Za-z_][\w-]*=\S*(?:\s+\(optional\))?\.?$/, "").trim();
  // A tool with a pageSummary (a shorter text for this page only) shows it
  // here; every listing and the meta description keep the full description.
  // Each source credit the catalog put in the description (attribute() in
  // src/data-attribution.js) ends the summary too.
  const credits = tool.pageSummary ? ATTRIBUTION_TAILS.filter((c) => String(tool.description || "").includes(c) && !String(tool.pageSummary).includes(c)) : [];
  const pageText = tool.pageSummary ? [String(tool.pageSummary).trim(), ...credits].join(" ") : tool.description;
  const descFlat = String(pageText).replace(/\s+/g, " ").trim();
  const leadFull = firstSentence(pageText);
  const restShown = dropQueryHint(descFlat.slice(leadFull.length).trim());
  // --- Parameters table from the input schema, plus accepted alternative names.
  const aliasFor = (name) => {
    const alts = PARAM_ALIASES[name];
    if (!alts || !required.includes(name)) return [];
    return alts.filter((a) => !(a in props));
  };
  const paramRows = Object.entries(props).map(([k, v]) => {
    const req = required.includes(k);
    const alts = aliasFor(k);
    const altNote = alts.length ? ` <span style="color:var(--faint);">Also accepted as ${alts.map((a) => `<code>${e(a)}</code>`).join(", ")}.</span>` : "";
    const limits = paramLimits(v, input[k]);
    const limitNote = limits ? ` <span style="color:var(--faint);">${limits}</span>` : "";
    return `<tr><td><code>${e(k)}</code></td><td>${e(schemaType(v))}</td><td>${req ? "yes" : "no"}</td><td>${e(v.description ?? "")}${altNote}${limitNote}</td></tr>`;
  }).join("\n");

  // --- Response fields from the documented example (same derivation as /openapi.json).
  const respSchema = responseSchemaFor(tool.path, example, tool.discovery?.output?.optional);
  const respRequired = new Set(respSchema.required || []);
  const optionalOut = !binaryTypes && tool.discovery?.output?.optional && typeof tool.discovery.output.optional === "object" ? Object.entries(tool.discovery.output.optional).filter(([k]) => !outKeys.includes(k)) : [];
  const respRows = [...outKeys.map((k) => {
    const v = example[k];
    let sample = typeof v === "string" ? v : v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"} in the example` : null;
    if (sample === null) sample = objectFieldsSample(v);
    else if (sample && sample.length > 80) sample = sample.slice(0, 77) + "...";
    return `<tr><td><code>${e(k)}</code></td><td>${e(exampleValueType(v))}</td><td>${respRequired.has(k) ? "yes" : "no"}</td><td>${e(sample ?? "")}</td></tr>`;
  }), ...optionalOut.map(([k, v]) => `<tr><td><code>${e(k)}</code></td><td>${e(String(v?.type || ""))}</td><td>no</td><td>${e(String(v?.description || ""))}</td></tr>`)].join("\n");

  // --- Errors and behavior: one line per fact, only facts that hold for this tool.
  const facts = [];
  const inputErrorBody = "<code>error</code>, <code>tool</code>, <code>expected</code>, <code>required</code> and <code>example</code>";
  if (isPack) {
    facts.push(`Arguments left out take the pack's defaults. The call succeeds when at least one step does; a run where every step fails is refused (400 when the input caused it, 502 otherwise).`);
  } else if (required.length) {
    facts.push(`Required: ${codeList(required, 6)}; a rejected input answers 4xx with ${inputErrorBody}.`);
  } else if (Object.keys(props).length) {
    facts.push(`Every field is optional; a rejected input answers 4xx with ${inputErrorBody}.`);
  } else {
    facts.push(`No input: any request to ${e(tool.path)} runs the tool.`);
  }
  // Settlement on failure, per rail this route offers, stated for this route:
  // x402, MPP evm and card settle only after an under-400 answer and a credits
  // key is debited only on a 200; the settle-first sentence is added only on a
  // route that may settle first (def.settlesFirst); a Tempo PUSH credential is
  // a transfer already on chain before the tool runs (src/mpp-tempo.js), so a
  // failure there is a refund owed (src/tempo-push-debts.js).
  const tempoHere = tempoOfferedFor(tool) && !!tempoDiscoveryInfo();
  const notCharged = ["x402", ...(mpp ? ["MPP"] : []), ...(tool.identityBound || paysThirdParty(tool) ? [] : ["a credits key"])];
  // A job's payment settles on its answer: said in the same line, so the
  // settle-first sentence (only on a route that may settle first) follows
  // both claims once. A slow route's description already states its run time
  // and the wait header (server.js runTimeNote), so the line keeps to the job;
  // a pageSummary carries no such note, so the line states both.
  const runStated = /Prefer: wait=/.test(descFlat);
  const waitPart = tool.runSeconds && !runStated
    ? ` It takes up to ${e(String(tool.runSeconds))} seconds${needsAsyncOrWait(tool.asyncProfile) ? `; or send <code>Prefer: wait=${e(String(tool.runSeconds))}</code> and keep the connection open (a paid call with neither header is answered <code>400</code> before any payment is taken)` : ", or keep the connection open that long"}.`
    : "";
  const jobPart = tool.runSeconds || tool.asyncProfile
    ? ` <code>Prefer: respond-async</code> answers <code>202</code> with a job link to poll (<code>GET /api/jobs/{id}</code>), and its payment settles only when the answer is ready${tempoHere ? JOB_PUSH_EXCEPTION : ""}.${waitPart}`
    : "";
  facts.push(`${e(routeFailedCallLine({ rails: notCharged }))}${jobPart}${e(settleFirstClause(tool))}${tempoHere ? ` ${e(TEMPO_PUSH_SHORT)}` : ""}`);
  const creditsLine = tool.identityBound ? "" : paysThirdParty(tool) ? " It buys from an outside seller with our wallet, so prepaid credits and cards do not pay it." : (creditsSalesEnabled() ? " A prepaid card-credits key (<code>Authorization: Bearer a402_...</code>) also pays it." : " A card-credits key issued earlier (<code>Authorization: Bearer a402_...</code>) also pays it.");
  if (computePayable) facts.unshift(`${e(payHow)}, or free with proof-of-work (${e(String(powDifficulty))} leading zero bits of sha256): this tool makes no outbound network call.`);
  else if (tool.modelBacked) facts.unshift(`${e(payHow)}. Wallet-only, model-backed: no proof-of-work tier; the same input can give a different result.${creditsLine}`);
  else facts.unshift(`${e(payHow)}. Wallet-only: this tool ${WALLET_ONLY_POLICY_REASON.has(tool.slug) ? e(WALLET_ONLY_POLICY_REASON.get(tool.slug)) : "reaches the network or stored state"}, so it has no proof-of-work tier.${creditsLine}`);
  // A free-tier tool is never model-backed today; if one were, it still says so.
  if (tool.modelBacked && computePayable) facts.push(`Model-backed: the answer is generated by a model, so the same input can produce a different result.`);
  // G.S. 105-164.7(2): a tax-included price is shown with a statement saying so.
  if (ncTaxableKind(tool.slug)) facts.push(`Sales tax: the price includes North Carolina sales tax for a card buyer billed to a North Carolina address.`);
  if (tool.identityBound) facts.push(`Identity-bound: results are keyed to the paying wallet, so only EVM x402 payments are accepted; credits keys and Tempo are refused.`);
  else if (tool.longRunning) {
    // Read from the offers this route's 402 carries (mppOffersFor), so the
    // sentence names exactly what a buyer can pay with here.
    const lrMpp = mpp ? mppRailsPhrase(mppOffersFor({ priceUsd: priceUsdOf(tool), identityBound: false, longRunning: true })) : "";
    facts.push(`Long-running: x402 is offered on EVM chains only${lrMpp ? ` and MPP on ${e(lrMpp)}` : ""}; Tempo is not offered.`);
  }
  if (tool.judgedChoice && toolJudgeEnabled()) facts.push(`A judgment model picks among the shortlisted tools; the chosen tool runs unchanged, so the answer is the tool's own.`);
  if (tool.quoteRange && tool.quoteFormula) facts.push(`The quote is ${e(tool.quoteFormula)}.`);
  if (isMeteredChatSlug(tool.slug)) facts.push(e(meteredTimeoutSentence()));
  // The tier rule in one line (the whole note is on /api/pricing and /openapi.json).
  if (typeof tool.tierQuote === "function") facts.push(`A body naming another flat tier's model is quoted and served at that tier's price; the answer names it in <code>agent402_tier</code>.`);
  if (cacheTtl) facts.push(`Cached: an identical request within ${e(fmtTtl(cacheTtl))} is answered from cache with <code>X-Cache: hit</code>.`);
  // The method alias (server.js) runs only when no catalog route of the other
  // method shares this path: /api/memory has both, so neither page says it.
  if (!otherMethodRouted) {
    facts.push(tool.method === "GET"
      ? `A <code>POST</code> with a JSON body is served as this GET.`
      : `A bodyless <code>GET</code> or <code>HEAD</code> returns the same 402 quote.`);
  }
  // The replay cache holds JSON answers only (it captures res.json) and only
  // up to IDEM_MAX_BODY_BYTES; bytes and streams are never replayed.
  if (binaryTypes) facts.push(`An <code>Idempotency-Key</code> does not replay bytes: a retried paid call runs and is charged again.`);
  else facts.push(`An <code>Idempotency-Key</code> replays the first 200 uncharged (an answer larger than ${e(IDEM_MAX_BODY_LABEL)}${String(tool.path).startsWith("/v1/") ? " or streamed is" : " is"} not replayed).`);

  // --- MCP usage.
  const mcpArgs = JSON.stringify({ slug: tool.slug, params: input }, null, 2);
  const mcpNote = computePayable
    ? `Hosted connector (<code>${e(baseUrl)}/mcp</code>): free, rate-limited. Stdio package: <code>npx -y agent402-mcp@0.17.1</code>.`
    : `Hosted connector (<code>${e(baseUrl)}/mcp</code>): paid in the call. Stdio package (<code>npx -y agent402-mcp@0.17.1</code>): pays from a wallet${tool.identityBound || paysThirdParty(tool) ? "" : creditsSalesEnabled() ? " or <code>AGENT402_CREDITS_KEY</code>" : " or an <code>AGENT402_CREDITS_KEY</code> issued earlier"}.`;

  const aliases = (Array.isArray(tool.aliases) ? tool.aliases : []).filter((a) => a && a !== tool.slug);
  const tagsLine = (tool.tags || []).length ? (tool.tags || []).slice(0, 8).map((t) => `<code>${e(t)}</code>`).join(" ") : "";

  // Related tools and the packs that hold this tool: linked names only (each
  // page carries its own description and price).
  // A long name's trailing parenthetical rides in the link title, not its text.
  const shortName = (n) => { const s = String(n); const t = s.length > 24 ? s.replace(/\s*\([^()]*\)\s*$/, "").trim() : s; return t || s; };
  const relatedLinks = related.map((t) => { const n = shortName(t.name); return `<li><a href="/tools/${e(t.slug)}"${n !== t.name ? ` title="${e(t.name)}"` : ""}>${e(n)}</a></li>`; }).join("");
  const inPacks = SKILL_PACKS.filter((p) => (p.toolSlugs || []).includes(tool.slug));
  const packsHtml = inPacks.length
    ? `<h2 class="tp-h2">Part of these workflows</h2>
  <ul class="tp-links">${inPacks.map((p) => `<li><a href="/skills/${e(p.slug)}">${e(p.title)}</a></li>`).join("")}</ul>`
    : "";

  // The label sits on the dark panel, so it takes the panel accent (lit) for both methods.
  const methodColor = "var(--accent-lit)";

  // The H1 wraps balanced: tool names run from 3 chars ("hex") to 50+, and a
  // long name takes two even lines instead of an ellipsis, so the page's own
  // title is always whole. A JS comment, not a CSS one: the CSS block is served.
  const TOOL_PAGE_CSS = `
  .tp-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  .tp-h1 { font-family:var(--font-body); font-weight:800; font-size:var(--fs-3xl); line-height:1; letter-spacing:-.02em; margin-bottom:10px; text-wrap:balance; }
  @media (max-width:640px){ .tp-h1 { font-size:var(--fs-2xl); line-height:1.1; } }
  .tp-badge { display:inline-flex; flex-wrap:wrap; row-gap:4px; background:var(--panel); color:var(--on-panel); font-family:var(--font-mono); font-size:var(--fs-sm); padding:8px 16px; margin:8px 0 6px; }
  .tp-badge > span { white-space:nowrap; }
  .tp-badge > span + span::before { content:"·"; padding:0 8px; color:var(--on-panel-dim); }
  .tp-sub { color:var(--muted); font-size:var(--fs-lg); line-height:1.6; max-width:760px; }
  .tp-lead { color:var(--ink); font-size:var(--fs-lg); line-height:1.6; max-width:760px; margin:14px 0 6px; }
  .tp-sub code, .tp-lead code, .tp-facts code { background:var(--card); border:1px solid var(--hairline); font-family:var(--font-mono); padding:1px 5px; font-size:var(--fs-code-inline); }
  .tp-h2 { font-weight:700; font-size:var(--fs-xl); margin:40px 0 10px; letter-spacing:-.01em; }
  .tp-table { border-collapse:collapse; width:100%; font-size:var(--fs-md); }
  .tp-table td, .tp-table th { border:1px solid var(--hairline); padding:10px 12px; text-align:left; vertical-align:top; }
  .tp-table th { background:var(--card); font-weight:700; }
  .tp-tw { overflow-x:auto; }
  .tp-wrap .ml-code { margin:13px 0; }
  /* Target size (DESIGN.md): a link that is not inside a sentence is at least 24px tall. */
  .tp-meta a, .tp-links a { display:inline-block; padding:4px 0; }
  .tp-links { list-style:none; padding:0; margin:12px 0 0; display:flex; flex-wrap:wrap; gap:8px 12px; max-width:820px; }
  .tp-links li { background:var(--card); border:1px solid var(--hairline); padding:4px 12px; min-width:0; overflow-wrap:anywhere; }
  .tp-links a { color:var(--accent); font-weight:700; font-size:var(--fs-base); text-decoration:none; }
  .tp-free { display:inline-block; background:var(--ok); color:var(--paper); font-weight:700; font-size:var(--fs-2xs); letter-spacing:.02em; padding:2px 8px; font-family:var(--font-mono); vertical-align:middle; }
  .tp-facts { color:var(--muted); font-size:var(--fs-base); line-height:1.65; max-width:820px; padding-left:20px; }
  .tp-facts li { margin-bottom:6px; }
  .tp-meta { display:flex; flex-wrap:wrap; gap:6px 20px; color:var(--faint); font-size:var(--fs-sm); font-family:var(--font-mono); margin-top:10px; }
  .tp-meta > span { white-space:nowrap; }
  .tp-meta > .tp-tags { white-space:normal; display:flex; flex-wrap:wrap; gap:4px 8px; align-items:baseline; }
  .tp-tags > * { white-space:nowrap; }
  `;

  const badgeHtml = `<div class="tp-badge">${
    computePayable
      ? `<span><span class="tp-free">FREE</span> <span style="color:var(--on-panel-dim);">with proof-of-work</span></span><span style="color:var(--on-panel-muted);">or ${e(pw.short)} in USDC</span>`
      : `<span style="color:var(--on-panel);">${e(pw.long)}</span><span style="color:var(--on-panel-dim);">USDC via x402</span>`
  }<span><code style="color:${methodColor};background:transparent;font-size:var(--fs-sm);">${e(tool.method)}</code> <code style="color:var(--on-panel-muted);background:transparent;font-size:var(--fs-sm);">${e(tool.path)}</code></span>${
    cacheTtl ? `<span style="color:var(--on-panel-dim);" title="Server caches identical responses for ${e(fmtTtl(cacheTtl))}.">Cached ${e(fmtTtl(cacheTtl))}</span>` : ""
  }</div>`;
  const metaHtml = `<div class="tp-meta"><span>Category: <a href="${e(catHref)}" style="color:var(--accent);">${e(catLabel)}</a></span>${tagsLine ? `<span class="tp-tags"><span>Tags:</span> ${tagsLine}</span>` : ""}${aliases.length ? `<span class="tp-tags"><span>Also found as:</span> ${aliases.slice(0, 6).map((a) => `<code>${e(a)}</code>`).join(" ")}</span>` : ""}${isPack ? `<span><a href="/skills/${e(packSlug)}" style="color:var(--accent);">Pack overview</a></span>` : ""}</div>
  <p style="margin:16px 0 0;"><a class="btn btn-secondary btn-sm ml-cta" href="/playground?slug=${e(tool.slug)}" rel="nofollow" style="display:inline-block;">Try in playground →</a></p>`;
  // The lead is the first sentence, cut to the words the badge and the meta
  // row leave; a cut sentence is given whole under Details.
  const leadRoom = Math.max(8, TOOL_LEAD_MAX_WORDS - proseWordCount(badgeHtml) - proseWordCount(metaHtml));
  const leadShown = cutWords(leadFull, leadRoom);
  const leadCut = leadShown !== leadFull.trim().split(/\s+/).join(" ");
  const aboutText = leadCut ? dropQueryHint(descFlat) : restShown;
  const aboutHtml = aboutText || namesEdgar(tool)
    ? `<h2 class="tp-h2">Details</h2>
  ${aboutText ? `<p class="tp-sub tp-about">${e(aboutText)}</p>` : ""}
  ${namesEdgar(tool) ? `<p class="tp-mark-notice" style="font-size:var(--fs-xs);color:var(--faint);margin:8px 0 0;max-width:76ch;">${e(EDGAR_MARK_NOTICE)}</p>` : ""}`
    : "";

  const body = `<div class="tp-wrap">
  ${crumbs.nav}
  <h1 class="tp-h1" title="${e(tool.name)}">${e(tool.name)}</h1>
  ${badgeHtml}
  <p class="tp-lead">${e(leadShown)}</p>
  ${metaHtml}

  ${aboutHtml}

  <h2 class="tp-h2">Parameters</h2>
  ${paramRows ? `<div class="tp-tw"><table class="tp-table"><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr>${paramRows}</table></div>` : `<p class="tp-sub">${e(tool.name)} takes no parameters.</p>`}

  ${
    computePayable
      ? `<h2 class="tp-h2">Free call, no wallet</h2>
  <p class="tp-sub">Fetch a challenge, solve its sha256 puzzle (${e(String(powDifficulty))} leading zero bits), resend with <code>X-Pow-Solution</code>.</p>
  ${codeBlock(`import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("${baseUrl}/api/pow/challenge?slug=${tool.slug}")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
await fetch("${powSnippetRequest(baseUrl, tool).url}", { method: "${tool.method}", headers: { "X-Pow-Solution": c.token + ":" + n${tool.method === "POST" ? ', "Content-Type": "application/json"' : ""} }${tool.method === "POST" ? `, body: JSON.stringify(${JSON.stringify(input)})` : ""} });`, { name: "the proof-of-work call" })}
  <p class="tp-sub">Python:</p>
  ${codeBlock(pythonExample(baseUrl, tool, { computePayable }), { name: "the Python proof-of-work call" })}`
      : ""
  }

  <h2 class="tp-h2">Example request</h2>
  ${codeBlock(curlExample(baseUrl, tool), { name: "the request" })}

  <h2 class="tp-h2">Watch a call get paid</h2>
  ${paidCallFigure({ method: tool.method, path: tool.path, price: pw.short, chains: x402RailsFor(tool).length === 1 ? railsOrFor(tool) : x402RailsFor(tool).length })}

  <h2 class="tp-h2">Example response</h2>
  ${binaryTypes
    ? `<p class="tp-sub">A 200 carries ${binaryPhrase}: the file itself.</p>`
    : `${codeBlock(JSON.stringify(example ?? {}, null, 2), { name: "the response" })}${captured ? `\n  <p class="tp-sub tp-captured">${e(captureNote(captured))}</p>` : ""}`}
  ${respRows ? `<div class="tp-tw"><table class="tp-table"><tr><th>Field</th><th>Type</th><th>Always present</th><th>In the example</th></tr>${respRows}</table></div>` : ""}

  <h2 class="tp-h2">From an MCP client</h2>
  ${codeBlock(`catalog.call ${mcpArgs}`, { name: "the MCP call" })}
  <p class="tp-sub">${mcpNote}</p>

  <h2 class="tp-h2">Errors and behavior</h2>
  <ul class="tp-facts">${facts.map((f) => `<li>${f}</li>`).join("\n")}</ul>

  <h2 class="tp-h2">Paid call (JavaScript agent)</h2>
  ${codeBlock(`import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.({ maxAmountPerPayment: "${spendCap}" }); // refuse any quote above this tool's price
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

${payExample(baseUrl, tool)}`, { name: "the paid call" })}
  <p class="tp-sub">${getWalletShortHtml()}</p>
${computePayable ? "" : `
  <h2 class="tp-h2">The quote (Python)</h2>
  ${codeBlock(pythonExample(baseUrl, tool), { name: "the Python quote" })}`}

  ${packsHtml}

  ${relatedLinks ? `<h2 class="tp-h2">Related tools</h2>
  <ul class="tp-links">${relatedLinks}</ul>` : ""}
</div>
${ledgerFooterCompact()}
${paidCallScript()}`;

  return ledgerShell({
    title,
    description: toolMetaDescription(tool, { computePayable, mpp }),
    canonical,
    baseUrl,
    activePath: "/tools",
    ogImage: `${baseUrl}/tools/${tool.slug}/card.png?v=${CARD_ART_VERSION}`,
    jsonLd,
    extraCss: TOOL_PAGE_CSS + PAID_CALL_CSS,
    body,
    mpp,
  });
}

// Price line for the new ledger card style: a run of tags (.ml-meta), so a
// narrow card wraps between "FREE w/ compute", the price and the route, never
// inside one of them.
function ledgerPriceLine(tool) {
  const p = ledgerEsc(priceWords(tool).short);
  const route = `<span style="white-space:normal;"><code style="background:transparent;color:var(--faint);font-size:var(--fs-xs);">${ledgerEsc(tool.method)} ${ledgerEsc(tool.path)}</code></span>`;
  const price = isComputePayable(tool)
    ? `<span><span style="background:var(--ok);color:var(--paper);font-weight:700;font-size:var(--fs-2xs);padding:1px 6px;font-family:var(--font-mono);">FREE</span> w/ compute</span><span>or ${p}</span>`
    : `<span>${p}</span>`;
  return `<div class="ml-meta" style="margin:0;font-size:var(--fs-xs);color:var(--accent);">${price}${route}</div>`;
}

/** Category landing page — /tools/:category shows all tools in one category. */
export function categoryPage(baseUrl, catalog, catKey) {
  const e = ledgerEsc;
  const cat = CATEGORIES[catKey];
  if (!cat) return null;
  const tools = toolList(catalog).filter((t) => t.category === catKey);
  if (!tools.length) return null;
  const freeCount = tools.filter(isComputePayable).length;
  const canonical = `${baseUrl}/tools/category/${catKey}`;
  const nTools = `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
  const title = `${cat.label} - ${nTools} | Agent402`;
  const description = firstFit([`${cat.blurb} ${nTools}, ${freeCount} free via proof-of-work.`, `${cat.label}: ${nTools} Agent402 tools priced per call, ${freeCount} free via proof-of-work.`]);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: cat.label,
    description: cat.blurb,
    url: canonical,
    numberOfItems: tools.length,
    itemListElement: tools.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, url: `${baseUrl}/tools/${t.slug}` })),
  };
  const cards = tools.map((t) => {
    const desc = cutAtWord(firstSentence(t.description), 120);
    return `<div style="background:var(--card);border:1px solid var(--hairline);padding:18px 20px;display:flex;flex-direction:column;gap:8px;min-width:0;overflow-wrap:break-word;">
  <h3 style="font-size:var(--fs-base);margin:0;"><a href="/tools/${e(t.slug)}" style="text-decoration:none;color:var(--ink);">${e(t.name)}</a></h3>
  ${ledgerPriceLine(t)}
  <p style="color:var(--muted);font-size:var(--fs-sm);margin:0;line-height:1.5;flex:1;">${e(desc)}</p>
  <a href="/playground?slug=${e(t.slug)}" rel="nofollow" style="font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--accent);text-decoration:none;font-weight:700;">try in playground →</a>
</div>`;
  }).join("\n");

  const crumbs = breadcrumbTrail(baseUrl, [["Home", "/"], ["Tools", "/tools"], [cat.label, `/tools/category/${catKey}`]]);
  const CAT_CSS = `
  .cp-grid { display:grid; gap:14px; margin:20px 0; }
  @media (min-width:640px){ .cp-grid { grid-template-columns:repeat(3,1fr); } }
  `;

  const body = `<div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
  ${crumbs.nav}
  <h1 style="font-family:var(--font-body);font-weight:800;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin-bottom:10px;">${e(cat.label)}</h1>
  <p style="color:var(--muted);font-size:var(--fs-lg);line-height:1.6;max-width:720px;">${e(cat.blurb)}</p>
  <div style="background:var(--card);border:1px solid var(--hairline);padding:16px 20px;margin:18px 0;font-size:var(--fs-base);"><b style="color:var(--accent);">${nTools}</b> in this category${freeCount ? ` - <b style="color:var(--accent);">${freeCount} free</b> via proof-of-work` : ""}. <a href="/tools" style="color:var(--accent);">\u2190 All tools</a></div>
  <div class="cp-grid">${cards}</div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/tools",
    jsonLd: [jsonLd, crumbs.ld],
    extraCss: CAT_CSS,
    body,
  });
}

// On-site FAQ — surfaces the wiki FAQ for Google (FAQPage rich results) and for
// humans/agents landing on the site. The Q&A pairs are the single source for
// BOTH the visible HTML and the JSON-LD, so they can't drift apart. Answers may
// contain simple inline HTML (links) — allowed in FAQPage and rendered as-is.
// A function, not a constant: whether credits are on sale is read at render.
// Each answer is the fact plus a link to the page that holds the detail; the
// groups are the page's headings, in order.
export const FAQ_GROUPS = [
  ["paying", "Paying"],
  ["protocols", "x402 and MPP"],
  ["models", "Models and data"],
  ["sellers", "Sellers and the index"],
  ["service", "The service"],
];
export function faqItems() {
  const creditsOnSale = creditsSalesEnabled();
  return [
  { g: "paying", q: "Do I need an account or API key?", a: `No. Nothing here has a signup. Payment - USDC, proof-of-work, or a prepaid card-credits key${creditsOnSale ? ' you bought at <a href="/credits">/credits</a>' : " you already hold"} - is the only credential, charged per call.` },
  { g: "paying", q: "Can I pay by card instead of crypto?", a: `Yes: buy a finished report at <a href="/reports">/reports</a> (${cardReportPriceRange(HUMAN_PRODUCTS)?.text || "priced per report"} by card, refunded if it fails) or subscribe to a monitor at <a href="/monitors">/monitors</a> (${reportLadderProse({ monitorProducts: MONITOR_PRODUCTS }).monthly || "priced per month"} a month, cancel anytime).${creditsOnSale ? ' Prepaid credits at <a href="/credits">/credits</a> pay any paid tool except the wallet-scoped ones and the routes that buy from an outside seller, with <code>Authorization: Bearer a402_…</code>, debited only when a call succeeds; the unspent balance is refunded to your card on request.' : " Prepaid card credits are not on sale; a credits key bought earlier still pays any tool with <code>Authorization: Bearer a402_…</code>, debited only when a call succeeds."}` },
  // DERIVED. Every figure in this answer was typed once and then outlived two
  // repricings: the pack ceiling was over ten times the real one and the card
  // range was quoted below its own floor, which a reader meets at checkout.
  { g: "paying", q: "What does it cost?", a: `Flat per-call prices from $0.001; most tools are ${TYPICAL_PRICE_RANGE.text}, premium AI and media tiers higher, skill packs ${PACK_PRICE_RANGE.text}, and report products ${agentReportPriceRange()?.text || "priced per product"} for an agent (${cardReportPriceRange(HUMAN_PRODUCTS)?.text || "priced per product"} by card, which includes payment processing). Every price is in <a href="/api/pricing">/api/pricing</a> and quoted in each 402; the metered model route quotes each request from its body.` },
  { g: "paying", q: "Can I use it without any money or a wallet?", a: `Yes. Most pure-CPU tools accept proof-of-work - a sha256 puzzle solved by your own CPU (${powCostPhrase()}) - and the hosted MCP connector runs that same set for free (rate-limited).` },
  { g: "paying", q: "Which blockchain and asset does it use?", a: `${RAILS_PAREN}. The buyer needs only the stablecoin - gas is sponsored by the facilitator on EVM chains.` },
  { g: "paying", q: "What happens if a tool fails after I pay?", a: `Over x402 an error is not charged: settlement runs only after a successful (under-400) response. ${SETTLE_FIRST_SENTENCE} A payment final before the call runs (a Tempo push transfer over MPP) is recorded when the call fails and repaid on chain; look one up with <code>GET /api/refunds/lookup?tx=&lt;hash&gt;</code>. A few tools charge a partial result by design and say so in their description.` },
  { g: "protocols", q: "What is x402?", a: 'An open HTTP payment standard built on the 402 Payment Required status code, for machine-to-machine pay-per-call payments in stablecoins, with settlement infrastructure from Coinbase. How a paid request works here: <a href="/what-is-x402">x402 and MPP on Agent402</a>.' },
  { g: "protocols", q: "What is MPP, and does Agent402 support it?", a: 'Yes. MPP (Machine Payments Protocol) carries the same pay-per-call handshake in HTTP&rsquo;s standard auth headers. Every paid endpoint accepts its evm method, and most also accept its tempo method (memory and the long-running report routes take evm only), at the same URL and price. Header by header: <a href="/what-is-x402#compare">the comparison table</a>; how a payment works here: <a href="/what-is-mpp">MPP on Agent402</a>.' },
  { g: "models", q: "Does using this spend my AI tokens?", a: "No. You never hand us a model key; a model we run is billed to us and priced into the call. Most of the catalog is deterministic code (parsers, hashes, math, a real browser). The model-backed ones are named: the /v1 gateway tiers, the report products, Decide (<code>/api/decide</code>), the router's judgment model, and the image, speech, transcription, embedding and AI-answer tools." },
  { g: "models", q: "Is there an OpenAI-compatible endpoint?", a: 'Yes. Point any OpenAI SDK at <code>base_url https://agent402.tools/v1/metered</code> (with <code>/v1/metered/messages</code> and <code>/v1/metered/responses</code> twins), paid per call in USDC over x402 or MPP with no API key. How each request is quoted: <a href="/guides/x402-in-5-minutes">the five-minute guide</a>; flat tiers, embeddings and images: <a href="/pricing">/pricing</a>.' },
  { g: "models", q: "Is my data stored?", a: 'Tool inputs are processed in memory. The memory tools store data by design (wallet-keyed, owner-deletable, optional TTL); the other cases, such as short-lived response caches and decisions bought on /api/decide (30 days), are listed in <a href="/privacy">/privacy</a>.' },
  { g: "sellers", q: "Can I find tools on other x402 sellers from here?", a: `Yes. <code>POST /api/route</code> ranks tools across every x402 seller we have crawled, found in public discovery registries re-read ${discoveryIntervalLabel()} and re-probed ${crawlIntervalLabel()}; a seller whose latest crawl failed is skipped until a crawl succeeds (its last five crawls set its health score), and a new one starts routable. Browse <a href="/marketplace">/marketplace</a> or page through <a href="/api/index">/api/index</a> (<code>?seller=&lt;host&gt;</code> for one origin), both free.` },
  { g: "sellers", q: "How do I list my own API?", a: 'For free: your origin is auto-discovered from public x402 discovery registries once it is live, or paste it on <a href="/sell">/sell</a> (or call <code>POST /api/index/register</code>) for an immediate probe. Settlement lands straight in your wallet, with 0% take.' },
  { g: "sellers", q: "How do I see which x402 sellers are most used?", a: `<code>GET <a href="/api/leaderboard">/api/leaderboard</a></code> returns the head of the on-chain ranking of x402 sellers by Base USDC settled volume: 25 rows by default, up to 50 with <code>?top=N</code>, and <code>totalSellers</code> for the full count. It refreshes ${leaderboardCadence()}, leaves Agent402 out unless you add <code>?include=all</code>, and <a href="/leaderboard">/leaderboard</a> shows how it is built.` },
  { g: "sellers", q: "How does the Smart Order Router decide which seller to route to?", a: `${routerRankingSentence()} If the model declines every candidate, route-and-execute refuses before anything is paid. ${routingProofSentence()} More: <a href="/guides/smart-order-router">the router guide</a>.` },
  { g: "service", q: "How do I know the service is honest?", a: 'The server is open source; CI re-tests every tool that runs without a third-party key against its own documented example before each deploy. The wallet-identity tools (memory and usage), which need a paying wallet, ' + (kalshiToolsEnabled() ? 'and one prediction-market family whose upstream throttles CI runners ' : '') + 'get a looser check, and one rate-limited data family runs on a rotation, covered across runs. Revenue settles on chain to the receiving wallets listed in <a href="/.well-known/x402">/.well-known/x402</a> (agent402.base.eth on Base and the other EVM chains).' },
  { g: "service", q: "Is Agent402 self-hostable and open source?", a: 'Yes - the server is open source under the AGPL-3.0 license (the client SDK, MCP connector, and tollbooth are MIT). Clone the repo and run it yourself for free, with or without payments enabled. It also ships agent402-tollbooth, an open-source pay-per-crawl gate for charging AI crawlers on your own site.' },
  { g: "service", q: "Who runs Agent402?", a: `Havok Holdings LLC - a public, contactable maintainer reachable at <a href="mailto:help@agent402.tools">help@agent402.tools</a>, on <a href="${REPO_URL}">GitHub</a>, and on <a href="https://x.com/Agent402Tools">X</a>.` },
  ];
}

export function faqPage(baseUrl) {
  const e = ledgerEsc;
  const canonical = `${baseUrl}/faq`;
  const title = "Agent402 FAQ: paying for AI agent tools over x402 and MPP";
  const description =
    "Answers for builders: how AI agents find, pay for and verify pay-per-call tools over x402 and MPP, the free proof-of-work tier, MCP and self-hosting.";
  const FAQ_ITEMS = faqItems();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: it.a },
    })),
  };

  const FAQ_CSS = `
  .fq-item { border-bottom:1px solid var(--hairline); }
  .fq-group { max-width:900px; margin:0 0 40px; }
  .fq-group h2 { padding-bottom:6px; border-bottom:1px solid var(--hairline); }
  .fq-item > summary { list-style:none; cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 0; font-family:var(--font-body); font-weight:800; font-size:var(--fs-lg); line-height:1.3; color:var(--ink); }
  .fq-item > summary::-webkit-details-marker { display:none; }
  .fq-mark { font-family:var(--font-mono); font-weight:400; font-size:var(--fs-xl); line-height:1; color:var(--accent); flex:none; transition:transform var(--dur-fast) ease; display:inline-block; }
  .fq-item[open] .fq-mark { transform:rotate(45deg); }
  @media (prefers-reduced-motion:reduce){ .fq-mark { transition:none; } }
  .fq-item p { color:var(--muted); font-size:var(--fs-base); line-height:1.7; margin:0; padding:0 0 22px; max-width:760px; }
  .fq-item a { color:var(--accent); }
  .fq-item code { background:var(--panel); color:var(--on-panel); font-family:var(--font-mono); padding:2px 6px; font-size:var(--fs-sm); }
  `;

  const item = (it, open) => `<details class="fq-item"${open ? " open" : ""}><summary><span>${e(it.q)}</span><span class="fq-mark">+</span></summary><p>${it.a}</p></details>`;
  const groups = FAQ_GROUPS.map(([id, label], gi) => {
    const rows = FAQ_ITEMS.filter((it) => it.g === id);
    if (!rows.length) return "";
    return `<section id="${id}" class="fq-group">
  <h2 style="font-weight:700;font-size:var(--fs-2xl);line-height:1.1;letter-spacing:-.02em;margin:0 0 6px;color:var(--ink);">${e(label)}</h2>
  ${rows.map((it, i) => item(it, gi === 0 && i === 0)).join("\n")}
  </section>`;
  }).join("\n");

  const body = `<div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
  <section>
  <div style="font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--accent);margin-bottom:10px;">FAQ</div>
  <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:.96;margin-bottom:14px;">Frequently asked questions</h1>
  <p style="color:var(--muted);font-size:var(--fs-lg);line-height:1.6;max-width:720px;margin-bottom:32px;">Agent402 is the open-source payment and trust layer for x402 and MPP, with 500+ ready tools an AI agent pays for per call.</p>
  </section>
  ${groups}
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/faq",
    jsonLd,
    extraCss: FAQ_CSS,
    body,
  });
}

// Scalar types a GET query parameter is published with as declared. Everything
// else (object, array) is documented as a string, because that is what a query
// string carries. Only "number" passed through before, so an input schema
// declaring "integer" or "boolean" was published as a string beside a numeric
// or boolean `example` - an example that does not validate against the type the
// same operation declares, on the surface a code generator reads.
const QUERY_PARAM_TYPES = new Set(["number", "integer", "boolean"]);
// The 429 every catalog operation can answer: the unpaid-request limits, and
// the in-flight coverage check on paid calls (src/inflight-cover.js).
// The region refusal (src/sanctioned-regions.js), on every paid operation
// while the block is on: answered before any payment is verified or settled.
const OPENAPI_451 = Object.freeze({ description: "Unavailable in the caller's region (reason unavailable_in_region), or a paid request whose region could not be read (reason location_unreadable), before any payment is verified or settled: charged false on x402; a Tempo push transfer is not claimed." });
const OPENAPI_429 = Object.freeze({ description: "Refused before the tool runs: one of the documented limits, such as a rate limit or a wallet whose balance does not cover its paid calls in flight. Not charged on x402; a Tempo transfer sent before the call is recorded as owed and repaid after on-chain proof. Retry after Retry-After when present." });

// Inlined, not a $ref: naive dereferencers that crawl this document resolve
// every pointer from the root (see the components note below).
const ASYNC_JOB_SCHEMA = {
  type: "object",
  properties: {
    jobId: { type: "string" },
    status: { type: "string", enum: ["working", "completed", "failed"], description: "The original job status: working until the answer is ready, then completed or failed." },
    state: { type: "string", enum: ["queued", "running", "succeeded", "failed"], description: "The lifecycle: queued until the paid handler starts (payment verified), running while it works, then succeeded or failed." },
    stage: { type: "string", description: "What the run is doing: queued, started, a route-specific stage (video: submitted, generating, downloading; reports: their named steps), running, done or failed." },
    progress: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Fraction done, when known." },
    progressEstimated: { type: "boolean", description: "true when progress is elapsed time against the route's typical run rather than reported by the run itself." },
    steps: { type: "object", properties: { done: { type: "integer" }, total: { type: "integer" } }, description: "Steps done out of the total, on routes that report steps." },
    etaSeconds: { type: ["integer", "null"], description: "Estimated seconds until the answer, when known." },
    elapsedSeconds: { type: "integer" }, expectedSeconds: { type: "integer", description: "The route's typical run, measured." }, maxSeconds: { type: "integer", description: "The route's run budget." },
    statusUrl: { type: "string" }, message: { type: "string" }, pollIntervalSeconds: { type: "integer", description: "Seconds to wait before the next poll (also sent as Retry-After)." },
    createdAt: { type: "string" }, updatedAt: { type: "string" }, expiresAt: { type: "string" },
    result: { type: "object", description: "On completed (state succeeded): { httpStatus, headers (payment receipt), body }." },
    error: { type: "object", description: "On failed: { httpStatus, body or message }." },
  },
};
// A well-formed Base payment hash: a generator or sweep that sends the
// published example gets the real answer shape (status none for a payment
// with no refund recorded), never a 400.
const REFUND_LOOKUP_EXAMPLE_TX = "0x3f9c2a7d41b8e06c5d2f7a9b13e48c60d7a2f95b1c3e8d40a6f2b97c5d1e3a08";
const REFUND_LOOKUP_SCHEMA = {
  type: "object",
  required: ["tx", "found", "status"],
  properties: {
    tx: { type: "string" },
    found: { type: "boolean", description: "True exactly when status is not none." },
    status: { type: "string", enum: ["owed", "sending", "held", "paid", "void", "none"] },
    priceUsd: { type: ["number", "null"], description: "Price of the call this payment bought; the amount a refund repays." },
    amountUsd: { type: ["number", "null"], description: "Same as priceUsd." },
    network: { type: ["string", "null"], description: "CAIP-2 network the payment settled on." },
    chain: { type: ["string", "null"] },
    txUrl: { type: ["string", "null"], description: "The payment on its explorer." },
    refundTx: { type: ["string", "null"], description: "Our refund transaction, once paid." },
    refundTxUrl: { type: ["string", "null"] },
    refundedAt: { type: ["string", "null"], format: "date-time" },
    note: { type: "string" },
    refunds: {
      type: "array",
      description: "Every refund recorded for this transaction, oldest first: one, except where several payments settled in the same transaction. The fields above describe the one furthest from repaid.",
      items: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["owed", "sending", "held", "paid", "void"] },
          priceUsd: { type: "number" },
          amountUsd: { type: "number" },
          refundTx: { type: ["string", "null"] },
          refundTxUrl: { type: ["string", "null"] },
          refundedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
    },
  },
};

// The answers of GET /api/skill-packs.json and /api/skill-packs/{slug}/prompt
// (server.js), as their handlers build them.
const SKILL_PACK_LIST_SCHEMA = Object.freeze({
  type: "object",
  required: ["packs"],
  properties: {
    packs: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "title", "toolSlugs"],
        properties: {
          slug: { type: "string" },
          title: { type: "string" },
          tagline: { type: "string" },
          useCase: { type: "string" },
          toolSlugs: { type: "array", items: { type: "string" } },
          workflow: { type: "array", items: { type: "string" } },
          claudePrompt: { type: "string" },
          promptArgs: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } } } },
        },
      },
    },
  },
});
const SKILL_PACK_PROMPT_SCHEMA = Object.freeze({
  type: "object",
  required: ["messages"],
  properties: {
    description: { type: "string" },
    messages: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: { type: "string", enum: ["user", "assistant"] },
          content: { type: "object", required: ["type", "text"], properties: { type: { type: "string", const: "text" }, text: { type: "string" } } },
        },
      },
    },
  },
});

export function openapiSpec(baseUrl, catalog) {
  const geoBlockOn = sanctionsGeoBlockEnabled();
  const paths = {};
  // MPP start-here set (src/mpp-flagship.js), already filtered to routes the
  // 402 offers tempo on. Marked per operation and indexed at the top level.
  const mppFlagship = mppFlagshipRows(catalog);
  const mppFlagshipBySlug = new Map(mppFlagship.map((r) => [r.slug, r]));
  // Which clients get the x402 offer alone (src/mpp-offer-gate.js), read once.
  const offerGateClause = mppOfferGateClauseIfOffered({ code: (x) => x });
  const offerGateSentence = mppOfferGateSentenceIfOffered({ code: (x) => x });
  for (const tool of toolList(catalog)) {
    const { method, path, discovery } = tool;
    // Every MPP offer the live 402 makes on this route, in the order it lists
    // them (tempo per currency, evm per chain, stripe) - read from the same
    // predicates and env the 402 middlewares read, so the document never
    // promises a method the 402 withholds (identity-bound and long-running
    // routes get no tempo; evm only on MPP_CHALLENGE_NETWORKS rails that are
    // also accepted; stripe only at or above the card minimum; nothing when a
    // method is switched off). The prose clause and x-payment-info both read it.
    const toolPriceUsd = Number(String(tool.price ?? "").replace(/[^0-9.]/g, "")) || 0;
    const mppOffers = mppOffersFor({ priceUsd: toolPriceUsd, identityBound: tool.identityBound, longRunning: tool.longRunning });
    const mppRails = mppRailsPhrase(mppOffers);
    const op = {
      operationId: `${tool.slug}${method === "GET" ? "Get" : ""}`,
      summary: `${tool.name} (${tool.quoteRange ? `from ${fromPriceLabel(tool)}` : tool.price}/call via x402${mppRails ? " or MPP" : ""})`,
      // A route that can quote MORE than its list price for some bodies says so
      // here, in the same breath as the number. `x-price` stays the list price
      // (it is what this route charges for the models it serves, and every
      // other surface agrees with it); the sentence is what keeps the number
      // from reading as a ceiling it is not.
      // The 402 walkthrough lives ONCE in info.x-guidance; repeating it on
      // every operation was ~20% of a 2 MB document for no new information.
      description: `${tool.description}\n\nPrice: ${typeof tool.quote === "function" ? `quoted per request from the body, from ${fromPriceLabel(tool)}${tool.quoteFormula ? ` (${tool.quoteFormula})` : ""}` : `${tool.price} per call`}, over x402 (${railsOrFor(tool)})${mppRails ? ` or MPP (${mppRails})` : ""}.${typeof tool.quote === "function" && String(tool.slug).startsWith("v1-chat-metered") ? ` ${meteredQuoteSentence()}` : ""}${typeof tool.tierQuote === "function" ? ` ${PRICED_BY_MODEL_NOTE}` : ""}${meteredTwinPath(tool.slug) ? ` For the same models quoted per request from the body (on x402, Tempo and credits, settlement never exceeds the quote), use POST ${meteredTwinPath(tool.slug)}.` : ""} Docs: ${baseUrl}/tools/${tool.slug}`,
      tags: [tool.category],
      responses: {
        200: {
          // A captured example (src/tool-output-examples.js) says where it came
          // from: a real paid answer and its date, and model-generated when so.
          description: discovery?.output?.captured && !binaryTypesOf(tool) ? `Success. ${captureNote(discovery.output.captured)}` : "Success",
          // A replayed answer says so (src/idempotency.js); the replay cache
          // holds JSON answers only, so a binary tool never carries them.
          ...(binaryTypesOf(tool) ? {} : { headers: { "X-Idempotent-Replay": { $ref: "#/components/headers/IdempotentReplay" }, "X-Replayed-Answer": { $ref: "#/components/headers/ReplayedAnswer" } } }),
          // A binary tool answers raw bytes (one content type per format it
          // can produce), never the JSON note its discovery example carries.
          // The listing's type (the one the published example answers with)
          // comes first; a tool that can also answer JSON (dub's json mode)
          // lists it with its schema.
          content: Object.fromEntries(responseTypesOf(tool).map((t) => [t, t === JSON_MIME
            ? { schema: responseSchemaFor(path, discovery?.output?.example, discovery?.output?.optional), example: discovery?.output?.example ?? {}, ...(discovery?.output?.captured ? { "x-example-source": { kind: "captured-paid-answer", capturedAt: discovery.output.captured.capturedAt, modelBacked: discovery.output.captured.modelBacked === true } } : {}) }
            : { schema: { type: "string", format: "binary" } }])),
        },
        402: { description: `Payment Required - x402 payment requirements in the PAYMENT-REQUIRED header, mirrored in the JSON body, and MPP challenges (WWW-Authenticate: Payment)${offerGateClause ? `; ${offerGateClause}` : ""}. A first-contact body also carries payment: this request's price in dollars on the named network, how to pay, the proof-of-work path on a free-tier tool (noWallet), the caller's own inputs on a route quoted from its body (quote), and links to /llms.txt, the pay section of /agents.md and the MCP connector. ${PAYMENT_RETRY_VERBS_NOTE}` },
        400: { description: "Invalid input - the JSON body names the tool's input schema (expected, required), its example, and howToCall: the same example as a ready-to-run request (method, url, and a JSON body, or form parts for a multipart tool), with the other method under alternate where it is served; a call over 1024 bytes carries only method and url" },
        // One shared object (the description is the same on every route).
        429: OPENAPI_429,
        ...(geoBlockOn ? { 451: OPENAPI_451 } : {}),
      },
      "x-price": tool.price,
      ...(mppFlagshipBySlug.has(tool.slug) ? { "x-mpp-flagship": { order: mppFlagshipBySlug.get(tool.slug).order, why: mppFlagshipBySlug.get(tool.slug).why } } : {}),
      "x-payment-protocol": "x402",
      // ONE x-payment-info object serves two advisory readers, each keyed on
      // its own fields (extra keys are tolerated by both):
      //   - x402scan (docs/DISCOVERY.md in Merit-Systems/x402scan) reads
      //     `protocols` + `price` (decimal-dollar amount);
      //   - MPP discovery (paymentauth.org draft-payment-discovery; MPPScan
      //     crawls this) reads the multi-offer `offers` array — amount in
      //     SMALLEST currency units, currency = token contract address. The
      //     runtime 402 stays authoritative; the shim (src/mpp-shim.js) is
      //     what actually answers MPP's evm/charge wire, and src/mpp-tempo.js
      //     the tempo one.
      "x-payment-info": (() => {
        const priceUsd = toolPriceUsd;
        // Per-request-priced routes (metered, priced by model) publish their
        // range, never the catalog floor as if it were the price.
        const range = tool.quoteRange || null;
        const fmtUsd = (n) => String(Number(n.toFixed(6)));
        // A chain's settlement premium, added to the amounts below when the
        // buyer settles there (the same map the 402 prices through).
        const premium = premiumUsdByNetworkName();
        // The route's MPP offers, computed once above from the 402's own predicates.
        const mpp = mppOffers;
        const firstOf = (m) => mpp.find((o) => o.method === m);
        return {
          // STRUCTURED protocol objects, not bare strings: @agentcash/discovery
          // (MPPScan's crawler, whose L3 output x402scan consumes) parses
          // structured x-payment-info with zod — an object `price` next to
          // string protocols fails the structured schema AND the legacy
          // fallback, losing both price and protocols. Each mpp entry
          // requires non-empty method/intent/currency. One entry per METHOD
          // (its preferred currency); `offers` below carries every currency.
          protocols: [
            { x402: {} },
            ...["tempo", "evm", "stripe"].filter(firstOf).map((m) => ({ mpp: { method: m, intent: "charge", currency: firstOf(m).currency } })),
          ],
          price: range
            ? { mode: "dynamic", currency: "USD", min: fmtUsd(range.minUsd), max: fmtUsd(range.maxUsd) }
            : { mode: "fixed", currency: "USD", amount: String(tool.price ?? "").replace(/[^0-9.]/g, "") || "0" },
          // How a dynamic price is computed from the body, where the route states it.
          ...(range && tool.quoteFormula ? { quoteFormula: tool.quoteFormula } : {}),
          ...(Object.keys(premium).length ? { premiumUsdByNetwork: premium } : {}),
          offers: mpp.map((o) => ({
            intent: o.intent,
            method: o.method,
            amount: range ? null : baseUnitsOrNull(priceUsd, o.decimals),
            currency: o.currency,
            ...(o.chainId ? { chainId: o.chainId } : {}),
            description: o.description,
          })),
          // The Circle Gateway batched option, where the live offer carries
          // it (src/gateway-nanopayments.js): the same price on a second
          // exact accept the buyer pays from a Gateway balance, no gas per payment.
          // Identity-bound routes and routes with a lasting effect
          // (defHasLastingEffect) keep the plain accept only. Absent while
          // the option is off.
          ...(() => {
            const gw = gatewayOfferPublic();
            if (!gw || tool.identityBound || defHasLastingEffect(tool)) return {};
            return { nanopayments: { kind: gw.kind, networks: Object.keys(gw.networks), buyerGas: "none per payment. After a USDC deposit into Gateway (an on-chain transfer the buyer makes and pays gas for), each payment is a signature against that balance, with no gas per payment.", settlement: "batched off chain by Circle Gateway", select: `the accept whose extra.name is ${gw.kind}` } };
          })(),
        };
      })(),
    };
    const props = discovery?.inputSchema?.properties ?? {};
    const required = discovery?.inputSchema?.required ?? [];
    // Every route accepts Idempotency-Key; only PoW-eligible (non-wallet-only)
    // routes accept X-Pow-Solution as an alternative to x402 payment. Neither
    // was declared as a parameter before - a caller had to already know these
    // headers exist from prose docs, not from the machine-readable spec.
    const headerParams = [
      {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "Same key + same credential + same body replays the paid result without charging again. A copy sent while the first is still running gets 409 with Retry-After and does not run.",
        schema: { type: "string" },
      },
      ...(tool.asyncProfile ? [{
        name: "Prefer",
        in: "header",
        required: false,
        description: `respond-async: a paid call gets 202 and a job link at once (Location, statusUrl) instead of waiting${tool.asyncProfile.maxSeconds ? ` up to ${tool.asyncProfile.maxSeconds} s` : " on the connection"}; or send wait=${tool.asyncProfile.maxSeconds} to hold the connection and get the answer in the same response (a plain call with no Prefer header is refused with 400 before payment); poll GET /api/jobs/{id} (free, honor Retry-After) until status is completed or failed (state succeeded or failed).${tool.asyncProfile.slow ? " Recommended on this route." : ""} Payment settles only when the answer is ready${JOB_PUSH_EXCEPTION}.${settleFirstClause(tool)}${needsAsyncOrWait(tool.asyncProfile) ? ` wait=${tool.asyncProfile.maxSeconds}: wait on this connection for the answer instead. A paid call with neither is answered 400 before any payment is taken.` : ""}`,
        schema: needsAsyncOrWait(tool.asyncProfile)
          ? { type: "string", examples: ["respond-async", `wait=${tool.asyncProfile.maxSeconds}`] }
          : { type: "string", enum: ["respond-async"] },
      }] : []),
      ...returningWalletHeaderParams(tool),
      ...upstreamKeyHeaderParams(tool),
      ...(isComputePayable(tool) ? [{
        name: "X-Pow-Solution",
        in: "header",
        required: false,
        description: "Free alternative to paying: <token>:<nonce> from GET /api/pow/challenge.",
        schema: { type: "string" },
      }] : []),
    ];
    if (method === "GET") {
      op.parameters = [
        ...Object.entries(props).map(([name, schema]) => ({
          name,
          in: "query",
          required: required.includes(name),
          description: schema.description,
          // A string field's published length cap (maxLength, the number the
          // handler enforces) and its closed set of values (enum) ride on the
          // parameter as they do on a JSON body.
          schema: {
            type: QUERY_PARAM_TYPES.has(schema.type) ? schema.type : "string",
            ...(Number.isInteger(schema.maxLength) && (!QUERY_PARAM_TYPES.has(schema.type) || schema.type === "string") ? { maxLength: schema.maxLength } : {}),
            ...(schema.type === "string" && Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((v) => typeof v === "string") ? { enum: [...schema.enum] } : {}),
          },
          ...(discovery?.input?.[name] !== undefined ? { example: discovery.input[name] } : {}),
        })),
        ...headerParams,
      ];
    } else {
      // JSON for every route but the multipart ones (src/openapi-request.js).
      op.requestBody = openapiRequestBody(discovery);
      op.parameters = headerParams;
    }
    if (tool.asyncProfile && op.responses) op.responses["202"] = { description: "Accepted (Prefer: respond-async): status working, state queued; poll its statusUrl, waiting Retry-After seconds between polls. Nothing has settled yet.", content: { "application/json": { schema: ASYNC_JOB_SCHEMA } } };
    // Machine-readable duration and async advice (src/slow-routes.js): the
    // same block /api/pricing rows and a slow route's 402 body carry.
    if (tool.asyncProfile) op["x-agent402-async"] = asyncAdvice(tool);
    paths[path] = paths[path] ?? {};
    paths[path][method.toLowerCase()] = op;
  }
  paths["/api/jobs/{id}"] = {
    get: {
      operationId: "getAsyncJob",
      security: [],
      summary: "Collect a job started with Prefer: respond-async",
      description: `Free. Returns the job's status (working, completed, failed, as since the feature shipped) and its state (queued, running, succeeded, failed) with its stage, progress (0 to 1 when known, labeled progressEstimated when it is elapsed time against the route's typical run) and etaSeconds; a state that is not final sets Retry-After. A succeeded job carries the route's answer in result.body with its payment receipt in result.headers, and a failed job says why in error (on x402 a failed run is not charged). ${SETTLE_FIRST_SENTENCE} The id is the link the 202 returned; it expires after one hour.`,
      tags: ["jobs"],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{48}$" } }],
      responses: {
        200: { description: "The job.", content: { "application/json": { schema: ASYNC_JOB_SCHEMA } } },
        404: { description: "Unknown job id." },
        410: { description: "The job link has expired." },
      },
    },
  };
  // The free refund lookup: one transaction per ask, every refund recorded for it.
  const refundLookupOp = (operationId) => ({
    operationId,
    security: [],
    summary: "Refund status of one transaction's payments, by the payment transaction",
    description: "Free. Answers whether a payment that was charged and not delivered is refunded: found, status (owed, sending, held for review, paid, void, or none for a transaction with no refund recorded, which is also the answer for one never seen), priceUsd of the call it paid for, network, chain, the payment's and the refund's explorer links, refundTx once sent, and refunds (every refund recorded for that transaction). One transaction per ask; never a wallet's list, never a wallet address, the payer or the tool bought. Rate limited per client address (429 with Retry-After).",
    tags: ["refunds"],
    parameters: [{ name: "tx", in: "query", required: true, description: "The payment's transaction: 0x plus 64 hex on EVM chains, 64 hex on Stellar, a base58 signature on Solana, a 52-character id on Algorand.", schema: { type: "string", maxLength: 100 }, example: REFUND_LOOKUP_EXAMPLE_TX }],
    responses: {
      200: { description: "The refund status of that one transaction (one transaction per ask).", content: { "application/json": { schema: REFUND_LOOKUP_SCHEMA } } },
      400: { description: "tx is not one transaction hash." },
      429: { description: "Too many lookups from this address; retry after Retry-After seconds." },
    },
  });
  // A streamed paid answer's signed receipt, kept where its head said.
  if (receiptsServed()) paths[`${RECEIPT_FETCH_PATH}/{key}`] = {
    get: {
      operationId: "getStreamedReceipt",
      security: [],
      summary: "The signed receipt of a streamed paid answer, by the token its head named",
      description: `Free. A paid answer written in parts names ${RECEIPT_URL_HEADER} in its head; once it finished 200, this answers the same ${RECEIPT_HEADER} receipt a trailer carries (a compact JWS, checked against /.well-known/agent402-receipt-key.json or at POST /api/receipts/verify with the bytes received), for ${RECEIPT_FETCH_DAYS} days. The key is the random token the head named, never the call's settlement, so only the buyer can fetch it. A failed, free or trial call and a referral copy are never signed, so they have none. Rate limited per client address (429 with Retry-After).`,
      tags: ["receipts"],
      parameters: [{ name: "key", in: "path", required: true, description: "The settlement or token the answer's head named.", schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{16,200}$" } }],
      responses: {
        200: { description: "The receipt.", content: { "application/json": { schema: { type: "object", properties: { receipt: { type: "string" }, header: { type: "string" }, keys: { type: "string" }, verify: { type: "string" } }, required: ["receipt"] } } } },
        400: { description: "key is not a settlement or token." },
        404: { description: "No receipt is kept under that key." },
        429: { description: "Too many reads from this address; retry after Retry-After seconds." },
      },
    },
  };
  paths["/api/refunds"] = { get: refundLookupOp("getRefundStatus") };
  paths["/api/refunds/lookup"] = { get: refundLookupOp("lookupRefund") };
  // Document the skill-pack discovery surface so SDK generators and agent
  // frameworks that consume the OpenAPI spec learn about the curated multi-tool
  // workflows. Free, no payment required — these are discovery/composition
  // helpers, not paywalled tools.
  paths["/api/skill-packs.json"] = {
    get: {
      operationId: "listSkillPacks",
      // Explicit no-auth marker: discovery crawlers flag operations with
      // neither x-payment-info nor a security declaration as "no auth mode".
      security: [],
      summary: "List curated multi-tool workflows (skill packs)",
      description:
        "Curated, ordered sequences of Agent402 tool calls for tasks no single tool covers (e.g. audit a domain, diagnose deliverability). Each pack includes the tool slugs to call in order, a Claude-ready prompt template, and declared prompt arguments. Same data exposed as MCP prompts on the hosted connector. Free.",
      tags: ["workflows"],
      responses: {
        200: {
          description: "All skill packs.",
          content: { "application/json": { schema: SKILL_PACK_LIST_SCHEMA } },
        },
      },
    },
  };
  paths["/api/skill-packs/{slug}/prompt"] = {
    get: {
      operationId: "getSkillPackPrompt",
      security: [],
      summary: "Get a templated workflow prompt for a single skill pack",
      description:
        "Returns the rendered MCP-style messages for the named skill pack with the given arguments substituted in. Same output as MCP prompts/get on the hosted connector - usable directly with any LLM. Per-pack argument names come from /api/skill-packs.json. Free.",
      tags: ["workflows"],
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          description: `Skill pack slug. Known values: ${SKILL_PACKS.map((p) => p.slug).join(", ")}.`,
          schema: { type: "string", enum: SKILL_PACKS.map((p) => p.slug) },
          example: SKILL_PACKS[0]?.slug ?? "security-audit",
        },
      ],
      responses: {
        200: {
          description: "Rendered prompt messages.",
          content: { "application/json": { schema: SKILL_PACK_PROMPT_SCHEMA } },
        },
        404: { description: "Unknown slug. Use /api/skill-packs.json to list." },
      },
    },
  };
  paths["/api/scorecard"] = {
    get: {
      operationId: "getBuyerScorecard",
      security: [],
      summary: "Buyer scorecard: outside paying wallets per UTC month",
      description: "Free. Per UTC calendar month (the current month to date and the six before it), from the sales ledger: distinct outside paying wallets, wallets that also paid in an earlier month, wallets with paid calls on 2 or more days, settled paid calls and USD by settlement network. Our own wallets, canary and test traffic, free proof-of-work calls and calls with no paying wallet are left out. A count of 1 or 2 reads \"<3\", and a month with fewer than 3 paying wallets publishes that alone. The method is stated in the method field. Refreshed on a timer; asOf says when.",
      tags: ["transparency"],
      responses: {
        200: { description: "The scorecard.", content: { "application/json": { schema: { type: "object", required: ["asOf", "months", "method"], properties: { asOf: { type: "string", format: "date-time" }, months: { type: "array", items: { type: "object" } }, method: { type: "object" } } } } } },
        503: { description: "Not computed yet; retry after Retry-After seconds." },
      },
    },
  };
  paths["/api/reputation"] = {
    get: {
      operationId: "getSellerReputation",
      security: [],
      summary: "One outside seller's reputation, measured by this server",
      description: "Free. What this server's own crawl and its router's own paid calls measured about one outside x402 seller over a rolling 30-day window: manifest uptime, paywall (402) uptime, responsiveness of the 402, price matches listing (the live 402 price against the price the seller's own documents list) and delivery (measured from purchases Agent402's router made for buyers), with age. Each metric names its method, window, sample size, minimum sample and last measurement, and is scored (0 to 1) only past its minimum sample; below it reads not-enough-data. No metric counts payments or buyers: router purchases, our own wallets and test traffic are never buyer evidence, and settlement counts are not part of the record. Per-route rows are capped (returned, matched, complete and truncated say so). Computed off the request path by a scheduled pass.",
      tags: ["transparency"],
      parameters: [{ name: "seller", in: "query", required: true, description: "The seller's host or origin, as on /api/index?seller=.", schema: { type: "string", maxLength: 512 } }],
      responses: {
        200: { description: "The seller's reputation record.", content: { "application/json": { schema: { type: "object", required: ["seller", "reputation", "tools"], properties: { seller: { type: "string" }, reputation: { type: "object" }, tools: { type: "array", items: { type: "object" } }, returned: { type: "integer" }, matched: { type: "integer" }, complete: { type: "boolean" }, truncated: { type: "boolean" } } } } } },
        400: { description: "No seller named, or one longer than 512 characters." },
        404: { description: "The seller is not in this server's index (or names this server's own host)." },
        503: { description: "The index is still loading; retry after Retry-After seconds." },
      },
    },
  };
  paths["/api/router-benchmarks"] = {
    get: {
      operationId: "getRouterBenchmarks",
      security: [],
      summary: "Router benchmarks: measured outcomes across outside sellers, in aggregate",
      description: "Free. Aggregates over the 30-day reputation records this server holds: the share of the router's recorded purchases an outside seller answered 200 after taking the payment, and the measured uptime, 402 responsiveness and price-match scores of the sellers the router bought from beside the indexed sellers it did not buy from. No seller is named; a statistic is published only when at least five sellers are scored on it and otherwise reads not-enough-data; no field counts payments, purchases, buyers or settlements. One seller's own record is on /api/reputation?seller=.",
      tags: ["transparency"],
      responses: {
        200: { description: "The benchmark document.", content: { "application/json": { schema: { type: "object", required: ["benchmark", "recordState", "windowDays", "delivery", "cohorts", "comparison", "legend"], properties: { benchmark: { type: "string" }, recordState: { type: "string", enum: ["ready", "loading", "not-measured-here"] }, windowDays: { type: "integer" }, minCohortSellers: { type: "integer" }, delivery: { type: "object" }, cohorts: { type: "object" }, comparison: { type: "object" }, legend: { type: "string" } } } } } },
        503: { description: "The benchmark could not be computed right now; retry after Retry-After seconds." },
      },
    },
  };
  paths["/api/reputation/recheck"] = {
    post: {
      operationId: "recheckSellerReputation",
      security: [],
      summary: "Ask for a fresh measurement of one indexed seller",
      description: "Free. Schedules the crawl to read the seller on its next cycle, inside the seller's own per-operator crawl budget (one of its places that cycle, never an extra read; a Retry-After or daily budget it set still applies); the next reputation pass folds that read in. One accepted request per seller every 6 hours: a repeat inside that span answers the request already scheduled and changes nothing. Limited per caller.",
      tags: ["transparency"],
      parameters: [{ name: "seller", in: "query", required: false, description: "The seller's host or origin, as on /api/reputation?seller= (or send it in the body).", schema: { type: "string", maxLength: 512 } }],
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { seller: { type: "string", maxLength: 512, description: "The seller's host or origin, when not sent as ?seller=." } } }, example: { seller: "seller.example" } } } },
      responses: {
        202: { description: "Scheduled: when the crawl reads the seller (crawlBy) and when the record shows it (recordBy).", content: { "application/json": { schema: { type: "object", required: ["seller", "status", "accepted", "requestedAt", "crawlBy", "recordBy"], properties: { seller: { type: "string" }, status: { type: "string", enum: ["scheduled"] }, accepted: { type: "boolean" }, requestedAt: { type: "string", format: "date-time" }, crawlBy: { type: "string", format: "date-time" }, recordBy: { type: "string", format: "date-time" }, nextAcceptedAt: { type: "string", format: "date-time" }, lastRecheckedAt: { type: ["string", "null"], format: "date-time" } } } } } },
        400: { description: "No seller named, or one longer than 512 characters." },
        404: { description: "The seller is not in this server's index (or names this server's own host)." },
        429: { description: "The caller's hourly limit; retry after Retry-After seconds." },
        503: { description: "The index is still loading, reputation is not measured on this server, or the store could not record the request; retry after Retry-After seconds." },
      },
    },
  };
  // Instance-wide MPP offer, read from the same config the 402 middlewares read.
  const mppShort = mppOfferShortProse();
  return {
    openapi: "3.1.0",
    info: {
      // The title is what x402scan, MPPScan and every OpenAPI-reading
      // directory display as OUR NAME, so it is the plain product name; the
      // tagline (both wires, x402 + MPP) lives in the description below.
      title: "Agent402.tools",
      // package.json's version (src/server-version.js), the release running.
      version: SERVER_VERSION,
      description:
        // Template literal, not a plain string: this is the spec description
        // every crawler and directory reads, and as a quoted string it shipped
        // a literal ${RAILS_OR} to production.
        `${frontDoorOneLine(catalog)} ${leadSentence({ mpp: Boolean(mppShort), receipts: receiptsServed() })} ${SUPPORT_LINE} The open-source, self-hostable applied layer of Agentic Finance - agents paying and getting paid over x402 and MPP: machine-payable web tools for AI agents in one place (browser, search, PDFs, images, live data, payment helpers) - the whole catalog is open and runnable yourself. Each priced operation is paid per call over x402 (${RAILS_OR}; identity-bound and long-running operations take EVM chains only, and each operation's description names its own rails)${mppShort ? `, or over MPP (Machine Payments Protocol: ${mppShort})` : ""} - no signup, no API keys - the first request returns HTTP 402 carrying ${mppShort ? "both offers, an x402 or mppx client pays" : "the offer, an x402 client pays"} and retries - or free with proof-of-work. Also the open x402 index, Smart Order Router and MPP marketplace. Free discovery: GET /api/pricing, GET /llms.txt. Multi-tool workflows: GET /api/skill-packs.json.`,
      // Email doubles as x402scan's ownership-verification signal; it is the
      // same public maintainer contact the /.well-known/x402 manifest names.
      contact: { name: "Havok Holdings LLC", email: "help@agent402.tools", url: baseUrl },
      // The terms every paid and free call is made under (the same URL the
      // x402 manifest, every 402 body and the MCP connector name), and the
      // server's own license.
      termsOfService: `${baseUrl}/terms`,
      license: { name: "AGPL-3.0-or-later", identifier: "AGPL-3.0-or-later" },
      // Agent-facing quickstart read by MPP/x402 discovery crawlers
      // (info.x-guidance in MPPScan's audit).
      "x-guidance":
        // Scoped to the operations that carry x-price: discovery paths such as
        // /api/find, /api/route, /api/index and /api/pricing are free and are
        // not pay-per-call. No credits sentence: credit sales are off by
        // default (CREDITS_SALES), so "buy at /credits" is not an instruction
        // an agent can follow.
        `Every operation in this document that carries x-price is pay-per-call: request it unauthenticated, read the 402 (x402 PAYMENT-REQUIRED or MPP WWW-Authenticate: Payment), pay and retry.${offerGateSentence ? ` ${offerGateSentence}` : ""} Find the right tool with GET /api/find?q=<task> and read prices at GET /api/pricing, both free (its payment.premiumUsdByNetwork names a chain's settlement premium, added to every price quoted on that chain, and payment.minPriceUsdByNetwork a chain's floor; an operation's x-payment-info carries the premium too); many tools also accept free proof-of-work (GET /api/pow). To call a model, use the metered routes (${meteredRoutesInline().replace(/`/g, "")}), the default. ${meteredQuoteSentence().replace(/`/g, "")} ${flatTiersLine().replace(/`/g, "")} Retries: an Idempotency-Key replays a served paid call without a second charge, and a request re-sent with the same signed EVM payment is replayed without one (X-Replayed-Answer: 1).`,
    },
    servers: [{ url: baseUrl }],
    // These exist ONLY so the openapi-resolve-refs tool's example (which
    // embeds a mini-spec whose `$ref`s point at #/components/...) resolves
    // against THIS document's root too. Naive ecosystem dereferencers (e.g.
    // dereference-json-schema, used by MPPScan's @agentcash/discovery crawler)
    // walk the whole document and resolve every `$ref` from the root — a
    // dangling pointer CRASHES them and kills our entire listing. The
    // definitions mirror the example's own components byte-for-byte, so a
    // resolver that inlines them changes nothing semantically.
    // test-openapi-coverage locks "every $ref in the spec resolves".
    components: {
      schemas: { User: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
      parameters: { UserId: { name: "id", in: "path", required: true, schema: { type: "string" } } },
      // The two replay markers every JSON 200 may carry (src/idempotency.js).
      headers: {
        IdempotentReplay: { description: "true when this 200 was replayed from the first answer to the same credential, route and body (an Idempotency-Key, the x402 payment-identifier extension, or a re-sent EVM payment): no handler ran and nothing settled again.", schema: { type: "string", enum: ["true"] } },
        ReplayedAnswer: { description: "1 when the replay was keyed on a re-sent signed EVM payment (same nonce, route and body) with no Idempotency-Key. Not on identity-bound routes, routes with a lasting effect or streamed calls.", schema: { type: "string", enum: ["1"] } },
      },
      securitySchemes: {
        x402: { type: "apiKey", in: "header", name: "PAYMENT-SIGNATURE", description: "x402 v2 payment payload (USDC, EIP-3009 authorization) - answer to the 402's PAYMENT-REQUIRED header." },
        mpp: { type: "http", scheme: "Payment", description: "MPP (Machine Payments Protocol) credential answering the 402's WWW-Authenticate: Payment challenge (evm/charge, tempo/charge, stripe/charge)." },
        // Purchase is offered only while credits are on sale (CREDITS_SALES);
        // a key already issued keeps working either way.
        creditsKey: { type: "http", scheme: "bearer", bearerFormat: "a402_<key>", description: `Prepaid card credits key (Authorization: Bearer a402_<key>), accepted on any paid operation except the wallet-identity-bound ones and the operations that buy from an outside seller (the router's execute tiers, seller-payability, decide-execute and the flight routes), which are paid with a wallet. The list price is held before the call and debited only on a 200; read the remaining balance at GET /api/credits/balance with the same header.${creditsSalesEnabled() ? " New keys are sold at /credits." : " New credits are not on sale; a key already issued keeps working."}` },
      },
    },
    // MPP discovery (paymentauth.org draft-payment-discovery) service-level
    // metadata — MPPScan and MPP-aware agents read this from /openapi.json.
    "x-service-info": {
      categories: ["data", "search", "media", "compute", "developer-tools"],
      docs: {
        homepage: baseUrl,
        llms: `${baseUrl}/llms.txt`,
        apiReference: `${baseUrl}/openapi.json`,
      },
    },
    tags: [
      ...Object.entries(CATEGORIES).map(([k, v]) => ({ name: k, description: k === "llm" ? `${v.label}. ${gatewayProductSentence({ receipts: receiptsServed() })}` : v.label })),
      { name: "workflows", description: "Curated multi-tool workflows (skill packs) - task-level templates that compose catalog tools." },
      { name: "transparency", description: "Figures about this service computed from its own ledgers." },
    ],
    paths,
    // Top-level extension so OpenAPI consumers can enumerate workflows without
    // scanning paths. Same `promptName == slug` contract as the other surfaces.
    // MPP start here: fast, low-priced routes that offer the tempo challenge,
    // in the order a new MPP client might try them.
    "x-mpp-flagship": mppFlagship.map((r) => ({ order: r.order, slug: r.slug, method: r.method, path: r.path, price: r.price, why: r.why })),
    "x-skill-packs": SKILL_PACKS.map((p) => ({
      slug: p.slug,
      title: p.title,
      toolCount: (p.toolSlugs || []).length,
      promptName: p.slug,
    })),
  };
}
