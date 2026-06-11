export function landingPage(baseUrl, network, freeMode) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent402 — Paid web tools for AI agents (x402, USDC on Base)</title>
<meta name="description" content="Pay-per-call web tools for AI agents: headless-browser rendering, screenshots, PDF extraction, URL-to-markdown, wallet-keyed memory, metadata and DNS. Paid per request in USDC via the x402 protocol — no API keys, no signup.">
<link rel="canonical" href="${baseUrl}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/">
<meta property="og:site_name" content="Agent402">
<meta property="og:title" content="Agent402 — Paid web tools for AI agents">
<meta property="og:description" content="8 machine-payable endpoints: browser rendering, screenshots, PDF extraction, markdown extraction, wallet-keyed memory, metadata, DNS. USDC per call via x402. No signup.">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Agent402 — Paid web tools for AI agents">
<meta name="twitter:description" content="Machine-payable web tools. Agents pay per call in USDC via x402 — no API keys, no signup.">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebAPI",
  "name": "Agent402",
  "url": "${baseUrl}",
  "description": "Pay-per-call web tools for AI agents via the x402 payment protocol (USDC on Base): headless-browser rendering, screenshots, PDF text extraction, URL-to-markdown, wallet-keyed key-value memory, page metadata, and DNS lookups.",
  "documentation": "${baseUrl}/llms.txt",
  "termsOfService": "${baseUrl}/",
  "offers": { "@type": "Offer", "price": "0.001-0.02", "priceCurrency": "USD", "description": "Per-call micropayments in USDC via x402" }
}
</script>
<style>
  :root { --bg:#0b0e14; --card:#131826; --text:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:860px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:2.4rem; line-height:1.15; margin-bottom:12px; }
  h1 .x { color:var(--accent); }
  .sub { color:var(--muted); font-size:1.15rem; max-width:600px; }
  .badge { display:inline-block; background:#1b2336; color:var(--accent); border:1px solid #2a3550; border-radius:999px; padding:3px 12px; font-size:.8rem; margin-bottom:20px; font-family:var(--mono); }
  .grid { display:grid; gap:16px; margin:36px 0; }
  @media (min-width:640px){ .grid{ grid-template-columns:repeat(3,1fr);} }
  .card { background:var(--card); border:1px solid #1e2638; border-radius:12px; padding:20px; }
  .card h3 { font-size:1rem; margin-bottom:6px; }
  .card .price { color:var(--accent); font-family:var(--mono); font-size:.9rem; }
  .card p { color:var(--muted); font-size:.88rem; margin-top:8px; }
  .card code { font-family:var(--mono); font-size:.78rem; color:#a5b4d4; }
  h2 { margin:40px 0 12px; font-size:1.3rem; }
  pre { background:#0d1220; border:1px solid #1e2638; border-radius:10px; padding:16px; overflow-x:auto; font-family:var(--mono); font-size:.82rem; line-height:1.5; color:#c9d4ec; }
  .step { display:flex; gap:14px; margin:14px 0; }
  .step b { color:var(--accent); font-family:var(--mono); flex-shrink:0; }
  .step span { color:var(--muted); }
  a { color:var(--accent); }
  footer { margin-top:56px; color:var(--muted); font-size:.85rem; border-top:1px solid #1e2638; padding-top:20px; }
  .warn { background:#3a2a12; border:1px solid #6b4a1a; color:#fbbf24; border-radius:10px; padding:12px 16px; margin:20px 0; font-size:.9rem; }
</style>
</head>
<body>
<div class="wrap">
  <div class="badge">x402 &middot; USDC on ${network} &middot; no signup, no API keys</div>
  <h1>Agent<span class="x">402</span></h1>
  <p class="sub">Pay-per-call web tools built for AI agents. Your agent hits the endpoint, pays a fraction of a cent in USDC automatically, and gets the result. No accounts. No keys. No subscriptions.</p>
  ${freeMode ? '<div class="warn">⚠ Demo mode — payments are currently disabled on this instance.</div>' : ""}

  <div class="grid">
    <div class="card">
      <h3>Render 🆕</h3>
      <div class="price">$0.02 / call</div>
      <p>Real headless Chromium. JavaScript executed, SPAs included &rarr; clean markdown. The pages plain fetch can't read.</p>
      <code>POST /api/render</code>
    </div>
    <div class="card">
      <h3>Memory 🆕</h3>
      <div class="price">$0.002 write / $0.001 read</div>
      <p>Persistent key-value state scoped to your wallet. Your payment is your login — no signup, no API keys, ever.</p>
      <code>POST·GET /api/memory</code>
    </div>
    <div class="card">
      <h3>Screenshot 🆕</h3>
      <div class="price">$0.015 / call</div>
      <p>Any URL &rarr; PNG, full-page optional. Visual verification for agent workflows.</p>
      <code>GET /api/screenshot?url=…</code>
    </div>
    <div class="card">
      <h3>PDF 🆕</h3>
      <div class="price">$0.01 / call</div>
      <p>PDF URL &rarr; full text + document info. Up to 20MB. The format agents hit constantly and parse badly.</p>
      <code>POST /api/pdf</code>
    </div>
    <div class="card">
      <h3>Extract</h3>
      <div class="price">$0.005 / call</div>
      <p>Any URL &rarr; clean markdown. Title, byline, main content with boilerplate stripped. The page-reading primitive every agent needs.</p>
      <code>POST /api/extract</code>
    </div>
    <div class="card">
      <h3>Meta &amp; DNS</h3>
      <div class="price">$0.002 / $0.001</div>
      <p>Page metadata (OpenGraph, Twitter cards, favicon) and DNS lookups (A, AAAA, MX, TXT, NS, CNAME).</p>
      <code>GET /api/meta · /api/dns</code>
    </div>
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

# See the 402 challenge a paying agent receives
curl -i -X POST ${baseUrl}/api/extract \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com"}'</pre>

  <footer>
    Agent402 — machine-payable web tools. Built on the <a href="https://x402.org" rel="noopener">x402 protocol</a>.
    Free endpoints: <code>GET /api/pricing</code>, <code>GET /health</code>.
  </footer>
</div>
</body>
</html>`;
}
