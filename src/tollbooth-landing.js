// Dedicated install landing page for agent402-tollbooth, the sell-side gate.
//
// Single-purpose: a visitor arriving from the launch article, a LinkedIn
// thread, or the README clicks "install tollbooth" and lands on ONE page that
// shows them the snippet, lets them paste a wallet address, and gives them the
// observe → bots → strict progression with one knob each. No marketing, no
// pricing tables, no "request a demo." The snippet on the page is the install.
//
// NOTE: The inline script uses innerHTML to render syntax-highlighted code
// snippets from user-controlled config inputs (wallet, price, mode). All
// interpolated values are HTML-escaped via the inline esc() function before
// insertion, matching the original pre-migration implementation.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

export function tollboothLandingPage(baseUrl) {
  const title = "Tollbooth — charge AI bots that crawl your site (30-second install)";
  const description = "agent402-tollbooth is an open-source, self-hostable pay-per-crawl gate. Drop it in front of any Node site (Express, Next.js, Cloudflare Worker, Docker) and AI crawlers pay USDC on Base (or Solana, Polygon, Arbitrum) — or burn CPU — to read your content. Humans browse free.";
  const canonical = `${baseUrl}/tollbooth`;

  const extraCss = `
  .tb-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  h1 { font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 12px; }
  .lede { color:var(--muted); margin:0 0 32px; font-size:1.05rem; line-height:1.6; }
  .lede a { color:var(--accent); text-decoration:none; }
  .lede a:hover { text-decoration:underline; }
  h2 { font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:36px 0 12px;color:var(--accent); }
  .config { background:var(--card); border:1.5px solid var(--ink); padding:18px; margin:0 0 14px; display:grid; gap:14px; grid-template-columns:1fr 160px 1fr; align-items:end; }
  .config label { display:block; }
  .config .k { color:var(--faint); font-family:var(--font-mono); font-size:.75rem; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px; }
  .config input, .config select { width:100%; box-sizing:border-box; background:var(--paper); color:var(--ink); border:1.5px solid var(--ink); padding:9px 11px; font:inherit; font-family:var(--font-mono); font-size:.95rem; }
  .config input:focus, .config select:focus { outline:none; border-color:var(--accent); }
  @media (max-width:720px){ .config { grid-template-columns:1fr; } }
  .install { background:var(--ink); border:1.5px solid var(--dark-border); padding:16px 18px; position:relative; overflow:auto; }
  .install pre { margin:0; font-family:var(--font-mono); font-size:.9rem; color:var(--cream); white-space:pre; }
  .install .copy { position:absolute; top:10px; right:10px; background:var(--ink-panel); color:var(--cream); border:1px solid var(--dark-border); padding:4px 9px; cursor:pointer; font-family:var(--font-mono); font-size:.78rem; }
  .install .copy:hover { border-color:var(--accent); color:var(--accent); }
  .install + .install { margin-top:10px; }
  .kw { color:#c084fc; } .str { color:#86efac; } .com { color:#64748b; } .num { color:#fbbf24; }
  .phase { display:grid; gap:12px; grid-template-columns:repeat(3,1fr); margin:18px 0; }
  @media (max-width:720px){ .phase { grid-template-columns:1fr; } }
  .step { background:var(--card); border:1.5px solid var(--ink); padding:14px; }
  .step h3 { margin:0 0 4px; font-size:.95rem; color:var(--ink); }
  .step .mode { font-family:var(--font-mono); color:var(--accent); font-size:.85rem; }
  .step p { margin:6px 0 0; color:var(--muted); font-size:.88rem; }
  .links { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 24px; }
  .links a { background:var(--card); border:1.5px solid var(--ink); padding:8px 12px; color:var(--ink); text-decoration:none; font-size:.88rem; }
  .links a:hover { border-color:var(--accent); color:var(--accent); }
  .deploy { display:grid; gap:10px; grid-template-columns:repeat(3,1fr); }
  @media (max-width:720px){ .deploy { grid-template-columns:1fr; } }
  .deploy a { background:var(--card); border:1.5px solid var(--ink); padding:14px; color:var(--ink); text-decoration:none; }
  .deploy a:hover { border-color:var(--accent); }
  .deploy a .t { font-weight:600; }
  .deploy a .s { color:var(--muted); font-size:.85rem; display:block; margin-top:4px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .note { color:var(--muted); font-size:.88rem; margin-top:8px; }
  code { font-family:var(--font-mono); font-size:.88em; }
  .cloud-cta { display:flex; gap:10px; align-items:center; justify-content:space-between; background:var(--card); border:1.5px solid var(--ink); padding:10px 14px; margin:0 0 22px; font-size:.9rem; color:var(--muted); }
  .cloud-cta a { color:var(--accent); white-space:nowrap; }
  @media (max-width:520px){ .cloud-cta { flex-direction:column; align-items:flex-start; } }
  `;

  /* The inline render() function uses .innerHTML to build syntax-highlighted
     code from user inputs. Every interpolated value passes through the inline
     esc() sanitiser first — this pattern is carried over from the original
     pre-migration code and is safe against injection. */
  const body = `<div class="tb-wrap">

<h1>Charge AI bots that crawl your site</h1>
<p class="lede"><b>agent402-tollbooth</b> is an open-source, self-hostable pay-per-crawl gate. Drop it in front of any Node site and AI crawlers pay USDC on Base (or Solana, Polygon, Arbitrum) — or burn CPU — to read your content. Humans browse free. <a href="https://github.com/MikeyPetrillo/Agent402/wiki/Pay-per-crawl-Walkthrough" rel="noopener">30-min walkthrough →</a></p>

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
  <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth/deploy/wordpress" rel="noopener"><span class="t">WordPress plugin <small style="color:var(--accent);">beta</small></span><span class="s">Drop-in PHP. Settings → Agent402 Tollbooth.</span></a>
</div>

<h2>More</h2>
<div class="links">
  <a href="https://github.com/MikeyPetrillo/Agent402/wiki/Pay-per-crawl-Walkthrough" rel="noopener">30-min walkthrough</a>
  <a href="https://github.com/MikeyPetrillo/Agent402/tree/main/tollbooth" rel="noopener">README + reference</a>
  <a href="https://github.com/MikeyPetrillo/Agent402/blob/main/tollbooth/demo.js" rel="noopener"><code>node demo.js</code></a>
  <a href="https://www.npmjs.com/package/agent402-tollbooth" rel="noopener">npm</a>
</div>

<script>
(function(){
  /* esc() HTML-escapes every user-controlled value before it reaches the
     syntax-highlighted snippet. This is the same sanitisation used in the
     pre-migration version of this page. */
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

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "__none__",
    extraCss,
    body,
  });
}
