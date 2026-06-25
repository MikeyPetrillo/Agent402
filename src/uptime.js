import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

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

  const extraCss = `
.up-wrap{max-width:960px;margin:0 auto;padding:56px 30px}
.up-eyebrow{font-family:var(--font-mono);font-size:13px;color:var(--accent);margin-bottom:18px}
.up-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 20px}

/* Status banner */
.status-banner{background:var(--card);border:1.5px solid var(--ink);padding:32px 40px;text-align:center;margin-bottom:40px}
.status-banner .status-dot{display:inline-block;width:12px;height:12px;background:var(--green);margin-right:10px;animation:ml-pulse 2s ease-in-out infinite}
.status-banner h2{display:inline;font-family:var(--font-body);font-weight:800;font-size:24px;color:var(--ink);margin:0}
.status-banner p{color:var(--muted);font-size:14px;margin:12px 0 0}
.status-banner a{color:var(--accent);text-decoration:none;font-family:var(--font-mono);font-size:13px}

/* Section headings */
.section-title{font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:40px 0 16px;padding-bottom:10px;border-bottom:1.5px solid var(--ink);color:var(--ink)}

/* Stats grid */
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:40px}
@media(max-width:640px){.stats-grid{grid-template-columns:1fr}.up-h1{font-size:36px !important}}
.stat-card{background:var(--card);border:1.5px solid var(--ink);padding:24px;text-align:center}
.stat-card .stat-value{font-size:28px;font-weight:700;color:var(--accent);font-family:var(--font-mono)}
.stat-card .stat-label{font-size:14px;color:var(--muted);margin-top:6px}

/* How we monitor */
.monitor-list{list-style:none;padding:0;margin:0 0 40px}
.monitor-list li{background:var(--card);border:1.5px solid var(--ink);padding:18px 22px;margin-bottom:10px;display:flex;align-items:flex-start;gap:12px;color:var(--muted);font-size:14px;line-height:1.55}
.monitor-list .check-icon{color:var(--accent);font-size:18px;flex-shrink:0;margin-top:2px}
.monitor-list strong{color:var(--ink);font-weight:700}
.monitor-list a{color:var(--accent);text-decoration:none}
.monitor-list a:hover{text-decoration:underline}
.monitor-list code{font-family:var(--font-mono);color:var(--accent);font-size:13px}

/* Infrastructure grid */
.infra-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-bottom:40px}
@media(max-width:800px){.infra-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:480px){.infra-grid{grid-template-columns:1fr}}
.infra-card{background:var(--card);border:1.5px solid var(--ink);padding:22px;text-align:center}
.infra-card .infra-icon{font-size:24px;margin-bottom:8px}
.infra-card .infra-name{font-family:var(--font-body);font-weight:800;font-size:16px;color:var(--ink)}
.infra-card .infra-desc{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.5}

/* Endpoints table */
.endpoints-table{width:100%;border-collapse:collapse;margin-bottom:40px;font-size:14px}
.endpoints-table th{text-align:left;color:var(--cream);font-family:var(--font-mono);font-weight:700;padding:10px 14px;background:var(--ink);font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.endpoints-table td{padding:12px 14px;border-bottom:1px solid var(--hairline);color:var(--muted)}
.endpoints-table tr:hover td{background:var(--card)}
.endpoints-table .ep-path{font-family:var(--font-mono);font-size:13px;color:var(--accent)}
.endpoints-table .ep-path a{color:var(--accent);text-decoration:none}
.endpoints-table .ep-path a:hover{text-decoration:underline}
.endpoints-table .ep-badge{display:inline-block;font-family:var(--font-mono);font-size:11px;padding:2px 8px;background:var(--ink);color:var(--cream);margin-left:8px;vertical-align:middle;font-weight:700}

/* Incident response */
.incident-box{background:var(--card);border:1.5px solid var(--ink);padding:24px 26px;margin-bottom:40px;color:var(--muted);font-size:14px;line-height:1.55}
.incident-box strong{color:var(--ink);font-weight:700}
.incident-box a{color:var(--accent);text-decoration:none}
.incident-box a:hover{text-decoration:underline}

/* CTA */
.status-cta{text-align:center;margin:32px 0 48px}
.status-cta a{color:var(--accent);font-family:var(--font-mono);font-weight:700;text-decoration:none;font-size:15px}
.status-cta a:hover{text-decoration:underline}
`;

  const body = `
<div class="up-wrap">
<div class="up-eyebrow">$ GET /status</div>
<h1 class="up-h1">System Status</h1>

<!-- Current status banner -->
<div class="status-banner">
  <span class="status-dot"></span><h2>All systems operational</h2>
  <p>Real-time health available at <a href="/health">/health</a></p>
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
    <span><strong>Heartbeat probe every 15 minutes</strong> &mdash; a GitHub Actions workflow hits <code>/health</code> around the clock and verifies the response includes all expected feature flags.</span>
  </li>
  <li>
    <span class="check-icon">&#10003;</span>
    <span><strong>Daily paid canary</strong> &mdash; a separate workflow purchases a $0.001 tool once per day to verify the full end-to-end payment flow: tool discovery, x402 negotiation, USDC settlement on Base, and result delivery.</span>
  </li>
  <li>
    <span class="check-icon">&#10003;</span>
    <span><strong>Automated incident management</strong> &mdash; on any probe failure, a GitHub issue is auto-opened with diagnostic details. When the service recovers, the issue is auto-closed. No open issues = healthy.</span>
  </li>
  <li>
    <span class="check-icon">&#10003;</span>
    <span><strong>Transparent monitoring</strong> &mdash; all monitoring runs in the open. View the <a href="https://github.com/MikeyPetrillo/Agent402/actions/workflows/heartbeat.yml" rel="noopener">heartbeat workflow runs</a> and <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">open issues</a> on GitHub.</span>
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
  <p style="margin:0 0 12px"><strong>Automated detection:</strong> When the heartbeat probe or paid canary fails, a GitHub issue is automatically opened with the failure details, HTTP status, and timestamp.</p>
  <p style="margin:0 0 12px"><strong>Maintainer notification:</strong> The repository owner is notified immediately via GitHub's issue notification system. Critical failures trigger immediate investigation.</p>
  <p style="margin:0 0 12px"><strong>Resolution:</strong> Most incidents are infrastructure-related (upstream API latency, Railway restarts) and resolve within minutes. The heartbeat re-probes every 15 minutes and auto-closes the issue on recovery.</p>
  <p style="margin:0"><strong>Post-incident:</strong> Persistent issues are tracked in the <a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">GitHub issue tracker</a> with root-cause analysis and remediation steps.</p>
</div>

<div class="status-cta"><a href="https://github.com/MikeyPetrillo/Agent402/issues" rel="noopener">Questions about reliability? Open a GitHub issue &rarr;</a></div>
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({ title: pageTitle, description: pageDesc, canonical, baseUrl, activePath: "/status", jsonLd, extraCss, body });
}
