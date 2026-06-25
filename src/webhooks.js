// Webhook/callback documentation page — explains async patterns and
// planned webhook support for long-running tool chains.

import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function webhooksPage(baseUrl) {
  const canonical = `${baseUrl}/docs/webhooks`;
  const title = "Webhooks & Callbacks \u2014 Agent402 Docs";
  const description = "How to handle async workflows with Agent402: polling, idempotent retries, and planned webhook support for long-running tool chains.";

  const extraCss = `
  @media (max-width: 900px) {
    .ml-wh-grid { grid-template-columns: 1fr !important; }
    .ml-wh-toc  { position: static !important; }
  }
  .ml-wh-cards { display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin:14px 0 32px; }`;

  const body = `
  <div class="ml-wh-grid" style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;display:grid;grid-template-columns:200px 1fr;gap:44px;align-items:start;">

    <!-- TOC -->
    <aside class="ml-wh-toc" style="position:sticky;top:92px;font-family:var(--font-mono);font-size:13px;">
      <div style="font-size:11px;color:var(--accent);letter-spacing:.1em;margin-bottom:14px;">WEBHOOKS</div>
      <div style="display:flex;flex-direction:column;gap:11px;border-left:1.5px solid var(--ink);padding-left:16px;">
        <a href="#patterns" style="color:var(--ink);text-decoration:none;font-weight:700;">async patterns</a>
        <a href="#idempotent" style="color:var(--muted);text-decoration:none;">idempotent retries</a>
        <a href="#chaining" style="color:var(--muted);text-decoration:none;">chaining</a>
        <a href="#planned" style="color:var(--muted);text-decoration:none;">planned webhooks</a>
        <a href="#related" style="color:var(--muted);text-decoration:none;">related</a>
      </div>
    </aside>

    <!-- CONTENT -->
    <main>
      <p style="font-size:.85rem;color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--faint);text-decoration:none;">Home</a> &rsaquo; <a href="/docs" style="color:var(--faint);text-decoration:none;">Docs</a> &rsaquo; Webhooks &amp; Callbacks</p>
      <h1 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:1;letter-spacing:-.02em;margin:0 0 14px;">Webhooks &amp; Callbacks</h1>
      <p style="font-size:17px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 36px;">How to handle async workflows, retries, and long-running tool chains with Agent402.</p>

      <h2 id="patterns" style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Current async patterns</h2>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 14px;">All Agent402 tools return results synchronously in the HTTP response. For workflows that chain multiple tools, here are the patterns available today:</p>

      <div class="ml-wh-cards">
        <div style="background:var(--card);border:1.5px solid var(--ink);padding:20px 22px;">
          <h3 style="font-weight:700;font-size:1rem;margin:0 0 8px;">Idempotent retries <span style="display:inline-block;background:var(--ink);color:var(--green);font-size:.72rem;font-weight:700;padding:2px 8px;margin-left:8px;vertical-align:middle;font-family:var(--font-mono);">Available</span></h3>
          <p style="color:var(--muted);font-size:.9rem;line-height:1.6;margin:0;">Add an <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">Idempotency-Key</code> header to any request. If a network error occurs mid-flight, retry safely &mdash; the server returns the cached result without re-charging.</p>
        </div>
        <div style="background:var(--card);border:1.5px solid var(--ink);padding:20px 22px;">
          <h3 style="font-weight:700;font-size:1rem;margin:0 0 8px;">Sequential chaining <span style="display:inline-block;background:var(--ink);color:var(--green);font-size:.72rem;font-weight:700;padding:2px 8px;margin-left:8px;vertical-align:middle;font-family:var(--font-mono);">Available</span></h3>
          <p style="color:var(--muted);font-size:.9rem;line-height:1.6;margin:0;">Chain tools by calling them in sequence: <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">render</code> &rarr; <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">extract</code> &rarr; <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">memory-write</code>. Each call is independent and stateless. Use <a href="/workflows" style="color:var(--accent);">workflow examples</a> for patterns.</p>
        </div>
        <div style="background:var(--card);border:1.5px solid var(--ink);padding:20px 22px;">
          <h3 style="font-weight:700;font-size:1rem;margin:0 0 8px;">Wallet-keyed state <span style="display:inline-block;background:var(--ink);color:var(--green);font-size:.72rem;font-weight:700;padding:2px 8px;margin-left:8px;vertical-align:middle;font-family:var(--font-mono);">Available</span></h3>
          <p style="color:var(--muted);font-size:.9rem;line-height:1.6;margin:0;">Use the memory tools (<code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">memory-write</code>, <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">memory-read</code>) to persist intermediate results across tool calls. Your wallet address is your identity &mdash; no accounts needed.</p>
        </div>
      </div>

      <h2 id="idempotent" style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Idempotent retries in practice</h2>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 14px;">Pass an <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:.85em;">Idempotency-Key</code> header with any unique string. The server caches the result keyed to your request + credential combination:</p>

      <pre style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0 0 14px;overflow-x:auto;">curl -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-key-123" \\
  -d '{"text":"hello","algo":"sha256"}'

# Retry the same request — returns cached result, no re-charge
curl -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-key-123" \\
  -d '{"text":"hello","algo":"sha256"}'</pre>

      <p style="color:var(--muted);line-height:1.7;margin:0 0 36px;">The cache key is <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:.85em;">sha256(METHOD /path + key + credential)</code>, so different callers with the same idempotency key don't collide.</p>

      <h2 id="chaining" style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Chaining with agent402-client</h2>
      <pre style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:.82rem;line-height:1.55;padding:16px;margin:0 0 36px;overflow-x:auto;">import { Agent402 } from "agent402-client";

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

      <h2 id="planned" style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Planned: webhook callbacks <span style="display:inline-block;background:var(--card);border:1.5px solid var(--ink);color:var(--accent);font-size:.72rem;font-weight:700;padding:2px 8px;margin-left:8px;vertical-align:middle;font-family:var(--font-mono);">Planned</span></h2>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 14px;">We're designing a webhook system for long-running chains. The planned flow:</p>

      <div style="background:var(--card);border:1.5px solid var(--ink);padding:20px 22px;margin-bottom:14px;">
        <h3 style="font-weight:700;font-size:1rem;margin:0 0 8px;">How it will work</h3>
        <p style="color:var(--muted);font-size:.9rem;line-height:1.7;margin:0;">1. Submit a tool call with a <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">X-Callback-URL</code> header pointing to your endpoint.<br>
        2. Agent402 returns <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">202 Accepted</code> with a job ID immediately.<br>
        3. When the tool completes, Agent402 POSTs the result to your callback URL with an HMAC signature for verification.<br>
        4. Poll <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:.85em;">/api/jobs/:id</code> as a fallback if the callback fails.</p>
      </div>

      <p style="color:var(--muted);line-height:1.7;margin:0 0 36px;">Want to be notified when webhooks launch? Follow <a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--accent);">@Agent402Tools</a> or watch the <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener" style="color:var(--accent);">GitHub repo</a>.</p>

      <h2 id="related" style="font-family:var(--font-body);font-weight:800;font-size:24px;letter-spacing:-.02em;margin:0 0 12px;">Related</h2>
      <p style="color:var(--muted);line-height:1.7;margin:0;">
        <a href="/workflows" style="color:var(--accent);text-decoration:none;">Workflow examples</a> &mdash; see how tools chain together<br>
        <a href="/quickstart" style="color:var(--accent);text-decoration:none;">Quickstart</a> &mdash; get your first call working in 60 seconds<br>
        <a href="/docs" style="color:var(--accent);text-decoration:none;">Documentation</a> &mdash; full API reference
      </p>
    </main>
  </div>
  ${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/docs",
    extraCss,
    body,
  });
}
