(function(){
  // The session cookie authenticates same-origin requests automatically; nav is
  // plain links and the refresh below needs no token handling.
  function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  var tbody=document.getElementById('tbody');
  var feed=document.getElementById('feed');
  // Live per-tool data - was templated directly into this script's text
  // (`rowsCache=${JSON.stringify(tools)}`); now read from the JSON island
  // op-rows-data emits (CSP hardening, 2026-08-16 - this value is genuinely
  // per-request, unlike most of this site's other inline-script data).
  var rowsDataEl = document.getElementById('op-rows-data');
  var sortK='calls', sortDir=-1, rowsCache = rowsDataEl ? JSON.parse(rowsDataEl.textContent) : [];

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
      var r=await fetch('/__operator/stats',{cache:'no-store'});
      if(!r.ok) return;
      var d=await r.json();
      var tt=d.totals||{};
      document.getElementById('t-total').textContent=tt.total||0;
      document.getElementById('t-usdc').textContent=tt.viaUSDC||0;
      document.getElementById('t-pow').textContent=tt.viaProofOfWork||0;
      document.getElementById('t-hb').textContent=tt.viaHeartbeat||0;
      document.getElementById('t-rev').textContent='$'+((tt.estimatedRevenueUsd||0).toFixed(4));
      document.getElementById('t-tools').textContent=tt.toolsServed||0;
      document.getElementById('t-up').textContent=Math.floor((d.processUptimeSeconds||0)/3600)+'h';
      rowsCache=d.tools||[]; renderRows();
      var feedHtml=(d.recentCalls||[]).map(function(x){
        var m=x.paidWith==='proof-of-work'?'PoW':x.paidWith==='heartbeat'?'HB':'$ USDC';
        return '<li><span class="op-rs">'+esc(x.slug)+'</span><span class="op-rm">'+m+'</span><span class="op-ra">'+esc(x.at)+'</span></li>';
      }).join('') || '<li style="text-align:center;color:var(--on-panel-dim);padding:16px;">No recent activity.</li>';
      feed.innerHTML = feedHtml; /* eslint-disable-line -- pre-existing AJAX feed refresh; all values esc()-d */
    } catch(e) { /* ignore */ }
  }
  setInterval(tick, 10000);
})();
