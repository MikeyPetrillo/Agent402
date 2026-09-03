import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export const BLOG_POSTS = [
  {
    slug: "what-is-agentic-finance-aifi",
    date: "2026-08-18",
    title: "Agentic Finance (AIFI): the economy that forms once agents can pay",
    excerpt: "Agentic payments are the wire. Agentic Finance is what forms on top of it: agents discovering services, paying per request from their own wallets over x402 or MPP, receiving receipts, and earning per request in return. What the term means, what one purchase looks like, and where Agent402 sits.",
    body: `<p><strong>Agentic Finance (AIFI)</strong> is software agents transacting on their own: discovering a service, reading a machine-readable price, paying per request from a non-custodial wallet over an open protocol, receiving a verifiable receipt, and, on the other side, earning per request for what they serve. No accounts, no API keys, no invoices. The payment is the identity and every settlement is on a public ledger.</p>

<p>We use the term deliberately, and this post is the long form of the <a href="/agentic-finance">category page</a>: what it means, why it is different from the two phrases it gets confused with, what a single purchase actually looks like on the wire, and where Agent402 sits in it.</p>

<h2>Three phrases that are not the same thing</h2>

<ul>
  <li><strong>Agentic payments</strong> is the plumbing: a wire format that lets one program pay another per request. HTTP 402 names a price, the client answers with a signed stablecoin payment, the server verifies, settles and delivers. <a href="/what-is-x402">x402</a> and <a href="/what-is-mpp">MPP</a> are the two open, HTTP-native standards for it.</li>
  <li><strong>Agentic commerce</strong> usually means agents buying goods for humans through checkout flows: a shopping assistant completing a purchase a person asked for, with a card on file and a human ultimately approving.</li>
  <li><strong>Agentic finance</strong> is the machine-to-machine economy that forms on top of the plumbing once thousands of agents and sellers transact: price discovery, routing between competing sellers, reliability signals, spend controls, receipts, and transparent revenue - operated by and for autonomous software.</li>
</ul>

<p>The practical test, borrowed from <a href="/what-is-x402#agentic">the x402 explainer</a>: could the software complete the purchase with no human awake? If a human has to approve, register, or paste a key, it is not agentic. Agentic finance is the same test applied to a whole market rather than to one payment.</p>

<h2>What one purchase looks like</h2>

<p>An agent working a real task needs something it cannot answer from memory: a live page, a filing, a conversion, an address on a chain. It sends a plain HTTP request. The server answers <code>402 Payment Required</code> and, in the response headers, quotes a price: which asset, which chain, which recipient, how much, valid until when. On x402 that quote is a <code>PAYMENT-REQUIRED</code> header; on MPP it is a <code>WWW-Authenticate: Payment</code> challenge. A dual-stack server carries both on the same 402 at the same price.</p>

<p>The agent's wallet signs an authorization for exactly that amount - on the EVM rails an <a href="/glossary#eip-3009">EIP-3009</a> authorization, so it pays no gas and its key never leaves the client - and repeats the identical request with the credential attached. The server verifies it, runs the tool, settles the payment on chain through a <a href="/glossary#facilitator">facilitator</a> (or, for MPP's native Tempo method, through Tempo's relay), and returns the answer with a <a href="/glossary#payment-receipt">receipt</a> that ties this payment to this response.</p>

<p>Two round trips, a couple of seconds, a fraction of a cent. Nothing to sign up for means nothing to leak, and one receipt per call means an agent's spend is legible line by line.</p>

<h2>The four layers</h2>

<ol>
  <li><strong>Agents.</strong> Autonomous software with a wallet: MCP-connected assistants, crawlers, research and trading agents, other services' agents. The buyers and, increasingly, the sellers.</li>
  <li><strong>The applied layer.</strong> Discovery, routing, pricing, reliability, receipts, transparency. Where an agent finds the right service and pays it once, safely.</li>
  <li><strong>Payment protocols.</strong> x402 and MPP. Open, HTTP-native, wallet as identity.</li>
  <li><strong>Rails and money.</strong> Stablecoins settled on public chains: USDC across the EVM chains plus Solana, Stellar and Algorand; USDG on Robinhood Chain; native Tempo.</li>
</ol>

<p>The interesting problems live in the second layer. A wire format tells you how to pay one seller you already trust. It says nothing about which of a dozen sellers to pay, whether that seller has ever actually delivered, what happens when a paid call fails, or how anyone can check the numbers a marketplace publishes about itself. Those are finance questions, and they only appear once the payments layer works.</p>

<h2>Where Agent402 sits</h2>

<p>Agent402 is built as the applied layer, and every piece of it is live on both wires:</p>

<ul>
  <li><strong>Buy:</strong> a catalog of 500+ pay-per-call tools - search, browser rendering, PDFs, OCR, financial and chain data, an OpenAI-compatible LLM gateway - each priced, tested against its own example in CI, and settled on chain over x402 or MPP. <a href="/tools">Browse the catalog</a>.</li>
  <li><strong>Route:</strong> an open <a href="/marketplace">cross-seller index</a> and a <a href="/guides/smart-order-router">Smart Order Router</a> that resolves a task to the best seller across the ecosystem - ours or anyone's - pays them on the agent's behalf on the same chain the agent paid on, and relays the result with a receipt. Only sellers with proven on-chain settlement are routable.</li>
  <li><strong>Sell:</strong> the open-source <a href="/sell">tollbooth</a> that lets any site or API charge agents per request over both wires while humans browse free. Non-custodial, no signup.</li>
  <li><strong>Prove:</strong> <a href="/revenue">live transactions</a> by rail and by wire (external revenue too), every figure linked to its on-chain receipt, an on-chain seller leaderboard, uptime measured from outside, and a ledger for the rare charged-but-failed call so it is refunded rather than forgotten.</li>
</ul>

<p>Settlement ordering is the detail we care most about, because it is where a marketplace can quietly cheat its buyers: Agent402 runs the tool first and settles only on a successful response, so a failed call is never charged. A daily canary buys real tools over both x402 and MPP so the claim is re-proven on mainnet rather than asserted once.</p>

<h2>Do agents need crypto to take part?</h2>

<p>To pay, an agent needs a wallet holding a stablecoin on a supported chain; gas is sponsored on the EVM rails, so no native token is required. Agent402 also keeps a <a href="/blog/proof-of-work-free-tier">free tier</a>: pure-CPU tools are payable with a short proof-of-work solve instead of money, so an agent without a wallet still has a path through. To sell, you need an endpoint and a wallet address to receive into. That is the whole onboarding.</p>

<h2>Where to go next</h2>

<ul>
  <li>The <a href="/agentic-finance">Agentic Finance (AIFI)</a> category page, with the definition, the stack and the FAQ.</li>
  <li>The <a href="/glossary">glossary</a>: every term above - 402, facilitator, EIP-3009, receipt, settlement, rails, dual-stack, PoW tier, SOR, tollbooth - defined once, each with its own anchor.</li>
  <li><a href="/what-is-x402">What is x402?</a> and <a href="/what-is-mpp">What is MPP?</a> for the two wires in depth.</li>
  <li><a href="/docs#add">Add Agent402 to your agent</a>, or <a href="/sell">put a price on your own API</a>. Both are free to start.</li>
</ul>`,
  },
  {
    slug: "why-we-built-agent402",
    date: "2026-06-15",
    title: "Why we built Agent402",
    excerpt: "Agents need deterministic tools they can trust. We built Agent402 to give them exactly that - no API keys, no rate-limit games, just x402 micropayments for every call.",
    body: `<p>Most tool APIs were designed for human developers: sign up, get an API key, read the docs, handle auth, manage quotas. That friction is invisible to a person, but it's a wall for an autonomous agent.</p>

<p>We built Agent402 around a simple idea: <strong>every tool should be callable with a single HTTP request and a micropayment</strong>. No registration, no API keys, no OAuth flows. The x402 protocol makes this possible - the agent's wallet <em>is</em> its identity, and payment <em>is</em> authorization.</p>

<h2>Why deterministic?</h2>

<p>An agent that calls a tool needs to know what it will get back. If a "summarize" endpoint silently calls an LLM, the output varies on every call. That makes testing impossible, caching meaningless, and debugging a nightmare.</p>

<p>Every Agent402 tool is deterministic: same input, same output, every time. This means agents can cache results, retry safely, and CI can verify every tool automatically. Our test suite literally calls every tool with its example input and checks the response - 500+ tools, zero LLM variance.</p>

<h2>Why x402 over API keys?</h2>

<p>API keys create a management burden. An agent operating across dozens of services needs dozens of keys, each with its own rate limits, billing dashboard, and revocation policy. x402 replaces all of that with a single mechanism:</p>

<ul>
  <li><strong>No signup.</strong> The agent sends a payment header with its request. Done.</li>
  <li><strong>No rate limits.</strong> You pay per call. Want to make 10,000 calls? Pay for 10,000 calls.</li>
  <li><strong>No vendor lock-in.</strong> x402 is an open protocol. Any server can accept it, any client can send it.</li>
  <li><strong>Micropayments that actually work.</strong> USDC on Base (and Solana, Polygon, Arbitrum, Stellar - plus USDG on Robinhood Chain) settles in seconds for fractions of a cent in gas.</li>
</ul>

<p>The result: an agent with a funded wallet can discover Agent402 tools via MCP, call them, and pay - all without a human ever creating an account.</p>

<h2>Open source, self-hostable</h2>

<p>Agent402 is AGPL-3.0-licensed (the buyer SDK, MCP connector, and tollbooth stay MIT). You can run your own instance, add your own tools, set your own prices. The hosted version at <code>agent402.tools</code> is just one deployment of the same codebase that's on GitHub.</p>

<p>We think the future of agent infrastructure is open protocols, not walled gardens. x402 is the payment layer, MCP is the discovery layer, and Agent402 is the tool layer that ties them together.</p>`,
  },
  {
    slug: "proof-of-work-free-tier",
    date: "2026-06-17",
    title: "How the proof-of-work free tier works",
    excerpt: "Every pure-CPU tool on Agent402 is free if you solve a small proof-of-work challenge. Here's how it works, why we built it, and what it means for agents.",
    body: `<p>Agent402 has over a thousand tools, and most of them are pure CPU - no external API calls, no network I/O, just computation. Things like JSON formatting, hash generation, regex matching, unit conversion, and text analysis.</p>

<p>For these tools, we offer a <strong>proof-of-work free tier</strong>: instead of paying USDC, the caller solves a small computational challenge. It's the same idea as Hashcash (the precursor to Bitcoin mining), adapted for API access control.</p>

<h2>How it works</h2>

<ol>
  <li><strong>Request a challenge.</strong> The client sends a request without payment. The server responds with <code>402 Payment Required</code> and includes a PoW challenge in the response headers.</li>
  <li><strong>Solve the challenge.</strong> The client finds a nonce that, when combined with the challenge, produces a hash with a required number of leading zero bits. This takes roughly 50-200ms on modern hardware.</li>
  <li><strong>Submit the solution.</strong> The client re-sends the original request with the PoW solution in the headers. The server verifies the solution (instant) and serves the result.</li>
</ol>

<p>Each solution is <strong>single-use and slug-scoped</strong> - it can only be used once, and only for the specific tool it was issued for. This prevents replay attacks and solution-sharing across tools.</p>

<h2>Why proof-of-work?</h2>

<p>We wanted a free tier that didn't require registration or API keys (that would defeat the whole point of x402). PoW gives us three things:</p>

<ul>
  <li><strong>Abuse prevention.</strong> Solving a challenge has a real CPU cost, so bulk abuse is expensive even though the tools are "free."</li>
  <li><strong>No identity required.</strong> The caller doesn't need an account, email, or API key. Just compute the answer.</li>
  <li><strong>Fair access.</strong> Every caller pays the same cost - a few milliseconds of CPU time - regardless of who they are.</li>
</ul>

<h2>Browser-side solving</h2>

<p>The PoW challenge is designed to be solvable in the browser using Web Crypto. The <code>agent402-client</code> SDK handles this automatically - it detects a 402 response, solves the challenge, and retries, all transparently. For agents using the MCP integration, the hosted server at <code>/mcp</code> handles PoW internally.</p>

<h2>Which tools are free?</h2>

<p>Any tool that runs purely on the server's CPU without making external network requests is PoW-eligible. Tools that call upstream APIs (web search, rendering, geocoding) require payment because they have a real marginal cost. The tool catalog marks each tool's pricing - <code>$0.000</code> means PoW-eligible.</p>`,
  },
  {
    slug: "catalog-milestone",
    date: "2026-06-20",
    title: "500+ tools and counting",
    excerpt: "The Agent402 catalog passed the 500-tool mark - every one deterministic, tested in CI, callable with one HTTP request. What categories exist, how we got here, and what's coming next.",
    body: `<p>The Agent402 catalog passed the 500-tool mark. Every one of those tools is deterministic, tested in CI, and callable with a single HTTP request. Here's a look at what's in the box.</p>

<p><em>Note (updated 2026-08-18): this post originally counted every catalog entry, including hundreds of near-duplicate pairwise converters that were later collapsed into a handful of parameterized tools. The catalog is quoted as an evergreen "500+ tools" everywhere now; the exact live number is always at <a href="/api/pricing">/api/pricing</a> and <a href="/health">/health</a>.</em></p>

<h2>What categories exist</h2>

<p>The catalog spans 30+ categories, grouped into "kits" - each kit is a focused collection of related tools:</p>

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

<p>We started with 50 tools in the first week. The approach was simple: pick a category, build 5-10 tools that cover the common tasks, write the CI test for each, and ship. Each kit follows the same pattern - a single file that exports an array of tool definitions with handlers.</p>

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
  <li><strong>search_tools</strong> - find tools by keyword or task description</li>
  <li><strong>find_tool</strong> - resolve a specific tool by name or slug</li>
  <li><strong>call_tool</strong> - execute any tool with input parameters</li>
  <li><strong>about_agent402</strong> - get platform info and capabilities</li>
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

<p>Once connected, Claude Code can search through all 500+ tools, find the right one for a task, and call it - all through the standard MCP protocol. The <code>search_tools</code> and <code>find_tool</code> commands help the agent discover relevant tools without needing to know the full catalog.</p>

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

<p>The npm package bundles the same tool definitions and connects to the hosted API for execution. It works with any MCP client that supports stdio transport - Claude Code, Cline, Continue, and others.</p>

<h2>Framework adapters</h2>

<p>Beyond MCP, we publish framework-specific adapters for direct integration: OpenAI, Anthropic SDK, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents, and AWS Strands. Each adapter wraps Agent402 tools in the framework's native tool format, so you can drop them into existing agent code without protocol translation.</p>

<p>All adapters and the MCP package are open source and published on npm. Check the <a href="https://github.com/MikeyPetrillo/Agent402">GitHub repo</a> for the latest versions.</p>`,
  },
];

export function blogIndex(baseUrl) {
  const canonical = `${baseUrl}/blog`;
  const pageTitle = "Blog - Agent402";
  const pageDesc = "News, deep-dives, and announcements from the Agent402 project - tools, models, x402 payments, and MCP integrations for autonomous agents.";

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
.blog-card{display:block;background:var(--card);border:1px solid var(--hairline);padding:24px 26px;text-decoration:none;transition:border-color .2s;}
.blog-card:hover{border-color:var(--accent);}
.blog-date{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:6px;}
.blog-card h2{font-family:var(--font-body);font-weight:800;font-size:20px;line-height:1.15;letter-spacing:-.02em;margin:4px 0 12px;color:var(--ink);}
.blog-excerpt{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 14px;}
.blog-read{font-family:var(--font-mono);font-size:13px;color:var(--accent);font-weight:700;}
@media(max-width:600px){.bl-wrap h1{font-size:40px;}}
`;

  const body = `<div class="bl-wrap">
  <section>
  <div class="bl-eyebrow">$ GET /blog</div>
  <h1>Blog</h1>
  <p class="bl-desc">${esc(pageDesc)}</p>
  </section>
  <section>
  <div class="blog-grid">
${cards}
  </div>
  </section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}

export function blogPost(baseUrl, slug) {
  const post = BLOG_POSTS.find((p) => p.slug === slug);
  if (!post) return null;

  const canonical = `${baseUrl}/blog/${post.slug}`;
  const pageTitle = `${post.title} - Agent402 Blog`;

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
.post-body pre{background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:13px;line-height:1.55;padding:16px 20px;overflow-x:auto;margin:0 0 16px;border:1px solid var(--hairline);}
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
