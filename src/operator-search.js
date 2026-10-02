// Operator-only HTML view of the weekly search summary (/__operator/search).
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const n = (v) => (v == null ? "-" : Number(v).toLocaleString("en-US"));
const pct = (v) => (v == null ? "-" : (v * 100).toFixed(2) + "%");
const chg = (v) => (v == null ? "" : ` <span class="os-chg ${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%</span>`);
const pos = (v) => (v == null ? "-" : Number(v).toFixed(1));

function moverTable(title, rows, label) {
  if (!rows?.length) return `<h3>${esc(title)}</h3><p class="os-empty">None.</p>`;
  return `<h3>${esc(title)}</h3><div class="os-tbl"><table><thead><tr><th>${esc(label)}</th><th>Clicks</th><th>Δ</th><th>Impr.</th><th>Δ</th><th>Pos.</th></tr></thead><tbody>${rows.map((r) =>
    `<tr><td class="os-key">${esc(r.key)}</td><td>${n(r.clicks)}</td><td>${n(r.clicksDelta)}</td><td>${n(r.impressions)}</td><td>${n(r.impressionsDelta)}</td><td>${pos(r.position)}</td></tr>`).join("")}</tbody></table></div>`;
}

function listTable(title, rows, cols) {
  if (!rows?.length) return `<h3>${esc(title)}</h3><p class="os-empty">None.</p>`;
  return `<h3>${esc(title)}</h3><div class="os-tbl"><table><thead><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${cols.map((c) => `<td${c[1] === "page" ? ' class="os-key"' : ""}>${esc(c[2] ? c[2](r[c[1]]) : r[c[1]])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function sourceBlock(name, s) {
  if (!s) return "";
  if (s.error) return `<h2>${esc(name)}</h2><div class="os-warn">${esc(s.error)}</div>`;
  if (s.empty) return `<h2>${esc(name)}</h2><p class="os-empty">No data stored yet.</p>`;
  const t = s.totals;
  const index = (s.index || []).filter((x) => !String(x.metric).startsWith("backfill"));
  return `<h2>${esc(name)} <span class="os-win">${esc(s.window.from)} to ${esc(s.window.to)} vs ${esc(s.window.prevFrom)} to ${esc(s.window.prevTo)}</span></h2>
<div class="os-grid">
  <div class="os-stat"><div class="k">Clicks</div><div class="v">${n(t.clicks)}${chg(t.clicksChange)}</div><div class="p">prev ${n(t.prevClicks)}</div></div>
  <div class="os-stat"><div class="k">Impressions</div><div class="v">${n(t.impressions)}${chg(t.impressionsChange)}</div><div class="p">prev ${n(t.prevImpressions)}</div></div>
  <div class="os-stat"><div class="k">CTR</div><div class="v">${pct(t.ctr)}</div><div class="p">prev ${pct(t.prevCtr)}</div></div>
  <div class="os-stat"><div class="k">Avg position</div><div class="v">${pos(t.position)}</div><div class="p">prev ${pos(t.prevPosition)}</div></div>
</div>
${moverTable("Queries gaining", s.queries.gaining, "Query")}
${moverTable("Queries losing", s.queries.losing, "Query")}
${moverTable("Pages gaining", s.pages.gaining, "Page")}
${moverTable("Pages losing", s.pages.losing, "Page")}
${listTable("New pages", s.pages.new, [["Page", "page"], ["Impr.", "impressions", n], ["Clicks", "clicks", n], ["Pos.", "position", pos]])}
${listTable("Dropped pages", s.pages.dropped, [["Page", "page"], ["Prev impr.", "prevImpressions", n], ["Prev clicks", "prevClicks", n]])}
${listTable(`High impressions, low CTR (>= ${s.thresholds.lowCtrMinImpressions} impr., CTR < ${pct(s.thresholds.lowCtrMax)})`, s.lowCtrPages, [["Page", "page"], ["Impr.", "impressions", n], ["Clicks", "clicks", n], ["CTR", "ctr", pct], ["Pos.", "position", pos]])}
${listTable("Index snapshot (latest)", index, [["Metric", "metric"], ["Day", "day"], ["Value", "value", n]])}`;
}

export function operatorSearchPage(baseUrl, data) {
  const st = data.status || {};
  const conf = `Google: ${st.google?.site ? esc(st.google.site) : "not configured"}${st.google?.error ? ` (${esc(st.google.error)})` : ""} · Bing: ${st.bing?.site ? esc(st.bing.site) : "not configured"} · store: ${esc(st.store || "none")} · last run: ${esc(st.lastRunAt || "never")}`;
  const sources = data.sources || {};
  const blocks = Object.keys(sources).length
    ? sourceBlock("Google Search Console", sources.google) + sourceBlock("Bing Webmaster Tools", sources.bing)
    : `<p class="os-empty">${esc(data.note || "No search source is configured on this instance.")}</p>`;
  const extraCss = `
.os-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.os-h1{font-family:var(--font-body);font-weight:800;font-size:48px;line-height:1;letter-spacing:-.03em;margin:0 0 6px}
.os-sub{color:var(--muted);margin:0 0 22px;font-size:13px;line-height:1.55;font-family:var(--font-mono)}
.os-sub a{color:var(--accent)}
.os-wrap h2{font-size:24px;margin:36px 0 12px}
.os-wrap h3{font-size:15px;margin:22px 0 8px}
.os-win{font-family:var(--font-mono);font-size:12px;color:var(--muted);font-weight:400}
.os-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.os-stat{background:var(--surface);border:1px solid var(--hairline);padding:12px 16px;color:var(--on-dark)}
.os-stat .k{color:var(--dk-muted);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.os-stat .v{font-family:var(--font-mono);font-size:1.3rem;margin-top:2px}
.os-stat .p{font-family:var(--font-mono);font-size:11px;color:var(--dk-muted)}
.os-chg{font-size:12px}.os-chg.up{color:#3E9B6E}.os-chg.down{color:#c87070}
.os-tbl{background:var(--surface);border:1px solid var(--hairline);overflow-x:auto}
.os-wrap table{width:100%;border-collapse:collapse}
.os-wrap th{text-align:left;color:var(--dk-muted);font-weight:500;font-family:var(--font-mono);font-size:11px;text-transform:uppercase;padding:8px 12px;border-bottom:1px solid var(--dark-border)}
.os-wrap td{padding:8px 12px;border-bottom:1px solid var(--dark-border);font-size:13px;color:var(--on-dark);font-family:var(--font-mono)}
.os-key{word-break:break-all;max-width:520px}
.os-empty{color:var(--faint);font-size:13px}
.os-warn{border:1px solid var(--hairline);color:#b8842e;padding:10px 14px;font-size:13px}
`;
  const body = `
<div class="os-wrap">
  <h1 class="os-h1">Search data</h1>
  <p class="os-sub">${conf}<br><a href="/__operator/search.json">JSON</a> · <a href="/__operator">Back to operator</a></p>
  ${blocks}
</div>
${ledgerFooterCompact()}`;
  return ledgerShell({
    title: "Operator · Search data - Agent402",
    description: "Agent402 operator dashboard - search engine data.",
    canonical: `${baseUrl}/__operator/search`,
    baseUrl,
    activePath: "__none__",
    robots: "noindex, nofollow",
    extraCss,
    body,
  });
}
