import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";

export function landingPage(baseUrl, network, freeMode, catalog, stats = null) {
  const tools = toolList(catalog);
  const count = tools.length;
  const freeCount = tools.filter(isComputePayable).length;
  const served = stats?.toolCallsServed;
  // The old-web visitor counter, except every digit is a real served tool call.
  const odometer = served
    ? `<div class="odometer" title="Counted live by the server; settled revenue is independently verifiable on-chain">
    <span class="odo-label">— TOOL CALLS SERVED —</span>
    <span class="odo-digits">${String(served.total).padStart(7, "0").split("").map((d) => `<b>${d}</b>`).join("")}</span>
    <span class="odo-sub">${served.viaUSDC} settled in USDC · ${served.viaProofOfWork} paid with compute${stats.onchainRevenueProof ? ` · <a href="${stats.onchainRevenueProof}" rel="noopener">on-chain proof</a>` : ""} · counting since ${String(stats.servingSince).slice(0, 10)}</span>
  </div>`
    : "";
  const categoryCards = Object.entries(CATEGORIES)
    .map(([key, { label, blurb }]) => {
      const inCat = tools.filter((t) => t.category === key);
      if (!inCat.length) return "";
      const cheapest = inCat.reduce((a, t) => Math.min(a, parseFloat(t.price.slice(1))), Infinity);
      return `<a class="card cat" href="/tools#${key}">
      <h3>${label} <span class="count">${inCat.length}</span></h3>
      <div class="price">from $${cheapest}</div>
      <p>${blurb}</p>
    </a>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230b0e14'/%3E%3Ctext x='50' y='66' font-size='40' font-weight='700' font-family='monospace' text-anchor='middle' fill='%234ade80'%3E402%3C/text%3E%3C/svg%3E">
<title>Agent402 — where agents pay agents (machine-to-machine payments via x402, USDC on Base)</title>
<meta name="description" content="A live node in the machine-to-machine economy: ${count} tools autonomous agents pay for per call in USDC via the x402 protocol — or with proof-of-work, no wallet. No human, no signup, no API key. The payment is the identity.">
<link rel="canonical" href="${baseUrl}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/">
<meta property="og:site_name" content="Agent402">
<meta property="og:title" content="Agent402 — where agents pay agents (machine-to-machine payments)">
<meta property="og:description" content="A working node in agent-to-agent commerce: ${count} tools settled per call in USDC via x402 (or proof-of-work). No human, no signup. The payment is the identity.">
<meta property="og:image" content="${baseUrl}/logo.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:image" content="${baseUrl}/logo.png">
<meta name="twitter:title" content="Agent402 — where agents pay agents">
<meta name="twitter:description" content="Machine-to-machine payments, live. Autonomous agents pay per call in USDC via x402 — or with compute. No human, no signup, no API key.">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "${baseUrl}/#org",
      "name": "Agent402",
      "url": "${baseUrl}",
      "founder": { "@type": "Person", "name": "Mikey Petrillo", "url": "https://github.com/MikeyPetrillo" },
      "sameAs": ["https://github.com/MikeyPetrillo", "https://www.npmjs.com/package/agent402-mcp"],
      "description": "Machine-to-machine payments for AI agents: ${count} pay-per-call web tools settled in USDC via the x402 protocol, or free with proof-of-work."
    },
    {
      "@type": "WebSite",
      "@id": "${baseUrl}/#site",
      "url": "${baseUrl}",
      "name": "Agent402 — tools for AI agents",
      "publisher": { "@id": "${baseUrl}/#org" }
    },
    {
      "@type": "WebAPI",
      "name": "Agent402",
      "url": "${baseUrl}",
      "provider": { "@id": "${baseUrl}/#org" },
      "description": "${count} pay-per-call tools for AI agents via the x402 payment protocol (USDC on Base): live web search, headless-browser rendering, screenshots, PDF text extraction, URL-to-markdown, wallet-keyed memory & coordination, ${count - freeCount > 0 ? "data conversion, " : ""}unit conversions, validation, and more.",
      "documentation": "${baseUrl}/llms.txt",
      "offers": { "@type": "AggregateOffer", "offerCount": "${count}", "lowPrice": "0.001", "highPrice": "0.02", "priceCurrency": "USD", "description": "Per-call micropayments in USDC via x402, or free with proof-of-work" }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        { "@type": "Question", "name": "What is Agent402?", "acceptedAnswer": { "@type": "Answer", "text": "Agent402 is a live node in the machine-to-machine economy: ${count} web tools an autonomous AI agent can call and pay for per request in USDC via the x402 protocol — or with proof-of-work, no wallet. No human, no signup, no API key." } },
        { "@type": "Question", "name": "How does an AI agent pay for a tool?", "acceptedAnswer": { "@type": "Answer", "text": "The agent calls an endpoint and receives an HTTP 402 Payment Required quote. An x402 client signs a USDC payment from the agent's own wallet on Base and retries; the call settles on-chain in seconds. The wallet is the identity — no account needed." } },
        { "@type": "Question", "name": "Are any tools free?", "acceptedAnswer": { "@type": "Answer", "text": "Yes — ${freeCount} of the ${count} pure-CPU tools can be used with no wallet at all by solving a short proof-of-work puzzle (a few seconds of the caller's CPU) instead of paying USDC." } },
        { "@type": "Question", "name": "Why would an agent use this instead of building the tools itself?", "acceptedAnswer": { "@type": "Answer", "text": "Many agents can write code but can't run a headless browser, reach the network from a locked sandbox, or keep durable state across sessions. Agent402 provides a real browser, network access, and wallet-keyed memory and coordination that a single ephemeral agent cannot give itself." } },
        { "@type": "Question", "name": "Does Agent402 use AI or spend my model tokens?", "acceptedAnswer": { "@type": "Answer", "text": "No. Every tool is deterministic code — parsers, hashes, math, a real browser — with no LLM anywhere in the serving path, and the free tier's proof-of-work is a sha256 puzzle your machine solves in a fraction of a second. Nothing consumes AI tokens. Tools like /api/extract exist to SAVE your tokens: they return clean markdown instead of 100k tokens of raw HTML." } }
      ]
    }
  ]
}
</script>
<style>
  :root { --bg:#0b0e14; --card:#131826; --text:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:920px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:2.4rem; line-height:1.15; margin-bottom:12px; }
  h1 .x { color:var(--accent); }
  .sub { color:var(--muted); font-size:1.15rem; max-width:640px; }
  .badge { display:inline-block; background:#1b2336; color:var(--accent); border:1px solid #2a3550; border-radius:999px; padding:3px 12px; font-size:.8rem; margin-bottom:20px; font-family:var(--mono); }
  .cta { display:inline-block; margin:18px 12px 0 0; padding:10px 18px; border-radius:10px; font-weight:600; text-decoration:none; }
  .cta.primary { background:var(--accent); color:#08130b; }
  .cta.ghost { border:1px solid #2a3550; color:var(--text); }
  .grid { display:grid; gap:14px; margin:32px 0; }
  @media (min-width:640px){ .grid{ grid-template-columns:repeat(3,1fr);} }
  .card { background:var(--card); border:1px solid #1e2638; border-radius:12px; padding:18px; }
  a.card { text-decoration:none; display:block; }
  a.card:hover { border-color:#2a3550; }
  .card h3 { font-size:1rem; margin-bottom:4px; color:var(--text); }
  .card .count { color:var(--muted); font-family:var(--mono); font-size:.8rem; font-weight:400; }
  .card .price { color:var(--accent); font-family:var(--mono); font-size:.85rem; }
  .card p { color:var(--muted); font-size:.85rem; margin-top:8px; }
  h2 { margin:44px 0 12px; font-size:1.35rem; }
  pre { background:#0d1220; border:1px solid #1e2638; border-radius:10px; padding:16px; overflow-x:auto; font-family:var(--mono); font-size:.82rem; line-height:1.5; color:#c9d4ec; }
  code { font-family:var(--mono); font-size:.85em; color:#a5b4d4; }
  .step { display:flex; gap:14px; margin:14px 0; }
  .step b { color:var(--accent); font-family:var(--mono); flex-shrink:0; }
  .step span { color:var(--muted); }
  .why { display:grid; gap:14px; margin:20px 0; }
  @media (min-width:640px){ .why{ grid-template-columns:repeat(2,1fr);} }
  .why .card h3 { color:var(--accent); font-size:.95rem; }
  a { color:var(--accent); }
  footer { margin-top:56px; color:var(--muted); font-size:.85rem; border-top:1px solid #1e2638; padding-top:20px; }
  .warn { background:#3a2a12; border:1px solid #6b4a1a; color:#fbbf24; border-radius:10px; padding:12px 16px; margin:20px 0; font-size:.9rem; }
  .faq p { color:var(--muted); margin:14px 0; font-size:.95rem; }
  .faq b { color:var(--text); }
  .callout { background:#10210f; border:1px solid #1f4a1d; border-radius:12px; padding:14px 18px; margin:24px 0 8px; font-size:1rem; color:var(--text); }
  .callout b { color:#fff; }
  .freebadge { display:inline-block; background:var(--accent); color:#08130b; font-weight:800; font-size:.72rem; letter-spacing:.03em; padding:2px 9px; border-radius:999px; margin-right:8px; vertical-align:middle; }
  .odometer { margin:30px 0 4px; text-align:center; }
  .odo-label { display:block; color:var(--muted); font-family:var(--mono); font-size:.7rem; letter-spacing:.3em; margin-bottom:9px; }
  .odo-digits b { display:inline-block; background:#000; color:var(--accent); border:1px solid #1f4a1d; border-radius:6px; font:700 1.9rem/1 var(--mono); padding:9px 8px; margin:0 2px; text-shadow:0 0 9px rgba(74,222,128,.55); }
  .odo-sub { display:block; margin-top:9px; color:var(--muted); font-size:.8rem; font-family:var(--mono); }
  .ticker { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; margin:18px 0 6px; padding:11px 14px; background:#0d1626; border:1px solid #1f3550; border-radius:10px; font-family:var(--mono); font-size:.78rem; color:var(--muted); }
  .ticker .live { color:var(--accent); font-weight:700; letter-spacing:.08em; }
  .ticker .dot { width:7px; height:7px; border-radius:50%; background:var(--accent); display:inline-block; box-shadow:0 0 8px var(--accent); margin-right:6px; vertical-align:middle; }
  .ticker .sep { color:#33405c; }
  .verify { background:#0d1220; border:1px solid #1e2638; border-radius:12px; padding:18px 20px; margin:18px 0; }
  .verify h3 { font-size:1rem; margin-bottom:6px; }
  .verify .row { margin:12px 0; }
  .verify .row b { color:var(--text); font-size:.9rem; }
  .verify code { display:block; margin-top:5px; background:#080c16; border:1px solid #1e2638; border-radius:7px; padding:8px 10px; font-size:.76rem; color:#9fb4dc; overflow-x:auto; white-space:nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <div class="badge">x402 &middot; machine-to-machine payments &middot; USDC on ${network} &middot; ${count} tools</div>
  <h1>Where agents pay agents<span class="x">.</span></h1>
  <p class="sub">A live node in the machine-to-machine economy. An autonomous agent hits an endpoint, gets an <code>HTTP 402</code> price quote, settles payment from its own wallet in USDC — or with a few seconds of compute — and gets the result. No human, no signup, no API key. The payment <em>is</em> the identity. ${count} tools to prove it's real.</p>
  <a class="cta primary" href="/tools">Browse all ${count} tools →</a>
  <a class="cta ghost" href="/api/stats">live stats</a>
  <a class="cta ghost" href="/llms.txt">llms.txt</a>
  <a class="cta ghost" href="/openapi.json">OpenAPI</a>
  <div class="ticker">
    <span><span class="dot"></span><span class="live">LIVE</span></span>
    <span class="sep">·</span><span>Settling on ${network} mainnet</span>
    <span class="sep">·</span><span>Paid MCP server + HTTP x402</span>
    <span class="sep">·</span><span>On the Coinbase CDP Bazaar</span>
    <span class="sep">·</span><span>On the MCP Registry &amp; agent402.app</span>
    <span class="sep">·</span><span>${count} tools</span>
  </div>
  <div class="callout"><span class="freebadge">${freeCount} FREE</span> <b>${freeCount} of ${count} tools need no wallet at all.</b> An agent with no funds pays by solving a tiny <a href="/api/pow">sha256 puzzle</a> (a fraction of a second of its own CPU) instead of USDC — <b>no money, no AI tokens, no model calls</b>, still no signup. The other ${count - freeCount} (browser, network, memory) settle in USDC because they cost real infrastructure to run.</div>
  ${freeMode ? '<div class="warn">⚠ Demo mode — payments are currently disabled on this instance.</div>' : ""}
  ${odometer}

  <h2>Watch an agent pay an agent</h2>
  <p class="sub">No slideware — run the whole loop yourself. An autonomous buyer discovers the catalog, gets quoted over <code>HTTP 402</code>, settles, and uses the result, with zero human involvement:</p>
  <pre># one file, zero dependencies — pays with COMPUTE (no wallet, no funds)
curl -s ${baseUrl}/demo.js -o demo.js && node demo.js

# or settle in real USDC on Base with a funded key
npm i @x402/core @x402/evm @x402/fetch viem
AGENT_KEY=0xYOUR_FUNDED_KEY node demo.js</pre>
  <p class="sub">Revenue is trustless and public — every settled call lands on-chain. See live counts and the receiving wallet at <a href="/api/stats">/api/stats</a>.</p>

  <h2>Why not just build it yourself?</h2>
  <p class="sub">A developer with a free weekend could build some of this. But the buyer here isn't that developer — it's an <em>agent, mid-task, with no human to ask</em>. Here's what it can't give itself:</p>
  <div class="why">
    <div class="card">
      <h3>Sign up for anything</h3>
      <p>The useful web hides behind signups, captchas, API keys, and credit cards — none of which an autonomous agent can obtain. Here, the only credential is the one thing an agent can hold: a wallet. That's how <code>/api/search</code> puts a paid search index one HTTP call away, no account.</p>
    </div>
    <div class="card">
      <h3>Run a browser farm</h3>
      <p>Most agent sandboxes have no Chromium, no GPU, no display. <code>/api/render</code> and <code>/api/screenshot</code> are real headless browser infrastructure — JavaScript executed, SPAs included — rented by the call for 2 cents.</p>
    </div>
    <div class="card">
      <h3>Remember anything tomorrow</h3>
      <p>Agent sessions are ephemeral; the container is gone an hour later. <code>/api/memory</code> is durable state keyed to the paying wallet — persist findings today, read them next week from a different machine, zero credentials to store or leak. Wallets can grant each other access: shared state for agents that don't share an owner.</p>
    </div>
    <div class="card">
      <h3>Escape its own sandbox</h3>
      <p>Many runtimes block or allowlist network egress, so "just fetch it" fails. Agent402 endpoints are a single, predictable host that does the fetching, parsing, and rendering server-side — with SSRF guards built in.</p>
    </div>
    <div class="card">
      <h3>Beat the token math</h3>
      <p>Writing, testing, and debugging a CSV parser or cron calculator mid-task burns thousands of tokens — easily 10-100&times; the price of a tested <code>$0.001</code> call. Reimplementation is the expensive path.</p>
    </div>
    <div class="card">
      <h3>Stay maintained</h3>
      <p>The weekend-built version rots quietly: site layouts change, Chromium updates, SSRF holes ship. Every endpoint here is re-tested against its own documented example before every deploy — all of them green, or it doesn't ship.</p>
    </div>
  </div>

  <h2>${count} tools, ${Object.keys(CATEGORIES).filter((k) => tools.some((t) => t.category === k)).length} categories</h2>
  <div class="grid">
${categoryCards}
  </div>

  <h2>The index lists thousands of sellers. Verify this one.</h2>
  <p class="sub">Machine-to-machine commerce has no sales calls and no contracts — so every trust claim here is checkable by a program:</p>
  <div class="why">
    <div class="card">
      <h3>Revenue is on-chain</h3>
      <p>Every USDC call settles to a <a href="/api/stats">public wallet</a> you can audit on Basescan. The odometer above counts real served calls — not marketing numbers.</p>
    </div>
    <div class="card">
      <h3>Tested before every deploy</h3>
      <p>CI calls all ${count} endpoints with their own documented examples and blocks the release on any failure. The example on each tool page <em>is</em> the test.</p>
    </div>
    <div class="card">
      <h3>A named maintainer</h3>
      <p>Most x402 sellers are anonymous wallets. This one is <a href="https://github.com/MikeyPetrillo" rel="noopener">signed</a> — a reputation that costs more to burn than a tool call earns.</p>
    </div>
    <div class="card">
      <h3>Deterministic, schema'd, flat-priced</h3>
      <p>No LLM in the serving path: same input, same output, full <a href="/openapi.json">OpenAPI schemas</a>, flat per-call prices. Nothing to drift, nothing to hallucinate.</p>
    </div>
  </div>

  <h2>Verify it yourself</h2>
  <p class="sub">Don't take our word for it — every claim above is checkable by a machine. These are the real discovery and settlement records:</p>
  <div class="verify">
    <div class="row"><b>Discoverable on the Coinbase CDP Bazaar</b> — the index AI agents browse for x402 services, keyed to our pay-to address:
      <code>GET api.cdp.coinbase.com/platform/v2/x402/discovery/resources</code></div>
    <div class="row"><b>Listed in the official MCP Registry</b> — installable by name in any MCP client:
      <code>GET registry.modelcontextprotocol.io/v0/servers?search=io.github.mikeypetrillo/agent402</code></div>
    <div class="row"><b>On npm</b> — one-line install, <code>npx -y agent402-mcp</code>:
      <code>https://www.npmjs.com/package/agent402-mcp</code></div>${stats?.wallet ? `
    <div class="row"><b>Real USDC settlements, on-chain</b> — every paid call lands here, verifiable on Basescan:
      <code>${stats.onchainRevenueProof || `https://basescan.org/address/${stats.wallet}#tokentxns`}</code></div>` : ""}
    <div class="row"><b>Self-describing & tested</b> — full schemas, and every endpoint is re-tested against its own documented example before each deploy:
      <code>GET ${baseUrl}/openapi.json &nbsp;·&nbsp; GET ${baseUrl}/api/pricing</code></div>
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

  <h2>Or just add it to Claude / any MCP client</h2>
  <p>Published in the <a href="https://registry.modelcontextprotocol.io" rel="noopener">official MCP Registry</a> and on npm. The <code>agent402-mcp</code> server exposes the whole catalog as MCP tools and pays underneath — USDC via x402 if you give it a funded key, proof-of-work (free) on the pure-CPU tools if you don't. High-value tools are first-class; the rest are reachable via <code>search_tools</code> + <code>call_tool</code>, so your context window stays small. Built-in spend controls (<code>AGENT402_BUDGET</code>, <code>AGENT402_MAX_PER_CALL</code>) refuse a runaway model <em>before</em> a payment is signed.</p>
  <pre>{ "mcpServers": { "agent402": {
    "command": "npx", "args": ["-y", "agent402-mcp"],
    "env": { "AGENT_KEY": "0x&lt;funded wallet key — optional&gt;",
             "AGENT402_BUDGET": "1.00" }
} } }</pre>

  <h2>Try it (no payment needed)</h2>
  <pre># Machine-readable catalog — free
curl ${baseUrl}/api/pricing

# Full OpenAPI 3.1 spec — free
curl ${baseUrl}/openapi.json

# See the 402 challenge a paying agent receives
curl -i -X POST ${baseUrl}/api/extract \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com"}'</pre>

  <h2>FAQ</h2>
  <div class="faq">
    <p><b>What is Agent402?</b><br><span>A live node in the machine-to-machine economy: ${count} web tools an autonomous AI agent can call and pay for per request in USDC via the <a href="https://x402.org" rel="noopener">x402 protocol</a> — or with proof-of-work, no wallet. No human, no signup, no API key.</span></p>
    <p><b>How does an AI agent pay for a tool?</b><br><span>It calls an endpoint and gets an <code>HTTP 402 Payment Required</code> quote. An x402 client signs a USDC payment from the agent's own wallet on Base and retries; the call settles on-chain in seconds. The wallet is the identity.</span></p>
    <p><b>Are any tools free?</b><br><span>Yes — ${freeCount} of the ${count} pure-CPU tools work with no wallet at all: solve a short <a href="/api/pow">proof-of-work</a> puzzle (a few seconds of CPU) instead of paying USDC.</span></p>
    <p><b>Why not just build the tools myself?</b><br><span>Many agents can write code but can't run a headless browser, reach the network from a locked sandbox, or keep durable state across sessions. Agent402 provides a real browser, network access, and wallet-keyed memory &amp; coordination a single ephemeral agent can't give itself.</span></p>
    <p><b>Does Agent402 use AI or spend my model tokens?</b><br><span>No. Every tool is deterministic code — parsers, hashes, math, a real browser — with no LLM anywhere in the serving path, and the free tier's proof-of-work is a sha256 puzzle your machine solves in a fraction of a second. Nothing here consumes AI tokens. Tools like <code>/api/extract</code> exist to <em>save</em> your tokens: clean markdown out instead of 100k tokens of raw HTML in.</span></p>
  </div>

  <footer>
    Agent402 — ${count} machine-payable tools for AI agents. Built on the <a href="https://x402.org" rel="noopener">x402 protocol</a>
    by <a href="https://github.com/MikeyPetrillo" rel="noopener">Mikey Petrillo</a>.
    Free: <a href="/tools">/tools</a> · <a href="/api/pricing">/api/pricing</a> · <a href="/openapi.json">/openapi.json</a> · <a href="/llms.txt">/llms.txt</a> · <code>GET /health</code>.
  </footer>
</div>
</body>
</html>`;
}
