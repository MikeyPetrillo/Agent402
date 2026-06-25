import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function contributePage(baseUrl) {
  const canonical = `${baseUrl}/contribute`;
  const title = "Contribute to Agent402 — add tools, guides, and skill packs";
  const description =
    "A contributor guide for Agent402: how to add a tool kit, write a guide, or submit a skill pack.";

  const extraCss = `
.ct-wrap{max-width:860px;margin:0 auto;padding:56px 30px}
.ct-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.ct-title{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 10px}
.ct-subtitle{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px}

.ct-section{margin-bottom:48px}
.ct-section h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 12px;color:var(--ink)}
.ct-section h3{font-family:var(--font-body);font-weight:800;font-size:20px;margin:24px 0 8px;color:var(--ink)}
.ct-section p{color:var(--muted);margin:0 0 12px;font-size:15px;line-height:1.55}
.ct-section ul,.ct-section ol{margin:0 0 16px;padding:0 0 0 22px;font-size:15px;line-height:1.55;color:var(--muted)}
.ct-section li{margin-bottom:6px}
.ct-section li code{font-family:var(--font-mono);background:var(--ink);color:var(--cream);padding:2px 7px;font-size:13px;border:1.5px solid var(--ink)}

.ct-code-wrap{position:relative;margin-bottom:24px}
.ct-code-wrap pre{background:var(--ink);border:1.5px solid var(--ink);padding:20px;overflow-x:auto;margin:0;font-family:var(--font-mono);font-size:13px;line-height:1.55;color:var(--cream)}
.ct-code-wrap .ct-copy{position:absolute;top:8px;right:8px;background:var(--ink);border:1.5px solid var(--cream);color:var(--cream);font-family:var(--font-mono);font-size:11px;padding:4px 10px;cursor:pointer;transition:all .15s}
.ct-code-wrap .ct-copy:hover{background:var(--cream);color:var(--ink)}
.ct-code-wrap .ct-copy.copied{color:var(--accent);border-color:var(--accent)}

.ct-label{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--faint);margin-bottom:8px}

.ct-note{background:var(--card);border:1.5px solid var(--ink);padding:18px 22px;margin:16px 0 24px;font-size:14px;line-height:1.55;color:var(--muted)}
.ct-note strong{color:var(--accent);font-weight:700}

.ct-divider{border:none;border-top:1.5px solid var(--ink);margin:40px 0}

.ct-bottom{background:var(--card);border:1.5px solid var(--ink);padding:32px;text-align:center;margin-top:48px}
.ct-bottom h3{font-family:var(--font-body);font-weight:800;font-size:24px;margin:0 0 12px;color:var(--ink)}
.ct-bottom p{color:var(--muted);font-size:15px;line-height:1.55;margin:0 0 6px}
.ct-bottom a{color:var(--accent);text-decoration:none}
.ct-bottom a:hover{text-decoration:underline}

@media(max-width:600px){
  .ct-title{font-size:36px !important}
}
`;

  const body = `
<div class="ct-wrap">

<div class="ct-eyebrow">$ GET /contribute</div>
<h1 class="ct-title">Contribute to Agent402</h1>
<p class="ct-subtitle">Add a tool kit, write a guide, or submit a skill pack. Every contribution ships to 1,323+ tools that agents pay for per call.</p>

<!-- Section 1: Add a tool kit -->
<div class="ct-section">
<h2>Add a tool kit</h2>
<p>A tool kit is a JavaScript file in <code>src/tools/</code> that exports an array of tool objects. Each tool is a self-contained, deterministic function &mdash; no LLM in the serving path.</p>

<h3>Step 1 &mdash; Create the file</h3>
<p>Add a new file in <code>src/tools/</code>, for example <code>my-kit.js</code>. Export a named array of tool objects:</p>

<span class="ct-label">src/tools/my-kit.js</span>
<div class="ct-code-wrap">
<pre><code>// my-kit.js — example tool kit
export const MY_TOOLS = [
  {
    route: "POST /api/reverse-string",
    name: "Reverse string",
    slug: "reverse-string",
    category: "text",
    price: "$0.001",
    description:
      "Reverse the characters in a string. Deterministic, pure-CPU.",
    tags: ["text", "string", "reverse"],
    discovery: {
      bodyType: "json",
      input: { text: "hello world" },
      inputSchema: {
        properties: {
          text: {
            type: "string",
            description: "The string to reverse",
          },
        },
        required: ["text"],
      },
      output: {
        example: { reversed: "dlrow olleh" },
      },
    },
    handler: (input) =&gt; {
      if (typeof input.text !== "string" || !input.text) {
        const err = new Error('Missing "text"');
        err.statusCode = 400;
        throw err;
      }
      return { reversed: [...input.text].reverse().join("") };
    },
  },
];</code></pre>
<button class="ct-copy" aria-label="Copy">Copy</button>
</div>

<h3>Step 2 &mdash; Wire it into the server</h3>
<p>Open <code>src/server.js</code>, add the import, and spread the array into <code>ALL_KIT</code>:</p>

<span class="ct-label">src/server.js</span>
<div class="ct-code-wrap">
<pre><code>import { MY_TOOLS } from "./tools/my-kit.js";

const ALL_KIT = [...KIT, ...KIT2, /* ... existing kits ... */ ...MY_TOOLS];</code></pre>
<button class="ct-copy" aria-label="Copy">Copy</button>
</div>

<h3>Step 3 &mdash; Test</h3>
<p>Every tool must pass the "answers its own example" CI check. Run the test suite locally:</p>

<div class="ct-code-wrap">
<pre><code># Boot the server in free mode
FREE_MODE=true PORT=3000 node src/server.js

# In another terminal, run all tool tests
TARGET_URL=http://localhost:3000 node scripts/test-all.js</code></pre>
<button class="ct-copy" aria-label="Copy">Copy</button>
</div>

<div class="ct-note">
<strong>Key rules:</strong> Tools must be deterministic &mdash; same input, same output, every time. No LLM calls, no non-deterministic dependencies. Pure-CPU tools are automatically eligible for the free proof-of-work tier. Tools that make external network requests must be added to <code>WALLET_ONLY_SLUGS</code> in <code>src/pow.js</code>.
</div>

<h3>Tool object shape</h3>
<p>Every tool in the array needs these fields:</p>
<ul>
  <li><code>route</code> &mdash; HTTP method and path, e.g. <code>"POST /api/my-tool"</code></li>
  <li><code>name</code> &mdash; human-readable name</li>
  <li><code>slug</code> &mdash; URL-safe identifier, unique across the catalog</li>
  <li><code>category</code> &mdash; one of the existing categories (text, data, web, finance, etc.)</li>
  <li><code>price</code> &mdash; USDC price string, e.g. <code>"$0.001"</code></li>
  <li><code>description</code> &mdash; what the tool does, one or two sentences</li>
  <li><code>tags</code> &mdash; array of lowercase keyword strings for discovery</li>
  <li><code>discovery.inputSchema</code> &mdash; JSON Schema describing the input</li>
  <li><code>discovery.input</code> &mdash; example input (used by CI to test the tool)</li>
  <li><code>handler(input)</code> &mdash; function that returns JSON or throws an <code>Error</code> with <code>.statusCode</code></li>
</ul>
</div>

<hr class="ct-divider">

<!-- Section 2: Write a guide -->
<div class="ct-section">
<h2>Write a guide</h2>
<p>Guides are Markdown files that get rendered as pages on the site and synced to the GitHub wiki. They target humans searching for topics like "x402 payment example" or "AI agent tool payments."</p>

<h3>Where guides live</h3>
<p>Guides are defined in <code>src/guides.js</code>. Each guide has a <code>slug</code>, <code>title</code>, <code>description</code>, and <code>md</code> (Markdown content). The wiki directory (<code>wiki/</code>) contains the GitHub wiki source files, which CI syncs automatically.</p>

<h3>Adding a guide</h3>
<ol>
  <li>Add a new entry to the <code>GUIDES</code> array in <code>src/guides.js</code> with your slug, title, description, and Markdown content.</li>
  <li>If you want it in the GitHub wiki too, create a matching <code>wiki/Your-Guide-Title.md</code> file and add it to <code>wiki/_Sidebar.md</code>.</li>
  <li>Use standard Markdown: headings, code blocks (with language tags), inline code, lists, links.</li>
  <li>Link to tools by path: <code>/tools/hash</code>. Link to other guides: <code>/guides/your-slug</code>.</li>
</ol>

<span class="ct-label">Guide format in src/guides.js</span>
<div class="ct-code-wrap">
<pre><code>{
  slug: "my-guide",
  title: "How to do X with Agent402",
  description: "A practical walkthrough of doing X.",
  md: \`
## Introduction

Your Markdown content goes here.

\\\`\\\`\\\`bash
curl -X POST https://agent402.tools/api/my-tool \\\\
  -H "Content-Type: application/json" \\\\
  -d '{"text":"hello"}'
\\\`\\\`\\\`
  \`,
}</code></pre>
<button class="ct-copy" aria-label="Copy">Copy</button>
</div>

<span class="ct-label">wiki/ file format</span>
<div class="ct-code-wrap">
<pre><code># Your Guide Title

Standard Markdown. CI syncs this to the GitHub wiki automatically.

## Sections

Use ## for top-level sections within the guide.

## See also

- [[Getting Started]]
- [[Tool Catalog]]</code></pre>
<button class="ct-copy" aria-label="Copy">Copy</button>
</div>
</div>

<hr class="ct-divider">

<!-- Section 3: Submit a skill pack -->
<div class="ct-section">
<h2>Submit a skill pack</h2>
<p>A skill pack is a curated, multi-tool workflow that solves a job no single tool covers. Instead of guessing which tools to call, the agent gets a ready-to-run plan with the right tools wired in the right order.</p>

<h3>How skill packs work</h3>
<p>Skill packs are defined in <code>src/skills.js</code> in the <code>SKILL_PACKS</code> array. Each pack is both a server-rendered page at <code>/skills/&lt;slug&gt;</code> and an MCP prompt template that agents discover via <code>prompts/list</code>. Payment only happens when the agent actually calls each tool &mdash; the template itself is free.</p>

<h3>Pack shape</h3>
<p>A skill pack has these fields:</p>
<ul>
  <li><code>slug</code> &mdash; URL-safe identifier, e.g. <code>"security-audit"</code></li>
  <li><code>title</code> &mdash; human-readable name</li>
  <li><code>tagline</code> &mdash; one-sentence summary of what the pack solves</li>
  <li><code>useCase</code> &mdash; when to reach for this pack</li>
  <li><code>promptArgs</code> &mdash; array of <code>{ name, description, required, substitute }</code> arguments</li>
  <li><code>toolSlugs</code> &mdash; ordered array of tool slugs the pack orchestrates</li>
  <li><code>workflow</code> &mdash; array of strings, one per step, describing what each tool contributes</li>
  <li><code>claudePrompt</code> &mdash; a copy-pastable Claude prompt that exercises the pack</li>
</ul>

<span class="ct-label">Example skill pack in src/skills.js</span>
<div class="ct-code-wrap">
<pre><code>{
  slug: "domain-health",
  title: "Domain health check",
  tagline:
    "Quick health check on a domain: DNS, TLS cert, HTTP headers.",
  useCase:
    "You want to verify a domain is properly configured before launch.",
  promptArgs: [
    {
      name: "domain",
      description: "Domain to check (e.g. example.com)",
      required: true,
      substitute: "example.com",
    },
  ],
  toolSlugs: ["dns-lookup", "tls-cert", "http-headers"],
  workflow: [
    "Resolve DNS records (A, AAAA, MX, NS) to confirm the domain is live.",
    "Inspect the TLS certificate for expiry, SANs, and chain issues.",
    "Fetch HTTP response headers and score security posture.",
  ],
  claudePrompt:
    "Check the health of example.com. Use Agent402 to: (1) resolve DNS, "
    + "(2) inspect the TLS cert, (3) check HTTP security headers. "
    + "Summarize any issues found.",
}</code></pre>
<button class="ct-copy" aria-label="Copy">Copy</button>
</div>

<h3>Testing skill packs</h3>
<p>Skill packs are validated by <code>scripts/test-mcp-all.js</code>, which checks that <code>prompts/list</code> returns all packs and <code>prompts/get</code> renders each one without errors. The underlying tools are covered by the standard <code>test-all.js</code> suite.</p>

<div class="ct-code-wrap">
<pre><code># Boot the server and run the MCP test suite
FREE_MODE=true PORT=3000 node src/server.js
TARGET_URL=http://localhost:3000 node scripts/test-mcp-all.js</code></pre>
<button class="ct-copy" aria-label="Copy">Copy</button>
</div>

<div class="ct-note">
<strong>Tip:</strong> Every tool slug in <code>toolSlugs</code> must exist in the catalog. The page renderer shows a "missing" placeholder for dead references, and CI will catch it. Use <code>/api/find?q=&lt;task&gt;</code> to discover existing tool slugs.
</div>
</div>

<hr class="ct-divider">

<!-- Bottom: Questions? -->
<div class="ct-bottom">
<h3>Questions?</h3>
<p>Open an issue on <a href="https://github.com/MikeyPetrillo/Agent402/issues">GitHub Issues</a> for bugs, feature requests, or contribution questions.</p>
<p>Browse the <a href="/guides">Guides</a> for walkthroughs, or check the <a href="/docs">Docs</a> for the full API reference.</p>
</div>

</div>
${ledgerFooterCompact()}

<script>
(function(){
  document.querySelectorAll(".ct-copy").forEach(function(btn){
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

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "/contribute", extraCss, body });
}
