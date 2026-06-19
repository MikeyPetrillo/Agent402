// /shop — task-first buyer surface. The /tools page organizes by category
// (web, data, payments...) which is the SELLER's mental model. /shop
// flips it to the BUYER's: "I am an agent and I want to do X." Each
// row maps a real agent goal to the 1–3 tools that solve it cheapest.
//
// This is intentionally hand-curated (small list, high signal) rather
// than auto-generated from tags. Generated lists end up with everything
// in them; curated lists end up with the one or two right answers.
//
// Bundles point at slugs that must exist in CATALOG. If a slug here
// goes missing the page silently drops the row — better than a 500 —
// and the missing tool shows up as a soft-warning at the top.

import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";
import { isComputePayable } from "./pow.js";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Each task: a clear agent goal, a one-line buyer-framed answer, the
// slug(s) that solve it. First slug is primary; rest are alternatives or
// "stage 2" tools the agent might call after the first one.
const TASKS = [
  {
    goal: "Research a public company",
    answer: "One call returns the latest 10-K/10-Q/8-K filings, recent insider trades, live stock quote, and current news headlines.",
    slugs: ["research-company", "edgar-filings", "edgar-company-facts", "stock-quote"],
    example: "/api/research-company?ticker=AAPL",
  },
  {
    goal: "Get a snapshot of the US economy",
    answer: "Fresh FRED indicators (CPI, unemployment, Fed funds), Treasury yield curve, and FX rates — all from official feeds, no signup.",
    slugs: ["cpi-yoy", "unemployment-rate", "fed-funds", "treasury-yield-curve", "yield-curve-spread", "sahm-rule"],
    example: "/api/cpi-yoy",
  },
  {
    goal: "Read a webpage as clean markdown",
    answer: "Article extraction strips boilerplate to title + byline + body markdown. Use render if you need post-JS DOM.",
    slugs: ["extract", "render", "screenshot", "meta"],
    example: "/api/extract",
  },
  {
    goal: "Search the live web",
    answer: "Independent web search, with separate news and image surfaces — and an `answer` tool that returns a cited synthesis instead of a link list.",
    slugs: ["search", "answer", "search-news", "search-images", "search-suggest"],
    example: "/api/search?q=federal+reserve",
  },
  {
    goal: "Track crypto markets",
    answer: "Live prices, market-cap rankings, history, and global dominance — keyless, batched, no rate-limit headaches.",
    slugs: ["crypto-price", "crypto-market", "crypto-history", "crypto-trending", "crypto-global"],
    example: "/api/crypto-price?ids=BTC,ETH",
  },
  {
    goal: "Track equities",
    answer: "Live quote, OHLCV history, and earnings calendar — works for stocks, indices, FX, and crypto symbols via Yahoo's chart endpoint.",
    slugs: ["stock-quote", "stock-history", "earnings-calendar"],
    example: "/api/stock-quote?symbol=AAPL",
  },
  {
    goal: "Dig into SEC filings",
    answer: "Ticker → CIK, recent filings, full XBRL financial-statement history per concept, insider trades, 13F holdings, IPO calendar, full-text search.",
    slugs: ["edgar-filings", "edgar-company-facts", "edgar-xbrl-frame", "edgar-insider-trades", "edgar-13f-holdings", "edgar-recent-ipos", "edgar-search"],
    example: "/api/edgar-filings?ticker=AAPL&form=10-K",
  },
  {
    goal: "Run a domain or uptime check",
    answer: "DNS, TLS certificate inspection, WHOIS/RDAP, HTTP health, robots.txt and sitemap parsing — the boring infra primitives every agent eventually needs.",
    slugs: ["dns", "tls-cert", "whois", "http-check", "robots-check", "sitemap"],
    example: "/api/http-check?url=https://example.com",
  },
  {
    goal: "Convert or process a document",
    answer: "PDF → markdown, PDF page extraction/merge/rotate, images → PDF, PDF metadata. JSON ⇄ CSV/YAML/XML and markdown ⇄ HTML alongside.",
    slugs: ["pdf-to-markdown", "pdf-info", "pdf-merge", "pdf-extract-pages", "pdf-rotate", "images-to-pdf"],
    example: "/api/pdf-to-markdown",
  },
  {
    goal: "Persist state across calls",
    answer: "Wallet-keyed KV with TTL and atomic counters. The wallet IS the identity — no signup, no API key. Grant access to other agents by their wallet.",
    slugs: ["memory-write", "memory-read", "memory-incr", "memory-cas", "memory-grant", "memory-recall"],
    example: "/api/memory-write",
  },
  {
    goal: "Pay another x402 seller",
    answer: "Decode HTTP 402 quotes, verify settlements on Base, check USDC balances, build EIP-3009 transfer authorizations. You sign — Agent402 never touches funds.",
    slugs: ["x402-quote", "x402-verify", "usdc-balance", "transfer-authorization", "tx-status", "gas-estimate"],
    example: "/api/x402-quote",
  },
  {
    goal: "Find a tool across every x402 seller",
    answer: "/api/find ranks the local catalog plus every seller we crawl from public registries by health × price. Free, instant, no payment.",
    slugs: [],
    extraLinks: [
      { href: "/api/find?q=stock+quote", label: "Try /api/find" },
      { href: "/leaderboard", label: "Seller leaderboard" },
      { href: "/index", label: "Live index" },
    ],
  },
];

function priceTag(tool) {
  return isComputePayable(tool)
    ? `<span class="free">FREE w/ PoW</span> · ${esc(tool.price)}`
    : `<span class="paidtag">USDC</span> ${esc(tool.price)}`;
}

function renderTask(task, catalog) {
  const tools = task.slugs
    .map((slug) => Object.values(catalog).find((t) => t.slug === slug))
    .filter(Boolean);
  const primary = tools[0];
  const others = tools.slice(1);
  const extra = (task.extraLinks ?? [])
    .map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`)
    .join(" · ");
  const primaryBlock = primary
    ? `<div class="task-primary">
        <a href="/tools/${esc(primary.slug)}" class="task-name">${esc(primary.name)}</a>
        <span class="task-price">${priceTag(primary)}</span>
      </div>`
    : extra
      ? `<div class="task-primary"><span class="task-name">${extra}</span></div>`
      : "";
  const othersBlock = others.length
    ? `<div class="task-alts">also: ${others
        .map((t) => `<a href="/tools/${esc(t.slug)}">${esc(t.name)}</a>`)
        .join(" · ")}</div>`
    : "";
  const exampleBlock = task.example
    ? `<div class="task-example"><code>GET ${esc(task.example)}</code></div>`
    : "";

  return `<section class="task">
    <h2>${esc(task.goal)}</h2>
    <p class="task-answer">${esc(task.answer)}</p>
    ${primaryBlock}
    ${othersBlock}
    ${exampleBlock}
  </section>`;
}

const SHOP_CSS = `
  .shop-intro { color:var(--muted); max-width:680px; margin-bottom:8px; }
  .task { background:var(--card); border:1px solid #1e2638; border-radius:12px; padding:18px 20px; margin:14px 0; }
  .task h2 { font-size:1.1rem; margin:0 0 6px; }
  .task-answer { color:var(--muted); font-size:.92rem; margin-bottom:10px; }
  .task-primary { font-size:.95rem; margin-bottom:4px; }
  .task-name { color:var(--text); text-decoration:none; font-weight:600; }
  .task-name:hover { color:var(--accent); }
  .task-price { color:var(--muted); font-family:var(--mono); font-size:.8rem; margin-left:10px; }
  .task-alts { color:var(--muted); font-size:.82rem; margin-top:4px; }
  .task-alts a { color:#a5b4d4; text-decoration:none; }
  .task-alts a:hover { color:var(--accent); }
  .task-example { margin-top:8px; }
  .task-example code { background:#0d1220; border:1px solid #1e2638; padding:4px 10px; border-radius:6px; font-size:.78rem; color:#c9d4ec; }
  .missing { background:#2a1d10; border:1px solid #4a371d; border-radius:8px; padding:8px 12px; margin:12px 0; font-size:.85rem; color:#e0b27a; }
`;

export function shopPage(baseUrl, catalog) {
  const canonical = `${baseUrl}/shop`;
  const title = "Agent402 shop — pay-per-call APIs indexed by what an agent wants to do";
  const description =
    "Task-indexed catalogue of Agent402's machine-payable APIs: research a company, get macro data, read the web, track markets, persist state. Pay per call in USDC on Base, or free with proof-of-work.";

  const missingSlugs = TASKS.flatMap((t) =>
    t.slugs.filter((s) => !Object.values(catalog).find((c) => c.slug === s))
  );
  const missingNotice = missingSlugs.length
    ? `<div class="missing">Note: ${missingSlugs.length} tool slug(s) listed here are no longer in the catalog: <code>${esc(missingSlugs.join(", "))}</code>. Rest of the page is still accurate.</div>`
    : "";

  const tasks = TASKS.map((t) => renderTask(t, catalog)).join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Agent402 shop — tools by task",
    itemListElement: TASKS.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: t.goal,
    })),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${CHROME_HEAD_LINKS}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="Agent402">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  :root { --bg:#0b0e14; --card:#131826; --text:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:840px; margin:0 auto; padding:40px 20px 80px; }
  a { color:var(--accent); }
  h1 { font-size:1.9rem; line-height:1.2; margin-bottom:8px; }
  .crumb { font-size:.85rem; color:var(--muted); margin-bottom:18px; }
  .free { display:inline-block; background:var(--accent); color:#08130b; font-weight:700; font-size:.68rem; letter-spacing:.02em; padding:1px 7px; border-radius:999px; }
  .paidtag { display:inline-block; background:#1b2336; color:var(--muted); font-size:.68rem; padding:1px 7px; border-radius:999px; }
  ${SHOP_CSS}
  ${CHROME_CSS}
</style>
</head>
<body>
${renderHeader("/shop")}
<div class="wrap">
  <div class="crumb"><a href="/">Agent402</a> / shop</div>
  <h1>What does your agent want to do?</h1>
  <p class="shop-intro">A task-indexed buyer's guide to the 1,164 APIs at Agent402 — written from the agent's side of the call. Each row maps a real goal to the cheapest tool that solves it. Browse the full category-organized catalogue at <a href="/tools">/tools</a>, or ask the discovery endpoint directly: <code>/api/find?q=&lt;your task&gt;</code>.</p>
  ${missingNotice}
  ${tasks}
</div>
${renderFooter()}
</body>
</html>`;
}
