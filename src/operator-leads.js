// Token-gated /__operator/leads dashboard — every row in tollbooth_leads.
// Same auth model and visual language as operator.js (the per-tool dashboard):
// AGENT402_OPERATOR_TOKEN accepted via Authorization: Bearer / X-Operator-Token
// header (preferred) or ?token= query (legacy, stripped from the URL on load).
//
// Read-only view of the leads stored before the tollbooth waitlist intake
// closed. Nothing writes this table any more: POST /api/tollbooth/waitlist
// answers 410 and stores nothing.
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
    solo: "var(--t-cyan)",
    team: "var(--ok)",
    agency: "var(--t-violet)",
    enterprise: "var(--warn)",
    partner: "var(--accent)",
  }[plan] || "var(--faint)";
  return `<span class="ol-plan" style="color:${color}; border-color:color-mix(in srgb,${color} 33%,transparent);">${esc(plan)}</span>`;
};

const KNOWN_PLANS = ["solo", "team", "agency", "enterprise", "partner"];

export function operatorLeadsPage({ ok, rows, total, byPlan, dbEnabled, countsOk = ok, baseUrl = "" }) {
  const banner = !dbEnabled
    ? `<div class="ol-warn">DATABASE_URL is not set on this instance, so no stored leads can be read here.</div>`
    : !ok
      ? `<div class="ol-warn">Database is configured but the query failed. Check server logs for [leads-db].</div>`
      : "";

  // Totals first: how many sign-ups exist, per plan, without opening anyone's
  // details. Any plan value outside the known list still gets its own tile.
  const plans = [...KNOWN_PLANS, ...Object.keys(byPlan || {}).filter((p) => !KNOWN_PLANS.includes(p)).sort()];
  const summary = dbEnabled && countsOk
    ? `<div class="ol-grid" id="ol-totals">
        <div class="ol-stat"><div class="ol-k">Total leads</div><div class="ol-v">${esc(Number(total) || 0)}</div></div>
        ${plans.map((p) =>
          `<div class="ol-stat"><div class="ol-k">${esc(p)}</div><div class="ol-v">${esc(Number(byPlan?.[p]) || 0)}</div></div>`
        ).join("")}
      </div>`
    : "";

  const tbody = (rows || []).map((r) => `<tr>
    <td class="ol-mono">${esc(fmtDate(r.created_at))}</td>
    <td>${planBadge(r.plan)} ${r.kind && r.kind !== "waitlist" ? `<span class="ol-kind">${esc(r.kind)}</span>` : ""}</td>
    <td><b>${esc(r.name)}</b><br><a class="ol-mail" href="mailto:${encodeURIComponent(r.email)}">${esc(r.email)}</a></td>
    <td>${esc(r.org || "-")}</td>
    <td class="ol-sites">${esc(r.sites || "-")}</td>
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
        : `<p class="ol-empty">No stored leads. The intake is closed, so this table receives no new rows.</p>`)
    : "";

  const extraCss = `
.ol-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.ol-h1{font-family:var(--font-display);font-weight:400;letter-spacing:-.01em;font-size:var(--fs-5xl);line-height:.96;margin:0 0 6px}
.ol-sub{color:var(--muted);margin:0 0 22px;font-size:var(--fs-md);line-height:1.55}
.ol-sub a{color:var(--accent);text-decoration:none}
.ol-sub a:hover{text-decoration:underline}
.ol-warn{background:var(--card);border:1px solid var(--hairline);color:var(--warn);padding:12px 16px;margin-bottom:18px;font-size:var(--fs-md)}
.ol-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin:0 0 22px}
.ol-stat{background:var(--panel);border:1px solid var(--hairline);padding:12px 16px}
.ol-stat .ol-k{color:var(--on-panel-dim);font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.06em}
.ol-stat .ol-v{font-family:var(--font-mono);font-size:var(--fs-lg);color:var(--on-panel);margin-top:2px}
.ol-tbl-wrap{background:var(--panel);border:1px solid var(--hairline);overflow:hidden}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:var(--on-panel-dim);font-weight:500;font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em;padding:10px 14px;border-bottom:1px solid var(--panel-rule);background:var(--ink-panel)}
td{padding:12px 14px;border-bottom:1px solid var(--panel-rule);vertical-align:top;font-size:var(--fs-sm);color:var(--on-panel)}
tr:last-child td{border-bottom:0}
.ol-mono{font-family:var(--font-mono)}
.ol-small{font-size:var(--fs-xs)}
.ol-faint{color:var(--on-panel-dim)}
.ol-mail{color:var(--accent);text-decoration:none;word-break:break-all}
.ol-mail:hover{text-decoration:underline}
.ol-plan{display:inline-block;border:1px solid var(--panel-rule);padding:1px 10px;font-family:var(--font-mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.04em}
.ol-kind{display:inline-block;color:var(--warn);border:1px solid rgba(196,164,78,.3);padding:1px 8px;font-family:var(--font-mono);font-size:var(--fs-2xs);margin-left:4px;text-transform:uppercase;letter-spacing:.04em}
.ol-sites{max-width:240px;word-break:break-word}
.ol-msg{max-width:320px;white-space:pre-wrap;color:var(--on-panel-dim)}
.ol-empty{background:var(--card);border:1px solid var(--hairline);padding:30px;text-align:center;color:var(--faint)}
.ol-empty a{color:var(--accent)}
@media(max-width:600px){.ol-h1{font-size:var(--fs-3xl) !important}}
`;

  // Auth is the /__operator session cookie (set at POST /__operator/login),
  // sent automatically with same-origin requests — so nav is plain links, no
  // token in the URL or sessionStorage (audit A402-07).
  const body = `
<div class="ol-wrap">
  <h1 class="ol-h1">Tollbooth leads</h1>
  <p class="ol-sub">Intake closed: these rows were stored before the waitlist form was retired, and nothing new is added. <a href="/__operator">Back to operator</a> &middot; <form method="POST" action="/__operator/logout" style="display:inline;margin:0"><button type="submit" style="background:none;border:0;padding:0;color:var(--accent);font:inherit;cursor:pointer">Log out</button></form></p>
  ${banner}
  ${summary}
  ${table}
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Operator · Tollbooth leads - Agent402",
    description: "Agent402 operator dashboard - stored tollbooth leads (intake closed).",
    canonical: `${baseUrl}/__operator/leads`,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
