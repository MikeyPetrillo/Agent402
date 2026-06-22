// A tiny self-contained operator dashboard for the tollbooth, served at
// /__tollbooth by the reverse-proxy CLI. It polls /__tollbooth/stats and shows
// how much of your traffic is bots and what the gate is collecting — the visual
// answer to "I had to upgrade my plan to serve bots I don't monetize."
//
// Visual rhythm mirrors agent402.tools/analytics: stat-card grid, inline-SVG
// rolling sparkline (built client-side from poll deltas — no server changes,
// no third-party chart lib), and a window selector that changes how many
// recent polls feed the sparkline. Pure function (no deps) so it's trivially
// testable.
export function dashboardHtml() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>agent402-tollbooth — live stats</title>
<style>
  :root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--line:#1e2638;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:40px 20px}
  h1{font-size:1.4rem;display:flex;align-items:center;gap:10px}
  .badge{font:700 14px/1 var(--mono);color:var(--accent);background:#000;border:1px solid #1f4a1d;border-radius:8px;padding:8px 10px}
  .sub{color:var(--muted);margin:6px 0 24px;font-size:.9rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
  .k{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
  .v{font:800 1.8rem/1.1 var(--mono);margin-top:8px}
  .v.accent{color:var(--accent)}
  .spark{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:18px}
  .spark .row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:12px;flex-wrap:wrap}
  .spark h2{font-size:.95rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
  .spark .windows{display:flex;gap:6px}
  .spark .w{font:600 .8rem/1 var(--mono);color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer}
  .spark .w.active{color:var(--accent);border-color:#1f4a1d;background:#000}
  .spark svg{display:block;width:100%;height:80px}
  .ratios{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:18px}
  .ratios .card .v{font-size:1.5rem}
  .ratios .card .hint{color:var(--muted);font-size:.75rem;margin-top:6px;font-family:var(--mono)}
  footer{color:var(--muted);font-size:.8rem;margin-top:28px}
  a{color:var(--accent)}
</style></head>
<body><div class="wrap">
  <h1><span class="badge">402</span> agent402-tollbooth <span id="mode"></span></h1>
  <div class="sub">Live pay-per-crawl stats · refreshes every 5s · <span id="since"></span></div>
  <div class="grid" id="grid"></div>
  <div class="spark">
    <div class="row">
      <h2>Requests / poll</h2>
      <div class="windows" id="windows">
        <button class="w" data-n="12">1m</button>
        <button class="w active" data-n="60">5m</button>
        <button class="w" data-n="180">15m</button>
      </div>
    </div>
    <svg viewBox="0 0 720 80" preserveAspectRatio="none" id="sparksvg" aria-hidden="true">
      <polyline id="sparkline" fill="none" stroke="#4ade80" stroke-width="1.5" points=""/>
      <polygon id="sparkfill" fill="#4ade80" fill-opacity="0.08" points=""/>
    </svg>
  </div>
  <div class="ratios">
    <div class="card"><div class="k">Bot share</div><div class="v" id="botpct">—</div><div class="hint">charged + would-charge</div></div>
    <div class="card"><div class="k">Paid conversion</div><div class="v accent" id="paidpct">—</div><div class="hint">of all requests, paid (PoW or USDC)</div></div>
    <div class="card"><div class="k">Paid in USDC</div><div class="v accent" id="usdcpct">—</div><div class="hint">of paid, settled on Base</div></div>
  </div>
  <footer>Aggregate counts only (no per-request data). Raw JSON: <a href="/__tollbooth/stats">/__tollbooth/stats</a>.</footer>
</div>
<script>
const cards=[
  ["requests","Requests",false],
  ["freeAllowed","Humans (free)",false],
  ["wouldCharge","Would charge (observe)","accent"],
  ["charged","Charged (402)","accent"],
  ["powSolved","Proof-of-work paid","accent"],
  ["x402Paid","USDC paid (x402)","accent"],
  ["difficultyNow","PoW difficulty",false]
];
// Rolling poll-delta series for the sparkline. We retain up to MAX_POINTS
// raw deltas (one per 5s tick) and the active window selector controls how
// many of the tail points are plotted. Built client-side — no server-side
// timeseries store needed, and the data dies with the tab.
var MAX_POINTS=180; // 15 minutes at one poll per 5s
var series=[]; var lastRequests=null; var activeWindow=60;
function drawSpark(){
  var poly=document.getElementById("sparkline");
  var fill=document.getElementById("sparkfill");
  if(!poly||!fill) return;
  var pts=series.slice(-activeWindow);
  if(!pts.length){poly.setAttribute("points","");fill.setAttribute("points","");return;}
  var max=1; for(var i=0;i<pts.length;i++){if(pts[i]>max)max=pts[i];}
  var stepX=pts.length>1?720/(pts.length-1):0;
  var coords=[];
  for(var j=0;j<pts.length;j++){
    var x=(j*stepX).toFixed(1);
    var y=(80-(pts[j]/max)*76-2).toFixed(1);
    coords.push(x+","+y);
  }
  poly.setAttribute("points",coords.join(" "));
  fill.setAttribute("points","0,80 "+coords.join(" ")+" "+(720).toFixed(1)+",80");
}
function bindWindows(){
  var bs=document.querySelectorAll("#windows .w");
  for(var i=0;i<bs.length;i++){
    (function(b){
      b.addEventListener("click",function(){
        activeWindow=Number(b.getAttribute("data-n"))||60;
        for(var j=0;j<bs.length;j++) bs[j].classList.remove("active");
        b.classList.add("active");
        drawSpark();
      });
    })(bs[i]);
  }
}
async function tick(){
  try{
    const s=await (await fetch("/__tollbooth/stats",{cache:"no-store"})).json();
    // Counters are always numbers — coerce, never trust raw JSON from the
    // configured stats endpoint (a compromised collector with httpStatsSink
    // could otherwise inject HTML through this innerHTML sink).
    document.getElementById("grid").innerHTML=cards.map(function(c){
      var k=c[0],label=c[1],acc=c[2];
      if(k==="wouldCharge" && !(Number(s.wouldCharge)>0) && !s.observe) return "";
      var v=Number(s[k]); if(!Number.isFinite(v)) v=0;
      var lbl=String(label).replace(/[&<>"']/g,function(ch){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch];});
      return '<div class="card"><div class="k">'+lbl+'</div><div class="v '+(acc||"")+'">'+v+'</div></div>';
    }).join("");
    // Derived operator ratios — computed client-side so the gate stays a
    // pure counter store. All inputs are coerced numbers (see render loop
    // above), so a malicious snapshot can't smuggle non-numerics here.
    var reqs=Number(s.requests)||0;
    var botish=(Number(s.charged)||0)+(Number(s.wouldCharge)||0);
    var pct=reqs?Math.round((botish/reqs)*100):0;
    document.getElementById("botpct").textContent=pct+"%";
    // Paid conversion: of all requests, what share actually settled (either
    // PoW or USDC). Answers "is the gate converting traffic into payment?"
    var pow=Number(s.powSolved)||0, usd=Number(s.x402Paid)||0, paid=pow+usd;
    var paidPct=reqs?Math.round((paid/reqs)*100):0;
    document.getElementById("paidpct").textContent=paidPct+"%";
    // Paid-in-USDC share: of *paid* requests, how many settled in USDC vs PoW.
    // Answers "are bots paying me real money, or just grinding compute?" "—"
    // when there are no paid requests yet (avoids 0/0 NaN).
    document.getElementById("usdcpct").textContent=paid?Math.round((usd/paid)*100)+"%":"\u2014";
    document.getElementById("mode").textContent=s.observe?" \u00B7 OBSERVE":"";
    if(s.since)document.getElementById("since").textContent="since "+new Date(s.since).toLocaleString();
    // Roll the series: delta of total requests since the last tick is the
    // per-poll arrival rate. First tick seeds lastRequests with no plot.
    var now=Number(s.requests); if(!Number.isFinite(now)) now=0;
    if(lastRequests!==null){
      var delta=Math.max(0,now-lastRequests);
      series.push(delta);
      if(series.length>MAX_POINTS) series.shift();
      drawSpark();
    }
    lastRequests=now;
  }catch(e){/* keep last values */}
}
bindWindows();
tick();setInterval(tick,5000);
</script>
</body></html>`;
}
