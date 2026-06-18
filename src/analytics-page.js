// Public analytics dashboard — HTML render of the /api/analytics JSON.
//
// Mirrors the leaderboard.js render pattern: dark theme, stat cards, table,
// inline SVG sparkline (no external chart lib), schema callout. Reads from the
// timeseries + totals + topTools returned by getAnalytics() in analytics-db.js.
//
// When analytics is disabled (no ANALYTICS_DATABASE_URL / DATABASE_URL) the
// page renders a clean empty state explaining how to enable it on a self-hosted
// instance — same fail-soft behavior as /api/analytics.
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) =>
  String(s == null ? "" : s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

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
    <polyline fill="none" stroke="#4ade80" stroke-width="1.5" points="${path}" />
    <polyline fill="rgba(74,222,128,0.08)" stroke="none" points="0,${height} ${path} ${width},${height}" />
  </svg>`;
}

export function analyticsPage(data, { baseUrl }) {
  // Disabled (no DB): clean, friendly empty state with self-host hint.
  if (!data || !data.enabled) {
    return renderShell({
      baseUrl,
      windowHuman: "—",
      hours: 24,
      body: `
<div class="panel">
  <div class="ph"><h2>Analytics not enabled on this instance</h2><div class="pn">No analytics DB configured.</div></div>
  <div style="padding:16px 18px;">
    <p class="foot" style="margin:0 0 10px;">The hosted instance turns this on by attaching a Postgres plugin and setting <code>ANALYTICS_DATABASE_URL</code> (or sharing the existing <code>DATABASE_URL</code>).</p>
    <p class="foot" style="margin:0;">Once enabled, this page surfaces totals, latency percentiles, cache hit rate, and the top tools over a configurable window. JSON: <code>${esc(baseUrl)}/api/analytics?hours=24&amp;top=25</code></p>
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
<div class="panel">
  <div class="ph"><h2>Analytics temporarily unavailable</h2><div class="pn">Query failed — the DB connection may be warming. Refresh in a few seconds.</div></div>
</div>`,
    });
  }

  const hours = data.windowHours || 24;
  const windowHuman = hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
  const totals = data.totals || {};
  const top = Array.isArray(data.topTools) ? data.topTools : [];
  const series = Array.isArray(data.timeseries) ? data.timeseries : [];

  const cacheHitRate = fmtPct(totals.cached, totals.calls);
  // Split: 4xx = caller sent bad input (their bug — wrong field, missing
  // required, malformed value). 5xx = our handler or its upstream broke
  // (our bug, or a third-party API blip). Aggregating both into a single
  // "error rate" hides the only signal that matters for triage.
  const clientErrRate = fmtPct(totals.client_errored, totals.calls);
  const serverErrRate = fmtPct(totals.server_errored, totals.calls);
  const peakHour = series.reduce((best, r) => (Number(r.calls || 0) > Number(best?.calls || 0) ? r : best), null);

  const rows = top
    .map((r, i) => {
      const safeSlug = esc(r.slug);
      const cachedPct = r.calls ? fmtPct(r.cached, r.calls) : "—";
      const clientErrCellPct = r.calls ? fmtPct(r.client_errored, r.calls) : "—";
      const serverErrCellPct = r.calls ? fmtPct(r.server_errored, r.calls) : "—";
      // Color code the per-row error cells so a glance tells you which tools
      // are actually broken vs which are just being called wrong.
      const clientErrClass = (Number(r.client_errored || 0) > 0) ? "warn" : "muted";
      const serverErrClass = (Number(r.server_errored || 0) > 0) ? "danger" : "muted";
      const route = "/api/" + safeSlug;
      return `<tr>
        <td class="num muted">${esc(i + 1)}</td>
        <td><a href="${route}" rel="nofollow">${safeSlug}</a></td>
        <td class="num">${esc(fmtInt(r.calls))}</td>
        <td class="num muted">${esc(cachedPct)}</td>
        <td class="num ${clientErrClass}">${esc(clientErrCellPct)}</td>
        <td class="num ${serverErrClass}">${esc(serverErrCellPct)}</td>
        <td class="num">${esc(fmtMs(r.p50_ms))}</td>
        <td class="num">${esc(fmtMs(r.p95_ms))}</td>
      </tr>`;
    })
    .join("");

  const emptyRow = `<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">No tool calls in the last ${esc(windowHuman)}. The dashboard starts filling as agents call tools.</td></tr>`;

  // Highlight class on the hero stats so the difference between caller errors
  // (we can't fix that without changes to the SDK or the agent) and server
  // errors (we definitely need to fix that) is visible at a glance.
  const clientErrClass = (Number(totals.client_errored || 0) > 0) ? "warn" : "";
  const serverErrClass = (Number(totals.server_errored || 0) > 0) ? "danger" : "";

  const body = `
<div class="grid">
  <div class="stat"><div class="k">Tool calls (${esc(windowHuman)})</div><div class="v">${esc(fmtInt(totals.calls))}</div><div class="s">across the whole catalog</div></div>
  <div class="stat"><div class="k">Cache hit rate</div><div class="v">${esc(cacheHitRate)}</div><div class="s">served from Redis without re-fetching upstream</div></div>
  <div class="stat ${clientErrClass}" title="HTTP 4xx — input the tool's schema didn't accept (missing required field, unrecognized shape). Often a UX gap on our side: the caller's intent is clear but we haven't taught the handler to accept their field names. Each one returns the schema + an example so the next call self-corrects.">
    <div class="k">Schema mismatches (4xx)</div><div class="v">${esc(clientErrRate)}</div><div class="s">input we didn't accept — caller gets back the schema + an example</div>
  </div>
  <div class="stat ${serverErrClass}" title="HTTP 5xx — the handler threw or its upstream failed. This is the rate that needs fixing.">
    <div class="k">Server errors (5xx)</div><div class="v">${esc(serverErrRate)}</div><div class="s">handler or upstream failure — actionable</div>
  </div>
  <div class="stat"><div class="k">Latency p50 / p95</div><div class="v" style="font-size:1.05rem">${esc(fmtMs(totals.p50_latency_ms))} / ${esc(fmtMs(totals.p95_latency_ms))}</div><div class="s">avg ${esc(fmtMs(totals.avg_latency_ms))}</div></div>
  <div class="stat"><div class="k">Peak hour</div><div class="v" style="font-size:1rem">${esc(fmtTs(peakHour?.ts))}</div><div class="s">${esc(fmtInt(peakHour?.calls || 0))} calls</div></div>
</div>

<div class="panel">
  <div class="ph"><h2>Tool calls per hour (last ${esc(windowHuman)})</h2><div class="pn">Live, write-through from the dispatcher — every tool call is recorded after responding (no PII, no caller wallet, no IP).</div></div>
  <div style="padding:14px 18px;">
    ${sparkline(series)}
  </div>
</div>

<div class="panel">
  <div class="ph"><h2>Top tools by volume (last ${esc(windowHuman)})</h2><div class="pn">Click a slug to see the tool's docs page.</div></div>
  <table>
    <thead><tr><th class="num">#</th><th>Tool</th><th class="num">Calls</th><th class="num" title="Share of this tool's calls served from the Redis response cache">Cache %</th><th class="num" title="HTTP 4xx — input the schema didn't accept. Often a UX gap on our side; the tool returns its schema + an example so the next call self-corrects.">4xx %</th><th class="num" title="HTTP 5xx — handler or upstream failure. Actionable.">5xx %</th><th class="num">p50</th><th class="num">p95</th></tr></thead>
    <tbody>${rows || emptyRow}</tbody>
  </table>
</div>

<div class="panel">
  <div class="ph"><h2>What's recorded</h2><div class="pn">Privacy-by-default: aggregate counters only.</div></div>
  <div style="padding:14px 18px;">
    <p class="foot" style="margin:0 0 8px;">Each tool call records five fields after responding: <code>slug</code>, <code>latency_ms</code>, <code>cached</code> (Redis hit), <code>errored</code>, and the HTTP <code>status</code> (so 4xx caller errors and 5xx handler/upstream failures can be told apart). No caller identity, wallet, payment, input, output, or IP is logged. The dashboard reflects exactly what's in the table.</p>
    <pre>curl -s ${esc(baseUrl)}/api/analytics?hours=24&amp;top=25</pre>
  </div>
</div>`;

  return renderShell({ baseUrl, windowHuman, hours, body });
}

function renderShell({ baseUrl, windowHuman, hours, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analytics — Agent402</title>
<meta name="description" content="Live, public usage analytics for Agent402 — total tool calls, cache hit rate, latency percentiles, and top tools over a configurable window.">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --card:#0f1320; }
  body { background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:980px; margin:0 auto; padding:36px 20px 28px; }
  h1 { font-size:1.6rem; margin:0 0 6px; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:.95rem; max-width:680px; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin:0 0 22px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .stat .k { color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .stat .v { font-family:ui-monospace,Menlo,monospace; font-size:1.65rem; color:var(--fg); margin-top:4px; word-break:break-word; }
  .stat .s { color:var(--muted); font-size:.78rem; margin-top:3px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:18px; }
  .ph { padding:14px 18px; border-bottom:1px solid var(--line); }
  .ph h2 { margin:0; font-size:1rem; color:var(--accent); }
  .ph .pn { color:var(--muted); font-size:.82rem; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:10px 18px; border-bottom:1px solid var(--line); }
  th.num { text-align:right; }
  td { padding:10px 18px; border-bottom:1px solid var(--line); }
  td.num { font-family:ui-monospace,Menlo,monospace; text-align:right; }
  td.muted { color:var(--muted); font-family:ui-monospace,Menlo,monospace; font-size:.85em; }
  td.warn { color:#f59e0b; font-family:ui-monospace,Menlo,monospace; }
  td.danger { color:#ef4444; font-family:ui-monospace,Menlo,monospace; }
  .stat.warn { border-color:#7a4d10; }
  .stat.warn .v { color:#f59e0b; }
  .stat.danger { border-color:#7a1f1f; }
  .stat.danger .v { color:#ef4444; }
  td a { color:var(--fg); text-decoration:none; border-bottom:1px solid transparent; }
  td a:hover { border-color:var(--accent); }
  code { background:#1a2236; padding:1px 5px; border-radius:4px; font-family:ui-monospace,Menlo,monospace; font-size:.85em; }
  pre { background:#0a0d15; border:1px solid var(--line); border-radius:8px; padding:14px 16px; overflow:auto; font-size:.84rem; }
  .foot { color:var(--muted); font-size:.82rem; }
  .foot a { color:var(--accent); text-decoration:none; }
  .winbar { display:flex; gap:8px; margin:0 0 18px; flex-wrap:wrap; }
  .winbar a { padding:6px 12px; border:1px solid var(--line); border-radius:999px; color:var(--muted); text-decoration:none; font-size:.82rem; }
  .winbar a.active { color:var(--accent); border-color:var(--accent); }
  .winbar a:hover { color:var(--fg); }
  ${CHROME_CSS}
</style>
</head>
<body>
${renderHeader("/analytics")}
<div class="wrap">

<h1>Analytics</h1>
<p class="sub">Live, public usage data for Agent402. Every tool call records four aggregate fields after responding — slug, latency, cache flag, error flag — with no PII. Window: <b>${esc(windowHuman)}</b>.</p>

<div class="winbar">
  ${[1, 24, 24 * 7, 24 * 30].map((h) => `<a class="${h === hours ? "active" : ""}" href="/analytics?hours=${h}">${h === 1 ? "1h" : h === 24 ? "24h" : h === 168 ? "7d" : "30d"}</a>`).join("")}
</div>

${body}

<p class="foot" style="margin-top:24px;">Analytics is open-source — part of <a href="https://github.com/MikeyPetrillo/Agent402">Agent402</a>. Self-hosters get the same dashboard by attaching a Postgres instance.</p>

</div>
${renderFooter()}
</body></html>`;
}
