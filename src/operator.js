// Operator dashboard — every served tool with its call count, USDC vs PoW
// split, estimated revenue, and the full retained recent-calls feed. Gated by
// AGENT402_OPERATOR_TOKEN via a Secure/HttpOnly/SameSite session cookie set at
// POST /__operator/login (never a ?token= URL — security audit A402-07).
// Nothing here is shown publicly; /api/stats remains the safe public surface.
import { ledgerShell, ledgerFooterCompact, esc, jsonScriptTag } from "./ledger-chrome.js";

// Minimal, unauthenticated login form. The operator pastes the token; it is
// POSTed as JSON to /__operator/login (body, not URL) which validates it and
// sets the session cookie, then this redirects into the dashboard. The token
// therefore never appears in a URL, access log, browser history, or Referer.
export function operatorLoginPage(baseUrl) {
  const extraCss = `
.opl-wrap{max-width:420px;margin:0 auto;padding:80px 30px}
.opl-h1{font-family:var(--font-body);font-weight:800;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:0 0 8px}
.opl-sub{color:var(--muted);margin:0 0 24px;font-size:var(--fs-md)}
.opl-form{display:flex;flex-direction:column;gap:12px}
.opl-form input{font-family:var(--font-mono);font-size:var(--fs-md);padding:12px 14px;border:1px solid var(--hairline);background:var(--panel);color:var(--on-panel)}
.opl-form button{font-family:var(--font-body);font-weight:700;font-size:var(--fs-base);padding:12px 14px;border:1px solid var(--hairline);background:var(--ink);color:var(--panel);cursor:pointer}
.opl-err{color:var(--warn);font-size:var(--fs-sm);min-height:18px}
`;
  const body = `
<div class="opl-wrap">
  <h1 class="opl-h1">Operator</h1>
  <p class="opl-sub">Paste the operator token to start a session.</p>
  <form class="opl-form" id="f" autocomplete="off">
    <input id="t" type="password" placeholder="operator token" aria-label="operator token" autocomplete="off">
    <button type="submit">Sign in</button>
    <div class="opl-err" id="e"></div>
  </form>
</div>
<script src="/js/operator-login.js"></script>
${ledgerFooterCompact()}`;
  return ledgerShell({
    title: "Operator sign-in - Agent402",
    description: "Agent402 operator sign-in.",
    canonical: `${baseUrl}/__operator/login`,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}

export function operatorPage(baseUrl, data) {
  const t = data?.totals || {};
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  const recent = Array.isArray(data?.recentCalls) ? data.recentCalls : [];
  // Call-volume and revenue are different leaderboards - the per-tool table
  // below defaults to sorting by calls, which silently doubles as a revenue
  // proxy unless someone thinks to click the Revenue header. Surfacing both
  // top-5s side by side makes the divergence visible at a glance.
  const topByRevenue = [...tools].sort((a, b) => b.revenueUsd - a.revenueUsd).slice(0, 5);
  const topByCalls = [...tools].sort((a, b) => b.calls - a.calls).slice(0, 5);
  const railBreakdown = Array.isArray(data?.railBreakdown) ? data.railBreakdown : [];
  const badge = (r) => r.walletOnly
    ? `<span class="op-badge op-badge-wallet" title="USDC only - no proof-of-work path">USDC-ONLY</span>`
    : `<span class="op-badge op-badge-pow" title="Also payable with proof-of-work (free tier)">FREE-W/POW</span>`;
  const rows = tools.map((r) => `<tr>
    <td><a href="/tools/${esc(r.slug)}">${esc(r.slug)}</a> ${badge(r)}</td>
    <td class="num">${esc(r.calls)}</td>
    <td class="num op-paid">${esc(r.paid)}</td>
    <td class="num op-pow">${esc(r.pow)}</td>
    <td class="num op-hb">${esc(r.heartbeat || 0)}</td>
    <td class="num op-rev">$${esc(r.revenueUsd.toFixed(4))}</td>
    <td class="num op-muted">$${esc(r.pricePerCall.toFixed(4))}</td>
  </tr>`).join("");
  const feedIcon = (m) => m === "proof-of-work" ? "PoW" : m === "heartbeat" ? "HB" : "$ USDC";
  const feed = recent.map((r) => `<li><span class="op-rs">${esc(r.slug)}</span><span class="op-rm">${feedIcon(r.paidWith)}</span><span class="op-ra">${esc(r.at)}</span></li>`).join("");

  const extraCss = `
.op-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.op-h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 6px}
.op-sub{color:var(--muted);margin:0 0 22px;font-size:var(--fs-md);line-height:1.55}
.op-sub a{color:var(--accent);text-decoration:none}
.op-sub a:hover{text-decoration:underline}
.op-sub code{font-family:var(--font-mono);font-size:var(--fs-xs);background:var(--panel);color:var(--on-panel);padding:2px 7px;border:1px solid var(--hairline)}
.op-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:0 0 22px}
.op-stat{background:var(--panel);border:1px solid var(--hairline);padding:16px}
.op-stat .op-k{color:var(--on-panel-dim);font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.06em}
.op-stat .op-v{font-family:var(--font-mono);font-size:var(--fs-xl);color:var(--on-panel);margin-top:4px}
.op-stat .op-s{color:var(--on-panel-dim);font-family:var(--font-mono);font-size:var(--fs-xs);margin-top:3px}
.op-layout{display:grid;gap:18px;grid-template-columns:1fr 320px}
@media(max-width:880px){.op-layout{grid-template-columns:1fr}}
.op-panel{background:var(--panel);border:1px solid var(--hairline);overflow:hidden}
.op-ph{padding:12px 16px;border-bottom:1px solid var(--panel-rule);display:flex;justify-content:space-between;align-items:center}
.op-ph h2{margin:0;font-size:var(--fs-base);color:var(--accent);font-family:var(--font-body);font-weight:700}
.op-ph input{background:var(--ink-panel);color:var(--on-panel);border:1px solid var(--panel-rule);padding:5px 8px;font-family:var(--font-mono);font-size:var(--fs-xs)}
.op-ph input:focus{outline:none;border-color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
th{text-align:left;color:var(--on-panel-dim);font-weight:500;font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;padding:9px 14px;border-bottom:1px solid var(--panel-rule);position:sticky;top:0;background:var(--panel);cursor:pointer;user-select:none}
th.num{text-align:right}
td{padding:8px 14px;border-bottom:1px solid var(--panel-rule);color:var(--on-panel);font-family:var(--font-mono);font-size:var(--fs-sm)}
td.num{text-align:right}
td.op-paid{color:var(--ok)}
td.op-pow{color:var(--t-cyan)}
td.op-hb{color:var(--t-violet)}
td.op-rev{color:var(--accent);font-weight:600}
td.op-muted{color:var(--on-panel-dim)}
td a{color:var(--on-panel);text-decoration:none}
td a:hover{color:var(--accent)}
.op-tbody-scroll{max-height:560px;overflow:auto}
.op-feed{max-height:560px;overflow:auto}
.op-feed ul{list-style:none;margin:0;padding:0}
.op-feed li{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:10px 16px;border-bottom:1px solid var(--panel-rule);font-size:var(--fs-xs)}
.op-rs{font-family:var(--font-mono);color:var(--on-panel)}
.op-rm{color:var(--on-panel-dim);font-family:var(--font-mono);font-size:var(--fs-xs)}
.op-ra{grid-column:1/-1;color:var(--on-panel-dim);font-family:var(--font-mono);font-size:var(--fs-2xs)}
.op-badge{display:inline-block;font-family:var(--font-mono);font-size:var(--fs-2xs);font-weight:600;padding:1px 6px;margin-left:6px;letter-spacing:.04em;vertical-align:middle}
.op-badge-pow{background:rgba(124,179,224,.12);color:var(--t-cyan);border:1px solid rgba(124,179,224,.3)}
.op-badge-wallet{background:rgba(111,174,141,.12);color:var(--ok);border:1px solid rgba(111,174,141,.3)}
@media(max-width:600px){.op-h1{font-size:var(--fs-3xl) !important}}
`;

  // Auth is the /__operator session cookie (set by the POST login form),
  // sent automatically with same-origin requests — so nav is plain links and
  // the table/feed AJAX refresh needs no token handling. No ?token= in the URL,
  // no sessionStorage, no Authorization header dance (security audit A402-07).
  const body = `
<div class="op-wrap">

<h1 class="op-h1">Operator dashboard</h1>
<p class="op-sub">Per-tool usage, settlement split, and live activity. Auto-refreshes every 10s. Not public - gated by <code>AGENT402_OPERATOR_TOKEN</code>. <a href="/__operator/wishes">Agent demand</a> · <a href="/__operator/leads">Tollbooth leads</a> · <form method="POST" action="/__operator/logout" style="display:inline;margin:0"><button type="submit" style="background:none;border:0;padding:0;color:var(--accent);font:inherit;cursor:pointer">Log out</button></form></p>

<div class="op-grid">
  <div class="op-stat"><div class="op-k">Total calls</div><div class="op-v" id="t-total">${esc(t.total ?? 0)}</div><div class="op-s">all tools, all rails</div></div>
  <div class="op-stat"><div class="op-k">USDC settled</div><div class="op-v" id="t-usdc">${esc(t.viaUSDC ?? 0)}</div><div class="op-s">on-chain proof at wallet</div></div>
  <div class="op-stat"><div class="op-k">PoW (external)</div><div class="op-v" id="t-pow">${esc(t.viaProofOfWork ?? 0)}</div><div class="op-s">real free-tier adoption</div></div>
  <div class="op-stat"><div class="op-k">Heartbeat probes</div><div class="op-v" id="t-hb">${esc(t.viaHeartbeat ?? 0)}</div><div class="op-s">internal /api/hash probe</div></div>
  <div class="op-stat"><div class="op-k">Estimated revenue</div><div class="op-v" id="t-rev">$${esc((t.estimatedRevenueUsd ?? 0).toFixed(4))}</div><div class="op-s">counter; chain is truth</div></div>
  <div class="op-stat"><div class="op-k">Tools served</div><div class="op-v" id="t-tools">${esc(t.toolsServed ?? 0)}</div><div class="op-s">distinct slugs</div></div>
  <div class="op-stat"><div class="op-k">Uptime</div><div class="op-v" id="t-up">${esc(Math.floor((data?.processUptimeSeconds ?? 0) / 3600))}h</div><div class="op-s">since process boot</div></div>
</div>

<div class="op-layout">
  <div class="op-panel">
    <div class="op-ph"><h2>Per-tool breakdown</h2><input id="filter" type="search" placeholder="filter slug…" autocomplete="off"></div>
    <div class="op-tbody-scroll"><table id="tbl">
      <thead><tr><th data-k="slug">Slug</th><th class="num" data-k="calls">Calls</th><th class="num" data-k="paid">USDC</th><th class="num" data-k="pow" title="External proof-of-work - does not include the heartbeat probe">PoW</th><th class="num" data-k="heartbeat" title="Internal /api/hash probe (agent402-heartbeat UA, every 15 min)">HB</th><th class="num" data-k="rev">Revenue</th><th class="num" data-k="price">Price</th></tr></thead>
      <tbody id="tbody">${rows || `<tr><td colspan="7" class="op-muted" style="padding:24px;text-align:center;">No tool calls yet.</td></tr>`}</tbody>
    </table></div>
  </div>

  <div class="op-panel op-feed">
    <div class="op-ph"><h2>Recent calls</h2></div>
    <ul id="feed">${feed || `<li style="text-align:center;color:var(--on-panel-dim);padding:16px;">No recent activity.</li>`}</ul>
  </div>
</div>

<div class="op-layout" style="margin-top:18px">
  <div class="op-panel">
    <div class="op-ph"><h2>Top by revenue vs top by calls</h2></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
      <div style="border-right:1px solid var(--panel-rule)">
        <div style="padding:8px 14px;color:var(--on-panel-dim);font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--panel-rule)">By revenue</div>
        <ol style="list-style:none;margin:0;padding:0">${topByRevenue.length ? topByRevenue.map((r) => `<li style="padding:8px 14px;border-bottom:1px solid var(--panel-rule);font-family:var(--font-mono);font-size:var(--fs-sm);display:flex;justify-content:space-between;gap:8px"><a href="/tools/${esc(r.slug)}" style="color:var(--on-panel);text-decoration:none">${esc(r.slug)}</a><span class="op-rev">$${esc(r.revenueUsd.toFixed(4))}</span></li>`).join("") : `<li style="padding:16px;text-align:center;color:var(--on-panel-dim)">No data yet.</li>`}</ol>
      </div>
      <div>
        <div style="padding:8px 14px;color:var(--on-panel-dim);font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--panel-rule)">By calls</div>
        <ol style="list-style:none;margin:0;padding:0">${topByCalls.length ? topByCalls.map((r) => `<li style="padding:8px 14px;border-bottom:1px solid var(--panel-rule);font-family:var(--font-mono);font-size:var(--fs-sm);display:flex;justify-content:space-between;gap:8px"><a href="/tools/${esc(r.slug)}" style="color:var(--on-panel);text-decoration:none">${esc(r.slug)}</a><span class="op-muted">${esc(r.calls)}</span></li>`).join("") : `<li style="padding:16px;text-align:center;color:var(--on-panel-dim)">No data yet.</li>`}</ol>
      </div>
    </div>
  </div>

  <div class="op-panel">
    <div class="op-ph"><h2>Rails offered vs settled</h2></div>
    <div style="max-height:280px;overflow:auto">
      <table>
        <thead><tr><th>Rail</th><th class="num">Settled calls</th></tr></thead>
        <tbody>${railBreakdown.length ? railBreakdown.map((r) => `<tr><td>${esc(r.network)}${r.settledCalls === 0 ? ` <span class="op-badge" style="background:rgba(184,132,46,.14);color:var(--warn);border:1px solid rgba(184,132,46,.35)">ZERO REVENUE</span>` : ""}</td><td class="num${r.settledCalls === 0 ? " op-muted" : " op-paid"}">${esc(r.settledCalls)}</td></tr>`).join("") : `<tr><td colspan="2" class="op-muted" style="padding:16px;text-align:center">No configured rails.</td></tr>`}</tbody>
      </table>
    </div>
    <p style="padding:10px 14px;margin:0;color:var(--on-panel-dim);font-size:var(--fs-xs);border-top:1px solid var(--panel-rule)">Rails currently in PAYMENT_NETWORKS with zero lifetime settled calls still carry facilitator config, canary legs, and test maintenance for zero return.</p>
  </div>
</div>

${jsonScriptTag("op-rows-data", tools)}
<script src="/js/operator-dashboard.js"></script>

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Operator - Agent402",
    description: "Agent402 operator dashboard - per-tool usage, settlement split, and live activity.",
    canonical: `${baseUrl}/__operator`,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
