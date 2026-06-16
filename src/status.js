// Public status page — a trust-signal surface for visitors landing from
// articles or directories. Renders the same numbers /api/stats already exposes
// (uptime, served calls, last paid call, on-chain proof) but as a single
// human-readable HTML page that refreshes itself every 12s. No auth, no PII.
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

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
    ? `<div class="last"><div class="eyebrow">Last paid call</div>
        <div class="last-row"><span class="slug">${esc(last.slug)}</span>
        <span class="meta">${last.paidWith === "proof-of-work" ? "⚙ proof-of-work" : "$ USDC"} · ${agoStr(last.at)}</span></div></div>`
    : `<div class="last"><div class="eyebrow">Last paid call</div><div class="muted">No calls served yet in this window.</div></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status — Agent402</title>
<meta name="description" content="Live status for Agent402: uptime, tool calls served, settlement split (USDC + proof-of-work), and on-chain revenue proof.">
<link rel="canonical" href="${baseUrl}/status">
<meta property="og:title" content="Status — Agent402">
<meta property="og:description" content="Live status for Agent402: uptime, calls served, settlement split, on-chain proof.">
<meta property="og:image" content="${baseUrl}/card.png">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="60">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --card:#0f1320; }
  body { background:var(--bg); color:var(--fg); font:16px/1.6 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:880px; margin:0 auto; padding:48px 20px 24px; }
  h1 { font-size:1.6rem; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 28px; }
  .pill { display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border-radius:999px; background:rgba(74,222,128,.08); color:var(--accent); border:1px solid rgba(74,222,128,.28); font-size:.9rem; font-weight:600; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 6px rgba(74,222,128,.18); animation:pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow:0 0 0 10px rgba(74,222,128,0); } }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); margin:24px 0; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; }
  .stat .k { color:var(--muted); font-size:.8rem; letter-spacing:.05em; text-transform:uppercase; }
  .stat .v { font-family:ui-monospace,Menlo,monospace; font-size:1.6rem; color:var(--fg); margin-top:6px; }
  .stat .sub-v { color:var(--muted); font-size:.85rem; margin-top:4px; }
  .last { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:14px 0; }
  .last-row { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px; align-items:baseline; margin-top:6px; }
  .last .slug { font-family:ui-monospace,Menlo,monospace; color:var(--fg); }
  .last .meta { color:var(--muted); font-size:.9rem; }
  .eyebrow { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
  .muted { color:var(--muted); }
  .links { margin-top:30px; color:var(--muted); font-size:.9rem; }
  .links a { color:var(--accent); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  ${CHROME_CSS}
</style>
</head>
<body>${renderHeader("/status")}<div class="wrap">

<h1>Service status</h1>
<p class="sub">Every number on this page is recomputed live from <a href="/api/stats">/api/stats</a>. Settled revenue is independently verifiable on Basescan.</p>

<div class="pill"><span class="dot"></span> All systems operational</div>

<div class="grid">
  <div class="stat"><div class="k">Uptime (this process)</div><div class="v" id="uptime">${esc(fmtUptime(stats?.uptimeSeconds || 0))}</div><div class="sub-v">${since ? `serving since ${esc(since)}` : ""}</div></div>
  <div class="stat"><div class="k">Tools live</div><div class="v">${esc(stats?.tools ?? "—")}</div><div class="sub-v">${esc(stats?.payment?.network || "")} · ${esc(stats?.payment?.currency || "")}</div></div>
  <div class="stat"><div class="k">Calls served</div><div class="v" id="total">${esc(served.total)}</div><div class="sub-v"><span id="viaUSDC">${esc(served.viaUSDC)}</span> USDC · <span id="viaPoW">${esc(served.viaProofOfWork)}</span> PoW</div></div>
  <div class="stat"><div class="k">Estimated revenue</div><div class="v" id="rev">${esc(typeof stats?.estimatedRevenueUsd === "number" ? `$${stats.estimatedRevenueUsd.toFixed(4)}` : "—")}</div><div class="sub-v">${onchain ? `<a href="${esc(onchain)}" rel="noopener">on-chain proof ↗</a>` : "counter only"}</div></div>
</div>

<div id="last-wrap">${lastBlock}</div>

<div class="links">
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
      if(w){
        if(last){
          w.innerHTML='<div class="last"><div class="eyebrow">Last paid call</div><div class="last-row"><span class="slug">'+esc(last.slug)+'</span><span class="meta">'+(last.paidWith==='proof-of-work'?'⚙ proof-of-work':'$ USDC')+' · '+ago(last.at)+'</span></div></div>';
        } else {
          w.innerHTML='<div class="last"><div class="eyebrow">Last paid call</div><div class="muted">No calls served yet in this window.</div></div>';
        }
      }
    } catch(e) { /* ignore */ }
  }
  setInterval(tick,12000);
})();
</script>

</div>${renderFooter()}</body></html>`;
}
