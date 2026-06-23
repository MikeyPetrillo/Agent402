import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

export function uptimePage(baseUrl) {
  const canonical = `${baseUrl}/status`;
  const pageTitle = "Status & Uptime — Agent402";
  const pageDesc = "Agent402 system status, uptime monitoring, and incident response. 15-minute health probes, daily paid canary tests, and automated incident management.";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: pageTitle,
    description: pageDesc,
    url: canonical,
  };

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
.breadcrumb{font-size:.85rem;color:var(--muted);margin-bottom:1.5rem}
.breadcrumb a{color:var(--accent);text-decoration:none}
.breadcrumb a:hover{text-decoration:underline}

/* Status banner */
.status-banner{background:linear-gradient(135deg,#0d2818 0%,#132a1a 100%);border:1px solid #1f4a2a;border-radius:12px;padding:2rem 2.5rem;text-align:center;margin-bottom:2.5rem}
.status-banner .status-dot{display:inline-block;width:12px;height:12px;background:var(--accent);border-radius:50%;margin-right:10px;box-shadow:0 0 8px rgba(74,222,128,.5);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 8px rgba(74,222,128,.4)}50%{box-shadow:0 0 16px rgba(74,222,128,.7)}}
.status-banner h2{display:inline;font-size:1.35rem;color:var(--accent);font-weight:600;margin:0}
.status-banner p{color:var(--muted);font-size:.9rem;margin:.75rem 0 0}

/* Section headings */
.section-title{font-size:1.2rem;color:var(--text);font-weight:600;margin:2.5rem 0 1rem;padding-bottom:.5rem;border-bottom:1px solid rgba(255,255,255,.06)}

/* Stats grid */
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.25rem;margin-bottom:2.5rem}
@media(max-width:640px){.stats-grid{grid-template-columns:1fr}}
.stat-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem;text-align:center}
.stat-card .stat-value{font-size:1.6rem;font-weight:700;color:var(--accent);font-family:var(--mono)}
.stat-card .stat-label{font-size:.88rem;color:var(--muted);margin-top:.4rem}

/* How we monitor */
.monitor-list{list-style:none;padding:0;margin:0 0 2.5rem}
.monitor-list li{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.1rem 1.4rem;margin-bottom:.75rem;display:flex;align-items:flex-start;gap:.8rem;color:var(--muted);font-size:.93rem;line-height:1.6}
.monitor-list .check-icon{color:var(--accent);font-size:1.1rem;flex-shrink:0;margin-top:2px}

/* Infrastructure grid */
.infra-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1.25rem;margin-bottom:2.5rem}
@media(max-width:800px){.infra-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:480px){.infra-grid{grid-template-columns:1fr}}
.infra-card{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.3rem;text-align:center}
.infra-card .infra-icon{font-size:1.5rem;margin-bottom:.5rem}
.infra-card .infra-name{font-size:.95rem;color:var(--text);font-weight:600}
.infra-card .infra-desc{font-size:.82rem;color:var(--muted);margin-top:.3rem;line-height:1.5}

/* Endpoints table */
.endpoints-table{width:100%;border-collapse:collapse;margin-bottom:2.5rem;font-size:.9rem}
.endpoints-table th{text-align:left;color:var(--muted);font-weight:500;padding:.6rem .8rem;border-bottom:1px solid rgba(255,255,255,.08);font-size:.82rem;text-transform:uppercase;letter-spacing:.04em}
.endpoints-table td{padding:.75rem .8rem;border-bottom:1px solid rgba(255,255,255,.04);color:var(--text)}
.endpoints-table tr:hover td{background:rgba(255,255,255,.02)}
.endpoints-table .ep-path{font-family:var(--mono);font-size:.85rem;color:var(--accent)}
.endpoints-table .ep-path a{color:var(--accent);text-decoration:none}
.endpoints-table .ep-path a:hover{text-decoration:underline}
.endpoints-table .ep-badge{display:inline-block;font-size:.7rem;font-family:var(--mono);padding:2px 7px;border-radius:4px;background:rgba(74,222,128,.12);color:var(--accent);margin-left:6px;vertical-align:middle}

/* Incident response */
.incident-box{background:var(--card);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:1.5rem 1.6rem;margin-bottom:2.5rem;color:var(--muted);font-size:.93rem;line-height:1.7}
.incident-box strong{color:var(--text);font-weight:600}

/* CTA */
.status-cta{text-align:center;margin:2rem 0 3rem}
.status-cta a{color:var(--accent);font-weight:600;text-decoration:none;font-size:1.05rem}
.status-cta a:hover{text-decoration:underline}
</style>
</head>
<body>
${renderHeader("/status")}
<main style="max-width:960px;margin:0 auto;padding:2rem 1.25rem">
<p class="breadcrumb"><a href="/">Home</a> &rsaquo; Status</p>
<h1 style="font-size:1.8rem;margin:0 0 1rem;color:var(--text)">System Status</h1>

<!-- Current status banner -->
<div class="status-banner">
  <span class="status-dot"></span><h2>All systems operational</h2>
  <p>Real-time health available at <a href="/health" style="color:var(--accent);text-decoration:none;font-family:var(--mono);font-size:.88rem">/health</a></p>
</div>

<!-- Uptime stats -->
<h2 class="section-title">Uptime</h2>
<div class="stats-grid">
  <div class="stat-card">
    <div class="stat-value">99.9%+</div>
    <div class="stat-label">Target uptime</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">15 min</div>
    <div class="stat-label">Health-check interval</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">24/7</div>
    <div class="stat-label">Automated canary testing</div>
  </div>
</div>

<!-- How we monitor -->
<h2 class="section-title">How We Monitor</h2>
<ul class="monitor-list">
  <li>
    <span class="check-icon">&#10003;</span>
    <span><strong style="color:var(--text)">Heartbeat probe every 15 minutes</strong> &mdash; a GitHub Actions workflow hits <code style="font-family:var(--mono);color:var(--accent);font-size:.88rem">/health</code> around the clock and verifies the response includes all expected feature flags.</span>
  </li>
  <li>
    <span class="check-icon">&#10003;</span>
    <span><strong style="color:var(--text)">Daily paid canary</strong> &mdash; a separate workflow purchases a $0.001 tool once per day to verify the full end-to-end payment flow: tool discovery, x402 negotiation, USDC settlement on Base, and result delivery.</span>
  </li>
  <li>
    <span class="check-icon">&#10003;</span>
    <span><strong style="color:var(--text)">Automated incident management</strong> &mdash; on any probe failure, a GitHub issue is auto-opened with diagnostic details. When the service recovers, the issue is auto-closed. No open issues = healthy.</span>
  </li>
  <li>
    <span class="check-icon">&#10003;</span>
    <span><strong style="color:var(--text)">Transparent monitoring</strong> &mdash; all monitoring runs in the open. View the <a href="https://github.com/MikeyPetrillo/Agent402/actions/workflows/heartbeat.yml" rel="noopener" style="color:var(--accent);text-decoration:none">heartbeat workflow runs</a> and <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener" style="color:var(--accent);text-decoration:none">open issues</a> on GitHub.</span>
  </li>
</ul>

<!-- Infrastructure -->
<h2 class="section-title">Infrastructure</h2>
<div class="infra-grid">
  <div class="infra-card">
    <div class="infra-icon">&#9881;</div>
    <div class="infra-name">Railway</div>
    <div class="infra-desc">Managed hosting with zero-downtime deploys</div>
  </div>
  <div class="infra-card">
    <div class="infra-icon">&#9830;</div>
    <div class="infra-name">Base L2</div>
    <div class="infra-desc">USDC settlement on Coinbase's L2 chain</div>
  </div>
  <div class="infra-card">
    <div class="infra-icon">&#9878;</div>
    <div class="infra-name">Coinbase CDP</div>
    <div class="infra-desc">x402 payment facilitation</div>
  </div>
  <div class="infra-card">
    <div class="infra-icon">&#9729;</div>
    <div class="infra-name">Global CDN</div>
    <div class="infra-desc">Edge caching for static assets</div>
  </div>
</div>

<!-- Live endpoints -->
<h2 class="section-title">Live Endpoints</h2>
<table class="endpoints-table">
  <thead>
    <tr><th>Endpoint</th><th>Description</th></tr>
  </thead>
  <tbody>
    <tr>
      <td class="ep-path"><a href="/health">/health</a><span class="ep-badge">FREE</span></td>
      <td>Server health check with feature flags, version, and tool count</td>
    </tr>
    <tr>
      <td class="ep-path"><a href="/api/reliability">/api/reliability</a><span class="ep-badge">FREE</span></td>
      <td>Uptime percentage, error rate, and response-time report</td>
    </tr>
    <tr>
      <td class="ep-path"><a href="/api/stats">/api/stats</a><span class="ep-badge">FREE</span></td>
      <td>Economy stats: total calls served, revenue, and tool-level breakdown</td>
    </tr>
  </tbody>
</table>

<!-- Incident response -->
<h2 class="section-title">Incident Response</h2>
<div class="incident-box">
  <p style="margin:0 0 .75rem"><strong>Automated detection:</strong> When the heartbeat probe or paid canary fails, a GitHub issue is automatically opened with the failure details, HTTP status, and timestamp.</p>
  <p style="margin:0 0 .75rem"><strong>Maintainer notification:</strong> The repository owner is notified immediately via GitHub's issue notification system. Critical failures trigger immediate investigation.</p>
  <p style="margin:0 0 .75rem"><strong>Resolution:</strong> Most incidents are infrastructure-related (upstream API latency, Railway restarts) and resolve within minutes. The heartbeat re-probes every 15 minutes and auto-closes the issue on recovery.</p>
  <p style="margin:0"><strong>Post-incident:</strong> Persistent issues are tracked in the <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener" style="color:var(--accent);text-decoration:none">GitHub issue tracker</a> with root-cause analysis and remediation steps.</p>
</div>

<div class="status-cta"><a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Questions about reliability? Open a GitHub issue &rarr;</a></div>
</main>
${renderFooter()}
</body>
</html>`;
}
