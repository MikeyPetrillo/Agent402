// Token-gated /__operator/leads dashboard — every row in tollbooth_leads.
// Same auth model and visual language as operator.js (the per-tool dashboard):
// AGENT402_OPERATOR_TOKEN accepted via Authorization: Bearer / X-Operator-Token
// header (preferred) or ?token= query (legacy, stripped from the URL on load).
//
// This is the source of truth view for incoming Tollbooth Cloud waitlist and
// partner applications. The form on /tollbooth/waitlist POSTs to
// /api/tollbooth/waitlist, which inserts here.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

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
    solo: "#7cb3e0",
    team: "#6fae8d",
    agency: "#b0a0d0",
    enterprise: "#c4a44e",
    partner: "#c87090",
  }[plan] || "#8A8475";
  return `<span class="ol-plan" style="color:${color}; border-color:${color}55;">${esc(plan)}</span>`;
};

export function operatorLeadsPage({ ok, rows, total, byPlan, dbEnabled }) {
  const banner = !dbEnabled
    ? `<div class="ol-warn">DATABASE_URL is not set on this instance. Submissions fall back to the GitHub pre-fill flow and are not stored here.</div>`
    : !ok
      ? `<div class="ol-warn">Database is configured but the query failed. Check server logs for [leads-db].</div>`
      : "";

  const summary = dbEnabled && ok
    ? `<div class="ol-grid">
        <div class="ol-stat"><div class="ol-k">Total leads</div><div class="ol-v">${esc(total)}</div></div>
        ${["solo","team","agency","enterprise","partner"].map(p =>
          `<div class="ol-stat"><div class="ol-k">${p}</div><div class="ol-v">${esc(byPlan?.[p] || 0)}</div></div>`
        ).join("")}
      </div>`
    : "";

  const tbody = (rows || []).map((r) => `<tr>
    <td class="ol-mono">${esc(fmtDate(r.created_at))}</td>
    <td>${planBadge(r.plan)} ${r.kind && r.kind !== "waitlist" ? `<span class="ol-kind">${esc(r.kind)}</span>` : ""}</td>
    <td><b>${esc(r.name)}</b><br><a class="ol-mail" href="mailto:${encodeURIComponent(r.email)}">${esc(r.email)}</a></td>
    <td>${esc(r.org || "—")}</td>
    <td class="ol-sites">${esc(r.sites || "—")}</td>
    <td class="ol-msg">${esc(r.message || "")}</td>
    <td class="ol-mono ol-small ol-faint">${esc(r.ip || "")}<br>${esc((r.ua || "").slice(0, 70))}</td>
  </tr>`).join("");

  const table = dbEnabled && ok
    ? (rows && rows.length
        ? `<div class="ol-tbl-wrap"><table>
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
          </table></div>`
        : `<p class="ol-empty">No leads yet. The form on <a href="/tollbooth/waitlist">/tollbooth/waitlist</a> POSTs into this table.</p>`)
    : "";

  const extraCss = `
.ol-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.ol-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 6px}
.ol-sub{color:var(--muted);margin:0 0 22px;font-size:14px;line-height:1.55}
.ol-sub a{color:var(--accent);text-decoration:none}
.ol-sub a:hover{text-decoration:underline}
.ol-warn{background:var(--card);border:1.5px solid var(--ink);color:#b8842e;padding:12px 16px;margin-bottom:18px;font-size:14px}
.ol-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin:0 0 22px}
.ol-stat{background:var(--ink);border:1.5px solid var(--ink);padding:12px 16px}
.ol-stat .ol-k{color:var(--dk-muted);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.ol-stat .ol-v{font-family:var(--font-mono);font-size:1.25rem;color:var(--cream);margin-top:2px}
.ol-tbl-wrap{background:var(--ink);border:1.5px solid var(--ink);overflow:hidden}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:var(--dk-muted);font-weight:500;font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:10px 14px;border-bottom:1px solid var(--dark-border);background:var(--ink-panel)}
td{padding:12px 14px;border-bottom:1px solid var(--dark-border);vertical-align:top;font-size:13px;color:var(--cream)}
tr:last-child td{border-bottom:0}
.ol-mono{font-family:var(--font-mono)}
.ol-small{font-size:12px}
.ol-faint{color:var(--dk-muted)}
.ol-mail{color:var(--accent);text-decoration:none;word-break:break-all}
.ol-mail:hover{text-decoration:underline}
.ol-plan{display:inline-block;border:1px solid var(--dark-border);padding:1px 10px;font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.ol-kind{display:inline-block;color:#c4a44e;border:1px solid rgba(196,164,78,.3);padding:1px 8px;font-family:var(--font-mono);font-size:10px;margin-left:4px;text-transform:uppercase;letter-spacing:.04em}
.ol-sites{max-width:240px;word-break:break-word}
.ol-msg{max-width:320px;white-space:pre-wrap;color:var(--dk-muted)}
.ol-empty{background:var(--card);border:1.5px solid var(--ink);padding:30px;text-align:center;color:var(--faint)}
.ol-empty a{color:var(--accent)}
@media(max-width:600px){.ol-h1{font-size:36px !important}}
`;

  // NOTE: The inline <script> preserves the existing operator auth pattern:
  // token capture from ?token= into sessionStorage, URL stripping via
  // replaceState, and inter-page navigation via fetch()+document.write() so
  // the token travels in the Authorization header, never in the URL.
  const body = `
<div class="ol-wrap">
  <h1 class="ol-h1">Tollbooth leads</h1>
  <p class="ol-sub">Submissions from <a href="/tollbooth/waitlist">/tollbooth/waitlist</a>. <a href="/__operator" data-op-link>Back to operator</a></p>
  ${banner}
  ${summary}
  ${table}
</div>
<script>
(function(){
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
        .then(function(t){
          document.open(); document.write(t); document.close();
          history.pushState({}, '', a.getAttribute('href'));
        })
        .catch(function(){});
    });
  });
})();
</script>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Operator · Tollbooth leads — Agent402",
    description: "Agent402 operator dashboard — Tollbooth Cloud waitlist and partner application leads.",
    canonical: `${baseUrl}/__operator/leads`,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
