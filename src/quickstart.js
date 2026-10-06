import { ledgerShell, ledgerFooterCompact } from "./ledger-chrome.js";
import { RAILS_AMP } from "./rails.js";

export function quickstartPage(baseUrl) {
  const canonical = `${baseUrl}/quickstart`;
  const title = "Quickstart - your first Agent402 call in 60 seconds";
  const description =
    "Get started with Agent402 in under a minute. Pick your stack - MCP, curl, JavaScript, OpenAI, or direct USDC - and make your first call.";

  const extraCss = `
.qs-wrap{max-width:860px;margin:0 auto;padding:56px 30px}
.qs-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.qs-title{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 10px}
.qs-subtitle{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 36px}

/* tabs */
.qs-tab-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:0;border-bottom:1px solid var(--hairline);padding-bottom:10px}
.qs-tab{background:transparent;border:1px solid var(--hairline);color:var(--muted);font-family:var(--font-mono);font-size:13px;padding:8px 16px;cursor:pointer;transition:all .15s}
.qs-tab:hover{color:var(--ink);border-color:var(--ink)}
.qs-tab.active{background:var(--surface);color:var(--on-dark);border-color:var(--ink);font-weight:700}

.qs-panel{display:none;padding:28px 0 0}
.qs-panel.active{display:block}
.qs-panel h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 8px;color:var(--ink)}
.qs-panel .qs-oneliner{color:var(--muted);margin:0 0 20px;font-size:15px;line-height:1.55}

.qs-code-wrap{position:relative;margin-bottom:20px}
.qs-code-wrap pre{background:var(--surface);border:1px solid var(--hairline);padding:20px;overflow-x:auto;margin:0;font-family:var(--font-mono);font-size:13px;line-height:1.55;color:var(--on-dark)}
.qs-code-wrap .qs-copy{position:absolute;top:8px;right:8px;background:var(--surface);border:1.5px solid var(--cream);color:var(--on-dark);font-family:var(--font-mono);font-size:11px;padding:4px 10px;cursor:pointer;transition:all .15s}
.qs-code-wrap .qs-copy:hover{background:var(--cream);color:var(--ink)}
.qs-code-wrap .qs-copy.copied{color:var(--accent);border-color:var(--accent)}

.qs-label{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--faint);margin-bottom:8px}
.qs-alt{color:var(--muted);font-size:15px;line-height:1.55;margin-top:18px}
.qs-alt code{font-family:var(--font-mono);background:var(--surface);color:var(--on-dark);padding:2px 7px;font-size:13px;border:1px solid var(--hairline)}

.qs-next{margin-top:18px}
.qs-next-title{font-family:var(--font-mono);font-size:13px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.qs-next ul{margin:0;padding:0 0 0 20px;font-size:15px;line-height:1.55}
.qs-next li{margin-bottom:4px;color:var(--muted)}
.qs-next a{color:var(--accent);text-decoration:none}
.qs-next a:hover{text-decoration:underline}

/* bottom cards */
.qs-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:48px}
.qs-card{background:var(--card);border:1px solid var(--hairline);padding:24px;text-decoration:none;color:var(--ink);transition:border-color .15s,transform .15s}
.qs-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.qs-card h3{margin:0 0 6px;font-family:var(--font-body);font-weight:800;font-size:18px}
.qs-card p{margin:0;color:var(--muted);font-size:14px;line-height:1.55}

@media(max-width:600px){
  .qs-title{font-size:36px !important}
  .qs-tab-bar{gap:4px}
  .qs-tab{font-size:12px;padding:6px 10px}
}
`;

  const body = `
<div class="qs-wrap">

<section>
<div class="qs-eyebrow">$ GET /quickstart</div>
<h1 class="qs-title">Your first Agent402 call in 60 seconds</h1>
<p class="qs-subtitle">Pick your stack, copy the snippet, and you're live.</p>
</section>

<section>
<!-- Tab bar -->
<div class="qs-tab-bar" role="tablist">
  <button class="qs-tab active" role="tab" aria-selected="true" data-tab="mcp">Claude / MCP</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="curl">curl / HTTP</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="js">JavaScript</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="models">Models (LLM gateway)</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="ai">OpenAI / Anthropic / Vercel AI SDK</button>
  <button class="qs-tab" role="tab" aria-selected="false" data-tab="usdc">Pay with USDC</button>
</div>

<!-- Panel: Claude / MCP -->
<div class="qs-panel active" id="panel-mcp" role="tabpanel">
<h2>Add to Claude Code</h2>
<p class="qs-oneliner">One command and you're done - 500+ tools available instantly.</p>

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
<h2>Call any tool with curl</h2>
<p class="qs-oneliner">Standard HTTP - send JSON, get JSON back. No SDK required.</p>

<span class="qs-label">Web search, then a cited answer: see each 402 quote (free)</span>
<div class="qs-code-wrap">
<pre><code>curl -i "https://agent402.tools/api/search?q=x402+payment+protocol+adoption&amp;count=5"
curl -i "https://agent402.tools/api/answer?q=what+is+the+x402+payment+protocol"</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>
<p class="qs-alt">Each 402 carries the price and every way to pay it. A wallet client signs the payment and retries the same request: the Pay with USDC tab shows the same two calls paid from a wallet.</p>

<p class="qs-alt"><strong>No wallet yet?</strong> The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet:</p>
<span class="qs-label">Pay with proof-of-work (free, no wallet)</span>
<div class="qs-code-wrap">
<pre><code># Grab a challenge: { "challenge", "difficulty", "token", ... }
curl -s "https://agent402.tools/api/pow/challenge?slug=hash"

# Find an integer nonce so sha256("&lt;challenge&gt;:&lt;nonce&gt;") has at least
# &lt;difficulty&gt; leading zero bits, then send the TOKEN (not the challenge):
curl -X POST https://agent402.tools/api/hash \\
  -H "Content-Type: application/json" \\
  -H "X-Pow-Solution: &lt;token&gt;:&lt;nonce&gt;" \\
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
<h2>Use the JavaScript SDK</h2>
<p class="qs-oneliner">Install agent402-client: it pays each call from your wallet, and pays the pure-CPU tools with proof-of-work.</p>

<span class="qs-label">Install</span>
<div class="qs-code-wrap">
<pre><code>npm install agent402-client @x402/fetch @x402/core @x402/evm viem</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<span class="qs-label">Web search, then a cited answer</span>
<div class="qs-code-wrap">
<pre><code>import { Agent402 } from "agent402-client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const payClient = new x402Client();
registerExactEvmScheme(payClient, { signer: privateKeyToAccount(process.env.AGENT_KEY) });
const payFetch = wrapFetchWithPayment(fetch, payClient);

const a = new Agent402({ fetch: payFetch });  // pays each call from the wallet

const found = await a.call("search", { q: "x402 payment protocol adoption", count: 5 });
const answer = await a.call("answer", { q: "what is the x402 payment protocol?" });

console.log(found.results, answer.answer, answer.citations);</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<p class="qs-alt"><strong>No wallet yet?</strong> The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet:</p>
<div class="qs-code-wrap">
<pre><code>const free = new Agent402();  // no fetch: proof-of-work

const result = await free.call("hash", { text: "hello world", algo: "sha256" });
console.log(result);</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<div class="qs-next">
<div class="qs-next-title">What to try next</div>
<ul>
  <li>Use <code>a.find("geocode")</code> to search tools programmatically</li>
  <li>Set <code>maxPerCallUsd</code> and <code>dailyLimitUsd</code> on <code>new Agent402()</code> to cap what the wallet spends</li>
  <li>Enable <a href="/docs">idempotent retries</a> for production use</li>
</ul>
</div>
</div>

<!-- Panel: OpenAI / Anthropic / Vercel AI SDK -->
<div class="qs-panel" id="panel-models" role="tabpanel">
<h2>Use Agent402 as your model endpoint</h2>
<p class="qs-oneliner">Chat, the Anthropic Messages wire and embeddings, paid per request. The metered tier quotes each call from its own body.</p>

<span class="qs-label">Run the local wallet proxy (pays each call from your wallet over x402)</span>
<div class="qs-code-wrap">
<pre><code>npm i @x402/fetch @x402/evm viem
export AGENT402_WALLET_KEY=0x...      # an EVM key holding USDC on Base
export AGENT402_MAX_PER_CALL_USD=2    # per-call ceiling checked before signing
npx agent402-openclaw proxy           # serves http://127.0.0.1:8412/v1</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<span class="qs-label">Point any OpenAI SDK at it</span>
<div class="qs-code-wrap">
<pre><code>from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8412/v1", api_key="unused")
r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "hi"}])</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>
<p class="qs-alt">Every model id and its price: <code>GET https://agent402.tools/v1/models</code>. The proxy speaks the OpenAI wire; for Claude Code and other Anthropic-wire clients, and for every host's settings, see <a href="/guides/agent-hosts">the agent-hosts guide</a>.</p>
</div>

<div class="qs-panel" id="panel-ai" role="tabpanel">
<h2>Plug into any LLM framework</h2>
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
// same shape: agent402-anthropic-tools
// payFetch: the wallet-paying fetch from the Pay with USDC tab

// web search, then a cited answer: both paid per call from the wallet
const { tools, execute } = await agent402Tools({ slugs: ["search", "answer"], freeOnly: false, fetch: payFetch });

// pass tools to your LLM call, e.g. "search the web for x402 adoption, then answer: what is x402?"
// for each tool_call it returns, run:
const result = await execute(call.function.name, JSON.parse(call.function.arguments));

// agent402-ai-sdk returns four meta tools instead, keyed by name:
// const tools = await agent402Tools({ fetch: payFetch }); await generateText({ model, tools, prompt });</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<p class="qs-alt"><strong>No wallet yet?</strong> The pure-CPU tools (hash, uuid, base64, markdown, JSON and more) run free with proof-of-work and no wallet:</p>
<div class="qs-code-wrap">
<pre><code>// free tier: every compute-payable tool, paid with proof-of-work
const { tools, execute } = await agent402Tools({ slugs: ["hash", "markdown-to-html"] });</code></pre>
<button class="qs-copy" aria-label="Copy">Copy</button>
</div>

<div class="qs-next">
<div class="qs-next-title">What to try next</div>
<ul>
  <li>More wallet-only tools (extract, render, screenshot): add their slugs beside <code>freeOnly: false</code></li>
  <li>Combine with the <a href="/docs">MCP connector</a> for Claude-native integration</li>
  <li>See the <a href="/playground">playground</a> for live examples</li>
</ul>
</div>
</div>

<!-- Panel: Pay with USDC -->
<div class="qs-panel" id="panel-usdc" role="tabpanel">
<h2>Pay directly with ${RAILS_AMP.replaceAll("&", "&amp;")}</h2>
<p class="qs-oneliner">Use the x402 protocol for on-chain payment - no API keys, no accounts.</p>

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
client.setSpendControls?.(false); // @x402/core 2.23+ refuses anything over $1 or off the pegged-asset list by default; keep your own ceiling in code instead
registerExactEvmScheme(client, {
  signer: privateKeyToAccount(process.env.AGENT_KEY)
});
const payFetch = wrapFetchWithPayment(fetch, client);

// web search, then a cited answer: each call quoted by its 402, then paid and retried
const q = (s) => encodeURIComponent(s);
const found = await (await payFetch("https://agent402.tools/api/search?q=" + q("x402 payment protocol adoption") + "&amp;count=5")).json();
const answer = await (await payFetch("https://agent402.tools/api/answer?q=" + q("what is the x402 payment protocol?"))).json();

console.log(found.results, answer.answer, answer.citations);</code></pre>
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
</section>

<section>
<h2 class="sr-section">What to try next</h2>
<div class="qs-cards">
  <a class="qs-card" href="/tools">
    <h3>Browse 500+ tools</h3>
    <p>Search, filter, and preview every tool in the catalog.</p>
  </a>
  <a class="qs-card" href="/playground">
    <h3>Try it live</h3>
    <p>Run any tool interactively in the browser playground.</p>
  </a>
  <a class="qs-card" href="/docs">
    <h3>Read the docs</h3>
    <p>API reference, authentication, pricing, and advanced usage.</p>
  </a>
</div>
</section>

</div>
${ledgerFooterCompact()}

<script src="/js/quickstart-tabs.js"></script>
<script src="/js/copy-buttons.js"></script>`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/quickstart", extraCss, body });
}
