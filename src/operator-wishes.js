// Token-gated /__operator/wishes dashboard — the full agent demand board,
// including single-source and below-threshold clusters the public never sees
// ranked. Same auth model and visual language as operator-leads.js:
// AGENT402_OPERATOR_TOKEN via Authorization / X-Operator-Token header or the
// /__operator/login session cookie (never a ?token= URL — audit A402-07).
//
// Why operator-only: the raw feed at /api/wishes is deliberately public (a
// demand beacon that pulls sellers in), and the paid demand-radar tool sells
// the analysis layer on top. This page is the OPERATOR's strategic read of the
// same data — every cluster, ranked, with the qualification verdict spelled
// out — so it lives behind the token, not on a public route.
//
// aggregate is the getWishesAggregate() output. Its `text` field is already
// esc()'d at the source, so it is inserted here without re-escaping (double-
// escaping would mangle the &amp; etc.). Every other value is numeric/ISO.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const fmt = (iso) => String(iso || "").replace("T", " ").slice(0, 16) + "Z";

// A cluster's story at a glance: qualified (would auto-open an issue), or the
// reason it won't. Mirrors clusterQualifies in wish.js.
function verdict(c, threshold) {
  if (c.qualified) return { label: "qualified", color: "#3E9B6E", note: "opens an issue" };
  if (c.count < threshold) return { label: "below", color: "#8C8C8C", note: `needs ${threshold - c.count} more` };
  const distinct = ["api", "mcp", "find-miss"].filter((s) => (c.sources?.[s] || 0) > 0).length;
  if (distinct < 2) return { label: "single-source", color: "#c4a44e", note: "one surface, not corroborated" };
  return { label: "held", color: "#c4a44e", note: "not yet sustained" };
}

export function operatorWishesPage(baseUrl, aggregate) {
  const { distinctClusters = 0, totalWishes = 0, threshold = 5, qualifyMinSpanHours = 24, clusters = [] } = aggregate || {};
  const atThreshold = clusters.filter((c) => c.count >= threshold);
  const qualified = atThreshold.filter((c) => c.qualified);
  const held = atThreshold.filter((c) => !c.qualified);

  const summary = `<div class="ow-grid">
    <div class="ow-stat"><div class="ow-k">Distinct clusters</div><div class="ow-v">${esc(distinctClusters)}</div></div>
    <div class="ow-stat"><div class="ow-k">Total wishes</div><div class="ow-v">${esc(totalWishes)}</div></div>
    <div class="ow-stat"><div class="ow-k">At threshold (${esc(threshold)})</div><div class="ow-v">${esc(atThreshold.length)}</div></div>
    <div class="ow-stat"><div class="ow-k">Qualified</div><div class="ow-v" style="color:#3E9B6E">${esc(qualified.length)}</div></div>
    <div class="ow-stat"><div class="ow-k">Held (spam/near-miss)</div><div class="ow-v" style="color:#c4a44e">${esc(held.length)}</div></div>
  </div>`;

  const rows = (clusters || []).map((c) => {
    const v = verdict(c, threshold);
    const s = c.sources || {};
    const src = `${s.api || 0}/${s.mcp || 0}/${s["find-miss"] || 0}`;
    return `<tr>
      <td class="ow-mono ow-num">${esc(c.count)}</td>
      <td><span class="ow-badge" style="color:${v.color};border-color:${v.color}55">${esc(v.label)}</span><div class="ow-note">${esc(v.note)}</div></td>
      <td class="ow-mono ow-faint" title="api / mcp / find-miss">${esc(src)}</td>
      <td class="ow-mono ow-small ow-faint">${esc(fmt(c.firstSeen))}<br>${esc(fmt(c.lastSeen))}</td>
      <td class="ow-text">${c.text}</td>
    </tr>`;
  }).join("");

  const table = clusters.length
    ? `<div class="ow-tbl-wrap"><table>
        <thead><tr>
          <th class="ow-num">Count</th><th>Verdict</th><th title="api / mcp / find-miss">a/m/f</th><th>First / last</th><th>Normalized request</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<p class="ow-empty">No wishes recorded yet. Demand lands here from POST /api/wish, MCP request_tool, and /api/find misses.</p>`;

  const extraCss = `
.ow-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.ow-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 6px}
.ow-sub{color:var(--muted);margin:0 0 22px;font-size:14px;line-height:1.55}
.ow-sub a{color:var(--accent);text-decoration:none}
.ow-sub a:hover{text-decoration:underline}
.ow-sub code{font-family:var(--font-mono);font-size:12px;background:var(--surface);color:var(--on-dark);padding:2px 7px;border:1.5px solid var(--ink)}
.ow-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin:0 0 22px}
.ow-stat{background:var(--surface);border:1.5px solid var(--ink);padding:12px 16px}
.ow-stat .ow-k{color:var(--dk-muted);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.ow-stat .ow-v{font-family:var(--font-mono);font-size:1.25rem;color:var(--on-dark);margin-top:2px}
.ow-tbl-wrap{background:var(--surface);border:1.5px solid var(--ink);overflow:hidden}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:var(--dk-muted);font-weight:500;font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:10px 14px;border-bottom:1px solid var(--dark-border);background:var(--ink-panel)}
td{padding:10px 14px;border-bottom:1px solid var(--dark-border);vertical-align:top;font-size:13px;color:var(--on-dark)}
tr:last-child td{border-bottom:0}
.ow-mono{font-family:var(--font-mono)}
.ow-num{text-align:right;width:64px}
.ow-small{font-size:12px}
.ow-faint{color:var(--dk-muted)}
.ow-badge{display:inline-block;border:1px solid var(--dark-border);padding:1px 10px;font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.ow-note{color:var(--dk-muted);font-size:11px;margin-top:3px}
.ow-text{max-width:520px;word-break:break-word}
.ow-empty{background:var(--card);border:1.5px solid var(--ink);padding:30px;text-align:center;color:var(--faint)}
@media(max-width:600px){.ow-h1{font-size:36px !important}}
`;

  // Auth is the /__operator session cookie (set at POST /__operator/login),
  // sent automatically with same-origin requests — so nav is plain links, no
  // token in the URL or sessionStorage (audit A402-07).
  const body = `
<div class="ow-wrap">
  <h1 class="ow-h1">Agent demand</h1>
  <p class="ow-sub">The full wish board, ranked — every cluster including single-source and below-threshold, which the public feed never shows ranked. A cluster auto-opens a GitHub issue only when <b>qualified</b> (count &ge; ${esc(threshold)} and either &ge;2 sources or sustained past ${esc(qualifyMinSpanHours)}h). Not public — gated by <code>AGENT402_OPERATOR_TOKEN</code>. <a href="/__operator">Back to operator</a> &middot; <form method="POST" action="/__operator/logout" style="display:inline;margin:0"><button type="submit" style="background:none;border:0;padding:0;color:var(--accent);font:inherit;cursor:pointer">Log out</button></form></p>
  ${summary}
  ${table}
</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Operator · Agent demand — Agent402",
    description: "Agent402 operator dashboard — full agent demand board.",
    canonical: `${baseUrl}/__operator/wishes`,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
