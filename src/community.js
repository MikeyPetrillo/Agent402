import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

// Real, free-to-read outputs of the product (assets/samples), never placeholders.
const SHOWCASE_PROJECTS = [
  { title: "Company due-diligence dossier: NVDA", description: "Filings, financial trend, insider and institutional activity, litigation and risk themes, 20 cited sources. Read the real report at /reports/sample/dossier.", badge: "Live sample", href: "/reports/sample/dossier" },
  { title: "Insider flow report: NVDA", description: "Every Form 4 in the window parsed and explained: open-market buys and sales against awards and exercises, per insider. /reports/sample/insider-report.", badge: "Live sample", href: "/reports/sample/insider-report" },
  { title: "Domain security audit: github.com", description: "Email authentication, TLS, headers and DNS posture graded A to F with the evidence. /reports/sample/domain-audit.", badge: "Live sample", href: "/reports/sample/domain-audit" },
  { title: "Deep research: airline jet-fuel hedging", description: "A cited answer to a real question, built from live sources with the full-text pages read. /reports/sample/research.", badge: "Live sample", href: "/reports/sample/research" },
];

export function communityPage(baseUrl) {
  const canonical = `${baseUrl}/community`;
  const pageTitle = "Community - Agent402 ecosystem";
  const pageDesc = "Join the Agent402 community: contribute tool kits, write guides, and build autonomous agents with 500+ web tools on the x402 protocol.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: pageTitle,
    description: pageDesc,
    url: canonical,
  };

  const statCards = [
    { value: "500+", label: "tools" },
    { value: "8", label: "framework adapters" },
    { value: "Open source", label: "AGPL-3.0 licensed" },
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
        <h3>${p.href ? `<a href="${esc(p.href)}" style="color:inherit;text-decoration:none;">${esc(p.title)} →</a>` : esc(p.title)}</h3>
        <p class="cm-card-desc">${esc(p.description)}</p>
      </div>`).join("\n");

  const extraCss = `
.cm-wrap{max-width:960px;margin:0 auto;padding:56px 30px}
.cm-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}

/* hero */
.cm-hero{text-align:center;padding:0 0 32px}
.cm-hero h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px;color:var(--ink)}
.cm-hero p{font-size:15px;line-height:1.55;color:var(--muted);max-width:620px;margin:0 auto}

/* section headings */
.cm-section{margin:40px 0 18px}
.cm-section h2{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0 0 6px;color:var(--ink)}
.cm-section p{color:var(--muted);font-size:15px;line-height:1.55;margin:0}

/* stat cards */
.cm-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
@media(max-width:640px){.cm-stats{grid-template-columns:repeat(2,1fr)}.cm-hero h1{font-size:36px !important}}
.cm-stat{background:var(--card);border:1px solid var(--hairline);padding:20px 22px;text-align:center}
.cm-stat-value{font-size:24px;font-weight:700;color:var(--accent);font-family:var(--font-mono);margin-bottom:4px}
.cm-stat-label{font-size:14px;color:var(--muted)}

/* card grid */
.cm-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:32px}
@media(max-width:800px){.cm-grid-3{grid-template-columns:1fr}}
.cm-grid-4{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;margin-bottom:32px}
@media(max-width:640px){.cm-grid-4{grid-template-columns:1fr}}
.cm-card{background:var(--card);border:1px solid var(--hairline);padding:22px 24px}
.cm-card h3{margin:0 0 8px;font-family:var(--font-body);font-weight:800;font-size:18px;color:var(--ink)}
.cm-card-desc{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 12px}
.cm-card-link{color:var(--accent);text-decoration:none;font-family:var(--font-mono);font-size:13px;font-weight:700}
.cm-card-link:hover{text-decoration:underline}

/* showcase badge */
.cm-showcase{position:relative}
.cm-badge{display:inline-block;background:var(--surface);color:var(--on-dark);font-family:var(--font-mono);font-size:11px;font-weight:700;padding:3px 10px;margin-bottom:10px;letter-spacing:.04em;text-transform:uppercase}

/* cta */
.cm-cta{text-align:center;margin:40px 0 48px}
.cm-cta a{display:inline-block;background:var(--accent);color:var(--on-accent);font-family:var(--font-mono);font-weight:700;text-decoration:none;font-size:14px;padding:14px 30px;border:1.5px solid var(--accent)}
.cm-cta a:hover{opacity:.9}
`;

  const body = `
<div class="cm-wrap">
<section>
<div class="cm-eyebrow">$ GET /community</div>

<div class="cm-hero">
  <h1>Built by the community</h1>
  <p>Agent402 is open source and built in the open. Explore the ecosystem, connect with other builders, and contribute tools, guides, and integrations.</p>
</div>
</section>

<section>
<div class="cm-section"><h2>Ecosystem</h2></div>
<div class="cm-stats">
${statsHtml}
</div>
</section>

<section>
<div class="cm-section">
  <h2>Where to find us</h2>
  <p>Follow development, ask questions, and stay up to date.</p>
</div>
<div class="cm-grid-3">
${channelsHtml}
</div>
</section>

<section>
<div class="cm-section">
  <h2>How to contribute</h2>
  <p>Every contribution makes the platform better for every agent.</p>
</div>
<div class="cm-grid-3">
${contributeHtml}
</div>
</section>

<section>
<div class="cm-section">
  <h2>Showcase</h2>
  <p>Example projects built on Agent402. Have something to share? Open a PR to add it.</p>
</div>
<div class="cm-grid-4">
${showcaseHtml}
</div>
</section>

<section>
<div class="cm-cta"><a href="/quickstart">Start building &rarr;</a></div>
</section>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "/community", jsonLd, extraCss, body });
}
