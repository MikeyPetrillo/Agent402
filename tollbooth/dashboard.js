// A tiny self-contained operator dashboard for the tollbooth, served at
// /__tollbooth by the reverse-proxy CLI. It polls /__tollbooth/stats and shows
// how much of your traffic is bots and what the gate is collecting — the visual
// answer to "I had to upgrade my plan to serve bots I don't monetize."
// Pure function (no deps) so it's trivially testable.
export function dashboardHtml() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>agent402-tollbooth — live stats</title>
<style>
  :root{--bg:#0b0e14;--card:#131826;--text:#e6e9f0;--muted:#8b93a7;--accent:#4ade80;--line:#1e2638;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,sans-serif}
  .wrap{max-width:880px;margin:0 auto;padding:40px 20px}
  h1{font-size:1.4rem;display:flex;align-items:center;gap:10px}
  .badge{font:700 14px/1 var(--mono);color:var(--accent);background:#000;border:1px solid #1f4a1d;border-radius:8px;padding:8px 10px}
  .sub{color:var(--muted);margin:6px 0 24px;font-size:.9rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
  .k{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
  .v{font:800 1.8rem/1.1 var(--mono);margin-top:8px}
  .v.accent{color:var(--accent)}
  footer{color:var(--muted);font-size:.8rem;margin-top:28px}
  a{color:var(--accent)}
</style></head>
<body><div class="wrap">
  <h1><span class="badge">402</span> agent402-tollbooth <span id="mode"></span></h1>
  <div class="sub">Live pay-per-crawl stats · refreshes every 5s · <span id="since"></span></div>
  <div class="grid" id="grid"></div>
  <footer><b id="botpct">—</b> of requests were classified as AI bots. Aggregate counts only (no per-request data). Raw JSON: <a href="/__tollbooth/stats">/__tollbooth/stats</a>.</footer>
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
async function tick(){
  try{
    const s=await (await fetch("/__tollbooth/stats",{cache:"no-store"})).json();
    document.getElementById("grid").innerHTML=cards.map(function(c){
      var k=c[0],label=c[1],acc=c[2];
      if(k==="wouldCharge" && !(s.wouldCharge>0) && !s.observe) return "";
      return '<div class="card"><div class="k">'+label+'</div><div class="v '+(acc||"")+'">'+(s[k]??0)+'</div></div>';
    }).join("");
    var botish=(s.charged||0)+(s.wouldCharge||0);
    var pct=s.requests?Math.round((botish/s.requests)*100):0;
    document.getElementById("botpct").textContent=pct+"%";
    document.getElementById("mode").textContent=s.observe?" · OBSERVE":"";
    if(s.since)document.getElementById("since").textContent="since "+new Date(s.since).toLocaleString();
  }catch(e){/* keep last values */}
}
tick();setInterval(tick,5000);
</script>
</body></html>`;
}
