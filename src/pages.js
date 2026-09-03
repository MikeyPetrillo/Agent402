// Server-rendered catalogue pages and the OpenAPI spec — all generated from
// the tool catalog so they never drift from what the API actually serves.
import { isComputePayable } from "./pow.js";
import { responseSchemaFor } from "./openapi-schema.js";
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";
import { ledgerShell, ledgerFooterCompact, esc as ledgerEsc } from "./ledger-chrome.js";
import { SKILL_PACKS } from "./skills.js";
import { RAILS_AMP, RAILS_OR, RAILS_PAREN, RAILS_SHORT } from "./rails.js";
import { tempoDiscoveryInfo } from "./mpp-tempo.js";
import { stripeDiscoveryInfo } from "./mpp-stripe.js";

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
  chain: { label: "Contract & address inspection", blurb: "Deeper onchain reads: verified contract source and ABI, address profiles, token holders, transaction inspection - plus the named block and log primitives (block number, block info, event logs, ERC-721 owner, contract code)." },
  wallet: { label: "Wallet operations", blurb: "Multi-chain balance reads, testnet funding, onramp links, and SQL over onchain data. Non-custodial: the agent signs with its own key." },
  ai: { label: "AI & compute", blurb: "Inference, generation and sandboxed execution priced per call: chat tiers, image generation, text-to-speech, speech-to-text, and code execution in an isolated sandbox." },
  "skill-pack": { label: "Skill packs", blurb: "Multi-tool workflows that run server-side in one request: one payment, one settlement, and a single response with a partial-success envelope if a step fails. Cheaper to integrate than orchestrating the steps yourself." },
  "date-time": { label: "Calendar & date math", blurb: "ISO weeks, leap years, day-of-year, epoch conversion, and movable-feast dates - the calendar edge cases that are easy to get subtly wrong." },
  research: { label: "Market & demand research", blurb: "Analyzed reads over this catalog's own demand and the open x402 ecosystem: what agents ask for, what sells, and company research." },
  agent: { label: "Routing & delegation", blurb: "The Smart Order Router: describe a task and it resolves the best-matching tool and runs it in one call, from this catalog or from an external x402 seller paid on your behalf. Three tiers by underlying price." },
  api: { label: "API primitives", blurb: "Building blocks for services that front an agent: CAPTCHA generation and verification." },
  x402: { label: "x402 seller intelligence", blurb: "Evidence about other x402 sellers: crawl health, advertised chains, and observed on-chain settlement counts - the same gate the router applies before it spends on an external seller." },
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

function head({ title, description, canonical, jsonLd, image }) {
  const blocks = (Array.isArray(jsonLd) ? jsonLd : [jsonLd])
    .filter(Boolean)
    .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
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
<meta property="og:site_name" content="Agent402.Tools">
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
  if (method === "GET") {
    const qs = new URLSearchParams(
      Object.entries(discovery?.input ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
    ).toString();
    return `const res = await payFetch("${baseUrl}${path}${qs ? `?${qs}` : ""}");`;
  }
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

export function toolPage(baseUrl, tool, related, { computePayable = false, powDifficulty = 0, cacheTtl = null } = {}) {
  const e = ledgerEsc;
  const title = `${tool.name} API for AI agents - ${tool.price} per call | Agent402`;
  const canonical = `${baseUrl}/tools/${tool.slug}`;
  const catLabel = CATEGORIES[tool.category]?.label ?? tool.category;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebAPI",
      name: `Agent402 ${tool.name}`,
      url: canonical,
      description: tool.description,
      documentation: `${baseUrl}/llms.txt`,
      provider: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
      offers: {
        "@type": "Offer",
        price: tool.price.replace("$", ""),
        priceCurrency: "USD",
        description: `${tool.price} per call, paid in ${RAILS_OR} via the x402 protocol. No signup, no API key.${computePayable ? " Or free with proof-of-work (no wallet)." : ""}`,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Agent402.Tools", item: baseUrl },
        { "@type": "ListItem", position: 2, name: "Tools", item: `${baseUrl}/tools` },
        { "@type": "ListItem", position: 3, name: catLabel, item: `${baseUrl}/tools#${tool.category}` },
        { "@type": "ListItem", position: 4, name: tool.name, item: canonical },
      ],
    },
  ];
  const schemaRows = Object.entries(tool.discovery?.inputSchema?.properties ?? {})
    .map(([k, v]) => {
      const required = (tool.discovery?.inputSchema?.required ?? []).includes(k);
      return `<tr><td><code>${e(k)}</code>${required ? " <b>*</b>" : ""}</td><td>${e(v.type ?? "any")}</td><td>${e(v.description ?? "")}</td></tr>`;
    })
    .join("\n");

  const relatedCards = related.map((t) => {
    const desc = t.description.length > 120 ? t.description.slice(0, 120) + "\u2026" : t.description;
    return `<div style="background:var(--card);border:1px solid var(--hairline);padding:18px 20px;display:flex;flex-direction:column;gap:8px;">
  <h3 style="font-size:15px;margin:0;"><a href="/tools/${e(t.slug)}" style="text-decoration:none;color:var(--ink);">${e(t.name)}</a></h3>
  <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${ledgerPriceLine(t)} · <code style="background:transparent;color:var(--faint);font-size:12px;">${t.method} ${e(t.path)}</code></div>
  <p style="color:var(--muted);font-size:13px;margin:0;line-height:1.5;flex:1;">${e(desc)}</p>
  <a href="/playground?slug=${e(t.slug)}" style="font-family:var(--font-mono);font-size:12px;color:var(--accent);text-decoration:none;font-weight:700;">try in playground →</a>
</div>`;
  }).join("\n");

  // Surface which curated multi-tool workflows include this tool.
  const inPacks = SKILL_PACKS.filter((p) => (p.toolSlugs || []).includes(tool.slug));
  const packsHtml = inPacks.length
    ? `<h2 style="font-weight:800;font-size:22px;margin:40px 0 10px;">Part of these workflows</h2>
  <p style="color:var(--muted);font-size:15px;margin-bottom:12px;">This tool is one step in ${inPacks.length === 1 ? "a curated multi-tool workflow" : `${inPacks.length} curated multi-tool workflows`} - agents can fetch the whole sequence as an MCP prompt or call <code style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);padding:2px 6px;font-size:13px;">${e(baseUrl)}/api/skill-packs/{slug}/prompt</code>.</p>
  <ul style="padding-left:20px;">${inPacks.map((p) => `<li style="margin-bottom:6px;"><a href="/skills/${e(p.slug)}" style="color:var(--accent);font-weight:700;">${e(p.title)}</a> - <span style="color:var(--muted);">${e(p.tagline)}</span></li>`).join("")}</ul>`
    : "";

  const methodColor = tool.method === "GET" ? "var(--green)" : "var(--accent)";

  const TOOL_PAGE_CSS = `
  .tp-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  .tp-crumb { font-family:var(--font-mono); font-size:13px; color:var(--faint); margin-bottom:18px; }
  .tp-crumb a { color:var(--accent); text-decoration:none; }
  /* Tool names range from 3 chars ("hex") to 50+ ("EDGAR XBRL company-concept
     (one tag, full history)") across 530 tools, and this H1's width shrinks
     continuously as the viewport narrows (single-column layout, no grid
     breakpoint to hook a "reserve the worst case" fix to like the per-chain
     marketplace pages use) - so unlike those pages, a fixed min-height would
     either waste a lot of space at in-between widths or still not cover the
     true worst case at the narrowest ones. Capping to a fixed 2-line box
     instead makes the height deterministic (max 2 lines) at EVERY viewport
     width regardless of name length - only the small number of genuinely
     long outlier names ever get visually truncated, and only at narrower
     widths where 2 lines isn't enough; the full name is preserved via the
     title attribute below and is always the actual page <title>. */
  .tp-h1 { font-family:var(--font-body); font-weight:800; font-size:38px; line-height:1; letter-spacing:-.02em; margin-bottom:10px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-overflow:ellipsis; }
  .tp-badge { display:inline-block; background:var(--surface); color:var(--on-dark); font-family:var(--font-mono); font-size:13px; padding:8px 16px; margin:8px 0 6px; }
  .tp-sub { color:var(--muted); font-size:16px; line-height:1.6; max-width:720px; }
  .tp-h2 { font-weight:800; font-size:22px; margin:40px 0 10px; letter-spacing:-.01em; }
  .tp-table { border-collapse:collapse; width:100%; font-size:14px; }
  .tp-table td, .tp-table th { border:1px solid var(--hairline); padding:10px 12px; text-align:left; vertical-align:top; }
  .tp-table th { background:var(--card); font-weight:700; }
  .tp-pre { background:var(--surface); color:var(--on-dark); font-family:var(--font-mono); font-size:13px; line-height:1.6; padding:18px 20px; overflow-x:auto; border:none; }
  .tp-grid { display:grid; gap:14px; margin:20px 0; }
  @media (min-width:640px){ .tp-grid { grid-template-columns:repeat(3,1fr); } }
  .tp-free { display:inline-block; background:var(--green); color:#08130b; font-weight:700; font-size:11px; letter-spacing:.02em; padding:2px 8px; font-family:var(--font-mono); vertical-align:middle; }
  .tp-callout { background:var(--card); border:1px solid var(--hairline); padding:16px 20px; margin:18px 0; font-size:15px; }
  .tp-callout b { color:var(--accent); }
  `;

  const body = `<div class="tp-wrap">
  <div class="tp-crumb"><a href="/">Agent402</a> / <a href="/tools">tools</a> / ${e(tool.slug)}</div>
  <h1 class="tp-h1" title="${e(tool.name)}">${e(tool.name)}</h1>
  <div class="tp-badge">${
    computePayable
      ? `<span class="tp-free">FREE</span> <span style="color:var(--dk-muted);">with proof-of-work</span> · <span style="color:var(--dk-muted2);">or ${tool.price} in USDC</span>`
      : `<span style="color:var(--on-dark);">${tool.price} per call</span> · <span style="color:var(--dk-muted);">USDC via x402</span>`
  } · <code style="color:${methodColor};background:transparent;font-size:13px;">${tool.method}</code> <code style="color:var(--dk-muted2);background:transparent;font-size:13px;">${e(tool.path)}</code>${
    cacheTtl ? ` · <span style="color:var(--dk-muted);" title="Server caches identical responses for ${e(fmtTtl(cacheTtl))}. Repeated calls return X-Cache: hit and don't re-hit the upstream.">Cached ${e(fmtTtl(cacheTtl))}</span>` : ""
  }</div>
  <p class="tp-sub">${e(tool.description)}</p>
  <p style="margin:16px 0 0;"><a class="ml-cta" href="/playground?slug=${e(tool.slug)}" style="display:inline-block;background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;font-size:13px;text-decoration:none;padding:11px 16px;">TRY IN PLAYGROUND →</a></p>

  <h2 class="tp-h2">Input</h2>
  ${schemaRows ? `<table class="tp-table"><tr><th>Field</th><th>Type</th><th>Description</th></tr>${schemaRows}</table>` : `<p class="tp-sub">No parameters.</p>`}

  <h2 class="tp-h2">Example output</h2>
  <pre class="tp-pre">${e(JSON.stringify(tool.discovery?.output?.example ?? {}, null, 2))}</pre>

  <h2 class="tp-h2">Try it - see the 402 challenge (free)</h2>
  <pre class="tp-pre">${e(exampleCall(baseUrl, tool))}</pre>
  <p class="tp-sub">The response is <code style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);padding:2px 6px;font-size:13px;">HTTP 402 Payment Required</code> with exact payment requirements. Any x402 v2 client pays automatically and retries:</p>

  <h2 class="tp-h2">Paid call (JavaScript agent)</h2>
  <pre class="tp-pre">import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

${e(payExample(baseUrl, tool))}</pre>

  ${
    computePayable
      ? `<h2 class="tp-h2">No wallet? Pay with compute</h2>
  <p class="tp-sub">This is a pure-CPU tool, so an agent without a wallet can pay with <a href="/api/pow" style="color:var(--accent);">proof-of-work</a> instead of USDC: fetch a challenge, solve the sha256 puzzle (${powDifficulty} leading zero bits - a fraction of a second of CPU, no money, no AI tokens), and resend with the <code style="background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);padding:2px 6px;font-size:13px;">X-Pow-Solution</code> header.</p>
  <pre class="tp-pre">import { createHash } from "node:crypto";
const lz = (b) =&gt; { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("${baseUrl}/api/pow/challenge?slug=${e(tool.slug)}")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) &lt; c.difficulty) n++;
await fetch("${baseUrl}${tool.path}", { method: "${tool.method}", headers: { "X-Pow-Solution": c.token + ":" + n${tool.method === "POST" ? ', "Content-Type": "application/json"' : ""} }${tool.method === "POST" ? `, body: JSON.stringify(${JSON.stringify(tool.discovery?.input ?? {})})` : ""} });</pre>`
      : `<div class="tp-callout" style="margin-top:24px"><b>Wallet-only.</b> This tool reaches the network/browser/storage, so it is paid in USDC via x402 (no proof-of-work tier).</div>`
  }

  ${packsHtml}

  <h2 class="tp-h2">Related tools</h2>
  <div class="tp-grid">${relatedCards}</div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description: `${tool.description} ${tool.price} per call via x402 - no API key, no signup.`,
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
    jsonLd,
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
  { q: "What does it cost?", a: 'Flat per-call prices from $0.001. Most tools are $0.001 to $0.02; premium AI and media tiers and multi-tool skill packs run higher, up to $1.50; finished report products are $0.60 to $2.00 per call for an agent per report ($1 to $2 by card at <a href="/reports">/reports</a>, where the price includes payment processing). Every price is published in <a href="/api/pricing">/api/pricing</a> and quoted exactly in every HTTP 402 response. No subscriptions. The metered model route (<code>/v1/metered</code>) quotes each request from its body before payment and settles what the call used, under that quote.' },
  { q: "Can I use it without any money or a wallet?", a: "Yes. Most pure-CPU tools accept proof-of-work - a sub-second sha256 puzzle solved by your own CPU - and the hosted MCP connector runs that same set for free (rate-limited)." },
  { q: "What is x402?", a: 'An open HTTP payment standard built on the 402 Payment Required status code, for machine-to-machine pay-per-call payments in stablecoins, with settlement infrastructure from Coinbase. Plain-English explainer: <a href="/what-is-x402">/what-is-x402</a>.' },
  { q: "What is MPP, and does Agent402 support it?", a: 'Yes - every paid endpoint is dual-stack, and now natively via Tempo too. MPP (Machine Payments Protocol, the IETF-track Payment HTTP authentication scheme) carries the pay-per-call handshake through the web&rsquo;s standard auth headers: the 402 carries a <code>WWW-Authenticate: Payment</code> challenge, the client pays via <code>Authorization: Payment</code>, and settled responses return a signed <code>Payment-Receipt</code>. Same URL, same price either way - MPP&rsquo;s evm method settles identically to x402 (same on-chain USDC settlement), while its tempo method settles natively via Tempo&rsquo;s own relay, a genuinely separate mechanism. How the two compare: <a href="/what-is-x402">/what-is-x402</a>; the full MPP explainer: <a href="/what-is-mpp">/what-is-mpp</a>.' },
  { q: "Which blockchain and asset does it use?", a: `${RAILS_PAREN}. The buyer needs only the stablecoin - gas is sponsored by the facilitator on EVM chains.` },
  { q: "Does using this spend my AI tokens?", a: "No LLM in the deterministic tool path - those are pure code (parsers, hashes, math, a real browser). Proof-of-work spends your CPU; x402 spends USDC. The optional /v1 gateway is a separate OpenAI-compatible LLM proxy you opt into - it's the only place a model runs." },
  { q: "Is there an OpenAI-compatible endpoint?", a: 'Yes - <code>/v1</code> is a pay-per-call OpenAI-wire LLM gateway: point any OpenAI SDK at <code>base_url https://agent402.tools/v1</code> for chat (five quality tiers, model-optional auto-routing), embeddings, and image generation. No API key, no signup - settle in USDC over x402, same as every other tool. See <a href="/pricing">/pricing</a> for the tier breakdown.' },
  { q: "Is my data stored?", a: 'Tool inputs are processed in memory and not persisted - except the memory tools, whose purpose is storage (wallet-keyed, owner-deletable, with optional TTL). Full policy: <a href="/privacy">/privacy</a>.' },
  { q: "How do I know the service is honest?", a: "It is fully open source; CI re-tests every endpoint against its own documented example before each deploy; and revenue settles on-chain to agent402.base.eth (the named public receiving wallet), auditable by anyone on Basescan." },
  { q: "What happens if a tool fails after I pay?", a: "You are not charged. Payment settles only for a successful (under-400) response, so an error cancels settlement and no money moves. On top of that guarantee, anything which can't be served reliably is removed from the catalog rather than left to fail, and failure rates are watched by CI and a 15-minute production heartbeat." },
  { q: "Is Agent402 self-hostable and open source?", a: 'Yes - the server is open source under the AGPL-3.0 license (the client SDK, MCP connector, and tollbooth are MIT). Clone the repo and run it yourself for free, with or without payments enabled. It also ships agent402-tollbooth, an open-source pay-per-crawl gate for charging AI crawlers on your own site.' },
  { q: "Can I find tools on other x402 sellers from here?", a: 'Yes. Agent402 is also an x402 Index + Smart Order Router: <code>POST /api/route</code> ranks tools across every x402 seller we have crawled - the local catalog plus sellers auto-discovered from public registries like the Coinbase CDP Bazaar, refreshed hourly. It filters out unhealthy sellers and tiebreaks on health then price. Browse the live marketplace at <a href="/marketplace">/marketplace</a> or fetch the JSON snapshot at <a href="/api/index">/api/index</a>. Both surfaces are free.' },
  { q: "How do I list my own API?", a: 'For free, three ways: your origin is auto-discovered from public x402 registries (Coinbase CDP Bazaar, GoPlausible) once it&rsquo;s live and settling; paste it on <a href="/sell">/sell</a> for an immediate probe; or call <code>POST /api/index/register</code> directly. A listed seller is routable by the Smart Order Router and ranked on <a href="/leaderboard">/leaderboard</a> by real on-chain USDC volume - 0% take, settlement lands straight in your wallet.' },
  { q: "How do I see which x402 sellers are most used?", a: '<code>GET <a href="/api/leaderboard">/api/leaderboard</a></code> returns the live on-chain ranking of every x402 seller by Base USDC settled volume - callsSettled, totalUsd, and uniqueBuyers per seller. The pipeline walks every page of the Coinbase CDP Bazaar discovery endpoint, queries <code>eth_getLogs</code> on Base USDC for each seller&rsquo;s payTo, filters per-call settlements within a $0.50 ceiling (larger inbound is funding/swaps, not buys), and aggregates. The snapshot refreshes hourly server-side. Free, like <code>/api/find</code> and <code>/api/route</code>. Use <code>?include=external</code> to exclude Agent402 itself and rank only the rest of the ecosystem.' },
  { q: "How does the Smart Order Router decide which seller to route to?", a: "It scores tools by lexical match against your query, then ranks by seller health (computed from the last five crawl outcomes), then by price. Sellers whose recent crawls errored are excluded entirely - a buyer routed to a dead seller wastes money. Brand-new sellers with no history yet are still routable: benefit of the doubt for newcomers." },
  { q: "Who runs Agent402?", a: 'Havok Holdings LLC - a public, contactable maintainer reachable at <a href="mailto:mike@agent402.tools">mike@agent402.tools</a>, on <a href="https://github.com/MikeyPetrillo/Agent402">GitHub</a>, and on <a href="https://x.com/Agent402Tools">X</a>.' },
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

export function openapiSpec(baseUrl, catalog) {
  const paths = {};
  for (const tool of toolList(catalog)) {
    const { method, path, discovery } = tool;
    const op = {
      operationId: `${tool.slug}${method === "GET" ? "Get" : ""}`,
      summary: `${tool.name} (${tool.price}/call via x402)`,
      description: `${tool.description}\n\nPrice: ${tool.price} per call, paid in ${RAILS_OR} via the x402 protocol. Unpaid requests receive HTTP 402 with payment requirements; any x402 v2 client can pay and retry automatically. Docs: ${baseUrl}/tools/${tool.slug}`,
      tags: [tool.category],
      responses: {
        200: {
          description: "Success",
          content: {
            [tool.mimeType ?? "application/json"]:
              tool.mimeType && tool.mimeType !== "application/json"
                ? { schema: { type: "string", format: "binary" } }
                : { schema: responseSchemaFor(path, discovery?.output?.example), example: discovery?.output?.example ?? {} },
          },
        },
        402: { description: "Payment Required - x402 payment requirements in the response body/headers" },
        400: { description: "Invalid input" },
      },
      "x-price": tool.price,
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
        // Tempo is a SECOND, independent MPP method (native TIP-1034/TIP-20
        // via Tempo's own relay, not x402-settled) — advertised here only
        // when actually enabled, same "never advertise what we can't settle"
        // rule mintTempoChallenge() itself enforces.
        const tempo = tempoDiscoveryInfo();
        // Stripe cards-over-MPP (stripe/charge via SPT): a THIRD MPP method,
        // advertised ONLY when the gate is live AND the route clears the $0.50
        // SPT card minimum — same "never advertise what we can't settle" rule.
        // Dormant (no keys) -> null -> no stripe offer on any operation.
        const stripe = stripeDiscoveryInfo();
        const stripeOffered = stripe && priceUsd >= stripe.minUsd;
        return {
          // STRUCTURED protocol objects, not bare strings: @agentcash/discovery
          // (MPPScan's crawler, whose L3 output x402scan consumes) parses
          // structured x-payment-info with zod — an object `price` next to
          // string protocols fails the structured schema AND the legacy
          // fallback, losing both price and protocols. Each mpp entry
          // requires non-empty method/intent/currency.
          protocols: [
            { x402: {} },
            { mpp: { method: "evm", intent: "charge", currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } },
            ...(tempo ? [{ mpp: { method: "tempo", intent: "charge", currency: tempo.currency } }] : []),
            ...(stripeOffered ? [{ mpp: { method: "stripe", intent: "charge", currency: "usd" } }] : []),
          ],
          price: { mode: "fixed", currency: "USD", amount: String(tool.price ?? "").replace(/[^0-9.]/g, "") || "0" },
          offers: [
            {
              intent: "charge",
              method: "evm",
              amount: String(Math.round(priceUsd * 1e6)),
              currency: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              description: `${tool.price} in USDC on Base (eip155:8453) - MPP evm charge or x402 exact; more chains in the live 402`,
            },
            ...(tempo
              ? [{
                  intent: "charge",
                  method: "tempo",
                  amount: String(Math.round(priceUsd * 10 ** tempo.decimals)),
                  currency: tempo.currency,
                  description: `${tool.price} on Tempo (chain 4217) - MPP tempo/charge, settled via Tempo's own relay (not x402)`,
                }]
              : []),
            ...(stripeOffered
              ? [{
                  intent: "charge",
                  method: "stripe",
                  amount: String(Math.round(priceUsd * 100)),
                  currency: "usd",
                  description: `${tool.price} by card (Stripe Shared Payment Token) - MPP stripe/charge, settled to our Stripe balance; $0.50 card minimum`,
                }]
              : []),
          ],
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
        description: "Optional client-supplied key. Replaying the same key with the same payment/PoW credential and request body returns the original result instead of charging again.",
        schema: { type: "string" },
      },
      ...(isComputePayable(tool) ? [{
        name: "X-Pow-Solution",
        in: "header",
        required: false,
        description: `Free-tier alternative to x402 payment: "<token>:<nonce>" from a solved proof-of-work challenge (GET /api/pow/challenge). Omit when paying via x402.`,
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
          schema: { type: schema.type === "number" ? "number" : "string" },
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
      title: "Agent402.Tools - 500+ pay-per-call tools for AI agents over x402 + MPP",
      version: "2.1.0",
      description:
        // Template literal, not a plain string: this is the spec description
        // every crawler and directory reads, and as a quoted string it shipped
        // a literal ${RAILS_OR} to production.
        `The open-source, self-hostable applied layer of Agentic Finance - agents paying and getting paid over x402 and MPP: 500+ machine-payable web tools for AI agents in one place (browser, search, PDFs, images, live data, payment helpers) - the whole catalog is open and runnable yourself. Every endpoint is paid per call in ${RAILS_OR} over x402, or over MPP (Machine Payments Protocol: USDC on Base/Celo, or USDC.e (and PathUSD) natively on Tempo) - no signup, no API keys - the first request returns HTTP 402 carrying both offers, an x402 or mppx client pays and retries - or free with proof-of-work. Also the open x402 index, Smart Order Router and MPP marketplace. Free discovery: GET /api/pricing, GET /llms.txt. Multi-tool workflows: GET /api/skill-packs.json.`,
      // Email doubles as x402scan's ownership-verification signal; it is the
      // same public maintainer contact the /.well-known/x402 manifest names.
      contact: { name: "Havok Holdings LLC", email: "mike@agent402.tools", url: baseUrl },
      // Agent-facing quickstart read by MPP/x402 discovery crawlers
      // (info.x-guidance in MPPScan's audit).
      "x-guidance":
        "Every /api/* and /v1/* path is pay-per-call: request it unauthenticated, read the 402 (x402 PAYMENT-REQUIRED or MPP WWW-Authenticate: Payment), pay in USDC and retry - or send a prepaid card-credits key as Authorization: Bearer a402_<key> (buy at /credits; balance at GET /api/credits/balance). Find the right tool with GET /api/find?q=<task>; prices at GET /api/pricing; many tools also accept free proof-of-work (GET /api/pow).",
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
    "x-skill-packs": SKILL_PACKS.map((p) => ({
      slug: p.slug,
      title: p.title,
      toolCount: (p.toolSlugs || []).length,
      promptName: p.slug,
    })),
  };
}
