import { toolList, CATEGORIES } from "./pages.js";

export function landingPage(baseUrl, network, freeMode, catalog) {
  const tools = toolList(catalog);
  const count = tools.length;
  const categoryCards = Object.entries(CATEGORIES)
    .map(([key, { label, blurb }]) => {
      const inCat = tools.filter((t) => t.category === key);
      if (!inCat.length) return "";
      const cheapest = inCat.reduce((a, t) => Math.min(a, parseFloat(t.price.slice(1))), Infinity);
      return `<a class="card cat" href="/tools#${key}">
      <h3>${label} <span class="count">${inCat.length}</span></h3>
      <div class="price">from $${cheapest}</div>
      <p>${blurb}</p>
    </a>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent402 — ${count} pay-per-call tools for AI agents (x402, USDC on Base)</title>
<meta name="description" content="${count} machine-payable tools for AI agents: headless-browser rendering, screenshots, PDF extraction, wallet-keyed memory, data conversion, validation, networking. Fractions of a cent per call in USDC via the x402 protocol — no API keys, no signup.">
<link rel="canonical" href="${baseUrl}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/">
<meta property="og:site_name" content="Agent402">
<meta property="og:title" content="Agent402 — ${count} pay-per-call tools for AI agents">
<meta property="og:description" content="${count} machine-payable endpoints, one base URL, zero API keys. Browser rendering, PDF extraction, wallet-keyed memory, conversions, validation. USDC per call via x402.">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Agent402 — ${count} pay-per-call tools for AI agents">
<meta name="twitter:description" content="Machine-payable web tools. Agents pay fractions of a cent per call in USDC via x402 — no API keys, no signup.">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebAPI",
  "name": "Agent402",
  "url": "${baseUrl}",
  "description": "${count} pay-per-call tools for AI agents via the x402 payment protocol (USDC on Base): headless-browser rendering, screenshots, PDF text extraction, URL-to-markdown, wallet-keyed key-value memory, data conversion, text processing, validation, time, and network tools.",
  "documentation": "${baseUrl}/llms.txt",
  "termsOfService": "${baseUrl}/",
  "offers": { "@type": "Offer", "price": "0.001-0.02", "priceCurrency": "USD", "description": "Per-call micropayments in USDC via x402" }
}
</script>
<style>
  :root { --bg:#0b0e14; --card:#131826; --text:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:920px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:2.4rem; line-height:1.15; margin-bottom:12px; }
  h1 .x { color:var(--accent); }
  .sub { color:var(--muted); font-size:1.15rem; max-width:640px; }
  .badge { display:inline-block; background:#1b2336; color:var(--accent); border:1px solid #2a3550; border-radius:999px; padding:3px 12px; font-size:.8rem; margin-bottom:20px; font-family:var(--mono); }
  .cta { display:inline-block; margin:18px 12px 0 0; padding:10px 18px; border-radius:10px; font-weight:600; text-decoration:none; }
  .cta.primary { background:var(--accent); color:#08130b; }
  .cta.ghost { border:1px solid #2a3550; color:var(--text); }
  .grid { display:grid; gap:14px; margin:32px 0; }
  @media (min-width:640px){ .grid{ grid-template-columns:repeat(3,1fr);} }
  .card { background:var(--card); border:1px solid #1e2638; border-radius:12px; padding:18px; }
  a.card { text-decoration:none; display:block; }
  a.card:hover { border-color:#2a3550; }
  .card h3 { font-size:1rem; margin-bottom:4px; color:var(--text); }
  .card .count { color:var(--muted); font-family:var(--mono); font-size:.8rem; font-weight:400; }
  .card .price { color:var(--accent); font-family:var(--mono); font-size:.85rem; }
  .card p { color:var(--muted); font-size:.85rem; margin-top:8px; }
  h2 { margin:44px 0 12px; font-size:1.35rem; }
  pre { background:#0d1220; border:1px solid #1e2638; border-radius:10px; padding:16px; overflow-x:auto; font-family:var(--mono); font-size:.82rem; line-height:1.5; color:#c9d4ec; }
  code { font-family:var(--mono); font-size:.85em; color:#a5b4d4; }
  .step { display:flex; gap:14px; margin:14px 0; }
  .step b { color:var(--accent); font-family:var(--mono); flex-shrink:0; }
  .step span { color:var(--muted); }
  .why { display:grid; gap:14px; margin:20px 0; }
  @media (min-width:640px){ .why{ grid-template-columns:repeat(2,1fr);} }
  .why .card h3 { color:var(--accent); font-size:.95rem; }
  a { color:var(--accent); }
  footer { margin-top:56px; color:var(--muted); font-size:.85rem; border-top:1px solid #1e2638; padding-top:20px; }
  .warn { background:#3a2a12; border:1px solid #6b4a1a; color:#fbbf24; border-radius:10px; padding:12px 16px; margin:20px 0; font-size:.9rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="badge">x402 &middot; USDC on ${network} &middot; ${count} tools &middot; no signup, no API keys</div>
  <h1>The utility belt your agent<br>can't build for itself<span class="x">.</span></h1>
  <p class="sub">${count} pay-per-call tools behind one base URL. Your agent hits an endpoint, pays a fraction of a cent in USDC automatically, and gets the result. No accounts. No keys. No subscriptions. The wallet is the identity.</p>
  <a class="cta primary" href="/tools">Browse all ${count} tools →</a>
  <a class="cta ghost" href="/llms.txt">llms.txt</a>
  <a class="cta ghost" href="/openapi.json">OpenAPI</a>
  ${freeMode ? '<div class="warn">⚠ Demo mode — payments are currently disabled on this instance.</div>' : ""}

  <h2>Why not just build it yourself?</h2>
  <p class="sub">Your agent can write code. Here's what it can't do mid-task:</p>
  <div class="why">
    <div class="card">
      <h3>Run a browser farm</h3>
      <p>Most agent sandboxes have no Chromium, no GPU, no display. <code>/api/render</code> and <code>/api/screenshot</code> are real headless browser infrastructure — JavaScript executed, SPAs included — rented by the call for 2 cents.</p>
    </div>
    <div class="card">
      <h3>Remember anything tomorrow</h3>
      <p>Agent sessions are ephemeral; the container is gone an hour later. <code>/api/memory</code> is durable state keyed to the paying wallet — persist findings today, read them next week from a different machine, zero credentials to store or leak.</p>
    </div>
    <div class="card">
      <h3>Escape its own sandbox</h3>
      <p>Many runtimes block or allowlist network egress, so "just fetch it" fails. Agent402 endpoints are a single, predictable host that does the fetching, parsing, and rendering server-side — with SSRF guards built in.</p>
    </div>
    <div class="card">
      <h3>Beat the token math</h3>
      <p>Writing, testing, and debugging a CSV parser or cron calculator mid-task burns thousands of tokens — easily 10-100&times; the price of a tested <code>$0.001</code> call. Reimplementation is the expensive path.</p>
    </div>
  </div>

  <h2>${count} tools, nine categories</h2>
  <div class="grid">
${categoryCards}
  </div>

  <h2>How it works</h2>
  <div class="step"><b>1</b><span>Your agent calls a paid endpoint and receives <code>HTTP 402 Payment Required</code> with the price and payment details.</span></div>
  <div class="step"><b>2</b><span>An x402-capable client (e.g. <code>@x402/fetch</code>, <code>@x402/axios</code>, or any agent framework with x402 support) signs a USDC payment from its wallet and retries the request.</span></div>
  <div class="step"><b>3</b><span>Payment settles on ${network} in seconds and the response comes back. Total overhead: one round trip.</span></div>

  <h2>Quickstart (JavaScript agent)</h2>
  <pre>import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, {
  signer: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY),
});
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("${baseUrl}/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
console.log(await res.json()); // { title, markdown, ... }</pre>

  <h2>Try it (no payment needed)</h2>
  <pre># Machine-readable catalog — free
curl ${baseUrl}/api/pricing

# Full OpenAPI 3.1 spec — free
curl ${baseUrl}/openapi.json

# See the 402 challenge a paying agent receives
curl -i -X POST ${baseUrl}/api/extract \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com"}'</pre>

  <footer>
    Agent402 — ${count} machine-payable tools for AI agents. Built on the <a href="https://x402.org" rel="noopener">x402 protocol</a>.
    Free: <a href="/tools">/tools</a> · <a href="/api/pricing">/api/pricing</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/llms.txt">/llms.txt</a> · <code>GET /health</code>.
  </footer>
</div>
</body>
</html>`;
}
