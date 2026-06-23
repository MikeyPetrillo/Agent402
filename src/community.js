import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const SHOWCASE_PROJECTS = [
  {
    title: "Research Agent",
    description: "Overnight batch analysis of SEC filings, earnings, and market data for 50+ companies.",
    badge: "Coming soon",
  },
  {
    title: "Security Scanner",
    description: "Automated domain security audits: DNS, TLS, WHOIS, SPF/DKIM, and HTTP headers in one pass.",
    badge: "Coming soon",
  },
  {
    title: "Data Pipeline",
    description: "Extract, transform, and validate structured data from hundreds of PDFs and web pages.",
    badge: "Coming soon",
  },
  {
    title: "Content Monitor",
    description: "Daily price and content tracking across competitor sites with change-detection alerts.",
    badge: "Coming soon",
  },
];

export function communityPage(baseUrl) {
  const canonical = `${baseUrl}/community`;
  const pageTitle = "Community — Agent402 ecosystem";
  const pageDesc = "Join the Agent402 community: contribute tool kits, write guides, and build autonomous agents with 1,323 deterministic web tools on the x402 protocol.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: pageTitle,
    description: pageDesc,
    url: canonical,
  };

  const statCards = [
    { value: "1,323", label: "tools" },
    { value: "8", label: "framework adapters" },
    { value: "Open source", label: "MIT licensed" },
    { value: "x402", label: "protocol" },
  ];

  const channels = [
    {
      title: "GitHub",
      description: "Source code, issues, and pull requests. Star the repo and follow development.",
      href: "https://github.com/MikeyPetrillo/Agent402",
      linkText: "View repository",
    },
    {
      title: "X / Twitter",
      description: "Announcements, releases, and ecosystem updates from @Agent402Tools.",
      href: "https://x.com/Agent402Tools",
      linkText: "Follow @Agent402Tools",
    },
    {
      title: "npm packages",
      description: "agent402-mcp (MCP server), agent402-client (buyer SDK), agent402-tollbooth (pay-per-crawl).",
      href: "https://www.npmjs.com/search?q=agent402",
      linkText: "Browse on npm",
    },
  ];

  const contributeCards = [
    {
      title: "Add a tool kit",
      description: "Build a new deterministic tool kit and submit a PR. Every tool must answer its own example.",
      href: "/contribute",
      linkText: "Contributor guide",
    },
    {
      title: "Write a guide",
      description: "Document a workflow, integration pattern, or deployment recipe for other builders.",
      href: "/contribute",
      linkText: "Contributor guide",
    },
    {
      title: "Report a bug",
      description: "Found something broken? Open an issue on GitHub with reproduction steps.",
      href: "https://github.com/MikeyPetrillo/Agent402/issues",
      linkText: "Open an issue",
    },
  ];

  const statsHtml = statCards.map((s) => `
      <div class="cm-stat">
        <div class="cm-stat-value">${esc(s.value)}</div>
        <div class="cm-stat-label">${esc(s.label)}</div>
      </div>`).join("\n");

  const channelsHtml = channels.map((c) => `
      <div class="cm-card">
        <h3>${esc(c.title)}</h3>
        <p class="cm-card-desc">${esc(c.description)}</p>
        <a class="cm-card-link" href="${esc(c.href)}" rel="noopener">${esc(c.linkText)} &rarr;</a>
      </div>`).join("\n");

  const contributeHtml = contributeCards.map((c) => `
      <div class="cm-card">
        <h3>${esc(c.title)}</h3>
        <p class="cm-card-desc">${esc(c.description)}</p>
        <a class="cm-card-link" href="${esc(c.href)}" rel="noopener">${esc(c.linkText)} &rarr;</a>
      </div>`).join("\n");

  const showcaseHtml = SHOWCASE_PROJECTS.map((p) => `
      <div class="cm-card cm-showcase">
        <span class="cm-badge">${esc(p.badge)}</span>
        <h3>${esc(p.title)}</h3>
        <p class="cm-card-desc">${esc(p.description)}</p>
      </div>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(pageDesc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(pageDesc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(pageTitle)}">
<meta name="twitter:description" content="${esc(pageDesc)}">
${CHROME_HEAD_LINKS}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
${CHROME_CSS}
:root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif}

.breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.breadcrumb a{color:var(--accent);text-decoration:none}
.breadcrumb a:hover{text-decoration:underline}

/* hero */
.cm-hero{text-align:center;padding:2.5rem 0 2rem}
.cm-hero h1{font-size:2rem;margin:0 0 .75rem;color:var(--text);font-weight:700}
.cm-hero p{color:var(--muted);font-size:1.05rem;line-height:1.7;max-width:620px;margin:0 auto}

/* section headings */
.cm-section{margin:2.5rem 0 1.25rem}
.cm-section h2{font-size:1.3rem;color:var(--text);font-weight:600;margin:0 0 .5rem}
.cm-section p{color:var(--muted);font-size:.93rem;line-height:1.6;margin:0}

/* stat cards */
.cm-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:2rem}
@media(max-width:640px){.cm-stats{grid-template-columns:repeat(2,1fr)}}
.cm-stat{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.25rem 1.4rem;text-align:center}
.cm-stat-value{font-size:1.5rem;font-weight:700;color:var(--accent);font-family:var(--mono);margin-bottom:.3rem}
.cm-stat-label{font-size:.85rem;color:var(--muted)}

/* card grid */
.cm-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem;margin-bottom:2rem}
@media(max-width:800px){.cm-grid-3{grid-template-columns:1fr}}
.cm-grid-4{display:grid;grid-template-columns:repeat(2,1fr);gap:1.25rem;margin-bottom:2rem}
@media(max-width:640px){.cm-grid-4{grid-template-columns:1fr}}
.cm-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.4rem 1.5rem}
.cm-card h3{margin:0 0 .6rem;font-size:1.05rem;color:var(--text);font-weight:600}
.cm-card-desc{color:var(--muted);font-size:.9rem;line-height:1.6;margin:0 0 .75rem}
.cm-card-link{color:var(--accent);text-decoration:none;font-size:.88rem;font-weight:500}
.cm-card-link:hover{text-decoration:underline}

/* showcase badge */
.cm-showcase{position:relative}
.cm-badge{display:inline-block;background:rgba(74,222,128,.12);color:var(--accent);font-size:.72rem;font-weight:600;padding:3px 9px;border-radius:6px;margin-bottom:.6rem;letter-spacing:.02em;text-transform:uppercase}

/* cta */
.cm-cta{text-align:center;margin:2.5rem 0 3rem}
.cm-cta a{display:inline-block;background:var(--accent);color:#0b0e14;font-weight:600;text-decoration:none;font-size:1rem;padding:12px 28px;border-radius:8px}
.cm-cta a:hover{opacity:.9}
</style>
</head>
<body>
${renderHeader("/community")}
<main style="max-width:960px;margin:0 auto;padding:2rem 1.25rem">
<p class="breadcrumb"><a href="/">Home</a> &rsaquo; Community</p>

<div class="cm-hero">
  <h1>Built by the community</h1>
  <p>Agent402 is open source and built in the open. Explore the ecosystem, connect with other builders, and contribute tools, guides, and integrations.</p>
</div>

<div class="cm-section"><h2>Ecosystem</h2></div>
<div class="cm-stats">
${statsHtml}
</div>

<div class="cm-section">
  <h2>Where to find us</h2>
  <p>Follow development, ask questions, and stay up to date.</p>
</div>
<div class="cm-grid-3">
${channelsHtml}
</div>

<div class="cm-section">
  <h2>How to contribute</h2>
  <p>Every contribution makes the platform better for every agent.</p>
</div>
<div class="cm-grid-3">
${contributeHtml}
</div>

<div class="cm-section">
  <h2>Showcase</h2>
  <p>Example projects built on Agent402. Have something to share? Open a PR to add it.</p>
</div>
<div class="cm-grid-4">
${showcaseHtml}
</div>

<div class="cm-cta"><a href="/quickstart">Start building &rarr;</a></div>
</main>
${renderFooter()}
</body>
</html>`;
}
