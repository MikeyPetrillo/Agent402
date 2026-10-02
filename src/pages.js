// Server-rendered catalogue pages and the OpenAPI spec — all generated from
// the tool catalog so they never drift from what the API actually serves.
import { REPO_URL } from "./repo-link.js";
import { isComputePayable } from "./pow.js";
import { responseSchemaFor } from "./openapi-schema.js";
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";
import { ledgerShell, ledgerFooterCompact, esc as ledgerEsc, breadcrumbLd } from "./ledger-chrome.js";
import { SKILL_PACKS, PACK_PRICE_RANGE } from "./skills.js";
import { agentReportPriceRange, cardReportPriceRange } from "./report-tiers.js";
import { HUMAN_PRODUCTS } from "./human-checkout.js";
import { RAILS_AMP, RAILS_OR, RAILS_PAREN, RAILS_SHORT, railsOrFor, x402EvmOnly } from "./rails.js";
import { mppOffersFor } from "./mpp-offers.js";
import { tempoOfferedFor, tempoDiscoveryInfo } from "./mpp-tempo.js";
import { WALLET_ONLY_POLICY_REASON } from "./pow.js";
import { IDEM_MAX_BODY_LABEL } from "./idempotency-limits.js";
import { mppFlagshipRows } from "./mpp-flagship.js";
import { PRICED_BY_MODEL_NOTE } from "./tools/llm-gateway-kit.js";
import { PARAM_ALIASES } from "./input-aliases.js";
import { metaTitle, metaDescription } from "./seo-meta.js";

export const CATEGORIES = {
  web: { label: "Web & documents", blurb: "Read the live web: browser rendering, screenshots, article extraction, PDFs, metadata." },
  memory: { label: "Agent memory & coordination", blurb: "The stateful layer a stateless agent can't build for itself: durable wallet-keyed KV with TTL, atomic counters/locks, shared namespaces other agents can reach (grants), a tamper-evident audit log, and similarity recall. The payment is the identity - no signup." },
  network: { label: "Network & domains", blurb: "DNS, TLS certificates, WHOIS/RDAP, uptime checks, robots.txt and sitemaps." },
  data: { label: "Live public data", blurb: "Keyless real-time government and market data: dataset search across data.gov, NWS weather alerts, USGS earthquakes, currency rates, barcode product lookup." },
  payments: { label: "Payments & x402", blurb: "Non-custodial x402 tooling: decode HTTP 402 quotes, verify on-chain USDC settlements, read balances, tx status and gas across Base, Polygon, Arbitrum, Optimism, Ethereum, and Robinhood Chain, and build EIP-3009 transfer authorizations. The agent signs with its own key - Agent402 never touches funds." },
  conversion: { label: "Data conversion", blurb: "JSON ⇄ CSV/YAML/XML, markdown ⇄ HTML, diffs and queries - formats agents juggle constantly." },
  text: { label: "Text processing", blurb: "Slugs, case conversion, diffs, regex, keywords, token estimates, edit distance, readability, PII redaction." },
  math: { label: "Math & finance", blurb: "Safe expression calculator, statistics, unit conversion across 13 categories (length, mass, temperature, …) via POST /api/unit-convert, percentage/number formatting, CIDR subnets, compound interest and loan math." },
  encoding: { label: "Encoding & crypto", blurb: "Hashes, HMAC signatures, base64/hex, JWT decoding, TOTP codes." },
  identifiers: { label: "Generators & IDs", blurb: "UUIDs, ULIDs, passwords, secure randomness, QR codes." },
  time: { label: "Time & scheduling", blurb: "Timezone-aware clocks, epoch conversion, cron parsing, durations." },
  validation: { label: "Validation & parsing", blurb: "Emails (with MX), URLs, IPs, user agents, colors, semver, IBAN, card numbers." },
  llm: { label: "LLM gateway", blurb: "OpenAI-compatible pay-per-call inference over x402 - five quality tiers plus embeddings, image generation and text-to-speech, model-optional auto-routing, streaming, and a default-on prompt cache. See /v1 in the OpenAPI spec for the full wire format." },
  // Every category the catalog actually uses must have an entry here. This map
  // is the source for the /tools category pages, the /api/pricing categories
  // map, /.well-known/x402 capabilities, and llms.txt - so a category missing
  // from it is a 404 page, an unlabelled price row, a capabilities total that
  // does not reconcile, and tools absent from the agent-readable catalog. It
  // was short by ten keys covering 195 entries (37% of the catalog), which is
  // why seller-trust and the chain-read primitives were invisible to agents.
  crypto: { label: "Crypto & onchain data", blurb: "Keyless reads across chains: token prices and metadata, order books, stablecoin peg health, wallet balances and transaction history, NFT holdings and metadata, gas snapshots." },
  chain: { label: "Address screening", blurb: "Onchain address checks: screen any blockchain address against every digital currency address on the OFAC SDN list, with the sanctioned entity named on a match." },
  wallet: { label: "Wallet operations", blurb: "Multi-chain balance reads, testnet funding, onramp links, and SQL over onchain data. Non-custodial: the agent signs with its own key." },
  ai: { label: "AI & compute", blurb: "Inference, generation and sandboxed execution priced per call: chat tiers, image generation, text-to-speech, speech-to-text, and code execution in an isolated sandbox." },
  "skill-pack": { label: "Skill packs", blurb: "Multi-tool workflows that run server-side in one request: one payment, one settlement, and a single response with a partial-success envelope if a step fails. Cheaper to integrate than orchestrating the steps yourself." },
  "date-time": { label: "Calendar & date math", blurb: "ISO weeks, leap years, day-of-year, epoch conversion, and movable-feast dates - the calendar edge cases that are easy to get subtly wrong." },
  research: { label: "Market & demand research", blurb: "Analyzed reads over this catalog's own demand and the open x402 ecosystem: what agents ask for, what sells, and company research." },
  agent: { label: "Routing & delegation", blurb: "The Smart Order Router: describe a task and it resolves the best-matching tool and runs it in one call, from this catalog or from an external x402 seller paid on your behalf. Three tiers by underlying price." },
  api: { label: "API primitives", blurb: "Building blocks for services that front an agent: CAPTCHA generation and verification." },
  x402: { label: "x402 seller intelligence", blurb: "Evidence about other x402 sellers, at three depths: the router's own gate field by field (crawl health, advertised chains, observed settlement counts), the assembled record for one origin (price provenance, advertised wallets against the wallets actually paid, settlement evidence per source, the dispatch verdict per chain), and a live payability check that buys one real call and reports every leg." },
};

/** Flatten the catalog into renderable tool descriptors. */
export function toolList(catalog) {
  return Object.entries(catalog).map(([route, def]) => {
    const [method, path] = route.split(" ");
    return { route, method, path, ...def };
  });
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SHARED_CSS = `
  :root { --bg:#0b0e14; --card:#131826; --text:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:920px; margin:0 auto; padding:40px 20px 80px; }
  a { color:var(--accent); }
  h1 { font-size:1.9rem; line-height:1.2; margin-bottom:8px; }
  h2 { margin:32px 0 12px; font-size:1.25rem; }
  .crumb { font-size:.85rem; color:var(--muted); margin-bottom:18px; }
  .price-badge { display:inline-block; background:#1b2336; color:var(--accent); border:1px solid #2a3550; border-radius:999px; padding:3px 12px; font-size:.85rem; font-family:var(--mono); margin:8px 0 4px; }
  .sub { color:var(--muted); max-width:680px; }
  pre { background:#0d1220; border:1px solid #1e2638; border-radius:10px; padding:16px; overflow-x:auto; font-family:var(--mono); font-size:.82rem; line-height:1.5; color:#c9d4ec; }
  code { font-family:var(--mono); font-size:.85em; color:#a5b4d4; }
  .grid { display:grid; gap:12px; margin:20px 0; }
  @media (min-width:640px){ .grid{ grid-template-columns:repeat(3,1fr);} }
  .card { background:var(--card); border:1px solid #1e2638; border-radius:12px; padding:16px; }
  .card h3 { font-size:.95rem; margin-bottom:4px; }
  .card h3 a { text-decoration:none; color:var(--text); }
  .card h3 a:hover { color:var(--accent); }
  .card .price { color:var(--accent); font-family:var(--mono); font-size:.8rem; }
  .card p { color:var(--muted); font-size:.82rem; margin-top:6px; }
  .cat-blurb { color:var(--muted); font-size:.9rem; margin:-6px 0 10px; }
  .free { display:inline-block; background:var(--accent); color:#08130b; font-weight:700; font-size:.68rem; letter-spacing:.02em; padding:1px 7px; border-radius:999px; font-family:system-ui,sans-serif; vertical-align:middle; }
  .paidtag { display:inline-block; background:#1b2336; color:var(--muted); font-size:.68rem; padding:1px 7px; border-radius:999px; font-family:system-ui,sans-serif; vertical-align:middle; }
  .callout { background:#10210f; border:1px solid #1f4a1d; border-radius:12px; padding:14px 16px; margin:16px 0; font-size:.95rem; }
  .callout b { color:var(--accent); }
  table { border-collapse:collapse; width:100%; font-size:.88rem; }
  td, th { border:1px solid #1e2638; padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#10162a; }
  footer { margin-top:56px; color:var(--muted); font-size:.85rem; border-top:1px solid #1e2638; padding-top:20px; }
`;

// Price line for a tool card: compute-payable tools are FREE via proof-of-work
// (the USDC price is the alternative); the rest are USDC-only.
function priceLine(tool) {
  return isComputePayable(tool)
    ? `<span class="free">FREE</span> with compute · or ${tool.price} USDC`
    : `<span class="paidtag">USDC</span> ${tool.price}`;
}

function card(t) {
  return `<div class="card"><h3><a href="/tools/${t.slug}">${esc(t.name)}</a></h3><div class="price">${priceLine(t)} · <code>${t.method} ${esc(t.path)}</code></div><p>${esc(t.description.length > 120 ? t.description.slice(0, 120) + "…" : t.description)}</p></div>`;
}

function head({ title: rawTitle, description: rawDescription, canonical, jsonLd, image }) {
  // Snippet trims live in one place (seo-meta.js); see ledgerShell for why.
  const title = metaTitle(rawTitle);
  const description = metaDescription(rawDescription);
  const blocks = (Array.isArray(jsonLd) ? jsonLd : [jsonLd])
    .filter(Boolean)
    .map((b) => `<script type="application/ld+json">${JSON.stringify(b).replace(/</g, "\\u003c")}</script>`)
    .join("\n");
  const social = image
    ? `<meta name="twitter:card" content="summary_large_image">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:image" content="${image}">`
    : `<meta name="twitter:card" content="summary">`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${CHROME_HEAD_LINKS}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Agent402">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${social}
${blocks}
<style>${SHARED_CSS}${CHROME_CSS}</style>`;
}

function exampleCall(baseUrl, tool) {
  const { method, path, discovery } = tool;
  if (method === "GET") {
    const qs = new URLSearchParams(
      Object.entries(discovery?.input ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
    ).toString();
    return `curl -i "${baseUrl}${path}${qs ? `?${qs}` : ""}"`;
  }
  return `curl -i -X ${method} ${baseUrl}${path} \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(discovery?.input ?? {})}'`;
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
function priceWords(tool) {
  if (tool.quoteRange && Number.isFinite(tool.quoteRange.maxUsd) && tool.quoteRange.maxUsd > tool.quoteRange.minUsd) {
    return { short: `from ${tool.price}`, long: `quoted per request from ${tool.price}` };
  }
  return { short: tool.price, long: `${tool.price} per call` };
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

/** First sentence of a description (a period followed by a capital or the end). */
function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?[.!?])(?=\s+[A-Z(`"]|$)/);
  const out = m ? m[1] : s;
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
export function toolMetaDescription(tool, { computePayable = false } = {}) {
  const MAX = 155, MIN = 120;
  const p = priceWords(tool).long;
  const pay = computePayable ? `${p} over x402, or free with proof-of-work.` : `${p} over x402 or MPP.`;
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

/** Content types a tool answers with as raw bytes (the route binder's
 *  { __binary, contentType } sentinel), or null for a JSON tool. */
export function binaryTypesOf(tool) {
  if (Array.isArray(tool?.binaryTypes) && tool.binaryTypes.length) return tool.binaryTypes;
  if (tool?.mimeType && tool.mimeType !== "application/json") return [tool.mimeType];
  return null;
}

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

function curlExample(baseUrl, tool) {
  const input = tool.discovery?.input ?? {};
  if (tool.method === "GET") {
    return `curl -i "${baseUrl}${tool.path}${exampleQueryString(tool)}"`;
  }
  const body = JSON.stringify(input).replace(/'/g, "'\\''");
  return `curl -i -X ${tool.method} ${baseUrl}${tool.path} \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}

export function toolPage(baseUrl, tool, related, { computePayable = false, powDifficulty = 0, cacheTtl = null, otherMethodRouted = false } = {}) {
  const e = ledgerEsc;
  const title = toolTitle(tool);
  const canonical = `${baseUrl}/tools/${tool.slug}`;
  const catLabel = CATEGORIES[tool.category]?.label ?? tool.category;
  const catHref = `/tools/category/${tool.category}`;
  const pw = priceWords(tool);
  const schema = tool.discovery?.inputSchema || {};
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const example = tool.discovery?.output?.example;
  const input = tool.discovery?.input ?? {};
  // A tool that names its only networks (`onlyNetworks`, e.g. decide-execute:
  // Base) is offered on exactly those (payments.js acceptsForItem), so the page
  // names them (railsOrFor) rather than "EVM chains".
  const evmOnly = x402EvmOnly(tool);
  const binaryTypes = binaryTypesOf(tool);
  const hasOnly = Array.isArray(tool.onlyNetworks) && tool.onlyNetworks.length > 0;
  const evmOne = hasOnly ? railsOrFor(tool) : "USDC on an EVM chain";
  const isPack = tool.category === "skill-pack";
  const packSlug = isPack ? tool.slug.replace(/^skill-/, "") : null;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebAPI",
      name: `Agent402 ${tool.name}`,
      url: canonical,
      description: tool.description,
      documentation: `${baseUrl}/openapi.json`,
      provider: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
      offers: {
        "@type": "Offer",
        price: tool.price.replace("$", ""),
        priceCurrency: "USD",
        description: `${pw.long}, paid over x402 in ${railsOrFor(tool)} or MPP. No signup, no API key.${computePayable ? " Or free with proof-of-work (no wallet)." : ""}`,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: baseUrl },
        { "@type": "ListItem", position: 2, name: "Tools", item: `${baseUrl}/tools` },
        { "@type": "ListItem", position: 3, name: catLabel, item: `${baseUrl}${catHref}` },
        { "@type": "ListItem", position: 4, name: tool.name, item: canonical },
      ],
    },
  ];

  // --- Answer-first summary: what it does, what it costs, how to pay, where it lives.
  const payHow = computePayable
    ? `pay ${pw.long} over x402 or MPP, or call it free by solving a proof-of-work challenge`
    : evmOnly
      ? `pay ${pw.long} over x402 with ${evmOne}${tool.identityBound ? " (the paying wallet is the identity)" : ""}`
      : `pay ${pw.long} over x402 or MPP (there is no free tier)`;
  const reqPhrase = required.length
    ? `${required.length === 1 ? "the required field" : "the required fields"} ${codeList(required)}`
    : Object.keys(props).length ? `no required fields (${Object.keys(props).length} optional)` : "no input";
  // A binary tool's example is a note about the bytes, not a response shape.
  const outKeys = !binaryTypes && example && typeof example === "object" && !Array.isArray(example) ? Object.keys(example) : [];
  const binaryPhrase = binaryTypes ? `raw bytes, not JSON, with <code>Content-Type</code> ${listWords(binaryTypes.map((t) => `<code>${ledgerEsc(t)}</code>`))}` : "";
  const outPhrase = binaryTypes ? binaryPhrase : outKeys.length ? `a JSON object with ${codeList(outKeys, 5)}` : Array.isArray(example) ? "a JSON array" : "the result";
  const summary = `${e(firstSentence(tool.description))} Send <code>${e(tool.method)} ${e(tool.path)}</code> with ${reqPhrase} and ${e(payHow)}. It returns ${outPhrase}.`;
  const restOfDescription = String(tool.description).replace(/\s+/g, " ").trim().slice(firstSentence(tool.description).length).trim();

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
    return `<tr><td><code>${e(k)}</code></td><td>${e(schemaType(v))}</td><td>${req ? "yes" : "no"}</td><td>${e(v.description ?? "")}${altNote}</td></tr>`;
  }).join("\n");

  // --- Response fields from the documented example (same derivation as /openapi.json).
  const respSchema = responseSchemaFor(tool.path, example);
  const respRequired = new Set(respSchema.required || []);
  const respRows = outKeys.map((k) => {
    const v = example[k];
    let sample = typeof v === "string" ? v : v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"} in the example` : `${Object.keys(v).length} field${Object.keys(v).length === 1 ? "" : "s"}: ${Object.keys(v).slice(0, 6).join(", ")}`;
    if (sample && sample.length > 80) sample = sample.slice(0, 77) + "...";
    return `<tr><td><code>${e(k)}</code></td><td>${e(exampleValueType(v))}</td><td>${respRequired.has(k) ? "yes" : "no"}</td><td>${e(sample ?? "")}</td></tr>`;
  }).join("\n");

  // --- Errors and behavior: only statements that hold for this tool.
  const facts = [];
  const inputErrorBody = "<code>error</code>, <code>tool</code>, <code>expected</code>, <code>required</code> and <code>example</code>";
  if (isPack) {
    facts.push(`Arguments left out fall back to the pack's own defaults. Each step reports on its own; the call succeeds when at least one step does, and a run where every step fails is refused (400 when the input caused it, 502 otherwise).`);
  } else if (required.length) {
    facts.push(`${codeList(required, 6)} ${required.length === 1 ? "is" : "are"} required. An input the tool rejects returns an HTTP 4xx whose body carries ${inputErrorBody}, so the caller can correct it.`);
  } else if (Object.keys(props).length) {
    facts.push(`Every field is optional. An input the tool rejects returns an HTTP 4xx whose body carries ${inputErrorBody}.`);
  } else {
    facts.push(`There is no input to get wrong: any request to ${e(tool.path)} runs the tool.`);
  }
  // Settlement on failure, per rail this route offers. x402, MPP evm and card
  // settle only after an under-400 answer and a credits key is debited only on
  // a 200; a Tempo PUSH credential is a transfer already on chain before the
  // tool runs (src/mpp-tempo.js), so a failure there is a refund owed
  // (src/tempo-push-debts.js), not a cancelled charge.
  const tempoHere = tempoOfferedFor(tool) && !!tempoDiscoveryInfo();
  const notCharged = ["x402", "MPP", ...(tool.identityBound ? [] : ["a prepaid credits key"])];
  facts.push(`A paid call that ends in any status of 400 or above is not charged over ${listWords(notCharged)}: settlement is cancelled when the tool fails.${tempoHere ? " The exception is a Tempo push credential, a transfer the buyer sent before the call: it settles before the tool runs, so if the tool then fails the payment is recorded as a refund owed to the paying wallet." : ""}`);
  if (computePayable) facts.push(`Free tier: no outbound network call leaves the server for this tool, so proof-of-work (${e(String(powDifficulty))} leading zero bits of sha256) pays for it.`);
  else facts.push(`Wallet-only: this tool ${tool.modelBacked ? "runs a model, so it has no proof-of-work tier" : WALLET_ONLY_POLICY_REASON.has(tool.slug) ? `${e(WALLET_ONLY_POLICY_REASON.get(tool.slug))}, so it is metered with money and has no proof-of-work tier` : "reaches the network or stored state, so it has no proof-of-work tier"}.${tool.identityBound ? "" : " A prepaid card-credits key (<code>Authorization: Bearer a402_...</code>) also pays it."}`);
  if (tool.modelBacked) facts.push(`Model-backed: the answer is generated by a model, so the same input can produce different wording.`);
  if (tool.identityBound) facts.push(`Identity-bound: results are keyed to the wallet that signed the payment, so only EVM x402 payments are accepted; credits keys and Tempo are refused.`);
  else if (tool.longRunning) facts.push(`Long-running: payment settles after the work finishes, so only EVM exact payments are offered.`);
  if (tool.quoteRange) facts.push(`Priced per request: the 402 quotes this body, between ${e(tool.price)} and $${e(String(tool.quoteRange.maxUsd))}.`);
  if (typeof tool.tierQuote === "function") facts.push(e(PRICED_BY_MODEL_NOTE));
  if (cacheTtl) facts.push(`Cached: an identical request within ${e(fmtTtl(cacheTtl))} is answered from cache with <code>X-Cache: hit</code>.`);
  // The method alias (server.js) runs only when no catalog route of the other
  // method shares this path: /api/memory has both, so neither page says it.
  if (!otherMethodRouted) {
    facts.push(tool.method === "GET"
      ? `A <code>POST</code> with a JSON body to ${e(tool.path)} is served as this GET, with the body as the input.`
      : `A <code>GET</code> or <code>HEAD</code> to ${e(tool.path)} returns the same 402 quote, so the price can be read without a body.`);
  }
  // The replay cache holds JSON answers only (it captures res.json) and only
  // up to IDEM_MAX_BODY_BYTES; bytes and streams are never replayed.
  if (binaryTypes) facts.push(`An <code>Idempotency-Key</code> header does not replay this tool's answer: the replay cache holds JSON answers only, so a retried paid call runs and is charged again.`);
  else facts.push(`An <code>Idempotency-Key</code> header makes a retried paid call replay the first 200 instead of charging again (an answer larger than ${e(IDEM_MAX_BODY_LABEL)}${String(tool.path).startsWith("/v1/") ? " and a streamed response are" : " is"} not replayed).`);

  // --- MCP usage.
  const mcpArgs = JSON.stringify({ slug: tool.slug, params: input }, null, 2);
  const mcpNote = computePayable
    ? `On the hosted connector at <code>${e(baseUrl)}/mcp</code>, <code>catalog.call</code> runs ${e(tool.slug)} free (rate-limited, no wallet).`
    : `The hosted connector at <code>${e(baseUrl)}/mcp</code> needs a payment for ${e(tool.slug)}; the stdio package pays it from a wallet or from <code>AGENT402_CREDITS_KEY</code>${tool.identityBound ? " (wallet only for this tool)" : ""}.`;

  const aliases = (Array.isArray(tool.aliases) ? tool.aliases : []).filter((a) => a && a !== tool.slug);
  const tagsLine = (tool.tags || []).length ? (tool.tags || []).slice(0, 8).map((t) => `<code>${e(t)}</code>`).join(" ") : "";

  const relatedCards = related.map((t) => {
    const desc = t.description.length > 120 ? t.description.slice(0, 120) + "…" : t.description;
    return `<div class="tp-card">
  <h3 style="font-size:15px;margin:0;"><a href="/tools/${e(t.slug)}" style="text-decoration:none;color:var(--ink);">${e(t.name)}</a></h3>
  <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${ledgerPriceLine(t)} · <code style="background:transparent;color:var(--faint);font-size:12px;">${e(t.method)} ${e(t.path)}</code></div>
  <p style="color:var(--muted);font-size:13px;margin:0;line-height:1.5;flex:1;">${e(desc)}</p>
</div>`;
  }).join("\n");

  // Surface which curated multi-tool workflows include this tool.
  const inPacks = SKILL_PACKS.filter((p) => (p.toolSlugs || []).includes(tool.slug));
  const packsHtml = inPacks.length
    ? `<h2 class="tp-h2">Part of these workflows</h2>
  <p class="tp-sub">${e(tool.name)} is one step in ${inPacks.length === 1 ? "this skill pack" : `these ${inPacks.length} skill packs`}, each sold as a single call:</p>
  <ul style="padding-left:20px;">${inPacks.map((p) => `<li style="margin-bottom:6px;"><a href="/skills/${e(p.slug)}" style="color:var(--accent);font-weight:700;">${e(p.title)}</a> - <span style="color:var(--muted);">${e(p.tagline)}</span></li>`).join("")}</ul>`
    : "";

  const methodColor = tool.method === "GET" ? "var(--green)" : "var(--accent)";

  // The H1 clamp: tool names run from 3 chars ("hex") to 50+, and this H1's
  // width shrinks continuously as the viewport narrows (single-column, no grid
  // breakpoint to reserve a worst case against), so a fixed min-height would
  // waste space at in-between widths or still miss the narrowest ones. A fixed
  // 2-line box makes the height deterministic at every width; the few long
  // names that truncate keep the full text in the title attribute and the
  // page <title>. A JS comment, not a CSS one: the CSS block is served.
  const TOOL_PAGE_CSS = `
  .tp-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  .tp-crumb { font-family:var(--font-mono); font-size:13px; color:var(--faint); margin-bottom:18px; }
  .tp-crumb a { color:var(--accent); text-decoration:none; }
  .tp-h1 { font-family:var(--font-body); font-weight:800; font-size:38px; line-height:1; letter-spacing:-.02em; margin-bottom:10px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-overflow:ellipsis; }
  .tp-badge { display:inline-block; background:var(--surface); color:var(--on-dark); font-family:var(--font-mono); font-size:13px; padding:8px 16px; margin:8px 0 6px; }
  .tp-sub { color:var(--muted); font-size:16px; line-height:1.6; max-width:760px; }
  .tp-lead { color:var(--ink); font-size:17px; line-height:1.6; max-width:760px; margin:14px 0 6px; }
  .tp-sub code, .tp-lead code, .tp-facts code { background:var(--card); border:1px solid var(--hairline); font-family:var(--font-mono); padding:1px 5px; font-size:.86em; }
  .tp-h2 { font-weight:800; font-size:22px; margin:40px 0 10px; letter-spacing:-.01em; }
  .tp-table { border-collapse:collapse; width:100%; font-size:14px; }
  .tp-table td, .tp-table th { border:1px solid var(--hairline); padding:10px 12px; text-align:left; vertical-align:top; }
  .tp-table th { background:var(--card); font-weight:700; }
  .tp-tw { overflow-x:auto; }
  .tp-pre { background:var(--surface); color:var(--on-dark); font-family:var(--font-mono); font-size:13px; line-height:1.6; padding:18px 20px; overflow-x:auto; border:none; white-space:pre; }
  .tp-grid { display:grid; gap:14px; margin:20px 0; }
  @media (min-width:640px){ .tp-grid { grid-template-columns:repeat(3,1fr); } }
  .tp-card { background:var(--card); border:1px solid var(--hairline); padding:18px 20px; display:flex; flex-direction:column; gap:8px; }
  .tp-free { display:inline-block; background:var(--green); color:#08130b; font-weight:700; font-size:11px; letter-spacing:.02em; padding:2px 8px; font-family:var(--font-mono); vertical-align:middle; }
  .tp-facts { color:var(--muted); font-size:15px; line-height:1.65; max-width:820px; padding-left:20px; }
  .tp-facts li { margin-bottom:6px; }
  .tp-meta { color:var(--faint); font-size:13px; font-family:var(--font-mono); margin-top:10px; }
  `;

  const body = `<div class="tp-wrap">
  <nav class="tp-crumb" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/tools">Tools</a> / <a href="${e(catHref)}">${e(catLabel)}</a> / ${e(tool.name)}</nav>
  <h1 class="tp-h1" title="${e(tool.name)}">${e(tool.name)}</h1>
  <div class="tp-badge">${
    computePayable
      ? `<span class="tp-free">FREE</span> <span style="color:var(--dk-muted);">with proof-of-work</span> · <span style="color:var(--dk-muted2);">or ${e(tool.price)} in USDC</span>`
      : `<span style="color:var(--on-dark);">${e(pw.long)}</span> · <span style="color:var(--dk-muted);">USDC via x402</span>`
  } · <code style="color:${methodColor};background:transparent;font-size:13px;">${e(tool.method)}</code> <code style="color:var(--dk-muted2);background:transparent;font-size:13px;">${e(tool.path)}</code>${
    cacheTtl ? ` · <span style="color:var(--dk-muted);" title="Server caches identical responses for ${e(fmtTtl(cacheTtl))}.">Cached ${e(fmtTtl(cacheTtl))}</span>` : ""
  }</div>
  <p class="tp-lead">${summary}</p>
  ${restOfDescription ? `<p class="tp-sub">${e(restOfDescription)}</p>` : ""}
  <p class="tp-meta">Category: <a href="${e(catHref)}" style="color:var(--accent);">${e(catLabel)}</a>${tagsLine ? ` · Tags: ${tagsLine}` : ""}${aliases.length ? ` · Also found as: ${aliases.slice(0, 6).map((a) => `<code>${e(a)}</code>`).join(" ")}` : ""}${isPack ? ` · <a href="/skills/${e(packSlug)}" style="color:var(--accent);">Pack overview</a>` : ""}</p>
  <p style="margin:16px 0 0;"><a class="ml-cta" href="/playground?slug=${e(tool.slug)}" style="display:inline-block;background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 16px;">TRY IN PLAYGROUND →</a></p>

  <h2 class="tp-h2">Parameters</h2>
  ${paramRows ? `<div class="tp-tw"><table class="tp-table"><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr>${paramRows}</table></div>` : `<p class="tp-sub">${e(tool.name)} takes no parameters.</p>`}

  <h2 class="tp-h2">Example request</h2>
  <pre class="tp-pre">${e(curlExample(baseUrl, tool))}</pre>
  <p class="tp-sub">Without payment this returns <code>HTTP 402 Payment Required</code> with the exact price for ${e(tool.slug)}; any x402 v2 or MPP client pays it and retries.</p>

  <h2 class="tp-h2">Example response</h2>
  ${binaryTypes
    ? `<p class="tp-sub">A 200 carries ${binaryPhrase}: the file itself.</p>`
    : `<pre class="tp-pre">${e(JSON.stringify(example ?? {}, null, 2))}</pre>`}
  ${respRows ? `<div class="tp-tw"><table class="tp-table"><tr><th>Field</th><th>Type</th><th>Always present</th><th>In the example</th></tr>${respRows}</table></div>` : ""}

  <h2 class="tp-h2">From an MCP client</h2>
  <pre class="tp-pre">catalog.call ${e(mcpArgs)}</pre>
  <p class="tp-sub">${mcpNote} Local install: <code>npx -y agent402-mcp</code>.</p>

  <h2 class="tp-h2">Errors and behavior</h2>
  <ul class="tp-facts">${facts.map((f) => `<li>${f}</li>`).join("\n")}</ul>

  <h2 class="tp-h2">Paid call (JavaScript agent)</h2>
  <pre class="tp-pre">${e(`import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.setSpendControls?.(false); // keep your own spending ceiling in code
registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

${payExample(baseUrl, tool)}`)}</pre>

  ${
    computePayable
      ? `<h2 class="tp-h2">No wallet? Pay with compute</h2>
  <p class="tp-sub">Fetch a challenge, solve the sha256 puzzle (${e(String(powDifficulty))} leading zero bits, a fraction of a second of CPU), and resend with the <code>X-Pow-Solution</code> header:</p>
  <pre class="tp-pre">${e(`import { createHash } from "node:crypto";
const lz = (b) => { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("${baseUrl}/api/pow/challenge?slug=${tool.slug}")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) < c.difficulty) n++;
await fetch("${powSnippetRequest(baseUrl, tool).url}", { method: "${tool.method}", headers: { "X-Pow-Solution": c.token + ":" + n${tool.method === "POST" ? ', "Content-Type": "application/json"' : ""} }${tool.method === "POST" ? `, body: JSON.stringify(${JSON.stringify(input)})` : ""} });`)}</pre>`
      : ""
  }

  ${packsHtml}

  ${relatedCards ? `<h2 class="tp-h2">Related tools</h2>
  <div class="tp-grid">${relatedCards}</div>` : ""}
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description: toolMetaDescription(tool, { computePayable }),
    canonical,
    baseUrl,
    activePath: "/tools",
    ogImage: `${baseUrl}/tools/${tool.slug}/card.png`,
    jsonLd,
    extraCss: TOOL_PAGE_CSS,
    body,
  });
}

// Price line for the new ledger card style
function ledgerPriceLine(tool) {
  return isComputePayable(tool)
    ? `<span style="background:var(--green);color:#08130b;font-weight:700;font-size:11px;padding:1px 6px;font-family:var(--font-mono);">FREE</span> w/ compute · or ${tool.price}`
    : `${tool.price}`;
}

export function toolsIndexPage(baseUrl, catalog) {
  const tools = toolList(catalog);
  const canonical = `${baseUrl}/tools`;
  const title = `${tools.length} pay-per-call APIs for AI agents | Agent402 tool catalogue`;
  const description = `${tools.length} machine-payable tools for AI agents: browser rendering, PDF extraction, wallet-keyed memory, conversions, validation, networking. USDC per call via x402 - no API keys.`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Agent402 tool catalogue",
    numberOfItems: tools.length,
    itemListElement: tools.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: t.name,
      url: `${baseUrl}/tools/${t.slug}`,
    })),
  };
  const freeCount = tools.filter(isComputePayable).length;
  const sections = Object.entries(CATEGORIES)
    .map(([key, { label, blurb }]) => {
      const inCat = tools.filter((t) => t.category === key);
      if (!inCat.length) return "";
      const free = inCat.filter(isComputePayable).length;
      const tag =
        free === inCat.length
          ? ` <span class="free">ALL FREE w/ compute</span>`
          : free > 0
            ? ` <span class="free">${free} FREE w/ compute</span>`
            : ` <span class="paidtag">USDC only</span>`;
      // Large families (e.g. the 100+ live-data tools) render as a compact
      // sample + count, not hundreds of cards; each still has its own /tools page.
      if (inCat.length > 40) {
        const sample = inCat
          .slice(0, 24)
          .map((t) => `<a href="/tools/${t.slug}">${esc(t.name)}</a>`)
          .join(" · ");
        return `<h2><a href="/tools/category/${key}" style="color:inherit;text-decoration:none">${esc(label)}</a> <span style="color:var(--muted);font-size:.85rem">(${inCat.length})</span>${tag}</h2>
<p class="cat-blurb">${esc(blurb)}</p>
<p class="sub" style="font-size:.85rem">${sample} · <a href="/tools/category/${key}">…and ${inCat.length - 24} more →</a></p>`;
      }
      const cards = inCat.map(card).join("\n");
      return `<h2><a href="/tools/category/${key}" style="color:inherit;text-decoration:none">${esc(label)}</a> <span style="color:var(--muted);font-size:.85rem">(${inCat.length})</span>${tag}</h2>
<p class="cat-blurb">${esc(blurb)}</p>
<div class="grid">${cards}</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description, canonical, jsonLd, image: `${baseUrl}/card.png` })}
</head>
<body>
${renderHeader("/tools")}
<div class="wrap">
  <div class="crumb"><a href="/">Agent402</a> / tools</div>
  <h1>${tools.length} tools, one base URL, zero API keys</h1>
  <p class="sub">Call any endpoint, get an <code>HTTP 402</code> quote, and either pay a fraction of a cent in ${RAILS_PAREN} via <a href="https://x402.org" rel="noopener">x402</a> - or, on the <span class="free">FREE</span> tools, skip the wallet entirely. The catalog is capped - every tool here earns its place and answers its own example on every deploy. Machine-readable: <a href="/api/pricing">/api/pricing</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/llms.txt">/llms.txt</a>.</p>
  <div style="margin:18px 0"><input id="tool-search" type="text" placeholder="Search ${tools.length} tools\u2026" style="width:100%;max-width:480px;padding:10px 16px;background:#0d1220;border:1px solid #1e2638;border-radius:10px;color:#e6e9f0;font-size:.95rem;outline:none;"><span id="tool-search-count" style="margin-left:12px;color:#8b93a7;font-size:.85rem"></span></div>
  <div class="callout"><b>${freeCount} of ${tools.length} tools are free</b> - no wallet needed. Pay with a few seconds of <a href="/api/pow">proof-of-work</a> (CPU) instead of USDC. The other ${tools.length - freeCount} (browser, network, memory) settle in USDC because they cost real infrastructure to run. Look for the <span class="free">FREE</span> badge below.</div>
  ${sections}
  <script src="/js/pages-tool-search.js"></script>
</div>
${renderFooter()}
</body>
</html>`;
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
  const title = `${cat.label} - ${tools.length} tools | Agent402`;
  const description = `${cat.blurb} ${tools.length} tools, ${freeCount} free via proof-of-work.`;
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
    const desc = t.description.length > 120 ? t.description.slice(0, 120) + "\u2026" : t.description;
    return `<div style="background:var(--card);border:1px solid var(--hairline);padding:18px 20px;display:flex;flex-direction:column;gap:8px;">
  <h3 style="font-size:15px;margin:0;"><a href="/tools/${e(t.slug)}" style="text-decoration:none;color:var(--ink);">${e(t.name)}</a></h3>
  <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${ledgerPriceLine(t)} · <code style="background:transparent;color:var(--faint);font-size:12px;">${t.method} ${e(t.path)}</code></div>
  <p style="color:var(--muted);font-size:13px;margin:0;line-height:1.5;flex:1;">${e(desc)}</p>
  <a href="/playground?slug=${e(t.slug)}" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);text-decoration:none;font-weight:700;">try in playground →</a>
</div>`;
  }).join("\n");

  const CAT_CSS = `
  .cp-grid { display:grid; gap:14px; margin:20px 0; }
  @media (min-width:640px){ .cp-grid { grid-template-columns:repeat(3,1fr); } }
  `;

  const body = `<div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--faint);margin-bottom:18px;"><a href="/" style="color:var(--accent);text-decoration:none;">Agent402</a> / <a href="/tools" style="color:var(--accent);text-decoration:none;">tools</a> / ${e(cat.label)}</div>
  <h1 style="font-family:var(--font-body);font-weight:800;font-size:38px;line-height:1;letter-spacing:-.02em;margin-bottom:10px;">${e(cat.label)}</h1>
  <p style="color:var(--muted);font-size:16px;line-height:1.6;max-width:720px;">${e(cat.blurb)}</p>
  <div style="background:var(--card);border:1px solid var(--hairline);padding:16px 20px;margin:18px 0;font-size:15px;"><b style="color:var(--accent);">${tools.length} tools</b> in this category${freeCount ? ` - <b style="color:var(--accent);">${freeCount} free</b> via proof-of-work` : ""}. <a href="/tools" style="color:var(--accent);">\u2190 All tools</a></div>
  <div class="cp-grid">${cards}</div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/tools",
    jsonLd: [jsonLd, breadcrumbLd(baseUrl, [["Agent402", "/"], ["Tools", "/tools"], [cat.label, `/tools/category/${catKey}`]])],
    extraCss: CAT_CSS,
    body,
  });
}

// On-site FAQ — surfaces the wiki FAQ for Google (FAQPage rich results) and for
// humans/agents landing on the site. The Q&A pairs are the single source for
// BOTH the visible HTML and the JSON-LD, so they can't drift apart. Answers may
// contain simple inline HTML (links) — allowed in FAQPage and rendered as-is.
const FAQ_ITEMS = [
  { q: "Do I need an account or API key?", a: 'No. Nothing here has a signup. Payment - USDC, proof-of-work, or a prepaid card-credits key you bought at <a href="/credits">/credits</a> - is the only credential, charged per call.' },
  { q: "Can I pay by card instead of crypto?", a: 'Yes, three ways: buy a finished report at <a href="/reports">/reports</a> ($2 to $5 by card, refunded if it fails), subscribe to a monitor at <a href="/monitors">/monitors</a> ($5 a month, cancel anytime), or buy prepaid credits at <a href="/credits">/credits</a> and call any tool with <code>Authorization: Bearer a402_…</code> - debited only when a call succeeds. The card price includes payment processing; an agent paying per call over x402 or MPP pays the lower tool price for the same report.' },
  // DERIVED. Every figure in this answer was typed once and then outlived two
  // repricings: the pack ceiling was over ten times the real one and the card
  // range was quoted below its own floor, which a reader meets at checkout.
  { q: "What does it cost?", a: `Flat per-call prices from $0.001. Most tools are $0.001 to $0.02; premium AI and media tiers run higher and multi-tool skill packs are ${PACK_PRICE_RANGE.text}; finished report products are ${agentReportPriceRange()?.text || "priced per product"} per call for an agent per report (${cardReportPriceRange(HUMAN_PRODUCTS)?.text || "priced per product"} by card at <a href="/reports">/reports</a>, where the price includes payment processing). Every price is published in <a href="/api/pricing">/api/pricing</a> and quoted exactly in every HTTP 402 response. No subscriptions. The metered model route (<code>/v1/metered</code>) quotes each request from its body before payment and settles what the call used, under that quote.` },
  { q: "Can I use it without any money or a wallet?", a: "Yes. Most pure-CPU tools accept proof-of-work - a sub-second sha256 puzzle solved by your own CPU - and the hosted MCP connector runs that same set for free (rate-limited)." },
  { q: "What is x402?", a: 'An open HTTP payment standard built on the 402 Payment Required status code, for machine-to-machine pay-per-call payments in stablecoins, with settlement infrastructure from Coinbase. Plain-English explainer: <a href="/what-is-x402">/what-is-x402</a>.' },
  { q: "What is MPP, and does Agent402 support it?", a: 'Yes - every paid endpoint is dual-stack, and now natively via Tempo too. MPP (Machine Payments Protocol, the IETF-track Payment HTTP authentication scheme) carries the pay-per-call handshake through the web&rsquo;s standard auth headers: the 402 carries a <code>WWW-Authenticate: Payment</code> challenge, the client pays via <code>Authorization: Payment</code>, and settled responses return a signed <code>Payment-Receipt</code>. Same URL, same price either way - MPP&rsquo;s evm method settles identically to x402 (same on-chain USDC settlement), while its tempo method settles natively via Tempo&rsquo;s own relay, a genuinely separate mechanism. How the two compare: <a href="/what-is-x402">/what-is-x402</a>; the full MPP explainer: <a href="/what-is-mpp">/what-is-mpp</a>.' },
  { q: "Which blockchain and asset does it use?", a: `${RAILS_PAREN}. The buyer needs only the stablecoin - gas is sponsored by the facilitator on EVM chains.` },
  { q: "Does using this spend my AI tokens?", a: "No. Not your tokens, ever: you never hand us a model key, and a model we run is billed to us and priced into the call. Most of the catalog is deterministic code (parsers, hashes, math, a real browser) with no model in its path. The ones that do run a model are named: the /v1 gateway tiers, the report products, and the image, speech, transcription, embedding and AI-answer tools. Proof-of-work spends your CPU; x402 spends USDC." },
  { q: "Is there an OpenAI-compatible endpoint?", a: 'Yes - <code>/v1</code> is a pay-per-call OpenAI-wire LLM gateway: point any OpenAI SDK at <code>base_url https://agent402.tools/v1</code> for chat (five quality tiers, model-optional auto-routing), embeddings, and image generation. No API key, no signup - settle in USDC over x402, same as every other tool. See <a href="/pricing">/pricing</a> for the tier breakdown.' },
  { q: "Is my data stored?", a: 'Tool inputs are processed in memory to compute the response. The memory tools store data by design (wallet-keyed, owner-deletable, with optional TTL). An input is otherwise kept only in the cases the privacy policy lists, such as short-lived response caches, catalog searches that find no tool, decisions bought on /api/decide (30 days), and the feedback you leave on a paid call. Full policy: <a href="/privacy">/privacy</a>.' },
  { q: "How do I know the service is honest?", a: "It is fully open source; CI re-tests every endpoint against its own documented example before each deploy; and revenue settles on-chain to agent402.base.eth (the named public receiving wallet), auditable by anyone on Basescan." },
  { q: "What happens if a tool fails after I pay?", a: "You are not charged. Payment settles only for a successful (under-400) response, so an error cancels settlement and no money moves. On top of that guarantee, anything which can't be served reliably is removed from the catalog rather than left to fail, and failure rates are watched by CI and a 15-minute production heartbeat." },
  { q: "Is Agent402 self-hostable and open source?", a: 'Yes - the server is open source under the AGPL-3.0 license (the client SDK, MCP connector, and tollbooth are MIT). Clone the repo and run it yourself for free, with or without payments enabled. It also ships agent402-tollbooth, an open-source pay-per-crawl gate for charging AI crawlers on your own site.' },
  { q: "Can I find tools on other x402 sellers from here?", a: 'Yes. Agent402 is also an x402 Index + Smart Order Router: <code>POST /api/route</code> ranks tools across every x402 seller we have crawled - the local catalog plus sellers auto-discovered from public registries like the Coinbase CDP Bazaar, refreshed hourly. It filters out unhealthy sellers and tiebreaks on health then price. Browse the live marketplace at <a href="/marketplace">/marketplace</a> or fetch the index as JSON at <a href="/api/index">/api/index</a>, which is paginated - one page at a time, with <code>?seller=&lt;host&gt;</code> for a single origin. Both surfaces are free.' },
  { q: "How do I list my own API?", a: 'For free, three ways: your origin is auto-discovered from public x402 registries (Coinbase CDP Bazaar, GoPlausible) once it&rsquo;s live and settling; paste it on <a href="/sell">/sell</a> for an immediate probe; or call <code>POST /api/index/register</code> directly. A listed seller is routable by the Smart Order Router and ranked on <a href="/leaderboard">/leaderboard</a> by real on-chain USDC volume - 0% take, settlement lands straight in your wallet.' },
  { q: "How do I see which x402 sellers are most used?", a: '<code>GET <a href="/api/leaderboard">/api/leaderboard</a></code> returns the <b>head</b> of the live on-chain ranking of x402 sellers by Base USDC settled volume - callsSettled, totalUsd, and uniqueBuyers per seller. It is a top-N slice, not the whole board: 25 rows by default, up to 50 with <code>?top=N</code>, and the response carries <code>totalSellers</code> for how many are ranked in all, so a seller absent from the rows you were served may still be ranked below them. The pipeline walks every page of the Coinbase CDP Bazaar discovery endpoint, queries <code>eth_getLogs</code> on Base USDC for each seller&rsquo;s payTo, counts a transfer that matches a price the seller publishes and otherwise holds it to the per-call ceiling the response reports as <code>maxCallUsd</code> (larger inbound is funding/swaps, not buys), and aggregates over the window the response reports as <code>windowServed</code>. The snapshot refreshes hourly server-side. Free, like <code>/api/find</code> and <code>/api/route</code>. Use <code>?include=external</code> to exclude Agent402 itself and rank only the rest of the ecosystem.' },
  { q: "How does the Smart Order Router decide which seller to route to?", a: "It shortlists tools by lexical match against your query (at most two listings per seller) and by seller health (computed from the last five crawl outcomes), then a judgment model picks the one that actually does the task; when several do it equally well, the cheapest wins. If none of them does, route-and-execute refuses before anything is paid. Sellers whose recent crawls errored are excluded entirely - a buyer routed to a dead seller wastes money. Brand-new sellers with no history yet are still routable: benefit of the doubt for newcomers." },
  { q: "Who runs Agent402?", a: `Havok Holdings LLC - a public, contactable maintainer reachable at <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>, on <a href="${REPO_URL}">GitHub</a>, and on <a href="https://x.com/Agent402Tools">X</a>.` },
];

export function faqPage(baseUrl) {
  const e = ledgerEsc;
  const canonical = `${baseUrl}/faq`;
  const title = "Agent402 FAQ - x402 + MPP + MCP server for AI agents";
  const description =
    `Frequently asked questions about Agent402: pricing, proof-of-work, x402 and ${RAILS_SHORT}, the OpenAI-compatible /v1 gateway, self-serve listing, MCP, data handling, and self-hosting the open-source server.`;
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
  .fq-item:first-of-type { border-top:1px solid var(--hairline); }
  .fq-item > summary { list-style:none; cursor:pointer; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 0; font-family:var(--font-body); font-weight:800; font-size:18px; line-height:1.3; color:var(--ink); }
  .fq-item > summary::-webkit-details-marker { display:none; }
  .fq-mark { font-family:var(--font-mono); font-weight:400; font-size:22px; line-height:1; color:var(--accent); flex:none; transition:transform .15s ease; display:inline-block; }
  .fq-item[open] .fq-mark { transform:rotate(45deg); }
  @media (prefers-reduced-motion:reduce){ .fq-mark { transition:none; } }
  .fq-item p { color:var(--muted); font-size:15px; line-height:1.7; margin:0; padding:0 0 22px; max-width:760px; }
  .fq-item a { color:var(--accent); }
  .fq-item code { background:var(--surface); color:var(--on-dark); font-family:var(--font-mono); padding:2px 6px; font-size:13px; }
  `;

  const items = FAQ_ITEMS.map(
    (it, i) => `<details class="fq-item"${i === 0 ? " open" : ""}><summary><span>${e(it.q)}</span><span class="fq-mark">+</span></summary><p>${it.a}</p></details>`
  ).join("\n");

  const body = `<div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
  <section>
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;">FAQ</div>
  <h1 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:.96;letter-spacing:-.03em;margin-bottom:14px;">Frequently asked questions</h1>
  <p style="color:var(--muted);font-size:16px;line-height:1.6;max-width:720px;margin-bottom:32px;">Agent402 is the open-source, self-hostable applied layer of Agentic Finance for x402 and MPP (+ MCP server): an open cross-seller Index, Smart Order Router, on-chain leaderboard and MPP marketplace, built on pay-per-call web tools for AI agents - free via proof-of-work, or paid in ${RAILS_AMP} over x402, or over MPP (Base/Celo USDC, native Tempo).</p>
  </section>
  <section>
  ${items}
  </section>
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

export function openapiSpec(baseUrl, catalog) {
  const paths = {};
  // MPP start-here set (src/mpp-flagship.js), already filtered to routes the
  // 402 offers tempo on. Marked per operation and indexed at the top level.
  const mppFlagship = mppFlagshipRows(catalog);
  const mppFlagshipBySlug = new Map(mppFlagship.map((r) => [r.slug, r]));
  for (const tool of toolList(catalog)) {
    const { method, path, discovery } = tool;
    const op = {
      operationId: `${tool.slug}${method === "GET" ? "Get" : ""}`,
      summary: `${tool.name} (${tool.quoteRange ? `from ${tool.price}` : tool.price}/call via x402 or MPP)`,
      // A route that can quote MORE than its list price for some bodies says so
      // here, in the same breath as the number. `x-price` stays the list price
      // (it is what this route charges for the models it serves, and every
      // other surface agrees with it); the sentence is what keeps the number
      // from reading as a ceiling it is not.
      // The 402 walkthrough lives ONCE in info.x-guidance; repeating it on
      // every operation was ~20% of a 2 MB document for no new information.
      description: `${tool.description}\n\nPrice: ${typeof tool.quote === "function" ? `quoted per request from the body, from ${tool.price}` : `${tool.price} per call`}, over x402 (${railsOrFor(tool)}) or MPP (${tool.identityBound || tool.longRunning ? "Base" : "Tempo or Base"}).${typeof tool.tierQuote === "function" ? ` ${PRICED_BY_MODEL_NOTE}` : ""} Docs: ${baseUrl}/tools/${tool.slug}`,
      tags: [tool.category],
      responses: {
        200: {
          description: "Success",
          // A binary tool answers raw bytes (one content type per format it
          // can produce), never the JSON note its discovery example carries.
          content: binaryTypesOf(tool)
            ? Object.fromEntries(binaryTypesOf(tool).map((t) => [t, { schema: { type: "string", format: "binary" } }]))
            : { "application/json": { schema: responseSchemaFor(path, discovery?.output?.example), example: discovery?.output?.example ?? {} } },
        },
        402: { description: "Payment Required - x402 payment requirements in the PAYMENT-REQUIRED header, mirrored in the JSON body, and MPP challenges (WWW-Authenticate: Payment)" },
        400: { description: "Invalid input" },
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
        const priceUsd = Number(String(tool.price ?? "").replace(/[^0-9.]/g, "")) || 0;
        // Per-request-priced routes (metered, priced by model) publish their
        // range, never the catalog floor as if it were the price.
        const range = tool.quoteRange || null;
        const fmtUsd = (n) => String(Number(n.toFixed(6)));
        // Every MPP offer the live 402 makes on this route, in the order it
        // lists them (tempo per currency, evm per chain, stripe) - read from
        // the same predicates and env the 402 middlewares read, so the
        // document never promises a method the 402 withholds (identity-bound
        // and long-running routes get no tempo; stripe only at or above the
        // card minimum; nothing when a method is switched off).
        const mpp = mppOffersFor({ priceUsd, identityBound: tool.identityBound, longRunning: tool.longRunning });
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
          offers: mpp.map((o) => ({
            intent: o.intent,
            method: o.method,
            amount: range ? null : String(Math.round(priceUsd * 10 ** o.decimals)),
            currency: o.currency,
            ...(o.chainId ? { chainId: o.chainId } : {}),
            description: o.description,
          })),
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
        description: "Same key + same credential + same body replays the paid result without charging again.",
        schema: { type: "string" },
      },
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
          schema: { type: QUERY_PARAM_TYPES.has(schema.type) ? schema.type : "string" },
          ...(discovery?.input?.[name] !== undefined ? { example: discovery.input[name] } : {}),
        })),
        ...headerParams,
      ];
    } else {
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", properties: props, required: required.length ? required : undefined },
            example: discovery?.input ?? {},
          },
        },
      };
      op.parameters = headerParams;
    }
    paths[path] = paths[path] ?? {};
    paths[path][method.toLowerCase()] = op;
  }
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
          content: { "application/json": { schema: { type: "object" } } },
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
          content: { "application/json": { schema: { type: "object" } } },
        },
        404: { description: "Unknown slug. Use /api/skill-packs.json to list." },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      // The title/description here are what x402scan, MPPScan and every
      // OpenAPI-reading directory display as OUR NAME - keep them aligned with
      // the homepage: both wires (x402 + MPP), not "x402 server".
      title: "Agent402: 500+ pay-per-call tools for AI agents over x402 + MPP",
      version: "2.1.0",
      description:
        // Template literal, not a plain string: this is the spec description
        // every crawler and directory reads, and as a quoted string it shipped
        // a literal ${RAILS_OR} to production.
        `The open-source, self-hostable applied layer of Agentic Finance - agents paying and getting paid over x402 and MPP: 500+ machine-payable web tools for AI agents in one place (browser, search, PDFs, images, live data, payment helpers) - the whole catalog is open and runnable yourself. Each priced operation is paid per call over x402 (${RAILS_OR}; identity-bound and long-running operations take EVM chains only, and each operation's description names its own rails), or over MPP (Machine Payments Protocol: USDC on Base/Celo, or USDC.e (and PathUSD) natively on Tempo) - no signup, no API keys - the first request returns HTTP 402 carrying both offers, an x402 or mppx client pays and retries - or free with proof-of-work. Also the open x402 index, Smart Order Router and MPP marketplace. Free discovery: GET /api/pricing, GET /llms.txt. Multi-tool workflows: GET /api/skill-packs.json.`,
      // Email doubles as x402scan's ownership-verification signal; it is the
      // same public maintainer contact the /.well-known/x402 manifest names.
      contact: { name: "Havok Holdings LLC", email: "mike@agent402.tools", url: baseUrl },
      // Agent-facing quickstart read by MPP/x402 discovery crawlers
      // (info.x-guidance in MPPScan's audit).
      "x-guidance":
        // Scoped to the operations that carry x-price: discovery paths such as
        // /api/find, /api/route, /api/index and /api/pricing are free and are
        // not pay-per-call. No credits sentence: credit sales are off by
        // default (CREDITS_SALES), so "buy at /credits" is not an instruction
        // an agent can follow.
        "Every operation in this document that carries x-price is pay-per-call: request it unauthenticated, read the 402 (x402 PAYMENT-REQUIRED or MPP WWW-Authenticate: Payment), pay and retry. Find the right tool with GET /api/find?q=<task> and read prices at GET /api/pricing, both free; many tools also accept free proof-of-work (GET /api/pow).",
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
      securitySchemes: {
        x402: { type: "apiKey", in: "header", name: "PAYMENT-SIGNATURE", description: "x402 v2 payment payload (USDC, EIP-3009 authorization) - answer to the 402's PAYMENT-REQUIRED header." },
        mpp: { type: "http", scheme: "Payment", description: "MPP (Machine Payments Protocol) credential answering the 402's WWW-Authenticate: Payment challenge (evm/charge, tempo/charge, stripe/charge)." },
        creditsKey: { type: "http", scheme: "bearer", bearerFormat: "a402_<key>", description: "Prepaid card credits key from /credits - the list price is held before the call and debited only on a 200." },
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
      ...Object.entries(CATEGORIES).map(([k, v]) => ({ name: k, description: v.label })),
      { name: "workflows", description: "Curated multi-tool workflows (skill packs) - task-level templates that compose catalog tools." },
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
