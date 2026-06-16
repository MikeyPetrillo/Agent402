// Operator dashboard — every served tool with its call count, USDC vs PoW
// split, estimated revenue, and the full retained recent-calls feed. Gated by
// AGENT402_OPERATOR_TOKEN (query ?token=…). Nothing here is shown publicly;
// /api/stats remains the safe public surface.
import { CHROME_HEAD_LINKS, CHROME_CSS } from "./chrome.js";

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function operatorPage(baseUrl, token, data) {
  const t = data?.totals || {};
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  const recent = Array.isArray(data?.recentCalls) ? data.recentCalls : [];
  const badge = (r) => r.walletOnly
    ? `<span class="badge wallet" title="USDC only — no proof-of-work path">USDC-ONLY</span>`
    : `<span class="badge pow" title="Also payable with proof-of-work (free tier)">FREE-W/POW</span>`;
  const rows = tools.map((r) => `<tr>
    <td><a href="/tools/${esc(r.slug)}">${esc(r.slug)}</a> ${badge(r)}</td>
    <td class="num">${esc(r.calls)}</td>
    <td class="num paid">${esc(r.paid)}</td>
    <td class="num pow">${esc(r.pow)}</td>
    <td class="num rev">$${esc(r.revenueUsd.toFixed(4))}</td>
    <td class="num muted">$${esc(r.pricePerCall.toFixed(4))}</td>
  </tr>`).join("");
  const feed = recent.map((r) => `<li><span class="rs">${esc(r.slug)}</span><span class="rm">${r.paidWith === "proof-of-work" ? "⚙ PoW" : "$ USDC"}</span><span class="ra">${esc(r.at)}</span></li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Operator — Agent402</title>
<meta name="robots" content="noindex,nofollow">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --card:#0f1320; --pow:#60a5fa; --paid:#4ade80; }
  body { background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:1180px; margin:0 auto; padding:28px 20px 24px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 22px; font-size:.9rem; }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); margin:0 0 22px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .stat .k { color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .stat .v { font-family:ui-monospace,Menlo,monospace; font-size:1.45rem; color:var(--fg); margin-top:4px; }
  .stat .s { color:var(--muted); font-size:.78rem; margin-top:3px; }
  .layout { display:grid; gap:18px; grid-template-columns:1fr 320px; }
  @media (max-width:880px){ .layout { grid-template-columns:1fr; } }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .ph { padding:12px 16px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
  .ph h2 { margin:0; font-size:.95rem; color:var(--accent); }
  .ph input { background:#0b0e14; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 8px; font-size:.82rem; }
  .ph input:focus { outline:none; border-color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:.86rem; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; padding:9px 14px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--card); cursor:pointer; user-select:none; }
  th.num { text-align:right; }
  td { padding:8px 14px; border-bottom:1px solid var(--line); }
  td.num { font-family:ui-monospace,Menlo,monospace; text-align:right; }
  td.paid { color:var(--paid); }
  td.pow { color:var(--pow); }
  td.rev { color:var(--accent); font-weight:600; }
  td.muted { color:var(--muted); }
  td a { color:var(--fg); text-decoration:none; }
  td a:hover { color:var(--accent); }
  .tbody-scroll { max-height:560px; overflow:auto; }
  .feed { max-height:560px; overflow:auto; }
  .feed ul { list-style:none; margin:0; padding:0; }
  .feed li { display:grid; grid-template-columns:1fr auto; gap:4px 10px; padding:10px 16px; border-bottom:1px solid var(--line); font-size:.82rem; }
  .feed .rs { font-family:ui-monospace,Menlo,monospace; color:var(--fg); }
  .feed .rm { color:var(--muted); font-size:.78rem; }
  .feed .ra { grid-column:1/-1; color:var(--muted); font-size:.72rem; font-family:ui-monospace,Menlo,monospace; }
  .badge { display:inline-block; font-size:.62rem; font-weight:600; padding:1px 6px; border-radius:4px; margin-left:6px; letter-spacing:.04em; vertical-align:middle; font-family:ui-monospace,Menlo,monospace; }
  .badge.pow { background:rgba(96,165,250,.12); color:var(--pow); border:1px solid rgba(96,165,250,.3); }
  .badge.wallet { background:rgba(74,222,128,.1); color:var(--paid); border:1px solid rgba(74,222,128,.3); }
  ${CHROME_CSS}
</style>
</head>
<body><div class="wrap">

<h1>Operator dashboard</h1>
<p class="sub">Per-tool usage, settlement split, and live activity. Auto-refreshes every 10s. Not public — gated by <code>AGENT402_OPERATOR_TOKEN</code>.</p>

<div class="grid">
  <div class="stat"><div class="k">Total calls</div><div class="v" id="t-total">${esc(t.total ?? 0)}</div><div class="s">all tools, all rails</div></div>
  <div class="stat"><div class="k">USDC settled</div><div class="v" id="t-usdc">${esc(t.viaUSDC ?? 0)}</div><div class="s">on-chain proof at wallet</div></div>
  <div class="stat"><div class="k">Proof-of-work</div><div class="v" id="t-pow">${esc(t.viaProofOfWork ?? 0)}</div><div class="s">free tier</div></div>
  <div class="stat"><div class="k">Estimated revenue</div><div class="v" id="t-rev">$${esc((t.estimatedRevenueUsd ?? 0).toFixed ? t.estimatedRevenueUsd.toFixed(4) : t.estimatedRevenueUsd)}</div><div class="s">counter; chain is truth</div></div>
  <div class="stat"><div class="k">Tools served</div><div class="v" id="t-tools">${esc(t.toolsServed ?? 0)}</div><div class="s">distinct slugs</div></div>
  <div class="stat"><div class="k">Uptime</div><div class="v" id="t-up">${esc(Math.floor((data?.uptimeSeconds ?? 0) / 3600))}h</div><div class="s">since process boot</div></div>
</div>

<div class="layout">
  <div class="panel">
    <div class="ph"><h2>Per-tool breakdown</h2><input id="filter" type="search" placeholder="filter slug…" autocomplete="off"></div>
    <div class="tbody-scroll"><table id="tbl">
      <thead><tr><th data-k="slug">Slug</th><th class="num" data-k="calls">Calls</th><th class="num" data-k="paid">USDC</th><th class="num" data-k="pow">PoW</th><th class="num" data-k="rev">Revenue</th><th class="num" data-k="price">Price</th></tr></thead>
      <tbody id="tbody">${rows || `<tr><td colspan="6" class="muted" style="padding:24px;text-align:center;">No tool calls yet.</td></tr>`}</tbody>
    </table></div>
  </div>

  <div class="panel feed">
    <div class="ph"><h2>Recent calls</h2></div>
    <ul id="feed">${feed || `<li class="muted" style="text-align:center;">No recent activity.</li>`}</ul>
  </div>
</div>

<script>
(function(){
  var TOKEN=${JSON.stringify(token || "")};
  function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  var tbody=document.getElementById('tbody');
  var feed=document.getElementById('feed');
  var sortK='calls', sortDir=-1, rowsCache=${JSON.stringify(tools)};

  function renderRows(){
    var q=(document.getElementById('filter').value||'').toLowerCase();
    var rs=rowsCache.filter(function(r){ return !q || r.slug.toLowerCase().indexOf(q)>=0; });
    rs.sort(function(a,b){
      var k=sortK==='price'?'pricePerCall':(sortK==='rev'?'revenueUsd':sortK);
      var av=a[k], bv=b[k];
      if(typeof av==='string') return sortDir*av.localeCompare(bv);
      return sortDir*((av||0)-(bv||0));
    });
    tbody.innerHTML = rs.length ? rs.map(function(r){
      var b = r.walletOnly
        ? '<span class="badge wallet" title="USDC only — no proof-of-work path">USDC-ONLY</span>'
        : '<span class="badge pow" title="Also payable with proof-of-work (free tier)">FREE-W/POW</span>';
      return '<tr><td><a href="/tools/'+esc(r.slug)+'">'+esc(r.slug)+'</a> '+b+'</td>'+
        '<td class="num">'+esc(r.calls)+'</td>'+
        '<td class="num paid">'+esc(r.paid)+'</td>'+
        '<td class="num pow">'+esc(r.pow)+'</td>'+
        '<td class="num rev">$'+esc(r.revenueUsd.toFixed(4))+'</td>'+
        '<td class="num muted">$'+esc(r.pricePerCall.toFixed(4))+'</td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center;">No matches.</td></tr>';
  }
  document.getElementById('filter').addEventListener('input', renderRows);
  document.querySelectorAll('th[data-k]').forEach(function(th){
    th.addEventListener('click', function(){
      var k=th.getAttribute('data-k');
      if(sortK===k) sortDir=-sortDir; else { sortK=k; sortDir=-1; }
      renderRows();
    });
  });

  async function tick(){
    try {
      var r=await fetch('/__operator/stats?token='+encodeURIComponent(TOKEN),{cache:'no-store'});
      if(!r.ok) return;
      var d=await r.json();
      var t=d.totals||{};
      document.getElementById('t-total').textContent=t.total||0;
      document.getElementById('t-usdc').textContent=t.viaUSDC||0;
      document.getElementById('t-pow').textContent=t.viaProofOfWork||0;
      document.getElementById('t-rev').textContent='$'+((t.estimatedRevenueUsd||0).toFixed(4));
      document.getElementById('t-tools').textContent=t.toolsServed||0;
      document.getElementById('t-up').textContent=Math.floor((d.uptimeSeconds||0)/3600)+'h';
      rowsCache=d.tools||[]; renderRows();
      feed.innerHTML=(d.recentCalls||[]).map(function(x){
        return '<li><span class="rs">'+esc(x.slug)+'</span><span class="rm">'+(x.paidWith==='proof-of-work'?'⚙ PoW':'$ USDC')+'</span><span class="ra">'+esc(x.at)+'</span></li>';
      }).join('') || '<li class="muted" style="text-align:center;">No recent activity.</li>';
    } catch(e) { /* ignore */ }
  }
  setInterval(tick, 10000);
})();
</script>

</div></body></html>`;
}
