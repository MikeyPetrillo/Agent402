// Public analytics dashboard — HTML render of the /api/analytics JSON.
//
// Mirrors the leaderboard.js render pattern: Machine Ledger design system,
// stat cards, table, inline SVG sparkline (no external chart lib), schema
// callout. Reads from the timeseries + totals + topTools returned by
// getAnalytics() in analytics-db.js.
//
// When analytics is disabled (no ANALYTICS_DATABASE_URL / DATABASE_URL) the
// page renders a clean empty state explaining how to enable it on a self-hosted
// instance — same fail-soft behavior as /api/analytics.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
const fmtPct = (num, denom) => {
  const d = Number(denom || 0);
  if (!d) return "—";
  return ((Number(num || 0) / d) * 100).toFixed(1) + "%";
};
const fmtMs = (n) => {
  const v = Number(n || 0);
  if (v === 0) return "—";
  if (v < 1000) return v + " ms";
  return (v / 1000).toFixed(2) + " s";
};
const fmtTs = (ts) => {
  if (!ts) return "—";
  const s = typeof ts === "string" ? ts : new Date(ts).toISOString();
  return s.replace("T", " ").slice(0, 16) + "Z";
};

// Inline SVG sparkline. No external dep — just polyline + a baseline so an
// all-zero series still renders something visible. Width/height are fixed so
// the SVG sits comfortably inside the card without forcing a layout shift.
function sparkline(series, { width = 720, height = 80 } = {}) {
  const pts = (series || []).map((r) => Number(r.calls || 0));
  if (!pts.length) return "";
  const max = Math.max(1, ...pts);
  const stepX = pts.length > 1 ? width / (pts.length - 1) : 0;
  const path = pts
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block">
    <polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="${path}" />
    <polyline fill="rgba(214,60,26,0.08)" stroke="none" points="0,${height} ${path} ${width},${height}" />
  </svg>`;
}

const AN_EXTRA_CSS = `
.an-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.an-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 6px}
.an-sub{color:var(--muted);margin:0 0 22px;font-size:15px;max-width:680px;line-height:1.55}
.an-sub b{color:var(--ink);font-weight:600}
.an-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin:0 0 22px}
.an-stat{background:var(--ink);border:1.5px solid var(--ink);padding:18px}
.an-stat .an-k{color:var(--dk-muted);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.an-stat .an-v{font-family:var(--font-mono);font-size:1.65rem;color:var(--cream);margin-top:4px;word-break:break-word}
.an-stat .an-s{color:var(--dk-muted);font-family:var(--font-mono);font-size:12px;margin-top:3px}
.an-panel{background:var(--ink);border:1.5px solid var(--ink);overflow:hidden;margin-bottom:18px}
.an-ph{padding:14px 18px;border-bottom:1px solid var(--dark-border)}
.an-ph h2{margin:0;font-size:1rem;color:var(--accent);font-family:var(--font-body);font-weight:700}
.an-ph .an-pn{color:var(--dk-muted);font-family:var(--font-mono);font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dk-muted);font-weight:500;font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:10px 18px;border-bottom:1px solid var(--dark-border)}
th.num{text-align:right}
td{padding:10px 18px;border-bottom:1px solid var(--dark-border);color:var(--cream);font-family:var(--font-mono);font-size:13px}
td.num{text-align:right}
td.an-muted{color:var(--dk-muted)}
td.an-warn{color:#c4a44e}
td.an-danger{color:#c0453a}
.an-stat.an-warn{border-color:#7a4d10}
.an-stat.an-warn .an-v{color:#c4a44e}
.an-stat.an-danger{border-color:#7a1f1f}
.an-stat.an-danger .an-v{color:#c0453a}
td a{color:var(--cream);text-decoration:none;border-bottom:1px solid transparent}
td a:hover{border-color:var(--accent)}
code{font-family:var(--font-mono);font-size:12px;background:var(--ink);color:var(--cream);padding:2px 7px;border:1.5px solid var(--dark-border)}
pre{background:var(--ink-panel);border:1px solid var(--dark-border);padding:14px 16px;overflow:auto;font-family:var(--font-mono);font-size:12px;color:var(--cream)}
.an-foot{color:var(--faint);font-size:13px}
.an-foot a{color:var(--accent);text-decoration:none}
.an-foot a:hover{text-decoration:underline}
.an-winbar{display:flex;gap:8px;margin:0 0 18px;flex-wrap:wrap}
.an-winbar a{padding:6px 12px;border:1.5px solid var(--ink);font-family:var(--font-mono);color:var(--faint);text-decoration:none;font-size:13px}
.an-winbar a.active{color:var(--accent);border-color:var(--accent)}
.an-winbar a:hover{color:var(--ink)}
@media(max-width:600px){.an-h1{font-size:36px !important}}
`;

export function analyticsPage(data, { baseUrl }) {
  // Disabled (no DB): clean, friendly empty state with self-host hint.
  if (!data || !data.enabled) {
    return renderShell({
      baseUrl,
      windowHuman: "—",
      hours: 24,
      body: `
<div class="an-panel">
  <div class="an-ph"><h2>Analytics not enabled on this instance</h2><div class="an-pn">No analytics DB configured.</div></div>
  <div style="padding:16px 18px;">
    <p class="an-foot" style="margin:0 0 10px;">The hosted instance turns this on by attaching a Postgres plugin and setting <code>ANALYTICS_DATABASE_URL</code> (or sharing the existing <code>DATABASE_URL</code>).</p>
    <p class="an-foot" style="margin:0;">Once enabled, this page surfaces totals, latency percentiles, cache hit rate, and the top tools over a configurable window. JSON: <code>${esc(baseUrl)}/api/analytics?hours=24&amp;top=25</code></p>
  </div>
</div>`,
    });
  }

  if (!data.ok) {
    return renderShell({
      baseUrl,
      windowHuman: "—",
      hours: data.windowHours || 24,
      body: `
<div class="an-panel">
  <div class="an-ph"><h2>Analytics temporarily unavailable</h2><div class="an-pn">Query failed — the DB connection may be warming. Refresh in a few seconds.</div></div>
</div>`,
    });
  }

  const hours = data.windowHours || 24;
  const windowHuman = hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
  const includeSynthetic = !!data.includeSynthetic;
  const syntheticHidden = Number(data.syntheticHidden || 0);
  const includeProbes = !!data.includeProbes;
  const probesHidden = Number(data.probesHidden || 0);
  const totals = data.totals || {};
  const top = Array.isArray(data.topTools) ? data.topTools : [];
  const errs = Array.isArray(data.errorTools) ? data.errorTools : [];
  const series = Array.isArray(data.timeseries) ? data.timeseries : [];

  const cacheHitRate = fmtPct(totals.cached, totals.calls);
  const clientErrRate = fmtPct(totals.client_errored, totals.calls);
  const serverErrRate = fmtPct(totals.server_errored, totals.calls);
  const peakHour = series.reduce((best, r) => (Number(r.calls || 0) > Number(best?.calls || 0) ? r : best), null);

  const rows = top
    .map((r, i) => {
      const safeSlug = esc(r.slug);
      const cachedPct = r.calls ? fmtPct(r.cached, r.calls) : "—";
      const clientErrCellPct = r.calls ? fmtPct(r.client_errored, r.calls) : "—";
      const serverErrCellPct = r.calls ? fmtPct(r.server_errored, r.calls) : "—";
      const clientErrClass = (Number(r.client_errored || 0) > 0) ? "an-warn" : "an-muted";
      const serverErrClass = (Number(r.server_errored || 0) > 0) ? "an-danger" : "an-muted";
      const route = "/api/" + safeSlug;
      return `<tr>
        <td class="num an-muted">${esc(i + 1)}</td>
        <td><a href="${route}" rel="nofollow">${safeSlug}</a></td>
        <td class="num">${esc(fmtInt(r.calls))}</td>
        <td class="num an-muted">${esc(cachedPct)}</td>
        <td class="num ${clientErrClass}">${esc(clientErrCellPct)}</td>
        <td class="num ${serverErrClass}">${esc(serverErrCellPct)}</td>
        <td class="num">${esc(fmtMs(r.p50_ms))}</td>
        <td class="num">${esc(fmtMs(r.p95_ms))}</td>
      </tr>`;
    })
    .join("");

  const emptyRow = `<tr><td colspan="8" class="an-muted" style="text-align:center;padding:24px">No tool calls in the last ${esc(windowHuman)}. The dashboard starts filling as agents call tools.</td></tr>`;

  const errRows = errs
    .map((r, i) => {
      const safeSlug = esc(r.slug);
      const total = Number(r.errored || 0);
      const c4 = Number(r.client_errored || 0);
      const c5 = Number(r.server_errored || 0);
      const errPct = r.calls ? fmtPct(total, r.calls) : "—";
      const route = "/api/" + safeSlug;
      return `<tr>
        <td class="num an-muted">${esc(i + 1)}</td>
        <td><a href="${route}" rel="nofollow">${safeSlug}</a></td>
        <td class="num">${esc(fmtInt(r.calls))}</td>
        <td class="num an-warn">${esc(fmtInt(c4))}</td>
        <td class="num an-danger">${esc(fmtInt(c5))}</td>
        <td class="num">${esc(fmtInt(total))}</td>
        <td class="num">${esc(errPct)}</td>
      </tr>`;
    })
    .join("");
  const errEmpty = `<tr><td colspan="7" class="an-muted" style="text-align:center;padding:24px">No errors in the last ${esc(windowHuman)} — every tool call returned 2xx.</td></tr>`;

  const clientErrClass = (Number(totals.client_errored || 0) > 0) ? "an-warn" : "";
  const serverErrClass = (Number(totals.server_errored || 0) > 0) ? "an-danger" : "";

  const body = `
<div class="an-grid">
  <div class="an-stat"><div class="an-k">Tool calls (${esc(windowHuman)})</div><div class="an-v">${esc(fmtInt(totals.calls))}</div><div class="an-s">across the whole catalog</div></div>
  <div class="an-stat"><div class="an-k">Cache hit rate</div><div class="an-v">${esc(cacheHitRate)}</div><div class="an-s">served from Redis without re-fetching upstream</div></div>
  <div class="an-stat ${clientErrClass}" title="HTTP 4xx — input the tool's schema didn't accept (missing required field, unrecognized shape). Often a UX gap on our side: the caller's intent is clear but we haven't taught the handler to accept their field names. Each one returns the schema + an example so the next call self-corrects.">
    <div class="an-k">Schema mismatches (4xx)</div><div class="an-v">${esc(clientErrRate)}</div><div class="an-s">input we didn't accept — caller gets back the schema + an example</div>
  </div>
  <div class="an-stat ${serverErrClass}" title="HTTP 5xx — the handler threw or its upstream failed. This is the rate that needs fixing.">
    <div class="an-k">Server errors (5xx)</div><div class="an-v">${esc(serverErrRate)}</div><div class="an-s">handler or upstream failure — actionable</div>
  </div>
  <div class="an-stat"><div class="an-k">Latency p50 / p95</div><div class="an-v" style="font-size:1.05rem">${esc(fmtMs(totals.p50_latency_ms))} / ${esc(fmtMs(totals.p95_latency_ms))}</div><div class="an-s">avg ${esc(fmtMs(totals.avg_latency_ms))}</div></div>
  <div class="an-stat"><div class="an-k">Peak hour</div><div class="an-v" style="font-size:1rem">${esc(fmtTs(peakHour?.ts))}</div><div class="an-s">${esc(fmtInt(peakHour?.calls || 0))} calls</div></div>
</div>

<div class="an-panel">
  <div class="an-ph"><h2>Tool calls per hour (last ${esc(windowHuman)})</h2><div class="an-pn">Live, write-through from the dispatcher — every tool call is recorded after responding (no PII, no caller wallet, no IP).</div></div>
  <div style="padding:14px 18px;">
    ${sparkline(series)}
  </div>
</div>

<div class="an-panel">
  <div class="an-ph"><h2>Top tools by volume (last ${esc(windowHuman)})</h2><div class="an-pn">Click a slug to see the tool's docs page.</div></div>
  <table>
    <thead><tr><th class="num">#</th><th>Tool</th><th class="num">Calls</th><th class="num" title="Share of this tool's calls served from the Redis response cache">Cache %</th><th class="num" title="HTTP 4xx — input the schema didn't accept. Often a UX gap on our side; the tool returns its schema + an example so the next call self-corrects.">4xx %</th><th class="num" title="HTTP 5xx — handler or upstream failure. Actionable.">5xx %</th><th class="num">p50</th><th class="num">p95</th></tr></thead>
    <tbody>${rows || emptyRow}</tbody>
  </table>
</div>

<div class="an-panel">
  <div class="an-ph"><h2>Top error slugs (last ${esc(windowHuman)})</h2><div class="an-pn">Tools ranked by total errored calls. 4xx = caller sent the wrong shape (often a schema-coverage gap we can fix with input aliases). 5xx = handler or upstream broke (the actionable one).</div></div>
  <table>
    <thead><tr><th class="num">#</th><th>Tool</th><th class="num">Calls</th><th class="num" title="HTTP 4xx — schema mismatches">4xx</th><th class="num" title="HTTP 5xx — handler/upstream failures">5xx</th><th class="num">Errors</th><th class="num">Error %</th></tr></thead>
    <tbody>${errRows || errEmpty}</tbody>
  </table>
</div>

<div class="an-panel">
  <div class="an-ph"><h2>What's recorded</h2><div class="an-pn">Privacy-by-default: aggregate counters only.</div></div>
  <div style="padding:14px 18px;">
    <p class="an-foot" style="margin:0 0 8px;">Each tool call records five fields after responding: <code>slug</code>, <code>latency_ms</code>, <code>cached</code> (Redis hit), <code>errored</code>, and the HTTP <code>status</code> (so 4xx caller errors and 5xx handler/upstream failures can be told apart). No caller identity, wallet, payment, input, output, or IP is logged. The dashboard reflects exactly what's in the table.</p>
    <pre>curl -s ${esc(baseUrl)}/api/analytics?hours=24&amp;top=25</pre>
  </div>
</div>`;

  return renderShell({ baseUrl, windowHuman, hours, includeSynthetic, syntheticHidden, includeProbes, probesHidden, body });
}

function renderShell({ baseUrl, windowHuman, hours, includeSynthetic, syntheticHidden, includeProbes, probesHidden, body }) {
  const winbarQs = [includeSynthetic ? "include_synthetic=1" : "", includeProbes ? "include_probes=1" : ""].filter(Boolean).join("&");

  const shellBody = `
<div class="an-wrap">

<h1 class="an-h1">Analytics</h1>
<p class="an-sub">Live, public usage data for Agent402. Every tool call records four aggregate fields after responding — slug, latency, cache flag, error flag — with no PII. Window: <b>${esc(windowHuman)}</b>.</p>

<div class="an-winbar">
  ${[1, 24, 24 * 7, 24 * 30].map((h) => {
    return `<a class="${h === hours ? "active" : ""}" href="/analytics?hours=${h}${winbarQs ? "&" + winbarQs : ""}">${h === 1 ? "1h" : h === 24 ? "24h" : h === 168 ? "7d" : "30d"}</a>`;
  }).join("")}
</div>
${(syntheticHidden > 0 || includeSynthetic) ? `<p class="an-foot" style="margin:6px 0 0;font-size:13px;">${includeSynthetic
    ? `Showing <b>all</b> calls (incl. synthetic test traffic). <a href="/analytics?hours=${hours}${includeProbes ? "&include_probes=1" : ""}">Hide synthetic</a>`
    : `<b>${esc(String(syntheticHidden))}</b> synthetic call${syntheticHidden === 1 ? "" : "s"} hidden (CI canary / heartbeat probe). <a href="/analytics?hours=${hours}&include_synthetic=1${includeProbes ? "&include_probes=1" : ""}">Show all</a>`}</p>` : ""}
${(probesHidden > 0 || includeProbes) ? `<p class="an-foot" style="margin:6px 0 0;font-size:13px;">${includeProbes
    ? `Showing <b>probe</b> calls (empty-input scans). <a href="/analytics?hours=${hours}${includeSynthetic ? "&include_synthetic=1" : ""}">Hide probes</a>`
    : `<b>${esc(String(probesHidden))}</b> probe call${probesHidden === 1 ? "" : "s"} hidden (empty-input scans — not real errors). <a href="/analytics?hours=${hours}${includeSynthetic ? "&include_synthetic=1" : ""}&include_probes=1">Show all</a>`}</p>` : ""}

${body}

<p class="an-foot" style="margin-top:24px;">Analytics is open-source — part of <a href="https://github.com/MikeyPetrillo/Agent402">Agent402</a>. Self-hosters get the same dashboard by attaching a Postgres instance.</p>

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Analytics — Agent402",
    description: "Live, public usage analytics for Agent402 — total tool calls, cache hit rate, latency percentiles, and top tools over a configurable window.",
    canonical: `${baseUrl}/analytics`,
    baseUrl,
    activePath: "__none__",
    extraCss: AN_EXTRA_CSS,
    body: shellBody,
  });
}
