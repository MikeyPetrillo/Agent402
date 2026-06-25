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
import { ledgerShell, ledgerFooterCompact, esc as ledgerEsc } from "./ledger-chrome.js";
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
  .sh-task { background:var(--card); border:1.5px solid var(--ink); padding:20px 22px; margin:14px 0; }
  .sh-task h2 { font-family:var(--font-body); font-weight:800; font-size:18px; margin:0 0 6px; }
  .sh-task-answer { color:var(--muted); font-size:14px; margin-bottom:10px; line-height:1.6; }
  .sh-task-primary { font-size:15px; margin-bottom:4px; }
  .sh-task-name { color:var(--ink); text-decoration:none; font-weight:700; }
  .sh-task-name:hover { color:var(--accent); }
  .sh-task-price { color:var(--faint); font-family:var(--font-mono); font-size:12px; margin-left:10px; }
  .sh-task-alts { color:var(--faint); font-size:13px; margin-top:4px; }
  .sh-task-alts a { color:var(--muted); text-decoration:none; }
  .sh-task-alts a:hover { color:var(--accent); }
  .sh-task-example { margin-top:8px; }
  .sh-task-example code { background:var(--ink); color:var(--cream); padding:4px 10px; font-family:var(--font-mono); font-size:12px; }
  .sh-missing { background:var(--card); border:1.5px solid var(--accent); padding:10px 14px; margin:12px 0; font-size:14px; color:var(--accent); }
  .sh-free { display:inline-block; background:var(--green); color:#08130b; font-weight:700; font-size:11px; letter-spacing:.02em; padding:1px 7px; font-family:var(--font-mono); }
`;

export function shopPage(baseUrl, catalog) {
  const e = ledgerEsc;
  const canonical = `${baseUrl}/shop`;
  const title = "Agent402 shop — pay-per-call APIs indexed by what an agent wants to do";
  const description =
    "Task-indexed catalogue of Agent402's machine-payable APIs: research a company, get macro data, read the web, track markets, persist state. Pay per call in USDC on Base, or free with proof-of-work.";

  const missingSlugs = TASKS.flatMap((t) =>
    t.slugs.filter((s) => !Object.values(catalog).find((c) => c.slug === s))
  );
  const missingNotice = missingSlugs.length
    ? `<div class="sh-missing">Note: ${missingSlugs.length} tool slug(s) listed here are no longer in the catalog: <code style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);padding:2px 6px;font-size:13px;">${e(missingSlugs.join(", "))}</code>. Rest of the page is still accurate.</div>`
    : "";

  const tasks = TASKS.map((t) => renderTaskLedger(t, catalog)).join("\n");

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

  const body = `<div style="max-width:1180px;margin:0 auto;padding:56px 30px;">
  <div style="font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;">SHOP</div>
  <h1 style="font-family:var(--font-body);font-weight:800;font-size:42px;line-height:.96;letter-spacing:-.03em;margin-bottom:14px;">What does your agent want to do?</h1>
  <p style="color:var(--muted);font-size:16px;line-height:1.6;max-width:720px;margin-bottom:8px;">A task-indexed buyer's guide to the ${Object.keys(catalog).length.toLocaleString()} APIs at Agent402 — written from the agent's side of the call. Each row maps a real goal to the cheapest tool that solves it. Browse the full category-organized catalogue at <a href="/tools" style="color:var(--accent);">/tools</a>, walk the multi-tool workflows at <a href="/skills" style="color:var(--accent);">/skills</a>, or ask the discovery endpoint directly: <code style="background:var(--ink);color:var(--cream);font-family:var(--font-mono);padding:2px 6px;font-size:13px;">/api/find?q=&lt;your task&gt;</code>.</p>
  ${missingNotice}
  ${tasks}
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/shop",
    jsonLd,
    extraCss: SHOP_CSS,
    body,
  });
}

function renderTaskLedger(task, catalog) {
  const e = ledgerEsc;
  const tools = task.slugs
    .map((slug) => Object.values(catalog).find((t) => t.slug === slug))
    .filter(Boolean);
  const primary = tools[0];
  const others = tools.slice(1);
  const extra = (task.extraLinks ?? [])
    .map((l) => `<a href="${e(l.href)}" style="color:var(--accent);text-decoration:none;">${e(l.label)}</a>`)
    .join(" · ");
  const primaryBlock = primary
    ? `<div class="sh-task-primary">
        <a href="/tools/${e(primary.slug)}" class="sh-task-name">${e(primary.name)}</a>
        <span class="sh-task-price">${shopPriceTag(primary)}</span>
      </div>`
    : extra
      ? `<div class="sh-task-primary"><span class="sh-task-name">${extra}</span></div>`
      : "";
  const othersBlock = others.length
    ? `<div class="sh-task-alts">also: ${others
        .map((t) => `<a href="/tools/${e(t.slug)}">${e(t.name)}</a>`)
        .join(" \u00b7 ")}</div>`
    : "";
  const exampleBlock = task.example
    ? `<div class="sh-task-example"><code>GET ${e(task.example)}</code></div>`
    : "";

  return `<section class="sh-task">
    <h2>${e(task.goal)}</h2>
    <p class="sh-task-answer">${e(task.answer)}</p>
    ${primaryBlock}
    ${othersBlock}
    ${exampleBlock}
  </section>`;
}

function shopPriceTag(tool) {
  return isComputePayable(tool)
    ? `<span class="sh-free">FREE w/ PoW</span> \u00b7 ${esc(tool.price)}`
    : `${esc(tool.price)}`;
}
