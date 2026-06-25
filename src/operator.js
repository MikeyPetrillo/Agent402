// Operator dashboard — every served tool with its call count, USDC vs PoW
// split, estimated revenue, and the full retained recent-calls feed. Gated by
// AGENT402_OPERATOR_TOKEN (query ?token=…). Nothing here is shown publicly;
// /api/stats remains the safe public surface.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function operatorPage(baseUrl, data) {
  const t = data?.totals || {};
  const tools = Array.isArray(data?.tools) ? data.tools : [];
  const recent = Array.isArray(data?.recentCalls) ? data.recentCalls : [];
  const badge = (r) => r.walletOnly
    ? `<span class="op-badge op-badge-wallet" title="USDC only — no proof-of-work path">USDC-ONLY</span>`
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
.op-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 6px}
.op-sub{color:var(--muted);margin:0 0 22px;font-size:14px;line-height:1.55}
.op-sub a{color:var(--accent);text-decoration:none}
.op-sub a:hover{text-decoration:underline}
.op-sub code{font-family:var(--font-mono);font-size:12px;background:var(--ink);color:var(--cream);padding:2px 7px;border:1.5px solid var(--ink)}
.op-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin:0 0 22px}
.op-stat{background:var(--ink);border:1.5px solid var(--ink);padding:16px}
.op-stat .op-k{color:var(--dk-muted);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.op-stat .op-v{font-family:var(--font-mono);font-size:1.45rem;color:var(--cream);margin-top:4px}
.op-stat .op-s{color:var(--dk-muted);font-family:var(--font-mono);font-size:12px;margin-top:3px}
.op-layout{display:grid;gap:18px;grid-template-columns:1fr 320px}
@media(max-width:880px){.op-layout{grid-template-columns:1fr}}
.op-panel{background:var(--ink);border:1.5px solid var(--ink);overflow:hidden}
.op-ph{padding:12px 16px;border-bottom:1px solid var(--dark-border);display:flex;justify-content:space-between;align-items:center}
.op-ph h2{margin:0;font-size:.95rem;color:var(--accent);font-family:var(--font-body);font-weight:700}
.op-ph input{background:var(--ink-panel);color:var(--cream);border:1px solid var(--dark-border);padding:5px 8px;font-family:var(--font-mono);font-size:12px}
.op-ph input:focus{outline:none;border-color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dk-muted);font-weight:500;font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:9px 14px;border-bottom:1px solid var(--dark-border);position:sticky;top:0;background:var(--ink);cursor:pointer;user-select:none}
th.num{text-align:right}
td{padding:8px 14px;border-bottom:1px solid var(--dark-border);color:var(--cream);font-family:var(--font-mono);font-size:13px}
td.num{text-align:right}
td.op-paid{color:var(--green)}
td.op-pow{color:#7cb3e0}
td.op-hb{color:#b0a0d0}
td.op-rev{color:var(--accent);font-weight:600}
td.op-muted{color:var(--dk-muted)}
td a{color:var(--cream);text-decoration:none}
td a:hover{color:var(--accent)}
.op-tbody-scroll{max-height:560px;overflow:auto}
.op-feed{max-height:560px;overflow:auto}
.op-feed ul{list-style:none;margin:0;padding:0}
.op-feed li{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:10px 16px;border-bottom:1px solid var(--dark-border);font-size:12px}
.op-rs{font-family:var(--font-mono);color:var(--cream)}
.op-rm{color:var(--dk-muted);font-family:var(--font-mono);font-size:12px}
.op-ra{grid-column:1/-1;color:var(--dk-muted);font-family:var(--font-mono);font-size:11px}
.op-badge{display:inline-block;font-family:var(--font-mono);font-size:10px;font-weight:600;padding:1px 6px;margin-left:6px;letter-spacing:.04em;vertical-align:middle}
.op-badge-pow{background:rgba(124,179,224,.12);color:#7cb3e0;border:1px solid rgba(124,179,224,.3)}
.op-badge-wallet{background:rgba(111,174,141,.12);color:var(--green);border:1px solid rgba(111,174,141,.3)}
@media(max-width:600px){.op-h1{font-size:36px !important}}
`;

  // NOTE: The inline <script> preserves the existing operator auth pattern:
  // token capture from ?token= into sessionStorage, URL stripping via
  // replaceState, and inter-page navigation via fetch()+document.write() so
  // the token travels in the Authorization header, never in the URL. The
  // table/feed refresh uses the same AJAX + DOM update pattern as before.
  const body = `
<div class="op-wrap">

<h1 class="op-h1">Operator dashboard</h1>
<p class="op-sub">Per-tool usage, settlement split, and live activity. Auto-refreshes every 10s. Not public — gated by <code>AGENT402_OPERATOR_TOKEN</code>. <a href="/__operator/leads" data-op-link>Tollbooth leads</a></p>

<div class="op-grid">
  <div class="op-stat"><div class="op-k">Total calls</div><div class="op-v" id="t-total">${esc(t.total ?? 0)}</div><div class="op-s">all tools, all rails</div></div>
  <div class="op-stat"><div class="op-k">USDC settled</div><div class="op-v" id="t-usdc">${esc(t.viaUSDC ?? 0)}</div><div class="op-s">on-chain proof at wallet</div></div>
  <div class="op-stat"><div class="op-k">PoW (external)</div><div class="op-v" id="t-pow">${esc(t.viaProofOfWork ?? 0)}</div><div class="op-s">real free-tier adoption</div></div>
  <div class="op-stat"><div class="op-k">Heartbeat probes</div><div class="op-v" id="t-hb">${esc(t.viaHeartbeat ?? 0)}</div><div class="op-s">internal /api/hash probe</div></div>
  <div class="op-stat"><div class="op-k">Estimated revenue</div><div class="op-v" id="t-rev">$${esc((t.estimatedRevenueUsd ?? 0).toFixed ? t.estimatedRevenueUsd.toFixed(4) : t.estimatedRevenueUsd)}</div><div class="op-s">counter; chain is truth</div></div>
  <div class="op-stat"><div class="op-k">Tools served</div><div class="op-v" id="t-tools">${esc(t.toolsServed ?? 0)}</div><div class="op-s">distinct slugs</div></div>
  <div class="op-stat"><div class="op-k">Uptime</div><div class="op-v" id="t-up">${esc(Math.floor((data?.uptimeSeconds ?? 0) / 3600))}h</div><div class="op-s">since process boot</div></div>
</div>

<div class="op-layout">
  <div class="op-panel">
    <div class="op-ph"><h2>Per-tool breakdown</h2><input id="filter" type="search" placeholder="filter slug…" autocomplete="off"></div>
    <div class="op-tbody-scroll"><table id="tbl">
      <thead><tr><th data-k="slug">Slug</th><th class="num" data-k="calls">Calls</th><th class="num" data-k="paid">USDC</th><th class="num" data-k="pow" title="External proof-of-work — does not include the heartbeat probe">PoW</th><th class="num" data-k="heartbeat" title="Internal /api/hash probe (agent402-heartbeat UA, every 15 min)">HB</th><th class="num" data-k="rev">Revenue</th><th class="num" data-k="price">Price</th></tr></thead>
      <tbody id="tbody">${rows || `<tr><td colspan="7" class="op-muted" style="padding:24px;text-align:center;">No tool calls yet.</td></tr>`}</tbody>
    </table></div>
  </div>

  <div class="op-panel op-feed">
    <div class="op-ph"><h2>Recent calls</h2></div>
    <ul id="feed">${feed || `<li style="text-align:center;color:var(--dk-muted);padding:16px;">No recent activity.</li>`}</ul>
  </div>
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
  var authHeader = function(){ return TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {}; };
  document.querySelectorAll('a[data-op-link]').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault();
      fetch(a.getAttribute('href'), { headers: authHeader(), cache: 'no-store' })
        .then(function(r){ return r.text(); })
        .then(function(t){
          document.open(); document.write(t); document.close();
          history.pushState({}, '', a.getAttribute('href'));
        })
        .catch(function(){});
    });
  });
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
    var html = rs.length ? rs.map(function(r){
      var b = r.walletOnly
        ? '<span class="op-badge op-badge-wallet" title="USDC only">USDC-ONLY</span>'
        : '<span class="op-badge op-badge-pow" title="Also payable with proof-of-work">FREE-W/POW</span>';
      return '<tr><td><a href="/tools/'+esc(r.slug)+'">'+esc(r.slug)+'</a> '+b+'</td>'+
        '<td class="num">'+esc(r.calls)+'</td>'+
        '<td class="num op-paid">'+esc(r.paid)+'</td>'+
        '<td class="num op-pow">'+esc(r.pow)+'</td>'+
        '<td class="num op-hb">'+esc(r.heartbeat||0)+'</td>'+
        '<td class="num op-rev">$'+esc(r.revenueUsd.toFixed(4))+'</td>'+
        '<td class="num op-muted">$'+esc(r.pricePerCall.toFixed(4))+'</td></tr>';
    }).join('') : '<tr><td colspan="7" class="op-muted" style="padding:24px;text-align:center;">No matches.</td></tr>';
    tbody.innerHTML = html; /* eslint-disable-line -- pre-existing AJAX table refresh; all values esc()-d */
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
      var r=await fetch('/__operator/stats',{cache:'no-store', headers: authHeader()});
      if(!r.ok) return;
      var d=await r.json();
      var tt=d.totals||{};
      document.getElementById('t-total').textContent=tt.total||0;
      document.getElementById('t-usdc').textContent=tt.viaUSDC||0;
      document.getElementById('t-pow').textContent=tt.viaProofOfWork||0;
      document.getElementById('t-hb').textContent=tt.viaHeartbeat||0;
      document.getElementById('t-rev').textContent='$'+((tt.estimatedRevenueUsd||0).toFixed(4));
      document.getElementById('t-tools').textContent=tt.toolsServed||0;
      document.getElementById('t-up').textContent=Math.floor((d.uptimeSeconds||0)/3600)+'h';
      rowsCache=d.tools||[]; renderRows();
      var feedHtml=(d.recentCalls||[]).map(function(x){
        var m=x.paidWith==='proof-of-work'?'PoW':x.paidWith==='heartbeat'?'HB':'$ USDC';
        return '<li><span class="op-rs">'+esc(x.slug)+'</span><span class="op-rm">'+m+'</span><span class="op-ra">'+esc(x.at)+'</span></li>';
      }).join('') || '<li style="text-align:center;color:var(--dk-muted);padding:16px;">No recent activity.</li>';
      feed.innerHTML = feedHtml; /* eslint-disable-line -- pre-existing AJAX feed refresh; all values esc()-d */
    } catch(e) { /* ignore */ }
  }
  setInterval(tick, 10000);
})();
</script>

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Operator — Agent402",
    description: "Agent402 operator dashboard — per-tool usage, settlement split, and live activity.",
    canonical: `${baseUrl}/__operator`,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
