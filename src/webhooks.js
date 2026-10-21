// Webhook/callback documentation page: the async patterns that exist today
// (async jobs, idempotent retries, chaining, wallet-keyed state) and the one
// piece still planned (a callback POST to the buyer's own URL).

import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";

import { REPO_URL } from "./repo-link.js";
export function webhooksPage(baseUrl) {
  const canonical = `${baseUrl}/docs/webhooks`;
  const title = "Webhooks & Callbacks - Agent402 Docs";
  const description = "How to handle async workflows with Agent402: async jobs with a job link to poll, idempotent retries, chaining, and planned callback delivery for long-running tool chains.";

  const extraCss = `
  @media (max-width: 900px) {
    .ml-wh-grid { grid-template-columns: 1fr !important; }
    .ml-wh-toc  { position: static !important; }
  }
  .ml-wh-cards { display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin:14px 0 32px; }`;

  const body = `
  <div class="ml-wh-grid" style="max-width:1180px;margin:0 auto;padding:50px 30px 64px;display:grid;grid-template-columns:200px 1fr;gap:44px;align-items:start;">

    <!-- TOC -->
    <aside class="ml-wh-toc" style="position:sticky;top:92px;font-family:var(--font-mono);font-size:var(--fs-sm);">
      <div style="font-size:var(--fs-2xs);color:var(--accent);letter-spacing:.1em;margin-bottom:14px;">WEBHOOKS</div>
      <div style="display:flex;flex-direction:column;gap:11px;border-left:1px solid var(--hairline);padding-left:16px;">
        <a href="#patterns" style="color:var(--ink);text-decoration:none;font-weight:700;">async patterns</a>
        <a href="#async-jobs" style="color:var(--muted);text-decoration:none;">async jobs</a>
        <a href="#idempotent" style="color:var(--muted);text-decoration:none;">idempotent retries</a>
        <a href="#chaining" style="color:var(--muted);text-decoration:none;">chaining</a>
        <a href="#planned" style="color:var(--muted);text-decoration:none;">planned callbacks</a>
        <a href="#related" style="color:var(--muted);text-decoration:none;">related</a>
      </div>
    </aside>

    <!-- CONTENT -->
    <div>
      <p style="font-size:var(--fs-md);color:var(--faint);margin:0 0 20px;"><a href="/" style="color:var(--faint);text-decoration:none;">Home</a> &rsaquo; <a href="/docs" style="color:var(--faint);text-decoration:none;">Docs</a> &rsaquo; Webhooks &amp; Callbacks</p>
      <h1 style="font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-4xl);line-height:1;margin:0 0 14px;">Webhooks &amp; Callbacks</h1>
      <p style="font-size:var(--fs-lg);line-height:1.55;color:var(--muted);max-width:620px;margin:0 0 36px;">How to handle async workflows, retries, and long-running tool chains with Agent402.</p>

      <h2 id="patterns" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;">Current async patterns</h2>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 14px;">Most tools answer in the HTTP response itself. The slow paid routes (reports, media, plan execution) can also run as a job you collect later. The patterns available today:</p>

      <div class="ml-wh-cards">
        <div style="background:var(--card);border:1px solid var(--hairline);padding:20px 22px;">
          <h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;">Async jobs <span style="display:inline-block;background:var(--panel);color:var(--accent-lit);font-size:var(--fs-xs);font-weight:700;padding:2px 8px;font-family:var(--font-mono);">Available</span></h3>
          <p style="color:var(--muted);font-size:var(--fs-md);line-height:1.6;margin:0;">Send <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">Prefer: respond-async</code> with a paid call to a slow route and get <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">202 Accepted</code> with a job link at once. Poll <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">GET /api/jobs/{id}</code> (free) for its stage, progress and ETA until it has succeeded or failed. Payment settles only when the result is ready.</p>
        </div>
        <div style="background:var(--card);border:1px solid var(--hairline);padding:20px 22px;">
          <h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;">Idempotent retries <span style="display:inline-block;background:var(--panel);color:var(--accent-lit);font-size:var(--fs-xs);font-weight:700;padding:2px 8px;font-family:var(--font-mono);">Available</span></h3>
          <p style="color:var(--muted);font-size:var(--fs-md);line-height:1.6;margin:0;">Add an <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">Idempotency-Key</code> header to a paid or proof-of-work call. Resend the same request with the same key and the same payment header, and the server returns the stored answer without charging again. A retry while the first copy still runs gets <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">409</code> with <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">Retry-After</code>.</p>
        </div>
        <div style="background:var(--card);border:1px solid var(--hairline);padding:20px 22px;">
          <h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;">Sequential chaining <span style="display:inline-block;background:var(--panel);color:var(--accent-lit);font-size:var(--fs-xs);font-weight:700;padding:2px 8px;font-family:var(--font-mono);">Available</span></h3>
          <p style="color:var(--muted);font-size:var(--fs-md);line-height:1.6;margin:0;">Chain tools by calling them in sequence, for example <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">render</code> &rarr; <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">extract</code> &rarr; <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">memory-write</code> (wallet-only tools, paid per call). Each call is independent and stateless. Use <a href="/workflows" style="color:var(--accent);">workflow examples</a> for patterns.</p>
        </div>
        <div style="background:var(--card);border:1px solid var(--hairline);padding:20px 22px;">
          <h3 style="font-weight:600;font-size:var(--fs-lg);margin:0 0 8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;">Wallet-keyed state <span style="display:inline-block;background:var(--panel);color:var(--accent-lit);font-size:var(--fs-xs);font-weight:700;padding:2px 8px;font-family:var(--font-mono);">Available</span></h3>
          <p style="color:var(--muted);font-size:var(--fs-md);line-height:1.6;margin:0;">Use the memory tools (<code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">memory-write</code>, <code style="font-family:var(--font-mono);background:var(--paper);padding:1px 5px;font-size:var(--fs-code-inline);">memory-read</code>) to persist intermediate results across tool calls. Your wallet address is your identity - no accounts needed.</p>
        </div>
      </div>

      <h2 id="async-jobs" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;">Async jobs</h2>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 14px;">A report runs for minutes, longer than many HTTP clients wait. Add <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">Prefer: respond-async</code> to the paid call. The server answers <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">202 Accepted</code> with a <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">Location</code> header and a <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">statusUrl</code>, runs the call with your payment, and settles only on a successful result. A run that fails is not charged, and the job says so.</p>
      <pre style="background:var(--panel);color:var(--on-panel);font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.55;padding:16px;margin:0 0 14px;overflow-x:auto;"># the paid call, with your x402 payment header, asking for a job
POST /v1/research
Prefer: respond-async
PAYMENT-SIGNATURE: &lt;signed payment&gt;

# 202 Accepted, Location: /api/jobs/&lt;id&gt;; poll it (free), waiting Retry-After seconds, until status is succeeded or failed
curl -s https://agent402.tools/api/jobs/&lt;id&gt;
# {"status":"running","stage":"searching","steps":{"done":1,"total":5},"progress":0.2,"etaSeconds":64}</pre>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 36px;">A job is queued until the paid handler starts, then running with a stage, a progress from 0 to 1 and an ETA, then succeeded or failed. A slow route's 402 carries <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">X-Async-Recommended</code>, and agent402-client and agent402-mcp switch to a job on their own. The job id is the only key to the result: keep it private. On the hosted MCP connector the same long calls run as MCP tasks, with the same progress in <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">tasks/get</code>.</p>

      <h2 id="idempotent" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;">Idempotent retries in practice</h2>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 14px;">Pass an <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">Idempotency-Key</code> header with any unique string. The server stores a successful answer keyed to the route, the key, the credential that paid and the body, so the replay must carry the same payment header (an x402 <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">PAYMENT-SIGNATURE</code>, a proof-of-work solution or a credits key). A fresh payment with the same key is a new call. This example uses a proof-of-work solution from <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">GET /api/pow/challenge?slug=hash</code>:</p>

      <pre style="background:var(--panel);color:var(--on-panel);font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.55;padding:16px;margin:0 0 14px;overflow-x:auto;">curl -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-key-123" \\
  -H "X-Pow-Solution: &lt;token&gt;:&lt;nonce&gt;" \\
  -d '{"text":"hello","algo":"sha256"}'

# Retry with the same key, the same credential and the same body:
# the stored answer comes back with X-Idempotent-Replay: true, nothing is spent again
curl -i -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: my-unique-key-123" \\
  -H "X-Pow-Solution: &lt;token&gt;:&lt;nonce&gt;" \\
  -d '{"text":"hello","algo":"sha256"}'</pre>

      <p style="color:var(--muted);line-height:1.7;margin:0 0 36px;">The cache key is <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">sha256(METHOD /path + key + credential + body hash)</code>, so different callers with the same idempotency key don't collide, and the same key with a different body is a different entry. <a href="https://www.npmjs.com/package/agent402-client" rel="noopener" style="color:var(--accent);">agent402-client</a> resends the same payment for you on a retry.</p>

      <h2 id="chaining" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;">Chaining with agent402-client</h2>
      <pre style="background:var(--panel);color:var(--on-panel);font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.55;padding:16px;margin:0 0 36px;overflow-x:auto;">import { Agent402 } from "agent402-client";

// Free tier: each call settles its own proof-of-work, no wallet needed
const a = new Agent402();
const md = await a.call("html-to-markdown", { html: "&lt;h1&gt;Q3 report&lt;/h1&gt;&lt;p&gt;Revenue rose.&lt;/p&gt;" });
const stats = await a.call("text-stats", { text: md.markdown });

// Wallet-only tools chain the same way through a payment-wrapped fetch.
// Memory is keyed to the wallet that signs the x402 payment.
// payFetch: an @x402/fetch-wrapped fetch (see the USDC tab on /quickstart).
const paid = new Agent402({ fetch: payFetch });
const page = await paid.call("extract", { url: "https://example.com" });
await paid.call("memory-write", { key: "example-title", value: page.title });</pre>

      <h2 id="planned" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;">Planned: callback delivery <span style="display:inline-block;background:var(--card);border:1px solid var(--hairline);color:var(--accent);font-size:var(--fs-xs);font-weight:700;padding:2px 8px;margin-left:8px;vertical-align:middle;font-family:var(--font-mono);">Planned</span></h2>
      <p style="color:var(--muted);line-height:1.7;margin:0 0 14px;">Async jobs are polled today. The planned addition is delivery to your own endpoint: name a callback URL on the call, and when the job finishes the server POSTs the result there with a signature you can verify. Polling <code style="font-family:var(--font-mono);background:var(--card);border:1px solid var(--hairline);padding:1px 5px;font-size:var(--fs-code-inline);">/api/jobs/{id}</code> stays the fallback.</p>

      <p style="color:var(--muted);line-height:1.7;margin:0 0 36px;">To hear when callbacks ship, follow <a href="https://x.com/Agent402Tools" rel="noopener" style="color:var(--accent);">@Agent402Tools</a> or watch the <a href="${REPO_URL}" rel="noopener" style="color:var(--accent);">GitHub repo</a>.</p>

      <h2 id="related" style="font-family:var(--font-body);font-weight:700;font-size:var(--fs-xl);letter-spacing:-.02em;margin:0 0 12px;">Related</h2>
      <p style="color:var(--muted);line-height:1.7;margin:0;">
        <a href="/workflows" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px;">Workflow examples</a> - see how tools chain together<br>
        <a href="/quickstart" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px;">Quickstart</a> - get your first call working in 60 seconds<br>
        <a href="/docs" style="color:var(--accent);text-decoration:underline;text-underline-offset:3px;">Documentation</a> - full API reference
      </p>
    </div>
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
