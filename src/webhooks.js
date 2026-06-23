// Webhook/callback documentation page — explains async patterns and
// planned webhook support for long-running tool chains.

import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function webhooksPage(baseUrl) {
  const canonical = `${baseUrl}/docs/webhooks`;
  const title = "Webhooks & Callbacks — async patterns for Agent402";
  const description = "How to handle async workflows with Agent402: polling, idempotent retries, and planned webhook support for long-running tool chains.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
${CHROME_HEAD_LINKS}
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,sans-serif}
.wh-wrap{max-width:800px;margin:0 auto;padding:2rem 1.25rem 4rem}
.wh-crumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.wh-crumb a{color:var(--accent);text-decoration:none}
.wh-crumb a:hover{text-decoration:underline}
h1{font-size:1.6rem;font-weight:700;margin:0 0 .75rem}
.wh-sub{color:var(--muted);margin:0 0 2rem;font-size:.95rem;max-width:640px}
h2{font-size:1.2rem;margin:2rem 0 .75rem;color:var(--text)}
h3{font-size:1rem;margin:1.5rem 0 .5rem;color:var(--text)}
p{color:var(--muted);line-height:1.7;margin:0 0 1rem}
a{color:var(--accent)}
code{font-family:var(--mono);background:rgba(255,255,255,.04);padding:.15rem .45rem;border-radius:4px;font-size:.85rem}
pre{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:1rem 1.25rem;overflow-x:auto;margin:0 0 1.25rem;font-family:var(--mono);font-size:.82rem;line-height:1.55;color:var(--text)}
.wh-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.25rem 1.5rem;margin-bottom:1rem}
.wh-card h3{margin:.25rem 0 .5rem;font-size:1rem}
.wh-card p{font-size:.9rem}
.wh-badge{display:inline-block;background:#1a3a2a;color:var(--accent);font-size:.72rem;font-weight:600;padding:2px 8px;border-radius:4px;margin-left:8px;vertical-align:middle}
.wh-badge.planned{background:#2a2a1a;color:#facc15}
.wh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin:1rem 0 2rem}
</style>
</head>
<body>
${renderHeader("/docs")}
<div class="wh-wrap">
<p class="wh-crumb"><a href="/">Home</a> &rsaquo; <a href="/docs">Docs</a> &rsaquo; Webhooks &amp; Callbacks</p>

<h1>Webhooks &amp; Callbacks</h1>
<p class="wh-sub">How to handle async workflows, retries, and long-running tool chains with Agent402.</p>

<h2>Current async patterns</h2>
<p>All Agent402 tools return results synchronously in the HTTP response. For workflows that chain multiple tools, here are the patterns available today:</p>

<div class="wh-grid">
  <div class="wh-card">
    <h3>Idempotent retries <span class="wh-badge">Available</span></h3>
    <p>Add an <code>Idempotency-Key</code> header to any request. If a network error occurs mid-flight, retry safely — the server returns the cached result without re-charging.</p>
  </div>
  <div class="wh-card">
    <h3>Sequential chaining <span class="wh-badge">Available</span></h3>
    <p>Chain tools by calling them in sequence: <code>render</code> &rarr; <code>extract</code> &rarr; <code>memory-write</code>. Each call is independent and stateless. Use <a href="/workflows">workflow examples</a> for patterns.</p>
  </div>
  <div class="wh-card">
    <h3>Wallet-keyed state <span class="wh-badge">Available</span></h3>
    <p>Use the memory tools (<code>memory-write</code>, <code>memory-read</code>) to persist intermediate results across tool calls. Your wallet address is your identity — no accounts needed.</p>
  </div>
</div>

<h2>Idempotent retries in practice</h2>
<p>Pass an <code>Idempotency-Key</code> header with any unique string. The server caches the result keyed to your request + credential combination:</p>

<pre>curl -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-key-123" \\
  -d '{"text":"hello","algo":"sha256"}'

# Retry the same request — returns cached result, no re-charge
curl -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-key-123" \\
  -d '{"text":"hello","algo":"sha256"}'</pre>

<p>The cache key is <code>sha256(METHOD /path + key + credential)</code>, so different callers with the same idempotency key don't collide.</p>

<h2>Chaining with agent402-client</h2>
<pre>import { Agent402 } from "agent402-client";

const a = new Agent402();

// Step 1: Render a page
const html = await a.call("render", { url: "https://example.com" });

// Step 2: Extract structured data
const data = await a.call("extract", { html: html.html, selector: "h1" });

// Step 3: Store for later
await a.call("memory-write", {
  key: "example-title",
  value: data.text
});</pre>

<h2>Planned: webhook callbacks <span class="wh-badge planned">Planned</span></h2>
<p>We're designing a webhook system for long-running chains. The planned flow:</p>

<div class="wh-card">
  <h3>How it will work</h3>
  <p>1. Submit a tool call with a <code>X-Callback-URL</code> header pointing to your endpoint.<br>
  2. Agent402 returns <code>202 Accepted</code> with a job ID immediately.<br>
  3. When the tool completes, Agent402 POSTs the result to your callback URL with an HMAC signature for verification.<br>
  4. Poll <code>/api/jobs/:id</code> as a fallback if the callback fails.</p>
</div>

<p>Want to be notified when webhooks launch? Follow <a href="https://x.com/Agent402Tools" rel="noopener">@Agent402Tools</a> or watch the <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">GitHub repo</a>.</p>

<h2>Related</h2>
<p>
  <a href="/workflows">Workflow examples</a> &mdash; see how tools chain together<br>
  <a href="/quickstart">Quickstart</a> &mdash; get your first call working in 60 seconds<br>
  <a href="/docs">Documentation</a> &mdash; full API reference
</p>

</div>
${renderFooter()}
</body>
</html>`;
}
