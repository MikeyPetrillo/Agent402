import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function quickstartPage(baseUrl) {
  const canonical = `${baseUrl}/quickstart`;
  const title = "Quickstart \u2014 your first Agent402 call in 60 seconds";
  const description =
    "Get started with Agent402 in under a minute. Pick your stack \u2014 MCP, curl, JavaScript, OpenAI, or direct USDC \u2014 and make your first call.";

  const extraCss = `
.qs-wrap{max-width:860px;margin:0 auto;padding:56px 30px}
.qs-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.qs-title{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 10px}
.qs-subtitle{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 36px}

/* tabs */
.qs-tab-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:0;border-bottom:1.5px solid var(--ink);padding-bottom:10px}
.qs-tab{background:transparent;border:1.5px solid var(--ink);color:var(--muted);font-family:var(--font-mono);font-size:13px;padding:8px 16px;cursor:pointer;transition:all .15s}
.qs-tab:hover{color:var(--ink);border-color:var(--ink)}
.qs-tab.active{background:var(--ink);color:var(--cream);border-color:var(--ink);font-weight:700}

.qs-panel{display:none;padding:28px 0 0}
.qs-panel.active{display:block}
.qs-panel h3{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink)}
.qs-panel .qs-oneliner{color:var(--muted);margin:0 0 20px;font-size:15px;line-height:1.55}

.qs-code-wrap{position:relative;margin-bottom:20px}
.qs-code-wrap pre{background:var(--ink);border:1.5px solid var(--ink);padding:20px;overflow-x:auto;margin:0;font-family:var(--font-mono);font-size:13px;line-height:1.55;color:var(--cream)}
.qs-code-wrap .qs-copy{position:absolute;top:8px;right:8px;background:var(--ink);border:1.5px solid var(--cream);color:var(--cream);font-family:var(--font-mono);font-size:11px;padding:4px 10px;cursor:pointer;transition:all .15s}
.qs-code-wrap .qs-copy:hover{background:var(--cream);color:var(--ink)}
.qs-code-wrap .qs-copy.copied{color:var(--accent);border-color:var(--accent)}

.qs-label{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--faint);margin-bottom:8px}
.qs-alt{color:var(--muted);font-size:15px;line-height:1.55;margin-top:18px}
.qs-alt code{font-family:var(--font-mono);background:var(--ink);color:var(--cream);padding:2px 7px;font-size:13px;border:1.5px solid var(--ink)}

.qs-next{margin-top:18px}
.qs-next-title{font-family:var(--font-mono);font-size:13px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.qs-next ul{margin:0;padding:0 0 0 20px;font-size:15px;line-height:1.55}
.qs-next li{margin-bottom:4px;color:var(--muted)}
.qs-next a{color:var(--accent);text-decoration:none}
.qs-next a:hover{text-decoration:underline}

/* bottom cards */
.qs-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:48px}
.qs-card{background:var(--card);border:1.5px solid var(--ink);padding:24px;text-decoration:none;color:var(--ink);transition:border-color .15s,transform .15s}
.qs-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.qs-card h4{margin:0 0 6px;font-family:var(--font-body);font-weight:800;font-size:18px}
.qs-card p{margin:0;color:var(--muted);font-size:14px;line-height:1.55}

@media(max-width:600px){
  .qs-title{font-size:36px !important}
  .qs-tab-bar{gap:4px}
  .qs-tab{font-size:12px;padding:6px 10px}
}
`;

  const body = `
<div class="qs-wrap">

<div class="qs-eyebrow">$ GET /quickstart</div>
<h1 class="qs-title">Your first Agent402 call in 60 seconds</h1>
<p class="qs-subtitle">Pick your stack, copy the snippet, and you're live.</p>

<!-- Tab bar -->
<div class="qs-tab-bar" role="tablist">
  <button class="qs-tab active" role="tab" aria-selected="true" data-tab="mcp">Claude / MCP</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="curl">curl / HTTP</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="js">JavaScript</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="ai">OpenAI / Anthropic / Vercel AI SDK</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="usdc">Pay with USDC</button>
</div>

<!-- Panel: Claude / MCP -->
<div class="qs-panel active" id="panel-mcp" role="tabpanel">
<h3>Add to Claude Code</h3>
<p class="qs-oneliner">One command and you're done &mdash; 1,338 tools available instantly.</p>

<span class="qs-label">Install</span>
<div class="qs-code-wrap">
<pre><code>claude mcp add agent402 -s user -- npx -y agent402-mcp@latest</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<span class="qs-label">Then ask Claude</span>
<div class="qs-code-wrap">
<pre><code># "extract the tables from this PDF"
# "geocode these 50 addresses"
# "fetch Apple's latest 10-K"</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<p class="qs-alt">Or paste the hosted connector URL (zero install):</p>
<div class="qs-code-wrap">
<pre><code>https://agent402.tools/mcp</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<div class="qs-next">
<div class="qs-next-title">What to try next</div>
<ul>
  <li><a href="/tools">Browse all tools</a> to see what's available</li>
  <li><a href="/playground">Try the playground</a> for interactive testing</li>
  <li><a href="/docs">Read the MCP docs</a> for advanced config</li>
</ul>
</div>
</div>

<!-- Panel: curl / HTTP -->
<div class="qs-panel" id="panel-curl" role="tabpanel">
<h3>Call any tool with curl</h3>
<p class="qs-oneliner">Standard HTTP &mdash; POST JSON, get JSON back. No SDK required.</p>

<span class="qs-label">See a 402 quote (free)</span>
<div class="qs-code-wrap">
<pre><code>curl -i -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -d '{"text":"hello world","algo":"sha256"}'</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<span class="qs-label">Pay with proof-of-work (free, no wallet)</span>
<div class="qs-code-wrap">
<pre><code># Grab a challenge
CHAL=$(curl -s "https://agent402.tools/api/pow/challenge?slug=hash")

# Solve the challenge, then retry with:
curl -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "X-Pow-Solution: &lt;nonce&gt;:&lt;hash&gt;" \\
  -d '{"text":"hello world","algo":"sha256"}'</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<div class="qs-next">
<div class="qs-next-title">What to try next</div>
<ul>
  <li>Use <a href="/api/find?q=geocode">/api/find?q=&lt;task&gt;</a> to discover tools by keyword</li>
  <li>Check <a href="/api/pricing">/api/pricing</a> for the full price list</li>
  <li>Add an <code>Idempotency-Key</code> header for safe retries</li>
</ul>
</div>
</div>

<!-- Panel: JavaScript -->
<div class="qs-panel" id="panel-js" role="tabpanel">
<h3>Use the JavaScript SDK</h3>
<p class="qs-oneliner">Install agent402-client &mdash; auto-payment via proof-of-work, no wallet needed.</p>

<span class="qs-label">Install</span>
<div class="qs-code-wrap">
<pre><code>npm install agent402-client</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<span class="qs-label">Call a tool</span>
<div class="qs-code-wrap">
<pre><code>import { Agent402 } from "agent402-client";

const a = new Agent402();  // free tier (proof-of-work)

const result = await a.call("hash", {
  text: "hello world",
  algo: "sha256"
});

console.log(result);</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<div class="qs-next">
<div class="qs-next-title">What to try next</div>
<ul>
  <li>Use <code>a.find("geocode")</code> to search tools programmatically</li>
  <li>Pass a wallet key to unlock paid-only tools</li>
  <li>Enable <a href="/docs">idempotent retries</a> for production use</li>
</ul>
</div>
</div>

<!-- Panel: OpenAI / Anthropic / Vercel AI SDK -->
<div class="qs-panel" id="panel-ai" role="tabpanel">
<h3>Plug into any LLM framework</h3>
<p class="qs-oneliner">Drop-in tool definitions for OpenAI, Anthropic, and Vercel AI SDK.</p>

<span class="qs-label">Install</span>
<div class="qs-code-wrap">
<pre><code>npm install agent402-openai-tools
# also: agent402-anthropic-tools, agent402-ai-sdk</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<span class="qs-label">Wire into your LLM call</span>
<div class="qs-code-wrap">
<pre><code>import { agent402Tools } from "agent402-openai-tools";
// also: agent402-anthropic-tools, agent402-ai-sdk

const { tools, execute } = await agent402Tools();

// pass tools to your LLM call
// when it returns a tool_call, run:
await execute(name, args);</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<div class="qs-next">
<div class="qs-next-title">What to try next</div>
<ul>
  <li>Filter tools by category: <code>agent402Tools({ categories: ["search"] })</code></li>
  <li>Combine with the <a href="/docs">MCP connector</a> for Claude-native integration</li>
  <li>See the <a href="/playground">playground</a> for live examples</li>
</ul>
</div>
</div>

<!-- Panel: Pay with USDC -->
<div class="qs-panel" id="panel-usdc" role="tabpanel">
<h3>Pay directly with USDC on Base</h3>
<p class="qs-oneliner">Use the x402 protocol for on-chain payment &mdash; no API keys, no accounts.</p>

<span class="qs-label">Install</span>
<div class="qs-code-wrap">
<pre><code>npm install @x402/fetch @x402/core @x402/evm viem</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<span class="qs-label">Make a paid call</span>
<div class="qs-code-wrap">
<pre><code>import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, {
  signer: privateKeyToAccount(process.env.AGENT_KEY)
});
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("https://agent402.tools/api/extract", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<div class="qs-next">
<div class="qs-next-title">What to try next</div>
<ul>
  <li>Check <a href="/api/pricing">/api/pricing</a> for per-tool USDC prices</li>
  <li>Add an <code>Idempotency-Key</code> header so retries never double-charge</li>
  <li>See <a href="/.well-known/x402">/.well-known/x402</a> for the machine-readable payment manifest</li>
</ul>
</div>
</div>

<!-- What to try next cards -->
<div class="qs-cards">
  <a class="qs-card" href="/tools">
    <h4>Browse 1,338 tools</h4>
    <p>Search, filter, and preview every tool in the catalog.</p>
  </a>
  <a class="qs-card" href="/playground">
    <h4>Try it live</h4>
    <p>Run any tool interactively in the browser playground.</p>
  </a>
  <a class="qs-card" href="/docs">
    <h4>Read the docs</h4>
    <p>API reference, authentication, pricing, and advanced usage.</p>
  </a>
</div>

</div>
${ledgerFooterCompact()}

<script>
(function(){
  var tabs=document.querySelectorAll(".qs-tab");
  var panels=document.querySelectorAll(".qs-panel");
  tabs.forEach(function(t){
    t.addEventListener("click",function(){
      tabs.forEach(function(b){b.classList.remove("active");b.setAttribute("aria-selected","false")});
      panels.forEach(function(p){p.classList.remove("active")});
      t.classList.add("active");
      t.setAttribute("aria-selected","true");
      var id="panel-"+t.getAttribute("data-tab");
      document.getElementById(id).classList.add("active");
    });
  });

  document.querySelectorAll(".qs-copy").forEach(function(btn){
    btn.addEventListener("click",function(){
      var code=btn.parentElement.querySelector("code");
      var text=code.textContent;
      navigator.clipboard.writeText(text).then(function(){
        btn.textContent="Copied!";
        btn.classList.add("copied");
        setTimeout(function(){btn.textContent="Copy";btn.classList.remove("copied")},1500);
      });
    });
  });
})();
</script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/quickstart", extraCss, body });
}
