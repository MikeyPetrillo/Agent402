// Token-gated /__operator/leads dashboard — every row in tollbooth_leads.
// Same auth model and visual language as operator.js (the per-tool dashboard):
// AGENT402_OPERATOR_TOKEN accepted via Authorization: Bearer / X-Operator-Token
// header (preferred) or ?token= query (legacy, stripped from the URL on load).
//
// This is the source of truth view for incoming Tollbooth Cloud waitlist and
// partner applications. The form on /tollbooth/waitlist POSTs to
// /api/tollbooth/waitlist, which inserts here.
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtDate = (d) => {
  try {
    const iso = (d instanceof Date ? d : new Date(d)).toISOString();
    return iso.replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return String(d || "");
  }
};

const planBadge = (plan) => {
  const color = {
    solo: "#60a5fa",
    team: "#4ade80",
    agency: "#a78bfa",
    enterprise: "#fbbf24",
    partner: "#f472b6",
  }[plan] || "#8b93a7";
  return `<span class="plan" style="color:${color}; border-color:${color}33;">${esc(plan)}</span>`;
};

export function operatorLeadsPage({ ok, rows, total, byPlan, dbEnabled }) {
  const banner = !dbEnabled
    ? `<div class="warn">DATABASE_URL is not set on this instance. Submissions fall back to the GitHub pre-fill flow and are not stored here.</div>`
    : !ok
      ? `<div class="warn">Database is configured but the query failed. Check server logs for [leads-db].</div>`
      : "";

  const summary = dbEnabled && ok
    ? `<div class="grid">
        <div class="stat"><div class="k">Total leads</div><div class="v">${esc(total)}</div></div>
        ${["solo","team","agency","enterprise","partner"].map(p =>
          `<div class="stat"><div class="k">${p}</div><div class="v">${esc(byPlan?.[p] || 0)}</div></div>`
        ).join("")}
      </div>`
    : "";

  const tbody = (rows || []).map((r) => `<tr>
    <td class="mono">${esc(fmtDate(r.created_at))}</td>
    <td>${planBadge(r.plan)} ${r.kind && r.kind !== "waitlist" ? `<span class="kind">${esc(r.kind)}</span>` : ""}</td>
    <td><b>${esc(r.name)}</b><br><a class="mail" href="mailto:${encodeURIComponent(r.email)}">${esc(r.email)}</a></td>
    <td>${esc(r.org || "—")}</td>
    <td class="sites">${esc(r.sites || "—")}</td>
    <td class="msg">${esc(r.message || "")}</td>
    <td class="mono small muted">${esc(r.ip || "")}<br>${esc((r.ua || "").slice(0, 70))}</td>
  </tr>`).join("");

  const table = dbEnabled && ok
    ? (rows && rows.length
        ? `<table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Plan</th>
                <th>Lead</th>
                <th>Org</th>
                <th>Sites</th>
                <th>Message</th>
                <th>IP / UA</th>
              </tr>
            </thead>
            <tbody>${tbody}</tbody>
          </table>`
        : `<p class="empty">No leads yet. The form on <a href="/tollbooth/waitlist">/tollbooth/waitlist</a> POSTs into this table.</p>`)
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator · Tollbooth leads — Agent402</title>
<meta name="robots" content="noindex,nofollow">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --card:#0f1320; --warn:#fbbf24; }
  body { background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:1280px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:.9rem; }
  .sub a { color:var(--accent); text-decoration:none; }
  .warn { background:#231a05; border:1px solid #5b3f00; color:var(--warn); border-radius:8px; padding:10px 14px; margin-bottom:18px; font-size:.9rem; }
  .grid { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); margin:0 0 22px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; }
  .stat .k { color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .stat .v { font-family:ui-monospace,Menlo,monospace; font-size:1.25rem; color:var(--fg); margin-top:2px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:10px 14px; border-bottom:1px solid var(--line); background:#0a0d15; }
  td { padding:12px 14px; border-bottom:1px solid var(--line); vertical-align:top; font-size:.88rem; }
  tr:last-child td { border-bottom:0; }
  .mono { font-family:ui-monospace,Menlo,monospace; }
  .small { font-size:.78rem; }
  .muted { color:var(--muted); }
  .mail { color:var(--accent); text-decoration:none; word-break:break-all; }
  .mail:hover { text-decoration:underline; }
  .plan { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 10px; font-size:.74rem; text-transform:uppercase; letter-spacing:.04em; }
  .kind { display:inline-block; color:var(--warn); border:1px solid #5b3f00; border-radius:999px; padding:1px 8px; font-size:.7rem; margin-left:4px; text-transform:uppercase; letter-spacing:.04em; }
  .sites { max-width:240px; word-break:break-word; }
  .msg { max-width:320px; white-space:pre-wrap; color:var(--muted); }
  .empty { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:30px; text-align:center; color:var(--muted); }
  .empty a { color:var(--accent); }
${CHROME_CSS}
</style>
</head>
<body>
${renderHeader("/__operator/leads")}
<div class="wrap">
  <h1>Tollbooth leads</h1>
  <p class="sub">Submissions from <a href="/tollbooth/waitlist">/tollbooth/waitlist</a>. <a href="/__operator" data-op-link>← Back to operator</a></p>
  ${banner}
  ${summary}
  ${table}
</div>
<script>
(function(){
  // Mirror operator.js: capture ?token= once, then strip it from the URL +
  // route inter-page links through fetch() with the Authorization header so
  // the secret never re-appears in access logs / history / Referer.
  var qs = new URLSearchParams(location.search);
  if (qs.has('token')) {
    try { sessionStorage.setItem('agent402-op-token', qs.get('token') || ''); } catch(_) {}
    qs.delete('token');
    var clean = location.pathname + (qs.toString() ? '?' + qs.toString() : '');
    history.replaceState({}, document.title, clean);
  }
  var TOKEN = '';
  try { TOKEN = sessionStorage.getItem('agent402-op-token') || ''; } catch(_) {}
  document.querySelectorAll('a[data-op-link]').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault();
      fetch(a.getAttribute('href'), {
        headers: TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {},
        cache: 'no-store',
      })
        .then(function(r){ return r.text(); })
        .then(function(html){
          document.open(); document.write(html); document.close();
          history.pushState({}, '', a.getAttribute('href'));
        })
        .catch(function(){});
    });
  });
})();
</script>
${renderFooter()}
</body>
</html>`;
}
