import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export const BLOG_POSTS = [
  {
    slug: "why-we-built-agent402",
    date: "2026-06-15",
    title: "Why we built Agent402",
    excerpt: "Agents need deterministic tools they can trust. We built Agent402 to give them exactly that — no API keys, no rate-limit games, just x402 micropayments for every call.",
    body: `<p>Most tool APIs were designed for human developers: sign up, get an API key, read the docs, handle auth, manage quotas. That friction is invisible to a person, but it's a wall for an autonomous agent.</p>

<p>We built Agent402 around a simple idea: <strong>every tool should be callable with a single HTTP request and a micropayment</strong>. No registration, no API keys, no OAuth flows. The x402 protocol makes this possible — the agent's wallet <em>is</em> its identity, and payment <em>is</em> authorization.</p>

<h2>Why deterministic?</h2>

<p>An agent that calls a tool needs to know what it will get back. If a "summarize" endpoint silently calls an LLM, the output varies on every call. That makes testing impossible, caching meaningless, and debugging a nightmare.</p>

<p>Every Agent402 tool is deterministic: same input, same output, every time. This means agents can cache results, retry safely, and CI can verify every tool automatically. Our test suite literally calls every tool with its example input and checks the response — 1,338 tools, zero LLM variance.</p>

<h2>Why x402 over API keys?</h2>

<p>API keys create a management burden. An agent operating across dozens of services needs dozens of keys, each with its own rate limits, billing dashboard, and revocation policy. x402 replaces all of that with a single mechanism:</p>

<ul>
  <li><strong>No signup.</strong> The agent sends a payment header with its request. Done.</li>
  <li><strong>No rate limits.</strong> You pay per call. Want to make 10,000 calls? Pay for 10,000 calls.</li>
  <li><strong>No vendor lock-in.</strong> x402 is an open protocol. Any server can accept it, any client can send it.</li>
  <li><strong>Micropayments that actually work.</strong> USDC on Base (and Solana, Polygon, Arbitrum) settles in seconds for fractions of a cent in gas.</li>
</ul>

<p>The result: an agent with a funded wallet can discover Agent402 tools via MCP, call them, and pay — all without a human ever creating an account.</p>

<h2>Open source, self-hostable</h2>

<p>Agent402 is MIT-licensed. You can run your own instance, add your own tools, set your own prices. The hosted version at <code>agent402.tools</code> is just one deployment of the same codebase that's on GitHub.</p>

<p>We think the future of agent infrastructure is open protocols, not walled gardens. x402 is the payment layer, MCP is the discovery layer, and Agent402 is the tool layer that ties them together.</p>`,
  },
  {
    slug: "proof-of-work-free-tier",
    date: "2026-06-17",
    title: "How the proof-of-work free tier works",
    excerpt: "Every pure-CPU tool on Agent402 is free if you solve a small proof-of-work challenge. Here's how it works, why we built it, and what it means for agents.",
    body: `<p>Agent402 has over a thousand tools, and most of them are pure CPU — no external API calls, no network I/O, just computation. Things like JSON formatting, hash generation, regex matching, unit conversion, and text analysis.</p>

<p>For these tools, we offer a <strong>proof-of-work free tier</strong>: instead of paying USDC, the caller solves a small computational challenge. It's the same idea as Hashcash (the precursor to Bitcoin mining), adapted for API access control.</p>

<h2>How it works</h2>

<ol>
  <li><strong>Request a challenge.</strong> The client sends a request without payment. The server responds with <code>402 Payment Required</code> and includes a PoW challenge in the response headers.</li>
  <li><strong>Solve the challenge.</strong> The client finds a nonce that, when combined with the challenge, produces a hash with a required number of leading zero bits. This takes roughly 50-200ms on modern hardware.</li>
  <li><strong>Submit the solution.</strong> The client re-sends the original request with the PoW solution in the headers. The server verifies the solution (instant) and serves the result.</li>
</ol>

<p>Each solution is <strong>single-use and slug-scoped</strong> — it can only be used once, and only for the specific tool it was issued for. This prevents replay attacks and solution-sharing across tools.</p>

<h2>Why proof-of-work?</h2>

<p>We wanted a free tier that didn't require registration or API keys (that would defeat the whole point of x402). PoW gives us three things:</p>

<ul>
  <li><strong>Abuse prevention.</strong> Solving a challenge has a real CPU cost, so bulk abuse is expensive even though the tools are "free."</li>
  <li><strong>No identity required.</strong> The caller doesn't need an account, email, or API key. Just compute the answer.</li>
  <li><strong>Fair access.</strong> Every caller pays the same cost — a few milliseconds of CPU time — regardless of who they are.</li>
</ul>

<h2>Browser-side solving</h2>

<p>The PoW challenge is designed to be solvable in the browser using Web Crypto. The <code>agent402-client</code> SDK handles this automatically — it detects a 402 response, solves the challenge, and retries, all transparently. For agents using the MCP integration, the hosted server at <code>/mcp</code> handles PoW internally.</p>

<h2>Which tools are free?</h2>

<p>Any tool that runs purely on the server's CPU without making external network requests is PoW-eligible. Tools that call upstream APIs (web search, rendering, geocoding) require payment because they have a real marginal cost. The tool catalog marks each tool's pricing — <code>$0.000</code> means PoW-eligible.</p>`,
  },
  {
    slug: "1000-tools-milestone",
    date: "2026-06-20",
    title: "1,000 tools and counting",
    excerpt: "Agent402 crossed 1,000 deterministic tools this week. Here's what categories exist, how we got here, and what's coming next.",
    body: `<p>This week Agent402 crossed 1,000 tools in the catalog. Every one of them is deterministic, tested in CI, and callable with a single HTTP request. Here's a look at what's in the box.</p>

<h2>What categories exist</h2>

<p>The catalog spans 30+ categories, grouped into "kits" — each kit is a focused collection of related tools:</p>

<ul>
  <li><strong>Data processing:</strong> JSON, CSV, XML, YAML, TOML manipulation and validation</li>
  <li><strong>Web tools:</strong> rendering, scraping, extraction, link checking, sitemap parsing</li>
  <li><strong>Search:</strong> web search, news, images, suggestions, and cited answers (via Brave)</li>
  <li><strong>Finance:</strong> stock quotes, history, company research, SEC filings, earnings data</li>
  <li><strong>Crypto &amp; DeFi:</strong> token prices, TVL, wallet balances, ENS resolution, gas prices</li>
  <li><strong>Government data:</strong> FRED economic indicators, Treasury rates, BLS statistics</li>
  <li><strong>PDF processing:</strong> PDF to markdown, text extraction, metadata, page counting</li>
  <li><strong>Media:</strong> image conversion, audio transcription metadata, video info</li>
  <li><strong>Barcode &amp; QR:</strong> generation and reading for multiple barcode formats</li>
  <li><strong>Security:</strong> DNS lookup, TLS certificate info, WHOIS, HTTP headers, SPF checks</li>
  <li><strong>Encoding:</strong> base64, hex, URL encoding, punycode, NATO phonetic, Soundex</li>
  <li><strong>Math &amp; stats:</strong> statistical summaries, correlation, regression, prime checks, GCD/LCM</li>
  <li><strong>Hashing:</strong> SHA-256, MD5, HMAC, PBKDF2, scrypt, HKDF, checksums</li>
  <li><strong>Text &amp; string:</strong> diff, similarity, word frequency, case conversion, word wrap</li>
  <li><strong>Agent memory:</strong> wallet-keyed persistent storage (read, write, list, delete)</li>
</ul>

<h2>How we got here</h2>

<p>We started with 50 tools in the first week. The approach was simple: pick a category, build 5-10 tools that cover the common tasks, write the CI test for each, and ship. Each kit follows the same pattern — a single file that exports an array of tool definitions with handlers.</p>

<p>The constraint that kept quality high: <strong>every tool must answer its own example input correctly in CI</strong>. No exceptions. If a tool can't pass that bar, it doesn't ship.</p>

<h2>What's coming next</h2>

<p>We're continuing to expand the catalog based on what agents actually request (tracked via the <code>/api/find</code> endpoint). The most-searched-for capabilities that don't yet have tools get built first. Current priorities include more data transformation tools, additional financial data sources, and deeper government data coverage.</p>

<p>The catalog is also now registered on the Coinbase CDP Bazaar, making Agent402 tools discoverable by any x402-compatible agent through the Bazaar's marketplace API.</p>`,
  },
  {
    slug: "building-with-mcp",
    date: "2026-06-22",
    title: "Building with MCP: Claude Code, hosted, and npm",
    excerpt: "Agent402 speaks MCP natively. Here's how to connect it to Claude Code, use the hosted endpoint, or run the npm package locally.",
    body: `<p>The <a href="https://modelcontextprotocol.io">Model Context Protocol</a> (MCP) is the emerging standard for how AI agents discover and call tools. Agent402 supports MCP in three ways: a hosted HTTP endpoint, an npm package for local use, and direct integration with Claude Code.</p>

<h2>Hosted MCP endpoint</h2>

<p>The simplest way to connect: point your MCP client at <code>https://agent402.tools/mcp</code>. This endpoint exposes four tools:</p>

<ul>
  <li><strong>search_tools</strong> — find tools by keyword or task description</li>
  <li><strong>find_tool</strong> — resolve a specific tool by name or slug</li>
  <li><strong>call_tool</strong> — execute any tool with input parameters</li>
  <li><strong>about_agent402</strong> — get platform info and capabilities</li>
</ul>

<p>The hosted endpoint handles PoW challenges internally, so pure-CPU tools are effectively free through MCP. Paid tools require an x402 payment header on the <code>call_tool</code> request.</p>

<h2>Claude Code setup</h2>

<p>To add Agent402 to Claude Code, add this to your MCP configuration:</p>

<pre><code>{
  "mcpServers": {
    "agent402": {
      "url": "https://agent402.tools/mcp"
    }
  }
}</code></pre>

<p>Once connected, Claude Code can search through all 1,338 tools, find the right one for a task, and call it — all through the standard MCP protocol. The <code>search_tools</code> and <code>find_tool</code> commands help the agent discover relevant tools without needing to know the full catalog.</p>

<h2>npm package (local / stdio)</h2>

<p>For local development or air-gapped environments, install the <code>agent402-mcp</code> npm package:</p>

<pre><code>npm install -g agent402-mcp</code></pre>

<p>Then configure it as a stdio MCP server in your client:</p>

<pre><code>{
  "mcpServers": {
    "agent402": {
      "command": "agent402-mcp",
      "args": []
    }
  }
}</code></pre>

<p>The npm package bundles the same tool definitions and connects to the hosted API for execution. It works with any MCP client that supports stdio transport — Claude Code, Cline, Continue, and others.</p>

<h2>Framework adapters</h2>

<p>Beyond MCP, we publish framework-specific adapters for direct integration: OpenAI, Anthropic SDK, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents, and AWS Strands. Each adapter wraps Agent402 tools in the framework's native tool format, so you can drop them into existing agent code without protocol translation.</p>

<p>All adapters and the MCP package are open source and published on npm. Check the <a href="https://github.com/MikeyPetrillo/Agent402">GitHub repo</a> for the latest versions.</p>`,
  },
];

export function blogIndex(baseUrl) {
  const canonical = `${baseUrl}/blog`;
  const pageTitle = "Blog — Agent402";
  const pageDesc = "News, deep-dives, and announcements from the Agent402 project — deterministic tools, x402 payments, and MCP integrations for autonomous agents.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: pageTitle,
    description: pageDesc,
    url: canonical,
    isPartOf: { "@type": "WebSite", url: baseUrl },
    blogPost: BLOG_POSTS.map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      datePublished: p.date,
      url: `${baseUrl}/blog/${p.slug}`,
      description: p.excerpt,
    })),
  };

  const cards = BLOG_POSTS.slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((p) => `
      <a href="/blog/${esc(p.slug)}" class="blog-card">
        <span class="blog-date">${esc(p.date)}</span>
        <h2>${esc(p.title)}</h2>
        <p class="blog-excerpt">${esc(p.excerpt)}</p>
        <span class="blog-read">Read more</span>
      </a>`)
    .join("\n");

  const extraCss = `
.bl-wrap{max-width:1180px;margin:0 auto;padding:56px 30px;}
.bl-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;}
.bl-wrap h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;}
.bl-desc{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px;max-width:640px;}
.blog-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;}
@media(max-width:700px){.blog-grid{grid-template-columns:1fr;}}
.blog-card{display:block;background:var(--card);border:1.5px solid var(--ink);padding:24px 26px;text-decoration:none;transition:border-color .2s;}
.blog-card:hover{border-color:var(--accent);}
.blog-date{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:6px;}
.blog-card h2{font-family:var(--font-body);font-weight:800;font-size:20px;line-height:1.15;letter-spacing:-.02em;margin:4px 0 12px;color:var(--ink);}
.blog-excerpt{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 14px;}
.blog-read{font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:700;}
@media(max-width:600px){.bl-wrap h1{font-size:40px;}}
`;

  const body = `<div class="bl-wrap">
  <div class="bl-eyebrow">$ GET /blog</div>
  <h1>Blog</h1>
  <p class="bl-desc">${esc(pageDesc)}</p>
  <div class="blog-grid">
${cards}
  </div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}

export function blogPost(baseUrl, slug) {
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) return null;

  const canonical = `${baseUrl}/blog/${post.slug}`;
  const pageTitle = `${post.title} — Agent402 Blog`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    url: canonical,
    author: { "@type": "Organization", name: "Agent402.Tools", url: baseUrl },
    isPartOf: { "@type": "Blog", name: "Agent402.Tools Blog", url: `${baseUrl}/blog` },
  };

  const extraCss = `
.bp-wrap{max-width:760px;margin:0 auto;padding:56px 30px 48px;}
.bp-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;}
.bp-crumb{font-family:var(--font-mono);font-size:13px;color:var(--faint);margin-bottom:20px;}
.bp-crumb a{color:var(--accent);text-decoration:none;}
.bp-crumb a:hover{text-decoration:underline;}
.bp-date{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:6px;}
.bp-wrap h1{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:4px 0 28px;color:var(--ink);}
.post-body{font-size:15px;line-height:1.55;color:var(--muted);}
.post-body h2{font-family:var(--font-body);font-weight:800;font-size:22px;line-height:1.1;letter-spacing:-.02em;color:var(--ink);margin:32px 0 12px;}
.post-body p{margin:0 0 16px;}
.post-body ul,.post-body ol{margin:0 0 16px;padding-left:24px;}
.post-body li{margin-bottom:6px;}
.post-body strong{color:var(--ink);}
.post-body code{font-family:var(--font-mono);font-size:13px;background:var(--card);border:1px solid var(--hairline);padding:2px 6px;}
.post-body pre{background:var(--ink);color:var(--cream);font-family:var(--font-mono);font-size:13px;line-height:1.55;padding:16px 20px;overflow-x:auto;margin:0 0 16px;border:1.5px solid var(--ink);}
.post-body pre code{background:none;border:none;padding:0;color:inherit;font-size:13px;}
.post-body a{color:var(--accent);text-decoration:none;}
.post-body a:hover{text-decoration:underline;}
.bp-back{display:inline-block;margin-top:28px;font-family:var(--font-mono);font-size:13px;color:var(--accent);text-decoration:none;font-weight:700;}
.bp-back:hover{text-decoration:underline;}
`;

  const body = `<div class="bp-wrap">
  <div class="bp-crumb"><a href="/">Home</a> / <a href="/blog">Blog</a> / ${esc(post.title)}</div>
  <span class="bp-date">${esc(post.date)}</span>
  <h1>${esc(post.title)}</h1>
  <div class="post-body">
    ${post.body}
  </div>
  <a href="/blog" class="bp-back">Back to blog</a>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: post.excerpt, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}
