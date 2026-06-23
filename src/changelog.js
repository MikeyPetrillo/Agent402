import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const ENTRIES = [
  {
    date: "2026-06-23",
    title: "Crypto-hash, string, and calendar kits — 15 new tools (1,323 total)",
    items: [
      "crypto-hash-kit: pbkdf2, scrypt-derive, hkdf-expand, constant-compare, checksum (CRC32/Adler32)",
      "string-kit: jaccard-similarity, case-convert, string-similarity, char-frequency, word-wrap",
      "calendar-kit: iso-week, leap-year, easter-date, epoch-convert, day-of-year",
      "Google ADK adapter published — agent402-google-adk on npm",
      "MCP package bumped to 0.9.0 with all new tools",
    ],
  },
  {
    date: "2026-06-22",
    title: "Validation, encoding, and math kits — 15 new tools",
    items: [
      "validation-kit: phone-format, xml-validate, csv-lint, base-detect, ipv6-expand",
      "encoding-kit: punycode-convert, nato-phonetic, soundex, binary-text, braille-convert",
      "math-kit: roman-numeral, fibonacci, prime-check, gcd-lcm, number-base",
      "951 tools registered on the Coinbase CDP Bazaar",
    ],
  },
  {
    date: "2026-06-21",
    title: "Decode-blob and trend-analysis skill packs",
    items: [
      "decode-blob skill pack — JWT / gzip / brotli / base64 / hex decision tree",
      "trend-analysis skill pack — fetch, describe, smooth, trend, anomalies, benchmark",
      "Compression kit: 5 tools (gzip, brotli, deflate) pure CPU on node:zlib",
      "Stats kit: 5 tools (summary, correlation, regression, MA, outliers)",
    ],
  },
  {
    date: "2026-06-20",
    title: "Security-audit and structured-scrape skill packs",
    items: [
      "security-audit skill pack — 7-tool domain audit (DNS, TLS, WHOIS, HTTP, headers, SPF, robots)",
      "structured-scrape skill pack — ties html-kit to render + extract for deterministic scraping",
      "HTML kit: 5 tools (html-to-text, html-select, html-links, html-table, html-headings)",
    ],
  },
  {
    date: "2026-06-19",
    title: "Economy dashboard and leaderboard",
    items: [
      "/economy page — daily x402 ecosystem volume, concentration, network split",
      "/leaderboard — on-chain ranking of x402 sellers by Base USDC settled volume",
      "/api/leaderboard — machine-readable seller rankings (also MCP tool top_x402_sellers)",
      "Smart Order Router (/api/route) — neutral cross-seller discovery",
    ],
  },
  {
    date: "2026-06-18",
    title: "Docs hub, analytics dashboard, Redis cache layer",
    items: [
      "/docs hub — wiki content rendered on-site with sidebar navigation",
      "/analytics dashboard — tool-level call counts, error rates, latency percentiles",
      "Redis cache layer (CACHEABLE_ROUTES) — opt-in server-side caching with X-Cache headers",
      "Idempotency support — Idempotency-Key header prevents double-charging on retries",
    ],
  },
  {
    date: "2026-06-17",
    title: "Tollbooth Cloud and framework adapters",
    items: [
      "Tollbooth Cloud — hosted multi-site pay-per-crawl dashboard (Solo/Team/Agency/Enterprise)",
      "8 framework adapters published on npm (OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents, AWS Strands)",
      "agent402-client SDK — find() + call() with auto-payment",
    ],
  },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function changelogRss(baseUrl) {
  const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = ENTRIES.map((e) =>
    `  <item>
    <title>${xmlEsc(e.title)}</title>
    <link>${baseUrl}/changelog</link>
    <guid isPermaLink="false">agent402-changelog-${e.date}</guid>
    <pubDate>${new Date(e.date + "T12:00:00Z").toUTCString()}</pubDate>
    <description>${xmlEsc(e.items.join(". ") + ".")}</description>
  </item>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Agent402 Changelog</title>
  <link>${baseUrl}/changelog</link>
  <description>Recent additions to Agent402: new tools, skill packs, framework adapters, and platform features.</description>
  <language>en</language>
  <atom:link href="${baseUrl}/changelog.xml" rel="self" type="application/rss+xml"/>
${items}
</channel>
</rss>`;
}

export function changelogPage(baseUrl) {
  const canonical = `${baseUrl}/changelog`;
  const title = "Changelog — what's new at Agent402";
  const description = "Recent additions to Agent402: new tools, skill packs, framework adapters, and platform features.";

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", url: baseUrl },
  });

  const timelineHtml = ENTRIES.map((entry) => {
    const itemsHtml = entry.items.map((item) => `<li>${esc(item)}</li>`).join("\n              ");
    return `
          <div class="tl-entry">
            <div class="tl-dot"></div>
            <div class="tl-card">
              <span class="tl-date">${esc(entry.date)}</span>
              <h2>${esc(entry.title)}</h2>
              <ul>
              ${itemsHtml}
              </ul>
            </div>
          </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<link rel="canonical" href="${esc(canonical)}"/>
<link rel="alternate" type="application/rss+xml" title="Agent402 Changelog" href="${baseUrl}/changelog.xml"/>
${CHROME_HEAD_LINKS}
<script type="application/ld+json">${jsonLd}</script>
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.6}
.crumb{max-width:960px;margin:0 auto;padding:1rem 1.5rem 0;font-size:.85rem;color:var(--muted)}
.crumb a{color:var(--accent);text-decoration:none}
.crumb a:hover{text-decoration:underline}
.page-title{max-width:960px;margin:0 auto;padding:1.5rem 1.5rem .5rem}
.page-title h1{font-size:1.6rem;margin:0 0 .25rem;color:var(--text)}
.page-title p{margin:0;color:var(--muted);font-size:.95rem}
.timeline{max-width:960px;margin:2rem auto 3rem;padding:0 1.5rem;position:relative}
.timeline::before{content:"";position:absolute;left:calc(1.5rem + 7px);top:0;bottom:0;width:2px;background:var(--card)}
.tl-entry{position:relative;padding-left:2.5rem;margin-bottom:1.5rem}
.tl-dot{position:absolute;left:0;top:.6rem;width:16px;height:16px;border-radius:50%;background:var(--accent);border:3px solid var(--bg);z-index:1}
.tl-card{background:var(--card);border-radius:8px;padding:1.25rem 1.5rem}
.tl-date{display:inline-block;font-family:var(--mono);font-size:.78rem;color:var(--accent);margin-bottom:.25rem}
.tl-card h2{font-size:1.1rem;margin:.15rem 0 .75rem;color:var(--text);font-weight:600}
.tl-card ul{margin:0;padding-left:1.25rem;color:var(--muted);font-size:.9rem}
.tl-card li{margin-bottom:.35rem}
.tl-card li:last-child{margin-bottom:0}
@media(max-width:600px){.page-title h1{font-size:1.3rem}.tl-card{padding:1rem}}
</style>
</head>
<body>
${renderHeader("/changelog")}
<div class="crumb"><a href="/">Agent402</a> / changelog</div>
<div class="page-title">
  <h1>Changelog</h1>
  <p>${esc(description)}</p>
</div>
<div class="timeline">
${timelineHtml}
</div>
${renderFooter()}
</body>
</html>`;
}
