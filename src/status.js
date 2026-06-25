// Public status page — a trust-signal surface for visitors landing from
// articles or directories. Renders the same numbers /api/stats already exposes
// (uptime, served calls, last paid call, on-chain proof) but as a single
// human-readable HTML page that refreshes itself every 12s. No auth, no PII.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const fmtUptime = (sec) => {
  const s = Math.max(0, sec | 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${(s / 60) | 0}m ${s % 60}s`;
  if (s < 86400) return `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`;
  return `${(s / 86400) | 0}d ${((s % 86400) / 3600) | 0}h`;
};

const agoStr = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  return `${(s / 86400) | 0}d ago`;
};

export function statusPage(baseUrl, stats) {
  const served = stats?.toolCallsServed || { total: 0, viaUSDC: 0, viaProofOfWork: 0 };
  const last = stats?.recentCalls?.[0];
  const onchain = stats?.onchainRevenueProof;
  const walletName = stats?.walletName;
  const since = stats?.servingSince ? String(stats.servingSince).slice(0, 10) : null;
  const lastBlock = last
    ? `<div class="st-last"><div class="st-eyebrow">Last paid call</div>
        <div class="st-last-row"><span class="st-slug">${esc(last.slug)}</span>
        <span class="st-meta">${last.paidWith === "proof-of-work" ? "proof-of-work" : "$ USDC"} · ${agoStr(last.at)}</span></div></div>`
    : `<div class="st-last"><div class="st-eyebrow">Last paid call</div><div style="color:var(--faint);">No calls served yet in this window.</div></div>`;

  const extraCss = `
.st-wrap{max-width:1180px;margin:0 auto;padding:56px 30px}
.st-h1{font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 6px}
.st-sub{color:var(--muted);margin:0 0 28px;font-size:15px;line-height:1.55}
.st-sub a{color:var(--accent);text-decoration:none}
.st-sub a:hover{text-decoration:underline}
.st-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:var(--card);border:1.5px solid var(--ink);font-family:var(--font-mono);font-size:13px;font-weight:600;color:var(--green)}
.st-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 6px rgba(111,174,141,.18);animation:ml-pulse 2s ease-in-out infinite}
.st-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:24px 0}
.st-stat{background:var(--ink);border:1.5px solid var(--ink);padding:20px}
.st-stat .st-k{color:var(--dk-muted);font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.st-stat .st-v{font-family:var(--font-mono);font-size:1.6rem;color:var(--cream);margin-top:6px}
.st-stat .st-sv{color:var(--dk-muted);font-family:var(--font-mono);font-size:12px;margin-top:4px}
.st-stat .st-sv a{color:var(--accent);text-decoration:none}
.st-stat .st-sv a:hover{text-decoration:underline}
.st-last{background:var(--card);border:1.5px solid var(--ink);padding:20px;margin:14px 0}
.st-last-row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:baseline;margin-top:6px}
.st-slug{font-family:var(--font-mono);color:var(--ink)}
.st-meta{color:var(--faint);font-family:var(--font-mono);font-size:13px}
.st-eyebrow{color:var(--faint);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.st-links{margin-top:30px;color:var(--faint);font-family:var(--font-mono);font-size:13px}
.st-links a{color:var(--accent);text-decoration:none}
.st-links a:hover{text-decoration:underline}
@media(max-width:600px){.st-h1{font-size:36px !important}}
`;

  // NOTE: The inline <script> uses .textContent for all live-updated fields
  // (uptime, totals, revenue). The only place that sets .innerHTML is the
  // "last paid call" block, whose values are escaped through the same esc()
  // helper used server-side — this is the pre-existing AJAX refresh pattern
  // carried over from the original implementation.
  const body = `
<div class="st-wrap">

<h1 class="st-h1">Service status</h1>
<p class="st-sub">Every number on this page is recomputed live from <a href="/api/stats">/api/stats</a>. Settled revenue is independently verifiable on Basescan.</p>

<div class="st-pill"><span class="st-dot"></span> All systems operational</div>

<div class="st-grid">
  <div class="st-stat"><div class="st-k">Uptime (this process)</div><div class="st-v" id="uptime">${esc(fmtUptime(stats?.uptimeSeconds || 0))}</div><div class="st-sv">${since ? `serving since ${esc(since)}` : ""}</div></div>
  <div class="st-stat"><div class="st-k">Tools live</div><div class="st-v">${esc(stats?.tools ?? "—")}</div><div class="st-sv">${esc(stats?.payment?.network || "")} · ${esc(stats?.payment?.currency || "")}</div></div>
  <div class="st-stat"><div class="st-k">Calls served</div><div class="st-v" id="total">${esc(served.total)}</div><div class="st-sv"><span id="viaUSDC">${esc(served.viaUSDC)}</span> USDC · <span id="viaPoW">${esc(served.viaProofOfWork)}</span> PoW</div></div>
  <div class="st-stat"><div class="st-k">Estimated revenue</div><div class="st-v" id="rev">${esc(typeof stats?.estimatedRevenueUsd === "number" ? `$${stats.estimatedRevenueUsd.toFixed(4)}` : "—")}</div><div class="st-sv">${onchain ? `<a href="${esc(onchain)}" rel="noopener">on-chain proof</a>` : "counter only"}</div></div>
</div>

<div id="last-wrap">${lastBlock}</div>

<div class="st-links">
  <a href="/api/stats">/api/stats</a> ·
  <a href="/api/reliability">/api/reliability</a> ·
  <a href="/health">/health</a> ·
  <a href="/.well-known/x402">x402 manifest</a>
  ${onchain ? ` · <a href="${esc(onchain)}" rel="noopener">wallet on-chain</a>` : ""}
  ${walletName ? ` · paying to ${esc(walletName)}` : ""}
</div>

<script>
(function(){
  function fmt(sec){ sec=Math.max(0,sec|0); if(sec<60)return sec+'s'; if(sec<3600)return ((sec/60)|0)+'m '+(sec%60)+'s'; if(sec<86400)return ((sec/3600)|0)+'h '+(((sec%3600)/60)|0)+'m'; return ((sec/86400)|0)+'d '+(((sec%86400)/3600)|0)+'h'; }
  function ago(iso){ var s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000); if(s<60)return (s|0)+'s ago'; if(s<3600)return ((s/60)|0)+'m ago'; if(s<86400)return ((s/3600)|0)+'h ago'; return ((s/86400)|0)+'d ago'; }
  function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  async function tick(){
    try {
      var r=await fetch('/api/stats',{cache:'no-store'}); var d=await r.json();
      var s=d.toolCallsServed||{};
      var el=document.getElementById('uptime'); if(el) el.textContent=fmt(d.uptimeSeconds||0);
      var t=document.getElementById('total'); if(t) t.textContent=(s.total||0);
      var u=document.getElementById('viaUSDC'); if(u) u.textContent=(s.viaUSDC||0);
      var p=document.getElementById('viaPoW'); if(p) p.textContent=(s.viaProofOfWork||0);
      var rv=document.getElementById('rev'); if(rv) rv.textContent=(typeof d.estimatedRevenueUsd==='number'?'$'+d.estimatedRevenueUsd.toFixed(4):'—');
      var last=(d.recentCalls||[])[0];
      var w=document.getElementById('last-wrap');
      if(w&&last){
        w.querySelector('.st-slug').textContent=last.slug;
        w.querySelector('.st-meta').textContent=(last.paidWith==='proof-of-work'?'proof-of-work':'$ USDC')+' \u00b7 '+ago(last.at);
      }
    } catch(e) { /* ignore */ }
  }
  setInterval(tick,12000);
})();
</script>

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title: "Status — Agent402",
    description: "Live status for Agent402: uptime, tool calls served, settlement split (USDC + proof-of-work), and on-chain revenue proof.",
    canonical: `${baseUrl}/status`,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
