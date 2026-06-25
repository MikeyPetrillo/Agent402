import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const ENTRIES = [
  {
    date: "2026-06-24",
    title: "LLM vision, structured output, and content moderation",
    items: [
      "Vision: send up to 2 image URLs to any LLM tier — screenshot analysis, chart reading, image Q&A",
      "Structured output: response_format with json_object or json_schema for guaranteed valid JSON",
      "Content moderation: /api/moderate ($0.002) — check text for harmful content across 13 categories",
      "All guardrails enforced server-side: image count limits, schema size caps, data: URI blocking",
    ],
  },
  {
    date: "2026-06-24",
    title: "Full AI suite — TTS, STT, embeddings via x402",
    items: [
      "Text-to-speech: /api/tts ($0.05) and /api/tts-hd ($0.10) — 10 voices, 6 audio formats",
      "Speech-to-text: /api/transcribe ($0.03) and /api/transcribe-pro ($0.10) — URL-based audio input",
      "Embeddings: /api/embed ($0.005) and /api/embed-large ($0.01) — 1536 or 3072 dimensions for RAG and search",
      "No API key needed — pay per call with USDC on Base",
      "Self-hosters: bring your own upstream key to run these for free",
    ],
  },
  {
    date: "2026-06-24",
    title: "Code execution sandbox — Python/JS via x402",
    items: [
      "Run Python or JavaScript in isolated cloud sandboxes: /api/code-run ($0.02) and /api/code-run-pro ($0.05)",
      "Returns stdout, stderr, expression result, and error traceback",
      "Pro tier: 60s timeout and 50k char code limit for longer computations",
      "Each call runs in a fresh, isolated VM — nothing persists between calls",
    ],
  },
  {
    date: "2026-06-24",
    title: "Image generation gateway — 3-tier GPT Image via x402",
    items: [
      "Generate images: /api/image-gen ($0.03), /api/image-gen-hd ($0.10), /api/image-gen-premium ($0.30)",
      "Text-to-image — no API key needed, pay per call, returns base64 PNG",
      "Three quality tiers from fast drafts to high-fidelity output",
    ],
  },
  {
    date: "2026-06-24",
    title: "LLM proxy gateway — 3-tier inference via x402",
    items: [
      "Chat completions: /api/llm ($0.01), /api/llm-pro ($0.10), /api/llm-premium ($0.50)",
      "OpenAI-format interface — no API key needed, pay per call",
      "Models: GPT-4o-mini, GPT-4o, GPT-4.1, o3, o3-mini",
    ],
  },
  {
    date: "2026-06-23",
    title: "Reliability improvements and observability",
    items: [
      "Per-tool analytics: every call now tracked with latency, cache, and error metrics",
      "Improved upstream reliability for finance and government data tools",
      "Automatic retry on transient network failures for market data endpoints",
    ],
  },
  {
    date: "2026-06-23",
    title: "Developer experience and SEO improvements",
    items: [
      "Proper caching headers on static and discovery routes for faster loads",
      "/health endpoint now reports tool count, uptime, and mode",
      "Expanded sitemap with blog posts, adapter docs, and webhook pages",
      "Wiki and docs navigation updated with new developer resources",
    ],
  },
  {
    date: "2026-06-23",
    title: "Crypto-hash, string, and calendar kits — 15 new tools",
    items: [
      "Crypto-hash kit: PBKDF2, scrypt, HKDF, constant-time compare, CRC32/Adler32 checksums",
      "String kit: Jaccard similarity, case conversion, fuzzy matching, character frequency, word wrap",
      "Calendar kit: ISO week numbers, leap year check, Easter date, epoch conversion, day-of-year",
      "Google ADK adapter published — agent402-google-adk on npm",
    ],
  },
  {
    date: "2026-06-22",
    title: "Validation, encoding, and math kits — 15 new tools",
    items: [
      "Validation kit: phone formatting, XML validation, CSV linting, base detection, IPv6 expansion",
      "Encoding kit: Punycode, NATO phonetic, Soundex, binary-text, Braille conversion",
      "Math kit: Roman numerals, Fibonacci, primality check, GCD/LCM, number base conversion",
    ],
  },
  {
    date: "2026-06-21",
    title: "Decode-blob and trend-analysis skill packs",
    items: [
      "decode-blob skill pack — automatically detect and decode JWT, gzip, brotli, base64, or hex blobs",
      "trend-analysis skill pack — fetch data, summarize, smooth, detect trends, flag anomalies, benchmark",
      "Compression kit: 5 tools for gzip, brotli, and deflate compression/decompression",
      "Stats kit: 5 tools for summary statistics, correlation, regression, moving averages, and outlier detection",
    ],
  },
  {
    date: "2026-06-20",
    title: "Security-audit and structured-scrape skill packs",
    items: [
      "security-audit skill pack — 7-tool domain audit covering DNS, TLS, WHOIS, HTTP, headers, SPF, and robots.txt",
      "structured-scrape skill pack — render a page and extract structured data in one workflow",
      "HTML kit: 5 tools for extracting text, elements, links, tables, and headings from HTML",
    ],
  },
  {
    date: "2026-06-19",
    title: "x402 economy dashboard and leaderboard",
    items: [
      "/economy — daily x402 ecosystem volume, concentration, and network breakdown",
      "/leaderboard — public on-chain ranking of x402 sellers by Base USDC settled volume",
      "/api/leaderboard — machine-readable seller rankings",
      "Smart Order Router (/api/route) — find the cheapest healthy tool across the x402 ecosystem",
    ],
  },
  {
    date: "2026-06-18",
    title: "Docs hub, analytics dashboard, and caching",
    items: [
      "/docs — wiki content rendered on-site with sidebar navigation",
      "/analytics — live tool-level call counts, error rates, and latency percentiles",
      "Server-side response caching with cache-hit headers for supported routes",
      "Idempotency support — Idempotency-Key header prevents double-charging on retries",
    ],
  },
  {
    date: "2026-06-17",
    title: "Tollbooth Cloud and framework adapters",
    items: [
      "Tollbooth Cloud — hosted multi-site pay-per-crawl dashboard",
      "8 framework adapters on npm: OpenAI, Anthropic, Vercel AI SDK, LangChain, LlamaIndex, Google ADK, OpenAI Agents, AWS Strands",
      "agent402-client SDK — find() + call() with auto-payment",
    ],
  },
];

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

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", url: baseUrl },
  };

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

  const extraCss = `
.cl-wrap{max-width:1180px;margin:0 auto;padding:56px 30px;}
.cl-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:10px;}
.cl-wrap h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;}
.cl-desc{font-size:15px;line-height:1.55;color:var(--muted);margin:0 0 40px;max-width:640px;}
.cl-rss{font-family:var(--font-mono);font-size:13px;color:var(--accent);text-decoration:none;display:inline-block;margin-bottom:32px;}
.cl-rss:hover{text-decoration:underline;}
.timeline{position:relative;padding-left:28px;}
.timeline::before{content:"";position:absolute;left:7px;top:0;bottom:0;width:1.5px;background:var(--hairline);}
.tl-entry{position:relative;margin-bottom:24px;}
.tl-dot{position:absolute;left:-28px;top:8px;width:16px;height:16px;background:var(--accent);border:3px solid var(--paper);}
.tl-card{background:var(--card);border:1.5px solid var(--ink);padding:20px 24px;}
.tl-date{display:inline-block;font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:4px;}
.tl-card h2{font-family:var(--font-body);font-weight:800;font-size:20px;line-height:1.15;letter-spacing:-.02em;margin:4px 0 12px;color:var(--ink);}
.tl-card ul{margin:0;padding-left:20px;color:var(--muted);font-size:15px;line-height:1.55;}
.tl-card li{margin-bottom:5px;}
.tl-card li:last-child{margin-bottom:0;}
@media(max-width:600px){.cl-wrap h1{font-size:40px;}.tl-card{padding:16px 18px;}}
`;

  const body = `<div class="cl-wrap">
  <div class="cl-eyebrow">$ GET /changelog</div>
  <h1>Changelog</h1>
  <p class="cl-desc">${esc(description)}</p>
  <a class="cl-rss" href="${baseUrl}/changelog.xml">RSS feed</a>
  <div class="timeline">
${timelineHtml}
  </div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title, description, canonical, baseUrl, activePath: "__none__", jsonLd, extraCss, body });
}
