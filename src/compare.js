import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

export function comparePage(baseUrl) {
  const canonical = `${baseUrl}/compare`;
  const pageTitle = "Compare — Agent402 vs alternatives";
  const pageDesc = "See how Agent402 compares to building your own tool server, raw API calls, and hosted AI tool platforms. Open source, per-call pricing, no lock-in.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: pageTitle,
    description: pageDesc,
    url: canonical,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(pageDesc)}">
${CHROME_HEAD_LINKS}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
.cmp-intro{max-width:760px;color:var(--muted);line-height:1.7;margin:0 0 2.5rem}
.cmp-section{margin-bottom:3rem}
.cmp-section h2{font-size:1.3rem;color:var(--text);font-weight:600;margin:0 0 1rem}
.cmp-section p.cmp-desc{color:var(--muted);font-size:.93rem;line-height:1.65;margin:0 0 1.25rem;max-width:760px}
.cmp-table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;overflow:hidden;font-size:.93rem}
.cmp-table th,.cmp-table td{padding:.85rem 1.1rem;text-align:left;border-bottom:1px solid rgba(255,255,255,.04)}
.cmp-table thead th{background:rgba(255,255,255,.03);color:var(--text);font-weight:600;font-size:.88rem;text-transform:uppercase;letter-spacing:.03em}
.cmp-table thead th:first-child{color:var(--muted);font-weight:500;text-transform:none;letter-spacing:normal}
.cmp-table tbody td{color:var(--muted)}
.cmp-table tbody td:first-child{color:var(--text);font-weight:500}
.cmp-table tbody tr:last-child td{border-bottom:none}
.cmp-table .col-a402{color:var(--accent)}
.cmp-win{color:var(--accent);font-weight:500}
.cmp-lose{color:var(--muted)}
.check{color:var(--accent);font-size:1.1rem}
.cross{color:#f87171;font-size:1.1rem}
@media(max-width:640px){.cmp-table{font-size:.82rem}.cmp-table th,.cmp-table td{padding:.65rem .7rem}}
.cmp-cta{text-align:center;margin:2.5rem 0 3rem;padding:2rem 1.5rem;background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px}
.cmp-cta h2{font-size:1.3rem;color:var(--text);font-weight:600;margin:0 0 .75rem}
.cmp-cta p{color:var(--muted);font-size:.95rem;margin:0 0 1.25rem;line-height:1.6}
.cmp-cta a.btn{display:inline-block;background:var(--accent);color:#0b0e14;padding:.7rem 1.8rem;border-radius:8px;font-weight:600;text-decoration:none;font-size:.95rem}
.cmp-cta a.btn:hover{opacity:.9}
.breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.breadcrumb a{color:var(--accent);text-decoration:none}
.breadcrumb a:hover{text-decoration:underline}
</style>
</head>
<body>
${renderHeader("/compare")}
<main style="max-width:960px;margin:0 auto;padding:2rem 1.25rem">
<p class="breadcrumb"><a href="/">Home</a> &rsaquo; Compare</p>
<h1 style="font-size:1.8rem;margin:0 0 1rem;color:var(--text)">How Agent402 Compares</h1>
<p class="cmp-intro">Agent402 gives your AI agent 1,300+ deterministic tools behind a single protocol. Here is how it stacks up against the common alternatives.</p>

<div class="cmp-section">
<h2>Agent402 vs. building your own tool server</h2>
<p class="cmp-desc">Standing up a custom tool server means writing handlers, managing uptime, handling payments, and keeping up with upstream API changes. Agent402 ships all of that out of the box.</p>
<table class="cmp-table">
<thead><tr><th>Dimension</th><th class="col-a402">Agent402</th><th>Build your own</th></tr></thead>
<tbody>
<tr><td>Setup time</td><td class="cmp-win"><span class="check">&#10003;</span> One npm install or HTTP call</td><td class="cmp-lose">Weeks of engineering</td></tr>
<tr><td>Maintenance</td><td class="cmp-win"><span class="check">&#10003;</span> Managed and monitored 24/7</td><td class="cmp-lose">You own every outage</td></tr>
<tr><td>Tool count</td><td class="cmp-win"><span class="check">&#10003;</span> 1,300+ tools and growing</td><td class="cmp-lose">Only what you build</td></tr>
<tr><td>Payment handling</td><td class="cmp-win"><span class="check">&#10003;</span> x402 protocol, built in</td><td class="cmp-lose">Build from scratch</td></tr>
<tr><td>MCP support</td><td class="cmp-win"><span class="check">&#10003;</span> Native MCP endpoint</td><td class="cmp-lose">Implement yourself</td></tr>
<tr><td>Cost</td><td class="cmp-win"><span class="check">&#10003;</span> Pay per call, free tier via PoW</td><td class="cmp-lose">Server + engineer time</td></tr>
</tbody>
</table>
</div>

<div class="cmp-section">
<h2>Agent402 vs. raw API calls</h2>
<p class="cmp-desc">Wiring an agent directly to upstream APIs means juggling API keys, reading per-provider docs, and building error handling for each service individually.</p>
<table class="cmp-table">
<thead><tr><th>Dimension</th><th class="col-a402">Agent402</th><th>Raw API calls</th></tr></thead>
<tbody>
<tr><td>Authentication</td><td class="cmp-win"><span class="check">&#10003;</span> x402 protocol &mdash; one wallet, all tools</td><td class="cmp-lose">Separate API key per service</td></tr>
<tr><td>Discovery</td><td class="cmp-win"><span class="check">&#10003;</span> Searchable catalog + /api/find</td><td class="cmp-lose">Read each provider's docs</td></tr>
<tr><td>Error handling</td><td class="cmp-win"><span class="check">&#10003;</span> Standardized JSON errors</td><td class="cmp-lose">Different format per API</td></tr>
<tr><td>Payment</td><td class="cmp-win"><span class="check">&#10003;</span> Per-call, pay only for what you use</td><td class="cmp-lose">Monthly subscriptions per provider</td></tr>
<tr><td>Retries</td><td class="cmp-win"><span class="check">&#10003;</span> Idempotency built in</td><td class="cmp-lose">Build retry logic yourself</td></tr>
</tbody>
</table>
</div>

<div class="cmp-section">
<h2>Agent402 vs. hosted AI tool platforms</h2>
<p class="cmp-desc">Hosted platforms can get you started fast, but they typically lock you in with proprietary APIs, monthly fees, and opaque LLM-dependent tool logic.</p>
<table class="cmp-table">
<thead><tr><th>Dimension</th><th class="col-a402">Agent402</th><th>Hosted platforms</th></tr></thead>
<tbody>
<tr><td>Open source</td><td class="cmp-win"><span class="check">&#10003;</span> Fully open source</td><td class="cmp-lose"><span class="cross">&#10007;</span> Proprietary</td></tr>
<tr><td>Self-hostable</td><td class="cmp-win"><span class="check">&#10003;</span> Run your own instance</td><td class="cmp-lose"><span class="cross">&#10007;</span> Vendor-hosted only</td></tr>
<tr><td>Pricing</td><td class="cmp-win"><span class="check">&#10003;</span> Per-call, transparent</td><td class="cmp-lose">Monthly subscription</td></tr>
<tr><td>Lock-in</td><td class="cmp-win"><span class="check">&#10003;</span> None &mdash; standard protocols</td><td class="cmp-lose">Vendor lock-in</td></tr>
<tr><td>Deterministic</td><td class="cmp-win"><span class="check">&#10003;</span> Every tool is deterministic</td><td class="cmp-lose">LLM-dependent, non-reproducible</td></tr>
</tbody>
</table>
</div>

<div class="cmp-cta">
<h2>Ready to get started?</h2>
<p>Connect your agent to 1,300+ tools in under five minutes. No API keys, no subscriptions, no lock-in.</p>
<a class="btn" href="/quickstart">Start building &rarr;</a>
</div>
</main>
${renderFooter()}
</body>
</html>`;
}
