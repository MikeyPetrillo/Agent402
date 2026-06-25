// Tollbooth Cloud — hosted analytics + multi-site dashboard on top of the OSS
// agent402-tollbooth package. The OSS gate stays unchanged: same Express
// middleware, same Cloudflare Worker template, same non-custodial USDC settlement
// straight to the publisher's wallet. Cloud sits next to it and reads aggregate
// stats from the durable sink (KV / HTTP), nothing more.
//
// This page is the agency / SEO / multi-publisher pitch: pricing, partner
// program, two-sided flywheel. The /tollbooth install page stays as-is for devs
// who just want the snippet — this page links to it from "Self-host the OSS".
import { ledgerShell, ledgerFooterCompact, esc } from "./ledger-chrome.js";

const REPO = "https://github.com/MikeyPetrillo/Agent402";
// All CTAs route through the on-site waitlist form (/tollbooth/waitlist) which
// collects structured intent and then submits a labeled GitHub issue. Keeps the
// agency-pitch UX out of GitHub's raw issue editor.
const waitlistUrl = (plan) => `/tollbooth/waitlist?plan=${plan}`;

export function tollboothCloudPage(baseUrl) {
  const title = "Tollbooth Cloud — multi-site AI-crawler analytics for publishers & SEO agencies";
  const description = "Hosted dashboard on top of open-source agent402-tollbooth. One pane over every client site, alerts when AI crawlers spike, white-label for agencies, 20% partner referral. Non-custodial — your wallet still settles USDC directly.";
  const canonical = `${baseUrl}/tollbooth/cloud`;

  const extraCss = `
  .tc-wrap { max-width:1180px; margin:0 auto; padding:56px 30px; }
  h1 { font-family:var(--font-body);font-weight:800;font-size:58px;line-height:.96;letter-spacing:-.03em;margin:0 0 14px; }
  .lede { color:var(--muted); margin:0 0 28px; font-size:1.05rem; max-width:760px; line-height:1.6; }
  .lede a { color:var(--accent); text-decoration:none; }
  h2 { font-family:var(--font-body);font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:36px 0 12px;color:var(--accent); }
  h3 { font-size:1rem; margin:0 0 6px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  code { font-family:var(--font-mono); font-size:.86rem; }
  .pill { display:inline-block; padding:2px 8px; border:1.5px solid var(--ink); color:var(--faint); font-family:var(--font-mono); font-size:.72rem; letter-spacing:.06em; text-transform:uppercase; }
  .pill.warn { color:var(--accent); border-color:var(--accent); }
  .who { display:grid; gap:14px; grid-template-columns:repeat(3,1fr); margin:18px 0 30px; }
  @media (max-width:780px){ .who { grid-template-columns:1fr; } }
  .who .c { background:var(--card); border:1.5px solid var(--ink); padding:18px; }
  .who .c .k { color:var(--accent); font-family:var(--font-mono); font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px; }
  .who .c p { margin:6px 0 0; color:var(--muted); font-size:.92rem; }
  .hero-cta { display:flex; flex-wrap:wrap; gap:10px; margin:0 0 28px; }
  .hero-cta a { display:inline-block; padding:10px 18px; font-family:var(--font-mono); font-size:.92rem; border:1.5px solid var(--ink); color:var(--ink); }
  .hero-cta a.primary { background:var(--ink); color:var(--cream); font-weight:700; }
  .hero-cta a.primary:hover { text-decoration:none; opacity:.9; }
  .hero-cta a:hover { border-color:var(--accent); text-decoration:none; }
  .hero-cta .note { color:var(--faint); font-size:.82rem; align-self:center; margin-left:4px; }
  .preview { background:var(--ink); border:1.5px solid var(--dark-border); padding:18px 20px; margin:0 0 8px; }
  .preview .ph { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
  .preview .ph .t { color:var(--dk-muted); font-family:var(--font-mono); font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; }
  .preview .ph .dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--green); margin-right:6px; vertical-align:middle; }
  .preview .row { display:grid; grid-template-columns:1.4fr .9fr .9fr .9fr; gap:10px; padding:9px 0; border-bottom:1px solid var(--dark-border); font-size:.9rem; font-family:var(--font-mono); color:var(--cream); }
  .preview .row.head { color:var(--dk-muted); font-size:.74rem; letter-spacing:.06em; text-transform:uppercase; border-bottom-style:solid; padding-bottom:6px; }
  .preview .row:last-child { border-bottom:0; }
  .preview .row .up { color:var(--green); }
  .preview .row .dn { color:#fbbf24; }
  @media (max-width:560px){ .preview .row { grid-template-columns:1.2fr .7fr .7fr; } .preview .row .hide-sm { display:none; } }
  .outcomes { display:grid; gap:14px; grid-template-columns:repeat(3,1fr); margin:18px 0 8px; }
  @media (max-width:780px){ .outcomes { grid-template-columns:1fr; } }
  .outcomes .o { background:var(--card); border:1.5px solid var(--ink); padding:16px 18px; }
  .outcomes .o .when { color:var(--accent); font-family:var(--font-mono); font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px; }
  .outcomes .o p { margin:4px 0 0; color:var(--muted); font-size:.92rem; }
  .badge-pop { position:absolute; top:-10px; right:14px; background:var(--accent); color:var(--paper); font-family:var(--font-mono); font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; font-weight:700; padding:3px 8px; }
  .plan.featured { position:relative; }
  .cta-strip { background:var(--card); border:1.5px solid var(--ink); padding:22px; margin:24px 0 8px; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:14px; }
  .cta-strip .copy h3 { margin:0 0 4px; color:var(--ink); font-size:1.1rem; }
  .cta-strip .copy p { margin:0; color:var(--muted); font-size:.92rem; max-width:560px; }
  .cta-strip .actions { display:flex; gap:8px; flex-wrap:wrap; }
  .cta-strip .actions a { display:inline-block; padding:9px 16px; font-family:var(--font-mono); font-size:.9rem; border:1.5px solid var(--ink); color:var(--ink); }
  .cta-strip .actions a.primary { background:var(--ink); color:var(--cream); font-weight:700; }
  .cta-strip .actions a:hover { border-color:var(--accent); text-decoration:none; }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(4,1fr); margin:0 0 18px; }
  @media (max-width:980px){ .grid { grid-template-columns:repeat(2,1fr); } }
  @media (max-width:560px){ .grid { grid-template-columns:1fr; } }
  .plan { background:var(--card); border:1.5px solid var(--ink); padding:20px; display:flex; flex-direction:column; }
  .plan.featured { border-color:var(--accent); border-width:2px; }
  .plan h3 { color:var(--ink); font-size:1.05rem; margin:0 0 2px; }
  .plan .sub { color:var(--muted); font-size:.82rem; margin:0 0 14px; min-height:32px; }
  .plan .price { font-size:1.6rem; font-weight:800; letter-spacing:-.01em; }
  .plan .price small { font-size:.78rem; color:var(--muted); font-weight:400; margin-left:4px; }
  .plan ul { padding:0; margin:14px 0 0; list-style:none; font-size:.92rem; color:var(--ink); }
  .plan ul li { padding:5px 0; border-bottom:1px solid var(--hairline); }
  .plan ul li:last-child { border-bottom:0; }
  .plan ul li b { color:var(--accent); font-weight:600; }
  .plan .cta { margin-top:auto; padding-top:14px; }
  .plan .cta a { display:inline-block; padding:8px 14px; border:1.5px solid var(--ink); font-family:var(--font-mono); color:var(--ink); font-size:.88rem; }
  .plan.featured .cta a { background:var(--ink); color:var(--cream); font-weight:700; }
  .plan .cta a:hover { border-color:var(--accent); text-decoration:none; }
  .annual { color:var(--muted); font-size:.88rem; margin:0 0 14px; }
  .annual b { color:var(--ink); }
  .tcols { display:grid; gap:14px; grid-template-columns:1fr 1fr; margin:18px 0; }
  @media (max-width:780px){ .tcols { grid-template-columns:1fr; } }
  .tcols .b { background:var(--card); border:1.5px solid var(--ink); padding:18px; }
  .tcols .b p { margin:8px 0 0; color:var(--muted); font-size:.92rem; }
  .flywheel { background:var(--ink); border:1.5px solid var(--dark-border); padding:18px 20px; color:var(--cream); }
  .flywheel .h { color:var(--accent); font-family:var(--font-mono); font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px; }
  .flywheel p { margin:6px 0 0; color:var(--cream); font-size:.95rem; }
  .flywheel p a { color:var(--accent); }
  .flywheel p code { background:var(--ink-panel); border:1px solid var(--dark-border); padding:1px 6px; font-family:var(--font-mono); font-size:.86rem; }
  .faq dt { color:var(--ink); font-weight:600; margin:18px 0 4px; }
  .faq dd { color:var(--muted); margin:0; font-size:.94rem; }
  .faq dd a { color:var(--accent); }
  .foot { margin-top:36px; color:var(--faint); font-size:.86rem; }
  .foot a { color:var(--accent); }
  `;

  const body = `<div class="tc-wrap">

<span class="pill warn">Cloud · early access</span>
<h1>Tollbooth Cloud</h1>
<p class="lede">Hosted multi-site dashboard, alerts, and white-label rollup on top of open-source <a href="${esc(baseUrl)}/tollbooth">agent402-tollbooth</a> — the pay-per-crawl gate. The gate stays self-hosted and non-custodial; Cloud just reads aggregate stats from the durable sink and gives publishers and SEO agencies one pane over every site.</p>

<div class="hero-cta">
  <a class="primary" href="${esc(waitlistUrl("team"))}">Join the Cloud waitlist →</a>
  <a href="${esc(baseUrl)}/tollbooth">Install the free OSS gate</a>
  <span class="note">Waitlist locks in the launch price for life.</span>
</div>

<h2>What the dashboard looks like</h2>
<div class="preview" aria-hidden="true">
  <div class="ph">
    <div><span class="dot"></span><span class="t">Live · last 24h · 4 sites</span></div>
    <div class="t">acme-agency.tollbooth.cloud</div>
  </div>
  <div class="row head"><div>Site</div><div>Charged</div><div class="hide-sm">Paid</div><div>USDC</div></div>
  <div class="row"><div>blog.acme.com</div><div>14,208</div><div class="hide-sm">132</div><div class="up">$1.32</div></div>
  <div class="row"><div>recipes.client-a.io</div><div>9,841</div><div class="hide-sm">88</div><div class="up">$0.88</div></div>
  <div class="row"><div>guide.client-b.co</div><div>3,402</div><div class="hide-sm">27</div><div class="up">$0.27</div></div>
  <div class="row"><div>news.client-c.net</div><div>21,067</div><div class="hide-sm">0</div><div class="dn">PoW only</div></div>
</div>
<p class="annual" style="margin-top:8px;">Counters update minute-by-minute. No request bodies, no per-call data — Cloud only ever sees aggregate stats.</p>

<h2>Who it's for</h2>
<div class="who">
  <div class="c">
    <div class="k">Solo publisher</div>
    <h3>One site, one wallet</h3>
    <p>You ship the gate, AI crawlers pay your wallet. Cloud sends a weekly digest and pings you when GPTBot or ClaudeBot suddenly 10x.</p>
  </div>
  <div class="c">
    <div class="k">SEO agency</div>
    <h3>Dozens of client sites</h3>
    <p>One dashboard across every install. Tag sites by client, alert on per-client thresholds, export a monthly report. White-label on a CNAMEd sub-domain on the Agency plan.</p>
  </div>
  <div class="c">
    <div class="k">Enterprise</div>
    <h3>Many properties, audit trail</h3>
    <p>SSO, custom retention, SLA, signed audit log of every charged-but-failed event. Single contract, your wallet still owns the USDC.</p>
  </div>
</div>

<h2>Pricing</h2>
<p class="annual">Monthly prices below. <b>Annual prepay = 2 months free</b> (16% off). All paid plans include the OSS gate, the dashboard, weekly digest, and email alerts.</p>
<div class="grid">

  <div class="plan">
    <h3>OSS · Self-host</h3>
    <p class="sub">The open-source <code>agent402-tollbooth</code> package. Run it wherever you want.</p>
    <div class="price">Free</div>
    <ul>
      <li>Unlimited sites</li>
      <li>Per-site <code>/__tollbooth</code> dashboard</li>
      <li>KV / HTTP stats sink for your own infra</li>
      <li>MIT licensed, audited, non-custodial</li>
    </ul>
    <div class="cta"><a href="${esc(baseUrl)}/tollbooth">Install →</a></div>
  </div>

  <div class="plan">
    <h3>Cloud Solo</h3>
    <p class="sub">For the publisher tired of GPTBot scraping their blog.</p>
    <div class="price">$19<small>/mo</small></div>
    <ul>
      <li><b>1 domain</b></li>
      <li>Hosted multi-instance dashboard</li>
      <li><b>30-day</b> stats retention</li>
      <li>Weekly email digest</li>
      <li>Charged-vs-paid spike alerts</li>
    </ul>
    <div class="cta"><a href="${esc(waitlistUrl("solo"))}">Join waitlist</a></div>
  </div>

  <div class="plan featured">
    <span class="badge-pop">Most popular</span>
    <h3>Cloud Team</h3>
    <p class="sub">For boutique SEO agencies. ~$4/site/mo at the cap.</p>
    <div class="price">$99<small>/mo</small></div>
    <ul>
      <li><b>Up to 25 sites</b></li>
      <li>Multi-site rollup with client tagging</li>
      <li>Custom alert rules per site or tag</li>
      <li><b>90-day</b> retention + monthly PDF report</li>
      <li>Branded dashboard (your logo)</li>
      <li>API access for your own reports</li>
    </ul>
    <div class="cta"><a href="${esc(waitlistUrl("team"))}">Join waitlist</a></div>
  </div>

  <div class="plan">
    <h3>Cloud Agency</h3>
    <p class="sub">For agencies managing many client properties under one brand.</p>
    <div class="price">$299<small>/mo</small></div>
    <ul>
      <li><b>Up to 100 sites</b></li>
      <li>Everything in Team, plus:</li>
      <li><b>White-label</b> sub-domain (CNAME)</li>
      <li><b>1-year</b> retention</li>
      <li>Priority support</li>
      <li><b>Partner referral program</b> access</li>
    </ul>
    <div class="cta"><a href="${esc(waitlistUrl("agency"))}">Join waitlist</a></div>
  </div>

</div>

<div class="grid" style="grid-template-columns:1fr; margin-top:6px;">
  <div class="plan">
    <h3>Enterprise</h3>
    <p class="sub">Many properties, a single contract, audit-grade trail.</p>
    <div class="price">Contact us</div>
    <ul>
      <li>Unlimited sites, custom retention</li>
      <li>SSO (SAML / OIDC), role-based access</li>
      <li>SLA, signed audit log, dedicated support</li>
      <li>Your wallet still owns the USDC — Cloud never custodies funds</li>
    </ul>
    <div class="cta"><a href="${esc(waitlistUrl("enterprise"))}&kind=enterprise">Talk to us</a></div>
  </div>
</div>

<h2>What you get, when</h2>
<div class="outcomes">
  <div class="o">
    <div class="when">Day 1</div>
    <h3>The gate is live</h3>
    <p>Drop the snippet in Express, Next.js, or a Cloudflare Worker. AI crawlers see HTTP 402; classic SEO indexers pass through untouched.</p>
  </div>
  <div class="o">
    <div class="when">Week 1</div>
    <h3>You see the shape of bot traffic</h3>
    <p>The dashboard tells you which crawlers hit which paths and how much PoW vs. USDC is settling. Most operators are surprised by the volume.</p>
  </div>
  <div class="o">
    <div class="when">Month 1</div>
    <h3>You have data to make a policy call</h3>
    <p>Decide per site: deter (PoW), monetize (USDC), or block. Export a monthly report for clients with charged-vs-paid breakdowns.</p>
  </div>
</div>

<h2>Partner program for SEO agencies</h2>
<div class="tcols">
  <div class="b">
    <h3 style="color:var(--accent);">20% lifetime recurring</h3>
    <p>On every Team or Agency plan you refer. Paid in normal currency via Stripe — not USDC — so the protocol's non-custodial promise stays clean. Standard rev-share, settled monthly.</p>
  </div>
  <div class="b">
    <h3 style="color:var(--accent);">Co-marketing</h3>
    <p>Joint launch posts, agency directory listing on this site, and a case-study slot when a client's settled USDC crosses a milestone. We don't do anything we won't put our name on.</p>
  </div>
</div>
<p style="margin:8px 0 0;"><a href="${esc(waitlistUrl("partner"))}&kind=partner">Apply as a partner agency →</a></p>

<h2>The two-sided flywheel kicker</h2>
<div class="flywheel">
  <div class="h">Bonus for verified Tollbooth installs</div>
  <p>Any wallet that runs a verified Tollbooth install earns <b>1.5× bonus Agent402.tools credit</b> per dollar of settled USDC its install charges. Spend it on the 1,338 paid tools in the <a href="${esc(baseUrl)}/tools">catalog</a> (browser, search, PDFs, images, live data, identifiers) or against the <a href="${esc(baseUrl)}/index">Smart Order Router</a>. Tollbooth installs feed Agent402 demand; Agent402 buyers feed Tollbooth supply.</p>
</div>

<h2>How it stays non-custodial</h2>
<div class="tcols">
  <div class="b">
    <h3>Cloud reads stats, not money</h3>
    <p>The OSS gate already writes aggregate counters to its <code>statsSink</code> (memory, KV, or HTTP). Cloud is an <code>httpStatsSink</code> endpoint that aggregates across instances. <b>No request bodies, no per-call data, no PII</b> — just minute-level counters per install.</p>
  </div>
  <div class="b">
    <h3>USDC bypasses us entirely</h3>
    <p>Settlement is direct: bot wallet → publisher wallet, verified by the standard x402 facilitator. Cloud never sees a transaction. If we vanish tomorrow, your gate keeps charging and your USDC keeps flowing.</p>
  </div>
</div>

<div class="cta-strip">
  <div class="copy">
    <h3>Ready to see who's scraping you?</h3>
    <p>Self-host the OSS gate for free, or join the Cloud waitlist for the hosted multi-site dashboard. Cancel anytime — your wallet keeps collecting USDC either way.</p>
  </div>
  <div class="actions">
    <a class="primary" href="${esc(waitlistUrl("team"))}">Join the waitlist</a>
    <a href="${esc(baseUrl)}/tollbooth">Install the OSS gate</a>
  </div>
</div>

<h2>FAQ</h2>
<dl class="faq">
  <dt>Is Tollbooth itself paid?</dt>
  <dd>No — <code>agent402-tollbooth</code> is and will stay MIT-licensed and free to self-host. <a href="${esc(baseUrl)}/tollbooth">Install it now</a> at no cost. Cloud is the optional hosted analytics on top.</dd>

  <dt>What happens when I cancel Cloud?</dt>
  <dd>Your OSS gate keeps running and your wallet keeps collecting USDC. You lose the hosted dashboard, multi-site rollup, alerts, and digests — that's it.</dd>

  <dt>Does Cloud require Cloudflare?</dt>
  <dd>No. The gate runs anywhere Node 20+ runs: Express, Next.js middleware, a reverse proxy, a Cloudflare Worker, a Deno or Bun script. Cloud reads stats from any of them.</dd>

  <dt>Which AI crawlers does it charge by default?</dt>
  <dd>The default <code>bots</code> mode targets 25 AI/LLM crawler user-agents (GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended, Bytespider, …). Classic search indexers (Googlebot, Bingbot) are <b>deliberately not</b> on the list — you almost always want classic SEO indexing to stay free.</dd>

  <dt>What if AI vendors haven't shipped buyer-side x402 yet?</dt>
  <dd>Right now Tollbooth's main job for most sites is to <b>deter</b> AI training crawl (with proof-of-work or an outright block), not to <b>monetize</b> it. The USDC rail is fully wired and ready for the moment buyer-side x402 lands at OpenAI / Anthropic / Perplexity. Most operators run <code>observe</code> mode for 1-2 weeks first to size the traffic.</dd>

  <dt>How is this different from Cloudflare AI Crawl Toll?</dt>
  <dd>Open source, portable across hosts (not locked to Cloudflare), non-custodial (USDC settles to your wallet, not a vendor's books), single-product price (not bundled into a CDN plan), and ships with a free proof-of-work rail that doesn't need any AI vendor to integrate buyer-side rails first.</dd>
</dl>

<p class="foot">Cloud is in early access. Pricing reflects the launch terms and may evolve before general availability — anyone on the waitlist gets the price they signed up at, for life. Questions? <a href="${REPO}/issues" rel="noopener">Open an issue</a>.</p>

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
