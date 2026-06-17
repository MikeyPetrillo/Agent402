// Dedicated install landing page for agent402-tollbooth, the sell-side gate.
//
// Single-purpose: a visitor arriving from the launch article, a LinkedIn
// thread, or the README clicks "install tollbooth" and lands on ONE page that
// shows them the snippet, lets them paste a wallet address, and gives them the
// observe → bots → strict progression with one knob each. No marketing, no
// pricing tables, no "request a demo." The snippet on the page is the install.
import { CHROME_HEAD_LINKS, CHROME_CSS, renderHeader, renderFooter } from "./chrome.js";

export function tollboothLandingPage(baseUrl) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tollbooth — charge AI bots that crawl your site (30-second install)</title>
<meta name="description" content="agent402-tollbooth is an open-source, self-hostable pay-per-crawl gate. Drop it in front of any Node site (Express, Next.js, Cloudflare Worker, Docker) and AI crawlers pay USDC on Base — or burn CPU — to read your content. Humans browse free.">
<link rel="canonical" href="${baseUrl}/tollbooth">
<meta property="og:title" content="Tollbooth — charge AI bots per crawl, in 30 seconds">
<meta property="og:description" content="Open-source pay-per-crawl gate. Drop it in front of any Node site and AI crawlers pay USDC on Base, or burn CPU. Humans browse free.">
<meta property="og:image" content="${baseUrl}/card.png">
<meta name="twitter:card" content="summary_large_image">
${CHROME_HEAD_LINKS}
<style>
  :root { --bg:#0b0e14; --fg:#e6e9f0; --muted:#8b93a7; --accent:#4ade80; --line:#1e2638; --card:#0f1320; --warn:#fbbf24; }
  body { background:var(--bg); color:var(--fg); font:16px/1.6 system-ui,-apple-system,sans-serif; margin:0; }
  .wrap { max-width:880px; margin:0 auto; padding:48px 20px 24px; }
  h1 { font-size:2rem; margin:0 0 8px; letter-spacing:-.02em; }
  .lede { color:var(--muted); margin:0 0 32px; font-size:1.05rem; }
  h2 { font-size:1.15rem; margin:36px 0 8px; color:var(--accent); }
  .config { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:0 0 14px; display:grid; gap:14px; grid-template-columns:1fr 160px 1fr; align-items:end; }
  .config label { display:block; }
  .config .k { color:var(--muted); font-size:.75rem; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px; }
  .config input, .config select { width:100%; box-sizing:border-box; background:#0b0e14; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:9px 11px; font:.95rem ui-monospace,Menlo,monospace; }
  .config input:focus, .config select:focus { outline:none; border-color:var(--accent); }
  @media (max-width:720px){ .config { grid-template-columns:1fr; } }
  .install { background:#000; border:1px solid var(--line); border-radius:12px; padding:16px 18px; position:relative; overflow:auto; }
  .install pre { margin:0; font:.9rem ui-monospace,Menlo,monospace; color:#dbeafe; white-space:pre; }
  .install .copy { position:absolute; top:10px; right:10px; background:#0f1320; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 9px; cursor:pointer; font-size:.78rem; }
  .install .copy:hover { border-color:var(--accent); color:var(--accent); }
  .install + .install { margin-top:10px; }
  .kw { color:#c084fc; } .str { color:#86efac; } .com { color:#64748b; } .num { color:#fbbf24; }
  .phase { display:grid; gap:12px; grid-template-columns:repeat(3,1fr); margin:18px 0; }
  @media (max-width:720px){ .phase { grid-template-columns:1fr; } }
  .step { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .step h3 { margin:0 0 4px; font-size:.95rem; color:var(--fg); }
  .step .mode { font-family:ui-monospace,Menlo,monospace; color:var(--accent); font-size:.85rem; }
  .step p { margin:6px 0 0; color:var(--muted); font-size:.88rem; }
  .row { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 24px; }
  .row a { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 12px; color:var(--fg); text-decoration:none; font-size:.88rem; }
  .row a:hover { border-color:var(--accent); color:var(--accent); }
  .deploy { display:grid; gap:10px; grid-template-columns:repeat(3,1fr); }
  @media (max-width:720px){ .deploy { grid-template-columns:1fr; } }
  .deploy a { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; color:var(--fg); text-decoration:none; }
  .deploy a:hover { border-color:var(--accent); }
  .deploy a .t { font-weight:600; }
  .deploy a .s { color:var(--muted); font-size:.85rem; display:block; margin-top:4px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .note { color:var(--muted); font-size:.88rem; margin-top:8px; }
  .cloud-cta { display:flex; gap:10px; align-items:center; justify-content:space-between; background:linear-gradient(180deg,#0f1320,#0b0e14); border:1px solid var(--line); border-radius:10px; padding:10px 14px; margin:0 0 22px; font-size:.9rem; color:var(--muted); }
  .cloud-cta a { color:var(--accent); white-space:nowrap; }
  @media (max-width:520px){ .cloud-cta { flex-direction:column; align-items:flex-start; } }
  ${CHROME_CSS}
</style>
</head>
<body>${renderHeader("/tollbooth")}<div class="wrap">

<h1>Charge AI bots that crawl your site</h1>
<p class="lede"><b>agent402-tollbooth</b> is an open-source, self-hostable pay-per-crawl gate. Drop it in front of any Node site and AI crawlers pay USDC on Base — or burn CPU — to read your content. Humans browse free. <a href="https://github.com/MikeyPetrillo/Agent402/wiki/Pay-per-crawl-Walkthrough" rel="noopener">30-min walkthrough →</a></p>

<div class="cloud-cta">
  <span>Managing multiple sites or running an SEO agency? Multi-site rollup, alerts, white-label dashboard, 20% partner program.</span>
  <a href="/tollbooth/cloud">Tollbooth Cloud →</a>
</div>

<h2>1 · Configure</h2>
<div class="config">
  <label><span class="k">Your wallet (Base, USDC)</span>
    <input id="wallet" type="text" value="0xYourWalletHere" autocomplete="off" spellcheck="false">
  </label>
  <label><span class="k">Price per request</span>
    <input id="price" type="text" value="$0.002" autocomplete="off" spellcheck="false">
  </label>
  <label><span class="k">Mode</span>
    <select id="mode">
      <option value="observe" selected>observe — watch only</option>
      <option value="bots">bots — charge AI crawlers</option>
      <option value="all">all — charge everything non-human</option>
      <option value="strict">strict — paywall everyone</option>
    </select>
  </label>
</div>
<p class="note">Tip: leave it in <code>observe</code> mode for 24h. Your dashboard at <code>/__tollbooth</code> will show what's actually crawling you before you ever charge anyone.</p>

<h2>2 · Install</h2>
<div class="install"><button class="copy" data-target="cmd">copy</button><pre id="cmd"><span class="kw">npm</span> install agent402-tollbooth</pre></div>

<div class="install"><button class="copy" data-target="snip">copy</button><pre id="snip"></pre></div>

<p class="note">That's it. Start your server normally. Add a <code>TOLLBOOTH_STATS_TOKEN</code> env var to view the dashboard at <code>/__tollbooth?token=&lt;your token&gt;</code>.</p>

<h2>3 · Roll out safely</h2>
<div class="phase">
  <div class="step"><h3>Phase 1 · 24h</h3><div class="mode">mode: "observe"</div><p>Nothing is blocked. Dashboard shows you what's crawling and what you <i>would</i> charge.</p></div>
  <div class="step"><h3>Phase 2 · ongoing</h3><div class="mode">mode: "bots"</div><p>Known AI crawlers (GPTBot, ClaudeBot, CCBot, Perplexity, …) get 402. Humans + Googlebot pass.</p></div>
  <div class="step"><h3>Phase 3 · optional</h3><div class="mode">mode: "all" / "strict"</div><p>Catch unidentified bots too. Adaptive proof-of-work keeps the page reachable for legit edge cases.</p></div>
</div>

<h2>Not running Express?</h2>
<div class="deploy">
  <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/cloudflare" rel="noopener"><span class="t">Cloudflare Worker</span><span class="s">One <code>wrangler deploy</code>. KV-backed.</span></a>
  <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/nextjs" rel="noopener"><span class="t">Next.js middleware</span><span class="s">One file in <code>middleware.ts</code>.</span></a>
  <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/docker" rel="noopener"><span class="t">Docker reverse proxy</span><span class="s">Any backend, any language.</span></a>
</div>

<h2>More</h2>
<div class="row">
  <a href="https://github.com/MikeyPetrillo/Agent402/wiki/Pay-per-crawl-Walkthrough" rel="noopener">30-min walkthrough</a>
  <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth" rel="noopener">README + reference</a>
  <a href="https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/demo.js" rel="noopener"><code>node demo.js</code></a>
  <a href="https://www.npmjs.com/package/agent402-tollbooth" rel="noopener">npm</a>
</div>

<script>
(function(){
  function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  var w=document.getElementById('wallet'), p=document.getElementById('price'), m=document.getElementById('mode'), out=document.getElementById('snip');
  function render(){
    var wallet=esc((w.value||'').trim()||'0xYourWalletHere');
    var price=esc((p.value||'').trim()||'$0.002');
    var mode=esc(m.value);
    var modeLine = mode==='observe'
      ? '<span class="kw">observe</span>: <span class="num">true</span>,                       <span class="com">// no 402s yet — watch first</span>'
      : '<span class="kw">mode</span>: <span class="str">"'+mode+'"</span>,                   <span class="com">// '+(mode==='bots'?'charge AI crawlers; humans pass':mode==='all'?'charge everything non-human':'paywall everyone')+'</span>';
    out.innerHTML =
      '<span class="kw">import</span> express <span class="kw">from</span> <span class="str">"express"</span>;\\n' +
      '<span class="kw">import</span> { createTollbooth } <span class="kw">from</span> <span class="str">"agent402-tollbooth"</span>;\\n\\n' +
      '<span class="kw">const</span> app = <span class="kw">express</span>();\\n' +
      'app.<span class="kw">use</span>(<span class="kw">createTollbooth</span>({\\n' +
      '  <span class="kw">payTo</span>: <span class="str">"'+wallet+'"</span>,\\n' +
      '  <span class="kw">price</span>: <span class="str">"'+price+'"</span>,\\n' +
      '  ' + modeLine + '\\n' +
      '  <span class="kw">statsToken</span>: process.env.<span class="kw">TOLLBOOTH_STATS_TOKEN</span>,\\n' +
      '}));\\n' +
      'app.<span class="kw">use</span>(yourExistingRoutes);\\n' +
      'app.<span class="kw">listen</span>(<span class="num">3000</span>);';
  }
  w.addEventListener('input', render);
  p.addEventListener('input', render);
  m.addEventListener('change', render);
  render();

  document.querySelectorAll('.copy').forEach(function(btn){
    btn.addEventListener('click', function(){
      var el=document.getElementById(btn.getAttribute('data-target'));
      if(!el) return;
      var txt=el.innerText;
      if(navigator.clipboard) navigator.clipboard.writeText(txt);
      var old=btn.textContent; btn.textContent='copied'; setTimeout(function(){ btn.textContent=old; }, 1200);
    });
  });
})();
</script>

</div>${renderFooter()}</body></html>`;
}
