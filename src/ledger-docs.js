// Machine Ledger — Docs page (/docs)
// Two-column layout: sticky TOC (left) + content sections (right).
// Quickstart, payment flow, three ways in, free tier, reference endpoints.

import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

export function ledgerDocsPage(baseUrl) {
  const canonical = baseUrl + "/docs";
  const title = "Docs — Agent402";
  const description = "Add 1,337 deterministic tools to your agent in about a minute. No signup, no API key — start free with proof-of-work, settle USDC on Base when you scale.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    name: "Agent402 Documentation",
    url: canonical,
    description,
    publisher: {
      "@type": "Organization",
      name: "Agent402",
      url: baseUrl,
    },
  };

  const extraCss = `
  .ml-docs-grid [id] { scroll-margin-top: 110px; }
  .ml-docs-toc a.active { color: var(--ink) !important; font-weight: 700; }
  @media (max-width: 900px) {
    .ml-docs-grid { grid-template-columns: 1fr !important; }
    .ml-docs-toc  { position: static !important; }
  }`;

  const body = `
  <!-- DOCS LAYOUT -->
  <div class="ml-docs-grid" style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;display:grid;grid-template-columns:220px 1fr;gap:44px;">

    <!-- TOC -->
    <aside class="ml-docs-toc" style="position:sticky;top:92px;font-family:var(--font-mono);font-size:13px;">
      <div style="font-size:11px;color:var(--accent);letter-spacing:.1em;margin-bottom:14px;">$ GET /docs</div>
      <div style="display:flex;flex-direction:column;gap:11px;border-left:1.5px solid var(--ink);padding-left:16px;">
        <a href="#quickstart" style="color:var(--ink);text-decoration:none;font-weight:700;">quickstart</a>
        <a href="#how" style="color:var(--muted);text-decoration:none;">how payment works</a>
        <a href="#add" style="color:var(--muted);text-decoration:none;">three ways in</a>
        <a href="#free" style="color:var(--muted);text-decoration:none;">free tier &middot; PoW</a>
        <a href="#endpoints" style="color:var(--muted);text-decoration:none;">endpoints</a>
        <a href="/docs/adapters" style="color:var(--muted);text-decoration:none;">framework adapters &rarr;</a>
      </div>
    </aside>

    <!-- CONTENT -->
    <main>
      <h1 style="font-family:var(--font-body);font-weight:800;font-size:52px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;">Quickstart.</h1>
      <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 30px;">Add 1,337 deterministic tools to your agent in about a minute. No signup, no API key &mdash; start free with proof-of-work, settle USDC on Base when you scale.</p>

      <div id="quickstart" style="border:1.5px solid var(--ink);background:var(--ink);margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:7px;padding:11px 15px;border-bottom:1px solid var(--dark-border2);font-family:var(--font-mono);font-size:11px;color:var(--dk-muted);">terminal</div>
        <pre style="margin:0;padding:18px;font-family:var(--font-mono);font-size:13px;line-height:1.85;color:var(--cream);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># one file, zero deps &mdash; pays with COMPUTE (no wallet)
</span>curl -s https://agent402.tools/demo.js -o demo.js
node demo.js

<span style="color:var(--dk-muted3);"># or settle real USDC on Base with a funded key
</span>npm i @x402/core @x402/evm @x402/fetch viem
AGENT_KEY=0xYOUR_FUNDED_KEY node demo.js</pre>
      </div>
      <p style="font-family:var(--font-mono);font-size:12.5px;color:var(--faint);margin:0 0 44px;">// an autonomous buyer discovers the catalog, gets quoted over HTTP 402, settles, and uses the result &mdash; zero humans.</p>

      <!-- HOW -->
      <h2 id="how" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 18px;">How payment works.</h2>
      <div style="border:1.5px solid var(--ink);background:var(--card);margin-bottom:44px;">
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:18px;">01</span><span style="font-size:15px;line-height:1.5;color:#2c2a22;">Your agent calls a paid endpoint and receives <strong>HTTP 402 Payment Required</strong> with the price and payment details.</span></div>
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;border-bottom:1px solid var(--hairline);"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:18px;">02</span><span style="font-size:15px;line-height:1.5;color:#2c2a22;">An x402 client (<span style="font-family:var(--font-mono);font-size:13px;">@x402/fetch</span>, axios, or any framework adapter) signs a USDC payment from its wallet and retries.</span></div>
        <div style="display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 20px;"><span style="font-family:var(--font-mono);font-weight:700;color:var(--accent);font-size:18px;">03</span><span style="font-size:15px;line-height:1.5;color:#2c2a22;">Payment settles on Base in seconds and the response comes back. Total overhead: <strong>one round trip</strong>.</span></div>
      </div>

      <!-- THREE WAYS -->
      <h2 id="add" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 18px;">Three ways in.</h2>

      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:8px;">A / MCP &mdash; Claude &amp; any MCP client</div>
      <div style="border:1.5px solid var(--ink);background:var(--ink);margin-bottom:22px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:13px;line-height:1.8;color:var(--cream);white-space:pre-wrap;word-break:break-word;"><span style="color:var(--dk-muted3);"># Claude Code &mdash; no signup, no API key
</span>claude mcp add agent402 -s user -- npx -y agent402-mcp@latest

<span style="color:var(--dk-muted3);"># or paste the hosted connector (Settings &rarr; Connectors)
</span>https://agent402.tools/mcp</pre></div>

      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:8px;">B / x402 client &mdash; pay in code</div>
      <div style="border:1.5px solid var(--ink);background:var(--ink);margin-bottom:22px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:12.5px;line-height:1.8;color:var(--cream);white-space:pre-wrap;word-break:break-word;">import { wrapFetchWithPayment } from "@x402/fetch";
const payFetch = wrapFetchWithPayment(fetch, client);
const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST", body: JSON.stringify({ url })
});</pre></div>

      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);margin-bottom:8px;">C / SDK &mdash; resolves a task &amp; pays automatically</div>
      <div style="border:1.5px solid var(--ink);background:var(--ink);margin-bottom:44px;"><pre style="margin:0;padding:16px;font-family:var(--font-mono);font-size:12.5px;line-height:1.8;color:var(--cream);white-space:pre-wrap;word-break:break-word;">npm install agent402-client
import { Agent402 } from "agent402-client";
const a = new Agent402();           <span style="color:var(--dk-muted3);">// free tier (proof-of-work)</span>
const out = await a.call("hash", { text: "hello", algo: "sha256" });</pre></div>

      <!-- FREE -->
      <h2 id="free" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 14px;">Free tier &mdash; proof-of-work.</h2>
      <p style="font-size:15.5px;line-height:1.55;color:var(--muted);max-width:640px;margin:0 0 18px;">1,158 of the 1,337 pure-CPU tools work with no wallet. Instead of paying USDC, your machine solves a short sha256 puzzle &mdash; a fraction of a second of CPU &mdash; and the call goes through. Nothing here consumes AI tokens.</p>
      <div style="border:1.5px solid var(--ink);background:var(--card);padding:16px 20px;font-family:var(--font-mono);font-size:13px;margin-bottom:44px;"><span style="color:var(--green);font-weight:700;">GET</span> <span style="color:var(--ink);">/api/pow</span>  <span style="color:var(--faint);">&rarr; returns a challenge; solve and resubmit. Free, rate-limited.</span></div>

      <!-- ENDPOINTS -->
      <h2 id="endpoints" style="font-family:var(--font-body);font-weight:800;font-size:32px;letter-spacing:-.02em;margin:0 0 18px;">Reference endpoints.</h2>
      <div style="border:1.5px solid var(--ink);background:var(--card);font-family:var(--font-mono);font-size:13px;">
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--green);font-weight:700;">GET</span><span>/api/pricing</span><span style="color:var(--faint);">machine-readable catalog</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--green);font-weight:700;">GET</span><span>/openapi.json</span><span style="color:var(--faint);">full OpenAPI 3.1 spec</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--green);font-weight:700;">GET</span><span>/api/stats</span><span style="color:var(--faint);">live counts &amp; receiving wallet</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;border-bottom:1px solid var(--hairline);"><span style="color:var(--accent);font-weight:700;">POST</span><span>/api/extract</span><span style="color:var(--faint);">$0.004 &middot; url &rarr; clean markdown</span></div>
        <div style="display:grid;grid-template-columns:60px 1fr auto;gap:14px;padding:12px 18px;"><span style="color:var(--green);font-weight:700;">GET</span><span>/llms.txt</span><span style="color:var(--faint);">agent-readable site map</span></div>
      </div>
    </main>
  </div>

  ${ledgerFooterCompact()}
<script>
(function(){
  var links=document.querySelectorAll('.ml-docs-toc a[href^="#"]');
  var ids=[].map.call(links,function(a){return a.getAttribute('href').slice(1);});
  var sections=ids.map(function(id){return document.getElementById(id);}).filter(Boolean);
  function update(){
    var top=window.scrollY+130;
    var active='';
    sections.forEach(function(s){if(s.offsetTop<=top)active=s.id;});
    links.forEach(function(a){
      var h=a.getAttribute('href');
      if(h==='#'+active)a.classList.add('active');
      else a.classList.remove('active');
    });
  }
  window.addEventListener('scroll',update,{passive:true});
  update();
})();
</script>`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    jsonLd,
    extraCss,
    body,
  });
}
