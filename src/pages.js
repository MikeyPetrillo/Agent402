// Server-rendered catalogue pages and the OpenAPI spec — all generated from
// the tool catalog so they never drift from what the API actually serves.
import { isComputePayable } from "./pow.js";
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";
import { SKILL_PACKS } from "./skills.js";

export const CATEGORIES = {
  web: { label: "Web & documents", blurb: "Read the live web: browser rendering, screenshots, article extraction, PDFs, metadata." },
  memory: { label: "Agent memory & coordination", blurb: "The stateful layer a stateless agent can't build for itself: durable wallet-keyed KV with TTL, atomic counters/locks, shared namespaces other agents can reach (grants), a tamper-evident audit log, and similarity recall. The payment is the identity — no signup." },
  network: { label: "Network & domains", blurb: "DNS, TLS certificates, WHOIS/RDAP, uptime checks, robots.txt and sitemaps." },
  data: { label: "Live public data", blurb: "Keyless real-time government and market data: dataset search across data.gov, NWS weather alerts, USGS earthquakes, currency rates, barcode product lookup." },
  payments: { label: "Payments & x402", blurb: "Non-custodial x402 tooling: decode HTTP 402 quotes, verify on-chain USDC settlements, read balances, tx status and gas on Base, and build EIP-3009 transfer authorizations. The agent signs with its own key — Agent402 never touches funds." },
  conversion: { label: "Data conversion", blurb: "JSON ⇄ CSV/YAML/XML, markdown ⇄ HTML, diffs and queries — formats agents juggle constantly." },
  text: { label: "Text processing", blurb: "Slugs, case conversion, diffs, regex, keywords, token estimates, edit distance, readability, PII redaction." },
  math: { label: "Math & finance", blurb: "Safe expression calculator, statistics, unit/percentage/number formatting, CIDR subnets, compound interest and loan math." },
  convert: { label: "Unit conversions", blurb: "One real endpoint per unit pair across length, mass, volume, area, speed, time, data, pressure, energy, power, angle, frequency, and temperature — e.g. GET /api/convert/miles-to-kilometers?value=5." },
  encoding: { label: "Encoding & crypto", blurb: "Hashes, HMAC signatures, base64/hex, JWT decoding, TOTP codes." },
  identifiers: { label: "Generators & IDs", blurb: "UUIDs, ULIDs, passwords, secure randomness, QR codes." },
  time: { label: "Time & scheduling", blurb: "Timezone-aware clocks, epoch conversion, cron parsing, durations." },
  validation: { label: "Validation & parsing", blurb: "Emails (with MX), URLs, IPs, user agents, colors, semver, IBAN, card numbers." },
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

// Unique, useful per-page content for the generated conversion tools — a
// reference table + the factor + the inverse link — so the ~970 pages are
// substantive rather than near-duplicate doorway pages.
function convertContent(baseUrl, tool) {
  let from, to, perUnit;
  try {
    const r = tool.handler({ value: 1 });
    from = r.from;
    to = r.to;
    perUnit = r.result;
  } catch {
    return "";
  }
  const rows = [1, 2, 5, 10, 25, 100, 1000]
    .map((v) => {
      let out;
      try {
        out = tool.handler({ value: v }).result;
      } catch {
        out = "";
      }
      return `<tr><td>${v} ${esc(from.replace(/-/g, " "))}</td><td>${esc(String(out))} ${esc(to.replace(/-/g, " "))}</td></tr>`;
    })
    .join("");
  const inverse = `convert-${to}-to-${from}`;
  const fromL = from.replace(/-/g, " ");
  const toL = to.replace(/-/g, " ");
  return `
  <p class="sub"><b>1 ${esc(fromL)} = ${esc(String(perUnit))} ${esc(toL)}.</b> To convert, multiply the number of ${esc(fromL)} by ${esc(String(perUnit))}. The reverse direction is <a href="/tools/${inverse}">${esc(toL)} → ${esc(fromL)}</a>.</p>
  <h2>Common ${esc(fromL)} to ${esc(toL)} values</h2>
  <table><tr><th>${esc(fromL)}</th><th>${esc(toL)}</th></tr>${rows}</table>`;
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
  const title = `${tool.name} API for AI agents — ${tool.price} per call | Agent402`;
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
      provider: { "@type": "Organization", name: "Agent402", url: baseUrl },
      offers: {
        "@type": "Offer",
        price: tool.price.replace("$", ""),
        priceCurrency: "USD",
        description: `${tool.price} per call, paid in USDC on Base via the x402 protocol. No signup, no API key.${computePayable ? " Or free with proof-of-work (no wallet)." : ""}`,
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Agent402", item: baseUrl },
        { "@type": "ListItem", position: 2, name: "Tools", item: `${baseUrl}/tools` },
        { "@type": "ListItem", position: 3, name: catLabel, item: `${baseUrl}/tools#${tool.category}` },
        { "@type": "ListItem", position: 4, name: tool.name, item: canonical },
      ],
    },
  ];
  const schemaRows = Object.entries(tool.discovery?.inputSchema?.properties ?? {})
    .map(([k, v]) => {
      const required = (tool.discovery?.inputSchema?.required ?? []).includes(k);
      return `<tr><td><code>${esc(k)}</code>${required ? " <b>*</b>" : ""}</td><td>${esc(v.type ?? "any")}</td><td>${esc(v.description ?? "")}</td></tr>`;
    })
    .join("\n");
  const relatedCards = related.map(card).join("\n");
  // Surface which curated multi-tool workflows include this tool. Helps an agent
  // landing on a single-tool page see the broader task it slots into (e.g.
  // spf-check → security-audit + email-deliverability), and exposes the MCP
  // prompt slug they can fetch to get the full Claude-ready workflow template.
  const inPacks = SKILL_PACKS.filter((p) => (p.toolSlugs || []).includes(tool.slug));
  const packsHtml = inPacks.length
    ? `<h2>Part of these workflows</h2>
  <p class="sub">This tool is one step in ${inPacks.length === 1 ? "a curated multi-tool workflow" : `${inPacks.length} curated multi-tool workflows`} — agents can fetch the whole sequence as an MCP prompt or call <code>${esc(baseUrl)}/api/skill-packs/{slug}/prompt</code>.</p>
  <ul>${inPacks.map((p) => `<li><a href="/skills/${esc(p.slug)}"><b>${esc(p.title)}</b></a> — ${esc(p.tagline)}</li>`).join("")}</ul>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description: `${tool.description} ${tool.price} per call via x402 — no API key, no signup.`, canonical, jsonLd, image: `${baseUrl}/card.png` })}
</head>
<body>
${renderHeader("/tools")}
<div class="wrap">
  <div class="crumb"><a href="/">Agent402</a> / <a href="/tools">tools</a> / ${esc(tool.slug)}</div>
  <h1>${esc(tool.name)}</h1>
  <div class="price-badge">${
    computePayable
      ? `<span class="free">FREE</span> with proof-of-work · or ${tool.price} in USDC`
      : `${tool.price} per call · USDC via x402`
  } · <code>${tool.method} ${esc(tool.path)}</code>${
    cacheTtl ? ` · <span title="Server caches identical responses for ${esc(fmtTtl(cacheTtl))}. Repeated calls return X-Cache: hit and don't re-hit the upstream.">Cached ${esc(fmtTtl(cacheTtl))}</span>` : ""
  }</div>
  <p class="sub">${esc(tool.description)}</p>
  ${tool.category === "convert" ? convertContent(baseUrl, tool) : ""}

  <h2>Input</h2>
  ${schemaRows ? `<table><tr><th>Field</th><th>Type</th><th>Description</th></tr>${schemaRows}</table>` : `<p class="sub">No parameters.</p>`}

  <h2>Example output</h2>
  <pre>${esc(JSON.stringify(tool.discovery?.output?.example ?? {}, null, 2))}</pre>

  <h2>Try it — see the 402 challenge (free)</h2>
  <pre>${esc(exampleCall(baseUrl, tool))}</pre>
  <p class="sub">The response is <code>HTTP 402 Payment Required</code> with exact payment requirements. Any x402 v2 client pays automatically and retries:</p>

  <h2>Paid call (JavaScript agent)</h2>
  <pre>import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

${esc(payExample(baseUrl, tool))}</pre>

  ${
    computePayable
      ? `<h2>No wallet? Pay with compute</h2>
  <p class="sub">This is a pure-CPU tool, so an agent without a wallet can pay with <a href="/api/pow">proof-of-work</a> instead of USDC: fetch a challenge, solve the sha256 puzzle (${powDifficulty} leading zero bits — a fraction of a second of CPU, no money, no AI tokens), and resend with the <code>X-Pow-Solution</code> header.</p>
  <pre>import { createHash } from "node:crypto";
const lz = (b) =&gt; { let t = 0; for (const x of b) { if (!x) { t += 8; continue; } t += Math.clz32(x) - 24; break; } return t; };
const c = await (await fetch("${baseUrl}/api/pow/challenge?slug=${esc(tool.slug)}")).json();
let n = 0;
while (lz(createHash("sha256").update(c.challenge + ":" + n).digest()) &lt; c.difficulty) n++;
await fetch("${baseUrl}${tool.path}", { method: "${tool.method}", headers: { "X-Pow-Solution": c.token + ":" + n${tool.method === "POST" ? ', "Content-Type": "application/json"' : ""} }${tool.method === "POST" ? `, body: JSON.stringify(${JSON.stringify(tool.discovery?.input ?? {})})` : ""} });</pre>`
      : `<p class="sub" style="margin-top:24px"><b>Wallet-only.</b> This tool reaches the network/browser/storage, so it is paid in USDC via x402 (no proof-of-work tier).</p>`
  }

  ${packsHtml}

  <h2>Related tools</h2>
  <div class="grid">${relatedCards}</div>
</div>
${renderFooter()}
</body>
</html>`;
}

export function toolsIndexPage(baseUrl, catalog) {
  const tools = toolList(catalog);
  const canonical = `${baseUrl}/tools`;
  const title = `${tools.length} pay-per-call APIs for AI agents | Agent402 tool catalogue`;
  const description = `${tools.length} machine-payable tools for AI agents: browser rendering, PDF extraction, wallet-keyed memory, conversions, validation, networking. USDC per call via x402 — no API keys.`;
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
      // Large generated families (e.g. ~970 conversions) render as a compact
      // sample + count, not hundreds of cards; each still has its own /tools page.
      if (inCat.length > 40) {
        const sample = inCat
          .slice(0, 24)
          .map((t) => `<a href="/tools/${t.slug}">${esc(t.name)}</a>`)
          .join(" · ");
        return `<h2>${esc(label)} <span style="color:var(--muted);font-size:.85rem">(${inCat.length})</span>${tag}</h2>
<p class="cat-blurb">${esc(blurb)}</p>
<p class="sub" style="font-size:.85rem">${sample} · <a href="/api/pricing">…and ${inCat.length - 24} more →</a></p>`;
      }
      const cards = inCat.map(card).join("\n");
      return `<h2>${esc(label)} <span style="color:var(--muted);font-size:.85rem">(${inCat.length})</span>${tag}</h2>
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
  <p class="sub">Call any endpoint, get an <code>HTTP 402</code> quote, and either pay a fraction of a cent in USDC on Base via <a href="https://x402.org" rel="noopener">x402</a> — or, on the <span class="free">FREE</span> tools, skip the wallet entirely. Machine-readable: <a href="/api/pricing">/api/pricing</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/llms.txt">/llms.txt</a>.</p>
  <div class="callout"><b>${freeCount} of ${tools.length} tools are free</b> — no wallet needed. Pay with a few seconds of <a href="/api/pow">proof-of-work</a> (CPU) instead of USDC. The other ${tools.length - freeCount} (browser, network, memory) settle in USDC because they cost real infrastructure to run. Look for the <span class="free">FREE</span> badge below.</div>
  ${sections}
</div>
${renderFooter()}
</body>
</html>`;
}

// On-site FAQ — surfaces the wiki FAQ for Google (FAQPage rich results) and for
// humans/agents landing on the site. The Q&A pairs are the single source for
// BOTH the visible HTML and the JSON-LD, so they can't drift apart. Answers may
// contain simple inline HTML (links) — allowed in FAQPage and rendered as-is.
const FAQ_ITEMS = [
  { q: "Do I need an account or API key?", a: "No. Nothing here has a signup. Payment — USDC or proof-of-work — is the only credential, charged per call." },
  { q: "What does it cost?", a: 'Flat per-call prices, $0.001–$0.02, published in <a href="/api/pricing">/api/pricing</a> and quoted exactly in every HTTP 402 response. No subscriptions or tiers.' },
  { q: "Can I use it without any money or a wallet?", a: "Yes. Most pure-CPU tools accept proof-of-work — a sub-second sha256 puzzle solved by your own CPU — and the hosted MCP connector runs that same set for free (rate-limited)." },
  { q: "What is x402?", a: "An open HTTP payment standard built on the 402 Payment Required status code, for machine-to-machine pay-per-call payments in stablecoins, with settlement infrastructure from Coinbase." },
  { q: "Which blockchain and asset does it use?", a: "USDC on Base mainnet (eip155:8453). The buyer needs only USDC — gas is sponsored by the facilitator." },
  { q: "Does using this spend my AI tokens?", a: "No. There is no LLM anywhere in the serving path — every tool is deterministic code. Proof-of-work spends your CPU; x402 spends USDC." },
  { q: "Is my data stored?", a: 'Tool inputs are processed in memory and not persisted — except the memory tools, whose purpose is storage (wallet-keyed, owner-deletable, with optional TTL). Full policy: <a href="/privacy">/privacy</a>.' },
  { q: "How do I know the service is honest?", a: "It is fully open source; CI re-tests every endpoint against its own documented example before each deploy; and revenue settles on-chain to agent402.base.eth (the named public receiving wallet), auditable by anyone on Basescan." },
  { q: "What happens if a tool fails after I pay?", a: "x402 settles before the handler runs, so the operating principle is that anything which can't be served reliably is removed from the catalog rather than left to charge-and-fail. Failure rates are watched by CI and a 15-minute production heartbeat." },
  { q: "Is Agent402 self-hostable and open source?", a: 'Yes — it is open source under the MIT license. Clone the repo and run it yourself for free, with or without payments enabled. It also ships agent402-tollbooth, an open-source pay-per-crawl gate for charging AI crawlers on your own site.' },
  { q: "Can I find tools on other x402 sellers from here?", a: 'Yes. Agent402 is also an x402 Index + Smart Order Router: <code>POST /api/route</code> ranks tools across every x402 seller we have crawled — the local catalog plus sellers auto-discovered from public registries like the Coinbase CDP Bazaar, refreshed hourly. It filters out unhealthy sellers and tiebreaks on health then price. Browse the live index at <a href="/index">/index</a> or fetch the JSON snapshot at <a href="/api/index">/api/index</a>. Both surfaces are free.' },
  { q: "How do I see which x402 sellers are most used?", a: '<code>GET <a href="/api/leaderboard">/api/leaderboard</a></code> returns the live on-chain ranking of every x402 seller by Base USDC settled volume — callsSettled, totalUsd, and uniqueBuyers per seller. The pipeline walks every page of the Coinbase CDP Bazaar discovery endpoint, queries <code>eth_getLogs</code> on Base USDC for each seller&rsquo;s payTo, filters per-call settlements within a $0.50 ceiling (larger inbound is funding/swaps, not buys), and aggregates. The snapshot refreshes hourly server-side. Free, like <code>/api/find</code> and <code>/api/route</code>. Use <code>?include=external</code> to exclude Agent402 itself and rank only the rest of the ecosystem.' },
  { q: "How does the Smart Order Router decide which seller to route to?", a: "It scores tools by lexical match against your query, then ranks by seller health (computed from the last five crawl outcomes), then by price. Sellers whose recent crawls errored are excluded entirely — a buyer routed to a dead seller wastes money. Brand-new sellers with no history yet are still routable: benefit of the doubt for newcomers." },
  { q: "Who runs Agent402?", a: 'Mikey Petrillo — a named, public maintainer reachable on <a href="https://github.com/MikeyPetrillo">GitHub</a>.' },
];

export function faqPage(baseUrl) {
  const canonical = `${baseUrl}/faq`;
  const title = "Agent402 FAQ — x402 + MCP server for AI agents";
  const description =
    "Frequently asked questions about Agent402: pricing, proof-of-work, x402 and USDC on Base, MCP, data handling, and self-hosting the open-source server.";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: it.a },
    })),
  };
  const items = FAQ_ITEMS.map(
    (it) => `<section class="faq-item"><h2>${esc(it.q)}</h2><p>${it.a}</p></section>`
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
${head({ title, description, canonical, jsonLd, image: `${baseUrl}/card.png` })}
</head>
<body>
${renderHeader("/faq")}
<div class="wrap">
  <div class="crumb"><a href="/">Agent402</a> / faq</div>
  <h1>Frequently asked questions</h1>
  <p class="sub">Agent402 is the open-source, self-hostable x402 + MCP server: pay-per-call web tools for AI agents, free via proof-of-work or paid in USDC on Base.</p>
  ${items}
</div>
${renderFooter()}
</body>
</html>`;
}

export function openapiSpec(baseUrl, catalog) {
  const paths = {};
  for (const tool of toolList(catalog)) {
    const { method, path, discovery } = tool;
    const op = {
      operationId: `${tool.slug}${method === "GET" ? "Get" : ""}`,
      summary: `${tool.name} (${tool.price}/call via x402)`,
      description: `${tool.description}\n\nPrice: ${tool.price} per call, paid in USDC on Base via the x402 protocol. Unpaid requests receive HTTP 402 with payment requirements; any x402 v2 client can pay and retry automatically. Docs: ${baseUrl}/tools/${tool.slug}`,
      tags: [tool.category],
      responses: {
        200: {
          description: "Success",
          content: {
            [tool.mimeType ?? "application/json"]:
              tool.mimeType && tool.mimeType !== "application/json"
                ? { schema: { type: "string", format: "binary" } }
                : { schema: { type: "object" }, example: discovery?.output?.example ?? {} },
          },
        },
        402: { description: "Payment Required — x402 payment requirements in the response body/headers" },
        400: { description: "Invalid input" },
      },
      "x-price": tool.price,
      "x-payment-protocol": "x402",
    };
    const props = discovery?.inputSchema?.properties ?? {};
    const required = discovery?.inputSchema?.required ?? [];
    if (method === "GET") {
      op.parameters = Object.entries(props).map(([name, schema]) => ({
        name,
        in: "query",
        required: required.includes(name),
        description: schema.description,
        schema: { type: schema.type === "number" ? "number" : "string" },
        ...(discovery?.input?.[name] !== undefined ? { example: discovery.input[name] } : {}),
      }));
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
      summary: "Get a templated workflow prompt for a single skill pack",
      description:
        "Returns the rendered MCP-style messages for the named skill pack with the given arguments substituted in. Same output as MCP prompts/get on the hosted connector — usable directly with any LLM. Per-pack argument names come from /api/skill-packs.json. Free.",
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
      title: "Agent402 — the open-source, self-hostable x402 server for AI agents",
      version: "2.0.0",
      description:
        "The open-source, self-hostable x402 server: hundreds of machine-payable web tools for AI agents in one place (browser, search, PDFs, images, live data, payment helpers) — the whole catalog is open and runnable yourself. Every endpoint is paid per call in USDC on Base via x402 (no signup, no API keys — the first request returns HTTP 402, an x402 client pays and retries) or free with proof-of-work. Free discovery: GET /api/pricing, GET /llms.txt. Multi-tool workflows: GET /api/skill-packs.json.",
      contact: { url: baseUrl },
    },
    servers: [{ url: baseUrl }],
    tags: [
      ...Object.entries(CATEGORIES).map(([k, v]) => ({ name: k, description: v.label })),
      { name: "workflows", description: "Curated multi-tool workflows (skill packs) — task-level templates that compose catalog tools." },
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
