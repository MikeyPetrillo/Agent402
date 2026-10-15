// Dedicated install landing page for agent402-tollbooth, the sell-side gate.
//
// Single-purpose: a visitor arriving from the launch article, a LinkedIn
// thread, or the README clicks "install tollbooth" and lands on ONE page that
// shows them the snippet, lets them paste a wallet address, and gives them the
// observe → bots → strict progression with one knob each. No marketing, no
// pricing tables, no "request a demo." The snippet on the page is the install.
//
// Every option, mode and route this page names is the package's own
// (tollbooth/index.js), and scripts/test-tollbooth-landing.js runs the snippet
// assets/js/tollbooth-snippet.js renders against the real package for every
// mode: observe passes, bots charges a crawler, proof-of-work unlocks, and the
// x402 middleware collects a stock client's payment. tollbooth/ is not in the
// server image, so nothing here imports it; the test holds the two together.
//
// NOTE: The inline script uses innerHTML to render syntax-highlighted code
// snippets from user-controlled config inputs (wallet, price, mode). All
// interpolated values are HTML-escaped via the inline esc() function before
// insertion, matching the original pre-migration implementation.
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

import { repoUrl } from "./repo-link.js";
export function tollboothLandingPage(baseUrl) {
  const title = "Tollbooth - charge AI bots that crawl your site (30-second install)";
  const description = "agent402-tollbooth is an open-source, self-hostable pay-per-crawl gate. Put it in front of a site (Express, Next.js, Cloudflare Worker, Docker) and AI crawlers pay per request in USDC through your x402 facilitator, over MPP on the same 402, or by solving a proof-of-work. People browse free.";
  const canonical = `${baseUrl}/tollbooth`;

  const extraCss = `
  .tb-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  h1 {font-family:var(--font-display);font-weight:400;letter-spacing:-.01em; font-size:var(--fs-5xl);line-height:.96;margin:0 0 12px; }
  .lede { color:var(--muted); margin:0 0 32px; font-size:var(--fs-lg); line-height:1.6; }
  .lede a { color:var(--accent); text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px; }
  .lede a:hover { text-decoration:underline; }
  h2 { font-family:var(--font-body);font-weight:700;font-size:var(--fs-3xl);line-height:1;letter-spacing:-.02em;margin:36px 0 12px;color:var(--accent); }
  .config { background:var(--card); border:1px solid var(--hairline); padding:18px; margin:0 0 14px; display:grid; gap:14px; grid-template-columns:1fr 160px 1fr; align-items:end; }
  .config label { display:block; }
  .config .k { color:var(--faint); font-family:var(--font-mono); font-size:var(--fs-xs); letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px; }
  .config input, .config select { width:100%; box-sizing:border-box; background:var(--paper); color:var(--ink); border:1px solid var(--hairline); padding:9px 11px; font:inherit; font-family:var(--font-mono); font-size:var(--fs-base); }
  .config input:focus, .config select:focus { outline:none; border-color:var(--accent); }
  @media (max-width:720px){ .config { grid-template-columns:1fr; } }
  .install { background:var(--panel); border:1.5px solid var(--panel-rule); padding:16px 18px; position:relative; overflow:auto; }
  .install pre { margin:0; font-family:var(--font-mono); font-size:var(--fs-md); color:var(--on-panel); white-space:pre; }
  .install .copy { position:absolute; top:10px; right:10px; background:var(--panel); color:var(--on-panel); border:1px solid var(--panel-rule); padding:4px 9px; cursor:pointer; font-family:var(--font-mono); font-size:var(--fs-xs); }
  .install .copy:hover { border-color:var(--accent); color:var(--accent); }
  .install + .install { margin-top:10px; }
  .kw { color:var(--on-panel-violet); } .str { color:var(--accent-lit); } .com { color:var(--on-panel-faint); } .num { color:var(--on-panel-warn); }
  .phase { display:grid; gap:12px; grid-template-columns:repeat(3,1fr); margin:18px 0; }
  @media (max-width:720px){ .phase { grid-template-columns:1fr; } }
  .step { background:var(--card); border:1px solid var(--hairline); padding:14px; }
  .step h3 { margin:0 0 4px; font-size:var(--fs-base); color:var(--ink); }
  .step .mode { font-family:var(--font-mono); color:var(--accent); font-size:var(--fs-md); }
  .step p { margin:6px 0 0; color:var(--muted); font-size:var(--fs-md); }
  .links { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 24px; }
  .links a { background:var(--card); border:1px solid var(--hairline); padding:8px 12px; color:var(--ink); text-decoration:none; font-size:var(--fs-md); }
  .links a:hover { border-color:var(--accent); color:var(--accent); }
  .deploy { display:grid; gap:10px; grid-template-columns:repeat(2,1fr); }
  @media (max-width:720px){ .deploy { grid-template-columns:1fr; } }
  .deploy a { background:var(--card); border:1px solid var(--hairline); padding:14px; color:var(--ink); text-decoration:none; }
  .deploy a:hover { border-color:var(--accent); }
  .deploy a .t { font-weight:600; }
  .deploy a .s { color:var(--muted); font-size:var(--fs-md); display:block; margin-top:4px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .note { color:var(--muted); font-size:var(--fs-md); margin-top:8px; }
  code { font-family:var(--font-mono); font-size:var(--fs-code-inline); }
  `;

  /* The inline render() function uses .innerHTML to build syntax-highlighted
     code from user inputs. Every interpolated value passes through the inline
     esc() sanitiser first - this pattern is carried over from the original
     pre-migration code and is safe against injection. */
  const body = `<div class="tb-wrap">

<h1>Charge AI bots that crawl your site</h1>
<p class="lede"><b>agent402-tollbooth</b> is an open-source, self-hostable pay-per-crawl gate. Put it in front of a Node site and AI crawlers pay per request to read your content: in USDC on Base or another EVM chain your x402 facilitator settles, over MPP on the same 402, or by solving a proof-of-work. People browse free, and payments settle straight to your wallet with nothing taken. <a href="${repoUrl("wiki/Pay-per-crawl-Walkthrough")}" rel="noopener">30-min walkthrough →</a></p>

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
      <option value="observe" selected>observe: true - count, never charge</option>
      <option value="bots">bots - charge known AI crawlers</option>
      <option value="strict">strict - charge anything not a browser</option>
      <option value="all">all - charge every client</option>
    </select>
  </label>
</div>
<p class="note">Tip: start with <code>observe: true</code> for a day. A request the gate would charge passes with an <code>X-Tollbooth-Observed: would-charge</code> header and is counted in <code>gate.stats().wouldCharge</code>, so you see what is crawling you before you charge anyone.</p>

<h2>2 · Install</h2>
<div class="install"><button class="copy" data-target="cmd">copy</button><pre id="cmd"><span class="kw">npm</span> install agent402-tollbooth express @x402/express @x402/core @x402/evm</pre></div>

<div class="install"><button class="copy" data-target="snip">copy</button><pre id="snip"></pre></div>

<p class="note">Set <code>X402_FACILITATOR_URL</code> to an x402 facilitator that settles USDC on Base, then start your server normally. The <code>x402</code> middleware is what collects USDC, and with it the same 402 also carries MPP challenges; without it the gate still answers crawlers with a 402 and lets through any that solve the proof-of-work, but no payment can be accepted. <code>gate.stats()</code> returns the counts: requests, charged, and paid by x402, MPP or proof-of-work.</p>
<p class="note">The reverse proxy (<code>npx agent402-tollbooth</code>) and the Cloudflare Worker also serve a dashboard at <code>/__tollbooth</code> with JSON at <code>/__tollbooth/stats</code>. On the proxy, <code>TOLLBOOTH_ADMIN_TOKEN</code> gates both and is read from an <code>Authorization: Bearer</code> header; on the Worker, <code>TOLLBOOTH_STATS_TOKEN</code> gates the JSON the same way.</p>

<h2>3 · Roll out safely</h2>
<div class="phase">
  <div class="step"><h3>Phase 1 · 24h</h3><div class="mode">observe: true</div><p>Nothing is blocked. <code>gate.stats()</code> counts what you <i>would</i> charge.</p></div>
  <div class="step"><h3>Phase 2 · ongoing</h3><div class="mode">mode: "bots"</div><p>Known AI crawler user-agents (the default list in <a href="${repoUrl("blob/main/tollbooth/bots.js")}" rel="noopener">bots.js</a>) get a 402. People pass.</p></div>
  <div class="step"><h3>Phase 3 · optional</h3><div class="mode">mode: "strict" / "all"</div><p><code>strict</code> charges anything that is not a real browser; <code>all</code> charges every client, people included, except what your <code>free()</code> predicate allows. Proof-of-work keeps the page reachable without a wallet; <code>adaptive: true</code> raises its difficulty under load.</p></div>
</div>

<h2>Not running Express?</h2>
<div class="deploy">
  <a href="${repoUrl("tree/main/tollbooth/deploy/cloudflare")}" rel="noopener"><span class="t">Cloudflare Worker</span><span class="s">One <code>wrangler deploy</code>. KV-backed.</span></a>
  <a href="${repoUrl("tree/main/tollbooth/deploy/nextjs")}" rel="noopener"><span class="t">Next.js middleware</span><span class="s">One file: <code>middleware.js</code>.</span></a>
  <a href="${repoUrl("tree/main/tollbooth/deploy/docker")}" rel="noopener"><span class="t">Docker reverse proxy</span><span class="s">Any backend, any language.</span></a>
  <a href="${repoUrl("tree/main/tollbooth/deploy/wordpress")}" rel="noopener"><span class="t">WordPress plugin <small style="color:var(--accent);">beta</small></span><span class="s">Drop-in PHP. Settings → Agent402 Tollbooth.</span></a>
</div>

<h2>More</h2>
<div class="links">
  <a href="${repoUrl("wiki/Pay-per-crawl-Walkthrough")}" rel="noopener">30-min walkthrough</a>
  <a href="${repoUrl("tree/main/tollbooth")}" rel="noopener">README + reference</a>
  <a href="${repoUrl("blob/main/tollbooth/demo.js")}" rel="noopener"><code>node demo.js</code></a>
  <a href="https://www.npmjs.com/package/agent402-tollbooth" rel="noopener">npm</a>
  <a href="/guides/coinbase-business-get-paid-by-agents">Get paid into an exchange business account</a>
</div>

<script src="/js/tollbooth-snippet.js"></script>

</div>
${ledgerFooterCompact()}`;

  return ledgerShell({
    title,
    description,
    canonical,
    baseUrl,
    activePath: "/sell",
    extraCss,
    body,
  });
}
