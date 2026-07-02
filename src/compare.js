import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

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

  const extraCss = `
.cmp-wrap{max-width:960px;margin:0 auto;padding:56px 30px}
.cmp-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.cmp-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px}
.cmp-intro{max-width:760px;font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px}
.cmp-section{margin-bottom:48px}
.cmp-section h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 10px;color:var(--ink)}
.cmp-section p.cmp-desc{color:var(--muted);font-size:15px;line-height:1.55;margin:0 0 20px;max-width:760px}
.cmp-table{width:100%;border-collapse:collapse;background:var(--card);border:1.5px solid var(--ink);overflow:hidden;font-size:14px}
.cmp-table th,.cmp-table td{padding:14px 18px;text-align:left;border-bottom:1px solid var(--hairline)}
.cmp-table thead th{background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.cmp-table thead th:first-child{color:var(--dk-muted2);font-weight:500;text-transform:none;letter-spacing:normal}
.cmp-table tbody td{color:var(--muted)}
.cmp-table tbody td:first-child{color:var(--ink);font-weight:600}
.cmp-table tbody tr:last-child td{border-bottom:none}
.cmp-table .col-a402{color:var(--accent)}
.cmp-win{color:var(--accent);font-weight:500}
.cmp-lose{color:var(--faint)}
.check{color:var(--accent);font-size:1.1rem}
.cross{color:#D63C1A;font-size:1.1rem}
@media(max-width:640px){.cmp-table{font-size:13px}.cmp-table th,.cmp-table td{padding:10px 12px}.cmp-h1{font-size:36px !important}}
.cmp-cta{text-align:center;margin:40px 0 48px;padding:36px 24px;background:var(--card);border:1.5px solid var(--ink)}
.cmp-cta h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 12px;color:var(--ink)}
.cmp-cta p{color:var(--muted);font-size:15px;margin:0 0 20px;line-height:1.55}
.cmp-cta a.btn{display:inline-block;background:var(--accent);color:#fff;padding:12px 30px;font-family:var(--font-mono);font-weight:700;font-size:14px;text-decoration:none;border:1.5px solid var(--accent)}
.cmp-cta a.btn:hover{opacity:.9}
`;

  const body = `
<div class="cmp-wrap">
<div class="cmp-eyebrow">$ GET /compare</div>
<h1 class="cmp-h1">How Agent402 Compares</h1>
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

<div class="cmp-section">
<h2>agent402-tollbooth vs. platform monetization gateways</h2>
<p class="cmp-desc">The other side of the protocol: charging AI crawlers and agents for <em>your</em> content. Cloudflare's Monetization Gateway (announced July 2026, waitlist) brings x402 charging to sites behind Cloudflare &mdash; strong validation that pay-per-request is the business model of the agentic web. <a href="/tollbooth">agent402-tollbooth</a> is the open-source version of the same idea, shipping since before the announcement.</p>
<table class="cmp-table">
<thead><tr><th>Dimension</th><th class="col-a402">agent402-tollbooth</th><th>Platform gateways (e.g. Cloudflare)</th></tr></thead>
<tbody>
<tr><td>Availability</td><td class="cmp-win"><span class="check">&#10003;</span> Live today &mdash; <code>npm i agent402-tollbooth</code></td><td class="cmp-lose">Waitlist / beta</td></tr>
<tr><td>Where it runs</td><td class="cmp-win"><span class="check">&#10003;</span> Any origin &mdash; Express, Next.js, Docker, even a Cloudflare Worker</td><td class="cmp-lose">Only sites behind the platform's proxy</td></tr>
<tr><td>Open source</td><td class="cmp-win"><span class="check">&#10003;</span> MIT &mdash; read every line, fork it</td><td class="cmp-lose"><span class="cross">&#10007;</span> Proprietary edge service</td></tr>
<tr><td>Free tier for bots</td><td class="cmp-win"><span class="check">&#10003;</span> Proof-of-work &mdash; crawlers can pay with CPU instead of money</td><td class="cmp-lose"><span class="cross">&#10007;</span> Pay or blocked</td></tr>
<tr><td>Settlement</td><td class="cmp-win"><span class="check">&#10003;</span> x402 USDC on Base, Solana, Polygon, Arbitrum &mdash; direct to your wallet, 0% take</td><td class="cmp-lose">Stablecoins over x402; fee structure not yet public</td></tr>
<tr><td>Charge rules</td><td class="cmp-win"><span class="check">&#10003;</span> Your code &mdash; modes (bots/all/strict), adaptive PoW, per-path pricing</td><td class="cmp-lose">Platform rules API</td></tr>
<tr><td>Analytics</td><td class="cmp-win"><span class="check">&#10003;</span> Built-in dashboard + stats endpoint, self-hosted</td><td class="cmp-lose">Platform dashboard</td></tr>
</tbody>
</table>
</div>

<div class="cmp-cta">
<h2>Ready to get started?</h2>
<p>Connect your agent to 1,300+ tools in under five minutes. No API keys, no subscriptions, no lock-in.</p>
<a class="btn" href="/quickstart">Start building &rarr;</a>
</div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "/compare", jsonLd, extraCss, body });
}
