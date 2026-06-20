// Skill packs — curated bundles of tools for a specific workflow. Each pack is
// a discovery surface (a server-rendered page at /skills/<slug>) and, in the
// follow-up PR, an MCP prompt that templates the workflow for an agent.
//
// The data shape is deliberately small: a slug, a human-readable title and
// tagline, a "when to use" sentence, the ordered list of tool slugs, a narrative
// workflow (what each tool contributes), and a copy-pastable Claude prompt.
// Both surfaces (HTML pages + MCP prompts) read from the same SKILL_PACKS
// array — single source of truth.
//
// The page renderer looks each toolSlug up in the live CATALOG so prices,
// descriptions, and routes stay accurate even as tools evolve. If a pack
// references a tool that's been removed, the page surfaces a "missing" placeholder
// rather than crashing — useful for catching dead references in the test suite.
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

export const SKILL_PACKS = [
  {
    slug: "security-audit",
    title: "Security audit",
    tagline:
      "Enumerate a domain's external attack surface in one workflow: certs, DNS posture, email auth, HTTP security headers, and tech stack.",
    useCase:
      "Before a pentest, an acquisition diligence call, or a quarterly review — you want a fast read on what an attacker sees from the outside.",
    promptArgs: [
      { name: "domain", description: "Target domain to audit (e.g. stripe.com)", required: true, substitute: "example.com" },
    ],
    toolSlugs: [
      "cert-transparency",
      "dns-lookup",
      "spf-check",
      "dmarc-check",
      "http-headers",
      "tls-cert",
      "tech-stack",
    ],
    workflow: [
      "Pull the certificate transparency log to enumerate every subdomain a CA has ever issued a cert for — this is the fastest external recon step.",
      "For each interesting subdomain, resolve A/AAAA/MX/NS/CAA records to map the live infrastructure and certificate authority constraints.",
      "Check SPF and DMARC on the apex to see whether the domain can be spoofed in email — a missing or weak DMARC is one of the highest-impact findings on most audits.",
      "Pull HTTP response headers on the apex and a few key subdomains; the security analyzer scores HSTS, CSP, XFO, XCTO, Referrer-Policy, Permissions-Policy, and the COOP/CORP/COEP triad.",
      "Inspect the live TLS cert (chain, expiry, SANs) — useful for spotting near-expiry, mismatched SANs, or weak chain configurations.",
      "Fingerprint the tech stack so you know what CMS/framework/CDN to research for known CVEs.",
    ],
    claudePrompt:
      'Run a security audit on example.com. Use Agent402 to: (1) pull the certificate transparency log, (2) check SPF and DMARC on the apex, (3) fetch HTTP security headers and the TLS cert, (4) fingerprint the tech stack. Report findings ranked by severity, and call out anything that would block a SOC 2 review.',
  },
  {
    slug: "email-deliverability",
    title: "Email deliverability",
    tagline:
      "Diagnose why a domain's email lands in spam: SPF posture, DMARC policy, DKIM key strength, MX targets, and a composite 0–100 score.",
    useCase:
      "Marketing or transactional email is landing in spam, or you're rolling out a new sending domain and want to verify the auth posture before the first campaign.",
    promptArgs: [
      { name: "domain", description: "Sending domain to diagnose (e.g. stripe.com)", required: true, substitute: "example.com" },
    ],
    toolSlugs: [
      "spf-check",
      "dmarc-check",
      "dkim-lookup",
      "email-deliverability",
      "email-validate",
      "dns-lookup",
    ],
    workflow: [
      "Parse the SPF record — the tool flags the most common failures (>10 DNS lookups, +all permissive directive, syntax errors).",
      "Parse the DMARC policy — p=none means receivers ignore SPF/DKIM failures, which usually explains a 'we set it all up but it still goes to spam' problem.",
      "Probe 14 common DKIM selectors and warn on <1024-bit keys and testing-mode (t=y) records. Most sending platforms publish under a predictable selector this catches.",
      "Run the composite deliverability score (25 points each for SPF + DMARC + DKIM + MX) for a single integer to report back to the team.",
      "Validate a single recipient address with email-validate to confirm the MX is actually reachable.",
      "Spot-check the MX records with dns-lookup type=MX to verify the chain matches the sending platform's documented setup.",
    ],
    claudePrompt:
      'Diagnose email deliverability for sender@example.com. Use Agent402 to check SPF, DMARC, DKIM (probe common selectors), and the composite email-deliverability score. If the score is below 75, explain which auth records are missing or weak and how to fix each one.',
  },
  {
    slug: "financial-research",
    title: "Financial research",
    tagline:
      "Pull SEC filings, real-time quotes, historical prices, and macro context for a single ticker in one pass.",
    useCase:
      "Building a one-pager on a public company — you want fundamentals, recent insider activity, and the macro backdrop without leaving the agent loop.",
    promptArgs: [
      { name: "ticker", description: "Stock ticker symbol (e.g. AAPL, MSFT, NVDA)", required: true, substitute: "AAPL" },
    ],
    toolSlugs: [
      "stock-quote",
      "stock-history",
      "edgar-filings",
      "edgar-company-facts",
      "edgar-insider-trades",
      "fred-series",
      "research-company",
    ],
    workflow: [
      "Get the live quote from stock-quote — current price, market cap, day range, volume.",
      "Pull 1Y of OHLCV from stock-history to compute return, vol, and drawdown for the brief.",
      "List recent SEC filings (10-K, 10-Q, 8-K) via edgar-filings — link each one in the report.",
      "Pull the structured XBRL company facts (revenue, net income, total assets, share count) from edgar-company-facts for the canonical numbers.",
      "Check edgar-insider-trades for Form 4 filings in the last 90 days — directional insider activity is a real signal.",
      "Drop in macro context (CPI, fed funds, unemployment) from fred-series so the brief contextualizes the company-level view.",
      "If you need a 1-call composite, research-company fans out to several of the above in a single paid call.",
    ],
    claudePrompt:
      "Build a one-page research brief on AAPL. Use Agent402 to pull: (1) current quote, (2) 1-year price history with return/vol/max-drawdown, (3) the last 4 SEC filings, (4) XBRL revenue and net income trend, (5) Form 4 insider trades in the last 90 days, (6) CPI and fed funds rate as macro context. Output a clean markdown brief.",
  },
  {
    slug: "macro-economics",
    title: "Macro economics",
    tagline:
      "Pull the canonical US macro dataset — yield curve, CPI, unemployment, fed funds, Sahm rule — without an API key.",
    useCase:
      "Producing a weekly macro note, charting the recession-indicator dashboard, or feeding a model with the latest FRED/Treasury data.",
    promptArgs: [],
    toolSlugs: [
      "treasury-yield-curve",
      "yield-curve-spread",
      "cpi-yoy",
      "unemployment-rate",
      "fed-funds",
      "sahm-rule",
      "fred-release-calendar",
    ],
    workflow: [
      "Pull the live Treasury yield curve (all maturities from 1M to 30Y) — the base data for every spread/inversion chart.",
      "Get the 10Y–2Y and 10Y–3M spreads from yield-curve-spread; the latter is the NY Fed's preferred recession indicator.",
      "Pull CPI YoY (cpi-yoy) for the headline and core inflation read.",
      "Pull the headline unemployment rate (unemployment-rate) — the U-3 series.",
      "Get the effective fed funds rate (fed-funds) for the current policy stance.",
      "Compute the Sahm rule (sahm-rule) — a real-time recession indicator that triggers when the 3-month unemployment average rises >0.5pp above its 12-month low.",
      "Pull the upcoming FRED release calendar (fred-release-calendar) so the brief can flag what's hitting this week.",
    ],
    claudePrompt:
      "Build today's macro dashboard. Use Agent402 to pull the Treasury yield curve, 10Y–2Y and 10Y–3M spreads, latest CPI YoY, unemployment rate, fed funds rate, and the Sahm rule reading. Highlight any indicator that is at a multi-year extreme, and list FRED releases scheduled for this week.",
  },
  {
    slug: "dns-network-ops",
    title: "DNS & network ops",
    tagline:
      "End-to-end DNS health check: records, multi-resolver propagation, WHOIS, ASN, robots.txt, and reachability.",
    useCase:
      "Investigating a DNS-related outage, debugging propagation after a record change, or onboarding a new domain and checking the operator chain.",
    promptArgs: [
      { name: "domain", description: "Domain to check (e.g. stripe.com)", required: true, substitute: "example.com" },
    ],
    toolSlugs: [
      "dns-lookup",
      "dns-propagation",
      "asn-info",
      "whois",
      "http-check",
      "robots-check",
    ],
    workflow: [
      "Resolve A/AAAA/MX/TXT/NS/CAA records on the apex with dns-lookup to baseline what the authoritative answer should be.",
      "Run dns-propagation across Cloudflare/Google/Quad9/OpenDNS in parallel — divergent answers mean a stale cache somewhere or a botched TTL during a migration.",
      "Look up the ASN and prefix that the apex resolves into with asn-info (Team Cymru DNS-based whois — no auth needed). Useful for spotting an unexpected hosting move.",
      "Pull whois for ownership, expiry, and registrar — catches the 'we forgot to renew' class of outage.",
      "Run http-check for status code, response time, and final URL after redirects — the fastest 'is it actually up' read.",
      "Spot-check robots.txt with robots-check to make sure a redeploy didn't accidentally Disallow: / the whole site.",
    ],
    claudePrompt:
      "Run a DNS health check on example.com. Use Agent402 to: pull the apex DNS records, check propagation across major public resolvers, look up the ASN/prefix, pull whois for ownership and expiry, run an HTTP reachability check, and confirm robots.txt isn't broken. Report any inconsistency or near-expiry.",
  },
  {
    slug: "content-extraction",
    title: "Content extraction",
    tagline:
      "Turn arbitrary URLs and PDFs into clean structured text — articles, page metadata, PDF pages, OCR'd images, browser-rendered SPAs.",
    useCase:
      "Building a RAG corpus, a daily newsletter from a list of source URLs, or extracting a table from a scanned PDF.",
    promptArgs: [
      { name: "urls", description: "Newline- or comma-separated list of URLs / PDF links to ingest", required: false, substitute: "these 10 URLs" },
    ],
    toolSlugs: [
      "extract",
      "meta",
      "pdf-to-markdown",
      "pdf-extract-pages",
      "render",
      "image-ocr",
    ],
    workflow: [
      "For an article URL, extract returns clean markdown (Readability-style) plus title, byline, word count.",
      "For OpenGraph card data (title, description, image, canonical), meta is faster than extract.",
      "For a PDF that lives at a URL, pdf-to-markdown converts the whole document; pdf-extract-pages pulls a specific page range.",
      "For a SPA or paywalled page that needs JavaScript execution, render returns the post-JS HTML — extract usually works directly against the rendered URL.",
      "For an image URL (scanned receipt, screenshot of a table), image-ocr returns the text.",
      "Pipeline: render → extract → embed for a robust ingest path that handles client-rendered sites without breaking.",
    ],
    claudePrompt:
      "Ingest these 10 URLs into clean markdown using Agent402. For each: try extract first; if it returns no body, fall back to render→extract; for any PDF URL, use pdf-to-markdown. Return one markdown blob per URL with the source URL as the H1.",
  },
];

// HTML escape — copied from guides.js/pages.js to keep skills self-contained.
const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Build a quick { slug → toolDef } map from the CATALOG. CATALOG is keyed by
// "METHOD /path", so we have to scan the values.
function indexCatalog(catalog) {
  const ix = new Map();
  for (const def of Object.values(catalog || {})) {
    if (def?.slug) ix.set(def.slug, def);
  }
  return ix;
}

const SKILLS_CSS = `
.skill-grid { display:grid; gap:14px; margin-top:24px; }
.skill-card { display:block; padding:18px 20px; border:1px solid #1e2638; border-radius:12px; background:#0f1420; color:inherit; text-decoration:none; transition:border-color .15s; }
.skill-card:hover { border-color:#4ade80; }
.skill-card h3 { margin:0 0 6px; font-size:1.1rem; color:#e6e9f0; }
.skill-card p { margin:0; color:#8b93a7; font-size:.93rem; line-height:1.55; }
.skill-card .meta { display:block; margin-top:10px; color:#4ade80; font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; }
.tool-list { margin:18px 0 8px; padding:0; list-style:none; }
.tool-list li { padding:14px 16px; border:1px solid #1e2638; border-radius:10px; margin-bottom:10px; background:#0f1420; }
.tool-list .row { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.tool-list .name { font-weight:600; color:#e6e9f0; }
.tool-list .price { color:#4ade80; font-family:ui-monospace,Menlo,monospace; font-size:.85rem; }
.tool-list .route { color:#8b93a7; font-family:ui-monospace,Menlo,monospace; font-size:.8rem; }
.tool-list .desc { display:block; margin-top:6px; color:#8b93a7; font-size:.9rem; line-height:1.55; }
.tool-list .missing { color:#f87171; font-style:italic; }
.workflow { counter-reset: step; margin:18px 0; padding:0; list-style:none; }
.workflow li { position:relative; padding:14px 16px 14px 56px; border-left:2px solid #1e2638; margin-bottom:8px; color:#c5cad8; font-size:.95rem; line-height:1.6; counter-increment: step; }
.workflow li::before { content: counter(step); position:absolute; left:14px; top:14px; width:26px; height:26px; border-radius:50%; background:#1e2638; color:#4ade80; font-family:ui-monospace,Menlo,monospace; font-weight:700; font-size:.85rem; display:flex; align-items:center; justify-content:center; }
.prompt-box { position:relative; margin:14px 0; }
.prompt-box pre { background:#0f1420; border:1px solid #1e2638; border-radius:10px; padding:14px 16px; overflow-x:auto; font-size:.85rem; line-height:1.55; white-space:pre-wrap; color:#e6e9f0; }
`;

function shell(baseUrl, title, description, path, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Agent402</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${baseUrl}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${baseUrl}/card.png">
<meta name="twitter:card" content="summary_large_image">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; }
  body { background:var(--bg); color:var(--fg); font:17px/1.7 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:820px; margin:0 auto; padding:48px 20px 24px; }
  h1 { font-size:1.9rem; line-height:1.25; margin:0 0 8px; }
  h2 { font-size:1.25rem; margin-top:36px; color:var(--accent); }
  a { color:var(--accent); } .muted { color:var(--muted); }
  pre { background:#0f1420; border:1px solid #1e2638; border-radius:10px; padding:14px 16px; overflow-x:auto; font-size:.85rem; line-height:1.55; }
  code { font-family:ui-monospace,Menlo,monospace; }
  p > code, li > code { background:#0f1420; padding:1px 6px; border-radius:6px; font-size:.85em; }
  ${CHROME_CSS}
  ${SKILLS_CSS}
</style>
</head>
<body>${renderHeader(path)}<div class="wrap">${body}</div>${renderFooter()}</body></html>`;
}

export function skillsIndex(baseUrl) {
  const cards = SKILL_PACKS.map(
    (p) => `<a class="skill-card" href="/skills/${p.slug}">
  <h3>${esc(p.title)}</h3>
  <p>${esc(p.tagline)}</p>
  <span class="meta">${p.toolSlugs.length} tools</span>
</a>`
  ).join("\n");
  const body = `<h1>Skill packs</h1>
<p class="muted">Curated, multi-tool workflows for specific jobs — pay per call (USDC on Base) or run free with proof-of-work. Each pack is one paste of context for your agent.</p>
<div class="skill-grid">${cards}</div>
<h2 style="margin-top:48px">Install once, use any pack</h2>
<pre>claude mcp add agent402 -s user -- npx -y agent402-mcp@latest</pre>
<p class="muted">Then ask Claude to run the pack's example prompt — it discovers the tools automatically via the hosted MCP connector.</p>`;
  return shell(
    baseUrl,
    "Skill packs: curated multi-tool workflows for AI agents",
    "Pre-built workflows — security audit, email deliverability, financial research, macro economics, DNS health, content extraction. Pay per call in USDC or run free with proof-of-work.",
    "/skills",
    body
  );
}

function renderToolList(pack, ix) {
  return pack.toolSlugs
    .map((slug) => {
      const t = ix.get(slug);
      if (!t) {
        return `<li><span class="row"><span class="name">${esc(slug)}</span> <span class="missing">— tool not currently in catalog</span></span></li>`;
      }
      return `<li>
  <span class="row">
    <span class="name"><a href="/tools/${esc(slug)}">${esc(t.name)}</a></span>
    <span class="price">${esc(t.price)}</span>
    <span class="route">${esc(t.route)}</span>
  </span>
  <span class="desc">${esc(t.description)}</span>
</li>`;
    })
    .join("\n");
}

export function skillPackPage(baseUrl, slug, catalog) {
  const pack = SKILL_PACKS.find((p) => p.slug === slug);
  if (!pack) return null;
  const ix = indexCatalog(catalog);
  const tools = renderToolList(pack, ix);
  const steps = pack.workflow.map((s) => `<li>${esc(s)}</li>`).join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: pack.title,
    description: pack.tagline,
    url: `${baseUrl}/skills/${pack.slug}`,
    step: pack.workflow.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      text: s,
    })),
  };

  const body = `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<h1>${esc(pack.title)}</h1>
<p class="muted">${esc(pack.tagline)}</p>

<h2>When to use this pack</h2>
<p>${esc(pack.useCase)}</p>

<h2>Tools in this pack</h2>
<ul class="tool-list">${tools}</ul>

<h2>Workflow</h2>
<ol class="workflow">${steps}</ol>

<h2>Run it in Claude</h2>
<pre>claude mcp add agent402 -s user -- npx -y agent402-mcp@latest</pre>
<p class="muted">Then paste this prompt into Claude:</p>
<div class="prompt-box"><pre>${esc(pack.claudePrompt)}</pre></div>

<p class="muted" style="margin-top:36px"><a href="/skills">← All skill packs</a></p>`;
  return shell(
    baseUrl,
    `${pack.title} — Agent402 skill pack`,
    pack.tagline,
    `/skills/${pack.slug}`,
    body
  );
}

export const skillSlugs = () => SKILL_PACKS.map((p) => p.slug);

// Machine-readable shape served at /api/skill-packs.json — also what the
// stdio agent402-mcp npm package fetches at startup to register its prompts.
// We strip internal-only fields like `substitute` (a render hint) and expose
// the public schema that any MCP client or discovery aggregator needs.
export function skillPacksJson() {
  return {
    packs: SKILL_PACKS.map((p) => ({
      slug: p.slug,
      title: p.title,
      tagline: p.tagline,
      useCase: p.useCase,
      toolSlugs: p.toolSlugs,
      workflow: p.workflow,
      claudePrompt: p.claudePrompt,
      promptArgs: (p.promptArgs || []).map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required ?? true,
      })),
    })),
  };
}

// Build an MCP prompt response for a skill pack — `messages` array + a top-level
// `description`. Two design choices baked in here, both Option-A from the
// trade-off matrix:
//   1. We name the exact tool slug at each step so the agent doesn't have to
//      search the catalog first (deterministic; fewer round-trips).
//   2. We pre-split the tool list into "free here" vs "wallet required" so the
//      agent can short-circuit before getting a 402 — `freeSlugs` is computed
//      per-session in mcp-http.js's buildServer().
// `args` is the MCP-prompt arguments object the client passes (e.g.
// `{ domain: "stripe.com" }`). For each entry in `pack.promptArgs` that
// declares a `substitute` string, we replace literal occurrences of that
// string in the prompt body — keeps the existing example-driven claudePrompt
// reusable as a template without introducing curly-brace placeholders that
// would leak into the HTML render.
export function buildPromptMessages(pack, args = {}, { freeSlugs } = {}) {
  let body = pack.claudePrompt;
  let useCase = pack.useCase;
  for (const a of pack.promptArgs || []) {
    const v = args && args[a.name];
    if (v && a.substitute) {
      body = body.split(a.substitute).join(String(v));
      useCase = useCase.split(a.substitute).join(String(v));
    }
  }

  const freeSet = freeSlugs instanceof Set ? freeSlugs : null;
  const free = [];
  const wallet = [];
  for (const slug of pack.toolSlugs) {
    if (!freeSet) continue;
    (freeSet.has(slug) ? free : wallet).push(slug);
  }

  // Per-step plan: if the workflow narrative and toolSlugs are 1:1, zip them
  // so the agent sees "step N → call this slug". Otherwise (e.g. security-audit
  // has one extra tool covered by a multi-tool step) list them in parallel
  // sections so we don't misalign instructions and tools.
  let plan;
  if (pack.toolSlugs.length === pack.workflow.length) {
    plan = pack.workflow
      .map((w, i) => `${i + 1}. call_tool { slug: "${pack.toolSlugs[i]}" } — ${w}`)
      .join("\n");
  } else {
    plan = [
      "Tools (in order):",
      ...pack.toolSlugs.map((s, i) => `  ${i + 1}. ${s}`),
      "",
      "Workflow:",
      ...pack.workflow.map((w, i) => `  ${i + 1}. ${w}`),
    ].join("\n");
  }

  const accessLines = [];
  if (free.length)
    accessLines.push(`Free on this hosted connector (compute-only, rate-limited): ${free.join(", ")}`);
  if (wallet.length)
    accessLines.push(
      `Wallet required (USDC via x402): ${wallet.join(", ")}. ` +
        `For paid access, use the agent402-mcp npm server with AGENT_KEY set, or call over HTTP with any x402 client.`
    );

  const text = [
    body,
    "",
    "---",
    "",
    `Context — ${pack.title}: ${useCase}`,
    "",
    "Tool plan (call each via the `call_tool` tool on this connector):",
    "",
    plan,
    ...(accessLines.length ? ["", "Access:", ...accessLines] : []),
  ].join("\n");

  return {
    description: `${pack.title}: ${pack.tagline}`,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

// Lexical ranker for skill packs, mirroring the one in find.js so /api/find and
// the MCP search_tools surface can recommend a *workflow* when the agent's query
// matches a multi-tool task (e.g. "audit a domain" → security-audit) instead of
// just returning the best individual tool. Scoring stays modest so packs only
// rank alongside tools when the lexical signal is strong:
//   slug exact match           = 12  (a pack is a richer answer than a single tool)
//   slug substring             =  5
//   title substring            =  3
//   tagline substring          =  2
//   useCase substring          =  1
//   tool slug in pack.toolSlugs =  4 ("check spf" → email-deliverability via spf-check)
//   workflow narrative hit     =  1
const PACK_STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "to", "for", "with", "by", "and", "or",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "as", "at",
  "from", "into", "onto", "my", "me", "i", "you", "your", "we", "our",
  "do", "does", "did", "can", "will", "would", "should",
]);

export function rankSkillPacks(query, { k = 2, baseUrl = "", minScore = 4 } = {}) {
  const q = String(query || "").slice(0, 500);
  const rawTerms = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const terms = rawTerms.filter((t) => t.length > 1 && !PACK_STOPWORDS.has(t)).slice(0, 32);
  if (!terms.length) return [];

  const scored = [];
  for (const pack of SKILL_PACKS) {
    const slug = pack.slug.toLowerCase();
    const title = (pack.title || "").toLowerCase();
    const tagline = (pack.tagline || "").toLowerCase();
    const useCase = (pack.useCase || "").toLowerCase();
    const toolSet = new Set((pack.toolSlugs || []).map((s) => String(s).toLowerCase()));
    const workflowHay = (pack.workflow || []).join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (slug === term) score += 12;
      else if (slug.includes(term)) score += 5;
      if (title.includes(term)) score += 3;
      if (tagline.includes(term)) score += 2;
      if (useCase.includes(term)) score += 1;
      if (toolSet.has(term)) score += 4;
      if (workflowHay.includes(term)) score += 1;
    }
    if (score >= minScore) scored.push([score, pack]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].slug.length - b[1].slug.length || a[1].slug.localeCompare(b[1].slug));

  return scored.slice(0, Math.min(Math.max(k, 1), SKILL_PACKS.length)).map(([score, p]) => ({
    slug: p.slug,
    title: p.title,
    tagline: p.tagline,
    toolSlugs: p.toolSlugs,
    score,
    url: baseUrl ? `${baseUrl}/skills/${p.slug}` : `/skills/${p.slug}`,
    promptName: p.slug, // matches the MCP prompts/list name; agents can prompts/get this directly
  }));
}
