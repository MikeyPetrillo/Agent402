import { toolList, CATEGORIES } from "./pages.js";
import { isComputePayable } from "./pow.js";
import { CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

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
    <span class="odo-sub">${served.viaUSDC} settled in USDC${stats.walletName ? ` to ${stats.walletName}` : ""} · ${served.viaProofOfWork} paid with compute${stats.onchainRevenueProof ? ` · <a href="${stats.onchainRevenueProof}" rel="noopener">on-chain proof</a>` : ""} · counting since ${String(stats.servingSince).slice(0, 10)}</span>
  </div>`
    : "";
  // Live activity strip — the recent paid-call feed from /api/stats as social
  // proof. Server-rendered, then refreshed client-side every 12s.
  const recent = Array.isArray(stats?.recentCalls) ? stats.recentCalls : [];
  const agoStr = (iso) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`; };
  // Defense-in-depth: slugs originate from CATALOG (developer-controlled), but
  // escape on render so the server-side path matches the client-side esc() below.
  // Also escape ' so attribute contexts using single quotes are covered.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const activityRows = (rows) => rows.slice(0, 8).map((r) => `<li><span class="a-slug">${esc(r.slug)}</span><span class="a-meta">${r.paidWith === "proof-of-work" ? "⚙ PoW" : "$ USDC"} · ${agoStr(r.at)} ago</span></li>`).join("");
  const activity = recent.length
    ? `<div class="activity">
    <div class="eyebrow" style="margin:0 0 8px">● Live — recent paid calls</div>
    <ul id="activity-list">${activityRows(recent)}</ul>
    <script>(function(){var el=document.getElementById('activity-list');if(!el)return;function ago(iso){var s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000);return s<60?(s|0)+'s':s<3600?((s/60)|0)+'m':s<86400?((s/3600)|0)+'h':((s/86400)|0)+'d';}function esc(t){return String(t).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}async function tick(){try{var r=await fetch('/api/stats',{cache:'no-store'});var d=await r.json();el.innerHTML=(d.recentCalls||[]).slice(0,8).map(function(x){return '<li><span class="a-slug">'+esc(x.slug)+'</span><span class="a-meta">'+(x.paidWith==='proof-of-work'?'⚙ PoW':'$ USDC')+' · '+ago(x.at)+' ago</span></li>';}).join('');}catch(e){}}setInterval(tick,12000);})();</script>
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="512x512" href="/logo.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/logo.png"><title>Agent402 — the open x402 index: Find, Router &amp; Leaderboard for the agent payments economy (${count}+ tools)</title>
<meta name="description" content="The open x402 index — discovery, routing, and on-chain ranking for the agent payments economy. /api/find resolves tasks to tools, /api/route is the neutral Smart Order Router across every x402 seller, /api/leaderboard ranks them by Base USDC settled volume. Plus ${count} pay-per-call agent tools and agent402-tollbooth (open pay-per-crawl gate). Free via proof-of-work or USDC on Base. No signup, no API key.">
<link rel="canonical" href="${baseUrl}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/">
<meta property="og:site_name" content="Agent402">
<meta property="og:title" content="Agent402 — the open x402 index: Find, Router &amp; Leaderboard (${count}+ tools)">
<meta property="og:description" content="The open x402 index — discovery, routing, and on-chain ranking for the agent payments economy. Find a tool, route across every x402 seller, see who's most used on-chain. Plus ${count} pay-per-call agent tools. Free via proof-of-work or USDC on Base.">
<meta property="og:image" content="${baseUrl}/card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${baseUrl}/card.png">
<meta name="twitter:title" content="Agent402 — the open x402 index: Find, Router &amp; Leaderboard">
<meta name="twitter:description" content="Discovery, routing, and on-chain ranking for the agent payments economy. ${count} pay-per-call agent tools. Free via proof-of-work or USDC on Base.">
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
      "sameAs": ["https://github.com/MikeyPetrillo", "https://github.com/MikeyPetrillo/Agent402", "https://www.npmjs.com/package/agent402-mcp", "https://www.npmjs.com/package/agent402-client", "https://www.npmjs.com/package/agent402-tollbooth", "https://www.npmjs.com/package/agent402-openai-tools", "https://www.npmjs.com/package/agent402-anthropic-tools", "https://www.npmjs.com/package/agent402-ai-sdk", "https://www.npmjs.com/package/agent402-langchain", "https://www.npmjs.com/package/agent402-llamaindex"],
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
      "description": "${count} pay-per-call tools for AI agents via the x402 payment protocol (USDC on Base): live web search, headless-browser rendering, screenshots, PDF text extraction, URL-to-markdown, wallet-keyed memory & coordination, a non-custodial multi-chain x402 payment toolkit (quote/verify/balance/gas/transfer-authorization/ENS), image transforms, live currency & product data, ${count - freeCount > 0 ? "data conversion, " : ""}unit conversions, validation, and more.",
      "documentation": "${baseUrl}/llms.txt",
      "offers": { "@type": "AggregateOffer", "offerCount": "${count}", "lowPrice": "0.001", "highPrice": "0.02", "priceCurrency": "USD", "description": "Per-call micropayments in USDC via x402, or free with proof-of-work" }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        { "@type": "Question", "name": "What is Agent402?", "acceptedAnswer": { "@type": "Answer", "text": "Agent402 is a live node in the machine-to-machine economy: ${count} web tools an autonomous AI agent can call and pay for per request in USDC via the x402 protocol — or with proof-of-work, no wallet. No human, no signup, no API key." } },
        { "@type": "Question", "name": "How does an AI agent pay for a tool?", "acceptedAnswer": { "@type": "Answer", "text": "The agent calls an endpoint and receives an HTTP 402 Payment Required quote. An x402 client signs a USDC payment from the agent's own wallet on Base and retries; the call settles on-chain in seconds. The wallet is the identity — no account needed. x402 is an open standard with settlement infrastructure from Coinbase and Stripe." } },
        { "@type": "Question", "name": "Are any tools free?", "acceptedAnswer": { "@type": "Answer", "text": "Yes — ${freeCount} of the ${count} pure-CPU tools can be used with no wallet at all by solving a short proof-of-work puzzle (a few seconds of the caller's CPU) instead of paying USDC." } },
        { "@type": "Question", "name": "Why would an agent use this instead of building the tools itself?", "acceptedAnswer": { "@type": "Answer", "text": "Many agents can write code but can't run a headless browser, reach the network from a locked sandbox, or keep durable state across sessions. Agent402 provides a real browser, network access, and wallet-keyed memory and coordination that a single ephemeral agent cannot give itself." } },
        { "@type": "Question", "name": "Does Agent402 use AI or spend my model tokens?", "acceptedAnswer": { "@type": "Answer", "text": "No. Every tool is deterministic code — parsers, hashes, math, a real browser — with no LLM anywhere in the serving path, and the free tier's proof-of-work is a sha256 puzzle your machine solves in a fraction of a second. Nothing consumes AI tokens. Tools like /api/extract exist to SAVE your tokens: they return clean markdown instead of 100k tokens of raw HTML." } },
        { "@type": "Question", "name": "Can I use Agent402 from OpenAI / Anthropic / LangChain / LlamaIndex / Vercel AI SDK?", "acceptedAnswer": { "@type": "Answer", "text": "Yes — there is a zero-dependency adapter package on npm for each of the major agent stacks: agent402-openai-tools (OpenAI function-calling), agent402-anthropic-tools (Anthropic Messages API), agent402-ai-sdk (Vercel AI SDK), agent402-langchain (LangChain JS / LangGraph), and agent402-llamaindex (LlamaIndex TS). Each one returns ready-to-pass tool objects in the framework's native shape, with payment handled underneath (proof-of-work for free tools, USDC via x402 for wallet-only). MCP-based clients like Claude can use the hosted https://agent402.tools/mcp connector directly." } },
        { "@type": "Question", "name": "How do I see which x402 sellers are most used?", "acceptedAnswer": { "@type": "Answer", "text": "GET /api/leaderboard returns the live on-chain ranking of every x402 seller by Base USDC settled volume — callsSettled, totalUsd, and uniqueBuyers per seller. The pipeline walks every page of the Coinbase CDP Bazaar discovery endpoint, queries eth_getLogs on Base USDC for each seller's payTo wallet, filters to per-call settlements within a $0.50 ceiling (larger inbound is funding, not buys), and aggregates. The snapshot refreshes hourly server-side. Free, like /api/find and /api/route. Use include=external to exclude Agent402 itself and rank only the rest of the ecosystem." } }
      ]
    }
  ]
}
</script>
<style>
  :root { --bg:#0a0d13; --bg2:#0d1220; --card:#121826; --line:#1e2638; --line2:#2a3550; --text:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --accent2:#34d399; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  html { scroll-behavior:smooth; }
  body { background:var(--bg); color:var(--text); font:16px/1.65 system-ui,-apple-system,sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:var(--accent); }

  /* sticky top nav — makes it read as a product, not a doc */
  .nav { position:sticky; top:0; z-index:50; backdrop-filter:blur(12px); background:rgba(10,13,19,.82); border-bottom:1px solid var(--line); }
  .nav-in { max-width:1080px; margin:0 auto; display:flex; align-items:center; gap:20px; padding:12px 20px; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; text-decoration:none; color:var(--text); letter-spacing:-.01em; }
  .brand .glyph { font-family:var(--mono); font-weight:700; color:var(--accent); border:1px solid #1f4a1d; background:#000; border-radius:7px; padding:2px 7px; font-size:.82rem; }
  .nav .spacer { flex:1; }
  .nav a.link { color:var(--muted); text-decoration:none; font-size:.9rem; }
  .nav a.link:hover { color:var(--text); }
  .nav a.gh { border:1px solid var(--line2); border-radius:8px; padding:6px 13px; color:var(--text); font-size:.85rem; text-decoration:none; }
  .nav a.gh:hover { border-color:var(--accent); }
  @media (max-width:720px){ .nav a.hide-sm{ display:none; } }

  .wrap { max-width:1080px; margin:0 auto; padding:0 20px; position:relative; }
  section { padding:60px 0; border-top:1px solid var(--line); }
  .eyebrow { font-family:var(--mono); font-size:.72rem; letter-spacing:.2em; text-transform:uppercase; color:var(--accent); margin-bottom:12px; }
  h2 { font-size:clamp(1.5rem,3vw,1.9rem); letter-spacing:-.02em; margin-bottom:12px; }
  .sub { color:var(--muted); font-size:1.08rem; max-width:680px; }

  /* hero */
  .hero { position:relative; padding:60px 0 56px; display:grid; gap:36px; border-top:none; }
  @media (min-width:900px){ .hero{ grid-template-columns:1.04fr .96fr; align-items:center; } }
  .hero::before { content:""; position:absolute; top:-160px; left:-10%; width:780px; height:520px; pointer-events:none; z-index:-1;
    background:radial-gradient(closest-side, rgba(74,222,128,.16), rgba(52,211,153,.05) 55%, transparent 75%); }
  h1 { font-size:clamp(2.6rem,5.6vw,3.7rem); font-weight:800; letter-spacing:-.03em; line-height:1.04; margin-bottom:18px; }
  h1 .x { color:var(--accent); text-shadow:0 0 26px rgba(74,222,128,.65); }
  .hero .sub { font-size:1.15rem; }
  .badge { display:inline-flex; align-items:center; gap:8px; background:#11203a; color:var(--accent); border:1px solid #1f3550; border-radius:999px; padding:5px 13px; font-size:.78rem; margin-bottom:22px; font-family:var(--mono); }
  .badge .dot { width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 8px var(--accent); }
  .ctas { margin-top:26px; display:flex; flex-wrap:wrap; gap:12px; }
  .cta { display:inline-block; padding:12px 20px; border-radius:11px; font-weight:650; text-decoration:none; font-size:.95rem; }
  .cta.primary { background:linear-gradient(180deg,#5bf09a,#3ec873); color:#06210f; box-shadow:0 6px 24px rgba(74,222,128,.28); }
  .cta.primary:hover { box-shadow:0 8px 30px rgba(74,222,128,.42); }
  .cta.ghost { border:1px solid var(--line2); color:var(--text); }
  .cta.ghost:hover { border-color:var(--accent); }

  /* stat band */
  .stats { display:grid; grid-template-columns:repeat(2,1fr); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:14px; overflow:hidden; margin-top:14px; }
  @media (min-width:560px){ .stats{ grid-template-columns:repeat(4,1fr);} }
  .stat { background:var(--bg2); padding:18px 16px; }
  .stat .n { font:800 1.7rem/1 var(--mono); color:var(--accent); letter-spacing:-.02em; }
  .stat .l { color:var(--muted); font-size:.78rem; margin-top:6px; }

  /* terminal (hero right) */
  .term { background:#080c16; border:1px solid var(--line); border-radius:14px; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,.45); }
  .term-bar { display:flex; gap:7px; padding:11px 14px; border-bottom:1px solid #151c2c; }
  .term-bar i { width:11px; height:11px; border-radius:50%; display:block; }
  .term-bar i:nth-child(1){background:#ff5f57}.term-bar i:nth-child(2){background:#febc2e}.term-bar i:nth-child(3){background:#28c840}
  .term-bar .ttl { margin-left:8px; color:#5b6b8c; font-family:var(--mono); font-size:.72rem; align-self:center; }
  .term-body { padding:16px 18px; font-family:var(--mono); font-size:.78rem; line-height:1.95; color:#c9d4ec; overflow-x:auto; min-height:230px; }
  .tline { opacity:0; white-space:nowrap; animation:tcycle 11s infinite; }
  .tline .p { color:#5b6b8c; } .tline .ok { color:var(--accent); } .tline .warn { color:#fbbf24; }
  .t1{animation-name:t1}.t2{animation-name:t2}.t3{animation-name:t3}.t4{animation-name:t4}.t5{animation-name:t5}.t6{animation-name:t6}
  @keyframes t1 { 0%,2%{opacity:0} 4%,90%{opacity:1} 95%,100%{opacity:0} }
  @keyframes t2 { 0%,13%{opacity:0} 15%,90%{opacity:1} 95%,100%{opacity:0} }
  @keyframes t3 { 0%,28%{opacity:0} 30%,90%{opacity:1} 95%,100%{opacity:0} }
  @keyframes t4 { 0%,42%{opacity:0} 44%,90%{opacity:1} 95%,100%{opacity:0} }
  @keyframes t5 { 0%,57%{opacity:0} 59%,90%{opacity:1} 95%,100%{opacity:0} }
  @keyframes t6 { 0%,73%{opacity:0} 75%,90%{opacity:1} 95%,100%{opacity:0} }
  @media (prefers-reduced-motion: reduce){ .tline{ animation:none; opacity:1; } }

  /* cards / grids */
  .grid { display:grid; gap:14px; margin-top:26px; }
  @media (min-width:640px){ .grid{ grid-template-columns:repeat(3,1fr);} }
  .card { background:var(--card); border:1px solid var(--line); border-radius:13px; padding:18px; transition:border-color .15s, transform .15s; }
  a.card { text-decoration:none; display:block; }
  a.card:hover { border-color:var(--accent); transform:translateY(-2px); }
  .card h3 { font-size:1rem; margin-bottom:4px; color:var(--text); }
  .card .count { color:var(--muted); font-family:var(--mono); font-size:.8rem; font-weight:400; }
  .card .price { color:var(--accent); font-family:var(--mono); font-size:.85rem; }
  .card p { color:var(--muted); font-size:.85rem; margin-top:8px; }
  .why { display:grid; gap:14px; margin-top:22px; }
  @media (min-width:640px){ .why{ grid-template-columns:repeat(2,1fr);} }
  .why .card h3 { color:var(--accent); font-size:.95rem; }
  .steps { display:grid; gap:14px; margin-top:22px; }
  @media (min-width:760px){ .steps{ grid-template-columns:repeat(3,1fr);} }
  .stepc { background:var(--card); border:1px solid var(--line); border-radius:13px; padding:18px; }
  .stepc .num { font:800 1.1rem/1 var(--mono); color:#06210f; background:var(--accent); width:30px; height:30px; border-radius:8px; display:flex; align-items:center; justify-content:center; margin-bottom:12px; }
  .stepc span { color:var(--muted); font-size:.92rem; }

  pre { background:var(--bg2); border:1px solid var(--line); border-radius:11px; padding:16px; overflow-x:auto; font-family:var(--mono); font-size:.82rem; line-height:1.55; color:#c9d4ec; margin-top:10px; }
  code { font-family:var(--mono); font-size:.85em; color:#a5b4d4; }
  .warn { background:#3a2a12; border:1px solid #6b4a1a; color:#fbbf24; border-radius:10px; padding:12px 16px; margin-top:20px; font-size:.9rem; }
  .faq p { color:var(--muted); margin:16px 0; font-size:.95rem; }
  .faq b { color:var(--text); }
  .callout { background:#10210f; border:1px solid #1f4a1d; border-radius:13px; padding:16px 18px; margin-top:24px; font-size:1rem; color:var(--text); }
  .callout b { color:#fff; }
  .freebadge { display:inline-block; background:var(--accent); color:#08130b; font-weight:800; font-size:.72rem; letter-spacing:.03em; padding:2px 9px; border-radius:999px; margin-right:8px; vertical-align:middle; }
  .odometer { margin-top:28px; text-align:center; }
  .odo-label { display:block; color:var(--muted); font-family:var(--mono); font-size:.7rem; letter-spacing:.3em; margin-bottom:9px; }
  .odo-digits b { display:inline-block; background:#000; color:var(--accent); border:1px solid #1f4a1d; border-radius:6px; font:700 1.9rem/1 var(--mono); padding:9px 8px; margin:0 2px; text-shadow:0 0 9px rgba(74,222,128,.55); }
  .odo-sub { display:block; margin-top:9px; color:var(--muted); font-size:.8rem; font-family:var(--mono); }
  .activity { margin:26px auto 0; max-width:540px; }
  .activity ul { list-style:none; margin:0; padding:0; border:1px solid #1f4a1d; border-radius:11px; overflow:hidden; }
  .activity li { display:flex; justify-content:space-between; gap:12px; padding:8px 13px; border-top:1px solid #14260f; font-family:var(--mono); font-size:.8rem; }
  .activity li:first-child { border-top:0; }
  .a-slug { color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .a-meta { color:var(--muted); white-space:nowrap; }
  .verify { background:var(--bg2); border:1px solid var(--line); border-radius:13px; padding:6px 20px; margin-top:22px; }
  .verify .row { margin:16px 0; }
  .verify .row b { color:var(--text); font-size:.9rem; }
  .verify code { display:block; margin-top:6px; background:#080c16; border:1px solid var(--line); border-radius:7px; padding:8px 10px; font-size:.76rem; color:#9fb4dc; overflow-x:auto; white-space:nowrap; }
  .lbl { color:var(--accent); font-family:var(--mono); font-size:.8rem; font-weight:600; margin:22px 0 7px; }
  .lbl span { color:var(--muted); font-weight:400; }
  ${CHROME_CSS}
</style>
</head>
<body>
${renderHeader("/", [{ href: "#connect", label: "Connect" }])}
<div class="wrap">
  <header class="hero">
    <div>
      <span class="badge"><span class="dot"></span> open source · self-hostable · ${count} x402 tools</span>
      <h1>Where agents pay agents<span class="x">.</span></h1>
      <p class="sub"><b>The open-source, self-hostable x402 server</b> — ${count} tools for AI agents in one place (and a <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth" rel="noopener">pay-per-crawl gate</a> for the other side). A real headless browser, live web search, durable memory, and a <a href="/guides/x402-payments-toolkit">non-custodial x402 payment toolkit</a> — the things your agent's sandbox <em>doesn't have</em> — rented by the call. The agent hits an endpoint, gets an <code>HTTP 402</code> quote, pays from its own wallet in USDC (or a few seconds of compute), and gets the result. No human, no signup, no API key — the payment <em>is</em> the identity.</p>
      <div class="ctas">
        <a class="cta primary" href="/tools">Browse all ${count} tools →</a>
        <a class="cta ghost" href="#connect">Add to Claude</a>
        <a class="cta ghost" href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">Self-host free →</a>
      </div>
      <div class="stats">
        <div class="stat"><div class="n">${count.toLocaleString()}</div><div class="l">pay-per-call tools</div></div>
        <div class="stat"><div class="n">${freeCount.toLocaleString()}</div><div class="l">free via proof-of-work</div></div>
        <div class="stat"><div class="n">$0.001</div><div class="l">starting price / call</div></div>
        <div class="stat"><div class="n">${served ? served.total.toLocaleString() : "live"}</div><div class="l">${served ? "calls served" : "settling on-chain"}</div></div>
      </div>
    </div>
    <div class="term" aria-hidden="true">
      <div class="term-bar"><i></i><i></i><i></i><span class="ttl">agent — machine-to-machine</span></div>
      <div class="term-body">
        <div class="tline t1"><span class="p">agent$</span> POST agent402.tools/api/extract {"url":"…/article"}</div>
        <div class="tline t2"><span class="warn">← HTTP 402 Payment Required</span> &nbsp;{"price":"$0.005","payTo":"0xaBF4…a9D0"}</div>
        <div class="tline t3"><span class="p">agent$</span> signing USDC from its own wallet… <span class="p">(no human)</span></div>
        <div class="tline t4"><span class="p">agent$</span> retry with X-PAYMENT header →</div>
        <div class="tline t5"><span class="ok">← HTTP 200 OK</span> &nbsp;{"title":"…","markdown":"# …"} <span class="p">· ~2s</span></div>
        <div class="tline t6"><span class="ok">✓</span> machine-to-machine commerce, end to end</div>
      </div>
    </div>
  </header>

  <div class="callout"><span class="freebadge">${freeCount} FREE</span> <b>${freeCount} of ${count} tools need no wallet</b> — pay with a tiny <a href="/api/pow">sha256 proof-of-work</a> (a fraction of a second of CPU; no money, no AI tokens). The other ${count - freeCount} (browser, network, memory) settle in USDC.</div>
  <div class="callout">🧭 <b>x402 Index + Smart Order Router — the neutral discovery API for x402.</b> <code>POST <a href="/api/route">/api/route</a> {"query":"&lt;task&gt;","include":"external"}</code> ranks tools across <em>every</em> x402 seller we've crawled (auto-discovered from the <a href="https://docs.cdp.coinbase.com/x402/docs/bazaar" rel="noopener">Coinbase CDP Bazaar</a>), filters out unhealthy ones, and tiebreaks on health then price. <code>include:"external"</code> explicitly excludes Agent402 — use us as a neutral router over the rest of the ecosystem. Browse the live index at <a href="/index">/index</a>. Free, like <code>/api/find</code>.</div>
  <div class="callout">🏆 <b>x402 Leaderboard — the first public on-chain ranking of x402 sellers.</b> <code>GET <a href="/api/leaderboard">/api/leaderboard</a></code> ranks every seller in the <a href="https://docs.cdp.coinbase.com/x402/docs/bazaar" rel="noopener">Coinbase CDP Bazaar</a> by <em>real settled USDC volume on Base</em> — calls served, total USD, unique buyers per seller. Pipeline: Bazaar discovery → <code>eth_getLogs</code> → per-call ceiling filter → aggregate by payTo. Hourly snapshot. Use <code>?include=external</code> to exclude Agent402 itself and rank only the rest of the ecosystem. Free, like <code>/api/find</code> and <code>/api/route</code>.</div>
  <div class="callout">⭐ <b>Open source &amp; self-hostable</b> — don't want the hosted version? Clone the repo and run all ${count} tools yourself for free (MCP + HTTP, no wallet, no signup): <code>FREE_MODE=true npm start</code>. <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">Star / fork it on GitHub →</a></div>
  <div class="callout">🚧 <b>The other side of x402: charge AI bots crawling <em>your</em> site.</b> <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth" rel="noopener">agent402-tollbooth</a> is an open-source, self-hostable <b>pay-per-crawl</b> gate — humans browse free, AI crawlers pay per request (USDC via x402, or free via proof-of-work). The open answer to Cloudflare pay-per-crawl: no CDN, no Stripe, no signup. <b>Deploy in one command</b> (<a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/docker" rel="noopener">Docker</a>, <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare" rel="noopener">Cloudflare Workers</a>, or <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/nextjs" rel="noopener">Next.js</a>) and watch a live <code>/__tollbooth</code> dashboard of your bot traffic and earnings.</div>
  ${freeMode ? '<div class="warn">⚠ Demo mode — payments are currently disabled on this instance.</div>' : ""}

  <section>
    <div class="eyebrow">Proof, not slideware</div>
    <h2>Run the whole loop yourself</h2>
    <p class="sub">An autonomous buyer discovers the catalog, gets quoted over <code>HTTP 402</code>, settles, and uses the result — zero humans involved:</p>
    <pre># one file, zero dependencies — pays with COMPUTE (no wallet, no funds)
curl -s ${baseUrl}/demo.js -o demo.js && node demo.js

# or settle in real USDC on Base with a funded key
npm i @x402/core @x402/evm @x402/fetch viem
AGENT_KEY=0xYOUR_FUNDED_KEY node demo.js</pre>
    <p class="sub">Revenue is trustless and public — every settled call lands on-chain. See live counts and the receiving wallet at <a href="/api/stats">/api/stats</a>.</p>
    ${odometer}
    ${activity}
  </section>

  <section>
    <div class="eyebrow">Why pay instead of build</div>
    <h2>What an agent can't give itself</h2>
    <p class="sub">A developer with a free weekend could build some of this. But the buyer here is an <em>agent, mid-task, with no human to ask</em>:</p>
    <div class="why">
      <div class="card">
        <h3>Sign up for anything</h3>
        <p>The useful web hides behind signups, captchas, API keys, and credit cards — none of which an autonomous agent can obtain. Here, the only credential is the one thing an agent holds: a wallet. That's how <code>/api/search</code> puts a paid search index one HTTP call away, no account.</p>
      </div>
      <div class="card">
        <h3>Run a browser farm</h3>
        <p>Most agent sandboxes have no Chromium, no GPU, no display. <code>/api/render</code> and <code>/api/screenshot</code> are real headless browser infrastructure — JavaScript executed, SPAs included — rented by the call for 2 cents.</p>
      </div>
      <div class="card">
        <h3>Remember anything tomorrow</h3>
        <p>Agent sessions are ephemeral; the container is gone an hour later. <code>/api/memory</code> is durable state keyed to the paying wallet — persist findings today, read them next week from a different machine, zero credentials to store or leak.</p>
      </div>
      <div class="card">
        <h3>Beat the token math</h3>
        <p>Writing, testing, and debugging a CSV parser or cron calculator mid-task burns thousands of tokens — easily 10-100&times; the price of a tested <code>$0.001</code> call. Reimplementation is the expensive path.</p>
      </div>
    </div>
  </section>

  <section>
    <div class="eyebrow">The retention hook</div>
    <h2>Memory that outlives the session</h2>
    <p class="sub">One-shot calls solve today's task. <code>/api/memory</code> is why an agent returns next week: durable state where the <em>paying wallet is the identity</em> — no API key to store, leak, or rotate. Write from one machine, read from another, grant a different wallet access, and every access lands in a tamper-evident audit log. From $0.002/call.</p>
    <pre># today, machine A — persist what you learned
POST /api/memory   {"key":"deploy-fix","value":{"cause":"build OOM","fix":"NODE_VERSION=22"}}

# next week, machine B — same wallet, nothing else needed
GET  /api/memory?key=deploy-fix

# let a teammate's agent read your namespace (different wallet, different owner)
POST /api/memory/grant     {"grantee":"0xTEAMMATE","mode":"read"}

# or store prose and search it by meaning later
POST /api/memory/remember  {"text":"Railway deploy failed: build out of memory"}
POST /api/memory/recall    {"query":"why did the deploy break?"}</pre>
  </section>

  <section>
    <div class="eyebrow">The catalog</div>
    <h2>${count} tools, ${Object.keys(CATEGORIES).filter((k) => tools.some((t) => t.category === k)).length} categories</h2>
    <div class="grid">
${categoryCards}
    </div>
  </section>

  <section>
    <div class="eyebrow">Trust is checkable</div>
    <h2>The index lists thousands of sellers. Verify this one.</h2>
    <p class="sub">No sales calls, no contracts — every trust claim here is checkable by a machine, not asserted: deterministic outputs (no LLM in the path), flat prices, a named maintainer, and fully <a href="https://github.com/MikeyPetrillo/Agent402" rel="noopener">open source</a>. The records:</p>
    <div class="verify">
      <div class="row"><b>Discoverable on the Coinbase CDP Bazaar</b> — the index AI agents browse for x402 services, keyed to our pay-to address:
        <code>GET api.cdp.coinbase.com/platform/v2/x402/discovery/resources</code></div>
      <div class="row"><b>Listed in the official MCP Registry</b> — installable by name in any MCP client:
        <code>GET registry.modelcontextprotocol.io/v0/servers?search=io.github.MikeyPetrillo/agent402</code></div>
      <div class="row"><b>On npm</b> — one-line install, <code>npx -y agent402-mcp</code>:
        <code>https://www.npmjs.com/package/agent402-mcp</code></div>
      <div class="row"><b>Open source on GitHub</b> — read every line that serves and prices your call:
        <code>https://github.com/MikeyPetrillo/Agent402</code></div>${stats?.wallet ? `
      <div class="row"><b>Real USDC settlements, on-chain</b> — every paid call lands at ${stats.walletName ? `<b>${stats.walletName}</b> (${stats.wallet.slice(0, 6)}…${stats.wallet.slice(-4)})` : "the revenue wallet"}, verifiable on Basescan:
        <code>${stats.onchainRevenueProof || `https://basescan.org/address/${stats.wallet}#tokentxns`}</code></div>` : ""}
      <div class="row"><b>Self-describing & tested</b> — full schemas, and every endpoint is re-tested against its own documented example before each deploy:
        <code>GET ${baseUrl}/openapi.json &nbsp;·&nbsp; GET ${baseUrl}/api/pricing</code></div>
    </div>
  </section>

  <section>
    <div class="eyebrow">How it works</div>
    <h2>One round trip</h2>
    <div class="steps">
      <div class="stepc"><div class="num">1</div><span>Your agent calls a paid endpoint and receives <code>HTTP 402 Payment Required</code> with the price and payment details.</span></div>
      <div class="stepc"><div class="num">2</div><span>An x402 client (<code>@x402/fetch</code>, <code>@x402/axios</code>, or any agent framework with x402 support) signs a USDC payment from its wallet and retries.</span></div>
      <div class="stepc"><div class="num">3</div><span>Payment settles on ${network} in seconds and the response comes back. Total overhead: one round trip.</span></div>
    </div>
  </section>

  <section id="connect">
    <div class="eyebrow">Use it</div>
    <h2>Three ways in</h2>
    <p class="lbl">Pay in code <span>— any x402 client</span></p>
    <pre>import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY) });
const payFetch = wrapFetchWithPayment(fetch, client);

const res = await payFetch("${baseUrl}/api/extract", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com/article" }),
});
console.log(await res.json()); // { title, markdown, ... }</pre>

    <p class="lbl">Add to Claude / any MCP client <span>— paste the hosted connector URL (claude.ai → Settings → Connectors), zero install: the pure-CPU tools run free there, rate-limited.</span></p>
    <pre>${baseUrl}/mcp</pre>

    <p class="lbl">Full catalog with payment underneath <span>— in the <a href="https://registry.modelcontextprotocol.io" rel="noopener">MCP Registry</a> + npm. High-value tools first-class, the long tail via <code>search_tools</code>/<code>call_tool</code>; spend caps refuse a runaway model before paying.</span></p>
    <pre>{ "mcpServers": { "agent402": {
    "command": "npx", "args": ["-y", "agent402-mcp"],
    "env": { "AGENT_KEY": "0x&lt;funded wallet key — optional&gt;", "AGENT402_BUDGET": "1.00" }
} } }</pre>

    <p class="lbl">Call it from your code <span>— the <a href="https://www.npmjs.com/package/agent402-client" rel="noopener">agent402-client</a> SDK resolves a task to a tool and pays automatically (proof-of-work for free tools, your x402 wallet for paid). Zero deps, non-custodial, with caching + idempotent retries.</span></p>
    <pre>npm install agent402-client

import { Agent402 } from "agent402-client";
const a = new Agent402();                 // free tier (proof-of-work)
const out = await a.call("hash", { text: "hello world", algo: "sha256" });</pre>

    <p class="lbl">Or drop into your agent framework <span>— zero-dep adapters that turn the catalog into native tool objects, with auto-payment underneath.</span></p>
    <pre># pick your stack
npm install agent402-openai-tools         # OpenAI function-calling
npm install agent402-anthropic-tools      # Anthropic Messages API (tool_use)
npm install agent402-ai-sdk               # Vercel AI SDK (streamText / generateText)
npm install agent402-langchain            # LangChain JS / LangGraph
npm install agent402-llamaindex           # LlamaIndex TS

import { agent402Tools } from "agent402-openai-tools";
const { tools, execute } = await agent402Tools({ slugs: ["extract", "hash", "render"] });
// pass tools to openai.chat.completions.create({ tools }); call execute(name, args) on a tool_call.</pre>

    <p class="lbl">Or try it free <span>— no wallet needed</span></p>
    <pre>curl ${baseUrl}/api/pricing          # machine-readable catalog
curl ${baseUrl}/openapi.json         # full OpenAPI 3.1 spec
curl -i -X POST ${baseUrl}/api/extract \\
  -H "Content-Type: application/json" -d '{"url":"https://example.com"}'   # see the 402 quote</pre>
  </section>

  <section>
    <div class="eyebrow">Questions</div>
    <h2>FAQ</h2>
    <div class="faq">
      <p><b>What is Agent402?</b><br><span>A live node in the machine-to-machine economy: ${count} web tools an autonomous AI agent can call and pay for per request in USDC via the <a href="https://x402.org" rel="noopener">x402 protocol</a> — or with proof-of-work, no wallet. No human, no signup, no API key.</span></p>
      <p><b>How does an AI agent pay for a tool?</b><br><span>It calls an endpoint and gets an <code>HTTP 402 Payment Required</code> quote. An x402 client signs a USDC payment from the agent's own wallet on Base and retries; the call settles on-chain in seconds. The wallet is the identity. <a href="https://x402.org" rel="noopener">x402</a> is an open standard with settlement infrastructure from Coinbase and Stripe.</span></p>
      <p><b>Are any tools free?</b><br><span>Yes — ${freeCount} of the ${count} pure-CPU tools work with no wallet at all: solve a short <a href="/api/pow">proof-of-work</a> puzzle (a few seconds of CPU) instead of paying USDC.</span></p>
      <p><b>Does Agent402 use AI or spend my model tokens?</b><br><span>No. Every tool is deterministic code — parsers, hashes, math, a real browser — with no LLM anywhere in the serving path, and the free tier's proof-of-work is a sha256 puzzle your machine solves in a fraction of a second. Nothing here consumes AI tokens. Tools like <code>/api/extract</code> exist to <em>save</em> your tokens: clean markdown out instead of 100k tokens of raw HTML in.</span></p>
      <p><b>Can I use Agent402 from OpenAI / Anthropic / LangChain / LlamaIndex / Vercel AI SDK?</b><br><span>Yes — there's a zero-dependency adapter on npm for each: <code><a href="https://www.npmjs.com/package/agent402-openai-tools" rel="noopener">agent402-openai-tools</a></code>, <code><a href="https://www.npmjs.com/package/agent402-anthropic-tools" rel="noopener">agent402-anthropic-tools</a></code>, <code><a href="https://www.npmjs.com/package/agent402-ai-sdk" rel="noopener">agent402-ai-sdk</a></code>, <code><a href="https://www.npmjs.com/package/agent402-langchain" rel="noopener">agent402-langchain</a></code>, and <code><a href="https://www.npmjs.com/package/agent402-llamaindex" rel="noopener">agent402-llamaindex</a></code>. Each returns ready-to-pass tool objects in the framework's native shape — payment handled underneath (proof-of-work for free tools, USDC via x402 for wallet-only). MCP-based clients (Claude) can still use the hosted <code>/mcp</code> connector directly.</span></p>
      <p><b>How do I see which x402 sellers are most used?</b><br><span><code><a href="/api/leaderboard">GET /api/leaderboard</a></code> returns the live on-chain ranking by Base USDC settled volume — calls served, totalUsd, unique buyers per seller. The pipeline walks every page of the Coinbase CDP Bazaar, queries <code>eth_getLogs</code> on Base USDC for each seller's payTo, filters per-call settlements within a $0.50 ceiling (larger inbound is funding, not buys), and aggregates. Hourly snapshot. Free. Use <code>?include=external</code> to exclude Agent402 itself.</span></p>
    </div>
  </section>

</div>
${renderFooter()}
</body>
</html>`;
}
